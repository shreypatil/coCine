/**
 * Whether the `<video>` engine can play a file, and what to do when it cannot.
 *
 * Phase B1.5. Measured against Electron 44 (Chromium 152) rather than assumed,
 * because the assumptions are mostly wrong in both directions: Matroska plays,
 * which the common wisdom says it does not; AC-3 and DTS play through a plain
 * `src=` even though `MediaSource.isTypeSupported` reports them unsupported,
 * because that path uses Chromium's full FFmpeg demuxer while MSE is narrower.
 * What genuinely does not open is AVI and MPEG-2, both of which fail with
 * `DEMUXER_ERROR_COULD_NOT_OPEN`.
 *
 * The interesting part is that the answer is not binary. A file can fail for
 * three quite different reasons, costing three quite different amounts to fix:
 *
 *   - the **container** is unreadable but the streams inside are fine, which is
 *     the usual case for AVI carrying H.264. Repacking copies the streams
 *     untouched and runs at disk speed.
 *   - the **audio** is unreadable, which is cheap to re-encode; audio is a
 *     percent or two of a film's bitrate.
 *   - the **video** is unreadable -- MPEG-2, Xvid, VC-1 -- which means a real
 *     transcode, minutes of CPU for a feature-length film.
 *
 * Telling them apart is worth doing because the third is the only one where the
 * honest answer might be "use the mpv engine for this film instead", which is
 * available precisely because both engines are kept.
 */

/** What Chromium's demuxer will open. Verified by playing one of each. */
const CONTAINERS = new Set(['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm', 'mp4', 'matroska', 'webm'])

/** Video codecs it will decode. */
const VIDEO = new Set(['h264', 'hevc', 'av1', 'vp8', 'vp9'])

/**
 * Audio codecs it will decode through a plain `src=`.
 *
 * Wider than the MSE list on purpose: ac3, eac3 and dts were each confirmed
 * playing here, and excluding them would send most film rips down a
 * re-encoding path they do not need.
 */
const AUDIO = new Set(['aac', 'ac3', 'eac3', 'dts', 'flac', 'opus', 'vorbis', 'mp3', 'pcm_s16le'])

export interface ProbedStream { kind: 'video' | 'audio' | 'other'; codec: string }
export interface Probed {
  /** ffprobe's `format_name`, which is a comma-joined list of aliases. */
  container: string
  streams: ProbedStream[]
}

export type CompatAction = 'direct' | 'repack' | 'audio' | 'transcode'

export interface Compatibility {
  action: CompatAction
  /** Why, in a sentence the interface can show without rewriting. */
  reason: string
  /** Whether this will take real time rather than running at disk speed. */
  slow: boolean
}

const firstOf = (p: Probed, kind: 'video' | 'audio'): string | null =>
  p.streams.find(s => s.kind === kind)?.codec.toLowerCase() ?? null

/**
 * What to do with a file.
 *
 * Deliberately conservative about the unknown: a codec nobody listed is treated
 * as unplayable and re-encoded, rather than attempted and left as a black
 * rectangle. Being wrong in that direction costs CPU; the other direction costs
 * a film that does not play with no explanation.
 */
export function compatibilityOf (probed: Probed): Compatibility {
  const container = probed.container.toLowerCase()
  const containerOk = CONTAINERS.has(container) ||
    container.split(',').some(c => CONTAINERS.has(c.trim()))

  const video = firstOf(probed, 'video')
  const audio = firstOf(probed, 'audio')
  // A file with no video stream at all is not something to repack hopefully.
  const videoOk = video !== null && VIDEO.has(video)
  // No audio is fine: silent films and video-only rips both exist.
  const audioOk = audio === null || AUDIO.has(audio)

  if (!videoOk) {
    return {
      action: 'transcode',
      reason: video
        ? `the video is ${video}, which this player cannot decode`
        : 'the file has no video stream this player can read',
      slow: true
    }
  }
  if (!audioOk) {
    return {
      action: 'audio',
      reason: `the audio is ${audio}, which this player cannot decode`,
      slow: false
    }
  }
  if (!containerOk) {
    return {
      action: 'repack',
      reason: `${container.split(',')[0]} is not a container this player can open, ` +
        'but everything inside it can be played as it is',
      slow: false
    }
  }
  return { action: 'direct', reason: 'plays as it is', slow: false }
}

/** Parse `ffprobe -show_format -show_streams -of json` output. */
export function parseProbe (json: string): Probed | null {
  let data: {
    format?: { format_name?: string }
    streams?: Array<{ codec_type?: string; codec_name?: string }>
  }
  try { data = JSON.parse(json) } catch { return null }
  if (!data.format?.format_name) return null
  return {
    container: data.format.format_name,
    streams: (data.streams ?? []).map(s => ({
      kind: s.codec_type === 'video' || s.codec_type === 'audio' ? s.codec_type : 'other',
      codec: s.codec_name ?? ''
    }))
  }
}

/**
 * The ffmpeg arguments that make a file playable.
 *
 * Always Matroska out, because it takes every combination of streams that might
 * survive a copy -- MP4 would refuse several of them -- and because Chromium
 * opens it, which is the whole point.
 */
export function conversionArgs (action: CompatAction, input: string, output: string): string[] {
  const base = [
    '-hide_banner', '-loglevel', 'error', '-stats', '-y',
    // AVI does not carry usable presentation timestamps, and Matroska refuses a
    // packet without one -- so a straight stream copy out of an AVI fails with
    // "Can't write packet with unknown timestamp" and produces a one-kilobyte
    // file. Generating them costs nothing on a container that already has them.
    '-fflags', '+genpts',
    '-i', input
  ]
  switch (action) {
    case 'repack':
      // Nothing is re-encoded; this runs at the speed of the disk.
      return [...base, '-c', 'copy', '-map', '0:v:0', '-map', '0:a:0?', output]
    case 'audio':
      // Video copied, audio re-encoded. A film's audio is a percent or two of
      // its bitrate, so this is far closer to a repack than to a transcode.
      return [...base, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-map', '0:v:0', '-map', '0:a:0?', output]
    case 'transcode':
      // The expensive one. veryfast rather than a slower preset: this is
      // somebody waiting to watch a film, not an archival encode.
      return [...base, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
        '-map', '0:v:0', '-map', '0:a:0?', output]
    case 'direct':
      return []
  }
}
