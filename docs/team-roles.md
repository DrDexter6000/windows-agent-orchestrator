# WAO 标准团队角色矩阵

> 状态：定稿。这是 agents.json 配置的角色驱动依据。
> 设计原则：先定 vibe coding 开发流程必要的角色职责，再给每个角色绑技术配置。
> 上游：`AGENT_ONBOARDING.md`（部署模型）、`SKILL.md`（安全铁律）。

## 部署模型（前提）

WAO 是"装一次，开发多个项目"的工具：
- **WAO skill** 装在 runtime 目录（一次性）
- **`.wao/`** 建在被开发的目标项目（每项目一次）
- agents.json 的 worker `cwd` 是**动态的**——CLI 派发时 Lead 用 `--cwd <目标项目>` 指定；MCP 派发时由 host-authorized workspace binding 决定（`--workspace-root` 或 MCP roots/list），Lead 不能通过 tool argument 传任意路径

## 核心原则

1. 每个角色有明确的 work scope（做什么）和边界（不做什么）
2. Worker 通过最终 assistant response 交付结果；编排层（Lead / 控制面）负责记录和传递
3. Lead 负责编排+验收，worker 只做 bounded 任务
4. Chief-Advisor / Auditor 是 Lead Agent 的平级合作伙伴；canonical `agentId` 保持 `auditor`，同一专家按需承担前置建议与后置审计
5. 默认进程式 backend（安全），opencode 仅在需要 token 闸门精确控成本时用

## Lane：角色多通道（决策 0025）

**lane = 角色在 registry 中的一个具体实现通道**（固定 backend × provider × model × effort 组合）。角色清单里各角色行只写默认落点（lane 键）；通道的实际组合以 registry 为准。

1. 角色与车道解绑：车道键=模型家族短名（glm-pro/glm-flash/kimi/sol/astra/opus/deepseek-pro/deepseek-flash），角色是派发时按任务显式选择的帽子（`--lane <车道> --role <角色>`，角色库=config/roles/*.md：auditor/coder/researcher/tester）。
2. 新旧 harness 用独立 agentId 并存，禁止原位换。原因：认证历史要隔离、可回退；provider 会话复用键按 canonical agentId 派生、不含 harness——原位换会把 A 通道会话续到 B 通道 harness。适用面：禁令针对新旧 harness 双活的切换；旧通道已死（订阅取消/停服）时 Owner 可裁定原位迁移（会话复用机制随迁移重估、认证历史作废重跑）。换 harness 驱动同一模型 = Owner 建新 lane 条目 + 认证，之后 Lead 派发时在既有条目间点名切换。模型面 vs runtime 面分叉：接入新模型 = lane 内操作（改既有 backend 的 provider/model 字段）；接入新 runtime（另一 CLI/runtime 驱动）= 新 backend = Owner 裁定（先例 ADR-0028）。操作食谱见 `docs/certification-runbook.md`「接入新模型 / 新运行时」。
3. 组合权 = Owner，选择权 = Lead。Owner 的组合动作是写 registry + 付认证费；registry 里存在的条目即一条已付认证费的 lane。供应商死亡类突发允许两段式：入册先行 + 切换当刻 smoke 首跑 + 承重前补 delta。这是集合边界与纪律，不是 MCP 门禁（认证不是 permission gate）。
4. lane 备用条目（id ≠ 角色名原 id）不携带席位声明：席位角色声明（seatRole）机制已退役，对抗性从审者×作者车道关系派生（见「Lead 派工策略」第 7 条）。历史 seatRole 字段在场时，registry 归一化忽略并给弃用 advisory。
5. 新 lane 的认证走 delta 子集 → `conditional`（`certificationScope:"delta"` 标注），全量重跑升 `certified`。检查集合与规程见 `docs/certification-runbook.md`「delta 认证规程」。

## 角色清单

### Lead（主控）— 不进 registry

| 维度 | 内容 |
|---|---|
| **身份** | 编排者。安装 WAO skill 的那个 runtime 自己就是 Lead（不预设 runtime） |
| **Work Scope** | 理解和消化用户需求、明确任务目标、拆解和编排任务（判断可并行与必须串行的工作）、派发给合适的 worker、验收并放行或打回重做、汇总和集成交付物、向 owner 提交执行总结报告、用 .wao/ 管状态 |
| **边界** | 不把所有工作留给自己消耗 Lead quota；不把机械执行冒充语义判断；Advisor/Auditor 是按需参考，最终方案、路由与验收仍由 Lead 决定 |
| **默认 runtime** | 谁装 WAO 谁是 Lead（codex / claude-code / kimi-code 均可） |
| **配置** | 不在 agents.json（它是调用方，不是被调度的 worker） |

### Researcher（研究员）

| 维度 | 内容 |
|---|---|
| **身份** | 调研/分析专家。只读分析，不改产品代码 |
| **Work Scope** | 读代码库、技术选型、可行性分析、输出 brief/affectedFiles 清单；边界清晰的简单任务（仍限只读分析边界） |
| **边界** | 不改产品代码；不跑测试（只读）；不做实现决策（决策归 Lead+Auditor） |
| **默认 lane 配置** | 见 `config/agents.example.json` 的 `glm-flash` 条目；本机真值以 `config/agents.json`（gitignored）为准 |
| **配置要点** | model/reasoning/context 从结构化 provider policy 单一编译，不手拼 CLI flags |
| **会话复用** | `sessionReuse=lead_workspace`：同一 MCP Lead server 实例在同一绑定 workspace 内多次询问同一专家时，复用 provider 原生会话保留上下文/cache，每次仍是独立 run/transcript。Host/MCP 重启后开新会话；仅非 delivery；语义详见 `docs/02-architecture.md` §4.10。复用政策按角色登记于 `config/roles.json`：researcher/coder/tester 复用，auditor 不复用。CLI 直派注意：前台 `run` 派发 sessionReuse 型 agent 须显式 `--cwd` 指向 git 根，否则复用路由不命中、需补发 |

### Coder（实现者）

| 维度 | 内容 |
|---|---|
| **身份** | 团队的实现者，承担边界清晰的编码与制作任务包；不区分档位，实现通道由车道承担（为什么见决定 0046） |
| **Work Scope** | bounded implementation package：实现功能、修 bug、重构、兼容性调整、TDD（RED→GREEN 与指定验证）、脚本/文档/配置、前端实现与 UI 截图还原、图像/视觉内容理解（车道具备视觉能力时）、独立并行实现包与窄修正；按 Lead 指派兼职方案顾问与交付物评审（只读意见，不做验收决定） |
| **边界** | 不替 Lead 作产品、架构、范围、拆包或转派决策；不自行扩域；不验收自己；不得仅因文件数、prompt 长度、耗时或规模自行拒绝，是否拆分/转派由 Lead 决定 |
| **默认 lane 配置** | 主力 `glm-pro`、副通道 `glm-flash`/`deepseek-flash`——见 `config/agents.example.json` 对应条目；本机真值以 `config/agents.json`（gitignored）为准 |
| **派工策略** | 高耦合/长程优先 `glm-pro`；预算敏感并行小包与视觉/探索优先 `glm-flash`/`deepseek-flash`；创意/文案优先 `kimi`；高要求前端设计 `opus` |

### Tester（测试员）+ 轮询职责

| 维度 | 内容 |
|---|---|
| **身份** | 执行层验证 + 运行监控 |
| **Work Scope** | 跑测试、验证 exitCode、检查产出文件存在、报缺陷；轮询各 worker 运行状态（`runs status`/`runs list`）、检测超时/失控、向 Lead 汇报异常，降低 Lead 的 token 开销；多模态识别（读取并分析图像输入，车道具备视觉能力时）；边界清晰的简单任务 |
| **边界** | 不修 bug（归 Coder）；不做语义判断（只看证据）；不审编排方案（归 Auditor） |
| **默认 lane 配置** | 主力 `glm-pro`，看图任务用 `glm-flash`/`deepseek-flash`——见 `config/agents.example.json` 对应条目；本机真值以 `config/agents.json`（gitignored）为准 |

### Chief-Advisor / Auditor（首席顾问与审计员）— 按需双模式

| 维度 | 内容 |
|---|---|
| **身份** | Lead Agent 的平级顾问与审计合作伙伴，独立红队。auditor 是角色库 canonical 角色，经 `--role` 显式选择；不另建 `advisor` 角色 |
| **Work Scope（前置 advisory）** | 对 Lead 明确提出的未决问题做头脑风暴、红队挑战和方案审查，给可验证的替代方向，不替 Lead 拍板 |
| **Work Scope（后置 audit）** | 独立复核 Coder 产出、查伪完成、质疑声明、给 PASS/FAIL，不把验收扩张成新方案 |
| **边界** | 不改代码（归 Coder）；不和 Coder 同源（独立性）；不跑测试（归 Tester） |
| **默认 lane 配置** | 主审 `astra`、Claude 系备胎 `opus`——见 `config/agents.example.json` 对应条目；本机真值以 `config/agents.json`（gitignored）为准 |
| **会话复用** | 无。auditor 不入复用登记——验收独立性是岗位职责（登记处 `config/roles.json`） |

## Lead 派工策略

1. **Lead 拥有路由权**：worker 可以报告合同矛盾、缺少授权或能力风险，但不得自行决定拆包、缩减合同或转派。认证、provider 状态、成本和既往表现都是 Lead 的决策事实，不是自动门禁。
2. **按任务性质选通道**：主要判断语义耦合度、需求歧义、长程上下文连续性、验收边界、是否可独立并行、多模态需求、provider 可用性与成本；不按车道名头衔、prompt 长度、文件数量或预计耗时机械路由。
3. **默认实现通道偏好**：无明确耦合、成本或并行理由时，多数实现任务优先派发 `glm-pro`（质量优先；额度见车道画像的成本，凡它能完成的实现任务都优先交给它，不按任务形态——如整文件一次性重写——另分车道）；预算敏感、可独立并行的批量小包与视觉/探索优先 `glm-flash` 或 `deepseek-flash`。此为建议性偏好（advisory），不是控制面规则；Lead 仍按语义耦合与项目实际裁量，不机械路由。选车道前可用 `npm run cli -- wao lanes` 一屏查看各车道接线 / Owner 画像 / 认证 / 就绪（画像来自 `config/lane-traits.json`，分项星级加依据；开工时 `lead_preflight` 带紧凑表，`wao lanes` 看全量；零排序零推荐）。
4. **高耦合 lane**：跨模块语义强耦合、歧义较高、需要一次长程保持整体设计，或拆包会显著损失上下文时优先 `glm-pro`。
5. **多模态与创意**：视觉、前端、创意和多模态任务优先 `kimi`（文案/头脑风暴）或 `glm-flash`/`deepseek-flash`（视觉理解）；`opus` 承担高要求前端设计与备胎审计。
6. **拆包条件**：只有工作确实可独立验收、并行能降低等待或单包合同难以清晰表达时才拆；最终是否拆分或转派由 Lead 决定。
   **并发**：同一车道同时派 2–4 个任务通常没有问题；本机实测同车道 3–6 个并发的最小任务全部完成（各车道的记录见 `wao lanes` 的 `concurrency` 行）。这是一次取样，不是服务方承诺的限额：长任务、大上下文下可能更低。出现超时或限流（运行失败、诊断指向 provider）时，按事实降低并发重派；WAO 不设并发上限，也不代为排队。并发说的是相互独立的运行；同一个复用会话不能重叠派发（复用槽互斥）。并发写同一个检出会互相踩，写任务用隔离工作树；同机的全量交付验证本来就串行（见 `docs/usage/delivery.md` 同机验证串行化闸）。
7. **顾问/审计与三席会审**：三席会审是推荐标准（决策 0023，advisory 非门禁）。同一个 `auditor` 专家在执行前使用 advisory 模式、交付后使用 audit 模式；方案（stage 2）与交付物验收（stage 4）强烈建议 Lead 主审 + 两名副审（席位避同族、避被审产出作者，见 ADR 0019 §3），配不齐两副审则以 Lead + 一副审两席为次之推荐；跨族系大模型会审是更强推荐。跳过需 `--panel-skip-reason` 显式登记理由。panel 记录是证据不是验收，`run_delivery_decide` 只由 Lead 调用。席位不声明角色：对抗性从审者车道 × 被审产出作者车道派生（`wao stage 2/4 --panel-seats <a,b> --reviewed-run <runId>`，车道指纹比对），席位与作者同车道=回避违反大声提示（advisory 不阻断）；车道画像与建议用途见 `wao lanes`。

## 标准开发流（角色协作）

```
Lead 收到需求
  → 必要时派 Researcher 调研（输出 brief + affectedFiles）
  → Lead 出执行方案
  → 方案定稿后默认推荐召集副审会审（advisory 模式；三席组席与 skip 登记见「Lead 派工策略」第 7 条；wao stage 2 留痕）
  → Lead 独立裁定方案，选实现车道，以 --lane <车道> --role coder 派发
  → 必要时派 Tester 提供独立执行证据
  → 交付物验收前默认推荐召集副审会审（audit 模式；组合同上；wao stage 4 留痕）
  → Lead 整合，汇报 owner
```

Worker 通过最终 assistant response 交付结果。编排层负责记录和传递。Tester 的轮询反馈给 Lead，异常时 Lead 介入。同一 auditor 会话连审方案与交付两阶段会侵蚀独立性（ADR 0019 §3）；两阶段分席更稳。

## 接线与能力事实在哪里

本节只指路，不复述数值：

- 车道接线模板：`config/agents.example.json`（入库模板；本机真值 `config/agents.json`，gitignored）；车道表：`config/lanes.json`
- 车道画像（上下文窗口、多模态、并发取样记录）：`config/lane-traits.json`；一屏查看：`npm run cli -- wao lanes`
- backend 字段形状与 effort 值域：生成层 `docs/surface/certification.md`（由代码生成，禁止手改）
- registry 最小配置示例与 kimi/deepseek 车道前提：`docs/usage/lanes.md`
- 接入新模型 / 新运行时食谱：`docs/certification-runbook.md`「接入新模型 / 新运行时」
