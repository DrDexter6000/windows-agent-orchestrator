# M4 审计报告

> 状态：✅ 审计完成。
> 日期：2026-06-15

## 完成定义核验

| 完成定义 | 结果 | 证据 |
|---------|------|------|
| `npm test` 全绿 | ✅ | **122 tests, 0 fail** |
| `runs metrics <runId>` 显示 token/duration/state | ✅ | 真实 claude run 显示 input=5518 output=7 reasoning=3761 cost=$0.0576 |
| `runs metrics --summary` 聚合 | ✅ | 真实验证 + 3 个 CLI 测试 |
| 三个 backend token 提取 | ✅ | claude（smoke 验证）+ opencode（实测字段确认）+ codex（测试覆盖）|
| 技术债审计 | ✅ | 见下 |

## 真实 smoke 结果

```
runs metrics run_xxx
  state:    completed
  duration: 5.1s
  tokens:   input=5518 output=7 reasoning=3761
  cost:     $0.0576
```

token 从 claude 的 `result.usage` → parser metricsEvent → RunManager → transcript → `runs metrics` 全链路打通。

## 逐 Task 验收

| Task | Gate | 结果 |
|------|------|------|
| M4-1 metricsEvent | 构造器 + omit undefined + KINDS | ✅ 8 测试 |
| M4-2 parser token 提取 | claude(usage) + codex(turn.usage) + opencode(info.tokens) | ✅ 各加测试 |
| M4-3 RunManager 消费 | metrics 写 transcript + 返回值 | ✅ 2 测试 |
| M4-4 metrics 聚合器 | aggregateRunMetrics + aggregateSummary + formatDuration | ✅ 6 测试 |
| M4-5 CLI runs metrics | 单 run + summary + json 格式 | ✅ 3 测试 |

## 技术债清单

### 已登记延后（2 项）

| # | 问题 | 触发条件 |
|---|------|---------|
| TD-9 | 证据链事件（command/file_written/tool_use）仍未实现 | M6 scorecard |
| TD-24 | opencode 的 token 是"最后一条 assistant 消息的累计值"，不是增量。若多轮对话，token 可能偏高 | M5/M6 若需精确分轮 token 时处理 |

### 无新增已修技术债

M4 实现过程中未发现需要当场修的技术债。token 提取是纯增量（parser 加几行字段读取），不侵入现有架构。

## 设计记录

1. **metrics 事件不触发状态转移**——它是"旁路"信息，只写 transcript + 返回给调用方，不参与状态机。
2. **三个 backend 的 token 字段位置各不同**（claude 的 result.usage / codex 的 turn.completed.usage / opencode 的 info.tokens），但都翻译成统一的 metricsEvent——再次验证 runtime-agnostic 抽象。
3. **opencode token 是累计值**（TD-24）——诚实标注，不假装是增量。
