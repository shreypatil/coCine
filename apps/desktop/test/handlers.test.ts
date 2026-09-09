import { describe, it, expect, vi } from 'vitest'
import { chromeOffset } from '../src/main/video-window.js'
import { createHandlers, explainConnectError, type HandlerDeps, type PlayerLike, type RoomLike, type VideoLike, type TransferLike, type FilmStoreLike } from '../src/main/handlers.js'

/**
 * Every case below reproduces a bug that actually shipped. None of them needs
 * Electron, a window, or a click.
 */

const player = (over: Partial<PlayerLike> = {}): PlayerLike => ({
  load: vi.fn(async () => {}),
  play: vi.fn(async () => {}),
  pause: vi.fn(async () => {}),
  seek: vi.fn(async () => {}),
  duration: () => 120,
  showText: vi.fn(async () => {}),
  unload: vi.fn(async () => {}),
  ...over
})

const video = (p: PlayerLike | null = player()): VideoLike => ({
  player: p,
  suspend: vi.fn(),
  resume: vi.fn(),
  setSlot: vi.fn(),
  setFilmOpen: vi.fn(),
  ensureVisible: vi.fn(),
  bounds: () => ({ x: 0, y: 0, width: 10, height: 10 })
})

// `kind` matters: it is what sourceId() reads to identify the film, so a
// fixture without it silently produced an undefined info hash.
const TORRENT = {
  kind: 'p2p' as const,
  infoHash: 'a'.repeat(40),
  magnet: 'magnet:?xt=urn:btih:' + 'a'.repeat(40),
  bytes: 4_000_000_000,
  pieceLength: 262144
}

const transfer = (over: Partial<TransferLike> = {}): TransferLike => ({
  share: vi.fn(async () => TORRENT),
  receive: vi.fn(async () => ({ path: '/films/aaa/dune.mkv' })),
  stop: vi.fn(async () => {}),
  progress: () => [],
  pieceMap: () => 'f'.repeat(64),
  setPaused: vi.fn(() => true),
  ...over
})

const filmStore = (over: Partial<FilmStoreLike> = {}): FilmStoreLike => ({
  list: vi.fn(async () => [{
    infoHash: 'a'.repeat(40), name: 'dune.mkv', path: '/films/aaa/dune.mkv',
    bytes: 100, onDiskBytes: 100, complete: true, addedAtMs: 1
  }]),
  remove: vi.fn(async () => {}),
  totalBytes: async () => 100,
  freeBytes: async () => 1_000_000,
  ...over
})

const room = (): RoomLike => ({
  announceMedia: vi.fn(),
  clearMedia: vi.fn(),
  requestPlay: vi.fn(),
  requestPause: vi.fn(),
  requestSeek: vi.fn(),
  close: vi.fn(async () => {}),
  memberId: 'm1'
})

function build (over: Partial<HandlerDeps> = {}): {
  h: Record<string, (...a: never[]) => unknown>
  deps: HandlerDeps
  win: object
} {
  const win = { id: 'main' }
  let mediaPath: string | null = null
  let currentRoom: RoomLike | null = null
  let fullscreen = false
  let sharing: 'off' | 'sharing' | 'paused' = 'off'
  let sharedInfoHash: string | null = null
  let announced = false
  let identity = {
    id: 'local-1', name: 'me', server: 'ws://127.0.0.1:8787',
    lastCode: null as string | null, lastFilmDir: null as string | null
  }
  const deps: HandlerDeps = {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/films/dune.mkv'] })),
    getWindow: () => win,
    getVideo: () => video(),
    getRoom: () => currentRoom,
    setRoom: r => { currentRoom = r },
    createRoom: vi.fn(async () => room()),
    getMediaPath: () => mediaPath,
    setMediaPath: p => { mediaPath = p },
    setFullScreen: on => { fullscreen = on },
    isFullScreen: () => fullscreen,
    getIdentity: () => identity,
    saveIdentity: patch => { identity = { ...identity, ...patch }; return identity },
    getTransfer: () => null,
    getSharing: () => sharing,
    setSharing: state => { sharing = state },
    getSharedInfoHash: () => sharedInfoHash,
    setSharedInfoHash: h => { sharedInfoHash = h },
    getAnnouncedByUs: () => announced,
    setAnnouncedByUs: v => { announced = v },
    getFilmStore: () => filmStore(),
    ...over
  }
  return { h: createHandlers(deps), deps, win }
}

const call = async (h: Record<string, (...a: never[]) => unknown>, ch: string, ...args: unknown[]): Promise<unknown> =>
  await (h[ch] as (...a: unknown[]) => unknown)(...args)

describe('file:open', () => {
  it('passes the parent window to the dialog', async () => {
    // Without a parent the dialog is not modal to the app and can open behind it.
    const v = video()
    const { h, deps, win } = build({ getVideo: () => v })
    await call(h, 'file:open')
    expect(deps.showOpenDialog).toHaveBeenCalledWith(win, expect.anything())
  })

  it('offers an All files filter as well as known video extensions', async () => {
    const { h, deps } = build()
    await call(h, 'file:open')
    const opts = (deps.showOpenDialog as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { filters: Array<{ extensions: string[] }> }
    expect(opts.filters.some(f => f.extensions.includes('*'))).toBe(true)
    expect(opts.filters.some(f => f.extensions.includes('mkv'))).toBe(true)
  })

  it('hides the video surface while the dialog is up and restores it after', async () => {
    const v = video()
    const { h } = build({ getVideo: () => v })
    await call(h, 'file:open')
    expect(v.suspend).toHaveBeenCalledOnce()
    expect(v.resume).toHaveBeenCalledOnce()
  })

  it('restores the video surface even when the dialog throws', async () => {
    const v = video()
    const { h } = build({
      getVideo: () => v,
      showOpenDialog: vi.fn(async () => { throw new Error('dialog exploded') })
    })
    await expect(call(h, 'file:open')).rejects.toThrow('dialog exploded')
    expect(v.resume).toHaveBeenCalledOnce()
  })

  it('loads nothing and returns null when dismissed', async () => {
    const p = player()
    const v = video(p)
    const { h } = build({
      getVideo: () => v,
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] }))
    })
    expect(await call(h, 'file:open')).toBeNull()
    expect(p.load).not.toHaveBeenCalled()
    expect(v.resume).toHaveBeenCalledOnce()
  })

  it('surfaces a load failure instead of swallowing it', async () => {
    const p = player({ load: vi.fn(async () => { throw new Error('unsupported codec') }) })
    const { h } = build({ getVideo: () => video(p) })
    await expect(call(h, 'file:open')).rejects.toThrow('unsupported codec')
  })

  it('tells the room nothing until sharing is asked for', async () => {
    // Opening a film and pushing gigabytes at other people are different
    // decisions, and used to be one action.
    const r = room()
    const { h } = build({ getVideo: () => video(), getRoom: () => r })
    await call(h, 'file:open')
    expect(r.announceMedia).not.toHaveBeenCalled()
  })
})

describe('sharing a film with the room, as a separate act', () => {
  /** Opening a film, then handing it over, which is now two steps. */
  const openThenShare = async (over: Partial<HandlerDeps> = {}): Promise<{
    h: Record<string, (...a: never[]) => unknown>; r: RoomLike; tx: TransferLike
  }> => {
    const r = room()
    const tx = transfer()
    const { h } = build({ getVideo: () => video(), getRoom: () => r, getTransfer: () => tx, ...over })
    await call(h, 'file:openPath', '/films/dune.mkv')
    return { h, r, tx }
  }

  it('hashes the film and tells the room where to get it', async () => {
    const { h, r, tx } = await openThenShare()
    expect(tx.share).not.toHaveBeenCalled()
    await call(h, 'film:share')
    expect(tx.share).toHaveBeenCalledWith('/films/dune.mkv')
    expect(r.announceMedia).toHaveBeenCalledWith('dune.mkv', 120, TORRENT)
  })

  it('keeps the film playing here when hashing fails, and says so', async () => {
    // Whoever opened the film should not lose it because sharing broke.
    const tx = transfer({ share: vi.fn(async () => { throw new Error('disk went away') }) })
    const r = room()
    const p = player()
    const { h } = build({ getVideo: () => video(p), getRoom: () => r, getTransfer: () => tx })
    await call(h, 'file:openPath', '/films/dune.mkv')
    await expect(call(h, 'film:share')).rejects.toThrow('disk went away')
    expect(p.load).toHaveBeenCalled()
    expect(r.announceMedia).not.toHaveBeenCalled()
  })

  it('refuses to announce a film the room cannot fetch', async () => {
    // It used to announce with a null source when there was no transport. The
    // room then showed everyone the film's name and its length with nothing to
    // download: a duration at the bottom of the window, "Nothing open" in the
    // panel, and a wait with no end. Saying no is more use than saying nothing.
    const r = room()
    const { h } = build({ getVideo: () => video(), getRoom: () => r, getTransfer: () => null })
    await call(h, 'file:openPath', '/films/dune.mkv')
    await expect(call(h, 'film:share')).rejects.toThrow(/Cannot share yet/)
    expect(r.announceMedia).not.toHaveBeenCalled()
  })

  it('refuses to share outside a room, in words rather than a crash', async () => {
    const { h } = build({ getVideo: () => video(), getRoom: () => null })
    await call(h, 'file:openPath', '/films/dune.mkv')
    await expect(call(h, 'film:share')).rejects.toThrow(/room/i)
  })

  it('refuses to share when no film is open', async () => {
    const { h } = build({ getVideo: () => video(), getRoom: () => room() })
    await expect(call(h, 'film:share')).rejects.toThrow(/No film/i)
  })

  it('pauses and resumes this machine\'s part in the swarm', async () => {
    const setPaused = vi.fn(() => true)
    const tx = transfer({ setPaused })
    const { h } = build({ getVideo: () => video(), getRoom: () => room(), getTransfer: () => tx })
    await call(h, 'file:openPath', '/films/dune.mkv')
    await call(h, 'film:share')
    await call(h, 'film:setSharingPaused', true)
    expect(setPaused).toHaveBeenCalledWith(TORRENT.infoHash, true)
    await call(h, 'film:setSharingPaused', false)
    expect(setPaused).toHaveBeenLastCalledWith(TORRENT.infoHash, false)
  })

  it('will not pause what is not being shared', async () => {
    const { h } = build({ getVideo: () => video(), getRoom: () => room(), getTransfer: () => transfer() })
    await call(h, 'file:openPath', '/films/dune.mkv')
    await expect(call(h, 'film:setSharingPaused', true)).rejects.toThrow(/not being shared/)
  })

  it('unloading stops the transfer and takes the film off the room', async () => {
    const tx = transfer()
    const r = room()
    const p = player()
    const { h, deps } = build({ getVideo: () => video(p), getRoom: () => r, getTransfer: () => tx })
    await call(h, 'file:openPath', '/films/dune.mkv')
    await call(h, 'film:share')
    await call(h, 'film:unload')
    expect(tx.stop).toHaveBeenCalledWith(TORRENT.infoHash)
    expect(r.clearMedia).toHaveBeenCalledOnce()
    expect(p.unload).toHaveBeenCalledOnce()
    expect(deps.getMediaPath()).toBeNull()
  })

  it('leaves the room\'s film alone when unloading one merely received', async () => {
    // Somebody who was receiving a film does not get to take it off everybody
    // else's room by closing their own copy.
    const tx = transfer()
    const r = room()
    const { h } = build({
      getVideo: () => video(), getRoom: () => r, getTransfer: () => tx,
      getAnnouncedByUs: () => false,
      getSharedInfoHash: () => TORRENT.infoHash,
      getSharing: () => 'sharing'
    })
    await call(h, 'film:unload')
    expect(tx.stop).toHaveBeenCalledWith(TORRENT.infoHash)
    expect(r.clearMedia).not.toHaveBeenCalled()
  })
})

describe('films on disk', () => {
  it('lists what is stored, with space used and free', async () => {
    const { h } = build()
    const r = await call(h, 'films:list') as { films: unknown[]; usedBytes: number; freeBytes: number }
    expect(r.films).toHaveLength(1)
    expect(r.usedBytes).toBe(100)
    expect(r.freeBytes).toBe(1_000_000)
  })

  it('removes a film', async () => {
    const store = filmStore()
    const { h } = build({ getFilmStore: () => store })
    await call(h, 'films:remove', 'a'.repeat(40))
    expect(store.remove).toHaveBeenCalledWith('a'.repeat(40))
  })

  it('refuses to delete the film that is currently open', async () => {
    // Otherwise the file disappears from under mpv mid-playback.
    const store = filmStore()
    const { h } = build({ getVideo: () => video(), getFilmStore: () => store })
    await call(h, 'file:openPath', '/films/aaa/dune.mkv')
    await expect(call(h, 'films:remove', 'a'.repeat(40))).rejects.toThrow(/open/)
    expect(store.remove).not.toHaveBeenCalled()
  })

  it('reports an empty library rather than failing when nothing is stored', async () => {
    const { h } = build({ getFilmStore: () => null })
    expect(await call(h, 'films:list')).toEqual({ films: [], usedBytes: 0, freeBytes: 0 })
  })
})

describe('receiving a film the room is sharing', () => {
  it('asks the transfer manager for it', async () => {
    const tx = transfer()
    const { h } = build({ getTransfer: () => tx })
    expect(await call(h, 'film:receive', TORRENT)).toEqual({ path: '/films/aaa/dune.mkv' })
    expect(tx.receive).toHaveBeenCalledWith(TORRENT)
  })

  it('refuses clearly when transfer is not available', async () => {
    const { h } = build({ getTransfer: () => null })
    await expect(call(h, 'film:receive', TORRENT)).rejects.toThrow(/transfer not ready/)
  })
})

describe('file:openPath', () => {
  it('loads without going near a dialog', async () => {
    const p = player()
    const { h, deps } = build({ getVideo: () => video(p) })
    const r = await call(h, 'file:openPath', '/films/arrival.mp4') as { name: string }
    expect(p.load).toHaveBeenCalledWith('/films/arrival.mp4')
    expect(deps.showOpenDialog).not.toHaveBeenCalled()
    expect(r.name).toBe('arrival.mp4')
  })
})

describe('playback', () => {
  it('awaits the player so a failure reaches the caller', async () => {
    // These were written as `void player.play()`, which returned immediately
    // and discarded both the promise and any error.
    const p = player({ play: vi.fn(async () => { throw new Error('mpv is gone') }) })
    const { h } = build({ getVideo: () => video(p) })
    await expect(call(h, 'playback:play')).rejects.toThrow('mpv is gone')
  })

  it('routes through the room when connected, never straight to the player', async () => {
    const p = player()
    const r = room()
    const { h } = build({ getVideo: () => video(p), getRoom: () => r })
    await call(h, 'playback:play')
    await call(h, 'playback:seek', 42)
    expect(r.requestPlay).toHaveBeenCalledOnce()
    expect(r.requestSeek).toHaveBeenCalledWith(42)
    expect(p.play).not.toHaveBeenCalled()
    expect(p.seek).not.toHaveBeenCalled()
  })

  it('drives the player directly when not in a room', async () => {
    const p = player()
    const { h } = build({ getVideo: () => video(p) })
    await call(h, 'playback:pause')
    expect(p.pause).toHaveBeenCalledOnce()
  })
})

describe('explaining why a connection failed', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:40689'), { code: 'ECONNREFUSED' })

  it('says what to do about a dead address, not what errno it was', async () => {
    // The address usually came from a setting saved on a previous run, which
    // the person has never seen. "ECONNREFUSED" tells them nothing.
    const e = explainConnectError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'ws://box.example:8787')
    expect(e.message).toContain('ws://box.example:8787')
    expect(e.message).toMatch(/Is the server running/)
    expect(e.message).not.toMatch(/ECONNREFUSED|errno/)
    void refused
  })

  it('distinguishes a name it cannot resolve from one that refused', () => {
    const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND nope'), { code: 'ENOTFOUND' })
    expect(explainConnectError(notFound, 'ws://nope:8787').message).toMatch(/Could not find a server/)
    const timeout = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
    expect(explainConnectError(timeout, 'ws://x:8787').message).toMatch(/unreachable/)
  })

  it('catches an address that is not an address at all', () => {
    expect(explainConnectError(new Error('Invalid URL'), 'not-a-url').message)
      .toMatch(/should look like ws:\/\/host:8787/)
  })

  it('reaches the interface instead of a raw socket error', async () => {
    const { h } = build({
      getVideo: () => video(),
      createRoom: vi.fn(async () => { throw refused })
    })
    await expect(call(h, 'room:connect', { url: 'ws://127.0.0.1:40689', code: null, name: 'shreya' }))
      .rejects.toThrow(/Nothing is listening/)
  })

  it('does not remember an address that could not be reached', async () => {
    const { h, deps } = build({
      getVideo: () => video(),
      createRoom: vi.fn(async () => { throw refused })
    })
    await expect(call(h, 'room:connect', { url: 'ws://127.0.0.1:40689', code: null, name: 'shreya' })).rejects.toThrow()
    expect(deps.getIdentity().server).toBe('ws://127.0.0.1:8787')
  })
})

describe('identity', () => {
  it('hands back what was stored', async () => {
    const { h } = build()
    expect(await call(h, 'identity:get')).toMatchObject({ name: 'me', server: 'ws://127.0.0.1:8787' })
  })

  it('remembers name, server and room only after connecting succeeds', async () => {
    const r = room()
    const { h, deps } = build({ getVideo: () => video(), createRoom: vi.fn(async () => ({ ...r, code: 'BCDFGHJK' })) })
    await call(h, 'room:connect', { url: 'ws://box:9000', code: null, name: 'anjali' })
    expect(deps.getIdentity()).toMatchObject({ name: 'anjali', server: 'ws://box:9000', lastCode: 'BCDFGHJK' })
  })

  it('does not remember a server address that failed to connect', async () => {
    // Otherwise a typo becomes what greets you on every future launch.
    const { h, deps } = build({
      getVideo: () => video(),
      createRoom: vi.fn(async () => { throw new Error('ECONNREFUSED') })
    })
    await expect(call(h, 'room:connect', { url: 'ws://typo:9000', code: null, name: 'anjali' })).rejects.toThrow()
    expect(deps.getIdentity().server).toBe('ws://127.0.0.1:8787')
    expect(deps.getIdentity().name).toBe('me')
  })
})

describe('window:fullscreen', () => {
  it('toggles when given no argument', async () => {
    const { h } = build()
    expect(await call(h, 'window:fullscreen')).toBe(true)
    expect(await call(h, 'window:fullscreen')).toBe(false)
  })

  it('honours an explicit value', async () => {
    const { h } = build()
    expect(await call(h, 'window:fullscreen', false)).toBe(false)
    expect(await call(h, 'window:fullscreen', true)).toBe(true)
  })

  it('shows the keyboard hint on the video when entering fullscreen', async () => {
    // Fullscreen has no visible controls, so the player itself has to say what
    // the keys are. Nothing can be drawn over the video by any other means.
    const p = player()
    const { h } = build({ getVideo: () => video(p) })
    await call(h, 'window:fullscreen', true)
    expect(p.showText).toHaveBeenCalledWith(expect.stringContaining('Esc'), expect.any(Number))
  })
})

describe('on-screen feedback', () => {
  it('reports play and pause on the video while fullscreen', async () => {
    const p = player()
    let fs = true
    const { h } = build({ getVideo: () => video(p), isFullScreen: () => fs, setFullScreen: on => { fs = on } })
    await call(h, 'playback:play')
    expect(p.showText).toHaveBeenCalledWith('Play', expect.any(Number))
  })

  it('stays silent when windowed, where the controls already show it', async () => {
    const p = player()
    const { h } = build({ getVideo: () => video(p), isFullScreen: () => false })
    await call(h, 'playback:play')
    expect(p.showText).not.toHaveBeenCalled()
  })

  it('survives a player that cannot draw text', async () => {
    const p = player({ showText: vi.fn(async () => { throw new Error('no osd') }) })
    const { h } = build({ getVideo: () => video(p), isFullScreen: () => true })
    await expect(call(h, 'playback:play')).resolves.toBeUndefined()
  })
})

describe('room:connect', () => {
  it('refuses before the player exists rather than failing obscurely later', async () => {
    const { h } = build({ getVideo: () => video(null) })
    await expect(call(h, 'room:connect', { url: 'ws://x', roomCode: 'r', name: 'n' }))
      .rejects.toThrow('player not ready')
  })

  it('announces a film that was already open when joining', async () => {
    const r = room()
    const { h } = build({ getVideo: () => video(), createRoom: vi.fn(async () => r) })
    await call(h, 'file:openPath', '/films/solaris.mkv')
    await call(h, 'room:connect', { url: 'ws://x', roomCode: 'r', name: 'n' })
    expect(r.announceMedia).toHaveBeenCalledWith('solaris.mkv', 120)
  })
})

const overlay = (): {
  setSlot: ReturnType<typeof vi.fn>; setShape: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
} => ({ setSlot: vi.fn(), setShape: vi.fn(), send: vi.fn() })

/** A room this client hosts, which is what the settings below all require. */
const hosted = (over: Partial<RoomLike> = {}): RoomLike => ({
  ...room(),
  me: () => ({ id: 'm1', name: 'me', isHost: true, mayControl: true, inVoice: false, muted: false, deafened: false }),
  setOpenControl: vi.fn(),
  ...over
} as RoomLike)

describe('the fullscreen chat overlay', () => {
  it('is given the video rectangle, because it is positioned inside it', async () => {
    const o = overlay()
    const { h } = build({ getOverlay: () => o })
    await call(h, 'video:slot', { x: 4, y: 5, width: 600, height: 400 })
    expect(o.setSlot).toHaveBeenCalledWith({ x: 4, y: 5, width: 600, height: 400 })
  })

  it('passes the reported bubbles through, so the film shows everywhere else', async () => {
    const o = overlay()
    const { h } = build({ getOverlay: () => o })
    const rects = [{ x: 10, y: 300, width: 220, height: 40 }]
    await call(h, 'overlay:shape', rects)
    expect(o.setShape).toHaveBeenCalledWith(rects)
  })

  it('treats a missing shape as no shape rather than passing rubbish to X', async () => {
    const o = overlay()
    const { h } = build({ getOverlay: () => o })
    await call(h, 'overlay:shape', undefined)
    expect(o.setShape).toHaveBeenCalledWith([])
  })

  it('carries what the main window is typing over to be drawn', async () => {
    // The overlay cannot hold the text field itself: it is reparented into the
    // main window, so the window manager will not focus it, and the composer
    // that used to live there dropped every keystroke while looking ready.
    const o = overlay()
    const { h } = build({ getOverlay: () => o })
    await call(h, 'overlay:draft', 'half a sen')
    expect(o.send).toHaveBeenCalledWith('overlay:draft', 'half a sen')
  })

  it('closes the drawn composer when the field goes away', async () => {
    const o = overlay()
    const { h } = build({ getOverlay: () => o })
    await call(h, 'overlay:draft', null)
    expect(o.send).toHaveBeenCalledWith('overlay:draft', null)
  })
})

describe('the options a host chooses while creating a room', () => {
  it('carries them to the room being created', async () => {
    const createRoom = vi.fn(async () => room())
    const { h } = build({ createRoom })
    await call(h, 'room:connect', {
      url: 'ws://x', code: null, name: 'anjali',
      options: { mode: 'origin', openControl: false, waitForLatecomers: false }
    })
    expect(createRoom).toHaveBeenCalledWith(expect.objectContaining({
      options: { mode: 'origin', openControl: false, waitForLatecomers: false }
    }))
  })

  it('lets the host change who may control playback afterwards', async () => {
    const r = hosted()
    const { h } = build({ getRoom: () => r })
    await call(h, 'room:setOpenControl', false)
    expect(r.setOpenControl).toHaveBeenCalledWith(false)
  })

  it('refuses that to anybody who is not the host', async () => {
    const r = hosted({
      me: () => ({ id: 'm1', name: 'me', isHost: false, mayControl: true, inVoice: false, muted: false, deafened: false })
    })
    const { h } = build({ getRoom: () => r })
    await expect(call(h, 'room:setOpenControl', false)).rejects.toThrow('only the host')
    expect(r.setOpenControl).not.toHaveBeenCalled()
  })
})

describe('placing the native video surface', () => {
  // The bug: Electron counts a Linux menu bar as part of the window's content,
  // while the page's coordinates start below it, so the video was drawn about
  // thirty pixels too high -- straight over the room code.
  it('finds the gap between the window content and the page', () => {
    expect(chromeOffset({ width: 1000, height: 800 }, { width: 1000, height: 772 }, 1)).toEqual({ x: 0, y: 28 })
  })

  it('finds nothing to correct when the page fills the content', () => {
    expect(chromeOffset({ width: 1000, height: 800 }, { width: 1000, height: 800 }, 1)).toEqual({ x: 0, y: 0 })
  })

  it('works in display pixels, not CSS ones', () => {
    expect(chromeOffset({ width: 2000, height: 1600 }, { width: 1000, height: 786 }, 2)).toEqual({ x: 0, y: 28 })
  })

  it('ignores a measurement that cannot be right rather than moving the video', () => {
    expect(chromeOffset({ width: 1000, height: 800 }, { width: 1000, height: 100 }, 1)).toEqual({ x: 0, y: 0 })
    expect(chromeOffset({ width: 1000, height: 800 }, undefined, 1)).toEqual({ x: 0, y: 0 })
    expect(chromeOffset({ width: 1000, height: 800 }, { width: 0, height: 0 }, 1)).toEqual({ x: 0, y: 0 })
  })
})

describe('browsing for a film without the system dialog', () => {
  // Electron's fallback GTK chooser reports a double-click on a file as a
  // cancellation, so on Linux the system dialog cannot open a film at all.
  it('starts where the last film came from, with places to jump to', async () => {
    const { h } = build({
      getHome: () => '/home/anjali',
      getIdentity: () => ({ id: 'i', name: 'anjali', server: 'ws://x', lastCode: null, lastFilmDir: '/films' })
    })
    const start = await call(h, 'browse:start') as { path: string; places: unknown[] }
    // The folder only counts if it is still there; this one is not, so home.
    expect(start.path).toBe('/home/anjali')
    expect(Array.isArray(start.places)).toBe(true)
  })

  it('remembers the folder a film was opened from', async () => {
    const { h, deps } = build()
    await call(h, 'file:openPath', '/films/scifi/solaris.mkv')
    expect(deps.getIdentity().lastFilmDir).toBe('/films/scifi')
  })

  it('hides the video surface while the picker is up, and restores it after', async () => {
    // The surface floats above the window's content, so a panel drawn over the
    // video area is invisible until it is out of the way.
    const v = video()
    const { h } = build({ getVideo: () => v })
    await call(h, 'browse:active', true)
    expect(v.suspend).toHaveBeenCalledOnce()
    await call(h, 'browse:active', false)
    expect(v.resume).toHaveBeenCalledOnce()
  })
})

describe('explaining a connection that failed', () => {
  it('tells someone who was sent a link what to do about the default address', () => {
    // A fresh install points at this machine until told otherwise, and
    // "connection refused" means nothing to the person who followed a link.
    const e = explainConnectError({ code: 'ECONNREFUSED' }, 'ws://127.0.0.1:8787')
    expect(e.message).toContain('this machine')
    expect(e.message).toMatch(/invited you/)
  })

  it('keeps the plainer message for a real address', () => {
    const e = explainConnectError({ code: 'ECONNREFUSED' }, 'ws://cocine.example:8787')
    expect(e.message).toContain('Is the server running?')
    expect(e.message).not.toContain('this machine')
  })
})

describe('showing the video surface', () => {
  it('shows it before mpv opens the file, not after', async () => {
    // mpv draws into that window. Loading into one that is still hidden is a
    // film with sound and no picture.
    const order: string[] = []
    const p = player({ load: vi.fn(async () => { order.push('load') }) })
    const v = video(p)
    v.setFilmOpen = vi.fn(() => { order.push('show') })
    const { h } = build({ getVideo: () => v })
    await call(h, 'file:openPath', '/films/dune.mkv')
    expect(order).toEqual(['show', 'load'])
  })

  it('puts it away again when the film will not open', async () => {
    const p = player({ load: vi.fn(async () => { throw new Error('not a film') }) })
    const v = video(p)
    const { h } = build({ getVideo: () => v })
    await expect(call(h, 'file:openPath', '/films/broken.mkv')).rejects.toThrow('not a film')
    // Last word: hidden, so the interface shows its empty state rather than a
    // black rectangle over nothing.
    const calls = (v.setFilmOpen as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.at(-1)).toEqual([false])
  })
})

describe('unloading a film, from every state it can be in', () => {
  /** The single path everything local goes through; index.ts owns the real one. */
  const withCloseFilm = (over: Partial<HandlerDeps> = {}): {
    h: Record<string, (...a: never[]) => unknown>; closed: ReturnType<typeof vi.fn>; r: RoomLike
  } => {
    const closed = vi.fn(async () => {})
    const r = room()
    const { h } = build({ getRoom: () => r, closeFilm: closed, ...over })
    return { h, closed, r }
  }

  it('takes the film off the room when this machine put it there', async () => {
    const { h, closed, r } = withCloseFilm({ getAnnouncedByUs: () => true })
    await call(h, 'film:unload')
    expect(r.clearMedia).toHaveBeenCalledOnce()
    expect(closed).toHaveBeenCalledOnce()
  })

  it('leaves the room\'s film alone when this machine was only receiving it', async () => {
    // Closing your own copy does not get to end everybody else's film.
    const { h, closed, r } = withCloseFilm({ getAnnouncedByUs: () => false })
    await call(h, 'film:unload')
    expect(r.clearMedia).not.toHaveBeenCalled()
    expect(closed).toHaveBeenCalledOnce()
  })

  it('still clears everything locally when the room refuses', async () => {
    // A server that says no, or a connection that has gone, must not leave a
    // film half-open on this machine.
    const r = room()
    r.clearMedia = vi.fn(() => { throw new Error('not your film') })
    const closed = vi.fn(async () => {})
    const { h } = build({ getRoom: () => r, closeFilm: closed, getAnnouncedByUs: () => true })
    await expect(call(h, 'film:unload')).resolves.toEqual({ ok: true })
    expect(closed).toHaveBeenCalledOnce()
  })

  it('is safe with no room at all', async () => {
    const closed = vi.fn(async () => {})
    const { h } = build({ getRoom: () => null, closeFilm: closed })
    await expect(call(h, 'film:unload')).resolves.toEqual({ ok: true })
    expect(closed).toHaveBeenCalledOnce()
  })

  it('is safe to do twice', async () => {
    const { h, closed } = withCloseFilm()
    await call(h, 'film:unload')
    await call(h, 'film:unload')
    expect(closed).toHaveBeenCalledTimes(2)
  })

  it('falls back to clearing in place when nothing supplies the shared path', async () => {
    // The older wiring, still exercised by tests that build deps by hand.
    const tx = transfer()
    const p = player()
    const { h, deps } = build({
      getVideo: () => video(p), getRoom: () => room(), getTransfer: () => tx,
      getSharedInfoHash: () => TORRENT.infoHash
    })
    await call(h, 'film:unload')
    expect(tx.stop).toHaveBeenCalledWith(TORRENT.infoHash)
    expect(p.unload).toHaveBeenCalledOnce()
    expect(deps.getMediaPath()).toBeNull()
  })
})
