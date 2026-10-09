// 1:1 port of desktop/tests/test_debug_events.py (ticket #205, map #181):
// the event recorder - flips only, 200 events or 30 minutes, in-memory ring.
// All tests are driven by explicit timestamps; the real clock is never
// touched. Every pytest test function maps to exactly one test() below.
// Registered conversions (criteria #2):
//   - PR.Snapshot -> Snapshot from src/main/debug/probe.ts (same shape).
//   - time.strftime("%H:%M:%S", localtime) -> the same local-time formatter
//     in events.ts; assertions stay format-shaped (regex), not value-shaped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventRecorder, type DebugEvent } from "../src/main/debug/events.ts";
import { Snapshot } from "../src/main/debug/probe.ts";

const T0 = 1_700_000_000.0;

let frames = 0;

function snap(over: Record<string, unknown> = {}): Snapshot {
  // A healthy read. frames grows on every call unless a test pins it, so
  // only the tests that care about stalling ever see a stall.
  frames += 1;
  const data: Record<string, unknown> = {
    state: "ok", trans_state: "idle", hook_error: "", capture_error: "",
    stats: { frames, bad_frames: 0, error: null },
  };
  Object.assign(data, over);
  return new Snapshot(true, data);
}

function failure(): Snapshot {
  return new Snapshot(false, null, "ConnectionRefusedError");
}

function kinds(events: DebugEvent[]): string[] {
  return events.map((e) => e.kind);
}

test("first successful read records nothing", () => {
  const rec = new EventRecorder(T0);
  assert.deepEqual(rec.observe(snap(), T0), []);
  assert.deepEqual(rec.events(), []);
});

test("records state and trans_state flips without repeats", () => {
  const rec = new EventRecorder(T0);
  rec.observe(snap(), T0);
  assert.deepEqual(kinds(rec.observe(snap({ state: "no_cues" }), T0 + 1)), ["state"]);
  assert.deepEqual(rec.observe(snap({ state: "no_cues" }), T0 + 2), []);
  assert.deepEqual(
    kinds(rec.observe(snap({ state: "no_cues", trans_state: "translating" }), T0 + 3)),
    ["trans_state"]);
});

test("records error appearance and recovery", () => {
  const rec = new EventRecorder(T0);
  rec.observe(snap(), T0);
  assert.deepEqual(kinds(rec.observe(snap({ hook_error: "boom" }), T0 + 1)), ["hook_error"]);
  assert.deepEqual(rec.observe(snap({ hook_error: "boom" }), T0 + 2), []);
  assert.deepEqual(kinds(rec.observe(snap({ hook_error: "" }), T0 + 3)), ["hook_error"]);
  assert.deepEqual(kinds(rec.observe(snap({ capture_error: "caption empty" }), T0 + 4)),
    ["capture_error"]);
  assert.deepEqual(kinds(rec.observe(snap({ capture_error: "" }), T0 + 5)),
    ["capture_error"]);
});

test("records fetch failure and recovery", () => {
  const rec = new EventRecorder(T0);
  assert.deepEqual(kinds(rec.observe(failure(), T0)), ["fetch"]);
  assert.deepEqual(rec.observe(failure(), T0 + 1), []);
  assert.deepEqual(kinds(rec.observe(snap(), T0 + 2)), ["fetch"]);
  assert.deepEqual(rec.observe(snap(), T0 + 3), []);
});

test("frames stall needs no growth and ok state", () => {
  const rec = new EventRecorder(T0);
  const pinned = { stats: { frames: 10, bad_frames: 0, error: null } };
  rec.observe(snap(pinned), T0);
  assert.deepEqual(kinds(rec.observe(snap(pinned), T0 + 1)), ["frames_stall"]);
  assert.deepEqual(rec.observe(snap(pinned), T0 + 2), []);
  const grown = { stats: { frames: 12, bad_frames: 0, error: null } };
  assert.deepEqual(rec.observe(snap(grown), T0 + 3), []);
  assert.deepEqual(kinds(rec.observe(snap(grown), T0 + 4)), ["frames_stall"]);
  assert.deepEqual(kinds(rec.observe(snap({ state: "no_cues", ...grown }), T0 + 5)),
    ["state"]);
});

test("events are newest first with wall clock and relative seconds", () => {
  const rec = new EventRecorder(T0);
  rec.observe(snap(), T0);
  rec.observe(snap({ state: "no_cues" }), T0 + 5);
  rec.observe(snap({ state: "ok" }), T0 + 42);
  const events = rec.events();
  assert.deepEqual(kinds(events), ["state", "state"]);
  assert.equal(events[0]!.rel, 42);
  assert.equal(events[1]!.rel, 5);
  assert.match(events[0]!.time, /^\d{2}:\d{2}:\d{2}$/, events[0]!.time);
  assert.ok(events[0]!.text && events[1]!.text);
  assert.ok(events[0]!.text.includes("no_cues") && events[0]!.text.includes("ok"));
});

test("capacity keeps the newest 200", () => {
  const rec = new EventRecorder(T0, 3);
  rec.observe(snap(), T0);
  for (let i = 0; i < 5; i++) {
    rec.observe(snap({ state: "s" + i }), T0 + 1 + i);
  }
  const events = rec.events();
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.rel), [5, 4, 3]);
});

test("thirty minute window drops older events", () => {
  const rec = new EventRecorder(T0);
  rec.observe(snap(), T0);
  rec.observe(snap({ state: "no_cues" }), T0 + 1);
  assert.deepEqual(kinds(rec.events()), ["state"]);
  assert.deepEqual(kinds(rec.observe(snap({ state: "ok" }), T0 + 2000)), ["state"]);
  assert.deepEqual(rec.events().map((e) => e.rel), [2000]);
});

test("opened label is the documented wording", () => {
  const rec = new EventRecorder(T0);
  const label = rec.opened_label();
  assert.ok(label.startsWith("本页打开于 ") && label.endsWith("，此前事件未记录"));
  assert.match(label, /\d{2}:\d{2}:\d{2}/);
});

test("every event carries kind time rel text", () => {
  const rec = new EventRecorder(T0);
  rec.observe(snap(), T0);
  rec.observe(snap({ hook_error: "boom" }), T0 + 7);
  const event = rec.events()[0]!;
  assert.deepEqual(Object.keys(event).sort(), ["at", "kind", "rel", "text", "time"]);
  assert.equal(event.kind, "hook_error");
  assert.equal(event.at, T0 + 7);
  assert.equal(event.rel, 7);
});
