import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, KeyboardEvent as ReactKeyEvent } from 'react'
import type { ChatMessage, State } from './types.js'
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
 * It is deliberately opaque. Translucency on X11 needs a compositing manager
 * running, and plenty of setups -- i3 without picom, for one -- have none, where
 * a transparent window paints black instead. An opaque panel looks the same
 * everywhere.
 */

const RECENT = 40

export function Overlay (): ReactElement {
  const [s, setS] = useState<State | null>(null)
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => window.cocine.onState(setS), [])

  // The overlay only ever shows the tail of the conversation; scrollback belongs
  // to the main window, where there is room for it.
  const messages: ChatMessage[] = (s?.messages ?? []).slice(-RECENT)
  useLayoutEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  useEffect(() => window.cocine.onFocusChat(() => inputRef.current?.focus()), [])

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void window.cocine.sendChat(text).catch(() => { /* the main window reports it */ })
  }

  return (
    <div className="ov" data-testid="overlay">
      <div className="ov-list" ref={listRef} data-testid="overlaychat">
        {messages.length === 0 && <p className="ov-empty">Nothing said yet</p>}
        {messages.map(m => m.kind === 'said' ? (
          <div className="ov-msg" key={m.id} data-testid="overlaymsg">
            <span className={`av sm t${tint(m.name)}`}>{initials(m.name)}</span>
            <span className="ov-txt"><b>{m.name}<i>{hhmm(m.atServerMs)}</i></b>{m.text}</span>
          </div>
        ) : (
          <p className="ov-sys" key={m.id} data-testid="overlaymsg"><b>{m.name}</b> {m.text}</p>
        ))}
      </div>
      <input
        ref={inputRef}
        className="ov-input"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={(e: ReactKeyEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') { e.preventDefault(); send() }
          // Handing focus back matters: while this window has it, the main
          // window's shortcuts -- space, seek, leaving fullscreen -- are dead.
          if (e.key === 'Escape') { e.preventDefault(); void window.cocine.releaseChatFocus() }
        }}
        placeholder="Message the room…"
        maxLength={800}
        data-testid="overlayinput"
      />
    </div>
  )
}
