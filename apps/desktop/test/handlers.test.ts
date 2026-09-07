import { describe, it, expect, vi } from 'vitest'
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
  ...over
})

const video = (p: PlayerLike | null = player()): VideoLike => ({
  player: p,
  suspend: vi.fn(),
  resume: vi.fn(),
  setSlot: vi.fn(),
  bounds: () => ({ x: 0, y: 0, width: 10, height: 10 })
})

const TORRENT = { infoHash: 'a'.repeat(40), magnet: 'magnet:?xt=urn:btih:' + 'a'.repeat(40), bytes: 4_000_000_000, pieceLength: 262144 }

const transfer = (over: Partial<TransferLike> = {}): TransferLike => ({
  share: vi.fn(async () => TORRENT),
  receive: vi.fn(async () => ({ path: '/films/aaa/dune.mkv' })),
  progress: () => [],
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
  let identity = { id: 'local-1', name: 'me', server: 'ws://127.0.0.1:8787', lastCode: null as string | null }
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

  it('announces the film to the room once one is connected', async () => {
    const r = room()
    const { h } = build({ getVideo: () => video(), getRoom: () => r })
    await call(h, 'file:open')
    expect(r.announceMedia).toHaveBeenCalledWith('dune.mkv', 120, null)
  })
})

describe('sharing what you open', () => {
  it('shares the film and tells the room where to get it', async () => {
    const tx = transfer()
    const r = room()
    const { h } = build({ getVideo: () => video(), getRoom: () => r, getTransfer: () => tx })
    await call(h, 'file:openPath', '/films/dune.mkv')
    expect(tx.share).toHaveBeenCalledWith('/films/dune.mkv')
    expect(r.announceMedia).toHaveBeenCalledWith('dune.mkv', 120, TORRENT)
  })

  it('still lets you watch when sharing fails', async () => {
    // Whoever opened the film should not lose it because hashing broke.
    const tx = transfer({ share: vi.fn(async () => { throw new Error('disk went away') }) })
    const r = room()
    const p = player()
    const { h } = build({ getVideo: () => video(p), getRoom: () => r, getTransfer: () => tx })
    const res = await call(h, 'file:openPath', '/films/dune.mkv') as { infoHash: string | null }
    expect(p.load).toHaveBeenCalled()
    expect(res.infoHash).toBeNull()
    expect(r.announceMedia).toHaveBeenCalledWith('dune.mkv', 120, null)
  })

  it('announces without a torrent when there is nothing to share through', async () => {
    const r = room()
    const { h } = build({ getVideo: () => video(), getRoom: () => r, getTransfer: () => null })
    await call(h, 'file:openPath', '/films/dune.mkv')
    expect(r.announceMedia).toHaveBeenCalledWith('dune.mkv', 120, null)
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
    const e = explainConnectError(refused, 'ws://127.0.0.1:40689')
    expect(e.message).toContain('ws://127.0.0.1:40689')
    expect(e.message).toMatch(/Is the server running/)
    expect(e.message).not.toMatch(/ECONNREFUSED|errno/)
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
      .rejects.toThrow(/Is the server running/)
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
