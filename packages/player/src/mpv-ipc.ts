import { spawn, type ChildProcess } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

export interface MpvEvent { event: string; [k: string]: unknown }

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void }

/**
 * Newline-delimited JSON over a Unix domain socket, or a named pipe on Windows.
 * net.connect handles both, so the only platform difference is the path shape.
 *
 * Written by hand rather than pulled from npm: it is ~150 lines, it is the most
 * latency-critical path in the application, and every millisecond of overhead
 * here comes straight out of the 100 ms sync budget.
 */
export class MpvIpc extends EventEmitter {
  private proc: ChildProcess | null = null
  private sock: Socket | null = null
  private buf = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  private readonly ipcPath: string
  private closed = false

  constructor (private readonly args: string[], private readonly binary = 'mpv') {
    super()
    const id = randomBytes(6).toString('hex')
    this.ipcPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\cocine-mpv-${id}`
      : join(tmpdir(), `cocine-mpv-${id}.sock`)
  }

  async start (timeoutMs = 10_000): Promise<void> {
    this.proc = spawn(this.binary, [`--input-ipc-server=${this.ipcPath}`, ...this.args], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    this.proc.stderr?.on('data', d => { stderr += String(d) })
    this.proc.on('exit', code => {
      if (!this.closed) this.emit('exit', code, stderr)
    })

    // mpv creates the socket a moment after launch; retry until it answers.
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        this.sock = await this.tryConnect()
        break
      } catch (err) {
        if (this.proc.exitCode !== null) {
          throw new Error(`mpv exited (${this.proc.exitCode}) before accepting IPC: ${stderr.trim()}`)
        }
        if (Date.now() > deadline) throw new Error(`mpv IPC socket never appeared: ${String(err)}`)
        await new Promise(r => setTimeout(r, 25))
      }
    }

    this.sock.setNoDelay(true)
    this.sock.on('data', chunk => this.onData(String(chunk)))
    this.sock.on('error', err => { if (!this.closed) this.emit('error', err) })
  }

  private tryConnect (): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = connect(this.ipcPath)
      s.once('connect', () => { s.removeAllListeners('error'); resolve(s) })
      s.once('error', err => { s.destroy(); reject(err) })
    })
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
        if (p) {
          this.pending.delete(msg.request_id)
          if (msg.error === 'success') p.resolve(msg.data)
          else p.reject(new Error(String(msg.error)))
        }
        continue
      }
      if (typeof msg.event === 'string') this.emit('mpv-event', msg as unknown as MpvEvent)
    }
  }

  command (...parts: unknown[]): Promise<unknown> {
    if (!this.sock || this.closed) return Promise.reject(new Error('mpv IPC not connected'))
    const request_id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(request_id, { resolve, reject })
      this.sock!.write(`${JSON.stringify({ command: parts, request_id })}\n`, err => {
        if (err) { this.pending.delete(request_id); reject(err) }
      })
    })
  }

  setProperty (name: string, value: unknown): Promise<unknown> {
    return this.command('set_property', name, value)
  }

  getProperty (name: string): Promise<unknown> {
    return this.command('get_property', name)
  }

  observeProperty (id: number, name: string): Promise<unknown> {
    return this.command('observe_property', id, name)
  }

  /** Immediate, synchronous teardown for process exit. */
  kill (): void {
    this.closed = true
    try { this.sock?.destroy() } catch { /* already gone */ }
    try { this.proc?.kill('SIGKILL') } catch { /* already gone */ }
  }

  async close (): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) p.reject(new Error('mpv IPC closing'))
    this.pending.clear()
    try { await this.command('quit') } catch { /* already going */ }
    this.sock?.destroy()
    await new Promise<void>(res => {
      if (!this.proc || this.proc.exitCode !== null) return res()
      const t = setTimeout(() => { this.proc?.kill('SIGKILL'); res() }, 2000)
      this.proc.once('exit', () => { clearTimeout(t); res() })
    })
    if (process.platform !== 'win32') { try { rmSync(this.ipcPath, { force: true }) } catch { /* gone */ } }
  }
}
