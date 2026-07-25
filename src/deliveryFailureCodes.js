// src/deliveryFailureCodes.js
//
// M11-8C closeout: the SINGLE source of truth for delivery PACKAGING failure
// codes — the closed set of codes that packageDelivery throws as
// DeliveryError.deliveryCode (and that get persisted on run.delivery_failed).
//
// Both the application projection (runDelivery.js → getRunDelivery) and the MCP
// schema (server.js → RUN_DELIVERY_OUTPUT) derive from THIS frozen set. There
// is no second hand-maintained list; the two cannot drift.
//
// These are DISTINCT from verification failure codes (command_failed /
// command_timeout / artifact_mutated / execution_error), which describe a
// packaged delivery that then failed its verification commands. Packaging
// codes describe the control plane's inability to CREATE the delivery commit
// (e.g. base_commit_mismatch — the worker moved HEAD off the frozen base).

/**
 * Frozen closed set of delivery packaging failure codes.
 *
 * Sourced from the codes packageDelivery throws (delivery.js). Adding a new
 * packaging code requires editing this list AND delivery.js together — they
 * are intentionally co-located as the single contract.
 */
export const PACKAGING_FAILURE_CODES = Object.freeze([
  "empty_diff",
  "disallowed_path",
  "pre_staged_changes",
  "not_a_git_repo",
  "primary_checkout",
  "wrong_branch",
  "base_commit_mismatch",
  "detached_head",
  "commit_integrity",
  "staging_mismatch",
  "commit_failed",
  "cleanup_failed",
  "worktree_path_mismatch",
  "artifact_mismatch",
  "invalid_allowed_paths",
  "invalid_base_commit",
  "invalid_input",
  "invalid_isolation",
  "invalid_mode",
  "invalid_run_id",
  "invalid_verification",
]);

/** The safe projection for an unknown/malformed code. Never echoed verbatim. */
export const UNKNOWN_PACKAGING_CODE = "unknown";

/**
 * Project an untrusted packaging failure code through the closed set.
 *
 * Returns the code unchanged when it is a member of PACKAGING_FAILURE_CODES,
 * otherwise UNKNOWN_PACKAGING_CODE. Never throws, never echoes the raw value.
 * Used by the application service (getRunDelivery) and (transitively, via the
 * schema enum derived from the same set) the MCP adapter.
 *
 * @param {unknown} code
 * @returns {string} a member of PACKAGING_FAILURE_CODES, or "unknown"
 */
export function safeProjectPackagingCode(code) {
  return typeof code === "string" && PACKAGING_FAILURE_CODES.includes(code)
    ? code
    : UNKNOWN_PACKAGING_CODE;
}
