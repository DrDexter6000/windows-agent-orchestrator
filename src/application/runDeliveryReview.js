// src/application/runDeliveryReview.js
//
// M11-3A: read-only delivery review eligibility + target resolver.
// M11-3B: bounded redacted delivery diff projection + stateless continuation.
//
// This service resolves the review target for one verified delivery file (M11-3A)
// and then projects a bounded, redacted, sanitized, paginated diff fragment from
// the EXACT committed delivery (M11-3B). The eligibility resolver is the trust
// boundary that runs BEFORE any Git content read. It proves, in strict order:
//
//   1. runId is well-formed (before any transcript path join);
//   2. the host-owned transcript is readable;
//   3. durable delivery facts are unambiguous (exactly one delivery_created and
//      one matching final verification outcome), via the SAME validateDeliveryFacts
//      SSOT that tryAppendDecision uses;
//   4. the full durable identity chain (created/verification events AND refs)
//      matches the requested runId;
//   5. the run belongs to the authorized workspace (verifyRunWorkspaceOwnership);
//   6. the exact delivery commit exists in the authorized source repo and matches
//      base/parent/count/files/message/identity (assertDeliveryCommitInRepository);
//   7. fileIndex addresses a verified changed file.
//
// Only then does M11-3B read a single-file diff via structured Git argv (no shell,
// no ext-diff, no textconv, no pager), with a hard 256 KiB bound. The complete
// text is redacted with the configured exact-secret SSOT, sanitized of unsafe
// control bytes (LF and TAB preserved), and paged at a valid UTF-8 code-point
// boundary. The cursor is an opaque, stateless, content-bound token.
//
// Architectural contract:
//   - Imports NO command module, MCP SDK, or zod.
//   - Delegates to delivery.js (proof kernel + path SSOT), transcript.js (facts
//     SSOT), runWorkspaceOwnership.js (ownership SSOT), secretRedaction.js
//     (exact-secret SSOT), and readTranscript (host-owned).
//   - Returns only safe structured results. It NEVER returns raw diff bytes,
//     absolute paths, commands, worktree paths, branches, raw errors, or any
//     intermediate raw artifact.
//   - Final `passed`, `failed`, and `unavailable` deliveries are reviewable;
//     `pending` or ambiguous facts are not. Acceptance status does not affect
//     read-only availability.
//
// All Git work uses structured argv only (no shell interpolation, ext-diff,
// textconv, pager, or model-controlled cwd/ref/path).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { readTranscript } from "../transcript.js";
import { validateDeliveryFacts } from "../transcript.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";
import { createSecretRedactor } from "../secretRedaction.js";
import { assertDeliveryCommitInRepository } from "../delivery.js";
import { isValidRunId } from "../delivery.js";

/**
 * Validate a fileIndex against a verified changed-file list.
 * @param {number} fileIndex
 * @param {number} fileCount
 * @throws {Error} if not a non-negative integer within range
 */
function validateFileIndex(fileIndex, fileCount) {
  if (!Number.isInteger(fileIndex) || fileIndex < 0) {
    throw new Error("fileIndex must be a non-negative integer");
  }
  if (fileIndex >= fileCount) {
    throw new Error(`fileIndex ${fileIndex} out of range (changedFileCount=${fileCount})`);
  }
}

/**
 * Resolve the review target for one verified delivery file. Read-only: creates
 * no transcript event, no filesystem mutation, no Git mutation.
 *
 * Gate order is deliberate — every later gate is unreachable until the earlier
 * one passes, so a cross-workspace / ambiguous / pending request fails BEFORE
 * any Git content is read.
 *
 * @param {object} input
 * @param {string} input.runId — well-formed run id
 * @param {string} input.runDir — host-owned runs directory (transcript location)
 * @param {string} input.authorizedWorkspaceRoot — canonical source repo root
 *   from the host workspace binding
 * @param {number} input.fileIndex — index into the verified sorted changedFiles
 * @param {Function} [input.readTranscriptFn] — injectable for deterministic tests
 * @returns {Promise<object>} resolved target:
 *   { runId, deliveryCommit, baseCommit, changedFiles, changedFileCount,
 *     fileIndex, changedPath, verificationStatus }
 *   — NEVER includes diff/fragment/content/worktree/branch.
 * @throws {Error} on any eligibility, ownership, proof, or index failure
 */
export async function resolveRunDeliveryReviewTarget({
  runId,
  runDir,
  authorizedWorkspaceRoot,
  fileIndex,
  readTranscriptFn,
}) {
  // 1. runId must be well-formed BEFORE any path join (no traversal).
  if (!isValidRunId(runId)) {
    throw new Error("invalid runId");
  }
  if (typeof runDir !== "string" || runDir.length === 0) {
    throw new Error("runDir must be a non-empty string");
  }
  if (typeof authorizedWorkspaceRoot !== "string" || authorizedWorkspaceRoot.length === 0) {
    throw new Error("authorizedWorkspaceRoot must be a non-empty string");
  }

  const _readTranscript = readTranscriptFn ?? readTranscript;

  // 2. Read the host-owned transcript.
  const { join } = await import("node:path");
  const filePath = join(runDir, `${runId}.jsonl`);
  let events;
  try {
    events = await _readTranscript(filePath);
  } catch {
    throw new Error("transcript not readable");
  }
  if (!Array.isArray(events)) {
    throw new Error("transcript malformed");
  }

  // 3. Durable delivery facts (unambiguous: exactly one created + one matching
  //    final verification outcome). Reuses the SAME SSOT as tryAppendDecision.
  const facts = validateDeliveryFacts(events);
  if (!facts.valid) {
    throw new Error(`delivery facts not reviewable: ${facts.error}`);
  }
  // Only final outcomes are reviewable. validateDeliveryFacts already requires
  // exactly one verification outcome event, so verificationStatus here is one of
  // passed/failed/unavailable (never pending when valid). Pending runs surface as
  // valid:false above. Guard defensively regardless.
  if (facts.verificationStatus === "pending") {
    throw new Error("delivery verification is pending; not reviewable");
  }

  // 4. Full durable-run identity binding. The requested runId must equal ALL of:
  //    - the run.delivery_created event envelope runId;
  //    - the verification event envelope runId;
  //    - the created DeliveryRef.runId;
  //    - the verification (latest) DeliveryRef.runId.
  //    Any mismatch means a cross-run ref or event was injected into this
  //    transcript (created ref of run B, verification ref of run A, etc.). This
  //    must pass BEFORE workspace ownership and the Git proof, so a cross-run
  //    DeliveryRef cannot reach the object database. Fixed message — never echo
  //    dynamic runId values into adapter-facing errors.
  const deliveryRef = facts.latestRef;
  const createdRef = facts.createdRef;
  if (
    facts.createdEventRunId !== runId
    || facts.verificationEventRunId !== runId
    || !createdRef || createdRef.runId !== runId
    || !deliveryRef || deliveryRef.runId !== runId
  ) {
    throw new Error("runId mismatch: durable delivery identity does not match the requested runId");
  }

  // 5. Workspace ownership — the run must belong to the authorized source repo.
  //    This must pass BEFORE the Git proof, so a cross-workspace request never
  //    reaches the object database.
  verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot);

  // 6. Exact delivery commit proof in the authorized source repo. The kernel
  //    uses explicit commit args (not HEAD), so a dirty or advanced source
  //    checkout does not affect the proof, and a removed linked worktree is
  //    irrelevant — the commit objects live in the source repo.
  const proof = assertDeliveryCommitInRepository({
    repoRoot: authorizedWorkspaceRoot,
    deliveryRef,
  });

  // 7. fileIndex addresses a verified changed file. The path returned to the
  //    caller comes ONLY from the verified sorted list, never from model input.
  const sortedFiles = [...proof.changedFiles].sort();
  validateFileIndex(fileIndex, sortedFiles.length);
  const changedPath = sortedFiles[fileIndex];

  return {
    runId,
    deliveryCommit: proof.deliveryCommit,
    baseCommit: proof.baseCommit,
    changedFiles: sortedFiles,
    changedFileCount: sortedFiles.length,
    fileIndex,
    changedPath,
    verificationStatus: facts.verificationStatus,
  };
}

// =====================================================================
// M11-3B: bounded redacted delivery diff projection + continuation.
//
// Private helpers below. Only getRunDeliveryReview is exported. The raw Git diff
// reader never escapes this module; the public result is always redacted,
// sanitized, and paginated.
// =====================================================================

// Server-owned hard caps (per spec §5).
const REVIEW_PAGE_BYTES = 16 * 1024;       // 16 KiB per page (UTF-8 bytes AND JS chars)
const REVIEW_PAGE_CHARS = 16384;           // 16384 JS characters
const REVIEW_TOTAL_BYTES = 256 * 1024;     // 256 KiB total per file
// Git maxBuffer: allow reading up to the total cap plus headroom for the diff
// envelope (headers/hunks). Anything beyond is folded to diff_too_large.
const GIT_DIFF_MAX_BUFFER = REVIEW_TOTAL_BYTES + 8 * 1024;

const CURSOR_VERSION = 1;
const CURSOR_MAX_CHARS = 192;

/**
 * Run git with structured argv (no shell). Returns stdout string, or null on
 * failure. cwd is always the authorized source repo; commit/path args come only
 * from the M11-3A proof (canonical literals + verified path).
 * @private
 */
function gitRead(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      maxBuffer: GIT_DIFF_MAX_BUFFER,
    });
  } catch {
    return null;
  }
}

/**
 * Detect whether a single-file diff is binary using structured Git metadata
 * (`git diff --numstat`). Binary files print `-` for added/deleted counts.
 * No content bytes are read here.
 * @private
 */
function isBinaryDiff(base, delivery, path, cwd) {
  const out = gitRead(
    ["diff", "--numstat", "--no-renames", base, delivery, "--", path],
    cwd,
  );
  if (out === null) return false; // unknown → let the diff read decide
  const line = out.split("\n").find((l) => l.length > 0);
  if (!line) return false;
  // Binary: "-\t-\tpath"
  const parts = line.split("\t");
  return parts.length >= 3 && parts[0] === "-" && parts[1] === "-";
}

/**
 * Read the complete single-file unified diff for exact commits + verified path.
 * Structured argv; --no-ext-diff/--no-textconv/--no-color/--unified=3 per spec.
 * Returns the raw diff string, or null if it could not be read bounded.
 * @private
 */
function readCompleteDiff(base, delivery, path, cwd) {
  return gitRead(
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--unified=3",
      base,
      delivery,
      "--",
      path,
    ],
    cwd,
  );
}

/**
 * Replace unsafe control characters. LF (0x0A) and TAB (0x09) are preserved;
 * every other C0 (0x00-0x1F except LF/TAB) and DEL (0x7F) and C1 (0x80-0x9F)
 * is replaced with a space. Operates on the UTF-8 string (JS UTF-16 code units;
 * control chars are single code units so this is code-point safe).
 * @private
 */
function sanitizeControls(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x0a || code === 0x09) {
      out += text[i];
    } else if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += " ";
    } else {
      out += text[i];
    }
  }
  return out;
}

/**
 * Compute a short, stable digest of the final redacted+sanitized complete text,
 * used to bind the cursor so a stale cursor (environment/content changed) fails
 * closed even if runId/commit/fileIndex happen to match.
 * @private
 */
function contentDigest(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * Encode an opaque cursor. base64url(JSON) v1, binding commit/fileIndex/offset
 * and the redacted-content digest. Max 192 chars.
 * @private
 */
function encodeCursor({ deliveryCommit, fileIndex, nextOffset, digest }) {
  const payload = JSON.stringify({
    v: CURSOR_VERSION,
    c: deliveryCommit,
    i: fileIndex,
    o: nextOffset,
    d: digest,
  });
  const token = Buffer.from(payload, "utf8").toString("base64url");
  if (token.length > CURSOR_MAX_CHARS) {
    throw new Error("cursor token too large");
  }
  return token;
}

/**
 * Decode and strictly validate an opaque cursor against the expected binding.
 * Failures (malformed/wrong-version/unknown-keys/wrong-types/cross-artifact/
 * offset-out-of-range/mid-codepoint/stale-digest) throw. Omitted cursor →
 * offset 0 with no binding check beyond the expected commit/fileIndex.
 * @private
 */
function decodeCursor(token, { deliveryCommit, fileIndex, totalSafeBytes, safeTextBuf, digest }) {
  if (token === undefined || token === null) {
    return { offset: 0 };
  }
  if (typeof token !== "string" || token.length === 0 || token.length > CURSOR_MAX_CHARS) {
    throw new Error("invalid cursor: length");
  }
  // base64url charset only.
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("invalid cursor: encoding");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid cursor: decode");
  }
  if (!payload || payload.v !== CURSOR_VERSION) {
    throw new Error("invalid cursor: version");
  }
  // Strict key set.
  const keys = Object.keys(payload).sort().join(",");
  if (keys !== "c,d,i,o,v") {
    throw new Error("invalid cursor: keys");
  }
  if (typeof payload.c !== "string" || payload.c !== deliveryCommit) {
    throw new Error("invalid cursor: commit mismatch");
  }
  if (!Number.isInteger(payload.i) || payload.i !== fileIndex) {
    throw new Error("invalid cursor: file mismatch");
  }
  if (!Number.isInteger(payload.o) || payload.o < 0) {
    throw new Error("invalid cursor: offset");
  }
  if (payload.o > totalSafeBytes) {
    throw new Error("invalid cursor: offset beyond end");
  }
  // Must not land in the middle of a UTF-8 code point.
  if (payload.o > 0 && payload.o < totalSafeBytes) {
    // A continuation byte is 0x80..0xBF. A start byte at offset o means the
    // following slice begins a fresh code point.
    if ((safeTextBuf[payload.o] & 0xc0) === 0x80) {
      throw new Error("invalid cursor: offset splits a code point");
    }
  }
  if (typeof payload.d !== "string" || payload.d !== digest) {
    throw new Error("invalid cursor: stale token");
  }
  return { offset: payload.o };
}

/**
 * Slice the safe (redacted+sanitized) text into one page starting at a UTF-8
 * byte offset, without splitting a code point, capping at REVIEW_PAGE_BYTES
 * UTF-8 bytes and REVIEW_PAGE_CHARS JS characters. Returns { fragment, nextOffset }.
 * @private
 */
function paginateSafe(safeBuf, startOffset) {
  const total = safeBuf.length;
  let end = startOffset;
  let chars = 0;
  while (end < total) {
    const byte = safeBuf[end];
    // Determine the code-point length of the byte at `end`.
    let cpLen = 1;
    if ((byte & 0x80) === 0) cpLen = 1;
    else if ((byte & 0xe0) === 0xc0) cpLen = 2;
    else if ((byte & 0xf0) === 0xe0) cpLen = 3;
    else if ((byte & 0xf8) === 0xf0) cpLen = 4;
    else {
      // A stray continuation byte should not occur (sanitizeControls + valid
      // UTF-8 input), but fail closed by stopping before it.
      break;
    }
    if (end + cpLen > total) break; // truncated multi-byte at buffer end
    const projectedBytes = end + cpLen - startOffset;
    if (projectedBytes > REVIEW_PAGE_BYTES) break;
    if (chars + 1 > REVIEW_PAGE_CHARS) break;
    end += cpLen;
    chars += 1;
  }
  const fragment = safeBuf.subarray(startOffset, end).toString("utf8");
  const nextOffset = end < total ? end : null;
  return { fragment, nextOffset };
}

/**
 * Project a safe changedPath. Reuses the exact-secret redactor on the verified
 * path; if redaction changes it, the whole path collapses to "[REDACTED]".
 * @private
 */
function projectChangedPath(path, redactor) {
  const r = redactor.redactString(path);
  return r === path ? path : "[REDACTED]";
}

/**
 * M11-3B public service: project one bounded, redacted, sanitized, paginated
 * diff fragment for a verified delivery file. Stateless: no transcript event,
 * no cursor persistence, no Git mutation.
 *
 * Pipeline (strict order):
 *   resolveRunDeliveryReviewTarget (M11-3A eligibility)
 *   → binary detection (metadata only) / size guard
 *   → read complete bounded single-file diff
 *   → redact exact secrets across the COMPLETE text (before paging)
 *   → sanitize unsafe control bytes (LF + TAB preserved)
 *   → UTF-8 pagination at a code-point boundary
 *   → safe structured result + opaque cursor
 *
 * @param {object} input
 * @param {string} input.runId
 * @param {string} input.runDir
 * @param {string} input.authorizedWorkspaceRoot
 * @param {number} input.fileIndex
 * @param {string} [input.cursor] — opaque continuation token
 * @param {object} [hostDependencies] — test-only injection
 * @param {object} [hostDependencies.env] — env for the secret redactor
 * @param {Function} [hostDependencies.readTranscriptFn]
 * @returns {Promise<object>} safe structured review result
 */
export async function getRunDeliveryReview(
  { runId, runDir, authorizedWorkspaceRoot, fileIndex, cursor },
  hostDependencies = {},
) {
  // 1. Eligibility + exact target (M11-3A). All runId/ownership/proof/fileIndex
  //    gates run here, before any diff content is read.
  const target = await resolveRunDeliveryReviewTarget({
    runId,
    runDir,
    authorizedWorkspaceRoot,
    fileIndex,
    ...(hostDependencies.readTranscriptFn ? { readTranscriptFn: hostDependencies.readTranscriptFn } : {}),
  });

  const base = target.baseCommit;
  const delivery = target.deliveryCommit;
  const path = target.changedPath;
  const cwd = authorizedWorkspaceRoot;

  // Build the redactor from the host env (exact-secret SSOT).
  const redactor = createSecretRedactor(hostDependencies.env ?? process.env);
  const safeChangedPath = projectChangedPath(path, redactor);

  // 2. Binary detection via structured metadata. Binary → metadata-only result.
  if (isBinaryDiff(base, delivery, path, cwd)) {
    return {
      runId,
      deliveryCommit: delivery,
      fileIndex,
      changedFileCount: target.changedFileCount,
      changedPath: safeChangedPath,
      contentFormat: "unified_diff_v1",
      artifactTextTrust: "untrusted_repository_text",
      available: false,
      unavailableReason: "binary",
      fragment: "",
      fragmentBytes: 0,
      nextCursor: null,
      truncated: false,
    };
  }

  // 3. Read the complete single-file diff (bounded). null/over-cap → too large.
  const rawDiff = readCompleteDiff(base, delivery, path, cwd);
  if (rawDiff === null) {
    return {
      runId,
      deliveryCommit: delivery,
      fileIndex,
      changedFileCount: target.changedFileCount,
      changedPath: safeChangedPath,
      contentFormat: "unified_diff_v1",
      artifactTextTrust: "untrusted_repository_text",
      available: false,
      unavailableReason: "diff_too_large",
      fragment: "",
      fragmentBytes: 0,
      nextCursor: null,
      truncated: false,
    };
  }

  // 4. Redact configured exact secrets across the COMPLETE text (before paging,
  //    so a secret spanning a page boundary is redacted as a whole).
  const redacted = redactor.redactString(rawDiff);

  // 5. Sanitize unsafe control bytes (LF + TAB preserved).
  const sanitized = sanitizeControls(redacted);

  // 6. Hard total cap on the safe text (post-redaction/sanitization).
  const safeBuf = Buffer.from(sanitized, "utf8");
  if (safeBuf.length > REVIEW_TOTAL_BYTES) {
    return {
      runId,
      deliveryCommit: delivery,
      fileIndex,
      changedFileCount: target.changedFileCount,
      changedPath: safeChangedPath,
      contentFormat: "unified_diff_v1",
      artifactTextTrust: "untrusted_repository_text",
      available: false,
      unavailableReason: "diff_too_large",
      fragment: "",
      fragmentBytes: 0,
      nextCursor: null,
      truncated: false,
    };
  }

  const digest = contentDigest(sanitized);

  // 7. Decode/validate cursor (binding commit/fileIndex/digest/offset) and page.
  const { offset: startOffset } = decodeCursor(cursor, {
    deliveryCommit: delivery,
    fileIndex,
    totalSafeBytes: safeBuf.length,
    safeTextBuf: safeBuf,
    digest,
  });

  const { fragment, nextOffset } = paginateSafe(safeBuf, startOffset);

  return {
    runId,
    deliveryCommit: delivery,
    fileIndex,
    changedFileCount: target.changedFileCount,
    changedPath: safeChangedPath,
    contentFormat: "unified_diff_v1",
    artifactTextTrust: "untrusted_repository_text",
    available: true,
    unavailableReason: null,
    fragment,
    fragmentBytes: Buffer.byteLength(fragment, "utf8"),
    nextCursor: nextOffset !== null
      ? encodeCursor({ deliveryCommit: delivery, fileIndex, nextOffset, digest })
      : null,
    truncated: false,
  };
}
