import { LineStreamParser } from "./lineStream.js";
import {
  messageEvent,
  doneEvent,
  metricsEvent,
  commandEvent,
  fileWrittenEvent,
  writeIntentEvent,
  toolUseEvent,
  toolResultEvent,
  thinkingEvent,
  runtimeActivityEvent,
  WRITE_INTENT_CORRELATION_STATUS,
} from "../../runEvent.js";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const MAX_PENDING_WRITE_INTENTS = 256;
const UNKNOWN_TOOL_CALL_ID = "unknown";
const STREAM_ACTIVITY_SAMPLE_INTERVAL = 64;

// 决定 0114：续修目标会话在 provider 侧不存在（真实样本：result 事件的 errors
// 里有 "No conversation found with session ID: <uuid>"，subtype=error_during_
// execution，0 token）。错误文本必须是固定句——provider 原文含 opaque uuid，
// 绝不能进转录或 MCP 输出。诊断按这个固定前缀把它归成具名原因（见 diagnosis.js）。
export const PROVIDER_SESSION_NOT_FOUND_ERROR =
  "provider session not found: the provider has no record of the resumed conversation";
const NO_CONVERSATION_FOUND_MARKER = "No conversation found with session ID";

// 只有出错帧才允许进入"会话不存在"收口：success 的正文/errors 无论写了什么，
// 都照常按成功路径处理（会审 opus 反例：success result 正文提到这句原文时被
// 误判成失败）。出错帧判定沿用 CLI 自己的字段。
function isErrorResultFrame(obj) {
  return obj?.is_error === true
    || (typeof obj?.subtype === "string" && obj.subtype.startsWith("error"));
}

function resultReportsMissingProviderSession(obj) {
  if (!isErrorResultFrame(obj)) return false;
  const texts = [];
  if (Array.isArray(obj.errors)) {
    for (const error of obj.errors) {
      if (typeof error === "string") texts.push(error);
      else if (typeof error?.message === "string") texts.push(error.message);
    }
  }
  // 出错帧的 result.result 也可能是同一句（不同 CLI 版本把原话放这里）；同样按
  // 固定句收口，避免任何路径把 uuid 带进转录。
  if (typeof obj.result === "string") texts.push(obj.result);
  return texts.some((text) => text.includes(NO_CONVERSATION_FOUND_MARKER));
}

/**
 * Claude Code stream-json 解析器（M2-3，M4 加 token 提取，M6-3 加证据链）。
 *
 * 翻译规则：
 *   type:"assistant" + content 含 text 块     → messageEvent("assistant", text块们)
 *   type:"assistant" + content 含 tool_use 块 → 证据事件（见 extractToolUse）
 *   type:"user" + content 含 tool_result 块   → toolResultEvent（证据链用）
 *   type:"result" + success                   → metricsEvent(usage) + doneEvent("completed");
 *                                              if non-blank result.result carries the final
 *                                              answer and no identical assistant text was
 *                                              streamed, emit one assistant message first
 *                                              (M12-21 completed-empty recovery)
 *   type:"result" + 出错帧（is_error 或 subtype 以 error 开头）的 errors/result
 *                                              含 No conversation found with session ID
 *                                             → metricsEvent(usage) + doneEvent("failed",
 *                                              PROVIDER_SESSION_NOT_FOUND_ERROR)——固定句，
 *                                              不回显 provider 原文里的 opaque uuid（0114）
 *   type:"result" + error                     → metricsEvent(usage) + doneEvent("failed")
 *   system init/api_retry                     → payload-free runtime activity
 *   stream_event                              → sampled payload-free activity
 *   其它 system/rate_limit                    → 忽略
 *
 * assistant 消息可能同时含 text + tool_use：message 和证据事件都 emit。
 * 顺序：先 message（text），后证据（tool_use），与 content 块顺序无关——
 * 因为 text 是产出，tool_use 是动作，text 在前更符合"先说再做"的阅读直觉。
 */
export class ClaudeStreamParser extends LineStreamParser {
  constructor() {
    super();
    // TD-12：claude-code stream-json 偶发重发同一 message.id 的 assistant 行。
    // 按 id 去重，避免 transcript 重复 message + scorecard 计数偏高。
    // 每个 run 独立 parser 实例（见 ProcessBackend），故 Set 生命周期 = 单 run。
    this._seenMessageIds = new Set();
    // M12-4B: runtime-specific write confirmation correlation. Map insertion
    // order plus a fixed cap makes memory use bounded and deterministic.
    this._pendingWrites = new Map();
    this._streamActivityCount = 0;
    // M12-21: completed-empty truth — result.result fallback dedupe. A provider
    // runtime may deliver the worker's final answer ONLY in the terminal
    // `result.result` field (no streamed assistant text). To recover it without
    // duplicating an already-streamed identical answer, record the joined text
    // of every emitted assistant message and skip a result fallback whose text
    // is identical. Bounded: one entry per assistant message in this run.
    this._emittedAssistantTexts = new Set();
    // 第一个请求的用量：第一条 assistant 消息的 message.usage（每个 assistant
    // 消息对应一次模型请求；input/cache_read 是分开的计数，input 不含缓存）。
    // 只看第一条 assistant 行，后面的请求不覆盖。
    this._firstRequest = null;
    this._firstRequestSeen = false;
  }

  /**
   * 可选接口（ProcessBackend 的非零退出兜底路径调用）：CLI 没发 result 帧、只把
   * "No conversation found with session ID: <uuid>" 写进 stderr 后非零退出时，
   * run.error 必须用同一固定句收口——stderr 尾部里的 uuid 绝不进转录。
   * 返回 null 时退出文案与既有逻辑逐字相同。
   */
  exitFailureText({ stderr = "", stdout = "" } = {}) {
    for (const text of [stderr, stdout]) {
      if (typeof text === "string" && text.includes(NO_CONVERSATION_FOUND_MARKER)) {
        return PROVIDER_SESSION_NOT_FOUND_ERROR;
      }
    }
    return null;
  }

  handleLine(obj) {
    if (obj.type === "system") {
      if (obj.subtype === "init") return [runtimeActivityEvent("initialized")];
      if (obj.subtype === "api_retry") return [runtimeActivityEvent("provider_retry")];
      return [];
    }
    if (obj.type === "stream_event") {
      this._streamActivityCount += 1;
      if (this._streamActivityCount === 1
        || this._streamActivityCount % STREAM_ACTIVITY_SAMPLE_INTERVAL === 0) {
        return [runtimeActivityEvent("streaming")];
      }
      return [];
    }
    if (obj.type === "assistant") {
      const content = obj.message?.content;
      if (!Array.isArray(content)) return [];
      // 首个请求用量（见构造函数注释）。usage 在 message.usage；只记上游报出
      // 的 input_tokens 与 cache_read_input_tokens。
      if (!this._firstRequestSeen) {
        this._firstRequestSeen = true;
        const usage = obj.message?.usage;
        if (usage && typeof usage === "object") {
          const firstRequest = {};
          if (typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)) {
            firstRequest.input = usage.input_tokens;
          }
          if (typeof usage.cache_read_input_tokens === "number"
            && Number.isFinite(usage.cache_read_input_tokens)) {
            firstRequest.cacheRead = usage.cache_read_input_tokens;
          }
          if (Object.keys(firstRequest).length > 0) this._firstRequest = firstRequest;
        }
      }
      // TD-12 去重（回归修复 2026-06-24）：原实现按 message.id 去重，但 claude-code 对
      // 同一 message 的 thinking 块和 text 块分两条 stream-json 行发出，共享同一 message.id。
      // 仅按 id 去重会误杀 text 行（content 不同但 id 相同）→ assistant text 全丢。
      // 现按 (id + content 签名) 去重：只有字面完全相同的重发行才跳过。
      const msgId = obj.message?.id;
      if (msgId) {
        const sig = msgId + "|" + JSON.stringify(content);
        if (this._seenMessageIds.has(sig)) return [];
        this._seenMessageIds.add(sig);
      }
      const events = [];
      const textParts = content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => ({ type: "text", text: c.text }));
      if (textParts.length > 0) {
        events.push(messageEvent("assistant", textParts));
        // M12-21: record the streamed answer so a terminal result.result that
        // merely repeats it is not emitted again (exact-text dedupe).
        this._emittedAssistantTexts.add(textParts.map((p) => p.text).join(""));
      }
      for (const block of content) {
        if (block.type === "tool_use") {
          const ev = extractToolUse(block, this._pendingWrites);
          if (ev) events.push(ev);
        }
        // TD-76 thinking 信号（方案 A：只记存在不存内容）：见 thinking 块即 emit 心跳事件，
        // 让 worker 思考期间心跳持续（消除"思考假死"→ provider_disconnect 误判）。
        // claude-code 实测（GLM-5.2 网关）：thinking 和 text 分两条 assistant 行（共享 message.id），
        // thinking 行 content 只有 [{type:"thinking",thinking,signature}]。原 filter 只取 text →
        // thinking 行产出 0 事件 → transcript 假死。现捕获，不存内容（Lead 只需知"在思考"）。
        if (block.type === "thinking") {
          events.push(thinkingEvent());
        }
      }
      return events;
    }
    if (obj.type === "user") {
      const content = obj.message?.content;
      if (!Array.isArray(content)) return [];
      const events = [];
      for (const block of content) {
        if (block.type === "tool_result") {
          const toolCallId = normalizeToolCallId(block.tool_use_id);
          const pendingPath = this._pendingWrites.get(toolCallId);
          const hasPendingWrite = pendingPath !== undefined;
          const isError = Boolean(block.is_error);
          if (hasPendingWrite) {
            // First matching result wins, including malformed results. Removing
            // before confirmation makes duplicate results idempotent.
            this._pendingWrites.delete(toolCallId);
          }
          events.push(toolResultEvent(toolCallId, block.content, isError));
          if (hasPendingWrite && !isError) {
            events.push(fileWrittenEvent(pendingPath, { toolCallId }));
          }
        }
      }
      return events;
    }
    if (obj.type === "result") {
      const events = [];
      // 提取 token usage（M4）
      const u = obj.usage;
      if (u) {
        const metrics = metricsEvent({
          input: u.input_tokens,
          output: u.output_tokens,
          cacheRead: u.cache_read_input_tokens,
          cacheWrite: u.cache_creation_input_tokens,
          costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined,
        });
        if (this._firstRequest) metrics.firstRequest = this._firstRequest;
        events.push(metrics);
      }
      // 决定 0114：续修目标会话不存在——只在出错帧（is_error 或 subtype 以 error
      // 开头）且带这句原文时用固定句收口（provider 原话里的 opaque uuid 绝不进
      // 转录）；success 帧无论正文写了什么都照常成功。
      if (resultReportsMissingProviderSession(obj)) {
        events.push(doneEvent("failed", PROVIDER_SESSION_NOT_FOUND_ERROR));
        return events;
      }
      if (obj.is_error || obj.subtype === "error") {
        events.push(doneEvent("failed", obj.result ?? obj.subtype ?? "claude error"));
      } else {
        // M12-21: completed-empty truth — recover a final answer that the
        // provider delivered ONLY in the terminal result.result field (no
        // streamed assistant text). Without this recovery the answer is lost
        // and the run looks empty, letting a Lead mistake real output for a
        // completed-empty worker. Emit exactly one assistant message before
        // done, and only when the text is non-blank and not identical to text
        // already streamed (exact dedupe). Normal metrics/done are preserved.
        const resultText = typeof obj.result === "string" ? obj.result : "";
        if (resultText.trim() && !this._emittedAssistantTexts.has(resultText)) {
          events.push(messageEvent("assistant", [{ type: "text", text: resultText }]));
          this._emittedAssistantTexts.add(resultText);
        }
        events.push(doneEvent("completed"));
      }
      return events;
    }
    return [];
  }
}

/**
 * 从 claude 的 tool_use 块提取证据事件（M6-3）。
 * - Bash/PowerShell/Cmd → commandEvent（含 command 文本）
 *   （Windows 上 claude-code 暴露 PowerShell/Cmd 而非 Bash，input.command 字段相同。
 *    2026-06-24 实测：原只认 Bash → PowerShell 命令掉到通用 toolUse → commandsPassed 永远
 *    认证失败 → 误判 DeepSeek/GLM 不会跑命令。现三类命令工具都识别。）
 * - Write/Edit/MultiEdit → writeIntentEvent（含 path + opaque toolCallId）
 * - 其它 → toolUseEvent（通用）
 * 字段缺失时返回 null（静默忽略，不崩）。
 */
const COMMAND_TOOLS = new Set(["Bash", "PowerShell", "Cmd"]);

function extractToolUse(block, pendingWrites) {
  const name = block.name;
  const input = block.input ?? {};
  if (COMMAND_TOOLS.has(name)) {
    if (typeof input.command === "string") {
      return commandEvent(input.command, undefined, { toolCallId: block.id });
    }
    return null;
  }
  if (WRITE_TOOLS.has(name)) {
    if (typeof input.file_path === "string") {
      const toolCallId = normalizeToolCallId(block.id);
      let correlationStatus;
      if (toolCallId === UNKNOWN_TOOL_CALL_ID) {
        correlationStatus = WRITE_INTENT_CORRELATION_STATUS.MISSING_TOOL_CALL_ID;
      } else if (pendingWrites.has(toolCallId)) {
        correlationStatus = WRITE_INTENT_CORRELATION_STATUS.DUPLICATE_TOOL_CALL_ID;
      } else if (pendingWrites.size >= MAX_PENDING_WRITE_INTENTS) {
        correlationStatus = WRITE_INTENT_CORRELATION_STATUS.PENDING_LIMIT;
      } else {
        pendingWrites.set(toolCallId, input.file_path);
        correlationStatus = WRITE_INTENT_CORRELATION_STATUS.TRACKED;
      }
      return writeIntentEvent(input.file_path, toolCallId, correlationStatus);
    }
    return null;
  }
  return toolUseEvent(name ?? "unknown", input);
}

function normalizeToolCallId(value) {
  return typeof value === "string"
    && value.length > 0
    && value !== UNKNOWN_TOOL_CALL_ID
    ? value
    : UNKNOWN_TOOL_CALL_ID;
}
