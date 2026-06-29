# Dispatch Readiness Review（2026-06-17）

> 状态：历史记录，已取代。
> 背景：站在 life index 主控 / 主编排 agent 的身份，判断 WAO 是否可放心 dispatch 真实任务。
> 当时结论：NO-GO for production dispatch。
> 当前结论已由 2026-06-18 runtime certification 取代：见 `docs/research/10-runtime-driver-comparison-2026-06-18.md`、`docs/roadmap.md`，以及最新 `runs/reliability-summary.json`。不要把本文件作为当前 dispatch 状态权威。

## 已确认能力

- `npm test`：268 pass / 0 fail。
- `registry validate`：`coder`、`researcher`、`coder_strict` 有效。
- `registry check`：opencode `coder` / `researcher` 可达 `http://127.0.0.1:4298`。
- sentinel 读取、silentTimeout 结构化失败、`run --wait-timeout`、worktree 隔离、file-based scorecard、workflow gate、fan-out、reliability suite 均已有通过样本。

## NO-GO 阻断项

### P0：控制面状态不可信

证据：

- `runs/wao-prod-drill-20260617/run_2026061722145438244njj5.jsonl`
- `runs/wao-prod-drill-20260617/run_20260617222032072oict3m.jsonl`
- `runs/wao-prod-drill-20260617/run_20260617222032072ykxql2.jsonl`

问题：

- `stop` 追加了 `run.stop_requested`，但 run 状态仍由旧 `run.state_change` 推断为 `submitted`。
- `stop` 追加事件时 `seq` 从 6 回到 1，破坏 transcript 单调序列。
- `collect` 也会在 completed transcript 末尾追加 `seq:1`，说明这是所有历史 transcript 追加路径的游标恢复问题，不是 stop 单点问题。

根因候选：

- `src/cli.js` 的 `loadRun()` 重开 transcript 后没有设置 `transcript.seq = findLastEventSeq(events)`。
- `stopCommand()` 绕过 RunManager，只写 `run.stop_requested`，不写 terminal `run.aborted` / `run.state_change`。

### P0：workflow 证据归档和状态口径不可信

证据：

- `runs/wao-prod-drill-20260617/wf_20260617221815325.jsonl`
- `runs/wao-prod-drill-20260617/wf_20260617221857146.jsonl`

问题：

- workflow 自己写入指定 `--run-dir`，但子节点 run 未继承该 `runDir`，同一 workflow 的证据链被拆到默认 `runs/`。
- 已出现 `workflow.completed` 的 workflow 被 `runs list` / `runs summary` 显示为 `running`。

根因候选：

- `workflowRunCommand()` 创建 workflow transcript 时使用了 resolved `runDir`，但没有把该 `runDir` 传入子节点 `RunManager.start()`。
- `findState()` 不识别 `workflow.completed`，也没有 workflow 级 `run.state_change`。

### P0：requireCommands 不能作为生产验收门

证据：

- Claude：`runs/wao-prod-drill-20260617/run_20260617222328448kp6tj9.jsonl`
- Codex：`runs/wao-prod-drill-20260617/run_20260617222211121runkss.jsonl`

问题：

- Claude 实际运行 `node --version`，`tool_result` 成功返回 `v24.13.1`，但 `command` evidence 没有 `exitCode`，scorecard 判失败。
- Codex command evidence 有 `exitCode:-1`，scorecard 判失败；需要进一步判断是 Codex runtime 在 Windows 下命令执行失败，还是 WAO 解析/调用方式缺陷。

根因候选：

- Claude parser 当前在 `tool_use` 阶段生成 `commandEvent(command)`，这是“意图”而不是“结果”；后续 `tool_result` 没有回填 exit semantics。
- Codex parser 只保留 `command` + `exit_code`，没有保留 `status` / `aggregated_output` / raw item 摘要，导致诊断信息不足。

### P1：opencode evidence 仍不足

证据：

- TD-33 已登记，`docs/research/07-opencode-smoke-and-weeds.md` 已勘测 schema。
- 本轮 drill 中 GLM 可做事，但 transcript 没有 opencode tool evidence。

问题：

- opencode worker 适合作为执行 worker，但不能作为严格 evidence-gated worker。
- `coder` 是主力 worker，若它没有 evidence，WAO 的核心 promise 会被削弱。

根因候选：

- `opencodeServe.streamEvents()` 只把 message parts 原样透传为 message，没有把 `type:"tool"` part 提取为 `command` / `file_written` / `tool_use` / `tool_result` evidence。

### P1：snapshot-stable 等待和重复输出风险

证据：

- 简单 `PARALLEL_OK` fan-out 里，GLM run 大约 35 秒才收束，`messageCount:6`。

问题：

- 不是绝对阻断，但会增加 dispatch latency 和不确定性。
- 需要把“正常会完成”和“足够适合生产调度”分开验证。

## 修复计划

### P0：先修控制面可信度

1. `loadRun()` 读取 events 后设置 transcript seq 为历史最大值，覆盖 `stop`、`collect`、`retry`、`resume` 等所有历史追加路径。
2. `stop` 成功 abort 后写入 terminal evidence：`run.aborted` + `run.state_change -> aborted`；失败时写结构化 `run.error phase=stop`。
3. workflow 子节点继承 resolved `runDir`，保证 workflow transcript 和 child run transcript 在同一证据目录。
4. workflow 状态统一进入 run state 口径：优先方案是 workflow 也写 `run.state_change`；最低限度是 `findState()` 识别 `workflow.completed`。

### P1：修证据链可信度

1. Claude parser 建立 `tool_use_id -> tool_use` 关联。Bash 的 command evidence 应在 `tool_result` 到达后生成或补全，并给出可解释的 `exitCode` / `status`。
2. Codex parser 增加 `status`、`output`、raw diagnostic 字段；对 Windows `exitCode:-1` 做真实 smoke 定界。
3. 落 TD-33：opencode tool part 提取规则：
   - `bash` -> `commandEvent(input.command, statusExitCode)`
   - `write` / `edit` -> `fileWrittenEvent(input.filePath)`
   - 其它工具 -> `toolUseEvent(tool, input)`
   - 所有 tool part -> `toolResultEvent(tool, output, isError)`
4. scorecard 对 `requireCommands` 区分“命令意图已出现”和“命令结果已确认”，避免把未完成/未知退出码当作可验收证据。

### P2：补 dispatch-readiness 套件

新增显式真实调用套件，例如 `npm run dispatch-readiness`，输出 `runs/dispatch-readiness-summary.json`。建议最小用例：

- stop drill：长跑 run 被 stop 后状态必须是 `aborted`，seq 单调。
- collect drill：completed run 多次 collect 后 seq 仍单调，状态不倒退。
- workflow drill：自定义 `--run-dir` 下 workflow + child runs 全部归档在同一目录，summary 不出现假 `running`。
- command gate drill：Claude / Codex / opencode 分别跑成功命令和失败命令，scorecard 正确 pass/fail。
- opencode evidence drill：GLM 写文件 + 跑命令，`requireFiles + requireCommands + requireEvidence` 全过。
- snapshot-stable drill：简单答复任务不得重复多轮或超过阈值。

## 当前使用策略

修复完成前：

- 不用于 life index 正式 CLI WP dispatch。
- 不用于需要 command/test exitCode 作为验收依据的任务。
- 不用于 workflow/DAG 证据链归档任务。
- 不用于需要 stop/abort 可审计的长跑任务。
- 不用于 opencode strict evidence-gated worker。

可接受：

- 单次 researcher/coder 只读分析或草稿生成。
- 主控手动 collect、手动验收，不让 scorecard 替主控下最终结论。

## 后续归档建议

- 实施修复时，把 P0/P1 拆成正式 TD 条目或更新现有 TD-4 / TD-33。
- 修复完成后，把本文件的 NO-GO 更新为 dispatch-readiness 复测记录，而不是在本文件维护长期进度。
