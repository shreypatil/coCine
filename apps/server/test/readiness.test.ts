import { describe, it, expect } from 'vitest'
import { isReady, phaseFor, bottleneck, tMinSeconds, etaSeconds, durability, DEFAULT_READINESS } from '../src/readiness.js'
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
