/**
 * Declarations for the parts of WebTorrent coCine uses.
 *
 * Hand-written rather than pulled from DefinitelyTyped: the published types lag
 * the v3 API, and declaring only what is touched keeps this honest about the
 * surface actually depended on. Anything missing here is a deliberate gap, not
 * an oversight -- add to it when the transfer manager needs more.
 */
declare module 'webtorrent' {
  import type { EventEmitter } from 'node:events'

  export interface Wire extends EventEmitter {
    peerId: string
    amChoking: boolean
    peerChoking: boolean
    choke: () => void
    unchoke: () => void
    remoteAddress?: string
  }

  export interface TorrentFile {
    name: string
    length: number
    path: string
  }

  export interface Torrent extends EventEmitter {
    infoHash: string
    magnetURI: string
    name: string
    length: number
    pieceLength: number
    pieces: Array<unknown | null>
    bitfield: { get: (index: number) => boolean }
    files: TorrentFile[]
    /** 0 to 1. */
    progress: number
    downloaded: number
    uploaded: number
    downloadSpeed: number
    uploadSpeed: number
    numPeers: number
    wires: Wire[]
    done: boolean
    destroyed: boolean
    path: string
    /** Piece ranges, inclusive. Higher priority is fetched first. */
    select: (start: number, end: number, priority?: number, notify?: () => void) => void
    deselect: (start: number, end: number) => void
    /** Fetch these pieces as soon as possible. */
    critical: (start: number, end: number) => void
    destroy: (cb?: () => void) => void
  }

  export interface TorrentOptions {
    announce?: string[]
    path?: string
    name?: string
    /** Skip verifying existing files on disk. */
    skipVerify?: boolean
  }

  export interface ClientOptions {
    dht?: boolean
    lsd?: boolean
    natUpnp?: boolean
    utp?: boolean
    tcp?: boolean
    webSeeds?: boolean
    /** Bytes per second; -1 for unlimited. */
    downloadLimit?: number
    uploadLimit?: number
    maxConns?: number
    tracker?: boolean | { rtcConfig?: unknown; announce?: string[] }
  }

  export default class WebTorrent extends EventEmitter {
    constructor (opts?: ClientOptions)
    readonly torrents: Torrent[]
    readonly downloadSpeed: number
    readonly uploadSpeed: number
    readonly progress: number
    readonly peerId: string
    add (torrentId: string | Buffer, opts?: TorrentOptions, onTorrent?: (torrent: Torrent) => void): Torrent
    seed (input: string | string[] | Buffer, opts?: TorrentOptions, onSeed?: (torrent: Torrent) => void): Torrent
    get (torrentId: string): Torrent | null | undefined
    remove (torrentId: string, cb?: () => void): void
    destroy (cb?: () => void): void
    throttleDownload (rate: number): void
    throttleUpload (rate: number): void
  }
}
