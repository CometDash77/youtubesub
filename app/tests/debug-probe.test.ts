// 1:1 port of desktop/tests/test_debug_probe.py (ticket #205, map #181):
// the diag page's data module - real HTTP loopback round trips + the explicit
// snapshot/failure distinction. Every pytest test function maps to exactly
// one test() below; assertions are converted assertion-for-assertion
// (equivalence criteria #1, #191).
// Registered conversions (criteria #2):
//   - http.server.HTTPServer -> node:http createServer; serve_forever on a
//     thread -> listen + await-ready; srv.shutdown() -> server.close().
//   - PR.fetch_status is async -> await (the read left the GUI thread in the
//     Python design; the event loop is the TS equivalent of the pool task).
//   - a raised fetch reports err.name, the type(e).__name__ convention; the
//     injected-boom test raises a named ConnectionRefusedError the same way
//     the ws-server-integration port names its RuntimeError.
//   - WSServer / EventQueue come from lib/ws-server.ts (the 1:1 server.py
//     port); status_provider option = status_provider kwarg.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as netCreateServer } from "node:net";
import { EventQueue, WSServer } from "../lib/ws-server.ts";
import { Snapshot, fetch_status } from "../src/main/debug/probe.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function free_port(): number {
  return 0; // port 0 = OS-assigned (the #198 port convention); the bound
            // port comes back from the listening event.
}

function serve(handler: Handler): Promise<{ close(): void; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(free_port(), "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ close: () => server.close(), port });
    });
  });
}

const PAYLOAD = { ok: true, version: 1, stats: { frames: 7, bad_frames: 1, error: "" },
                  state: "ok", orig: "hello" };

test("fetch_status reports a snapshot against a real server", async () => {
  const srv = await serve((req, res) => {
    const body = Buffer.from(JSON.stringify(PAYLOAD), "utf8");
    res.writeHead(200, { "Content-Type": "application/json",
                         "Content-Length": String(body.length) });
    res.end(body);
  });
  try {
    const snap = await fetch_status(srv.port);
    assert.equal(snap.ok, true);
    assert.equal((snap.data?.stats as { frames?: unknown }).frames, 7);
    assert.equal(snap.data?.state, "ok");
    assert.equal(snap.error, "");
  } finally {
    srv.close();
  }
});

test("fetch_status reports failure when nothing is listening", async () => {
  const srv = await serve(() => {});
  const dead = srv.port;
  srv.close();
  await new Promise((r) => setTimeout(r, 50)); // let the OS release the port
  const snap = await fetch_status(dead, "127.0.0.1", 1.0);
  assert.equal(snap.ok, false);
  assert.equal(snap.data, null);
  assert.ok(snap.error);
});

test("fetch_status never raises on a bad port", async () => {
  for (const port of ["nope", -1, null]) {
    const snap = await fetch_status(port, "127.0.0.1", 1.0);
    assert.equal(snap.ok, false);
    assert.equal(snap.data, null);
  }
});

test("fetch_status gives up at the timeout", async () => {
  // A server that accepts but never answers: cap, then it is a failure.
  const server = netCreateServer();
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const started = performance.now();
    const snap = await fetch_status(port, "127.0.0.1", 1.0);
    const elapsed = (performance.now() - started) / 1000;
    assert.equal(snap.ok, false);
    assert.ok(elapsed < 2.5, String(elapsed));
  } finally {
    server.close();
  }
});

test("fetch_status ignores proxy environment", async () => {
  // Loopback traffic must not be hijacked by HTTP_PROXY (spec #162 decision 10).
  const srv = await serve((req, res) => {
    const body = Buffer.from(JSON.stringify(PAYLOAD), "utf8");
    res.writeHead(200, { "Content-Length": String(body.length) });
    res.end(body);
  });
  process.env["HTTP_PROXY"] = "http://127.0.0.1:1";
  process.env["http_proxy"] = "http://127.0.0.1:1";
  try {
    const snap = await fetch_status(srv.port);
    assert.equal(snap.ok, true, snap.error);
  } finally {
    delete process.env["HTTP_PROXY"];
    delete process.env["http_proxy"];
    srv.close();
  }
});

test("injected fetcher distinguishes payload from failure", async () => {
  const ok = await fetch_status(1, "127.0.0.1", 2.0, () => ({ ok: true }));
  assert.deepEqual(ok.data, { ok: true });
  const bad = await fetch_status(1, "127.0.0.1", 2.0, () => "nope");
  assert.equal(bad.ok, false);

  const boom = (): never => {
    throw Object.assign(new Error("refused"), { name: "ConnectionRefusedError" });
  };
  const snap = await fetch_status(1, "127.0.0.1", 2.0, boom);
  assert.equal(snap.ok, false);
  assert.equal(snap.data, null);
  assert.ok(snap.error.includes("ConnectionRefused"), snap.error);
});

test("fetch_status reads the existing status contract", async () => {
  // Against the real WSServer: /status keeps its ok/version/stats shape.
  const server = new WSServer(0, new EventQueue(),
    { status_provider: () => ({ state: "ok", orig: "hi" }) });
  const port = await server.start();
  try {
    const snap = await fetch_status(port);
    assert.equal(snap.ok, true, snap.error);
    assert.equal(snap.data?.ok, true);
    assert.equal(snap.data?.version, 1);
    assert.deepEqual(snap.data?.stats, { frames: 0, bad_frames: 0, error: null });
    assert.equal(snap.data?.state, "ok");
    assert.equal(snap.data?.orig, "hi");
  } finally {
    await server.stop();
  }
});

test("Snapshot keeps failure and payload mutually exclusive", () => {
  const ok = new Snapshot(true, { a: 1 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.data, { a: 1 });
  assert.equal(ok.error, "");
  const fail = new Snapshot(false, null, "ConnectionRefusedError");
  assert.equal(fail.ok, false);
  assert.equal(fail.data, null);
  assert.equal(fail.error, "ConnectionRefusedError");
});
