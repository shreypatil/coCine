import { ipcMain, type BrowserWindow } from 'electron'
import { EventEmitter } from 'node:events'
import type { PlayerController } from '@cocine/player'

/**
 * The `<video>` element in the main window, behind `PlayerController`.
 *
 * Phase B1.1. The sync engine and RoomClient both live in the main process and
 * drive a `PlayerController`; the element they are driving now lives in the
 * renderer, so something has to carry commands across and carry state back.
 *
 * This is the third implementation of that interface and it is shaped like the
 * other two on purpose. `position()` must answer **synchronously** -- the sync
 * engine runs on a tick and cannot await a round trip -- so the renderer pushes
 * its position continuously and this caches the last reading, exactly as
 * ExternalMpv caches what mpv observes. Nothing in `packages/sync` changes, and
 * a room can hold one client on mpv and one on this without either noticing.
 *
 * The renderer stamps each reading with its own clock, beside the reading.
 * Timestamping on arrival here instead was measured to cost 18 ms of p99 room
 * drift during the B1.0 gate: the value describes a moment that has already
 * passed by the time it crosses the process boundary, and the sync engine
 * extrapolates from exactly that pair.
 */

/** How long to wait for the renderer to answer before giving up on a command. */
const COMMAND_TIMEOUT_MS = 30_000

export interface RendererState {
  pos: number
  /** Wall-clock ms, stamped in the renderer beside the reading. */
  at: number
  paused: boolean
  duration: number | null
  buffered: number
  readyState: number
  quality: { total: number; dropped: number } | null
}

export class RendererPlayer implements PlayerController {
  private events = new EventEmitter()
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private closed = false

  // The cache the sync engine reads.
  private pos = 0
  private posAt = 0
  private paused = true
  private dur: number | null = null
  private bufferedTo = 0
  private lastError: string | null = null

  private readonly onState: (e: unknown, s: RendererState) => void
  private readonly onEvent: (e: unknown, msg: { kind: string; message?: string }) => void
  private readonly onReply: (e: unknown, msg: { id: number; data?: unknown; error?: string }) => void

  constructor (private readonly win: BrowserWindow) {
    this.onState = (_e, s) => {
      if (typeof s?.pos !== 'number') return
      this.pos = s.pos
      // Trust the renderer's stamp, but never a clock from the future.
      this.posAt = typeof s.at === 'number' ? Math.min(s.at, Date.now()) : Date.now()
      this.paused = !!s.paused
      this.dur = typeof s.duration === 'number' ? s.duration : null
      this.bufferedTo = typeof s.buffered === 'number' ? s.buffered : 0
      this.events.emit('position', this.pos, this.posAt)
    }
    this.onEvent = (_e, msg) => {
      if (msg?.kind === 'eof') this.events.emit('eof')
      else if (msg?.kind === 'pause') this.events.emit('pause', this.paused)
      else if (msg?.kind === 'error') {
        this.lastError = msg.message ?? 'unknown media error'
        this.events.emit('warning', this.lastError)
      }
    }
    this.onReply = (_e, msg) => {
      const p = this.pending.get(msg?.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error))
      else p.resolve(msg.data)
    }
    ipcMain.on('player:state', this.onState)
    ipcMain.on('player:event', this.onEvent)
    ipcMain.on('player:reply', this.onReply)
  }

  private send (cmd: string, arg?: unknown): Promise<unknown> {
    if (this.closed || this.win.isDestroyed()) {
      return Promise.reject(new Error('the window is gone'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      // Bounded: a renderer that never answers must not leave the sync engine
      // waiting for the life of the process.
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`the player did not answer "${cmd}" within ${COMMAND_TIMEOUT_MS / 1000}s`))
      }, COMMAND_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v) },
        reject: e => { clearTimeout(timer); reject(e) }
      })
      this.win.webContents.send('player:command', { id, cmd, arg })
    })
  }

  /** A local path or an http(s) URL; the renderer resolves a path to a file
   *  URL, and the stream server already supplies the latter. */
  async load (path: string): Promise<void> {
    const r = await this.send('load', path) as { duration?: number; error?: string }
    if (r?.error) throw new Error(`could not load ${path}: ${r.error}`)
    this.dur = typeof r?.duration === 'number' ? r.duration : null
    this.pos = 0
    this.posAt = Date.now()
    this.paused = true
    this.lastError = null
  }

  async play (): Promise<void> {
    const r = await this.send('play') as { error?: string }
    if (r?.error) throw new Error(r.error)
  }

  async pause (): Promise<void> { await this.send('pause') }

  async seek (seconds: number): Promise<void> {
    const r = await this.send('seek', seconds) as { position?: number; error?: string }
    if (r?.error) throw new Error(r.error)
    if (typeof r?.position === 'number') { this.pos = r.position; this.posAt = Date.now() }
  }

  async setRate (rate: number): Promise<void> { await this.send('rate', rate) }
  async setVolume (percent: number): Promise<void> { await this.send('volume', percent) }

  position (): number { return this.pos }
  positionObservedAt (): number { return this.posAt }
  isPaused (): boolean { return this.paused }
  duration (): number | null { return this.dur }
  /** How far the media element has buffered; the transfer panel can say so. */
  buffered (): number { return this.bufferedTo }
  mediaError (): string | null { return this.lastError }

  /**
   * Transient text over the film. mpv draws this itself; here the renderer
   * already has a DOM above the video, which is one of the things this
   * architecture makes easy rather than impossible.
   */
  async showText (text: string, durationMs = 2000): Promise<void> {
    await this.send('showText', { text, durationMs }).catch(() => { /* cosmetic */ })
  }

  async unload (): Promise<void> {
    await this.send('unload').catch(() => { /* the window may be going */ })
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

  /**
   * Synchronous teardown, for process exit where a promise will never settle.
   *
   * There is no child process to signal -- the element dies with the window --
   * so this is only about letting go of the IPC listeners and refusing further
   * commands. Present so every player can be torn down the same way.
   */
  kill (): void {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) p.reject(new Error('the player is closing'))
    this.pending.clear()
    ipcMain.off('player:state', this.onState)
    ipcMain.off('player:event', this.onEvent)
    ipcMain.off('player:reply', this.onReply)
  }

  async close (): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) p.reject(new Error('the player is closing'))
    this.pending.clear()
    ipcMain.off('player:state', this.onState)
    ipcMain.off('player:event', this.onEvent)
    ipcMain.off('player:reply', this.onReply)
  }
}
