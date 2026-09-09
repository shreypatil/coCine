import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import type { BrowserWindow as BW } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { RoomClient } from '@cocine/client'
import { VideoWindow } from './video-window.js'
import { createHandlers, type RoomLike } from './handlers.js'
import { IdentityStore, identityPathFor } from './identity.js'
import { FilmStore, TransferManager, OriginTransfer, installWebRtc, webRtcFailure, type MediaTransport } from '@cocine/client'
import { sourceId, type Media } from '@cocine/protocol'
import { MpvNotFoundError } from '@cocine/player'
import { startUpdates } from './updates.js'
import { ChatOverlay } from './chat-overlay.js'
import { ensurePlayable, conversionDir } from './convert.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// mpv cannot reparent into a Wayland surface -- there is no embedding path at
// all. Running the whole app under XWayland is what makes --wid work on a
// Wayland desktop, at the cost of native fractional scaling.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform', 'x11')
}

// Tests launch the real application, and without this they would write a real
// identity file into the user's own config directory. Must happen before
// anything reads userData.
if (process.env.COCINE_HEADLESS) {
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'cocine-test-')))
}

let mainWin: BrowserWindow | null = null
let video: VideoWindow | null = null
let overlay: ChatOverlay | null = null
/**
 * Push the current state to the renderer.
 *
 * A module-level hook because the real pushState is created with the window,
 * and things outside that scope -- a conversion running while a film is opened
 * -- still have to report progress. A no-op before the window exists, which is
 * the right behaviour rather than something to guard at every call site.
 */
let notifyState: () => void = () => {}

/** A film being made playable by the <video> engine, or null. */
let converting: {
  name: string; reason: string; slow: boolean; progress: number | null
} | null = null
let room: RoomClient | null = null
let mediaPath: string | null = null
let statusTimer: NodeJS.Timeout | null = null
const identity = new IdentityStore(identityPathFor(app.getPath('userData')))
// Films are kept until removed, so they live somewhere stable rather than a
// temporary directory. The store owns listing and deletion, because retaining
// gigabytes without a way to see them fills a drive silently.
const films = new FilmStore(join(app.getPath('userData'), 'films'))
let transfer: MediaTransport | null = null
/** Which transport `transfer` currently is, so a mode change rebuilds it. */
let transferMode: 'p2p' | 'origin' | null = null
let sharedId: string | null = null
/**
 * Whether this machine is feeding the room. Opening a film no longer implies
 * sharing it: it plays locally until somebody says otherwise, and can be paused
 * without giving it up.
 */
let sharing: 'off' | 'sharing' | 'paused' = 'off'
/** Whether the room's current film is the one this machine put on. Only the
 *  announcer takes it off again. */
let announcedByUs = false
let startupError: { message: string; howToInstall: string } | null = null
let receiving: { name: string; infoHash: string } | null = null
/** Why the film could not be fetched, when it could not. */
let receiveError: string | null = null
/**
 * The id of the film this machine took *from the room*, as opposed to one
 * opened locally. It is what makes "the room took its film off" actionable: a
 * copy that came from the room goes with it, and a local file somebody opened
 * themselves stays where it is.
 */
let roomFilmId: string | null = null
/**
 * Bumped whenever the film changes or goes away.
 *
 * Fetching a film is a long await, and the room can move on during it. Without
 * a generation to check afterwards, a receive that started before the film was
 * taken off would finish afterwards and quietly reinstate it -- a machine
 * playing something the room had dropped, in sync with nothing.
 */
let filmGeneration = 0

/**
 * Put the film away, whatever state it was in.
 *
 * Every path that ends with no film open goes through here -- the person
 * pressing Unload, the room taking its film off, and swapping one film for
 * another -- because the bug this replaces was each of them clearing a
 * different subset. A guest left holding a film the room had moved on from kept
 * playing it against anchors meant for a different one, which looks exactly
 * like synchronisation failing.
 *
 * Every step is independently guarded: a transfer that will not stop must not
 * prevent the player being cleared, and neither must stop the state being
 * truthful afterwards.
 */
async function closeFilm (opts: { stopTransfer?: boolean } = {}): Promise<void> {
  // Anything in flight for the old film is now stale, whatever it does next.
  filmGeneration++
  const id = sharedId ?? receiving?.infoHash ?? null
  if (opts.stopTransfer !== false && id) {
    try { await transfer?.stop(id) } catch (err) { console.error('[film] could not stop the transfer:', err) }
  }
  try { await video?.player?.unload?.() } catch (err) { console.error('[film] could not unload the player:', err) }
  mediaPath = null
  video?.setFilmOpen(false)
  sharedId = null
  sharing = 'off'
  announcedByUs = false
  roomFilmId = null
  receiving = null
  receiveError = null
}
/** False until the window has been mapped, so nothing animates unseen. */
let windowShown = false

/**
 * The transport for the room's current mode.
 *
 * Rebuilt when the mode changes, because the two carry different bytes from
 * different places and nothing is shared between them. Created only once the
 * room has told us the tracker URL -- it is never guessed.
 */
function ensureTransfer (client: RoomClient | null = room): MediaTransport | null {
  // Takes the client explicitly because the first call happens *inside*
  // createRoom, before the module-level `room` has been assigned. Reading the
  // module variable there found null, gave up, and left the transport null for
  // the rest of the session -- so pressing Start sharing announced a film with
  // no source, and the other machine was told a name and a duration it could
  // never fetch a byte of.
  const mode = client?.mode ?? 'p2p'
  if (transfer && transferMode === mode) return transfer

  const previous = transfer
  transfer = null
  transferMode = null
  if (previous) void previous.destroy().catch(() => { /* replaced */ })

  if (mode === 'origin') {
    if (!client) return null
    transfer = new OriginTransfer({
      store: films,
      getUploadUrl: (contentId, name, bytes) => client.requestUploadUrl(contentId, name, bytes),
      getDownloadUrl: () => client.requestDownloadUrl()
    })
  } else {
    if (!client?.trackerUrl) return null
    // Bulk gets the server's bulk list, which is STUN only by design -- a film
    // pushed through a relay costs whoever runs it the whole file twice per peer.
    transfer = new TransferManager({ store: films, trackerUrl: client.trackerUrl, iceServers: client.ice.bulk })
  }
  transferMode = mode
  ;(transfer as unknown as { on: (e: string, f: (x: unknown) => void) => void })
    .on('error', err => console.error('[transfer]', err))
  return transfer
}

const state = (): Record<string, unknown> => {
  const player = video?.player
  const now = Date.now()
  const expected = room?.expectedPosition(now) ?? null
  const actual = player ? room?.actualPosition(now) ?? player.position() : 0
  return {
    ready: !!player,
    /** Which player is running; the renderer mounts a <video> for 'html'. */
    playerEngine: video?.engine ?? 'mpv',
    /** A film being converted so the <video> engine can open it. */
    converting,
    connected: !!room,
    connection: room?.connection ?? 'closed',
    members: room?.members ?? [],
    memberId: room?.memberId ?? '',
    code: room?.code ?? null,
    messages: room?.messages ?? [],
    isHost: room?.me()?.isHost ?? false,
    mayControl: room?.me()?.mayControl ?? false,
    mediaName: mediaPath ? basename(mediaPath) : null,
    durationSec: player?.duration() ?? null,
    positionSec: actual,
    expectedSec: expected,
    driftMs: expected === null ? null : (actual - expected) * 1000,
    paused: player?.isPaused() ?? true,
    rate: room?.currentRate() ?? 1,
    voiceIce: room?.ice.voice ?? [],
    clockOffsetMs: room?.clock.offsetMs() ?? null,
    rttMs: room?.clock.rttMs() ?? null,
    lastAction: room?.lastSyncAction()?.type ?? null,
    fullscreen: mainWin?.isFullScreen() ?? false,
    transfers: transfer?.progress() ?? [],
    /** Whether the window is actually on screen; see the 'show' handler. */
    windowShown,
    phase: room?.phase ?? 'lobby',
    waitForLatecomers: room?.waitForLatecomers ?? true,
    openControl: room?.openControl ?? true,
    transferStatus: room?.transfer ?? null,
    receiving,
    receiveError,
    /** What the room is showing, whether or not this machine has it yet. */
    roomFilm: room?.media ? { name: room.media.name, durationSec: room.media.durationSec, hasSource: !!room.media.source } : null,
    roomTorrent: room?.media?.source?.kind === 'p2p' ? room.media.source : null,
    mode: room?.mode ?? 'p2p',
    sharing,
    sharedInfoHash: sharedId,
    originAvailable: room?.originAvailable ?? false,
    /**
     * Whether the system's own file dialog can be trusted to return what was
     * chosen. It cannot on Linux without a desktop portal -- an activate
     * gesture is reported as a cancellation -- so the application browses for
     * itself there. See browse.ts.
     */
    nativePicker: process.platform !== 'linux' || !!process.env.COCINE_NATIVE_DIALOG,
    /**
     * Why peer-to-peer is unavailable, when it is. Almost always one thing: the
     * native WebRTC addon for this platform was left out of the package. Said
     * out loud, because the alternative is a transfer that simply never starts.
     */
    webrtcError: webRtcFailure(),
    startupError
  }
}

function createWindow (): void {
  // The application has its own top bar, and Electron's stock File/Edit/View
  // menu is both redundant and load-bearing in the wrong way: on Linux it is
  // drawn inside the window's content area, which pushed the whole interface
  // down by its height while the native video surface stayed where the page
  // said, covering the room code. macOS keeps a menu, where removing it would
  // take the standard shortcuts with it.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  mainWin = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0d1117',
    title: 'coCine',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      /**
       * Chromium throttles timers, animation frames and media in windows it
       * believes nobody is looking at. That is the right default for a browser
       * and the wrong one here: the room keeps playing whether or not this
       * window has focus, and a throttled client drifts away from everyone
       * else while its own screen looks fine. It matters more under the
       * <video> engine, where the film *is* this window, but the sync tick
       * runs here either way.
       */
      backgroundThrottling: false
    }
  })

  // Renderer console output normally goes nowhere visible. Forward it so a
  // failure in the interface shows up in the same terminal as everything else.
  mainWin.webContents.on('console-message', (e) => {
    const level = e.level === 'error' ? 'error' : 'log'
    console[level](`[renderer] ${e.message}`)
  })
  mainWin.webContents.on('render-process-gone', (_e, d) => console.error('[renderer] gone:', d.reason))

  mainWin.on('ready-to-show', () => { if (!process.env.COCINE_HEADLESS) mainWin?.show() })
  // Chromium throttles a hidden window: CSS animations freeze and timers slow to
  // about one a second. The launch animation therefore began before anyone could
  // see it and was sometimes still frozen on screen once the window appeared --
  // which also left the film picker stranded behind it. The renderer waits for
  // this before starting anything.
  mainWin.on('show', () => { windowShown = true; pushState() })
  // The renderer relayouts on this, which resizes the video surface via the
  // existing slot reporting -- no separate fullscreen handling for the video.
  // Both windows render from this. The overlay was left out of the first
  // version, which is why the fullscreen chat sat on "Nothing said yet" for a
  // conversation the main window was showing perfectly well.
  const pushState = (): void => {
    const s = state()
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('state', s)
    overlay?.send('state', s)
  }
  // Everything outside this scope reports progress through here.
  notifyState = pushState
  // Chat is hidden with the rest of the sidebar in fullscreen, so it comes back
  // as an overlay over the film. Only while in a room -- there is nothing to
  // show otherwise.
  const syncOverlay = (): void => {
    // Never under the <video> engine: the film is this window, so chat is drawn
    // over it in ordinary DOM (StageChat) and the shaped child window would be
    // a second, opaque copy of something already on screen.
    const show = !!mainWin?.isFullScreen() && !!room &&
      !process.env.COCINE_HEADLESS && video?.engine !== 'html'
    void overlay?.setVisible(show).catch(err => console.error('[overlay]', err))
  }
  mainWin.on('enter-full-screen', syncOverlay)
  mainWin.on('leave-full-screen', syncOverlay)
  mainWin.on('enter-full-screen', pushState)
  mainWin.on('leave-full-screen', pushState)
  mainWin.on('closed', () => { mainWin = null })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void mainWin.loadURL(devUrl)
  else void mainWin.loadFile(join(__dirname, '../renderer/index.html'))

  // Same bundle, different entry: #overlay renders the compact chat instead of
  // the whole interface.
  overlay = new ChatOverlay(mainWin, async win => {
    if (devUrl) await win.loadURL(`${devUrl}#overlay`)
    else await win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'overlay' })
  })

  // Fire and forget: an update check must never delay the window appearing, and
  // never prevent a film being watched if it fails.
  void (async () => {
    // electron-updater is CommonJS. Bundled and imported from an ESM main it
    // came back with only a default export, so the named import was undefined
    // and every packaged build failed its update check with a TypeError before
    // reaching the updater at all. Both shapes are accepted here.
    const mod = await import('electron-updater') as unknown as {
      autoUpdater?: unknown
      default?: { autoUpdater?: unknown }
    }
    const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater
    if (!autoUpdater) throw new Error('electron-updater exposed no autoUpdater')
    const outcome = await startUpdates({
      updater: autoUpdater as never,
      isPackaged: app.isPackaged,
      platform: process.platform,
      log: m => console.log(m),
      getWindow: () => mainWin
    })
    if (!outcome.checked) console.log(`[update] not checking: ${outcome.reason}`)
  })().catch(err => console.log('[update] skipped:', String(err)))

  // Load the WebRTC addon now rather than on the first transfer: if it is
  // missing, the room should say so before anybody picks a film and waits.
  installWebRtc()
  if (webRtcFailure()) console.error('[webrtc] unavailable:', webRtcFailure())

  video = new VideoWindow(mainWin)
  void video.start().catch((err: unknown) => {
    // Without mpv there is no application, so this is reported as a wall rather
    // than a dismissible banner. It is the first thing someone who installed
    // from a link will hit if their platform did not bring mpv with it.
    startupError = err instanceof MpvNotFoundError
      ? { message: err.message, howToInstall: err.howToInstall }
      : { message: `The video player could not start: ${String(err)}`, howToInstall: '' }
    console.error('[startup]', startupError.message, startupError.howToInstall)
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('state', state())
    return null
  }).then(async started => {
    if (!started) return
    // --film=<path> skips the dialog. Useful for manual testing, and the only
    // way to script a launch that ends with something on screen.
    const arg = process.argv.find(a => a.startsWith('--film='))
    if (arg) {
      mediaPath = arg.slice('--film='.length)
      video?.setFilmOpen(true)
      try { await video?.player?.load(mediaPath) } catch (e) { console.error('could not load film:', e) }
    }
    statusTimer = setInterval(() => {
      // Keep the fetch windows on the playhead. Uses the room's position rather
      // than the local player's, because while a film is still arriving the
      // local player may not have opened it yet.
      // If a film is open and nothing has deliberately hidden the surface, it
      // belongs on screen. Cheap to assert, and it means no sequence of window
      // events or IPC ordering can leave someone listening to a film they
      // cannot see.
      video?.ensureVisible()
      const id = sourceId(room?.media?.source)
      if (id && transfer) {
        const at = room?.expectedPosition() ?? 0
        transfer.updatePlayhead(id, at, room?.media?.durationSec ?? 0)
      }
      pushState()
    }, 100)
  })
}

const handlers = createHandlers({
  showOpenDialog: (parent, options) => dialog.showOpenDialog(parent as BW, options),
  getWindow: () => mainWin,
  getVideo: () => video,
  getOverlay: () => overlay,
  getHome: () => app.getPath('home'),
  getRoom: () => room,
  setRoom: r => { room = r as RoomClient | null },
  createRoom: async o => {
    // Annotated because getReport closes over `client`, and without a type here
    // that circular reference makes the whole thing infer as any.
    const client: RoomClient = new RoomClient({
      url: o.url,
      code: o.code,
      name: o.name,
      // Only meaningful when creating; the server ignores them on a join.
      options: o.options,
      player: o.player as never,
      // What this machine can honestly say about the film it is fetching.
      getReport: () => {
        const id = sourceId(client.media?.source)
        if (!id || !transfer) return null
        const pieces = transfer.pieceMap?.(id) ?? undefined
        const paused = sharing === 'paused'
        // The sharer, and anyone who already had the file, hold all of it --
        // but their upload rate is the interesting number, so it comes from the
        // transport rather than being assumed to be zero.
        if (id === sharedId) {
          const own = transfer.reportFor(id, client.expectedPosition() ?? 0, client.media?.durationSec ?? 0)
          return {
            havePct: 1,
            bufferEndSec: client.media?.durationSec ?? 0,
            downBps: own?.downBps ?? 0,
            upBps: own?.upBps ?? 0,
            peers: own?.peers ?? 0,
            pieces,
            paused
          }
        }
        const base = transfer.reportFor(id, client.expectedPosition() ?? 0, client.media?.durationSec ?? 0)
        return base ? { ...base, pieces, paused } : null
      }
    })
    // Attached before connect: room.state arrives while connecting, so a
    // listener added afterwards misses a film that was already on when we
    // joined -- which is the common case for anyone but the first person in.
    // Voice lives in the renderer, where Chromium supplies WebRTC and a
    // microphone. Main only carries the negotiation between the two.
    client.on('rtc-signal', (from: string, payload: unknown) => {
      mainWin?.webContents.send('voice:signal', from, payload)
    })
    client.on('voice-moderated', (by: string, action: string) => {
      mainWin?.webContents.send('voice:moderated', by, action)
    })

      client.on('media', (media: Media | null) => {
      void (async () => {
        const source = media?.source
        const id = sourceId(source)

        if (!source) {
          // The room took its film off. A copy that came *from the room* goes
          // with it -- keeping it meant playing one film against another film's
          // anchors -- while a file somebody opened here themselves is theirs
          // and stays put. A fetch still in flight counts as from the room: it
          // has not finished yet, and it must not finish.
          if (roomFilmId || receiving) {
            console.log('[film] the room took its film off; closing it here too')
            await closeFilm()
          } else {
            sharing = 'off'
            sharedId = null
          }
          return
        }
        if (!id || id === sharedId) return

        // A different film. The previous one has to go first, or its transfer
        // keeps running and its bytes keep being served for something nobody
        // is watching.
        if ((roomFilmId ?? receiving?.infoHash) && (roomFilmId ?? receiving?.infoHash) !== id) await closeFilm()

        const generation = ++filmGeneration
        try {
          const tm = ensureTransfer()
            if (!tm) throw new Error('no transport for this room yet')
          console.log(`[film] room is sharing ${media?.name}; fetching`)
          receiving = { name: media?.name ?? '', infoHash: id }
          receiveError = null
          const { path } = await tm.receive(source)
          // The room may have moved on while that was fetching. Finishing the
          // job now would put back a film nobody else has any more.
          if (generation !== filmGeneration) {
            console.log('[film] fetch finished after the room moved on; dropping it')
            try { await tm.stop(id) } catch { /* already going */ }
            return
          }
          // Open it through the streaming server rather than off disk. The
          // file is written sparsely, so reading it directly would give zeros
          // wherever a piece has not arrived; the stream blocks instead, which
          // is what makes watching before the download finishes possible.
          const url = tm.streamUrl(id) ?? path
          video?.setFilmOpen(true)
          await video?.player?.load(url)
          mediaPath = path
          receiving = null
          // Whoever receives a film also serves it, so the interface should say
          // so rather than showing them as a bystander.
          sharedId = id
          sharing = 'sharing'
          announcedByUs = false
          roomFilmId = id
          console.log(`[film] streaming ${media?.name} from ${url}`)
        } catch (err) {
          // A failure for a film the room has already dropped is not news.
          if (generation !== filmGeneration) return
          receiving = null
          // Only a console line before, which nobody can see in an installed
          // copy: the film simply never arrived and the interface said nothing.
          receiveError = err instanceof Error ? err.message : String(err)
          console.error('[film] could not receive:', err)
        }
      })()
    })
    await client.connect()
    // The tracker URL arrives with room state, so the transfer manager cannot
    // exist before this point -- and the client has to be passed in, because
    // the module-level `room` is not assigned until this function returns.
    ensureTransfer(client)
    return client as unknown as RoomLike
  },
  getMediaPath: () => mediaPath,
  /**
   * Make a film the <video> engine can open, converting it if it cannot.
   *
   * Progress is pushed into the interface rather than logged: a repack is over
   * before anybody wonders, but a transcode of a feature-length film is
   * minutes, and doing that silently looks exactly like the application having
   * hung.
   */
  makePlayable: async (path: string) => {
    const result = await ensurePlayable({
      input: path,
      outputDir: conversionDir(app.getPath('userData')),
      onProgress: p => {
        converting = {
          name: basename(p.path),
          reason: p.compatibility.reason,
          slow: p.compatibility.slow,
          progress: p.progress
        }
        notifyState()
      }
    })
    converting = null
    if (result.converted) {
      console.log(`[film] converted ${basename(path)} (${result.compatibility?.action})`)
    }
    notifyState()
    return result.path
  },
  setMediaPath: p => {
    mediaPath = p
    // The surface only belongs on screen once there is a picture for it; until
    // then the interface owns that space and can say what to do.
    video?.setFilmOpen(!!p)
  },
  setFullScreen: on => mainWin?.setFullScreen(on),
  isFullScreen: () => mainWin?.isFullScreen() ?? false,
  getIdentity: () => identity.get(),
  saveIdentity: patch => identity.save(patch),
  // Built on demand as well as eagerly: an early attempt can legitimately fail
  // (no tracker URL yet), and one that never retried is what made sharing
  // announce a film nobody could fetch.
  getTransfer: () => transfer ?? ensureTransfer(),
  getSharing: () => sharing,
  setSharing: state => { sharing = state },
  getSharedInfoHash: () => sharedId,
  getAnnouncedByUs: () => announcedByUs,
  setAnnouncedByUs: v => { announcedByUs = v },
  closeFilm: async () => { await closeFilm() },
  getFilmStore: () => films,
  setSharedInfoHash: h => { sharedId = h },
  log: m => console.log(m)
})
for (const [channel, fn] of Object.entries(handlers)) {
  ipcMain.handle(channel, (_e, ...args) => (fn as (...a: unknown[]) => unknown)(...args))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
let shuttingDown = false

/**
 * Electron's before-quit is synchronous: an async handler's awaits do not delay
 * the quit, so mpv was being orphaned and the process never settled. The
 * supported shape is to cancel the quit, clean up, then quit again.
 */
app.on('before-quit', event => {
  if (shuttingDown) return
  event.preventDefault()
  shuttingDown = true
  void (async () => {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null }
    try { await transfer?.destroy() } catch { /* going away */ }
    try { await room?.close() } catch { /* going away */ }
    overlay?.destroy()
    overlay = null
    try { await video?.close() } catch { /* going away */ }
    app.quit()
  })()
})

// Last resort: if anything above hangs, do not leave mpv behind.
process.on('exit', () => { try { video?.killNow() } catch { /* nothing to do */ } })
