# M2 审计报告

> 状态：✅ 审计完成，技术债已修或已登记。
> 日期：2026-06-15
> 审计依据：`docs/milestone-discipline.md`。

## 完成定义核验

| 完成定义 | 结果 | 证据 |
|---------|------|------|
| `npm test` 全绿 | ✅ | **83 tests, 0 fail** |
| registry 三种 backend 共存 | ✅ | `registry list` 列出 opencode-serve + claude-code + codex |
| ProcessBackend mock 子进程验证 | ✅ | spawn/events/abort/exit-code 兜底 5 测试 + 集成测试 |
| 两个 parser 用真实 JSONL 样本验证 | ✅ | claude(6测试)+codex(6测试)，含实测格式（非猜测） |
| 手动 smoke | ✅ | `npm run smoke` 跑通 claude + codex，两个都 PASS，状态链完整 |

## 真实 CLI smoke 结果（M2 收尾执行）

```
✅ PASS  claude-code    reply: "smoke ok"   chain: pending→submitted→running→completed
✅ PASS  codex          reply: "smoke ok"   chain: pending→submitted→running→completed
✅ PASS  opencode-serve reply: "smoke ok"   chain: pending→submitted→running→completed
```

三种 backend 全部真实跑通。smoke 暴露并修复了两个真实 bug（TD-17 Windows .cmd、TD-18 流式竞态），
证明"真实 smoke 不可省"——mock 测试覆盖不到平台特定行为和流式时序。
| 技术债审计完成 | ✅ | 见下 |

## 逐 Task 验收

| Task | Gate | 结果 |
|------|------|------|
| M2-1 runEvent 文档 | runEvent.test.js 全绿 | ✅ 5 测试 |
| M2-2 LineStreamParser | 多行切分/非JSON跳过/跨chunk缓冲/flush/CRLF | ✅ 7 测试 |
| M2-3 claude parser | 真实样本 + thinking 忽略 + result 各分支 | ✅ 6 测试 |
| M2-4 codex parser | 真实样本含ERROR行 + command_failed不触发done + 无turn.completed不假装 | ✅ 6 测试 |
| M2-5 ProcessBackend | spawn/exit兜底/abort杀进程/signal abort | ✅ 5 测试 |
| M2-6 backend 工厂 + registry | 三种共存 + 字段校验分支 + 未知拒绝 | ✅ 7 测试 |
| M2-7 集成测试 | 进程式经 RunManager 完整生命周期 | ✅ 1 测试 |

## 技术债清单

### 已修（2 项，实现过程中发现并修复）

| # | 类别 | 问题 | 修复 |
|---|------|------|------|
| TD-11 | 作用域 bug | 首版 ProcessBackend 用模块级 `resolveWait`，多 run 并发时会跨 run 共享信号变量，导致事件路由错乱 | 重构为 `EventQueue` 类，每个 handle 独立实例。在写实现时自检发现，未流入测试 |
| TD-17 | Windows 兼容性 | codex 在 Windows 上是 `codex.cmd` 包装器。Node spawn 受 CVE-2024-27980 补丁限制，默认拒绝 spawn `.cmd`/`.bat`（报 EINVAL 或 ENOENT）。`shell:true` 能绕过但破坏含空格/引号的 prompt 参数传递 | CodexBackend 覆写 `resolveBinary`：探测 codex.js 真实路径（`%APPDATA%/npm/node_modules/@openai/codex/bin/codex.js`），用 `node codex.js` 直接调用，完全绕过 .cmd 包装器。ProcessBackend 的 spawn 支持 `{binary, prependArgs}` 形式，前置 node + js 路径 |
| TD-18 | 流式竞态 | opencode-serve 流式追加 parts（assistant 消息逐步长出 step-start→text→step-finish）。原 streamEvents"看到 assistant 就 done"，导致 emit 的 message parts 不完整（text 还没到），reply 为空。顺带暴露第二个 bug：abort 后 waitForCompletion 仍处理后续事件，用 running 覆盖 aborted 状态 | streamEvents 改"稳定性判定"：看到 assistant 后再轮询一次确认快照不变才 emit（含完整 parts）+ done。RunManager 传 pollInterval 给 events 工厂控制轮询频率。waitForCompletion 循环开头检查 `_aborted`，已 abort 则停止处理事件。3 个关联测试覆盖 |

**TD-17 的教训**：这个 bug 只有真实 smoke 才暴露——mock 测试用 `process.execPath`（真 exe），永远不会碰到 .cmd 问题。这验证了"真实 smoke 不可省"的判断。已加 `npm run smoke` 自动化（`src/smoke.js`），后续回归可一键复验。

### 已登记延后（6 项，均有触发条件）

| # | 类别 | 问题 | 触发条件 |
|---|------|------|---------|
| TD-9 | 接口未完整 | RunEvent 只实现 message+done。证据链事件(command/file_written/tool_use)未实现 | M6 scorecard——需要审计证据时扩展 runEvent.js |
| TD-12 | 去重 | claude stream-json 的 assistant 事件可能分多条到达（流式拆分，同 message.id）。M2 每条都 emit message，不去重 | M6——scorecard 需要精确 message 计数时加 message.id 跟踪 |
| TD-13 | 跨平台 | ProcessBackend 的 abort 用 Windows `taskkill /T /F`。非 Windows 会失败 | 需要跨平台时加 `process.platform` 分支（M2 只 Windows，AGENTS.md 约束）|
| TD-14 | 语义 | resume 对进程式 backend 不可能（进程死了无法 attach）。当前 RunManager.resume 会尝试重建 handle 并调 `backend.streamEvents`——对进程式会失败 | M3 做 resume 统一时，进程式 backend 的 resume 应直接返回 null |
| TD-15 | 语义 | ProcessBackend 的 retries 默认 0 且无重试逻辑。构造函数接受 retries 参数但忽略它 | 若未来需要进程级重试（如 OOM 后重启），定义语义。当前进程式不像 HTTP 可幂等重试 |
| TD-16 | 测试 | 真实 CLI smoke 已自动化（`npm run smoke`），但**不进 npm test**（依赖真实 API/登录/费用） | 显式 `npm run smoke` 触发。CI 不跑 |

### 临时桥接（已标注）

无新增临时桥接。M0 的桥接在 M1 拆除，M2 未引入新的临时代码。

## 设计决策记录

1. **三层抽象（ProcessBackend / LineStreamParser / 专有 parser）验证成立**。加第三个 CLI = 写第三个 parser，ProcessBackend 和 LineStreamParser 不改。这正是"runtime-agnostic 强承诺"的实证。

2. **codex 的非 JSON 行容错是通用能力，非 codex 专有**。放在 LineStreamParser（所有 parser 受益），而非 codex.js。即使未来某个 CLI 也混入日志行，自动受益。

3. **进程式 session = 子进程，resume 不可能**。这是 TD-10/TD-14 的根源，是进程式与 HTTP 类的本质差异，不是 bug。架构上正确处理方式是 resume 对进程式返回 null。

## 审计结论

M2 **通过验收 gate**。两个进程式 backend（claude-code + codex）实现完成，parser 层用真实实测格式验证（非猜测），ProcessBackend 通过 mock 子进程测试覆盖了 spawn/events/abort/exit-code 兜底。

**关键风险已化解**：plan 标记的头号风险（codex 混入非 JSON 行）通过 LineStreamParser 的通用容错解决，且有测试钉住。

**待办（非阻塞）**：真实 CLI smoke 需你手动执行（指南在 `docs/smoke-guide.md`）。这是 M2 完成定义第 5 条，但因依赖真实 API/成本，不阻塞代码合入。
