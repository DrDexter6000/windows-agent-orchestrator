// src/application/runWorkspaceOwnership.js
//
// M10 P0-3: Run workspace ownership SSOT.
//
// The single source of truth for identifying and verifying which workspace
// a run belongs to. The ownership fact is `run.background_submitted.cwd` —
// the cwd passed to dispatchRun when the run was created.
//
// Both runStop.js and runList.js delegate to this module — no second copy
// of the ownership algorithm exists anywhere.
//
// Architectural contract:
//   - Does NOT import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Reuses proveWorkspace + pathsMatch from workspaceBinding.js.
//   - Never reads process.platform or implements path comparison.

import { proveWorkspace, pathsMatch } from "./workspaceBinding.js";

/**
 * Find the workspace ownership fact from transcript events.
 *
 * Transcript events are flat — payload fields are at the top level alongside
 * envelope fields (ts, seq, runId, agentId, type).
 *
 * @param {object[]} events
 * @returns {{cwd: string}|null} the ownership cwd, or null if not found
 * @throws {Error} if multiple background_submitted events exist (ambiguous)
 *                  or if the cwd field is missing/empty/non-string (malformed)
 */
export function findRunWorkspaceOwnership(events) {
  const submitted = events.filter((e) => e.type === "run.background_submitted");
  if (submitted.length === 0) return null;
  if (submitted.length > 1) {
    throw new Error("ambiguous ownership: multiple run.background_submitted events");
  }
  const cwd = submitted[0].cwd;
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("malformed ownership: run.background_submitted.cwd is missing or empty");
  }
  return { cwd };
}

/**
 * Create a query-scoped workspace verifier.
 *
 * The authorized root is proved once. Each distinct ownership cwd is then
 * proved at most once for the lifetime of this verifier. This preserves the
 * existing Git-top-level and realpath checks while avoiding repeated Git
 * subprocesses when a run inventory contains many runs from the same project.
 *
 * @param {string} authorizedWorkspaceRoot
 * @param {{proveWorkspaceFn?: Function}} [opts]
 * @returns {(events: object[]) => {authorized: true, ownershipCwd: string}}
 */
export function createRunWorkspaceVerifier(authorizedWorkspaceRoot, opts = {}) {
  const prove = opts.proveWorkspaceFn ?? proveWorkspace;
  const authorizedProof = prove(authorizedWorkspaceRoot);
  const proofCache = new Map([
    [authorizedWorkspaceRoot, authorizedProof],
    [authorizedProof.root, authorizedProof],
  ]);
  const failedProofs = new Set();

  return function verify(events) {
    const fact = findRunWorkspaceOwnership(events);
    if (!fact) {
      throw new Error("missing ownership: no run.background_submitted event");
    }

    if (failedProofs.has(fact.cwd)) {
      throw new Error("unprovable ownership workspace");
    }

    let ownershipProof = proofCache.get(fact.cwd);
    if (!ownershipProof) {
      try {
        ownershipProof = prove(fact.cwd);
      } catch {
        failedProofs.add(fact.cwd);
        throw new Error("unprovable ownership workspace");
      }
      proofCache.set(fact.cwd, ownershipProof);
      proofCache.set(ownershipProof.root, ownershipProof);
    }

    if (!pathsMatch(ownershipProof.root, authorizedProof.root)) {
      throw new Error("workspace mismatch: run ownership does not match authorized workspace");
    }
    return { authorized: true, ownershipCwd: fact.cwd };
  };
}

/**
 * Verify that a run's workspace ownership matches the authorized root.
 *
 * Uses proveWorkspace SSOT to canonicalize both paths (rejects subdirectories,
 * non-existent paths, non-Git dirs). Uses pathsMatch SSOT for platform-aware
 * comparison (case-insensitive on win32).
 *
 * @param {object[]} events
 * @param {string} authorizedWorkspaceRoot — canonical Git root from server binding
 * @returns {{authorized: true, ownershipCwd: string}}
 * @throws {Error} if ownership is missing, malformed, ambiguous, or mismatched
 */
export function verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot) {
  return createRunWorkspaceVerifier(authorizedWorkspaceRoot)(events);
}
