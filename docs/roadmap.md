# Roadmap

> 状态：✅ 已确认（第一轮）。
> 上游：`docs/01-prd.md`、`docs/02-architecture.md`、`docs/research/05-key-decisions.md`。
> 本文档定义里程碑、完成定义、依赖关系与风险。实现时按 M 编号推进。
>
> **权威边界（ADR 0018）**：WAO 自动监测，不自动监督；自动封装，不自动验收；自动呈现，不自动决策。
> （English: WAO monitors, never supervises; packages, never accepts; presents, never decides.）
> WAO 的价值是把 worker token 消耗路由到外部 provider quota；它是 Lead 的辅助执行控制面，不是门禁或第二个语义总管。

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
M7  持久执行/监督恢复 + 验收契约  [L]      daemon + LLM 编排器 + 验收契约机制
───────── 终局 ─────────
M8  Lead 体验层                  [M]      编排便利性下沉为工具默认行为（三分准则）
───────── 体验层 ─────────
M9  Agent Runtime Control Surface [M9]     MCP Server (agent-facing primary) + shared application services
───────── 控制面 ─────────
M10 Real Multi-Worker Dogfood   [M10]    host-bound workspace binding + real external-project collaboration
───────── 生产试用 ─────────
M11 Lead Experience + Adaptive Playbooks [M11]  ✅ complete（Lead friction + optional workflow templates；Tester token efficiency retire/defer）
M12 Lead Token Efficiency + Assisted Orchestration [M12]  🔧 in progress（产品合同重置；planned/unimplemented slices only）
───────── 合同重置 + token 效率（进行中） ─────────
```

> **总览用词注（ADR 0018）**：总览与下表中 M7 的 "LLM 编排器" 标签指决策 0010 声明者愿景落地的**机械 transcript 字段**（`upstream.text` 注入、provider/run header 一等字段、`requireAcceptance` 等），**不是**当前的自动语义路由产品方向；其前瞻的 "LLM 编排器作为可插拔编排策略一等公民 / 自动分流" 方向已被 ADR 0018 partial-supersede（M7 已落地的 dogfood 事实不推翻）。现行的 router/gate 是 Lead-authored deterministic function / Lead-specified mechanical condition。

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
| M7 | 持久 daemon + 监督恢复 + 验收契约：长任务可监督、可恢复，失败/卡住把证据交回 Lead 决策（不承诺 WAO 自动产生 goal、自动持续推理或自动故障策略） | 端到端测试 |
| M8 | scorecard 默认开启 + 实时仪表盘 + 故障诊断 + integrator 节点（成本预演曾在 M8 交付，已于 M11-11D 退役；编排便利性下沉为工具默认行为，三分准则：🟢工具域全自动 / 🟡Lead域工具不介入 / 🔵工具起草Lead拍板） | runManager/scorecard/cli/diagnosis/workflow engine 各自红绿 |
| M9 | 从 command modules 提取最小 Lead 闭环 application services（CLI 改为委托这些 services，行为不变）；MCP Server 使用与 CLI 相同的 application services；最小 Lead 闭环可用（inventory → dispatch → supervise → collect/diagnose → delivery query → acceptance）；等价的 state-changing operation 调用同一 service 产生相同 transcript durable facts 和 outcome，read-only query 不制造 transcript 事件返回语义等价结果；不通过 shell 调 CLI；真实 MCP dogfood（至少两个不同 Agent Runtime 分别作为 Lead host 完成受监督任务）；CLI fallback 保持可用；TD-104 强隔离边界不因 MCP 接入而放宽 | MCP server 测试 + 跨 runtime dogfood |
| M10 | Lead 在真实外部项目上完成多 worker 并行派发、liveness 监督、delivery 验证与 Lead 验收闭环；host 通过 `--workspace-root` 或 MCP roots/list 绑定 workspace，`run_dispatch` 在调用 shared service 前重新证明 workspace 并以 canonical Git root 作为 server-owned `cwd`；执行截止默认禁用，改由 `run_wait` liveness 监督驱动；independent tester TEMP composition 在真实 delivery 上通过 | workspaceBinding + mcpWorkspace + M10-1 composition final report |

## 依赖关系

```
M0 ──→ M1 ──→ M2 ──→ M3 ──→ M4   (短期,严格顺序)
                   │
                   └──→ M5 ──→ M6 ──→ M7   (中长期)
                                     │
                                     └──→ M8 ──→ M9 ──→ M10  (体验/控制面/生产试用)
                                                         │
                                                         └──→ M11 (✅ 完成) ──→ M12 (🔧 进行中，产品合同重置)
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

> **TD-103 Coder Delivery current state (2026-07-13)**: Phase 3C complete and repaid. Real supervised coder dogfood PASS (runId `run_td103_3c_dogfood_20260713`, worker coder_low / claude-code / glm-5-turbo, terminal=completed, verification=passed, acceptance=accepted). 本地凭据暴露边界与 supervised delivery 发布条件由 `docs/tech-debt.md` TD-104 + decision 0015/0016 所有；roadmap 只放指针，不复制 broker/multi-tenant 发布条件。

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
| M8 | ✅ 完成（590+ tests pass + docs-consistency 守卫） | Lead 体验层：把散落在 SKILL 指引里、靠 Lead 脑子+多命令拼的编排智能下沉为工具默认行为。按依赖序 TDD red-green：✅ M8-1 scorecard 默认 warn + `--scorecard-mode` 三态（🟢 工具域）/ ✅ M8-2 `runs dashboard` 实时仪表盘（聚合+`--watch`+异常标红，🟢 工具域）/ ✅ M8-3 `runs diagnose` 故障诊断（🔵 给证据不给处方，处方权留 Lead）/ 🗑 M8-4 `runs forecast` 成本预演曾交付、已于 M11-11D 退役（估算价值不足）/ ✅ M8-5 integrator 节点（🔵 拼初稿 Lead 终验）/ ✅ M8-6 收尾（技术债 TD-48/50 + SSOT 同步 + docs-consistency 守卫）/ ✅ 二次 dogfood 修复 TD-54~58。三分准则贯穿：🟢 工具域全自动 · 🟡 Lead 域工具不介入 · 🔵 工具起草 Lead 拍板。**不做**：自动任务拆解/自动故障应对策略表/auditor 自动串 DAG（用户明确否决，保留 Lead 自由与责任） |
| M9 | ✅ 完成 | Agent Runtime Control Surface：MCP-first 最小 Lead 闭环（7 tools）实现 + 两 runtime dogfood PASS。**M9-0~7A**：registry_list/inventory、run_dispatch/dispatch（delivery-capable）、run_status/status、run_collect/collect、run_diagnose/diagnose（含 provider_disconnect 优先级修复）、run_delivery/delivery query、run_delivery_decide/Lead acceptance。**M9-7B dogfood**：Codex（runId `run_20260715122607417p5fbue`）+ Claude Code/Fable（runId `run_20260715124226755a97el2`）两个不同 Lead Runtime 各完成真实 MCP coder delivery 闭环（terminal=completed, verification=passed, acceptance=accepted）。CLI fallback 保持可用；TD-104 强隔离不放宽。TD-106 登记 post-M9 ergonomics（bounded wait, changed-path projection, submitted observability），非 M9 blocker。 |
| M10 | ✅ 完成 | Real Multi-Worker Dogfood：在真实外部项目（Smash Bros）上证明控制面价值闭环。**完成证明**：(1) project-scoped workspace activation（M10 P0-1，host-bound `--workspace-root` / MCP roots，CLI 与 MCP 共用 `mcpWorkspaceActivation.js`）；(2) workspace-bound dispatch / recovery / stop（M10 P0-2 `run_stop`、M10 P0-3 `runs_list` + `runList.js`/`runWorkspaceOwnership.js`，project-bound recovery）；(3) default deadline disabled + `run_wait` liveness observation（M10-pre3，执行截止默认禁用 + `run_wait` 180s 观察驱动 + `ownerLiveness.js` liveness 投影，三钟分离）；(4) 真实外部项目两个 coder delivery（A=`run_20260717223656595115l1a`/`ac9a9f8`，新 B=`run_20260717231143556nvzt09`/`f0cabd1`，旧 B=`run_202607172236567802lcxc6`/`80f1bad`，Base=`cb9b335`）；(5) conditional coder_mm read-only canary（`run_20260718081326565xatx8l`，只读、completed、PASS）；(6) independent tester TEMP composition（`run_20260718081326807n79oxy`，A 硬门 8 passed、B 硬门 11 passed/4 deselected、full backend suite 224 passed）；(7) A/新 B accepted、旧 B rejected（durable decision + first-decision-wins）；(8) source checkout before/after byte-equivalent、无终态矛盾、无 loser 破坏副作用、无孤儿进程（active runs=0/owner markers=0/orphan processes=0）。两条 lane 均经 `run_wait` 180s observation-driven 监督自然终态，未调用 `run_stop`。**restart recovery 正向证据**：后续冷启动会话发现 A=accepted/新 B=accepted/旧 B=rejected 后按门在派发前停止，未重复 composition、未重复 decision、未覆盖报告——这是持久决策 + restart recovery + first-decision-wins 正常生效的证据，非产品失败。**M10 只验证控制面价值闭环**：Smash Bros delivery 仅在 WAO 侧验证，未 merge/push/tag/Release/PR/integrate 进目标项目。M10-pre/pre2/P0-1/P0-2/P0-3/M10-pre3 均已收束进本完成行。 |
| M11 | ✅ 完成 | **Lead Experience + Adaptive Playbooks**：两个核心——(1) 降低 Lead 使用摩擦，让常用闭环（派发/监督/collect/验收）更顺手；(2) 提供小而可选、可修改的 playbook/template，不强制统一 workflow，不自动做语义拆解。**已完成**：M11-0A（OpenCode 项目级 WAO MCP 安装文档：`opencode-ai` 包名、`npm ci`、`opencode.json` array-command schema、`--pure`/新进程边界）；M11-1A（`run_delivery` 安全 changed-path 投影：64 cap、repo-relative 校验、`changedPathsTruncated`，复用 `delivery.js` path SSOT，无 raw diff/绝对路径/secret 泄漏）；M11-1B（`createWorktree` 清理：`/.wao-worktrees/` 稳定仓库本地 exclude hygiene 规则 + owner-token 短锁租约语义，stable rule 在 `git worktree add` 失败时不回滚）；M11-2（**Adaptive Playbook Catalog 已交付**：四个内置只读 Lead playbook + `playbook_list`/`playbook_get` MCP 工具 + `playbook list`/`playbook show` CLI fallback，委托同一 `application/playbookCatalog.js` SSOT，output trust boundary + id-binding 已闭合；`SKILL.md` Routing Contract 明确 WAO worker 与 native subagent 路由边界 + run_dispatch runId 事实标准；**fresh Codex CLI Lead dogfood 已完成，verdict `PASS_WITH_HOST_FRICTION`**（runId `run_202607192128556114jk5v4`，delivery `cc4bfda`，verification passed，acceptance accepted；完整审计留 gitignored `.dev/`））；M11-3A/B/C（exact delivery proof、bounded/redacted diff projection、`run_delivery_review` MCP + CLI shared-service adapter）已完成并发布；M11-3D **fresh Codex CLI Lead dogfood 已完成，verdict `PASS`**（runId `run_20260721225501254ly42og`，delivery `76039be`，verification passed，acceptance accepted；完整审计留 gitignored `.dev/`）。**M11-4 run_collect continuation 已交付并通过 fresh Lead dogfood**：`run_collect` 续读（continuation）已实现——共享安全投影 `runCollectProjection.js` + opaque cursor codec + frozen-prefix snapshot stability + 跨页 exact-secret redaction + deferAppend 合同（invalid cursor / projection failure 零追加 audit）；CLI 续读入口与 MCP 委托同一投影。**fresh Codex CLI Lead dogfood 已完成，verdict `PASS_WITH_HOST_FRICTION`**（runId `run_m114_fresh_lead_20260722`；完整审计留 gitignored `.dev/`）。M11-5（Worker Role Contract Parity，TD-89 修复）已完成：Lead 无须手工复制角色说明，WAO 自动、可靠地向三个 process backend（claude-code / codex / kimi-code）注入 registry-owned 角色合同；不支持注入的 backend 明确拒绝。三条真实 canary 全通过（runId 锚点：`run_m115_canary_kimi_20260722222100` / `run_m115_canary_codex_20260722222352` / `run_m115_canary_claude_20260722223035`）。跨项目验收通过：从 Life Index cwd 调用全局 registry，`registry validate` 6/6 全过。机制（路径权威、capability 严格判断、加载时序、注入通道）见 `docs/02-architecture.md`；详细证据见 gitignored `.dev/`。**M11-10 Delivery Readiness Handshake 已交付并通过 fresh Lead canary**：`run_delivery` 增加可选 `waitMs` 触发 bounded 只读 readiness wait（入口：MCP `run_delivery` `waitMs` / CLI `runs delivery --wait-ms N`，共用同一 `getRunDeliveryReadiness` service）。核心结果：投影严格闭集 `readiness` + `waitReturnedEarly`；`reviewable` 复用 `validateDeliveryFacts` SSOT，冲突/孤立 durable 事实 fail-closed 为 `ambiguous`；wait 只读、零 transcript append，绝不 stop/retry/accept/reject。完整合同见 `docs/usage.md` §`run_delivery`。TDD 红→绿：42 tests pass（`test/m11-10-readiness.test.js`）；fresh Codex Lead canary `PASS`（runId `run_20260726093455485nl8l84`，delivery `df8bf65`，唯一一次 `run_delivery(waitMs)` 返回 `reviewable` + verification passed，acceptance accepted，一次性项目已清理）。**M11-11A/C Lead 日常体验修复已完成**：默认观察窗口为 270 秒且不作为失败判据；同一 MCP Lead server 实例在同一 workspace 对 Researcher/Auditor 的非 delivery 追问可复用 provider 会话，每次仍创建独立 WAO run/transcript。真实双 run canary 通过（`run_20260726130105899fc4g0v` → `run_20260726130112391y43ux7`）；机制见 `docs/02-architecture.md` §4.10。**M11-11D 小摩擦收尾已完成**：普通非 delivery run 的 `run_delivery` 返回结构化事实而非通用错误；`run.stop_verified` 明确解释为 runtime 已静默而非 Lead 必然调用 stop；`run_wait terminal:true` 后直接 collect、无需重复 status；无价值的 `runs forecast` 已退役。**Tester context/token efficiency 退役/deferred**（移出 M11 范围，不在本里程碑追）。**M11 闭环。** |
| M12 | 🔧 进行中 | **Lead Token Efficiency + Assisted Orchestration**：产品合同重置（ADR 0018）——明确 WAO 的核心价值是把 worker token 消耗路由到外部 provider quota、WAO 是 Lead 的辅助执行控制面（不是门禁、不是第二个语义总管）；五份 authority docs + ADR-0018 携带精确 containment 句、router/gate 降权为机械（router=Lead-authored deterministic function、gate=Lead-specified mechanical condition）、certification 改为 advisory evidence、M11 关闭。**M12-1 S1/S2 已实现**：`disallowed_path` 失败可只读投影 `candidateInventory`，Lead 审核后可用 `run_delivery_repackage` 在不重调模型的前提下复用原 worktree/base/verification declaration 原地重新检查、封装和验证；WAO 不推断新范围、不自动 accept/reject。**M12-2A 已实现**：`run_collect(mode:"compact")` 在同一安全 snapshot 上返回最后一条 bounded assistant 文本与 evidence counts，empty/too_large 诚实返回、原 full/cursor 路径保留。**M12-3A/B 已实现**：`run_await_result` 以一次 0..270 秒总等待预算机械组合 wait + truthful observation + terminal compact；`run_delivery_review_bundle` 以一次 readiness wait 机械组合安全 delivery 事实与 Lead 指定的单文件一页 review，非 reviewable 时零 diff read。两者均只读 advisory，原子工具始终保留，不 stop/retry/repackage/decide；delivery worktree containment 同步闭合为 lexical + physical realpath 双重检查。**M12-4A 已实现**：verified-quiet `backend_error|backend_stream_ended` 失败可投影 `candidateKind:"backend_failed"` + 完整 `candidateInventory`，由 Lead 明确 scope 后复用同一 `run_delivery_repackage` 无模型重封装；不恢复 provider session、不自动扩域或 decision。**M12-4B 已实现并通过重启后真实 delivery canary**：Claude Code 写工具先投影 `write_intent`，仅匹配同一 opaque `toolCallId` 的成功结果确认 `file_written`；未关联、重复、pending 超限或终态仍未确认均在 packaging 前 fail closed。真实 `coder_low` canary（run `run_20260729161100056r1e739`）只写一个新文件，terminal completed、verification passed、delivery `62231274e5f5d94aba277474ce38afefee2554f0` 可审查，source repo 保持 clean 且未作 acceptance decision。**M12-5 已完成并通过重启后真实 MCP 验收**：`runs_list` / `lead_preflight` 的 workspace ownership 证明改为单次查询内缓存授权 root、每个不同 cwd 及不可证明结果，隔离和 fail-closed 语义不变；Host 加载精确提交 `169ce4f676ccc4381aef040ea2dcc8eea116be0e` 后，1375 份 transcript 下 `runs_list({limit:1})` 从旧版 59.022 秒降至 4.911 秒（约降低 91.7%），`lead_preflight({workspaceRoot})` 为 3.373 秒且 `complete=true`、三项 `checkStatus` 均为 `observed`。其余 planned/unimplemented slices：deterministic evidence/handoff aggregation；bounded actionable failure facts；factual readiness/history projection。**M12-7 Lead 授权修正续跑已实现**：当 Lead 审阅一个终态、`continuable` 的 delivery 后发现窄缺陷，可显式授权**一**个修正回合——WAO 创建**新** run/transcript，**复用父 run 的 retained worktree**（不开新 worktree、不开新 provider 会话），以 `turn:resume` 续同一 provider-native 对话，并打包新 child delivery（`run_continue` MCP 工具，输入 `{parentRunId, prompt, delivery}`；`run_dispatch` 新增可选 `continuable` 标记终态 delivery 为续谱根并以 `turn:first` 建立谱系 provider 会话）。谱系作用域而非 project-wide：opaque uuid 由 server-owned Lead session + canonical workspace + canonical agentId + **root runId** 派生，只跨这一条 lineage 复用，与 M11-11C 的 `lead_workspace` expert 复用是互斥的两套 routing。**Lead 语义唯一**：WAO 不推断 correction 的存在/范围/verification/retry/acceptance，只在 Lead 显式调用时发生一次；child 的 review/accept/reject 仍走既有交付工具归 Lead。资格/因果检查在任何 mutation 之前以闭集 `rejectionReason` 拒绝（malformed/legacy/非终态/非 continuable/跨 workspace/无 delivery/不支持 backend/retained worktree 丢失或漂移/busy）；retained-worktree 转换幂等且崩溃安全，父 commit 对象永不删除。续谱 provider uuid/Lead id/workspace 路径/active lineage runId 永不出现在 MCP 输出。机制见 `docs/02-architecture.md` 与 `docs/usage.md` §`run_continue`。 **M12-8A/B/C/D 已发布；M12-8E fresh canary 与 `run_wait` 下钻一致性本地候选已完成**：Lead 获得 `run_activity` 有界活动时间线与七个观察工具统一的 `availableDrilldowns`；Human Owner 获得 loopback-only `runs dashboard --web`，其服务与 UI 共用 activity projector、不直接解析 JSONL、无控制或决策能力。真实 headed desktop/mobile 浏览器验收通过；delivery `3c812a1b8b25cc3ae56fb0152498c486cd621abe` 经 Lead 接受，独立风险 review 后的 cursor filter binding 与 runs/activity freshness 修复 delivery `16ed6db2edbb04c684a09bf5f615fabe90fcea84` 亦经 Lead 接受。TD-107 canonical runner 已解决历史随机假红；M12-8E 已用真实 `coder_low` run `run_20260802104033172rt04hc` 证明 Lead 可按需下钻并显式停止；冻结候选唯一 canonical `171/171` files 通过，当前未 push/tag/Release。 |

### M12-6 真实 Host 验收与文字关单（2026-08-01）

重启后的 Codex Host 加载了 M12-6 发布态的 **20 个 MCP tools**。单次 `lead_preflight` 在 WAO 开发仓精确 HEAD 上返回 `workspaceSelection:selected`、workspace/workers/activeRuns 三项 `observed`、active run 为 0 且 `complete:true`；故意提供错误 `expectedGitHead` 的 `run_dispatch` 在创建 run 前固定拒绝，随后以正确 workspace/HEAD/dirty 期望派发真实 certified `coder_hq`，得到 run `run_20260801134619889cxvx2v`。这组证据关单的是 **Host 已加载、单调用启动检查、workspace/head expectation 与真实 runtime dispatch 路径**；该 run 后续因 Lead 预声明路径不完整而发生的 delivery scope failure 没有被伪装成 M12-6 通过，也不构成 accepted delivery，候选已由 Lead 持久拒绝并作为 M12-7 续跑体验的真实输入。M12-6 verdict：`PASS_HOST_ACCEPTANCE_AND_TEXT_CLOSEOUT`。

### M12-7 真实 provider continuation 验收（2026-08-01）

重启后的 Codex Host 加载了包含 `run_continue` 的 **21 个 MCP tools**。在一次性合成 Git 仓库的 clean base `368377bdc56218ced9f019ee0c9d88c1edfaf1c3` 上，Lead 以 `continuable:true` 派发真实 `coder_hq` 根 run `run_202608011845146861hsubm`；其 V1 delivery `375c9e20a4890c48ea7535e74c98a599701c428a` 经完整单文件 review 与精确 verification 后被 Lead 有意拒绝。Lead 随后显式调用 `run_continue` 创建 child `run_20260801184704043af91q5`：durable facts 证明 `turn:first -> turn:resume`、stable root/parent lineage 与同一 retained worktree；WAO 隔离的 Claude 会话存储证明父、子两轮内容落入同一个 provider conversation 文件（仅验证同一性，不披露 provider session id）。child 交付 `70b59898efdb0b1a68da945e6c5c2392b5aecb4a` 将 V1 窄纠正为 V2，精确 verification passed，经 Lead 完整 review 后 durable accepted。合成仓 source checkout 仍停在原 base、clean，最终 active runs 为 0。

候选验证：M12-7 focused `42/42`、continuation worktree/TOCTOU `23/23`、affected regression `376/376`、首轮全量失败面在自包含环境中 `174/174`、`runAwaitResult` 隔离 `34/34`。原样全量 `npm test` 在 Windows 高并发下出现每轮位置不同的历史锁/子进程/墙钟假红；本关单不以重复运行碰巧全绿替代因果证据，也不虚报 canonical 0 fail，后续可靠性改造登记为 TD-107。M12-7 verdict：`PASS_M12_7_REAL_CONTINUATION_CANARY`。

### M12-8 Lead/Owner progressive disclosure 与 fresh supervision canary（2026-08-02）

M12-8A/B/C/D 已发布：Lead 的 `run_activity` 使用单 transcript 快照、七类安全事件、opaque frozen cursor 与 Lead 级 caps；`run_wait`、`run_await_result`、`run_status`、`run_diagnose`、`run_collect`、`run_delivery`、`run_activity` 七个观察工具统一给出静态有界 `availableDrilldowns`，提示可继续查看的深度/成本但不自动调用。Owner 的 `runs dashboard --web` 仅监听 loopback，以随机 fragment token、严格只读 API 和同一 Owner activity projection 提供人类实时页面，Owner 消息更详细但仍隐藏 secret/credential/raw command/tool payload/PID/session/绝对路径。

真实 headed Playwright 在 desktop 与 `390x844` mobile 通过：recent-runs 在移动端内部滚动，选中 activity 可达；fragment 被清除、token 仅存 `sessionStorage`、`localStorage` 为空；未出现 mutation control，未授权 API 为 401、traversal 为 404，no-store/nosniff/CSP 生效，自动 polling 有真实请求证据且浏览器 console 零 error/warning。delivery run `run_2026080209023901192ox47`（commit `3c812a1b8b25cc3ae56fb0152498c486cd621abe`）经 Lead exact review/verification accepted；独立 `coder_mm` 风险 review `run_20260802092954132u8o9b2` 发现的 cursor filter binding 与 runs/activity freshness 两项中风险缺陷，由 correction run `run_202608020937056037jbwxs` 修复并经 Lead exact review accepted（commit `16ed6db2edbb04c684a09bf5f615fabe90fcea84`）。fresh supervision canary 使用真实 `coder_low` run `run_20260802104033172rt04hc`：一次 30 秒 `run_await_result` 返回 `running/progress` + activity drilldown，`run_activity(afterSeq:0)` 显示 3 次成功读取、worker 明确选择 current source/value 42、0 file write 与正在运行的长命令；Lead 在语义判断后显式 `run_stop`，`stopVerified=true`、最终 state `aborted`、active runs 归零，合成仓 HEAD/status 不变。该 canary 证明 Lead 可按需下钻并及时停止，但 WAO 没有自动判断或自动停止。M12-8E verdict：`PASS_FRESH_LEAD_MID_RUN_OBSERVE_AND_STOP`。

M12-8E 候选验证：TDD focused `38/38`，补齐 MCP 七工具合同后 focused `49/49`，affected + docs `190/190`；唯一 canonical runner 最终 `verdict=pass`（discovered/executed/passed `171/171/171` files，0 fail/missing/crashed，5 waves），`git diff --check` clean。首轮 canonical 稳定识别出 `mcpDrilldowns.test.js` 仍冻结“六工具”旧合同，候选修正后仅重跑受影响范围，再执行一次冻结候选 canonical；未以随机重跑覆盖失败。本轮无新技术债。

**M11-12A/B 消费者摩擦收口已完成**：`run_delivery_review` 将 verification pending 投影为可等待/重试的结构化只读事实；`run_delivery` 在 exact verification 失败时提供 nullable 8 字段安全摘要（失败命令索引、声明/执行计数、Windows 退出码与字节计数），不暴露命令或输出内容。当前合同见 `docs/usage.md`。
