import { PIECE_MAP_BUCKETS, type PeerStatus, type RoomPhase } from '@cocine/protocol'

/**
 * What the room can say about its own progress.
 *
 * Kept as pure functions over reports so the arithmetic -- which is where being
 * wrong would produce a countdown nobody trusts -- can be tested without a
 * socket, a swarm, or a film.
 */

export interface ReadinessConfig {
  /** Contiguous seconds each peer needs before the room will start. */
  startBufferSec: number
}

export const DEFAULT_READINESS: ReadinessConfig = { startBufferSec: 20 }

export function isReady (p: { bufferEndSec: number; havePct: number }, cfg: ReadinessConfig): boolean {
  // Holding the whole film counts regardless of how the buffer is reported --
  // the sharer, and anyone who already had it, are ready by definition.
  return p.havePct >= 0.999 || p.bufferEndSec >= cfg.startBufferSec
}

export function phaseFor (
  hasMedia: boolean,
  playing: boolean,
  peers: PeerStatus[],
  overridden: boolean
): RoomPhase {
  if (!hasMedia) return 'lobby'
  if (playing) return 'playing'
  if (overridden || (peers.length > 0 && peers.every(p => p.ready))) return 'ready'
  return 'preparing'
}

/** Whoever is furthest from being able to watch. Null when everyone is fine. */
export function bottleneck (peers: PeerStatus[]): string | null {
  const behind = peers.filter(p => !p.ready)
  if (behind.length === 0) return null
  return behind.reduce((worst, p) => (p.havePct < worst.havePct ? p : worst)).name
}

/**
 * Kumar–Ross minimum distribution time: the floor no scheduling can beat.
 *
 *   max( S/u_sharer , S/d_slowest , N·S/(u_sharer + Σu_peers) )
 *
 * Null until enough rates have been observed to mean anything -- an ETA
 * invented from zeros is worse than admitting the number is not known yet.
 */
export function tMinSeconds (bytes: number, sharerUpBps: number, leechers: Array<{ downBps: number; upBps: number }>): number | null {
  if (bytes <= 0 || sharerUpBps <= 0 || leechers.length === 0) return null
  const slowest = Math.min(...leechers.map(l => l.downBps))
  if (slowest <= 0) return null
  const aggregate = sharerUpBps + leechers.reduce((n, l) => n + l.upBps, 0)
  return Math.max(bytes / sharerUpBps, bytes / slowest, (leechers.length * bytes) / aggregate)
}

/**
 * How long until everyone is ready, from what is actually happening rather than
 * from theory. Uses the peer with the most left to do at its own observed rate.
 */
export function etaSeconds (bytes: number, peers: PeerStatus[], cfg: ReadinessConfig): number | null {
  const waiting = peers.filter(p => !isReady(p, cfg))
  if (waiting.length === 0) return 0
  let worst: number | null = null
  for (const p of waiting) {
    if (p.downBps <= 0) return null
    const remaining = Math.max(0, bytes * (1 - p.havePct))
    const seconds = remaining / p.downBps
    worst = worst === null ? seconds : Math.max(worst, seconds)
  }
  return worst
}

/**
 * Whether the film survives the sharer closing their laptop.
 *
 * Counts whole copies rather than per-piece coverage, which needs bitfields on
 * the wire. That makes it conservative: a room whose peers collectively hold
 * every piece in fragments reads as unsafe. Erring toward "not yet" is the
 * right direction for a question whose wrong answer loses the film.
 */
export function durability (peers: PeerStatus[]): { fullCopies: number; safeForSharerToLeave: boolean } {
  const fullCopies = peers.filter(p => p.havePct >= 0.999).length
  return { fullCopies, safeForSharerToLeave: fullCopies >= 2 }
}

/**
 * Which parts of the film the whole room can play.
 *
 * Phase B1.3. Seeking in a co-watching app is not a local action: moving the
 * playhead moves it for everybody, so a seek into a stretch that somebody has
 * not downloaded stalls *them* while everyone else watches. Two shapes of that
 * problem turn up in practice -- seeking ahead of the slowest downloader, and a
 * late joiner seeking back into the beginning they never fetched, since a
 * newcomer fetches from the playhead rather than from the start.
 *
 * Both are the same question: can every peer play this moment? The piece map
 * each client already reports answers it. One hexadecimal digit per
 * sixty-fourth of the film, and only a complete slice reaches `f` -- one piece
 * short never reads as complete -- so intersecting on `f` is conservative in the
 * direction that matters. A bucket wrongly called seekable stalls the room; a
 * bucket wrongly called unreachable costs a little of the film nobody was
 * trying to watch anyway.
 *
 * Peers that report no map are ignored rather than treated as holding nothing.
 * Relay mode fetches byte ranges and has no pieces to report, and a client that
 * has only just joined has not reported yet; treating either as empty would
 * lock the room out of the entire film.
 */
export function seekableBuckets (peers: PeerStatus[], buckets = PIECE_MAP_BUCKETS): boolean[] {
  const maps = peers.map(p => p.pieces).filter((m): m is string => typeof m === 'string' && m.length === buckets)
  // Nothing to go on: allow everything rather than inventing a restriction.
  if (maps.length === 0) return new Array<boolean>(buckets).fill(true)
  const out = new Array<boolean>(buckets)
  for (let b = 0; b < buckets; b++) {
    out[b] = maps.every(m => m[b] === 'f')
  }
  return out
}

/** Which bucket a moment falls in. */
function bucketOf (positionSec: number, durationSec: number, buckets: number): number {
  if (!(durationSec > 0)) return 0
  const clamped = Math.max(0, Math.min(positionSec, durationSec - 1e-6))
  return Math.min(buckets - 1, Math.floor((clamped / durationSec) * buckets))
}

/** Whether every peer can play this moment. */
export function seekableAt (positionSec: number, durationSec: number, seekable: boolean[]): boolean {
  if (seekable.length === 0) return true
  // A film of unknown length cannot be reasoned about; do not block on it.
  if (!(durationSec > 0)) return true
  return seekable[bucketOf(positionSec, durationSec, seekable.length)] ?? true
}

/**
 * The span around `fromSec` the room can move within without leaving the film
 * it holds — the contiguous run of buckets everyone has, containing that point.
 *
 * This is what the interface should draw. A seek bar that merely refuses is a
 * seek bar that looks broken; one that shows the reachable stretch explains
 * itself, and makes the room's slowest member visible as a property of the room
 * rather than as an error nobody can act on.
 */
export function seekableSpan (
  fromSec: number, durationSec: number, seekable: boolean[]
): { fromSec: number; toSec: number } {
  const buckets = seekable.length
  if (buckets === 0 || !(durationSec > 0)) return { fromSec: 0, toSec: Math.max(0, durationSec) }
  const per = durationSec / buckets
  const here = bucketOf(fromSec, durationSec, buckets)
  if (!seekable[here]) return { fromSec, toSec: fromSec }
  let lo = here
  let hi = here
  while (lo > 0 && seekable[lo - 1]) lo--
  while (hi < buckets - 1 && seekable[hi + 1]) hi++
  return { fromSec: lo * per, toSec: Math.min(durationSec, (hi + 1) * per) }
}

/** The seekable set as a piece map, so it can travel on the wire and be drawn
 *  by the same code that draws everyone else's. */
export function seekableMapOf (seekable: boolean[]): string {
  return seekable.map(b => (b ? 'f' : '0')).join('')
}
