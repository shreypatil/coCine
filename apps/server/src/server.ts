import { WebSocketServer, type WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import { ClientMessage, encode, normaliseCode, type ServerMessage } from '@cocine/protocol'
import type { Room } from './room.js'
import { InMemoryRoomStore, type RoomStore } from './store.js'

interface Conn { ws: WebSocket; memberId: string; room: Room }

export interface SignallingServerOptions {
  port?: number
  /** How far ahead of now a scheduled start is placed. Must exceed the worst
   *  one-way delay plus seek latency in the room, or the slowest client starts late. */
  startLeadMs?: number
  log?: (msg: string) => void
  store?: RoomStore
  /** How long an empty room is kept before it is collected. */
  roomTtlMs?: number
  /** Test affordance: delay every outbound message, with jitter, to stand in
   *  for a real network. Loopback is 0 ms, which exercises none of the clock
   *  estimation the design depends on. */
  simulatedDelayMs?: number
  simulatedJitterMs?: number
  /** Test affordance: run the server's clock deliberately offset from the
   *  clients', so the offset estimation has something real to recover. */
  simulatedSkewMs?: number
}

export class SignallingServer {
  private wss: WebSocketServer | null = null
  private conns = new Map<WebSocket, Conn>()
  private sweeper: NodeJS.Timeout | null = null
  readonly rooms: RoomStore
  private readonly startLeadMs: number
  private readonly roomTtlMs: number
  private readonly log: (msg: string) => void
  private readonly delayMs: number
  private readonly jitterMs: number
  private readonly skewMs: number

  constructor (private readonly opts: SignallingServerOptions = {}) {
    this.startLeadMs = opts.startLeadMs ?? 300
    this.roomTtlMs = opts.roomTtlMs ?? 10 * 60_000
    this.log = opts.log ?? (() => {})
    this.rooms = opts.store ?? new InMemoryRoomStore()
    this.delayMs = opts.simulatedDelayMs ?? 0
    this.jitterMs = opts.simulatedJitterMs ?? 0
    this.skewMs = opts.simulatedSkewMs ?? 0
  }

  async listen (): Promise<number> {
    this.wss = new WebSocketServer({ port: this.opts.port ?? 0 })
    await new Promise<void>(res => this.wss!.once('listening', res))
    this.wss.on('connection', ws => this.onConnection(ws))
    this.sweeper = setInterval(() => this.rooms.sweep(this.roomTtlMs), 60_000)
    this.sweeper.unref?.()
    const addr = this.wss.address()
    return typeof addr === 'object' && addr ? addr.port : 0
  }

  private onConnection (ws: WebSocket): void {
    ws.on('message', raw => {
      let msg: ClientMessage
      try { msg = ClientMessage.parse(JSON.parse(String(raw))) } catch (e) {
        return this.send(ws, { t: 'error', message: `bad message: ${String(e)}` })
      }
      // Stamped on receipt, before any work, so the clock estimate measures the
      // network rather than this handler.
      try { this.handle(ws, msg, this.now()) } catch (e) {
        this.send(ws, { t: 'error', message: e instanceof Error ? e.message : String(e) })
      }
    })
    ws.on('close', () => this.onClose(ws))
    ws.on('error', () => { /* close will follow */ })
  }

  private onClose (ws: WebSocket): void {
    const c = this.conns.get(ws)
    if (!c) return
    const who = c.room.members.get(c.memberId)?.name ?? 'someone'
    c.room.remove(c.memberId)
    this.conns.delete(ws)
    this.emitChat(c.room, 'left', who, 'left the room', null)
    this.broadcastState(c.room)
    this.log(`${who} left ${c.room.code} (${c.room.members.size} present)`)
  }

  private handle (ws: WebSocket, msg: ClientMessage, s1: number): void {
    if (msg.t === 'time.ping') {
      return this.send(ws, { t: 'time.pong', c1: msg.c1, s1, s2: this.now() })
    }

    if (msg.t === 'hello') {
      if (this.conns.has(ws)) return this.send(ws, { t: 'error', message: 'already in a room' })
      let room: Room
      if (msg.code === null) {
        room = this.rooms.create(this.startLeadMs)
      } else {
        const found = this.rooms.get(normaliseCode(msg.code))
        if (!found) return this.send(ws, { t: 'error', message: 'No room with that code' })
        room = found
      }
      const memberId = randomUUID()
      room.add(memberId, msg.name)
      this.conns.set(ws, { ws, memberId, room })
      this.send(ws, { t: 'welcome', memberId, code: room.code, serverMs: this.now() })
      this.send(ws, { t: 'chat.history', messages: room.chat })
      this.send(ws, { t: 'playback.schedule', state: room.state, seq: room.seq })
      this.emitChat(room, 'joined', msg.name, 'joined the room', memberId)
      this.broadcastState(room)
      this.log(`${msg.name} joined ${room.code} (${room.members.size} present)`)
      return
    }

    const conn = this.conns.get(ws)
    if (!conn) return this.send(ws, { t: 'error', message: 'say hello first' })
    const me = conn.room.members.get(conn.memberId)
    if (!me) return this.send(ws, { t: 'error', message: 'no longer in the room' })

    switch (msg.t) {
      case 'media.announce': {
        conn.room.media = { name: msg.name, durationSec: msg.durationSec }
        conn.room.state = { kind: 'paused', positionSec: 0 }
        conn.room.seq++
        this.emitChat(conn.room, 'system', me.name, `put on ${msg.name}`, me.id)
        this.broadcastState(conn.room)
        this.broadcast(conn.room, { t: 'playback.schedule', state: conn.room.state, seq: conn.room.seq })
        return
      }

      case 'playback.request': {
        if (!me.mayControl) return this.send(ws, { t: 'error', message: 'You do not have playback control' })
        const state = conn.room.apply(msg.intent, msg.positionSec, this.now())
        this.broadcast(conn.room, { t: 'playback.schedule', state, seq: conn.room.seq })
        this.log(`${me.name} → ${msg.intent}${msg.positionSec !== undefined ? ` @${msg.positionSec.toFixed(2)}s` : ''}`)
        return
      }

      case 'chat.send': {
        const text = msg.text.trim()
        if (!text) return
        this.emitChat(conn.room, 'said', me.name, text, me.id)
        return
      }

      case 'member.setControl': {
        const target = conn.room.setControl(me.id, msg.memberId, msg.mayControl)
        this.emitChat(conn.room, 'system', me.name,
          `${msg.mayControl ? 'gave' : 'took'} playback control ${msg.mayControl ? 'to' : 'from'} ${target.name}`, me.id)
        this.broadcastState(conn.room)
        return
      }

      case 'member.transferHost': {
        const target = conn.room.transferHost(me.id, msg.memberId)
        this.emitChat(conn.room, 'system', me.name, `made ${target.name} the host`, me.id)
        this.broadcastState(conn.room)
        return
      }
    }
  }

  private emitChat (room: Room, kind: 'said' | 'joined' | 'left' | 'system', name: string, text: string, memberId: string | null): void {
    const message = room.addChat(kind, name, text, memberId, this.now())
    this.broadcast(room, { t: 'chat.message', message })
  }

  private broadcastState (room: Room): void {
    this.broadcast(room, { t: 'room.state', code: room.code, members: [...room.members.values()], media: room.media })
  }

  private broadcast (room: Room, msg: ServerMessage): void {
    for (const c of this.conns.values()) if (c.room === room) this.send(c.ws, msg)
  }

  /** The server's own clock. Everything time-related goes through here so a
   *  simulated skew is consistent across pongs and playback anchors alike. */
  private now (): number { return Date.now() + this.skewMs }

  private send (ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState !== ws.OPEN) return
    const wire = encode(msg)
    if (this.delayMs === 0 && this.jitterMs === 0) return void ws.send(wire)
    const d = this.delayMs + (Math.random() * 2 - 1) * this.jitterMs
    setTimeout(() => { if (ws.readyState === ws.OPEN) ws.send(wire) }, Math.max(0, d))
  }

  async close (): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper)
    for (const c of this.conns.keys()) c.terminate()
    await new Promise<void>(res => this.wss ? this.wss.close(() => res()) : res())
  }
}
