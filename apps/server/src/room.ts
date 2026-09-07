import { randomUUID } from 'node:crypto'
import { positionAt, type ChatMessage, type Media, type Member, type PeerReport, type PeerStatus, type PlaybackState, type RoomMode, type RoomPhase } from '@cocine/protocol'
import { bottleneck, durability, etaSeconds, isReady, phaseFor, tMinSeconds, DEFAULT_READINESS, type ReadinessConfig } from './readiness.js'

/** Enough backlog that a latecomer sees the conversation, not so much that a
 *  long session grows without bound. */
const CHAT_HISTORY = 200

/**
 * Playback state lives here, not in the host's client.
 *
 * That choice buys three things: the room survives the host's connection
 * blipping, permissions are enforceable rather than advisory, and a member who
 * joins late is correct by construction because they simply receive the current
 * anchor and compute from it.
 */
export class Room {
  readonly members = new Map<string, Member>()
  state: PlaybackState = { kind: 'idle' }
  media: Media | null = null
  seq = 0
  readonly chat: ChatMessage[] = []
  lastEmptyAtMs: number | null = Date.now()
  /** The most recent report from each member, by member id. */
  readonly reports = new Map<string, PeerReport>()
  /** Set by the host to start before everyone is ready. Cleared by a new film. */
  startOverridden = false
  /** Host preference: does the room pause when someone arrives mid-film? */
  waitForLatecomers = true

  /**
   * How the film is distributed. `p2p` is the default and the product; `origin`
   * is relay mode, for the room where the swarm cannot deliver at all. The host
   * chooses, and the choice is per room rather than per person -- a room cannot
   * be half in one mode and half in the other, because the two transports do not
   * share bytes.
   */
  mode: RoomMode = 'p2p'
  /** Whoever announced the film, so their upload can be identified. */
  sharerId: string | null = null
  /** The phase last sent to clients, so a change can be noticed and pushed. */
  lastBroadcastPhase: RoomPhase | null = null

  constructor (
    readonly code: string,
    private readonly startLeadMs = 300,
    private readonly readiness: ReadinessConfig = DEFAULT_READINESS
  ) {}

  /**
   * Put a film on. Clears the reports and any override with it: both describe
   * the previous film, and leaving them behind makes a room nobody has anything
   * of look ready to start.
   */
  setMedia (media: Media, sharerId: string): void {
    this.media = media
    this.sharerId = sharerId
    this.reports.clear()
    this.startOverridden = false
    this.state = { kind: 'paused', positionSec: 0 }
    this.seq++
  }

  /** Someone joining, leaving or changing their own microphone state. */
  setVoice (memberId: string, state: { inVoice: boolean; muted: boolean; deafened: boolean }): Member | undefined {
    const m = this.members.get(memberId)
    if (!m) return undefined
    m.inVoice = state.inVoice
    m.muted = state.muted
    m.deafened = state.deafened
    return m
  }

  report (memberId: string, report: PeerReport): void {
    if (this.members.has(memberId)) this.reports.set(memberId, report)
  }

  /** Every member's state, whether or not they have reported yet. */
  peerStatuses (): PeerStatus[] {
    return [...this.members.values()].map(m => {
      const r = this.reports.get(m.id) ?? { havePct: 0, bufferEndSec: 0, downBps: 0, upBps: 0, peers: 0 }
      return {
        memberId: m.id,
        name: m.name,
        havePct: r.havePct,
        bufferEndSec: r.bufferEndSec,
        downBps: r.downBps,
        upBps: r.upBps,
        peers: r.peers,
        ready: isReady(r, this.readiness)
      }
    })
  }

  phase (): RoomPhase {
    return phaseFor(this.media !== null, this.state.kind === 'playing', this.peerStatuses(), this.startOverridden)
  }

  /** Everything the room can honestly say about getting the film to everyone. */
  transferStatus (): {
    perPeer: PeerStatus[]
    etaSec: number | null
    tMinSec: number | null
    bottleneck: string | null
    fullCopies: number
    safeForSharerToLeave: boolean
  } {
    const perPeer = this.peerStatuses()
    const bytes = this.media?.source?.bytes ?? 0
    const sharer = perPeer.find(p => p.memberId === this.sharerId)
    const leechers = perPeer.filter(p => p.memberId !== this.sharerId)
    return {
      perPeer,
      etaSec: bytes > 0 ? etaSeconds(bytes, perPeer, this.readiness) : null,
      tMinSec: sharer ? tMinSeconds(bytes, sharer.upBps, leechers) : null,
      bottleneck: bottleneck(perPeer),
      ...durability(perPeer)
    }
  }

  add (id: string, name: string): Member {
    const member: Member = {
      id, name, isHost: this.members.size === 0, mayControl: true,
      inVoice: false, muted: false, deafened: false
    }
    this.members.set(id, member)
    this.lastEmptyAtMs = null
    return member
  }

  remove (id: string): void {
    const wasHost = this.members.get(id)?.isHost
    this.members.delete(id)
    this.reports.delete(id)
    // Hosting passes to whoever has been here longest rather than collapsing.
    if (wasHost) {
      const next = this.members.values().next().value
      if (next) next.isHost = true
    }
    if (this.members.size === 0) this.lastEmptyAtMs = Date.now()
  }

  host (): Member | undefined {
    for (const m of this.members.values()) if (m.isHost) return m
    return undefined
  }

  /**
   * Permission changes are the host's alone. Enforced here rather than in the
   * interface, because an interface check is a suggestion -- anyone can send
   * the message directly.
   */
  setControl (actorId: string, targetId: string, mayControl: boolean): Member {
    const actor = this.members.get(actorId)
    if (!actor?.isHost) throw new Error('only the host can change who may control playback')
    const target = this.members.get(targetId)
    if (!target) throw new Error('no such member')
    if (target.isHost) throw new Error('the host always keeps control')
    target.mayControl = mayControl
    return target
  }

  transferHost (actorId: string, targetId: string): Member {
    const actor = this.members.get(actorId)
    if (!actor?.isHost) throw new Error('only the host can hand over hosting')
    const target = this.members.get(targetId)
    if (!target) throw new Error('no such member')
    actor.isHost = false
    target.isHost = true
    target.mayControl = true
    return target
  }

  addChat (kind: ChatMessage['kind'], name: string, text: string, memberId: string | null, nowMs: number): ChatMessage {
    const message: ChatMessage = { id: randomUUID(), kind, memberId, name, text, atServerMs: nowMs }
    this.chat.push(message)
    if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY)
    return message
  }

  /**
   * Every transition produces an anchor, never a command. The lead time is what
   * gives the slowest client room to receive the message and finish its seek
   * before the instant arrives.
   */
  apply (intent: 'play' | 'pause' | 'seek', positionSec: number | undefined, nowMs: number): PlaybackState {
    const current = positionAt(this.state, nowMs) ?? 0
    switch (intent) {
      case 'play':
        this.state = { kind: 'playing', positionSec: positionSec ?? current, atServerMs: nowMs + this.startLeadMs }
        break
      case 'pause':
        this.state = { kind: 'paused', positionSec: positionSec ?? current }
        break
      case 'seek': {
        const to = positionSec ?? current
        this.state = this.state.kind === 'playing'
          ? { kind: 'playing', positionSec: to, atServerMs: nowMs + this.startLeadMs }
          : { kind: 'paused', positionSec: to }
        break
      }
    }
    this.seq++
    return this.state
  }
}
