# 技术架构 Spec

> 状态：✅ 契约层稳定。本文档定义的接口契约 / 数据模型 / 状态机 / 模块边界已由 M0–M8 实现落地并经测试固化。
> **实现进度**见 `docs/roadmap.md`（里程碑状态 + 测试数），**技术债**见 `docs/tech-debt.md`；
> 本文不再维护 per-item 进度标注（旧 `[S]`/`[M]` 标记保留作"阶段归属"参考，不代表"待实现"）。
> 上游：`docs/01-prd.md`（需求）、`docs/research/05-key-decisions.md`（决策）。
> 本文档定义**接口契约、数据模型、状态机、模块边界**，不包含具体算法实现。

---

## 0. 阅读约定

- TypeScript 风格的伪类型用于描述接口，但实现语言是 **JavaScript ESM**（无 TS）。
- `[S]`/`[M]`/`[L]` 标注是**阶段归属**（短期/中期/长期目标），**不代表"待实现"**。M0–M8 已全部落地，这些标记仅保留作"当初规划在哪个阶段"的参考；真实进度看 `docs/roadmap.md`。
- `现状`/`目标` 字段是 spec 初稿时的快照视角，部分已被实现超越——以 roadmap + 代码为准。

---

## 1. 分层总览

```
┌──────────────────────────────────────────────────────────────┐
│ L4 接口层    CLI client · (可选)本地 HTTP API · 事件订阅       │
├──────────────────────────────────────────────────────────────┤
│ L3 编排层    DAG 引擎 · 可插拔节点 · 结构化 handoff            │
├──────────────────────────────────────────────────────────────┤
│ L2 控制平面  RunManager · 状态机 · 调度器 · 隔离 · 恢复        │
├──────────────────────────────────────────────────────────────┤
│ L1 运行时抽象 Backend 接口 · Registry · Transcript            │
└──────────────────────────────────────────────────────────────┘
     横切：scorecard（门控审计）· metrics（可观测）
```

**依赖方向**：上层依赖下层，下层不知道上层。横切层只读 transcript + 发事件，不参与调度决策。

**铁律**：任何层都**不往 agent 的 system prompt 灌指令**。agent 只看到 task prompt。

---

## 2. L1：运行时抽象

> **本章是 "runtime-agnostic" 承诺的技术落点**（定义见 `docs/01-prd.md` §1）。
> 强承诺：编排逻辑（L2/L3）不针对具体 runtime 写分支——同一套 RunManager / 状态机 /
> scorecard / DAG 引擎，对所有 runtime 一视同仁。加新 runtime = 写一个 Backend 类 + parser，
> 编排层一行不改。本章定义的就是这个承诺赖以成立的接口契约。

### 2.1 Backend 接口（核心）

所有 runtime（opencode-serve / claude-code / codex）实现同一接口。
上层只面对这个接口，永远不碰传输细节（HTTP / stdio）。

```js
interface Backend {
  // 建会话 + 投递任务，返回 RunHandle
  spawn(agent: AgentDef, task: TaskInput): Promise<RunHandle>;

  // 拉取历史消息（用于恢复 / collect）
  messages?(serveUrl: string, sessionId: string, opts?): Promise<MessagePage>;

  // 健康检查
  healthCheck?(serveUrl: string): Promise<HealthResult>;
}
```

```js
interface RunHandle {
  sessionId: string;                    // backend 侧会话标识
  messageId?: string;                   // 投递的消息 id（若 backend 支持）
  // 统一消息流：屏蔽 HTTP 轮询 / stdio 流式差异
  events: AsyncIterable<RunEvent>;
  abort(): Promise<void>;               // 停止此会话
}
```

### 2.2 RunEvent（统一事件流）

无论 opencode 的"轮询 /message"还是 claude-code 的"读 stdout"，
在 Backend 实现内部被翻译成**同一个事件序列**。

```js
type RunEvent =
  | { kind: "message", role: "user"|"assistant"|"system", parts: Part[] }
  | { kind: "tool_use", tool: string, input: unknown }
  | { kind: "tool_result", tool: string, output: unknown, isError: boolean }
  | { kind: "command", command: string, exitCode?: number }   // agent 跑的 shell 命令（证据链用）
  | { kind: "file_written", path: string }                     // agent 写文件（证据链用）
  | { kind: "metrics", tokens?: TokenUsage, durationMs?: number }
  | { kind: "done", reason: "completed"|"aborted"|"failed", error?: string };
```

```js
interface Part {
  type: "text";
  text: string;
}
interface TokenUsage { input?: number; output?: number; reasoning?: number; }
interface MessagePage { data: Message[]; cursor: { previous: string|null; next: string|null }; }
interface HealthResult { ok: boolean; status?: number; error?: string; }
```

**关键**：`command` / `file_written` / `tool_result` 这几个事件是 scorecard 证据链的来源。
Backend 实现有责任从 runtime 的原始输出里**提取**这些结构化证据（而非原样透传文本）。

### 2.3 AgentDef（registry 条目规范化后）

```js
interface AgentDef {
  id: string;
  backend: "opencode-serve" | "claude-code" | "codex" | "kimi-code";   // 可扩展
  cwd: string;
  // backend 特定字段
  serveUrl?: string;               // opencode-serve 必填
  agent?: string;                  // opencode-serve 的 agent 名（如 "build"）
  model?: { providerID: string; id: string; variant?: string };  // opencode-serve 必填
  // 进程式 backend 字段（claude-code / codex）
  binary?: string;                 // 可执行文件路径或名
  args?: string[];                 // 额外启动参数
}
```

**现状**：`registry.js` 已实现 `normalizeAgent`，校验 opencode-serve 字段。
**目标 `[S]`**：扩展校验逻辑支持进程式 backend 字段；`getAgent(id, overrides)` 保持不变。

### 2.4 Backend 工厂

```js
function backendFor(agent: AgentDef): Backend {
  switch (agent.backend) {
    case "opencode-serve": return new OpenCodeServeBackend();
    case "claude-code":    return new ProcessBackend({ ... });
    case "codex":          return new ProcessBackend({ ... });
  }
}
```

**现状**：`cli.js` 的 `backendFor` 已有 switch，但只认 opencode-serve。
**目标 `[S]`**：加 `ProcessBackend`（§2.5）。

### 2.5 ProcessBackend（进程式 runtime）`[S]`

驱动 claude-code / codex 这类"一个进程 = 一次会话、stdout 流式产出"的 runtime。

```js
class ProcessBackend implements Backend {
  constructor({ binary, args, parser }) { ... }
  async spawn(agent, task): Promise<RunHandle> {
    // 1. 启动子进程：spawn(binary, [...args, ...buildPromptArgs(task.prompt)], { cwd: agent.cwd })
    // 2. 用 parser 把 stdout/stderr 流翻译成 RunEvent
    // 3. 用 Windows Job Object 绑定：父进程终止则子进程全杀（§4.3）
    // 4. 返回 RunHandle，events 来自 parser 的输出流
  }
}
```

**parser** 是 ProcessBackend 的核心差异点：不同 runtime 的 stdout 格式不同。
- claude-code：解析其流式输出协议（待实测确认格式）
- codex：解析其输出格式（待实测）

**parser 契约**：
```js
interface StreamParser {
  feed(chunk: Buffer|string): RunEvent[];   // 喂入 stdout chunk，吐出解析出的事件
  flush(): RunEvent[];                        // 流结束时收尾
}
```

**未知风险 ❓**：claude-code / codex 的流式输出格式需要实测确认。
若格式不稳定或不结构化，parser 要做容错（提取不到 tool_use 就只产 message 事件，
不让整个 run 失败——降级而非崩溃）。

`EventQueue` must drain events that arrived while the consumer was paused before honoring `closed`. A fast child may emit `message` + `done` and exit while RunManager is awaiting transcript I/O; `done` cannot be skipped merely because the queue is already closed.

**Worker environment and output boundary (TD-104)**:
- Process workers do not inherit `process.env` wholesale. The backend copies a fixed OS/runtime allowlist, the credential channel assigned to that backend, non-secret `agent.env`, and WAO control variables.
- Secret-like names are forbidden in `agent.env`; registry configuration names an inherited credential channel instead of storing credential values.
- Values from explicitly assigned credential channels are redacted regardless of channel name. Values of at least eight characters from credential-like environment names (including proxy URLs) are also exact-match redacted before parsed events enter RunManager memory, before JSONL persistence, and in raw-capture/stdout/stderr diagnostic sinks. Raw capture uses a UTF-8 streaming redactor, so a value split across chunks or code-point bytes is still removed.
- This is exposure minimization, not a strong secret boundary. A worker under the same OS identity can still inspect its assigned runtime credential or credential files. Strong isolation requires the broker/identity boundary recorded in decision 0015 and TD-104.

### 2.6 现有 OpenCodeServeBackend 的迁移 `[S]`

**现状**：`spawn` 返回 `{ backend, backendSessionId, messageId, admittedSeq }`，
`waitForCompletion` 用轮询实现。
**目标**：保持 `spawn` 签名不变，但让它返回的 `RunHandle.events` 是一个**AsyncIterable**，
内部用轮询 `/message` 填充。`waitForCompletion` 改为 `events` 流的消费者（而非独立方法）。

迁移路径（保持向后兼容）：
1. 新增 `OpenCodeServeBackend.streamEvents(serveUrl, sessionId)` → AsyncIterable
2. `spawn` 返回的 handle 挂上 `events`
3. `waitForCompletion` 内部改为 `for await (const ev of handle.events)` 直到 `done`

---

## 3. Transcript（数据持久化）

### 3.1 事件结构（现状扩展）

```js
interface TranscriptEvent {
  ts: string;            // ISO timestamp
  runId: string;
  agentId: string;
  type: string;          // 见下表
  seq?: number;          // [S新增] 单调递增序号，便于恢复时定位
  ...payload;
}
```

### 3.2 事件类型清单

| type | 何时写 | 阶段 |
|------|--------|------|
| `run.started` | run 创建 | ✅ 现有 |
| `session.created` | backend.spawn 返回 sessionId | ✅ 现有 |
| `prompt.sent` | prompt 投递 | ✅ 现有 |
| `run.submitted` | 投递完成，进入等待 | ✅ 现有 |
| **`run.state_change`** | 状态机每次转移 | `[S]` 新增 |
| **`run.event`** | 从 RunEvent 流透传一条（message/tool_use/command/...） | `[S]` 新增 |
| `run.completed` | 正常完成 | ✅ 现有 |
| `run.timed_out` | 超时 | ✅ 现有 |
| `run.aborted` | 被 abort | ✅ 现有 |
| `run.error` | 错误 | ✅ 现有 |
| `run.stop_requested` | 用户请求停止 | ✅ 现有 |
| **`run.state_change_rejected`** | TD-99：终态仲裁拒绝一次迟到转移（含 attemptedTo/attemptedReason/existingTerminal/reason="first_terminal_wins"） | `[S]` 新增 |
| **`run.delivery_created`** | TD-103 Phase 3A：delivery 打包成功——`delivery` 含完整 DeliveryRef（deliveryCommit/baseCommit/branch/changedFiles/verification/acceptance/integration） | Phase 3A |
| **`run.delivery_failed`** | TD-103 Phase 3A：delivery 打包失败——`deliveryCode`（empty_diff/disallowed_path/commit_integrity/delivery_error 等）+ `message`（脱敏摘要） | Phase 3A |
| **`run.delivery_verification_passed`** | TD-103 Phase 3B：delivery 验证通过——`delivery.verification.status:"passed"`，含 verifiedCommit/results | Phase 3B |
| **`run.delivery_verification_failed`** | TD-103 Phase 3B：delivery 验证失败——`delivery.verification.status:"failed"`，含 failureCode/command_failed/command_timeout/artifact_mutated/execution_error | Phase 3B |
| **`run.delivery_verification_unavailable`** | TD-103 Phase 3B：无验证命令——`delivery.verification.status:"unavailable"`，含 unavailableReason | Phase 3B |
| `messages.collected` | collect 命令 | ✅ 现有 |
| **`scorecard.checked`** | scorecard 审计一次 | `[M]` |
| **`workflow.*`** | DAG 节点级事件 | `[M]` |
| **`run.message`** | scorecard requireAssistantText 检查用的 message 快照（role+parts，非落盘事件，仅传给 scorecard） | post-M6 |

**关键 `[S]` 变更**：
- `run.state_change` 让状态机**显式化**（替代当前靠"最后事件 type"推断）。
- `run.event` 透传 RunEvent 流，让 transcript 成为**完整的事实来源**——
  恢复、scorecard、metrics 全部从这些事件重建，不依赖内存。
- Transcript envelope fields (`ts`, `seq`, `runId`, `agentId`, `type`) are authoritative and cannot be overridden by payload fields. Payloads, transition batches, and transition reasons pass through the same secret redactor before append.

### 3.3 Transcript API（现状基本不变）

```js
class JsonlTranscript {
  constructor(filePath, context: { runId, agentId }) {}
  async append(type, payload?): Promise<TranscriptEvent>   // 自动加 ts + seq
  // [S新增] 批量重放恢复时用
}
async function readTranscript(filePath): Promise<TranscriptEvent[]>
function findLatest(events, type): TranscriptEvent | undefined
// [S新增]
function findState(events): RunState        // 从事件序列推算当前状态
function findLastEventSeq(events): number   // 恢复时定位续读点
```

---

## 4. L2：控制平面

### 4.1 状态机 `[S]`

```
            ┌──────────┐
            │ pending  │  run 已创建，backend.spawn 尚未调用
            └────┬─────┘
                 │ spawn() 调用
                 ↓
            ┌──────────┐
            │submitted │  spawn 返回 sessionId
            └────┬─────┘
                 │ 首个 message/tool 事件
                 ↓
            ┌──────────┐     abort()     ┌─────────┐
     ┌─────→│ running  │───────────────→ │ aborted │
     │      └─┬──┬──┬──┘                  └─────────┘
     │        │  │  │ timeout             ┌─────────┐
     │        │  │  └───────────────────→│timed_out│
     │        │  │ error                  └─────────┘
     │        │  └──────────────────────→┌─────────┐
     │        │                          │ failed  │
     │        ↓ done                     └─────────┘
     │  ┌──────────┐
     └──┤completed │  retry 时回到 pending
        └──────────┘
```

```js
type RunState =
  | "pending" | "submitted" | "running"
  | "completed" | "failed" | "aborted" | "timed_out";
```

**转移规则（代码判定，绝不依赖 LLM）**：
- `pending→submitted`：`backend.spawn` 成功返回
- `submitted→running`：收到首个 `message` 事件（C5 对齐，2026-06-24）。⚠️ 实现上只有 `message` 触发 running，`tool_use`/`command`/`file_written` 等证据事件只落 `run.event` 不触发状态转移——这样语义更清晰（"running"= 已开始生成文本回复，而非"调了工具"）。一个只调工具不给文本的 worker 会等到首条 message 才进 running，证据事件仍记录在 transcript 可追溯。
- `running→completed`：收到 `done` 事件且 `reason==="completed"` **且 scorecard 通过**（`[M]` 起；`[S]` 无 scorecard，直接 completed）。**M8-1 起 scorecard 默认 warn**：无显式 rules 时默认 `requireEvidence:warn`，不通过仅记 `scorecard.warn` 不转 failed（仍 completed）；`--scorecard-mode hard` 升级硬闸、`off` 关闭。
- `running→failed`：收到 `done` 且 `reason==="failed"`，或 scorecard 不通过（hard 模式）
- `running→timed_out`：`waitTimeout` 到
- `running→aborted`：`abort()` 调用

**每次转移写 `run.state_change` 事件**，含 `{ from, to, reason }`。

**TD-99 跨进程终态仲裁**：状态转移经 `JsonlTranscript.transitionState` 在已有 append lock 内
原子完成（读事件 → 检查既有终态 → 分配 seq → 批量 append）。规则 = **first terminal wins**：
一旦 transcript 中已有终态（terminal `run.state_change`，或旧 transcript 的 legacy terminal fact），
任何后续转移（含 `running`/`submitted` 复活）被拒绝，写 `run.state_change_rejected` 审计事件
（不静默消失）。RunManager 决定合法转移（状态机策略）；Transcript 只负责跨进程原子提交和终态
不可逆，不把完整状态机策略下沉到 L1。这解决了 owner 进程（`waitForCompletion` 写 failed/completed）
与短命 CLI 进程（`stop` 写 aborted）之间的终态覆盖竞态。

**TD-100 stop 副作用所有权**：`stop` 命令先 `transitionState` claim `aborted`，只有 accepted winner
才执行破坏性副作用（taskkill / backend.abort）。rejected loser 零副作用。
`run.stop_requested` 不再 claim 前单独 append，而是通过 `transitionState` 的 `attemptEvents` 同批提交
（accepted: stop_requested → run.aborted{verification:"pending"} → state_change；rejected:
stop_requested → state_change_rejected）——持锁读取的旧 events 不含本次 attemptEvents，不自拒绝。
winner 执行 kill/abort 后追加 `run.stop_verified`（进程已死）或 `run.stop_unverified`（进程可能仍活 + raiseAlert）。
`verified` 以后置 PID 存活检查为准——taskkill exitCode=0 不单独产生 verified=true（PID 可能复用/僵尸）。
PID 存活判定：`isPidAlive` 仅在 `ESRCH`（进程不存在）时返回 false；`EPERM`/未知错误保守返回 true
（不得假验证）。taskkill 后执行有界轮询（`waitForPidExit`，默认 5 轮 × 200ms，可注入）补偿 Windows
PID 回收延迟，轮询耗尽仍 alive → unverified + raiseAlert。`run.stop_verified`/`run.stop_unverified`
均写 `outcome`/`taskkillCalled`/`taskkillExitCode`/`processAliveBefore`/`processAliveAfter`（进程路径）
或 `backend`/`method`/`taskkillCalled`（opencode 路径），transcript 可重建"为何 verified"。
`run.stop_requested` 含 `reason:"user"`（修复 diagnosis 显示 reason=unknown）。
**无效 PID 边界**：`stop` 命令在 claim 前验证 process session PID（`Number.isInteger(pid) && pid > 0`）。
无效 PID（`proc_not-a-number` / `proc_0` / `proc_-1`）不进入 `processStop`，不 claim 终态，不 taskkill，
保持 run 原状态。记录 `stop_requested` + `stop_unverified{outcome:"invalid_pid"}` + raiseAlert。
CLI 输出 `stopped:false / outcome:"invalid_pid" / terminalAccepted:false / terminalState:<原状态>`。
这把"metadata 损坏（backendSessionId 格式异常）"与"进程已退出（already_exited/verified）"区分开。
`isPidAlive` 的探测函数可注入（`isPidAlive(pid, probe=process.kill)`），测试用注入 probe 模拟
ESRCH/EPERM/未知错误，不依赖真实 PID 环境。

### 4.2 RunManager `[S]`

替代当前 `cli.js` 里散落的 `activeSessions` 数组 + `doSpawn`/`doWait` 逻辑。

```js
class RunManager {
  constructor({ config, transcript, backendFor }) {}

  // 创建并启动一个 run
  async start(agentId, { prompt, cwd, tags }): Promise<Run> {
    // 1. readRegistry → normalizeAgent
    // 2. 建 transcript（runId 生成）
    // 3. append run.started + state_change(pending)
    // 4. backend.spawn → append session.created + state_change(submitted)
    // 5. 注册到 activeRuns
    // 6. 启动事件消费循环（见下）
    // 7. return Run（含 abort、waitForCompletion）
  }

  // 恢复一个已有 run（基于 transcript）
  async resume(runId): Promise<Run | null> {
    // 1. readTranscript(runId)
    // 2. findState → 若已终态，返回 null（无需恢复）
    // 3. 若 running/submitted：重新 attach backend（若 sessionId 还活）
    //    或重放 prompt（若 session 已失效）
    // 4. 续接事件消费循环
  }

  async abort(runId): Promise<void>
  list(): Run[]
}
```

```js
interface Run {
  runId: string;
  agentId: string;
  state: RunState;
  transcript: JsonlTranscript;
  waitForCompletion(opts): Promise<WaitResult>;
  abort(): Promise<void>;
}
```

**事件消费循环（`start` 内部启动，不阻塞调用方）**：
```
for await (const ev of handle.events):
  transcript.append("run.event", ev)      // 透传到 transcript
  if ev 是 message/tool_use 且 state===submitted:
    state → running
  if ev.kind === "done":
    根据 reason 转到终态
  if ev.kind === "command":
    记录证据（供 scorecard 用）
```

### 4.3 隔离 `[S]`

| 维度 | 机制 |
|------|------|
| 文件 | git worktree（每个 run 独立 worktree，run 结束可保留或清理） |
| 进程 | 复用 Node 内置 Job Object（v22，被动 OS 级：父进程终止→子进程全杀）+ `taskkill /T /F` 主动 abort（TD-40，见 ADR 0013） |
| 网络 | 端口分配表：RunManager 给每个 run 分配端口段，避免 Niuma 式冲突 |

**cleanup 钩子（确定性，即使失败也执行）**：
```
run 终态时：
  - 若进程式 backend：确认子进程已退出（Node 内置 Job Object 被动兜底 + taskkill /T/F 主动，见 TD-40/ADR 0013）
  - 若 worktree 配置为临时：清理 worktree
  - 释放端口段
  - append run.cleanup_done
```

**Worktree 策略**（config 可选）：
- `persistent`（默认）：worktree 保留，便于事后检查产出
- `ephemeral`：run 结束清理

### 4.4 调度 / 限并发 `[未实现]`

> **现状**：未实现独立调度器（无 `src/scheduler.js`）。M0–M6 的"并行"靠
> RunManager 直接并行 `spawn` 多个 run，**没有显式信号量/限并发/优先级队列**。
> 下面的接口是设计预留，等真正需要限并发时落代码（登记为 TD-5，见 `docs/tech-debt.md`）。

```js
interface SchedulerOpts { maxConcurrent: number; }
```
- RunManager 维护一个**信号量**（简单计数）。
- `start` 超过 `maxConcurrent` 时，run 进入 `pending` 排队，等空位。
- `[M]` 加优先级队列；`[S]` 先到先服务即可。

### 4.5 daemon vs 可重入单进程

**短期 `[S]`**：可重入单进程。每次 CLI 调用读 transcript 恢复 `RunManager` 状态，
`spawn --wait` 进程存活期间持有活跃 run，Ctrl+C 时 abort（现有 SIGINT 逻辑保留）。
后台 run（`spawn` 不带 `--wait`）靠 detached 子进程或 nohup 式机制存活——**待实测 Windows 上的可行性 ❓**。

**中期 `[M]`**：持久 daemon + IPC（命名管道或本地 HTTP）。CLI 变 daemon 客户端。

### 4.6 Coder Delivery Contract v1 `[Phase 2]`

> **实现状态**：TD-103 Phase 2 core complete（inspection + packaging deep module）。
> Phase 3A（RunManager 集成、transcript 事件）complete，Phase 3B（exact-artifact verification）complete。
> 项目当前进度只见 `docs/roadmap.md`；监督式 Phase 3C 的凭据边界见 decision 0016，强隔离发布边界仍见 decision 0015。

控制平面（而非 worker）负责把 isolated worktree 里的 worker 产出打包成 atomic delivery commit。
worker 只准备变更，不创建 commit。

**模块边界**：`src/delivery.js` 是 deep module，只依赖 Node built-ins，不 import CLI / RunManager /
workflow / transcript / backend / role 模块。Git 通过 `execFileSync("git", args)` 结构化参数调用，
**禁止 shell-built command string**。

**API（v1）**：

```js
inspectDelivery(input) -> proposed DeliveryRef   // read-only, fail-closed
packageDelivery(input) -> committed DeliveryRef  // re-inspect + stage + one commit
```

**DeliveryRef v1**：

```jsonc
{
  "schemaVersion": 1,
  "kind": "git_commit",
  "runId": "run_...",
  "baseCommit": "<full hash>",
  "deliveryCommit": null,          // null = proposed; full hash after packaging
  "branch": "wao/run_...",
  "worktreePath": "<resolved path>",
  "changedFiles": ["repo/relative/path"],  // unique, lexically sorted
  "verification": {
    "status": "pending",           // pending | passed | failed
    "commands": [],                // or "unavailableReason" when no verification
    "unavailableReason": "..."     // (optional) present only when commands is empty
  },
  "acceptance": {
    "status": "pending",           // pending | accepted | rejected
    "reviewerType": "lead_agent"
  },
  "integration": {
    "status": "pending",           // pending | integrated
    "targetCommit": null
  }
}
```

**Packaging ownership**：worker 不创建 delivery commit。`packageDelivery` 重新 inspect 后只 stage
inspected 授权路径（`git add -A -- <changedFiles...>`），然后用 Git **plumbing** 命令创建 commit：
`git write-tree` 捕获 staged index tree → `git commit-tree <tree> -p <baseCommit>` 创建 commit object
（message 通过 stdin 传入，author/committer identity 通过子进程 env 传入
`WAO Delivery <wao-delivery@local>`）→ `git update-ref refs/heads/<branch> <candidate> <baseCommit>`
原子 CAS 更新 branch ref（expected-old-value 保护防并发）。

**Hooks 不参与机械打包**：`commit-tree` + `update-ref` 是 plumbing 命令，**不执行任何 repository hooks**
（pre-commit / prepare-commit-msg / commit-msg / post-commit 均不运行）。
Git hooks 属于项目验证策略，未来由 `DeliveryRef.verification.commands` 显式执行；
机械 packager 必须确定性地把已检查的 index tree 变成 commit，不受项目 hook 配置影响。
不修改 repo-local/global git config；GPG signing 不适用（plumbing 路径不走 signing）。

**Post-commit integrity gate**：`update-ref` 后统一验证八项不变量——(1) HEAD === candidateCommit，
(2) parent = baseCommit，(3) `baseCommit..HEAD` 恰好 1 个 commit，(4) `HEAD^{tree}` === write-tree 输出，
(5) committed files = inspected changedFiles（精确集合等价），(6) commit message 精确为
`wao-delivery: <runId>`，(7) author/committer 精确为 WAO process identity，
(8) worktree 干净（`git status --porcelain=v1 -z --untracked-files=all` 为空）。
ignored 文件不出现不影响成功。只有全通过才返回 DeliveryRef。

**Packaging failure cleanup**：三类失败路径：
- **staging mismatch**：`git reset -q --` 恢复 index 到 base，保留 working-tree；验证 HEAD 在 base、index 为空。
- **commit-tree / update-ref CAS 失败**：`git reset -q --` 恢复 index（branch 未移动——CAS 保护），
  保留 working-tree；验证 HEAD 在 base、index 为空。candidate object 不可达但不影响 branch。
- **post-update-ref integrity 失败**：`git reset --mixed -q --end-of-options <canonicalBase>` 把 branch
  HEAD 移回 base（不用 `--hard`、不用 `clean`），保留所有 working-tree 文件内容，然后重新验证
  HEAD === baseCommit 且 cached diff 为空。只有验证成功才声称 restored。
  rollback 本身失败时抛 `deliveryCode=cleanup_failed`（保留原始失败类别/摘要，不吞错误、不虚报恢复）。

重复 packaging（HEAD 已在 delivery commit）被 base mismatch 拦截，不创建第二个 commit。

**Fail-closed**（inspection + packaging 均适用）：empty diff、dirty base（pre-staged changes）、
disallowed path（不在 allowedPaths 或 path-segment boundary 越界）、non-Git path、primary checkout
（非 linked worktree）、detached HEAD、wrong branch、base commit mismatch、ephemeral/non-persistent
isolation、invalid runId（ref 注入/路径遍历）、invalid allowedPaths（含空 segment/尾分隔符/重复分隔符）、
invalid baseCommit（`--` 开头 option 注入）、whitespace-only verification — 均拒绝，不静默改写。

**生命周期**（Phase 3 实现，Phase 2 不发 transcript 事件）：
```
worker output → delivery_created → verification_passed|failed → lead_accepted|rejected → integrated
```
worker 进程完成 ≠ code delivery 完成。

### 4.7 Run delivery mode 集成 `[Phase 3A]`

> **实现状态**：TD-103 Phase 3A complete。Run delivery mode 已接入 RunManager 生命周期。
> Phase 3B（exact-artifact verification）complete——见 §4.8。

**RunManager.start() option**：

```js
delivery: {
  mode: "git_commit_v1",             // 目前唯一支持的模式
  allowedPaths: ["src", "test/"],     // SSOT 验证同 src/delivery.js
  verificationCommands: ["npm test"]  // OR verificationUnavailableReason: "..."
}
```

`delivery` absent：字节级兼容现有行为，无 delivery Git 调用或事件。
`delivery` present：`mode` 必须为 `git_commit_v1`，要求 `{type:"worktree", strategy:"persistent"}` 隔离。
worktree 创建前用 `prepareDeliveryRequest()` 验证（SSOT 在 `src/delivery.js`）。
worktree 创建后、backend spawn 前捕获 base commit（full hash）。
`run.started` 扩展 `delivery: {mode, baseCommit, allowedPaths, verificationCommands|verificationUnavailableReason}`。
`resume()` 从 `run.started.delivery` 重建 deliveryContext。

**Packaging 时序**（`waitForCompletion` completed 路径内）：

```text
backend done:completed
  → scorecard (existing)
  → hard scorecard failed: existing failed path, no package
  → re-check external terminal
  → if terminal exists: loser result, no package
  → packageDelivery(deliveryContext)     // plumbing path, no hooks
     → success: transition completed with factEvents [delivery_created + run.completed]
     → failure: transition failed with factEvents [delivery_failed + run.error phase=delivery]
  → transition accepted: return success/failure contract
  → transition rejected (race): return existing terminal + delivery/deliveryError fact
```

**Terminal arbitration**（复用 TD-99 `transitionState`）：
- 成功：`run.delivery_created` + `run.completed` 作为 `factEvents` 在 accepted completed transition 中同批写入。
- 失败：`run.delivery_failed` + `run.error{phase:"delivery"}` 作为 `factEvents` 在 accepted failed transition 中同批写入。
- Race（external terminal 在 packaging 期间先赢）：`run.delivery_created`/`run.delivery_failed` 作为 `attemptEvents` 在 transitionState 仲裁批次中同批写入（自 `87bf1e3` 起），返回 loser result 含 `delivery`/`deliveryError`。不回滚已创建的 DeliveryRef（它是 isolated recoverable artifact）。

**`waitForCompletion` result contract**：
- Every non-throw terminal result carries consistent booleans: `completed`, `failed`, `aborted`, and `timedOut`; exactly one matches the terminal state.
- 成功：`{completed:true, failed:false, aborted:false, timedOut:false, messages, evidence, metrics, delivery}` — `delivery` 是完整 DeliveryRef。
- 打包失败：`{completed:false, failed:true, aborted:false, timedOut:false, messages, evidence, metrics, deliveryError:{code, message}}` — 结构化非抛出。
- timeout/budget/abort/hard scorecard fail return the same structured terminal shape and do not call the packager. An accepted backend failure remains the exception path and throws after persisting `run.error` + terminal `failed`.
- The RunManager wait timer owns timeout causality: if its abort causes a process to exit non-zero and emit `done(failed)`, the terminal/result remains `timed_out`, not `backend_error`.

**事件排序**：
- 成功：`scorecard.checked`（如有）→ `run.delivery_created` → `run.completed` → `run.state_change completed`（seq 连续）。
- 打包失败：`run.delivery_failed` → `run.error phase=delivery` → `run.state_change failed`（seq 连续）。

`packageDeliveryFn` 构造函数参数（默认 `packageDelivery`）仅供测试/组合注入，非通用 service container。

### 4.8 Delivery Verification 集成 `[Phase 3B]`

> **实现状态**：TD-103 Phase 3B complete。exact-artifact deterministic verification 已接入 RunManager。

**两个独立维度**：

Run terminal state（`completed`/`failed`/`timed_out`/`aborted`）和 delivery verification status（`passed`/`failed`/`unavailable`）是**两个正交维度**，不互相覆盖：

- `run.completed` = worker lifecycle done（backend exited cleanly）。
- verification `failed` = verification commands failed or artifact mutated。
- verification 可以在 `run.completed` 之后 fail，**不改变** run terminal state。

**生命周期时序**（`waitForCompletion` 成功路径内，packaging 之后）：

```text
packageDelivery success → transitionState(completed)
  → run.delivery_created + run.completed (factEvents, atomic batch)
  → run.state_change completed
  → _runCleanup() (session abort; persistent worktree 不删)
  → _verifyDeliveryResult(deliveryRef)
     → verifyDelivery(deliveryRef)    // exact-artifact proof + commands
     → transcript.append(verification_passed|failed|unavailable)
  → return {completed:true, delivery:verifiedRef, verificationFailed?, verificationUnavailable?}
```

**Verification 的 proof 纪律**（`src/deliveryVerification.js`）：

1. **所有结果前先 proof**：passed/failed/unavailable 任何结果产生前，都必须先调 `assertCommittedDeliveryRef(deliveryRef)`。unavailable 路径（零 command）也不例外——脏/伪造的 worktree 必须被 `artifact_mismatch` 挡住。
2. **每命令后 re-proof**：每个 attempted command 结束后（exit 0、非零、timeout、launch error），都先重新执行完整 proof，再分类命令结果。
3. **artifact_mutated 优先**：若命令同时失败并造成 artifact mutation，`artifact_mutated` 优先于 `command_failed`/`command_timeout`/`execution_error`。
4. **不 reset/clean**：verification 不修改被命令改动的 worktree 状态（proof 是只读的）。

**Transcript 原子可信语义**（`Run._verifyDeliveryResult`）：

并发控制（`_verificationComputePromise` / `_verificationAppendPromise` 合并 in-flight Promise）：

- verifier 计算通过共享 `_verificationComputePromise` 合并——任意数量并发调用只执行 verifier 一次。Promise 创建一次，所有 caller await 同一实例。
- outcome append 通过共享 `_verificationAppendPromise` 合并——任意数量并发调用最多成功 append 一个 outcome event。
- append 失败时，所有等待者收到同一个错误；`_verificationAppendPromise` 清空以允许显式重试。
- 重试 append 不得重跑 verifier（使用已缓存的 `_pendingVerificationResult`）。
- append 成功后 `_verificationRecorded=true`，后续调用幂等返回 `_recordedVerificationResult`。
- 不重新引入"未落盘却返回 pass"的 fallback。

错误分类（`_computeVerification`，strict `instanceof DeliveryError` 识别）：

- `DeliveryError`（artifact_mismatch 等已知 proof 失败）→ 转换为 verification failed result，
  **保留原 failureCode**（不降级为 execution_error，不原样抛给 waitForCompletion）。
  生成 `{delivery: {...ref, verification:{status:"failed", failureCode, verifiedCommit, results:[]}},
  outcome:"failed", failureCode}`，由 `_verificationAppendPromise` 写入唯一
  `run.delivery_verification_failed` event。waitForCompletion 返回 `completed:true +
  verificationFailed:true`，run terminal 保持 completed。
- 只有未知 verifier 内部异常映射为 `execution_error` result（不 re-throw）。
- **只有 transcript outcome append 失败才向调用者传播异常**——这是唯一的异常传播路径。
- 不泄露原始 error.message/stack/stderr/secret。
- strict `instanceof DeliveryError` 识别——不接受伪造的 `{name:"DeliveryError"}` 对象。

**身份 SSOT**（`src/delivery.js`）：

`assertDeliveryIdentity(cwd, deliveryCode)` 是 author + committer 身份检查的单一 SSOT，由 `verifyPostCommitIntegrity`（packaging，`commit_integrity`）和 `assertCommittedDeliveryRef`（verification proof，`artifact_mismatch`）共用。

`verifyDeliveryFn` 构造函数参数（默认 `verifyDelivery`）仅供测试/组合注入。HTTP resume 创建 Run 时同样传入（自 closeout 起，不再遗漏）。

### 4.9 Lead Acceptance Record `[Phase 3C-2]`

> **实现状态**：TD-103 Phase 3C-2 complete。`runs delivery` 命令已接入 CLI，
> transcript-backed 原子 first-decision-wins 语义已实现。
> Phase 3C coder-first template 和真实 dogfood 待 CTO 审计后做。

**公开 CLI**：

```text
runs delivery <runId> [--format json]                                    # 只读查询
runs delivery <runId> --accept --reason-file FILE [--format json]       # Lead 接受
runs delivery <runId> --reject --reason-file FILE [--format json]       # Lead 拒绝
```

**只读查询**返回从 transcript 事件重建的结构化视图：runId、终态、最新 DeliveryRef、
verification 状态/failureCode、acceptance 状态及已有决策事件（如有）。Transcript 是 SSOT，
不创建额外 current-state 文件。

**决策前置条件**：
- 必须存在 exactly one committed delivery（有 `run.delivery_created` + verification event）。
- `--accept` 和 `--reject` 互斥。
- `--reason-file` 必须是非空 UTF-8 文件（不支持 inline reason，避免 PowerShell quoting drift）。
- `--accept` 要求 run terminal `completed` + verification `passed`。
- `--reject` 允许 passed/failed/unavailable verification，但仍要求 committed delivery。
- 不执行 merge/reset/checkout/cherry-pick/push/branch deletion/worktree deletion/Git mutation。

**事件**：append exactly one of `run.delivery_accepted` / `run.delivery_rejected`。
事件含新 DeliveryRef（acceptance.status 变为 accepted/rejected，其余字段不变）+
`deliveryCommit` + `reviewerType:"lead_agent"` + trimmed reason。
不重写已有 `run.delivery_created` 或 verification 事件。

**原子 first-decision-wins**（`JsonlTranscript.tryAppendDecision`）：
在已有 cross-process append lock 内完成：读事件 → 检查同一 `deliveryCommit` 的已有
accepted/rejected event → append at most one decision event → 返回 `{accepted:true,event}`
给 winner 或 `{accepted:false,existing}` 给 loser。此原语窄，不泛化为 workflow engine。
append 失败原样传播；不在 durable transcript write 前 report acceptance。
CLI JSON 区分 `decisionAccepted:true`（winner）vs `decisionAccepted:false` + existing（loser）。

---

## 5. L3：编排层 `[M]`

> 短期不实现，但 L1/L2 的设计必须为它留好接口。

### 5.1 DAG 数据模型

```js
interface WorkflowDef {
  id: string;
  nodes: NodeDef[];
  edges: EdgeDef[];
}
interface NodeDef {
  id: string;
  type: "agent" | "router" | "gate" | "custom";   // 可扩展
  agentId?: string;            // type=agent 时必填
  // 节点完成后产出的 handoff 结构定义（供下游校验）
  outputSchema?: HandoffSchema;
}
interface EdgeDef {
  from: string;                // 源节点
  to: string;                  // 目标节点
  // 关键：区分两类依赖
  dataEdge?: boolean;          // true=非执行依赖（to 不等 from 完成，仅用于 upstream 引用/handoff）
  // 默认（dataEdge=false 或省略）= 执行依赖：to 必须等 from 完成
  condition?: string;          // 条件表达式（可选，用于 router/分支）
}
```

**依赖语义**（C4 对齐，2026-06-24）：
- `dataEdge: true` 表示**非执行依赖**——engine 拓扑排序时不把它算入执行依赖（to 不等 from 完成），`buildUpstreamContext` 仍会把 from 的产出作为 upstream 引用传给 to。
- ⚠️ **当前实现不含"数据就绪事件"或流式 handoff**——dataEdge 只是"不算执行依赖"，不是"数据可用后即启动"（Niuma 式的 artifact_ready 事件未实现）。文档此前承诺的"data 到后但未完成时启动"比实现更强，已修正为实际语义。
- 长期若要真正的数据依赖（partial output + artifact_ready 事件），需扩展 engine——当前留作未来增强，登记在 tech-debt。
- **执行依赖**（默认）：`to` 等 `from` **完成**才启动。
- **数据依赖**（`dataEdge: true`）：`to` 在 `from` 的产出**可用**后即可启动，
  但若 `to` 另有执行依赖，则仍受其约束。
- 例：`Coder --dataEdge--> QualityGate` 且 `Tester --execEdge--> QualityGate`：
  QualityGate 收到 Coder 数据后仍要等 Tester 完成。

### 5.2 结构化 handoff

```js
interface Handoff {
  from: string;                // 源节点 id
  to: string;                  // 目标节点 id
  // 不传内容，传引用（Anthropic 经验，防 token 爆炸）
  artifacts: { kind: "file"|"runId"|"path", ref: string }[];
  // 结构化声明（供 scorecard 校验）
  claims: { field: string; value: string; evidence: string }[];
}
interface HandoffSchema {
  requiredFields: string[];    // handoff.claims 必须含的字段
}
```

**校验**：编排引擎在 handoff 传递时，用 `outputSchema.requiredFields` 检查 `claims` 字段完整性。
缺字段 → 打回，不传给下游。

### 5.3 YAML schema（配置即行为）

```yaml
# workflow.yaml
id: refactor-module
nodes:
  - id: analyze
    type: agent
    agentId: researcher
    outputSchema:
      requiredFields: [summary, affectedFiles]
  - id: code
    type: agent
    agentId: coder_low
  - id: test
    type: agent
    agentId: tester
  - id: gate
    type: gate
edges:
  - { from: analyze, to: code }
  - { from: code, to: test }
  - { from: code, to: gate, dataEdge: true }
  - { from: test, to: gate }          # gate 必须等 test 完成（执行依赖）
```

**分层字段**（对应 05 D6，但裁剪到我们的约束）：
- 图拓扑：nodes + edges
- Agent 定义：agentId（引用 registry）
- 模型 profile：在 registry agent 定义里，不在 workflow 里重复
- 环境：cwd + worktree 策略（registry agent 定义里）
- 安全：保持简单（cwd 边界即可，不做复杂权限）

**配置即行为**：YAML 是系统行为。改 YAML → 所有未来 run 用新定义。

### 5.4 可插拔节点

```js
// 内置节点处理器
const nodeHandlers = {
  agent:      (node, ctx) => runManager.start(node.agentId, ...),
  router:     (node, ctx) => evaluateRouting(node, ctx),   // 可由 LLM 驱动
  gate:       (node, ctx) => scorecard.check(ctx),
  integrator: (node, ctx) => collectAndDedup(ctx.upstream), // M8-5: 拼初稿(不改判质量)
};
// 用户注册自定义
registry.registerNodeType("my-custom", MyHandler);
```

`gate.requiredClaims` uses `"nodeId.field"` to require one predecessor field; a bare `"field"` searches all predecessors. This format is part of the workflow contract, not a Lead prompt convention.

**LLM 编排器 `[L]`**：作为一种 `router` 节点实现，或作为独立的策略层客户端调用 L2 原语。
它是**可插拔策略的一等公民**，但不焊死在引擎里。

---

## 6. 横切层

### 6.1 scorecard（证据链门控）`[M]`

```js
interface Scorecard {
  check(ctx: { runId, transcript, handoff? }): Promise<ScorecardResult>;
}
interface ScorecardResult {
  passed: boolean;
  checks: { name: string; passed: boolean; evidence: string; detail?: string }[];
}
```

**检查项（初版，随实战积累）**：
- 节点是否真跑完（transcript 有完整事件链到 `done`）
- handoff 字段完整性（对照 `outputSchema.requiredFields`）
- 测试命令是否真有输出（查 `command` 事件的 exitCode + 输出）
- 产出文件是否真存在（查 `file_written` 事件 + 文件系统验证）
- 证据闭环（前驱 claims 有 evidence 支撑）
- **assistant text 答案存在**（`requireAssistantText`，post-M6 新增：防 completed 但无 text 的伪完成）

**判定来源**：程序检查，**不来自 LLM**。
**与状态机关系**：scorecard 不通过 → `running→failed`（而非 `completed`）。
**默认行为（M8-1）**：无显式 rules 时默认 `{ requireEvidence:true, mode:"warn" }` —— 不阻塞完成，只记 `scorecard.warn` 留痕（防伪完成从 opt-in 升级为默认）。`--scorecard-mode hard|warn|off` 三态切换；显式 rules 优先于 mode 默认。详见 SKILL.md §Scorecard。

### 6.2 metrics `[S→M]`

```js
// 从 transcript 聚合
interface RunMetrics {
  runId: string;
  tokens?: TokenUsage;
  durationMs?: number;
  commandCount: number;
  fileWrittenCount: number;
  state: RunState;
}
async function aggregateMetrics(runDir): Promise<SummaryMetrics>
```

`[S]`：单 run 聚合（token/时长/命令数）。`[M]`：跨 run 聚合（成功率、延迟分布、成本趋势）。

---

## 7. 目录结构与模块边界

```
src/
├── cli.js                    # L4：CLI 入口与路由（现有）
├── registry.js               # L1：registry 加载（现有）
├── transcript.js             # L1：JSONL transcript（现有，扩展事件类型）
├── runManager.js             # L2：RunManager + 状态机
├── isolation.js              # L2：worktree（进程隔离=Node 内置 Job Object v22 + taskkill，见 ADR 0013；端口表见 portAllocator.js）
├── delivery.js               # L2：Coder Delivery Contract v1（TD-103 Phase 2：isolated delivery inspect/package，不 import CLI/RunManager）
├── portAllocator.js          # L2：端口分配表（已实现但未接入，TD-23）
├── metrics.js                # 横切：metrics 聚合
├── runEvent.js               # L1：RunEvent 类型（message/done/metrics + 证据 command/file_written/tool_use/tool_result）
├── scorecard.js              # 横切：证据链门控
├── diagnosis.js              # 横切：故障诊断（M8-3+C，给证据不给处方；类别 provider_auth/config_conflict/timeout/scorecard_fail/budget/crash/aborted_manual/unknown）
├── costForecast.js           # 横切：成本预演（M8-4，历史中位数±区间）
├── smoke.js                  # L4：真实 CLI smoke 入口（npm run smoke）
├── backends/
│   ├── opencodeServe.js      # L1：HTTP 类 backend
│   ├── processBackend.js     # L1：进程式 backend 基类
│   ├── claudeCode.js         # L1：claude-code 后端
│   ├── codex.js              # L1：codex 后端
│   └── parsers/
│       ├── lineStream.js     # stdout 行流解析基类
│       ├── claudeCode.js     # claude-code stream-json 解析
│       └── codex.js          # codex 输出解析
├── workflow/                 # L3：DAG 引擎
│   ├── schema.js             #   图定义 + 校验 + 拓扑排序
│   ├── loader.js             #   .mjs 加载 + applyTemplate（参数式 DAG）
│   ├── engine.js             #   执行引擎（分层 + 并行 + 失败传播）
│   ├── handlers.js           #   节点处理器（agent/gate/router/integrator + 自定义注册）
│   └── handoff.js            #   节点间引用传递 + promptBuilder
config/
├── agents.example.json       # registry 模板（角色化 5 角色）
└── default.json              # 默认设置
test/
└── （各模块配 node:test 测试，含 docs-consistency.test.js 文档不变量守卫）
```

> **未实现的模块**（spec 曾设想，roadmap 无对应 milestone，勿当作既有文件）：
> - `scheduler.js`（限并发调度器，**未实现**）—— 见 §4.4，登记 TD-5。
> - `workflow/dag.js`（**未实现**，DAG 能力已拆进 schema.js + engine.js，无独立 dag.js）。

**模块边界规则**：
- backend 特定逻辑**只在** `src/backends/` 下
- 状态机逻辑**只在** `runManager.js`
- 隔离机制**只在** `isolation.js`
- CLI 只做路由 + 调用 RunManager，不持有业务逻辑

---

## 8. 配置

```jsonc
// config/default.json
{
  "registry": "config/agents.json",
  "runDir": "runs",
  "pollInterval": 5000,
  "waitTimeout": 300000,
  "timeout": 30000,
  "retries": 2,
  // [S新增]
  "maxConcurrent": 4,
  "worktreeStrategy": "persistent",   // "persistent" | "ephemeral"
  "isolation": {
    "useJobObject": true,
    "portRange": [30000, 31000]
  },
  // [post-M6新增] 静默无响应早失败（Kimi 白名单/不存在 model）：null=不启用，数值=ms
  "silentTimeout": null
}
```

CLI flag 覆盖 config，config 覆盖 hardcoded defaults（现有优先级链保留）。

---

## 9. 实现顺序（M0–M8 已完成 ✅）

> 以下顺序已全部落地（M0–M8），每步对应一个 milestone，见 `docs/roadmap.md`。
> 保留作历史参考，不代表待办。

1. ✅ **Transcript 扩展**（M0）：`seq` + `run.state_change` + `run.event` + `findState`
2. ✅ **状态机 + RunManager**（M0）：从 `cli.js` 抽出，状态显式化
3. ✅ **RunHandle.events 迁移**（M1）：opencode-serve 改为 AsyncIterable
4. ✅ **隔离层**（M3）：worktree + 端口表（进程隔离 = Node 内置 Job Object v22 + taskkill /T/F，TD-40/ADR 0013）
5. ✅ **ProcessBackend + parser**（M2）：claude-code + codex 都已实现
6. ✅ **resume**（M3）：`runs resume <runId>`
7. ✅ **metrics 聚合**（M4）：`runs metrics`

M5（DAG）/ M6（scorecard）/ M7（daemon + unattended）/ M8（Lead 体验层）也已落地；后续真实进度见 `docs/roadmap.md`。每步完成时 `npm test` 必须绿（纪律见 `docs/milestone-discipline.md`）。

---

## 10. 开放问题 ❓

- **后台 run 在 Windows 上的存活机制**：✅ 已实测（[research/13](./research/13-p3-daemon-ipc-spikes-2026-06-25.md) §T0a）：
  `spawn({detached:true, stdio:'ignore'}) + unref()` 给出真正的后台存活，**无需 OS service**。
  P3 daemon = P2 detached runner 常驻化 + IPC。
- **claude-code / codex 的流式输出格式**：parser 的实现依赖实测，spec 里只定了契约。
- **验收契约形态**（PRD U13）：留 `[L]`，先不阻塞。
- **IPC 选型**（daemon 阶段）：✅ 已定 **命名管道**（`\\.\pipe\wao-daemon` + JSON-line over `node:net`），
  见 [决策 0012](../.wao/decisions/0012-daemon-ipc-选型-命名管道.md) + [research/13](./research/13-p3-daemon-ipc-spikes-2026-06-25.md)。
