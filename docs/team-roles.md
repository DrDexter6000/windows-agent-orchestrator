# WAO 标准团队角色矩阵

> 状态：✅ 定稿（2026-06-24，决策 0005；lane 多通道条款 2026-08-19，决策 0025）。这是 agents.json 配置的角色驱动依据。
> 设计原则：先定 vibe coding 开发流程必要的角色职责，再给每个角色绑技术配置。
> 上游：`AGENT_ONBOARDING.md`（部署模型）、`SKILL.md`（安全铁律）、`.wao/decisions/0005`（定稿决策）、`.wao/decisions/0025`（lane 架构）。

## 部署模型（前提）

WAO 是"装一次，开发多个项目"的工具：
- **WAO skill** 装在 runtime 目录（一次性）
- **`.wao/`** 建在被开发的目标项目（每项目一次）
- agents.json 的 worker `cwd` 是**动态的**——CLI 派发时 Lead 用 `--cwd <目标项目>` 指定；MCP 派发时由 host-authorized workspace binding 决定（`--workspace-root` 或 MCP roots/list），Lead 不能通过 tool argument 传任意路径（M10-pre2）

## 核心原则

1. 每个角色有明确的 work scope（做什么）和边界（不做什么）
2. Worker 通过最终 assistant response 交付结果；编排层（Lead / 控制面）负责记录和传递
3. Lead 负责编排+验收，worker 只做 bounded 任务
4. Chief-Advisor / Auditor 是 Lead Agent 的平级合作伙伴；canonical `agentId` 保持 `auditor`，同一专家按需承担前置建议与后置审计
5. 默认进程式 backend（安全），opencode 仅在需要 token 闸门精确控成本时用

## Lane：角色多通道（决策 0025）

**lane = 角色在 registry 中的一个具体实现通道**（固定 backend × provider × model × effort 组合）。本节各角色行的 backend/model 描述**主 lane**；lane 通道的实际组合以 registry 为准。

1. 角色与车道解绑（0046）：车道键=模型家族短名（glm-pro/glm-flash/kimi/sol/astra/opus/deepseek-pro/deepseek-flash），角色是派发时按任务显式选择的帽子（`--role`，库=config/roles/*.md：auditor/coder/researcher/tester）。
2. **新旧 harness 用独立 agentId 并存，禁止原位换**（认证历史隔离可回退；provider 会话复用键按 canonical agentId 派生、不含 harness——原位换会把 A 通道会话续到 B 通道 harness）。**适用面（ADR-0029 修订）**：本禁令针对新旧 harness 双活的切换；旧通道已死（订阅取消/停服）时 Owner 可裁定原位迁移（会话复用机制随迁移重估、认证历史作废重跑）。"换 harness 驱动同一模型" = Owner 建新 lane 条目 + 认证，之后 Lead 派发时在既有条目间点名切换。**模型面 vs runtime 面分叉**：接入新模型 = lane 内操作（改既有 backend 的 provider/model 字段）；接入新 runtime（另一 CLI/runtime 驱动）= 新 backend = Owner 裁定（先例 ADR-0028）。操作食谱见 docs/usage.md「接入新模型 / 新运行时」节。
3. **组合权 = Owner，选择权 = Lead**：Owner 的组合动作是写 registry + 付认证费；registry 里存在的条目即一条已付认证费的 lane（纪律修订见 ADR-0029 两段式：供应商死亡类突发允许入册先行 + 切换当刻 smoke 首跑 + 承重前补 delta）。这是集合边界与纪律，不是 MCP 门禁（ADR 0018 的"认证非 permission gate"不变）。
4. lane 备用条目（id ≠ 角色名原 id）**必须显式声明 `seatRole`**——防后缀命名被 `/^coder_/` 惯例误判席位、稀释三席会审候选统计（决策 0023）。
5. 新 lane 的认证走 delta 子集（sentinel + scorecard + 越界写对抗断言）→ `conditional`（`certificationScope:"delta"` 标注），全量重跑升 `certified`——见决策 0025 §5 与批次 3。

## 角色清单

### Lead（主控）— 不进 registry

| 维度 | 内容 |
|---|---|
| **身份** | 编排者。安装 WAO skill 的那个 runtime 自己就是 Lead（不预设 runtime） |
| **Work Scope** | 理解和消化用户需求、明确任务目标、拆解和编排任务（判断可并行与必须串行的工作）、派发给合适的 worker、验收并放行或打回重做、汇总和集成交付物、向 owner 提交执行总结、用 .wao/ 管状态 |
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
| **裁定注记** | 2026-09-17 Owner 裁定由 DeepSeek-v4-flash 切换到智谱 GLM-5.3-Flash[1m]；**2026-10-06 0046 步⑤⑥：角色与车道解绑（researcher 经 `--role` 显式选择，默认落点 glm-flash；复用政策席位字段保活）** |
| **配置要点** | model/reasoning/context 从结构化 provider policy 单一编译，不手拼 CLI flags |
| **会话复用** | `sessionReuse=lead_workspace`（M11-11C）：同一 MCP Lead server 实例在同一 workspace 内多次询问 Researcher 时，复用 provider 原生会话保留上下文/cache，每次仍是独立 run/transcript。Host/MCP 重启后开新会话；仅非 delivery；详见 `02-architecture.md §4.10`。**CLI 直派注意（2026-08-23 life-index 会话实证）**：前台 `run` 派发 sessionReuse 型 agent 须显式 `--cwd` 指向 git 根，否则复用路由不命中、需补发 |

### Coder（实现者）

| 维度 | 内容 |
|---|---|
| **身份** | 团队的实现者，承担边界清晰的编码与制作任务包（0046 步⑤：Coder-HQ/Low/MM 三角色合并——模型与身份解绑，通道由车道承担） |
| **Work Scope** | bounded implementation package：实现功能、修 bug、重构、兼容性调整、TDD（RED→GREEN 与指定验证）、脚本/文档/配置、前端实现与 UI 截图还原、图像/视觉内容理解（车道具备视觉能力时）、独立并行实现包与窄修正；按 Lead 指派兼职方案顾问与交付物评审（只读意见，不做验收决定） |
| **边界** | 不替 Lead 作产品、架构、范围、拆包或转派决策；不自行扩域；不验收自己；不得仅因文件数、prompt 长度、耗时或规模自行拒绝，是否拆分/转派由 Lead 决定 |
| **默认 lane 配置** | 主力 `glm-pro`、副通道 `glm-flash`/`deepseek-flash`——见 `config/agents.example.json` 对应条目；本机真值以 `config/agents.json`（gitignored）为准 |
| **裁定注记** | 2026-10-06 Owner 裁定（0046 §1）三 Coder 角色合并为任务命名角色 coder，档位身份语言随旧席位名一并废弃；历史裁定（2026-08-15 wrapper 维持、2026-09-17 切智谱、2026-06-23 决策 0005 MM 定位）随旧角色退役归档 |
| **派工策略** | 高耦合/长程优先 `glm-pro`（次选 `sol`）；预算敏感并行小包与视觉/探索优先 `glm-flash`/`deepseek-flash`；创意/文案优先 `kimi`；高要求前端设计 `opus` |

### Tester（测试员）+ 轮询职责

| 维度 | 内容 |
|---|---|
| **身份** | 执行层验证 + 运行监控 |
| **Work Scope（原）** | 跑测试、验证 exitCode、检查产出文件存在、报缺陷 |
| **Work Scope（扩展-轮询）** | 轮询各 worker 运行状态（`runs status`/`runs list`）、检测超时/失控、向 Lead 汇报异常。降低 Lead 的 token 开销 |
| **Work Scope（扩展-多模态+简单任务，2026-08-15）** | 多模态识别（读取并分析图像输入；codex 图像输入能力由 Owner 人工验证）；边界清晰的简单任务 |
| **边界** | 不修 bug（归 Coder）；不做语义判断（只看证据）；不审编排方案（归 Auditor） |
| **默认 lane 配置** | 见 `config/agents.example.json` 的 `sol` 条目；本机真值以 `config/agents.json`（gitignored）为准 |
| **裁定注记** | 2026-09-03 Owner 裁定 tester effort 由 medium 升级为 xhigh；**2026-10-06 0046：tester 经 `--role` 显式选择，默认落点 sol（旧落点 gpt-sol-56 随升级淘汰）** |

### Chief-Advisor / Auditor（首席顾问与审计员）— 按需双模式

| 维度 | 内容 |
|---|---|
| **身份** | Lead Agent 的平级顾问与审计合作伙伴，独立红队。0046：auditor 经 `--role` 显式选择（角色库 canonical 角色），不另建 `advisor` 角色 |
| **Work Scope（前置 advisory）** | 对 Lead 明确提出的未决问题做头脑风暴、红队挑战和方案审查，给可验证的替代方向，不替 Lead 拍板 |
| **Work Scope（后置 audit）** | 独立复核 Coder 产出、查伪完成、质疑声明、给 PASS/FAIL，不把验收扩张成新方案 |
| **边界** | 不改代码（归 Coder）；不和 Coder 同源（独立性）；不跑测试（归 Tester） |
| **默认 lane 配置** | 主审 `astra`、Claude 系备胎 `opus`——见 `config/agents.example.json` 对应条目；本机真值以 `config/agents.json`（gitignored）为准 |
| **裁定注记** | 2026-09-17 Owner 裁定由已停用的 Claude 通道切到 Codex / GPT-6-astra，effort=medium；**2026-09-22 Owner 裁定 effort medium → high**（本机 `config/agents.json` 已改并 `registry validate` 复核：9 agent 全 valid、零 ⚠） |
| **会话复用** | 无（2026-09-17 切 codex 起）。历史注记：claude-code 通道时期用 `sessionReuse=lead_workspace`（M11-11C，语义详见 `02-architecture.md §4.10`）；**CLI 直派 sessionReuse 型 agent 须显式 `--cwd` 指向 git 根**的注意事项对仍在用该机制的 agent（如 researcher）依然适用（2026-08-23 life-index 会话实证） |

## Lead 派工策略

1. **Lead 拥有路由权**：worker 可以报告合同矛盾、缺少授权或能力风险，但不得自行决定拆包、缩减合同或转派。认证、provider 状态、成本和既往表现都是 Lead 的决策事实，不是自动门禁。
2. **按任务性质选通道**：主要判断语义耦合度、需求歧义、长程上下文连续性、验收边界、是否可独立并行、多模态需求、provider 可用性与成本；不按 `Low`/`HQ` 名称、prompt 长度、文件数量或预计耗时机械路由。
3. **默认实现通道偏好（0046 车道版）**：无明确耦合、成本或并行理由时，多数实现任务优先派发 `glm-pro`（质量优先）；预算敏感、可独立并行的批量小包与视觉/探索优先 `glm-flash` 或 `deepseek-flash`。此为建议性偏好（advisory），不是控制面规则；Lead 仍按语义耦合与项目实际裁量，不机械路由。
4. **高耦合 lane**：跨模块语义强耦合、歧义较高、需要一次长程保持整体设计，或拆包会显著损失上下文时优先 `glm-pro`（次选 `sol`）。
5. **多模态与创意**：视觉、前端、创意和多模态任务优先 `kimi`（文案/头脑风暴）或 `glm-flash`/`deepseek-flash`（视觉理解）；`opus` 承担高要求前端设计与备胎审计。
6. **拆包条件**：只有工作确实可独立验收、并行能降低等待或单包合同难以清晰表达时才拆；最终是否拆分或转派由 Lead 决定。
7. **顾问/审计与三席会审**：同一个 `auditor` 专家在执行前使用 advisory 模式、交付后使用 audit 模式。三席会审是推荐标准（决策 0023，2026-08-17 起产品化；supersedes 0019 "默认不审"）：方案（stage 2）与交付物验收（stage 4）强烈建议 Lead 主审 + 两名副审（席位避同族、避被审产出作者——0019 §3 席位回避保留），配不齐两副审则以 Lead + 一副审两席为次之推荐。强烈推荐但非强制：跳过需 `--panel-skip-reason` 显式登记理由；跨族系大模型会审是更强推荐。panel 记录是证据不是验收，`run_delivery_decide` 只由 Lead 调用。新配置建议在 registry 里显式声明 `seatRole`（adversarial/implementation/non_seat，省略按命名惯例回退——见 docs/usage.md registry 配置详解）。

## 标准开发流（角色协作）

```
Lead 收到需求
  → 必要时派 Researcher 调研（输出 brief + affectedFiles）
  → Lead 出执行方案
  → 方案定稿后默认推荐召集副审会审（advisory 模式；决策 0023：三席 = Lead 主审 + 实现席车道取一避同族 + 对抗席车道（astra/opus）取一；跳过需 --panel-skip-reason 登记理由，wao stage 2 留痕）
  → Lead 独立裁定方案并选择 Coder-HQ/Low/MM
  → 必要时派 Tester 提供独立执行证据
  → 交付物验收前默认推荐召集副审会审（audit 模式；决策 0023：组合同上；跳过需 --panel-skip-reason 登记理由，wao stage 4 留痕；auditor 同会话连审两阶段的独立性侵蚀见 ADR 0019 §3）
  → Lead 整合，汇报 owner
```

Worker 通过最终 assistant response 交付结果。编排层负责记录和传递。Tester 的轮询反馈给 Lead，异常时 Lead 介入。

## 配置 probe 实测结果（2026-06-24）

| 配置 | 实测 | 状态 |
|---|---|---|
| GLM-5.2 via claude-code wrapper | `open.bigmodel.cn/api/anthropic` + glm-5.2 | ✅ probe 通过 |
| GLM-5.2 effort=high | `CLAUDE_CODE_EFFORT_LEVEL=high` | ✅ probe 通过 |
| **GLM-5.3-Flash[1m] via wrapper（2026-09-17 切换实测）** | `open.bigmodel.cn/api/anthropic` + glm-5.3-flash[1m]，contextWindow 1000000，effort=max；researcher/coder_low 双席 WAO 端到端自检 run_20260917163004276j38li4 / run_20260917163114758gz2zfv completed | ✅ 通过（原生多模态/视觉能力由官方文档确认，图像链路未实测） |
| DeepSeek-v4-flash via wrapper | `api.deepseek.com/anthropic` + deepseek-v4-flash | ✅ probe 通过 |
| DeepSeek variant=max（model 后缀） | `deepseek-v4-flash:max` | ❌ 报错（只认 deepseek-v4-pro/flash） |
| DeepSeek effort=max（env） | `CLAUDE_CODE_EFFORT_LEVEL=max` | ✅ probe 通过 |
| kimi-code kimi-for-coding | 阶段 2 真实跑通 | ✅ |

**注意**：GLM/DeepSeek 的 effort 通过 `CLAUDE_CODE_EFFORT_LEVEL` 传，这是 claude-code 客户端的 effort 控制。是否真传给后端模型的 thinking effort，待实战观察——但配置层不报错，先用。

## 待确认项（需 owner 或实战定）

- ~~**Opus 4.8 的认证**~~：✅ 已解决（owner 亲自验证，2026-06-24，claude login 通过）
- **GPT5.5（Lead/Tester）**：codex 自带，不进 agents.json，但 Tester worker 如果用 codex backend，需确认 codex 的认证链路
- **effort 是否真传后端**：上面注意点，实战观察 token 消耗/响应质量判断
