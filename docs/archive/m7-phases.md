# M7 行动大纲（Phase Plan）

> ⏳ **历史快照**：M7 已完成，本文已归档，不是现行契约源。当前里程碑状态见 `../roadmap.md` 的 M7 行；收尾审计见 `m7-audit.md`。
>
> 原类别：M7 执行期 phase plan。归档后只保留当时行动大纲与验收脉络，不维护当前事实。

## 为什么拆（两个硬事实，决定拆法）

经 `docs/research/` + PRD + 事故复盘全量核查，M7 不是"一个里程碑"，是**三个独立大未知
捆在一起**，且有**两个必须先正视的硬事实**：

**🔴 事实 1：验收契约（PRD U13）实质未定义。** 6+ 处提到它，唯一的"定义"是三选一候选列表
（行为快照 / 契约测试 / 验收脚本），从未收敛（`docs/01-prd.md:88`、`research/03:212`、
`research/05:171`）。M7 完成定义（`roadmap.md:34`）甚至没提它。**这是伪装成已知需求的
绿地设计问题**——不能直接拆代码，得先做需求收敛（见 P1）。

**🔴 事实 2："拒绝裸 spawn"护栏恰恰堵死了它要服务的无人值守。** TD-39 最小护栏
（`runManager.js:171`）在 `fireAndForget && sessionOutlivesProcess` 时拒绝派发——这让**无人值守
opencode 派发不可能**。06-18 事故（`incidents/2026-06-18-glm-quota-drain.md`）证明：所有现有
防线（token 闸门 S1-1、stop 静默验证 TD-37/38）**全活在 `waitForCompletion()` 内部**，而无人值守
的定义就是"没有调用方在 wait"——所以**按构造这些防线全不触发**。这是 06-18 事故的精确架构洞，
M7 必须把"拒绝"换成"接管生命周期"。

**结论**：不能线性按"watchdog→契约→daemon→编排器"顺序硬推。正确拆法是**地基→能力→愿景**，
每个 phase 独立可交付、可停、有验收，且**先收敛未定义需求**。

---

## Phase 总览（地基→能力→愿景，风险递增）

| Phase | 名字 | 性质 | 依赖 | 独立可交付 | 风险 |
|-------|------|------|------|-----------|------|
| **P0** | 真任务 dogfood 基线 | 验证 | 无 | ✅ 完成（2026-06-25） | 低 |
| **P1** | 验收契约需求收敛 | 设计（ADR） | 无 | ✅ 完成（2026-06-25） | 中（绿地） |
| **P2** | 后台生命周期接管（watchdog） | 能力+安全 | 无 | ✅ 完成（2026-06-25） | 中 |
| **P3** | 持久 daemon + IPC | 能力 | P2 | ✅ 完成（2026-06-25） | 高（新进程模型） |
| **P4** | LLM 编排器（声明者愿景） | 愿景 | P1, P3 | ✅ 完成（2026-06-26） | 高 |
| **P5** | 长跑稳定性 hardening | 收尾 | P2,P3 | ✅ 完成（2026-06-26）：T1 自愈 supervisor / T2 health 可观测 / T3 长跑 45min/265run/0fail/0warn | 中（新 bug 类别） |

**关键排序逻辑**：
- P0/P1 无代码依赖、风险最低，**先做**——P1 尤其，因为它解的是"未定义"，不解则 P4 无的放矢。
- P2 是 06-18 事故的架构正解 + daemon 最小前身，**安全收益立竿见影**，独立于 daemon 可交付。
- P3 风险最高（全新进程模型 + Windows 长跑），放 P2 之后——P2 跑稳了，daemon 就是"把 P2 长期挂起 + 加 IPC"。
- P4 依赖 P1（要验收契约可声明）+ 决策 0010 的声明者愿景，最自然放最后，可渐进。

---

## P0 — 真任务 dogfood 基线（先做）

**目标**：用 WAO 自己的真实复杂任务（非 sentinel）验证当前链路，**用真实 friction 喂给后续 phase**。
**做什么**：在**隔离 worktree**（`--isolate`，标准动作）里跑真实多 worker 任务，例：
- researcher 读 WAO 某模块 → coder_hq 在隔离 worktree 写该模块测试 → tester 跑 → auditor 验收。
**产出**：真实交付物（WAO 自己的测试覆盖）+ 一份"真实长任务 friction 清单"（过程类，进 research/）。
**验收**：任务真完成（scorecard 门过）+ worktree 无污染 + friction 清单落盘。
**不做什么**：不修代码（P0 是观测，不是修复）。

## P1 — 验收契约需求收敛（ADR，解事实 1）

**目标**：把"行为快照/契约测试/验收脚本"三选一收敛成 WAO 的具体契约格式。
**做什么**：
1. 研究 Niuma 案例的对照物机制（`research/04`）+ 现有 scorecard 证据门的边界。
2. 产出 ADR（`.wao/decisions/0011-验收契约格式.md`）：定义契约格式、与 scorecard 的关系、
   三选一的取舍理由（哪个适合 WAO 的进程式 lane + 证据链哲学）。
3. **不写代码**——P1 是设计收敛，P2+ 才实现。
**验收**：ADR 落盘 + owner 认可格式（这是决策点，需 owner 拍板三选一）。
**风险提示**：这是绿地，可能需要 spike（造一个最小契约例子试跑）才能定格式。

## P2 — 后台生命周期接管（watchdog，解事实 2 + B2 + TD-39）

**目标**：把"拒绝裸 spawn"换成"接管孤儿会话生命周期"。**06-18 事故的架构正解。**
**做什么**：fork 最小 detached 进程，对 fire-and-forget 的 run（含进程式 + opencode）：
- 守 worker stdout / 推进状态机（解 F1：纯 spawn 不再卡 submitted）
- 跑 token 闸门轮询（S1-1 出 `waitForCompletion`，对孤儿会话也生效）
- 超时兜底 abort（进程式 taskkill / opencode stop+verify）
- 失败/告警写到 transcript + ALERTS（无人值守的"失控检测"，事故教训 #5）
**产出**：`--unsafe-detach`（或 `--background`）flag 落地，裸 spawn 不再被拒、而是被托管。
**验收**：孤儿会话超 tokenBudget 时 watchdog 能秒级终止（端到端测试，复现 06-18 路径但被拦住）。
**独立可交付**：daemon 之前的"可运行前身"，安全收益立刻有。

## P3 — 持久 daemon + IPC（风险最高）

**目标**：L2 控制平面持久化（`research/05` D4）。CLI 变 daemon 客户端。
**做什么**：
1. 先定两个遗留 open question（`02-architecture.md:636,640`）：
   - Windows 后台进程存活机制（detached 子进程 / 必须 daemon）—— **实测**，不臆断。
   - IPC 选型（命名管道 vs 本地 HTTP）。
2. 实现 daemon：持有 run registry，`tail --follow` 改推送（非文件轮询），重启经 transcript 无缝接管。
3. 顺带：portAllocator 跨进程持久化（TD-23 的 daemon 阶段部分，软依赖）。
**验收**：daemon 重启后能从 transcript 接管未完成 run；多 CLI 调用共享同一 daemon 状态。
**风险**：新进程模型 + Windows 长跑稳定性（进程累积/句柄泄漏），单元测试覆盖不到——P5 兜。

## P4 — LLM 编排器（声明者愿景，决策 0010）

**目标**：Lead 从"操作员"变"声明者"。
**做什么**（决策 0010 的融合项）：
- 引擎注入 `ctx.upstream.X.text`（声明式链式 = 手动链式一样简单）。
- `run` 成唯一命令（流式进度 + 内联 scorecard + metrics）。
- model/provider/effort 一等字段（消除 opus-4.8 类 bug）。
- 渐进式 scorecard（默认 requireEvidence，完成后追加收紧）。
**依赖**：P1（验收契约可声明）+ workflow 引擎增强。
**验收**：lead 用声明式描述一个 3+ 节点任务，引擎自动链式+验收+整合，lead 不传 runId/不 relay 内容。

## P5 — 长跑稳定性 hardening（收尾）

**目标**：支撑 PRD U12"数小时/数天无人值守"。这是 WAO 至今没碰过的 territory。
**做什么**：在 P2+P3 之上，针对长跑暴露的新 bug 类别：
- 内存/句柄泄漏（daemon 跑数天的累积）
- 进程组清理（worktree + 子进程累积）
- provider 长尾故障（重试/熔断/降级）
- TD-40 Job Object 绑定（OS 级"进程死即会话死"，长跑安全的地基）
**验收**：一个无人值守工作流跑数小时，失败自动处理或通知（roadmap M7 完成定义）。
**风险**：长尾 bug，需真实长跑才能暴露——P0 的真任务 dogfood 是它的探测器。

---

## 执行纪律（与现有工程纪律一致）

- **严格红绿 TDD**，每个 phase 的能力项配测试；中途遇严重 red flag / 架构变更取舍停下汇报。
- **phase 间松耦合**：每个 phase 独立可交付、可停，不互相阻塞（P3 依赖 P2 是唯一硬依赖）。
- **决策点显式标 owner**：P1 三选一、P3 IPC 选型、P4 范围，都是需 owner 拍板的，不替 owner 决定。
- **过程归档**：每 phase 完成写一条 roadmap 进度 + 必要时 ADR；M7 全部完成写 `archive/m7-audit.md`。
- **真任务驱动**：P0 之后，每个能力 phase 用真实任务验证（不是只跑 sentinel）。

## 当前状态（活，随进度同步）

- **✅ P0 完成（2026-06-25）**：用 WAO 编排自己补 `test/workflow/handoff.test.js`（+11 真实覆盖，
  commit 15049d9）。全链 worktree 隔离 + scorecard 门 + 无残余。friction 清单见
  [`research/12`](./research/12-p0-realtask-dogfood-2026-06-25.md)——实证了决策 0010 的"人肉 relay"
  （P0-F1）和 worktree 产出→交付 gap（P0-F2/F4）。未动摇 P2 优先级（P0 是人在环，未触发无人值守安全洞）。
- **✅ P1 spike 完成（2026-06-25）**：验收契约三选一 spike 收敛——**选 C（用户验收脚本）**（owner 确认），
  见 [`.wao/decisions/0011`](../.wao/decisions/0011-验收契约格式-选用户验收脚本.md)。
- **✅ P2 完成（2026-06-25）**：后台生命周期接管（detached runner）。新增 `src/backgroundRunner.js`
  （进程内核心 `runBackground` + CLI 入口）+ CLI `run/spawn --background` flag。CLI fork detached runner，
  runner 拥有 worker handle 驱动 `waitForCompletion`（token 闸门/超时/兜底 abort 全生效），写共享 transcript。
  **替代旧 TD-39 "拒绝裸 spawn"护栏**——现在不拒，而是托管，不再产生孤儿 session（06-18 架构洞正解）。
  真实 E2E：coder_low --background 立即返回，detached runner 在后台推进完整状态链到 completed
  （**F1 根治：纯 spawn 不再卡 submitted**）。3 新测试 + P0-1 测试更新（拒→托管）。443 全绿。
- **🟡 P3-T0 spike 完成（2026-06-25）**：解 P3 step 1 两个 open question（`02-architecture.md:636,640`），
  实测见 [`research/13`](./research/13-p3-daemon-ipc-spikes-2026-06-25.md)。
  - **T0a ✅ 收敛**：Windows `spawn({detached:true, stdio:'ignore'}) + unref()` 给出**真正的后台存活**——
    父进程退出后子进程继续、能被后续独立进程经 handshake 文件触达 + 停止、无孤儿。**daemon 无需 OS service**，
    P2 detached runner 常驻化即得（架构连续，无返工）。
  - **T0b ✅ 收敛（2026-06-25 owner 拍板）**：IPC 选型 = **命名管道**（`\\.\pipe\wao-daemon` + JSON-line
    over `node:net`），见 [决策 0012](../.wao/decisions/0012-daemon-ipc-选型-命名管道.md)。否决本地 HTTP
    （占端口 + 安全门面大 + 协议表达力用不上）。
- **✅ P3-T1 完成（2026-06-25）**：持久 daemon + 命名管道 IPC + 心跳健康 + 重启 resume-scan + CLI `daemon`
  命令族（start/stop/status/list/ping）。新增 `src/daemon.js`（IPC server + run 追踪 + 心跳 + resume-scan
  + 进程入口）+ `src/cli.js` `daemon` 命令族。daemon 持有 1 个长生命周期 RunManager，`start` IPC 内部驱动
  `waitForCompletion`（token 闸门/超时/abort 全生效，runtime-agnostic 不分支 backend），`stop` IPC abort
  in-memory run。**关键修复**：发现并修了一个潜伏 bug——被弃的 opencode `streamEvents` 轮询循环在
  `waitForCompletion` 的 AbortController 未 abort 时会后台空转（06-18 孤儿换皮）；解法是 `RunManager.waitForCompletion`
  接受外部 `signal`（与 waitTimeout 控制器合并），daemon 持 per-run controller，`stop`/`daemon.stop` abort 之。
  重启时 `scanResumableRuns` 扫 runDir 非终态 run → `manager.resume` 接管（进程式会 respawn，既有语义）。
  handshake 放 `runDir/daemon.json`（**不放 .wao/**——5 槽位锁死有 layout 守卫）。21 红绿测试，464 全绿。
  真实 smoke：daemon start/ping/list/stop 全链 + 幂等（重复 start 不起第二实例）+ **无孤儿进程**（06-18 教训）。
  T1 划给 P5 的项见 TD-45（自愈）/TD-46（长跑清理）/TD-47（tail 流式）。
- **✅ P4 完成（2026-06-26）**：LLM 编排器（声明者愿景，决策 0010）——Lead 从操作员变声明者。
  四个融合项落地（融合项 #5 任务对象、#6 富 TUI 不做，见决策 0010）：
  - **T1 融合项 #2**：`ctx.upstream.X.text/tokens/costUsd` 一等别名（`src/workflow/handoff.js`）。
    关键发现：output.text 代码本就就绪（handlers.extractOutput + buildUpstreamContext 已透传 output），
    缺的只是别名对齐决策 0010 写法 + 默认用法。声明式链式 = 手动链式一样简单，解 P0-F1 人肉 relay。
  - **T2 融合项 #3（决策B 全量迁移）**：`provider:{baseUrl,apiKeyEnv,model,effort,contextWindow}` 一等字段
    （`src/backends/claudeCodeProvider.js` 纯函数 resolveProviderArgs + 接入 claudeCode.js）。
    backend 从单一真相源推导 wrapper prependArgs + claude CLI flags——两处从同一字段来，物理上不可漂移
    （opus-4.8 bug 类根除）。config/agents.example.json 全量改写为 provider 形态；旧 args/prependArgs 向后兼容。
  - **T3 融合项 #1（决策A）**：`run` 默认人类可读 header（runId·agent·结果·成本）+ 内联 scorecard 卡片
    （`src/cliRunSummary.js` 纯函数 renderRunSummary + 接入 runCommand）。`--format json` 保留机器可读。
    一次融合取代 collect/scorecard/metrics 的常见回查。
  - **T4 融合项 #4（决策C）**：渐进式 scorecard——`requireAcceptance` check（决策 0011 落地，用户验收脚本作
    独立 oracle，exit≠0 = failed）+ `mode:"warn"` 非阻断门（记 scorecard.warn，run 仍 completed，默认仍是硬门）。
  27 红绿测试（T1:5 + T2:8 + T3:7 + T4:7）+ 4 真实 smoke（每项配）。510 全绿，30 SSOT 不变量绿。
  **未做**：融合项 #5 任务对象（决策 0010 排最后，大且低优先，归后续）；daemon 两套所有者彻底统一
  （D-F2 已给统一视图，彻底统一是独立设计决策，留后续）。
- **未开始**：P5（长跑 hardening，含 TD-45/46/47）。
- **建议起步**：P5（长跑 hardening）——需真实长跑暴露 bug，P0 真任务 dogfood 是探测器。
