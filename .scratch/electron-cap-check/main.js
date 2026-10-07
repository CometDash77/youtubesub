// Electron 五能力真机验证（throwaway，wayfinder：Electron 五能力真机验证）。
// 场景经 CAPCHECK_SCENE 切换：base | clickthrough | hover-unlock | tray-menu | hotkey | ws
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const { startCapcheckServer } = require("./ws-server");

const SCENE = process.env.CAPCHECK_SCENE || "base";
const EVIDENCE = path.join(__dirname, "evidence");

function logLine(msg) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.appendFileSync(path.join(EVIDENCE, "hotkey.log"), Date.now() + " " + msg + "\n");
}

let win;
let tray;

function setClickThrough(on) {
  // forward:true 让 Windows 下页面在穿透态仍收到 mousemove，渲染层才能把
  // 解锁图标热区切回可点（对应浮窗穿透态解锁方案的 Electron 路径）。
  win.setIgnoreMouseEvents(on, { forward: true });
  win.webContents.send("click-through", on);
  logLine("set_click_through " + on);
}

function createWindow() {
  win = new BrowserWindow({
    width: 650,
    height: 135,
    x: parseInt(process.env.CAPCHECK_X || "100", 10),
    y: parseInt(process.env.CAPCHECK_Y || "100", 10),
    frame: false,        // ① 无边框
    transparent: true,   // ① 逐像素半透明（renderer rgba 合成）
    alwaysOnTop: true,   // ① 置顶
    skipTaskbar: true,
    resizable: true,     // 实测 transparent + resizable 组合行为（坑位候选）
    title: "capcheck-overlay",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile("index.html");
}

app.whenReady().then(() => {
  logLine("scene=" + SCENE + " boot");
  createWindow();

  // ⑤ 本地 WS：协议 v1 语义复刻，端口与生产一致（9877，启动前实测空闲）。
  startCapcheckServer(9877, {
    onFrame: (ev) => { if (win) win.webContents.send("ws-frame", ev); },
    onLog: (m) => logLine("[ws] " + m)
  });

  // ④ 全局热键 Ctrl+Alt+U = 穿透解锁（语义同 PySide6 ComboWatcher 轮询）。
  const hkOk = globalShortcut.register("Control+Alt+U", () => {
    logLine("hotkey fired Control+Alt+U -> click_through off");
    setClickThrough(false);
  });
  logLine('globalShortcut.register("Control+Alt+U") => ' + hkOk +
    (hkOk ? "" : "  (RegisterHotKey conflict; GetAsyncKeyState polling has no such failure mode)"));

  // ③ 托盘 + 右键菜单（语义同现状：穿透切换 + 退出 + 双击恢复）。
  const iconPath = path.join(__dirname, "tray.png");
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("YouTube 字幕浮窗");
  const ctxMenu = Menu.buildFromTemplate([
    { label: "字幕浮窗（capcheck）", enabled: false },
    { type: "separator" },
    { id: "ct", label: "鼠标穿透", type: "checkbox", checked: false,
      click: (item) => setClickThrough(item.checked) },
    { type: "separator" },
    { label: "退出", click: () => app.quit() }
  ]);
  tray.setContextMenu(ctxMenu);
  tray.on("double-click", () => { win.show(); logLine("tray double-click -> show"); });

  // 场景编排（穿透 3s 后开启，外部取证脚本按此时序对齐）。
  if (SCENE === "clickthrough" || SCENE === "hover-unlock" || SCENE === "hotkey") {
    setTimeout(() => setClickThrough(true), 3000);
  }
  if (SCENE === "tray-menu") {
    setTimeout(() => { logLine("tray popUpContextMenu"); tray.popUpContextMenu(ctxMenu); }, 5000);
  }
});

// 渲染层热区检测回调：hot=true 时窗口局部可点。
ipcMain.handle("set-ignore", (e, on) => { logLine("[renderer] set-ignore " + !!on); win.setIgnoreMouseEvents(!!on, { forward: true }); return true; });
ipcMain.on("renderer-log", (e, m) => logLine("[renderer] " + m));

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => globalShortcut.unregisterAll());
