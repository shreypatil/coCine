/**
 * A full mesh of peer connections, one per other person in the room.
 *
 * Mesh rather than a server-side mixer because at six people it is the simpler
 * thing that works: no media passes through any server, and there is nothing to
 * run or pay for. It stops scaling somewhere around eight, where each person is
 * encoding a separate stream for everyone else and the cost is their CPU rather
 * than their bandwidth.
 *
 * Written against minimal interfaces rather than the DOM's, so the negotiation
 * can be driven by fakes in a test. Getting this wrong produces calls that
 * connect for some pairs and not others, which is miserable to debug live.
 */

export interface SignalPayload {
  kind: 'offer' | 'answer' | 'candidate'
  sdp?: string
  candidate?: unknown
}

export interface ConnectionLike {
  createOffer: () => Promise<{ type: string; sdp?: string }>
  createAnswer: () => Promise<{ type: string; sdp?: string }>
  setLocalDescription: (d: { type: string; sdp?: string }) => Promise<void>
  setRemoteDescription: (d: { type: string; sdp?: string }) => Promise<void>
  addIceCandidate: (c: unknown) => Promise<void>
  addTrack: (track: unknown, stream: unknown) => void
  /** Optional because the fakes predate it; every real connection has it. */
  getSenders?: () => Array<{ track: unknown; replaceTrack: (t: unknown) => Promise<void> }>
  close: () => void
  onicecandidate: ((e: { candidate: unknown }) => void) | null
  ontrack: ((e: { streams: unknown[] }) => void) | null
  onconnectionstatechange: (() => void) | null
  connectionState: string
}

export interface VoiceMeshOptions {
  selfId: string
  send: (to: string, payload: SignalPayload) => void
  createConnection: () => ConnectionLike
  onRemoteStream: (memberId: string, stream: unknown) => void
  onPeerStateChange?: (memberId: string, state: string) => void
  /**
   * How long to wait before each attempt to bring back a connection that
   * failed, in order. When they run out the connection is left failed.
   */
  retryDelaysMs?: number[]
  /** Timers, injectable so a test can drive the retries. */
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

interface Peer { conn: ConnectionLike; pendingCandidates: unknown[]; remoteSet: boolean }

/**
 * Five attempts over about a minute. A Wi-Fi blip or a laptop lid recovers in
 * the first one or two; a network that has gone for good is not worth hammering
 * past that, and the room's member list will drop the person anyway.
 */
export const RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 15_000, 30_000]

/**
 * An ICE candidate as plain data, fit to leave the page.
 *
 * `RTCIceCandidate` is a platform object: its fields are prototype getters, and
 * structured clone -- which is what Electron IPC uses -- cannot copy it. It
 * does not throw. It hands the other side an empty object, `addIceCandidate({})`
 * accepts that without complaint, and the connection sits at `new` for ever
 * with no error anywhere. Offers and answers are strings and crossed intact,
 * which is what made this look like a network problem for days: every kind of
 * signal was visibly sent and received, and only the candidates were hollow.
 *
 * `toJSON()` is the platform's own definition of the candidate as data.
 */
function plainCandidate (candidate: unknown): unknown {
  const c = candidate as { toJSON?: () => unknown } | null
  return c && typeof c.toJSON === 'function' ? c.toJSON() : candidate
}

export class VoiceMesh {
  private peers = new Map<string, Peer>()
  private localTracks: Array<{ track: unknown; stream: unknown }> = []
  /** Reconnection attempts made per person since they were last connected. */
  private attempts = new Map<string, number>()
  private retryTimers = new Map<string, unknown>()
  private readonly delays: number[]
  private readonly setT: (fn: () => void, ms: number) => unknown
  private readonly clearT: (handle: unknown) => void

  constructor (private readonly o: VoiceMeshOptions) {
    this.delays = o.retryDelaysMs ?? RETRY_DELAYS_MS
    this.setT = o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearT = o.clearTimeout ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  get selfId (): string { return this.o.selfId }

  get connectedIds (): string[] { return [...this.peers.keys()] }

  /**
   * Only one side of a pair may offer, or both send offers at once and the
   * negotiation collapses. Comparing ids is arbitrary but consistent, and both
   * sides reach the same answer without needing to agree on anything.
   */
  private shouldInitiate (peerId: string): boolean { return this.o.selfId < peerId }

  setLocalStream (stream: unknown, tracks: unknown[]): void {
    this.localTracks = tracks.map(track => ({ track, stream }))
    for (const [, p] of this.peers) {
      for (const { track, stream: s } of this.localTracks) p.conn.addTrack(track, s)
    }
  }

  /**
   * Swap the microphone under a live call.
   *
   * `replaceTrack` renegotiates nothing: the other side keeps receiving on the
   * same sender and hears the new track. This is how a microphone that opened
   * silent -- Bluetooth earbuds still in music-only mode, typically -- is asked
   * for again without anyone dropping out, and how a different device is chosen
   * mid-call. Connections that have not been given a sender for the old track
   * (opened before any local stream existed) get the new one added instead.
   */
  async replaceLocalTrack (oldTrack: unknown, track: unknown, stream: unknown): Promise<void> {
    this.localTracks = this.localTracks.map(t => t.track === oldTrack ? { track, stream } : t)
    if (!this.localTracks.some(t => t.track === track)) this.localTracks.push({ track, stream })
    for (const [, p] of this.peers) {
      const sender = p.conn.getSenders?.().find(s => s.track === oldTrack)
      if (sender) await sender.replaceTrack(track)
      else p.conn.addTrack(track, stream)
    }
  }

  /** Bring the mesh in line with who is in the call. Safe to call repeatedly. */
  async setMembers (memberIds: string[]): Promise<void> {
    const wanted = new Set(memberIds.filter(id => id !== this.o.selfId))
    for (const id of [...this.peers.keys()]) {
      if (!wanted.has(id)) this.forget(id)
    }
    for (const id of wanted) {
      if (this.peers.has(id)) continue
      const peer = this.open(id)
      if (this.shouldInitiate(id)) await this.offer(id, peer)
    }
  }

  private async offer (id: string, peer: Peer): Promise<void> {
    const offer = await peer.conn.createOffer()
    // Dropped or replaced while the offer was being made: it belongs to nobody.
    if (this.peers.get(id) !== peer) return
    await peer.conn.setLocalDescription(offer)
    this.o.send(id, { kind: 'offer', sdp: offer.sdp })
  }

  /**
   * A connection failed. The side that offers starts again from nothing -- a
   * new connection and a new offer -- after a pause, and the other side waits
   * to be offered. Without this a call that dropped stayed silent for good: the
   * failed connection was still "the connection to them", so nothing ever
   * replaced it, and the room went on listing them as in voice.
   *
   * A fresh connection rather than an ICE restart because it needs nothing from
   * the other side beyond what a first offer does, and the other side handles a
   * fresh offer the same way whether its own end noticed the failure or not.
   */
  private onFailed (id: string): void {
    if (!this.shouldInitiate(id) || this.retryTimers.has(id)) return
    const n = this.attempts.get(id) ?? 0
    const delay = this.delays[n]
    if (delay === undefined) return
    this.attempts.set(id, n + 1)
    this.retryTimers.set(id, this.setT(() => {
      this.retryTimers.delete(id)
      if (!this.peers.has(id)) return
      this.drop(id)
      const peer = this.open(id)
      this.o.onPeerStateChange?.(id, 'connecting')
      void this.offer(id, peer).catch(() => this.onFailed(id))
    }, delay))
  }

  private open (id: string): Peer {
    const conn = this.o.createConnection()
    const peer: Peer = { conn, pendingCandidates: [], remoteSet: false }
    conn.onicecandidate = e => {
      if (e.candidate) this.o.send(id, { kind: 'candidate', candidate: plainCandidate(e.candidate) })
    }
    conn.ontrack = e => { if (e.streams[0]) this.o.onRemoteStream(id, e.streams[0]) }
    conn.onconnectionstatechange = () => {
      const state = conn.connectionState
      this.o.onPeerStateChange?.(id, state)
      if (state === 'connected') this.attempts.delete(id)
      else if (state === 'failed') this.onFailed(id)
    }
    for (const { track, stream } of this.localTracks) conn.addTrack(track, stream)
    this.peers.set(id, peer)
    return peer
  }

  async handleSignal (from: string, payload: SignalPayload): Promise<void> {
    // Never a call to ourselves, whatever the room says. A client whose member
    // id changed under a live mesh once offered to its own new id, answered
    // itself, and logged a failure on every rejoin.
    if (from === this.o.selfId) return
    let peer = this.peers.get(from)
    // A second offer is a fresh start from the other side -- it rebuilt its end
    // after a failure or a rejoin -- and goes to a fresh connection. Nothing in
    // this mesh renegotiates a live connection, so it cannot be anything else.
    if (peer && payload.kind === 'offer' && peer.remoteSet) {
      this.drop(from)
      peer = undefined
    }
    // An offer can arrive before we have noticed the person joined.
    if (!peer) peer = this.open(from)

    if (payload.kind === 'offer') {
      await peer.conn.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
      peer.remoteSet = true
      await this.flush(peer)
      const answer = await peer.conn.createAnswer()
      await peer.conn.setLocalDescription(answer)
      this.o.send(from, { kind: 'answer', sdp: answer.sdp })
      return
    }

    if (payload.kind === 'answer') {
      await peer.conn.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
      peer.remoteSet = true
      await this.flush(peer)
      return
    }

    // Candidates routinely arrive before the description they belong to; adding
    // one then is an error, so they are held until there is somewhere to put them.
    if (!peer.remoteSet) { peer.pendingCandidates.push(payload.candidate); return }
    await peer.conn.addIceCandidate(payload.candidate)
  }

  private async flush (peer: Peer): Promise<void> {
    const held = peer.pendingCandidates.splice(0)
    for (const c of held) await peer.conn.addIceCandidate(c)
  }

  /** Drop someone and everything kept about them, including a pending retry. */
  private forget (id: string): void {
    const t = this.retryTimers.get(id)
    if (t !== undefined) this.clearT(t)
    this.retryTimers.delete(id)
    this.attempts.delete(id)
    this.drop(id)
  }

  private drop (id: string): void {
    const peer = this.peers.get(id)
    if (!peer) return
    peer.conn.onicecandidate = null
    peer.conn.ontrack = null
    peer.conn.onconnectionstatechange = null
    peer.conn.close()
    this.peers.delete(id)
  }

  close (): void {
    for (const id of new Set([...this.peers.keys(), ...this.retryTimers.keys()])) this.forget(id)
    this.localTracks = []
  }
}
