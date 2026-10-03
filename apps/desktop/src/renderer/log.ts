/**
 * Logging from the renderer.
 *
 * The renderer cannot write files, so records are shipped to main over IPC and
 * land in the same per-channel, per-day directories as everything else. They
 * also go to the devtools console, because that is where you are already
 * looking when something misbehaves on screen.
 *
 * Deliberately tolerant of the bridge being absent: the renderer is also run
 * under Playwright with a stubbed preload, and a missing `window.cocine` must
 * not turn a layout test into a crash.
 */
export type Level = 'error' | 'warn' | 'info' | 'debug' | 'trace'

export interface RendererLogger {
  error: (msg: string, data?: unknown) => void
  warn: (msg: string, data?: unknown) => void
  info: (msg: string, data?: unknown) => void
  debug: (msg: string, data?: unknown) => void
  trace: (msg: string, data?: unknown) => void
}

/**
 * A log record's data as plain values, fit to cross IPC.
 *
 * Errors are the reason this exists. A DOMException -- what WebRTC and
 * getUserMedia throw -- keeps its name and message as prototype getters, so by
 * the time a record reached main and was written as JSON it read
 * `"error":{}`, and a failure was logged with every detail of it gone. Errors
 * at any depth become their name, message and the top of the stack; anything
 * else that cannot be copied becomes a description rather than costing the
 * whole line.
 */
export function plainLogData (value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
    if (typeof value === 'bigint') return `${value.toString()}n`
    return value
  }
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  const e = value as { name?: unknown; message?: unknown; stack?: unknown }
  if (value instanceof Error || (typeof DOMException !== 'undefined' && value instanceof DOMException)) {
    return {
      name: String(e.name),
      message: String(e.message),
      ...(typeof e.stack === 'string' ? { stack: e.stack.split('\n').slice(0, 4).join(' | ') } : {})
    }
  }
  if (depth >= 6) return '[…]'
  if (Array.isArray(value)) return value.map(v => plainLogData(v, depth + 1, seen))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = plainLogData(v, depth + 1, seen)
  return out
}

export function logger (channel: string): RendererLogger {
  const at = (level: Level) => (msg: string, data?: unknown): void => {
    try {
      const w = window as unknown as { cocine?: { log?: (c: string, l: string, m: string, d?: unknown) => void } }
      w.cocine?.log?.(channel, level, msg, data === undefined ? undefined : plainLogData(data))
    } catch { /* the bridge is optional; never fail a render over a log line */ }
    if (level === 'error') console.error(`[${channel}] ${msg}`, data ?? '')
    else if (level === 'warn') console.warn(`[${channel}] ${msg}`, data ?? '')
    else if (level !== 'trace') console.log(`[${channel}] ${msg}`, data ?? '')
  }
  return { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug'), trace: at('trace') }
}
