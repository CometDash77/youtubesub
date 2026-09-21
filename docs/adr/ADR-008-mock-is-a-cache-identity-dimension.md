# ADR-008: Mock 是缓存身份的一个维度

状态: 已接受 (2026-09-21).

背景: 缓存 identity 原本只含 base_url / model / protocol, 再加 clientKey / instructions / prompt. Mock 是显式验证替身, 它把原文加【译】前缀回显 —— 与真实译文**同构**; 而 _provider_usable() 允许「勾了 Mock」与「base_url + model 都填了」同时成立. 于是先勾 Mock 跑出的回显会落在真实 provider 的身份下; 用户取消勾选 Mock 后同一句直接命中缓存, 拿到的是回显, 真实 provider 永远不会被请求 (issue #31). 只靠「结果里带不带来源标记」无法解决: 落盘发生在队列 worker, 它拿到的是同构的 dict.

决定: **mock 进入缓存 identity 的 provider 子载荷**, 与 base_url / model / protocol 并列; 身份方案版本 1 -> 2. 配套三点: (1) TranslationJob 携带提交时的 provider 快照与命名空间, worker 用快照翻译而不是读活配置, 使「结果」与「写它用的身份」必然同源; (2) 命名空间 (provider 配置 + 系统提示词, 即 identity 去掉逐句部分) 变动时, Engine 丢弃内存中属于旧 provider 的译文并重新调度当前句; (3) 晚到的旧命名空间结果在 _on_done 被丢弃.

后果: 两个命名空间从此不可能碰撞; 旧方案写下的行一律不可达 —— 包括真实 provider 的行, 这是刻意的: 旧库里 Mock 回显与真实译文共用同一个 key, 无法只作废被污染的行而留下好的行. 升级后本地缓存全量失效一次 (纯 Mock 行与真实行都要重取/重显), 之后各自的命中/落盘行为不变. mock 缺省视为 false, 老 setting.json 无需迁移; 「API Key 永不进入身份」与 _provider_usable() 的语义两条不变式不变 (ADR-005 的测试连接路径同样不受影响).
