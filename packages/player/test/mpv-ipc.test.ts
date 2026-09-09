import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { MpvIpc, type MpvEvent } from '../src/mpv-ipc.js'

/**
 * The JSON IPC transport, against a real socket.
 *
 * This is the most latency-critical path in the application -- every
 * millisecond here comes out of the 100 ms sync budget -- and it was the least
 * asserted, because the situations that break it are ones real mpv produces
 * only under load: a response split across two reads, several messages sharing
 * one, a malformed line between good ones. A stream parser that gets any of
 * those wrong does not throw. It drops a reply, and the promise waiting on it
 * never settles, so a seek silently never completes and the room drifts apart
 * with nothing in any log.
 *
 * `support/fake-mpv.mjs` speaks the protocol and produces those situations on
 * demand. Everything else here is real: the process spawn, the socket path, the
 * connect retry, the framing.
 */

const FAKE = fileURLToPath(new URL('./support/fake-mpv.mjs', import.meta.url))

/** Every client made here, torn down after each test whatever happened. */
const open: MpvIpc[] = []
afterEach(async () => {
  // kill() rather than close(): it is synchronous and unconditional, and a test
  // that failed mid-way must not leave a process behind on the machine.
  for (const ipc of open.splice(0)) { try { ipc.kill() } catch { /* already gone */ } }
})

/**
 * Start a fake mpv and connect to it, with the environment it needs set only
 * for the duration of the spawn and restored afterwards.
 */
async function connect (env: Record<string, string> = {}): Promise<MpvIpc> {
  const saved = new Map<string, string | undefined>()
  for (const [k, v] of Object.entries(env)) { saved.set(k, process.env[k]); process.env[k] = v }
  const ipc = new MpvIpc([], FAKE)
  open.push(ipc)
  try {
    await ipc.start(15_000)
    return ipc
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}

describe('framing, which is where a silent failure would live', () => {
  it('reassembles a response split across many reads', async () => {
    // Delivered one byte at a time. A parser that assumed one read is one
    // message would leave this promise pending for ever, and the caller -- a
    // seek, in practice -- would simply never complete.
    const ipc = await connect()
    await expect(ipc.command('__split')).resolves.toBe('reassembled')
  }, 30_000)

  it('reads several messages that arrived in one read', async () => {
    // What a busy mpv actually does. Handling only the first would drop the
    // events that tell the application the film loaded.
    const ipc = await connect()
    const events: MpvEvent[] = []
    ipc.on('mpv-event', e => events.push(e))
    await expect(ipc.command('__burst')).resolves.toBe('after events')
    expect(events.map(e => e.event)).toEqual(['file-loaded', 'playback-restart'])
  }, 30_000)

  it('survives blank lines, malformed JSON, and a reply to nothing', async () => {
    // The important half is that the stream keeps working afterwards: a parser
    // that threw here would take down every later command with it.
    const ipc = await connect()
    await expect(ipc.command('__garbage')).resolves.toBe('survived')
    // And it is still usable.
    await expect(ipc.getProperty('time-pos')).resolves.toBe(12.5)
  }, 30_000)

  it('keeps concurrent commands apart by request id', async () => {
    // Every reply carries the id of its request, and matching them wrongly
    // would resolve a seek with the answer to a volume query.
    const ipc = await connect()
    const [a, b, c] = await Promise.all([
      ipc.getProperty('time-pos'),
      ipc.getProperty('volume'),
      ipc.getProperty('duration')
    ])
    expect({ a, b, c }).toEqual({ a: 12.5, b: 'value-of-volume', c: 'value-of-duration' })
  }, 30_000)
})

describe('what a command does when mpv says no', () => {
  it('rejects with the error mpv gave, rather than resolving with it', async () => {
    const ipc = await connect()
    await expect(ipc.command('__fail')).rejects.toThrow('property not found')
  }, 30_000)

  it('rejects rather than hanging when there is no connection yet', async () => {
    const ipc = new MpvIpc([], FAKE)
    open.push(ipc)
    await expect(ipc.command('get_property', 'time-pos')).rejects.toThrow(/not connected/)
  })

  it('rejects everything still outstanding when it closes', async () => {
    // Otherwise a quit during a pending seek leaves a promise that never
    // settles, and whatever was awaiting it waits for the life of the process.
    const ipc = await connect()
    const pending = ipc.command('__silent')
    const rejected = expect(pending).rejects.toThrow(/closing/)
    await ipc.close()
    await rejected
  }, 30_000)
})

describe('starting up', () => {
  it('waits for the socket rather than failing on the first attempt', async () => {
    // mpv creates its socket a moment after launch, so the first connect always
    // loses the race. This makes that delay long enough to be real.
    const ipc = await connect({ FAKE_MPV_LISTEN_DELAY_MS: '400' })
    await expect(ipc.getProperty('time-pos')).resolves.toBe(12.5)
  }, 30_000)

  it('reports why mpv died instead of waiting out the timeout', async () => {
    // The failure people actually hit: mpv exits immediately because it cannot
    // open a display or find a codec. Without the exit check this waits the
    // full ten seconds and then blames the socket, hiding the real reason --
    // which mpv had already printed.
    const saved = process.env.FAKE_MPV_MODE
    process.env.FAKE_MPV_MODE = 'exit-before-ipc'
    const ipc = new MpvIpc([], FAKE)
    open.push(ipc)
    try {
      await expect(ipc.start(15_000)).rejects.toThrow(/exited \(3\).*could not open display/s)
    } finally {
      if (saved === undefined) delete process.env.FAKE_MPV_MODE
      else process.env.FAKE_MPV_MODE = saved
    }
  }, 30_000)
})

describe('events mpv sends on its own', () => {
  it('emits them without them being confused for command replies', async () => {
    const ipc = await connect()
    const events: MpvEvent[] = []
    ipc.on('mpv-event', e => events.push(e))
    await ipc.command('__event', 'seek')
    expect(events.map(e => e.event)).toContain('seek')
  }, 30_000)
})

describe('shutting down', () => {
  it('closes cleanly and is safe to close twice', async () => {
    const ipc = await connect()
    await ipc.close()
    await expect(ipc.close()).resolves.toBeUndefined()
  }, 30_000)

  it('kill() is immediate and safe with nothing running', () => {
    const ipc = new MpvIpc([], FAKE)
    expect(() => ipc.kill()).not.toThrow()
  })
})
