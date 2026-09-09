import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compatibilityOf, parseProbe, conversionArgs } from '../src/compat.js'

/**
 * The compatibility table, against real files and real ffprobe output.
 *
 * `compat.test.ts` checks the decision logic against hand-written probe data,
 * which is worth nothing if the codec names in that data are not the names
 * ffprobe actually prints. They are easy to get subtly wrong -- `mpeg4` covers
 * Xvid and DivX 5 while DivX 3 is `msmpeg4v3`, and guessing produces a table
 * that looks right and classifies real films incorrectly.
 *
 * So this generates files, probes them, and checks the whole path. It also runs
 * the conversion the table asks for and probes *that*, because a conversion
 * whose output still cannot be played is worse than refusing outright.
 */

const has = (cmd: string): boolean => {
  try { execFileSync(cmd, ['-version'], { stdio: 'ignore' }); return true } catch { return false }
}
const HAVE_FFMPEG = has('ffmpeg') && has('ffprobe')
const suite = HAVE_FFMPEG ? describe : describe.skip

let dir = ''
beforeAll(() => { if (HAVE_FFMPEG) dir = mkdtempSync(join(tmpdir(), 'cocine-compat-')) })
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

/** A three-second clip in whatever shape is asked for. */
function make (name: string, args: string[]): string {
  const out = join(dir, name)
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    ...args, '-shortest', out
  ], { stdio: 'ignore' })
  return out
}

function probe (path: string): ReturnType<typeof parseProbe> {
  const json = execFileSync('ffprobe', [
    '-hide_banner', '-loglevel', 'error',
    '-show_format', '-show_streams', '-of', 'json', path
  ], { encoding: 'utf8' })
  return parseProbe(json)
}

suite('what ffprobe actually says about real files', () => {
  it('classifies the shapes films actually ship in', () => {
    const cases: Array<{ name: string; args: string[]; expect: string }> = [
      // Modern rips, which must not be sent down a conversion for nothing.
      { name: 'h264-aac.mkv', args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], expect: 'direct' },
      { name: 'h264-ac3.mkv', args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'ac3'], expect: 'direct' },
      { name: 'h264-aac.mp4', args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], expect: 'direct' },
      // An old container carrying a modern stream: repack, not transcode.
      { name: 'h264-aac.avi', args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], expect: 'repack' },
      // Genuinely old rips, which need the expensive path.
      { name: 'xvid.avi', args: ['-c:v', 'mpeg4', '-vtag', 'XVID', '-c:a', 'libmp3lame'], expect: 'transcode' },
      { name: 'mpeg2.mpg', args: ['-c:v', 'mpeg2video', '-c:a', 'mp2'], expect: 'transcode' }
    ]

    for (const c of cases) {
      const probed = probe(make(c.name, c.args))
      expect(probed, `${c.name} did not probe`).not.toBeNull()
      const got = compatibilityOf(probed!)
      expect(got.action, `${c.name} (${probed!.container} / ${probed!.streams.map(s => s.codec).join('+')})`)
        .toBe(c.expect)
    }
  }, 180_000)

  it('produces something playable from a file that needed repacking', () => {
    // A conversion whose output still cannot be played is worse than refusing.
    const input = make('repack-me.avi', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'])
    const output = join(dir, 'repacked.mkv')
    execFileSync('ffmpeg', conversionArgs('repack', input, output), { stdio: 'ignore' })
    expect(existsSync(output)).toBe(true)
    expect(compatibilityOf(probe(output)!).action).toBe('direct')
  }, 180_000)

  it('produces something playable from a file that needed transcoding', () => {
    const input = make('transcode-me.avi', ['-c:v', 'mpeg4', '-vtag', 'XVID', '-c:a', 'libmp3lame'])
    const output = join(dir, 'transcoded.mkv')
    execFileSync('ffmpeg', conversionArgs('transcode', input, output), { stdio: 'ignore' })
    expect(existsSync(output)).toBe(true)
    expect(compatibilityOf(probe(output)!).action).toBe('direct')
  }, 300_000)

  it('converts a film with no audio track without failing on the missing stream', () => {
    // `0:a:0?` rather than `0:a:0`. Without the question mark ffmpeg exits with
    // an error on a silent film, which is a real shape rather than a curiosity.
    const out = join(dir, 'silent.avi')
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2',
      '-c:v', 'mpeg4', '-vtag', 'XVID', '-an', out
    ], { stdio: 'ignore' })

    const converted = join(dir, 'silent.mkv')
    execFileSync('ffmpeg', conversionArgs('transcode', out, converted), { stdio: 'ignore' })
    expect(existsSync(converted)).toBe(true)
    expect(compatibilityOf(probe(converted)!).action).toBe('direct')
  }, 180_000)
})
