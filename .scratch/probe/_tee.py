"""Tee stdout into .scratch/probe/logs/ so a diagnostic run is inspectable later.

The E2E harness deletes its temp dir (Chrome profile + chrome.log) on stop, so
anything a probe does not write down itself is gone. Import and call tee() first
thing in main().
"""
import os
import sys
import time


class _Tee:
    def __init__(self, path):
        self.f = open(path, "w", encoding="utf-8")
        self.out = sys.__stdout__

    def write(self, s):
        self.f.write(s)
        try:
            self.out.write(s)
        except Exception:
            self.out.write(s.encode("ascii", "replace").decode("ascii"))

    def flush(self):
        self.f.flush()
        try:
            self.out.flush()
        except Exception:
            pass


def tee(here, name):
    d = os.path.join(here, "logs")
    os.makedirs(d, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = os.path.join(d, "%s-%s.log" % (stamp, name))
    sys.stdout = _Tee(path)
    print("# log:", path)
    return path
