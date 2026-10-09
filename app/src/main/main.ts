// Electron main process. Skeleton base (Phase 1 ticket): frameless
// always-on-top per-pixel translucent window, click-through with hotspot
// unlock (full state-flip path: renderer -> preload unlock-through -> main
// setClickThrough(false)), tray + context menu, global hotkey Ctrl+Alt+U,
// loopback WS placeholder, and the acceptance-harness scene orchestrator.
// Scenes (SKELETON_SCENE) are a test affordance for
// docs/ELECTRON-SKELETON-ACCEPTANCE.md, not product behavior.
//
// #204 display layer integration: the main process owns the headless overlay
// state machine (overlay.ts) - it loads real settings, feeds synthetic
// display payloads from wire frames, and pushes paint plans + the shared
// menu model (overlay-menu.ts, the equivalent of app.py's single QMenu
// shared by tray and overlay) to the renderer. Window geometry comes from
// settings in product mode; the six-scene acceptance keeps its 650x135
// stage whenever SKELETON_SCENE is set. Wire-frame to display-payload
// mapping is a skeleton transition shim kept ONLY for the acceptance
// scenes; product mode (no SKELETON_SCENE) runs the full stack since #206:
// the real protocol-v1 WSServer feeds an EventQueue, the Engine consumes it
// on the 50ms pump and drives the display layer on the 33ms tick, and
// /status projects engine + overlay + connection-tester state (the app.py
// App._status payload, 1:1).
import { app, BrowserWindow, Tray, Menu, dialog, globalShortcut, ipcMain, nativeImage } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { startSkeletonServer, type WireEvent } from "./ws-server.ts";
import * as S from "./settings.ts";
import {
  OverlayDisplay, apply_resize, edge_at,
  type Rect, type Pt, type ResizeEdge, type JsonRecord,
} from "./overlay.ts";
import { overlay_menu_model, type OverlayMenuAction, type OverlayMenuEntry } from "./overlay-menu.ts";
import { createDebugWindowHost } from "./debug-window-host.ts";
import { EventQueue, WSServer } from "./ws-server.ts";
import { Engine } from "./engine.ts";
import { TranslationCache } from "./queue-cache.ts";
import { ConnectionTester } from "./connection-test.ts";
import { startE2EControl } from "./e2e-control.ts";

const SCENE = process.env.SKELETON_SCENE || "base";
// Product mode = no SKELETON_SCENE in the environment (npm start / packaged
// run). Any scene value switches the acceptance-harness stage back on.
const SCENE_MODE = process.env.SKELETON_SCENE !== undefined;
// dist/main/main.js -> app root two levels up.
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOG_PATH = process.env.SKELETON_LOG || path.join(APP_ROOT, "skeleton.log");

function logLine(msg: string): void {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, Date.now() + " " + msg + "\n");
}

// ---- settings + overlay display state (the #204 port's owner) ----
const settings = S.load();
const display = new OverlayDisplay(settings as JsonRecord, {
  save: (cfg) => { S.save(cfg as S.Settings); },
  fieldSpec: (key) => {
    const f = S.field_by_path(["display", key]);
    // font_size / bg_opacity are int fields with non-null bounds in the
    // authority table (the Python int(field["min"]) would raise on null too).
    return {
      min: typeof f.min === "number" ? f.min : 0,
      max: typeof f.max === "number" ? f.max : 255,
      default: typeof f.default === "number" ? f.default : 0,
    };
  },
});

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let ctxMenu: Menu | null = null;
let clickThrough = false;

// #205: the settings/debug window host owns the headless DebugWindow model
// plus its single permanently-reused BrowserWindow. The menu entries land on
// different pages of the same instance (settings page / tuning page).
const debugHost = createDebugWindowHost({
  settings,
  overlay: display,
  appRoot: APP_ROOT,
  log: logLine,
});

function pushPlan(): void {
  win?.webContents.send("display-plan", display.paint_plan());
}

function pushMenuModel(): void {
  win?.webContents.send("menu-model", overlay_menu_model({
    overlay_visible: !!win?.isVisible(),
    click_through: clickThrough,
  }));
}

function templateFromModel(model: OverlayMenuEntry[]): MenuItemConstructorOptions[] {
  return model.map((it): MenuItemConstructorOptions => {
    if (it.kind === "separator") return { type: "separator" };
    if (it.checkable) {
      return { label: it.label, type: "checkbox", checked: it.checked, click: () => handleMenuAction(it.id) };
    }
    return { label: it.label, type: "normal", click: () => handleMenuAction(it.id) };
  });
}

function rebuildTrayMenu(): void {
  // Python mutates the texts of one shared QMenu; Electron menus are
  // immutable, so the shared thing is the MODEL - both consumers rebuild
  // from overlay_menu_model().
  ctxMenu = Menu.buildFromTemplate(templateFromModel(overlay_menu_model({
    overlay_visible: !!win?.isVisible(),
    click_through: clickThrough,
  })));
  tray?.setContextMenu(ctxMenu);
}

const MENU_IDS: ReadonlySet<string> = new Set<string>([
  "toggle-overlay", "cycle-mode", "swap-order", "font-up", "font-down",
  "bg-denser", "bg-lighter", "click-through", "open-settings", "open-debug", "quit",
]);

function handleMenuAction(idRaw: string): void {
  const w = win;
  if (!w) return;
  const id = idRaw as OverlayMenuAction;
  switch (id) {
    case "toggle-overlay": {
      if (w.isVisible()) w.hide(); else w.show();
      pushMenuModel();
      rebuildTrayMenu();     // visibility label flip (隐藏浮窗 <-> 显示浮窗)
      break;
    }
    case "cycle-mode": display.cycle_mode(); pushPlan(); break;
    case "swap-order": display.swap_order(); pushPlan(); break;
    case "font-up": display.nudge_font(1); pushPlan(); break;
    case "font-down": display.nudge_font(-1); pushPlan(); break;
    case "bg-denser": display.nudge_opacity(25); pushPlan(); break;
    case "bg-lighter": display.nudge_opacity(-25); pushPlan(); break;
    case "click-through": setClickThrough(!clickThrough); break;
    case "open-settings":
      // One window, two entries (settings page vs tuning page); the Python
      // unlock-before-open guard ships with the window host (#205).
      logLine("[menu] open-settings -> debug window (settings page)");
      debugHost.open("settings");
      break;
    case "open-debug":
      logLine("[menu] open-debug -> debug window (tuning page)");
      debugHost.open("tuning");
      break;
    case "quit": app.quit(); break;
  }
}

function setClickThrough(on: boolean): void {
  const w = win;
  if (!w) return;
  // forward:true keeps mousemove flowing to the page while click-through is
  // on, so the renderer can flip the unlock-icon hotspot back to clickable.
  w.setIgnoreMouseEvents(on, { forward: true });
  w.webContents.send("click-through", on);
  clickThrough = on;
  logLine("set_click_through " + on);
  pushMenuModel();
  rebuildTrayMenu();         // click-through label + checked flip, like _set_click_through
}

// ---- wire frames -> synthetic display payloads (transition shim, #206 owns the engine) ----
let lastTitle = "";

function wireToDisplay(ev: WireEvent): void {
  if (ev.type === "register") {
    lastTitle = typeof ev.tab_title === "string" ? ev.tab_title : "";
    display.set_display({ state: "no_cues", trans_state: "waiting", trans_available: true, title: lastTitle });
  } else if (ev.type === "cues") {
    const list = Array.isArray(ev.cues) ? ev.cues : [];
    const last = list.length ? list[list.length - 1] : null;
    const text = last && typeof last === "object" && typeof (last as { text?: unknown }).text === "string"
      ? (last as { text: string }).text
      : "";
    display.set_display({ state: "ok", orig: text, trans: "", trans_available: false, playing: true, title: lastTitle });
  } else if (ev.type === "sync") {
    display.set_display({
      state: "ok", orig: display.orig_text, trans: display.trans_text,
      trans_available: display.trans_available, playing: ev.playing === true,
    });
  } else if (ev.type === "deactivate") {
    lastTitle = "";
    display.set_display({ state: "no_cues", trans_state: "waiting", trans_available: true });
  }
  pushPlan();
}

// ---- drag + 8-edge resize machine (renderer forwards raw mouse events) ----
type MouseEvt = { type?: unknown; x?: unknown; y?: unknown; gx?: unknown; gy?: unknown };

function numOr(v: unknown, d: number): number {
  return typeof v === "number" ? v : d;
}

let drag: { pos: Pt; global: Pt; geom: Rect; resizing: boolean; edge: ResizeEdge } | null = null;
let lastCursor = "";

function cursorFor(edge: ResizeEdge | null): string {
  switch (edge) {
    case "t": case "b": return "ns-resize";
    case "l": case "r": return "ew-resize";
    case "tl": case "br": return "nwse-resize";
    case "tr": case "bl": return "nesw-resize";
    default: return "";
  }
}

function setCursor(name: string): void {
  if (name !== lastCursor) {
    lastCursor = name;
    win?.webContents.send("overlay-cursor", name);
  }
}

function persistGeometry(w: BrowserWindow): void {
  // _persist_geometry: window x/y/w/h into settings + save, try/except.
  const b = w.getBounds();
  let wi = settings["window"];
  if (wi === null || typeof wi !== "object" || Array.isArray(wi)) {
    wi = {};
    settings["window"] = wi;
  }
  const rec = wi as JsonRecord;
  rec["x"] = b.x;
  rec["y"] = b.y;
  rec["w"] = b.width;
  rec["h"] = b.height;
  try {
    S.save(settings);
  } catch {
    // OSError: pass
  }
}

ipcMain.on("overlay-mouse", (_e, raw: unknown) => {
  const w = win;
  if (!w) return;
  const ev = (raw ?? {}) as MouseEvt;
  const type = typeof ev.type === "string" ? ev.type : "";
  if (type === "press") {
    const b = w.getBounds();
    const x = numOr(ev.x, 0), y = numOr(ev.y, 0);
    const gx = numOr(ev.gx, 0), gy = numOr(ev.gy, 0);
    const edge = edge_at(x, y, b.width, b.height); // latch edge at press
    drag = {
      pos: { x: gx - b.x, y: gy - b.y },
      global: { x: gx, y: gy },
      geom: { x: b.x, y: b.y, w: b.width, h: b.height },
      resizing: edge !== null,
      edge: edge ?? "r",
    };
    setCursor("");            // arrow while dragging, like Qt's default
  } else if (type === "move") {
    const gx = numOr(ev.gx, 0), gy = numOr(ev.gy, 0);
    if (!drag) {
      const b = w.getBounds();
      setCursor(cursorFor(edge_at(numOr(ev.x, 0), numOr(ev.y, 0), b.width, b.height)));
      return;
    }
    if (drag.resizing) {
      // edge latched at press: dragging inward past the margin must keep resizing
      w.setBounds(apply_resize(drag.edge, { x: gx, y: gy }, drag.geom, drag.global));
    } else {
      w.setPosition(gx - drag.pos.x, gy - drag.pos.y);
    }
  } else if (type === "release") {
    if (drag) {
      drag = null;
      persistGeometry(w);
    }
  }
});

ipcMain.on("menu-action", (_e, id: unknown) => {
  if (typeof id === "string" && MENU_IDS.has(id)) handleMenuAction(id);
});
// #205 debug window: renderer intents (edits / page switch / save / close...).
ipcMain.on("debug-intent", (_e, raw: unknown) => debugHost.handleIntent(raw));

function createWindow(geo: { width: number; height: number; x?: number; y?: number }): void {
  win = new BrowserWindow({
    ...geo,
    // Browser E2E drives the app purely through /status (black box); the
    // hidden window keeps unattended runs desktop-safe (the #193 decision
    // bans visible GUI automation on the maintainer's machine).
    show: process.env.YOUTUBESUB_E2E_OFFSCREEN !== "1",
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
  // Diagnostics: a sandboxed preload that fails to load leaves the page with
  // no bridge at all, which shows up only as silence in the renderer logs.
  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    logLine("[main] preload-error " + preloadPath + " : " + error.message);
  });
  win.webContents.on("did-fail-load", (_e, code, desc) => {
    logLine("[main] did-fail-load " + code + " " + desc);
  });
  win.webContents.once("did-finish-load", () => {
    logLine("[main] did-finish-load");
    pushPlan();              // initial plan (defaults: empty rows, clean status)
    pushMenuModel();         // initial shared menu model for the DOM menu
    void win?.webContents.executeJavaScript(
      "typeof window.youtubesub === 'object' ? Object.keys(window.youtubesub).join(',') : ('MISSING:' + typeof window.youtubesub)",
    ).then((r: unknown) => logLine("[main] bridge probe => " + String(r)))
      .catch((e: unknown) => logLine("[main] bridge probe failed: " + String(e)));
  });
  void win.loadFile(path.join(APP_ROOT, "dist", "renderer", "index.html"));
}

// ---- #206: the product stack - protocol v1 WSServer -> Engine -> display ----
// app.py App.__init__/run() 1:1: the ConnectionTester lives once and reports
// through /status; frames land in a bounded queue; the pump drains it into
// the engine (50ms, capped rounds leaving the remainder queued), the tick
// drives the display layer (33ms), and a 5s pulse re-asserts topmost while
// the window is visible and not click-through.
async function startProductStack(): Promise<void> {
  // The cache default lives beside the app (app/data/translations.db, the
  // TS-stack equivalent of the repo-root data dir); YOUTUBESUB_DATA_DIR
  // relocates it (portable installs, E2E isolation under a private APPDATA).
  const dataDir = process.env.YOUTUBESUB_DATA_DIR;
  const cache = new TranslationCache(dataDir ? path.join(dataDir, "translations.db") : null);
  const engine = new Engine(settings as unknown as Record<string, unknown>, cache);
  const evq = new EventQueue(2000);
  const tester = new ConnectionTester();

  // App._status: engine.status() flattened + overlay state bits.
  function statusPayload(): Record<string, unknown> {
    const s = engine.status() as {
      sources?: unknown;
      active_source?: unknown;
      display?: Record<string, unknown>;
    };
    const d = (s.display ?? {}) as Record<string, unknown>;
    return {
      state: typeof d.state === "string" ? d.state : "",
      orig: typeof d.orig === "string" ? d.orig : "",
      trans: typeof d.trans === "string" ? d.trans : "",
      trans_state: typeof d.trans_state === "string" && d.trans_state ? d.trans_state : "idle",
      trans_available: d.trans_available === true,
      playing: d.playing === undefined || d.playing === null ? null : d.playing,
      rate: d.rate === undefined || d.rate === null ? null : d.rate,
      title: typeof d.title === "string" ? d.title : "",
      video_description: typeof d.video_description === "string" ? d.video_description : "",
      hook_error: typeof d.hook_error === "string" ? d.hook_error : "",
      capture_error: typeof d.capture_error === "string" ? d.capture_error : "",
      sources: typeof s.sources === "number" ? s.sources : 0,
      active_source: (s.active_source ?? null) as unknown,
      mode: display.mode,
      order: display.order,
      history: display.history.map((p) => [p[0], p[1]]),
      click_through: clickThrough,
    };
  }

  const secRaw = settings["server"];
  const sec = (secRaw && typeof secRaw === "object" && !Array.isArray(secRaw) ? secRaw : {}) as JsonRecord;
  const port = typeof sec["port"] === "number" && sec["port"] ? Math.trunc(sec["port"]) : 9877;
  const server = new WSServer(port, evq, {
    // app.py: payload.update(tester.status_payload()) - {} when never run.
    status_provider: () => Object.assign(statusPayload(), tester.status_payload()),
  });
  try {
    await server.start();
    logLine("[ws] listening on 127.0.0.1:" + port + " (protocol v1)");
  } catch (e) {
    // server.py raises at boot -> the app dies with an error dialog.
    logLine("[ws] start failed: " + String(e));
    dialog.showErrorBox("字幕浮窗启动失败", String((e as Error).message ?? e));
    app.quit();
    return;
  }

  // App._pump: drain the queue into the engine; a capped round leaves the
  // remainder for the next beat (Python breaks at n > 500, keeping order).
  const pump = setInterval(() => {
    const evs = evq.drain();
    let n = 0;
    for (const ev of evs) {
      if (n >= 501) {
        evq.put(ev);   // requeue the rest; drain() emptied the queue first
        continue;
      }
      engine.handle_event(ev);
      n++;
    }
  }, 50);

  // App._tick: d = engine.tick(); if d: overlay.set_display(d).
  const tick = setInterval(() => {
    const d = engine.tick() as Record<string, unknown> | null;
    if (d) {
      display.set_display(d as unknown as Parameters<typeof display.set_display>[0]);
      pushPlan();
    }
  }, 33);

  // App._topmost -> overlay.pulse_topmost: hidden or click-through windows
  // are never re-pinned.
  const topmost = setInterval(() => {
    const w = win;
    if (w && w.isVisible() && !clickThrough) {
      w.setAlwaysOnTop(true);
      w.moveTop();
    }
  }, 5000);

  // e2e_app.py port: the mode/provider control surface (env-gated).
  if (process.env.YOUTUBESUB_E2E_MODE_PORT) {
    startE2EControl({ engine, display, pushPlan, log: logLine })
      .then((p) => logLine("[e2e] mode control on 127.0.0.1:" + p))
      .catch((e: unknown) => logLine("[e2e] control start failed: " + String(e)));
  }

  app.on("before-quit", () => {
    clearInterval(pump);
    clearInterval(tick);
    clearInterval(topmost);
    void server.stop();
  });
}

app.whenReady().then(() => {
  logLine("scene=" + SCENE + " boot");
  if (SCENE_MODE) {
    // Acceptance-harness stage: fixed 650x135 + env placement (evidence
    // parity with the six-scene screenshots).
    createWindow({
      width: 650,
      height: 135,
      x: parseInt(process.env.SKELETON_X || "100", 10),
      y: parseInt(process.env.SKELETON_Y || "100", 10),
    });
  } else {
    // Product geometry: settings window section, with the "or 650/135"
    // fallbacks and move-only-when-x-is-set exactly like __init__.
    const wsecRaw = settings["window"];
    const wsec = (wsecRaw && typeof wsecRaw === "object" && !Array.isArray(wsecRaw) ? wsecRaw : {}) as JsonRecord;
    const geo: { width: number; height: number; x?: number; y?: number } = {
      width: typeof wsec["w"] === "number" && wsec["w"] ? Math.trunc(wsec["w"]) : 650,
      height: typeof wsec["h"] === "number" && wsec["h"] ? Math.trunc(wsec["h"]) : 135,
    };
    if (typeof wsec["x"] === "number") geo.x = Math.trunc(wsec["x"]);
    if (typeof wsec["y"] === "number") geo.y = Math.trunc(wsec["y"]);
    createWindow(geo);
  }

  // Capability 5: loopback WS service on 9877. Scenes keep the skeleton
  // server + wire shim (the acceptance stage); product mode runs the full
  // stack - real protocol-v1 server -> Engine -> display (#206).
  if (SCENE_MODE) {
    startSkeletonServer(9877, {
      onFrame: (ev: WireEvent) => {
        win?.webContents.send("ws-frame", ev);
        wireToDisplay(ev);      // #204: frames feed the real display layer now
      },
      onLog: (m: string) => logLine("[ws] " + m),
    });
  } else {
    void startProductStack();
  }

  // Capability 4: global hotkey Ctrl+Alt+U = unlock click-through.
  const hkOk = globalShortcut.register("Control+Alt+U", () => {
    logLine("hotkey fired Control+Alt+U -> click_through off");
    setClickThrough(false);
  });
  logLine('globalShortcut.register("Control+Alt+U") => ' + hkOk +
    (hkOk ? "" : "  (RegisterHotKey conflict; GetAsyncKeyState polling has no such failure mode)"));

  // Capability 3: tray + context menu. The menu is the full #172 model
  // (shared with the overlay's DOM context menu); the skeleton header entry
  // is gone and the entry set is a superset - A3.1 popup/closed logging and
  // A3.2 semantics (checkable 穿透, 退出) are unchanged.
  const iconPath = path.join(APP_ROOT, "assets", "tray.png");
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("YouTube 字幕浮窗");
  rebuildTrayMenu();
  tray.on("double-click", () => {
    // _tray_activated: double-click restores a hidden overlay.
    const w = win;
    if (w && !w.isVisible()) w.show();
    logLine("tray double-click -> show");
  });

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
          const b = w.getBounds();   // hotspot center from live bounds (CSS right/bottom 8 + margins)
          const hx = b.width - 33, hy = b.height - 33;
          setTimeout(() => {
            logLine("[main] synthetic mousemove -> hotspot");
            w.webContents.sendInputEvent({ type: "mouseEnter", x: hx, y: hy });
            w.webContents.sendInputEvent({ type: "mouseMove", x: hx, y: hy });
          }, 2500);
          setTimeout(() => {
            logLine("[main] synthetic mousemove -> center");
            w.webContents.sendInputEvent({ type: "mouseMove", x: Math.trunc(b.width / 2), y: Math.trunc(b.height / 2) });
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
        t.popUpContextMenu(ctxMenu!);   // blocks until the menu closes
        logLine("tray menu closed");
        // Unattended sessions dismiss tray-anchored menus in <200ms (no
        // foreground activation); pop once more anchored to the overlay
        // window so the visual evidence shot can catch it.
        setTimeout(() => {
          logLine("menu popup (window-anchored)");
          ctxMenu!.popup(win ? { window: win, x: 20, y: 140 } : { x: 20, y: 140 });
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
app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  // A pending debug-window close prompt must never block quitting (#205).
  debugHost.markQuitting();
});
