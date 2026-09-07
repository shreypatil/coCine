import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * The entire main-to-renderer surface. Hand-rolled over the shared types rather
 * than a typed-IPC framework -- it is small enough to read in one screen, and
 * nothing sits between the renderer and a latency problem.
 */
const api = {
  setVideoSlot: (slot: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('video:slot', slot),
  getIdentity: () => ipcRenderer.invoke('identity:get'),
  listFilms: () => ipcRenderer.invoke('films:list'),
  removeFilm: (infoHash: string) => ipcRenderer.invoke('films:remove', infoHash),
  receiveFilm: (info: unknown) => ipcRenderer.invoke('film:receive', info),
  openFile: () => ipcRenderer.invoke('file:open'),
  openPath: (path: string) => ipcRenderer.invoke('file:openPath', path),
  /** Electron removed File.path; this is the supported way to recover a real
   *  filesystem path from a dropped file. */
  pathForFile: (f: File): string | null => {
    try { return webUtils.getPathForFile(f) } catch { return null }
  },
  connect: (o: { url: string; code: string | null; name: string }) => ipcRenderer.invoke('room:connect', o),
  sendChat: (text: string) => ipcRenderer.invoke('chat:send', text),
  setControl: (memberId: string, mayControl: boolean) => ipcRenderer.invoke('member:setControl', memberId, mayControl),
  transferHost: (memberId: string) => ipcRenderer.invoke('member:transferHost', memberId),
  startAnyway: () => ipcRenderer.invoke('room:startAnyway'),
  setWaitForLatecomers: (wait: boolean) => ipcRenderer.invoke('room:setWaitForLatecomers', wait),
  setMode: (mode: 'p2p' | 'origin') => ipcRenderer.invoke('room:setMode', mode),
  releaseChatFocus: () => ipcRenderer.invoke('overlay:releaseFocus'),
  focusChat: () => ipcRenderer.invoke('overlay:focus'),
  onFocusChat: (h: () => void) => {
    const fn = (): void => h()
    ipcRenderer.on('overlay:focus', fn)
    return () => { ipcRenderer.removeListener('overlay:focus', fn) }
  },
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
