# PRD：Windows Agent Orchestrator

> 状态：✅ 目标与边界已确认。本文定义 WAO 的产品目标、非目标和验收语义。
> 当前实现进度与测试数的权威来源是 `docs/roadmap.md`；runtime/model 可派发性以 `runs/reliability-summary.json` 为准。
> 技术实现细节见 `docs/02-architecture.md`。

## 0. 产品定义

**WAO is an MCP-first, Skill-guided, CLI-backed multi-runtime agent control plane.**

- **MCP-first**：任意支持 MCP 的 Agent Runtime 都可以作为 Lead Agent 使用 WAO。WAO 将提供自己的 MCP Server 作为主要 agent-facing 控制面。Lead 可通过 MCP 调用 dispatch、supervise、collect、diagnose、delivery 和 acceptance 等确定性能力。MCP 是 Lead Agent 的首选接口，不是新的 worker backend。
- **Skill-guided**：`SKILL.md` 负责告诉 Lead 何时派工、如何拆分、如何验收和遵守边界。Skill 不保存运行状态，不代替 transcript，不实现控制逻辑。Lead 继续负责语义分解、失败响应和最终验收。WAO 不自动执行语义任务分解。
- **CLI-backed**：CLI 保留为人类操作、debug、运维、CI 和 fallback 接口。MCP 与 CLI 必须调用同一个 application-service 层。禁止 MCP Server 通过 shell 调 CLI 并解析文本输出。RunManager、transcript、delivery、Backend 不依赖 MCP。当前 shared application-service 层尚未完整提取——部分 use-case orchestration 仍在 `src/commands/*.js` 中，提取是 M9 首步。
- **配置责任**：WAO 可以提供自身 MCP Server 的启动和配置入口。WAO 不接管 host runtime 的全局 MCP 配置、provider 配置或认证系统。一个 runtime 可以作为 Lead host，也可以通过 Backend 作为 worker，但两种角色必须保持边界清楚。

> 架构决策见 `.wao/decisions/0017-mcp-first-control-surface.md`。

---

## 1. 问题陈述

用户长期使用 RunMaestro 协调多个本地 agent runtime（opencode / codex / claude code）协作开发。
RunMaestro 升级后工作流彻底崩溃——主控 Agent 无法调度 worker，调度链条瘫痪。

崩溃根因（详见 `research/02`）：
- 把状态机、门控、冲突仲裁**外包给 LLM**，靠自然语言 prompt 自执行
- 三源 system prompt（Maestro playbook / runtime 自身配置 / 项目 governance）**全量灌进主控，无仲裁**
- 编排逻辑写进 agent 脑子，与 runtime 自身 prompt 体系冲突，且不可解

同时，市面上**没有**满足以下全部条件的工具（详见 `research/01`）：
- Windows 原生（无 Docker/WSL 重依赖）
- headless（可被脚本/CI/LLM 驱动，不依赖 GUI）
- runtime-agnostic（见下方定义）
- 开放可控（用户完全掌握编排逻辑，不绑闭源产品）

> **"runtime-agnostic" 的精确定义**（本词在本文档多处出现，统一指此义）：
> 指**编排逻辑（L2 控制平面 / L3 编排层 / scorecard）不针对具体 runtime 写分支**——
> 同一套 RunManager / 状态机 / DAG 引擎，对 opencode-serve / claude-code / codex 一视同仁，
> 只通过统一的 `Backend` 接口 + `RunEvent` 流交互（见 spec §2）。
> **强承诺**：加一个新 runtime 是"写一个 Backend 类 + parser"的局部加法，编排层一行不改。
> **不承诺**：① 所有 runtime 能力对等（能力差异客观存在，Backend 自行降级）；
> ② 短期 `[S]` 就能在一个工作流里混用多 runtime——真正混用要等 `[M]` 的 DAG 引擎
> 把节点和 backend 解耦。短期 `[S]` 只验证"多个 backend 各自能跑"。

Niuma 验证了"图编排 + 结构化 handoff + scorecard"的正确性，但它是 macOS-first + Docker + Electron + 闭源，不可用（详见 `research/04`）。

## 2. 目标用户

| | 范围 |
|---|------|
| **主要** | 本项目作者本人——在 Windows 上用多个本地 agent runtime 开发真实项目（life index 等）的单人开发者 |
| **次要** | 想要可脚本化/CI 驱动的 agent 编排、且排斥重 GUI 的 power user；任意 MCP-capable Agent Runtime 可作为 Lead host 接入 WAO |
| **非目标** | 企业团队、云用户、GUI-first 用户、需要细粒度多人协作的场景 |

## 3. 目标（成功长什么样）

1. **替代 RunMaestro 的角色**：可靠协调多个 agent runtime 完成真实开发工作，且不重蹈 RunMaestro 崩溃的覆辙。
2. **Windows 原生、无重依赖**：Node ESM，PowerShell 友好，核心路径不依赖 Docker/WSL。
3. **每个 run 可观测、可回放、可恢复**：transcript 是事实来源，进程崩溃/机器重启后能接续。
4. **架构不自我坍塌**：薄确定性原语 + 可插拔策略，编排逻辑不侵入 agent 的 system prompt。
5. **开放可控**：用户完全掌握编排逻辑，可版本化，可改进一次惠及所有未来任务。

## 4. 非目标（明确不做）

- ❌ GUI / kanban 看板（headless 优先，未来可由独立 client 叠加）
- ❌ 云服务 / 远程调度
- ❌ agent reasoning framework（不实现推理循环、不自己做 LLM 调用、不自动做语义任务分解）
- ❌ 接管 host runtime 的全局 MCP 配置、provider 配置或认证系统
- ❌ Docker 进核心隔离路径（留作可选 environment backend）
- ❌ 复杂权限系统（AGENTS.md 约束：保持简单）
- ❌ 自动任务分解（除非显式要求）
- ❌ 与 `D:\projects\talking-cli` 的任何耦合
- ❌ 兼容 Maestro 的 playbook 格式

## 5. 用户故事

### 5.1 基础编排（短期目标）

- **U1 并行开发**：我要在同一个项目的 3 个 worktree 上同时启动 3 个 agent，它们互不干扰地干活。
- **U2 后台跑 + 恢复**：我启动一批 run 后去做别的；机器重启或进程崩了，我能让它们接续跑，不丢失历史。
- **U3 看清楚发生了什么**：对任意一个 run，我要知道它到底干了什么——跑了哪些命令、产出了什么、卡在哪。
- **U4 重试不丢历史**：一个 run 失败了，我要基于它的原始 prompt 重跑，但保留旧 run 的完整记录。
- **U5 等价驱动**：MCP-capable Agent Runtime 通过 MCP 调用 WAO 确定性能力（dispatch、supervise、collect、diagnose、delivery、acceptance）——这是 agent-facing primary interface。人类通过 CLI 做操作、debug、运维和 fallback。两者共享同一个 application-service 层。等价的 state-changing operation 必须调用同一 service，产生相同 transcript durable facts 和 outcome；read-only query 不制造 transcript 事件，MCP/CLI 返回语义等价的结构化结果。bash 脚本和 CI 通过 CLI 驱动。三者在同一套原语上**平权**。

### 5.2 可靠性（短期→中期）

- **U6 干没干完，看证据不是看嘴**：agent 说"完成了"不算数；系统要检查测试是否真跑、产出是否真存在，才允许标记完成。
- **U7 控制运行成本**：我要知道每个 run / 每个任务烧了多少 token、花了多久，能聚合看趋势。

### 5.3 工作流编排（中期目标）

- **U8 定义可复用流程**：我要定义一次"分析→编码→测试→审查→提交"流程，之后对每个新任务复用，只换输入。
- **U9 精确调度**：流程里"审查"节点必须等"测试"节点完成才能开始，即使"编码"的数据已经到了。
- **U10 灵活扩展**：我要能注册自定义节点类型（比如"用 LLM 决定分流到哪个 agent"），不必改核心代码。
- **U11 配置即改进**：我改进了一次流程定义，之后所有任务都按新标准执行，不必改代码。

### 5.4 无人值守（中长期）

- **U12 长任务无人值守**：我定义好流程和验收标准，让系统连续跑数小时/数天，失败率低，失败时能自动处理或通知我介入。
- **U13 无对照物也能判定对错**：全新项目没有"标准答案"，我要能通过用户定义的验收契约（行为快照/契约测试/验收脚本）判定产出是否合格。

## 6. 能力清单（按架构层组织）

能力标注 **[S]**=短期目标 / **[M]**=中期目标 / **[L]**=长期目标。
本节保留原始需求分层，不再作为当前进度表；当前进度看 `docs/roadmap.md`。

### L1 运行时抽象

| 能力 | 阶段 | 现状 |
|------|------|------|
| Backend 接口（spawn / messages / abort / healthCheck / waitForCompletion） | [S] | 🟡 opencode-serve 已实现，待固化为统一接口 |
| 统一消息流 `AsyncIterable<RunEvent>`（屏蔽 HTTP 轮询 / stdio 流式差异） | [S] | ❌ 待抽象 |
| 进程式 backend（claude-code / codex，走 stdio） | [S] | ❌ 待实现，验证 runtime-agnostic（层次一：编排逻辑不绑 runtime，见 §1 定义） |
| Registry 加载与规范化 | [S] | ✅ 已有 |
| Transcript（JSONL，事件追加） | [S] | ✅ 已有 |

### L2 控制平面

| 能力 | 阶段 | 现状 |
|------|------|------|
| 显式状态机（见 `02-architecture.md §状态机`） | [S] | ❌ 当前是隐式推断 |
| run 恢复（runs resume，基于 transcript 重接） | [S] | ❌ |
| 优雅关闭（Ctrl+C abort 活跃会话） | [S] | ✅ 已有 |
| 多 run 并行 + 限并发 | [S] | 🟡 已有并行 spawn，无限并发/调度 |
| worktree 隔离 + 进程组 + 端口表 | [S] | ❌ 当前共享 cwd |
| 持久 daemon + IPC | [M] | ❌ 短期用可重入单进程过渡 |

### L3 编排层

| 能力 | 阶段 | 现状 |
|------|------|------|
| 内置工作流模板（parallel / sequential） | [M] | ❌ |
| 声明式 DAG（YAML） | [M] | ❌ |
| 数据依赖 vs 执行依赖解耦 | [M] | ❌ |
| 可插拔节点类型 | [M] | ❌ |
| 结构化 handoff（程序可校验） | [M] | ❌ |
| LLM 编排器（作为可插拔策略的一等公民） | [L] | ❌ |

### L4 接口层

| 能力 | 阶段 | 现状 |
|------|------|------|
| CLI（human/ops/debug/fallback 接口） | [S] | ✅ 已有 |
| MCP Server（agent-facing primary 控制面） | [M9] | ✅ M9 最小 Lead 闭环 complete（7 tools: registry_list/run_dispatch/run_status/run_collect/run_diagnose/run_delivery/run_delivery_decide；Codex + Claude Code/Fable 两 runtime dogfood PASS） |
| 事件订阅（通用化 tail --follow） | [M] | 🟡 已有文件轮询式 |
| shared application services（MCP 与 CLI 共用，禁止 shell-out） | [M9] | ✅ M9 最小 Lead 闭环 services 已提取（registryInventory + runDispatch + runStatus + runCollect + runDiagnosis + runDelivery）；非 M9 use-case 仍可能在 commands |

> L4 架构依赖方向和约束见 `docs/02-architecture.md` §1 分层总览。

### 横切

| 能力 | 阶段 | 现状 |
|------|------|------|
| metrics 聚合（token / 延迟 / 成功率） | [S→M] | ❌ |
| scorecard 证据链门控（程序审计，非 LLM 自报） | [M] | ❌ |
| 验收契约机制（无对照物场景） | [L] | ❌ |

## 7. 约束

- **平台**：Windows 原生，Node ESM（`"type": "module"`），Node ≥ 22
- **隔离**：worktree + 进程组 + 端口表；Docker 不进核心路径
- **依赖**：不引入依赖，除非显著降低真实复杂度（沿用 AGENTS.md）
- **风格**：两空格缩进，async/await，命名导出，backend 行为隔离在 `src/backends/`
- **测试**：`node:test` + `node:assert/strict`，每个模块配测试
- **独立**：与 talking-cli 零耦合；不搬 Windows auth/providers/plugins/skills/MCP 配置

## 8. 验收标准（怎么算"短期目标做完"）

短期目标（[S] 项）的完成定义：

1. **多 backend 并存**：registry 里同时有 opencode-serve 和至少一个进程式 backend（claude-code 或 codex），都能 spawn 并收集结果。
2. **状态机显式化**：每个 run 有明确状态（非靠最后事件推断），状态转换写 transcript。
3. **可恢复**：`runs resume <runId>` 能接续未完成的 run（或明确报告为何不可恢复）。
4. **隔离**：不同 run 用不同 worktree，进程互不残留（有 cleanup 钩子）。
5. **可观测**：`runs metrics` 能给出 token / 时长 / 成功率聚合。
6. **测试全绿**：`npm test` 通过，覆盖状态机、恢复、多 backend。
7. **实际跑通**：在本项目或 life index 上完成至少一次真实的多 agent 并行开发任务。

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 进程式 backend 的 stdout 解析不稳定 | 统一消息流抽象层吸收差异；契约测试固化输出格式 |
| 进程级隔离清理不彻底（Niuma 的 3% 失败来源） | Job Object 强制子进程随父退出；端口表 + cleanup 钩子 |
| 短期目标贪多，做不完 | 严格按 [S] 清单，[M]/[L] 不进短期 |
| 无对照物场景的验收难定义 | 留作 [L]，先用"测试真通过 + 产出真存在"做证据链门控 |

---

## 附：本文档的来源映射

| PRD 章节 | 来源 |
|---------|------|
| 问题陈述 | `research/02`（RunMaestro）、`research/01`（生态空白） |
| 目标/非目标 | `research/03`（定位）、`research/05` D2（与 Niuma 关系） |
| 用户故事 | 实战 pain（RunMaestro 崩溃）+ Niuma 验证的能力 |
| 能力清单 | `research/03` 四层架构 + `research/05` D3（目标分层） |
| 约束 | AGENTS.md + `research/05` D1（隔离方案） |
| 验收标准 | `research/05` D3（短期目标）+ `research/04`（scorecard 思想） |
