# 0031: DSH ACP 后端落地方案（B-2）

status: proposed
date: 2026-09-19
author: Lead（Owner 2026-09-19 授权：先审方案、后开工）

## Context

WAO 现有 backend 闭集为 opencode-serve / claude-code / codex / kimi-code / deepseek-harness
（`docs/02-architecture.md`；成员增补属 Owner 决策）。其中 `deepseek-harness` 是 WAO 自建的
stdio JSON-RPC composition（`~/.wao/runtimes/dsh-jsonrpc/`，pin `@deepseek-ai/dsh-*@0.1.0-rc.6`）。

2026-08-15 该线暂停（TD-117）：`supportsSessionReuse=false`（`src/backends/deepSeekHarness.js:76`），
researcher lane 带 `sessionReuse` 时会在 spawn 前被 `runManager.js` fail-closed 拒绝。

Owner 2026-09-19 指令：DeepSeek 已结清；**不改现有 provider/model 配置**；先解决技术问题——
证明 dsh 驱动 DeepSeek 的组合可用，并具备 WAO 所需能力。

本文是**前置方案审查的标的**，不是施工单；`status: proposed`，待裁定后转 accepted。

## 1. 已验证事实（2026-09-19，dsh 0.1.5-rc.2，Windows，Node 24.13.1）

验证方式：WAO 侧手写**零依赖** ACP 客户端（纯 `node:` 内置模块），直接 spawn `dsh --profile acp`。
原始 JSON 输出留档于本机 `.dev/dsh-acp-probe/`（gitignored）。

| # | 事实 | 证据 |
|---|---|---|
| F1 | `dsh --profile acp` 是上游 **shipped profile**，非 WAO 自建组合 | `dsh --profile acp --help` 直接可用，无需 bootstrap |
| F2 | 服务端经 `initialize` 声明 `sessionCapabilities: {close, list, resume}` | 原始响应 |
| F3 | 单轮可真实驱动 DeepSeek 并执行工具：`write` + `pwsh` 调用成功，物理文件落盘 | `stopReason: "end_turn"`；`usage_update.used ≈ 10.5k / 1M` |
| F4 | **跨进程会话恢复可用**：进程 A 建会话 → 进程 B `session/list` 列出 → `session/resume` → 模型在**零工具**条件下复述上一轮写入内容 | `resumeRecalledSentinel: true`；上下文 10537 续接 |
| F5 | 会话配置项随会话暴露：`model` = `["deepseek-official","deepseek-v4-flash"]`；`reasoning_effort` = off/low/high/max（**四档**） | `session/new` 的 `configOptions` |
| F6 | 上游明确不支持：wire 无 `session/load`、无 fork、无 deletion、无 modes/commands/plans/terminals | `dsh-acp` README §Protocol contract |
| F7 | ACP 有 `session/cancel`（真取消）与 `session/close`；**无在途消息改写** | 同上 |

**对照（旧线未被修复）**：现有 `deepseek-harness` 走的 JSON-RPC 面**至今无 resume**——
`dsh-sdk-jsonrpc-server@0.1.5-rc.2` 随包 README 明写 "The wire has no per-session close or
prompt-cancel method"，且新进程一律走 `ctx.agents.create()`。故 **TD-117 只在 ACP 面上成立**。

## 2. containment 与角色合同（已实测）

shipped `acp` profile 建在 `dsh-base` 上，默认携带 subagent / workflow / ralph / goal / skills / jobs / web。
CLI 提供 `--patch <file>`（可重复，叠加于 profile 层之后），格式与 WAO 现有
`wao-coder.cordis.yml` 同源（Cordis patch list）。

**二分实测（判据 = `session/new` 成功/失败）**：

| 被关闭的 id | 结果 |
|---|---|
| `tool-subagent` / `tool-subagent-fork` / `tool-subagent-control` / `tool-workflow` / `tool-ralph` | OK |
| `tool-goal` / `plan-mode` / `tool-todo` / `tool-jobs` / `tool-skill` / `tool-web` | OK |
| `jobs` / `skill` / `skill-filesystem`（服务） | OK |
| `subagent` / `subagent-spawn-in-process` / `subagent-fork-in-process`（服务） | **失败 -32603** |
| `workflow-worker-thread`（服务） | **失败 -32603** |
| `goal` / `goal-round-driver`（服务） | **失败 -32603** |

结论：**关"工具门面"安全（模型看不到即达成 containment）；关"运行时服务"会打断 agent 组合。**

角色合同注入：`--patch` 覆盖 `system-prompt.personaPrefix` 已验证生效，且与 containment 层
**同一次 compose 双向叠加有效**（17 条 `disabled: true` 与新 personaPrefix 并存）。

## 3. 提议设计

### 3.1 集成面
新增 ACP over stdio 集成面：`dsh --profile acp --patch <containment.yml> --patch <role-contract.yml>`。
**不修改 DSH 安装**（全局包保持原厂）；不改任何现有 worker 的 provider/model。

### 3.2 资产落位
- **不入库（机器本地）**：`~/.wao/runtimes/dsh-acp/`
  - `wao-contain.patch.yml`——固定，一次写成
  - 角色合同 patch——由 backend **每次派发时**生成到 run 级临时目录（内容随 `task.roleContract` 变化），run 结束清理
- **入库**：新 backend 源码 + 测试 + 文档指针

### 3.3 新 backend：`src/backends/deepSeekAcp.js`

| 能力 | 初值 | 依据 |
|---|---|---|
| `supportsRoleContract` | true | personaPrefix 注入已验证 |
| `supportsSessionReuse` | **true** | F4；TD-117 卡点解除 |
| `supportsInFlightCorrection` | **false** | F7：ACP 无在途改写 |
| `replayByRespawn` | false | 有真 resume，无需重放 |
| `reportsTokenUsage` | true | `usage_update` 与 `PromptResponse.usage` |

### 3.4 事件投影（ACP → RunEvent）
- `agent_message_chunk` → message(assistant)
- `tool_call` / `tool_call_update` → tool_use / tool_result（status: pending/in_progress/completed/failed）
- `PromptResponse.stopReason` → done（`end_turn`；`cancelled`/`refusal`/`max_tokens` 需映射到既有语义）
- `usage_update` → metrics
- `session/request_permission` → backend 自动应答（需与 WAO 既有 approval 语义对齐）

### 3.5 fail-closed 边界（沿用旧线纪律）
未绑定 `sessionId`、未知 `sessionUpdate` 类型、提前 transport close、runtime identity 不符
→ fail closed，**不投影为 completed**。
**待审**：是否需 backend 侧二次校验"工具面已收窄"（例如出现 subagent 工具调用即判失败）。

### 3.6 sessionReuse 语义
`session/resume` 需 `sessionId` + `cwd`，跨进程有效。WAO 侧需定：sessionId 持久化槽位、
与 worktree 生命周期的关系（resume 要求 cwd 一致，与 delivery worktree 的短生命周期存在张力）。

### 3.7 与旧线关系
新旧并存；旧 `deepseek-harness` backend 与其 runtime **保留至新线认证通过**，之后由 Owner 决定去留。

## 4. 认证与验收路径
- 新 backend = 新组合 → 按 ADR-0029 #3「换 backend 或 lane 升主力 → 全量」。
- 命令：`npm run reliability -- --agent <newLane> --profile strict --wait-timeout 600000`。
- 新 lane 用**独立 agentId**（如 `coder_low_dsh`），不改现有 registry 条目（决策 0025 #2）。
- 合入前：方案审查（本次，stage 2）+ 交付后审计（stage 4）+ 集成后 main 全量 `npm test`（T3）。

## 5. 未决问题（请审查方重点判断）
1. `supportsInFlightCorrection=false` 对主力 lane 是否可接受？researcher 是否依赖在途纠偏？
2. 每派发生成角色合同 patch 的落点与清理责任（越界写风险 vs 临时文件生命周期）。
3. worktree 短生命周期 vs resume 要求 cwd 一致的张力如何解？
4. containment 判定面：仅靠 compose 层 `disabled` 是否足够，还是 backend 需二次校验？
5. 认证范围：全量是否必要，或可先 delta 再升主力（ADR-0029 档位规则）？

## 6. 明确不做
- 不改现有 worker 的 provider/model（Owner 指令）。
- 不改 DSH 安装或上游源码。
- 不删除旧 `deepseek-harness` 线。
- 不引入新的生产依赖（探针已证零依赖可行）。

## Consequences
（待裁定后补：`docs/02-architecture.md` backend 闭集条目、`docs/usage.md` 配置节、
`docs/team-roles.md` lane 行、`npm run gen:surface` 再生成。）
