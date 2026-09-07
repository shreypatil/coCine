/**
 * Minimal declarations for the parts of bittorrent-tracker we use. The package
 * ships no types; declaring only what RoomTracker touches keeps the surface
 * honest rather than pretending the whole module is typed.
 */
declare module 'bittorrent-tracker' {
  import type { EventEmitter } from 'node:events'

  export interface TrackerServerOptions {
    udp?: boolean
    http?: boolean
    ws?: boolean
    stats?: boolean
    interval?: number
    filter?: (infoHash: string, params: Record<string, unknown>, cb: (err: Error | null) => void) => void
  }

  export class Server extends EventEmitter {
    constructor (opts?: TrackerServerOptions)
    onWebSocketConnection (socket: unknown): void
    onHttpRequest (req: unknown, res: unknown, opts?: Record<string, unknown>): void
    close (cb?: () => void): void
    readonly torrents: Record<string, unknown>
  }
}
