// Skeleton WS assertions A5.1-A5.5 from docs/ELECTRON-SKELETON-ACCEPTANCE.md,
// run as pure Node against the placeholder server (no Electron needed):
// /health shape, Origin allowlist, bad-frame tolerance without disconnect,
// cue-flow status reporting, loopback bind. The GUI-side ws scene in
// app/acceptance re-proves the same transport inside the running app.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { originAllowed, sanitizeEvent, startSkeletonServer } from "../src/main/ws-server.ts";

type Json = Record<string, any>;
type WsSocket = any;
type WsOptions = { headers?: Record<string, string> };

async function httpJson(port: number, path: string): Promise<{ statusCode: number; body: Json }> {
  const res = await fetch("http://127.0.0.1:" + port + path);
  return { statusCode: res.status, body: (await res.json()) as Json };
}

async function withServer(name: string, fn: (port: number) => Promise<void>): Promise<void> {
  test(name, async () => {
    const h = startSkeletonServer(0, { onFrame: () => {} });
    const port = await h.ready;
    try {
      await fn(port);
    } finally {
      await h.close();
    }
  });
}

function wsOpen(port: number, opts: WsOptions = {}): Promise<WsSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + port + "/ws", opts);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req: unknown, res: { statusCode: number }) =>
      reject(Object.assign(new Error("rejected"), { statusCode: res.statusCode })));
  });
}

function wsSend(ws: WsSocket, frame: unknown): Promise<void> {
  return new Promise((resolve) => ws.send(typeof frame === "string" ? frame : JSON.stringify(frame), () => resolve()));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

withServer("A5.1 /health returns 200 ok true version 1", async (port) => {
  const r = await httpJson(port, "/health");
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true, version: 1 });
});

withServer("A5.2 origin allowlist: non-whitelisted rejected 403, whitelisted pass", async (port) => {
  await assert.rejects(
    wsOpen(port, { headers: { Origin: "https://evil.example.com" } }),
    (err: Error & { statusCode?: number }) => err.statusCode === 403,
  );
  for (const origin of [undefined, "http://localhost:5173", "https://www.youtube.com"]) {
    const ws = await wsOpen(port, origin ? { headers: { Origin: origin } } : {});
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  }
});

withServer("A5.3 bad frames counted, connection kept, later frames processed", async (port) => {
  const ws = await wsOpen(port);
  await wsSend(ws, "this is not json");
  await wsSend(ws, { type: "mystery" });
  await wsSend(ws, { type: "sync", source_id: "s1", video_time_ms: 100, playing: false, playback_rate: 1, timestamp: 1 });
  await sleep(150);
  assert.equal(ws.readyState, WebSocket.OPEN, "connection must survive bad frames");
  const st = await httpJson(port, "/status");
  assert.equal(st.body.stats.bad_frames, 2);
  assert.equal(st.body.stats.frames, 3);
  assert.equal(st.body.stats.error, 0);
  ws.close();
});

withServer("A5.4 register cues sync reported via /status", async (port) => {
  const ws = await wsOpen(port);
  const sid = "skeleton-src-1";
  await wsSend(ws, { type: "register", provider: "youtube", source_id: sid, tab_title: "骨架验证视频", video_id: "v1" });
  await wsSend(ws, { type: "cues", provider: "youtube", source_id: sid, cues: [
    { start_ms: 0, end_ms: 4000, text: "hello from the wire protocol" },
    { start_ms: 4000, end_ms: 8000, text: "second cue line" },
  ] });
  await wsSend(ws, { type: "sync", source_id: sid, video_time_ms: 4200, playing: true, playback_rate: 1, timestamp: Date.now() });
  await sleep(150);
  const mid = await httpJson(port, "/status");
  assert.equal(mid.body.sources, 1);
  assert.equal(mid.body.title, "骨架验证视频");
  assert.equal(mid.body.state, "ok");
  assert.equal(mid.body.orig, "second cue line");
  assert.equal(mid.body.playing, true);
  assert.equal(mid.body.stats.frames, 3);
  await wsSend(ws, { type: "sync", source_id: sid, video_time_ms: 4500, playing: false, playback_rate: 1, timestamp: Date.now() });
  await sleep(100);
  const fin = await httpJson(port, "/status");
  assert.equal(fin.body.playing, false);
  assert.equal(fin.body.stats.frames, 4);
  ws.close();
});

test("A5.5 server binds loopback 127.0.0.1 only", async () => {
  const h = startSkeletonServer(0, { onFrame: () => {} });
  await h.ready;
  try {
    const addr = h.server.address() as AddressInfo;
    assert.equal(addr.address, "127.0.0.1");
  } finally {
    await h.close();
  }
});

test("unit: originAllowed table and sanitizeEvent guards", () => {
  assert.equal(originAllowed(undefined), true);
  assert.equal(originAllowed("http://localhost:3000"), true);
  assert.equal(originAllowed("http://127.0.0.1:9877"), true);
  assert.equal(originAllowed("https://www.youtube.com"), true);
  assert.equal(originAllowed("https://evil.example.com"), false);
  assert.equal(sanitizeEvent(null), null);
  assert.equal(sanitizeEvent([1, 2]), null);
  assert.equal(sanitizeEvent({ type: "mystery" }), null);
  assert.equal(sanitizeEvent({ type: "play_pause" }), null);
  assert.equal(sanitizeEvent({ type: "sync", source_id: "" }), null);
  assert.equal(sanitizeEvent({ type: "cues" }), null);
  assert.ok(sanitizeEvent({ type: "cues", source_id: "" }), "register/cues allow empty source_id");
});