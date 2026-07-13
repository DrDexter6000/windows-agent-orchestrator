# WAO Repository Contract

WAO is a Windows-native control plane for supervised worker dispatch through local agent runtimes.

## Invariants

1. WAO run state comes from `runs/<runId>.jsonl`; agent memory may provide context but never overrides transcript facts.
2. Workers receive a bounded task and role contract, not Lead orchestration context. The control plane owns dispatch, state, delivery, and handoff records.
3. Runtime-specific behavior stays behind a Backend and parser. Shared orchestration code does not branch on runtime.
4. The control plane stays deterministic. Semantic decomposition, failure response, and final acceptance belong to the Lead.
5. Production runtime remains free of third-party dependencies. Adding one requires explicit Owner approval.
6. WAO itself does not automatically perform semantic task decomposition; the Lead decides whether and how to split work.

## Read Before Changes

- Architecture and event contracts: `docs/02-architecture.md`
- Roadmap and current progress: `docs/roadmap.md`
- Documentation ownership: `docs/ssot.md`
- Milestone and real-runtime gates: `docs/milestone-discipline.md`
- Operations and failures: `docs/usage.md`, `docs/troubleshooting.md`
- Lead orchestration usage: `SKILL.md` (only when operating WAO)

Before adding or editing documentation, follow `docs/ssot.md`: update the existing authority by default and point to it instead of copying its content.

For aggregation, parsing, or classification changes, green unit tests are not enough; smoke the result against real transcripts before declaring completion.

## Commands

- `npm test` - deterministic local test suite; no API tokens
- `npm run cli -- <command>` - WAO CLI
- `npm run smoke` - real runtime smoke; consumes tokens
- `npm run reliability` - runtime/model certification; consumes tokens

## Code

Plain JavaScript ESM, named exports, two-space indentation, and async/await. Match existing patterns, keep backend-specific code under `src/backends/`, and do not add unrelated refactors.

## Boundaries

- Use the npm scripts for WAO entrypoints so they select Node 22; do not change the system-wide Node version.
- On Windows, use an explicit absolute temporary path or `os.tmpdir()`; never use ambiguous POSIX `/tmp` paths.
- Keep WAO independent from `D:\projects\talking-cli`.
- No GUI or automatic merge/release behavior unless explicitly requested.
- Never commit `config/agents.json`, `runs/`, `.wao-worktrees/`, credentials, or secrets.
