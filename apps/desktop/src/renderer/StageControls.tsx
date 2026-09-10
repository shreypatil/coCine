import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'

/**
 * The controls over the film in fullscreen.
 *
 * In a window the controls live in the footer beneath the video, where they are
 * always visible and never in the way. Fullscreen has no footer -- the whole
 * screen is the film -- so they have to be drawn *over* the picture, which is
 * the third thing in this phase that is trivial here and was impossible under
 * mpv: there was no way to put anything above that surface at all.
 *
 * Hidden by default, because a bar across the bottom of a film somebody is
 * watching is exactly what a player should not do. It appears on a click and
 * takes itself away again shortly afterwards.
 */

/** How long the bar stays up after the last interaction with it. */
const HIDE_AFTER_MS = 3200

const clock = (sec: number | null | undefined): string => {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '00:00:00'
  const s = Math.max(0, Math.floor(sec))
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map(n => String(n).padStart(2, '0')).join(':')
}

export interface StageControlsProps {
  visible: boolean
  paused: boolean
  positionSec: number
  durationSec: number
  volume: number
  /** Whether this member is allowed to drive playback at all. */
  mayControl: boolean
  /** The stretch of film the whole room can reach; see B1.3. */
  seekable: { fromSec: number; toSec: number; limited: boolean } | null
  onPlayPause: () => void
  onSeek: (sec: number) => void
  onVolume: (percent: number) => void
  onLeaveFullscreen: () => void
  /**
   * The chat line being typed, and what to do with it.
   *
   * In the bar rather than floating over the film on a keyboard shortcut. The
   * shortcut works and is kept, but nothing on screen said so, so in practice
   * there was no way to type in fullscreen at all unless you already knew.
   */
  draft: string
  onDraftChange: (text: string) => void
  onSend: () => void
  /** Reported so the bar can stay up while somebody is mid-sentence. */
  onChatFocus: (focused: boolean) => void
  /** Bumped to ask for the keyboard, which is how the Enter shortcut works. */
  focusChatAt: number
  canChat: boolean
  /** Reflected onto the element for diagnosis. */
  keepOpen: boolean
  hovering: boolean
  /** Hold the bar open while the pointer is on it, and let it go again when
   *  the pointer leaves. Without this it vanishes from under the cursor
   *  mid-drag, which is the most irritating thing a control bar can do. */
  onHold: () => void
  onRelease: () => void
}

export function StageControls ({
  visible, paused, positionSec, durationSec, volume, mayControl, seekable,
  onPlayPause, onSeek, onVolume, onLeaveFullscreen, onHold, onRelease,
  draft, onDraftChange, onSend, onChatFocus, focusChatAt, canChat, keepOpen, hovering
}: StageControlsProps): ReactElement {
  const duration = durationSec > 0 ? durationSec : 0
  const progress = duration > 0 ? Math.min(100, (positionSec / duration) * 100) : 0
  const chatRef = useRef<HTMLInputElement>(null)

  // Pressing Enter over the film shows the bar and asks for the keyboard here,
  // so the shortcut and the visible box are the same composer rather than two.
  useEffect(() => {
    if (focusChatAt > 0) chatRef.current?.focus()
  }, [focusChatAt])

  return (
    <div
      className={`stagebar${visible ? ' shown' : ''}`}
      data-testid="stagebar"
      // Exposed so a test can say *why* the bar is or is not up, rather than
      // only that it is not.
      data-shown={visible ? '1' : '0'}
      data-keepopen={keepOpen ? '1' : '0'}
      data-hover={hovering ? '1' : '0'}
      aria-hidden={!visible}
      // Clicks on the bar are for the bar. Both events have to be stopped: the
      // stage listens for `click`, so stopping only `mousedown` let every press
      // on a button bubble through and toggle the bar shut underneath the very
      // control being used.
      //
      // They deliberately do *not* claim the hover hold. Entering the bar does
      // that, and leaving it releases -- whereas a click that took the hold
      // could never give it back if the bar hid before the pointer left, and
      // the bar then stayed up for ever.
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      // Held open by the pointer being on it rather than by movement: a hand
      // resting still on the volume slider is using it just as much as one
      // that is moving, and a bar that disappears at that moment is useless.
      onMouseEnter={onHold}
      // Movement over the bar counts as using it too. Entering alone was not
      // enough in practice: the icons swap as the state changes, and a pointer
      // that never leaves the bar can still stop producing enter events.
      onMouseMove={onHold}
      onMouseLeave={onRelease}
    >
      {canChat && (
        <input
          ref={chatRef}
          className="stagechatinput"
          data-testid="stageinput"
          value={draft}
          maxLength={800}
          placeholder="Say something…"
          aria-label="Message the room"
          onChange={e => onDraftChange(e.target.value)}
          // Focus is reported as focus and nothing else. It used to also claim
          // the *pointer* hold, which blurring never gave back -- so once
          // anybody had clicked into the chat box, the bar believed a pointer
          // was resting on it for the rest of the session and never hid again.
          // Holding it open while typing is `keepOpen`'s job, and that one is
          // released on blur.
          onFocus={() => onChatFocus(true)}
          onBlur={() => onChatFocus(false)}
          onKeyDown={e => {
            // Kept here so the film's own shortcuts -- space, the arrow keys --
            // do not fire while somebody is typing a message into it.
            e.stopPropagation()
            if (e.key === 'Enter') { e.preventDefault(); onSend() }
            if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur() }
          }}
        />
      )}

      <button
        className="play" data-testid="stageplaypause"
        disabled={!mayControl}
        onClick={onPlayPause}
        aria-label={paused ? 'Play' : 'Pause'}
        title={mayControl ? undefined : 'The host has not given you playback control'}
      >
        {paused
          ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" /></svg>
          : <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3.4" height="11" rx="1" /><rect x="9.1" y="2.5" width="3.4" height="11" rx="1" /></svg>}
      </button>

      <span className="tc" data-testid="stageposition">{clock(positionSec)}</span>

      <span
        className={`track${seekable?.limited ? ' limited' : ''}`}
        style={{
          ['--p' as string]: `${progress}%`,
          ['--sa' as string]: `${duration > 0 ? ((seekable?.fromSec ?? 0) / duration) * 100 : 0}%`,
          ['--sb' as string]: `${duration > 0 ? ((seekable?.toSec ?? duration) / duration) * 100 : 100}%`
        }}
        title={seekable?.limited
          ? 'Only the lit stretch is downloaded by everyone; the room cannot seek outside it yet'
          : undefined}
      >
        <input
          className="scrub" type="range" min={0} max={Math.max(1, duration)} step={0.5}
          value={Math.min(positionSec, duration)}
          data-testid="stagescrub"
          onChange={e => onSeek(Number(e.target.value))}
          disabled={!mayControl} aria-label="Seek"
        />
      </span>

      <span className="tc" data-testid="stageduration">{clock(duration)}</span>

      {/* The film's volume only. What the room hears of each other is a
          separate thing and stays in the sidebar. */}
      <span className="stagevol">
        <button
          className="icon" data-testid="stagemute"
          onClick={() => onVolume(volume > 0 ? 0 : 100)}
          aria-label={volume > 0 ? 'Mute the film' : 'Unmute the film'}
        >
          {volume === 0
            ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3 4 6H1.5v4H4l3 3zM10.5 6l4 4m0-4-4 4" stroke="currentColor" strokeWidth="1.4" fill="none" /></svg>
            : <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3 4 6H1.5v4H4l3 3z" /><path d="M10 5.5a3.5 3.5 0 0 1 0 5M12 3.5a6 6 0 0 1 0 9" stroke="currentColor" strokeWidth="1.3" fill="none" /></svg>}
        </button>
        <input
          className="volslider" type="range" min={0} max={100} step={1}
          value={volume} data-testid="stagevolume"
          onChange={e => onVolume(Number(e.target.value))}
          aria-label="Film volume"
        />
      </span>

      <button
        className="icon" data-testid="stagefullscreen"
        onClick={onLeaveFullscreen} aria-label="Leave fullscreen"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 1v3H3v2h5V1zm4 0v5h5V4h-3V1zM1 10h5v5H4v-3H1zm9 0h5v2h-3v3h-2z" />
        </svg>
      </button>
    </div>
  )
}

/**
 * Whether the bar is up, and the rule for taking it away again.
 *
 * A click shows it; a few quiet seconds hide it. The timer restarts on any
 * interaction, so it never vanishes in the middle of dragging the seek bar --
 * which is the single most irritating thing a control bar can do.
 */
export function useStageControls (active: boolean, keepOpen = false): {
  visible: boolean; show: () => void; toggle: () => void
  hold: () => void; release: () => void; hovering: () => boolean
} {
  const [visible, setVisible] = useState(false)
  /**
   * Whether the pointer is on the bar.
   *
   * State rather than a ref, and the countdown is an effect rather than a
   * timer somebody arms by hand. The imperative version was wrong in a way that
   * took three attempts to see: a hold taken while the bar was up outlived it,
   * because a hidden bar stops accepting the pointer and so never sends the
   * `mouseleave` that would have released it -- and the bar was then stuck open
   * for ever. Expressed as state, "hidden" and "hovered" cannot disagree.
   */
  const [hovering, setHovering] = useState(false)
  /** Bumped to restart the countdown without changing anything else. */
  const [poke, setPoke] = useState(0)

  // The countdown. Restarted whenever anything it depends on changes, and
  // simply absent while something is holding the bar open.
  useEffect(() => {
    if (!visible || keepOpen || hovering) return
    const t = setTimeout(() => setVisible(false), HIDE_AFTER_MS)
    return () => clearTimeout(t)
  }, [visible, keepOpen, hovering, poke])

  // A bar nobody can point at is not being hovered, whatever the last event
  // said. This is what the ref could never express.
  useEffect(() => { if (!visible) setHovering(false) }, [visible])

  // Leaving fullscreen takes the bar with it: the footer is back, and a bar
  // left showing would be a second set of controls over a windowed film.
  useEffect(() => {
    if (active) return
    setVisible(false)
    setHovering(false)
  }, [active])

  const show = useCallback(() => { setVisible(true); setPoke(n => n + 1) }, [])
  const toggle = useCallback(() => setVisible(v => !v), [])
  const hold = useCallback(() => setHovering(true), [])
  const release = useCallback(() => setHovering(false), [])
  const isHovering = useCallback(() => hovering, [hovering])

  // Stable, so an effect depending on it does not run on every render.
  return useMemo(
    () => ({ visible, show, toggle, hold, release, hovering: isHovering }),
    [visible, show, toggle, hold, release, isHovering]
  )
}
