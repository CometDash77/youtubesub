自定义 agent preset 源码（A+C 面：挂到用户侧 `.agent-presets/`，不修改安装目录里的官方 preset）。

## `lean/` — 收窄工具面的 PTC preset

**它是什么**：官方 `ptc` preset 的逐字拷贝，外加**一行** `tool-scope` 模块行（`agent.cordis.yml` 顶部的 provenance 注释写明了这一点）。目的只有一个：把当前会话里**用不到、却每个请求都要付上下文费**的工具家族从模型可见面里拿掉。

**为什么必须是 preset 模块而不是配置开关**：要拿掉的 42 个工具大多来自 **host 组合**（profile 的插件集），不是本 preset 文件里的工具行——从 preset 里卸不掉。唯一能删掉「继承面」上的工具、并且对 `ptc` 折叠后的 wire 同样生效的接缝，是 `agent.ctx.tools.restrict({ deny })`（#14 已对该接缝取证）。时序上必须在 `agent/created` 装——装进 `system-prompt/assemble` 瀑布里只会慢一个请求。

**实测省多少**（数据源：本机最新会话日志里 68 个工具的 SDK 声明，逐工具量得；见 `harness/scripts/sdk-budget.cjs`）：

| 家族 | 工具数 | 字符 | ≈tokens |
|---|---|---|---|
| mcp/playwright | 24 | 6185 | 1547 |
| ssh | 6 | 5895 | 1474 |
| team_task | 4 | 4076 | 1019 |
| goal | 3 | 3881 | 971 |
| job | 3 | 1992 | 498 |
| consult_expert | 1 | 1080 | 270 |
| spawn_teammate | 1 | 944 | 236 |
| **合计被 deny** | **42** | **24053** | **≈6014** |

系统提示从 **14452 → 约 8438 tokens（−42%）**；每请求的 `tools` 数组不变（PTC 下本来就只有 `run_code`，524 tokens）。

> 口径提醒：上表是「请求要去掉多少」的**逐工具实测值之和**。其中 `consult_expert` 与 `spawn_teammate` 可能是本 preset 自有注册，而 `restrict` 按 #14 的结论**豁免本层注册**——这两个真被卸掉才作数，因此保守口径是 **≈5508 tokens**（去掉这两行）。其余家族来自 host 组合，属于确定能卸的继承面。

**保留面**（never-deny，写在 `tool-scope.mjs`）：`run_code`（PTC 的 transport，少了整个 agent 就废）、read/write/edit/glob/grep/pwsh、ask_user_question、todo_write、present、web_search/web_fetch、subagent/subagent_fork。

**装上**（用户侧，不碰安装目录）：

```
copy harness\preset\lean  ->  <DSH_HOME>\.agent-presets\lean
```

然后在 agent preset 选择器里选「Lean」。**默认 preset 仍是官方 `ptc`**——本 preset 是**选择性启用**的，装上它本身不改变任何现有会话的行为。

**验证**（不需要重启就能跑）：

```
node harness\scripts\test-tool-scope.cjs     # 用真实工具名 + stub ctx 驱动模块，断言 deny 集合与 never-deny
node harness\scripts\sdk-budget.cjs          # 逐工具/逐家族的声明体积
harness\scripts\verify-dsh.cmd               # 六项体检；换上 Lean 跑一轮会话后，再看 Session 与 CHECKS
```

**回滚**：把 `<DSH_HOME>/.agent-presets/lean/` 整个删掉即可（它只被 preset 选择器引用，删掉不影响官方 preset）。若已把默认 preset 改成 lean，先在选择器里切回官方 `ptc`。

**尚未验证的部分（不粉饰）**：模块的逻辑、deny 集合、体积收益都已在离线用真实数据断言过；但**「在真实会话里挂载成功并真的少渲染 42 个声明」需要在下一个会话里跑一次`sdk-budget.cjs` 才能确认**——本机不允许我从会话内部重启 host。首次启用后请跑一次 `node harness/scripts/sdk-budget.cjs`，把 `declaredTools` 从 68 变成 26 当作成功判据。
