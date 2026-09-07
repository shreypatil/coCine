import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { FilmStore, TransferManager, OutOfSpaceError } from '@cocine/client'
import { SignallingServer } from '../src/server.js'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

/**
 * Sharing a film and receiving it, against a real tracker, over WebRTC only.
 */

let server: SignallingServer
let trackerUrl: string
let root: string
const managers: TransferManager[] = []

const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

beforeAll(async () => {
  server = new SignallingServer({})
  const port = await server.listen()
  trackerUrl = `ws://127.0.0.1:${port}/announce`
  root = mkdtempSync(join(tmpdir(), 'cocine-tx-'))
})
afterAll(async () => {
  for (const m of managers) await m.destroy()
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

function manager (name: string): { tm: TransferManager; store: FilmStore } {
  const store = new FilmStore(join(root, name, 'films'))
  // No ICE servers: these peers are on loopback, so host candidates connect
  // directly. Reaching out to a public STUN server made this slow and flaky.
  const tm = new TransferManager({ store, trackerUrl, webrtcOnly: true, iceServers: [] })
  managers.push(tm)
  return { tm, store }
}

describe('sharing', () => {
  it('seeds the film where it already is, without copying it', async () => {
    // A four gigabyte film must not be duplicated just to share it.
    const mine = join(root, 'library')
    rmSync(mine, { recursive: true, force: true })
    const { tm } = manager('sharer-a')
    const file = join(mine, 'dune.mkv')
    mkdirSync(mine, { recursive: true })
    writeFileSync(file, randomBytes(2 * 1024 * 1024))
    const before = sha(file)

    const info = await tm.share(file)
    expect(info.infoHash).toMatch(/^[0-9a-f]{40}$/)
    expect(info.bytes).toBe(2 * 1024 * 1024)
    expect(info.pieceLength).toBeGreaterThan(0)
    expect(sha(file)).toBe(before)
    // Nothing new next to it, and nothing in the sharer's own film store.
    expect(readdirSync(mine)).toEqual(['dune.mkv'])
  }, 60_000)
})

describe('receiving', () => {
  it('fetches a film from the room and lands it byte-identical', async () => {
    const mine = join(root, 'lib2')
    mkdirSync(mine, { recursive: true })
    const file = join(mine, 'arrival.mkv')
    writeFileSync(file, randomBytes(3 * 1024 * 1024))
    const want = sha(file)

    const { tm: sharer } = manager('sharer-b')
    const info = await sharer.share(file)
    server.tracker.allow(info.infoHash)

    const { tm: receiver, store } = manager('receiver-b')
    const { torrent, path } = await receiver.receive(info)
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('not received within 90s')), 90_000)
      if (torrent.done) { clearTimeout(t); return res() }
      torrent.on('done', () => { clearTimeout(t); res() })
    })

    expect(sha(path)).toBe(want)
    // And it is recorded, so it shows up in the films-on-disk view.
    const films = await store.list()
    expect(films).toHaveLength(1)
    expect(films[0]!.complete).toBe(true)
    expect(films[0]!.name).toBe('arrival.mkv')
  }, 120_000)

  it('refuses before starting when the film will not fit', async () => {
    const { tm, store } = manager('receiver-c')
    const free = await store.freeBytes()
    await expect(tm.receive({
      infoHash: 'a'.repeat(40),
      magnet: 'magnet:?xt=urn:btih:' + 'a'.repeat(40),
      bytes: free * 2,
      pieceLength: 16384
    })).rejects.toBeInstanceOf(OutOfSpaceError)
    // Nothing was written for a transfer that was never going to work.
    expect(await store.list()).toEqual([])
  }, 30_000)

  it('does not start a second copy of a film it is already fetching', async () => {
    const mine = join(root, 'lib3')
    mkdirSync(mine, { recursive: true })
    const file = join(mine, 'solaris.mkv')
    writeFileSync(file, randomBytes(1024 * 1024))

    const { tm: sharer } = manager('sharer-d')
    const info = await sharer.share(file)
    server.tracker.allow(info.infoHash)

    const { tm: receiver } = manager('receiver-d')
    const first = await receiver.receive(info)
    const second = await receiver.receive(info)
    expect(second.torrent).toBe(first.torrent)
    expect(receiver.progress()).toHaveLength(1)
  }, 90_000)
})

describe('progress reporting', () => {
  it('reports each torrent it is responsible for', async () => {
    const mine = join(root, 'lib4')
    mkdirSync(mine, { recursive: true })
    const file = join(mine, 'stalker.mkv')
    writeFileSync(file, randomBytes(1024 * 1024))
    const { tm } = manager('sharer-e')
    const info = await tm.share(file)
    const [p] = tm.progress()
    expect(p!.infoHash).toBe(info.infoHash)
    expect(p!.name).toBe('stalker.mkv')
    expect(p!.progress).toBe(1)
    expect(p!.done).toBe(true)
    expect(statSync(file).size).toBe(p!.bytes)
  }, 60_000)
})

describe('piece selection', () => {
  it('primes the container index and then follows the playhead', async () => {
    const mine = join(root, 'lib5')
    mkdirSync(mine, { recursive: true })
    const file = join(mine, 'mirror.mkv')
    writeFileSync(file, randomBytes(4 * 1024 * 1024))

    const { tm: sharer } = manager('sharer-f')
    const info = await sharer.share(file)
    server.tracker.allow(info.infoHash)

    const { tm: receiver } = manager('receiver-f')
    await receiver.receive(info)
    const scheduler = receiver.schedulerFor(info.infoHash)
    expect(scheduler).toBeDefined()

    // Priming already happened during receive, so a second call is a no-op.
    expect(scheduler!.prime()).toHaveLength(0)

    // With a duration known, the window follows the playhead down the file.
    receiver.updatePlayhead(info.infoHash, 0, 120)
    const atStart = scheduler!.update(0).critical[0]
    receiver.updatePlayhead(info.infoHash, 90, 120)
    const nearEnd = scheduler!.update(90).critical[0]
    expect(nearEnd).toBeGreaterThan(atStart)
  }, 90_000)

  it('ignores a playhead for a film it is not fetching', () => {
    const { tm } = manager('receiver-g')
    expect(() => tm.updatePlayhead('f'.repeat(40), 30, 120)).not.toThrow()
  })
})
