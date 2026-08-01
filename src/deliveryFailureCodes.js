// src/deliveryFailureCodes.js
//
// M11-8C: the SHARED safe-projection allowlist for delivery PACKAGING failure
// codes. This is the single contract that BOTH the application projection
// (runDelivery.js → getRunDelivery → safeProjectPackagingCode) and the MCP
// schema (server.js → PACKAGING_FAILURE_CODE_ENUM) consume. There is no second
// hand-maintained projection list; the two cannot drift.
//
// Scope note (accurate, not over-claimed): this is the application+MCP
// safe-projection contract — the closed set of codes those two layers will
// ever surface to a Lead. The PRODUCER (delivery.js → packageDelivery) still
// defines its own DeliveryError.deliveryCode values independently; adding a new
// producer code requires editing BOTH this allowlist and delivery.js for the
// code to be surfaceable (otherwise it projects to "unknown"). A full producer
// refactor to derive delivery.js from this list is out of scope for this change.
//
// These are DISTINCT from verification failure codes (command_failed /
// command_timeout / artifact_mismatch / execution_error), which describe a
// packaged delivery that then failed its verification commands. Packaging
// codes describe the control plane's inability to CREATE the delivery commit
// (e.g. base_commit_mismatch — the worker moved HEAD off the frozen base).

/**
 * Frozen closed set of delivery packaging failure codes — the application+MCP
 * safe-projection allowlist. Producer codes (delivery.js) that are not in this
 * set project to UNKNOWN_PACKAGING_CODE.
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
  "invalid_verification_path",
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
