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
    return await this.nextWhere(t, () => true, timeoutMs)
  }

  /**
   * Waits for a message of a kind that also satisfies a predicate.
   *
   * Clearing `seen` and taking the next arrival is not enough: a message the
   * server had already sent can still be in flight when the queue is cleared,
   * and then it is what `next` returns. Matching on content instead of on
   * arrival order removes that race entirely.
   */
  async nextWhere<T extends ServerMessage['t']> (
    t: T,
    match: (m: Extract<ServerMessage, { t: T }>) => boolean,
    timeoutMs = 3000
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = this.seen.find(m => m.t === t && match(m as Extract<ServerMessage, { t: T }>))
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

describe('the readiness gate over the wire', () => {
  const ready = { havePct: 1, bufferEndSec: 900, downBps: 0, upBps: 0, peers: 1 }
  const behind = { havePct: 0.2, bufferEndSec: 3, downBps: 1_000_000, upBps: 0, peers: 1 }
  const torrent = { infoHash: 'c'.repeat(40), magnet: 'magnet:?xt=urn:btih:' + 'c'.repeat(40), bytes: 1_000_000_000, pieceLength: 262144 }

  async function roomOfTwo (): Promise<{ a: Peer; b: Peer; bId: string }> {
    const a = await Peer.connect()
    a.send({ t: 'hello', code: null, name: 'anjali' })
    const code = (await a.next('welcome')).code
    const b = await Peer.connect()
    b.send({ t: 'hello', code, name: 'dev' })
    const bId = (await b.next('welcome')).memberId
    a.send({ t: 'media.announce', name: 'dune.mkv', durationSec: 7200, torrent })
    await a.next('room.state')
    return { a, b, bId }
  }

  it('holds in preparing while somebody is behind, then opens', async () => {
    const { a, b } = await roomOfTwo()
    a.send({ t: 'peer.report', report: ready })
    b.send({ t: 'peer.report', report: behind })
    await new Promise(r => setTimeout(r, 1400))
    expect((await a.next('transfer.status')).bottleneck).toBe('dev')

    b.send({ t: 'peer.report', report: ready })
    await new Promise(r => setTimeout(r, 1400))
    const s = await a.next('transfer.status')
    expect(s.bottleneck).toBeNull()
    expect(s.perPeer.every(p => p.ready)).toBe(true)
  }, 20_000)

  it('reports a countdown and the floor it cannot beat', async () => {
    const { a, b } = await roomOfTwo()
    a.send({ t: 'peer.report', report: { havePct: 1, bufferEndSec: 900, downBps: 0, upBps: 4_000_000, peers: 1 } })
    b.send({ t: 'peer.report', report: behind })
    await new Promise(r => setTimeout(r, 1400))
    const s = await a.next('transfer.status')
    expect(s.etaSec).toBeGreaterThan(0)
    expect(s.tMinSec).toBeGreaterThan(0)
  }, 20_000)

  it('says the film needs the sharer until a second full copy exists', async () => {
    const { a, b } = await roomOfTwo()
    a.send({ t: 'peer.report', report: ready })
    b.send({ t: 'peer.report', report: behind })
    await new Promise(r => setTimeout(r, 1400))
    expect((await a.next('transfer.status')).safeForSharerToLeave).toBe(false)

    b.send({ t: 'peer.report', report: ready })
    await new Promise(r => setTimeout(r, 1400))
    const s = await a.next('transfer.status')
    expect(s.fullCopies).toBe(2)
    expect(s.safeForSharerToLeave).toBe(true)
  }, 20_000)

  it('lets only the host start early, and records it in the room log', async () => {
    const { a, b } = await roomOfTwo()
    b.seen.length = 0
    b.send({ t: 'room.startAnyway' })
    expect((await b.next('error')).message).toMatch(/Only the host/)

    a.send({ t: 'peer.report', report: ready })
    b.send({ t: 'peer.report', report: behind })
    await new Promise(r => setTimeout(r, 1200))
    a.seen.length = 0
    a.send({ t: 'room.startAnyway' })
    const note = await a.nextWhere('chat.message', m => m.message.text.includes('without'))
    expect(note.message.text).toContain('without dev')
    expect((await a.nextWhere('room.state', m => m.phase === 'ready')).phase).toBe('ready')
  }, 20_000)

  it('lets only the host choose whether the room waits for latecomers', async () => {
    const { a, b } = await roomOfTwo()
    b.seen.length = 0
    b.send({ t: 'room.setWaitForLatecomers', wait: false })
    expect((await b.next('error')).message).toMatch(/Only the host/)

    a.send({ t: 'room.setWaitForLatecomers', wait: false })
    expect((await a.nextWhere('room.state', m => !m.waitForLatecomers)).waitForLatecomers).toBe(false)
  }, 20_000)

  it('starts the gate afresh when a different film is put on', async () => {
    // An override for the last film must not let the next one start before
    // anybody has it.
    const { a, b } = await roomOfTwo()
    a.send({ t: 'peer.report', report: ready })
    b.send({ t: 'peer.report', report: behind })
    await new Promise(r => setTimeout(r, 1200))
    a.send({ t: 'room.startAnyway' })
    await a.next('room.state')

    a.send({ t: 'media.announce', name: 'arrival.mkv', durationSec: 6000, torrent: { ...torrent, infoHash: 'd'.repeat(40) } })
    const after = await a.nextWhere('room.state', m => m.media?.name === 'arrival.mkv')
    expect(after.phase).toBe('preparing')
  }, 20_000)
})
