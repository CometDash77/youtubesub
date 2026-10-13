// #232: restore_debug_bounds - the pure parse+clamp half of the debug
// window's bounds persistence (spec #230 section 3). Table-driven over the
// section shapes the spec pins: whole-section fallback, per-field degrade,
// size-then-position clamping, and the nearest-display probe rule (via a
// fake pickWorkArea - this file never imports electron).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  restore_debug_bounds,
  type DebugRect,
  type RestoredDebugBounds,
} from "../src/main/debug/window.ts";

const MIN_W = 420;
const MIN_H = 300;
const FB_W = 1120;   // the model fallback (debug.width/height at createWindow)
const FB_H = 760;
const WA: DebugRect = { x: 0, y: 0, width: 1920, height: 1040 };

interface Case {
  name: string;
  stored: unknown;
  want: RestoredDebugBounds;
  area?: DebugRect;                       // pickWorkArea's answer (default WA)
  probes?: DebugRect[];                   // expected probe rects; [] = not called
}

const CASES: Case[] = [
  // ---- whole-section fallback: never probes a work area ----
  { name: "missing section", stored: undefined,
    want: { x: null, y: null, width: FB_W, height: FB_H }, probes: [] },
  { name: "null section", stored: null,
    want: { x: null, y: null, width: FB_W, height: FB_H }, probes: [] },
  { name: "array section", stored: [1, 2],
    want: { x: null, y: null, width: FB_W, height: FB_H }, probes: [] },
  { name: "string section", stored: "garbage",
    want: { x: null, y: null, width: FB_W, height: FB_H }, probes: [] },
  // ---- valid section inside the work area: stored values survive ----
  { name: "valid rect restored as-is",
    stored: { x: 100, y: 50, w: 800, h: 600 },
    want: { x: 100, y: 50, width: 800, height: 600 },
    probes: [{ x: 100, y: 50, width: 800, height: 600 }] },
  { name: "floats truncate toward zero, 400 < minW lifts to the floor",
    stored: { x: 10.9, y: 20.4, w: 400.7, h: 300.9 },
    want: { x: 10, y: 20, width: MIN_W, height: 300 },
    probes: [{ x: 10, y: 20, width: 400, height: 300 }] },
  // ---- per-field degrade (an invalid field alone, the others survive) ----
  { name: "bad y falls to OS default, bad w falls to model size",
    stored: { x: 60, y: "no", w: "40", h: 360 },
    want: { x: 60, y: null, width: FB_W, height: 360 },
    probes: [{ x: 60, y: 0, width: FB_W, height: 360 }] },
  { name: "null axes stay null, sizes survive",
    stored: { x: null, y: null, w: 480, h: 360 },
    want: { x: null, y: null, width: 480, height: 360 },
    probes: [{ x: 0, y: 0, width: 480, height: 360 }] },
  { name: "NaN/Infinity degrade their axis; finite negatives clamp to the floor",
    stored: { x: Number.NaN, y: Number.POSITIVE_INFINITY, w: -5, h: 0 },
    want: { x: null, y: null, width: MIN_W, height: MIN_H },
    probes: [{ x: 0, y: 0, width: -5, height: 0 }] },
  // ---- position clamping: fully visible per non-null axis ----
  { name: "fully outside clamps to the bottom-right corner",
    stored: { x: 5000, y: 5000, w: 800, h: 600 },
    want: { x: 1920 - 800, y: 1040 - 600, width: 800, height: 600 } },
  { name: "partially outside clamps back inside",
    stored: { x: 1900, y: 1000, w: 800, h: 600 },
    want: { x: 1920 - 800, y: 1040 - 600, width: 800, height: 600 } },
  { name: "negative position clamps to the top-left",
    stored: { x: -100, y: -50, w: 800, h: 600 },
    want: { x: 0, y: 0, width: 800, height: 600 } },
  // ---- size first, then position ----
  { name: "size over work area clamps first, position still resolves",
    stored: { x: 10, y: 20, w: 3000, h: 2000 },
    want: { x: 0, y: 0, width: 1920, height: 1040 } },
  { name: "below-min size lifts to the floor",
    stored: { x: 50, y: 50, w: 100, h: 100 },
    want: { x: 50, y: 50, width: MIN_W, height: MIN_H } },
  // ---- #236: ring-era stored bounds (the deleted 24px SHADOW_MARGIN ring
  // made a stored rect describe the OUTER window, 48px wider/taller than the
  // then-visible panel). The restore runs no ±48 conversion: the stored rect
  // IS the new window rect, and #236 makes the window rect the visible panel
  // rect, so the panel comes back fully visible. A "-48 migration" would be
  // a no-op at the reporter's persisted 420x300 anyway (372x252 is under the
  // floor and clamps straight back). ----
  { name: "#236 ring-era rect restores verbatim (reporter's persisted bounds)",
    stored: { x: 60, y: 60, w: 420, h: 300 },
    want: { x: 60, y: 60, width: 420, height: 300 },
    probes: [{ x: 60, y: 60, width: 420, height: 300 }] },
  { name: "#236 ring-era size is not shrunk by the old 48px ring",
    stored: { x: 100, y: 100, w: FB_W + 48, h: FB_H + 48 },
    want: { x: 100, y: 100, width: FB_W + 48, height: FB_H + 48 },
    probes: [{ x: 100, y: 100, width: FB_W + 48, height: FB_H + 48 }] },
  // ---- multi-display: the probe rect decides which work area answers ----
  { name: "second display: stored rect probes it, clamp runs there",
    stored: { x: 2000, y: 100, w: 800, h: 600 },
    area: { x: 1920, y: 0, width: 1920, height: 1040 },
    want: { x: 2000, y: 100, width: 800, height: 600 },
    probes: [{ x: 2000, y: 100, width: 800, height: 600 }] },
  { name: "degenerate work area below min hugs the right/bottom edge",
    stored: { x: 0, y: 0, w: 800, h: 600 },
    area: { x: 0, y: 0, width: 200, height: 200 },
    // hi < lo: the clamp lands on hi = wa.x + wa.width - width
    want: { x: 200 - MIN_W, y: 200 - MIN_H, width: MIN_W, height: MIN_H } },
];

for (const c of CASES) {
  test(`restore_debug_bounds: ${c.name}`, () => {
    const probes: DebugRect[] = [];
    const area = c.area ?? WA;
    const out = restore_debug_bounds(
      c.stored,
      (rect) => { probes.push(rect); return area; },
      MIN_W, MIN_H, FB_W, FB_H,
    );
    assert.deepEqual(out, c.want);
    if (c.probes !== undefined) assert.deepEqual(probes, c.probes);
  });
}
