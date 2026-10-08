// test/run-lifecycle/runTerminalBackendDispose.test.js
//
// TD-223（2026-10-07）：RunManager 终态路径必须回收 backend 自有文件工件
// （backend.dispose——claude-code native OAuth 隔离目录的删除钩子）。
//
// 机制：start() 在 backend 创建后/spawn 前把 dispose 组合进 cleanupFn
// （runManager.js composeBackendDispose）——已有 worktree cleanup 包一层
// （finally 执行 dispose），为 null（非 delivery，persistent by design）则直接
// 设为 dispose 包装。由此覆盖：
//   ① 正常完成（Run 终态 this._cleanup）
//   ② backend done(failed) 终态
//   ③ spawn 失败（start 内 safeCleanup 路径）
//   ④ submitted-rejected（spawn 期间外部终态，barrier 确定性构造）
//   ⑤ stop/中止（manager.abort → _abortInternal → _runCleanup）
//   ⑥ tokenBudget 预算击杀（S1-1 硬闸门终态）
//   ⑦ resume 重放终态（1673 站点的 backendFor 流——Run cleanup 挂 dispose 包装）
//   ⑧ resume 重放 spawn 失败（就地 dispose，无 Run 兜底）
//
// 全部用假 backend（含 dispose 计数器），零真实进程、零真实凭据。

import { mkdtempSync, rmSync } from "node:fs";
import fsPromisesDefault from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { RunManager } from "../../src/runManager.js";
import { JsonlTranscript } from "../../src/transcript.js";

async function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "wao-td223-rm-"));
}

/**
 * 假 backend：可注入 spawn 行为，dispose 计数。
 * spawnImpl: () => handle（或抛错）。默认产出 message + done(completed) 流。
 */
function makeDisposeBackend(spawnImpl) {
  const calls = { dispose: 0, spawn: 0, handleAbort: 0 };
  const defaultHandle = () => ({
    backend: "fake",
    backendSessionId: `ses_${calls.spawn}`,
    events: async function* () {
      yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "did work" }] };
      yield { kind: "done", reason: "completed" };
    },
    abort: async () => { calls.handleAbort += 1; },
    isAlive: () => false,
  });
  const backend = {
    replayByRespawn: true,
    async spawn(agent, task) {
      calls.spawn += 1;
      return spawnImpl ? spawnImpl(agent, task, calls) : defaultHandle();
    },
    async dispose() { calls.dispose += 1; },
  };
  return { backend, calls };
}

function makeManager(dir, backend, agentOverrides = {}, configOverrides = {}) {
  const config = {
    registry: "config/agents.json",
    runDir: dir,
    pollInterval: 10,
    waitTimeout: 2000,
    timeout: 5000,
    retries: 0,
    ...configOverrides,
  };
  const readRegistry = async () => ({
    getAgent(id, overrides = {}) {
      const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
      return { id, backend: "fake", cwd: dir, ...agentOverrides, ...defined };
    },
    listAgents() { return []; },
  });
  return new RunManager({ config, readRegistry, transcriptDir: dir, backendFor: () => backend });
}

test("TD-223: 正常完成 → backend.dispose 恰一次（cleanupFn 组合覆盖 Run 终态）", async () => {
  const dir = await makeTempDir();
  try {
    const { backend, calls } = makeDisposeBackend();
    const manager = makeManager(dir, backend);
    const run = await manager.start("w", { prompt: "do", runId: "run_td223_done" });
    const result = await run.waitForCompletion({});
    assert.equal(result.completed, true);
    assert.equal(run.state, "completed");
    assert.equal(calls.dispose, 1, "终态 cleanup 执行 backend.dispose");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-223: done(failed) 终态 → backend.dispose 恰一次（cleanup 先于 throw 执行）", async () => {
  const dir = await makeTempDir();
  try {
    const { backend, calls } = makeDisposeBackend(() => ({
      backend: "fake",
      backendSessionId: "ses_fail",
      events: async function* () {
        yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "half work" }] };
        yield { kind: "done", reason: "failed", error: "boom" };
      },
      abort: async () => {},
      isAlive: () => false,
    }));
    const manager = makeManager(dir, backend);
    const run = await manager.start("w", { prompt: "do", runId: "run_td223_fail" });
    // done(failed) 路径在 _runCleanup（dispose）之后向调用方 throw——
    // 断言 rejects 的同时 dispose 必须已执行。
    await assert.rejects(run.waitForCompletion({}), /boom/);
    assert.equal(run.state, "failed");
    assert.equal(calls.dispose, 1, "failed 终态 cleanup 先于 throw 执行 dispose");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-223: spawn 失败 → start 抛错路径也执行 backend.dispose（safeCleanup 组合）", async () => {
  const dir = await makeTempDir();
  try {
    const { backend, calls } = makeDisposeBackend(() => {
      throw new Error("spawn boom: executable ENOENT");
    });
    const manager = makeManager(dir, backend);
    await assert.rejects(
      manager.start("w", { prompt: "do", runId: "run_td223_spawnfail" }),
      /spawn boom/,
    );
    assert.equal(calls.dispose, 1, "spawn 失败终态同样回收文件工件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-223: submitted-rejected（spawn 期间外部终态）→ dispose 执行 + handle abort", async () => {
  const dir = await makeTempDir();
  try {
    const runId = "run_td223_race";
    let resolveSpawn;
    const spawnPromise = new Promise((resolve) => { resolveSpawn = resolve; });
    let signalSpawnEntered;
    const spawnEntered = new Promise((resolve) => { signalSpawnEntered = resolve; });
    const { backend, calls } = makeDisposeBackend(() => {
      signalSpawnEntered();
      return spawnPromise.then(() => ({
        backend: "fake",
        backendSessionId: "ses_race",
        events: async function* () {},
        abort: async () => { calls.handleAbort += 1; },
        isAlive: () => false,
      }));
    });
    const manager = makeManager(dir, backend);
    const startPromise = manager.start("w", { prompt: "do", runId });
    await spawnEntered; // pending 已 accepted，start 停在 spawn

    // 第二 writer 在 spawn resolve 前 claim aborted（确定性，无 sleep 竞速）。
    const externalWriter = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "w" });
    await externalWriter.transitionState("pending", "aborted", "external_stop");
    resolveSpawn();

    await assert.rejects(startPromise, /became terminal/);
    assert.equal(calls.handleAbort, 1, "rejected 时新 handle 被 abort");
    assert.equal(calls.dispose, 1, "submitted-rejected 终态回收文件工件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-223: stop/中止（manager.abort）→ aborted 终态执行 backend.dispose 恰一次", { timeout: 20_000 }, async () => {
  const dir = await makeTempDir();
  try {
    // 事件流先发一条 message（进 running），随后 parked 到 abort signal——
    // 模拟"进程活着但不产出"的静默流（TD-163 形状）。
    const { backend, calls } = makeDisposeBackend(() => ({
      backend: "fake",
      backendSessionId: "ses_park",
      events: async function* (signal) {
        yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "working" }] };
        while (!signal?.aborted) {
          await new Promise((r) => setTimeout(r, 10));
        }
      },
      abort: async () => { calls.handleAbort += 1; },
      isAlive: () => true,
    }));
    const manager = makeManager(dir, backend);
    const run = await manager.start("w", { prompt: "do", runId: "run_td223_abort" });
    const waitPromise = run.waitForCompletion({});
    await new Promise((r) => setTimeout(r, 100)); // 让循环进入 parked 段

    await manager.abort("run_td223_abort");
    const result = await waitPromise;
    assert.equal(result.aborted, true);
    assert.equal(run.state, "aborted");
    assert.equal(calls.handleAbort, 1);
    assert.equal(calls.dispose, 1, "中止终态同样回收（_cleaned 守卫恰一次）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-223: tokenBudget 预算击杀 → failed 终态执行 backend.dispose", { timeout: 20_000 }, async () => {
  const dir = await makeTempDir();
  try {
    // 失控 metrics：逐次翻倍（runManager.test.js createBudgetBackend "growing" 同款）。
    const { backend, calls } = makeDisposeBackend(() => ({
      backend: "fake",
      backendSessionId: "ses_budget",
      events: async function* (signal) {
        yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "working" }] };
        let round = 0;
        while (!signal?.aborted) {
          round += 1;
          yield { kind: "metrics", tokens: { input: 2000 * round, output: 10, reasoning: 0 } };
          await new Promise((r) => setTimeout(r, 10));
        }
      },
      abort: async () => {},
      isAlive: () => true,
    }));
    const manager = makeManager(dir, backend, { tokenBudget: 5000 }, { tokenBudgetMultiplier: 1 });
    const run = await manager.start("w", { prompt: "do", runId: "run_td223_budget" });
    const result = await run.waitForCompletion({});
    assert.equal(result.failed, true, "预算超限转 failed");
    assert.equal(run.state, "failed");
    assert.equal(calls.dispose, 1, "预算击杀终态回收文件工件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-223: resume 重放 run 终态 → backend.dispose 执行（1673 站点组合）", async () => {
  const dir = await makeTempDir();
  try {
    const { backend, calls } = makeDisposeBackend();
    const manager = makeManager(dir, backend);
    // start 后不 waitForCompletion（模拟中断，停在 submitted）→ resume 重放。
    const run1 = await manager.start("w", { prompt: "original", runId: "run_td223_resume" });
    assert.equal(run1.state, "submitted");
    assert.equal(calls.dispose, 0, "start 未终态不 dispose");

    const resumed = await manager.resume("run_td223_resume");
    assert.ok(resumed, "进程式 backend resume 返回 Run");
    const result = await resumed.waitForCompletion({});
    assert.equal(result.completed, true);
    assert.equal(calls.dispose, 1, "resume 重放 run 的终态 cleanup 执行 dispose");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-223: resume 重放 spawn 失败 → 就地 dispose（无 Run 兜底路径）", async () => {
  const dir = await makeTempDir();
  try {
    let spawnCount = 0;
    const { backend, calls } = makeDisposeBackend(() => {
      spawnCount += 1;
      if (spawnCount === 1) {
        return {
          backend: "fake",
          backendSessionId: "ses_first",
          events: async function* () { yield { kind: "done", reason: "completed" }; },
          abort: async () => {},
          isAlive: () => false,
        };
      }
      throw new Error("replay spawn boom");
    });
    const manager = makeManager(dir, backend);
    await manager.start("w", { prompt: "original", runId: "run_td223_resumefail" });
    assert.equal(calls.dispose, 0);

    await assert.rejects(manager.resume("run_td223_resumefail"), /replay spawn boom/);
    assert.equal(calls.dispose, 1, "resume spawn 失败就地回收（catch 路径）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-223: 无 dispose 方法的注入 backend（legacy 测试假件形状）不受影响", async () => {
  const dir = await makeTempDir();
  try {
    // composeBackendDispose 对无 dispose 的 backend 静默跳过——既有测试注入的
    // 裸假 backend（runManager.test.js 大量）不因组合层抛错。
    const legacyBackend = {
      async spawn() {
        return {
          backend: "legacy",
          backendSessionId: "ses_legacy",
          events: async function* () { yield { kind: "done", reason: "completed" }; },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    const manager = makeManager(dir, legacyBackend);
    const run = await manager.start("w", { prompt: "do", runId: "run_td223_legacy" });
    const result = await run.waitForCompletion({});
    assert.equal(result.completed, true, "无 dispose backend 生命周期不受影响");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// TD-234 验收修回归钉（astra R1，2026-10-08）：终态写入抛读错误（EACCES）时
// run 已摘除但 cleanup 曾被跳过——修后 waitForCompletion 终态化尾部 try/finally
// 兜底执行 _runCleanup（backend.dispose 仍恰一次），原始错误不吞。
test("TD-234 R1: terminal write failing mid-read-error still runs backend.dispose exactly once", async () => {
  const dir = await makeTempDir();
  try {
    // astra R1 复现形态：done 事件【之后】、终态写入【之前】武装读故障——
    // 终态 CAS 锁内读失败 → 上抛；finally 兜底 cleanup。
    const filePath = join(dir, "run_td234_r1.jsonl");
    const fault = Object.assign(new Error("read denied"), { code: "EACCES" });
    const real = fsPromisesDefault.readFile;
    const { backend: armingBackend, calls } = makeDisposeBackend(() => ({
      backend: "fake",
      backendSessionId: "ses_td234r1",
      events: async function* () {
        yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "x" }] };
        // 此刻流转尚未消费 done——先武装，再交出 done。
        fsPromisesDefault.readFile = async (p, ...rest) => {
          if (p === filePath) throw fault;
          return real(p, ...rest);
        };
        syncBuiltinESMExports();
        yield { kind: "done", reason: "completed" };
      },
      abort: async () => {},
      isAlive: () => false,
    }));
    const manager = makeManager(dir, armingBackend);
    const run = await manager.start("w", { prompt: "do", runId: "run_td234_r1" });
    let threw = null;
    try {
      await run.waitForCompletion({});
    } catch (e) {
      threw = e;
    } finally {
      fsPromisesDefault.readFile = real;
      syncBuiltinESMExports();
    }
    assert.ok(threw, "意外错误上抛（不吞）");
    assert.equal(calls.dispose, 1, "终态写入失败的兜底 cleanup 仍执行 backend.dispose 恰一次");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
