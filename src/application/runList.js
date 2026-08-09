// src/application/runList.js
//
// M10 P0-3: Workspace-bound run inventory service.
//
// Scans run_*.jsonl files in runDir, parses state/agentId/updatedAt,
// filters by workspace ownership (MCP path), and returns a safe list.
//
// CLI `runs list` delegates to this service for shared logic.
// MCP `runs_list` calls this service with authorizedWorkspaceRoot to
// enforce project isolation.
//
// Architectural contract:
//   - Does NOT import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Does NOT import daemon (no reverse dependency).
//   - Reuses transcript readTranscript/findState, isValidRunId, and the
//     query-scoped workspace verifier SSOT.

import { join, resolve } from "node:path";
import { readdirSync, existsSync } from "node:fs";

import { readTranscript, findState, RUN_STATES, TERMINAL_STATES } from "../transcript.js";
import { isValidRunId } from "../delivery.js";
import { createRunWorkspaceVerifier } from "./runWorkspaceOwnership.js";
import { checkOwnerLiveness, DEFAULT_OWNER_LIVENESS_THRESHOLD_MS } from "./ownerLiveness.js";

// M12-15: closed-set activity projection. A run is reported activityStatus=active
// ONLY when a known non-terminal transcript has a FRESH owner heartbeat. A
// non-terminal run without a fresh heartbeat is unresolved — NEVER inferred
// failed/dead/stopped, and still discoverable in the ordinary list. These
// enums are the single SSOT for the MCP output schemas (server.js imports them).
export const ACTIVITY_STATUSES = ["terminal", "active", "unresolved", "unknown"];
export const ACTIVITY_BASES = [
  "terminal_state",
  "fresh_owner_heartbeat",
  "no_fresh_owner_heartbeat",
  "unknown_state",
];

/**
 * Scan runDir for run_*.jsonl files (excludes wf_* workflow transcripts).
 * @param {string} runDir
 * @returns {string[]} sorted array of filenames (e.g. ["run_abc.jsonl", ...])
 */
function scanRunFiles(runDir) {
  if (!existsSync(runDir)) return [];
  const files = readdirSync(runDir);
  return files
    .filter((f) => f.startsWith("run_") && f.endsWith(".jsonl"))
    .sort();
}

/**
 * Extract a run summary from events.
 * Returns null if the run is malformed or unreadable.
 *
 * @param {string} runId — from filename (already isValidRunId-checked)
 * @param {object[]} events
 * @param {string[]} knownAgentIds — for agentId validation
 * @returns {{runId, agentId, state, terminal, updatedAt}|null}
 */
function summarizeRun(runId, events, knownAgentIds, input) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const state = findState(events);
  // Map unknown states to "unknown" (don't leak arbitrary strings)
  const safeState = RUN_STATES.includes(state) ? state : "unknown";
  const terminal = TERMINAL_STATES.includes(safeState);
  // agentId from first event; validate against known registry.
  // MCP path: always validate (even if registry unavailable → all "unknown").
  // CLI path (validateAgentIds=false): preserve raw agentId.
  const rawAgentId = events[0]?.agentId;
  const agentId = input.validateAgentIds === false
    ? (typeof rawAgentId === "string" ? rawAgentId : "unknown")
    : (typeof rawAgentId === "string" && knownAgentIds.includes(rawAgentId) ? rawAgentId : "unknown");
  // updatedAt: last event's ts, validated as ISO timestamp
  const lastTs = events[events.length - 1]?.ts ?? null;
  let updatedAt = null;
  if (lastTs && typeof lastTs === "string") {
    const parsed = new Date(lastTs);
    if (!isNaN(parsed.getTime())) {
      updatedAt = parsed.toISOString();
    }
  }
  return { runId, agentId, state: safeState, terminal, updatedAt };
}

/**
 * List runs in a runDir, optionally filtered by workspace ownership.
 *
 * @param {object} input
 * @param {string} input.runDir — directory containing run_*.jsonl files
 * @param {string} [input.agentId] — filter by agent (CLI)
 * @param {number} [input.latest] — take N most recent (CLI)
 * @param {boolean} [input.activeOnly] — only non-terminal runs
 * @param {string} [input.authorizedWorkspaceRoot] — MCP workspace binding
 * @param {string[]} [input.knownAgentIds] — for agentId validation (default [])
 * @param {number} [input.nowMs] — activity snapshot timestamp (default Date.now())
 * @param {Function} [input.checkLivenessFn] — ownerLiveness injection (tests)
 * @param {number} [input.livenessThresholdMs] — heartbeat staleness threshold
 *   (default DEFAULT_OWNER_LIVENESS_THRESHOLD_MS)
 * @param {Function} [input.readTranscriptFn] — test injection
 * @param {Function} [input.createWorkspaceVerifierFn] — test injection
 * @returns {Promise<{runs: Array, matchedCount: number, unresolvedCount: number}>}
 *   - runs: array of {runId, agentId, state, terminal, updatedAt,
 *             activityStatus, activityBasis}
 *   - matchedCount: eligible runs AFTER the activeOnly filter, BEFORE the limit
 *   - unresolvedCount: full-scan count of known non-terminal runs lacking a
 *     fresh owner heartbeat (pre-limit, independent of activeOnly)
 */
export async function listRuns(input) {
  const {
    runDir,
    agentId,
    latest,
    activeOnly = false,
    authorizedWorkspaceRoot,
    knownAgentIds = [],
    nowMs,
    checkLivenessFn,
    livenessThresholdMs,
  } = input;
  const _readTranscript = input.readTranscriptFn ?? readTranscript;
  // M12-15: one nowMs snapshot per call (truthful "is it active RIGHT NOW").
  // Tests inject a fixed value for determinism; real callers omit it and get the
  // wall clock. ownerLiveness is the ONLY freshness SSOT — invoked once per
  // eligible (known non-terminal, in-workspace) run with the default threshold.
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const livenessThreshold = typeof livenessThresholdMs === "number"
    ? livenessThresholdMs
    : DEFAULT_OWNER_LIVENESS_THRESHOLD_MS;
  const _checkLiveness = checkLivenessFn ?? checkOwnerLiveness;

  const resolvedRunDir = resolve(runDir);
  const files = scanRunFiles(resolvedRunDir);
  let workspaceVerifier = null;
  if (authorizedWorkspaceRoot !== undefined) {
    const createVerifier = input.createWorkspaceVerifierFn ?? createRunWorkspaceVerifier;
    try {
      workspaceVerifier = createVerifier(authorizedWorkspaceRoot);
    } catch {
      // Invalid/unprovable authority yields no visible runs, matching the prior
      // per-run fail-closed behavior without repeating the same failed proof.
      return { runs: [], matchedCount: 0 };
    }
  }

  const summaries = [];
  let unresolvedCount = 0;
  for (const file of files) {
    const runId = file.replace(/\.jsonl$/, "");
    // Validate runId from filename
    if (!isValidRunId(runId)) continue;

    let events;
    try {
      events = await _readTranscript(join(resolvedRunDir, file));
    } catch {
      // Malformed/unreadable transcript — skip silently (fail-closed per file)
      continue;
    }

    // Workspace ownership filter (MCP path). The verifier binds ownership
    // facts to THIS run (runId from the transcript filename).
    if (workspaceVerifier) {
      try {
        workspaceVerifier(events, runId);
      } catch {
        // Other workspace, missing/duplicate/malformed ownership — skip silently
        continue;
      }
    }

    // Agent filter (CLI path)
    const rawAgentId = events[0]?.agentId;
    if (agentId && rawAgentId !== agentId) continue;

    // M12-15: closed-set activity classification. Computed once per run AFTER
    // workspace + agent filtering. Only known non-terminal runs trigger the
    // ownerLiveness SSOT (once each); terminal and unknown-state runs are
    // classified WITHOUT a heartbeat check and are NEVER reported active.
    const state = findState(events);
    const safeState = RUN_STATES.includes(state) ? state : "unknown";
    const isTerminal = TERMINAL_STATES.includes(safeState);
    let activityStatus;
    let activityBasis;
    if (isTerminal) {
      activityStatus = "terminal";
      activityBasis = "terminal_state";
    } else if (safeState === "unknown") {
      // Fail-closed: an unrecognized state is NOT provably active.
      activityStatus = "unknown";
      activityBasis = "unknown_state";
    } else {
      // Known non-terminal: require a FRESH owner heartbeat to be active.
      // A stale / missing / corrupt heartbeat → unresolved, NEVER inferred
      // failed/dead/stopped (the run may legitimately still be running).
      const liveness = _checkLiveness(resolvedRunDir, runId, now, livenessThreshold);
      if (liveness && liveness.fresh) {
        activityStatus = "active";
        activityBasis = "fresh_owner_heartbeat";
      } else {
        activityStatus = "unresolved";
        activityBasis = "no_fresh_owner_heartbeat";
        unresolvedCount += 1;
      }
    }

    // activeOnly returns ONLY proven-active runs. Terminal / unknown /
    // unresolved runs are excluded here — but unresolved stays discoverable via
    // the ordinary list and is counted in unresolvedCount (full scan, pre-limit,
    // independent of activeOnly).
    if (activeOnly && activityStatus !== "active") continue;

    const summary = summarizeRun(runId, events, knownAgentIds, input);
    if (!summary) continue;
    summary.activityStatus = activityStatus;
    summary.activityBasis = activityBasis;
    summaries.push(summary);
  }

  // Sort by updatedAt descending; null/invalid timestamps go last;
  // ties broken by runId ascending (deterministic).
  summaries.sort((a, b) => {
    const tsA = a.updatedAt ?? "";
    const tsB = b.updatedAt ?? "";
    if (tsA !== tsB) return tsB.localeCompare(tsA); // descending
    return a.runId.localeCompare(b.runId); // ascending tiebreak
  });

  const matchedCount = summaries.length;

  // Apply latest/limit
  const limit = latest ?? null;
  if (limit && limit > 0 && summaries.length > limit) {
    summaries.length = limit;
  }

  return { runs: summaries, matchedCount, unresolvedCount };
}
