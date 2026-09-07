/**
 * Which bytes of a file are present.
 *
 * The origin transport fetches byte ranges rather than pieces, and needs the
 * same three answers the piece scheduler gives for a swarm: how much is held,
 * how much plays continuously from here, and what is still missing. Kept pure
 * so all of that can be tested without a network or a disk.
 *
 * Ranges are half-open `[start, end)`, kept sorted and non-overlapping.
 */
export type Range = [number, number]

export function add (ranges: Range[], start: number, end: number): Range[] {
  if (end <= start) return ranges
  const out: Range[] = []
  let [s, e] = [start, end]
  for (const [a, b] of ranges) {
    // Touching counts as overlapping: [0,10) and [10,20) are one run, and
    // treating them as two would report a hole that is not there.
    if (b < s || a > e) {
      if (b < s) out.push([a, b])
      else { out.push([s, e]); s = a; e = b }
    } else {
      s = Math.min(s, a)
      e = Math.max(e, b)
    }
  }
  out.push([s, e])
  return out.sort((x, y) => x[0] - y[0])
}

/** The parts of `[start, end)` not yet held, in order. */
export function missing (ranges: Range[], start: number, end: number): Range[] {
  const gaps: Range[] = []
  let at = start
  for (const [a, b] of ranges) {
    if (b <= at) continue
    if (a >= end) break
    if (a > at) gaps.push([at, Math.min(a, end)])
    at = Math.max(at, b)
    if (at >= end) break
  }
  if (at < end) gaps.push([at, end])
  return gaps
}

export function has (ranges: Range[], start: number, end: number): boolean {
  return missing(ranges, start, end).length === 0
}

export function total (ranges: Range[]): number {
  return ranges.reduce((n, [a, b]) => n + (b - a), 0)
}

/** How far an uninterrupted run extends from `at`. Zero if `at` itself is absent. */
export function contiguousFrom (ranges: Range[], at: number): number {
  for (const [a, b] of ranges) if (a <= at && at < b) return b - at
  return 0
}

/**
 * Seconds of film that play without stopping from `positionSec`.
 *
 * Assumes a constant bitrate, which is wrong for any real encode -- a
 * high-motion scene occupies more bytes per second than a static one. It is
 * used to decide when playback may start, and being approximate there costs a
 * slightly early or late gate rather than a wrong picture.
 */
export function playableSecondsFrom (
  ranges: Range[], positionSec: number, totalBytes: number, durationSec: number
): number {
  if (!(durationSec > 0) || totalBytes <= 0) return 0
  const bytesPerSec = totalBytes / durationSec
  const at = Math.min(Math.floor(positionSec * bytesPerSec), Math.max(0, totalBytes - 1))
  return contiguousFrom(ranges, at) / bytesPerSec
}
