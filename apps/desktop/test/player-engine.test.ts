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
  it('runs the <video> engine by default', () => {
    // Decided after using both. The drift figures favour mpv slightly and
    // everything else favours this one -- most decisively, mpv's picture goes
    // black on entering fullscreen and stays black, which is measured in
    // black-screen.e2e.test.ts and written up in docs/TODO.md.
    expect(playerEngine({}, 'linux')).toBe('html')
    expect(playerEngine({}, 'win32')).toBe('html')
    expect(playerEngine({}, 'darwin')).toBe('html')
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
    expect(playerEngine({ COCINE_PLAYER: 'vlc' }, 'linux')).toBe('html')
    expect(playerEngine({ COCINE_PLAYER: '' }, 'linux')).toBe('html')
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

describe('an engine that cannot run here', () => {
  it('reports both as usable now that both are wired up', () => {
    // B1.1 put the <video> player into the main window; before that it existed
    // only inside its own hidden host and had no surface anybody could see.
    expect(engineAvailable('mpv')).toEqual({ ok: true })
    expect(engineAvailable('html')).toEqual({ ok: true })
  })

  it('runs what was asked for, and says nothing when it can', () => {
    const said: string[] = []
    expect(resolveEngine(m => said.push(m), { COCINE_PLAYER: 'html' }, 'linux')).toBe('html')
    // mpv stays selectable: it decodes formats the default engine converts
    // first, which is a real answer for a library of old rips.
    expect(resolveEngine(m => said.push(m), { COCINE_PLAYER: 'mpv' }, 'linux')).toBe('mpv')
    expect(said).toEqual([])
  })
})
