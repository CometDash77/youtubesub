// 1:1 port of desktop/tests/test_debug_poller.py (ticket #205, map #181):
// the single-shot self-rearming status poll. No real server, no event loop -
// the schedule function is injected and the tests pull the triggers by hand.
// Every pytest test function maps to exactly one test() below.
// Registered conversions (criteria #2):
//   - raise ConnectionRefusedError() -> a named Error (type(e).__name__ ->
//     err.name convention).
//   - Python list states -> TS arrays; Snapshot attribute access unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Snapshot } from "../src/main/debug/probe.ts";
import { StatusPoller, DEFERRED, type ScheduleFn } from "../src/main/debug/poller.ts";

interface State {
  timers: Array<() => void>;
  delays: number[];
  results: Snapshot[];
  calls: number[];
}

function harness(fetch?: () => Snapshot | typeof DEFERRED): [StatusPoller, State] {
  const state: State = { timers: [], delays: [], results: [], calls: [] };
  const schedule: ScheduleFn = (_delay, callback) => {
    state.delays.push(_delay);
    state.timers.push(callback);
  };
  function defaultFetch(): Snapshot {
    state.calls.push(1);
    return new Snapshot(true, { state: "ok" });
  }
  const poller = new StatusPoller(fetch ?? defaultFetch,
    (s) => state.results.push(s), schedule);
  return [poller, state];
}

test("start fetches immediately then rearms once per cycle", () => {
  const [poller, state] = harness();
  poller.start();
  assert.equal(state.calls.length, 1);
  assert.equal(state.results.length, 1);
  assert.equal(state.results[0]!.ok, true);
  assert.equal(state.timers.length, 1);
  assert.deepEqual(state.delays, [1.0]);

  state.timers[0]!();
  assert.equal(state.calls.length, 2);
  assert.equal(state.timers.length, 2, "每一拍结束才排下一拍，不许叠加");
});

test("stop keeps a leftover timer from fetching again", () => {
  const [poller, state] = harness();
  poller.start();
  poller.stop();
  state.timers[0]!();
  assert.equal(state.calls.length, 1);
  assert.equal(state.timers.length, 1);
});

test("set_interval applies to the next cycle", () => {
  const [poller, state] = harness();
  poller.start();
  poller.set_interval(2.0);
  state.timers[0]!();
  assert.deepEqual(state.delays, [1.0, 2.0]);
  poller.set_interval(0.5);
  state.timers[1]!();
  assert.deepEqual(state.delays, [1.0, 2.0, 0.5]);
});

test("refresh_now during a flight queues one more cycle without stacking", () => {
  const calls: number[] = [];
  let active = 0;
  let peak = 0;
  const holder: { poller?: StatusPoller } = {};

  function fetch(): Snapshot {
    active += 1;
    peak = Math.max(peak, active);
    try {
      calls.push(1);
      if (calls.length === 1) {
        holder.poller!.refresh_now();     // 飞行中又点了「立即刷新」
      }
      return new Snapshot(true, {});
    } finally {
      active -= 1;
    }
  }

  const [poller, state] = harness(fetch);
  holder.poller = poller;
  poller.start();
  assert.equal(peak, 1, "并发度必须恒为 1");
  assert.equal(calls.length, 2, "补一拍，但不叠加");
  assert.equal(state.timers.length, 1);
});

test("a failing fetch becomes a failure result and the cycle continues", () => {
  function boom(): never {
    throw Object.assign(new Error("refused"), { name: "ConnectionRefusedError" });
  }
  const [poller, state] = harness(boom);
  poller.start();
  const result = state.results[0]!;
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.ok(result.error.includes("ConnectionRefused"), result.error);
  assert.equal(state.timers.length, 1, "失败也要继续自续");
  state.timers[0]!();
  assert.equal(state.results.length, 2);
});

test("refresh_now before start does nothing", () => {
  const [poller, state] = harness();
  poller.refresh_now();
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.timers, []);
});

test("start is idempotent", () => {
  const [poller, state] = harness();
  poller.start();
  poller.start();
  assert.equal(state.calls.length, 1);
  assert.equal(state.timers.length, 1);
});

test("in_flight is false between cycles", () => {
  const [poller] = harness();
  poller.start();
  assert.equal(poller.in_flight, false);
});

test("a deferred fetch waits for report instead of faking a result", () => {
  const [poller, state] = harness(() => DEFERRED);
  poller.start();
  assert.deepEqual(state.results, []);
  assert.deepEqual(state.timers, []);
  assert.equal(poller.in_flight, true, "在途标记必须留到 report 才落");

  poller.report(new Snapshot(true, { state: "ok" }));
  assert.equal(state.results.length, 1);
  assert.equal(state.timers.length, 1);
  assert.equal(poller.in_flight, false);
});

test("refresh_now while deferred queues exactly one extra cycle", () => {
  const kicks: number[] = [];
  function fetch(): typeof DEFERRED {
    kicks.push(1);
    return DEFERRED;
  }
  const [poller, state] = harness(fetch);
  poller.start();
  poller.refresh_now();
  poller.refresh_now();
  assert.deepEqual(kicks, [1], "在途时不许再起一拍（两次刷新只记一次账）");

  poller.report(new Snapshot(false, null, "TimeoutError"));
  assert.equal(state.results.length, 1, "report 先按结果渲染");
  assert.deepEqual(kicks, [1, 1], "补的那一拍立刻起读");
  assert.deepEqual(state.timers, [], "补拍还在途，先不排定时器");
});

test("a deferred fetch after stop does not rearm", () => {
  const [poller, state] = harness(() => DEFERRED);
  poller.start();
  poller.stop();
  poller.report(new Snapshot(true, {}));
  assert.deepEqual(state.timers, [], "关窗后到的结果不许再排下一拍");
});

test("a second report for the same cycle is ignored", () => {
  const [poller, state] = harness(() => DEFERRED);
  poller.start();
  poller.report(new Snapshot(true, {}));
  assert.equal(state.results.length, 1);
  assert.equal(state.timers.length, 1);

  poller.report(new Snapshot(true, {}));
  assert.equal(state.results.length, 1, "同一拍只渲染一次");
  assert.equal(state.timers.length, 1, "也不许多排一拍");
});
