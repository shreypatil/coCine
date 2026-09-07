import { describe, it, expect } from 'vitest'
import { add, missing, has, total, contiguousFrom, playableSecondsFrom, type Range } from '../src/ranges.js'

const build = (...rs: Range[]): Range[] => rs.reduce((acc, [a, b]) => add(acc, a, b), [] as Range[])

describe('range bookkeeping', () => {
  it('merges an overlapping range rather than storing it twice', () => {
    expect(build([0, 10], [5, 20])).toEqual([[0, 20]])
  })

  it('merges ranges that only touch, so no phantom hole is reported', () => {
    // [0,10) and [10,20) are one continuous run. Reporting two would make
    // contiguousFrom stop at 10 and stall playback that could continue.
    expect(build([0, 10], [10, 20])).toEqual([[0, 20]])
    expect(contiguousFrom(build([0, 10], [10, 20]), 0)).toBe(20)
  })

  it('keeps genuinely separate ranges separate', () => {
    expect(build([0, 10], [20, 30])).toEqual([[0, 10], [20, 30]])
  })

  it('sorts however the ranges arrive', () => {
    expect(build([20, 30], [0, 10])).toEqual([[0, 10], [20, 30]])
  })

  it('ignores an empty or reversed range', () => {
    expect(add([], 5, 5)).toEqual([])
    expect(add([], 9, 4)).toEqual([])
  })

  it('reports the gaps inside a request', () => {
    expect(missing(build([0, 10], [20, 30]), 0, 30)).toEqual([[10, 20]])
  })

  it('reports a leading and trailing gap', () => {
    expect(missing(build([10, 20]), 0, 30)).toEqual([[0, 10], [20, 30]])
  })

  it('reports nothing missing when the range is covered', () => {
    expect(missing(build([0, 100]), 10, 20)).toEqual([])
    expect(has(build([0, 100]), 10, 20)).toBe(true)
  })

  it('reports everything missing when nothing is held', () => {
    expect(missing([], 0, 50)).toEqual([[0, 50]])
    expect(has([], 0, 1)).toBe(false)
  })

  it('counts held bytes', () => {
    expect(total(build([0, 10], [20, 30]))).toBe(20)
  })

  it('measures a run from a point inside it, not from its start', () => {
    expect(contiguousFrom(build([0, 100]), 40)).toBe(60)
  })

  it('reports zero when the point itself is missing', () => {
    expect(contiguousFrom(build([50, 100]), 40)).toBe(0)
  })
})

describe('playable seconds', () => {
  const BYTES = 1000
  const SECONDS = 100 // 10 bytes per second

  it('converts a held run into seconds of film', () => {
    expect(playableSecondsFrom(build([0, 1000]), 0, BYTES, SECONDS)).toBe(100)
  })

  it('counts only from the playhead, not from the start of the run', () => {
    expect(playableSecondsFrom(build([0, 1000]), 40, BYTES, SECONDS)).toBe(60)
  })

  it('reports zero at a playhead that has not arrived', () => {
    expect(playableSecondsFrom(build([0, 100]), 50, BYTES, SECONDS)).toBe(0)
  })

  it('stops at a hole rather than counting past it', () => {
    // Held 0-500 and 600-1000. From second 0 only 50 seconds play.
    expect(playableSecondsFrom(build([0, 500], [600, 1000]), 0, BYTES, SECONDS)).toBe(50)
  })

  it('is zero for an unknown duration rather than infinite', () => {
    expect(playableSecondsFrom(build([0, 1000]), 0, BYTES, 0)).toBe(0)
  })
})
