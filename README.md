# Windows Agent Orchestrator (WAO)

[![version](https://img.shields.io/badge/version-v0.2.0-2f2f2f?style=flat-square)](docs/changelog-2026-10-01-v0.2.0.md)
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
  over ACP. All 8 seats in the reference fleet run on first-party harnesses; 8 backend
  adapters are supported in total — per-axis facts in the generated
  [capability matrix](docs/surface/certification.md).
- **Transcript is the source of truth** — every run reconstructable from
  `runs/<runId>.jsonl`; delivery review is bounded and redacted, never a raw diff.
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

## What's new in v0.2.0 (2026-10-01)

- All 8 worker seats now run on first-party vendor harnesses (new backends: zcode,
  kimi-web, deepseek-acp).
- Six-axis backend capability matrix and two-tier certification published as a generated
  surface: [`docs/surface/certification.md`](docs/surface/certification.md).
- Semver adopted; release-gate evidence (251/251 tests green, dated 2026-10-01) in
  [`docs/changelog-2026-10-01-v0.2.0.md`](docs/changelog-2026-10-01-v0.2.0.md).

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

**Milestones M0–M12 complete.** Delivered highlights: multi-backend dispatch with
worktree isolation, resume, and token/cost metrics; declarative DAG workflows and
parameterized templates; evidence-chain scorecards; daemon supervision, diagnostics, and
runtime certification; workspace-bound dispatch/recovery/stop with `run_wait` liveness
observation; safe changed-path projection, exact delivery proof, and bounded/redacted
diff review; advisory `candidateInventory` recovery for retained `disallowed_path`
failures plus Lead-authorized, model-free `run_delivery_repackage` (re-check and re-verify
the original worktree, base, and verification declaration without calling the worker
model again); `run_continue` correction lineages; the 23-tool frozen MCP surface; and
per-command execution budgets.

Certification is advisory evidence about a worker's recorded reliability, not a dispatch
permission gate. Two-tier verification, the delta certification procedure, and the
upstream-primitive refresh SOP live in
[`docs/certification-runbook.md`](docs/certification-runbook.md); live per-worker status:
`npm run cli -- registry list`. Milestone history:
[`docs/roadmap.md`](docs/roadmap.md); open debt: [`docs/tech-debt.md`](docs/tech-debt.md).

## Quick start

```powershell
# One-command install (thin wrapper over the steps below; defaults to %USERPROFILE%\wao):
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/DrDexter6000/windows-agent-orchestrator/main/install.ps1 | iex"
# Manual equivalent:
git clone https://github.com/DrDexter6000/windows-agent-orchestrator.git D:\projects\windows-agent-orchestrator
cd D:\projects\windows-agent-orchestrator
npm ci            # install from the tracked package-lock (npm install works as a fallback)
npm link          # optional, once per machine: exposes the top-level `wao` command (e.g. `wao dashboard`)

# 1. Configure the agent registry — start with ONE worker
#    Automated path (recommended): generates a single-worker config/agents.json
#    from the tracked template and prints an MCP snippet:
#      npm run cli -- wao onboarding --agent <id> --apply
#    (run it BEFORE any manual copy — it refuses to overwrite an existing
#    config/agents.json). Manual equivalent below:
Copy-Item config/agents.example.json config/agents.json
#    agents.example.json is the TRACKED template, aligned one-to-one with the
#    canonical team roles — leave it untouched. Your copied agents.json is
#    gitignored and yours to prune: keep only the workers whose runtime/auth
#    path you actually have, delete the rest. One runtime is enough to use WAO.
#    The per-runtime auth choice table is in AGENT_ONBOARDING.md.
#    Edit each kept worker's cwd to the project it should operate on.

# 2. Verify the registry (no runtime needed for this)
# registry list = inventory + certification status; registry validate = static schema; registry check = live opencode health
npm run cli -- registry list --registry config/agents.json
npm run cli -- registry validate --registry config/agents.json
#    registry check probes a live opencode-serve backend (maintenance lane) —
#    it only applies if you kept the opencode fallback worker and started scripts/serve.ps1.

# 3. Connect an MCP Host (primary control surface — Decision 0017)
#    Run this from the WAO install root (the repo you cloned). Point any MCP
#    host (Claude Desktop / Codex / OpenCode) at this stdio entry; host-specific
#    absolute command/args examples live in docs/usage.md §MCP stdio:
npm run mcp -- --registry config/agents.json --run-dir runs
#    The host authorizes the workspace (roots/list / workspace_select);
#    --cwd below only steers CLI-side workspace observation.

# 4. First read-only canary via the CLI fallback (one retained worker)
#    Replace <agentId> with one worker id from `registry list` in step 2 — the
#    canary works for ANY retained process worker:
npm run cli -- run <agentId> --prompt "Read package.json and summarize what WAO does" --cwd <target-project> --registry config/agents.json --format json
#    <target-project> must be an existing directory on this machine — a brand-new
#    machine can temporarily use the WAO repo itself (the read-only canary has
#    no side effects on it); see AGENT_ONBOARDING.md §4f.
```

Full step-by-step instructions for steps 1–4, including per-runtime auth,
live in [`AGENT_ONBOARDING.md`](AGENT_ONBOARDING.md).

Node **v22 only** (`node --version`; `engines.node` is `>=22 <23`). v24 is now the
Active LTS but is rejected by WAO's version guard — a libuv Windows Job Object
regression in v24 kills long-lived spawned child processes. All WAO npm scripts
route through the v22 shim (`scripts/wao-node.cjs`), so a default-v24 machine
works as long as Node 22 is installed at the conventional path (or `WAO_NODE`
is set); see AGENT_ONBOARDING.md §3.

## Documentation map (single source of truth)

| You want to… | Read this |
|---|---|
| **Start from zero — install, one worker, validate, MCP host, first canary** | [`AGENT_ONBOARDING.md`](AGENT_ONBOARDING.md) — the single new-user setup path |
| **Use the orchestrator as an agent / from a script** (23 MCP tools, commands, workflows, config) | [`SKILL.md`](SKILL.md) — the agent-facing usage manual + tool table |
| **Deploy / configure / operate it as a human** | [`docs/usage.md`](docs/usage.md) — full deployment + usage guide |
| **Look up a tool parameter or CLI flag** | [`docs/surface/`](docs/surface/) — generated reference (regen: `npm run gen:surface`); repo index: [`llms.txt`](llms.txt) |
| **Compare backend capabilities / understand certification** | [`docs/surface/certification.md`](docs/surface/certification.md) (generated) + [`docs/certification-runbook.md`](docs/certification-runbook.md) |
| **Check live per-worker dispatch certification** | `npm run cli -- registry list` (data: `runs/reliability-summary.json`, gitignored, generated by `npm run reliability`) |
| **See what shipped in each release** | `docs/changelog-*.md` snapshots (latest: [v0.2.0](docs/changelog-2026-10-01-v0.2.0.md)) |
| **Run real smoke tests** (claude/codex/opencode) | [`docs/smoke-guide.md`](docs/smoke-guide.md) |
| **Understand the architecture** (layers, interfaces, state machine) | [`docs/02-architecture.md`](docs/02-architecture.md) |
| **See requirements / non-goals / acceptance** | [`docs/01-prd.md`](docs/01-prd.md) |
| **Track milestones / progress** | [`docs/roadmap.md`](docs/roadmap.md) |
| **See open tech debt** | [`docs/tech-debt.md`](docs/tech-debt.md) |
| **Read research / design decisions** | [`docs/research/`](docs/research/) |

Repository contribution guidelines (principles, coding style, constraints) live in
[`AGENTS.md`](AGENTS.md).

## Commands (overview)

WAO is MCP-first (Decision 0017); the CLI is a human/ops fallback that calls the
same shared application services.

```powershell
# MCP server (primary control surface — point any MCP host here)
npm run mcp -- --registry config/agents.json --run-dir runs

# CLI fallback — common Lead loop
npm run cli -- run <agentId> --prompt "..."             # dispatch + wait
npm run cli -- spawn <agentId> --prompt "..."           # fire-and-forget
npm run cli -- status|tail <runId>                      # observe
npm run cli -- collect <runId> [--cursor T --format json]   # bounded worker output + continuation
npm run cli -- runs diagnose <runId>                    # failure category
npm run cli -- runs delivery <runId>                    # changed-path projection
npm run cli -- runs delivery review <runId>             # safe bounded/redacted diff review
npm run cli -- stop <runId>                             # stop a runaway worker
npm run cli -- runs list                                # recovery inventory
npm run cli -- runs metrics <runId>                     # tokens / cost
npm run cli -- runs scorecard <runId>                   # evidence gate result
npm run cli -- playbook list|show <id>                  # optional Lead playbook catalog

# Declarative DAG workflows
npm run cli -- workflow run <file.mjs> [--vars k=v]
```

Full command reference: `npm run cli -- help`, or [`SKILL.md`](SKILL.md) for the
23-tool MCP table and routing contract.

## Testing

```powershell
npm test            # all unit/integration tests (mock subprocesses, no API tokens)
npm run smoke       # real CLI smoke (claude/codex/opencode — consumes API tokens)
npm run reliability # runtime/model certification matrix — consumes API tokens
```

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright © 2026 DrDexter6000.
