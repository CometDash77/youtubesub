"""Integration: real WS client <-> real WSServer (loopback)."""
import asyncio, json, os, queue, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from suboverlay.server import WSServer, sanitize_event, origin_allowed
PORT = 19877
def test_sanitize_and_origin_unit():
    assert sanitize_event({"type": "cues", "source_id": "s", "cues": []}) is not None
    assert sanitize_event({"type": "sync", "source_id": "s"}) is not None
    assert sanitize_event({"type": "sync"}) is None
    assert sanitize_event({"type": "play_pause", "source_id": "s"}) is None
    assert sanitize_event({"type": "mystery", "source_id": "s"}) is None
    assert sanitize_event([1, 2]) is None
    assert origin_allowed("https://www.youtube.com")
    assert not origin_allowed("https://evil.example.com")
    assert origin_allowed("")

def test_ws_roundtrip_real_sockets():
    evq = queue.Queue(maxsize=100)
    srv = WSServer(port=PORT, event_queue=evq)
    srv.start()
    time.sleep(0.4)
    result = None
    try:
        result = asyncio.new_event_loop().run_until_complete(client_flow())
    finally:
        srv.stop()
    assert result == "denied"
    kinds = []
    while True:
        try:
            kinds.append(evq.get_nowait()["type"])
        except queue.Empty:
            break
    assert kinds == ["register", "cues", "sync", "deactivate"], kinds
    assert srv.stats()["bad_frames"] == 2

async def client_flow():
    import websockets
    frames = [
        {"type": "register", "provider": "youtube", "source_id": "s1", "tab_title": "t",
         "video_id": "v1", "track_kind": "asr", "track_lang": "en"},
        {"type": "cues", "provider": "youtube", "source_id": "s1", "video_id": "v1",
         "track_kind": "asr", "track_lang": "en",
         "cues": [{"start_ms": 1000, "end_ms": 2000, "text": "hello", "last_off_ms": 1500}]},
        {"type": "sync", "source_id": "s1", "video_time_ms": 1200.0, "playing": True,
         "playback_rate": 1.5, "timestamp": int(time.time() * 1000)},
        {"type": "deactivate", "source_id": "s1"},
        "{not json",
        {"type": "unknown"},
    ]
    url = "ws://127.0.0.1:" + str(PORT) + "/ws"
    async with websockets.connect(url, origin="https://www.youtube.com") as ws:
        for f in frames:
            await ws.send(json.dumps(f) if not isinstance(f, str) else f)
        await asyncio.sleep(0.3)
    try:
        async with websockets.connect(url, origin="https://evil.example.com") as ws2:
            await ws2.send(json.dumps({"type": "sync", "source_id": "evil"}))
        return "connected"
    except Exception:
        return "denied"

def _http_get(port, path):
    """Plain HTTP GET that ignores the machine's HTTP_PROXY (http.client)."""
    import http.client
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        return resp.status, resp.read().decode("utf-8")
    finally:
        conn.close()


def test_health_and_status_routes():
    evq = queue.Queue(maxsize=100)
    srv = WSServer(port=PORT + 1, event_queue=evq,
                   status_provider=lambda: {"state": "ok", "orig": "hi", "trans": "你好"})
    srv.start()
    time.sleep(0.4)
    try:
        code, body = _http_get(PORT + 1, "/health")
        assert code == 200 and json.loads(body) == {"ok": True, "version": 1}

        code, body = _http_get(PORT + 1, "/status")
        assert code == 200
        data = json.loads(body)
        assert data["ok"] is True and data["version"] == 1
        assert (data["state"], data["orig"], data["trans"]) == ("ok", "hi", "你好")
        assert data["stats"]["frames"] == 0 and data["stats"]["bad_frames"] == 0

        code, _ = _http_get(PORT + 1, "/nope")
        assert code == 404
    finally:
        srv.stop()


def test_status_without_provider_leaks_nothing_and_survives_provider_failure():
    evq = queue.Queue(maxsize=100)
    plain = WSServer(port=PORT + 2, event_queue=evq)
    plain.start()
    time.sleep(0.4)
    try:
        code, body = _http_get(PORT + 2, "/status")
        data = json.loads(body)
        assert code == 200 and data["ok"] is True
        assert "orig" not in data and "trans" not in data, "no UI data without a provider"
    finally:
        plain.stop()

    def boom():
        raise RuntimeError("provider exploded")

    broken = WSServer(port=PORT + 3, event_queue=evq, status_provider=boom)
    broken.start()
    time.sleep(0.4)
    try:
        code, body = _http_get(PORT + 3, "/status")
        data = json.loads(body)
        assert code == 200, "a broken provider must not take the route down"
        assert data["status_error"] == "RuntimeError"
    finally:
        broken.stop()


def test_status_reports_transport_stats():
    evq = queue.Queue(maxsize=100)
    srv = WSServer(port=PORT + 4, event_queue=evq)
    srv.start()
    time.sleep(0.4)
    try:
        asyncio.new_event_loop().run_until_complete(_one_good_one_bad(PORT + 4))
        code, body = _http_get(PORT + 4, "/status")
        st = json.loads(body)["stats"]
        assert st["frames"] == 2 and st["bad_frames"] == 1
    finally:
        srv.stop()


async def _one_good_one_bad(port):
    import websockets
    url = "ws://127.0.0.1:" + str(port) + "/ws"
    async with websockets.connect(url, origin="https://www.youtube.com") as ws:
        await ws.send(json.dumps({"type": "register", "provider": "youtube",
                                  "source_id": "s1", "video_id": "v"}))
        await ws.send("{not json")
        await asyncio.sleep(0.2)
