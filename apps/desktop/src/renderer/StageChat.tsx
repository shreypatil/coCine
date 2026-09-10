import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ChatMessage } from './types.js'
import { initials, tint, hhmm } from './format.js'

/**
 * Chat over the film, in fullscreen, as ordinary DOM.
 *
 * This is the same feature `Overlay.tsx` provides for the mpv engine, and it is
 * worth seeing them side by side, because the difference is the whole argument
 * for the `<video>` engine.
 *
 * The mpv version needs: a second BrowserWindow, reparented into this one with
 * XReparentWindow; the X SHAPE extension to cut that window down to the exact
 * bubbles so the film shows through; a routine that measures every bubble and
 * approximates its rounded corners as a stack of rectangles, because SHAPE
 * takes nothing else; an IPC message and two X requests every time any of that
 * changes; a fallback to an opaque corner panel for X servers without SHAPE;
 * and a text field that lives in *this* window and is drawn in the other one,
 * because a reparented window is not one a window manager will ever focus.
 *
 * This version needs a `div` with a `z-index`. Clicks pass through the empty
 * space by way of `pointer-events`, which is the one CSS property that replaces
 * the entire shaping mechanism. The composer is a real focused input, so it can
 * be typed into, selected, and corrected like any other.
 */

/** How long a line stays up before it gets out of the way of the film. */
const LIFETIME_MS = 15_000
const MAX_VISIBLE = 5

export interface StageChatProps {
  messages: ChatMessage[]
  /**
   * Whether somebody is composing a message right now.
   *
   * The composer itself lives in the control bar -- a hidden field that only a
   * keyboard shortcut could reach meant that in practice there was no way to
   * type in fullscreen unless you already knew. What is left here is the
   * drawing, and this only decides whether recent lines stay up.
   */
  composing: boolean
}

export function StageChat ({ messages: all, composing }: StageChatProps): ReactElement {
  const [, setTick] = useState(0)
  /** When each message first appeared here, so expiry never depends on agreeing
   *  with the server's clock. */
  const seen = useRef(new Map<string, number>())
  const started = useRef(false)

  const now = Date.now()
  if (!started.current && all.length) {
    // The backlog is history, not news: entering fullscreen must not replay the
    // last hour of conversation over the film. Anything genuinely recent still
    // shows, aged by its own timestamp -- clamped to now, because a server
    // clock running ahead must not make a line immortal.
    started.current = true
    for (const m of all) seen.current.set(m.id, Math.min(now, m.atServerMs))
  }
  for (const m of all) if (!seen.current.has(m.id)) seen.current.set(m.id, now)

  // While the composer is open, recent lines stay up whatever their age.
  // Replying to something you can no longer see is worse than covering a little
  // more of the film for as long as you are typing.
  const visible = (composing
    ? all
    : all.filter(m => now - (seen.current.get(m.id) ?? 0) < LIFETIME_MS)
  ).slice(-MAX_VISIBLE)

  // Expiry is time-based, so something has to notice time passing.
  useEffect(() => {
    if (composing || visible.length === 0) return
    const id = setInterval(() => setTick(t => t + 1), 500)
    return () => clearInterval(id)
  }, [composing, visible.length])

  return (
    <div className="stagechat" data-testid="stagechat">
      <div className="sc-list" data-testid="stagechatlist">
        {visible.map(m => m.kind === 'said' ? (
          <div className="sc-msg" data-testid="stagemsg" key={m.id}>
            <span className={`av sm t${tint(m.name)}`}>{initials(m.name)}</span>
            <span className="sc-txt"><b>{m.name}<i>{hhmm(m.atServerMs)}</i></b>{m.text}</span>
          </div>
        ) : (
          <p className="sc-sys" data-testid="stagemsg" key={m.id}><b>{m.name}</b> {m.text}</p>
        ))}
      </div>
    </div>
  )
}
