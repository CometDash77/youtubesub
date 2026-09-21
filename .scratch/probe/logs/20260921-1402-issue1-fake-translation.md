# issue #1：未配置模型时的「【译】」= mock 被自动打开 + mock 回显原文（2026-09-21）

## 症状（用户报告，issue #1）
没填任何模型，浮窗仍出现**一个乃至于数个【译】标签**，标签下的内容其实是原文。期望：原文就显示原文。

## 根因（两层，缺一不成 bug）
1. **mock 被自动打开**：`desktop/suboverlay/engine.py:115-116`（修复前）
   ```python
   if not prov.get("base_url") or prov.get("mock"):
       prov["mock"] = True
   ```
   "没配 base_url" 被当成"用户开了 Mock 模式"。默认设置 `base_url=""`、`model=""`、无 `mock` 键
   （`desktop/suboverlay/settings.py:11-12`）→ 每个用户默认都落进 mock 分支。
2. **mock 的产物就是"【译】+原文"**：`engine.py:141` / `engine.py:147`（修复前）
   对齐模式下组内每条 cue 各加一个 `【译】` 前缀 —— 这正是用户看到的"数个【译】"。
   `docs/DESIGN.md:56` 写明 mock 是"无真实 Key 时的**验证替身**"，不是产品行为；设置面板里它是一个
   显式勾选框（`desktop/app.py:33-34`）。把它当默认值 = 把替身当产品。

**为什么自动化测试看不见**：所有期待译文的测试都显式写 `s["provider"]["mock"] = True`
（`desktop/tests/test_engine.py:11,131`；`desktop/tests/browser_e2e.py:557`），没人测"没配模型"这条路径。

## 复现（修复前，实测）
真实 Engine，默认设置，**不启 Chrome / 不启 Qt**：
```json
{"default_provider_has_mock_key": false, "default_base_url": "''",
 "display_orig": "the cat sat down",
 "display_trans": "\u3010\u8bd1\u3011the cat sat down",
 "trans_is_orig_with_prefix": true}
```
组内 2 条 cue 时 mock 对齐输出 = `【译】the cat sat` + `【译】the cat sat down` → 屏幕上**两个【译】**，
与报告"一个乃至于数个"逐字吻合。

## 判决标准（先红，且回退可复现）
新增 `desktop/tests/test_engine.py::test_unconfigured_provider_never_fabricates_a_translation`
（只断言用户可见行为：原文仍在 + trans 空串；**不断言 `_queue.stats()`** —— gate 放哪是实现细节，
按 tdd 技能的反模式清单，测试不该绑死实现位置）：

| 时点 | 命令 | 结果 |
|---|---|---|
| 修复前 | `pytest ... -q -k unconfigured` | exit 1：`AssertionError: an unconfigured provider must not produce a translation`（`assert '【译】the 【译】cat sat the cat sat down' == ''`） |
| 修复后 | 同命令 | exit 0 |
| **把修复回退**（两处还原成修复前写法，跑完 finally 恢复） | 同命令 | **exit 1，同一条断言** → 证明这条测试真的咬住这个 bug，而不是"恰好绿" |
| 恢复（sha256 校验与修复版逐字节相同 `21717fb034559db9…`） | 同命令 | exit 0 |

原始输出：`20260921T1402-issue1-no-fake-translation-red.txt` / `…-green.txt`。

## 修复（`desktop/suboverlay/engine.py`，三处）
- 新增 `_provider_usable(prov)`：**可用 = 显式 mock，或 base_url 与 model 都非空**
  （与 `settings.redact()` 的 "configured" 同一口径）。
- `_submit_group`：不可用 → **不投递任何任务**（不是"投了再失败"）。
- `_default_translate`：mock 分支只认 `prov.get("mock")`；不可用时返回 `NOT_CONFIGURED`（纵深防御，
  覆盖"任务已排队后用户又清空了设置"）。

## 修复后实测（绿）
```json
{"A_no_model_no_mock":        {"orig": "the cat sat down", "trans": "", "queue": {"pending": 0, "inflight": 0}},
 "B_mock_explicit":           {"trans": "【译】the 【译】cat sat the cat sat down", "queue": {"pending": 0, "inflight": 0}},
 "C_base_url_and_model":      {"trans": "", "queue": {"pending": 0, "inflight": 0}}}
```
- A：没配模型 → **trans 空串**（浮窗只剩原文），且**零任务入队**（不空转）。
- B：显式 Mock → 行为不变（E2E / 演示 / L1 仍可用）。
- C：配了但端点不可达 → 也是空串（不崩、不污染原字幕），真实链路未被 gate 影响。
- `python -m pytest desktop/tests/test_engine.py -q` → **8 passed**（原 7 + 新增 1）
- `python -m pytest desktop/tests -q --ignore=desktop/tests/test_browser_e2e.py` → **62 passed**（原 61 + 1，恢复后复跑）
- `cd userscript; node --test "tests/*.test.mjs"` → **38 pass / 0 fail**（未动 userscript）
- 原始输出：`20260921T1402-issue1-no-fake-translation-green.txt`

## 未验证 / 相邻发现
- **未跑真浏览器 7 条 E2E**（本会话没有 Chrome 启动授权）。改动不触及 mock 显式路径，
  但"完整 69 条"只能在下一次获授权的 Chrome 启动里确认。
- **`cache_identity` 不含 mock 标志**（`desktop/suboverlay/queue_cache.py:15-30`）：
  若用户勾着 Mock 又填了真 base_url，mock 回显会以**真实 provider 身份**写进 SQLite；
  之后关掉 Mock，这条假译文会**从缓存当作真译文返回**。本机 `data/translations.db` 52 行全是
  `base_url=""` 的夹具/mock 产物，**未命中该路径**，但口径该补（1 行：identity 里加 `mock`）。
