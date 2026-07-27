# 0018: WAO mechanical containment — no auto supervision

status: accepted
date: 2026-07-27
partial supersedes: 0010（product direction only — the "declarer / LLM-orchestrator-first-class" forward direction）
retains: 0017（MCP-first control surface — unchanged）
指向: M12-0（Lead Token Efficiency + Assisted Orchestration 产品合同重置）

## Context

WAO 已在 M0–M11 落地一个可用的 MCP-first 控制面：deterministic dispatch、transcript truth、
isolation、delivery verification、`run_wait` liveness observation、durable Lead decision、
scorecard evidence、adaptive playbook catalog。功能已经够用；fresh Lead 仍可能误读 WAO 的角色。

反复观察到的歧义：fresh Lead 把 WAO 当成（a）一道门禁（certification hard gate）、
（b）第二个语义总管（替 Lead 拆任务、选 worker、写 correction、决定验收）。
本 ADR 把 WAO 的真实定位固化为**机械执行控制面**，并显式排除上述两类误读。

核心价值陈述：**WAO 的价值是把 worker token 消耗路由到外部 provider quota**——
WAO 让 Lead 用确定性原语把任务派给外部 worker runtime，把 token 账单落在 worker 的 provider 上，
而不是把活揽回 Lead 自己的上下文。WAO 是 Lead 的辅助执行控制面，不是门禁，也不是第二个语义总管。

## Decision

WAO 自动监测，不自动监督；自动封装，不自动验收；自动呈现，不自动决策。
（English: WAO monitors, never supervises; packages, never accepts; presents, never decides.）

### 权威边界（authority boundary）

**Lead 独占（Lead-owned, never WAO）**：用户需求理解、目标定义、任务拆解、
并行/串行编排决策、worker/context/allowed paths/verification/acceptance criteria、
correction prompt、retry/switch/scope/fallback、语义审查、accept/reject、集成、报告。

**WAO 只机械执行（mechanical, never semantic）**：validate / resolve / inject /
execute / observe / preserve / redact / project / collect exact evidence /
run Lead-specified checks / package bounded artifact / record Lead decision。

WAO 不得 interpret / adapt / recommend / rank / choose / decide；不生成语义摘要、不选上下文、
不写 correction prompt、不推荐/选择 worker、不自动语义路由、不自动 scope/retry/fallback/accept/reject。

> 用词纪律：区分 **process liveness observation / deterministic containment**（WAO 拥有）
> 与 **supervision**（Lead 拥有）。`run_wait` 是 liveness observation，supervision 属于 Lead。
> 不得使用把"监督"与"自动过程"拼合的替代表述，也不得用否定式回避 observation 与 supervision 的
> 精确区分——前者把 Lead 的监督权悄悄塞给 WAO，后者模糊两者边界。精确句只用上文给定的中文与英文逐字形式。

### Deterministic containment（report facts, never terminate Lead workflow）

确定性 containment 可以拒绝把一个 unsafe 或 out-of-contract 的 artifact 表示成合法 delivery
（例如：delivery 路径越界、verification 证据缺失、durable 事实冲突 → fail-closed 投影）。
但它只报告事实，不终止 Lead workflow——是否继续、重试、放弃由 Lead 决定。

### Certification / readiness is advisory evidence, not a permission gate

`registry_list` 的 certification（certified / conditional）与 `run_delivery` 的 readiness 是
**advisory evidence**，不是 permission gate。Lead 可选择任意 configured worker，受项目治理约束；
certification 状态只是 Lead 判断的一个输入，不门禁派发。static role contracts 与 structured task
fields 由 Lead / approved registry author 撰写，WAO 只机械应用。

### 保留的既有不变量（unchanged）

identity binding、transcript truth、cleanup、redaction、isolation、allowed paths、
exact verification、safe review、durable decision——这些机械不变量全部保留，本 ADR 不改动它们。

## Consequences

- 五份 authority docs（PRD / architecture / README / SKILL / roadmap）+ 本 ADR 携带精确 containment 句。
- PRD 删除 "LLM 编排器（一等公民）" 与 "用 LLM 决定分流" 产品方向；Lead 定义/选择/修改 deterministic plan，
  已实现 WorkflowEngine 只是 Lead-authored expert mechanical executor。
- architecture 把 router 降权为 Lead-authored deterministic function、gate 降权为 Lead-specified
  mechanical condition；不暗示 WAO/LLM 自动语义路由或语义验收。
- SKILL 把 certification 定位为 advisory evidence，删除 certified/conditional permission hard gate。
- roadmap 关闭 M11（Tester token efficiency retire/defer），M12 进行中（仅 planned/unimplemented slices）。

## Boundaries

- 本 ADR 是 **docs-only** 产品合同重置。它不声称任何 runtime feature 新实现或已实现——
  所有被重述的不变量都是既有实现；本 ADR 只固化定位与措辞。
- 本 ADR **partial supersedes 0010 的 product direction**（声明者愿景中 "LLM 编排器作为
  可插拔策略一等公民 / 自动分流" 的前瞻产品方向），不推翻 0010 已落地的 M7 dogfood 事实。
- 本 ADR **retains 0017 MCP-first**：MCP 是 agent-facing primary，CLI 是 fallback，
  shared application services——全部不变。
- 不发明新工具名。M12 的计划切片（compact/delta observation、deterministic evidence/handoff
  aggregation、Lead-authored correction continuation with explicit lineage / safe reuse、
  bounded actionable failure facts、factual readiness/history projection）均为 planned/unimplemented。
