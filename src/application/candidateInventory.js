// src/application/candidateInventory.js
//
// M12-1S1: read-only safe candidate inventory projection.
//
// When a delivery run's durable bound packaging failure is exactly
// `disallowed_path`, the Lead previously saw only a blind code. This module
// computes a bounded, advisory inventory of the candidate's ACTUAL changed
// paths (tracked diff vs the persisted original base + non-ignored untracked
// files) and the subset that exceeded the ORIGINAL allowedPaths contract.
//
// Hard boundaries:
//   - Advisory facts only. NEVER expands scope, repackages, stops/retries,
//     decides, or recommends. null means "verify manually" — never an
//     automatic stop.
//   - Fail closed to null on ANY proof/read/path-validation failure — never
//     partial truth. Both required Git reads must succeed (enforced by
//     listWorktreeChangedPaths).
//   - Every emitted path passes the existing strict projection SSOT
//     (validateProjectedPath); any unsafe path nulls the WHOLE inventory.
//   - The old-contract comparison reuses the isPathAllowed SSOT — no
//     duplicated boundary semantics.
//   - Strictly read-only: no staging, no reset, no transcript/Git mutation.
//
// Architectural contract:
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Workspace ownership / run.started / linked-worktree-at-base proofs are
//     the CALLER's job (runDelivery.js) and must complete BEFORE this module
//     is invoked; this module trusts an already-authorized (worktreePath,
//     baseCommit, allowedPaths) triple but still validates it defensively.

import {
  isCanonicalCommitId,
  isPathAllowed,
  listWorktreeChangedPaths,
} from "../delivery.js";
import { validateProjectedPath } from "./deliveryReview.js";

/** Server-owned cap for each path list exposed via the inventory. */
export const INVENTORY_PATHS_LIMIT = 256;

/**
 * Compute the read-only candidate inventory for a disallowed_path failure.
 *
 * @param {string} worktreePath — candidate's persistent linked worktree
 * @param {string} baseCommit — canonical full hash from the ORIGINAL bound
 *   run.started delivery context (never HEAD / short SHA / user input)
 * @param {string[]} allowedPaths — the ORIGINAL allowedPaths contract
 * @param {Function} [listFn] — injectable change-listing reader for testing;
 *   defaults to listWorktreeChangedPaths. Must return an array of
 *   repo-relative paths or null when either required Git read failed.
 * @returns {object|null} {
 *   actualChangedPaths, actualChangedCount, actualChangedTruncated,
 *   disallowedPaths, disallowedCount, disallowedTruncated,
 * } or null on ANY validation/read failure (never partial truth)
 */
export function computeCandidateInventory(worktreePath, baseCommit, allowedPaths, listFn) {
  // Malformed inputs fail closed.
  if (typeof worktreePath !== "string" || worktreePath.length === 0) return null;
  if (!isCanonicalCommitId(baseCommit)) return null;
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) return null;

  // Validate the original contract through the SAME strict projection SSOT so
  // a traversal/absolute/control-char entry can never reach the comparison.
  let allowed;
  try {
    allowed = allowedPaths.map((p) => validateProjectedPath(p));
  } catch {
    return null;
  }

  const _list = listFn ?? listWorktreeChangedPaths;
  let raw;
  try {
    raw = _list(worktreePath, baseCommit);
  } catch {
    return null; // a throwing reader is a failed read — never partial truth
  }
  if (!Array.isArray(raw)) return null; // required read failed => null

  // Validate EVERY emitted path through the strict projection SSOT; any
  // unsafe path nulls the WHOLE inventory (no partial truth across the MCP
  // boundary).
  const validated = [];
  try {
    for (const p of raw) validated.push(validateProjectedPath(p));
  } catch {
    return null;
  }

  // Deterministic: deduplicate + sort. Counts report the FULL cardinality of
  // the deduplicated set (not the capped length) so truncation is detectable.
  const all = [...new Set(validated)].sort();
  const disallowed = all.filter((p) => !isPathAllowed(p, allowed));

  const actualChangedPaths = all.slice(0, INVENTORY_PATHS_LIMIT);
  const disallowedPaths = disallowed.slice(0, INVENTORY_PATHS_LIMIT);
  return {
    actualChangedPaths,
    actualChangedCount: all.length,
    actualChangedTruncated: all.length > actualChangedPaths.length,
    disallowedPaths,
    disallowedCount: disallowed.length,
    disallowedTruncated: disallowed.length > disallowedPaths.length,
  };
}
