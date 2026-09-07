import { describe, it, expect, vi } from 'vitest'
import { createHandlers, type HandlerDeps, type PlayerLike, type RoomLike, type VideoLike } from '../src/main/handlers.js'

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
    expect(r.announceMedia).toHaveBeenCalledWith('dune.mkv', 120)
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
