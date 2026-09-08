import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { ExternalMpv } from '../src/external-mpv.js'
import { ensureTestVideo } from '../src/fixture.js'

/**
 * What the player says about itself when there is nothing to say.
 *
 * The bug this exists for: mpv reports `time-pos` as null the moment nothing is
 * loaded, and that was ignored as "not a number". The previous film's position
 * stayed cached with pause still false, so the sync engine extrapolated it
 * forwards for ever — an empty player claiming to be twenty seconds into a film
 * that was not there. Loading the next film then meant fighting a playhead that
 * never existed, which on two machines looks exactly like synchronisation
 * collapsing.
 *
 * Runs a real mpv with no video output, so nothing reaches a display.
 */

let player: ExternalMpv
let film: string

beforeAll(async () => {
  film = ensureTestVideo(30, join(process.cwd(), '.fixtures'))
  player = new ExternalMpv({ headless: true })
  await player.start()
}, 60_000)

afterAll(async () => { await player?.close() }, 20_000)

describe('the player with nothing loaded', () => {
  it('forgets the position when a film is unloaded', async () => {
    await player.load(film)
    await player.seek(5)
    await player.play()
    await new Promise(r => setTimeout(r, 600))
    expect(player.position()).toBeGreaterThan(4)

    await player.unload()
    expect(player.position()).toBe(0)
    expect(player.isPaused()).toBe(true)
    expect(player.duration()).toBeNull()
  }, 40_000)

  it('does not let an unloaded player appear to be playing', async () => {
    // This is the property the sync engine depends on: it extrapolates from the
    // last reading only while the player says it is not paused.
    await player.unload()
    const at = player.positionObservedAt()
    await new Promise(r => setTimeout(r, 400))
    expect(player.isPaused()).toBe(true)
    expect(player.position()).toBe(0)
    expect(player.positionObservedAt()).toBeGreaterThanOrEqual(at)
  }, 30_000)

  it('starts the next film from its own beginning, not the last one\'s position', async () => {
    await player.load(film)
    await player.seek(12)
    await new Promise(r => setTimeout(r, 400))
    await player.unload()
    await player.load(film)
    await new Promise(r => setTimeout(r, 600))
    expect(player.position()).toBeLessThan(2)
    expect(player.duration()).toBeGreaterThan(25)
  }, 40_000)
})
