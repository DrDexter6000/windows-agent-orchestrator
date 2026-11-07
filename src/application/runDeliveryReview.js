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
import { resolveTranscriptPath } from "../projectBuckets.js";
import { validateDeliveryFacts } from "../transcript.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";
import { createSecretRedactor } from "../secretRedaction.js";
import { assertDeliveryCommitInRepository, isValidRunId, gitChildEnv } from "../delivery.js";
import { validateProjectedPath } from "./deliveryReview.js";
import { projectDeliveryReadiness } from "./runDelivery.js";
import { continuableLineageFact } from "./runContinue.js";
import { REVIEW_PENDING_REASON } from "./reviewUnavailableReasons.js";
// F5 (2026-10-08): typed cursor-rejection signal — the SAME class run_activity
// (M12-19) defined and exported. One class definition keeps instanceof identity
// across the application layer (see the matching note in runCollectProjection).
import { CursorRejectedError } from "./runActivityProjection.js";

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

// =====================================================================
// Decision 0116 --since-parent: the review base override for continuation
// child runs. The parent delivery commit is resolved ONLY from this run's
// own transcript continuation facts and proven through the SAME delivery
// facts / workspace ownership / Git proof kernel as the run itself. No
// external entry point (MCP tool input, CLI parameter) accepts a commit:
// the sole switch is the literal boolean sinceParent, so an arbitrary
// commit can never enter the diff base.
//
// Continuation-round hardening (consult b2f2f9d review): the ONLY parent
// fact source is `run.background_submitted` (the sole production event that
// writes parentRunId), it must be runId-bound, `continuation:true`, and
// EXACTLY ONE such fact may exist (duplicates refuse — the same uniqueness
// discipline as delivery facts). Parent fields on `run.started` are NEVER
// recognized, so a forged appended run.started cannot hijack the base. The
// fact's rootRunId must agree with THIS run's own run.session_reuse lineage
// root (decision 0112 SSOT), and the parent must belong to the same lineage.
// =====================================================================

const SINCE_PARENT_NO_PARENT_TEXT =
  "--since-parent is only available for a continuation child run: no bound parent run fact";
const SINCE_PARENT_AMBIGUOUS_TEXT =
  "--since-parent rejected: ambiguous continuation facts (expected exactly one bound run.background_submitted continuation fact)";
const SINCE_PARENT_WORKSPACE_TEXT =
  "--since-parent rejected: the parent run does not belong to the authorized workspace";
const SINCE_PARENT_LINEAGE_TEXT =
  "--since-parent rejected: lineage mismatch (rootRunId does not match the parent lineage)";
const SINCE_PARENT_NO_DELIVERY_TEXT =
  "--since-parent rejected: the parent run has no proven delivery commit";
const SINCE_PARENT_EMPTY_DELTA_TEXT =
  "--since-parent rejected: this round has no changes relative to the parent delivery";

/**
 * Closed-set marker on the six fixed --since-parent rejection errors, so the
 * CLI --all adapter can surface exactly these fixed texts while folding every
 * OTHER unexpected exception into the generic review failure copy.
 * @private
 */
function sinceParentRejection(text) {
  const error = new Error(text);
  error.waoSinceParentRejection = true;
  return error;
}

/**
 * Count the runId-BOUND run.background_submitted continuation facts. Shared by
 * the getRunDeliveryReview gate (so a duplicated fact is classified as the
 * closed-set ambiguity rejection BEFORE the workspace-ownership verifier would
 * reject the same transcript for a less specific reason) and by
 * resolveContinuationParent (the authoritative shape checks).
 * @private
 */
function continuationFactCandidates(events, runId) {
  const candidates = [];
  for (const e of events) {
    if (!e || e.runId !== runId) continue;
    if (e.type !== "run.background_submitted" || e.continuation !== true) continue;
    candidates.push(e);
  }
  return candidates;
}

/**
 * Resolve the PROVEN parent delivery commit for a continuation child run.
 * Fixed-text rejections (closed set): no parent fact / unreadable parent
 * transcript; ambiguous (duplicated) continuation facts; parent not in the
 * authorized workspace; lineage mismatch (fact root vs own session_reuse
 * root, or vs the parent's lineage root); parent without a proven delivery
 * commit (final verification outcome required — passed/failed/unavailable
 * all qualify; only pending does not). None of them echo paths, run ids,
 * commits, or Git errors.
 *
 * @param {object} input
 * @param {string} input.runId — the child run id (facts are read bound to it)
 * @param {object[]} input.events — the child transcript snapshot
 * @param {string} input.runDir
 * @param {string} input.authorizedWorkspaceRoot
 * @param {Function} [input.readTranscriptFn]
 * @returns {Promise<{parentRunId: string, deliveryCommit: string}>}
 */
async function resolveContinuationParent({
  runId, events, runDir, authorizedWorkspaceRoot, readTranscriptFn,
}) {
  // 1. The continuation fact: runId-BOUND run.background_submitted with
  //    continuation:true — count them ALL; exactly one is acceptable.
  //    run.started parent fields are never a fact source. AND that fact must
  //    be THIS run's FIRST transcript event: runContinue step 15 writes it
  //    before anything else (before the runner starts), so a continuation
  //    fact appended later — a foreground run, or an ordinary background
  //    dispatch — is a forgery, refused as "no parent run".
  const candidates = continuationFactCandidates(events, runId);
  if (candidates.length > 1) {
    throw sinceParentRejection(SINCE_PARENT_AMBIGUOUS_TEXT);
  }
  const factEvent = candidates[0];
  if (!factEvent
    || events[0] !== factEvent
    || typeof factEvent.parentRunId !== "string" || !isValidRunId(factEvent.parentRunId)
    || typeof factEvent.rootRunId !== "string" || !isValidRunId(factEvent.rootRunId)
    || factEvent.parentRunId === runId) {
    throw sinceParentRejection(SINCE_PARENT_NO_PARENT_TEXT);
  }
  const fact = { parentRunId: factEvent.parentRunId, rootRunId: factEvent.rootRunId };

  // 2. The child's own lineage fact must agree: the continuation fact's
  //    rootRunId must equal the root of THIS run's bound run.session_reuse
  //    (decision 0112 SSOT — no second membership algorithm).
  const childLineage = continuableLineageFact(events, runId);
  if (!childLineage || childLineage.rootRunId !== fact.rootRunId) {
    throw sinceParentRejection(SINCE_PARENT_LINEAGE_TEXT);
  }

  // 3. Read the parent transcript (unreadable/malformed = no parent run).
  let parentEvents;
  try {
    parentEvents = await (readTranscriptFn ?? readTranscript)(
      resolveTranscriptPath(runDir, fact.parentRunId),
    );
  } catch {
    throw sinceParentRejection(SINCE_PARENT_NO_PARENT_TEXT);
  }
  if (!Array.isArray(parentEvents)) {
    throw sinceParentRejection(SINCE_PARENT_NO_PARENT_TEXT);
  }

  // 4. The parent must belong to the SAME authorized workspace (before any
  //    Git proof, same gate order as the child).
  try {
    verifyRunWorkspaceOwnership(parentEvents, authorizedWorkspaceRoot, fact.parentRunId);
  } catch {
    throw sinceParentRejection(SINCE_PARENT_WORKSPACE_TEXT);
  }

  // 5. The parent must be a member of the SAME lineage (its own lineage root
  //    equals the fact's rootRunId — a root run satisfies this trivially).
  const parentLineage = continuableLineageFact(parentEvents, fact.parentRunId);
  if (!parentLineage || parentLineage.rootRunId !== fact.rootRunId) {
    throw sinceParentRejection(SINCE_PARENT_LINEAGE_TEXT);
  }

  // 6. Parent delivery facts + full durable identity binding — the SAME
  //    validateDeliveryFacts SSOT and binding discipline as the child. A
  //    FINAL verification outcome is required (passed/failed/unavailable all
  //    qualify); a pending parent is not a proven delivery.
  const pf = validateDeliveryFacts(parentEvents, { expectedRunId: fact.parentRunId });
  if (!pf.valid || pf.verificationStatus === "pending") {
    throw sinceParentRejection(SINCE_PARENT_NO_DELIVERY_TEXT);
  }
  if (
    pf.createdEventRunId !== fact.parentRunId
    || pf.verificationEventRunId !== fact.parentRunId
    || !pf.createdRef || pf.createdRef.runId !== fact.parentRunId
    || !pf.latestRef || pf.latestRef.runId !== fact.parentRunId
  ) {
    throw sinceParentRejection(SINCE_PARENT_NO_DELIVERY_TEXT);
  }

  // 7. Exact parent delivery commit proof in the authorized source repo —
  //    the SAME kernel as the child proof (delivery events alone are not
  //    enough: the commit must exist and match the ref).
  let parentProof;
  try {
    parentProof = assertDeliveryCommitInRepository({
      repoRoot: authorizedWorkspaceRoot,
      deliveryRef: pf.latestRef,
    });
  } catch {
    throw sinceParentRejection(SINCE_PARENT_NO_DELIVERY_TEXT);
  }
  return { parentRunId: fact.parentRunId, deliveryCommit: parentProof.deliveryCommit };
}

/**
 * List the changed files between two proven commits (sorted). Structured
 * argv, --no-renames + -z (same path discipline as the delivery kernel's
 * file listing); bounded by the same 256 KiB raw cap; any Git failure or
 * overflow fails closed with the fixed review failure text.
 * @private
 */
function listDeltaFiles(base, delivery, cwd) {
  const res = gitReadBounded(
    ["--literal-pathspecs", "diff", "--no-renames", "--name-only", "-r", "-z", base, delivery],
    cwd,
  );
  if (!res.ok) {
    throw new Error("run_delivery_review failed");
  }
  return res.out.split("\0").filter((p) => p.length > 0).sort();
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
 * @param {boolean} [input.sinceParent] — decision 0116 internal base override:
 *   only the literal `true`; resolves + proves the parent delivery commit from
 *   this run's own continuation facts and makes it the diff base (the changed
 *   list becomes the parent→delivery delta). External callers cannot pass a
 *   commit through this or any other parameter.
 * @param {Function} [input.readTranscriptFn] — injectable for deterministic tests
 * @returns {Promise<object>} resolved target:
 *   { runId, deliveryCommit, baseCommit, changedFiles, changedFileCount,
 *     fileIndex, changedPath, verificationStatus }
 *   — with sinceParent, baseCommit IS the proven parent delivery commit, the
 *   changed list is the parent→delivery delta, and parentRunId /
 *   parentDeliveryCommit are added. NEVER includes diff/fragment/content/
 *   worktree/branch.
 * @throws {Error} on any eligibility, ownership, proof, or index failure
 */
export async function resolveRunDeliveryReviewTarget({
  runId,
  runDir,
  authorizedWorkspaceRoot,
  fileIndex,
  sinceParent,
  readTranscriptFn,
}) {
  // The base override is a boolean, not a value: anything but the literal
  // true is refused, so no caller can smuggle a commit-shaped input.
  if (sinceParent !== undefined && sinceParent !== true) {
    throw new Error("sinceParent must be the literal true");
  }
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
  const filePath = resolveTranscriptPath(runDir, runId);
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
  const facts = validateDeliveryFacts(events, { expectedRunId: runId });
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
  verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot, runId);

  // 6. Exact delivery commit proof in the authorized source repo. The kernel
  //    uses explicit commit args (not HEAD), so a dirty or advanced source
  //    checkout does not affect the proof, and a removed linked worktree is
  //    irrelevant — the commit objects live in the source repo.
  const proof = assertDeliveryCommitInRepository({
    repoRoot: authorizedWorkspaceRoot,
    deliveryRef,
  });

  // 6b. Decision 0116 --since-parent base override: resolve + prove the
  //     parent delivery commit from THIS run's continuation facts, then make
  //     it the diff base and replace the changed-file list with the
  //     parent→delivery delta (a continuation child packages CUMULATIVE
  //     results against the lineage base; the delta is this round's work).
  let parent = null;
  let sortedFiles = [...proof.changedFiles].sort();
  if (sinceParent) {
    parent = await resolveContinuationParent({
      runId,
      events,
      runDir,
      authorizedWorkspaceRoot,
      ...(readTranscriptFn ? { readTranscriptFn } : {}),
    });
    sortedFiles = listDeltaFiles(parent.deliveryCommit, proof.deliveryCommit, authorizedWorkspaceRoot);
    if (sortedFiles.length === 0) {
      throw sinceParentRejection(SINCE_PARENT_EMPTY_DELTA_TEXT);
    }
  }

  // 7. fileIndex addresses a verified changed file. The path returned to the
  //    caller comes ONLY from the verified sorted list, never from model input.
  validateFileIndex(fileIndex, sortedFiles.length);
  const changedPath = sortedFiles[fileIndex];

  return {
    runId,
    deliveryCommit: proof.deliveryCommit,
    baseCommit: parent ? parent.deliveryCommit : proof.baseCommit,
    changedFiles: sortedFiles,
    changedFileCount: sortedFiles.length,
    fileIndex,
    changedPath,
    verificationStatus: facts.verificationStatus,
    ...(parent ? { parentRunId: parent.parentRunId, parentDeliveryCommit: parent.deliveryCommit } : {}),
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

const CURSOR_VERSION = 3;
const CURSOR_MAX_CHARS = 192;

/**
 * Git stdout outcome: "ok" (string), "failed" (Git/repository error — fail
 * closed, never diff_too_large), or "overflow" (raw output exceeded the hard
 * cap — diff_too_large). Distinguishing these is the M11-3B closeout truth fix.
 * @private
 */
function gitReadBounded(args, cwd, gitExec) {
  const exec = gitExec ?? execFileSync;
  try {
    const out = exec("git", args, {
      cwd,
      encoding: "utf8",
      // TD-236：review 面 diff 读取禁用 replace objects（gitChildEnv SSOT，注入 exec 不受影响）。
      env: gitChildEnv(),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      maxBuffer: GIT_DIFF_MAX_BUFFER,
    });
    // Even under a test injection, enforce the hard raw cap: an injected output
    // larger than 256 KiB is treated as overflow, never returned raw.
    if (typeof out === "string" && Buffer.byteLength(out, "utf8") > GIT_DIFF_MAX_BUFFER) {
      return { ok: false, overflow: true };
    }
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
function classifyBinary(base, delivery, path, cwd, gitExec) {
  const res = gitReadBounded(
    ["--literal-pathspecs", "diff", "--numstat", "--no-renames", base, delivery, "--", path],
    cwd,
    gitExec,
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
function readCompleteDiff(base, delivery, path, cwd, gitExec) {
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
    gitExec,
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
 * Compute a 128-bit irreversible ARTIFACT fingerprint binding runId +
 * deliveryCommit + fileIndex, base64url-encoded (22 chars). The cursor carries
 * ONLY this fingerprint (never the full 40/64-hex commit literal), so the token
 * stays <=192 chars for both sha1 and sha256 commits. Domain separation
 * (`runId|deliveryCommit|fileIndex`) prevents substring collisions, and the
 * fingerprint still fails cross-run / cross-commit / cross-file replay because
 * any of the three changing changes the fingerprint.
 * @private
 */
function artifactFingerprint(runId, deliveryCommit, fileIndex) {
  const material = `${runId}|${deliveryCommit}|${fileIndex}`;
  return createHash("sha256").update(material, "utf8").digest().subarray(0, 16).toString("base64url");
}

/**
 * Encode an opaque cursor. base64url(canonical JSON) v3, binding the 128-bit
 * artifact fingerprint (runId+commit+fileIndex) + offset + 128-bit content
 * digest. Max 192 chars for BOTH 40- and 64-hex commits (the full commit is
 * never placed in the token). Canonical re-encode must equal the input token.
 * @private
 */
function encodeCursor({ artifactFp, fileIndex, nextOffset, digest }) {
  const payload = {
    v: CURSOR_VERSION,
    a: artifactFp,
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
 * Failures (malformed/wrong-version/unknown-keys/wrong-types/cross-artifact/
 * offset-out-of-range/mid-codepoint/stale-digest/noncanonical-encoding) throw
 * the typed CursorRejectedError (F5) carrying a fixed "invalid cursor" message.
 * Omitted cursor → offset 0. `artifactAvailable` must be true: a cursor
 * supplied for a binary/too-large/unavailable artifact is rejected.
 * @private
 */
function decodeCursor(token, {
  artifactFp, fileIndex, totalSafeBytes, safeTextBuf, digest, artifactAvailable,
}) {
  // F5: every rejection on the DECODE path is the typed CursorRejectedError so
  // the MCP/CLI adapters fold it into the dedicated recovery copy (subtypes are
  // never surfaced — the run_activity discipline).
  if (token === undefined || token === null) {
    return { offset: 0 };
  }
  // A cursor is only valid for a reviewable text artifact. Binary/too-large
  // never produce a cursor, so a supplied cursor here is a replay/mismatch.
  if (!artifactAvailable) {
    throw new CursorRejectedError("invalid cursor: artifact not paginated");
  }
  if (typeof token !== "string" || token.length === 0 || token.length > CURSOR_MAX_CHARS) {
    throw new CursorRejectedError("invalid cursor: length");
  }
  // base64url charset only.
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new CursorRejectedError("invalid cursor: encoding");
  }
  let payload;
  let rawDecoded;
  try {
    rawDecoded = Buffer.from(token, "base64url").toString("utf8");
    payload = JSON.parse(rawDecoded);
  } catch {
    throw new CursorRejectedError("invalid cursor: decode");
  }
  if (!payload || payload.v !== CURSOR_VERSION) {
    throw new CursorRejectedError("invalid cursor: version");
  }
  // Strict key set (canonical order: a,d,i,o,v).
  const keys = Object.keys(payload).sort().join(",");
  if (keys !== "a,d,i,o,v") {
    throw new CursorRejectedError("invalid cursor: keys");
  }
  // Canonical re-encode must equal the input token (rejects noncanonical JSON
  // like reordered/extra-whitespace/repeated-key encodings).
  const canonical = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  if (canonical !== token) {
    throw new CursorRejectedError("invalid cursor: noncanonical encoding");
  }
  // Artifact fingerprint binds runId + deliveryCommit + fileIndex as one. Any
  // cross-run / cross-commit / cross-file replay changes the fingerprint.
  if (typeof payload.a !== "string" || payload.a !== artifactFp) {
    throw new CursorRejectedError("invalid cursor: artifact mismatch");
  }
  if (!Number.isInteger(payload.i) || payload.i !== fileIndex) {
    throw new CursorRejectedError("invalid cursor: file mismatch");
  }
  if (typeof payload.d !== "string" || payload.d !== digest) {
    throw new CursorRejectedError("invalid cursor: stale digest");
  }
  // offset: integer, 0 <= offset < totalSafeBytes (strict less-than; an offset
  // equal to total is the empty terminal page and is never encoded — nextCursor
  // is null there).
  if (!Number.isInteger(payload.o) || payload.o < 0 || payload.o >= totalSafeBytes) {
    throw new CursorRejectedError("invalid cursor: offset out of range");
  }
  // Must not land on a UTF-8 continuation byte (would split a code point).
  if (payload.o > 0 && (safeTextBuf[payload.o] & 0xc0) === 0x80) {
    throw new CursorRejectedError("invalid cursor: offset splits a code point");
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
 * @param {boolean} [input.sinceParent] — decision 0116 internal base override;
 *   literal `true` only (no commit value can enter). The diff base becomes the
 *   PROVEN parent delivery commit and the changed list the parent→delivery
 *   delta. The pending gate is unchanged: a pending run gets the same advisory
 *   with ZERO diff regardless of this flag.
 * @param {object} [hostDependencies] — test-only injection
 * @param {object} [hostDependencies.env] — env for the secret redactor
 * @param {Function} [hostDependencies.readTranscriptFn]
 * @param {Function} [hostDependencies.gitExecFileSyncFn] — inject the projection
 *   Git executor (classifyBinary + readCompleteDiff) for deterministic failure
 *   tests. M11-3A eligibility still uses the real Git. Injected output still
 *   passes through the 256 KiB raw cap, redaction, and sanitization — it is NOT
 *   a raw-output bypass.
 * @returns {Promise<object>} safe structured review result
 */
export async function getRunDeliveryReview(
  { runId, runDir, authorizedWorkspaceRoot, fileIndex, cursor, sinceParent },
  hostDependencies = {},
) {
  // M11-12A: not-yet-reviewable truth. If exact delivery verification has not
  // been recorded yet, surface a TRUTHFUL structured not-yet-reviewable result
  // instead of the generic review error, so a Lead can wait (run_delivery
  // waitMs) or retry review later. Pending is the ONLY readiness state handled
  // here; it is valid for the EXACT `waiting_for_verification` state only —
  // PLUS the TD-179 settled pending rejection: a run whose readiness projects
  // `reviewable` ONLY because a validated pending-verification REJECTION
  // decision exists while exact verification is still pending. That settled
  // shape gets the SAME verification_pending advisory (never Git diff
  // permission — there is still no verified artifact to review). Both gates run
  // AFTER workspace ownership but BEFORE resolveRunDeliveryReviewTarget (which
  // reads the Git commit proof) and before any diff/numstat read — so the
  // pending path performs ZERO Git proof / numstat / diff reader calls. Every
  // other readiness state (ordinary reviewable, ambiguous, packaging_failed,
  // waiting_for_packaging, not_requested) falls through to the existing
  // fail-closed resolver path below, unchanged. No duplicate readiness logic:
  // projectDeliveryReadiness + validateDeliveryFacts are the SAME SSOTs
  // run_delivery and the decision writer use.
  if (!isValidRunId(runId)) {
    throw new Error("invalid runId");
  }
  if (typeof runDir !== "string" || runDir.length === 0) {
    throw new Error("runDir must be a non-empty string");
  }
  if (typeof authorizedWorkspaceRoot !== "string" || authorizedWorkspaceRoot.length === 0) {
    throw new Error("authorizedWorkspaceRoot must be a non-empty string");
  }
  // Same boolean gate as the resolver: the base override accepts no value —
  // a commit-shaped input can never become the diff base.
  if (sinceParent !== undefined && sinceParent !== true) {
    throw new Error("sinceParent must be the literal true");
  }
  const _readTranscriptForGate = hostDependencies.readTranscriptFn ?? readTranscript;
  const _gateFilePath = resolveTranscriptPath(runDir, runId);
  let _gateEvents;
  try {
    _gateEvents = await _readTranscriptForGate(_gateFilePath);
  } catch {
    throw new Error("transcript not readable");
  }
  if (!Array.isArray(_gateEvents)) {
    throw new Error("transcript malformed");
  }
  // Duplicated continuation facts are classified as the closed-set --since-
  // parent ambiguity rejection BEFORE the workspace-ownership verifier (which
  // would reject the same transcript for "more than one background_submitted"
  // — true, but the specific reason matters to the Lead). 0/1 candidates
  // proceed; the full fact validation lives in resolveContinuationParent.
  if (sinceParent && continuationFactCandidates(_gateEvents, runId).length > 1) {
    throw sinceParentRejection(SINCE_PARENT_AMBIGUOUS_TEXT);
  }
  // Workspace ownership FIRST — a cross-workspace request must never reach
  // the readiness probe, the Git proof, or any content read.
  verifyRunWorkspaceOwnership(_gateEvents, authorizedWorkspaceRoot, runId);

  const _readiness = projectDeliveryReadiness(_gateEvents, runId);
  // TD-179: is this reviewable ONLY because of a settled pending rejection?
  // The shared facts authority (pending-aware, runId-bound — the SAME
  // validator the decision writer uses) decides; there is no second policy
  // here. A valid pending verification PLUS a validated decision event is
  // exactly the settled pending-rejection shape (an ordinary reviewable
  // delivery always carries a final outcome, so it never enters this branch).
  const _settledPendingRejection = _readiness === "reviewable" && (() => {
    const facts = validateDeliveryFacts(_gateEvents, {
      expectedRunId: runId,
      allowVerificationPending: true,
    });
    return facts.valid === true
      && facts.verificationStatus === "pending"
      && facts.decisionEvent !== null;
  })();
  if (_readiness === "waiting_for_verification" || _settledPendingRejection) {
    // fileIndex must be a non-negative integer (it is echoed back so the Lead
    // can correlate the advisory with its request). A supplied cursor is
    // rejected: a not-yet-reviewable artifact is never paginated.
    if (!Number.isInteger(fileIndex) || fileIndex < 0) {
      throw new Error("fileIndex must be a non-negative integer");
    }
    if (cursor !== undefined && cursor !== null) {
      // F5: cursor-validation path — typed rejection (same remedy as every
      // other bad cursor: re-fetch from page 1).
      throw new CursorRejectedError("invalid cursor: artifact not paginated");
    }
    return {
      runId,
      deliveryCommit: null,
      fileIndex,
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

  // 1. Eligibility + exact target (M11-3A). All runId/ownership/proof/fileIndex
  //    gates run here, before any diff content is read. sinceParent only swaps
  //    the diff base to the PROVEN parent delivery commit — every later stage
  //    (binary detect, diff read, redaction, sanitization, caps, pagination)
  //    is the SAME pipeline on that base.
  const target = await resolveRunDeliveryReviewTarget({
    runId,
    runDir,
    authorizedWorkspaceRoot,
    fileIndex,
    ...(sinceParent ? { sinceParent } : {}),
    ...(hostDependencies.readTranscriptFn ? { readTranscriptFn: hostDependencies.readTranscriptFn } : {}),
  });
  const gitExec = hostDependencies.gitExecFileSyncFn;

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
  const artifactFp = artifactFingerprint(runId, delivery, fileIndex);

  // Helper: a binary/too-large/unavailable artifact result. A supplied cursor
  // for such an artifact is rejected (decodeCursor checks artifactAvailable).
  const unavailableResult = (reason) => {
    // Validate/reject cursor even on unavailable artifacts — a cursor supplied
    // here is a replay against a non-paginated artifact. F5: typed rejection.
    if (cursor !== undefined && cursor !== null) {
      throw new CursorRejectedError("invalid cursor: artifact not paginated");
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
  const binaryClass = classifyBinary(base, delivery, path, cwd, gitExec);
  if (binaryClass === "failed") {
    throw new Error("run_delivery_review failed");
  }
  if (binaryClass === "binary") {
    return unavailableResult("binary");
  }

  // 3. Read the complete single-file diff (bounded to EXACTLY 256 KiB).
  //    overflow (raw > 256 KiB) → diff_too_large (no partial output).
  //    ordinary Git failure → application error (NOT diff_too_large).
  const diffRes = readCompleteDiff(base, delivery, path, cwd, gitExec);
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

  // 7. Decode/validate cursor (binding artifact fingerprint + fileIndex + digest
  //    + offset). artifactAvailable=true here.
  const { offset: startOffset } = decodeCursor(cursor, {
    artifactFp,
    fileIndex,
    totalSafeBytes: safeBuf.length,
    safeTextBuf: safeBuf,
    digest,
    artifactAvailable: true,
  });

  const { fragment, nextOffset } = paginateSafe(safeBuf, startOffset);
  const nextCursor = nextOffset !== null
    ? encodeCursor({ artifactFp, fileIndex, nextOffset, digest })
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
