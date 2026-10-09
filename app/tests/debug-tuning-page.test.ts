// 1:1 port of desktop/tests/test_debug_tuning_page.py (ticket #205, map #181):
// the tuning page. Assertions look only at external behavior: control ranges
// and copy, what apply() writes into the settings object, dirty counting,
// whether the changed notification fired - control class names and QSS colors
// are never asserted. Every pytest test function maps to exactly one test()
// below.
// Registered conversions (criteria #2):
//   - Qt widgets -> the headless control model; findChildren(QSlider) ->
//     slider_controls() / control_view(path).
//   - page.set_field_value path keys stay [section, key] arrays (TuningPath).
//   - the color dialog seam is injected at construction (headless default
//     cancels); clicking the color button is click_color_button(path).
//   - repr(cfg) before/after -> JSON.stringify(cfg) (key order is stable for
//     an untouched object in both languages).
//   - "no credential text is rendered" -> the page's full render model
//     (groups + control views) never contains the secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../lib/settings.ts";
import { TuningPage } from "../src/main/debug/tuning-page.ts";

type Cfg = S.Settings;

function page(cfg: Cfg | null = null): [TuningPage, Cfg] {
  const c = cfg ?? S.default_settings();
  return [new TuningPage(c), c];
}

test("controls expose the spec ranges", () => {
  const [p] = page();
  assert.equal(p.field_value(["display", "history_lines"]), 2);
  p.set_field_value(["display", "history_lines"], 999);
  assert.equal(p.field_value(["display", "history_lines"]), 10);
  p.set_field_value(["display", "history_lines"], -5);
  assert.equal(p.field_value(["display", "history_lines"]), 0);
  p.set_field_value(["display", "stroke"], 99.0);
  assert.equal(p.field_value(["display", "stroke"]), 10.0);
  p.set_field_value(["provider", "max_concurrent"], 0);
  assert.equal(p.field_value(["provider", "max_concurrent"]), 1);
  p.set_field_value(["display", "mode"], "trans");
  assert.equal(p.field_value(["display", "mode"]), "trans");
  p.set_field_value(["display", "mode"], "nonsense");
  assert.equal(p.field_value(["display", "mode"]), "bilingual");
  p.set_field_value(["display", "bg_color"], [300, -1, 7]);
  assert.deepEqual(p.field_value(["display", "bg_color"]), [255, 0, 7]);
});

test("opening a hand broken file shows clamped values", () => {
  const cfg = S.default_settings();
  (cfg["provider"] as S.JsonObject)["timeout_s"] = "abc";
  (cfg["display"] as S.JsonObject)["bg_opacity"] = 999;
  (cfg["display"] as S.JsonObject)["bg_color"] = [300, 0, 0];
  (cfg["display"] as S.JsonObject)["mode"] = "bogus";
  const [p] = page(cfg);
  assert.equal(p.field_value(["provider", "timeout_s"]), 60.0);
  assert.equal(p.field_value(["display", "bg_opacity"]), 255);
  assert.deepEqual(p.field_value(["display", "bg_color"]), [255, 0, 0]);
  assert.equal(p.field_value(["display", "mode"]), "bilingual");
});

test("apply writes only the edited keys", () => {
  const cfg = S.default_settings();
  (cfg["display"] as S.JsonObject)["font_size"] = 99; // 手写的越界值：没动就不许改它
  (cfg["prefetch"] as S.JsonObject)["draft_note"] = "keep me";
  const [p] = page(cfg);
  p.set_field_value(["prefetch", "lead_s"], 30.0);
  assert.deepEqual(p.apply(), [["prefetch", "lead_s"]]);
  assert.equal((cfg["prefetch"] as S.JsonObject)["lead_s"], 30.0);
  assert.equal((cfg["display"] as S.JsonObject)["order"], "trans_first");
  assert.equal((cfg["batch"] as S.JsonObject)["max_chars"], 8000);
  assert.equal((cfg["display"] as S.JsonObject)["font_size"], 99);
  assert.equal((cfg["prefetch"] as S.JsonObject)["draft_note"], "keep me");
});

test("apply without edits touches nothing", () => {
  const [p, cfg] = page();
  const before = JSON.stringify(cfg);
  assert.deepEqual(p.apply(), []);
  assert.equal(p.count_dirty(), 0);
  assert.equal(JSON.stringify(cfg), before);
});

test("cancel discards everything", () => {
  const [p, cfg] = page();
  p.set_field_value(["prefetch", "lead_s"], 30.0);
  assert.equal(p.is_dirty(), true);
  p.cancel();
  assert.equal((cfg["prefetch"] as S.JsonObject)["lead_s"], 90.0);
  assert.equal(p.field_value(["prefetch", "lead_s"]), 90.0);
  assert.equal(p.is_dirty(), false);
});

test("applied display fields are the ones the overlay has to repaint", () => {
  // 整窗保存时窗口只对 notify_overlay 的字段喊浮窗重画（#167 决议）。
  const [p] = page();
  for (const path of [["display", "font_size"], ["display", "mode"], ["display", "order"],
    ["display", "stroke"], ["display", "bg_color"], ["display", "bg_opacity"],
    ["display", "font_bold"]] as S.TuningPath[]) {
    assert.equal(S.field_by_path(path).notify_overlay, true, JSON.stringify(path));
  }
  assert.equal(S.field_by_path(["prefetch", "lead_s"]).notify_overlay, false);
  assert.equal(S.field_by_path(["display", "history_lines"]).notify_overlay, false);
  void p;
});

test("order is disabled outside bilingual but keeps its value", () => {
  const [p, cfg] = page();
  assert.equal(p.is_field_enabled(["display", "order"]), true);
  p.set_field_value(["display", "order"], "orig_first");
  p.set_field_value(["display", "mode"], "trans");
  assert.equal(p.is_field_enabled(["display", "order"]), false);
  assert.equal(p.field_value(["display", "order"]), "orig_first");
  p.apply();
  assert.equal((cfg["display"] as S.JsonObject)["order"], "orig_first");
  assert.equal((cfg["display"] as S.JsonObject)["mode"], "trans");
  p.set_field_value(["display", "mode"], "bilingual");
  assert.equal(p.is_field_enabled(["display", "order"]), true);
});

test("seek is shown in seconds and stored in milliseconds", () => {
  const [p, cfg] = page();
  assert.equal(p.field_value(["prefetch", "seek_debounce_ms"]), 0.4);
  p.set_field_value(["prefetch", "seek_debounce_ms"], 0.5);
  p.apply();
  assert.equal((cfg["prefetch"] as S.JsonObject)["seek_debounce_ms"], 500);
});

test("opacity is a slider and a number box that stay in sync", () => {
  // spec #161 字段表：背景不透明度 = 滑条 + 数字框（用户故事 18）。
  const [p, cfg] = page();
  const sliders = p.slider_controls();
  assert.equal(sliders.length, 1, "只有背景不透明度这一项带滑条");
  const path = sliders[0]!;
  const view = p.control_view(path);
  assert.equal(view.slider, 150);
  assert.equal(view.spin, 150);
  p.set_field_value(path, 200);
  assert.equal(p.field_value(path), 200);
  assert.equal(p.control_view(path).slider, 200, "改数字框时滑条跟着走");
  p.set_field_value(path, 40);
  assert.equal(p.control_view(path).slider, 40, "改滑条（经同一入口）时数字框跟着走");
  p.apply();
  assert.equal((cfg["display"] as S.JsonObject)["bg_opacity"], 40);
});

test("font size lives in the display group with the authority range", () => {
  // #167 归位：字号补进权威表并归「显示」组（此前只有设置对话框有它）。
  const field = S.field_by_path(["display", "font_size"]);
  assert.equal(field.group, "display");
  assert.deepEqual([field.control, field.min, field.max, field.step], ["int", 6, 40, 1]);
  assert.deepEqual(S.TUNING_FIELDS[0]!.path, ["display", "font_size"], "显示组第一项就是字号");
  const [p, cfg] = page();
  p.set_field_value(["display", "font_size"], 999);
  assert.equal(p.field_value(["display", "font_size"]), 40);
  p.apply();
  assert.equal((cfg["display"] as S.JsonObject)["font_size"], 40);
});

test("dirty counts only what apply would write", () => {
  const [p] = page();
  assert.equal(p.is_dirty(), false);
  assert.equal(p.count_dirty(), 0);
  p.set_field_value(["display", "history_lines"], 5);
  assert.equal(p.count_dirty(), 1);
  p.set_field_value(["display", "history_lines"], 2); // 改回原值
  assert.equal(p.is_dirty(), false, "值相等不算脏（不是 dirty flag）");
  p.set_field_value(["display", "mode"], "trans");
  p.set_field_value(["prefetch", "lead_s"], 30.0);
  assert.equal(p.count_dirty(), 2);
});

test("snapshot rolls the controls back to the settings dict", () => {
  const [p, cfg] = page();
  p.set_field_value(["display", "history_lines"], 5);
  p.apply();
  assert.equal((cfg["display"] as S.JsonObject)["history_lines"], 5);
  p.set_field_value(["display", "history_lines"], 7);
  assert.equal(p.is_dirty(), true);
  p.snapshot(); // 打开窗口 / 保存成功后的再快照
  assert.equal(p.field_value(["display", "history_lines"]), 5);
  assert.equal(p.is_dirty(), false);
});

test("every edit fires the changed notification", () => {
  // 窗口页脚的「保存」可用态靠这条通知刷新 —— 编辑不通知，按钮就永远点不了。
  const [p] = page(null);
  const seen: number[] = [];
  p.on_changed(() => seen.push(1));
  p.set_field_value(["display", "history_lines"], 5);  // 数字框
  p.set_field_value(["display", "mode"], "trans");      // 下拉
  p.set_field_value(["display", "bg_opacity"], 40);     // 滑条 + 数字框
  assert.ok(seen.length >= 3, String(seen.length));
  // 取色按钮也接了线（点它会弹真模态取色器，这里把取色替身换成「取消」）
  const cancelPick = new TuningPage(S.default_settings(), () => null);
  let clicks = 0;
  cancelPick.on_changed(() => clicks += 1);
  cancelPick.click_color_button(["display", "bg_color"]);
  assert.ok(clicks >= 1, "点取色按钮本身也要通知（无论选没选色）");
  void p;
});

test("group titles and hints match the spec", () => {
  const [p] = page();
  assert.equal(p.group_title("display"), "显示");
  assert.equal(p.group_title("network"), "网络与服务");
  assert.ok(p.group_title("experimental").includes("未校准"));
  // 重启生效 / 未校准 由页面统一补成徽标，字段自己的 hint 只写「改了会发生什么」。
  assert.ok(p.hint_for(["provider", "max_concurrent"]).endsWith("重启后生效"));
  assert.ok(p.hint_for(["server", "port"]).endsWith("重启后生效"));
  assert.ok(p.hint_for(["display", "stroke"]).startsWith("给字加一圈黑边"));
  for (const field of S.TUNING_FIELDS) {
    const hint = p.hint_for(field.path);
    assert.ok(hint, JSON.stringify(field.path));
    if (field.uncalibrated) assert.ok(hint.includes("未校准"), JSON.stringify(field.path));
    if (field.restart) assert.ok(hint.endsWith("重启后生效"), JSON.stringify(field.path));
  }
});

test("no credential path is reachable or rendered", () => {
  const cfg = S.default_settings();
  (cfg["provider"] as S.JsonObject)["api_key"] = "sk-secret-do-not-render";
  const [p] = page(cfg);
  for (const path of [["provider", "api_key"], ["provider", "base_url"], ["provider", "model"],
    ["provider", "protocol"], ["window", "w"], ["prompt", "active"]] as S.TuningPath[]) {
    assert.throws(() => p.set_field_value(path, "x" as unknown as S.Json),
      JSON.stringify(path) + " must not be settable from the tuning page");
  }
  const rendered = JSON.stringify([
    p.groups().map((g) => g.fields.map((f) => ({
      label: p.label_text(f),
      hint: p.hint_for(f.path),
      control: p.control_view(f.path),
      color: f.control === "color" ? p.color_text(p.field_value(f.path) as number[]) : "",
    }))),
  ]);
  assert.ok(!rendered.includes("sk-secret-do-not-render"));
});
