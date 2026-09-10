import { basename, dirname, join } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { isSubtitleFile, isUnsupportedSubtitleFile } from '@cocine/player'
import { listDirectory, placesFor, startDirectory, type Listing } from './browse.js'
import type { ChatMessage, Member } from '@cocine/protocol'
import type { Identity } from './identity.js'
import type { StoredFilm, TransferProgress } from '@cocine/client'
import { sourceId, type MediaSource, type RoomMode, type RoomOptions } from '@cocine/protocol'

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
  unload?: () => Promise<void>
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
  setFilmOpen?: (open: boolean) => void
  ensureVisible?: () => void
  /** Which player is running; only the <video> one needs conversion. */
  engine?: 'mpv' | 'html'
  setSlot: (slot: Slot) => void
  bounds: () => Rect | null
}

export interface OverlayLike {
  setSlot: (slot: Slot) => void
  /** The parts of the overlay window that should exist at all; everything
   *  else is cut away so the film shows through. */
  setShape: (rects: Rect[]) => void
  /** Push something for the overlay's own renderer to draw. */
  send: (channel: string, payload: unknown) => void
}

export interface TransferLike {
  share: (filePath: string) => Promise<MediaSource>
  receive: (source: MediaSource) => Promise<{ path: string }>
  stop: (id: string) => Promise<void>
  progress: () => TransferProgress[]
  /** Swarm only: which parts are held, and whether to take part at all. */
  pieceMap?: (id: string) => string | null
  setPaused?: (id: string, paused: boolean) => boolean
}

export interface FilmStoreLike {
  list: () => Promise<StoredFilm[]>
  remove: (infoHash: string) => Promise<void>
  totalBytes: () => Promise<number>
  freeBytes: () => Promise<number>
}

export interface RoomLike {
  announceMedia: (name: string, durationSec: number, source?: MediaSource | null) => void
  clearMedia: () => void
  setMode: (mode: RoomMode) => void
  setOpenControl: (open: boolean) => void
  mode: RoomMode
  openControl: boolean
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
/** The video rectangle, plus the viewport it was measured in. */
export interface Slot extends Rect { viewport?: { width: number; height: number } }

export interface OpenDialogResult { canceled: boolean; filePaths: string[] }

export interface HandlerDeps {
  /** Where the picker's shortcuts point. Injected so tests need no real home. */
  getHome?: () => string
  showOpenDialog: (parent: unknown, options: Record<string, unknown>) => Promise<OpenDialogResult>
  getWindow: () => unknown | null
  getVideo: () => VideoLike | null
  getRoom: () => RoomLike | null
  setRoom: (room: RoomLike | null) => void
  createRoom: (o: {
    url: string; code: string | null; name: string; player: PlayerLike
    options?: RoomOptions
  }) => Promise<RoomLike>
  getMediaPath: () => string | null
  setMediaPath: (path: string | null) => void
  /** The film's volume as the viewer set it, 0 to 100, and whether the call is
   *  currently quietening it. Held in the main process because both write to
   *  the same control. */
  getVolume?: () => number
  setVolume?: (percent: number) => void
  isDucked?: () => boolean
  setDucked?: (ducked: boolean) => void
  /**
   * Convert a film the <video> engine cannot open, returning the path to play.
   * Absent under the mpv engine, which needs none of it.
   */
  makePlayable?: (path: string) => Promise<string>
  setFullScreen: (on: boolean) => void
  isFullScreen: () => boolean
  getIdentity: () => Identity
  saveIdentity: (patch: Partial<Omit<Identity, 'id'>>) => Identity
  getTransfer: () => TransferLike | null
  /**
   * Whether this machine is currently feeding the room, and whether that has
   * been paused. Opening a film no longer implies sharing it: a film plays
   * locally until somebody says to share it.
   */
  getSharing?: () => 'off' | 'sharing' | 'paused'
  setSharing?: (state: 'off' | 'sharing' | 'paused') => void
  getSharedInfoHash?: () => string | null
  /** Whether the room's film is the one this machine put on. */
  getAnnouncedByUs?: () => boolean
  setAnnouncedByUs?: (v: boolean) => void
  /**
   * Put the film away and forget everything about it: transfer stopped, player
   * emptied, every flag cleared. One implementation, so no caller can clear a
   * different subset from the next.
   */
  closeFilm?: () => Promise<void>
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
    // A fresh install points at this machine until it is told otherwise, and
    // "connection refused" tells someone who was sent a link nothing at all.
    if (/^wss?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)([:/]|$)/i.test(url)) {
      return new Error(
        `Nothing is listening at ${url}, which is this machine. If a friend invited you, put the server address they gave you in the Server box.`
      )
    }
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
  /** What the player should actually be set to: the viewer's volume, reduced
   *  while somebody is talking. */
  const effectiveVolume = (): number => {
    const chosen = deps.getVolume?.() ?? 100
    return deps.isDucked?.() ? Math.round(chosen * 0.35) : chosen
  }

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

  /**
   * Open a film, for this machine only.
   *
   * Opening and sharing used to be one action, which made two quite different
   * things look like one: putting a film on your own screen, and pushing
   * gigabytes at everybody else. They are separate now -- nothing leaves this
   * machine until `film:share`.
   */
  const loadInto = async (path: string): Promise<{ path: string; name: string; durationSec: number | null; infoHash: string | null }> => {
    const video = deps.getVideo()
    if (!video?.player) throw new Error('player not ready')

    // Phase B1.5. The <video> engine cannot open every container -- AVI and
    // MPEG-2 do not demux -- so a file is inspected and, where needed, made
    // playable first. Most films need nothing and this costs one ffprobe.
    // Never on the mpv path, which decodes all of it natively; that is an
    // answer in itself for a library of old rips.
    let toPlay = path
    if (video.engine === 'html' && deps.makePlayable) {
      try {
        toPlay = await deps.makePlayable(path)
      } catch (err) {
        video.setFilmOpen?.(!!deps.getMediaPath())
        log(`[film] could not make ${basename(path)} playable: ${String(err)}`)
        throw err instanceof Error ? err : new Error(String(err))
      }
    }

    // Before the load, not after: mpv draws into this window, and a window that
    // is still hidden when the file opens is a film with sound and no picture.
    video.setFilmOpen?.(true)
    try {
      await video.player.load(toPlay)
    } catch (err) {
      // Nothing is playing, so the surface goes away again and the interface
      // gets its empty state back rather than a black rectangle.
      video.setFilmOpen?.(!!deps.getMediaPath())
      log(`[film] failed to load: ${String(err)}`)
      throw err instanceof Error ? err : new Error(String(err))
    }
    deps.setMediaPath(path)
    const durationSec = video.player.duration()
    log(`[film] loaded ${basename(path)} · duration ${durationSec ?? 'unknown'}`)

    // Nothing is announced and nothing is hashed: this film is on one screen
    // until somebody presses Start sharing.
    deps.setSharing?.('off')
    deps.setSharedInfoHash?.(null)
    deps.setAnnouncedByUs?.(false)
    // Next time the picker opens, open where this came from.
    deps.saveIdentity({ lastFilmDir: dirname(path) })
    return { path, name: basename(path), durationSec, infoHash: null }
  }

  return {
    'video:slot': (slot: Slot) => {
      const video = deps.getVideo()
      video?.setSlot(slot)
      // The overlay is positioned inside the video rectangle, so it needs the
      // same measurement.
      deps.getOverlay?.()?.setSlot(slot)
      return video?.bounds() ?? null
    },

    /**
     * The overlay reporting what it wants drawn, in its own CSS pixels. It is
     * measured in the renderer because only the renderer knows where the
     * bubbles ended up after layout.
     */
    'overlay:shape': (rects: Rect[]) => {
      deps.getOverlay?.()?.setShape(Array.isArray(rects) ? rects : [])
      return { ok: true }
    },

    /**
     * Subtitle files sitting beside the film (phase B1.4).
     *
     * Looked for rather than asked for, because that is where they always are:
     * a film downloaded with subtitles has them in the same folder, usually
     * sharing its name. Anything matching the film's own name is offered first,
     * since a folder can hold subtitles for a whole season.
     *
     * Formats that need libass are listed but marked, so the interface can say
     * "this needs a renderer coCine does not have yet" rather than silently
     * not offering a file the person can plainly see.
     */
    'subs:beside': async () => {
      const film = deps.getMediaPath()
      if (!film) return { files: [] }
      const dir = dirname(film)
      const stem = basename(film).replace(/\.[^.]+$/, '').toLowerCase()
      let names: string[] = []
      try { names = await readdir(dir) } catch { return { files: [] } }
      const files = names
        .filter(n => isSubtitleFile(n) || isUnsupportedSubtitleFile(n))
        .map(n => ({
          name: n,
          path: join(dir, n),
          /** Whether this can be drawn, or only named. */
          supported: isSubtitleFile(n),
          /** Subtitles for *this* film rather than another in the folder. */
          matches: n.toLowerCase().startsWith(stem)
        }))
        // The film's own subtitles first, then everything else alphabetically.
        .sort((a, b) => Number(b.matches) - Number(a.matches) || a.name.localeCompare(b.name))
      return { files }
    },

    /** The text of one subtitle file, parsed in the renderer that draws it. */
    'subs:read': async (path: string) => {
      if (!isSubtitleFile(path)) throw new Error('that is not a subtitle format coCine can draw')
      // Subtitle files are small; a whole-file read is simpler than streaming
      // and there is nothing to gain from being clever about it.
      return { text: await readFile(path, 'utf8') }
    },

    /**
     * The fullscreen composer, which lives in the main window and is drawn by
     * the overlay. The two are separate windows because the overlay cannot be
     * given the keyboard -- it is reparented into the main window, so the
     * window manager will not focus it, and everything typed while it was
     * supposedly focused went to the main window and was dropped.
     */
    'overlay:draft': (text: string | null) => {
      deps.getOverlay?.()?.send('overlay:draft', typeof text === 'string' ? text : null)
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

    /**
     * Hand the film to the room.
     *
     * Hashing runs in chunks -- measured at roughly 780 MB/s, so seconds on a
     * large film and no need for a worker thread -- and only then is the film
     * announced, because announcing a source nobody can fetch yet sends the
     * room chasing bytes that are not there.
     */
    'film:share': async () => {
      const room = deps.getRoom()
      if (!room) throw new Error('A film is shared with a room. Create or join one first.')
      const path = deps.getMediaPath()
      if (!path) throw new Error('No film is open')
      const transfer = deps.getTransfer()
      // Announcing a film with no source tells the room its name and its length
      // and gives it nothing to fetch: the other machines show a duration and
      // sit there for ever. Better to refuse than to claim to be sharing.
      if (!transfer) {
        throw new Error('Cannot share yet — no connection to the room\'s transfer network. Try again in a moment.')
      }
      const source = await transfer.share(path)
      deps.setSharedInfoHash?.(sourceId(source))
      log(`[film] sharing as ${sourceId(source)}`)
      room.announceMedia(basename(path), deps.getVideo()?.player?.duration() ?? 0, source)
      deps.setSharing?.('sharing')
      deps.setAnnouncedByUs?.(true)
      return { infoHash: sourceId(source) }
    },

    /**
     * Stop feeding the room without giving the film up. Paused means paused for
     * everyone: the swarm stops serving as well as fetching, which is what the
     * words have to mean if they are to describe the effect on other people.
     */
    'film:setSharingPaused': (paused: boolean) => {
      const id = deps.getSharedInfoHash?.()
      if (!id) throw new Error('This film is not being shared')
      const ok = deps.getTransfer()?.setPaused?.(id, paused)
      if (ok === false) throw new Error('This film could not be paused')
      deps.setSharing?.(paused ? 'paused' : 'sharing')
      log(`[film] sharing ${paused ? 'paused' : 'resumed'}`)
      return { paused }
    },

    /**
     * Put the film away. Takes it off the room too when this machine is the one
     * sharing it, so nobody is left fetching from somebody who has moved on.
     */
    /**
     * Put the film away.
     *
     * The room is told first, so the other machines start clearing while this
     * one does; then everything local goes at once through the single path that
     * knows what "no film here" means. Each step is independently guarded --
     * a transfer that will not stop must not leave a player holding a film, and
     * neither may leave the interface claiming one is open.
     */
    'film:unload': async () => {
      // Only whoever put the film on takes it off the room. Somebody who was
      // merely receiving it leaves the room's film where it is for everyone else.
      if (deps.getAnnouncedByUs?.()) {
        try { deps.getRoom()?.clearMedia() } catch (err) { log(`[film] could not clear the room's film: ${String(err)}`) }
      }
      if (deps.closeFilm) {
        await deps.closeFilm()
      } else {
        // Older wiring, and the tests that use it: do the same work in place.
        const id = deps.getSharedInfoHash?.()
        if (id) { try { await deps.getTransfer()?.stop(id) } catch { /* going away regardless */ } }
        try { await deps.getVideo()?.player?.unload?.() } catch { /* nothing playing */ }
        deps.setSharedInfoHash?.(null)
        deps.setSharing?.('off')
        deps.setAnnouncedByUs?.(false)
        deps.setMediaPath(null)
      }
      log('[film] unloaded')
      return { ok: true }
    },

    'identity:get': () => deps.getIdentity(),

    /**
     * The application's own film browser, used wherever the system dialog
     * cannot be trusted. See browse.ts for why that is Linux.
     */
    'browse:start': (): { places: Array<{ label: string; path: string }>; path: string } => {
      const home = deps.getHome?.() ?? '/'
      return {
        places: placesFor(home),
        path: startDirectory(deps.getIdentity().lastFilmDir, home)
      }
    },

    'browse:list': async (path: string, showAll = false): Promise<Listing> =>
      await listDirectory(path, { showAll }),

    /**
     * The native video surface floats above the window's own content, so a
     * panel drawn over the video area cannot be seen until it is out of the
     * way -- the same reason the system dialog needs it.
     */
    'browse:active': (active: boolean) => {
      const video = deps.getVideo()
      if (active) video?.suspend()
      // resume() only brings it back if a film is open, so closing the picker
      // on an empty room leaves the welcome panel where it is.
      else video?.resume()
      return { ok: true }
    },

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
    'room:connect': async (o: { url: string; code: string | null; name: string; options?: RoomOptions }) => {
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
      deps.setDucked?.(ducked)
      // Ducking is a *fraction* of whatever the viewer chose, not a fixed
      // level. Setting 100 here would undo their volume every time somebody
      // stopped talking, which is worse than not ducking at all.
      await player.setVolume?.(effectiveVolume())
    },

    /**
     * The film's own volume, nothing to do with the call.
     *
     * Kept in the main process rather than in the element, because ducking also
     * writes to the same control: whichever of them wrote last would otherwise
     * win, and the viewer's choice would be silently discarded whenever
     * somebody spoke.
     */
    'film:volume': async (percent: number) => {
      const clamped = Math.max(0, Math.min(100, Math.round(percent)))
      deps.setVolume?.(clamped)
      await deps.getVideo()?.player?.setVolume?.(effectiveVolume())
      return { volume: clamped }
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

    /**
     * Whether someone arriving may drive playback, or only the host. Chosen
     * when the room is created and changeable afterwards, because a host who
     * wants the remote back should not have to take it from people one by one.
     */
    'room:setOpenControl': (open: boolean) => {
      const room = deps.getRoom()
      if (!room) throw new Error('not in a room')
      if (!room.me()?.isHost) throw new Error('only the host can change that')
      room.setOpenControl(open)
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
          ?.showText('Space play · ← → seek · Enter chat · Esc exit', 2600)
          .catch(() => {})
      }
      return next
    }
  }
}
