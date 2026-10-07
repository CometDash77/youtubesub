// Overlay renderer for the skeleton: click-through state + hotspot unlock +
// wire-frame echo. Pit #2 (from the five-capability verification): body
// state classes ("ct", "hot-bg") must never share a name with the hotspot
// marker class ".hot" - closest(".hot") would hit body itself and pin the
// hotspot test to always-true.
interface SkeletonBridge {
  onClickThrough(cb: (on: boolean) => void): void;
  onWsFrame(cb: (frame: unknown) => void): void;
  setIgnore(on: boolean): void;
  unlockThrough(): void;
  rendererLog(m: string): void;
}

interface WireFrameView {
  type: string;
  tab_title?: unknown;
  cues?: unknown;
  playing?: unknown;
}

const bridge = (window as unknown as { youtubesub: SkeletonBridge }).youtubesub;

let clickThrough = false;
const statusEl = document.getElementById("status") as HTMLElement;
const origEl = document.getElementById("orig") as HTMLElement;

bridge.onClickThrough((on) => {
  clickThrough = on;
  document.body.classList.toggle("ct", on);
  if (!on) document.body.classList.remove("hot-bg");
  statusEl.textContent = on ? "click-through ON (Ctrl+Alt+U unlock)" : "";
});

let lastHot: boolean | null = null;
document.addEventListener("mousemove", (e: MouseEvent) => {
  if (!clickThrough) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const hot = !!(el && el.closest && el.closest(".hot"));
  if (hot !== lastHot) {              // log on state change only, no flood
    lastHot = hot;
    bridge.rendererLog("hot=" + hot + " at " + Math.round(e.clientX) + "," + Math.round(e.clientY));
  }
  bridge.setIgnore(!hot);             // clickable inside the hotspot, pass-through outside
  document.body.classList.toggle("hot-bg", hot);
});

document.getElementById("unlock")?.addEventListener("click", () => {
  bridge.rendererLog("unlock icon clicked -> click_through off");
  bridge.unlockThrough();             // full state flip via main, not bare set-ignore
});

bridge.onWsFrame((frame) => {
  const ev = frame as WireFrameView;
  if (ev.type === "register") {
    statusEl.textContent = "waiting for subtitles..." +
      (typeof ev.tab_title === "string" && ev.tab_title ? "  [" + ev.tab_title + "]" : "");
  } else if (ev.type === "cues") {
    const list = Array.isArray(ev.cues) ? ev.cues : [];
    const last = list.length ? list[list.length - 1] : null;
    const text = last && typeof last === "object" && typeof (last as { text?: unknown }).text === "string"
      ? (last as { text: string }).text
      : "";
    origEl.textContent = "【原】" + text;
  } else if (ev.type === "sync") {
    if (ev.playing === false) statusEl.textContent = "[Paused]";
  }
});