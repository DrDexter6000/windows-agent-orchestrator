# 0010: Lead-UX 方向 — 从"操作员"到"声明者"
status: accepted
date: 2026-06-25
指向: M7（无人值守 + 验收契约）

## Context

三轮 e2e dogfood（以 lead agent 身份实机走完整链）+ 两批修复（F0-F6、N1-N5）后，
WAO 在**可用性/安全性**上达标：身份清晰、选型一目、产出可取、run 可定位、验收有门、
成本可测、无残余进程。

但**好用 ≠ 顺心**。三轮里我反复观察到同一个深层模式，本 ADR 把它沉淀为方向决策，
避免 M7 启动时重新发现。

## 核心问题：安全/可见性是"你要去够的东西"，而非"默认流的属性"

一个逻辑任务（researcher 读代码 → coder 写文档 → 验收）我跑了 **6 条命令**：
```
registry list          # 谁可用
run researcher         # 派发步骤1
collect <runId>        # 取产出
run coder_low          # 派发步骤2（我手动 relay 了 brief）
runs scorecard <runId> # 验收
runs metrics <runId>   # 成本
```
6 次进程、手动在命令间传 runId。**每个安全/可见性特性（transcript/scorecard/evidence/
metrics）都是独立的动词。** N1-N5 的修复本质都是"让这些东西更好够"——但更大的举措是：
**让它们成为默认流的一部分，lead 根本不用去够。**

行业对照：GitHub Actions 不让你说"现在看日志、现在看状态、现在看成本"——它给你**一个
run 页面**，实时包含一切。`terraform apply` 在一个流里给计划→进度→结果。WAO 的
`run --wait` 是静默阻塞、末尾 dump 一个 JSON。

## 决策：lead-UX 的北极星 = "声明者，不是操作员"

**Lead 当前是操作员**（敲 6 条命令、传 runId、relay 内容）。
**目标是声明者**（描述任务+验收标准、最终复核；引擎自动跑执行/跟踪/产出捕获/门控/链式/整合/清理）。

这条方向**不是新发现，正是 M7 的愿景**。三轮 dogfood 暴露的不是新 bug，而是**通往 M7
的路径**——通过 UX friction 显形。N1-N5 是战术修补；融合项是让 M7 用起来自然的战略动作。

## 融合机会（按杠杆排序，作为 M7 的设计骨架）

### 高杠杆、低成本（M7 前期就该做）

**1. 让 `run` 成为唯一需要的命令。** 它已经返回一切。让它：
- 打印简洁 header（runId · agent · 结果 · 成本），详细 JSON 在下面
- 可选流式人类可读进度（`--watch` 默认开？），不是静默阻塞
- 内联跑 scorecard + 打印 pass/fail 卡片
- 附带 metrics

→ collect/scorecard/metrics 随之变成**仅历史回查用**。一次融合取代 4 条命令。

**2. 引擎注入 `ctx.upstream.X.text`。** N4 修复后 worker 文字已在 transcript。
当前 workflow 只给 `ctx.upstream.X.runId`（runId，不是文字）→ coder 得自己 collect，
比手敲两条 run 还麻烦。注入 text 后，**声明式链式 = 手动链式一样简单**，
消除"人肉消息总线"（我三轮里都在复制粘贴 brief）。

**3. model/provider/effort/apiKeyEnv 提为一等 agent 字段。** wrapper 变内部细节。
消除 `opus-4.8` 这类 bug 的整个类别（配置太啰嗦+间接，model 层级从 wrapper 泄露）。

### 中杠杆

**4. 渐进式 scorecard。** 默认 `requireEvidence:true`（worker 真干了？），
完成后允许追加收紧规则。验收从"opt-in 的 JSON 块"变"默认开、渐进收紧"。

**5. 任务对象。** 把相关 run（research+code+test）聚成一个句柄，带组合成本/验收。
Lead 按"实现 feature X"思考，不按 runId。

### 低杠杆 / 明确不做

**6. 富 TUI 仪表盘。** 违反无 GUI 原则。放弃。

## 与行业最佳实践的对照（CLI 工具，非 Web UI——超出 WAO 范围）

| 关注点 | 行业（docker/terraform/gh/cargo） | WAO 当前 |
|--------|----------------------------------|---------|
| 常见路径 | `terraform apply`：单流，计划→进度→结果 | 6 条命令，静默阻塞末尾 dump JSON |
| 默认输出 | `git log`：人类可读，结构化用 `--format` | 原始 JSON 或 JSONL，无人类默认 |
| 句柄可发现 | `kubectl get pod`：名字第一列 | runId 埋 JSON 里 |
| 链式 | Claude Code Task：一行生成+内联结果 | 手动两 run + 复制粘贴，或写 .mjs |
| 渐进验收 | CI：默认 pass/fail，细节按需展开 | 全有或全无的 rules JSON |

WAO 守住了 noun-verb 模式（对），但漏了我称之为**"一条命令、一个流、一张摘要卡"**
的模式——现代 CLI 工具为常见路径趋同的方向。

## 结论与边界

- **本 ADR 是方向决策，不立即开工任何融合项。** 它们是 M7 的设计骨架。
- N1-N5 已让"现在能用"成立；融合项让"M7 用起来自然"。
- **不在现在零散追求融合项 1-3**——它们要么绑死成 M7 设计一起做（否则半成品更乱），
  要么作为 M7 增量逐步落地。
- 当前唯一仍开放的能力缺口 **B2（后台消费进程）** 也归 M7，本 ADR 与之同向。

## 纪律提醒

- 写新 doc 前确认类别：本 ADR 属**决策类**（`.wao/decisions/NNNN-*.md`），只追加不改写。
- 本文不复制状态机/事件表/接口定义（契约类，在 02-architecture.md），仅指针 + 方向。
- 三轮 dogfood 的 friction 细节已冻结在 `docs/research/11`（过程类），本文只提炼方向。
