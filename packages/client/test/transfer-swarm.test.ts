import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { installWebRtc } from '../src/webrtc.js'

// Before any WebTorrent client exists, or the swarm is silently TCP-only.
installWebRtc()

import { existsSync, readFileSync } from 'node:fs'
import { PIECE_MAP_BUCKETS, type P2PSource } from '@cocine/protocol'
import { SwarmHarness, until, type Peer } from './support/swarm.js'

/**
 * The parts of the transfer that only exist when a swarm does.
 *
 * `apps/server/test/transfer.test.ts` covers sharing and receiving end to end.
 * What it does not touch is everything the room *shows* while that happens --
 * the stream server that makes watching before the download finishes possible,
 * the once-a-second report, the piece map, pausing, and unloading. Those were
 * the least covered code in the project, at around 60%, and they are the code
 * a person actually looks at during a session.
 *
 * They went unasserted because each needs two real peers and a film moving
 * between them. `support/swarm.ts` makes that a couple of lines.
 */

const FILM_BYTES = 2 * 1024 * 1024
/**
 * Loopback moves this film in well under a second, which would leave nothing
 * partial to observe. Shaping the receiver is what makes "while it is still
 * arriving" a state a test can be in.
 */
const LIMIT_BPS = 250_000

/** A piece map holding nothing at all. */
const EMPTY_MAP = '0'.repeat(PIECE_MAP_BUCKETS)

let swarm: SwarmHarness
let seeder: Peer
let source: P2PSource
let filmPath: string

beforeAll(async () => {
  swarm = await SwarmHarness.start()
  seeder = swarm.peer('seeder')
  filmPath = swarm.film(seeder, 'film.mp4', FILM_BYTES)
  // The harness admits the hash to the tracker too, which is what the server
  // does when a room announces a film.
  source = await swarm.share(seeder, filmPath)
}, 120_000)

afterAll(async () => { await swarm?.destroy() }, 60_000)

describe('the stream server, which is what lets a film be watched before it arrives', () => {
  it('has no URL for a film this client is not carrying', () => {
    expect(seeder.tm.streamUrl('0'.repeat(40))).toBeNull()
  })

  it('has no URL before the server is running, even for a film it holds', () => {
    // share() does not start it; only receiving does, or asking directly. A URL
    // built against port 0 would be handed to mpv and simply fail to open.
    const other = swarm.peer('no-server')
    expect(other.tm.streamUrl(source.infoHash)).toBeNull()
  })

  it('serves the film once the server is asked for, and is idempotent about it', async () => {
    const port = await seeder.tm.ensureStreamServer()
    expect(port).toBeGreaterThan(0)
    // Called on every receive, so a second call must not start a second server.
    expect(await seeder.tm.ensureStreamServer()).toBe(port)

    const url = seeder.tm.streamUrl(source.infoHash)
    expect(url).toContain(`127.0.0.1:${port}`)
  }, 60_000)

  it('answers a byte range with exactly the bytes at that offset', async () => {
    // This is the assertion the whole streaming design rests on. Playing the
    // file on disk directly would read zeros wherever a piece has not arrived,
    // because the file is written sparsely -- so the bytes have to be checked
    // against what that offset should hold, not merely counted.
    await seeder.tm.ensureStreamServer()
    const url = seeder.tm.streamUrl(source.infoHash)!

    const from = 1_000_000
    const to = 1_000_255
    const { status, body } = await swarm.range(url, from, to)
    expect(status).toBe(206)
    expect(body).toEqual(swarm.expectedBytes(from, to - from + 1))
  }, 60_000)

  it('serves a range from the very end, which is where a container keeps its index', async () => {
    // Matroska puts its seek index at the end of the file. Without being able
    // to fetch that, mpv cannot seek at all, which reads as a broken
    // application rather than as a partial download.
    await seeder.tm.ensureStreamServer()
    const url = seeder.tm.streamUrl(source.infoHash)!
    const from = FILM_BYTES - 128
    const { status, body } = await swarm.range(url, from, FILM_BYTES - 1)
    expect(status).toBe(206)
    expect(body).toEqual(swarm.expectedBytes(from, 128))
  }, 60_000)
})

describe('what a peer tells the room about itself', () => {
  it('says nothing about a film it is not carrying', () => {
    expect(seeder.tm.reportFor('0'.repeat(40), 0, 3600)).toBeNull()
    expect(seeder.tm.pieceMap('0'.repeat(40))).toBeNull()
  })

  it('reports a complete copy as complete', () => {
    const report = seeder.tm.reportFor(source.infoHash, 0, 3600)!
    expect(report.havePct).toBe(1)
    expect(report.downBps).toBeGreaterThanOrEqual(0)
    expect(report.upBps).toBeGreaterThanOrEqual(0)
    expect(report.peers).toBeGreaterThanOrEqual(0)
  })

  it('measures a finished film\'s buffer from the playhead to the end', () => {
    // The done branch, which is not the same calculation as the partial one:
    // with everything held there is no bitfield to walk, and the answer is
    // simply how much film is left.
    expect(seeder.tm.reportFor(source.infoHash, 0, 3600)!.bufferEndSec).toBe(3600)
    expect(seeder.tm.reportFor(source.infoHash, 600, 3600)!.bufferEndSec).toBe(3000)
    // Never negative, even for a playhead past the end.
    expect(seeder.tm.reportFor(source.infoHash, 4000, 3600)!.bufferEndSec).toBe(0)
  })

  it('draws a piece map of the right shape, all held', () => {
    const map = seeder.tm.pieceMap(source.infoHash)!
    expect(map).toMatch(/^[0-9a-f]{64}$/)
    // The seeder holds everything, so every bucket is full.
    expect(map).toBe('f'.repeat(PIECE_MAP_BUCKETS))
  })

  it('draws it at whatever resolution is asked for', () => {
    expect(seeder.tm.pieceMap(source.infoHash, 16)).toBe('f'.repeat(16))
  })

  it('is case-insensitive about the info hash, which arrives in both cases', () => {
    // A torrent's own infoHash is lowercase and a magnet URI often is not, so a
    // case-sensitive lookup would report null for a film being carried.
    const upper = source.infoHash.toUpperCase()
    expect(seeder.tm.get(upper)).toBeDefined()
    expect(seeder.tm.reportFor(upper, 0, 3600)).not.toBeNull()
    expect(seeder.tm.pieceMap(upper)).not.toBeNull()
  })
})

describe('receiving, and everything visible while it is happening', () => {
  let receiver: Peer

  beforeAll(async () => {
    receiver = swarm.peer('receiver', { downloadLimitBps: LIMIT_BPS })
    const { path } = await receiver.tm.receive(source)
    // Resolves on metadata, not on completion -- the whole point is watching
    // before it finishes.
    expect(path).toContain('film.mp4')
    // A whole piece, not merely progress. `progress` counts bytes in flight
    // including partial pieces, while the piece map reads the bitfield, which
    // only records pieces that have arrived complete and been verified -- so
    // waiting on progress leaves a window where some bytes have landed and the
    // map is still all zeros. That window is short, which is exactly what makes
    // it an intermittent failure rather than an obvious one.
    await until(
      () => (receiver.tm.pieceMap(source.infoHash) ?? EMPTY_MAP) !== EMPTY_MAP,
      'the first complete piece to arrive', 90_000
    )
  }, 120_000)

  it('is partial for a while, and says so honestly', () => {
    const report = receiver.tm.reportFor(source.infoHash, 0, 3600)!
    expect(report.havePct).toBeGreaterThan(0)
    expect(report.havePct).toBeLessThanOrEqual(1)
  })

  it('draws a piece map showing where it is, not only how much', () => {
    // The reason the map exists rather than a single percentage: a peer missing
    // the stretch about to be watched looks different from one missing the end
    // credits.
    const map = receiver.tm.pieceMap(source.infoHash)!
    expect(map).toMatch(/^[0-9a-f]{64}$/)
    // It reflects the bitfield rather than returning a constant: something is
    // held, and where it is held is what the room draws.
    expect(map).not.toBe(EMPTY_MAP)
  })

  it('streams a range it already holds, from its own server', async () => {
    // The receiver's stream server was started by receive(). What it serves has
    // to be the real bytes: the head of the film is primed first, so this range
    // is one that has certainly arrived.
    const url = receiver.tm.streamUrl(source.infoHash)!
    const { status, body } = await swarm.range(url, 0, 255)
    expect(status).toBe(206)
    expect(body).toEqual(swarm.expectedBytes(0, 256))
  }, 90_000)

  it('reports success, and stops new peers connecting', () => {
    // What pausing does today. Keeping this separate from the test below makes
    // clear which half works.
    expect(receiver.tm.setPaused(source.infoHash, true)).toBe(true)
    expect(receiver.tm.get(source.infoHash)!.paused).toBe(true)
    expect(receiver.tm.setPaused(source.infoHash, false)).toBe(true)
    expect(receiver.tm.get(source.infoHash)!.paused).toBe(false)
  })

  /**
   * Failing on purpose, because the behaviour is wrong rather than the test.
   *
   * The interface offers this as "pause sharing" and the room marks the peer as
   * paused, but WebTorrent consults `paused` only when admitting a new peer --
   * every wire already open keeps sending and receiving at full rate. Measured
   * here: a shaped receiver still took about thirty per cent of the film in the
   * two and a half seconds after being paused.
   *
   * Left as `it.fails` rather than deleted or quietly weakened, so the suite
   * records the gap instead of hiding it, and so it announces itself the moment
   * somebody fixes it: this turns red when it starts passing.
   *
   * Closing the open wires was tried and is worse -- the bytes stop, but the
   * peers go too, and resume has nothing to reconnect to until the next tracker
   * announce, over a minute later.
   */
  it.fails('stops fetching when paused, and starts again when resumed', async () => {
    const torrent = receiver.tm.get(source.infoHash)!
    expect(receiver.tm.setPaused(source.infoHash, true)).toBe(true)

    const atPause = torrent.progress
    await new Promise(r => setTimeout(r, 2500))
    const afterPause = torrent.progress
    // A little may land from pieces already in flight; what must not happen is
    // the transfer carrying on regardless.
    expect(afterPause - atPause).toBeLessThan(0.05)

    expect(receiver.tm.setPaused(source.infoHash, false)).toBe(true)
    await until(
      () => torrent.progress > afterPause + 0.02,
      'the transfer to resume', 30_000
    )
  }, 90_000)

  it('says so rather than throwing when asked to pause a film it does not have', () => {
    expect(receiver.tm.setPaused('0'.repeat(40), true)).toBe(false)
  })

  it('follows the playhead only for a film it is scheduling', () => {
    // Called as the room's playhead moves, including for films this peer is not
    // carrying, so an unknown hash has to be a no-op rather than a crash.
    expect(() => receiver.tm.updatePlayhead('0'.repeat(40), 120, 3600)).not.toThrow()
    expect(receiver.tm.schedulerFor('0'.repeat(40))).toBeUndefined()

    expect(receiver.tm.schedulerFor(source.infoHash)).toBeDefined()
    expect(() => receiver.tm.updatePlayhead(source.infoHash, 120, 3600)).not.toThrow()
    // A duration of zero means "not known yet" and must not overwrite a good one.
    expect(() => receiver.tm.updatePlayhead(source.infoHash, 120, 0)).not.toThrow()
  })

  it('lists what it is carrying, and stops listing it once stopped', async () => {
    expect(receiver.tm.progress().map(p => p.infoHash.toLowerCase()))
      .toContain(source.infoHash.toLowerCase())

    await receiver.tm.stop(source.infoHash)

    expect(receiver.tm.get(source.infoHash)).toBeUndefined()
    expect(receiver.tm.schedulerFor(source.infoHash)).toBeUndefined()
    expect(receiver.tm.progress().map(p => p.infoHash.toLowerCase()))
      .not.toContain(source.infoHash.toLowerCase())
  }, 60_000)

  it('leaves the partial file on disk, because stopping is not deleting', () => {
    // The caller deletes the directory itself when that is what was meant.
    // Destroying the store here would race with that, and a resumed transfer
    // depends on the bytes still being there.
    const dir = receiver.store.dirFor(source.infoHash)
    expect(existsSync(dir)).toBe(true)
    expect(readFileSync(`${dir}/film.mp4`).length).toBeGreaterThan(0)
  })

  it('is a no-op when asked to stop something it never had', async () => {
    await expect(receiver.tm.stop('0'.repeat(40))).resolves.toBeUndefined()
  }, 30_000)
})

describe('a third peer joining a swarm that already has two', () => {
  it('fetches the film and records it, so it appears in the films on disk', async () => {
    // A late joiner is the case the room is built around, and the one where the
    // relay transport was silently never recording what it received -- so the
    // films-on-disk view could not show it and gigabytes accumulated with no way
    // to remove them. Worth asserting on the swarm path too.
    const late = swarm.peer('late')
    const { path } = await late.tm.receive(source)
    expect(path).toContain('film.mp4')

    const listed = await late.store.list()
    expect(listed.map(f => f.infoHash.toLowerCase()))
      .toContain(source.infoHash.toLowerCase())

    await until(
      () => (late.tm.get(source.infoHash)?.progress ?? 0) > 0,
      'the late joiner to start receiving', 90_000
    )
  }, 150_000)

  it('does not start a second copy of a film it is already fetching', async () => {
    // receive() is called again whenever the room re-announces, which happens
    // on every reconnect.
    const again = swarm.peer('again')
    const first = await again.tm.receive(source)
    const second = await again.tm.receive(source)
    expect(second.path).toBe(first.path)
    expect(again.tm.progress()).toHaveLength(1)
  }, 150_000)
})
