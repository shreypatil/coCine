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

/**
 * Chat doubles as the room's log. A system entry for someone joining or for the
 * host seizing control reads naturally in the same column as conversation, and
 * means there is one place to look when you wonder what just happened.
 */
export const ChatMessage = z.object({
  id: z.string(),
  kind: z.enum(['said', 'joined', 'left', 'system']),
  memberId: z.string().nullable(),
  name: z.string(),
  text: z.string(),
  atServerMs: z.number()
})
export type ChatMessage = z.infer<typeof ChatMessage>

export const MAX_CHAT_LENGTH = 800

export const ClientMessage = z.discriminatedUnion('t', [
  /** No code creates a room and returns one; a code joins an existing room. */
  z.object({ t: z.literal('hello'), code: z.string().nullable(), name: z.string().min(1).max(40) }),
  z.object({ t: z.literal('time.ping'), c1: z.number() }),
  z.object({ t: z.literal('media.announce'), name: z.string(), durationSec: z.number() }),
  z.object({
    t: z.literal('playback.request'),
    intent: z.enum(['play', 'pause', 'seek']),
    positionSec: z.number().optional()
  }),
  z.object({ t: z.literal('chat.send'), text: z.string().min(1).max(MAX_CHAT_LENGTH) }),
  z.object({ t: z.literal('member.setControl'), memberId: z.string(), mayControl: z.boolean() }),
  z.object({ t: z.literal('member.transferHost'), memberId: z.string() })
])
export type ClientMessage = z.infer<typeof ClientMessage>

export const ServerMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('welcome'), memberId: z.string(), code: z.string(), serverMs: z.number() }),
  /** c1 echoed back, plus the server's receive and send stamps. Four timestamps
   *  are what let a client separate clock offset from network delay. */
  z.object({ t: z.literal('time.pong'), c1: z.number(), s1: z.number(), s2: z.number() }),
  z.object({
    t: z.literal('room.state'),
    code: z.string(),
    members: z.array(Member),
    media: z.object({ name: z.string(), durationSec: z.number() }).nullable()
  }),
  z.object({ t: z.literal('playback.schedule'), state: PlaybackState, seq: z.number() }),
  z.object({ t: z.literal('chat.message'), message: ChatMessage }),
  /** Sent once on join so a latecomer sees what was already said. */
  z.object({ t: z.literal('chat.history'), messages: z.array(ChatMessage) }),
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

/**
 * Room codes are the only credential, so they have to be unguessable and also
 * readable aloud. This alphabet drops the characters people confuse -- 0/O,
 * 1/I/L, and the vowels that let a code spell something unfortunate -- leaving
 * 8 characters of 27 symbols, around 38 bits.
 */
const CODE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ'

export function formatCode (raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c
}

export function normaliseCode (input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function generateCode (random: (n: number) => Uint8Array): string {
  const bytes = random(8)
  let out = ''
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length]
  return out
}
