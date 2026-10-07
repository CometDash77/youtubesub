const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("capcheck", {
  onClickThrough: (cb) => ipcRenderer.on("click-through", (e, on) => cb(on)),
  onWsFrame: (cb) => ipcRenderer.on("ws-frame", (e, f) => cb(f)),
  setIgnore: (on) => ipcRenderer.invoke("set-ignore", on),
  rendererLog: (m) => ipcRenderer.send("renderer-log", m)
});
