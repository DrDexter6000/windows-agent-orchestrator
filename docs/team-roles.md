# WAO 团队角色与派工原则

> 状态：现行。Lead 的职责、worker 角色清单与 Lead 的派工原则；worker 角色的合同全文在 `config/roles/*.md`。
> 上游：`AGENT_ONBOARDING.md`（部署模型）、`SKILL.md`（Safety Preflight）。

## 部署模型（前提）

WAO 是"装一次，开发多个项目"的工具：
- **WAO skill** 装在 runtime 目录（一次性）
- **`.wao/`** 建在被开发的目标项目（每项目一次）
- agents.json 的 worker `cwd` 是**动态的**——CLI 派发时 Lead 用 `--cwd <目标项目>` 指定；MCP 派发时由 host-authorized workspace binding 决定（`--workspace-root` 或 MCP roots/list），Lead 不能通过 tool argument 传任意路径

## 核心原则

1. 每个角色有明确的 work scope（做什么）和边界（不做什么）
2. Worker 通过最终 assistant response 交付结果；控制面 / Lead 负责记录和传递
3. Lead 负责编排+验收，worker 只做 bounded 任务
4. Chief-Advisor / Auditor 是 Lead Agent 的平级合作伙伴；canonical `agentId` 保持 `auditor`，同一专家按需承担前置建议与后置审计
5. 默认进程式 backend（安全），opencode 仅在需要 token 闸门精确控成本时用

## Lane：角色多通道（决策 0025）

**lane = registry 里的一个具体执行通道**（固定 backend × provider × model × effort 组合）。车道表是 `config/lanes.json`，通道的实际组合以 registry 为准。

1. 角色与车道解绑：车道键=模型家族短名（清单见 `config/lanes.json`），角色是派发时按任务显式选择的帽子（`--lane <车道> --role <角色>`，角色库=`config/roles/*.md`）。
2. 新旧 harness 用独立 agentId 并存，禁止原位换。原因：认证历史要隔离、可回退；provider 会话复用键按 canonical agentId 派生、不含 harness——原位换会把 A 通道会话续到 B 通道 harness。适用面：禁令针对新旧 harness 双活的切换；旧通道已死（订阅取消/停服）时 Owner 可裁定原位迁移（会话复用机制随迁移重估、认证历史作废重跑）。换 harness 驱动同一模型 = Owner 建新 lane 条目 + 认证，之后 Lead 派发时在既有条目间点名切换。模型面 vs runtime 面分叉：接入新模型 = lane 内操作（改既有 backend 的 provider/model 字段）；接入新 runtime（另一 CLI/runtime 驱动）= 新 backend = Owner 裁定（先例 ADR-0028）。操作食谱见 `docs/certification-runbook.md`「接入新模型 / 新运行时」。
3. 组合权 = Owner，选择权 = Lead。Owner 的组合动作是写 registry + 付认证费；registry 里存在的条目即一条已付认证费的 lane。供应商死亡类突发允许两段式：入册先行 + 切换当刻 smoke 首跑 + 承重前补 delta。这是集合边界与纪律，不是 MCP 门禁（认证不是 permission gate）。
4. 新 lane 的认证走 delta 子集 → `conditional`（`certificationScope:"delta"` 标注），全量重跑升 `certified`。检查集合与规程见 `docs/certification-runbook.md`「delta 认证规程」。

## 角色清单

### Lead（主控）— 不进 registry

| 维度 | 内容 |
|---|---|
| **身份** | 编排者。安装 WAO skill 的那个 runtime 自己就是 Lead（不预设 runtime） |
| **Work Scope** | 理解和消化用户需求、明确任务目标、拆解和编排任务（判断可并行与必须串行的工作）、派发给合适的 worker、验收并放行或打回重做、汇总和集成交付物、向 owner 提交执行总结报告、用 .wao/ 管状态 |
| **边界** | 不把所有工作留给自己消耗 Lead quota；不把机械执行冒充语义判断；Advisor/Auditor 是按需参考，最终方案、路由与验收仍由 Lead 决定 |
| **默认 runtime** | 谁装 WAO 谁是 Lead（codex / claude-code / kimi-code 均可） |
| **配置** | 不在 agents.json（它是调用方，不是被调度的 worker） |

### Worker 角色

职责与边界以合同为准：`config/roles/<角色>.md`，派发时按 `--role` 原样注入 worker，本文不复述。会话复用按角色登记在 `config/roles.json`（语义见 `docs/02-architecture.md` §4.10）。

| 角色 | 定位 | 合同 |
|---|---|---|
| `researcher` | 只读调研与分析，交 brief 与 affectedFiles 清单 | `config/roles/researcher.md` |
| `coder` | 边界清晰的实现包：功能、修 bug、重构、测试、脚本与文档 | `config/roles/coder.md` |
| `tester` | 跑测试、核对产出、轮询运行状态，按证据给 PASS/FAIL | `config/roles/tester.md` |
| `auditor` | Chief-Advisor / Auditor：Lead 的平级顾问与审计员，执行前给建议与挑战，交付后独立复核；不另建 `advisor` 角色 | `config/roles/auditor.md` |

## Lead 派工策略

1. **Lead 拥有路由权**：worker 可以报告合同矛盾、缺少授权或能力风险，但不得自行决定拆包、缩减合同或转派。认证、provider 状态、成本和既往表现都是 Lead 的决策事实，不是自动门禁。
2. **按任务性质选通道**：主要判断语义耦合度、需求歧义、长程上下文连续性、验收边界、是否可独立并行、多模态需求、provider 可用性与成本；不按车道名头衔、prompt 长度、文件数量或预计耗时机械路由。各车道擅长什么、成本多少、Owner 定了哪些规则，看 `lead_preflight` 的 `lanes`；证据与出处看 `npm run cli -- wao lanes`。画像是参考，不是路由；WAO 不排序、不推荐。
3. **拆包条件**：只有工作确实可独立验收、并行能降低等待或单包合同难以清晰表达时才拆；最终是否拆分或转派由 Lead 决定。
   **并发**：同一车道同时派 2–4 个任务通常没有问题；各车道的并发取样见 `wao lanes` 的 `concurrency` 行——那是本机一次取样，不是服务方承诺的限额，长任务、大上下文下可能更低。出现超时或限流（运行失败、诊断指向 provider）时，按事实降低并发重派；WAO 不设并发上限，也不代为排队。并发说的是相互独立的运行；同一个复用会话不能重叠派发（复用槽互斥）。并发写同一个检出会互相踩，写任务用隔离工作树；同机的全量交付验证本来就串行（见 `docs/usage/delivery.md` 同机验证串行化闸）。
4. **顾问/审计与会审**：同一个 `auditor` 专家在执行前用 advisory 模式、交付后用 audit 模式。会审怎么组席、跳过怎么登记见 `SKILL.md`；登记命令与对抗性怎么派生见 `docs/usage/consult.md`。

## 标准开发流（角色协作）

```
Lead 收到需求
  → 必要时派 Researcher 调研（输出 brief + affectedFiles）
  → Lead 出执行方案
  → 方案定稿后默认推荐召集副审会审（advisory 模式；组席与跳过登记见 SKILL.md；wao stage 2 留痕）
  → Lead 独立裁定方案，选实现车道，以 --lane <车道> --role coder 派发
  → 必要时派 Tester 提供独立执行证据
  → 交付物验收前默认推荐召集副审会审（audit 模式；组合同上；wao stage 4 留痕）
  → Lead 整合，汇报 owner
```

Worker 通过最终 assistant response 交付结果。控制面 / Lead 负责记录和传递。Tester 的轮询反馈给 Lead，异常时 Lead 介入。同一 auditor 会话连审方案与交付两阶段会侵蚀独立性（ADR 0019 §3）；两阶段分席更稳。

## 车道与角色的事实在哪里

本节只指路，不复述内容：

- 角色合同：`config/roles/*.md`；会话复用政策：`config/roles.json`
- 车道表：`config/lanes.json`；接线模板：`config/agents.example.json`（本机真值 `config/agents.json`，gitignored）
- 车道画像（擅长什么、成本档与成本、Owner 规则、实测分数、上下文、能否看图、并发取样）：`config/lane-traits.json`；开工时 `lead_preflight` 带紧凑表，全量与证据看 `npm run cli -- wao lanes`
- backend 字段形状与 effort 值域：生成层 `docs/surface/certification.md`（由代码生成，禁止手改）
- registry 最小配置示例与 kimi-web、deepseek-acp 车道的前提：`docs/usage/lanes.md`
- 接入新模型 / 新运行时食谱：`docs/certification-runbook.md`「接入新模型 / 新运行时」
