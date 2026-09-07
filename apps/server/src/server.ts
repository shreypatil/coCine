import { WebSocketServer, type WebSocket } from 'ws'
import { createServer, type Server as HttpServer } from 'node:http'
import { RoomTracker, ANNOUNCE_PATH } from './tracker.js'
import { randomUUID } from 'node:crypto'
import { ClientMessage, encode, normaliseCode, type ServerMessage } from '@cocine/protocol'
import type { Room } from './room.js'
import { InMemoryRoomStore, type RoomStore } from './store.js'
import { iceServersFor, type TurnConfig } from './turn.js'

interface Conn { ws: WebSocket; memberId: string; room: Room }

export interface SignallingServerOptions {
  port?: number
  /** How far ahead of now a scheduled start is placed. Must exceed the worst
   *  one-way delay plus seek latency in the room, or the slowest client starts late. */
  startLeadMs?: number
  log?: (msg: string) => void
  store?: RoomStore
  /** Relay for voice only. Absent means public STUN alone, which is enough on
   *  most networks and leaves the rest unable to hold a call. */
  turn?: TurnConfig
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
  private http: HttpServer | null = null
  private wss: WebSocketServer | null = null
  readonly tracker = new RoomTracker()
  private conns = new Map<WebSocket, Conn>()
  private sweeper: NodeJS.Timeout | null = null
  private statusTimer: NodeJS.Timeout | null = null
  readonly rooms: RoomStore
  private readonly startLeadMs: number
  private readonly roomTtlMs: number
  private readonly log: (msg: string) => void
  private readonly delayMs: number
  private readonly jitterMs: number
  private readonly skewMs: number
  /** Filled in once listening, so clients are told where to announce. */
  private trackerUrl = ''

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
    // One port carries both planes: signalling on the root path, tracker
    // announces on /announce. Two ports would mean two things to open in a
    // firewall for no benefit.
    this.http = createServer((_req, res) => { res.writeHead(404); res.end() })
    this.wss = new WebSocketServer({ noServer: true })
    this.wss.on('connection', ws => this.onConnection(ws))

    this.http.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '/').split('?')[0]
      if (path === ANNOUNCE_PATH) return this.tracker.handleUpgrade(req, socket, head)
      this.wss!.handleUpgrade(req, socket, head, ws => this.wss!.emit('connection', ws, req))
    })

    // Binding can fail -- the port is taken, or privileged. Without this the
    // failure surfaces as an unhandled 'error' event and a bare stack trace,
    // and the caller's promise never settles either way.
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => { this.http!.off('listening', onListening); reject(err) }
      const onListening = (): void => { this.http!.off('error', onError); resolve() }
      this.http!.once('error', onError)
      this.http!.once('listening', onListening)
      this.http!.listen(this.opts.port ?? 0)
    })
    // Transfer status is derived from reports that arrive once a second, so
    // broadcasting on the same cadence is as fresh as it can meaningfully be.
    this.statusTimer = setInterval(() => this.broadcastTransferStatus(), 1000)
    this.statusTimer.unref?.()
    this.sweeper = setInterval(() => this.rooms.sweep(this.roomTtlMs), 60_000)
    this.sweeper.unref?.()
    const addr = this.http.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    this.trackerUrl = `ws://127.0.0.1:${port}${ANNOUNCE_PATH}`
    return port
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
      this.send(ws, {
        t: 'welcome',
        memberId,
        code: room.code,
        serverMs: this.now(),
        ice: {
          voice: iceServersFor('voice', msg.name, this.opts.turn),
          bulk: iceServersFor('bulk', msg.name, this.opts.turn)
        }
      })
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
        conn.room.setMedia({ name: msg.name, durationSec: msg.durationSec, torrent: msg.torrent }, me.id)
        // Only info hashes a room has announced are answerable, so this cannot
        // be used as a public tracker for arbitrary torrents.
        if (msg.torrent) this.tracker.allow(msg.torrent.infoHash)
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

      case 'rtc.signal': {
        // Relayed verbatim to exactly one member. The server does not read the
        // payload and never joins the call -- voice is peer to peer.
        const target = [...this.conns.values()].find(c => c.room === conn.room && c.memberId === msg.to)
        if (!target) return
        this.send(target.ws, { t: 'rtc.signal', from: me.id, payload: msg.payload })
        return
      }

      case 'voice.state': {
        conn.room.setVoice(me.id, msg)
        this.broadcastState(conn.room)
        return
      }

      case 'voice.moderate': {
        if (!me.isHost) return this.send(ws, { t: 'error', message: 'Only the host can mute other people' })
        const target = [...this.conns.values()].find(c => c.room === conn.room && c.memberId === msg.memberId)
        const member = conn.room.members.get(msg.memberId)
        if (!target || !member) return this.send(ws, { t: 'error', message: 'no such member' })
        // Advisory: in a mesh the server carries no audio, so all it can do is
        // ask, and a modified client could decline. Said plainly in the
        // interface rather than pretended otherwise.
        this.send(target.ws, { t: 'voice.moderated', by: me.name, action: msg.action })
        this.emitChat(conn.room, 'system', me.name, `${msg.action}d ${member.name}`, me.id)
        return
      }

      case 'peer.report': {
        conn.room.report(me.id, msg.report)
        return
      }

      case 'room.startAnyway': {
        if (!me.isHost) return this.send(ws, { t: 'error', message: 'Only the host can start early' })
        conn.room.startOverridden = true
        const waiting = conn.room.peerStatuses().filter(p => !p.ready).map(p => p.name)
        this.emitChat(conn.room, 'system', me.name,
          waiting.length ? `started without ${waiting.join(', ')}` : 'started the film', me.id)
        this.broadcastState(conn.room)
        return
      }

      case 'room.setWaitForLatecomers': {
        if (!me.isHost) return this.send(ws, { t: 'error', message: 'Only the host can change that' })
        conn.room.waitForLatecomers = msg.wait
        this.emitChat(conn.room, 'system', me.name,
          msg.wait ? 'set the room to wait for latecomers' : 'set the room to carry on without latecomers', me.id)
        this.broadcastState(conn.room)
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

  private broadcastTransferStatus (): void {
    const seen = new Set<Room>()
    for (const c of this.conns.values()) {
      if (seen.has(c.room)) continue
      seen.add(c.room)

      // The phase is derived from reports, which arrive continuously and
      // trigger nothing on their own. Without this the room becomes ready and
      // never tells anyone -- the gate simply never opens.
      const phase = c.room.phase()
      if (phase !== c.room.lastBroadcastPhase) {
        c.room.lastBroadcastPhase = phase
        this.broadcastState(c.room)
      }

      if (!c.room.media?.torrent) continue
      this.broadcast(c.room, { t: 'transfer.status', ...c.room.transferStatus() })
    }
  }

  private broadcastState (room: Room): void {
    room.lastBroadcastPhase = room.phase()
    this.broadcast(room, {
      t: 'room.state',
      code: room.code,
      members: [...room.members.values()],
      media: room.media,
      trackerUrl: this.trackerUrl,
      phase: room.phase(),
      waitForLatecomers: room.waitForLatecomers
    })
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
    if (this.statusTimer) clearInterval(this.statusTimer)
    for (const c of this.conns.keys()) c.terminate()
    this.tracker.close()
    this.wss?.close()
    await new Promise<void>(res => this.http ? this.http.close(() => res()) : res())
  }
}
