// Test-only controller around the real app shell for browser E2E scenarios -
// the port of desktop/tests/e2e_app.py (ticket #206). It is started ONLY when
// YOUTUBESUB_E2E_MODE_PORT is set, and only in product mode; the harness uses
// it to flip display mode and swap provider config mid-test without touching
// the window. Everything it mutates is the live objects the Engine and the
// overlay already read on every tick, so changes land on the next beat.
//
// Wire contract (byte-compatible with e2e_app.py):
//   POST /mode     {"mode": "orig" | "trans" | "bilingual"} -> 202
//   POST /provider {"provider": {...}}                      -> 202
//   unknown path -> 404; unparseable body or invalid value -> 400.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface E2EControlDeps {
  // The Engine holds the live settings reference; e2e_app.py mutates
  // app.settings in place, so we mutate the same object.
  engine: { settings: Record<string, unknown> };
  display: { mode: string };
  pushPlan: () => void;
  log?: (msg: string) => void;
}

function section_of(settings: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = settings[key];
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    const fresh: Record<string, unknown> = {};
    settings[key] = fresh;
    return fresh;
  }
  return v as Record<string, unknown>;
}

const OVERLAY_MODES: readonly string[] = ["orig", "trans", "bilingual"];

function handlePost(
  deps: E2EControlDeps,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const path = (req.url ?? "").split("?")[0]!;
  if (path !== "/mode" && path !== "/provider") {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = "";
  req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
  req.on("end", () => {
    let value: unknown;
    try {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      if (path === "/mode") {
        value = parsed["mode"];
        if (typeof value !== "string" || !OVERLAY_MODES.includes(value)) {
          throw new Error("invalid mode");
        }
      } else {
        value = parsed["provider"];
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("invalid provider");
        }
      }
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    // e2e_app.py defers application through a 20ms QTimer; the TS main
    // process is single-threaded, so applying before the 202 is strictly
    // stronger and the status polls see it no later.
    if (path === "/mode") {
      const mode = value as string;
      section_of(deps.engine.settings, "display")["mode"] = mode;
      deps.display.mode = mode;
      deps.pushPlan();
      deps.log?.("[e2e] mode=" + mode);
    } else {
      const prov = section_of(deps.engine.settings, "provider");
      for (const k of Object.keys(prov)) delete prov[k];
      Object.assign(prov, value as Record<string, unknown>);
      deps.log?.("[e2e] provider updated");
    }
    res.writeHead(202);
    res.end();
  });
}

// Returns the bound port, or rejects when the env is not set (normal product
// runs never start this server). A bind failure rejects like the threading
// crash in e2e_app.py.
export function startE2EControl(deps: E2EControlDeps): Promise<number> {
  const raw = process.env.YOUTUBESUB_E2E_MODE_PORT;
  if (raw === undefined || raw === "") {
    return Promise.reject(new Error("YOUTUBESUB_E2E_MODE_PORT not set"));
  }
  const port = parseInt(raw, 10);
  let server: Server | null = null;
  try {
    server = createServer((req, res) => handlePost(deps, req, res));
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise<number>((resolve, reject) => {
    server!.once("error", (e: Error) => reject(e));
    server!.listen(port, "127.0.0.1", () => {
      resolve((server!.address() as AddressInfo).port);
    });
  });
}
