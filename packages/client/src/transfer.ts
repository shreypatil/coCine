import WebTorrent, { type Torrent } from 'webtorrent'
import { EventEmitter } from 'node:events'
import { basename, dirname } from 'node:path'
import type { Server } from 'node:http'
import { stat } from 'node:fs/promises'
import type { MediaSource, TorrentInfo } from '@cocine/protocol'
import type { MediaTransport, TransferReport } from './transport.js'
import { installWebRtc, DEFAULT_ICE_SERVERS } from './webrtc.js'
import { FilmStore } from './storage.js'
import { PieceScheduler, contiguousSecondsFrom, type WindowConfig } from './pieces.js'

export interface TransferOptions {
  store: FilmStore
  /** Learned from the server, never guessed. */
  trackerUrl: string
  iceServers?: unknown[]
  /** Test affordance: refuse TCP so only the WebRTC path can succeed. */
  webrtcOnly?: boolean
  windows?: WindowConfig
  /**
   * Bytes per second, or -1 for unlimited. Loopback is far faster than any real
   * link, so without shaping a transfer finishes before the readiness gate has
   * anything to gate -- which proves nothing about watching while it arrives.
   */
  downloadLimitBps?: number
  uploadLimitBps?: number
  /** How long to wait for a swarm peer to supply the torrent's metadata. */
  metadataTimeoutMs?: number
}

export interface TransferProgress {
  infoHash: string
  name: string
  /** 0 to 1. */
  progress: number
  downBps: number
  upBps: number
  peers: number
  done: boolean
  bytes: number
}

/**
 * Sharing a film and receiving one.
 *
 * Two things worth knowing. The sharer's file is seeded **in place** -- no copy
 * is made, which matters when the file is four gigabytes. And hashing does not
 * need a worker: measured at roughly 780 MB/s with worst-case event-loop lag of
 * one millisecond, because WebTorrent streams and hashes in chunks rather than
 * in one blocking pass. That was checked before this class was written, since
 * it would otherwise have dictated the whole process model.
 */
export class TransferManager extends EventEmitter implements MediaTransport {
  private client: WebTorrent | null = null
  private torrents = new Map<string, Torrent>()
  private schedulers = new Map<string, PieceScheduler>()
  private server: Server | null = null
  private serverPort = 0

  constructor (private readonly o: TransferOptions) {
    super()
    // Before any client exists, or the swarm is silently TCP-only.
    installWebRtc()
  }

  private ensureClient (): WebTorrent {
    if (this.client) return this.client
    this.client = new WebTorrent({
      dht: false,
      lsd: false,
      natUpnp: false,
      utp: false,
      webSeeds: false,
      ...(this.o.webrtcOnly ? { tcp: false } : {}),
      ...(this.o.downloadLimitBps !== undefined ? { downloadLimit: this.o.downloadLimitBps } : {}),
      ...(this.o.uploadLimitBps !== undefined ? { uploadLimit: this.o.uploadLimitBps } : {}),
      tracker: { rtcConfig: { iceServers: this.o.iceServers ?? DEFAULT_ICE_SERVERS } }
    })
    this.client.on('error', err => this.emit('error', err))
    return this.client
  }

  /** Seed a film already on this machine. The file is not copied or moved. */
  async share (filePath: string): Promise<MediaSource> {
    const size = (await stat(filePath)).size
    const torrent = await new Promise<Torrent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out hashing ${basename(filePath)}`)), 15 * 60_000)
      this.ensureClient().seed(
        filePath,
        { announce: [this.o.trackerUrl], path: dirname(filePath) },
        t => { clearTimeout(timer); resolve(t) }
      )
    })
    this.track(torrent)
    return {
        kind: 'p2p',
      infoHash: torrent.infoHash,
      magnet: torrent.magnetURI,
      bytes: size,
      pieceLength: torrent.pieceLength
    }
  }

  /**
   * Fetch a film from the room. Resolves as soon as the torrent's metadata is
   * ready and the file has a path -- not when it has finished, because the
   * whole point is watching before it finishes.
   */
  async receive (source: MediaSource): Promise<{ path: string; torrent: Torrent }> {
    if (source.kind !== 'p2p') throw new Error('the swarm transport was given an origin source')
    const info: TorrentInfo = source
    const existing = this.torrents.get(info.infoHash.toLowerCase())
    if (existing) return { path: existing.files[0]?.path ?? '', torrent: existing }

    await this.o.store.ensureRoomFor(info.bytes)
    await this.ensureStreamServer()
    const dir = this.o.store.dirFor(info.infoHash)

    // Metadata arrives from a peer, not from the tracker, so it depends on a
    // swarm connection being established first. That occasionally does not
    // happen on the first attempt -- observed in roughly one run in three --
    // so a stalled attempt is torn down and retried rather than failing the
    // whole transfer.
    const timeout = this.o.metadataTimeoutMs ?? 45_000
    const attempt = async (): Promise<Torrent | null> => {
      let added: Torrent | null = null
      const t = await new Promise<Torrent | null>(resolve => {
        const timer = setTimeout(() => resolve(null), timeout)
        added = this.ensureClient().add(info.magnet, { announce: [this.o.trackerUrl], path: dir }, got => {
          clearTimeout(timer); resolve(got)
        })
      })
      if (!t && added) {
        this.emit('warning', `no metadata for ${info.infoHash.slice(0, 8)} in ${timeout / 1000}s; retrying`)
        await new Promise<void>(res => (added as Torrent).destroy(() => res()))
      }
      return t
    }

    const torrent = (await attempt()) ?? (await attempt())
    if (!torrent) throw new Error(`no metadata from the swarm for ${basename(info.magnet)} after two attempts`)

    await this.o.store.record({
      infoHash: torrent.infoHash,
      name: torrent.name,
      bytes: info.bytes,
      addedAtMs: Date.now()
    })
    this.track(torrent)

    // Fetch the container's head and tail before anything else: Matroska keeps
    // its seek index at the end of the file, and without it mpv cannot seek at
    // all -- which reads as a broken application rather than a partial download.
    const scheduler = new PieceScheduler(torrent, 0, this.o.windows)
    this.schedulers.set(torrent.infoHash.toLowerCase(), scheduler)
    scheduler.prime()

    return { path: `${dir}/${torrent.name}`, torrent }
  }

  private track (torrent: Torrent): void {
    this.torrents.set(torrent.infoHash.toLowerCase(), torrent)
    torrent.on('done', () => this.emit('done', torrent.infoHash))
    torrent.on('error', err => this.emit('error', err))
  }

  get (infoHash: string): Torrent | undefined { return this.torrents.get(infoHash.toLowerCase()) }

  schedulerFor (infoHash: string): PieceScheduler | undefined {
    return this.schedulers.get(infoHash.toLowerCase())
  }

  /**
   * An HTTP origin that streams torrents, blocking on pieces that have not
   * arrived yet.
   *
   * This is what makes watching before the download finishes possible at all.
   * Playing the file on disk directly would read zeros wherever a piece is
   * missing, because the file is written sparsely -- so the player has to go
   * through something that knows how to wait. Byte ranges are supported, which
   * is what lets mpv seek.
   */
  async ensureStreamServer (): Promise<number> {
    if (this.server) return this.serverPort
    const server = this.ensureClient().createServer()
    await new Promise<void>(res => server.listen(0, '127.0.0.1', res))
    const addr = server.address()
    this.serverPort = typeof addr === 'object' && addr ? addr.port : 0
    this.server = server
    return this.serverPort
  }

  /** A URL mpv can open, or null if this film is not being handled here. */
  streamUrl (infoHash: string): string | null {
    const t = this.torrents.get(infoHash.toLowerCase())
    const file = t?.files[0]
    if (!file || !this.serverPort) return null
    return `http://127.0.0.1:${this.serverPort}${file.streamURL}`
  }

  /**
   * What this client can tell the room about itself. Null when it is not
   * involved in this film at all.
   */
  reportFor (infoHash: string, positionSec: number, durationSec: number): {
    havePct: number; bufferEndSec: number; downBps: number; upBps: number; peers: number
  } | null {
    const t = this.torrents.get(infoHash.toLowerCase())
    if (!t) return null
    const geometry = {
      pieceLength: t.pieceLength,
      pieceCount: t.pieces.length,
      totalBytes: t.length,
      durationSec
    }
    return {
      havePct: t.progress,
      bufferEndSec: t.done
        ? Math.max(0, durationSec - positionSec)
        : contiguousSecondsFrom(positionSec, geometry, i => t.bitfield.get(i)),
      downBps: t.downloadSpeed,
      upBps: t.uploadSpeed,
      peers: t.numPeers
    }
  }

  /**
   * Move the windows to follow playback. Called as the room's playhead moves,
   * including while the film is still arriving -- which is the whole point of
   * windowing rather than fetching in order.
   */
  updatePlayhead (infoHash: string, positionSec: number, durationSec: number): void {
    const scheduler = this.schedulers.get(infoHash.toLowerCase())
    if (!scheduler) return
    if (durationSec > 0) scheduler.setDuration(durationSec)
    scheduler.update(positionSec)
  }

  /** Drop the torrent so nothing writes into the film's directory any more. */
  async stop (id: string): Promise<void> {
    const key = id.toLowerCase()
    const torrent = this.torrents.get(key)
    if (!torrent) return
    this.torrents.delete(key)
    this.schedulers.delete(key)
    await new Promise<void>(resolve => {
      // The files stay on disk; the caller is about to delete the directory
      // itself, and destroying the store here would race with that.
      try { torrent.destroy(() => resolve()) } catch { resolve() }
      setTimeout(resolve, 2000).unref?.()
    })
  }

  progress (): TransferProgress[] {
    return [...this.torrents.values()].map(t => ({
      infoHash: t.infoHash,
      name: t.name,
      progress: t.progress,
      downBps: t.downloadSpeed,
      upBps: t.uploadSpeed,
      peers: t.numPeers,
      done: t.done,
      bytes: t.length
    }))
  }

  async destroy (): Promise<void> {
    this.torrents.clear()
    this.schedulers.clear()
    if (this.server) { await new Promise<void>(res => this.server!.close(() => res())); this.server = null }
    await new Promise<void>(res => this.client ? this.client.destroy(() => res()) : res())
    this.client = null
  }
}
