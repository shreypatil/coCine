/**
 * Standing up logging in a Node process: the server and the desktop's main
 * process both want the same thing, and neither should have to assemble it.
 */
import { LogHub, type Level, LEVELS, type Logger } from './index.js'
import { FileSink, ConsoleSink } from './file-sink.js'

export interface SetupOptions {
  /** Where the per-channel directories live. */
  dir: string
  /** Overridden by COCINE_LOG_LEVEL when that is set to something valid. */
  level?: Level
  keepDays?: number
  /** Also write to stdout/stderr, which is what journald captures. */
  console?: boolean
}

export interface Logging {
  hub: LogHub
  logger: (channel: string) => Logger
  files: FileSink
  /** Delete days past the retention window. Run at startup and on a timer. */
  prune: () => { removed: string[]; freedBytes: number }
  close: () => void
}

/** A level from the environment, ignoring anything that is not one. */
export function levelFromEnv (raw: string | undefined, fallback: Level = 'info'): Level {
  const v = (raw ?? '').trim().toLowerCase()
  return (LEVELS as readonly string[]).includes(v) ? v as Level : fallback
}

export function setupLogging (o: SetupOptions): Logging {
  const files = new FileSink({ root: o.dir, keepDays: o.keepDays ?? 7 })
  const hub = new LogHub({
    level: levelFromEnv(process.env.COCINE_LOG_LEVEL, o.level ?? 'info'),
    sinks: o.console === false ? [files] : [new ConsoleSink(), files]
  })
  const log = hub.logger('logging')

  const prune = (): { removed: string[]; freedBytes: number } => {
    const r = files.prune()
    if (r.removed.length) {
      log.info('pruned old logs', { days: o.keepDays ?? 7, files: r.removed.length, freedKb: Math.round(r.freedBytes / 1024) })
    }
    return r
  }

  // At startup as well as on a timer: a machine that was off for a fortnight
  // should not keep a fortnight of stale logs until its first timer fires.
  prune()
  log.info('logging started', { dir: o.dir, level: hub.getLevel(), keepDays: o.keepDays ?? 7 })

  return { hub, logger: (c: string) => hub.logger(c), files, prune, close: () => hub.close() }
}
