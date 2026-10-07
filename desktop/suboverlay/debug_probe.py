"""排障页取数：读公开状态接口 `GET /status`（回环 HTTP），返回一个明确区分
「拿到了快照」与「取数失败」的结果对象 —— 失败**不是**空快照（spec #162 决策 1）。

刻意走 HTTP 而不是进程内直调引擎：这样「服务没在听」是本页能观测到的**结论**，
而不是它的前提（与 ADR-005「测试与生产同一条路径」同源；spec #162 决策 5）。
`http.client` 不读代理环境变量，所以回环流量不会被 HTTP_PROXY 劫持（决策 10）。

本模块不依赖 Qt、不做缓存、不做重试，也永不抛：任何异常都变成失败快照。
"""
import http.client
import json
import time

from .protocol import STATUS_PATH


class Snapshot:
    """One read of /status: `ok` decides which half is meaningful."""

    __slots__ = ("ok", "data", "error", "at")

    def __init__(self, ok, data=None, error="", at=None):
        self.ok = bool(ok)
        self.data = data if self.ok else None
        self.error = "" if self.ok else str(error or "取数失败")
        self.at = time.time() if at is None else float(at)

    def __repr__(self):
        return "Snapshot(ok=%r, error=%r)" % (self.ok, self.error)


def fetch_status(port, host="127.0.0.1", timeout=2.0, fetcher=None):
    """GET /status once. `fetcher` is the injectable seam for tests/headless runs."""
    if fetcher is not None:
        try:
            data = fetcher()
        except Exception as exc:
            return Snapshot(False, error=type(exc).__name__)
        if isinstance(data, dict):
            return Snapshot(True, data=data)
        return Snapshot(False, error="响应不是 JSON 对象")

    conn = None
    try:
        conn = http.client.HTTPConnection(host, int(port), timeout=float(timeout))
        conn.request("GET", STATUS_PATH)
        response = conn.getresponse()
        body = response.read()
        if response.status != 200:
            return Snapshot(False, error="HTTP %d" % response.status)
        data = json.loads(body.decode("utf-8"))
        if not isinstance(data, dict):
            return Snapshot(False, error="响应不是 JSON 对象")
        return Snapshot(True, data=data)
    except Exception as exc:
        return Snapshot(False, error=type(exc).__name__)
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
