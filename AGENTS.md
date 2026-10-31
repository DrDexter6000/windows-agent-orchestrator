# WAO Repository Contract

WAO is a Windows-native control plane for supervised worker dispatch through local agent runtimes.

**Lean by default** (Owner: 简练就是美，灵活就是美；除非工程和技术必要，官僚就是丑). Prefer the smaller design, the shorter text and fewer rules, from architecture to wording; add a process step, rule, guard or abstraction only when engineering or technical necessity requires it.

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

**WAO development Lead only**: start work by checking `wao feedback list` (how: `docs/usage/host.md` §反馈收件箱); each open entry either enters the ledger or is closed with a written reason. Workers do not do this.

## Documentation

Before writing or changing any document, read `docs/ssot.md` §2–§4.

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
