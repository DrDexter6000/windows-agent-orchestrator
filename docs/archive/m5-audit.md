# M5 审计报告

> 状态：✅ 审计完成。
> 日期：2026-06-16
> 审计依据：`docs/milestone-discipline.md`（6 类别逐项检查）。

## 完成定义核验

| 完成定义 | 结果 | 证据 |
|---------|------|------|
| `npm test` 全绿 | ✅ | **158 tests, 0 fail** |
| `workflow run <file.mjs>` 能执行 DAG | ✅ | `workflows/analyze-summarize.mjs` 真实跑通 |
| 5 种 DAG 形状正确 | ✅ | engine.test.js 8 测试（串行/并行/扇出汇聚/gate/失败传播/dataEdge/router/result） |
| 数据依赖 vs 执行依赖解耦 | ✅ | dataEdge 测试验证：数据先传、执行仍等执行依赖 |
| 节点间传引用不传内容 | ✅ | handoff.test.js 验证 upstream 无 messages |
| 节点失败 → 下游不执行 | ✅ | 失败传播测试 + propagateFailure 递归 |
| 真实 smoke | ✅ | 2 节点串行 workflow（claude）真实跑通，transcript 干净 |
| 技术债审计 | ✅ | 见下（预审清单 9 项 + 新发现 2 项） |

## 真实 smoke 结果

```
workflow run workflows/analyze-summarize.mjs
  wf_20260616061242394
  analyze   → completed (run_20260616061242399, 25s)
  summarize → completed (run_20260616061307251, 44s)
  total: ~69s, 2 claude API calls
```

Workflow transcript 干净记录了 6 个事件（workflow.started → node.started → node.completed × 2 → workflow.completed）。

## 逐 Task 验收

| Task | Gate | 结果 |
|------|------|------|
| M5-1 schema.js | defineWorkflow + validate + topoSort（5 种 DAG 形状）| ✅ 11 测试 |
| M5-2 loader.js | 加载 .mjs + 裸对象/不存在/非法 export | ✅ 4 测试 |
| M5-3 handlers.js | agent/gate/router + 注册自定义 | ✅ 13 测试 |
| M5-4 engine.js | 5 种 DAG + dataEdge + 失败传播 + router | ✅ 8 测试 |
| M5-5 handoff.js | promptBuilder + 引用传递 + requiredClaims | ✅ 含在 handlers 测试 |
| M5-6 CLI + transcript | workflow run 命令 + workflow 级 transcript | ✅ smoke 验证 |

## 技术债预审清单（9 项逐项检查）

| # | 检查项 | 结论 |
|---|--------|------|
| 1 | 拓扑排序循环检测覆盖自环 | ✅ schema.js 显式检查 `from === to`，测试覆盖 |
| 2 | 并行执行的错误处理（同层一个失败） | 🟡 当前：Promise.all 会在一个 reject 时让其它继续（不中断），但 handler 内部 catch 了 backend 错误转 NodeResult.completed=false。**若 handler 本身抛错（非 backend 错误），Promise.all 会 reject 整个层**。登记 TD-27 |
| 3 | workflow transcript 和 node transcript 关系 | ✅ 独立文件（`wf_xxx.jsonl` vs `run_xxx.jsonl`）。workflow transcript 记 workflow 级事件，node 自己的 transcript 记 run 级事件。通过 nodeRunId 字段关联 |
| 4 | gate 的 requiredClaims 语义 | ✅ 格式 `"nodeId.field"` 或 `"field"`（查所有前驱）。清晰，测试覆盖 |
| 5 | router 条件边和 dataEdge 交互 | 🟡 当前 router 用 `pendingRoutes` 只影响下一层，dataEdge 不影响 router。**若 router 的下游同时有 dataEdge 边，行为未测**。登记 TD-28 |
| 6 | promptBuilder 的 ctx.upstream 泄漏 | ✅ upstream 只含 `{runId, transcriptPath, completed, output}`，不含 messages。output 是提取后的 `{text, tokens, costUsd}`。可控 |
| 7 | 大 DAG 内存占用 | 🟡 completedResults Map 累积所有节点结果。对 100+ 节点 DAG 可能占内存。M5 不处理（登记 TD-29） |
| 8 | workflow 级超时 | 🟡 当前只有单节点超时（waitTimeout）。无 workflow 整体超时。登记 TD-30 |
| 9 | JS/ESM 沙箱安全 | 🟡 workflow .mjs 文件有完全 JS 能力（和 npm script 同级风险）。登记 TD-31 |

## 实现中自检发现并修复（2 项）

| # | 问题 | 修复 |
|---|------|------|
| TD-25 | router 的 `activeRoutes` 在层结束时被清除，导致 router 的路由只影响当前层而非下一层。router 在第 N 层，它的后继在第 N+1 层，但 activeRoutes 在第 N 层结束时清了 | 改为 `pendingRoutes`：在层开始时消费（过滤当前层），而不是在层结束时清除 |
| TD-26 | `_log` 的 payload 里 `runId`/`type`/`agentId` 字段覆盖了 transcript context 的同名字段，导致 workflow transcript 事件混入了 node 的 runId 和 "agent" type | `_log` 自动重命名冲突字段（runId→nodeRunId, type→nodeType, agentId→nodeAgentId）|

**TD-26 只有真实 smoke 才暴露**——mock 测试不检查 transcript 内容的字段名。再次验证"真实 smoke 不可省"。

## 已登记延后（5 项）

| # | 问题 | 触发条件 |
|---|------|---------|
| TD-27 | 并行层中 handler 抛错（非 backend 错误）会让 Promise.all reject 整个层 | 若实战中出现 handler 级异常，改为 Promise.allSettled |
| TD-28 | router 下游同时有 dataEdge 边时的行为未测 | 复杂 workflow 出现时补测试 |
| TD-29 | 大 DAG（100+ 节点）的 completedResults 内存占用 | 实际遇到大 DAG 时做流式/分页 |
| TD-30 | 无 workflow 级整体超时 | 长跑 workflow 出现超时问题时加 |
| TD-31 | JS/ESM workflow 文件沙箱 | 和 npm script 同级风险，文档标注即可 |

## 设计记录

1. **JS/ESM 格式验证成立**——零依赖、可注释、可动态构造 workflow。`export default { id, nodes, edges }` 足够简洁。
2. **数据/执行依赖解耦是真实价值**——Niuma 的 QualityGate 场景（数据先到但执行等 Tester）在我们的 dataEdge 测试里验证了。这不是理论，是可用的。
3. **gate 是 scorecard 的最小子集**——M5 的 gate 只检查 completed + requiredClaims。M6 补完整证据链审计（command 是否真跑、file 是否真存在）。边界清晰，不重叠。
4. **workflow transcript 独立于 node transcript**——两层记录，通过 nodeRunId 关联。这让 workflow 的执行历史和单 run 的详细事件分离，各有用途。

## 审计结论

M5 **通过验收 gate**。DAG 引擎完整实现（5 种形状 + 依赖解耦 + gate + router + 失败传播），真实 2 节点 workflow 端到端跑通。2 项实现中自检发现并修复（TD-25 router 时序、TD-26 transcript 字段覆盖），5 项登记延后（均有触发条件）。
