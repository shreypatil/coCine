import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { SignallingServer } from '../../../../apps/server/src/server.js'
import { FilmStore } from '../../src/storage.js'
import { TransferManager, type TransferOptions } from '../../src/transfer.js'
import type { MediaSource, P2PSource } from '@cocine/protocol'

/**
 * A real swarm, on this machine, for tests that need one.
 *
 * The transfer code is the least covered part of the project and the reason is
 * structural rather than neglect: it does nothing on its own. Every interesting
 * property -- can you watch before it finishes, does pausing actually stop
 * serving, does the piece map say *where* somebody is -- needs at least two
 * peers, a tracker they both trust, and a film moving between them. There was
 * nothing that made that cheap to set up, so it mostly went unasserted.
 *
 * This makes it cheap. Everything is real: a real signalling server carrying a
 * real BitTorrent tracker, real WebTorrent clients, WebRTC data channels, and
 * files written to disk. Nothing is stubbed, because the bugs worth catching
 * here live in the interaction rather than in any one function.
 *
 * Two deliberate constraints, both copied from the tests that already worked:
 * peers exchange no ICE servers, since loopback candidates connect directly and
 * reaching a public STUN server made this slow and flaky; and TCP is refused,
 * so anything that transfers, transferred over the path real users will use.
 */

/** Narrow the shared union once, so assertions stay about behaviour. */
export const p2p = (s: MediaSource): P2PSource => {
  if (s.kind !== 'p2p') throw new Error('expected a swarm source')
  return s
}

export const sha = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

/**
 * Wait for something to become true, with a deadline.
 *
 * Never an unbounded loop: a swarm that will not connect must fail the test
 * rather than hang the run, and a wait with no ceiling can outlive the session
 * that started it.
 */
export async function until (
  cond: () => boolean, what: string, ms = 30_000, everyMs = 50
): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`)
    await new Promise(r => setTimeout(r, everyMs))
  }
}

/** A peer in the swarm: its own store, its own directory, its own client. */
export interface Peer {
  name: string
  tm: TransferManager
  store: FilmStore
  /** Where this peer's own files live, as distinct from films it receives. */
  dir: string
}

export class SwarmHarness {
  private constructor (
    private readonly server: SignallingServer,
    readonly trackerUrl: string,
    readonly root: string
  ) {}

  private readonly peers: Peer[] = []

  static async start (): Promise<SwarmHarness> {
    const server = new SignallingServer({})
    const port = await server.listen()
    const root = mkdtempSync(join(tmpdir(), 'cocine-swarm-'))
    // The tracker shares the signalling server's port, on /announce.
    return new SwarmHarness(server, `ws://127.0.0.1:${port}/announce`, root)
  }

  /**
   * Add a peer.
   *
   * `downloadLimitBps` is the one that matters for anything about *progress*.
   * Loopback is far faster than any real link, so an unshaped transfer of a
   * test-sized film finishes between two polls -- and a test that asserts
   * something about a partial transfer would pass or fail on timing rather than
   * on behaviour.
   */
  peer (name: string, opts: Partial<TransferOptions> = {}): Peer {
    const dir = join(this.root, name)
    mkdirSync(dir, { recursive: true })
    const store = new FilmStore(join(dir, 'films'))
    const tm = new TransferManager({
      store,
      trackerUrl: this.trackerUrl,
      // Anything that transfers, transferred over WebRTC.
      webrtcOnly: true,
      // Loopback peers connect on host candidates; no STUN server involved.
      iceServers: [],
      ...opts
    })
    const peer: Peer = { name, tm, store, dir }
    this.peers.push(peer)
    return peer
  }

  /**
   * Share a film and admit it to the tracker.
   *
   * Both halves, because the tracker refuses any info hash no room has
   * announced -- deliberately, so it cannot be used as a public tracker for
   * arbitrary torrents. In the running application the server admits the hash
   * when a room announces the film; in a test there is no room doing that, and
   * forgetting it produces no error anywhere. Peers simply never find each
   * other, and the failure surfaces ninety seconds later as "no metadata from
   * the swarm", which reads like a WebRTC problem and is not one.
   *
   * So the harness does both, and nothing using it has to know.
   */
  async share (peer: Peer, filePath: string): Promise<P2PSource> {
    const source = p2p(await peer.tm.share(filePath))
    this.allow(source.infoHash)
    return source
  }

  /** Admit an info hash to the tracker, as a room announcing media would. */
  allow (infoHash: string): void {
    this.server.tracker.allow(infoHash)
  }

  /**
   * A film for a peer to share, filled with a deterministic pattern.
   *
   * Deterministic rather than random so that a byte range fetched from the
   * stream server can be checked against what that offset *should* hold, which
   * is what distinguishes "served the right bytes" from "served zeros because
   * the piece had not arrived" -- the exact failure the streaming server exists
   * to prevent.
   */
  film (peer: Peer, name: string, bytes: number): string {
    const buf = Buffer.alloc(bytes)
    for (let i = 0; i < bytes; i++) buf[i] = (i * 31 + 7) & 0xff
    const path = join(peer.dir, name)
    writeFileSync(path, buf)
    return path
  }

  /** What `film` wrote at a given offset, to compare a fetched range against. */
  expectedBytes (offset: number, length: number): Buffer {
    const buf = Buffer.alloc(length)
    for (let i = 0; i < length; i++) buf[i] = ((offset + i) * 31 + 7) & 0xff
    return buf
  }

  /**
   * Fetch a byte range from a peer's stream server, the way mpv does when it
   * seeks. Returns the body and the status, so a test can tell a 206 from a 200.
   */
  async range (url: string, from: number, to: number): Promise<{ status: number; body: Buffer }> {
    const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } })
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()) }
  }

  /**
   * Shut everything down.
   *
   * Unconditional and in order: torrents and their clients first, then the
   * server, then the files. A test that failed part-way must not leave a
   * WebTorrent client, a tracker or a listening socket behind.
   */
  async destroy (): Promise<void> {
    for (const p of this.peers) {
      try { await p.tm.destroy() } catch { /* already gone */ }
    }
    this.peers.length = 0
    try { await this.server.close() } catch { /* already gone */ }
    try { rmSync(this.root, { recursive: true, force: true }) } catch { /* gone */ }
  }
}
