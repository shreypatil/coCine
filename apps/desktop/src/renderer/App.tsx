import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import type { ReactElement, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyEvent } from 'react'
import { useVoice } from './useVoice.js'

interface Member {
  id: string; name: string; isHost: boolean; mayControl: boolean
  inVoice: boolean; muted: boolean; deafened: boolean
}
interface ChatMessage {
  id: string
  kind: 'said' | 'joined' | 'left' | 'system'
  memberId: string | null
  name: string
  text: string
  atServerMs: number
}
interface StoredFilm {
  infoHash: string; name: string; path: string
  bytes: number; onDiskBytes: number; complete: boolean; addedAtMs: number
}
interface TransferProgress {
  infoHash: string; name: string; progress: number
  downBps: number; upBps: number; peers: number; done: boolean; bytes: number
}
interface Library { films: StoredFilm[]; usedBytes: number; freeBytes: number }
interface PeerStatus {
  memberId: string; name: string; havePct: number; bufferEndSec: number
  downBps: number; upBps: number; peers: number; ready: boolean
}
interface TransferStatus {
  perPeer: PeerStatus[]
  etaSec: number | null
  tMinSec: number | null
  bottleneck: string | null
  fullCopies: number
  safeForSharerToLeave: boolean
}

interface State {
  ready: boolean; connected: boolean; members: Member[]; memberId: string
  code: string | null; messages: ChatMessage[]
  isHost: boolean; mayControl: boolean
  mediaName: string | null; durationSec: number | null
  positionSec: number; expectedSec: number | null; driftMs: number | null
  paused: boolean; rate: number
  clockOffsetMs: number | null; rttMs: number | null; lastAction: string | null
  voiceIce: RTCIceServer[]
  mode: 'p2p' | 'origin'
  originAvailable: boolean
  startupError: { message: string; howToInstall: string } | null
  fullscreen: boolean
  transfers: TransferProgress[]
  receiving: { name: string; infoHash: string } | null
  phase: 'lobby' | 'preparing' | 'ready' | 'playing'
  waitForLatecomers: boolean
  transferStatus: TransferStatus | null
}

declare global {
  interface Window {
    cocine: {
      setVideoSlot: (r: { x: number; y: number; width: number; height: number }) => Promise<unknown>
      openFile: () => Promise<{ path: string; name: string; durationSec: number | null } | null>
      openPath: (path: string) => Promise<{ path: string; name: string; durationSec: number | null }>
      pathForFile: (f: File) => string | null
      getIdentity: () => Promise<{ id: string; name: string; server: string; lastCode: string | null }>
      listFilms: () => Promise<Library>
      removeFilm: (infoHash: string) => Promise<void>
      connect: (o: { url: string; code: string | null; name: string }) => Promise<{ memberId: string; code: string }>
      disconnect: () => Promise<void>
      sendChat: (text: string) => Promise<void>
      setControl: (memberId: string, mayControl: boolean) => Promise<void>
      transferHost: (memberId: string) => Promise<void>
      startAnyway: () => Promise<void>
      setWaitForLatecomers: (wait: boolean) => Promise<void>
      setMode: (mode: 'p2p' | 'origin') => Promise<unknown>
      play: () => Promise<void>
      pause: () => Promise<void>
      seek: (sec: number) => Promise<void>
      setFullScreen: (on?: boolean) => Promise<boolean>
      sendSignal: (to: string, payload: unknown) => Promise<void>
      setVoiceState: (v: { inVoice: boolean; muted: boolean; deafened: boolean }) => Promise<void>
      moderateVoice: (memberId: string, action: 'mute' | 'unmute') => Promise<void>
      duckFilm: (ducked: boolean) => Promise<void>
      onSignal: (cb: (from: string, payload: unknown) => void) => () => void
      onModerated: (cb: (by: string, action: string) => void) => () => void
      onState: (cb: (s: State) => void) => () => void
    }
  }
}

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

const clock = (s: number | null | undefined): string => {
  if (s == null || !isFinite(s)) return '--:--:--'
  const t = Math.max(0, Math.floor(s))
  return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60]
    .map(n => String(n).padStart(2, '0')).join(':')
}
const hhmm = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
const pretty = (code: string): string => code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code
const initials = (name: string): string => name.trim().slice(0, 1).toUpperCase() || '?'
/** Stable per-name avatar tint, so the same person is the same colour every session. */
const tint = (name: string): number => {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 5
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
  const [library, setLibrary] = useState<Library | null>(null)
  const slotRef = useRef<HTMLDivElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)

  const memberIds = (s?.members ?? []).filter(m => m.inVoice || m.id === s?.memberId).map(m => m.id)
  const voice = useVoice(s?.memberId ?? '', memberIds, s?.voiceIce ?? [])

  useEffect(() => window.cocine.onState(setS), [])

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

  const togglePlay = useCallback(() => {
    if (!s?.mediaName) return
    void guard(() => s.paused ? window.cocine.play() : window.cocine.pause())
  }, [s?.mediaName, s?.paused, guard])

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
      <header className="topbar" data-testid="header">
        <span className="brand"><span className="mark" />coCine</span>
        {s?.connected && s.code && (
          <button className="pill code" data-testid="code" onClick={copyCode} title="Copy the room code">
            <span className="live" />{pretty(s.code)}
            <span className="copy">{copied ? 'copied' : 'copy'}</span>
          </button>
        )}
        {s?.connected && (
          <span className={`pill sync ${driftClass}`} data-testid="drift"
            title="How far this screen is from the rest of the room">
            {drift == null ? '—' : `${Math.abs(drift).toFixed(0)} ms`}
          </span>
        )}
        <span className="grow" />
        <button className="btn" data-testid="open" disabled={busy || !s?.ready}
          onClick={() => { console.log('open film clicked'); void guard(() => window.cocine.openFile()) }}>
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
                <p>To fix it:</p>
                <p className="wall-cmd">{s.startupError.howToInstall}</p>
              </>
            )}
            <p className="quiet">Restart coCine once it is installed.</p>
          </div>
        </div>
      )}

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
              <button className="btn primary wide" data-testid="create" disabled={busy || !s?.ready || !identityLoaded || !name.trim()}
                onClick={() => void guard(() => window.cocine.connect({ url, code: null, name }))}>
                Create a room
              </button>
              <div className="or"><span>or join one</span></div>
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
                      {m.inVoice && (
                        <span className={`vdot ${m.muted ? 'off' : ''}`} data-testid="vdot"
                          title={m.muted ? `${m.name} is muted` : `${m.name} is in voice`} />
                      )}
                      {m.deafened && <span className="tag muted" title="Cannot hear the room">deafened</span>}
                      {m.isHost && <span className="tag">host</span>}
                      {!m.mayControl && !m.isHost && <span className="tag muted" title="Cannot control playback">no control</span>}
                      {s.isHost && !m.isHost && (
                        <span className="rowacts">
                          <button className="mini" data-testid="togglecontrol"
                            title={m.mayControl ? 'Take playback control' : 'Give playback control'}
                            onClick={() => void guard(() => window.cocine.setControl(m.id, !m.mayControl))}>
                            {m.mayControl ? 'take' : 'give'}
                          </button>
                          <button className="mini" data-testid="makehost" title="Make host"
                            onClick={() => void guard(() => window.cocine.transferHost(m.id))}>host</button>
                          {m.inVoice && (
                            <button className="mini" data-testid="mutethem"
                              title="Ask them to mute — advisory, their client chooses to comply"
                              onClick={() => void guard(() => window.cocine.moderateVoice(m.id, m.muted ? 'unmute' : 'mute'))}>
                              {m.muted ? 'unmute' : 'mute'}
                            </button>
                          )}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

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
          {view === 'room' && s?.connected && (s.phase === 'preparing' || s.phase === 'ready') && s.transferStatus && (
            <div className="sect gate" data-testid="gate">
              <h4>{s.phase === 'ready' ? 'Everyone is ready' : 'Getting everyone ready'}</h4>
              {s.phase === 'preparing' && (
                <p className="gate-eta" data-testid="eta">
                  {countdown(s.transferStatus.etaSec)}
                  {s.transferStatus.bottleneck && <span> · waiting on <b>{s.transferStatus.bottleneck}</b></span>}
                </p>
              )}
              <ul className="peers">
                {s.transferStatus.perPeer.map(p => (
                  <li key={p.memberId} data-testid="peerstatus" data-name={p.name}>
                    <span className="pn">{p.name}</span>
                    <span className={`pv ${p.ready ? 'ok' : ''}`}>{Math.round(p.havePct * 100)}%</span>
                    <span className="pd">{rate(p.downBps)}</span>
                    <div className="bar"><span style={{ width: `${Math.round(p.havePct * 100)}%` }} /></div>
                  </li>
                ))}
              </ul>
              {s.transferStatus.tMinSec !== null && (
                <p className="quiet" data-testid="floor">
                  fastest possible {countdown(s.transferStatus.tMinSec)} — nothing can beat that
                </p>
              )}
              <p className={s.transferStatus.safeForSharerToLeave ? 'quiet safe' : 'quiet'} data-testid="durability">
                {s.transferStatus.safeForSharerToLeave
                  ? 'Safe for the sharer to leave — the room has a second full copy'
                  : `${s.transferStatus.fullCopies} full ${s.transferStatus.fullCopies === 1 ? 'copy' : 'copies'} in the room — the film needs the sharer for now`}
              </p>
              {s.isHost && (
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
          {view === 'room' && (
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
                  <p className="fname">{s?.mediaName ?? 'Nothing open'}</p>
                  <p className="quiet">{duration > 0 ? `${clock(duration)} long` : 'Drop a file anywhere, or use Open film'}</p>
                </>
              )}
            </div>
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
        <span className="track" style={{ ['--p' as string]: `${progress}%` }}>
          <input
            className="scrub" type="range" min={0} max={Math.max(1, duration)} step={0.5}
            value={Math.min(s?.positionSec ?? 0, duration)}
            onChange={e => void guard(() => window.cocine.seek(Number(e.target.value)))}
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
