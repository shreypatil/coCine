import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, basename } from 'node:path'
import {
  compatibilityOf, parseProbe, conversionArgs, locateFfmpeg, ffmpegInstallHint,
  type Compatibility
} from '@cocine/player'

const run = promisify(execFile)

/**
 * Making a film playable by the `<video>` engine when it is not already.
 *
 * Phase B1.5. Most films need nothing: every modern container and codec was
 * measured playing directly. What does not open is AVI and MPEG-2, and the
 * useful observation is that they fail for different reasons costing different
 * amounts -- an AVI carrying H.264 is repacked at disk speed, while genuine
 * Xvid or MPEG-2 needs a real transcode.
 *
 * That distinction is why this reports what it is about to do before doing it.
 * A repack finishes before anybody wonders what happened; a transcode of a
 * feature-length film is minutes, and starting one silently would look like the
 * application had hung.
 *
 * Nothing here is reached under the mpv engine, which decodes all of this
 * natively. That is worth remembering as an answer in itself: for a library of
 * old rips, running mpv is better than transcoding each one.
 */

export interface ConversionProgress {
  /** What is being done, and why, in words the interface can show. */
  compatibility: Compatibility
  /** 0 to 1 where it can be known; null while it cannot. */
  progress: number | null
  path: string
}

/** Where converted films are kept, so the same file is converted once. */
export function conversionDir (userDataPath: string): string {
  return join(userDataPath, 'converted')
}

/**
 * A stable name for the converted copy.
 *
 * Keyed on the path, size and modification time rather than on content: hashing
 * four gigabytes to decide whether to convert it would cost more than the
 * repack it is trying to avoid.
 */
export async function convertedNameFor (input: string): Promise<string> {
  const s = await stat(input)
  const key = createHash('sha256')
    .update(`${input}:${s.size}:${Math.floor(s.mtimeMs)}`)
    .digest('hex')
    .slice(0, 16)
  return `${basename(input).replace(/\.[^.]+$/, '')}-${key}.mkv`
}

export class FfmpegMissingError extends Error {
  constructor (platform: NodeJS.Platform = process.platform) {
    super(
      'This file needs converting before it can be played, and ffmpeg was not ' +
      `found. Install it (${ffmpegInstallHint(platform)}), or run coCine with ` +
      'COCINE_PLAYER=mpv, which plays this format without converting it.'
    )
    this.name = 'FfmpegMissingError'
  }
}

/**
 * Where ffmpeg is, or null.
 *
 * A bundled copy first, then PATH -- somebody who installed from a link has no
 * reason to have a media toolchain, and a copy ships beside the application for
 * exactly that person. `resourcesPath` is absent outside a packaged build,
 * where PATH is the whole answer.
 */
export function ffmpegTools (resourcesPath?: string): { ffmpeg: string; ffprobe: string } | null {
  return locateFfmpeg(resourcesPath ? { resourcesPath } : {})
}

/** Whether ffmpeg and ffprobe are both usable. */
export async function ffmpegAvailable (resourcesPath?: string): Promise<boolean> {
  const tools = ffmpegTools(resourcesPath)
  if (!tools) return false
  try {
    await Promise.all([run(tools.ffprobe, ['-version']), run(tools.ffmpeg, ['-version'])])
    return true
  } catch { return false }
}

/**
 * What this file needs, or null when it cannot be inspected at all.
 *
 * A file ffprobe cannot read is not assumed to be broken -- it may simply be a
 * format ffprobe lacks -- so the caller is left to try loading it and let the
 * media element give the real answer.
 */
export async function inspect (path: string, ffprobe = 'ffprobe'): Promise<Compatibility | null> {
  try {
    const { stdout } = await run(ffprobe, [
      '-hide_banner', '-loglevel', 'error',
      '-show_format', '-show_streams', '-of', 'json', path
    ], { maxBuffer: 8 * 1024 * 1024 })
    const probed = parseProbe(stdout)
    return probed ? compatibilityOf(probed) : null
  } catch { return null }
}

/** Total duration in seconds, for turning ffmpeg's progress into a fraction. */
async function durationOf (path: string, ffprobe = 'ffprobe'): Promise<number | null> {
  try {
    const { stdout } = await run(ffprobe, [
      '-hide_banner', '-loglevel', 'error',
      '-show_entries', 'format=duration', '-of', 'csv=p=0', path
    ])
    const n = Number(stdout.trim())
    return Number.isFinite(n) && n > 0 ? n : null
  } catch { return null }
}

/** `-stats` writes `time=HH:MM:SS.mm` to stderr; this is how far it has got. */
function progressFrom (line: string, totalSec: number | null): number | null {
  if (totalSec === null) return null
  const m = /time=(\d+):(\d{2}):(\d{2})\.(\d+)/.exec(line)
  if (!m) return null
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`)
  return Math.max(0, Math.min(1, sec / totalSec))
}

export interface ConvertOptions {
  input: string
  /** Electron's process.resourcesPath, so a bundled ffmpeg is preferred. */
  resourcesPath?: string
  /** Where converted films live; usually conversionDir(app.getPath('userData')). */
  outputDir: string
  onProgress?: (p: ConversionProgress) => void
  /** Aborts a conversion in flight, for a film the room has moved on from. */
  signal?: AbortSignal
}

/**
 * Make a file playable, returning the path to play.
 *
 * Returns the input unchanged when nothing is needed, which is the common case
 * and costs one ffprobe. A film already converted is reused rather than
 * converted again.
 */
export async function ensurePlayable (o: ConvertOptions): Promise<{
  path: string; compatibility: Compatibility | null; converted: boolean
}> {
  const tools = ffmpegTools(o.resourcesPath)
  if (!tools) {
    // Not an error on its own: most films need nothing, and refusing to play
    // them because a tool they do not need is missing would be absurd. The
    // media element gets its chance, and says so itself if it cannot.
    return { path: o.input, compatibility: null, converted: false }
  }

  const compatibility = await inspect(o.input, tools.ffprobe)
  if (!compatibility || compatibility.action === 'direct') {
    return { path: o.input, compatibility, converted: false }
  }

  await mkdir(o.outputDir, { recursive: true })
  const output = join(o.outputDir, await convertedNameFor(o.input))
  // Converted once. The name carries the source's size and modification time,
  // so an edited or replaced file converts again rather than playing a stale copy.
  try {
    const existing = await stat(output)
    if (existing.size > 0) return { path: output, compatibility, converted: true }
  } catch { /* not converted yet */ }

  const totalSec = await durationOf(o.input, tools.ffprobe)
  o.onProgress?.({ compatibility, progress: 0, path: o.input })

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(tools.ffmpeg, conversionArgs(compatibility.action, o.input, output))
    let stderr = ''
    proc.stderr.on('data', d => {
      const text = String(d)
      // Kept bounded: ffmpeg's stats line repeats forever and only the tail is
      // of any use in an error message.
      stderr = (stderr + text).slice(-4000)
      const progress = progressFrom(text, totalSec)
      if (progress !== null) o.onProgress?.({ compatibility, progress, path: o.input })
    })
    const onAbort = (): void => { try { proc.kill('SIGKILL') } catch { /* gone */ } }
    o.signal?.addEventListener('abort', onAbort, { once: true })
    proc.on('error', err => { o.signal?.removeEventListener('abort', onAbort); reject(err) })
    proc.on('exit', code => {
      o.signal?.removeEventListener('abort', onAbort)
      if (o.signal?.aborted) return reject(new Error('conversion cancelled'))
      if (code === 0) return resolve()
      reject(new Error(`ffmpeg failed (${code}): ${stderr.trim().split('\n').slice(-3).join(' ')}`))
    })
  })

  o.onProgress?.({ compatibility, progress: 1, path: o.input })
  return { path: output, compatibility, converted: true }
}


/* ------------------------------------------------ embedded subtitles */

export interface EmbeddedSubtitle {
  /** Index of the stream within the file, for extraction. */
  index: number
  /** The language tag the file carries, when it carries one. */
  language: string | null
  /** The title the file carries, which is usually the useful label. */
  title: string | null
  codec: string
  /** Whether it is text libass or the DOM layer can draw. */
  drawable: boolean
}

/** Text subtitle codecs. The rest are bitmaps and need a compositor. */
const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'])

/**
 * Subtitle tracks inside the film itself.
 *
 * The media element reports `textTracks.length === 0` for a Matroska carrying
 * three subtitle tracks -- Chromium demuxes the video and audio and simply does
 * not surface the rest -- so the only way to offer them is to look with ffprobe
 * and pull one out with ffmpeg. That is possible now that ffmpeg ships; before,
 * this was a gap that could only be named.
 */
export async function embeddedSubtitles (
  film: string, resourcesPath?: string
): Promise<EmbeddedSubtitle[]> {
  const tools = ffmpegTools(resourcesPath)
  if (!tools) return []
  try {
    const { stdout } = await run(tools.ffprobe, [
      '-hide_banner', '-loglevel', 'error',
      '-select_streams', 's', '-show_streams', '-of', 'json', film
    ], { maxBuffer: 8 * 1024 * 1024 })
    const data = JSON.parse(stdout) as {
      streams?: Array<{
        index?: number; codec_name?: string
        tags?: { language?: string; title?: string }
      }>
    }
    return (data.streams ?? []).map((st, i) => ({
      index: st.index ?? i,
      language: st.tags?.language ?? null,
      title: st.tags?.title ?? null,
      codec: st.codec_name ?? '',
      drawable: TEXT_SUBTITLE_CODECS.has((st.codec_name ?? '').toLowerCase())
    }))
  } catch { return [] }
}

/**
 * Pull one embedded track out to a file the renderer can read.
 *
 * Extracted as ASS when it already is one, so its styling survives, and as
 * SubRip otherwise -- converting a plain text track to ASS would invent
 * styling nobody asked for.
 */
export async function extractSubtitle (
  film: string, stream: EmbeddedSubtitle, outputDir: string, resourcesPath?: string
): Promise<string> {
  const tools = ffmpegTools(resourcesPath)
  if (!tools) throw new FfmpegMissingError()
  if (!stream.drawable) {
    throw new Error(`${stream.codec} subtitles are images rather than text, and cannot be drawn yet`)
  }
  await mkdir(outputDir, { recursive: true })
  const isAss = stream.codec.toLowerCase() === 'ass' || stream.codec.toLowerCase() === 'ssa'
  const ext = isAss ? 'ass' : 'srt'
  const key = createHash('sha256').update(`${film}:${stream.index}`).digest('hex').slice(0, 12)
  const out = join(outputDir, `${basename(film).replace(/\.[^.]+$/, '')}-${key}.${ext}`)

  try {
    const existing = await stat(out)
    if (existing.size > 0) return out
  } catch { /* not extracted yet */ }

  await run(tools.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', film,
    // By absolute stream index, because `-map 0:s:N` counts only subtitle
    // streams and ffprobe reported the index within the whole file.
    '-map', `0:${stream.index}`,
    '-c:s', isAss ? 'copy' : 'srt',
    out
  ], { maxBuffer: 8 * 1024 * 1024 })
  return out
}
