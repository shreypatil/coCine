import { describe, it, expect, afterEach } from 'vitest'
import { SignallingServer } from '../src/server.js'
import { RoomClient } from '@cocine/client'
import type { PlayerController } from '@cocine/player'

/**
 * The server minting ICE servers is worth nothing if the client drops them on
 * the floor, which is exactly what it did until this test existed: credentials
 * were issued correctly, checked by unit tests, and then every peer connection
 * was built with an empty server list. That fails only on networks the developer
 * does not have -- it works perfectly on a LAN.
 */

/** Enough of a player for RoomClient to hold; none of it is exercised here. */
const stubPlayer = (): PlayerController => ({
  load: async () => {}, play: async () => {}, pause: async () => {},
  seek: async () => {}, setRate: async () => {},
  position: () => 0, isPaused: () => true, positionObservedAt: () => Date.now(),
  duration: () => null, showText: async () => {}, setVolume: async () => {},
  on: () => {}, close: async () => {}
}) as PlayerController

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

async function connect (turn?: { secret: string; urls: string[] }) {
  const server = new SignallingServer(turn ? { turn } : {})
  const port = await server.listen()
  cleanups.push(() => server.close())
  const client = new RoomClient({ url: `ws://127.0.0.1:${port}`, code: null, name: 'anjali', player: stubPlayer() })
  await client.connect()
  cleanups.push(() => client.close())
  return client
}

const urlsOf = (servers: Array<{ urls: string[] }>) => servers.flatMap(s => s.urls)

describe('ICE servers reach the client', () => {
  it('gives voice the relay and bulk only STUN', async () => {
    const client = await connect({ secret: 'a-test-secret', urls: ['turn:relay.example:3478'] })

    expect(urlsOf(client.ice.voice)).toContain('turn:relay.example:3478')
    expect(urlsOf(client.ice.bulk)).not.toContain('turn:relay.example:3478')
    expect(urlsOf(client.ice.bulk).every(u => u.startsWith('stun:'))).toBe(true)
  })

  it('carries usable credentials on the voice relay', async () => {
    const client = await connect({ secret: 'a-test-secret', urls: ['turn:relay.example:3478'] })

    const relay = client.ice.voice.find(s => s.urls.some(u => u.startsWith('turn:')))
    expect(relay?.username).toMatch(/^\d+:anjali$/)
    expect(relay?.credential).toBeTruthy()
    // The expiry in the username must be in the future, or coturn rejects it
    // outright and voice silently fails for anyone who needed the relay.
    expect(Number(relay!.username!.split(':')[0])).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('still gives both planes STUN when no relay is configured', async () => {
    const client = await connect()

    expect(urlsOf(client.ice.voice).length).toBeGreaterThan(0)
    expect(urlsOf(client.ice.bulk).length).toBeGreaterThan(0)
    expect(urlsOf(client.ice.voice).some(u => u.startsWith('turn:'))).toBe(false)
  })
})
