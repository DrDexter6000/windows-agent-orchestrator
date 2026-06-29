# 0008: agents.example.json 对齐决策 0005（进程式切线落地）
status: accepted
date: 2026-06-24

## Context

决策 0005（2026-06-23）定稿角色矩阵：默认进程式 backend，opencode 降为 fallback。
team-roles.md（2026-06-24）跟齐，成为角色权威源。

但 **config/agents.example.json 从未跟齐**——它还停在 06-23 之前的 opencode-first 配置
（coder/researcher/coder_multimodal 全是 opencode-serve）。这是"决策→配置"链路的断点：
决策写了、文档跟了，但下游配置没落地。owner 在 06-24 重塑 SSOT 后发现此违规
（"这就是我最担心的问题"）。

## Decision

把 agents.example.json 重写为决策 0005 的配置落地：
- worker 改按角色命名：researcher / coder_hq / coder_low / coder_mm / tester / auditor
  （与 team-roles.md 一一对应，弃旧名 coder/coder_strict/coder_multimodal/coder_kimi/coder_deepseek_claude）
- 全进程式 backend：researcher/coder_hq/coder_low = claude-code wrapper，
  coder_mm = kimi-code，tester = codex，auditor = claude-code(opus)
- opencode 收敛为单个显式标注的 fallback worker（coder_opencode_fallback），
  不再混在主角色里
- certification.matrix 改认证进程式 worker；opencode fallback 不强制认证
- 新增 docs-consistency SSOT 守卫：断言 agents.example.json 角色与 team-roles.md 对齐
  （主 worker 进程式 + opencode 必须标 fallback），防回归

## Consequences

- 解决了"决策没落地"的 SSOT 违规。team-roles.md ↔ agents.example.json 现已一致。
- 暴露并固化了一个教训：**做决策 ≠ 决策落地**。决策 0005 落地到 team-roles.md 但
  没落地到 registry，是因为两者分属不同文件、无机制强制联动。新增的 SSOT 守卫
  把这条联动从"靠人记得改"变成"测试强制"。
- reliability-summary.json（停在 06-18，旧 worker 名）现在是 stale 的——
  P1-1 认证重跑需用新角色名补全。此为后续工作。
- 旧测试引用的 agent 名（coder_kimi 等）已随守卫重写更新。
