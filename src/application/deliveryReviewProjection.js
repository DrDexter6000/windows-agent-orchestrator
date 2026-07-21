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
// Architectural contract:
//   - No Git I/O, no file I/O, no MCP SDK / zod / command imports.
//   - Reuses createSecretRedactor SSOT (exact-secret redaction), isValidRunId,
//     isCanonicalCommitId from delivery.js — no second algorithm.

import { createSecretRedactor } from "../secretRedaction.js";
import { isValidRunId, isCanonicalCommitId } from "../delivery.js";

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

  // deliveryCommit: canonical lowercase 40/64 hex.
  if (typeof raw.deliveryCommit !== "string" || !isCanonicalCommitId(raw.deliveryCommit)) {
    throw new Error("invalid deliveryCommit");
  }

  // fileIndex: non-negative integer.
  if (!Number.isInteger(raw.fileIndex) || raw.fileIndex < 0) throw new Error("invalid fileIndex");
  // changedFileCount: non-negative integer.
  if (!Number.isInteger(raw.changedFileCount) || raw.changedFileCount < 0) throw new Error("invalid changedFileCount");
  // When available, fileIndex must be within range.
  if (raw.available === true && raw.fileIndex >= raw.changedFileCount) throw new Error("fileIndex out of range");

  // changedPath: safe string ≤512; redact if it contains a configured secret.
  if (typeof raw.changedPath !== "string" || raw.changedPath.length === 0 || raw.changedPath.length > 512) {
    throw new Error("invalid changedPath");
  }
  const redactor = createSecretRedactor(env ?? process.env);
  let changedPath = raw.changedPath;
  const redactedPath = redactor.redactString(changedPath);
  if (redactedPath !== changedPath) {
    // Exact-secret redaction changed the path → collapse to [REDACTED].
    changedPath = "[REDACTED]";
  }

  // contentFormat + artifactTextTrust: exact constants.
  if (raw.contentFormat !== "unified_diff_v1") throw new Error("invalid contentFormat");
  if (raw.artifactTextTrust !== "untrusted_repository_text") throw new Error("invalid artifactTextTrust");

  const available = raw.available;
  if (typeof available !== "boolean") throw new Error("invalid available");

  if (available) {
    if (raw.unavailableReason !== null) throw new Error("available but reason set");
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

    // nextCursor: null or opaque base64url string ≤192.
    if (raw.nextCursor !== null) {
      if (typeof raw.nextCursor !== "string" || raw.nextCursor.length === 0 || raw.nextCursor.length > 192) {
        throw new Error("invalid nextCursor");
      }
    }
    const expectedTruncated = raw.nextCursor !== null;
    if (raw.truncated !== expectedTruncated) throw new Error("truncated/nextCursor inconsistency");
  } else {
    if (raw.unavailableReason !== "binary" && raw.unavailableReason !== "diff_too_large") {
      throw new Error("invalid unavailableReason");
    }
    if (raw.fragment !== "") throw new Error("unavailable but fragment non-empty");
    if (raw.fragmentBytes !== 0) throw new Error("unavailable but fragmentBytes non-zero");
    if (raw.nextCursor !== null) throw new Error("unavailable but nextCursor non-null");
    if (raw.truncated !== false) throw new Error("unavailable but truncated true");
  }

  // Build and return a NEW object — never the raw service reference.
  return {
    runId: raw.runId,
    deliveryCommit: raw.deliveryCommit,
    fileIndex: raw.fileIndex,
    changedFileCount: raw.changedFileCount,
    changedPath,
    contentFormat: raw.contentFormat,
    artifactTextTrust: raw.artifactTextTrust,
    available,
    unavailableReason: raw.unavailableReason,
    fragment: raw.fragment,
    fragmentBytes: raw.fragmentBytes,
    nextCursor: raw.nextCursor,
    truncated: raw.truncated,
  };
}
