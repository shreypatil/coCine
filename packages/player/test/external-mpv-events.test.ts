import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { ExternalMpv } from '../src/external-mpv.js'

/**
 * How the player decodes what mpv tells it.
 *
 * `player-state.test.ts` drives a real mpv and covers the behaviour that
 * matters most -- a null `time-pos` must not leave the sync engine
 * extrapolating a position that does not exist. What it cannot do is ask mpv
 * for a specific event shape: property changes only arrive as a consequence of
 * playing something, so the branches that handle a value of the *wrong type*
 * were unreachable from there and went unasserted.
 *
 * Those branches are where a silent failure would live. Every one of them
 * decides what the sync engine is told about the playhead, and being wrong
 * there does not raise anything -- it drifts the room apart.
 *
 * `support/fake-mpv.mjs` emits an exact event on request. Everything above the
 * socket is the real ExternalMpv.
 */

const FAKE = fileURLToPath(new URL('./support/fake-mpv.mjs', import.meta.url))

// The observe ids ExternalMpv registers, which is what its decoder switches on.
const OBS_TIME = 1
const OBS_PAUSE = 2
const OBS_DURATION = 3

const players: ExternalMpv[] = []
afterEach(async () => {
  // kill() rather than close(): unconditional and synchronous, so a failed test
  // cannot leave an mpv stand-in running on the machine.
  for (const p of players.splice(0)) { try { p.kill() } catch { /* already gone */ } }
})

async function player (): Promise<ExternalMpv> {
  const p = new ExternalMpv({ binary: FAKE })
  players.push(p)
  await p.start()
  return p
}

/** Ask the fake to emit one property-change and wait for it to be decoded. */
async function emit (p: ExternalMpv, id: number, data: unknown): Promise<void> {
  await (p as unknown as { ipc: { command: (...a: unknown[]) => Promise<unknown> } })
    .ipc.command('__prop', id, data)
  // The event and the command reply travel the same socket in that order, so
  // one turn of the loop is enough for the event to have been handled.
  await new Promise(r => setImmediate(r))
}

describe('the playhead, which the whole sync budget rests on', () => {
  it('takes a number and stamps when it was observed', async () => {
    const p = await player()
    const seen: Array<{ sec: number; at: number }> = []
    p.on('position', (sec, at) => seen.push({ sec, at }))

    const before = Date.now()
    await emit(p, OBS_TIME, 42.5)

    expect(p.position()).toBe(42.5)
    expect(p.positionObservedAt()).toBeGreaterThanOrEqual(before)
    expect(seen.at(-1)?.sec).toBe(42.5)
  }, 30_000)

  it('forgets everything when mpv says the position is null', async () => {
    // The documented bug: ignoring the null left the last film's position
    // cached with pause still false, and the sync engine extrapolated it
    // forwards for ever -- an empty player claiming to be well into a film that
    // is not open. Pausing as well as zeroing is the half that matters, because
    // an unpaused reading is what licenses the extrapolation.
    const p = await player()
    await emit(p, OBS_TIME, 42.5)
    await emit(p, OBS_PAUSE, false)
    expect(p.position()).toBe(42.5)
    expect(p.isPaused()).toBe(false)

    await emit(p, OBS_TIME, null)
    expect(p.position()).toBe(0)
    expect(p.isPaused()).toBe(true)
  }, 30_000)

  it('ignores a position that is not a number at all', async () => {
    const p = await player()
    await emit(p, OBS_TIME, 42.5)
    await emit(p, OBS_TIME, 'nonsense')
    // Treated as "nothing loaded" rather than parsed or kept, which is the safe
    // reading of a value that should never have arrived.
    expect(p.position()).toBe(0)
  }, 30_000)
})

describe('pause and duration', () => {
  it('follows the pause flag both ways', async () => {
    const p = await player()
    const seen: boolean[] = []
    p.on('pause', v => seen.push(v))
    await emit(p, OBS_PAUSE, false)
    expect(p.isPaused()).toBe(false)
    await emit(p, OBS_PAUSE, true)
    expect(p.isPaused()).toBe(true)
    expect(seen).toEqual([false, true])
  }, 30_000)

  it('keeps the last known pause state when the value is not a boolean', async () => {
    // Unlike the position, a nonsense pause value is not evidence that nothing
    // is loaded, so the safe move is to leave the flag alone rather than to
    // guess -- guessing `false` would license extrapolation on a paused film.
    const p = await player()
    await emit(p, OBS_PAUSE, false)
    await emit(p, OBS_PAUSE, 'maybe')
    expect(p.isPaused()).toBe(false)
  }, 30_000)

  it('reports a duration, and null once there is nothing loaded', async () => {
    const p = await player()
    expect(p.duration()).toBeNull()
    await emit(p, OBS_DURATION, 3600)
    expect(p.duration()).toBe(3600)
    await emit(p, OBS_DURATION, null)
    expect(p.duration()).toBeNull()
  }, 30_000)

  it('ignores a property id it never asked to observe', async () => {
    const p = await player()
    await emit(p, OBS_TIME, 10)
    await emit(p, 99, 'something else entirely')
    expect(p.position()).toBe(10)
    expect(p.duration()).toBeNull()
  }, 30_000)
})

describe('reaching the end of a film', () => {
  it('reports it for either name mpv uses', async () => {
    // mpv has emitted both over its versions, and handling only one means the
    // room never learns the film ended.
    for (const name of ['eof-reached', 'end-file']) {
      const p = await player()
      let ended = 0
      p.on('eof', () => { ended++ })
      await (p as unknown as { ipc: { command: (...a: unknown[]) => Promise<unknown> } })
        .ipc.command('__event', name)
      await new Promise(r => setImmediate(r))
      expect(ended, name).toBe(1)
    }
  }, 30_000)
})

describe('asking mpv directly', () => {
  it('reads the authoritative position over a round trip', async () => {
    const p = await player()
    await expect(p.positionExact()).resolves.toBe(12.5)
  }, 30_000)

  it('falls back to the observed position when the answer is not a number', async () => {
    // A round trip that comes back wrong must not turn into NaN in the sync
    // engine, which would propagate into every drift calculation after it.
    const p = await player()
    await emit(p, OBS_TIME, 7.25)
    const ipc = (p as unknown as { ipc: { getProperty: (n: string) => Promise<unknown> } }).ipc
    ipc.getProperty = async () => null
    await expect(p.positionExact()).resolves.toBe(7.25)
  }, 30_000)
})

describe('putting a film away without shutting mpv down', () => {
  it('forgets the position immediately rather than waiting for mpv to say so', async () => {
    // `stop` is asynchronous inside mpv, and for the moments before its null
    // arrives the cached position is a lie -- which is exactly long enough for
    // the next film to be loaded and fight a playhead that never existed.
    const p = await player()
    await emit(p, OBS_TIME, 88)
    await emit(p, OBS_PAUSE, false)
    await p.unload()
    expect(p.position()).toBe(0)
    expect(p.isPaused()).toBe(true)
  }, 30_000)
})

describe('the process going away', () => {
  it('passes mpv\'s exit up, so the application can say what happened', async () => {
    const p = await player()
    const exits: Array<number | null> = []
    p.on('exit', code => exits.push(code))
    await p.unload()
    // quit is what close() sends; the fake exits on it.
    await (p as unknown as { ipc: { command: (...a: unknown[]) => Promise<unknown> } })
      .ipc.command('quit').catch(() => { /* the socket goes with it */ })
    await new Promise(r => setTimeout(r, 300))
    expect(exits.length).toBeGreaterThan(0)
  }, 30_000)
})
