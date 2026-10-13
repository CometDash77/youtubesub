# PROTOTYPE（抛弃式）— #213 浮窗三态视觉与动效原型

回答两个设计问题：

1. 三态（A 常驻纯字幕 / B 悬停控制条淡入+字幕缩小 / C 穿透解锁小图标）的观感与过渡是否成立——转移矩阵照 #211 决议，动效数值外显可拖，仅供 #214 定案参考。
2. Chromium backdrop-filter 在 Electron 44 真透明窗上是否达标（#154 acrylic 禁用先例约束，"达标由本原型票呈现"）。

## 跑法

- **Electron 真窗**（推荐，backdrop-filter 判定真实）：
  \`pnpm -C app exec electron prototype/213-three-states/electron.cjs\`
- **便携双击**：直接双击 \`index.html\`（模拟背景降级，动效与三态可看，材质判定仅供参考）。
- **自检**（无窗跑转移矩阵断言）：
  \`pnpm -C app exec electron prototype/213-three-states/electron.cjs -- --selfcheck\`

## 操作

- 整窗悬停 → 控制条淡入+字幕缩小；离窗 → 延迟淡出。
- 右键菜单「鼠标穿透」或 Ctrl+Alt+U → 穿透态（真窗下真实鼠标穿透）；点右下小图标解锁。
- 底部悬浮切换条 ◀/▶ 循环三态（同 ?variant=A|B|C，可分享、刷新稳定）；←/→ 键同样循环。
- 右上工作台：材质三档（真磨砂/伪磨砂/不透明）、blur 档位、动效滑杆+快/中/慢预设、模拟直播流降级、状态与转移日志外显。

抛弃式：验证完成前禁止并入生产 renderer；选定基准后按 /prototype 规则把原型捕获到抛弃分支，main 只留已验证决策。
