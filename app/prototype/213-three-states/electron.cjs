// PROTOTYPE (throwaway) shell for #213 — 真透明无边框窗承载 index.html
// 用途：真 Chromium 152 + 真透明窗上呈现 backdrop-filter 达标与否；便携双击版同文件。
const { app, BrowserWindow, ipcMain, globalShortcut } = require("electron");
const path = require("path");

const SELFCHECK = process.argv.includes("--selfcheck");

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 940, height: 250,
    frame: false, transparent: true, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false,
    show: !SELFCHECK,
    backgroundColor: "#00000000",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "index.html"), {
    search: "?electron=1" + (SELFCHECK ? "&selfcheck=1" : ""),
  });

  try {
    globalShortcut.register("Control+Alt+U", () => win.webContents.send("proto:hotkey"));
  } catch (e) {
    console.log("[proto213] Ctrl+Alt+U 注册失败（可能与运行中的主程序冲突）：" + e.message);
  }
  ipcMain.on("proto:passthrough", (_e, on) => win.setIgnoreMouseEvents(!!on, { forward: true }));
  ipcMain.on("proto:interactive", (_e, on) => win.setIgnoreMouseEvents(!on, { forward: !on && true }));
  ipcMain.on("proto:selfcheck", (_e, text) => {
    console.log("[proto213 selfcheck]\n" + text);
    app.quit();
  });
  if (SELFCHECK) setTimeout(() => { console.log("[proto213 selfcheck] 超时未回报"); app.quit(); }, 15000);
});
