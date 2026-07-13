# 0016: Supervised Phase 3C credential posture
status: accepted
date: 2026-07-13

## Context

Decision 0015 correctly required a broker or separate identity before an unsupervised release, but it also made that strong boundary a prerequisite for all Phase 3C work. That conflated two risks: exposure of unrelated provider credentials, which the TD-104 containment fixes address, and access to the credential intentionally assigned to a same-identity local worker, which requires a new security subsystem.

WAO's current product posture is supervised local dispatch, not multi-tenant or unattended production. Blocking the public delivery workflow on a credential broker would expand the milestone from coder delivery into identity infrastructure.

## Decision

Supervised TD-103 Phase 3C development and dogfood may proceed without a credential broker when all of these conditions hold:

- use a process-backed worker with one explicitly assigned, revocable provider credential;
- the child environment contains no unrelated provider credentials;
- known credential values are redacted from returned and persisted output;
- the Lead reviews the transcript, delivery, verification result, and residual processes;
- the run stops and reopens the security blocker if an unrelated credential or unredacted known value is observed.

The first resumed dogfood uses one bounded coder and does not expose OpenCode's shared-server lane.

A broker or equivalent separate identity remains required before unattended queues, multi-tenant use, or any claim that workers cannot access their assigned reusable credential. This decision supersedes only the Phase 3C blocking clause in decision 0015; its containment and strong-isolation findings remain valid.

## Consequences

- TD-103 Phase 3C can resume under the existing supervised product posture.
- Access to the assigned provider credential is an explicit accepted risk for supervised local runs, not evidence of strong isolation.
- Strong credential isolation remains a release-boundary hardening item rather than a coder-delivery prerequisite.
