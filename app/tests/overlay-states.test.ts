// Three-state machine + control-bar payload (#211 IA / #214 motion / #217).
//
// The headless OverlayDisplay owns the derived state (subtitles / controls /
// passthrough); these tests pin every transition the decision block fixed,
// the plan payload the renderer consumes, and the playback feed (position /
// duration / muted) that rides engine ticks and sync frames.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { make_sync_state, apply_sync, estimate_ms } from "../lib/clock.ts";
import { Engine } from "../lib/engine.ts";
import * as Q from "../lib/queue-cache.ts";
import * as S from "../lib/settings.ts";
import { OverlayDisplay } from "../lib/overlay.ts";

function mk(): OverlayDisplay {
  return new OverlayDisplay(S.default_settings() as { [k: string]: unknown });
}

// ---- state machine transitions (#211 decision block) --------------------

test("rest state is subtitles before any input", () => {
  const w = mk();
  assert.equal(w.overlay_state, "subtitles");
});

test("hover enters controls, leave returns to subtitles", () => {
  const w = mk();
  w.set_overlay_hover(true);
  assert.equal(w.overlay_state, "controls");
  w.set_overlay_hover(false);
  assert.equal(w.overlay_state, "subtitles");
});

test("freeze blocks automatic transitions but keeps manual passthrough", () => {
  const w = mk();
  w.set_overlay_hover(true);
  assert.equal(w.overlay_state, "controls");
  // Drag/resize or context menu open: the state must not flicker.
  w.set_overlay_frozen(true);
  w.set_overlay_hover(false);
  assert.equal(w.overlay_state, "controls", "leave during freeze must not apply");
  w.set_overlay_frozen(false);
  assert.equal(w.overlay_state, "subtitles", "unfreeze re-derives from last hover");
});

test("click-through forces passthrough; unlock lands on subtitles, never controls", () => {
  const w = mk();
  w.set_overlay_hover(true);
  w.set_overlay_click_through(true);
  assert.equal(w.overlay_state, "passthrough");
  // Even with hover still logically on (cursor inside the window), unlock
  // must fall back to subtitles (#211 decision: unlock -> subtitles).
  w.set_overlay_click_through(false);
  assert.equal(w.overlay_state, "subtitles");
  // A later synthetic mousemove re-enters controls like any normal hover.
  w.set_overlay_hover(true);
  assert.equal(w.overlay_state, "controls");
});

test("passthrough survives freeze flips (manual transitions are never gated)", () => {
  const w = mk();
  w.set_overlay_click_through(true);
  w.set_overlay_frozen(true);
  assert.equal(w.overlay_state, "passthrough");
  w.set_overlay_frozen(false);
  assert.equal(w.overlay_state, "passthrough");
});

// ---- paint plan payload (#217 renderer contract) ------------------------

test("plan carries state, title and playback fields with null degrade", () => {
  const w = mk();
  let plan = w.paint_plan();
  assert.equal(plan.state, "subtitles");
  assert.equal(plan.title, "");
  assert.equal(plan.playing, null);
  assert.equal(plan.position_ms, null);
  assert.equal(plan.duration_ms, null);
  assert.equal(plan.muted, null);

  w.set_display({ state: "ok", title: "My video", playing: true,
    position_ms: 1234.5, duration_ms: 90000, muted: false,
    events: [], bg_color: "0,0,0", bg_opacity: 151 });
  w.set_overlay_hover(true);
  plan = w.paint_plan();
  assert.equal(plan.state, "controls");
  assert.equal(plan.title, "My video");
  assert.equal(plan.playing, true);
  assert.equal(plan.position_ms, 1234.5);
  assert.equal(plan.duration_ms, 90000);
  assert.equal(plan.muted, false);
});

test("plan degrades non-finite or absent playback fields to null", () => {
  const w = mk();
  w.set_display({ state: "ok", title: "v", playing: "yes",
    position_ms: Number.NaN, duration_ms: Number.POSITIVE_INFINITY, muted: 1 });
  const plan = w.paint_plan();
  assert.equal(plan.playing, null);
  assert.equal(plan.position_ms, null);
  assert.equal(plan.duration_ms, null);
  assert.equal(plan.muted, null);
});

test("control-bar feed survives the no_cues branch (controls before captions)", () => {
  const w = mk();
  w.set_display({ state: "no_cues", title: "Still loading", playing: false,
    position_ms: 0, duration_ms: 60000, muted: true });
  w.set_overlay_hover(true);
  const plan = w.paint_plan();
  assert.equal(plan.state, "controls");
  assert.equal(plan.title, "Still loading");
  assert.equal(plan.playing, false);
  assert.equal(plan.duration_ms, 60000);
  assert.equal(plan.muted, true);
});

// ---- engine playback feed (position/duration/muted ride the tick) -------

function mkEngine(): { engine: Engine; cleanup: () => void } {
  // Mirror engine.test.ts: a real SQLite cache in a throwaway dir, mock off
  // (nothing here should translate - we only read the playback feed).
  const dir = mkdtempSync(path.join(os.tmpdir(), "overlay-states-"));
  const s = S.default_settings();
  const prov = s["provider"] as unknown as Record<string, unknown>;
  prov["mock"] = true;
  const engine = new Engine(s, new Q.TranslationCache(path.join(dir, "t.db")), 2);
  return { engine, cleanup: () => {
    (engine._queue as unknown as { shutdown?: () => void }).shutdown?.();
    engine._cache.close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* throwaway */ }
  } };
}

test("engine tick exposes position, duration and muted for the control bar", () => {
  const { engine, cleanup } = mkEngine();
  try {
    engine.handle_event({ type: "register", provider: "youtube", source_id: "s1", video_id: "v1" });
    engine.handle_event({ type: "sync", source_id: "s1", video_id: "v1",
      video_time_ms: 5000, playing: true, playback_rate: 1, timestamp: Date.now(),
      duration_ms: 120000, muted: true });
    const d = engine.tick() as Record<string, unknown>;
    // No cues sent yet: the feed rides the no_cues branch (engine.ts:811-815).
    assert.equal(d.state, "no_cues");
    assert.equal(d.duration_ms, 120000);
    assert.equal(d.muted, true);
    assert.equal(typeof d.position_ms, "number");
    assert.ok((d.position_ms as number) >= 5000);
    assert.equal(d.playing, true);
  } finally {
    cleanup();
  }
});

test("engine without an active source degrades the feed to null", () => {
  const { engine, cleanup } = mkEngine();
  try {
    // No source: tick() yields null and the renderer simply keeps its plan.
    assert.equal(engine.tick(), null);
  } finally {
    cleanup();
  }
});

// ---- clock: muted rides sync frames (#215) -------------------------------

test("apply_sync stores muted when present and null when absent", () => {
  const withMuted = make_sync_state({ video_time_ms: 0, playing: true, playback_rate: 1 });
  apply_sync(withMuted, 1000, true, 1, Date.now(), Date.now(), 60000, true);
  assert.equal(withMuted.muted, true);
  const withoutMuted = make_sync_state({ video_time_ms: 0, playing: false, playback_rate: 1 });
  apply_sync(withoutMuted, 1000, false, 1, Date.now(), Date.now(), 60000);
  assert.equal(withoutMuted.muted, null);
  // Non-boolean junk degrades instead of poisoning the face.
  const junk = make_sync_state({});
  apply_sync(junk, 1000, false, 1, Date.now(), Date.now(), 60000, "loud");
  assert.equal(junk.muted, null);
});

test("estimate_ms still interpolates with the muted field along for the ride", () => {
  const s = make_sync_state({ video_time_ms: 1000, playing: true, playback_rate: 2 });
  apply_sync(s, 1000, true, 2, Date.now(), Date.now(), 60000, false);
  const est = estimate_ms(s, s.anchor_mono + 1); // clock is seconds, not ms
  assert.ok(Math.abs(est - 3000) < 5, String(est));
});

// ---- #227: the plan carries the raw hover bit for the external bar -------

test("paint plan exposes the hover bit the bar window consumes", () => {
  const w = mk();
  assert.equal(w.paint_plan().overlay_hover, false);
  w.set_overlay_hover(true);
  assert.equal(w.paint_plan().overlay_hover, true);
  // Entering click-through keeps the raw bit: the bar shows the unlock lock
  // exactly while passthrough && hover (#226 spec §4).
  w.set_overlay_click_through(true);
  assert.equal(w.overlay_state, "passthrough");
  assert.equal(w.paint_plan().overlay_hover, true);
  // Unlock (!on) clears the bit and lands on subtitles (#211 unchanged).
  w.set_overlay_click_through(false);
  assert.equal(w.overlay_state, "subtitles");
  assert.equal(w.paint_plan().overlay_hover, false);
  // An explicit leave clears it too.
  w.set_overlay_hover(true);
  w.set_overlay_hover(false);
  assert.equal(w.paint_plan().overlay_hover, false);
});
