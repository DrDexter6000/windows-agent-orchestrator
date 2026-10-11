// test/run-lifecycle/td250-upstreamSessionRelease.test.js
//
// TD-250（决定 0056）A1 集成钉：RunManager 终态清理路径的上游会话卫生。
// 事件族合同（双席会审 consult_20261010220638436s4gchx）：
//   - 一果一名：run.upstream_session_deleted / _already_gone /
//     _delete_skipped{reason} / _delete_failed{reason[,code]}
//   - 恰好一条（能力在场且有 backendSessionId 的 run）；能力缺席/pre-spawn
//     终态（无会话）= 零事件
//   - 门1 routing（sessionReuse 在场→跳过）；门2 completed-only（this.state
//     是仲裁已接受态）；busy 预探针在 backend.releaseSession 内（skipped_busy）
//   - 顺序：release 在停止验证之后、run.cleanup_done 之前
//   - 幂等：_runCleanup 重复进入不重复删/不重复写

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunManager, Run } from "../../src/runManager.js";
import { JsonlTranscript } from "../../src/transcript.js";

function cleanupDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function makeFakeBackend({ outcome = { outcome: "deleted" }, throwOnRelease = false } = {}) {
  const calls = [];
  return {
    calls,
    supportsRoleContract: true,
    supportsSessionReuse: true,
    supportsSessionRelease: true,
    validateAgentPolicy() {},
    async spawn(agent) {
      return {
        backend: "kimi-web",
        backendSessionId: "session_td250",
        events: async function* () {
          yield { kind: "message", parts: [{ type: "text", text: "done text" }] };
          yield { kind: "done", reason: "completed" };
        },
        abort: async () => {},
      };
    },
    async releaseSession(agent, sessionId) {
      calls.push({ agentId: agent?.id, sessionId });
      if (throwOnRelease) throw new Error("contract violation");
      return outcome;
    },
  };
}

function makeRun({ backend, initialState = "completed", sessionReuse = null, sessionId = "session_td250" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wao-td250-run-"));
  const filePath = join(dir, "run_td250_1.jsonl");
  const transcript = new JsonlTranscript(filePath, { runId: "run_td250_1", agentId: "kimi", initialSeq: 0 });
  const handle = {
    backend: "kimi-web",
    backendSessionId: sessionId,
    events: async function* () {},
    abort: async () => {},
  };
  const run = new Run({
    runId: "run_td250_1",
    agentId: "kimi",
    agent: { id: "kimi", backend: "kimi-web", cwd: dir },
    backend,
    handle,
    transcript,
    result: handle,
    config: {},
    onRemove: () => {},
    initialState,
    ...(sessionReuse ? { sessionReuse } : {}),
  });
  return { run, dir, transcript };
}

function readEvents(pathOrDir) {
  let raw;
  try {
    raw = readFileSync(typeof pathOrDir === "string" && pathOrDir.endsWith(".jsonl")
      ? pathOrDir
      : join(pathOrDir, "run_td250_1.jsonl"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return []; // 零事件合同：转录文件可以根本不存在
    throw error;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split("\n").map((l) => JSON.parse(l));
}

const RELEASE_EVENT_TYPES = [
  "run.upstream_session_deleted",
  "run.upstream_session_already_gone",
  "run.upstream_session_delete_skipped",
  "run.upstream_session_delete_failed",
];

test("TD-250 A1: completed + 无 routing → 恰一条 deleted 事件；backend 收到 (agent, sessionId)", async () => {
  const backend = makeFakeBackend({ outcome: { outcome: "deleted" } });
  const { run, dir } = makeRun({ backend });
  await run._runCleanup();
  const events = readEvents(dir);
  const releaseEvents = events.filter((e) => RELEASE_EVENT_TYPES.includes(e.type));
  assert.deepEqual(releaseEvents.map((e) => e.type), ["run.upstream_session_deleted"]);
  assert.equal(releaseEvents[0].backendSessionId, "session_td250");
  assert.equal(backend.calls.length, 1);
  assert.deepEqual(backend.calls[0], { agentId: "kimi", sessionId: "session_td250" });
  cleanupDir(dir);
});

test("TD-250 A1: 幂等——_runCleanup 双入恰一删一事件（_upstreamSessionReleased 单发）", async () => {
  const backend = makeFakeBackend();
  const { run, dir } = makeRun({ backend });
  await run._runCleanup();
  await run._runCleanup();
  assert.equal(backend.calls.length, 1);
  assert.equal(readEvents(dir).filter((e) => RELEASE_EVENT_TYPES.includes(e.type)).length, 1);
  cleanupDir(dir);
});

test("TD-250 A1 门1: sessionReuse routing 在场 → skipped{reason:routing}，releaseSession 零调用", async () => {
  const backend = makeFakeBackend();
  const { run, dir } = makeRun({
    backend,
    initialState: "completed",
    sessionReuse: { mode: "lead_workspace", opaqueUuid: "op", turn: "first" },
  });
  await run._runCleanup();
  assert.equal(backend.calls.length, 0, "routing 门在 backend 调用之前——线系会话受保护");
  const events = readEvents(dir).filter((e) => RELEASE_EVENT_TYPES.includes(e.type));
  assert.deepEqual(events.map((e) => [e.type, e.reason]), [["run.upstream_session_delete_skipped", "routing"]]);
  cleanupDir(dir);
});

test("TD-250 A1 门2: state=failed → skipped{reason:not_completed}（failed 会话保留给迟到收取）", async () => {
  const backend = makeFakeBackend();
  const { run, dir } = makeRun({ backend, initialState: "failed" });
  await run._runCleanup();
  assert.equal(backend.calls.length, 0);
  const events = readEvents(dir).filter((e) => RELEASE_EVENT_TYPES.includes(e.type));
  assert.deepEqual(events.map((e) => [e.type, e.reason]), [["run.upstream_session_delete_skipped", "not_completed"]]);
  cleanupDir(dir);
});

test("TD-250 A1: 闭集结果映射——already_gone / skipped_busy / failed{reason,code}", async () => {
  for (const [outcome, expected] of [
    [{ outcome: "already_gone" }, ["run.upstream_session_already_gone", undefined, undefined]],
    [{ outcome: "skipped_busy" }, ["run.upstream_session_delete_skipped", "busy", undefined]],
    [{ outcome: "failed", reason: "upstream_rejected", code: 50001 }, ["run.upstream_session_delete_failed", "upstream_rejected", 50001]],
    [{ outcome: "failed", reason: "made-up-reason" }, ["run.upstream_session_delete_failed", "http_error", undefined]],
  ]) {
    const backend = makeFakeBackend({ outcome });
    const { run, dir } = makeRun({ backend });
    await run._runCleanup();
    const ev = readEvents(dir).filter((e) => RELEASE_EVENT_TYPES.includes(e.type));
    assert.equal(ev.length, 1, `${JSON.stringify(outcome)} → 恰一事件`);
    assert.equal(ev[0].type, expected[0]);
    assert.equal(ev[0].reason, expected[1]);
    assert.equal(ev[0].code, expected[2]);
    cleanupDir(dir);
  }
});

test("TD-250 A1 合同: 能力缺席（无 supportsSessionRelease）→ 零事件零调用；无 backendSessionId → 零事件", async () => {
  const backend = makeFakeBackend();
  delete backend.supportsSessionRelease;
  let ctx = makeRun({ backend });
  await ctx.run._runCleanup();
  assert.equal(readEvents(ctx.dir).length, 0);
  assert.equal(backend.calls.length, 0);
  cleanupDir(ctx.dir);

  const backend2 = makeFakeBackend();
  ctx = makeRun({ backend: backend2, sessionId: "" });
  await ctx.run._runCleanup();
  assert.equal(readEvents(ctx.dir).length, 0, "pre-spawn 形态（无会话）零事件");
  assert.equal(backend2.calls.length, 0);
  cleanupDir(ctx.dir);
});

test("TD-250 A1 顺序+吞错: deleted 事件在 run.cleanup_done 之前；releaseSession 抛错被吞、后续 cleanup 不受阻", async () => {
  const backend = makeFakeBackend();
  const { run, dir } = makeRun({ backend });
  let cleanupRan = false;
  run._cleanup = async () => { cleanupRan = true; };
  await run._runCleanup();
  const events = readEvents(dir);
  const relIdx = events.findIndex((e) => e.type === "run.upstream_session_deleted");
  const cleanupIdx = events.findIndex((e) => e.type === "run.cleanup_done");
  assert.ok(relIdx !== -1 && cleanupIdx !== -1, "两事件都在场");
  assert.ok(relIdx < cleanupIdx, "会话卫生先于 cleanup_done（与停止验证/cleanup 的次序合同）");
  assert.equal(cleanupRan, true);

  const throwing = makeFakeBackend({ throwOnRelease: true });
  const ctx2 = makeRun({ backend: throwing });
  let cleanup2Ran = false;
  ctx2.run._cleanup = async () => { cleanup2Ran = true; };
  await ctx2.run._runCleanup();
  assert.equal(cleanup2Ran, true, "backend 违约抛错不阻断清理链");
  assert.equal(readEvents(ctx2.dir).filter((e) => RELEASE_EVENT_TYPES.includes(e.type)).length, 0,
    "违约抛错路径零事件（releaseSession 合同=绝不抛错）");
  cleanupDir(ctx2.dir);
  cleanupDir(dir);
});

test("TD-250 A1 全流程: manager.start → done(completed) → 转录含 deleted 事件（真实接线，非直调）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td250-start-"));
  try {
    const backend = makeFakeBackend({ outcome: { outcome: "deleted" } });
    const readRegistry = async () => ({
      getAgent(id) { return { id, backend: "kimi-web", cwd: dir }; },
      listAgents() { return []; },
    });
    const manager = new RunManager({
      config: {
        registry: "x", runDir: dir, pollInterval: 5, waitTimeout: 2000,
        timeout: 5000, retries: 0, defaultIsolation: "none",
      },
      readRegistry,
      transcriptDir: dir,
      backendFor: () => backend,
    });
    const run = await manager.start("kimi", { prompt: "hi", runId: "run_td250_start1" });
    const result = await run.waitForCompletion({});
    assert.equal(result.state ?? run.state, "completed");
    // D2-②b：新转录可能桶化到 projects/<slug>/ 下——唯一权威路径=run.transcript.filePath。
    const events = readEvents(run.transcript.filePath);
    assert.ok(events.some((e) => e.type === "run.upstream_session_deleted" && e.backendSessionId === "session_td250"),
      "真实完成路径自动删除上游会话");
    assert.ok(events.some((e) => e.type === "run.cleanup_done"));
  } finally {
    cleanupDir(dir);
  }
});
