// src/cliHelp.js
//
// P4-乙 Phase 1a: the CLI help text as a named, importable constant.
//
// WHY a separate module: src/cli.js ends with a self-executing main() — importing
// it RUNS the CLI. The docs/surface generator (scripts/gen-surface.mjs) and any
// other consumer import HELP_TEXT from here instead, with zero side effects.
//
// The string below is byte-identical to the historical inline printHelp()
// template literal that lived in src/cli.js (moved verbatim; the CLI's help
// output is unchanged byte-for-byte).

export const HELP_TEXT = `Windows Agent Orchestrator PoC

Commands:
  registry list --registry config/agents.json
  registry check [--registry config/agents.json] [--format json]
  registry validate [--registry FILE] [--format json]
  spawn <agentId> [agentId2 ...] --prompt "..." [--cwd DIR] [--registry FILE] [--run-dir DIR] [--wait] [--background] [--poll-interval MS] [--wait-timeout MS] [--tag key=value] [--isolate] [--scorecard-rules-file FILE]
  run <agentId> --prompt "..." [--prompt-file FILE] [--cwd DIR] [--registry FILE] [--run-dir DIR] [--poll-interval MS] [--wait-timeout MS] [--format json|text] [--isolate] [--require-certified] [--background] [--scorecard-rules-file FILE] [--delivery-spec-file FILE] [--read-only] [--model ID] [--reasoning EFFORT]
  status <runId> [--run-dir DIR] [--format json]
  tail <runId> [--limit N] [--follow] [--run-dir DIR]
  collect <runId> [--limit N] [--cursor TOKEN] [--mode full|compact] [--final] [--format json] [--run-dir DIR]
  stop <runId> [--run-dir DIR]
  retry <runId> [--wait] [--run-dir DIR] [--model ID] [--reasoning EFFORT]
  resume <runId> [--wait] [--run-dir DIR]
  runs list [--run-dir DIR] [--agent AGENT_ID] [--latest N] [--format json]
  runs summary [--run-dir DIR] [--format json]
  runs prune --older-than <duration> [--run-dir DIR]
  runs grep <pattern> [--run-dir DIR] [--format json]
  runs metrics <runId> [--run-dir DIR] [--format json]
  runs metrics --summary [--run-dir DIR] [--format json]
  runs scorecard <runId> [--run-dir DIR] [--format json]
  runs dashboard [--watch N] [--agent ID] [--latest N] [--format json] [--run-dir DIR]
  runs dashboard --web [--port N] [--run-dir DIR] [--cwd DIR]   # local read-only Owner dashboard
  dashboard [--cwd DIR] [--port N] [--run-dir DIR] [--no-open]  # Owner dashboard launcher (global wao command; auto-opens browser)
  runs diagnose <runId> [--run-dir DIR] [--format json]
  runs delivery <runId> [--run-dir DIR] [--format json]
  runs delivery <runId> --accept --reason-file FILE [--run-dir DIR] [--format json]
  runs delivery <runId> --reject --reason-file FILE [--run-dir DIR] [--format json]
  runs wait <runId> [--wait-ms N] [--format json|text] [--run-dir DIR]   # 阻塞等待终态或观察窗口到期（默认 text；窗口到期 exit 0）
  workflow run <name|file.mjs> [--input TEXT] [--registry FILE] [--isolate] [--wait-timeout MS] [--run-dir DIR] [--vars key=value...]
  workflow list                  # 列出可用模板（workflows/templates/）
  playbook list [--format json]              # 列出内置 Lead playbook 摘要（只读）
  playbook show <id> [--format json]         # 展示一个完整 Lead playbook（只读）
  worktree list [--cwd DIR]
  worktree remove <path> [--cwd DIR]
  daemon start [--run-dir DIR] [--registry FILE] [--pipe PIPE] [--resume-on-start]
  daemon run <agentId> --prompt "..." [--run-dir DIR] [--registry FILE] [--prompt-file FILE]
  daemon stop [--run-dir DIR]
  daemon ping [--run-dir DIR] [--pipe PIPE]
  daemon status <runId> [--run-dir DIR] [--pipe PIPE]
  daemon list [--run-dir DIR] [--pipe PIPE]
  daemon supervise [--run-dir DIR] [--registry FILE] [--idle-exit-ms MS]
  daemon supervisor status|stop [--run-dir DIR]
  daemon health [--run-dir DIR]

Workspace activation (host project binding):
  mcp bind --host codex --cwd <git-root>
  mcp status --host codex --cwd <git-root>
  mcp unbind --host codex --cwd <git-root>

Project state (.wao/):
  wao init [--cwd DIR] [--state-dir DIR]
  wao state read [--format text|json]
  wao state snapshot --workflow-id ID [--cwd DIR]
  wao decision add --title T [--body B | --body-file F] [--context C]
  wao decision list [--format json]
  wao decision show <id>
  wao declare --task T --reason <code> [--note N]  # Lead 自做声明（reason: too-coupled|too-small|high-constitutional-risk|verification-cheaper|needs-global-context）
  wao declare                                       # 列出已有声明 + 理由分布
  wao stage <n> --task T [--artifacts a,b] [--note N] [--panel-seats id[,id] | --panel-skip-reason <code>]  # Lead 阶段声明（n: 1=spec 2=plan 3=派发 4=验收 5=汇总 6=总结；panel 字段只在 2/4 登记：seats=自报副审、skip=跳过理由闭集码）
  wao stage                                            # 列出已声明阶段 + 缺口 + panel/skip 分布（pipeline 自省）
  wao ask <agentId> "<一句话任务>" [--mode write] [--cwd DIR]  # 快捷派工（只读默认注入边界；--mode write 不注入）
  wao handoff write --from R --to R --summary S [--artifacts a,b]
  wao handoff read <role> [--format json]  # latest incoming handoff addressed to role
  wao doctor [--cwd DIR] [--format json] [--warn-as-error]
  wao onboarding [--agent <id>] [--apply] [--endorse-worker <id>] [--json]  # third-party: generate one minimal private registry from the tracked template (+ host-neutral MCP snippet)
`;

// A-1（friction 2026-08-15 #1）：run <agentId> 的 agentId 位置误填顶层命令名时
// （如 `run status ...`）做 did-you-mean 提示。恰 17 名；不含 help（HELP_TEXT
// 无 help 命令行且字节冻结——评审裁定 (a)）。
export const COMMAND_NAMES = Object.freeze([
  "registry", "spawn", "retry", "resume", "run", "status", "tail", "collect",
  "stop", "runs", "dashboard", "workflow", "worktree", "wao", "daemon", "mcp", "playbook",
]);

// A-2（friction 2026-08-15 #2）：`run --help` 用法页。顶层 HELP_TEXT 字节冻结
// （docsSurface 生成层把 docs/surface/cli.md 与 generate() 输出做字节对比），
// run 的详细用法放在这里由 `run --help` 打印（--help 必须是 run 之后的第一个参数）。
export const RUN_USAGE_TEXT = `run <agentId> --prompt "..." [options]

Run one agent to completion and print a summary (default text format).

Flags:
  --prompt TEXT                  the task prompt (required unless --prompt-file is given)
  --prompt-file FILE             read the task prompt from FILE (multi-line safe)
  --cwd DIR                      target project directory (required for --background delivery runs) — must be an existing directory; a missing or non-directory path is refused at dispatch/start before any side effect
  --registry FILE                agent registry file (default config/agents.json)
  --run-dir DIR                  transcript directory (default runs/)
  --poll-interval MS             status poll interval in ms
  --wait-timeout MS              bounded wait timeout in ms (1000-600000)
  --format json|text             output format (default text)
  --isolate                      run in an isolated worktree
  --require-certified            dispatch only certified workers
  --background                   fork a detached runner and return immediately
  --scorecard-rules-file FILE    load scorecard rules from FILE (JSON)
  --scorecard-rules JSON         inline scorecard rules (JSON string)
  --tag key=value                tag the run
  --delivery-spec-file FILE      delivery mode spec (requires --isolate; a --background delivery run also requires --cwd)
  --read-only                    declare a read-only run (advisory observation; forces --isolate; mutually exclusive with --delivery-spec-file and --no-isolate)
  --model ID                     per-dispatch model override (one dispatch only, never written to the registry; replaces only the registry model's id — contextWindow/providerID/variant are preserved)
  --reasoning EFFORT             per-dispatch reasoning effort override (one dispatch only, never written to the registry; replaces only the registry reasoning's effort — minimal/low/medium/high/xhigh/max; composable with --model)

Notes:
  - The file given to --delivery-spec-file must contain the INNER delivery object
    itself ({"mode":"git_commit_v1",...}), WITHOUT an outer {"delivery": ...} wrapper.
  - A --background delivery run additionally requires an explicit --cwd: the
    delivery ownership record (run.background_submitted.cwd) is built from it,
    and the dispatch is refused before any side effect when it is missing.
  - --read-only declares advisory observation, never a gate: WAO observes
    tool-reported file writes (run_activity readOnlyObservation) but never
    auto-stops or fails the run on observed writes; final judgment is the Lead's.
  - --model VALUE must be a non-empty string of at most 128 characters, not
    starting with "--", with no whitespace or control characters (the
    background runner's flag parser would split a "--"-prefixed value). It is
    mutually exclusive with --require-certified (the certification matrix is
    recorded per provider+model, so any override voids the certified
    combination) and with provider-session reuse agents (a resumed
    conversation must run one model). A mistyped model id is only reported by
    the provider when the worker starts — the echoed "effective model" in the
    dispatch output is advisory: it shows what WAO threaded, not that the
    provider accepts the id. --model exists only on run and retry (not
    spawn/workflow/daemon); a persistent model change belongs in the registry
    model policy.
  - --reasoning VALUE must be one of the closed effort set
    minimal/low/medium/high/xhigh/max; anything else is refused with a fixed
    text (never echoing the value). It may be combined with --model (the
    per-dispatch "model + effort" pairing). It is mutually exclusive with
    --require-certified (any override voids the certified-combination claim)
    and with provider-session reuse agents (a resumed conversation must run
    one reasoning effort); when combined with --model against a reuse agent,
    the refusal names the override actually at fault. A backend that cannot
    express the effort (opencode-serve) or only a conditional subset
    (kimi-code K3-only, deepseek-harness high|max) refuses the dispatch
    through its existing policy gate with a hint naming --reasoning. The
    echoed "effective reasoning" is advisory in the same sense as the model
    echo. --reasoning exists only on run and retry (not
    spawn/workflow/daemon); a persistent reasoning change belongs in the
    registry reasoning policy.
  - --help must be the FIRST argument after run: npm run cli -- run --help
`;
