// 1:1 port of desktop/tests/test_tuning_fields.py (map #152 / ticket #158).
// Every pytest test function maps to exactly one test() below; assertions
// are converted assertion-for-assertion (equivalence criteria #1, #191).
// Registered behavior conversions (criteria #2):
//   - Python dict keyed by (section, key) tuple  -> Map keyed by path_key()
//   - KeyError from field_by_path / apply_edits  -> Error throw (assert.throws)
//   - isinstance(got, int)                       -> Number.isInteger(got)
//   - isinstance(got, float)                     -> typeof got === "number"
//     (JS has one numeric type; the float value-domain is owned by control)
import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../lib/settings.ts";

// The 16 authoritative paths, in page order (display.font_size joined per
// decision #167: the settings dialog was absorbed into the window).
const SPEC_PATHS: S.TuningPath[] = [
  ["display", "font_size"],
  ["display", "mode"], ["display", "order"], ["display", "history_lines"],
  ["display", "font_bold"], ["display", "stroke"], ["display", "bg_color"],
  ["display", "bg_opacity"],
  ["provider", "timeout_s"], ["provider", "max_concurrent"], ["server", "port"],
  ["prefetch", "lead_s"], ["prefetch", "max_groups"],
  ["prefetch", "seek_debounce_ms"], ["batch", "max_groups"], ["batch", "max_chars"],
];

// Explicitly not tunable: credentials / keys with an implicit UI (window
// geometry is owned by dragging).
const NOT_TUNABLE: S.TuningPath[] = [
  ["provider", "base_url"], ["provider", "api_key"], ["provider", "model"],
  ["provider", "protocol"], ["provider", "mock"],
  ["prompt", "active"], ["prompt", "context_groups"],
  ["window", "x"], ["window", "y"], ["window", "w"], ["window", "h"],
];

const setOf = (paths: readonly S.TuningPath[]): Set<string> =>
  new Set(paths.map((p) => JSON.stringify(p)));

test("fields cover exactly the spec paths", () => {
  assert.deepEqual(S.TUNING_FIELDS.map((f) => f.path), SPEC_PATHS);
  assert.deepEqual([...S.TUNING_GROUPS], ["display", "network", "experimental"]);
});

test("no credentials or already exposed keys are tunable", () => {
  for (const p of NOT_TUNABLE) {
    assert.throws(() => S.field_by_path(p), Error,
      JSON.stringify(p) + " must not be tunable: it already has a UI entry (or is a credential)");
  }
});

test("defaults match default settings", () => {
  // Every field default agrees with default_settings() (seek: UI seconds
  // vs stored milliseconds).
  const cfg = S.default_settings();
  for (const f of S.TUNING_FIELDS) {
    assert.deepEqual(S.display_value(f, cfg), f.default, JSON.stringify(f.path));
  }
});

test("clamp is boundary inclusive", () => {
  for (const f of S.TUNING_FIELDS) {
    if (f.control !== "int" && f.control !== "float" && f.control !== "slider") continue;
    const lo = f.min as number;
    const hi = f.max as number;
    assert.deepEqual(S.stored_value(f, lo - 1), S.stored_value(f, lo), JSON.stringify(f.path));
    assert.deepEqual(S.stored_value(f, hi + 1), S.stored_value(f, hi), JSON.stringify(f.path));
    const mid = (lo + hi) / 2;
    const got = S.stored_value(f, mid);
    const vlo = S.stored_value(f, lo) as number;
    const vhi = S.stored_value(f, hi) as number;
    assert.ok(vlo < (got as number) && (got as number) < vhi, JSON.stringify(f.path));
    if (f.control === "int" || f.control === "slider" || S.is_scaled(f)) {
      assert.ok(Number.isInteger(got), JSON.stringify(f.path) + " must be int-like");
    } else {
      assert.equal(typeof got, "number", JSON.stringify(f.path) + " must be numeric");
    }
  }
});

test("choice field rejects unknown value", () => {
  const mode = S.field_by_path(["display", "mode"]);
  assert.equal(S.stored_value(mode, "nonsense"), "bilingual");
  assert.equal(S.display_value(mode, { display: { mode: "nonsense" } }), "bilingual");
  assert.deepEqual(
    mode.choices.map((c) => S.display_value(mode, { display: { mode: c } })),
    [...mode.choices]);
});

test("color field clamps each channel and rejects wrong length", () => {
  const color = S.field_by_path(["display", "bg_color"]);
  assert.deepEqual(S.stored_value(color, [0, 300, -5]), [0, 255, 0]);
  assert.deepEqual(S.stored_value(color, [0, 0]), [0, 0, 0]);
  assert.deepEqual(S.stored_value(color, "nope"), [0, 0, 0]);
  assert.deepEqual(S.display_value(color, { display: { bg_color: [10, 20] } }), [0, 0, 0]);
  assert.deepEqual(S.display_value(color, { display: { bg_color: [10, 20, 300] } }), [10, 20, 255]);
});

test("seek seconds milliseconds round trip", () => {
  const seek = S.field_by_path(["prefetch", "seek_debounce_ms"]);
  assert.equal(S.is_scaled(seek), true);
  assert.equal(S.stored_value(seek, 0.4), 400);
  assert.equal(S.stored_value(seek, 0.5), 500);
  assert.equal(S.stored_value(seek, 5.0), 5000);
  assert.equal(S.stored_value(seek, 9999), 5000);
  assert.equal(S.display_value(seek, { prefetch: { seek_debounce_ms: 400 } }), 0.4);
  assert.equal(S.display_value(seek, { prefetch: { seek_debounce_ms: 9999 } }), 5.0);
  assert.equal(S.display_value(seek, { prefetch: {} }), 0.4);
  for (const ui of [0.0, 0.4, 1.0, 2.5, 5.0]) {
    assert.equal(
      S.display_value(seek, { prefetch: { seek_debounce_ms: S.stored_value(seek, ui) as number } }),
      ui);
  }
});

test("display value falls back to default for unusable values", () => {
  const timeout = S.field_by_path(["provider", "timeout_s"]);
  assert.equal(S.display_value(timeout, { provider: { timeout_s: "abc" } }), 60.0);
  assert.equal(S.display_value(timeout, { provider: { timeout_s: true } }), 60.0);
  assert.equal(S.display_value(timeout, { provider: { timeout_s: null } }), 60.0);
  assert.equal(S.display_value(timeout, {}), 60.0);
  assert.equal(S.display_value(timeout, { provider: "broken" }), 60.0);
  assert.equal(S.display_value(timeout, { provider: { timeout_s: 9999 } }), 600.0);
  assert.equal(S.display_value(timeout, { provider: { timeout_s: 30 } }), 30.0);
});

test("collect edits only returns changed keys", () => {
  const cfg = S.default_settings();
  const initial = S.tuning_ui_state(cfg);
  assert.deepEqual(S.collect_edits(initial, initial), []);
  const ui = new Map(initial);
  ui.set(S.path_key(["display", "history_lines"]), 5);
  assert.deepEqual(
    S.collect_edits(ui, initial),
    [[["display", "history_lines"], 5]]);
});

test("apply edits clamps and preserves untouched keys", () => {
  const cfg = S.default_settings();
  const node = (k: string): S.JsonObject => cfg[k] as S.JsonObject;
  node("display")["font_size"] = 99;          // hand-edited out-of-range value
  node("prefetch")["draft_note"] = "keep me"; // hand-edited unknown key
  const applied = S.apply_edits(cfg, [[["prefetch", "lead_s"], 30.0]]);
  assert.deepEqual(applied, [["prefetch", "lead_s"]]);
  assert.equal(node("prefetch")["lead_s"], 30.0);
  assert.equal(node("display")["font_size"], 99);
  assert.equal(node("prefetch")["draft_note"], "keep me");
  assert.deepEqual(
    S.apply_edits(cfg, [[["batch", "max_chars"], 1e9]]),
    [["batch", "max_chars"]]);
  // Keys outside the tuning table raise - the page cannot reach them.
  assert.throws(() => S.apply_edits(cfg, [[["provider", "api_key"], "sk-nope"]]), Error);
  assert.equal(node("provider")["api_key"], "");
});

test("restart and uncalibrated flags match the spec", () => {
  const restart = S.TUNING_FIELDS.filter((f) => f.restart).map((f) => f.path);
  assert.deepEqual(setOf(restart), setOf([["provider", "max_concurrent"], ["server", "port"]]));
  const uncalibrated = S.TUNING_FIELDS.filter((f) => f.uncalibrated).map((f) => f.path);
  assert.deepEqual(
    setOf(uncalibrated),
    setOf([
      ["prefetch", "lead_s"], ["prefetch", "max_groups"],
      ["prefetch", "seek_debounce_ms"], ["batch", "max_groups"], ["batch", "max_chars"],
    ]));
  const notify = S.TUNING_FIELDS.filter((f) => f.notify_overlay).map((f) => f.path);
  // Display fields that change the paint must make the overlay look again
  // after save (#170: a font-size change is visible on the spot).
  assert.deepEqual(
    setOf(notify),
    setOf([
      ["display", "font_size"], ["display", "mode"], ["display", "order"],
      ["display", "font_bold"], ["display", "stroke"], ["display", "bg_color"],
      ["display", "bg_opacity"],
    ]));
  const groups = new Set(S.TUNING_FIELDS.map((f) => f.group));
  assert.deepEqual(groups, new Set(S.TUNING_GROUPS));
});

test("every field carries a label and hint slot", () => {
  for (const f of S.TUNING_FIELDS) {
    assert.equal(typeof f.label, "string", JSON.stringify(f.path));
    assert.ok(f.label.trim().length > 0, JSON.stringify(f.path));
    assert.equal(typeof f.hint, "string", JSON.stringify(f.path));
    assert.ok(f.hint.trim().length > 0, JSON.stringify(f.path));
  }
  // "Reboot to take effect" / "uncalibrated" badges are attached by the page
  // uniformly; a field's own hint only says what changing it does (#170).
  assert.equal(
    S.field_by_path(["provider", "max_concurrent"]).hint.includes("重启后生效"), false);
  assert.equal(S.field_by_path(["server", "port"]).hint.includes("重启后生效"), false);
  assert.ok(S.field_by_path(["display", "stroke"]).hint.startsWith("给字加一圈黑边"));
  for (const f of S.TUNING_FIELDS) {
    if (f.uncalibrated) assert.equal(f.group, "experimental", JSON.stringify(f.path));
  }
});
