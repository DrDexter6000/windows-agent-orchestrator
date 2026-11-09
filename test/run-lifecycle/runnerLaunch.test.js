// test/run-lifecycle/runnerLaunch.test.js
//
// TD-347（第 93 批 + 续修）：runner 启动模块（src/application/runnerLaunch.js）+
// 管道帧协议（src/application/runnerFrame.js）的单元测试。
//
// 全部注入桩，不起真进程：WMI 侧注入 wmiSpawnBrokerFn（假"起桥"），管道对端是
// 测试进程内的 net 客户端（假桥，按帧协议说话：先 {nonce} 握手、再收载荷、再回帧）；
// 三处调用方的形状断言用假 spawn / 假 launchRunnerFn。真进程的桥测试见
// runnerBroker.test.js；真作业存活证明见 runnerLaunchJob.test.js；续修不回滚的
// 端到端（真 git 工作树）见 runnerLaunchContinueKillGate.test.js。

import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { accessSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  launchRunner,
  resolveLaunchMode,
  runnerLaunchFailureText,
  buildBrokerCommandLine,
  buildWmiCreateScript,
  parseLaunchSentinel,
  buildKillScanScript,
  parseKillScanOutput,
  DEFAULT_BROKER_PATH,
  RUNNER_LAUNCH_FAIL_REASONS,
  RUNNER_KILL_BUDGET_MS,
} from "../../src/application/runnerLaunch.js";
import {
  encodeFrame,
  FrameDecoder,
  FrameTooLargeError,
  MAX_FRAME_BYTES,
  validateBrokerPayload,
  validateBrokerReply,
} from "../../src/application/runnerFrame.js";
import { PROMPT_HANDOFF_TIMEOUT_TEXT } from "../../src/runnerPrompt.js";
import { dispatchRun } from "../../src/application/runDispatch.js";
import { forkResumeRunner } from "../../src/commands/lifecycle.js";
import { readTranscript, findState, findLatest } from "../../src/transcript.js";
import { resolveTranscriptPath } from "../../src/projectBuckets.js";

const IS_WINDOWS = process.platform === "win32";

// 套件子进程环境钉了 WAO_RUNNER_LAUNCH=spawn（canonical-test.mjs）——本文件的
// WMI 路径测试要的是缺省路径，逐测试摘掉并恢复（node:test 文件内串行，安全）。
function withoutSpawnSwitch() {
  const prev = process.env.WAO_RUNNER_LAUNCH;
  delete process.env.WAO_RUNNER_LAUNCH;
  return () => {
    if (prev === undefined) delete process.env.WAO_RUNNER_LAUNCH;
    else process.env.WAO_RUNNER_LAUNCH = prev;
  };
}

// 假子进程（spawn 路径）：记录调用，可编程 stdin 行为。
function makeFakeSpawn({ pid = 4321, hangStdin = false } = {}) {
  const calls = [];
  const fakeSpawn = (execPath, args, opts) => {
    const call = { execPath, args, opts, stdinText: null, unrefCalled: false, killCount: 0 };
    calls.push(call);
    return {
      pid,
      unref() { call.unrefCalled = true; },
      kill() { call.killCount += 1; },
      stdin: hangStdin
        ? { once() {}, end(_t, cb) { /* 回调一直不来 */ } }
        : { once() {}, end(text, cb) { call.stdinText = String(text ?? ""); if (cb) cb(); } },
    };
  };
  return { fakeSpawn, calls };
}

/**
 * 假桥：收到 handoff（含 pipeName/nonce）→ 连管道 → 按 handshake 形状发第一帧
 * （ok=正确 nonce / wrong=错 nonce / garbage=坏 JSON / silent=什么都不发）→
 * （握手被父端接受时）收载荷帧、交给 onPayload 回帧。"起桥"promise 在 connect
 * 即落定（真实语义：PowerShell 退出 = 创建完成，桥进程自己活着干活）。
 * record.receivedBytes 统计连接后收到的全部字节——载荷没被发出时它必须是 0
 * （续修 6 的反证面）。
 */
function makeFakeBroker({ pid = 8800, handshake = "ok", onPayload = null } = {}) {
  const record = { handoff: null, payload: null, receivedBytes: 0 };
  const wmiSpawnBrokerFn = (handoff) => new Promise((resolveLaunch) => {
    record.handoff = handoff;
    const socket = connect(handoff.pipeName);
    const decoder = new FrameDecoder();
    socket.on("error", () => resolveLaunch({ ok: false, detail: "connect failed" }));
    socket.on("connect", () => {
      resolveLaunch({ ok: true, pid });
      if (handshake === "ok") {
        socket.write(encodeFrame({ nonce: handoff.nonce }));
      } else if (handshake === "wrong") {
        socket.write(encodeFrame({ nonce: "0".repeat(32) }));
      } else if (handshake === "garbage") {
        const body = Buffer.from("{oops", "utf8");
        const frame = Buffer.alloc(4 + body.length);
        frame.writeUInt32BE(body.length, 0);
        body.copy(frame, 4);
        socket.write(frame);
      }
      // "silent"：连接后一个字节都不发。
    });
    socket.on("data", (chunk) => {
      record.receivedBytes += chunk.length;
      try {
        const r = decoder.push(chunk);
        if (r.status !== "frame") return;
        record.payload = r.value;
        if (onPayload) onPayload(r.value, socket);
      } catch { /* 帧坏了就不管——父端自己会判 unverified */ }
    });
    setTimeout(() => { try { socket.destroy(); } catch { /* 已关 */ } }, 4000).unref();
  });
  return { wmiSpawnBrokerFn, record };
}

/**
 * 假 killDeps：记录事件顺序（"taskkill:<pid>" / "scan1" / "scan2"）。
 * scanResults 可给每次扫描分别编排结果；缺省=第一次扫描命中 scanPids（随后被
 * 结束）、第二次扫描干净（它们都死了）——"结束已确认"的自然语义。
 * alivePids 里的 pid 判活。
 */
function makeFakeKillDeps({ scanResults = null, scanPids = [], alivePids = [], budgetMs } = {}) {
  const events = [];
  const killed = [];
  const scanned = [];
  let scanCalls = 0;
  const deps = {
    taskkillFn: (pid) => { events.push(`taskkill:${pid}`); killed.push(pid); return { called: true, exitCode: 0 }; },
    scanFn: async (runId, notBeforeMs, opts) => {
      scanCalls += 1;
      scanned.push({ runId, notBeforeMs, call: scanCalls, timeoutMs: opts?.timeoutMs });
      events.push(`scan${scanCalls}`);
      if (scanResults) return scanResults[Math.min(scanCalls - 1, scanResults.length - 1)];
      return { ok: true, pids: scanCalls === 1 ? [...scanPids] : [] };
    },
    isAliveFn: (pid) => alivePids.includes(pid),
    ...(budgetMs !== undefined ? { budgetMs } : {}),
  };
  return { deps, events, killed, scanned };
}

function baseWmiInput(overrides = {}) {
  return {
    execPath: "C:\\node\\node.exe",
    args: ["C:\\repo\\src\\backgroundRunner.js", "coder_low", "--run-id", "run_test_ab1"],
    env: { PATH: "C:\\windows", WAO_SECRET_TOKEN: "secret-value-xyz" },
    cwd: "D:\\work\\proj",
    prompt: "do the task",
    stderrPath: "D:\\runs\\.runner-run_test_ab1.stderr",
    runId: "run_test_ab1",
    timeoutMs: 2000,
    ...overrides,
  };
}

// ── 帧协议（runnerFrame.js）───────────────────────────────────────────────────

test("帧：编码 → 整帧解码往返", () => {
  const value = { execPath: "node", args: ["a", "b"], env: { X: "1" }, cwd: "d", prompt: null, stderrPath: "s", deadlineAt: 1 };
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(encodeFrame(value)), { status: "frame", value });
});

test("帧：半包逐字节喂，凑齐才出帧；帧后多余字节忽略", () => {
  const bytes = encodeFrame({ a: "b" });
  const decoder = new FrameDecoder();
  for (let i = 0; i < bytes.length - 1; i += 1) {
    assert.deepEqual(decoder.push(bytes.subarray(i, i + 1)), { status: "incomplete" }, `字节 ${i} 仍是半包`);
  }
  const r = decoder.push(bytes.subarray(bytes.length - 1));
  assert.equal(r.status, "frame");
  assert.equal(r.value.a, "b");
  assert.deepEqual(decoder.push(Buffer.from("trailing")), { status: "incomplete" }, "第二帧被忽略");
});

test("帧：长度头超上限 / 坏 JSON / 非对象 都抛错", () => {
  const bad1 = Buffer.alloc(8);
  bad1.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  assert.throws(() => new FrameDecoder().push(bad1), FrameTooLargeError);
  const full = Buffer.alloc(4 + 7);
  full.writeUInt32BE(7, 0);
  full.write('{"x":~', 4, "utf8");
  assert.throws(() => new FrameDecoder().push(full), { name: "FrameFormatError" });
  const arr = encodeFrame([1, 2]);
  assert.throws(() => new FrameDecoder().push(arr), { name: "FrameFormatError" });
});

test("帧：encodeFrame 超上限抛 FrameTooLargeError", () => {
  assert.throws(() => encodeFrame({ big: "x".repeat(MAX_FRAME_BYTES + 8) }), FrameTooLargeError);
});

test("载荷/回帧校验：坏形状拒绝（deadlineAt 必须是正整数），好形状放行", () => {
  const goodPayload = { execPath: "n", args: ["a"], env: { A: "b" }, cwd: "d", prompt: null, stderrPath: "s", deadlineAt: 1700000000000 };
  assert.deepEqual(validateBrokerPayload(goodPayload), goodPayload);
  assert.deepEqual(validateBrokerPayload({ ...goodPayload, prompt: "任务书" }), { ...goodPayload, prompt: "任务书" });
  for (const bad of [
    { ...goodPayload, execPath: "" },
    { ...goodPayload, args: ["ok", 42] },
    { ...goodPayload, env: { A: 1 } },
    { ...goodPayload, cwd: 5 },
    { ...goodPayload, prompt: 7 },
    { ...goodPayload, stderrPath: null },
    { ...goodPayload, deadlineAt: 0 },
    { ...goodPayload, deadlineAt: 1.5 },
    { ...goodPayload, deadlineAt: "123" },
    { deadlineAt: 1 }, // 缺字段
  ]) {
    assert.throws(() => validateBrokerPayload(bad), { name: "FrameFormatError" }, JSON.stringify(bad));
  }
  assert.deepEqual(validateBrokerReply({ runnerPid: 123, handoff: "written" }), { runnerPid: 123, handoff: "written" });
  assert.deepEqual(validateBrokerReply({ runnerPid: null, handoff: "runner_exited" }), { runnerPid: null, handoff: "runner_exited" });
  assert.throws(() => validateBrokerReply({ runnerPid: 123 }), { name: "FrameFormatError" });
  assert.throws(() => validateBrokerReply({ runnerPid: 123, handoff: "nope" }), { name: "FrameFormatError" });
  assert.throws(() => validateBrokerReply({ runnerPid: -5, handoff: "written" }), { name: "FrameFormatError" });
});

// ── 路径选择与纯函数 ──────────────────────────────────────────────────────────

test("resolveLaunchMode：注入 spawnFn / 开关 / 非 Windows → spawn；Windows 缺省 → wmi", () => {
  const restore = withoutSpawnSwitch(); // envValue 缺省读 process.env——套件环境钉了 spawn，先摘掉
  try {
    assert.equal(resolveLaunchMode({ platform: "win32", envValue: undefined, hasSpawnFn: true }), "spawn", "注入缝优先");
    assert.equal(resolveLaunchMode({ platform: "win32", envValue: "spawn", hasSpawnFn: false }), "spawn", "显式开关");
    assert.equal(resolveLaunchMode({ platform: "linux", envValue: undefined, hasSpawnFn: false }), "spawn", "非 Windows");
    assert.equal(resolveLaunchMode({ platform: "win32", envValue: undefined, hasSpawnFn: false }), "wmi", "Windows 缺省");
  } finally {
    restore();
  }
});

test("桥命令行与 WMI 脚本：脚本带的是 buildBrokerCommandLine 的输出，不含凭据", () => {
  const nonce = "a".repeat(32);
  const commandLine = buildBrokerCommandLine({
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    brokerPath: DEFAULT_BROKER_PATH,
    pipeName: "\\\\.\\pipe\\wao-runner-run_x-abc",
    nonce,
    runId: "run_x",
  });
  assert.equal(
    commandLine,
    '"C:\\Program Files\\nodejs\\node.exe" "' + DEFAULT_BROKER_PATH + '" --pipe \\\\.\\pipe\\wao-runner-run_x-abc --nonce ' + nonce + " --run-id run_x",
    "命令行含 --nonce（生产拼装口就是它，续修 7）",
  );
  const script = buildWmiCreateScript({ commandLine, cwd: "D:\\w" });
  // 脚本只携带 b64 的整条桥命令行与 cwd：凭据、任务书、runner argv 一概不在。
  for (const secret of ["secret-value-xyz", "WAO_SECRET_TOKEN", "do the task", "backgroundRunner.js"]) {
    assert.ok(!script.includes(secret), `WMI 脚本不含 ${secret}`);
  }
  assert.ok(script.includes(Buffer.from(commandLine, "utf8").toString("base64")), "整条桥命令行以 b64 进脚本");
  assert.ok(script.includes(Buffer.from("D:\\w", "utf8").toString("base64")), "cwd 以 b64 进脚本");
  assert.ok(/Invoke-CimMethod -ClassName Win32_Process -MethodName Create/.test(script), "经 WMI Create");
  assert.ok(/ShowWindow=\[UInt16\]0/.test(script), "不弹窗口");
});

test("哨兵判读：好行 / ReturnValue≠0 / 缺失 / 多行取最后 / CRLF", () => {
  assert.deepEqual(parseLaunchSentinel("wao-launch:0:4242\n"), { ok: true, returnValue: 0, processId: 4242 });
  assert.deepEqual(parseLaunchSentinel("noise\r\nwao-launch:0:7\r\n"), { ok: true, returnValue: 0, processId: 7 });
  const rv = parseLaunchSentinel("wao-launch:2:0\n");
  assert.equal(rv.ok, false);
  assert.equal(rv.returnValue, 2);
  assert.deepEqual(parseLaunchSentinel("wao-launch:0:11\nwao-launch:0:22\n").processId, 22, "多行取最后");
  assert.deepEqual(parseLaunchSentinel("nothing here"), { ok: false, returnValue: null, processId: null });
  assert.deepEqual(parseLaunchSentinel("wao-launch:0:0\n").ok, false, "pid 0 不算起");
});

test("kill 扫描：脚本带排除链与时间下限；哨兵判读 pids", () => {
  const script = buildKillScanScript("run_k1", 1700000000000);
  assert.ok(script.includes("*--run-id run_k1*"), "按 --run-id 匹配");
  assert.ok(script.includes("*--resume-run-id run_k1*"), "按 --resume-run-id 匹配");
  assert.ok(script.includes("1699999995000"), "时间下限 −5s");
  assert.ok(!script.includes("secret"), "不含凭据");
  assert.deepEqual(parseKillScanOutput("wao-killscan-ok:2:101 202"), { ok: true, pids: [101, 202] });
  assert.deepEqual(parseKillScanOutput("wao-killscan-ok:0:"), { ok: true, pids: [] });
  assert.deepEqual(parseKillScanOutput("wao-killscan-ok:1:abc"), { ok: false });
  assert.deepEqual(parseKillScanOutput(""), { ok: false });
});

test("失败原因闭集与固定文本：新码（kill_unconfirmed/bridge_unverified）与既有原文", () => {
  assert.ok(RUNNER_LAUNCH_FAIL_REASONS.includes("runner_kill_unconfirmed"));
  assert.ok(RUNNER_LAUNCH_FAIL_REASONS.includes("bridge_unverified"));
  const unconfirmed = runnerLaunchFailureText("runner_kill_unconfirmed");
  assert.ok(unconfirmed.includes("未能确认它已结束"), "点名未确认");
  assert.ok(unconfirmed.includes("保持 pending"), "指引不收口");
  assert.ok(unconfirmed.includes("wao runs settle"), "指引 settle");
  const verified = runnerLaunchFailureText("bridge_unverified");
  assert.ok(verified.includes("载荷未发出"), "点名载荷未发出");
  const wmi = runnerLaunchFailureText("wmi_create_failed");
  assert.ok(wmi.includes("WAO_RUNNER_LAUNCH=spawn"), "点名开关");
  assert.ok(wmi.includes("随宿主重启 MCP 服务而死"), "讲清退路的代价");
  assert.equal(runnerLaunchFailureText("handoff_timeout"), PROMPT_HANDOFF_TIMEOUT_TEXT);
  assert.equal(runnerLaunchFailureText("prompt_handoff_timeout"), PROMPT_HANDOFF_TIMEOUT_TEXT);
  for (const reason of RUNNER_LAUNCH_FAIL_REASONS) {
    assert.ok(typeof runnerLaunchFailureText(reason) === "string" && runnerLaunchFailureText(reason).length > 0, `每个原因都有固定文本：${reason}`);
  }
  assert.equal(RUNNER_KILL_BUDGET_MS, 15000, "结束阶段总预算 15 秒");
});

// ── spawn 路径（注入 spawnFn）─────────────────────────────────────────────────

test("spawn 路径：形状与原三处一致（detached/stdio/env/cwd/摘要 stdin/unref）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-launch-spawn-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const stderrPath = join(dir, ".runner-run_sp1.stderr");
    const r = await launchRunner({
      ...baseWmiInput({ stderrPath, runId: "run_sp1" }),
      spawnFn: fakeSpawn,
    });
    assert.equal(r.outcome, "started");
    assert.equal(r.runnerPid, 4321);
    const { opts, stdinText, unrefCalled } = calls[0];
    assert.equal(opts.detached, true);
    assert.equal(opts.stdio[0], "pipe", "有提示词 → stdin pipe");
    assert.equal(opts.stdio[1], "ignore");
    assert.equal(typeof opts.stdio[2], "number", "stderr 是打开的 fd");
    assert.equal(opts.env.WAO_SECRET_TOKEN, "secret-value-xyz", "env 原样传给 spawn");
    assert.equal(opts.cwd, "D:\\work\\proj", "cwd 显式传递（继承语义）");
    assert.equal(stdinText, "do the task", "提示词经 stdin");
    assert.equal(unrefCalled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawn 路径：resume（prompt null）stdin=ignore、无提示词仍带 env，成功", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-launch-resume-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const r = await launchRunner({
      ...baseWmiInput({ prompt: null, stderrPath: join(dir, ".stderr"), runId: "run_rs1" }),
      spawnFn: fakeSpawn,
    });
    assert.equal(r.outcome, "started");
    assert.equal(calls[0].opts.stdio[0], "ignore", "resume 无提示词交接");
    assert.equal(calls[0].opts.env.PATH, "C:\\windows", "resume 仍带 env");
    assert.equal(calls[0].stdinText, "", "没写过提示词");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawn 路径：spawn 抛错 → start_failed(spawn_error)，detail 保留原始错误，不 unref", async () => {
  const boom = new Error("spawn boom");
  const r = await launchRunner({
    ...baseWmiInput(),
    spawnFn: () => { throw boom; },
  });
  assert.equal(r.outcome, "start_failed");
  assert.equal(r.reason, "spawn_error");
  assert.equal(r.detail, boom, "原始错误对象原样带回（调用方照旧抛）");
});

test("spawn 路径：提示词交接超时 → 结束 runner 恰一次 → start_failed(prompt_handoff_timeout)", async () => {
  const { fakeSpawn, calls } = makeFakeSpawn({ hangStdin: true });
  const r = await launchRunner({
    ...baseWmiInput(),
    timeoutMs: 40,
    spawnFn: fakeSpawn,
  });
  assert.equal(r.outcome, "start_failed");
  assert.equal(r.reason, "prompt_handoff_timeout");
  assert.equal(runnerLaunchFailureText(r.reason), PROMPT_HANDOFF_TIMEOUT_TEXT);
  assert.equal(calls[0].killCount, 1, "runner 被结束恰一次");
  assert.equal(calls[0].unrefCalled, false, "失败路径不 unref");
});

test("spawn 路径：stderr 打开失败 → 退回 ignore，照常 started", async () => {
  const { fakeSpawn, calls } = makeFakeSpawn();
  const r = await launchRunner({
    ...baseWmiInput({ stderrPath: "Z:\\nope\\x.stderr" }),
    spawnFn: fakeSpawn,
    openStderrFn: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
  });
  assert.equal(r.outcome, "started");
  assert.equal(calls[0].opts.stdio[2], "ignore");
});

// ── WMI 路径（Windows，真管道，假桥/假 kill）──────────────────────────────────

test("WMI 路径：握手通过 → handoff=written → started；载荷逐字段一致（含 deadlineAt），WMI 侧不见凭据", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  const before = Date.now();
  const { wmiSpawnBrokerFn, record } = makeFakeBroker({
    onPayload: (_payload, socket) => {
      socket.end(encodeFrame({ runnerPid: 777, handoff: "written" }));
    },
  });
  const kill = makeFakeKillDeps();
  const input = baseWmiInput();
  try {
    const r = await launchRunner({ ...input, wmiSpawnBrokerFn, killDeps: kill.deps });
    assert.equal(r.outcome, "started");
    assert.equal(r.runnerPid, 777);
    // WMI 起桥的输入只有整条桥命令行与拼它的字段——env/prompt/runner argv 不在其中。
    const handoff = record.handoff;
    assert.ok(handoff.commandLine.startsWith(`"${input.execPath}" "${DEFAULT_BROKER_PATH}" --pipe \\\\.\\pipe\\wao-runner-${input.runId}-`), "命令行由 buildBrokerCommandLine 拼好整条交给 WMI");
    assert.ok(handoff.commandLine.includes(`--nonce ${handoff.nonce}`), "命令行带握手 nonce");
    assert.match(handoff.nonce, /^[0-9a-f]{32}$/, "nonce 是 128 位随机十六进制");
    assert.match(handoff.pipeName.replace(/^.*wao-runner-[0-9A-Za-z_-]+-/, ""), /^[0-9a-f]{32}$/, "管道名带 128 位随机后缀");
    assert.deepEqual(
      Object.keys(handoff).sort(),
      ["brokerPath", "commandLine", "cwd", "execPath", "nonce", "pipeName", "runId", "timeoutMs"],
      "WMI 侧上下文绝不含 env/prompt/runner argv",
    );
    for (const secret of [input.env.WAO_SECRET_TOKEN, input.prompt]) {
      assert.ok(!handoff.commandLine.includes(secret), "凭据/任务书不在命令行里");
    }
    // 桥收到的载荷与输入逐字段一致（凭据只在载荷里）；deadlineAt 是父端总期限。
    const payload = record.payload;
    assert.deepEqual(
      { execPath: payload.execPath, args: payload.args, env: payload.env, cwd: payload.cwd, prompt: payload.prompt, stderrPath: payload.stderrPath },
      { execPath: input.execPath, args: input.args, env: input.env, cwd: input.cwd, prompt: input.prompt, stderrPath: input.stderrPath },
    );
    assert.equal(payload.env.WAO_SECRET_TOKEN, "secret-value-xyz", "凭据在载荷里");
    assert.ok(Number.isInteger(payload.deadlineAt) && payload.deadlineAt >= before + 2000 - 50 && payload.deadlineAt <= before + 2000 + 500, "deadlineAt=父端总期限的绝对时刻（现在 + timeoutMs）");
    assert.deepEqual(kill.events, [], "成功路径零兜底结束");
  } finally {
    restore();
  }
});

test("WMI 路径：ReturnValue≠0 / PowerShell 起不来 → start_failed(wmi_create_failed)，不退回 spawn、零 kill", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  try {
    for (const detail of ["WMI ReturnValue=2", "powershell failed to start", "powershell timeout"]) {
      const kill = makeFakeKillDeps();
      const r = await launchRunner({
        ...baseWmiInput(),
        wmiSpawnBrokerFn: async () => ({ ok: false, detail }),
        killDeps: kill.deps,
      });
      assert.equal(r.outcome, "start_failed", detail);
      assert.equal(r.reason, "wmi_create_failed", detail);
      assert.equal(r.detail, detail);
      assert.equal(r.killConfirmed, null, "确定没起来——不做兜底结束");
      assert.deepEqual(kill.events, [], "没杀任何进程、没做扫描");
      assert.ok(runnerLaunchFailureText(r.reason).includes("WAO_RUNNER_LAUNCH=spawn"));
    }
  } finally {
    restore();
  }
});

test("WMI 路径：桥不连管道 → start_failed(bridge_timeout)，且尽力结束桥 pid（续修 5）", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  const kill = makeFakeKillDeps();
  try {
    const r = await launchRunner({
      ...baseWmiInput({ runId: "run_bt1", args: ["x", "--run-id", "run_bt1"] }),
      timeoutMs: 250,
      wmiSpawnBrokerFn: async () => ({ ok: true, pid: 8801 }),
      killDeps: kill.deps,
    });
    assert.equal(r.outcome, "start_failed");
    assert.equal(r.reason, "bridge_timeout");
    assert.ok(runnerLaunchFailureText(r.reason).includes("runner 未启动"), "bridge_timeout 不属于'可能已起'");
    assert.deepEqual(kill.killed, [8801], "WMI 给出的桥 pid 被 taskkill（尽力而为）");
    assert.deepEqual(kill.scanned, [], "不做扫描（runner 未启动）");
  } finally {
    restore();
  }
});

test("WMI 路径：握手不发 / 发错 nonce / 坏帧 → bridge_unverified，抢先连上者收不到任何载荷字节", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  try {
    for (const handshake of ["silent", "wrong", "garbage"]) {
      const kill = makeFakeKillDeps();
      const { wmiSpawnBrokerFn, record } = makeFakeBroker({ handshake, pid: 8810 });
      const r = await launchRunner({
        ...baseWmiInput(),
        wmiSpawnBrokerFn,
        killDeps: kill.deps,
      });
      assert.equal(r.outcome, "start_failed", handshake);
      assert.equal(r.reason, "bridge_unverified", handshake);
      assert.ok(runnerLaunchFailureText(r.reason).includes("载荷未发出"), handshake);
      assert.equal(record.payload, null, `${handshake}：没收到载荷帧`);
      assert.equal(record.receivedBytes, 0, `${handshake}：连接后零字节到达——载荷从未离开父端`);
      assert.deepEqual(kill.killed, [8810], `${handshake}：桥 pid 尽力结束`);
      assert.deepEqual(kill.scanned, [], `${handshake}：不做扫描（runner 未启动）`);
    }
  } finally {
    restore();
  }
});

test("WMI 路径：载荷已发、回帧丢失且结束确认 → bridge_reply_missing（原码保留，续修 1 的对照面）", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  const kill = makeFakeKillDeps({ scanPids: [31337] });
  const { wmiSpawnBrokerFn } = makeFakeBroker({ pid: 8802, onPayload: (_p, socket) => { socket.destroy(); } });
  try {
    const r = await launchRunner({
      ...baseWmiInput({ runId: "run_rm1", args: ["x", "--run-id", "run_rm1"] }),
      timeoutMs: 1500,
      wmiSpawnBrokerFn,
      killDeps: kill.deps,
    });
    assert.equal(r.outcome, "start_failed");
    assert.equal(r.reason, "bridge_reply_missing", "确认了就用原码");
    assert.equal(r.detail, undefined);
    assert.equal(r.killConfirmed, true);
    assert.equal(r.killScanOk, true);
    assert.ok(runnerLaunchFailureText(r.reason).includes("已被结束并确认"), "此时这句话才是真的");
  } finally {
    restore();
  }
});

test("WMI 路径：回帧是坏 JSON 且结束确认 → bridge_reply_invalid", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  const kill = makeFakeKillDeps();
  const { wmiSpawnBrokerFn } = makeFakeBroker({
    pid: 8803,
    onPayload: (_p, socket) => {
      // 完整一帧、声明长度与体一致，但 JSON 解析不开。
      const body = Buffer.from("{oops", "utf8");
      const garbage = Buffer.alloc(4 + body.length);
      garbage.writeUInt32BE(body.length, 0);
      body.copy(garbage, 4);
      socket.end(garbage);
    },
  });
  try {
    const r = await launchRunner({
      ...baseWmiInput(),
      wmiSpawnBrokerFn,
      killDeps: kill.deps,
    });
    assert.equal(r.outcome, "start_failed");
    assert.equal(r.reason, "bridge_reply_invalid");
    assert.equal(r.killConfirmed, true);
    assert.ok(kill.killed.includes(8803));
  } finally {
    restore();
  }
});

test("WMI 路径：回帧 handoff=timeout 且结束确认 → handoff_timeout（按 runnerPid 结束）", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  const kill = makeFakeKillDeps();
  const { wmiSpawnBrokerFn } = makeFakeBroker({
    pid: 8804,
    onPayload: (_p, socket) => { socket.end(encodeFrame({ runnerPid: 555, handoff: "timeout" })); },
  });
  try {
    const r = await launchRunner({
      ...baseWmiInput(),
      wmiSpawnBrokerFn,
      killDeps: kill.deps,
    });
    assert.equal(r.outcome, "start_failed");
    assert.equal(r.reason, "handoff_timeout");
    assert.equal(runnerLaunchFailureText(r.reason), PROMPT_HANDOFF_TIMEOUT_TEXT);
    assert.ok(kill.killed.includes(555), "runner pid 被 taskkill");
    assert.ok(kill.killed.includes(8804), "桥 pid 也被 taskkill");
    assert.equal(r.killConfirmed, true);
  } finally {
    restore();
  }
});

test("WMI 路径：回帧 handoff=runner_exited → started（runner 自己的失败路径落盘）", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  const kill = makeFakeKillDeps();
  const { wmiSpawnBrokerFn } = makeFakeBroker({
    pid: 8805,
    onPayload: (_p, socket) => { socket.end(encodeFrame({ runnerPid: 666, handoff: "runner_exited" })); },
  });
  try {
    const r = await launchRunner({
      ...baseWmiInput(),
      wmiSpawnBrokerFn,
      killDeps: kill.deps,
    });
    assert.equal(r.outcome, "started");
    assert.equal(r.runnerPid, 666);
    assert.deepEqual(kill.events, [], "不 kill");
  } finally {
    restore();
  }
});

test("WMI 路径：载荷超限 → 起任何进程之前失败 payload_too_large", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  let brokerCalled = false;
  try {
    const r = await launchRunner({
      ...baseWmiInput({ env: { BIG: "x".repeat(5 * 1024 * 1024) } }),
      wmiSpawnBrokerFn: async () => { brokerCalled = true; return { ok: true, pid: 1 }; },
      killDeps: makeFakeKillDeps().deps,
    });
    assert.equal(r.outcome, "start_failed");
    assert.equal(r.reason, "payload_too_large");
    assert.equal(brokerCalled, false, "没起桥");
  } finally {
    restore();
  }
});

// ── 兜底结束：顺序、二次扫描、预算、未确认折叠（续修 1/2）────────────────────

test("兜底结束顺序：已知 pid 先 taskkill，再扫描结束命中，再扫第二次；确认 = 全死 + 二扫干净", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  const kill = makeFakeKillDeps({ scanPids: [31337] });
  const { wmiSpawnBrokerFn } = makeFakeBroker({ pid: 8806, onPayload: (_p, socket) => { socket.destroy(); } });
  try {
    const r = await launchRunner({
      ...baseWmiInput({ runId: "run_ko1", args: ["x", "--run-id", "run_ko1"] }),
      timeoutMs: 1500,
      wmiSpawnBrokerFn,
      killDeps: kill.deps,
    });
    assert.deepEqual(
      kill.events,
      ["taskkill:8806", "scan1", "taskkill:31337", "scan2"],
      "已知 pid（桥）先于扫描结束；扫描命中也结束；随后再扫一次",
    );
    assert.equal(r.reason, "bridge_reply_missing", "全部干净 → 原码");
    assert.equal(kill.scanned.length, 2, "两次扫描都带 runId 与时间下限");
    assert.ok(kill.scanned.every((s) => s.runId === "run_ko1" && Number.isFinite(s.notBeforeMs)));
  } finally {
    restore();
  }
});

test("兜底结束：第二次扫描仍有命中 → 不确认 → 折叠成 runner_kill_unconfirmed（原原因进 detail）", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  const kill = makeFakeKillDeps({ scanResults: [{ ok: true, pids: [] }, { ok: true, pids: [9999] }] });
  const { wmiSpawnBrokerFn } = makeFakeBroker({ pid: 8807, onPayload: (_p, socket) => { socket.destroy(); } });
  try {
    const r = await launchRunner({
      ...baseWmiInput({ runId: "run_ko2", args: ["x", "--run-id", "run_ko2"] }),
      timeoutMs: 1500,
      wmiSpawnBrokerFn,
      killDeps: kill.deps,
    });
    assert.equal(r.outcome, "start_failed");
    assert.equal(r.reason, "runner_kill_unconfirmed");
    assert.equal(r.detail, "bridge_reply_missing", "原原因码放进 detail");
    assert.equal(r.killConfirmed, false);
    assert.equal(r.killScanOk, true, "扫描本身成功——是仍有命中，不是扫描失败");
    assert.ok(runnerLaunchFailureText(r.reason).includes("wao runs settle"));
  } finally {
    restore();
  }
});

test("兜底结束：第二次扫描失败 → killScanOk=false → 同样折叠成 runner_kill_unconfirmed", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  const kill = makeFakeKillDeps({ scanResults: [{ ok: true, pids: [] }, { ok: false }] });
  const { wmiSpawnBrokerFn } = makeFakeBroker({ pid: 8808, onPayload: (_p, socket) => { socket.destroy(); } });
  try {
    const r = await launchRunner({
      ...baseWmiInput({ runId: "run_ko3", args: ["x", "--run-id", "run_ko3"] }),
      timeoutMs: 1500,
      wmiSpawnBrokerFn,
      killDeps: kill.deps,
    });
    assert.equal(r.reason, "runner_kill_unconfirmed");
    assert.equal(r.killScanOk, false, "扫描失败如实上报");
    assert.equal(r.killConfirmed, false);
  } finally {
    restore();
  }
});

test("兜底结束：预算用完（第二次扫描没做成）→ killScanOk=false", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  const kill = makeFakeKillDeps({ budgetMs: 1 });
  // 第一次扫描真睡 50ms：预算（1ms）在它做完时就没了 → 不做第二次扫描。
  const realScan = kill.deps.scanFn;
  kill.deps.scanFn = async (runId, notBeforeMs, opts) => {
    await new Promise((res) => { setTimeout(res, 50); });
    return realScan(runId, notBeforeMs, opts);
  };
  const { wmiSpawnBrokerFn } = makeFakeBroker({ pid: 8809, onPayload: (_p, socket) => { socket.destroy(); } });
  try {
    const r = await launchRunner({
      ...baseWmiInput({ runId: "run_ko4", args: ["x", "--run-id", "run_ko4"] }),
      timeoutMs: 1500,
      wmiSpawnBrokerFn,
      killDeps: kill.deps,
    });
    assert.equal(r.reason, "runner_kill_unconfirmed");
    assert.equal(r.killScanOk, false, "预算用完按扫描不成功处理");
    assert.equal(kill.scanned.length, 1, "只做了第一次扫描");
    assert.ok(Number.isInteger(kill.scanned[0].timeoutMs) && kill.scanned[0].timeoutMs >= 1
      && kill.scanned[0].timeoutMs <= 1, "扫描的超时取剩余预算（这里预算只有 1ms）");
    assert.deepEqual(kill.events, ["taskkill:8809", "scan1"], "已知 pid 的结束不受预算影响");
  } finally {
    restore();
  }
});

test("兜底结束：已知 pid 没死 → 不确认", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  const kill = makeFakeKillDeps({ alivePids: [8809] });
  const { wmiSpawnBrokerFn } = makeFakeBroker({ pid: 8809, onPayload: (_p, socket) => { socket.destroy(); } });
  try {
    const r = await launchRunner({
      ...baseWmiInput({ runId: "run_ko5", args: ["x", "--run-id", "run_ko5"] }),
      timeoutMs: 1500,
      wmiSpawnBrokerFn,
      killDeps: kill.deps,
    });
    assert.equal(r.reason, "runner_kill_unconfirmed");
    assert.equal(r.killConfirmed, false);
    assert.equal(r.killScanOk, true, "扫描干净，但桥 pid 判活 → 不确认");
  } finally {
    restore();
  }
});

// ── 三处调用方（假 spawn / 假 launchRunnerFn，不起真进程）────────────────────

test("dispatchRun → 启动模块：argv 带 --run-id 与摘要，env 含凭据，cwd=process.cwd()，stderr fd 已开", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-launch-dispatch-"));
  const { fakeSpawn, calls } = makeFakeSpawn({ pid: 5100 });
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { coder_low: { backend: "claude-code", cwd: dir, model: { id: "glm-5-turbo" } } },
    }), "utf8");
    const result = await dispatchRun({
      agentId: "coder_low",
      prompt: "do the task",
      registryPath,
      runDir: join(dir, "runs"),
      spawnFn: fakeSpawn,
      skipCredentialCheck: true,
      resolvedCredentials: { WAO_TEST_TOKEN: "tok-123" },
    });
    assert.equal(result.accepted, true);
    const [call] = calls;
    assert.equal(call.execPath, process.execPath);
    assert.equal(call.args[call.args.indexOf("--run-id") + 1], result.runId);
    assert.ok(call.args.includes("--prompt-stdin"), "argv 只带提示词摘要");
    assert.equal(call.opts.env.WAO_TEST_TOKEN, "tok-123", "解析出的凭据进 env");
    assert.equal(call.opts.cwd, process.cwd(), "cwd 是调用方此刻的工作目录");
    assert.equal(typeof call.opts.stdio[2], "number", "stderr fd");
    assert.equal(call.stdinText, "do the task");
    try {
      accessSync(join(dir, "runs", `.runner-${result.runId}.stderr`));
      assert.ok(true, "stderr 证据文件已创建");
    } catch {
      assert.fail("stderr 证据文件未创建");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatchRun：结束未确认（launchRunnerFn 注入）→ 只写 run.error(runner_start)，转录停在 pending，抛固定文字", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-launch-ku-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { coder_low: { backend: "claude-code", cwd: dir } },
    }), "utf8");
    const runDir = join(dir, "runs");
    const seenInputs = [];
    await assert.rejects(() => dispatchRun({
      agentId: "coder_low",
      prompt: "x",
      registryPath,
      runDir,
      launchRunnerFn: async (input) => {
        seenInputs.push(input);
        return { outcome: "start_failed", runnerPid: 321, reason: "runner_kill_unconfirmed", detail: "bridge_reply_missing", killConfirmed: false, killScanOk: false };
      },
    }), /运行保持 pending，用 wao runs settle 判定/);
    assert.equal(seenInputs.length, 1, "启动模块恰被调一次");
    assert.equal(seenInputs[0].spawnFn, undefined, "未注入 spawnFn 时原样穿线");
    const transcriptPath = resolveTranscriptPath(runDir, seenInputs[0].runId);
    const events = await readTranscript(transcriptPath);
    const err = findLatest(events, "run.error");
    assert.equal(err.phase, "runner_start");
    assert.ok(err.error.includes("未能确认它已结束"), "run.error 用固定文字");
    // findState 对裸 run.error 有 legacy failed 兜底——按"没有任何终态转移"断言。
    assert.ok(
      !events.some((e) => e.type === "run.state_change" && ["failed", "completed", "aborted", "timed_out"].includes(e.to)),
      "没有终态转移——不转 failed，交 settle 判定",
    );
    const lastChange = [...events].reverse().find((e) => e.type === "run.state_change");
    assert.equal(lastChange.to, "pending", "最后一个状态转移仍是 pending");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatchRun：结束已确认（launchRunnerFn 注入）→ 照旧 run.error + failed + 抛原码文字", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-launch-kc-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { coder_low: { backend: "claude-code", cwd: dir } },
    }), "utf8");
    const runDir = join(dir, "runs");
    await assert.rejects(() => dispatchRun({
      agentId: "coder_low",
      prompt: "x",
      registryPath,
      runDir,
      launchRunnerFn: async () => ({ outcome: "start_failed", runnerPid: null, reason: "bridge_reply_missing", killConfirmed: true, killScanOk: true }),
    }), /已被结束并确认/);
    const [only] = (await import("../../src/projectBuckets.js")).listTranscriptsDeep(runDir);
    const events = await readTranscript(only.path);
    assert.equal(events.find((e) => e.type === "run.error")?.phase, "runner_start");
    assert.equal(findState(events), "failed", "确认了 → 照旧收口成 failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forkResumeRunner → 启动模块：resume 无 prompt（stdin=ignore）仍带 env，cwd=process.cwd()", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-launch-fork-"));
  const { fakeSpawn, calls } = makeFakeSpawn({ pid: 5200 });
  try {
    await forkResumeRunner(
      "run_fork_shape",
      { runDir: dir, registry: "reg.json" },
      { runDir: "runs-default", registry: "reg-default.json", pollInterval: 1000 },
      fakeSpawn,
    );
    const [call] = calls;
    assert.equal(call.execPath, process.execPath);
    assert.equal(call.args[call.args.indexOf("--resume-run-id") + 1], "run_fork_shape");
    assert.equal(call.opts.stdio[0], "ignore", "resume 无提示词交接");
    assert.ok(call.opts.env && typeof call.opts.env === "object", "resume 仍带 env");
    assert.equal(call.opts.cwd, process.cwd());
    assert.equal(call.unrefCalled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forkResumeRunner：结束未确认（launchRunnerFn 注入）→ 抛固定文字", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-launch-fku-"));
  try {
    await assert.rejects(
      () => forkResumeRunner(
        "run_fork_ku",
        { runDir: dir, registry: "reg.json" },
        { runDir: "runs-default", registry: "reg-default.json", pollInterval: 1000 },
        undefined,
        undefined,
        async () => ({ outcome: "start_failed", runnerPid: 9, reason: "runner_kill_unconfirmed", detail: "handoff_timeout", killConfirmed: false, killScanOk: true }),
      ),
      /运行保持 pending，用 wao runs settle 判定/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
