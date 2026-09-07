import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * The entire main-to-renderer surface. Hand-rolled over the shared types rather
 * than a typed-IPC framework -- it is small enough to read in one screen, and
 * nothing sits between the renderer and a latency problem.
 */
const api = {
  setVideoSlot: (slot: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('video:slot', slot),
  openFile: () => ipcRenderer.invoke('file:open'),
  openPath: (path: string) => ipcRenderer.invoke('file:openPath', path),
  /** Electron removed File.path; this is the supported way to recover a real
   *  filesystem path from a dropped file. */
  pathForFile: (f: File): string | null => {
    try { return webUtils.getPathForFile(f) } catch { return null }
  },
  connect: (o: { url: string; roomCode: string; name: string }) => ipcRenderer.invoke('room:connect', o),
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
