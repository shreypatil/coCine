import { BrowserWindow, screen } from 'electron'
import { EmbeddedMpv, ExternalMpv, locateMpv } from '@cocine/player'
import { embedWindow, x11EmbeddingPossible } from './x11-embed.js'

export interface Rect { x: number; y: number; width: number; height: number }

/**
 * mpv reparented into a frameless child window that is kept exactly over the
 * video area of the main window.
 *
 * Why a child window at all: --wid makes mpv fill whatever window it is given,
 * with no way to ask for a sub-rectangle. Handing it the main window would put
 * video over the entire interface. So the main window keeps the whole layout in
 * ordinary HTML, and only the video rectangle is a separate native surface.
 *
 * The consequence, and it is the one real cost of this architecture: nothing
 * can be drawn on top of the video. Controls sit beside and beneath it, never
 * over it. The layout is built around that rather than fighting it.
 */
/**
 * The mpv to run. Resolved once per launch rather than per player, so a missing
 * mpv is reported the same way whichever path created the player.
 */
function mpvBinary (): string {
  return locateMpv({ resourcesPath: process.resourcesPath })
}

export class VideoWindow {
  private win: BrowserWindow | null = null
  player: EmbeddedMpv | ExternalMpv | null = null
  private slot: Rect | null = null
  /** True once the surface is a real child of the main window, after which its
   *  coordinates are relative to the parent rather than to the screen. */
  private embedded = false

  constructor (private readonly parent: BrowserWindow) {}

  async start (): Promise<EmbeddedMpv | ExternalMpv> {
    // Test affordance: no child window and no video output, so the full
    // application can be driven end to end without anything reaching a display.
    // Everything above this class sees the same PlayerController either way.
    if (process.env.COCINE_HEADLESS) {
      const player = new ExternalMpv({ headless: true, binary: mpvBinary() })
      await player.start()
      this.player = player
      return player
    }
    this.win = new BrowserWindow({
      parent: this.parent,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Keyboard belongs to the main window; this surface is pixels only.
      focusable: false,
      backgroundColor: '#000000',
      title: 'coCine video',
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    })
    await this.win.loadURL('data:text/html,<body style="margin:0;background:#000"></body>')

    const player = new EmbeddedMpv(this.win.getNativeWindowHandle(), { binary: mpvBinary() })
    await player.start()
    this.player = player

    // Become a real child of the main window rather than a separate top-level
    // one the window manager ignores. Without this a tiling window manager
    // leaves the video painted over whatever workspace you switch to, because
    // an override-redirect window belongs to no workspace at all.
    if (x11EmbeddingPossible()) {
      this.embedded = await embedWindow(this.parent, this.win, 0, 0)
      if (!this.embedded) console.log('[video] could not embed the surface; it stays a separate window')
    }

    // The child has to follow the parent everywhere, or it detaches visibly.
    const follow = (): void => this.reposition()
    this.parent.on('move', follow)
    this.parent.on('resize', follow)
    this.parent.on('maximize', follow)
    this.parent.on('unmaximize', follow)
    this.parent.on('enter-full-screen', follow)
    this.parent.on('leave-full-screen', follow)
    this.parent.on('minimize', () => this.win?.hide())
    this.parent.on('restore', () => { if (this.slot) this.win?.show() })
    this.parent.on('closed', () => { void this.close() })
    return player
  }

  /** Called from the renderer whenever the video slot moves or resizes. */
  setSlot (slot: Rect): void {
    this.slot = slot
    if (this.win) this.reposition()
  }

  private reposition (): void {
    if (!this.win || !this.slot || this.win.isDestroyed() || this.parent.isDestroyed()) return
    const content = this.parent.getContentBounds()
    // Renderer rects are in CSS pixels; window bounds are in display pixels.
    const scale = screen.getDisplayMatching(content).scaleFactor || 1
    // Once embedded the window sits inside the parent, so its origin is the
    // parent's content origin and adding the screen position would double it.
    const originX = this.embedded ? 0 : content.x
    const originY = this.embedded ? 0 : content.y
    const bounds = {
      x: Math.round(originX + this.slot.x * scale),
      y: Math.round(originY + this.slot.y * scale),
      width: Math.max(1, Math.round(this.slot.width * scale)),
      height: Math.max(1, Math.round(this.slot.height * scale))
    }
    this.win.setBounds(bounds)
    if (process.env.COCINE_DEBUG) {
      const got = this.win.getBounds()
      console.log(`[video] slot=${this.slot.width}x${this.slot.height}@${this.slot.x},${this.slot.y}` +
        ` content=${content.width}x${content.height}@${content.x},${content.y} scale=${scale}` +
        ` asked=${bounds.width}x${bounds.height}@${bounds.x},${bounds.y}` +
        ` got=${got.width}x${got.height}@${got.x},${got.y}`)
    }
    if (!this.win.isVisible()) this.win.showInactive()
  }

  /**
   * Native child windows sit above their parent and are not affected by the
   * parent's modal dialogs, so an open-file dialog can appear *behind* the
   * video surface. Hiding it for the duration is the only reliable fix.
   */
  suspend (): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide()
  }

  resume (): void {
    if (this.win && !this.win.isDestroyed() && this.slot) {
      this.reposition()
      this.win.showInactive()
    }
  }

  bounds (): Rect | null {
    return this.win && !this.win.isDestroyed() ? this.win.getBounds() : null
  }

  /** Synchronous, for process exit where promises will never settle. */
  killNow (): void {
    this.player?.kill()
    this.player = null
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }

  async close (): Promise<void> {
    try { await this.player?.close() } catch { /* going away anyway */ }
    this.player = null
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}
