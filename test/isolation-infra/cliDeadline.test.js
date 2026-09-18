// test/cli.test.js
//
// TD-151（ADR-0030 落地）CLI 面验收钉：
//   1. 前台继续等钉：等待窗到期 → CLI 在到期时刻打印一行通知（含 `runs wait` 有界
//      观察 + `--background` 存活指引）后继续等到自然终态（非 timed_out）。
//   2. resume 挂起脸修复钉（TD-148 姊妹脸 (a)）：`resume` 不带 --wait 改为 detached
//      runner 托管——(a) fork 形状钉（detached + stdio ignore + unref + --resume-run-id，
//      注入 spawnFn 证伪：回退到进程内 resume 则零 fork 即红）；(b) 真子进程钉
//      （CLI 进程在 resume 委托后立即退出——旧形状会被 ref'd 子管道吊住超时）；
//      (c) 终态拒绝钉（本地拒绝形状，零 fork）。
//
// 根语义钉在 test/runManager.test.js；后台 runner 钉在 test/backgroundRunner.test.js。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { dirname, join } from "node:path";

import { runAndWait, printObservationDeadlineNotice } from "../../src/commands/run.js";
import { forkResumeRunner, resumeCommand } from "../../src/commands/lifecycle.js";
import { JsonlTranscript, STATE_CHANGE_REASON } from "../../src/transcript.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(import.meta.dirname, "../..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 钉 1：前台继续等 + 通知可见 ─────────────────────────────────────────────
test("TD-151 前台钉: 到期 → 通知行（含 runs wait / --background 指引）后继续等到自然 completed", async () => {
  const noticeCalls = [];
  const originalError = console.error;
  console.error = (line) => noticeCalls.push(String(line));
  try {
    // 假 run：先在到期时刻回调 onObservationDeadline（waitForCompletion 的契约），
    // 随后自然完成；run.observationDeadlineReached 置 true（Run 的内存镜像）。
    const fakeRun = {
      transcript: { context: { runId: "run_td151_fg" }, filePath: join(os.tmpdir(), "nonexistent-td151.jsonl") },
      observationDeadlineReached: false,
      async waitForCompletion(opts) {
        assert.equal(typeof opts.onObservationDeadline, "function",
          "runAndWait 必须注入 onObservationDeadline 回调（到期通知的时序基础）");
        await sleep(5);
        this.observationDeadlineReached = true;
        opts.onObservationDeadline({ waitTimeoutMs: 30000, source: "explicit" });
        await sleep(5); // 通知后继续等
        return { completed: true, messages: [], evidence: [], timedOut: false, metrics: null };
      },
    };
    const result = await runAndWait(fakeRun, {});
    assert.equal(result.completed, true, "到期后仍应等到自然 completed");
    assert.equal(result.observationDeadlineReached, true,
      "结果应携带 observationDeadlineReached:true");
    assert.equal(noticeCalls.length, 1, "到期通知恰打印一行");
    const line = noticeCalls[0];
    assert.match(line, /run_td151_fg/, "通知行应含 runId");
    assert.match(line, /observation deadline reached/, "通知行应说明等待窗到期");
    assert.match(line, /NOT stopped/i, "通知行必须声明未停止 worker（通知不杀）");
    assert.match(line, /runs wait/, "通知行应指引自界观察（runs wait）");
    assert.match(line, /--background/, "通知行应指引存活（--background）");
  } finally {
    console.error = originalError;
  }
});

test("TD-151: 调用方已提供 onObservationDeadline 时 runAndWait 不覆盖", async () => {
  const seen = [];
  const fakeRun = {
    transcript: { context: { runId: "run_td151_custom" }, filePath: "nonexistent.jsonl" },
    observationDeadlineReached: true,
    async waitForCompletion(opts) {
      seen.push(typeof opts.onObservationDeadline);
      opts.onObservationDeadline({ waitTimeoutMs: 1000, source: "agent" });
      return { completed: true, messages: [], evidence: [], timedOut: false, metrics: null };
    },
  };
  const custom = () => { seen.push("custom-called"); };
  const result = await runAndWait(fakeRun, { onObservationDeadline: custom });
  assert.deepEqual(seen, ["function", "custom-called"], "调用方回调应被尊重并原样触发");
  assert.equal(result.observationDeadlineReached, true);
});

test("TD-151: printObservationDeadlineNotice 单行且不抛（无信息时也可打印）", () => {
  const lines = [];
  const originalError = console.error;
  console.error = (l) => lines.push(String(l));
  try {
    printObservationDeadlineNotice("run_x", { waitTimeoutMs: 5000, source: "global" });
  } finally {
    console.error = originalError;
  }
  assert.equal(lines.length, 1, "恰一行");
  assert.match(lines[0], /waitTimeout 5000ms, source global/);
});

// ── 钉 2：resume 挂起脸修复 ────────────────────────────────────────────────
test("TD-151 resume 挂起脸钉(a): fork 形状 = detached + stdio ignore + unref + --resume-run-id", async () => {
  const calls = [];
  const fakeSpawn = (execPath, args, opts) => {
    calls.push({ execPath, args, opts });
    return { unref() { calls.at(-1).unrefCalled = true; } };
  };
  await forkResumeRunner(
    "run_td151_fork",
    { runDir: "runs-x", registry: "reg-x.json", waitTimeout: "2000", pollInterval: "250" },
    { runDir: "runs-default", registry: "reg-default.json", pollInterval: 1000 },
    fakeSpawn,
  );
  assert.equal(calls.length, 1, "恰一次 fork");
  const call = calls[0];
  assert.equal(call.execPath, process.execPath);
  assert.ok(call.args.includes("--resume-run-id"));
  assert.equal(call.args[call.args.indexOf("--resume-run-id") + 1], "run_td151_fork");
  assert.ok(call.args.includes("--run-dir"));
  assert.ok(call.args[call.args.indexOf("--run-dir") + 1].endsWith("runs-x"), "显式 runDir 优先");
  assert.ok(call.args.includes("--wait-timeout"));
  assert.equal(call.args[call.args.indexOf("--wait-timeout") + 1], "2000");
  assert.equal(call.opts.detached, true, "必须 detached（runner 脱离 CLI 存活）");
  assert.equal(call.opts.stdio, "ignore", "必须 stdio ignore（CLI 不持有 runner 管道）");
  assert.equal(call.unrefCalled, true, "必须 unref（CLI 不等待 runner）");
});

test("TD-151 resume 挂起脸钉(a): 非法 --wait-timeout 在 fork 前被拒（零 fork）", async () => {
  let spawnCalls = 0;
  const fakeSpawn = () => { spawnCalls += 1; return { unref() {} }; };
  await assert.rejects(
    () => forkResumeRunner(
      "run_x",
      { waitTimeout: "50" },
      { runDir: "r", registry: "g" },
      fakeSpawn,
    ),
    /Invalid waitTimeout/,
  );
  assert.equal(spawnCalls, 0, "校验失败必须零 fork");
});

test("TD-151 resume 钉(c): 终态 run 不带 --wait → 本地拒绝形状，零 fork", async () => {
  const dir = await mkdtemp(join(os.tmpdir(), "wao-td151-cliterm-"));
  const originalLog = console.log;
  const printed = [];
  console.log = (s) => printed.push(String(s));
  try {
    const runId = "run_td151_cli_terminal";
    const transcript = new JsonlTranscript(join(dir, `${runId}.jsonl`), {
      runId, agentId: "w",
    });
    await transcript.append("run.started", { backend: "claude-code", cwd: dir });
    await transcript.append("session.created", { backendSessionId: "proc_c" });
    await transcript.append("prompt.sent", { prompt: "done" });
    await transcript.transitionState("running", "completed", STATE_CHANGE_REASON.done);

    // 行为断言：终态路径只打印一行既有拒绝 JSON 且立即返回（fork 与否由钉(a)的
    // 形状断言覆盖；若回退为进程内 resume，终态 gate 同样返回 null——但 CLI 会在
    // newRunManager 后才拒绝，钉(b) 的不挂起断言会抓住 ref'd 管道形状）。
    await resumeCommand([runId, "--run-dir", dir], { runDir: dir, registry: "x" });
    assert.equal(printed.length, 1, "终态拒绝恰打印一行");
    const parsed = JSON.parse(printed[0]);
    assert.equal(parsed.resumed, false);
    assert.equal(parsed.reason, "terminal or not found");
  } finally {
    console.log = originalLog;
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-151 resume 挂起脸钉(b): 真子进程——CLI 在 resume 委托后立即退出（不挂起）", async () => {
  const dir = await mkdtemp(join(os.tmpdir(), "wao-td151-clifork-"));
  try {
    const runId = "run_td151_cli_delegate";
    const transcript = new JsonlTranscript(join(dir, `${runId}.jsonl`), {
      runId, agentId: "delegate_worker",
    });
    await transcript.append("run.started", { backend: "claude-code", cwd: dir });
    await transcript.append("session.created", { backendSessionId: "proc_d" });
    await transcript.append("prompt.sent", { prompt: "delegate me" });
    await transcript.append("run.submitted", {});
    await transcript.append("run.state_change", { from: "pending", to: "submitted", reason: "spawned" });

    const registryPath = join(dir, "agents.json");
    await writeFile(registryPath, JSON.stringify({
      agents: {
        delegate_worker: {
          backend: "claude-code",
          // 不存在的 binary：runner 侧 respawn 会快速失败——本钉只关心 CLI 不挂起。
          binary: "nonexistent-binary-td151",
          cwd: dir,
        },
      },
    }), "utf8");

    const result = spawnSync(process.execPath, [
      join(ROOT, "src", "cli.js"),
      "resume", runId,
      "--registry", registryPath,
      "--run-dir", dir,
    ], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" },
    });

    assert.equal(result.error, undefined,
      `CLI 进程必须在 resume 委托后退出（不被 ref'd 管道吊住），实际 ${result.error}`);
    assert.equal(result.status, 0, `resume 应成功委托: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.resumed, true);
    assert.equal(parsed.delegated, "background-runner");
    assert.match(parsed.note, /detached runner owns the resumed lifecycle/);
    // 委托后 CLI 不持有 worker：transcript 仍在（runner 异步续跑/失败都由 runner 落盘）。
    assert.ok(existsSync(join(dir, `${runId}.jsonl`)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
