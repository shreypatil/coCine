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
  /** Sixty-four hex digits, one per sixty-fourth of the film: how full that
   *  slice is, 0 to 15. Absent when the transport cannot say. */
  pieces?: string
  paused?: boolean
  sharer?: boolean
}
export interface TransferStatus {
  perPeer: PeerStatus[]
  etaSec: number | null
  tMinSec: number | null
  bottleneck: string | null
  fullCopies: number
  safeForSharerToLeave: boolean
  /** Which parts of the film the whole room can play, as a piece map. */
  seekableMap?: string
}

export interface SubtitleFile {
  name: string
  path: string
  /** Whether coCine can draw it, or only name it. */
  supported: boolean
  /** Whether it is named after this film rather than another in the folder. */
  matches: boolean
}

export interface State {
  /** Which player is running. 'html' renders a <video> in this window; 'mpv'
   *  keeps the native surface in a child window. Both are supported while the
   *  two are being compared -- see main/player-engine.ts. */
  playerEngine: 'mpv' | 'html'
  /** The film's own volume, 0 to 100, as the viewer set it. */
  volume: number
  /** A film being converted so the <video> engine can open it, or null. */
  converting: {
    name: string
    /** Why it needs converting, in words that can be shown as they are. */
    reason: string
    /** Whether this is a real transcode rather than a repack. */
    slow: boolean
    progress: number | null
  } | null
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
  /** Why the film could not be fetched, when it could not. */
  receiveError: string | null
  /** The room's film, whether or not this machine has a copy yet. */
  roomFilm: { name: string; durationSec: number; hasSource: boolean } | null
  phase: 'lobby' | 'preparing' | 'ready' | 'playing'
  waitForLatecomers: boolean
  /** Whether someone arriving may drive playback without being handed it. */
  openControl: boolean
  /** Whether the system file dialog can be trusted here; see main/browse.ts. */
  nativePicker: boolean
  /** Why peer-to-peer is unavailable in this build, if it is. */
  webrtcError: string | null
  /** Whether the window is on screen. Nothing animates before it is. */
  windowShown: boolean
  /** Whether this machine is feeding the room, and whether that is paused. */
  sharing: 'off' | 'sharing' | 'paused'
  sharedInfoHash: string | null
  transferStatus: TransferStatus | null
}

/** What the host settles before anybody else is in the room. */
export interface RoomOptions {
  mode?: 'p2p' | 'origin'
  openControl?: boolean
  waitForLatecomers?: boolean
}

export interface ShapeRect { x: number; y: number; width: number; height: number }

export interface DirEntry {
  name: string; path: string; isDir: boolean
  bytes: number; modifiedMs: number; playable: boolean
}
export interface Listing { path: string; parent: string | null; entries: DirEntry[]; filtered: boolean }
export interface Place { label: string; path: string }

declare global {
  interface Window {
    cocine: {
      setVideoSlot: (r: {
        x: number; y: number; width: number; height: number
        viewport?: { width: number; height: number }
      }) => Promise<unknown>
      openFile: () => Promise<{ path: string; name: string; durationSec: number | null } | null>
      /** The application's own picker: where to start, and one folder at a time. */
      browseStart: () => Promise<{ places: Place[]; path: string }>
      browseList: (path: string, showAll?: boolean) => Promise<Listing>
      /** Hides the video surface while the picker is up, or it covers it. */
      browseActive: (active: boolean) => Promise<unknown>
      openPath: (path: string) => Promise<{ path: string; name: string; durationSec: number | null }>
      pathForFile: (f: File) => string | null
      getIdentity: () => Promise<{ id: string; name: string; server: string; lastCode: string | null }>
      listFilms: () => Promise<Library>
      removeFilm: (infoHash: string) => Promise<void>
      /** Hand the open film to the room; nothing leaves this machine before it. */
      shareFilm: () => Promise<{ infoHash: string | null }>
      setSharingPaused: (paused: boolean) => Promise<{ paused: boolean }>
      unloadFilm: () => Promise<unknown>
      connect: (o: { url: string; code: string | null; name: string; options?: RoomOptions }) => Promise<{ memberId: string; code: string }>
      disconnect: () => Promise<void>
      sendChat: (text: string) => Promise<void>
      setControl: (memberId: string, mayControl: boolean) => Promise<void>
      transferHost: (memberId: string) => Promise<void>
      startAnyway: () => Promise<void>
      setWaitForLatecomers: (wait: boolean) => Promise<void>
      setMode: (mode: 'p2p' | 'origin') => Promise<unknown>
      setOpenControl: (open: boolean) => Promise<unknown>
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
      /** Main window only: the fullscreen draft to draw, or null when closed. */
      setOverlayDraft: (text: string | null) => Promise<unknown>
      /** Overlay only: what the main window is typing, for it to draw. */
      onOverlayDraft: (cb: (text: string | null) => void) => () => void
      /** Subtitle files beside the film, and the text of one of them. */
      setFilmVolume?: (percent: number) => Promise<unknown>
      subtitlesBeside?: () => Promise<{ files: SubtitleFile[] }>
      readSubtitles?: (path: string) => Promise<{ text: string }>
      /** The <video> player: commands from the main process, and the state
       *  and events it pushes back. Present only under COCINE_PLAYER=html. */
      onPlayerCommand?: (cb: (c: { id: number; cmd: string; arg?: unknown }) => void) => () => void
      sendPlayerReply?: (r: { id: number; data?: unknown; error?: string }) => void
      sendPlayerState?: (s: unknown) => void
      sendPlayerEvent?: (e: { kind: string; message?: string }) => void
      /** Overlay only: which rectangles of its window should exist at all. */
      setOverlayShape: (rects: ShapeRect[]) => Promise<unknown>
      /** Overlay only: whether it floats over the film or falls back to a box. */
      onOverlayLayout: (cb: (layout: 'floating' | 'panel') => void) => () => void
    }
  }
}

export {}
