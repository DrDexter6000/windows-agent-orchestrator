# Windows Agent Orchestrator (WAO)

[![version](https://img.shields.io/badge/version-v0.7.0-2f2f2f?style=flat-square)](docs/changelog-2026-10-31-v0.7.0.md)
[![license](https://img.shields.io/badge/license-Apache--2.0-2f2f2f?style=flat-square)](LICENSE)

English · [简体中文](README.zh-CN.md)

**Rent judgment, buy labor, seat the council.**

Put your existing coding-agent subscriptions to work. WAO lets one Lead agent — or you,
from any MCP host — dispatch Claude Code, Codex, Kimi, GLM (ZCode) and DeepSeek workers
against real repositories: the token bill lands on each worker's own provider, every run
is captured as an auditable transcript, and the control plane never makes decisions for
you.

> **Value & boundary (ADR 0018):** WAO's value is routing worker token spend onto
> external provider quota — it lets a Lead dispatch real work to external worker runtimes
> so the token bill lands on the worker's provider, instead of pulling the work back into
> the Lead's own context. WAO is an assisted execution control plane, not a gate and not a
> second semantic supervisor. WAO 自动监测，不自动监督；自动封装，不自动验收；自动呈现，不自动决策。
> (English: WAO monitors, never supervises; packages, never accepts; presents, never decides.)

> **New to WAO?** Start with [`AGENT_ONBOARDING.md`](AGENT_ONBOARDING.md) — the one
> authoritative path from zero to a working setup: install WAO, configure **ONE** worker,
> validate it, connect an MCP Host, and run a first read-only canary. You do **not** need
> every runtime or provider credential to start.

## Why WAO

- **Route the token bill** — workers run on their own provider quota; the Lead's context
  stays small and cheap.
- **First-party harnesses** — WAO drives each vendor's own CLI directly (no protocol
  re-implementation): ZCode for GLM, the Kimi desktop web channel, Codex CLI, DeepSeek
  over ACP. All 8 seats in the reference fleet run on first-party harnesses; 7 backend
  adapters are supported in total — per-axis facts in the generated
  [capability matrix](docs/surface/certification.md).
- **Transcript is the source of truth** — every run reconstructable from
  the run's transcript (bucketed `runs/projects/<slug>/<runId>.jsonl` or legacy flat); delivery review is bounded and redacted, never a raw diff.
- **Monitors, never supervises** — WAO observes, packages, and presents evidence; the
  semantic call (accept, reject, rework) always belongs to the Lead.
- **Windows-native, minimal footprint** — plain Node ESM; two direct production
  dependencies (`@modelcontextprotocol/sdk` + `zod`, confined to `src/mcp/**`); no
  Docker/WSL; worktree isolation and process-tree cleanup tuned for Windows.

## A staffing model for intelligence

- **Rent judgment, buy labor** — seat your strongest model as advisor and auditor
  (plan review, delivery gating) and let cost-efficient models do the bulk of the work.
  A $200-tier subscription on every seat is not a prerequisite; frontier-grade review is
  applied where you decide it matters.
- **A council beats a genius — and costs less than one.** Cross-family, multi-seat
  review brings several top models to one decision chain; model families err
  differently, so cross-examination covers blind spots. The pattern has independent
  backing — OpenRouter's Fusion council [reports](https://openrouter.ai/blog/announcements/fusion-beats-frontier)
  cheaper panels outscoring frontier flagships, and the Mixture-of-Agents paper
  ([arXiv:2406.04692](https://arxiv.org/abs/2406.04692)) topped GPT-4 Omni on
  AlpacaEval 2.0 with open-source models only. WAO turns the same principle into
  review discipline: advice is recorded, the Lead decides. Results depend on task and
  configuration.

## What's new in v0.7.0 (2026-10-31)

- **The Lead hears when a run settles, on any host** — `wao runs wait <runId> --until-settled`
  exits only once the run has settled: terminal and, for a delivery, its verification and any
  reverify have results; MCP `run_delivery` with `waitMs` waits for settlement the same way;
  unsettled waits and accepted dispatches carry a `nextStep`; the four MCP wait tools default
  to 45 s so they fit hosts that time a tool call out after about a minute (decision 0095). The waiter
  exits with `verifier_gone` when it can prove that a pending delivery's verifier is gone,
  and consult receipts say how to keep waiting on unfinished seats (0096).
- **Lane facts where the Lead decides** — the lane profile holds the Owner's cost tiers,
  measured scores and lane rules in one place; `wao lanes` opens with a one-screen table,
  dispatch echoes the chosen lane's facts, and `lead_preflight` lane rows say whether a lane
  takes video (0097, 0098). Measured facts may replace an Owner note once the Owner confirms.
- **Delivery reads say more, fewer deliveries get stuck** — `run_delivery` shows whether a
  commit on the main branch declares adoption of the run (`WAO-Adopted-From`, three states;
  0098); a delivery dispatched with `verificationUnavailableReason` can be accepted after
  Lead review instead of only rejected (0101).
- **Run storage that does not fall over** — runs dispatched from a linked dev worktree go
  into the main project's bucket (0099); runId lookups scan every bucket with no limit, and
  above 64 buckets `lead_preflight` shows one facts-only line (0100).
- **Correctness** — text files bound for the repository (tracked, plus untracked and not
  ignored) are guarded against control bytes and invalid UTF-8; diagnosis names deepseek-acp
  transport failures; the MCP server build check looks at `src/` only.
- Scope by decision and release-gate evidence:
  [`docs/changelog-2026-10-31-v0.7.0.md`](docs/changelog-2026-10-31-v0.7.0.md).

## Current status

WAO is an **MCP-first control plane** (Decision 0017). A lead agent runtime — Claude
Desktop, Codex CLI, OpenCode, or any MCP host — drives WAO as a stdio MCP server. WAO
owns dispatch, state, isolation, transcripts, delivery verification, and durable Lead
accept/reject decision recording (it records the Lead's decision; it does not accept or
reject for the Lead); workers receive only a bounded task prompt and stay out of
orchestration.

WAO exposes **23 MCP tools** covering the supervised Lead loop:

> `inventory → workspace_status → dispatch → await result → delivery query/review → Lead decision`

plus `runs_list` recovery. `run_consult` (CLI `wao consult`, a.k.a. the **Agent Union**)
convenes bounded multi-seat, cross-family consultations: mechanical fan-out, verbatim
collection, and a council-diff view that places each seat's full original answer side
by side (CLI renders in full; the MCP face returns a capped receipt and pages each
seat's answer losslessly — decision 0051) — advice is recorded, never auto-synthesized;
the Lead reads the divergence and
decides. The playbook catalog is read on demand via MCP resources
(`wao://playbooks`), not tools. Every state-changing operation calls the same shared
application service as the CLI fallback, producing identical transcript durable facts.
See [`SKILL.md`](SKILL.md) for the tool table and routing contract.

**Milestones:** progress and per-milestone scope live in
[`docs/roadmap.md`](docs/roadmap.md) — the single authority for milestone
progress (this README deliberately does not restate the completed range here).

By default, certification is advisory evidence about a worker's recorded reliability, not a
dispatch permission gate; the Owner can switch on an MCP-boundary gate that dispatches only
certified lanes. Two-tier verification, the delta certification procedure, and the
upstream-primitive refresh SOP live in
[`docs/certification-runbook.md`](docs/certification-runbook.md); live per-worker status:
`npm run cli -- registry list`. Milestone history:
[`docs/roadmap.md`](docs/roadmap.md); open debt: [`docs/tech-debt.md`](docs/tech-debt.md).

## Quick start

Follow [`AGENT_ONBOARDING.md`](AGENT_ONBOARDING.md):

- §3 Prerequisites — environment checks, including the supported Node version
- §4a Install WAO itself — one-command installer or manual steps; upgrade & rollback
- §4b Install the WAO skill into your agent runtime
- §4c Configure ONE worker — registry template and the per-runtime auth choice table
- §4d Validate the registry and self-check the environment
- §4e Connect an MCP host — `mcp bind` and per-host registration
- §4f First read-only canary

## Documentation map (single source of truth)

| You want to… | Read this |
|---|---|
| **Start from zero — install, one worker, validate, MCP host, first canary** | [`AGENT_ONBOARDING.md`](AGENT_ONBOARDING.md) — the single new-user setup path |
| **Use the orchestrator as an agent / from a script** (23 MCP tools, commands, config) | [`SKILL.md`](SKILL.md) — the agent-facing usage manual + tool table |
| **Deploy / configure / operate it as a human** | [`docs/usage.md`](docs/usage.md) — map of the deployment and usage pages |
| **Look up a tool parameter or CLI flag** | [`docs/surface/`](docs/surface/) — generated reference (regen: `npm run gen:surface`); repo index: [`llms.txt`](llms.txt) |
| **Compare backend capabilities / understand certification** | [`docs/surface/certification.md`](docs/surface/certification.md) (generated) + [`docs/certification-runbook.md`](docs/certification-runbook.md) |
| **Check live per-worker dispatch certification** | `npm run cli -- registry list` (data: `runs/reliability-summary.json`, gitignored, generated by `npm run reliability`) |
| **See what shipped in each release** | `docs/changelog-*.md` snapshots (latest: [v0.7.0](docs/changelog-2026-10-31-v0.7.0.md)) |
| **Run real smoke tests** (claude/codex) | [`docs/smoke-guide.md`](docs/smoke-guide.md) |
| **Know when to run the full suite vs targeted tests** | [`docs/testing.md`](docs/testing.md) |
| **Understand the architecture** (layers, interfaces, state machine) | [`docs/02-architecture.md`](docs/02-architecture.md) |
| **See requirements / non-goals / acceptance** | [`docs/01-prd.md`](docs/01-prd.md) |
| **Track milestones / progress** | [`docs/roadmap.md`](docs/roadmap.md) |
| **See open tech debt** | [`docs/tech-debt.md`](docs/tech-debt.md) |
| **Read research / design decisions** | [`docs/research/`](docs/research/) |

Repository contribution guidelines (principles, coding style, constraints) live in
[`AGENTS.md`](AGENTS.md).

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright © 2026 DrDexter6000.
