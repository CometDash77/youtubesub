// Port of desktop/suboverlay/debug_tuning_page.py - the tuning page: the
// "has-a-key-but-no-UI" parameters rendered as three groups (spec #161, 16
// items since map #164).
//
// The control layer cannot produce illegal values (enum dropdowns / bounded
// number boxes / color picker); the write-back clamps only the keys touched
// this time. The footer Save lives at the window level (debug/window.ts);
// this page only applies its edits into the settings object. Editing and
// taking effect are decoupled: while editing, the settings the engine is
// reading are never touched, so dragging a control never jolts a running
// prefetch/batch.
//
// The page knows NO concrete field: it grows entirely from
// settings.TUNING_FIELDS - range/default/unit/copy all come from that single
// authority table.
//
// Conversion notes (ticket #205): Qt widgets become a headless control model
// (kind + value + bounds); the changed Qt signal becomes a listener list
// (onChanged / changed()). A Qt setValue with an unchanged value emits
// nothing - the model fires "changed" only on actual value changes, matching
// QSpinBox/QComboBox semantics. The color picker is a seam: production opens
// it renderer-side (bare DOM <input type=color>); the headless default
// returns null (cancels). slider+spin pair: the field value is the number
// box (integer semantics); both stay in sync.
import * as S from "../settings.ts";
import { path_key, field_by_path, type FieldSpec, type TuningPath, type Json } from "../settings.ts";

export const GROUP_TITLES: Record<string, string> = {
  display: "显示",
  network: "网络与服务",
  experimental: "实验（未校准）",
};

const ORDER_PATH: TuningPath = ["display", "order"];
const MODE_PATH: TuningPath = ["display", "mode"];

function decimals_of(step: number): number {
  const text = String(Number(step));
  return text.includes(".") ? text.split(".")[1]!.length : 0;
}

// Round a UI value through the authority table (clamp + unit) and back.
function normalize(field: FieldSpec, value: Json): Json {
  const [section, key] = field.path;
  const stored = S.stored_value(field, value);
  return S.display_value(field, { [section]: { [key]: stored } });
}

export type UiValue = string | number | number[];

interface ControlBase {
  kind: "choice" | "int" | "float" | "slider" | "color";
  enabled: boolean;
}
interface ChoiceControl extends ControlBase { kind: "choice"; value: string; }
interface IntControl extends ControlBase { kind: "int"; value: number; }
interface FloatControl extends ControlBase { kind: "float"; value: number; }
interface ColorControl extends ControlBase { kind: "color"; rgb: number[]; }
interface SliderPair extends ControlBase { kind: "slider"; slider: number; spin: number; }
type Control = ChoiceControl | IntControl | FloatControl | ColorControl | SliderPair;

export class TuningPage {
  // The settings this page edits (NOT copied - same object as the window's).
  readonly settings: S.Settings;
  private _pick_color: (title: string, current: number[]) => number[] | null;
  private _initial: Map<string, Json>;
  private _controls = new Map<string, Control>();
  private _changed_listeners: Array<() => void> = [];

  constructor(settings: S.Settings, pick_color: ((title: string, current: number[]) => number[] | null) | null = null) {
    this.settings = settings;
    this._pick_color = pick_color ?? (() => null);
    this._initial = S.tuning_ui_state(settings);
    this._build();
  }

  // ---- page surface (what the tests and the window use) ----

  group_title(group: string): string {
    return GROUP_TITLES[group] ?? group;
  }

  // One line of "what changes if I touch this"; restart/uncalibrated badges
  // are appended by the page uniformly, never written into the field hint.
  hint_for(path: TuningPath): string {
    const field = field_by_path(path);
    const parts: string[] = field.hint ? [field.hint] : [];
    if (field.restart) parts.push("重启后生效");
    if (field.uncalibrated) parts.push("未校准");
    return parts.join(" · ");
  }

  is_field_enabled(path: TuningPath): boolean {
    if (path_key(path) === path_key(ORDER_PATH)) {
      return this.field_value(MODE_PATH) === "bilingual";
    }
    const c = this._controls.get(path_key(path));
    return c ? c.enabled : false;
  }

  field_value(path: TuningPath): UiValue {
    const c = this._controls.get(path_key(path))!;
    if (c.kind === "color") return [...c.rgb];
    if (c.kind === "slider") return Math.trunc(c.spin);
    if (c.kind === "choice") return c.value;
    if (c.kind === "int") return Math.trunc(c.value);
    return c.value;
  }

  // Set a control as a user would, clamped by the authority table.
  set_field_value(path: TuningPath, value: Json): void {
    const field = field_by_path(path); // throws outside the table (KeyError)
    const v = normalize(field, value);
    const c = this._controls.get(path_key(path))!;
    if (c.kind === "choice") {
      const idx = field.choices.indexOf(v as string);
      const next = field.choices[idx] ?? field.default as string;
      if (next !== c.value) { c.value = next; this._emit_changed(); }
    } else if (c.kind === "color") {
      const rgb = [...(v as number[])];
      if (JSON.stringify(rgb) !== JSON.stringify(c.rgb)) {
        c.rgb = rgb; this._emit_changed();
      }
    } else if (c.kind === "slider") {
      const n = Math.trunc(v as number);
      if (n !== c.spin) {
        c.spin = n;
        c.slider = n; // from_spin sync
        this._emit_changed();
      }
    } else if (c.kind === "int") {
      const n = Math.trunc(v as number);
      if (n !== c.value) { c.value = n; this._emit_changed(); }
    } else {
      const n = v as number;
      const rounded = Number(n.toFixed(decimals_of(field.step ?? 0.1)));
      if (rounded !== c.value) { c.value = rounded; this._emit_changed(); }
    }
    this._sync_enabled();
  }

  // ---- the three things the window footer needs: dirty, count, apply ----

  // Keys touched this time, in authority-table order; equal values do not
  // count as touched (not a dirty flag).
  collect_edits(): Array<[TuningPath, Json]> {
    return S.collect_edits(this._ui_state(), this._initial);
  }

  count_dirty(): number {
    return this.collect_edits().length;
  }

  is_dirty(): boolean {
    return this.count_dirty() > 0;
  }

  // Apply the edits into the settings object (NO disk write); returns the
  // changed paths. Disk write and overlay notification live at the window
  // level - one atomic save per window, overlay re-reads only notify_overlay
  // fields.
  apply(): TuningPath[] {
    return S.apply_edits(this.settings, this.collect_edits());
  }

  // Re-take the baseline and load the controls back from it (window opened /
  // saved / cancelled).
  snapshot(): void {
    this._initial = S.tuning_ui_state(this.settings);
    this._load_controls();
  }

  // Discard this page's unsaved edits (back to the settings' current values).
  cancel(): void {
    this.snapshot();
  }

  // ---- changed signal (the Qt signal equivalent) ----

  changed(): void { /* presence keeps the Python name readable in hosts */ }

  on_changed(cb: () => void): void {
    this._changed_listeners.push(cb);
  }

  private _emit_changed(): void {
    for (const cb of this._changed_listeners) cb();
  }

  // The color button click (control.clicked.emit() equivalent): the click
  // itself is wired to changed (like every other control), then the picker
  // seam runs; a picked color lands via set_field_value (which may emit
  // again, exactly like Qt's signal chain).
  click_color_button(path: TuningPath): void {
    this._pick_color_for(path);
    this._emit_changed();
  }

  // ---- construction ----

  private _build(): void {
    for (const field of S.TUNING_FIELDS) {
      const k = path_key(field.path);
      const initial = this._initial.get(k);
      if (field.control === "choice") {
        this._controls.set(k, { kind: "choice", enabled: true, value: initial as string });
      } else if (field.control === "int") {
        this._controls.set(k, { kind: "int", enabled: true, value: initial as number });
      } else if (field.control === "float") {
        this._controls.set(k, { kind: "float", enabled: true, value: initial as number });
      } else if (field.control === "slider") {
        const v = Math.trunc(initial as number);
        this._controls.set(k, { kind: "slider", enabled: true, slider: v, spin: v });
      } else {
        this._controls.set(k, { kind: "color", enabled: true, rgb: [...(initial as number[])] });
      }
    }
    this._sync_enabled();
  }

  label_text(field: FieldSpec): string {
    return field.label + (field.unit ? "（" + field.unit + "）" : "");
  }

  // Render model: the groups with their fields, in authority-table order -
  // the DOM builds from this (bare DOM, #205).
  groups(): Array<{ group: string; title: string; fields: FieldSpec[] }> {
    return S.TUNING_GROUPS.map((group) => ({
      group,
      title: this.group_title(group),
      fields: S.TUNING_FIELDS.filter((f) => f.group === group),
    }));
  }

  color_text(rgb: number[]): string {
    return "#" + rgb.map((c) => Math.trunc(c).toString(16).toUpperCase().padStart(2, "0")).join("");
  }

  // Structural control inspection - the findChildren(...) equivalent for the
  // headless model: kind + current values + enabled, keyed by authority table.
  control_view(path: TuningPath): Record<string, unknown> {
    const c = this._controls.get(path_key(path));
    if (!c) throw new Error("no such control: " + path_key(path));
    const view: Record<string, unknown> = { kind: c.kind, enabled: c.enabled };
    if (c.kind === "color") view.rgb = [...c.rgb];
    if (c.kind === "slider") { view.slider = c.slider; view.spin = c.spin; }
    else if (c.kind === "choice") view.value = c.value;
    else if (c.kind === "int") view.value = c.value;
    else if (c.kind === "float") view.value = c.value;
    return view;
  }

  slider_controls(): TuningPath[] {
    // findChildren(QSlider) equivalent: the paths whose control is a pair.
    return S.TUNING_FIELDS.filter((f) => f.control === "slider").map((f) => f.path);
  }

  private _load_controls(): void {
    for (const field of S.TUNING_FIELDS) {
      const k = path_key(field.path);
      const value = this._initial.get(k)!;
      const c = this._controls.get(k)!;
      if (c.kind === "color") {
        c.rgb = [...(value as number[])];
      } else if (c.kind === "slider") {
        c.spin = Math.trunc(value as number);
        c.slider = Math.trunc(value as number);
      } else if (c.kind === "choice") {
        c.value = value as string;
      } else if (c.kind === "int") {
        c.value = Math.trunc(value as number);
      } else {
        c.value = value as number;
      }
    }
    this._sync_enabled();
  }

  private _sync_enabled(): void {
    const order = this._controls.get(path_key(ORDER_PATH));
    if (order) order.enabled = this.is_field_enabled(ORDER_PATH);
  }

  private _pick_color_for(path: TuningPath): void {
    const c = this._controls.get(path_key(path))!;
    if (c.kind !== "color") return;
    const chosen = this._pick_color("选择背景色", c.rgb);
    if (chosen !== null && chosen.length === 3) {
      this.set_field_value(path, [chosen[0]!, chosen[1]!, chosen[2]!]);
    }
  }

  private _ui_state(): Map<string, Json> {
    const state = new Map<string, Json>();
    for (const f of S.TUNING_FIELDS) {
      const v = this.field_value(f.path);
      state.set(path_key(f.path), Array.isArray(v) ? [...v] as Json : v as Json);
    }
    return state;
  }
}
