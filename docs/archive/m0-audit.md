# M0 审计报告

> 状态：✅ 审计完成，技术债已修或已登记。
> 日期：2026-06-15
> 审计依据：`docs/milestone-discipline.md`（每个 task 有 gate，技术债不留）。

## 完成定义核验

| 完成定义 | 结果 | 证据 |
|---------|------|------|
| 所有 task 验收 gate 全绿 | ✅ | 见下方逐 task checklist |
| 技术债审计完成 | ✅ | 3 项已修，2 项已登记 |
| `npm test` 全绿 | ✅ | **43 tests, 0 fail** |
| roadmap 更新 | ✅ | `docs/roadmap.md` 标 M0 完成 |

---

## 逐 Task 验收 Checklist

### M0-1: transcript.js 扩展

**Gate**: `node --test test/transcript.test.js` 全绿，含 seq 单调、findState 各分支、legacy 兜底。

- [x] `append` 自动写 `seq` 且单调递增（测试：`append auto-increments seq monotonically`）
- [x] `findState` 取最后一条 `run.state_change.to`（测试：`findState uses last run.state_change.to when present`）
- [x] `findState` 对旧 transcript 用最后 type 兜底（测试：`findState falls back to legacy event type when no state_change`）
- [x] `findState` 优先 state_change 胜过 legacy event（测试：`findState prefers state_change over legacy event`）
- [x] `findLastEventSeq` 返回最大 seq，无 seq 返回 0（2 个测试）
- [x] `RUN_STATES` / `TERMINAL_STATES` 常量正确（1 个测试）
- [x] 空事件序列返回 `pending`（测试：`findState returns pending for empty events`）
- [x] **PASS** — 11 个测试全绿

### M0-2: 新建 runManager.js

**Gate**: `node --test test/runManager.test.js` 全绿，状态转移全覆盖 + resume + 幂等。

- [x] `pending→submitted→running→completed` 完整路径（测试：`full lifecycle`）
- [x] `running→timed_out`（测试：`timed_out transition`）
- [x] `running→failed` via wait error（测试：`failed transition`）
- [x] `running→aborted` via Run.abort()（测试：`aborted transition`）
- [x] `resume` 对终态返回 null（测试：`resume returns null for terminal run`）
- [x] `resume` 对非终态重建 Run（测试：`resume rebuilds Run handle`）
- [x] state_change 事件含 from/to/reason（测试：`transcript state_change events`）
- [x] **审计后新增**：onRemove 幂等性（测试：`onRemove is idempotent`）
- [x] **审计后新增**：abort 失败仍更新 state（测试：`abort updates state even when backend fails`）
- [x] **PASS** — 10 个测试全绿

### M0-3: cli.js 瘦身

**Gate**: 现有测试全绿（行为不变证明）+ CLI 能正常路由。

- [x] 删除 `doSpawn`/`doWait`/`activeSessions`/`registerShutdown`/`abortActiveSessions`/SIGINT handler
- [x] `spawnCommand`/`runCommand`/`retryCommand` 改调 `RunManager`
- [x] `runsListCommand`/`runsSummaryCommand` 改用 `findState`
- [x] `statusCommand` 加 `state` 字段输出
- [x] `formatOptions` 函数移除（不再需要，retry 改走 RunManager）
- [x] **PASS** — `integration.test.js`（spawn→collect→stop 全流程）+ `runs.test.js` 全绿

### M0-3b: 修复现有测试

**Gate**: `test/runs.test.js` 全绿，测试反映新行为（状态而非事件 type）。

- [x] `runs list` 测试改为验证状态推断（completed/running/failed 三态）
- [x] `runs summary` 测试改为验证状态计数
- [x] 覆盖 legacy 兜底路径（无 state_change 的旧 run）
- [x] **PASS** — 10 个测试全绿

### M0-4: 新建 test/runManager.test.js → 见 M0-2

### M0-5: 扩展 test/transcript.test.js → 见 M0-1

### M0-6: 验证 npm test 全绿

**Gate**: `npm test` 全绿。

- [x] **PASS** — 43 tests, 0 fail（审计修技术债后从 41 升到 43）

---

## 技术债清单

### 已修（3 项）

| # | 类别 | 问题 | 修复 |
|---|------|------|------|
| TD-1 | 代码异味 | `runManager.js:114` 用动态 `await import("./transcript.js")` 加载 `readTranscript`/`findState`，但文件顶部已静态 import 了同模块的其它导出 | 改为顶部静态 import |
| TD-2 | 并发安全 | `waitForCompletion` 错误路径与 `abort` 路径都调 `onRemove`，无幂等保护；且 `Run.abort()` 的 guard `if (!this.onRemove)` 永远不成立（onRemove 不置空） | 引入 `_removed` flag + `_removeFromManager()` 幂等方法 |
| TD-3 | 状态一致性 | `_abortInternal` 在 backend.abort 失败时，catch 分支不写 `run.state_change`，导致内存 state 与 transcript 不一致（内存停在旧状态，transcript 的 findState 靠 run.aborted 兜底才显示 aborted） | catch 也执行 `_transition(aborted)`，state 机以"意图"为准 |

每项修复都补了专门测试钉住（`onRemove is idempotent`、`abort updates state even when backend fails`）。

### 已登记延后（2 项）

| # | 类别 | 问题 | 为何延后 | 触发条件 |
|---|------|------|---------|---------|
| TD-4 | 架构一致性 | `stopCommand` 仍直接调 `backend.abort`，不走 `RunManager.abort`，不写 `run.state_change` | stop 是对历史 run 的操作（可能已不在 activeRuns），而 RunManager.abort 只管 active run。语义不同。`findState` 兜底能正确识别。 | M3 做 resume/恢复时，统一"对 active run 用 RunManager.abort，对历史 run 用 transcript 追加"两条路径 |
| TD-5 | 测试覆盖 | 未测并发场景：多个 run 同时 waitForCompletion、同时 abort | M0 短期目标是单进程串行编排，并发在 M3（限并发）才真正引入。现在测并发是测假设而非真实代码路径。 | M3 实现限并发调度器时，加并发 abort/timeout 交叉测试 |

### 临时桥接（已标注拆除时机）

| 代码 | 位置 | 拆除时机 |
|------|------|---------|
| `_waitForFirstMessageThenCompletion`（复用轮询驱动状态转移，而非消费 events 流） | `runManager.js:259` | **M1** 拆除。M1 把 opencode-serve 迁移到 `AsyncIterable<RunEvent>` 后，状态转移改由消费 events 流驱动 |
| `Run` 类不实现 spec §2.1 的 `RunHandle.events` | `runManager.js` | **M1** 补。M1 让 Run 暴露 `events: AsyncIterable<RunEvent>` |

---

## 审计结论

M0 **通过验收 gate**。发现的 3 项技术债已当场修复并补测试，2 项延后项有明确触发条件和登记。临时桥接代码标注了 M1 拆除时机。

**诚实声明**：初次完成 M0 时我跳过了技术债审计（只跑了 `npm test` 就报完成），违反了现在确立的工作纪律。回溯审计发现了 3 个真实问题（动态 import、onRemove 非幂等、abort 失败 state 漂移），其中后两个是并发/错误路径的潜在 bug——若不审计，会在 M3 引入并发后暴露为难以定位的故障。这验证了"不留技术债"纪律的价值。
