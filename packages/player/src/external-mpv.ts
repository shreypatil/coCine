import { EventEmitter } from 'node:events'
import { MpvIpc, type MpvEvent } from './mpv-ipc.js'
import type { PlayerController, PlayerOptions } from './types.js'

const OBS_TIME = 1
const OBS_PAUSE = 2
const OBS_DURATION = 3

/**
 * Drives an mpv process over JSON IPC. This is architecture D from the design
 * notes: the player is a separate process, so there is no window embedding, no
 * graphics code, and nothing platform-specific beyond the socket path.
 *
 * It ships for two reasons. It is the phase 0/1 implementation, and it stays
 * forever as the headless rig the drift tests run against -- you cannot point
 * five embedded players at one machine, but you can point five of these.
 */
export class ExternalMpv implements PlayerController {
  private ipc: MpvIpc
  private events = new EventEmitter()
  private pos = 0
  private posAt = 0
  private paused = true
  private dur: number | null = null

  constructor (opts: PlayerOptions = {}) {
    const args = [
      '--idle=yes',
      '--no-terminal',
      '--keep-open=yes',
      '--pause=yes',
      // Exact seeking is not optional at a 100 ms budget. Without this mpv may
      // seek to the nearest keyframe, which on a typical film is seconds away.
      '--hr-seek=yes',
      '--msg-level=all=no',
      // We draw the interface. mpv must not paint controls over its own window
      // or swallow keystrokes meant for the application.
      '--osc=no',
      '--osd-level=0',
      '--input-default-bindings=no',
      '--input-vo-keyboard=no'
    ]
    if (!opts.useUserConfig) args.push('--no-config')
    if (opts.wid) {
      // force-window matters: with --idle and nothing loaded mpv would not
      // create a window at all, and there would be nothing to reparent.
      args.push(`--wid=${opts.wid}`, '--force-window=yes')
    } else if (opts.headless) {
      args.push('--vo=null', '--ao=null')
    }
    if (opts.extraArgs) args.push(...opts.extraArgs)
    this.ipc = new MpvIpc(args, opts.binary ?? 'mpv')
    // Seeks in flight each hold a short-lived listener, and the default cap of
    // ten trips a spurious leak warning during rapid seeking.
    this.ipc.setMaxListeners(64)
    this.ipc.on('mpv-event', (e: MpvEvent) => this.onEvent(e))
    this.ipc.on('exit', (code, stderr) => this.events.emit('exit', code, stderr))
  }

  async start (): Promise<void> {
    await this.ipc.start()
    await this.ipc.observeProperty(OBS_TIME, 'time-pos')
    await this.ipc.observeProperty(OBS_PAUSE, 'pause')
    await this.ipc.observeProperty(OBS_DURATION, 'duration')
  }

  private onEvent (e: MpvEvent): void {
    if (e.event === 'property-change') {
      if (e.id === OBS_TIME && typeof e.data === 'number') {
        this.pos = e.data
        this.posAt = Date.now()
        this.events.emit('position', this.pos, this.posAt)
      } else if (e.id === OBS_PAUSE && typeof e.data === 'boolean') {
        this.paused = e.data
        this.events.emit('pause', this.paused)
      } else if (e.id === OBS_DURATION && typeof e.data === 'number') {
        this.dur = e.data
      }
    } else if (e.event === 'eof-reached' || e.event === 'end-file') {
      this.events.emit('eof')
    }
  }

  async load (path: string): Promise<void> {
    const loaded = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`mpv never loaded ${path}`)), 30_000)
      const onEvent = (e: MpvEvent): void => {
        if (e.event === 'file-loaded') { cleanup(); resolve() }
        if (e.event === 'end-file' && e.reason === 'error') { cleanup(); reject(new Error(`mpv failed to load ${path}`)) }
      }
      const cleanup = (): void => { clearTimeout(t); this.ipc.off('mpv-event', onEvent) }
      this.ipc.on('mpv-event', onEvent)
    })
    try {
      await this.ipc.command('loadfile', path, 'replace')
    } catch (err) {
      // Same trap as seek: if the command fails, nothing will ever resolve the
      // promise above, and an unhandled rejection from its timer kills the
      // process rather than surfacing a load error.
      loaded.catch(() => {})
      throw err
    }
    await loaded
    await this.ipc.setProperty('pause', true)
  }

  async play (): Promise<void> { await this.ipc.setProperty('pause', false) }
  async pause (): Promise<void> { await this.ipc.setProperty('pause', true) }
  /**
   * mpv acknowledges a seek command immediately but performs it asynchronously,
   * so time-pos stays stale for a moment afterwards. Waiting for
   * playback-restart is what makes a seek observable -- without it the sync
   * engine reads the pre-seek position and corrects against a phantom drift.
   */
  async seek (seconds: number): Promise<void> {
    // Arm the listener before issuing the command, or a fast seek can complete
    // before anyone is watching for it.
    const landed = this.waitFor('playback-restart', 3000)
    try {
      await this.ipc.command('seek', seconds, 'absolute', 'exact')
    } catch (err) {
      // The command itself failed, so nothing will ever restart playback.
      // Without this the promise above is never awaited and Node kills the
      // process with an unhandled rejection from a timer.
      void landed
      throw err
    }
    if (!await landed) this.events.emit('warning', `seek to ${seconds.toFixed(2)}s: no playback-restart`)
  }

  /**
   * Resolves true if the event arrived, false if it timed out. Deliberately
   * never rejects: a missed event means the sync engine corrects on its next
   * tick, whereas a throw from a player primitive takes the whole client down.
   */
  private waitFor (eventName: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const done = (ok: boolean): void => { clearTimeout(t); this.ipc.off('mpv-event', onEvent); resolve(ok) }
      const t = setTimeout(() => done(false), timeoutMs)
      const onEvent = (e: MpvEvent): void => { if (e.event === eventName) done(true) }
      this.ipc.on('mpv-event', onEvent)
    })
  }
  async setRate (rate: number): Promise<void> { await this.ipc.setProperty('speed', rate) }

  /** 0 to 100. Used to duck the film while someone is speaking. */
  async setVolume (percent: number): Promise<void> {
    await this.ipc.setProperty('volume', Math.max(0, Math.min(130, percent)))
  }

  position (): number { return this.pos }
  positionObservedAt (): number { return this.posAt }
  isPaused (): boolean { return this.paused }
  duration (): number | null { return this.dur }

  /** Authoritative position, at the cost of a round trip. Use sparingly --
   *  the observed value is what the tick loop should read. */
  async positionExact (): Promise<number> {
    const v = await this.ipc.getProperty('time-pos')
    return typeof v === 'number' ? v : this.pos
  }

  on (event: 'position', fn: (seconds: number, atMs: number) => void): void
  on (event: 'pause', fn: (paused: boolean) => void): void
  on (event: 'eof', fn: () => void): void
  on (event: 'exit', fn: (code: number | null, stderr: string) => void): void
  on (event: 'warning', fn: (message: string) => void): void
  on (event: string, fn: (...a: never[]) => void): void {
    this.events.on(event, fn as (...a: unknown[]) => void)
  }

  async close (): Promise<void> { await this.ipc.close() }

  /**
   * Transient text drawn by mpv over the video. This is the one thing that can
   * appear above the picture without an overlay window, so it carries feedback
   * in fullscreen where no controls are visible.
   */
  async showText (text: string, durationMs = 2000): Promise<void> {
    await this.ipc.command('show-text', text, durationMs)
  }

  /** Kill mpv immediately, without waiting on IPC. For process teardown. */
  kill (): void { this.ipc.kill() }
}
