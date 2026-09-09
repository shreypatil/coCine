import { describe, it, expect, afterEach } from 'vitest'
import { networkInterfaces } from 'node:os'
import { WebSocket } from 'ws'
import { SignallingServer } from '../src/server.js'
import { RoomClient } from '@cocine/client'
import type { PlayerController } from '@cocine/player'

/**
 * That the signalling server answers on both address families.
 *
 * It always did, and by accident: `listen(port)` with no host leaves the choice
 * to Node, which binds the IPv6 wildcard and lets the kernel map IPv4
 * connections onto it. That is a default, not a promise -- on a host with
 * `net.ipv6.bindv6only=1` the same call produces an IPv6-only listener, and
 * every IPv4 client is refused by a server whose logs show it running
 * perfectly. The bind is explicit now, and this is what holds it that way.
 *
 * It matters more than a settings detail because of who the users are. On an
 * Indian home connection IPv6 is often native while IPv4 sits behind
 * carrier-grade NAT, so both families genuinely get used -- and a room where
 * some people can reach the server and others cannot is indistinguishable, from
 * inside, from the server being down.
 */

const stubPlayer = (): PlayerController => ({
  load: async () => {}, play: async () => {}, pause: async () => {},
  seek: async () => {}, setRate: async () => {},
  position: () => 0, isPaused: () => true, positionObservedAt: () => Date.now(),
  duration: () => null, showText: async () => {}, setVolume: async () => {},
  unload: async () => {},
  on: () => {}, close: async () => {}
}) as PlayerController

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

/** Whether this machine has an IPv6 loopback to connect over at all. */
function hasV6Loopback (): boolean {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv6' && a.address === '::1') return true
  }
  return false
}

/** Open a websocket and resolve whether it connected, without throwing. */
async function reaches (url: string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const ws = new WebSocket(url, { handshakeTimeout: 5000 })
    const done = (ok: boolean): void => {
      ws.removeAllListeners()
      try { ws.close() } catch { /* never opened */ }
      resolve(ok)
    }
    ws.once('open', () => done(true))
    ws.once('error', () => done(false))
    // A ceiling of our own, so a socket that neither opens nor errors cannot
    // hang the run.
    setTimeout(() => done(false), 8000).unref?.()
  })
}

describe('the signalling server on both address families', () => {
  it('accepts an IPv4 client', async () => {
    const server = new SignallingServer({})
    const port = await server.listen()
    cleanups.push(() => server.close())
    expect(await reaches(`ws://127.0.0.1:${port}`)).toBe(true)
  }, 30_000)

  it.skipIf(!hasV6Loopback())('accepts an IPv6 client on the same port', async () => {
    // The two are one listener, not two: the same port answers both, which is
    // what makes a single firewall rule and a single published address correct.
    const server = new SignallingServer({})
    const port = await server.listen()
    cleanups.push(() => server.close())
    expect(await reaches(`ws://[::1]:${port}`)).toBe(true)
  }, 30_000)

  it.skipIf(!hasV6Loopback())('serves both at once, so no client is refused by which family it arrived on', async () => {
    const server = new SignallingServer({})
    const port = await server.listen()
    cleanups.push(() => server.close())
    const [v4, v6] = await Promise.all([
      reaches(`ws://127.0.0.1:${port}`),
      reaches(`ws://[::1]:${port}`)
    ])
    expect({ v4, v6 }).toEqual({ v4: true, v6: true })
  }, 30_000)

  it.skipIf(!hasV6Loopback())('runs a real room over IPv6, not merely a handshake', async () => {
    // Reaching the socket is not the same as the protocol working across it.
    const server = new SignallingServer({})
    const port = await server.listen()
    cleanups.push(() => server.close())

    const host = new RoomClient({ url: `ws://[::1]:${port}`, code: null, name: 'anjali', player: stubPlayer() })
    cleanups.push(() => host.close())
    await host.connect()
    const code = host.code
    expect(code).toBeTruthy()

    // And the two families meet in the same room, which is the case that
    // actually turns up: one person on IPv6, another on IPv4.
    const guest = new RoomClient({ url: `ws://127.0.0.1:${port}`, code, name: 'dev', player: stubPlayer() })
    cleanups.push(() => guest.close())
    await guest.connect()
    expect(guest.connection).toBe('connected')
  }, 30_000)
})
