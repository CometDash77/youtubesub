// Equivalence port of desktop/tests/test_overlay_labels.py (ticket #204).
//
// Issue #1, display half: an unavailable translation must not blank the
// overlay. The engine stopped fabricating a translation when no provider is
// configured; that leaves the display layer with an empty translation, and
// trans mode must fall back to the original instead of reading as "no
// subtitles".
//
// Conversion register (pytest -> node --test):
// - The Qt widget is offscreen and the tests read what it hands to its paint
//   primitives via a PaintLog injected over _draw_wrapped/_draw_divider. Here
//   the same decisions are read from OverlayDisplay.paint_plan() events:
//   texts / shape / colors map 1:1 (plan text events carry the exact QColor
//   .name() strings, dividers keep their placement).
// - paint() helper: mode/order/texts assigned directly like the pytest
//   helper; Python None texts coerce to "" (identical at the row level - the
//   row contract treats None and "" the same).
// - The two pixel-measuring wrap tests become wrap_text() with a
//   deterministic Measurer (10 units per character, height 10): "wraps into
//   >= 3 lines" and "nothing renders beyond the area width" are asserted as
//   the algorithm's own invariants (line count / end_y / per-line advance).
// - test_long_translation_renders_inside_bounds: the rendered-image pixel
//   classification (yellow above white) becomes plan row order + color
//   assertions plus the same wrap invariants.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OverlayDisplay, wrap_text, type Measurer, type Rect } from "../lib/overlay.ts";
import { default_settings } from "../lib/settings.ts";

const ORIG_LABEL = "\u3010\u539f\u3011";   // 【原】
const TRANS_LABEL = "\u3010\u8bd1\u3011";  // 【译】

// Deterministic QFontMetrics stand-in: 10 units of advance per character.
const mono: Measurer = {
  advance: (s: string) => [...s].length * 10,
  height: () => 10,
};

interface PaintOpts {
  order?: string;
  trans_available?: boolean;
  trans_state?: string;
}

function paint(mode: string, orig: unknown, trans: unknown, opts: PaintOpts = {}) {
  const w = new OverlayDisplay(default_settings() as { [k: string]: unknown });
  w.mode = mode;
  w.order = opts.order ?? "trans_first";
  w.orig_text = orig == null ? "" : String(orig);
  w.trans_text = trans == null ? "" : String(trans);
  w.trans_available = opts.trans_available ?? false;
  w.trans_state = opts.trans_state ?? "idle";
  return w.paint_plan();
}

function texts(plan: ReturnType<typeof paint>): string[] {
  return plan.events.filter((e) => e.kind === "text").map((e) => e.text);
}

function colors(plan: ReturnType<typeof paint>): string[] {
  return plan.events.filter((e) => e.kind === "text").map((e) => e.color);
}

function shape(plan: ReturnType<typeof paint>): string[] {
  return plan.events.map((e) => e.kind);
}

test("trans mode without a translation shows the original", () => {
  const log = paint("trans", "FIXTURE ALPHA one", "", { trans_available: false });
  assert.deepEqual(texts(log), [ORIG_LABEL + "FIXTURE ALPHA one"]);
  assert.ok(!texts(log).some((t) => t.includes(TRANS_LABEL)), JSON.stringify(texts(log)));
});

test("trans mode with a configured provider keeps waiting blank", () => {
  // A usable provider means a translation is coming: no fallback flash, and
  // the row is still the translation row (today's behaviour, unchanged).
  const log = paint("trans", "Hello", "", { trans_available: true });
  assert.deepEqual(texts(log), []);
  assert.deepEqual(log.events.filter((e) => e.kind === "divider"), []);
});

test("trans mode with a translation still shows only the translation", () => {
  const log = paint("trans", "Hello", "\u4f60\u597d", { trans_available: true });
  assert.deepEqual(texts(log), [TRANS_LABEL + "\u4f60\u597d"]);
  assert.deepEqual(log.events.filter((e) => e.kind === "divider"), []);
});

test("bilingual without a translation keeps both labels and the divider", () => {
  const log = paint("bilingual", "Hello there", "", { trans_available: false });
  assert.deepEqual(texts(log), [TRANS_LABEL, ORIG_LABEL + "Hello there"]);
  assert.deepEqual(shape(log), ["text", "divider", "text"]);
});

test("bilingual divider sits between the rows in either order", () => {
  const first = paint("bilingual", "Hello", "\u4f60\u597d", { order: "trans_first" });
  assert.deepEqual(texts(first), [TRANS_LABEL + "\u4f60\u597d", ORIG_LABEL + "Hello"]);
  assert.deepEqual(shape(first), ["text", "divider", "text"]);
  const second = paint("bilingual", "Hello", "\u4f60\u597d", { order: "orig_first" });
  assert.deepEqual(texts(second), [ORIG_LABEL + "Hello", TRANS_LABEL + "\u4f60\u597d"]);
  assert.deepEqual(shape(second), ["text", "divider", "text"]);
});

test("orig mode keeps its label and draws no divider", () => {
  const log = paint("orig", "Hello", "\u4f60\u597d");
  assert.deepEqual(texts(log), [ORIG_LABEL + "Hello"]);
  assert.deepEqual(log.events.filter((e) => e.kind === "divider"), []);
});

test("trans mode with nothing to show stays blank", () => {
  // The fallback shows the original; with nothing to fall back to there is
  // still no floating 【原】 left behind before the first cue.
  const log = paint("trans", "", "", { trans_available: false });
  assert.deepEqual(log.events, []);
});

test("a None text is treated as empty not a crash", () => {
  // set_display copies whatever the engine sent; a falsy side must not take
  // the paint slot down (the old renderer skipped it).
  const log = paint("bilingual", null, "\u4f60\u597d");
  assert.deepEqual(texts(log), [TRANS_LABEL + "\u4f60\u597d", ORIG_LABEL]);
});

test("nothing is drawn between cues", () => {
  // Both rows empty happens in every gap between cues; a row label must not
  // survive on its own and leave 【译】/【原】 floating over an empty video.
  const log = paint("bilingual", "", "");
  assert.deepEqual(log.events, []);
});

test("set_display hands the engine's word to the rows", () => {
  // The flag travels on the display state, so the overlay never has to read
  // provider config itself (Engine is the only authority on _provider_usable).
  const w = new OverlayDisplay(default_settings() as { [k: string]: unknown });
  w.mode = "trans";
  w.set_display({ state: "ok", orig: "Hello", trans: "", trans_available: false });
  const log = w.paint_plan();
  assert.deepEqual(texts(log), [ORIG_LABEL + "Hello"]);
});

test("a text that already carries its label is not labelled twice", () => {
  // The mock translator writes 【译】 into its own output, and the demo / E2E
  // depend on that; the row label must not double up on it.
  const log = paint("trans", "\u539f\u6587", TRANS_LABEL + "\u539f\u6587", { trans_available: true });
  assert.deepEqual(texts(log), [TRANS_LABEL + "\u539f\u6587"]);
});

test("translation states replace the translation row with fixed copy and color", () => {
  const cases: Array<[string, string, string]> = [
    ["waiting", "\uff08\u7b49\u5f85\u539f\u5b57\u5e55\u4e2d\uff09", "#ffe082"],
    ["translating", "\uff08\u7ffb\u8bd1\u4e2d\uff09", "#ffe082"],
    ["failed:\u8bf7\u6c42\u53d7\u9650", "\uff08\u7ffb\u8bd1\u5931\u8d25\uff1a\u8bf7\u6c42\u53d7\u9650\uff09", "#ff5a5a"],
    ["unconfigured", "\uff08\u672a\u914d\u7f6e\u7ffb\u8bd1\uff09", "#ffe082"],
  ];
  for (const [state, expected, color] of cases) {
    const log = paint("trans", "Original", "", { trans_available: true, trans_state: state });
    assert.deepEqual(texts(log), [TRANS_LABEL + expected], state);
    assert.deepEqual(colors(log), [color], state);
  }
});

test("ready state restores translation and original-only hides all translation state", () => {
  const ready = paint("trans", "Original", "Translated", { trans_available: true, trans_state: "ready" });
  assert.deepEqual(texts(ready), [TRANS_LABEL + "Translated"]);

  const originalOnly = paint("orig", "Original", "", { trans_available: true, trans_state: "failed:\u8bf7\u6c42\u53d7\u9650" });
  assert.deepEqual(texts(originalOnly), [ORIG_LABEL + "Original"]);
});

test("translation failure reason is truncated to sixteen unicode characters", () => {
  const log = paint("trans", "Original", "", { trans_available: true, trans_state: "failed:" + "\u7532".repeat(17) });
  assert.deepEqual(texts(log), [TRANS_LABEL + "\uff08\u7ffb\u8bd1\u5931\u8d25\uff1a" + "\u7532".repeat(16) + "\u2026\uff09"]);
});

test("bilingual unconfigured state keeps original and divider", () => {
  const log = paint("bilingual", "Original", "", { trans_available: false, trans_state: "unconfigured" });
  assert.deepEqual(texts(log), [TRANS_LABEL + "\uff08\u672a\u914d\u7f6e\u7ffb\u8bd1\uff09", ORIG_LABEL + "Original"]);
  assert.deepEqual(shape(log), ["text", "divider", "text"]);
});

test("waiting state is visible before the first cue", () => {
  const w = new OverlayDisplay(default_settings() as { [k: string]: unknown });
  w.mode = "trans";
  w.set_display({ state: "no_cues", trans_state: "waiting", trans_available: true, title: "Some video" });
  const log = w.paint_plan();
  assert.deepEqual(texts(log), [TRANS_LABEL + "\uff08\u7b49\u5f85\u539f\u5b57\u5e55\u4e2d\uff09"]);
});

test("caption chain error suppresses waiting translation state", () => {
  const w = new OverlayDisplay(default_settings() as { [k: string]: unknown });
  w.mode = "trans";
  w.set_display({ state: "no_cues", trans_state: "waiting", trans_available: true, hook_error: "hook unavailable" });
  const log = w.paint_plan();
  assert.deepEqual(texts(log), []);
  assert.ok(w.status_text.toLowerCase().includes("hook"), w.status_text);
});

// ---- wrap algorithm (measurer-injected port of the two pixel tests) ----

test("long unspaced translation wraps within the available width", () => {
  const w = new OverlayDisplay(default_settings() as { [k: string]: unknown });
  void w;
  const area: Rect = { x: 10, y: 10, w: 72, h: 100 };
  const text = "\u591a\u5e74\u6765\u8d5b\u8f66\u8fd0\u52a8\u4e2d\u4f7f\u7528\u7684\u53d1\u8f66\u683c\u52a8\u753b\u786e\u5b9e\u81ea\u6210\u4e00\u4f53";
  const r = wrap_text(text, area, mono, area.y);

  const line_height = mono.height() + 3;
  assert.ok(r.end_y >= area.y + 3 * line_height, "end_y=" + r.end_y);
  // The pixel-outside-bounds assertion becomes the algorithm's own invariant:
  // no drawn line may exceed the available width.
  for (const ln of r.lines) {
    assert.ok(mono.advance(ln) <= area.w, "line beyond width: " + JSON.stringify(ln));
  }
});

test("long single word wraps at large font and narrow width", () => {
  const w = new OverlayDisplay(default_settings() as { [k: string]: unknown });
  void w;
  const area: Rect = { x: 10, y: 10, w: 48, h: 500 };
  const r = wrap_text("InternationalChampionshipFinals", area, mono, area.y);

  const line_height = mono.height() + 3;
  assert.ok(r.end_y >= area.y + 3 * line_height, "end_y=" + r.end_y);
  for (const ln of r.lines) {
    assert.ok(mono.advance(ln) <= area.w, "line beyond width: " + JSON.stringify(ln));
  }
});

test("long translation renders inside bounds in trans and bilingual modes", () => {
  // Pixel-classification rewrite: trans rows are yellow, orig rows white, the
  // yellow rows sit ABOVE the white ones (trans_first), and every wrapped
  // line stays inside the content width.
  const translation = "\u591a\u5e74\u6765\u8d5b\u8f66\u8fd0\u52a8\u4e2d" +
    "\u4f7f\u7528\u7684\u53d1\u8f66\u683c\u52a8\u753b" +
    "\u786e\u5b9e\u81ea\u6210\u4e00\u4f53\u5e76\u4e14" +
    "\u6bcf\u4e2a\u7ec6\u8282\u90fd\u80fd\u8bf4\u660e" +
    "\u8fd9\u9879\u8fd0\u52a8\u7684\u590d\u6742\u5386\u53f2";
  for (const mode of ["trans", "bilingual"]) {
    const w = new OverlayDisplay(default_settings() as { [k: string]: unknown });
    w.mode = mode;
    w.order = "trans_first";
    w.trans_text = translation;
    w.orig_text = mode === "bilingual" ? "Original row" : "";
    w.trans_available = true;
    const plan = w.paint_plan();
    const rows = plan.events.filter((e) => e.kind === "text");
    assert.ok(rows.length >= 1, mode);
    assert.equal(rows[0]!.color, "#ffe082", mode);
    const area: Rect = { x: 0, y: 0, w: 220, h: 500 };
    for (const row of rows) {
      const r = wrap_text(row.text, area, mono, 0);
      for (const ln of r.lines) {
        assert.ok(mono.advance(ln) <= area.w, mode + " line beyond width: " + JSON.stringify(ln));
      }
    }
    if (mode === "bilingual") {
      assert.equal(rows.length, 2, mode);
      assert.equal(rows[1]!.color, "#ffffff", mode); // orig row
      assert.ok(rows[0]!.text.startsWith(TRANS_LABEL), mode);
      assert.ok(rows[1]!.text.startsWith(ORIG_LABEL), mode);
    }
  }
});

// ---- #174 appearance keys (scope-driven, no pytest source: Python never
// landed the keys; these pin the fallback-compatible consumption contract) ----

test("#174 keys fall back to today's hardcoded values when absent", () => {
  const log = paint("trans", "Original", "\u4f60\u597d", { trans_available: true });
  assert.deepEqual(colors(log), ["#ffe082"]);               // trans fallback 255,224,130
  const bilingual = paint("bilingual", "Hello", "\u4f60\u597d", { trans_available: true });
  assert.deepEqual(colors(bilingual), ["#ffe082", "#ffffff"]); // orig fallback 255,255,255
  const rows = bilingual.events.filter((e) => e.kind === "text") as Array<{ stroke_width: number; stroke_color: string; font_family: string }>;
  // display.stroke default 1.5 passes through (Python paint reads the key, not the 2.0 paint fallback)
  assert.ok(rows.every((r) => r.stroke_width === 1.5), JSON.stringify(rows.map((r) => r.stroke_width)));
  assert.ok(rows.every((r) => r.stroke_color === "#000000"));
  assert.ok(rows.every((r) => r.font_family === "Microsoft YaHei UI"));
});

test("#174 explicit values are consumed and stroke 0 disables the pen", () => {
  const cfg = default_settings() as { [k: string]: unknown };
  const disp = cfg["display"] as { [k: string]: unknown };
  disp["orig_text_color"] = [255, 0, 0];
  disp["trans_stroke_color"] = [10, 20, 30];
  disp["stroke"] = 0;
  const w = new OverlayDisplay(cfg);
  w.mode = "bilingual";
  w.orig_text = "Hi";
  w.trans_text = "\u4f60\u597d";
  w.trans_available = true;
  const rows = w.paint_plan().events.filter((e) => e.kind === "text") as Array<{ role: string; color: string; stroke_width: number; stroke_color: string }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.color, "#ff0000");        // orig row (trans_first)
  assert.equal(rows[1]!.stroke_color, "#000000"); // orig stroke unchanged
  assert.equal(rows[0]!.stroke_color, "#0a141e"); // trans stroke 10,20,30
  assert.equal(rows[0]!.stroke_width, 0);
});

test("failure red stays fixed regardless of trans_text_color", () => {
  const cfg = default_settings() as { [k: string]: unknown };
  (cfg["display"] as { [k: string]: unknown })["trans_text_color"] = [0, 255, 0];
  const w = new OverlayDisplay(cfg);
  w.mode = "trans";
  w.trans_available = true;
  w.trans_state = "failed:\u8bf7\u6c42\u53d7\u9650";
  w.orig_text = "Original";
  w.trans_text = "";
  const rows = w.paint_plan().events.filter((e) => e.kind === "text") as Array<{ color: string }>;
  assert.deepEqual(rows.map((r) => r.color), ["#ff5a5a"]);
});

