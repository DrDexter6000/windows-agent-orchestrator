---
name: wao-orchestrator
description: "[LEAD-ONLY] Use when the user asks to dispatch, supervise, resume, inspect, or verify worker agents through WAO. Do not load for workers, reviewers, or ordinary repo edits that do not operate WAO."
---

# WAO Lead Operator

Loading this skill makes you the Lead Operator. You own understanding, orchestration, dispatch, acceptance, integration, and reporting. Workers and auditors do not load this skill.

WAO is an MCP-first, Skill-guided, CLI-backed deterministic control plane for real worker tasks: dispatch, transcript, isolation, delivery, scorecard, metrics, and workflow. The Lead uses MCP tools as the primary interface; CLI is for human/ops/debug/fallback. It is in supervised production trial, not autonomous production. Use only workers whose latest certification says `certified` and `strict-dispatch`; Claude Code process workers are the default coding lane. Do not promise automatic merge, unattended failure response, or large production queues.

## Mainline

Before expanding work, stop at the first true line:

1. It does not block the current roadmap item: defer it.
2. A smaller containment lets the roadmap continue: do that and stop.
3. It creates a new subsystem, protocol, persistent state, or separate workstream expected to exceed half a day: ask the Owner first.
4. Otherwise make the minimum change that advances the roadmap item.

For an active safety incident, contain immediate harm first. Full remediation is a separate Owner-approved task.

## Dispatch

1. A narrow implementation with a clear acceptance oracle: dispatch one coder first.
2. Truly independent tasks: dispatch workers in parallel.
3. Tiny, tightly coupled, or Lead-context-heavy work: the Lead may do it directly.
4. Add a Tester when independent execution evidence is useful. Add an Auditor only for high risk, semantic uncertainty, or low Lead confidence.
5. Do not manufacture subtasks or reviewers to satisfy a worker count.

Use `docs/team-roles.md` and the current registry to choose a worker. The Lead owns the verdict even when deterministic gates pass.

## Workflow Size

- Simple read-only or tiny Lead task: do it directly.
- One bounded worker task: dispatch, supervise, accept, report.
- Two or more independent workers, cross-session work, or an explicitly audited engagement: use the six-stage pipeline: understand, plan, dispatch, accept, integrate, report.

For a tracked complex pipeline, `wao stage` records stage progress and `wao declare` records a Lead self-work deviation. Run bare `wao stage` or `wao declare` to inspect the current stages and reason codes. Do not use either command as ceremony for a trivial task.

## Worker Contract

A worker prompt contains only:

- the bounded task and permitted paths;
- read/write and environment constraints;
- the required acceptance command or observable result;
- the expected final response shape.

Workers do not receive the roadmap, other-worker context, or Lead orchestration duties. They return their result in the final assistant response. WAO and the Lead own transcript, delivery, handoff, state, and pipeline records.

Never put credentials or secret values in a worker prompt. For read-only work, explicitly forbid writes, installs, and environment changes. For coding work, authorize exact paths and require an independent verification command.

## Safety Preflight

Before dispatch:

1. Use MCP `registry_list` to confirm worker availability and certification status; require a certified strict-dispatch worker for real changes.
2. For static schema checks, `registry validate`/`doctor`/debug, use CLI fallback.
3. Host MCP/provider/auth configuration belongs to the host runtime, not WAO. Never put credential values in worker prompts, MCP arguments, or the repository.
4. Delivery runs force persistent worktree isolation automatically — the model cannot override `isolate`.

After `stop`, trust the terminal result and transcript evidence, including stop verification; do not infer success from an HTTP response alone. Daemon liveness comes from `daemon ping`, `daemon list`, and `daemon status`, not `.wao/`.

See `references/safety-incidents.md` before unattended or stop-sensitive work. Read `references/opencode-pitfalls.md` only when using opencode.

## Minimal MCP Loop

The Lead drives the full minimal loop through 8 MCP tools:

| Tool | Side effect | Purpose |
|---|---|---|
| `registry_list` | read-only | Inventory + certification status |
| `workspace_status` | read-only | Query host-authorized workspace binding (M10-pre2) |
| `run_dispatch` | destructive | Create a supervised run (with optional delivery block for git_commit_v1); workspace is server-owned, not model-controlled |
| `run_status` | read-only | Poll terminal state + last activity |
| `run_collect` | appends `messages.collected` (non-idempotent) | Collect bounded worker output |
| `run_diagnose` | read-only | Failure category + signal types (no prescription) |
| `run_delivery` | read-only | Query delivery commit/verification/acceptance |
| `run_delivery_decide` | durable (first-decision-wins) | Record Lead accept/reject |

Minimal closed loop: `inventory → workspace_status → dispatch → status → collect/diagnose → delivery query → Lead decision`

See `docs/usage.md §MCP stdio` for host setup, full input/output schemas, and install instructions.

CLI (`npm run cli --`) remains available for human/ops/debug/fallback, including `registry validate`, `registry check`, `daemon`, and `runs dashboard`. `registry list = inventory + certification status; registry validate = static schema; registry check = live opencode health`. `mcp bind/status/unbind` is a Human Owner ops command for project-level workspace activation (M10 P0-1); see `docs/usage.md §项目级 Workspace Activation`.

## Acceptance

Worker self-report is evidence, not acceptance. Verification/scorecard/worker output are not semantic acceptance. Before recording acceptance:

1. Check terminal state via `run_status`; collect output via `run_collect`; diagnose on failure via `run_diagnose`.
2. `run_delivery` shows verification result and acceptance status, but does not return changed paths or raw diff. When semantic judgment requires inspecting the artifact or diff, use Owner-authorized repo-local read-only Git/CLI — do not blindly accept on `verification=passed` alone.
3. Record the verdict with `run_delivery_decide` (first-decision-wins, irreversible through MCP).
4. The Lead owns the final decision even when all deterministic gates pass.

On failure, `run_diagnose` gives category + evidence; the Lead decides the response. Do not automatically turn a failure into a new feature or remediation project.

## Scorecard

Scorecard defaults to `warn`; use `--scorecard-mode hard` only when missing evidence must block completion, and `off` only deliberately. Put non-trivial rules in a file and pass `--scorecard-rules-file`; do not fight PowerShell inline JSON quoting.

Scorecard proves recorded evidence, not semantic correctness. Delivery verification proves the packaged artifact, not worker conduct or credential compliance.

## State and Handoff

Run truth lives in `runs/<runId>.jsonl`. Project decisions and cross-session handoffs use `.wao/` commands. Do not create parallel handwritten current-state files.

## Read On Demand

- Architecture and event contracts: `docs/02-architecture.md`
- Current roadmap: `docs/roadmap.md`
- Full CLI and transcript reference: `docs/usage.md` and `npm run cli -- help`
- Worker roles: `docs/team-roles.md`
- Runtime certification: `docs/milestone-discipline.md`
- Failure diagnosis: `docs/troubleshooting.md`
- Safety history: `references/safety-incidents.md`
- Optional opencode lane: `references/opencode-pitfalls.md`

At the end of each batch report one line:

`mainline: <before> -> <after>; next: <shortest next step>`
