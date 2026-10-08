// 1:1 port of desktop/tests/test_connection_test.py seam 1 - the test runner
// + report contract, driven by injected fake transports (ticket #202,
// map #181). Every seam-1 pytest test function maps to exactly one test()
// below; assertions are converted assertion-for-assertion (equivalence
// criteria #1, #191).
//
// seam 2 (the /status loopback observation port) stays pytest ground truth
// for the protocol-service ticket (#198): the pytest fixture drives the real
// WSServer(port, event_queue, status_provider) which the app side has not
// ported yet (the skeleton ws-server is a #197 placeholder without a
// status_provider seam). status_payload() is ported and ready for it.
// seam 3 (client vs real bad addresses) lives in tests/provider.test.ts,
// exactly like the pytest split.
//
// Registered behavior conversions (criteria #2):
//   - Python sync runner + threading.Event gates -> async runner + promise
//     gates polled with waitFor (the event loop must stay free).
//   - threading.Thread / single-flight bookkeeping -> async worker with a
//     generation counter (same start/cancel/progress semantics).
//   - monkeypatch on TranslationCache.put / TranslationQueue.submit ->
//     prototype patch + restore (class methods stay mutable in JS).
//   - monkeypatch.setattr(S, "save", ...) is impossible on an ESM module
//     export; the equivalent guarantee is a source scan asserting the
//     runner module never imports the settings module (plus the runner
//     never imports the cache/queue modules at all).
//   - time.sleep(0.3) after cancel is KEPT (the assertion means the stale
//     run had time to (not) write its report back).
//   - gate.wait(5) -> waitFor with a 10s deadline (same asserted states,
//     CI-safe deadline, matching the queue-cache port).
//   - tester._translate is P.translate_group -> direct reference equality
//     on the JS class fields (same field names as the Python module).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as CT from "../lib/connection-test.ts";
import * as P from "../lib/provider.ts";
import * as Q from "../lib/queue-cache.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await sleep(stepMs);
  }
}

const KEY = "sk-SECRET-XYZ";

function snap(kw: Record<string, unknown> = {}): Record<string, unknown> {
  return { base_url: "https://api.example.test/v1", api_key: KEY,
           model: "test-model", protocol: "auto",
           system: "Translate into Chinese.", mock: false, ...kw };
}

function layer(rep: CT.TestReport, lid: string): CT.TestLayer {
  return rep.layers.find(L => L.id === lid)!;
}

const okTranslate = async (): Promise<P.GroupResult> =>
  ({ aligned: false, text: "OK", error: null, attempts: 1 });

const okList = async (): Promise<[string[], string | null]> => [["test-model"], null];

function run(s: Record<string, unknown>, translate: CT.TranslateFn = okTranslate,
             lst: CT.ListModelsFn = okList): Promise<CT.TestReport> {
  return CT.run_connection_test(s, translate, lst);
}

// ---------------------------------------------------------------- seam 1
// --- local static short-circuit: zero network --------------------------
test("static bad url short-circuits with zero network", async () => {
  const calls: unknown[] = [];
  const boomT: CT.TranslateFn = () => {
    calls.push("t");
    throw new Error("network must not be touched");
  };
  const boomL: CT.ListModelsFn = () => {
    calls.push("l");
    throw new Error("network must not be touched");
  };
  const rep = await run(snap({ base_url: "not-a-url" }), boomT, boomL);
  assert.equal(rep.verdict, "fail");
  assert.equal(layer(rep, "L1").passed, false);
  assert.equal(layer(rep, "L1").code, "BAD_CONFIG");
  assert.equal(rep.attempts, 0);
  assert.deepEqual(rep.skipped, ["step1", "step2"]);
  assert.deepEqual(calls, [], "a locally invalid URL must short-circuit both steps");
});

test("static empty base url fails immediately", async () => {
  const t0 = Date.now();
  const rep = await run(snap({ base_url: "" }));
  assert.equal(rep.verdict, "fail");
  assert.equal(layer(rep, "L1").code, "BAD_CONFIG");
  assert.ok(Date.now() - t0 < 1000, "no network timeout may be waited out");
});

test("static empty model fails model layer zero network", async () => {
  const calls: unknown[] = [];
  const boomT: CT.TranslateFn = () => {
    calls.push("t");
    throw new Error("network must not be touched");
  };
  const boomL: CT.ListModelsFn = () => {
    calls.push("l");
    throw new Error("network must not be touched");
  };
  const rep = await run(snap({ model: "" }), boomT, boomL);
  assert.equal(rep.verdict, "fail");
  assert.equal(layer(rep, "L3").passed, false);
  assert.equal(layer(rep, "L3").code, "NO_MODEL");
  assert.equal(rep.attempts, 0);
  assert.deepEqual(calls, []);
});

// --- model list: three-state observation (never a gate) ----------------
test("model list hit passes the model layer", async () => {
  const rep = await run(snap());
  assert.equal(layer(rep, "L3").passed, true);
  assert.deepEqual(rep.model_list,
                   { observed: true, ids: ["test-model"], total: 1,
                     contains_model: true });
});

test("model not in list is an observation but gate still passes", async () => {
  const rep = await run(snap(), okTranslate, async () => [["other-model"], null]);
  const l3 = layer(rep, "L3");
  assert.equal(l3.passed, null, "not-in-list must not be judged a failure");
  assert.equal(l3.message, "模型列表有响应，但其中未列出配置的模型。");
  assert.equal(rep.model_list.contains_model, false);
  assert.equal(rep.verdict, "pass", "step 2 is the only gate");
});

test("model list http 404 is observation not failure", async () => {
  const rep = await run(snap(), okTranslate, async () => [[], "HTTP_404"]);
  assert.equal(layer(rep, "L1").passed, true, "an answered endpoint is reachable");
  assert.equal(layer(rep, "L3").passed, null);
  assert.equal(rep.verdict, "pass");
});

test("unparseable model list still passes auth and gate", async () => {
  const rep = await run(snap(), okTranslate, async () => [[], "INVALID_MODEL_OUTPUT"]);
  assert.equal(layer(rep, "L1").passed, true);
  assert.equal(layer(rep, "L2").passed, true, "HTTP 2xx means the key was accepted");
  assert.equal(layer(rep, "L3").passed, null);
  assert.equal(rep.verdict, "pass");
});

// --- list-side error codes -> layers ------------------------------------
test("list error codes map to layers", async () => {
  // L2 failure is localization, never a gate: with step 2 succeeding the
  // verdict stays pass (decision 1 - only L4 gates).
  for (const code of ["HTTP_401", "HTTP_403"]) {
    const rep = await run(snap(), okTranslate, async () => [[], code]);
    assert.equal(layer(rep, "L2").passed, false, code);
    assert.ok(["AUTH", "FORBIDDEN"].includes(layer(rep, "L2").code!), code);
    assert.equal(layer(rep, "L1").passed, true, "HTTP response = reachable");
    assert.equal(rep.verdict, "pass", "L1-L3 never gate");
  }
  for (const code of ["HTTP_429", "HTTP_500", "HTTP_400"]) {
    const rep = await run(snap(), okTranslate, async () => [[], code]);
    assert.equal(layer(rep, "L2").passed, null, code + " says nothing about auth");
    assert.equal(layer(rep, "L1").passed, true);
  }
  for (const code of ["TIMEOUT", "NETWORK"]) {
    const rep = await run(snap(), okTranslate, async () => [[], code]);
    assert.equal(layer(rep, "L1").passed, false);
    assert.equal(layer(rep, "L1").code, code);
    assert.equal(layer(rep, "L2").passed, null);
    assert.equal(rep.verdict, "pass", "a step-1 failure must never gate");
  }
});

test("list 401 fails auth layer but step2 still runs", async () => {
  // Decision 5: network-layer step-1 results - 401 included - never block
  // step 2; only local static validation short-circuits.
  const seen: string[] = [];
  const translate: CT.TranslateFn = (_cfg, text) => {
    seen.push(text);
    return { aligned: false, text: "T", error: "AUTH",
             message: "401 unauthorized", attempts: 1 };
  };
  const rep = await run(snap(), translate, async () => [[], "HTTP_401"]);
  assert.ok(seen.length > 0, "step 2 must still run after a step-1 401");
  assert.equal(layer(rep, "L1").passed, true, "earlier success preserved");
  assert.equal(layer(rep, "L2").code, "AUTH");
  assert.equal(layer(rep, "L4").code, "AUTH");
  assert.equal(rep.verdict, "fail");
});

// --- structural judgment of step 2 ---------------------------------------
test("pass carries sample source and real translation", async () => {
  const rep = await run(snap(), async () =>
    ({ aligned: false, text: "猫坐在垫子上", error: null, attempts: 2 }));
  assert.equal(rep.verdict, "pass");
  assert.deepEqual(rep.sample, { source: CT.TEST_SENTENCE, translation: "猫坐在垫子上" });
  assert.equal(rep.attempts, 2);
  assert.equal(layer(rep, "L4").passed, true);
});

test("non json response is a shape failure with provider message", async () => {
  const rep = await run(snap(), async () =>
    ({ error: "INVALID_MODEL_OUTPUT", message: "response is not JSON", attempts: 1 }));
  assert.equal(rep.verdict, "fail");
  assert.equal(layer(rep, "L4").code, "INVALID_MODEL_OUTPUT");
  assert.equal(layer(rep, "L4").message,
               "响应中没有非空译文。（原始详情：response is not JSON）");
});

test("empty text without error is still a failure", async () => {
  const rep = await run(snap(), async () =>
    ({ aligned: false, text: "", error: null, attempts: 1 }));
  assert.equal(rep.verdict, "fail");
  assert.equal(layer(rep, "L4").passed, false);
  assert.equal(layer(rep, "L4").code, "INVALID_MODEL_OUTPUT");
});

test("error code mapping is a closed set", async () => {
  const closed = ["TIMEOUT", "NETWORK", "AUTH", "FORBIDDEN", "RATE_LIMITED",
                  "SERVER", "BAD_REQUEST", "INVALID_MODEL_OUTPUT", "NO_MODEL",
                  "BAD_CONFIG"];
  for (const code of closed) {
    const rep = await run(snap(), async () =>
      ({ error: code, message: "msg-" + code, attempts: 1 }));
    assert.equal(rep.verdict, "fail");
    assert.equal(layer(rep, "L4").code, code, code);
    assert.ok(layer(rep, "L4").message!.includes("msg-" + code), code);
    assert.ok(!layer(rep, "L4").message!.includes("未知错误"), code);
  }
  // anything outside the closed set degrades to the unknown code
  const rep = await run(snap(), async () =>
    ({ error: "SOMETHING_NEW", message: "x", attempts: 1 }));
  assert.equal(layer(rep, "L4").code, "UNKNOWN");
});

test("failure keeps the layers that succeeded", async () => {
  const rep = await run(snap(), async () =>
    ({ error: "AUTH", message: "401 unauthorized", attempts: 1 }));
  assert.equal(rep.verdict, "fail");
  assert.equal(layer(rep, "L1").passed, true);
  assert.equal(layer(rep, "L2").passed, true);
  assert.equal(layer(rep, "L3").passed, true);
  assert.equal(layer(rep, "L4").passed, false);
});

// --- Mock: third verdict, zero network, never green ----------------------
test("mock is the third verdict with zero network", async () => {
  const boomT: CT.TranslateFn = () => {
    throw new Error("Mock must send no network request");
  };
  const boomL: CT.ListModelsFn = () => {
    throw new Error("Mock must send no network request");
  };
  const rep = await run(snap({ mock: true }), boomT, boomL);
  assert.equal(rep.verdict, "mock");
  assert.notEqual(rep.verdict, "pass");
  assert.equal(rep.mock, true);
  assert.equal(rep.attempts, 0);
  assert.deepEqual(rep.skipped, ["step1", "step2"]);
  for (const lid of ["L1", "L2", "L3", "L4"]) {
    assert.equal(layer(rep, lid).passed, null, lid);
  }
});

test("mock with real config warns it masks the real state", async () => {
  const rep = await run(snap({ mock: true }));
  assert.ok(rep.warnings.includes(CT.MOCK_MASKS_REAL_CONFIG));
  assert.deepEqual(rep.warning_messages,
                   { [CT.MOCK_MASKS_REAL_CONFIG]:
                       "当前为 Mock 模式；已填写的真实配置本次不会被使用。" });
});

test("mock without real config has no mask warning", async () => {
  const rep = await run(snap({ mock: true, base_url: "", model: "" }));
  assert.equal(rep.verdict, "mock");
  assert.ok(!rep.warnings.includes(CT.MOCK_MASKS_REAL_CONFIG));
  assert.ok(!(CT.MOCK_MASKS_REAL_CONFIG in rep.warning_messages));
});

// --- attempts / quota / snapshot -----------------------------------------
test("attempts zero when nothing was sent", async () => {
  assert.equal((await run(snap({ base_url: "" }))).attempts, 0);
  assert.equal((await run(snap({ mock: true }))).attempts, 0);
});

test("quota notice promises a real request only for real runs", async () => {
  assert.ok((await run(snap())).quota_notice.includes("一次真实的最小翻译请求"));
  assert.ok((await run(snap({ mock: true }))).quota_notice.includes("未发送网络请求"));
  assert.ok((await run(snap({ base_url: "" }))).quota_notice.includes("未发送请求"));
});

test("report snapshot is the click time input and never the key", async () => {
  const s = snap({ system: "CLICK-TIME PROMPT" });
  const rep = await run(s);
  const blob = JSON.stringify(rep);
  assert.ok(!blob.includes(KEY), "the API key must never appear in the report");
  assert.ok(!("api_key" in rep.snapshot));
  assert.equal(rep.snapshot.api_key_set, true);
  assert.equal(rep.snapshot.system, "CLICK-TIME PROMPT");
  assert.equal(rep.snapshot.base_url, s["base_url"]);
  assert.equal(s["api_key"], KEY, "the run must not mutate the caller's snapshot");
});

test("alignment protocol is declared unverified", async () => {
  const rep = await run(snap());
  assert.ok(rep.notes.some(n => n.includes("尚未验证 Alignment（N|line）协议")));
});

// --- same-path invariant --------------------------------------------------
test("default transports are the production client functions", () => {
  const t = new CT.ConnectionTester();
  assert.equal(t._translate, P.translate_group);
  assert.equal(t._listModels, P.list_models);
});

test("step2 sends the constant sentence with form prompt and tightened timeout", async () => {
  const calls: { cfg: Record<string, unknown>; text: string }[] = [];
  const capture: CT.TranslateFn = (cfg, text) => {
    calls.push({ cfg: { ...cfg }, text });
    return { aligned: false, text: "T", error: null, attempts: 1 };
  };
  await run(snap({ system: "FORM PROMPT" }), capture);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  // one positional prompt, no context; whole-line mode: the TS TranslateFn
  // signature carries exactly (cfg, text) - no expected_lines override and
  // no context parameters exist to pass (pytest kw == {}).
  assert.equal(call.text, CT.TEST_SENTENCE);
  assert.ok(!CT.TEST_SENTENCE.includes("\n"), "the probe sentence must be one line");
  assert.equal(call.cfg["system"], "FORM PROMPT",
               "the current form prompt goes on the wire");
  assert.equal(call.cfg["timeout_s"], CT.TEST_TIMEOUT_S);
  assert.equal(CT.TEST_TIMEOUT_S, 20.0);
  assert.equal(call.cfg["base_url"], "https://api.example.test/v1");
  assert.equal(call.cfg["model"], "test-model");
  assert.equal(call.cfg["protocol"], "auto");
  assert.equal(call.cfg["api_key"], KEY);
});

// --- run mechanics: single-flight, cancel/generation, progress ------------
function gatedTranslator(gate: { open: boolean }, onStarted: () => void,
                         text = "late"): CT.TranslateFn {
  return async () => {
    onStarted();
    await waitFor(() => gate.open, 10000, 5);
    return { aligned: false, text, error: null, attempts: 1 };
  };
}

function startedGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("single flight rejects a second start while running", async () => {
  const gate = { open: false };
  const started = startedGate();
  const done: CT.TestReport[] = [];
  const tester = new CT.ConnectionTester(gatedTranslator(gate, started.release), okList);
  try {
    assert.equal(tester.start(snap(), r => { done.push(r); }), true);
    await started.promise;
    assert.ok(tester.is_running());
    assert.equal(tester.start(snap(), r => { done.push(r); }), false, "single flight");
    gate.open = true;
    await waitFor(() => done.length > 0);
    assert.ok(done.length > 0 && tester.last_report() !== null);
    // after the run ends the button works again
    assert.equal(tester.start(snap(), r => { done.push(r); }), true);
    await waitFor(() => done.length >= 2);
    assert.equal(done.length, 2);
  } finally {
    gate.open = true;
    tester.cancel();
  }
});

test("cancel unblocks immediately drops stale result and allows rerun", async () => {
  const gate = { open: false };
  const started = startedGate();
  const done: CT.TestReport[] = [];
  const tester = new CT.ConnectionTester(gatedTranslator(gate, started.release), okList);
  try {
    assert.ok(tester.start(snap(), r => { done.push(r); }));
    await started.promise;
    assert.equal(tester.progress().step, 2);
    tester.cancel();
    assert.ok(!tester.is_running(), "cancel must free the UI immediately");
    gate.open = true;
    await sleep(300);
    // (not deepEqual: its asserts-signature would narrow done to never[])
    assert.equal(done.length, 0, "the abandoned run must not write its report back");
    assert.equal(tester.last_report(), null);
    // a fresh run right after cancel works and is the one that lands
    assert.ok(tester.start(snap(), r => { done.push(r); }));
    await waitFor(() => done.length >= 1);
    assert.equal(done.length, 1);
    assert.ok(tester.last_report() !== null);
    assert.equal(tester.last_report()!.verdict, "pass");
  } finally {
    gate.open = true;
    tester.cancel();
  }
});

test("progress reports step and elapsed seconds", async () => {
  const gate = { open: false };
  const started = startedGate();
  const slowList: CT.ListModelsFn = async () => {
    started.release();
    await waitFor(() => gate.open, 10000, 5);
    return [["test-model"], null];
  };
  const tester = new CT.ConnectionTester(okTranslate, slowList);
  try {
    assert.ok(tester.start(snap(), () => {}));
    await started.promise;
    const p = tester.progress();
    assert.ok(p.running);
    assert.equal(p.step, 1);
    assert.ok(p.elapsed_s >= 0.0);
    gate.open = true;
    await waitFor(() => !tester.is_running());
    assert.ok(!tester.is_running());
    assert.equal(tester.progress().step, 0);
  } finally {
    gate.open = true;
    tester.cancel();
  }
});

test("a run writes no cache no queue and no config", async () => {
  const hits = { cache: 0, queue: 0, save: 0 };
  const origPut = Q.TranslationCache.prototype.put;
  const origSubmit = Q.TranslationQueue.prototype.submit;
  (Q.TranslationCache.prototype as unknown as { put: () => void }).put =
    function putProbe() { hits.cache += 1; };
  (Q.TranslationQueue.prototype as unknown as { submit: () => void }).submit =
    function submitProbe() { hits.queue += 1; };
  try {
    const rep = await run(snap());
    assert.equal(rep.verdict, "pass");
    assert.deepEqual(hits, { cache: 0, queue: 0, save: 0 });
  } finally {
    Q.TranslationCache.prototype.put = origPut;
    Q.TranslationQueue.prototype.submit = origSubmit;
  }
  // settings.save cannot be monkeypatched on an ESM module export; the
  // equivalent guarantee is that the runner module never imports the
  // settings module (source scan; cache/queue covered by the patch above).
  const src = fs.readFileSync(new URL("../lib/connection-test.ts", import.meta.url), "utf8");
  assert.ok(!/^import[^\n]*settings/m.test(src),
            "the runner must not import the settings module");
});
