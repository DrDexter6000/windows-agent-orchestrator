# 0015: Worker credential boundary
status: accepted
date: 2026-07-12

## Context

TD-103 coder-delivery dogfood showed that a process worker could enumerate provider credentials inherited from the Lead process and could echo them into tool output. Transcript redaction limits persistence but does not prevent credential use or exfiltration. The worker and Lead currently run under the same Windows identity, so an assigned credential remains visible to the runtime and potentially to worker-invoked tools.

## Risk matrix

The boundary spans backend, source, lifecycle, sink, and credential class. Full Cartesian coverage is not useful; each value is covered at least once, high-risk pairs are explicit, and silent-success cases are first priority.

| Dimension | Values | Highest-risk pair / gate |
|---|---|---|
| Backend | Claude wrapper / Kimi / Codex / OpenCode shared server | Process workers get only their assigned channel; OpenCode remains blocked |
| Source | message / tool input / tool result / stdout / stderr / raw capture | secret split across stdout chunks must not persist |
| Lifecycle | completed / backend failed / scorecard failed / budget / timeout / abort | timeout kill must not become backend crash |
| Sink | memory result / CLI / transcript / diagnosis / raw log | no known exact secret value in any persisted or returned sink |
| Credential | unrelated provider / assigned provider / credential file / derived token | unrelated provider absent now; assigned/file/derived require strong isolation |

## Decision

Adopt two layers:

1. Immediate containment: explicit child environment allowlist, backend-assigned credential channels, exact-value streaming redaction at normalized output and persistence boundaries, and fail-closed registry handling for secret-like `agent.env` entries.
2. Release boundary: do not treat same-identity environment filtering as credential isolation. Before unsupervised coder dogfood or Phase 3C release, introduce a credential broker or an equivalent separate OS/runtime identity. The worker receives a bounded capability, not a reusable provider secret. Provider-native gateway/helper mechanisms may be adapters to that broker but are not sufficient when the worker can invoke or read the helper directly.

OpenCode shared-server credentials require a separate process/identity boundary or per-run broker integration; the ProcessBackend allowlist does not cover it.

For repository-wide retrospective scanning, prefer a mature secret scanner plus narrow WAO-specific rules. Do not expand the runtime exact-value redactor into a home-grown multi-language scanner.

## Consequences

- Current process workers expose fewer credentials. Explicitly assigned channels are always registered with the redactor; recognized credential-like environment values are registered when at least eight characters long.
- Assigned credentials remain reachable under the current identity model; TD-104 stays open. Current milestone status is maintained only in `docs/roadmap.md`.
- Real provider dogfood is allowed only after a gate proves unrelated and assigned reusable secrets are unavailable to worker tools, while brokered provider calls still work.
- The current hotfix is independently testable without consuming model tokens.
