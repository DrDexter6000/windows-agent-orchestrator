# 0094 退役 workflow/DAG 层与 `wao state`：多步编排归 Lead，WAO 只留派发、会审与续接原语

- 日期：2026-10-29
- 状态：accepted
- 来源：
  - Owner 2026-10-29 同意退役："同意你建议的"退役 workflow/DAG 层""。
  - 问到从架构与 agent 发展看这一层是否还有价值，Lead 给出判断后，Owner 答："同意，可以继续"。
- 关系：修订决定 0027 第 4 条（"workflow 层不动"，TD-142），0027 原文不改。了结 TD-29、TD-31、TD-142。
- 方案会审：kimi 与 deepseek-flash（consult_20261029152031470r4wfv2），两席都判 FIX_FIRST，指出读侧兼容的错误与漏掉的触点，已并入。
- 合入授权：Owner 2026-10-12——"只要是你联合会审过的，我都许可 commit & push"。

## 背景

- 0027 第 4 条保留 workflow 层，依据是"wf_ 643 次 ≈21%"，并给 TD-142 定了退出条件：连续一个季度零 workflow 运行。
- 10-29 重新核对转录：647 条 wf_ 里 634 条是 `template-parallel-research`，来自 `cli.test.js` 的 `workflow run`。当时测试会往真实运行目录写，每次全量一条。真实使用 13 次，全在 06-16 至 07-08：示例 8 次、认证演练 2 次、试用 3 次。此后约 4000 次运行，workflow 为 0，退出条件 10-08 已满足。
- `wao state` 只服务 DAG 引擎（每个节点完成后写快照）。主检出 `.wao/state/current.md` 最后一次写入（10-21）同样来自测试。
- 认证的 `workflowRunDir` drill 不在任何默认清单里，真实矩阵行没有声明，当前认证汇总里 0 条。
- 维护面：转录读取方（runs、状态投影、事件登记）、`.wao/` 布局、认证脚本、7 个测试文件 1437 行，以及 6 份以上文档，都要为它开特例。

## 决定

1. 删除 DAG 引擎（`src/workflow/`）、`wao workflow run|list`、`workflows/` 示例与模板、`wao state read|snapshot` 与 `src/waoState.js`，以及只为它们存在的测试与文档。
2. 多步编排由 Lead 用现有原语完成：
   - 并行研究与核验用 consult；
   - 实现加验证用带交付规格的派发（交付验证、会审包、裁定）；
   - 续接与纠偏用 run_continue / run_correct。
   WAO 不再提供"预先声明、由控制面推进"的多步计划。
3. 兼容：
   - `.wao/` 必需槽位变为 6 个：project.md、decisions、pipeline、handoff、runs、migration。`state` 与 `inbox` 同为可选：`validateWaoDir` 放行，`wao init` 不预建，已有的不必清理。
   - 转录读侧保留：四个 `workflow.*` 事件在事件表里改标 legacy（只出现在旧转录，不再有写入方）；`findState` 照旧识别 `workflow.completed`。`runs-archive/` 里的旧转录用 `status --run-dir` 查，仍得到原来的状态。
   - `runs/verify/` 里仅剩的两条 wf_ 转录（06-16）同深度哈希核对移进 `runs-archive/2026-06/`，与它们引用的子运行同一月桶。运行转录是数据文件，不是热日志，原处不留墓碑。
   - 认证：`workflowRunDir` 进 `RETIRED_DRILLS`，矩阵行声明即报错；读侧 scope 派生不变，历史 case 照原样派生。
4. 将来真需要量大、重复的流水线，在宿主侧写脚本调用 WAO 的派发、等待与交付原语，验收仍归 Lead；不在控制面里再建第二套状态机。

## 否决的备选

- **保留现状**（0027 的结论）：依据的使用数据是测试残留；维护代价一直在付，收益为零。
- **只删模板与示例、留引擎**：引擎、事件、布局与认证的特例照旧，维护面不减。
- **留 `wao state` 作手工快照**：snapshot 必须带 workflowId，离开引擎就没有写入方，也没有读者。
- **读侧一并删除**（摘掉事件登记与 `findState` 映射）：`findState` 认不出末事件时默认 `running`，归档里已完成或失败的旧 workflow 会被静默显示成运行中。
- **把引擎挪到宿主侧做可选包**：没有用户；真有需要时按决定第 4 条现写。

## 已知边界

- 宿主若有脚本或指令调用 `wao workflow`、`wao state`，合入后会得到未知命令错误。转录与分桶里没有任何宿主侧的 workflow 运行。
- 已经开着的旧版 MCP 服务进程不受影响：MCP 面从未包含 workflow 或 state。
- "夜里 A 跑完自动接 B、不经过 Lead"这类无人值守串联不再有现成工具。按不变量 4，应由宿主定时唤醒 Lead 来决定。
