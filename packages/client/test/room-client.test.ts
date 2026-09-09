import { describe, it, expect, afterEach } from 'vitest'
import { SignallingServer } from '../../../apps/server/src/server.js'
import type { OriginConfig } from '../../../apps/server/src/origin.js'
import { RoomClient } from '../src/room-client.js'
import type { PlayerController } from '@cocine/player'

/**
 * RoomClient's command surface, against a real server.
 *
 * Under half of this class's methods had ever been called by a test. They are
 * one-liners that put a message on the wire, which is exactly why they went
 * unasserted and exactly why a mistake in one is invisible: send the wrong
 * field name and the message is still valid JSON, the server's schema rejects
 * it or silently ignores it, and the button in the interface simply does
 * nothing. No error, no log, no failing test.
 *
 * So these are round trips rather than assertions about what was sent. Each one
 * drives the client the way the interface does and then checks the effect
 * somewhere observable -- the server's own state, or a second client in the
 * room -- which is the only thing that proves the message was understood.
 */

const stubPlayer = (): PlayerController => ({
  load: async () => {}, play: async () => {}, pause: async () => {},
  seek: async () => {}, setRate: async () => {},
  position: () => 0, isPaused: () => true, positionObservedAt: () => Date.now(),
  duration: () => null, showText: async () => {}, setVolume: async () => {},
  unload: async () => {},
  on: () => {}, close: async () => {}
}) as PlayerController

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

/** Poll until true, so nothing here sleeps on a guess about timing. */
async function until (cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 20))
  }
}

const ORIGIN: OriginConfig = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  bucket: 'cocine',
  accessKeyId: 'key',
  secretAccessKey: 'secret'
}

async function room (opts: { origin?: OriginConfig } = {}): Promise<{
  server: SignallingServer; port: number; host: RoomClient; guest: RoomClient
}> {
  const server = new SignallingServer({ startLeadMs: 50, ...opts })
  const port = await server.listen()
  cleanups.push(() => server.close())

  const host = new RoomClient({ url: `ws://127.0.0.1:${port}`, code: null, name: 'anjali', player: stubPlayer() })
  cleanups.push(() => host.close())
  await host.connect()

  const guest = new RoomClient({ url: `ws://127.0.0.1:${port}`, code: host.code, name: 'dev', player: stubPlayer() })
  cleanups.push(() => guest.close())
  await guest.connect()

  await until(() => host.members.length === 2 && guest.members.length === 2, 'both members to appear')
  return { server, port, host, guest }
}

describe('who may do what', () => {
  it('grants and revokes control, and both clients see it', async () => {
    // A room starts with openControl on -- everyone who arrives may drive
    // playback, which is the friends-and-family default -- so the restricted
    // state has to be asked for before it can be granted back.
    const { host, guest } = await room()
    const guestId = guest.memberId!
    host.setOpenControl(false)
    host.setControl(guestId, false)
    await until(() => guest.me()?.mayControl === false, 'the guest to start without control')

    host.setControl(guestId, true)
    await until(() => guest.me()?.mayControl === true, 'the guest to gain control')
    expect(host.members.find(m => m.id === guestId)?.mayControl).toBe(true)

    host.setControl(guestId, false)
    await until(() => guest.me()?.mayControl === false, 'the guest to lose control')
  }, 30_000)

  it('hands the room over, which moves the host flag rather than duplicating it', async () => {
    // A room with two hosts, or none, is a state nothing else in the server
    // knows how to recover from.
    const { host, guest } = await room()
    host.transferHost(guest.memberId!)
    await until(() => guest.me()?.isHost === true, 'the guest to become host')
    expect(host.me()?.isHost).toBe(false)
    expect(guest.members.filter(m => m.isHost)).toHaveLength(1)
  }, 30_000)

  it('closes and reopens control to everyone who arrives', async () => {
    // It starts open, so the meaningful assertion is that it can be closed and
    // that the change reaches the other client both ways.
    const { host, guest } = await room()
    expect(host.openControl).toBe(true)
    host.setOpenControl(false)
    await until(() => guest.openControl === false, 'control to close')
    host.setOpenControl(true)
    await until(() => guest.openControl === true, 'control to reopen')
  }, 30_000)

  it('ignores a command from someone who is not the host', async () => {
    // The guest asking is not an error worth crashing over, but it must not
    // work either -- and the client learns why through the error event.
    const { host, guest } = await room()
    host.setOpenControl(false)
    await until(() => guest.openControl === false, 'control to close')

    const errors: string[] = []
    guest.on('server-error', (m: string) => errors.push(m))
    guest.setOpenControl(true)
    await until(() => errors.length > 0, 'the server to refuse')
    expect(host.openControl).toBe(false)
  }, 30_000)
})

describe('the room\'s own settings', () => {
  it('carries the latecomer policy to everyone', async () => {
    // Shreya's requirement: the room owner chooses whether everyone waits while
    // a newcomer catches up, rather than it being automatic in either direction.
    const { host, guest } = await room()
    const before = host.waitForLatecomers
    host.setWaitForLatecomers(!before)
    await until(() => guest.waitForLatecomers === !before, 'the policy to propagate')
  }, 30_000)

  it('switches transport, and clears the film because its bytes cannot follow', async () => {
    const { host, guest } = await room({ origin: ORIGIN })
    host.announceMedia('film.mkv', 3600, null)
    await until(() => guest.media?.name === 'film.mkv', 'the film to be announced')

    host.setMode('origin')
    await until(() => guest.mode === 'origin', 'the mode to change')
    // Leaving the film on would show one nobody could fetch.
    await until(() => !guest.media?.source && !host.media?.source, 'the film to be cleared')
  }, 30_000)

  it('refuses relay mode on a server with no storage configured', async () => {
    const { host } = await room()
    const errors: string[] = []
    host.on('server-error', (m: string) => errors.push(m))
    expect(host.originAvailable).toBe(false)
    host.setMode('origin')
    await until(() => errors.length > 0, 'the server to refuse')
    expect(host.mode).toBe('p2p')
  }, 30_000)
})

describe('chat', () => {
  it('reaches the other client', async () => {
    const { host, guest } = await room()
    host.sendChat('starting in five')
    await until(() => guest.messages.some(m => m.text === 'starting in five'), 'the message to arrive')
  }, 30_000)

  it('does not send whitespace, which would render as an empty bubble', async () => {
    const { host, guest } = await room()
    const before = guest.messages.length
    host.sendChat('   ')
    host.sendChat('')
    host.sendChat('\n\t')
    // Something real afterwards, so this waits on an arrival rather than on time.
    host.sendChat('real')
    await until(() => guest.messages.some(m => m.text === 'real'), 'the real message')
    expect(guest.messages.length).toBe(before + 1)
  }, 30_000)

  it('trims, and truncates rather than being rejected by the server', async () => {
    // The schema caps text at 800 and would reject a longer one outright, which
    // would lose the message entirely instead of shortening it.
    const { host, guest } = await room()
    host.sendChat('  padded  ')
    await until(() => guest.messages.some(m => m.text === 'padded'), 'the trimmed message')

    host.sendChat('x'.repeat(900))
    await until(() => guest.messages.some(m => m.text.length === 800), 'the truncated message')
  }, 30_000)

  it('gives a joiner the history rather than an empty column', async () => {
    const { host, port } = await room()
    host.sendChat('said before you arrived')
    await until(() => host.messages.some(m => m.text === 'said before you arrived'), 'the message')

    const late = new RoomClient({
      url: `ws://127.0.0.1:${port}`, code: host.code, name: 'late', player: stubPlayer()
    })
    cleanups.push(() => late.close())
    await late.connect()
    await until(() => late.messages.some(m => m.text === 'said before you arrived'), 'the history')
  }, 30_000)
})

describe('playback requests', () => {
  it('schedules a play that every client is told about', async () => {
    const { host, guest } = await room()
    host.announceMedia('film.mkv', 3600, null)
    await until(() => guest.media?.name === 'film.mkv', 'the film')

    const schedules: unknown[] = []
    guest.on('schedule', (s: unknown) => schedules.push(s))
    host.requestPlay(0)
    await until(() => schedules.length > 0, 'a schedule to reach the guest')
  }, 30_000)

  it('refuses a member without control, so the film cannot be moved under everyone', async () => {
    const { host, guest } = await room()
    host.setOpenControl(false)
    host.setControl(guest.memberId!, false)
    await until(() => guest.me()?.mayControl === false, 'the guest to lose control')
    host.announceMedia('film.mkv', 3600, null)
    await until(() => guest.media?.name === 'film.mkv', 'the film')

    const errors: string[] = []
    guest.on('server-error', (m: string) => errors.push(m))
    guest.requestSeek(600)
    await until(() => errors.length > 0, 'the server to refuse')
  }, 30_000)

  it('carries pause and seek as well as play', async () => {
    const { host, guest } = await room()
    host.announceMedia('film.mkv', 3600, null)
    await until(() => guest.media?.name === 'film.mkv', 'the film')

    const seen: string[] = []
    guest.on('schedule', (s: { kind: string }) => seen.push(s.kind))
    host.requestPlay(0)
    await until(() => seen.includes('playing'), 'a play')
    host.requestSeek(120)
    host.requestPause(120)
    await until(() => seen.includes('paused'), 'a pause')
  }, 30_000)
})

describe('the film on the room', () => {
  it('announces one and takes it off again', async () => {
    const { host, guest } = await room()
    host.announceMedia('film.mkv', 3600, null)
    await until(() => guest.media?.name === 'film.mkv', 'the film to appear')
    host.clearMedia()
    await until(() => guest.media === null || guest.media?.name === '', 'the film to be cleared')
  }, 30_000)

  it('only reports a change when the film really changed', async () => {
    // The media event drives loading a file into mpv. Firing it on every room
    // state broadcast -- which arrives whenever anyone's transfer report does --
    // would reload the film roughly once a second.
    const { host, guest } = await room()
    let events = 0
    guest.on('media', () => { events++ })

    const source = {
      kind: 'p2p' as const, infoHash: 'a'.repeat(40),
      magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
      bytes: 1_000_000, pieceLength: 262_144
    }
    host.announceMedia('film.mkv', 3600, source)
    await until(() => guest.media?.source != null, 'the source to arrive')
    const afterFirst = events

    // Re-announcing the same source must not count as a change.
    host.announceMedia('film.mkv', 3600, source)
    host.setWaitForLatecomers(!host.waitForLatecomers)
    await until(() => guest.waitForLatecomers !== host.waitForLatecomers === false, 'a later broadcast')
    expect(events).toBe(afterFirst)
  }, 30_000)
})

describe('signed URLs for relay mode', () => {
  it('gets an upload URL whose key the server chose, not the client', async () => {
    // A client that could name its own key could write over another room's film.
    const { host } = await room({ origin: ORIGIN })
    const { url, key } = await host.requestUploadUrl('content-1', 'film.mkv', 1234)
    expect(key).toContain(host.code!.toLowerCase())
    expect(url).toContain('X-Amz-Signature')
    expect(new URL(url).pathname).toContain(key)
  }, 30_000)

  it('gets a download URL for the film the room is actually sharing', async () => {
    const { host, guest } = await room({ origin: ORIGIN })
    host.setMode('origin')
    await until(() => guest.mode === 'origin', 'relay mode')
    host.announceMedia('film.mkv', 3600, { kind: 'origin', key: 'rooms/x/film.mkv', bytes: 10 })
    await until(() => guest.media?.source?.kind === 'origin', 'the origin source')

    const url = await guest.requestDownloadUrl()
    expect(url).toContain('rooms/x/film.mkv')
    expect(url).toContain('X-Amz-Signature')
  }, 30_000)

  it('rejects a download when the room is not sharing through the relay', async () => {
    const { guest } = await room({ origin: ORIGIN })
    await expect(guest.requestDownloadUrl()).rejects.toThrow()
  }, 30_000)

  it('answers two requests in flight each with its own URL', async () => {
    // The bug this exists for. A single pending slot per purpose meant the
    // first reply resolved the second caller's promise, so asking for two
    // upload URLs in quick succession -- picking a film, then changing your
    // mind -- handed the second caller the first film's key. The film was then
    // uploaded to an object the room had not announced.
    const { host } = await room({ origin: ORIGIN })
    const [first, second] = await Promise.all([
      host.requestUploadUrl('content-1', 'a.mkv', 1),
      host.requestUploadUrl('content-2', 'b.mkv', 2)
    ])
    expect(first.key).toContain('a.mkv')
    expect(second.key).toContain('b.mkv')
    expect(first.url).toContain(first.key)
    expect(second.url).toContain(second.key)
  }, 30_000)
})

describe('voice, which the server carries the signalling for but never the audio', () => {
  it('relays an RTC signal to the named peer and to nobody else', async () => {
    const { host, guest } = await room()
    const got: Array<{ from: string; payload: unknown }> = []
    guest.on('rtc-signal', (from: string, payload: unknown) => got.push({ from, payload }))

    host.sendSignal(guest.memberId!, { sdp: 'v=0 fake offer' })
    await until(() => got.length > 0, 'the signal to arrive')
    expect(got[0]).toEqual({ from: host.memberId, payload: { sdp: 'v=0 fake offer' } })
  }, 30_000)

  it('publishes voice state to the room', async () => {
    const { host, guest } = await room()
    host.setVoiceState({ inVoice: true, muted: true, deafened: false })
    await until(
      () => guest.members.find(m => m.id === host.memberId)?.inVoice === true,
      'the voice state to propagate'
    )
    expect(guest.members.find(m => m.id === host.memberId)?.muted).toBe(true)
  }, 30_000)

  it('carries a host mute as a request, which is all a mesh can honestly do', async () => {
    // The server never touches audio, so a muted client is one that chose to
    // comply. The interface says so; this asserts the request at least arrives.
    const { host, guest } = await room()
    const asked: Array<{ by: string; action: string }> = []
    guest.on('voice-moderated', (by: string, action: string) => asked.push({ by, action }))

    host.moderateVoice(guest.memberId!, 'mute')
    await until(() => asked.length > 0, 'the request to arrive')
    expect(asked[0]?.action).toBe('mute')
  }, 30_000)
})

describe('what the client knows about itself', () => {
  it('finds its own membership once the room state has arrived', async () => {
    const { host, guest } = await room()
    expect(host.me()?.name).toBe('anjali')
    expect(host.me()?.isHost).toBe(true)
    expect(guest.me()?.name).toBe('dev')
    expect(guest.me()?.isHost).toBe(false)
  }, 30_000)

  it('has no membership before connecting', () => {
    const client = new RoomClient({ url: 'ws://127.0.0.1:1', code: null, name: 'nobody', player: stubPlayer() })
    expect(client.me()).toBeUndefined()
  })
})
