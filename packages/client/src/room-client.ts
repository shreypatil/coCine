import WebSocket from 'ws'
import { EventEmitter } from 'node:events'
import { ClockSync, tick, extrapolatePosition, DEFAULT_SYNC_CONFIG, type SyncConfig, type SyncAction } from '@cocine/sync'
import { decodeServer, encode, sourceId, type ChatMessage, type ClientMessage, type Media, type Member, type PeerReport, type PeerStatus, type PlaybackState, type RoomPhase, type TorrentInfo, type MediaSource, type RoomMode, type RoomOptions, type IceServer } from '@cocine/protocol'
import type { PlayerController } from '@cocine/player'

export interface RoomClientOptions {
  url: string
  /** null creates a new room; a code joins an existing one. */
  code: string | null
  name: string
  /** Applied only when creating a room. Ignored when joining one, and ignored
   *  on a reconnect, which rejoins by code. */
  options?: RoomOptions
  player: PlayerController
  syncConfig?: SyncConfig
  /** How often the sync engine runs. mpv reports position at ~25 Hz, so there
   *  is no value above that; 20 Hz keeps control lag well inside the budget. */
  tickHz?: number
  pingIntervalMs?: number
  /** Called once a second to describe this client to the room. */
  getReport?: () => PeerReport | null
}

/**
 * Composes the three pieces: a socket to the server, a clock estimate, and the
 * pure sync engine driving a player. This is what Electron's main process will
 * hold, and what the drift test instantiates five of.
 *
 * It owns all the I/O so that `@cocine/sync` does not have to.
 */
export class RoomClient extends EventEmitter {
  readonly clock = new ClockSync()
  private ws: WebSocket | null = null
  private target: PlaybackState = { kind: 'idle' }
  private rate = 1
  private busy = false
  private timers: NodeJS.Timeout[] = []
  private lastAction: SyncAction = { type: 'none' }
  members: Member[] = []
  memberId = ''
  code = ''
  private pendingOriginUrl = new Map<'upload' | 'download',
    { resolve: (v: { url: string; key: string; expiresAtMs: number }) => void; reject: (e: Error) => void }>()
  media: Media | null = null
  phase: RoomPhase = 'lobby'
  waitForLatecomers = true
  /** Whether someone joining may drive playback without being handed control. */
  openControl = true
  /** How the room distributes the film; the host chooses. */
  mode: RoomMode = 'p2p'
  /** Whether the server has relay storage at all. Without it the host is
   *  shown no toggle rather than one that fails when pressed. */
  originAvailable = false
  transfer: {
    perPeer: PeerStatus[]
    etaSec: number | null
    tMinSec: number | null
    bottleneck: string | null
    fullCopies: number
    safeForSharerToLeave: boolean
  } | null = null
  /** Where the room's swarm announces. Learned from the server, never guessed. */
  trackerUrl = ''

  /**
   * Whether the room is actually reachable right now. `reconnecting` is the
   * state that previously did not exist and was displayed as `connected`.
   */
  connection: 'connected' | 'reconnecting' | 'closed' = 'closed'
  private wantConnection = true
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null

  /**
   * ICE servers, as issued by the server at welcome. The two planes are handed
   * out separately and deliberately differ: voice may be given a TURN relay,
   * bulk transfer never is. Relaying a film means the server carries it twice,
   * once in and once out, per viewer who needs the relay -- gigabytes of someone
   * else's bandwidth bill to avoid a NAT. Voice is kilobits and worth relaying.
   * Until welcome arrives these are empty, which is only ever the case before
   * any peer connection is attempted.
   */
  ice: { voice: IceServer[]; bulk: IceServer[] } = { voice: [], bulk: [] }
  /** Bounded locally as well as on the server, so a long session cannot grow
   *  the renderer's state without limit. */
  messages: ChatMessage[] = []

  constructor (private readonly o: RoomClientOptions) { super() }

  async connect (): Promise<void> {
    const ws = new WebSocket(this.o.url)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.on('message', raw => this.onMessage(String(raw)))
    // A socket that dies is not an error the caller can await -- it happens an
    // hour into a film, long after connect() resolved. Without this the room
    // went on showing a code and a drift reading while nothing worked.
    ws.on('close', () => this.onSocketClosed(ws))
    ws.on('error', () => { /* close follows, and is where recovery starts */ })
    this.connection = 'connected'
    // Options only travel with a creating hello; the server ignores them on a
    // join, and after a reconnect the code is no longer null anyway.
    this.send({ t: 'hello', code: this.o.code, name: this.o.name, options: this.o.code === null ? this.o.options : undefined })

    // Burst a few pings so the first estimate is usable immediately, then settle.
    for (let i = 0; i < 8; i++) { this.ping(); await new Promise(r => setTimeout(r, 25)) }
    await this.waitForClock()

    if (this.o.getReport) {
      this.timers.push(setInterval(() => {
        const report = this.o.getReport?.()
        if (report) this.send({ t: 'peer.report', report })
      }, 1000))
    }

    const pingMs = this.o.pingIntervalMs ?? 2000
    this.timers.push(setInterval(() => this.ping(), pingMs))
    const tickMs = 1000 / (this.o.tickHz ?? 20)
    this.timers.push(setInterval(() => { void this.runTick() }, tickMs))
  }

  private async waitForClock (timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!this.clock.ready) {
      if (Date.now() > deadline) throw new Error('no clock samples from server')
      await new Promise(r => setTimeout(r, 20))
    }
  }

  private ping (): void { this.send({ t: 'time.ping', c1: Date.now() }) }

  private onMessage (raw: string): void {
    const msg = decodeServer(raw)
    switch (msg.t) {
      case 'time.pong':
        this.clock.addExchange(msg.c1, msg.s1, msg.s2, Date.now())
        break
        case 'origin.url': {
          // Signed URLs are requested one at a time per purpose, so a single
          // pending resolver each is enough and nothing can be mismatched.
          const pending = this.pendingOriginUrl.get(msg.purpose)
          if (pending) { this.pendingOriginUrl.delete(msg.purpose); pending.resolve(msg) }
          break
        }
      case 'welcome':
        this.memberId = msg.memberId
        this.code = msg.code
        this.ice = msg.ice
        // Remember it for a reconnect: a client that created the room was given
        // a null code, and rejoining with null would create a second room.
        this.o.code = msg.code
        this.emit('welcome', msg.code)
        break
      case 'room.state':
        this.members = msg.members
        this.code = msg.code
        this.trackerUrl = msg.trackerUrl
        this.phase = msg.phase
        this.waitForLatecomers = msg.waitForLatecomers
        this.openControl = msg.openControl
        this.mode = msg.mode
        this.originAvailable = msg.originAvailable
        if (sourceId(msg.media?.source) !== sourceId(this.media?.source)) {
          this.media = msg.media
          this.emit('media', msg.media)
        } else {
          this.media = msg.media
        }
        this.emit('members', msg.members)
        break
      case 'chat.history':
        this.messages = msg.messages.slice(-200)
        this.emit('chat', this.messages)
        break
      case 'chat.message':
        this.messages = [...this.messages, msg.message].slice(-200)
        this.emit('chat', this.messages)
        break
      case 'playback.schedule':
        this.target = msg.state
        this.emit('schedule', msg.state)
        // React immediately rather than waiting for the next tick: a scheduled
        // start needs its seek to complete before the anchor instant arrives.
        void this.runTick()
        break
      case 'rtc.signal':
        this.emit('rtc-signal', msg.from, msg.payload)
        break
      case 'voice.moderated':
        this.emit('voice-moderated', msg.by, msg.action)
        break
      case 'transfer.status':
        this.transfer = {
          perPeer: msg.perPeer,
          etaSec: msg.etaSec,
          tMinSec: msg.tMinSec,
          bottleneck: msg.bottleneck,
          fullCopies: msg.fullCopies,
          safeForSharerToLeave: msg.safeForSharerToLeave
        }
        this.emit('transfer', this.transfer)
        break
      case 'error':
        this.emit('server-error', msg.message)
        break
    }
  }

  private async runTick (): Promise<void> {
    if (this.busy || !this.clock.ready) return
    const localNowMs = Date.now()
    const action = tick({
      target: this.target,
      serverNowMs: this.clock.serverNow(localNowMs),
      localNowMs,
      player: {
        positionSec: this.o.player.position(),
        observedAtMs: this.o.player.positionObservedAt(),
        paused: this.o.player.isPaused(),
        rate: this.rate
      },
      config: this.o.syncConfig ?? DEFAULT_SYNC_CONFIG
    })
    if (action.type === 'none') return

    this.busy = true
    try {
      switch (action.type) {
        case 'seek': await this.o.player.seek(action.toSec); break
        case 'play': await this.o.player.play(); break
        case 'pause': await this.o.player.pause(); break
        case 'setRate': await this.o.player.setRate(action.rate); this.rate = action.rate; break
      }
      this.lastAction = action
      this.emit('action', action)
    } catch (err) {
      this.emit('action-error', err)
    } finally {
      this.busy = false
    }
  }

  /** Where the room says the film should be, right now, in seconds. */
  expectedPosition (localNowMs = Date.now()): number | null {
    const s = this.target
    if (s.kind === 'idle') return null
    if (s.kind === 'paused') return s.positionSec
    const serverNow = this.clock.serverNow(localNowMs)
    if (serverNow < s.atServerMs) return s.positionSec
    return s.positionSec + (serverNow - s.atServerMs) / 1000
  }

  /** Where this client's film actually is, extrapolated past a stale reading. */
  actualPosition (localNowMs = Date.now()): number {
    return extrapolatePosition({
      positionSec: this.o.player.position(),
      observedAtMs: this.o.player.positionObservedAt(),
      paused: this.o.player.isPaused(),
      rate: this.rate
    }, localNowMs)
  }

  currentRate (): number { return this.rate }
  lastSyncAction (): SyncAction { return this.lastAction }

  /** A null torrent means "everyone is expected to already have this file". */
  /** Host only. Changing this clears the room's film: the bytes live where
   *  only the previous transport can reach them. */
  setMode (mode: RoomMode): void { this.send({ t: 'room.setMode', mode }) }

  /**
   * Ask the server for a signed URL. The client never holds the storage
   * credentials and never names a key for a download -- the server derives
   * both from the room, so one room cannot reach another's objects.
   */
  private originUrl (
    purpose: 'upload' | 'download',
    extra: { contentId?: string; name?: string; bytes?: number } = {},
    timeoutMs = 15_000
  ): Promise<{ url: string; key: string; expiresAtMs: number }> {
    const existing = this.pendingOriginUrl.get(purpose)
    if (existing) existing.reject(new Error('superseded by a newer request'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOriginUrl.delete(purpose)
        reject(new Error(`the server did not supply a ${purpose} URL within ${timeoutMs / 1000}s`))
      }, timeoutMs)
      this.pendingOriginUrl.set(purpose, {
        resolve: v => { clearTimeout(timer); resolve(v) },
        reject: e => { clearTimeout(timer); reject(e) }
      })
      this.send({ t: 'origin.request', purpose, ...extra })
    })
  }

  requestUploadUrl (contentId: string, name: string, bytes: number): Promise<{ url: string; key: string }> {
    return this.originUrl('upload', { contentId, name, bytes })
  }

  requestDownloadUrl (): Promise<string> {
    return this.originUrl('download').then(r => r.url)
  }

  announceMedia (name: string, durationSec: number, source: MediaSource | null = null): void {
    this.send({ t: 'media.announce', name, durationSec, source })
  }
  sendChat (text: string): void {
    const t = text.trim()
    if (t) this.send({ t: 'chat.send', text: t.slice(0, 800) })
  }

  setControl (memberId: string, mayControl: boolean): void {
    this.send({ t: 'member.setControl', memberId, mayControl })
  }

  transferHost (memberId: string): void { this.send({ t: 'member.transferHost', memberId }) }
  startAnyway (): void { this.send({ t: 'room.startAnyway' }) }
  sendSignal (to: string, payload: unknown): void { this.send({ t: 'rtc.signal', to, payload }) }
  setVoiceState (v: { inVoice: boolean; muted: boolean; deafened: boolean }): void {
    this.send({ t: 'voice.state', ...v })
  }

  moderateVoice (memberId: string, action: 'mute' | 'unmute'): void {
    this.send({ t: 'voice.moderate', memberId, action })
  }
  setWaitForLatecomers (wait: boolean): void { this.send({ t: 'room.setWaitForLatecomers', wait }) }
  /** Host only: whether someone arriving may drive playback. */
  setOpenControl (open: boolean): void { this.send({ t: 'room.setOpenControl', open }) }

  /** This client's own membership, once the room state has arrived. */
  me (): Member | undefined { return this.members.find(m => m.id === this.memberId) }
  requestPlay (positionSec?: number): void { this.send({ t: 'playback.request', intent: 'play', positionSec }) }
  requestPause (positionSec?: number): void { this.send({ t: 'playback.request', intent: 'pause', positionSec }) }
  requestSeek (positionSec: number): void { this.send({ t: 'playback.request', intent: 'seek', positionSec }) }

  private send (m: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(m))
  }

  async close (): Promise<void> {
    // Deliberate: stop trying to come back.
    this.wantConnection = false
    this.connection = 'closed'
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.ws?.close()
  }

  /**
   * The socket went away on its own.
   *
   * Reconnecting rejoins by room code, which is what the code is for -- the
   * server has no session to resume, so this arrives as a new member with a new
   * id. Chat history and room state come back with the join; playback state is
   * the server's and is re-anchored on the next schedule.
   */
  private onSocketClosed (ws: WebSocket): void {
    if (ws !== this.ws) return
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    if (!this.wantConnection) {
      this.connection = 'closed'
      this.emit('connection', this.connection)
      return
    }
    this.connection = 'reconnecting'
    this.emit('connection', this.connection)
    this.scheduleReconnect()
  }

  private scheduleReconnect (): void {
    if (this.reconnectTimer) return
    // Backing off matters when the server is down rather than the network
    // blipping: a tight retry loop against a dead host is just noise.
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempts, 6))
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.wantConnection) return
      void this.connect()
        .then(() => {
          this.reconnectAttempts = 0
          this.emit('connection', this.connection)
        })
        .catch(() => { if (this.wantConnection) this.scheduleReconnect() })
    }, delay)
    this.reconnectTimer.unref?.()
  }
}
