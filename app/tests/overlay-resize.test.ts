// Equivalence port of desktop/tests/test_overlay_resize.py (ticket #204).
//
// Regression: overlay resize must keep working when dragging inward.
// Conversion register: _apply_resize is ported as the pure apply_resize()
// (baseline = press-time geometry, min 1x1 guard); the Qt geometry reads
// become the returned Rect fields. The pytest fixtures set press_geom /
// press_global directly - here they are plain arguments.
import assert from "node:assert/strict";
import { test } from "node:test";
import { apply_resize, type Rect, type Pt } from "../lib/overlay.ts";

// mk_window(): 380x64 at (0,0), press at global (1000, 1000), resizing.
function pressGeom(): Rect {
  return { x: 0, y: 0, w: 380, h: 64 };
}
function pressGlobal(): Pt {
  return { x: 1000, y: 1000 };
}

test("resize enlarge then shrink", () => {
  const start = pressGeom();
  // enlarge by dragging right edge +200
  let g = apply_resize("r", { x: 1200, y: 1000 }, start, pressGlobal());
  assert.equal(g.w, start.w + 200);
  // now shrink by dragging the same edge inward -200 (was broken before latch
  // fix): the baseline is the press geometry, so the same cursor position
  // returns to the press-time size.
  g = apply_resize("r", { x: 1000, y: 1000 }, start, pressGlobal());
  assert.equal(g.w, start.w);
  // shrink below original from bottom edge
  g = apply_resize("b", { x: 1000, y: 970 }, start, pressGlobal());
  assert.equal(g.h, start.h - 30);
  // drag far past: clamps to 1 (zero-size guard), never crashes or goes negative
  g = apply_resize("b", { x: 1000, y: 100 }, start, pressGlobal());
  assert.equal(g.h, 1);
});

test("resize corner and no floor limit", () => {
  const start = pressGeom();
  let g = apply_resize("br", { x: 1120, y: 1080 }, start, pressGlobal());
  assert.equal(g.w, 500);
  assert.equal(g.h, 144);
  g = apply_resize("tl", { x: 1000, y: 1000 }, start, pressGlobal());
  assert.equal(g.w, 380);
  assert.equal(g.h, 64);
});

test("latched edge survives inward drag", () => {
  const start = pressGeom();
  // simulate the latch: edge stays "r" even though cursor moved to window middle
  const g = apply_resize("r", { x: 950, y: 1000 }, start, pressGlobal());
  assert.equal(g.w, 330);
});
