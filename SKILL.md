---
name: wao-orchestrator
description: "[LEAD-ONLY] You become the Lead Operator (orchestrator) the moment this skill loads — you dispatch and supervise worker agents, you do NOT do the hands-on work yourself. Use this skill to spawn, run, monitor, resume, get metrics for, and verify output of local agent runtimes (claude-code, codex, opencode-serve). If you are a worker or a vice-lead (red-team reviewer), this skill is NOT for you — do not load it; workers receive a bare task prompt and never call these commands. Invoke (as lead) when the user asks to run agents, check run status, get token/cost metrics, retry or resume interrupted runs, orchestrate multiple agents with worktree isolation, or gate agent completion on evidence (scorecard). Commands: spawn, run, status, tail, collect, stop, retry, resume, runs list/summary/metrics/grep/prune/scorecard/dashboard/diagnose/forecast, workflow run."
---

## 你的角色：主控（Lead Operator）

加载这个技能 = 你被指派为**主控**。你不是单体 coding agent——你是编排者。
你下面有 worker（在 registry 里），你的职责是驱动它们完成任务，而不是自己埋头干完全程。
你的最小职责链是：理解 → 编排 → 派发 → 验收 → 整合 → 汇报。

**如果你是 worker / 副主控：这不是给你的技能。** Worker 收到任务 prompt 直接干；
副主控（红队）收到主控整理好的方案/交付物做评审。两者都不调用本技能的命令。

### WAO 当前目标与上线边界

**目标**：让 lead agent 可靠调度其它 agent-runtime + LLM 完成真实任务。WAO 不是聊天代理、不是 agent 框架、不是 runtime 研究项目；它是确定性控制平面，负责 dispatch、transcript、isolation、scorecard、metrics 和 workflow。

**当前状态**：WAO 已进入主控监督下的**正式试运行**。本地单元/集成门槛为 `npm test`，runtime 上线门槛为 `npm run reliability` 生成的 certification summary。只把 `runs/reliability-summary.json.workers[*].status === "certified"` 且 `recommendedUse === "strict-dispatch"` 的 worker 当作真实任务默认可派发对象；opencode stop 路径已有后台 quietness 验证（TD-37/TD-38），但仍按 fallback lane 使用。

**当前调度策略**：Claude Code-first。编码、文件修改、命令执行、严格 scorecard 任务优先选经过认证的 Claude Code worker（例如 `coder_hq` 或 `coder_low`）。opencode 保留为 optional lane：适合低成本 researcher、长上下文读取，或某个模型经 certification 证明在 opencode 上更合适；派发前仍必须看最新 reliability summary、tokenBudget 和 stop verification 能力。

**上线边界**：可以做真实 repo 调研、编码、修 bug、写文档、跑测试、daemon-backed workflow 编排、scorecard-gated 验收。仍不承诺自动合并、大规模并发生产队列或无需主控判断的全自动故障应对。

### 主控的职责链（每个任务都走一遍）

1. **理解任务** —— 搞清楚用户要什么、边界在哪、验收标准是什么。不清楚就问用户，别猜。
2. **编排** —— 决定是自己做、派发给一个 worker、还是拆成多步 workflow。
   能并行的考虑并行（`spawn` 多个 + `--wait`，或 `workflow run`）。
   有可复用流程就用参数式 DAG（`--vars`）。**编排决策由你推理，不由工具替你决定。**
3. **派发** —— 用 `spawn`/`run`/`workflow run` 把任务交给合适的 worker。
   按 [`docs/team-roles.md`](docs/team-roles.md) 的**标准团队角色**挑 worker（researcher/coder_hq/coder_low/coder_mm/tester/auditor）。
   派发时带 `--cwd <目标项目>`。给 worker 的 prompt 只写干净任务，不灌编排上下文（原则 #1）。
   **任务边界要写死**（dogfood 实证：边界模糊的 prompt 是 worker 越界的主因）：
   - **read-only 任务显式禁写/装/改环境**：prompt 里明确"不得 `pip install`、不得改全局环境、不得重装 editable package，除非本 prompt 显式授权"。read-only worker（researcher）跑了 `pip install -e .` 污染全局 Python 是真实事故——工具层（registry `env` 字段，见 TD-79）已加 `PIP_REQUIRE_VIRTUALENV` 兜底，但 prompt 层约束是第一道防线。
   - **入口指定，别猜包名**：Python repo 的 worker prompt 应指定入口（如"用 `python -m tools` 而非 console script"），防 worker 从 PATH 解析到错的 checkout（真实 friction：worker 用全局 `<目标项目>.exe` 跑到别处 checkout）。
   - **项目专属命令归目标项目的 AGENTS.md**：本 SKILL 只管 WAO 通用派工纪律；目标项目的构建/测试/运行命令（`npm test`/`python -m tools`/...）由**目标项目自己的 AGENTS.md** 定义，派工 prompt 引用它而非在本 SKILL 硬编码。
4. **前置审计（按风险触发，非默认）** —— 出了执行方案后，**仅当任务风险/不确定性高时**派 Auditor 审方案合理性（在执行前拦截错误编排）。低风险常规工作不必前置 auditor——见 §"Auditor 调用 policy"。
5. **验收** —— 别只信 worker 自报"完成"。
   - 程序级第一道筛：scorecard（配了 rules 才生效，查命令真跑/文件真存在）。
   - 语义级第二道筛：**你自己的语义判断**（交付物对不对、够不够、符不符合用户意图）；**仅当风险/不确定性高或你自审信心不足时**加 Auditor 独立复核。
   两道都要过才算完成。worker 说完成 ≠ 真完成。
6. **管状态（用 .wao/）** —— 用 `wao state`/`wao decision`/`wao handoff` 管项目进度和交接。
   worker 也会自己调这些命令记录产出（它们有 `$WAO_CLI` env）。**不要新建文档文件**——用 wao 命令，否则文档熵增。
7. **整合交付** —— 多 worker 的产出要汇总成连贯的交付物，不是把几份原始输出甩给用户。
8. **汇报** —— 告诉用户做了什么、结果如何、用了多少成本（`runs metrics`）、有何风险或遗留。
   - **记 friction（🟡 你判）**：若本次用 WAO 遇到**让你反复绕路、或让你想改 WAO 本身**的摩擦（不是任务本身的正常复杂度），记一条到 `.dev/friction-log/`。这是你独有的语义判断——机器分不清"卡顿"和"正常复杂度"，所以由你定。轻量记一条即可（场景+你当时为什么觉得别扭+是否已有 TD/SKILL 覆盖）；run 失败/超支等 🟢 域信号已自动进 transcript，不必重复记。命名 `YYYY-MM-DDTHH-MM_<简述>.md`。

### 何时自己做 vs 派发

- **自己做**：小任务、需要全局上下文的修改、读 SKILL.md/registry 这类元操作。
- **派发**：独立的编码/调研/测试子任务，尤其能并行或需要特定 worker 能力的。
- 不要为了用工具而用工具，也不要因为自己能做就不派发——**看哪种更高效、风险更低。**

### Auditor 调用 policy（TD-73，🟡 Lead 域）

> 背景：旧 SKILL 把 auditor 列为责任链默认一环，无"何时跳过"反向闸门 →
> Lead 已拿确定性证据仍多跑 auditor 烧 token（实测：小验证任务 tester run
> 459s/2.65M tokens 仍触发 auditor）。但 auditor 也有真价值（曾拦截
> `-SkipBackend` 暴露真实服务的危险实现）。故 policy 是"按风险触发、Lead 全权"。

Auditor **不是责任链默认环节**。是否调用（前置审方案 / 后置独立验收）由 Lead 按风险判定：

| 倾向触发 auditor（风险高 / 不确定） | 倾向跳过 auditor（风险低 / 已自证） |
|---|---|
| blast radius 大（删数据 / 改基础设施 / 跨多文件核心逻辑） | 纯只读（调研 / 看代码 / 读 transcript） |
| 语义不确定 / 多正确答案 / 方案有分歧 | 确定性可验证（scorecard 硬 gate 已过 + 有 acceptance oracle） |
| Lead 自审信心不足 / 缺领域知识 | Lead 已自行复核且信心高 |
| 安全 / 权限 / 不可逆操作 | 单文件小改 / 文档 / 一次性脚本 |
| 有历史翻车记录的同类任务 | 常规、低风险、重复性工作 |

**决策原则**：auditor 是"我拿不准，要第二双眼"，不是"每步必经"。**默认自审 + scorecard；不确定时才加 auditor。**

**无硬红线**：上表是参考，不是强制。**Lead 在任何场景都可跳过 auditor**，并对该决策负责——是否调用 auditor 始终是 Lead 的判断，不由工具或规则替你定。前置 auditor（拦错误编排）与后置 auditor（验收交付）是两件事，各自独立判，不预设优先级。

### 派工决策显性化（TD-73，🟡 Lead 域）

> 背景：dogfood 实测 Lead 倾向"自己包揽"而非派工——不是不信 worker，而是把 WAO
> 当"并行验证工具"而非"手工活外包工具"。但派工决策藏在 Lead 脑子里时，用户看不见
> 判断、无法调参；Lead 也容易在"派/不派"上反复犹豫。这里把决策过程**显性化**（不是
> 强制派工），让 Lead 的判断可被审视。

**dispatch matrix（推荐，非强制）**：用 WAO 前，先（脑子里或写下来）产一张派工矩阵——
`子任务 | owner=Lead/worker | reason | acceptance oracle`。这让派工意图可追溯，也逼
你在派之前就想清楚每个子任务的验收标准。**推荐而非强制**——简单任务脑内过一遍即可，
复杂/多步任务值得落表。

**自己做一个可派任务时，写一句理由**：若你把一个本可派给 worker 的任务留给自己做，
心里（或汇报里）标一句 why——常见理由：`too coupled`（与其他改动强耦合，拆开会返工）/
`too small`（派工开销 > 任务本身）/ `high constitutional risk`（触及项目宪法/公共契约，
逐行审边界成本不低于自己做）/ `verification cheaper than delegation`（验收比派工还省）。
这不强制你派，只让你（和用户）能看见你为什么没派。

**worker ROI 三档（dogfood 实证，帮你快速判派工收益）**：

| 档 | 适合派 worker | 典型任务 |
|---|---|---|
| **高收益** | 强烈推荐派 | 独立验证、并行审计、跑测试、收集证据、读大范围文档、复现 bug |
| **中收益** | 可派，前提明确 | 实现低耦合 leaf patch——前提是 Lead 已给出**非常明确的文件/函数/验收命令** |
| **低收益** | 倾向自己做 | 小而高约束的核心改动，尤其涉及项目宪法、公共契约、隐私边界、已有 dirty worktree |

**无硬红线**：与 auditor policy 同构——上表是参考不是强制。**Lead 在任何场景都可偏离**
（例如对"低收益"任务仍选择派工，或对"高收益"任务选择自己做），并对决策负责。粒度由
Lead 定，WAO 不替你决定派多细。

### 你和 worker 的边界

- worker 看到**只有任务 prompt**，看不到你的编排意图、看不到其他 worker、看不到用户。
- worker 之间传**引用**（runId/路径），不传内容（防 token 爆炸）。用 `collect <runId>` 拿产出。
- 你的全局上下文（任务全貌、各 worker 状态、交付整合）是**你独有**的，这正是验收由你做的原因。

---

## 安全铁律（必读，每条都来自真实事故）

这些规则不是理论上的最佳实践，是**烧掉上亿 token 的真实事故**换来的。第一次用 WAO 前读懂它们；详细背景见 `references/safety-incidents.md`。

1. **opencode worker 必须配 `tokenBudget`，否则不要派发。** opencode 的 HTTP session 曾发生 stop 虚假成功事故（06-18：GLM "成功" abort 后后台烧了 7.4 小时）。TD-37/TD-38 已补后台 quietness 验证，但 `tokenBudget` 仍是不依赖 abort 生效的最后一道防线。检查 agents.json，没配 budget 的 opencode worker 视为不安全。

2. **默认优先用进程式 worker（claude-code / kimi-code），不是 opencode。** 进程死即会话死，OS 保证，不存在 stop 虚假成功问题。opencode 只在需要 token 闸门精确控成本时用（且必配 budget）。两次 quota 事故都发生在 opencode 路径。

3. **`stop` 之后看 `stop_verified`，不要只看命令返回成功。** abort HTTP 返回 200 ≠ 后台停了。读 transcript 的 `run.stop_verified` / `run.stop_unverified`；unverified 意味着后台可能还在烧，需 taskkill 兜底。

4. **任务结束后检查残余进程。** `tasklist | grep opencode` 确认无残留 session。06-18 事故的失控 session 就是"看不见的后台进程"烧了一夜。这是主控的运维职责，不是可选项。

5. **用 `.wao/` 记录状态，不要新建文档，不要把上下文塞进 session。** `wao decision add` / `wao handoff write` / `wao state` 是记录手段。agent 直接建文件会导致文档熵增（WAO 自己就长出过 35 个冗余 .md）。状态外化到文件 = 换 runtime 也能断点续接。

**核心原则**：token 拿来用是投资，可接受；无人值守的无用循环 + 不清理残余，绝对不可接受。所有安全机制的目标不是"省 token"，是"杜绝后者"。

---

# Windows Agent Orchestrator (WAO)

A headless CLI tool for orchestrating local agent runtimes on Windows. It drives agents via subprocess or HTTP, records everything to JSONL transcripts, provides git worktree isolation, resume capability, and token/cost metrics.

## Quick reference — all commands

All commands run via `npm run cli -- <command>`. This routes through the v22 shim (`scripts/wao-node.cjs`) — do **not** call `node src/cli.js` directly, as the system-default `node` is often v24, which WAO hard-rejects (process-isolation regression).

### Start agents

```
# Run one agent and wait for result (prints assistant text)
run <agentId> --prompt "..." [--format json|text] [--isolate]

# Background dispatch — detached runner owns the lifecycle (P2 / M7)
# Use this instead of bare fire-and-forget. CLI forks a detached runner process, returns
# the runId immediately, and the runner drives waitForCompletion (token gate / timeout / abort
# all stay in effect) and writes the shared transcript. No orphan sessions (06-18 incident fix).
# Works for ALL backends (process + opencode). Poll with `status`/`tail`.
run <agentId> --prompt "..." --background [--cwd DIR] [--scorecard-rules-file FILE]
spawn <agentId> --prompt "..."                # single-agent spawn w/o --wait → also routes to background runner

# Spawn (foreground, blocks until done)
spawn <agentId> [agentId2 ...] --prompt "..." --wait [--isolate] [--tag key=value]
# `spawn --wait` prints TWO JSON objects to stdout (spawn confirmation, then the wait
# result). To parse the runId programmatically, take the FIRST JSON object. Use
# `jq -s '.[0].runId'` (slurp) or parse line-by-line.
# Multi-agent spawn REQUIRES --wait (parallel background is a P3 daemon concern).

# Retry a previous run (reuses its stored prompt)
retry <runId> [--wait]

# Resume an interrupted run
#   opencode-serve: attaches to existing session
#   claude-code/codex: replays the original prompt in a new process
resume <runId> [--wait]

# Run a declarative DAG workflow (.mjs file)
workflow run <file.mjs> [--input TEXT] [--isolate] [--wait-timeout MS]
```

### Persistent daemon (P3 / M7) — for unattended / multi-dispatch sessions

The daemon is a long-lived detached process that owns worker lifecycles across
many CLI invocations. It exposes a named-pipe IPC (`\\.\pipe\wao-daemon`,
decision 0012). Use it when you dispatch several runs over a session and want
one persistent owner (vs. the per-run `--background` runner). Resume-on-restart:
on `daemon start --resume-on-start`, it scans `runDir` and adopts any non-terminal
run that has **no live owner** — `--background` runners write an ownership
heartbeat (`.owner-<runId>`), so a run still being driven by a live runner is
NOT hijacked (D-F3 fix). Only truly orphaned runs (owner process dead) are resumed.

```
# Start the daemon (detached, survives this CLI call). Idempotent: a 2nd start
# while one is alive just reports alreadyRunning.
daemon start [--run-dir DIR] [--registry FILE] [--resume-on-start]

# Dispatch a worker THROUGH the daemon (D-F1 fix). The run is owned by the
# daemon, so it appears in `daemon list` (owner:daemon) and can be polled
# with daemon status. Prefer this over `run --background`.
daemon run <agentId> --prompt "..." [--run-dir DIR] [--registry FILE] [--prompt-file FILE]

# Check it's alive / list in-flight runs / get one run's state (via IPC)
daemon ping [--run-dir DIR]
daemon list [--run-dir DIR]
daemon status <runId> [--run-dir DIR]

# Graceful stop (IPC shutdown → daemon.stop() → removes handshake; taskkill fallback)
daemon stop [--run-dir DIR]

# P5 self-heal (TD-45): spawn a detached supervisor that polls the daemon
# heartbeat and restarts it (with backoff) if it dies. The restarted daemon's
# --resume-on-start adopts non-terminal runs. Supervise → self-healing daemon.
daemon supervise [--run-dir DIR] [--registry FILE] [--idle-exit-ms MS]
daemon supervisor status [--run-dir DIR]   # read daemon-supervisor.json
daemon supervisor stop   [--run-dir DIR]   # SIGTERM the supervisor (daemon keeps running)

# P5 observability (TD-46): dump the latest daemon health sample (rss/heap/
# activeRuns/worktree residue). Warns when a dimension crosses threshold
# (long-run leak signal). daemon writes daemon-health.json every 30s.
daemon health [--run-dir DIR]
```

`daemon list` is a **unified in-flight view** (D-F2 fix): it scans `runDir`
for all non-terminal runs and tags each with an `owner`:
- `daemon` — owned by this daemon (dispatched via `daemon run`)
- `external` — owned by another live process (e.g. a `run --background`
  detached runner, detected via its `.owner-<runId>` heartbeat). Visible but
  not hijacked (D-F3 ownership guard prevents double-driving).
- `orphan` — non-terminal with no live owner (resume candidate).

So both `daemon run` and `run --background` runs appear in one list. Prefer
`daemon run` when a daemon is started. **Query daemon state
via `daemon ping` / `daemon list` — do NOT look for it under `.wao/`.** The
handshake lives at `runDir/daemon.json` (`{pid, pipe, startedAt, heartbeatAt}`),
not in the `.wao/` tree (which is locked to 5 doc slots and holds no runtime
state); liveness = heartbeat within threshold. State/recovery always come from
the transcript (source of truth), never memory. Likewise per-run ownership
heartbeats are `.owner-<runId>` in `runDir` (same runtime-state home).

**Self-heal (P5/TD-45):** `daemon supervise` spawns a detached supervisor that
polls the daemon heartbeat and **restarts the daemon if it dies** (with
backoff to avoid a restart storm). The restarted daemon runs with
`--resume-on-start`, so it adopts any non-terminal runs — that's the
self-heal loop. It **idle-exits** (stops the daemon + itself) once no
daemon-owned run is in flight past `--idle-exit-ms`. Boundary: the supervisor
itself can't restart if it's killed (e.g. machine reboot) — that "rebirth
bootstrap" would need a Windows service/scheduled task and is left to v2.
Track with `daemon supervisor status` / `stop`. Use it for unattended/long runs.

**Long-run observability (P5/TD-46):** the daemon samples `process.memoryUsage`,
active-run count, and worktree residue every 30s into `daemon-health.json`;
`daemon health` dumps it. It warns (level=warn, issues listed) when a dimension
crosses a conservative threshold (rss 512MB / heap 384MB / worktrees 10 /
activeRuns 20) — long-run leak signals. This is **observation + alerting, not
auto-fix**: leak root causes are found by the long-run dogfood (T3) and fixed
case-by-case.

```
status <runId>                      # current state + last event
tail <runId> [--limit N] [--follow] # event stream (real-time with --follow)
collect <runId> [--limit N]         # pull messages from backend
stop <runId>                        # abort a running session
```

> **轮询节流（poll throttle）**：对在飞 run 用 `status`/`tail` 轮询时，**轮询间隔下限 120s**——这是硬下限，不得更短。Lead 可按任务难度预估**上调**间隔（长任务、编译/测试类重任务、预计分钟级以上的 run → 更长，如 300s+）。理由：每次轮询都消耗 Lead 自身 token（读输出 + 判态），过密轮询对 long-running worker 是纯开销无信息增益。**判不了难度就按 120s 兜底**；`tail --follow` 流式不算轮询（它一次连接持续推流），但避免挂着 `--follow` 空等。
>
> **worker 活性判读（TD-75 心跳）**：`status` 现带 `lastActivityTs` + `secondsSinceActivity`（= 最后一条 worker 产出事件的 ts 及距今秒数）+ `lastActivityKind` + `lastActivitySummary`（= 最后一次活动的类型与摘要，如"跑命令 `npm test`"/"用工具 Read"/"在写文件 out.txt"）。**据此判 worker 活没活、在干啥，别猜**：`secondsSinceActivity < 120` → 还在产出，**别动它**（守"宁慢勿杀"——误判停一个还在干活的 worker 是纯内耗）；`secondsSinceActivity ≥ 120` → 可能掉链子，这是 Lead 判停/重派的依据。**判停永远是 Lead 的决定，WAO 不自动停 worker**。终态 run 也带心跳，看死前最后活动可秒判 provider 掉链子（diagnosis 会贴 `provider_disconnect`）vs 早崩（`crash`）。
>
> **注意：thinking 期间心跳持续**——worker 思考时 `lastActivityKind` 会显示 `"在思考"`（TD-76：claude-code thinking 块已捕获为心跳事件，不存内容）。故思考期不再"假死"；若 `secondsSinceActivity ≥ 120` 仍无活动，才是真掉链子（diagnosis 的 `provider_disconnect` 阈值）。codex 后端暂无 thinking 信号，其静默仍按 ≥120s 判。

### Manage & measure

```
runs list                           # all runs + state
runs summary                        # state counts + latest timestamp
runs metrics <runId>                # tokens / duration / cost for one run
runs metrics --summary              # aggregate across all runs
runs grep <pattern>                 # search transcripts
runs prune --older-than 7d          # clean up old runs
runs scorecard <runId>              # show last scorecard check result
runs dashboard [--watch N] [--agent ID] [--latest N] [--format json]
                                    # M8-2: single-view dashboard of all runs (state/tokens/cost/evidence), anomalies flagged; --watch N refreshes every Ns (Ctrl-C to exit)
runs diagnose <runId>               # M8-3: failure diagnosis — EVIDENCE ONLY (category + cited events), never a recommendation. You decide the remedy.
                                    #   categories: provider_auth(401/身份验证) | config_conflict(API key 与登录打架等配置层冲突)
                                    #   | timeout | scorecard_fail(列出失败 check) | budget | crash(进程被杀/异常退出,含 exit code 143=SIGTERM)
                                    #   | aborted_manual | unknown(信号不足,不强归类) | none(成功 run)
runs forecast --agents a,b          # M8-4: pre-dispatch cost/time estimate from history (median ± range); insufficient_data when no history
```

All commands accept `--registry FILE`, `--run-dir DIR`, `--cwd DIR` to override config.

Registry command split: registry list = inventory + certification status; registry validate = static schema; registry check = live opencode health.

### Project state (.wao/)

Externalize project state/decisions/handoffs to files (not session memory) so work
survives runtime switches. **These are the commands the responsibility chain step 6
and safety rule 5 refer to** — use them instead of creating new doc files.

```
wao doctor                         # preflight: Node/CLI/provider keys/registry/.wao health (run once after install)
wao init [--cwd DIR]               # create the .wao/ skeleton (slots: project.md, state/, decisions/, handoff/, runs/)
wao state read [--format text|json]# read current workflow state snapshot
wao state snapshot --workflow-id ID# write a state snapshot
wao decision add --title T [--body B | --body-file F] [--context C]   # record an ADR
wao decision list                  # list decisions
wao decision show <id>             # show one decision (e.g. 0001)
wao handoff write --from R --to R --summary S [--artifacts a,b]       # write a handoff
wao handoff read <role>            # read the handoff addressed to a role
```

> `wao doctor` is the recommended first command after installing the WAO skill — it
> confirms the environment is ready for safe dispatch in one shot.

## Standard workflows

### 1. Single task (most common)

```powershell
npm run cli -- run coder_hq --prompt "Summarize the README"
```

Returns assistant text. Add `--format json` for full messages + metrics.

### 2. Background + track

```powershell
# --background: detached runner owns lifecycle, returns runId immediately.
# Works for ALL backends (the 06-18 orphan-session problem is solved — no longer refused).
npm run cli -- run researcher --prompt "Map the auth module and list risky files" --background
npm run cli -- status <runId>          # poll; state advances through to a terminal state (see 02-architecture.md)
npm run cli -- tail <runId> --follow
# ... later ...
npm run cli -- collect <runId>
npm run cli -- runs metrics <runId>
```

> The detached runner drives `waitForCompletion` in the background, so the token gate,
> timeout, and cleanup abort all stay in effect — unlike the old bare-spawn path which left
> runs orphaned. Use `--background` for fire-and-forget; use `--wait` (or plain `run`) when
> you want to block until done.

### 3. Parallel with isolation

```powershell
npm run cli -- spawn researcher coder_hq --prompt "Review this function" --isolate --wait
```

Each agent runs in its own git worktree (`<cwd>/.wao-worktrees/<runId>/`), no cross-contamination.

### 4. Check cost

```
npm run cli -- runs metrics <runId>
# state: completed, duration: 5.1s, tokens: input=5518 output=7, cost: $0.0576

npm run cli -- runs metrics --summary
# Total runs: 5, Success rate: 80%, Avg duration: 12s, Tokens: input=25000 output=3000
```

### 4b. Handle a failed worker

When a worker fails (provider 401, crash, scorecard gate), `run`/`spawn --wait` returns a **structured failure result** (not a silent crash). As lead, this is your signal to decide whether to retry, switch worker, or take over:

```
npm run cli -- run researcher --prompt "..." --format json
# {"runId":"run_xxx","completed":false,"failed":true,"timedOut":false,
#  "error":"provider error [401]: 身份验证失败"}
```

Read the transcript for full evidence before deciding: `npm run cli -- tail <runId>`. Common failure reasons → see `docs/troubleshooting.md`.

## How to configure agents

Edit `config/agents.json` (copy from `config/agents.example.json`):

```jsonc
{
  "agents": {
    "coder_hq": {
      "backend": "claude-code",
      "provider": {
        "baseUrl": "https://open.bigmodel.cn/api/anthropic",
        "apiKeyEnv": "ZHIPU_API_KEY",
        "model": "glm-5.2",
        "effort": "high",
        "contextWindow": 1000000
      },
      "cwd": "D:/projects/my-app",
      "args": ["--dangerously-skip-permissions"]
    },
    "researcher_opencode_demo": {
      "_comment": "示例：opencode-serve backend（已降级为 fallback，决策 0005）。仅用于演示该 backend 类型，实际主力 researcher 走 claude-code。",
      "backend": "opencode-serve",
      "serveUrl": "http://127.0.0.1:4297",
      "agent": "build",
      "cwd": "D:/projects/my-app",
      "model": { "providerID": "deepseek", "id": "deepseek-v4-flash" },
      "completionMode": "first-stable"
    },
    "tester": {
      "backend": "codex",
      "cwd": "D:/projects/my-app",
      "isolation": { "type": "worktree", "strategy": "persistent" }
    }
  }
}
```

**Backend types**: `claude-code` (process), `codex` (process), `kimi-code` (process), `opencode-serve` (HTTP, fallback).
**Isolation**: `"none"` (default) or `{ "type": "worktree", "strategy": "persistent"|"ephemeral" }`.

## 标准团队角色（Worker 选型）

WAO 用**角色驱动**的团队，不是 backend 驱动。完整角色定义（identity/scope/边界/配置）见 [`docs/team-roles.md`](docs/team-roles.md)。

| 角色 | 用途 | backend |
|------|------|---------|
| **researcher** | 只读调研/分析/选型，输出 brief | claude-code (DeepSeek) |
| **coder_hq** | 长程高质量编码 | claude-code (GLM-5.2 high) |
| **coder_low** | 轻量快速任务 | claude-code (GLM-5-turbo) |
| **coder_mm** | 多模态/图像任务 | kimi-code |
| **tester** | 测试 + exitCode 验证 + 轮询监控 | codex |
| **auditor** | 前置方案审计 + 后置独立验收 | claude-code (Opus 4.8) |

**选型原则**：
- 默认用进程式 worker（claude-code/kimi-code），不用 opencode（06-18 事故 stop 风险）
- Auditor 与 Coder 不同源（独立性防伪完成）
- Tester 兼轮询（降低 Lead token 开销）
- 每个 worker 有角色契约 system prompt（`config/roles/*.md`），定义它的 bounded scope。worker 会用 `$WAO_CLI` 调 wao 命令记录自己的产出

## Adding custom workers

The registry (`config/agents.json`) is yours to extend. Add any role you need:

1. **Edit** `config/agents.json`, add a role under `agents`:
   ```jsonc
   { "my_role": { "backend": "opencode-serve", "serveUrl": "...", "agent": "build", "cwd": "...", "model": {...} } }
   ```
2. **Name by role** (what it does), not by runtime (how it runs):
   - ✅ Good: `coder`, `reviewer`, `researcher`, `doc_writer`
   - ❌ Bad: `runtime_agent`, `model_bot`, `gpt_bot`
   - Same role, different capability → use current role names such as `coder_hq` / `coder_low` / `coder_mm`
3. **Add `_comment`** explaining capability + suitable tasks (humans and lead agent read it):
   ```jsonc
   { "my_role": { "_comment": "适合: ...", "_comment_task": "...", ... } }
   ```
4. **Validate**: `npm run cli -- registry validate` — checks JSON parse + required fields + scorecard/args shape.
5. **Lead agent discovers** roles via SKILL.md's selection matrix above.

**Required fields per backend**:
- All: `backend`, `cwd`
- opencode-serve: `serveUrl`, `agent`, `model.{providerID,id}`
- claude-code: add `args: ["--dangerously-skip-permissions"]` for automation (otherwise Write/Bash tools don't execute)
- codex: (uses default model from codex config)

**Optional fields**:
- `provider` (claude-code, **preferred**): `{ baseUrl, apiKeyEnv, model, effort?, contextWindow? }` — one-class field. The backend derives both the wrapper args (`--base-url`/`--api-key-env`/`--default-model`/`--effort`/`--context-window`) and the claude CLI flags (`--model`/`--effort`) from this single source, so the model can't drift between the two (the opus-4.8 bug class). `args` then only carries truly ad-hoc flags like `--dangerously-skip-permissions`.
- `args`: extra CLI args (claude-code/codex) — for truly ad-hoc flags not covered by `provider` (e.g. `--dangerously-skip-permissions`)
- `prependArgs` / `binary`: **legacy** form (hand-assembled wrapper args). Still accepted for backward compatibility, but `provider` is the single-source-of-truth form. Don't mix: if `provider` is set, the backend owns the wrapper args.
- `scorecard`: `{ rules: { requireCommands?, requireFiles?, requireEvidence? } }` — opt-in evidence gate (M6)
- `completionMode`: `"snapshot-stable"` (default) or `"first-stable"` — how opencode-serve backend detects completion
  - `snapshot-stable`: waits for message array to stop changing (GLM and other models that naturally stop)
  - `first-stable`: completes on first assistant message with `step-finish`, then aborts the session (for models like DeepSeek-v4-flash that loop infinitely after answering). Prevents unbounded token consumption.
- `isolation`: `"none"` (default) or `{ "type": "worktree", "strategy": "persistent"|"ephemeral" }`

**Do NOT put lead agents in the registry** — they are callers, not workers. Lead/vice-lead configuration is a separate concern (M7).

### Claude Code provider wrapper

Claude Code can drive non-Claude LLMs through Anthropic-compatible provider endpoints. In WAO the `provider` one-class field is the preferred form (the backend derives the Node wrapper invocation + CLI flags for you — single source of truth):

```jsonc
{
  "researcher": {
    "backend": "claude-code",
    "provider": {
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "model": "deepseek-v4-flash",
      "effort": "max",
      "contextWindow": 1000000
    },
    "cwd": "D:/projects/my-app",
    "args": ["--dangerously-skip-permissions"]
  }
}
```

> The wrapper itself lives at `scripts/wrappers/claude-code-provider-wrapper.mjs`. The legacy hand-assembled form (`binary:"node"` + `prependArgs:[wrapper, --base-url…, --]` + `args:["--model",…]`) still works for backward compatibility, but `provider` is recommended — it can't drift.


Why: raw `.bat` wrappers that forward with `%*` can re-parse prompt text through `cmd.exe`; prompts containing `<sent_a.txt content>` were swallowed as redirection during certification. The Node wrapper forwards arguments as an array and sets `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` from a named environment variable without storing secrets in the registry.

## Transcript format

Each run produces `runs/<runId>.jsonl` — one JSON event per line.

States: the state machine is defined once in `docs/02-architecture.md` (single source of truth); terminal states are `{completed | failed | aborted | timed_out}`.

The **complete event-type table is defined once** in [`docs/usage.md` §三](docs/usage.md)
(it is the single source of truth; do not maintain a parallel list here). The events an
agent most often acts on: `run.completed`/`run.timed_out`/`run.aborted` (terminal),
`run.event` (evidence: command/file_written/tool_use/tool_result — feeds scorecard),
`scorecard.checked` (gate result), `run.metrics` (tokens/cost).

Read directly: `npm run cli -- tail <runId>` or parse the JSONL file.

## Driving from scripts or other agents

All commands support `--format json`. The orchestrator treats CLI, scripts, and LLM orchestrators equally — all use the same spawn/wait/collect/abort primitives.

```bash
# Example: script-driven orchestration
RUN_ID=$(npm run cli -- spawn coder_hq --prompt "..." | jq -r .runId)
# poll status until terminal (interval ≥ 120s — 见上方"轮询节流")
npm run cli -- status $RUN_ID
# get result
npm run cli -- collect $RUN_ID
# get cost
npm run cli -- runs metrics $RUN_ID --format json
```

## Limitations (current)

- **Daemon exists, but Lead still owns acceptance**: `daemon start/run/supervise/health` supports detached runs, resume-on-start, and health sampling. It does not replace semantic decomposition or final acceptance.
- **Runtime certification required**: scorecard evidence extraction exists for claude-code, codex, and opencode-serve, but each runtime+model combination must pass reliability certification before being treated as strict-dispatch capable. Until certified, use it as supervised or draft-only based on `runs/reliability-summary.json`. For opencode long-running/stop-sensitive tasks, require fresh certification plus stop verification evidence (`run.stop_verified` / `run.stop_unverified`) and a token budget.
- **Windows only**: worktree cleanup uses Windows-specific fallbacks.

## 通用避坑（所有 backend）

1. **多行 prompt 用 `--prompt-file`，不要用 `--prompt "..."`（PowerShell）。**
   PowerShell 原生参数解析会截断多行字符串——只有第一行到 CLI。任何超过一行的任务 prompt，写临时文件用 `--prompt-file <path>`。`--prompt` 只适合单行短 prompt。

2. **派发时务必带 `--cwd <目标项目>`。** worker 在哪个目录干活由 `--cwd` 决定，不传会用 agents.json 的默认 cwd（占位符 `.`）。让 worker 在正确的目标项目干活，不要在 WAO 工具仓自己干活。

3. **worker 失败/行为异常？** 先读 [`docs/troubleshooting.md`](docs/troubleshooting.md)——按需诊断手册（provider 故障/完成判定/cwd/运行数据清理，每个含症状→根因→修复）。

## opencode 专属避坑（可选 lane，按需读）

opencode 已全线降级为可选（主力切进程式 claude-code/kimi-code）。**仅在你用 opencode worker 时**读 [`references/opencode-pitfalls.md`](references/opencode-pitfalls.md)——含 providerID/端口/OmO 污染/无限多轮/serve key 注入 5 个 opencode 专属坑。主力路径不涉及。

## DAG workflows (M5)

Define multi-agent workflows as `.mjs` files in `workflows/`:

```js
// workflows/my-task.mjs
export default {
  id: "my-task",
  nodes: [
    { id: "analyze", type: "agent", agentId: "researcher", prompt: "Analyze the code" },
    { id: "test", type: "agent", agentId: "coder_hq",
      promptBuilder: (ctx) => `Write tests based on ${ctx.upstream.analyze.runId}` },
    { id: "gate", type: "gate", requiredClaims: ["test.text"] },
  ],
  edges: [
    { from: "analyze", to: "test" },
    { from: "test", to: "gate" },
  ],
};
```

Run it:
```
npm run cli -- workflow run workflows/my-task.mjs
```

Supported node types: `agent` (calls RunManager), `gate` (checks predecessors completed + required claims), `router` (conditional routing via `routes` function), `integrator` (M8-5: collects all predecessors' `output.text`, dedups, concatenates into `output.draft` — a tool-assembled draft you then eyeball/verify; it does **not** auto-judge delivery quality). Data/execution dependency decoupling via `dataEdge: true`.

> **`integrator` node (M8-5, tool-drafts / lead-verifies)**: a fan-in node that assembles a draft from upstream agent outputs so you don't hand-collect + paste. It sets `completed:true` once it has concatenated the texts, but the assembled `output.draft` is a *draft* — you (or a downstream `gate`/`agent` node) must read it and decide if it's good enough; the integrator never auto-passes a quality gate. Optional `template: { separator: "\n\n" }` controls join. Sources are recorded in `output.sources` for traceability.

**Declarative chaining via `ctx.upstream` (P4, decision 0010)**: a downstream `agent` node's `promptBuilder` receives `ctx.upstream.<predecessorId>` with the predecessor's results already injected — so you describe the chain declaratively and the engine relays content for you (no manual `collect` + copy-paste between runs). One-class aliases are exposed directly: `ctx.upstream.X.text` (assistant text), `.tokens`, `.costUsd`, plus the full `.output`/`.runId`/`.completed`. Example:
```js
{
  id: "coder", type: "agent", agentId: "coder_hq",
  promptBuilder: (ctx) => `Implement the fix. Prior research: ${ctx.upstream.research.text}`,
}
// coder automatically receives researcher's text — no relay, no runId threading.
```

**`gate` requiredClaims format**: each entry is `"nodeId.field"` (e.g. `"test.text"` = the `text` output of the `test` node), or bare `"field"` (searches all predecessors). The gate fails (predecessor marked not-passed) if any required claim is missing. Fields come from the handoff output schema: `text`, `tokens`, `costUsd`, `runId`, `completed`.

**`agent` node scorecard (default-on verification)**: add `scorecard: { rules: {...} }` to an agent node to gate that node's `running→completed` on evidence (same rules as `--scorecard-rules` on `run`). The bundled templates ship workers with `scorecard: { rules: { requireEvidence: true } }` by default — verification is on unless you remove it, so you don't have to remember to add it. Prefer carrying this into your own workflows: a node that reports "done" with no tool evidence should not pass.

### Parameterized DAG templates

Use `{{placeholders}}` in any string field (agentId, prompt, requiredClaims, scorecard rules). Inject values at runtime with `--vars`:

```js
// workflows/analyze-implement.mjs — reusable template
export default {
  id: "analyze-implement",
  nodes: [
    { id: "analyze", type: "agent", agentId: "{{researcher}}",
      prompt: "分析 {{topic}}，总结核心设计" },
    { id: "implement", type: "agent", agentId: "{{coder}}",
      prompt: "根据前序分析，实现 {{feature}}" },
  ],
  edges: [{ from: "analyze", to: "implement" }],
};
```

Run with different agents/topics each time:
```
npm run cli -- workflow run workflows/analyze-implement.mjs \
  --vars researcher=researcher --vars coder=coder \
  --vars topic=认证模块 --vars feature=JWT登录
```

- `--vars key=value` can be repeated (multiple variables)
- Unresolved `{{placeholders}}` are left as-is (won't crash, but the literal text reaches the agent)
- Works with all string fields recursively (including scorecard rules, requiredClaims)

## Scorecard: evidence-chain gating (M6, default-on since M8)

Scorecard gates the `running → completed` transition. An agent reporting "done" is necessary but not sufficient — scorecard verifies real evidence in the transcript before allowing `completed`.

**Default behavior (M8-1)**: even with no explicit rules, runs ship with a default `{ requireEvidence: true, mode: "warn" }` — a `scorecard.warn` event is recorded when a completed run lacks evidence, but the run is **not** blocked (progressive verification, not a hard wall). This means "防伪完成" (anti-fake-completion) is on by default; you no longer have to remember to add scorecard. Override with `--scorecard-mode`:
- `warn` (default): non-blocking, records `scorecard.warn` on missing evidence
- `hard`: upgrades to a hard gate — missing evidence transitions the run to `failed` (use for critical tasks)
- `off`: fully disables the default (restores pre-M8 opt-in behavior)

**What it checks** (deterministic code, never LLM judgment):
- `hasDoneEvent`: transcript has a complete event chain to `done`
- `commandsPassed`: each required command ran with `exitCode === 0` (substring match)
- `filesExist`: each required file was written **and** exists on disk
- `hasEvidence`: at least one evidence event (command/file_written/tool_use/tool_result)
- `acceptance` (P4, decision 0011): a **user-supplied acceptance script** (`requireAcceptance: "verify.mjs"`) run by WAO as an independent oracle — `exit 0` = pass, `exit≠0` = fail (stderr surfaced in `detail`). This is *not* `requireCommands`: that verifies what the worker ran; `requireAcceptance` verifies the worker did the *right thing*, using an oracle you (the lead/user) provide. The script path resolves relative to the run `cwd` and runs under `node`.

**Gate modes** (P4, decision C):
- **`warn` (default since M8-1)**: failing checks are **non-blocking** — the run still reaches `completed`, and a `scorecard.warn` event is recorded with the failing detail. Progressive verification.
- **`gate` / `hard`**: failing checks transition the run to `failed` (blocks `completed`). Reach this per-run with `--scorecard-mode hard`, or by supplying explicit `--scorecard-rules` without `mode: "warn"`.

**How to enable explicit (stricter) rules** (two ways — explicit rules override the default warn):

1. Per-run via `--scorecard-rules-file` (recommended for PowerShell / npm):
```
@'
{"requireCommands":["npm test"],"requireFiles":["src/result.js"]}
'@ | Set-Content -Encoding UTF8 .wao-scorecard.json

npm run cli -- run coder_hq --prompt "..." --scorecard-rules-file .wao-scorecard.json
```

Inline `--scorecard-rules '<json>'` is acceptable in shells with reliable single-quote handling. In PowerShell through `npm run cli --`, prefer the file form; inline JSON quoting is easy to corrupt before WAO sees it.

2. Per-agent in registry config:
```jsonc
{
  "test_runner": {
    "backend": "claude-code",
    "cwd": "D:/projects/my-app",
    "scorecard": { "rules": { "requireCommands": ["npm test"], "requireEvidence": true } }
  }
}
```

No explicit rules + default `warn` mode = `scorecard.warn` recorded on missing evidence, run still completes. Use `--scorecard-mode off` to fully disable; `--scorecard-mode hard` to hard-block. Explicit `--scorecard-rules` always takes precedence over the mode default.

**Inspect results**:
```
npm run cli -- runs scorecard <runId>
# passed: yes
#   ✔ hasDoneEvent: run.completed present
#   ✔ commandsPassed: 1 command(s) recorded
#   ✔ hasEvidence: 3 evidence event(s) found
```

**Note**: claude-code agents need `args: ["--dangerously-skip-permissions"]` in automated contexts, otherwise Write/Bash tools don't actually execute (they only emit intent).

## Reliability suite (post-change verification)

After modifying completion judgment, metrics extraction, or provider error handling, run the reliability suite to verify across the completion-mode × provider matrix with real API calls:

```
npm run reliability                      # full matrix (needs serve with keys)
npm run reliability -- --agent coder     # single agent
npm run reliability -- --profile strict  # adds command/file scorecard drill
```

The suite reads `certification.matrix` from `config/agents.json` when present; if absent it falls back to the legacy coder/researcher/Kimi matrix. Each matrix case names an `agentId`, optional label/profile, and `drills`.

Supported drills:
- `sentinel`: create files, ask the worker to read + report contents; catches pseudo-completion,背诵, and metrics discrepancies.
- `scorecard`: require `node --version`, file materialization, `requireEvidence`, and `requireAssistantText`.
- `isolation`: run with `--isolate` and verify output lands in the worktree, not the source cwd.
- `workflowRunDir`: run a one-node workflow and verify workflow + child transcripts share the requested run dir.
- `stop`: red-line drill for opencode abort. It verifies local ledger behavior and backend quietness after abort; successful real-provider certification records `backendStopQuietVerified` evidence in `runs/reliability-summary.json`.

The default `basic` profile is sentinel-first and intentionally reports strict-dispatch certification as `conditional` when command/file evidence was not exercised. Use `--profile strict` to force scorecard coverage across configured cases.

Output: `runs/reliability-summary.json`, a versioned certification report with per-case status plus `workers[agentId]` capability summaries for dispatch policy. Status values: `certified`, `conditional`, `draft-only`, `blocked`, or `rejected`. Consumes real tokens — not in `npm test`, run manually after significant changes. See `docs/milestone-discipline.md` §6.7.

## Deeper docs (read when needed)

- Architecture spec: `docs/02-architecture.md`
- Deployment & usage: `docs/usage.md`
- Roadmap & progress: `docs/roadmap.md`
- Research & design decisions: `docs/research/`
