// Port of desktop/suboverlay/settings.py - settings storage for the desktop
// app: JSON file in %APPDATA%/SubOverlay, save-on-change, .bak on corruption.
// (Original adapted ideas from LiveSubs Setting.cs + WindowHandler.cs,
// Apache-2.0; this TS port keeps the same public names as the Python module
// so the remaining Phase 1 tickets map one-to-one onto it.)
//
// Semantic fidelity notes (registered in ticket #199):
// - Python round() is half-even; Math.round is not. roundHalfEven keeps the
//   stored byte values identical for midpoints (e.g. max_concurrent mid 8.5).
// - Python str.strip trims a slightly different whitespace set than
//   String.trim; every migrated legacy text in the fixtures agrees.
// - json.dump(indent=2, ensure_ascii=False) vs JSON.stringify(cfg, null, 2):
//   identical for this schema; a float like 60.0 serializes as 60 (same JSON
//   number, no assertion depends on the literal).
// - load() validates UTF-8 with a fatal TextDecoder to reproduce
//   UnicodeDecodeError -> .bak fallback semantics.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type Settings = JsonObject;
export type TuningPath = readonly [string, string];
export type Control = "choice" | "int" | "float" | "slider" | "color";

export interface FieldSpec {
  path: TuningPath;
  group: string;
  label: string;
  control: Control;
  default: Json;
  choices: readonly string[];
  labels: readonly string[];
  min: number | null;
  max: number | null;
  step: number | null;
  scale: number;
  unit: string;
  restart: boolean;
  uncalibrated: boolean;
  notify_overlay: boolean;
  hint: string;
}

export function isJsonObject(v: Json | undefined): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const APP_DIR_NAME = "SubOverlay";
export const FILE_NAME = "setting.json";

// Built-in presets (issue #39 / ADR-010): three, single category, locked in
// code - never persisted, never renamed, never deleted. The default text is
// the legacy prompt.system default, preserved verbatim.
export const DEFAULT_PROMPT_TEXT =
  "Translate the following subtitles into Chinese. Return ONLY the translation, one line per input line, in the same order. Do not add explanations.";
export const LITERAL_PROMPT_TEXT =
  "Translate the following subtitles into Chinese. Render technical terms and proper names with their commonly accepted literal translations; keep numbers, units and amounts exactly as written; add or remove no information. Return ONLY the translation, one line per input line, in the same order. Do not add explanations.";
export const NATURAL_PROMPT_TEXT =
  "Translate the following subtitles into Chinese as natural, colloquial spoken language - the way a native speaker would actually say it in everyday conversation. Return ONLY the translation, one line per input line, in the same order. Do not add explanations.";

export interface PromptPreset {
  id: string;
  name: string;
  text: string;
}

export const BUILTIN_PROMPTS: readonly PromptPreset[] = [
  { id: "default", name: "标准", text: DEFAULT_PROMPT_TEXT },
  { id: "literal", name: "直译", text: LITERAL_PROMPT_TEXT },
  { id: "natural", name: "口语", text: NATURAL_PROMPT_TEXT },
];

// One-way migration of the legacy free-form prompt.system key (#39).
export const MIGRATED_PRESET_ID = "prompt_migrated";
export const MIGRATED_PRESET_NAME = "旧版自定义"; // name fixed by #39

export function active_prompt_text(cfg: Json | undefined): string {
  // Text of the active preset: built-in by id, custom from prompt.presets,
  // else the default built-in. The one resolver shared by the engine
  // (identity + wire) and the panel preview (#39).
  const pr = isJsonObject(cfg) && isJsonObject(cfg["prompt"]) ? cfg["prompt"] : {};
  const active = pr["active"];
  for (const b of BUILTIN_PROMPTS) {
    if (b.id === active) return b.text;
  }
  const presets = pr["presets"];
  if (Array.isArray(presets)) {
    for (const c of presets) {
      if (isJsonObject(c) && c["id"] === active && typeof c["text"] === "string") {
        return c["text"];
      }
    }
  }
  return DEFAULT_PROMPT_TEXT;
}

export function default_settings(): Settings {
  return {
    provider: { base_url: "", api_key: "", model: "", protocol: "auto",
                timeout_s: 60.0, max_concurrent: 5 },
    // Schema per #39: active = built-in id or custom id; presets = custom
    // array only (built-ins never appear here); legacy prompt.system is
    // migrated one-way in load() and never returns.
    prompt: { active: "default", presets: [], context_groups: 1 },
    // Prefetch / batch parameters (spec #24, ADR-007); ranges and defaults
    // live in TUNING_FIELDS. Values still need real-Key calibration - do not
    // treat them as final.
    prefetch: { lead_s: 90.0,        // lead window measured in SECONDS
                max_groups: 20,      // hard group cap (first of the two to hit wins)
                seek_debounce_ms: 400 }, // quiet time before a refill after a jump
    batch: { max_groups: 8,          // max sentence groups per batched request
             max_chars: 8000 },      // max chars (text + its own context) per batch
    display: { mode: "bilingual", order: "trans_first", history_lines: 2,
               font_size: 10, font_bold: "none", stroke: 1.5,
               bg_color: [0, 0, 0], bg_opacity: 150 },
    window: { x: null, y: null, w: 380, h: 64 },
    server: { port: 9877 },
  };
}

// ---- Tuning-page field authority table (#152 / spec #161, ticket #158) ----
// The parameters the tuning page renders. This table is the ONE authority for
// their range, default, unit, label/hint copy and effect timing: the debug
// window's tuning page builds its controls from it and clamps through it
// (spec #161 decision 5). Being listed here does NOT add a key to the file -
// the schema stays frozen. display.font_size joined the table when the
// settings dialog was absorbed into the window (#164 / #167).
//
// notify_overlay means "after saving, the overlay must look again":
// mode/order are the two snapshotted choices, and the paint-consuming
// display fields (font/stroke/colour/opacity) need a repaint so a font-size
// change is visible on the spot (#164).
//
// control is the widget kind the page must use, one per spec #161:
// "choice" (dropdown), "int"/"float" (number box), "slider" (slider + number
// box, backdrop opacity), "color" (color picker).
export const TUNING_GROUPS = ["display", "network", "experimental"] as const;

function _tune(path: TuningPath, group: string, label: string, control: Control,
               def: Json, kw: Partial<FieldSpec> = {}): FieldSpec {
  const base: FieldSpec = {
    path, group, label, control, default: def,
    choices: [], labels: [], min: null, max: null, step: null,
    scale: 1, unit: "", restart: false, uncalibrated: false,
    notify_overlay: false, hint: "",
  };
  return { ...base, ...kw };
}

export const TUNING_FIELDS: readonly FieldSpec[] = [
  _tune(["display", "font_size"], "display", "字幕字号", "int", 10,
        { min: 6, max: 40, step: 1, notify_overlay: true,
          hint: "浮窗里字有多大；越大越占地方" }),
  _tune(["display", "mode"], "display", "显示内容", "choice", "bilingual",
        { choices: ["bilingual", "trans", "orig"], labels: ["双语", "只看译文", "只看原文"],
          notify_overlay: true, hint: "双语 = 原文译文都显示" }),
  _tune(["display", "order"], "display", "谁在上面", "choice", "trans_first",
        { choices: ["trans_first", "orig_first"], labels: ["译文在上", "原文在上"],
          notify_overlay: true, hint: "只有双语模式看得到这一项" }),
  _tune(["display", "history_lines"], "display", "往上多留几行", "int", 2,
        { min: 0, max: 10, step: 1,
          hint: "还能看到几句旧字幕；0 = 只显示当前这句" }),
  _tune(["display", "font_bold"], "display", "哪些行加粗", "choice", "none",
        { choices: ["none", "trans_only", "sub_only", "both"],
          labels: ["都不加粗", "只有译文", "只有原文", "都加粗"],
          notify_overlay: true, hint: "让选中的那几行更醒目" }),
  _tune(["display", "stroke"], "display", "字外面的描边", "float", 1.5,
        { min: 0.0, max: 10.0, step: 0.5, notify_overlay: true,
          hint: "给字加一圈黑边，压在亮画面上也看得清；0 = 不加" }),
  _tune(["display", "bg_color"], "display", "底板颜色", "color", [0, 0, 0],
        { min: 0, max: 255, notify_overlay: true, hint: "字幕后面那块底色" }),
  _tune(["display", "bg_opacity"], "display", "底板浓淡", "slider", 150,
        { min: 0, max: 255, step: 1, notify_overlay: true,
          hint: "越小越透，能看见后面的画面" }),
  _tune(["provider", "timeout_s"], "network", "一次请求最多等多久", "float", 60.0,
        { min: 1.0, max: 600.0, step: 1.0, unit: "秒",
          hint: "超过就算这次失败；网络慢就调大" }),
  _tune(["provider", "max_concurrent"], "network", "同时发几个请求", "int", 5,
        { min: 1, max: 16, step: 1, restart: true,
          hint: "调大翻得更快，但更容易撞上服务商的限流" }),
  _tune(["server", "port"], "network", "本地服务端口", "int", 9877,
        { min: 1, max: 65535, step: 1, restart: true,
          hint: "浏览器插件连的就是这个端口，改了插件那边也要跟着改" }),
  _tune(["prefetch", "lead_s"], "experimental", "提前翻多少秒", "float", 90.0,
        { min: 0.0, max: 600.0, step: 1.0, unit: "秒", uncalibrated: true,
          hint: "播放前先翻好前面这么多秒；卡顿就调大" }),
  _tune(["prefetch", "max_groups"], "experimental", "最多提前翻几句", "int", 20,
        { min: 1, max: 200, step: 1, uncalibrated: true,
          hint: "预先翻好的句子上限，够用就好" }),
  _tune(["prefetch", "seek_debounce_ms"], "experimental", "拖进度条后先等多久",
        "float", 0.4,
        { min: 0.0, max: 5.0, step: 0.1, unit: "秒", scale: 1000, uncalibrated: true,
          hint: "安静这么久才开始翻，免得白翻一堆" }),
  _tune(["batch", "max_groups"], "experimental", "一次最多合并几句", "int", 8,
        { min: 1, max: 64, step: 1, uncalibrated: true,
          hint: "合并得多更省额度，一行出错影响的行也更多" }),
  _tune(["batch", "max_chars"], "experimental", "一次最多合并多少字", "int", 8000,
        { min: 100, max: 64000, step: 500, uncalibrated: true,
          hint: "和上一项谁先到算谁" }),
];

// Python tuples hash by value; TS arrays do not, so paths key maps by their
// JSON form. Exported because the tuning UI state (and later the settings
// window port) needs the same keying.
export function path_key(path: TuningPath): string {
  return JSON.stringify(path);
}

const _FIELDS_BY_PATH = new Map<string, FieldSpec>(
  TUNING_FIELDS.map((f) => [path_key(f.path), f]));

export function field_by_path(path: TuningPath): FieldSpec {
  // Field spec for a (section, key) path; throws when not tunable
  // (Python KeyError equivalent - see test conversion notes).
  const f = _FIELDS_BY_PATH.get(path_key(path));
  if (f === undefined) throw new Error("not tunable: " + path_key(path));
  return f;
}

export function is_scaled(field: FieldSpec): boolean {
  // True when the page shows one unit and the file stores another (seek).
  return field.scale !== 1;
}

// Python round(): half-even. Math.round is half-up (and toward +inf on .5
// negatives), which would drift stored values at midpoints.
function roundHalfEven(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

function _is_number(v: Json | undefined): v is number {
  // Python must additionally exclude bool (a subclass of int); in JS
  // typeof true is "boolean", so the guard alone is already equivalent.
  return typeof v === "number";
}

function _raw(field: FieldSpec, cfg: Json | undefined): Json | undefined {
  const [section, key] = field.path;
  const node = isJsonObject(cfg) ? cfg[section] : undefined;
  return isJsonObject(node) ? node[key] : undefined;
}

function _clamp_number(field: FieldSpec, value: Json | undefined): number | null {
  // Clamp a numeric UI value into range; null when it is not a number.
  if (!_is_number(value)) return null;
  if (field.min === null || field.max === null) return null;
  const v = Math.min(Math.max(value, field.min), field.max);
  return field.control === "int" || field.control === "slider" ? roundHalfEven(v) : v;
}

function _clamp_channels(field: FieldSpec, value: Json | undefined): number[] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const out: number[] = [];
  for (const channel of value) {
    if (typeof channel !== "number") return null;
    if (field.min === null || field.max === null) return null;
    out.push(roundHalfEven(Math.min(Math.max(channel, field.min), field.max)));
  }
  return out;
}

const listCopy = (v: Json): Json => (Array.isArray(v) ? [...v] : []);

export function display_value(field: FieldSpec, cfg: Json | undefined): Json {
  // Stored value -> UI value (clamped, UI unit). Never throws: a hand-edited
  // or corrupted value falls back to the field default.
  const raw = _raw(field, cfg);
  if (field.control === "choice") {
    return typeof raw === "string" && field.choices.includes(raw) ? raw : field.default;
  }
  if (field.control === "color") {
    const channels = _clamp_channels(field, raw);
    return channels ?? listCopy(field.default);
  }
  if (!_is_number(raw)) return field.default;
  const value = _clamp_number(field, raw / field.scale);
  return value === null ? field.default : value;
}

export function stored_value(field: FieldSpec, ui_value: Json): Json {
  // UI value -> stored value (clamped, stored unit).
  if (field.control === "choice") {
    return typeof ui_value === "string" && field.choices.includes(ui_value)
      ? ui_value : field.default;
  }
  if (field.control === "color") {
    const channels = _clamp_channels(field, ui_value);
    return channels ?? listCopy(field.default);
  }
  let value = _clamp_number(field, ui_value);
  if (value === null) value = _clamp_number(field, field.default);
  if (value === null) throw new Error("invariant: numeric field default: " + path_key(field.path));
  const scale = field.scale;
  return scale !== 1 ? roundHalfEven(value * scale) : value;
}

function section(cfg: Settings, k: string): JsonObject {
  const v = cfg[k];
  if (!isJsonObject(v)) throw new Error("invariant: section missing: " + k);
  return v;
}

export function tuning_ui_state(cfg: Json | undefined): Map<string, Json> {
  // UI-unit working copy of every tunable field (fresh lists, never aliases
  // cfg). The page edits this; the file is written only on save.
  const state = new Map<string, Json>();
  for (const f of TUNING_FIELDS) state.set(path_key(f.path), display_value(f, cfg));
  return state;
}

// Structural equality for the Json value domain (Python == on dicts/lists is
// structural; JS === is not). Key order is normalized for objects.
function jsonEq(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => jsonEq(x, b[i]));
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (!jsonEq(ka, kb)) return false;
    return ka.every((k) => jsonEq(a[k], b[k]));
  }
  return false;
}

export function collect_edits(ui_state: ReadonlyMap<string, Json>,
                              initial_state: ReadonlyMap<string, Json>): Array<[TuningPath, Json]> {
  // Paths whose UI value differs from the state the page loaded, in page
  // order. Value equality (not a dirty flag) is what makes an untouched key
  // stay untouched - including hand-edited out-of-range values.
  const edits: Array<[TuningPath, Json]> = [];
  for (const f of TUNING_FIELDS) {
    const k = path_key(f.path);
    if (ui_state.has(k) && initial_state.has(k)) {
      const ui = ui_state.get(k);
      const init = initial_state.get(k);
      if (!jsonEq(ui, init)) edits.push([f.path, ui as Json]);
    }
  }
  return edits;
}

export function apply_edits(cfg: Settings,
                            edits: ReadonlyArray<readonly [TuningPath, Json]>): TuningPath[] {
  // Write clamped+converted values into cfg in place; returns the applied
  // paths. Keys outside TUNING_FIELDS throw - the page cannot reach them.
  const applied: TuningPath[] = [];
  for (const [p, ui_value] of edits) {
    const field = field_by_path(p);
    const [sec, key] = field.path;
    let node = cfg[sec];
    if (!isJsonObject(node)) {
      node = {};
      cfg[sec] = node;
    }
    node[key] = stored_value(field, ui_value);
    applied.push(field.path);
  }
  return applied;
}

export function settings_dir(): string {
  const base = process.env["APPDATA"] || homedir();
  return path.join(base, APP_DIR_NAME);
}

export function settings_path(): string {
  return path.join(settings_dir(), FILE_NAME);
}

function moveToBak(p: string): void {
  // shutil.move(p, p + ".bak") guarded like the Python OSError pass.
  try {
    renameSync(p, p + ".bak");
  } catch {
    // leave the file in place, caller returns defaults
  }
}

export function load(filePath?: string): Settings {
  // Load settings; corrupt file -> renamed to .bak, defaults returned.
  // (Parameter is filePath so it never shadows the node:path import.)
  const p = filePath ?? settings_path();
  const cfg = default_settings();
  if (!existsSync(p)) return cfg;
  let text: string;
  try {
    // Fatal decoding reproduces the UnicodeDecodeError branch: invalid
    // UTF-8 must fall back to .bak, not silently become U+FFFD.
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(p));
  } catch {
    moveToBak(p);
    return cfg;
  }
  let data: Json;
  try {
    data = JSON.parse(text) as Json;
  } catch {
    moveToBak(p);
    return cfg;
  }
  if (isJsonObject(data)) {
    for (const [k, v] of Object.entries(data)) {
      const cur = cfg[k];
      if (isJsonObject(v) && isJsonObject(cur)) {
        cfg[k] = { ...cur, ...v }; // shallow merge, like dict.update
      } else {
        cfg[k] = v;
      }
    }
  }
  if (_normalize_prompt(cfg)) {
    // One-way migration (#39): the legacy prompt.system key is already gone
    // from memory - write the file back now so old and new schema never
    // coexist on disk. Schema operation, not a user save: _meta.saved_at
    // stays untouched (file mtime remains untrusted, #4).
    try {
      save(cfg, p);
    } catch {
      // OSError: keep the in-memory cfg, leave the disk file as-is
    }
  }
  return cfg;
}

function _valid_preset(item: Json): boolean {
  return isJsonObject(item)
    && typeof item["id"] === "string" && item["id"] !== ""
    && "text" in item && typeof item["text"] === "string";
}

function _normalize_prompt(cfg: Settings): boolean {
  // #39 / ADR-010 schema normalization + one-way migration.
  //
  // Returns true iff the legacy prompt.system key was removed (caller must
  // write the file back). Damaged prompt node resets to defaults; a damaged
  // presets array falls back to []; active pointing at a missing id falls
  // back to "default".
  const pr = cfg["prompt"];
  if (!isJsonObject(pr)) {
    const d = section(default_settings(), "prompt");
    cfg["prompt"] = { active: d["active"] ?? "default", presets: [],
                      context_groups: d["context_groups"] ?? 1 };
    return false;
  }
  let hadLegacy = false;
  let legacy: Json | undefined;
  if (Object.prototype.hasOwnProperty.call(pr, "system")) {
    legacy = pr["system"];
    delete pr["system"];
    hadLegacy = true;
  }
  const rawPresets = pr["presets"];
  let presets: Json[] = Array.isArray(rawPresets) && rawPresets.every(_valid_preset)
    ? [...rawPresets]
    : [];
  if (hadLegacy) {
    const content = typeof legacy === "string" ? legacy.trim() : "";
    if (content && content !== DEFAULT_PROMPT_TEXT) {
      if (!presets.some((x) => isJsonObject(x) && x["id"] === MIGRATED_PRESET_ID)) {
        presets.push({ id: MIGRATED_PRESET_ID, name: MIGRATED_PRESET_NAME, text: content });
      }
      pr["active"] = MIGRATED_PRESET_ID;
    }
    // empty or equal to the built-in default: the key is simply dropped
  }
  pr["presets"] = presets;
  const known = new Set<string>(
    [...BUILTIN_PROMPTS.map((b) => b.id),
     ...presets.filter(isJsonObject).map((x) => x["id"] as string)]);
  const act = pr["active"];
  if (typeof act !== "string" || !known.has(act)) pr["active"] = "default";
  if (!Object.prototype.hasOwnProperty.call(pr, "context_groups")) {
    pr["context_groups"] = section(default_settings(), "prompt")["context_groups"] ?? 1;
  }
  return hadLegacy;
}

export function save(cfg: Settings, filePath?: string): string {
  // Atomic save (tmp + replace). Never logs or prints the api key.
  // (Parameter is filePath so it never shadows the node:path import.)
  const p = filePath ?? settings_path();
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
  renameSync(tmp, p);
  return p;
}

export function redact(cfg: Json | undefined): JsonObject {
  // Public summary for untrusted consumers (transly providerSummary rule).
  // Python crashed on a non-dict provider node; this port returns the empty
  // summary instead (registered robustness deviation, no assertion relied
  // on the crash).
  const prov = isJsonObject(cfg) && isJsonObject(cfg["provider"]) ? cfg["provider"] : {};
  const get = (k: string, dflt: Json): Json => (k in prov ? (prov[k] as Json) : dflt);
  const baseRaw = get("base_url", "");
  const base = typeof baseRaw === "string" ? baseRaw : "";
  return {
    configured: Boolean(baseRaw) && Boolean(get("model", "")),
    host: base.includes("://") ? (base.split("/")[2] ?? "") : "",
    model: get("model", ""),
    protocol: get("protocol", "auto"),
  };
}
