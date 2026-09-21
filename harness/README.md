# harness — 本机 DeepSeek Harness 的改造工作面

本目录是 map「DeepSeek Harness 运行时现代化：PTC 收益度量、能力可见性治理与 P0→P3 改造（规格 + 落地）」（issue #10）的落地位置。**代码、脚本与报告进本仓；运行产物与快照不进 git。**

## 目录用途

| 目录 | 用途 |
|---|---|
| `research/` | 取证产物：环境审计、PTC 机制、可测基线、动态可见性（已由 #11–#14 交付） |
| `preset/` | 自定义 agent preset 源码（A+C 面：用户侧挂载，不碰安装目录官方包） |
| `plugins/` | 自定义 Cordis 插件源码（同上） |
| `scripts/` | 备份 / 恢复 / 校验脚本，以及会话度量工具 |
| `reports/` | Architecture / PTC Compatibility / Improvement 三份报告的落点 |
| `backups/` | 配置快照（**已 gitignore**，永不入库——快照可能含账号与端点信息） |

## 快照里有什么、没有什么

**有**（用户侧可写面，即 A+C 面的全部）：

- `<DSH_HOME>/settings.yaml`
- `<DSH_HOME>/.agent-presets/**`
- `<DSH_HOME>/profiles/desktop/{cordis.yml, cordis.patch.yml, package.json, desktop-plugins.lock.json, pnpm-workspace.yaml}`
- `~/.agents/skills/**`

**没有**（故意不纳入）：`<DSH_HOME>/.credentials.yaml` 等凭据文件、`sessions/`、`storages/`、`dsh-usage/`、`state/`、`attachments/`、安装目录 `app.asar.unpacked`（升级会覆盖，本来就不是可改面）。

快照根默认 `harness/backups/`，可用 `-SnapshotRoot` 改到仓库外。

## 怎么跑

本机执行策略禁止直接运行 `.ps1`。随附的 `.cmd` 包装器以**进程级** `-ExecutionPolicy Bypass` 调用（**不改机器策略、不改用户策略**）：

```
harness\scripts\backup-dsh.cmd    [-Label <名>] [-SnapshotRoot <路径>]
harness\scripts\restore-dsh.cmd   -Snapshot <快照目录> [-DryRun]
harness\scripts\verify-dsh.cmd
harness\scripts\selftest.cmd
```

也可以直接在会话里内联执行脚本内容（本机 harness 的常规做法）。

- `verify-dsh.ps1` 跑四项最小校验：**Agent Loop / Tool Calling / Plugin Loading / Session**。四项全过才退出 0，输出一张表。
- `selftest-backup-restore.ps1` 在临时目录里造一份假 DSH_HOME，跑「备份 → 篡改 → 恢复 → 逐字节比对」，**不碰真实配置**。

## git checkpoint 约定

改造铁律：**先快照、再 checkpoint、才动配置**。

1. 动配置前：`harness\scripts\backup-dsh.cmd -Label before-<改造名>`，记下快照路径。
2. 仓库 checkpoint：
   ```
   git add harness/
   git commit -m "checkpoint: before <改造名> (#<票号>)"
   git tag -a dsh-ck-<yyyyMMdd-HHmm> -m "<改造名> (#<票号>)"
   ```
   tag 命名固定为 `dsh-ck-<yyyyMMdd-HHmm>`，一个改造一枚。
3. 回滚分两层，缺一不可：
   - **仓库层**：`git revert <commit>`（或 `git checkout dsh-ck-...` 取回 `harness/`）。
   - **机器配置层**：`harness\scripts\restore-dsh.cmd -Snapshot <第 1 步的快照>`——因为 `<DSH_HOME>` 不在 git 里，git 回滚救不了它。
4. 回滚后必须重跑 `verify-dsh.cmd` 拿到退出码 0。

## 与票的对应

- [#17](https://github.com/CometDash77/youtubesub/issues/17) 建立本目录、备份/恢复脚本与上述约定。
- [#13](https://github.com/CometDash77/youtubesub/issues/13) 提供 `scripts/session-metrics.cjs` 与会话口径。
- [#16](https://github.com/CometDash77/youtubesub/issues/16) 决定 P0→P3 具体改造；每次改造按上面的 checkpoint 约定留痕。
