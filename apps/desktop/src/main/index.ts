import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import type { BrowserWindow as BW } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { RoomClient } from '@cocine/client'
import { VideoWindow } from './video-window.js'
import { createHandlers, type RoomLike } from './handlers.js'
import { IdentityStore, identityPathFor } from './identity.js'
import { FilmStore, TransferManager, OriginTransfer, type MediaTransport } from '@cocine/client'
import { sourceId, type Media } from '@cocine/protocol'
import { MpvNotFoundError } from '@cocine/player'
import { startUpdates } from './updates.js'
import { ChatOverlay } from './chat-overlay.js'

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
let startupError: { message: string; howToInstall: string } | null = null
let receiving: { name: string; infoHash: string } | null = null

/**
 * The transport for the room's current mode.
 *
 * Rebuilt when the mode changes, because the two carry different bytes from
 * different places and nothing is shared between them. Created only once the
 * room has told us the tracker URL -- it is never guessed.
 */
function ensureTransfer (): MediaTransport | null {
  const mode = room?.mode ?? 'p2p'
  if (transfer && transferMode === mode) return transfer

  const previous = transfer
  transfer = null
  transferMode = null
  if (previous) void previous.destroy().catch(() => { /* replaced */ })

  if (mode === 'origin') {
    if (!room) return null
    const client = room
    transfer = new OriginTransfer({
      store: films,
      getUploadUrl: (contentId, name, bytes) => client.requestUploadUrl(contentId, name, bytes),
      getDownloadUrl: () => client.requestDownloadUrl()
    })
  } else {
    if (!room?.trackerUrl) return null
    // Bulk gets the server's bulk list, which is STUN only by design -- a film
    // pushed through a relay costs whoever runs it the whole file twice per peer.
    transfer = new TransferManager({ store: films, trackerUrl: room.trackerUrl, iceServers: room.ice.bulk })
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
    phase: room?.phase ?? 'lobby',
    waitForLatecomers: room?.waitForLatecomers ?? true,
    transferStatus: room?.transfer ?? null,
    receiving,
    roomTorrent: room?.media?.source?.kind === 'p2p' ? room.media.source : null,
    mode: room?.mode ?? 'p2p',
    originAvailable: room?.originAvailable ?? false,
    startupError
  }
}

function createWindow (): void {
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
      sandbox: false
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
  // The renderer relayouts on this, which resizes the video surface via the
  // existing slot reporting -- no separate fullscreen handling for the video.
  const pushState = (): void => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('state', state())
  }
  // Chat is hidden with the rest of the sidebar in fullscreen, so it comes back
  // as an overlay over the film. Only while in a room -- there is nothing to
  // show otherwise.
  const syncOverlay = (): void => {
    const show = !!mainWin?.isFullScreen() && !!room && !process.env.COCINE_HEADLESS
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
    const { autoUpdater } = await import('electron-updater')
    const outcome = await startUpdates({
      updater: autoUpdater as never,
      isPackaged: app.isPackaged,
      platform: process.platform,
      log: m => console.log(m),
      getWindow: () => mainWin
    })
    if (!outcome.checked) console.log(`[update] not checking: ${outcome.reason}`)
  })().catch(err => console.log('[update] skipped:', String(err)))

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
      try { await video?.player?.load(mediaPath) } catch (e) { console.error('could not load film:', e) }
    }
    statusTimer = setInterval(() => {
      // Keep the fetch windows on the playhead. Uses the room's position rather
      // than the local player's, because while a film is still arriving the
      // local player may not have opened it yet.
      const id = sourceId(room?.media?.source)
      if (id && transfer) {
        const at = room?.expectedPosition() ?? 0
        transfer.updatePlayhead(id, at, room?.media?.durationSec ?? 0)
      }
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('state', state())
    }, 100)
  })
}

const handlers = createHandlers({
  showOpenDialog: (parent, options) => dialog.showOpenDialog(parent as BW, options),
  getWindow: () => mainWin,
  getVideo: () => video,
  getRoom: () => room,
  setRoom: r => { room = r as RoomClient | null },
  createRoom: async o => {
    // Annotated because getReport closes over `client`, and without a type here
    // that circular reference makes the whole thing infer as any.
    const client: RoomClient = new RoomClient({
      url: o.url,
      code: o.code,
      name: o.name,
      player: o.player as never,
      // What this machine can honestly say about the film it is fetching.
      getReport: (): { havePct: number; bufferEndSec: number; downBps: number; upBps: number; peers: number } | null => {
        const id = sourceId(client.media?.source)
        if (!id || !transfer) return null
        // The sharer, and anyone who already had the file, hold all of it.
        if (id === sharedId) {
          return { havePct: 1, bufferEndSec: client.media?.durationSec ?? 0, downBps: 0, upBps: 0, peers: 0 }
        }
        return transfer.reportFor(id, client.expectedPosition() ?? 0, client.media?.durationSec ?? 0)
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
          if (!source || !id || id === sharedId) return
        try {
          const tm = ensureTransfer()
            if (!tm) throw new Error('no transport for this room yet')
          console.log(`[film] room is sharing ${media?.name}; fetching`)
          receiving = { name: media?.name ?? '', infoHash: id }
          const { path } = await tm.receive(source)
          // Open it through the streaming server rather than off disk. The
          // file is written sparsely, so reading it directly would give zeros
          // wherever a piece has not arrived; the stream blocks instead, which
          // is what makes watching before the download finishes possible.
          const url = tm.streamUrl(id) ?? path
          await video?.player?.load(url)
          mediaPath = path
          receiving = null
          console.log(`[film] streaming ${media?.name} from ${url}`)
        } catch (err) {
          receiving = null
          console.error('[film] could not receive:', err)
        }
      })()
    })
    await client.connect()
    // The tracker URL arrives with room state, so the transfer manager cannot
    // exist before this point.
    ensureTransfer()
    return client as unknown as RoomLike
  },
  getMediaPath: () => mediaPath,
  setMediaPath: p => { mediaPath = p },
  setFullScreen: on => mainWin?.setFullScreen(on),
  isFullScreen: () => mainWin?.isFullScreen() ?? false,
  getIdentity: () => identity.get(),
  saveIdentity: patch => identity.save(patch),
  getTransfer: () => transfer,
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
