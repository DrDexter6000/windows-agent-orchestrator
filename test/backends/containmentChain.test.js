// test/backends/containmentChain.test.js
//
// 各后端"越界写 → 拦截"的确定性链式测试（进 npm test，零真实运行时、零网络、
// 零 token）。链路 = 协议帧 → 真实 parser / Backend（各后端自己的注入缝）→
// 真实 Run（带 deliveryContext，fixture 与 test/transcript/m12-4b-writeIntent.test.js
// 同形）→ runManager 的 delivery containment gate → 终态 failed、不进打包。
// 物理判定（junction / realpath）已在 test/registry-roles/m12-3-workdirContainment.test.js
// 门级覆盖，本文件不重测。
//
// 覆盖的后端与注入缝（每后端一组：越界用例 + 正对照 + 取键源级钉）：
//   claude-code     ClaudeStreamParser.feed()——投影词汇 write_intent + file_written
//                   两段；越界恒在 intent 段被拦（file_written 的 path 取自同一
//                   intent 帧捕获的 path，词法越界必然先在 intent 段判出）。
//   codex           CodexStreamParser.feed()——只有终态 file_written。
//   kimi-code       KimiCodeBackend + spawnFn 假子进程（解析器不产 done，经
//                   ProcessBackend 的 exit-0 兜底收口）；只有调用帧 file_written。
//   kimi-web        KimiWebBackend + fetchImpl 假服务器；只有终态 file_written。
//   zcode           ZcodeBackend + spawnFn 假 app-server；只有终态 file_written。
//   deepseek-acp    DeepSeekAcpBackend + 内存 peer.notify——write_intent +
//                   file_written 两段；越界同样恒在 intent 段被拦。
//   opencode-serve  OpenCodeServeBackend + fetchImpl 假服务器（构造器自带该
//                   注入缝，snapshot-stable 轮询可确定性驱动）；只有终态
//                   file_written。
//
// 不覆盖的后端（原因，不假装覆盖）：
//   claudeCodeProvider.js——只做 provider 包装的参数推导，不产出事件流；写事件
//     投影就是 claude-code 的 ClaudeStreamParser，上面已覆盖。
//   src/backends/ 其余模块（factory / kimiServe* / deepSeekHarness /
//     opencodeStopVerify / processActivity / stallBudget / processBackend 共享
//     传输层）——没有独立的写事件投影面；processBackend 的传输由 kimi-code 组
//     经真实类穿过。

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

import { KimiWebBackend } from "../../src/backends/kimiWeb.js";
import { ZcodeBackend } from "../../src/backends/zcode.js";
import { DeepSeekAcpBackend } from "../../src/backends/deepSeekAcp.js";
import { KimiCodeBackend } from "../../src/backends/kimiCode.js";
import { OpenCodeServeBackend } from "../../src/backends/opencodeServe.js";
import { ClaudeStreamParser } from "../../src/backends/parsers/claudeCode.js";
import { CodexStreamParser } from "../../src/backends/parsers/codex.js";
import { Run } from "../../src/runManager.js";
import { JsonlTranscript, readTranscript } from "../../src/transcript.js";

const KIMI_WEB_TOKEN_ENV = "KIMI_WEB_CONTAINMENT_TEST_TOKEN";

before(() => {
  process.env[KIMI_WEB_TOKEN_ENV] = "kimi-web-containment-test-token";
});

after(() => {
  delete process.env[KIMI_WEB_TOKEN_ENV];
});

// ===== 公共夹具：真实 Run（deliveryContext 开启 containment gate）=====

let runSeq = 0;

/**
 * 与 m12-4b 同形的 Run fixture：临时 delivery worktree + 临时 runs 目录 +
 * deliveryContext + 计数式 packageDeliveryFn（被调即抛固定 deliveryCode——
 * 证明"进没进打包"而不真打包）。spawnHandle 在目录就绪后取 handle，使各后端
 * 的注入缝能拿到真实 effectiveCwd / root。
 */
async function makeDeliveryRunFixture({ backendName, spawnHandle }) {
  const runId = `run_contain_chain_${backendName.replace(/-/g, "_")}_${++runSeq}`;
  const root = await mkdtemp(join(tmpdir(), `wao-contain-chain-${backendName}-`));
  const effectiveCwd = join(root, "delivery-worktree");
  await mkdir(effectiveCwd, { recursive: true });
  const runDir = join(root, "runs");
  const transcriptPath = join(runDir, `${runId}.jsonl`);
  const transcript = new JsonlTranscript(transcriptPath, {
    runId,
    agentId: `coder_${backendName.replace(/-/g, "_")}`,
  });
  await transcript.append("session.created", {
    backend: backendName,
    backendSessionId: `session_${runId}`,
  });
  const handle = await spawnHandle({ root, effectiveCwd, runId });
  let packageCount = 0;
  const run = new Run({
    runId,
    agentId: `coder_${backendName.replace(/-/g, "_")}`,
    agent: { id: `coder_${backendName.replace(/-/g, "_")}`, cwd: effectiveCwd },
    backend: {},
    handle,
    transcript,
    result: {
      backend: backendName,
      backendSessionId: `session_${runId}`,
      messageId: `message_${runId}`,
      admittedSeq: 1,
    },
    config: { runDir },
    onRemove: () => {},
    initialState: "submitted",
    effectiveCwd,
    deliveryContext: { runId },
    packageDeliveryFn: async () => {
      packageCount += 1;
      const error = new Error("fixture stops after containment check");
      error.deliveryCode = "empty_diff";
      throw error;
    },
  });
  return {
    root,
    effectiveCwd,
    transcriptPath,
    run,
    getPackageCount: () => packageCount,
  };
}

async function finishRun(fixture) {
  const result = await fixture.run.waitForCompletion({ pollInterval: 1 });
  const events = await readTranscript(fixture.transcriptPath);
  const rawTranscript = await readFile(fixture.transcriptPath, "utf8");
  return { result, events, rawTranscript };
}

async function cleanupFixture(fixture) {
  await rm(fixture.root, { recursive: true, force: true });
}

async function createInsideFile(effectiveCwd, relPath, content = "confirmed") {
  const abs = join(effectiveCwd, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  return abs;
}

/**
 * 越界用例的统一断言面：终态 failed、闭集 reason、违规事实不带 path、被拒的
 * 写事件本身不落 transcript、打包零调用。marker 是被拒路径里独有的子串——
 * deepseek-acp 例外（见其用例注释）。
 */
function assertEscapeBlocked(fixture, output, { eventKind, reason, marker }) {
  assert.equal(fixture.getPackageCount(), 0, "packager must not run on an escaped write");
  assert.equal(fixture.run.state, "failed");
  assert.equal(output.result.isolationViolation, true);
  const violation = output.events.find((event) => event.type === "run.isolation_violation");
  assert.deepEqual(
    {
      type: violation?.type,
      code: violation?.code,
      eventKind: violation?.eventKind,
      reason: violation?.reason,
    },
    {
      type: "run.isolation_violation",
      code: "workdir_escape",
      eventKind,
      reason,
    },
  );
  assert.ok(!Object.hasOwn(violation ?? {}, "path"), "violation fact never carries the rejected path");
  assert.ok(output.events.some(
    (event) => event.type === "run.error"
      && event.phase === "isolation"
      && event.code === "workdir_escape",
  ));
  assert.equal(
    output.events.filter(
      (event) => event.type === "run.event"
        && (event.kind === "file_written" || event.kind === "write_intent"),
    ).length,
    0,
    "the rejected write event itself is never persisted",
  );
  if (marker !== undefined) {
    assert.ok(!output.rawTranscript.includes(marker), "rejected path marker must not reach the transcript");
  }
}

/** 正对照的统一断言面：零违规、打包被调、file_written 落盘；按后端声明投影词汇。 */
function assertPositivePackaged(fixture, output, { expectWriteIntent }) {
  assert.equal(fixture.getPackageCount(), 1);
  assert.ok(!output.events.some((event) => event.type === "run.isolation_violation"));
  assert.equal(
    output.events.some((event) => event.type === "run.event" && event.kind === "write_intent"),
    expectWriteIntent,
  );
  assert.ok(output.events.some((event) => event.type === "run.event" && event.kind === "file_written"));
}

/** 源级钉：后端源码的取键链必须逐字仍在——后端改取键而夹具没跟，这里红。 */
function assertSourcePins(pins) {
  for (const [repoRelative, needle] of pins) {
    const text = readFileSync(new URL(`../../${repoRelative}`, import.meta.url), "utf8");
    assert.ok(
      text.includes(needle),
      `${repoRelative} must still extract the write path via: ${needle}`,
    );
  }
}

// ===== 共享 fake 子进程（zcode / deepseek-acp / kimi-code 三组的注入缝载体）=====

function fakeProcessChild(pid = 424200 + ++runSeq) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const originalOnce = child.once.bind(child);
  child.once = (event, listener) => {
    originalOnce(event, listener);
    if (event === "spawn") queueMicrotask(() => listener());
    return child;
  };
  child.end = (code = 0) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    child.emit("close", code, null);
  };
  child.kill = () => {
    child.end(1);
    return true;
  };
  return child;
}

const jsonFrame = (obj) => `${JSON.stringify(obj)}\n`;

// ===== claude-code：ClaudeStreamParser.feed() =====

function claudeChainHandle() {
  let eventFactory = async function* empty() {};
  const handle = {
    backend: "claude-code",
    backendSessionId: "session_claude_chain",
    events(...args) {
      return eventFactory(...args);
    },
    async abort() {},
  };
  return {
    handle,
    feedFrames(frames) {
      const parser = new ClaudeStreamParser();
      const parsed = parser.feed(frames.map(jsonFrame).join(""));
      eventFactory = async function* events() {
        yield* parsed;
      };
      return parsed;
    },
  };
}

test("containment chain / claude-code: 源级钉——intent 与 written 两段都取 input.file_path", () => {
  assertSourcePins([
    ["src/backends/parsers/claudeCode.js", "return writeIntentEvent(input.file_path, toolCallId, correlationStatus);"],
    ["src/backends/parsers/claudeCode.js", "events.push(fileWrittenEvent(pendingPath, { toolCallId }));"],
  ]);
});

for (const [label, pathFactory, marker] of [
  ["relative ../ escape", () => "../cc_escape_rel.js", "cc_escape_rel"],
  ["absolute outside escape", (fixture) => join(fixture.root, "outside-claude", "escaped.js"), "outside-claude"],
  // MSYS 盘符形（win32 上经 normalizeMsysDrivePath 归一后仍在本工作树之外；
  // 非 win32 上它是普通绝对路径，同样在工作树之外——两平台都是词法越界）。
  ["MSYS drive-letter escape", () => "/c/wao_msys_escape/cc_msys.js", "wao_msys_escape"],
]) {
  test(`containment chain / claude-code: ${label} → write_intent 段拦截，reason 闭集成员 write_intent_lexical_outside`, async () => {
    const chain = claudeChainHandle();
    const fixture = await makeDeliveryRunFixture({
      backendName: "claude-code",
      spawnHandle: () => chain.handle,
    });
    chain.feedFrames([
      { type: "assistant", message: { content: [{ type: "tool_use", id: "cc_esc", name: "Write", input: { file_path: pathFactory(fixture) } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "cc_esc", content: "ok", is_error: false }] } },
      { type: "result", subtype: "success", is_error: false },
    ]);
    try {
      const output = await finishRun(fixture);
      assertEscapeBlocked(fixture, output, {
        eventKind: "write_intent",
        reason: "write_intent_lexical_outside",
        marker,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });
}

test("containment chain / claude-code: 界内写正对照——intent 与 written 两段都落盘、path 逐字节保真、打包照常", async () => {
  const chain = claudeChainHandle();
  const fixture = await makeDeliveryRunFixture({
    backendName: "claude-code",
    spawnHandle: () => chain.handle,
  });
  await createInsideFile(fixture.effectiveCwd, "src/inside-claude.js");
  const parsed = chain.feedFrames([
    { type: "assistant", message: { content: [{ type: "tool_use", id: "cc_ok", name: "Write", input: { file_path: "src/inside-claude.js" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "cc_ok", content: "ok", is_error: false }] } },
    { type: "result", subtype: "success", is_error: false },
  ]);
  try {
    const output = await finishRun(fixture);
    assertPositivePackaged(fixture, output, { expectWriteIntent: true });
    const intent = output.events.find(
      (event) => event.type === "run.event" && event.kind === "write_intent",
    );
    const written = output.events.find(
      (event) => event.type === "run.event" && event.kind === "file_written",
    );
    assert.equal(intent?.path, "src/inside-claude.js", "intent path 与帧内原值逐字节相同");
    assert.equal(intent?.toolCallId, "cc_ok");
    assert.equal(written?.path, "src/inside-claude.js", "written path 与帧内原值逐字节相同");
    assert.equal(parsed.find((event) => event.kind === "file_written").path, "src/inside-claude.js");
  } finally {
    await cleanupFixture(fixture);
  }
});

// ===== codex：CodexStreamParser.feed() =====

function codexChainHandle(frames) {
  const parser = new CodexStreamParser();
  const parsed = parser.feed(frames.map(jsonFrame).join(""));
  return {
    backend: "codex",
    backendSessionId: "session_codex_chain",
    async *events() {
      yield* parsed;
    },
    async abort() {},
  };
}

const codexFileChangeFrame = (path) => ({
  type: "item.completed",
  item: { type: "file_change", changes: [{ kind: "add", path }] },
});

test("containment chain / codex: 源级钉——file_change 逐 change 取 ch.path 且只认写入类 kind", () => {
  assertSourcePins([
    ["src/backends/parsers/codex.js", "if (typeof ch.path === \"string\" && WRITE_KINDS.has(ch.kind)) {"],
    ["src/backends/parsers/codex.js", "events.push(fileWrittenEvent(ch.path));"],
  ]);
});

for (const [label, pathFactory, marker] of [
  ["relative ../ escape", () => "../codex_escape_rel.js", "codex_escape_rel"],
  ["absolute outside escape", ({ root }) => join(root, "outside-codex", "escaped.js"), "outside-codex"],
]) {
  test(`containment chain / codex: ${label} → file_written 段拦截，reason 闭集成员 file_written_lexical_outside`, async () => {
    const fixture = await makeDeliveryRunFixture({
      backendName: "codex",
      spawnHandle: ({ root }) => codexChainHandle([
        codexFileChangeFrame(pathFactory({ root })),
      ]),
    });
    try {
      const output = await finishRun(fixture);
      assertEscapeBlocked(fixture, output, {
        eventKind: "file_written",
        reason: "file_written_lexical_outside",
        marker,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });
}

test("containment chain / codex: 界内写正对照——file_written 落盘、path 逐字节保真、零 write_intent、打包照常", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "codex",
    spawnHandle: () => codexChainHandle([
      codexFileChangeFrame("src/inside-codex.js"),
      { type: "item.completed", item: { type: "agent_message", text: "wrote it" } },
      { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } },
    ]),
  });
  await createInsideFile(fixture.effectiveCwd, "src/inside-codex.js");
  try {
    const output = await finishRun(fixture);
    assertPositivePackaged(fixture, output, { expectWriteIntent: false });
    const written = output.events.find(
      (event) => event.type === "run.event" && event.kind === "file_written",
    );
    assert.equal(written?.path, "src/inside-codex.js", "path 与帧内原值逐字节相同");
  } finally {
    await cleanupFixture(fixture);
  }
});

// ===== kimi-code：KimiCodeBackend + spawnFn 假子进程 =====

const kimiCodeWriteCall = (callId, path) => ({
  role: "assistant",
  tool_calls: [{
    type: "function",
    id: callId,
    function: { name: "Write", arguments: JSON.stringify({ path }) },
  }],
});

async function kimiCodeScenario({ effectiveCwd, frames }) {
  const child = fakeProcessChild();
  const backend = new KimiCodeBackend({ spawnFn: () => child });
  const handle = await backend.spawn(
    { id: "coder_kimi_code", backend: "kimi-code", cwd: effectiveCwd, binary: process.execPath, model: { id: "kimi-code/k3" } },
    { prompt: "do the task" },
  );
  child.stdout.write(frames.map(jsonFrame).join(""));
  // 让 backend 的 stdout data 监听器先消化这些帧，再收进程（假子的 close 是同步
  // emit，不隔一个 tick 会抢在 data 事件之前关掉队列）。
  await delay(50);
  child.end(0);
  return handle;
}

test("containment chain / kimi-code: 源级钉——Write/Edit 取 args.path（arguments 二次 parse）", () => {
  assertSourcePins([
    ["src/backends/parsers/kimiCode.js", "return fileWrittenEvent(parsedArgs.path);"],
  ]);
});

for (const [label, pathFactory, marker] of [
  ["relative ../ escape", () => "../kimicode_escape_rel.js", "kimicode_escape_rel"],
  ["absolute outside escape", ({ root }) => join(root, "outside-kimicode", "escaped.js"), "outside-kimicode"],
]) {
  test(`containment chain / kimi-code: ${label} → file_written 段拦截，reason 闭集成员 file_written_lexical_outside`, async () => {
    const fixture = await makeDeliveryRunFixture({
      backendName: "kimi-code",
      spawnHandle: ({ effectiveCwd, root }) => kimiCodeScenario({
        effectiveCwd,
        frames: [
          kimiCodeWriteCall("kc_esc", pathFactory({ root })),
          { role: "tool", tool_call_id: "kc_esc", content: "wrote" },
          { role: "assistant", content: "done writing" },
        ],
      }),
    });
    try {
      const output = await finishRun(fixture);
      assertEscapeBlocked(fixture, output, {
        eventKind: "file_written",
        reason: "file_written_lexical_outside",
        marker,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });
}

test("containment chain / kimi-code: 界内写正对照——file_written 落盘、path 逐字节保真、零 write_intent、exit-0 兜底收口后打包照常", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "kimi-code",
    spawnHandle: ({ effectiveCwd }) => kimiCodeScenario({
      effectiveCwd,
      frames: [
        kimiCodeWriteCall("kc_ok", "out/inside-kimicode.txt"),
        { role: "tool", tool_call_id: "kc_ok", content: "wrote" },
        { role: "assistant", content: "done writing" },
      ],
    }),
  });
  await createInsideFile(fixture.effectiveCwd, "out/inside-kimicode.txt");
  try {
    const output = await finishRun(fixture);
    assertPositivePackaged(fixture, output, { expectWriteIntent: false });
    const written = output.events.find(
      (event) => event.type === "run.event" && event.kind === "file_written",
    );
    assert.equal(written?.path, "out/inside-kimicode.txt", "path 与帧内原值逐字节相同");
  } finally {
    await cleanupFixture(fixture);
  }
});

// ===== kimi-web：KimiWebBackend + fetchImpl 假服务器 =====

function kimiJsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return value;
    },
    async text() {
      return JSON.stringify(value);
    },
  };
}

const kimiEnvelope = (data) => kimiJsonResponse({ code: 0, msg: "", data });
const kimiDetailEnvelope = (sessionId) => kimiEnvelope({
  id: sessionId,
  busy: false,
  main_turn_active: false,
  last_turn_reason: null,
  usage: {},
});
const kimiTranscriptEnvelope = (items) => kimiEnvelope({ items, seq: 7, has_more: false });

/** completed 轮夹具：steps[].frames 里一个终态 Write tool 帧 + assistant text。 */
function kimiWriteTurn({ input, prompt = "do the task" }) {
  return {
    kind: "turn",
    turnId: "t0",
    triggerPromptId: "msg_q1",
    ordinal: 0,
    state: "completed",
    prompt,
    endedAt: "2026-10-16T12:00:00.000Z",
    durationMs: 1234,
    error: null,
    steps: [{
      stepId: "s0",
      turnId: "t0",
      ordinal: 0,
      state: "completed",
      usage: { inputOther: 10, output: 4, inputCacheRead: 1, inputCacheCreation: 1 },
      llmTiming: { firstTokenMs: 120, totalMs: 900 },
      frames: [
        {
          kind: "tool",
          frameId: "f_w",
          toolCallId: "tc_write",
          name: "Write",
          state: "done",
          input,
          output: "wrote",
        },
        { kind: "text", text: "wrote the file", role: "assistant" },
      ],
    }],
  };
}

/**
 * spawn 阶段路由 + 事件轮脚本：提交前 transcript 读返回空；markSpawned() 之后
 * 每拍回放 script（同 test/backends/kimiWeb.test.js 的 turnScriptServer 形状）。
 */
function kimiWebServer(sessionId, { script = [] } = {}) {
  let spawned = false;
  const fetchImpl = async (url) => {
    const urlStr = String(url);
    if (urlStr === `http://127.0.0.1:4311/api/v1/sessions`) return kimiEnvelope({ id: sessionId });
    if (urlStr === `http://127.0.0.1:4311/api/v1/sessions/${sessionId}`) {
      return kimiDetailEnvelope(sessionId);
    }
    if (urlStr === `http://127.0.0.1:4311/api/v1/sessions/${sessionId}/transcript?agent_id=main`) {
      if (!spawned) return kimiTranscriptEnvelope([]);
      return kimiTranscriptEnvelope(script);
    }
    if (urlStr.endsWith(`/api/v1/sessions/${sessionId}/prompts`)) {
      return kimiEnvelope({ prompt_id: "msg_q1", status: "running" });
    }
    throw new Error(`unexpected ${urlStr}`);
  };
  return { fetchImpl, markSpawned: () => { spawned = true; } };
}

async function kimiWebScenario({ effectiveCwd, writeInput }) {
  const { fetchImpl, markSpawned } = kimiWebServer("session_kimiweb_chain", {
    script: [kimiWriteTurn({ input: writeInput })],
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(
    {
      id: "coder_kimiweb",
      backend: "kimi-web",
      serveUrl: "http://127.0.0.1:4311",
      cwd: effectiveCwd,
      model: { id: "kimi-code/k3" },
      tokenEnv: KIMI_WEB_TOKEN_ENV,
    },
    { prompt: "do the task" },
  );
  markSpawned();
  return handle;
}

test("containment chain / kimi-web: 源级钉——写路径取键链 filePath ?? file_path ?? path（kimiWritePath 与终态投影同链）", () => {
  assertSourcePins([
    ["src/backends/kimiWeb.js", "const filePath = input.filePath ?? input.file_path ?? input.path;"],
  ]);
});

for (const [label, pathFactory, marker] of [
  ["relative ../ escape", () => "../kimieweb_escape_rel.txt", "kimieweb_escape_rel"],
  ["absolute outside escape", (fixture) => join(fixture.root, "outside-kimieweb", "escaped.txt"), "outside-kimieweb"],
]) {
  test(`containment chain / kimi-web: ${label} → file_written 段拦截，reason 闭集成员 file_written_lexical_outside`, async () => {
    const fixture = await makeDeliveryRunFixture({
      backendName: "kimi-web",
      spawnHandle: ({ effectiveCwd, root }) => kimiWebScenario({
        effectiveCwd,
        writeInput: { filePath: pathFactory({ root }) },
      }),
    });
    try {
      const output = await finishRun(fixture);
      assertEscapeBlocked(fixture, output, {
        eventKind: "file_written",
        reason: "file_written_lexical_outside",
        marker,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });
}

test("containment chain / kimi-web: 界内写正对照——filePath 优先于 file_path/path 双诱饵、path 逐字节保真、零 write_intent、打包照常", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "kimi-web",
    spawnHandle: ({ effectiveCwd }) => kimiWebScenario({
      effectiveCwd,
      writeInput: {
        filePath: "out/inside-kimieweb.txt",
        file_path: "out/decoy-a-kimieweb.txt",
        path: "out/decoy-b-kimieweb.txt",
      },
    }),
  });
  await createInsideFile(fixture.effectiveCwd, "out/inside-kimieweb.txt");
  try {
    const output = await finishRun(fixture);
    assertPositivePackaged(fixture, output, { expectWriteIntent: false });
    const written = output.events.find(
      (event) => event.type === "run.event" && event.kind === "file_written",
    );
    assert.equal(written?.path, "out/inside-kimieweb.txt", "取键链首选 filePath，path 与帧内原值逐字节相同");
    assert.notEqual(written?.path, "out/decoy-a-kimieweb.txt");
    assert.notEqual(written?.path, "out/decoy-b-kimieweb.txt");
  } finally {
    await cleanupFixture(fixture);
  }
});

// ===== zcode：ZcodeBackend + spawnFn 假 app-server =====

const ZCODE_SESSION_ID = "sess_zcode_chain";

let zcodeFixtureSeq = 0;
const zcodeFixtureId = (pfx) => `${pfx}_zc_${String(++zcodeFixtureSeq).padStart(4, "0")}`;
let zcodeLastUserId = null;
const zcodeUserMsg = (text) => {
  const id = zcodeFixtureId("msg");
  zcodeLastUserId = id;
  return { role: "user", info: { id, role: "user" }, parts: [{ type: "text", text, id: zcodeFixtureId("part"), messageID: id }] };
};
const zcodeAssistantPartsMsg = (parts) => {
  const id = zcodeFixtureId("msg");
  return {
    role: "assistant",
    info: { id, role: "assistant", ...(zcodeLastUserId !== null ? { parentID: zcodeLastUserId } : {}) },
    parts: parts.map((part) => ({ id: zcodeFixtureId("part"), messageID: id, ...part })),
  };
};

const zcodeWritePart = ({ callId, input }) => ({
  id: `part_${callId}`,
  sessionID: ZCODE_SESSION_ID,
  messageID: "msg_tool_1",
  type: "tool",
  callId,
  tool: "Write",
  state: {
    status: "completed",
    input,
    output: "wrote",
    title: "done",
    metadata: {},
    startedAt: 1,
    completedAt: 2,
  },
});

/** 假 app-server：create/setModel/setMode/send/usage/stop 全应答；messages 按脚本。 */
function fakeZcodePeer(child, { messages = () => [] } = {}) {
  const activeSessions = new Set();
  const clientFrames = [];
  let polls = 0;
  const send = (obj) => child.stdout.write(jsonFrame(obj));
  const requireActive = (frame) => {
    if (!activeSessions.has(frame.params?.sessionId)) return false;
    return true;
  };
  const lines = readline.createInterface({ input: child.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const frame = JSON.parse(line);
    clientFrames.push(frame);
    if (frame.method === undefined) return;
    if (frame.method === "session/create") {
      activeSessions.add(ZCODE_SESSION_ID);
      send({
        id: frame.id,
        result: {
          session: { sessionId: ZCODE_SESSION_ID, model: "glm-5.3" },
          settings: { model: { available: [{ ref: { providerId: "bigmodel-api", modelId: "GLM-5.3" } }] } },
          projection: { status: "ready" },
        },
      });
      return;
    }
    if (frame.method === "session/setModel" || frame.method === "session/setMode") {
      if (!requireActive(frame)) return;
      send({ id: frame.id, result: {} });
      return;
    }
    if (frame.method === "session/send") {
      if (!requireActive(frame)) return;
      send({ id: frame.id, result: { accepted: true, stateRevision: 7 } });
      return;
    }
    if (frame.method === "session/messages") {
      if (!requireActive(frame)) return;
      polls += 1;
      send({ id: frame.id, result: { messages: messages(polls) } });
      return;
    }
    if (frame.method === "session/usage") {
      if (!requireActive(frame)) return;
      send({
        id: frame.id,
        result: { totalTokens: 101, inputTokens: 60, outputTokens: 30, reasoningTokens: 5, cacheReadTokens: 4, cacheCreationTokens: 2, modelRequestCount: 2 },
      });
      return;
    }
    if (frame.method === "session/stop") {
      if (!requireActive(frame)) return;
      send({ id: frame.id, result: { stopped: true } });
      return;
    }
    send({ id: frame.id, result: {} });
  });
  return { clientFrames, notify: (method, params) => send({ method, params }) };
}

async function zcodeScenario({ effectiveCwd, writeInput }) {
  const child = fakeProcessChild();
  const killCalls = [];
  const backend = new ZcodeBackend({
    spawnFn: () => child,
    killFn: (victim) => {
      killCalls.push(victim);
      victim.kill();
    },
  });
  fakeZcodePeer(child, {
    messages: (n) => (n <= 1 ? [] : [
      zcodeUserMsg("do the task"),
      zcodeAssistantPartsMsg([
        zcodeWritePart({ callId: "call_zc_write", input: writeInput }),
        { type: "text", text: "wrote the file" },
        { type: "step-finish", reason: "stop", tokens: {} },
      ]),
    ]),
  });
  const handle = await backend.spawn(
    {
      id: "coder_zcode",
      backend: "zcode",
      cwd: effectiveCwd,
      binary: "C:\\Users\\wao\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs",
      model: { id: "bigmodel-api/GLM-5.3" },
    },
    { prompt: "do the task" },
  );
  return handle;
}

test("containment chain / zcode: 源级钉——写路径取键链 filePath ?? file_path ?? path", () => {
  assertSourcePins([
    ["src/backends/zcode.js", "const filePath = input.filePath ?? input.file_path ?? input.path;"],
  ]);
});

for (const [label, pathFactory, marker] of [
  ["relative ../ escape", () => "../zcode_escape_rel.js", "zcode_escape_rel"],
  ["absolute outside escape", (fixture) => join(fixture.root, "outside-zcode", "escaped.js"), "outside-zcode"],
]) {
  test(`containment chain / zcode: ${label} → file_written 段拦截，reason 闭集成员 file_written_lexical_outside`, async () => {
    const fixture = await makeDeliveryRunFixture({
      backendName: "zcode",
      spawnHandle: ({ effectiveCwd, root }) => zcodeScenario({
        effectiveCwd,
        writeInput: { filePath: pathFactory({ root }) },
      }),
    });
    try {
      const output = await finishRun(fixture);
      assertEscapeBlocked(fixture, output, {
        eventKind: "file_written",
        reason: "file_written_lexical_outside",
        marker,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });
}

test("containment chain / zcode: 界内写正对照——filePath 优先于 file_path/path 双诱饵、path 逐字节保真、零 write_intent、打包照常", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "zcode",
    spawnHandle: ({ effectiveCwd }) => zcodeScenario({
      effectiveCwd,
      writeInput: {
        filePath: "out/inside-zcode.js",
        file_path: "out/decoy-a-zcode.js",
        path: "out/decoy-b-zcode.js",
      },
    }),
  });
  await createInsideFile(fixture.effectiveCwd, "out/inside-zcode.js");
  try {
    const output = await finishRun(fixture);
    assertPositivePackaged(fixture, output, { expectWriteIntent: false });
    const written = output.events.find(
      (event) => event.type === "run.event" && event.kind === "file_written",
    );
    assert.equal(written?.path, "out/inside-zcode.js", "取键链首选 filePath，path 与帧内原值逐字节相同");
    assert.notEqual(written?.path, "out/decoy-a-zcode.js");
    assert.notEqual(written?.path, "out/decoy-b-zcode.js");
  } finally {
    await cleanupFixture(fixture);
  }
});

// ===== deepseek-acp：DeepSeekAcpBackend + 内存 peer.notify =====

const ACP_REFERENCE_CONTAINMENT = readFileSync(
  new URL("../../scripts/reliability/dsh-acp/wao-contain-safe.patch.yml", import.meta.url),
  "utf8",
);

/** fake ACP 对端（最小握手 + 记录 + notify/respond），形状同 test/backends/deepSeekAcp.test.js。 */
function fakeAcpPeer(child, { sessionId = "sess-acp-chain" } = {}) {
  const clientRequests = [];
  const send = (obj) => child.stdout.write(jsonFrame(obj));
  const lines = readline.createInterface({ input: child.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (!message.method) return;
    clientRequests.push(message);
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            agentInfo: { name: "deepseek-harness-acp", version: "0.0.1" },
            sessionCapabilities: { close: {}, list: {}, resume: {} },
          },
        },
      });
    } else if (message.method === "session/new") {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    } else if (message.method === "session/close") {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      child.end(0);
    } else if (message.method === "session/cancel") {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  });
  return {
    clientRequests,
    sessionId,
    respond(id, result) {
      send({ jsonrpc: "2.0", id, result });
    },
    notify(update, sid = sessionId) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update } });
    },
  };
}

async function acpScenario({ effectiveCwd, drive }) {
  const dir = await mkdtemp(join(tmpdir(), "wao-contain-chain-acp-"));
  const containmentPath = join(dir, "wao-contain.patch.yml");
  await writeFile(containmentPath, ACP_REFERENCE_CONTAINMENT, "utf8");
  const child = fakeProcessChild();
  const backend = new DeepSeekAcpBackend({ containmentPatchPath: containmentPath, spawnFn: () => child });
  const peer = fakeAcpPeer(child);
  const handle = await backend.spawn(
    {
      id: "coder_low_dsh",
      backend: "deepseek-acp",
      cwd: effectiveCwd,
      binary: "D:/wao-test/dsh-acp-stub.exe",
      credentialEnv: "DEEPSEEK_API_KEY",
    },
    { prompt: "do the task" },
  );
  const promptRequest = () => peer.clientRequests.find((message) => message.method === "session/prompt");
  await drive({ peer, promptRequest });
  return { handle, peer, dir };
}

test("containment chain / deepseek-acp: 源级钉——写路径取键链 file_path ?? path ?? filePath（rawInput parse 后）", () => {
  assertSourcePins([
    ["src/backends/deepSeekAcp.js", "const filePath = input.file_path ?? input.path ?? input.filePath;"],
  ]);
});

for (const [label, pathFactory, marker] of [
  ["relative ../ escape", () => "../acp_escape_intent_rel.txt", "acp_escape_intent_rel"],
  ["absolute outside escape", (fixture) => join(fixture.root, "outside-acp", "escaped.txt"), "outside-acp"],
]) {
  test(`containment chain / deepseek-acp: ${label} → write_intent 段拦截，reason 闭集成员 write_intent_lexical_outside`, async () => {
    let scenario = null;
    const fixture = await makeDeliveryRunFixture({
      backendName: "deepseek-acp",
      spawnHandle: async ({ effectiveCwd, root }) => {
        scenario = await acpScenario({
          effectiveCwd,
          drive: async ({ peer, promptRequest }) => {
            peer.notify({
              sessionUpdate: "tool_call",
              toolCallId: "call_acp_esc",
              title: "write",
              kind: "other",
              status: "in_progress",
              rawInput: { file_path: pathFactory({ root }), content: "payload" },
            });
            peer.respond(promptRequest().id, { stopReason: "end_turn", usage: null });
          },
        });
        return scenario.handle;
      },
    });
    try {
      const output = await finishRun(fixture);
      assertEscapeBlocked(fixture, output, {
        eventKind: "write_intent",
        reason: "write_intent_lexical_outside",
        marker,
      });
      const violation = output.events.find((event) => event.type === "run.isolation_violation");
      assert.ok(!JSON.stringify(violation ?? {}).includes(marker));
    } finally {
      await cleanupFixture(fixture);
      if (scenario) await rm(scenario.dir, { recursive: true, force: true });
    }
  });
}

test("containment chain / deepseek-acp: 界内写正对照——file_path 优先于 path/filePath 双诱饵、intent 与 written 两段 path 逐字节保真、打包照常", async () => {
  let scenario = null;
  const fixture = await makeDeliveryRunFixture({
    backendName: "deepseek-acp",
    spawnHandle: async ({ effectiveCwd }) => {
      scenario = await acpScenario({
        effectiveCwd,
        drive: async ({ peer, promptRequest }) => {
          peer.notify({
            sessionUpdate: "tool_call",
            toolCallId: "call_acp_ok",
            title: "write",
            kind: "other",
            status: "in_progress",
            rawInput: {
              file_path: "out/inside-acp.txt",
              path: "out/decoy-a-acp.txt",
              filePath: "out/decoy-b-acp.txt",
              content: "payload",
            },
          });
          peer.notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "call_acp_ok",
            status: "completed",
            content: [{ type: "text", text: "written" }],
          });
          peer.respond(promptRequest().id, { stopReason: "end_turn", usage: null });
        },
      });
      return scenario.handle;
    },
  });
  await createInsideFile(fixture.effectiveCwd, "out/inside-acp.txt");
  try {
    const output = await finishRun(fixture);
    assertPositivePackaged(fixture, output, { expectWriteIntent: true });
    const intent = output.events.find(
      (event) => event.type === "run.event" && event.kind === "write_intent",
    );
    const written = output.events.find(
      (event) => event.type === "run.event" && event.kind === "file_written",
    );
    assert.equal(intent?.path, "out/inside-acp.txt", "取键链首选 file_path，path 与帧内原值逐字节相同");
    assert.equal(intent?.toolCallId, "call_acp_ok");
    assert.equal(intent?.correlationStatus, "tracked");
    assert.equal(written?.path, "out/inside-acp.txt", "written path 与 intent 捕获值逐字节相同");
  } finally {
    await cleanupFixture(fixture);
    if (scenario) await rm(scenario.dir, { recursive: true, force: true });
  }
});

// ===== opencode-serve：OpenCodeServeBackend + fetchImpl 假服务器 =====

function opencodeJsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return value;
    },
    async text() {
      return JSON.stringify(value);
    },
  };
}

function opencodeServer({ messagePolls }) {
  const fetchImpl = async (url, init = {}) => {
    const urlStr = String(url);
    if (urlStr === "http://127.0.0.1:4313/api/session" && init.method === "POST") {
      return opencodeJsonResponse({
        data: {
          id: "ses_oc_chain",
          location: { directory: "D:/projects/worktree" },
          title: "",
          projectID: "global",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
        },
      });
    }
    if (urlStr.includes("/session/ses_oc_chain/prompt_async")) {
      return opencodeJsonResponse({}, 204);
    }
    if (urlStr.includes("/session/ses_oc_chain/message")) {
      return opencodeJsonResponse(messagePolls());
    }
    if (urlStr.includes("/session/ses_oc_chain/abort")) {
      return opencodeJsonResponse({}, 204);
    }
    if (urlStr.includes("/session/status")) {
      return opencodeJsonResponse({});
    }
    if (urlStr.includes("/session/ses_oc_chain")) {
      return opencodeJsonResponse({
        id: "ses_oc_chain",
        tokens: { input: 5, output: 2, reasoning: 0 },
        cost: 0,
      });
    }
    throw new Error(`unexpected ${urlStr}`);
  };
  return { fetchImpl };
}

const opencodeWriteMsgs = (input) => ([
  { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "do the task" }] },
  {
    info: { id: "a1", role: "assistant" },
    parts: [
      {
        type: "tool",
        callID: "call_oc_write",
        tool: "write",
        state: { status: "completed", input, output: "wrote" },
      },
      { type: "text", text: "wrote the file" },
    ],
  },
]);

async function opencodeScenario({ effectiveCwd, writeInput }) {
  const { fetchImpl } = opencodeServer({
    // snapshot-stable：第 1 拍空（无 assistant），第 2 拍出现、第 3 拍同快照 → 完成。
    messagePolls: (() => {
      let polls = 0;
      return () => {
        polls += 1;
        return polls <= 1 ? [] : opencodeWriteMsgs(writeInput);
      };
    })(),
  });
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  return backend.spawn(
    {
      id: "coder_opencode",
      backend: "opencode-serve",
      serveUrl: "http://127.0.0.1:4313",
      agent: "build",
      cwd: effectiveCwd,
      model: { providerID: "zhipuai-coding-plan", id: "glm-5.1" },
    },
    { prompt: "do the task" },
  );
}

test("containment chain / opencode-serve: 源级钉——写路径取键链 filePath ?? file_path ?? path", () => {
  assertSourcePins([
    ["src/backends/opencodeServe.js", "const filePath = input.filePath ?? input.file_path ?? input.path;"],
  ]);
});

for (const [label, pathFactory, marker] of [
  ["relative ../ escape", () => "../opencode_escape_rel.txt", "opencode_escape_rel"],
  ["absolute outside escape", (fixture) => join(fixture.root, "outside-opencode", "escaped.txt"), "outside-opencode"],
]) {
  test(`containment chain / opencode-serve: ${label} → file_written 段拦截，reason 闭集成员 file_written_lexical_outside`, async () => {
    const fixture = await makeDeliveryRunFixture({
      backendName: "opencode-serve",
      spawnHandle: ({ effectiveCwd, root }) => opencodeScenario({
        effectiveCwd,
        writeInput: { filePath: pathFactory({ root }) },
      }),
    });
    try {
      const output = await finishRun(fixture);
      assertEscapeBlocked(fixture, output, {
        eventKind: "file_written",
        reason: "file_written_lexical_outside",
        marker,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });
}

test("containment chain / opencode-serve: 界内写正对照——filePath 优先于 file_path/path 双诱饵、path 逐字节保真、零 write_intent、打包照常", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "opencode-serve",
    spawnHandle: ({ effectiveCwd }) => opencodeScenario({
      effectiveCwd,
      writeInput: {
        filePath: "out/inside-opencode.txt",
        file_path: "out/decoy-a-opencode.txt",
        path: "out/decoy-b-opencode.txt",
      },
    }),
  });
  await createInsideFile(fixture.effectiveCwd, "out/inside-opencode.txt");
  try {
    const output = await finishRun(fixture);
    assertPositivePackaged(fixture, output, { expectWriteIntent: false });
    const written = output.events.find(
      (event) => event.type === "run.event" && event.kind === "file_written",
    );
    assert.equal(written?.path, "out/inside-opencode.txt", "取键链首选 filePath，path 与帧内原值逐字节相同");
    assert.notEqual(written?.path, "out/decoy-a-opencode.txt");
    assert.notEqual(written?.path, "out/decoy-b-opencode.txt");
  } finally {
    await cleanupFixture(fixture);
  }
});
