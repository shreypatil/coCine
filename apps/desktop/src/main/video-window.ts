import { BrowserWindow, screen } from 'electron'
import { EmbeddedMpv, ExternalMpv, locateMpv } from '@cocine/player'
import { embedWindow, setEmbeddedMapped, x11EmbeddingPossible } from './x11-embed.js'

export interface Rect { x: number; y: number; width: number; height: number }

/**
 * A rectangle plus the size of the viewport it was measured in.
 *
 * The viewport is what makes the two coordinate systems reconcilable. Electron
 * counts a Linux menu bar as part of the window's *content*, while the page's
 * own coordinates start below it, so placing a native surface from the page's
 * rectangle alone put the video roughly thirty pixels too high -- over the
 * application's own top bar, hiding the room code.
 */
export interface Slot extends Rect { viewport?: { width: number; height: number } }

/**
 * How far the page's origin sits inside the window's content area.
 *
 * Derived rather than assumed, so it is right whether the window has a menu
 * bar, gains one, or never had one. Anything absurd is treated as zero: a bad
 * measurement must not move the video.
 */
export function chromeOffset (
  content: { width: number; height: number },
  viewport: { width: number; height: number } | undefined,
  scale: number
): { x: number; y: number } {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) return { x: 0, y: 0 }
  const y = Math.round(content.height - viewport.height * scale)
  const x = Math.round(content.width - viewport.width * scale)
  return {
    x: x > 0 && x < 200 ? x : 0,
    y: y > 0 && y < 200 ? y : 0
  }
}

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
  private slot: Slot | null = null
  /** True once the surface is a real child of the main window, after which its
   *  coordinates are relative to the parent rather than to the screen. */
  private embedded = false
  /**
   * Whether the surface belongs on screen at all.
   *
   * It used to appear the moment the renderer reported a rectangle, which meant
   * a black box sat where the picture goes from launch until a film was opened
   * -- and nothing could be drawn there to say what to do next, because this
   * window covers it. Off until there is something to play, and the interface
   * owns that space in the meantime.
   */
  private wanted = false
  /**
   * Set while something is deliberately covering the video area -- the film
   * picker, or a system dialog. Kept separate from `wanted` because
   * repositioning used to re-show the surface underneath whatever had just
   * hidden it, which is how a dialog ended up behind the video.
   */
  private suspended = false

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
      // Whatever the reparent did, X and Electron agree from here on.
      this.setShown(this.wanted)
    }

    // The child has to follow the parent everywhere, or it detaches visibly.
    const follow = (): void => this.reposition()
    this.parent.on('move', follow)
    this.parent.on('resize', follow)
    this.parent.on('maximize', follow)
    this.parent.on('unmaximize', follow)
    this.parent.on('enter-full-screen', follow)
    this.parent.on('leave-full-screen', follow)
    this.parent.on('minimize', () => this.setShown(false))
    this.parent.on('restore', () => { if (this.slot && this.wanted) this.setShown(true) })
    this.parent.on('closed', () => { void this.close() })
    return player
  }

  /**
   * Show or hide the surface in both worlds at once.
   *
   * Electron's own show and hide are not enough: once the window has been
   * reparented, the window manager no longer tracks it, and its X map state
   * drifted away from what Electron believed. That drift is what left a black
   * rectangle over the interface that nothing would clear.
   */
  private setShown (shown: boolean): void {
    if (!this.win || this.win.isDestroyed()) return
    if (shown) this.win.showInactive()
    else this.win.hide()
    if (this.embedded) void setEmbeddedMapped(this.win, shown)
  }

  /** Called from the renderer whenever the video slot moves or resizes. */
  setSlot (slot: Slot): void {
    this.slot = slot
    if (this.win) this.reposition()
  }

  /** Whether a film is open. Nothing else decides if the surface is shown. */
  setFilmOpen (open: boolean): void {
    this.wanted = open
    if (!this.win || this.win.isDestroyed()) return
    // Position first, then show: a surface that appears before it has been
    // placed flashes black over whatever it lands on.
    if (open) { this.reposition(); this.setShown(true) }
    else this.setShown(false)
  }

  private reposition (): void {
    if (!this.win || !this.slot || this.win.isDestroyed() || this.parent.isDestroyed()) return
    const content = this.parent.getContentBounds()
    // Renderer rects are in CSS pixels; window bounds are in display pixels.
    const scale = screen.getDisplayMatching(content).scaleFactor || 1
    // Once embedded the window sits inside the parent, so its origin is the
    // parent's content origin and adding the screen position would double it.
    const chrome = chromeOffset(content, this.slot.viewport, scale)
    const originX = (this.embedded ? 0 : content.x) + chrome.x
    const originY = (this.embedded ? 0 : content.y) + chrome.y
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
    if (this.wanted && !this.suspended && !this.win.isVisible()) this.setShown(true)
  }

  /**
   * Put the surface back on screen if it belongs there and something has left
   * it hidden. Called on the status tick: no sequence of window events, IPC
   * ordering or dialogs should be able to leave a film playing with no picture.
   */
  ensureVisible (): void {
    if (!this.win || this.win.isDestroyed()) return
    if (!this.wanted || this.suspended || !this.slot) return
    if (!this.win.isVisible()) this.reposition()
  }

  /**
   * Native child windows sit above their parent and are not affected by the
   * parent's modal dialogs, so an open-file dialog can appear *behind* the
   * video surface. Hiding it for the duration is the only reliable fix.
   */
  suspend (): void {
    this.suspended = true
    this.setShown(false)
  }

  resume (): void {
    this.suspended = false
    if (this.win && !this.win.isDestroyed() && this.slot && this.wanted) {
      this.reposition()
      this.setShown(true)
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
