import { describe, it, expect } from 'vitest'
import { ClockSync } from '../src/clock.js'

/** Simulates one ping/pong with a known true offset and asymmetric delays. */
function exchange (c: ClockSync, trueOffset: number, upMs: number, downMs: number, c1 = 1000): void {
  const s1 = c1 + upMs + trueOffset
  const s2 = s1 + 1
  const c2 = s2 - trueOffset + downMs
  c.addExchange(c1, s1, s2, c2)
}

describe('ClockSync', () => {
  it('recovers the offset exactly when the path is symmetric', () => {
    const c = new ClockSync()
    exchange(c, 5000, 20, 20)
    expect(c.offsetMs()).toBeCloseTo(5000, 5)
    expect(c.rttMs()).toBeCloseTo(40, 5)
  })

  it('reports uncertainty as half the round trip', () => {
    const c = new ClockSync()
    exchange(c, 0, 30, 30)
    expect(c.uncertaintyMs()).toBeCloseTo(30, 5)
  })

  it('prefers the lowest-RTT sample over the most recent one', () => {
    const c = new ClockSync()
    exchange(c, 5000, 5, 5, 1000)      // clean: rtt 10
    exchange(c, 5000, 400, 20, 2100)   // congested upstream: badly skewed
    // Averaging would drag the estimate toward the skewed sample; picking the
    // best round trip keeps it exact.
    expect(c.offsetMs(2500)).toBeCloseTo(5000, 5)
    expect(c.rttMs(2500)).toBeCloseTo(10, 5)
  })

  it('bounds error by half the asymmetry', () => {
    const c = new ClockSync()
    exchange(c, 0, 60, 20) // 40 ms of asymmetry
    expect(Math.abs(c.offsetMs())).toBeLessThanOrEqual(20 + 1e-6)
  })

  it('still prefers the cleanest sample when every sample has aged out', () => {
    const c = new ClockSync({ maxAgeMs: 10 })
    exchange(c, 1234, 200, 20, 1000)  // skewed
    exchange(c, 1234, 5, 5, 2000)     // clean
    expect(c.offsetMs(1_000_000)).toBeCloseTo(1234, 5)
  })

  it('reports zero and not-ready before any exchange', () => {
    const c = new ClockSync()
    expect(c.ready).toBe(false)
    expect(c.offsetMs()).toBe(0)
  })
})
