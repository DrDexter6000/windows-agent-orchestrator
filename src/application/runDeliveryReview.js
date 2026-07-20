// src/application/runDeliveryReview.js
//
// M11-3A: read-only delivery review eligibility + target resolver.
//
// This service resolves the review target for one verified delivery file WITHOUT
// reading any diff content. It is the trust boundary that runs BEFORE any Git
// content read in M11-3B. It proves, in strict order:
//
//   1. runId is well-formed (before any transcript path join);
//   2. the host-owned transcript is readable;
//   3. durable delivery facts are unambiguous (exactly one delivery_created and
//      one matching final verification outcome), via the SAME validateDeliveryFacts
//      SSOT that tryAppendDecision uses;
//   4. the run belongs to the authorized workspace (verifyRunWorkspaceOwnership);
//   5. the exact delivery commit exists in the authorized source repo and matches
//      base/parent/count/files/message/identity (assertDeliveryCommitInRepository);
//   6. fileIndex addresses a verified changed file.
//
// Architectural contract:
//   - Imports NO command module, MCP SDK, or zod.
//   - Delegates to delivery.js (proof kernel), transcript.js (facts SSOT),
//     runWorkspaceOwnership.js (ownership SSOT), and readTranscript (host-owned).
//   - Returns only the resolved target metadata (commits, file index, path). It
//     NEVER returns raw diff content, fragment, worktree path, branch, or any
//     intermediate raw artifact. Diff projection + redaction belong to M11-3B.
//   - Final `passed`, `failed`, and `unavailable` deliveries are reviewable;
//     `pending` or ambiguous facts are not. Acceptance status does not affect
//     read-only availability.
//
// All Git work happens inside assertDeliveryCommitInRepository, which uses
// structured argv only (no shell interpolation, ext-diff, textconv, pager, or
// model-controlled cwd/ref/path).

import { readTranscript } from "../transcript.js";
import { validateDeliveryFacts } from "../transcript.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";
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
