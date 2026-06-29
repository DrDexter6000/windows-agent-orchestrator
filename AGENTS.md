# Repository Guidelines

## What this is

Windows-native, headless orchestrator for dispatching certified worker agents through local agent runtimes (claude-code / codex / opencode-serve).
Drives agents via CLI, records everything to JSONL transcripts, provides worktree isolation, resume, metrics, workflows, scorecard gates, and runtime certification.
Current operating posture: supervised production dispatch trial, Claude Code-first for real coding/tool-use tasks, opencode as a certified optional lane.

## Core principles (do not violate)

1. **Never inject orchestration logic into an agent's system prompt.** Agents see only a normal task prompt. Orchestration lives in transcript + deterministic code.
2. **Transcript is the source of truth**, not memory. All state is reconstructable from `runs/<runId>.jsonl`.
3. **Runtime-agnostic.** Adding a new runtime = writing a Backend + parser. Orchestration code never branches on runtime.
4. **Thin control plane, thick strategy layer.** Control plane (RunManager/state machine) is minimal and deterministic. Flexibility lives in config/workflow/skills.
5. **Windows-native, zero dependencies.** Node ESM, no Docker/WSL, no npm install.
6. **Three-domain rule for automation boundaries.** When deciding whether a feature should be automated, classify it first:
   - 🟢 **Tool domain** (mechanical/deterministic/single right answer: status aggregation, evidence gates, cost math, reference passing) → **fully automated**, Lead doesn't touch it.
   - 🔵 **Tool-drafts/Lead-decides** (has a standard answer but needs human eyes, or a draft can be machine-generated: DAG drafts, failure **diagnosis** with evidence, integration **drafts**) → tool produces the draft/evidence, Lead eyeballs it and can override.
   - 🟡 **Lead domain** (high-semantic/context-dependent/multiple right answers: intent understanding, decomposition granularity, failure **response**, whether an auditor is needed, final acceptance) → **tool does not intervene**, Lead decides and owns it.

   The rule: **🟢 automate only "single-right-answer" steps; 🔵 automate the mechanical half but never the verdict; 🟡 never automate.** This keeps convenience (offload drudge work) without hardening special-cases (which corner-cases stab) and preserves Lead's authority + responsibility. When in doubt, prefer 🔵/🟡 over 🟢.

## For agents working in this repo

**If you need to use the orchestrator tool** (spawn agents, check runs, get metrics):
read `SKILL.md` in the project root for the complete usage manual.

**If you're modifying the orchestrator code itself**:
- Architecture spec: `docs/02-architecture.md`
- Roadmap + progress: `docs/roadmap.md`
- Milestone discipline: `docs/milestone-discipline.md`
- Research/decisions: `docs/research/`
- **文档分类标准（写新文档前必读）**: `docs/ssot.md`

**Smoke-driven refinement**: unit tests passing ≠ works on real data. For aggregation/parsing/classification features (dashboard, diagnose, forecast, parsers), after green tests, **run them against real `runs/*.jsonl` transcripts** before declaring done. Real transcripts surface blind spots unit fixtures can't (M8-C: smoke exposed two real failure modes — `exit code 143` crash + `API_KEY precedence` config-conflict — that unit tests missed; both fed back into the classifier). Treat smoke findings as first-class inputs to the next refinement pass. See `docs/milestone-discipline.md §4.4`.

## 文档纪律（SSOT）

**写新 .md 文件前，先读 `docs/ssot.md`，并回答三个问题：**

1. 这个信息属于哪个类别？（契约 / 决策 / 运维 / 过程 / 调研）—— 不确定就属于已有类别的补充，不该新建。
2. 权威源是不是已经存在？—— 95% 的情况是"已存在，应该改它而不是新建"。新建需要能说出"现有 5 类文件都装不下"的理由。
3. 我会不会复制别处的正文？—— 会的话，改成指针（"见 `<file> §<heading>`"）。

**默认答案是"不新建"**。合理新建只有两种：(a) 新事故复盘（过程类，按日期命名）；(b) 新 ADR（决策类，按编号命名）。

### 五大类别（详见 `docs/ssot.md §1`）

| 类别 | 权威源示例 | 性质 |
|------|-----------|------|
| 契约 Contract | `02-architecture.md`(状态机/接口)、`team-roles.md`(角色)、`tech-debt.md`(技术债)、`roadmap.md`(进度) | 活的，随代码同步 |
| 决策 Decision | `.wao/decisions/NNNN-*.md` | ADR，只追加不改写 |
| 运维 Runbook | `usage.md`、`troubleshooting.md`、`milestone-discipline.md` | 操作步骤 |
| 过程 Process Log | `docs/incidents/`、`changelog-*.md`、`mN-audit.md` | 时间冻结快照，只追加 |
| 调研 Research | `docs/research/NN-*.md` | 早期草稿，不再维护事实 |

### 三条铁律

1. **一处定义，处处指针** —— 状态机、事件表、角色、端口约定全文只在权威源出现一次。
2. **类别不可混放** —— 根因进事故复盘（过程），现象+做法进 troubleshooting（运维），接口定义进 architecture（契约）。
3. **过程文档只追加** —— 事故复盘/mN-audit/research 定格后不改写事实；修复状态、被取代状态用指针。

**典型违规**：把状态机状态列表复制进 PRD/SKILL/research（应只指针指向 architecture）；在事故复盘里维护修复进度（应指针指向 tech-debt TD 编号）。

## Project structure

- `src/cli.js` — CLI entry point and command routing
- `src/runManager.js` — RunManager + Run class + state machine
- `src/transcript.js` — JSONL transcript (events, findState, seq)
- `src/isolation.js` — git worktree management
- `src/portAllocator.js` — port allocation table (implemented, not yet wired into RunManager — TD-23)
- `src/metrics.js` — metrics aggregation
- `src/runEvent.js` — RunEvent types (message/done/metrics + evidence: command/file_written/tool_use/tool_result)
- `src/scorecard.js` — evidence-chain gating (default-on warn since M8-1: `--scorecard-mode warn|hard|off`; checks: hasDoneEvent/commandsPassed/filesExist/hasEvidence/hasAssistantText)
- `src/diagnosis.js` — failure diagnosis (M8-3+C: gives evidence/category, never a recommendation — prescription stays with Lead; categories: provider_auth/config_conflict/timeout/scorecard_fail/budget/crash/aborted_manual/unknown)
- `src/costForecast.js` — cost forecast (M8-4: median ± range from history; insufficient_data when no history)
- `src/smoke.js` — real CLI smoke entry point (`npm run smoke`, consumes API tokens)
- `src/workflow/` — DAG engine (schema, loader, engine, handlers, handoff)
- `src/backends/` — backend implementations (opencodeServe, processBackend, claudeCode, codex)
- `src/backends/parsers/` — stdout parsers (lineStream, claudeCode, codex)
- `config/agents.example.json` — registry template (role-driven workers: researcher/coder_hq/coder_low/coder_mm/tester/auditor + opencode fallback; aligns docs/team-roles.md + decision 0005)
- `config/default.json` — default settings
- `scripts/` — ops scripts: `serve.ps1` (start serve with provider keys), `run-reliability.mjs` (runtime certification reliability suite)
- `test/` — Node native tests (`node:test` + `node:assert/strict`), incl. `docs-consistency.test.js` (SSOT invariants)
- `docs/troubleshooting.md` — on-demand diagnosis manual (provider/cwd/runs/completion-judgment)
- `docs/tech-debt.md` — single TD register (authoritative)
- `docs/ssot.md` — 文档 SSOT 分类标准（写新文档前必读）
- `docs/changelog-2026-06-17.md` — post-M6 修复轮 changelog
- `docs/incidents/` — incident postmortems
- `docs/archive/` — 历史快照（m0~m6-audit 等冻结的过程文档，非现行契约源）

## Build, test, and development commands

- `npm test` — run all tests (mock backends, no API tokens)
- `npm run smoke` — real CLI smoke test (consumes API tokens)
- `npm run reliability` — registry-driven runtime+model certification (`certification.matrix`); use `-- --profile strict` for command/file scorecard drills (consumes real tokens, see `docs/milestone-discipline.md` §6.7)
- `npm run cli -- <command>` — run the orchestrator CLI
- `npm run cli -- help` — list all commands

## Coding style

Plain JavaScript ESM, named exports, two-space indent, async/await.
No dependencies unless they reduce real complexity.
Backend-specific behavior isolated under `src/backends/`.
No formatter/linter — match existing style.

## Constraints

- Keep independent from `D:\projects\talking-cli`.
- **Node version: WAO runs on v22, v24 is hard-rejected.** `.nvmrc` declares `22`. `src/nodeVersionGuard.js` blocks v24 (libuv Windows Job Object regression kills long processes — TD-40). The system default `node` may be v24; **all WAO entrypoints (`cli`/`smoke`/`reliability`/`long-run` in `package.json`) route through `scripts/wao-node.cjs`**, which uses the system-level shared v22 at `%LOCALAPPDATA%\Programs\nodejs-v22\node.exe` (overridable via `WAO_NODE` env). This keeps the global PATH/default node untouched (other projects keep v24) while WAO always gets v22. `npm test` is exempt (uses `test/_guardBypass.mjs` to skip the guard, runs on any node).
- No GUI, no complex permissions, no automatic task decomposition unless explicitly requested.
- Do not commit `config/agents.json`, `runs/`, `.wao-worktrees/`, secrets.
