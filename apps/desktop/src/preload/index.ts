import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * The entire main-to-renderer surface. Hand-rolled over the shared types rather
 * than a typed-IPC framework -- it is small enough to read in one screen, and
 * nothing sits between the renderer and a latency problem.
 */
const api = {
  setVideoSlot: (slot: {
    x: number; y: number; width: number; height: number
    viewport?: { width: number; height: number }
  }) => ipcRenderer.invoke('video:slot', slot),
  getIdentity: () => ipcRenderer.invoke('identity:get'),
  getServers: () => ipcRenderer.invoke('identity:servers'),
  listFilms: () => ipcRenderer.invoke('films:list'),
  removeFilm: (infoHash: string) => ipcRenderer.invoke('films:remove', infoHash),
  receiveFilm: (info: unknown) => ipcRenderer.invoke('film:receive', info),
  /** Hand the open film to the room. Nothing leaves this machine before it. */
  shareFilm: () => ipcRenderer.invoke('film:share'),
  setSharingPaused: (paused: boolean) => ipcRenderer.invoke('film:setSharingPaused', paused),
  unloadFilm: () => ipcRenderer.invoke('film:unload'),
  openFile: () => ipcRenderer.invoke('file:open'),
  browseStart: () => ipcRenderer.invoke('browse:start'),
  browseList: (path: string, showAll?: boolean) => ipcRenderer.invoke('browse:list', path, showAll),
  browseActive: (active: boolean) => ipcRenderer.invoke('browse:active', active),
  openPath: (path: string) => ipcRenderer.invoke('file:openPath', path),
  /** Electron removed File.path; this is the supported way to recover a real
   *  filesystem path from a dropped file. */
  pathForFile: (f: File): string | null => {
    try { return webUtils.getPathForFile(f) } catch { return null }
  },
  connect: (o: {
    url: string; code: string | null; name: string
    /** Honoured only when creating a room. */
    options?: { mode?: 'p2p' | 'origin'; openControl?: boolean; waitForLatecomers?: boolean }
  }) => ipcRenderer.invoke('room:connect', o),
  sendChat: (text: string) => ipcRenderer.invoke('chat:send', text),
  setControl: (memberId: string, mayControl: boolean) => ipcRenderer.invoke('member:setControl', memberId, mayControl),
  transferHost: (memberId: string) => ipcRenderer.invoke('member:transferHost', memberId),
  startAnyway: () => ipcRenderer.invoke('room:startAnyway'),
  setWaitForLatecomers: (wait: boolean) => ipcRenderer.invoke('room:setWaitForLatecomers', wait),
  setMode: (mode: 'p2p' | 'origin') => ipcRenderer.invoke('room:setMode', mode),
  setOpenControl: (open: boolean) => ipcRenderer.invoke('room:setOpenControl', open),
  /** Overlay only: the rectangles it wants to exist as, in its own CSS pixels.
   *  Everything outside them is cut out of the window so the film shows. */
  setOverlayShape: (rects: Array<{ x: number; y: number; width: number; height: number }>) =>
    ipcRenderer.invoke('overlay:shape', rects),
  onOverlayLayout: (h: (layout: 'floating' | 'panel') => void) => {
    const fn = (_e: unknown, layout: 'floating' | 'panel'): void => h(layout)
    ipcRenderer.on('overlay:layout', fn)
    return () => { ipcRenderer.removeListener('overlay:layout', fn) }
  },
  /** Main window only: what is being typed into the fullscreen composer, or
   *  null when it is closed. The overlay cannot hold a text field of its own --
   *  it is not a window the window manager will give the keyboard to -- so the
   *  main window types and the overlay draws. */
  setOverlayDraft: (text: string | null) => ipcRenderer.invoke('overlay:draft', text),
  onOverlayDraft: (h: (text: string | null) => void) => {
    const fn = (_e: unknown, text: string | null): void => h(text)
    ipcRenderer.on('overlay:draft', fn)
    return () => { ipcRenderer.removeListener('overlay:draft', fn) }
  },
  /**
   * The <video> player (COCINE_PLAYER=html). The main process holds the sync
   * engine and drives the element in here through PlayerController, so commands
   * come down and state goes back up continuously -- position() in the main
   * process reads a cache and cannot await a round trip.
   */
  onPlayerCommand: (h: (c: { id: number; cmd: string; arg?: unknown }) => void) => {
    const fn = (_e: unknown, c: { id: number; cmd: string; arg?: unknown }): void => h(c)
    ipcRenderer.on('player:command', fn)
    return () => { ipcRenderer.removeListener('player:command', fn) }
  },
  sendPlayerReply: (r: { id: number; data?: unknown; error?: string }) => ipcRenderer.send('player:reply', r),
  /** Sent many times a second; `send` rather than `invoke` so no reply is
   *  awaited and a slow main process cannot stall the frame callback. */
  sendPlayerState: (s: unknown) => ipcRenderer.send('player:state', s),
  sendPlayerEvent: (e: { kind: string; message?: string }) => ipcRenderer.send('player:event', e),
  /** Subtitle files sitting beside the film, and the text of one. */
  /** The film's own volume, 0 to 100. Voice ducking is applied on top. */
  setFilmVolume: (percent: number) => ipcRenderer.invoke('film:volume', percent),
  subtitlesBeside: () => ipcRenderer.invoke('subs:beside'),
  /** Subtitle tracks inside the film, which the media element never reports. */
  embeddedSubtitles: () => ipcRenderer.invoke('subs:embedded'),
  extractSubtitle: (index: number) => ipcRenderer.invoke('subs:extract', index),
  readSubtitles: (path: string) => ipcRenderer.invoke('subs:read', path),
  sendSignal: (to: string, payload: unknown) => ipcRenderer.invoke('voice:signal', to, payload),
  setVoiceState: (v: { inVoice: boolean; muted: boolean; deafened: boolean }) => ipcRenderer.invoke('voice:state', v),
  moderateVoice: (memberId: string, action: 'mute' | 'unmute') => ipcRenderer.invoke('voice:moderate', memberId, action),
  duckFilm: (ducked: boolean) => ipcRenderer.invoke('voice:duck', ducked),
  onSignal: (cb: (from: string, payload: unknown) => void) => {
    const h = (_e: unknown, from: string, payload: unknown): void => cb(from, payload)
    ipcRenderer.on('voice:signal', h)
    return () => ipcRenderer.off('voice:signal', h)
  },
  onModerated: (cb: (by: string, action: string) => void) => {
    const h = (_e: unknown, by: string, action: string): void => cb(by, action)
    ipcRenderer.on('voice:moderated', h)
    return () => ipcRenderer.off('voice:moderated', h)
  },
  disconnect: () => ipcRenderer.invoke('room:disconnect'),
  play: () => ipcRenderer.invoke('playback:play'),
  pause: () => ipcRenderer.invoke('playback:pause'),
  seek: (sec: number) => ipcRenderer.invoke('playback:seek', sec),
  setFullScreen: (on?: boolean) => ipcRenderer.invoke('window:fullscreen', on),
  onState: (cb: (s: Record<string, unknown>) => void) => {
    const h = (_e: unknown, s: Record<string, unknown>): void => cb(s)
    ipcRenderer.on('state', h)
    return () => ipcRenderer.off('state', h)
  }
}

contextBridge.exposeInMainWorld('cocine', api)
export type CocineApi = typeof api
