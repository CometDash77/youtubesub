# Tampermonkey「用户脚本无效」= 元数据块终止符被吞（2026-09-21）

## 症状
用户把 `userscript/youtubesub.user.js` 导入 Tampermonkey，TM 报「用户脚本无效」。
用户附上的副本与仓库文件字节相同（19466 B, sha256 4484a96f…），**不是传错文件**。

## 根因
`userscript/youtubesub.user.js:13` 写的是 `// ==` —— 元数据块的终止符
`// ==/UserScript==` 被截断。全仓库 grep `==/UserScript==` 命中 0 次。
TM 用终止符划定元数据块；没有它 → 无 `@name/@match/@grant` → 拒绝安装，报「无效」。
脚本正文本身是合法 JS（`node --check` 退出 0），所以所有自动化测试都看不见：
- `userscript/tests/userscript.test.mjs` 只把文件当纯 JS 在 vm 里跑；
- `desktop/tests/browser_e2e.py` 走 CDP 注入，注释无关。

## 假设与判决（一次比一次快）
| # | 假设 | 预测 | 实测 |
|---|---|---|---|
| H1 | 元数据块未闭合 | 无 `==/UserScript==`；补上即通过 | **成立**（0 处命中，line 13 是 `// ==`） |
| H2 | `@match` 模式非法 | 模式不合法 | 否：`*://*.youtube.com/*` 合法 |
| H3 | `@require` URL 取不到 | 有 @require | 否：无 @require |
| H4 | BOM / 编码 / 首行偏移 | 首字节非 `/` | 否：首字节 0x2F，无 BOM，LF |
| H5 | 装的是截断副本 | 与仓库文件不同 | 否：sha256 相同，末尾 `})();` 完整 |

## 修复（单行）
```
userscript/youtubesub.user.js:13
- // ==
+ // ==/UserScript==
```

## 回归测试（先红后绿）
新增 `userscript/tests/userscript.test.mjs` 末条：
`userscript metadata block is installable by Tampermonkey` —— 断言块在第 1 行开始、
有 `// ==/UserScript==` 终止、块内每行都是注释、`@name/@namespace/@version/@match/@run-at/@grant/@connect` 齐全。

- 红：`cd userscript; node --test "tests/*.test.mjs"` → tests 38 / pass 37 / fail 1
  （`AssertionError: the metadata block must be closed by "// ==/UserScript=="`）→ `…-red.txt`
- 绿：同命令 → tests 38 / pass 38 / fail 0 → `…-green.txt`
- 附带：`node --check` 退出 0；`python -m pytest desktop/tests -q --ignore=desktop/tests/test_browser_e2e.py` → 61 passed（未唤 Chrome）

## 残留（只能由用户收口）
TM 的解析器不在本机可离线复现，代理只到"元数据块结构合法"这一层；
**最终绿灯 = 用户在 TM 里重新导入后不再报「无效」**。重新导入即 L3 的第一步。
