// Port of desktop/suboverlay/debug_window.py - the settings & debug window:
// a non-modal, parentless, frameless tool panel + top page switcher
// (spec #161/#162, map #164).
//
// Three pages: 设置 / 调参 / 排障 (the settings page moved in from the former
// modal dialog). The whole window shares ONE footer "保存 / 取消": both pages
// apply their edits into the same settings object and the file is written
// exactly once (settings.save's atomic write) - a cross-page commit is one
// atomic action. Cancel = everything back to that settings' current values,
// no write, no overlay touch.
//
// Closing with unsaved edits asks first (three-way, default 回去继续改);
// choosing 回去继续改 stops nothing - reopening re-takes the baseline in the
// show-event hook, which is exactly the "re-snapshot on every open" mount
// point (the pit recorded in map #164: the tuning baseline used to be taken
// once at construction while the window instance is permanently reused).
//
// The window surface is OPAQUE (see tokens.ts); frameless + self-drawn title
// row remain required (drag / × / Esc).
//
// Conversion notes (ticket #205): there is no QWidget here - the shell is a
// headless model owned by the main process and mirrored to a bare-DOM
// renderer over IPC. Qt specifics land as follows:
//   - closeEvent/hideEvent/showEvent -> close()/hide()/show() model methods
//     with the same re-snapshot-once-per-visibility contract.
//   - QKeySequence.Save (Ctrl+S) -> the renderer keydown binding forwards a
//     save intent; the model exposes save_via_shortcut() and never closes.
//   - _ask_unsaved_changes stays an injectable seam (module-level monkeypatch
//     seam in Python); the host injects an Electron message box, headless
//     tests inject stubs, and the default throws rather than silently lose
//     edits.
//   - Qt's minimumSizeHint is replaced by an explicit layout model
//     (min_content_height per page, constants mirroring debug.html's CSS);
//     the geometric guarantees the #180 tests pin (window never exceeds
//     avail - margin, footer outside the scroll region, every page scrolls
//     to its last row) are asserted on that model.
//   - _os_label: sys.getwindowsversion().build -> os.release() third
//     component (the build number on Windows).
import os from "node:os";
import * as S from "../settings.ts";
import { DEFAULT_PORT } from "../protocol.ts";
import { field_by_path, type TuningPath } from "../settings.ts";
import { TuningPage } from "./tuning-page.ts";
import { SettingsPage, type PageTester } from "./settings-page.ts";
import { DiagPage } from "./diag-page.ts";

export const PAGES: readonly string[] = ["settings", "tuning", "diag"];
export type PageName = (typeof PAGES)[number];
export const PAGE_TITLES: Record<string, string> = {
  settings: "设置", tuning: "调参", diag: "排障",
};
export const SHADOW_MARGIN = 24;

// Design size (the prototype's 1120x760) and the short-screen fallback
// (#180): page content goes to the outer scroll region, the window only
// shrinks to the screen's available area, so the footer (Cancel / Save)
// stays on screen.
export const PREFERRED_W = 1120;
export const PREFERRED_H = 760;
export const MIN_W = 560;
export const MIN_H = 360;
// Fixed height of the title row + footer + inner/outer margins (page-content
// independent; measured 1015 - 858 = 157 in Qt, 160 in the DOM model).
export const CHROME_H = 160;
export const SCREEN_MARGIN = 64;

export function fit_to_screen(wanted_w: number, wanted_h: number,
                              avail_w: number, avail_h: number,
                              margin: number = SCREEN_MARGIN): [number, number] {
  // Clamp "how big the window wants to be" into the screen's available area
  // (margin on every side). Both take min(wanted, avail - margin), floored at
  // MIN_W / MIN_H: on a short screen the window is shorter than the content's
  // natural height and the outer scroll region catches it (DebugWindow scroll).
  const width = Math.max(MIN_W, Math.min(Math.trunc(wanted_w), Math.trunc(avail_w) - margin));
  const height = Math.max(MIN_H, Math.min(Math.trunc(wanted_h), Math.trunc(avail_h) - margin));
  return [width, height];
}

// Results of the close interception (ask_unsaved_changes).
export const CONFIRM_STAY = "stay";
export const CONFIRM_SAVE = "save";
export const CONFIRM_DISCARD = "discard";
export type ConfirmChoice = "stay" | "save" | "discard";

export interface AskInfo {
  settings_dirty: boolean;
  tuning_dirty: boolean;
}
export type AskUnsavedChanges = (info: AskInfo) => ConfirmChoice;

export interface OverlayNotify {
  reread_settings(): void;
}
export type SaveFn = (cfg: S.Settings, path?: string) => unknown;

// ---- the layout model (replaces Qt's minimumSizeHint) ----
// Constants mirror debug.html's CSS: control rows 30px + 6px gap, group
// titles 22px + 8px, textareas their fixed px heights, card padding 20px
// twice, 10px between cards.
const ROW = 36;            // one control row incl. spacing
const TITLE = 30;          // group/card title incl. spacing
const CARD_PAD = 40;       // top+bottom padding of a card
const CARD_GAP = 10;

function tuning_height(): number {
  const counts: Record<string, number> = { display: 8, network: 3, experimental: 5 };
  let h = 0;
  for (const g of S.TUNING_GROUPS) h += TITLE + counts[g]! * ROW + CARD_PAD + CARD_GAP;
  return h;
}

function settings_height(): number {
  // credentials: title + 5 rows; prompt: title + combo + button row + label +
  // editor(90) + label + preview(90) + label + checkbox; test: title +
  // buttons + progress + label + report(150).
  const credentials = TITLE + 5 * ROW + CARD_PAD;
  const prompt = TITLE + 3 * ROW + 2 * 22 + 90 + 90 + CARD_PAD;
  const test = TITLE + 2 * ROW + 22 + 150 + CARD_PAD;
  return credentials + prompt + test + 2 * CARD_GAP;
}

function diag_height(): number {
  // status bar + 4 zone cards (rows estimated for a typical read) + footer.
  const link = TITLE + 6 * 24 + CARD_PAD;
  const playback = TITLE + 11 * 24 + CARD_PAD;
  const queue = TITLE + 2 * 24 + CARD_PAD;
  const events = TITLE + 120 + CARD_PAD;
  return 30 + link + playback + queue + events + 38 + 5 * CARD_GAP;
}

export interface ScrollState {
  content_h: number;
  viewport_h: number;
  scroll_max: number;   // 0 when the content fits
}

export function default_os_label(): string {
  if (os.platform() !== "win32") return "非 Windows 桌面";
  const build = Number.parseInt(os.release().split(".")[2] ?? "0", 10) || 0;
  if (build <= 0) return "非 Windows 桌面";
  return (build >= 22000 ? "Windows 11" : "Windows 10") + " build " + build;
}

export class DebugWindow {
  readonly settings: S.Settings;
  readonly overlay: OverlayNotify | null;
  private readonly _save: SaveFn;
  private readonly _port: number;
  private readonly _ask: AskUnsavedChanges;
  private readonly _screen_avail: (() => { w: number; h: number } | null) | null;
  private _current: PageName;
  private _shown = false;
  private _listeners: Array<() => void> = [];

  settings_page: SettingsPage;
  tuning_page: TuningPage;
  diag_page: DiagPage;
  visible = false;
  width = PREFERRED_W;
  height = PREFERRED_H;
  status_label_text = "没有未保存的改动";
  save_button_enabled = false;

  constructor(settings: S.Settings, opts: {
    port?: number;
    overlay?: OverlayNotify | null;
    tester?: PageTester | null;
    save?: SaveFn;
    page?: string;
    ask_unsaved_changes?: AskUnsavedChanges;
    screen_avail?: (() => { w: number; h: number } | null) | null;
    poll_timer?: { start(): void; stop(): void } | null;
  } = {}) {
    this.settings = settings;
    this.overlay = opts.overlay ?? null;
    this._save = opts.save ?? S.save;
    this._ask = opts.ask_unsaved_changes ?? (() => {
      throw new Error("no ask_unsaved_changes seam injected: the host must provide the close prompt");
    });
    this._screen_avail = opts.screen_avail ?? null;
    const server = S.isJsonObject(settings["server"]) ? settings["server"] as S.JsonObject : {};
    const port_value = opts.port !== undefined ? opts.port : (server["port"] as number | undefined);
    this._port = Math.trunc(port_value !== undefined && port_value !== null
      ? Number(port_value) : DEFAULT_PORT);
    const requested = opts.page ?? "tuning";
    this._current = (PAGES.indexOf(requested) >= 0 ? requested : PAGES[0]) as PageName;
    this.settings_page = new SettingsPage(settings, opts.tester ?? null, null,
      opts.poll_timer ?? null);
    this.tuning_page = new TuningPage(settings);
    this.diag_page = new DiagPage(this._port);
    // Any edit on either committing page refreshes the footer (the Save
    // button's availability and the count line).
    this.settings_page.on_changed(() => this._refresh_footer());
    this.tuning_page.on_changed(() => this._refresh_footer());
    this._refresh_footer();
    // Construction-time fit (Python __init__ calls fit_to_available()): only
    // meaningful when a screen seam exists (headless tests shrink explicitly).
    const avail = this._screen_avail !== null ? this._screen_avail() : null;
    if (avail !== null) this.fit_to_available(avail.w, avail.h);
  }

  // ---- what the host and the tests use ----

  current_page_name(): string {
    return this._current;
  }

  // The size the window naturally wants: width = design value; height = the
  // larger of the design target and the fully-expanded content + chrome.
  wanted_size(): [number, number] {
    return [PREFERRED_W, Math.max(PREFERRED_H, this.stack_min_height() + CHROME_H)];
  }

  fit_to_available(avail_w?: number, avail_h?: number): [number, number] {
    // Clamp into the screen's available area (ask the screen when not given).
    // On a short screen the window height ends up below the content's natural
    // height - the outer scroll region catches it and the footer (outside the
    // scroll region) stays visible and clickable (#180's acceptance line:
    // h <= avail_h - SCREEN_MARGIN).
    let aw = avail_w;
    let ah = avail_h;
    if (aw === undefined || ah === undefined) {
      const area = this._screen_avail !== null ? this._screen_avail() : null;
      if (area === null) return [this.width, this.height];
      aw = area.w;
      ah = area.h;
    }
    const [w, h] = fit_to_screen(...this.wanted_size(), aw!, ah!);
    this.width = w;
    this.height = h;
    return [w, h];
  }

  resize(w: number, h: number): void {
    // Qt clamps to the window minimum size.
    this.width = Math.max(MIN_W, Math.trunc(w));
    this.height = Math.max(MIN_H, Math.trunc(h));
  }

  show_page(name: string): void {
    const idx = PAGES.indexOf(name);
    if (idx < 0) {
      const e = new Error("no such page: " + name);
      e.name = "KeyError";
      throw e;
    }
    this._current = name as PageName;
    this._notify();
  }

  dirty_counts(): [number, number] {
    return [this.settings_page.count_dirty(), this.tuning_page.count_dirty()];
  }

  dirty_count(): number {
    const [a, b] = this.dirty_counts();
    return a + b;
  }

  // Whether the whole window still has unsaved edits (the footer line and the
  // close interception both read this).
  is_dirty(): boolean {
    return this.dirty_count() > 0;
  }

  // Whole-window save: both pages apply into the same settings, then the file
  // is written EXACTLY ONCE.
  save(): boolean {
    const tuning_applied: TuningPath[] = this.tuning_page.apply();
    const settings_applied: string[] = this.settings_page.apply();
    if (tuning_applied.length > 0 || settings_applied.length > 0) {
      this._save(this.settings);         // one atomic disk write (settings.save)
    }
    if (this.overlay !== null &&
        tuning_applied.some((p) => field_by_path(p).notify_overlay)) {
      this.overlay.reread_settings();    // mode/order are the overlay's boot snapshot
    }
    this.snapshot();
    return tuning_applied.length > 0 || settings_applied.length > 0;
  }

  // Discard the whole window's unsaved edits (both pages back to the
  // settings' current values).
  cancel(): void {
    this.settings_page.cancel();
    this.tuning_page.cancel();
    this._refresh_footer();
  }

  // Re-take the baseline (window opened / save succeeded / cancelled or
  // discarded).
  snapshot(): void {
    this.settings_page.snapshot();
    this.tuning_page.snapshot();
    this._refresh_footer();
  }

  // Ctrl+S: save without closing (the Esc key remains the close path).
  save_via_shortcut(): boolean {
    return this.save();
  }

  // ---- the Qt-event equivalents ----

  // closeEvent: ask first when dirty; on confirm stop the pages (close stops
  // fetching; the reused instance restarts on next show) and hide.
  close(): boolean {
    if (!this._confirm_close()) return false;
    this._stop_pages();
    this.visible = false;
    // An accepted closeEvent hides the widget, which fires hideEvent and
    // resets the once-per-visibility guard - the next open re-snapshots.
    this._shown = false;
    this._notify();
    return true;
  }

  // showEvent: first show after a hide = re-take the baseline + re-fit to the
  // available area (the instance is permanently reused by the host; after a
  // screen/resolution change only this recompute counts).
  show(): void {
    this.visible = true;
    if (!this._shown) {
      this._shown = true;
      this.fit_to_available();
      this.snapshot();
    }
    this._notify();
  }

  hide(): void {
    this.visible = false;
    this._shown = false;
    this._notify();
  }

  // ---- internals ----

  private _refresh_footer(): void {
    const count = this.dirty_count();
    this.save_button_enabled = count > 0;
    this.status_label_text = count === 0
      ? "没有未保存的改动"
      : "有 " + count + " 项改动没保存";
  }

  private _confirm_close(): boolean {
    if (!this.is_dirty()) return true;
    const [settings_dirty, tuning_dirty] = this.dirty_counts();
    const choice = this._ask({
      settings_dirty: settings_dirty > 0,
      tuning_dirty: tuning_dirty > 0,
    });
    if (choice === CONFIRM_STAY) return false;
    if (choice === CONFIRM_SAVE) this.save();
    else this.cancel();
    return true;
  }

  private _stop_pages(): void {
    // Close cleanup, idempotent: diag first (stop() only stops the polling),
    // then give up an in-flight connection test.
    this.diag_page.stop();
    this.settings_page.cancel_test();
  }

  // ---- change notification (the host pushes state after these) ----

  on_change(cb: () => void): void {
    this._listeners.push(cb);
  }

  _notify(): void {
    for (const cb of this._listeners) cb();
  }

  // ---- layout model (Qt minimumSizeHint equivalents) ----

  stack_min_height(): number {
    // QStackedWidget's minimum hint is the max over its pages.
    return Math.max(tuning_height(), settings_height(), diag_height());
  }

  page_min_height(page: string): number {
    if (page === "settings") return settings_height();
    if (page === "tuning") return tuning_height();
    if (page === "diag") return diag_height();
    throw new Error("no such page: " + page);
  }

  // The outer scroll region's state for the current page at the current
  // window size: content vs viewport, and how far the scrollbar can travel.
  scroll_state(page: string): ScrollState {
    const content_h = this.page_min_height(page);
    const viewport_h = Math.max(0, this.height - CHROME_H);
    return {
      content_h,
      viewport_h,
      scroll_max: Math.max(0, content_h - viewport_h),
    };
  }

  env_label(): string {
    return default_os_label();
  }
}

// The two menu entries open ONE window instance, landing on different pages
// (map #164's goal). Pure helper so the contract stays testable headlessly.
export function open_or_reuse(existing: DebugWindow | null, page: string,
                              make: () => DebugWindow): DebugWindow {
  const w = existing ?? make();
  w.show_page(page);
  w.show();
  return w;
}
