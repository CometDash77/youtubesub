// The Electron host for the settings/debug window (#205). Owns the
// headless DebugWindow model + its single, permanently-reused BrowserWindow,
// mirrors model state to the bare-DOM renderer ("debug-state" pushes), and
// forwards renderer intents back into the model ("debug-intent").
//
// This is the #204 pattern scaled up: the main process decides everything,
// the renderer is a dumb applier. The window-level semantics the map pins
// live here: one instance for both menu entries landing on different pages,
// window-level single save/cancel, the three-way close prompt (synchronous
// Electron message box inside the model's ask seam), first-show resnapshot,
// Ctrl+S save-without-close / Esc close. The renderer-side X/Esc route goes
// through the same debug.close() confirm flow; a real window close (Alt+F4)
// is intercepted and routed identically (hide, never destroy - the model
// instance is permanent).
import { BrowserWindow, dialog, screen } from "electron";
import path from "node:path";
import * as S from "./settings.ts";
import { ConnectionTester } from "./connection-test.ts";
import {
  DebugWindow, CONFIRM_SAVE, CONFIRM_DISCARD, CONFIRM_STAY,
  type OverlayNotify,
} from "./debug/window.ts";

export interface DebugHostDeps {
  settings: S.Settings;
  overlay: OverlayNotify;           // reread_settings target (the overlay display)
  appRoot: string;
  log?: (m: string) => void;
}

interface Intent {
  type?: unknown;
  [k: string]: unknown;
}

export interface DebugHost {
  open(page: string): void;
  debug: DebugWindow;
  handleIntent(raw: unknown): void;
  markQuitting(): void;
}

export function createDebugWindowHost(deps: DebugHostDeps): DebugHost {
  const log = deps.log ?? (() => {});
  let win: BrowserWindow | null = null;
  let closing = false;              // set by before-quit so quit is never blocked

  // The page's 200ms progress poll: a real interval that also pushes state
  // (the QTimer seam the headless model leaves injectable).
  let pollTimer: NodeJS.Timeout | null = null;
  const poll_seam = {
    start(): void {
      if (pollTimer !== null) return;
      pollTimer = setInterval(() => {
        debug.settings_page.poll_progress();
        pushState();
      }, 200);
    },
    stop(): void {
      if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
    },
  };

  const debug = new DebugWindow(deps.settings, {
    overlay: deps.overlay,
    tester: new ConnectionTester(),
    save: (cfg) => { S.save(cfg as S.Settings); },
    poll_timer: poll_seam,
    ask_unsaved_changes: (info) => {
      // Three-way close prompt; the default button is 回去继续改 (Enter and
      // Esc both land there) - Esc still means "close the window", not
      // "throw away".
      const buttons = ["回去继续改", "保存并关闭", "不保存，直接关闭"];
      const detail = [
        "关掉窗口，还没保存的改动会丢掉。",
        info.settings_dirty ? "\n设置页里没保存的密钥（API Key）和提示词会一起丢掉。" : "",
        info.tuning_dirty ? "\n调参页改过的数值会回到原样。" : "",
      ].join("");
      const opts = {
        type: "warning" as const,
        title: "有改动还没保存",
        message: detail,
        buttons,
        defaultId: 0,
        cancelId: 0,
        noLink: true as const,
      };
      const r = win
        ? dialog.showMessageBoxSync(win, opts)
        : dialog.showMessageBoxSync(opts);
      return r === 1 ? CONFIRM_SAVE : (r === 2 ? CONFIRM_DISCARD : CONFIRM_STAY);
    },
    screen_avail: () => {
      try {
        const area = screen.getPrimaryDisplay().workAreaSize;
        return { w: area.width, h: area.height };
      } catch {
        return null;
      }
    },
  });

  function pushState(): void {
    try {
      win?.webContents.send("debug-state", serialize(debug));
    } catch {
      // the window can vanish mid-push; never fatal
    }
  }

  debug.on_change(() => pushState());

  function applyBounds(): void {
    const w = win;
    if (!w) return;
    const b = w.getBounds();
    if (b.width !== debug.width || b.height !== debug.height) {
      w.setBounds({ x: b.x, y: b.y, width: debug.width, height: debug.height });
    }
  }

  function createWindow(): void {
    win = new BrowserWindow({
      width: debug.width,
      height: debug.height,
      minWidth: 560,
      minHeight: 360,
      frame: false,          // frameless, self-drawn chrome
      transparent: true,     // the panel inside is opaque cream (tokens.ts);
                             // transparency only serves the rounded corners
      resizable: true,       // frameless edge resizing is native in Electron
      skipTaskbar: true,     // Qt.Tool: a palette, not a task
      title: "设置与调试",
      show: false,
      webPreferences: {
        preload: path.join(deps.appRoot, "dist", "preload", "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.webContents.on("preload-error", (_e, p, err) => log("[debug] preload-error " + p + " : " + err.message));
    win.on("show", () => {
      debug.show();          // first show after hide: resnapshot + refit
      applyBounds();
      pushState();
    });
    win.on("hide", () => {
      debug.hide();
      pushState();
    });
    // Frameless windows still receive a close (Alt+F4, app quit): route it
    // through the model's confirm flow and hide - the instance is permanent.
    win.on("close", (e) => {
      if (closing) return;   // app quit: let it go
      e.preventDefault();
      if (debug.close()) {
        pushState();
        win?.hide();
      }
    });
    void win.loadFile(path.join(deps.appRoot, "dist", "renderer", "debug.html"));
  }

  function open(page: string): void {
    if (!win) createWindow();
    debug.show_page(page);
    if (win && !win.isVisible()) {
      win.show();
    } else {
      // Already visible: show() would not refire the show-event in Qt either.
      applyBounds();
      pushState();
    }
  }

  function num(v: unknown, d: number): number {
    return typeof v === "number" ? v : d;
  }

  function handleIntent(raw: unknown): void {
    const it = (raw ?? {}) as Intent;
    const sp = debug.settings_page;
    const tp = debug.tuning_page;
    const dp = debug.diag_page;
    switch (it.type) {
      case "switch-page": debug.show_page(String(it.page ?? "")); break;
      case "edit-credential":
        switch (it.field) {
          case "base_url": sp.set_base_url(String(it.value ?? "")); break;
          case "api_key": sp.set_api_key(String(it.value ?? "")); break;
          case "model": sp.set_model(String(it.value ?? "")); break;
          case "protocol": sp.set_protocol(String(it.value ?? "auto")); break;
          case "mock": sp.set_mock(Boolean(it.value)); break;
          case "context_groups": sp.set_context_groups(Boolean(it.value)); break;
          default: break;
        }
        break;
      case "preset-select": sp.select_preset_index(Math.trunc(num(it.index, -1))); break;
      case "preset-copy": sp.click_copy(); break;
      case "preset-rename": sp.click_rename(typeof it.name === "string" ? it.name : undefined); break;
      case "preset-delete": sp.click_delete(); break;
      case "prompt-text": sp.set_prompt_text(String(it.text ?? "")); break;
      case "test-start": sp.click_test(); break;
      case "test-cancel": sp.click_cancel_test(); break;
      case "tuning-set": {
        const p = Array.isArray(it.path) ? it.path as [string, string] : null;
        if (p) tp.set_field_value(p, (it.value ?? 0) as S.Json);
        break;
      }
      case "color-set": {
        const p = Array.isArray(it.path) ? it.path as [string, string] : null;
        const rgb = Array.isArray(it.rgb) ? (it.rgb as unknown[]).map((c) => num(c, 0)) : null;
        if (p && rgb && rgb.length === 3) tp.set_field_value(p, rgb as unknown as S.Json);
        break;
      }
      case "save": debug.save(); break;
      case "ctrl-s": debug.save_via_shortcut(); break;
      case "cancel": debug.cancel(); break;
      case "close":
      case "esc": debug.close(); break;
      case "frequency": dp.set_frequency(num(it.seconds, 1.0)); break;
      case "refresh": dp.refresh_now(); break;
      case "ct-expand": dp.set_connection_test_expanded(Boolean(it.expanded)); break;
      case "copy-all": {
        // The headless page owns the text; the renderer performs the actual
        // clipboard write (navigator.clipboard).
        win?.webContents.send("debug-copy-text", dp.copy_all_text());
        break;
      }
      default: break;
    }
    pushState();
  }

  function serialize(w: DebugWindow): Record<string, unknown> {
    const sp = w.settings_page;
    const tp = w.tuning_page;
    const dp = w.diag_page;
    return {
      visible: w.visible,
      current_page: w.current_page_name(),
      geometry: { width: w.width, height: w.height },
      footer: { status: w.status_label_text, save_enabled: w.save_button_enabled },
      env: w.env_label(),
      settings: {
        fields: {
          base_url: sp.base_url, api_key: sp.api_key, model: sp.model,
          protocol: sp.protocol, mock: sp.mock, context_groups: sp.context_groups,
        },
        preset: {
          items: sp.preset_items, index: sp.preset_index,
          editor_text: sp.editor_text, editor_readonly: sp.editor_readonly,
          copy_enabled: sp.copy_btn_enabled, rename_enabled: sp.rename_btn_enabled,
          delete_enabled: sp.delete_btn_enabled,
        },
        preview_text: sp.preview_text,
        progress_text: sp.progress_text,
        report_text: sp.report_text,
        test_btn_enabled: sp.test_btn_enabled,
        cancel_btn_enabled: sp.cancel_btn_enabled,
      },
      tuning: tp.groups().map((g) => ({
        group: g.group,
        title: g.title,
        fields: g.fields.map((f) => ({
          path: f.path,
          label: tp.label_text(f),
          hint: tp.hint_for(f.path),
          kind: f.control,
          value: tp.field_value(f.path),
          min: f.min, max: f.max, step: f.step,
          choices: f.choices, labels: f.labels,
          enabled: tp.is_field_enabled(f.path),
          color_text: f.control === "color" ? tp.color_text(tp.field_value(f.path) as number[]) : "",
        })),
      })),
      diag: {
        bar: { text: dp.status_bar_text(), level: dp.status_bar_level() },
        stale: dp.zones_stale(),
        zones: [
          { name: "link", title: "① 浏览器插件连接" },
          { name: "playback", title: "② 播放与字幕" },
          { name: "queue", title: "③ 翻译队列" },
          { name: "events", title: "④ 事件记录" },
        ].map((z) => ({
          name: z.name,
          title: z.title,
          badge: dp.zone_badge(z.name) ?? null,
          rows: dp.zone_rows(z.name),
        })),
        ct_label: dp.ct_button_label(),
        ct_enabled: dp.ct_button_enabled(),
        ct_expanded: dp.connection_test_expanded(),
        frequency: dp.frequency(),
      },
    };
  }

  return {
    open,
    debug,
    // main.ts wires these: the ipcMain debug-intent listener and the
    // before-quit flag (so a pending close prompt never blocks quitting).
    handleIntent,
    markQuitting() { closing = true; },
  };
}
