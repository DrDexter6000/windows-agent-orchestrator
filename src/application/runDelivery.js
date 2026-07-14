// src/application/runDelivery.js
//
// M9-6A: Shared application services for delivery query and Lead decision.
//
// getRunDelivery: read-only reconstruction of the current delivery state.
// decideRunDelivery: durable Lead decision via tryAppendDecision (first-decision-wins).
//
// Architectural contract:
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Depends on transcript.js (readTranscript/findState/JsonlTranscript/findLastEventSeq)
//     and delivery.js (isValidRunId).
//   - The _reconstructDelivery algorithm is migrated here from src/commands/runs.js
//     so CLI and MCP share one reconstruction path.

import { join } from "node:path";

import { readTranscript, findState, findLastEventSeq, JsonlTranscript } from "../transcript.js";
import { isValidRunId } from "../delivery.js";

// ===== Private: delivery reconstruction (migrated from runs.js) =====

/**
 * Reconstruct the latest delivery ref, decision event, and delivery commit
 * from transcript events. This is the single algorithm — CLI and MCP both
 * use it via getRunDelivery.
 * @param {Array} events
 * @returns {{latestRef: object|null, decisionEvent: object|null, deliveryCommit: string|null}}
 */
function _reconstructDelivery(events) {
  let latestRef = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === "run.delivery_created" && events[i].delivery) {
      latestRef = events[i].delivery;
      break;
    }
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if ((e.type === "run.delivery_verification_passed"
      || e.type === "run.delivery_verification_failed"
      || e.type === "run.delivery_verification_unavailable")
      && e.delivery) {
      latestRef = e.delivery;
      break;
    }
  }
  let decisionEvent = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected") {
      decisionEvent = e;
      break;
    }
  }
  if (decisionEvent?.delivery) {
    latestRef = decisionEvent.delivery;
  }
  const deliveryCommit = latestRef?.deliveryCommit ?? null;
  return { latestRef, decisionEvent, deliveryCommit };
}

// ===== Service: getRunDelivery (read-only query) =====

/**
 * Get the read-only delivery status for a run.
 *
 * @param {object} input
 * @param {string} input.runId — must pass isValidRunId
 * @param {string} input.runDir — runs/ directory (host-owned)
 * @param {Function} [input.readTranscriptFn] — injectable for testing
 * @returns {Promise<object>} delivery view: {runId, terminalState, deliveryRef, verification, acceptance}
 */
export async function getRunDelivery({ runId, runDir, readTranscriptFn }) {
  if (!runId || typeof runId !== "string") throw new Error("getRunDelivery: runId is required");
  if (!runDir || typeof runDir !== "string") throw new Error("getRunDelivery: runDir is required");
  if (!isValidRunId(runId)) throw new Error(`Invalid runId: ${JSON.stringify(runId)}`);

  const _readTranscript = readTranscriptFn ?? readTranscript;
  const filePath = join(runDir, `${runId}.jsonl`);
  const events = await _readTranscript(filePath);

  const terminalState = findState(events);
  const { latestRef, decisionEvent, deliveryCommit } = _reconstructDelivery(events);

  if (!latestRef || !deliveryCommit) {
    throw new Error(`No committed delivery found for run ${runId}`);
  }

  const verificationStatus = latestRef.verification?.status ?? "pending";
  const acceptanceStatus = decisionEvent
    ? (decisionEvent.type === "run.delivery_accepted" ? "accepted" : "rejected")
    : (latestRef.acceptance?.status ?? "pending");

  return {
    runId,
    terminalState,
    deliveryRef: latestRef,
    verification: {
      status: verificationStatus,
      ...(latestRef.verification?.failureCode ? { failureCode: latestRef.verification.failureCode } : {}),
    },
    acceptance: {
      status: acceptanceStatus,
      ...(decisionEvent ? { decisionEvent: { type: decisionEvent.type, reason: decisionEvent.reason } } : {}),
    },
  };
}

// ===== Service: decideRunDelivery (durable decision) =====

/**
 * Record a Lead decision via the transcript primitive's atomic first-decision-wins.
 *
 * Does NOT reimplement terminal/verification/duplicate/commit-match rules —
 * those live inside tryAppendDecision's lock-scoped validation.
 *
 * @param {object} input
 * @param {string} input.runId
 * @param {string} input.runDir
 * @param {string} input.decision — "accepted" | "rejected"
 * @param {string} input.reason — trimmed non-empty
 * @param {Function} [input.readTranscriptFn] — for lock-external context init only
 * @param {Function} [input.transcriptFactory] — injectable for testing (async (filePath, context) => transcript)
 * @returns {Promise<{accepted:true, event} | {accepted:false, existing}>}
 */
export async function decideRunDelivery({ runId, runDir, decision, reason, readTranscriptFn, transcriptFactory }) {
  if (!runId || typeof runId !== "string") throw new Error("decideRunDelivery: runId is required");
  if (!runDir || typeof runDir !== "string") throw new Error("decideRunDelivery: runDir is required");
  if (!isValidRunId(runId)) throw new Error(`Invalid runId: ${JSON.stringify(runId)}`);
  if (decision !== "accepted" && decision !== "rejected") {
    throw new Error(`decision must be "accepted" or "rejected", got: ${JSON.stringify(decision)}`);
  }
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  if (trimmedReason.length === 0) throw new Error("reason must be non-empty after trimming");

  const filePath = join(runDir, `${runId}.jsonl`);
  const _readTranscript = readTranscriptFn ?? readTranscript;

  // Lock-external read: initialize transcript context/seq only.
  // Authorization happens IN-LOCK inside tryAppendDecision.
  const events = await _readTranscript(filePath);
  const context = {
    runId,
    agentId: events[0]?.agentId ?? "unknown",
    initialSeq: findLastEventSeq(events),
  };

  let transcript;
  if (transcriptFactory) {
    transcript = await transcriptFactory(filePath, context);
  } else {
    transcript = new JsonlTranscript(filePath, context);
  }

  return transcript.tryAppendDecision({ decision, reason: trimmedReason });
}
