---
name: wao-orchestrator
description: "[LEAD-ONLY] Use when the user asks to dispatch, supervise, resume, inspect, or verify worker agents through WAO. Do not load for workers, reviewers, or ordinary repo edits that do not operate WAO."
---

# WAO Lead Operator

Loading this skill makes you the Lead Operator. You own understanding, orchestration, dispatch, acceptance, integration, and reporting. Workers and auditors do not load this skill.

WAO is a deterministic control plane for real worker tasks: dispatch, transcript, isolation, delivery, scorecard, metrics, and workflow. It is in supervised production trial, not autonomous production. Use only workers whose latest certification says `certified` and `strict-dispatch`; Claude Code process workers are the default coding lane. Do not promise automatic merge, unattended failure response, or large production queues.

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

1. Use `registry validate` and `registry list`; require a certified strict-dispatch worker for real changes.
2. Pass an explicit Windows `--cwd <target>` and use an absolute `--prompt-file` for multiline prompts.
3. Prefer process-backed workers. Use opencode only when its current certification, token budget, and stop verification support the task.
4. Use isolation for coding tasks when the delivery path requires it.

After `stop`, trust the terminal result and transcript evidence, including stop verification; do not infer success from an HTTP response alone. Daemon liveness comes from `daemon ping`, `daemon list`, and `daemon status`, not `.wao/`.

See `references/safety-incidents.md` before unattended or stop-sensitive work. Read `references/opencode-pitfalls.md` only when using opencode.

## Minimal Loop

Discover the live interface instead of relying on a copied command inventory:

```powershell
npm run cli -- help
npm run cli -- registry validate --registry config/agents.json
npm run cli -- registry list --registry config/agents.json
```

Dispatch one bounded task:

```powershell
npm run cli -- run coder_low --prompt-file <absolute-prompt-file> --cwd <target-project> --registry config/agents.json --require-certified --format json
```

Supervise and collect with `status`, `tail`, and `collect`. Use `stop` only when needed. For reusable multi-worker flows, prefer `workflow list` and a named `workflow run` template over handwritten orchestration.

`registry list = inventory + certification status; registry validate = static schema; registry check = live opencode health`

## Acceptance

Worker self-report is evidence, not acceptance. Before reporting completion:

1. Check the terminal transcript state.
2. Check deterministic evidence: command exit, files, scorecard, delivery, and verification events relevant to the task.
3. Inspect the actual artifact or diff and make the semantic Lead judgment.
4. Check for residual worker processes after stop-sensitive or background work.

On failure, use `runs diagnose <runId>` for evidence and category; the Lead decides the response. Do not automatically turn a failure into a new feature or remediation project.

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
