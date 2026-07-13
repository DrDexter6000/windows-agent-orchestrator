# 0017: MCP-first control surface

status: accepted
date: 2026-07-13

## Context

WAO's CLI has been the sole interface since M0. TD-103 Phase 3C added the public
delivery CLI (`run --delivery-spec-file`, `runs delivery --accept/--reject`) and a
real coder dogfood passed. The product is functionally complete for supervised
single-process delivery.

The original PRD (§6 L4) listed "本地 HTTP API（供 LLM/外部程序驱动）" as a [L]
long-term goal. The ecosystem has since converged on MCP (Model Context Protocol)
as the standard for agent-facing tool interfaces. Any MCP-capable Agent Runtime
should be able to act as a Lead host for WAO without writing a custom integration.

This ADR defines WAO's product posture going forward. It does not start MCP
implementation — that is milestone M9.

## Decision

WAO is an **MCP-first, Skill-guided, CLI-backed** multi-runtime agent control plane.

1. **MCP Server is the primary agent-facing control surface.** WAO will provide
   its own MCP Server. Lead Agents call WAO's deterministic capabilities
   (dispatch, supervise, collect, diagnose, delivery, acceptance) through MCP
   tools. MCP is not a new worker backend.

2. **MCP Server and CLI share the same application-service layer.** Both are
   thin transport/input/output adapters. Business rules live once in the
   application services (RunManager, transcript, delivery, workflow, registry).
   **MCP Server must not shell out to CLI and parse text output.**

3. **Core services are MCP-agnostic.** RunManager, transcript, delivery,
   Backend, and workflow do not depend on MCP. MCP is an L4 adapter, not an
   L1-L3 dependency.

4. **Skill is the Lead guidance layer.** `SKILL.md` tells the Lead when to
   dispatch, how to decompose, and how to accept. Skill holds no runtime state,
   does not replace transcript, and does not implement control logic. Lead
   retains decomposition and acceptance responsibility. WAO does not auto-decompose.

5. **CLI remains the human/ops/debug/fallback interface.** CLI and MCP produce
   identical transcript facts for the same operation.

6. **Host-global configuration is not WAO's responsibility.** WAO may provide
   its own MCP Server startup and configuration entry point, but does not take
   over the host runtime's global MCP configuration, provider configuration, or
   authentication system. A runtime can serve as Lead host and also as a worker
   via Backend, but the two roles must keep clear boundaries.

## Consequences

- Adding MCP does not require rewriting RunManager, transcript, delivery, or
  backends — they are already L1-L3 services with no CLI dependency in their
  core logic.
- The CLI commands and MCP tools must be kept in sync semantically. A shared
  application-service layer is the structural guarantee, not discipline.
- MCP implementation has not started. This ADR only sets direction. M9 defines
  the implementation milestone.
- TD-104 strong-isolation boundary is not relaxed by MCP adoption. A Lead host
  running via MCP still operates under the same supervised, single-process,
  single-revocable-credential posture as the CLI.

## Boundaries

- MCP Server is L4 only. It must not contain business rules.
- MCP Server must not invoke CLI as a subprocess.
- Skill is not in the runtime dependency graph — it holds no state.
- Transcript remains the run truth SSOT regardless of interface.
- Backends remain worker-runtime-only adapters.
- This ADR does not define final MCP tool names or JSON schemas — that is M9
  implementation work requiring validation.
