import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSubtitles, subtitleKind } from '@cocine/player/subtitles'
import { embeddedSubtitles, extractSubtitle } from '../src/main/convert.js'

/**
 * Subtitle tracks inside the film.
 *
 * The reason this exists at all: a Matroska carrying three subtitle tracks
 * reports `textTracks.length === 0` to the media element. Chromium demuxes the
 * video and the audio and does not surface the rest, so there is no way to
 * offer those tracks from the renderer -- they have to be found with ffprobe
 * and pulled out with ffmpeg. That was a gap that could only be named until
 * ffmpeg shipped with the application.
 *
 * Runs against real files and real ffmpeg, because the whole question is what
 * the tools actually report; a mocked ffprobe would only prove that this file
 * agrees with itself.
 */

const have = (cmd: string): boolean => {
  try { execFileSync(cmd, ['-version'], { stdio: 'ignore' }); return true } catch { return false }
}
const suite = have('ffmpeg') && have('ffprobe') ? describe : describe.skip

let dir = ''
let film = ''

beforeAll(() => {
  if (!have('ffmpeg')) return
  dir = mkdtempSync(join(tmpdir(), 'cocine-embed-'))

  const srt = join(dir, 'english.srt')
  writeFileSync(srt, '1\n00:00:01,000 --> 00:00:04,000\nSpoken in English.\n')
  // Advanced SubStation, so both kinds are represented -- they are extracted
  // differently, one copied and one converted.
  const ass = join(dir, 'styled.ass')
  writeFileSync(ass, [
    '[Script Info]', 'ScriptType: v4.00+', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Alignment, MarginV, Encoding',
    'Style: Default,Arial,48,&H00FFFFFF,0,2,30,1', '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\pos(960,900)}Styled line'
  ].join('\n'))

  film = join(dir, 'film.mkv')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-i', srt, '-i', ass,
    '-map', '0:v', '-map', '1:a', '-map', '2:s', '-map', '3:s',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-c:s:0', 'srt', '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English',
    '-c:s:1', 'ass', '-metadata:s:s:1', 'language=jpn',
    '-shortest', film
  ], { stdio: 'ignore' })
}, 180_000)

afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

suite('subtitle tracks inside the film', () => {
  it('finds tracks the media element never reports', async () => {
    const tracks = await embeddedSubtitles(film)
    expect(tracks).toHaveLength(2)
    expect(tracks.every(t => t.drawable)).toBe(true)
  }, 60_000)

  it('carries the labels the file provides, which are what a person picks by', () => {
    // A film with four audio commentaries and three subtitle tracks is only
    // navigable if the labels come through; "track 3" is not a choice.
    return embeddedSubtitles(film).then(tracks => {
      expect(tracks[0]).toMatchObject({ language: 'eng', title: 'English', codec: 'subrip' })
      expect(tracks[1]).toMatchObject({ language: 'jpn', codec: 'ass' })
    })
  }, 60_000)

  it('extracts a text track as SubRip, which the cue parser reads', async () => {
    const tracks = await embeddedSubtitles(film)
    const out = await extractSubtitle(film, tracks[0]!, join(dir, 'out'))
    expect(existsSync(out)).toBe(true)
    expect(subtitleKind(out)).toBe('text')

    const cues = parseSubtitles(readFileSync(out, 'utf8'))
    expect(cues.map(c => c.text)).toContain('Spoken in English.')
  }, 90_000)

  it('extracts an ASS track as ASS, so its styling survives', async () => {
    // Converting it to SubRip would throw away the positioning, which is the
    // whole reason somebody chose that format.
    const tracks = await embeddedSubtitles(film)
    const out = await extractSubtitle(film, tracks[1]!, join(dir, 'out'))
    expect(subtitleKind(out)).toBe('ass')

    const text = readFileSync(out, 'utf8')
    expect(text).toContain('[Events]')
    expect(text).toContain('\\pos(960,900)')
  }, 90_000)

  it('extracts once and reuses the file', async () => {
    const tracks = await embeddedSubtitles(film)
    const first = await extractSubtitle(film, tracks[0]!, join(dir, 'out'))
    const second = await extractSubtitle(film, tracks[0]!, join(dir, 'out'))
    expect(second).toBe(first)
  }, 90_000)

  it('refuses a bitmap track rather than producing an empty file', async () => {
    // VobSub and PGS are images per frame; ffmpeg would either fail or write
    // something no parser here can read, and saying so is better than either.
    const bitmap = { index: 9, language: null, title: null, codec: 'hdmv_pgs_subtitle', drawable: false }
    await expect(extractSubtitle(film, bitmap, join(dir, 'out'))).rejects.toThrow(/images rather than text/)
  }, 30_000)

  it('reports nothing for a film that carries no subtitles', async () => {
    const plain = join(dir, 'plain.mp4')
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', plain
    ], { stdio: 'ignore' })
    expect(await embeddedSubtitles(plain)).toEqual([])
  }, 60_000)
})
