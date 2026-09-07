import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'
import { basename } from 'node:path'
import { createHash } from 'node:crypto'
import { open, mkdir, readFile, writeFile, stat, type FileHandle } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import type { MediaSource, OriginSource } from '@cocine/protocol'
import { FilmStore } from './storage.js'
import { add, missing, total, playableSecondsFrom, type Range } from './ranges.js'
import type { MediaTransport, TransferProgress, TransferReport } from './transport.js'

/**
 * Relay mode: the film comes from object storage rather than from other people.
 *
 * This exists for the room the swarm cannot serve -- nobody able to connect
 * directly, or a sharer whose uplink cannot feed even one viewer. The sharer
 * uploads once; everyone else fetches independently, and nobody depends on
 * anybody else being online.
 *
 * It deliberately keeps the behaviour the peer-to-peer path has, because the
 * product promises are the same either way: the film is written to disk and
 * kept, an interrupted transfer resumes, playback starts before the download
 * finishes, and the readiness gate can still tell who is behind. What changes is
 * only where the bytes come from.
 *
 * Signed URLs are never stored. They expire, so one is requested from the server
 * when needed and re-requested when it stops working.
 */

/** Fetched in chunks rather than one long request, so progress is visible and a
 *  dropped connection costs one chunk instead of the whole film. */
const CHUNK_BYTES = 8 * 1024 * 1024
/** How far ahead of the playhead to fetch before backfilling the rest. */
const PREFETCH_SECONDS = 90

export interface OriginTransferOptions {
  store: FilmStore
  /** Asks the server for a signed URL. Called again whenever one expires. */
  getDownloadUrl: () => Promise<string>
  getUploadUrl: (contentId: string, name: string, bytes: number) => Promise<{ url: string; key: string }>
  /** Test affordance, as on the swarm transport: real links are slower than a
   *  loopback and the gate has nothing to gate without this. */
  downloadLimitBps?: number
  chunkBytes?: number
}

interface Held {
  source: OriginSource
  name: string
  path: string
  ranges: Range[]
  handle: FileHandle | null
  playheadSec: number
  durationSec: number
  downBps: number
  lastMeasureMs: number
  lastMeasureBytes: number
  fetching: Promise<void> | null
  stopped: boolean
}

/**
 * The identity a relayed film is filed under on disk.
 *
 * The object key is a path with slashes in it and cannot be a directory name,
 * so it is flattened. It has to be derived the same way everywhere: the films
 * list shows what this returns, and deleting a film looks it up by the same
 * value.
 */
export function storeIdFor (key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, '').slice(-40) || 'origin'
}

/** Identifies content without hashing gigabytes: the head, the tail and the
 *  size. Two different films sharing all three is not a case worth designing
 *  for; re-uploading a film the sharer already uploaded is. */
async function contentIdFor (filePath: string): Promise<string> {
  const { size } = await stat(filePath)
  const span = Math.min(1024 * 1024, size)
  const fh = await open(filePath, 'r')
  try {
    const head = Buffer.alloc(span)
    await fh.read(head, 0, span, 0)
    const tail = Buffer.alloc(span)
    await fh.read(tail, 0, span, Math.max(0, size - span))
    return createHash('sha256').update(head).update(tail).update(String(size)).digest('hex').slice(0, 32)
  } finally {
    await fh.close()
  }
}

/**
 * What relay mode actually consumed. Object storage bills for operations as well
 * as bytes, and a chunked download is many operations, so counting requests is
 * as necessary as counting gigabytes to know what a session costs.
 */
export interface OriginStats {
  getRequests: number
  putRequests: number
  bytesDown: number
  bytesUp: number
}

export class OriginTransfer extends EventEmitter implements MediaTransport {
  private held = new Map<string, Held>()
  private stats: OriginStats = { getRequests: 0, putRequests: 0, bytesDown: 0, bytesUp: 0 }
  private server: Server | null = null
  private serverPort = 0

  constructor (private readonly o: OriginTransferOptions) { super() }

  private get chunk (): number { return this.o.chunkBytes ?? CHUNK_BYTES }

  // ---------------------------------------------------------------- sharing

  async share (filePath: string): Promise<MediaSource> {
    const { size } = await stat(filePath)
    const name = basename(filePath)
    const contentId = await contentIdFor(filePath)
    const { url, key } = await this.o.getUploadUrl(contentId, name, size)

    await this.put(url, filePath, size)
    // The sharer already holds the whole film, so it is recorded as complete
    // rather than fetched back from where it was just sent.
    const source: OriginSource = { kind: 'origin', key, bytes: size }
    this.held.set(key, {
      source, name, path: filePath, ranges: [[0, size]], handle: null,
      playheadSec: 0, durationSec: 0, downBps: 0,
      lastMeasureMs: Date.now(), lastMeasureBytes: size, fetching: null, stopped: false
    })
    return source
  }

  /**
   * Streams the file to a signed URL. Uses the raw http client rather than
   * fetch: S3 requires Content-Length on a presigned PUT, and a streamed fetch
   * body sends chunked transfer encoding instead, which is rejected.
   */
  private put (url: string, filePath: string, size: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const target = new URL(url)
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest
      this.stats.putRequests++
      const req = send(target, {
        method: 'PUT',
        headers: { 'content-length': String(size), 'content-type': 'application/octet-stream' }
      }, res => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          if (status >= 200 && status < 300) return resolve()
          reject(new Error(`upload rejected with ${status}: ${Buffer.concat(chunks).toString().slice(0, 200)}`))
        })
      })
      req.on('error', reject)
      const body = createReadStream(filePath)
      body.on('error', reject)
      let sent = 0
      body.on('data', (c: Buffer | string) => {
        sent += typeof c === 'string' ? Buffer.byteLength(c) : c.length
        this.stats.bytesUp = sent
        this.emit('upload-progress', sent / size)
      })
      body.pipe(req)
    })
  }

  // -------------------------------------------------------------- receiving

  async receive (source: MediaSource): Promise<{ path: string }> {
    if (source.kind !== 'origin') throw new Error('origin transport was given a swarm source')
    const existing = this.held.get(source.key)
    if (existing) return { path: existing.path }

    await this.o.store.ensureRoomFor(source.bytes)
    const dir = this.o.store.dirFor(storeIdFor(source.key))
    await mkdir(dir, { recursive: true })
    const name = basename(source.key)
    const path = join(dir, name)

    // Resume: a previous run's ranges are on disk beside the file. Trusting them
    // is safe because the file is only ever written at the offsets they record.
    const ranges = await this.loadRanges(dir, source.bytes)
    const handle = await open(path, ranges.length ? 'r+' : 'w+')
    await handle.truncate(source.bytes)

    const held: Held = {
      source, name, path, ranges, handle,
      playheadSec: 0, durationSec: 0, downBps: 0,
      lastMeasureMs: Date.now(), lastMeasureBytes: total(ranges), fetching: null, stopped: false
    }
    this.held.set(source.key, held)

    // Recorded so the film appears in the films-on-disk view and can be deleted
    // from there. Without this a relayed film accumulated gigabytes invisibly:
    // FilmStore.list() skips any directory with no metadata beside the file.
    await this.o.store.record({
      infoHash: storeIdFor(source.key),
      name,
      bytes: source.bytes,
      addedAtMs: Date.now()
    })

    // The head carries the container's metadata; without it nothing can open.
    await this.ensure(held, 0, Math.min(this.chunk, source.bytes))
    void this.prefetch(held)
    return { path }
  }

  private rangesPath (dir: string): string { return join(dir, 'ranges.json') }

  private async loadRanges (dir: string, bytes: number): Promise<Range[]> {
    try {
      const raw = JSON.parse(await readFile(this.rangesPath(dir), 'utf8')) as unknown
      if (!Array.isArray(raw)) return []
      const rs = raw.filter((r): r is Range =>
        Array.isArray(r) && r.length === 2 && typeof r[0] === 'number' && typeof r[1] === 'number' &&
        r[0] >= 0 && r[1] <= bytes && r[0] < r[1])
      return rs.reduce<Range[]>((acc, [a, b]) => add(acc, a, b), [])
    } catch {
      return []
    }
  }

  private async saveRanges (held: Held): Promise<void> {
    try {
      await writeFile(this.rangesPath(join(held.path, '..')), JSON.stringify(held.ranges))
    } catch { /* losing this costs a re-download, not correctness */ }
  }

  /** Fetch whatever of `[start, end)` is missing, and not more. */
  private async ensure (held: Held, start: number, end: number): Promise<void> {
    const clampedEnd = Math.min(end, held.source.bytes)
    for (const [a, b] of missing(held.ranges, start, clampedEnd)) {
      for (let at = a; at < b; at += this.chunk) {
        if (held.stopped) return
        const to = Math.min(at + this.chunk, b)
        await this.fetchInto(held, at, to)
      }
    }
  }

  private async fetchInto (held: Held, start: number, end: number): Promise<void> {
    let lastError: unknown = null
    // Two attempts: the first may fail because the signed URL expired while a
    // long download was in progress, and a fresh one is all that is needed.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const url = await this.o.getDownloadUrl()
        this.stats.getRequests++
        const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } })
        if (res.status !== 206 && res.status !== 200) throw new Error(`origin returned ${res.status}`)
        const body = Buffer.from(await res.arrayBuffer())
        if (held.stopped || !held.handle) return
        await held.handle.write(body, 0, body.length, start)
        this.stats.bytesDown += body.length
        held.ranges = add(held.ranges, start, start + body.length)
        this.measure(held)
        await this.saveRanges(held)
        await this.throttle(body.length)
        return
      } catch (err) {
        lastError = err
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async throttle (bytes: number): Promise<void> {
    const limit = this.o.downloadLimitBps
    if (!limit || limit <= 0) return
    await new Promise(r => setTimeout(r, (bytes / limit) * 1000))
  }

  private measure (held: Held): void {
    const now = Date.now()
    const elapsed = (now - held.lastMeasureMs) / 1000
    if (elapsed < 0.5) return
    const bytes = total(held.ranges)
    held.downBps = Math.max(0, (bytes - held.lastMeasureBytes) / elapsed)
    held.lastMeasureMs = now
    held.lastMeasureBytes = bytes
  }

  /**
   * Fetches ahead of the playhead first, then fills in everything else.
   *
   * The order matters for the same reason it does in the swarm: a late joiner
   * wants the part being watched now, not the opening titles. Backfilling
   * afterwards is what keeps a backward seek from stalling.
   */
  private async prefetch (held: Held): Promise<void> {
    if (held.fetching) return held.fetching
    const run = (async () => {
      try {
        while (!held.stopped && total(held.ranges) < held.source.bytes) {
          const bytesPerSec = held.durationSec > 0 ? held.source.bytes / held.durationSec : 0
          const from = bytesPerSec > 0 ? Math.floor(held.playheadSec * bytesPerSec) : 0
          const ahead = bytesPerSec > 0 ? Math.ceil(PREFETCH_SECONDS * bytesPerSec) : held.source.bytes
          await this.ensure(held, from, from + ahead)
          if (held.stopped) return
          const gap = missing(held.ranges, 0, held.source.bytes)[0]
          if (!gap) break
          await this.ensure(held, gap[0], Math.min(gap[1], gap[0] + this.chunk))
        }
      } catch (err) {
        this.emit('error', err)
      } finally {
        held.fetching = null
      }
    })()
    held.fetching = run
    return run
  }

  // ------------------------------------------------------------- playback

  /**
   * Serves the partially-downloaded file over HTTP, waiting for bytes that have
   * not arrived instead of returning zeros. Reading the file directly would give
   * whatever the sparse regions hold, which is silence and a black screen.
   */
  async ensureStreamServer (): Promise<number> {
    if (this.server) return this.serverPort
    const server = createServer((req, res) => { void this.serve(req.url ?? '', req.headers.range, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    this.serverPort = typeof addr === 'object' && addr ? addr.port : 0
    this.server = server
    return this.serverPort
  }

  private async serve (url: string, rangeHeader: string | undefined, res: import('node:http').ServerResponse): Promise<void> {
    const key = decodeURIComponent(url.replace(/^\//, ''))
    const held = this.held.get(key)
    if (!held || !held.handle) { res.writeHead(404); res.end(); return }

    const size = held.source.bytes
    const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader ?? '')
    const start = m ? Number(m[1]) : 0
    const end = m && m[2] ? Math.min(Number(m[2]) + 1, size) : size

    res.writeHead(m ? 206 : 200, {
      'content-type': 'video/x-matroska',
      'accept-ranges': 'bytes',
      'content-length': String(end - start),
      ...(m ? { 'content-range': `bytes ${start}-${end - 1}/${size}` } : {})
    })

    // A seek moves the playhead somewhere the prefetch is not aiming; asking
    // for it here is what makes seeking into an unfetched part work at all.
    held.playheadSec = held.durationSec > 0 ? (start / size) * held.durationSec : held.playheadSec

    try {
      for (let at = start; at < end;) {
        const to = Math.min(at + this.chunk, end)
        await this.ensure(held, at, to)
        if (held.stopped || !held.handle) break
        const buf = Buffer.alloc(to - at)
        await held.handle.read(buf, 0, buf.length, at)
        if (!res.write(buf)) await new Promise(r => res.once('drain', r))
        at = to
      }
    } catch (err) {
      this.emit('error', err)
    } finally {
      res.end()
    }
  }

  streamUrl (id: string): string | null {
    const held = this.held.get(id)
    if (!held || !this.serverPort) return null
    return `http://127.0.0.1:${this.serverPort}/${encodeURIComponent(id)}`
  }

  // -------------------------------------------------------------- reporting

  reportFor (id: string, positionSec: number, durationSec: number): TransferReport | null {
    const held = this.held.get(id)
    if (!held) return null
    if (durationSec > 0) held.durationSec = durationSec
    return {
      havePct: total(held.ranges) / held.source.bytes,
      bufferEndSec: playableSecondsFrom(held.ranges, positionSec, held.source.bytes, durationSec),
      downBps: held.downBps,
      // Nobody uploads in relay mode, and no peers are connected. Reporting
      // zero is the truth, and the readiness gate reads it as such.
      upBps: 0,
      peers: 0
    }
  }

  updatePlayhead (id: string, positionSec: number, durationSec: number): void {
    const held = this.held.get(id)
    if (!held) return
    held.playheadSec = positionSec
    if (durationSec > 0) held.durationSec = durationSec
    if (!held.fetching && total(held.ranges) < held.source.bytes) void this.prefetch(held)
  }

  /** Matches either the object key or the identity the films list shows. */
  async stop (id: string): Promise<void> {
    for (const [key, held] of this.held) {
      if (key !== id && storeIdFor(key) !== id) continue
      held.stopped = true
      try { await held.fetching } catch { /* stopping */ }
      try { await held.handle?.close() } catch { /* going away */ }
      held.handle = null
      this.held.delete(key)
    }
  }

  progress (): TransferProgress[] {
    return [...this.held.values()].map(h => ({
      infoHash: h.source.key,
      name: h.name,
      progress: total(h.ranges) / h.source.bytes,
      downBps: h.downBps,
      upBps: 0,
      peers: 0,
      done: total(h.ranges) >= h.source.bytes,
      bytes: h.source.bytes
    }))
  }

  /** Bytes present locally, however they got here (a resumed transfer counts
   *  bytes it did not fetch this session). */
  bytesFromOrigin (): number {
    return [...this.held.values()].reduce((n, h) => n + total(h.ranges), 0)
  }

  /** What this client asked of the origin, for costing a real session. */
  originStats (): OriginStats { return { ...this.stats } }

  async destroy (): Promise<void> {
    for (const held of this.held.values()) {
      held.stopped = true
      try { await held.fetching } catch { /* stopping */ }
      try { await held.handle?.close() } catch { /* going away */ }
      held.handle = null
    }
    this.held.clear()
    if (this.server) {
      await new Promise<void>(res => this.server!.close(() => res()))
      this.server = null
    }
  }
}
