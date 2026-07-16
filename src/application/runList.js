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
//   - Reuses transcript readTranscript/findState, isValidRunId, and
//     verifyRunWorkspaceOwnership SSOT.

import { join, resolve } from "node:path";
import { readdirSync, existsSync } from "node:fs";

import { readTranscript, findState, RUN_STATES, TERMINAL_STATES } from "../transcript.js";
import { isValidRunId } from "../delivery.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";

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
 * @param {Function} [input.readTranscriptFn] — test injection
 * @returns {Promise<{runs: Array, matchedCount: number}>}
 *   - runs: array of {runId, agentId, state, terminal, updatedAt}
 *   - matchedCount: number of eligible runs BEFORE limit (for MCP truncation)
 */
export async function listRuns(input) {
  const {
    runDir,
    agentId,
    latest,
    activeOnly = false,
    authorizedWorkspaceRoot,
    knownAgentIds = [],
  } = input;
  const _readTranscript = input.readTranscriptFn ?? readTranscript;

  const resolvedRunDir = resolve(runDir);
  const files = scanRunFiles(resolvedRunDir);

  const summaries = [];
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

    // Workspace ownership filter (MCP path)
    if (authorizedWorkspaceRoot !== undefined) {
      try {
        verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot);
      } catch {
        // Other workspace, missing/duplicate/malformed ownership — skip silently
        continue;
      }
    }

    // Agent filter (CLI path)
    const rawAgentId = events[0]?.agentId;
    if (agentId && rawAgentId !== agentId) continue;

    // Active-only filter
    if (activeOnly) {
      const state = findState(events);
      if (TERMINAL_STATES.includes(state)) continue;
    }

    const summary = summarizeRun(runId, events, knownAgentIds, input);
    if (summary) summaries.push(summary);
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

  return { runs: summaries, matchedCount };
}
