import { describe, it, expect } from 'vitest'
import {
  ClientMessage, ServerMessage, PlaybackState, MediaSource, PeerReport, Member,
  TorrentInfo, PieceMap, MAX_CHAT_LENGTH, PIECE_MAP_BUCKETS,
  encode, decodeClient, decodeServer, sourceId
} from '../src/index.js'

/**
 * The wire contract itself, rather than the server's behaviour across it.
 *
 * `apps/server/test/protocol.test.ts` drives a real socket and asserts what the
 * server *does*; nothing asserted what the schemas *accept*. That is a gap of a
 * particular kind: every one of these schemas sits between an untrusted client
 * and the room's state, and a schema that is looser than intended does not fail
 * anywhere -- it lets a malformed or hostile message through to code that was
 * written assuming validation had already happened.
 *
 * The room is invite-only and small, so this is not a hardening exercise
 * against strangers so much as insurance that a version-skewed client, or one
 * mid-refactor, is rejected at the door with a clear failure rather than
 * corrupting a room's state in a way nobody can trace.
 */

const parses = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown): boolean =>
  schema.safeParse(v).success

describe('what counts as a message at all', () => {
  it('rejects a type nobody defined', () => {
    expect(parses(ClientMessage, { t: 'room.selfDestruct' })).toBe(false)
    expect(parses(ClientMessage, { t: '' })).toBe(false)
    expect(parses(ClientMessage, {})).toBe(false)
  })

  it('rejects the two directions being confused for each other', () => {
    // 'welcome' is only ever sent by the server, 'hello' only by a client.
    // Accepting the wrong one would let a client push a message the server's
    // own handler never expected to receive.
    expect(parses(ClientMessage, { t: 'welcome', memberId: 'a', code: 'ABC', ice: { voice: [], bulk: [] } })).toBe(false)
    expect(parses(ServerMessage, { t: 'hello', name: 'anjali', code: null })).toBe(false)
  })

  it('rejects a field of the wrong type rather than coercing it', () => {
    // JSON from a client can carry a string where a number belongs, and a
    // coerced timestamp would put the whole room's clock out.
    expect(parses(ClientMessage, { t: 'time.ping', c1: '1700000000' })).toBe(false)
    expect(parses(ClientMessage, { t: 'time.ping', c1: 1700000000 })).toBe(true)
  })

  it('throws on input that is not JSON at all', () => {
    expect(() => decodeClient('not json')).toThrow()
    expect(() => decodeServer('')).toThrow()
  })

  it('round-trips every message it accepts', () => {
    const msg = { t: 'chat.send', text: 'starting in five' } as const
    expect(decodeClient(encode(msg))).toEqual(msg)
  })
})

describe('the chat length limit, which is the one bound a client controls directly', () => {
  it('accepts a message exactly at the limit', () => {
    expect(parses(ClientMessage, { t: 'chat.send', text: 'x'.repeat(MAX_CHAT_LENGTH) })).toBe(true)
  })

  it('rejects one character more', () => {
    // Off-by-one here is the difference between a bound and a suggestion, and
    // the room's history is kept in memory for every member.
    expect(parses(ClientMessage, { t: 'chat.send', text: 'x'.repeat(MAX_CHAT_LENGTH + 1) })).toBe(false)
  })

  it('rejects an empty message, which would render as a blank bubble', () => {
    expect(parses(ClientMessage, { t: 'chat.send', text: '' })).toBe(false)
  })
})

describe('playback state, where the wrong shape would desynchronise a room', () => {
  it('requires a position for a paused film and an anchor instant for a playing one', () => {
    // The anchor is what every client extrapolates from. A 'playing' state
    // without it cannot be turned into a position, and the sync engine would
    // have nothing to correct toward.
    expect(parses(PlaybackState, { kind: 'idle' })).toBe(true)
    expect(parses(PlaybackState, { kind: 'paused', positionSec: 42 })).toBe(true)
    expect(parses(PlaybackState, { kind: 'playing', positionSec: 42, atServerMs: 1700000000000 })).toBe(true)

    expect(parses(PlaybackState, { kind: 'paused' })).toBe(false)
    expect(parses(PlaybackState, { kind: 'playing', positionSec: 42 })).toBe(false)
    expect(parses(PlaybackState, { kind: 'stopped' })).toBe(false)
  })
})

describe('where a film comes from', () => {
  const torrent = {
    kind: 'p2p', infoHash: 'a'.repeat(40), magnet: 'magnet:?xt=urn:btih:' + 'a'.repeat(40),
    bytes: 4_000_000_000, pieceLength: 262_144
  }

  it('accepts a well-formed swarm source', () => {
    expect(parses(MediaSource, torrent)).toBe(true)
  })

  it('insists an info hash is one, in either case', () => {
    // It is used as a key into the tracker's allow-list, so anything else is
    // either a bug or an attempt to announce a torrent the room never approved.
    expect(parses(TorrentInfo, { ...torrent, infoHash: 'A'.repeat(40) })).toBe(true)
    expect(parses(TorrentInfo, { ...torrent, infoHash: 'a'.repeat(39) })).toBe(false)
    expect(parses(TorrentInfo, { ...torrent, infoHash: 'a'.repeat(41) })).toBe(false)
    expect(parses(TorrentInfo, { ...torrent, infoHash: 'z'.repeat(40) })).toBe(false)
    expect(parses(TorrentInfo, { ...torrent, infoHash: '' })).toBe(false)
  })

  it('refuses a film of no size, or of a fractional number of bytes', () => {
    expect(parses(TorrentInfo, { ...torrent, bytes: 0 })).toBe(false)
    expect(parses(TorrentInfo, { ...torrent, bytes: -1 })).toBe(false)
    expect(parses(TorrentInfo, { ...torrent, bytes: 1.5 })).toBe(false)
    expect(parses(TorrentInfo, { ...torrent, pieceLength: 0 })).toBe(false)
  })

  it('accepts a relay source and refuses one with no key', () => {
    expect(parses(MediaSource, { kind: 'origin', key: 'rooms/ABCD/film.mp4', bytes: 100 })).toBe(true)
    expect(parses(MediaSource, { kind: 'origin', key: '', bytes: 100 })).toBe(false)
  })

  it('refuses a source that is neither', () => {
    expect(parses(MediaSource, { kind: 'http', url: 'https://example.test/film.mp4' })).toBe(false)
  })

  it('identifies the two kinds by different fields, case-folded for the swarm', () => {
    // Comparing the wrong field silently means "the film never changes", which
    // is why every caller goes through sourceId rather than reaching in.
    expect(sourceId(torrent as never)).toBe('a'.repeat(40))
    expect(sourceId({ ...torrent, infoHash: 'A'.repeat(40) } as never)).toBe('a'.repeat(40))
    expect(sourceId({ kind: 'origin', key: 'rooms/ABCD/film.mp4', bytes: 1 } as never))
      .toBe('rooms/ABCD/film.mp4')
    expect(sourceId(null)).toBeNull()
    expect(sourceId(undefined)).toBeNull()
  })
})

describe('the once-a-second peer report, which every member sends and everyone sees', () => {
  const report = { havePct: 0.5, bufferEndSec: 30, downBps: 1_000_000, upBps: 500_000, peers: 3 }

  it('accepts a plausible report', () => {
    expect(parses(PeerReport, report)).toBe(true)
  })

  it('keeps a fraction a fraction', () => {
    // havePct drives the readiness gate and a progress bar. Out of range it
    // would either hold a room back for ever or start it before anyone is ready.
    expect(parses(PeerReport, { ...report, havePct: 0 })).toBe(true)
    expect(parses(PeerReport, { ...report, havePct: 1 })).toBe(true)
    expect(parses(PeerReport, { ...report, havePct: 1.01 })).toBe(false)
    expect(parses(PeerReport, { ...report, havePct: -0.01 })).toBe(false)
  })

  it('refuses negative rates and a fractional peer count', () => {
    expect(parses(PeerReport, { ...report, downBps: -1 })).toBe(false)
    expect(parses(PeerReport, { ...report, bufferEndSec: -1 })).toBe(false)
    expect(parses(PeerReport, { ...report, peers: 2.5 })).toBe(false)
    expect(parses(PeerReport, { ...report, peers: -1 })).toBe(false)
  })

  it('treats the piece map and the paused flag as optional', () => {
    // A client in relay mode fetches byte ranges and has no pieces to report,
    // and the interface falls back to a plain progress bar there.
    expect(parses(PeerReport, report)).toBe(true)
    expect(parses(PeerReport, { ...report, pieces: 'f'.repeat(64), paused: true })).toBe(true)
  })
})

describe('the piece map, which is drawn as a picture of who holds what', () => {
  it('is exactly one hex digit per bucket', () => {
    expect(PIECE_MAP_BUCKETS).toBe(64)
    expect(parses(PieceMap, '0'.repeat(PIECE_MAP_BUCKETS))).toBe(true)
    expect(parses(PieceMap, 'f'.repeat(PIECE_MAP_BUCKETS))).toBe(true)
    expect(parses(PieceMap, '0123456789abcdef'.repeat(4))).toBe(true)
  })

  it('rejects a map of the wrong length, which would misalign the whole picture', () => {
    expect(parses(PieceMap, '0'.repeat(63))).toBe(false)
    expect(parses(PieceMap, '0'.repeat(65))).toBe(false)
    expect(parses(PieceMap, '')).toBe(false)
  })

  it('rejects anything that is not lowercase hex', () => {
    expect(parses(PieceMap, 'F'.repeat(64))).toBe(false)
    expect(parses(PieceMap, 'g'.repeat(64))).toBe(false)
    expect(parses(PieceMap, `${'0'.repeat(63)} `)).toBe(false)
  })
})

describe('members, and the defaults a room relies on', () => {
  it('fills in the voice fields, so an older client does not arrive as undefined', () => {
    // These are read directly by the interface. Without defaults a member from a
    // client that predates voice would render as neither muted nor unmuted.
    const parsed = Member.parse({ id: 'm1', name: 'anjali', isHost: true, mayControl: true })
    expect(parsed).toMatchObject({ inVoice: false, muted: false, deafened: false })
  })

  it('still requires the fields that have no sensible default', () => {
    expect(parses(Member, { name: 'anjali', isHost: true, mayControl: true })).toBe(false)
    expect(parses(Member, { id: 'm1', name: 'anjali', isHost: 'yes', mayControl: true })).toBe(false)
  })
})

describe('the enumerations, where a typo would otherwise reach the server', () => {
  it('accepts only the two moderation actions', () => {
    expect(parses(ClientMessage, { t: 'voice.moderate', memberId: 'm1', action: 'mute' })).toBe(true)
    expect(parses(ClientMessage, { t: 'voice.moderate', memberId: 'm1', action: 'unmute' })).toBe(true)
    expect(parses(ClientMessage, { t: 'voice.moderate', memberId: 'm1', action: 'kick' })).toBe(false)
  })

  it('accepts only the two room modes', () => {
    expect(parses(ClientMessage, { t: 'room.setMode', mode: 'p2p' })).toBe(true)
    expect(parses(ClientMessage, { t: 'room.setMode', mode: 'origin' })).toBe(true)
    expect(parses(ClientMessage, { t: 'room.setMode', mode: 'torrent' })).toBe(false)
  })
})

describe('the one field that is deliberately unvalidated', () => {
  it('passes an RTC signal payload through untouched', () => {
    // Offers, answers and candidates are WebRTC's business, not this schema's,
    // and they are relayed to one named peer rather than acted on here. Worth
    // an assertion so that "unknown" reads as a decision rather than an
    // oversight to whoever tightens schemas next.
    for (const payload of [{ sdp: 'v=0...' }, null, 42, 'a string', { nested: { deep: true } }]) {
      expect(parses(ClientMessage, { t: 'rtc.signal', to: 'm2', payload })).toBe(true)
    }
    // The recipient, though, is this schema's business.
    expect(parses(ClientMessage, { t: 'rtc.signal', payload: {} })).toBe(false)
  })
})
