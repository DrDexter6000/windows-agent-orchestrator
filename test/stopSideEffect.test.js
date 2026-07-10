// TD-100：stop 副作用所有权与真实验证。
//
// 核心不变量：先 claim 终态（transitionState），只有 accepted winner 才执行
// 破坏性副作用（taskkill / backend.abort）。rejected loser 零副作用。
//
// 所有进程行为通过依赖注入 mock，不使用真实 PID，不依赖 sleep。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { JsonlTranscript, readTranscript, findState, findLatest } from "../src/transcript.js";
import { diagnoseFailure } from "../src/diagnosis.js";

async function makeDir() {
  return mkdtemp(join(tmpdir(), "wao-td100-"));
}

/** 构造一个 running 状态的 process-backed transcript。 */
async function seedRunningTranscript(dir, runId = "run_td100", pid = 99999) {
  const tp = join(dir, `${runId}.jsonl`);
  const t = new JsonlTranscript(tp, { runId, agentId: "td100_agent" });
  await t.append("run.started", { backend: "claude-code" });
  await t.append("session.created", { backend: "process", backendSessionId: `proc_${pid}` });
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "submitted", "spawned");
  await t.transitionState("submitted", "running", "first_event");
  return tp;
}

/** 构造一个已 completed 的 transcript（用于 rejected 测试）。 */
async function seedCompletedTranscript(dir, runId = "run_td100_done", pid = 88888) {
  const tp = join(dir, `${runId}.jsonl`);
  const t = new JsonlTranscript(tp, { runId, agentId: "td100_agent" });
  await t.append("run.started", { backend: "claude-code" });
  await t.append("session.created", { backend: "process", backendSessionId: `proc_${pid}` });
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "submitted", "spawned");
  await t.transitionState("submitted", "running", "first_event");
  await t.append("run.completed", { backendSessionId: `proc_${pid}` });
  await t.transitionState("running", "completed", "done");
  return tp;
}

/** 捕获 console.log 输出。 */
async function captureLog(fn) {
  const orig = console.log;
  let out = "";
  console.log = (s) => { out += s + "\n"; };
  try { await fn(); } finally { console.log = orig; }
  return out;
}

// --- 默认 deps mock（测试覆盖注入） ---

function defaultKillMocks(overrides = {}) {
  return {
    kill: overrides.kill ?? (() => ({ called: true, exitCode: 0 })),
    isAlive: overrides.isAlive ?? (() => false),
    executeStop: overrides.executeStop ?? (async () => ({ verified: true, abortCalled: true, taskkillCalled: false })),
    alert: overrides.alert ?? (async () => {}),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. completed run → rejected，taskkill 调用次数=0
// ---------------------------------------------------------------------------
test("TD-100.1: completed run stop → rejected, taskkill 调用次数=0", async () => {
  const dir = await makeDir();
  try {
    await seedCompletedTranscript(dir);
    let killCalls = 0;
    const { stopCommand } = await import("../src/commands/stop.js");
    const out = await captureLog(async () => {
      await stopCommand(["run_td100_done", "--run-dir", dir], { runDir: dir }, {
        kill: () => { killCalls++; return { called: true, exitCode: 0 }; },
        isAlive: () => false,
        alert: async () => {},
      });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.terminalAccepted, false);
    assert.equal(killCalls, 0, "rejected 不执行 taskkill");
    assert.equal(parsed.sideEffectAttempted, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. 两个并发 process stop → 只有 winner 调 taskkill
// ---------------------------------------------------------------------------
test("TD-100.2: 两个并发 process stop → 只有 winner 调 taskkill", async () => {
  const dir = await makeDir();
  try {
    await seedRunningTranscript(dir);
    let killCalls = 0;
    const { stopCommand } = await import("../src/commands/stop.js");
    const deps = {
      kill: () => { killCalls++; return { called: true, exitCode: 0 }; },
      isAlive: () => true,  // aliveBefore=true → winner 会调 kill；loser 在 claim 阶段就返回了
      waitForExit: async () => true,  // 注入：仍活（轮询不真实等待）
      alert: async () => {},
    };
    // 不用 captureLog（并发时 console.log 会互相覆盖）。直接跑，靠 transcript + killCalls 断言。
    // suppress console.log during concurrent stop
    const origLog = console.log;
    console.log = () => {};
    try {
      await Promise.all([
        stopCommand(["run_td100", "--run-dir", dir], { runDir: dir }, deps),
        stopCommand(["run_td100", "--run-dir", dir], { runDir: dir }, deps),
      ]);
    } finally {
      console.log = origLog;
    }
    // 恰好一个 accepted（transcript 只有一条 terminal state_change）
    const events = await readTranscript(join(dir, "run_td100.jsonl"));
    const terminalChanges = events.filter((e) => e.type === "run.state_change" && ["aborted", "failed", "completed", "timed_out"].includes(e.to));
    assert.equal(terminalChanges.length, 1, "恰好一条 terminal state_change");
    // 只有 winner 调 taskkill
    assert.equal(killCalls, 1, "只有 winner 调 taskkill");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. rejected 输出 stopped=false, sideEffectAttempted=false
// ---------------------------------------------------------------------------
test("TD-100.3: rejected → stopped=false, sideEffectAttempted=false", async () => {
  const dir = await makeDir();
  try {
    await seedCompletedTranscript(dir);
    const { stopCommand } = await import("../src/commands/stop.js");
    const out = await captureLog(async () => {
      await stopCommand(["run_td100_done", "--run-dir", dir], { runDir: dir }, {
        kill: () => ({ called: true, exitCode: 0 }),
        isAlive: () => false,
        alert: async () => {},
      });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.stopped, false);
    assert.equal(parsed.sideEffectAttempted, false);
    assert.equal(parsed.terminalAccepted, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. taskkill exit=0 但 PID 仍活 → stop_unverified + alert + stopped=false
// ---------------------------------------------------------------------------
test("TD-100.4: taskkill exit=0 但 PID 仍活 → stop_unverified + alert + stopped=false", async () => {
  const dir = await makeDir();
  try {
    await seedRunningTranscript(dir);
    let alertCalled = false;
    const { stopCommand } = await import("../src/commands/stop.js");
    const out = await captureLog(async () => {
      await stopCommand(["run_td100", "--run-dir", dir], { runDir: dir }, {
        kill: () => ({ called: true, exitCode: 0 }),
        isAlive: () => true,  // PID 仍活
        waitForExit: async () => true,  // 注入：轮询后仍活（不真实等待）
        alert: async () => { alertCalled = true; },
      });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.stopped, false, "PID 仍活 → stopped=false");
    assert.equal(parsed.verified, false);
    assert.equal(parsed.outcome, "still_running");
    assert.ok(alertCalled, "unverified 必须 raiseAlert");

    const events = await readTranscript(join(dir, "run_td100.jsonl"));
    const unverified = events.find((e) => e.type === "run.stop_unverified");
    assert.ok(unverified, "transcript 含 run.stop_unverified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. PID 调用前已退出 → 不调 taskkill, stop_verified, outcome=already_exited
// ---------------------------------------------------------------------------
test("TD-100.5: PID 调用前已退出 → 不调 taskkill, outcome=already_exited", async () => {
  const dir = await makeDir();
  try {
    await seedRunningTranscript(dir);
    let killCalls = 0;
    const { stopCommand } = await import("../src/commands/stop.js");
    const out = await captureLog(async () => {
      await stopCommand(["run_td100", "--run-dir", dir], { runDir: dir }, {
        kill: () => { killCalls++; return { called: true, exitCode: 0 }; },
        isAlive: () => false,  // 调用前已死
        alert: async () => {},
      });
    });
    const parsed = JSON.parse(out);
    assert.equal(killCalls, 0, "PID 已死 → 不调 taskkill");
    assert.equal(parsed.outcome, "already_exited");
    assert.equal(parsed.verified, true, "进程已死 = verified");
    assert.equal(parsed.stopped, true);

    const events = await readTranscript(join(dir, "run_td100.jsonl"));
    assert.ok(events.find((e) => e.type === "run.stop_verified"), "含 stop_verified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. taskkill 非零但 PID 最终已死 → verified=true，但 outcome≠killed
// ---------------------------------------------------------------------------
test("TD-100.6: taskkill 非零但 PID 最终已死 → verified=true, outcome=already_exited", async () => {
  const dir = await makeDir();
  try {
    await seedRunningTranscript(dir);
    let killCalls = 0;
    let killExitCode = 0;
    const { stopCommand } = await import("../src/commands/stop.js");
    // isAlive：第一次（aliveBefore）true → 触发 taskkill；轮询后 false → PID 最终已死。
    let aliveCallCount = 0;
    const aliveSeq = [true, false];
    const out = await captureLog(async () => {
      await stopCommand(["run_td100", "--run-dir", dir], { runDir: dir }, {
        kill: () => { killCalls++; killExitCode = 128; return { called: true, exitCode: 128 }; },
        isAlive: () => aliveSeq[aliveCallCount++] ?? false,
        waitForExit: async (p, ia) => ia(p),  // 注入：直接调 isAlive（不真实等待）
        alert: async () => {},
      });
    });
    const parsed = JSON.parse(out);
    assert.equal(killCalls, 1, "taskkill 调用一次");
    assert.equal(parsed.taskkillExitCode, 128, "taskkill exitCode=128");
    assert.equal(parsed.verified, true, "PID 最终已死 → verified=true");
    assert.equal(parsed.outcome, "already_exited", "taskkill 非零但 PID 死了 → already_exited");
    assert.notEqual(parsed.outcome, "killed", "taskkill 非零 → 不宣称 killed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. taskkill 后 PID 已死 → outcome=killed + stop_verified
// ---------------------------------------------------------------------------
test("TD-100.7: taskkill 后 PID 已死 → outcome=killed + stop_verified", async () => {
  const dir = await makeDir();
  try {
    await seedRunningTranscript(dir);
    const { stopCommand } = await import("../src/commands/stop.js");
    // isAlive: 第一次调用（aliveBefore）返回 true，第二次（aliveAfter）返回 false。
    let aliveCallCount = 0;
    const out = await captureLog(async () => {
      await stopCommand(["run_td100", "--run-dir", dir], { runDir: dir }, {
        kill: () => ({ called: true, exitCode: 0 }),
        isAlive: () => { aliveCallCount++; return aliveCallCount === 1; },
        waitForExit: async (p, ia) => ia(p),  // 注入：直接调 isAlive（不真实等待）
        alert: async () => {},
      });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.outcome, "killed");
    assert.equal(parsed.verified, true);
    assert.equal(parsed.stopped, true);

    const events = await readTranscript(join(dir, "run_td100.jsonl"));
    assert.ok(events.find((e) => e.type === "run.stop_verified"), "含 stop_verified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. opencode loser 不调用 backend.abort/executeStopWithVerification
// ---------------------------------------------------------------------------
test("TD-100.8: opencode loser 不调用 executeStopWithVerification", async () => {
  const dir = await makeDir();
  try {
    // 构造一个 opencode (有 serveUrl) 且已 completed 的 transcript
    const tp = join(dir, "run_opencode_done.jsonl");
    const t = new JsonlTranscript(tp, { runId: "run_opencode_done", agentId: "agent" });
    await t.append("run.started", { backend: "opencode-serve" });
    await t.append("session.created", { backend: "opencode-serve", backendSessionId: "ses_done", serveUrl: "http://localhost:1" });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "submitted", "spawned");
    await t.transitionState("submitted", "running", "first_event");
    await t.append("run.completed", { backendSessionId: "ses_done" });
    await t.transitionState("running", "completed", "done");

    let execStopCalls = 0;
    const { stopCommand } = await import("../src/commands/stop.js");
    const out = await captureLog(async () => {
      await stopCommand(["run_opencode_done", "--run-dir", dir], { runDir: dir }, {
        executeStop: async () => { execStopCalls++; return { verified: true, abortCalled: true, taskkillCalled: false }; },
        alert: async () => {},
      });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.terminalAccepted, false);
    assert.equal(execStopCalls, 0, "opencode loser 不调 executeStopWithVerification");
    assert.equal(parsed.sideEffectAttempted, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. opencode winner verified/unverified 两路径保持同一事件语义
// ---------------------------------------------------------------------------
test("TD-100.9a: opencode winner verified → stop_verified + stopped=true", async () => {
  const dir = await makeDir();
  try {
    const tp = join(dir, "run_oc_v.jsonl");
    const t = new JsonlTranscript(tp, { runId: "run_oc_v", agentId: "agent" });
    await t.append("run.started", { backend: "opencode-serve" });
    await t.append("session.created", { backend: "opencode-serve", backendSessionId: "ses_v", serveUrl: "http://localhost:2" });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "submitted", "spawned");
    await t.transitionState("submitted", "running", "first_event");

    const { stopCommand } = await import("../src/commands/stop.js");
    const out = await captureLog(async () => {
      await stopCommand(["run_oc_v", "--run-dir", dir], { runDir: dir }, {
        executeStop: async () => ({ verified: true, abortCalled: true, taskkillCalled: false }),
        alert: async () => {},
      });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.terminalAccepted, true);
    assert.equal(parsed.stopped, true);
    assert.equal(parsed.verified, true);

    const events = await readTranscript(tp);
    assert.ok(events.find((e) => e.type === "run.stop_verified"), "含 stop_verified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-100.9b: opencode winner unverified → stop_unverified + alert + stopped=false", async () => {
  const dir = await makeDir();
  try {
    const tp = join(dir, "run_oc_uv.jsonl");
    const t = new JsonlTranscript(tp, { runId: "run_oc_uv", agentId: "agent" });
    await t.append("run.started", { backend: "opencode-serve" });
    await t.append("session.created", { backend: "opencode-serve", backendSessionId: "ses_uv", serveUrl: "http://localhost:3" });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "submitted", "spawned");
    await t.transitionState("submitted", "running", "first_event");

    let alertCalled = false;
    const { stopCommand } = await import("../src/commands/stop.js");
    const out = await captureLog(async () => {
      await stopCommand(["run_oc_uv", "--run-dir", dir], { runDir: dir }, {
        executeStop: async () => ({ verified: false, abortCalled: true, taskkillCalled: true }),
        alert: async () => { alertCalled = true; },
      });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.terminalAccepted, true);
    assert.equal(parsed.stopped, false, "unverified → stopped=false");
    assert.equal(parsed.verified, false);
    assert.ok(alertCalled, "unverified → raiseAlert");

    const events = await readTranscript(tp);
    assert.ok(events.find((e) => e.type === "run.stop_unverified"), "含 stop_unverified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10. rejected 不写 stop_verified/stop_unverified
// ---------------------------------------------------------------------------
test("TD-100.10: rejected 不写 stop_verified/stop_unverified", async () => {
  const dir = await makeDir();
  try {
    await seedCompletedTranscript(dir);
    const { stopCommand } = await import("../src/commands/stop.js");
    await captureLog(async () => {
      await stopCommand(["run_td100_done", "--run-dir", dir], { runDir: dir }, {
        kill: () => ({ called: true, exitCode: 0 }),
        isAlive: () => false,
        alert: async () => {},
      });
    });
    const events = await readTranscript(join(dir, "run_td100_done.jsonl"));
    assert.equal(events.find((e) => e.type === "run.stop_verified"), undefined, "rejected 不写 stop_verified");
    assert.equal(events.find((e) => e.type === "run.stop_unverified"), undefined, "rejected 不写 stop_unverified");
    // 但应写 state_change_rejected
    assert.ok(events.find((e) => e.type === "run.state_change_rejected"), "含 state_change_rejected");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 11. run.stop_requested 含 reason=user，diagnosis 不再显示 unknown
// ---------------------------------------------------------------------------
test("TD-100.11: stop_requested 含 reason=user, diagnosis 不显示 unknown", async () => {
  const dir = await makeDir();
  try {
    await seedRunningTranscript(dir);
    const { stopCommand } = await import("../src/commands/stop.js");
    await captureLog(async () => {
      await stopCommand(["run_td100", "--run-dir", dir], { runDir: dir }, {
        kill: () => ({ called: true, exitCode: 0 }),
        isAlive: () => false,
        alert: async () => {},
      });
    });
    const events = await readTranscript(join(dir, "run_td100.jsonl"));
    const sr = events.find((e) => e.type === "run.stop_requested");
    assert.ok(sr, "含 stop_requested");
    assert.equal(sr.reason, "user", "reason=user");

    const d = diagnoseFailure(events);
    assert.equal(d.category, "aborted_manual");
    assert.ok(!d.evidence[0].fact.includes("unknown"), "diagnosis fact 不含 unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 12. run.aborted 与 aborted state_change 同批、seq 连续
// ---------------------------------------------------------------------------
test("TD-100.12: run.aborted 与 aborted state_change seq 连续", async () => {
  const dir = await makeDir();
  try {
    await seedRunningTranscript(dir);
    const { stopCommand } = await import("../src/commands/stop.js");
    await captureLog(async () => {
      await stopCommand(["run_td100", "--run-dir", dir], { runDir: dir }, {
        kill: () => ({ called: true, exitCode: 0 }),
        isAlive: () => false,
        alert: async () => {},
      });
    });
    const events = await readTranscript(join(dir, "run_td100.jsonl"));
    const abortedFact = events.find((e) => e.type === "run.aborted");
    const abortedChange = events.find((e) => e.type === "run.state_change" && e.to === "aborted");
    assert.ok(abortedFact, "含 run.aborted");
    assert.ok(abortedChange, "含 aborted state_change");
    assert.equal(abortedChange.seq - abortedFact.seq, 1, "seq 连续 (diff=1)");
    assert.equal(abortedFact.verification, "pending", "verification=pending");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TD-100 收尾：PID liveness 契约（ESRCH/EPERM/unknown）+ 有界轮询 + attemptEvents 事件顺序
// ---------------------------------------------------------------------------

test("TD-100.13: isPidAlive — ESRCH → false（死）", async () => {
  const { isPidAlive } = await import("../src/commands/stop.js");
  const probe = () => { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; };
  assert.equal(isPidAlive(99999, probe), false, "ESRCH → false");
});

test("TD-100.14: isPidAlive — EPERM → true（保守 alive，不得假验证）", async () => {
  const { isPidAlive } = await import("../src/commands/stop.js");
  const probe = () => { const e = new Error("EPERM"); e.code = "EPERM"; throw e; };
  assert.equal(isPidAlive(99999, probe), true, "EPERM → true");
});

test("TD-100.15: isPidAlive — 未知错误 → true（保守 alive）", async () => {
  const { isPidAlive } = await import("../src/commands/stop.js");
  const probe = () => { throw new Error("something weird"); };
  assert.equal(isPidAlive(99999, probe), true, "未知错误 → true");
});

test("TD-100.16: taskkill 后有界轮询 true,true,false → verified=true, outcome=killed", async () => {
  const dir = await makeDir();
  try {
    await seedRunningTranscript(dir);
    const { stopCommand } = await import("../src/commands/stop.js");
    // isAlive 序列：aliveBefore=true, 轮询第一次=true, 轮询第二次=false → 有界轮询后死。
    let aliveCallCount = 0;
    const aliveSeq = [true, true, false];
    const out = await captureLog(async () => {
      await stopCommand(["run_td100", "--run-dir", dir], { runDir: dir }, {
        kill: () => ({ called: true, exitCode: 0 }),
        isAlive: () => aliveSeq[aliveCallCount++] ?? false,
        sleep: async () => {},  // 注入 no-op sleep，测试不真实等待
        pollConfig: { rounds: 5, intervalMs: 1 },
        alert: async () => {},
      });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.verified, true, "轮询后 PID 死了 → verified=true");
    assert.equal(parsed.outcome, "killed", "taskkill 杀死的 → outcome=killed");
    assert.equal(parsed.processAliveAfter, false, "processAliveAfter=false");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-100.17: 轮询耗尽仍 alive → unverified + alert + stopped=false", async () => {
  const dir = await makeDir();
  try {
    await seedRunningTranscript(dir);
    let alertCalled = false;
    const { stopCommand } = await import("../src/commands/stop.js");
    const out = await captureLog(async () => {
      await stopCommand(["run_td100", "--run-dir", dir], { runDir: dir }, {
        kill: () => ({ called: true, exitCode: 0 }),
        isAlive: () => true,  // 永远 alive → 轮询耗尽
        sleep: async () => {},
        pollConfig: { rounds: 3, intervalMs: 1 },
        alert: async () => { alertCalled = true; },
      });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.verified, false, "轮询耗尽仍 alive → unverified");
    assert.equal(parsed.outcome, "still_running");
    assert.equal(parsed.stopped, false);
    assert.ok(alertCalled, "轮询耗尽 → raiseAlert");

    const events = await readTranscript(join(dir, "run_td100.jsonl"));
    const unverified = events.find((e) => e.type === "run.stop_unverified");
    assert.ok(unverified, "含 stop_unverified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-100.18: stop_verified 写 outcome/taskkillCalled/taskkillExitCode/processAliveBefore/processAliveAfter", async () => {
  const dir = await makeDir();
  try {
    await seedRunningTranscript(dir);
    const { stopCommand } = await import("../src/commands/stop.js");
    let aliveCallCount = 0;
    const aliveSeq = [true, false]; // aliveBefore=true, 轮询后=false
    await captureLog(async () => {
      await stopCommand(["run_td100", "--run-dir", dir], { runDir: dir }, {
        kill: () => ({ called: true, exitCode: 0 }),
        isAlive: () => aliveSeq[aliveCallCount++] ?? false,
        sleep: async () => {},
        pollConfig: { rounds: 3, intervalMs: 1 },
        alert: async () => {},
      });
    });
    const events = await readTranscript(join(dir, "run_td100.jsonl"));
    const verified = events.find((e) => e.type === "run.stop_verified");
    assert.ok(verified, "含 stop_verified");
    assert.equal(verified.outcome, "killed");
    assert.equal(verified.taskkillCalled, true);
    assert.equal(verified.taskkillExitCode, 0);
    assert.equal(verified.processAliveBefore, true);
    assert.equal(verified.processAliveAfter, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-100.19: stop winner 事件顺序 stop_requested → run.aborted → state_change(aborted)", async () => {
  const dir = await makeDir();
  try {
    await seedRunningTranscript(dir);
    const { stopCommand } = await import("../src/commands/stop.js");
    await captureLog(async () => {
      await stopCommand(["run_td100", "--run-dir", dir], { runDir: dir }, {
        kill: () => ({ called: true, exitCode: 0 }),
        isAlive: () => false,
        alert: async () => {},
      });
    });
    const events = await readTranscript(join(dir, "run_td100.jsonl"));
    // 不再有 claim 前单独的 stop_requested append——stop_requested 应在 run.aborted 之前（同批）
    const types = events.map((e) => e.type);
    const stopReqIdx = types.indexOf("run.stop_requested");
    const abortedFactIdx = types.indexOf("run.aborted");
    const stateChangeIdx = types.findIndex((e) => events[types.indexOf(e)]?.type === "run.state_change" && events[types.indexOf(e)]?.to === "aborted");
    // 修正：直接用 findIndex
    const scIdx = events.findIndex((e) => e.type === "run.state_change" && e.to === "aborted");
    assert.ok(stopReqIdx >= 0, "含 stop_requested");
    assert.ok(abortedFactIdx >= 0, "含 run.aborted");
    assert.ok(scIdx >= 0, "含 aborted state_change");
    assert.ok(stopReqIdx < abortedFactIdx, "stop_requested 在 run.aborted 之前");
    assert.ok(abortedFactIdx < scIdx, "run.aborted 在 state_change 之前");
    // 三个事件 seq 连续
    const sr = events[stopReqIdx];
    const af = events[abortedFactIdx];
    const sc = events[scIdx];
    assert.equal(af.seq - sr.seq, 1, "stop_requested → run.aborted seq 连续");
    assert.equal(sc.seq - af.seq, 1, "run.aborted → state_change seq 连续");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-100.20: stop loser 事件顺序 stop_requested → state_change_rejected（无 run.aborted）", async () => {
  const dir = await makeDir();
  try {
    await seedCompletedTranscript(dir);
    const { stopCommand } = await import("../src/commands/stop.js");
    await captureLog(async () => {
      await stopCommand(["run_td100_done", "--run-dir", dir], { runDir: dir }, {
        kill: () => ({ called: true, exitCode: 0 }),
        isAlive: () => false,
        alert: async () => {},
      });
    });
    const events = await readTranscript(join(dir, "run_td100_done.jsonl"));
    const types = events.map((e) => e.type);
    const stopReqIdx = types.lastIndexOf("run.stop_requested"); // 最新的那个
    const rejectedIdx = types.lastIndexOf("run.state_change_rejected");
    assert.ok(stopReqIdx >= 0, "loser 含 stop_requested（attemptEvents）");
    assert.ok(rejectedIdx >= 0, "loser 含 state_change_rejected");
    assert.ok(stopReqIdx < rejectedIdx, "stop_requested 在 rejected 之前");
    // loser 不写 run.aborted
    const abortedFacts = events.filter((e) => e.type === "run.aborted");
    // 已 completed 的 seed 没有 run.aborted，loser 也不写 → 0
    assert.equal(abortedFacts.length, 0, "loser 不写 run.aborted");
    // seq 连续
    const sr = events[stopReqIdx];
    const rj = events[rejectedIdx];
    assert.equal(rj.seq - sr.seq, 1, "stop_requested → rejected seq 连续");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-100.21: opencode stop_verified 写 backend/method/taskkillCalled", async () => {
  const dir = await makeDir();
  try {
    const tp = join(dir, "run_oc_v2.jsonl");
    const t = new JsonlTranscript(tp, { runId: "run_oc_v2", agentId: "agent" });
    await t.append("run.started", { backend: "opencode-serve" });
    await t.append("session.created", { backend: "opencode-serve", backendSessionId: "ses_v2", serveUrl: "http://localhost:9" });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "submitted", "spawned");
    await t.transitionState("submitted", "running", "first_event");

    const { stopCommand } = await import("../src/commands/stop.js");
    await captureLog(async () => {
      await stopCommand(["run_oc_v2", "--run-dir", dir], { runDir: dir }, {
        executeStop: async () => ({ verified: true, abortCalled: true, taskkillCalled: false, backend: "opencode-serve", method: "abort+verify" }),
        alert: async () => {},
      });
    });
    const events = await readTranscript(tp);
    const verified = events.find((e) => e.type === "run.stop_verified");
    assert.ok(verified, "含 stop_verified");
    assert.equal(verified.backend, "opencode-serve");
    assert.equal(verified.method, "abort+verify");
    assert.equal(verified.taskkillCalled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TD-100 最终边界：invalid process session PID 不 claim 终态
// ---------------------------------------------------------------------------

/** 构造一个 running 状态的 process-backed transcript，可指定 backendSessionId。 */
async function seedRunningTranscriptCustomSid(dir, runId, sid) {
  const tp = join(dir, `${runId}.jsonl`);
  const t = new JsonlTranscript(tp, { runId, agentId: "td100_agent" });
  await t.append("run.started", { backend: "claude-code" });
  await t.append("session.created", { backend: "process", backendSessionId: sid });
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "submitted", "spawned");
  await t.transitionState("submitted", "running", "first_event");
  return tp;
}

test("TD-100.22: invalid PID (proc_not-a-number) → stopped=false, outcome=invalid_pid, 不 claim", async () => {
  const dir = await makeDir();
  try {
    await seedRunningTranscriptCustomSid(dir, "run_invalid", "proc_not-a-number");
    let killCalls = 0;
    let alertMsg = null;
    const { stopCommand } = await import("../src/commands/stop.js");
    const out = await captureLog(async () => {
      await stopCommand(["run_invalid", "--run-dir", dir], { runDir: dir }, {
        kill: () => { killCalls++; return { called: true, exitCode: 0 }; },
        isAlive: () => false,
        alert: async (level, msg) => { alertMsg = msg; },
      });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.stopped, false);
    assert.equal(parsed.verified, false);
    assert.equal(parsed.outcome, "invalid_pid");
    assert.equal(parsed.sideEffectAttempted, false);
    assert.equal(parsed.terminalAccepted, false);
    assert.equal(parsed.terminalState, "running", "terminalState 保持原状态");
    assert.equal(parsed.taskkillCalled, false);
    assert.equal(killCalls, 0, "不调 taskkill");

    const events = await readTranscript(join(dir, "run_invalid.jsonl"));
    // 写 stop_requested {reason:"user"}
    const sr = events.find((e) => e.type === "run.stop_requested");
    assert.ok(sr, "写 stop_requested");
    assert.equal(sr.reason, "user");
    // 写 stop_unverified {outcome:"invalid_pid"}
    const uv = events.find((e) => e.type === "run.stop_unverified");
    assert.ok(uv, "写 stop_unverified");
    assert.equal(uv.outcome, "invalid_pid");
    // 不得写 run.aborted
    assert.equal(events.find((e) => e.type === "run.aborted"), undefined, "不得写 run.aborted");
    // 不得写 aborted state_change
    assert.equal(events.find((e) => e.type === "run.state_change" && e.to === "aborted"), undefined, "不得写 aborted state_change");
    // alert 指出 invalid PID
    assert.ok(alertMsg && /invalid/i.test(alertMsg), "alert 指出 invalid PID");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-100.23: proc_0 → stopped=false, outcome=invalid_pid, 不 claim", async () => {
  const dir = await makeDir();
  try {
    await seedRunningTranscriptCustomSid(dir, "run_zero", "proc_0");
    let killCalls = 0;
    const { stopCommand } = await import("../src/commands/stop.js");
    const out = await captureLog(async () => {
      await stopCommand(["run_zero", "--run-dir", dir], { runDir: dir }, {
        kill: () => { killCalls++; return { called: true, exitCode: 0 }; },
        isAlive: () => false,
        alert: async () => {},
      });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.outcome, "invalid_pid");
    assert.equal(parsed.terminalAccepted, false);
    assert.equal(parsed.terminalState, "running");
    assert.equal(killCalls, 0);

    const events = await readTranscript(join(dir, "run_zero.jsonl"));
    assert.equal(events.find((e) => e.type === "run.aborted"), undefined, "不得写 run.aborted");
    assert.equal(events.find((e) => e.type === "run.state_change" && e.to === "aborted"), undefined, "不得写 aborted state_change");
    assert.ok(events.find((e) => e.type === "run.stop_unverified" && e.outcome === "invalid_pid"), "写 stop_unverified invalid_pid");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-100.24: proc_-1 → stopped=false, outcome=invalid_pid, 不 claim", async () => {
  const dir = await makeDir();
  try {
    await seedRunningTranscriptCustomSid(dir, "run_neg", "proc_-1");
    let killCalls = 0;
    const { stopCommand } = await import("../src/commands/stop.js");
    const out = await captureLog(async () => {
      await stopCommand(["run_neg", "--run-dir", dir], { runDir: dir }, {
        kill: () => { killCalls++; return { called: true, exitCode: 0 }; },
        isAlive: () => false,
        alert: async () => {},
      });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.outcome, "invalid_pid");
    assert.equal(parsed.terminalAccepted, false);
    assert.equal(killCalls, 0);

    const events = await readTranscript(join(dir, "run_neg.jsonl"));
    assert.equal(events.find((e) => e.type === "run.aborted"), undefined, "不得写 run.aborted");
    assert.equal(events.find((e) => e.type === "run.state_change" && e.to === "aborted"), undefined, "不得写 aborted state_change");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TD-100 确定性 PID 探测：isPidAlive 可注入 probe（.13/.14/.15 已覆盖 ESRCH/EPERM/unknown）
// ---------------------------------------------------------------------------

test("TD-100.25: isPidAlive — probe 不抛 → true（存活）", async () => {
  const { isPidAlive } = await import("../src/commands/stop.js");
  const probe = () => {};  // 不抛 = 存活
  assert.equal(isPidAlive(99999, probe), true, "存活 → true");
});
