// 1:1 port of desktop/suboverlay/server.py (ticket #198, map #181): the
// loopback WebSocket service for PROTOCOL.md v1. Security per ADR-003: bind
// 127.0.0.1 only, WS Origin allowlist (youtube/localhost/none), /health
// probe. The Python daemon thread + asyncio loop pair maps to node:http +
// the ws package on the single event loop (thread->loop mapping table,
// ticket #203 header); queue.Queue -> EventQueue below.
//
// Registered conversions (criteria #2):
// - start(): thread boot + _ready.wait(5) + _startup_error re-raise ->
//   the listen promise raced against a 5s timeout; a listen failure
//   (EADDRINUSE) rejects start() exactly where Python raises
//   _startup_error. start() resolves with the bound port (port-0 test
//   fixtures need it; Python knew its port up front).
// - TimeoutError("\u5b57\u5e55\u670d\u52a1\u542f\u52a8\u8d85\u65f6") -> WsStartupTimeout
//   (name "TimeoutError", same message).
// - queue.Queue(maxsize) with put_nowait / swallowed queue.Full ->
//   EventQueue.put() boolean; false means full and the frame is dropped,
//   same observable.
// - websockets serve() process_request -> an http request handler for
//   /health, /status and the 404 "not found" branch, plus an upgrade
//   handler gating non-/ws paths (404) and the Origin allowlist (403).
//   /health and /status skip the Origin gate, exactly like the Python
//   branch order.
// - type(e).__name__ -> err.name; stats()["error"] is a "Name: message"
//   string or null (JSON null, like Python None). A throwing status
//   provider lands in payload["status_error"] = err.name, never a 500.
// - the handler's outer `except Exception: pass` -> an empty ws "error"
//   listener (the connection dies, the server lives).
// - on_frame_error is stored but never invoked in server.py; the port
//   keeps the field (and the dead-parameter semantics) 1:1.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { VALID_TYPES, WS_PATH, HEALTH_PATH, STATUS_PATH } from "./protocol.ts";

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

// Allow empty (non-browser client), localhost, or *.youtube.com.
export function origin_allowed(origin: string | null | undefined): boolean {
  if (!origin) return true;
  const o = origin.toLowerCase();
  if (o.includes("localhost") || o.includes("127.0.0.1") || o.includes("[::1]")) return true;
  return o.endsWith("youtube.com") || o.endsWith(".youtube.com");
}

// Validate an inbound frame into a plain event record; null for junk.
// Never raises; unknown types are ignored (counted by the caller).
export function sanitize_event(msg: unknown): Record<string, unknown> | null {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return null;
  const rec = msg as Record<string, unknown>;
  const t = rec["type"];
  if (typeof t !== "string" || !VALID_TYPES.has(t) || t === "play_pause") return null;
  const sid = rec["source_id"];
  if ((t === "sync" || t === "deactivate") && (typeof sid !== "string" || !sid)) return null;
  if ((t === "register" || t === "cues") && typeof sid !== "string") return null;
  return rec;
}

// queue.Queue equivalent: bounded FIFO; a put on a full queue drops the
// frame, exactly like the server's swallowed queue.Full.
export class EventQueue {
  private items: Record<string, unknown>[] = [];
  private readonly maxsize: number;
  constructor(maxsize: number = 0) {
    this.maxsize = maxsize;
  }
  put(v: Record<string, unknown>): boolean {
    if (this.maxsize > 0 && this.items.length >= this.maxsize) return false;
    this.items.push(v);
    return true;
  }
  get_nowait(): Record<string, unknown> | undefined {
    return this.items.shift();
  }
  drain(): Record<string, unknown>[] {
    const out = this.items;
    this.items = [];
    return out;
  }
}

// Python TimeoutError carries the builtin name through the startup path.
class WsStartupTimeout extends Error {
  constructor() {
    super("\u5b57\u5e55\u670d\u52a1\u542f\u52a8\u8d85\u65f6");
    this.name = "TimeoutError";
  }
}

export interface WSServerOptions {
  on_frame_error?: ((...args: unknown[]) => void) | null;
  status_provider?: (() => Record<string, unknown>) | null;
}

export class WSServer {
  readonly port: number;
  readonly events: EventQueue;
  private readonly _status_provider: (() => Record<string, unknown>) | null;
  private readonly _on_frame_error: ((...args: unknown[]) => void) | null;
  private _frame_errors = 0;
  private _frames_seen = 0;
  private _error: string | null = null;
  private _http: Server | null = null;
  private _wss: WebSocketServer | null = null;
  private _closed = false;

  constructor(port: number, events: EventQueue, opts: WSServerOptions = {}) {
    this.port = port;
    this.events = events;
    this._status_provider = opts.status_provider ?? null;
    this._on_frame_error = opts.on_frame_error ?? null;
  }

  // Bind and serve; resolves with the bound port. Listen failures (port
  // conflict) reject here, where Python re-raises _startup_error.
  async start(): Promise<number> {
    const http = createServer((req, res) => this._http_route(req, res));
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    wss.on("connection", (ws: WebSocket) => this._connection(ws));
    http.on("upgrade", (req, socket, head) => {
      const path = (req.url ?? "").split("?")[0]!;
      if (path !== WS_PATH) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      if (!origin_allowed(req.headers.origin ?? "")) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
    this._http = http;
    this._wss = wss;
    const listening = new Promise<void>((resolve, reject) => {
      http.once("listening", () => resolve());
      http.once("error", (e: Error) => {
        this._error = e.name + ": " + e.message;
        reject(e);
      });
    });
    http.listen(this.port, "127.0.0.1");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        listening,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new WsStartupTimeout()), 5000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return (http.address() as AddressInfo).port;
  }

  // Python: loop.call_soon_threadsafe(server.close) + thread.join(3). The
  // 3s join budget becomes a race: past it we stop waiting (same effect -
  // stop() returns while the OS cleans up in the background).
  async stop(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    const wss = this._wss;
    const http = this._http;
    if (wss === null || http === null) return;
    const all = Promise.all([
      Promise.all([...wss.clients].map((c) => new Promise<void>((resolve) => {
        c.once("close", () => resolve());
        c.close();
      }))),
      new Promise<void>((resolve) => http.close(() => resolve())),
    ]);
    await Promise.race([all, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
  }

  private _http_route(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? "").split("?")[0]!;
    if (path === HEALTH_PATH) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: 1 }));
      return;
    }
    if (path === STATUS_PATH) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this._status_payload()));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }

  private _connection(ws: WebSocket): void {
    ws.on("message", (data: unknown) => {
      const raw = to_buffer(data);
      if (raw.length > MAX_FRAME_BYTES) return;
      this._frames_seen++;
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        this._frame_errors++;
        return;
      }
      const ev = sanitize_event(msg);
      if (ev === null) {
        this._frame_errors++;
        return;
      }
      // events.put_nowait(ev) except queue.Full: pass
      this.events.put(ev);
    });
    ws.on("error", () => {});
  }

  // Loopback diagnostics: transport stats + whatever the UI is showing.
  // The provider is optional (tests/headless runs omit it) and must never
  // be able to break the endpoint, so its failure is reported inline.
  private _status_payload(): Record<string, unknown> {
    const payload: Record<string, unknown> = { ok: true, version: 1, stats: this.stats() };
    if (this._status_provider !== null) {
      try {
        const extra = this._status_provider();
        if (extra !== null && typeof extra === "object" && !Array.isArray(extra)) {
          Object.assign(payload, extra);
        }
      } catch (e) {
        payload["status_error"] = (e as Error).name; // never 500 the route
      }
    }
    return payload;
  }

  stats(): Record<string, unknown> {
    return { frames: this._frames_seen, bad_frames: this._frame_errors, error: this._error };
  }
}

function to_buffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data.map((d) => Buffer.from(d as Uint8Array)));
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data), "utf8");
}
