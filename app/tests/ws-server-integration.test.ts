// 1:1 port of desktop/tests/test_server_integration.py (ticket #198,
// map #181): real WS client <-> real WSServer on loopback. Every pytest
// test function maps to exactly one test() below; assertions are converted
// assertion-for-assertion (equivalence criteria #1, #191).
// Registered conversions (criteria #2):
//   - WSServer / sanitize_event / origin_allowed come from lib/ws-server.ts
//     (the 1:1 server.py port); queue.Queue -> EventQueue.
//   - Fixed PORT base 19877 -> port 0 (OS-assigned) so CI cannot collide;
//     assertions unchanged. srv.start() resolves the bound port.
//   - time.sleep(0.4) boot waits -> await srv.start() (ready promise).
//   - pytest.raises(OSError) on port conflict -> assert.rejects (Node
//     surfaces EADDRINUSE from the same failed listen).
//   - websockets.connect(origin=...) -> ws WebSocket with an Origin header;
//     the rejected handshake surfaces via "unexpected-response" (403).
//   - asyncio.new_event_loop().run_until_complete(client_flow()) ->
//     await client_flow() (same single-threaded orchestration).
//   - App.__new__(App) half-built shell + SimpleNamespace stubs (the status
//     projection / chinese-idle / register-metadata tests) -> the
//     project_status() helper below replaying desktop/app.py App._status's
//     pure projection over the same stubs; the TS App shell itself lands
//     with the full-stack integration ticket (#206). status_provider is
//     wired to that helper exactly like Python wires app._status.
//   - RuntimeError("provider exploded") -> a local Error subclass carrying
//     name "RuntimeError" (status_error keeps type(e).__name__ = err.name).
//   - tmp_path fixture -> mkdtempSync + rmSync(maxRetries) per #201 /
//     b468aa7 (Windows EBUSY; cleanup never masks the body's failure).
//   - http.client.HTTPConnection (proxy-ignoring) -> fetch: loopback URLs
//     bypass proxy env the same way (A5 assertions already ride fetch).
//   - engine internals assertions (engine.sources["s1"].meta) -> the same
//     public field on the TS Engine (#203 port).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { WebSocket as WsSocket } from "ws";
import { Engine } from "../lib/engine.ts";
import * as Q from "../lib/queue-cache.ts";
import * as S from "../lib/settings.ts";
import { WSServer, EventQueue, sanitize_event, origin_allowed } from "../lib/ws-server.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function http_get(port: number, p: string): Promise<{ status: number; body: string }> {
  const res = await fetch("http://127.0.0.1:" + port + p);
  return { status: res.status, body: await res.text() };
}

function ws_open(port: number, origin: string | null): Promise<WsSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + port + "/ws",
      origin ? { headers: { Origin: origin } } : {});
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req: unknown, res: { statusCode: number }) =>
      reject(Object.assign(new Error("rejected"), { statusCode: res.statusCode })));
  });
}

function ws_send(ws: WsSocket, frame: unknown): Promise<void> {
  return new Promise((resolve) =>
    ws.send(typeof frame === "string" ? frame : JSON.stringify(frame), () => resolve()));
}

function withTmp(name: string, fn: (dir: string) => Promise<void>): void {
  test(name, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ws-int-test-"));
    // Cleanup must never mask the body's real failure (b468aa7 contract).
    let failure: unknown;
    try {
      await fn(dir);
    } catch (e) {
      failure = e;
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      } catch {
        // Per-test throwaway dir; a stubborn Windows lock is not a verdict.
      }
    }
    if (failure !== undefined) throw failure;
  });
}

interface OverlayStub { mode: string; order: string; history: string[]; _click_through: boolean; }

// desktop/app.py App._status's pure projection (the TS App shell lands with
// #206): engine.status() display flattened to the top level, overlay and
// tester fields merged, connection-test report riding as optional keys.
function project_status(engine: { status(): Record<string, unknown> },
                        overlay: OverlayStub,
                        tester: { status_payload(): Record<string, unknown> }): Record<string, unknown> {
  const s = engine.status();
  const d = (s["display"] ?? {}) as Record<string, unknown>;
  const payload: Record<string, unknown> = {
    "state": d["state"] ?? "", "orig": d["orig"] ?? "",
    "trans": d["trans"] ?? "",
    "trans_state": d["trans_state"] || "idle",
    "trans_available": Boolean(d["trans_available"] ?? false),
    "playing": d["playing"],
    "rate": d["rate"], "title": d["title"] ?? "",
    "video_description": d["video_description"] ?? "",
    "hook_error": d["hook_error"] ?? "",
    "capture_error": d["capture_error"] ?? "",
    "sources": s["sources"] ?? 0,
    "active_source": s["active_source"],
    "mode": overlay.mode, "order": overlay.order,
    "history": [...overlay.history],
    "click_through": Boolean(overlay._click_through),
  };
  Object.assign(payload, tester.status_payload());
  return payload;
}

const NO_OVERLAY: OverlayStub = { mode: "bilingual", order: "trans_first", history: [], _click_through: false };
const NO_TESTER = { status_payload: () => ({}) as Record<string, unknown> };

test("start reports port conflict to caller", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", () => resolve()));
  const port = (occupied.address() as AddressInfo).port;
  try {
    const srv = new WSServer(port, new EventQueue());
    await assert.rejects(srv.start());
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

test("sanitize and origin unit", () => {
  assert.notEqual(sanitize_event({ type: "cues", source_id: "s", cues: [] }), null);
  const enriched = { type: "register", source_id: "s", tab_title: "Video",
                     video_description: "Description" };
  assert.deepEqual(sanitize_event(enriched), enriched);
  assert.notEqual(sanitize_event({ type: "register", source_id: "old-client" }), null);
  assert.notEqual(sanitize_event({ type: "sync", source_id: "s" }), null);
  assert.equal(sanitize_event({ type: "sync" }), null);
  assert.equal(sanitize_event({ type: "play_pause", source_id: "s" }), null);
  assert.equal(sanitize_event({ type: "mystery", source_id: "s" }), null);
  assert.equal(sanitize_event([1, 2]), null);
  assert.equal(origin_allowed("https://www.youtube.com"), true);
  assert.equal(origin_allowed("https://evil.example.com"), false);
  assert.equal(origin_allowed(""), true);
});

async function client_flow(port: number): Promise<string> {
  const frames: (string | Record<string, unknown>)[] = [
    { type: "register", provider: "youtube", source_id: "s1", tab_title: "t",
      video_id: "v1", track_kind: "asr", track_lang: "en" },
    { type: "cues", provider: "youtube", source_id: "s1", video_id: "v1",
      track_kind: "asr", track_lang: "en",
      cues: [{ start_ms: 1000, end_ms: 2000, text: "hello", last_off_ms: 1500 }] },
    { type: "sync", source_id: "s1", video_time_ms: 1200.0, playing: true,
      playback_rate: 1.5, timestamp: Date.now() },
    { type: "deactivate", source_id: "s1" },
    "{not json",
    { type: "unknown" },
  ];
  const ws = await ws_open(port, "https://www.youtube.com");
  for (const f of frames) await ws_send(ws, f);
  await sleep(300);
  ws.close();
  try {
    const ws2 = await ws_open(port, "https://evil.example.com");
    await ws_send(ws2, { type: "sync", source_id: "evil" });
    ws2.close();
    return "connected";
  } catch {
    return "denied";
  }
}

test("ws roundtrip real sockets", async () => {
  const evq = new EventQueue(100);
  const srv = new WSServer(0, evq);
  const port = await srv.start();
  let result: string | null = null;
  try {
    result = await client_flow(port);
  } finally {
    await srv.stop();
  }
  assert.equal(result, "denied");
  assert.deepEqual(evq.drain().map((e) => e["type"]),
                   ["register", "cues", "sync", "deactivate"]);
  assert.equal(srv.stats()["bad_frames"], 2);
});

test("health and status routes", async () => {
  const evq = new EventQueue(100);
  const srv = new WSServer(0, evq,
    { status_provider: () => ({ state: "ok", orig: "hi", trans: "\u4f60\u597d" }) });
  const port = await srv.start();
  try {
    let r = await http_get(port, "/health");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true, version: 1 });

    r = await http_get(port, "/status");
    assert.equal(r.status, 200);
    const data = JSON.parse(r.body) as Record<string, any>;
    assert.equal(data["ok"], true);
    assert.equal(data["version"], 1);
    assert.deepEqual([data["state"], data["orig"], data["trans"]], ["ok", "hi", "\u4f60\u597d"]);
    assert.equal(data["stats"]["frames"], 0);
    assert.equal(data["stats"]["bad_frames"], 0);

    r = await http_get(port, "/nope");
    assert.equal(r.status, 404);
  } finally {
    await srv.stop();
  }
});

test("status projects current translation state to the top level", async () => {
  const current = { value: "waiting" };
  const engineStub = {
    status: () => ({
      sources: 1, active_source: "s1",
      display: { state: "ok", orig: "hello", trans: "",
                 trans_available: true, trans_state: current.value },
    }),
  };
  const srv = new WSServer(0, new EventQueue(10),
    { status_provider: () => project_status(engineStub, NO_OVERLAY, NO_TESTER) });
  const port = await srv.start();
  try {
    const states = ["idle", "waiting", "translating", "unconfigured", "ready",
                    "failed:\u989d\u5ea6\u4e0d\u8db3"];
    for (const state of states) {
      current.value = state;
      const r = await http_get(port, "/status");
      const data = JSON.parse(r.body) as Record<string, any>;
      assert.equal(r.status, 200);
      assert.equal(data["version"], 1);
      assert.equal(data["trans_state"], state);
      assert.equal(data["state"], "ok");
      assert.equal(data["orig"], "hello");
      assert.equal("display" in data, false, "trans_state belongs at the API top level");
    }
  } finally {
    await srv.stop();
  }
});

withTmp("chinese original stays idle through real status route", async (dir) => {
  const settings = S.default_settings();
  const prov = settings["provider"] as unknown as Record<string, unknown>;
  prov["mock"] = false;
  prov["base_url"] = "https://provider.test/v1";
  prov["model"] = "test-model";
  const translated_calls: unknown[] = [];
  const cache = new Q.TranslationCache(path.join(dir, "chinese-status.db"));
  const engine = new Engine(settings, cache, 1,
    (jobs) => { translated_calls.push(jobs); return []; });
  engine.handle_event({ type: "cues", source_id: "zh1", video_id: "v1",
                        track_lang: "zh-Hans",
                        cues: [{ start_ms: 0, end_ms: 1000, text: "\u8fd9\u662f\u4e00\u6bb5\u539f\u6587\u5b57\u5e55" }] });
  engine.handle_event({ type: "sync", source_id: "zh1", video_time_ms: 500,
                        playing: false, playback_rate: 1.0,
                        timestamp: Date.now() });
  engine.tick();

  const srv = new WSServer(0, new EventQueue(10),
    { status_provider: () => project_status(engine, NO_OVERLAY, NO_TESTER) });
  const port = await srv.start();
  try {
    let r = await http_get(port, "/status");
    let data = JSON.parse(r.body) as Record<string, any>;
    assert.equal(r.status, 200);
    assert.equal(data["ok"], true);
    assert.equal(data["orig"], "\u8fd9\u662f\u4e00\u6bb5\u539f\u6587\u5b57\u5e55");
    assert.equal(data["trans"], "");
    assert.equal(data["trans_state"], "idle");
    assert.equal(data["trans_available"], true);
    assert.deepEqual(translated_calls, []);

    // Turning the translator off must keep the same source out of the queue.
    prov["mock"] = false;
    prov["base_url"] = "";
    prov["model"] = "";
    engine.tick();
    r = await http_get(port, "/status");
    data = JSON.parse(r.body) as Record<string, any>;
    assert.equal(r.status, 200);
    assert.equal(data["trans_state"], "idle");
    assert.equal(data["trans_available"], false);
    assert.deepEqual(translated_calls, []);
  } finally {
    await srv.stop();
    (engine._queue as unknown as { shutdown?: () => void }).shutdown?.();
  }
  cache.close();
});

withTmp("register video metadata is visible through real status route", async (dir) => {
  const cache = new Q.TranslationCache(path.join(dir, "register-metadata.db"));
  const engine = new Engine(S.default_settings(), cache, 1);
  engine.handle_event({ type: "register", source_id: "s1", video_id: "v1",
                        tab_title: "Clean title",
                        video_description: "Video description" });
  engine.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                        tab_title: "Clean title", cues: [] });
  assert.equal((engine.sources["s1"]!.meta)["video_description"], "Video description");
  engine.tick();

  const srv = new WSServer(0, new EventQueue(10),
    { status_provider: () => project_status(engine, NO_OVERLAY, NO_TESTER) });
  const port = await srv.start();
  try {
    const r = await http_get(port, "/status");
    const data = JSON.parse(r.body) as Record<string, any>;
    assert.equal(r.status, 200);
    assert.equal(data["title"], "Clean title");
    assert.equal(data["video_description"], "Video description");
  } finally {
    await srv.stop();
    (engine._queue as unknown as { shutdown?: () => void }).shutdown?.();
  }
  cache.close();
});

test("status without provider leaks nothing and survives provider failure", async () => {
  const evq = new EventQueue(100);
  const plain = new WSServer(0, evq);
  const p1 = await plain.start();
  try {
    const r = await http_get(p1, "/status");
    const data = JSON.parse(r.body) as Record<string, any>;
    assert.equal(r.status, 200);
    assert.equal(data["ok"], true);
    assert.equal(["orig", "trans", "trans_state"].some((k) => k in data), false,
                 "no UI data without a provider");
  } finally {
    await plain.stop();
  }

  // status_error carries the exception type name (Python type(e).__name__).
  class RuntimeError extends Error {
    constructor() { super("provider exploded"); this.name = "RuntimeError"; }
  }
  const boom = () => { throw new RuntimeError(); };
  const broken = new WSServer(0, evq, { status_provider: boom });
  const p2 = await broken.start();
  try {
    const r = await http_get(p2, "/status");
    const data = JSON.parse(r.body) as Record<string, any>;
    assert.equal(r.status, 200, "a broken provider must not take the route down");
    assert.equal(data["status_error"], "RuntimeError");
  } finally {
    await broken.stop();
  }
});

test("status reports transport stats", async () => {
  const evq = new EventQueue(100);
  const srv = new WSServer(0, evq);
  const port = await srv.start();
  try {
    const ws = await ws_open(port, "https://www.youtube.com");
    await ws_send(ws, { type: "register", provider: "youtube",
                        source_id: "s1", video_id: "v" });
    await ws_send(ws, "{not json");
    await sleep(200);
    ws.close();
    const r = await http_get(port, "/status");
    const st = (JSON.parse(r.body) as Record<string, any>)["stats"];
    assert.equal(st["frames"], 2);
    assert.equal(st["bad_frames"], 1);
  } finally {
    await srv.stop();
  }
});
