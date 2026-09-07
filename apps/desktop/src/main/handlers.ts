import { basename } from 'node:path'
import type { ChatMessage, Member } from '@cocine/protocol'
import type { Identity } from './identity.js'

/**
 * Every IPC handler, as plain functions over injected dependencies.
 *
 * Extracted from index.ts specifically so it can be tested without launching
 * Electron. The bugs this file has already shipped — a dialog with no parent
 * window, a load failure swallowed by `void`, an unawaited promise that killed
 * the process — were all reachable from here with nothing running.
 */

export interface PlayerLike {
  load: (path: string) => Promise<void>
  play: () => Promise<void>
  pause: () => Promise<void>
  seek: (seconds: number) => Promise<void>
  duration: () => number | null
  showText: (text: string, durationMs?: number) => Promise<void>
}

export interface VideoLike {
  player: PlayerLike | null
  suspend: () => void
  resume: () => void
  setSlot: (slot: Rect) => void
  bounds: () => Rect | null
}

export interface RoomLike {
  announceMedia: (name: string, durationSec: number) => void
  requestPlay: (positionSec?: number) => void
  requestPause: (positionSec?: number) => void
  requestSeek: (positionSec: number) => void
  sendChat: (text: string) => void
  setControl: (memberId: string, mayControl: boolean) => void
  transferHost: (memberId: string) => void
  me: () => Member | undefined
  close: () => Promise<void>
  memberId: string
  code: string
  members: Member[]
  messages: ChatMessage[]
}

export interface Rect { x: number; y: number; width: number; height: number }

export interface OpenDialogResult { canceled: boolean; filePaths: string[] }

export interface HandlerDeps {
  showOpenDialog: (parent: unknown, options: Record<string, unknown>) => Promise<OpenDialogResult>
  getWindow: () => unknown | null
  getVideo: () => VideoLike | null
  getRoom: () => RoomLike | null
  setRoom: (room: RoomLike | null) => void
  createRoom: (o: { url: string; code: string | null; name: string; player: PlayerLike }) => Promise<RoomLike>
  getMediaPath: () => string | null
  setMediaPath: (path: string | null) => void
  setFullScreen: (on: boolean) => void
  isFullScreen: () => boolean
  getIdentity: () => Identity
  saveIdentity: (patch: Partial<Omit<Identity, 'id'>>) => Identity
  log?: (message: string) => void
}

export function formatClock (seconds: number): string {
  const t = Math.max(0, Math.floor(seconds))
  return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60]
    .map(n => String(n).padStart(2, '0')).join(':')
}

export const VIDEO_EXTENSIONS = ['mkv', 'mp4', 'avi', 'mov', 'webm', 'm4v', 'ts', 'mpg', 'mpeg', 'wmv', 'flv', 'ogv']

export function createHandlers (deps: HandlerDeps): Record<string, (...args: never[]) => unknown> {
  const log = deps.log ?? (() => {})

  /**
   * In fullscreen there are no visible controls -- nothing can be drawn over
   * the video until the overlay window exists -- so the player itself reports
   * what just happened. Silent when windowed, where the controls already show it.
   */
  const announce = async (text: string): Promise<void> => {
    if (!deps.isFullScreen()) return
    await deps.getVideo()?.player?.showText(text, 1200).catch(() => {})
  }

  /** Shared by the dialog and by drag-and-drop, so both behave identically. */
  const loadInto = async (path: string): Promise<{ path: string; name: string; durationSec: number | null }> => {
    const video = deps.getVideo()
    if (!video?.player) throw new Error('player not ready')
    try {
      await video.player.load(path)
    } catch (err) {
      log(`[film] failed to load: ${String(err)}`)
      throw err instanceof Error ? err : new Error(String(err))
    }
    deps.setMediaPath(path)
    const durationSec = video.player.duration()
    log(`[film] loaded ${basename(path)} · duration ${durationSec ?? 'unknown'}`)
    deps.getRoom()?.announceMedia(basename(path), durationSec ?? 0)
    return { path, name: basename(path), durationSec }
  }

  return {
    'video:slot': (slot: Rect) => {
      const video = deps.getVideo()
      video?.setSlot(slot)
      return video?.bounds() ?? null
    },

    'file:open': async () => {
      log('[film] open requested — showing dialog')
      const win = deps.getWindow()
      if (!win) throw new Error('no window')
      const video = deps.getVideo()
      // The video surface is a native child window: it floats above its parent
      // and ignores the parent's modality, so without hiding it the dialog can
      // open behind the video and look like the app refusing to yield focus.
      video?.suspend()
      try {
        const r = await deps.showOpenDialog(win, {
          title: 'Choose a film',
          properties: ['openFile'],
          filters: [
            { name: 'Video', extensions: VIDEO_EXTENSIONS },
            { name: 'All files', extensions: ['*'] }
          ]
        })
        if (r.canceled || !r.filePaths[0]) {
          log('[film] dialog dismissed without a selection')
          return null
        }
        log(`[film] loading ${r.filePaths[0]}`)
        return await loadInto(r.filePaths[0])
      } finally {
        // Must run even when the dialog throws, or the video never comes back.
        video?.resume()
      }
    },

    'file:openPath': async (path: string) => {
      log(`[film] loading (dropped) ${path}`)
      return await loadInto(path)
    },

    'identity:get': () => deps.getIdentity(),

    /** A null code creates a room; a code joins one. */
    'room:connect': async (o: { url: string; code: string | null; name: string }) => {
      const player = deps.getVideo()?.player
      if (!player) throw new Error('player not ready')
      await deps.getRoom()?.close()
      const room = await deps.createRoom({ ...o, player })
      deps.setRoom(room)
      // Only remembered once the connection succeeded, so a typo in the server
      // address is not what greets you next launch.
      deps.saveIdentity({ name: o.name, server: o.url, lastCode: room.code })
      const mediaPath = deps.getMediaPath()
      if (mediaPath) room.announceMedia(basename(mediaPath), player.duration() ?? 0)
      return { memberId: room.memberId, code: room.code }
    },

    'chat:send': (text: string) => {
      const room = deps.getRoom()
      if (!room) throw new Error('not in a room')
      room.sendChat(text)
    },

    'member:setControl': (memberId: string, mayControl: boolean) => {
      const room = deps.getRoom()
      if (!room) throw new Error('not in a room')
      // The server enforces this too; refusing here just avoids a pointless
      // round trip and a confusing error banner.
      if (!room.me()?.isHost) throw new Error('only the host can change playback control')
      room.setControl(memberId, mayControl)
    },

    'member:transferHost': (memberId: string) => {
      const room = deps.getRoom()
      if (!room) throw new Error('not in a room')
      if (!room.me()?.isHost) throw new Error('only the host can hand over hosting')
      room.transferHost(memberId)
    },

    'room:disconnect': async () => {
      await deps.getRoom()?.close()
      deps.setRoom(null)
    },

    // Outside a room these drive the player directly. Awaited rather than fired
    // and forgotten, so a failure reaches the interface instead of vanishing.
    'playback:play': async () => {
      const room = deps.getRoom()
      if (room) room.requestPlay()
      else await deps.getVideo()?.player?.play()
      await announce('Play')
    },
    'playback:pause': async () => {
      const room = deps.getRoom()
      if (room) room.requestPause()
      else await deps.getVideo()?.player?.pause()
      await announce('Paused')
    },
    'playback:seek': async (sec: number) => {
      const room = deps.getRoom()
      if (room) room.requestSeek(sec)
      else await deps.getVideo()?.player?.seek(sec)
      await announce(`→ ${formatClock(sec)}`)
    },

    'window:fullscreen': async (on?: boolean) => {
      const next = on ?? !deps.isFullScreen()
      deps.setFullScreen(next)
      if (next) {
        await deps.getVideo()?.player
          ?.showText('Space play · ← → seek · Esc exit', 2600)
          .catch(() => {})
      }
      return next
    }
  }
}
