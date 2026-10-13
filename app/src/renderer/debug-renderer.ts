// Settings/debug window renderer (#205; display layer migrated to Web
// Awesome in #216). The headless model (src/main/debug/*.ts) decides
// everything; the main process owns the instance and pushes ready-to-render
// state ("debug-state"); this file is a dumb applier that forwards user
// intents ("debug-intent").
//
// Must stay import-free (classic script over file://, see tsconfig.build.json
// and the #204 renderer pitfall): the state/intent schemas here mirror the
// wire, not the lib types. Web Awesome components are consumed as bare
// custom elements from the vendored subset (src/renderer/vendor/webawesome/
// VENDOR-NOTE.md); the autoloader upgrades them, this script only touches
// host-element properties and attributes.
//
// Static copy (card titles, field labels for the settings page) lives here -
// it is display text, fixed by the #164 spec, while all dynamic values come
// from the pushed state.
interface DebugBridge {
  onDebugState(cb: (s: unknown) => void): void;
  debugIntent(intent: unknown): void;
  onDebugCopyText(cb: (t: string) => void): void;
}
const debugBridge = (window as unknown as { youtubesub: DebugBridge }).youtubesub;

// Minimal shape of the vendored WA host elements this script drives
// (property access only - the classes live inside the vendored modules and
// the script must stay import-free).
interface WaCtl extends HTMLElement {
  value: string;
  checked: boolean;
  disabled: boolean;
  readOnly: boolean;
}

// ---- static display copy (settings page) ----
const SETTINGS_CARDS = [
  { title: "接口凭据（服务商给你的那几项）" },
  { title: "提示词（决定翻译的风格）" },
  { title: "测试连接（用上面这些还没保存的输入试一次）" },
];
const CRED_ROWS: Array<{ key: string; label: string; hint: string }> = [
  { key: "base_url", label: "接口地址", hint: "服务商文档里的接口前缀，一般以 /v1 结尾" },
  { key: "api_key", label: "密钥", hint: "服务商给你的那串 key，只写在本机设置文件里" },
  { key: "model", label: "模型名", hint: "要调用哪个模型，照服务商文档里写的名字填" },
  { key: "protocol", label: "接口协议", hint: "不知道就留「auto」；连不通时再照服务商文档换一个" },
  { key: "mock", label: "", hint: "勾上就不发真实请求、不花额度：只用来试界面" },
];
const PROTOCOLS = ["auto", "responses", "chat-completions"];

let current = "";
let focusedEl: Element | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// WA host element factory: variant/appearance come from the debug.html token
// mapping (brand accent = 主按钮, neutral filled = 次按钮, plain = ghost).
function wa(tag: string): HTMLElement {
  return document.createElement(tag);
}
function waBtn(text: string, primary: boolean, id?: string): HTMLElement {
  const b = wa("wa-button");
  b.setAttribute("variant", primary ? "brand" : "neutral");
  b.setAttribute("appearance", primary ? "accent" : "filled");
  if (id) b.id = id;
  b.textContent = text;
  return b;
}
function waSelect(id: string, opts?: Array<[string, string]>): HTMLElement {
  const s = wa("wa-select");
  if (id) s.id = id;
  for (const [v, l] of opts ?? []) {
    const o = wa("wa-option");
    o.setAttribute("value", v);
    o.textContent = l;
    s.appendChild(o);
  }
  return s;
}

function send(intent: Record<string, unknown>): void {
  debugBridge.debugIntent(intent);
}

// Rename modal (QInputDialog equivalent - Electron has no synchronous
// text-input dialog, so the prompt lives here and the confirm carries the
// typed name in the intent).
function openRenameModal(): void {
  let modal = document.getElementById("renameModal") as HTMLDivElement | null;
  if (!modal) {
    modal = el("div"); modal.id = "renameModal";
    modal.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;z-index:10;";
    const box = el("div", "debugCard");
    box.style.cssText = "padding:18px 20px;display:flex;flex-direction:column;gap:10px;min-width:320px;";
    const title = el("div", "debugSection"); title.textContent = "重命名预设"; box.appendChild(title);
    const lab = el("div", "debugValue"); lab.textContent = "名称："; box.appendChild(lab);
    const input = wa("wa-input"); input.id = "renameInput";
    box.appendChild(input);
    const row = el("div", "btnrow");
    const ok = waBtn("确定", true);
    const cancel = waBtn("取消", false);
    ok.addEventListener("click", () => {
      send({ type: "preset-rename", name: ((input as WaCtl).value || "").trim() });
      modal!.style.display = "none";
    });
    cancel.addEventListener("click", () => { modal!.style.display = "none"; });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") ok.click();
      if (e.key === "Escape") cancel.click();
      e.stopPropagation();
    });
    row.appendChild(ok); row.appendChild(cancel); box.appendChild(row);
    modal.appendChild(box);
    document.body.appendChild(modal);
  }
  // The combo is a wa-select whose options carry value=String(index); the
  // current label comes from the selected option's text (same as the old
  // select.options[selectedIndex].text).
  const combo = document.getElementById("presetCombo") as WaCtl;
  const inp = document.getElementById("renameInput") as WaCtl;
  const opts = Array.from(combo.querySelectorAll("wa-option")) as WaCtl[];
  const sel = opts.find((o) => o.value === combo.value);
  inp.value = sel?.textContent ?? "";
  modal.style.display = "flex";
  inp.focus();
}

function setVal(input: WaCtl, value: string): void {
  // Never clobber what the user is typing (matches Qt: the widget owns its
  // in-progress edit until focus leaves).
  if (document.activeElement === input) return;
  if (input.value !== value) input.value = value;
}

// ---- page switch ----
function buildSwitch(s: Record<string, unknown>): void {
  const bar = document.getElementById("pageswitch")!;
  const titles: Record<string, string> = { settings: "设置", tuning: "调参", diag: "排障" };
  if (bar.childElementCount === 0) {
    for (const name of ["settings", "tuning", "diag"]) {
      const b = waBtn(titles[name] ?? name, false);
      b.dataset.page = name;
      b.addEventListener("click", () => send({ type: "switch-page", page: name }));
      bar.appendChild(b);
    }
  }
  for (const c of Array.from(bar.children) as HTMLElement[]) {
    const active = c === undefined ? false : c.dataset.page === current;
    c.classList.toggle("active", active);
    // Active pill = brand accent (indigo, cream text); the rest stay neutral
    // filled - the palette mapping on #debugWindow paints both.
    c.setAttribute("variant", active ? "brand" : "neutral");
    c.setAttribute("appearance", active ? "accent" : "filled");
  }
  void s;
}

// ---- settings page ----
function buildSettingsPage(root: HTMLElement, st: Record<string, unknown>): void {
  const fields = st.fields as Record<string, unknown>;
  const preset = st.preset as Record<string, unknown>;
  if (root.dataset.built !== "1") {
    root.dataset.built = "1";
    // card 1: credentials
    const c1 = el("div", "debugCard");
    c1.appendChild(Object.assign(el("h3", "debugSection"), { textContent: SETTINGS_CARDS[0]!.title }));
    const g1 = el("div", "grid");
    for (const row of CRED_ROWS) {
      if (row.label) {
        const cap = el("label", "cap debugValue"); cap.textContent = row.label; g1.appendChild(cap);
      } else {
        g1.appendChild(el("span"));
      }
      let ctl: HTMLElement;
      if (row.key === "protocol") {
        const sel = waSelect("f_protocol", PROTOCOLS.map((p) => [p, p] as [string, string]));
        sel.addEventListener("change", () => send({ type: "edit-credential", field: "protocol", value: (sel as WaCtl).value }));
        ctl = sel;
      } else if (row.key === "mock") {
        const cb = wa("wa-switch"); cb.id = "f_mock";
        const lab = el("label");
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(" Mock 模式：不真的调用 API，只在试界面时用"));
        cb.addEventListener("change", () => send({ type: "edit-credential", field: "mock", value: (cb as WaCtl).checked }));
        ctl = lab;
      } else {
        const inp = wa("wa-input");
        inp.setAttribute("type", row.key === "api_key" ? "password" : "text");
        inp.id = "f_" + row.key;
        inp.addEventListener("input", () => send({ type: "edit-credential", field: row.key, value: (inp as WaCtl).value }));
        ctl = inp;
      }
      g1.appendChild(ctl);
      const hint = el("div", "debugHint"); hint.textContent = row.hint; g1.appendChild(hint);
    }
    c1.appendChild(g1);
    // card 2: prompt
    const c2 = el("div", "debugCard");
    c2.appendChild(Object.assign(el("h3", "debugSection"), { textContent: SETTINGS_CARDS[1]!.title }));
    const g2 = el("div", "grid");
    const cap1 = el("label", "cap debugValue"); cap1.textContent = "用哪套提示词"; g2.appendChild(cap1);
    const combo = waSelect("presetCombo");
    combo.addEventListener("change", () => {
      const v = (combo as WaCtl).value;
      if (v !== "") send({ type: "preset-select", index: Number(v) });
    });
    g2.appendChild(combo);
    const h1 = el("div", "debugHint"); h1.textContent = "内置的三套只读；想改就先「复制为自定义」"; g2.appendChild(h1);
    g2.appendChild(el("span"));
    const btns = el("div", "btnrow");
    for (const [id, label, intent] of [
      ["copyBtn", "复制为自定义", "preset-copy"],
      ["renameBtn", "重命名", "preset-rename"],
      ["deleteBtn", "删除", "preset-delete"],
    ] as Array<[string, string, string]>) {
      const b = waBtn(label, false, id);
      b.addEventListener("click", () => {
        if (intent === "preset-rename") { openRenameModal(); return; }
        send({ type: intent });
      });
      btns.appendChild(b);
    }
    btns.className = "btnrow rowspan";
    g2.appendChild(btns);
    const cap2 = el("label", "cap debugValue"); cap2.textContent = "提示词内容"; g2.appendChild(cap2);
    const editor = wa("wa-textarea"); editor.id = "promptEditor"; editor.style.height = "90px";
    editor.addEventListener("input", () => send({ type: "prompt-text", text: (editor as WaCtl).value }));
    editor.className = "rowspan";
    g2.appendChild(editor);
    const h2 = el("div", "debugHint span-hint"); h2.textContent = "这就是发给模型的指令；内置的只读，复制出来的才能改"; g2.appendChild(h2);
    const cap3 = el("label", "cap debugValue"); cap3.textContent = "实际发出去的提示词"; g2.appendChild(cap3);
    const preview = wa("wa-textarea"); preview.id = "promptPreview";
    (preview as WaCtl).readOnly = true; preview.style.height = "90px";
    preview.className = "rowspan";
    g2.appendChild(preview);
    const h3 = el("div", "debugHint span-hint"); h3.textContent = "下面这段就是真正发出去的内容，改上面会立刻跟着变"; g2.appendChild(h3);
    g2.appendChild(el("span"));
    const ctxLab = el("label");
    const ctx = wa("wa-switch"); ctx.id = "f_context";
    ctxLab.appendChild(ctx);
    ctxLab.appendChild(document.createTextNode(" 携带上下文：把上一句、下一句也一起发给模型"));
    ctx.addEventListener("change", () => send({ type: "edit-credential", field: "context_groups", value: (ctx as WaCtl).checked }));
    ctxLab.className = "rowspan";
    g2.appendChild(ctxLab);
    const h4 = el("div", "debugHint span-hint"); h4.textContent = "勾上翻译更连贯（模型能看到前后句），每次请求也更大"; g2.appendChild(h4);
    c2.appendChild(g2);
    // card 3: connection test
    const c3 = el("div", "debugCard");
    c3.appendChild(Object.assign(el("h3", "debugSection"), { textContent: SETTINGS_CARDS[2]!.title }));
    const g3 = el("div", "grid");
    g3.appendChild(el("span"));
    const testBtns = el("div", "btnrow rowspan");
    const testBtn = waBtn("测试连接", true, "testBtn");
    testBtn.addEventListener("click", () => send({ type: "test-start" }));
    const cancelTest = waBtn("取消测试", false, "cancelTestBtn");
    cancelTest.addEventListener("click", () => send({ type: "test-cancel" }));
    testBtns.appendChild(testBtn); testBtns.appendChild(cancelTest);
    g3.appendChild(testBtns);
    const hTest = el("div", "debugHint span-hint");
    hTest.textContent = "测的是上面填的、还没保存的输入；不落盘、不动浮窗";
    g3.appendChild(hTest);
    const capP = el("label", "cap debugValue"); capP.textContent = "测试进度"; g3.appendChild(capP);
    const prog = el("span", "debugHint"); prog.id = "testProgress"; g3.appendChild(prog);
    g3.appendChild(el("span"));
    const capR = el("label", "cap debugValue"); capR.textContent = "测试报告"; g3.appendChild(capR);
    const report = wa("wa-textarea"); report.id = "testReport";
    (report as WaCtl).readOnly = true;
    report.style.height = "150px"; report.className = "rowspan";
    g3.appendChild(report);
    const hRep = el("div", "debugHint span-hint"); hRep.textContent = "上一次的结果会一直留在这里"; g3.appendChild(hRep);
    c3.appendChild(g3);
    // card 4: WA prototype trial area (#220) - display-only: sends no
    // intents and attaches no user-event listeners; facts are published on
    // window.__waProtoStatus / __waBfProbe for the E2E smoke and the ADR.
    const c4 = el("div", "debugCard"); c4.id = "waProtoCard";
    const c4h = el("h3", "debugSection"); c4h.textContent = "WA 原型试验区（#220，只展示，不动任何设置）";
    c4.appendChild(c4h);
    const waRow1 = el("div"); waRow1.id = "waProtoRow";
    const waBtnPrimary = wa("wa-button"); waBtnPrimary.setAttribute("variant", "brand"); waBtnPrimary.textContent = "主操作预览";
    const waBtnNeutral = wa("wa-button"); waBtnNeutral.textContent = "次操作预览";
    const waSwitch = wa("wa-switch"); waSwitch.id = "waProtoSwitch";
    waRow1.appendChild(waBtnPrimary); waRow1.appendChild(waBtnNeutral); waRow1.appendChild(waSwitch);
    const waRow2 = el("div"); waRow2.id = "waProtoRow";
    const waInput = wa("wa-input"); waInput.id = "waProtoInput"; waInput.setAttribute("label", "示例输入");
    const waProtoSel = wa("wa-select"); waProtoSel.id = "waProtoSelect"; waProtoSel.setAttribute("label", "示例选择");
    for (const pair of [["a", "选项甲"], ["b", "选项乙"], ["c", "选项丙"]]) {
      const o = wa("wa-option"); o.setAttribute("value", pair[0]!); o.textContent = pair[1]!;
      waProtoSel.appendChild(o);
    }
    waRow2.appendChild(waInput); waRow2.appendChild(waProtoSel);
    const waStatus = el("div"); waStatus.id = "waProtoStatus"; waStatus.textContent = "WA 自检中……";
    const waBfWrap = el("div"); waBfWrap.id = "waBfWrap";
    const waBfGlass = el("div"); waBfGlass.id = "waBfGlass"; waBfGlass.textContent = "backdrop-filter 磨砂探针";
    waBfWrap.appendChild(waBfGlass);
    c4.appendChild(waRow1); c4.appendChild(waRow2); c4.appendChild(waStatus); c4.appendChild(waBfWrap);
    root.appendChild(c1); root.appendChild(c2); root.appendChild(c3); root.appendChild(c4);
    // The instrumentation below may finish before the first state push
    // builds this card; refresh the status line now that it exists.
    waRenderHook();
  }
  // patch
  setVal(document.getElementById("f_base_url") as WaCtl, String(fields.base_url ?? ""));
  setVal(document.getElementById("f_api_key") as WaCtl, String(fields.api_key ?? ""));
  setVal(document.getElementById("f_model") as WaCtl, String(fields.model ?? ""));
  const proto = document.getElementById("f_protocol") as WaCtl;
  if (document.activeElement !== proto) proto.value = String(fields.protocol ?? "auto");
  (document.getElementById("f_mock") as WaCtl).checked = Boolean(fields.mock);
  (document.getElementById("f_context") as WaCtl).checked = Boolean(fields.context_groups);
  const combo = document.getElementById("presetCombo") as WaCtl;
  const items = preset.items as Array<{ label: string; separator: boolean }>;
  const wantLabels = JSON.stringify(items.map((i) => i.label));
  const haveLabels = JSON.stringify((Array.from(combo.querySelectorAll("wa-option")) as WaCtl[]).map((o) => o.textContent));
  if (wantLabels !== haveLabels) {
    combo.innerHTML = "";
    for (const [idx, it] of items.entries()) {
      const o = wa("wa-option");
      o.setAttribute("value", String(idx));
      o.textContent = it.label;
      (o as WaCtl).disabled = it.separator;
      combo.appendChild(o);
    }
  }
  if (document.activeElement !== combo) {
    const idx = Number(preset.index ?? -1);
    combo.value = idx >= 0 ? String(idx) : "";
  }
  const editor = document.getElementById("promptEditor") as WaCtl;
  setVal(editor, String(preset.editor_text ?? ""));
  editor.readOnly = Boolean(preset.editor_readonly);
  (document.getElementById("copyBtn") as WaCtl).disabled = !preset.copy_enabled;
  (document.getElementById("renameBtn") as WaCtl).disabled = !preset.rename_enabled;
  (document.getElementById("deleteBtn") as WaCtl).disabled = !preset.delete_enabled;
  setVal(document.getElementById("promptPreview") as WaCtl, String(st.preview_text ?? ""));
  document.getElementById("testProgress")!.textContent = String(st.progress_text ?? "");
  (document.getElementById("testBtn") as WaCtl).disabled = !st.test_btn_enabled;
  (document.getElementById("cancelTestBtn") as WaCtl).disabled = !st.cancel_btn_enabled;
  setVal(document.getElementById("testReport") as WaCtl, String(st.report_text ?? ""));
}

// ---- tuning page ----
function buildTuningPage(root: HTMLElement, groups: Array<Record<string, unknown>>): void {
  root.innerHTML = "";
  for (const g of groups) {
    const card = el("div", "debugCard");
    const h = el("h3", "debugSection"); h.textContent = String(g.title); card.appendChild(h);
    // #222: the motion group leads with its preset buttons; the active one is
    // highlighted, a manual slider change un-highlights it (value-matched).
    const presets = (g.presets ?? []) as Array<{ name: string; label: string; active: boolean }>;
    if (presets.length > 0) {
      const prow = el("div", "btnrow");
      for (const p of presets) {
        const b = waBtn(p.label, p.active);
        b.addEventListener("click", () => send({ type: "anim-preset", name: p.name }));
        prow.appendChild(b);
      }
      card.appendChild(prow);
    }
    const grid = el("div", "grid");
    for (const f of g.fields as Array<Record<string, unknown>>) {
      const cap = el("label", "cap debugValue"); cap.textContent = String(f.label); grid.appendChild(cap);
      grid.appendChild(buildTuningControl(f));
      const hint = el("div", "hint debugHint"); hint.textContent = String(f.hint); grid.appendChild(hint);
    }
    card.appendChild(grid);
    root.appendChild(card);
  }
}

function buildTuningControl(f: Record<string, unknown>): HTMLElement {
  const kind = String(f.kind);
  const path = f.path as [string, string];
  const key = path.join(".");
  if (kind === "choice") {
    const choices = f.choices as string[];
    const labels = f.labels as string[];
    const sel = waSelect("", choices.map((c, i) => [c, labels[i] ?? c] as [string, string]));
    sel.dataset.path = key;
    (sel as WaCtl).value = String(f.value);
    (sel as WaCtl).disabled = !f.enabled;
    sel.addEventListener("change", () => send({ type: "tuning-set", path, value: (sel as WaCtl).value }));
    return sel;
  }
  if (kind === "color") {
    const btn = waBtn(String(f.color_text), false);
    btn.dataset.path = key;
    if (!f.enabled) (btn as WaCtl).disabled = true;
    const colorInput = document.getElementById("colorInput") as HTMLInputElement;
    btn.addEventListener("click", () => {
      colorInput.dataset.path = key;
      colorInput.value = String(f.color_text);
      colorInput.click();
    });
    return btn;
  }
  if (kind === "slider") {
    const row = el("div", "sliderrow");
    // #222: the step comes from the authority table (float-step motion
    // sliders keep decimals; bg_opacity stays the integer pair).
    const stepStr = String(f.step ?? 1);
    const slider = wa("wa-slider") as WaCtl;
    slider.setAttribute("min", String(f.min));
    slider.setAttribute("max", String(f.max));
    slider.setAttribute("step", stepStr);
    slider.value = String(f.value);
    const spin = wa("wa-input") as WaCtl;
    spin.setAttribute("type", "number");
    spin.setAttribute("min", String(f.min));
    spin.setAttribute("max", String(f.max));
    spin.setAttribute("step", stepStr);
    spin.value = String(f.value);
    const push2 = (v: string): void => send({ type: "tuning-set", path, value: Number(v) });
    slider.addEventListener("input", () => { spin.value = slider.value; push2(slider.value); });
    spin.addEventListener("input", () => { slider.value = spin.value; push2(spin.value); });
    row.appendChild(slider); row.appendChild(spin);
    row.dataset.path = key;
    return row;
  }
  const inp = wa("wa-input") as WaCtl;
  inp.setAttribute("type", "number");
  inp.setAttribute("min", String(f.min ?? ""));
  inp.setAttribute("max", String(f.max ?? ""));
  inp.setAttribute("step", kind === "int" ? String(f.step ?? 1) : "any");
  inp.value = String(f.value);
  inp.disabled = !f.enabled;
  inp.dataset.path = key;
  inp.addEventListener("input", () =>
    send({ type: "tuning-set", path, value: kind === "int" ? Math.trunc(Number(inp.value) || 0) : Number(inp.value) || 0 }));
  return inp;
}

// ---- diag page ----
function buildDiagPage(root: HTMLElement, d: Record<string, unknown>): void {
  if (root.dataset.built !== "1") {
    root.dataset.built = "1";
    const bar = el("div"); bar.id = "diagBar";
    const status = el("span"); status.id = "diagStatus";
    const stale = el("span", "debugStale"); stale.id = "diagStale";
    stale.textContent = "下面是上一次拿到的值，已经过期";
    bar.appendChild(status); bar.appendChild(stale);
    root.appendChild(bar);
    const zonesWrap = el("div"); zonesWrap.id = "diagZones";
    root.appendChild(zonesWrap);
    const footer = el("div"); footer.id = "diagFooter";
    const ct = waBtn("", false, "ctToggle");
    ct.addEventListener("click", () => send({ type: "ct-expand", expanded: !ct.dataset.expanded }));
    const freqLab = el("span", "debugHint"); freqLab.textContent = "多久刷新一次";
    const freq = waSelect("diagFreq");
    for (const gear of [0.5, 1.0, 2.0]) {
      const o = wa("wa-option"); o.setAttribute("value", String(gear)); o.textContent = gear + " 秒";
      freq.appendChild(o);
    }
    freq.addEventListener("change", () => send({ type: "frequency", seconds: Number((freq as WaCtl).value) }));
    const copy = waBtn("复制全部内容", false, "diagCopy");
    copy.addEventListener("click", () => send({ type: "copy-all" }));
    const refresh = waBtn("立刻刷新一次", true, "diagRefresh");
    refresh.addEventListener("click", () => send({ type: "refresh" }));
    footer.appendChild(ct); footer.appendChild(freqLab); footer.appendChild(freq);
    footer.appendChild(copy); footer.appendChild(refresh);
    root.appendChild(footer);
  }
  const status = document.getElementById("diagStatus")!;
  const level = String((d.bar as Record<string, unknown>).level);
  status.textContent = String((d.bar as Record<string, unknown>).text);
  status.className = level === "error" ? "debugError" : (level === "warn" ? "debugValue" : "debugValue");
  document.getElementById("diagStale")!.style.display = d.stale ? "" : "none";
  const zonesWrap = document.getElementById("diagZones")!;
  zonesWrap.innerHTML = "";
  for (const z of d.zones as Array<Record<string, unknown>>) {
    const card = el("div", "debugCard zone");
    const head = el("div", "zonehead");
    const t = el("h3", "debugSection"); t.textContent = String(z.title); head.appendChild(t);
    const badge = z.badge as [string, string] | null;
    if (badge) {
      const b = el("span", "debugBadge" + (badge[1] === "error" ? "Error" : badge[1] === "warn" ? "Warn" : "Ok"));
      b.textContent = badge[0];
      head.appendChild(b);
    }
    card.appendChild(head);
    if (z.name === "events") {
      const view = el("div"); view.id = "eventsView";
      view.textContent = (z.rows as Array<[string, string]>)
        .map(([l, v]) => (l ? l + "  " + v : v)).join("\n");
      card.appendChild(view);
    } else {
      const rows = el("div", "zonerows");
      for (const [l, v] of z.rows as Array<[string, string]>) {
        const lab = el("span", "debugHint"); lab.textContent = l; rows.appendChild(lab);
        const val = el("span", "zval " + (l === "服务端错误" || l === "状态提供者错误" || l === "页面钩子" || l === "字幕抓取" ? "debugError" : "debugValue"));
        val.textContent = v;
        rows.appendChild(val);
      }
      card.appendChild(rows);
    }
    zonesWrap.appendChild(card);
  }
  const ct = document.getElementById("ctToggle") as WaCtl;
  ct.textContent = String(d.ct_label);
  ct.disabled = !d.ct_enabled;
  ct.dataset.expanded = d.ct_expanded ? "1" : "";
  const freq = document.getElementById("diagFreq") as WaCtl;
  if (document.activeElement !== freq) freq.value = String(d.frequency);
}

// ---- top-level apply ----
function apply(s: unknown): void {
  const st = s as Record<string, unknown>;
  focusedEl = document.activeElement;
  current = String(st.current_page);
  buildSwitch(st);
  const foot = st.footer as Record<string, unknown>;
  document.getElementById("footerStatus")!.textContent = String(foot.status);
  (document.getElementById("saveBtn") as WaCtl).disabled = !foot.save_enabled;
  document.getElementById("debugHint")!.textContent =
    [String(st.version ?? ""), String(st.env ?? "")].filter(Boolean).join(" · ");
  const geo = st.geometry as Record<string, number>;
  void geo; // geometry is owned by the OS window; model fit happens main-side
  buildSettingsPage(document.getElementById("page-settings")!, st.settings as Record<string, unknown>);
  buildTuningPage(document.getElementById("page-tuning")!, st.tuning as Array<Record<string, unknown>>);
  buildDiagPage(document.getElementById("page-diag")!, st.diag as Record<string, unknown>);
  for (const name of ["settings", "tuning", "diag"]) {
    document.getElementById("page-" + name)!.classList.toggle("active", name === current);
  }
}

// ---- chrome wiring ----
document.getElementById("closeBtn")!.addEventListener("click", () => send({ type: "close" }));
document.getElementById("cancelBtn")!.addEventListener("click", () => send({ type: "cancel" }));
document.getElementById("saveBtn")!.addEventListener("click", () => send({ type: "save" }));
document.getElementById("colorInput")!.addEventListener("change", function (this: HTMLInputElement) {
  // #RRGGBB -> [r,g,b]; cancelling the picker fires no change event.
  const hex = this.value.replace("#", "");
  const rgb = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  const path = (this.dataset.path || "").split(".");
  if (path.length === 2) send({ type: "color-set", path, rgb });
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { send({ type: "esc" }); e.preventDefault(); return; }
  if (e.ctrlKey && (e.key === "s" || e.key === "S")) { send({ type: "ctrl-s" }); e.preventDefault(); }
});
debugBridge.onDebugCopyText((t) => { void navigator.clipboard.writeText(t); });
debugBridge.onDebugState(apply);

// ---- #220 WA prototype instrumentation (display-only; zero intents) ----
// The vendored autoloader is a deferred module script: this classic script
// runs first, so the console.warn tap below catches its per-tag load
// failures (the autoloader warns instead of throwing). Upgrade facts and
// the backdrop-filter probe feed the E2E smoke (#220 acceptance 3) and the
// ADR verdict (#220 acceptance 2). #216 migrated the real controls too; the
// instance counting stays scoped to the prototype card so the E2E evidence
// keeps measuring exactly what it always measured.
interface WaProtoGlobals {
  __waProtoStatus?: Record<string, unknown>;
  __waProtoRender?: () => void;
  __waBfProbe?: { supported: boolean; fps: number | null };
  __waScriptError?: string;
}
const waGlobals = window as unknown as WaProtoGlobals;
const WA_TAGS = ["wa-button", "wa-input", "wa-select", "wa-option", "wa-switch"];
const waAutoloadWarns: string[] = [];
const waOrigWarn = console.warn.bind(console);
console.warn = ((...args: unknown[]) => {
  waAutoloadWarns.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  waOrigWarn(...args);
}) as typeof console.warn;
const waProtoStatus: Record<string, unknown> = waGlobals.__waProtoStatus = {
  tags: {} as Record<string, boolean>,
  defined: 0, total: 0, upgraded: 0,
  discoveryComplete: false,
  autoloadWarns: waAutoloadWarns,
};
function waRefreshUpgrades(): void {
  const tags = waProtoStatus.tags as Record<string, boolean>;
  let defined = 0;
  for (const t of WA_TAGS) {
    const has = Boolean(customElements.get(t));
    tags[t] = has;
    if (has) defined++;
  }
  // Probe facts come from the prototype card's subtree only (see comment above).
  const card = document.getElementById("waProtoCard");
  const nodes = card ? Array.from(card.querySelectorAll(WA_TAGS.join(","))) : [];
  let upgraded = 0;
  for (const node of nodes) {
    if ((node as HTMLElement).shadowRoot) upgraded++;
  }
  waProtoStatus.defined = defined;
  waProtoStatus.total = nodes.length;
  waProtoStatus.upgraded = upgraded;
}
function waStatusText(): string {
  const tags = waProtoStatus.tags as Record<string, boolean>;
  const missing = WA_TAGS.filter((t) => !tags[t]);
  const bf = waGlobals.__waBfProbe;
  const bfText = bf
    ? "；backdrop-filter " + (bf.supported ? "支持" : "不支持") +
      "，磨砂层刷新实测 " + (bf.fps === null ? "…" : String(bf.fps)) + " fps（2s rAF 采样）"
    : "";
  if (missing.length === 0) {
    return "WA 自检通过：5 个标签全部定义，" + String(waProtoStatus.upgraded) + "/" + String(waProtoStatus.total) +
      " 实例已挂 shadowRoot" + (waProtoStatus.discoveryComplete ? "，autoloader 扫描完成" : "") + bfText;
  }
  return "WA 自检未过：未定义 " + missing.join(", ") +
    (waAutoloadWarns.length ? "；autoloader 警告：" + waAutoloadWarns.join(" | ") : "") +
    (waGlobals.__waScriptError ? "；模块加载失败：" + waGlobals.__waScriptError : "") + bfText;
}
function waRenderHook(): void {
  const line = document.getElementById("waProtoStatus");
  if (line) line.textContent = waStatusText();
}
waGlobals.__waProtoRender = waRenderHook;
document.addEventListener("wa-discovery-complete", () => {
  waProtoStatus.discoveryEvent = true;
  waRefreshUpgrades();
  waRenderHook();
});
// "Settled" means the honest verdict: every tag defined and every instance
// upgraded. The autoloader's first discovery-complete can fire before this
// classic-script-built card exists (module scripts are deferred, the card
// builds on the first debug-state push), so settle on facts, not the event.
function waSettled(): boolean {
  const total = waProtoStatus.total as number;
  return waProtoStatus.defined === WA_TAGS.length &&
    total >= WA_TAGS.length &&
    (waProtoStatus.upgraded as number) === total;
}
(function waPollUpgrades(): void {
  waRefreshUpgrades();
  if (waSettled()) waProtoStatus.discoveryComplete = true;
  waRenderHook();
  if (!waProtoStatus.discoveryComplete) window.setTimeout(waPollUpgrades, 250);
})();
const waBfSupported = typeof CSS !== "undefined" &&
  (CSS.supports("backdrop-filter", "blur(12px)") || CSS.supports("-webkit-backdrop-filter", "blur(12px)"));
const waBf: { supported: boolean; fps: number | null } = waGlobals.__waBfProbe =
  { supported: waBfSupported, fps: null };
if (waBfSupported) {
  const waBfT0 = performance.now();
  let waBfFrames = 0;
  const waBfStep = (t: number): void => {
    waBfFrames++;
    if (t - waBfT0 < 2000) { requestAnimationFrame(waBfStep); return; }
    waBf.fps = Math.round(waBfFrames / ((t - waBfT0) / 1000));
    waRenderHook();
  };
  requestAnimationFrame(waBfStep);
} else {
  waRenderHook();
}
