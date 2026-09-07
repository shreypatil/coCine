"use strict";
const electron = require("electron");
const api = {
  setVideoSlot: (slot) => electron.ipcRenderer.invoke("video:slot", slot),
  getIdentity: () => electron.ipcRenderer.invoke("identity:get"),
  listFilms: () => electron.ipcRenderer.invoke("films:list"),
  removeFilm: (infoHash) => electron.ipcRenderer.invoke("films:remove", infoHash),
  receiveFilm: (info) => electron.ipcRenderer.invoke("film:receive", info),
  openFile: () => electron.ipcRenderer.invoke("file:open"),
  openPath: (path) => electron.ipcRenderer.invoke("file:openPath", path),
  /** Electron removed File.path; this is the supported way to recover a real
   *  filesystem path from a dropped file. */
  pathForFile: (f) => {
    try {
      return electron.webUtils.getPathForFile(f);
    } catch {
      return null;
    }
  },
  connect: (o) => electron.ipcRenderer.invoke("room:connect", o),
  sendChat: (text) => electron.ipcRenderer.invoke("chat:send", text),
  setControl: (memberId, mayControl) => electron.ipcRenderer.invoke("member:setControl", memberId, mayControl),
  transferHost: (memberId) => electron.ipcRenderer.invoke("member:transferHost", memberId),
  disconnect: () => electron.ipcRenderer.invoke("room:disconnect"),
  play: () => electron.ipcRenderer.invoke("playback:play"),
  pause: () => electron.ipcRenderer.invoke("playback:pause"),
  seek: (sec) => electron.ipcRenderer.invoke("playback:seek", sec),
  setFullScreen: (on) => electron.ipcRenderer.invoke("window:fullscreen", on),
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    electron.ipcRenderer.on("state", h);
    return () => electron.ipcRenderer.off("state", h);
  }
};
electron.contextBridge.exposeInMainWorld("cocine", api);
