# WAO 标准团队角色矩阵

> 状态：✅ 定稿（2026-06-24，决策 0005）。这是 agents.json 配置的角色驱动依据。
> 设计原则：先定 vibe coding 开发流程必要的角色职责，再给每个角色绑技术配置。
> 上游：`AGENT_ONBOARDING.md`（部署模型）、`SKILL.md`（安全铁律）、`.wao/decisions/0005`（定稿决策）。

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
| **backend** | claude-code wrapper（进程式，弃 opencode——06-18 事故风险） |
| **model** | deepseek-v4-flash（1M context，适合深度调研；2026-08-15 Owner 裁定与实际配置对齐——此前本行与认证矩阵误记 v4-pro） |
| **effort** | max（深度分析） |
| **配置要点** | model/reasoning/context 从结构化 provider policy 单一编译，不手拼 CLI flags |
| **会话复用** | `sessionReuse=lead_workspace`（M11-11C）：同一 MCP Lead server 实例在同一 workspace 内多次询问 Researcher 时，复用 provider 原生会话保留上下文/cache，每次仍是独立 run/transcript。Host/MCP 重启后开新会话；仅非 delivery；详见 `02-architecture.md §4.10` |

### Coder-HQ（码农-长程高质量）

| 维度 | 内容 |
|---|---|
| **身份** | 高耦合与长程连贯实现通道 |
| **Work Scope** | 跨模块高耦合实现、歧义较高且需要持续统筹的编码任务、难以经济拆分的长程实现，以及按 brief 写/改代码、跑 lint/build、修 bug；按 Lead 指派兼职方案顾问与交付物评审（只读意见，不做验收决定） |
| **边界** | 不做架构决策（归 Lead+Auditor）；不验收自己（归 Auditor） |
| **backend** | claude-code wrapper（进程式，已 probe；2026-08-15 Owner 裁定维持——ZCode CLI 迁移构想见 TD-116） |
| **model** | glm-5.3[1m]（1M context，编码能力强；2026-08-15 对齐实际配置，此前本行误记 glm-5.2；该组合 2026-08-14 已认证 certified。下方 probe 表为 2026-06-24 历史快照） |
| **effort** | max |

### Coder-Low（码农-低成本快速）

| 维度 | 内容 |
|---|---|
| **身份** | 低成本高吞吐的通用第二实现通道；`Low` 不表示低能力 |
| **Work Scope** | 默认承担边界明确的实现包、TDD、修 bug、重构、兼容性、脚本、文档/配置与窄修正；适合独立并行包；按 Lead 指派兼职方案顾问与交付物评审（只读意见，不做验收决定） |
| **边界** | 不替 Lead 作架构、范围、拆包或转派决策；不自行扩域；不验收自己。不得仅因文件数、prompt 长度、耗时或规模自行拒绝，是否拆分/转派由 Lead 决定 |
| **backend** | claude-code wrapper（进程式） |
| **model** | deepseek-v4-flash（1M context） |
| **effort** | max |

### Coder-MM（多模态创意与高质量工程）

| 维度 | 内容 |
|---|---|
| **身份** | 多模态、视觉创意与高质量工程通道 |
| **Work Scope** | 图像/截图/视频内容理解；前端设计与实现；UI 截图还原；视觉/美术审核；带图文档与图像相关编码；产品、内容和体验策略方案起草；文案写作；高质量工程与代码实现；按 Lead 指派兼职方案顾问与交付物评审/会审对抗席（只读意见；不做验收决定，不评审自己的产出） |
| **边界** | 不替 Lead 做最终产品/策略/架构决策；不验收自己的产出；常规低风险纯文本编码默认归 Coder-HQ/Low |
| **backend** | kimi-code（进程式，官方过 Kimi 白名单） |
| **model** | kimi-code/k3（原生最高 1M context；实际可用窗口取决于 Kimi Code 账户档位） |
| **配置要点** | 不要加 `--yolo`（与 -p 互斥）；Kimi Code/K3 自主管理上下文，WAO 不配置 backend 无法表达的 `contextWindow` override |
| **派工策略** | 多模态、视觉、前端、创意、策略或文案任务优先；工程与代码能力强，可在 Coder-HQ 不可用、并行容量不足，或任务明显受益于 K3 长上下文/多模态能力时作为高质量替补。token 价格较高，不作为常规低风险编码的默认通道 |

### Tester（测试员）+ 轮询职责

| 维度 | 内容 |
|---|---|
| **身份** | 执行层验证 + 运行监控 |
| **Work Scope（原）** | 跑测试、验证 exitCode、检查产出文件存在、报缺陷 |
| **Work Scope（扩展-轮询）** | 轮询各 worker 运行状态（`runs status`/`runs list`）、检测超时/失控、向 Lead 汇报异常。降低 Lead 的 token 开销 |
| **Work Scope（扩展-多模态+简单任务，2026-08-15）** | 多模态识别（读取并分析图像输入；codex 图像输入能力由 Owner 人工验证）；边界清晰的简单任务 |
| **边界** | 不修 bug（归 Coder）；不做语义判断（只看证据）；不审编排方案（归 Auditor） |
| **backend** | codex（进程式，command_execution exitCode 最准） |
| **effort** | medium（测试是确定性任务，不需高推理） |

### Chief-Advisor / Auditor（首席顾问与审计员）— 按需双模式

| 维度 | 内容 |
|---|---|
| **身份** | Lead Agent 的平级顾问与审计合作伙伴，独立红队。canonical `agentId` 固定为 `auditor`，不另建 `advisor` worker |
| **Work Scope（前置 advisory）** | 对 Lead 明确提出的未决问题做头脑风暴、红队挑战和方案审查，给可验证的替代方向，不替 Lead 拍板 |
| **Work Scope（后置 audit）** | 独立复核 Coder 产出、查伪完成、质疑声明、给 PASS/FAIL，不把验收扩张成新方案 |
| **边界** | 不改代码（归 Coder）；不和 Coder 同源（独立性）；不跑测试（归 Tester） |
| **backend** | claude-code（官方 Claude，最强判断力） |
| **model** | claude-opus-5 |
| **effort** | xhigh（最关键的角色，给最强配置） |
| **会话复用** | `sessionReuse=lead_workspace`（M11-11C）：同一 MCP Lead server 实例在同一 workspace 内多次询问 Auditor 时，复用 provider 原生会话保留上下文/cache，每次仍是独立 run/transcript。Host/MCP 重启后开新会话；仅非 delivery；详见 `02-architecture.md §4.10` |

## Lead 派工策略

1. **Lead 拥有路由权**：worker 可以报告合同矛盾、缺少授权或能力风险，但不得自行决定拆包、缩减合同或转派。认证、provider 状态、成本和既往表现都是 Lead 的决策事实，不是自动门禁。
2. **按任务性质选通道**：主要判断语义耦合度、需求歧义、长程上下文连续性、验收边界、是否可独立并行、多模态需求、provider 可用性与成本；不按 `Low`/`HQ` 名称、prompt 长度、文件数量或预计耗时机械路由。
3. **默认实现通道偏好（Owner 劝诫，2026-08-15）**：无明确耦合、成本或并行理由时，多数实现任务优先派发 `coder_hq`（质量优先）。`coder_low` 仍是低成本高吞吐与并行容量通道——预算敏感、可独立并行的批量小包优先走 `coder_low`。此为建议性偏好（advisory），不是控制面规则；Lead 仍按语义耦合与项目实际裁量，不机械路由。
4. **高耦合 lane**：跨模块语义强耦合、歧义较高、需要一次长程保持整体设计，或拆包会显著损失上下文时优先 `coder_hq`。
5. **多模态与高质量替补**：视觉、前端、创意和多模态任务优先 `coder_mm`；也可在 `coder_hq` 不可用或任务明显受益于 K3 能力时作为高质量替补。
6. **拆包条件**：只有工作确实可独立验收、并行能降低等待或单包合同难以清晰表达时才拆；最终是否拆分或转派由 Lead 决定。
7. **顾问/审计按需**：同一个 `auditor` 专家在执行前使用 advisory 模式、交付后使用 audit 模式。只有存在明确未决问题且确定性证据不足时调用；不设默认必经审查流水线。2026-08-15 起另有劝诫级三方会审惯例（ADR 0019：信号触发、按需召集——默认姿态不变；召集时 = Lead + coder_hq/low 取一避同族与作者 + auditor/mm 取一避贡献者）——是"按需"原则的细化，不是叠加义务。

## 标准开发流（角色协作）

```
Lead 收到需求
  → 必要时派 Researcher 调研（输出 brief + affectedFiles）
  → Lead 出执行方案
  → 有明确高风险未决问题时，派 auditor（或轮换 coder_mm）走 advisory 模式提供挑战与建议（劝诫：三方会审 = Lead + coder_hq/low 取一避同族 + auditor/mm 取一，ADR 0019）
  → Lead 独立裁定方案并选择 Coder-HQ/Low/MM
  → 必要时派 Tester 提供独立执行证据
  → 高风险或 Lead 低信心时，派 auditor（或轮换 coder_mm）走 audit 模式独立复核（劝诫：三方会审组合同上；auditor 同会话连审两阶段的独立性侵蚀见 ADR 0019）
  → Lead 整合，汇报 owner
```

Worker 通过最终 assistant response 交付结果。编排层负责记录和传递。Tester 的轮询反馈给 Lead，异常时 Lead 介入。

## 配置 probe 实测结果（2026-06-24）

| 配置 | 实测 | 状态 |
|---|---|---|
| GLM-5.2 via claude-code wrapper | `open.bigmodel.cn/api/anthropic` + glm-5.2 | ✅ probe 通过 |
| GLM-5.2 effort=high | `CLAUDE_CODE_EFFORT_LEVEL=high` | ✅ probe 通过 |
| DeepSeek-v4-flash via wrapper | `api.deepseek.com/anthropic` + deepseek-v4-flash | ✅ probe 通过 |
| DeepSeek variant=max（model 后缀） | `deepseek-v4-flash:max` | ❌ 报错（只认 deepseek-v4-pro/flash） |
| DeepSeek effort=max（env） | `CLAUDE_CODE_EFFORT_LEVEL=max` | ✅ probe 通过 |
| kimi-code kimi-for-coding | 阶段 2 真实跑通 | ✅ |

**注意**：GLM/DeepSeek 的 effort 通过 `CLAUDE_CODE_EFFORT_LEVEL` 传，这是 claude-code 客户端的 effort 控制。是否真传给后端模型的 thinking effort，待实战观察——但配置层不报错，先用。

## 待确认项（需 owner 或实战定）

- ~~**Opus 4.8 的认证**~~：✅ 已解决（owner 亲自验证，2026-06-24，claude login 通过）
- **GPT5.5（Lead/Tester）**：codex 自带，不进 agents.json，但 Tester worker 如果用 codex backend，需确认 codex 的认证链路
- **effort 是否真传后端**：上面注意点，实战观察 token 消耗/响应质量判断
