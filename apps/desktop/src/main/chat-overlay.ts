import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { Rect } from './video-window.js'
import { embedWindow, raiseEmbedded, x11EmbeddingPossible } from './x11-embed.js'

/**
 * The chat panel shown over the film in fullscreen.
 *
 * It exists as its own window because mpv renders into a native child window
 * that sits above the main window's content: anything Chromium paints in the
 * main window is behind the video and cannot be seen. A second native window,
 * stacked above the first, is the only place pixels can go.
 *
 * Opaque on purpose. Translucency on X11 requires a compositing manager, and a
 * bare i3 session has none -- a transparent window there paints black, which
 * looks broken rather than subtle.
 */

const WIDTH = 380
const HEIGHT = 300
const MARGIN = 20

export class ChatOverlay {
  private win: BrowserWindow | null = null
  private slot: Rect | null = null
  private wanted = false
  private embedded = false

  constructor (
    private readonly parent: BrowserWindow,
    private readonly load: (win: BrowserWindow) => Promise<void>
  ) {}

  private async ensure (): Promise<BrowserWindow | null> {
    if (this.win && !this.win.isDestroyed()) return this.win
    if (this.parent.isDestroyed()) return null

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
      // Unlike the video surface this one takes the keyboard, because it has a
      // text field. It is shown without focus and only takes it when asked.
      focusable: true,
      backgroundColor: '#0d0f16',
      title: 'coCine chat',
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false
      }
    })
    await this.load(this.win)
    // Same reason as the video surface: a separate top-level window is ignored
    // by the window manager and strands itself on other workspaces. Mapping it
    // after the video window also puts it above, which is what makes chat
    // visible over the film rather than behind it.
    if (x11EmbeddingPossible()) {
      this.embedded = await embedWindow(this.parent, this.win, 0, 0)
    }
    this.win.on('closed', () => { this.win = null })
    return this.win
  }

  /** The video rectangle, which is what the overlay is positioned within. */
  setSlot (slot: Rect): void {
    this.slot = slot
    if (!this.wanted) return
    this.reposition()
    // The video surface re-shows itself whenever its own slot changes, which
    // restacks it above this window. Re-raising on the same cadence is what
    // keeps chat on top rather than winning the race only sometimes.
    if (this.embedded && this.isVisible()) void raiseEmbedded(this.win!)
  }

  async setVisible (visible: boolean): Promise<void> {
    this.wanted = visible
    if (!visible) {
      if (this.win && !this.win.isDestroyed()) this.win.hide()
      return
    }
    const win = await this.ensure()
    if (!win) return
    this.reposition()
    // showInactive keeps the keyboard with the main window, so space still
    // pauses and Escape still leaves fullscreen until chat is deliberately used.
    win.showInactive()
    // Both children sit above the parent; this is what puts chat above video
    // rather than behind it.
    // setAlwaysOnTop and moveTop both go through the window manager, which does
    // not manage an embedded child window at all. Raising it in X directly is
    // what actually puts chat above the film.
    if (this.embedded) {
      const ok = await raiseEmbedded(win)
      if (process.env.COCINE_DEBUG) console.log(`[overlay] raised: ${ok}`)
    }
    else { win.setAlwaysOnTop(true); win.moveTop() }
  }

  focus (): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      this.win.focus()
      this.win.webContents.send('overlay:focus')
    }
  }

  /** Give the keyboard back, or the main window's shortcuts stay dead. */
  releaseFocus (): void {
    if (!this.parent.isDestroyed()) this.parent.focus()
  }

  private reposition (): void {
    if (!this.win || this.win.isDestroyed() || this.parent.isDestroyed()) return
    const content = this.parent.getContentBounds()
    const scale = screen.getDisplayMatching(content).scaleFactor || 1
    const slot = this.slot
    // Bottom-left of the video, which is the least likely corner to hold
    // anything worth reading in a film.
    // Embedded windows are placed relative to the parent, so the parent's own
    // screen position must not be added in.
    const originX = this.embedded ? 0 : content.x
    const originY = this.embedded ? 0 : content.y
    const areaX = originX + Math.round((slot?.x ?? 0) * scale)
    const areaBottom = originY + Math.round(((slot?.y ?? 0) + (slot?.height ?? content.height)) * scale)
    this.win.setBounds({
      x: areaX + MARGIN,
      y: Math.max(originY, areaBottom - HEIGHT - MARGIN),
      width: WIDTH,
      height: HEIGHT
    })
  }

  isVisible (): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible()
  }

  destroy (): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}
