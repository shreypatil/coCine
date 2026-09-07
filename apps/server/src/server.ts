import { WebSocketServer, type WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import { ClientMessage, encode, type ServerMessage } from '@cocine/protocol'
import { Room } from './room.js'

interface Conn { ws: WebSocket; memberId: string; room: Room }

export interface SignallingServerOptions {
  port?: number
  /** How far ahead of now a scheduled start is placed. Must exceed the worst
   *  one-way delay plus seek latency in the room, or the slowest client starts late. */
  startLeadMs?: number
  log?: (msg: string) => void
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
  private rooms = new Map<string, Room>()
  private conns = new Map<WebSocket, Conn>()
  private readonly startLeadMs: number
  private readonly log: (msg: string) => void
  private readonly delayMs: number
  private readonly jitterMs: number
  private readonly skewMs: number

  constructor (private readonly opts: SignallingServerOptions = {}) {
    this.startLeadMs = opts.startLeadMs ?? 300
    this.log = opts.log ?? (() => {})
    this.delayMs = opts.simulatedDelayMs ?? 0
    this.jitterMs = opts.simulatedJitterMs ?? 0
    this.skewMs = opts.simulatedSkewMs ?? 0
  }

  async listen (): Promise<number> {
    this.wss = new WebSocketServer({ port: this.opts.port ?? 0 })
    await new Promise<void>(res => this.wss!.once('listening', res))
    this.wss.on('connection', ws => this.onConnection(ws))
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
      this.handle(ws, msg, this.now())
    })
    ws.on('close', () => {
      const c = this.conns.get(ws)
      if (!c) return
      c.room.remove(c.memberId)
      this.conns.delete(ws)
      this.broadcastState(c.room)
    })
    ws.on('error', () => { /* close will follow */ })
  }

  private handle (ws: WebSocket, msg: ClientMessage, s1: number): void {
    if (msg.t === 'time.ping') {
      return this.send(ws, { t: 'time.pong', c1: msg.c1, s1, s2: this.now() })
    }

    if (msg.t === 'hello') {
      let room = this.rooms.get(msg.room)
      if (!room) { room = new Room(msg.room, this.startLeadMs); this.rooms.set(msg.room, room) }
      const memberId = randomUUID()
      room.add(memberId, msg.name)
      this.conns.set(ws, { ws, memberId, room })
      this.send(ws, { t: 'welcome', memberId, serverMs: this.now() })
      this.send(ws, { t: 'playback.schedule', state: room.state, seq: room.seq })
      this.broadcastState(room)
      this.log(`${msg.name} joined ${msg.room} (${room.members.size} present)`)
      return
    }

    const conn = this.conns.get(ws)
    if (!conn) return this.send(ws, { t: 'error', message: 'say hello first' })

    if (msg.t === 'media.announce') {
      conn.room.media = { name: msg.name, durationSec: msg.durationSec }
      conn.room.state = { kind: 'paused', positionSec: 0 }
      conn.room.seq++
      this.broadcastState(conn.room)
      this.broadcast(conn.room, { t: 'playback.schedule', state: conn.room.state, seq: conn.room.seq })
      return
    }

    if (msg.t === 'playback.request') {
      const member = conn.room.members.get(conn.memberId)
      if (!member?.mayControl) return this.send(ws, { t: 'error', message: 'not permitted to control playback' })
      const state = conn.room.apply(msg.intent, msg.positionSec, this.now())
      this.broadcast(conn.room, { t: 'playback.schedule', state, seq: conn.room.seq })
      this.log(`${member.name} → ${msg.intent}${msg.positionSec !== undefined ? ` @${msg.positionSec.toFixed(2)}s` : ''}`)
    }
  }

  private broadcastState (room: Room): void {
    this.broadcast(room, { t: 'room.state', members: [...room.members.values()], media: room.media })
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
    for (const c of this.conns.keys()) c.terminate()
    await new Promise<void>(res => this.wss ? this.wss.close(() => res()) : res())
  }
}
