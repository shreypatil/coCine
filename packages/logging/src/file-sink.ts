/**
 * Log files on disk, one directory per channel and one file per day.
 *
 *   <root>/voice/2026-09-12.log
 *   <root>/room/2026-09-12.log
 *   <root>/transfer/2026-09-12.log
 *
 * Split by channel because the question is almost always "what was voice doing",
 * and by day because that is the unit anybody reasons in and it makes deletion
 * a matter of reading a filename rather than a file's contents.
 *
 * Node only: the renderer sends its records over IPC rather than writing.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Level, Sink } from './index.js'

/** `2026-09-12`, in the local day the reader lives in rather than UTC. */
export function dayStamp (d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** A channel becomes a directory, so it must not be able to escape the root. */
function safeChannel (channel: string): string {
  const clean = channel.replace(/[^A-Za-z0-9._-]/g, '_')
  return clean === '' || clean === '.' || clean === '..' ? 'other' : clean
}

export interface FileSinkOptions {
  root: string
  /** Files older than this are deleted by `prune`. */
  keepDays?: number
  now?: () => Date
}

export class FileSink implements Sink {
  private readonly root: string
  private readonly keepDays: number
  private readonly now: () => Date
  private readonly known = new Set<string>()
  /** Reported once and then suppressed: a full disk should not also produce a
   *  million lines on stderr about being unable to log. */
  private complained = false

  constructor (o: FileSinkOptions) {
    this.root = o.root
    this.keepDays = o.keepDays ?? 7
    this.now = o.now ?? (() => new Date())
  }

  write (line: string, channel: string, _level: Level): void {
    const dir = join(this.root, safeChannel(channel))
    try {
      if (!this.known.has(dir)) { mkdirSync(dir, { recursive: true }); this.known.add(dir) }
      // Synchronous on purpose. The alternative loses whatever was buffered at
      // exactly the moment that matters most -- a crash -- and at these volumes
      // the cost is irrelevant.
      appendFileSync(join(dir, `${dayStamp(this.now())}.log`), line + '\n')
    } catch (e) {
      if (this.complained) return
      this.complained = true
      console.error(`[logging] cannot write to ${dir}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * Delete whole days older than the retention window.
   *
   * By filename rather than mtime: a file still being appended to today has a
   * current mtime whatever day it belongs to, and an old file touched by a
   * backup would otherwise be spared. The name is the fact.
   */
  prune (nowMs = this.now().getTime()): { removed: string[]; freedBytes: number } {
    const cutoff = nowMs - this.keepDays * 86_400_000
    const removed: string[] = []
    let freedBytes = 0
    let channels: string[]
    try { channels = readdirSync(this.root) } catch { return { removed, freedBytes } }

    for (const channel of channels) {
      const dir = join(this.root, channel)
      let files: string[]
      try {
        if (!statSync(dir).isDirectory()) continue
        files = readdirSync(dir)
      } catch { continue }

      for (const file of files) {
        const m = /^(\d{4})-(\d{2})-(\d{2})\.log$/.exec(file)
        if (!m) continue
        const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
        if (at >= cutoff) continue
        const full = join(dir, file)
        try {
          freedBytes += statSync(full).size
          rmSync(full, { force: true })
          removed.push(join(channel, file))
        } catch { /* someone else's problem now */ }
      }
    }
    return { removed, freedBytes }
  }
}

/** Everything also goes to the console, which is what journald captures. */
export class ConsoleSink implements Sink {
  write (line: string, _channel: string, level: Level): void {
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
}
