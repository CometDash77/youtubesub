// Settings/debug window renderer (#205). The headless model
// (src/main/debug/*.ts) decides everything; the main process owns the instance
// and pushes ready-to-render state ("debug-state"); this file is a dumb
// applier that forwards user intents ("debug-intent").
//
// Must stay import-free (classic script over file://, see tsconfig.build.json
// and the #204 renderer pitfall): the state/intent schemas here mirror the
// wire, not the lib types.
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
    const input = el("input") as HTMLInputElement; input.type = "text"; input.id = "renameInput";
    box.appendChild(input);
    const row = el("div", "btnrow");
    const ok = el("button", "push debugPrimary"); ok.textContent = "确定";
    const cancel = el("button", "push"); cancel.textContent = "取消";
    ok.addEventListener("click", () => {
      send({ type: "preset-rename", name: input.value.trim() });
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
  const current = (document.getElementById("presetCombo") as HTMLSelectElement);
  const inp = document.getElementById("renameInput") as HTMLInputElement;
  inp.value = current.options[current.selectedIndex]?.text ?? "";
  modal.style.display = "flex";
  inp.focus();
}

function setVal(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
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
      const b = el("button");
      b.dataset.page = name;
      b.textContent = titles[name] ?? name;
      b.addEventListener("click", () => send({ type: "switch-page", page: name }));
      bar.appendChild(b);
    }
  }
  for (const c of Array.from(bar.children)) {
    (c as HTMLElement).classList.toggle("active", c === undefined ? false : (c as HTMLElement).dataset.page === current);
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
        const sel = el("select"); sel.id = "f_protocol";
        for (const p of PROTOCOLS) {
          const o = el("option"); o.value = p; o.textContent = p; sel.appendChild(o);
        }
        sel.addEventListener("change", () => send({ type: "edit-credential", field: "protocol", value: sel.value }));
        ctl = sel;
      } else if (row.key === "mock") {
        const cb = el("input"); cb.type = "checkbox"; cb.id = "f_mock";
        const lab = el("label"); lab.textContent = "Mock 模式：不真的调用 API，只在试界面时用";
        lab.appendChild(cb); lab.appendChild(document.createTextNode(" Mock 模式：不真的调用 API，只在试界面时用"));
        lab.removeChild(cb); lab.insertBefore(cb, lab.firstChild);
        cb.addEventListener("change", () => send({ type: "edit-credential", field: "mock", value: cb.checked }));
        ctl = lab;
      } else {
        const inp = el("input"); inp.type = row.key === "api_key" ? "password" : "text";
        inp.id = "f_" + row.key;
        inp.addEventListener("input", () => send({ type: "edit-credential", field: row.key, value: inp.value }));
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
    const combo = el("select"); combo.id = "presetCombo";
    combo.addEventListener("change", () => send({ type: "preset-select", index: combo.selectedIndex }));
    g2.appendChild(combo);
    const h1 = el("div", "debugHint"); h1.textContent = "内置的三套只读；想改就先「复制为自定义」"; g2.appendChild(h1);
    g2.appendChild(el("span"));
    const btns = el("div", "btnrow");
    for (const [id, label, intent] of [
      ["copyBtn", "复制为自定义", "preset-copy"],
      ["renameBtn", "重命名", "preset-rename"],
      ["deleteBtn", "删除", "preset-delete"],
    ] as Array<[string, string, string]>) {
      const b = el("button", "push"); b.id = id; b.textContent = label;
      b.addEventListener("click", () => {
        if (intent === "preset-rename") { openRenameModal(); return; }
        send({ type: intent });
      });
      btns.appendChild(b);
    }
    btns.className = "btnrow rowspan";
    g2.appendChild(btns);
    const cap2 = el("label", "cap debugValue"); cap2.textContent = "提示词内容"; g2.appendChild(cap2);
    const editor = el("textarea"); editor.id = "promptEditor"; editor.style.height = "90px";
    editor.addEventListener("input", () => send({ type: "prompt-text", text: editor.value }));
    const ed = editor as HTMLTextAreaElement; ed.className = "rowspan";
    g2.appendChild(editor);
    const h2 = el("div", "debugHint span-hint"); h2.textContent = "这就是发给模型的指令；内置的只读，复制出来的才能改"; g2.appendChild(h2);
    const cap3 = el("label", "cap debugValue"); cap3.textContent = "实际发出去的提示词"; g2.appendChild(cap3);
    const preview = el("textarea"); preview.id = "promptPreview"; preview.readOnly = true; preview.style.height = "90px";
    preview.className = "rowspan";
    g2.appendChild(preview);
    const h3 = el("div", "debugHint span-hint"); h3.textContent = "下面这段就是真正发出去的内容，改上面会立刻跟着变"; g2.appendChild(h3);
    g2.appendChild(el("span"));
    const ctxLab = el("label");
    const ctx = el("input"); ctx.type = "checkbox"; ctx.id = "f_context";
    ctxLab.appendChild(ctx);
    ctxLab.appendChild(document.createTextNode(" 携带上下文：把上一句、下一句也一起发给模型"));
    ctx.addEventListener("change", () => send({ type: "edit-credential", field: "context_groups", value: ctx.checked }));
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
    const testBtn = el("button", "push debugPrimary"); testBtn.id = "testBtn"; testBtn.textContent = "测试连接";
    testBtn.addEventListener("click", () => send({ type: "test-start" }));
    const cancelBtn = el("button", "push"); cancelBtn.id = "cancelTestBtn"; cancelBtn.textContent = "取消测试";
    cancelBtn.addEventListener("click", () => send({ type: "test-cancel" }));
    testBtns.appendChild(testBtn); testBtns.appendChild(cancelBtn);
    g3.appendChild(testBtns);
    const hTest = el("div", "debugHint span-hint");
    hTest.textContent = "测的是上面填的、还没保存的输入；不落盘、不动浮窗";
    g3.appendChild(hTest);
    const capP = el("label", "cap debugValue"); capP.textContent = "测试进度"; g3.appendChild(capP);
    const prog = el("span", "debugHint"); prog.id = "testProgress"; g3.appendChild(prog);
    g3.appendChild(el("span"));
    const capR = el("label", "cap debugValue"); capR.textContent = "测试报告"; g3.appendChild(capR);
    const report = el("textarea"); report.id = "testReport"; report.readOnly = true;
    report.style.height = "150px"; report.className = "rowspan";
    g3.appendChild(report);
    const hRep = el("div", "debugHint span-hint"); hRep.textContent = "上一次的结果会一直留在这里"; g3.appendChild(hRep);
    c3.appendChild(g3);
    root.appendChild(c1); root.appendChild(c2); root.appendChild(c3);
  }
  // patch
  setVal(document.getElementById("f_base_url") as HTMLInputElement, String(fields.base_url ?? ""));
  setVal(document.getElementById("f_api_key") as HTMLInputElement, String(fields.api_key ?? ""));
  setVal(document.getElementById("f_model") as HTMLInputElement, String(fields.model ?? ""));
  const proto = document.getElementById("f_protocol") as HTMLSelectElement;
  if (document.activeElement !== proto) proto.value = String(fields.protocol ?? "auto");
  (document.getElementById("f_mock") as HTMLInputElement).checked = Boolean(fields.mock);
  (document.getElementById("f_context") as HTMLInputElement).checked = Boolean(fields.context_groups);
  const combo = document.getElementById("presetCombo") as HTMLSelectElement;
  const items = preset.items as Array<{ label: string; separator: boolean }>;
  const wantLabels = JSON.stringify(items.map((i) => i.label));
  const haveLabels = JSON.stringify(Array.from(combo.options).map((o) => o.text));
  if (wantLabels !== haveLabels) {
    combo.innerHTML = "";
    for (const it of items) {
      const o = el("option");
      o.text = it.label;
      o.disabled = it.separator;
      combo.add(o);
    }
  }
  if (document.activeElement !== combo) combo.selectedIndex = Number(preset.index ?? -1);
  const editor = document.getElementById("promptEditor") as HTMLTextAreaElement;
  setVal(editor, String(preset.editor_text ?? ""));
  editor.readOnly = Boolean(preset.editor_readonly);
  (document.getElementById("copyBtn") as HTMLButtonElement).disabled = !preset.copy_enabled;
  (document.getElementById("renameBtn") as HTMLButtonElement).disabled = !preset.rename_enabled;
  (document.getElementById("deleteBtn") as HTMLButtonElement).disabled = !preset.delete_enabled;
  setVal(document.getElementById("promptPreview") as HTMLTextAreaElement, String(st.preview_text ?? ""));
  document.getElementById("testProgress")!.textContent = String(st.progress_text ?? "");
  (document.getElementById("testBtn") as HTMLButtonElement).disabled = !st.test_btn_enabled;
  (document.getElementById("cancelTestBtn") as HTMLButtonElement).disabled = !st.cancel_btn_enabled;
  setVal(document.getElementById("testReport") as HTMLTextAreaElement, String(st.report_text ?? ""));
}

// ---- tuning page ----
function buildTuningPage(root: HTMLElement, groups: Array<Record<string, unknown>>): void {
  root.innerHTML = "";
  for (const g of groups) {
    const card = el("div", "debugCard");
    const h = el("h3", "debugSection"); h.textContent = String(g.title); card.appendChild(h);
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
    const sel = el("select"); sel.dataset.path = key;
    const choices = f.choices as string[];
    const labels = f.labels as string[];
    choices.forEach((c, i) => {
      const o = el("option"); o.value = c; o.textContent = labels[i] ?? c; sel.appendChild(o);
    });
    sel.value = String(f.value);
    sel.disabled = !f.enabled;
    sel.addEventListener("change", () => send({ type: "tuning-set", path, value: sel.value }));
    return sel;
  }
  if (kind === "color") {
    const btn = el("button", "push"); btn.textContent = String(f.color_text);
    btn.dataset.path = key;
    if (!f.enabled) btn.disabled = true;
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
    const slider = el("input") as HTMLInputElement; slider.type = "range";
    slider.min = String(f.min); slider.max = String(f.max); slider.step = "1";
    slider.value = String(f.value);
    const spin = el("input") as HTMLInputElement; spin.type = "number";
    spin.min = String(f.min); spin.max = String(f.max); spin.step = "1";
    spin.value = String(f.value);
    const push2 = (v: string): void => send({ type: "tuning-set", path, value: Number(v) });
    slider.addEventListener("input", () => { spin.value = slider.value; push2(slider.value); });
    spin.addEventListener("input", () => { slider.value = spin.value; push2(spin.value); });
    row.appendChild(slider); row.appendChild(spin);
    row.dataset.path = key;
    return row;
  }
  const inp = el("input") as HTMLInputElement; inp.type = "number";
  inp.min = String(f.min ?? ""); inp.max = String(f.max ?? "");
  inp.step = kind === "int" ? String(f.step ?? 1) : "any";
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
    const ct = el("button", "push"); ct.id = "ctToggle";
    ct.addEventListener("click", () => send({ type: "ct-expand", expanded: !ct.dataset.expanded }));
    const freqLab = el("span", "debugHint"); freqLab.textContent = "多久刷新一次";
    const freq = el("select"); freq.id = "diagFreq";
    for (const gear of [0.5, 1.0, 2.0]) {
      const o = el("option"); o.value = String(gear); o.textContent = gear + " 秒"; freq.appendChild(o);
    }
    freq.addEventListener("change", () => send({ type: "frequency", seconds: Number(freq.value) }));
    const copy = el("button", "push"); copy.id = "diagCopy"; copy.textContent = "复制全部内容";
    copy.addEventListener("click", () => send({ type: "copy-all" }));
    const refresh = el("button", "push debugPrimary"); refresh.id = "diagRefresh"; refresh.textContent = "立刻刷新一次";
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
  const ct = document.getElementById("ctToggle") as HTMLButtonElement;
  ct.textContent = String(d.ct_label);
  ct.disabled = !d.ct_enabled;
  ct.dataset.expanded = d.ct_expanded ? "1" : "";
  const freq = document.getElementById("diagFreq") as HTMLSelectElement;
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
  (document.getElementById("saveBtn") as HTMLButtonElement).disabled = !foot.save_enabled;
  document.getElementById("debugHint")!.textContent = String(st.env ?? "");
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
