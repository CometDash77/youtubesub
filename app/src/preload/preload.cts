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
  // #204 display layer: main owns the headless overlay state machine and
  // pushes ready-to-render paint plans + the shared menu model; the renderer
  // stays a dumb applier plus DOM-only hotspot/menu/mouse plumbing.
  onDisplayPlan: (cb: (plan: unknown) => void) => ipcRenderer.on("display-plan", (_e, p) => cb(p)),
  onMenuModel: (cb: (model: unknown) => void) => ipcRenderer.on("menu-model", (_e, m) => cb(m)),
  menuAction: (id: string) => ipcRenderer.send("menu-action", id),
  overlayMouse: (ev: unknown) => ipcRenderer.send("overlay-mouse", ev),
  onOverlayCursor: (cb: (cursor: string) => void) => ipcRenderer.on("overlay-cursor", (_e, c) => cb(c)),
  // #205 settings/debug window: the headless model pushes ready-to-render
  // state; the renderer forwards user intents back. Same applier contract as
  // the overlay's paint-plan bridge.
  onDebugState: (cb: (s: unknown) => void) => ipcRenderer.on("debug-state", (_e, s) => cb(s)),
  debugIntent: (intent: unknown) => ipcRenderer.send("debug-intent", intent),
  onDebugCopyText: (cb: (t: string) => void) => ipcRenderer.on("debug-copy-text", (_e, t) => cb(t)),
});