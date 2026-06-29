# M6 审计报告

> 状态：✅ 审计完成。
> 日期：2026-06-16
> 审计依据：`docs/milestone-discipline.md`（6 类别逐项检查）。

## 完成定义核验

| 完成定义 | 结果 | 证据 |
|---------|------|------|
| `npm test` 全绿 | ✅ | **204 tests, 0 fail** |
| 证据链事件落盘（TD-9 偿还） | ✅ | runEvent.js 7 种 kind + RunManager 消费 run.event |
| claude-code/codex 证据提取 | ✅ | tool_use→command/file_written, command_execution→command |
| scorecard 模块（4 检查项） | ✅ | scorecard.test.js 15 测试 |
| scorecard 门控状态机（opt-in） | ✅ | done(completed) → scorecard → failed/completed |
| 真实 smoke（满足+不满足） | ✅ | claude 写文件 + requireFiles 通过；requireCommands 缺失拦截 |
| 技术债审计 | ✅ | 见下（预审 6 类别 + 新发现 2 项 + 偿还 1 项） |

## 真实 smoke 结果

```
--- 场景 1：证据满足（requireFiles）---
  state: completed, scorecard: passed=true
  evidence: 2 event(s) [file_written, tool_result]
  ✔ hasDoneEvent  ✔ filesExist  ✔ hasEvidence

--- 场景 2：证据不满足（requireCommands 缺失）---
  state: failed, scorecard: passed=false
  lastTransition: running→failed(scorecard_failed)
  ✖ commandsPassed: not executed: this-command-does-not-exist-xyz
```

两个场景端到端验证：scorecard 正确放行满足证据的 run，正确拦截"声称完成但证据不足"的 run。

**真实 smoke 抓到两个 mock 永远抓不到的问题**（再次验证 milestone-discipline §6.1）：
1. claude Write 工具传绝对路径，requireFiles 相对路径匹配失败 → 补尾部匹配
2. claude 默认权限模式下不真正执行工具调用 → 需 `--dangerously-skip-permissions`

## 逐 Task 验收

| Task | Gate | 结果 |
|------|------|------|
| M6-1 runEvent 扩展 | 4 构造器 + KINDS + exitCode omit + isError 必填 | ✅ 16 测试 |
| M6-2 证据落盘 | run.event 写入 + 不触发转移 + evidence 返回值 | ✅ 4 测试（runManager） |
| M6-3 claude parser | Bash/Write/Edit/tool_result + 混合 + 边界 | ✅ 9 测试 |
| M6-4 codex parser | command_execution + exitCode + 失败不 done | ✅ 4 测试（+1 旧测试更新） |
| M6-5 scorecard | 4 检查项 + opt-in + 绝对路径匹配 | ✅ 15 测试 |
| M6-6 状态机接入 | opt-in + 满足通过 + 不满足 failed + agent 配置 | ✅ 6 测试（runManager） |
| M6-7 CLI + smoke | runs scorecard 命令 + 真实两场景 | ✅ smoke PASS |

## 技术债预审（6 类别逐项）

| 类别 | 检查结论 |
|------|---------|
| **代码异味** | ✅ scorecard.js 无重复逻辑；checkCommandsPassed/checkFilesExist 结构对称；pathMatches 独立函数。无死代码。 |
| **接口契约** | ✅ checkScorecard 签名 `{events, cwd, rules}` 与 spec §6.1 一致；ScorecardResult `{passed, checks}` + check `{name, passed, evidence, detail?}` 字段完整。toolResultEvent 强制 isError 布尔（契约严格）。 |
| **测试覆盖** | ✅ exitCode=undefined 边界测；requireCommands 包含匹配测；绝对 vs 相对路径测；无 rules opt-in 测。🟡 **并发证据未测**（多条 command 同时到达）——登记 TD-32。 |
| **向后兼容** | ✅ 无 rules 时 waitForCompletion 行为与 M5 完全一致（旧 158 测试零回归）；旧 transcript（无 run.event）被 scorecard 读时 evidence 为空，hasDoneEvent 仍可判。codex 旧测试"command_execution failed 返回 []"更新为"不 emit done"——行为变更已记录。 |
| **依赖方向** | ✅ scorecard.js 只依赖 node:fs + node:path，不依赖 runManager/workflow（纯横切层）。RunManager 依赖 scorecard（单向），不反向。 |
| **未完成项** | 🟡 opencode 证据提取未做（计划内禁做，登记 TD-33）；claims/evidence-loop 留 M7；CLI `--scorecard-rules` 只支持 JSON 格式。注：TD-33 的 opencode tool part schema **已在 `research/07` 勘测完毕**（自包含 input+output+status），未做的是把 schema 落成 parser 代码，不是"未知"。 |

## 偿还的技术债

| # | 原登记 | 偿还内容 |
|---|--------|---------|
| TD-9 | M2/M4：证据链事件（command/file_written/tool_use）未实现 | ✅ M6-1 全部实现 + M6-3/M6-4 两个 backend 提取 |

## 实现中自检发现并修复（2 项）

| # | 问题 | 修复 |
|---|------|------|
| — | scorecard `filesExist` 精确匹配 `f.path === required`，claude Write 传绝对路径时匹配失败 | 改为 pathMatches 尾部匹配（规范化分隔符 + 精确 OR 后缀）|
| — | claude 默认权限模式下 Write/Bash 工具不真正执行（只输出意图），file_written 有事件但文件不存在 | ClaudeCodeBackend buildArgs 合并 agent.args；smoke 场景加 `--dangerously-skip-permissions` |

## 新登记延后（2 项）

| # | 问题 | 触发条件 |
|---|------|---------|
| TD-32 | scorecard 并发证据未测（多条 command 事件同时到达时 evidence 数组顺序） | 实战中遇到高并发工具调用时补测试 |
| TD-33 | opencode-serve 证据提取未实现（schema 已在 `research/07` 勘测，待落 parser） | opencode run 需要 scorecard 门控时补 parser |

## 设计记录

1. **scorecard 是横切层，不是图节点**——与 Niuma 把"检查证据"作为流水线一站不同，我们挂在状态转移上（done→completed 的守门）。这让每个 agent 节点自动获得证据门控，无需在 DAG 里显式加 gate 节点。gate 节点（M5）和 scorecard（M6）边界清晰：gate 查 claims 字段存在，scorecard 查事实。
2. **opt-in 语义保证向后兼容**——scorecardRules=null 时行为与 M5 完全一致。这是"无 rules = 不拦"的诚实设计：不假装验证了什么。
3. **路径/命令匹配用包含逻辑而非精确**——runtime 会包装命令（`npm test --verbose`）、传绝对路径（`D:\proj\out.js`）。scorecard 必须容忍这些差异，否则会误判。这和 requireCommands 的设计意图一致："验证 agent 跑了测试"，不是"验证 agent 跑了完全一致的字符串"。
4. **claude 权限模式是真实 smoke 才能抓到的**——mock backend 直接注入事件流，永远不会碰到"工具调用不执行"的问题。这再次证明 milestone-discipline §6.1 的规则：涉及外部系统的 milestone，收尾必跑真实 smoke。

## 审计结论

M6 **通过验收 gate**。证据链门控完整实现（4 种证据事件 + 2 个 backend 提取 + scorecard 4 检查项 + opt-in 状态机门控），真实 smoke 两场景端到端验证。偿还 TD-9（M2/M4 登记），新发现 2 项实现中修复（路径匹配、权限模式），登记 2 项延后（TD-32 并发、TD-33 opencode）。
