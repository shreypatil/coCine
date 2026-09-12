import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogHub, RateSummary, render, type Sink, type Level } from '../src/index.js'
import { FileSink, dayStamp } from '../src/file-sink.js'

/**
 * A logger has an unusual obligation: it must never be the reason something
 * fails. Most of what is checked here is that it degrades rather than throws --
 * a full disk, a cyclic object, a sink that itself explodes.
 */

const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'cocine-log-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const collect = (): { sink: Sink; lines: string[] } => {
  const lines: string[] = []
  return { sink: { write: l => lines.push(l) }, lines }
}

describe('levels', () => {
  it('records at and above the configured level, and nothing below', () => {
    const { sink, lines } = collect()
    const hub = new LogHub({ level: 'info', sinks: [sink] })
    const log = hub.logger('room')
    log.error('a'); log.warn('b'); log.info('c'); log.debug('d'); log.trace('e')
    expect(lines.map(l => l.split(' ')[1]?.trim())).toEqual(['ERROR', 'WARN', 'INFO'])
  })

  it('can be raised at runtime, which is the point of having a level', () => {
    const { sink, lines } = collect()
    const hub = new LogHub({ level: 'info', sinks: [sink] })
    hub.logger('x').debug('quiet')
    hub.setLevel('trace')
    hub.logger('x').debug('loud')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('loud')
  })
})

describe('the line format', () => {
  it('leads with a timestamp, level and channel, so grep and eyes both work', () => {
    const { sink, lines } = collect()
    const hub = new LogHub({ sinks: [sink], now: () => new Date('2026-09-12T08:30:00.000Z') })
    hub.logger('voice').info('offer sent', { to: 'abc' })
    expect(lines[0]).toBe('2026-09-12T08:30:00.000Z INFO  [voice] offer sent {"to":"abc"}')
  })

  it('names a child channel after its parent', () => {
    const { sink, lines } = collect()
    const hub = new LogHub({ sinks: [sink] })
    hub.logger('voice').child('mesh').info('opened')
    expect(lines[0]).toContain('[voice.mesh]')
  })
})

describe('rendering values', () => {
  it('keeps an error readable rather than logging {}', () => {
    // JSON.stringify(new Error(...)) is "{}", which is how a logged failure
    // becomes less informative than no log at all.
    const out = render(new Error('microphone blocked'))
    expect(out).toContain('microphone blocked')
    expect(out).toContain('stack')
  })

  it('survives a cycle instead of overflowing the stack', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    expect(render(a)).toContain('[Circular]')
  })

  it('truncates something enormous, so an SDP does not fill the file', () => {
    const out = render({ sdp: 'v=0'.repeat(50_000) }, 200)
    expect(out.length).toBeLessThan(300)
    expect(out).toContain('chars)')
  })

  it('never throws, whatever it is handed', () => {
    expect(() => render({ big: 10n, fn: () => 1, un: undefined, sym: Symbol('s') })).not.toThrow()
  })
})

describe('around()', () => {
  it('records the parameters and the return value', () => {
    const { sink, lines } = collect()
    const hub = new LogHub({ level: 'debug', sinks: [sink] })
    const log = hub.logger('room')
    const out = log.around('join', { code: 'ABCD' }, () => ({ memberId: 'm1' }))
    expect(out).toEqual({ memberId: 'm1' })
    expect(lines[0]).toContain('join received {"code":"ABCD"}')
    expect(lines[1]).toContain('join returned')
    expect(lines[1]).toContain('"memberId":"m1"')
  })

  it('waits for a promise rather than logging it as {}', async () => {
    const { sink, lines } = collect()
    const hub = new LogHub({ level: 'debug', sinks: [sink] })
    const out = await hub.logger('room').around('fetch', {}, async () => 'done')
    expect(out).toBe('done')
    expect(lines.at(-1)).toContain('"value":"done"')
  })

  it('logs a throw as an error and still rethrows it', () => {
    const { sink, lines } = collect()
    const hub = new LogHub({ level: 'debug', sinks: [sink] })
    expect(() => hub.logger('x').around('boom', {}, () => { throw new Error('nope') })).toThrow('nope')
    expect(lines.at(-1)).toContain('boom threw')
    expect(lines.at(-1)).toContain('nope')
  })

  it('logs a rejection and still rejects', async () => {
    const { sink, lines } = collect()
    const hub = new LogHub({ level: 'debug', sinks: [sink] })
    await expect(hub.logger('x').around('boom', {}, async () => { throw new Error('nope') })).rejects.toThrow('nope')
    expect(lines.at(-1)).toContain('boom threw')
  })

  it('does not even build the arguments when debug is off', () => {
    // The hot path must not pay for logging that is switched off.
    const hub = new LogHub({ level: 'info', sinks: [collect().sink] })
    let built = 0
    const params = { get expensive () { built++; return 1 } }
    hub.logger('x').around('f', params, () => 1)
    expect(built).toBe(0)
  })
})

describe('never breaking the caller', () => {
  it('carries on when a sink throws', () => {
    const good = collect()
    const bad: Sink = { write: () => { throw new Error('disk on fire') } }
    const hub = new LogHub({ sinks: [bad, good.sink] })
    expect(() => hub.logger('x').info('still here')).not.toThrow()
    expect(good.lines).toHaveLength(1)
  })

  it('carries on when the log directory cannot be written', () => {
    // A path *inside a regular file*, which cannot become a directory: ENOTDIR
    // immediately, on any platform. (A path under /proc seems the obvious
    // choice and is not -- on a sandboxed machine the mkdir hangs instead of
    // failing, which turns a test of graceful degradation into a hung suite.)
    const root = tmp()
    const notADir = join(root, 'file')
    writeFileSync(notADir, 'x')
    const sink = new FileSink({ root: join(notADir, 'nested') })
    expect(() => sink.write('line', 'room', 'info' as Level)).not.toThrow()
  })
})

describe('files on disk', () => {
  it('writes one directory per channel and one file per day', () => {
    const root = tmp()
    const sink = new FileSink({ root, now: () => new Date('2026-09-12T10:00:00Z') })
    const hub = new LogHub({ sinks: [sink], now: () => new Date('2026-09-12T10:00:00Z') })
    hub.logger('voice').info('joined')
    hub.logger('room').info('created')

    const day = dayStamp(new Date('2026-09-12T10:00:00Z'))
    expect(existsSync(join(root, 'voice', `${day}.log`))).toBe(true)
    expect(existsSync(join(root, 'room', `${day}.log`))).toBe(true)
    expect(readFileSync(join(root, 'voice', `${day}.log`), 'utf8')).toContain('joined')
  })

  it('appends rather than truncating, so a restart keeps the history', () => {
    const root = tmp()
    const at = () => new Date('2026-09-12T10:00:00Z')
    for (const msg of ['first', 'second']) {
      new LogHub({ sinks: [new FileSink({ root, now: at })], now: at }).logger('room').info(msg)
    }
    const text = readFileSync(join(root, 'room', `${dayStamp(at())}.log`), 'utf8')
    expect(text).toContain('first')
    expect(text).toContain('second')
  })

  it('cannot be made to write outside its root by a channel name', () => {
    const root = tmp()
    new FileSink({ root }).write('line', '../../escaped', 'info' as Level)
    expect(existsSync(join(root, '..', '..', 'escaped'))).toBe(false)
    expect(readdirSync(root)).toContain('.._.._escaped')
  })
})

describe('pruning old days', () => {
  const seed = (root: string, channel: string, day: string): string => {
    mkdirSync(join(root, channel), { recursive: true })
    const f = join(root, channel, `${day}.log`)
    writeFileSync(f, 'x'.repeat(100))
    return f
  }

  it('removes days past the window and keeps the rest', () => {
    const root = tmp()
    const now = new Date('2026-09-12T10:00:00Z').getTime()
    const old = seed(root, 'voice', '2026-09-01')
    const recent = seed(root, 'voice', '2026-09-11')

    const { removed, freedBytes } = new FileSink({ root, keepDays: 7 }).prune(now)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(removed).toEqual([join('voice', '2026-09-01.log')])
    expect(freedBytes).toBe(100)
  })

  it('goes by the name rather than the modification time', () => {
    // Today's file is appended to constantly and an old one may be touched by a
    // backup. The date in the name is the fact; mtime is not.
    const root = tmp()
    const f = seed(root, 'room', '2026-08-01')
    const now = new Date('2026-09-12T10:00:00Z').getTime()
    // mtime is "now", but the name says August.
    new FileSink({ root, keepDays: 7 }).prune(now)
    expect(existsSync(f)).toBe(false)
  })

  it('leaves files that are not day logs alone', () => {
    const root = tmp()
    mkdirSync(join(root, 'voice'), { recursive: true })
    const keep = join(root, 'voice', 'notes.txt')
    writeFileSync(keep, 'not mine')
    new FileSink({ root, keepDays: 0 }).prune(Date.now())
    expect(existsSync(keep)).toBe(true)
  })

  it('says nothing and does nothing when there is no log directory yet', () => {
    expect(new FileSink({ root: join(tmp(), 'absent') }).prune(Date.now()))
      .toEqual({ removed: [], freedBytes: 0 })
  })
})

describe('summarising traffic instead of logging it', () => {
  it('reports counts rather than one line per message', () => {
    const { sink, lines } = collect()
    const hub = new LogHub({ sinks: [sink] })
    const s = new RateSummary(hub.logger('server'), 60_000)
    for (let i = 0; i < 5000; i++) s.count('time.ping')
    for (let i = 0; i < 1200; i++) s.count('peer.report')
    s.flush()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"time.ping":5000')
    expect(lines[0]).toContain('"peer.report":1200')
  })

  it('says nothing when nothing happened', () => {
    const { sink, lines } = collect()
    new RateSummary(new LogHub({ sinks: [sink] }).logger('s')).flush()
    expect(lines).toHaveLength(0)
  })
})
