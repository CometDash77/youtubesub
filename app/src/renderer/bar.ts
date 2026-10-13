// External control-bar window renderer (#226 spec, #227 implementation). The
// control bar + title + unlock lock moved OUT of the overlay window; this
// second window rides next to it (below, or flipped above at the screen's
// bottom edge) and mirrors the same paint plan. Visibility is double-gated:
// main holds setIgnoreMouseEvents unless the bar is interactive, and the CSS
// opacity is the renderer gate - so this renderer only reports hover while
// actually visible (an invisible bar must never be a giant hover region).
//
// The plan schema mirrors the wire, not the lib types: this file stays
// import-free (classic script over file://, see tsconfig.build.json).
// tsc's legacy moduleDetection treats import-free files as ONE global
// script, so every top-level name here would collide with renderer.ts's
// (loaded in a different window - no runtime clash, but one compile unit).
// An IIFE keeps the classic-script delivery and scopes everything.
(function () {
  interface SkeletonBridge {
    unlockThrough(): void;
    rendererLog(m: string): void;
    onDisplayPlan(cb: (plan: unknown) => void): void;
    overlayMouse(ev: unknown): void;
    // #217 three-state + control bar (see preload.cts)
    overlayHover(hovering: boolean): void;
    overlayCommand(cmd: unknown): void;
  }

  const bridge = (window as unknown as { youtubesub: SkeletonBridge }).youtubesub;
  // Boot proof line, same contract as the overlay renderer.
  bridge.rendererLog("bar booted (bridge present)");
  window.addEventListener("error", (e) => bridge.rendererLog("bar error: " + e.message));

  const barEl = document.getElementById("bar") as HTMLElement;
  const barTitleEl = document.getElementById("bar-title") as HTMLElement;
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
  const unlockEl = document.getElementById("bar-unlock") as HTMLElement;

  interface PlanView {
    anim?: { fade_delay: string; dur: string; ease: string };
    state?: "subtitles" | "controls" | "passthrough";
    // #226: hover bit - drives the lock while passthrough + hover.
    overlay_hover?: boolean;
    title?: string;
    playing?: boolean | null;
    position_ms?: number | null;
    duration_ms?: number | null;
    muted?: boolean | null;
  }

  let latestPlan: PlanView | null = null;
  // Seek-drag local preview: while dragging, the fill/timelabel show the pointer
  // target instead of plan.position_ms; nothing is sent until mouseup (#211:
  // 拖拽期间只预览不发包、松手发一次 seek).
  let seekDragging = false;
  let seekFrac = 0;
  // Hover claim bookkeeping: only the VISIBLE bar reports hover (spec §1).
  let barVisible = false;
  // Title-row drag forwarding is controls-state-only (spec §7: the title rides
  // the bar only in controls; a lock-state background click must not drag).
  let barOn = false;
  let hoverSent = false;

  function reportHover(h: boolean): void {
    hoverSent = h;
    bridge.overlayHover(h);
  }

  function applyBarState(plan: PlanView): void {
    const st = plan.state ?? "subtitles";
    barOn = st === "controls";
    const lockOn = st === "passthrough" && plan.overlay_hover === true;
    barVisible = barOn || lockOn;
    document.body.classList.toggle("bar-on", barOn);

    document.body.classList.toggle("lock-on", lockOn);
    // Transition to invisible: retract the hover claim exactly once, then stay
    // silent until the bar is visible again.
    if (!barVisible && hoverSent) reportHover(false);
  }

  function fmtTime(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function updateControlBar(plan: PlanView): void {
    latestPlan = plan;
    barTitleEl.textContent = typeof plan.title === "string" ? plan.title : "";
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

  bridge.onDisplayPlan((raw) => {
    const plan = raw as PlanView;
    if (!plan || typeof plan !== "object") return;
    const anim = plan.anim;
    if (anim) {
      // #226: the bar consumes --dur/--ease for its fade (main owns the delay).
      const rootStyle = document.documentElement.style;
      if (typeof anim.dur === "string") rootStyle.setProperty("--dur", anim.dur);
      if (typeof anim.ease === "string") rootStyle.setProperty("--ease", anim.ease);
    }
    applyBarState(plan);
    updateControlBar(plan);
  });

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
  unlockEl.addEventListener("mousedown", (e) => e.stopPropagation());

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

  function seekFractionFromEvent(e: MouseEvent): number {
    const r = seekTrackEl.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  }

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

  // Hover bridging (spec §3): native enter/leave while interactive; the bar is
  // a second hover position next to the overlay window. Only a visible bar
  // reports (main keeps ignore+forward on the invisible window, so this is
  // belt-and-braces against any synthetic enter on the transparent shell).
  barEl.addEventListener("mouseenter", () => { if (barVisible) reportHover(true); });
  barEl.addEventListener("mouseleave", () => { if (barVisible) reportHover(false); });

  // Unlock lock (#226 §4): only clickable in lock-on (passthrough + hover);
  // walks the existing unlock-through channel, main flips the full state.
  unlockEl.addEventListener("click", () => {
    bridge.rendererLog("bar unlock clicked -> click_through off");
    bridge.unlockThrough();
  });

  // #226 §7: title-row drag forwards press/move/release to the main drag
  // machine (gx/gy global, px/py bar-relative; main rewrites px/py to the
  // overlay's interior so edge_at sees null and the press becomes a plain
  // window drag). Buttons/seek/lock stopPropagation above, so only title /
  // bar-background presses get here.
  window.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !barOn) return;   // controls state only (spec §7)
    bridge.overlayMouse({ type: "press", x: e.clientX, y: e.clientY, gx: e.screenX, gy: e.screenY });
  });

  window.addEventListener("mousemove", (e) => {
    if (e.buttons % 2 !== 1 || !barOn) return;  // primary button down, controls state
    bridge.overlayMouse({ type: "move", x: e.clientX, y: e.clientY, gx: e.screenX, gy: e.screenY });
  });

  window.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;
    bridge.overlayMouse({ type: "release" });
  });

  // #226 §8: no context menu in the bar (the overlay's menu stays untouched).
  document.addEventListener("contextmenu", (e) => e.preventDefault());
})();
