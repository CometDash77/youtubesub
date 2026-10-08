// 1:1 port of desktop/tests/test_clock.py (ticket #200, map #181).
// Every pytest test function maps to exactly one test() below; assertions
// are converted assertion-for-assertion (equivalence criteria #1, #191).
// Registered behavior conversions (criteria #2):
//   - dataclass SyncState(...) keyword defaults -> make_sync_state({...})
//   - find_cue_at(...).text == "x"              -> ?.text (null stays null)
import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../lib/clock.ts";
import { make_cue } from "../lib/protocol.ts";

test("paused clock is frozen", () => {
  const s = C.make_sync_state({ video_time_ms: 10000.0, playing: false, anchor_mono: 100.0 });
  assert.equal(C.estimate_ms(s, 150.0), 10000.0);
});

test("playing clock interpolates with rate", () => {
  const cases: Array<[number, number, number]> =
    [[1.0, 1.0, 11000.0], [2.0, 1.0, 12000.0], [0.5, 2.0, 11000.0], [1.5, 4.0, 16000.0]];
  for (const [rate, dt, want] of cases) {
    const s = C.make_sync_state({
      video_time_ms: 10000.0, playing: true, playback_rate: rate, anchor_mono: 100.0,
    });
    assert.equal(C.estimate_ms(s, 100.0 + dt), want);
  }
});

test("apply sync compensates transit only while playing", () => {
  const s = C.make_sync_state();
  C.apply_sync(s, 5000.0, true, 1.0, 900.0, 1000.0);
  assert.equal(s.video_time_ms, 5100.0);
  C.apply_sync(s, 5000.0, false, 1.0, 900.0, 1000.0);
  assert.equal(s.video_time_ms, 5000.0);
  C.apply_sync(s, 5000.0, true, 1.0, -1000000000.0, 1000.0);
  assert.equal(s.video_time_ms, 7000.0);
  C.apply_sync(s, 5000.0, true, 0.0, 1000.0, 1000.0);
  assert.equal(s.playback_rate, 1.0);
});

test("find cue inside and before first", () => {
  const cs = [make_cue(1000, 3000, "a"), make_cue(4000, 6000, "b")];
  assert.equal(C.find_cue_at(cs, 1500)?.text, "a");
  assert.equal(C.find_cue_at(cs, 500), null);
});

test("find cue gap hold bounded by ttl", () => {
  const cs = [make_cue(1000, 2000, "a"), make_cue(9000, 10000, "b")];
  assert.equal(C.find_cue_at(cs, 3000)?.text, "a");
  assert.equal(C.find_cue_at(cs, 3000, 500), null);
  assert.equal(C.find_cue_at(cs, 11000, 1000000000.0), null);
});

test("find cue overlap walks back", () => {
  const cs = [make_cue(1000, 5000, "wide"), make_cue(2000, 2500, "narrow")];
  assert.equal(C.find_cue_at(cs, 2200)?.text, "narrow");
  assert.equal(C.find_cue_at(cs, 3000)?.text, "wide");
});

test("rate change resyncs without jump", () => {
  const s = C.make_sync_state();
  C.apply_sync(s, 20000.0, true, 1.0, 1000.0, 1100.0);
  const t0 = C.estimate_ms(s, s.anchor_mono + 1.0);
  C.apply_sync(s, t0, true, 2.0, 1100.0, 1100.0);
  assert.ok(Math.abs(C.estimate_ms(s, s.anchor_mono) - t0) < 1e-6);
});
