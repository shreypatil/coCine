/**
 * Timestamped, channelled logging that survives the session.
 *
 * Written because too much of this project has been debugged by inference. The
 * voice pipeline in particular failed for days with no record of what it had
 * tried: every layer looked correct when read, and nothing said what had
 * actually happened at runtime.
 *
 * Three things it has to get right:
 *
 * **Volume.** "Log everything" is not free. At 1500 connections the server
 * receives about 2,250 messages a second -- a `time.ping` every two seconds and
 * a `peer.report` every second, per client -- which at a couple of hundred
 * bytes each is tens of gigabytes a day against 24 GB of disk. So the noisy,
 * uninformative traffic sits at `trace`, off unless asked for, and is reported
 * as periodic counts instead. Everything a person actually does, and the whole
 * of call setup, is logged in full at `info`: those are rare and they are what
 * you need at three in the morning.
 *
 * **Never breaking the thing it watches.** A logger that throws because a disk
 * filled, or that serialises a cyclic object forever, has made the failure
 * worse. Every write is guarded and every value is rendered defensively.
 *
 * **Being readable without tooling.** One line per record, timestamp first, so
 * `grep`, `tail -f` and eyes all work. The structured part is JSON at the end
 * of the line for when something needs parsing.
 */

export const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const
export type Level = (typeof LEVELS)[number]

const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 }

export interface Sink {
  write: (line: string, channel: string, level: Level) => void
  close?: () => void
}

export interface LoggerOptions {
  /** Nothing below this is recorded. */
  level?: Level
  sinks?: Sink[]
  now?: () => Date
}

/**
 * Render a value for a log line.
 *
 * Deliberately lossy and deliberately total: a log line is not a serialisation
 * format, and the only unacceptable outcome is throwing. Errors keep their
 * message and stack because that is the whole reason they are being logged;
 * cycles become "[Circular]" rather than a stack overflow; anything very long
 * is truncated, since a 4 MB SDP in a log file helps nobody.
 */
export function render (value: unknown, maxLen = 2000): string {
  const seen = new WeakSet<object>()
  const replacer = (_k: string, v: unknown): unknown => {
    if (v instanceof Error) return { error: v.message, stack: v.stack?.split('\n').slice(0, 4).join(' | ') }
    if (typeof v === 'bigint') return `${v.toString()}n`
    if (typeof v === 'function') return `[function ${v.name || 'anonymous'}]`
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[Circular]'
      seen.add(v)
    }
    return v
  }
  let out: string
  try {
    out = JSON.stringify(value, replacer) ?? String(value)
  } catch (e) {
    out = `[unserialisable: ${e instanceof Error ? e.message : String(e)}]`
  }
  return out.length > maxLen ? `${out.slice(0, maxLen)}…(${out.length} chars)` : out
}

export interface Logger {
  error: (msg: string, data?: unknown) => void
  warn: (msg: string, data?: unknown) => void
  info: (msg: string, data?: unknown) => void
  debug: (msg: string, data?: unknown) => void
  trace: (msg: string, data?: unknown) => void
  /**
   * Log what a call was given and what it produced, at `debug`.
   *
   * The shape this project kept needing: "foo received {params}" followed by
   * "foo returned {value}" or the error it threw, with the elapsed time, and
   * without wrapping every function by hand.
   */
  around: <T>(name: string, params: unknown, fn: () => T) => T
  /** A child channel, so `voice` can have `voice.mesh` without new plumbing. */
  child: (suffix: string) => Logger
  readonly channel: string
}

export class LogHub {
  private level: Level
  private readonly sinks: Sink[]
  private readonly now: () => Date

  constructor (o: LoggerOptions = {}) {
    this.level = o.level ?? 'info'
    this.sinks = o.sinks ?? []
    this.now = o.now ?? (() => new Date())
  }

  setLevel (level: Level): void { this.level = level }
  getLevel (): Level { return this.level }
  addSink (s: Sink): void { this.sinks.push(s) }
  enabled (level: Level): boolean { return RANK[level] <= RANK[this.level] }

  close (): void {
    for (const s of this.sinks) { try { s.close?.() } catch { /* closing must not throw */ } }
  }

  logger (channel: string): Logger {
    const at = (level: Level) => (msg: string, data?: unknown): void => {
      if (!this.enabled(level)) return
      const stamp = this.now().toISOString()
      const suffix = data === undefined ? '' : ` ${render(data)}`
      const line = `${stamp} ${level.toUpperCase().padEnd(5)} [${channel}] ${msg}${suffix}`
      for (const s of this.sinks) {
        // One failing sink must not silence the others, nor take down the
        // caller: logging is never the point of the code that calls it.
        try { s.write(line, channel, level) } catch { /* ignore */ }
      }
    }
    const self: Logger = {
      error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug'), trace: at('trace'),
      channel,
      child: (suffix: string) => this.logger(`${channel}.${suffix}`),
      around: <T>(name: string, params: unknown, fn: () => T): T => {
        if (!this.enabled('debug')) return fn()
        const started = Date.now()
        self.debug(`${name} received`, params)
        try {
          const out = fn()
          // A promise has to be awaited before its outcome is known, or every
          // async function would be logged as returning "{}" immediately.
          if (out instanceof Promise) {
            return out.then(
              v => { self.debug(`${name} returned`, { ms: Date.now() - started, value: v }); return v },
              e => { self.error(`${name} threw`, { ms: Date.now() - started, error: e }); throw e }
            ) as unknown as T
          }
          self.debug(`${name} returned`, { ms: Date.now() - started, value: out })
          return out
        } catch (e) {
          self.error(`${name} threw`, { ms: Date.now() - started, error: e })
          throw e
        }
      }
    }
    return self
  }
}

/**
 * Counts instead of lines, for traffic that is uninformative individually and
 * ruinous in bulk.
 *
 * `time.ping` tells you nothing; "42,180 time.ping in the last minute" tells you
 * the room is alive and costs one line.
 */
export class RateSummary {
  private counts = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor (private readonly log: Logger, private readonly everyMs = 60_000) {}

  count (what: string, n = 1): void {
    this.counts.set(what, (this.counts.get(what) ?? 0) + n)
  }

  start (): void {
    if (this.timer) return
    this.timer = setInterval(() => this.flush(), this.everyMs)
    // Never hold a process open just to report counts.
    this.timer.unref?.()
  }

  flush (): void {
    if (this.counts.size === 0) return
    this.log.info('traffic', Object.fromEntries(this.counts))
    this.counts.clear()
  }

  stop (): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.flush()
  }
}

export { FileSink, ConsoleSink, dayStamp } from './file-sink.js'
export { setupLogging, levelFromEnv, type Logging, type SetupOptions } from './node.js'
