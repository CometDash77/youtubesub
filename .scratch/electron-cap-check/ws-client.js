// WS 取证客户端。mode=ok 走完整 v1 帧序列（含坏帧不断连验证）；
// mode=evil 用伪造 Origin 验证 allowlist 拒绝。
const WebSocket = require("ws");
const mode = process.argv[2] || "ok";
const opts = mode === "evil" ? { headers: { Origin: "https://evil.example.com" } } : {};
const ws = new WebSocket("ws://127.0.0.1:9877/ws", opts);
const sid = "capcheck-src-1";

ws.on("open", () => {
  const frames = [
    { type: "register", provider: "youtube", source_id: sid, tab_title: "capcheck 验证视频", video_id: "v1" },
    { type: "cues", provider: "youtube", source_id: sid, cues: [
      { start_ms: 0, end_ms: 4000, text: "hello from the wire protocol" },
      { start_ms: 4000, end_ms: 8000, text: "second cue line" }
    ] },
    { type: "sync", source_id: sid, video_time_ms: 4200, playing: true, playback_rate: 1.0, timestamp: Date.now() }
  ];
  let i = 0;
  const iv = setInterval(() => {
    if (i >= frames.length) {
      // 未知 type 与非 JSON 坏帧：连接必须保持，随后 sync(playing=false) 仍生效。
      ws.send(JSON.stringify({ type: "mystery" }));
      ws.send("this is not json");
      ws.send(JSON.stringify({ type: "sync", source_id: sid, video_time_ms: 4500, playing: false, playback_rate: 1.0, timestamp: Date.now() }));
      clearInterval(iv);
      setTimeout(() => { ws.close(); process.exit(0); }, 400);
      return;
    }
    ws.send(JSON.stringify(frames[i++]));
  }, 120);
});
ws.on("error", (e) => { console.log("WS-ERROR " + e.message); process.exit(1); });
ws.on("unexpected-response", (req, res) => { console.log("WS-REJECTED status=" + res.statusCode); process.exit(2); });
