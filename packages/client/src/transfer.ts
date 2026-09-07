import WebTorrent, { type Torrent } from 'webtorrent'
import { EventEmitter } from 'node:events'
import { basename, dirname } from 'node:path'
import { stat } from 'node:fs/promises'
import type { TorrentInfo } from '@cocine/protocol'
import { installWebRtc, DEFAULT_ICE_SERVERS } from './webrtc.js'
import { FilmStore } from './storage.js'
import { PieceScheduler, type WindowConfig } from './pieces.js'

export interface TransferOptions {
  store: FilmStore
  /** Learned from the server, never guessed. */
  trackerUrl: string
  iceServers?: unknown[]
  /** Test affordance: refuse TCP so only the WebRTC path can succeed. */
  webrtcOnly?: boolean
  windows?: WindowConfig
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
export class TransferManager extends EventEmitter {
  private client: WebTorrent | null = null
  private torrents = new Map<string, Torrent>()
  private schedulers = new Map<string, PieceScheduler>()

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
      tracker: { rtcConfig: { iceServers: this.o.iceServers ?? DEFAULT_ICE_SERVERS } }
    })
    this.client.on('error', err => this.emit('error', err))
    return this.client
  }

  /** Seed a film already on this machine. The file is not copied or moved. */
  async share (filePath: string): Promise<TorrentInfo> {
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
  async receive (info: TorrentInfo): Promise<{ path: string; torrent: Torrent }> {
    const existing = this.torrents.get(info.infoHash.toLowerCase())
    if (existing) return { path: existing.files[0]?.path ?? '', torrent: existing }

    await this.o.store.ensureRoomFor(info.bytes)
    const dir = this.o.store.dirFor(info.infoHash)

    const torrent = await new Promise<Torrent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no metadata from the swarm within 60s')), 60_000)
      this.ensureClient().add(info.magnet, { announce: [this.o.trackerUrl], path: dir }, t => {
        clearTimeout(timer); resolve(t)
      })
    })

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
    await new Promise<void>(res => this.client ? this.client.destroy(() => res()) : res())
    this.client = null
  }
}
