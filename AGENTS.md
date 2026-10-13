# WAO Repository Contract

WAO is a Windows-native control plane for supervised worker dispatch through local agent runtimes.

## Invariants

1. WAO run state comes from the run's transcript (`runs/<runId>.jsonl` legacy flat, or `runs/projects/<slug>/<runId>.jsonl` since D2-②b — resolved via `src/projectBuckets.js`); agent memory may provide context but never overrides transcript facts.
2. Workers receive a bounded task and role contract, not Lead orchestration context. The control plane owns dispatch, state, delivery, and handoff records.
3. Runtime-specific behavior stays behind a Backend and parser. Shared orchestration code does not branch on runtime.
4. The control plane stays deterministic. Semantic decomposition, failure response, and final acceptance belong to the Lead.
5. Production runtime carries exactly two Owner-approved third-party dependencies (`@modelcontextprotocol/sdk` and `zod`, both confined to `src/mcp/**`); adding any further requires explicit Owner approval. Keep `devDependencies` empty — introducing any dev toolchain (TypeScript, linters, AST parsers) likewise requires explicit Owner approval.
6. WAO itself does not automatically perform semantic task decomposition; the Lead decides whether and how to split work.

## Read Before Changes

Use the action-matched tier-1 row in `docs/ssot.md` §0.1. That table is the only
file list: read the union of rows your action matches, including each stated
condition. `SKILL.md` remains conditional on actually operating WAO.

For aggregation, parsing, or classification changes, green unit tests are not enough; smoke the result against real transcripts before declaring completion.

## Documentation

One fact has one editable home; everything else links to it. Document categories are defined in `docs/ssot.md`.

- **What a change writes.** Code and tests; for each fact that changed, the reference text that is its home (a change may touch several facts, each in its own place); a decision record only when you chose between alternatives (`.wao/decisions/`, at most 8 KB: background, decision, rejected alternatives, known limits); one ledger line when a debt item opens or closes. For an ordinary development batch, the story of the batch — what changed, how it was verified, who reviewed it, run and consult ids — goes in the commit message, not in a document. Releases, incidents and workstream close-outs keep the records `docs/milestone-discipline.md` and `docs/incidents/` ask for.
- **Reference documents describe the present.** Replace the text that is no longer true; do not append what changed, when, or in which batch.
- **Debt ledger** (`docs/tech-debt.md`): one line per unresolved item, format and limits in its header. Updating a row rewrites it; closing a row moves it to `docs/archive/tech-debt-closed.md`.
- **Tests on documents** check agreement with code, that a retired claim stays gone, shape, and the few operating instructions a reader cannot work without — in the one place that is authoritative for them, never as the same sentence required in several files. When the text a test protects is retired, the test is retired with it.
- **A red size limit means move or delete content.** Raising a limit is the Owner's decision.

## Commands

- `npm test` - deterministic local test suite; no API tokens
- `npm run cli -- <command>` - WAO CLI
- `npm run smoke` - real runtime smoke; consumes tokens
- `npm run reliability` - runtime/model certification; consumes tokens
- `npm run gen:surface` - regenerate docs/surface/* after MCP surface or CLI help changes; commit the output (tool-surface wire-cap tests may need refreeze)

## Code

Plain JavaScript ESM, named exports, two-space indentation, and async/await. Match existing patterns, keep backend-specific code under `src/backends/`, and do not add unrelated refactors.

## Boundaries

- Use the npm scripts for WAO entrypoints so they select Node 22; do not change the system-wide Node version.
- On Windows, use an explicit absolute temporary path or `os.tmpdir()`; never use ambiguous POSIX `/tmp` paths.
- Keep WAO independent from `D:\projects\talking-cli`.
- Keep at most one active continuation entry; on workstream close, archive its logs (hash-verified same-depth move + tombstone pointer) instead of growing or rewriting them (ADR 0034).
- No GUI or automatic merge/release behavior unless explicitly requested.
- Never commit `config/agents.json`, `runs/`, `.wao-worktrees/`, credentials, or secrets.
