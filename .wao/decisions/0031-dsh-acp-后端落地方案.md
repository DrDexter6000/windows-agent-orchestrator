# 0031: DSH ACP 后端落地方案（B-2）

status: accepted
date: 2026-09-19
author: Lead（Owner 2026-09-19 授权：先审方案、后开工）
review: 前置方案审查已过 —— auditor `run_20260919232557140mvw4ov` PASS_WITH_CHANGES；
        researcher `run_20260919232554555pjmuxi` PASS_WITH_CHANGES（两席无分歧）。
        本版已折叠全部 findings，见 §5。
        **Owner 2026-09-20 裁定：接受 `deepseek-acp` 成员资格**（见 §7）。
rulings: 裁定记录（2026-09-20，**两项均已获 Owner 追认**；依据两席专项咨询 auditor run_20260920073941517068b7w
         与 coder_mm run_20260920073938973bbp3l9，两席对下列两项意见一致）：
         (A) §3.6 关联面**正式延期**；`supportsSessionReuse` 取 **false**（翻转条件见 §3.6）。
         (B) 闭集 5→6 保留为**候选注册**，删除一切"Owner 已授权"表述。→ **已由 Owner 2026-09-20 裁定接受**，见 §7。
         (C) effort **硬拒**（见 §3.3）。
         (B) 已由 Owner 裁定（§7）；(C) 属 Lead 职权、已生效；(A) **已由 Owner 追认**（同意「会话复用单独立项」，即接受本轮关联面延期）。

## Context

WAO 现有 backend 闭集为 opencode-serve / claude-code / codex / kimi-code / deepseek-harness
（`docs/02-architecture.md` 闭集；成员增补属 Owner 决策）。其中 `deepseek-harness` 是 WAO 自建
stdio JSON-RPC composition（`~/.wao/runtimes/dsh-jsonrpc/`，pin `@deepseek-ai/dsh-*@0.1.0-rc.6`）。

2026-08-15 该线暂停（TD-117）：`supportsSessionReuse=false`（`src/backends/deepSeekHarness.js:76`），
researcher lane 带 `sessionReuse` 时会在 spawn 前被 `src/runManager.js:870-881` fail-closed 拒绝。

Owner 2026-09-19 指令：DeepSeek 已结清；**不改现有 provider/model 配置**；先解决技术问题。

## 1. 已验证事实（2026-09-19，dsh 0.1.5-rc.2，Windows）

验证方式：WAO 侧手写**零依赖** ACP 客户端（纯 `node:`）直接 spawn `dsh --profile acp`。
资产与原始输出已入库：`scripts/reliability/dsh-acp/`（含 `evidence/`），见 §7。

> **环境声明（审查修正）**：上述探针运行于**全局 Node 24.13.1**。但 `docs/usage.md:19` 明确
> WAO 入口（cli / daemon / background-runner）**拒绝 Node 24、使用 Node 22**。
> 因此探针结论**不等于 WAO 集成验收**；认证必须经 WAO 规范入口，并记录 DSH 子进程实际 Node 版本。

| # | 事实 | 证据 |
|---|---|---|
| F1 | `dsh --profile acp` 是上游 **shipped profile**，非 WAO 自建组合 | `dsh --profile acp --help` 直接可用；`--dump-default-config` 输出 86 条目 |
| F2 | 经 `initialize` 声明 `sessionCapabilities: {close, list, resume}` | `evidence/phase2-list.json` |
| F3 | 单轮可真实驱动 DeepSeek 并执行工具：`write` + `pwsh` 调用成功、物理文件落盘 | `evidence/phase4-contained-safe.json`；`stopReason: "end_turn"` |
| F4 | **跨进程会话恢复可用**：进程 A 建会话 → 进程 B `session/list` → `session/resume` → 模型**零工具**复述上一轮内容 | `evidence/phase2-resume.json`；`resumeRecalledSentinel: true`，上下文 10537 续接 |
| F5 | 会话配置项随会话暴露：`model`、`reasoning_effort`（**off/low/high/max 四档**） | `evidence/phase4-contained-safe.json` 的 `configOptions` |
| F6 | 上游明确不支持：`session/load`、fork、deletion、modes、commands、plans、terminals | `dsh-acp` README §Protocol contract |
| F7 | ACP 有 `session/cancel`（真取消）与 `session/close`；**无在途消息改写** | 同上 |
| F8 | **wire 上 `tool_call.title` 即工具真名**（`write` / `pwsh` / `subagent`）；stock profile 下模型确实成功调用了 `subagent` | `acp-tool-sample.mjs` 采样（本版新增，Q4 前置） |

**对照（旧线未被上游修复）**：`deepseek-harness` 走的 JSON-RPC 面**至今无 resume**——
`dsh-sdk-jsonrpc-server@0.1.5-rc.2` 随包 README:125 明写 "The wire has no per-session close or
prompt-cancel method"，且新进程一律 `ctx.agents.create()`。**TD-117 只在 ACP 面上成立。**

## 2. containment 与角色合同（已实测）

shipped `acp` profile 建在 `dsh-base` 上，默认携带 subagent / workflow / ralph / goal / skills / jobs / web。
CLI 提供 `--patch <file>`（可重复，叠加于 profile 层之后），格式与 `wao-coder.cordis.yml` 同源。

**二分实测（判据 = `session/new` 成功/失败）**：

| 被关闭的 id | 结果 |
|---|---|
| `tool-subagent` / `tool-subagent-fork` / `tool-subagent-control` / `tool-workflow` / `tool-ralph` | OK |
| `tool-goal` / `plan-mode` / `tool-todo` / `tool-jobs` / `tool-skill` / `tool-web` | OK |
| `jobs` / `skill` / `skill-filesystem`（服务） | OK |
| `subagent` / `subagent-spawn-in-process` / `subagent-fork-in-process`（服务） | **失败 -32603** |
| `workflow-worker-thread`（服务） | **失败 -32603** |
| `goal` / `goal-round-driver`（服务） | **失败 -32603** |

> **能力边界（审查收紧，不夸大）**：compose 层 `disabled` 是**唯一真 containment**。
> `session/new` 成功**只证明组合能够建立，不证明不存在间接调用**；本层**不是** OS 级沙箱隔离。
> 协议无法观察的行为一律列为能力边界，不声称已阻止。

角色合同注入：`--patch` 覆盖 `system-prompt.personaPrefix` 已验证生效，且与 containment 层
**同一次 compose 双向叠加有效**。

## 3. 设计

### 3.1 集成面
`dsh --profile acp --patch <containment.yml> --patch <role-contract.yml>`。
不修改 DSH 安装；不改任何现有 worker 的 provider/model。

### 3.2 资产落位（审查修正）
- **不入库、机器本地**：`~/.wao/runtimes/dsh-acp/wao-contain.patch.yml`
  - 内容与版本依据 = 仓库内 `scripts/reliability/dsh-acp/wao-contain-safe.patch.yml`（§7）
  - **由操作员安装**；WAO 只 detect / invoke / report，**不生成、不升级、不持久修复**（`docs/usage.md:187`）
  - 缺失或与声明不匹配 → backend 启动时 **拒绝派发**（fail-closed），不静默降级
- **每次派发临时目录**：OS temp + runId 前缀的独占目录，存放当次角色合同 patch
  - 角色合同用**结构化序列化**生成 YAML，禁止字符串拼接
  - 清理责任：backend 实例 `finally` / stop 路径；启动时 best-effort 清扫孤儿（覆盖被 kill 的残留）
  - 仅删除自身创建的目录；**绝不写** `~/.wao/runtimes/dsh-acp/`，**绝不**删除会话存储
  - patch 内容为角色合同文本、无凭据、**不进 transcript**
- **入库**：backend 源码 + 测试 + 文档 + §7 验证资产

### 3.3 新 backend：`src/backends/deepSeekAcp.js`

| 能力 | 值 | 依据 |
|---|---|---|
| `supportsRoleContract` | true | personaPrefix 注入已验证 |
| `supportsSessionReuse` | **false** | **Lead 临时裁定（2026-09-20，待 Owner 追认）**：F4 只证明上游协议具备 resume；WAO 侧 §3.6 关联面未落地，声明 true 属"声明强于实现"。落地 §3.6 五项 + 认证含真实会话恢复 drill 后改回 true。依据两席专项咨询（auditor/coder_mm 一致） |
| `supportsInFlightCorrection` | **false** | F7；能力表**如实标注"不支持"，不静默** |
| `replayByRespawn` | false | 有真 resume，无需重放 |
| `reportsTokenUsage` | true | `usage_update` + `PromptResponse.usage` |

**policy 校验面（folding：Lead 2026-09-20 初裁 → Phase 5 修订）**：旧线 `validateAgentPolicy` 限 `{high, max}`
（`src/backends/deepSeekHarness.js:95-99`）；ACP 面 `configOptions` 暴露四档 off/low/high/max（F5）。
初裁依据"**F5 只证明暴露、未证明可设置**"而**硬拒任何非空 `reasoning.effort`**（配了不能表达的值
必须硬拒，不静默忽略）。该前提已被 **Phase 5 真实 runtime 实测推翻**（见 §7.3 注意事项 3）：
`session/set_config_option` 可设置 reasoning_effort，域外值被 `-32602` 拒绝。
现语义 = **条件放行 `low/high/max`**（WAO 六值闭集 ∩ ACP 广告四档；不发明映射），
派发时下发且响应未确认即 fail-closed；`provider` 与 `model` 块仍拒绝——**model 的理由已改写**：
不是"无通道"（同一探针已证可 set），而是"WAO 本轮未接线 + value 形状不同（provider/model 对
vs 裸 `model.id`）"。

### 3.4 事件投影（ACP → RunEvent）——审查后补全

**必须覆盖 `docs/02-architecture.md` §2.2 的交付证据链**（旧线 `projectDshEvent` 已有对应提取）：

| ACP wire | RunEvent | 规则 |
|---|---|---|
| `agent_message_chunk` | `messageEvent("assistant", …)` | 按 `sessionId` 绑定；未绑定即丢弃 |
| `agent_thought_chunk` | `thinkingEvent()` | |
| `tool_call`（`title` = 工具真名，F8） | `toolUseEvent(tool, input)`；文件写类另发 `writeIntentEvent(path, toolCallId, …)` | `toolCallId` 为关联键 |
| `tool_call_update` `status: completed` | `toolResultEvent(tool, output, isError)`；**关联成功**才发 `fileWrittenEvent(path)` | **`pending`/`in_progress` 绝不当作成功** |
| `tool_call_update` `status: failed` | `toolResultEvent(tool, output, true)` | 不得发 `file_written` |
| shell 类工具（`pwsh` 等） | `commandEvent(command, exitCode)` | 需从结果提取退出码；无法提取时不伪造 |
| `usage_update` | 中间态观察，**不直接发 `metricsEvent`** | 见下 |
| `PromptResponse.usage` | `metricsEvent({input, output, reasoning, cacheRead, cacheWrite})` | **终局用量唯一来源** |

**去重与边界（审查新增）**：
- `usage_update.used` 是**上下文占用量**，**不得**当作本轮 input token 计入 `metricsEvent`。
- 同一 `toolCallId` 的重复/乱序更新：以**首个到达的终态**为准，后续同 `toolCallId` 终态忽略并留痕。
- 未知 `sessionUpdate` 类型 → fail-closed（不投影、不吞掉）。

**终态映射（审查新增）**：

| `stopReason` | 终态 |
|---|---|
| `end_turn` | `doneEvent("completed")`；无可用效应时补 `completed_empty` 标记（`DONE_MARKERS`）|
| `cancelled` | `doneEvent("failed", "…cancelled")`（WAO 既有 done 只接受 completed/failed）|
| `refusal` / `max_tokens` / `max_turn_requests` | `doneEvent("failed", <闭集码>)` |
| 断链（transport close 先于终态） | `doneEvent("failed", "…transport closed")` |

### 3.5 fail-closed 与二次校验（审查修正）

沿用旧线纪律：未绑定 `sessionId`、未知 `sessionUpdate`、提前 transport close、runtime identity
不符 → fail closed，**不投影为 completed**。

**二次校验 = 越界 tripwire，不是第二层 containment**（两席一致）：
- 在事件投影处加 deny-list 断言：出现 `subagent` / `subagent_fork` / `spawn_teammate` 类工具调用
  即 `doneEvent("failed", …)`。F8 已确认 `title` 即工具真名，**前置条件已满足**。
- 如实定位：这是**检测**（detection），**不是阻止**（prevention）——副作用可能已发生。
- 与旧线 `consumeNotification` 对未授权内部 subagent 判失败同源，也与 `docs/02-architecture.md` §2.4
  claude-code 禁 runtime 内建 subagent 先例一致。

**`session/request_permission` 应答规则（审查新增）**：
- 选项含 `allow_once`/`allow_always` → 选中（WAO 侧权限模型为 worktree containment，非逐次审批）
- 仅含 reject 类或 **未知 kind** → 选中 reject；无可选项 → `outcome: "cancelled"`
- 每次应答进 transcript 供审计；不得静默丢弃

### 3.6 sessionReuse 合同（审查后重写）

**不再新造持久化面**——挂接既有语义：`docs/02-architecture.md:235-239` 已把 `sessionReuse`
定为封闭集 `"lead_workspace" | null`，绑定点是 **stable lead workspace**，不是短命 delivery worktree。

规则：
1. 仅 **stable-workspace lane** 开 `sessionReuse`；`cwd` 为 delivery worktree 的 run **一律 fresh session**。
2. ACP `session/resume` 会校验 canonical workspace（`dsh-acp` README:68）；恢复失败
   **必须 fail-closed 报错，不得静默新建会话**（否则静默丢上下文）。
3. `opaqueUuid` 与 ACP `sessionId` 的关联须补齐（审查指出 `src/application/sessionReuse.js`
   的 `validateSessionReuseRouting` 只传 `{mode, opaqueUuid, turn}`，路由存储只记 `{runId, updatedAt}`）：
   规定持久化、原子写入、并发互斥、身份绑定，以及**缺失/损坏时拒绝恢复**的行为。
4. **不得**只把 `supportsSessionReuse` 改成 `true` 了事。
5. worktree 级 resume 需上游确认 workspace 变更语义——README 未提供，**列为未决**。

**裁定（Owner 2026-09-20 追认）：关联面正式延期，会话复用单独立项。**

- 本轮范围为：**独立新会话可用；跨 run 复用不可用**。`supportsSessionReuse` 取 **false**。
- **翻转条件（全部满足才可改回 true）**：§3.6 五项（关联持久化 / 原子写 / 并发互斥 /
  与 `{leadSession, workspace, agentId}` 三元组的身份绑定 / 缺失损坏时拒绝恢复）落地
  + §4 认证含**真实会话恢复 drill** + 本 ADR 转 accepted。
- **拒绝点清单与顺序不变量**：`deepSeekAcp.js` preflight 与 spawn 双拒绝点；
  "拒绝先于 transcript / worktree / spawn"（`runManager.js:959-965`）为**测试钉住的不变量**。
- **fail-closed 声明的适用域（重要边界）**：本 backend 的 fail-closed **只覆盖 resume 分支**。
  路由层"降为 first"三条路径（`sessionReuse.js:237-239 / 390-396 / 397-405`）是
  **M11-11C 既有 provider-中立合同**（`:381-389` 自述 "This is a degrade, not fail-closed"），
  **对 claude-code 同样成立**，不在本 backend 的 fail-closed 声称范围内。
- **interim 不变量**：§3.6 规则 1 照守（delivery worktree 一律 fresh session）；
  无 containment 资产时任何派发 fail-closed。
- **台账**：本延期登记为在册债务（TD），`docs/usage.md` 能力表与 §2.5b / §4.10 文案同步 interim 状态。
- **反静默要求**：任何复用请求（含 `first` / `resume` / `continuable`）均**不得**退化为新会话；
  不得自动修改现有 lane 配置、删除历史，或用新会话"修复"恢复失败。

### 3.7 与旧线关系
新旧并存；旧 backend 与其 runtime **保留至新线认证通过**，之后由 Owner 决定去留。

## 4. 认证与验收路径（审查修正：档位）

新 lane 用**独立 agentId**（如 `coder_low_dsh`），不改现有 registry 条目（ADR-0025 #2）。
档位按 ADR-0025 #5 + ADR-0029 #3：

```
新组合 → delta（sentinel + scorecard + 越界写对抗；isolation 不得省）→ conditional
       → lane 升主力（承重）前 → 全量 strict 认证
```

两席一致：属**成本排序**而非合规问题。若 Owner 即打算让该 lane 承重，则一次全量更省。
认证须补：**真实会话恢复、角色合同注入、取消、权限处理、工具证据**五面。
命令：`npm run reliability -- --agent <newLane> --profile strict --wait-timeout 600000`。

合入前：方案审查（已过，本文件）→ 交付后审计（stage 4）→ 集成后 main 全量 `npm test`（T3）。

## 5. 本轮修订对照（审查 findings 处置）

| 来源 | finding | 处置 |
|---|---|---|
| auditor [高] | sessionReuse 合同未补齐 | §3.6 重写（挂接 `lead_workspace` + 关联/原子/互斥/拒绝恢复）|
| auditor [高] | §3.4 投影不足以支撑证据链 | §3.4 补全表（含 `command`/`write_intent`/`file_written`）+ 去重规则 |
| auditor [高] | 权限自动应答 + containment 表述过强 | §3.5 补应答规则；§2/§3.5 改为"检测非阻止" |
| auditor [中] | 终态与用量映射缺失 | §3.4 增终态映射表 + `usage_update` 去重 |
| auditor [中] | Node 版本不符 | §1 增环境声明；认证须走 WAO 入口 |
| auditor [中] | containment 文件内容/版本依据/责任人 | §3.2 明确内容来源、操作员安装、不匹配即拒 |
| researcher [中] | 二次校验缺实施前提（工具名映射未验证） | **F8 采样已补**；§3.5 tripwire 可实施 |
| researcher [低] | §4 档位表述不完整 | §4 改为 delta→全量 |
| researcher [低] | §3.6 重新发明 | §3.6 收编既有封闭集 |
| researcher [低] | effort 闭集未定义 | §3.3 增 policy 重定义 |
| researcher [低] | 权限对齐点 | §3.5 明确 |
| researcher [低] | 行为主张复现性 | §7 资产入库（F1–F7 现可在仓库内核验）|
| 两席 | F1–F7 CANNOT_VERIFY（`.dev/` 未入库）| §7 资产入库，消除该面 |

## 6. 明确不做
- 不改现有 worker 的 provider/model（Owner 指令）。
- 不改 DSH 安装或上游源码。
- 不删除旧 `deepseek-harness` 线。
- 不引入新的生产依赖（探针已证零依赖可行）。
- 不声称 containment 是 OS 级沙箱隔离。

## 7. 验证资产（入库，可复现）

`scripts/reliability/dsh-acp/`：`acp-probe.mjs` / `acp-smoke.mjs` / `acp-tool-sample.mjs` /
`wao-contain-safe.patch.yml` / `evidence/*.json` / `README.md`（含复现步骤与诚实边界声明）。
零依赖、无凭据。

## 7. 成员资格裁定（Owner，2026-09-20）

### 7.1 裁定
`deepseek-acp` **接受为 backend 闭集正式成员**（5→6）。闭集成员增补属 Owner 决策
（`docs/02-architecture.md:223`），本条即该决策的记录。

### 7.2 前因（怎么走到这一步）
1. **旧线为什么停**：2026-08-15 `deepseek-harness`（WAO 自建 stdio JSON-RPC composition）因
   `supportsSessionReuse=false` 暂停（TD-117）。Owner 当时的动因是"deepseek 模型在 dsh 中任务完成质量
   更高、token 消耗更少"——**不是质量问题，是控制面契约缺口**。
2. **2026-09-19 Owner 指令**：DeepSeek 已结清；**不改现有 provider/model**；先解决技术问题。
3. **B-2 验证**：证明 dsh 0.1.5-rc.2 经 ACP 面可驱动 DeepSeek，且**跨进程 session/resume 可用**
   （F1–F8；证据入库 `scripts/reliability/dsh-acp/`）。关键对照：旧 JSON-RPC 面**至今无 resume**，
   故 TD-117 只在 ACP 面上成立。
4. **实现与两轮审计**：首轮交付 `c213ea2` 被 **Lead 拒收**（auditor FAIL：Windows 启动链断裂、
   toolCallId 可伪造 `file_written`、权限缺会话/终态约束等 6 项）；修正轮 `28e87e7` 经二轮两席审计
   逐条核验第 1/2/3/5/6 项 FIXED、无回归；规格强于实现由 `200fec9` 闭合。
5. **Owner 裁定**：2026-09-20 接受成员资格。

### 7.3 注意事项（**接受成员资格 ≠ 现在可用**）
接受成员资格只是"占名分"。下列约束在本 ADR 有效期内持续成立：

1. **成员资格 ≠ 完整认证（两层口径，ADR-0032）**。**组件层**已于 2026-09-20 完成并通过：
   `backend:deepseek-acp@da12bfa…` 记入 `runs/component-checks.json`，17/17 ALL PASS → `conformant`。
   但 §4 的**组合层**认证（`npm run reliability`）**尚未执行**，`certification` 为空。
   **组合层认证通过前任何 lane 不得以 `deepseek-acp` 承重。**
2. **操作员前置**：`~/.wao/runtimes/dsh-acp/wao-contain.patch.yml` 必须由操作员手工安装
   （WAO 不生成、不升级、不修复外部 runtime）。**缺失或内容不匹配时任何派发 fail-closed。**
   建议以 `scripts/reliability/dsh-acp/wao-contain-safe.patch.yml` 为准自行比对；
   **当前无自动一致性校验**，且 dsh 升级若改插件 id，覆盖层会**静默失效**（关不存在的 id = 没关）。
3. ~~**`effort` 硬拒**~~ → **已由 Phase 5 收窄（2026-09-20）**：真实 dsh 0.1.5-rc.2 实测证明
   `session/set_config_option { configId: "reasoning_effort", value }` **可设置**（set 响应
   `currentValue` 确认生效；域外值 `medium` 被 `-32602 "unknown reasoning effort"` 拒绝）。
   证据：`scripts/reliability/dsh-acp/evidence/phase5-config-option-set*.json` + 探针
   `scripts/reliability/dsh-acp/acp-config-option.mjs`。据此 `validateAgentPolicy` 从"一律硬拒"
   改为**只放行 WAO 六值闭集 ∩ ACP 广告四档 = `low/high/max`**（无证据支持映射，不发明），
   派发时在 `session/new` 后下发、**响应未确认请求值即 fail-closed 拒绝派发**。
   **遗留缺口**：现有 lane 普遍使用 `effort: max`——`max` 在交集内，可用；`medium`/`xhigh`/`minimal`
   在本 backend 上仍会被拒（非配置错误，是值域事实）。
4. **§3.6 关联面仍为延期**（**Owner 2026-09-20 追认**，会话复用单独立项）：`supportsSessionReuse=false`；
   配了会话复用的 lane（researcher 类）在本 backend 上**派发即拒**；未配复用的 lane 正常。
5. **从未有一次真实 WAO 派发跑过这个 backend**：B-2 是探针直接驱动 `dsh --profile acp`；
   交付的 855 行测试**全部是假进程/假传输**。win32 `.cmd` 路径有真实断言，但**未对真实 `dsh.cmd` 跑过**。
6. **MCP 与 smoke 面未扩**：`src/mcp/server.js` 的 `resolveBackendFor` 与 `src/smoke.js` 未纳入
   新 backend（二者是既有的刻意非工厂构造点）→ MCP `run_continue` 对其按"未知 backend" fail-soft 拒绝；
   `npm run smoke` 不探测新线。
7. ~~**`reportsTokenUsage=true` 但真实 usage 可能为 null**~~ → **已按实测裁定为 `false`**
   （2026-09-20，组件验证 `reportsTokenUsageConsistency` 抓到 `declared=true, input=null`；
   声明口径：表示 WAO 今天能完成什么，不是上游协议具备什么）。因此本 backend 上 tokenBudget 闸门
   收不到输入，只剩 ADR-0030 的观察预算——这是**如实声明**，不是缺陷。
8. **首跑风险**：ACP 未列出的 update 类型按未知类型 fail-closed **整轮失败**（刻意保守）。

### 7.4 回退面
若本裁定日后被推翻，回退集中且可逆：`src/registry.js` 第六成员 + `src/backends/factory.js` 注册
+ `docs/02-architecture.md` 闭集与 §2.5b + `docs/usage.md` 两表 + 4 个钉测试
（`knownBackendsSsot` / `backendCapabilityValidate` / `backendCapabilityMatrix` / `onboarding`）
+ `src/envPolicy.js` / `src/application/backendCliMap.js` / `src/application/modelFamily.js` / `src/application/registryInventory.js` 各一条。纯增量，不动既有成员与 lane。

## Consequences
（待裁定后补：`docs/02-architecture.md` backend 闭集条目与 §2.x 小节、`docs/usage.md` 配置表与能力表、
`src/backends/factory.js` 注册、`npm run gen:surface` 再生成。）
