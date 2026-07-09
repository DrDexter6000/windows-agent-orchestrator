/**
 * TD-97 统一证据语义（SSOT）。
 *
 * 背景：WAO 曾有三套独立的证据判定——scorecard（completed 路径）、
 * _auditEvidenceOnFailure（failed 路径）、diagnosis（事后分类）。它们各自检测
 * file_written/command/assistant text，但判据不完全一致，长期会造成信任模型漂移。
 * 本模块是唯一的事实评估函数，三处都应读它的输出。
 *
 * 设计约束：
 *   - 只输出事实（hasFileWritten/count/...），绝不输出建议或处方（同 diagnosis 铁律）
 *   - 兼容三种 message 形状（见下 _isAssistantMessage），因为调用方输入来源不同
 *   - 纯函数，无 I/O，无副作用，可安全在任何上下文调用
 *
 * 三种输入形状（必须全兼容）：
 *   1. transcript 落盘：{ type:"run.event", kind:"message", role:"assistant", parts }
 *   2. scorecard 临时：  { type:"run.message", role:"assistant", parts }（不落盘，scorecard 构造）
 *   3. runManager 内存：  { info:{ role:"assistant" }, parts }（waitForCompletion 累积）
 *
 * @module runEvidenceAssessment
 */

/**
 * 从事件数组计算统一证据事实。
 *
 * @param {object[]} events — 事件数组（transcript 落盘 / scorecard 临时 / runManager 内存均可）
 * @returns {{
 *   hasFileWritten: boolean,
 *   hasCommandExit0: boolean,
 *   hasAssistantText: boolean,
 *   hasToolUse: boolean,
 *   hasAnyEvidence: boolean,
 *   fileWrittenCount: number,
 *   commandExit0Count: number,
 *   assistantTextCount: number,
 *   evidenceEventCount: number,
 * }}
 */
export function assessRunEvidence(events) {
  const evs = Array.isArray(events) ? events : [];

  const fileWrittenEvents = evs.filter((e) => _isEvidenceKind(e, "file_written"));
  const commandEvents = evs.filter((e) => _isEvidenceKind(e, "command"));
  const commandExit0Events = commandEvents.filter((e) => e.exitCode === 0);
  const toolUseEvents = evs.filter((e) => _isEvidenceKind(e, "tool_use"));
  const assistantMessages = evs.filter((e) => _isAssistantMessage(e) && _hasNonEmptyTextPart(e.parts));

  // hasAnyEvidence:有任意证据类 run.event（command/file_written/tool_use/tool_result）
  const evidenceKinds = new Set(["command", "file_written", "tool_use", "tool_result"]);
  const evidenceEvents = evs.filter((e) => _isEvidenceKind(e, null) && evidenceKinds.has(e.kind));
  const evidenceEventCount = evidenceEvents.length;

  // activityEventCount:所有 run.event 活动事件数（含 message）。
  // 比 evidenceEventCount 宽——message 算活动但不算 evidence（scorecard requireEvidence 不计 message）。
  // diagnosis no_effect 用这个字段描述"worker 有多少活动"，避免 message-only case 文案写"0 条活动"。
  const activityKinds = new Set(["command", "file_written", "tool_use", "tool_result", "message"]);
  const activityEventCount = evs.filter((e) => _isEvidenceKind(e, null) && activityKinds.has(e.kind)).length;

  return {
    hasFileWritten: fileWrittenEvents.length > 0,
    hasCommandExit0: commandExit0Events.length > 0,
    hasAssistantText: assistantMessages.length > 0,
    hasToolUse: toolUseEvents.length > 0,
    hasAnyEvidence: evidenceEventCount > 0,
    fileWrittenCount: fileWrittenEvents.length,
    commandExit0Count: commandExit0Events.length,
    assistantTextCount: assistantMessages.length,
    evidenceEventCount,
    activityEventCount,
  };
}

// ---------------------------------------------------------------------------
// 内部归一化 helpers
// ---------------------------------------------------------------------------

/**
 * 判断事件是否是 evidence 类（type==="run.event" 或内存形状 { kind }）。
 * kind 参数可选——传 null 时只判"是不是 evidence 事件"，不判具体 kind。
 */
function _isEvidenceKind(e, kind) {
  if (!e) return false;
  // transcript 落盘形状：type === "run.event"
  // runManager 内存形状：无 type 字段，直接有 kind（RunEvent 解构前的形状）
  const isEvidence = e.type === "run.event" || (e.kind && e.type === undefined);
  if (!isEvidence) return false;
  if (kind === null) return true;
  return e.kind === kind;
}

/**
 * 判断事件是否是 assistant message（兼容三种形状）。
 *   1. { type:"run.event", kind:"message", role:"assistant" }  — transcript 落盘
 *   2. { type:"run.message", role:"assistant" }                — scorecard 临时
 *   3. { info:{ role:"assistant" } }                           — runManager 内存
 */
function _isAssistantMessage(e) {
  if (!e) return false;
  // 形状 1：transcript 落盘 run.event kind=message
  if (e.type === "run.event" && e.kind === "message") {
    return e.role === "assistant";
  }
  // 形状 2：scorecard 临时 run.message
  if (e.type === "run.message") {
    return e.role === "assistant";
  }
  // 形状 3：runManager 内存 { info: { role } }
  if (e.info && typeof e.info === "object") {
    return e.info.role === "assistant";
  }
  return false;
}

/**
 * parts 数组中是否有非空 text part。
 * 空白 text（"   "）、非 text part（tool/step-start）、空数组都算 false。
 */
function _hasNonEmptyTextPart(parts) {
  if (!Array.isArray(parts)) return false;
  return parts.some((p) => p?.type === "text" && typeof p.text === "string" && p.text.trim().length > 0);
}
