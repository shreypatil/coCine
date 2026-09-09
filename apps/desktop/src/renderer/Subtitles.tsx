import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { parseSubtitles, cuesAt, type Cue } from '@cocine/player/subtitles'
import type { SubtitleFile } from './types.js'

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
  activePath: string | null
  style: SubtitleStyle
  onPick: (path: string | null) => void
  onStyle: (style: SubtitleStyle) => void
  onRefresh: () => void
}

/** The panel in the sidebar. */
export function SubtitleControls ({
  files, activePath, style, onPick, onStyle, onRefresh
}: SubtitleControlsProps): ReactElement {
  const set = <K extends keyof SubtitleStyle>(k: K, v: SubtitleStyle[K]): void =>
    onStyle({ ...style, [k]: v })

  return (
    <div className="sect subs-panel" data-testid="subspanel">
      <h4>Subtitles</h4>

      <select
        className="input" data-testid="substrack"
        value={activePath ?? ''}
        onChange={e => onPick(e.target.value || null)}
      >
        <option value="">Off</option>
        {files.filter(f => f.supported).map(f => (
          <option key={f.path} value={f.path}>{f.name}</option>
        ))}
      </select>

      {files.some(f => !f.supported) && (
        // Named rather than hidden: somebody can see the file in the folder,
        // and silence about it reads as the application not having looked.
        <p className="quiet small" data-testid="subsunsupported">
          {files.filter(f => !f.supported).map(f => f.name).join(', ')} needs a
          renderer coCine does not have yet.
        </p>
      )}

      <button className="mini" data-testid="subsrefresh" onClick={onRefresh}>
        Look again
      </button>

      {activePath && (
        <div className="subs-style">
          <label>
            Size
            <input type="range" min={2} max={9} step={0.2} data-testid="subssize"
              value={style.sizePct}
              onChange={e => set('sizePct', Number(e.target.value))} />
          </label>
          <label>
            Height
            <input type="range" min={2} max={40} step={1} data-testid="subsheight"
              value={style.bottomPct}
              onChange={e => set('bottomPct', Number(e.target.value))} />
          </label>
          <label>
            Delay
            <input type="range" min={-10} max={10} step={0.1} data-testid="subsoffset"
              value={style.offsetSec}
              onChange={e => set('offsetSec', Number(e.target.value))} />
            <span className="quiet small">{style.offsetSec.toFixed(1)}s</span>
          </label>
          <label>
            Colour
            <input type="color" data-testid="subscolour"
              value={style.colour}
              onChange={e => set('colour', e.target.value)} />
          </label>
        </div>
      )}
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
export function useSubtitles (path: string | null): { cues: Cue[]; error: string | null } {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const cues = useMemo(() => (text ? parseSubtitles(text) : []), [text])
  return { cues, error }
}
