import { describe, it, expect } from 'vitest'
import { isReady, phaseFor, bottleneck, tMinSeconds, etaSeconds, durability, DEFAULT_READINESS, seekableBuckets, seekableAt, seekableSpan, seekableMapOf } from '../src/readiness.js'
import type { PeerStatus } from '@cocine/protocol'

const peer = (over: Partial<PeerStatus> = {}): PeerStatus => ({
  memberId: 'm', name: 'someone', havePct: 0, bufferEndSec: 0,
  downBps: 0, upBps: 0, peers: 0, ready: false, ...over
})

describe('who is ready', () => {
  it('needs a lead buffer, not merely some bytes', () => {
    expect(isReady({ havePct: 0.4, bufferEndSec: 5 }, DEFAULT_READINESS)).toBe(false)
    expect(isReady({ havePct: 0.4, bufferEndSec: 25 }, DEFAULT_READINESS)).toBe(true)
  })

  it('counts anyone holding the whole film, however they report their buffer', () => {
    // The sharer, and anyone who already had it, are ready by definition.
    expect(isReady({ havePct: 1, bufferEndSec: 0 }, DEFAULT_READINESS)).toBe(true)
  })
})

describe('the room phase', () => {
  it('is lobby with no film and preparing while someone is behind', () => {
    expect(phaseFor(false, false, [], false)).toBe('lobby')
    expect(phaseFor(true, false, [peer({ ready: true }), peer({ ready: false })], false)).toBe('preparing')
  })

  it('becomes ready only when everybody is', () => {
    expect(phaseFor(true, false, [peer({ ready: true }), peer({ ready: true })], false)).toBe('ready')
  })

  it('lets the host override the gate', () => {
    expect(phaseFor(true, false, [peer({ ready: false })], true)).toBe('ready')
  })

  it('reports playing over everything else', () => {
    expect(phaseFor(true, true, [peer({ ready: false })], false)).toBe('playing')
  })

  it('does not call an empty room ready', () => {
    expect(phaseFor(true, false, [], false)).toBe('preparing')
  })
})

describe('naming who the room is waiting for', () => {
  it('picks whoever has least of the film', () => {
    expect(bottleneck([
      peer({ name: 'anjali', ready: true, havePct: 1 }),
      peer({ name: 'dev', ready: false, havePct: 0.6 }),
      peer({ name: 'priya', ready: false, havePct: 0.2 })
    ])).toBe('priya')
  })

  it('names nobody when nobody is holding things up', () => {
    expect(bottleneck([peer({ ready: true }), peer({ ready: true })])).toBeNull()
  })
})

describe('the theoretical floor', () => {
  const GB = 1024 ** 3
  it('takes the largest of the three constraints', () => {
    // Sharer upload binds: one copy has to leave their machine regardless.
    const t = tMinSeconds(4 * GB, 3 * 1024 ** 2, [
      { downBps: 100 * 1024 ** 2, upBps: 10 * 1024 ** 2 },
      { downBps: 100 * 1024 ** 2, upBps: 10 * 1024 ** 2 }
    ])
    expect(t).toBeCloseTo((4 * GB) / (3 * 1024 ** 2), 0)
  })

  it('is bound by the slowest downlink when that is worst', () => {
    const t = tMinSeconds(1024 ** 3, 100 * 1024 ** 2, [
      { downBps: 1024 ** 2, upBps: 50 * 1024 ** 2 },
      { downBps: 100 * 1024 ** 2, upBps: 50 * 1024 ** 2 }
    ])
    expect(t).toBeCloseTo(1024, 0)
  })

  it('admits it does not know rather than inventing a number', () => {
    expect(tMinSeconds(4 * GB, 0, [{ downBps: 1, upBps: 1 }])).toBeNull()
    expect(tMinSeconds(4 * GB, 1000, [])).toBeNull()
    expect(tMinSeconds(0, 1000, [{ downBps: 1, upBps: 1 }])).toBeNull()
  })
})

describe('the countdown', () => {
  it('is zero when everyone can already start', () => {
    expect(etaSeconds(1000, [peer({ havePct: 1, ready: true })], DEFAULT_READINESS)).toBe(0)
  })

  it('follows whoever has furthest to go at their own rate', () => {
    const eta = etaSeconds(1_000_000, [
      peer({ name: 'fast', havePct: 0.9, downBps: 100_000 }),
      peer({ name: 'slow', havePct: 0.5, downBps: 10_000 })
    ], DEFAULT_READINESS)
    expect(eta).toBeCloseTo(50, 0)
  })

  it('says nothing rather than dividing by a rate of zero', () => {
    expect(etaSeconds(1_000_000, [peer({ havePct: 0.1, downBps: 0 })], DEFAULT_READINESS)).toBeNull()
  })
})

describe('surviving the sharer leaving', () => {
  it('needs a second whole copy, not just the sharer', () => {
    expect(durability([peer({ havePct: 1 })])).toEqual({ fullCopies: 1, safeForSharerToLeave: false })
    expect(durability([peer({ havePct: 1 }), peer({ havePct: 1 })]))
      .toEqual({ fullCopies: 2, safeForSharerToLeave: true })
  })

  it('is conservative about fragments, which is the safe direction', () => {
    // Three peers holding two thirds each may between them hold every piece.
    // Counting whole copies cannot see that, so it says no -- and a wrong "yes"
    // here loses the film.
    expect(durability([peer({ havePct: 0.7 }), peer({ havePct: 0.7 }), peer({ havePct: 0.7 })]))
      .toEqual({ fullCopies: 0, safeForSharerToLeave: false })
  })
})

/**
 * Phase B1.3: which parts of the film the room may seek to.
 *
 * Seeking moves the playhead for everybody, so a seek into a stretch somebody
 * has not downloaded stalls *them* while the rest watch. The two shapes of that
 * are seeking ahead of the slowest downloader, and a late joiner seeking back
 * into a beginning they never fetched -- a newcomer fetches from the playhead,
 * not from the start, which is a decision recorded well before this existed.
 */

/** A peer holding exactly the buckets in `held`. */
const withMap = (name: string, held: (i: number) => boolean): PeerStatus => ({
  memberId: name, name, havePct: 0.5, bufferEndSec: 30, downBps: 1, upBps: 1,
  peers: 1, ready: true,
  pieces: Array.from({ length: 64 }, (_, i) => (held(i) ? 'f' : '0')).join('')
})

describe('what the whole room can play', () => {
  it('intersects, so one peer missing a stretch takes it away from everyone', () => {
    // The point of the feature. Anjali has the first half, dev the first
    // quarter; the room can only move within the first quarter.
    const seekable = seekableBuckets([
      withMap('anjali', i => i < 32),
      withMap('dev', i => i < 16)
    ])
    expect(seekable.slice(0, 16).every(Boolean)).toBe(true)
    expect(seekable.slice(16).some(Boolean)).toBe(false)
  })

  it('counts only a complete slice as held', () => {
    // pieceMapOf reaches 'f' only for a full bucket -- one piece short reads as
    // 'e' -- so this is conservative in the direction that matters: a bucket
    // wrongly called seekable stalls the room.
    const nearly: PeerStatus = { ...withMap('sam', () => true), pieces: 'e'.repeat(64) }
    expect(seekableBuckets([nearly]).some(Boolean)).toBe(false)
  })

  it('ignores peers that cannot report rather than treating them as empty', () => {
    // Relay mode fetches byte ranges and has no pieces; a client that just
    // joined has not reported yet. Counting either as holding nothing would
    // lock the room out of the whole film.
    const noMap: PeerStatus = {
      memberId: 'r', name: 'relay', havePct: 0.5, bufferEndSec: 30,
      downBps: 1, upBps: 1, peers: 0, ready: true
    }
    const seekable = seekableBuckets([withMap('anjali', i => i < 32), noMap])
    expect(seekable.slice(0, 32).every(Boolean)).toBe(true)
  })

  it('allows everything when nobody can report at all', () => {
    expect(seekableBuckets([]).every(Boolean)).toBe(true)
  })
})

describe('whether a particular moment may be seeked to', () => {
  const firstHalf = seekableBuckets([withMap('anjali', i => i < 32)])

  it('permits a moment everyone holds and refuses one they do not', () => {
    expect(seekableAt(10, 3600, firstHalf)).toBe(true)
    expect(seekableAt(1790, 3600, firstHalf)).toBe(true)
    expect(seekableAt(1810, 3600, firstHalf)).toBe(false)
    expect(seekableAt(3599, 3600, firstHalf)).toBe(false)
  })

  it('does not block on a film whose length is not known yet', () => {
    // Duration arrives with the metadata; refusing every seek until then would
    // read as the seek bar being broken.
    expect(seekableAt(10, 0, firstHalf)).toBe(true)
  })

  it('handles the very end without falling off the last bucket', () => {
    const all = seekableBuckets([withMap('anjali', () => true)])
    expect(seekableAt(3600, 3600, all)).toBe(true)
  })
})

describe('the stretch the interface should draw', () => {
  it('reports the contiguous run around the playhead', () => {
    const seekable = seekableBuckets([withMap('anjali', i => i >= 8 && i < 24)])
    const span = seekableSpan(600, 3600, seekable)
    // Buckets 8..23 of 64 over an hour: 450s to 1350s.
    expect(span.fromSec).toBeCloseTo(450, 0)
    expect(span.toSec).toBeCloseTo(1350, 0)
  })

  it('stops at a gap rather than spanning across it', () => {
    // A late joiner holding the middle and the end but not the join between:
    // the room can move within the run it is in, not into the far one.
    const seekable = seekableBuckets([withMap('dev', i => (i >= 8 && i < 16) || i >= 40)])
    const span = seekableSpan(600, 3600, seekable)
    expect(span.toSec).toBeLessThan(3600 * (40 / 64))
  })

  it('collapses to a point when the playhead is somewhere nobody holds', () => {
    const seekable = seekableBuckets([withMap('anjali', i => i < 8)])
    expect(seekableSpan(3000, 3600, seekable)).toEqual({ fromSec: 3000, toSec: 3000 })
  })

  it('travels as a piece map, so it is drawn by the code that draws the others', () => {
    const seekable = seekableBuckets([withMap('anjali', i => i < 32)])
    const map = seekableMapOf(seekable)
    expect(map).toMatch(/^[0-9a-f]{64}$/)
    expect(map).toBe('f'.repeat(32) + '0'.repeat(32))
  })
})
