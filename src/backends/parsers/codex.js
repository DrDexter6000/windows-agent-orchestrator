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
 *   type:"error"        + message                            → 不 emit；记下过程报错的原话供失败兜底
 *   type:"turn.failed"  + error.message                      → 不 emit；记下本轮终局的原话供失败兜底
 *   type:"item.started" / "item.completed"                   → 照常翻译；顺带清掉过程报错的原话
 *   type:"turn.started" / "turn.completed"                   → 照常翻译；顺带清掉全部失败原话
 *   其它                                                      → 忽略
 *
 * 自报失败（额度到顶、上游拒绝等）：原因原话只在这两种帧里，stderr 往往只有常规提示
 * （"Reading additional input from stdin..."）。原话经 failureReason() 交给 ProcessBackend
 * 的退出兜底，拼进 run.error(phase:wait)。不 emit 事件：现有 RunEvent 种类都不能承载
 * provider 错误原文而不改变语义——message 会被读成 worker 产出并算作可用产出，
 * runtime_activity 是无载荷闭集——故事件流形状不变。
 *
 * 两种原话分开记：turn.failed 是本轮的终局，只在新一轮开始（turn.started）或本轮完成
 * （turn.completed）时清掉——同一轮失败收尾之后到达的 item.* 帧（例如失败命令的完成帧）
 * 不会把它清掉；type:error 是过程中的报错（可能随后重试恢复），之后任何推进帧都清掉它，
 * 它只在"报错之后再无进展就退出"时才算退出原因。两者都在时以本轮终局为准。
 *
 * 原话不在解析器里截断：脱敏按完整密钥值整段匹配，任何在脱敏之前的截断都会把跨在截断
 * 点上的值切碎、前缀原样漏出，而脱敏把前面的值换成标记后，残留前缀还可能挪进可见范围
 * （secretRedaction.js 记过同类教训）。这一行已经整行缓冲并解析过，多记一份原话不改变
 * 内存量级；有界截断只由 ProcessBackend 在脱敏之后做（保留开头）。
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

// 只做换行归一与去首尾空白，不截断（理由见类注释）。
function normalizeFailureMessage(message) {
  return message.replace(/\r\n/g, "\n").trim();
}

export class CodexStreamParser extends LineStreamParser {
  constructor() {
    super();
    // 自报失败原话（没有则为 null）：turnFailure 是本轮终局（turn.failed），
    // transientError 是过程报错（type:error）。不进事件流：只在进程非零退出、
    // 解析器没产出 done 时由 ProcessBackend 的失败兜底读出。
    this.turnFailure = null;
    this.transientError = null;
  }

  /** 自报失败原话，本轮终局优先（可选接口，见 LineStreamParser#failureReason）。 */
  failureReason() {
    return this.turnFailure ?? this.transientError;
  }

  handleLine(obj) {
    // provider 会话复用（2026-09-21）：codex 在**第一帧**广告 thread id，resume 时
    // 回显同一个 id。只捕获、不 emit——事件流保持逐字节不变。
    if (obj.type === "thread.started" && typeof obj.thread_id === "string" && obj.thread_id.length > 0) {
      this.providerSessionId = obj.thread_id;
      return [];
    }
    // 自报失败帧：按种类记下原话（同种后到的覆盖先到的），不 emit 事件。
    if (obj.type === "error" || obj.type === "turn.failed") {
      const message = obj.type === "error" ? obj.message : obj.error?.message;
      if (typeof message === "string" && message.trim().length > 0) {
        const reason = { runtime: "codex", message: normalizeFailureMessage(message) };
        if (obj.type === "turn.failed") this.turnFailure = reason;
        else this.transientError = reason;
      }
      return [];
    }
    // 推进帧（事件流本身照常翻译）：新一轮开始或本轮完成，之前的失败原话都已陈旧；
    // 轮内的 item.* 只说明过程报错之后又有进展，不推翻本轮终局。
    if (obj.type === "turn.started" || obj.type === "turn.completed") {
      this.turnFailure = null;
      this.transientError = null;
    } else if (obj.type === "item.started" || obj.type === "item.completed") {
      this.transientError = null;
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
