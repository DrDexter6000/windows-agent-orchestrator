// src/application/deliveryReviewProjection.js
//
// M11-3C closeout: SHARED safe-output projection for run_delivery_review.
//
// Both the MCP adapter (src/mcp/server.js) and the CLI adapter
// (src/commands/runs.js) MUST call projectReviewResult — neither may return the
// raw service output directly. This is the single trust boundary that:
//   - rejects unknown keys;
//   - validates runId / commit / fileIndex / path / format / trust-marker;
//   - redacts configured exact secrets in changedPath;
//   - fails closed if a configured secret appears in the fragment body (the
//     service should have redacted it; if not, the artifact is untrustworthy);
//   - checks C0/C1/DEL control chars in fragment;
//   - enforces available/unavailableReason/fragment/nextCursor/truncated
//     cross-field consistency;
//   - returns a NEW validated payload, never the raw service reference.
//
// M11-12A: three validated variants share the 13-field shape —
//   - available=true         : text fragment present, proof-backed metadata;
//   - binary/diff_too_large  : NO fragment, proof-backed metadata present;
//   - verification_pending   : NO fragment, ALL proof-backed metadata null
//                              (exact verification not yet recorded → nothing
//                              honest to surface but nulls). The closed set of
//                              unavailable reasons lives in
//                              reviewUnavailableReasons.js and is consumed by
//                              BOTH this projection and the MCP output schema,
//                              so the two cannot drift.
//
// Architectural contract:
//   - No Git I/O, no file I/O, no MCP SDK / zod / command imports.
//   - Reuses createSecretRedactor SSOT (exact-secret redaction), isValidRunId,
//     isCanonicalCommitId from delivery.js — no second algorithm.

import { createSecretRedactor } from "../secretRedaction.js";
import { isValidRunId, isCanonicalCommitId } from "../delivery.js";
import { validateProjectedPath } from "./deliveryReview.js";
import {
  REVIEW_UNAVAILABLE_REASONS,
  REVIEW_PENDING_REASON,
} from "./reviewUnavailableReasons.js";

/** Allowed top-level keys in a review result. */
const ALLOWED_REVIEW_KEYS = new Set([
  "runId", "deliveryCommit", "fileIndex", "changedFileCount", "changedPath",
  "contentFormat", "artifactTextTrust", "available", "unavailableReason",
  "fragment", "fragmentBytes", "nextCursor", "truncated",
]);

/**
 * Project an untrusted service review result into a safe, validated payload.
 *
 * @param {object} raw — the raw service output (UNTRUSTED)
 * @param {object} opts
 * @param {string} opts.runId — the caller-requested runId (must match raw.runId)
 * @param {object} [opts.env] — env for the secret redactor (default: process.env)
 * @returns {object} a NEW validated payload with exactly the 13 safe fields
 * @throws {Error} on any structural, semantic, or secret-leak violation
 */
export function projectReviewResult(raw, { runId: expectedRunId, env } = {}) {
  if (!raw || typeof raw !== "object") throw new Error("invalid review result");

  // Unknown keys are rejected — no silent data passthrough.
  for (const k of Object.keys(raw)) {
    if (!ALLOWED_REVIEW_KEYS.has(k)) throw new Error("unknown key in review result");
  }

  // runId must be valid and match the request.
  if (typeof raw.runId !== "string" || !isValidRunId(raw.runId) || raw.runId !== expectedRunId) {
    throw new Error("runId mismatch");
  }

  // fileIndex: non-negative integer. Required for EVERY variant — including
  // verification_pending, where the caller-requested index is echoed back so
  // the Lead can correlate the advisory with its request.
  if (!Number.isInteger(raw.fileIndex) || raw.fileIndex < 0) throw new Error("invalid fileIndex");

  const available = raw.available;
  if (typeof available !== "boolean") throw new Error("invalid available");

  // One redactor instance is shared by every variant that carries text/paths.
  // (verification_pending carries neither, so it never invokes it.)
  const redactor = createSecretRedactor(env ?? process.env);

  if (available) {
    return projectAvailableReview(raw, redactor);
  }

  // All unavailable variants share a closed-set reason and carry NO text
  // fragment — enforced here, before the per-variant metadata rules, so the
  // shared invariants cannot drift between binary / diff_too_large /
  // verification_pending.
  if (!REVIEW_UNAVAILABLE_REASONS.includes(raw.unavailableReason)) {
    throw new Error("invalid unavailableReason");
  }
  if (raw.fragment !== "") throw new Error("unavailable but fragment non-empty");
  if (raw.fragmentBytes !== 0) throw new Error("unavailable but fragmentBytes non-zero");
  if (raw.nextCursor !== null) throw new Error("unavailable but nextCursor non-null");
  if (raw.truncated !== false) throw new Error("unavailable but truncated true");

  if (raw.unavailableReason === REVIEW_PENDING_REASON) {
    return projectPendingReview(raw);
  }

  // binary / diff_too_large: proof-backed metadata MUST be present.
  return projectProofBackedUnavailableReview(raw, redactor);
}

/**
 * Project an AVAILABLE review result (a text fragment is present). This is the
 * verbatim M11-3C reviewable path; nothing about the verification_pending
 * variant touches it.
 */
function projectAvailableReview(raw, redactor) {
  if (raw.unavailableReason !== null) throw new Error("available but reason set");
  // deliveryCommit: canonical lowercase 40/64 hex.
  if (typeof raw.deliveryCommit !== "string" || !isCanonicalCommitId(raw.deliveryCommit)) {
    throw new Error("invalid deliveryCommit");
  }
  // changedFileCount: non-negative integer; fileIndex must be within range.
  if (!Number.isInteger(raw.changedFileCount) || raw.changedFileCount < 0) throw new Error("invalid changedFileCount");
  if (raw.fileIndex >= raw.changedFileCount) throw new Error("fileIndex out of range");

  // changedPath: MUST be a canonical repo-relative path. Validate with the
  // existing SSOT (validateProjectedPath: rejects absolute, traversal,
  // backslash, double/trailing separator, dot segment, C0/C1/DEL, >512).
  // M11-3B --literal-pathspecs already prevents Git pathspec expansion at the
  // diff-read layer; the projection output is data, not a Git pathspec, so
  // legal POSIX filename characters like [*?:] are NOT re-rejected here.
  validateProjectedPath(raw.changedPath);
  let changedPath = raw.changedPath;
  if (redactor.redactString(changedPath) !== changedPath) {
    // Exact-secret redaction changed the path → collapse to [REDACTED].
    changedPath = "[REDACTED]";
  }

  // contentFormat + artifactTextTrust: exact constants.
  if (raw.contentFormat !== "unified_diff_v1") throw new Error("invalid contentFormat");
  if (raw.artifactTextTrust !== "untrusted_repository_text") throw new Error("invalid artifactTextTrust");

  if (typeof raw.fragment !== "string") throw new Error("invalid fragment");
  if (raw.fragment.length > 16384) throw new Error("fragment too long");
  if (Buffer.byteLength(raw.fragment, "utf8") > 16 * 1024) throw new Error("fragment too many bytes");

  // fragmentBytes must match the real UTF-8 byte length of the fragment.
  const actualBytes = Buffer.byteLength(raw.fragment, "utf8");
  if (raw.fragmentBytes !== actualBytes) throw new Error("fragmentBytes mismatch");

  // Only LF (0x0A) and TAB (0x09) are safe control chars; reject all others
  // (C0 / DEL / C1).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(raw.fragment)) throw new Error("unsafe control char in fragment");

  // If the service failed to redact a configured secret from the fragment,
  // the artifact is untrustworthy → fail closed. Do NOT attempt to redact
  // here and continue with a stale cursor (the cursor's digest was computed
  // over the service's redacted text, so re-redacting would make it
  // inconsistent).
  const redactedFragment = redactor.redactString(raw.fragment);
  if (redactedFragment !== raw.fragment) throw new Error("unredacted secret in fragment");

  // nextCursor: null or opaque base64url string ≤192. The cursor must only
  // contain [A-Za-z0-9_-] — no spaces, colons, slashes, or path-like content.
  if (raw.nextCursor !== null) {
    if (typeof raw.nextCursor !== "string" || raw.nextCursor.length === 0 || raw.nextCursor.length > 192) {
      throw new Error("invalid nextCursor");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(raw.nextCursor)) {
      throw new Error("invalid nextCursor: not base64url");
    }
  }
  const expectedTruncated = raw.nextCursor !== null;
  if (raw.truncated !== expectedTruncated) throw new Error("truncated/nextCursor inconsistency");

  // Build and return a NEW object — never the raw service reference.
  return {
    runId: raw.runId,
    deliveryCommit: raw.deliveryCommit,
    fileIndex: raw.fileIndex,
    changedFileCount: raw.changedFileCount,
    changedPath,
    contentFormat: raw.contentFormat,
    artifactTextTrust: raw.artifactTextTrust,
    available: true,
    unavailableReason: null,
    fragment: raw.fragment,
    fragmentBytes: raw.fragmentBytes,
    nextCursor: raw.nextCursor,
    truncated: raw.truncated,
  };
}

/**
 * Project a verification_pending (not-yet-reviewable) result. Exact delivery
 * verification has NOT been recorded yet, so there is no proof-backed metadata
 * and zero diff bytes to surface honestly — only nulls. Any injected metadata,
 * fragment, cursor, or unknown key was already rejected upstream; here we
 * additionally assert every proof-backed field is exactly null so a service
 * (or a tampered payload) cannot smuggle unproved commit/path/format data
 * through the pending variant.
 */
function projectPendingReview(raw) {
  if (raw.deliveryCommit !== null) throw new Error("verification_pending must not carry deliveryCommit");
  if (raw.changedFileCount !== null) throw new Error("verification_pending must not carry changedFileCount");
  if (raw.changedPath !== null) throw new Error("verification_pending must not carry changedPath");
  if (raw.contentFormat !== null) throw new Error("verification_pending must not carry contentFormat");
  if (raw.artifactTextTrust !== null) throw new Error("verification_pending must not carry artifactTextTrust");

  return {
    runId: raw.runId,
    deliveryCommit: null,
    fileIndex: raw.fileIndex,
    changedFileCount: null,
    changedPath: null,
    contentFormat: null,
    artifactTextTrust: null,
    available: false,
    unavailableReason: REVIEW_PENDING_REASON,
    fragment: "",
    fragmentBytes: 0,
    nextCursor: null,
    truncated: false,
  };
}

/**
 * Project a binary / diff_too_large result. Proof-backed metadata (commit /
 * count / path / format / trust) MUST be present — this is the pre-M11-12A
 * behavior, unchanged. No text fragment (the shared unavailable invariants were
 * already enforced by the caller).
 */
function projectProofBackedUnavailableReview(raw, redactor) {
  // deliveryCommit: canonical lowercase 40/64 hex.
  if (typeof raw.deliveryCommit !== "string" || !isCanonicalCommitId(raw.deliveryCommit)) {
    throw new Error("invalid deliveryCommit");
  }
  // changedFileCount: non-negative integer. (fileIndex need not be in range —
  // the requested file may be the very one that is binary / too large.)
  if (!Number.isInteger(raw.changedFileCount) || raw.changedFileCount < 0) throw new Error("invalid changedFileCount");

  // changedPath: MUST be a canonical repo-relative path (see projectAvailableReview).
  validateProjectedPath(raw.changedPath);
  let changedPath = raw.changedPath;
  if (redactor.redactString(changedPath) !== changedPath) {
    changedPath = "[REDACTED]";
  }

  // contentFormat + artifactTextTrust: exact constants.
  if (raw.contentFormat !== "unified_diff_v1") throw new Error("invalid contentFormat");
  if (raw.artifactTextTrust !== "untrusted_repository_text") throw new Error("invalid artifactTextTrust");

  return {
    runId: raw.runId,
    deliveryCommit: raw.deliveryCommit,
    fileIndex: raw.fileIndex,
    changedFileCount: raw.changedFileCount,
    changedPath,
    contentFormat: raw.contentFormat,
    artifactTextTrust: raw.artifactTextTrust,
    available: false,
    unavailableReason: raw.unavailableReason,
    fragment: "",
    fragmentBytes: 0,
    nextCursor: null,
    truncated: false,
  };
}
