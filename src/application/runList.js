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
import { boundReportScope } from "../metrics.js";
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

// M12-20: enumerate the CURRENT owner-lease candidates — the .owner-<runId>
// heartbeat files backgroundRunner writes while a runner is alive (and deletes
// on exit). This reads runDir once with readdirSync and filters to .owner-*
// files: the directory read touches every entry (its cost grows with the total
// directory size, including historical transcripts), but the EXPENSIVE downstream
// work — opening/parsing each transcript, per-run workspace verification, and
// ownerLiveness — runs ONLY for these lease candidates, so no historical
// transcript is opened, parsed, or verified. The corresponding transcript file
// is <runId>.jsonl (validated and read downstream exactly like a default-scan
// file). isValidRunId filters any oddly-named lease file; the runId slice
// matches ownerFilePath()'s naming.
function scanOwnerLeaseCandidates(runDir) {
  if (!existsSync(runDir)) return [];
  const files = readdirSync(runDir);
  return files
    .filter((f) => f.startsWith(".owner-"))
    .map((f) => f.slice(".owner-".length))
    .filter((runId) => isValidRunId(runId))
    .sort();
}

/**
 * Extract the smallest EXACT static run facts from parsed transcript events.
 *
 * This is the cache payload SSOT (M12-18): the static facts listRuns derives
 * from a transcript, plus the exact run.background_submitted / run.started
 * ownership events the workspace verifier consumes (findRunWorkspaceOwnership
 * filters by those types, so this projection is exact-equivalence for
 * re-applying CURRENT workspace authorization on every query). The facts are
 * derived from the full exact parse — never a selective parser.
 *
 * R20 (TD-128 M2，每行 state/terminal 绑定)：提供了权威 runId（listRuns 的
 * 【文件名 stem】）时，state/terminal 经 metrics.js 的 boundReportScope 单一
 * 定义处收窄到该 runId 的信封绑定事件——尾部追加的外 run 伪终态尾条不再
 * 翻转 runs list 每行的 state/terminal（及由其派生的 activity 分类）。legacy
 * 行为选择 = boundReportScope 自身规则：全无信封的 pre-envelope transcript
 * 保持历史读法；任一事件带信封即严格绑定，混信封下不可归属降级 pending。
 * runId 缺省（runSummaryCache 的 extractFactsFn 兼容形状 / 既有直接调用）时
 * 保持历史无绑定读法——缓存路径的绑定需其调用方传入 stem（本轮授权面外，
 * 见 TD-128 登记）。agentId/updatedAt/ownershipEvents 不在本轮锚点，维持全量
 * 事件派生。
 *
 * Returns null when the transcript yields no run (empty / non-array events).
 *
 * @param {object[]} events
 * @param {string|null} [runId] 权威 runId（文件名 stem）；缺省保持历史读法
 * @returns {{agentId, state, terminal, updatedAt, ownershipEvents}|null}
 */
export function extractRunFacts(events, runId = null) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const scope = boundReportScope(events, runId) ?? events;
  const state = findState(scope);
  // Map unknown states to "unknown" (don't leak arbitrary strings)
  const safeState = RUN_STATES.includes(state) ? state : "unknown";
  const terminal = TERMINAL_STATES.includes(safeState);
  // agentId raw, pre-validation — the registry mapping is re-applied per query
  // (finalizeSummary) so cached facts stay registry-independent.
  const rawAgentId = events[0]?.agentId;
  // updatedAt: last event's ts, validated as ISO timestamp
  const lastTs = events[events.length - 1]?.ts ?? null;
  let updatedAt = null;
  if (lastTs && typeof lastTs === "string") {
    const parsed = new Date(lastTs);
    if (!isNaN(parsed.getTime())) {
      updatedAt = parsed.toISOString();
    }
  }
  return {
    agentId: rawAgentId,
    state: safeState,
    terminal,
    updatedAt,
    ownershipEvents: events.filter(
      (e) => e.type === "run.background_submitted" || e.type === "run.started",
    ),
  };
}

// Empty-transcript sentinel: preserves the pre-M12-18 flow EXACTLY for an
// empty file — ownership and activity are still evaluated (an empty file
// without a verifier is an unresolved run in the count) and the run is
// finally dropped at summary completion (finalizeSummary returns null).
const EMPTY_TRANSCRIPT_FACTS = Object.freeze({
  agentId: undefined,
  state: "pending",
  terminal: false,
  updatedAt: null,
  ownershipEvents: [],
  emptyTranscript: true,
});

/**
 * Complete a run summary from static facts, re-applying the CURRENT registry
 * (knownAgentIds) and CLI validateAgentIds flag per query.
 *
 * @param {string} runId — from filename (already isValidRunId-checked)
 * @param {object} facts — extractRunFacts payload (or the empty sentinel)
 * @param {string[]} knownAgentIds — for agentId validation
 * @param {object} input — listRuns input (validateAgentIds flag)
 * @returns {{runId, agentId, state, terminal, updatedAt}|null}
 */
function finalizeSummary(runId, facts, knownAgentIds, input) {
  if (facts.emptyTranscript) return null;
  const rawAgentId = facts.agentId;
  // agentId from first event; validate against known registry.
  // MCP path: always validate (even if registry unavailable → all "unknown").
  // CLI path (validateAgentIds=false): preserve raw agentId.
  const agentId = input.validateAgentIds === false
    ? (typeof rawAgentId === "string" ? rawAgentId : "unknown")
    : (typeof rawAgentId === "string" && knownAgentIds.includes(rawAgentId) ? rawAgentId : "unknown");
  return { runId, agentId, state: facts.state, terminal: facts.terminal, updatedAt: facts.updatedAt };
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
 * @param {Function} [input.readSummaryFn] — M12-18: metadata-validated cached
 *   run facts reader (extractRunFacts payload). When provided it takes
 *   precedence over readTranscriptFn — same output contract, no transcript
 *   read. Every query still re-applies workspace authorization,
 *   knownAgentIds, heartbeat, activeOnly, sorting and limit.
 * @param {Function} [input.createWorkspaceVerifierFn] — test injection
 * @param {"active"|"history"} [input.scanScope] — M12-20: extends the ONE listRuns
 *   SSOT (NOT a second classifier). "active" enumerates owner-lease candidates
 *   (.owner-<runId>) via a single readdirSync of runDir and includes ONLY
 *   proven-active runs — so the expensive per-run work (transcript open/parse +
 *   workspace verification + ownerLiveness) is O(current lease candidates); no
 *   historical transcript is opened or parsed (the directory read itself still
 *   touches every entry). "history" scans run_*.jsonl and filters by a bounded
 *   inclusive transcript-updated range. When ABSENT (MCP runs_list / CLI)
 *   behavior is byte-identical to before: full scan + unresolvedCount.
 * @param {{fromMs:number, toMs:number}} [input.historyRange] — M12-20: the
 *   bounded inclusive [fromMs, toMs] window for scanScope:"history", keyed on
 *   the transcript-derived summary updatedAt (not filesystem mtime). Ignored
 *   unless scanScope === "history".
 * @returns {Promise<{runs: Array, matchedCount: number, unresolvedCount?: number, scanScope?: string}>}
 *   - runs: array of {runId, agentId, state, terminal, updatedAt,
 *             activityStatus, activityBasis}
 *   - matchedCount: eligible runs AFTER the activeOnly / active-scope / history
 *     filter, BEFORE the limit
 *   - unresolvedCount: ONLY in the default scope (scanScope absent): the
 *     full-scan count of known non-terminal runs lacking a fresh owner
 *     heartbeat (pre-limit, independent of activeOnly). ABSENT for
 *     scanScope "active"|"history" (the full inventory is intentionally not
 *     scanned in active; history reports a bounded window, not full health).
 *   - scanScope: ONLY for scanScope "active"|"history" (echoes the input so a
 *     client can guard mode/epoch races). ABSENT in the default scope.
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
    scanScope,
    historyRange,
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
  let workspaceVerifier = null;
  if (authorizedWorkspaceRoot !== undefined) {
    const createVerifier = input.createWorkspaceVerifierFn ?? createRunWorkspaceVerifier;
    try {
      workspaceVerifier = createVerifier(authorizedWorkspaceRoot);
    } catch {
      // Invalid/unprovable authority yields no visible runs, matching the prior
      // per-run fail-closed behavior without repeating the same failed proof.
      // Echo scanScope for active/history so a client always knows the mode.
      if (scanScope === undefined) return { runs: [], matchedCount: 0 };
      return { runs: [], matchedCount: 0, scanScope };
    }
  }

  // M12-20: the candidate set depends on scanScope. "active" enumerates the
  // CURRENT owner-lease candidates (.owner-<runId>) via a single readdirSync of
  // runDir — the expensive per-run work (transcript open/parse + workspace
  // verification + ownerLiveness) is O(current lease candidates); no historical
  // transcript is opened or parsed. "history" and the default scope scan the
  // run_*.jsonl inventory (history then filters by a bounded transcript-updated
  // range below). Each candidate flows through the SAME downstream pipeline
  // (facts → workspace → activity), so scanScope is an input to the ONE
  // classifier, never a second classifier.
  let candidates;
  if (scanScope === "active") {
    candidates = scanOwnerLeaseCandidates(resolvedRunDir)
      .map((runId) => ({ runId, file: `${runId}.jsonl` }));
  } else {
    candidates = scanRunFiles(resolvedRunDir)
      .map((file) => ({ runId: file.replace(/\.jsonl$/, ""), file }));
  }

  const summaries = [];
  let unresolvedCount = 0;
  for (const { runId, file } of candidates) {
    // Validate runId from filename / lease-name (active candidates are already
    // pre-filtered; this is a no-op for them and kept for default/history).
    if (!isValidRunId(runId)) continue;

    // Static run facts come from ONE of two exact sources:
    //   - readSummaryFn (M12-18): metadata-validated in-memory facts served by
    //     the MCP query cache — the same extractRunFacts payload, stored only
    //     when the file's pre/post metadata agree (never on a parse failure).
    //   - readTranscriptFn (default): the full transcript parsed this query.
    // Both flow through the SAME downstream re-validation below (CURRENT
    // workspace binding, agentId registry, heartbeat, activeOnly, sorting,
    // limit), so the cache can never freeze a query result.
    let facts;
    let ownershipView;
    if (input.readSummaryFn) {
      try {
        facts = await input.readSummaryFn(join(resolvedRunDir, file));
      } catch {
        // Unreadable/vanished/corrupt file — skip silently (fail-closed per file)
        continue;
      }
      if (!facts || !Array.isArray(facts.ownershipEvents)) continue; // malformed payload — fail closed
      ownershipView = facts.ownershipEvents;
    } else {
      let events;
      try {
        events = await _readTranscript(join(resolvedRunDir, file));
      } catch {
        // Malformed/unreadable transcript — skip silently (fail-closed per file)
        continue;
      }
      facts = extractRunFacts(events, runId);
      // An empty transcript preserves the exact pre-M12-18 flow: ownership and
      // activity are still evaluated, and the run is dropped at completion.
      if (!facts) facts = EMPTY_TRANSCRIPT_FACTS;
      ownershipView = events;
    }

    // Workspace ownership filter (MCP path). The verifier binds ownership
    // facts to THIS run (runId from the transcript filename) — re-applied to
    // the CURRENT authorized binding on every query, cached facts included.
    if (workspaceVerifier) {
      try {
        workspaceVerifier(ownershipView, runId);
      } catch {
        // Other workspace, missing/duplicate/malformed ownership — skip silently
        continue;
      }
    }

    // Agent filter (CLI path)
    if (agentId && facts.agentId !== agentId) continue;

    // M12-20 history: bounded INCLUSIVE range filter on the transcript-derived
    // summary updatedAt (NOT filesystem mtime). A run whose updatedAt cannot be
    // placed in time (null/unparseable) is excluded — it cannot be proven
    // in-window. Terminal + active + unresolved runs are all eligible here;
    // history never forces activeOnly.
    if (scanScope === "history") {
      const range = historyRange && Number.isFinite(historyRange.fromMs) && Number.isFinite(historyRange.toMs)
        ? historyRange : null;
      if (!range) continue;
      const ms = facts.updatedAt != null ? Date.parse(facts.updatedAt) : NaN;
      if (!Number.isFinite(ms) || ms < range.fromMs || ms > range.toMs) continue;
    }

    // M12-15: closed-set activity classification. Computed once per run AFTER
    // workspace + agent filtering. Only known non-terminal runs trigger the
    // ownerLiveness SSOT (once each); terminal and unknown-state runs are
    // classified WITHOUT a heartbeat check and are NEVER reported active.
    const safeState = facts.state;
    const isTerminal = facts.terminal;
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
        // unresolvedCount is the FULL-INVENTORY health signal — it is only
        // meaningful in the default scope (the only scope that scans the whole
        // inventory). active/history intentionally do not surface it.
        if (scanScope === undefined) unresolvedCount += 1;
      }
    }

    // activeOnly (default scope, MCP runs_list / CLI) returns ONLY proven-active
    // runs. Terminal / unknown / unresolved runs are excluded — but unresolved
    // stays discoverable via the ordinary list and is counted in unresolvedCount
    // (full scan, pre-limit, independent of activeOnly).
    if (activeOnly && activityStatus !== "active") continue;
    // M12-20 active scope: include ONLY proven-active runs. A stale / corrupt /
    // missing heartbeat, a terminal state, or an unknown state is excluded —
    // NEVER inferred failed/dead/stopped (the run may still be running; the
    // Owner can find it via the default list or a history window).
    if (scanScope === "active" && activityStatus !== "active") continue;

    const summary = finalizeSummary(runId, facts, knownAgentIds, input);
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

  // M12-20: the default scope (no scanScope — MCP runs_list / CLI) reports the
  // full-scan unresolvedCount. active/history instead echo scanScope so a client
  // can guard mode/epoch races; they NEVER surface unresolvedCount (the full
  // inventory is intentionally not scanned in active, and history is a bounded
  // window — neither is the full-inventory health signal).
  if (scanScope === undefined) {
    return { runs: summaries, matchedCount, unresolvedCount };
  }
  return { runs: summaries, matchedCount, scanScope };
}
