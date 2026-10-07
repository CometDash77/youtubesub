// Wire-protocol probe client for the skeleton acceptance harness.
// mode=ok: full v1 frame sequence incl. bad-frame tolerance; prints
// MIDSTATUS / FINALSTATUS verdict lines read by the harness.
// mode=evil: forged Origin, expects the 403 rejection (WS-REJECTED).
import WebSocket from "ws";

const mode = process.argv[2] || "ok";
const opts = mode === "evil" ? { headers: { Origin: "https://evil.example.com" } } : {};
const ws = new WebSocket("ws://127.0.0.1:9877/ws", opts);
const sid = "skeleton-src-1";

async function readStatus() {
  const res = await fetch("http://127.0.0.1:9877/status");
  return res.json();
}

ws.on("open", async () => {
  if (mode === "evil") {
    console.log("EVIL-OPEN should-not-happen");
    process.exit(3);
  }
  const frames = [
    { type: "register", provider: "youtube", source_id: sid, tab_title: "骨架验证视频", video_id: "v1" },
    { type: "cues", provider: "youtube", source_id: sid, cues: [
      { start_ms: 0, end_ms: 4000, text: "hello from the wire protocol" },
      { start_ms: 4000, end_ms: 8000, text: "second cue line" },
    ] },
    { type: "sync", source_id: sid, video_time_ms: 4200, playing: true, playback_rate: 1.0, timestamp: Date.now() },
  ];
  let i = 0;
  const iv = setInterval(async () => {
    if (i >= frames.length) {
      clearInterval(iv);
      const mid = await readStatus();
      console.log("MIDSTATUS playing=" + mid.playing + " state=" + mid.state + ' orig="' + mid.orig + '"');
      // Unknown type and non-JSON junk: connection must stay, later sync works.
      ws.send(JSON.stringify({ type: "mystery" }));
      ws.send("this is not json");
      ws.send(JSON.stringify({ type: "sync", source_id: sid, video_time_ms: 4500, playing: false, playback_rate: 1.0, timestamp: Date.now() }));
      setTimeout(async () => {
        const fin = await readStatus();
        console.log("FINALSTATUS playing=" + fin.playing + ' orig="' + fin.orig + '" bad_frames=' + fin.stats.bad_frames);
        ws.close();
        process.exit(0);
      }, 500);
      return;
    }
    ws.send(JSON.stringify(frames[i++]));
  }, 120);
});

ws.on("error", (e) => { console.log("WS-ERROR " + e.message); process.exit(1); });
ws.on("unexpected-response", (req, res) => { console.log("WS-REJECTED status=" + res.statusCode); process.exit(2); });
