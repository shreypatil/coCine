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

describe('a connection that goes silent without closing', () => {
  // A laptop that sleeps, or loses its network, does not close its socket.
  // TCP takes minutes to declare it dead, and in a real session the room went
  // on listing somebody for two and a half minutes after their voice
  // connection had failed. Both ends now treat silence as an answer.

  it('is closed by the server, and the member removed, once it has said nothing for the idle limit', async () => {
    const { default: WebSocket } = await import('ws')
    const server = new SignallingServer({ idleTimeoutMs: 600 })
    const port = await server.listen()
    cleanups.push(() => server.close())
    const watcher = new RoomClient({ url: `ws://127.0.0.1:${port}`, code: null, name: 'anjali', player: stubPlayer(), pingIntervalMs: 100 })
    cleanups.push(() => watcher.close())
    await watcher.connect()

    // Joins, then never says another word -- and never closes.
    const ghost = new WebSocket(`ws://127.0.0.1:${port}`)
    cleanups.push(() => ghost.terminate())
    await new Promise(r => ghost.once('open', r))
    ghost.send(JSON.stringify({ t: 'hello', code: watcher.code, name: 'asleep' }))
    await waitFor(() => watcher.members.some(m => m.name === 'asleep'), 3000, 'the ghost to join')

    const started = Date.now()
    await waitFor(() => !watcher.members.some(m => m.name === 'asleep'), 5000, 'the ghost to be removed')
    expect(Date.now() - started).toBeLessThan(2500)
    // And someone who is still talking is left alone.
    expect(watcher.connection).toBe('connected')
    expect(watcher.members.some(m => m.name === 'anjali')).toBe(true)
  }, 20000)

  it('does not close a client that is pinging, however long it stays', async () => {
    const server = new SignallingServer({ idleTimeoutMs: 500 })
    const port = await server.listen()
    cleanups.push(() => server.close())
    const a = new RoomClient({ url: `ws://127.0.0.1:${port}`, code: null, name: 'anjali', player: stubPlayer(), pingIntervalMs: 100 })
    cleanups.push(() => a.close())
    await a.connect()
    let dropped = false
    a.on('connection', (s: string) => { if (s !== 'connected') dropped = true })
    await new Promise(r => setTimeout(r, 2000))
    expect(dropped).toBe(false)
    expect(a.connection).toBe('connected')
  }, 20000)

  it('is given up on by the client when the server stops answering, which starts a reconnect', async () => {
    const server = new SignallingServer({ idleTimeoutMs: 0 })
    const port = await server.listen()
    cleanups.push(() => server.close())
    const client = new RoomClient({
      url: `ws://127.0.0.1:${port}`, code: null, name: 'anjali', player: stubPlayer(),
      pingIntervalMs: 100, deadAfterMs: 800
    })
    cleanups.push(() => client.close())
    await client.connect()
    const code = client.code

    const seen: string[] = []
    client.on('connection', (st: string) => seen.push(st))
    // The server's end stays open and goes mute: a dead route, not a refusal.
    for (const ws of (server as unknown as { conns: Map<{ send: unknown }, unknown> }).conns.keys()) ws.send = () => {}
    await waitFor(() => seen.includes('reconnecting'), 4000, 'the client to give up on the silent server')
    // It came back to the same room under a new connection.
    await waitFor(() => seen.at(-1) === 'connected', 10000, 'the reconnect')
    expect(client.code).toBe(code)
  }, 30000)
})
