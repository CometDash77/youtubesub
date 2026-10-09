// Port of desktop/suboverlay/debug_events.py - event recording: turn "one
// snapshot + one timestamp" into "which flip events did this read produce"
// (spec #162 decisions 2/3 + D3).
//
// Only FLIPS are recorded (appearances and disappearances, state changes,
// the start of a stall), never per-tick values; one continuous appearance
// records only its first event (change detection lives here, not in the
// renderer). Capacity 200 events or 30 minutes, whichever comes first;
// in-memory ring, never persisted, dropped when the page closes.
//
// "Event record" is not a log (nothing on disk) and not a snapshot (nothing
// exported) - see CONTEXT.md.
export const KINDS: readonly string[] = [
  "hook_error", "capture_error", "state", "trans_state", "fetch", "frames_stall",
];

export const CAPACITY = 200;
export const WINDOW_S = 1800.0;

export interface DebugEvent {
  at: number;
  time: string;
  rel: number;
  kind: string;
  text: string;
}

export interface ObserveInput {
  ok?: unknown;
  data?: unknown;
}

function hhmmss(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

export class EventRecorder {
  readonly opened_at: number;
  readonly capacity: number;
  readonly window_s: number;
  private _events: DebugEvent[] = [];
  private _seen = false;
  private _state: unknown = null;
  private _trans_state: unknown = null;
  private _hook_error = "";
  private _capture_error = "";
  private _fetch_ok: boolean | null = null;
  private _frames: number | null = null;
  private _stalled = false;

  constructor(opened_at: number, capacity: number = CAPACITY, window_s: number = WINDOW_S) {
    this.opened_at = Number(opened_at);
    this.capacity = Math.trunc(Number(capacity));
    this.window_s = Number(window_s);
  }

  // ---- feeding ----

  // Record what this read changed; returns the new events (oldest first).
  // Never raises, never waits.
  observe(snapshot: ObserveInput | null, now: number): DebugEvent[] {
    now = Number(now);
    const ok = Boolean(snapshot !== null && snapshot !== undefined && snapshot.ok);
    const fresh: DebugEvent[] = [];
    if (this._fetch_ok === null) {
      // A first-read failure must be recorded ("never managed to fetch" is a
      // state the user has to see); a first-read success only sets the
      // baseline, it is not a flip.
      if (!ok) {
        fresh.push(this._record(now, "fetch", "取数失败（尚未成功取到过数据）"));
      }
      this._fetch_ok = ok;
    } else if (ok !== this._fetch_ok) {
      fresh.push(this._record(now, "fetch", ok ? "取数恢复" : "取数失败"));
      this._fetch_ok = ok;
    }
    if (ok) {
      fresh.push(...this._observe_payload(
        (snapshot!.data && typeof snapshot!.data === "object" && !Array.isArray(snapshot!.data)
          ? snapshot!.data : {}) as Record<string, unknown>, now));
    }
    this._prune(now);
    return fresh;
  }

  private _observe_payload(data: Record<string, unknown>, now: number): DebugEvent[] {
    const stats_raw = data["stats"];
    const stats = (stats_raw !== null && typeof stats_raw === "object" && !Array.isArray(stats_raw)
      ? stats_raw : {}) as Record<string, unknown>;
    const state = data["state"];
    const trans_state = data["trans_state"];
    const hook = (data["hook_error"] ?? "") as string;
    const capture = (data["capture_error"] ?? "") as string;
    const fresh: DebugEvent[] = [];
    if (!this._seen) {
      // a first successful read sets the baseline, no event
      this._seen = true;
    } else {
      if (state !== this._state) {
        fresh.push(this._record(now, "state",
          "字幕状态 " + String(this._state) + " → " + String(state)));
      }
      if (trans_state !== this._trans_state) {
        fresh.push(this._record(now, "trans_state",
          "翻译态 " + String(this._trans_state) + " → " + String(trans_state)));
      }
      const pairs: Array<[string, string, string, string, string]> = [
        ["hook_error", hook, this._hook_error, "页面钩子未装上：%s", "页面钩子已恢复"],
        ["capture_error", capture, this._capture_error, "字幕正文抓取失败：%s", "字幕正文抓取已恢复"],
      ];
      for (const [kind, value, was, on_text, off_text] of pairs) {
        if (Boolean(value) !== Boolean(was)) {
          fresh.push(this._record(now, kind,
            value ? on_text.replace("%s", String(value)) : off_text));
        }
      }
    }
    this._state = state;
    this._trans_state = trans_state;
    this._hook_error = String(hook ?? "");
    this._capture_error = String(capture ?? "");
    const frames = stats["frames"];
    if (typeof frames === "number" && Number.isInteger(frames)) {
      if (this._frames !== null) {
        const stalled = frames === this._frames && state === "ok";
        if (stalled && !this._stalled) {
          fresh.push(this._record(now, "frames_stall",
            "帧计数停滞（停在 " + frames + " 帧）"));
        }
        this._stalled = stalled;
      }
      this._frames = frames;
    }
    return fresh;
  }

  private _record(now: number, kind: string, text: string): DebugEvent {
    const event: DebugEvent = {
      at: now,
      time: hhmmss(now),
      rel: Math.trunc(now - this.opened_at),
      kind,
      text,
    };
    this._events.push(event);
    return event;
  }

  private _prune(now: number): void {
    const cutoff = now - this.window_s;
    if (this._events.length > 0 && this._events[0]!.at < cutoff) {
      this._events = this._events.filter((e) => e.at >= cutoff);
    }
    if (this._events.length > this.capacity) {
      this._events.splice(0, this._events.length - this.capacity);
    }
  }

  // ---- reading ----

  // Newest first (the list is rendered that way).
  events(): DebugEvent[] {
    return [...this._events].reverse();
  }

  // The capability boundary, verbatim: this page was opened at HH:MM:SS and
  // saw nothing before that (spec #162, D3).
  opened_label(): string {
    return "本页打开于 " + hhmmss(this.opened_at) + "，此前事件未记录";
  }
}
