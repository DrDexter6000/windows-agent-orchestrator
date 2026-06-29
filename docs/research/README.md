# Research Notes（草稿 / WIP）

本目录记录项目早期的**外部调研**与**架构推演讨论**，用于支撑后续正式的 PRD / spec。
不是定稿规范，是**可迭代的讨论记录**。任何文件都可能被推翻、修正、合并。

## 状态标注体系

文档内结论用以下标记区分成熟度：

- ✅ **已确认** —— 用户明确同意，可作为后续设计的输入
- 🟡 **倾向性结论** —— 有方向，但未最终拍板，仍可被讨论修正
- ❓ **待定** —— 需要进一步讨论，或依赖其它决策先定下来

## 文件清单与阅读顺序

| 文件 | 内容 | 性质 |
|------|------|------|
| [01-landscape-and-positioning.md](./01-landscape-and-positioning.md) | 外部调研：主流框架、学术综述、本地 CLI 编排器竞品；我们的定位 | 外部参考 |
| [02-runmaestro-postmortem.md](./02-runmaestro-postmortem.md) | RunMaestro 崩溃案例剖析（驱动整个讨论的实战教训） | 案例研究 |
| [03-architecture-vision-draft.md](./03-architecture-vision-draft.md) | 顶层架构推演：四层模型、三个关键决策、核心原则 | 设计草案 |
| [04-niuma-case-study.md](./04-niuma-case-study.md) | Niuma 多 agent 无人值守案例（正面对标 + 架构验证） | 案例研究 |
| [05-key-decisions.md](./05-key-decisions.md) | 关键决策记录（已收敛，PRD/spec 的输入） | 决策固化 |
| [06-onboarding-design.md](./06-onboarding-design.md) | Lead Agent onboarding 设计（AGENTS.md + SKILL.md 三层分离） | 设计记录 |
| [07-opencode-smoke-and-weeds.md](./07-opencode-smoke-and-weeds.md) | opencode-serve + GLM-5.2 工具调用实测；TD-33 schema 勘测；Maestro context 杂草记录 | 实测记录 |
| [08-agent-architecture-decisions.md](./08-agent-architecture-decisions.md) | 主控-执行架构四议题（编排模式/副主控/多模型/runtime 选型） | 决策固化 |
| [09-dispatch-readiness-review.md](./09-dispatch-readiness-review.md) | 历史 NO-GO dispatch readiness 评测，已被 2026-06-18 runtime certification 结果取代 | 实测记录（历史） |
| [10-runtime-driver-comparison-2026-06-18.md](./10-runtime-driver-comparison-2026-06-18.md) | DeepSeek-v4-flash 分别由 opencode 与 Claude Code Node wrapper 驱动的认证对照、调度策略结论 | 实测记录 |
| [11-e2e-lead-dogfood-audit-2026-06-25.md](./11-e2e-lead-dogfood-audit-2026-06-25.md) | Lead-agent 视角 e2e dogfood 审计（friction F0–F6 + N1–N5），决策 0010 的输入 | 实测记录 |
| [12-p0-realtask-dogfood-2026-06-25.md](./12-p0-realtask-dogfood-2026-06-25.md) | M7/P0 真任务 dogfood（WAO 编排自己补 handoff.test.js）的 friction 清单 | 实测记录 |
| [13-p3-daemon-ipc-spikes-2026-06-25.md](./13-p3-daemon-ipc-spikes-2026-06-25.md) | M7/P3 两个 open question 实测：Windows detached 存活 + IPC 选型（管道 vs HTTP） | 实测记录 |
| [14-p3-daemon-dogfood-2026-06-25.md](./14-p3-daemon-dogfood-2026-06-25.md) | P3-T1 daemon 落地后 lead-agent 视角 e2e dogfood（D-F1..D-F4），含 handshake 位置决策输入 | 实测记录 |

**推荐顺序**：
01（生态定位）→ 02（RunMaestro 负例）→ 04（Niuma 正例）→ 03（架构推演）→ 05（收敛后的决策）→ 06（onboarding 设计）。
02 和 04 构成"负例 + 正例"的对照，是所有原则的实战锚点。

## 当前进度

本目录是**早期调研与架构推演**的归档（决策已收敛进 PRD / spec / 代码）。
**实现里程碑进度不在本处维护**——权威来源是 [`docs/roadmap.md`](../roadmap.md)（含 M0–M7 状态 + 测试数），
技术债清单见 [`docs/tech-debt.md`](../tech-debt.md)。两处之外不得再有第二份进度/债务表（SSOT）。

调研本身的完成状态：
- ✅ 外部调研与生态定位（01）
- ✅ RunMaestro 崩溃剖析（02）
- ✅ Niuma 案例对照（04）
- ✅ 顶层架构推演（03）
- ✅ 关键决策收敛第一轮（05）
- ✅ Onboarding 设计（06）
- ✅ opencode-serve 实测 + worker 架构决策（07、08，M6 阶段补）
- ✅ production dispatch 就绪度历史评测已归档（09，当前状态看 10 + roadmap）
- ✅ runtime driver 对照与 Claude Code Node wrapper 认证（10）
- ✅ Lead-agent 视角 e2e dogfood 审计（11，M7/P0 输入）
- ✅ M7/P0 真任务 dogfood friction（12）
- 🟡 M7/P3 daemon 存活 + IPC spike（13）：存活机制 + IPC 选型均已收敛 ✅（IPC 选命名管道，决策 0012）
- 🟡 M7/P3 daemon dogfood（14）：D-F1 ✅（daemon run）/D-F2 ✅（list 统一视图 owner 分类；彻底统一两套所有者留 P4）/D-F3 ✅（ownership 心跳防劫持）/D-F4 ⬜（handshake 位置待定）

## 最后更新

- 2026-06-25 P3 daemon/IPC spike（13）：Windows detached+unref 后台存活实测成立（T0a 收敛）；IPC 命名管道 vs 本地 HTTP 实测均可用，推荐命名管道，待 owner 拍板（T0b）。
- 2026-06-25 P0 真任务 dogfood（12）+ Lead e2e 审计（11）：friction 清单归档，决策 0010/0011 输入。
- 2026-06-17 dispatch readiness 评测：历史 NO-GO 记录，已被 2026-06-18 runtime certification 取代。
- 2026-06-18 runtime driver 对照：opencode/DeepSeek 与 Claude Code/DeepSeek Node wrapper 均通过 strict certification；记录 `.bat %*` wrapper 根因与调度策略。
- 2026-06-16 SSOT 审计：进度/技术债指针统一指向 roadmap.md / tech-debt.md，本目录不再维护重复状态。
