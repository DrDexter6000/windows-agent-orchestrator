# 关键决策记录（已收敛）

> 状态：✅ 以下决策在第一轮架构讨论中已收敛，作为后续 PRD/spec 的输入。
> ⏳ **冻结快照（2026-06-15）**：本表是早期决策的初稿记录，**已被取代**——架构级决策现行走 `.wao/decisions/NNNN-*.md`（ADR），产品/技术契约见 `docs/01-prd.md` 与 `docs/02-architecture.md`。本文保留作历史决策溯源，不作为现行决策源（SSOT 铁律 3）。
> 日期：2026-06-15 收敛。
> 每条决策附"为什么这样定"和"什么情况下会重新评估"。

## 决策清单

| # | 决策 | 状态 |
|---|------|------|
| D1 | 隔离方案：git worktree + 进程组 + 端口表，Docker 留作可选 | ✅ |
| D2 | 与 Niuma 的关系：架构参照，不重写；做更薄、更开放、Windows 原生的控制层 | ✅ |
| D3 | 目标分层：短期（能用的薄编排）/ 中长期（Niuma 级无人值守） | ✅ |
| D4 | daemon 形态：L2 走持久 daemon + IPC | ✅ |
| D5 | runtime 范围：HTTP + 进程式两类，MCP 不作为 backend | ✅ |
| D6 | 编排深度：DAG + 可插拔节点，YAML 配置即行为 | ✅ |

---

## D1：隔离方案

**结论**：核心路径用 **git worktree（文件）+ 进程组/Job Object（进程）+ 编排层端口分配表（网络）**。
Docker **不进核心路径**，留作"可选 environment backend"，需要时再插。

**为什么**：
- life index 场景的 agents 同构（同 Windows、同 Node、指向同项目的不同 worktree），**不需要异构工具链**。
- Docker Desktop 在 Windows 上走 WSL2 后端，**直接违反 AGENTS.md "无 Docker/WSL 依赖" 约束**。
- worktree 给文件隔离，进程组给进程隔离，端口表解决 Niuma 那种"端口冲突/进程残留"——
  这些组合起来覆盖了 Niuma 用 Docker 想解决的 90% 问题，且 Windows 原生、无重依赖。
- Niuma 那 3% 失败（端口冲突、进程残留）正是"无容器"的代价，但**可以用编排层的确定性机制解决**，
  不需要为此引入容器。

**重新评估条件**：
- 若未来需要异构工具链（某 agent 必须 Python 3.8，另一个必须 3.12）→ Docker 成为必要。
- 若进程级隔离在实践中清理不干净、失败率显著 → 重新评估容器化。
- 此时把 Docker 作为 environment backend 接入，而非推翻 worktree 方案。

**已知风险**：进程级隔离的清理彻底性弱于容器。缓解措施：
- Windows Job Object：父进程终止则子进程全杀
- 编排层维护端口分配表，每个 run 领一段端口
- 状态机层强制 cleanup 钩子（即使 run 失败也要清理 worktree/进程）

---

## D2：与 Niuma 的关系

**结论**：Niuma 是**最好的架构参照物**，但不是我们的终局。
我们不重写 Niuma，而是**提取其验证过的模式 + 移植到不同底座 + 补两个缺口**。

**提取的模式**（已被 Niuma 实战验证，我们直接采用）：
- DAG + 节点化（每个 agent 单一职责、干净上下文）
- 结构化 handoff（程序可校验，不靠 LLM 自报）
- scorecard 审计（证据链门控，AI 说完成不算）
- 配置即行为（YAML 定义拓扑/agent/模型/环境）

**移植到不同底座**：
- Niuma：macOS-first + Electron + Docker + 封闭产品
- 我们：Windows 原生 + headless + 无 Docker + 开放 toolkit

**补的两个缺口**（Niuma 没解决，我们必须解决）：
1. **无对照物场景的验收契约**：Niuma 成功依赖 Python 旧版本做标准答案；
   life index 是半新/全新项目，"什么算对"需要由用户定义的契约来判定，不能假设有对照物。
2. **策略可插拔**：Niuma 的 Codex 总控焊死在引擎里；我们的 LLM 编排器是可插拔策略之一，
   甚至可以不是默认项（bash 脚本、YAML、LLM 平权）。

**关键定位差异**：Niuma 是**产品**（解决一类场景），我们做的是**平台/toolkit**（让用户解决自己的场景）。
这决定了我们的 YAML schema 必须比 Niuma 更小、更中立、更可扩展。

**不做的理由**（为什么不直接等 Niuma 开源）：
- Niuma 尚未开源，且开源时间表不明。
- Niuma 是 macOS-first + Docker + Electron，迁到 Windows 无 Docker 是重写，不是适配。
- 绑死闭源产品 = 重复 RunMaestro 的错误（命运绑在别人产品路线上）。

---

## D3：目标分层（短期 vs 中长期）

**结论**：分两层目标，既不放弃终局视野，又能在短期内交付真能用的东西。

### 短期（几周）

**目标**：把 PoC 做到"能并行跑多个 agent、可靠记录、能恢复"。
- 多 run 并行 + 限并发
- 可靠 transcript（已有，强化状态机）
- run 恢复（runs resume）
- 多 backend 接口固化（至少 HTTP + 一个进程式）
- 基础可观测性（metrics 聚合）

**价值**：立刻减轻用户的编排 pain，虽不是 Niuma 级全自动。

### 中长期（几个月）

**目标**：补 DAG + scorecard + 验收契约，接近 Niuma 的无人值守能力。
- 声明式 DAG 引擎（含数据/执行依赖解耦）
- scorecard 审计层
- 验收契约机制（无对照物场景）
- 可插拔策略层（含 LLM 编排器作为一等公民）

**判断依据**：用户痛点优先级。当前最痛的是"RunMaestro 崩溃后没有可用工具"，
短期目标直接解这个；中长期目标解"无人值守自动化"。

---

## D4：daemon 形态

**结论**：L2 控制平面走持久 daemon + IPC。
CLI 变成 daemon 的客户端（命名管道或本地 HTTP）。

**为什么**：
- 真正的并行调度需要持久进程持有运行注册表。
- 订阅式 `tail --follow` 需要常驻进程推送，不能靠轮询文件。
- daemon 重启后基于 transcript 状态机无缝接管（呼应"重启很贵"原则）。

**与当前 PoC 的差异**：当前是"每次 CLI 调用即起即灭"，状态在内存里进程死就丢。
daemon 化是把内存状态外置到 transcript + 持久进程。

**注意**：daemon 是 L2 的终局形态，**不是短期目标**。短期可先用"可重入单进程 + transcript 状态机"
过渡——每次 CLI 调用读 transcript 恢复状态，无需常驻进程。等并行调度需求强了再 daemon 化。

---

## D5：runtime 范围

**结论**：终局支持 **HTTP 类 + 进程式**两类 runtime。MCP **不作为 backend**。

**HTTP 类**：OpenCode serve（当前已支持）。无状态 HTTP + 轮询。
**进程式**：Claude Code / Codex CLI。一个进程 = 一次会话，stdout 流式产出。

**统一抽象**：两者都被翻译成 `AsyncIterable<RunEvent>`（见 03 决策 1），
编排层永远不碰传输细节。

**MCP 不作为 backend 的理由**：MCP 是 tool 协议（agent 调用外部工具），
不是 runtime 协议（编排器驱动 agent）。把 MCP 当 backend 语义错位。
若未来需要 MCP 工具，它属于 agent 内部的能力，不属于我们的编排层。

---

## D6：编排深度

**结论**：L3 编排层做 **DAG 引擎 + 可插拔节点**，**YAML 配置即行为**。

**DAG 能力**（参考 Niuma，但 schema 更小更中立）：
- 串行、并行、扇出、汇聚、打回、循环
- **数据依赖 vs 执行依赖解耦**（Niuma 的关键设计：
  数据可以先到，但执行顺序由依赖锁死。例：QualityGate 先收到数据，但要等 Tester 完成）
- 节点间传引用（路径/runId）不传内容（防 token 爆炸）

**可插拔节点**：三层灵活性逐级递进。
1. 零代码：内置模板
2. 声明式：写 YAML DAG
3. 可编程：注册自定义节点类型（如 LLM router）

**YAML 分层**（参考 Niuma 的分层，但裁剪到我们的约束）：
- 图拓扑（节点 + 边 + 依赖类型）
- Agent 定义（agentId + 职责 prompt）
- 模型 profile（provider + model + variant）
- 环境（cwd + worktree 策略；Docker 字段可选，默认不用）
- 安全限位（权限边界，但保持简单，不做复杂权限系统——AGENTS.md 约束）

**配置即行为原则**：YAML 不是文档，是系统行为。
改进一次 YAML，所有未来任务按新标准执行（Niuma 经验）。
但我们的 YAML 比 Niuma 更中立——不假定 Docker、不假定 Electron。

---

## 收敛后剩余的开放问题 ❓

这些不阻塞短期目标，留给 spec 阶段或后续迭代：

- **验收契约的具体形态**：无对照物场景下，"什么算对"怎么定义？
  候选：行为快照、OpenAPI 契约、用户提供的验收脚本。需 spec 时定。
- **YAML schema 的字段集**：分层方向已定（D6），具体字段待 spec。
- **scorecard 的检查规则库**：框架已定（证据链门控），具体检查项随实战积累。
- **IPC 机制**：daemon 阶段再定（命名管道 vs 本地 HTTP）。
