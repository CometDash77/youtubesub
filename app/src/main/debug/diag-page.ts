// Port of desktop/suboverlay/debug_diag_page.py - the diag page: one persistent
// status bar + a screen of four zones (spec #162).
//
// This page only renders and interacts; it never fetches: fetching, recording
// and scheduling live in debug_probe / debug_events / debug_poller. The page
// consumes a Snapshot and the event list; the poller and the clock are both
// injectable, so the whole presentation is assertable headlessly.
//
// Failure presentation (decisions 8/9): the status bar turns terracotta
// "cannot connect" + "last success HH:MM:SS (N seconds ago)", the value zones
// keep the last good read but greyed; a CONTINUOUS failure beyond ~10 seconds
// clears the value zones, leaving only the status bar. "Never fetched" and
// "cannot connect" share the same presentation - no blank page ever.
//
// Hard boundary (decisions 16/17): only keys that ALREADY exist in the status
// payload are displayed; signals that cannot be read (queue depth, in-flight,
// backoff, cache hit rate / entries / db size, connection count, frame age,
// per-source frame counts) are never displayed - the correct move is to not
// show them, not to extend /status.
//
// Conversion notes (ticket #205): the QThreadPool probe task becomes an async
// fetch whose result lands via poller.report() (DEFERRED path) - start()
// returns before the read finishes by construction. The clipboard is an
// injectable seam; the renderer performs the actual copy.
import { EventRecorder } from "./events.ts";
import { DEFERRED, StatusPoller, type FetchResult, type ScheduleFn } from "./poller.ts";
import { Snapshot, fetch_status } from "./probe.ts";

export const HOST = "127.0.0.1";
export const FREQUENCIES: readonly number[] = [0.5, 1.0, 2.0];
export const STALE_AFTER_S = 10.0;
export const ZONES: ReadonlyArray<readonly [string, string]> = [
  ["link", "① 浏览器插件连接"], ["playback", "② 播放与字幕"],
  ["queue", "③ 翻译队列"], ["events", "④ 事件记录"],
];
export const LEVEL_OBJECT: Record<string, string> = {
  ok: "debugBadgeOk", warn: "debugBadgeWarn", error: "debugBadgeError",
};
export const ERROR_LABELS: ReadonlySet<string> = new Set([
  "服务端错误", "状态提供者错误", "页面钩子", "字幕抓取",
]);

type Row = readonly [string, string];
type Level = "ok" | "warn" | "error";

function text_or(value: unknown, fallback = "—"): string {
  const t = value === null || value === undefined ? "" : String(value);
  return t ? t : fallback;
}

function int_or_zero(value: unknown): number {
  // bool is a number subtype in Python only; JS typeof true is "boolean".
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.trunc(value);
}

function number_text(value: unknown): string {
  if (typeof value !== "number" || Number.isNaN(value)) return text_or(value);
  return String(value);
}

function yes_no(value: unknown): string {
  return value ? "是" : "否";
}

function stamp(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

export interface PollerLike {
  interval: number;
  start(): void;
  stop(): void;
  set_interval(seconds: number): void;
  refresh_now(): void;
}

export class DiagPage {
  private readonly _port: number;
  private readonly _clock: () => number;
  readonly _recorder: EventRecorder;
  readonly _poller: PollerLike;
  private readonly _clipboard: { setText(t: string): void } | null;
  private _failing = false;
  private _last_data: Record<string, unknown> | null = null;
  private _last_ok_at: number | null = null;
  private _streak_started_at: number | null = null;
  private _stale = false;
  private _bar_text = "";
  private _level: Level = "ok";
  private _ct_expanded = false;
  private _rows: Record<string, Row[]> = {};
  private _zone_level: Record<string, [string, Level]> = {};
  private _ct_enabled = true;

  constructor(port: number, opts: {
    poller?: PollerLike;
    recorder?: EventRecorder;
    clock?: () => number;
    schedule?: ScheduleFn;
    clipboard?: { setText(t: string): void } | null;
  } = {}) {
    this._port = Math.trunc(Number(port));
    this._clock = opts.clock ?? (() => Date.now() / 1000);
    this._recorder = opts.recorder ?? new EventRecorder(this._clock());
    this._clipboard = opts.clipboard ?? null;
    this._poller = opts.poller ?? new StatusPoller(
      () => this._fetch_async(),
      (s) => this.apply(s),
      opts.schedule ?? default_schedule,
      1.0);
    this._render();
  }

  // ---- what the window and the tests use ----

  // A read came back (or a failed read). Never raises.
  apply(snapshot: Snapshot): void {
    const now = this._clock();
    this._recorder.observe(snapshot, now);
    if (snapshot.ok) {
      const data = snapshot.data;
      this._last_data = data !== null && typeof data === "object" ? { ...data } : {};
      this._last_ok_at = now;
      this._failing = false;
      this._streak_started_at = null;
    } else {
      if (this._streak_started_at === null) {
        this._streak_started_at = now;
      }
      this._failing = true;
    }
    this._render();
  }

  status_bar_text(): string {
    return this._bar_text;
  }

  status_bar_level(): Level {
    return this._level;
  }

  // True while the value zones still show the last good read (greyed).
  zones_stale(): boolean {
    return this._stale;
  }

  zone_rows(zone: string): Row[] {
    return [...(this._rows[zone] ?? [])];
  }

  // (text, level) of the one colour badge in that zone's title (spec #162
  // decision 20: exactly one status badge per zone).
  zone_badge(zone: string): [string, Level] | undefined {
    return this._zone_level[zone];
  }

  copy_all_text(): string {
    const lines: string[] = [
      "调试页 · 复制于 " + stamp(this._clock()),
      "状态: " + this._bar_text,
    ];
    if (this._stale) lines.push("注: 以下为上一拍的值（已过期）");
    for (const [name, title] of ZONES) {
      lines.push("[" + title + "]");
      for (const [label, value] of this._rows[name] ?? []) {
        lines.push(label ? label + ": " + value : value);
      }
    }
    return lines.join("\n");
  }

  copy_to_clipboard(): string {
    const t = this.copy_all_text();
    if (this._clipboard !== null) this._clipboard.setText(t);
    return t;
  }

  set_frequency(seconds: unknown): number | null {
    let s: number;
    try {
      s = Number(seconds);
      if (Number.isNaN(s)) return null;
    } catch {
      return null;
    }
    let gear = FREQUENCIES[0]!;
    let best: [number, number] = [Math.abs(FREQUENCIES[0]! - s), FREQUENCIES[0]!];
    for (const option of FREQUENCIES) {
      const key: [number, number] = [Math.abs(option - s), option];
      if (key[0]! < best[0]! || (key[0] === best[0] && key[1]! < best[1]!)) {
        best = key;
        gear = option;
      }
    }
    this._poller.set_interval(gear);
    return gear;
  }

  frequency(): number {
    return Number(this._poller.interval);
  }

  refresh_now(): void {
    this._poller.refresh_now();
  }

  connection_test_expanded(): boolean {
    return this._ct_expanded;
  }

  set_connection_test_expanded(expanded: boolean): void {
    this._ct_expanded = Boolean(expanded);
    this._render();
  }

  ct_button_label(): string {
    return this._ct_expanded ? "收起连接测试" : "看上次的连接测试";
  }

  ct_button_enabled(): boolean {
    // Render-pass condition: not failing, or the last good read still shows.
    return this._ct_enabled;
  }

  start(): void {
    this._poller.start();
  }

  stop(): void {
    this._poller.stop();
  }

  // ---- the read leaves the UI thread (async probe, see probe.ts) ----

  private _fetch_async(): FetchResult {
    // Poller seam: hand the read to an async task. DEFERRED tells the poller
    // "this tick has not come back yet; the result arrives via report()".
    void fetch_status(this._port).then((s) => this._probe_finished(s));
    return DEFERRED;
  }

  private _probe_finished(snapshot: Snapshot): void {
    // The default poller is always the StatusPoller (the FakePoller the tests
    // inject never reaches this path - it does no real fetching, like Python).
    (this._poller as StatusPoller).report(snapshot);
  }

  // ---- rendering ----

  private _render(): void {
    const now = this._clock();
    let data: Record<string, unknown> | null;
    if (this._failing) {
      const streak = now - (this._streak_started_at ?? now);
      const gone = this._last_data === null || streak > STALE_AFTER_S;
      data = gone ? null : { ...this._last_data };
    } else {
      data = this._last_data !== null ? { ...this._last_data } : null;
    }
    this._stale = Boolean(this._failing && data !== null);
    const [level, bar_text] = this._bar(data, now);
    this._level = level;
    this._bar_text = bar_text;
    this._zone_level = this._zone_badges(data);
    this._rows = this._build_rows(data);
    this._ct_enabled = !this._failing || data !== null;
  }

  // One badge per value zone, in the zone title: ① connectivity / ② whether
  // the subtitle chain is healthy / ③ the translation state itself.
  //
  // Never lie without data: a failed read -> 不通 (even while the value zones
  // still grey-show the last good values); never fetched -> 等待.
  private _zone_badges(data: Record<string, unknown> | null): Record<string, [string, Level]> {
    if (data === null || this._failing) {
      const [text, level]: [string, Level] = this._failing ? ["不通", "error"] : ["等待", "warn"];
      const out: Record<string, [string, Level]> = {};
      for (const zone of ["link", "playback", "queue"]) out[zone] = [text, level];
      return out;
    }
    const stats_raw = data["stats"];
    const stats = (stats_raw !== null && typeof stats_raw === "object" && !Array.isArray(stats_raw)
      ? stats_raw : {}) as Record<string, unknown>;
    const link: Level = stats["error"] || data["status_error"] ? "warn" : "ok";
    let playback: Level = "ok";
    if (data["hook_error"] || data["capture_error"] || data["state"] !== "ok") {
      playback = "warn";
    }
    const trans_state = String(data["trans_state"] ?? "").trim() || "—";
    let queue: Level;
    if (trans_state.startsWith("failed")) queue = "error";
    else if (trans_state === "—" || trans_state === "unconfigured") queue = "warn";
    else queue = "ok";
    return {
      link: [link === "ok" ? "正常" : "有错误", link],
      playback: [playback === "ok" ? "正常" : "注意", playback],
      queue: [trans_state, queue],
    };
  }

  private _bar(data: Record<string, unknown> | null, now: number): [Level, string] {
    const head = "连不上 " + HOST + ":" + this._port;
    if (this._failing) {
      if (this._last_ok_at === null) {
        return ["error", head + " · 本窗口还没有成功取到过数据"];
      }
      const age = Math.trunc(Math.max(0.0, now - this._last_ok_at));
      return ["error", head + " · 上次成功 " + stamp(this._last_ok_at) + "（" + age + " 秒前）"];
    }
    if (data === null) {
      return ["warn", "等待第一拍……"];
    }
    const level = level_of(data);
    let text = "已连接 " + HOST + ":" + this._port;
    if (level === "warn") text += " · 有需要处理的问题";
    return [level, text];
  }

  private _build_rows(data: Record<string, unknown> | null): Record<string, Row[]> {
    if (data === null) {
      return { link: [], playback: [], queue: [], events: this._event_rows() };
    }
    return {
      link: this._link_rows(data),
      playback: this._playback_rows(data),
      queue: this._queue_rows(data),
      events: this._event_rows(),
    };
  }

  private _link_rows(data: Record<string, unknown>): Row[] {
    const stats_raw = data["stats"];
    const stats = (stats_raw !== null && typeof stats_raw === "object" && !Array.isArray(stats_raw)
      ? stats_raw : {}) as Record<string, unknown>;
    const rows: Row[] = [
      ["服务", "已连接 " + HOST + ":" + this._port],
      ["累计帧数", String(int_or_zero(stats["frames"]))],
      ["坏帧数", String(int_or_zero(stats["bad_frames"]))],
    ];
    if (stats["error"]) rows.push(["服务端错误", text_or(stats["error"])]);
    if (data["status_error"]) rows.push(["状态提供者错误", text_or(data["status_error"])]);
    rows.push(["来源数", String(int_or_zero(data["sources"]))]);
    rows.push(["活跃来源", text_or(data["active_source"])]);
    return rows;
  }

  private _playback_rows(data: Record<string, unknown>): Row[] {
    const rows: Row[] = [
      ["字幕状态", text_or(data["state"])],
      ["标题", text_or(data["title"])],
      ["在播", yes_no(data["playing"])],
      ["倍速", number_text(data["rate"])],
      ["显示模式", text_or(data["mode"])],
      ["显示顺序", text_or(data["order"])],
      ["原文", text_or(data["orig"])],
      ["译文", text_or(data["trans"])],
      ["点击穿透", yes_no(data["click_through"])],
    ];
    if (data["hook_error"]) rows.push(["页面钩子", text_or(data["hook_error"])]);
    if (data["capture_error"]) rows.push(["字幕抓取", text_or(data["capture_error"])]);
    return rows;
  }

  private _queue_rows(data: Record<string, unknown>): Row[] {
    const rows: Row[] = [
      ["可翻译", yes_no(data["trans_available"])],
      ["翻译态", text_or(data["trans_state"])],
    ];
    if (this._ct_expanded) {
      rows.push(...connection_test_rows(data["connection_test"]));
    }
    return rows;
  }

  private _event_rows(): Row[] {
    const rows: Row[] = [["", this._recorder.opened_label()]];
    for (const event of this._recorder.events()) {
      rows.push([event.time + " (+" + int_or_zero(event.rel) + "s)", text_or(event.text)]);
    }
    return rows;
  }
}

// Python: min(FREQUENCIES, key=lambda option: (abs(option - seconds), option))
// is only used by the poller-interval gear pick; kept next to the page.
function level_of(data: Record<string, unknown>): Level {
  const stats_raw = data["stats"];
  const stats = (stats_raw !== null && typeof stats_raw === "object" && !Array.isArray(stats_raw)
    ? stats_raw : {}) as Record<string, unknown>;
  if (stats["error"] || data["status_error"]) return "warn";
  if (data["hook_error"] || data["capture_error"]) return "warn";
  if (String(data["trans_state"] ?? "").startsWith("failed")) return "warn";
  return "ok";
}

function connection_test_rows(report: unknown): Row[] {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return [["连通测试结论", "（还没有跑过）"]];
  }
  const r = report as Record<string, unknown>;
  const rows: Row[] = [
    ["连通测试结论", String(r["verdict"] ?? "").toUpperCase() || "—"],
  ];
  const layers = Array.isArray(r["layers"]) ? r["layers"] as Record<string, unknown>[] : [];
  for (const layer of layers) {
    if (layer === null || typeof layer !== "object") continue;
    const passed = layer["passed"];
    const mark = passed === true ? "PASS" : (passed === false ? "FAIL" : "--");
    const head = [
      mark,
      layer["code"] ? "[" + String(layer["code"]) + "]" : "",
      text_or(layer["message"]),
    ].filter((part) => part).join(" ");
    rows.push(["层 " + text_or(layer["id"]),
      head + " (" + String(layer["elapsed_ms"] ?? 0) + " 毫秒)"]);
  }
  if (r["attempts"]) rows.push(["尝试次数", String(int_or_zero(r["attempts"]))]);
  if (r["skipped"]) {
    rows.push(["跳过", (r["skipped"] as unknown[]).map((s) => String(s)).join(", ")]);
  }
  const messages = (r["warning_messages"] ?? {}) as Record<string, unknown>;
  if (r["warnings"]) {
    rows.push(["警告", (r["warnings"] as string[])
      .map((code) => String(messages[code] ?? code)).join("; ")]);
  }
  if (r["duration_ms"]) rows.push(["用时", int_or_zero(r["duration_ms"]) + " 毫秒"]);
  return rows;
}

function default_schedule(seconds: number, callback: () => void): void {
  setTimeout(callback, Math.max(0, Math.round(seconds * 1000)));
}
