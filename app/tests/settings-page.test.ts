// 1:1 port of desktop/tests/test_settings_page.py (ticket #205, map #181):
// the settings page (#39 / ADR-010 preset model + the window absorption from
// map #164 / ticket #170). Assertions follow the two Python lines - control
// copy / preset model asserted on external behavior, persistence via
// page.apply() + page.snapshot() (there is no accept() any more).
// Every pytest test function maps to exactly one test() below.
// Registered conversions (criteria #2):
//   - Qt combo -> preset_items model (data null = group header; separator
//     flagged); itemData(i) -> preset_items[i].data.
//   - widget .text() copy asserts (buttons / card titles / rows & hints) ->
//     source scan of the bare-DOM renderer's static copy block, the repo's
//     established source-scan pattern (connection-test.test.ts:454). The
//     dynamic button states stay model asserts.
//   - QInputDialog (rename) -> injectable ask_new_name seam (headless); the
//     GUI path carries the typed name in the intent (renderer modal).
//   - monkeypatch P._do_post -> translate_group's opts.post injection
//     (registered in #202).
//   - json.dumps(p, sort_keys=True, ensure_ascii=False) fingerprints ->
//     stableStringify (same normalization semantics, page-internal).
//   - page_mod.P.build_instructions is P.build_instructions (identity) ->
//     _build_instructions_ref === P.build_instructions (the shim chain
//     resolves to the same module instance).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as P from "../lib/provider.ts";
import * as S from "../lib/settings.ts";
import {
  SettingsPage, _build_instructions_ref,
  PREVIEW_PREV_EXAMPLE, PREVIEW_NEXT_EXAMPLE,
} from "../src/main/debug/settings-page.ts";

const PREV_LABEL = "Previous line (context only, do not translate): ";
const NEXT_LABEL = "Next line (context only, do not translate): ";

type Cfg = S.Settings;

function page(settings: Cfg | null = null): SettingsPage {
  return new SettingsPage(settings ?? S.default_settings());
}

function ids(d: SettingsPage): Array<string | null> {
  return d.preset_items.map((it) => it.data);
}

function rendererSource(): string {
  return fs.readFileSync(
    new URL("../src/renderer/debug-renderer.ts", import.meta.url), "utf8");
}

test("settings surface uses the approved chinese copy", () => {
  const d = page();
  // Static button/card/row copy lives in the bare-DOM renderer (source scan).
  const src = rendererSource();
  for (const wanted of ["复制为自定义", "重命名", "删除", "测试连接", "取消测试",
    "携带上下文：把上一句、下一句也一起发给模型",
    "Mock 模式：不真的调用 API，只在试界面时用",
    "接口地址", "密钥", "模型名", "接口协议", "用哪套提示词",
    "提示词内容", "实际发出去的提示词", "测试进度", "测试报告"]) {
    assert.ok(src.includes(wanted), "renderer copy missing: " + wanted);
  }
  // combo group headers are model constants (they arrive via pushed state)
  const modelSrc = fs.readFileSync(
    new URL("../src/main/debug/settings-page.ts", import.meta.url), "utf8");
  for (const wanted of ["——— 内置 ———", "——— 我的预设 ———"]) {
    assert.ok(modelSrc.includes(wanted), "model combo copy missing: " + wanted);
  }
  // 内置预设名也过一遍「说人话」：不再是 Default / Literal / Natural。
  assert.deepEqual(
    d.preset_items.filter((it) => it.data !== null && !it.separator).map((it) => it.label)
      .filter((label) => ["标准", "直译", "口语"].includes(label)),
    ["标准", "直译", "口语"]);
  // 每个可编辑项都要有「一句改了会发生什么」（地图 #164 的判据）：8+ 条 hint。
  const hints = CRED_HINTS.concat(PROMPT_HINTS, [TEST_HINT]);
  assert.ok(hints.length >= 8, String(hints.length));
  for (const h of hints) assert.ok(h.length >= 8, h);
  assert.ok(!hints.some((h) => h.includes("seek") || h.includes("帧")), hints.join("|"));
  // rename modal copy (title/label/ok/cancel) lives in the renderer too.
  for (const wanted of ["重命名预设", "名称：", "确定", "取消"]) {
    assert.ok(src.includes(wanted), "renderer rename modal copy missing: " + wanted);
  }
});

const CRED_HINTS = [
  "服务商文档里的接口前缀，一般以 /v1 结尾",
  "服务商给你的那串 key，只写在本机设置文件里",
  "要调用哪个模型，照服务商文档里写的名字填",
  "不知道就留「auto」；连不通时再照服务商文档换一个",
  "勾上就不发真实请求、不花额度：只用来试界面",
];
const PROMPT_HINTS = [
  "内置的三套只读；想改就先「复制为自定义」",
  "这就是发给模型的指令；内置的只读，复制出来的才能改",
  "下面这段就是真正发出去的内容，改上面会立刻跟着变",
  "勾上翻译更连贯（模型能看到前后句），每次请求也更大",
];
const TEST_HINT = "测的是上面填的、还没保存的输入；不落盘、不动浮窗";

test("report localizes human labels but preserves machine and sample values", () => {
  const d = page();
  d._render_report({
    verdict: "mock",
    layers: [{ id: "L4", passed: null, code: null, title: "翻译可用",
               message: "已跳过", elapsed_ms: 0 }],
    skipped: ["step1", "step2"], attempts: 0,
    sample: { source: "The cat sat on the mat.", translation: "猫坐在垫子上" },
    model_list: { observed: true, total: 2, contains_model: false },
    warnings: ["MOCK_MASKS_REAL_CONFIG", "FUTURE_WARNING"],
    warning_messages: { MOCK_MASKS_REAL_CONFIG:
      "当前为 Mock 模式；已填写的真实配置本次不会被使用。" },
    notes: ["尚未验证 Alignment（N|line）协议；本次探测仅使用整行模式。"],
    snapshot: { base_url: "https://example.test/v1", model: "gpt-test" },
    quota_notice: "Mock 模式：未发送网络请求，也未消耗额度。",
  } as unknown as Parameters<SettingsPage["_render_report"]>[0]);
  const text = d.report_text;
  assert.ok(text.includes("结论：MOCK"));
  assert.ok(text.includes("-- L4 翻译可用 - 已跳过 (0 毫秒)"));
  assert.ok(text.includes("跳过：step1, step2"));
  assert.ok(text.includes("尝试次数：0"));
  assert.ok(text.includes("原文：The cat sat on the mat."));
  assert.ok(text.includes("译文：猫坐在垫子上"));
  assert.ok(text.includes("模型列表：2（包含所配模型：否）"));
  assert.ok(text.includes("警告：当前为 Mock 模式；已填写的真实配置本次不会被使用。"));
  assert.ok(text.includes("警告：FUTURE_WARNING"));
  assert.ok(text.includes("备注：尚未验证 Alignment（N|line）协议"));
  assert.ok(text.includes(
    "基于点击时的输入（base_url=https://example.test/v1，model=gpt-test）；未写入任何配置文件。"));
  assert.ok(text.includes("Mock 模式：未发送网络请求，也未消耗额度。"));
  assert.ok(!text.includes("Warning: MOCK_MASKS_REAL_CONFIG"));
  for (const [value, expected] of [[true, "是"], [null, "未知"]] as const) {
    d._render_report({
      model_list: { observed: true, total: 2, contains_model: value },
    } as unknown as Parameters<SettingsPage["_render_report"]>[0]);
    assert.ok(d.report_text.includes("模型列表：2（包含所配模型：" + expected + "）"));
  }
});

test("connection test progress copy is chinese", () => {
  class Tester {
    cancelled = false;
    last_report(): null { return null; }
    start(_snapshot: Record<string, unknown>, _on_done?: unknown): boolean { return true; }
    progress(): { running: boolean; step: number; elapsed_s: number } {
      return { running: true, step: 2, elapsed_s: 1.25 };
    }
    cancel(): void { this.cancelled = true; }
  }
  const tester = new Tester();
  const d = new SettingsPage(S.default_settings(), tester);
  d.click_test();
  assert.equal(d.progress_text, "启动中……");
  d.poll_progress();
  assert.equal(d.progress_text, "第 2/2 步 - 1.2 秒");
  d.click_cancel_test();
  assert.equal(tester.cancelled, true);
  assert.equal(d.progress_text, "已取消——进行中的请求仍会继续执行，其额度不退还");
  // 关窗清理走同一条路（#23 决策 19：窗口关掉就放弃进行中的运行）。
  tester.cancelled = false;
  d.cancel_test();
  assert.equal(tester.cancelled, true);
});

test("builtin selection locks editor and actions", () => {
  const d = page();
  assert.equal(d.preset_items[d.preset_index]?.data, "default");
  assert.equal(d.editor_readonly, true, "built-in text must be read-only");
  assert.equal(d.rename_btn_enabled, false, "built-ins cannot be renamed");
  assert.equal(d.delete_btn_enabled, false, "built-ins cannot be deleted");
  assert.equal(d.copy_btn_enabled, true, "copy-as-custom is the one way past the lock");
  // every built-in behaves the same
  for (const [pid, text] of [["literal", S.LITERAL_PROMPT_TEXT],
    ["natural", S.NATURAL_PROMPT_TEXT]] as const) {
    d.select_preset_id(pid);
    assert.equal(d.editor_readonly, true);
    assert.equal(d.rename_btn_enabled, false);
    assert.equal(d.delete_btn_enabled, false);
    assert.equal(d.editor_text, text);
  }
  // two groups are present: built-ins, then customs (empty but labelled)
  const all = ids(d);
  assert.equal(all[0], null);
  assert.deepEqual(all.slice(1, 4), ["default", "literal", "natural"]);
  assert.ok(all.slice(4).includes(null), "a separator/header divides the two groups");
});

test("group header click snaps selection back", () => {
  const d = page();
  const headerIdx = d.preset_items.findIndex((it) => it.data === null);
  d.select_preset_index(headerIdx); // header carries no preset id
  assert.equal(d.preset_items[d.preset_index]?.data, "default",
    "selection must snap back");
});

test("copy rename delete chain applies the right shape", () => {
  const s = S.default_settings();
  const d = new SettingsPage(s, null, () => "我的提示");

  // copy the built-in default -> new custom, selected, editable
  d.click_copy();
  const new_id = d.preset_items[d.preset_index]?.data as string;
  assert.ok(new_id && new_id.startsWith("prompt_") && new_id.length === "prompt_".length + 8);
  assert.equal(d.editor_readonly, false);
  assert.equal(d.rename_btn_enabled, true);
  assert.equal(d.delete_btn_enabled, true);
  const custom = d._presets.find((p) => p.id === new_id)!;
  assert.equal(custom.name, "标准 副本");
  assert.equal(custom.text, S.DEFAULT_PROMPT_TEXT);

  // a second copy from the same built-in gets the ordinal suffix
  d.select_preset_id("default");
  d.click_copy();
  assert.deepEqual(d._presets.map((p) => p.name), ["标准 副本", "标准 副本 2"]);

  // rename the first copy
  d.select_preset_id(new_id);
  d.click_rename();
  assert.equal(d._presets.find((p) => p.id === new_id)!.name, "我的提示");
  const comboItem = d.preset_items.find((it) => it.data === new_id)!;
  assert.equal(comboItem.label, "我的提示");

  // edit the custom text - lands in the working copy immediately
  d.set_prompt_text("Edited custom text.");
  assert.equal(d._presets.find((p) => p.id === new_id)!.text, "Edited custom text.");

  // nothing hit settings before apply()（编辑期间不碰引擎正在读的那份 dict）
  const promptNode = s["prompt"] as S.JsonObject;
  assert.ok(!("system" in promptNode) || promptNode["active"] === "default");
  assert.deepEqual(promptNode["presets"], []);

  // delete the OTHER copy (not the persisted active) - chain step
  const other_id = d._presets.find((p) => p.id !== new_id)!.id;
  d.select_preset_id(other_id);
  assert.equal(d.delete_btn_enabled, true);
  d.click_delete();
  assert.deepEqual(d._presets.map((p) => p.id), [new_id]);
  assert.equal(d.preset_items[d.preset_index]?.data, "default",
    "deleting a non-active preset returns to the active choice the page opened with");

  // apply -> persisted shape
  d.select_preset_id(new_id);
  assert.ok(d.apply().length > 0, "apply() must report the fields it wrote");
  const pr = s["prompt"] as S.JsonObject;
  assert.ok(!("system" in pr), "legacy key must never come back");
  assert.equal(pr["active"], new_id);
  assert.equal((pr["presets"] as unknown[]).length, 1,
    "the deleted copy must not be persisted");
  const mine = (pr["presets"] as S.JsonObject[])[0]!;
  assert.deepEqual(mine, { id: new_id, name: "我的提示", text: "Edited custom text." });
});

test("delete active custom falls back to default", () => {
  const s = S.default_settings();
  (s["prompt"] as S.JsonObject)["presets"] = [
    { id: "prompt_deadbee", name: "Doomed", text: "Doomed text." }];
  (s["prompt"] as S.JsonObject)["active"] = "prompt_deadbee";
  const d = page(s);
  assert.equal(d.preset_items[d.preset_index]?.data, "prompt_deadbee");
  assert.equal(d.editor_readonly, false);

  d.click_delete();
  assert.equal(d.preset_items[d.preset_index]?.data, "default",
    "deleting the active custom must fall back to default");
  assert.equal(d.editor_readonly, true, "editor locked again on the built-in");
  assert.equal(d.editor_text, S.DEFAULT_PROMPT_TEXT);
  assert.equal(d.preview_text, P.build_instructions(
    S.DEFAULT_PROMPT_TEXT, PREVIEW_PREV_EXAMPLE, PREVIEW_NEXT_EXAMPLE, 0),
    "preview must refresh immediately after the fallback");

  d.apply();
  assert.deepEqual(s["prompt"], { active: "default", presets: [], context_groups: 1 });
});

test("preview is byte identical to the production assembly", async () => {
  // The UI half of Testing Decision 5: the page preview and the system
  // translate_group actually sends, for the same (preset, ctx, expected_lines)
  // inputs, are byte-identical - and both come out of the SAME function object
  // (asserted by identity, not by comparing two hard-coded constants).
  assert.equal(_build_instructions_ref, P.build_instructions);

  const fakePostSeen: { payload?: unknown } = {};
  const fake_post = (_url: string, _headers: Record<string, string>,
                     payload: unknown, _timeout_s: number) => {
    fakePostSeen.payload = payload;
    return Promise.resolve({ status: 200, headers: {},
      bodyText: JSON.stringify({ choices: [{ message: { content: "ok" } }],
                                 output_text: "ok" }) });
  };

  const s = S.default_settings();
  (s["prompt"] as S.JsonObject)["presets"] = [
    { id: "prompt_11223344", name: "Mine", text: "MY CUSTOM TASK" }];
  (s["prompt"] as S.JsonObject)["active"] = "prompt_11223344";
  const d = page(s);
  assert.equal(d.context_groups, true); // default on

  const preview_on = d.preview_text;
  assert.equal(preview_on, P.build_instructions(
    "MY CUSTOM TASK", PREVIEW_PREV_EXAMPLE, PREVIEW_NEXT_EXAMPLE, 0));
  assert.ok(preview_on.includes(PREV_LABEL) && preview_on.includes(NEXT_LABEL));

  // production, same inputs -> byte-identical system on the wire
  const cfg = { base_url: "https://api.example.test/v1", api_key: "k",
                model: "m", protocol: "chat-completions",
                system: "MY CUSTOM TASK" };
  await P.translate_group(cfg as unknown as P.ProviderConfig, "a sentence",
    PREVIEW_PREV_EXAMPLE, PREVIEW_NEXT_EXAMPLE, 0, { post: fake_post });
  const payload = fakePostSeen.payload as { messages: Array<{ content: string }> };
  const wire_system = payload.messages[0]!.content;
  assert.equal(wire_system, preview_on,
    "preview and production must emit byte-identical systems");
  assert.equal(payload.messages[1]!.content, "a sentence");

  // switch state is visible in the preview
  d.set_context_groups(false);
  const preview_off = d.preview_text;
  assert.equal(preview_off, P.build_instructions("MY CUSTOM TASK", "", "", 0));
  assert.ok(!preview_off.includes(PREV_LABEL));
  assert.notEqual(preview_off, preview_on);
});

test("context groups checkbox round trip", () => {
  const d = page();
  assert.equal(d.context_groups, true); // default truthy

  d.set_context_groups(false);
  d.apply();
  assert.equal((d.settings["prompt"] as S.JsonObject)["context_groups"], 0);

  const d2 = page(d.settings);
  assert.equal(d2.context_groups, false);
  d2.set_context_groups(true);
  d2.apply();
  assert.equal((d2.settings["prompt"] as S.JsonObject)["context_groups"], 1);
});

test("edits stay out of settings until apply", () => {
  const s = S.default_settings();
  const d = page(s);
  d.click_copy();
  d.set_prompt_text("Unsaved draft.");
  assert.deepEqual((s["prompt"] as S.JsonObject)["presets"], [],
    "编辑期间不许碰那份 settings：引擎正在读它");
  d.snapshot();
  assert.equal(d.preset_items[d.preset_index]?.data, "default", "取消 = 回到盘上的活动预设");
  assert.equal(d.is_dirty(), false);
});

test("dirty counts only the fields that would be written", () => {
  const s = S.default_settings();
  (s["prompt"] as S.JsonObject)["presets"] = [
    { id: "prompt_aabbccdd", name: "Mine", text: "MINE" }];
  const d = page(s);
  assert.equal(d.is_dirty(), false);
  assert.equal(d.count_dirty(), 0);

  // 改一个字段 -> 恰好 1 项；改回原值 -> 又不脏（值相等不算脏，不用 dirty flag）
  d.set_model("gpt-test");
  assert.equal(d.count_dirty(), 1);
  d.set_model("");
  assert.equal(d.is_dirty(), false);

  // 活动预设改走再改回：同样不算脏
  d.select_preset_id("prompt_aabbccdd");
  assert.equal(d.is_dirty(), true);
  d.select_preset_id("default");
  assert.equal(d.is_dirty(), false);

  // 预设改个名字再改回：规范化比较（json 指纹）之后不该再算脏
  d.select_preset_id("prompt_aabbccdd");
  d._presets[0]!.name = "Renamed";
  assert.equal(d.count_dirty(), 2, "活动预设 + 预设名字各算一项");
  d._presets[0]!.name = "Mine";
  assert.equal(d.count_dirty(), 1, "名字改回来之后只剩「活动预设变了」这一项");
  d.select_preset_id("default");
  assert.equal(d.is_dirty(), false);

  // 勾一下 Mock 与上下文：各算一项
  d.set_mock(true);
  d.set_context_groups(false);
  assert.equal(d.count_dirty(), 2);
  d.set_mock(false);
  d.set_context_groups(true);
  assert.equal(d.count_dirty(), 0);
});

test("snapshot rolls every control back to the settings dict", () => {
  const s = S.default_settings();
  (s["provider"] as S.JsonObject)["api_key"] = "sk-on-disk";
  const d = page(s);
  d.set_base_url("https://elsewhere.test/v1");
  d.set_api_key("sk-typo");
  d.set_protocol("responses");
  d.set_mock(true);
  d.set_context_groups(false);
  assert.equal(d.count_dirty(), 5);

  d.cancel();
  assert.equal(d.is_dirty(), false);
  assert.equal(d.base_url, "");
  assert.equal(d.api_key, "sk-on-disk", "密钥要回滚到那份 settings 里的值");
  assert.equal(d.protocol, "auto");
  assert.equal(d.mock, false);
  assert.equal(d.context_groups, true);
});
