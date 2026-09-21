# ADR-003: localhost sink 安全边界

状态: 已接受.
背景: local-screen-translator 的 sink 无 Origin/鉴权, 任意页面可 POST; dkitle /ws 同样无鉴权且 CORS 挡不住 WS.
决定 (v1):
1. 只绑 127.0.0.1; WS 握手校验 Origin (只允许空/浏览器扩展与 userscript 的常规值, 拒绝外网 Origin);
2. 首帧 register 可携带 token (桌面端生成存本地, 脚本从本地读取 — v1 先实现 Origin 检查, token 为可选项);
3. API Key 只存在桌面主进程内存与 %APPDATA% 配置文件; 绝不发往浏览器端 (summary 只含 host/model, 沿用 transly providerSummary);
4. 日志/错误串中出现疑似 Key 的内容要脱敏 (见测试).
