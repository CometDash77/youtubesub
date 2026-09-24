"""Test-only controller around the real desktop App for browser E2E scenarios."""
import json
import os
import queue
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PySide6 import QtCore

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app import App


def main():
    port = int(os.environ["YOUTUBESUB_E2E_MODE_PORT"])
    app = App()
    requested_modes = queue.Queue()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            if self.path != "/mode":
                self.send_error(404)
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                mode = body["mode"]
                if mode not in ("orig", "trans", "bilingual"):
                    raise ValueError("invalid mode")
            except Exception:
                self.send_error(400)
                return
            requested_modes.put(mode)
            self.send_response(202)
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def apply_modes():
        while True:
            try:
                mode = requested_modes.get_nowait()
            except queue.Empty:
                break
            app.settings["display"]["mode"] = mode
            app.overlay.mode = mode
            app.overlay.update()

    timer = QtCore.QTimer()
    timer.timeout.connect(apply_modes)
    timer.start(20)
    app.run()


if __name__ == "__main__":
    main()
