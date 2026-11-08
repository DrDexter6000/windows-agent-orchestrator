# WAO Repository Contract

WAO is a Windows-native control plane for supervised worker dispatch through local agent runtimes.

**Lean by default** (Owner: 简练就是美，灵活就是美；除非工程和技术必要，官僚就是丑). Prefer the smaller design, the shorter text and fewer rules, from architecture to wording; add a process step, rule, guard or abstraction only when engineering or technical necessity requires it.

## Invariants

1. WAO run state comes from the run's own transcript; agent memory may provide context but never overrides transcript facts.
2. Workers receive a bounded task and role contract, not Lead orchestration context. The control plane owns dispatch, state, delivery, and handoff records.
3. Runtime-specific behavior stays behind a Backend and parser. Shared orchestration code does not branch on runtime.
4. The control plane stays deterministic. Semantic decomposition, failure response, and final acceptance belong to the Lead.
5. Production runtime carries exactly two Owner-approved third-party dependencies (`@modelcontextprotocol/sdk` and `zod`, both confined to `src/mcp/**`); adding any further requires explicit Owner approval. Keep `devDependencies` empty — introducing any dev toolchain (TypeScript, linters, AST parsers) likewise requires explicit Owner approval.
6. WAO itself does not automatically perform semantic task decomposition; the Lead decides whether and how to split work.

## Read Before Changes

Use the action-matched tier-1 row in `docs/ssot.md` §0.1. That table is the only
file list: read the union of rows your action matches, including each stated
condition. `SKILL.md` remains conditional on actually operating WAO.
Workers dispatched with a task brief use the `worker-repo-change` row; the Lead
and independent development agents without one use `repo-change`.

For aggregation, parsing, or classification changes, green unit tests are not enough; smoke the result against real transcripts before declaring completion.

## Documentation

Before writing or changing any document, read `docs/ssot.md` §2–§4.

## Commands

- `npm test` - deterministic local test suite; no API tokens
- `npm run test:one -- <file>` - one test file (targeted checks)
- `npm run cli -- <command>` - WAO CLI
- `npm run smoke` - real runtime smoke; consumes tokens
- `npm run reliability` - runtime/model certification; consumes tokens
- `npm run gen:surface` - regenerate docs/surface/* after MCP surface or CLI help changes; commit the output (tool-surface wire-cap tests may need refreeze)
- `npm run map` - on-demand workflow reference map: edges and reachability tiers of every tracked file (`-- --json` for full output)
- `npm run hygiene` - workflow closeout checks
- `node scripts/wao-node.cjs scripts/measure-mcp-surface.mjs` - measure the MCP tool-surface bytes before a cap refreeze (decision 0078)

## Code

Plain JavaScript ESM, named exports, two-space indentation, and async/await. Match existing patterns, keep backend-specific code under `src/backends/`, and do not add unrelated refactors.

## Boundaries

- Use the npm scripts for WAO entrypoints so they select Node 22; do not change the system-wide Node version.
- On Windows, use an explicit absolute temporary path or `os.tmpdir()`; never use ambiguous POSIX `/tmp` paths.
- Keep WAO independent from the talking-cli project.
- The continuation entry is `.strategy/AGENTS.md`: it points to the single live handoff page under `.wao/runs/` (`npm run hygiene` W3 checks it); keep at most one live page, and on workstream close archive that page (hash-verified same-depth move + tombstone pointer) and close the entry — never grow or rewrite archived logs (ADR 0034).
- No GUI or automatic merge/release behavior unless explicitly requested.
- Never commit `config/agents.json`, `runs/`, `.wao-worktrees/`, credentials, or secrets.

## WAO Development Lead Only (workers skip)

Start work by checking `wao feedback list` (how: `docs/usage/host.md` §反馈收件箱); each open entry either enters the ledger or is closed with a written reason. Workers do not do this.
