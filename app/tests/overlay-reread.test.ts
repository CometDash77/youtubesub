// Equivalence port of desktop/tests/test_overlay_reread.py (ticket #204).
//
// 地图 #152 / 实施票 #158 -- 浮窗「重读设置」入口（spec #161 生效语义）。
// 调参页在点「确定」后调用它，让浮窗在不重启的前提下换脸；除此之外浮窗的
// 其它状态（历史行、文本、几何、点击穿透）一律不许被动到。
//
// Conversion register: the pytest monkeypatch.setattr(S, "save", ...) seam is
// the deps.save injection (constructor dep, #202/#203 precedent); the module
// default is a no-op here, and the spy observes that reread never saves.
// History equality is asserted field-by-field (length + element reads) per
// the deepEqual-narrowing pit from the CI forensics.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OverlayDisplay } from "../lib/overlay.ts";
import { default_settings, type Settings } from "../lib/settings.ts";

test("reread settings picks up mode and order and keeps the rest", () => {
  const cfg = default_settings() as Settings;
  const w = new OverlayDisplay(cfg as { [k: string]: unknown });
  w.history.push(["orig line", "trans line"]);
  w.orig_text = "orig";
  w.trans_text = "trans";

  (cfg["display"] as { [k: string]: unknown })["mode"] = "trans";
  (cfg["display"] as { [k: string]: unknown })["order"] = "orig_first";
  w.reread_settings();

  assert.equal(w.mode, "trans");
  assert.equal(w.order, "orig_first");
  assert.equal(w.history.length, 1);
  assert.deepEqual(w.history[0], ["orig line", "trans line"]);
  assert.equal(w.orig_text, "orig");
  assert.equal(w.trans_text, "trans");
});

test("reread settings falls back like the constructor", () => {
  const cfg = default_settings() as Settings;
  const w = new OverlayDisplay(cfg as { [k: string]: unknown });
  cfg["display"] = {};
  w.reread_settings();
  assert.equal(w.mode, "bilingual");
  assert.equal(w.order, "trans_first");
});

test("reread settings never saves", () => {
  const cfg = default_settings() as Settings;
  const saved: unknown[] = [];
  const w = new OverlayDisplay(cfg as { [k: string]: unknown }, {
    save: () => { saved.push(1); },
  });
  (cfg["display"] as { [k: string]: unknown })["mode"] = "orig";
  w.reread_settings();
  assert.equal(saved.length, 0);
  assert.equal(w.mode, "orig");
});
