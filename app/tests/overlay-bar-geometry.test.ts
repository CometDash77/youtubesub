// External control-bar window geometry (#226 spec §2 / #227).
//
// bar_geometry is a pure function so these run headless: hug the overlay's
// bottom edge (horizontally centered on it), flip above the overlay when the
// screen's bottom edge would clip the bar, and clamp into the work area
// either way. Cases pinned here: hug, centering + min width, flip, flip then
// clamp (work area edges, second monitor below, negative coords), custom opts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BAR_GAP, BAR_MIN_WIDTH, BAR_HEIGHT, bar_geometry } from "../lib/overlay.ts";

const WA: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 1920, h: 1040 };

test("hug: bar sits right below the overlay, centered on it", () => {
  const g = bar_geometry({ x: 100, y: 100, w: 400, h: 200 }, WA);
  assert.deepEqual(g, { x: 100, y: 100 + 200 + BAR_GAP, w: 400, h: BAR_HEIGHT });
});

test("centering: narrow overlay gets the min width, centered on it", () => {
  const g = bar_geometry({ x: 100, y: 100, w: 100, h: 200 }, WA);
  assert.equal(g.w, BAR_MIN_WIDTH);
  assert.equal(g.x, 100 + (100 - BAR_MIN_WIDTH) / 2);
  assert.equal(g.y, 100 + 200 + BAR_GAP);
});

test("flip: overlay near the screen bottom flips the bar above it", () => {
  const g = bar_geometry({ x: 100, y: 900, w: 400, h: 150 }, WA);
  // hug y = 900+150+8 = 1058; 1058+96 > 1040 -> above: 900-8-96
  assert.deepEqual(g, { x: 100, y: 900 - BAR_GAP - BAR_HEIGHT, w: 400, h: BAR_HEIGHT });
});

test("flip then clamp: bar never leaves the work area at the top", () => {
  // Tiny work area: hug clips, flip lands above its top edge -> clamped to wa.y.
  const tiny = { x: 0, y: 0, w: 1920, h: 200 };
  const g = bar_geometry({ x: 0, y: 20, w: 400, h: 100 }, tiny);
  assert.equal(g.y, 0);
});

test("clamp x: the centered bar stays inside the work area", () => {
  // Left edge: center would be -80 -> clamped to wa.x.
  const left = bar_geometry({ x: 0, y: 0, w: 100, h: 200 }, WA);
  assert.equal(left.x, 0);
  // Right edge: center would be 1790 -> clamped to wa right minus bar width.
  const right = bar_geometry({ x: 1870, y: 0, w: 100, h: 200 }, WA);
  assert.equal(right.x, WA.w - BAR_MIN_WIDTH);
});

test("second monitor below: flip clamps to that display's work area top", () => {
  const below = { x: 0, y: 1000, w: 1920, h: 300 };
  const g = bar_geometry({ x: 0, y: 1100, w: 400, h: 250 }, below);
  // hug 1358 clips (1358+96 > 1300); flip y = 996 < 1000 -> clamped to 1000.
  assert.equal(g.y, 1000);
  assert.equal(g.x, 0);
});

test("negative coordinates: left monitor keeps the bar inside its work area", () => {
  const leftScreen = { x: -1920, y: 0, w: 1920, h: 1040 };
  const g = bar_geometry({ x: -1800, y: 100, w: 100, h: 200 }, leftScreen);
  assert.equal(g.w, BAR_MIN_WIDTH);
  assert.equal(g.x, -1880); // -1800-80, still >= -1920 and <= -1920+1920-260
  assert.equal(g.y, 100 + 200 + BAR_GAP);
});

test("custom opts: gap and bar height are overridable (tuning knobs)", () => {
  const g = bar_geometry({ x: 0, y: 0, w: 400, h: 200 }, WA, { gap: 0, barH: 50 });
  assert.deepEqual(g, { x: 0, y: 200, w: 400, h: 50 });
});
