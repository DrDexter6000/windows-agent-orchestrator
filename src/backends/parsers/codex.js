import { LineStreamParser } from "./lineStream.js";
import { messageEvent, doneEvent, metricsEvent, commandEvent, fileWrittenEvent } from "../../runEvent.js";

/**
 * Codex CLI --json 解析器（M2-4，M4 加 token 提取，M6-4 加证据链，file_change 提取 2026-06-24）。
 *
 * 翻译规则：
 *   type:"item.completed" + item.type:"agent_message"       → messageEvent("assistant", text)
 *   type:"item.completed" + item.type:"command_execution"   → commandEvent（证据链用）
 *   type:"item.completed" + item.type:"file_change"         → fileWrittenEvent（每个非 delete change）
 *   type:"turn.completed"                                    → metricsEvent(usage) + doneEvent("completed")
 *   其它                                                      → 忽略
 *
 * command_execution 无论成败都 emit command 事件（供 scorecard 判 exitCode），
 * 但绝不 emit done(failed)——命令失败 ≠ run 失败（M2 已定），codex 可能继续运行。
 *
 * file_change（2026-06-24 修复）：codex 写文件用 file_change item（不是 claude-code 的 Write tool）。
 * 原漏认 → filesExist 认证找不到 file_written → 误判 tester draft-only。现每个 add/edit change
 * emit 一个 fileWrittenEvent（path 保留绝对路径原样，供 scorecard 按文件名匹配）；delete 不算写入。
 */
const WRITE_KINDS = new Set(["add", "edit", "update", "create"]);

export class CodexStreamParser extends LineStreamParser {
  handleLine(obj) {
    if (obj.type === "item.completed") {
      const item = obj.item;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        return [messageEvent("assistant", [{ type: "text", text: item.text }])];
      }
      if (item?.type === "command_execution" && typeof item.command === "string") {
        const ev = commandEvent(item.command, typeof item.exit_code === "number" ? item.exit_code : undefined);
        return [ev];
      }
      if (item?.type === "file_change" && Array.isArray(item.changes)) {
        const events = [];
        for (const ch of item.changes) {
          // 只记写入类（add/edit/create/update），delete 不算 file_written
          if (typeof ch.path === "string" && WRITE_KINDS.has(ch.kind)) {
            events.push(fileWrittenEvent(ch.path));
          }
        }
        return events;
      }
      return [];
    }
    if (obj.type === "turn.completed") {
      const events = [];
      const u = obj.usage;
      if (u) {
        events.push(metricsEvent({
          input: u.input_tokens,
          output: u.output_tokens,
          reasoning: u.reasoning_output_tokens,
        }));
      }
      events.push(doneEvent("completed"));
      return events;
    }
    return [];
  }
}
