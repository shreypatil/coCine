import { describe, it, expect, afterEach } from 'vitest'
import { SignallingServer } from '../src/server.js'
import { RoomClient } from '@cocine/client'
import { LogHub, type Sink } from '@cocine/logging'
import type { PlayerController } from '@cocine/player'

/**
 * The voice pipeline leaves a trail.
 *
 * This exists because a call that never connects is otherwise evidenceless:
 * both ends show "nobody else is in voice", neither reports an error, and every
 * layer reads correctly. The value of these lines is precisely that they
 * distinguish failures that look identical from outside -- so they are worth
 * testing like any other behaviour.
 */

const stubPlayer = (): PlayerController => ({
  load: async () => {}, play: async () => {}, pause: async () => {},
  seek: async () => {}, setRate: async () => {},
  position: () => 0, isPaused: () => true, positionObservedAt: () => Date.now(),
  duration: () => null, showText: async () => {}, setVolume: async () => {},
  unload: async () => {}, on: () => {}, close: async () => {}
}) as PlayerController

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

const until = async (p: () => boolean, what: string, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!p()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 25))
  }
}

async function room (): Promise<{ host: RoomClient; guest: RoomClient; lines: string[] }> {
  const lines: string[] = []
  const sink: Sink = { write: l => lines.push(l) }
  const hub = new LogHub({ level: 'debug', sinks: [sink] })
  const server = new SignallingServer({ logger: hub.logger('server') })
  const port = await server.listen()
  cleanups.push(() => server.close())

  const host = new RoomClient({ url: `ws://127.0.0.1:${port}`, code: null, name: 'anjali', player: stubPlayer() })
  cleanups.push(() => host.close())
  await host.connect()
  const guest = new RoomClient({ url: `ws://127.0.0.1:${port}`, code: host.code, name: 'dev', player: stubPlayer() })
  cleanups.push(() => guest.close())
  await guest.connect()
  return { host, guest, lines }
}

describe('what the server records about a call', () => {
  it('records a signal arriving and being relayed, with who and what kind', async () => {
    const { host, guest, lines } = await room()
    host.sendSignal(guest.memberId!, { kind: 'offer', sdp: 'v=0 lots of sdp' })
    await until(() => lines.some(l => l.includes('signal relayed')), 'the relay to be logged')

    const inbound = lines.find(l => l.includes('signal in'))!
    expect(inbound).toContain('[server.voice]')
    expect(inbound).toContain('"kind":"offer"')
    expect(inbound).toContain(`"to":"${guest.memberId!.slice(0, 8)}"`)
    expect(lines.find(l => l.includes('signal relayed'))).toContain(`"to":"${guest.memberId!.slice(0, 8)}"`)
  }, 30_000)

  it('does not put a whole SDP in the log, only its size', async () => {
    // An offer is several kilobytes and there is one per call per peer. The
    // useful facts are who and what kind; the body would bury them.
    const { host, guest, lines } = await room()
    host.sendSignal(guest.memberId!, { kind: 'offer', sdp: 'v=0 '.repeat(2000) })
    await until(() => lines.some(l => l.includes('signal in')), 'the signal to be logged')
    const line = lines.find(l => l.includes('signal in'))!
    expect(line).toContain('"sdpBytes":8000')
    expect(line).not.toContain('v=0 v=0 v=0')
  }, 30_000)

  it('warns loudly when a signal is addressed to somebody who is not there', async () => {
    // The failure this was written for: the server drops it silently, so the
    // sender sees no error and the intended peer never hears. Without this line
    // it is indistinguishable from a peer that simply never answered.
    const { host, lines } = await room()
    host.sendSignal('a-member-id-that-left', { kind: 'offer', sdp: 'v=0' })
    await until(() => lines.some(l => l.includes('signal dropped')), 'the drop to be logged')

    const line = lines.find(l => l.includes('signal dropped'))!
    expect(line).toContain('WARN')
    // And says who *was* there, which is what makes it actionable.
    expect(line).toContain('"present"')
  }, 30_000)

  it('records who the room believes is in the call', async () => {
    // "Nobody else is in voice" on the client, checked against the server's own
    // roster: if they disagree the fault is in the client.
    const { host, guest, lines } = await room()
    host.setVoiceState({ inVoice: true, muted: false, deafened: false })
    guest.setVoiceState({ inVoice: true, muted: false, deafened: false })
    await until(() => lines.filter(l => l.includes('voice roster')).length >= 2, 'both rosters')

    const last = lines.filter(l => l.includes('voice roster')).at(-1)!
    expect(last).toContain('anjali')
    expect(last).toContain('dev')
  }, 30_000)

  it('counts the per-tick traffic instead of writing a line for each', async () => {
    // 1500 connections send about 2,250 of these a second. One line each would
    // be tens of gigabytes a day against 24 GB of disk.
    const { host, lines } = await room()
    // Ticks arrive on their own -- RoomClient pings every two seconds and
    // reports every second -- so this just watches for a while.
    const before = lines.length
    await new Promise(r => setTimeout(r, 2500))
    expect(lines.filter(l => l.includes('[server.net] time.ping')).length).toBe(0)
    expect(lines.length - before).toBeLessThan(20)
  }, 30_000)
})
