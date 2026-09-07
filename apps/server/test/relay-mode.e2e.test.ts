import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignallingServer } from '../src/server.js'
import { presign, type OriginConfig } from '../src/origin.js'
import { RoomClient, FilmStore, OriginTransfer } from '@cocine/client'
import { ExternalMpv, ensureTestVideo } from '@cocine/player'

/**
 * Phase 7's exit criterion: a room in which no two peers can connect directly
 * still watches a film together.
 *
 * The "cannot connect" half is structural rather than simulated -- in relay mode
 * there is no swarm, no tracker announce and no peer connection of any kind, so
 * a film arriving at the second machine can only have come from the origin.
 */

const CONTAINER = 'cocine-minio-relay'
const PORT = 9125
const origin: OriginConfig = {
  endpoint: `http://127.0.0.1:${PORT}`, bucket: 'cocine',
  accessKeyId: 'cocinetest', secretAccessKey: 'cocinetestsecret', region: 'us-east-1'
}

function hasDocker (): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true } catch { return false }
}
const suite = hasDocker() ? describe : describe.skip

suite('relay mode, end to end', () => {
  let root = ''
  let server: SignallingServer
  let port = 0
  const cleanups: Array<() => Promise<void>> = []

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cocine-relay-'))
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
    port = await server.listen()
  }, 120000)

  afterAll(async () => {
    for (const c of cleanups.splice(0)) await c().catch(() => { /* tearing down */ })
    await server?.close()
    execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
    if (root) rmSync(root, { recursive: true, force: true })
  })

  async function member (name: string, code: string | null) {
    const player = new ExternalMpv({ headless: true })
    await player.start()
    cleanups.push(() => player.close())

    const client = new RoomClient({ url: `ws://127.0.0.1:${port}`, code, name, player })
    const transfer = new OriginTransfer({
      store: new FilmStore(join(root, name, 'films')),
      getUploadUrl: (contentId, n, bytes) => client.requestUploadUrl(contentId, n, bytes),
      getDownloadUrl: () => client.requestDownloadUrl()
    })
    cleanups.push(() => transfer.destroy())
    cleanups.push(() => client.close())
    await client.connect()
    return { client, player, transfer }
  }

  it('tells the room that relay storage is available', async () => {
    const host = await member('host-a', null)
    expect(host.client.originAvailable).toBe(true)
    expect(host.client.mode).toBe('p2p')
  }, 60000)

  it('carries a film from one machine to another with no peer connection at all', async () => {
    const film = ensureTestVideo(30, join(process.cwd(), '.fixtures'))
    const filmBytes = statSync(film).size

    const host = await member('anjali', null)
    host.client.setMode('origin')
    await waitFor(() => host.client.mode === 'origin', 5000, 'the room to switch to relay mode')

    const guest = await member('dev', host.client.code)
    await waitFor(() => guest.client.mode === 'origin', 5000, 'the guest to see relay mode')

    // The host uploads once. Nobody else ever uploads anything.
    await host.player.load(film)
    const source = await host.transfer.share(film)
    expect(source.kind).toBe('origin')
    host.client.announceMedia('film', 30, source)

    await waitFor(() => guest.client.media?.source?.kind === 'origin', 5000, 'the guest to learn of the film')

    // The guest fetches it. There is no tracker announce and no peer here: the
    // only possible source of these bytes is the origin.
    const guestSource = guest.client.media!.source!
    const { path } = await guest.transfer.receive(guestSource)
    await guest.transfer.ensureStreamServer()
    const url = guest.transfer.streamUrl(guestSource.kind === 'origin' ? guestSource.key : '')
    expect(url).toBeTruthy()

    await waitFor(() => guest.transfer.progress()[0]!.progress >= 1, 90000, 'the film to arrive from the origin')
    expect(statSync(path).size).toBe(filmBytes)
    expect(guest.transfer.bytesFromOrigin()).toBe(filmBytes)

    // And it is a film both machines can actually play, in step.
    await guest.player.load(url!)
    host.client.requestPlay(0)
    await new Promise(r => setTimeout(r, 3000))

    const drift = Math.abs(host.player.position() - guest.player.position()) * 1000
    expect(host.player.isPaused()).toBe(false)
    expect(guest.player.isPaused()).toBe(false)
    expect(drift).toBeLessThan(100)
  }, 240000)

  it('refuses to hand a signed URL to a room that is not sharing through the relay', async () => {
    const host = await member('solo', null)
    const err = new Promise<string>(resolve => host.client.once('server-error', (m: string) => resolve(m)))
    void host.client.requestDownloadUrl().catch(() => { /* the error arrives on the socket */ })
    expect(await Promise.race([err, sleep(3000).then(() => 'no error')])).toContain('not sharing')
  }, 60000)
})

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function waitFor (cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
    await sleep(50)
  }
}
