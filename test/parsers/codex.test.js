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

test("codex 样本：跳过 ERROR 行，emit message + command + tool_result + metrics + done(completed)", () => {
  const p = new CodexStreamParser();
  const events = p.feed(CODEX_SAMPLE + "\n");
  // message + command(from command_execution) + tool_result(its aggregated_output, 决定 0070)
  // + metrics(from turn.completed usage) + done
  assert.equal(events.length, 5);
  assert.equal(events[0].kind, "message");
  assert.equal(events[0].role, "assistant");
  assert.equal(events[0].parts[0].text, "Hello from codex!");
  assert.equal(events[1].kind, "command");
  assert.equal(events[1].command, "npm test");
  assert.equal(events[1].exitCode, 1);
  assert.deepEqual([events[2].kind, events[2].tool, events[2].output, events[2].isError], ["tool_result", "shell", "test failed", true]);
  assert.equal(events[3].kind, "metrics");
  assert.equal(events[3].tokens.input, 10);
  assert.equal(events[4].kind, "done");
  assert.equal(events[4].reason, "completed");
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

test("决定 0070: 命令开始帧带 command → 落 tool_use(shell)；结束帧的 aggregated_output 随 tool_result 落盘，command 仍只落一次", () => {
  const p = new CodexStreamParser();
  const started = p.feed(
    '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"npm test","aggregated_output":"","exit_code":null,"status":"in_progress"}}\n',
  );
  assert.deepEqual(started, [{ kind: "tool_use", tool: "shell", input: { command: "npm test" } }]);
  const ok = p.feed(
    '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"npm test","aggregated_output":"# pass 3\\n# fail 0\\n","exit_code":0,"status":"completed"}}\n',
  );
  assert.deepEqual(ok.map((e) => e.kind), ["command", "tool_result"]);
  assert.equal(ok[0].exitCode, 0);
  assert.deepEqual([ok[1].tool, ok[1].output, ok[1].isError], ["shell", "# pass 3\n# fail 0\n", false]);
  const failed = p.feed(
    '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"false","aggregated_output":"boom","exit_code":2,"status":"failed"}}\n',
  );
  assert.equal(failed[0].exitCode, 2);
  assert.equal(failed[1].isError, true);
  // 没有 aggregated_output 的结束帧：只落 command（与此前相同）。
  const bare = p.feed('{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"ls","exit_code":0}}\n');
  assert.deepEqual(bare.map((e) => e.kind), ["command"]);
  // 其它类型的开始帧仍忽略。
  assert.deepEqual(p.feed('{"type":"item.started","item":{"id":"m","type":"agent_message","text":""}}\n'), []);
});

test("item.started 不带 command 时被忽略", () => {
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

// ===== 自报失败原话（可选接口 failureReason）=====
// codex 失败时原因原话只在 stdout 的 JSON 里：type:"error" 的 message，或
// turn.failed 的 error.message；stderr 往往只有 "Reading additional input from
// stdin..." 这类常规提示。解析器把原话记下（不截断；本轮终局优先于过程报错），ProcessBackend
// 在非零退出兜底时读出并拼进 run.error。两种帧都不 emit 事件——事件流形状不变
// （现有 RunEvent 种类承载不了 provider 错误原文：message 会被读成 worker 产出）。

test("自报失败: type:error 记下 message，不 emit 事件", () => {
  const p = new CodexStreamParser();
  assert.equal(p.failureReason(), null, "没有失败帧时没有原话");
  const events = p.feed('{"type":"error","message":"You\'ve hit your usage limit. Try again at 1:38 AM."}\n');
  assert.deepEqual(events, [], "失败帧不产事件");
  assert.deepEqual(p.failureReason(), {
    runtime: "codex",
    message: "You've hit your usage limit. Try again at 1:38 AM.",
  });
});

test("自报失败: turn.failed 记下 error.message，不 emit 事件", () => {
  const p = new CodexStreamParser();
  const events = p.feed('{"type":"turn.failed","error":{"message":"stream error: upstream refused the turn"}}\n');
  assert.deepEqual(events, [], "失败帧不产事件");
  assert.deepEqual(p.failureReason(), {
    runtime: "codex",
    message: "stream error: upstream refused the turn",
  });
});

test("自报失败: 两种帧都来时以本轮终局为准", () => {
  const p = new CodexStreamParser();
  p.feed('{"type":"error","message":"first failure"}\n');
  assert.equal(p.failureReason().message, "first failure");
  p.feed('{"type":"turn.failed","error":{"message":"second failure"}}\n');
  assert.equal(p.failureReason().message, "second failure", "本轮终局优先于过程报错");
  p.feed('{"type":"error","message":"late transient"}\n');
  assert.equal(p.failureReason().message, "second failure", "终局之后的过程报错不覆盖终局");
});

test("自报失败: 解析器不按读者长度截短原话（脱敏需要完整密钥值）", () => {
  const p = new CodexStreamParser();
  const long = `head-marker ${"x".repeat(600)}`;
  p.feed(`${JSON.stringify({ type: "error", message: long })}\n`);
  const reason = p.failureReason();
  assert.equal(reason.message, long, "远低于原始上限的原话原样保留（后端脱敏后才截）");
  assert.ok(reason.message.startsWith("head-marker "), "原因在开头");
});

test("自报失败: 解析器不截断原话（70 KB 原样保留，截断只在脱敏之后）", () => {
  const p = new CodexStreamParser();
  const long = `head-marker ${"x".repeat(70 * 1024)}`;
  p.feed(`${JSON.stringify({ type: "error", message: long })}\n`);
  assert.equal(p.failureReason().message, long, "任何在脱敏之前的截断都可能切碎密钥值");
});

test("自报失败: 本轮终局只被新一轮或本轮完成清掉，轮内的 item.* 不清", () => {
  // 失败收尾之后同一轮还可能到达 item.*（例如失败命令的完成帧），它们不推翻本轮终局。
  for (const frame of [
    '{"type":"item.started","item":{"id":"c1","type":"command_execution","command":"echo hi"}}',
    '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"echo hi","exit_code":1}}',
  ]) {
    const p = new CodexStreamParser();
    p.feed('{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}\n');
    p.feed(`${frame}\n`);
    assert.equal(p.failureReason()?.message, "You've hit your usage limit.", `轮内帧不清终局：${frame}`);
  }
  for (const frame of ['{"type":"turn.started"}', '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}']) {
    const p = new CodexStreamParser();
    p.feed('{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}\n');
    p.feed(`${frame}\n`);
    assert.equal(p.failureReason(), null, `新一轮或本轮完成清掉终局：${frame}`);
  }
});

test("自报失败: 过程报错之后的推进帧清掉原话（陈旧错误不算终局原因）", () => {
  // 运行又往前走说明之前的过程报错已陈旧（可能已重试恢复）：只有"报错之后再无进展
  // 就退出"时，原话才是退出原因。
  const progressFrames = [
    '{"type":"item.started","item":{"id":"c1","type":"command_execution","command":"echo hi"}}',
    '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"recovered"}}',
    '{"type":"turn.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
  ];
  for (const frame of progressFrames) {
    const p = new CodexStreamParser();
    p.feed('{"type":"error","message":"You\'ve hit your usage limit."}\n');
    assert.ok(p.failureReason(), `失败帧先记下原话（${frame}）`);
    p.feed(`${frame}\n`);
    assert.equal(p.failureReason(), null, `推进帧清掉已陈旧的原话：${frame}`);
  }
});

test("自报失败: 推进之后新的失败帧重新记下原话（清除不是单向闩锁）", () => {
  const p = new CodexStreamParser();
  p.feed('{"type":"error","message":"stale rate limit"}\n');
  p.feed('{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"recovered"}}\n');
  assert.equal(p.failureReason(), null);
  p.feed('{"type":"turn.failed","error":{"message":"final failure"}}\n');
  assert.equal(p.failureReason().message, "final failure", "新的失败帧重新成为退出原因");
});

test("自报失败: 缺 message 的失败帧与其它事件一样被忽略（不崩、无原话）", () => {
  const p = new CodexStreamParser();
  assert.deepEqual(p.feed('{"type":"error"}\n'), []);
  assert.deepEqual(p.feed('{"type":"turn.failed","error":{}}\n'), []);
  assert.deepEqual(p.feed('{"type":"error","message":"   "}\n'), []);
  assert.equal(p.failureReason(), null, "空原话不算失败原话");
});
