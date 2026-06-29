import { LineStreamParser } from "./lineStream.js";
import {
  messageEvent,
  commandEvent,
  fileWrittenEvent,
  toolUseEvent,
  toolResultEvent,
} from "../../runEvent.js";

/**
 * Kimi Code CLI stream-json 解析器（S2-1，阶段 2）。
 *
 * 格式来源：2026-06-23 实测 kimi 0.18.0 `-p --output-format stream-json`。
 * 和 claude-code 的嵌套 type 结构不同，kimi 是**扁平 role-based**：
 *
 *   {"role":"assistant","tool_calls":[{"type":"function","id":"...","function":{"name":"...","arguments":"<JSON字符串>"}}]}
 *   {"role":"tool","tool_call_id":"...","content":"<纯文本>"}
 *   {"role":"assistant","content":"<文本答案>"}
 *   {"role":"meta","type":"session.resume_hint",...}   ← 忽略
 *
 * 关键差异（vs claude-code）：
 *   1. function.arguments 是 JSON 字符串（需二次 parse），非对象
 *   2. tool result 是独立 role:"tool" 行，非 user content 内的 tool_result block
 *   3. 无显式 done/result 事件 → 不 emit done，靠 ProcessBackend 进程 exit 兜底
 *   4. 工具字段名：Read/Write 用 "path"（claude-code 用 "file_path"），Bash 用 "command"
 *   5. stderr 可能有非 JSON 直输（如版本号），LineStreamParser 已静默跳过
 *
 * 翻译规则：
 *   role:"assistant" + tool_calls → 遍历 tool_call：
 *     name "Bash" + args.command       → commandEvent(command)
 *     name "Write"/"Edit" + args.path  → fileWrittenEvent(path)
 *     其它                               → toolUseEvent(name, parsedArgs)
 *   role:"tool" + tool_call_id + content → toolResultEvent(id, content, isError)
 *     isError: content 含 "error"/"failed"(不区分大小写) 时 true，否则 false（kimi 不显式给 error 标志）
 *   role:"assistant" + content（无 tool_calls）→ messageEvent("assistant", text)
 *   role:"meta" → 忽略
 */
export class KimiStreamParser extends LineStreamParser {
  handleLine(obj) {
    if (obj.role === "assistant") {
      // 有 tool_calls → 证据事件（不 emit message；kimi 的 tool_call 行无 text content）
      if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
        const events = [];
        for (const call of obj.tool_calls) {
          const ev = extractToolCall(call);
          if (ev) events.push(ev);
        }
        return events;
      }
      // 无 tool_calls，有 content → message
      if (typeof obj.content === "string" && obj.content.length > 0) {
        return [messageEvent("assistant", [{ type: "text", text: obj.content }])];
      }
      return [];
    }
    if (obj.role === "tool") {
      const id = obj.tool_call_id ?? "unknown";
      const content = typeof obj.content === "string" ? obj.content : String(obj.content ?? "");
      const isError = /error|failed/i.test(content);
      return [toolResultEvent(id, content, isError)];
    }
    // role:"meta"（resume_hint 等）及其它未知 role → 忽略
    return [];
  }
}

/**
 * 从单个 tool_call 提取证据事件。
 * function.arguments 是 JSON 字符串，需二次 parse（parse 失败时用空对象降级）。
 */
function extractToolCall(call) {
  const fn = call?.function;
  if (!fn || typeof fn.name !== "string") return null;
  const name = fn.name;
  const parsedArgs = parseArgs(fn.arguments);
  const toolCallId = call.id;

  // Bash + command → commandEvent
  if (name === "Bash" && typeof parsedArgs.command === "string") {
    return commandEvent(parsedArgs.command, undefined, { toolCallId });
  }
  // Write/Edit + path → fileWrittenEvent（kimi 用 path 非 file_path）
  if ((name === "Write" || name === "Edit") && typeof parsedArgs.path === "string") {
    return fileWrittenEvent(parsedArgs.path);
  }
  // 其它工具 → toolUseEvent（降级，不崩）
  return toolUseEvent(name, parsedArgs);
}

/**
 * 解析 tool_call 的 arguments 字段。
 * kimi 把 arguments 序列化成 JSON 字符串（OpenAI function-call 风格），需二次 parse。
 * parse 失败 → 空对象（降级，避免崩整个流）。
 */
function parseArgs(raw) {
  if (typeof raw !== "string") {
    // 若已是对象（格式变化），直接用
    return typeof raw === "object" && raw !== null ? raw : {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
