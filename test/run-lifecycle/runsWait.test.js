// test/runsWait.test.js
//
// TD-109 (TDD plan v2 D1): CLI `runs wait <runId>` + `runs` unknown-subcommand
// fail-closed.
//
// The command is a thin CLI adapter over the SAME runWait application service
// the MCP run_wait tool uses (src/application/runWait.js). The CLI owns only:
//   - argv parsing (--wait-ms / --format / --run-dir)
//   - Number() coercion of --wait-ms (the SERVICE is the boundary validator —
//     its exact error text must reach the user unmodified; D1-D3 收口起唯一
//     例外：非数字值 NaN 在 CLI 层以固定文案拒绝，见 D1-D3-Bug2 测试)
//   - JSON (full service result + semanticNotes) / text rendering
//   - SIGINT handling（D1-D3 收口起由 D1-D3-SIGINT 系列实测覆盖——此前本头
//     注释声称覆盖 "SIGINT handling" 而实际没有对应测试，终审遗漏-1 已修正）
//
// In-process tests inject deps.runWaitFn (stopCommand(args, config, deps)
// precedent) wrapping the real service with a fake clock so the 180s+ window
// expires in milliseconds. One subprocess test proves exit code + stderr for
// the invalid --wait-ms path. TD-114 closeout (B)：B-1 进程内断言窗口到期
// （json + text）不改 process.exitCode；B-2 子进程断言终态路径 exit 0 +
// "Terminal: yes"（终态与到期共享同一 return/print 代码路径）。字面 3 分钟
// 真实窗口被 RUN_WAIT_MIN_MS=180000 确定性排除（假时钟无法跨进程注入；
// 套件纪律禁真实长等待）。SIGINT 用 process.emit("SIGINT") 进程内驱动
// （无需真实信号）：挂起的 runWaitFn 模拟阻塞窗口，emit 后断言快照打印 +
// process.exit(1) + finally 注销。
//
// Pure group: tmp runDir, no network, no node_modules imports.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { runsCommand } from "../../src/commands/runs.js";
import { runWait } from "../../src/application/runWait.js";
import { OBSERVATION_OUTCOMES } from "../../src/application/runObservationProjection.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

// Service-level closed set (mirrors the MCP RUN_WAIT_OUTPUT enum).
const SERVICE_OBSERVATION_OUTCOMES = ["observed", "read_failure"];

function makeRunDir() {
  return mkdtempSync(join(tmpdir(), "wao-runs-wait-"));
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Stamp runId/agentId on every event (the transcript appender always does;
// the observation projector's cross-run binding requires it).
async function writeJsonl(dir, runId, events) {
  const lines = events.map((e) => JSON.stringify({ runId, agentId: "coder_low", ...e }));
  writeFileSync(join(dir, `${runId}.jsonl`), lines.join("\n") + "\n", "utf8");
}

function terminalEvents() {
  return [
    { type: "run.started", backend: "claude-code", ts: "2026-08-14T10:00:00.000Z" },
    { type: "run.state_change", from: "pending", to: "running", reason: "first_event", seq: 1 },
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "done" }], seq: 2 },
    { type: "messages.collected", reason: "ops", seq: 3 },
    { type: "run.completed", ts: "2026-08-14T10:00:30.000Z", seq: 4 },
    { type: "run.state_change", from: "running", to: "completed", reason: "done", seq: 5 },
  ];
}

function runningEvents() {
  return [
    { type: "run.started", backend: "claude-code", ts: "2026-08-14T10:00:00.000Z" },
    { type: "run.state_change", from: "pending", to: "running", reason: "first_event", seq: 1 },
  ];
}

async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map(String).join("\t")); };
  try { await fn(); }
  finally { console.log = orig; }
  return lines.join("\n");
}

// Fake clock: each _now() call advances 60s, so a 270000 ms window expires
// after ~5 loop iterations with zero real sleeping.
function fakeClock() {
  let t = 1000000;
  return () => (t += 60000);
}

// =====================================================================
// RED-1: terminal fixture → `runs wait <id> --format json` prints the
// service result (JSON.parse-able, terminal, state, returnedEarly).
// =====================================================================

test("TD-109-W1: terminal run → runs wait --format json prints service result + semanticNotes", async () => {
  const dir = makeRunDir();
  try {
    writeFileSync(join(dir, "run_done.jsonl"),
      terminalEvents().map((e) => JSON.stringify({ runId: "run_done", agentId: "coder_low", ...e })).join("\n") + "\n", "utf8");
    const out = await captureLog(() => runsCommand(["wait", "run_done", "--format", "json"], { runDir: dir }));
    const parsed = JSON.parse(out);
    assert.equal(parsed.runId, "run_done");
    assert.equal(parsed.terminal, true);
    assert.equal(parsed.state, "completed");
    assert.equal(parsed.returnedEarly, true);
    assert.equal(parsed.observationOutcome, "observed");
    // semanticNotes reuse the MCP run_wait selector (no copied catalog).
    assert.ok(Array.isArray(parsed.semanticNotes), "semanticNotes must be an array");
    assert.ok(parsed.semanticNotes.length >= 1, "semanticNotes must be non-empty");
    const ids = parsed.semanticNotes.map((n) => n.id);
    assert.ok(ids.includes("observation.terminal"), `notes must include observation.terminal, got: ${ids.join(",")}`);
    for (const n of parsed.semanticNotes) {
      assert.deepEqual(Object.keys(n).sort(), ["doesNotMean", "id", "meaning"]);
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// D1-D3 终审收口（遗漏-2 一半）: 终态 run 的 text 模式输出结构守卫。
//
// 此前只有 JSON 模式有终态断言（W1）；text 是默认格式却无结构断言。只钉
// 五行前缀结构与关键值（Run 行的 runId/state、Terminal: yes），不逐字钉
// Waited/Liveness/Observation 的动态值（避免脆弱）。
// =====================================================================

test("D1-D3-text: terminal run → runs wait（text 默认模式）五行结构：Run/Terminal/Waited/Liveness/Observation", async () => {
  const dir = makeRunDir();
  try {
    writeFileSync(join(dir, "run_done.jsonl"),
      terminalEvents().map((e) => JSON.stringify({ runId: "run_done", agentId: "coder_low", ...e })).join("\n") + "\n", "utf8");
    const out = await captureLog(() => runsCommand(["wait", "run_done"], { runDir: dir }));
    const lines = out.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 5, `text 输出恰好五行，实际 ${lines.length} 行: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /^Run: run_done \(completed\)$/, "第 1 行：Run: <runId> (<state>)");
    assert.equal(lines[1], "Terminal: yes", "第 2 行：Terminal: yes（终态）");
    assert.match(lines[2], /^Waited: \d+ ms \(window \d+ ms\)$/, "第 3 行：Waited: <ms> ms (window <ms> ms)");
    assert.match(lines[3], /^Liveness: \S+$/, "第 4 行：Liveness: <非空标签>");
    assert.match(lines[4], /^Observation: \S+( \(\S+\))?$/, "第 5 行：Observation: <outcome>[ (<observation.outcome>)]");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// RED-2: non-terminal run + fake clock → window expiry in milliseconds,
// terminal:false, observationOutcome in the service closed set.
// =====================================================================

test("TD-109-W2: non-terminal run + injected fake clock → window_expired in milliseconds", async () => {
  const dir = makeRunDir();
  try {
    await writeJsonl(dir, "run_active", runningEvents());
    const sleepCalls = [];
    const startedAt = Date.now();
    const out = await captureLog(() => runsCommand(
      ["wait", "run_active", "--format", "json"],
      { runDir: dir },
      {
        runWaitFn: (input) => runWait({
          ...input,
          sleepFn: (ms) => { sleepCalls.push(ms); return Promise.resolve(); },
          nowFn: fakeClock(),
        }),
      },
    ));
    const parsed = JSON.parse(out);
    assert.equal(parsed.terminal, false);
    assert.equal(parsed.returnedEarly, false);
    assert.ok(
      SERVICE_OBSERVATION_OUTCOMES.includes(parsed.observationOutcome),
      `observationOutcome must be in ${SERVICE_OBSERVATION_OUTCOMES.join("|")}, got: ${parsed.observationOutcome}`,
    );
    assert.ok(
      OBSERVATION_OUTCOMES.includes(parsed.observation?.outcome),
      `observation.outcome must be in ${OBSERVATION_OUTCOMES.join("|")}, got: ${parsed.observation?.outcome}`,
    );
    assert.equal(parsed.observation.outcome, "window_expired");
    // The wait loop actually ran (fake clock), but no real sleeping happened.
    assert.ok(sleepCalls.length > 0, "fake-clock wait loop must poll at least once");
    assert.ok(Date.now() - startedAt < 1000, "real elapsed time must stay in the millisecond range");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// RED-3: invalid --wait-ms values → service error text, no waiting entered.
// =====================================================================

test("TD-109-W3: out-of-range / non-integer --wait-ms → service error, wait never entered", async () => {
  const dir = makeRunDir();
  try {
    await writeJsonl(dir, "run_active", runningEvents());
    // （"abc" 曾在此列表——D1-D3 收口后非数字值由 CLI 层以固定文案拒绝，不再
    // 到达 service；该用例迁移到下方 D1-D3-Bug2 测试。这里保留仍到达 service
    // 边界的值：越界整数 / 非整数数字。）
    for (const bad of ["179999", "600001", "1.5"]) {
      const slept = [];
      const startedAt = Date.now();
      await assert.rejects(
        () => runsCommand(
          ["wait", "run_active", "--wait-ms", bad],
          { runDir: dir },
          {
            runWaitFn: (input) => runWait({
              ...input,
              sleepFn: (ms) => { slept.push(ms); return Promise.resolve(); },
              nowFn: fakeClock(),
            }),
          },
        ),
        (err) => {
          // The SERVICE's exact boundary error — the CLI must not reword it.
          assert.match(err.message, /waitMs must be an integer in \[180000, 600000\]/,
            `--wait-ms ${bad}: service error text required`);
          return true;
        },
        `--wait-ms ${bad} must be rejected`,
      );
      assert.equal(slept.length, 0, `--wait-ms ${bad}: must reject before entering the wait loop`);
      assert.ok(Date.now() - startedAt < 1000, `--wait-ms ${bad}: immediate rejection`);
    }
  } finally {
    cleanupDir(dir);
  }
});

test("TD-109-W3b: invalid runId → service error text (CLI does not swallow/reword)", async () => {
  const dir = makeRunDir();
  try {
    // Single positional token outside the isValidRunId allowlist — reaches the
    // service, which throws its own boundary error.
    await assert.rejects(
      () => runsCommand(["wait", "bad$run$id"], { runDir: dir }),
      (err) => {
        assert.match(err.message, /invalid runId/);
        assert.ok(err.message.includes("bad$run$id"), "service error interpolates the raw input");
        return true;
      },
    );
  } finally {
    cleanupDir(dir);
  }
});

test("TD-109-W3c: subprocess exit code 1 + stderr carries the service error text", () => {
  const dir = makeRunDir();
  try {
    writeFileSync(join(dir, "run_active.jsonl"),
      runningEvents().map((e) => JSON.stringify({ runId: "run_active", agentId: "coder_low", ...e })).join("\n") + "\n", "utf8");
    const r = spawnSync(
      process.execPath,
      ["src/cli.js", "runs", "wait", "run_active", "--wait-ms", "179999", "--run-dir", dir],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 30000,
        env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" },
      },
    );
    assert.notEqual(r.status, 0, `invalid --wait-ms must exit non-zero (got status ${r.status}, stdout=${r.stdout})`);
    assert.match(r.stderr, /waitMs must be an integer in \[180000, 600000\]/,
      "stderr must contain the service boundary error text");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// D1-D3 终审收口（Bug-2）: 非数字 --wait-ms 的 CLI 诊断文案。
//
// 今天 `--wait-ms abc` 经 CLI 的 Number() 强转变成 NaN 原样传给 service，
// service 报 `waitMs must be an integer in [180000, 600000], got: null`
// （原始输入丢失，用户看到的是 got:null 而非自己敲了什么）。裁决：CLI 层在
// 强转后 Number.isNaN 即拒绝，固定安全文本 `--wait-ms must be a number`
// （不回显原值）——service 边界与越界/非整数文案保持不变。
// （"abc" 从 W3 的 service 文案用例迁移至此：非数字从此由 CLI 层拒绝。）
// =====================================================================

test("D1-D3-Bug2: 非数字 --wait-ms → CLI 固定错误 --wait-ms must be a number，service 从未被调", async () => {
  const dir = makeRunDir();
  try {
    await writeJsonl(dir, "run_active", runningEvents());
    // （空串值在 flag 解析层已被 "--wait-ms must be non-empty" 拒绝，走不到
    // Number() 强转——不在此循环内。）
    for (const bad of ["abc", "12x"]) {
      const serviceCalls = [];
      await assert.rejects(
        () => runsCommand(
          ["wait", "run_active", "--wait-ms", bad],
          { runDir: dir },
          {
            runWaitFn: (input) => {
              serviceCalls.push(input);
              return runWait({ ...input, sleepFn: () => Promise.resolve(), nowFn: fakeClock() });
            },
          },
        ),
        (err) => {
          // CLI 固定安全文本——不是 service 的 got:null 文案，也不回显原值。
          assert.equal(err.message, "--wait-ms must be a number",
            `--wait-ms ${JSON.stringify(bad)}: expected the fixed CLI error`);
          return true;
        },
        `--wait-ms ${JSON.stringify(bad)} must be rejected`,
      );
      assert.equal(serviceCalls.length, 0,
        `--wait-ms ${JSON.stringify(bad)}: must reject BEFORE the service is called`);
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// RED-4: read-only invariant — the transcript bytes are unchanged and no
// audit event is appended by `runs wait`.
// =====================================================================

test("TD-109-W4: runs wait is read-only (transcript bytes unchanged)", async () => {
  const dir = makeRunDir();
  try {
    writeFileSync(join(dir, "run_ro.jsonl"),
      terminalEvents().map((e) => JSON.stringify({ runId: "run_ro", agentId: "coder_low", ...e })).join("\n") + "\n", "utf8");
    const tp = join(dir, "run_ro.jsonl");
    const before = readFileSync(tp);
    const out = await captureLog(() => runsCommand(
      ["wait", "run_ro", "--format", "json"],
      { runDir: dir },
      { runWaitFn: (input) => runWait({ ...input, sleepFn: () => Promise.resolve(), nowFn: fakeClock() }) },
    ));
    const parsed = JSON.parse(out);
    assert.equal(parsed.terminal, true, "wait result must be the service payload");
    // Byte equality subsumes "no new audit events" — the fixture deliberately
    // carries a pre-existing messages.collected event, so any append (or any
    // other mutation) must break this comparison.
    assert.equal(readFileSync(tp).equals(before), true, "transcript bytes unchanged");
    assert.equal(
      readFileSync(tp, "utf8").split("\n").filter(Boolean).length,
      before.toString("utf8").split("\n").filter(Boolean).length,
      "event line count unchanged",
    );
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// WQ-02 state coverage: missing / unparseable transcript → the service's
// fail-closed read_failure closed-set result, printed normally (exit 0 —
// a read failure is an observation outcome, not a command error).
// =====================================================================

test("TD-109-W6: missing transcript → read_failure closed-set result, no throw", async () => {
  const dir = makeRunDir();
  try {
    const out = await captureLog(() => runsCommand(["wait", "run_missing", "--format", "json"], { runDir: dir }));
    const parsed = JSON.parse(out);
    assert.equal(parsed.runId, "run_missing");
    assert.equal(parsed.terminal, false);
    assert.equal(parsed.observationOutcome, "read_failure");
    assert.equal(parsed.readFailureReason, "transcript_parse_failed");
    assert.equal(parsed.liveness, "unknown");
    assert.equal(parsed.termination, null);
    assert.ok(Array.isArray(parsed.semanticNotes) && parsed.semanticNotes.length >= 1);
    assert.deepEqual(parsed.semanticNotes.map((n) => n.id), ["observation.read_failure"]);
  } finally {
    cleanupDir(dir);
  }
});

test("TD-109-W7: corrupt transcript line → read_failure closed-set result, no throw", async () => {
  const dir = makeRunDir();
  try {
    writeFileSync(join(dir, "run_corrupt.jsonl"),
      JSON.stringify({ runId: "run_corrupt", agentId: "coder_low", type: "run.started" }) + "\n{not json\n", "utf8");
    const out = await captureLog(() => runsCommand(["wait", "run_corrupt", "--format", "json"], { runDir: dir }));
    const parsed = JSON.parse(out);
    assert.equal(parsed.observationOutcome, "read_failure");
    assert.equal(parsed.readFailureReason, "transcript_parse_failed");
    assert.equal(parsed.terminal, false);
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// RED-5: unknown non-empty subcommand fails closed; bare `runs` (and the
// legacy flags-only / `runs list` forms) keep listing.
// =====================================================================

test("TD-109-W5: unknown runs subcommand fails closed listing valid subcommands; bare runs still lists", async () => {
  const dir = makeRunDir();
  try {
    writeFileSync(join(dir, "run_done.jsonl"),
      terminalEvents().map((e) => JSON.stringify({ runId: "run_done", agentId: "coder_low", ...e })).join("\n") + "\n", "utf8");
    // Unknown non-empty subcommand → fixed error naming every valid subcommand (incl. wait).
    await assert.rejects(
      () => runsCommand(["waitx"], { runDir: dir }),
      (err) => {
        assert.match(err.message, /unknown runs subcommand/i);
        for (const valid of ["list", "summary", "prune", "grep", "metrics", "scorecard", "dashboard", "diagnose", "delivery", "wait"]) {
          assert.ok(err.message.includes(valid), `error must list subcommand "${valid}"`);
        }
        return true;
      },
    );
    // Bare `runs` keeps the legacy list fallthrough (backward compat).
    const bare = await captureLog(() => runsCommand([], { runDir: dir }));
    assert.match(bare, /run_done\tcompleted/, "bare runs must still list runs");
    // Explicit `runs list` keeps working after fail-closed dispatch.
    const listed = await captureLog(() => runsCommand(["list"], { runDir: dir }));
    assert.match(listed, /run_done\tcompleted/, "runs list must still list runs");
    // Flags-only `runs` (no subcommand) keeps the legacy fallthrough.
    const flagsOnly = await captureLog(() => runsCommand(["--agent", "coder_low"], { runDir: dir }));
    assert.match(flagsOnly, /run_done\tcompleted/, "flags-only runs must still list runs");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// D1-D3 终审收口（遗漏-1）: SIGINT handler 实测（process.emit 进程内驱动）。
//
// 此前本文件头声称覆盖 "SIGINT handling" 而实际没有对应测试。以下用
// process.emit("SIGINT") 驱动真实 handler（终审验证过该探针模式可行，无需
// 真实信号）：注入挂起的 runWaitFn（返回 pending promise）模拟"阻塞窗口中
// Ctrl-C"，emit 后 handler 必须 await readTranscript 渲染最后快照、再
// process.exit(1)。process.exit 被记录而非真正退出；探针 finally 释放 gate
// 让 runsCommand 走完 finally（注销 listener），供无泄漏断言。
//
// WQ-02 状态覆盖：normal（快照可读 → 真实 state）/ missing（快照读失败 →
// fail-soft "unknown"，catch 分支）/ text 渲染分支。unparseable transcript
// 与 missing 走同一 catch 路径（readTranscript 任何 throw → unknown），不
// 重复设例；"终态 run + 阻塞窗口 emit" 不适用——终态时 service 立即返回，
// 与挂起窗口互斥（handler 的 terminal 投影与 normal 同路径，仅布尔不同）。
// =====================================================================

/**
 * SIGINT 探针：patch console.log/process.exit → 启动 runsCommand（runWaitFn
 * 挂起）→ 在 runWaitFn 被调时（此刻 handler 已注册）emit SIGINT → 轮询等
 * handler 调用 process.exit → probe({lines, exitArg}) 做断言。finally 恢复
 * patch 并释放 gate（service 以错误 settle → runsCommand 的 finally 注销
// handler），probe 返回后调用方可断言 listenerCount 回基线。
 */
async function withSigintProbe({ runArgs, config, onService }, probe) {
  const lines = [];
  const origLog = console.log;
  const origExit = process.exit;
  let exitArg = "NOT_CALLED";
  let releaseGate;
  const gate = new Promise((_resolve, reject) => { releaseGate = reject; });
  console.log = (...a) => { lines.push(a.map(String).join("\t")); };
  process.exit = (code) => { exitArg = code; };
  let waitPromise;
  try {
    waitPromise = runsCommand(runArgs, config, {
      runWaitFn: onService
        ? (input) => onService(input, gate)
        : () => { process.emit("SIGINT"); return gate; },
    });
    // handler 是 async IIFE：readTranscript 至少一个微任务后才打印/退出。
    const deadline = Date.now() + 5000;
    while (exitArg === "NOT_CALLED" && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    await probe({ lines, exitArg });
  } finally {
    console.log = origLog;
    process.exit = origExit;
    releaseGate(new Error("sigint-probe-teardown"));
    if (waitPromise) await waitPromise.catch(() => {});
  }
}

test("D1-D3-SIGINT: 阻塞窗口中 SIGINT → JSON 快照含 interrupted:true，process.exit(1)，listener 注销", async () => {
  const dir = makeRunDir();
  try {
    await writeJsonl(dir, "run_active", runningEvents());
    const sigintBase = process.listenerCount("SIGINT");
    await withSigintProbe(
      {
        runArgs: ["wait", "run_active", "--format", "json"],
        config: { runDir: dir },
        // runWaitFn 被调时 process.on("SIGINT") 已注册（先于 await service）。
        onService: (_input, gate) => {
          assert.equal(process.listenerCount("SIGINT"), sigintBase + 1,
            "阻塞窗口（await service）期间 SIGINT handler 必须已注册");
          process.emit("SIGINT");
          return gate;
        },
      },
      ({ lines, exitArg }) => {
        assert.notEqual(exitArg, "NOT_CALLED", "handler 必须 process.exit(1)");
        assert.equal(exitArg, 1, "中断退出码必须是 1");
        const snap = JSON.parse(lines.join("\n"));
        assert.equal(snap.runId, "run_active");
        assert.equal(snap.state, "running", "快照是阻塞时刻的最后已知状态");
        assert.equal(snap.terminal, false);
        assert.equal(snap.interrupted, true, "JSON 模式中断快照必须携带 interrupted:true");
      },
    );
    assert.equal(process.listenerCount("SIGINT"), sigintBase,
      "runsCommand 走完 finally 后必须注销 SIGINT handler（无监听器泄漏）");
  } finally {
    cleanupDir(dir);
  }
});

test("D1-D3-SIGINT: 快照读失败（transcript 缺失）→ fail-soft state unknown，仍打印快照并 exit(1)", async () => {
  const dir = makeRunDir();
  try {
    // 不写 transcript：handler 内 readTranscript throw → catch → unknown 快照。
    await withSigintProbe(
      { runArgs: ["wait", "run_missing", "--format", "json"], config: { runDir: dir } },
      ({ lines, exitArg }) => {
        assert.equal(exitArg, 1, "读失败也必须 exit(1)（中断意图不受影响）");
        const snap = JSON.parse(lines.join("\n"));
        assert.equal(snap.runId, "run_missing");
        assert.equal(snap.state, "unknown", "读失败降级为 unknown，而不是崩掉中断路径");
        assert.equal(snap.terminal, false);
        assert.equal(snap.interrupted, true);
      },
    );
  } finally {
    cleanupDir(dir);
  }
});

test("D1-D3-SIGINT: text 模式中断 → Run/Terminal/固定中断说明三行快照", async () => {
  const dir = makeRunDir();
  try {
    await writeJsonl(dir, "run_active", runningEvents());
    await withSigintProbe(
      { runArgs: ["wait", "run_active"], config: { runDir: dir } },
      ({ lines, exitArg }) => {
        assert.equal(exitArg, 1, "text 模式中断同样 exit(1)");
        assert.equal(lines.length, 3, "text 模式中断快照恰好三行");
        assert.equal(lines[0], "Run: run_active (running)");
        assert.equal(lines[1], "Terminal: no");
        assert.equal(lines[2], "(interrupted before the observation window completed)");
      },
    );
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// TD-114 closeout (B): window-expiry exit code assertions.
//
// 进程级"窗口到期 exit 0"被 RUN_WAIT_MIN_MS=180000（src/application/runWait.js）
// 确定性排除：3 分钟真实等待违反套件纪律，假时钟无法跨进程注入。TD-114 原文
// 授权进程内替代——B-1（进程内退出码未设置）+ B-2（进程级终态 exit 0，与到期
// 路径共享同一 return/print 代码路径）组合覆盖。
// =====================================================================

test("TD-114-B1-json: 窗口到期结果打印且 process.exitCode 不变（进程内）", async () => {
  const dir = makeRunDir();
  const prev = process.exitCode;
  try {
    await writeJsonl(dir, "run_active", runningEvents());
    const out = await captureLog(() => runsCommand(
      ["wait", "run_active", "--wait-ms", "180001", "--format", "json", "--run-dir", dir],
      { runDir: dir },
      {
        runWaitFn: (input) => runWait({
          ...input,
          sleepFn: () => Promise.resolve(),
          nowFn: fakeClock(),
        }),
      },
    ));
    const parsed = JSON.parse(out);
    assert.equal(parsed.terminal, false, "窗口到期必须报 terminal:false");
    assert.equal(parsed.returnedEarly, false, "窗口到期必须报 returnedEarly:false");
    assert.equal(parsed.observation.outcome, "window_expired", "observation.outcome 必须是 window_expired");
    assert.ok(
      SERVICE_OBSERVATION_OUTCOMES.includes(parsed.observationOutcome),
      `observationOutcome must be in ${SERVICE_OBSERVATION_OUTCOMES.join("|")}, got: ${parsed.observationOutcome}`,
    );
    assert.equal(process.exitCode, prev, "窗口到期（正常结果）不得设置非零退出码");
  } finally {
    process.exitCode = prev;
    cleanupDir(dir);
  }
});

test("TD-114-B1-text: 窗口到期打印五行结构且 process.exitCode 不变（进程内）", async () => {
  const dir = makeRunDir();
  const prev = process.exitCode;
  try {
    await writeJsonl(dir, "run_active", runningEvents());
    const out = await captureLog(() => runsCommand(
      ["wait", "run_active", "--wait-ms", "180001", "--run-dir", dir],
      { runDir: dir },
      {
        runWaitFn: (input) => runWait({
          ...input,
          sleepFn: () => Promise.resolve(),
          nowFn: fakeClock(),
        }),
      },
    ));
    const lines = out.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 5, `text 输出恰好五行，实际 ${lines.length} 行: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /^Run: run_active \(running\)$/, "第 1 行：Run: <runId> (<state>)");
    assert.equal(lines[1], "Terminal: no", "第 2 行：Terminal: no（窗口到期）");
    assert.match(lines[2], /^Waited: \d+ ms \(window \d+ ms\)$/, "第 3 行：Waited: <ms> ms (window <ms> ms)");
    assert.match(lines[3], /^Liveness: \S+$/, "第 4 行：Liveness: <非空标签>");
    assert.match(lines[4], /^Observation: \S+( \(\S+\))?$/, "第 5 行：Observation: <outcome>[ (<observation.outcome>)]");
    assert.equal(process.exitCode, prev, "窗口到期（正常结果）不得设置非零退出码");
  } finally {
    process.exitCode = prev;
    cleanupDir(dir);
  }
});

test("TD-114-B2: 子进程终态路径 exit 0 且 stdout 含 'Terminal: yes'", () => {
  const dir = makeRunDir();
  try {
    writeFileSync(join(dir, "run_term.jsonl"),
      terminalEvents().map((e) => JSON.stringify({ runId: "run_term", agentId: "coder_low", ...e })).join("\n") + "\n", "utf8");
    const r = spawnSync(
      process.execPath,
      ["src/cli.js", "runs", "wait", "run_term", "--run-dir", dir],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 30000,
        env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" },
      },
    );
    assert.equal(r.status, 0, `终态 run 必须 exit 0（stderr=${r.stderr}）`);
    assert.match(r.stdout, /Terminal: yes/, "stdout 必须打印终态事实");
  } finally {
    cleanupDir(dir);
  }
});
