# 调试窗口视觉 token（调试设置前端 map 的样式底稿）

来源：用户提供的风格图（磨砂渐变拼色照片），用户裁定「设置的风格与色块从这张图提取」。
- 源图落盘：.scratch/wayfinder/style/style-source.jpg
- 采样脚本：.scratch/wayfinder/style/extract_palette.py（缩放到 240x524，每通道 24 级量化，桶内取均值）
- 抽取色卡：.scratch/wayfinder/style/swatches.png

## 一、从图中提取的色块（未做任何调色）

| 名称 | Hex | 像素占比 | 对奶油纸底对比度 | 图中位置 |
|---|---|---|---|---|
| 奶油纸底 Paper | #E6E3DA（次级 #E0DDD2） | 11.8% / 4.8% / 1.5% | — | 右下大块 |
| 赭红 Terracotta | #B94D37（亮一档 #C2533C） | 11.0% / 5.2% | 3.92:1 | 左下大块 |
| 松绿 Pine | #38544D（深一档 #355044） | 10.0% / 5.6% | 6.43:1 | 左上 |
| 芥末黄 Mustard | #CCA13D（亮一档 #D3AA42） | 7.6% / 3.4% | 1.87:1 | 右上大块 |
| 靛蓝 Indigo | #343E68（深一档 #2D3662） | 6.1% / 1.6% | 8.04:1 | 上方 |

对比度按 WCAG 相对亮度计算；芥末黄与奶油底只有 1.87:1，这条数字决定了它的用法（见下）。

## 二、角色映射（用户裁定：奶油纸底 + 靛蓝主调 + 松绿次调 + 赭红危险 + 芥末黄高亮）

| 角色 | 取值 | 用法规则 |
|---|---|---|
| 窗口底 | 奶油 #E6E3DA（半透明，配合磨砂） | 磨砂降级时改用不透明度更高的纸底，保证可读 |
| 卡片 / 分区 | #E0DDD2 | 与窗口底只差一级，靠 1px 内描边 + 柔和阴影分层，不用重投影 |
| 主强调 / 主按钮 / 选中态 | 靛蓝 #343E68 | 8.04:1，可承白字或奶油字 |
| 次强调 / 就绪与连接正常 | 松绿 #38544D | 6.43:1，可承字 |
| 危险 / 错误 / 停止 | 赭红 #B94D37 | 3.92:1：只用于图标 / 边框 / 大字号；正文级错误文字用加深档（实施时定，建议 #8F3A29 一档） |
| 高亮 / 注意 / 进行中 | 芥末黄 #CCA13D | 1.87:1：**禁止承字**，只作填充、色带、进度条；上面的文字必须是靛蓝或深松绿 |
| 主文字 | 靛蓝 #2D3662 | |
| 次文字 / 辅助说明 | 松绿 #355044 | |
| 分隔线与描边 | 松绿或靛蓝的 20% 混合档 | 需在纸底上肉眼可见，不用纯灰 |

## 三、窗口底规则（不透明；磨砂已废）

**用户 2026-10-03 裁定：「外卡片的透明毛玻璃效果没有必要」——外层窗口不再做透明、不再做磨砂，视觉结构交给内层卡片。**

- 外层配方（唯一一版）：不透明奶油底 `rgba(246,243,235,255)` + 24 圆角 + 1px 内描边 `rgba(255,255,255,110)` + 48px 柔阴影；窗口四周留 24px 边距给阴影（无边框窗口，否则圆角与阴影被系统标题栏吃掉）。
- 内层卡片（`QFrame#debugCard`）**保留**：奶油一级 `#E0DDD2` + 1px 描边 `#C9C4B6` + 12 圆角；它是唯一的分组面，与窗口底只差一级的关系到此才真正成立（此前窗口底半透明，这层关系是失真的）。
- 无边框 + 自绘标题行（拖动 / × / Esc）继续保留：系统标题栏会吃掉圆角与阴影。
- 实现：`desktop/suboverlay/debug_tokens.py` 的 `WINDOW_RGBA` + `debug_window.window_sheet()`；`DebugWindow.enable_frost()/frost_mode()/frost_env` 与 `debug_frost.py` 随本裁定**已删除**。回归测试：`test_the_window_paints_the_documented_opaque_chrome`（不透明 + 圆角 + 内描边 + 柔阴影 + 内层卡片仍在）。

### 存档：真磨砂取证（2026-10-01 闭环，2026-10-03 随上面的裁定下线，不再实施）

留在这里只为防回退/防重复踩坑；`debug_frost.py` 的删除前原件备份在 `.scratch/wf-session/backup-frost/`。

- 曾经的配方：SetWindowCompositionAttribute(hwnd, ACCENT_ENABLE_BLURBEHIND = 3, AccentFlags = 2, GradientColor = 0x00000000) —— 真模糊、零 tint、16.7ms/帧零掉帧。
- 曾经的启用条件（全真）：sys.platform=="win32" ∧ platformName()=="windows" ∧ 19041 <= build < 22000 ∧ DwmIsCompositionEnabled() ∧ **顶层窗口**的 winId()!=0 且 IsWindow(hwnd) ∧ accent 返回非 0。
- 曾经的坑：accent 必须打在**顶层窗口**的 HWND 上——Qt 会给带 QGraphicsEffect 的子控件单独建原生句柄，打在那种句柄上 `SetWindowCompositionAttribute` 返回 0，会被当成"不接受"（2026-10-03 实施期实测）。
- 曾禁用：ACCENT_ENABLE_ACRYLICBLURBEHIND(4)（本机实测移动 30fps / 缩放 20fps，且 alpha=0 时零效果却仍返回 TRUE）；GetWindowCompositionAttribute 回读（本机 err 87）；不能靠 winId()!=0 或 QPixmap.isNull() 判定（offscreen 下都是假值且不抛异常）。
- 历史取证图：.scratch/wayfinder/research/round-round_blur_grad0.png（真磨砂）、v2-looks-pseudo-context.png（降级伪磨砂）。

## 四、禁止

- 芥末黄上放正文文字（对比度不足）。
- 用纯黑 / 纯白做背景或边框（图中没有，会破坏纸感）。
- 把这套 token 用到调试窗口以外的界面（用户裁定本轮只作用于新窗口）。
