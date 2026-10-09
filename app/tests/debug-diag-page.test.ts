// 1:1 port of desktop/tests/test_debug_diag_page.py (ticket #205, map #181):
// the diag page. Real-service black box where the Python one is: a real
// WSServer + injected status_provider, the page consumes only a Snapshot (it
// never fetches itself). The clock is an injectable, pushable fake pinning
// the "continuous failure beyond ~10s clears the value zones" time semantics.
// Only external observable behavior is asserted: status bar text/level, zone
// rows, copy text, event order - internals and QSS colors never.
// Every pytest test function maps to exactly one test() below.
// Registered conversions (criteria #2):
//   - queue.Queue -> EventQueue; WSServer from lib/ws-server.ts (1:1 port).
//   - QtWidgets.QApplication.clipboard -> an injectable clipboard seam; the
//     renderer performs the actual navigator.clipboard write, the page owns
//     the text.
//   - page.copy_button.text() static copy -> source scan of the renderer
//     (repo's established source-scan pattern).
//   - the QThreadPool probe task -> the async fetch + DEFERRED report path;
//     start() returns before the read finishes by construction (asserted).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer as netCreateServer } from "node:net";
import { EventQueue, WSServer } from "../lib/ws-server.ts";
import { DiagPage, type PollerLike } from "../src/main/debug/diag-page.ts";
import { Snapshot, fetch_status } from "../src/main/debug/probe.ts";

const PORT = 9877;

const PAYLOAD: Record<string, unknown> = {
  ok: true, version: 1,
  stats: { frames: 12, bad_frames: 1, error: "" },
  state: "ok", orig: "hello", trans: "你好",
  trans_state: "ready", trans_available: true,
  playing: true, rate: 1.0, title: "Demo",
  sources: 1, active_source: "src-1",
  mode: "bilingual", order: "trans_first",
  history: [["hello", "你好"]], click_through: false,
  hook_error: "", capture_error: "", video_description: "",
};

// Pushable fake clock (Python Clock class equivalent - a callable with
// set/advance, injected into the page's clock seam).
interface PushClock {
  (): number;
  t: number;
  set(t: number): void;
  advance(dt: number): void;
}
function makeClock(t = 1000.0): PushClock {
  const fn = (() => fn.t) as PushClock;
  fn.t = t;
  fn.set = (v: number) => { fn.t = v; };
  fn.advance = (dt: number) => { fn.t += dt; };
  return fn;
}

class FakePoller implements PollerLike {
  interval = 1.0;
  starts = 0;
  stops = 0;
  refreshes = 0;
  start(): void { this.starts += 1; }
  stop(): void { this.stops += 1; }
  set_interval(seconds: number): void { this.interval = seconds; }
  refresh_now(): void { this.refreshes += 1; }
}

function page(clock: PushClock | null = null, poller: PollerLike | null = null): DiagPage {
  return new DiagPage(PORT, {
    poller: poller ?? new FakePoller(),
    clock: clock ?? makeClock(),
  });
}

function rows(page_: DiagPage, zone: string): Record<string, string> {
  return Object.fromEntries(page_.zone_rows(zone));
}

// ---- 渲染：通 ----

test("success renders the four zones and the green bar", () => {
  const p = page();
  p.apply(new Snapshot(true, PAYLOAD));
  assert.equal(p.status_bar_level(), "ok");
  assert.equal(p.status_bar_text(), "已连接 127.0.0.1:9877");
  assert.equal(p.zones_stale(), false);
  const link = rows(p, "link");
  assert.equal(link["服务"], "已连接 127.0.0.1:9877");
  assert.equal(link["累计帧数"], "12");
  assert.equal(link["坏帧数"], "1");
  assert.ok(!("服务端错误" in link));
  assert.equal(link["来源数"], "1");
  assert.equal(link["活跃来源"], "src-1");
  const play = rows(p, "playback");
  assert.equal(play["字幕状态"], "ok");
  assert.equal(play["标题"], "Demo");
  assert.equal(play["在播"], "是");
  assert.equal(play["倍速"], "1");
  assert.equal(play["显示模式"], "bilingual");
  assert.equal(play["显示顺序"], "trans_first");
  assert.equal(play["原文"], "hello");
  assert.equal(play["译文"], "你好");
  assert.equal(play["点击穿透"], "否");
  assert.ok(!("页面钩子" in play) && !("字幕抓取" in play));
  const queue = rows(p, "queue");
  assert.equal(queue["可翻译"], "是");
  assert.equal(queue["翻译态"], "ready");
  assert.ok(!JSON.stringify(queue).includes("连通测试"));
  assert.deepEqual(p.zone_badge("link"), ["正常", "ok"]);
  assert.deepEqual(p.zone_badge("playback"), ["正常", "ok"]);
  assert.deepEqual(p.zone_badge("queue"), ["ready", "ok"]);
});

test("service side problems are shown and mark the bar warn", () => {
  const payload: Record<string, unknown> = { ...PAYLOAD };
  payload["stats"] = { frames: 3, bad_frames: 0, error: "startup boom" };
  payload["hook_error"] = "page hook NOT installed";
  payload["capture_error"] = "caption response was empty (status 200)";
  payload["trans_state"] = "failed:timeout";
  const p = page();
  p.apply(new Snapshot(true, payload));
  assert.equal(p.status_bar_level(), "warn");
  const link = rows(p, "link");
  assert.equal(link["服务端错误"], "startup boom");
  const play = rows(p, "playback");
  assert.equal(play["页面钩子"], "page hook NOT installed");
  assert.equal(play["字幕抓取"], "caption response was empty (status 200)");
  assert.equal(rows(p, "queue")["翻译态"], "failed:timeout");
  assert.deepEqual(p.zone_badge("link"), ["有错误", "warn"]);
  assert.deepEqual(p.zone_badge("playback"), ["注意", "warn"]);
  assert.deepEqual(p.zone_badge("queue"), ["failed:timeout", "error"]);
});

test("bad keys never show up as rows", () => {
  const payload: Record<string, unknown> = { ...PAYLOAD };
  Object.assign(payload, {
    queue_depth: 3, in_flight: 2, in_backoff: true,
    cache_hit_rate: 0.5, cache_entries: 9,
    cache_db_bytes: 1024, connections: 2,
    last_frame_age_ms: 12,
  });
  const p = page();
  p.apply(new Snapshot(true, payload));
  const all = p.zone_rows("link").concat(p.zone_rows("playback"), p.zone_rows("queue"))
    .map(([l, v]) => l + "=" + v).join(" ");
  const known = new Set(["ok", "version", "stats", "state", "orig", "trans",
    "trans_state", "trans_available", "playing", "rate", "title",
    "sources", "active_source", "mode", "order", "click_through",
    "hook_error", "capture_error", "history", "video_description"]);
  for (const token of Object.keys(payload)) {
    if (known.has(token)) continue;
    assert.ok(!all.includes(token), token);
  }
  for (const label of ["排队", "在途", "退避", "缓存", "连接数", "收帧龄", "按来源"]) {
    assert.ok(!all.includes(label), label);
  }
});

// ---- 呈现：不通 ----

test("failure reports the port the age and greys the old values", () => {
  const clock = makeClock(1000.0);
  const p = page(clock);
  p.apply(new Snapshot(true, PAYLOAD, null, 999.0));
  clock.set(1030.0);
  p.apply(new Snapshot(false, null, "ConnectionRefusedError", 1030.0));
  assert.equal(p.status_bar_level(), "error");
  const text = p.status_bar_text();
  assert.ok(text.includes("连不上"));
  assert.ok(text.includes("9877"));
  assert.ok(text.includes("上次成功"));
  assert.ok(text.includes("30 秒前"));
  assert.equal(p.zones_stale(), true);
  assert.equal(rows(p, "playback")["字幕状态"], "ok", "灰化期间仍摆上次成功的值");
  assert.deepEqual(p.zone_badge("playback"), ["不通", "error"]);
});

test("failures past ten seconds clear the value zones", () => {
  const clock = makeClock(1000.0);
  const p = page(clock);
  p.apply(new Snapshot(true, PAYLOAD, null, 1000.0));
  clock.set(1012.0);
  p.apply(new Snapshot(false, null, "timeout", 1012.0));
  assert.equal(p.status_bar_level(), "error");
  assert.equal(p.zones_stale(), true, "第一拍失败：灰化上一拍的值");
  assert.equal(rows(p, "playback")["译文"], "你好");
  clock.set(1025.0);
  p.apply(new Snapshot(false, null, "timeout", 1025.0));
  assert.deepEqual(p.zone_rows("link"), []);
  assert.deepEqual(p.zone_rows("playback"), []);
  assert.deepEqual(p.zone_rows("queue"), []);
  assert.equal(p.zones_stale(), false);
  assert.notEqual(p.zone_rows("events").length, 0, "事件列表不是数值区，不清空");
  assert.ok(p.status_bar_text().includes("上次成功"));
});

test("a never successful page shows the same failure presentation", () => {
  const clock = makeClock(1000.0);
  const p = page(clock);
  p.apply(new Snapshot(false, null, "ConnectionRefusedError", 1000.0));
  assert.equal(p.status_bar_level(), "error");
  assert.ok(p.status_bar_text().includes("连不上"));
  assert.deepEqual(p.zone_rows("playback"), []);
  const copy = p.copy_all_text();
  assert.ok(copy.includes("连不上") && copy.includes("9877"));
});

test("recovery returns to ok and drops the stale flag", () => {
  const clock = makeClock(1000.0);
  const p = page(clock);
  p.apply(new Snapshot(true, PAYLOAD, null, 1000.0));
  clock.set(1020.0);
  p.apply(new Snapshot(false, null, "timeout", 1020.0));
  clock.set(1021.0);
  p.apply(new Snapshot(true, PAYLOAD, null, 1021.0));
  assert.equal(p.status_bar_level(), "ok");
  assert.equal(p.status_bar_text(), "已连接 127.0.0.1:9877");
  assert.equal(p.zones_stale(), false);
  assert.equal(rows(p, "playback")["译文"], "你好");
});

// ---- 事件列表 ----

test("events are newest first under the capability banner", () => {
  const clock = makeClock(1000.0);
  const p = page(clock);
  p.apply(new Snapshot(true, PAYLOAD, null, 1000.0));
  clock.set(1005.0);
  p.apply(new Snapshot(false, null, "timeout", 1005.0));
  clock.set(1009.0);
  const grown = { ...PAYLOAD, stats: { ...(PAYLOAD.stats as Record<string, unknown>), frames: 13 } };
  p.apply(new Snapshot(true, grown, null, 1009.0));
  const events = p.zone_rows("events");
  assert.ok(events[0]![1].includes("此前事件未记录"));
  assert.ok(events[1]![1].includes("取数恢复") && events[1]![0].includes("(+9s)"));
  assert.ok(events[2]![1].includes("取数失败") && events[2]![0].includes("(+5s)"));
});

// ---- 复制 ----

test("copy all is plain text one row per line", () => {
  const p = page();
  p.apply(new Snapshot(true, PAYLOAD));
  const text = p.copy_all_text();
  const lines = text.split("\n");
  assert.ok(lines[0]!.startsWith("调试页"));
  assert.ok(lines[0]!.includes("复制于"));
  for (const line of lines) assert.ok(line.trim().length > 0);
  assert.ok(lines.includes("累计帧数: 12"));
  assert.ok(text.includes("译文: 你好"));
  assert.ok(!text.includes("连通测试"), "折叠时不该出现在复制文本里");
});

test("connection test is collapsed until asked for", () => {
  const payload: Record<string, unknown> = { ...PAYLOAD };
  payload["connection_test"] = {
    verdict: "pass", layers: [
      { id: "L1", title: "配置", passed: true, code: "", message: "ok", elapsed_ms: 1 },
      { id: "L4", title: "模型", passed: false, code: "HTTP_401",
        message: "unauthorized", elapsed_ms: 12 }],
    attempts: 2, warnings: ["MOCK_MASKS_REAL_CONFIG"],
    warning_messages: { MOCK_MASKS_REAL_CONFIG: "Mock 掩盖了真实配置" },
    skipped: ["L3"], duration_ms: 30,
  };
  const p = page();
  p.apply(new Snapshot(true, payload));
  assert.equal(p.connection_test_expanded(), false);
  assert.ok(!JSON.stringify(rows(p, "queue")).includes("连通测试"));
  p.set_connection_test_expanded(true);
  const queue = rows(p, "queue");
  assert.equal(queue["连通测试结论"], "PASS");
  assert.equal(queue["层 L4"], "FAIL [HTTP_401] unauthorized (12 毫秒)");
  assert.equal(queue["跳过"], "L3");
  assert.equal(queue["警告"], "Mock 掩盖了真实配置");
  assert.ok(p.copy_all_text().includes("连通测试"));
  p.set_connection_test_expanded(false);
  assert.ok(!p.copy_all_text().includes("连通测试"));
});

test("copy carries the events and the failure age", () => {
  const clock = makeClock(1000.0);
  const p = page(clock);
  p.apply(new Snapshot(true, PAYLOAD, null, 1000.0));
  clock.set(1011.0);
  p.apply(new Snapshot(false, null, "timeout", 1011.0));
  const text = p.copy_all_text();
  assert.ok(text.includes("连不上"));
  assert.ok(text.includes("上次成功") && text.includes("11 秒前"));
  assert.ok(text.includes("取数失败"));
});

// ---- 按钮与频率 ----

test("frequency gears and manual refresh go through the poller", () => {
  const poller = new FakePoller();
  const p = page(null, poller);
  p.set_frequency(0.5);
  assert.equal(poller.interval, 0.5);
  p.set_frequency(6);
  assert.equal(poller.interval, 2.0);
  p.set_frequency(0.7);
  assert.equal(poller.interval, 0.5);
  assert.equal(p.frequency(), 0.5);
  p.refresh_now();
  assert.equal(poller.refreshes, 1);
  // copy button static copy lives in the renderer (source scan)
  const src = fs.readFileSync(
    new URL("../src/renderer/debug-renderer.ts", import.meta.url), "utf8");
  assert.ok(src.includes("复制全部内容"));
});

test("copy button puts the text on the clipboard", () => {
  const seen: string[] = [];
  const p = new DiagPage(PORT, {
    poller: new FakePoller(),
    clock: makeClock(),
    clipboard: { setText: (t: string) => seen.push(t) },
  });
  p.apply(new Snapshot(true, PAYLOAD));
  p.copy_to_clipboard();
  assert.ok(seen[0]!.includes("译文: 你好"));
});

// ---- 真服务黑盒 ----

test("against a real server and its shutdown", async () => {
  const provider = { state: "ok", orig: "hi", trans: "你好", trans_state: "ready",
    trans_available: true, playing: true, rate: 1.0, title: "Demo",
    sources: 1, active_source: "s1", mode: "trans", order: "orig_first",
    click_through: false };
  const server = new WSServer(0, new EventQueue(),
    { status_provider: () => ({ ...provider }) });
  const port = await server.start();
  const clock = makeClock(1000.0);
  const p = new DiagPage(port, { poller: new FakePoller(), clock });
  try {
    const snapshot = await fetch_status(port);
    assert.ok(snapshot.ok, snapshot.error);
    p.apply(snapshot);
    assert.equal(p.status_bar_level(), "ok");
    assert.equal(p.status_bar_text(), "已连接 127.0.0.1:" + port);
    const link = rows(p, "link");
    assert.equal(link["累计帧数"], "0");
    assert.equal(link["坏帧数"], "0");
    assert.equal(rows(p, "playback")["显示模式"], "trans");
  } finally {
    await server.stop();
  }
  p.apply(await fetch_status(port, "127.0.0.1", 1.0));
  assert.equal(p.status_bar_level(), "error");
  assert.equal(rows(p, "playback")["译文"], "你好", "第一拍失败仍摆上一拍的值");
  clock.advance(20.0);
  p.apply(await fetch_status(port, "127.0.0.1", 1.0));
  assert.equal(p.status_bar_level(), "error");
  assert.deepEqual(p.zone_rows("playback"), []);
  const server2 = new WSServer(port, new EventQueue(),
    { status_provider: () => ({ ...provider }) });
  await server2.start();
  try {
    p.apply(await fetch_status(port, "127.0.0.1", 1.0));
    assert.equal(p.status_bar_level(), "ok");
    assert.equal(rows(p, "playback")["译文"], "你好");
  } finally {
    await server2.stop();
  }
});

test("the default page does not block on a stalling read", async () => {
  // 取数离开 GUI 线程（异步探针）：对端挂起时要等满 2 秒超时，这 2 秒绝不许
  // 压在调用线程上（真机关掉服务后每拍都会冻 GUI）。
  const server = netCreateServer();
  server.listen(0, "127.0.0.1"); // 握手能成，但永不回话
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const p = new DiagPage(port);
  try {
    const started = performance.now();
    p.start();
    const elapsed = (performance.now() - started) / 1000;
    assert.ok(elapsed < 0.5, "start() 不该等满取数超时, got " + elapsed);

    const deadline = started + 4000;
    while (performance.now() < deadline && p.status_bar_level() !== "error") {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(p.status_bar_level(), "error", "超时结果必须照样回到页面");
  } finally {
    p.stop();
    server.close();
  }
});
