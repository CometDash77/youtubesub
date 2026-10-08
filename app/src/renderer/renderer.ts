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

// ---------------------------------------------------------------------------
// Paint plan application (rows / divider / status / bg box)
// ---------------------------------------------------------------------------

interface PlanTextView { kind: "text"; role: string; text: string; color: string; bold: boolean; font_size: number }
interface PlanDividerView { kind: "divider"; y: number }
type PlanEventView = PlanTextView | PlanDividerView;
interface PlanView { events: PlanEventView[]; status_text: string; bg: { r: number; g: number; b: number; a: number } }

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
});

// ---------------------------------------------------------------------------
// Click-through + hotspot unlock (skeleton contract, kept verbatim)
// ---------------------------------------------------------------------------

bridge.onClickThrough((on) => {
  clickThrough = on;
  document.body.classList.toggle("ct", on);
  if (!on) document.body.classList.remove("hot-bg");
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
}

function showMenuAt(x: number, y: number): void {
  buildMenu(menuModel);
  ctxMenuEl.hidden = false;
  menuOpen = true;
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
