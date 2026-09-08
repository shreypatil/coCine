import { describe, it, expect, afterEach } from 'vitest'
import { SignallingServer } from '../src/server.js'
import { RoomClient } from '@cocine/client'
import type { PlayerController } from '@cocine/player'

/**
 * What happens when the socket dies on its own -- a wifi blip, a server
 * restart, a laptop lid closing. Before this the client noticed nothing: the
 * interface went on showing a room code and a drift reading while the
 * connection was gone, which is worse than saying so.
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

const waitFor = async (cond: () => boolean, ms: number, what: string): Promise<void> => {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 25))
  }
}

describe('losing the connection', () => {
  it('notices the socket closing instead of claiming to be connected', async () => {
    const server = new SignallingServer({})
    const port = await server.listen()
    const client = new RoomClient({ url: `ws://127.0.0.1:${port}`, code: null, name: 'anjali', player: stubPlayer() })
    cleanups.push(() => client.close())
    await client.connect()
    expect(client.connection).toBe('connected')

    await server.close()
    await waitFor(() => client.connection === 'reconnecting', 5000, 'the client to notice')
  }, 30000)

  it('comes back on its own, rejoining the same room by its code', async () => {
    const server = new SignallingServer({ port: 0 })
    const port = await server.listen()
    const client = new RoomClient({ url: `ws://127.0.0.1:${port}`, code: null, name: 'anjali', player: stubPlayer() })
    cleanups.push(() => client.close())
    await client.connect()
    const code = client.code
    expect(code).toBeTruthy()

    await server.close()
    await waitFor(() => client.connection === 'reconnecting', 5000, 'the drop to register')

    // Same port, so the client's retry finds it again.
    const again = new SignallingServer({ port })
    cleanups.push(() => again.close())
    await again.listen()

    await waitFor(() => client.connection === 'connected', 20000, 'the client to come back')
    // It rejoined rather than creating a second room, which is what would happen
    // if a client that created a room retried with a null code.
    expect(client.code).toBe(code)
  }, 40000)

  it('stops trying once the room is left deliberately', async () => {
    const server = new SignallingServer({})
    const port = await server.listen()
    cleanups.push(() => server.close())
    const client = new RoomClient({ url: `ws://127.0.0.1:${port}`, code: null, name: 'anjali', player: stubPlayer() })
    await client.connect()
    await client.close()

    expect(client.connection).toBe('closed')
    // Give any stray retry time to fire and prove it does not.
    await new Promise(r => setTimeout(r, 1500))
    expect(client.connection).toBe('closed')
  }, 30000)
})
