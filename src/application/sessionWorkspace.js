// src/application/sessionWorkspace.js
//
// M11-6: Lead session-level workspace selection — pure validation kernel.
//
// A Lead/Host is the Human Owner's trusted coordinator and may choose which
// Git project to work in. This module PROVES a Lead-chosen path is a valid
// canonical Git top-level (delegating to the existing proveWorkspace SSOT) and
// returns its canonical root, gitHead, and dirty status.
//
// This module is stateless: it does not hold per-session selection state, does
// not persist anything, and has no module-level mutable variables. The per-MCP-
// server session state lives in the createWaoMcpServer closure (server.js), so
// two server instances are strictly isolated and there is no global singleton.
//
// Architectural contract:
//   - Does NOT import src/mcp/*, src/commands/*, MCP SDK, or zod.
//   - No disk writes, no transcript, no run/worktree/process creation.
//   - Validation failure does not mutate any caller-held state; the caller
//     keeps its previous valid selection on a failed selectSessionWorkspace.
//   - Re-proves on every selection (no cached identity) — delegates to
//     proveWorkspace, which re-runs Git each time.
//
// Authority boundary:
//   - Only a canonical Git top-level is accepted (proveWorkspace rejects
//     subdirectories, non-repos, missing paths). This is the same authority
//     proof used for host-supplied --workspace-root; the Lead's choice is
//     validated, not trusted.

import { proveWorkspace } from "./workspaceBinding.js";

/**
 * Validate a Lead-chosen workspace path as a canonical Git top-level.
 *
 * @param {{ workspaceRoot: string }} input — non-empty absolute path chosen by the Lead
 * @returns {{ root: string, gitHead: string, dirty: boolean, source: "lead_session" }}
 *   canonical root, full HEAD, dirty status, and the fixed source label.
 * @throws {Error} if workspaceRoot is missing, not absolute, not a real Git
 *   top-level, or any Git command fails. The error message is a fixed safe
 *   shape and does not echo the absolute path or role/project content.
 */
export function selectSessionWorkspace({ workspaceRoot } = {}) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new Error("workspace: workspaceRoot must be a non-empty absolute path");
  }
  // Delegate to the shared SSOT — same authority proof as host --workspace-root.
  // proveWorkspace throws a fixed-shape message on any failure (non-absolute,
  // not a directory, not a Git top-level, subdirectory, malformed HEAD).
  const proof = proveWorkspace(workspaceRoot);
  return { ...proof, source: "lead_session" };
}
