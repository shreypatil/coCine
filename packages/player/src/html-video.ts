import { spawn, type ChildProcess } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import type { PlayerController } from './types.js'

/**
 * A `<video>` element behind the `PlayerController` interface.
 *
 * The B1.0 spike. The question it exists to answer is whether Chromium's media
 * element can hold coCine's 100 ms synchronisation budget, and the only
 * credible way to answer that is to put it behind the same interface mpv sits
 * behind and run the same harnesses at it. `PlayerController` was written so
 * "the sync engine must not be able to tell them apart"; this is the third
 * implementation, and nothing in `packages/sync` changes.
 *
 * The shape is copied from ExternalMpv on purpose. A hidden Electron process
 * hosts the video elements and pushes position over a socket; this class caches
 * the last reading so `position()` can answer synchronously, because the sync
 * engine runs on a tick and cannot await a round trip. That constraint is the
 * whole reason this is not simply an `executeJavaScript` wrapper.
 *
 * Several players share one host process, addressed by id. Five Electron
 * processes would cost about a gigabyte to prove nothing extra.
 *
 * **Nothing is ever displayed.** The host's window is created with
 * `show: false`, so a drift run never puts a window on the machine's desktop.
 */

/** One Electron host, shared by every player in a process. */
class VideoHost {
  private static shared: VideoHost | null = null
  private proc: ChildProcess | null = null
  private sock: Socket | null = null
  private buf = ''
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private readonly listeners = new Map<string, (msg: Record<string, unknown>) => void>()
  private readonly socketPath: string
  private closed = false

  private constructor () {
    const id = randomBytes(6).toString('hex')
    this.socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\cocine-video-${id}`
      : join(tmpdir(), `cocine-video-${id}.sock`)
  }

  static async get (): Promise<VideoHost> {
    if (!VideoHost.shared) {
      VideoHost.shared = new VideoHost()
      await VideoHost.shared.start()
    }
    return VideoHost.shared
  }

  /** Electron's binary, resolved lazily so this module stays importable in a
   *  plain Node test run that never touches it. */
  private electronBinary (): string {
    const require = createRequire(import.meta.url)
    return require('electron') as unknown as string
  }

  private hostScript (): string {
    return join(dirname(fileURLToPath(import.meta.url)), 'html-video-host.cjs')
  }

  private async start (): Promise<void> {
    this.proc = spawn(this.electronBinary(), [this.hostScript(), `--socket=${this.socketPath}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    })
    let stderr = ''
    this.proc.stderr?.on('data', d => { stderr += String(d) })

    // Wait for the host to say its socket is up, rather than retrying blindly.
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`the video host never became ready: ${stderr.slice(-400)}`)),
        60_000
      )
      this.proc!.stdout?.on('data', d => {
        if (String(d).includes('READY')) { clearTimeout(deadline); resolve() }
      })
      this.proc!.on('exit', code => {
        clearTimeout(deadline)
        reject(new Error(`the video host exited (${code}) before it was ready: ${stderr.slice(-400)}`))
      })
    })

    this.sock = await new Promise<Socket>((resolve, reject) => {
      const s = connect(this.socketPath)
      s.once('connect', () => { s.removeAllListeners('error'); resolve(s) })
      s.once('error', reject)
    })
    this.sock.setNoDelay(true)
    this.sock.on('data', chunk => this.onData(String(chunk)))
    this.sock.on('error', () => { /* teardown */ })
  }

  private onData (chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg: Record<string, unknown>
      try { msg = JSON.parse(line) } catch { continue }

      if (typeof msg.request_id === 'number') {
        const p = this.pending.get(msg.request_id)
        if (!p) continue
        this.pending.delete(msg.request_id)
        if (msg.error) p.reject(new Error(String(msg.error)))
        else p.resolve(msg.data)
        continue
      }
      // An unsolicited event, routed to whichever player it names.
      const player = typeof msg.player === 'string' ? msg.player : null
      if (player) this.listeners.get(player)?.(msg)
    }
  }

  on (player: string, fn: (msg: Record<string, unknown>) => void): void {
    this.listeners.set(player, fn)
  }

  off (player: string): void { this.listeners.delete(player) }

  send (cmd: string, player: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.sock || this.closed) return Promise.reject(new Error('the video host is not connected'))
    const request_id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(request_id, { resolve, reject })
      this.sock!.write(`${JSON.stringify({ request_id, cmd, player, ...extra })}\n`, err => {
        if (err) { this.pending.delete(request_id); reject(err) }
      })
    })
  }

  /** Shut the host down. Static, because the host is shared. */
  static async shutdown (): Promise<void> {
    const h = VideoHost.shared
    if (!h || h.closed) return
    h.closed = true
    VideoHost.shared = null
    for (const p of h.pending.values()) p.reject(new Error('the video host is closing'))
    h.pending.clear()
    try { await h.send('quit', '') } catch { /* already going */ }
    try { h.sock?.destroy() } catch { /* gone */ }
    await new Promise<void>(res => {
      if (!h.proc || h.proc.exitCode !== null) return res()
      // Bounded: a host that will not exit is killed rather than waited on for
      // ever, so a failed run cannot leave an Electron process behind.
      const t = setTimeout(() => { try { h.proc?.kill('SIGKILL') } catch { /* gone */ } res() }, 3000)
      h.proc.once('exit', () => { clearTimeout(t); res() })
    })
    if (process.platform !== 'win32') { try { rmSync(h.socketPath, { force: true }) } catch { /* gone */ } }
  }
}

export interface HtmlVideoOptions {
  /** Leave the audio on. Off by default: a five-peer drift run would otherwise
   *  play five copies of the film out loud. */
  audible?: boolean
}

export class HtmlVideoPlayer implements PlayerController {
  private host: VideoHost | null = null
  private readonly id = `p${randomBytes(4).toString('hex')}`
  private events = new EventEmitter()

  // The cache the sync engine reads. Exactly the shape ExternalMpv keeps.
  private pos = 0
  private posAt = 0
  private paused = true
  private dur: number | null = null
  /** Decode statistics, for the 4K gate rather than for the sync engine. */
  private quality: { total: number; dropped: number } | null = null
  private bufferedTo = 0
  private readyState = 0
  private lastError: string | null = null

  constructor (private readonly o: HtmlVideoOptions = {}) {}

  async start (): Promise<void> {
    this.host = await VideoHost.get()
    this.host.on(this.id, msg => this.onEvent(msg))
    await this.host.send('create', this.id, { opts: { muted: !this.o.audible } })
  }

  private onEvent (msg: Record<string, unknown>): void {
    switch (msg.event) {
      case 'position': {
        if (typeof msg.pos === 'number') {
          this.pos = msg.pos
          this.posAt = typeof msg.at === 'number' ? msg.at : Date.now()
          this.events.emit('position', this.pos, this.posAt)
        }
        if (typeof msg.paused === 'boolean') this.paused = msg.paused
        this.dur = typeof msg.duration === 'number' ? msg.duration : null
        this.quality = (msg.quality as { total: number; dropped: number } | null) ?? this.quality
        if (typeof msg.buffered === 'number') this.bufferedTo = msg.buffered
        if (typeof msg.readyState === 'number') this.readyState = msg.readyState
        break
      }
      case 'pause':
        if (typeof msg.paused === 'boolean') {
          this.paused = msg.paused
          this.events.emit('pause', this.paused)
        }
        break
      case 'eof':
        this.events.emit('eof')
        break
      case 'mediaerror':
        this.lastError = String(msg.message ?? 'unknown')
        this.events.emit('warning', this.lastError)
        break
    }
  }

  private cmd (cmd: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.host) return Promise.reject(new Error('player not started'))
    return this.host.send(cmd, this.id, extra)
  }

  /** A local path or an http(s) URL. The stream server serves the latter. */
  async load (path: string): Promise<void> {
    // A local path or an http(s) URL; the host serves the former over its own
    // origin, because a page cannot load file:// media from another origin.
    const r = await this.cmd('load', { src: path }) as { duration?: number; error?: string }
    if (r?.error) throw new Error(`could not load ${path}: ${r.error}`)
    this.dur = typeof r?.duration === 'number' ? r.duration : null
    this.paused = true
    this.pos = 0
    this.posAt = Date.now()
  }

  async play (): Promise<void> {
    const r = await this.cmd('play') as { error?: string }
    if (r?.error) throw new Error(`could not play: ${r.error}`)
  }

  async pause (): Promise<void> { await this.cmd('pause') }

  async seek (seconds: number): Promise<void> {
    const r = await this.cmd('seek', { arg: seconds }) as { position?: number; error?: string }
    if (r?.error) throw new Error(`could not seek: ${r.error}`)
    if (typeof r?.position === 'number') { this.pos = r.position; this.posAt = Date.now() }
  }

  async setRate (rate: number): Promise<void> { await this.cmd('rate', { arg: rate }) }

  async setVolume (percent: number): Promise<void> {
    await this.cmd('volume', { arg: Math.max(0, Math.min(100, percent)) / 100 })
  }

  position (): number { return this.pos }
  positionObservedAt (): number { return this.posAt }
  isPaused (): boolean { return this.paused }
  duration (): number | null { return this.dur }

  /** Authoritative position, at the cost of a round trip. Matches ExternalMpv,
   *  which the phase 0 harness uses to measure command latency. */
  async positionExact (): Promise<number> {
    const snap = await this.cmd('snapshot') as Array<{ player: string; pos: number }>
    const mine = Array.isArray(snap) ? snap.find(s => s.player === this.id) : null
    return typeof mine?.pos === 'number' ? mine.pos : this.pos
  }

  /** Decode statistics, for the 4K gate. Null before anything has played. */
  playbackQuality (): { total: number; dropped: number } | null { return this.quality }
  /** How far the media element has buffered, for the stalling gate. */
  buffered (): number { return this.bufferedTo }
  readyStateValue (): number { return this.readyState }
  mediaError (): string | null { return this.lastError }

  /** mpv draws this itself; a real implementation will draw it in the DOM.
   *  The spike has no surface to draw on, so it is deliberately a no-op. */
  async showText (): Promise<void> { /* B1.2 draws this in the DOM */ }

  async unload (): Promise<void> {
    await this.cmd('unload')
    this.pos = 0
    this.posAt = Date.now()
    this.paused = true
    this.dur = null
  }

  on (event: 'position', fn: (seconds: number, atMs: number) => void): void
  on (event: 'pause', fn: (paused: boolean) => void): void
  on (event: 'eof', fn: () => void): void
  on (event: 'warning', fn: (message: string) => void): void
  on (event: string, fn: (...a: never[]) => void): void {
    this.events.on(event, fn as (...a: unknown[]) => void)
  }

  async close (): Promise<void> {
    this.host?.off(this.id)
    try { await this.cmd('unload') } catch { /* host already gone */ }
    this.host = null
  }
}

/** Stop the shared Electron host. Every run must call this, or it outlives the
 *  process that started it. */
export const shutdownVideoHost = (): Promise<void> => VideoHost.shutdown()
