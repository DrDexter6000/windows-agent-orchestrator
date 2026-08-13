// src/application/runDiagnosis.js
//
// M9-5A: Shared application service for read-only run diagnosis.
//
// This module orchestrates: validate runId → read transcript → call
// diagnoseFailure(events) → return structured result. CLI `runs diagnose` and
// MCP `run_diagnose` both call it. The classification logic itself stays in
// diagnosis.js (the SSOT kernel); this service only adds runId validation,
// transcript reading, and state/terminal enrichment.
//
// Architectural contract:
//   - Read-only: never writes transcript or any persistent state.
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Depends on transcript.js (readTranscript/findState/TERMINAL_STATES),
//     delivery.js (isValidRunId), and diagnosis.js (diagnoseFailure).

import { join } from "node:path";

import { readTranscript, findState, TERMINAL_STATES } from "../transcript.js";
import { isValidRunId } from "../delivery.js";
import { diagnoseFailure } from "../diagnosis.js";

/**
 * Get the read-only diagnosis of a run.
 *
 * @param {object} input
 * @param {string} input.runId — must pass isValidRunId
 * @param {string} input.runDir — runs/ directory (host-owned)
 * @param {Function} [input.readTranscriptFn] — injectable for testing
 * @returns {Promise<{runId, state, terminal, category, code, evidence}>}
 *   code — nullable closed-set diagnosis code, a member of the single general
 *   DIAGNOSIS_CODES SSOT (PROVIDER_DIAGNOSIS_CODES ∪ NO_EFFECT_DIAGNOSIS_CODES).
 *   provider_auth carries a PROVIDER_DIAGNOSIS_CODES member; no_effect carries
 *   completed_empty (M12-21) — the durable completionMarker=completed_empty on
 *   the accepted run.completed fact, or the evidence retrofit for a historical
 *   transcript without the marker, for a completion with no usable effect;
 *   every other category is null. The MCP run_diagnose AND run_await_result
 *   wires expose this pair directly: code is `z.enum(DIAGNOSIS_CODES).nullable()`
 *   and the handler validates the (category, code) pair via isValidDiagnosisCode,
 *   so completed_empty reaches a Lead on the wire as category=no_effect,
 *   code=completed_empty. No provider text/argv/path/prompt/secret is exposed.
 */
export async function getRunDiagnosis({
  runId,
  runDir,
  readTranscriptFn,
}) {
  if (!runId || typeof runId !== "string") {
    throw new Error("getRunDiagnosis: runId is required");
  }
  if (!runDir || typeof runDir !== "string") {
    throw new Error("getRunDiagnosis: runDir is required");
  }
  if (!isValidRunId(runId)) {
    throw new Error(`Invalid runId: ${JSON.stringify(runId)}`);
  }

  const _readTranscript = readTranscriptFn ?? readTranscript;
  const filePath = join(runDir, `${runId}.jsonl`);
  const events = await _readTranscript(filePath);

  const state = findState(events);
  const terminal = TERMINAL_STATES.includes(state);
  // M11-8C closeout (Gap B): pass the requested runId so diagnoseFailure can
  // bind the delivery_packaging_failed classification — a cross-run
  // run.delivery_failed event must NOT pollute this run's diagnosis.
  const { category, code, evidence } = diagnoseFailure(events, runId);

  return { runId, state, terminal, category, code, evidence };
}
