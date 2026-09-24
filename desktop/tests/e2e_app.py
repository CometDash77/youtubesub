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
            if self.path not in ("/mode", "/provider"):
                self.send_error(404)
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                if self.path == "/mode":
                    value = body["mode"]
                    if value not in ("orig", "trans", "bilingual"):
                        raise ValueError("invalid mode")
                else:
                    value = body["provider"]
                    if not isinstance(value, dict):
                        raise ValueError("invalid provider")
            except Exception:
                self.send_error(400)
                return
            requested_modes.put((self.path, value))
            self.send_response(202)
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def apply_modes():
        while True:
            try:
                path, value = requested_modes.get_nowait()
            except queue.Empty:
                break
            if path == "/mode":
                app.settings["display"]["mode"] = value
                app.overlay.mode = value
                app.overlay.update()
            else:
                app.settings["provider"].clear()
                app.settings["provider"].update(value)

    timer = QtCore.QTimer()
    timer.timeout.connect(apply_modes)
    timer.start(20)
    app.run()


if __name__ == "__main__":
    main()
