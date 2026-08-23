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

// TD-113（2026-08-20）: backward-scan ceiling for the repeat write counter,
// counted in EXAMINED events (interleaved ones included) — the counter is
// purely positional, no time window. Real interleaved shapes (same-path
// file_written typically 7 events apart, P90 25 — 2026-08-20 corpus scan)
// saturate the effective write count around 20-30; that still separates
// "在推进" from "卡死" without scanning an unbounded transcript.
const WRITE_REPEAT_SCAN_LIMIT = 200;

/**
 * TD-113: count the trailing run of same-path file_written events.
 * file_written events are rarely adjacent in real transcripts (every parser
 * pushes a tool_result immediately before file_written; corpus-wide only 17
 * adjacent pairs in ~6683 writes), so the count is taken on the
 * file_written SUBSEQUENCE: walk `priorEvents` backwards, skip any
 * interleaved event (tool_use/tool_result/message/thinking/...), stop at the
 * first file_written with a DIFFERENT path. Path compare is full-path, not
 * basename — two same-named files in different directories are different
 * writes (only the display stays basename, as TD-75 always rendered).
 * The scan examines at most WRITE_REPEAT_SCAN_LIMIT events, so with real
 * interleaving the effective count ceiling is far below 200 writes.
 *
 * Contract: `priorEvents` is the caller's bound scope and contains the event
 * being described as its last file_written, so the loop always counts it.
 * A mismatched caller shape degrades to "just this write" (N=1), never ×0.
 *
 * @param {Array} priorEvents 调用点传入的绑定作用域（含末条 file_written 自身）
 * @param {string} path 末条 file_written 的 path（全文比较）
 * @returns {number} N ≥ 1
 */
function countRecentSamePathWrites(priorEvents, path) {
  let n = 0;
  let scanned = 0;
  for (let i = priorEvents.length - 1; i >= 0 && scanned < WRITE_REPEAT_SCAN_LIMIT; i -= 1) {
    scanned += 1;
    const e = priorEvents[i];
    if (!e || e.kind !== "file_written") continue; // 跳过交错的任何事件
    if (e.path !== path) break; // 不同 path 的 file_written 即断
    n += 1;
  }
  return Math.max(n, 1);
}

/**
 * TD-75: Map a run.event to a Lead-readable activity kind + summary.
 * Human labels (Chinese) are the existing CLI contract — preserved exactly.
 *
 * TD-113: optional second argument carries the call-site scope context.
 * `priorEvents` is the caller's bound scope array (the same array `ev` was
 * found in — the counter's ONLY data source; the raw `events` read must never
 * feed it, see R23-B in test/run-lifecycle/boundReadSweep.test.js). The
 * counter is purely positional — it takes NO clock; the time dimension of
 * "还在动吗" stays with secondsSinceActivity (getRunStatus's single
 * injectable `_now`). Without the argument the output is byte-identical to
 * the legacy single-event form (TD-113-DEFAULT pins it); with it, a trailing
 * file_written also reports the repeat count of same-path writes as
 * `写 <file> ×N（最近）`.
 *
 * @param {object|null} ev
 * @param {object} [ctx]
 * @param {Array} [ctx.priorEvents] — 调用点绑定作用域（计数需要调用点传入 scope 上下文）
 * @returns {{lastActivityKind: string|null, lastActivitySummary: string|null}}
 */
function describeActivity(ev, { priorEvents } = {}) {
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
    case "file_written": {
      const name = basenameSafe(ev.path ?? "");
      // TD-113: without scope context the summary stays the legacy
      // byte-identical basename-only form; with it, append the repeat count.
      if (!Array.isArray(priorEvents)) {
        return { lastActivityKind: "在写文件", lastActivitySummary: name };
      }
      const n = countRecentSamePathWrites(priorEvents, ev.path);
      return { lastActivityKind: "在写文件", lastActivitySummary: `写 ${name} ×${n}（最近）` };
    }
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

/**
 * TD-150 批B: scorecard 可见面 — 把绑定作用域内最近一条 scorecard.checked 投影为
 * { passed, failedChecks }。failedChecks 只含未过检查的 name（WAO 代码写入的检查
 * 标签），绝不透传 evidence/detail 自由文本——run_status 的非泄漏红线由"只读
 * name 字段"这一形状保证，不靠调用方自律。无 scorecard.checked 的 run 返回
 * null（调用方据此让字段 absent——仓库惯例：缺事实 ≠ null 事实）。
 *
 * 绑定纪律：与 state/last/lastActivity 同一 R20 绑定作用域（boundReportScope 收窄），
 * 外 run 尾条伪造的 scorecard.checked 不再供给本字段。取最近一条（reverse 线性扫）：
 * correction/续跑等多次门控时末次结果胜出，与 findState 的末条语义一致。
 *
 * @param {Array} scopeEvents 绑定作用域事件数组
 * @returns {{passed: boolean, failedChecks: string[]}|null}
 */
function projectScorecardSummary(scopeEvents) {
  let checked = null;
  for (let i = scopeEvents.length - 1; i >= 0; i -= 1) {
    const e = scopeEvents[i];
    if (e?.type === "scorecard.checked") {
      checked = e;
      break;
    }
  }
  if (!checked) return null;
  const failedChecks = Array.isArray(checked.checks)
    ? checked.checks
        .filter((c) => c && typeof c === "object" && c.passed !== true && typeof c.name === "string")
        .map((c) => c.name)
    : [];
  // Fail-closed on a malformed/missing flag: only an explicit true reads as passed.
  return { passed: checked.passed === true, failedChecks };
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
  // TD-113: the repeat-write counter reads the SAME bound scope (`scope`, not
  // the raw `events` array) — unscoped counting stays out (foreign-run tail
  // lines included). It is positional and takes no clock; the time dimension
  // lives in secondsSinceActivity above (single injectable `_now`).
  const { lastActivityKind, lastActivitySummary } = describeActivity(lastActivity, {
    priorEvents: scope,
  });

  // M12-17: submitted-stage execution semantics — pure closed-set projection
  // over the SAME read-only snapshot, bound to the requested runId. Same
  // injectable clock as secondsSinceActivity, so all ages are deterministic
  // together. Purely additive; state/terminal/activity stay untouched.
  const stage = projectExecutionStage({ events }, { runId, nowFn: _now });

  // TD-150 批B: scorecard 可见面 — same bound scope, purely additive. A run
  // without any scorecard.checked event carries the field ABSENT (never null):
  // conditional spread keeps every existing consumer's shape byte-identical.
  const scorecardSummary = projectScorecardSummary(scope);

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
    ...(scorecardSummary ? { scorecardSummary } : {}),
  };
}

// Exported for test reuse only (the CLI adapter goes through getRunStatus;
// no production caller imports these directly anymore). TD-113: the repeat
// write counter needs the call site to pass scope context — `priorEvents`
// (the bound scope the event was found in) — via the optional second
// argument; without it the output stays the legacy single-event form.
export { describeActivity, describeLastEventMeaning };
