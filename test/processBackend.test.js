import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessBackend } from "../src/backends/processBackend.js";
import { ClaudeStreamParser } from "../src/backends/parsers/claudeCode.js";

const NODE = process.execPath;

// mock 子进程：输出预设的 claude 风格 JSONL 后正常退出
function mockScript(lines, exitCode = 0) {
  // 用 base64 编码 JSONL 行，避免引号转义地狱
  const payload = Buffer.from(lines.join("\n")).toString("base64");
  return [
    `const p=Buffer.from("${payload}","base64").toString("utf8");`,
    `process.stdout.write(p+"\\n");`,
    `process.exit(${exitCode});`,
  ].join("");
}

// mock 长时进程：永不退出，用于测 abort
function mockLongRunning() {
  return `setInterval(()=>{},1000);`;
}

const CLAUDE_LINES = [
  '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
  '{"type":"result","subtype":"success","is_error":false}',
];

function makeAgent(overrides = {}) {
  return {
    id: "test",
    backend: "claude-code",
    cwd: process.cwd(),
    binary: NODE,
    ...overrides,
  };
}

function makeBackend(parserClass = ClaudeStreamParser, buildArgs = (_agent, task) => ["-e", task.prompt]) {
  return new ProcessBackend({ parserClass, buildArgs });
}

test("spawn 输出 JSONL 的子进程 → events 流产出 message + done", async () => {
  const script = mockScript(CLAUDE_LINES);
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", script]);
  const agent = makeAgent();
  const handle = await backend.spawn(agent, { prompt: "test" });

  const events = [];
  for await (const ev of handle.events(new AbortController().signal)) {
    events.push(ev);
  }
  assert.ok(events.some((e) => e.kind === "message" && e.role === "assistant"));
  assert.ok(events.some((e) => e.kind === "done" && e.reason === "completed"));
});

test("进程退出但无 done 事件 → 按 exit code 0 兜底 emit done(completed)", async () => {
  // 只输出 system 事件（parser 忽略），不输出 result
  const script = mockScript(['{"type":"system","subtype":"init"}'], 0);
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", script]);
  const agent = makeAgent();
  const handle = await backend.spawn(agent, { prompt: "test" });

  const events = [];
  for await (const ev of handle.events(new AbortController().signal)) {
    events.push(ev);
  }
  // parser 没 emit done，进程 exit 0 → 兜底 done(completed)
  assert.ok(events.some((e) => e.kind === "done" && e.reason === "completed"));
});

test("TD-76: rawCapturePath 把 parser 输入前的原始 stdout 留旁路文件（不影响 transcript）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-rawcap-"));
  const capturePath = path.join(dir, "raw.log");
  try {
    const script = mockScript(CLAUDE_LINES);
    const backend = new ProcessBackend({
      parserClass: ClaudeStreamParser,
      buildArgs: () => ["-e", script],
      rawCapturePath: capturePath,
    });
    const agent = makeAgent();
    const handle = await backend.spawn(agent, { prompt: "test" });
    const events = [];
    for await (const ev of handle.events(new AbortController().signal)) {
      events.push(ev);
    }
    // 旁路文件应含原始 JSONL（parser 输入前，未翻译）
    const raw = await import("node:fs/promises").then((m) => m.readFile(capturePath, "utf8"));
    assert.match(raw, /"type":"assistant"/, "raw 文件应含原始 assistant 行");
    assert.match(raw, /"type":"result"/, "raw 文件应含原始 result 行");
    // transcript 事件不受影响（正常翻译）
    assert.ok(events.some((e) => e.kind === "message"), "raw-capture 不影响事件流");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-76: WAO_RAW_CAPTURE env 也启用 raw-capture（默认关）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-rawcap-env-"));
  const capturePath = path.join(dir, "raw-env.log");
  const prevEnv = process.env.WAO_RAW_CAPTURE;
  try {
    process.env.WAO_RAW_CAPTURE = capturePath;
    const script = mockScript(['{"type":"assistant","message":{"content":[{"type":"text","text":"x"}]}}']);
    const backend = makeBackend(ClaudeStreamParser, () => ["-e", script]);
    const handle = await backend.spawn(makeAgent(), { prompt: "test" });
    for await (const _ev of handle.events(new AbortController().signal)) { /* drain */ }
    const raw = await import("node:fs/promises").then((m) => m.readFile(capturePath, "utf8"));
    assert.match(raw, /"type":"assistant"/, "env 形态也应捕获 raw");
  } finally {
    if (prevEnv === undefined) delete process.env.WAO_RAW_CAPTURE; else process.env.WAO_RAW_CAPTURE = prevEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-76: thinking 块 → emit thinking 心跳事件（不存内容，消除思考假死）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-think-"));
  const capturePath = path.join(dir, "raw.log");
  try {
    // 真实 schema（GLM-5.2 网关实测）：thinking 单独成行，content 只有 thinking 块
    const THINKING_LINES = [
      '{"type":"assistant","message":{"id":"msg_x","content":[{"type":"thinking","thinking":"reasoning here","signature":""}]}}',
      '{"type":"assistant","message":{"id":"msg_x","content":[{"type":"text","text":"answer"}]}}',
      '{"type":"result","subtype":"success","is_error":false}',
    ];
    const script = mockScript(THINKING_LINES);
    const backend = new ProcessBackend({ parserClass: ClaudeStreamParser, buildArgs: () => ["-e", script], rawCapturePath: capturePath });
    const handle = await backend.spawn(makeAgent(), { prompt: "test" });
    const events = [];
    for await (const ev of handle.events(new AbortController().signal)) {
      events.push(ev);
    }
    const thinking = events.filter((e) => e.kind === "thinking");
    assert.equal(thinking.length, 1, "thinking 块应 emit 一个 thinking 事件");
    assert.ok(!("thinking" in thinking[0]), "thinking 事件不存内容（方案 A：只记存在）");
    // text 仍正常产出（thinking 和 text 分行不互相吞）
    assert.ok(events.some((e) => e.kind === "message"), "text 行仍产出 message");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("进程 exit code 非 0 且无 done → 兜底 emit done(failed)", async () => {
  const script = mockScript(['{"type":"system"}'], 1); // exit 1
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", script]);
  const agent = makeAgent();
  const handle = await backend.spawn(agent, { prompt: "test" });

  const events = [];
  for await (const ev of handle.events(new AbortController().signal)) {
    events.push(ev);
  }
  assert.ok(events.some((e) => e.kind === "done" && e.reason === "failed"));
});

test("进程 exit code 非 0 时 done(failed) 带 stderr 摘要", async () => {
  const script = [
    "process.stderr.write('provider error [429]: quota exhausted\\n');",
    "process.exit(1);",
  ].join("");
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", script]);
  const agent = makeAgent();
  const handle = await backend.spawn(agent, { prompt: "test" });

  const events = [];
  for await (const ev of handle.events(new AbortController().signal)) {
    events.push(ev);
  }

  const done = events.find((e) => e.kind === "done");
  assert.equal(done?.reason, "failed");
  assert.match(done.error, /process exited with code 1/);
  assert.match(done.error, /provider error \[429\]: quota exhausted/);
});

// ── TD-77 子项 B（stdout 尾留存进诊断）──────────────────────────────────
// 进程崩时往往没写 stderr（物理缺失），旧 detail 退化为 "process exited with code N"，
// Lead 看不到 worker 崩前 stdout 吐了什么。修复：无 stderr 时回落到 stdout 尾部摘要。
test("TD-77B: 进程 exit 非 0 + 无 stderr + 有 stdout → done.error 含 stdout 尾", async () => {
  // stdout 吐非 JSON 文本（parser 静默跳过非 JSON 行，不产事件 → 走 exit code 兜底）。
  // 模拟 worker 崩前在 stdout 吐了诊断信息但没写 stderr 的真实场景。
  const script = [
    "process.stdout.write('investigating src/app.py\\n');",
    "process.stdout.write('traceback: KeyError at line 42\\n');",
    "process.exit(1);",
  ].join("");
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", script]);
  const agent = makeAgent();
  const handle = await backend.spawn(agent, { prompt: "test" });

  const events = [];
  for await (const ev of handle.events(new AbortController().signal)) {
    events.push(ev);
  }

  const done = events.find((e) => e.kind === "done");
  assert.equal(done?.reason, "failed");
  assert.match(done.error, /process exited with code 1/);
  // 关键：无 stderr 时，stdout 尾部应进 detail（旧实现这里只有 exit code）
  assert.match(done.error, /stdout:/, "无 stderr 时 detail 应含 stdout: 段");
  assert.match(done.error, /traceback: KeyError/, "stdout 尾内容应进 detail");
});

test("TD-77B 回归: 进程 exit 非 0 + 有 stderr → 仍优先 stderr（stdout 不抢）", async () => {
  // 有 stderr 时 stderr 优先，stdout 不应混入 detail（避免噪声）。
  const script = [
    "process.stdout.write('some stdout noise\\n');",
    "process.stderr.write('fatal: provider 401 unauthorized\\n');",
    "process.exit(1);",
  ].join("");
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", script]);
  const agent = makeAgent();
  const handle = await backend.spawn(agent, { prompt: "test" });

  const events = [];
  for await (const ev of handle.events(new AbortController().signal)) {
    events.push(ev);
  }

  const done = events.find((e) => e.kind === "done");
  assert.equal(done?.reason, "failed");
  assert.match(done.error, /process exited with code 1/);
  assert.match(done.error, /provider 401 unauthorized/, "stderr 优先");
  assert.doesNotMatch(done.error, /stdout:/, "有 stderr 时不应掺 stdout 段");
});

test("abort 能杀掉长时进程", async () => {
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", mockLongRunning()]);
  const agent = makeAgent();
  const handle = await backend.spawn(agent, { prompt: "test" });

  assert.ok(handle.backendSessionId, "should have a pid-based session id");
  assert.equal(handle.isAlive(), true, "process alive before abort");

  await handle.abort();

  // taskkill 异步，轮询等待进程真正退出（最多 2s）
  const deadline = Date.now() + 2000;
  while (handle.isAlive() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(handle.isAlive(), false, "process should be dead after abort");
});

test("signal abort 让 events 流终止", async () => {
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", mockLongRunning()]);
  const agent = makeAgent();
  const handle = await backend.spawn(agent, { prompt: "test" });

  const controller = new AbortController();
  const events = [];
  const collectPromise = (async () => {
    for await (const ev of handle.events(controller.signal)) {
      events.push(ev);
    }
  })();

  // 100ms 后 abort signal
  setTimeout(() => controller.abort(), 100);
  await collectPromise;

  // 流应已终止（events 可能为空，但流必须结束）
  assert.equal(handle.isAlive(), false, "signal abort should kill process");
});

test("Windows: agent.binary 指向 .cmd wrapper 时可正常启动", { skip: process.platform !== "win32" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-cmd-wrapper-"));
  const scriptPath = path.join(dir, "mock wrapper.cmd");
  const payload = Buffer.from(CLAUDE_LINES.join("\n") + "\n").toString("base64");
  await writeFile(scriptPath, [
    "@echo off",
    `"${NODE}" -e "process.stdout.write(Buffer.from('${payload}','base64').toString('utf8'))"`,
  ].join("\r\n"));

  try {
    const backend = makeBackend(ClaudeStreamParser, () => []);
    const agent = makeAgent({ binary: scriptPath });
    const handle = await backend.spawn(agent, { prompt: "test" });

    const events = [];
    for await (const ev of handle.events(new AbortController().signal)) {
      events.push(ev);
    }

    assert.ok(events.some((e) => e.kind === "message" && e.parts?.[0]?.text === "hi"));
    assert.ok(events.some((e) => e.kind === "done" && e.reason === "completed"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent.prependArgs 在 runtime args 前注入 wrapper 参数", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-prepend-wrapper-"));
  const wrapperPath = path.join(dir, "mock-wrapper.mjs");
  await writeFile(wrapperPath, [
    "const text = process.argv.slice(2).join('|');",
    "process.stdout.write(JSON.stringify({",
    "  type: 'assistant',",
    "  message: { content: [{ type: 'text', text }] },",
    "}) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n');",
  ].join("\n"));

  try {
    const backend = makeBackend(ClaudeStreamParser, (_agent, task) => ["--", task.prompt]);
    const agent = makeAgent({
      binary: NODE,
      prependArgs: [wrapperPath, "--provider", "deepseek"],
    });
    const handle = await backend.spawn(agent, { prompt: "Read <sent_a.txt content>" });

    const events = [];
    for await (const ev of handle.events(new AbortController().signal)) {
      events.push(ev);
    }

    const message = events.find((e) => e.kind === "message");
    assert.equal(message?.parts?.[0]?.text, "--provider|deepseek|--|Read <sent_a.txt content>");
    assert.ok(events.some((e) => e.kind === "done" && e.reason === "completed"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- TD-A: 进程式 backend silentTimeout ---
// RunManager 算出 silentTimeout 传给 handle.events(signal, {silentTimeout})，
// 但原 processBackend.events 签名是 (signal)，第二参数被丢弃 → 静默死循环只能干等 waitTimeout。
// 修复：events 接第二参数，_streamEvents 里复用 opencodeServe 语义——
// silentTimeout 内若无任何 parser 事件 → doneEvent("failed", "silent timeout...")。

test("TD-A: 静默进程 + silentTimeout → 在超时窗口内 done(failed, silent timeout)", async () => {
  // 永不退出、不输出任何东西的进程（模拟 provider 静默拒绝/重试死循环）
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", mockLongRunning()]);
  const agent = makeAgent();
  const handle = await backend.spawn(agent, { prompt: "test" });

  const start = Date.now();
  const events = [];
  for await (const ev of handle.events(new AbortController().signal, { silentTimeout: 300 })) {
    events.push(ev);
  }
  const elapsed = Date.now() - start;

  const done = events.find((e) => e.kind === "done");
  assert.equal(done?.reason, "failed", "静默应在 silentTimeout 后失败");
  assert.match(done?.error ?? "", /silent timeout/i, "失败原因应含 silent timeout");
  // 应在 silentTimeout 附近触发，而非干等到很久之后
  assert.ok(elapsed < 2000, `应在 silentTimeout 附近失败，实际 ${elapsed}ms`);
  // 清理：杀掉长时进程
  await handle.abort();
});

test("TD-A: silentTimeout 内有事件 → 不误杀，正常完成", async () => {
  // 正常输出 assistant message 的进程，不应被 silentTimeout 误杀。
  // silentTimeout 用宽松窗口（1000ms）：全量 suite 并发时进程 spawn→parser 首事件有抖动，
  // 太短的窗口（如 100ms）会在高负载下误杀正常响应。此测试验证的是"有响应不触发 silent"，
  // 用宽松窗口表达该不变量，避免对调度时序过度敏感。
  const script = mockScript(CLAUDE_LINES);
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", script]);
  const agent = makeAgent();
  const handle = await backend.spawn(agent, { prompt: "test" });

  const events = [];
  for await (const ev of handle.events(new AbortController().signal, { silentTimeout: 1000 })) {
    events.push(ev);
  }
  // 有事件 → 应正常 completed，而非 silent timeout
  assert.ok(events.some((e) => e.kind === "done" && e.reason === "completed"), "有响应不应被 silentTimeout 误杀");
  assert.ok(!events.some((e) => e.kind === "done" && /silent timeout/i.test(e.error ?? "")), "不应有 silent timeout 事件");
});

test("TD-A: 不传 silentTimeout → 行为不变（向后兼容）", async () => {
  // 不传 silentTimeout 时，长时进程应持续到 signal abort（不被静默超时打断）
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", mockLongRunning()]);
  const agent = makeAgent();
  const handle = await backend.spawn(agent, { prompt: "test" });

  const controller = new AbortController();
  const events = [];
  const consumePromise = (async () => {
    for await (const ev of handle.events(controller.signal)) {
      events.push(ev);
    }
  })();
  await new Promise((r) => setTimeout(r, 200)); // 等一会
  controller.abort(); // 主动终止
  await consumePromise;
  // 不传 silentTimeout → 不应有 silent timeout done
  assert.ok(!events.some((e) => e.kind === "done" && /silent timeout/i.test(e.error ?? "")), "未配 silentTimeout 不应触发");
  await handle.abort();
});

// ── TD-79（Python 环境隔离：agent.env 注入子进程）─────────────────────────
// read-only worker（如 researcher）跑 pip install 会污染全局 Python env。
// 修复：registry worker 可声明 env 字段（如 PIP_REQUIRE_VIRTUALENV），processBackend
// spawn 时注入子进程 env，让 pip 自己拒绝安装（OS-native 机制）。
test("TD-79: agent.env 字段注入子进程 env（PIP_REQUIRE_VIRTUALENV 等）", async () => {
  // 子进程把可疑 env 写进 assistant message 文本，parser 提取后断言。
  const script = [
    "const v = process.env.PIP_REQUIRE_VIRTUALENV || '(unset)';",
    "const u = process.env.PYTHONNOUSERSITE || '(unset)';",
    `process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"PIPRV="+v+";PYNS="+u}]}})+"\\n");`,
    `process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false})+"\\n");`,
  ].join("");
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", script]);
  const agent = makeAgent({
    env: { PIP_REQUIRE_VIRTUALENV: "1", PYTHONNOUSERSITE: "1" },
  });
  const handle = await backend.spawn(agent, { prompt: "test" });

  const events = [];
  for await (const ev of handle.events(new AbortController().signal)) {
    events.push(ev);
  }
  const msg = events.find((e) => e.kind === "message" && e.role === "assistant");
  assert.ok(msg, "应有 assistant message");
  const text = (msg.parts ?? []).map((p) => p.text).filter(Boolean).join("");
  assert.match(text, /PIPRV=1/, "agent.env.PIP_REQUIRE_VIRTUALENV 注入子进程");
  assert.match(text, /PYNS=1/, "agent.env.PYTHONNOUSERSITE 注入子进程");
});

test("TD-79 回归: 无 agent.env 时子进程不染多余 env（不破坏原行为）", async () => {
  // 无 env 字段时 PIP_REQUIRE_VIRTUALENV 应为 unset（验证默认不注入）。
  const script = [
    "const v = process.env.PIP_REQUIRE_VIRTUALENV || '(unset)';",
    `process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"PIPRV="+v}]}})+"\\n");`,
    `process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false})+"\\n");`,
  ].join("");
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", script]);
  const agent = makeAgent(); // 无 env
  const handle = await backend.spawn(agent, { prompt: "test" });

  const events = [];
  for await (const ev of handle.events(new AbortController().signal)) {
    events.push(ev);
  }
  const msg = events.find((e) => e.kind === "message" && e.role === "assistant");
  const text = (msg.parts ?? []).map((p) => p.text).filter(Boolean).join("");
  assert.match(text, /PIPRV=\(unset\)/, "无 agent.env 时不注入 PIP_REQUIRE_VIRTUALENV");
});
