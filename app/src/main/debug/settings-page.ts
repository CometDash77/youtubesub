// Port of desktop/suboverlay/settings_page.py - the settings page: credentials,
// prompts and the connection test (map #164 / ticket #170, from the former
// modal SettingsDialog).
//
// The page owns exactly the 8 write-channel fields' collection, rollback and
// apply, and answers "was anything edited". It does NOT use
// settings.apply_edits: that authority table only knows TUNING_FIELDS keys and
// would raise on provider.* / prompt.* - so this page builds its own snapshot,
// compared over exactly those 8 fields (presets compared through json
// normalization). The window-level "N unsaved edits" = this page + tuning page.
//
// While editing, self.settings is NEVER touched (the engine is reading that
// dict): edits live in the controls and the presets working copy only;
// apply() writes them in on Save.
//
// Conversion notes (ticket #205):
//   - Qt widgets/signals -> headless model + changed listener list; internal
//     reloads (blockSignals paths) never fire changed, user edits do.
//   - _ask_new_name is an injectable seam (module-level stub seam in Python);
//     headless default returns "" (cancelled).
//   - The 200ms progress QTimer is an injectable {start,stop} seam (tests
//     drive poll_progress() manually; the host wires a real interval).
//   - json.dumps(p, sort_keys=True, ensure_ascii=False) -> stableStringify
//     (recursively key-sorted, non-ASCII kept literal).
//   - "%.1f" % elapsed_s is Python round-half-even; py_fixed1 replicates it
//     (1.25 -> "1.2", not toFixed's "1.3").
import { randomUUID } from "node:crypto";
import * as S from "../settings.ts";
import * as P from "../provider.ts";
import type { TestReport, TestSnapshot, ProgressState } from "../connection-test.ts";

// Preview neighbors use example text: on a real send these would be the
// previous/next group - the window cannot see real context, so these two
// placeholders demonstrate what the context switch does (#39 decision 5).
export const PREVIEW_PREV_EXAMPLE = "(previous group)";
export const PREVIEW_NEXT_EXAMPLE = "(next group)";

// Card titles and the one-line explanation per item (bar: someone who never
// read the docs can say what changing it does).
export const CARD_CREDENTIALS = "接口凭据（服务商给你的那几项）";
export const CARD_PROMPT = "提示词（决定翻译的风格）";
export const CARD_TEST = "测试连接（用上面这些还没保存的输入试一次）";

export interface PageTester {
  start(snapshot: TestSnapshot, on_done?: (report: TestReport) => void): boolean;
  progress(): ProgressState;
  cancel(): void;
  last_report(): TestReport | null;
}

// Preview == production by construction: the exact function object the page
// assembles previews with (identity-tested; the shim chain resolves to the
// same module instance as every production consumer).
export const _build_instructions_ref = P.build_instructions;

export interface PresetComboItem {
  label: string;
  data: string | null;   // null = group header (never a preset id)
  separator: boolean;
}

export interface AskNewName {
  (initial: string): string;
}

// json.dumps(p, sort_keys=True, ensure_ascii=False) equivalent.
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k])).join(",") + "}";
}

// "%.1f" with Python's round-half-even (1.25 -> "1.2").
export function py_fixed1(v: number): string {
  const scaled = v * 10;
  const f = Math.floor(scaled);
  const d = scaled - f;
  let r: number;
  if (d > 0.5) r = f + 1;
  else if (d < 0.5) r = f;
  else r = f % 2 === 0 ? f : f + 1;
  return (r / 10).toFixed(1);
}

export interface PresetWorkingCopy {
  id: string;
  name: string;
  text: string;
}

export class SettingsPage {
  readonly settings: S.Settings;
  readonly tester: PageTester | null;
  private _ask_new_name: AskNewName;
  private _poll_timer: { start(): void; stop(): void };
  // Working copy (public for the tests that poke it, like the Python ones).
  _presets: PresetWorkingCopy[];
  private _active: string;
  private _persisted_active: string;
  private _baseline: Record<string, unknown>;
  private _changed_listeners: Array<() => void> = [];

  // ---- control state (the bare-DOM renderer mirrors these) ----
  base_url = "";
  api_key = "";
  model = "";
  protocol = "auto";
  mock = false;
  context_groups = true;
  preset_items: PresetComboItem[] = [];
  preset_index = -1;
  editor_text = "";
  editor_readonly = true;
  copy_btn_enabled = true;
  rename_btn_enabled = false;
  delete_btn_enabled = false;
  preview_text = "";
  progress_text = "";
  test_btn_enabled = true;
  cancel_btn_enabled = false;
  report_text = "";

  constructor(settings: S.Settings, tester: PageTester | null = null,
              ask_new_name: AskNewName | null = null,
              poll_timer: { start(): void; stop(): void } | null = null) {
    this.settings = settings;
    this.tester = tester;
    this._ask_new_name = ask_new_name ?? (() => "");
    this._poll_timer = poll_timer ?? { start() {}, stop() {} };
    const prov = S.isJsonObject(settings["provider"]) ? settings["provider"] as S.JsonObject : {};
    const prompt = S.isJsonObject(settings["prompt"]) ? settings["prompt"] as S.JsonObject : {};
    this._presets = (Array.isArray(prompt["presets"]) ? prompt["presets"] : [])
      .filter((p): p is S.JsonObject => S.isJsonObject(p))
      .map((p) => ({
        id: String(p["id"] ?? ""),
        name: String(p["name"] ?? ""),
        text: String(p["text"] ?? ""),
      }));
    this._active = (prompt["active"] as string) || "default";
    if (this._find_custom(this._active) === null && !this._is_builtin_id(this._active)) {
      this._active = "default";
    }
    // The active preset at open time. Deleting a NON-active preset falls back
    // to this, not to default - only deleting the ACTIVE custom lands on
    // default (#39 D5).
    this._persisted_active = this._active;
    // Python's __init__ builds the controls WITH the settings' values (the
    // QLineEdit constructors take them); load them before taking the baseline.
    const prov0 = S.isJsonObject(settings["provider"]) ? settings["provider"] as S.JsonObject : {};
    const prompt0 = S.isJsonObject(settings["prompt"]) ? settings["prompt"] as S.JsonObject : {};
    this.base_url = String(prov0["base_url"] ?? "");
    this.api_key = String(prov0["api_key"] ?? "");
    this.model = String(prov0["model"] ?? "");
    this.protocol = String(prov0["protocol"] ?? "auto");
    this.mock = Boolean(prov0["mock"]);
    this.context_groups = Boolean(prompt0["context_groups"] ?? 1);
    this._build();
    this._baseline = this.state();
  }

  // ---- the three things the window footer needs: dirty, count, apply ----

  // The current values on this page's 8-field write channel (controls +
  // presets working copy).
  state(): Record<string, unknown> {
    return {
      base_url: this.base_url.trim(),
      api_key: this.api_key,
      model: this.model.trim(),
      protocol: this.protocol,
      mock: this.mock,
      active: this._normalized_active(),
      presets: this._preset_fingerprints(),
      context_groups: this.context_groups,
    };
  }

  // Fields not yet on disk (the footer's "N unsaved edits" line).
  count_dirty(): number {
    const now = this.state();
    let n = 0;
    for (const key of STATE_KEYS) {
      if (!deepEq(now[key], this._baseline[key])) n += 1;
    }
    return n;
  }

  is_dirty(): boolean {
    return this.count_dirty() > 0;
  }

  // Write this page's edits into the settings object (no disk write);
  // returns the changed field names.
  apply(): string[] {
    const now = this.state();
    const changed = STATE_KEYS.filter((key) => !deepEq(now[key], this._baseline[key]));
    if (changed.length === 0) return [];
    const prov = this.settings["provider"] as S.JsonObject;
    prov["base_url"] = this.base_url.trim();
    prov["api_key"] = this.api_key;
    prov["model"] = this.model.trim();
    prov["protocol"] = this.protocol;
    prov["mock"] = this.mock;
    // One-way schema (#39): the legacy "system" key is never written back.
    this.settings["prompt"] = {
      active: this._normalized_active(),
      presets: this._presets.map((p) => ({ ...p })),
      context_groups: this.context_groups ? 1 : 0,
    };
    return [...changed];
  }

  // Re-take the baseline and load the controls back from the settings
  // (window opened / save succeeded / cancelled).
  snapshot(): void {
    const prompt = S.isJsonObject(this.settings["prompt"]) ? this.settings["prompt"] as S.JsonObject : {};
    const prov = S.isJsonObject(this.settings["provider"]) ? this.settings["provider"] as S.JsonObject : {};
    this.base_url = String(prov["base_url"] ?? "");
    this.api_key = String(prov["api_key"] ?? "");
    this.model = String(prov["model"] ?? "");
    this.protocol = String(prov["protocol"] ?? "auto");
    this.mock = Boolean(prov["mock"]);
    this.context_groups = Boolean(prompt["context_groups"] ?? 1);
    this._presets = (Array.isArray(prompt["presets"]) ? prompt["presets"] : [])
      .filter((p): p is S.JsonObject => S.isJsonObject(p))
      .map((p) => ({
        id: String(p["id"] ?? ""),
        name: String(p["name"] ?? ""),
        text: String(p["text"] ?? ""),
      }));
    this._active = (prompt["active"] as string) || "default";
    if (this._find_custom(this._active) === null && !this._is_builtin_id(this._active)) {
      this._active = "default";
    }
    this._persisted_active = this._active;
    this._rebuild_preset_combo();
    this._load_active_into_editor();
    this._refresh_preview();
    this._baseline = this.state();
  }

  // Discard this page's unsaved edits (back to the settings' current values).
  cancel(): void {
    this.snapshot();
  }

  // Window-close cleanup: give up an in-flight test (#23 decision 19). Idempotent.
  cancel_test(): void {
    if (this.tester !== null) this.tester.cancel();
    this._poll_timer.stop();
  }

  // ---- changed signal ----

  on_changed(cb: () => void): void {
    this._changed_listeners.push(cb);
  }

  private _emit_changed(): void {
    for (const cb of this._changed_listeners) cb();
  }

  // ---- user-edit entry points (the DOM forwards intents here) ----

  set_base_url(v: string): void { this.base_url = v; this._emit_changed(); }
  set_api_key(v: string): void { this.api_key = v; this._emit_changed(); }
  set_model(v: string): void { this.model = v; this._emit_changed(); }
  set_protocol(v: string): void { if (v !== this.protocol) { this.protocol = v; this._emit_changed(); } }
  set_mock(v: boolean): void { if (v !== this.mock) { this.mock = v; this._emit_changed(); } }
  set_context_groups(v: boolean): void {
    // toggled fires only on an actual flip (Qt semantics).
    if (v === this.context_groups) return;
    this.context_groups = v;
    this._refresh_preview();
  }

  // Selecting a combo entry as a user would. Header entries (data null) snap
  // the selection back to the real choice - silently, like blockSignals.
  select_preset_index(index: number): void {
    this.preset_index = index;
    const pid = this._current_id();
    if (pid === null) {
      const back = this.preset_items.findIndex((it) => it.data === this._active);
      if (back >= 0) this.preset_index = back;
      return;
    }
    this._active = pid;
    this._load_active_into_editor();
    this._refresh_preview();
    this._emit_changed();
  }

  select_preset_id(id: string): void {
    const idx = this.preset_items.findIndex((it) => it.data === id);
    if (idx >= 0) this.select_preset_index(idx);
  }

  // Typing in the prompt editor: only custom presets are editable; built-ins
  // are read-only.
  set_prompt_text(text: string): void {
    if (!this._is_builtin_current()) {
      const custom = this._find_custom(this._current_id() as string);
      if (custom !== null) custom.text = text;
    }
    this.editor_text = text;
    this._refresh_preview();
  }

  click_copy(): void { this._copy_preset(); }

  // Rename entry point. The GUI path carries the typed name (the renderer
  // shows its own modal - Electron has no synchronous text-input dialog);
  // the headless path falls back to the ask_new_name seam (the monkeypatch
  // seam the Python tests stub).
  click_rename(name?: string): void {
    if (name !== undefined) {
      this._rename_with(name);
    } else {
      this._rename_preset();
    }
  }

  click_delete(): void { this._delete_preset(); }

  // ---- connection test (#23) ----

  click_test(): void {
    // Snapshot semantics (#23): runs the inputs the controls hold at click
    // time; nothing is written, nothing auto-fires.
    if (this.tester === null) return;
    const snap: TestSnapshot = {
      base_url: this.base_url.trim(),
      api_key: this.api_key,
      model: this.model.trim(),
      protocol: this.protocol,
      system: this.editor_text,
      mock: this.mock,
    };
    if (!this.tester.start(snap, (report) => this._show_report(report))) {
      return; // single-flight: one run already going
    }
    this.test_btn_enabled = false;
    this.cancel_btn_enabled = true;
    this.progress_text = "启动中……";
    this._poll_timer.start();
  }

  click_cancel_test(): void {
    // Cancel = just stop waiting: the HTTP request is not interrupted and its
    // quota is not refunded - say exactly that, do not imply a rollback.
    if (this.tester === null) return;
    this.tester.cancel();
    this._poll_timer.stop();
    this.test_btn_enabled = true;
    this.cancel_btn_enabled = false;
    this.progress_text = "已取消——进行中的请求仍会继续执行，其额度不退还";
  }

  poll_progress(): void {
    const p = this.tester!.progress();
    if (p.running) {
      const step = Math.max(1, Math.min(2, Math.trunc(p.step || 1)));
      this.progress_text = "第 " + step + "/2 步 - " + py_fixed1(p.elapsed_s) + " 秒";
    } else {
      this._poll_timer.stop();
    }
  }

  // ---- presets working set (#39 / ADR-010) ----

  private _normalized_active(): string {
    let active = this._current_id() || "default";
    if (!this._is_builtin_id(active) && this._find_custom(active) === null) {
      active = "default";
    }
    return active;
  }

  private _preset_fingerprints(): string[] {
    return this._presets.map((p) => stableStringify(p)).sort();
  }

  private _find_custom(pid: string): PresetWorkingCopy | null {
    for (const p of this._presets) {
      if (p.id === pid) return p;
    }
    return null;
  }

  private _is_builtin_id(pid: string): boolean {
    return S.BUILTIN_PROMPTS.some((b) => b.id === pid);
  }

  private _is_builtin_current(): boolean {
    return this._is_builtin_id(this._current_id() ?? "");
  }

  private _current_id(): string | null {
    const it = this.preset_items[this.preset_index];
    return it ? it.data : null;
  }

  private _rebuild_preset_combo(): void {
    // Two groups: built-ins first (locked), customs after. The selected entry
    // lands back on the current active id.
    const keep = this._active;
    this.preset_items = [
      { label: "——— 内置 ———", data: null, separator: false },
      ...S.BUILTIN_PROMPTS.map((b) => ({ label: b.name, data: b.id as string | null, separator: false })),
      { label: "", data: null, separator: true },
      { label: "——— 我的预设 ———", data: null, separator: false },
      ...this._presets.map((p) => ({ label: p.name || p.id, data: p.id as string | null, separator: false })),
    ];
    let idx = this.preset_items.findIndex((it) => it.data === keep);
    if (idx < 0) idx = this.preset_items.findIndex((it) => it.data === "default");
    this.preset_index = idx;
    this._sync_buttons();
  }

  private _active_text(): string {
    const pid = this._current_id();
    if (pid !== null && this._is_builtin_id(pid)) {
      for (const b of S.BUILTIN_PROMPTS) {
        if (b.id === pid) return b.text;
      }
    }
    const custom = pid !== null ? this._find_custom(pid) : null;
    return custom ? custom.text : S.DEFAULT_PROMPT_TEXT;
  }

  private _sync_buttons(): void {
    const builtin = this._is_builtin_current();
    this.rename_btn_enabled = !builtin;
    this.delete_btn_enabled = !builtin;
    this.editor_readonly = builtin;
  }

  private _load_active_into_editor(): void {
    // blockSignals path: no changed emission, like Python.
    this.editor_text = this._active_text();
    this._sync_buttons();
  }

  private _unique_copy_name(base: string): string {
    // Copy naming fixed by #39.
    let name = base + " 副本";
    let n = 2;
    const existing = new Set(this._presets.map((p) => p.name));
    while (existing.has(name)) {
      name = base + " 副本 " + n;
      n += 1;
    }
    return name;
  }

  private _copy_preset(): void {
    // Copy the selected preset (built-in or custom) into a new custom preset
    // and select it - the ONLY way past the built-in lock (#39 / ADR-010).
    const pid = this._current_id();
    const text = this.editor_text; // includes unsaved edits
    let base = pid ?? "";
    const builtin = S.BUILTIN_PROMPTS.find((b) => b.id === pid);
    if (builtin) {
      base = builtin.name;
    } else {
      const custom = pid !== null ? this._find_custom(pid) : null;
      base = (custom ? custom.name : pid) || (pid ?? "");
    }
    const new_id = "prompt_" + randomUUID().replaceAll("-", "").slice(0, 8);
    this._presets.push({ id: new_id, name: this._unique_copy_name(base), text });
    this._active = new_id;
    this._rebuild_preset_combo();
    this._load_active_into_editor();
    this._refresh_preview();
    this._emit_changed();
  }

  private _rename_preset(): void {
    if (this._is_builtin_current()) return;
    const custom = this._find_custom(this._current_id() as string);
    if (custom === null) return;
    this._rename_with(this._ask_new_name(custom.name));
  }

  private _rename_with(name: string): void {
    if (!name) return;
    if (this._is_builtin_current()) return;
    const custom = this._find_custom(this._current_id() as string);
    if (custom === null) return;
    custom.name = name;
    this._rebuild_preset_combo();
    this._refresh_preview();
    this._emit_changed();
  }

  private _delete_preset(): void {
    if (this._is_builtin_current()) return;
    const pid = this._current_id() as string;
    this._presets = this._presets.filter((p) => p.id !== pid);
    const known = (x: string): boolean =>
      this._is_builtin_id(x) || this._find_custom(x) !== null;
    if (pid !== this._persisted_active && known(this._persisted_active)) {
      // Deleted a NON-active preset: the selection returns to the active
      // preset the page opened with - tidying up must not swap the active
      // preset as a side effect.
      this._active = this._persisted_active;
    } else {
      // Deleting the ACTIVE custom falls back to the built-in default - the
      // user must never land in a "no prompt" empty state (#39 D5).
      this._active = "default";
    }
    this._rebuild_preset_combo();
    this._load_active_into_editor();
    this._refresh_preview();
    this._emit_changed();
  }

  private _refresh_preview(): void {
    // Read-only effective preview: generated by the SAME assembly function
    // production uses (#39 testing decision 5 - preview == production, one
    // function, not two constants). The window cannot see real context, so
    // the switch-on state demos the two context lines with example text.
    const on = this.context_groups;
    this.preview_text = P.build_instructions(
      this._active_text(),
      on ? PREVIEW_PREV_EXAMPLE : "",
      on ? PREVIEW_NEXT_EXAMPLE : "",
      0);
    this._emit_changed();
  }

  // ---- report rendering ----

  private _show_report(report: TestReport): void {
    this._poll_timer.stop();
    this.test_btn_enabled = true;
    this.cancel_btn_enabled = false;
    this.progress_text = "已完成，用时 " + (report["duration_ms"] ?? 0) + " 毫秒";
    this._render_report(report);
  }

  // Translate machine fields into human labels while preserving the report's
  // values verbatim.
  _render_report(report: TestReport): void {
    const r = report as unknown as Record<string, unknown>;
    const lines: string[] = ["结论：" + String(r["verdict"] ?? "").toUpperCase()];
    const layers = Array.isArray(r["layers"]) ? r["layers"] as Record<string, unknown>[] : [];
    for (const lay of layers) {
      const passed = lay["passed"];
      const mark = passed === true ? "PASS" : (passed === false ? "FAIL" : "--");
      const code = lay["code"] ? " [" + String(lay["code"]) + "]" : "";
      lines.push(mark + " " + String(lay["id"] ?? "") + " " + String(lay["title"] ?? "") + code +
        " - " + String(lay["message"] ?? "") + " (" + String(lay["elapsed_ms"] ?? 0) + " 毫秒)");
    }
    const skipped = r["skipped"] as string[] | undefined;
    if (skipped) lines.push("跳过：" + skipped.join(", "));
    lines.push("尝试次数：" + String(r["attempts"] ?? 0));
    const sample = (r["sample"] ?? {}) as Record<string, unknown>;
    lines.push("原文：" + String(sample["source"] ?? ""));
    lines.push("译文：" + (sample["translation"] ? String(sample["translation"]) : "（无）"));
    const ml = (r["model_list"] ?? {}) as Record<string, unknown>;
    if (ml["observed"]) {
      const cm = ml["contains_model"];
      const contains = cm === true ? "是" : (cm === false ? "否" : "未知");
      lines.push("模型列表：" + String(ml["total"] ?? 0) + "（包含所配模型：" + contains + "）");
    }
    const warning_messages = (r["warning_messages"] ?? {}) as Record<string, unknown>;
    const warnings = (r["warnings"] ?? []) as string[];
    for (const w of warnings) {
      lines.push("警告：" + String(warning_messages[w] ?? w));
    }
    const notes = (r["notes"] ?? []) as string[];
    for (const n of notes) {
      lines.push("备注：" + String(n));
    }
    const snap = (r["snapshot"] ?? {}) as Record<string, unknown>;
    lines.push("基于点击时的输入（base_url=" + String(snap["base_url"] ?? "") +
      "，model=" + String(snap["model"] ?? "") + "）；未写入任何配置文件。");
    lines.push(String(r["quota_notice"] ?? ""));
    this.report_text = lines.join("\n");
  }

  // ---- construction ----

  private _build(): void {
    this._rebuild_preset_combo();
    this._load_active_into_editor();
    this._refresh_preview();
  }
}

// The page's write channel is exactly these 8 fields; is_dirty() compares
// against the same definition.
export const STATE_KEYS: readonly string[] = [
  "base_url", "api_key", "model", "protocol", "mock", "active", "presets", "context_groups",
];

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
