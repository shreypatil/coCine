/**
 * The only surface the sync engine is allowed to touch.
 *
 * Two implementations satisfy it: ExternalMpv (spawns its own mpv, used for
 * phase 0/1 and permanently for headless testing) and later EmbeddedMpv
 * (reparented into the Electron window via --wid). The sync engine must not be
 * able to tell them apart -- that is what makes the phase 1 test suite reusable
 * against the shipped player.
 *
 * This layer decides nothing. It executes.
 */
export interface PlayerController {
  /** Load a file and block until mpv reports it ready. Starts paused. */
  load(path: string): Promise<void>
  /** Unpause immediately. Scheduling is the sync engine's problem, not ours. */
  play(): Promise<void>
  pause(): Promise<void>
  /** Absolute, exact seek. Requires hr-seek; a keyframe seek cannot hold 100 ms. */
  seek(seconds: number): Promise<void>
  /** Playback rate. 1.0 is normal; the sync engine nudges within a few percent. */
  setRate(rate: number): Promise<void>
  /** Last observed playback position, in seconds. Synchronous by design --
   *  the sync engine runs on a tick and cannot await a round trip. */
  position(): number
  /** Whether mpv is currently paused, as last observed. */
  isPaused(): boolean
  /** Wall-clock ms at which `position()` was last updated. */
  positionObservedAt(): number
  duration(): number | null
  /** Transient on-screen text drawn by the player itself. */
  showText(text: string, durationMs?: number): Promise<void>
  on(event: 'position', fn: (seconds: number, atMs: number) => void): void
  on(event: 'pause', fn: (paused: boolean) => void): void
  on(event: 'eof', fn: () => void): void
  close(): Promise<void>
}

export interface PlayerOptions {
  /** Path to the mpv binary. Defaults to `mpv` on PATH. */
  binary?: string
  /** Headless: no video output, no audio output, but still paced in real time. */
  headless?: boolean
  /** Load the user's mpv.conf. Off by default so behaviour is reproducible. */
  useUserConfig?: boolean
  /** Extra mpv arguments, appended last. */
  extraArgs?: string[]
  /** Native window id to reparent into. When set, mpv renders into that window
   *  instead of creating its own, and `headless` is ignored. */
  wid?: string
}
