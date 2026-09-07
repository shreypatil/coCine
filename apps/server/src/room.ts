import { positionAt, type Member, type PlaybackState } from '@cocine/protocol'

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
  media: { name: string; durationSec: number } | null = null
  seq = 0

  constructor (readonly code: string, private readonly startLeadMs = 300) {}

  add (id: string, name: string): Member {
    const member: Member = { id, name, isHost: this.members.size === 0, mayControl: true }
    this.members.set(id, member)
    return member
  }

  remove (id: string): void {
    const wasHost = this.members.get(id)?.isHost
    this.members.delete(id)
    // Hosting passes to whoever has been here longest rather than collapsing.
    if (wasHost) {
      const next = this.members.values().next().value
      if (next) next.isHost = true
    }
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
