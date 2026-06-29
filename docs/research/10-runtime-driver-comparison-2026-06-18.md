# Runtime Driver Comparison: DeepSeek-v4-flash via opencode vs Claude Code

Date: 2026-06-18

## Verdict

Default to Claude Code for real WAO worker dispatch.

- `coder_deepseek_claude`: `claude-code` + DeepSeek via `scripts/wrappers/claude-code-provider-wrapper.mjs` is the better default for coding, file mutation, command execution, and scorecard-gated tasks.
- `researcher`: `opencode-serve` + `deepseek-v4-flash` remains useful as a low-cost research / long-context lane, but not for long-running or stop-sensitive tasks.
- opencode stop safety is **not certified**: the previous drill proved only local transcript ledger behavior (`aborted` state + seq monotonic), not backend session/token/log quietness after abort.

Do not use raw `.bat` wrappers that forward with bare `%*`. They are unsafe for WAO prompts because characters like `<` and `>` can be re-parsed by `cmd.exe` during batch expansion.

## Latest Evidence

Command:

```powershell
npm run reliability -- --serve-url http://127.0.0.1:4298
```

Historical result:

- Exit code: `0`
- Summary: `runs/reliability-summary.json`
- Certification counts: `{"certified":3,"conditional":0,"draft-only":0,"blocked":0,"rejected":0}`

Status correction: that run included an opencode `stop` drill that checked local ledger state only. It did not verify backend quietness, so it must not be used as proof that opencode can safely handle long-running stop-sensitive dispatch.

## Dimension Comparison

| Dimension | opencode-serve + DeepSeek | Claude Code + DeepSeek Node wrapper |
|---|---|---|
| Certification status | Suitable for non-stop-sensitive research when current matrix passes | Best default when current matrix passes |
| Delivery quality in drills | Passed sentinel, scorecard, isolation, workflow run-dir; historical stop coverage was local-ledger only | Passed sentinel, scorecard, isolation, workflow run-dir |
| Process observability | Good: assistant text, metrics, command/file/tool evidence | Good: assistant text, metrics, command/file/tool evidence |
| Control surface | Local ledger can record aborted state; backend stop quietness is unverified (TD-37) | Process lifecycle is simpler for WAO to own; stop parity drill still future work |
| Cost/context profile in this run | Lower reported input in sentinel drill (`335`) | Much higher reported input in sentinel drill (`35997`), likely Claude Code wrapper/session context overhead |
| Failure mode found | None in latest run | Raw `.bat %*` wrapper silently swallowed prompts with `<...>`; fixed by Node wrapper |
| Best current use | Low-cost research and long-context read/analysis that can be manually supervised | Strict tool-use jobs, scorecard-gated file/command tasks, default worker runtime |

## Dispatch Policy

Default to Claude Code for real coding, file mutation, command execution, and scorecard-gated tasks when a certified Claude Code worker is available. The project posture is Claude Code-first because tool execution quality and strict evidence gates are closer to the goal than preserving opencode as the center of the architecture.

Use `opencode-serve` as an optional lane: low-cost researcher tasks, long-context read/analysis, or model-specific cases where certification proves it is the better route. Do not use opencode for long-running or stop-sensitive real-provider work until `capabilities.backendStopQuiet === true`.

Claude Code provider workers must be configured through `binary: "node"` + absolute `prependArgs` to `scripts/wrappers/claude-code-provider-wrapper.mjs`.

Do not dispatch production work through ad hoc `.bat` wrappers unless they have been certified with prompts containing shell metacharacters (`<`, `>`, `&`, `|`) and scorecard evidence.

## Remaining Gaps

- GLM-5.2 certification is still deferred until a healthy Zhipu key is available.
- TD-37: the reliability `stop` drill must be upgraded from local ledger checks to backend quietness checks before claiming opencode stop auditability.
- The active registry should remain the dispatch source of truth: read `runs/reliability-summary.json.workers` before treating a worker as strict-dispatch capable.
