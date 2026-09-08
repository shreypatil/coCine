import { nativeHandleToWid } from '@cocine/player'
import type { BrowserWindow } from 'electron'

/**
 * Making the application look like one window on X11.
 *
 * The video surface and the fullscreen chat overlay are separate native windows,
 * because mpv fills whatever window it is given and nothing can be drawn over
 * it. Electron creates them as **override-redirect** windows -- a consequence of
 * asking for a non-focusable window -- which tells the window manager to ignore
 * them entirely.
 *
 * On i3 that has a very visible cost: an ignored window belongs to no workspace,
 * so the window manager never unmaps it, and the video stays painted over
 * whatever workspace you switch to. Confirmed directly: the video window has no
 * `WM_STATE` and no `_NET_WM_DESKTOP`, and reports `Override Redirect: yes`.
 *
 * Reparenting them into the main window's own X window fixes it at the root. A
 * real child window is clipped by its parent, moves with it, and is hidden with
 * it, so the window manager only ever sees one window -- which is what the
 * application should have looked like all along.
 *
 * Everything here is best effort. A failure leaves the previous behaviour, which
 * is imperfect but works, so nothing is ever thrown at the caller.
 */

interface X11Client {
  ReparentWindow: (child: number, parent: number, x: number, y: number) => void
  MapWindow: (win: number) => void
  UnmapWindow: (win: number) => void
  RaiseWindow: (win: number) => void
}
interface X11Display { client: X11Client }

let clientPromise: Promise<X11Display | null> | null = null

/** Connects once and reuses it; a display connection per reparent is wasteful. */
async function display (): Promise<X11Display | null> {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return null
  clientPromise ??= (async () => {
    try {
      const x11 = await import('x11')
      return await new Promise<X11Display | null>(resolve => {
        const timer = setTimeout(() => resolve(null), 3000)
        try {
          ;(x11 as unknown as {
            createClient: (cb: (err: unknown, d: X11Display) => void) => void
          }).createClient((err, d) => {
            clearTimeout(timer)
            resolve(err ? null : d)
          })
        } catch {
          clearTimeout(timer)
          resolve(null)
        }
      })
    } catch {
      return null
    }
  })()
  return clientPromise
}

/**
 * Make `child` a real child of `parent`, positioned at (x, y) inside it.
 *
 * After this the child's coordinates are relative to the parent, so callers must
 * stop adding the parent's screen position when placing it.
 */
export async function embedWindow (
  parent: BrowserWindow, child: BrowserWindow, x: number, y: number
): Promise<boolean> {
  const d = await display()
  if (!d) return false
  try {
    if (parent.isDestroyed() || child.isDestroyed()) return false
    const parentId = Number(nativeHandleToWid(parent.getNativeWindowHandle()))
    const childId = Number(nativeHandleToWid(child.getNativeWindowHandle()))
    if (!Number.isFinite(parentId) || !Number.isFinite(childId)) return false
    d.client.ReparentWindow(childId, parentId, Math.round(x), Math.round(y))
    // Reparenting unmaps the window. Putting it back on screen unconditionally
    // was a real bug: the video surface is created hidden and belongs hidden
    // until a film is open, so mapping it here left a black rectangle over the
    // top-left of the interface -- over the launch animation and over the film
    // picker -- while Electron went on reporting the window as hidden and
    // therefore never corrected it. Only what is meant to be seen is mapped.
    if (child.isVisible()) d.client.MapWindow(childId)
    return true
  } catch {
    return false
  }
}

/**
 * Map or unmap an embedded window in X directly.
 *
 * Electron's show() and hide() are the source of truth for what *should* be on
 * screen, but a reparented window is no longer one the window manager tracks,
 * and the two states drifted apart. These are called alongside show and hide so
 * that what X does always matches what Electron believes.
 */
export async function setEmbeddedMapped (win: BrowserWindow, mapped: boolean): Promise<boolean> {
  const d = await display()
  if (!d) return false
  try {
    if (win.isDestroyed()) return false
    const wid = Number(nativeHandleToWid(win.getNativeWindowHandle()))
    if (!Number.isFinite(wid)) return false
    if (mapped) d.client.MapWindow(wid)
    else d.client.UnmapWindow(wid)
    return true
  } catch {
    return false
  }
}

/**
 * Put an embedded window at the top of its parent's stacking order.
 *
 * Necessary because sibling children stack in the order they were mapped, and
 * the video surface is mapped first -- so the chat overlay, created later but
 * mapped while hidden, ends up underneath it and cannot be seen. Electron's own
 * moveTop() cannot help: it asks the window manager to restack a window the
 * window manager does not manage.
 */
export async function raiseEmbedded (win: BrowserWindow): Promise<boolean> {
  const d = await display()
  if (!d) return false
  try {
    if (win.isDestroyed()) return false
    d.client.RaiseWindow(Number(nativeHandleToWid(win.getNativeWindowHandle())))
    return true
  } catch {
    return false
  }
}

export function x11EmbeddingPossible (): boolean {
  return process.platform === 'linux' && !!process.env.DISPLAY
}

/**
 * Shaping a window so the film shows through everywhere it has no content.
 *
 * The fullscreen chat has to sit over the video, and X11 gives no way to blend
 * one window over another: a compositing manager composites *top level* windows
 * only, and the chat window is deliberately a child of the main window so the
 * whole application behaves as one window. Alpha in a child is simply painted,
 * not blended.
 *
 * The X SHAPE extension solves it from the other direction. Rather than making
 * pixels translucent, it removes them from the window altogether -- the window
 * exists only where its shape says it does, and everywhere else the video
 * sibling underneath is what the screen shows. It needs no compositing manager,
 * so it behaves the same on a bare i3 session as under picom, and it clips
 * input as well as output, so a click that lands on the film is not swallowed.
 */

interface ShapeExt {
  Kind: { Bounding: number; Clip: number; Input: number }
  Op: { Set: number; Union: number; Intersect: number; Subtract: number; Invert: number }
  Ordering: { Unsorted: number; YSorted: number; YXSorted: number; YXBanded: number }
  Rectangles: (
    op: number, kind: number, window: number, x: number, y: number,
    rectangles: number[][], ordering?: number
  ) => void
  Mask: (op: number, kind: number, window: number, x: number, y: number, bitmap: number) => void
}

let shapePromise: Promise<ShapeExt | null> | null = null

/** Loaded once. A server without the extension resolves null and stays null. */
async function shapeExt (): Promise<ShapeExt | null> {
  const d = await display()
  if (!d) return null
  shapePromise ??= new Promise<ShapeExt | null>(resolve => {
    try {
      const client = d.client as unknown as {
        require: (name: string, cb: (err: unknown, ext: ShapeExt) => void) => void
      }
      const timer = setTimeout(() => resolve(null), 3000)
      client.require('shape', (err, ext) => {
        clearTimeout(timer)
        resolve(err ? null : ext)
      })
    } catch {
      resolve(null)
    }
  })
  return shapePromise
}

/** Whether the shaped overlay is possible at all, before anything is drawn. */
export async function shapingAvailable (): Promise<boolean> {
  return (await shapeExt()) !== null
}

/**
 * Restrict `win` to `rects`, in device pixels relative to the window's own
 * origin. An empty list makes the window invisible without hiding it, which is
 * what an overlay with nothing to say should look like.
 */
export async function setWindowShape (
  win: BrowserWindow, rects: Array<{ x: number; y: number; width: number; height: number }>
): Promise<boolean> {
  const ext = await shapeExt()
  const d = await display()
  if (!ext || !d || win.isDestroyed()) return false
  try {
    const wid = Number(nativeHandleToWid(win.getNativeWindowHandle()))
    if (!Number.isFinite(wid)) return false
    const list = rects
      .filter(r => r.width > 0 && r.height > 0)
      .map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)])
    // Bounding rather than Clip: Clip would leave the window's frame drawn.
    ext.Rectangles(ext.Op.Set, ext.Kind.Bounding, wid, 0, 0, list)
    // Input follows the same region, so a click on the film reaches the film.
    ext.Rectangles(ext.Op.Set, ext.Kind.Input, wid, 0, 0, list)
    return true
  } catch {
    return false
  }
}

/** Give the window its whole rectangle back. */
export async function clearWindowShape (win: BrowserWindow): Promise<boolean> {
  const ext = await shapeExt()
  if (!ext || win.isDestroyed()) return false
  try {
    const wid = Number(nativeHandleToWid(win.getNativeWindowHandle()))
    if (!Number.isFinite(wid)) return false
    // A mask of None is the documented way to remove a shape entirely.
    ext.Mask(ext.Op.Set, ext.Kind.Bounding, wid, 0, 0, 0)
    ext.Mask(ext.Op.Set, ext.Kind.Input, wid, 0, 0, 0)
    return true
  } catch {
    return false
  }
}
