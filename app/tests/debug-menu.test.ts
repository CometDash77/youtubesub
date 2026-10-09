// 1:1 port of desktop/tests/test_debug_menu.py (ticket #205, map #181):
// the settings/debug window (three pages) and its menu entries. The App-level
// half (真实 settings 文件 + App() 壳) lands with the full-stack integration
// ticket (#206) - exactly like the ws-server-integration port did for
// project_status; what is testable now, headlessly, is the menu MODEL half
// and the whole DebugWindow behavior surface. Every pytest test function maps
// to exactly one test() below (the two App-driving ones pin the model
// contract the App shell must keep, registered below).
// Registered conversions (criteria #2):
//   - App()/monkeypatched S.load -> a plain DebugWindow over
//     S.default_settings() with an injected save seam (the window never
//     loads settings itself; the App shell owns that wiring in #206).
//   - monkeypatch.setattr(dw_mod, "_ask_unsaved_changes", ...) -> the
//     injectable ask_unsaved_changes seam (same three-way contract).
//   - window.isVisible() -> model .visible; isVisibleAfterClose asserts run
//     on the model (the host mirrors visibility onto the BrowserWindow).
//   - window._save_shortcut.key() == QKeySequence.Save -> the renderer's
//     keydown binding (source scan of debug-renderer.ts) + the model's
//     save_via_shortcut() path.
//   - QSS/pixel paint asserts -> the tokens.ts CSS contract (window_sheet +
//     qss) with the same numeric facts (opaque alpha 255, radius 24/12,
//     1px stroke); the renderer applies these classes verbatim.
//   - app.overlay._ctx_menu actions -> overlay_menu_model() entries (the
//     shared model, #172); App trigger -> open_or_reuse() reuse contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as S from "../lib/settings.ts";
import * as TOKENS from "../src/main/debug/tokens.ts";
import { overlay_menu_model } from "../src/main/overlay-menu.ts";
import {
  DebugWindow, open_or_reuse, CONFIRM_STAY, CONFIRM_SAVE, CONFIRM_DISCARD,
  PAGE_TITLES, PAGES, SHADOW_MARGIN, type ConfirmChoice,
} from "../src/main/debug/window.ts";

// The autouse fixture's stance: the close prompt must never block; tests
// that exercise it override the stub inside their own body.
function _answer(choice: ConfirmChoice,
                 seen?: Array<[boolean, boolean]>): (info: { settings_dirty: boolean; tuning_dirty: boolean }) => ConfirmChoice {
  return (info) => {
    if (seen !== undefined) seen.push([info.settings_dirty, info.tuning_dirty]);
    return choice;
  };
}

function _window(settings: S.Settings | null = null,
                 ask: ReturnType<typeof _answer> = _answer(CONFIRM_DISCARD)):
    [DebugWindow, S.Settings, S.Settings[]] {
  // 一个窗口 + 写盘替身（整窗保存只该写一次，替身用来数次数）。
  const writes: S.Settings[] = [];
  const cfg = settings ?? S.default_settings();
  const w = new DebugWindow(cfg, { port: 1, save: (c) => { writes.push(c); },
    ask_unsaved_changes: ask });
  return [w, cfg, writes];
}

test("menu offers both entries and they land on different pages", () => {
  // The menu-model half of the App test (the App shell itself lands with #206):
  // both entries exist, 重读设置 stays gone, all copy is Chinese, and the two
  // entries open ONE window landing on different pages (open_or_reuse).
  const entries = overlay_menu_model({ overlay_visible: true, click_through: false });
  const actions = new Map(entries.filter((e) => e.kind === "action")
    .map((e) => [(e as { label: string }).label, e]));
  assert.ok(actions.has("设置……") && actions.has("调试……"),
    [...actions.keys()].join(", "));
  assert.ok(!actions.has("重读设置"), [...actions.keys()].join(", "));
  const nonChinese = [...actions.keys()]
    .filter((t) => t.length > 0 && !/[一-鿿]/.test(t));
  assert.deepEqual(nonChinese, [], "菜单条目还有英文: " + nonChinese.join(", "));

  let made = 0;
  const first = open_or_reuse(null, "tuning", () => { made += 1; return _window()[0]; });
  assert.equal(made, 1);
  assert.equal(first.visible, true);
  assert.equal(first.current_page_name(), "tuning");
  // 第二个入口打开的是**同一个**窗口，只是落到设置页（#164 目标）。
  const second = open_or_reuse(first, "settings", () => { made += 1; return _window()[0]; });
  assert.equal(made, 1, "两个入口必须复用同一实例");
  assert.equal(second, first);
  assert.equal(first.current_page_name(), "settings");
});

test("every menu label says what it changes", () => {
  // #172:菜单文案要能自解释(换日常词 + 一句「点一下会怎样」),并且
  // 「鼠标穿透」在开 / 关两种状态下的说法都要对;退出仍然只有一颗。
  const off_model = overlay_menu_model({ overlay_visible: true, click_through: false });
  const labels = off_model.filter((e) => e.kind === "action").map((e) => (e as { label: string }).label);
  assert.ok(labels.length > 0, "菜单不能是空的");
  for (const t of labels) assert.ok(/[一-鿿]/.test(t), t);
  for (const t of labels) {
    if (t.endsWith("……")) continue;
    assert.ok(["调", "换", "显示", "顺序", "穿", "隐藏", "退出"].some((w) => t.includes(w)), t);
  }
  const off = (off_model.find((e) => e.kind === "action" && (e as { label: string }).label.includes("鼠标穿透")) as { label: string }).label;
  assert.ok(off.includes("鼠标穿透") && off.includes("Ctrl+Alt+U"));
  const on_model = overlay_menu_model({ overlay_visible: true, click_through: true });
  const on = (on_model.find((e) => e.kind === "action" && (e as { label: string }).label.includes("鼠标穿透")) as { label: string }).label;
  assert.ok(on.includes("已开启") && on.includes("Ctrl+Alt+U"));
  assert.notEqual(on, off, "开 / 关两种状态必须能一眼区分");
  const quits = off_model.filter((e) => e.kind === "action" && (e as { label: string }).label === "退出程序");
  assert.equal(quits.length, 1, labels.join(", "));
});

test("the shell is a modeless tool window with three pages", () => {
  const [window] = _window();
  try {
    // 非模态无父 Qt.Tool 面板:the model is a standalone instance owned by the
    // host (no parent), the BrowserWindow is created skipTaskbar + non-modal.
    assert.equal(window.current_page_name(), "tuning");
    assert.equal(window.settings_page !== undefined, true);
    assert.equal(window.tuning_page !== undefined, true);
    assert.equal(window.diag_page !== undefined, true);
    for (const [name, key] of [["settings", "settings"], ["diag", "diag"], ["tuning", "tuning"]] as const) {
      window.show_page(name);
      assert.equal(window.current_page_name(), name);
    }
    assert.deepEqual(PAGES.map((n) => PAGE_TITLES[n]), ["设置", "调参", "排障"]);
    assert.deepEqual([...PAGES], ["settings", "tuning", "diag"]);
    assert.throws(() => window.show_page("nope"), Error, "未知页名必须报错");
  } finally {
    window.close();
  }
});

test("switching pages keeps the uncommitted edits", () => {
  // #169 断言 ②:三页是常驻子控件,切页只改 index —— 未提交的编辑天然留着,
  // 不为「保留」写代码(页签也不标脏点)。
  const [window, , writes] = _window();
  try {
    window.show();
    window.show_page("tuning");
    window.tuning_page.set_field_value(["display", "history_lines"], 5);
    window.settings_page.set_model("gpt-kept");
    assert.deepEqual(window.dirty_counts(), [1, 1]);

    window.show_page("settings");
    assert.equal(window.settings_page.model, "gpt-kept");
    window.show_page("diag");
    window.show_page("tuning");
    assert.equal(window.tuning_page.field_value(["display", "history_lines"]), 5);
    assert.equal(window.is_dirty(), true, "切页不该把编辑弄丢(也不该弄脏)");
    assert.deepEqual(writes, []);
  } finally {
    window.close();
  }
});

test("the close affordance hides the frameless window", () => {
  const [window] = _window();
  window.show();
  assert.equal(window.visible, true);
  window.close();          // the renderer X button routes here (close intent)
  assert.equal(window.visible, false);
});

test("the window paints the documented opaque chrome", () => {
  // 外层 = 不透明奶油底 + 24 圆角 + 1px 内描边 + 48px 柔阴影,内层卡片保留。
  const [window] = _window();
  try {
    const sheet = TOKENS.window_sheet();
    const block = sheet.match(/#debugWindow\s*\{([^}]*)\}/);
    assert.ok(block, sheet);
    const rgba = block[1]!.match(/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*(\d+)\s*\)/);
    assert.ok(rgba, block[1] ?? sheet);
    assert.equal(Number(rgba![1]), 255, "窗口底必须不透明:透明/磨砂配方已废");
    assert.ok(block[1]!.includes("border-radius: " + TOKENS.RADIUS + "px"));
    assert.ok(/border:\s*1px solid rgba\(\s*\d+,\s*\d+,\s*\d+,\s*\d+\s*\)/.test(block[1]!),
      "1px 内描边");
    // 柔阴影 + 阴影边距(渲染层结构;模型钉数值)
    const html = fs.readFileSync(
      new URL("../src/renderer/debug.html", import.meta.url), "utf8");
    assert.ok(html.includes("padding: 24px"), "阴影需要边距,去掉就看不见了");
    assert.ok(html.includes("0 8px 48px"), "柔阴影两版都留");
    const card = TOKENS.qss().match(new RegExp('\\.debugCard\\s*\\{([^}]*)\\}'));
    assert.ok(card, "内层卡片保留(它是唯一的分组面)");
    assert.ok(card![1]!.includes(TOKENS.CARD), "内层卡片必须真的画成 token 色");
    assert.ok(card![1]!.includes("border-radius: 12px"));
    void window;
  } finally {
    window.close();
  }
});

test("the window is reusable after closing", () => {
  const [window] = _window();
  window.show_page("diag");
  window.show();
  window.close();
  assert.equal(window.visible, false);
  window.show_page("tuning");
  window.show();
  assert.equal(window.visible, true);
  assert.equal(window.current_page_name(), "tuning");
  window.close();
});

test("save commits both pages with exactly one write", () => {
  // #169 断言 ③:一次「保存」= 一次写盘,并让两页的改动都落下去。
  const [window, settings, writes] = _window();
  try {
    assert.equal(window.save_button_enabled, false);
    assert.equal(window.status_label_text, "没有未保存的改动");

    window.tuning_page.set_field_value(["prefetch", "lead_s"], 30.0);
    assert.equal(window.save_button_enabled, true);
    assert.equal(window.status_label_text, "有 1 项改动没保存");
    window.settings_page.set_model("gpt-test");
    assert.equal(window.status_label_text, "有 2 项改动没保存");

    assert.equal(window.save(), true);
    assert.equal(writes.length, 1, "整窗提交只许写一次盘");
    assert.equal((settings["prefetch"] as S.JsonObject)["lead_s"], 30.0);
    assert.equal((settings["provider"] as S.JsonObject)["model"], "gpt-test");
    assert.equal(window.is_dirty(), false);
    assert.equal(window.save_button_enabled, false);
    assert.equal(window.status_label_text, "没有未保存的改动");
  } finally {
    window.close();
  }
});

test("save without edits does not touch the file", () => {
  const [window, , writes] = _window();
  try {
    assert.equal(window.save(), false);
    assert.deepEqual(writes, []);
  } finally {
    window.close();
  }
});

test("cancel rolls both pages back", () => {
  const [window, settings, writes] = _window();
  try {
    window.tuning_page.set_field_value(["display", "history_lines"], 9);
    window.settings_page.set_api_key("sk-typo");
    assert.equal(window.is_dirty(), true);
    window.cancel();
    assert.equal(window.is_dirty(), false);
    assert.equal(window.tuning_page.field_value(["display", "history_lines"]), 2);
    assert.equal(window.settings_page.api_key, "");
    assert.equal((settings["display"] as S.JsonObject)["history_lines"], 2);
    assert.deepEqual(writes, []);
  } finally {
    window.close();
  }
});

test("the tuning page saves through the real settings object", () => {
  // 装配正确性:窗口里的调参页改的必须是同一份 settings(不是副本)。
  const [window, settings, writes] = _window();
  try {
    window.tuning_page.set_field_value(["prefetch", "lead_s"], 30.0);
    window.save();
    assert.equal((settings["prefetch"] as S.JsonObject)["lead_s"], 30.0);
    assert.equal(writes.length, 1);
    assert.equal(writes[0], settings);
  } finally {
    window.close();
  }
});

test("footer state tracks every edit in both pages", () => {
  const [window] = _window();
  try {
    window.settings_page.set_base_url("https://api.example.test/v1");
    assert.equal(window.status_label_text, "有 1 项改动没保存");
    window.diag_page.set_frequency(2.0);
    assert.equal(window.status_label_text, "有 1 项改动没保存",
      "排障页不参与脏状态(它只是看,不落盘)");
    assert.deepEqual(window.dirty_counts(), [1, 0]);
  } finally {
    window.close();
  }
});

test("ctrl_s saves without closing the window", () => {
  const [window, settings, writes] = _window();
  try {
    window.show();
    window.tuning_page.set_field_value(["display", "history_lines"], 4);
    // QKeySequence.Save -> the renderer keydown binding (Ctrl+S -> save intent)
    const src = fs.readFileSync(
      new URL("../src/renderer/debug-renderer.ts", import.meta.url), "utf8");
    assert.ok(src.includes("ctrlKey") && src.includes("ctrl-s"),
      "Ctrl+S 绑定在渲染层 keydown 上");
    window.save_via_shortcut();
    assert.equal(writes.length, 1);
    assert.equal((settings["display"] as S.JsonObject)["history_lines"], 4);
    assert.equal(window.visible, true, "Ctrl+S 只保存,不关窗(Esc 才是关窗)");
  } finally {
    window.close();
  }
});

test("reopening the window resnapshots the baseline", () => {
  // #169 断言 ⑥:窗口关掉之后外部把盘上的值改了,再打开时基线要重新取,
  // 不能拿构造时那一份旧快照当基准。
  const [window, settings] = _window();
  try {
    window.show();
    window.close();
    (settings["display"] as S.JsonObject)["history_lines"] = 9; // 外部改动(模拟手改文件后重载)
    window.show();
    assert.equal(window.current_page_name(), "tuning");
    assert.equal(window.tuning_page.field_value(["display", "history_lines"]), 9);
    assert.equal(window.is_dirty(), false, "重新打开 = 重新取基线");
  } finally {
    window.close();
  }
});

test("closing with unsaved changes asks first", () => {
  const seen: string[] = [];
  const [window, settings, writes] = _window(S.default_settings(),
    _answer(CONFIRM_STAY, undefined));
  // 「回去继续改」什么都不停:排障页的 stop 也必须没有发生。
  const dp = window.diag_page as unknown as { stop: () => void };
  const origStop = dp.stop.bind(window.diag_page);
  dp.stop = () => { seen.push("stopped"); void origStop; };
  try {
    window.show();
    window.settings_page.set_api_key("sk-half-typed");
    window.close();
    assert.equal(window.visible, true, "选「回去继续改」窗口必须留着");
    assert.equal(window.is_dirty(), true);
    assert.deepEqual(writes, []);
    assert.equal((settings["provider"] as S.JsonObject)["api_key"], "");
    assert.deepEqual(seen, [], "「回去继续改」什么都不停(排障页也不许停,否则成僵尸页)");
  } finally {
    dp.stop = origStop;
    const discard = _window(S.default_settings(), _answer(CONFIRM_DISCARD));
    discard[0].close();
  }
});

test("closing with discard throws the edits away", () => {
  const seen: Array<[boolean, boolean]> = [];
  const [window, settings, writes] = _window(S.default_settings(),
    _answer(CONFIRM_DISCARD, seen));
  try {
    window.show();
    window.settings_page.set_api_key("sk-half-typed");
    window.tuning_page.set_field_value(["prefetch", "lead_s"], 30.0);
    window.close();
    assert.equal(window.visible, false);
    assert.deepEqual(writes, []);
    assert.equal((settings["provider"] as S.JsonObject)["api_key"], "");
    assert.equal((settings["prefetch"] as S.JsonObject)["lead_s"], 90.0);
    assert.equal(window.is_dirty(), false, "放弃之后基线要重置");
    assert.deepEqual(seen, [[true, true]], "两页都脏时弹窗要点名两页");
  } finally {
    window.close();
  }
});

test("closing with save writes once then closes", () => {
  const [window, settings, writes] = _window(S.default_settings(),
    _answer(CONFIRM_SAVE));
  try {
    window.show();
    window.tuning_page.set_field_value(["prefetch", "lead_s"], 30.0);
    window.settings_page.set_mock(true);
    window.close();
    assert.equal(window.visible, false);
    assert.equal(writes.length, 1);
    assert.equal((settings["prefetch"] as S.JsonObject)["lead_s"], 30.0);
    assert.equal((settings["provider"] as S.JsonObject)["mock"], true);
    assert.equal(window.is_dirty(), false);
  } finally {
    window.close();
  }
});
