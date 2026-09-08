import type { MediaSource } from '@cocine/protocol'

/** What a client reports about one film in flight. Shared by both transports. */
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

/** What the readiness gate needs from a client, once a second. */
export interface TransferReport {
  havePct: number
  bufferEndSec: number
  downBps: number
  upBps: number
  peers: number
}

/**
 * Getting a film from wherever it is to where it can be played.
 *
 * Two implementations, chosen by the room's mode. `TransferManager` is the
 * swarm; `OriginTransfer` is relay mode. Everything above this interface --
 * the readiness gate, the progress display, playing before the download
 * finishes -- works the same either way, which is the point of it existing.
 */
export interface MediaTransport {
  /** Make a local file available to the room, returning what to announce. */
  share (filePath: string): Promise<MediaSource>
  /** Begin fetching. Resolves once there is something to play, not once complete. */
  receive (source: MediaSource): Promise<{ path: string }>
  /** A URL the player can open. Serves bytes that have arrived and waits for
   *  the rest, which is what makes watching during the transfer possible. */
  streamUrl (id: string): string | null
  reportFor (id: string, positionSec: number, durationSec: number): TransferReport | null
  /** Tell the transport where playback is, so it fetches that part first. */
  updatePlayhead (id: string, positionSec: number, durationSec: number): void
  /**
   * Stop working on one film and let go of its files.
   *
   * Needed before deleting it: a transfer still running will write bytes back
   * into a directory that is being removed, and the film reappears.
   */
  stop (id: string): Promise<void>
  progress (): TransferProgress[]
  /**
   * Which parts of the film are held, as a piece map, when the transport can
   * say. The origin transport fetches byte ranges rather than pieces and does
   * not answer.
   */
  pieceMap?: (id: string) => string | null
  /**
   * Stop or restart taking part. Only the swarm has anything to pause: in relay
   * mode nobody depends on this client at all.
   */
  setPaused?: (id: string, paused: boolean) => boolean
  destroy (): Promise<void>
}
