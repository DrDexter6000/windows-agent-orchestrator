import test from "node:test";
import assert from "node:assert/strict";
import { CodexStreamParser } from "../../src/backends/parsers/codex.js";

// 真实 codex --json 样本（基于实测，含混入的非 JSON ERROR 行）
const CODEX_SAMPLE = [
  '{"type":"thread.started","thread_id":"019e"}',
  '{"type":"turn.started"}',
  // 混入的非 JSON 日志行（实测见到 windows sandbox 错误等）
  'ERROR codex_core::exec: windows sandbox: CreateProcessWithLogonW failed: 1326',
  'ERROR codex_core::tools::router: something',
  // agent 消息
  '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Hello from codex!"}}',
  // 命令执行失败（不应触发 done failed）
  '{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"npm test","exit_code":1,"status":"failed","aggregated_output":"test failed"}}',
  // turn 完成
  '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
].join("\n");

test("codex 样本：跳过 ERROR 行，emit message + command + metrics + done(completed)", () => {
  const p = new CodexStreamParser();
  const events = p.feed(CODEX_SAMPLE + "\n");
  // message + command(from command_execution) + metrics(from turn.completed usage) + done
  assert.equal(events.length, 4);
  assert.equal(events[0].kind, "message");
  assert.equal(events[0].role, "assistant");
  assert.equal(events[0].parts[0].text, "Hello from codex!");
  assert.equal(events[1].kind, "command");
  assert.equal(events[1].command, "npm test");
  assert.equal(events[1].exitCode, 1);
  assert.equal(events[2].kind, "metrics");
  assert.equal(events[2].tokens.input, 10);
  assert.equal(events[3].kind, "done");
  assert.equal(events[3].reason, "completed");
});

test("command_execution failed 不触发 done(failed)", () => {
  const p = new CodexStreamParser();
  const events = p.feed(
    '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"x","status":"failed","exit_code":1}}\n',
  );
  // M6-4 起命令失败也 emit command（证据链用，exitCode=1），但绝不 emit done(failed)
  // —— 命令失败 ≠ run 失败（M2 已定），codex 可能继续运行。
  assert.ok(!events.some((e) => e.kind === "done"), "must not emit done for command failure");
});

test("turn.completed → done(completed)", () => {
  const p = new CodexStreamParser();
  const events = p.feed('{"type":"turn.completed"}\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "done");
  assert.equal(events[0].reason, "completed");
});

test("item.started 被忽略", () => {
  const p = new CodexStreamParser();
  const events = p.feed(
    '{"type":"item.started","item":{"id":"x","type":"command_execution","status":"in_progress"}}\n',
  );
  assert.deepEqual(events, []);
});

test("无 turn.completed 时 flush 不假装 completed", () => {
  // 只喂 agent_message，不喂 turn.completed
  const p = new CodexStreamParser();
  p.feed('{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"hi"}}\n');
  const flushed = p.flush();
  // flush 不应补 done（进程退出码兜底是 ProcessBackend 的职责）
  assert.deepEqual(flushed, []);
});

test("多个 agent_message 都 emit", () => {
  const p = new CodexStreamParser();
  const events = p.feed(
    '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}\n' +
    '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}\n',
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].parts[0].text, "first");
  assert.equal(events[1].parts[0].text, "second");
});

test("turn.completed 含 usage → emit metrics + done", () => {
  const p = new CodexStreamParser();
  const events = p.feed(
    '{"type":"turn.completed","usage":{"input_tokens":200,"output_tokens":80,"reasoning_output_tokens":15}}\n',
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "metrics");
  assert.equal(events[0].tokens.input, 200);
  assert.equal(events[0].tokens.output, 80);
  assert.equal(events[0].tokens.reasoning, 15);
  assert.equal(events[1].kind, "done");
  assert.equal(events[1].reason, "completed");
});

test("turn.completed 无 usage → 只 emit done", () => {
  const p = new CodexStreamParser();
  const events = p.feed('{"type":"turn.completed"}\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "done");
});

// ===== M6-4: 证据链提取 =====

test("M6-4: command_execution → command 事件，含 command + exitCode", () => {
  const p = new CodexStreamParser();
  const events = p.feed(
    '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"npm test","exit_code":0,"status":"completed"}}\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "command");
  assert.equal(events[0].command, "npm test");
  assert.equal(events[0].exitCode, 0);
});

test("M6-4: command_execution 缺 exit_code（运行中）→ exitCode 字段省略", () => {
  const p = new CodexStreamParser();
  const events = p.feed(
    '{"type":"item.completed","item":{"id":"c2","type":"command_execution","command":"echo hi","status":"in_progress"}}\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "command");
  assert.equal(events[0].command, "echo hi");
  assert.ok(!("exitCode" in events[0]), "exitCode should be absent when missing");
});

test("M6-4: command_execution 失败(exit_code=1) → 仍 emit command（供 scorecard 判 exitCode≠0），不 emit done failed", () => {
  const p = new CodexStreamParser();
  const events = p.feed(
    '{"type":"item.completed","item":{"id":"c3","type":"command_execution","command":"npm test","exit_code":1,"status":"failed"}}\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "command");
  assert.equal(events[0].exitCode, 1);
  // 关键：命令失败 ≠ run 失败（M2 已定），codex 可能继续运行
  assert.ok(!events.some((e) => e.kind === "done"));
});

test("M6-4: command_execution 无 command 字段 → 忽略（不崩）", () => {
  const p = new CodexStreamParser();
  const events = p.feed(
    '{"type":"item.completed","item":{"id":"c4","type":"command_execution","exit_code":0}}\n',
  );
  assert.deepEqual(events, []);
});

test("file_change item → file_written 证据（codex 写文件的真实 item type）", () => {
  // 真实捕获（codex exec --json，2026-06-24）：codex 写文件用 file_change item，
  // 不是 claude-code 的 Write tool。原 parser 只认 agent_message/command_execution，
  // 漏认 file_change → filesExist 认证检查找不到 file_written → 误判 tester draft-only。
  // file_change 结构：{type:"file_change", changes:[{path, kind}], status}
  // path 是绝对路径（codex 输出绝对路径），需原样保留供 scorecard 匹配。
  const p = new CodexStreamParser();
  const events = p.feed(
    '{"type":"item.completed","item":{"id":"f1","type":"file_change","changes":[{"path":"D:\\\\proj\\\\wao_test.txt","kind":"add"}],"status":"completed"}}\n',
  );
  const fw = events.filter((e) => e.kind === "file_written");
  assert.equal(fw.length, 1, "file_change 应 emit file_written 事件");
  assert.match(fw[0].path, /wao_test\.txt$/, "file_written path 应含文件名");
});

test("file_change 多个 changes 都 emit（一次写多文件）", () => {
  const p = new CodexStreamParser();
  const events = p.feed(
    '{"type":"item.completed","item":{"id":"f2","type":"file_change","changes":[{"path":"/a/x.js","kind":"add"},{"path":"/b/y.js","kind":"edit"}],"status":"completed"}}\n',
  );
  const fw = events.filter((e) => e.kind === "file_written");
  assert.equal(fw.length, 2, "两个 changes 都应 emit file_written");
});

test("file_change kind=delete 不 emit file_written（只记写入）", () => {
  const p = new CodexStreamParser();
  const events = p.feed(
    '{"type":"item.completed","item":{"id":"f3","type":"file_change","changes":[{"path":"/a/old.txt","kind":"delete"}],"status":"completed"}}\n',
  );
  assert.ok(!events.some((e) => e.kind === "file_written"), "删除不应算 file_written");
});
