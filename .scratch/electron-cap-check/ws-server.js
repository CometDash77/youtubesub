// 协议 v1 loopback WS 服务（复刻 desktop/suboverlay/server.py 语义）：
// 只绑 127.0.0.1；Origin allowlist（空 / localhost / *.youtube.com）；
// 坏帧记数不断连；未知 type 忽略；/health 与 /status 诊断端点。
const http = require("http");
const { WebSocketServer } = require("ws");

const VALID_TYPES = ["register", "cues", "sync", "deactivate", "play_pause"];

function originAllowed(origin) {
  if (!origin) return true;
  const o = origin.toLowerCase();
  if (o.includes("localhost") || o.includes("127.0.0.1") || o.includes("[::1]")) return true;
  return o.endsWith("youtube.com") || o.endsWith(".youtube.com");
}

// 对齐 server.py sanitize_event：垃圾帧返回 null，永不抛。
function sanitizeEvent(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  const t = msg.type;
  if (!VALID_TYPES.includes(t) || t === "play_pause") return null;
  const sid = msg.source_id;
  if ((t === "sync" || t === "deactivate") && (typeof sid !== "string" || !sid)) return null;
  if ((t === "register" || t === "cues") && typeof msg.source_id !== "string") return null;
  return msg;
}

function startCapcheckServer(port, { onFrame, onLog = () => {} }) {
  const state = {
    frames: 0, badFrames: 0, error: 0,
    state: "no_cues", orig: "", trans: "",
    playing: false, title: "", sources: 0
  };
  const server = http.createServer((req, res) => {
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
        sources: state.sources
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

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      state.frames++;
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { state.badFrames++; onLog("bad frame (not json), connection kept"); return; }
      const ev = sanitizeEvent(msg);
      if (!ev) { state.badFrames++; onLog("ignored frame type=" + (msg && msg.type)); return; }
      if (ev.type === "register") { state.sources++; state.title = ev.tab_title || ""; state.state = "waiting"; }
      if (ev.type === "cues") {
        state.state = "ok";
        const last = (ev.cues && ev.cues.length) ? ev.cues[ev.cues.length - 1] : null;
        state.orig = (last && last.text) || "";
      }
      if (ev.type === "sync") { state.playing = !!ev.playing; }
      if (ev.type === "deactivate") { state.sources = Math.max(0, state.sources - 1); }
      onFrame(ev);
    });
    ws.on("error", () => { state.error++; });
  });

  server.listen(port, "127.0.0.1", () => onLog("listening on 127.0.0.1:" + port));
  server.on("error", (e) => onLog("server error: " + e.message));
  return { state };
}

module.exports = { startCapcheckServer, originAllowed, sanitizeEvent };
