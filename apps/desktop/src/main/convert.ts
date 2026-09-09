import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, basename } from 'node:path'
import {
  compatibilityOf, parseProbe, conversionArgs, type Compatibility
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
  constructor () {
    super(
      'ffmpeg is not installed, so this file cannot be converted. ' +
      'Install ffmpeg, or run coCine with COCINE_PLAYER=mpv, which plays this format natively.'
    )
    this.name = 'FfmpegMissingError'
  }
}

/** Whether ffmpeg and ffprobe are both available. */
export async function ffmpegAvailable (): Promise<boolean> {
  try {
    await Promise.all([run('ffprobe', ['-version']), run('ffmpeg', ['-version'])])
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
export async function inspect (path: string): Promise<Compatibility | null> {
  try {
    const { stdout } = await run('ffprobe', [
      '-hide_banner', '-loglevel', 'error',
      '-show_format', '-show_streams', '-of', 'json', path
    ], { maxBuffer: 8 * 1024 * 1024 })
    const probed = parseProbe(stdout)
    return probed ? compatibilityOf(probed) : null
  } catch { return null }
}

/** Total duration in seconds, for turning ffmpeg's progress into a fraction. */
async function durationOf (path: string): Promise<number | null> {
  try {
    const { stdout } = await run('ffprobe', [
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
  if (!await ffmpegAvailable()) {
    // Not an error on its own: most films need nothing, and refusing to play
    // them because a tool they do not need is missing would be absurd.
    return { path: o.input, compatibility: null, converted: false }
  }

  const compatibility = await inspect(o.input)
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

  const totalSec = await durationOf(o.input)
  o.onProgress?.({ compatibility, progress: 0, path: o.input })

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', conversionArgs(compatibility.action, o.input, output))
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
