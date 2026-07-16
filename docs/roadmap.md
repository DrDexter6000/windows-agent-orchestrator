# Roadmap

> 状态：✅ 已确认（第一轮）。
> 上游：`docs/01-prd.md`、`docs/02-architecture.md`、`docs/research/05-key-decisions.md`。
> 本文档定义里程碑、完成定义、依赖关系与风险。实现时按 M 编号推进。

## 总览

```
M0  地基重塑                    [S]      transcript 扩展 + 显式状态机 + RunManager
M1  统一事件流                  [S]      opencode-serve 迁移到 RunHandle.events
M2  第二个 runtime              [S]      ProcessBackend + parser(claude-code 或 codex)
M3  隔离与恢复                  [S]      worktree + 进程隔离 + 端口表 + runs resume
M4  可观测                      [S]      metrics 聚合(token/时长/命令数)
───────── 短期目标完成,PRD §8 验收 7 条全绿 ─────────
M5  DAG 编排骨架                [M]      YAML DAG 引擎 + 结构化 handoff + 数据/执行依赖解耦
M6  scorecard + 可插拔节点      [M]      证据链门控 + 自定义节点注册
───────── 中期目标完成 ─────────
M7  无人值守 + 验收契约          [L]      daemon + LLM 编排器 + 验收契约机制
───────── 终局 ─────────
M8  Lead 体验层                  [M]      编排便利性下沉为工具默认行为（三分准则）
───────── 体验层 ─────────
M9  Agent Runtime Control Surface [M9]     MCP Server (agent-facing primary) + shared application services
───────── 控制面 ─────────
M10 Real Multi-Worker Dogfood   [M10]    host-bound workspace binding + real external-project collaboration
───────── 生产试用 ─────────
```

## 里程碑完成定义

| M | 完成当且仅当 | 测试锚点 |
|---|-------------|---------|
| M0 | 状态机显式化,`run.state_change` 写入 transcript,`findState()` 能推算状态 | `runManager.test.js` 状态转移全覆盖 |
| M1 | opencode-serve 的 `waitForCompletion` 改为消费 `handle.events`,旧 CLI 行为不变 | `opencodeServe.test.js` + 集成测试 |
| M2 | registry 里同时有 opencode-serve 和进程式 backend,各自能 spawn+collect | `processBackend.test.js` |
| M3 | 不同 run 用不同 worktree,进程残留被清理,`runs resume` 能接续 | `isolation.test.js` + 真实 worktree 测试 |
| M4 | `runs metrics <runId>` 给出 token/时长/命令数 | 聚合测试 |
| M5 | 一个 YAML workflow 能跑通(至少 3 节点,含并行+串行+依赖等待) | DAG 引擎测试 |
| M6 | scorecard 阻止一个"agent 说完成但测试没真跑"的 run 进入 completed | scorecard 测试 |
| M7 | 一个无人值守工作流跑数小时,失败自动处理或通知 | 端到端测试 |
| M8 | scorecard 默认开启 + 实时仪表盘 + 故障诊断 + 成本预演 + integrator 节点（编排便利性下沉为工具默认行为，三分准则：🟢工具域全自动 / 🟡Lead域工具不介入 / 🔵工具起草Lead拍板） | runManager/scorecard/cli/diagnosis/costForecast/workflow engine 各自红绿 |
| M9 | 从 command modules 提取最小 Lead 闭环 application services（CLI 改为委托这些 services，行为不变）；MCP Server 使用与 CLI 相同的 application services；最小 Lead 闭环可用（inventory → dispatch → supervise → collect/diagnose → delivery query → acceptance）；等价的 state-changing operation 调用同一 service 产生相同 transcript durable facts 和 outcome，read-only query 不制造 transcript 事件返回语义等价结果；不通过 shell 调 CLI；真实 MCP dogfood（至少两个不同 Agent Runtime 分别作为 Lead host 完成受监督任务）；CLI fallback 保持可用；TD-104 强隔离边界不因 MCP 接入而放宽 | MCP server 测试 + 跨 runtime dogfood |
| M10 | Lead 可以复用既有 worker 在当前宿主授权项目中派发任务，不需要为每个项目新建 worker；MCP host 通过 `--workspace-root` 或 MCP roots/list 绑定 workspace，`run_dispatch` 在调用 shared service 前重新证明 workspace 并以 canonical Git root 作为 server-owned `cwd`；模型不能通过 tool argument 传任意路径；CLI `--cwd` 路径行为不变 | workspaceBinding + mcpWorkspace + smoke |

## 依赖关系

```
M0 ──→ M1 ──→ M2 ──→ M3 ──→ M4   (短期,严格顺序)
                   │
                   └──→ M5 ──→ M6 ──→ M7   (中长期)
```

- M0 是所有后续的地基（transcript 事件类型 + 状态机是大家共用的）
- M1 必须在 M2 前（先验证统一事件流抽象，再加第二个 backend 去压测它）
- M3 依赖 M2（恢复机制要能处理进程式 backend 的会话）
- M5 依赖 M3（DAG 节点跑在不同 worktree 上，需要隔离层就位）

## 相对工作量（不给绝对天数）

⚠️ LLM 对绝对时间的预估基于传统流程，agentic coding 实际更快。此处只给相对大小。

- ◻ 小（transcript 改动、加字段、加测试）
- ◻◻ 中（新模块，但有明确契约参照）
- ◻◻◻ 大（新抽象 + 实测未知，如 parser）

| M | 相对大小 | 主要不确定性 |
|---|---------|------------|
| M0 | ◻◻ | 状态机和现有 CLI 逻辑的解耦 |
| M1 | ◻ | 迁移路径清晰，spec 已定 |
| M2 | ◻◻◻ | claude-code/codex 的输出格式待实测 |
| M3 | ◻◻ | Windows 进程隔离 + worktree 自动化 |
| M4 | ◻ | 纯聚合，无新依赖 |
| M5 | ◻◻◻ | DAG 引擎是新抽象，依赖解析+拓扑排序 |
| M6 | ◻◻ | scorecard 规则库要随实战积累 |
| M7 | ◻◻◻ | daemon + LLM 编排器，两个大未知 |

## 短期两大风险点

### 风险 1：M2 的 parser（◻◻◻）

claude-code / codex 的流式输出格式是实测未知。若格式不结构化，parser 要做容错降级，可能拖长 M2。

**缓解**：M2 先只做一个 runtime（选输出最结构化的那个），另一个留到验证抽象成立后再加。

### 风险 2：M3 的 Windows 进程隔离（◻◻）

严格的 Job Object 需要 ffi 或原生 addon，可能引入依赖（违反 AGENTS.md "不加依赖"原则）。

**缓解**：先用 Node 的 `child_process` + 进程树 kill 做退路，Job Object 作为增强。
spec §4.3 的 cleanup 钩子是确定性的，即使没有 Job Object 也能保证基本清理。

## 进度跟踪

> **TD-103 Coder Delivery current state (2026-07-13)**: Phase 3C complete and repaid. Real supervised coder dogfood PASS (runId `run_td103_3c_dogfood_20260713`, worker coder_low / claude-code / glm-5-turbo, terminal=completed, verification=passed, acceptance=accepted). TD-104 containment is deployed and Owner credential rotation is complete. Strong-isolation boundary remains per TD-104 / decision 0015/0016; supervised single-process delivery is allowed, but unattended or multi-tenant release still requires a credential broker.

| M | 状态 |
|---|------|
| M0 | ✅ 完成（43 tests pass，含技术债审计，见 [m0-audit.md](./archive/m0-audit.md)）|
| M1 | ✅ 完成（54 tests pass，含技术债审计，见 [m1-audit.md](./archive/m1-audit.md)）|
| M2 | ✅ 完成（83 tests pass，含技术债审计，见 [m2-audit.md](./archive/m2-audit.md)）|
| M3 | ✅ 完成（102 tests pass，含技术债审计，见 [m3-audit.md](./archive/m3-audit.md)）|
| M4 | ✅ 完成（122 tests pass，含技术债审计，见 [m4-audit.md](./archive/m4-audit.md)）|
| M5 | ✅ 完成（158 tests pass，含技术债审计，见 [m5-audit.md](./archive/m5-audit.md)）|
| M6 | ✅ 完成（204 tests pass，含技术债审计，见 [m6-audit.md](./archive/m6-audit.md)）|
| post-M6 修复轮 | ✅ 完成（268 tests pass + reliability 套件）。两轮实战测试暴露的完成判定/provider/metrics/scorecard 问题全部修复，见 [changelog-2026-06-17.md](./changelog-2026-06-17.md) |
| runtime certification 收束 | ✅ 完成（Claude Code-first 正式监督试运行）。主力 lane 全进程式（claude-code/kimi-code/codex），opencode-serve 降级为 fallback（决策 0005）。6 worker 全认证（5 certified + coder_mm conditional）：researcher/coder_hq/coder_low/tester/auditor=certified，coder_mm=conditional（kimi 不吐 metrics，能力正常）。期间诊断闭环两个根因：coder_hq 早期 rejected=glm-5.2 服务端瞬时 529 过载（非配置问题，非高峰即恢复）；auditor rejected=model 名 `opus-4.8` 无效（claude-code 只认别名 `opus` 或全名 `claude-opus-4-8`，已改）。reliability 套件修复：summary 增量合并（单跑不再覆盖全量结果）、silentTimeout 探针 serve 不在时自动 skip。当前 runtime/model 可派发性以 `runs/reliability-summary.json.workers` 为准（429 tests pass）|
| M7 | ✅ 完成（P0-P5 完成，536 tests pass） | **多阶段行动大纲已归档**：[`docs/archive/m7-phases.md`](./archive/m7-phases.md)；**收尾审计见 [`docs/archive/m7-audit.md`](./archive/m7-audit.md)**。M7 6 phase 全完成：✅ P0（真任务 dogfood）/ P1（验收契约=用户验收脚本，ADR 0011）/ P2（detached runner，06-18 架构洞正解）/ P3（持久 daemon + 命名管道 IPC + 心跳 + resume + D-F1..D-F4 收口）/ P4（LLM 编排器，决策 0010 声明者愿景：T1 upstream.text / T2 provider 一等字段决策B / T3 run header 决策A / T4 requireAcceptance+warn 决策C）/ **P5（长跑 hardening：T1 自愈 supervisor TD-45 / T2 可观测 health TD-46 / T3 真实长跑 45min/265run/0fail/0warn ✅ / T4 文档）**。两个硬事实收敛：①验收契约由 P1 定为用户脚本（落地于 P4-T4）；②"拒绝裸 spawn"换"接管"由 P2/P3 完成。UX 见 `.wao/decisions/0010`。详见 m7-audit。**M7 闭环。** |
| M8 | ✅ 完成（590+ tests pass + docs-consistency 守卫） | Lead 体验层：把散落在 SKILL 指引里、靠 Lead 脑子+多命令拼的编排智能下沉为工具默认行为。5 项全做（按依赖序 TDD red-green）：✅ M8-1 scorecard 默认 warn + `--scorecard-mode` 三态（🟢 工具域）/ ✅ M8-2 `runs dashboard` 实时仪表盘（聚合+`--watch`+异常标红，🟢 工具域）/ ✅ M8-3 `runs diagnose` 故障诊断（🔵 给证据不给处方，处方权留 Lead）/ ✅ M8-4 `runs forecast` 成本预演（🟢 bonus）/ ✅ M8-5 integrator 节点（🔵 拼初稿 Lead 终验）/ ✅ M8-6 收尾（技术债 TD-48/50 + SSOT 同步 + docs-consistency 守卫）/ ✅ 二次 dogfood 修复 TD-54~58。三分准则贯穿：🟢 工具域全自动 · 🟡 Lead 域工具不介入 · 🔵 工具起草 Lead 拍板。**不做**：自动任务拆解/自动故障应对策略表/auditor 自动串 DAG（用户明确否决，保留 Lead 自由与责任） |
| M9 | ✅ 完成 | Agent Runtime Control Surface：MCP-first 最小 Lead 闭环（7 tools）实现 + 两 runtime dogfood PASS。**M9-0~7A**：registry_list/inventory、run_dispatch/dispatch（delivery-capable）、run_status/status、run_collect/collect、run_diagnose/diagnose（含 provider_disconnect 优先级修复）、run_delivery/delivery query、run_delivery_decide/Lead acceptance。**M9-7B dogfood**：Codex（runId `run_20260715122607417p5fbue`）+ Claude Code/Fable（runId `run_20260715124226755a97el2`）两个不同 Lead Runtime 各完成真实 MCP coder delivery 闭环（terminal=completed, verification=passed, acceptance=accepted）。CLI fallback 保持可用；TD-104 强隔离不放宽。TD-106 登记 post-M9 ergonomics（bounded wait, changed-path projection, submitted observability），非 M9 blocker。 |
| M10-pre/pre2 | 🔧 准备中 | Bounded runtime policy（M10-pre）+ host-bound workspace binding（M10-pre2）。M10-pre：timeout SSOT（explicit > agent > global > default，1000..600000 bounded）、process stop verification（verified/unverified/probe_error fail-closed）、global config threading。M10-pre2：workspace proof SSOT（`proveWorkspace`）、MCP `workspace_status` tool（只读，source/gitHead/dirty）、`run_dispatch` 重新证明 workspace 并以 canonical root 作为 server-owned cwd、stdio `--workspace-root` fallback。零真实模型调用，no-model real stdio smoke 已通过。**M10 P0-2 进行中**：`run_stop` MCP tool + 共享 `runStop.js` application service（workspace-bound，first-terminal-wins 终态认领 + PID 存活 stop verification，不返回 PID/path/session）文档已落地。**M10 P0-3 进行中**：`runs_list` MCP tool + 共享 `runList.js` / `runWorkspaceOwnership.js` application service（workspace-bound run 列表，project-bound recovery，`activeOnly`/`limit` 输入，`runs`/`returnedCount`/`truncated` 输出）文档已落地。M10 整体未完成。 |
