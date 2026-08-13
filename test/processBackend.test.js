import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessBackend } from "../src/backends/processBackend.js";
import { ClaudeCodeBackend } from "../src/backends/claudeCode.js";
import { CodexBackend } from "../src/backends/codex.js";
import { KimiCodeBackend } from "../src/backends/kimiCode.js";
import { ClaudeStreamParser } from "../src/backends/parsers/claudeCode.js";
import {
  runEventIsUsableEffect,
  DONE_MARKERS,
  messageEvent,
  commandEvent,
  fileWrittenEvent,
  toolUseEvent,
  toolResultEvent,
  thinkingEvent,
  runtimeActivityEvent,
  metricsEvent,
} from "../src/runEvent.js";

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

  // taskkill 异步（fire-and-forget spawn），轮询等待进程真正退出。
  // 窗口放宽到 5s：并发 npm test 负载下 taskkill 子进程调度可能 >2s（Windows 进程终止
  // 语义：/T /F 杀整树，父进程退出与 OS 回收 PID 有延迟）。断言不放宽——仍要求 isAlive===false。
  const deadline = Date.now() + 5000;
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

test("TD-104: worker environment includes assigned credential but excludes unrelated provider keys", async () => {
  const previousAssigned = process.env.WAO_ASSIGNED_API_KEY;
  const previousUnrelated = process.env.WAO_UNRELATED_API_KEY;
  process.env.WAO_ASSIGNED_API_KEY = "assigned-test-secret";
  process.env.WAO_UNRELATED_API_KEY = "unrelated-test-secret";
  try {
    const script = [
      "const assigned = Boolean(process.env.WAO_ASSIGNED_API_KEY);",
      "const unrelated = Boolean(process.env.WAO_UNRELATED_API_KEY);",
      `process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"assigned="+assigned+";unrelated="+unrelated}]}})+"\\n");`,
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false})+"\\n");`,
    ].join("");
    const backend = new ProcessBackend({
      parserClass: ClaudeStreamParser,
      buildArgs: () => ["-e", script],
      credentialEnvNames: () => ["WAO_ASSIGNED_API_KEY"],
    });
    const handle = await backend.spawn(makeAgent(), { prompt: "test" });
    const events = [];
    for await (const event of handle.events(new AbortController().signal)) events.push(event);
    const text = events.find((event) => event.kind === "message")?.parts?.[0]?.text;
    assert.equal(text, "assigned=true;unrelated=false");
  } finally {
    if (previousAssigned === undefined) delete process.env.WAO_ASSIGNED_API_KEY;
    else process.env.WAO_ASSIGNED_API_KEY = previousAssigned;
    if (previousUnrelated === undefined) delete process.env.WAO_UNRELATED_API_KEY;
    else process.env.WAO_UNRELATED_API_KEY = previousUnrelated;
  }
});

test("TD-104: process backends declare only their assigned credential channels", () => {
  const claude = new ClaudeCodeBackend();
  const kimi = new KimiCodeBackend();
  const codex = new CodexBackend();

  // credentialEnvNames delegates to the env-policy SSOT, which keys off
  // agent.backend. Pass the backend field so the SSOT resolves the static list.
  assert.deepEqual(claude.credentialEnvNames({ backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" } }), ["ZHIPU_API_KEY"]);
  assert.deepEqual(claude.credentialEnvNames({ backend: "claude-code" }), []);
  assert.deepEqual(kimi.credentialEnvNames({ backend: "kimi-code" }), ["KIMI_API_KEY", "KIMI_BASE_URL", "KIMI_MODEL_NAME"]);
  assert.deepEqual(codex.credentialEnvNames({ backend: "codex" }), ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME"]);
});

test("TD-104: secret-like values are rejected from agent.env", async () => {
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", "process.exit(0)"]);
  await assert.rejects(
    () => backend.spawn(makeAgent({ env: { EMBEDDED_API_KEY: "test-secret-registry-value" } }), { prompt: "test" }),
    /secret-like.*agent\.env|agent\.env.*secret-like/i,
  );
});

test("TD-104: raw capture redacts an explicitly assigned credential split across stdout chunks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-rawcap-secret-"));
  const capturePath = path.join(dir, "raw.log");
  const previous = process.env.WAO_SPLIT_CHANNEL;
  const secret = "split-test-secret-value-104";
  process.env.WAO_SPLIT_CHANNEL = secret;
  try {
    const script = [
      "const value=process.env.WAO_SPLIT_CHANNEL;",
      `process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"'+value.slice(0,10));`,
      `setTimeout(()=>{process.stdout.write(value.slice(10)+'"}]}}\\n');process.stdout.write('{"type":"result","subtype":"success","is_error":false}\\n');},10);`,
    ].join("");
    const backend = new ProcessBackend({
      parserClass: ClaudeStreamParser,
      buildArgs: () => ["-e", script],
      rawCapturePath: capturePath,
      credentialEnvNames: () => ["WAO_SPLIT_CHANNEL"],
    });
    const handle = await backend.spawn(makeAgent(), { prompt: "test" });
    for await (const _event of handle.events(new AbortController().signal)) {
    }
    const raw = await import("node:fs/promises").then((module) => module.readFile(capturePath, "utf8"));
    assert.equal(raw.includes(secret), false);
    assert.match(raw, /\[REDACTED:WAO_SPLIT_CHANNEL\]/);
    assert.equal(JSON.stringify(handle.redact({ value: secret })).includes(secret), false);
  } finally {
    if (previous === undefined) delete process.env.WAO_SPLIT_CHANNEL;
    else process.env.WAO_SPLIT_CHANNEL = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-105: done queued while consumer is paused is drained before closed stream returns", async () => {
  const script = [
    `process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}\\n');`,
    `setTimeout(()=>process.stdout.write('{"type":"result","subtype":"success","is_error":false}\\n'),20);`,
  ].join("");
  const backend = new ProcessBackend({
    parserClass: ClaudeStreamParser,
    buildArgs: () => ["-e", script],
  });
  const handle = await backend.spawn(makeAgent(), { prompt: "test" });
  const iterator = handle.events(new AbortController().signal)[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.value?.kind, "message");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await iterator.next();

  assert.equal(second.done, false);
  assert.equal(second.value?.kind, "done");
  assert.equal(second.value?.reason, "completed");
});

// ── M12-14：控制面 env（runtimeEnv/waoEnv）优先级钉死 ─────────────────────
// claude-code 的 auto-memory 隔离依赖这条机制：buildChildEnv 合并序
// { ...inherited, ...credEnv, ...agentEnv, ...waoEnv }——backend runtimeEnv
// （waoEnv 段）必须压过同名 agent.env，否则 agent/task 配置可以反设安全 flag。
// 这是 provider-neutral 的共享层不变量，单独钉死，防未来重排合并序。
test("M12-14: backend runtimeEnv 覆盖同名 agent.env（控制面 env 优先级最高）", async () => {
  const captures = [];
  const spawnFn = (binary, args, opts) => {
    captures.push({ binary, args: [...args], opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 7171;
    child.exitCode = null;
    child.signalCode = null;
    setImmediate(() => {
      child.emit("spawn");
      setImmediate(() => { child.exitCode = 0; child.emit("close", 0); });
    });
    return child;
  };
  const backend = new ProcessBackend({
    parserClass: ClaudeStreamParser,
    buildArgs: () => ["-e", "process.exit(0)"],
    runtimeEnv: () => ({ WAO_MANAGED_SAFETY_FLAG: "1" }),
    spawnFn,
  });
  const agent = makeAgent({ env: { WAO_MANAGED_SAFETY_FLAG: "0" } });
  const handle = await backend.spawn(agent, { prompt: "t" });
  for await (const _ev of handle.events(new AbortController().signal)) { /* drain */ }
  assert.equal(captures.length, 1, "恰好一次 spawn");
  assert.equal(captures[0].opts.env.WAO_MANAGED_SAFETY_FLAG, "1", "runtimeEnv（waoEnv）必须压过 agent.env");
});

// ── M12-16：correctable wire（单 stream-json 进程 + stdin 投递）─────────────
//
// provider-neutral 能力 + Claude wire。correctable 任务把首个 prompt 经 stdin
// 投递（claude -p --input-format stream-json，无 positional prompt），并在 handle
// 上挂 sendCorrection，使后续纠正轮次投递到【同一】live 进程。非 correctable 路径
// 字节级兼容（stdio "ignore"，-p <prompt> positional，无 sendCorrection）。
// "delivered" 只证明字节进入 runtime stdin，不证明模型执行（queued≠delivered≠executed）。

// fake 子进程：捕获 argv/stdio/stdin 写入，emit spawn。stdout/close 不触发
// （argv/stdin 断言不需要 drain events）。
function makeCapturingChild() {
  const stdinChunks = [];
  const stdin = new EventEmitter();
  stdin.writable = true;
  stdin.destroyed = false;
  stdin.writableEnded = false;
  stdin.write = (chunk, cb) => {
    stdinChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    if (typeof cb === "function") setImmediate(() => cb(null));
    return true; // no backpressure
  };
  stdin.end = () => { stdin.writableEnded = true; };
  const child = new EventEmitter();
  child.stdin = stdin;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 80808;
  child.exitCode = null;
  child.signalCode = null;
  setImmediate(() => child.emit("spawn"));
  return { child, stdinChunks, stdinText: () => stdinChunks.join("") };
}

test("M12-16: capability 声明 — base ProcessBackend=false，ClaudeCodeBackend=true（读 boolean 不认 runtime 名）", () => {
  const base = new ProcessBackend({ parserClass: ClaudeStreamParser, buildArgs: () => [] });
  assert.equal(base.supportsInFlightCorrection, false, "base ProcessBackend 默认不支持");
  const claude = new ClaudeCodeBackend({});
  assert.equal(claude.supportsInFlightCorrection, true, "ClaudeCodeBackend 声明支持");
});

test("M12-16: correctable ClaudeCode argv = -p --input-format stream-json（无 positional prompt）；初始 prompt 经 stdin 投递为 stream-json", async () => {
  const cap = makeCapturingChild();
  const argv = [];
  const spawnFn = (binary, args, opts) => {
    argv.push([...args]);
    return cap.child;
  };
  const backend = new ClaudeCodeBackend({ spawnFn });
  const handle = await backend.spawn(makeAgent(), { prompt: "do the thing", correctable: true });

  const args = argv[0];
  assert.ok(args.includes("-p"), "correctable 仍带 -p（print mode）");
  assert.ok(args.includes("--input-format"), "correctable 带 --input-format");
  assert.equal(args[args.indexOf("--input-format") + 1], "stream-json", "input-format=stream-json");
  // positional prompt 绝不出现（prompt 改走 stdin）
  assert.equal(args.includes("do the thing"), false, "correctable 不把 prompt 作为 positional argv");
  // stdio[0] 必须是 pipe（否则无法投递）
  // 初始 prompt 已作为一条整 stream-json 行写入 stdin
  const lines = cap.stdinText().split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1, "恰好一条初始 prompt 行");
  const envelope = JSON.parse(lines[0]);
  assert.equal(envelope.type, "user");
  assert.equal(envelope.message.role, "user");
  assert.equal(envelope.message.content[0].text, "do the thing");
  // correctable handle 必须挂 sendCorrection
  assert.equal(typeof handle.sendCorrection, "function");
  assert.equal(handle.supportsSendCorrection, true);
});

test("M12-16: sendCorrection 投递一条整 stream-json user-message 行；返回 {ok:true}", async () => {
  const cap = makeCapturingChild();
  const backend = new ClaudeCodeBackend({ spawnFn: () => cap.child });
  const handle = await backend.spawn(makeAgent(), { prompt: "initial", correctable: true });
  const before = cap.stdinText();
  const res = await handle.sendCorrection("fix the off-by-one");
  assert.deepEqual(res, { ok: true });
  const added = cap.stdinText().slice(before.length);
  const envelope = JSON.parse(added.trim());
  assert.equal(envelope.type, "user");
  assert.equal(envelope.message.content[0].text, "fix the off-by-one");
  // 一条整行（以换行结尾）
  assert.ok(added.endsWith("\n"), "sendCorrection 写一条以换行结尾的整行");
});

test("M12-16: sendCorrection 在 stdin 已关闭时返回 closed-set {ok:false, reason:'stdin_closed'}", async () => {
  const cap = makeCapturingChild();
  const backend = new ClaudeCodeBackend({ spawnFn: () => cap.child });
  const handle = await backend.spawn(makeAgent(), { prompt: "initial", correctable: true });
  // 模拟 provider 进程已关闭 stdin（进程退出/管道断开）
  cap.child.stdin.destroyed = true;
  const res = await handle.sendCorrection("late correction");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "stdin_closed");
  // 没有新字节进入（写被拒）
  assert.equal(cap.stdinText().includes("late correction"), false);
});

test("M12-16: sendCorrection write error (NOT a closed stdin) → closed-set {ok:false, reason:'send_failed'}; listeners never accumulate across corrections", async () => {
  const cap = makeCapturingChild();
  const backend = new ClaudeCodeBackend({ spawnFn: () => cap.child });
  const handle = await backend.spawn(makeAgent(), { prompt: "initial", correctable: true });
  // stdin is OPEN (passes the pre-check), but the write itself fails — a bounded
  // send failure, NOT stdin_closed. Route the failure via the async write
  // callback (the realistic mid-write error path).
  cap.child.stdin.write = (chunk, cb) => {
    if (typeof cb === "function") setImmediate(() => cb(new Error("EPIPE")));
    return true;
  };
  const beforeErr = cap.child.stdin.listenerCount("error");
  const beforeDrain = cap.child.stdin.listenerCount("drain");
  for (let i = 0; i < 3; i += 1) {
    const res = await handle.sendCorrection(`turn ${i}`);
    assert.equal(res.ok, false, `turn ${i} refused`);
    assert.equal(res.reason, "send_failed", `turn ${i} is send_failed, not stdin_closed`);
  }
  // Tail (b): the per-correction error/drain listeners must detach on settle,
  // NOT accumulate with the correction count.
  assert.equal(cap.child.stdin.listenerCount("error"), beforeErr, "no error-listener accumulation");
  assert.equal(cap.child.stdin.listenerCount("drain"), beforeDrain, "no drain-listener accumulation");
});

test("M12-16: sendCorrection synchronous write throw → {ok:false, reason:'send_failed'}; error listener detached (no leak)", async () => {
  const cap = makeCapturingChild();
  const backend = new ClaudeCodeBackend({ spawnFn: () => cap.child });
  const handle = await backend.spawn(makeAgent(), { prompt: "initial", correctable: true });
  cap.child.stdin.write = () => { throw new Error("sync write boom"); };
  const beforeErr = cap.child.stdin.listenerCount("error");
  const res = await handle.sendCorrection("late");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "send_failed");
  assert.equal(cap.child.stdin.listenerCount("error"), beforeErr, "sync-throw path detaches the error listener too");
});

test("M12-16: 非 correctable 路径字节级兼容 — -p <prompt> positional，stdio[0]='ignore'，无 sendCorrection", async () => {
  const cap = makeCapturingChild();
  const argv = [];
  const stdioSeen = [];
  const spawnFn = (binary, args, opts) => {
    argv.push([...args]);
    stdioSeen.push(opts.stdio);
    return cap.child;
  };
  const backend = new ClaudeCodeBackend({ spawnFn });
  const handle = await backend.spawn(makeAgent(), { prompt: "ordinary run" });
  const args = argv[0];
  assert.equal(stdioSeen[0][0], "ignore", "非 correctable stdin='ignore'（字节兼容）");
  assert.ok(args.includes("-p"), "非 correctable 仍带 -p");
  assert.ok(args.includes("ordinary run"), "非 correctable 把 prompt 作为 positional argv");
  assert.equal(args.includes("--input-format"), false, "非 correctable 不带 --input-format");
  assert.equal(handle.sendCorrection, undefined, "非 correctable handle 不挂 sendCorrection");
  assert.equal(handle.supportsSendCorrection, undefined);
  assert.equal(cap.stdinText(), "", "非 correctable 不向 stdin 写任何字节");
});

test("M12-16: base ProcessBackend（supportsInFlightCorrection=false）即使 task.correctable=true 也不启用 correctable（能力门 defense-in-depth）", async () => {
  const cap = makeCapturingChild();
  const stdioSeen = [];
  const spawnFn = (binary, args, opts) => { stdioSeen.push(opts.stdio); return cap.child; };
  // 显式 encodeUserMessage，但 supportsInFlightCorrection 仍是 base 的 false
  const backend = new ProcessBackend({
    parserClass: ClaudeStreamParser,
    buildArgs: (_a, task) => ["-p", task.prompt],
    spawnFn,
    encodeUserMessage: (text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }),
  });
  const handle = await backend.spawn(makeAgent(), { prompt: "x", correctable: true });
  assert.equal(stdioSeen[0][0], "ignore", "无能力声明 → 不 pipe stdin（即使 task.correctable=true）");
  assert.equal(handle.supportsSendCorrection, undefined, "无能力 → 不挂 sendCorrection");
  assert.equal(cap.stdinText(), "", "无能力 → 不写 stdin");
});

// ── M12-21：completed-empty truth — result.result fallback through the real ──
// process backend (fresh-vs-resume determinism).
//
// A provider runtime may deliver the worker's final answer ONLY in the terminal
// `result.result` field (no streamed assistant text) — a "resumed"/non-streamed
// completion. The parser must recover it as exactly one assistant message so
// the run is not misread as completed-empty. When the same text WAS already
// streamed ("fresh" streamed completion), the result repeat must NOT duplicate.
// These run the recovery through the real ProcessBackend + ClaudeStreamParser
// (the _emittedAssistantTexts Set lives for one run = one parser instance).

test("M12-21: resumed-style completion (result.result only, no streamed text) → recover one assistant message", async () => {
  // system init + result success with the answer ONLY in result.result.
  const lines = [
    '{"type":"system","subtype":"init"}',
    '{"type":"result","subtype":"success","is_error":false,"result":"recovered answer"}',
  ];
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", mockScript(lines)]);
  const handle = await backend.spawn(makeAgent(), { prompt: "test" });
  const events = [];
  for await (const ev of handle.events(new AbortController().signal)) {
    events.push(ev);
  }
  const messages = events.filter((e) => e.kind === "message" && e.role === "assistant");
  assert.equal(messages.length, 1, "exactly one recovered assistant message");
  assert.equal(messages[0].parts[0].text, "recovered answer");
  assert.ok(events.some((e) => e.kind === "done" && e.reason === "completed"), "done(completed) preserved");
});

test("M12-21: fresh-style completion (streamed text + identical result.result) → no duplicate", async () => {
  // The answer is streamed as an assistant message, then the result event
  // repeats the identical text. The fallback must NOT emit a second message.
  const lines = [
    '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"live answer"}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"live answer"}',
  ];
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", mockScript(lines)]);
  const handle = await backend.spawn(makeAgent(), { prompt: "test" });
  const events = [];
  for await (const ev of handle.events(new AbortController().signal)) {
    events.push(ev);
  }
  const messages = events.filter((e) => e.kind === "message" && e.role === "assistant");
  assert.equal(messages.length, 1, "identical streamed + result text must not duplicate");
  assert.equal(messages[0].parts[0].text, "live answer");
  assert.ok(events.some((e) => e.kind === "done" && e.reason === "completed"));
});

// ── M12-21 Lead correction: completed-empty marker at the ProcessBackend stream ──
//
// Contract #1/#4: a completion (parser done(completed) OR the exit-code-0
// fallback) that produced NO usable model effect must NOT read as ordinary
// success — ProcessBackend attaches the closed-set `completed_empty` marker to
// the done event. A completion WITH a usable effect (assistant text / command /
// file_written / tool_use / tool_result) stays an ordinary completed (no
// marker). A FAILED done never carries the marker. runtime_activity / thinking /
// metrics are transport activity, NOT usable effect.
//
// These are deterministic end-to-end tests through the real ProcessBackend +
// ClaudeStreamParser (the hasUsableEffect flag lives for one run = one stream).

test("M12-21: parser done(completed) with NO usable effect → done carries completed_empty marker", async () => {
  // A bare success result (no streamed assistant text, no result.result, no
  // tool/command evidence): the parser emits done(completed) and nothing usable.
  const lines = ['{"type":"result","subtype":"success","is_error":false}'];
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", mockScript(lines)]);
  const handle = await backend.spawn(makeAgent(), { prompt: "test" });
  const events = [];
  for await (const ev of handle.events(new AbortController().signal)) {
    events.push(ev);
  }
  const done = events.find((e) => e.kind === "done");
  assert.equal(done?.reason, "completed", "parser emitted a completion");
  assert.equal(done?.marker, "completed_empty", "no-effect completion carries the closed-set marker");
});

test("M12-21: exit-code-0 fallback with NO usable effect → done carries completed_empty marker", async () => {
  // Parser ignores the system line → emits no done; process exits 0 → the
  // exit-code-0 fallback synthesizes done(completed). With no usable effect it
  // carries completed_empty (transport success is not a useful result).
  const lines = ['{"type":"system","subtype":"init"}'];
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", mockScript(lines, 0)]);
  const handle = await backend.spawn(makeAgent(), { prompt: "test" });
  const events = [];
  for await (const ev of handle.events(new AbortController().signal)) {
    events.push(ev);
  }
  const done = events.find((e) => e.kind === "done");
  assert.equal(done?.reason, "completed", "exit-0 fallback synthesizes a completion");
  assert.equal(done?.marker, "completed_empty", "no-effect exit-0 completion carries the marker");
});

test("M12-21: completion WITH assistant text → ordinary completed, NO marker", async () => {
  // Streamed assistant text is a usable effect → completion stays ordinary.
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", mockScript(CLAUDE_LINES)]);
  const handle = await backend.spawn(makeAgent(), { prompt: "test" });
  const events = [];
  for await (const ev of handle.events(new AbortController().signal)) {
    events.push(ev);
  }
  const done = events.find((e) => e.kind === "done");
  assert.equal(done?.reason, "completed");
  assert.equal(done?.marker, undefined, "a real assistant effect suppresses the marker");
});

test("M12-21B: completion with WHITESPACE-ONLY assistant text → done carries completed_empty marker", async () => {
  // M12-21B gap #2 (live path): a worker that emits only whitespace assistant
  // text did no usable model work. runEventIsUsableEffect trims (matching
  // assessRunEvidence._hasNonEmptyTextPart), so the live ProcessBackend
  // hasUsableEffect gate treats whitespace-only text as no effect and the
  // completion still carries completed_empty. This is the live counterpart to
  // the historical retrofit test in diagnosis.test.js — the two decisions must
  // agree on blank output.
  const lines = [
    '{"type":"assistant","message":{"id":"m_ws","content":[{"type":"text","text":"   \\n\\t  "}]}}',
    '{"type":"result","subtype":"success","is_error":false}',
  ];
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", mockScript(lines)]);
  const handle = await backend.spawn(makeAgent(), { prompt: "test" });
  const events = [];
  for await (const ev of handle.events(new AbortController().signal)) {
    events.push(ev);
  }
  const msg = events.find((e) => e.kind === "message" && e.role === "assistant");
  assert.ok(msg, "the whitespace-only assistant message was emitted");
  const done = events.find((e) => e.kind === "done");
  assert.equal(done?.reason, "completed");
  assert.equal(done?.marker, "completed_empty", "whitespace-only output does not suppress the marker");
});

test("M12-21: completion WITH a tool_use only (no text) → ordinary completed, NO marker", async () => {
  // An assistant turn whose only content is a tool_use (no text) still counts
  // as a usable effect — the worker took an action. The completion must NOT be
  // misread as completed-empty.
  const lines = [
    '{"type":"assistant","message":{"id":"m_tu","content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/x"}}]}}',
    '{"type":"result","subtype":"success","is_error":false}',
  ];
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", mockScript(lines)]);
  const handle = await backend.spawn(makeAgent(), { prompt: "test" });
  const events = [];
  for await (const ev of handle.events(new AbortController().signal)) {
    events.push(ev);
  }
  assert.ok(events.some((e) => e.kind === "tool_use"), "the tool_use evidence was emitted");
  const done = events.find((e) => e.kind === "done");
  assert.equal(done?.reason, "completed");
  assert.equal(done?.marker, undefined, "a tool_use effect suppresses the marker");
});

test("M12-21: failed done NEVER carries the completed_empty marker", async () => {
  // The marker is completion-only. A failed run keeps its failure shape.
  const lines = ['{"type":"result","subtype":"error","is_error":true,"result":"boom"}'];
  const backend = makeBackend(ClaudeStreamParser, () => ["-e", mockScript(lines)]);
  const handle = await backend.spawn(makeAgent(), { prompt: "test" });
  const events = [];
  for await (const ev of handle.events(new AbortController().signal)) {
    events.push(ev);
  }
  const done = events.find((e) => e.kind === "done");
  assert.equal(done?.reason, "failed", "error result → failed");
  assert.equal(done?.marker, undefined, "a failed done never carries the completion marker");
});

// ── M12-21: runEventIsUsableEffect predicate (the usable-effect definition) ──
//
// Pins the exact definition of "usable model effect" so the marker gate above
// cannot drift: the five evidence/effect kinds + non-empty assistant text count;
// transport-only signals (thinking / runtime_activity / metrics) and
// write_intent (containment telemetry, not a confirmed write) do NOT.

test("M12-21: DONE_MARKERS is the exact closed set [completed_empty]", () => {
  assert.deepEqual([...DONE_MARKERS], ["completed_empty"]);
});

test("M12-21: runEventIsUsableEffect — five effect kinds + non-blank assistant text count; transport does not", () => {
  // Usable effects.
  assert.equal(runEventIsUsableEffect(messageEvent("assistant", [{ type: "text", text: "hi" }])), true);
  assert.equal(runEventIsUsableEffect(commandEvent("ls", 0)), true);
  assert.equal(runEventIsUsableEffect(fileWrittenEvent("/p", {})), true);
  assert.equal(runEventIsUsableEffect(toolUseEvent("Read", {})), true);
  assert.equal(runEventIsUsableEffect(toolResultEvent("Read", "ok", false)), true);
  // NOT usable: empty-text / non-assistant messages.
  assert.equal(runEventIsUsableEffect(messageEvent("assistant", [{ type: "text", text: "" }])), false, "empty assistant text is not usable");
  assert.equal(runEventIsUsableEffect(messageEvent("assistant", [])), false, "no parts is not usable");
  assert.equal(runEventIsUsableEffect(messageEvent("user", [{ type: "text", text: "hi" }])), false, "user message is not a worker effect");
  // M12-21B: whitespace-only assistant text is NOT a usable effect — it must not
  // suppress the completed_empty marker. This matches assessRunEvidence._hasNonEmptyTextPart
  // (trim), so the live ProcessBackend marker decision and the historical evidence retrofit
  // cannot disagree on blank output.
  assert.equal(runEventIsUsableEffect(messageEvent("assistant", [{ type: "text", text: "   " }])), false, "whitespace-only assistant text is not usable");
  assert.equal(runEventIsUsableEffect(messageEvent("assistant", [{ type: "text", text: "\n\t  \r\n" }])), false, "newline/tab-only assistant text is not usable");
  assert.equal(runEventIsUsableEffect(messageEvent("assistant", [{ type: "text", text: "  " }, { type: "text", text: "ok" }])), true, "a non-blank part among blank parts is usable");

  // NOT usable: transport-only signals (runtime activity / thinking / metrics).
  assert.equal(runEventIsUsableEffect(runtimeActivityEvent("streaming")), false);
  assert.equal(runEventIsUsableEffect(thinkingEvent()), false);
  assert.equal(runEventIsUsableEffect(metricsEvent({ input: 1 })), false);
  // NOT usable: write_intent is containment telemetry, not a confirmed write.
  assert.equal(runEventIsUsableEffect({ kind: "write_intent", path: "/p", toolCallId: "t1", correlationStatus: "tracked" }), false);
  // NOT usable: garbage / missing.
  assert.equal(runEventIsUsableEffect(null), false);
  assert.equal(runEventIsUsableEffect(undefined), false);
  assert.equal(runEventIsUsableEffect({ kind: "no_such_kind" }), false);
});
