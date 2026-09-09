import { describe, it, expect } from 'vitest'
import { compatibilityOf, parseProbe, conversionArgs, type Probed } from '../src/compat.js'

/**
 * What the `<video>` engine can play, and what it costs to fix what it cannot.
 *
 * Every membership in these sets was measured against Electron 44 by playing a
 * file of that shape, not assumed -- and the measurements contradicted the
 * usual wisdom in both directions. Matroska plays. AC-3 and DTS play through a
 * plain `src=` while `MediaSource.isTypeSupported` says they do not, because
 * that path uses Chromium's full FFmpeg demuxer and MSE is the narrower
 * surface. AVI and MPEG-2 genuinely do not open.
 *
 * The distinction these tests protect is not "plays or does not". It is how
 * *expensive* the fix is, because only the expensive case is worth telling
 * somebody about, and only there is "use the mpv engine for this one" the
 * better answer.
 */

const file = (container: string, video: string | null, audio: string | null): Probed => ({
  container,
  streams: [
    ...(video ? [{ kind: 'video' as const, codec: video }] : []),
    ...(audio ? [{ kind: 'audio' as const, codec: audio }] : [])
  ]
})

describe('files that play as they are', () => {
  it('accepts what was measured playing', () => {
    // Each of these was played in Electron before being listed here.
    const fine: Probed[] = [
      file('mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'aac'),
      file('matroska,webm', 'h264', 'aac'),
      file('matroska,webm', 'h264', 'ac3'),
      file('matroska,webm', 'h264', 'dts'),
      file('mov,mp4,m4a,3gp,3g2,mj2', 'hevc', 'aac'),
      file('matroska,webm', 'av1', 'opus'),
      file('matroska,webm', 'vp9', 'opus')
    ]
    for (const f of fine) {
      expect(compatibilityOf(f).action, `${f.container} ${f.streams[0]?.codec}`).toBe('direct')
    }
  })

  it('accepts a film with no audio at all', () => {
    // Silent films and video-only rips both exist; treating missing audio as a
    // fault would send them down a re-encode for nothing.
    expect(compatibilityOf(file('matroska,webm', 'h264', null)).action).toBe('direct')
  })
})

describe('files that need only repacking', () => {
  it('repacks AVI whose streams are already playable', () => {
    // The common case for an old rip that was remuxed at some point: the
    // container is unreadable and everything inside it is fine.
    const c = compatibilityOf(file('avi', 'h264', 'aac'))
    expect(c.action).toBe('repack')
    expect(c.slow).toBe(false)
    expect(c.reason).toContain('avi')
  })

  it('says the streams themselves are fine, since that is the reassuring part', () => {
    expect(compatibilityOf(file('avi', 'h264', 'aac')).reason)
      .toContain('everything inside it can be played')
  })
})

describe('files needing the audio re-encoded', () => {
  it('re-encodes audio only, and does not call it slow', () => {
    // A film's audio is a percent or two of its bitrate, so this is far closer
    // to a repack than to a transcode.
    const c = compatibilityOf(file('matroska,webm', 'h264', 'truehd'))
    expect(c.action).toBe('audio')
    expect(c.slow).toBe(false)
    expect(c.reason).toContain('truehd')
  })
})

describe('files needing a real transcode', () => {
  it('names the video codec, because this is the case worth warning about', () => {
    for (const [container, codec] of [['avi', 'mpeg4'], ['mpeg', 'mpeg2video'], ['asf', 'vc1']]) {
      const c = compatibilityOf(file(container!, codec!, 'mp3'))
      expect(c.action, codec).toBe('transcode')
      expect(c.slow, codec).toBe(true)
      expect(c.reason, codec).toContain(codec!)
    }
  })

  it('treats an unknown codec as unplayable rather than trying it hopefully', () => {
    // Wrong in this direction costs CPU. Wrong in the other direction is a
    // black rectangle with no explanation, which is much worse.
    expect(compatibilityOf(file('matroska,webm', 'some_new_codec', 'aac')).action).toBe('transcode')
  })

  it('does not claim a file with no video stream can be repacked', () => {
    const c = compatibilityOf(file('matroska,webm', null, 'aac'))
    expect(c.action).toBe('transcode')
    expect(c.reason).toContain('no video stream')
  })
})

describe('reading ffprobe output', () => {
  it('pulls the container and the streams out', () => {
    const probed = parseProbe(JSON.stringify({
      format: { format_name: 'matroska,webm' },
      streams: [
        { codec_type: 'video', codec_name: 'h264' },
        { codec_type: 'audio', codec_name: 'ac3' },
        { codec_type: 'subtitle', codec_name: 'ass' }
      ]
    }))
    expect(probed?.container).toBe('matroska,webm')
    expect(probed?.streams).toEqual([
      { kind: 'video', codec: 'h264' },
      { kind: 'audio', codec: 'ac3' },
      { kind: 'other', codec: 'ass' }
    ])
  })

  it('returns null rather than throwing on anything unexpected', () => {
    // ffprobe on a file that is not media at all prints an error, and the
    // caller should fall back rather than crash on it.
    expect(parseProbe('not json')).toBeNull()
    expect(parseProbe('{}')).toBeNull()
    expect(parseProbe(JSON.stringify({ streams: [] }))).toBeNull()
  })
})

describe('the ffmpeg arguments each action produces', () => {
  it('copies both streams for a repack, so nothing is re-encoded', () => {
    const args = conversionArgs('repack', 'in.avi', 'out.mkv')
    expect(args).toContain('-c')
    expect(args).toContain('copy')
    expect(args.join(' ')).not.toContain('libx264')
  })

  it('copies the video when only the audio is at fault', () => {
    const args = conversionArgs('audio', 'in.mkv', 'out.mkv').join(' ')
    expect(args).toContain('-c:v copy')
    expect(args).toContain('-c:a aac')
    expect(args).not.toContain('libx264')
  })

  it('re-encodes the video only when it has to', () => {
    const args = conversionArgs('transcode', 'in.mpg', 'out.mkv').join(' ')
    expect(args).toContain('libx264')
    // Somebody is waiting to watch a film, not making an archival encode.
    expect(args).toContain('veryfast')
  })

  it('tolerates a film with no audio track in every mode', () => {
    // `0:a:0?` rather than `0:a:0`: the trailing question mark makes the
    // mapping optional, and without it ffmpeg fails outright on a silent film.
    for (const action of ['repack', 'audio', 'transcode'] as const) {
      expect(conversionArgs(action, 'in', 'out').join(' '), action).toContain('0:a:0?')
    }
  })

  it('generates timestamps, without which a copy out of an AVI fails', () => {
    // Measured: Matroska refuses a packet with no presentation timestamp, and
    // AVI does not carry them -- so the repack this table asks for produced a
    // one-kilobyte file and an error until this was added.
    for (const action of ['repack', 'audio', 'transcode'] as const) {
      expect(conversionArgs(action, 'in', 'out').join(' '), action).toContain('-fflags +genpts')
    }
  })

  it('produces nothing for a file that needs no conversion', () => {
    expect(conversionArgs('direct', 'in.mkv', 'out.mkv')).toEqual([])
  })
})
