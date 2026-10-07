// Electron desktop skeleton (Phase 1 ticket): first assembly of the six
// capabilities on the app/ toolchain - frameless always-on-top per-pixel
// translucent window, click-through with hotspot unlock (full state-flip
// path: renderer -> preload unlock-through -> main setClickThrough(false)),
// tray + context menu, global hotkey Ctrl+Alt+U, loopback WS placeholder,
// and the acceptance-harness scene orchestrator. Scenes (SKELETON_SCENE) are
// a test affordance for docs/ELECTRON-SKELETON-ACCEPTANCE.md, not product
// behavior; the product protocol service arrives with its own ticket.
import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { startSkeletonServer, type WireEvent } from "./ws-server.js";

const SCENE = process.env.SKELETON_SCENE || "base";
// dist/main/main.js -> app root two levels up.
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOG_PATH = process.env.SKELETON_LOG || path.join(APP_ROOT, "skeleton.log");

function logLine(msg: string): void {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, Date.now() + " " + msg + "\n");
}

let win: BrowserWindow | null = null;
let tray: Tray | null = null;

function setClickThrough(on: boolean): void {
  const w = win;
  if (!w) return;
  // forward:true keeps mousemove flowing to the page while click-through is
  // on, so the renderer can flip the unlock-icon hotspot back to clickable.
  w.setIgnoreMouseEvents(on, { forward: true });
  w.webContents.send("click-through", on);
  logLine("set_click_through " + on);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 650,
    height: 135,
    x: parseInt(process.env.SKELETON_X || "100", 10),
    y: parseInt(process.env.SKELETON_Y || "100", 10),
    frame: false,        // capability 1: frameless
    transparent: true,   // capability 1: per-pixel translucency (renderer rgba)
    alwaysOnTop: true,   // capability 1: topmost
    skipTaskbar: true,
    resizable: true,
    title: "youtubesub-overlay",
    webPreferences: {
      preload: path.join(APP_ROOT, "dist", "preload", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  void win.loadFile(path.join(APP_ROOT, "dist", "renderer", "index.html"));
}

app.whenReady().then(() => {
  logLine("scene=" + SCENE + " boot");
  createWindow();

  // Capability 5: loopback WS placeholder (production port 9877).
  startSkeletonServer(9877, {
    onFrame: (ev: WireEvent) => { win?.webContents.send("ws-frame", ev); },
    onLog: (m: string) => logLine("[ws] " + m),
  });

  // Capability 4: global hotkey Ctrl+Alt+U = unlock click-through.
  const hkOk = globalShortcut.register("Control+Alt+U", () => {
    logLine("hotkey fired Control+Alt+U -> click_through off");
    setClickThrough(false);
  });
  logLine('globalShortcut.register("Control+Alt+U") => ' + hkOk +
    (hkOk ? "" : "  (RegisterHotKey conflict; GetAsyncKeyState polling has no such failure mode)"));

  // Capability 3: tray + context menu (toggle click-through, quit, restore).
  const iconPath = path.join(APP_ROOT, "assets", "tray.png");
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("YouTube 字幕浮窗");
  const ctxMenu = Menu.buildFromTemplate([
    { label: "字幕浮窗（骨架）", enabled: false },
    { type: "separator" },
    { id: "ct", label: "鼠标穿透", type: "checkbox", checked: false,
      click: (item) => setClickThrough(item.checked) },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
  tray.setContextMenu(ctxMenu);
  tray.on("double-click", () => { win?.show(); logLine("tray double-click -> show"); });

  // Scene orchestration (timings the acceptance harness aligns to).
  if (SCENE === "clickthrough" || SCENE === "hotkey") {
    setTimeout(() => setClickThrough(true), 3000);
  }
  if (SCENE === "hover-unlock") {
    const w = win;
    if (w) {
      // All three verdict points land in click-through state. Runner sessions
      // never deliver forwarded OS mousemoves, so the main process drives the
      // renderer unlock chain with synthetic mousemoves (proven by #193 CI).
      w.webContents.once("did-finish-load", () => {
        setTimeout(() => {
          setClickThrough(true);
          const hx = 650 - 33, hy = 135 - 33;   // hotspot center (CSS right/bottom 8 + margins)
          setTimeout(() => {
            logLine("[main] synthetic mousemove -> hotspot");
            w.webContents.sendInputEvent({ type: "mouseEnter", x: hx, y: hy });
            w.webContents.sendInputEvent({ type: "mouseMove", x: hx, y: hy });
          }, 2500);
          setTimeout(() => {
            logLine("[main] synthetic mousemove -> center");
            w.webContents.sendInputEvent({ type: "mouseMove", x: 325, y: 67 });
          }, 8000);
        }, 500);
      });
    }
  }
  if (SCENE === "tray-menu") {
    const t = tray;
    if (t) {
      setTimeout(() => {
        logLine("tray popUpContextMenu (tray-anchored)");
        t.popUpContextMenu(ctxMenu);   // blocks until the menu closes
        logLine("tray menu closed");
        // Unattended sessions dismiss tray-anchored menus in <200ms (no
        // foreground activation); pop once more anchored to the overlay
        // window so the visual evidence shot can catch it.
        setTimeout(() => {
          logLine("menu popup (window-anchored)");
          ctxMenu.popup(win ? { window: win, x: 20, y: 140 } : { x: 20, y: 140 });
          logLine("menu popup closed");
        }, 1500);
      }, 6000);
    }
  }
});

// Renderer hotspot verdict: hot=true -> window locally clickable.
ipcMain.handle("set-ignore", (_e, on: unknown) => {
  logLine("[renderer] set-ignore " + !!on);
  win?.setIgnoreMouseEvents(!!on, { forward: true });
  return true;
});
// Full state-flip unlock path (same route as the hotkey), per #195.
ipcMain.on("unlock-through", () => { logLine("[renderer] unlock-through"); setClickThrough(false); });
ipcMain.on("renderer-log", (_e, m: unknown) => logLine("[renderer] " + String(m)));

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => globalShortcut.unregisterAll());