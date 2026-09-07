/**
 * Which pieces to ask for, and in what order.
 *
 * Rarest-first is right for swarm health and wrong for watching: it optimises
 * for the file eventually existing, not for the next ten seconds being ready.
 * Strict sequential is wrong too -- it starves the swarm of piece diversity and
 * quietly makes everyone slower. So the file is split into zones that move with
 * the playhead, and only the zones near it override the default.
 *
 * All of this is arithmetic over piece indices, deliberately kept free of any
 * torrent object so it can be tested exhaustively without a network.
 */

export interface PieceGeometry {
  pieceLength: number
  pieceCount: number
  totalBytes: number
  /** Film length in seconds. Zero or unknown means positions cannot be mapped. */
  durationSec: number
}

export interface WindowConfig {
  /** Fetched strictly in order, as soon as possible. */
  criticalSec: number
  /** Fetched ahead of the bulk of the file, but without the urgency. */
  bufferSec: number
}

export const DEFAULT_WINDOWS: WindowConfig = { criticalSec: 10, bufferSec: 60 }

export type PieceRange = readonly [number, number]

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

/**
 * Position in the film to a piece index. Assumes a constant bitrate, which is
 * wrong for every real film -- but the error is a few seconds of material in
 * either direction, and the windows are tens of seconds wide. Being roughly
 * right here is enough; being exactly right would need the container's index.
 */
export function pieceAt (positionSec: number, g: PieceGeometry): number {
  if (g.pieceCount <= 0) return 0
  if (!(g.durationSec > 0)) return 0
  const fraction = clamp(positionSec / g.durationSec, 0, 1)
  return clamp(Math.floor((fraction * g.totalBytes) / g.pieceLength), 0, g.pieceCount - 1)
}

export function secondsToPieces (seconds: number, g: PieceGeometry): number {
  if (!(g.durationSec > 0) || g.pieceLength <= 0) return 0
  const bytesPerSec = g.totalBytes / g.durationSec
  return Math.max(1, Math.ceil((seconds * bytesPerSec) / g.pieceLength))
}

export interface PieceWindows {
  /** In-order and urgent: the next few seconds of picture. */
  critical: PieceRange
  /** Ahead of the playhead but not urgent. Includes the critical range. */
  buffer: PieceRange
}

export function windowsFor (positionSec: number, g: PieceGeometry, cfg: WindowConfig = DEFAULT_WINDOWS): PieceWindows {
  const last = Math.max(0, g.pieceCount - 1)
  const start = pieceAt(positionSec, g)
  const criticalEnd = clamp(start + secondsToPieces(cfg.criticalSec, g), start, last)
  const bufferEnd = clamp(start + secondsToPieces(cfg.bufferSec, g), criticalEnd, last)
  return { critical: [start, criticalEnd], buffer: [start, bufferEnd] }
}

/**
 * The head and tail of the file, which have to arrive before anything else.
 *
 * Matroska keeps its Cues -- the seek index -- at the *end* of the file, and
 * mpv cannot seek without them. Fetch sequentially from the start and seeking
 * appears broken for the whole session, which reads as a broken application
 * rather than a missing download. MP4 has the same problem whenever the moov
 * atom was not moved to the front.
 *
 * The head carries the EBML header and track definitions, so both ends matter.
 */
export function indexRanges (g: PieceGeometry, headBytes = 2 * 1024 * 1024, tailBytes = 4 * 1024 * 1024): PieceRange[] {
  if (g.pieceCount <= 0 || g.pieceLength <= 0) return []
  const last = g.pieceCount - 1
  const headEnd = clamp(Math.ceil(headBytes / g.pieceLength) - 1, 0, last)
  const tailStart = clamp(last - (Math.ceil(tailBytes / g.pieceLength) - 1), 0, last)

  // On a small file the two halves meet; one range is then the whole thing.
  if (tailStart <= headEnd + 1) return [[0, last]]
  return [[0, headEnd], [tailStart, last]]
}

/**
 * How many seconds of film are available without a gap, starting where playback
 * is. This is the number the readiness gate turns on: not how much of the file
 * exists, but how long it can play before running into a hole.
 */
export function contiguousSecondsFrom (positionSec: number, g: PieceGeometry, has: (index: number) => boolean): number {
  if (g.pieceCount <= 0 || !(g.durationSec > 0)) return 0
  const start = pieceAt(positionSec, g)
  if (!has(start)) return 0
  let end = start
  while (end + 1 < g.pieceCount && has(end + 1)) end++
  const bytesPerSec = g.totalBytes / g.durationSec
  // The playhead sits somewhere inside its piece, so only count from there.
  const availableTo = Math.min((end + 1) * g.pieceLength, g.totalBytes)
  return Math.max(0, availableTo / bytesPerSec - positionSec)
}

/** The slice of a torrent the scheduler needs. Kept minimal so it can be faked. */
export interface SelectableTorrent {
  pieceLength: number
  length: number
  pieces: Array<unknown | null>
  select: (start: number, end: number, priority?: number) => void
  deselect: (start: number, end: number) => void
  critical: (start: number, end: number) => void
}

const HIGH_PRIORITY = 1

/**
 * Applies the windows to a torrent as the playhead moves.
 *
 * Two things about WebTorrent's API shape this class. `critical()` only ever
 * sets flags -- there is no way to clear one -- so re-issuing a range is safe
 * but pointless, and the class only calls it when the range actually changes.
 * `select()` accumulates instead of replacing, so the previous window has to be
 * deselected first or the selection list grows without bound and every range
 * ends up equally important, which is the same as having no windows at all.
 */
export class PieceScheduler {
  private primed = false
  private lastCritical: PieceRange | null = null
  private lastBuffer: PieceRange | null = null

  constructor (
    private readonly torrent: SelectableTorrent,
    private durationSec: number,
    private readonly cfg: WindowConfig = DEFAULT_WINDOWS
  ) {}

  setDuration (seconds: number): void { this.durationSec = seconds }

  geometry (): PieceGeometry {
    return {
      pieceLength: this.torrent.pieceLength,
      pieceCount: this.torrent.pieces.length,
      totalBytes: this.torrent.length,
      durationSec: this.durationSec
    }
  }

  /** Fetch the container's head and tail before anything else. Once only. */
  prime (): PieceRange[] {
    if (this.primed) return []
    this.primed = true
    const ranges = indexRanges(this.geometry())
    for (const [a, b] of ranges) this.torrent.critical(a, b)
    return ranges
  }

  update (positionSec: number): PieceWindows {
    const w = windowsFor(positionSec, this.geometry(), this.cfg)

    if (!this.lastCritical || this.lastCritical[0] !== w.critical[0] || this.lastCritical[1] !== w.critical[1]) {
      this.torrent.critical(w.critical[0], w.critical[1])
      this.lastCritical = w.critical
    }

    if (!this.lastBuffer || this.lastBuffer[0] !== w.buffer[0] || this.lastBuffer[1] !== w.buffer[1]) {
      if (this.lastBuffer) this.torrent.deselect(this.lastBuffer[0], this.lastBuffer[1])
      this.torrent.select(w.buffer[0], w.buffer[1], HIGH_PRIORITY)
      this.lastBuffer = w.buffer
    }
    return w
  }
}
