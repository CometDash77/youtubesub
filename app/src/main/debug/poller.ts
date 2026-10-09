// Port of desktop/suboverlay/debug_poller.py - the single-shot, self-rearming
// status poll (spec #162 decision 6).
//
// The NEXT tick is scheduled only AFTER the previous read reported back:
// never re-entrant, never stacked; a slow network slows the polling down.
// This module touches no Electron/Qt - the timer is injected (Qt passed
// QTimer.singleShot), so the behavior is assertable without a window server
// or an event loop.
//
// Conversion notes (ticket #205): DEFERRED keeps its sentinel role (a unique
// symbol, the object() equivalent); a raised fetch reports err.name in the
// failure snapshot (type(e).__name__ convention).
import { Snapshot } from "./probe.ts";

export const INTERVALS: readonly number[] = [0.5, 1.0, 2.0];
export const DEFAULT_INTERVAL = 1.0;

// Returned by an async fetch: the read is in flight elsewhere and will arrive
// via report(). Synchronous fetchers never see it.
export const DEFERRED = Symbol("DEFERRED");
export type FetchResult = Snapshot | typeof DEFERRED;

export type ScheduleFn = (seconds: number, callback: () => void) => void;

export class StatusPoller {
  private readonly _fetch: () => FetchResult;
  private readonly _on_result: (s: Snapshot) => void;
  private readonly _schedule: ScheduleFn;
  interval: number;
  in_flight = false;
  private _running = false;
  private _again = false;

  constructor(fetch: () => FetchResult, on_result: (s: Snapshot) => void,
              schedule: ScheduleFn, interval: number = DEFAULT_INTERVAL) {
    this._fetch = fetch;
    this._on_result = on_result;
    this._schedule = schedule;
    this.interval = Number(interval);
  }

  // ---- control ----

  start(): void {
    if (this._running) return;
    this._running = true;
    this._cycle();
  }

  stop(): void {
    this._running = false;
  }

  // Applies to the next cycle (the current one is already scheduled).
  set_interval(seconds: number): void {
    this.interval = Number(seconds);
  }

  // A manual read. While one is in flight it only queues one extra cycle -
  // it never runs a second read concurrently.
  refresh_now(): void {
    if (!this._running) return;
    if (this.in_flight) {
      this._again = true;
      return;
    }
    this._cycle();
  }

  // ---- the single-shot, self-rearming cycle ----

  private _cycle(): void {
    if (!this._running || this.in_flight) return;
    this.in_flight = true;
    let snapshot: FetchResult;
    try {
      snapshot = this._fetch();
    } catch (exc) {
      // a failed read is a result
      const name = exc instanceof Error ? (exc.name || "Error") : "Error";
      snapshot = new Snapshot(false, null, name);
    }
    if (snapshot === DEFERRED) {
      return; // report() will finish it
    }
    this.report(snapshot);
  }

  // A read finished. Async fetches call this when their result lands.
  report(snapshot: Snapshot): void {
    if (!this.in_flight) {
      // duplicate / late results must not schedule another round
      return;
    }
    this.in_flight = false;
    this._on_result(snapshot);
    if (this._again) {
      // one catch-up cycle (the user pressed refresh-now)
      this._again = false;
      this._cycle();
      return;
    }
    if (this._running) {
      this._schedule(this.interval, () => this._cycle());
    }
  }
}
