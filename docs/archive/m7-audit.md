# M7 审计报告

> 状态：✅ 定稿（P5 T3 长跑 dogfood 已跑，2026-06-26）。
> 日期：2026-06-26（T3 长跑后定稿；过程快照不再改写）
> 审计依据：`docs/milestone-discipline.md`（6 类别逐项检查）+ `docs/archive/m7-phases.md`（6 phase）。
> 性质：过程类快照（mN-audit），时间冻结——P5 T3 完成后只追加"P5 长跑发现"，不改写已定事实。

## M7 概览

M7 = "多阶段行动大纲"（见 `docs/archive/m7-phases.md`），从 P0 真任务 dogfood 到 P5 长跑 hardening，
共 6 phase。本审计是 M7 收尾的过程快照。

## 完成定义核核（逐 phase）

| phase | 完成定义 | 结果 | 证据 |
|-------|---------|------|------|
| **P0** | 真任务 dogfood 基线（用 WAO 编排自己补测试） | ✅ | 2026-06-25；用 WAO 派真实 worker 补 `test/workflow/handoff.test.js`（+11 真实覆盖） |
| **P1** | 验收契约收敛（ADR 0011） | ✅ | 2026-06-25；选 C 用户验收脚本（requireAcceptance）；落地见 P4-T4 |
| **P2** | 后台生命周期接管（detached runner，解 06-18 事故架构洞） | ✅ | 2026-06-25；`src/backgroundRunner.js` + CLI `--background`（TD-39 偿还） |
| **P3** | 持久 daemon + 命名管道 IPC（ADR 0012） | ✅ | 2026-06-25；startDaemon/IPC/心跳/resume-scan + D-F1..D-F4 dogfood 收口 |
| **P4** | LLM 编排器（声明者愿景，决策 0010） | ✅ | 2026-06-26；T1 upstream.text / T2 provider 一等字段 / T3 run header / T4 requireAcceptance+warn；真实 3-node dogfood 通过 |
| **P5** | 长跑稳定性 hardening | ✅ | T1 自愈（supervisor）✅ / T2 可观测（health）✅ / **T3 长跑 dogfood ✅（45min/265run/0fail/0warn）** / T4 文档+TD-47 评估 ✅ |

## milestone-discipline 6 类别核核

| 类别 | 结果 | 证据 |
|------|------|------|
| 1. `npm test` 全绿 | ✅ | **536 tests, 0 fail**（含 30 docs-consistency 不变量） |
| 2. 真实 smoke（涉外部系统） | ✅ | P4 真实 3-node dogfood（researcher→coder→acceptance）✅；P5 T1 自愈（前台观测重启）✅；P5 T2 health 采样✅；**P5 T3 长跑 dogfood ✅**（45min/265run/0fail/0warn） |
| 3. 技术债审计 | ✅ | 见下"技术债动态" |
| 4. 文档纪律（SSOT） | ✅ | TD-40 → ADR 0013；声明式用法/registry/daemon 文档对齐；docs-consistency 守 30 不变量 |
| 5. 跨文档一致性 | ✅ | roadmap/m7-phases P5 状态已修正（⬜ 未开始，原误标 ✅） |
| 6. 零依赖 / 无 GUI | ✅ | 无新增依赖；P5 supervisor/health 纯 Node；无 GUI |

## 技术债动态（M7 期间）

**偿还（M7 期间）：**
- TD-39（detached runner，P2）/ TD-37+38（opencode 三层防线）/ TD-45（daemon 自愈，P5-T1）/ TD-46 可观测部分（P5-T2）/ TD-40（Job Object 复用内置 + 版本守卫，ADR 0013）

**新增/延续（开放）：**
- TD-46 剩余：长跑泄漏根因——**P5 T3 长跑未触发**（45min/265run/0 health warn）。T2 已装"眼睛"，本轮保守阈值下未越线；若未来更长时长/更高负载触发则针对性修。本轮**可观测能力 ✅**，根因修复留待真需求。
- TD-47：tail 流式 IPC——P5 T3 长跑后评估（若文件轮询够用则标"按需/不做"）
- TD-4/23/29/41 等：M7 前既有，触发条件未到（resume 统一/并行多 opencode/大 DAG/测试偶发）

## P5 T3 长跑 dogfood（已跑，✅）

> 2026-06-26 跑完。方案 A+C（自动捕获 + 时长降级）+ portable v22（零系统改动）。
> 脚本：`scripts/long-run-probe.mjs`（detached daemon + supervisor 自愈 → 循环派发 coder_low 主
> + 每 5 插 researcher → 每 5s 巡检 health + 失败 run → 跑完自动生成报告）。

**数据**（`.dev/long-run-report.md`，gitignored）：
- 时长 **45min 3s**（2026-06-26T11:07:50Z → 11:52:53Z，完整跑满未提前停）
- 派发 **265 run**（coder_low 主 + 每 5 插 researcher，含约 53 个 researcher，混合 backend）
- 成功 **265/265**（100%）；失败 **0**；health warn **0**（rss/heap/worktree/activeRuns 全程未越阈值）
- 终态全收敛（无 running 残留）

**结论**：daemon + supervisor 自愈 + health 监控 + 进程隔离（v22 Job Object）在 45min/265run 真实负载下
表现正常，**无累积类 bug 触发**。混合 backend 派发未致状态串台。TD-46 泄漏根因本轮未触发
（保守阈值 + 此负载下）——可观测能力已证，根因修复留待真需求（更长时长/更高负载）。
**P5/M7 长跑 hardening 验收通过。**
