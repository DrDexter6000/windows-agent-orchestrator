import { LineStreamParser } from "./lineStream.js";
import {
  messageEvent, doneEvent, metricsEvent, commandEvent, fileWrittenEvent, toolUseEvent, toolResultEvent,
} from "../../runEvent.js";

/**
 * Codex CLI --json 解析器（M2-4，M4 加 token 提取，M6-4 加证据链，file_change 提取 2026-06-24）。
 *
 * 翻译规则：
 *   type:"item.completed" + item.type:"agent_message"       → messageEvent("assistant", text)
 *   type:"item.started"   + item.type:"command_execution"   → toolUseEvent("shell", { command })（决定 0070）
 *   type:"item.completed" + item.type:"command_execution"   → commandEvent（证据链用）
 *                                                             + toolResultEvent("shell", aggregated_output)（决定 0070）
 *   type:"item.completed" + item.type:"file_change"         → fileWrittenEvent（每个非 delete change）
 *   type:"turn.completed"                                    → metricsEvent(usage) + doneEvent("completed")
 *   其它                                                      → 忽略
 *
 * command_execution 无论成败都 emit command 事件（供 scorecard 判 exitCode），
 * 但绝不 emit done(failed)——命令失败 ≠ run 失败（M2 已定），codex 可能继续运行。
 *
 * 决定 0070（2026-10-13，原始流实测）：命令开始帧（item.started，status:"in_progress"）已带
 * command——此前只认 item.completed，长命令在途的几分钟里转录是空的，Lead 看不到 worker
 * 在跑什么。现在开始时落一条 tool_use；结束帧的 aggregated_output 随 tool_result 落盘
 * （isError = 退出码非 0）。command 事件仍只在结束时落一次、带线上的退出码——证据计数里
 * command 的个数不变。
 *
 * file_change（2026-06-24 修复）：codex 写文件用 file_change item（不是 claude-code 的 Write tool）。
 * 原漏认 → filesExist 认证找不到 file_written → 误判 tester draft-only。现每个 add/edit change
 * emit 一个 fileWrittenEvent（path 保留绝对路径原样，供 scorecard 按文件名匹配）；delete 不算写入。
 */
const WRITE_KINDS = new Set(["add", "edit", "update", "create"]);

export class CodexStreamParser extends LineStreamParser {
  handleLine(obj) {
    // provider 会话复用（2026-09-21）：codex 在**第一帧**广告 thread id，resume 时
    // 回显同一个 id。只捕获、不 emit——事件流保持逐字节不变。
    if (obj.type === "thread.started" && typeof obj.thread_id === "string" && obj.thread_id.length > 0) {
      this.providerSessionId = obj.thread_id;
      return [];
    }
    if (obj.type === "item.started") {
      const item = obj.item;
      if (item?.type === "command_execution" && typeof item.command === "string") {
        return [toolUseEvent("shell", { command: item.command })];
      }
      return [];
    }
    if (obj.type === "item.completed") {
      const item = obj.item;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        return [messageEvent("assistant", [{ type: "text", text: item.text }])];
      }
      if (item?.type === "command_execution" && typeof item.command === "string") {
        const ev = commandEvent(item.command, typeof item.exit_code === "number" ? item.exit_code : undefined);
        if (typeof item.aggregated_output !== "string") return [ev];
        return [ev, toolResultEvent("shell", item.aggregated_output, typeof item.exit_code === "number" && item.exit_code !== 0)];
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
