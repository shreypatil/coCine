import { useEffect, useRef, useState, useCallback } from 'react'
import type { ReactElement, DragEvent as ReactDragEvent } from 'react'

interface Member { id: string; name: string; isHost: boolean; mayControl: boolean }
interface State {
  ready: boolean; connected: boolean; members: Member[]
  mediaName: string | null; durationSec: number | null
  positionSec: number; expectedSec: number | null; driftMs: number | null
  paused: boolean; rate: number
  clockOffsetMs: number | null; rttMs: number | null; lastAction: string | null
  fullscreen: boolean
}

declare global {
  interface Window {
    cocine: {
      setVideoSlot: (r: { x: number; y: number; width: number; height: number }) => Promise<unknown>
      openFile: () => Promise<{ path: string; name: string; durationSec: number | null } | null>
      openPath: (path: string) => Promise<{ path: string; name: string; durationSec: number | null }>
      pathForFile: (f: File) => string | null
      connect: (o: { url: string; roomCode: string; name: string }) => Promise<{ memberId: string }>
      disconnect: () => Promise<void>
      play: () => Promise<void>
      pause: () => Promise<void>
      seek: (sec: number) => Promise<void>
      setFullScreen: (on?: boolean) => Promise<boolean>
      onState: (cb: (s: State) => void) => () => void
    }
  }
}

const clock = (s: number | null | undefined): string => {
  if (s == null || !isFinite(s)) return '--:--:--'
  const t = Math.max(0, Math.floor(s))
  return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60]
    .map(n => String(n).padStart(2, '0')).join(':')
}

const initials = (name: string): string => name.trim().slice(0, 1).toUpperCase() || '?'
/** Stable per-name avatar tint, so the same person is the same colour every session. */
const tint = (name: string): number => {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 5
}

export function App (): ReactElement {
  const [s, setS] = useState<State | null>(null)
  const [url, setUrl] = useState('ws://127.0.0.1:8787')
  const [roomCode, setRoomCode] = useState('lounge')
  const [name, setName] = useState('me')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const slotRef = useRef<HTMLDivElement>(null)

  useEffect(() => window.cocine.onState(setS), [])

  // The main process needs the video rectangle in window coordinates so it can
  // keep the native surface exactly over this box. Report it on every change.
  useEffect(() => {
    const el = slotRef.current
    if (!el) return
    const push = (): void => {
      const r = el.getBoundingClientRect()
      void window.cocine.setVideoSlot({
        x: Math.round(r.x), y: Math.round(r.y),
        width: Math.round(r.width), height: Math.round(r.height)
      })
    }
    push()
    const ro = new ResizeObserver(push)
    ro.observe(el)
    window.addEventListener('resize', push)
    return () => { ro.disconnect(); window.removeEventListener('resize', push) }
  }, [])

  const guard = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      console.error(m)
      setError(m)
    } finally { setBusy(false) }
  }, [])

  const togglePlay = useCallback(() => {
    if (!s?.mediaName) return
    void guard(() => s.paused ? window.cocine.play() : window.cocine.pause())
  }, [s?.mediaName, s?.paused, guard])

  // Fullscreen has no visible controls yet -- nothing can be drawn over the
  // video until the overlay window exists -- so the keyboard is the whole
  // interface there. It works windowed too, which is what people expect.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      const pos = s?.positionSec ?? 0
      if (e.key === ' ') { e.preventDefault(); togglePlay() }
      else if (e.key === 'f' || e.key === 'F') { void window.cocine.setFullScreen() }
      else if (e.key === 'Escape' && s?.fullscreen) { void window.cocine.setFullScreen(false) }
      else if (e.key === 'ArrowRight' && s?.mediaName) { void guard(() => window.cocine.seek(pos + 10)) }
      else if (e.key === 'ArrowLeft' && s?.mediaName) { void guard(() => window.cocine.seek(Math.max(0, pos - 10))) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s?.positionSec, s?.mediaName, s?.fullscreen, togglePlay, guard])

  const onDrop = (e: ReactDragEvent): void => {
    e.preventDefault()
    setDropping(false)
    const f = e.dataTransfer.files[0]
    if (!f) return
    const path = window.cocine.pathForFile(f)
    if (!path) { setError('Could not read a path from that file'); return }
    void guard(() => window.cocine.openPath(path))
  }

  const duration = s?.durationSec ?? 0
  const drift = s?.driftMs
  const driftClass = drift == null ? '' : Math.abs(drift) <= 100 ? 'ok' : Math.abs(drift) <= 250 ? 'warn' : 'bad'
  const progress = duration > 0 ? Math.min(100, ((s?.positionSec ?? 0) / duration) * 100) : 0

  return (
    <div
      className={`app${s?.fullscreen ? ' fullscreen' : ''}${dropping ? ' dropping' : ''}`}
      onDragOver={(e: ReactDragEvent) => { e.preventDefault(); setDropping(true) }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <header className="topbar" data-testid="header">
        <span className="brand"><span className="mark" />coCine</span>
        {s?.connected && (
          <span className="pill"><span className="live" />{roomCode} · {s.members.length} watching</span>
        )}
        <span className="grow" />
        <button className="btn" data-testid="open" disabled={busy || !s?.ready}
          onClick={() => { console.log('open film clicked'); void guard(() => window.cocine.openFile()) }}>
          Open film
        </button>
        {s?.connected && (
          <button className="btn" disabled={busy} onClick={() => void guard(() => window.cocine.disconnect())}>Leave</button>
        )}
      </header>

      {error && (
        <div className="banner" role="alert" data-testid="banner">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">Dismiss</button>
        </div>
      )}

      <main className="body">
        {/* Intentionally empty. mpv's surface covers this box from launch, so
            anything rendered inside is never seen. */}
        <div className="stage" ref={slotRef} data-testid="stage" />

        <aside className="sidebar">
          {!s?.connected ? (
            <div className="sect join">
              <h4>Join a room</h4>
              <label>Server<input value={url} onChange={e => setUrl(e.target.value)} spellCheck={false} /></label>
              <label>Room<input value={roomCode} onChange={e => setRoomCode(e.target.value)} spellCheck={false} /></label>
              <label>Your name<input value={name} onChange={e => setName(e.target.value)} spellCheck={false} /></label>
              <button className="btn primary wide" disabled={busy || !s?.ready}
                onClick={() => void guard(() => window.cocine.connect({ url, roomCode, name }))}>
                Join room
              </button>
            </div>
          ) : (
            <>
              <div className="sect">
                <h4>Watching</h4>
                <ul className="people">
                  {s.members.map(m => (
                    <li key={m.id}>
                      <span className={`av t${tint(m.name)}`}>{initials(m.name)}</span>
                      <span className="nm">{m.name}</span>
                      {m.isHost && <span className="tag">host</span>}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="sect">
                <h4>In sync</h4>
                <div className="syncline">
                  <span className={`big ${driftClass}`}>{drift == null ? '—' : Math.abs(drift).toFixed(0)}<i>ms</i></span>
                  <span className="sub">drift · {s.rate.toFixed(3)}×</span>
                </div>
                <dl className="stats">
                  <dt>clock offset</dt><dd>{s.clockOffsetMs == null ? '—' : `${s.clockOffsetMs.toFixed(0)} ms`}</dd>
                  <dt>round trip</dt><dd>{s.rttMs == null ? '—' : `${s.rttMs.toFixed(1)} ms`}</dd>
                  <dt>room says</dt><dd>{clock(s.expectedSec)}</dd>
                </dl>
              </div>
              <div className="chat">
                <p className="soon">Chat arrives in phase 3.</p>
              </div>
            </>
          )}
          <div className="sect film">
            <h4>Film</h4>
            <p className="fname">{s?.mediaName ?? 'Nothing open'}</p>
            <p className="quiet">{duration > 0 ? `${clock(duration)} long` : 'Drop a file anywhere, or use Open film'}</p>
          </div>
        </aside>
      </main>

      <footer className="controls" data-testid="controls">
        <button className="play" data-testid="playpause" disabled={busy || !s?.mediaName}
          onClick={togglePlay} aria-label={s?.paused ? 'Play' : 'Pause'}>
          {s?.paused
            ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" /></svg>
            : <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3.4" height="11" rx="1" /><rect x="9.1" y="2.5" width="3.4" height="11" rx="1" /></svg>}
        </button>
        <span className="tc" data-testid="position">{clock(s?.positionSec)}</span>
        <span className="track" style={{ ['--p' as string]: `${progress}%` }}>
          <input
            className="scrub" type="range" min={0} max={Math.max(1, duration)} step={0.5}
            value={Math.min(s?.positionSec ?? 0, duration)}
            onChange={e => void guard(() => window.cocine.seek(Number(e.target.value)))}
            disabled={!s?.mediaName} aria-label="Seek"
          />
        </span>
        <span className="tc" data-testid="duration">{clock(duration)}</span>
        <button className="icon" data-testid="fullscreen" onClick={() => void window.cocine.setFullScreen()}
          aria-label="Toggle fullscreen">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 1h5v2H3v3H1zm14 0v5h-2V3h-3V1zM1 10h2v3h3v2H1zm14 0v5h-5v-2h3v-3z" /></svg>
        </button>
      </footer>
    </div>
  )
}
