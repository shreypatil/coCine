import { describe, it, expect } from 'vitest'
import { SpeechGate, rms } from '../src/renderer/speaking.js'

/**
 * The indicator has one job beyond looking right: it must be believable. A dot
 * that flickers on every syllable, or that stays lit after somebody stops, is
 * worse than none -- it is the thing you would check to find out whether your
 * microphone is working at all.
 */

describe('deciding that somebody is speaking', () => {
  it('lights up once the level passes the threshold', () => {
    const g = new SpeechGate({ on: 0.02, off: 0.012, holdMs: 400 })
    expect(g.update(0.001, 0)).toBe(false)
    expect(g.update(0.05, 100)).toBe(true)
  })

  it('does not go out between words', () => {
    // The gaps in ordinary speech are longer than they feel. Without the hold,
    // the dot strobes on every pause and reads as a broken connection.
    const g = new SpeechGate({ on: 0.02, off: 0.012, holdMs: 400 })
    g.update(0.05, 0)
    expect(g.update(0.001, 100)).toBe(true)
    expect(g.update(0.001, 300)).toBe(true)
    expect(g.update(0.06, 350)).toBe(true)
  })

  it('goes out once the hold has elapsed', () => {
    const g = new SpeechGate({ on: 0.02, off: 0.012, holdMs: 400 })
    g.update(0.05, 0)
    expect(g.update(0.001, 200)).toBe(true)
    expect(g.update(0.001, 401)).toBe(false)
  })

  it('restarts the hold when the voice comes back', () => {
    const g = new SpeechGate({ on: 0.02, off: 0.012, holdMs: 400 })
    g.update(0.05, 0)
    g.update(0.001, 300)      // quiet, but within the hold
    g.update(0.05, 350)       // speaking again -- the clock resets
    expect(g.update(0.001, 700)).toBe(true)
    expect(g.update(0.001, 760)).toBe(false)
  })

  it('uses hysteresis, so a voice sitting at the threshold does not strobe', () => {
    // Between `off` and `on`: too quiet to start, loud enough to continue.
    const g = new SpeechGate({ on: 0.02, off: 0.012, holdMs: 400 })
    expect(g.update(0.015, 0)).toBe(false)
    g.update(0.05, 100)
    expect(g.update(0.015, 200)).toBe(true)
    expect(g.update(0.015, 5000)).toBe(true)
  })

  it('stays dark for a muted microphone, which is silence', () => {
    // A disabled track emits silence to everything downstream, so this is also
    // what push-to-talk looks like while the key is up.
    const g = new SpeechGate()
    for (let t = 0; t < 5000; t += 100) expect(g.update(0, t)).toBe(false)
  })
})

describe('measuring loudness', () => {
  it('is zero for silence', () => {
    expect(rms(new Float32Array(512))).toBe(0)
  })

  it('reports the root mean square, not the peak', () => {
    // A single click in an otherwise silent frame must not light the dot.
    const click = new Float32Array(1024)
    click[0] = 1
    expect(rms(click)).toBeLessThan(0.032)

    // A sustained quiet tone should, despite a much smaller peak.
    const tone = new Float32Array(1024).map((_, i) => 0.05 * Math.sin(i / 4))
    expect(rms(tone)).toBeGreaterThan(0.03)
  })

  it('survives an empty frame rather than returning NaN', () => {
    expect(rms(new Float32Array(0))).toBe(0)
  })
})
