# 事故复盘：GLM-5.2 quota 耗尽（dispatch-readiness stop 测试用例）

> 日期：2026-06-18（发现于 06-18 早晨；失控发生在 06-17 23:38 ~ 06-18 07:00）
> 严重度：高（智谱 coding plan max 当周 quota 耗尽——睡前约剩一半，早上发现整周配额已用尽）
> 根因：`stop` 命令的 abort 调用返回成功（本地 ledger 写入 `run.aborted`），但 opencode serve 端 session 未真正终止；属 TD-37 描述的"本地 stop ledger ≠ 后台 session quietness"，**本次为已实现的故障，非假设性风险**。
> 状态：🔴 根因已定位 + 证据闭环。
> **修复状态**：见 `docs/tech-debt.md` TD-37（stop 后台静默验证 `verifyStopQuiet`）、TD-38（`_runCleanup` quiet verification）—— 均已偿还。本文正文不再维护修复进度（过程文档只追加，修复状态以 TD 登记为准）。
> **残留架构缺口**：fire-and-forget 路径（裸 `spawn` 不带 `--wait`）的 HTTP-session backend 仍不经过 `waitForCompletion` 内的三层防线，见 TD-39 + `docs/ssot.md`。

> 取证方式：只读。直接查 `~/.local/share/opencode/opencode.db`（serve 自身 SQLite）+ dispatch-readiness 副本的 transcript。脚本见 `.dev/forensics-0618.mjs`、`.dev/forensics-0617-recheck.mjs`。

## 与 06-17 DeepSeek 事故的关系

这是**与 `2026-06-17-deepseek-quota-drain.md` 完全独立的另一次事故**，间隔不足 24 小时。两次根因路径不同（见文末对比表），不可合并，不可互相引用对方的修复结论。06-17 复盘第 35 行"对会自然停止的模型（GLM-5.2，serve session 自己就停了）无害"的结论，**被本次事故证伪**——GLM 在被明确要求"do not finish until stopped"时会无限运行，与 DeepSeek 无本质差异。

## 事件经过

2026-06-17 23:38~23:41（UTC），`dispatch-readiness` 测试套件的 `ledger.stop-aborted` 用例（`scripts/run-dispatch-readiness.mjs:416 runStopAbortedCase`）执行了两次（两次测试批次 `dispatch-readiness-20260617233800374` 与 `dispatch-readiness-20260617234043014`）。

每次执行：
1. `spawn coder --prompt "Begin a long-running task and do not finish until stopped."`（fire-and-forget，不带 `--wait`）
2. 紧接 `stop <runId>`
3. 读 transcript，检查 state==aborted + seq 单调 → **测试判定 PASS**

但两个被派发的 GLM session 在 opencode serve 端实际运行到 **06-18 07:00**（用户早晨 kill serve 进程止血），约 **7 小时 22 分钟**。期间持续消耗 token，直至当周 quota 耗尽。

## 根因分析（双证据闭环）

### 证据 A：WAO transcript 显示"干净 abort"

失控 session `ses_1280cd47afferI5Y6S1dZ5wfu4` 对应的 transcript
`dispatch-readiness-20260617233800374/run_20260617233818337aidjzx.jsonl`：

```
23:38:18.338  run.started            (coder, opencode-serve, glm-5.2)
23:38:19.876  prompt.sent            "Begin a long-running task and do not finish until stopped."
23:38:19.974  run.stop_requested     ← stop 命令执行（距 prompt 98ms）
23:38:20.067  run.aborted            ← backend.abort 返回（距 stop_requested 93ms）
23:38:20.068  run.state_change → aborted
```

seq 单调、状态正常收束到 `aborted`。**从 WAO 控制平面视角，这是一个完全成功的 stop 操作。** 第二个 session（`ses_1280a4794ffeTmAEF3suKLjEAX`，23:41）同理。

### 证据 B：opencode DB 显示"后台持续运行 7 小时"

`opencode.db` 的 `session` 表（serve 自身维护，非 WAO 写入）：

| session id | created | time_updated | tokens_input | out+reason |
|---|---|---|---|---|
| `ses_1280cd47afferI5Y6S1dZ5wfu4` | 06-17 23:38:18 | **06-18 07:00:14** | 292,258 | 70,298 |
| `ses_1280a4794ffeTmAEF3suKLjEAX` | 06-17 23:41:05 | **06-18 07:00:23** | 573,487 | 64,257 |

`time_updated` 都精确停在 07:00 —— 这是用户早晨 `taskkill` serve 进程的止血动作。两个 session 窗口内 GLM input 合计约 **86 万**（opencode 逻辑计数）；按 provider 计费口径（含 cache read、多轮 context 重发）折算，**烧光用户睡前剩余的半周 quota（智谱 coding plan max 周配额约 2.5 亿）**。

### 根因：abort 的"虚假成功"

`stopCommand`（`src/cli.js:477`，主仓与 dispatch-readiness 副本逻辑一致）：

```js
const backend = new OpenCodeServeBackend();
await backend.abort(session.serveUrl, session.backendSessionId);  // HTTP 调用，93ms 返回成功
await transcript.append("run.stop_requested", {...});
await transcript.append("run.state_change", { to: "aborted", ... });
```

`OpenCodeServeBackend.abort` 是一个 `POST /session/{id}/abort`（`opencodeServe.js:106`）。**它只验证 HTTP 响应成功，不验证 serve 端 session 是否真正停止生成 / token 是否停止增长。** abort 的 HTTP 调用在 93ms 内返回 200，transcript 据此写 `run.aborted`——**所有本地证据都指向"已停止"，而 serve 端的 GLM session 实际仍在运行。**

这正是 TD-37 预言、且本次被实证的情形：

> "stop drill 目前只证明本地 ledger…不证明 opencode backend session 已真正停止、token 不再增长。"

### 为什么 TD-35 修复没能阻止本次事故

TD-35（commit `03374cf`，06-17）在 `Run._runCleanup()` 加了兜底 abort，覆盖的是 **`waitForCompletion` 走完的终态路径**（completed/failed/timed_out）。

本次事故**不走这条路**：
- `spawn` 不带 `--wait`，spawn 进程拿到 runId 立即退出，RunManager 实例随进程死亡
- `stop` 是**另一个独立 CLI 进程**，`loadRun` 从 transcript 重建上下文，`new OpenCodeServeBackend()` 造全新实例，**完全不经过 RunManager，不触发 `_runCleanup`**

因此 TD-35 对 `stop` 命令路径**零覆盖**。两起事故根因路径不同，修复也不同——TD-35 修不了 06-18。

## 止血

06-18 早晨：用户发现 provider 提示当周 quota 耗尽 → `taskkill` 杀 opencode serve 进程（DB 显示两 session 的 `time_updated` 同步停在 07:00，即为此动作）。

> 注：本次止血由用户手动完成。WAO 控制平面在事故全程**无任何告警**——从 23:38 失控到次日 07:00 被人发现，跨度 7.4 小时，系统侧零感知。

## 修复

🔴 **未修复。** 当前（2026-06-23）状态：

- `stopCommand`（主仓 `src/cli.js:477`）实现未变——仍只发 HTTP abort、不验证后台 quietness。
- TD-37 仍为开放技术债（`docs/tech-debt.md`）。
- **风险**：同样的 `ledger.stop-aborted` 用例如现在重跑，会复现本事故。

待办（按优先级）：

1. **TD-37 落地**：`stop`（及所有 abort 路径）在 abort 后做 bounded polling——按 session/message/tokens 反复查询，确认无新增 message/token/stream；失败时标 `stop_unverified` 并继续 abort/retry 或强制 `taskkill`。
2. **token 预算硬闸门**：在 backend 轮询层累计 session token，超 `agent.tokenBudget` 立即终止并写 `run.budget_exceeded`。这是**唯一不依赖 abort 是否生效**的防线——即使 abort 是空操作，预算闸门也能在本地冻结。
3. **fire-and-forget spawn 的生命周期归口**：`spawn` 不带 `--wait` 时，要么要求外接监控进程，要么默认走 daemon 托管（M7），不能让 session 成为"无人看管的孤儿"。

## 教训

1. **"基于意图的停止"会给出虚假成功。** abort HTTP 调用成功 ≠ serve 端停止。任何停止动作的"成功"必须由**实测**（token/message 不再增长）定义，不能由"调用没报错"定义。本次事故中所有本地证据（seq 单调、state=aborted、stop 返回 ok）都正确，唯独最关键的事实（后台是否真停）从未被验证。

2. **fire-and-forget spawn 把 session 变成无人看管的资源。** `spawn` 不带 `--wait` + 进程立即退出 = session 的生命周期脱离任何 WAO 进程。`stop` 作为跨进程命令本可补救，但它同样不验证后台。**孤儿 session + 不可靠 stop = 必然泄漏。** 这不是某个用例的特殊问题，是控制平面架构的缺口。

3. **测试基础设施自己可以成为事故源。** 烧 quota 的是 `dispatch-readiness` 套件的 `ledger.stop-aborted` 用例——一个为验证"stop 能可靠 abort"而设计的测试，自身成了不会被 abort 的失控源。测试代码绕过主仓 RunManager（用独立副本派发），等于绕过了主仓的修复。**测试副本与主仓的生命周期管理必须同源，否则主仓修复对副本无效。**

4. **"某模型会自然停止"是不可依赖的假设。** 06-17 复盘据此判定 GLM 安全，导致 06-18 对 GLM 零设防。模型是否会自然停止取决于 task + context，而非模型本身——同一 GLM 在简单任务上停、在"do not finish until stopped"上无限跑。**调度安全不能建立在模型行为假设上。**

5. **无实时告警 = 事故时长 = 人类发现时长。** 23:38 失控到次日 07:00 被发现，7.4 小时全程零告警。在一个花真金白银的系统上，"无人在场时的失控检测"是必需品，不是 M7 的可选功能。

## 受影响配置

- **触发**：`dispatch-readiness` 套件 `ledger.stop-aborted` 用例（`coder` + GLM-5.2 + opencode-serve，fire-and-forget spawn + 跨进程 stop）
- **同类风险**：任何 `spawn` 不带 `--wait` + 后续 `stop` 的组合，在 opencode-serve backend 上
- **主仓等价风险**：主仓 `stopCommand`（`src/cli.js:477`）逻辑与副本一致，相同用例在主仓重跑会复现
- 进程式 backend（claude-code/codex）不受影响（进程死即会话死）

## 相关

- TD-37（`docs/tech-debt.md`）——本次事故的根因登记项，**状态从"开放风险"升级为"已实现故障"**
- `docs/incidents/2026-06-17-deepseek-quota-drain.md` —— 另一起独立事故（不同路径），其"GLM 无害"结论被本次证伪
- `SKILL.md` "opencode-serve operations & pitfalls"（需补充：stop 的虚假成功风险）
- 取证脚本：`.dev/forensics-0618.mjs`、`.dev/forensics-0617-recheck.mjs`

## 附：两起事故对比

| 维度 | 06-17 DeepSeek | 06-18 GLM（本次） |
|---|---|---|
| 触发 | 真实 researcher 调研任务 | dispatch-readiness 测试用例 |
| 触发 prompt | 调研类 | "do not finish until stopped"（测试故意制造长任务） |
| 派发方 | WAO 主控，`run --wait` | dispatch-readiness 副本，`spawn` fire-and-forget |
| 失控路径 | `waitForCompletion` 超时，终态漏 abort | `stop` 命令 abort 虚假成功 |
| 修复覆盖项 | **TD-35**（`_runCleanup` 兜底 abort）✅ 已修该路径 | **TD-37**（abort 后后台 quietness 验证）🔴 未修 |
| 后台存活 | ~1–2.5h（21–23:43 被 kill） | **7.4h**（23:38 → 07:00 被 kill） |
| 本地证据 | 终态事件缺失（漏 abort） | 终态事件齐全（虚假 abort 成功） |
| 发现方式 | 用户从系统提示偶然发现 | 用户早晨看 provider quota 通知 |
| 当前可复现性 | 该路径已修，不可复现 | **当前可复现**（stop 实现未变） |
