import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { LogHub } from '@cocine/logging'
import { StatusSampler, lineLogger, watchRoom, type Snapshot } from '../src/main/diagnostics.js'

/**
 * A night of testing several films once left logs holding voice and nothing
 * else. These pin down what the room, playback and transfer now write -- and
 * that they stay quiet when nothing has happened, since a line ten times a
 * second buries everything as surely as no line at all.
 */

function hub (): { hub: LogHub; lines: Array<{ channel: string; level: string; line: string }> } {
  const lines: Array<{ channel: string; level: string; line: string }> = []
  const h = new LogHub({ level: 'debug', sinks: [{ write: (line, channel, level) => lines.push({ channel, level, line }) }] })
  return { hub: h, lines }
}

describe('prefixed lines', () => {
  it('lands a [channel] line in that channel, without the prefix', () => {
    const { hub: h, lines } = hub()
    const line = lineLogger(c => h.logger(c))
    line('[film] loaded dune.mkv · duration 7200')
    line('[transfer] error', 'error', { error: new Error('tracker unreachable') })
    line('no prefix at all')
    expect(lines.map(l => [l.channel, l.level])).toEqual([['film', 'info'], ['transfer', 'error'], ['main', 'info']])
    // The prefix becomes the channel rather than being repeated in the text.
    expect(lines[0]!.line).toMatch(/INFO  \[film\] loaded dune\.mkv/)
    expect(lines[0]!.line).not.toContain('[film] [film]')
    expect(lines[1]!.line).toContain('tracker unreachable')
  })
})

describe('the room', () => {
  const room = (): EventEmitter & { memberId: string; code: string | null } =>
    Object.assign(new EventEmitter(), { memberId: 'aaaaaaaa1111', code: 'BCDFGHJK' })
  const m = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, isHost: false, inVoice: false, ...extra })

  it('records a reconnect as a lost connection and a new member id', () => {
    // The voice bug from that night was invisible for exactly this reason:
    // nothing said the member id had changed.
    const { hub: h, lines } = hub()
    const r = room()
    watchRoom(r, h.logger('room'))
    r.emit('welcome', 'BCDFGHJK')
    r.emit('connection', 'reconnecting')
    r.memberId = 'bbbbbbbb2222'
    r.emit('welcome', 'BCDFGHJK')
    r.emit('connection', 'connected')
    const text = lines.map(l => `${l.level} ${l.line}`)
    expect(text[0]).toContain('joined room')
    expect(text[1]).toMatch(/^warn .*connection lost; reconnecting/)
    expect(text[2]).toContain('member id changed')
    expect(text[2]).toContain('"was":"aaaaaaaa"')
    expect(text[2]).toContain('"now":"bbbbbbbb"')
    expect(text[3]).toContain('connection restored')
  })

  it('names who arrives, who leaves, and who joins or leaves voice -- not the whole list every time', () => {
    const { hub: h, lines } = hub()
    const r = room()
    watchRoom(r, h.logger('room'))
    r.emit('members', [m('aaaaaaaa1111', 'anjali', { isHost: true }), m('cccccccc', 'dev')])
    r.emit('members', [m('aaaaaaaa1111', 'anjali', { isHost: true }), m('cccccccc', 'dev')])
    r.emit('members', [m('aaaaaaaa1111', 'anjali', { isHost: true }), m('cccccccc', 'dev', { inVoice: true }), m('dddddddd', 'kiran')])
    r.emit('members', [m('aaaaaaaa1111', 'anjali', { isHost: true }), m('dddddddd', 'kiran')])
    const text = lines.map(l => l.line)
    expect(text).toHaveLength(4)
    expect(text[0]).toContain('members')
    expect(text[1]).toContain('member joined voice')
    expect(text[2]).toContain('member joined')
    expect(text[2]).toContain('kiran')
    expect(text[3]).toContain('member left')
    expect(text[3]).toContain('dev')
  })

  it('records seeks and failed corrections, and keeps rate nudges at debug', () => {
    const { hub: h, lines } = hub()
    const r = room()
    watchRoom(r, h.logger('room'))
    r.emit('action', { type: 'setRate', rate: 1.02, driftSec: 0.04 })
    r.emit('action', { type: 'seek', toSec: 612.4, reason: 'drift 1.2s' })
    r.emit('action-error', new Error('player is gone'))
    expect(lines.map(l => l.level)).toEqual(['debug', 'info', 'error'])
    expect(lines[1]!.line).toContain('sync seek')
    expect(lines[2]!.line).toContain('player is gone')
  })
})

describe('the status sampler', () => {
  const base: Snapshot = {
    connected: true, phase: 'playing', paused: false, driftMs: 10, rttMs: 40, clockOffsetMs: 3,
    positionSec: 100, mediaName: 'dune.mkv', members: 2, transfers: []
  }
  function sampler (o: Record<string, number> = {}): { s: StatusSampler; lines: string[]; levels: string[]; at: (ms: number) => void } {
    const { hub: h, lines } = hub()
    let t = 0
    const s = new StatusSampler(h.logger('status'), { summaryEveryMs: 1e9, now: () => t, ...o })
    return {
      s,
      get lines () { return lines.map(l => l.line) },
      get levels () { return lines.map(l => l.level) },
      at: (ms: number) => { t = ms }
    } as never
  }

  it('is silent while nothing changes', () => {
    const x = sampler()
    for (let i = 0; i < 100; i++) { x.at(i * 100); x.s.sample(base) }
    // The first summary only.
    expect(x.lines).toHaveLength(1)
    expect(x.lines[0]).toContain('status')
  })

  it('reports drift that leaves the budget and stays out, then its return with the peak', () => {
    const x = sampler()
    x.at(0); x.s.sample(base)
    // Out for 0.5 s: a correction in flight, not news.
    x.at(100); x.s.sample({ ...base, driftMs: 180 })
    x.at(600); x.s.sample({ ...base, driftMs: 20 })
    expect(x.lines.some(l => /drift (out|back)/.test(l))).toBe(false)
    // Out for over a second.
    x.at(1000); x.s.sample({ ...base, driftMs: -150 })
    x.at(1800); x.s.sample({ ...base, driftMs: -320 })
    x.at(2100); x.s.sample({ ...base, driftMs: -240 })
    x.at(2500); x.s.sample({ ...base, driftMs: 30 })
    const drift = x.lines.filter(l => /drift (out|back)/.test(l))
    expect(drift).toHaveLength(2)
    expect(drift[0]).toContain('drift out of budget')
    expect(drift[1]).toContain('drift back in budget')
    expect(drift[1]).toContain('"peakMs":320')
    expect(drift[1]).toContain('"forMs":1500')
  })

  it('ignores drift while paused, when the figure means nothing', () => {
    const x = sampler()
    for (let i = 0; i < 30; i++) { x.at(i * 100); x.s.sample({ ...base, paused: true, driftMs: 5000 }) }
    expect(x.lines.some(l => /drift (out|back)/.test(l))).toBe(false)
  })

  it('records phase changes and playback starting and stopping', () => {
    const x = sampler()
    x.at(0); x.s.sample({ ...base, phase: 'preparing', paused: true })
    x.at(100); x.s.sample({ ...base, phase: 'ready', paused: true })
    x.at(200); x.s.sample({ ...base, phase: 'playing', paused: false })
    x.at(300); x.s.sample({ ...base, phase: 'playing', paused: true })
    const text = x.lines.slice(1)
    expect(text[0]).toContain('"from":"preparing","to":"ready"')
    expect(text[1]).toContain('"from":"ready","to":"playing"')
    expect(text[2]).toContain('playing')
    expect(text[3]).toContain('paused')
  })

  it('follows a transfer: start, first peer, stall, resume, completion', () => {
    // "Progress stays at 0 %, peers stays at 0" is the symptom of a connection
    // that never formed; these lines are what tell it apart from a slow one.
    const x = sampler({ stallMs: 10_000 })
    const t = { infoHash: 'h1', name: 'dune.mkv', progress: 0, downBps: 0, upBps: 0, peers: 0, done: false, bytes: 2 * 1024 ** 3 }
    x.at(0); x.s.sample({ ...base, transfers: [t] })
    x.at(2000); x.s.sample({ ...base, transfers: [{ ...t, peers: 1 }] })
    x.at(4000); x.s.sample({ ...base, transfers: [{ ...t, peers: 1, progress: 0.2 }] })
    x.at(15_000); x.s.sample({ ...base, transfers: [{ ...t, peers: 1, progress: 0.2 }] })
    x.at(15_100); x.s.sample({ ...base, transfers: [{ ...t, peers: 1, progress: 0.2 }] })
    x.at(20_000); x.s.sample({ ...base, transfers: [{ ...t, peers: 1, progress: 0.5 }] })
    x.at(40_000); x.s.sample({ ...base, transfers: [{ ...t, peers: 0, progress: 1, done: true }] })
    const text = x.lines.filter(l => /\] transfer /.test(l))
    expect(text.map(l => /\] (transfer(?: [a-z]+)+)/.exec(l)?.[1])).toEqual([
      'transfer started', 'transfer has peers', 'transfer stalled', 'transfer resumed', 'transfer complete'
    ])
    expect(text[4]).toContain('"avgMBps":51.2')
  })

  it('warns when a transfer loses its last peer before it is finished', () => {
    const x = sampler()
    const t = { infoHash: 'h1', name: 'dune.mkv', progress: 0.3, downBps: 1e6, upBps: 0, peers: 2, done: false, bytes: 100 }
    x.at(0); x.s.sample({ ...base, transfers: [t] })
    x.at(100); x.s.sample({ ...base, transfers: [{ ...t, peers: 0 }] })
    expect(x.lines.some(l => l.includes('transfer lost every peer'))).toBe(true)
    expect(x.levels.at(-1)).toBe('warn')
  })

  it('writes a summary on its interval, and none outside a room', () => {
    const x = sampler({ summaryEveryMs: 30_000 })
    for (let t = 0; t <= 90_000; t += 100) { x.at(t); x.s.sample(base) }
    expect(x.lines.filter(l => l.includes('status'))).toHaveLength(4)
    const y = sampler({ summaryEveryMs: 30_000 })
    for (let t = 0; t <= 90_000; t += 100) { y.at(t); y.s.sample({ ...base, connected: false }) }
    expect(y.lines).toHaveLength(0)
  })
})
