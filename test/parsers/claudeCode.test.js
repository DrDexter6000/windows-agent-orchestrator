import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeStreamParser } from "../../src/backends/parsers/claudeCode.js";
import { commandEvent, fileWrittenEvent, toolUseEvent, toolResultEvent } from "../../src/runEvent.js";

// 真实 claude stream-json 样本（基于实测，已精简到关键字段）
const CLAUDE_SAMPLE = [
  // system init（应被忽略）
  '{"type":"system","subtype":"init","session_id":"abc","model":"claude-3-5"}',
  // assistant 消息，含 thinking + text（只应取 text）
  '{"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"thinking","thinking":"let me think"},{"type":"text","text":"Hello!"}]}}',
  // result 成功（应 emit done completed）
  '{"type":"result","subtype":"success","is_error":false,"result":"Hello!","session_id":"abc"}',
].join("\n");

test("claude 样本：emit message(assistant text) + thinking + done(completed)", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(CLAUDE_SAMPLE + "\n");
  // TD-76：thinking 块现 emit 心跳事件（不存内容）。parser 先 emit message（text 循环），
  // 再 emit thinking（block 循环）——顺序 message,thinking,done（不影响心跳语义）。
  assert.equal(events.length, 3);
  assert.equal(events[0].kind, "message");
  assert.equal(events[0].role, "assistant");
  assert.deepEqual(events[0].parts, [{ type: "text", text: "Hello!" }]);
  assert.equal(events[1].kind, "thinking");
  assert.equal(events[2].kind, "done");
  assert.equal(events[2].reason, "completed");
});

test("TD-76: thinking 块 emit 心跳事件（不存内容），text 仍取", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"inner"},{"type":"text","text":"outer"}]}}\n',
  );
  // thinking + text 同行 → message（取 text，先）+ thinking 事件（不存内容，后）
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "message");
  assert.equal(events[0].parts[0].text, "outer");
  assert.equal(events[1].kind, "thinking");
  assert.ok(!("thinking" in events[1]), "thinking 事件不存内容（方案 A）");
});

test("assistant 多个 text 块都 emit", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"text","text":"part1"},{"type":"text","text":"part2"}]}}\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].parts.length, 2);
  assert.equal(events[0].parts[0].text, "part1");
  assert.equal(events[0].parts[1].text, "part2");
});

test("TD-12 回归修复: 同 message.id 的 thinking 行与 text 行都必须保留（非重发）", () => {
  // 真实 claude-code stream-json：同一条 assistant message 的 thinking 块和 text 块
  // 分两条到达，共享同一 message.id（实测 DeepSeek via wrapper 捕获，2026-06-24）。
  // 早期 TD-12 去重误把同 id 的第二条（text）当重发丢弃 → assistant text 全丢 →
  // 认证 hasAssistantText 失败 + 真实任务输出空。
  // 修复后：去重只针对"字面完全相同的行"，thinking/text 不同 content 不丢。
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"thinking","thinking":"let me think"}]}}\n'
    + '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"PONG"}]}}\n',
  );
  const messages = events.filter((e) => e.kind === "message");
  assert.equal(messages.length, 1, "text 行应 emit 为 message");
  assert.equal(messages[0].parts[0].text, "PONG", "text 内容必须保留（thinking 行的 id 相同不得误杀）");
});

test("TD-12: 真正的字面重发（同 id + 同 content）仍去重", () => {
  // 真重发：两条完全一样的 text 行（同 id + 同 text）。这种才该去重。
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"id":"msg_dup","content":[{"type":"text","text":"same"}]}}\n'
    + '{"type":"assistant","message":{"id":"msg_dup","content":[{"type":"text","text":"same"}]}}\n',
  );
  const messages = events.filter((e) => e.kind === "message");
  assert.equal(messages.length, 1, "完全相同的重发行应去重");
});

test("TD-12: 不同 message.id 的 assistant 行各自 emit（去重不误伤）", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"id":"msg_a","content":[{"type":"text","text":"a"}]}}\n'
    + '{"type":"assistant","message":{"id":"msg_b","content":[{"type":"text","text":"b"}]}}\n',
  );
  const messages = events.filter((e) => e.kind === "message");
  assert.equal(messages.length, 2, "不同 message.id 应各自 emit");
});

test("TD-12: 无 message.id 的 assistant 行不去重（向后兼容）", () => {
  // 旧格式/部分场景可能无 id，此时不得因去重逻辑丢消息。
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"text","text":"no-id-1"}]}}\n'
    + '{"type":"assistant","message":{"content":[{"type":"text","text":"no-id-2"}]}}\n',
  );
  const messages = events.filter((e) => e.kind === "message");
  assert.equal(messages.length, 2, "无 message.id 的行不应被去重");
});

test("result is_error=true → done(failed)", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"result","subtype":"error","is_error":true,"result":"boom"}\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "done");
  assert.equal(events[0].reason, "failed");
  assert.ok(events[0].error);
});

test("system/rate_limit 事件被忽略", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"system","subtype":"hook_started"}\n' +
    '{"type":"rate_limit_event","rate_limit_info":{}}\n',
  );
  assert.deepEqual(events, []);
});

test("TD-76: assistant 无 text 块（纯 thinking）emit thinking 心跳（非 message，非空）", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"only thinking"}]}}\n',
  );
  // TD-76：纯 thinking 行现 emit thinking 事件（心跳持续），不再产出空（消除思考假死）
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "thinking");
  assert.ok(!("thinking" in events[0]), "不存内容");
});

test("result 含 usage → emit metrics + done", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"result","subtype":"success","is_error":false,' +
    '"usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":10},' +
    '"total_cost_usd":0.02}\n',
  );
  // metrics 在 done 之前
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "metrics");
  assert.equal(events[0].tokens.input, 100);
  assert.equal(events[0].tokens.output, 50);
  assert.equal(events[0].tokens.reasoning, 10);
  assert.equal(events[0].costUsd, 0.02);
  assert.equal(events[1].kind, "done");
  assert.equal(events[1].reason, "completed");
});

test("result 无 usage → 只 emit done（不崩溃）", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed('{"type":"result","subtype":"success","is_error":false}\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "done");
});

// ===== M6-3: 证据链提取 =====

test("M6-3: Bash 工具 → command 事件，含 command 文本", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"npm test"}}]}}\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "command");
  assert.equal(events[0].command, "npm test");
  assert.equal(events[0].toolCallId, "tu_1");
  assert.ok(!("exitCode" in events[0]), "Bash 无退出码时不带 exitCode");
});

test("Windows 命令工具（PowerShell/Cmd）也 → command 事件（不只认 Bash）", () => {
  // 真实捕获（DeepSeek via claude-code，2026-06-24）：Windows 上 claude-code 暴露的是
  // PowerShell 工具而非 Bash，input 字段同为 command。原 parser 只认 name==="Bash"，
  // PowerShell 命令掉到通用 toolUse → commandsPassed 认证永远找不到命令 → 误判能力缺失。
  // 这是认证 draft-only 误判的根因（不是模型不会跑命令）。
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_ps","name":"PowerShell","input":{"command":"node --version","description":"Check Node version"}}]}}\n'
    + '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_cmd","name":"Cmd","input":{"command":"dir"}}]}}\n',
  );
  const cmds = events.filter((e) => e.kind === "command");
  assert.equal(cmds.length, 2, "PowerShell + Cmd 都应识别为 command 事件");
  assert.equal(cmds[0].command, "node --version", "PowerShell command 文本应保留");
  assert.equal(cmds[1].command, "dir", "Cmd command 文本应保留");
});

test("M6-3: Write 工具 → file_written 事件，含 path", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_2","name":"Write","input":{"file_path":"src/result.js","content":"x"}}]}}\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "file_written");
  assert.equal(events[0].path, "src/result.js");
});

test("M6-3: Edit / MultiEdit 工具 → file_written 事件", () => {
  const p = new ClaudeStreamParser();
  const events1 = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_3","name":"Edit","input":{"file_path":"a.js"}}]}}\n',
  );
  assert.equal(events1[0].kind, "file_written");
  assert.equal(events1[0].path, "a.js");

  p.flush();
  const events2 = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_4","name":"MultiEdit","input":{"file_path":"b.js"}}]}}\n',
  );
  assert.equal(events2[0].kind, "file_written");
  assert.equal(events2[0].path, "b.js");
});

test("M6-3: 其它工具（如 Grep）→ tool_use 事件", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_5","name":"Grep","input":{"pattern":"TODO"}}]}}\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "tool_use");
  assert.equal(events[0].tool, "Grep");
  assert.deepEqual(events[0].input, { pattern: "TODO" });
});

test("M6-3: text + tool_use 混合 → message + 证据都 emit，不丢", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"content":[' +
    '{"type":"text","text":"running tests"},' +
    '{"type":"tool_use","id":"tu_6","name":"Bash","input":{"command":"npm test"}}' +
    ']}}\n',
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "message");
  assert.equal(events[0].role, "assistant");
  assert.equal(events[1].kind, "command");
  assert.equal(events[1].command, "npm test");
});

test("M6-3: user 消息的 tool_result(is_error:true) → toolResultEvent", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"command not found","is_error":true}]}}\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "tool_result");
  assert.equal(events[0].tool, "tu_1");
  assert.equal(events[0].isError, true);
});

test("M6-3: user 消息的 tool_result(is_error:false) → toolResultEvent", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_2","content":"ok","is_error":false}]}}\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].isError, false);
});

test("M6-3: Bash 工具无 input.command 字段 → 忽略（不崩）", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_7","name":"Bash","input":{}}]}}\n',
  );
  assert.deepEqual(events, []);
});

test("M6-3: Write 工具无 file_path → 忽略（不崩）", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_8","name":"Write","input":{}}]}}\n',
  );
  assert.deepEqual(events, []);
});
