// Port of desktop/suboverlay/debug_probe.py - the diag page's data source:
// one read of the public status endpoint GET /status (loopback HTTP), returned
// as a result object that explicitly separates "got a snapshot" from "the read
// failed" - a failure is NOT an empty snapshot (spec #162 decision 1).
//
// Deliberately HTTP instead of an in-process call into the engine: "the server
// is not listening" must be a conclusion this page can OBSERVE, not a premise
// (ADR-005: tests and production share one path; spec #162 decision 5).
//
// Conversion notes (ticket #205):
//   - http.client.HTTPConnection -> node:http request. node:http reads no
//     proxy environment variables either, so loopback traffic is not hijacked
//     by HTTP_PROXY (decision 10) - the same property, pinned by a test.
//   - Python exceptions become JS Errors; error carries type(e).__name__, so
//     a raised error reports err.name (the ws-server-integration convention).
//   - The read is async (the pool thread has no Electron equivalent and none
//     is needed on the main process's event loop); the poller's DEFERRED path
//     keeps the "no second read while one is in flight" semantics.
// No Qt, no caching, no retries, never throws: every failure becomes a
// failed snapshot.
import http from "node:http";
import { STATUS_PATH } from "../protocol.ts";

export class Snapshot {
  // One read of /status: ok decides which half is meaningful.
  readonly ok: boolean;
  readonly data: Record<string, unknown> | null;
  readonly error: string;
  readonly at: number;

  constructor(ok: boolean, data: Record<string, unknown> | null = null,
              error: string | null = null, at: number | null = null) {
    this.ok = Boolean(ok);
    this.data = this.ok ? data : null;
    this.error = this.ok ? "" : String(error || "取数失败");
    this.at = at === null ? Date.now() / 1000 : at;
  }
}

function err_name(exc: unknown): string {
  // type(exc).__name__ equivalent: an Error reports its (assigned) name, so
  // callers can distinguish ConnectionRefusedError from TimeoutError etc.
  if (exc instanceof Error) return exc.name || "Error";
  return "Error";
}

// GET /status once. fetcher is the injectable seam for tests/headless runs.
export async function fetch_status(
  port: unknown,
  host = "127.0.0.1",
  timeout = 2.0,
  fetcher: (() => unknown) | null = null,
): Promise<Snapshot> {
  if (fetcher !== null) {
    let data: unknown;
    try {
      data = fetcher();
    } catch (exc) {
      return new Snapshot(false, null, err_name(exc));
    }
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      return new Snapshot(true, data as Record<string, unknown>);
    }
    return new Snapshot(false, null, "响应不是 JSON 对象");
  }

  let port_num: number;
  try {
    // int(port) equivalent: None/"" raise in Python; Number() coercions that
    // NaN out raise here too. -1 stays numeric (connect fails naturally).
    if (port === null || port === "" || port === undefined ||
        typeof port === "boolean" || Number.isNaN(Number(port))) {
      // int("nope") / int(None) raise in Python; the same inputs raise here
      throw Object.assign(new Error("invalid port"), { name: "TypeError" });
    }
    port_num = Math.trunc(Number(port));
  } catch (exc) {
    return new Snapshot(false, null, err_name(exc));
  }

  return await new Promise<Snapshot>((resolve) => {
    let settled = false;
    const done = (s: Snapshot): void => {
      if (!settled) { settled = true; resolve(s); }
    };
    let req: http.ClientRequest | null = null;
    try {
      req = http.request(
        { host, port: port_num, path: STATUS_PATH, method: "GET" },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            try {
              if (res.statusCode !== 200) {
                done(new Snapshot(false, null, "HTTP " + res.statusCode));
                return;
              }
              const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                done(new Snapshot(false, null, "响应不是 JSON 对象"));
                return;
              }
              done(new Snapshot(true, parsed as Record<string, unknown>));
            } catch (exc) {
              done(new Snapshot(false, null, err_name(exc)));
            }
          });
          res.on("error", (exc) => done(new Snapshot(false, null, err_name(exc))));
        });
      req.setTimeout(Math.max(1, Number(timeout) * 1000), () => {
        req?.destroy(new TimeoutDotError());
      });
      req.on("timeout", () => done(new Snapshot(false, null, "TimeoutError")));
      req.on("error", (exc) => done(new Snapshot(false, null, err_name(exc))));
      req.end();
    } catch (exc) {
      done(new Snapshot(false, null, err_name(exc)));
    }
  });
}

// Marker used for the request-destroy path above; its name lands in the
// snapshot error like Python's socket.timeout would.
class TimeoutDotError extends Error {
  override name = "TimeoutError";
}
