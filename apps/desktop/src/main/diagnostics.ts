import type { Logger } from '@cocine/logging'

/**
 * What the log records about the room, playback and transfer.
 *
 * A night of testing several films across several machines once left logs
 * holding voice and nothing else: the room client, the sync engine, the player
 * and the transfer all reported to `console.log`, which an installed copy
 * sends nowhere. Every question about what went wrong had to be answered from
 * memory. This is the part of the application that writes those answers down.
 *
 * Kept apart from index.ts, and free of Electron, so what gets logged -- and,
 * as importantly, what does not, since a line ten times a second is as useless
 * as none -- is tested rather than hoped for.
 */

/**
 * A `[channel] message` line to the matching log channel.
 *
 * The existing progress lines are written with their channel as a prefix
 * (`[film] loaded dune.mkv`). Rather than rewrite every call site, the prefix
 * is read and honoured, so they land in `logs/film/` beside everything else
 * about films. Unprefixed lines go to the fallback channel.
 */
export function lineLogger (
  get: (channel: string) => Logger,
  fallback = 'main'
): (line: string, level?: 'error' | 'warn' | 'info' | 'debug', data?: unknown) => void {
  return (line, level = 'info', data) => {
    const m = /^\[([a-z][a-z0-9.-]{0,30})\]\s*(.*)$/s.exec(line)
    const log = get(m ? m[1]! : fallback)
    log[level](m ? m[2]! : line, data)
  }
}

/** Just enough of a RoomClient to watch it. */
export interface WatchedRoom {
  on: (event: string, fn: (...args: any[]) => void) => unknown
  memberId: string
  code: string | null
}

interface MemberLike { id: string; name: string; isHost?: boolean; inVoice?: boolean }

/**
 * Log what happens to a room: the connection dropping and coming back, the
 * member id changing (which is what a reconnect looks like from here), people
 * arriving and leaving, the film changing, the server refusing something, and
 * every corrective action the sync engine takes.
 *
 * Rate changes are the exception. The engine nudges the rate continually to
 * hold drift down, and logging each would bury the seeks, which are the
 * corrections worth reading; they go at debug.
 */
export function watchRoom (room: WatchedRoom, log: Logger): void {
  let members = new Map<string, MemberLike>()
  let memberId = ''
  const short = (id: string): string => id.slice(0, 8)

  room.on('connection', (state: string) => {
    if (state === 'connected') log.info('connection restored', { memberId: short(room.memberId) })
    else if (state === 'reconnecting') log.warn('connection lost; reconnecting', { memberId: short(room.memberId) })
    else log.info('connection closed')
  })
  room.on('welcome', (code: string | null) => {
    if (memberId && memberId !== room.memberId) {
      log.info('member id changed', { was: short(memberId), now: short(room.memberId), code })
    } else log.info('joined room', { memberId: short(room.memberId), code })
    memberId = room.memberId
  })
  room.on('members', (list: MemberLike[]) => {
    const next = new Map(list.map(m => [m.id, m]))
    if (members.size === 0) {
      // The first list is who was already here, not a stream of arrivals.
      log.info('members', { list: list.map(m => ({ id: short(m.id), name: m.name, host: !!m.isHost, inVoice: !!m.inVoice })) })
      members = next
      return
    }
    for (const [id, m] of next) {
      const was = members.get(id)
      if (!was) log.info('member joined', { id: short(id), name: m.name, host: !!m.isHost })
      else {
        if (!was.isHost && m.isHost) log.info('host is now', { id: short(id), name: m.name })
        if (!!was.inVoice !== !!m.inVoice) log.info(m.inVoice ? 'member joined voice' : 'member left voice', { id: short(id), name: m.name })
      }
    }
    for (const [id, m] of members) if (!next.has(id)) log.info('member left', { id: short(id), name: m.name })
    members = next
  })
  room.on('media', (media: { name?: string; durationSec?: number; source?: { kind?: string } } | null) => {
    if (!media) log.info('room film cleared')
    else log.info('room film', { name: media.name, durationSec: media.durationSec, source: media.source?.kind ?? 'none' })
  })
  room.on('server-error', (message: string) => log.warn('server refused', { message }))
  room.on('action', (a: { type: string; toSec?: number; reason?: string; rate?: number; driftSec?: number }) => {
    if (a.type === 'setRate') log.debug('sync rate', { rate: a.rate, driftMs: a.driftSec === undefined ? undefined : Math.round(a.driftSec * 1000) })
    else log.info(`sync ${a.type}`, { toSec: a.toSec, reason: a.reason })
  })
  room.on('action-error', (err: unknown) => log.error('sync action failed', { error: err }))
}

/** The parts of a state snapshot worth sampling. */
export interface Snapshot {
  connected: boolean
  phase?: string
  paused: boolean
  driftMs: number | null
  rttMs?: number | null
  clockOffsetMs?: number | null
  positionSec?: number | null
  mediaName?: string | null
  members?: number
  transfers: Array<{ infoHash: string; name: string; progress: number; downBps: number; upBps: number; peers: number; done: boolean; bytes?: number }>
}

export interface SamplerOptions {
  /** A summary line this often while in a room. */
  summaryEveryMs?: number
  /** Drift beyond this is an excursion. The product's promise is 100 ms. */
  driftBudgetMs?: number
  /** How long drift must stay out of budget before it counts, so a correction in flight is not news. */
  driftHoldMs?: number
  /** An unfinished transfer that has not moved for this long has stalled. */
  stallMs?: number
  now?: () => number
}

interface TransferSeen { progress: number; movedAt: number; startedAt: number; peers: number; stalled: boolean; done: boolean }

/**
 * Reads the state snapshot the interface is built from, ten times a second,
 * and writes down only what changed in a way someone would ask about later:
 *
 * - drift leaving the 100 ms budget and coming back, with its peak and how
 *   long it was out -- the one number the product promises
 * - the room's phase changing, and playback starting or stopping
 * - a transfer starting, finding its first peer or losing its last, stalling,
 *   resuming and finishing
 * - and every thirty seconds, one line with the lot, so a quiet stretch of a
 *   log is evidence that things were fine rather than an absence of evidence.
 */
export class StatusSampler {
  private readonly every: number
  private readonly budget: number
  private readonly hold: number
  private readonly stallMs: number
  private readonly now: () => number
  /** -Infinity so the first summary comes on joining, not thirty seconds in. */
  private lastSummary = -Infinity
  private phase: string | undefined
  private paused: boolean | undefined
  private outSince: number | null = null
  private reported = false
  private peak = 0
  private transfers = new Map<string, TransferSeen>()

  constructor (private readonly log: Logger, o: SamplerOptions = {}) {
    this.every = o.summaryEveryMs ?? 30_000
    this.budget = o.driftBudgetMs ?? 100
    this.hold = o.driftHoldMs ?? 1_000
    this.stallMs = o.stallMs ?? 15_000
    this.now = o.now ?? Date.now
  }

  sample (s: Snapshot): void {
    const now = this.now()
    if (!s.connected) {
      this.phase = undefined
      this.paused = undefined
      this.endExcursion(now)
    } else {
      if (s.phase !== this.phase) {
        if (this.phase !== undefined) this.log.info('phase', { from: this.phase, to: s.phase })
        this.phase = s.phase
      }
      if (s.mediaName && s.paused !== this.paused) {
        if (this.paused !== undefined) this.log.info(s.paused ? 'paused' : 'playing', { atSec: round(s.positionSec) })
        this.paused = s.paused
      }
      this.drift(s, now)
    }
    this.watchTransfers(s.transfers, now)
    if (s.connected && now - this.lastSummary >= this.every) {
      this.lastSummary = now
      this.log.info('status', {
        phase: s.phase,
        film: s.mediaName ?? null,
        atSec: round(s.positionSec),
        paused: s.paused,
        driftMs: s.driftMs === null ? null : Math.round(s.driftMs),
        rttMs: s.rttMs ?? null,
        offsetMs: s.clockOffsetMs === null || s.clockOffsetMs === undefined ? null : Math.round(s.clockOffsetMs),
        members: s.members,
        transfers: s.transfers.map(t => ({ name: t.name, pct: Math.round(t.progress * 1000) / 10, downKBps: Math.round(t.downBps / 1024), upKBps: Math.round(t.upBps / 1024), peers: t.peers }))
      })
    }
  }

  private drift (s: Snapshot, now: number): void {
    // Only while a film is playing: paused, the expected position stands still
    // and so does the film, and a figure then means nothing.
    const d = s.driftMs
    if (d === null || s.paused || !s.mediaName) { this.endExcursion(now); return }
    const over = Math.abs(d) > this.budget
    if (!over) { this.endExcursion(now); return }
    if (this.outSince === null) { this.outSince = now; this.peak = 0 }
    this.peak = Math.max(this.peak, Math.abs(d))
    if (!this.reported && now - this.outSince >= this.hold) {
      this.reported = true
      this.log.warn('drift out of budget', { driftMs: Math.round(d), budgetMs: this.budget, atSec: round(s.positionSec), rttMs: s.rttMs ?? null })
    }
  }

  private endExcursion (now: number): void {
    if (this.outSince !== null && this.reported) {
      this.log.info('drift back in budget', { peakMs: Math.round(this.peak), forMs: now - this.outSince })
    }
    this.outSince = null
    this.reported = false
    this.peak = 0
  }

  private watchTransfers (list: Snapshot['transfers'], now: number): void {
    const here = new Set<string>()
    for (const t of list) {
      here.add(t.infoHash)
      let seen = this.transfers.get(t.infoHash)
      if (!seen) {
        seen = { progress: t.progress, movedAt: now, startedAt: now, peers: t.peers, stalled: false, done: t.done }
        this.transfers.set(t.infoHash, seen)
        this.log.info('transfer started', { name: t.name, bytes: t.bytes, pct: pct(t.progress), done: t.done })
        if (t.peers > 0) this.log.info('transfer has peers', { name: t.name, peers: t.peers })
        continue
      }
      if (seen.peers === 0 && t.peers > 0) this.log.info('transfer has peers', { name: t.name, peers: t.peers })
      if (seen.peers > 0 && t.peers === 0 && !t.done) this.log.warn('transfer lost every peer', { name: t.name, pct: pct(t.progress) })
      seen.peers = t.peers
      if (t.progress > seen.progress) {
        if (seen.stalled) this.log.info('transfer resumed', { name: t.name, pct: pct(t.progress), stalledMs: now - seen.movedAt })
        seen.progress = t.progress
        seen.movedAt = now
        seen.stalled = false
      } else if (!t.done && !seen.stalled && now - seen.movedAt >= this.stallMs) {
        seen.stalled = true
        this.log.warn('transfer stalled', { name: t.name, pct: pct(t.progress), peers: t.peers, forMs: now - seen.movedAt })
      }
      if (t.done && !seen.done) {
        seen.done = true
        const ms = now - seen.startedAt
        this.log.info('transfer complete', { name: t.name, ms, avgMBps: t.bytes && ms > 0 ? Math.round(t.bytes / (ms / 1000) / 1024 ** 2 * 10) / 10 : undefined })
      }
    }
    for (const [id] of this.transfers) if (!here.has(id)) this.transfers.delete(id)
  }
}

const round = (x: number | null | undefined): number | null =>
  x === null || x === undefined ? null : Math.round(x * 10) / 10
const pct = (p: number): number => Math.round(p * 1000) / 10
