# Windows Agent Orchestrator (WAO)

Windows-native, headless, runtime-agnostic orchestrator for local agent runtimes
(claude-code / codex / kimi-code / opencode-serve, plus an experimental
DeepSeek Harness JSON-RPC adapter). Drives agents via subprocess or HTTP,
records everything to JSONL transcripts, provides git worktree isolation, resume,
token/cost metrics, declarative DAG workflows, and evidence-chain scorecard gating.

> **Value & boundary (ADR 0018):** WAO's value is routing worker token spend onto
> external provider quota — it lets a Lead dispatch real work to external worker runtimes
> so the token bill lands on the worker's provider, instead of pulling the work back into
> the Lead's own context. WAO is an assisted execution control plane, not a gate and not a
> second semantic supervisor. WAO 自动监测，不自动监督；自动封装，不自动验收；自动呈现，不自动决策。
> (English: WAO monitors, never supervises; packages, never accepts; presents, never decides.)

> **New to WAO?** Start with [`AGENT_ONBOARDING.md`](AGENT_ONBOARDING.md) — it is the one
> authoritative path from zero to a working setup: install WAO, configure **ONE** worker,
> validate it, connect an MCP Host, and run a first read-only canary. You do **not** need
> all six runtimes or every provider credential to start.

- **Minimal dependencies** — plain Node ESM; only `@modelcontextprotocol/sdk` + `zod` for the MCP control surface. No Docker/WSL.
- **Transcript is source of truth** — every run reconstructable from `runs/<runId>.jsonl`.
- **Windows-native** — worktree isolation + process-tree cleanup tuned for Windows.

## Vision

WAO is a Windows-native control plane that lets a lead agent dispatch external worker
agents to do real repository work, routing the token spend onto each worker's provider
quota. It keeps orchestration out of worker system prompts: workers receive normal task
prompts, while WAO owns transcripts, state, isolation, workflow execution, metrics, and
evidence-chain scorecard gates. Certification is advisory evidence about a worker's
recorded reliability, not a dispatch permission gate.

## Current Status

WAO is an **MCP-first control plane** (Decision 0017). A lead agent runtime —
Claude Desktop, Codex CLI, OpenCode, or any MCP host — drives WAO as a stdio MCP
server. WAO owns dispatch, state, isolation, transcripts, delivery verification,
and durable Lead accept/reject decision recording (it records the Lead's decision;
it does not accept or reject for the Lead); workers receive only a bounded task
prompt and stay out of orchestration.

WAO exposes **22 MCP tools** covering the full supervised Lead loop:

> `inventory → workspace_status → dispatch → await result → delivery query/review → Lead decision`

plus `runs_list` recovery. The playbook catalog is read on demand via MCP
resources (`wao://playbooks`), not tools. Every state-changing operation calls
the same shared application service as the CLI fallback, producing identical
transcript durable facts. See
[`SKILL.md`](SKILL.md) for the tool table and routing contract.

**Milestones M0–M12 complete** (M12: Lead Token Efficiency + Assisted
Orchestration). Implemented: explicit state machine + JSONL transcript source
of truth; multi-backend (opencode-serve + claude-code + codex + kimi-code,
with DeepSeek Harness available as an experimental, uncertified adapter);
worktree isolation, resume, metrics aggregation; declarative DAG engine +
parameterized workflow templates; daemon supervision + scorecard evidence
gating + runtime certification + diagnostics; MCP-first Lead closed loop with
workspace-bound dispatch/recovery/stop + `run_wait` liveness observation +
durable decisions + restart recovery; real multi-worker dogfood on an external
project; safe changed-path projection + exact delivery proof + bounded/redacted
diff review (`run_delivery_review`); bounded `run_collect` continuation with
opaque cursor pagination; adaptive playbook catalog; workspace-scoped expert
session reuse; read-only `run_await_result` combining bounded wait, truthful
liveness, and safe compact terminal output without hiding the atomic tools.
M11 closed complete; the former "Tester context/token efficiency"
item is retired/deferred out of M11. M12-1+ delivered advisory
`candidateInventory` for retained `disallowed_path` failures and
Lead-authorized, model-free `run_delivery_repackage` reuse of the original
worktree, base, and verification declaration, plus compact collect, delivery
review bundles, backend-failure candidate recovery, `run_continue`, the
22-tool frozen MCP surface with playbook/semantics resources, and per-command
execution budgets. The only remaining non-blocking candidate is broader
cross-run/historical evidence aggregation — explicitly out of the M12
completion definition.

See [`docs/roadmap.md`](docs/roadmap.md) for full milestone status and
[`docs/tech-debt.md`](docs/tech-debt.md) for the open tech-debt register.
Runtime/model dispatch certification lives in `runs/reliability-summary.json`
(gitignored, generated by `npm run reliability`).

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
#    path you actually have, delete the rest. One runtime is enough to use
#    WAO. The choice table per runtime (claude-code + provider key / codex
#    login / Kimi Code) is in AGENT_ONBOARDING.md.
#    Edit each kept worker's cwd to the project it should operate on.

# 2. Verify the registry (no runtime needed for this)
# registry list = inventory + certification status; registry validate = static schema; registry check = live opencode health
npm run cli -- registry list --registry config/agents.json
npm run cli -- registry validate --registry config/agents.json
#    registry check probes a live opencode-serve backend — it only applies if
#    you kept the opencode fallback worker and started scripts/serve.ps1.

# 3. Connect an MCP Host (primary control surface — Decision 0017)
#    Run this from the WAO install root (the repo you cloned). Point any MCP
#    host (Claude Desktop / Codex / OpenCode) at this stdio entry; host-specific
#    absolute command/args examples live in docs/usage.md §MCP stdio:
npm run mcp -- --registry config/agents.json --run-dir runs
#    The host authorizes the workspace (roots/list / workspace_select);
#    --cwd below only steers CLI-side workspace observation.

# 4. First read-only canary via the CLI fallback (one retained worker)
#    Replace <agentId> with one worker id from `registry list` in step 2 — the
#    canary works for ANY retained process worker (claude-code / codex / kimi-code):
npm run cli -- run <agentId> --prompt "Read package.json and summarize what WAO does" --cwd D:/projects/your-project --registry config/agents.json --format json
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
| **Use the orchestrator as an agent / from a script** (22 MCP tools, commands, workflows, config) | [`SKILL.md`](SKILL.md) — the agent-facing usage manual + tool table |
| **Deploy / configure / operate it as a human** | [`docs/usage.md`](docs/usage.md) — full deployment + usage guide |
| **Look up a tool parameter or CLI flag** | [`docs/surface/`](docs/surface/) — generated reference (regen: `npm run gen:surface`); repo index: [`llms.txt`](llms.txt) |
| **Run real smoke tests** (claude/codex/opencode) | [`docs/smoke-guide.md`](docs/smoke-guide.md) |
| **Understand the architecture** (layers, interfaces, state machine) | [`docs/02-architecture.md`](docs/02-architecture.md) |
| **See requirements / non-goals / acceptance** | [`docs/01-prd.md`](docs/01-prd.md) |
| **Track milestones / progress** | [`docs/roadmap.md`](docs/roadmap.md) |
| **Check runtime/model dispatch certification** | `runs/reliability-summary.json` generated by `npm run reliability` |
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
22-tool MCP table and routing contract.

## Testing

```powershell
npm test            # all unit/integration tests (mock subprocesses, no API tokens)
npm run smoke       # real CLI smoke (claude/codex/opencode — consumes API tokens)
npm run reliability # runtime/model certification matrix — consumes API tokens
```

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright © 2026 DrDexter6000.
