import { describe, it, expect } from 'vitest'
import { tick, extrapolatePosition, DEFAULT_SYNC_CONFIG, type PlayerSnapshot } from '../src/engine.js'
import type { PlaybackState } from '@cocine/protocol'

const player = (over: Partial<PlayerSnapshot> = {}): PlayerSnapshot =>
  ({ positionSec: 0, observedAtMs: 1000, paused: true, rate: 1, ...over })

const playing = (positionSec: number, atServerMs: number): PlaybackState =>
  ({ kind: 'playing', positionSec, atServerMs })

describe('extrapolatePosition', () => {
  it('advances a stale reading at the current rate', () => {
    expect(extrapolatePosition(player({ positionSec: 10, observedAtMs: 1000, paused: false }), 1040)).toBeCloseTo(10.04, 5)
    expect(extrapolatePosition(player({ positionSec: 10, observedAtMs: 1000, paused: false, rate: 2 }), 1040)).toBeCloseTo(10.08, 5)
  })

  it('does not advance a paused reading', () => {
    expect(extrapolatePosition(player({ positionSec: 10, paused: true }), 9999)).toBe(10)
  })
})

describe('tick — scheduled start', () => {
  it('holds paused at the anchor before the start instant', () => {
    const a = tick({
      target: playing(30, 5000), serverNowMs: 4700, localNowMs: 1000,
      player: player({ positionSec: 30, paused: true })
    })
    expect(a.type).toBe('none')
  })

  it('pre-positions if it is sitting somewhere else', () => {
    const a = tick({
      target: playing(30, 5000), serverNowMs: 4700, localNowMs: 1000,
      player: player({ positionSec: 0, paused: true })
    })
    expect(a).toMatchObject({ type: 'seek', toSec: 30 })
  })

  it('refuses to start early even if unpaused', () => {
    const a = tick({
      target: playing(30, 5000), serverNowMs: 4900, localNowMs: 1000,
      player: player({ positionSec: 30, paused: false })
    })
    expect(a.type).toBe('pause')
  })

  it('starts once the anchor time has passed', () => {
    const a = tick({
      target: playing(30, 5000), serverNowMs: 5001, localNowMs: 1000,
      player: player({ positionSec: 30, paused: true })
    })
    expect(a.type).toBe('play')
  })
})

describe('tick — drift correction', () => {
  it('does nothing inside the deadband', () => {
    const a = tick({
      target: playing(0, 0), serverNowMs: 10_000, localNowMs: 1000,
      player: player({ positionSec: 10 - DEFAULT_SYNC_CONFIG.deadbandSec / 2, paused: false })
    })
    expect(a.type).toBe('none')
  })

  it('acts on a drift that two clients could double into a budget breach', () => {
    // Each client resting at the edge of the deadband puts the room spread at
    // twice it, so the deadband must stay well under the per-client share.
    expect(DEFAULT_SYNC_CONFIG.deadbandSec * 2 * 1000).toBeLessThan(50)
  })

  it('slows down when ahead and speeds up when behind', () => {
    const ahead = tick({
      target: playing(0, 0), serverNowMs: 10_000, localNowMs: 1000,
      player: player({ positionSec: 10.25, paused: false })
    })
    expect(ahead.type).toBe('setRate')
    if (ahead.type === 'setRate') expect(ahead.rate).toBeLessThan(1)

    const behind = tick({
      target: playing(0, 0), serverNowMs: 10_000, localNowMs: 1000,
      player: player({ positionSec: 9.75, paused: false })
    })
    expect(behind.type).toBe('setRate')
    if (behind.type === 'setRate') expect(behind.rate).toBeGreaterThan(1)
  })

  it('never deviates more than the configured maximum', () => {
    const a = tick({
      target: playing(0, 0), serverNowMs: 10_000, localNowMs: 1000,
      player: player({ positionSec: 9.1, paused: false })
    })
    if (a.type === 'setRate') {
      expect(a.rate).toBeLessThanOrEqual(1 + DEFAULT_SYNC_CONFIG.maxRateDeviation + 1e-9)
      expect(a.rate).toBeGreaterThanOrEqual(1 - DEFAULT_SYNC_CONFIG.maxRateDeviation - 1e-9)
    } else { expect.unreachable('expected a rate correction') }
  })

  it('seeks rather than nudges once drift is large', () => {
    const a = tick({
      target: playing(0, 0), serverNowMs: 10_000, localNowMs: 1000,
      player: player({ positionSec: 4, paused: false })
    })
    expect(a.type).toBe('seek')
    if (a.type === 'seek') expect(a.toSec).toBeCloseTo(10 + DEFAULT_SYNC_CONFIG.seekLeadSec, 5)
  })
})

describe('tick — converges', () => {
  it('erases a 400 ms drift within the correction horizon and holds', () => {
    // A closed loop: apply the engine's own output to a simulated player and
    // check the error actually goes to zero rather than oscillating.
    let pos = 10.4              // 400 ms ahead of the room
    let rate = 1
    const stepMs = 100
    let serverNow = 10_000      // room is at t=10s and advancing
    const target = playing(0, 0)

    // 400 ms of drift at a 5 % maximum rate deviation needs 8 s to erase, so
    // only the tail of a 20 s run tells you whether it settled or oscillated.
    let maxAfterHorizon = 0
    for (let i = 0; i < 200; i++) {
      const a = tick({
        target, serverNowMs: serverNow, localNowMs: 1000,
        player: { positionSec: pos, observedAtMs: 1000, paused: false, rate }
      })
      if (a.type === 'setRate') rate = a.rate
      if (a.type === 'seek') pos = a.toSec
      pos += (stepMs / 1000) * rate
      serverNow += stepMs
      const drift = Math.abs(pos - serverNow / 1000)
      if (i > 120) maxAfterHorizon = Math.max(maxAfterHorizon, drift)
    }
    expect(maxAfterHorizon).toBeLessThan(0.05)
  })
})
