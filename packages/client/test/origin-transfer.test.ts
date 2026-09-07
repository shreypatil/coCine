import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OriginTransfer } from '../src/origin-transfer.js'
import { FilmStore } from '../src/storage.js'
import { presign, type OriginConfig } from '../../../apps/server/src/origin.js'

/**
 * Relay mode end to end against a real S3 implementation: upload a file, fetch
 * it back on a different machine's worth of state, and play it through the
 * stream server before it has finished arriving.
 */

const CONTAINER = 'cocine-minio-origin'
const PORT = 9124
const cfg: OriginConfig = {
  endpoint: `http://127.0.0.1:${PORT}`, bucket: 'cocine',
  accessKeyId: 'cocinetest', secretAccessKey: 'cocinetestsecret', region: 'us-east-1'
}

function hasDocker (): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true } catch { return false }
}
const suite = hasDocker() ? describe : describe.skip

suite('relay mode', () => {
  let dir = ''
  const cleanups: Array<() => Promise<void>> = []

  // Large enough to need several chunks, so partial state is real rather than
  // a single request that either works or does not.
  const FILM = Buffer.alloc(3 * 1024 * 1024)
  for (let i = 0; i < FILM.length; i++) FILM[i] = i % 251

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cocine-origin-'))
    execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
    execFileSync('docker', ['run', '-d', '--name', CONTAINER, '-p', `${PORT}:9000`,
      '-e', `MINIO_ROOT_USER=${cfg.accessKeyId}`, '-e', `MINIO_ROOT_PASSWORD=${cfg.secretAccessKey}`,
      'minio/minio:latest', 'server', '/data'], { stdio: 'ignore' })
    const deadline = Date.now() + 30000
    for (;;) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/minio/health/live`)).ok) break } catch { /* waiting */ }
      if (Date.now() > deadline) throw new Error('minio did not start')
      await new Promise(r => setTimeout(r, 250))
    }
    await fetch(presign(cfg, { method: 'PUT', key: '' }), { method: 'PUT' })
  }, 90000)

  afterEach(async () => { for (const c of cleanups.splice(0)) await c() })
  afterAll(() => {
    execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /** A transport wired to the presigner the way the server wires it. */
  function transport (label: string, opts: { chunkBytes?: number; downloadLimitBps?: number } = {}) {
    const root = join(dir, label)
    const store = new FilmStore(root)
    let key = ''
    const t = new OriginTransfer({
      store,
      chunkBytes: opts.chunkBytes ?? 1024 * 1024,
      ...(opts.downloadLimitBps ? { downloadLimitBps: opts.downloadLimitBps } : {}),
      getUploadUrl: async (contentId, name) => {
        key = `rooms/test/${contentId}/${name}`
        return { url: presign(cfg, { method: 'PUT', key }), key }
      },
      getDownloadUrl: async () => presign(cfg, { method: 'GET', key })
    })
    cleanups.push(() => t.destroy())
    return { t, setKey: (k: string) => { key = k } }
  }

  it('uploads a film once and hands back a source naming it', async () => {
    const path = join(dir, 'film.mkv')
    writeFileSync(path, FILM)
    const { t } = transport('sharer')

    const source = await t.share(path)
    expect(source.kind).toBe('origin')
    if (source.kind !== 'origin') throw new Error('unreachable')
    expect(source.bytes).toBe(FILM.length)
    expect(source.key).toContain('rooms/test/')
  }, 60000)

  it('fetches the film back byte for byte on a receiver that never had it', async () => {
    const path = join(dir, 'film2.mkv')
    writeFileSync(path, FILM)
    const { t: sharer } = transport('sharer2')
    const source = await sharer.share(path)

    const { t: receiver, setKey } = transport('receiver2')
    if (source.kind !== 'origin') throw new Error('unreachable')
    setKey(source.key)

    const { path: got } = await receiver.receive(source)
    // receive resolves once playable, so wait for the rest before comparing.
    const deadline = Date.now() + 60000
    while (receiver.progress()[0]!.progress < 1) {
      if (Date.now() > deadline) throw new Error(`stalled at ${receiver.progress()[0]!.progress}`)
      await new Promise(r => setTimeout(r, 100))
    }
    expect(readFileSync(got).equals(FILM)).toBe(true)
  }, 90000)

  it('serves bytes over the stream server before the download has finished', async () => {
    const path = join(dir, 'film3.mkv')
    writeFileSync(path, FILM)
    const { t: sharer } = transport('sharer3')
    const source = await sharer.share(path)
    if (source.kind !== 'origin') throw new Error('unreachable')

    const { t: receiver, setKey } = transport('receiver3', { chunkBytes: 256 * 1024 })
    setKey(source.key)
    await receiver.receive(source)
    const port = await receiver.ensureStreamServer()
    expect(port).toBeGreaterThan(0)

    // Ask for a range near the end, which the sequential prefetch will not have
    // reached. It must be fetched on demand rather than returning zeros.
    const url = receiver.streamUrl(source.key)!
    const res = await fetch(url, { headers: { Range: `bytes=${FILM.length - 100}-${FILM.length - 1}` } })
    expect(res.status).toBe(206)
    const tail = Buffer.from(await res.arrayBuffer())
    expect(tail.equals(FILM.subarray(FILM.length - 100))).toBe(true)
  }, 90000)

  it('resumes an interrupted transfer instead of starting again', async () => {
    const path = join(dir, 'film4.mkv')
    writeFileSync(path, FILM)
    const { t: sharer } = transport('sharer4')
    const source = await sharer.share(path)
    if (source.kind !== 'origin') throw new Error('unreachable')

    // Rate limited so the transfer is genuinely unfinished when interrupted;
    // unthrottled, three megabytes off loopback complete before the test can
    // stop them and the case under test never occurs.
    const first = transport('receiver4', { chunkBytes: 256 * 1024, downloadLimitBps: 512 * 1024 })
    first.setKey(source.key)
    await first.t.receive(source)
    const partial = first.t.progress()[0]!.progress
    await first.t.destroy()
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(1)

    // A second transport over the same store must pick up what the first left
    // rather than fetching those bytes again.
    const second = transport('receiver4', { chunkBytes: 256 * 1024, downloadLimitBps: 512 * 1024 })
    second.setKey(source.key)
    await second.t.receive(source)
    expect(second.t.progress()[0]!.progress).toBeGreaterThanOrEqual(partial)
  }, 90000)

  it('reports what it holds, so the readiness gate works the same as on the swarm', async () => {
    const path = join(dir, 'film5.mkv')
    writeFileSync(path, FILM)
    const { t: sharer } = transport('sharer5')
    const source = await sharer.share(path)
    if (source.kind !== 'origin') throw new Error('unreachable')

    const { t: receiver, setKey } = transport('receiver5', { chunkBytes: 512 * 1024 })
    setKey(source.key)
    await receiver.receive(source)

    const report = receiver.reportFor(source.key, 0, 120)!
    expect(report.havePct).toBeGreaterThan(0)
    expect(report.bufferEndSec).toBeGreaterThan(0)
    // Relay mode has no peers and nobody uploading; saying otherwise would make
    // the room's durability display claim a resilience that does not exist.
    expect(report.peers).toBe(0)
    expect(report.upBps).toBe(0)
  }, 90000)
})
