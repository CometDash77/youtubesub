// Port of desktop/suboverlay/clock.py - desktop playback clock: interpolate
// video time between browser syncs. Design from dkitle ui.rs
// estimated_time_ms + transit-delay compensation (design only, reimplemented;
// dkitle defects fixed: gap-hold has a TTL, replayed syncs keep their
// original sender timestamp, overlap lookup walks back like yt-dual-subs
// activeCueIdxAt). Keeps the same public names as the Python module so the
// remaining Phase 1 tickets map one-to-one onto it.
//
// Semantic fidelity notes (registered in ticket #200):
// - time.monotonic() (seconds) -> monotonic() = performance.now()/1000; every
//   test passes explicit anchor/now values, so the seconds convention is what
//   both sides share.
// - isinstance(playback_rate, (int, float)) -> typeof "number" (JS has one
//   numeric type); NaN > 0 is false on both sides, so non-positive or NaN
//   rates fall back to 1.0 identically.
import type { Cue } from "./protocol.ts";

export const GAP_HOLD_MS = 3500.0;
export const MAX_TRANSIT_MS = 2000.0;
export const OVERLAP_WALKBACK = 8;

export interface SyncState {
  video_time_ms: number;
  playing: boolean;
  playback_rate: number;
  anchor_mono: number;
}

export function monotonic(): number {
  return performance.now() / 1000;
}

// Dataclass equivalent: defaults video_time_ms=0.0, playing=false,
// playback_rate=1.0, anchor_mono=now.
export function make_sync_state(init: Partial<SyncState> = {}): SyncState {
  return {
    video_time_ms: init.video_time_ms ?? 0.0,
    playing: init.playing ?? false,
    playback_rate: init.playback_rate ?? 1.0,
    anchor_mono: init.anchor_mono ?? monotonic(),
  };
}

// Fold one browser sync into the clock. Transit compensation only while
// playing. sender_ts_ms MUST be the original send time (never refresh on
// replay).
export function apply_sync(state: SyncState, video_time_ms: number,
                           playing: boolean, playback_rate: number,
                           sender_ts_ms: number, now_epoch_ms: number): SyncState {
  const rate = typeof playback_rate === "number" && playback_rate > 0
    ? playback_rate : 1.0;
  let transit = 0.0;
  if (playing) {
    transit = now_epoch_ms - sender_ts_ms;
    transit = Math.max(0.0, Math.min(transit, MAX_TRANSIT_MS));
  }
  state.video_time_ms = Number(video_time_ms) + transit;
  state.playing = Boolean(playing);
  state.playback_rate = Number(rate);
  state.anchor_mono = monotonic();
  return state;
}

// Current video time: frozen while paused, else base + elapsed*rate.
export function estimate_ms(state: SyncState, now_mono?: number): number {
  if (!state.playing) return state.video_time_ms;
  const now = now_mono === undefined || now_mono === null ? monotonic() : now_mono;
  return state.video_time_ms
    + Math.max(0.0, now - state.anchor_mono) * 1000.0 * state.playback_rate;
}

// Cue visible at t_ms. Binary search greatest start <= t, walk back <=8 for
// overlap coverage; hold previous cue in gaps for at most gap_hold_ms.
export function find_cue_at(cues_sorted: readonly Cue[], t_ms: number,
                            gap_hold_ms: number = GAP_HOLD_MS): Cue | null {
  if (cues_sorted.length === 0) return null;
  const starts = cues_sorted.map((c) => c.start_ms);
  // bisect_right(starts, t_ms) - 1: first index with start > t, minus one.
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= t_ms) lo = mid + 1;
    else hi = mid;
  }
  const idx = lo - 1;
  if (idx < 0) return null;
  const walk_to = Math.max(0, idx - OVERLAP_WALKBACK);
  for (let j = idx; j >= walk_to; j--) {
    const c = cues_sorted[j]!;
    if (c.start_ms <= t_ms && t_ms < c.end_ms) return c;
  }
  if (idx + 1 >= cues_sorted.length) return null; // after the last cue: never hold (dkitle gap-hold-forever fix)
  const prev = cues_sorted[idx]!;
  if (t_ms - prev.end_ms <= gap_hold_ms) return prev;
  return null;
}
