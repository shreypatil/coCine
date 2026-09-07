/**
 * The shape of everything the main process pushes to a window, and the bridge
 * the preload script exposes.
 *
 * Shared because there are two renderer entry points -- the main interface and
 * the fullscreen chat overlay -- and both receive the same state. Keeping one
 * definition is what stops them drifting apart.
 */

export interface Member {
  id: string; name: string; isHost: boolean; mayControl: boolean
  inVoice: boolean; muted: boolean; deafened: boolean
}
export interface ChatMessage {
  id: string
  kind: 'said' | 'joined' | 'left' | 'system'
  memberId: string | null
  name: string
  text: string
  atServerMs: number
}
export interface StoredFilm {
  infoHash: string; name: string; path: string
  bytes: number; onDiskBytes: number; complete: boolean; addedAtMs: number
}
export interface TransferProgress {
  infoHash: string; name: string; progress: number
  downBps: number; upBps: number; peers: number; done: boolean; bytes: number
}
export interface Library { films: StoredFilm[]; usedBytes: number; freeBytes: number }
export interface PeerStatus {
  memberId: string; name: string; havePct: number; bufferEndSec: number
  downBps: number; upBps: number; peers: number; ready: boolean
}
export interface TransferStatus {
  perPeer: PeerStatus[]
  etaSec: number | null
  tMinSec: number | null
  bottleneck: string | null
  fullCopies: number
  safeForSharerToLeave: boolean
}

export interface State {
  ready: boolean; connected: boolean
  /** Whether the room is actually reachable, as opposed to merely joined. */
  connection: 'connected' | 'reconnecting' | 'closed'
   members: Member[]; memberId: string
  code: string | null; messages: ChatMessage[]
  isHost: boolean; mayControl: boolean
  mediaName: string | null; durationSec: number | null
  positionSec: number; expectedSec: number | null; driftMs: number | null
  paused: boolean; rate: number
  clockOffsetMs: number | null; rttMs: number | null; lastAction: string | null
  voiceIce: RTCIceServer[]
  mode: 'p2p' | 'origin'
  originAvailable: boolean
  startupError: { message: string; howToInstall: string } | null
  fullscreen: boolean
  transfers: TransferProgress[]
  receiving: { name: string; infoHash: string } | null
  phase: 'lobby' | 'preparing' | 'ready' | 'playing'
  waitForLatecomers: boolean
  transferStatus: TransferStatus | null
}

declare global {
  interface Window {
    cocine: {
      setVideoSlot: (r: { x: number; y: number; width: number; height: number }) => Promise<unknown>
      openFile: () => Promise<{ path: string; name: string; durationSec: number | null } | null>
      openPath: (path: string) => Promise<{ path: string; name: string; durationSec: number | null }>
      pathForFile: (f: File) => string | null
      getIdentity: () => Promise<{ id: string; name: string; server: string; lastCode: string | null }>
      listFilms: () => Promise<Library>
      removeFilm: (infoHash: string) => Promise<void>
      connect: (o: { url: string; code: string | null; name: string }) => Promise<{ memberId: string; code: string }>
      disconnect: () => Promise<void>
      sendChat: (text: string) => Promise<void>
      setControl: (memberId: string, mayControl: boolean) => Promise<void>
      transferHost: (memberId: string) => Promise<void>
      startAnyway: () => Promise<void>
      setWaitForLatecomers: (wait: boolean) => Promise<void>
      setMode: (mode: 'p2p' | 'origin') => Promise<unknown>
      play: () => Promise<void>
      pause: () => Promise<void>
      seek: (sec: number) => Promise<void>
      setFullScreen: (on?: boolean) => Promise<boolean>
      sendSignal: (to: string, payload: unknown) => Promise<void>
      setVoiceState: (v: { inVoice: boolean; muted: boolean; deafened: boolean }) => Promise<void>
      moderateVoice: (memberId: string, action: 'mute' | 'unmute') => Promise<void>
      duckFilm: (ducked: boolean) => Promise<void>
      onSignal: (cb: (from: string, payload: unknown) => void) => () => void
      onModerated: (cb: (by: string, action: string) => void) => () => void
      onState: (cb: (s: State) => void) => () => void
      /** Overlay only: the main window asking it to take the keyboard. */
      onFocusChat: (cb: () => void) => () => void
      /** Overlay only: hand the keyboard back, so shortcuts work again. */
      releaseChatFocus: () => Promise<unknown>
    }
  }
}

export {}
