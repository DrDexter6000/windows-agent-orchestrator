# WAO 标准团队角色矩阵

> 状态：✅ 定稿（2026-06-24，决策 0005）。这是 agents.json 配置的角色驱动依据。
> 设计原则：先定 vibe coding 开发流程必要的角色职责，再给每个角色绑技术配置。
> 上游：`AGENT_ONBOARDING.md`（部署模型）、`SKILL.md`（安全铁律）、`.wao/decisions/0005`（定稿决策）。

## 部署模型（前提）

WAO 是"装一次，开发多个项目"的工具：
- **WAO skill** 装在 runtime 目录（一次性）
- **`.wao/`** 建在被开发的目标项目（每项目一次）
- agents.json 的 worker `cwd` 是**动态的**——派发时 Lead 用 `--cwd <目标项目>` 指定

## 核心原则

1. 每个角色有明确的 work scope（做什么）和边界（不做什么）
2. Worker 通过最终 assistant response 交付结果；编排层（Lead / 控制面）负责记录和传递
3. Lead 负责编排+验收，worker 只做 bounded 任务
4. Chief-Auditor 是 Lead Agent 的平级审计合作伙伴（独立于 Coder，不同源，防伪完成）
5. 默认进程式 backend（安全），opencode 仅在需要 token 闸门精确控成本时用

## 角色清单

### Lead（主控）— 不进 registry

| 维度 | 内容 |
|---|---|
| **身份** | 编排者。安装 WAO skill 的那个 runtime 自己就是 Lead（不预设 runtime） |
| **Work Scope** | 理解需求、拆任务、派发、验收、整合交付、汇报 owner、用 .wao/ 管状态 |
| **边界** | 不埋头干全程；不碰 worker 执行细节；不做架构决策不经 Auditor 审 |
| **默认 runtime** | 谁装 WAO 谁是 Lead（codex / claude-code / kimi-code 均可） |
| **配置** | 不在 agents.json（它是调用方，不是被调度的 worker） |

### Researcher（研究员）

| 维度 | 内容 |
|---|---|
| **身份** | 调研/分析专家。只读分析，不改产品代码 |
| **Work Scope** | 读代码库、技术选型、可行性分析、输出 brief/affectedFiles 清单 |
| **边界** | 不改产品代码；不跑测试（只读）；不做实现决策（决策归 Lead+Auditor） |
| **backend** | claude-code wrapper（进程式，弃 opencode——06-18 事故风险） |
| **model** | deepseek-v4-flash（1M context + 低成本，适合调研） |
| **effort** | max（深度分析） |
| **配置要点** | variant=max 用 `--effort max`（**不能用 model id 后缀**，DeepSeek 端点只认 `deepseek-v4-flash`，probe 实测） |

### Coder-HQ（码农-长程高质量）

| 维度 | 内容 |
|---|---|
| **身份** | 核心实现者。处理需要高质量/长程的编码任务 |
| **Work Scope** | 写/改代码、跑 lint/build、修 bug、按 brief 实现 |
| **边界** | 不做架构决策（归 Lead+Auditor）；不验收自己（归 Auditor） |
| **backend** | claude-code wrapper（进程式，已 probe） |
| **model** | glm-5.2（1M context，编码能力强） |
| **effort** | high |

### Coder-Low（码农-低成本快速）

| 维度 | 内容 |
|---|---|
| **身份** | 轻活快速处理。杀鸡不用牛刀 |
| **Work Scope** | 小 bug 修复、跑脚本、简单文件改动、格式调整 |
| **边界** | 不接长程/高复杂任务（归 Coder-HQ）；不做架构改动 |
| **backend** | claude-code wrapper（进程式） |
| **model** | glm-5-turbo（快速推理，低成本） |
| **effort** | 默认（不强制 high） |

### Coder-MM（码农-多模态）

| 维度 | 内容 |
|---|---|
| **身份** | 多模态处理。涉及图像/截图的任务 |
| **Work Scope** | UI 截图设计还原、带图文档、图像相关编码 |
| **边界** | 纯文本编码归 Coder-HQ/Low；不做架构决策 |
| **backend** | kimi-code（进程式，官方过 Kimi 白名单） |
| **model** | kimi-for-coding（多模态能力） |
| **配置要点** | 不要加 `--yolo`（与 -p 互斥，阶段 2 实测） |

### Tester（测试员）+ 轮询职责

| 维度 | 内容 |
|---|---|
| **身份** | 执行层验证 + 运行监控 |
| **Work Scope（原）** | 跑测试、验证 exitCode、检查产出文件存在、报缺陷 |
| **Work Scope（扩展-轮询）** | 轮询各 worker 运行状态（`runs status`/`runs list`）、检测超时/失控、向 Lead 汇报异常。降低 Lead 的 token 开销 |
| **边界** | 不修 bug（归 Coder）；不做语义判断（只看证据）；不审编排方案（归 Auditor） |
| **backend** | codex（进程式，command_execution exitCode 最准） |
| **effort** | medium（测试是确定性任务，不需高推理） |

### Chief-Auditor（审计员）— 前置 + 后置审计

| 维度 | 内容 |
|---|---|
| **身份** | Lead Agent 的平级审计合作伙伴，独立红队。与 Coder 不同源，防伪完成 |
| **Work Scope（前置审计）** | Lead Agent 出执行方案/编排后，审计方案合理性、给建议（在执行前拦截错误编排） |
| **Work Scope（后置验收）** | 独立复核 Coder 产出、查伪完成、质疑声明、给 PASS/FAIL |
| **边界** | 不改代码（归 Coder）；不和 Coder 同源（独立性）；不跑测试（归 Tester） |
| **backend** | claude-code（官方 Claude，最强判断力） |
| **model** | opus-4.8 |
| **effort** | xhigh（最关键的角色，给最强配置） |

## 标准开发流（角色协作）

```
Lead 收到需求
  → 派 Researcher 调研（输出 brief + affectedFiles）
  → Lead 出执行方案
  → 派 Auditor 前置审计方案（给建议，拦截错误编排）
  → Lead 按审计建议调整方案
  → 派 Coder-HQ/Low/MM 实现（按 brief + 方案干活）
  → 派 Tester 测试 + 轮询监控（验证 exitCode + 文件 + 运行状态）
  → 派 Auditor 后置验收（独立复核，PASS/FAIL）
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
