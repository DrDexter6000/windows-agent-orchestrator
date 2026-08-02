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

/**
 * Claude Code stream-json 解析器（M2-3，M4 加 token 提取，M6-3 加证据链）。
 *
 * 翻译规则：
 *   type:"assistant" + content 含 text 块     → messageEvent("assistant", text块们)
 *   type:"assistant" + content 含 tool_use 块 → 证据事件（见 extractToolUse）
 *   type:"user" + content 含 tool_result 块   → toolResultEvent（证据链用）
 *   type:"result" + success                   → metricsEvent(usage) + doneEvent("completed")
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
        events.push(metricsEvent({
          input: u.input_tokens,
          output: u.output_tokens,
          cacheRead: u.cache_read_input_tokens,
          cacheWrite: u.cache_creation_input_tokens,
          costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined,
        }));
      }
      if (obj.is_error || obj.subtype === "error") {
        events.push(doneEvent("failed", obj.result ?? obj.subtype ?? "claude error"));
      } else {
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
