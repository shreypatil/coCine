import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { parseSubtitles, cuesAt, subtitleKind, type Cue } from '@cocine/player/subtitles'
import JASSUB from 'jassub'
// Vite emits these as assets and hands back their built URLs. libass runs in a
// worker and needs its WebAssembly fetched at runtime, both of which work from
// the file:// origin a packaged renderer is loaded from -- verified before this
// was built on, because a worker that cannot start would have been discovered
// only in a packaged build.
import jassubWorkerUrl from 'jassub/dist/wasm/jassub-worker.js?url'
import jassubWasmUrl from 'jassub/dist/wasm/jassub-worker.wasm?url'
import type { SubtitleFile, EmbeddedSubtitle } from './types.js'

/**
 * Subtitles drawn over the film, and the controls for them.
 *
 * Phase B1.4. Chromium renders a WebVTT `<track>` by itself, which is tempting
 * until the requirement is read closely: colour, size and position controls.
 * `::cue` cannot move a cue at all and browser support for the rest is uneven,
 * so cues are drawn as ordinary DOM. Owning the rendering is what makes the
 * controls possible, and it is only possible because the film is in this window
 * -- under the mpv engine nothing could be drawn above the picture at all.
 */

export interface SubtitleStyle {
  /** Percentage of the video height; scales with the window rather than fixed. */
  sizePct: number
  colour: string
  /** Distance from the bottom, as a percentage of the video height. Raising it
   *  is the usual fix for a film whose own burnt-in text sits low. */
  bottomPct: number
  /** Seconds to shift the subtitles against the film. */
  offsetSec: number
  outline: boolean
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  sizePct: 4.2,
  colour: '#ffffff',
  bottomPct: 8,
  offsetSec: 0,
  outline: true
}

/**
 * Advanced SubStation, drawn by libass.
 *
 * Handed the video element rather than a position: libass follows the film's
 * own clock, which is what karaoke and per-character animation need. None of
 * the size, colour or position controls apply -- in this format the styling
 * *is* the content, and overriding it would be rewriting somebody's subtitles
 * rather than displaying them.
 */
export function AssLayer (
  { video, content }: { video: HTMLVideoElement | null; content: string }
): ReactElement | null {
  useEffect(() => {
    if (!video || !content) return
    let renderer: { destroy: () => void } | null = null
    try {
      renderer = new JASSUB({
        video,
        subContent: content,
        workerUrl: jassubWorkerUrl,
        wasmUrl: jassubWasmUrl
      }) as unknown as { destroy: () => void }
    } catch (err) {
      console.error('[subtitles] libass could not start:', err)
    }
    return () => { try { renderer?.destroy() } catch { /* already gone */ } }
  }, [video, content])
  // libass inserts and owns its own canvas over the video.
  return null
}

/** Draws whatever is on screen at this moment. */
export function SubtitleLayer (
  { cues, positionSec, style }: { cues: Cue[]; positionSec: number; style: SubtitleStyle }
): ReactElement | null {
  const showing = cuesAt(cues, positionSec, style.offsetSec)
  if (showing.length === 0) return null
  return (
    <div
      className="subs"
      data-testid="subtitles"
      style={{
        bottom: `${style.bottomPct}%`,
        fontSize: `${style.sizePct}cqh`,
        color: style.colour,
        // An outline rather than a box: a box hides more of the film than the
        // text does, and every player worth using draws an outline.
        textShadow: style.outline
          ? '0 0 4px #000, 0 1px 2px #000, 1px 0 2px #000, -1px 0 2px #000, 0 -1px 2px #000'
          : 'none'
      }}
    >
      {showing.map((c, i) => (
        <p className="subs-line" key={`${c.fromSec}-${i}`}>{c.text}</p>
      ))}
    </div>
  )
}

export interface SubtitleControlsProps {
  files: SubtitleFile[]
  /** Tracks inside the film, which the media element never reports. */
  embedded: EmbeddedSubtitle[]
  activePath: string | null
  /** How the chosen file is drawn; ASS owns its own appearance. */
  kind: 'text' | 'ass' | null
  style: SubtitleStyle
  onPick: (path: string | null) => void
  onStyle: (style: SubtitleStyle) => void
  onRefresh: () => void
}

/** The panel in the sidebar. */
/** What to call an embedded track in a list. */
function embeddedLabel (t: EmbeddedSubtitle): string {
  const parts = [t.title, t.language?.toUpperCase()].filter(Boolean)
  return parts.length > 0
    ? `In the film — ${parts.join(' · ')}`
    : `In the film — track ${t.index}`
}

export function SubtitleControls ({
  files, embedded, activePath, kind, style, onPick, onStyle, onRefresh
}: SubtitleControlsProps): ReactElement {
  const set = <K extends keyof SubtitleStyle>(k: K, v: SubtitleStyle[K]): void =>
    onStyle({ ...style, [k]: v })

  return (
    <div className="sect subs-panel" data-testid="subspanel">
      <h4>Subtitles</h4>

      {/* The same shapes the rest of the sidebar uses -- `.opts` for the group,
          `.opt` for a field label, `.sel` for a dropdown. The first version
          invented its own and looked like it had come from another
          application. */}
      <div className="opts">
        <label className="opt">
          Track
          <select
            className="sel" data-testid="substrack"
            value={activePath ?? ''}
            onChange={e => onPick(e.target.value || null)}
          >
            <option value="">Off</option>
            {files.filter(f => f.supported).map(f => (
              <option key={f.path} value={f.path}>{f.name}</option>
            ))}
            {/* Tracks inside the film. Prefixed with `embedded:` so one
                onChange can tell a track to extract from a file to open. */}
            {embedded.filter(t => t.drawable).map(t => (
              <option key={`e${t.index}`} value={`embedded:${t.index}`}>{embeddedLabel(t)}</option>
            ))}
          </select>
        </label>

        {embedded.some(t => !t.drawable) && (
          <p className="quiet small" data-testid="subsbitmap">
            This film also carries {embedded.filter(t => !t.drawable).length} image-based
            subtitle track(s), which cannot be drawn yet.
          </p>
        )}

        {files.some(f => !f.supported) && (
          // Named rather than hidden: somebody can see the file in the folder,
          // and silence about it reads as the application not having looked.
          <p className="quiet small" data-testid="subsunsupported">
            {files.filter(f => !f.supported).map(f => f.name).join(', ')} cannot be
            drawn yet.
          </p>
        )}

        {activePath && kind === 'ass' && (
          <p className="quiet small" data-testid="subsass">
            Advanced SubStation carries its own styling — position, colour and
            size come from the file, so they are not adjustable here.
          </p>
        )}

        {activePath && kind !== 'ass' && (
          <>
            <label className="opt subrow">
              Size
              <input type="range" min={2} max={9} step={0.2} data-testid="subssize"
                value={style.sizePct}
                onChange={e => set('sizePct', Number(e.target.value))} />
            </label>
            <label className="opt subrow">
              Height
              <input type="range" min={2} max={40} step={1} data-testid="subsheight"
                value={style.bottomPct}
                onChange={e => set('bottomPct', Number(e.target.value))} />
            </label>
            <label className="opt subrow">
              Delay
              <input type="range" min={-10} max={10} step={0.1} data-testid="subsoffset"
                value={style.offsetSec}
                onChange={e => set('offsetSec', Number(e.target.value))} />
              <span className="subval">{style.offsetSec.toFixed(1)}s</span>
            </label>
            <label className="opt subrow">
              Colour
              <input type="color" data-testid="subscolour"
                value={style.colour}
                onChange={e => set('colour', e.target.value)} />
            </label>
          </>
        )}

        <button className="mini" data-testid="subsrefresh" onClick={onRefresh}>
          look again
        </button>
      </div>
    </div>
  )
}

/**
 * Load and parse a subtitle file, and keep it while it is chosen.
 *
 * Parsing happens once when the file is picked rather than on every frame:
 * a two-hour film is a couple of thousand cues, and re-parsing them twenty-five
 * times a second to draw one line would be absurd.
 */
export function useSubtitles (path: string | null): {
  cues: Cue[]; assContent: string | null; kind: 'text' | 'ass' | null; error: string | null
} {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const kind = path ? subtitleKind(path) : null

  useEffect(() => {
    let cancelled = false
    if (!path) { setText(null); setError(null); return }
    void window.cocine.readSubtitles?.(path)
      .then(r => { if (!cancelled) { setText(r.text); setError(null) } })
      .catch((e: unknown) => {
        if (cancelled) return
        setText(null)
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => { cancelled = true }
  }, [path])

  // Parsed once when the file is picked rather than on every frame: a two-hour
  // film is a couple of thousand cues, and re-parsing them to draw one line
  // twenty-five times a second would be absurd.
  const cues = useMemo(
    () => (text && kind === 'text' ? parseSubtitles(text) : []),
    [text, kind]
  )
  return { cues, assContent: kind === 'ass' ? text : null, kind, error }
}
