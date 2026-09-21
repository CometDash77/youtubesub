"""Fake browser: connects to the real WS server and streams cues+sync
in real time, exactly like the userscript will. Used for GUI verification."""
import asyncio, json, sys, time
import websockets

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9877

JSON3 = {"events": [
  {"tStartMs": 0, "dDurationMs": 2000, "segs": [{"utf8": "Hello everyone,", "tOffsetMs": 300}, {"utf8": "welcome back", "tOffsetMs": 1800}]},
  {"tStartMs": 1000, "dDurationMs": 2500, "segs": [{"utf8": "Hello everyone, welcome back to the show", "tOffsetMs": 2400}]},
  {"tStartMs": 4000, "dDurationMs": 2000, "segs": [{"utf8": "Today we are talking about", "tOffsetMs": 4300}]},
  {"tStartMs": 6000, "dDurationMs": 2500, "segs": [{"utf8": "subtitle overlays on Windows", "tOffsetMs": 6200}]},
  {"tStartMs": 9000, "dDurationMs": 2000, "segs": [{"utf8": "Let us get right into it.", "tOffsetMs": 9100}]},
  {"tStartMs": 12000, "dDurationMs": 2000, "segs": [{"utf8": "First point: always on top.", "tOffsetMs": 12100}]},
]}

async def main():
    url = "ws://127.0.0.1:" + str(PORT) + "/ws"
    async with websockets.connect(url, origin="https://www.youtube.com") as ws:
        sid = "fake-src-1"
        await ws.send(json.dumps({"type": "register", "provider": "youtube", "source_id": sid,
                                  "tab_title": "Fake Browser - GUI Verification", "video_id": "fakeV1",
                                  "track_kind": "asr", "track_lang": "en"}))
        await ws.send(json.dumps({"type": "cues", "provider": "youtube", "source_id": sid,
                                  "video_id": "fakeV1", "track_kind": "asr", "track_lang": "en",
                                  "cues": parse()}))
        # 14s of real-time playback at 1.0x
        t0 = time.time()
        while time.time() - t0 < 14:
            vt = (time.time() - t0) * 1000.0
            await ws.send(json.dumps({"type": "sync", "source_id": sid, "video_time_ms": vt,
                                      "playing": True, "playback_rate": 1.0,
                                      "timestamp": int(time.time() * 1000)}))
            await asyncio.sleep(0.25)
        # pause for 4s (clock must freeze)
        vt = (time.time() - t0) * 1000.0
        await ws.send(json.dumps({"type": "sync", "source_id": sid, "video_time_ms": vt,
                                  "playing": False, "playback_rate": 1.0,
                                  "timestamp": int(time.time() * 1000)}))
        await asyncio.sleep(4)

def parse():
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from suboverlay.protocol import parse_json3
    return [{"start_ms": c.start_ms, "end_ms": c.end_ms, "text": c.text,
             "last_off_ms": c.last_off_ms} for c in parse_json3(JSON3)]

import os
asyncio.run(main())