// test/runManager.test.js
//
// TD-151（ADR-0030 落地）验收钉：等待窗到期 = 通知，不杀。
//
// 契约（ADR-0030，不可协商）：派发侧等待上限（waitTimeout/--wait-timeout）的到期
// 语义 = 通知，绝不终止 worker。终止只有两个来源：Lead 显式 stop；既有硬安全线
// （tokenBudget、workdir_escape 等）。历史上 waitTimer 到期的 controller.abort() 臂
// （TD-148 实证它在 --background 下同样杀 worker）已废弃。
//
// 本文件钉住根语义的四件事（证伪优先）：
//   1. 到期不杀钉：deadline 后 worker 仍活、abort 未被调、终态自然落盘（completed）。
//   2. 通知事实钉：run.observation_deadline_reached 落盘且载荷有界（恰
//      {waitTimeoutMs, source}）。
//   3. 通知时点钉：onObservationDeadline 在到期时刻同步回调（先于终态）——前台 CLI
//      通知行的时序基础。
//   4. legacy 兼容钉：含 timed_out 终态的旧转录 → findState / diagnoseFailure 行为
//      不变（读取兼容不得回归）。
//
// 前台 CLI 通知行与后台 runner 语义分别在 test/cli.test.js /
// test/isolation-infra/backgroundRunner.test.js 钉。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunManager } from "../../src/runManager.js";
import { JsonlTranscript, readTranscript, findState } from "../../src/transcript.js";
import { diagnoseFailure } from "../../src/diagnosis.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "wao-td151-rm-"));
}

/**
 * 慢 worker 假 backend：立即产出首条 message（进 running），随后跨过 deadline
 * 沉默 firstMessageDelay ms，再自然 done(completed)。记录 abort 调用时刻与
 * worker 存活状态，供"到期不杀"断言。
 */
function createSlowWorkerBackend({ silentMs = 150 } = {}) {
  const state = { abortCalls: 0, alive: true };
  const backend = {
    async spawn() {
      return {
        backend: "process",
        backendSessionId: "proc_td151_slow",
        async *events() {
          yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "slow but alive" }] };
          await sleep(silentMs);
          state.alive = false; // 自然完成，进程退出
          yield { kind: "done", reason: "completed" };
        },
        abort: async () => { state.abortCalls += 1; },
        isAlive: () => state.alive,
      };
    },
  };
  return { backend, state };
}

function createManager(dir, backend, configOverrides = {}) {
  const config = {
    registry: "x", runDir: dir, pollInterval: 5, waitTimeout: 5000,
    timeout: 5000, retries: 0, defaultIsolation: "none",
    ...configOverrides,
  };
  const readRegistry = async () => ({
    getAgent(id) { return { id, backend: "claude-code", cwd: dir }; },
    listAgents() { return []; },
  });
  return new RunManager({ config, readRegistry, transcriptDir: dir, backendFor: () => backend });
}

// ── 钉 1 + 2 + 3：到期不杀 + 事实有界 + 通知时点 ────────────────────────────
test("TD-151: 到期=通知不杀——deadline 后 worker 活着、abort 未调、终态自然 completed", async () => {
  const dir = await makeTempDir();
  try {
    const { backend, state } = createSlowWorkerBackend({ silentMs: 150 });
    const manager = createManager(dir, backend);
    const run = await manager.start("slow", { prompt: "go" });

    const notice = { called: 0, atCall: null };
    const result = await run.waitForCompletion({
      waitTimeout: 40, // deadline 远早于 worker 自然完成（150ms）
      pollInterval: 5,
      onObservationDeadline: (info) => {
        notice.called += 1;
        notice.atCall = {
          ...info,
          abortCallsAtDeadline: state.abortCalls,
          workerAliveAtDeadline: state.alive,
        };
      },
    });

    // 终态是自然的 completed，不是 timed_out，不是 aborted。
    assert.equal(result.completed, true, "到期后应继续等到自然 completed");
    assert.equal(result.timedOut, false, "到期不再产生 timed_out");
    assert.equal(result.aborted, false);
    assert.equal(run.state, "completed");

    // 通知时点钉：到期时刻同步回调（先于终态），此刻 worker 仍活、abort 从未发生。
    assert.equal(notice.called, 1, "onObservationDeadline 恰好回调一次（到期时刻）");
    assert.ok(notice.atCall, "通知回调应携带等待策略信息");
    assert.equal(notice.atCall.waitTimeoutMs, 40);
    assert.equal(notice.atCall.source, "explicit");
    assert.equal(notice.atCall.abortCallsAtDeadline, 0,
      "到期时刻 handle.abort 必须未被调用（通知不杀的铁证）");
    assert.equal(notice.atCall.workerAliveAtDeadline, true,
      "到期时刻 worker 必须仍活（活过 deadline）");

    // 兜底 abort 只发生在自然终态后的清理（会话兜底语义，不是到期杀）。
    assert.equal(state.abortCalls, 1, "自然终态后的清理兜底 abort 恰一次");

    // 通知事实钉：恰一条 run.observation_deadline_reached，载荷有界。
    const events = await readTranscript(run.transcript.filePath);
    const facts = events.filter((e) => e.type === "run.observation_deadline_reached");
    assert.equal(facts.length, 1, "run.observation_deadline_reached 恰一条");
    assert.deepEqual(
      { waitTimeoutMs: facts[0].waitTimeoutMs, source: facts[0].source },
      { waitTimeoutMs: 40, source: "explicit" },
      "载荷恰 {waitTimeoutMs, source}（有界，不回显路径/环境/提示词）",
    );
    const payloadKeys = Object.keys(facts[0]).filter((k) =>
      !["ts", "seq", "runId", "agentId", "type"].includes(k));
    assert.deepEqual(payloadKeys.sort(), ["source", "waitTimeoutMs"],
      "事实 payload 键集有界（闭集）");

    // 无 timed_out 终态/事实。
    assert.equal(events.some((e) => e.type === "run.timed_out"), false,
      "到期不得写 run.timed_out");
    assert.equal(events.some((e) => e.type === "run.state_change" && e.to === "timed_out"), false,
      "到期不得转 timed_out 终态");
    assert.equal(events.some((e) => e.type === "run.aborted"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 到期后 backend 自然 failed：终态真相不被到期污染 ─────────────────────────
test("TD-151: 到期后 backend 自然 failed → 终态如实 failed（不伪造 timed_out）", async () => {
  const dir = await makeTempDir();
  try {
    const backend = {
      async spawn() {
        return {
          backend: "process",
          backendSessionId: "proc_td151_latefail",
          async *events() {
            await sleep(120); // 跨过 deadline（40ms）
            yield { kind: "done", reason: "failed", error: "worker crashed after deadline" };
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    const manager = createManager(dir, backend);
    const run = await manager.start("latefail", { prompt: "go" });
    await assert.rejects(
      () => run.waitForCompletion({ waitTimeout: 40, pollInterval: 5 }),
      /worker crashed after deadline/,
    );
    assert.equal(run.state, "failed", "到期后的 backend 失败保持 failed（TD-105 诚实终态延续）");
    const events = await readTranscript(run.transcript.filePath);
    assert.ok(events.some((e) => e.type === "run.observation_deadline_reached"),
      "到期事实仍应落盘");
    assert.equal(events.some((e) => e.type === "run.timed_out"), false,
      "到期不得把 backend 失败伪造成 timed_out");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 钉 4：legacy timed_out 转录读取兼容（findState / diagnosis 不回归）────────
test("TD-151 legacy 兼容钉: 旧 timed_out 终态转录 → findState/diagnosis 行为不变", async () => {
  const dir = await makeTempDir();
  try {
    const runId = "run_legacy_timed_out";
    const transcript = new JsonlTranscript(join(dir, `${runId}.jsonl`), {
      runId, agentId: "old_worker",
    });
    await transcript.append("run.started", { backend: "claude-code" });
    await transcript.append("session.created", { backendSessionId: "proc_old" });
    await transcript.append("prompt.sent", { prompt: "old task" });
    await transcript.append("run.state_change", { from: "submitted", to: "running", reason: "first_message" });
    await transcript.append("run.timed_out", { backendSessionId: "proc_old" });
    await transcript.append("run.state_change", { from: "running", to: "timed_out", reason: "timeout" });

    const events = await readTranscript(transcript.filePath);
    // findState：legacy timed_out 终态仍被识别为 timed_out（读取兼容）。
    assert.equal(findState(events), "timed_out",
      "findState 对 legacy timed_out 转录不得回归");

    // diagnosis：run.timed_out 事件仍分类为 timeout（读取兼容）。
    const diagnosis = diagnoseFailure(events, runId);
    assert.ok(diagnosis, "diagnoseFailure 应产出诊断");
    assert.equal(diagnosis.category, "timeout",
      `legacy timed_out 转录应分类 timeout，实际 ${diagnosis.category}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── deadline 禁用时零事实（默认 disabled 语义保持）──────────────────────────
test("TD-151: 未配置等待窗（disabled）→ 无到期事实、无定时器副作用", async () => {
  const dir = await makeTempDir();
  try {
    const { backend } = createSlowWorkerBackend({ silentMs: 30 });
    const manager = createManager(dir, backend, { waitTimeout: undefined });
    const run = await manager.start("nodeadline", { prompt: "go" });
    // 不传 waitTimeout，agent/config 也无 → resolveWaitTimeout = disabled。
    const result = await run.waitForCompletion({ pollInterval: 5 });
    assert.equal(result.completed, true);
    const events = await readTranscript(run.transcript.filePath);
    assert.equal(events.some((e) => e.type === "run.observation_deadline_reached"), false,
      "disabled 时不得有到期事实");
    const policy = events.find((e) => e.type === "run.wait_policy");
    assert.ok(policy, "run.wait_policy 仍应落盘");
    assert.equal(policy.waitTimeoutMs, null);
    assert.equal(policy.source, "disabled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ===== 审计回归钉（TD-151 收口轮）=====

test("审计 P1a: 入口短路顺序——自然 completed 后 run.abort()，再 wait 报 completed 不误报 aborted", async () => {
  const { RunManager } = await import("../../src/runManager.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wao-p1a-"));
  try {
    const config = { registry: "x", runDir: dir, pollInterval: 5, timeout: 1000, retries: 0 };
    const readRegistry = async () => ({ getAgent: (id) => ({ id, backend: "fake", cwd: dir }), listAgents: () => [] });
    const backendFor = () => ({
      async spawn() {
        return {
          backend: "fake", backendSessionId: "s1",
          abort: async () => {},
          events: async function* () { yield { kind: "done", reason: "completed" }; },
        };
      },
    });
    const manager = new RunManager({ config, readRegistry, transcriptDir: dir, backendFor });
    const run = await manager.start("t", { prompt: "x" });
    const r1 = await run.waitForCompletion({});
    assert.equal(r1.completed, true);
    // completed 已落盘后 Lead 误发 abort：仲裁保留 completed；新 wait 必须报 completed。
    await run.abort("user");
    const r2 = await run.waitForCompletion({});
    assert.equal(r2.completed, true, "已落盘 completed 是更高权威——不得被 _aborted 标志误报为 aborted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("审计 P2: 双等待者到期事实恰一条（run 级标志幂等去重）", async () => {
  const { RunManager } = await import("../../src/runManager.js");
  const { readTranscript } = await import("../../src/transcript.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wao-p2-"));
  try {
    const config = { registry: "x", runDir: dir, pollInterval: 5, timeout: 1000, retries: 0 };
    const readRegistry = async () => ({ getAgent: (id) => ({ id, backend: "fake", cwd: dir }), listAgents: () => [] });
    const backendFor = () => ({
      async spawn() {
        return {
          backend: "fake", backendSessionId: "s2",
          abort: async () => {},
          events: async function* (signal) {
            await new Promise((resolve) => {
              if (signal?.aborted) { resolve(); return; }
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          },
        };
      },
    });
    const manager = new RunManager({ config, readRegistry, transcriptDir: dir, backendFor });
    const run = await manager.start("t", { prompt: "x" });
    const w1 = run.waitForCompletion({ waitTimeout: 60, pollInterval: 5 });
    const w2 = run.waitForCompletion({ waitTimeout: 60, pollInterval: 5 }); // 第二个等待者
    const both = Promise.allSettled([w1, w2]);
    await new Promise((r) => setTimeout(r, 150)); // 两个定时器都到期
    await run.abort("user");
    await both;
    const events = await readTranscript(run.transcript.filePath);
    assert.equal(events.filter((e) => e.type === "run.observation_deadline_reached").length, 1,
      "多等待者各自定时器，run 级标志去重——事实恰一条（usage.md 承诺）");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
