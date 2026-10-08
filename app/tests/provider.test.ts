// 1:1 port of the provider assertions in desktop/tests/test_provider_and_queue.py
// (ticket #202, map #181). The cache/queue tests in that pytest file belong to
// ticket #201 (already ported in tests/queue-cache.test.ts) and the settings
// redaction test to #199; they are intentionally NOT here. Every provider
// pytest test function maps to exactly one test() below; assertions are
// converted assertion-for-assertion (equivalence criteria #1, #191).
// Registered behavior conversions (criteria #2):
//   - monkeypatch.setattr(P, "_do_post", fake) -> opts.post injection (the
//     default transport stays the real proxy-aware doPost).
//   - monkeypatch.setenv(...) -> direct process.env write with finally
//     restore (same NO_PROXY values, same bypass semantics).
//   - fake_post returns (402, {}, text) -> async () => PostResult.
//   - P.coerce_endpoint tuple -> destructured [endpoint, protocol].
//   - P.map_status_error(...).retryable -> field read on the error object.
//   - test_translate_group_blackhole_reports_timeout: the real blackhole
//     address 10.255.255.1 is not CI-deterministic (routability depends on
//     the runner network; a fast ICMP unreachable would flip the code to
//     NETWORK). CI-deterministic stand-in: a local server that accepts and
//     never answers - connect succeeds, no response ever arrives, the
//     whole-exchange deadline fires TIMEOUT. Same asserted outcome
//     (error == TIMEOUT, attempts == 1), deterministic fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import * as P from "../lib/provider.ts";

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

test("coerce_endpoint auto and rewrite", () => {
  let [ep, pr] = P.coerce_endpoint("https://api.deepseek.com", "auto");
  assert.equal(ep, "https://api.deepseek.com/responses");
  assert.equal(pr, "responses");
  [ep, pr] = P.coerce_endpoint("https://o.ai/v1/chat/completions", "auto");
  assert.ok(ep.endsWith("/v1/chat/completions"));
  assert.equal(pr, "chat-completions");
  [ep, pr] = P.coerce_endpoint("https://x.com/a/responses", "chat-completions");
  assert.equal(ep, "https://x.com/a/chat/completions");
  [ep, pr] = P.coerce_endpoint("https://x.com/v1", "responses");
  assert.equal(ep, "https://x.com/v1/responses");
});

test("coerce_endpoint rejects bad", () => {
  for (const bad of ["", "ftp://x", "notaurl", null]) {
    assert.throws(() => P.coerce_endpoint(bad, "auto"), P.ProviderError);
  }
  assert.throws(() => P.coerce_endpoint("https://x.com", "weird"), P.ProviderError);
});

test("unpack_numbered all-or-nothing", () => {
  assert.deepEqual(P.unpack_numbered("1|hello\n2|world", 2), ["hello", "world"]);
  assert.deepEqual(P.unpack_numbered("\u0060\u0060\u0060json\n1|a\n2|b\n\u0060\u0060\u0060", 2), ["a", "b"]);
  assert.equal(P.unpack_numbered("1|a\n3|b", 2), null);
  assert.equal(P.unpack_numbered("1|a\n1|b", 2), null);
  assert.equal(P.unpack_numbered("1|a", 2), null);
  assert.equal(P.unpack_numbered("1|a\n2|", 2), null);
  assert.equal(P.unpack_numbered("", 1), null);
  assert.equal(P.unpack_numbered("just text", 1), null);
});

test("map_status_error retryable", () => {
  assert.equal(P.map_status_error(429, "x").retryable, true);
  assert.equal(P.map_status_error(500, "x").retryable, true);
  assert.equal(P.map_status_error(401, "x").retryable, false);
  assert.equal(P.map_status_error(400, "x").retryable, false);
});

test("provider results preserve http status without exposing it as text", async () => {
  const fakePost = async (): Promise<P.PostResult> =>
    ({ status: 402, headers: {}, bodyText: "secret provider detail" });
  const cfg = { base_url: "https://api.example.test/v1", api_key: "k",
                model: "m", protocol: "responses", max_retries: 0 };
  const single = await P.translate_group(cfg, "hello", "", "", 0, { post: fakePost });
  const batch = await P.translate_batch(cfg, [{ text: "hello", expected: 1 }],
                                        { post: fakePost });
  assert.equal(single.error, "RATE_LIMITED");
  assert.equal(single.status, 402);
  assert.equal(batch[0]!.error, "RATE_LIMITED");
  assert.equal(batch[0]!.status, 402);
  assert.ok(single.message!.includes("secret provider detail"));
  assert.ok(batch[0]!.message!.includes("secret provider detail"));
});

test("extract_complete_text both protocols", () => {
  const chat = { choices: [{ message: { content: "hi" } }] };
  const resp = { output_text: "yo" };
  const resp2 = { output: [{ content: [{ type: "output_text", text: "a" }, { type: "x" }] }] };
  assert.equal(P.extract_complete_text("chat-completions", chat), "hi");
  assert.equal(P.extract_complete_text("responses", resp), "yo");
  assert.equal(P.extract_complete_text("responses", resp2), "a");
  assert.throws(() => P.extract_complete_text("chat-completions", { nope: 1 }),
                P.ProviderError);
});

test("slice_numbered_batch requires exact full coverage", () => {
  // Decision 7/8: globally continuous numbering 1..T with EXACT full
  // coverage - the same all-or-nothing semantics as the single aligned
  // protocol. Anything else voids the whole batch; missing lines are never
  // patched in.
  const nl = "\n";
  const counts = [2, 1, 3];
  const full = ["1|甲", "2|乙", "3|丙", "4|丁", "5|戊", "6|己"].join(nl);
  const want = [["甲", "乙"], ["丙"], ["丁", "戊", "己"]];
  assert.deepEqual(P.slice_numbered_batch(full, counts), want);
  const fenced = "\u0060\u0060\u0060json" + nl + full + nl + "\u0060\u0060\u0060";
  assert.deepEqual(P.slice_numbered_batch(fenced, counts), want);
  // dropped line + re-numbered contiguously: text cannot reveal the loss
  const renumbered = ["1|甲", "2|乙", "3|丙", "4|丁", "5|戊"].join(nl);
  assert.equal(P.slice_numbered_batch(renumbered, counts), null);
  // gap in the numbering
  const gapped = ["1|甲", "2|乙", "3|丙", "4|丁", "6|己"].join(nl);
  assert.equal(P.slice_numbered_batch(gapped, counts), null);
  // duplicate number
  const dup = ["1|甲", "2|乙", "3|丙", "4|丁", "4|戊", "6|己"].join(nl);
  assert.equal(P.slice_numbered_batch(dup, counts), null);
  // empty translation body
  const emptyBody = ["1|甲", "2|乙", "3|丙", "4|", "5|戊", "6|己"].join(nl);
  assert.equal(P.slice_numbered_batch(emptyBody, counts), null);
  // one line MORE than T (contiguous, looks perfectly valid)
  const over = ["1|甲", "2|乙", "3|丙", "4|丁", "5|戊", "6|己"].join(nl);
  assert.equal(P.slice_numbered_batch(over, [2, 1, 2]), null); // T=5, got 6 lines
  // number beyond T
  const extra = ["1|甲", "2|乙", "3|丙", "4|丁", "5|戊", "7|庚"].join(nl);
  assert.equal(P.slice_numbered_batch(extra, counts), null);
  // nonsense counts never validate
  assert.equal(P.slice_numbered_batch(full, []), null);
  assert.equal(P.slice_numbered_batch(full, [0, 3, 3]), null);
});

// ---- seam 3 (#23): the client against REAL bad addresses never raises ----
// Old bug (decision 14): a refused connection or read timeout escaped the
// client as a raw URLError and surfaced to the user as an internal WORKER
// error. Real closed port + a deterministic no-answer endpoint, no patching.

const BAD_REFUSED = "http://127.0.0.1:9/v1";

function netCfg(base: string, timeout = 2.0): P.ProviderConfig {
  return { base_url: base, api_key: "x", model: "m", protocol: "auto",
           timeout_s: timeout, max_retries: 0, system: "t" };
}

test("translate_group refused port reports NETWORK and never raises", async () => {
  const prev = process.env.NO_PROXY;
  process.env.NO_PROXY = "localhost,127.0.0.1,::1";
  try {
    const r = await P.translate_group(netCfg(BAD_REFUSED, 3.0), "hello");
    assert.equal(r.error, "NETWORK");
    assert.equal(r.attempts, 1);
  } finally {
    restoreEnv("NO_PROXY", prev);
  }
});

test("translate_group reports TIMEOUT when the endpoint never answers", async () => {
  // Pytest fixture: real blackhole 10.255.255.1 (see header conversion note).
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {}); // accept and stall: never write, never end
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const r = await P.translate_group(netCfg("http://127.0.0.1:" + port + "/v1", 2.0), "hello");
    assert.equal(r.error, "TIMEOUT");
    assert.equal(r.attempts, 1);
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
});

test("translate_group local static short-circuits without attempts", async () => {
  let r = await P.translate_group(netCfg("ftp://x/v1"), "hello");
  assert.equal(r.error, "BAD_CONFIG");
  assert.equal(r.attempts, 0);
  r = await P.translate_group({ ...netCfg(BAD_REFUSED), model: "" }, "hello");
  assert.equal(r.error, "NO_MODEL");
  assert.equal(r.attempts, 0);
});

test("list_models reports network and timeout codes", async () => {
  const prev = process.env.NO_PROXY;
  process.env.NO_PROXY = "localhost,127.0.0.1,::1";
  try {
    const refused = await P.list_models(netCfg(BAD_REFUSED), 3.0);
    assert.deepEqual(refused[0], []);
    assert.equal(refused[1], "NETWORK");
  } finally {
    restoreEnv("NO_PROXY", prev);
  }
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {}); // stalling no-answer fixture
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const timedOut = await P.list_models(netCfg("http://127.0.0.1:" + port + "/v1"), 2.0);
    assert.deepEqual(timedOut[0], []);
    assert.equal(timedOut[1], "TIMEOUT");
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
});

async function captureWire(protocol: string, cur: string, prev = "", nxt = "",
                           system = "BASE PROMPT"): Promise<[string, string]> {
  // Drive translate_group against a stubbed transport (no network) and
  // return (system, user) exactly as they would go on the wire.
  const seen: Record<string, unknown>[] = [];
  const fakePost = async (
    _url: string, _headers: Record<string, string>, payload: unknown,
  ): Promise<P.PostResult> => {
    seen.push(payload as Record<string, unknown>);
    // one body that satisfies both protocols' extractors
    return { status: 200, headers: {},
             bodyText: JSON.stringify({ choices: [{ message: { content: "ok" } }],
                                        output_text: "ok" }) };
  };
  const cfg = { base_url: "https://api.example.test/v1", api_key: "k", model: "m",
                protocol, system };
  const r = await P.translate_group(cfg, cur, prev, nxt, 0, { post: fakePost });
  assert.ok(r.error === null && seen.length > 0, "the stubbed transport must be hit");
  const body = seen[seen.length - 1]!;
  if (protocol === "chat-completions") {
    const messages = body["messages"] as { content: string }[];
    return [messages[0]!.content, messages[1]!.content];
  }
  const input = body["input"] as { content: { text: string }[] }[];
  return [body["instructions"] as string, input[0]!.content[0]!.text];
}

test("wire context lines go into system and user stays pure", async () => {
  // #38 / ADR-009 wire contract: neighbour context rides as two verbatim
  // label lines appended to the system prompt; the user message is the pure
  // current sentence - for both protocols. Wording and order are pinned on
  // purpose: they feed the identity scheme. Empty context appends nothing,
  // and a missing neighbour omits exactly its own line.
  const cur = "current sentence here";
  const prev = "previous neighbour line";
  const nxt = "next neighbour line";
  const wantSys = "BASE PROMPT\n" +
    "Previous line (context only, do not translate): " + prev + "\n" +
    "Next line (context only, do not translate): " + nxt;
  for (const protocol of ["chat-completions", "responses"]) {
    const [system, user] = await captureWire(protocol, cur, prev, nxt);
    assert.equal(user, cur, protocol + ": user message must be the pure current sentence");
    assert.equal(system, wantSys, protocol + ": exactly two verbatim label lines in system");
  }
  // empty context (both neighbours absent): nothing is appended
  for (const protocol of ["chat-completions", "responses"]) {
    const [system, user] = await captureWire(protocol, cur);
    assert.equal(system, "BASE PROMPT", protocol + ": no lines when no context");
    assert.equal(user, cur, protocol + ": no lines when no context");
  }
  // positional defaults: a missing neighbour omits exactly its own line
  const [sysNoPrev] = await captureWire("chat-completions", cur, "", nxt);
  assert.equal(sysNoPrev, "BASE PROMPT\n" +
    "Next line (context only, do not translate): " + nxt);
  const [sysNoNext] = await captureWire("chat-completions", cur, prev, "");
  assert.equal(sysNoNext, "BASE PROMPT\n" +
    "Previous line (context only, do not translate): " + prev);
});
