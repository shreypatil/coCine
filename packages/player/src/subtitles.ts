/**
 * Subtitle files, parsed into something that can be drawn.
 *
 * Phase B1.4. Chromium will render a WebVTT `<track>` on its own, and that is
 * tempting until you read what the requirement actually asks for: colour, size
 * and position controls. `::cue` styling reaches almost none of that -- there is
 * no way to move a cue, and browser support for the rest is uneven -- so cues
 * are drawn as ordinary DOM instead, positioned wherever the viewer wants them.
 * Owning the rendering is the point rather than a cost.
 *
 * Two formats are handled here because between them they cover what films
 * actually ship with: SubRip (`.srt`), which is most of them, and WebVTT
 * (`.vtt`). Both are line-oriented and near enough identical once the timestamp
 * separator is normalised.
 *
 * **Advanced SubStation (`.ass`) is deliberately not parsed here.** Its whole
 * reason for existing is styling -- positioning, karaoke, per-character
 * animation -- and a parser that read the text and dropped all of that would
 * look like support while producing something visibly wrong. It is rendered by
 * libass instead, compiled to WebAssembly, which is what actually understands
 * the format; this module only has to recognise it and stand aside.
 */

export interface Cue {
  /** Seconds from the start of the film. */
  fromSec: number
  toSec: number
  /** Already stripped of markup, with line breaks preserved. */
  text: string
}

/**
 * `HH:MM:SS,mmm` or `HH:MM:SS.mmm`, and the two-field `MM:SS.mmm` WebVTT
 * allows. Returns null rather than NaN so a malformed line can be skipped
 * instead of poisoning the timeline.
 */
export function parseTimestamp (text: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/.exec(text.trim())
  if (!m) return null
  const [, h, mm, ss, ms] = m
  const seconds = Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss)
  // A two-digit fraction means hundredths, not thousandths.
  return seconds + Number(ms!.padEnd(3, '0')) / 1000
}

/** Tags a renderer has no use for: SubRip allows a little HTML, and some files
 *  carry SSA drawing commands that would otherwise be shown as text. */
function stripMarkup (text: string): string {
  return text
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\{\\[^}]*\}/g, '')
    .trim()
}

/**
 * Parse SubRip or WebVTT. The two differ in the timestamp separator, an
 * optional header, and cue identifiers, none of which change how a cue is read
 * -- so one parser handles both rather than two that drift apart.
 *
 * Anything unparseable is skipped rather than thrown on. A single malformed cue
 * in a file of two thousand should cost that one line, not the subtitles.
 */
export function parseSubtitles (source: string): Cue[] {
  const text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const cues: Cue[] = []

  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter(l => l.trim() !== '')
    if (lines.length === 0) continue
    // WebVTT's header, and any metadata blocks that follow it.
    if (/^WEBVTT/.test(lines[0]!)) continue
    if (/^(NOTE|STYLE|REGION)\b/.test(lines[0]!)) continue

    // The timing line is the first one containing an arrow; anything before it
    // is a cue number or identifier, which is of no interest.
    const at = lines.findIndex(l => l.includes('-->'))
    if (at === -1) continue
    const [fromText, restText] = lines[at]!.split('-->')
    if (fromText === undefined || restText === undefined) continue
    // WebVTT allows positioning settings after the end time; ignored here
    // because position is the viewer's choice rather than the file's.
    const toText = restText.trim().split(/\s+/)[0] ?? ''

    const fromSec = parseTimestamp(fromText)
    const toSec = parseTimestamp(toText)
    if (fromSec === null || toSec === null || toSec < fromSec) continue

    const body = stripMarkup(lines.slice(at + 1).join('\n'))
    if (!body) continue
    cues.push({ fromSec, toSec, text: body })
  }

  // Sorted so lookup can assume order; files are usually sorted already, but a
  // merged or hand-edited one may not be.
  return cues.sort((a, b) => a.fromSec - b.fromSec)
}

/**
 * The cues showing at a moment, with an offset applied.
 *
 * `offsetSec` shifts the subtitles against the film, which is the control
 * everyone reaches for first: a positive value shows each line later, matching
 * subtitles timed for a different release. Overlapping cues are all returned --
 * some files put a sign and a line of dialogue on screen together.
 */
export function cuesAt (cues: Cue[], positionSec: number, offsetSec = 0): Cue[] {
  const t = positionSec - offsetSec
  return cues.filter(c => t >= c.fromSec && t < c.toSec)
}

/**
 * How a subtitle file has to be drawn, or null if it cannot be.
 *
 * `text` is parsed here and drawn as DOM, which is what makes the size, colour
 * and position controls possible. `ass` is handed to libass, which owns its own
 * appearance -- the styling *is* the format, so a viewer's size and colour
 * preferences do not apply and are hidden for it.
 */
export type SubtitleKind = 'text' | 'ass'

export function subtitleKind (name: string): SubtitleKind | null {
  if (/\.(srt|vtt)$/i.test(name)) return 'text'
  if (/\.(ass|ssa)$/i.test(name)) return 'ass'
  return null
}

/** Whether a filename is subtitles coCine can draw at all. */
export function isSubtitleFile (name: string): boolean {
  return subtitleKind(name) !== null
}

/**
 * Formats still not drawn: the bitmap ones.
 *
 * VobSub and PGS are images per frame rather than text, so they need a decoder
 * and a compositor rather than a parser. Named rather than hidden, because
 * somebody can see the file in the folder.
 */
export function isUnsupportedSubtitleFile (name: string): boolean {
  return /\.(sub|idx|sup)$/i.test(name)
}
