# 0026: lane 认证身份维度补全（provider 指纹与全量新鲜度）
status: accepted
date: 2026-08-21

## Context

ADR-0025 lane 架构落地后的两个认证残差（经 2026-08-19 lane 批次验收会审确认：auditor F1/F3/F4 + coder_mm b1-b4）：
1. **TD-136**：provider 块（`provider.baseUrl`/`apiKeyEnv`）完全未参与认证身份比对——现网 3 条 lane 带 provider 块（researcher/coder_hq/coder_low），改 baseUrl 或换 apiKeyEnv 而模型名不变，旧认证照常放行。附带事实：providerID 比对维对现网全部 lane 从未生效（agent 侧无声明、summary 侧值来自 matrix 硬编码行值），现行有效守卫只有 backend+modelId。
2. **TD-133d**：delta 认证全绿会刷新 worker 级 `lastHealthyRunAt` 而门不读 scope——机制性潜在洞（首次全绿 delta 即稀释）。

设计经两轮红队定稿（v1 于 2026-08-21 经 auditor run_20260821082403434ja9hma + coder_mm run_20260821082405800ao0zd6 独立红队，v2 吸收全部必改；实施经 Owner 主导双执行席对比实验：coder_hq run_20260821104255559ngym3n + coder_ox run_202608211042573439rqmoy，双席交付会审 run_20260821130626176rxh2ze / run_2026082112584478736atbk，Lead 裁定 Ox 为集成基线 + 吸收 coder_hq 的 §4 与测试）。

## Decision

1. **providerKey = baseUrl 指纹（fingerprint-only，无 provider.id）**：指纹元组 = 规范化 baseUrl（scheme+host 小写、剥默认端口、path 保留大小写仅去尾斜杠、显式丢弃 userinfo/query/fragment 防凭据入盘）+ apiKeyEnv 变量名（比变量名非密钥值）。单一实现宿主 `src/providerFingerprint.js`（零出边叶子，layering CORE_TOP 登记——fail-closed 清单的有意识维护）。已知边界（F9）：非 http(s)/含 `|` 的 baseUrl 归 null，与"已观察无接入方"碰撞，fail-open 方向，头注释明示。
2. **写入侧四点接线**：run-reliability `agentInfo()`、`matrix.normalizeCase`（从 registry `agent.provider` 派生，禁 matrix 行硬编码）、certification 身份四元组 + worker 记录、`buildCertMap` 白名单透传。**台账合并边界语义（auditor"没问但该问"钉死）**：「无条件写」限定为**本轮 active-identity case 有声明的 worker**；prior-only（本轮未跑）的 worker 记录该字段**原样保留缺失**（undefined = legacy 未观察）——半迁移窗按 worker 逐个落账，部分重认证不连坐其他 lane（此语义即集成基线的 `normalizeProviderKeyField` 实现；v1 草稿的歧义措辞作废）。
3. **delta 修法 = `lastFullHealthyRunAt`**（不读合并 scope）：worker 记录新增字段，仅 full-scope 全绿 case 刷新；`--require-certified` 门新鲜度改读它（缺失回退既有 `lastHealthyRunAt` 半迁移、显式 null/不可解析/过期 fail-closed、零新拒绝码、`manualOverride:"cleared"` 例外照旧）；MCP 主通道恒 false 不动，wire 零字节。**TD-133(c) 同批根修**：scope 派生需 `profile==="delta"` 且 drills ⊆ DELTA_DRILLS，显式 drills 超子集按 full。
4. **runContinue 同族面**：`run.started` 持久化 `providerKey`（无条件键：无 provider 块落显式 null——堵"原生直连→新接入方"最高危迁移的 fail-open 格）；续跑漂移比对 `started.providerKey`（legacy 父无字段跳过该维）；**不持久化 raw provider 块**（凭据纪律）。（吸收 coder_hq 路线）
5. **registry validate 非阻塞提示**：summary 记录缺 providerKey/lastFullHealthyRunAt 的在册 lane 输出 advisory（无前缀返回形状，半迁移期可见性）。
6. **存量宽容 + 收尾**：legacy 记录缺字段不比对；修完协调一轮全量重认证收尾（coder_low 停用豁免——其记录保持 legacy 缺字段即不比对，不被连坐）。

## Consequences

- registry schema 零扩展；MCP 22 工具零字节；不自动重认证存量。
- 不宣称 TD-136"全闭合"：对独立端点有效，对共享网关无判别力（该拓扑判别器为 apiKeyEnv+modelId；researcher/coder_low 共用 baseUrl+key 的隔离由 modelId 承担，现状不变）。
- coder_ox（Ox Alpha via OpenRouter）实验通道由本轮建立（Owner 2026-08-21 指令，三轮金丝雀+全链路交付验证通过）；去留 Owner 另定。
- 双执行席对比的完整质量结论留档 `.dev/`（会话记录）与 runs transcripts。
