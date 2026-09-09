import { describe, it, expect } from 'vitest'
import {
  playerEngine, defaultEngine, engineAvailable, resolveEngine
} from '../src/main/player-engine.js'

/**
 * The switch between mpv and the `<video>` player.
 *
 * Both engines are kept because the B1.0 gate answered "can it?" and not "is it
 * better?" -- the `<video>` player clears every bar mpv clears, but holds the
 * room to a p99 drift of 48.7 ms against mpv's 26.9 ms on an identical run.
 * Which one ships, and on which platform, is a judgement to make after using
 * both rather than after reading a benchmark.
 *
 * So the thing worth testing is that the switch cannot strand somebody: an
 * unrecognised value must not stop the application starting, and asking for an
 * engine that is not wired up yet must produce a sentence rather than a black
 * rectangle.
 */

describe('choosing an engine', () => {
  it('runs mpv by default, which is the shipped and exercised path', () => {
    expect(playerEngine({}, 'linux')).toBe('mpv')
    expect(playerEngine({}, 'win32')).toBe('mpv')
    expect(playerEngine({}, 'darwin')).toBe('mpv')
  })

  it('honours an explicit choice, which is how the two get compared', () => {
    expect(playerEngine({ COCINE_PLAYER: 'html' }, 'linux')).toBe('html')
    expect(playerEngine({ COCINE_PLAYER: 'mpv' }, 'linux')).toBe('mpv')
  })

  it('is forgiving about spelling, since this is typed by hand while testing', () => {
    expect(playerEngine({ COCINE_PLAYER: ' HTML ' }, 'linux')).toBe('html')
    expect(playerEngine({ COCINE_PLAYER: 'MPV' }, 'linux')).toBe('mpv')
  })

  it('ignores a value it does not recognise rather than refusing to start', () => {
    // A typo in an environment variable should not stop the application; it
    // should start the engine that works.
    expect(playerEngine({ COCINE_PLAYER: 'vlc' }, 'linux')).toBe('mpv')
    expect(playerEngine({ COCINE_PLAYER: '' }, 'linux')).toBe('mpv')
  })

  it('can answer differently per platform, which is the point of taking one', () => {
    // Nothing forces one answer everywhere: the two engines have entirely
    // different weak points, and PlayerController is what makes a room able to
    // hold one of each without noticing.
    for (const p of ['linux', 'win32', 'darwin'] as const) {
      expect(['mpv', 'html']).toContain(defaultEngine(p))
    }
  })
})

describe('asking for an engine that is not ready', () => {
  it('says the <video> player is not on screen yet, and how to drive it', () => {
    const check = engineAvailable('html')
    expect(check.ok).toBe(false)
    expect(check.why).toMatch(/B1\.1/)
    expect(check.why).toMatch(/phase0:html/)
  })

  it('reports mpv as usable', () => {
    expect(engineAvailable('mpv')).toEqual({ ok: true })
  })

  it('falls back with an explanation rather than starting something invisible', () => {
    // The failure this prevents: selecting an engine with no surface, and
    // getting a black rectangle with nothing said about why.
    const said: string[] = []
    const engine = resolveEngine(m => said.push(m), { COCINE_PLAYER: 'html' }, 'linux')
    expect(engine).toBe('mpv')
    expect(said.join(' ')).toMatch(/not wired into the window yet/)
  })

  it('says nothing when the engine asked for is the one that runs', () => {
    const said: string[] = []
    expect(resolveEngine(m => said.push(m), { COCINE_PLAYER: 'mpv' }, 'linux')).toBe('mpv')
    expect(said).toEqual([])
  })
})
