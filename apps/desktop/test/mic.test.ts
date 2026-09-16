import { describe, it, expect } from 'vitest'
import { MicWatch, audioDevices, loadDevice, micConstraints, saveDevice, silentMicMessage, type TrackLike } from '../src/renderer/mic.js'

/**
 * A microphone that opened and delivers nothing looks, from the interface,
 * exactly like nobody talking. These are the decisions that tell the two apart
 * -- tested against a fake track, with time under control, because the real
 * thing needs Bluetooth earbuds paired to a phone at the wrong moment.
 */

function fakeTrack (muted: boolean): TrackLike & { fire: (t: 'mute' | 'unmute' | 'ended') => void } {
  const listeners = new Map<string, Set<() => void>>()
  const t = {
    muted,
    addEventListener: (type: string, cb: () => void) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(cb) },
    removeEventListener: (type: string, cb: () => void) => { listeners.get(type)?.delete(cb) },
    fire: (type: 'mute' | 'unmute' | 'ended') => {
      if (type === 'mute') t.muted = true
      if (type === 'unmute') t.muted = false
      for (const cb of listeners.get(type) ?? []) cb()
    }
  }
  return t as typeof t & TrackLike
}

/** A clock whose timers fire only when told to. */
function clock () {
  let now = 0
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let next = 1
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { const id = next++; timers.push({ at: now + ms, fn, id }); return id },
    clearTimeout: (h: unknown) => { const i = timers.findIndex(t => t.id === h); if (i >= 0) timers.splice(i, 1) },
    advance: (ms: number) => {
      now += ms
      for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) { if (t.at <= now) t.fn(); else timers.push(t) }
    }
  }
}

describe('watching whether the microphone delivers anything', () => {
  it('reports live at once for a track that is already delivering', () => {
    const seen: string[] = []
    const w = new MicWatch(h => seen.push(h), clock())
    w.watch(fakeTrack(false))
    expect(seen).toEqual(['live'])
  })

  it('gives a muted track a grace period, then calls it silent', () => {
    // Bluetooth profile switches take about a second; a track that is muted
    // for 200 ms is a switch in progress, not a broken microphone.
    const c = clock()
    const seen: string[] = []
    const w = new MicWatch(h => seen.push(h), { ...c, graceMs: 1500 })
    w.watch(fakeTrack(true))
    c.advance(1000)
    expect(seen).toEqual([])
    c.advance(600)
    expect(seen).toEqual(['silent'])
  })

  it('reports live when frames start arriving inside the grace period, and never silent', () => {
    const c = clock()
    const seen: string[] = []
    const t = fakeTrack(true)
    new MicWatch(h => seen.push(h), { ...c, graceMs: 1500 }).watch(t)
    c.advance(800)
    t.fire('unmute')
    c.advance(5000)
    expect(seen).toEqual(['live'])
  })

  it('reports each change once, and a later mute as silent again after the grace period', () => {
    const c = clock()
    const seen: string[] = []
    const t = fakeTrack(false)
    new MicWatch(h => seen.push(h), { ...c, graceMs: 1500 }).watch(t)
    t.fire('mute'); c.advance(2000)
    t.fire('unmute'); t.fire('unmute')
    t.fire('mute'); c.advance(2000)
    expect(seen).toEqual(['live', 'silent', 'live', 'silent'])
  })

  it('reports a device that went away as ended', () => {
    const seen: string[] = []
    const t = fakeTrack(false)
    new MicWatch(h => seen.push(h), clock()).watch(t)
    t.fire('ended')
    expect(seen).toEqual(['live', 'ended'])
  })

  it('stops listening when unwatched, and watching a new track starts afresh', () => {
    const c = clock()
    const seen: string[] = []
    const w = new MicWatch(h => seen.push(h), { ...c, graceMs: 1500 })
    const t1 = fakeTrack(true)
    w.watch(t1)
    const t2 = fakeTrack(false)
    w.watch(t2)              // implies unwatch(t1)
    c.advance(5000)
    t1.fire('unmute')
    expect(seen).toEqual(['live'])
  })
})

describe('the devices on offer', () => {
  it('splits microphones from speakers and names the unnamed by position', () => {
    const d = audioDevices([
      { kind: 'audioinput', deviceId: 'default', label: 'Default' },
      { kind: 'audioinput', deviceId: 'bt1', label: 'OnePlus Buds 3' },
      { kind: 'audioinput', deviceId: 'x', label: '' },
      { kind: 'audiooutput', deviceId: 'spk', label: 'Speakers' },
      { kind: 'videoinput', deviceId: 'cam', label: 'Camera' },
      { kind: 'audioinput', deviceId: '', label: 'placeholder before permission' }
    ])
    expect(d.inputs.map(i => i.label)).toEqual(['Default', 'OnePlus Buds 3', 'Microphone 3'])
    expect(d.outputs).toEqual([{ id: 'spk', label: 'Speakers' }])
  })

  it('remembers a chosen device per machine, and forgets it when the default is chosen', () => {
    const data: Record<string, string> = {}
    const s = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v }, removeItem: (k: string) => { delete data[k] } }
    expect(loadDevice(s, 'input')).toBeNull()
    saveDevice(s, 'input', 'bt1'); saveDevice(s, 'output', 'spk')
    expect(loadDevice(s, 'input')).toBe('bt1')
    expect(loadDevice(s, 'output')).toBe('spk')
    saveDevice(s, 'input', null)
    expect(loadDevice(s, 'input')).toBeNull()
    expect(loadDevice(null, 'output')).toBeNull()
  })

  it('asks for a chosen microphone exactly, and for the default with no device at all', () => {
    // `ideal` would let the system hand back the earbuds the person just moved
    // away from. Exact fails visibly instead.
    const chosen = micConstraints('bt1').audio as MediaTrackConstraints
    expect(chosen.deviceId).toEqual({ exact: 'bt1' })
    expect(chosen.echoCancellation).toBe(true)
    expect((micConstraints(null).audio as MediaTrackConstraints).deviceId).toBeUndefined()
  })
})

describe('what the person is told', () => {
  it('names the device when it has a name, and mentions earbuds only once retries are spent', () => {
    expect(silentMicMessage('OnePlus Buds 3', false)).toContain('"OnePlus Buds 3" is not sending any sound yet')
    expect(silentMicMessage('Default', true)).toMatch(/^Your microphone is not sending any sound\. Bluetooth/)
    expect(silentMicMessage(undefined, true)).toContain('choose another microphone')
  })
})

