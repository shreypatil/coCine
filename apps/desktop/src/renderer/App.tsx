import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import type { ReactElement, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyEvent } from 'react'
import { useVoice } from './useVoice.js'
import { FilmPicker } from './FilmPicker.js'
import { hhmm, initials, tint } from './format.js'
import { attachVideoEngine } from './videoEngine.js'
import { StageChat } from './StageChat.js'
import {
  SubtitleLayer, SubtitleControls, useSubtitles, DEFAULT_SUBTITLE_STYLE, type SubtitleStyle
} from './Subtitles.js'
import type { SubtitleFile } from './types.js'
import type { Library, State, StoredFilm } from './types.js'
import './types.js'

const size = (b: number): string => {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`
  return `${(b / 1024).toFixed(0)} kB`
}
/** Kept in step with the main process, which uses the same value. */
const DEFAULT_SERVER = 'ws://127.0.0.1:8787'

/**
 * Electron wraps anything thrown in a handler as
 * "Error invoking remote method 'x': Error: <the actual message>". The useful
 * part is the tail, and the prefix is noise in front of it.
 */
const humanise = (message: string): string =>
  message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(Error|TypeError):\s*/, '')

const rate = (b: number): string => b > 0 ? `${(b / 1024 ** 2).toFixed(1)} MB/s` : '—'
/** Countdowns read better rounded than exact; nobody needs 4 m 07 s. */
const countdown = (s: number | null): string => {
  if (s === null) return 'working it out'
  if (s <= 1) return 'any moment'
  if (s < 60) return `about ${Math.round(s)}s`
  const m = Math.round(s / 60)
  return m < 60 ? `about ${m} min` : `about ${(m / 60).toFixed(1)} hours`
}

/** A buffer, in the units a person would use for it. */
const buffered = (sec: number): string => {
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.round(sec / 60)
  return m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} hours`
}

const clock = (s: number | null | undefined): string => {
  if (s == null || !isFinite(s)) return '--:--:--'
  const t = Math.max(0, Math.floor(s))
  return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60]
    .map(n => String(n).padStart(2, '0')).join(':')
}
const pretty = (code: string): string => code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code

/**
 * How long the launch mark is on screen once it has started, and how long to
 * wait for the window before starting anyway.
 *
 * The timeline cannot begin at mount. Chromium throttles a window that is not
 * on screen yet -- CSS animations freeze and timers slow to roughly one a
 * second -- so an animation started then plays to an empty desktop, or worse,
 * is still frozen mid-way when the window finally appears. The main process
 * says when the window has been mapped; the fallback covers a state push that
 * never arrives, so a stuck mark can never hold the interface hostage.
 */
const SPLASH_MS = 1550
const SPLASH_ARM_FALLBACK_MS = 2500

/**
 * The mark, drawn on and then gone.
 *
 * It covers the window rather than delaying it: the application is already
 * loading underneath, nothing waits for this, and it lets no clicks through to
 * be swallowed. Someone who has asked for reduced motion never sees it -- the
 * stylesheet hides it outright -- so it is decoration in the honest sense.
 */
function Splash ({ onDone }: { onDone: () => void }): ReactElement {
  return (
    <div
      className="splash" data-testid="splash" aria-hidden="true"
      // The mark's own pieces animate too and their events bubble; only the
      // container's fade-out means the thing is finished.
      onAnimationEnd={e => { if (e.target === e.currentTarget) onDone() }}
    >
      <div className="splash-inner">
        <svg viewBox="0 0 40 40">
          <defs>
            <linearGradient id="splashgrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#7B5CFF" />
              <stop offset="0.55" stopColor="#B053C8" />
              <stop offset="1" stopColor="#D14FA8" />
            </linearGradient>
          </defs>
          <rect className="frame" x="2.5" y="7" width="35" height="26" rx="8"
            fill="none" stroke="url(#splashgrad)" strokeWidth="2" strokeLinecap="round" />
          <circle className="m1" cx="15.5" cy="20" r="4.1" fill="url(#splashgrad)" />
          <circle className="m2" cx="25" cy="20" r="4.1" fill="none" stroke="url(#splashgrad)" strokeWidth="1.7" />
        </svg>
        <div className="word">coCine</div>
        <div className="tag">watch together</div>
      </div>
    </div>
  )
}

/**
 * Which parts of the film somebody holds.
 *
 * Sixty-four slices, each 0 to 15 full, straight from the peer's own report.
 * "How much" is a percentage; this is "which bits", which is the difference
 * between somebody who is merely behind and somebody who is missing the stretch
 * about to be watched.
 */
function PieceStrip ({ map, title }: { map?: string; title: string }): ReactElement | null {
  if (!map) return null
  return (
    <div className="strip" data-testid="piecestrip" data-map={map} title={title} aria-hidden="true">
      {[...map].map((c, i) => {
        const held = parseInt(c, 16) / 15
        return <span key={i} className={held >= 1 ? 'full' : held > 0 ? 'part' : ''} style={{ opacity: 0.16 + held * 0.84 }} />
      })}
    </div>
  )
}

export function App (): ReactElement {
  const [s, setS] = useState<State | null>(null)
  const [url, setUrl] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [name, setName] = useState('')
  const [identityLoaded, setIdentityLoaded] = useState(false)
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [view, setView] = useState<'room' | 'films'>('room')
  // What the host settles before anybody else arrives. Held here rather than
  // pushed at the server, because until the room exists there is nothing to
  // push at -- they travel with the creating connection.
  const [optMode, setOptMode] = useState<'p2p' | 'origin'>('p2p')
  const [optOpenControl, setOptOpenControl] = useState(true)
  const [optWaitLate, setOptWaitLate] = useState(true)
  const [picking, setPicking] = useState(false)
  const [splash, setSplash] = useState(true)
  const [armed, setArmed] = useState(false)
  const [library, setLibrary] = useState<Library | null>(null)
  /** Subtitle files beside the film, which of them is on, and how it looks. */
  const [subFiles, setSubFiles] = useState<SubtitleFile[]>([])
  const [subPath, setSubPath] = useState<string | null>(null)
  const [subStyle, setSubStyle] = useState<SubtitleStyle>(DEFAULT_SUBTITLE_STYLE)
  /**
   * What is being typed into the fullscreen chat, or null when it is closed.
   *
   * The field is here rather than in the overlay window because the overlay is
   * reparented into this window on X11, so the window manager will not give it
   * the keyboard -- it opened a composer that looked ready and dropped every
   * keystroke. This window has the keyboard already, and in fullscreen its own
   * content is behind the video, so the field is invisible here and is drawn by
   * the overlay instead.
   */
  const [fsDraft, setFsDraft] = useState<string | null>(null)
  const fsInputRef = useRef<HTMLInputElement>(null)
  const slotRef = useRef<HTMLDivElement>(null)
  /** The film itself, when this build renders it here rather than in a child
   *  window. Null under the mpv engine, where the stage stays an empty box. */
  const videoRef = useRef<HTMLVideoElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)

  const memberIds = (s?.members ?? []).filter(m => m.inVoice || m.id === s?.memberId).map(m => m.id)
  const voice = useVoice(s?.memberId ?? '', memberIds, s?.voiceIce ?? [])

  useEffect(() => window.cocine.onState(setS), [])

  // Start the mark only once the window is really on screen. Until then a
  // hidden window's animations are frozen, so it would either be missed or be
  // caught half-finished.
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), SPLASH_ARM_FALLBACK_MS)
    return () => clearTimeout(t)
  }, [])
  useEffect(() => { if (s?.windowShown) setArmed(true) }, [s?.windowShown])

  // Taken off the page once it has faded, so nothing is left over the interface
  // holding a compositing layer for the rest of the session. The animation's own
  // end event is the primary signal; the timer is the guarantee.
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setSplash(false), SPLASH_MS)
    return () => clearTimeout(t)
  }, [armed])

  // Who you were last time. Loaded once, before anything is typed, so the join
  // panel is filled in rather than asking for the same three answers every launch.
  useEffect(() => {
    let live = true
    void window.cocine.getIdentity().then(id => {
      if (!live) return
      setName(id.name)
      setUrl(id.server)
      setJoinCode(id.lastCode ?? '')
      setIdentityLoaded(true)
    }).catch(() => setIdentityLoaded(true))
    return () => { live = false }
  }, [])

  // The main process needs the video rectangle in window coordinates so it can
  // keep the native surface exactly over this box. Report it on every change.
  useEffect(() => {
    const el = slotRef.current
    if (!el) return
    const push = (): void => {
      const r = el.getBoundingClientRect()
      // The viewport goes with it: the main process cannot otherwise tell where
      // this page's origin sits inside the window, and a menu bar it does not
      // know about put the video over the top bar.
      void window.cocine.setVideoSlot({
        x: Math.round(r.x), y: Math.round(r.y),
        width: Math.round(r.width), height: Math.round(r.height),
        viewport: { width: window.innerWidth, height: window.innerHeight }
      })
    }
    push()
    const ro = new ResizeObserver(push)
    ro.observe(el)
    window.addEventListener('resize', push)
    return () => { ro.disconnect(); window.removeEventListener('resize', push) }
  }, [])

  // Follow the conversation, but only when already at the bottom -- yanking the
  // view down while someone is reading back is worse than missing a line.
  //
  // Whether we were at the bottom has to be recorded while scrolling, not
  // measured afterwards: by the time the effect runs the new messages have
  // already grown scrollHeight, so the check always reads as "scrolled up" and
  // the view never follows -- including on first load with a backlog.
  const count = s?.messages.length ?? 0
  const stick = useRef(true)
  const onChatScroll = (): void => {
    const el = chatRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
  }
  useLayoutEffect(() => {
    const el = chatRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [count])

  const refreshLibrary = useCallback(async () => {
    try { setLibrary(await window.cocine.listFilms()) } catch { setLibrary(null) }
  }, [])

  // Refresh while the library is on screen, so a transfer's growing file and a
  // deletion elsewhere both show up without needing a reload.
  useEffect(() => {
    if (view !== 'films') return
    void refreshLibrary()
    const iv = setInterval(() => void refreshLibrary(), 2000)
    return () => clearInterval(iv)
  }, [view, refreshLibrary])

  const guard = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) {
      const m = humanise(e instanceof Error ? e.message : String(e))
      console.error(m)
      setError(m)
    } finally { setBusy(false) }
  }, [])

  // Read inside the key handler, which is registered once and must not be
  // re-registered on every open and close.
  const pickingRef = useRef(false)
  pickingRef.current = picking
  /** Read inside the key handler, which must not be re-registered whenever the
   *  room's holdings change. */
  const clampRef = useRef<(sec: number) => number>((sec: number) => sec)

  const togglePlay = useCallback(() => {
    if (!s?.mediaName) return
    void guard(() => s.paused ? window.cocine.play() : window.cocine.pause())
  }, [s?.mediaName, s?.paused, guard])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      // The picker has the screen and its own keys; space must not reach the
      // film underneath it.
      if (pickingRef.current) return
      const pos = s?.positionSec ?? 0
      if (e.key === ' ') { e.preventDefault(); togglePlay() }
      else if (e.key === 'f' || e.key === 'F') { void window.cocine.setFullScreen() }
      else if (e.key === 'Escape' && s?.fullscreen) { void window.cocine.setFullScreen(false) }
      else if (e.key === 'ArrowRight' && s?.mediaName) { void guard(() => window.cocine.seek(clampRef.current(pos + 10))) }
      else if (e.key === 'ArrowLeft' && s?.mediaName) { void guard(() => window.cocine.seek(clampRef.current(pos - 10))) }
      // Fullscreen has no visible composer until it is asked for; this is how
      // it is asked for. The overlay takes the keyboard and hands it back on
      // Escape, so the shortcuts here are only dead while someone is typing.
      else if (e.key === 'Enter' && s?.fullscreen && s?.connected) { e.preventDefault(); setFsDraft('') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s?.positionSec, s?.mediaName, s?.fullscreen, s?.connected, togglePlay, guard])

  // Under the mpv engine the draft has to be shipped to the overlay window to be
  // drawn, because the field cannot live there. Under the <video> engine the
  // field and the film are in the same window and there is nothing to send.
  useEffect(() => {
    if (s?.playerEngine === 'html') return
    void window.cocine.setOverlayDraft?.(fsDraft)
  }, [fsDraft, s?.playerEngine])
  // Leaving fullscreen takes the overlay away with it, so the field goes too.
  useEffect(() => { if (!s?.fullscreen) setFsDraft(null) }, [s?.fullscreen])
  useEffect(() => { if (fsDraft !== null) fsInputRef.current?.focus() }, [fsDraft !== null])

  const sendFullscreen = (): void => {
    const text = (fsDraft ?? '').trim()
    setFsDraft(null)
    if (text) void guard(() => window.cocine.sendChat(text))
  }

  // The main process holds the sync engine and drives this element through
  // PlayerController, exactly as it drives mpv. Attached only while there is an
  // element to attach to, and detached with it.
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const engine = attachVideoEngine(el)
    return () => engine.stop()
  }, [s?.playerEngine])

  /**
   * Which part of the film the room can actually reach, from the map the
   * server broadcasts (see readiness.seekableBuckets). Drawn on the seek bar
   * and used to clamp the keyboard, so a refused seek is something you can see
   * coming rather than an error banner after the fact.
   */
  const seekable = useMemo(() => {
    const map = s?.transferStatus?.seekableMap
    const total = s?.durationSec ?? 0
    if (!map || !(total > 0)) return null
    const per = total / map.length
    const held = (i: number): boolean => map[i] === 'f'
    const here = Math.min(map.length - 1, Math.max(0, Math.floor(((s?.positionSec ?? 0) / total) * map.length)))
    if (!held(here)) return { fromSec: 0, toSec: total, limited: false }
    let lo = here; let hi = here
    while (lo > 0 && held(lo - 1)) lo--
    while (hi < map.length - 1 && held(hi + 1)) hi++
    const fromSec = lo * per
    const toSec = Math.min(total, (hi + 1) * per)
    return { fromSec, toSec, limited: fromSec > 0.5 || toSec < total - 0.5 }
  }, [s?.transferStatus?.seekableMap, s?.durationSec, s?.positionSec])

  /** Keep a seek inside what the room holds, so the keys never ask for a
   *  refusal the interface could have avoided. */
  const clampSeek = useCallback((sec: number): number => {
    if (!seekable) return Math.max(0, sec)
    return Math.max(seekable.fromSec, Math.min(sec, Math.max(seekable.fromSec, seekable.toSec - 0.5)))
  }, [seekable])
  clampRef.current = clampSeek

  const findSubtitles = useCallback(() => {
    void window.cocine.subtitlesBeside?.()
      .then(r => setSubFiles(r.files))
      .catch(() => setSubFiles([]))
  }, [])

  // A new film means new subtitles, and the old choice is meaningless against
  // it -- keeping it would draw one film's dialogue over another's picture.
  useEffect(() => {
    setSubPath(null)
    if (!s?.mediaName) { setSubFiles([]); return }
    findSubtitles()
  }, [s?.mediaName, findSubtitles])

  const { cues: subCues, error: subError } = useSubtitles(subPath)

  const onDrop = (e: ReactDragEvent): void => {
    e.preventDefault()
    setDropping(false)
    const f = e.dataTransfer.files[0]
    if (!f) return
    const path = window.cocine.pathForFile(f)
    if (!path) { setError('Could not read a path from that file'); return }
    void guard(() => window.cocine.openPath(path))
  }

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void guard(() => window.cocine.sendChat(text))
  }

  const copyCode = (): void => {
    if (!s?.code) return
    void navigator.clipboard.writeText(pretty(s.code)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    }).catch(() => setError('Could not copy to the clipboard'))
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
      {s?.fullscreen && fsDraft !== null && s?.playerEngine !== 'html' && (
        // mpv engine only. Deliberately invisible: in fullscreen this window's
        // content is behind the video surface, and the overlay window is what
        // the viewer actually sees. It has to be a real focused input all the
        // same, so that composition, dead keys and selection behave the way a
        // text field should. The <video> engine has no need for any of this --
        // its composer is visible, in StageChat, in this window.
        <input
          ref={fsInputRef}
          className="fscompose"
          value={fsDraft}
          maxLength={800}
          aria-label="Message the room"
          data-testid="fscompose"
          onChange={e => setFsDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); sendFullscreen() }
            if (e.key === 'Escape') { e.preventDefault(); setFsDraft(null) }
          }}
          // Keep the field: in fullscreen there is nothing else here to click,
          // so losing focus means something took it by accident. Guarded on the
          // window still being focused, or switching away from the application
          // would turn into a fight over the keyboard.
          onBlur={() => { if (fsDraft !== null && document.hasFocus()) fsInputRef.current?.focus() }}
        />
      )}
      <header className="topbar" data-testid="header">
        <span className="brand">
          <svg className="mark" viewBox="0 0 40 40" aria-hidden="true">
            <defs>
              <linearGradient id="markgrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#7B5CFF" />
                <stop offset="0.55" stopColor="#B053C8" />
                <stop offset="1" stopColor="#D14FA8" />
              </linearGradient>
            </defs>
            <rect x="1.5" y="6" width="37" height="28" rx="9" fill="url(#markgrad)" />
            <rect x="4.5" y="9" width="31" height="22" rx="6.5" fill="#0B0812" />
            {/* Two playheads in step: the whole product in one mark. */}
            <circle className="m1" cx="15.5" cy="20" r="4.1" fill="url(#markgrad)" />
            <circle className="m2" cx="25" cy="20" r="4.1" fill="none" stroke="url(#markgrad)" strokeWidth="1.7" />
          </svg>
          <span className="wordmark">coCine</span>
        </span>
        {s?.connected && s.code && (
          <button className="pill code" data-testid="code" onClick={copyCode} title="Copy the room code">
            <span className="live" />{pretty(s.code)}
            <span className="copy">{copied ? 'copied' : 'copy'}</span>
          </button>
        )}
        {s?.connection === 'reconnecting' && (
          <span className="pill recon" role="status" data-testid="reconnecting"
            title="The connection dropped; trying to rejoin">
            <span className="spin" />reconnecting
          </span>
        )}
        {s?.connected && s.connection === 'connected' && (
          <span className={`pill sync ${driftClass}`} data-testid="drift"
            title="How far this screen is from the rest of the room">
            {drift == null ? '—' : `${Math.abs(drift).toFixed(0)} ms`}
          </span>
        )}
        <span className="grow" />
        <button className="btn" data-testid="open" disabled={busy || !s?.ready || !s?.connected}
          title={s?.connected ? undefined : 'Create or join a room first — a film is always watched with somebody'}
          onClick={() => {
            // Whatever the mark is still doing, it stops here: it covers the
            // whole window, and what comes next has to be reachable.
            setSplash(false)
            // The system dialog is only used where it can be trusted to return
            // what was chosen; on Linux it cannot. See main/browse.ts.
            if (s?.nativePicker) void guard(() => window.cocine.openFile())
            else setPicking(true)
          }}>
          Open film
        </button>
        <button className={view === 'films' ? 'btn on' : 'btn'} data-testid="films"
          onClick={() => setView(v => v === 'films' ? 'room' : 'films')}>Films</button>
        {s?.connected && (
          <button className="btn" data-testid="leave" disabled={busy}
            onClick={() => void guard(() => window.cocine.disconnect())}>Leave</button>
        )}
      </header>

      {s?.startupError && (
        <div className="wall" role="alert" data-testid="startuperror">
          <div className="wall-card">
            <h2>{s.startupError.message}</h2>
            {s.startupError.howToInstall && (
              <>
                <p>coCine plays films with mpv, which is not on this machine yet. Paste this into a terminal:</p>
                <p className="wall-cmd" data-testid="installcmd">{s.startupError.howToInstall}</p>
                <button className="btn" data-testid="copycmd"
                  onClick={() => {
                    void navigator.clipboard.writeText(s.startupError!.howToInstall)
                      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400) })
                      .catch(() => setError('Could not copy to the clipboard'))
                  }}>
                  {copied ? 'Copied' : 'Copy the command'}
                </button>
              </>
            )}
            <p className="quiet">Then start coCine again.</p>
          </div>
        </div>
      )}

      {splash && armed && <Splash onDone={() => setSplash(false)} />}

      {picking && (
        <FilmPicker
          onClose={() => setPicking(false)}
          onPick={path => {
            setPicking(false)
            void guard(() => window.cocine.openPath(path))
          }}
        />
      )}

      {error && (
        <div className="banner" role="alert" data-testid="banner">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">Dismiss</button>
        </div>
      )}

      <main className="body">
        {/* mpv's surface covers this box exactly, but only once a film is
            open -- so this is the one moment anything drawn here can be seen,
            and it is worth saying what to do rather than showing a black
            rectangle. Nothing inside may change the box's size. */}
        <div className="stage" ref={slotRef} data-testid="stage">
          {/* Under the mpv engine this box stays empty and a native surface is
              positioned over it. Under the <video> engine the film is here, in
              this window, with everything else drawn above it in ordinary DOM. */}
          {s?.playerEngine === 'html' && subPath && (
            <SubtitleLayer cues={subCues} positionSec={s?.positionSec ?? 0} style={subStyle} />
          )}
          {s?.playerEngine === 'html' && s?.fullscreen && s?.connected && (
            <StageChat
              messages={s.messages ?? []}
              draft={fsDraft}
              onDraftChange={setFsDraft}
              onSend={sendFullscreen}
              onClose={() => setFsDraft(null)}
            />
          )}
          {s?.playerEngine === 'html' && (
            <video
              ref={videoRef}
              className="stagefilm"
              data-testid="film"
              playsInline
              // The sync engine decides when a film starts; a player that began
              // on its own would be a peer nobody scheduled.
              autoPlay={false}
              controls={false}
            />
          )}
          {s?.converting && (
            // A repack is over before anybody wonders what happened, but a
            // transcode of a feature-length film is minutes -- and doing that
            // silently looks exactly like the application having hung.
            <div className="converting" data-testid="converting">
              <h1>Preparing {s.converting.name}</h1>
              <p className="quiet">{s.converting.reason}.</p>
              {s.converting.slow && (
                <p className="quiet small">
                  This one has to be re-encoded, which takes a few minutes. mpv
                  plays this format without converting it.
                </p>
              )}
              <div className="convbar">
                <span style={{ width: `${Math.round((s.converting.progress ?? 0) * 100)}%` }} />
              </div>
            </div>
          )}
          {!s?.mediaName && !s?.receiving && !s?.converting && (
            <div className="welcome" data-testid="welcome">
              <svg viewBox="0 0 40 40" aria-hidden="true" className="wl-mark">
                <defs>
                  <linearGradient id="wlgrad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#7B5CFF" />
                    <stop offset="0.55" stopColor="#B053C8" />
                    <stop offset="1" stopColor="#D14FA8" />
                  </linearGradient>
                </defs>
                <rect x="2.5" y="7" width="35" height="26" rx="8" fill="none"
                  stroke="url(#wlgrad)" strokeWidth="1.6" />
                <circle cx="15.5" cy="20" r="4.1" fill="url(#wlgrad)" />
                <circle cx="25" cy="20" r="4.1" fill="none" stroke="url(#wlgrad)" strokeWidth="1.6" />
              </svg>
              <h1>{s?.connected ? 'Put a film on' : 'Start with a room'}</h1>
              {s?.connected
                ? <p>Drag one into this window, or use <b>Open film</b>.</p>
                : <p>Create one and send the code to whoever is watching. Then put a film on.</p>}
              <p className="wl-quiet">
                {s?.connected
                  ? 'It plays here first, on your machine only. When you are ready, Start sharing sends it to the room — nobody else has to find their own copy.'
                  : 'A film is always watched with somebody, so the room comes first.'}
              </p>
            </div>
          )}
        </div>

        <aside className="sidebar">
          {view === 'films' ? (
            <div className="sect library" data-testid="library">
              <h4>Films on this machine</h4>
              {!library || library.films.length === 0
                ? <p className="quiet">Nothing stored yet. Films you receive are kept here.</p>
                : (
                  <ul className="filmlist">
                    {library.films.map(f => (
                      <li key={f.infoHash} data-testid="storedfilm" data-name={f.name}>
                        <span className="fl-name">{f.name}</span>
                        <span className="fl-meta">
                          {f.complete ? size(f.bytes) : `${size(f.onDiskBytes)} of ${size(f.bytes)}`}
                          {!f.complete && <em> partial</em>}
                        </span>
                        <button className="mini" data-testid="removefilm"
                          onClick={() => void guard(async () => { await window.cocine.removeFilm(f.infoHash); await refreshLibrary() })}>
                          delete
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              {library && (
                <p className="quiet space">{size(library.usedBytes)} used · {size(library.freeBytes)} free on disk</p>
              )}
            </div>
          ) : !s?.connected ? (
            <div className="sect join">
              <h4>Watch together</h4>
              <label>Your name<input value={name} onChange={e => setName(e.target.value)} spellCheck={false} data-testid="name" /></label>
              <label>
                Server
                <input value={url} onChange={e => setUrl(e.target.value)} spellCheck={false} data-testid="server" />
                {url !== DEFAULT_SERVER && (
                  <button className="mini reset" data-testid="resetserver"
                    onClick={() => setUrl(DEFAULT_SERVER)}>use default</button>
                )}
              </label>
              <div className="opts" data-testid="roomoptions">
                <h5>Your room</h5>
                <label className="opt">
                  How the film is shared
                  <select className="sel" value={optMode} data-testid="optmode"
                    onChange={e => setOptMode(e.target.value as 'p2p' | 'origin')}>
                    <option value="p2p">Between us — peer to peer</option>
                    <option value="origin">Through the server — relay</option>
                  </select>
                </label>
                <p className="quiet small">
                  {optMode === 'p2p'
                    ? 'Everyone shares with everyone. Free, and faster the more people there are — but it needs peers who can reach each other.'
                    : 'You upload once and everyone downloads from the server. Works when peer to peer cannot, and costs whoever runs the server. If that server has no storage, the room falls back to peer to peer and says so.'}
                </p>
                <label className="opt">
                  Who can control playback
                  <select className="sel" value={optOpenControl ? 'everyone' : 'host'} data-testid="optcontrol"
                    onChange={e => setOptOpenControl(e.target.value === 'everyone')}>
                    <option value="everyone">Everyone in the room</option>
                    <option value="host">Only me</option>
                  </select>
                </label>
                <label className="toggle">
                  <input type="checkbox" checked={optWaitLate} data-testid="optlate"
                    onChange={e => setOptWaitLate(e.target.checked)} />
                  Pause when someone arrives late
                </label>
                <p className="quiet small">All three can be changed later, by whoever is host.</p>
              </div>
              <button className="btn primary wide" data-testid="create" disabled={busy || !s?.ready || !identityLoaded || !name.trim()}
                onClick={() => void guard(() => window.cocine.connect({
                  url,
                  code: null,
                  name,
                  options: { mode: optMode, openControl: optOpenControl, waitForLatecomers: optWaitLate }
                }))}>
                Create a room
              </button>
              <div className="or"><span>or join one</span></div>
              <p className="quiet small">Joining takes the room's settings as the host left them.</p>
              <div className="joinrow">
                <input value={joinCode} onChange={e => setJoinCode(e.target.value)} placeholder="CODE" spellCheck={false} data-testid="joincode" />
                <button className="btn" data-testid="join" disabled={busy || !s?.ready || !identityLoaded || !name.trim() || !joinCode.trim()}
                  onClick={() => void guard(() => window.cocine.connect({ url, code: joinCode.trim(), name }))}>
                  Join
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="sect">
                <h4>Watching · {s.members.length}</h4>
                <ul className="people">
                  {s.members.map(m => (
                    <li key={m.id} data-testid="member" data-name={m.name}>
                      <span className={`av t${tint(m.name)}`}>{initials(m.name)}</span>
                      <span className="nm">{m.name}</span>
                      {m.inVoice && (() => {
                        const link = m.id === s.memberId ? 'connected' : voice.peers[m.id]
                        const cls = m.muted ? 'off' : link === 'failed' ? 'bad' : link === 'connecting' ? 'wait' : ''
                        const why = link === 'failed'
                          ? `No voice connection to ${m.name} — usually a firewall`
                          : link === 'connecting' ? `Connecting to ${m.name}…`
                          : m.muted ? `${m.name} is muted` : `${m.name} is in voice`
                        return <span className={`vdot ${cls}`} data-testid="vdot" data-link={link ?? 'none'} title={why} />
                      })()}
                      {m.deafened && <span className="tag muted" title="Cannot hear the room">deafened</span>}
                      {m.isHost && <span className="tag">host</span>}
                      {!m.mayControl && !m.isHost && <span className="tag muted" title="Cannot control playback">no control</span>}
                      {s.isHost && !m.isHost && (
                        <span className="rowacts">
                          {/* Spelled out rather than abbreviated: `take` and
                              `give` meant nothing without hovering for the
                              tooltip, and this is the panel a guest reads. */}
                          <button className="mini" data-testid="togglecontrol"
                            title={m.mayControl ? `Stop ${m.name} controlling playback` : `Let ${m.name} control playback`}
                            onClick={() => void guard(() => window.cocine.setControl(m.id, !m.mayControl))}>
                            {m.mayControl ? 'take control' : 'give control'}
                          </button>
                          <button className="mini" data-testid="makehost" title={`Make ${m.name} the host`}
                            onClick={() => void guard(() => window.cocine.transferHost(m.id))}>make host</button>
                          {m.inVoice && (
                            <button className="mini" data-testid="mutethem"
                              title="Ask them to mute — advisory, their client chooses to comply"
                              onClick={() => void guard(() => window.cocine.moderateVoice(m.id, m.muted ? 'unmute' : 'mute'))}>
                              {m.muted ? 'ask to unmute' : 'ask to mute'}
                            </button>
                          )}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {s.isHost && (
                  <label className="toggle hostopt">
                    <input type="checkbox" checked={s.openControl} data-testid="opencontrol"
                      onChange={e => void guard(() => window.cocine.setOpenControl(e.target.checked))} />
                    Anyone who joins can control playback
                  </label>
                )}
              </div>

              {s.transferStatus && s.transferStatus.perPeer.length > 0 && (s.mediaName ?? s.receiving) && (
                <div className="sect gate" data-testid="gate">
                  <h4>{s.phase === 'preparing' ? 'Getting everyone ready' : s.phase === 'ready' ? 'Everyone is ready' : 'Transfer'}</h4>
                  {s.phase === 'preparing' && (
                    <p className="gate-eta" data-testid="eta">
                      {countdown(s.transferStatus.etaSec)}
                      {s.transferStatus.bottleneck && <span> · waiting on <b>{s.transferStatus.bottleneck}</b></span>}
                    </p>
                  )}
                  {/* Everything this machine is doing, in one line: the number
                      the person sharing actually wants, and cannot otherwise
                      see anywhere. */}
                  {(() => {
                    const me = s.transferStatus!.perPeer.find(p => p.memberId === s.memberId)
                    if (!me) return null
                    return (
                      <p className="quiet mine" data-testid="mytransfer">
                        you: <b>↑ {rate(me.upBps)}</b> · ↓ {rate(me.downBps)} · {me.peers} {me.peers === 1 ? 'peer' : 'peers'}
                        {s.sharing === 'paused' && <span className="pausedtag"> · sharing paused</span>}
                      </p>
                    )
                  })()}
                  <ul className="peers">
                    {s.transferStatus.perPeer.map(p => (
                      <li key={p.memberId} data-testid="peerstatus" data-name={p.name}
                        className={p.ready ? 'ok' : 'behind'}>
                        <span className="pn">
                          {p.name}
                          {p.memberId === s.memberId && <em> · you</em>}
                          {p.sharer && <span className="tag src" title="Put this film on">source</span>}
                          {p.paused && <span className="tag muted" title="They have paused their sharing">paused</span>}
                        </span>
                        <span className={`pv ${p.ready ? 'ok' : ''}`}>{Math.round(p.havePct * 100)}%</span>
                        <span className="pd" title="Their download rate, then upload">
                          ↓{rate(p.downBps)} ↑{rate(p.upBps)}
                        </span>
                        {/* The strip says how much *and* where, so a plain
                            progress bar beside it would only repeat half of it. */}
                        {p.pieces
                          ? <PieceStrip map={p.pieces} title={`Which parts of the film ${p.name} holds`} />
                          : <div className="bar"><span style={{ width: `${Math.round(p.havePct * 100)}%` }} /></div>}
                        <span className="pw" data-testid="peerwhen">
                          {p.havePct >= 0.999
                            ? 'has the whole film'
                            : p.ready
                              ? `${buffered(p.bufferEndSec)} ahead of the playhead`
                              : s.transferStatus!.bottleneck === p.name ? 'furthest behind' : 'still filling up'}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {s.phase === 'preparing' && s.transferStatus.tMinSec !== null && (
                    <p className="quiet" data-testid="floor">
                      fastest possible {countdown(s.transferStatus.tMinSec)} — nothing can beat that
                    </p>
                  )}
                  <p className={s.transferStatus.safeForSharerToLeave ? 'quiet safe' : 'quiet'} data-testid="durability">
                    {s.transferStatus.safeForSharerToLeave
                      ? 'Safe for the sharer to leave — the room has a second full copy'
                      : `${s.transferStatus.fullCopies} full ${s.transferStatus.fullCopies === 1 ? 'copy' : 'copies'} in the room — the film needs the sharer for now`}
                  </p>
                  {s.isHost && (s.phase === 'preparing' || s.phase === 'ready') && (
                    <div className="gate-acts">
                      {s.phase === 'preparing' && (
                        <button className="btn" data-testid="startanyway"
                          onClick={() => void guard(() => window.cocine.startAnyway())}>
                          Start without {s.transferStatus.perPeer.filter(p => !p.ready).map(p => p.name).join(', ')}
                        </button>
                      )}
                      <label className="toggle">
                        <input type="checkbox" checked={s.waitForLatecomers} data-testid="waitlate"
                          onChange={e => void guard(() => window.cocine.setWaitForLatecomers(e.target.checked))} />
                        Pause when someone arrives late
                      </label>
                    </div>
                  )}
                </div>
              )}

              <div className="sect voice" data-testid="voice">
                <h4>Voice</h4>
                {!voice.inVoice ? (
                  <>
                    <button className="btn primary wide" data-testid="joinvoice"
                      onClick={() => void voice.join()}>Join voice</button>
                    <p className="quiet">Hold <b>V</b> to talk. Headphones strongly recommended.</p>
                  </>
                ) : (
                  <>
                    <div className="vbar">
                      <button className={voice.muted ? 'mini on' : 'mini'} data-testid="mute"
                        onClick={() => voice.setMuted(!voice.muted)}>{voice.muted ? 'unmute' : 'mute'}</button>
                      <button className={voice.deafened ? 'mini on' : 'mini'} data-testid="deafen"
                        onClick={() => voice.setDeafened(!voice.deafened)}>{voice.deafened ? 'undeafen' : 'deafen'}</button>
                      <button className="mini" data-testid="leavevoice" onClick={voice.leave}>leave</button>
                    </div>
                    <label className="toggle">
                      <input type="checkbox" checked={voice.pushToTalk} data-testid="ptt"
                        onChange={e => voice.setPushToTalk(e.target.checked)} />
                      Push to talk (hold V)
                    </label>
                    {(() => {
                      // Joining a call and being connected to the people in it
                      // are different things, and only one of them was visible.
                      // "Both joined and heard nothing" has two very different
                      // causes -- nobody held the talk key, or the peer
                      // connections never came up -- and this separates them.
                      const states = Object.values(voice.peers)
                      const connected = states.filter(v => v === 'connected').length
                      const failed = states.filter(v => v === 'failed').length
                      const connecting = states.filter(v => v === 'connecting').length
                      if (states.length === 0) return <p className="quiet" data-testid="voicepeers">Nobody else is in voice yet.</p>
                      return (
                        <p className={failed ? 'quiet vwarn' : 'quiet'} data-testid="voicepeers">
                          {connected > 0 && `Connected to ${connected} of ${states.length}`}
                          {connected > 0 && (connecting || failed) ? ' · ' : ''}
                          {connecting > 0 && `${connecting} connecting`}
                          {connecting > 0 && failed ? ' · ' : ''}
                          {failed > 0 && `${failed} could not connect — a firewall is the usual reason`}
                        </p>
                      )
                    })()}
                    <p className={voice.talking ? 'quiet talking' : 'quiet'} data-testid="talkstate">
                      {voice.muted ? 'Microphone off'
                        : voice.pushToTalk ? (voice.talking ? 'Talking' : 'Hold V to talk')
                        : 'Microphone open'}
                    </p>
                    <p className="quiet">
                      The film quietens while you talk, because echo cancellation cannot hear it.
                    </p>
                  </>
                )}
                {voice.error && <p className="quiet vwarn" data-testid="voiceerror">{voice.error}</p>}
              </div>

              <div className="chatwrap">
                <h4>Chat</h4>
                <div className="chat" ref={chatRef} onScroll={onChatScroll} data-testid="chat">
                  {s.messages.length === 0 && <p className="soon">Nothing said yet.</p>}
                  {s.messages.map(m => m.kind === 'said' ? (
                    <div className="msg" key={m.id} data-testid="msg">
                      <span className={`av sm t${tint(m.name)}`}>{initials(m.name)}</span>
                      <span className="txt"><b>{m.name}<i>{hhmm(m.atServerMs)}</i></b>{m.text}</span>
                    </div>
                  ) : (
                    <p className="sys" key={m.id} data-testid="msg"><b>{m.name}</b> {m.text}</p>
                  ))}
                </div>
                <div className="composer">
                  <input
                    value={draft} onChange={e => setDraft(e.target.value)}
                    onKeyDown={(e: ReactKeyEvent<HTMLInputElement>) => { if (e.key === 'Enter') { e.preventDefault(); send() } }}
                    placeholder="Message the room…" maxLength={800} data-testid="chatinput"
                  />
                </div>
              </div>
            </>
          )}
          {view === 'room' && (
            <>
            {/* Subtitles can only be drawn where the film is in this window;
                mpv has nothing that can be put above its picture. */}
            {s?.playerEngine === 'html' && s?.mediaName && (
              <SubtitleControls
                files={subFiles}
                activePath={subPath}
                style={subStyle}
                onPick={setSubPath}
                onStyle={setSubStyle}
                onRefresh={findSubtitles}
              />
            )}
            {subError && <p className="quiet small vwarn" data-testid="subserror">{subError}</p>}
            <div className="sect film">
              <h4>Film</h4>
                {s?.connected && s.isHost && s.originAvailable && (
                  <div className="share-mode" data-testid="sharemode">
                    <label className="quiet" htmlFor="modesel">How the film is shared</label>
                    <select id="modesel" className="sel" value={s.mode} data-testid="modeselect"
                      onChange={e => void guard(() => window.cocine.setMode(e.target.value as 'p2p' | 'origin'))}>
                      <option value="p2p">Between us (peer to peer)</option>
                      <option value="origin">Through the server (relay)</option>
                    </select>
                    <p className="quiet small">
                      {s.mode === 'p2p'
                        ? 'Everyone shares with everyone. Free, and faster with more people — but it needs peers who can reach each other.'
                        : 'You upload once and everyone downloads from the server. Works when peer to peer cannot, and costs whoever runs the server.'}
                    </p>
                    <p className="quiet small">Changing this clears the film — it has to be shared again.</p>
                  </div>
                )}
                {s?.connected && !s.isHost && s.mode === 'origin' && (
                  <p className="quiet small" data-testid="modenote">Shared through the server, not between us.</p>
                )}
              {s?.receiving ? (
                <>
                  <p className="fname">{s.receiving.name}</p>
                  {(() => {
                    const t = s.transfers.find(x => x.infoHash === s.receiving!.infoHash)
                    const pct = Math.round((t?.progress ?? 0) * 100)
                    return (
                      <>
                        <div className="bar" data-testid="receivebar"><span style={{ width: `${pct}%` }} /></div>
                        <p className="quiet">receiving · {pct}% · {rate(t?.downBps ?? 0)} · {t?.peers ?? 0} peers</p>
                      </>
                    )
                  })()}
                </>
              ) : (
                <>
                  {/* What the room is showing, even before this machine has a
                      byte of it. Saying "Nothing open" while everybody else
                      watches something is the least helpful true statement the
                      interface could make. */}
                  {!s?.mediaName && s?.roomFilm && (
                    <div className="roomfilm" data-testid="roomfilm">
                      <p className="fname">{s.roomFilm.name}</p>
                      <p className="quiet">
                        {s.receiveError
                          ? 'could not be fetched'
                          : s.roomFilm.hasSource ? 'the room is sharing this — fetching it' : 'waiting for the sharer to start sharing'}
                      </p>
                      {s.receiveError && (
                        <p className="quiet small vwarn" data-testid="receiveerror">{s.receiveError}</p>
                      )}
                    </div>
                  )}
                  {!(!s?.mediaName && s?.roomFilm) && <p className="fname">{s?.mediaName ?? 'Nothing open'}</p>}
                  <p className="quiet">
                    {s?.mediaName
                      ? (duration > 0 ? `${clock(duration)} long` : 'measuring…')
                      : s?.connected ? 'Drop a file anywhere, or use Open film' : 'Create or join a room first'}
                  </p>

                  {s?.webrtcError && s.mode !== 'origin' && (
                    <p className="quiet small vwarn" data-testid="webrtcerror">
                      Peer-to-peer is unavailable in this build, so the film cannot travel
                      between machines. Everything else works; a room on a server with relay
                      storage can still share through it.
                    </p>
                  )}
                  {s?.connected && s.mediaName && (
                    <div className="filmacts" data-testid="filmacts">
                      {s.sharing === 'off' && (
                        <>
                          <p className="quiet small" data-testid="sharestate">
                            Playing on this machine only. Nobody else has it yet.
                          </p>
                          <button className="btn primary wide" data-testid="startsharing" disabled={busy}
                            onClick={() => void guard(() => window.cocine.shareFilm())}>
                            Start sharing
                          </button>
                        </>
                      )}
                      {s.sharing === 'sharing' && (
                        <>
                          <p className="quiet small sharing-on" data-testid="sharestate">
                            Sharing with the room.
                          </p>
                          <button className="btn wide" data-testid="pausesharing" disabled={busy}
                            onClick={() => void guard(() => window.cocine.setSharingPaused(true))}>
                            Pause sharing
                          </button>
                        </>
                      )}
                      {s.sharing === 'paused' && (
                        <>
                          <p className="quiet small vwarn" data-testid="sharestate">
                            Sharing paused — nobody is receiving from you.
                          </p>
                          <button className="btn primary wide" data-testid="resumesharing" disabled={busy}
                            onClick={() => void guard(() => window.cocine.setSharingPaused(false))}>
                            Resume sharing
                          </button>
                        </>
                      )}
                      <button className="mini" data-testid="unloadfilm" disabled={busy}
                        title="Close this film so another can be opened"
                        onClick={() => void guard(() => window.cocine.unloadFilm())}>
                        unload film
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
            </>
          )}
        </aside>
      </main>

      <footer className="controls" data-testid="controls">
        <button className="play" data-testid="playpause" disabled={busy || !s?.mediaName || (s.connected && !s.mayControl)}
          onClick={togglePlay} aria-label={s?.paused ? 'Play' : 'Pause'}
          title={s?.connected && !s.mayControl ? 'The host has not given you playback control' : undefined}>
          {s?.paused
            ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" /></svg>
            : <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3.4" height="11" rx="1" /><rect x="9.1" y="2.5" width="3.4" height="11" rx="1" /></svg>}
        </button>
        <span className="tc" data-testid="position">{clock(s?.positionSec)}</span>
        <span
          className={`track${seekable?.limited ? ' limited' : ''}`}
          style={{
            ['--p' as string]: `${progress}%`,
            // The stretch the room can actually reach, so a seek that would be
            // refused is visible before it is attempted.
            ['--sa' as string]: `${duration > 0 ? ((seekable?.fromSec ?? 0) / duration) * 100 : 0}%`,
            ['--sb' as string]: `${duration > 0 ? ((seekable?.toSec ?? duration) / duration) * 100 : 100}%`
          }}
          title={seekable?.limited
            ? 'Only the lit stretch is downloaded by everyone; the room cannot seek outside it yet'
            : undefined}
        >
          <input
            className="scrub" type="range" min={0} max={Math.max(1, duration)} step={0.5}
            value={Math.min(s?.positionSec ?? 0, duration)}
            onChange={e => void guard(() => window.cocine.seek(clampSeek(Number(e.target.value))))}
            disabled={!s?.mediaName || (!!s?.connected && !s.mayControl)} aria-label="Seek"
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
