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
    // Reparenting unmaps the window, so it has to be put back on screen.
    d.client.MapWindow(childId)
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
