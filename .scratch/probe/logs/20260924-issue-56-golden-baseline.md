# Issue #56 黄金基线

采集日期：2026-09-24（Asia/Shanghai）

仓库：`CometDash77/youtubesub`

基线提交：`1a27ac892d21a08fa5a499209599bfd6ce0c272d`

## 环境

- Python：3.12.10
- pytest：9.1.1
- Node.js：v22.23.1
- Chrome：可用；真实浏览器测试未跳过

## Python 全量测试

命令：`python -m pytest desktop/tests -q`

结果：退出码 `0`，`215 passed in 30.46s`

## Node 全量测试

命令：`cd userscript; node --test "tests/*.test.mjs"`

结果：退出码 `1`，共 `38` 项，`37 passed`、`1 failed`。

唯一失败：`userscript metadata block is installable by Tampermonkey`；断言要求 userscript 文件第一个字节直接是 `// ==UserScript==`，当前文件首字节为 UTF-8 BOM（字节序列 `47 47 32 61 61 85 115 101`）。本票只记录基线，不修改实现或断言。

## 真实浏览器黑盒 E2E

命令：`python -m pytest desktop/tests/test_browser_e2e.py -q`

结果：退出码 `0`，`7 passed in 12.44s`。

7 条测试名称保持原样，未修改：

- `test_real_userscript_connects_and_registers_a_source`
- `test_real_timedtext_becomes_the_exact_subtitle`
- `test_play_pause_reaches_the_desktop_clock`
- `test_playback_rate_reaches_the_desktop_clock`
- `test_seek_moves_the_subtitle`
- `test_spa_navigation_creates_a_new_source_without_stale_cues`
- `test_userscript_reports_no_console_errors`

## 范围确认

本次只新增本基线档案；未修改实现、测试断言、测试夹具、docs/、ADR 或浏览器 E2E 测试。
