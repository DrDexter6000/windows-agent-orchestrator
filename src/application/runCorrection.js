// src/application/runCorrection.js
//
// M12-16: Lead-authorized IN-FLIGHT correction queue application service.
//
// A Lead supervising a RUNNING correctable run may queue a bounded follow-up
// user turn (a correction) against it WITHOUT waiting for terminal state. This
// service appends exactly one run.correction_requested to the run transcript —
// the durable cross-process queue the detached runner reads + claims + delivers
// over the live provider stdin.
//
// WAO is a deterministic transport only:
//   - "queued" proves only that the request was durably appended; "delivered"
//     proves only that the runner wrote the bytes to provider stdin. NEITHER
//     proves the model executed the turn (queued ≠ delivered ≠ executed).
//   - This service NEVER stops/retries/re-scopes/accepts/rejects the run, NEVER
//     infers a correction, and NEVER decides semantics. It appends a request or
//     refuses with a closed-set reason.
//   - It NEVER echoes the prompt/session/path/PID/provider in its result.
//
// Eligibility is decided READ-ONLY with closed-set refusals BEFORE any append:
//   malformed_input, unknown_run, workspace_mismatch, not_correctable,
//   not_ready, terminal_run, duplicate, already_delivered.
// The atomic no-duplicate / non-terminal append is delegated to the transcript
// CAS primitive (tryAppendCorrectionRequested), which re-checks both IN LOCK to
// close the terminal TOCTOU window between this service's read and the append.
//
// Architectural contract (mirrors runContinue.js / runDispatch.js):
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Depends on transcript.js (CAS primitives + projection), delivery.js
//     (isValidRunId), and runWorkspaceOwnership.js (ownership proof).

import { join, resolve } from "node:path";

import {
  JsonlTranscript,
  readTranscript,
  findState,
  findLatest,
  extractCanonicalAgentId,
  TERMINAL_STATES,
  projectCorrections,
  CORRECTION_OUTCOMES,
  CORRECTION_REJECTION_REASONS,
} from "../transcript.js";
import { isValidRunId } from "../delivery.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";

// Re-exported so the MCP schema enum derives from the ONE transcript SSOT (no
// second hand-maintained list at the boundary).
export { CORRECTION_OUTCOMES, CORRECTION_REJECTION_REASONS };

// correctionId shape (mirror of the transcript CAS bound, surfaced here so the
// MCP schema can declare the exact same alphabet + length).
export const CORRECTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const CORRECTION_ID_MAX_LEN = 64;
export const CORRECTION_PROMPT_MAX_LEN = 15000;

// Map an existing correction record (from projectCorrections on the read path,
// or from the CAS primitive's in-lock duplicate return) to a Lead-facing outcome
// for an incoming request carrying `prompt`. Returns null when there is no
// existing record.
//
// A DIFFERENT non-empty prompt body for the same correctionId is ALWAYS a
// duplicate refusal (the original request stands) — whether observed on the read
// path or after losing the in-lock CAS race. It NEVER surfaces pending/delivered
// for a differing prompt body (the duplicate conflict is closed-set and
// truthful). Same prompt (idempotent retry) or a status-only record maps to the
// stored status. The comparison is over the raw strings; redaction is a no-op
// for ordinary prose (a secret in a prompt violates the worker contract), so it
// is exact for legitimate use.
function mapExistingCorrection(info, prompt) {
  if (!info) return null;
  if (typeof info.prompt === "string" && info.prompt.length > 0 && info.prompt !== prompt) {
    return { outcome: "rejected", reason: "duplicate" };
  }
  if (info.status === "delivered") return { outcome: "delivered", reason: null };
  if (info.status === "rejected" || info.status === "delivery_failed") {
    return { outcome: "rejected", reason: info.reason };
  }
  return { outcome: "pending", reason: null }; // pending | claimed
}

/**
 * Queue one Lead-authorized in-flight correction against a RUNNING correctable
 * run, or return the closed-set outcome for the request.
 *
 * @param {object} input
 * @param {string} input.runId — the running correctable run to correct
 * @param {string} input.correctionId — Lead-supplied stable id (exactly-once key)
 * @param {string} input.prompt — Lead-authored correction prompt (bounded)
 * @param {string} input.runDir — runs/ directory (host-owned)
 * @param {string} input.authorizedWorkspaceRoot — MCP workspace binding (canonical git root)
 * @param {Function} [input.readTranscriptFn] — injectable reader (tests)
 * @returns {Promise<{runId:string, correctionId:string, outcome:string, reason:string|null}>}
 *   outcome ∈ CORRECTION_OUTCOMES; reason ∈ CORRECTION_REJECTION_REASONS when
 *   outcome === "rejected", else null. NEVER carries prompt/session/path/PID.
 */
export async function correctRun({
  runId,
  correctionId,
  prompt,
  runDir,
  authorizedWorkspaceRoot,
  readTranscriptFn,
} = {}) {
  const base = { runId: typeof runId === "string" ? runId : "", correctionId: typeof correctionId === "string" ? correctionId : "" };
  const reject = (reason) => ({ ...base, outcome: "rejected", reason });

  // 1. Input shape.
  if (!isValidRunId(runId)) return reject("malformed_input");
  if (typeof correctionId !== "string" || correctionId.length === 0
    || correctionId.length > CORRECTION_ID_MAX_LEN || !CORRECTION_ID_PATTERN.test(correctionId)) {
    return reject("malformed_input");
  }
  if (typeof prompt !== "string" || prompt.length === 0
    || prompt.length > CORRECTION_PROMPT_MAX_LEN) {
    return reject("malformed_input");
  }
  if (typeof runDir !== "string" || runDir.length === 0) return reject("malformed_input");
  if (typeof authorizedWorkspaceRoot !== "string" || authorizedWorkspaceRoot.length === 0) {
    return reject("malformed_input");
  }

  const reader = readTranscriptFn ?? readTranscript;
  const transcriptPath = join(resolve(runDir), `${runId}.jsonl`);

  // 2. Transcript must exist and carry one canonical agentId envelope.
  let events;
  try {
    events = await reader(transcriptPath);
  } catch {
    return reject("unknown_run");
  }
  if (!Array.isArray(events) || events.length === 0) return reject("unknown_run");
  const agentId = extractCanonicalAgentId(events, runId);
  if (agentId === "unknown") return reject("unknown_run");

  // 3. Workspace ownership (the run must belong to the bound workspace).
  try {
    verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot, runId);
  } catch {
    return reject("workspace_mismatch");
  }

  // 4. The run must have been dispatched correctable (run.background_submitted.
  //    correctable === true). This is a STABLE fact (set at dispatch, before the
  //    runner forks) so reading it outside the append lock is TOCTOU-safe.
  const submitted = findLatest(events, "run.background_submitted");
  if (!submitted || submitted.correctable !== true) return reject("not_correctable");

  // 5. Existing correctionId → return its durable status (no re-append). This is
  //    a pure read of prior durable facts, evaluated BEFORE the ready gate so a
  //    Lead can always read a prior outcome (a delivered/rejected correction is
  //    reported even after the run later goes terminal). mapExistingCorrection
  //    refuses a DIFFERENT prompt body as "duplicate" (the original stands) and
  //    never surfaces pending/delivered for a differing prompt body.
  const existingOutcome = mapExistingCorrection(projectCorrections(events, runId).get(correctionId), prompt);
  if (existingOutcome) return { ...base, ...existingOutcome };

  // 6. State-based ready gate (durable findState). Only a run in the LIVE-
  //    PROVIDER phase (submitted | running) may receive a NEW correction.
  //    pending (pre-spawn / during-spawn) and unknown → not_ready; any terminal
  //    → terminal_run. This closes the spawn_error / first-terminal-in-spawn
  //    window: a correction can never be queued — and so can never be stranded
  //    pending — against a run that has not reached (or has already left) the
  //    live-provider state. (spawn_error is pending→failed; first-terminal-wins
  //    rejects the pending→submitted transition, so the state is never
  //    "submitted" on those branches.) The CAS primitive re-checks terminal IN
  //    LOCK below. A run reaches "submitted" only AFTER backend.spawn succeeds,
  //    so this is a strictly stronger readiness signal than the legacy run.started
  //    event (which was appended before the spawn result was known).
  const state = findState(events);
  if (state !== "submitted" && state !== "running") {
    if (TERMINAL_STATES.includes(state)) return reject("terminal_run");
    return reject("not_ready");
  }

  // 7. Atomic append — re-validates no-duplicate + non-terminal under the
  //    cross-process lock and appends exactly one run.correction_requested.
  const transcript = new JsonlTranscript(transcriptPath, { runId, agentId });
  let res;
  try {
    res = await transcript.tryAppendCorrectionRequested({ correctionId, prompt });
  } catch {
    // Defense-in-depth at the CAS boundary (invalid shape the service missed).
    return reject("malformed_input");
  }
  if (res.queued) return { ...base, outcome: "queued", reason: null };
  // Lost the terminal race inside the lock (the run terminated between this
  // service's read and the append).
  if (res.reason === "terminal_run") return reject("terminal_run");
  // A concurrent appender won the correctionId between reads → re-compare its
  // prompt the SAME way as the read path (mapExistingCorrection): a different
  // prompt body is a duplicate conflict, never pending/delivered for THIS
  // differing prompt.
  if (res.reason === "duplicate") {
    const raceOutcome = mapExistingCorrection(res.existing, prompt);
    if (raceOutcome) return { ...base, ...raceOutcome };
  }
  return reject("malformed_input");
}
