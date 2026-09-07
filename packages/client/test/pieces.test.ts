import { describe, it, expect } from 'vitest'
import { pieceAt, secondsToPieces, windowsFor, indexRanges, DEFAULT_WINDOWS, type PieceGeometry } from '../src/pieces.js'

/** A 4 GB film, two hours, 1 MB pieces -- the shape the plan is written around. */
const FILM: PieceGeometry = {
  pieceLength: 1024 * 1024,
  totalBytes: 4 * 1024 ** 3,
  pieceCount: 4096,
  durationSec: 7200
}

describe('mapping time onto pieces', () => {
  it('puts the start at the first piece and the end at the last', () => {
    expect(pieceAt(0, FILM)).toBe(0)
    expect(pieceAt(7200, FILM)).toBe(4095)
  })

  it('puts halfway through the film halfway through the file', () => {
    expect(pieceAt(3600, FILM)).toBe(2048)
  })

  it('clamps rather than running off either end', () => {
    expect(pieceAt(-500, FILM)).toBe(0)
    expect(pieceAt(99_999, FILM)).toBe(4095)
  })

  it('falls back to the beginning when the duration is unknown', () => {
    // Better to fetch from the start than to compute a nonsense offset.
    expect(pieceAt(600, { ...FILM, durationSec: 0 })).toBe(0)
  })

  it('converts a span of film into a count of pieces', () => {
    // 4 GB over 7200s is ~596 kB/s, so ten seconds is about six pieces.
    expect(secondsToPieces(10, FILM)).toBe(6)
    expect(secondsToPieces(60, FILM)).toBe(35)
  })

  it('never asks for zero pieces, which would stall the window', () => {
    expect(secondsToPieces(0.001, FILM)).toBe(1)
  })
})

describe('the moving windows', () => {
  it('opens at the playhead, with buffer enclosing critical', () => {
    const w = windowsFor(0, FILM)
    expect(w.critical[0]).toBe(0)
    expect(w.buffer[0]).toBe(0)
    expect(w.buffer[1]).toBeGreaterThan(w.critical[1])
  })

  it('moves forward with the playhead', () => {
    const a = windowsFor(0, FILM)
    const b = windowsFor(3600, FILM)
    expect(b.critical[0]).toBeGreaterThan(a.critical[1])
  })

  it('is roughly the requested amount of film wide', () => {
    const w = windowsFor(1000, FILM)
    const pieces = w.critical[1] - w.critical[0]
    const seconds = (pieces * FILM.pieceLength) / (FILM.totalBytes / FILM.durationSec)
    expect(seconds).toBeGreaterThan(DEFAULT_WINDOWS.criticalSec * 0.7)
    expect(seconds).toBeLessThan(DEFAULT_WINDOWS.criticalSec * 1.5)
  })

  it('does not run past the end of the file near the credits', () => {
    const w = windowsFor(7199, FILM)
    expect(w.critical[1]).toBe(4095)
    expect(w.buffer[1]).toBe(4095)
    expect(w.critical[0]).toBeLessThanOrEqual(w.critical[1])
  })

  it('never produces a backwards range at any point in the film', () => {
    for (let t = 0; t <= 7200; t += 37) {
      const w = windowsFor(t, FILM)
      expect(w.critical[1]).toBeGreaterThanOrEqual(w.critical[0])
      expect(w.buffer[1]).toBeGreaterThanOrEqual(w.critical[1])
      expect(w.buffer[1]).toBeLessThanOrEqual(4095)
    }
  })
})

describe('the container index', () => {
  it('asks for both ends of the file, because the seek index lives at the end', () => {
    // Matroska keeps its Cues last. Fetch sequentially and seeking is broken
    // for the whole session.
    const ranges = indexRanges(FILM)
    expect(ranges).toHaveLength(2)
    expect(ranges[0]![0]).toBe(0)
    expect(ranges[1]![1]).toBe(4095)
  })

  it('keeps both ends small relative to the film', () => {
    const ranges = indexRanges(FILM)
    const pieces = ranges.reduce((n, [a, b]) => n + (b - a + 1), 0)
    expect(pieces / FILM.pieceCount).toBeLessThan(0.01)
  })

  it('collapses to the whole file when it is smaller than the two ends', () => {
    const tiny: PieceGeometry = { pieceLength: 16384, totalBytes: 200_000, pieceCount: 13, durationSec: 30 }
    expect(indexRanges(tiny)).toEqual([[0, 12]])
  })

  it('returns nothing rather than a bad range when there is no torrent yet', () => {
    expect(indexRanges({ pieceLength: 0, totalBytes: 0, pieceCount: 0, durationSec: 0 })).toEqual([])
  })
})

import { PieceScheduler, type SelectableTorrent } from '../src/pieces.js'

interface Call { fn: string; args: number[] }
function fakeTorrent (): SelectableTorrent & { calls: Call[] } {
  const calls: Call[] = []
  return {
    pieceLength: FILM.pieceLength,
    length: FILM.totalBytes,
    pieces: new Array(FILM.pieceCount).fill(null),
    select: (a, b, p) => calls.push({ fn: 'select', args: [a, b, p ?? 0] }),
    deselect: (a, b) => calls.push({ fn: 'deselect', args: [a, b] }),
    critical: (a, b) => calls.push({ fn: 'critical', args: [a, b] }),
    calls
  }
}

describe('PieceScheduler', () => {
  it('fetches the container index first, and only once', () => {
    const t = fakeTorrent()
    const s = new PieceScheduler(t, FILM.durationSec)
    expect(s.prime()).toHaveLength(2)
    expect(s.prime()).toHaveLength(0)
    expect(t.calls.filter(c => c.fn === 'critical')).toHaveLength(2)
  })

  it('deselects the previous window before selecting the next', () => {
    // select() accumulates in WebTorrent. Without the deselect the selection
    // list grows until every range is equally important, which is the same as
    // having no windows at all.
    const t = fakeTorrent()
    const s = new PieceScheduler(t, FILM.durationSec)
    s.update(0)
    t.calls.length = 0
    s.update(600)
    const order = t.calls.map(c => c.fn)
    expect(order.indexOf('deselect')).toBeLessThan(order.indexOf('select'))
    expect(t.calls.filter(c => c.fn === 'select')).toHaveLength(1)
  })

  it('says nothing to the torrent when the windows have not changed', () => {
    const t = fakeTorrent()
    const s = new PieceScheduler(t, FILM.durationSec)
    s.update(100)
    t.calls.length = 0
    s.update(100)
    expect(t.calls).toHaveLength(0)
  })

  it('stays quiet while the playhead moves within a single piece', () => {
    // Computed from the geometry rather than guessed: at 596 kB/s a 1 MB piece
    // is about 1.75s of film, and picking a fixed pair of times straddled a
    // piece boundary by accident.
    const t = fakeTorrent()
    const s = new PieceScheduler(t, FILM.durationSec)
    const secondsPerPiece = FILM.pieceLength / (FILM.totalBytes / FILM.durationSec)
    const base = 100
    const start = pieceAt(base, FILM)
    let inside = base
    while (pieceAt(inside + secondsPerPiece / 8, FILM) === start) inside += secondsPerPiece / 8
    s.update(base)
    t.calls.length = 0
    s.update(base + (inside - base) / 2)
    expect(t.calls).toHaveLength(0)
  })

  it('follows a seek backwards as readily as forwards', () => {
    const t = fakeTorrent()
    const s = new PieceScheduler(t, FILM.durationSec)
    s.update(3600)
    t.calls.length = 0
    const w = s.update(60)
    expect(w.critical[0]).toBeLessThan(100)
    expect(t.calls.some(c => c.fn === 'critical' && c.args[0] === w.critical[0])).toBe(true)
  })

  it('keeps working when the duration only arrives later', () => {
    const t = fakeTorrent()
    const s = new PieceScheduler(t, 0)
    expect(s.update(600).critical[0]).toBe(0)
    s.setDuration(FILM.durationSec)
    expect(s.update(3600).critical[0]).toBeGreaterThan(2000)
  })

  it('issues one selection per move across a whole film, not a growing pile', () => {
    const t = fakeTorrent()
    const s = new PieceScheduler(t, FILM.durationSec)
    for (let sec = 0; sec < 7200; sec += 30) s.update(sec)
    const selects = t.calls.filter(c => c.fn === 'select').length
    const deselects = t.calls.filter(c => c.fn === 'deselect').length
    expect(selects - deselects).toBe(1)
  })
})
