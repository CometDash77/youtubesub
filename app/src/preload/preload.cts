// Sandbox preload: CJS only - Electron sandboxed preloads cannot load ESM,
// so this file is .cts and compiles to dist/preload/preload.cjs. Exposes the
// narrow renderer bridge; the unlock route goes through unlock-through ->
// main setClickThrough(false) (full state flip, per #195), never a bare
// setIgnore(false) on the mouse layer.
import electron = require("electron");
const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("youtubesub", {
  onClickThrough: (cb: (on: boolean) => void) => ipcRenderer.on("click-through", (_e, on) => cb(on)),
  onWsFrame: (cb: (frame: unknown) => void) => ipcRenderer.on("ws-frame", (_e, f) => cb(f)),
  setIgnore: (on: boolean) => ipcRenderer.invoke("set-ignore", on),
  unlockThrough: () => ipcRenderer.send("unlock-through"),
  rendererLog: (m: string) => ipcRenderer.send("renderer-log", m),
});