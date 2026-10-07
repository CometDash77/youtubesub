// Protocol-v1-shaped loopback WS placeholder for the Electron skeleton.
// Transport semantics asserted by the skeleton acceptance (loopback bind,
// Origin allowlist, bad-frame tolerance without disconnect, /health +
// /status) are carried 1:1 from the cap-check evidence draft; the real
// protocol v1 service (cue pipeline, full state machine) lands with the
// protocol-service ticket, which owns semantics from desktop/suboverlay/server.py.
// Known quirk kept on purpose for fidelity: "https://notyoutube.com" passes
// originAllowed (endsWith match) - same as the placeholder this ports.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export const VALID_TYPES = ["register", "cues", "sync", "deactivate", "play_pause"] as const;
export type WireType = (typeof VALID_TYPES)[number];

// Wire frames come from the browser as arbitrary JSON; the placeholder only
// reads the fields below and treats everything else as opaque.
export interface WireEvent {
  type: WireType;
  source_id: string;
  tab_title?: unknown;
  cues?: unknown;
  playing?: unknown;
  video_time_ms?: unknown;
  playback_rate?: unknown;
  timestamp?: unknown;
  [key: string]: unknown;
}

export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  const o = origin.toLowerCase();
  if (o.includes("localhost") || o.includes("127.0.0.1") || o.includes("[::1]")) return true;
  return o.endsWith("youtube.com") || o.endsWith(".youtube.com");
}

// Mirrors server.py sanitize_event: junk frames return null, never throw.
export function sanitizeEvent(msg: unknown): WireEvent | null {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  const rec = msg as Record<string, unknown>;
  const t = rec.type;
  if (typeof t !== "string") return null;
  if (!(VALID_TYPES as readonly string[]).includes(t) || t === "play_pause") return null;
  const sid = rec.source_id;
  if ((t === "sync" || t === "deactivate") && (typeof sid !== "string" || !sid)) return null;
  if ((t === "register" || t === "cues") && typeof sid !== "string") return null;
  return rec as WireEvent;
}

export interface SkeletonServerHandlers {
  onFrame: (ev: WireEvent) => void;
  onLog?: (m: string) => void;
}

export interface SkeletonServerHandle {
  server: Server;
  state: {
    frames: number;
    badFrames: number;
    error: number;
    state: string;
    orig: string;
    trans: string;
    playing: boolean;
    title: string;
    sources: number;
  };
  ready: Promise<number>;
  close: () => Promise<void>;
}

export function startSkeletonServer(port: number, handlers: SkeletonServerHandlers): SkeletonServerHandle {
  const { onFrame, onLog = () => {} } = handlers;
  const state: SkeletonServerHandle["state"] = {
    frames: 0, badFrames: 0, error: 0,
    state: "no_cues", orig: "", trans: "",
    playing: false, title: "", sources: 0,
  };

  const server = createServer((req, res) => {
    const u = req.url || "/";
    if (req.method === "GET" && u === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: 1 }));
      return;
    }
    if (req.method === "GET" && u === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true, version: 1,
        stats: { frames: state.frames, bad_frames: state.badFrames, error: state.error },
        state: state.state, orig: state.orig, trans: state.trans,
        playing: state.playing, title: state.title,
        sources: state.sources,
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  server.on("upgrade", (req, sock, head) => {
    if (!originAllowed(req.headers.origin)) {
      onLog("origin rejected: " + req.headers.origin);
      sock.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      sock.destroy();
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (raw) => {
      state.frames++;
      let msg: unknown;
      try { msg = JSON.parse(raw.toString()); }
      catch { state.badFrames++; onLog("bad frame (not json), connection kept"); return; }
      const ev = sanitizeEvent(msg);
      if (!ev) { state.badFrames++; onLog("ignored frame type=" + String((msg as { type?: unknown })?.type)); return; }
      if (ev.type === "register") {
        state.sources++;
        state.title = typeof ev.tab_title === "string" ? ev.tab_title : "";
        state.state = "waiting";
      }
      if (ev.type === "cues") {
        state.state = "ok";
        const list = Array.isArray(ev.cues) ? ev.cues : [];
        const last = list.length ? list[list.length - 1] : null;
        const text = last && typeof last === "object" ? (last as { text?: unknown }).text : null;
        state.orig = typeof text === "string" ? text : "";
      }
      if (ev.type === "sync") { state.playing = Boolean(ev.playing); }
      if (ev.type === "deactivate") { state.sources = Math.max(0, state.sources - 1); }
      onFrame(ev);
    });
    ws.on("error", () => { state.error++; });
  });

  const ready = new Promise<number>((resolve, reject) => {
    server.once("listening", () => {
      const addr = server.address() as AddressInfo;
      onLog("listening on " + addr.address + ":" + addr.port);
      resolve(addr.port);
    });
    server.once("error", (e) => { onLog("server error: " + e.message); reject(e); });
  });
  server.listen(port, "127.0.0.1");

  const close = (): Promise<void> => new Promise((resolve) => {
    for (const c of wss.clients) c.terminate();
    server.close(() => resolve());
  });

  return { server, state, ready, close };
}