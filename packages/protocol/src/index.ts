import { z } from 'zod'

/**
 * The wire contract, defined once. Zod gives runtime validation on the server
 * and an inferred TypeScript type on both sides, so client and server cannot
 * drift apart on message shapes without it becoming a compile error.
 */

/**
 * Playback is expressed as an anchor, never as a command.
 *
 * `playing` means: position was `positionSec` at server time `atServerMs`, and
 * has advanced in real time since. A client that receives this late is still
 * correct -- it computes where the film should be now. A client that receives
 * it early holds at `positionSec` until the anchor time arrives.
 *
 * This is the whole reason nobody is ever told to "play now".
 */
export const PlaybackState = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }),
  z.object({ kind: z.literal('paused'), positionSec: z.number() }),
  z.object({ kind: z.literal('playing'), positionSec: z.number(), atServerMs: z.number() })
])
export type PlaybackState = z.infer<typeof PlaybackState>

export const Member = z.object({
  id: z.string(),
  name: z.string(),
  isHost: z.boolean(),
  mayControl: z.boolean()
})
export type Member = z.infer<typeof Member>

export const ClientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), room: z.string(), name: z.string() }),
  z.object({ t: z.literal('time.ping'), c1: z.number() }),
  z.object({ t: z.literal('media.announce'), name: z.string(), durationSec: z.number() }),
  z.object({
    t: z.literal('playback.request'),
    intent: z.enum(['play', 'pause', 'seek']),
    positionSec: z.number().optional()
  })
])
export type ClientMessage = z.infer<typeof ClientMessage>

export const ServerMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('welcome'), memberId: z.string(), serverMs: z.number() }),
  /** c1 echoed back, plus the server's receive and send stamps. Four timestamps
   *  are what let a client separate clock offset from network delay. */
  z.object({ t: z.literal('time.pong'), c1: z.number(), s1: z.number(), s2: z.number() }),
  z.object({ t: z.literal('room.state'), members: z.array(Member), media: z.object({ name: z.string(), durationSec: z.number() }).nullable() }),
  z.object({ t: z.literal('playback.schedule'), state: PlaybackState, seq: z.number() }),
  z.object({ t: z.literal('error'), message: z.string() })
])
export type ServerMessage = z.infer<typeof ServerMessage>

export const encode = (m: ServerMessage | ClientMessage): string => JSON.stringify(m)
export const decodeClient = (raw: string): ClientMessage => ClientMessage.parse(JSON.parse(raw))
export const decodeServer = (raw: string): ServerMessage => ServerMessage.parse(JSON.parse(raw))

/**
 * Where the film should be, in seconds, at a given server time.
 * Returns null when nothing is loaded.
 */
export function positionAt (state: PlaybackState, serverMs: number): number | null {
  if (state.kind === 'idle') return null
  if (state.kind === 'paused') return state.positionSec
  return state.positionSec + Math.max(0, serverMs - state.atServerMs) / 1000
}
