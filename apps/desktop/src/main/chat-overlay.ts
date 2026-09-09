import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { chromeOffset, type Rect, type Slot } from './video-window.js'
import {
  embedWindow, raiseEmbedded, x11EmbeddingPossible, setEmbeddedMapped,
  setWindowShape, clearWindowShape
} from './x11-embed.js'

/**
 * Chat over the film in fullscreen.
 *
 * It is its own native window because mpv renders into a native child window
 * that sits above the main window's content: anything Chromium paints in the
 * main window is behind the video and cannot be seen. A second native window,
 * stacked above the first, is the only place pixels can go.
 *
 * The window covers the whole video rectangle, and then almost all of it is
 * taken away again. On X11 the SHAPE extension restricts the window to exactly
 * the message bubbles the renderer reports, so the film is untouched everywhere
 * else -- no panel, no scrim, and clicks outside a bubble reach the film rather
 * than being swallowed. Elsewhere the same effect comes from an ordinary
 * transparent window, which those platforms composite for us.
 *
 * If neither is available -- an X server with no SHAPE extension -- it falls
 * back to `panel`, the opaque box in the corner it used to be. That is worse,
 * but it is visible, which is the property that matters.
 *
 * It never takes the keyboard. A window reparented into another window is not
 * one the window manager knows about, so it cannot be focused: asking it to
 * take the keyboard looked like it worked and quietly did nothing, which is why
 * the fullscreen composer opened and then swallowed everything typed into it.
 * The main window owns the text field -- it has the keyboard already, and in
 * fullscreen its own content is hidden behind the video anyway -- and sends the
 * draft here to be drawn.
 */

/** Fallback panel only; the floating layout is sized to the video. */
const PANEL_WIDTH = 380
const PANEL_HEIGHT = 300
const MARGIN = 20

export type OverlayLayout = 'floating' | 'panel'

export class ChatOverlay {
  private win: BrowserWindow | null = null
  private slot: Slot | null = null
  private wanted = false
  private embedded = false
  private layout: OverlayLayout = 'floating'
  /** The last shape asked for, in CSS pixels, so it survives a reposition. */
  private shapeCss: Rect[] = []
  /**
   * Whether the window has actually been cut down to its shape.
   *
   * The floating layout is a window the size of the entire film with almost all
   * of it taken away again. If the taking-away does not happen -- an X server
   * without the extension, a request that fails, a renderer that never reports
   * -- what is left is an opaque rectangle over the whole picture, which is the
   * worst thing this window could possibly do. So it is never shown until a
   * shape has been applied, and a failure to apply one drops it to the panel.
   */
  private shaped = false

  constructor (
    private readonly parent: BrowserWindow,
    private readonly load: (win: BrowserWindow) => Promise<void>
  ) {}

  private async ensure (): Promise<BrowserWindow | null> {
    if (this.win && !this.win.isDestroyed()) return this.win
    if (this.parent.isDestroyed()) return null

    // Transparency is real on Windows and macOS, where the desktop is always
    // composited. On Linux it is not: this window is reparented into the main
    // window, and X does not blend a child into its parent whatever the
    // compositing manager is doing, so the shape is what makes it work there.
    const transparent = process.platform !== 'linux'
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
      hasShadow: false,
      transparent,
      // Pixels only, like the video surface. It used to be focusable, because
      // it held the text field -- but a window reparented into another window
      // is not one the window manager will focus, so every keystroke went to
      // the main window regardless and the field could never be typed into.
      // The field lives in the main window now and this only draws it.
      focusable: false,
      backgroundColor: '#00000000',
      title: 'coCine chat',
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false
      }
    })
    const win = this.win
    await this.load(win)
    // Same reason as the video surface: a separate top-level window is ignored
    // by the window manager and strands itself on other workspaces. Mapping it
    // after the video window also puts it above, which is what makes chat
    // visible over the film rather than behind it.
    if (x11EmbeddingPossible()) {
      this.embedded = await embedWindow(this.parent, win, 0, 0)
      // Nothing has been reported yet, so the window should show nothing at
      // all rather than a full-video black rectangle for one frame. This
      // doubles as the test of whether shaping works here at all: asking the
      // extension whether it exists is not the same as the request succeeding,
      // and the consequence of believing it when it is not true is a film
      // nobody can see.
      this.shaped = await setWindowShape(win, [])
      this.layout = this.shaped ? 'floating' : 'panel'
    }
    win.webContents.send('overlay:layout', this.layout)
    win.webContents.on('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.send('overlay:layout', this.layout)
    })
    win.on('closed', () => { this.win = null })
    return win
  }

  /** The video rectangle, which is what the overlay is positioned within. */
  setSlot (slot: Slot): void {
    this.slot = slot
    if (!this.wanted) return
    this.reposition()
    // The video surface re-shows itself whenever its own slot changes, which
    // restacks it above this window. Re-raising on the same cadence is what
    // keeps chat on top rather than winning the race only sometimes.
    if (this.embedded && this.isVisible()) void raiseEmbedded(this.win!)
  }

  /**
   * What the renderer wants to be visible, in CSS pixels relative to its own
   * viewport. Everything else is cut out of the window.
   */
  setShape (rects: Rect[]): void {
    this.shapeCss = rects
    void this.applyShape()
  }

  /**
   * Cut the window down to what the renderer asked for, and give up the
   * floating layout entirely if that cannot be done. Covering the film with a
   * black rectangle is not an acceptable way to fail.
   */
  private async applyShape (): Promise<boolean> {
    if (this.layout !== 'floating' || !this.win || this.win.isDestroyed()) return false
    // Elsewhere the window is genuinely transparent and there is nothing to cut.
    if (process.platform !== 'linux') { this.shaped = true; return true }
    const ok = await setWindowShape(this.win, this.shapeCss.map(r => this.toDevice(r)))
    this.shaped = ok
    if (!ok) this.degrade()
    return ok
  }

  /**
   * Fall back to the opaque box in the corner. Worse to look at, but it covers
   * a corner of the film rather than all of it.
   */
  private degrade (): void {
    if (this.layout === 'panel') return
    console.error('[overlay] the window could not be shaped; falling back to a panel')
    this.layout = 'panel'
    if (this.win && !this.win.isDestroyed()) {
      void clearWindowShape(this.win)
      this.win.webContents.send('overlay:layout', 'panel')
    }
    this.reposition()
  }

  private toDevice (r: Rect): Rect {
    const scale = this.scaleFactor()
    return { x: r.x * scale, y: r.y * scale, width: r.width * scale, height: r.height * scale }
  }

  private scaleFactor (): number {
    if (this.parent.isDestroyed()) return 1
    return screen.getDisplayMatching(this.parent.getContentBounds()).scaleFactor || 1
  }

  async setVisible (visible: boolean): Promise<void> {
    this.wanted = visible
    if (!visible) {
      if (this.win && !this.win.isDestroyed()) {
        this.win.hide()
        // A reparented window is not one the window manager tracks, so hiding
        // it in Electron alone can leave it mapped in X.
        if (this.embedded) void setEmbeddedMapped(this.win, false)
      }
      return
    }
    const win = await this.ensure()
    if (!win) return
    this.reposition()
    // Shape first, show second. The other order puts a black rectangle over the
    // whole film for however long the shaping takes, and for ever if it fails.
    if (this.layout === 'floating') await this.applyShape()
    // showInactive keeps the keyboard with the main window: the overlay is
    // pixels only, and everything typed into it is typed in the main window.
    win.showInactive()
    if (this.embedded) await setEmbeddedMapped(win, true)
    // Both children sit above the parent; this is what puts chat above video
    // rather than behind it.
    // setAlwaysOnTop and moveTop both go through the window manager, which does
    // not manage an embedded child window at all. Raising it in X directly is
    // what actually puts chat above the film.
    if (this.embedded) {
      const ok = await raiseEmbedded(win)
      if (process.env.COCINE_DEBUG) console.log(`[overlay] raised: ${ok} layout=${this.layout}`)
    } else { win.setAlwaysOnTop(true); win.moveTop() }
  }

  /** The overlay renders from the same state as the main window. Without this
   *  it renders an empty conversation forever, which is exactly what it did. */
  send (channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload)
  }

  private reposition (): void {
    if (!this.win || this.win.isDestroyed() || this.parent.isDestroyed()) return
    const content = this.parent.getContentBounds()
    const scale = this.scaleFactor()
    const slot = this.slot
    // Embedded windows are placed relative to the parent, so the parent's own
    // screen position must not be added in.
    const chrome = chromeOffset(content, slot?.viewport, scale)
    const originX = (this.embedded ? 0 : content.x) + chrome.x
    const originY = (this.embedded ? 0 : content.y) + chrome.y
    const areaX = originX + Math.round((slot?.x ?? 0) * scale)
    const areaY = originY + Math.round((slot?.y ?? 0) * scale)
    const areaW = Math.round((slot?.width ?? content.width) * scale)
    const areaH = Math.round((slot?.height ?? content.height) * scale)

    if (this.layout === 'floating') {
      // The whole video. The shape is what decides which of it is drawn, so it
      // is re-applied unconditionally -- including when it is empty, which is
      // the state that keeps an idle overlay off the picture entirely.
      this.win.setBounds({ x: areaX, y: areaY, width: Math.max(1, areaW), height: Math.max(1, areaH) })
      void this.applyShape()
      return
    }
    // Bottom-left of the video, which is the least likely corner to hold
    // anything worth reading in a film.
    this.win.setBounds({
      x: areaX + MARGIN,
      y: Math.max(originY, areaY + areaH - PANEL_HEIGHT - MARGIN),
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT
    })
  }

  isVisible (): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible()
  }

  destroy (): void {
    if (this.win && !this.win.isDestroyed()) {
      void clearWindowShape(this.win)
      this.win.destroy()
    }
    this.win = null
  }
}
