import { WebSocketServer, type WebSocket } from 'ws'
import { createServer, type Server as HttpServer } from 'node:http'
import { RoomTracker, ANNOUNCE_PATH } from './tracker.js'

/** Where anything outside asks whether this server is alive and busy. */
export const HEALTH_PATH = '/health'
/** Reported by /health so a deploy can be told apart from a restart. */
const VERSION = process.env.COCINE_VERSION ?? 'dev'

import { randomUUID } from 'node:crypto'
import { ClientMessage, encode, normaliseCode, type ServerMessage } from '@cocine/protocol'
import type { Room } from './room.js'
import { InMemoryRoomStore, type RoomStore } from './store.js'
import { iceServersFor, type TurnConfig } from './turn.js'
import { presign, objectKeyFor, DEFAULT_EXPIRY_SECONDS, type OriginConfig } from './origin.js'
import { seekableBuckets, seekableAt, seekableMapOf } from './readiness.js'

interface Conn {
  ws: WebSocket
  memberId: string
  room: Room
  /**
   * Where the tracker is *from this client's point of view*.
   *
   * It used to be one address for everybody, hard-coded to 127.0.0.1, which is
   * correct only while every peer is on the same machine as the server. On a
   * second machine that address means the second machine, so its announce went
   * nowhere: chat, playback and sync all worked and the film never moved. Each
   * client is told the host it reached the server on, because that is an address
   * it demonstrably can reach.
   */
  trackerUrl: string
}

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
  /** Object storage for relay mode. Absent means the host is offered no toggle,
   *  rather than a toggle that fails when pressed. */
  origin?: OriginConfig
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
  /** The fallback when a client sends no Host header. Filled in once listening. */
  private trackerUrl = ''
  private port = 0

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
    this.http = createServer((req, res) => {
      // The one plain HTTP route. Everything else here is a websocket upgrade.
      if ((req.url ?? '').split('?')[0] === HEALTH_PATH) {
        const body = JSON.stringify(this.health())
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        return res.end(body)
      }
      res.writeHead(404); res.end()
    })
    this.wss = new WebSocketServer({ noServer: true })
    // The request carries the address this client used to reach us, which is
    // the only address we know it can reach.
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req as { headers?: Record<string, string | string[] | undefined> }))

    this.http.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '/').split('?')[0]
      if (path === ANNOUNCE_PATH) return this.tracker.handleUpgrade(req, socket, head)
      this.wss!.handleUpgrade(req, socket, head, ws => this.wss!.emit('connection', ws, req))
    })

    // Binding can fail -- the port is taken, or privileged. Without this the
    // failure surfaces as an unhandled 'error' event and a bare stack trace,
    // and the caller's promise never settles either way.
    await this.bind(this.opts.port ?? 0)
    // Transfer status is derived from reports that arrive once a second, so
    // broadcasting on the same cadence is as fresh as it can meaningfully be.
    this.statusTimer = setInterval(() => this.broadcastTransferStatus(), 1000)
    this.statusTimer.unref?.()
    this.sweeper = setInterval(() => this.rooms.sweep(this.roomTtlMs), 60_000)
    this.sweeper.unref?.()
    const addr = this.http.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    this.port = port
    this.trackerUrl = `ws://127.0.0.1:${port}${ANNOUNCE_PATH}`
    return port
  }

  /**
   * Bind the listener, accepting both address families wherever the host has
   * them.
   *
   * `listen(port)` with no host looked like it already did this, and mostly it
   * does: Node binds the IPv6 wildcard and the kernel maps IPv4 connections
   * onto it. But that behaviour is the *kernel's* default, not a guarantee this
   * code was making -- a host with `net.ipv6.bindv6only=1` set turns the same
   * call into an IPv6-only listener, and every IPv4 client is refused by a
   * server that appears to be running perfectly. Passing `ipv6Only: false`
   * explicitly states the requirement rather than inheriting it.
   *
   * The fallback matters as much as the bind. A host with IPv6 disabled
   * entirely cannot bind `::` at all, and there the right answer is an IPv4
   * listener rather than a server that refuses to start -- so that failure is
   * caught and retried on the wildcard, and only a second failure is reported.
   */
  private async bind (port: number): Promise<void> {
    const attempt = (target: { port: number; host?: string; ipv6Only?: boolean }): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => { this.http!.off('listening', onListening); reject(err) }
        const onListening = (): void => { this.http!.off('error', onError); resolve() }
        this.http!.once('error', onError)
        this.http!.once('listening', onListening)
        this.http!.listen(target)
      })

    try {
      await attempt({ port, host: '::', ipv6Only: false })
    } catch (err) {
      // A port that is genuinely taken will fail the same way on both families,
      // so retrying costs one extra syscall and reports the clearer error.
      this.log(`dual-stack bind failed (${(err as Error).message}); falling back to IPv4`)
      await attempt({ port })
    }
  }

  /**
   * What this server is doing, for anything watching it from outside.
   *
   * Three uses, and the third is the one that made it worth adding. An uptime
   * monitor needs somewhere to knock. A deploy needs to know the process came
   * back. And on a host that reclaims instances it judges idle -- Oracle's
   * always-free tier terminates one whose CPU and network both sit under twenty
   * per cent for a week -- the keepalive that stops that happening needs to
   * know whether anybody is actually watching a film, so it can stay out of the
   * way while they are.
   *
   * Deliberately says nothing about *who* is in a room. Room codes are the only
   * thing standing between a room and a stranger, and this endpoint is
   * unauthenticated.
   */
  health (): {
    ok: true; rooms: number; members: number; uptimeSec: number; version: string
  } {
    let members = 0
    for (const conn of this.conns.values()) void conn, members++
    return {
      ok: true,
      rooms: this.rooms.size(),
      members,
      uptimeSec: Math.round(process.uptime()),
      version: VERSION
    }
  }

  /**
   * Why a seek must be refused, or null if it may go ahead.
   *
   * Deliberately a refusal with a reason rather than a silent clamp to the
   * nearest allowed moment: somebody dragging a seek bar has a place in mind,
   * and being moved somewhere else without explanation is worse than being told
   * the room cannot go there yet. The interface draws the reachable stretch so
   * this is a backstop rather than the first thing anyone meets.
   */
  private seekRefusal (room: Room, positionSec: number): string | null {
    const duration = room.media?.durationSec ?? 0
    if (!(duration > 0)) return null
    const peers = room.peerStatuses()
    if (peers.length === 0) return null
    const seekable = seekableBuckets(peers)
    if (seekableAt(positionSec, duration, seekable)) return null
    const behind = peers
      .filter(p => typeof p.pieces === 'string' && !seekableAt(positionSec, duration, seekableBuckets([p])))
      .map(p => p.name)
    const who = behind.length === 0
      ? 'somebody in the room does not have'
      : `${behind.join(' and ')} ${behind.length === 1 ? 'does not have' : 'do not have'}`
    return `Cannot seek there yet — ${who} that part of the film.`
  }

  /**
   * Where this client should announce, derived from how it reached us.
   *
   * `COCINE_PUBLIC_HOST` overrides it for a deployed server behind a proxy or a
   * different public name; otherwise the Host header is exactly right, because
   * the tracker shares this server's port.
   */
  private trackerUrlFor (req?: { headers?: Record<string, string | string[] | undefined> }): string {
    const override = process.env.COCINE_PUBLIC_HOST
    if (override) {
      return override.includes('://')
        ? `${override.replace(/\/$/, '')}${ANNOUNCE_PATH}`
        : `ws://${override}${ANNOUNCE_PATH}`
    }
    const host = req?.headers?.host
    const value = Array.isArray(host) ? host[0] : host
    if (!value) return this.trackerUrl
    // A host without a port means the default one for the scheme, and this
    // server is not on it.
    const withPort = value.includes(':') ? value : `${value}:${this.port}`
    return `ws://${withPort}${ANNOUNCE_PATH}`
  }

  private onConnection (ws: WebSocket, req?: { headers?: Record<string, string | string[] | undefined> }): void {
    ws.on('message', raw => {
      let msg: ClientMessage
      try { msg = ClientMessage.parse(JSON.parse(String(raw))) } catch (e) {
        return this.send(ws, { t: 'error', message: `bad message: ${String(e)}` })
      }
      // Stamped on receipt, before any work, so the clock estimate measures the
      // network rather than this handler.
      try { this.handle(ws, msg, this.now(), this.trackerUrlFor(req)) } catch (e) {
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

  private handle (ws: WebSocket, msg: ClientMessage, s1: number, trackerUrl: string): void {
    if (msg.t === 'time.ping') {
      return this.send(ws, { t: 'time.pong', c1: msg.c1, s1, s2: this.now() })
    }

    if (msg.t === 'hello') {
      if (this.conns.has(ws)) return this.send(ws, { t: 'error', message: 'already in a room' })
      let room: Room
      /** Told to the creator once they are in the room, not dropped silently. */
      let optionNote: string | null = null
      if (msg.code === null) {
        room = this.rooms.create(this.startLeadMs)
        const o = msg.options
        if (o) {
          if (o.openControl !== undefined) room.openControl = o.openControl
          if (o.waitForLatecomers !== undefined) room.waitForLatecomers = o.waitForLatecomers
          if (o.mode === 'origin') {
            // Asking for the relay on a server that has no storage is a
            // reasonable thing for a client to do -- it cannot know until it
            // has connected. Fall back rather than fail, and say so.
            if (this.opts.origin) room.mode = 'origin'
            else optionNote = 'this server has no relay storage, so the film is shared peer to peer'
          } else if (o.mode === 'p2p') {
            room.mode = 'p2p'
          }
        }
      } else {
        const found = this.rooms.get(normaliseCode(msg.code))
        if (!found) return this.send(ws, { t: 'error', message: 'No room with that code' })
        room = found
      }
      const memberId = randomUUID()
      room.add(memberId, msg.name)
      this.conns.set(ws, { ws, memberId, room, trackerUrl })
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
      if (optionNote) this.emitChat(room, 'system', msg.name, optionNote, memberId)
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
        conn.room.setMedia({ name: msg.name, durationSec: msg.durationSec, source: msg.source }, me.id)
        // Only info hashes a room has announced are answerable, so this cannot
        // be used as a public tracker for arbitrary torrents.
        if (msg.source?.kind === 'p2p') this.tracker.allow(msg.source.infoHash)
        this.emitChat(conn.room, 'system', me.name, `put on ${msg.name}`, me.id)
        this.broadcastState(conn.room)
        this.broadcast(conn.room, { t: 'playback.schedule', state: conn.room.state, seq: conn.room.seq })
        return
      }

      case 'room.setMode': {
        if (!me.isHost) return this.send(ws, { t: 'error', message: 'Only the host can change how the film is shared' })
        if (msg.mode === 'origin' && !this.opts.origin) {
          return this.send(ws, { t: 'error', message: 'This server has no relay storage configured' })
        }
        if (conn.room.mode === msg.mode) return
        conn.room.mode = msg.mode
        // The film cannot follow: its bytes live where only the old transport
        // can reach them. Clearing it is honest -- leaving it would show a film
        // nobody could fetch.
        conn.room.setMedia({ name: '', durationSec: 0, source: null }, me.id)
        conn.room.media = null
        this.emitChat(conn.room, 'system', me.name,
          msg.mode === 'origin'
            ? 'switched to relay mode; the film needs sharing again'
            : 'switched to peer-to-peer; the film needs sharing again', me.id)
        this.broadcastState(conn.room)
        return
      }

      case 'origin.request': {
        const cfg = this.opts.origin
        if (!cfg) return this.send(ws, { t: 'error', message: 'This server has no relay storage configured' })
        const expiresAtMs = Date.now() + DEFAULT_EXPIRY_SECONDS * 1000

        if (msg.purpose === 'upload') {
          if (!me.mayControl) return this.send(ws, { t: 'error', message: 'You do not have permission to share a film' })
          if (!msg.contentId || !msg.name) return this.send(ws, { t: 'error', message: 'malformed upload request' })
          // The key is built here, from the room's own code. A client that could
          // name its own key could write over another room's film.
          const key = objectKeyFor(conn.room.code, msg.contentId, msg.name)
          return this.send(ws, {
            t: 'origin.url', purpose: 'upload', key, expiresAtMs,
            url: presign(cfg, { method: 'PUT', key })
          })
        }

        const source = conn.room.media?.source
        if (source?.kind !== 'origin') {
          return this.send(ws, { t: 'error', message: 'the room is not sharing a film through the relay' })
        }
        return this.send(ws, {
          t: 'origin.url', purpose: 'download', key: source.key, expiresAtMs,
          url: presign(cfg, { method: 'GET', key: source.key })
        })
      }

      case 'playback.request': {
        if (!me.mayControl) return this.send(ws, { t: 'error', message: 'You do not have playback control' })
        // Phase B1.3. Seeking moves the playhead for everybody, so a seek into
        // a stretch somebody has not downloaded stalls them while the rest
        // watch on. Enforced here rather than only in the interface: a limit
        // that lives in the client is a courtesy, and this is the same place
        // the permission above is checked.
        if (msg.intent === 'seek' && typeof msg.positionSec === 'number') {
          const refusal = this.seekRefusal(conn.room, msg.positionSec)
          if (refusal) return this.send(ws, { t: 'error', message: refusal })
        }
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

      case 'media.clear': {
        conn.room.clearMedia(me.id)
        this.emitChat(conn.room, 'system', me.name, 'took the film off', me.id)
        this.broadcastState(conn.room)
        this.broadcast(conn.room, { t: 'playback.schedule', state: conn.room.state, seq: conn.room.seq })
        return
      }

      case 'room.setOpenControl': {
        if (!me.isHost) return this.send(ws, { t: 'error', message: 'Only the host can change that' })
        conn.room.openControl = msg.open
        this.emitChat(conn.room, 'system', me.name,
          msg.open ? 'let everyone control playback' : 'kept playback control to the host', me.id)
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

      if (!c.room.media?.source) continue
      const status = c.room.transferStatus()
      // What the room may seek to, drawn by the interface from the same shape
      // as everyone else's piece map. Only meaningful once a film with a known
      // length is on; before that there is nothing to be outside of.
      const duration = c.room.media?.durationSec ?? 0
      const seekableMap = duration > 0 && status.perPeer.length > 0
        ? seekableMapOf(seekableBuckets(status.perPeer))
        : undefined
      this.broadcast(c.room, { t: 'transfer.status', ...status, seekableMap })
    }
  }

  private broadcastState (room: Room): void {
    room.lastBroadcastPhase = room.phase()
    // Sent one at a time rather than broadcast, because the tracker address is
    // the one thing in here that differs per client.
    for (const c of this.conns.values()) {
      if (c.room !== room) continue
      this.send(c.ws, this.roomState(room, c.trackerUrl))
    }
  }

  private roomState (room: Room, trackerUrl: string): ServerMessage {
    return {
      t: 'room.state',
      code: room.code,
      members: [...room.members.values()],
      media: room.media,
      trackerUrl,
      phase: room.phase(),
      waitForLatecomers: room.waitForLatecomers,
      openControl: room.openControl,
      mode: room.mode,
      originAvailable: !!this.opts.origin
    }
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
