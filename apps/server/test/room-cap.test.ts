import { describe, it, expect, afterEach } from 'vitest'
import { SignallingServer, MAX_ROOM_MEMBERS } from '../src/server.js'
import WebSocket from 'ws'

/**
 * A room stops accepting people before the server stops coping.
 *
 * Measured on the deployed instance, one room costs about 95 MB at 100 members,
 * 210 MB at 150 and 406 MB at 200 -- within 76 MB of exhausting the machine.
 * The cost is the periodic transfer.status broadcast, which is quadratic in
 * room size. Refusing the fifty-first person is much kinder than an OOM kill
 * that takes every other room with it.
 */

const cleanups: Array<() => unknown> = []
// Reverse order: the server is registered first and closing it waits on the
// sockets registered after it, so unwinding forwards deadlocks the hook.
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

const open = async (port: number, code: string | null, name: string): Promise<
  { code: string | null; error: string | null; ws: WebSocket }
> => await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  cleanups.push(() => ws.close())
  const t = setTimeout(() => reject(new Error('timed out')), 10_000)
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', code, name })))
  ws.on('error', reject)
  ws.on('message', raw => {
    const m = JSON.parse(String(raw))
    if (m.t === 'welcome') { clearTimeout(t); resolve({ code: m.code, error: null, ws }) }
    if (m.t === 'error') { clearTimeout(t); resolve({ code: null, error: m.message, ws }) }
  })
})

describe('the room size cap', () => {
  it('lets a room fill to the limit and refuses the next person', async () => {
    const server = new SignallingServer({ maxRoomMembers: 4 })
    const port = await server.listen()
    cleanups.push(() => server.close())

    const host = await open(port, null, 'anjali')
    expect(host.code).toBeTruthy()
    for (const name of ['dev', 'priya', 'sam']) {
      const g = await open(port, host.code, name)
      expect(g.error, name).toBeNull()
    }

    const turnedAway = await open(port, host.code, 'late')
    expect(turnedAway.error).toMatch(/full \(4 people\)/)
  }, 30_000)

  it('says what to do instead, rather than only refusing', async () => {
    // Somebody turned away at the door should learn the room is full and that
    // a second room is the answer, not see a bare failure.
    const server = new SignallingServer({ maxRoomMembers: 1 })
    const port = await server.listen()
    cleanups.push(() => server.close())
    const host = await open(port, null, 'anjali')
    const late = await open(port, host.code, 'dev')
    expect(late.error).toContain('Start another one')
  }, 30_000)

  it('frees a place when somebody leaves', async () => {
    // The cap is on people present, not on people who have ever been here --
    // otherwise a room would slowly become unjoinable over an evening of
    // reconnects.
    const server = new SignallingServer({ maxRoomMembers: 2 })
    const port = await server.listen()
    cleanups.push(() => server.close())

    const host = await open(port, null, 'anjali')
    const guest = await open(port, host.code, 'dev')
    expect(guest.error).toBeNull()
    expect((await open(port, host.code, 'late')).error).toMatch(/full/)

    guest.ws.close()
    await expect.poll(async () => (await open(port, host.code, 'later')).error,
      { timeout: 10_000 }).toBeNull()
  }, 30_000)

  it('never blocks creating a new room', async () => {
    // A full room must not stop anybody starting their own, which is exactly
    // what the refusal tells them to do.
    const server = new SignallingServer({ maxRoomMembers: 1 })
    const port = await server.listen()
    cleanups.push(() => server.close())
    await open(port, null, 'anjali')
    const second = await open(port, null, 'dev')
    expect(second.error).toBeNull()
    expect(second.code).toBeTruthy()
  }, 30_000)

  it('defaults to 50', () => {
    expect(MAX_ROOM_MEMBERS).toBe(50)
  })
})
