# M1 审计报告

> 状态：✅ 审计完成，技术债已修或已登记。
> 日期：2026-06-15
> 审计依据：`docs/milestone-discipline.md`。

## 完成定义核验

| 完成定义 | 结果 | 证据 |
|---------|------|------|
| `npm test` 全绿 | ✅ | **54 tests, 0 fail** |
| M0 桥接 `_waitForFirstMessageThenCompletion` 已拆除 | ✅ | `findstr` 在 src/ 中无结果 |
| `Run.waitForCompletion` 内部是 `for await (const ev of handle.events(...))` | ✅ | `runManager.js:247` |
| `opencodeServe.spawn` 返回值含 `events` + `abort` | ✅ | `opencodeServe.js:25-26` |
| 超时和完成走不同代码路径 | ✅ | 超时靠 RunManager AbortController（`M1 核心切分: 超时`测试）；完成靠 backend emit done（`M1 核心切分: 完成`测试） |

## 逐 Task 验收

| Task | Gate | 结果 |
|------|------|------|
| M1-1 runEvent.js | 类型构造 + reason 校验（5 测试）| ✅ |
| M1-2 opencodeServe streamEvents | emit message/done、去重、signal abort、failed（5 测试）| ✅ |
| M1-3 runManager 消费 events | 拆桥接 + resume 重建 handle + 删 sleep 死代码 | ✅ |
| M1-4 cli.js 适配 | waitResult.messages 形态兼容，无需改 | ✅（零改动）|
| M1-5 runEvent 测试 | 5 测试全绿 | ✅ |
| M1-6 opencodeServe 测试扩展 | 5 个 streamEvents 测试全绿 | ✅ |
| M1-7 runManager 测试扩展 | 3 个 M1 核心切分测试全绿 | ✅ |

## 技术债清单

### 已修（3 项）

| # | 类别 | 问题 | 修复 |
|---|------|------|------|
| TD-6 | 死代码 | `OpenCodeServeBackend.waitForCompletion`（旧轮询方法）在 events 迁移后无任何调用方，但保留着且有 2 个测试 | 删除方法 + 删除对应 2 个测试。行为已被 streamEvents 测试完全覆盖 |
| TD-7 | 死代码 | `runManager.js` 末尾的 `sleep` 函数在 `_waitForFirstMessageThenCompletion` 删除后无调用方 | 删除 |
| TD-8 | 代码异味 | `runManager.js:114` 的动态 `await import("./transcript.js")`（M0 审计 TD-1 的同类残留，resume 里漏改的一处）| 改为顶部已静态 import 的 `readTranscript`/`findState`（顶部早已有，这处是冗余）|

### 已登记延后（2 项）

| # | 类别 | 问题 | 触发条件 |
|---|------|------|---------|
| TD-9 | 接口未完整 | `RunEvent` 只实现 message + done。spec §2.2 的证据链事件（command/file_written/tool_use/tool_result/metrics）未实现 | M2/M6——进程式 backend 能从 stdout 提取这些时补 |
| TD-10 | 抽象一致性 | resume 重建 handle 时直接调 `backend.streamEvents`/`backend.abort`，硬编码了 opencode-serve 的方法名。M2 加进程式 backend 时，resume 路径需要统一的"reattach"抽象 | M2——ProcessBackend 实现后，统一 Backend 接口加 `reattach(serveUrl/sessionId)` 或等价机制 |

### 临时桥接（已标注拆除时机）

无新增临时桥接。M0 的桥接（`_waitForFirstMessageThenCompletion`）已在 M1 拆除并验证。

## 审计结论

M1 **通过验收 gate**。核心切分（done 由 backend emit、超时由 RunManager 管）有专门测试钉住，职责边界清晰。3 项技术债当场修复（含 1 项死代码、1 项 M0 遗留的动态 import、1 项伴随死代码的测试）。

**相比 M0 的改进**：本次审计在收尾时主动执行（非用户要求后回溯），验证了工作纪律的内化。发现的 TD-8（动态 import 残留）正是 M0 审计 TD-1 的"同模式第二处"——说明逐文件审查比全局搜索更彻底。
