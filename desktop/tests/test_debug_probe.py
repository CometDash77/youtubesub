"""地图 #152 / 实施票 #158 -- 排障页取数模块（spec #162 决策 1/5/7/10/11）。

黑盒口径：真 HTTP 回环往返 + 明确的「快照 / 失败」区分；失败**不是**空快照。
"""
import json
import os
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from suboverlay import debug_probe as PR


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _StatusHandler(BaseHTTPRequestHandler):
    payload = {"ok": True, "version": 1, "stats": {"frames": 7, "bad_frames": 1, "error": ""},
               "state": "ok", "orig": "hello"}

    def do_GET(self):
        body = json.dumps(self.payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def _serve(handler_cls=_StatusHandler):
    port = _free_port()
    srv = HTTPServer(("127.0.0.1", port), handler_cls)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, port


def test_fetch_status_reports_a_snapshot_against_a_real_server():
    srv, port = _serve()
    try:
        snap = PR.fetch_status(port)
    finally:
        srv.shutdown()
    assert snap.ok is True
    assert snap.data["stats"]["frames"] == 7
    assert snap.data["state"] == "ok"
    assert snap.error == ""


def test_fetch_status_reports_failure_when_nothing_is_listening():
    snap = PR.fetch_status(_free_port(), timeout=1.0)
    assert snap.ok is False
    assert snap.data is None
    assert snap.error


def test_fetch_status_never_raises_on_a_bad_port():
    for port in ("nope", -1, None):
        snap = PR.fetch_status(port, timeout=1.0)
        assert snap.ok is False and snap.data is None


def test_fetch_status_gives_up_at_the_timeout():
    """A server that accepts but never answers: 2s cap, then it is a failure."""
    port = _free_port()
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", port))
    listener.listen(1)
    try:
        started = time.monotonic()
        snap = PR.fetch_status(port, timeout=1.0)
        elapsed = time.monotonic() - started
    finally:
        listener.close()
    assert snap.ok is False
    assert elapsed < 2.5, elapsed


def test_fetch_status_ignores_proxy_environment(monkeypatch):
    """Loopback traffic must not be hijacked by HTTP_PROXY (spec #162 决策 10)."""
    srv, port = _serve()
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:1")
    try:
        snap = PR.fetch_status(port)
    finally:
        srv.shutdown()
    assert snap.ok is True, snap.error


def test_injected_fetcher_distinguishes_payload_from_failure():
    assert PR.fetch_status(1, fetcher=lambda: {"ok": True}).data == {"ok": True}
    assert PR.fetch_status(1, fetcher=lambda: "nope").ok is False

    def boom():
        raise ConnectionRefusedError()

    snap = PR.fetch_status(1, fetcher=boom)
    assert snap.ok is False and snap.data is None and "ConnectionRefused" in snap.error


def test_fetch_status_reads_the_existing_status_contract():
    """Against the real WSServer: /status keeps its ok/version/stats shape."""
    import queue

    from suboverlay.server import WSServer

    port = _free_port()
    server = WSServer(port, queue.Queue(), status_provider=lambda: {"state": "ok", "orig": "hi"})
    server.start()
    try:
        snap = PR.fetch_status(port)
    finally:
        server.stop()
    assert snap.ok is True, snap.error
    assert snap.data["ok"] is True and snap.data["version"] == 1
    assert snap.data["stats"] == {"frames": 0, "bad_frames": 0, "error": None}
    assert snap.data["state"] == "ok" and snap.data["orig"] == "hi"
