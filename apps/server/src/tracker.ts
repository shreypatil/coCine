import { Server as TrackerServer } from 'bittorrent-tracker'
import { WebSocketServer, type WebSocket } from 'ws'

/**
 * A BitTorrent tracker living inside the signalling server.
 *
 * Two reasons it belongs here rather than on a public tracker. The swarm should
 * be exactly the people in the room and nobody else, and a public tracker would
 * announce the room's existence to strangers. And peers are already connected
 * here, so this is the one place that knows who is allowed in.
 *
 * It must be a *WebSocket* tracker: WebRTC peers cannot be introduced over an
 * HTTP announce, because they need to exchange offers and answers to connect at
 * all. That exchange is what the tracker's websocket protocol carries.
 */
export class RoomTracker {
  private tracker: TrackerServer
  private wss: WebSocketServer
  /** Info hashes any room has announced. Anything else is refused. */
  private allowed = new Set<string>()

  constructor () {
    this.tracker = new TrackerServer({
      udp: false,
      http: false,
      ws: false,
      stats: false,
      // The info hash is effectively a capability: it only reaches you by being
      // in the room that announced it. Refusing everything else stops this
      // being usable as a public tracker for arbitrary torrents.
      filter: (infoHash, _params, cb) => {
        cb(this.allowed.has(infoHash.toLowerCase()) ? null : new Error('unknown torrent'))
      }
    })
    this.tracker.on('error', () => { /* a bad announce must not take the server down */ })
    this.tracker.on('warning', () => { /* likewise */ })

    this.wss = new WebSocketServer({ noServer: true })
    this.wss.on('connection', (ws: WebSocket, req) => {
      // The tracker expects the upgrade request on the socket.
      ;(ws as unknown as { upgradeReq: unknown }).upgradeReq = req
      this.tracker.onWebSocketConnection(ws as never)
    })
  }

  allow (infoHash: string): void { this.allowed.add(infoHash.toLowerCase()) }
  forget (infoHash: string): void { this.allowed.delete(infoHash.toLowerCase()) }
  allows (infoHash: string): boolean { return this.allowed.has(infoHash.toLowerCase()) }
  get size (): number { return this.allowed.size }

  /** Hand it a websocket upgrade that arrived on the announce path. */
  handleUpgrade (req: Parameters<WebSocketServer['handleUpgrade']>[0], socket: Parameters<WebSocketServer['handleUpgrade']>[1], head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit('connection', ws, req))
  }

  close (): void {
    try { this.tracker.close() } catch { /* already gone */ }
    this.wss.close()
  }
}

export const ANNOUNCE_PATH = '/announce'
