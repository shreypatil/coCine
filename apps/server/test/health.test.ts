import { describe, it, expect, afterEach } from 'vitest'
import { SignallingServer, HEALTH_PATH } from '../src/server.js'
import { RoomClient } from '@cocine/client'
import type { PlayerController } from '@cocine/player'

/**
 * The one plain HTTP route on the server.
 *
 * Three things want it, and the third is why it exists. An uptime monitor needs
 * somewhere to knock; a deploy needs to know the process came back; and on a
 * host that reclaims instances it judges idle -- Oracle terminates an
 * always-free instance whose CPU and network both sit under twenty per cent for
 * seven days -- the keepalive that prevents that has to know whether anybody is
 * watching a film, so it can stay out of the way while they are.
 *
 * That last one is why `rooms` and `members` are load-bearing rather than
 * decorative: a keepalive that burned CPU during a film would be protecting the
 * server by degrading it.
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

async function serve (): Promise<{ port: number; server: SignallingServer }> {
  const server = new SignallingServer({})
  const port = await server.listen()
  cleanups.push(() => server.close())
  return { port, server }
}

const health = async (port: number): Promise<{
  ok: boolean; rooms: number; members: number; uptimeSec: number; version: string
}> => {
  const res = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`)
  expect(res.status).toBe(200)
  return await res.json() as never
}

describe('the health endpoint', () => {
  it('answers on a fresh server with nothing happening', async () => {
    const { port } = await serve()
    const body = await health(port)
    expect(body).toMatchObject({ ok: true, rooms: 0, members: 0 })
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0)
  }, 30_000)

  it('counts rooms and members, which is what decides whether to keep quiet', async () => {
    // A keepalive burning CPU during a film would be protecting the server by
    // degrading it, so these two numbers have to be true.
    const { port } = await serve()

    const host = new RoomClient({ url: `ws://127.0.0.1:${port}`, code: null, name: 'anjali', player: stubPlayer() })
    cleanups.push(() => host.close())
    await host.connect()
    await expect.poll(async () => (await health(port)).rooms, { timeout: 10_000 }).toBe(1)

    const guest = new RoomClient({ url: `ws://127.0.0.1:${port}`, code: host.code, name: 'dev', player: stubPlayer() })
    cleanups.push(() => guest.close())
    await guest.connect()
    await expect.poll(async () => (await health(port)).members, { timeout: 10_000 }).toBe(2)
    // Two members in *one* room, not two rooms.
    expect((await health(port)).rooms).toBe(1)
  }, 30_000)

  it('drops the count again when everybody leaves', async () => {
    const { port } = await serve()
    const host = new RoomClient({ url: `ws://127.0.0.1:${port}`, code: null, name: 'anjali', player: stubPlayer() })
    await host.connect()
    await expect.poll(async () => (await health(port)).members, { timeout: 10_000 }).toBe(1)
    await host.close()
    await expect.poll(async () => (await health(port)).members, { timeout: 10_000 }).toBe(0)
  }, 30_000)

  it('says nothing about who is in a room', async () => {
    // A room code is the only thing between a room and a stranger, and this
    // endpoint is unauthenticated. Counts are safe to publish; codes and names
    // are not.
    const { port } = await serve()
    const host = new RoomClient({ url: `ws://127.0.0.1:${port}`, code: null, name: 'anjali', player: stubPlayer() })
    cleanups.push(() => host.close())
    await host.connect()

    const raw = await (await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`)).text()
    expect(raw).not.toContain('anjali')
    expect(raw).not.toContain(host.code)
  }, 30_000)

  it('still refuses every other path', async () => {
    const { port } = await serve()
    for (const path of ['/', '/rooms', '/admin']) {
      expect((await fetch(`http://127.0.0.1:${port}${path}`)).status, path).toBe(404)
    }
  }, 30_000)

  it('does not disturb the websocket upgrade sharing the port', async () => {
    // One port carries signalling, the tracker and this. Adding a route must
    // not have swallowed an upgrade.
    const { port } = await serve()
    const client = new RoomClient({ url: `ws://127.0.0.1:${port}`, code: null, name: 'anjali', player: stubPlayer() })
    cleanups.push(() => client.close())
    await client.connect()
    expect(client.connection).toBe('connected')
  }, 30_000)
})
