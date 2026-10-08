// Port of desktop/suboverlay/overlay.py - the subtitle overlay DISPLAY layer
// (ticket #204). Headless by design: the Qt widget's state machine, row
// contract, status copy, history, nudges, wrap algorithm and resize math live
// here as pure TS; the Electron renderer only applies the resulting paint
// plan to the DOM (main process owns the instance and pushes plans).
//
// Conversion register (pytest/Qt -> TS, per the #191 equivalence criteria):
// - QWidget paintEvent -> paint_plan(): the same decisions paintEvent makes
//   (rows, colors, bold, font size, divider placement, status line, bg box),
//   returned as an event list so the PaintLog-style pytest assertions port
//   1:1. Actual pixels are the renderer's DOM/CSS job.
// - QPainterPath stroke/wrapped drawing -> wrap_text() with an injected
//   Measurer (QFontMetrics.horizontalAdvance/height seam). The draw loop's
//   vertical budget (break past area.bottom() + 8) is preserved. Production
//   line breaking is delegated to CSS overflow-wrap (spaces break, long
//   unspaced runs break per character) - the pure function stays as the
//   algorithm authority and the equivalence anchor.
// - _draw_divider -> divider event between the two rows of a two-row plan.
// - Qt update() -> nothing here: the owner (main process) pushes a fresh
//   plan after every mutating call; tests read paint_plan() on demand.
// - self.settings dict access -> the constructor takes the live settings
//   object by reference (mutations visible to the owner), like Python.
// - S.field_by_path / S.save seams -> injected deps (fieldSpec / save), the
//   established monkeypatch -> deps-injection rewrite (#202/#203 precedent).
//   This file has ZERO relative imports so the node --test strip runner can
//   load it through the lib re-export shim.
// - set_display string coercion: Python d.get() may store None; the row
//   contract treats None and "" identically (both falsy, both != any real
//   string), so non-string wire values coerce to "" at the boundary -
//   behaviorally identical for every assertion.
// - _nudge_tuned int() semantics -> Math.trunc; garbage mode/order coerce to
//   the default instead of Python's ValueError crash (robustness deviation,
//   no assertion relied on the crash; swap_order keeps the exact ternary so
//   a garbage order falls back to trans_first like Python).
// - Qt point sizes -> CSS px is * 4/3 at the renderer (registered there);
//   plan carries the Qt-semantic integer size.
// - Drag/press bookkeeping (_press_pos/_press_global) is windowing, not
//   display state: it lives in the main-process drag machine. The pytest-
//   covered math (_edge_at, _apply_resize) is ported as pure functions below.
// - pulse_topmost / SetProcessDpiAwarenessContext are windowing concerns
//   (skeleton main already sets alwaysOnTop; DPI comes with the OS process) -
//   not part of this port; topmost re-arm timer lands with the App shell #206.
// - sys_has_windows() -> always true on the Electron win32 runtime; the
//   WS_EX_TRANSPARENT bit fiddling is replaced by setIgnoreMouseEvents
//   (already proven by the #193/#195 skeleton work).

export const RESIZE_MARGIN = 10;
export const ROW_LABELS = { orig: "\u3010\u539f\u3011", trans: "\u3010\u8bd1\u3011" } as const; // 【原】/【译】
export const OVERLAY_MODES = ["bilingual", "trans", "orig"] as const;
// Divider color DIVIDER_RGBA (255, 255, 255, 80); the renderer uses the
// fraction form. Kept here as the constant's authority.
export const DIVIDER_RGB = [255, 255, 255] as const;
export const DIVIDER_ALPHA = 80;

export type RowRole = "orig" | "trans";

// Wire display payload (engine.ts _tick_locked / status contract). Values
// arrive as arbitrary JSON; every read is defensive like the Python .get().
export interface DisplayData {
  state?: unknown;
  orig?: unknown;
  trans?: unknown;
  trans_available?: unknown;
  trans_state?: unknown;
  playing?: unknown;
  title?: unknown;
  hook_error?: unknown;
  capture_error?: unknown;
  [key: string]: unknown;
}

export interface NudgeFieldSpec {
  min: number;
  max: number;
  default: number;
}

export interface OverlayDeps {
  // Python: try S.save(self.settings) except OSError: pass. Default when
  // omitted: no-op (tests inject a spy; main injects the real save).
  save?: (cfg: { [key: string]: unknown }) => void;
  // Python: S.field_by_path(("display", key))["min"|"max"|"default"].
  // Main injects field_by_path from settings.ts; tests inject stubs.
  fieldSpec?: (key: string) => NudgeFieldSpec;
}

export interface JsonRecord {
  [key: string]: unknown;
}

export function asText(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function dispSection(settings: JsonRecord): JsonRecord {
  const d = settings["display"];
  return d !== null && typeof d === "object" && !Array.isArray(d) ? (d as JsonRecord) : {};
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}

// ---------------------------------------------------------------------------
// #174 appearance keys, read with fallback-compatible semantics
// (decision #174: the six display.* keys may be absent from any settings
// file - the overlay then falls back to the values overlay.py hardcodes
// today. Python has not landed these keys yet, so the display layer only
// CONSUMES them defensively; adding them to the authority table is the
// settings-window ticket's business. Failure red stays hardcoded.)
// ---------------------------------------------------------------------------

// QColor(.name()) shape: lowercase #rrggbb, channels clamped to 0-255.
function rgb_to_hex(c: [number, number, number]): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return "#" + h(c[0]) + h(c[1]) + h(c[2]);
}

// _clamp_channels-equivalent shape check: exactly three numbers, else null.
function rgb_list(v: unknown, fallback: [number, number, number]): [number, number, number] {
  if (Array.isArray(v) && v.length === 3
    && typeof v[0] === "number" && typeof v[1] === "number" && typeof v[2] === "number") {
    return [v[0], v[1], v[2]];
  }
  return fallback;
}

const FALLBACK_FONT_FAMILY = "Microsoft YaHei UI";
const FALLBACK_ORIG_TEXT: [number, number, number] = [255, 255, 255];
const FALLBACK_ORIG_STROKE: [number, number, number] = [0, 0, 0];
const FALLBACK_TRANS_TEXT: [number, number, number] = [255, 224, 130];
const FALLBACK_TRANS_STROKE: [number, number, number] = [0, 0, 0];

// ---------------------------------------------------------------------------
// Display state machine (OverlayWindow minus windowing)
// ---------------------------------------------------------------------------

export interface PlanTextEvent {
  kind: "text";
  role: RowRole;
  text: string;
  color: string;
  bold: boolean;
  font_size: number;
  // _draw_wrapped's stroke pen (display.stroke, paint fallback 2.0); 0 = none.
  stroke_width: number;
  // Per-role stroke color (display.orig_stroke_color / display.trans_stroke_color).
  stroke_color: string;
  // Global font family (display.font_family, fallback "Microsoft YaHei UI").
  font_family: string;
}

export interface PlanDividerEvent {
  kind: "divider";
  y: number;
}

export type PlanEvent = PlanTextEvent | PlanDividerEvent;

export interface PaintPlan {
  events: PlanEvent[];
  status_text: string;
  bg: { r: number; g: number; b: number; a: number };
}

export class OverlayDisplay {
  settings: JsonRecord;
  private readonly saveImpl: (cfg: JsonRecord) => void;
  private readonly fieldSpec: (key: string) => NudgeFieldSpec;
  mode: string;
  order: string;
  history: Array<[string, string]>;
  orig_text: string;
  trans_text: string;
  trans_state: string;
  status_text: string;
  trans_available: boolean;

  constructor(settings: JsonRecord, deps: OverlayDeps = {}) {
    this.settings = settings;
    this.saveImpl = deps.save ?? (() => {});
    this.fieldSpec = deps.fieldSpec ?? ((_key) => { throw new Error("fieldSpec not provided"); });
    // _sync_display_choices: snapshot display.mode / display.order here (not
    // read per paint), so a settings change needs reread_settings().
    const disp = dispSection(settings);
    this.mode = asText(disp["mode"]) || "bilingual";
    this.order = asText(disp["order"]) || "trans_first";
    this.history = [];
    this.orig_text = "";
    this.trans_text = "";
    this.trans_state = "idle";
    this.status_text = "";
    // Engine's word on whether this run can translate at all; see display_rows().
    this.trans_available = false;
  }

  // ---- text API (set_display) ----
  set_display(d: DisplayData): void {
    // One default for an absent field everywhere: nothing has said a
    // translation is possible, so don't assume one is.
    this.trans_available = Boolean(d.trans_available ?? false);
    this.trans_state = asText(d.trans_state) || "idle";
    if (d.state === "no_cues") {
      const hook_error = asText(d.hook_error);
      const capture_error = asText(d.capture_error);
      if ((hook_error || capture_error) && this.trans_state === "waiting") {
        // Subtitle capture diagnostics take precedence over a healthy
        // provider's waiting state; keep them in the existing status line.
        this.trans_state = "idle";
      }
      this.orig_text = "";
      this.trans_text = "";
      if (hook_error) {
        this.status_text = "page hook NOT installed - the script is connected but cannot see captions";
      } else if (capture_error) {
        this.status_text = "caption body was empty - connected, but YouTube returned no caption data";
      } else {
        const title = asText(d.title);
        this.status_text = "waiting for subtitles..." + (title ? "  [" + title + "]" : "");
      }
      return;
    }
    this.status_text = d.playing ? "" : "[Paused]";
    const o = asText(d.orig);
    const t = asText(d.trans);
    if (o && (o !== this.orig_text || t !== this.trans_text)) {
      if (this.orig_text && this.trans_text) {
        this.history.push([this.orig_text, this.trans_text]);
        const maxh = Math.trunc(num(dispSection(this.settings)["history_lines"], 2));
        while (this.history.length > maxh) this.history.shift();
      }
    }
    this.orig_text = o;
    this.trans_text = t;
  }

  // ---- the row contract (display_rows) ----
  display_rows(): Array<{ role: RowRole; text: string }> {
    // The single place that decides what a mode shows when there is no
    // translation to show (issue #1): a missing translation must not blank
    // the overlay, so trans mode falls back to the original instead of
    // drawing nothing. trans_available is the engine's word on whether this
    // run can translate at all - the display layer never infers it from
    // provider config, and an empty translation row is not evidence that none
    // is coming. Two rows mean a divider goes between them; with every row
    // empty (between cues) nothing is drawn at all.
    const orig = this.orig_text || "";
    let trans = this.trans_text || "";
    const trans_status = this.translation_status_text();
    if (trans_status) trans = trans_status;
    let rows: Array<{ role: RowRole; text: string }>;
    if (this.mode === "orig") {
      rows = [{ role: "orig", text: orig }];
    } else if (this.mode === "trans" && !trans && !this.trans_available) {
      rows = [{ role: "orig", text: orig }];
    } else if (this.mode === "trans") {
      rows = [{ role: "trans", text: trans }];
    } else {
      rows = [{ role: "trans", text: trans }, { role: "orig", text: orig }];
      if (this.order === "orig_first") rows.reverse();
    }
    if (!rows.some((r) => r.text)) return []; // between cues: no floating labels, no divider
    return rows.map((r) => ({ role: r.role, text: this.labelled(r.role, r.text) }));
  }

  translation_status_text(): string {
    // The map's fixed status copy, displayed inside the translation row.
    const state = this.trans_state || "idle";
    const labels: Record<string, string> = {
      "waiting": "\uff08\u7b49\u5f85\u539f\u5b57\u5e55\u4e2d\uff09",       // （等待原字幕中）
      "translating": "\uff08\u7ffb\u8bd1\u4e2d\uff09",                        // （翻译中）
      "unconfigured": "\uff08\u672a\u914d\u7f6e\u7ffb\u8bd1\uff09",         // （未配置翻译）
    };
    const known = labels[state];
    if (known !== undefined) return known;
    if (state.startsWith("failed:")) {
      let reason = state.slice("failed:".length);
      if (!reason) reason = "\u7ffb\u8bd1\u5185\u90e8\u9519\u8bef";           // 翻译内部错误
      if (reason.length > 16) reason = reason.slice(0, 16) + "\u2026";           // …
      return "\uff08\u7ffb\u8bd1\u5931\u8d25\uff1a" + reason + "\uff09";    // （翻译失败：…）
    }
    return "";
  }

  labelled(role: RowRole, text: string): string {
    // Row text with its constant label. Text that already carries it (the
    // mock translator writes 【译】 into its own output) is left alone, so the
    // label never doubles up on itself.
    const label = ROW_LABELS[role];
    return text.startsWith(label) ? text : label + text;
  }

  // ---- paint plan (paintEvent decisions without pixels) ----
  paint_plan(): PaintPlan {
    const disp = dispSection(this.settings);
    const bgRaw = disp["bg_color"];
    const bgArr = Array.isArray(bgRaw) ? bgRaw : [];
    const bg = {
      r: Math.trunc(num(bgArr[0], 0)),
      g: Math.trunc(num(bgArr[1], 0)),
      b: Math.trunc(num(bgArr[2], 0)),
      a: Math.trunc(num(disp["bg_opacity"], 150)),
    };
    const rows = this.display_rows();
    const has_status = this.translation_status_text() !== "";
    const events: PlanEvent[] = [];
    // Stroke pen: one width for every row (paintEvent's float(disp.get("stroke", 2.0))),
    // per-role stroke colors (#174). 0 means no stroke path in Python.
    const stroke_width = num(disp["stroke"], 2.0);
    const strokeColors: Record<RowRole, string> = {
      orig: rgb_to_hex(rgb_list(disp["orig_stroke_color"], FALLBACK_ORIG_STROKE)),
      trans: rgb_to_hex(rgb_list(disp["trans_stroke_color"], FALLBACK_TRANS_STROKE)),
    };
    const textColors: Record<RowRole, string> = {
      orig: rgb_to_hex(rgb_list(disp["orig_text_color"], FALLBACK_ORIG_TEXT)),
      trans: rgb_to_hex(rgb_list(disp["trans_text_color"], FALLBACK_TRANS_TEXT)),
    };
    const font_family = asText(disp["font_family"]) || FALLBACK_FONT_FAMILY;
    // Divider y values mirror the PaintLog stub geometry (rows 20 units tall);
    // no assertion depends on the value, only on placement/shape.
    rows.forEach((row, i) => {
      let size = num(disp["font_size"], 15);
      if (row.role === "trans") size = size * 1.25;
      const font_size = Math.trunc(size);
      const boldSetting = asText(disp["font_bold"]);
      const bold = boldSetting === "both" ||
        (row.role === "trans" && boldSetting === "trans_only") ||
        (row.role === "orig" && boldSetting === "sub_only");
      let color: string;
      if (row.role === "orig") {
        color = textColors.orig;
      } else if (has_status && this.trans_state.startsWith("failed:")) {
        // Failure red is a fixed contract (#174): it never reads trans_text_color.
        color = "#ff5a5a";
      } else {
        color = textColors.trans;
      }
      events.push({ kind: "text", role: row.role, text: row.text, color, bold, font_size,
        stroke_width, stroke_color: strokeColors[row.role], font_family });
      // Issue #1 Q2a: two rows (bilingual) always get the divider between
      // them, even while one of them is still empty.
      if (i === 0 && rows.length === 2) events.push({ kind: "divider", y: 20 * i + 2 });
    });
    return { events, status_text: this.status_text, bg };
  }

  // ---- settings reread (#152 / spec #161) ----
  reread_settings(): void {
    // Re-read the two snapshotted display choices: the tuning page calls this
    // after 确定 so the overlay changes face without a restart. History,
    // texts, geometry and click-through are left alone. Never saves.
    const disp = dispSection(this.settings);
    this.mode = asText(disp["mode"]) || "bilingual";
    this.order = asText(disp["order"]) || "trans_first";
  }

  // ---- menu-driven mutations ----
  cycle_mode(): void {
    // Garbage mode coerced to the first slot instead of Python's ValueError.
    const i = Math.max(0, OVERLAY_MODES.indexOf(this.mode as (typeof OVERLAY_MODES)[number]));
    this.mode = OVERLAY_MODES[(i + 1) % OVERLAY_MODES.length]!;
    dispSection(this.settings)["mode"] = this.mode; // in-memory only, like Python (no save)
  }

  swap_order(): void {
    // Exact Python ternary: anything but trans_first lands back on trans_first.
    this.order = this.order === "trans_first" ? "orig_first" : "trans_first";
    dispSection(this.settings)["order"] = this.order; // in-memory only, like Python (no save)
  }

  private nudgeTuned(key: string, delta: number): number {
    // 菜单里的 ± 快捷方式：范围取权威表（TUNING_FIELDS），**改完即落盘** ——
    // 这两项是从外面改浮窗外观的唯一途径，不能等下次挪窗口才顺手存进去
    // （#167 决议）。
    const field = this.fieldSpec(key);
    const low = Math.trunc(field.min);
    const high = Math.trunc(field.max);
    const disp = dispSection(this.settings);
    const current = Math.trunc(num(disp[key], field.default));
    const value = Math.max(low, Math.min(high, current + delta));
    disp[key] = value;
    try {
      this.saveImpl(this.settings);
    } catch {
      // OSError: pass (Python semantics)
    }
    return value;
  }

  nudge_font(d: number): number {
    return this.nudgeTuned("font_size", d);
  }

  nudge_opacity(d: number): number {
    return this.nudgeTuned("bg_opacity", d);
  }
}

// ---------------------------------------------------------------------------
// Wrap algorithm (draw_wrapped, measurer-injected)
// ---------------------------------------------------------------------------

export interface Measurer {
  // QFontMetrics.horizontalAdvance equivalent (any consistent unit).
  advance(text: string): number;
  // QFontMetrics.height equivalent.
  height(): number;
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }

export function wrap_text(text: string, area: Rect, m: Measurer, startY: number): { lines: string[]; end_y: number } {
  const line_h = m.height() + 3;
  // Wrap on spaces where possible, then split overlong words by character
  // width. Chinese subtitles commonly contain no spaces at all.
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";

  const split_word = (word: string): string[] => {
    const parts: string[] = [];
    let part = "";
    for (const ch of word) {
      const candidate = part + ch;
      if (part && m.advance(candidate) > area.w) {
        parts.push(part);
        part = ch;
      } else {
        part = candidate;
      }
    }
    if (part) parts.push(part);
    return parts;
  };

  for (const w of words) {
    const cand = (cur + " " + w).trim();
    if (m.advance(cand) <= area.w) {
      cur = cand;
    } else {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      const parts = split_word(w);
      if (parts.length) {
        for (const p of parts.slice(0, -1)) lines.push(p);
        cur = parts[parts.length - 1]!;
      }
    }
  }
  if (cur) lines.push(cur);

  // The draw loop: vertical budget with the +8 bottom tolerance, 1:1 with
  // _draw_wrapped. Returns only the lines that would be drawn plus end_y.
  const drawn: string[] = [];
  let y = startY;
  for (const ln of lines) {
    if (y + line_h > area.y + area.h + 8) break;
    drawn.push(ln);
    y += line_h;
  }
  return { lines: drawn, end_y: y + 4 };
}

// ---------------------------------------------------------------------------
// Geometry math (drag + 8-edge resize, LiveSubs-style manual calculation)
// ---------------------------------------------------------------------------

export type ResizeEdge = "t" | "b" | "l" | "r" | "tl" | "tr" | "bl" | "br";

export function edge_at(px: number, py: number, w: number, h: number): ResizeEdge | null {
  const m = RESIZE_MARGIN;
  const left = px <= m;
  const right = px >= w - m;
  const top = py <= m;
  const bottom = py >= h - m;
  if (top && left) return "tl";
  if (top && right) return "tr";
  if (bottom && left) return "bl";
  if (bottom && right) return "br";
  if (top) return "t";
  if (bottom) return "b";
  if (left) return "l";
  if (right) return "r";
  return null;
}

export function apply_resize(edge: ResizeEdge, g: Pt, pressGeom: Rect, pressGlobal: Pt): Rect {
  // min 1x1: guard zero-size only; no user-facing limit. Baseline is the
  // PRESS geometry (not current) - re-applying with the same cursor position
  // returns to the press-time size, which is what the latch regression pins.
  const min_w = 1, min_h = 1;
  const geo: Rect = { ...pressGeom };
  const dx = g.x - pressGlobal.x;
  const dy = g.y - pressGlobal.y;
  if (edge.includes("l")) {
    const new_w = geo.w - dx;
    if (new_w >= min_w) geo.x = geo.x + dx;
  }
  if (edge.includes("r")) {
    geo.w = Math.max(min_w, geo.w + dx);
  }
  if (edge.includes("t")) {
    const new_h = geo.h - dy;
    if (new_h >= min_h) geo.y = geo.y + dy;
  }
  if (edge.includes("b")) {
    geo.h = Math.max(min_h, geo.h + dy);
  }
  return geo;
}
