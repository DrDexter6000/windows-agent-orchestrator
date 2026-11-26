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
//   codex 传输层    CodexBackend + spawnFn 假子进程——同一 codex 事件经
//                   ProcessBackend 共享传输层穿真实类；帧不带 turn.completed，
//                   经 exit-0 兜底收口（本文件唯一穿过共享传输层的组）。
//   kimi-web        KimiWebBackend + fetchImpl 假服务器；只有终态 file_written。
//   zcode           ZcodeBackend + spawnFn 假 app-server；只有终态 file_written。
//   deepseek-acp    DeepSeekAcpBackend + 内存 peer.notify——write_intent +
//                   file_written 两段；越界同样恒在 intent 段被拦。
//
// 不覆盖的后端（原因，不假装覆盖）：
//   src/backends/ 其余模块（factory / kimiServe* /
//     serveStopVerify / processActivity / stallBudget）——没有独立的写事件投影面；
//     processBackend 的共享传输层由 codex 传输层组经真实类穿过。

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
import { CodexBackend } from "../../src/backends/codex.js";
import { ClaudeStreamParser } from "../../src/backends/parsers/claudeCode.js";
import { CodexStreamParser } from "../../src/backends/parsers/codex.js";
import { Run } from "../../src/runManager.js";
import { ISOLATION_DESTINATIONS } from "../../src/diagnosis.js";
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
 * 越界用例的统一断言面：终态 failed、闭集 reason、越界类违规事实不带未解析类
 * path 字段、被拒的写事件本身不落 transcript、打包零调用。marker 是被拒路径里
 * 独有的子串——TD-373 起 confirmed-outside 事实会记录脱敏后的上报路径，所以
 * marker 现在应当出现在 reportedPath 里（不是"不得出现"）。
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
  assert.ok(!Object.hasOwn(violation ?? {}, "path"), "outside facts never carry the unresolved path field");
  assert.ok(ISOLATION_DESTINATIONS.includes(violation?.destination), "TD-373 destination is a closed-set member");
  assert.equal(typeof violation?.reportedPath, "string", "TD-373 recorded path is present");
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
    assert.ok(violation.reportedPath.includes(marker),
      "TD-373: the redacted worker-reported path reaches the violation fact");
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

// ===== 共享 fake 子进程（zcode / deepseek-acp / codex 传输层三组的注入缝载体）=====

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
  // TD-357: file_change carries the upstream-required PatchApplyStatus; only
  // "completed" is a confirmed write (this helper models a successful patch).
  item: { type: "file_change", changes: [{ kind: "add", path }], status: "completed" },
});

test("containment chain / codex: 源级钉——file_change 逐 change 取 ch.path 且只认写入类 kind", () => {
  assertSourcePins([
    ["src/backends/parsers/codex.js", "if (typeof ch.path === \"string\" && WRITE_KINDS.has(ch.kind)) {"],
    ["src/backends/parsers/codex.js", "? fileWrittenEvent(ch.path)"],
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

// ===== codex 传输层：CodexBackend + spawnFn 假子进程（穿 ProcessBackend 共享传输层）=====

async function codexTransportScenario({ effectiveCwd, frames }) {
  const child = fakeProcessChild();
  const backend = new CodexBackend({ spawnFn: () => child });
  const handle = await backend.spawn(
    { id: "coder_codex_transport", backend: "codex", cwd: effectiveCwd, binary: process.execPath },
    { prompt: "do the task" },
  );
  child.stdout.write(frames.map(jsonFrame).join(""));
  // 让 backend 的 stdout data 监听器先消化这些帧，再收进程（假子的 close 是同步
  // emit，不隔一个 tick 会抢在 data 事件之前关掉队列）。帧不带 turn.completed——
  // done 经 ProcessBackend 的 exit-0 兜底收口，正是本组要穿的共享路径。
  await delay(50);
  child.end(0);
  return handle;
}

test("containment chain / codex 传输层: 源级钉——exit-0 兜底收口（无 done 时按退出码收口）", () => {
  assertSourcePins([
    ["src/backends/processBackend.js", 'yield doneEvent("completed", undefined, hasUsableEffect ? undefined : completedEmptyMarker);'],
  ]);
});

for (const [label, pathFactory, marker] of [
  ["relative ../ escape", () => "../codex_transport_escape_rel.js", "codex_transport_escape_rel"],
  ["absolute outside escape", ({ root }) => join(root, "outside-codex-transport", "escaped.js"), "outside-codex-transport"],
]) {
  test(`containment chain / codex 传输层: ${label} → file_written 段拦截，reason 闭集成员 file_written_lexical_outside`, async () => {
    const fixture = await makeDeliveryRunFixture({
      backendName: "codex",
      spawnHandle: ({ effectiveCwd, root }) => codexTransportScenario({
        effectiveCwd,
        frames: [
          codexFileChangeFrame(pathFactory({ root })),
          { type: "item.completed", item: { type: "agent_message", text: "wrote it" } },
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

test("containment chain / codex 传输层: 界内写正对照——file_written 落盘、path 逐字节保真、零 write_intent、exit-0 兜底收口后打包照常", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "codex",
    spawnHandle: ({ effectiveCwd }) => codexTransportScenario({
      effectiveCwd,
      frames: [
        codexFileChangeFrame("out/inside-codex-transport.txt"),
        { type: "item.completed", item: { type: "agent_message", text: "wrote it" } },
      ],
    }),
  });
  await createInsideFile(fixture.effectiveCwd, "out/inside-codex-transport.txt");
  try {
    const output = await finishRun(fixture);
    assertPositivePackaged(fixture, output, { expectWriteIntent: false });
    const written = output.events.find(
      (event) => event.type === "run.event" && event.kind === "file_written",
    );
    assert.equal(written?.path, "out/inside-codex-transport.txt", "path 与帧内原值逐字节相同");
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
const kimiTurnsEnvelope = (turns) => kimiEnvelope({ turns, has_more: false });

/**
 * ended/completed 轮夹具（kimi 2.6.3 turns 形状）：一个终态 Write tool_call 条目 +
 * assistant_message。写路径取 display.path（实测为绝对路径），没有再取 input.path。
 */
function kimiWriteTurn({ displayPath, inputPath, prompt = "do the task" }) {
  return {
    turn_id: "t_chain",
    ordinal: 0,
    kind: "agent",
    status: "ended",
    outcome: "completed",
    steps: [{
      index: 1,
      outcome: "completed",
      finish_reason: "end_turn",
      usage: { input_other: 10, output: 4, input_cache_read: 1, input_cache_creation: 1 },
    }],
    items: [
      { type: "user_message", item_id: "msg_q1", prompt_ids: ["msg_q1"], placement: "opener", text: prompt },
      {
        type: "tool_call",
        item_id: "tool_write",
        step_index: 1,
        status: "ended",
        name: "Write",
        input: { ...(inputPath === undefined ? {} : { path: inputPath }), content: "x" },
        display: { kind: "file_io", operation: "write", ...(displayPath === undefined ? {} : { path: displayPath }) },
        outcome: "completed",
        output: "wrote",
      },
      { type: "assistant_message", item_id: "a_1", step_index: 1, text: "wrote the file" },
    ],
    usage: { input_other: 10, output: 4, input_cache_read: 1, input_cache_creation: 1 },
  };
}

/**
 * spawn 阶段路由 + 事件轮脚本：提交前 turns 读返回空；markSpawned() 之后每拍回放
 * script；prompts 列表恒空（同 test/fixtures/kimiWebServe.js 的 turnScriptServer 形状）。
 */
function kimiWebServer(sessionId, { script = [] } = {}) {
  let spawned = false;
  let turnReads = 0;
  const fetchImpl = async (url, init = {}) => {
    const urlStr = String(url);
    const base = `http://127.0.0.1:4311/api/v1/sessions`;
    if (urlStr === base) return kimiEnvelope({ id: sessionId });
    if (urlStr === `${base}/${sessionId}`) return kimiDetailEnvelope(sessionId);
    if (urlStr === `${base}/${sessionId}/agents/main/turns`) {
      if (!spawned) return kimiTurnsEnvelope([]);
      // script 可以是按"提交后第几次读 turns"给快照的函数（TD-361 的在途→收口时序）。
      turnReads += 1;
      return kimiTurnsEnvelope(typeof script === "function" ? script(turnReads) : script);
    }
    if (urlStr === `${base}/${sessionId}/prompts`) {
      if ((init.method ?? "GET") === "GET") return kimiEnvelope({ active: null, queued: [] });
      return kimiEnvelope({ prompt_id: "msg_q1", user_message_id: "msg_q1", status: "running" });
    }
    throw new Error(`unexpected ${urlStr}`);
  };
  return { fetchImpl, markSpawned: () => { spawned = true; } };
}

async function kimiWebScenario({ effectiveCwd, write, script }) {
  const { fetchImpl, markSpawned } = kimiWebServer("session_kimiweb_chain", {
    script: script ?? [kimiWriteTurn(write)],
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

test("containment chain / kimi-web: 源级钉——写路径取 display.path，没有再取 input.path（在途预告与终态投影同一函数）", () => {
  assertSourcePins([
    ["src/backends/kimiWeb.js", "const displayPath = item?.display?.path;"],
    ["src/backends/kimiWeb.js", "const inputPath = item?.input?.path;"],
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
        write: { displayPath: pathFactory({ root }) },
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

test("containment chain / kimi-web: 界内写正对照——display.path 优先于 input.path 诱饵、path 逐字节保真、零 write_intent、打包照常", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "kimi-web",
    spawnHandle: ({ effectiveCwd }) => kimiWebScenario({
      effectiveCwd,
      write: { displayPath: "out/inside-kimieweb.txt", inputPath: "out/decoy-kimieweb.txt" },
    }),
  });
  await createInsideFile(fixture.effectiveCwd, "out/inside-kimieweb.txt");
  try {
    const output = await finishRun(fixture);
    assertPositivePackaged(fixture, output, { expectWriteIntent: false });
    const written = output.events.find(
      (event) => event.type === "run.event" && event.kind === "file_written",
    );
    assert.equal(written?.path, "out/inside-kimieweb.txt", "取 display.path，path 与条目原值逐字节相同");
    assert.notEqual(written?.path, "out/decoy-kimieweb.txt");
  } finally {
    await cleanupFixture(fixture);
  }
});

test("containment chain / kimi-web: display.path 缺席时取 input.path——界外相对路径同样在 file_written 段拦截", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "kimi-web",
    spawnHandle: ({ effectiveCwd }) => kimiWebScenario({
      effectiveCwd,
      write: { inputPath: "../kimieweb_escape_input.txt" },
    }),
  });
  try {
    const output = await finishRun(fixture);
    assertEscapeBlocked(fixture, output, {
      eventKind: "file_written",
      reason: "file_written_lexical_outside",
      marker: "kimieweb_escape_input",
    });
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

const zcodeWritePart = ({ callId, input, status = "completed" }) => ({
  id: `part_${callId}`,
  sessionID: ZCODE_SESSION_ID,
  messageID: "msg_tool_1",
  type: "tool",
  callId,
  tool: "Write",
  state: status === "running"
    ? { status, input, title: "running", startedAt: 1 }
    : {
      status,
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

async function zcodeScenario({ effectiveCwd, writeInput, messages }) {
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
    messages: messages ?? ((n) => (n <= 1 ? [] : [
      zcodeUserMsg("do the task"),
      zcodeAssistantPartsMsg([
        zcodeWritePart({ callId: "call_zc_write", input: writeInput }),
        { type: "text", text: "wrote the file" },
        { type: "step-finish", reason: "stop", tokens: {} },
      ]),
    ])),
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
      assert.ok(JSON.stringify(violation ?? {}).includes(marker),
        "TD-373: the redacted worker-reported path is intentionally recorded on the fact");
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

// ===== TD-361：codex / kimi-web / zcode 在写入完成之前发 write_intent（跨控制面）=====
//
// worker 在工作树里写了一个临时文件又删掉，等 file_written 到控制面时文件已不在盘上。
// 每条车道在补丁/工具完成之前的帧里发带 toolCallId 的 write_intent（意图时刻判界内），
// 完成时发同 id、同原文路径的 file_written，控制面（runManager 的 TD-372 放行）不判
// workdir_escape；同样形状但没有意图的（完成帧之前没见过的写入）仍判越界。每条车道都经真实
// parser / backend 把协议帧投影成事件，再喂给真实 Run。意图的收口事件（错误 tool_result）
// 也穿一遍控制面：未收口的意图在 completed 时会被判 write_intent_pending_at_completion。

/** 被删的文件：已写入又删除的临时文件在确认时刻不在盘上（ENOENT）。 */
async function writeThenDelete(effectiveCwd, relPath) {
  const abs = await createInsideFile(effectiveCwd, relPath, "ephemeral");
  await rm(abs, { force: true });
}

/** 通过：零违规、打包照常、意图与确认两段都落盘且带同一个 toolCallId、同一原文路径。 */
function assertIntentThenConfirmed(fixture, output, { toolCallId, path }) {
  assert.equal(fixture.getPackageCount(), 1, "打包照常");
  assert.ok(!output.events.some((event) => event.type === "run.isolation_violation"), "不判 workdir_escape");
  assert.equal(output.result.isolationViolation, undefined);
  const persisted = output.events.filter((event) => event.type === "run.event");
  const intent = persisted.find((event) => event.kind === "write_intent");
  const written = persisted.find((event) => event.kind === "file_written");
  assert.equal(intent?.correlationStatus, "tracked");
  assert.equal(intent?.toolCallId, toolCallId);
  assert.equal(intent?.path, path);
  assert.equal(written?.toolCallId, toolCallId);
  assert.equal(written?.path, path, "确认的路径与意图的原文路径逐字节相同");
}

/** 无意图的同形状：file_written 在盘上找不到（ENOENT）→ 按今天的样子判越界。 */
function assertDeletedWriteWithoutIntentBlocked(fixture, output) {
  assert.equal(fixture.getPackageCount(), 0, "不进打包");
  assert.equal(fixture.run.state, "failed");
  assert.equal(output.result.isolationViolation, true);
  const violation = output.events.find((event) => event.type === "run.isolation_violation");
  assert.deepEqual(
    { code: violation?.code, eventKind: violation?.eventKind, reason: violation?.reason },
    { code: "workdir_escape", eventKind: "file_written", reason: "file_written_physical_unresolved" },
  );
  assert.ok(!output.events.some((event) => event.type === "run.event" && event.kind === "write_intent"));
}

/**
 * 意图路径在树内、完成帧路径在树外：file_written 报的是完成帧的路径，门照常检查真实路径，
 * 判 workdir_escape（越界的是 file_written，不是意图；报出的路径是树外那个）。
 */
function assertCompletionPathEscapeBlocked(fixture, output, { marker, toolCallId }) {
  assert.equal(fixture.getPackageCount(), 0, "不进打包");
  assert.equal(fixture.run.state, "failed");
  assert.equal(output.result.isolationViolation, true);
  const violation = output.events.find((event) => event.type === "run.isolation_violation");
  assert.deepEqual(
    { code: violation?.code, eventKind: violation?.eventKind, reason: violation?.reason },
    { code: "workdir_escape", eventKind: "file_written", reason: "file_written_lexical_outside" },
  );
  assert.ok(violation.reportedPath.includes(marker), "报出的是完成帧里树外的那个路径");
  const persisted = output.events.filter((event) => event.type === "run.event");
  const intent = persisted.find((event) => event.kind === "write_intent");
  assert.equal(intent?.toolCallId, toolCallId, "树内的意图已落盘");
  assert.ok(!intent.path.includes(marker), "意图路径不是树外那个");
  assert.ok(!persisted.some((event) => event.kind === "file_written"), "越界的 file_written 本身不落盘");
}

/** 意图已落盘（在途发过），但确认没有 id、文件又缺失：照今天判越界，不享受放宽。 */
function assertDeletedWriteNotRelaxed(fixture, output) {
  assert.equal(fixture.getPackageCount(), 0, "不进打包");
  assert.equal(fixture.run.state, "failed");
  assert.equal(output.result.isolationViolation, true);
  const violation = output.events.find((event) => event.type === "run.isolation_violation");
  assert.deepEqual(
    { code: violation?.code, eventKind: violation?.eventKind, reason: violation?.reason },
    { code: "workdir_escape", eventKind: "file_written", reason: "file_written_physical_unresolved" },
  );
  assert.ok(output.events.some((event) => event.type === "run.event" && event.kind === "write_intent"), "意图确实发过并落盘");
}

/** 空白在途路径不发意图：打包照常、零违规、没有 write_intent 落盘，file_written 无 id。 */
function assertBlankInFlightPathAccepted(fixture, output, { path }) {
  assert.equal(fixture.getPackageCount(), 1, "打包照常");
  assert.ok(!output.events.some((event) => event.type === "run.isolation_violation"), "不判 workdir_escape");
  const persisted = output.events.filter((event) => event.type === "run.event");
  assert.ok(!persisted.some((event) => event.kind === "write_intent"), "零意图");
  const written = persisted.find((event) => event.kind === "file_written");
  assert.equal(written?.path, path);
  assert.ok(!Object.hasOwn(written, "toolCallId"));
}

/** 收口事件被控制面接受：completed 不因未收口意图失败。 */
function assertCompletedWithoutPendingIntent(fixture, output) {
  assert.equal(fixture.getPackageCount(), 1);
  assert.ok(!output.events.some((event) => event.type === "run.isolation_violation"));
  assert.ok(!output.events.some((event) => event.type === "run.error" && event.code === "workdir_escape"));
}

// ----- codex：CodexStreamParser 吃 item.started / item.completed 帧，写入与删除夹在中间 -----

const codexFileChangeItem = (status, path, id = "item_td361") => ({
  id, type: "file_change", changes: [{ kind: "add", path }], status,
});

function codexLifecycleHandle({ effectiveCwd, relPath, announce, finalStatus = "completed", deleteBetween = true }) {
  const parser = new CodexStreamParser();
  return {
    backend: "codex",
    backendSessionId: "session_codex_td361",
    async *events() {
      if (announce) {
        yield* parser.feed(jsonFrame({ type: "item.started", item: codexFileChangeItem("in_progress", relPath) }));
      }
      if (deleteBetween) await writeThenDelete(effectiveCwd, relPath);
      yield* parser.feed(jsonFrame({ type: "item.completed", item: codexFileChangeItem(finalStatus, relPath) }));
      yield* parser.feed(jsonFrame({ type: "item.completed", item: { type: "agent_message", text: "done" } }));
      yield* parser.feed(jsonFrame({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } }));
    },
    async abort() {},
  };
}

test("containment chain TD-361 / codex: item.started 意图 → 写入树内文件 → 文件被删 → item.completed 确认——不判 workdir_escape", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "codex",
    spawnHandle: ({ effectiveCwd }) => codexLifecycleHandle({ effectiveCwd, relPath: "src/ephemeral-codex.js", announce: true }),
  });
  try {
    const output = await finishRun(fixture);
    assertIntentThenConfirmed(fixture, output, { toolCallId: "item_td361#0", path: "src/ephemeral-codex.js" });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("containment chain TD-361 / codex: 同形状但完成帧之前没见过 item.started——仍判越界（不按分类时刻的磁盘放宽）", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "codex",
    spawnHandle: ({ effectiveCwd }) => codexLifecycleHandle({ effectiveCwd, relPath: "src/ephemeral-codex.js", announce: false }),
  });
  try {
    const output = await finishRun(fixture);
    assertDeletedWriteWithoutIntentBlocked(fixture, output);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("containment chain TD-361 / codex: 补丁失败——意图由错误 tool_result 收口，completed 不因未收口意图失败，也没有 file_written", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "codex",
    spawnHandle: ({ effectiveCwd }) => codexLifecycleHandle({
      effectiveCwd, relPath: "src/never-applied.js", announce: true, finalStatus: "failed", deleteBetween: false,
    }),
  });
  try {
    const output = await finishRun(fixture);
    assertCompletedWithoutPendingIntent(fixture, output);
    assert.ok(!output.events.some((event) => event.type === "run.event" && event.kind === "file_written"));
    assert.equal(output.events.filter((event) => event.type === "run.event" && event.kind === "write_intent").length, 1);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("containment chain TD-361 / codex: 意图没等到 item.completed 回合就结束——回合收口的错误 tool_result 让 completed 照常通过", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "codex",
    spawnHandle: () => {
      const parser = new CodexStreamParser();
      return {
        backend: "codex",
        backendSessionId: "session_codex_td361_open",
        async *events() {
          yield* parser.feed(jsonFrame({ type: "item.started", item: codexFileChangeItem("in_progress", "src/open.js") }));
          yield* parser.feed(jsonFrame({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
        },
        async abort() {},
      };
    },
  });
  try {
    const output = await finishRun(fixture);
    assertCompletedWithoutPendingIntent(fixture, output);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("containment chain TD-361 / codex: item.started 的路径是空白——零意图（否则门直接判 write_intent_lexical_outside），随后真实存在的树内文件照常打包", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "codex",
    spawnHandle: () => {
      const parser = new CodexStreamParser();
      return {
        backend: "codex",
        backendSessionId: "session_codex_td361_blank",
        async *events() {
          yield* parser.feed(jsonFrame({ type: "item.started", item: codexFileChangeItem("in_progress", "   ", "item_blank") }));
          yield* parser.feed(jsonFrame({ type: "item.completed", item: codexFileChangeItem("completed", "src/real-codex.js", "item_blank") }));
          yield* parser.feed(jsonFrame({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
        },
        async abort() {},
      };
    },
  });
  await createInsideFile(fixture.effectiveCwd, "src/real-codex.js");
  try {
    const output = await finishRun(fixture);
    assertBlankInFlightPathAccepted(fixture, output, { path: "src/real-codex.js" });
  } finally {
    await cleanupFixture(fixture);
  }
});

// ----- zcode：ZcodeBackend + 假 app-server，running 拍 → completed 拍 -----

function zcodeLifecycleMessages({ relPath, statuses, completedPath }) {
  const user = zcodeUserMsg("do the task");
  const phases = statuses.map((status) => [
    user,
    zcodeAssistantPartsMsg([
      zcodeWritePart({
        callId: "call_zc_td361",
        status,
        // completedPath：完成帧里的路径与在途帧（意图时刻）不同。
        input: { filePath: status === "completed" && completedPath !== undefined ? completedPath : relPath, content: "x" },
      }),
      ...(status === "completed" || statuses.length === 1
        ? [{ type: "text", text: "wrote the file" }, { type: "step-finish", reason: "stop", tokens: {} }]
        : []),
    ]),
  ]);
  // n=1 是提交前的基线读；之后每个阶段两拍（多拍重复帧），最后一个阶段保持到收口。
  return (n) => (n <= 1 ? [] : phases[Math.min(phases.length - 1, Math.floor((n - 2) / 2))]);
}

test("containment chain TD-361 / zcode: running 拍意图 → 文件写入后被删 → completed 拍确认——不判 workdir_escape", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "zcode",
    spawnHandle: ({ effectiveCwd }) => zcodeScenario({
      effectiveCwd,
      messages: zcodeLifecycleMessages({ relPath: "out/ephemeral-zcode.js", statuses: ["running", "completed"] }),
    }),
  });
  try {
    const output = await finishRun(fixture);
    assertIntentThenConfirmed(fixture, output, { toolCallId: "call_zc_td361", path: "out/ephemeral-zcode.js" });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("containment chain TD-361 / zcode: 意图路径在树内、completed 帧路径在树外——file_written 报完成帧路径，判 workdir_escape（意图不能替真实路径背书）", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "zcode",
    spawnHandle: ({ effectiveCwd, root }) => zcodeScenario({
      effectiveCwd,
      messages: zcodeLifecycleMessages({
        relPath: "out/inside-zcode-swap.js",
        completedPath: join(root, "outside-zcode-swap", "escaped.js"),
        statuses: ["running", "completed"],
      }),
    }),
  });
  try {
    const output = await finishRun(fixture);
    assertCompletionPathEscapeBlocked(fixture, output, { marker: "outside-zcode-swap", toolCallId: "call_zc_td361" });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("containment chain TD-361 / zcode: running 拍的路径是空白——零意图，completed 拍真实存在的树内文件照常打包", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "zcode",
    spawnHandle: ({ effectiveCwd }) => zcodeScenario({
      effectiveCwd,
      messages: zcodeLifecycleMessages({ relPath: "   ", completedPath: "out/real-zcode.js", statuses: ["running", "completed"] }),
    }),
  });
  await createInsideFile(fixture.effectiveCwd, "out/real-zcode.js");
  try {
    const output = await finishRun(fixture);
    assertBlankInFlightPathAccepted(fixture, output, { path: "out/real-zcode.js" });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("containment chain TD-361 / zcode: 同形状但首见即 completed——仍判越界", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "zcode",
    spawnHandle: ({ effectiveCwd }) => zcodeScenario({
      effectiveCwd,
      messages: zcodeLifecycleMessages({ relPath: "out/ephemeral-zcode.js", statuses: ["completed"] }),
    }),
  });
  try {
    const output = await finishRun(fixture);
    assertDeletedWriteWithoutIntentBlocked(fixture, output);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("containment chain TD-361 / zcode: 收口时 write part 仍停在 running——补发的错误 tool_result 让 completed 照常通过", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "zcode",
    spawnHandle: ({ effectiveCwd }) => zcodeScenario({
      effectiveCwd,
      messages: zcodeLifecycleMessages({ relPath: "out/stuck-zcode.js", statuses: ["running"] }),
    }),
  });
  try {
    const output = await finishRun(fixture);
    assertCompletedWithoutPendingIntent(fixture, output);
    assert.ok(!output.events.some((event) => event.type === "run.event" && event.kind === "file_written"));
  } finally {
    await cleanupFixture(fixture);
  }
});

// ----- kimi-web：KimiWebBackend + 按"第几次读 turns"出快照的假服务器 -----

function kimiLifecycleScript({ path, phases, endedPath }) {
  const opener = { type: "user_message", item_id: "msg_q1", prompt_ids: ["msg_q1"], placement: "opener", text: "do the task" };
  // endedPath：整轮收口时条目自己的路径与在途帧（意图时刻）不同。
  const ended = kimiWriteTurn({ displayPath: endedPath ?? path });
  const inFlightItem = kimiWriteTurn({ displayPath: path }).items[1];
  const toolItem = (status) => (status === "running"
    ? { ...inFlightItem, status, outcome: undefined, output: undefined }
    : { ...inFlightItem, status });
  const snapshots = {
    running: () => [{ ...ended, status: "running", outcome: undefined, usage: undefined, steps: [], items: [opener, toolItem("running")] }],
    ended: () => [ended],
    // 整轮已收口，但写条目自己仍是 running（不是 ended）。
    endedWithRunningItem: () => [{ ...ended, items: [opener, toolItem("running"), ended.items[2]] }],
    // 整轮收口的快照里没有这条写入（条目不见了）。
    endedWithoutItem: () => [{ ...ended, items: [opener, ended.items[2]] }],
  };
  return (reads) => snapshots[phases[Math.min(phases.length - 1, Math.floor((reads - 1) / 2))]]();
}

test("containment chain TD-361 / kimi-web: 在途拍意图 → 文件写入后被删 → 带回答收口时确认——不判 workdir_escape", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "kimi-web",
    spawnHandle: ({ effectiveCwd }) => kimiWebScenario({
      effectiveCwd,
      script: kimiLifecycleScript({ path: "out/ephemeral-kimi.txt", phases: ["running", "ended"] }),
    }),
  });
  try {
    const output = await finishRun(fixture);
    assertIntentThenConfirmed(fixture, output, { toolCallId: "tool_write", path: "out/ephemeral-kimi.txt" });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("containment chain TD-361 / kimi-web: 意图路径在树内、整轮收口时条目路径在树外——file_written 报收口路径，判 workdir_escape（意图不能替真实路径背书）", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "kimi-web",
    spawnHandle: ({ effectiveCwd, root }) => kimiWebScenario({
      effectiveCwd,
      script: kimiLifecycleScript({
        path: "out/inside-kimi-swap.txt",
        endedPath: join(root, "outside-kimi-swap", "escaped.txt"),
        phases: ["running", "ended"],
      }),
    }),
  });
  try {
    const output = await finishRun(fixture);
    assertCompletionPathEscapeBlocked(fixture, output, { marker: "outside-kimi-swap", toolCallId: "tool_write" });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("containment chain TD-361 / kimi-web: 在途路径是空白——零意图，整轮收口时真实存在的树内文件照常打包", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "kimi-web",
    spawnHandle: ({ effectiveCwd }) => kimiWebScenario({
      effectiveCwd,
      script: kimiLifecycleScript({ path: "   ", endedPath: "out/real-kimi.txt", phases: ["running", "ended"] }),
    }),
  });
  await createInsideFile(fixture.effectiveCwd, "out/real-kimi.txt");
  try {
    const output = await finishRun(fixture);
    assertBlankInFlightPathAccepted(fixture, output, { path: "out/real-kimi.txt" });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("containment chain TD-361 / kimi-web: 整轮收口时写条目仍是 running——file_written 不带 id，不享受放宽，文件缺失仍判越界", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "kimi-web",
    spawnHandle: ({ effectiveCwd }) => kimiWebScenario({
      effectiveCwd,
      script: kimiLifecycleScript({ path: "out/never-created-kimi.txt", phases: ["running", "endedWithRunningItem"] }),
    }),
  });
  try {
    const output = await finishRun(fixture);
    assertDeletedWriteNotRelaxed(fixture, output);
  } finally {
    await cleanupFixture(fixture);
  }
});

const kimiDupItem = ({ path, status }) => ({
  type: "tool_call",
  item_id: "tool_dup",
  step_index: 1,
  status,
  name: "Write",
  input: { path, content: "x" },
  display: { kind: "file_io", operation: "write", path },
  ...(status === "ended" ? { outcome: "completed", output: "wrote" } : {}),
});

function kimiDupScript({ insidePath, outsidePath }) {
  const base = kimiWriteTurn({ displayPath: insidePath });
  const [opener, , answer] = base.items;
  return (reads) => (reads <= 2
    ? [{ ...base, status: "running", outcome: undefined, usage: undefined, steps: [], items: [opener, kimiDupItem({ path: insidePath, status: "running" })] }]
    : [{ ...base, items: [opener, kimiDupItem({ path: insidePath, status: "ended" }), kimiDupItem({ path: outsidePath, status: "ended" }), answer] }]);
}

test("containment chain TD-361 / kimi-web: 同一快照里两个写条目撞了 item_id（一个树内、一个树外）——两条路径都被检查，树外那条判 workdir_escape", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "kimi-web",
    spawnHandle: ({ effectiveCwd, root }) => kimiWebScenario({
      effectiveCwd,
      script: kimiDupScript({ insidePath: "out/inside-kimi-dup.txt", outsidePath: join(root, "outside-kimi-dup", "escaped.txt") }),
    }),
  });
  await createInsideFile(fixture.effectiveCwd, "out/inside-kimi-dup.txt");
  try {
    const output = await finishRun(fixture);
    assert.equal(fixture.getPackageCount(), 0, "不进打包");
    assert.equal(fixture.run.state, "failed");
    const violation = output.events.find((event) => event.type === "run.isolation_violation");
    assert.deepEqual(
      { code: violation?.code, eventKind: violation?.eventKind, reason: violation?.reason },
      { code: "workdir_escape", eventKind: "file_written", reason: "file_written_lexical_outside" },
    );
    assert.ok(violation.reportedPath.includes("outside-kimi-dup"), "报出的是第二个条目的树外路径");
    const written = output.events.filter((event) => event.type === "run.event" && event.kind === "file_written");
    assert.deepEqual(written.map((event) => [event.path, Object.hasOwn(event, "toolCallId")]), [["out/inside-kimi-dup.txt", false]], "树内那条无 id 落盘，树外那条被拒不落盘");
  } finally {
    await cleanupFixture(fixture);
  }
});

test("containment chain TD-361 / kimi-web: 同形状但只在整轮收口时才见到这条写入——仍判越界", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "kimi-web",
    spawnHandle: ({ effectiveCwd }) => kimiWebScenario({
      effectiveCwd,
      script: kimiLifecycleScript({ path: "out/ephemeral-kimi.txt", phases: ["ended"] }),
    }),
  });
  try {
    const output = await finishRun(fixture);
    assertDeletedWriteWithoutIntentBlocked(fixture, output);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("containment chain TD-361 / kimi-web: 意图的条目在收口快照里不见了——补发的错误 tool_result 让 completed 照常通过", async () => {
  const fixture = await makeDeliveryRunFixture({
    backendName: "kimi-web",
    spawnHandle: ({ effectiveCwd }) => kimiWebScenario({
      effectiveCwd,
      script: kimiLifecycleScript({ path: "out/vanished-kimi.txt", phases: ["running", "endedWithoutItem"] }),
    }),
  });
  try {
    const output = await finishRun(fixture);
    assertCompletedWithoutPendingIntent(fixture, output);
    assert.ok(!output.events.some((event) => event.type === "run.event" && event.kind === "file_written"));
  } finally {
    await cleanupFixture(fixture);
  }
});
