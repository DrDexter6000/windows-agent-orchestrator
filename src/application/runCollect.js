// src/application/runCollect.js
//
// M9-4A: Shared application service for run result collection.
//
// This module owns the collect algorithm: reconstructing worker output from
// transcript run.event entries, then appending exactly one `messages.collected`
// durable audit event per successful call. All runs collect from the
// transcript, including old transcripts of retired backends.
//
// CLI `collect` and MCP `run_collect` both call it so the algorithm exists once.
//
// Architectural contract:
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Depends on transcript.js (readTranscript/findLatestBound/
//     JsonlTranscript) and delivery.js (isValidRunId).
//   - collect is NOT read-only and NOT idempotent: each successful call appends
//     one messages.collected audit event. This is the existing CLI contract.

import { join } from "node:path";

import { readTranscript, findLatestBound, JsonlTranscript, findLastEventSeq, extractCanonicalAgentId } from "../transcript.js";
import { resolveTranscriptPath } from "../projectBuckets.js";
import { isValidRunId } from "../delivery.js";
import { assertRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";
// R21（TD-128 W2 升格修复）：重建输入的绑定作用域——metrics.js 单一定义处。
import { boundReportScope } from "../metrics.js";

const DEFAULT_LIMIT = 50;

// ===== Process event reconstruction (migrated from observe.js, TD-77) =====

/**
 * TD-77: Reconstruct a single run.event into a collect timeline entry.
 * Unknown kinds pass through (forward-compat). thinking is not persisted → null.
 * @param {object} ev
 * @returns {object|null}
 */
function reconstructProcessEvent(ev) {
  switch (ev.kind) {
    case "message":
      return { kind: "message", role: ev.role, parts: ev.parts };
    case "command":
      return { kind: "command", command: ev.command, ...(ev.exitCode !== undefined ? { exitCode: ev.exitCode } : {}) };
    case "tool_use":
      return { kind: "tool_use", tool: ev.tool, input: ev.input };
    case "tool_result":
      return { kind: "tool_result", tool: ev.tool, output: ev.output, isError: ev.isError };
    case "file_written":
      return { kind: "file_written", path: ev.path };
    case "thinking":
      return null;
    default:
      return { kind: ev.kind ?? "unknown", ...ev };
  }
}

// M12-3: shared snapshot reconstruction. Reconstruct the FULL set of worker-
// authored items from an EXPLICIT transcript event snapshot, reusing the SAME
// reconstructProcessEvent SSOT (no second parser). Both collectRunMessages
// (process path) and the read-only runAwaitResult composite call this so the
// reconstructed item sequence is byte-identical for a given snapshot — there is
// exactly one reconstruction algorithm in the codebase.
//
// @param {Array<object>} events — explicit transcript event snapshot
// @returns {Array<object>} reconstructed items (thinking dropped)
function reconstructItemsFromEvents(events) {
  const list = Array.isArray(events) ? events : [];
  return list
    .filter((e) => e && e.type === "run.event")
    .map(reconstructProcessEvent)
    .filter((e) => e !== null);
}

// ===== Default append implementation (writes to the real transcript) =====

/**
 * Build a default appendCollectedFn that writes to the real transcript file.
 * Uses the validated runId argument (not events[0].runId) for the transcript
 * context so the audit event is always correctly attributed even if the first
 * event lacks a runId field.
 * @param {string} transcriptPath
 * @param {string} runId — the validated runId argument (authoritative)
 * @returns {Function}
 */
function defaultAppendFn(transcriptPath, runId) {
  return async (type, payload) => {
    // Re-read to get the latest seq + agentId (the file may have grown).
    let events = [];
    try { events = await readTranscript(transcriptPath); } catch { events = []; }
    const ctx = events[0] ?? {};
    const t = new JsonlTranscript(transcriptPath, {
      runId,
      agentId: ctx.agentId ?? "unknown",
      initialSeq: findLastEventSeq(events),
    });
    await t.append(type, payload);
  };
}

// ===== Service =====

/**
 * Collect a run's worker output and append one messages.collected audit event.
 *
 * All runs reconstruct run.event entries from the transcript.
 *
 * M11-4 continuation + CTO rework: when `deferAppend` is true (projection
 * mode — MCP always, CLI --format json / --cursor), the service reads +
 * reconstructs the FULL snapshot but does NOT append the audit event,
 * regardless of whether a cursor is present. It returns a `commitAppend`
 * function the caller MUST invoke after the projection layer has validated
 * the cursor binding (or produced page 1) AND output schema validation
 * succeeded. This guarantees ANY failure — invalid cursor, projection
 * failure, schema failure — results in ZERO audit
 * appends, including on cursor-less page 1 (M11-4 §12 + CTO rework Fix D).
 * When `deferAppend` is false (default, legacy raw CLI back-compat), the
 * service appends exactly once before returning.
 *
 * @param {object} input
 * @param {string} input.runId — must pass isValidRunId
 * @param {string} input.runDir — runs/ directory (host-owned)
 * @param {number} [input.limit=50] — max items to collect
 * @param {string} [input.cursor] — opaque continuation token (M11-4)
 * @param {boolean} [input.deferAppend=false] — when true, do not append; return
 *        commitAppend for the caller to invoke after projection success
 * @param {string} [input.authorizedWorkspaceRoot] — per-call proved target root
 *        (MCP run_collect). When supplied, the run's ownership must match it —
 *        verified fail-closed (code workspace_not_authorized) before any
 *        audit append. CLI callers omit it (Owner/Lead privileged
 *        channel, same as runStop).
 * @param {Function} [input.readTranscriptFn] — injectable for testing
 * @param {Function} [input.appendCollectedFn] — injectable append (testing)
 * @returns {Promise<{data: Array, reconstructed?: boolean, backend?: string, commitAppend?: Function}>}
 */
export async function collectRunMessages({
  runId,
  runDir,
  limit = DEFAULT_LIMIT,
  cursor,
  deferAppend = false,
  authorizedWorkspaceRoot,
  readTranscriptFn,
  appendCollectedFn,
}) {
  if (!runId || typeof runId !== "string") {
    throw new Error("collectRunMessages: runId is required");
  }
  if (!runDir || typeof runDir !== "string") {
    throw new Error("collectRunMessages: runDir is required");
  }
  // Validate runId BEFORE any path construction, file read, fetch, or append.
  if (!isValidRunId(runId)) {
    throw new Error(`Invalid runId: ${JSON.stringify(runId)}`);
  }

  const _readTranscript = readTranscriptFn ?? readTranscript;
  const transcriptPath = resolveTranscriptPath(runDir, runId);

  const events = await _readTranscript(transcriptPath);

  // the MCP boundary passes the per-call proved target root; the
  // run's ownership must match it (ownership SSOT — mismatched/missing/
  // malformed ownership fails closed with code workspace_not_authorized, which
  // the MCP adapter reports as a fixed refusal) BEFORE any serve fetch or
  // audit append. CLI callers omit the parameter.
  if (authorizedWorkspaceRoot !== undefined) {
    assertRunWorkspaceOwnership(events, authorizedWorkspaceRoot, runId);
  }

  // M11-8B closeout: canonical agentId from the transcript envelope, bound to
  // the requested runId. Passed through to the projection so MCP/CLI expose a
  // unified identity. Missing/conflicting/invalid/cross-run → "unknown".
  const agentId = extractCanonicalAgentId(events, runId);

  // Session gate (crash-run refusal).
  //
  // R16 (TD-127/TD-128; Owner 2026-08-18 拍板不兼容信封前老数据——本机实测存量
  // pre-envelope transcript 为 0): the session lookup is BOUND to the requested
  // runId and keeps its LAST-match order — collect reads the run's LATEST
  // session identity, the same latest-session-wins order the pre-R16 unbound
  // findLatest had on all-bound data and the same lane discipline as stop
  // (runStop.js) and activity (runActivity.js). Binding only removes lines
  // whose envelope runId is not THIS run: a tail-appended foreign-run
  // session.created can no longer swap the process backendSessionId.
  // Degradation (existing path, verified — no new branch): a transcript with
  // no runId-bound session.created — including pre-envelope legacy lines that
  // carry no runId field — falls into the existing "no session metadata"
  // refusal below, the SAME error face a transcript with no session.created
  // at all gets and the same treatment stop gives this shape (R13-C). Fail-closed:
  // no append, no fabricated parameters.
  const session = findLatestBound(events, "session.created", runId);
  if (!session?.backendSessionId) {
    throw new Error(`Run ${runId} has no session metadata (no session.created event)`);
  }

  // limit=0 means "all" (existing CLI semantics: slice(-0) returns everything).
  // Negative/NaN/non-number falls back to the default. MCP always passes 50.
  const numericLimit = Number(limit);
  const effectiveLimit = Number.isFinite(numericLimit) && numericLimit >= 0
    ? Math.floor(numericLimit)
    : DEFAULT_LIMIT;

  // M11-4 CTO rework (Fix A+C): the projection/continuation path (any call
  // with deferAppend=true, i.e. MCP and CLI --format json / --cursor) MUST
  // read the COMPLETE worker-authored snapshot, not a pre-truncated tail.
  // The old code always sliced to the last `effectiveLimit` items BEFORE
  // pagination, permanently hiding earlier messages (RED-1: 60 messages →
  // only last 50 reachable). Now: projection mode reads ALL run.event
  // entries; the legacy raw CLI mode (deferAppend=false) keeps the
  // slice(-limit) behavior byte-compatible.
  const isProjectionMode = deferAppend;

  // 所有 run 一律从转录重建（不变量 1：run 真相来自转录；活 run 语义 = 截至
  // 当前快照）。crash run（无 session.created）保 "no session metadata" 拒绝（R13-C 同面），
  // CLI 侧附诊断指路。
  // M12-3: reuse the shared reconstructItemsFromEvents SSOT (one algorithm).
  // R21（TD-128 W2 升格修复，原 W4"明确不做"经双席咨询改判）：重建输入经
  // boundReportScope 收窄到本 run 信封事件——外 run 尾条 run.event 不再被
  // 重建进 collect 输出（messages/evidenceCounts 是 Lead 决策的机器消费
  // 字段）。调用侧绑定，SSOT reconstructItemsFromEvents 本体不动。
  // 无 legacy 腿：到达此处必先过上方 findLatestBound session 门（已拒全无
  // 信封形状），session.created 行本身即带本 runId 信封 → boundReportScope
  // 在此恒非 null；?? [] 仅为函数全形状的防御，不为 legacy 回退。
  const reconstructedAll = reconstructItemsFromEvents(boundReportScope(events, runId) ?? []);
  const reconstructed = isProjectionMode
    ? reconstructedAll                     // full snapshot — pagination handles bounds
    : reconstructedAll.slice(-effectiveLimit);  // legacy raw CLI tail behavior

  const payload = {
    backendSessionId: session.backendSessionId,
    // backend 身份从 session.created 事实派生（runAwaitResult 同款先例）——
    // process run 的 session.created 恒带 backend:"process"（零漂移），
    // kimi-web 如实上报自身身份（此前硬编码 "process" 会让 wire 消费者看到
    // 错误身份）。
    backend: typeof session.backend === "string" && session.backend.length > 0 ? session.backend : "process",
    count: reconstructed.length,
    reconstructed: true,
  };
  if (isProjectionMode) {
    return {
      data: reconstructed, reconstructed: true,
      backend: typeof session.backend === "string" && session.backend.length > 0 ? session.backend : "process",
      agentId,
      commitAppend: buildCommitAppend(appendCollectedFn, transcriptPath, runId, payload),
    };
  }
  const _append = appendCollectedFn ?? defaultAppendFn(transcriptPath, runId);
  await _append("messages.collected", payload);
  return {
    data: reconstructed, reconstructed: true,
    backend: typeof session.backend === "string" && session.backend.length > 0 ? session.backend : "process",
    agentId,
  };
}

/**
 * Build a commitAppend closure that invokes the real (or injected) append
 * with the prepared payload. The caller invokes this only after the projection
 * layer has validated the cursor and produced a successful page.
 */
function buildCommitAppend(appendCollectedFn, transcriptPath, runId, payload) {
  return async () => {
    const _append = appendCollectedFn ?? defaultAppendFn(transcriptPath, runId);
    await _append("messages.collected", payload);
  };
}

export { reconstructProcessEvent, reconstructItemsFromEvents };
