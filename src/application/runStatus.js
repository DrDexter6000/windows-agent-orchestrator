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
//   - Depends on transcript.js (readTranscript/findState/TERMINAL_STATES),
//     delivery.js (isValidRunId), and metrics.js (boundReportScope — the R18/R20
//     observation-report binding SSOT, reused so the "何时绑定" rule lives once).
//   - M12-17: executionStage via projectExecutionStage (pure closed-set
//     projection over the SAME read-only snapshot; never writes, never probes
//     liveness, never makes a semantic judgment).

import { join } from "node:path";

import { readTranscript, findState, TERMINAL_STATES, extractCanonicalAgentId } from "../transcript.js";
import { isValidRunId } from "../delivery.js";
import { boundReportScope } from "../metrics.js";
import { projectExecutionStage } from "./runStageProjection.js";

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
    case "runtime_activity": {
      const summaries = {
        initialized: "provider 已初始化",
        streaming: "provider 正在输出",
        provider_retry: "provider 正在重试",
      };
      return {
        lastActivityKind: "运行时状态",
        lastActivitySummary: summaries[ev.status] ?? "provider 状态未知",
      };
    }
    default:
      return { lastActivityKind: ev.kind ?? "未知", lastActivitySummary: "" };
  }
}

function basenameSafe(p) {
  const parts = String(p).replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "";
}

function describeLastEventMeaning(type) {
  if (type === "run.stop_verified") return "runtime_quiet_verified";
  if (type === "run.stop_unverified") return "runtime_quiet_unverified";
  return null;
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

  // R20 (TD-128 M1，末簇观测投影)：state/terminal/last/lastActivity 补齐本函数
  // 既有绑定纪律（agentId/executionStage 自 M11-8B/M12-17 起已绑定）。经
  // metrics.js 的 boundReportScope 单一定义处收窄到请求 runId 的信封绑定事件
  // ——findState 的 state_change 末条胜出语义下，尾部追加的外 run 伪终态/
  // 伪活动行不再翻转 state/terminal、不再供给 last/lastActivity。legacy 行为
  // 选择（boundReportScope 自身规则，对齐 TD-75 既有 JSON 契约）：全无信封的
  // pre-envelope transcript 保持历史读法（cli.test.js TD-75 系列钉住）；任一
  // 事件带信封（含伪造尾行）即严格绑定——外 run/无信封行不可见，混信封下
  // 状态不可归属时降级 pending（findState([])），不 throw。
  const scope = boundReportScope(events, runId) ?? events;
  const state = findState(scope);
  const terminal = TERMINAL_STATES.includes(state);

  // M11-8B closeout: canonical agentId from the transcript envelope (the same
  // snapshot already read above — no extra read). Bound to the requested runId:
  // events from a different run, a missing/conflicting agentId, or an invalid
  // id all degrade to "unknown" (no throw, no gate). Never inferred from worker text.
  const agentId = extractCanonicalAgentId(events, runId);

  // Last event overall (any type) — R20 起取绑定作用域内末条。
  const last = scope.at(-1) ?? null;

  // Last run.event (activity heartbeat) — reverse search, TD-75 semantics.
  // R20：同在绑定作用域内反查（外 run/无信封 run.event 不再供给心跳）。
  const lastActivity = [...scope].reverse().find((e) => e.type === "run.event") ?? null;
  const lastActivityTs = lastActivity?.ts ?? null;
  const secondsSinceActivity = lastActivityTs
    ? Math.round((_now() - new Date(lastActivityTs).getTime()) / 1000)
    : null;
  const { lastActivityKind, lastActivitySummary } = describeActivity(lastActivity);

  // M12-17: submitted-stage execution semantics — pure closed-set projection
  // over the SAME read-only snapshot, bound to the requested runId. Same
  // injectable clock as secondsSinceActivity, so all ages are deterministic
  // together. Purely additive; state/terminal/activity stay untouched.
  const stage = projectExecutionStage({ events }, { runId, nowFn: _now });

  return {
    runId,
    agentId,
    state,
    terminal,
    executionStage: {
      phase: stage.phase,
      sinceTs: stage.sinceTs,
      secondsSince: stage.secondsSince,
    },
    // CLI-compatible fields (TD-75 contract, byte-compatible output).
    last,
    lastActivityTs,
    secondsSinceActivity,
    lastActivityKind,
    lastActivitySummary,
    // Extra machine fields for MCP (safe subset), not printed by CLI adapter.
    lastEventType: last?.type ?? null,
    lastEventTs: last?.ts ?? null,
    // `run.stop_verified` may come from routine terminal cleanup or an explicit
    // Lead stop. The stable meaning is only that the worker runtime is quiet.
    lastEventMeaning: describeLastEventMeaning(last?.type),
    lastActivityEventKind: lastActivity?.kind ?? null,
  };
}

// Exported for CLI adapter reuse (avoids a second copy of the algorithm).
export { describeActivity, describeLastEventMeaning };
