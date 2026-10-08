// 1:1 port of desktop/suboverlay/connection_test.py - connection test runner
// and report contract (#23, ADR-005; ticket #202, map #181).
//
// Answers one question honestly: does this provider configuration actually
// translate? Four layers localize a failure - L1 endpoint reachable, L2 auth
// accepted, L3 model listed, L4 a structurally valid non-empty translation -
// and only L4 gates the verdict ("red = production would be red too").
//
// Deliberately Qt-free and Electron-free: the two transports
// (provider.translate_group, provider.list_models - the exact production
// functions) are injected, so the run mechanics (single flight, cancel by
// generation, progress ticks, snapshot semantics) are testable without a
// window. The GUI is a thin adapter over this module.
//
// Rules honoured here: never auto-triggered; never writes the cache, the
// queue or any config file (the TS runner module imports neither - asserted
// by the ported test); never puts the API key into the report; Mock is a
// third verdict (never "pass") with zero network traffic; cancel means
// "stop waiting" - the in-flight request finishes on its own and its quota
// is not refunded. Human-facing report prose is Chinese alongside unchanged
// machine codes (byte-identical to the Python module).
//
// Registered port conversions (ticket #202):
// - Python sync runner + threading.Thread worker -> async runner + async
//   worker on the event loop (the TS transports are fetch-based promises).
// - threading.Lock -> single-threaded event-loop serialization.
// - time.monotonic() -> performance.now() (same monotonic-ms semantics).
// - the seam-2 /status integration test (WSServer + status_payload) stays
//   pytest ground truth for the protocol-service ticket (#198): the app-side
//   server there owns the real /status route; status_payload() is ported
//   here ready for it.
// - type(exc).__name__ -> Error.name.
import * as provider_mod from "./provider.ts";
import type { GroupResult, ProviderConfig } from "./provider.ts";

// The minimal one-line English probe sentence for step 2 (whole-line mode,
// no context prefix). Module constant so tests can pin it.
export const TEST_SENTENCE = "The cat sat on the mat.";

// Step 2's own time ceiling, tightened from the production 60s because the
// probe is one short sentence (decision 11). Step 1 keeps
// provider.MODELS_TIMEOUT_S. Constants only - no new user-facing setting.
export const TEST_TIMEOUT_S = 20.0;

export const MOCK_MASKS_REAL_CONFIG = "MOCK_MASKS_REAL_CONFIG";

export const ALIGNMENT_NOTE =
  "尚未验证 Alignment（N|line）协议；本次探测仅使用整行模式。";

// The closed error vocabulary shared by both steps (decision 13). Codes kept
// in the engine's own vocabulary but unreachable here (SHAPE_MISS, WORKER)
// degrade to UNKNOWN instead of leaking a second language into the report.
export const KNOWN_CODES: ReadonlySet<string> = new Set([
  "BAD_CONFIG", "NO_MODEL", "TIMEOUT", "NETWORK", "AUTH", "FORBIDDEN",
  "RATE_LIMITED", "SERVER", "BAD_REQUEST", "INVALID_MODEL_OUTPUT", "UNKNOWN",
]);

const _DEFAULT_MESSAGES: Record<string, string> = {
  "BAD_CONFIG": "配置不是有效的绝对 HTTP(S) URL。",
  "NO_MODEL": "模型名称为空。",
  "TIMEOUT": "请求超时，服务未在规定时间内响应。",
  "NETWORK": "无法连接到服务（网络错误）。",
  "AUTH": "401 未授权：API Key 被拒绝。",
  "FORBIDDEN": "403 禁止访问：服务器拒绝了请求。",
  "RATE_LIMITED": "请求被服务器限流。",
  "SERVER": "服务器报告内部错误。",
  "BAD_REQUEST": "服务器拒绝了请求。",
  "INVALID_MODEL_OUTPUT": "响应中没有非空译文。",
  "UNKNOWN": "未知错误。",
};

const _WARNING_MESSAGES: Record<string, string> = {
  [MOCK_MASKS_REAL_CONFIG]: "当前为 Mock 模式；已填写的真实配置本次不会被使用。",
};

const _LAYERS: readonly (readonly [string, string])[] = [
  ["L1", "端点可访问"], ["L2", "身份验证"], ["L3", "模型存在"], ["L4", "翻译可用"],
];

const _QUOTA_REAL =
  "本次点击会发送一次真实的最小翻译请求；重试可能增加用量，取消不会退还已消耗额度。";
const _QUOTA_MOCK = "Mock 模式：未发送网络请求，也未消耗额度。";
const _QUOTA_STATIC = "未发送请求：本地配置无效。";

const _ID_LIST = "step1";
const _ID_TRANS = "step2";

export type LayerId = "L1" | "L2" | "L3" | "L4";

export interface TestLayer {
  id: string;
  title: string;
  passed: boolean | null;
  code: string | null;
  message: string | null;
  elapsed_ms: number;
}

export interface SnapshotFields {
  base_url: string;
  model: string;
  protocol: string;
  system: string;
  api_key_set: boolean;
  mock: boolean;
}

export interface ModelListReport {
  observed: boolean;
  ids: string[];
  total: number;
  contains_model: boolean | null;
}

export interface TestReport {
  verdict: "pass" | "fail" | "mock";
  mock: boolean;
  layers: TestLayer[];
  attempts: number;
  sample: { source: string; translation: string | null };
  model_list: ModelListReport;
  warnings: string[];
  warning_messages: Record<string, string>;
  skipped: string[];
  quota_notice: string;
  notes: string[];
  snapshot: SnapshotFields;
  duration_ms: number;
}

// The snapshot is the click-time provider form: a loose dict (settings shaped).
export type TestSnapshot = Record<string, unknown>;

export type TranslateFn =
  (cfg: ProviderConfig, text: string) => GroupResult | Promise<GroupResult>;
export type ListModelsFn =
  (cfg: ProviderConfig) => [string[], string | null] | Promise<[string[], string | null]>;

const _layerTitles = new Map<string, string>(_LAYERS);

function _layer(lid: string, passed: boolean | null, code: string | null,
                message: string | null, elapsed_ms = 0): TestLayer {
  const title = _layerTitles.get(lid)!;
  return { id: lid, title, passed, code, message, elapsed_ms: Math.trunc(elapsed_ms) };
}

function _skip(msg: string): Record<LayerId, TestLayer> {
  return { L1: _layer("L1", null, null, msg),
           L2: _layer("L2", null, null, msg),
           L3: _layer("L3", null, null, msg),
           L4: _layer("L4", null, null, msg) };
}

function sfield(snap: TestSnapshot, key: string): string {
  const v = snap[key];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function _snapshot_fields(snap: TestSnapshot): SnapshotFields {
  return { base_url: sfield(snap, "base_url").trim(),
           model: sfield(snap, "model").trim(),
           protocol: sfield(snap, "protocol") || "auto",
           system: sfield(snap, "system") || "",
           api_key_set: Boolean(snap["api_key"]),
           mock: Boolean(snap["mock"]) };
}

function _report(verdict: TestReport["verdict"], layers: Record<LayerId, TestLayer>,
                 snap: TestSnapshot, attempts: number, translation: string | null,
                 model_list: ModelListReport, warnings: readonly string[],
                 skipped: readonly string[], quota: string, duration_ms: number):
    TestReport {
  return {
    verdict,
    mock: Boolean(snap["mock"]),
    layers: _LAYERS.map(([lid]) => layers[lid as LayerId]),
    attempts: Math.trunc(attempts),
    sample: { source: TEST_SENTENCE, translation },
    model_list,
    warnings: [...warnings],
    warning_messages: Object.fromEntries(
      warnings.filter(c => c in _WARNING_MESSAGES).map(c => [c, _WARNING_MESSAGES[c]!])),
    skipped: [...skipped],
    quota_notice: quota,
    notes: [ALIGNMENT_NOTE],
    snapshot: _snapshot_fields(snap),
    duration_ms: Math.trunc(duration_ms),
  };
}

function _no_model_list(): ModelListReport {
  return { observed: false, ids: [], total: 0, contains_model: null };
}

// Local validation only - exactly the short-circuit cases of decision 5:
// an empty / non-absolute / non-http(s) base URL, or an empty model name.
function _static_problems(snap: TestSnapshot):
    Partial<Record<"L1" | "L3", [string, string]>> {
  const problems: Partial<Record<"L1" | "L3", [string, string]>> = {};
  try {
    provider_mod.coerce_endpoint(snap["base_url"], snap["protocol"]);
  } catch (e) {
    if (e instanceof provider_mod.ProviderError) {
      problems["L1"] = ["BAD_CONFIG", _DEFAULT_MESSAGES["BAD_CONFIG"]!];
    } else {
      throw e;
    }
  }
  if (!sfield(snap, "model").trim()) {
    problems["L3"] = ["NO_MODEL", _DEFAULT_MESSAGES["NO_MODEL"]!];
  }
  return problems;
}

function _layers_from_models(err: string | null, ids: readonly string[],
                             model: string, elapsed_ms: number):
    [TestLayer, TestLayer, TestLayer] {
  // The list endpoint is a locating probe, never a gate: only an explicit
  // 401/403 fails L2, and L3 records an observation in all three states.
  if (err === null) {
    const l1 = _layer("L1", true, null, "端点已响应（HTTP 2xx）。", elapsed_ms);
    const l2 = _layer("L2", true, null, "API Key 已接受（HTTP 2xx）。", elapsed_ms);
    let l3: TestLayer;
    if (ids.includes(model)) {
      l3 = _layer("L3", true, null, "服务端模型列表包含配置的模型。", elapsed_ms);
    } else {
      l3 = _layer("L3", null, null, "模型列表有响应，但其中未列出配置的模型。", elapsed_ms);
    }
    return [l1, l2, l3];
  }

  if (typeof err === "string" && err.startsWith("HTTP_")) {
    const status = err.slice(5);
    const l1 = _layer("L1", true, null, "端点已响应（HTTP " + status + "）。", elapsed_ms);
    if (status === "401") {
      return [l1,
              _layer("L2", false, "AUTH", _DEFAULT_MESSAGES["AUTH"]!, elapsed_ms),
              _layer("L3", null, null, "模型列表不可用（401 未授权）。", elapsed_ms)];
    }
    if (status === "403") {
      return [l1,
              _layer("L2", false, "FORBIDDEN", _DEFAULT_MESSAGES["FORBIDDEN"]!, elapsed_ms),
              _layer("L3", null, null, "模型列表不可用（403 禁止访问）。", elapsed_ms)];
    }
    let note: string;
    if (status === "402" || status === "429") {
      note = "未能确认：端点触发限流（HTTP " + status + "）。";
    } else if (/^[0-9]+$/.test(status) && Number(status) >= 500) {
      note = "未能确认：端点返回服务器错误（HTTP " + status + "）。";
    } else {
      note = "未能确认：端点拒绝了请求（HTTP " + status + "）。";
    }
    return [l1,
            _layer("L2", null, null, note, elapsed_ms),
            _layer("L3", null, null, "模型列表不可用（HTTP " + status + "）。", elapsed_ms)];
  }

  if (err === "TIMEOUT") {
    return [_layer("L1", false, "TIMEOUT", _DEFAULT_MESSAGES["TIMEOUT"]!, elapsed_ms),
            _layer("L2", null, null, "未能确认：端点未及时响应。", elapsed_ms),
            _layer("L3", null, null, "模型列表不可用（请求超时）。", elapsed_ms)];
  }
  if (err === "NETWORK") {
    return [_layer("L1", false, "NETWORK", _DEFAULT_MESSAGES["NETWORK"]!, elapsed_ms),
            _layer("L2", null, null, "未能确认：端点无法连接。", elapsed_ms),
            _layer("L3", null, null, "模型列表不可用（网络错误）。", elapsed_ms)];
  }
  if (err === "INVALID_MODEL_OUTPUT") {
    return [_layer("L1", true, null, "端点已响应，但模型列表不是有效 JSON。", elapsed_ms),
            _layer("L2", true, null, "API Key 已接受（HTTP 2xx）。", elapsed_ms),
            _layer("L3", null, null, "模型列表响应不是有效 JSON。", elapsed_ms)];
  }
  if (err === "BAD_CONFIG") {
    return [_layer("L1", false, "BAD_CONFIG", _DEFAULT_MESSAGES["BAD_CONFIG"]!, elapsed_ms),
            _layer("L2", null, null, "已跳过：Base URL 无效。", elapsed_ms),
            _layer("L3", null, null, "已跳过：Base URL 无效。", elapsed_ms)];
  }
  return [_layer("L1", false, "UNKNOWN", "模型列表探测失败：" + err + "。", elapsed_ms),
          _layer("L2", null, null, "未能确认：第 1 步探测失败。", elapsed_ms),
          _layer("L3", null, null, "模型列表不可用。", elapsed_ms)];
}

function _layer4_from_result(res: GroupResult, elapsed_ms: number):
    [TestLayer, string | null] {
  // The only gate: HTTP 200 + parseable JSON + non-empty text, judged purely
  // structurally. Semantic quality is the human's call - the sample travels
  // in the report for exactly that reason.
  const err = res.error;
  const text = typeof res.text === "string" ? res.text : "";
  if (!err) {
    if (text.trim()) {
      return [_layer("L4", true, null, "已收到非空译文。", elapsed_ms), text];
    }
    return [_layer("L4", false, "INVALID_MODEL_OUTPUT",
                   _DEFAULT_MESSAGES["INVALID_MODEL_OUTPUT"]!, elapsed_ms), null];
  }
  const code = err !== null && KNOWN_CODES.has(err) ? err : "UNKNOWN";
  const detail = (typeof res.message === "string" ? res.message : "").trim();
  let message = _DEFAULT_MESSAGES[code] ?? _DEFAULT_MESSAGES["UNKNOWN"]!;
  if (detail) message += "（原始详情：" + detail + "）";
  return [_layer("L4", false, code, message, elapsed_ms), text || null];
}

export async function run_connection_test(
  snapshot: TestSnapshot,
  translate_fn: TranslateFn,
  list_models_fn: ListModelsFn,
  on_step?: (n: number) => void,
): Promise<TestReport> {
  const snap: TestSnapshot = { ...snapshot };
  const step = on_step ?? (() => {});
  const t_start = performance.now();

  const build = (verdict: TestReport["verdict"], layers: Record<LayerId, TestLayer>,
                 attempts: number, translation: string | null,
                 model_list: ModelListReport, warnings: readonly string[],
                 skipped: readonly string[], quota: string): TestReport =>
    _report(verdict, layers, snap, attempts, translation, model_list, warnings,
            skipped, quota, performance.now() - t_start);

  step(1);

  // --- Mock: third verdict, zero network, never green (decision 22).
  // Checked BEFORE local validation: an unconfigured Mock run is the honest
  // "verify the in-app link" path (story 23), not a configuration failure -
  // Mock can be verdict "mock" with every field empty.
  if (snap["mock"]) {
    const layers = _skip("已跳过：Mock 模式未发送网络请求。");
    layers["L4"] = _layer("L4", null, null, "已跳过：Mock 模式不会声称完成真实翻译。");
    const warnings: string[] = [];
    if (sfield(snap, "base_url").trim() && sfield(snap, "model").trim()) {
      warnings.push(MOCK_MASKS_REAL_CONFIG);
    }
    return build("mock", layers, 0, null, _no_model_list(), warnings,
                 [_ID_LIST, _ID_TRANS], _QUOTA_MOCK);
  }

  // --- local static validation: the only short-circuit (decision 5) -------
  const problems = _static_problems(snap);
  if (Object.keys(problems).length > 0) {
    const layers = _skip("已跳过：本地校验未通过，未发送请求。");
    for (const lid of Object.keys(problems) as ("L1" | "L3")[]) {
      const [code, message] = problems[lid]!;
      layers[lid] = _layer(lid, false, code, message);
    }
    return build("fail", layers, 0, null, _no_model_list(), [],
                 [_ID_LIST, _ID_TRANS], _QUOTA_STATIC);
  }

  // --- step 1: GET /models (locating probe, never a gate) -----------------
  const fields = _snapshot_fields(snap);
  const cfg: ProviderConfig = {
    base_url: fields.base_url,
    api_key: typeof snap["api_key"] === "string" ? snap["api_key"] : "",
    model: fields.model,
    protocol: fields.protocol,
    system: fields.system || provider_mod.DEFAULT_SYSTEM_PROMPT,
    // decision 11: step 2's tightened ceiling; list_models ignores this key
    // and keeps its own MODELS_TIMEOUT_S default.
    timeout_s: TEST_TIMEOUT_S,
  };

  let t0 = performance.now();
  const [idsRaw, err] = await list_models_fn(cfg);
  const list_ms = performance.now() - t0;
  const ids = idsRaw ?? [];
  const [l1, l2, l3] = _layers_from_models(err, ids, fields.model, list_ms);

  // --- step 2: the real minimal translation (the only gate) ---------------
  step(2);
  t0 = performance.now();
  let res = await translate_fn(cfg, TEST_SENTENCE);
  const trans_ms = performance.now() - t0;
  if (res === null || typeof res !== "object" || Array.isArray(res)) {
    res = { error: "UNKNOWN",
            message: "传输层返回了非字典结果。",
            attempts: 0 };
  }
  const [l4, translation] = _layer4_from_result(res, trans_ms);
  const attempts = Math.trunc(Number(res.attempts ?? 0)) || 0;

  // contains_model is an observation about a list we actually hold.
  const model_list: ModelListReport = {
    observed: true,
    ids: ids.slice(0, 50),
    total: ids.length,
    contains_model: err === null ? ids.includes(fields.model) : null,
  };

  const verdict: TestReport["verdict"] = l4.passed === true ? "pass" : "fail";
  return build(verdict, { L1: l1, L2: l2, L3: l3, L4: l4 },
               attempts, translation, model_list, [], [], _QUOTA_REAL);
}

function _crash_report(snapshot: TestSnapshot, exc: unknown): TestReport {
  // Last-resort report if an injected transport raises: the UI must always
  // unblock and the failure must stay inside the closed vocabulary.
  const snap: TestSnapshot = { ...snapshot };
  const name = exc instanceof Error ? exc.name : String(exc);
  const detail = exc instanceof Error ? exc.message : String(exc);
  const message = ("内部错误（" + name + "）：" + detail).slice(0, 300);
  const layers = _skip("已跳过：运行在执行此步骤前中止。");
  layers["L4"] = _layer("L4", false, "UNKNOWN", message);
  return _report("fail", layers, snap, 0, null, _no_model_list(), [],
                 [_ID_LIST, _ID_TRANS], _QUOTA_STATIC, 0);
}

export interface ProgressState {
  running: boolean;
  step: number;
  elapsed_s: number;
}

export class ConnectionTester {
  // Defaults are the production client functions themselves - the same-path
  // invariant (ADR-005) lives right here. Field names kept Python-visible
  // (the same-path test reads them directly).
  _translate: TranslateFn;
  _listModels: ListModelsFn;
  _gen = 0;
  _busy = false;
  _step = 0;
  _started: number | null = null;
  _report: TestReport | null = null;

  constructor(translate_fn?: TranslateFn, list_models_fn?: ListModelsFn) {
    this._translate = translate_fn ?? provider_mod.translate_group;
    this._listModels = list_models_fn ?? provider_mod.list_models;
  }

  // Begin a run with the click-time inputs. False when one is flying.
  start(snapshot: TestSnapshot, on_done?: (report: TestReport) => void): boolean {
    const frozen: TestSnapshot = { ...snapshot };
    if (this._busy) return false;
    this._busy = true;
    this._gen += 1;
    const gen = this._gen;
    this._step = 1;
    this._started = performance.now();
    void this._worker(frozen, gen, on_done);
    return true;
  }

  private async _worker(frozen: TestSnapshot, gen: number,
                        on_done?: (report: TestReport) => void): Promise<void> {
    const on_step = (n: number) => {
      if (this._gen === gen) this._step = n;
    };
    let report: TestReport;
    try {
      report = await run_connection_test(frozen, this._translate, this._listModels,
                                         on_step);
    } catch (e) {
      // a raising transport must not wedge the UI
      report = _crash_report(frozen, e);
    }
    const stale = gen !== this._gen;
    if (!stale) {
      this._report = report;
      this._busy = false;
      this._step = 0;
    }
    if (!stale && on_done !== undefined) {
      try {
        on_done(report);
      } catch {
        // on_done failures never escape the run mechanics
      }
    }
  }

  // Give up waiting: free the UI now and invalidate the in-flight run's
  // generation so it cannot write its report back. The HTTP request itself
  // is not interrupted and its quota is not refunded.
  cancel(): void {
    this._gen += 1;
    this._busy = false;
    this._step = 0;
  }

  is_running(): boolean {
    return this._busy;
  }

  progress(): ProgressState {
    if (!this._busy || this._started === null) {
      return { running: false, step: 0, elapsed_s: 0.0 };
    }
    const elapsed = (performance.now() - this._started) / 1000;
    return { running: true, step: this._step, elapsed_s: Math.round(elapsed * 10) / 10 };
  }

  last_report(): TestReport | null {
    return this._report;
  }

  // The /status addition. Empty until a run has produced a report - a
  // never-run test must not read as an empty report (decision 17).
  status_payload(): Record<string, unknown> {
    if (this._report === null) return {};
    return { connection_test: this._report };
  }
}
