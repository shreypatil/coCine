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
  mayControl: z.boolean(),
  /** In the voice call at all. Someone can be in the room without it. */
  inVoice: z.boolean().default(false),
  muted: z.boolean().default(false),
  deafened: z.boolean().default(false)
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

/**
 * What the swarm needs to fetch a film.
 *
 * Nullable on purpose: a room can still announce a film that everyone is
 * expected to already have, which is how phases 1 through 3 worked and remains
 * the right mode when nobody needs anything transferred. Its presence is what
 * means "and you can get it from us".
 */
export const TorrentInfo = z.object({
  infoHash: z.string().regex(/^[0-9a-f]{40}$/i),
  magnet: z.string().min(1),
  bytes: z.number().int().positive(),
  pieceLength: z.number().int().positive()
})
export type TorrentInfo = z.infer<typeof TorrentInfo>

/**
 * Where a film can be got from. Two transports, one shape.
 *
 * `p2p` is the swarm: everyone who has bytes serves them, and the sharer's
 * upload is divided among the room. `origin` is relay mode: the sharer uploads
 * once to object storage and everyone fetches from there. The second exists for
 * the room where the first cannot work at all -- no two peers able to connect,
 * or a sharer whose uplink cannot feed even one viewer.
 *
 * An origin source names only a key. The URL to reach it is minted by the server
 * on request and expires, so a client can neither hold a durable link nor name a
 * key of its own choosing.
 */
export const P2PSource = TorrentInfo.extend({ kind: z.literal('p2p') })
export type P2PSource = z.infer<typeof P2PSource>

export const OriginSource = z.object({
  kind: z.literal('origin'),
  key: z.string().min(1),
  bytes: z.number().int().positive()
})
export type OriginSource = z.infer<typeof OriginSource>

export const MediaSource = z.discriminatedUnion('kind', [P2PSource, OriginSource])
export type MediaSource = z.infer<typeof MediaSource>

/**
 * A stable identity for a source, used to notice that the room's film changed.
 * The two transports identify content differently -- a swarm by info hash, an
 * origin by object key -- and comparing the wrong field silently means "the film
 * never changes", so every caller goes through here.
 */
export function sourceId (source: MediaSource | null | undefined): string | null {
  if (!source) return null
  return source.kind === 'p2p' ? source.infoHash.toLowerCase() : source.key
}

export const Media = z.object({
  name: z.string(),
  durationSec: z.number(),
  source: MediaSource.nullable()
})
export type Media = z.infer<typeof Media>

/**
 * How the room distributes the film. The host chooses; it is not automatic,
 * because switching means re-uploading and only a person can judge whether that
 * is worth it.
 */
export const RoomMode = z.enum(['p2p', 'origin'])
export type RoomMode = z.infer<typeof RoomMode>

/** What each client tells the room about itself, once a second. */
export const PeerReport = z.object({
  /** Fraction of the film held locally, 0 to 1. */
  havePct: z.number().min(0).max(1),
  /** Contiguous seconds of film available from the current playhead. */
  bufferEndSec: z.number().min(0),
  downBps: z.number().min(0),
  upBps: z.number().min(0),
  /** Swarm peers this client is connected to. */
  peers: z.number().int().min(0)
})
export type PeerReport = z.infer<typeof PeerReport>

export const PeerStatus = z.object({
  memberId: z.string(),
  name: z.string(),
  havePct: z.number(),
  bufferEndSec: z.number(),
  downBps: z.number(),
  upBps: z.number(),
  peers: z.number(),
  ready: z.boolean()
})
export type PeerStatus = z.infer<typeof PeerStatus>

/**
 * The room's progress toward everyone being able to watch.
 *
 * `lobby` no film. `preparing` a film is arriving and not everyone can start.
 * `ready` everyone holds enough of a head start. `playing` speaks for itself.
 */
export const RoomPhase = z.enum(['lobby', 'preparing', 'ready', 'playing'])
export type RoomPhase = z.infer<typeof RoomPhase>

export const ClientMessage = z.discriminatedUnion('t', [
  /** No code creates a room and returns one; a code joins an existing room. */
  z.object({ t: z.literal('hello'), code: z.string().nullable(), name: z.string().min(1).max(40) }),
  z.object({ t: z.literal('time.ping'), c1: z.number() }),
  z.object({
    t: z.literal('media.announce'),
    name: z.string(),
    durationSec: z.number(),
      source: MediaSource.nullable().default(null)
  }),
    /** Host only. Switching mode clears the current film: the bytes live
     *  somewhere the other transport cannot reach. */
    z.object({ t: z.literal('room.setMode'), mode: RoomMode }),
    /**
     * Ask for a signed URL. The key is never supplied by the client -- for an
     * upload the server derives it, and for a download it comes from the room's
     * own media -- so no client can address another room's objects.
     */
    z.object({
      t: z.literal('origin.request'),
      purpose: z.enum(['upload', 'download']),
      /** Upload only: identifies the content so re-sharing does not re-upload. */
      contentId: z.string().min(1).max(64).optional(),
      name: z.string().optional(),
      bytes: z.number().int().positive().optional()
    }),
  z.object({
    t: z.literal('playback.request'),
    intent: z.enum(['play', 'pause', 'seek']),
    positionSec: z.number().optional()
  }),
  z.object({ t: z.literal('chat.send'), text: z.string().min(1).max(MAX_CHAT_LENGTH) }),
  z.object({ t: z.literal('member.setControl'), memberId: z.string(), mayControl: z.boolean() }),
  z.object({ t: z.literal('member.transferHost'), memberId: z.string() }),
  z.object({ t: z.literal('peer.report'), report: PeerReport }),
  /** Opaque WebRTC negotiation, relayed to one other member and nobody else. */
  z.object({ t: z.literal('rtc.signal'), to: z.string(), payload: z.unknown() }),
  z.object({
    t: z.literal('voice.state'),
    inVoice: z.boolean(),
    muted: z.boolean(),
    deafened: z.boolean()
  }),
  /**
   * Host only. Advisory in a mesh: the server has no media to stop, so it can
   * only ask. Enforcement needs the SFU, which is a later phase.
   */
  z.object({ t: z.literal('voice.moderate'), memberId: z.string(), action: z.enum(['mute', 'unmute']) }),
  /** Host only: start even though somebody is not ready. */
  z.object({ t: z.literal('room.startAnyway') }),
  /** Host only: whether the room pauses when someone arrives mid-film. */
  z.object({ t: z.literal('room.setWaitForLatecomers'), wait: z.boolean() })
])
export type ClientMessage = z.infer<typeof ClientMessage>

export const IceServer = z.object({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional()
})
export type IceServer = z.infer<typeof IceServer>

export const ServerMessage = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('welcome'),
    memberId: z.string(),
    code: z.string(),
    serverMs: z.number(),
    /**
     * Two sets, because the planes are treated oppositely. Voice may relay;
     * bulk never does, and is simply never given a relay to use.
     */
    ice: z.object({ voice: z.array(IceServer), bulk: z.array(IceServer) })
  }),
  /** c1 echoed back, plus the server's receive and send stamps. Four timestamps
   *  are what let a client separate clock offset from network delay. */
  z.object({ t: z.literal('time.pong'), c1: z.number(), s1: z.number(), s2: z.number() }),
  z.object({
    t: z.literal('room.state'),
    code: z.string(),
    members: z.array(Member),
    media: Media.nullable(),
    /** Where to announce, so clients do not have to guess the tracker URL. */
    trackerUrl: z.string(),
    phase: RoomPhase,
      waitForLatecomers: z.boolean(),
      mode: RoomMode,
      /** Whether the server has origin storage configured at all. Without it the
       *  host is offered no toggle, rather than a toggle that fails. */
      originAvailable: z.boolean()
  }),
  z.object({
    t: z.literal('transfer.status'),
    perPeer: z.array(PeerStatus),
    /** Seconds until everyone can start, from observed rates. Null while unknown. */
    etaSec: z.number().nullable(),
    /** The floor no scheduling can beat. Null until rates are known. */
    tMinSec: z.number().nullable(),
    /** Whoever the room is waiting for, by name. */
    bottleneck: z.string().nullable(),
    /** Whole copies of the film in the room, counting the sharer. */
    fullCopies: z.number(),
    /** Whether the film survives the sharer disconnecting. */
    safeForSharerToLeave: z.boolean()
  }),
  z.object({ t: z.literal('playback.schedule'), state: PlaybackState, seq: z.number() }),
    /** A signed URL, good for one method on one key until it expires. */
    z.object({
      t: z.literal('origin.url'),
      purpose: z.enum(['upload', 'download']),
      url: z.string(),
      key: z.string(),
      expiresAtMs: z.number()
    }),
  z.object({ t: z.literal('chat.message'), message: ChatMessage }),
  /** Sent once on join so a latecomer sees what was already said. */
  z.object({ t: z.literal('chat.history'), messages: z.array(ChatMessage) }),
  z.object({ t: z.literal('rtc.signal'), from: z.string(), payload: z.unknown() }),
  /** Sent to the person being asked, so their own client can comply. */
  z.object({ t: z.literal('voice.moderated'), by: z.string(), action: z.enum(['mute', 'unmute']) }),
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
