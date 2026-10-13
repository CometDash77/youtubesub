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
import { app, BrowserWindow, Tray, Menu, dialog, globalShortcut, ipcMain, nativeImage, screen } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { startSkeletonServer, type WireEvent } from "./ws-server.ts";
import * as S from "./settings.ts";
import {
  OverlayDisplay, apply_resize, edge_at, bar_geometry, BAR_HEIGHT, BAR_MIN_WIDTH,
  type Rect, type Pt, type ResizeEdge, type JsonRecord,
} from "./overlay.ts";
import { overlay_menu_model, type OverlayMenuAction, type OverlayMenuEntry } from "./overlay-menu.ts";
import { createDebugWindowHost } from "./debug-window-host.ts";
import { EventQueue, WSServer } from "./ws-server.ts";
import { COMMAND_TYPES } from "./protocol.ts";
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
// #217 control-bar command route: the IPC handler (registered below, before
// the stack starts) forwards to these once the product stack exists; before
// that (and in scene mode) the bar is a no-op.
let productEngine: Engine | null = null;
let productServer: WSServer | null = null;
// #211 freeze input from the renderer's DOM context menu (the drag half of
// the freeze lives in the drag machine below).
let overlayMenuOpen = false;
// #226 spec §1: the external control-bar window (second window). Created only
// by the product stack; scene mode never creates it.
let barWin: BrowserWindow | null = null;
let barInteractive = false;
// #226 spec §3/§4: two hover positions (overlay window + bar window), the
// grace timer lives HERE in main; the ping timer is the passthrough keep-alive.
let overlayHovering = false;
let barHovering = false;
let hoverGraceTimer: NodeJS.Timeout | null = null;
let hoverPingTimer: NodeJS.Timeout | null = null;

// #205: the settings/debug window host owns the headless DebugWindow model
// plus its single permanently-reused BrowserWindow. The menu entries land on
// different pages of the same instance (settings page / tuning page).
const debugHost = createDebugWindowHost({
  settings,
  // #222: the animation values ride paint_plan (read per paint); after a save
  // that touched notify_overlay fields, push a fresh plan so the overlay
  // picks up the new CSS variables on the spot (no restart).
  overlay: {
    reread_settings: () => {
      display.reread_settings();
      pushPlan();
    },
  },
  appRoot: APP_ROOT,
  log: logLine,
});

// #226: last plan's bar-relevant bits (what should be visible on the bar).
let barOn = false;      // controls state: title + control row visible
let lockOn = false;     // passthrough + hover: unlock lock visible

function pushPlan(): void {
  const plan = display.paint_plan();
  win?.webContents.send("display-plan", plan);
  barWin?.webContents.send("display-plan", plan);
  barOn = plan.state === "controls";
  lockOn = plan.state === "passthrough" && plan.overlay_hover;
  syncBarInteractivity();
}

// spec §1: main-side interaction gate. The bar window is interactive only
// while something is visible on it (controls bar, or the passthrough lock);
// otherwise ignore+forward keeps it click-through (and its renderer keeps
// reporting no hover while invisible - double gating).
function syncBarInteractivity(): void {
  const bw = barWin;
  if (!bw) return;
  const interactive = barOn || lockOn;
  if (interactive === barInteractive) return;
  barInteractive = interactive;
  bw.setIgnoreMouseEvents(!interactive, { forward: true });
  logLine("[bar] interactive " + interactive);
}

// #226 spec §3: the grace timer lives in MAIN (two hover positions). Any
// position true -> clear the timer + hover on; both false -> wait fade_delay
// seconds before hover off; a re-enter during the wait cancels it. The CSS
// leave transition carries no delay, so there is exactly one wait.
function fadeDelayMs(): number {
  const a = settings["anim"];
  const node = (a !== null && typeof a === "object" && !Array.isArray(a) ? a : {}) as JsonRecord;
  const v = node["fade_delay"];
  const d = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1.2;
  return Math.round(d * 1000);
}

function reevaluateHover(): void {
  if (overlayHovering || barHovering) {
    if (hoverGraceTimer !== null) { clearTimeout(hoverGraceTimer); hoverGraceTimer = null; }
    display.set_overlay_hover(true);
    pushPlan();
  } else if (hoverGraceTimer === null) {
    hoverGraceTimer = setTimeout(() => {
      hoverGraceTimer = null;
      if (!overlayHovering && !barHovering) {
        display.set_overlay_hover(false);
        pushPlan();
      }
    }, fadeDelayMs());
  }
}

function clearHoverTimers(): void {
  if (hoverGraceTimer !== null) { clearTimeout(hoverGraceTimer); hoverGraceTimer = null; }
  if (hoverPingTimer !== null) { clearTimeout(hoverPingTimer); hoverPingTimer = null; }
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
  "bg-denser", "bg-lighter", "click-through", "open-settings", "quit",
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
      // #209 Q1 ruling: ONE menu entry. It opens the settings/debug window on
      // the settings page; tuning/diag stay reachable via the in-window tabs.
      logLine("[menu] open-settings -> debug window (settings page)");
      debugHost.open("settings");
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
  // #226 spec §3/§4: explicit flips reset the two-position hover bookkeeping
  // (stale claims die with the mode change; the renderers re-enter fresh).
  clearHoverTimers();
  overlayHovering = false;
  barHovering = false;
  // #217: the same flip feeds the three-state machine (passthrough in,
  // unlock back to subtitles) and pushes a plan so the renderer fades
  // immediately instead of waiting for the next tick.
  display.set_overlay_click_through(on);
  pushPlan();
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

ipcMain.on("overlay-mouse", (e, raw: unknown) => {
  const w = win;
  if (!w) return;
  const fromBar = barWin !== null && e.sender === barWin.webContents;
  const ev = (raw ?? {}) as MouseEvt;
  const type = typeof ev.type === "string" ? ev.type : "";
  if (type === "press") {
    const b = w.getBounds();
    // #226 spec §7: a bar-sourced press (title-row drag) reports px/py in BAR
    // coordinates; rewrite them to the overlay's interior so edge_at sees no
    // edge and the press becomes a plain window drag. gx/gy stay real: the
    // drag machine moves the overlay rigidly with the cursor. (spec said
    // "py >= h makes edge_at return null", but the bottom band actually
    // matches edge_at - the rewrite is the faithful implementation of the
    // intent; recorded on the ticket.)
    const x = fromBar ? b.width / 2 : numOr(ev.x, 0);
    const y = fromBar ? b.height / 2 : numOr(ev.y, 0);
    const gx = numOr(ev.gx, 0), gy = numOr(ev.gy, 0);
    const edge = edge_at(x, y, b.width, b.height); // latch edge at press
    drag = {
      pos: { x: gx - b.x, y: gy - b.y },
      global: { x: gx, y: gy },
      geom: { x: b.x, y: b.y, w: b.width, h: b.height },
      resizing: edge !== null,
      edge: edge ?? "r",
    };
    // #211 exception freeze: auto transitions hold while drag/resize runs,
    // so a fast cursor cannot fade the controls out mid-gesture.
    display.set_overlay_frozen(true);
    pushPlan();
    setCursor("");            // arrow while dragging, like Qt's default
  } else if (type === "move") {
    const gx = numOr(ev.gx, 0), gy = numOr(ev.gy, 0);
    if (!drag) {
      if (fromBar) return;   // no resize-cursor feedback through the bar window
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
      // Unfreeze: the state re-derives from the last hover event (a cursor
      // pushed outside during a resize then lands back on subtitles).
      display.set_overlay_frozen(overlayMenuOpen);
      pushPlan();
    }
  }
});

ipcMain.on("menu-action", (_e, id: unknown) => {
  if (typeof id === "string" && MENU_IDS.has(id)) handleMenuAction(id);
});

// #217 three-state wiring, #226 spec §3/§4: still ONE "overlay-hover" IPC
// channel, now carrying two hover positions (overlay + bar), told apart by
// e.sender. The grace timer lives in main (reevaluateHover); an overlay-sourced
// report while click-through is the ct keep-alive ping (re-arms fade_delay).
ipcMain.on("overlay-hover", (e, hovering: unknown) => {
  const fromBar = barWin !== null && e.sender === barWin.webContents;
  const on = hovering === true;
  if (!fromBar && clickThrough) {
    // Ping semantics: keep the claim alive and re-arm the expiry timer; when
    // it expires with no further pings (and no bar hover) the claim dies.
    overlayHovering = on;
    if (hoverPingTimer !== null) { clearTimeout(hoverPingTimer); hoverPingTimer = null; }
    if (on) {
      hoverPingTimer = setTimeout(() => {
        hoverPingTimer = null;
        overlayHovering = false;
        reevaluateHover();
      }, fadeDelayMs());
    }
    reevaluateHover();
    return;
  }
  if (fromBar) barHovering = on; else overlayHovering = on;
  reevaluateHover();
});
// Menu-open freeze input (the other half lives in the drag machine above).
ipcMain.on("overlay-menu-open", (_e, open: unknown) => {
  overlayMenuOpen = open === true;
  display.set_overlay_frozen(overlayMenuOpen || drag !== null);
  pushPlan();
});
// Control-bar commands: whitelist the four semantics, attach the active
// source, route through the WS command channel. No source -> no-op (the bar
// stays visible but inert, per #211).
ipcMain.on("overlay-command", (_e, raw: unknown) => {
  const engine = productEngine;
  const server = productServer;
  if (!engine || !server || raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
  const cmd = raw as Record<string, unknown>;
  const type = cmd["type"];
  if (typeof type !== "string" || !COMMAND_TYPES.has(type)) return;
  if (type === "seek" && typeof cmd["delta_ms"] !== "number") return;
  if (type === "mute" && typeof cmd["muted"] !== "boolean") return;
  const sid = engine.active_source;
  if (sid === null) return;
  const sent = server.sendCommand({ ...cmd, source_id: sid } as Parameters<typeof server.sendCommand>[0]);
  if (!sent) logLine("[overlay-command] dropped (" + type + ") - no route for " + String(sid));
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

// ---- #226 spec §1/§2: the external control-bar window (second window) ----
function createBarWindow(): void {
  barWin = new BrowserWindow({
    width: BAR_MIN_WIDTH,
    height: BAR_HEIGHT,
    // YOUTUBESUB_E2E_OFFSCREEN: same gate as the overlay - the E2E black-box
    // run creates the bar but never shows it (spec §8: created, not shown,
    // never interacted with).
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,    // never steals focus from the video
    title: "youtubesub-bar",
    webPreferences: {
      preload: path.join(APP_ROOT, "dist", "preload", "preload.cjs"),  // same bridge, zero preload changes
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  barWin.setMenuBarVisibility(false);
  // Hidden until the plan says otherwise (spec §1: visibility = renderer
  // opacity + this ignore gate; forward keeps the bridge paths alive).
  barWin.setIgnoreMouseEvents(true, { forward: true });
  barWin.webContents.on("preload-error", (_e, preloadPath, error) => {
    logLine("[bar] preload-error " + preloadPath + " : " + error.message);
  });
  barWin.webContents.on("did-fail-load", (_e, code, desc) => {
    logLine("[bar] did-fail-load " + code + " " + desc);
  });
  barWin.webContents.once("did-finish-load", () => {
    logLine("[bar] did-finish-load");
    pushPlan();            // the bar's first plan (visibility gates engage)
  });
  void barWin.loadFile(path.join(APP_ROOT, "dist", "renderer", "bar.html"));
  // Follow the overlay (spec §2: move + resize + display-metrics fallback,
  // no throttle). placeBar is idempotent and cheap.
  win?.on("move", placeBar);
  win?.on("resize", placeBar);
  win?.on("show", placeBar);
  win?.on("hide", () => { if (barWin?.isVisible()) barWin.hide(); });
  screen.on("display-metrics-changed", placeBar);
}

// spec §2: hug the overlay's bottom edge, flip above it when the screen's
// bottom edge would clip the bar, clamp into the work area (the pure
// bar_geometry in overlay.ts is tested headless). The bar window itself is
// 常驻 once shown (spec §1): hover-driven visibility is renderer opacity +
// the ignore gate; hide() only follows the overlay window hiding (tray
// toggle-overlay), and E2E offscreen never shows it at all.
function placeBar(): void {
  const bw = barWin;
  const w = win;
  if (!bw || !w) return;
  const b = w.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const geo = bar_geometry(
    { x: b.x, y: b.y, w: b.width, h: b.height },
    { x: wa.x, y: wa.y, w: wa.width, h: wa.height },
  );
  bw.setBounds({ x: geo.x, y: geo.y, width: geo.w, height: geo.h });
  if (w.isVisible()) {
    if (!bw.isVisible()) bw.showInactive();
  } else if (bw.isVisible()) {
    bw.hide();
  }
}

// ---- #206: the product stack - protocol v1 WSServer -> Engine -> display ----
// app.py App.__init__/run() 1:1: the ConnectionTester lives once and reports
// through /status; frames land in a bounded queue; the pump drains it into
// the engine (50ms, capped rounds leaving the remainder queued), the tick
// drives the display layer (33ms), and a 5s pulse re-asserts topmost while
// the window is visible and not click-through.
async function startProductStack(): Promise<void> {
  // The cache default is the repo-root data/translations.db - the real
  // library the Python build wrote, taken over in place by the TS stack
  // (#207); YOUTUBESUB_DATA_DIR relocates it (portable installs, E2E
  // isolation under a private APPDATA).
  const dataDir = process.env.YOUTUBESUB_DATA_DIR;
  const cache = new TranslationCache(dataDir ? path.join(dataDir, "translations.db") : null);
  const engine = new Engine(settings as unknown as Record<string, unknown>, cache);
  const evq = new EventQueue(2000);
  const tester = new ConnectionTester();
  productEngine = engine;   // #217 overlay-command route target
  // #226 spec §1: the bar window exists only in the product stack.
  createBarWindow();

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
      // #217: the three-state machine's derived state, per the observability
      // ruling (new key, additive; old consumers ignore it).
      overlay_state: display.overlay_state,
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
    productServer = server;   // #217 overlay-command route target
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
      // #226 spec §1: the z-order pulse covers BOTH windows (overlay first,
      // bar right after) so the bar never sinks under other topmost apps.
      if (barWin && barWin.isVisible()) {
        barWin.setAlwaysOnTop(true);
        barWin.moveTop();
      }
    }
  }, 5000);

  // e2e_app.py port: the mode/provider control surface (env-gated).
  if (process.env.YOUTUBESUB_E2E_MODE_PORT) {
    startE2EControl({
      engine, display, pushPlan,
      sendCommand: (cmd) => server.sendCommand(cmd),
      debugOpen: () => { debugHost.open("settings"); return true; },
      debugClose: () => debugHost.close(),
      debugBounds: {
        get: () => debugHost.bounds(),
        set: (b) => { debugHost.setBounds(b); },
      },
      log: logLine,
    })
      .then((p) => logLine("[e2e] mode control on 127.0.0.1:" + p))
      .catch((e: unknown) => logLine("[e2e] control start failed: " + String(e)));
  }

  app.on("before-quit", () => {
    clearInterval(pump);
    clearInterval(tick);
    clearInterval(topmost);
    clearHoverTimers();
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
      // renderer chain with synthetic mousemoves (proven by #193 CI). #227:
      // the in-window hotspot is gone (the unlock lock lives in the bar
      // window now), so the +2.5s probe moves to the window CENTER and feeds
      // the ct ping chain (renderer mousemove -> throttled overlay-hover ping
      // -> main keep-alive) instead of the old .hot hotspot probe; the runner
      // only observes (no clicks, no assertions), so it stays untouched.
      w.webContents.once("did-finish-load", () => {
        setTimeout(() => {
          setClickThrough(true);
          const b = w.getBounds();
          const cx = Math.trunc(b.width / 2), cy = Math.trunc(b.height / 2);
          setTimeout(() => {
            logLine("[main] synthetic mousemove -> center (ct ping chain)");
            w.webContents.sendInputEvent({ type: "mouseEnter", x: cx, y: cy });
            w.webContents.sendInputEvent({ type: "mouseMove", x: cx, y: cy });
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
