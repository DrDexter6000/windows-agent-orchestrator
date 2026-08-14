# Changelog 2026-08-14 — architecture §1 契约/过程拆分（过程冻结档）

> ⏳ **本文件是过程类别（Process Log）的时间冻结快照，不是现行契约源。**（分类标准：`docs/ssot.md` §1.4）
> 冻结日期：2026-08-14。
> 来源指针：本文件收纳自 `docs/02-architecture.md` §1"分层总览"L4 bullet 区块的逐里程碑过程叙事，
> 于 P1 文档拆分（Owner 已批准）时按原文迁出、仅做最小整理（按里程碑分节；契约内核已改写为现在时留在
> 02-architecture.md §1，本文件不复制契约正文，只指针）。
> 当前架构契约唯一权威：`docs/02-architecture.md`；里程碑进度唯一权威：`docs/roadmap.md`。
> 本文件只追加、不回写事实（SSOT 铁律 3）。

## 为什么迁出

`docs/ssot.md` 铁律"类别不可混放"：契约文档回答"系统现在是什么"（活的），过程文档回答"当时发生了
什么"（冻结的）。02-architecture.md §1 的 L4 bullet 区块此前把逐里程碑新增记录、dogfood runId、
逐版本演进史与契约陈述混排在同一批 bullet 里（单条 bullet 最长 3000+ 字符）。本轮拆分后，历史演进
叙事冻结于本文件。

## M9 — 最小 Lead 闭环（application services 层 + 首批 MCP 工具）

- Application Services 层是 M9 最小 Lead 闭环的 use-case 层（已完成）；首批共享 services 的
  里程碑标签：`registryInventory.js`（M9-0）、`runDispatch.js`（M9-2A）、`runStatus.js`
  （M9-3A，只读）、`runCollect.js`（M9-4A，非只读）、`runDiagnosis.js`（M9-5A，只读）、
  `runDelivery.js`（M9-6A，只读查询 + 持久决策）。
- M9 已暴露 MCP `registry_list`、`run_dispatch`、`run_status`、`run_collect`、`run_diagnose`、
  `run_delivery`、`run_delivery_decide`。Codex + Claude Code/Fable 两个不同 Lead Runtime 真实
  MCP dogfood 已通过（runId: `run_20260715122607417p5fbue` / `run_20260715124226755a97el2`）。
  M9 最小 Lead 闭环正式完成。

## M10 — workspace 绑定、失控停止、run 列表与等待

- M10-pre2 新增 `workspace_status`（只读，host-authorized workspace binding 状态查询）并使
  `run_dispatch` 在调用 shared service 前重新解析并证明 workspace；host-authorized workspace
  proof SSOT 为 `workspaceBinding.js`（M10-pre2）。
- M10 P0-2 新增 `run_stop`（destructive，workspace-bound，停止失控 worker），委托共享
  application service `runStop.js`（M10 P0-2）。
- M10 P0-3 新增 `runs_list`（只读，project-bound run 列表，用于 recovery），委托共享
  application service `runList.js`（M10 P0-3；workspace ownership 由
  `runWorkspaceOwnership.js`（M10 P0-3）判定）。
- M10-pre3 新增 `run_wait`（只读 long-poll，终态/活性等待），委托共享 application service
  `runWait.js`（M10-pre3）；liveness 投影 SSOT 在 `ownerLiveness.js`（M10-pre3）。三钟分离
  自 M10-pre3 起：执行截止默认禁用，改由 Lead 观察驱动（`run_wait`）。
- **M10 架构验收结论**：真实外部项目验证了 WAO 架构闭环（多 worker 并行 dispatch、`run_wait`
  liveness observation、delivery verification、durable decision、restart recovery）。详细
  dogfood 进度、runId/commit 与过程证据只指向 `docs/roadmap.md` M10 行，不在契约文档复制。

## M11 — Lead 体验层工具与服务增量

- `runDeliveryReview.js`（M11-3）：exact delivery commit proof + bounded/redacted diff projection。
- `runCollectProjection.js`（M11-4）：run_collect 的共享安全投影 + cursor codec + 分页。
- M11-6 新增 `workspace_select`（会话级，Lead 选择工作 Git 项目，`lead_session` 来源，最高
  优先级）——workspace 解析优先级**变为** `lead_session` > `mcp_root` > `server_config` >
  fail-closed；纯验证内核为 `sessionWorkspace.js`（M11-6）。
- M11-10 给 `run_delivery` 增加可选 `waitMs`，触发 bounded 只读 readiness wait；`runDelivery.js`
  条目中 M11-10 增 `getRunDeliveryReadiness` 可选 bounded 只读 readiness wait +
  `projectDeliveryReadiness` 闭集投影。

## M12 — 观察面、纠正与工具面演进

- `runAwaitResult.js`（M12-3）：只读 advisory composite；M12-6 FR-08 增必填可空闭集
  `readFailureReason`（`READ_FAILURE_REASONS` 单一 SSOT）。
- M12-3B 新增 `run_delivery_review_bundle`：MCP adapter 机械组合同一 readiness service、同一
  `run_delivery` 安全投影和同一单文件 review service/投影。
- M12-6 Package 3B 新增 `run_delivery_reverify`（**第 20 个 tool**）：委托共享 application
  service `runDeliveryReverify.js`（CLI `runs delivery reverify` 与 MCP 共用同一 service）。
- M12-7 新增 `run_continue`（**第 21 个 tool**）与 `run_dispatch` 的 delivery-only 顶层
  `continuable` 选项：Lead 审阅一个终态 continuable delivery、发现窄缺陷后，显式授权对其续
  ONE 修正回合。
- M12-8 将可观测性分成两个消费者面（`runActivity.js` / `runActivityProjection.js` /
  `ownerDashboard.js` / `ownerDashboardServer.js`）；`runDrilldowns.js`（M12-8B）为有界 Lead
  渐进式披露元数据 SSOT。M12-14：`runScopeObservation.js` 在同一快照上投影 advisory
  `scopeObservation`。
- **M12-16 运行中显式纠正**：`runCorrection.js` 是 workspace-bound application service；
  `run_dispatch(correctable:true)` 只在 backend 明确声明 in-flight correction 能力时建立
  durable correction queue，`run_correct` 以 bounded `correctionId` + prompt 把 Lead 明确指令
  追加到原 run。
- **M12-17 submitted-stage 与 Owner 详情/通知**：`runStageProjection.js` 从单 run transcript
  快照投影事实阶段；Owner Dashboard 复用同一 application projection；浏览器 Notification 仅
  在人类点击启用、权限允许、且观察到非终态→终态时发送一次固定安全通知。
- **M12-20 Owner Dashboard active-first / history-on-demand**：Owner 观察面默认 Active；
  长驻看板服务进程复用 M12-18 的元数据校验 summary 缓存做热读。
- **M12-10 冻结工具面（progressive-disclosure correction）**：22 = 原 23 减去两个原 playbook
  工具、M12-16 增 `run_correct`——built-in playbook catalog 整体移出工具面，改为 MCP
  resources（`wao://playbooks` summary + `wao://playbooks/{id}` 详情）。
- **M12-12 Self-Describing Results**：恰好四个 standalone 成功结果携带 REQUIRED
  `semanticNotes`；SSOT 在 `src/application/runSemanticsNotes.js`。工具面恰好 22（M12-16 增
  `run_correct`）。
- M12-13 增 `isolation_failed` 闭集状态 + `isolationFailure:{code}` 安全投影 +
  `projectIsolationViolationCode`（`runDelivery.js` 条目）。
- **M12-4A retained-candidate recovery**：既有 `run_delivery_repackage` 内核支持
  `disallowed_scope` 与 `backend_failed` 两类闭集 provenance。
