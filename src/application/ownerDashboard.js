// src/application/ownerDashboard.js
//
// M12-8C Package C: ownerDashboard — a THIN composition service that gives a
// local trusted Owner client a bounded, read-only view of worker runs WITHOUT
// increasing Lead context cost. It is facts-only: it NEVER stops / retries /
// continues / repackages / decides, and it performs NO semantic judgment.
//
// It composes the EXISTING application SSOTs — there is NO second JSONL parser,
// classifier, redactor, ownership algorithm, ownership verifier, or liveness
// algorithm anywhere in this module:
//   - listRuns               — bounded workspace-owned recent run list,
//   - readRunActivity        — the SINGLE read-only snapshot entry (one read,
//                              workspace ownership verified fail-closed BEFORE
//                              any projection; zero append),
//   - projectRunActivity     — the SHARED classifier/redactor/cursor projector,
//                              driven here with audience:"owner" (owner caps),
//   - checkOwnerLiveness     — the SINGLE heartbeat freshness algorithm.
//
// Safe-outcome contract: missing / corrupt / cross-workspace data maps to a
// SMALL closed-set safe outcome { available:false, unavailableReason } — NEVER
// raw exception text. Liveness is exposed ONLY as
//   { ownerHeartbeat: "fresh"|"stale"|"n/a", secondsSinceHeartbeat: number|null }
// and NEVER carries PID, path, session id, provider payload, or an absolute
// timestamp. Liveness is computed ONLY for a run the caller is authorized to
// read (it is never probed for a cross-workspace / missing / corrupt run, so the
// existence or freshness of another workspace's worker is never leaked).
//
// Read-only: every operation is a single transcript snapshot — zero transcript
// append, zero worktree mutation.
//
// Architectural contract:
//   - Does NOT import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Reuses the four SSOTs above; owns no second algorithm.
//   - Service fns are injectable for testing (readRunActivityFn /
//     projectRunActivityFn / checkOwnerLivenessFn / listRunsFn).

import { listRuns } from "./runList.js";
import { readRunActivity } from "./runActivity.js";
import {
  projectRunActivity,
  ACTIVITY_CATEGORIES,
  ACTIVITY_CURSOR_MAX_CHARS,
  LEAD_PAGE_HARD_CAP,
} from "./runActivityProjection.js";
import { checkOwnerLiveness } from "./ownerLiveness.js";
import { isValidRunId } from "../delivery.js";

// Bounded recent-run list cap (server query validation reuses this SSOT bound).
export const OWNER_RUNS_LIMIT_MAX = 100;

// M12-8C: the HTTP server imports ONLY node builtins + this service module. The
// closed-set caps + runId validator it needs for strict query parsing are
// re-exported here (from the SINGLE SSOTs) so the server never re-declares a
// second copy of a closed set and never reaches past the service layer.
export { isValidRunId, ACTIVITY_CATEGORIES, ACTIVITY_CURSOR_MAX_CHARS, LEAD_PAGE_HARD_CAP };

// Safe liveness shape for any run we are NOT authorized to observe (and for any
// unexpected liveness failure). Never probes the owner file.
const NA_LIVENESS = Object.freeze({ ownerHeartbeat: "n/a", secondsSinceHeartbeat: null });

/**
 * Classify a readRunActivity failure into the small closed set of safe Owner
 * outcomes. NEVER inspects or echoes raw error detail — it only selects a label.
 *   - ENOENT (no transcript file)        → "not_found"
 *   - ownership/workspace verification   → "cross_workspace" (run not provably
 *                                            the caller's — including a missing
 *                                            ownership fact)
 *   - anything else (parse/cross-run/
 *     shape/invalid runId/projection)    → "corrupt"
 * The closed set is the source of truth; the message substrings are only used
 * to pick among three safe labels, with a safe "corrupt" fallback.
 */
function classifyReadError(err) {
  if (err && err.code === "ENOENT") return "not_found";
  const msg = (err && typeof err.message === "string") ? err.message : "";
  if (/ownership|workspace/i.test(msg)) return "cross_workspace";
  return "corrupt";
}

/**
 * Map the ownerLiveness SSOT result to the safe Owner liveness shape.
 * Exposes ONLY a closed-set freshness label and a RELATIVE age in seconds —
 * never the absolute heartbeatAt, never PID, never path, never session. Any
 * missing/corrupt/non-numeric heartbeat collapses to "n/a" + null.
 */
function projectLiveness(checkFn, runDir, runId, nowMs) {
  try {
    const live = checkFn(runDir, runId, nowMs);
    const hb = live && live.heartbeatAt;
    if (typeof hb !== "number" || !Number.isFinite(hb)) {
      return { ownerHeartbeat: "n/a", secondsSinceHeartbeat: null };
    }
    const seconds = Math.max(0, Math.round((nowMs - hb) / 1000));
    return {
      ownerHeartbeat: live.fresh ? "fresh" : "stale",
      secondsSinceHeartbeat: seconds,
    };
  } catch {
    return { ownerHeartbeat: "n/a", secondsSinceHeartbeat: null };
  }
}

/**
 * List a bounded set of recent runs owned by the authorized workspace.
 * Delegates to listRuns (workspace-bound, fail-closed per run, safe summaries).
 * Never throws on a missing runDir — listRuns returns an empty list.
 *
 * M12-20: threads scanScope / historyRange / now / readSummaryFn into the ONE
 * listRuns SSOT for the dashboard active-first / history-on-demand model, and
 * echoes scanScope in the result so the HTTP client can guard mode/epoch races.
 * The service result NEVER carries unresolvedCount (dropped here for every
 * scope); active/history merely add the scanScope label.
 *
 * @param {object} input
 * @param {string} input.runDir — server-owned runs/ directory
 * @param {string} input.workspaceRoot — server-owned canonical Git root
 * @param {string[]} [input.knownAgentIds] — registry ids for agentId validation
 * @param {number} [input.latest] — bounded recent-runs cap (1..OWNER_RUNS_LIMIT_MAX)
 * @param {"active"|"history"} [input.scanScope] — M12-20 active/history scope
 * @param {{fromMs:number, toMs:number}} [input.historyRange] — bounded history window
 * @param {number} [input.now] — clock (ms) for liveness (default Date.now())
 * @param {Function} [input.readSummaryFn] — M12-18/M12-20 cached facts reader
 *   (the long-lived dashboard server threads the run-summary cache here so warm
 *   history reads do not reparse transcripts)
 * @param {Function} [input.listRunsFn] — injectable (testing)
 * @returns {Promise<{runs: object[], returnedCount: number, matchedCount: number, truncated: boolean, scanScope?: string}>}
 */
export async function getOwnerRuns(input) {
  const {
    runDir, workspaceRoot, knownAgentIds = [], latest,
    scanScope, historyRange, now, readSummaryFn,
    listRunsFn,
  } = input;
  const list = listRunsFn ?? listRuns;

  const result = await list({
    runDir,
    authorizedWorkspaceRoot: workspaceRoot,
    knownAgentIds,
    ...(latest !== undefined && latest !== null ? { latest } : {}),
    ...(scanScope ? { scanScope } : {}),
    ...(scanScope === "history" && historyRange ? { historyRange } : {}),
    ...(typeof now === "number" && Number.isFinite(now) ? { nowMs: now } : {}),
    ...(readSummaryFn ? { readSummaryFn } : {}),
  });

  const out = {
    runs: result.runs,
    returnedCount: result.runs.length,
    matchedCount: result.matchedCount,
    truncated: latest != null && result.matchedCount > result.runs.length,
  };
  // Echo the scope so a client can guard mode/epoch races (absent in default).
  if (typeof result.scanScope === "string") out.scanScope = result.scanScope;
  return out;
}

/**
 * Read ONE snapshot for a selected run and project its safe Owner activity page
 * plus safe liveness. Workspace ownership is verified fail-closed INSIDE
 * readRunActivity — BEFORE projection runs (a cross-workspace run never reaches
 * the projector). The read is a single snapshot: zero append, zero worktree
 * mutation.
 *
 * Missing / corrupt / cross-workspace data maps to { available:false,
 * unavailableReason } — never raw exception text. Liveness is computed only for
 * an authorized, readable run.
 *
 * @param {object} input
 * @param {string} input.runId — the selected run (bounded client fact)
 * @param {string} input.runDir — server-owned runs/ directory
 * @param {string} input.workspaceRoot — server-owned canonical Git root
 * @param {string[]} [input.knownAgentIds] — registry ids for agentId validation
 * @param {object} [input.env] — server-owned env for the secret redactor
 * @param {string} [input.cursor] — opaque continuation token (bounded client fact)
 * @param {number} [input.afterSeq] — only events with seq > afterSeq
 * @param {string[]} [input.categories] — closed-set category filter
 * @param {number} [input.pageSize] — entries per page (owner caps)
 * @param {"asc"|"desc"} [input.order] — closed-set entry order (default asc)
 * @param {number} [input.now] — clock (ms) for liveness (default Date.now())
 * @param {Function} [input.readRunActivityFn] — injectable (testing)
 * @param {Function} [input.projectRunActivityFn] — injectable (testing)
 * @param {Function} [input.checkOwnerLivenessFn] — injectable (testing)
 * @returns {Promise<{runId: string, available: boolean,
 *   unavailableReason: ("not_found"|"cross_workspace"|"corrupt"|null),
 *   activity: object|null,
 *   liveness: {ownerHeartbeat: ("fresh"|"stale"|"n/a"), secondsSinceHeartbeat: (number|null)} }>}
 */
export async function getOwnerActivity(input) {
  const {
    runId, runDir, workspaceRoot, knownAgentIds = [], env,
    cursor, afterSeq, categories, pageSize, order,
    now,
    readRunActivityFn, projectRunActivityFn, checkOwnerLivenessFn,
  } = input;

  const reader = readRunActivityFn ?? readRunActivity;
  const project = projectRunActivityFn ?? projectRunActivity;
  const liveness = checkOwnerLivenessFn ?? checkOwnerLiveness;
  const nowMs = typeof now === "number" && Number.isFinite(now) ? now : Date.now();

  const unavailable = (reason) => ({
    runId,
    available: false,
    unavailableReason: reason,
    activity: null,
    liveness: { ...NA_LIVENESS },
  });

  // 1) SINGLE read-only snapshot. readRunActivity verifies workspace ownership
  //    fail-closed BEFORE returning — so a cross-workspace / missing / corrupt
  //    run is classified here and NEVER reaches the projector.
  let snapshot;
  try {
    snapshot = await reader({ runId, runDir, authorizedWorkspaceRoot: workspaceRoot });
  } catch (err) {
    return unavailable(classifyReadError(err));
  }

  // 2) Safe Owner projection (audience:"owner" → owner caps). Any projection
  //    failure (e.g. a malformed/foreign/stale cursor) collapses to "corrupt" —
  //    a closed-set safe outcome with no raw text. The client re-requests page 1.
  let page;
  try {
    page = project(snapshot, {
      runId,
      audience: "owner",
      ...(cursor !== undefined && cursor !== null ? { cursor } : {}),
      ...(afterSeq !== undefined && afterSeq !== null ? { afterSeq } : {}),
      ...(categories !== undefined && categories !== null ? { categories } : {}),
      ...(pageSize !== undefined && pageSize !== null ? { pageSize } : {}),
      ...(order !== undefined && order !== null ? { order } : {}),
      ...(env !== undefined ? { env } : {}),
    });
  } catch {
    return unavailable("corrupt");
  }

  // 3) Safe liveness — only for a run we are authorized to read. Relative age
  //    only; never PID/path/session/absolute heartbeat.
  return {
    runId,
    available: true,
    unavailableReason: null,
    activity: page,
    liveness: projectLiveness(liveness, runDir, runId, nowMs),
  };
}
