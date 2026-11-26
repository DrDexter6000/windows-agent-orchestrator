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
import { resolveTranscriptPath } from "../projectBuckets.js";
import { isValidRunId } from "../delivery.js";
import { boundReportScope } from "../metrics.js";
import { diagnoseFailure, isolationViolationDetail } from "../diagnosis.js";
// 批 119（A4）：带调用目标根时的归属核验（与 readRunActivity 同一 SSOT 入口）。
import { verifyRunWorkspaceOwnershipTyped as verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";

/**
 * Get the read-only diagnosis of a run.
 *
 * @param {object} input
 * @param {string} input.runId — must pass isValidRunId
 * @param {string} input.runDir — runs/ directory (host-owned)
 * @param {Function} [input.readTranscriptFn] — injectable for testing
 * @param {string} [input.authorizedWorkspaceRoot] — 批 119（A4）：可选调用目标根
 *   （canonical Git root）。给了就在读完转录后 fail-closed 核验归属（归属比较抛
 *   code="workspace_not_authorized"）；不给则按 runId 直读，行为不变。
 * @returns {Promise<{runId, state, terminal, category, code, evidence, isolationViolation?}>}
 *   isolationViolation — 第 141b 批：只在 category === "workdir_escape" 且绑定本
 *   runId 的事件上有可信字段时带（闭集 reason/destination、清理并限长后的
 *   reportedPath/resolvedPath、物理越界时的 escapedAt；见 diagnosis.js 的
 *   projectIsolationViolation）。
 *   code — nullable closed-set diagnosis code, a member of the single general
 *   DIAGNOSIS_CODES SSOT (provider-auth ∪ provider-capacity ∪ no-effect).
 *   provider_auth/provider_capacity carry their category code; no_effect carries
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
  authorizedWorkspaceRoot,
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
  const filePath = resolveTranscriptPath(runDir, runId);
  const events = await _readTranscript(filePath);

  // 批 119（A4）：带 authorizedWorkspaceRoot 时在读后、任何推导前核验归属
  //（fail-closed，绝不降级成部分结果；不给则按 runId 直读，行为不变）。
  if (authorizedWorkspaceRoot !== undefined && authorizedWorkspaceRoot !== null) {
    verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot, runId);
  }

  // R20 (TD-128 M4)：诊断的 state/terminal 投影绑定到请求 runId（与同文件
  // M11-8C Gap B 起 diagnoseFailure 的绑定分类读取同族，boundReportScope 单一
  // 定义处——metrics.js）：尾部追加的外 run 伪终态尾条不再把 run_diagnose 的
  // state/terminal 读成终态。legacy 行为选择（与 diagnosis.js 内核同一选择）：
  // 全无信封的 pre-envelope transcript 保持历史推断（frictionLog TD-92 契约）；
  // 任一信封即严格绑定，零绑定事件 → findState([]) = "pending" + terminal:false
  // ——不可归属永不投影为终态，与分类的既有降级（unknown）同向、不 throw。
  const state = findState(boundReportScope(events, runId) ?? events);
  const terminal = TERMINAL_STATES.includes(state);
  // M11-8C closeout (Gap B): pass the requested runId so diagnoseFailure can
  // bind the delivery_packaging_failed classification — a cross-run
  // run.delivery_failed event must NOT pollute this run's diagnosis.
  const { category, code, evidence } = diagnoseFailure(events, runId);

  // 第 141b 批：越界类别带上绑定事件的机读事实（闭集 reason/destination + 清理过的
  // 路径字段）；只给 MCP run_diagnose 用，CLI 照旧只读 evidence 文字。没有可信字段
  // 或不是越界 → 不带这个键。
  const isolationViolation = category === "workdir_escape" ? isolationViolationDetail(events, runId) : null;

  return {
    runId, state, terminal, category, code, evidence,
    ...(isolationViolation !== null ? { isolationViolation } : {}),
  };
}
