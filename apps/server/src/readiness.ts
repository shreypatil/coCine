import type { PeerStatus, RoomPhase } from '@cocine/protocol'

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
