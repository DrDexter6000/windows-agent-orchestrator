// src/application/reviewUnavailableReasons.js
//
// M11-12A: the SHARED closed set of run_delivery_review unavailable reasons.
//
// This is the single contract that BOTH the application safe-output projection
// (deliveryReviewProjection.js → projectReviewResult) and the MCP output schema
// (server.js → DELIVERY_REVIEW_OUTPUT) consume. There is no second hand-
// maintained enum; the two cannot drift.
//
// Members:
//   binary              — proof-backed metadata PRESENT (commit/count/path/
//                         format/trust non-null); no text fragment.
//   diff_too_large      — proof-backed metadata PRESENT; no text fragment.
//   verification_pending— NO proof-backed metadata (delivery created but exact
//                         verification not yet recorded). Advisory only: the
//                         Lead may wait with run_delivery(waitMs) or retry
//                         review later. It is never an automatic stop/accept/
//                         reject, and never a reason to read Git directly.
//
// These are DISTINCT from the delivery PACKAGING failure codes
// (deliveryFailureCodes.js), which describe the control plane's inability to
// CREATE a delivery commit and surface via run_delivery, not run_delivery_review.

/**
 * Frozen closed set of run_delivery_review unavailable reasons — the
 * application+MCP safe-projection allowlist.
 */
export const REVIEW_UNAVAILABLE_REASONS = Object.freeze([
  "binary",
  "diff_too_large",
  "verification_pending",
]);

/**
 * Reasons that still carry proof-backed metadata (non-null deliveryCommit /
 * changedFileCount / changedPath / contentFormat / artifactTextTrust).
 * verification_pending is intentionally excluded: its whole point is that NO
 * proof exists yet, so it must surface only honest nulls.
 */
export const REVIEW_UNAVAILABLE_REASONS_WITH_PROOF = Object.freeze([
  "binary",
  "diff_too_large",
]);

/**
 * The advisory not-yet-reviewable reason. A pending result exposes zero diff
 * bytes and null proof-backed metadata; it never weakens final-artifact review
 * eligibility (the exact reviewable path is unaffected).
 */
export const REVIEW_PENDING_REASON = "verification_pending";
