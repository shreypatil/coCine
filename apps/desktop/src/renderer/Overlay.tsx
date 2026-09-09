import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ChatMessage, ShapeRect, State } from './types.js'
import { initials, tint, hhmm } from './format.js'

/**
 * Chat while the film is fullscreen.
 *
 * This is a separate window rather than part of the main interface, and the
 * reason is architectural rather than aesthetic: mpv renders into its own native
 * child window sitting above the main window's content, so anything Chromium
 * draws there is behind the video and invisible. The only way to put pixels over
 * the film is another native window stacked above it.
 *
 * That window covers the whole video, and then reports back the handful of
 * rectangles it actually wants -- one per message bubble, plus the composer when
 * it is open. The main process cuts the window down to exactly those, so the
 * film is untouched everywhere else. Nothing here is a panel: when nobody has
 * said anything recently there is no window left at all.
 *
 * `panel` is the fallback for a display server that cannot do that, where the
 * old opaque box in the corner is still better than nothing.
 *
 * Nothing here is typed into. This window is reparented into the main window on
 * X11, which means the window manager will not give it the keyboard, so a text
 * field of its own opened, looked ready, and silently dropped every keystroke.
 * The field lives in the main window -- which has the keyboard, and whose own
 * content is behind the video in fullscreen anyway -- and what is being typed
 * arrives here as text to draw.
 */

/** How long a line stays up before it gets out of the way of the film. */
const LIFETIME_MS = 15_000
const MAX_VISIBLE = 5
/** Matches the bubble's border-radius in the stylesheet. */
const RADIUS = 12

/**
 * A rounded rectangle, as rectangles.
 *
 * The shape extension takes nothing else, so the corners are approximated in
 * bands: without this every bubble would be cut square and the dark corner of
 * an otherwise soft shape is exactly the sort of thing that reads as broken.
 */
function rounded (r: DOMRect, radius: number): ShapeRect[] {
  const R = Math.max(0, Math.min(radius, r.height / 2, r.width / 2))
  const out: ShapeRect[] = [{ x: r.x, y: r.y + R, width: r.width, height: r.height - 2 * R }]
  const steps = 3
  for (let i = 0; i < steps; i++) {
    const h = R / steps
    const top = r.y + h * i
    const mid = h * (i + 0.5)
    const dx = R - Math.sqrt(Math.max(0, R * R - (R - mid) * (R - mid)))
    const width = r.width - 2 * dx
    if (width <= 0) continue
    out.push({ x: r.x + dx, y: top, width, height: h })
    out.push({ x: r.x + dx, y: r.y + r.height - top - h, width, height: h })
  }
  return out
}

export function Overlay (): ReactElement {
  const [s, setS] = useState<State | null>(null)
  const [layout, setLayout] = useState<'floating' | 'panel'>('floating')
  /** What the main window is typing, or null while the composer is closed. */
  const [draft, setDraft] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  /** When each message first reached this window, so expiry does not depend on
   *  agreeing with the server's clock. */
  const seen = useRef(new Map<string, number>())
  const started = useRef(false)

  useEffect(() => window.cocine.onState(setS), [])
  useEffect(() => window.cocine.onOverlayLayout?.(setLayout), [])
  useEffect(() => window.cocine.onOverlayDraft?.(setDraft), [])

  const composing = draft !== null

  const all: ChatMessage[] = s?.messages ?? []
  const now = Date.now()
  if (!started.current && all.length) {
    // The backlog is history, not news: entering fullscreen should not replay
    // the last hour of conversation over the film. Anything genuinely recent
    // still shows, aged by its own timestamp -- clamped to now, because a
    // server clock running ahead must not make a line immortal.
    started.current = true
    for (const m of all) seen.current.set(m.id, Math.min(now, m.atServerMs))
  }
  for (const m of all) if (!seen.current.has(m.id)) seen.current.set(m.id, now)

  // While the composer is open the recent lines stay up whatever their age --
  // replying to something you can no longer see is worse than covering a little
  // more of the film for as long as you are typing.
  const messages = (layout === 'panel' || composing
    ? all
    : all.filter(m => now - (seen.current.get(m.id) ?? 0) < LIFETIME_MS)
  ).slice(-(layout === 'panel' ? 40 : MAX_VISIBLE))

  // Expiry is time-based, so something has to notice time passing.
  useEffect(() => {
    if (layout === 'panel' || composing || messages.length === 0) return
    const id = setInterval(() => setTick(t => t + 1), 500)
    return () => clearInterval(id)
  }, [layout, composing, messages.length])

  useLayoutEffect(() => {
    const el = listRef.current
    if (el && layout === 'panel') el.scrollTop = el.scrollHeight
  }, [messages.length, layout])

  /**
   * Tell the main process which pixels of this window should exist. Skipped
   * when nothing changed, because it crosses a process boundary and ends in an
   * X request.
   */
  const lastShape = useRef('')
  const report = useCallback(() => {
    if (layout !== 'floating' || !window.cocine.setOverlayShape) return
    const rects: ShapeRect[] = []
    for (const el of document.querySelectorAll('[data-chip]')) {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      rects.push(...rounded(r, RADIUS))
    }
    const key = JSON.stringify(rects)
    if (key === lastShape.current) return
    lastShape.current = key
    void window.cocine.setOverlayShape(rects)
  }, [layout])

  useLayoutEffect(() => {
    // After paint: bubbles are measured, not predicted.
    const id = requestAnimationFrame(() => requestAnimationFrame(report))
    return () => cancelAnimationFrame(id)
  })

  useEffect(() => {
    window.addEventListener('resize', report)
    return () => window.removeEventListener('resize', report)
  }, [report])

  return (
    <div className={`ov ${layout}`} data-testid="overlay">
      <div className="ov-list" ref={listRef} data-testid="overlaychat">
        {layout === 'panel' && messages.length === 0 && <p className="ov-empty">Nothing said yet</p>}
        {messages.map(m => m.kind === 'said' ? (
          <div className="ov-msg" data-chip key={m.id} data-testid="overlaymsg">
            <span className={`av sm t${tint(m.name)}`}>{initials(m.name)}</span>
            <span className="ov-txt"><b>{m.name}<i>{hhmm(m.atServerMs)}</i></b>{m.text}</span>
          </div>
        ) : (
          <p className="ov-sys" data-chip key={m.id} data-testid="overlaymsg"><b>{m.name}</b> {m.text}</p>
        ))}
      </div>
      {composing && (
        <div className="ov-compose" data-chip data-testid="overlaycompose">
          {/* A picture of the field in the main window, not a field. Everything
              typed goes there; this only has to look like where it is going. */}
          <p className="ov-input" data-testid="overlaydraft">
            {draft ? <span className="ov-typed">{draft}</span> : null}
            <span className="ov-caret" aria-hidden="true" />
            {!draft && <span className="ov-hint">Message the room — Enter to send, Esc to close</span>}
          </p>
        </div>
      )}
    </div>
  )
}
