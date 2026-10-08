// 1:1 port of desktop/tests/test_protocol.py (ticket #203, map #181).
// The engine needs coerce_cue / coerce_cues / repair_cue_ends, so this file
// lands the whole pytest file's assertions now (the parse_json3 tests ride
// along on the #200 partial port). The protocol-service ticket (#198) keeps
// the WS transport surface its header reserved; every test_protocol.py
// assertion now has a TS equivalent here, so nothing is lost.
// Registered conversions (criteria #2):
//   - pytest raises-free coercion -> assert.equal(result, null).
//   - float("nan") wire value -> NaN literal (the _num default path).
import { test } from "node:test";
import assert from "node:assert/strict";
import { make_cue, parse_json3, coerce_cue, repair_cue_ends } from "../lib/protocol.ts";

test("parse_json3 manual", () => {
  const data = { events: [
    { tStartMs: 1000, dDurationMs: 2000,
      segs: [{ utf8: "hello " }, { utf8: "world" }] },
    { tStartMs: 3000, dDurationMs: 1500,
      segs: [{ utf8: "second line", tOffsetMs: 100 }] },
  ] };
  const cues = parse_json3(data);
  assert.equal(cues.length, 2);
  assert.equal(cues[0]!.text, "hello world");
  assert.equal(cues[0]!.start_ms, 1000);
  assert.equal(cues[0]!.end_ms, 3000);
  assert.equal(cues[0]!.last_off_ms, 1000);
  assert.equal(cues[1]!.last_off_ms, 3100);
});

test("parse_json3 skips junk events", () => {
  const data = { events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [] },
    { tStartMs: 500, segs: [{ utf8: "no dur" }] },
    { tStartMs: 900, dDurationMs: 0, segs: [{ utf8: "zero" }] },
  ] };
  assert.deepEqual(parse_json3(data), []);
  assert.deepEqual(parse_json3({}), []);
  assert.deepEqual(parse_json3({ events: null }), []);
});

test("parse_json3 asr last off ignores blank tail", () => {
  const data = { events: [{ tStartMs: 5000, dDurationMs: 3000, segs: [
    { utf8: "the cat ", tOffsetMs: 200 }, { utf8: "sat", tOffsetMs: 800 },
    { utf8: " ", tOffsetMs: 2900 }] }] };
  const c = parse_json3(data)[0]!;
  assert.equal(c.text, "the cat sat");
  assert.equal(c.last_off_ms, 5800);
});

test("coerce_cue rejects junk never raises", () => {
  assert.equal(coerce_cue(null), null);
  assert.equal(coerce_cue("x"), null);
  assert.equal(coerce_cue({ text: "   " }), null);
  assert.equal(coerce_cue({ text: "a", start_ms: 5, end_ms: 5 }), null);
  assert.equal(coerce_cue({ text: "a", start_ms: NaN, end_ms: 9 })!.start_ms, 0.0);
  const bad = { text: "ok", start_ms: -100, end_ms: 50, last_off_ms: -999 };
  assert.equal(coerce_cue(bad)!.last_off_ms, -100);
});

test("repair_cue_ends sorts and trims", () => {
  const cs = [make_cue(9000, 12000, "b"), make_cue(1000, 5000, "a"),
              make_cue(3000, 4000, "mid")];
  const out = repair_cue_ends(cs);
  assert.deepEqual(out.map(c => c.text), ["a", "mid", "b"]);
  assert.equal(out[0]!.end_ms, 3000);
  assert.equal(out[2]!.end_ms, 12000);
});
