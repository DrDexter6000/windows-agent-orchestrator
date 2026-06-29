import test from "node:test";
import assert from "node:assert/strict";
import { KimiStreamParser } from "../../src/backends/parsers/kimiCode.js";

// 真实 kimi stream-json 样本（基于 2026-06-23 实测 kimi 0.18.0，已精简到关键字段）
// 格式特征（和 claude-code 的嵌套 type 结构不同）：
//   - 扁平 role-based：{"role":"assistant","content/tool_calls":...}
//   - tool_call 的 function.arguments 是 JSON 字符串（需二次 parse）
//   - tool result 是独立行 {"role":"tool","tool_call_id":...,"content":...}
//   - 无显式 done 事件（靠进程 exit，parser 不 emit done）
//   - meta 行（resume_hint）忽略

test("S2-1: assistant + Bash tool_call → commandEvent", () => {
  const p = new KimiStreamParser();
  const events = p.feed(
    '{"role":"assistant","tool_calls":[{"type":"function","id":"tool_abc","function":{"name":"Bash","arguments":"{\\"command\\":\\"node --version\\"}"}}]}\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "command");
  assert.equal(events[0].command, "node --version");
});

test("S2-1: assistant + Write tool_call → fileWrittenEvent（用 path 非 file_path）", () => {
  const p = new KimiStreamParser();
  const events = p.feed(
    '{"role":"assistant","tool_calls":[{"type":"function","id":"tool_def","function":{"name":"Write","arguments":"{\\"path\\":\\"out.txt\\",\\"content\\":\\"PROBE\\"}"}}]}\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "file_written");
  assert.equal(events[0].path, "out.txt");
});

test("S2-1: tool result 行 → toolResultEvent（tool_call_id 关联）", () => {
  const p = new KimiStreamParser();
  const events = p.feed(
    '{"role":"tool","tool_call_id":"tool_abc","content":"v24.13.1\\r\\n"}\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "tool_result");
  assert.equal(events[0].tool, "tool_abc");
  assert.equal(events[0].isError, false);
});

test("S2-1: assistant + content（纯文本）→ messageEvent", () => {
  const p = new KimiStreamParser();
  const events = p.feed(
    '{"role":"assistant","content":"The package name is wao."}\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "message");
  assert.equal(events[0].role, "assistant");
  assert.deepEqual(events[0].parts, [{ type: "text", text: "The package name is wao." }]);
});

test("S2-1: meta 行（resume_hint）→ 忽略，不 emit 任何事件", () => {
  const p = new KimiStreamParser();
  const events = p.feed(
    '{"role":"meta","type":"session.resume_hint","session_id":"session_x","command":"kimi -r session_x","content":"To resume..."}\n',
  );
  assert.equal(events.length, 0);
});

test("S2-1: arguments 是 JSON 字符串 → 正确二次 parse", () => {
  const p = new KimiStreamParser();
  // arguments 内嵌 command 含空格，验证 JSON.parse 正确处理转义
  const events = p.feed(
    '{"role":"assistant","tool_calls":[{"type":"function","id":"t1","function":{"name":"Bash","arguments":"{\\"command\\":\\"npm test --verbose\\"}"}}]}\n',
  );
  assert.equal(events[0].kind, "command");
  assert.equal(events[0].command, "npm test --verbose");
});

test("S2-1: 非 JSON 噪音行（stderr 直输）→ 静默跳过", () => {
  const p = new KimiStreamParser();
  // kimi 流前可能有 stderr 直输（如 v24.13.1），不是合法 JSON
  const events = p.feed("v24.13.1\n{\"role\":\"assistant\",\"content\":\"done\"}\n");
  assert.equal(events.length, 1, "噪音行跳过，只 emit 1 个 message 事件");
  assert.equal(events[0].kind, "message");
});

test("S2-1: 完整多轮样本（Bash + result + 文本答案）→ 事件序列正确", () => {
  const p = new KimiStreamParser();
  const sample = [
    '{"role":"assistant","tool_calls":[{"type":"function","id":"tool_x","function":{"name":"Bash","arguments":"{\\"command\\":\\"node --version\\"}"}}]}',
    '{"role":"tool","tool_call_id":"tool_x","content":"v24.13.1\\r\\n"}',
    '{"role":"assistant","content":"Node version is v24.13.1."}',
    '{"role":"meta","type":"session.resume_hint","session_id":"s1","command":"kimi -r s1","content":"resume"}',
  ].join("\n") + "\n";
  const events = p.feed(sample);
  assert.equal(events.length, 3, "command + tool_result + message（meta 忽略）");
  assert.equal(events[0].kind, "command");
  assert.equal(events[0].command, "node --version");
  assert.equal(events[1].kind, "tool_result");
  assert.equal(events[1].tool, "tool_x");
  assert.equal(events[2].kind, "message");
  assert.equal(events[2].parts[0].text, "Node version is v24.13.1.");
});

test("S2-1: tool result content 含 error → isError=true", () => {
  const p = new KimiStreamParser();
  const events = p.feed(
    '{"role":"tool","tool_call_id":"tool_err","content":"Error: ENOENT no such file"}\n',
  );
  assert.equal(events[0].isError, true, "content 含 Error 应标 isError");
});

test("S2-1: 未知工具 → toolUseEvent（不崩，降级处理）", () => {
  const p = new KimiStreamParser();
  const events = p.feed(
    '{"role":"assistant","tool_calls":[{"type":"function","id":"t9","function":{"name":"SomeWeirdTool","arguments":"{\\"x\\":1}"}}]}\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "tool_use");
  assert.equal(events[0].tool, "SomeWeirdTool");
});

test("S2-1: 不 emit done 事件（靠进程 exit 兜底）", () => {
  const p = new KimiStreamParser();
  const events = p.feed('{"role":"assistant","content":"answer"}\n');
  const dones = events.filter((e) => e.kind === "done");
  assert.equal(dones.length, 0, "kimi parser 不 emit done（ProcessBackend 进程 exit 兜底）");
});
