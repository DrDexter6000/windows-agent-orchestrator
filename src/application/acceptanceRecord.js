// src/application/acceptanceRecord.js
//
// TD-219 第一步（2026-10-06）：非 delivery run 的 Lead 侧验收落盘。
//
// 背景（docs/tech-debt.md TD-219）：delivery run 有 run_delivery_decide 承载
// 验收；非 delivery run（如"给本机 harness 装配置"这类仓库外写入任务）验收
// 此前只能靠 Lead 聊天汇报，transcript 里没有任何 acceptance 事件。本模块做
// 最小面：Lead 把"接受了什么、凭什么"以审计事件 `acceptance.recorded` 追加进
// 该 run 的 transcript 文件。不加 MCP 工具（CLI 先行，MCP 面等真实需求）。
//
// 架构契约：
//   - No argv parsing, no console.log, no process.exit。
//   - 追加走与 runCollect.js 追加 messages.collected **同一条** transcript
//     append 通道：readTranscript + JsonlTranscript.append（跨进程 append lock
//     + 载荷 secret redaction），不另写 JSONL 直写。
//   - 终态门：run 必须处于终态才记验收。终态闭集取 ../transcript.js 的
//     TERMINAL_STATES（状态机模块 SSOT，runManager.js 同源导入），不自造；
//     状态投影用同模块 findState 的 bound 纪律（e.runId === runId 过滤）。
//   - 多笔追加合法（审计日志语义——每次验收声明各落一笔，后续消费以最新一笔
//     为当前结论；与 run_delivery_decide 的恰一笔门不同，本面不做去重）。
//   - 已知最小面限制：终态扫描与追加非同一把锁（与 runCollect 的会话预检同
//     级）——终态判定基于本次调用读到的快照，不做锁内仲裁。
//   - runId 闭集对照仓库现有生成处的真实模式（backgroundRunner.js：
//     `run_${UTC 时间戳去分隔}${Math.random().toString(36).slice(2, 8)}`）——
//     `run_` 前缀 + 字母数字，是 delivery.js isValidRunId 的保守子集。
//   - 违规一律 typed 错误（AcceptanceRecordError + 闭集 code + 固定文案），
//     不回显超长原文。

import { join } from "node:path";

import {
  readTranscript,
  findState,
  findLastEventSeq,
  JsonlTranscript,
  TERMINAL_STATES } from "../transcript.js";
import { resolveTranscriptPath } from "../projectBuckets.js";
import { isValidRunId } from "../delivery.js";

/** 审计事件类型：Lead 侧验收落盘（TD-219）。 */
export const ACCEPTANCE_EVENT_TYPE = "acceptance.recorded";

/** decision 写入侧闭集（与 run_delivery_decide 的 accepted/rejected 同词汇）。 */
export const ACCEPTANCE_DECISIONS = Object.freeze(["accepted", "rejected"]);

/** reason 长度上限（超长拒绝，固定文案不回显原文）。 */
export const REASON_MAX_LENGTH = 2000;
/** evidenceSummary 长度上限（超长拒绝，固定文案不回显原文）。 */
export const EVIDENCE_SUMMARY_MAX_LENGTH = 1000;

// sha256 hex digest：64 位小写十六进制。
const EVIDENCE_DIGEST_RE = /^[0-9a-f]{64}$/;

// runId 生成处的真实模式（backgroundRunner.js）→ `run_` + 字母数字。比
// isValidRunId 更窄（不接裸词/连字符形态），且是其保守子集——两道校验同过，
// 不绕行 isValidRunId SSOT。
const RUN_ID_SHAPE_RE = /^run_[A-Za-z0-9]+$/;

/** typed 错误闭集 code（写入侧/调用侧同消费；成员变更 = 契约变更）。 */
export const ACCEPTANCE_RECORD_ERROR_CODES = Object.freeze([
  "invalid_run_id",
  "invalid_runs_dir",
  "invalid_decision",
  "invalid_reason",
  "invalid_evidence_digest",
  "invalid_evidence_summary",
  "run_transcript_missing",
  "run_not_terminal",
]);

/**
 * TD-219：验收落盘的 typed 错误。
 *
 * `code` 是机器协议（ACCEPTANCE_RECORD_ERROR_CODES 成员）；`message` 是固定
 * 人读文案，不回显超长/非法原文。仿 transcript.js DeliveryDecisionPolicyError
 * 先例：调用侧只按类型 + 闭集 code 分类，不解析 message。
 */
export class AcceptanceRecordError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AcceptanceRecordError";
    this.code = code;
  }
}

function assertValidRunId(runId) {
  if (!isValidRunId(runId) || !RUN_ID_SHAPE_RE.test(runId)) {
    throw new AcceptanceRecordError(
      "invalid_run_id",
      "runId 必须形如 run_<字母数字>（对照仓库现有 runId 生成模式）",
    );
  }
}

// 剥 C0/C1 控制字符 + DEL（净化落盘文本，不留不可打印字节）。
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * 净化落盘文本：剥控制字符 → trim → 限长（防御性兜底，合法输入经前置校验
 * 已不超长）。
 */
function sanitizeBoundedText(text, maxLength) {
  return text.replace(CONTROL_CHARS_RE, "").trim().slice(0, maxLength);
}

/**
 * 终态门：扫描 transcript 确认 run 处于终态（TERMINAL_STATES SSOT + findState
 * 的 bound 纪律）。非终态/不可归属 → typed 拒绝，文案说明只对终态 run 记验收。
 */
function assertRunTerminal(events, runId) {
  const state = findState(events.filter((e) => e && e.runId === runId));
  if (!TERMINAL_STATES.includes(state)) {
    throw new AcceptanceRecordError(
      "run_not_terminal",
      `只对终态 run 记验收：run ${runId} 当前非终态或状态不可归属，acceptance.recorded 只允许追加到已终态的 run transcript`,
    );
  }
}

async function readTranscriptOrTyped(transcriptPath, runId) {
  try {
    return await readTranscript(transcriptPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new AcceptanceRecordError(
        "run_transcript_missing",
        `Run ${runId} 的 transcript 不存在（runs/${runId}.jsonl 缺失），无法操作 acceptance.recorded`,
      );
    }
    throw error;
  }
}

/**
 * 追加 acceptance.recorded——与 runCollect.js 的 defaultAppendFn 同一通道：
 * 重读最新 events 取 seq/agentId 上下文，经 JsonlTranscript.append 落盘
 * （跨进程 append lock + secret redaction）。返回追加事件（含 seq）。
 */
async function appendAcceptanceEvent(transcriptPath, runId, payload) {
  // 重读取最新 seq + agentId（文件可能已增长）——runCollect defaultAppendFn 同款。
  let events = [];
  try { events = await readTranscript(transcriptPath); } catch { events = []; }
  const ctx = events[0] ?? {};
  const transcript = new JsonlTranscript(transcriptPath, {
    runId,
    agentId: ctx.agentId ?? "unknown",
    initialSeq: findLastEventSeq(events),
  });
  return transcript.append(ACCEPTANCE_EVENT_TYPE, payload);
}

/**
 * TD-219：Lead 侧验收落盘——非 delivery run 的 acceptance 审计事件。
 *
 * 校验（fail-closed，任何违规 zero append）：
 *   - runsDir 必填字符串；runId 必过 `run_<字母数字>` 闭集；
 *   - decision ∈ {accepted, rejected}；
 *   - reason 必填非空、≤2000 字符；evidenceDigest（可选）必匹配 sha256 hex；
 *     evidenceSummary（可选）≤1000 字符；
 *   - runs/<runId>.jsonl 必须存在；
 *   - 终态门：run 必须处于终态（TERMINAL_STATES），否则 typed 拒绝。
 *
 * 追加 payload：{ decision, reason(净化后), evidenceDigest?, evidenceSummary?,
 * recordedBy: "lead", recordedAt: <now ISO>, source: "cli" }——信封字段
 * （ts/seq/runId/agentId/type）由 JsonlTranscript.append 补齐，载荷过同一
 * redactor。多笔追加合法（审计日志语义，最新一笔为当前结论）。
 *
 * @param {object} input
 * @param {string} input.runsDir — runs/ 目录（host-owned）
 * @param {string} input.runId — 必须形如 run_<字母数字>
 * @param {"accepted"|"rejected"} input.decision
 * @param {string} input.reason — 必填非空，≤2000 字符
 * @param {string} [input.evidenceDigest] — 可选，sha256 hex（64 位小写十六进制）
 * @param {string} [input.evidenceSummary] — 可选，≤1000 字符
 * @param {string} [input.now] — 可选 ISO 时间戳（recordedAt）；缺省取当前时刻
 * @returns {Promise<{appended: true, seq: number}>}
 * @throws {AcceptanceRecordError} 违规一律 typed 拒绝（固定文案）
 */
export async function recordAcceptance({
  runsDir,
  runId,
  decision,
  reason,
  evidenceDigest,
  evidenceSummary,
  now,
}) {
  if (!runsDir || typeof runsDir !== "string") {
    throw new AcceptanceRecordError("invalid_runs_dir", "runsDir is required");
  }
  assertValidRunId(runId);
  if (!ACCEPTANCE_DECISIONS.includes(decision)) {
    throw new AcceptanceRecordError(
      "invalid_decision",
      "decision 必须是 accepted 或 rejected（闭集）",
    );
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new AcceptanceRecordError("invalid_reason", "reason 必填且不能为空");
  }
  if (reason.length > REASON_MAX_LENGTH) {
    throw new AcceptanceRecordError(
      "invalid_reason",
      `reason 超过 ${REASON_MAX_LENGTH} 字符上限`,
    );
  }
  if (evidenceDigest !== undefined && evidenceDigest !== null) {
    if (typeof evidenceDigest !== "string" || !EVIDENCE_DIGEST_RE.test(evidenceDigest)) {
      throw new AcceptanceRecordError(
        "invalid_evidence_digest",
        "evidenceDigest 必须是 64 位小写十六进制（sha256 hex）",
      );
    }
  }
  if (evidenceSummary !== undefined && evidenceSummary !== null) {
    if (typeof evidenceSummary !== "string") {
      throw new AcceptanceRecordError(
        "invalid_evidence_summary",
        "evidenceSummary 必须是字符串",
      );
    }
    if (evidenceSummary.length > EVIDENCE_SUMMARY_MAX_LENGTH) {
      throw new AcceptanceRecordError(
        "invalid_evidence_summary",
        `evidenceSummary 超过 ${EVIDENCE_SUMMARY_MAX_LENGTH} 字符上限`,
      );
    }
  }

  // D2-②b：跨层未命中（transcript-not-found）映射回既有闭集拒绝；孪生冲突
  // 等损坏形态如实上抛。
  let transcriptPath;
  try {
    transcriptPath = resolveTranscriptPath(runsDir, runId, { forAppend: true });
  } catch (e) {
    if (e?.code === "transcript-not-found") {
      throw new AcceptanceRecordError("run_transcript_missing", `Run ${runId} 的 transcript 不存在（任何层均未命中），无法操作 acceptance.recorded`);
    }
    throw e;
  }
  const events = await readTranscriptOrTyped(transcriptPath, runId);
  assertRunTerminal(events, runId);

  const recordedAt = typeof now === "string" && now.length > 0
    ? now
    : new Date().toISOString();
  const payload = {
    decision,
    reason: sanitizeBoundedText(reason, REASON_MAX_LENGTH),
  };
  if (evidenceDigest !== undefined && evidenceDigest !== null) {
    payload.evidenceDigest = evidenceDigest;
  }
  if (evidenceSummary !== undefined && evidenceSummary !== null) {
    payload.evidenceSummary = sanitizeBoundedText(evidenceSummary, EVIDENCE_SUMMARY_MAX_LENGTH);
  }
  payload.recordedBy = "lead";
  payload.recordedAt = recordedAt;
  payload.source = "cli";

  const appended = await appendAcceptanceEvent(transcriptPath, runId, payload);
  return { appended: true, seq: appended.seq };
}

/**
 * TD-219：列出该 run 全部 acceptance.recorded 事件的解析结果数组（按追加
 * 顺序，最新一笔在末尾）。只读，不追加。文件缺失 → typed 错误。
 *
 * @param {object} input
 * @param {string} input.runsDir — runs/ 目录（host-owned）
 * @param {string} input.runId — 必须形如 run_<字母数字>
 * @returns {Promise<object[]>} 解析后的 acceptance.recorded 事件数组
 * @throws {AcceptanceRecordError} runId 非法 / transcript 缺失
 */
export async function listAcceptance({ runsDir, runId }) {
  if (!runsDir || typeof runsDir !== "string") {
    throw new AcceptanceRecordError("invalid_runs_dir", "runsDir is required");
  }
  assertValidRunId(runId);
  // D2-②b：跨层未命中（transcript-not-found）映射回既有闭集拒绝；孪生冲突
  // 等损坏形态如实上抛。
  let transcriptPath;
  try {
    transcriptPath = resolveTranscriptPath(runsDir, runId, { forAppend: true });
  } catch (e) {
    if (e?.code === "transcript-not-found") {
      throw new AcceptanceRecordError("run_transcript_missing", `Run ${runId} 的 transcript 不存在（任何层均未命中），无法操作 acceptance.recorded`);
    }
    throw e;
  }
  const events = await readTranscriptOrTyped(transcriptPath, runId);
  return events.filter(
    (e) => e && e.type === ACCEPTANCE_EVENT_TYPE && e.runId === runId,
  );
}
