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
import { assertDeliveryCommitInRepository, isValidRunId } from "../delivery.js";
import { validateProjectedPath } from "./deliveryReview.js";

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
// Git maxBuffer is EXACTLY the total cap. A raw diff exceeding 256 KiB causes
// execFileSync to throw (ENOBUFS / maxBuffer), which is distinguishable from an
// ordinary Git failure. No partial stdout is returned on overflow.
const GIT_DIFF_MAX_BUFFER = REVIEW_TOTAL_BYTES;

const CURSOR_VERSION = 2;
const CURSOR_MAX_CHARS = 192;

/**
 * Git stdout outcome: "ok" (string), "failed" (Git/repository error — fail
 * closed, never diff_too_large), or "overflow" (raw output exceeded the hard
 * cap — diff_too_large). Distinguishing these is the M11-3B closeout truth fix.
 * @private
 */
function gitReadBounded(args, cwd) {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      maxBuffer: GIT_DIFF_MAX_BUFFER,
    });
    return { ok: true, out };
  } catch (err) {
    // maxBuffer exceeded → the raw output is genuinely too large.
    if (err && (err.code === "ENOBUFS" || (typeof err.message === "string" && /maxBuffer/i.test(err.message)))) {
      return { ok: false, overflow: true };
    }
    // Any other Git/repository/argv failure → fail closed, not too-large.
    return { ok: false, overflow: false };
  }
}

/**
 * Re-validate the verified path with the strict MCP-boundary SSOT BEFORE any Git
 * call. Defense in depth: even if a future caller passes a pathspec-magic path,
 * the SSOT rejects it here. M11-3B closeout: no second path-rule copy.
 * @private
 */
function assertSafePath(path) {
  try {
    validateProjectedPath(path);
  } catch {
    throw new Error("run_delivery_review failed");
  }
}

/**
 * Detect whether a single-file diff is binary using structured Git metadata
 * (`git --literal-pathspecs diff --numstat`). Binary files print `-` counts.
 * Returns "binary", "text", or "failed" (Git/numstat error → fail closed, never
 * fall back to a text read). `--literal-pathspecs` prevents pathspec magic from
 * matching sibling files.
 * @private
 */
function classifyBinary(base, delivery, path, cwd) {
  const res = gitReadBounded(
    ["--literal-pathspecs", "diff", "--numstat", "--no-renames", base, delivery, "--", path],
    cwd,
  );
  if (!res.ok) return res.overflow ? "failed" : "failed";
  const line = res.out.split("\n").find((l) => l.length > 0);
  if (!line) return "text";
  const parts = line.split("\t");
  return (parts.length >= 3 && parts[0] === "-" && parts[1] === "-") ? "binary" : "text";
}

/**
 * Read the complete single-file unified diff for exact commits + verified path.
 * Structured argv with global `--literal-pathspecs` (no pathspec magic),
 * --no-ext-diff/--no-textconv/--no-color/--unified=3 per spec.
 * Returns { ok, out?, overflow? }: ok=false+overflow=true → diff_too_large;
 * ok=false+overflow=false → ordinary Git failure (caller throws application error).
 * @private
 */
function readCompleteDiff(base, delivery, path, cwd) {
  return gitReadBounded(
    [
      "--literal-pathspecs",
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
 * Compute a 128-bit digest of the final redacted+sanitized complete text,
 * base64url-encoded (22 chars). Used to bind the cursor so a stale cursor
 * (environment/content changed) fails closed even if runId/commit/fileIndex
 * happen to match.
 * @private
 */
function contentDigest(text) {
  return createHash("sha256").update(text, "utf8").digest().subarray(0, 16).toString("base64url");
}

/**
 * Compute a 128-bit irreversible fingerprint of the runId, base64url-encoded
 * (22 chars). The cursor binds the runId via this fingerprint (not the raw
 * runId) so the token does not echo the runId, while still failing cross-run
 * replay even when two runs share the same deliveryCommit + fileIndex + digest.
 * @private
 */
function runIdFingerprint(runId) {
  return createHash("sha256").update(String(runId), "utf8").digest().subarray(0, 16).toString("base64url");
}

/**
 * Encode an opaque cursor. base64url(canonical JSON) v2, binding runId
 * fingerprint + commit + fileIndex + offset + 128-bit content digest.
 * Max 192 chars. Canonical re-encode must equal the input token.
 * @private
 */
function encodeCursor({ runIdFp, deliveryCommit, fileIndex, nextOffset, digest }) {
  const payload = {
    v: CURSOR_VERSION,
    r: runIdFp,
    c: deliveryCommit,
    i: fileIndex,
    o: nextOffset,
    d: digest,
  };
  const token = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  if (token.length > CURSOR_MAX_CHARS) {
    throw new Error("cursor token too large");
  }
  return token;
}

/**
 * Decode and strictly validate an opaque cursor against the expected binding.
 * Failures (malformed/wrong-version/unknown-keys/wrong-types/cross-run/
 * cross-commit/cross-file/offset-out-of-range/mid-codepoint/stale-digest/
 * noncanonical-encoding) throw a fixed "invalid cursor" error. Omitted cursor →
 * offset 0. `artifactAvailable` must be true: a cursor supplied for a
 * binary/too-large/unavailable artifact is rejected.
 * @private
 */
function decodeCursor(token, {
  runIdFp, deliveryCommit, fileIndex, totalSafeBytes, safeTextBuf, digest, artifactAvailable,
}) {
  if (token === undefined || token === null) {
    return { offset: 0 };
  }
  // A cursor is only valid for a reviewable text artifact. Binary/too-large
  // never produce a cursor, so a supplied cursor here is a replay/mismatch.
  if (!artifactAvailable) {
    throw new Error("invalid cursor: artifact not paginated");
  }
  if (typeof token !== "string" || token.length === 0 || token.length > CURSOR_MAX_CHARS) {
    throw new Error("invalid cursor: length");
  }
  // base64url charset only.
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("invalid cursor: encoding");
  }
  let payload;
  let rawDecoded;
  try {
    rawDecoded = Buffer.from(token, "base64url").toString("utf8");
    payload = JSON.parse(rawDecoded);
  } catch {
    throw new Error("invalid cursor: decode");
  }
  if (!payload || payload.v !== CURSOR_VERSION) {
    throw new Error("invalid cursor: version");
  }
  // Strict key set (canonical order: c,d,i,o,r,v).
  const keys = Object.keys(payload).sort().join(",");
  if (keys !== "c,d,i,o,r,v") {
    throw new Error("invalid cursor: keys");
  }
  // Canonical re-encode must equal the input token (rejects noncanonical JSON
  // like reordered/extra-whitespace/repeated-key encodings).
  const canonical = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  if (canonical !== token) {
    throw new Error("invalid cursor: noncanonical encoding");
  }
  if (typeof payload.r !== "string" || payload.r !== runIdFp) {
    throw new Error("invalid cursor: run mismatch");
  }
  if (typeof payload.c !== "string" || payload.c !== deliveryCommit) {
    throw new Error("invalid cursor: commit mismatch");
  }
  if (!Number.isInteger(payload.i) || payload.i !== fileIndex) {
    throw new Error("invalid cursor: file mismatch");
  }
  if (typeof payload.d !== "string" || payload.d !== digest) {
    throw new Error("invalid cursor: stale digest");
  }
  // offset: integer, 0 <= offset < totalSafeBytes (strict less-than; an offset
  // equal to total is the empty terminal page and is never encoded — nextCursor
  // is null there).
  if (!Number.isInteger(payload.o) || payload.o < 0 || payload.o >= totalSafeBytes) {
    throw new Error("invalid cursor: offset out of range");
  }
  // Must not land on a UTF-8 continuation byte (would split a code point).
  if (payload.o > 0 && (safeTextBuf[payload.o] & 0xc0) === 0x80) {
    throw new Error("invalid cursor: offset splits a code point");
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

  // M11-3B closeout: re-validate the verified path with the strict MCP-boundary
  // SSOT BEFORE any Git call. Defense in depth against pathspec magic.
  assertSafePath(path);

  // Build the redactor from the host env (exact-secret SSOT).
  const redactor = createSecretRedactor(hostDependencies.env ?? process.env);
  const safeChangedPath = projectChangedPath(path, redactor);
  const runIdFp = runIdFingerprint(runId);

  // Helper: a binary/too-large/unavailable artifact result. A supplied cursor
  // for such an artifact is rejected (decodeCursor checks artifactAvailable).
  const unavailableResult = (reason) => {
    // Validate/reject cursor even on unavailable artifacts — a cursor supplied
    // here is a replay against a non-paginated artifact.
    if (cursor !== undefined && cursor !== null) {
      throw new Error("invalid cursor: artifact not paginated");
    }
    return {
      runId,
      deliveryCommit: delivery,
      fileIndex,
      changedFileCount: target.changedFileCount,
      changedPath: safeChangedPath,
      contentFormat: "unified_diff_v1",
      artifactTextTrust: "untrusted_repository_text",
      available: false,
      unavailableReason: reason,
      fragment: "",
      fragmentBytes: 0,
      nextCursor: null,
      truncated: false,
    };
  };

  // 2. Binary detection via structured metadata (--literal-pathspecs numstat).
  //    A numstat Git failure fails closed (never falls back to a text read).
  const binaryClass = classifyBinary(base, delivery, path, cwd);
  if (binaryClass === "failed") {
    throw new Error("run_delivery_review failed");
  }
  if (binaryClass === "binary") {
    return unavailableResult("binary");
  }

  // 3. Read the complete single-file diff (bounded to EXACTLY 256 KiB).
  //    overflow (raw > 256 KiB) → diff_too_large (no partial output).
  //    ordinary Git failure → application error (NOT diff_too_large).
  const diffRes = readCompleteDiff(base, delivery, path, cwd);
  if (!diffRes.ok) {
    if (diffRes.overflow) {
      return unavailableResult("diff_too_large");
    }
    throw new Error("run_delivery_review failed");
  }
  const rawDiff = diffRes.out;

  // 4. Redact configured exact secrets across the COMPLETE text (before paging,
  //    so a secret spanning a page boundary is redacted as a whole).
  const redacted = redactor.redactString(rawDiff);

  // 5. Sanitize unsafe control bytes (LF + TAB preserved).
  const sanitized = sanitizeControls(redacted);

  // 6. Hard total cap on the safe text (post-redaction/sanitization). Even if
  //    redaction shrank a too-large raw diff, the raw overflow already decided
  //    diff_too_large; this catches the case where redaction does not shrink
  //    enough. No partial text.
  const safeBuf = Buffer.from(sanitized, "utf8");
  if (safeBuf.length > REVIEW_TOTAL_BYTES) {
    return unavailableResult("diff_too_large");
  }

  const digest = contentDigest(sanitized);

  // 7. Decode/validate cursor (binding runId fingerprint + commit + fileIndex +
  //    digest + offset). artifactAvailable=true here.
  const { offset: startOffset } = decodeCursor(cursor, {
    runIdFp,
    deliveryCommit: delivery,
    fileIndex,
    totalSafeBytes: safeBuf.length,
    safeTextBuf: safeBuf,
    digest,
    artifactAvailable: true,
  });

  const { fragment, nextOffset } = paginateSafe(safeBuf, startOffset);
  const nextCursor = nextOffset !== null
    ? encodeCursor({ runIdFp, deliveryCommit: delivery, fileIndex, nextOffset, digest })
    : null;

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
    nextCursor,
    truncated: nextCursor !== null,
  };
}
