# 0025: lane 架构与模型×harness 组合权
status: accepted
date: 2026-08-19

## Context

Owner 需求（2026-08-19）：同一大模型可被不同 coding agent harness 驱动、可反复来回切换，且切换不得每次付全额"调研 + 适配 + 重认证"成本。双席咨询（auditor run_20260819163805691s48sg5 / coder_mm run_202608191637555997xbcyk，全文留档本地 `.dev/consult/`，未入库）一致裁定方向成立（REFINE×2），并否决了"模型池 + 模型级认证"层（认证测量的是 harness×模型交互，模型单体绿不构成组合证据）与"能力档案作为 registry 声明输入"（config 可声明与代码不符，双真相源；`docs/usage.md` 已有平面能力布尔否决先例）。

咨询同时实证两个存量门洞（Lead 复核属实）：`--require-certified` 门不做身份比对（`src/runManager.js` 只按 agentId 取记录）；新鲜度读整份 summary 的 `generatedAt`（重考一人洗白全本）。MCP 主通道 `requireCertified` 恒为 server-owned false（ADR 0018：认证是 advisory 不是门禁）。

## Decision

1. **lane = 角色在 registry 中的一个具体实现通道**（固定 backend × provider × model × effort 组合）。每角色 ≥1 lane：主 lane 用角色名原 id（`coder_hq`），备用 lane 用 `<roleId>_<后缀>`（后缀语义自明，如 `_dsh`）。
2. **新旧 harness 用独立 agentId 并存，禁止原位换**。理由：认证历史按 agentId 隔离可回退；provider 会话复用键（opaque uuid）按 canonical agentId 派生、不含 harness/model——原位换会把 A 通道会话续到 B 通道 harness（run_continue 串线面）。"来回切换" = Lead 派发时在已存在条目间点名，零边际成本。
3. **组合权 = Owner，选择权 = Lead**。Owner 的组合动作 = 写 registry（建 lane）+ 付认证费；registry 里存在的条目即一条已付过认证费的 lane（纪律：未付认证费的组合不进 registry）。Lead 永远只在既有条目间选择，不现场拼未认证组合。本条是纪律与集合边界，不是 MCP 门禁（ADR 0018 不动）。
4. **lane 条目必须显式声明 seatRole**（闭集，`registry.js` SEAT_ROLES）：防 `<role>_<suffix>` 命名被 `/^coder_/` 等命名惯例误判席位、稀释三席会审候选统计（决策 0023）。
5. **认证分层（批次 3，前置 = 门卫修复先行）**：新组合走 delta 认证（sentinel + scorecard + 越界写对抗断言；isolation 不得省），通过 → `conditional`（Owner 方案 A，2026-08-19 拍板）+ summary 事实字段 `certificationScope: "full"|"delta"`；全量重跑升 `certified`。`CERTIFICATION_STATUSES` 闭集与 MCP 工具面（22 工具）零改动。"监督"= Lead 人工盯，无机制保障（ADR 0018 措辞纪律，禁用"监督档"暗示机制存在的说法）。
6. **模型池/模型级认证不设**；能力声明留在 backend 代码类（闭集字段，仿 `supportsSessionReuse` 模式），`registry validate` 交叉校验（批次 2）。

## Consequences

- `config/agents.example.json` `_comment_ssot` 的 1:1 纪律改为"每角色 ≥1 lane 映射"；onboarding 表述同步（守卫 TD-120 关系型化）。
- team-roles.md 角色行的 backend/model 描述主 lane；lane 通道的实际组合以 registry 为准。
- 旧条目 `coder_opencode_fallback` 追认为 lane 命名惯例的前身特例（pre-0025 名字，不改名——改名破坏认证历史与既有引用）。
- 实施批次（Owner 2026-08-19 批准）：0 门卫修复（先行）→ 1 lane 命名规矩（本决策落地）∥ 2 backend 能力声明 → 3 delta 认证。coder_low 因 provider 欠费停用，不参与派工。
