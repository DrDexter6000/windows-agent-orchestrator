# 0053 · B′ 根修关账与 tester/coder 复用入册

- 状态：accepted
- 签署：Owner 2026-10-10（"许可，继续"——批准 B′ 关账后的入册批与推送）
- 前置：0052（洞②修订与分级启用——§3 预告"待 zcode B′ 残余关闭…后另批启用"）
- 红队：consult_20261010134035145ef1yzp（opus+kimi 双席方案会审——两席独立提出 D 探针路线；指纹兜底否决：tester 重跑同套件同文是常态，假阳性趋近 100%）

## Context

0052 分级启用时 tester/coder 暂缓，唯一挡路石=zcode 通道 resume 残余 B′（头部插入→旧 stop 右移→假 completed+发射旧答案；连带击穿 0052 失败即弃与 run_lineage 交付链）。根修批（77efe1b）依双席会审的 D 路线完成：

1. **live 探针实证**（.dev/bprime-probe.mjs + .dev/bprime-evidence/，glm-flash 三轮 fresh/同进程/跨进程 resume）：上游消息 info.id/role/parentID、part id/messageID/sessionID 全数在场且跨快照稳定，assistant 另带 anchor.turnId——B′ 关闭条件（"上游提供轮次身份原语"）事实上早已满足，只是未被验证与消费。
2. **身份切片重写**（仅 zcode.js 内部）：完成判据=锚点（本轮新 user 消息）→parent 指向它的新 assistant 末位 step-finish；历史变异（基线 id 序列不再前缀）具名失败；resume 历史缺 id 发送前拒绝（零 token）；TD-199 台账改 part id 键；回显启发式退役。
3. **验收**：⑨h/⑨i/⑨k/⑨l/⑫f 五反例在旧位置判据上实证红（红绿双证）；zcode 59/59；全量 305/305 首满分；生产冒烟=MCP 两轮 glm-flash（fresh→resume，上下文续接成立；两轮同文正确完成=指纹方案会误杀的形状在身份判据下无感通过）。

## Decision

1. **B′ 残余关账**：factory.js 能力注记与 zcode.js 文件头的 B′ 残余声明改关闭声明（依据链=探针证据+反例组）。
2. **tester / coder 复用入册**（config/roles.json，本批生效）：lead_workspace。0052 §3 的"另批启用"条件就此满足。负对照=auditor 永不入册（不变）。
3. **auditor 维持不入册**（0052 裁定不变：验收独立性=岗位职责；advisory 模式复用仍列为未来选项，需模式分裂机制，另立项）。

## Consequences

- 显式 `--role tester` / `--role coder` 派发自本批起进复用路由（角色政策=真实开关）。
- 在册知悉项（0052 §4）继续适用：kimi-web 失控复用会话无 WAO 内停止杠杆；同身份并行派单撞 busy（Contract 6 串行化——Lead playbook 按串行规划）；claude-code/codex 的 KV-cache 经济性未计量。
- 桌面 zcode 2026-10-10 08:02 自动更新（bundle sha 漂移 b816e386，opus 席发现）：当日接线经探针+冒烟验证仍工作；后续 spawn 失败先查桌面更新漂移（版本巡检 SOP 项）。
- 测试钉随批更新：rolePolicy POL-3 ②b 负对照从 coder（已入册）改为 auditor。
