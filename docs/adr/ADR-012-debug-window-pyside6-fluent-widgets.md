# ADR-012: 调试窗口采用 PySide6-Fluent-Widgets（并接受其 GPLv3 代价）

状态: 已接受 (2026-10-01, 维护者裁定；取证 [组件库选型取证](https://github.com/CometDash77/youtubesub/issues/153) = `.scratch/wayfinder/research/component-library.md`；依赖落地 [依赖落地与 ADR](https://github.com/CometDash77/youtubesub/issues/160)).

背景: 地图 [调试设置前端 map](https://github.com/CometDash77/youtubesub/issues/152) 的 destination 要求一个用**成熟组件库**构建的桌面「调试」窗口（调参 + 排障两页，视觉取自风格图色板）。选型取证票在本机逐项实测三路候选：

- **A. PySide6-Fluent-Widgets 1.11.3**（qfluentwidgets）：**GPLv3**（非商用；商用须另购商业许可）。运行时可只靠 PySide6-Essentials 6.11.2，但 pip 元数据声明依赖**完整 PySide6**，正常安装实测额外拉入 **PySide6-Addons 168.2 MB**（wheel）；Windows 下经 **PySideSix-Frameless-Window**（LGPLv3）硬依赖 **pywin32**。offscreen 与 PyInstaller 实测可用（onedir 98.9 MB，比原生 +3.1 MB），但 import 时**无条件 print 促销标语**，且 `qconfig.save()` / `setTheme(..., save=True)` 会往 **cwd** 写 `config/config.json`；自带的 Win10 亚克力走未文档化 API，其 README 自认「移动会卡死」且库内没有自动降级。
- **B. Qt 原生 QWidgets + QSS**：零新增依赖、零 stdout / cwd 副作用、PyInstaller 自带全套 PySide6 hook、onedir 95.8 MB。取证**推荐 B**。
- **C. 轻量补充**：C1 superqt（BSD-3）、C2 qt-material（BSD-2，自带 PyInstaller hook）、C3 QDarkStyle（MIT + 图片 CC-BY-4.0）——许可证都宽松，但都只提供「补齐控件」或「某种预设明暗主题」，不提供本窗口需要的奶油/靛蓝/松绿/赭红/芥末黄配色，套上去仍要整层 QSS 覆盖，属净增依赖。

维护者 2026-10-01 裁定：**仍采用 A（PySide6-Fluent-Widgets），代价自担**（裁定记录见地图 Notes 第 ⑤ 条；否决取证推荐 B 的理由未在票内展开）。

决定:
- 调试窗口的控件一律取自 **PySide6-Fluent-Widgets >= 1.11.3**（本机落地 1.11.3）；`requirements.txt` 增列该行，其余依赖由 pip 元数据传递拉入（`PySide6` meta → `PySide6-Essentials` + `PySide6-Addons` 6.11.2；`PySideSix-Frameless-Window` 0.8.2 → `pywin32`；`darkdetect`）。
- **不用 `--no-deps` 规避 Addons**：保持 `pip install -r requirements.txt` 一步可复现，且 `pip check` 不报冲突（本机实测 `No broken requirements found`）。
- **磨砂不依赖库的亚克力**：Win10 磨砂按 [Win10 磨砂实现取证](https://github.com/CometDash77/youtubesub/issues/154) 的配方自行实现（真磨砂 + 伪磨砂自动降级，藏在可注入 seam 后面）；qframelesswindow 的 `setAcrylicEffect` 不作为本窗口磨砂的实现。
- 本 ADR 只记组件库这一条决策：ADR-001 的 PySide6 栈继续有效；**「本 App 将来整体以什么许可分发」不在此解决**（仍留在地图的「Not yet specified」）。

接受的代价（明文记账）:
1. **GPLv3 对分发的约束**：qfluentwidgets 是非商用 GPLv3。仓库当前**无 LICENSE**，ADR-001 把「打包分发」推迟但未取消；一旦将来分发本程序整体，GPLv3 义务即触发（整体须以 GPLv3 兼容条款提供源码），除非改写为 B 路或购买商业许可。只在本机开发、不分发时不触发。
2. **体积**：元数据声明 `PySide6`，本机正常安装实测多装 **PySide6-Addons 168.2 MB**（wheel）与 **pywin32**（约 6.9 MB，本机原本已有 312）；此外 `PySideSix-Frameless-Window` 31 KB、`darkdetect` 9 KB、qfluentwidgets 本体 1.5 MB。开发机成本按此计；冻结产物是否变大取决于实施是否 import Addons 子包（取证实测 onedir 只 +3.1 MB）。
3. **Win10 亚克力不可靠**：库自带真磨砂在 Win10 走未文档化 API 且作者自认移动会卡死，库内无自动降级——本窗口磨砂因此自建。
4. **已知副作用**（本机实测）：模块 import 时无条件 `print` 促销标语（污染 stdout 断言与 CLI 输出）；`qconfig.save()` / `setTheme(..., save=True)` 会往 **cwd** 写 `config/config.json`。默认路径不落盘：本票 offscreen 冒烟在干净 cwd 下实测**无新文件**。

被否决的选项:
- **B. Qt 原生 QWidgets + QSS（取证推荐）**：零新增依赖、许可干净（只在既有 Qt/PySide6 框架内）、offscreen / 测试 / 打包最省事。**被维护者否决**。
- **C1 superqt 0.8.2（BSD-3）**：只补 Qt 缺失控件，不提供主题/配色，帮不到本窗口外观，净增 qtpy + pygments。
- **C2 qt-material 2.17（BSD-2）**：自带 PyInstaller hook 是优点，但价值是 Material 预设主题，与本窗口从风格图采样的 token 不同源，套上仍要整层覆盖，净增 Jinja2 + MarkupSafe。
- **C3 QDarkStyle 3.2.3（MIT，图片 CC-BY-4.0）**：成熟明暗样式表，但同样是预设主题，还要额外做 CC-BY 署名，净增 qtpy。
- **A 的 Essentials-only 变体**（`--no-deps` + 手装 frameless-window / pywin32 / darkdetect）：能跑且省 168.2 MB，但会让 `pip check` 永久报 `pyside6-fluent-widgets requires pyside6, which is not installed`，且 `pip install -r requirements.txt` 无法一步复现（`--no-deps` 会连 pytest 的传递依赖一起跳过）——放弃，该代价改由「接受 Addons 体积」承担。

后果:
- `requirements.txt` 增 `PySide6-Fluent-Widgets>=1.11.3`；`THIRD-PARTY-NOTICES.md` 增 GPLv3 条目（连同传递依赖的许可一并注明）。
- 本机环境已落地并核验：`PySide6 6.11.2 / PySide6-Addons 6.11.2 / PySide6-Fluent-Widgets 1.11.3 / PySideSix-Frameless-Window 0.8.2 / darkdetect 0.8.0 / pywin32 312`；`pip check` 干净；`QT_QPA_PLATFORM=offscreen` 冒烟（import + 5 种控件 + 建窗可见）通过，除促销标语外无意外副作用；既有全量测试保持全绿（pytest 271 passed / node 40 pass）。
- 实施票 [实施：按选定组件库与 token 落地调试窗口](https://github.com/CometDash77/youtubesub/issues/158) 用 qfluentwidgets 控件构建两页，磨砂走自建 seam。
- **翻盘点（重开此决定的唯一触发）**：本 App 要以非 GPL 条款分发时——改写为 B 路（Qt 原生 + QSS）或购买商业许可。
