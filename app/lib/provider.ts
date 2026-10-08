// 1:1 port of desktop/suboverlay/provider.py - OpenAI-compatible translation
// client (ticket #202, map #181). Same public names as the Python module so
// the remaining Phase 1 tickets map one-to-one onto it.
//
// Designs absorbed from transly src/provider (MIT) via the Python module;
// added there: retries + exponential backoff + 429/Retry-After, proxy-aware
// transport, user-configurable system prompt.
//
// Registered port conversions (ticket #202):
// - urllib (respects HTTP(S)_PROXY, honors NO_PROXY) -> node:http/https with
//   the same semantics re-implemented in resolveProxy(): per-request env
//   read, urllib proxy_bypass_environment matching rule (host.endsWith(entry)
//   or (host + '.').endswith(entry + '.') after leading-dot strip), plus a
//   hard loopback bypass (CONTEXT.md fact: loopback never proxies). http
//   targets via proxy use absolute-form request-target; https targets
//   CONNECT-tunnel then TLS. No new dependencies.
// - Python OSError + _timed_out() message sniffing -> typed TransportError
//   {kind: "TIMEOUT" | "NETWORK"} thrown at the transport boundary; the
//   client maps kind -> the same message strings as _network_message.
// - urllib per-socket-op timeout -> one whole-exchange deadline (connect,
//   CONNECT/TLS, headers and body share a single timer budget).
// - urllib auto redirect-following -> GET follows up to 5 redirects; POST
//   does not follow (production endpoints never redirect; a 30x on POST
//   surfaces through map_status_error exactly like urllib's HTTPError did).
// - dict(resp.headers.items()) -> rawHeaders pairs, last-wins (same as
//   dict() on duplicate keys); retry_after_s still checks both casings.
// - monkeypatch.setattr(P, "_do_post", ...) -> injectable opts.post on
//   translate_group / translate_batch (default = the real transport).
//   time.sleep / time.time positional seams -> opts.sleep / opts.now.
// - str.isdigit() -> ASCII /^[0-9]+$/ (the N| protocol domain).
// - str.splitlines() -> split on CRLF | CR | LF.
// - int() truncation -> Math.trunc; time.monotonic() -> performance.now().
// - translate_group never raises for provider failures (transport
//   rejections become error results); translate_batch keeps the Python bare
//   transport call - transport rejections propagate (the engine wraps it).
// - the dead "if False else" leftover in the Python step-2 timing line is
//   dropped (effective behavior kept: int(elapsed seconds * 1000)).
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

export const REQUEST_TIMEOUT_S = 60.0;
export const MODELS_TIMEOUT_S = 15.0;
export const MAX_RETRIES = 3;
export const BACKOFF_BASE_S = 1.0;
export const MAX_BODY_ERR_CHARS = 4000;
export const DEFAULT_SYSTEM_PROMPT =
  "You are a subtitle translator. Translate the user's text into Chinese.";

export class ProviderError extends Error {
  code: string;
  status: number | null;
  retryable: boolean;
  constructor(code: string, message: string, status: number | null = null,
              retryable = false) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export class TransportError extends Error {
  kind: "TIMEOUT" | "NETWORK";
  constructor(kind: "TIMEOUT" | "NETWORK", message: string) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
  }
}

// cfg access: Python reads a loose dict with `.get(key) or default`. Any
// settings-shaped record must be accepted, so keys stay `unknown` readers.
export interface ProviderConfig {
  base_url?: unknown;
  api_key?: unknown;
  model?: unknown;
  protocol?: unknown;
  timeout_s?: unknown;
  max_retries?: unknown;
  system?: unknown;
  [key: string]: unknown;
}

function sval(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

// ---------------------------------------------------------------------
// Endpoint / body shaping
// ---------------------------------------------------------------------

export type ProviderProtocol = "responses" | "chat-completions";

export function coerce_endpoint(base_url: unknown, protocol: unknown):
    [string, ProviderProtocol] {
  const base = sval(base_url).trim().replace(/\/+$/, "");
  if (!base) throw new ProviderError("BAD_CONFIG", "Base URL is empty");
  if (!base.includes("://")) {
    throw new ProviderError("BAD_CONFIG", "Base URL must be absolute http(s) URL");
  }
  const scheme = base.split("://")[0]!.toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    throw new ProviderError("BAD_CONFIG", "Base URL must be http(s)");
  }
  let p = (sval(protocol) || "auto").trim().toLowerCase() || "auto";
  if (p === "auto") {
    p = base.endsWith("/chat/completions") ? "chat-completions" : "responses";
  }
  if (p === "chat-completions") {
    if (base.endsWith("/responses")) {
      return [base.slice(0, -"/responses".length) + "/chat/completions", "chat-completions"];
    }
    if (!base.endsWith("/chat/completions")) {
      return [base + "/chat/completions", "chat-completions"];
    }
  } else if (p === "responses") {
    if (base.endsWith("/chat/completions")) {
      return [base.slice(0, -"/chat/completions".length) + "/responses", "responses"];
    }
    if (!base.endsWith("/responses")) {
      return [base + "/responses", "responses"];
    }
  } else {
    throw new ProviderError("BAD_CONFIG", "Unknown protocol: " + String(protocol));
  }
  return [base, p as ProviderProtocol];
}

export function models_endpoint(action_endpoint: string): string {
  for (const suffix of ["/chat/completions", "/responses"]) {
    if (action_endpoint.endsWith(suffix)) {
      return action_endpoint.slice(0, -suffix.length) + "/models";
    }
  }
  return action_endpoint.replace(/\/+$/, "") + "/models";
}

export function build_body(protocol: string, model: string, instructions: string,
                           prompt: string, stream = false): Record<string, unknown> {
  if (protocol === "chat-completions") {
    return { model, stream,
             messages: [{ role: "system", content: instructions },
                        { role: "user", content: prompt }] };
  }
  return { model, store: false, stream, instructions,
           input: [{ role: "user",
                     content: [{ type: "input_text", text: prompt }] }] };
}

export function extract_complete_text(protocol: string, body: unknown): string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ProviderError("INVALID_MODEL_OUTPUT", "Response body is not an object");
  }
  const rec = body as Record<string, unknown>;
  if (protocol === "chat-completions") {
    // body["choices"][0]["message"]["content"] under try/except -> null.
    const choices = Array.isArray(rec["choices"]) ? rec["choices"] as unknown[] : [];
    const first = choices.length > 0 ? choices[0] : null;
    const messageObj = first !== null && typeof first === "object"
      ? (first as Record<string, unknown>)["message"] : null;
    const raw = messageObj !== null && typeof messageObj === "object"
      ? (messageObj as Record<string, unknown>)["content"] : null;
    let content: unknown = raw === undefined ? null : raw;
    if (Array.isArray(content)) {
      content = (content as unknown[])
        .map(p => p !== null && typeof p === "object"
          ? String((p as Record<string, unknown>)["text"] ?? "")
          : "")
        .join("");
    }
    if (typeof content === "string" && content) return content;
  } else {
    if (typeof rec["output_text"] === "string" && rec["output_text"]) {
      return rec["output_text"];
    }
    const chunks: string[] = [];
    const output = Array.isArray(rec["output"]) ? rec["output"] as unknown[] : [];
    for (const item of output) {
      if (item === null || typeof item !== "object") continue;
      const itemContent = (item as Record<string, unknown>)["content"];
      const parts = Array.isArray(itemContent) ? itemContent as unknown[] : [];
      for (const part of parts) {
        if (part !== null && typeof part === "object" &&
            (part as Record<string, unknown>)["type"] === "output_text") {
          chunks.push(String((part as Record<string, unknown>)["text"] ?? ""));
        }
      }
    }
    if (chunks.length > 0) return chunks.join("");
  }
  throw new ProviderError("INVALID_MODEL_OUTPUT", "Response carried no text");
}

// ---------------------------------------------------------------------
// Aligned (N|line) protocol
// ---------------------------------------------------------------------

function strip_fence(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    const nl = t.indexOf("\n");
    t = nl !== -1 ? t.slice(nl + 1) : "";
    const end = t.lastIndexOf("\u0060\u0060\u0060");
    if (end !== -1) t = t.slice(0, end);
  }
  return t.trim();
}

export function unpack_numbered(raw: unknown, expected_n: number): string[] | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const lines = strip_fence(raw).split(/\r\n|\r|\n/);
  const vals = new Map<number, string>();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || !line.includes("|")) continue;
    const sep = line.indexOf("|");
    const head = line.slice(0, sep).trim();
    if (!/^[0-9]+$/.test(head)) continue;
    const i = Number(head);
    const body = line.slice(sep + 1).trim();
    if (i < 1 || i > expected_n || !body || vals.has(i)) return null;
    vals.set(i, body);
  }
  if (vals.size !== expected_n) return null;
  const out: string[] = [];
  for (let i = 1; i <= expected_n; i++) out.push(vals.get(i)!);
  return out;
}

export function map_status_error(status: number, body_text: unknown): ProviderError {
  const snippet = String(body_text ?? "").split(/\s+/).filter(Boolean).join(" ")
    .slice(0, 500);
  if (status === 401) return new ProviderError("AUTH", "401 unauthorized", status);
  if (status === 403) return new ProviderError("FORBIDDEN", "403 forbidden", status);
  if (status === 402 || status === 429) {
    return new ProviderError("RATE_LIMITED", String(status) + " rate limited: " + snippet,
                             status, true);
  }
  if (status >= 500) {
    return new ProviderError("SERVER", String(status) + " server error", status, true);
  }
  return new ProviderError("BAD_REQUEST", String(status) + ": " + snippet, status);
}

// ---------------------------------------------------------------------
// System prompt assembly (byte-pinned wording - feeds the cache identity,
// ADR-010 / issue #39; changing it forks every cache row)
// ---------------------------------------------------------------------

export function build_instructions(preset_text: unknown, context_prev = "",
                                   context_next = "", expected_lines = 0): string {
  let instructions = sval(preset_text) || DEFAULT_SYSTEM_PROMPT;
  if (context_prev || context_next) {
    const ctx: string[] = [];
    if (context_prev) {
      ctx.push("Previous line (context only, do not translate): " + context_prev);
    }
    if (context_next) {
      ctx.push("Next line (context only, do not translate): " + context_next);
    }
    instructions = instructions + "\n" + ctx.join("\n");
  }
  if (expected_lines > 1) {
    instructions = instructions + "\n" + (
      "The input is one sentence split into " + expected_lines +
      " subtitle lines. Translate the whole sentence, then output exactly " +
      expected_lines + " lines in format 'N|translation' (N=1.." +
      expected_lines + ") matching the original line breaks. No other text.");
  }
  return instructions;
}

// ---------------------------------------------------------------------
// Proxy-aware transport (urllib semantics re-implemented, zero deps)
// ---------------------------------------------------------------------

export interface PostResult {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

export type DoPost =
  (url: string, headers: Record<string, string>, payload: unknown, timeoutS: number) =>
    Promise<PostResult>;

// urllib proxy_bypass_environment rule + the hard loopback bypass.
export function resolveProxy(target: URL): URL | null {
  const host = target.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]" ||
      host === "::1" || /^127\./.test(host)) {
    return null;
  }
  const noProxy = String(process.env.NO_PROXY ?? process.env.no_proxy ?? "").trim();
  if (noProxy === "*") return null;
  if (noProxy) {
    for (const rawEntry of noProxy.split(",")) {
      let name = rawEntry.trim().toLowerCase();
      if (!name) continue;
      name = name.replace(/^\.+/, "");
      if (host.endsWith(name) || (host + ".").endsWith(name + ".")) return null;
    }
  }
  const envName = target.protocol === "https:" ? "HTTPS_PROXY" : "HTTP_PROXY";
  const raw = String(process.env[envName] ?? process.env[envName.toLowerCase()] ?? "").trim();
  if (!raw) return null;
  try {
    return new URL(raw.includes("://") ? raw : "http://" + raw);
  } catch {
    return null;
  }
}

function collectHeaders(raw: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < raw.length; i += 2) out[raw[i]!] = raw[i + 1]!;
  return out;
}

interface Watchdog {
  arm(onFire: (err: TransportError) => void): void;
  disarm(): void;
}

function makeWatchdog(timeoutS: number): Watchdog {
  const deadlineAt = Date.now() + timeoutS * 1000;
  let timer: NodeJS.Timeout | null = null;
  return {
    arm(onFire) {
      this.disarm();
      const remaining = deadlineAt - Date.now();
      timer = setTimeout(
        () => onFire(new TransportError("TIMEOUT", "deadline exceeded after " + timeoutS + "s")),
        Math.max(1, remaining));
    },
    disarm() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

interface ExchangeOptions {
  method: string;
  target: URL;
  headers: Record<string, string>;
  body: Buffer | null;
  timeoutS: number;
}

function sendRequest(opts: ExchangeOptions,
                     t: { host: string; port: number; path: string;
                          extraHeaders?: Record<string, string> | undefined;
                          createConnection?: () => unknown },
                     wd: Watchdog): Promise<PostResult> {
  const mod = (opts.target.protocol === "https:" ? https : http) as typeof http;
  return new Promise<PostResult>((resolve, reject) => {
    let settled = false;
    const settle = (err: unknown, val?: PostResult) => {
      if (settled) return;
      settled = true;
      wd.disarm();
      if (err !== null && err !== undefined) reject(err);
      else resolve(val!);
    };
    const requestInit: https.RequestOptions = {
      method: opts.method,
      host: t.host,
      port: t.port,
      path: t.path,
      headers: { ...opts.headers, ...t.extraHeaders },
    };
    if (t.createConnection !== undefined) {
      requestInit.createConnection = t.createConnection as never;
    }
    const req = mod.request(requestInit, (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", (e: Error) =>
        settle(new TransportError("NETWORK", String(e.message ?? e))));
      res.on("end", () => settle(null, {
        status: res.statusCode ?? 0,
        headers: collectHeaders(res.rawHeaders),
        bodyText: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", (e) => {
      if (e instanceof TransportError) settle(e);
      else settle(new TransportError("NETWORK", String((e as Error).message ?? e)));
    });
    wd.arm((err) => {
      req.destroy(err);
    });
    if (opts.body !== null) req.write(opts.body);
    req.end();
  });
}

function connectTunnel(proxy: URL, target: URL, wd: Watchdog): Promise<tls.TLSSocket> {
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const port = Number(target.port || 443);
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    let settled = false;
    const settle = (err: unknown, val?: tls.TLSSocket) => {
      if (settled) return;
      settled = true;
      wd.disarm();
      if (err !== null && err !== undefined) reject(err);
      else resolve(val!);
    };
    const creq = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: "CONNECT",
      path: host + ":" + port,
      headers: { host: host + ":" + port },
    });
    creq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        settle(new TransportError("NETWORK", "proxy CONNECT failed with HTTP " + res.statusCode));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: host }, () => settle(null, tlsSocket));
      tlsSocket.once("error", (e: Error) =>
        settle(new TransportError("NETWORK", String(e.message ?? e))));
    });
    creq.on("error", (e) => {
      if (e instanceof TransportError) settle(e);
      else settle(new TransportError("NETWORK", String((e as Error).message ?? e)));
    });
    wd.arm((err) => {
      creq.destroy(err);
    });
    creq.end();
  });
}

async function exchange(opts: ExchangeOptions): Promise<PostResult> {
  const wd = makeWatchdog(opts.timeoutS);
  try {
    const proxy = resolveProxy(opts.target);
    if (proxy !== null && opts.target.protocol === "https:") {
      const socket = await connectTunnel(proxy, opts.target, wd);
      try {
        return await sendRequest(opts, {
          host: opts.target.hostname.replace(/^\[|\]$/g, ""),
          port: Number(opts.target.port || 443),
          path: opts.target.pathname + opts.target.search,
          createConnection: () => socket,
        }, wd);
      } finally {
        socket.destroy();
      }
    }
    // Direct, or http-target via proxy (absolute-form request-target).
    const viaProxyHttp = proxy !== null && opts.target.protocol === "http:";
    const host = viaProxyHttp ? proxy.hostname : opts.target.hostname.replace(/^\[|\]$/g, "");
    const port = viaProxyHttp
      ? Number(proxy.port || 80)
      : Number(opts.target.port || (opts.target.protocol === "https:" ? 443 : 80));
    const path = viaProxyHttp ? opts.target.href : opts.target.pathname + opts.target.search;
    const extraHeaders = viaProxyHttp ? { host: opts.target.host } : undefined;
    return await sendRequest(opts, {
      host, port, path,
      ...(extraHeaders !== undefined ? { extraHeaders } : {}),
    }, wd);
  } finally {
    wd.disarm();
  }
}

// The _do_post seam: HTTP statuses (including errors) resolve with
// (status, headers, body); only network-level failures reject, typed.
// Error-body detail is truncated to MAX_BODY_ERR_CHARS like urllib's
// HTTPError read.
export const doPost: DoPost = async (url, headers, payload, timeoutS) => {
  const target = new URL(url);
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const hdrs: Record<string, string> = { ...headers };
  if (hdrs["Content-Length"] === undefined && hdrs["content-length"] === undefined) {
    hdrs["Content-Length"] = String(body.length);
  }
  const result = await exchange({ method: "POST", target, headers: hdrs, body, timeoutS });
  if (result.status < 200 || result.status >= 300) {
    result.bodyText = result.bodyText.slice(0, MAX_BODY_ERR_CHARS);
  }
  return result;
};

async function fetchFollowingRedirects(url: string, headers: Record<string, string>,
                                       timeoutS: number): Promise<PostResult> {
  let current = new URL(url);
  for (let hops = 0; ; hops++) {
    const r = await exchange({ method: "GET", target: current, headers, body: null, timeoutS });
    if (hops < 5 && (r.status === 301 || r.status === 302 || r.status === 303 ||
                     r.status === 307 || r.status === 308)) {
      const loc = r.headers["Location"] ?? r.headers["location"];
      if (loc) {
        current = new URL(loc, current);
        continue;
      }
    }
    return r;
  }
}

function build_headers(api_key: unknown): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  const key = sval(api_key);
  if (key) h["Authorization"] = "Bearer " + key;
  return h;
}

function retry_after_s(headers: Record<string, string> | null): number | null {
  const raw = headers ? (headers["Retry-After"] || headers["retry-after"]) : null;
  if (raw === null || raw === undefined || raw === "") return null;
  const f = Number(raw);
  if (!Number.isFinite(f)) return null;
  return Math.max(0.0, f);
}

// ---------------------------------------------------------------------
// Translation calls (never raise for provider failures)
// ---------------------------------------------------------------------

export interface GroupResult {
  aligned?: boolean;
  values?: string[];
  text?: string;
  error: string | null;
  message?: string | null;
  // present on translate_group results; Python batch results carry no
  // attempts key (all-or-nothing slices), so it stays optional here too.
  attempts?: number;
  status?: number;
}

export interface TranslateOpts {
  sleep?: (seconds: number) => Promise<void> | void;
  now?: () => number;
  post?: DoPost;
}

const defaultSleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

function network_message(kind: "TIMEOUT" | "NETWORK", detail: string, timeoutS: number): string {
  if (kind === "TIMEOUT") {
    return "timed out after " + timeoutS + "s waiting for the endpoint";
  }
  return "connection failed: " + detail.slice(0, 300);
}

export async function translate_group(cfg: ProviderConfig, group_text: string,
                                      context_prev = "", context_next = "",
                                      expected_lines = 0,
                                      opts: TranslateOpts = {}): Promise<GroupResult> {
  const doPostFn = opts.post ?? doPost;
  const sleepFn = opts.sleep ?? defaultSleep;
  const model = sval(cfg.model).trim();
  if (!model) return { error: "NO_MODEL", message: null, attempts: 0 };
  let endpoint: string;
  let protocol: ProviderProtocol;
  try {
    [endpoint, protocol] = coerce_endpoint(cfg.base_url, cfg.protocol);
  } catch (e) {
    if (e instanceof ProviderError) {
      return { error: e.code, message: e.message, attempts: 0 };
    }
    throw e;
  }
  const instructions = build_instructions(cfg.system, context_prev, context_next,
                                          expected_lines);
  const prompt = group_text;
  const body = build_body(protocol, model, instructions, prompt, false);
  const timeoutS = cfg.timeout_s ? Number(cfg.timeout_s) : REQUEST_TIMEOUT_S;
  const maxRetries = cfg.max_retries == null
    ? MAX_RETRIES
    : Math.trunc(Number(cfg.max_retries));
  const headers = build_headers(cfg.api_key);

  let lastErr: ProviderError | null = null;
  let ra: number | null = null;
  let attempts = 0;
  let status: number | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let rh: Record<string, string> | null = null;
    try {
      const r = await doPostFn(endpoint, headers, body, timeoutS);
      status = r.status;
      rh = r.headers;
      attempts += 1;
      if (status === 200) {
        let out: string | null = null;
        try {
          out = extract_complete_text(protocol, JSON.parse(r.bodyText));
        } catch (e) {
          if (e instanceof ProviderError) {
            lastErr = e;
          } else {
            lastErr = new ProviderError("INVALID_MODEL_OUTPUT", "response is not JSON");
          }
        }
        if (lastErr === null && out !== null) {
          if (expected_lines > 1) {
            const vals = unpack_numbered(out, expected_lines);
            if (vals !== null) {
              return { aligned: true, values: vals, error: null, attempts };
            }
            // shape miss: caller degrades to whole-line, no re-ask
            lastErr = new ProviderError("SHAPE_MISS", "aligned output count mismatch");
            break;
          }
          return { aligned: false, text: out.trim(), error: null, attempts };
        }
      } else {
        lastErr = map_status_error(status, r.bodyText);
        ra = retry_after_s(rh);
      }
    } catch (e) {
      // Python catches OSError only; non-transport rejections propagate.
      if (!(e instanceof TransportError)) throw e;
      attempts += 1;
      // A timeout is transient (retried like a 5xx); a refused/reset
      // connection fails fast with its real cause (#23 decision 14).
      const kind = e.kind;
      lastErr = new ProviderError(kind, network_message(kind, e.message, timeoutS),
                                  null, kind === "TIMEOUT");
      status = null;
    }
    if (lastErr === null || !lastErr.retryable) break;
    if (attempt < maxRetries) {
      let delay: number;
      if (status !== null && (status === 402 || status === 429)) {
        ra = retry_after_s(rh);
        delay = ra !== null ? ra : BACKOFF_BASE_S * 2 ** attempt;
      } else {
        delay = BACKOFF_BASE_S * 2 ** attempt;
      }
      await sleepFn(Math.min(delay, 30.0));
    }
  }
  const code = lastErr !== null ? lastErr.code : "UNKNOWN";
  let message: string | null = lastErr !== null ? lastErr.message : null;
  if (code === "RATE_LIMITED" && ra !== null) {
    // the server's own wait time travels with the verdict (user story 9)
    message = message + " (server asked to retry after " + ra + "s)";
  }
  const result: GroupResult = { error: code, message, attempts };
  if (status !== null) {
    // Preserve final HTTP status for fixed 402/429 user-facing mapping.
    result.status = status;
  }
  return result;
}

export function slice_numbered_batch(raw: unknown, counts: number[]): string[][] | null {
  if (!counts || counts.length === 0 || counts.some(c => Math.trunc(c) < 1)) return null;
  const vals = unpack_numbered(raw, counts.reduce((a, c) => a + Math.trunc(c), 0));
  if (vals === null) return null;
  const out: string[][] = [];
  let i = 0;
  for (const c of counts) {
    out.push(vals.slice(i, i + Math.trunc(c)));
    i += Math.trunc(c);
  }
  return out;
}

function batch_prompt(items: readonly Record<string, unknown>[]): string {
  const sections: string[] = [];
  let i = 1;
  for (const it of items) {
    const expected = Math.max(1, Math.trunc(Number(it["expected"] ?? 0) || 1));
    sections.push("Sentence " + i + " (" + expected + " lines):\n" + sval(it["text"]));
    i += 1;
  }
  return sections.join("\n");
}

function batch_instructions(base: unknown, items: readonly Record<string, unknown>[],
                            counts: readonly number[]): string {
  const parts: string[] = [sval(base) || DEFAULT_SYSTEM_PROMPT];
  let i = 1;
  for (const it of items) {
    const ctx: string[] = [];
    const prev = sval(it["prev"]);
    const nxt = sval(it["nxt"]);
    if (prev) ctx.push("Previous line (context only, do not translate): " + prev);
    if (nxt) ctx.push("Next line (context only, do not translate): " + nxt);
    if (ctx.length > 0) {
      parts.push("Context for sentence " + i + ":\n" + ctx.join("\n"));
    }
    i += 1;
  }
  const total = counts.reduce((a, c) => a + c, 0);
  parts.push(
    "The input contains " + items.length + " sentences; sentence i has the number " +
    "of subtitle lines announced above. Translate every sentence. Output exactly " +
    total + " lines in format 'N|translation' (N=1.." + total +
    ") covering the subtitle lines of all sentences in order. No other text.");
  return parts.join("\n");
}

export async function translate_batch(cfg: ProviderConfig,
                                      items: readonly Record<string, unknown>[],
                                      opts: TranslateOpts = {}): Promise<GroupResult[]> {
  const doPostFn = opts.post ?? doPost;
  const sleepFn = opts.sleep ?? defaultSleep;
  const counts = items.map(it => Math.max(1, Math.trunc(Number(it["expected"] ?? 0) || 1)));

  const failed = (code: string, message: string | null = null,
                  status?: number): GroupResult[] => {
    const base: GroupResult = { aligned: false, text: "", error: code, message };
    if (status !== undefined) base.status = status;
    return items.map(() => ({ ...base }));
  };

  if (items.length === 0) return [];
  const model = sval(cfg.model).trim();
  if (!model) return failed("NO_MODEL");
  let endpoint: string;
  let protocol: ProviderProtocol;
  try {
    [endpoint, protocol] = coerce_endpoint(cfg.base_url, cfg.protocol);
  } catch (e) {
    if (e instanceof ProviderError) return failed(e.code, e.message);
    throw e;
  }
  const instructions = batch_instructions(cfg.system ?? DEFAULT_SYSTEM_PROMPT, items, counts);
  const prompt = batch_prompt(items);
  const body = build_body(protocol, model, instructions, prompt, false);
  const timeoutS = cfg.timeout_s ? Number(cfg.timeout_s) : REQUEST_TIMEOUT_S;
  const maxRetries = cfg.max_retries == null
    ? MAX_RETRIES
    : Math.trunc(Number(cfg.max_retries));
  const headers = build_headers(cfg.api_key);

  // Transport-level retries/backoff (429/5xx) are shared with
  // translate_group; they are wire errors, not contract failures. The bare
  // transport call mirrors the Python source: transport rejections
  // propagate out of the batch path (the engine wraps it).
  let lastErr: ProviderError | null = null;
  let status: number | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let rh: Record<string, string> | null = null;
    const r = await doPostFn(endpoint, headers, body, timeoutS);
    status = r.status;
    rh = r.headers;
    if (status === 200) {
      let out: string | null = null;
      try {
        out = extract_complete_text(protocol, JSON.parse(r.bodyText));
      } catch (e) {
        if (e instanceof ProviderError) {
          lastErr = e;
        } else {
          lastErr = new ProviderError("INVALID_MODEL_OUTPUT", "response is not JSON");
        }
      }
      if (lastErr === null && out !== null) {
        const sliced = slice_numbered_batch(out, counts);
        if (sliced === null) {
          // Contract miss: whole batch void, no retry / no split.
          return failed("SHAPE_MISS", "batch output does not exactly cover 1..T");
        }
        return sliced.map(v => ({ aligned: true, values: v, error: null }));
      }
    } else {
      lastErr = map_status_error(status, r.bodyText);
    }
    if (lastErr === null || !lastErr.retryable) break;
    if (attempt < maxRetries) {
      let delay: number;
      if (status !== 200 && (status === 402 || status === 429)) {
        const ra = retry_after_s(rh);
        delay = ra !== null ? ra : BACKOFF_BASE_S * 2 ** attempt;
      } else {
        delay = BACKOFF_BASE_S * 2 ** attempt;
      }
      await sleepFn(Math.min(delay, 30.0));
    }
  }
  const code = lastErr !== null ? lastErr.code : "UNKNOWN";
  return failed(code, lastErr !== null ? lastErr.message : null, status ?? undefined);
}

export async function list_models(cfg: ProviderConfig,
                                  timeoutS = MODELS_TIMEOUT_S): Promise<[string[], string | null]> {
  let endpoint: string;
  let protocol: ProviderProtocol;
  try {
    [endpoint, protocol] = coerce_endpoint(cfg.base_url, cfg.protocol);
  } catch (e) {
    if (e instanceof ProviderError) return [[], e.code];
    throw e;
  }
  const url = models_endpoint(endpoint);
  let body: unknown;
  try {
    const r = await fetchFollowingRedirects(url, build_headers(cfg.api_key), timeoutS);
    if (r.status < 200 || r.status >= 300) return [[], "HTTP_" + String(r.status)];
    try {
      body = JSON.parse(r.bodyText);
    } catch {
      // answered (2xx) but not a model list: reachable, nothing to check
      // membership against - the step-1 "list unavailable" observation (#23)
      return [[], "INVALID_MODEL_OUTPUT"];
    }
  } catch (e) {
    if (e instanceof TransportError) return [[], e.kind];
    return [[], "NETWORK"];
  }
  let items: unknown = null;
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const rec = body as Record<string, unknown>;
    if (Array.isArray(rec["data"])) items = rec["data"];
    else if (Array.isArray(rec["models"])) items = rec["models"];
  }
  const ids: string[] = [];
  for (const it of Array.isArray(items) ? items as unknown[] : []) {
    let mid: unknown = null;
    if (typeof it === "string") mid = it;
    else if (it !== null && typeof it === "object") {
      const rec = it as Record<string, unknown>;
      mid = rec["id"] || rec["name"];
    }
    if (typeof mid === "string" && mid.trim() && !ids.includes(mid)) {
      ids.push(mid.trim());
    }
  }
  return [ids, null];
}
