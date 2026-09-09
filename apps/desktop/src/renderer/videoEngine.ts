/**
 * The renderer half of the `<video>` player.
 *
 * Owns nothing but the element it is handed: the main process holds the sync
 * engine and the RoomClient, and drives this through `PlayerController` exactly
 * as it drives mpv. Commands arrive over IPC and are answered; position is
 * pushed back continuously so `position()` in the main process can stay
 * synchronous.
 *
 * Two details carry the accuracy this whole approach was gated on.
 *
 * **Every reading is stamped here, beside the reading.** Stamping on arrival in
 * the main process was measured during the B1.0 gate to cost 18 ms of p99 room
 * drift -- the value describes a moment that has already passed by the time it
 * crosses a process boundary, and the sync engine extrapolates from exactly
 * that pair.
 *
 * **`requestVideoFrameCallback` is preferred over a timer.** It fires when a
 * frame is actually presented and reports that frame's own media time, which is
 * both more accurate and more honest than sampling `currentTime` on an
 * interval: the gate measured a residual per-client deviation of about 35 ms,
 * close to one frame, which is exactly what frame-quantised sampling looks
 * like. A timer remains as the fallback for paused playback and for browsers
 * without the callback, because a paused film presents no frames and still has
 * to report where it is.
 */

/** Falls back to this when no frame has been presented recently. */
const TIMER_HZ = 30

interface FrameMetadata { mediaTime: number; presentationTime: number }
type FrameCallback = (now: number, metadata: FrameMetadata) => void

export interface PlayerCommand { id: number; cmd: string; arg?: unknown }

/** Wall-clock milliseconds on the same scale as the main process's Date.now(). */
const wallClockNow = (): number => performance.timeOrigin + performance.now()

export interface VideoEngine { stop: () => void }

/**
 * Wire an element to the main process. Returns a teardown so a React effect can
 * undo it; nothing here survives the element it was given.
 */
export function attachVideoEngine (video: HTMLVideoElement): VideoEngine {
  // requestVideoFrameCallback is declared by the DOM library but is not
  // universal, so it is still called defensively at runtime.
  const el = video
  const api = window.cocine
  const hasFrameCallback = typeof el.requestVideoFrameCallback === 'function'
  let stopped = false
  let frameHandle: number | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  const snapshot = (at: number, mediaTime?: number): void => {
    const q = el.getVideoPlaybackQuality?.()
    api.sendPlayerState?.({
      // The frame's own media time when we have it, which is what was actually
      // on screen at `at`, rather than what currentTime happens to read now.
      pos: typeof mediaTime === 'number' ? mediaTime : el.currentTime,
      at,
      paused: el.paused,
      duration: Number.isFinite(el.duration) ? el.duration : null,
      buffered: el.buffered.length ? el.buffered.end(el.buffered.length - 1) : 0,
      readyState: el.readyState,
      quality: q ? { total: q.totalVideoFrames, dropped: q.droppedVideoFrames } : null
    })
  }

  const onFrame = (_now: number, metadata: FrameMetadata): void => {
    if (stopped) return
    // presentationTime is on the same timeline as performance.now(), so this
    // converts to the wall clock the main process compares against.
    const at = performance.timeOrigin + metadata.presentationTime
    snapshot(Math.min(at, wallClockNow()), metadata.mediaTime)
    frameHandle = hasFrameCallback ? el.requestVideoFrameCallback(onFrame) : null
  }

  if (hasFrameCallback) frameHandle = el.requestVideoFrameCallback(onFrame)
  // Always running: a paused film presents no frames and must still report
  // where it is, and this is the only path when the callback is unavailable.
  timer = setInterval(() => { if (!stopped) snapshot(wallClockNow()) }, Math.round(1000 / TIMER_HZ))

  const notify = (kind: string, message?: string): void => {
    api.sendPlayerEvent?.({ kind, message })
  }
  const onEnded = (): void => notify('eof')
  const onPause = (): void => { snapshot(wallClockNow()); notify('pause') }
  const onPlay = (): void => { snapshot(wallClockNow()); notify('pause') }
  const onError = (): void => notify('error', el.error?.message ?? `code ${el.error?.code ?? '?'}`)
  el.addEventListener('ended', onEnded)
  el.addEventListener('pause', onPause)
  el.addEventListener('play', onPlay)
  el.addEventListener('error', onError)

  const load = (src: string): Promise<{ duration?: number; error?: string }> =>
    new Promise(resolve => {
      const done = (r: { duration?: number; error?: string }): void => {
        clearTimeout(t)
        el.removeEventListener('loadedmetadata', ok)
        el.removeEventListener('error', bad)
        resolve(r)
      }
      const ok = (): void => done({ duration: Number.isFinite(el.duration) ? el.duration : undefined })
      const bad = (): void => done({ error: el.error?.message ?? 'could not load' })
      // Bounded, so a film that never loads reports rather than hanging the
      // room. A stream that is merely slow keeps its metadata promise open,
      // which is why this is generous.
      const t = setTimeout(() => done({ error: 'timed out waiting for metadata' }), 120_000)
      el.addEventListener('loadedmetadata', ok)
      el.addEventListener('error', bad)
      el.src = src
      el.load()
    })

  const seek = (seconds: number): Promise<{ position?: number; error?: string }> =>
    new Promise(resolve => {
      const done = (r: { position?: number; error?: string }): void => {
        clearTimeout(t)
        el.removeEventListener('seeked', ok)
        resolve(r)
      }
      const ok = (): void => done({ position: el.currentTime })
      const t = setTimeout(() => done({ error: 'seek timed out' }), 30_000)
      el.addEventListener('seeked', ok)
      try { el.currentTime = seconds } catch (e) { done({ error: String(e) }) }
    })

  const run = async (cmd: string, arg: unknown): Promise<unknown> => {
    switch (cmd) {
      case 'load': {
        const path = String(arg)
        // The stream server hands over an http URL; a local film is a path.
        return load(/^[a-z]+:\/\//i.test(path) ? path : `file://${path}`)
      }
      case 'play':
        try { await el.play(); return { ok: true } } catch (e) {
          return { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
        }
      case 'pause': el.pause(); return { ok: true }
      case 'seek': return seek(Number(arg))
      case 'rate': el.playbackRate = Number(arg); return { ok: true }
      case 'volume': {
        const pct = Math.max(0, Math.min(100, Number(arg)))
        el.volume = pct / 100
        el.muted = pct === 0
        return { ok: true }
      }
      case 'showText': {
        // Drawn by the interface rather than by the player; this is one of the
        // things a DOM above the video makes trivial.
        const { text, durationMs } = (arg ?? {}) as { text?: string; durationMs?: number }
        window.dispatchEvent(new CustomEvent('cocine:osd', { detail: { text, durationMs } }))
        return { ok: true }
      }
      case 'unload':
        el.removeAttribute('src')
        el.load()
        return { ok: true }
      default:
        return { error: `unknown command ${cmd}` }
    }
  }

  const offCommand = api.onPlayerCommand?.((c: PlayerCommand) => {
    void run(c.cmd, c.arg)
      .then(data => api.sendPlayerReply?.({ id: c.id, data }))
      .catch((e: unknown) => api.sendPlayerReply?.({
        id: c.id, error: e instanceof Error ? e.message : String(e)
      }))
  })

  return {
    stop () {
      stopped = true
      if (frameHandle !== null && hasFrameCallback) el.cancelVideoFrameCallback(frameHandle)
      if (timer) clearInterval(timer)
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('error', onError)
      offCommand?.()
    }
  }
}
