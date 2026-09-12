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

export function logger (channel: string): RendererLogger {
  const at = (level: Level) => (msg: string, data?: unknown): void => {
    try {
      const w = window as unknown as { cocine?: { log?: (c: string, l: string, m: string, d?: unknown) => void } }
      w.cocine?.log?.(channel, level, msg, data)
    } catch { /* the bridge is optional; never fail a render over a log line */ }
    if (level === 'error') console.error(`[${channel}] ${msg}`, data ?? '')
    else if (level === 'warn') console.warn(`[${channel}] ${msg}`, data ?? '')
    else if (level !== 'trace') console.log(`[${channel}] ${msg}`, data ?? '')
  }
  return { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug'), trace: at('trace') }
}
