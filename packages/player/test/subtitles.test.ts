import { describe, it, expect } from 'vitest'
import {
  parseSubtitles, parseTimestamp, cuesAt, isSubtitleFile, isUnsupportedSubtitleFile,
  subtitleKind
} from '../src/subtitles.js'

/**
 * Subtitle parsing.
 *
 * Worth testing properly rather than trusting, because subtitle files in the
 * wild are a mess: hand-edited, re-timed, converted between formats, and
 * carrying whatever markup the last tool left behind. The failure that matters
 * is not a crash -- it is one malformed cue silently taking the rest of the
 * file with it, so the film plays with no subtitles and nothing says why.
 */

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello there.

2
00:00:04,000 --> 00:00:06,000
A second line,
across two rows.
`

describe('reading a timestamp', () => {
  it('reads both separators, since SubRip and WebVTT disagree', () => {
    expect(parseTimestamp('00:00:01,500')).toBe(1.5)
    expect(parseTimestamp('00:00:01.500')).toBe(1.5)
  })

  it('reads hours, and the two-field form WebVTT allows', () => {
    expect(parseTimestamp('01:02:03,004')).toBeCloseTo(3723.004, 3)
    expect(parseTimestamp('02:03.500')).toBeCloseTo(123.5, 3)
  })

  it('treats a short fraction as hundredths rather than thousandths', () => {
    // "00:00:01,5" is one and a half seconds, not one and five thousandths.
    expect(parseTimestamp('00:00:01,5')).toBe(1.5)
    expect(parseTimestamp('00:00:01,50')).toBe(1.5)
  })

  it('returns null for nonsense instead of NaN', () => {
    // NaN would propagate into every comparison and make cues appear at random.
    for (const bad of ['', 'x', '00:00', 'abc:de:fg,hij', '1-2-3']) {
      expect(parseTimestamp(bad), bad).toBeNull()
    }
  })
})

describe('parsing SubRip', () => {
  it('reads cues, keeping the line breaks the author put in', () => {
    const cues = parseSubtitles(SRT)
    expect(cues).toHaveLength(2)
    expect(cues[0]).toEqual({ fromSec: 1, toSec: 3.5, text: 'Hello there.' })
    expect(cues[1]?.text).toBe('A second line,\nacross two rows.')
  })

  it('drops the markup a renderer has no use for', () => {
    const cues = parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\n<i>Softly</i>, {\\an8}now.\n')
    expect(cues[0]?.text).toBe('Softly, now.')
  })

  it('survives a byte-order mark and Windows line endings', () => {
    // Both are the norm rather than the exception in files from the internet.
    const cues = parseSubtitles('﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nHello.\r\n')
    expect(cues[0]?.text).toBe('Hello.')
  })

  it('skips a malformed cue without losing the rest of the file', () => {
    // The failure this exists for: one bad line taking two thousand good ones
    // with it, and the film playing silently with nothing said about why.
    const cues = parseSubtitles(`1
00:00:01,000 --> 00:00:02,000
Good.

2
not a timestamp at all
Ignored.

3
00:00:05,000 --> 00:00:06,000
Also good.
`)
    expect(cues.map(c => c.text)).toEqual(['Good.', 'Also good.'])
  })

  it('refuses a cue that ends before it starts', () => {
    expect(parseSubtitles('1\n00:00:05,000 --> 00:00:01,000\nBackwards.\n')).toHaveLength(0)
  })

  it('drops a cue with timings and no words', () => {
    expect(parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\n\n')).toHaveLength(0)
  })

  it('sorts, so lookup can assume order even in a hand-merged file', () => {
    const cues = parseSubtitles(`1
00:00:09,000 --> 00:00:10,000
Later.

2
00:00:01,000 --> 00:00:02,000
Earlier.
`)
    expect(cues.map(c => c.text)).toEqual(['Earlier.', 'Later.'])
  })
})

describe('parsing WebVTT', () => {
  it('skips the header, notes and style blocks', () => {
    const cues = parseSubtitles(`WEBVTT - Some title

NOTE this is a comment
and it continues

STYLE
::cue { color: red }

00:00:01.000 --> 00:00:02.000
Hello.
`)
    expect(cues.map(c => c.text)).toEqual(['Hello.'])
  })

  it('ignores the positioning settings after the end time', () => {
    // Position is the viewer's choice here, not the file's -- which is the
    // whole reason cues are drawn rather than handed to a <track>.
    const cues = parseSubtitles('WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:90% align:start\nHello.\n')
    expect(cues[0]).toMatchObject({ fromSec: 1, toSec: 2, text: 'Hello.' })
  })

  it('reads a cue with an identifier line before the timings', () => {
    const cues = parseSubtitles('WEBVTT\n\nintro\n00:00:01.000 --> 00:00:02.000\nHello.\n')
    expect(cues[0]?.text).toBe('Hello.')
  })
})

describe('finding what is on screen', () => {
  const cues = parseSubtitles(SRT)

  it('shows a cue for exactly its own span', () => {
    expect(cuesAt(cues, 0.5)).toHaveLength(0)
    expect(cuesAt(cues, 1)).toHaveLength(1)
    expect(cuesAt(cues, 3.49).map(c => c.text)).toEqual(['Hello there.'])
    // The end is exclusive, or two adjacent cues would both show for an instant.
    expect(cuesAt(cues, 3.5)).toHaveLength(0)
  })

  it('shifts everything when an offset is set', () => {
    // The control everyone reaches for first, for subtitles timed against a
    // different release. A positive offset shows each line later.
    expect(cuesAt(cues, 1)).toHaveLength(1)
    expect(cuesAt(cues, 1, 2)).toHaveLength(0)
    expect(cuesAt(cues, 3, 2).map(c => c.text)).toEqual(['Hello there.'])
  })

  it('returns every cue that overlaps, since files put signs beside dialogue', () => {
    const both = parseSubtitles(`1
00:00:01,000 --> 00:00:05,000
A sign on the wall

2
00:00:02,000 --> 00:00:03,000
Someone speaking
`)
    expect(cuesAt(both, 2.5)).toHaveLength(2)
  })
})

describe('which files to offer to open', () => {
  it('accepts what can be read', () => {
    expect(isSubtitleFile('film.srt')).toBe(true)
    expect(isSubtitleFile('FILM.SRT')).toBe(true)
    expect(isSubtitleFile('film.vtt')).toBe(true)
    expect(isSubtitleFile('film.mkv')).toBe(false)
  })

  it('sends Advanced SubStation to libass rather than parsing it here', () => {
    // Its whole reason for existing is styling -- positioning, karaoke,
    // per-character animation -- so reading the text and dropping all of that
    // would look like support while producing something visibly wrong. It is
    // accepted, and drawn by something that understands it.
    for (const name of ['film.ass', 'film.SSA']) {
      expect(subtitleKind(name), name).toBe('ass')
      expect(isSubtitleFile(name), name).toBe(true)
      expect(isUnsupportedSubtitleFile(name), name).toBe(false)
    }
  })

  it('parses the text formats here', () => {
    expect(subtitleKind('film.srt')).toBe('text')
    expect(subtitleKind('film.vtt')).toBe('text')
    expect(subtitleKind('film.mkv')).toBeNull()
  })

  it('still names the bitmap formats, which are images rather than text', () => {
    // VobSub and PGS need a decoder and a compositor, not a parser.
    for (const name of ['film.sup', 'film.idx', 'film.sub']) {
      expect(isUnsupportedSubtitleFile(name), name).toBe(true)
      expect(isSubtitleFile(name), name).toBe(false)
    }
  })
})
