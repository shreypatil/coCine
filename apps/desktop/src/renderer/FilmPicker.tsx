import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, KeyboardEvent as ReactKeyEvent } from 'react'
import type { DirEntry, Listing, Place } from './types.js'

/**
 * Choosing a film, without the operating system's dialog.
 *
 * It exists because Electron's fallback GTK chooser -- what runs on a Linux
 * desktop with no portal installed -- reports a double-click or Enter on a file
 * as a *cancellation*, so opening a film silently did nothing. The reasoning,
 * and the reproduction, are in main/browse.ts.
 *
 * Being ours rather than the system's, it can also be the thing the rest of the
 * application looks like, and can show only what can actually be played.
 */

const size = (b: number): string => {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`
  return `${(b / 1024).toFixed(0)} kB`
}

/** The path as clickable pieces. Mirrors main/browse.ts, for display only. */
function crumbs (dir: string): Place[] {
  const sep = dir.includes('\\') && !dir.startsWith('/') ? '\\' : '/'
  const parts = dir.split(/[/\\]+/).filter(Boolean)
  const root = sep === '/' ? '/' : `${parts.shift() ?? ''}\\`
  const out: Place[] = [{ label: root, path: root }]
  let at = root
  for (const part of parts) {
    at = at.endsWith(sep) ? at + part : at + sep + part
    out.push({ label: part, path: at })
  }
  return out
}

export function FilmPicker ({ onPick, onClose }: {
  onPick: (path: string) => void
  onClose: () => void
}): ReactElement {
  const [places, setPlaces] = useState<Place[]>([])
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [at, setAt] = useState(-1)
  const boxRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const go = useCallback(async (path: string, all = showAll) => {
    try {
      const l = await window.cocine.browseList(path, all)
      setListing(l)
      setAt(l.entries.length ? 0 : -1)
      setError(null)
      if (listRef.current) listRef.current.scrollTop = 0
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '') : String(e))
    }
  }, [showAll])

  // The video surface floats above the window's content, so it has to be out
  // of the way for any of this to be visible at all.
  useEffect(() => {
    void window.cocine.browseActive(true)
    let live = true
    void window.cocine.browseStart().then(s => {
      if (!live) return
      setPlaces(s.places)
      void go(s.path)
    }).catch(() => setError('Could not work out where to start'))
    return () => {
      live = false
      void window.cocine.browseActive(false)
    }
    // Deliberately once: reopening the picker is what re-runs this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { boxRef.current?.focus() }, [])

  const entries = listing?.entries ?? []
  const open = (e: DirEntry): void => {
    if (e.isDir) void go(e.path)
    else onPick(e.path)
  }

  const move = (delta: number): void => {
    if (!entries.length) return
    const next = Math.max(0, Math.min(entries.length - 1, (at < 0 ? 0 : at) + delta))
    setAt(next)
    const row = listRef.current?.children[next] as HTMLElement | undefined
    row?.scrollIntoView({ block: 'nearest' })
  }

  const onKey = (e: ReactKeyEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    else if (e.key === 'PageDown') { e.preventDefault(); move(10) }
    else if (e.key === 'PageUp') { e.preventDefault(); move(-10) }
    else if (e.key === 'Home') { e.preventDefault(); move(-entries.length) }
    else if (e.key === 'End') { e.preventDefault(); move(entries.length) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const chosen = entries[at]
      if (chosen) open(chosen)
    } else if (e.key === 'Backspace' && listing?.parent) {
      e.preventDefault()
      void go(listing.parent)
    }
  }

  const chosen = entries[at]

  return (
    <div className="picker-wrap" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div
        className="picker" role="dialog" aria-modal="true" aria-label="Choose a film"
        ref={boxRef} tabIndex={-1} onKeyDown={onKey} data-testid="picker"
      >
        <header className="pk-head">
          <h2>Choose a film</h2>
          <button className="mini" onClick={onClose} data-testid="pickerclose" aria-label="Close">esc</button>
        </header>

        <nav className="pk-crumbs" data-testid="pickercrumbs">
          {listing?.parent && (
            <button className="mini" data-testid="pickerup" title="Up one folder"
              onClick={() => void go(listing.parent!)}>↑</button>
          )}
          {listing && crumbs(listing.path).map(c => (
            <button key={c.path} className="crumb" onClick={() => void go(c.path)}>{c.label}</button>
          ))}
        </nav>

        <div className="pk-body">
          <ul className="pk-places" data-testid="pickerplaces">
            {places.map(p => (
              <li key={p.path}>
                <button className={listing?.path === p.path ? 'on' : ''} onClick={() => void go(p.path)}>{p.label}</button>
              </li>
            ))}
          </ul>

          <ul className="pk-list" ref={listRef} data-testid="pickerlist">
            {error && <li className="pk-msg" data-testid="pickererror">{error}</li>}
            {!error && !listing && <li className="pk-msg">Looking…</li>}
            {!error && listing && entries.length === 0 && (
              <li className="pk-msg" data-testid="pickerempty">
                {listing.filtered ? 'No films in this folder.' : 'This folder is empty.'}
              </li>
            )}
            {entries.map((e, i) => (
              <li
                key={e.path}
                className={`pk-row${i === at ? ' on' : ''}${e.isDir ? ' dir' : ''}`}
                data-testid={e.isDir ? 'pickerdir' : 'pickerfile'}
                data-name={e.name}
                onClick={() => setAt(i)}
                onDoubleClick={() => open(e)}
              >
                <span className="pk-icon" aria-hidden="true">
                  {e.isDir
                    ? <svg viewBox="0 0 16 16"><path d="M1.5 3.5h4l1.4 1.6h7.6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V3.5z" /></svg>
                    : <svg viewBox="0 0 16 16"><path d="M2 2.5h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zm4.4 2.9v5.2l4.4-2.6z" /></svg>}
                </span>
                <span className="pk-name">{e.name}</span>
                {!e.isDir && <span className="pk-size">{size(e.bytes)}</span>}
              </li>
            ))}
          </ul>
        </div>

        <footer className="pk-foot">
          <label className="toggle">
            <input type="checkbox" checked={showAll} data-testid="pickerall"
              onChange={ev => { setShowAll(ev.target.checked); if (listing) void go(listing.path, ev.target.checked) }} />
            Show every file
          </label>
          <span className="pk-hint">Double-click to open · Esc to close</span>
          <span className="grow" />
          <button className="btn" onClick={onClose} data-testid="pickercancel">Cancel</button>
          <button
            className="btn primary" data-testid="pickeropen"
            disabled={!chosen}
            onClick={() => { if (chosen) open(chosen) }}
          >
            {chosen?.isDir ? 'Open folder' : 'Open film'}
          </button>
        </footer>
      </div>
    </div>
  )
}
