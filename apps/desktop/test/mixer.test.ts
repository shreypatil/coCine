import { describe, it, expect } from 'vitest'
import { EMPTY, FULL, applyMixer, gainFor, levelOf, loadDucking, micState, outputFor, prune, saveDucking, type Levels, type Output } from '../src/renderer/mixer.js'

/**
 * The local mixer is pure state applied to two element properties, so the
 * composition rules are tested here without a browser. What a real
 * HTMLAudioElement does with the values is mixer-live.test.ts.
 */

describe('the volume curve', () => {
  it('is silent at the bottom, full at the top, and perceptually half way in the middle', () => {
    expect(gainFor(0)).toBe(0)
    expect(gainFor(FULL)).toBe(1)
    // A linear map puts most of the useful range in the bottom quarter of the
    // slider; squared, the mid point sounds about half as loud.
    expect(gainFor(50)).toBeCloseTo(0.25)
    expect(gainFor(71)).toBeCloseTo(0.5, 1)
  })

  it('never exceeds one, whatever the slider claims', () => {
    // Boost is deliberately unavailable: on a marginal speakers-and-microphone
    // setup it tips the echo the canceller cannot hear into feedback.
    expect(gainFor(250)).toBe(1)
    expect(gainFor(-10)).toBe(0)
  })

  it('rises monotonically', () => {
    let last = -1
    for (let l = 0; l <= FULL; l++) { expect(gainFor(l)).toBeGreaterThanOrEqual(last); last = gainFor(l) }
  })
})

describe('composing one output', () => {
  const m: Levels = { level: { sam: 40 }, muted: { dev: true } }

  it('defaults an untouched person to full', () => {
    expect(levelOf(m, 'anjali')).toBe(FULL)
    expect(outputFor(m, 'anjali', false)).toEqual({ volume: 1, muted: false })
  })

  it('applies their own slider', () => {
    expect(outputFor(m, 'sam', false)).toEqual({ volume: gainFor(40), muted: false })
  })

  it('mutes a person muted for me, and keeps their slider where it was', () => {
    expect(outputFor(m, 'dev', false)).toEqual({ volume: 1, muted: true })
    expect(levelOf(m, 'dev')).toBe(FULL)
  })

  it('deafening silences everyone without touching their levels', () => {
    // The composition bug the film's volume once had: two writers to one
    // control, and whichever wrote last won. Deafen must never reset anyone.
    expect(outputFor(m, 'sam', true)).toEqual({ volume: gainFor(40), muted: true })
    expect(outputFor(m, 'anjali', true)).toEqual({ volume: 1, muted: true })
    // And undeafening puts everybody back exactly where they were.
    expect(outputFor(m, 'sam', false)).toEqual({ volume: gainFor(40), muted: false })
    expect(outputFor(m, 'dev', false).muted).toBe(true)
  })
})

describe('writing onto elements', () => {
  it('sets every element, and only writes what changed', () => {
    let writes = 0
    const el = (): Output => {
      const o = { _v: 1, _m: false }
      return {
        get volume () { return o._v }, set volume (v: number) { writes++; o._v = v },
        get muted () { return o._m }, set muted (v: boolean) { writes++; o._m = v }
      }
    }
    const els = new Map<string, Output>([['sam', el()], ['dev', el()]])
    applyMixer(els, { level: { sam: 40 }, muted: {} }, false)
    expect(els.get('sam')!.volume).toBeCloseTo(gainFor(40))
    expect(els.get('dev')!.volume).toBe(1)
    expect(writes).toBe(1)
    // Idempotent: applying the same state again touches nothing.
    applyMixer(els, { level: { sam: 40 }, muted: {} }, false)
    expect(writes).toBe(1)
  })
})

describe('forgetting people who left', () => {
  it('drops levels and mutes for anyone no longer present', () => {
    const m: Levels = { level: { sam: 40, dev: 70 }, muted: { dev: true, ravi: true } }
    expect(prune(m, ['sam'])).toEqual({ level: { sam: 40 }, muted: {} })
    expect(prune(EMPTY, [])).toEqual(EMPTY)
  })
})

describe('the microphone and the film', () => {
  const base = { inVoice: true, muted: false, pushToTalk: true, talking: false, ducking: true }

  it('ducks only while the microphone is actually sending', () => {
    expect(micState(base)).toEqual({ mic: false, duck: false })
    expect(micState({ ...base, talking: true })).toEqual({ mic: true, duck: true })
    expect(micState({ ...base, pushToTalk: false })).toEqual({ mic: true, duck: true })
    expect(micState({ ...base, pushToTalk: false, muted: true })).toEqual({ mic: false, duck: false })
    expect(micState({ ...base, talking: true, inVoice: false })).toEqual({ mic: false, duck: false })
  })

  it('leaves the film alone for someone who turned ducking off, mic live or not', () => {
    expect(micState({ ...base, talking: true, ducking: false })).toEqual({ mic: true, duck: false })
  })
})

describe('the ducking preference', () => {
  const store = (): Pick<Storage, 'getItem' | 'setItem'> & { data: Record<string, string> } => {
    const data: Record<string, string> = {}
    return { data, getItem: k => data[k] ?? null, setItem: (k, v) => { data[k] = v } }
  }

  it('is on until somebody turns it off, and remembers that', () => {
    const s = store()
    expect(loadDucking(s)).toBe(true)
    saveDucking(s, false)
    expect(loadDucking(s)).toBe(false)
    saveDucking(s, true)
    expect(loadDucking(s)).toBe(true)
  })

  it('survives storage that is missing or throws', () => {
    expect(loadDucking(null)).toBe(true)
    const broken = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') } }
    expect(loadDucking(broken)).toBe(true)
    expect(() => saveDucking(broken, false)).not.toThrow()
  })
})
