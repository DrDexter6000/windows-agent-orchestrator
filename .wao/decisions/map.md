# Decisions Map

<!-- 索引：所有决策。一行一条，不放正文。渐进式披露。 -->
<!-- 格式：<编号> | <标题> | <一句话> -->
0001 | state read 丰富查询（grep/过滤）
0002 | 单 agent 调 subagent 的 handoff 自动化
0003 | 旧 docs/ 体系迁移到 .wao/
0004 | WAO 开发文档自审：工具文档 vs 过程文档，迁徙适配分析
0005 | 角色矩阵定稿：Lead/Researcher/Coder-HQ/Coder-Low/Coder-MM/Tester/Auditor
0006 | 外部审计收口里程碑（P0-P2 处理）
0007 | Safety+Contract 收口里程碑完成（C1-C6）
0008 | agents.example.json 对齐决策 0005（进程式切线落地）
0009 | 2026-06-24 阶段性反思 — parser 证据链 bug + 臆测纪律
0010 | Lead-UX 方向：从"操作员"到"声明者"（指向 M7 的 UX 设计骨架）
0011 | 验收契约格式：选"用户验收脚本"（spike 收敛三选一，待 owner 确认）
0012 | daemon IPC 选型：命名管道（`node:net` over `\\.\pipe\wao-daemon`，T0b spike 后 owner 拍板）
0013 | 进程隔离 Job Object：复用 Node 内置（v22）vs 自定义实现（行业调研+零依赖约束后 owner 拍板）
0014 | FL7b coder_hq provider instability fallback
0015 | Worker credential boundary: minimize now, broker before unsupervised release
0016 | Supervised Phase 3C may resume; broker remains an unsupervised release boundary
0017 | MCP-first control surface: MCP Server is agent-facing primary, CLI is fallback, shared application services
0018 | WAO mechanical containment — no auto supervision (docs-only product-contract reset; partial supersedes 0010 product direction, retains 0017)
0019 | 方案与验收三方会审惯例（advisory 劝诫级，非门禁；Lead + coder_hq/low 取一避同族 + auditor/mm 取一；Owner 2026-08-15 裁定并细化）
0020 | TD-119 批次会审分歧仲裁：采纳 auditor FAIL
0021 | MCP 工具面字节稳定性分层（追认 M12-16 regime：name/顺序+schema/annotations 哈希冻结、description 天花板下可修订；减面两级；2026-08-16 外部审计触发）
0022 | onboarding 角色矩阵展示契约（Owner 两轮反馈定稿）
0023 | 三席会审产品化
0024 | onboarding 矩阵双源展示契约（已配置行 + 模板候选，0022(6) 部分取代）
0025 | lane 架构与模型×harness 组合权（每角色 ≥1 lane、独立 agentId 并存、delta 认证方案 A）
0026 | lane 认证身份维度补全（provider 指纹与全量新鲜度；fingerprint-only+lastFullHealthyRunAt+台账合并边界钉死；双执行席对比集成）
0027 | 第三方审计处置（Owner 四条裁定：治理称重不裁流程/Node v24 修复观察主路径/护栏体检够用就好；审计七条逐条裁定+TD-140..143）
