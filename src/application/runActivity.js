// src/application/runActivity.js
//
// M12-8 Package A: readRunActivity — the SINGLE shared read-only entry over
// runs/<runId>.jsonl for the activity timeline.
//
// Hard read-only contract — it MUST:
//   - read the transcript EXACTLY ONCE per call (single snapshot),
//   - verify workspace ownership when an authorized root is supplied (fail-closed
//     BEFORE the snapshot is projected/published),
//   - derive agentId / backend / state / terminal from that one snapshot,
//   - fail closed (BEFORE any fact derivation or projection) when any event's
//     envelope carries a missing/mismatched/conflicting runId — never degrade
//     to a partial result while still projecting content,
//   - NEVER append (no messages.collected, no audit event, no commitAppend),
//   - perform NO serve HTTP fetch (snapshot-only local read).
//
// The returned snapshot is UNTRUSTED and is handed to projectRunActivity, which
// performs all classification / redaction / cursor / pagination. This module
// performs no semantic judgment and emits no safe-output shaping of its own.
//
// Architectural contract:
//   - Does NOT import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Reuses readTranscript, findState, findLatest, TERMINAL_STATES,
//     extractCanonicalAgentId, assertEventsBoundToRunId SSOTs from transcript.js;
//     isValidRunId SSOT from delivery.js; verifyRunWorkspaceOwnership SSOT from
//     runWorkspaceOwnership.js.

import { join } from "node:path";

import {
  readTranscript,
  findState,
  findLatest,
  TERMINAL_STATES,
  extractCanonicalAgentId,
  assertEventsBoundToRunId,
} from "../transcript.js";
import { isValidRunId } from "../delivery.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";

/**
 * Read ONE transcript snapshot and derive the shared read-only activity facts.
 *
 * @param {object} opts
 * @param {string} opts.runId — the caller-requested runId
 * @param {string} opts.runDir — directory holding <runId>.jsonl
 * @param {string} [opts.authorizedWorkspaceRoot] — canonical Git root; when
 *        supplied, ownership is verified fail-closed before the snapshot is used
 * @param {Function} [opts.readTranscriptFn] — injectable reader (tests)
 * @returns {Promise<{events: object[], agentId: string, backend: string, state: string, terminal: boolean}>}
 */
export async function readRunActivity({ runId, runDir, authorizedWorkspaceRoot, readTranscriptFn } = {}) {
  if (!isValidRunId(runId)) throw new Error("invalid runId");
  if (!runDir || typeof runDir !== "string") throw new Error("invalid runDir");

  const reader = readTranscriptFn ?? readTranscript;
  const filePath = join(runDir, `${runId}.jsonl`);

  // Single read. No wait loop, no re-read, no append.
  const events = await reader(filePath);

  // Exact run binding: every object event must carry runId === the requested
  // runId. Missing/mismatched/conflicting envelope facts fail closed BEFORE
  // any fact derivation or projection — never degrade-and-project.
  assertEventsBoundToRunId(events, runId);

  // Trust-boundary workspace ownership (fail-closed before projection).
  if (authorizedWorkspaceRoot !== undefined && authorizedWorkspaceRoot !== null) {
    verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot);
  }

  const agentId = extractCanonicalAgentId(events, runId);
  const backend = findLatest(events, "session.created")?.backend ?? "unknown";
  const state = findState(events);
  const terminal = TERMINAL_STATES.includes(state);

  return { events, agentId, backend, state, terminal };
}
