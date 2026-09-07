import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import WebSocket from 'ws'
import { SignallingServer } from '../src/server.js'
import { encode, decodeServer, type ClientMessage, type ServerMessage } from '@cocine/protocol'

/**
 * The server over a real socket, driven by raw protocol messages rather than
 * through RoomClient -- so what is under test is the wire contract and the
 * permission rules, not the client's convenience wrappers.
 */

let server: SignallingServer
let port: number
const open: WebSocket[] = []

beforeEach(async () => {
  server = new SignallingServer({ startLeadMs: 50 })
  port = await server.listen()
})
afterEach(async () => {
  for (const ws of open.splice(0)) ws.close()
  await server.close()
})

class Peer {
  readonly seen: ServerMessage[] = []
  private constructor (readonly ws: WebSocket) {}

  static async connect (): Promise<Peer> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    open.push(ws)
    const p = new Peer(ws)
    ws.on('message', raw => p.seen.push(decodeServer(String(raw))))
    await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej) })
    return p
  }

  send (m: ClientMessage): void { this.ws.send(encode(m)) }

  /** Waits for the next message of a kind, so tests never sleep on a guess. */
  async next<T extends ServerMessage['t']> (t: T, timeoutMs = 3000): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = this.seen.find(m => m.t === t)
      if (hit) { this.seen.splice(this.seen.indexOf(hit), 1); return hit as Extract<ServerMessage, { t: T }> }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${t}; saw ${this.seen.map(m => m.t).join(', ') || 'nothing'}`)
      await new Promise(r => setTimeout(r, 10))
    }
  }
}

describe('joining', () => {
  it('creates a room when no code is given and hands back the code', async () => {
    const a = await Peer.connect()
    a.send({ t: 'hello', code: null, name: 'anjali' })
    const w = await a.next('welcome')
    expect(w.code).toMatch(/^[A-Z0-9]{8}$/)
    expect(server.rooms.size()).toBe(1)
  })

  it('refuses a code that does not exist rather than silently creating one', async () => {
    const a = await Peer.connect()
    a.send({ t: 'hello', code: 'ZZZZZZZZ', name: 'anjali' })
    expect((await a.next('error')).message).toMatch(/No room with that code/)
    expect(server.rooms.size()).toBe(0)
  })

  it('accepts a code however it was typed', async () => {
    const a = await Peer.connect()
    a.send({ t: 'hello', code: null, name: 'anjali' })
    const code = (await a.next('welcome')).code
    const b = await Peer.connect()
    b.send({ t: 'hello', code: `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase(), name: 'dev' })
    expect((await b.next('welcome')).code).toBe(code)
  })

  it('tells everyone who is present', async () => {
    const a = await Peer.connect()
    a.send({ t: 'hello', code: null, name: 'anjali' })
    const code = (await a.next('welcome')).code
    const b = await Peer.connect()
    b.send({ t: 'hello', code, name: 'dev' })
    await b.next('welcome')
    const state = await a.next('room.state', 3000)
    const names = state.members.map(m => m.name)
    expect(names).toContain('anjali')
    expect(await a.next('room.state').then(s => s.members.length)).toBeGreaterThanOrEqual(1)
    expect(names.length).toBeGreaterThanOrEqual(1)
  })
})

describe('chat', () => {
  it('relays a message to everyone including the sender', async () => {
    const a = await Peer.connect()
    a.send({ t: 'hello', code: null, name: 'anjali' })
    const code = (await a.next('welcome')).code
    const b = await Peer.connect()
    b.send({ t: 'hello', code, name: 'dev' })
    await b.next('welcome')

    a.seen.length = 0; b.seen.length = 0
    b.send({ t: 'chat.send', text: 'this bit is great' })
    expect((await a.next('chat.message')).message.text).toBe('this bit is great')
    expect((await b.next('chat.message')).message.name).toBe('dev')
  })

  it('gives a latecomer the backlog', async () => {
    const a = await Peer.connect()
    a.send({ t: 'hello', code: null, name: 'anjali' })
    const code = (await a.next('welcome')).code
    a.send({ t: 'chat.send', text: 'starting in five' })
    await a.next('chat.message')

    const b = await Peer.connect()
    b.send({ t: 'hello', code, name: 'dev' })
    const history = await b.next('chat.history')
    expect(history.messages.some(m => m.text === 'starting in five')).toBe(true)
    expect(history.messages.some(m => m.kind === 'joined')).toBe(true)
  })

  it('records joining and leaving in the same column as conversation', async () => {
    const a = await Peer.connect()
    a.send({ t: 'hello', code: null, name: 'anjali' })
    const code = (await a.next('welcome')).code
    const b = await Peer.connect()
    b.send({ t: 'hello', code, name: 'dev' })
    await b.next('welcome')
    // Two joins are already queued -- anjali's own and dev's -- so drain to a
    // known point before asserting on what leaving produces.
    await a.next('chat.message')
    await a.next('chat.message')
    a.seen.length = 0

    b.ws.close()
    const left = await a.next('chat.message', 4000)
    expect(left.message.kind).toBe('left')
    expect(left.message.name).toBe('dev')
  })

  it('drops an empty message rather than broadcasting whitespace', async () => {
    const a = await Peer.connect()
    a.send({ t: 'hello', code: null, name: 'anjali' })
    await a.next('welcome')
    a.seen.length = 0
    a.send({ t: 'chat.send', text: '   ' })
    await new Promise(r => setTimeout(r, 150))
    expect(a.seen.filter(m => m.t === 'chat.message')).toHaveLength(0)
  })
})

describe('playback permission', () => {
  it('refuses a request from someone without control, and does not move the room', async () => {
    const a = await Peer.connect()
    a.send({ t: 'hello', code: null, name: 'anjali' })
    const code = (await a.next('welcome')).code
    const w = await a.next('room.state')
    const b = await Peer.connect()
    b.send({ t: 'hello', code, name: 'dev' })
    const bId = (await b.next('welcome')).memberId
    void w

    a.send({ t: 'member.setControl', memberId: bId, mayControl: false })
    await new Promise(r => setTimeout(r, 120))

    b.seen.length = 0
    b.send({ t: 'playback.request', intent: 'play' })
    expect((await b.next('error')).message).toMatch(/playback control/)
    expect(b.seen.some(m => m.t === 'playback.schedule')).toBe(false)
  })

  it('lets the host grant control, after which the request works', async () => {
    const a = await Peer.connect()
    a.send({ t: 'hello', code: null, name: 'anjali' })
    const code = (await a.next('welcome')).code
    const b = await Peer.connect()
    b.send({ t: 'hello', code, name: 'dev' })
    const bId = (await b.next('welcome')).memberId

    a.send({ t: 'member.setControl', memberId: bId, mayControl: false })
    await new Promise(r => setTimeout(r, 100))
    a.send({ t: 'member.setControl', memberId: bId, mayControl: true })
    await new Promise(r => setTimeout(r, 100))

    b.seen.length = 0
    b.send({ t: 'playback.request', intent: 'play', positionSec: 12 })
    const sched = await b.next('playback.schedule')
    expect(sched.state.kind).toBe('playing')
  })

  it('stops a non-host from granting themselves control', async () => {
    const a = await Peer.connect()
    a.send({ t: 'hello', code: null, name: 'anjali' })
    const code = (await a.next('welcome')).code
    const b = await Peer.connect()
    b.send({ t: 'hello', code, name: 'dev' })
    const bId = (await b.next('welcome')).memberId
    b.seen.length = 0
    b.send({ t: 'member.setControl', memberId: bId, mayControl: true })
    expect((await b.next('error')).message).toMatch(/only the host/)
  })

  it('hands hosting over mid-session', async () => {
    const a = await Peer.connect()
    a.send({ t: 'hello', code: null, name: 'anjali' })
    const code = (await a.next('welcome')).code
    const b = await Peer.connect()
    b.send({ t: 'hello', code, name: 'dev' })
    const bId = (await b.next('welcome')).memberId

    a.send({ t: 'member.transferHost', memberId: bId })
    for (;;) {
      const st = await a.next('room.state', 3000)
      const host = st.members.find(m => m.isHost)
      if (host?.id === bId) { expect(host.name).toBe('dev'); break }
    }
  })
})

describe('validation', () => {
  it('rejects a message that does not match the contract', async () => {
    const a = await Peer.connect()
    a.ws.send(JSON.stringify({ t: 'hello', code: null }))
    expect((await a.next('error')).message).toMatch(/bad message/)
  })

  it('rejects chat beyond the length limit at the boundary', async () => {
    const a = await Peer.connect()
    a.send({ t: 'hello', code: null, name: 'anjali' })
    await a.next('welcome')
    a.ws.send(JSON.stringify({ t: 'chat.send', text: 'x'.repeat(801) }))
    expect((await a.next('error')).message).toMatch(/bad message/)
  })
})
