// src/application/runStatus.js
//
// M9-3A: Shared application service for read-only run status aggregation.
//
// This module is the single owner of the "what is this run doing right now"
// aggregation: state derivation, terminal detection, and activity heartbeat
// (last run.event → kind/summary/age). CLI `status` and MCP `run_status` both
// call it so the algorithm exists exactly once (no second copy).
//
// Architectural contract:
//   - Read-only: never writes transcript, owner files, or any persistent state.
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Depends on transcript.js (readTranscript/findState/TERMINAL_STATES) and
//     delivery.js (isValidRunId).

import { join } from "node:path";

import { readTranscript, findState, TERMINAL_STATES } from "../transcript.js";
import { isValidRunId } from "../delivery.js";

// ===== Activity description (migrated from observe.js, TD-75 semantics) =====

/**
 * Summarize tool input by extracting the most identifying field.
 * @param {string} tool
 * @param {object} [input]
 * @returns {string}
 */
function summarizeToolInput(tool, input) {
  if (!input || typeof input !== "object") return "";
  const key = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query;
  return key ? truncate(String(key), 80) : "";
}

/**
 * Truncate + collapse whitespace for human-readable summaries.
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
function truncate(s, n) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/**
 * TD-75: Map a run.event to a Lead-readable activity kind + summary.
 * Human labels (Chinese) are the existing CLI contract — preserved exactly.
 * @param {object|null} ev
 * @returns {{lastActivityKind: string|null, lastActivitySummary: string|null}}
 */
function describeActivity(ev) {
  if (!ev) return { lastActivityKind: null, lastActivitySummary: null };
  switch (ev.kind) {
    case "message":
      return { lastActivityKind: "在说话", lastActivitySummary: `worker 发言（${ev.role ?? "?"}）` };
    case "thinking":
      return { lastActivityKind: "在思考", lastActivitySummary: "worker 正在 reasoning" };
    case "command":
      return { lastActivityKind: "跑命令", lastActivitySummary: truncate(ev.command ?? "", 80) };
    case "tool_use":
      return { lastActivityKind: `用工具 ${ev.tool ?? "?"}`, lastActivitySummary: summarizeToolInput(ev.tool, ev.input) };
    case "tool_result":
      return { lastActivityKind: "收工具结果", lastActivitySummary: `${ev.tool ?? "?"} 返回${ev.isError ? "（错误）" : ""}` };
    case "file_written":
      return { lastActivityKind: "在写文件", lastActivitySummary: basenameSafe(ev.path ?? "") };
    default:
      return { lastActivityKind: ev.kind ?? "未知", lastActivitySummary: "" };
  }
}

function basenameSafe(p) {
  const parts = String(p).replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "";
}

// ===== Service =====

/**
 * Get the read-only status of a run.
 *
 * @param {object} input
 * @param {string} input.runId — must pass isValidRunId
 * @param {string} input.runDir — runs/ directory (server/CLI-owned)
 * @param {Function} [input.readTranscriptFn] — injectable for testing
 * @param {Function} [input.nowFn] — injectable clock for deterministic age
 * @returns {Promise<object>} structured status (CLI prints a subset; MCP a safe subset)
 */
export async function getRunStatus({
  runId,
  runDir,
  readTranscriptFn,
  nowFn,
}) {
  if (!runId || typeof runId !== "string") {
    throw new Error("getRunStatus: runId is required");
  }
  if (!runDir || typeof runDir !== "string") {
    throw new Error("getRunStatus: runDir is required");
  }
  // Validate runId BEFORE constructing any path or reading a file. Custom runIds
  // reach transcript paths; reject early to prevent path traversal / injection.
  if (!isValidRunId(runId)) {
    throw new Error(`Invalid runId: ${JSON.stringify(runId)}`);
  }

  const _readTranscript = readTranscriptFn ?? readTranscript;
  const _now = nowFn ?? Date.now;
  const filePath = join(runDir, `${runId}.jsonl`);

  // Read-only: readTranscript throws if the file does not exist (fail-closed).
  // The service must NOT create the file.
  const events = await _readTranscript(filePath);

  const state = findState(events);
  const terminal = TERMINAL_STATES.includes(state);

  // Last event overall (any type).
  const last = events.at(-1) ?? null;

  // Last run.event (activity heartbeat) — reverse search, TD-75 semantics.
  const lastActivity = [...events].reverse().find((e) => e.type === "run.event") ?? null;
  const lastActivityTs = lastActivity?.ts ?? null;
  const secondsSinceActivity = lastActivityTs
    ? Math.round((_now() - new Date(lastActivityTs).getTime()) / 1000)
    : null;
  const { lastActivityKind, lastActivitySummary } = describeActivity(lastActivity);

  return {
    runId,
    state,
    terminal,
    // CLI-compatible fields (TD-75 contract, byte-compatible output).
    last,
    lastActivityTs,
    secondsSinceActivity,
    lastActivityKind,
    lastActivitySummary,
    // Extra machine fields for MCP (safe subset), not printed by CLI adapter.
    lastEventType: last?.type ?? null,
    lastEventTs: last?.ts ?? null,
    lastActivityEventKind: lastActivity?.kind ?? null,
  };
}

// Exported for CLI adapter reuse (avoids a second copy of the algorithm).
export { describeActivity };
