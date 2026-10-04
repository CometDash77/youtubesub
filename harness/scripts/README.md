备份 / 恢复 / 校验脚本与 `session-metrics.cjs`；用法与 checkpoint 约定见 `harness/README.md`。

`fix-dsh-safe-mode.{ps1,cmd}`：体检并退出桌面版的「安全模式档案」——装在该档案里的用户插件会被应用每次启动清空（`safe mode: removing N user plugin(s) from the safe profile`）。默认只体检，`-Apply` 才把 `profiles/safe` 改名为 `profiles/main` 并改写 `.store.dat` 的 `active_profile`。
