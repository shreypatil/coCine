import { existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * A synthetic film of a given length, cached between runs. Content is
 * irrelevant to drift measurement -- what matters is that mpv reports a real
 * duration and paces playback in real time. Kept tiny and ultrafast-encoded so
 * a two-hour fixture costs seconds to build and megabytes to store.
 */
export interface FixtureOptions {
  /** Frame height. 240 keeps runs cheap; 1080 puts realistic decode load on
   *  each client, which is the point of the heavy variant. */
  height?: number
  crf?: number
  preset?: string
}

export function ensureTestVideo (seconds: number, dir: string, opts: FixtureOptions = {}): string {
  const height = opts.height ?? 240
  const width = Math.round((height * 16) / 9 / 2) * 2
  const size = height === 240 ? '320x240' : `${width}x${height}`
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `film-${seconds}s-${height}p.mp4`)
  if (existsSync(path)) return path
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', opts.preset ?? (height > 480 ? 'veryfast' : 'ultrafast'),
    '-crf', String(opts.crf ?? (height > 480 ? 28 : 40)), '-g', '50',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', path
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  return path
}
