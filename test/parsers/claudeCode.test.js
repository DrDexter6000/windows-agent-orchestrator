import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeStreamParser } from "../../src/backends/parsers/claudeCode.js";
import { commandEvent, fileWrittenEvent, toolUseEvent, toolResultEvent } from "../../src/runEvent.js";

// 真实 claude stream-json 样本（基于实测，已精简到关键字段）
const CLAUDE_SAMPLE = [
  // system init（仅投影闭集状态，不泄漏 session/model）
  '{"type":"system","subtype":"init","session_id":"abc","model":"claude-3-5"}',
  // assistant 消息，含 thinking + text（只应取 text）
  '{"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"thinking","thinking":"let me think"},{"type":"text","text":"Hello!"}]}}',
  // result 成功（应 emit done completed）
  '{"type":"result","subtype":"success","is_error":false,"result":"Hello!","session_id":"abc"}',
].join("\n");

test("claude 样本：emit init + message(assistant text) + thinking + done(completed)", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(CLAUDE_SAMPLE + "\n");
  // TD-76：thinking 块现 emit 心跳事件（不存内容）。parser 先 emit message（text 循环），
  // 再 emit thinking（block 循环）——顺序 message,thinking,done（不影响心跳语义）。
  assert.equal(events.length, 4);
  assert.deepEqual(events[0], { kind: "runtime_activity", status: "initialized" });
  assert.equal(events[1].kind, "message");
  assert.equal(events[1].role, "assistant");
  assert.deepEqual(events[1].parts, [{ type: "text", text: "Hello!" }]);
  assert.equal(events[2].kind, "thinking");
  assert.equal(events[3].kind, "done");
  assert.equal(events[3].reason, "completed");
  assert.ok(!JSON.stringify(events[0]).includes("abc"), "session id never crosses the parser boundary");
  assert.ok(!JSON.stringify(events[0]).includes("claude-3-5"), "model id never crosses the parser boundary");
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

test("system/api_retry 投影为闭集 provider_retry，不泄漏错误或重试 payload", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"system","subtype":"api_retry","error":"SECRET_PROVIDER_ERROR","attempt":3,"delay_ms":9000}\n',
  );
  assert.deepEqual(events, [{ kind: "runtime_activity", status: "provider_retry" }]);
  assert.ok(!JSON.stringify(events).includes("SECRET_PROVIDER_ERROR"));
  assert.ok(!JSON.stringify(events).includes("9000"));
});

test("partial stream events are sampled into bounded payload-free streaming activity", () => {
  const p = new ClaudeStreamParser();
  const lines = [];
  for (let i = 0; i < 65; i += 1) {
    lines.push(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: `SECRET-${i}` } },
    }));
  }
  const events = p.feed(lines.join("\n") + "\n");
  assert.deepEqual(events, [
    { kind: "runtime_activity", status: "streaming" },
    { kind: "runtime_activity", status: "streaming" },
  ]);
  assert.ok(!JSON.stringify(events).includes("SECRET-"), "raw text deltas never cross the parser boundary");
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
    '"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":12,"cache_creation_input_tokens":10},' +
    '"total_cost_usd":0.02}\n',
  );
  // metrics 在 done 之前
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "metrics");
  assert.equal(events[0].tokens.input, 100);
  assert.equal(events[0].tokens.output, 50);
  assert.equal(events[0].tokens.cacheRead, 12);
  assert.equal(events[0].tokens.cacheWrite, 10);
  assert.equal(events[0].tokens.reasoning, undefined,
    "Claude cache creation tokens are not reasoning tokens");
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

test("M12-4B-A: Write 工具先发 write_intent，不提前发 file_written", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_2","name":"Write","input":{"file_path":"src/result.js","content":"x"}}]}}\n',
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    kind: "write_intent",
    path: "src/result.js",
    toolCallId: "tu_2",
    correlationStatus: "tracked",
  });
});

test("M12-4B-A: Edit / MultiEdit 工具先发 write_intent", () => {
  const p = new ClaudeStreamParser();
  const events1 = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_3","name":"Edit","input":{"file_path":"a.js"}}]}}\n',
  );
  assert.deepEqual(events1[0], {
    kind: "write_intent",
    path: "a.js",
    toolCallId: "tu_3",
    correlationStatus: "tracked",
  });

  p.flush();
  const events2 = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_4","name":"MultiEdit","input":{"file_path":"b.js"}}]}}\n',
  );
  assert.deepEqual(events2[0], {
    kind: "write_intent",
    path: "b.js",
    toolCallId: "tu_4",
    correlationStatus: "tracked",
  });
});

test("M12-4B-B: matching successful write result confirms file_written exactly once", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"write_ok","name":"Write","input":{"file_path":"src/new.js","content":"x"}}]}}\n'
    + '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"write_ok","content":"created","is_error":false}]}}\n'
    + '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"write_ok","content":"duplicate","is_error":false}]}}\n',
  );
  assert.deepEqual(events.map((event) => event.kind), [
    "write_intent",
    "tool_result",
    "file_written",
    "tool_result",
  ]);
  assert.deepEqual(
    events.filter((event) => event.kind === "file_written"),
    [{ kind: "file_written", path: "src/new.js", toolCallId: "write_ok" }],
  );
});

test("M12-4B-B: failed and mismatched results never confirm file_written", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"write_fail","name":"Write","input":{"file_path":"src/fail.js"}}]}}\n'
    + '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"unknown_id","content":"ok","is_error":false}]}}\n'
    + '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"write_fail","content":"denied","is_error":true}]}}\n',
  );
  assert.equal(events.filter((event) => event.kind === "file_written").length, 0);
  assert.equal(events.filter((event) => event.kind === "tool_result").length, 2);
});

test("M12-4B-B: omitted is_error preserves success compatibility and confirms exactly once", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"write_omitted","name":"Write","input":{"file_path":"src/omitted.js"}}]}}\n'
    + '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"write_omitted","content":"created"}]}}\n'
    + '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"write_omitted","content":"duplicate"}]}}\n',
  );
  assert.deepEqual(
    events.filter((event) => event.kind === "file_written"),
    [{ kind: "file_written", path: "src/omitted.js", toolCallId: "write_omitted" }],
  );
  assert.deepEqual(
    events.filter((event) => event.kind === "tool_result").map((event) => event.isError),
    [false, false],
  );
});

test("M12-4B-B: missing and duplicate call ids expose bounded unconfirmable statuses", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"missing.js"}}]}}\n'
    + '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"duplicate","name":"Write","input":{"file_path":"first.js"}}]}}\n'
    + '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"duplicate","name":"Edit","input":{"file_path":"second.js"}}]}}\n',
  );
  assert.deepEqual(
    events.map((event) => ({
      toolCallId: event.toolCallId,
      correlationStatus: event.correlationStatus,
    })),
    [
      { toolCallId: "unknown", correlationStatus: "missing_tool_call_id" },
      { toolCallId: "duplicate", correlationStatus: "tracked" },
      { toolCallId: "duplicate", correlationStatus: "duplicate_tool_call_id" },
    ],
  );
});

test("M12-4B-B: two open write intents correlate out of order", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"content":['
    + '{"type":"tool_use","id":"write_a","name":"Write","input":{"file_path":"a.js"}},'
    + '{"type":"tool_use","id":"write_b","name":"Edit","input":{"file_path":"b.js"}}'
    + ']}}\n'
    + '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"write_b","content":"ok","is_error":false}]}}\n'
    + '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"write_a","content":"ok","is_error":false}]}}\n',
  );
  assert.deepEqual(
    events.filter((event) => event.kind === "file_written").map((event) => ({
      path: event.path,
      toolCallId: event.toolCallId,
    })),
    [
      { path: "b.js", toolCallId: "write_b" },
      { path: "a.js", toolCallId: "write_a" },
    ],
  );
});

test("M12-4B-B: pending write correlation is capped at 256 entries", () => {
  const p = new ClaudeStreamParser();
  const intents = Array.from({ length: 257 }, (_, index) => (
    `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"write_${index}","name":"Write","input":{"file_path":"file_${index}.js"}}]}}`
  ));
  const results = Array.from({ length: 257 }, (_, index) => (
    `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"write_${index}","content":"ok","is_error":false}]}}`
  ));
  const events = p.feed(`${[...intents, ...results].join("\n")}\n`);
  const intentEvents = events.filter((event) => event.kind === "write_intent");
  assert.equal(intentEvents[255].correlationStatus, "tracked");
  assert.equal(intentEvents[256].correlationStatus, "pending_limit");
  const confirmed = events.filter((event) => event.kind === "file_written");
  assert.equal(confirmed.length, 256);
  assert.equal(confirmed[0].path, "file_0.js");
  assert.equal(confirmed[0].toolCallId, "write_0");
  assert.equal(confirmed.at(-1).path, "file_255.js");
  assert.equal(confirmed.at(-1).toolCallId, "write_255");
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

// ---------------------------------------------------------------------------
// M12-21: completed-empty truth — result.result fallback recovery.
//
// Production fact: a provider runtime may reach a successful `result` event
// carrying the worker's final answer ONLY in `result.result` (no streamed
// assistant text). Without recovery, that text is lost → the run looks empty
// → a Lead can mistake a worker that produced real output for completed-empty.
//
// Contract:
//   - On a successful result event with NON-BLANK `result.result` AND no
//     identical assistant text already emitted, emit EXACTLY ONE assistant
//     message BEFORE done(completed).
//   - If identical assistant text was already streamed, do NOT duplicate.
//   - Blank/whitespace-only `result.result` emits NO fallback message.
//   - Normal metrics/error/done are preserved.
// ---------------------------------------------------------------------------

test("M12-21: result success with non-blank result + no prior assistant → emit one assistant message before done", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"system","subtype":"init"}\n'
    + '{"type":"result","subtype":"success","is_error":false,"result":"final answer"}\n',
  );
  const messages = events.filter((e) => e.kind === "message");
  const doneIdx = events.findIndex((e) => e.kind === "done");
  const msgIdx = events.findIndex((e) => e.kind === "message");
  assert.equal(messages.length, 1, "exactly one fallback assistant message");
  assert.equal(messages[0].role, "assistant");
  assert.deepEqual(messages[0].parts, [{ type: "text", text: "final answer" }]);
  assert.ok(msgIdx !== -1 && doneIdx !== -1 && msgIdx < doneIdx, "fallback message precedes done");
});

test("M12-21: result with usage + non-blank result + no prior assistant → metrics then message then done", () => {
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"result","subtype":"success","is_error":false,' +
    '"usage":{"input_tokens":10,"output_tokens":5},' +
    '"result":"recovered"}\n',
  );
  assert.deepEqual(events.map((e) => e.kind), ["metrics", "message", "done"]);
  assert.equal(events[1].role, "assistant");
  assert.deepEqual(events[1].parts, [{ type: "text", text: "recovered" }]);
});

test("M12-21: result.result identical to already-streamed assistant text → NOT duplicated", () => {
  // The worker streamed "Hello!" then the result event repeats "Hello!".
  // The fallback must NOT emit a second assistant message.
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Hello!"}]}}\n'
    + '{"type":"result","subtype":"success","is_error":false,"result":"Hello!"}\n',
  );
  const messages = events.filter((e) => e.kind === "message");
  assert.equal(messages.length, 1, "identical result text must not duplicate the streamed message");
  assert.equal(messages[0].parts[0].text, "Hello!");
});

test("M12-21: blank / whitespace-only result.result → NO fallback assistant message", () => {
  const p = new ClaudeStreamParser();
  const blank = p.feed('{"type":"result","subtype":"success","is_error":false,"result":"   "}\n');
  assert.equal(blank.filter((e) => e.kind === "message").length, 0, "whitespace result emits no message");
  assert.equal(blank.at(-1).kind, "done");
  assert.equal(blank.at(-1).reason, "completed");

  const empty = p.feed('{"type":"result","subtype":"success","is_error":false,"result":""}\n');
  assert.equal(empty.filter((e) => e.kind === "message").length, 0, "empty result emits no message");

  const missing = p.feed('{"type":"result","subtype":"success","is_error":false}\n');
  assert.equal(missing.filter((e) => e.kind === "message").length, 0, "missing result emits no message");
});

test("M12-21: error result with result text → done(failed), NO fallback assistant message", () => {
  // The fallback is for SUCCESSFUL completions only. An error result must keep
  // routing to done(failed) and must not invent a recovered assistant message.
  const p = new ClaudeStreamParser();
  const events = p.feed(
    '{"type":"result","subtype":"error","is_error":true,"result":"boom details"}\n',
  );
  assert.equal(events.filter((e) => e.kind === "message").length, 0);
  assert.equal(events.at(-1).kind, "done");
  assert.equal(events.at(-1).reason, "failed");
});
