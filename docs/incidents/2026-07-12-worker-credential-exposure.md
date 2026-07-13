# Worker credential exposure during coder-delivery dogfood

Date: 2026-07-12
Status pointer: see TD-104 in `docs/tech-debt.md`
Decision pointer: see `.wao/decisions/0015-worker-credential-boundary.md`

## Impact

During supervised TD-103 dogfood, workers demonstrated access to provider environment data outside the credential required for their assigned runtime. Provider-related tool output reached run transcripts. The affected credentials were rotated, contaminated originals were quarantined outside the repository, and sanitized run evidence was retained for audit.

No secret values, credential names tied to a real account, or contaminated output are reproduced in this document.

## Detection

The issue was detected by reviewing real worker transcripts rather than unit-test fixtures. Delivery packaging and artifact verification could pass while the worker violated the provider credential boundary, so the public workflow verdict remained unavailable.

## Root cause

`ProcessBackend` inherited the Lead process environment wholesale. Runtime wrappers then inherited that environment again. WAO treated worktree isolation as a file boundary but had no corresponding credential boundary. Output paths also lacked one common redaction contract: parser events, diagnostic tails, and raw capture had different persistence behavior.

## Containment

- Rotated exposed provider credentials.
- Quarantined contaminated originals and kept sanitized evidence in the repository workspace.
- Replaced wholesale environment inheritance with an explicit runtime allowlist plus the assigned backend credential channel.
- Added exact-value redaction before RunManager memory, transcript persistence, diagnostic tails, and raw capture.
- Kept Phase 3C and real coder dogfood paused.

## Lessons

Artifact integrity and credential integrity are independent acceptance dimensions. A correct commit does not make a run acceptable when the worker crossed a credential boundary. Redaction is also not isolation: it can prevent persistence of a known value but cannot revoke the worker's ability to use a credential it can read.

The durable boundary is tracked in decision 0015 and TD-104. This process log is frozen and does not maintain current implementation status.
