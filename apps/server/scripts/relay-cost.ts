/**
 * Phase 7 check: relay mode carries a film to a room that cannot use the swarm,
 * and what that costs is measured rather than estimated.  `npm run phase7`
 *
 * Runs a real session against a real S3 implementation (MinIO in Docker): one
 * sharer uploads, N receivers fetch, and every request and byte is counted. The
 * cost is then computed from published prices rather than guessed, and shown for
 * both R2 and S3 -- because the difference between them is the entire reason the
 * plan named R2.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignallingServer } from '../src/server.js'
import { presign, type OriginConfig } from '../src/origin.js'
import { RoomClient, FilmStore, OriginTransfer } from '@cocine/client'
import { ExternalMpv, ensureTestVideo } from '@cocine/player'

const CONTAINER = 'cocine-minio-cost'
const PORT = 9126
const arg = (name: string, fallback: number): number => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? Number(hit.split('=')[1]) : fallback
}
const RECEIVERS = arg('receivers', 3)
const FILM_SEC = arg('film', 30)
/** A real film, for scaling the measured per-byte costs up to a real movie night. */
const REAL_FILM_GB = arg('real-gb', 4)

/**
 * Published list prices, US, at the time of writing. Storage is charged per
 * GB-month; a film kept for one evening is a small fraction of that, so the
 * figure below assumes it is deleted the next day.
 */
const PRICES = {
  r2: { egressPerGB: 0, storagePerGBMonth: 0.015, classAPerMillion: 4.50, classBPerMillion: 0.36 },
  s3: { egressPerGB: 0.09, storagePerGBMonth: 0.023, classAPerMillion: 5.00, classBPerMillion: 0.40 }
}

const origin: OriginConfig = {
  endpoint: `http://127.0.0.1:${PORT}`, bucket: 'cocine',
  accessKeyId: 'cocinetest', secretAccessKey: 'cocinetestsecret', region: 'us-east-1'
}

const gb = (bytes: number): number => bytes / 1024 ** 3
const money = (n: number): string => n < 0.01 ? `${(n * 100).toFixed(3)} cents` : `$${n.toFixed(4)}`

function costOf (p: typeof PRICES.r2, o: { bytesUp: number; bytesDown: number; puts: number; gets: number; storedGB: number; days: number }): number {
  return o.bytesDown / 1024 ** 3 * p.egressPerGB
    + o.storedGB * p.storagePerGBMonth * (o.days / 30)
    + (o.puts / 1e6) * p.classAPerMillion
    + (o.gets / 1e6) * p.classBPerMillion
}

async function main (): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cocine-cost-'))
  const cleanups: Array<() => Promise<unknown>> = []
  let server: SignallingServer | null = null

  try {
    console.log(`\n  Relay mode cost, measured — ${RECEIVERS} receivers, ${FILM_SEC}s film\n`)
    execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
    execFileSync('docker', ['run', '-d', '--name', CONTAINER, '-p', `${PORT}:9000`,
      '-e', `MINIO_ROOT_USER=${origin.accessKeyId}`, '-e', `MINIO_ROOT_PASSWORD=${origin.secretAccessKey}`,
      'minio/minio:latest', 'server', '/data'], { stdio: 'ignore' })
    const deadline = Date.now() + 30000
    for (;;) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/minio/health/live`)).ok) break } catch { /* waiting */ }
      if (Date.now() > deadline) throw new Error('minio did not start')
      await new Promise(r => setTimeout(r, 250))
    }
    await fetch(presign(origin, { method: 'PUT', key: '' }), { method: 'PUT' })

    server = new SignallingServer({ origin, startLeadMs: 400 })
    const port = await server.listen()

    async function member (name: string, code: string | null) {
      const player = new ExternalMpv({ headless: true })
      await player.start()
      cleanups.push(() => player.close())
      const client = new RoomClient({ url: `ws://127.0.0.1:${port}`, code, name, player })
      const transfer = new OriginTransfer({
        store: new FilmStore(join(root, name)),
        getUploadUrl: (id, n, bytes) => client.requestUploadUrl(id, n, bytes),
        getDownloadUrl: () => client.requestDownloadUrl()
      })
      cleanups.push(() => transfer.destroy())
      cleanups.push(() => client.close())
      await client.connect()
      return { client, player, transfer }
    }

    const film = ensureTestVideo(FILM_SEC, join(process.cwd(), '.fixtures'))
    const filmBytes = statSync(film).size

    const host = await member('host', null)
    host.client.setMode('origin')
    while (host.client.mode !== 'origin') await new Promise(r => setTimeout(r, 50))

    const started = Date.now()
    const source = await host.transfer.share(film)
    host.client.announceMedia('film', FILM_SEC, source)
    const uploadMs = Date.now() - started
    console.log(`  sharer uploaded ${gb(filmBytes).toFixed(3)} GB once, in ${(uploadMs / 1000).toFixed(1)}s`)

    const receivers = []
    for (let i = 0; i < RECEIVERS; i++) receivers.push(await member(`peer-${i + 1}`, host.client.code))

    const fetchStart = Date.now()
    await Promise.all(receivers.map(async r => {
      while (!r.client.media?.source) await new Promise(res => setTimeout(res, 50))
      await r.transfer.receive(r.client.media.source)
      while (r.transfer.progress()[0]!.progress < 1) await new Promise(res => setTimeout(res, 100))
    }))
    const fetchMs = Date.now() - fetchStart

    const hostStats = host.transfer.originStats()
    const totals = receivers.reduce((acc, r) => {
      const s = r.transfer.originStats()
      return { gets: acc.gets + s.getRequests, bytesDown: acc.bytesDown + s.bytesDown }
    }, { gets: 0, bytesDown: 0 })

    console.log(`  ${RECEIVERS} receivers fetched in ${(fetchMs / 1000).toFixed(1)}s`)
    console.log(`\n  Measured against the origin`)
    console.log(`    uploads (class A)      ${hostStats.putRequests}`)
    console.log(`    downloads (class B)    ${totals.gets}`)
    console.log(`    bytes up               ${gb(hostStats.bytesUp).toFixed(4)} GB`)
    console.log(`    bytes down             ${gb(totals.bytesDown).toFixed(4)} GB`)

    const measured = {
      bytesUp: hostStats.bytesUp, bytesDown: totals.bytesDown,
      puts: hostStats.putRequests, gets: totals.gets,
      storedGB: gb(filmBytes), days: 1
    }
    console.log(`\n  Cost of this session as measured`)
    console.log(`    Cloudflare R2          ${money(costOf(PRICES.r2, measured))}`)
    console.log(`    AWS S3                 ${money(costOf(PRICES.s3, measured))}`)

    // Scale the observed shape of the session up to a real film. Requests scale
    // with size because the download is chunked; bytes scale directly.
    const factor = (REAL_FILM_GB * 1024 ** 3) / filmBytes
    const scaled = {
      bytesUp: measured.bytesUp * factor, bytesDown: measured.bytesDown * factor,
      puts: Math.ceil(measured.puts * factor), gets: Math.ceil(measured.gets * factor),
      storedGB: REAL_FILM_GB, days: 1
    }
    console.log(`\n  Extrapolated to a ${REAL_FILM_GB} GB film with ${RECEIVERS} receivers`)
    console.log(`    Cloudflare R2          ${money(costOf(PRICES.r2, scaled))}`)
    console.log(`    AWS S3                 ${money(costOf(PRICES.s3, scaled))}`)
    console.log(`\n  R2 charges nothing for egress, which is the whole difference:`)
    console.log(`  ${gb(scaled.bytesDown).toFixed(1)} GB of downloads costs ${money(gb(scaled.bytesDown) * PRICES.s3.egressPerGB)} on S3 and nothing on R2.`)
    console.log(`\n  Note: extrapolated figures assume the film is deleted after a day.`)
    console.log(`  Kept for a month instead, storage alone is ${money(REAL_FILM_GB * PRICES.r2.storagePerGBMonth)} per film on R2.\n`)
  } finally {
    for (const c of cleanups.reverse()) await c().catch(() => { /* tearing down */ })
    await server?.close().catch(() => { /* already down */ })
    execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
    rmSync(root, { recursive: true, force: true })
  }
}

await main()
