// Overlay renderer (#204 display layer). The headless state machine
// (src/main/overlay.ts) decides everything; main owns the instance and pushes
// ready-to-render paint plans + the shared menu model. This file is a dumb
// applier plus the DOM-only plumbing: click-through hotspot + unlock flow
// (skeleton contract, #195), the #172 context menu, and mouse forwarding for
// the main-process drag/resize machine.
//
// Pit #2 (from the five-capability verification): body state classes ("ct",
// "hot-bg") must never share a name with the hotspot marker class ".hot" -
// closest(".hot") would hit body itself and pin the hotspot test to
// always-true. The plan/menu schemas here mirror the wire, not the lib types:
// this file must stay import-free (classic script over file://, see
// tsconfig.build.json).
interface SkeletonBridge {
  onClickThrough(cb: (on: boolean) => void): void;
  onWsFrame(cb: (frame: unknown) => void): void;
  setIgnore(on: boolean): void;
  unlockThrough(): void;
  rendererLog(m: string): void;
  onDisplayPlan(cb: (plan: unknown) => void): void;
  onMenuModel(cb: (model: unknown) => void): void;
  menuAction(id: string): void;
  overlayMouse(ev: unknown): void;
  onOverlayCursor(cb: (cursor: string) => void): void;
  // #217 three-state + control bar (see preload.cts)
  overlayHover(hovering: boolean): void;
  overlayCommand(cmd: unknown): void;
  menuOpenState(open: boolean): void;
}

const bridge = (window as unknown as { youtubesub: SkeletonBridge }).youtubesub;
// Boot proof line: its absence (with main's bridge probe) separates "preload
// bridge missing" from "script ran but the hotspot logic never fired".
bridge.rendererLog("renderer booted (bridge present)");
window.addEventListener("error", (e) => bridge.rendererLog("renderer error: " + e.message));
// First-paint anchor: the acceptance harness waits for this line instead of
// sleeping, so a translucent window is captured only after it actually painted
// (pit 1: a fixed sleep captured the desktop before the first frame).
requestAnimationFrame(() => requestAnimationFrame(() => bridge.rendererLog("renderer painted")));

let clickThrough = false;
const rowsEl = document.getElementById("rows") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const boxEl = document.getElementById("box") as HTMLElement;
const ctxMenuEl = document.getElementById("ctxmenu") as HTMLElement;
// #217 control bar
const ctlTitleEl = document.getElementById("ctl-title") as HTMLElement;
const btnBack = document.getElementById("btn-back") as HTMLButtonElement;
const btnPlay = document.getElementById("btn-play") as HTMLButtonElement;
const btnFwd = document.getElementById("btn-fwd") as HTMLButtonElement;
const btnMute = document.getElementById("btn-mute") as HTMLButtonElement;
const iPlay = document.getElementById("i-play") as unknown as SVGElement;
const iPause = document.getElementById("i-pause") as unknown as SVGElement;
const iVol = document.getElementById("i-vol") as unknown as SVGElement;
const iMuted = document.getElementById("i-muted") as unknown as SVGElement;
const seekWrapEl = document.getElementById("seekwrap") as HTMLElement;
const seekTrackEl = document.getElementById("seektrack") as HTMLElement;
const seekFillEl = document.getElementById("seekfill") as HTMLElement;
const seekGhostEl = document.getElementById("seekghost") as HTMLElement;
const timeLabelEl = document.getElementById("timelabel") as HTMLElement;

// ---------------------------------------------------------------------------
// Paint plan application (rows / divider / status / bg box)
// ---------------------------------------------------------------------------

interface PlanTextView {
  kind: "text"; role: string; text: string; color: string; bold: boolean; font_size: number;
  stroke_width: number; stroke_color: string; font_family: string;
}
interface PlanDividerView { kind: "divider"; y: number }
type PlanEventView = PlanTextView | PlanDividerView;
interface PlanView {
  events: PlanEventView[]; status_text: string;
  bg: { r: number; g: number; b: number; a: number };
  anim?: { fade_delay: string; dur: string; shrink: string; ease: string };
  // #217 three-state + control-bar payload (null = unknown, degrade)
  state?: "subtitles" | "controls" | "passthrough";
  title?: string;
  playing?: boolean | null;
  position_ms?: number | null;
  duration_ms?: number | null;
  muted?: boolean | null;
}

function isPlanText(ev: PlanEventView): ev is PlanTextView {
  return ev.kind === "text";
}

bridge.onDisplayPlan((raw) => {
  const plan = raw as PlanView;
  if (!plan || !Array.isArray(plan.events)) return;
  rowsEl.textContent = "";
  for (const ev of plan.events) {
    if (isPlanText(ev)) {
      const div = document.createElement("div");
      div.className = "row";
      // Qt integer point size -> CSS px at 96 dpi (* 4/3). textContent only:
      // subtitle text is untrusted, never innerHTML.
      div.style.fontSize = (ev.font_size * 4) / 3 + "px";
      div.style.color = ev.color;
      div.style.fontWeight = ev.bold ? "700" : "400";
      // _draw_wrapped's QPainterPath stroke -> -webkit-text-stroke; stroke
      // under fill (paint-order) mirrors strokePath + fillPath.
      if (typeof ev.stroke_width === "number" && ev.stroke_width > 0) {
        div.style.webkitTextStrokeWidth = ev.stroke_width + "px";
        div.style.webkitTextStrokeColor = typeof ev.stroke_color === "string" ? ev.stroke_color : "#000000";
        div.style.paintOrder = "stroke fill";
      }
      if (typeof ev.font_family === "string" && ev.font_family) {
        div.style.fontFamily = '"' + ev.font_family + '", sans-serif';
      }
      div.textContent = ev.text;
      rowsEl.appendChild(div);
    } else {
      const sep = document.createElement("div");
      sep.className = "divider";
      rowsEl.appendChild(sep);
    }
  }
  statusEl.textContent = typeof plan.status_text === "string" ? plan.status_text : "";
  const bg = plan.bg;
  if (bg && typeof bg.r === "number" && typeof bg.g === "number" &&
      typeof bg.b === "number" && typeof bg.a === "number") {
    boxEl.style.background = "rgba(" + bg.r + "," + bg.g + "," + bg.b + "," + bg.a / 255 + ")";
  }
  const anim = plan.anim;
  if (anim) {
    // Animation tuning area (#222): the four values land as CSS custom
    // properties on :root; the three-state transitions (#217) consume them.
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--fade-delay", anim.fade_delay);
    rootStyle.setProperty("--dur", anim.dur);
    rootStyle.setProperty("--shrink", anim.shrink);
    rootStyle.setProperty("--ease", anim.ease);
  }
  applyPlanState(plan);
  updateControlBar(plan);
});

// ---------------------------------------------------------------------------
// Three-state machine applier + control bar (#211 IA / #214 motion, #217)
// ---------------------------------------------------------------------------

let latestPlan: PlanView | null = null;
// Seek-drag local preview: while dragging, the fill/timelabel show the pointer
// target instead of plan.position_ms; nothing is sent until mouseup (#211:
// 拖拽期间只预览不发包、松手发一次 seek).
let seekDragging = false;
let seekFrac = 0;

function applyPlanState(plan: PlanView): void {
  // Body classes drive the CSS transitions; "ct" stays the click-through
  // channel (hotspot code + unlock visibility), the state-* classes are new.
  const st = plan.state ?? "subtitles";
  document.body.classList.toggle("state-controls", st === "controls");
  document.body.classList.toggle("state-passthrough", st === "passthrough");
}

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function updateControlBar(plan: PlanView): void {
  latestPlan = plan;
  ctlTitleEl.textContent = typeof plan.title === "string" ? plan.title : "";
  // Faces: show pause while playing, play otherwise (null = paused face);
  // muted icon only when muted is explicitly true (null = unmuted face).
  const playing = plan.playing === true;
  iPlay.style.display = playing ? "none" : "";
  iPause.style.display = playing ? "" : "none";
  const muted = plan.muted === true;
  iVol.style.display = muted ? "none" : "";
  iMuted.style.display = muted ? "" : "none";
  // Degrade rule (#211): no finite positive duration -> the seek area hides
  // entirely and the label says live stream; the buttons stay (no-op without
  // an active source - main drops the command).
  const dur = plan.duration_ms;
  const seekable = typeof dur === "number" && Number.isFinite(dur) && dur > 0;
  seekWrapEl.style.visibility = seekable ? "visible" : "hidden";
  if (!seekable) {
    timeLabelEl.textContent = "直播流";
    seekGhostEl.style.display = "none";
    return;
  }
  const durMs = dur as number;
  const dragging = seekDragging;
  const pos = dragging
    ? seekFrac * durMs
    : (typeof plan.position_ms === "number" && Number.isFinite(plan.position_ms) ? plan.position_ms : 0);
  const frac = Math.min(1, Math.max(0, pos / durMs));
  seekFillEl.style.width = (frac * 100) + "%";
  timeLabelEl.textContent = fmtTime(pos) + " / " + fmtTime(durMs);
}

function seekFractionFromEvent(e: MouseEvent): number {
  const r = seekTrackEl.getBoundingClientRect();
  if (r.width <= 0) return 0;
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
}

// The four control semantics (#211, strictly): seek offsets, explicit
// play/pause, explicit mute. Main attaches the active source and routes.
function sendOverlayCommand(cmd: Record<string, unknown>): void {
  bridge.overlayCommand(cmd);
}

btnBack.addEventListener("mousedown", (e) => e.stopPropagation());
btnFwd.addEventListener("mousedown", (e) => e.stopPropagation());
btnPlay.addEventListener("mousedown", (e) => e.stopPropagation());
btnMute.addEventListener("mousedown", (e) => e.stopPropagation());
seekWrapEl.addEventListener("mousedown", (e) => e.stopPropagation()); // never a window drag

btnBack.addEventListener("click", () => sendOverlayCommand({ type: "seek", delta_ms: -15000 }));
btnFwd.addEventListener("click", () => sendOverlayCommand({ type: "seek", delta_ms: 15000 }));
btnPlay.addEventListener("click", () => {
  const playing = latestPlan?.playing === true;
  sendOverlayCommand({ type: playing ? "pause" : "play" });
});
btnMute.addEventListener("click", () => {
  const muted = latestPlan?.muted === true;
  sendOverlayCommand({ type: "mute", muted: !muted });
});

seekWrapEl.addEventListener("mousedown", (e) => {
  const dur = latestPlan?.duration_ms;
  if (!(typeof dur === "number" && Number.isFinite(dur) && dur > 0)) return;
  e.preventDefault();
  seekDragging = true;
  seekFrac = seekFractionFromEvent(e);
  updateControlBar(latestPlan as PlanView);   // preview without sending
});

document.addEventListener("mousemove", (e) => {
  if (!seekDragging) return;
  seekFrac = seekFractionFromEvent(e);
  const ghostLeft = seekFrac * 100;
  seekGhostEl.style.left = ghostLeft + "%";
  seekGhostEl.style.display = "block";
  if (latestPlan) updateControlBar(latestPlan);
});

document.addEventListener("mouseup", () => {
  if (!seekDragging) return;
  seekDragging = false;
  seekGhostEl.style.display = "none";
  const dur = latestPlan?.duration_ms;
  if (typeof dur === "number" && Number.isFinite(dur) && dur > 0) {
    const cur = typeof latestPlan?.position_ms === "number" && Number.isFinite(latestPlan.position_ms)
      ? (latestPlan.position_ms as number) : 0;
    const target = seekFrac * dur;
    // One seek on release: delta = target - current (#211).
    sendOverlayCommand({ type: "seek", delta_ms: Math.round(target - cur) });
  }
  if (latestPlan) updateControlBar(latestPlan);
});

// Hover reporting: enter/leave on the box + a synthetic enter on the first
// move after an unlock (the cursor was already inside, so no enter event
// fires; #211 says unlock lands on subtitles, the NEXT movement re-enters
// controls like any normal hover).
let hoverSent = false;
function reportHover(h: boolean): void {
  hoverSent = h;
  bridge.overlayHover(h);
}
boxEl.addEventListener("mouseenter", () => { if (!clickThrough) reportHover(true); });
boxEl.addEventListener("mouseleave", () => { if (!clickThrough) reportHover(false); });

// ---------------------------------------------------------------------------
// Click-through + hotspot unlock (skeleton contract, kept verbatim)
// ---------------------------------------------------------------------------

bridge.onClickThrough((on) => {
  clickThrough = on;
  document.body.classList.toggle("ct", on);
  if (!on) document.body.classList.remove("hot-bg");
  if (on) reportHover(false);   // leaving interactive mode ends the hover claim
  // The plan owns the status line; the click-through hint rides it only while
  // no plan text is showing, exactly like the skeleton did before plans.
  if (on && !statusEl.textContent) statusEl.textContent = "click-through ON (Ctrl+Alt+U unlock)";
  if (!on && statusEl.textContent === "click-through ON (Ctrl+Alt+U unlock)") statusEl.textContent = "";
});

let lastHot: boolean | null = null;
document.addEventListener("mousemove", (e: MouseEvent) => {
  if (clickThrough) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const hot = !!(el && el.closest && el.closest(".hot"));
    if (hot !== lastHot) {              // log on state change only, no flood
      lastHot = hot;
      bridge.rendererLog("hot=" + hot + " at " + Math.round(e.clientX) + "," + Math.round(e.clientY));
    }
    bridge.setIgnore(!hot);             // clickable inside the hotspot, pass-through outside
    document.body.classList.toggle("hot-bg", hot);
    return;
  }
  lastHot = null;
  // Interactive mode: forward moves so main can show resize-edge cursors.
  bridge.overlayMouse({ type: "move", x: e.clientX, y: e.clientY, gx: e.screenX, gy: e.screenY });
  if (!hoverSent) reportHover(true);   // first move after unlock re-enters controls
});

bridge.onOverlayCursor((cursor) => {
  document.body.style.cursor = cursor;
});

document.getElementById("unlock")?.addEventListener("click", () => {
  bridge.rendererLog("unlock icon clicked -> click_through off");
  bridge.unlockThrough();             // full state flip via main, not bare set-ignore
});

// ---------------------------------------------------------------------------
// Shared menu model -> DOM context menu (#172)
// ---------------------------------------------------------------------------

interface MenuActionView { kind: "action"; id: string; label: string; checkable: boolean; checked: boolean }
type MenuEntryView = { kind: "separator" } | MenuActionView;

function buildMenu(model: MenuEntryView[]): void {
  ctxMenuEl.textContent = "";
  for (const entry of model) {
    const el = document.createElement("div");
    if (entry.kind === "separator") {
      el.className = "cm-sep";
    } else {
      el.className = "cm-item";
      el.dataset.id = entry.id;
      el.dataset.checked = entry.checkable && entry.checked ? "1" : "0";
      el.textContent = entry.label;
    }
    ctxMenuEl.appendChild(el);
  }
}

let menuModel: MenuEntryView[] = [];
let menuOpen = false;

bridge.onMenuModel((raw) => {
  const model = raw as MenuEntryView[];
  if (!Array.isArray(model)) return;
  menuModel = model;
  if (menuOpen) buildMenu(menuModel);  // live label swaps (visibility / click-through)
});

function hideMenu(): void {
  menuOpen = false;
  ctxMenuEl.hidden = true;
  bridge.menuOpenState(false);   // #211 freeze input: menu closed
}

function showMenuAt(x: number, y: number): void {
  buildMenu(menuModel);
  ctxMenuEl.hidden = false;
  menuOpen = true;
  bridge.menuOpenState(true);    // #211 freeze input: menu open blocks auto transitions
  const r = ctxMenuEl.getBoundingClientRect();
  ctxMenuEl.style.left = Math.min(x, window.innerWidth - r.width - 2) + "px";
  ctxMenuEl.style.top = Math.min(y, window.innerHeight - r.height - 2) + "px";
}

document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  showMenuAt(e.clientX, e.clientY);
});

ctxMenuEl.addEventListener("mousedown", (e) => {
  e.stopPropagation();                 // menu clicks never start a window drag
  const target = (e.target as HTMLElement).closest<HTMLElement>(".cm-item");
  if (target && target.dataset.id) {
    hideMenu();
    bridge.menuAction(target.dataset.id);
  }
});

document.addEventListener("mousedown", () => { if (menuOpen) hideMenu(); }, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menuOpen) hideMenu(); });

// ---------------------------------------------------------------------------
// Mouse forwarding for the main-process drag/resize machine
// ---------------------------------------------------------------------------

window.addEventListener("mousedown", (e) => {
  if (menuOpen) { hideMenu(); return; }  // the closing click never drags (QMenu grab semantics)
  if (clickThrough || e.button !== 0) return;
  bridge.overlayMouse({ type: "press", x: e.clientX, y: e.clientY, gx: e.screenX, gy: e.screenY });
});

window.addEventListener("mouseup", (e) => {
  if (clickThrough || e.button !== 0) return;
  bridge.overlayMouse({ type: "release" });
});
