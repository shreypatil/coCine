import { basename } from 'node:path'
import type { ChatMessage, Member } from '@cocine/protocol'
import type { Identity } from './identity.js'
import type { StoredFilm, TransferProgress } from '@cocine/client'
import { sourceId, type MediaSource, type RoomMode } from '@cocine/protocol'

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
  setVolume?: (percent: number) => Promise<void>
}

export interface VideoLike {
  player: PlayerLike | null
  suspend: () => void
  resume: () => void
  setSlot: (slot: Rect) => void
  bounds: () => Rect | null
}

export interface OverlayLike {
  setSlot: (slot: Rect) => void
  focus: () => void
  releaseFocus: () => void
}

export interface TransferLike {
  share: (filePath: string) => Promise<MediaSource>
  receive: (source: MediaSource) => Promise<{ path: string }>
  stop: (id: string) => Promise<void>
  progress: () => TransferProgress[]
}

export interface FilmStoreLike {
  list: () => Promise<StoredFilm[]>
  remove: (infoHash: string) => Promise<void>
  totalBytes: () => Promise<number>
  freeBytes: () => Promise<number>
}

export interface RoomLike {
  announceMedia: (name: string, durationSec: number, source?: MediaSource | null) => void
  setMode: (mode: RoomMode) => void
  mode: RoomMode
  originAvailable: boolean
  requestPlay: (positionSec?: number) => void
  requestPause: (positionSec?: number) => void
  requestSeek: (positionSec: number) => void
  sendChat: (text: string) => void
  setControl: (memberId: string, mayControl: boolean) => void
  transferHost: (memberId: string) => void
  startAnyway: () => void
  setWaitForLatecomers: (wait: boolean) => void
  sendSignal: (to: string, payload: unknown) => void
  setVoiceState: (v: { inVoice: boolean; muted: boolean; deafened: boolean }) => void
  moderateVoice: (memberId: string, action: 'mute' | 'unmute') => void
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
  getTransfer: () => TransferLike | null
  getOverlay?: () => OverlayLike | null
  getFilmStore: () => FilmStoreLike | null
  setSharedInfoHash?: (infoHash: string | null) => void
  log?: (message: string) => void
}

export function formatClock (seconds: number): string {
  const t = Math.max(0, Math.floor(seconds))
  return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60]
    .map(n => String(n).padStart(2, '0')).join(':')
}

/**
 * Turn a socket failure into something a person can act on.
 *
 * The raw errors are Node's, and "connect ECONNREFUSED 127.0.0.1:40689" tells
 * someone nothing about what to do -- least of all that the address came from a
 * setting they have never seen, saved on a previous run.
 */
export function explainConnectError (err: unknown, url: string): Error {
  const code = (err as { code?: string })?.code
  const message = err instanceof Error ? err.message : String(err)
  if (code === 'ECONNREFUSED') {
    return new Error(`Nothing is listening at ${url}. Is the server running? Check the address, or reset it to the default.`)
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new Error(`Could not find a server at ${url}. Check the address.`)
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    return new Error(`No answer from ${url}. It may be unreachable from this network.`)
  }
  if (/Invalid URL|invalid url/i.test(message)) {
    return new Error(`${url} is not a valid address. It should look like ws://host:8787`)
  }
  return new Error(`Could not join through ${url}: ${message}`)
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
  const loadInto = async (path: string): Promise<{ path: string; name: string; durationSec: number | null; infoHash: string | null }> => {
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

    // Sharing is what makes the film available to everyone else. Hashing runs
    // in chunks and measured at roughly 780 MB/s, so it does not need a worker
    // -- but it is still seconds on a large film, and a failure to share must
    // not stop the person who opened it from watching.
    let source: MediaSource | null = null
    const transfer = deps.getTransfer()
    if (transfer) {
      try {
        source = await transfer.share(path)
        deps.setSharedInfoHash?.(sourceId(source)!)
        log(`[film] sharing as ${sourceId(source)}`)
      } catch (err) {
        log(`[film] could not share: ${String(err)}`)
      }
    }
    deps.getRoom()?.announceMedia(basename(path), durationSec ?? 0, source)
    return { path, name: basename(path), durationSec, infoHash: sourceId(source) }
  }

  return {
    'video:slot': (slot: Rect) => {
      const video = deps.getVideo()
      video?.setSlot(slot)
      // The overlay is positioned inside the video rectangle, so it needs the
      // same measurement.
      deps.getOverlay?.()?.setSlot(slot)
      return video?.bounds() ?? null
    },

    /** Fullscreen only: hand the keyboard to the chat overlay. */
    'overlay:focus': () => {
      deps.getOverlay?.()?.focus()
      return { ok: true }
    },

    /** And hand it back, or the main window's shortcuts stay dead. */
    'overlay:releaseFocus': () => {
      deps.getOverlay?.()?.releaseFocus()
      return { ok: true }
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

    'films:list': async () => {
      const store = deps.getFilmStore()
      if (!store) return { films: [], usedBytes: 0, freeBytes: 0 }
      return { films: await store.list(), usedBytes: await store.totalBytes(), freeBytes: await store.freeBytes() }
    },

    'films:remove': async (infoHash: string) => {
      const store = deps.getFilmStore()
      if (!store) throw new Error('no film store')
      // Removing the film currently open would pull the file out from under
      // mpv, so refuse rather than produce a confusing playback failure.
      const open = deps.getMediaPath()
      const film = (await store.list()).find(f => f.infoHash.toLowerCase() === infoHash.toLowerCase())
      if (film && open && film.path === open) throw new Error('That film is open. Close it first.')
      // Stop fetching it first. A transfer still running writes bytes back into
      // the directory while it is being removed, and the film reappears.
      try { await deps.getTransfer()?.stop(infoHash) } catch { /* stopping is best effort */ }
      await store.remove(infoHash)
      log(`[films] removed ${infoHash}`)
    },

    /** Fetch a film the room is sharing that this machine does not have. */
    'film:receive': async (source: MediaSource) => {
      const transfer = deps.getTransfer()
      if (!transfer) throw new Error('transfer not ready')
      log(`[film] receiving ${sourceId(source)} (${(source.bytes / 1024 ** 3).toFixed(2)} GB)`)
      const { path } = await transfer.receive(source)
      return { path }
    },

    /** A null code creates a room; a code joins one. */
    'room:connect': async (o: { url: string; code: string | null; name: string }) => {
      const player = deps.getVideo()?.player
      if (!player) throw new Error('player not ready')
      await deps.getRoom()?.close()
      let room: RoomLike
      try {
        room = await deps.createRoom({ ...o, player })
      } catch (err) {
        throw explainConnectError(err, o.url)
      }
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

    /** Start although somebody is still buffering. The host's call to make. */
    'room:startAnyway': () => {
      const room = deps.getRoom()
      if (!room) throw new Error('not in a room')
      if (!room.me()?.isHost) throw new Error('only the host can start early')
      room.startAnyway()
    },

    /** Opaque WebRTC negotiation, relayed by the server to one member. */
    'voice:signal': (to: string, payload: unknown) => {
      deps.getRoom()?.sendSignal(to, payload)
    },

    'voice:state': (v: { inVoice: boolean; muted: boolean; deafened: boolean }) => {
      deps.getRoom()?.setVoiceState(v)
    },

    'voice:moderate': (memberId: string, action: 'mute' | 'unmute') => {
      const room = deps.getRoom()
      if (!room) throw new Error('not in a room')
      if (!room.me()?.isHost) throw new Error('only the host can mute other people')
      room.moderateVoice(memberId, action)
    },

    /**
     * Quieten the film while someone is talking. Chromium's echo canceller
     * cannot hear mpv -- it removes audio Chromium itself played, and mpv plays
     * through a different path entirely -- so on speakers the film would
     * otherwise be picked up by every microphone and sent back to the room.
     */
    'voice:duck': async (ducked: boolean) => {
      const player = deps.getVideo()?.player
      if (!player) return
      await player.setVolume?.(ducked ? 35 : 100)
    },

    /**
     * Peer-to-peer or relay. The host chooses, and the choice clears the
     * room's film -- the bytes live where only the previous transport can
     * reach them, so it has to be shared again.
     */
    'room:setMode': (mode: RoomMode) => {
      const room = deps.getRoom()
      if (!room) throw new Error('not in a room')
      if (!room.me()?.isHost) throw new Error('only the host can change how the film is shared')
      if (mode === 'origin' && !room.originAvailable) {
        throw new Error('this server has no relay storage configured')
      }
      room.setMode(mode)
      return { ok: true }
    },

    /** Whether the room pauses when someone arrives mid-film. */
    'room:setWaitForLatecomers': (wait: boolean) => {
      const room = deps.getRoom()
      if (!room) throw new Error('not in a room')
      if (!room.me()?.isHost) throw new Error('only the host can change that')
      room.setWaitForLatecomers(wait)
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
