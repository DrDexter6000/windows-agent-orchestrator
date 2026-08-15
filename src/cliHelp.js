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
  run <agentId> --prompt "..." [--prompt-file FILE] [--cwd DIR] [--registry FILE] [--run-dir DIR] [--poll-interval MS] [--wait-timeout MS] [--format json|text] [--isolate] [--require-certified] [--background] [--scorecard-rules-file FILE] [--delivery-spec-file FILE]
  status <runId> [--run-dir DIR] [--format json]
  tail <runId> [--limit N] [--follow] [--run-dir DIR]
  collect <runId> [--limit N] [--cursor TOKEN] [--mode full|compact] [--final] [--format json] [--run-dir DIR]
  stop <runId> [--run-dir DIR]
  retry <runId> [--wait] [--run-dir DIR]
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
  wao stage <n> --task T [--artifacts a,b] [--note N]  # Lead 阶段声明（n: 1=spec 2=plan 3=派发 4=验收 5=汇总 6=总结）
  wao stage                                            # 列出已声明阶段 + 缺口（pipeline 自省）
  wao ask <agentId> "<一句话任务>" [--mode write] [--cwd DIR]  # 快捷派工（只读默认注入边界；--mode write 不注入）
  wao handoff write --from R --to R --summary S [--artifacts a,b]
  wao handoff read <role> [--format json]  # latest incoming handoff addressed to role
  wao doctor [--cwd DIR] [--format json]
  wao onboarding [--agent <id>] [--apply] [--endorse-worker <id>] [--json]  # third-party: generate one minimal private registry from the tracked template (+ host-neutral MCP snippet)
`;
