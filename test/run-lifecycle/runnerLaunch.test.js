// test/run-lifecycle/runnerLaunch.test.js
//
// TD-347（第 93 批）：runner 启动模块（src/application/runnerLaunch.js）+ 管道帧
// 协议（src/application/runnerFrame.js）的单元测试。
//
// 全部注入桩，不起真进程：WMI 侧注入 wmiSpawnBrokerFn（假"起桥"），管道对端是
// 测试进程内的 net 客户端（假桥，按帧协议说话）；三处调用方的形状断言用假 spawn。
// 真进程的桥测试见 runnerBroker.test.js；真作业存活证明见 runnerLaunchJob.test.js。

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

// 假桥：连上管道 → 读一帧载荷 → 按脚本行动（回帧/关管道/什么都不做）。载荷与
// 连接到的管道名都记录在返回的句柄上。"起桥"promise 在 connect 即落定（真实
// 语义：PowerShell 退出 = 创建完成，桥进程自己活着干活）。
function makeFakeBroker(script, pid = 8800) {
  const record = { payload: null, connectedPipe: null };
  const wmiSpawnBrokerFn = (pipeName) => new Promise((resolveLaunch) => {
    record.connectedPipe = pipeName;
    const socket = connect(pipeName);
    const decoder = new FrameDecoder();
    socket.on("error", () => resolveLaunch({ ok: false, detail: "connect failed" }));
    socket.on("connect", () => {
      resolveLaunch({ ok: true, pid });
      socket.on("data", (chunk) => {
        let frame;
        try {
          const r = decoder.push(chunk);
          if (r.status !== "frame") return;
          frame = r.value;
        } catch {
          try { socket.destroy(); } catch { /* 已关 */ }
          return;
        }
        record.payload = frame;
        script(frame, socket);
      });
    });
    // 兜底：脚本决定不回也不关时，别让套接字挂满 4 秒。
    setTimeout(() => { try { socket.destroy(); } catch { /* 已关 */ } }, 4000).unref();
  });
  return { wmiSpawnBrokerFn, record };
}

// 假 killDeps：全部记录，默认"杀完就死"。
function makeFakeKillDeps({ scanPids = [], scanOk = true } = {}) {
  const killed = [];
  const scanned = [];
  return {
    deps: {
      taskkillFn: (pid) => { killed.push(pid); return { called: true, exitCode: 0 }; },
      scanFn: async (runId, notBeforeMs) => {
        scanned.push({ runId, notBeforeMs });
        return scanOk ? { ok: true, pids: [...scanPids] } : { ok: false };
      },
      isAliveFn: () => false,
      sleepFn: async () => { throw new Error("isAliveFn 恒 false，不该再睡"); },
    },
    killed,
    scanned,
  };
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
  const value = { execPath: "node", args: ["a", "b"], env: { X: "1" }, cwd: "d", prompt: null, stderrPath: "s" };
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
  const badJson = Buffer.alloc(8);
  badJson.writeUInt32BE(3, 0);
  badJson.write("{oops", 4, "utf8");
  const over = new FrameDecoder();
  assert.throws(() => over.push(badJson.subarray(0, 7)), /incomplete|malformed/);
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

test("载荷/回帧校验：坏形状拒绝，好形状放行", () => {
  const goodPayload = { execPath: "n", args: ["a"], env: { A: "b" }, cwd: "d", prompt: null, stderrPath: "s" };
  assert.deepEqual(validateBrokerPayload(goodPayload), goodPayload);
  assert.deepEqual(validateBrokerPayload({ ...goodPayload, prompt: "任务书" }), { ...goodPayload, prompt: "任务书" });
  for (const bad of [
    { ...goodPayload, execPath: "" },
    { ...goodPayload, args: ["ok", 42] },
    { ...goodPayload, env: { A: 1 } },
    { ...goodPayload, cwd: 5 },
    { ...goodPayload, prompt: 7 },
    { ...goodPayload, stderrPath: null },
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

test("桥命令行与 WMI 脚本：拼装形状固定，不含凭据", () => {
  const pieces = { execPath: "C:\\Program Files\\nodejs\\node.exe", brokerPath: DEFAULT_BROKER_PATH, pipeName: "\\\\.\\pipe\\wao-runner-run_x-abc", runId: "run_x" };
  const cmd = buildBrokerCommandLine(pieces);
  assert.equal(cmd, '"C:\\Program Files\\nodejs\\node.exe" "' + DEFAULT_BROKER_PATH + '" --pipe \\\\.\\pipe\\wao-runner-run_x-abc --run-id run_x');
  const script = buildWmiCreateScript({ ...pieces, cwd: "D:\\w" });
  // 脚本只携带四个 b64 参数 + 固定 PS 语句：凭据、任务书、runner argv 一概不在。
  for (const secret of ["secret-value-xyz", "WAO_SECRET_TOKEN", "do the task", "backgroundRunner.js"]) {
    assert.ok(!script.includes(secret), `WMI 脚本不含 ${secret}`);
  }
  assert.ok(script.includes(Buffer.from(pieces.execPath, "utf8").toString("base64")), "execPath 以 b64 进脚本");
  assert.ok(script.includes(Buffer.from(pieces.pipeName, "utf8").toString("base64")), "pipeName 以 b64 进脚本");
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
  assert.ok(script.includes("--run-id run_k1") || script.includes("*--run-id run_k1*"), "按 --run-id 匹配");
  assert.ok(script.includes("*--resume-run-id run_k1*"), "按 --resume-run-id 匹配");
  assert.ok(script.includes("1699999995000"), "时间下限 −5s");
  assert.ok(!script.includes("secret"), "不含凭据");
  assert.deepEqual(parseKillScanOutput("wao-killscan-ok:2:101 202"), { ok: true, pids: [101, 202] });
  assert.deepEqual(parseKillScanOutput("wao-killscan-ok:0:"), { ok: true, pids: [] });
  assert.deepEqual(parseKillScanOutput("wao-killscan-ok:1:abc"), { ok: false });
  assert.deepEqual(parseKillScanOutput(""), { ok: false });
});

test("失败原因闭集与固定文本：wmi_create_failed 点名开关；交接超时用提示词超时文案", () => {
  assert.ok(RUNNER_LAUNCH_FAIL_REASONS.includes("wmi_create_failed"));
  const t = runnerLaunchFailureText("wmi_create_failed");
  assert.ok(t.includes("WAO_RUNNER_LAUNCH=spawn"), "点名开关");
  assert.ok(t.includes("随宿主重启 MCP 服务而死"), "讲清退路的代价");
  assert.equal(runnerLaunchFailureText("handoff_timeout"), PROMPT_HANDOFF_TIMEOUT_TEXT);
  assert.equal(runnerLaunchFailureText("prompt_handoff_timeout"), PROMPT_HANDOFF_TIMEOUT_TEXT);
  for (const reason of RUNNER_LAUNCH_FAIL_REASONS) {
    assert.ok(typeof runnerLaunchFailureText(reason) === "string" && runnerLaunchFailureText(reason).length > 0, `每个原因都有固定文本：${reason}`);
  }
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

test("WMI 路径：桥回 handoff=written → started；载荷逐字段一致，WMI 侧不见凭据", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  const { wmiSpawnBrokerFn, record } = makeFakeBroker((_payload, socket) => {
    socket.end(encodeFrame({ runnerPid: 777, handoff: "written" }));
  });
  const seenBrokerCalls = [];
  const wrapped = async (pipeName, ctx) => {
    seenBrokerCalls.push({ pipeName, ctx });
    return wmiSpawnBrokerFn(pipeName);
  };
  const input = baseWmiInput();
  try {
    const r = await launchRunner({ ...input, wmiSpawnBrokerFn: wrapped, killDeps: makeFakeKillDeps().deps });
    assert.equal(r.outcome, "started");
    assert.equal(r.runnerPid, 777);
    // WMI 起桥的输入只有管道名 + 四个 b64 进脚本的字段——env/prompt/args 不在其中。
    assert.equal(seenBrokerCalls.length, 1);
    assert.ok(seenBrokerCalls[0].pipeName.startsWith("\\\\.\\pipe\\wao-runner-run_test_ab1-"), "管道名带 runId + 随机后缀");
    assert.ok(/[0-9a-f]{32}$/.test(seenBrokerCalls[0].pipeName), "128 位随机十六进制后缀");
    assert.deepEqual(
      Object.keys(seenBrokerCalls[0].ctx).sort(),
      ["brokerPath", "cwd", "execPath", "runId", "timeoutMs"],
      "WMI 侧上下文绝不含 env/prompt/runner argv",
    );
    // 桥收到的载荷与输入逐字段一致（凭据只在载荷里）。
    assert.deepEqual(record.payload, {
      execPath: input.execPath,
      args: input.args,
      env: input.env,
      cwd: input.cwd,
      prompt: input.prompt,
      stderrPath: input.stderrPath,
    });
    assert.equal(record.payload.env.WAO_SECRET_TOKEN, "secret-value-xyz", "凭据在载荷里");
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
      assert.deepEqual(kill.killed, [], "没杀任何进程");
      assert.deepEqual(kill.scanned, [], "没做扫描");
      assert.ok(runnerLaunchFailureText(r.reason).includes("WAO_RUNNER_LAUNCH=spawn"));
    }
  } finally {
    restore();
  }
});

test("WMI 路径：桥不连管道 → 关管道 start_failed(bridge_timeout)，不 kill", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
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
    assert.deepEqual(kill.killed, [], "桥自己会退出，不 kill");
  } finally {
    restore();
  }
});

test("WMI 路径：载荷已发、回帧丢失 → kill 桥 pid + 扫描兜底 → start_failed(bridge_reply_missing)", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  const kill = makeFakeKillDeps({ scanPids: [31337] });
  // 假桥：连上、拿载荷、直接断开（不回帧）。
  const { wmiSpawnBrokerFn } = makeFakeBroker((_p, socket) => { socket.destroy(); }, 8802);
  try {
    const r = await launchRunner({
      ...baseWmiInput({ runId: "run_rm1", args: ["x", "--run-id", "run_rm1"] }),
      timeoutMs: 1500,
      wmiSpawnBrokerFn,
      killDeps: kill.deps,
    });
    assert.equal(r.outcome, "start_failed");
    assert.equal(r.reason, "bridge_reply_missing");
    assert.equal(r.killConfirmed, true);
    assert.ok(kill.killed.includes(8802), "桥 pid 被 taskkill");
    assert.ok(kill.killed.includes(31337), "扫描命中的 pid 被 taskkill");
    assert.equal(kill.scanned.length, 1, "兜底扫描一次");
    assert.equal(kill.scanned[0].runId, "run_rm1");
    assert.ok(Number.isFinite(kill.scanned[0].notBeforeMs), "带创建时间下限");
  } finally {
    restore();
  }
});

test("WMI 路径：回帧是坏 JSON → start_failed(bridge_reply_invalid)，同样兜底结束", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  const kill = makeFakeKillDeps();
  const { wmiSpawnBrokerFn } = makeFakeBroker((_p, socket) => {
    // 完整一帧、声明长度与体一致，但 JSON 解析不开。
    const body = Buffer.from("{oops", "utf8");
    const garbage = Buffer.alloc(4 + body.length);
    garbage.writeUInt32BE(body.length, 0);
    body.copy(garbage, 4);
    socket.end(garbage);
  }, 8803);
  try {
    const r = await launchRunner({
      ...baseWmiInput(),
      wmiSpawnBrokerFn,
      killDeps: kill.deps,
    });
    assert.equal(r.outcome, "start_failed");
    assert.equal(r.reason, "bridge_reply_invalid");
    assert.ok(kill.killed.includes(8803));
  } finally {
    restore();
  }
});

test("WMI 路径：回帧 handoff=timeout → 按 runnerPid 结束 → start_failed(handoff_timeout)", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  const kill = makeFakeKillDeps();
  const { wmiSpawnBrokerFn } = makeFakeBroker((_p, socket) => {
    socket.end(encodeFrame({ runnerPid: 555, handoff: "timeout" }));
  }, 8804);
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
  const { wmiSpawnBrokerFn } = makeFakeBroker((_p, socket) => {
    socket.end(encodeFrame({ runnerPid: 666, handoff: "runner_exited" }));
  }, 8805);
  try {
    const r = await launchRunner({
      ...baseWmiInput(),
      wmiSpawnBrokerFn,
      killDeps: kill.deps,
    });
    assert.equal(r.outcome, "started");
    assert.equal(r.runnerPid, 666);
    assert.deepEqual(kill.killed, [], "不 kill");
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

test("WMI 路径：兜底扫描失败 → killScanOk=false（不谎称干净）", { skip: !IS_WINDOWS && "WMI 路径仅 Windows" }, async () => {
  const restore = withoutSpawnSwitch();
  const kill = makeFakeKillDeps({ scanOk: false });
  const { wmiSpawnBrokerFn } = makeFakeBroker((_p, socket) => { socket.destroy(); }, 8806);
  try {
    const r = await launchRunner({
      ...baseWmiInput({ runId: "run_sf1", args: ["x", "--run-id", "run_sf1"] }),
      timeoutMs: 1500,
      wmiSpawnBrokerFn,
      killDeps: kill.deps,
    });
    assert.equal(r.outcome, "start_failed");
    assert.equal(r.reason, "bridge_reply_missing");
    assert.equal(r.killScanOk, false, "扫描失败如实上报");
  } finally {
    restore();
  }
});

// ── 三处调用方 → 启动模块的形状（假 spawn，不起真进程）─────────────────────────

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
    assert.ok(existsRunnerStderr(join(dir, "runs"), result.runId), "stderr 证据文件已创建");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function existsRunnerStderr(runDir, runId) {
  // 小工具：dispatch 后 stderr 文件应已存在（openSync "a" 已建）。
  try {
    accessSync(join(runDir, `.runner-${runId}.stderr`));
    return true;
  } catch {
    return false;
  }
}

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
