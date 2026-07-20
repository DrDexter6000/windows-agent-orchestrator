// src/application/deliveryReview.js
//
// M11-1A: Safe delivery changed-path projection.
//
// Pure application helper that projects a durable DeliveryRef's changedFiles
// into a bounded, repo-relative, safe list for MCP run_delivery. This is review
// metadata, NOT raw diff or semantic acceptance — only verificationStatus=passed
// means exact-artifact verification passed; the Lead still owns semantic judgment.
//
// Architectural contract:
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Does not execute Git, read files, read env, or mutate input.
//   - Reuses src/delivery.js repo-relative path-validation SSOT
//     (isValidRepoRelativePath). No second path-identity algorithm here.
//
// Path validation here is STRICTER than the packaging SSOT in one dimension:
// a max length (1..512) and a control-character allowlist, because this output
// crosses the MCP boundary to the model. Malformed input fails closed — the
// caller (MCP adapter) folds any throw into the fixed `run_delivery failed`
// error, never echoing the offending value.

import { isValidRepoRelativePath } from "../delivery.js";

/** Server-owned cap for the number of changed paths exposed via MCP. */
export const CHANGED_PATHS_LIMIT = 64;

/** Max length of a single projected repo-relative path. */
const MAX_PATH_LENGTH = 512;

/**
 * Validate a single projected path with MCP-boundary strictness.
 * Builds on the delivery.js repo-relative SSOT and adds length + control-char
 * guards. Returns the canonical forward-slash form, or throws on any violation.
 *
 * Exported (M11-3B closeout) so the delivery-review diff projection reuses the
 * SAME strict path SSOT before any Git call — no second path-rule copy.
 *
 * @param {string} p
 * @returns {string} canonical forward-slash path
 */
export function validateProjectedPath(p) {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error("invalid changedPath: must be a non-empty string");
  }
  if (p.length > MAX_PATH_LENGTH) {
    throw new Error(`invalid changedPath: length ${p.length} exceeds ${MAX_PATH_LENGTH}`);
  }
  // Reject NUL and ANY C0 (0x00-0x1F), DEL (0x7F), or C1 (0x80-0x9F) control
  // character. C1 (e.g. NEL=0x85) is a real attack vector: it is invisible/
  // bidi-affecting in some editors and could smuggle content or break path
  // parsing. The previous regex only covered C0+DEL; C1 is now included.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f-\x9f]/.test(p)) {
    throw new Error("invalid changedPath: control character present");
  }
  // Backslash is non-canonical (Git uses forward slash); reject so the output
  // is always forward-slash. The SSOT validator below also rejects absolute
  // Windows drive paths, UNC, traversal, leading/trailing/double separators.
  if (p.includes("\\")) {
    throw new Error("invalid changedPath: backslash is non-canonical (use forward slash)");
  }
  if (!isValidRepoRelativePath(p)) {
    throw new Error("invalid changedPath: not a canonical repo-relative path");
  }
  return p;
}

/**
 * Project a durable DeliveryRef's changedFiles into a bounded, safe list.
 *
 * Contract:
 *   - changedFiles must be a sorted, unique array of canonical repo-relative
 *     paths (the shape packaging/verification already guarantees). Non-canonical
 *     or malformed input fails closed — callers must not project partial results.
 *   - Output is at most CHANGED_PATHS_LIMIT paths, deterministic (first N after
 *     validating the input is already sorted).
 *   - The CHANGED_PATHS_LIMIT cap is a hard ceiling: a caller-supplied limit
 *     (test-only hook) is clamped to [0, CHANGED_PATHS_LIMIT]; it can never
 *     raise the cap. The MCP adapter does not expose limit to the model.
 *   - changedFileCount is the REAL total from the input array (not the capped
 *     length), so truncation is detectable.
 *   - Input is never mutated.
 *
 * @param {object} input
 * @param {string[]} input.changedFiles — sorted unique repo-relative paths
 * @param {number} [input.limit] — optional test-only hook; clamped to [0, CHANGED_PATHS_LIMIT]
 * @returns {{changedFileCount: number, changedPaths: string[], changedPathsTruncated: boolean}}
 */
export function projectDeliveryChangedPaths({ changedFiles, limit } = {}) {
  if (!Array.isArray(changedFiles)) {
    throw new Error("changedFiles must be an array");
  }
  // The cap is a hard ceiling. Caller-supplied limit is clamped to [0, CAP]; it
  // can only narrow the output, never widen it beyond CHANGED_PATHS_LIMIT.
  // Infinity means "no narrowing" → use the full CAP. Non-finite (other than
  // Infinity) / negative / non-integer values fail closed.
  let cap = CHANGED_PATHS_LIMIT;
  if (limit !== undefined && limit !== null && Number.isFinite(limit)) {
    if (limit < 0 || !Number.isInteger(limit)) {
      throw new Error(`invalid limit: must be a non-negative integer, got ${JSON.stringify(limit)}`);
    }
    cap = Math.min(limit, CHANGED_PATHS_LIMIT);
  }
  // Validate every entry against the strict projection rules. Use a snapshot
  // copy so the caller's array is never mutated even if validation throws.
  const validated = [];
  const seen = new Set();
  let prev = null;
  for (let i = 0; i < changedFiles.length; i += 1) {
    const raw = changedFiles[i];
    const canonical = validateProjectedPath(raw);
    // Duplicate detection (canonical input must be unique).
    if (seen.has(canonical)) {
      throw new Error(`invalid changedFiles: duplicate path at index ${i}`);
    }
    // Sort detection (canonical input must be sorted ascending).
    if (prev !== null && canonical < prev) {
      throw new Error(`invalid changedFiles: unsorted at index ${i}`);
    }
    seen.add(canonical);
    prev = canonical;
    validated.push(canonical);
  }
  const changedPaths = cap > 0 ? validated.slice(0, cap) : [];
  return {
    changedFileCount: validated.length,
    changedPaths,
    changedPathsTruncated: validated.length > changedPaths.length,
  };
}
