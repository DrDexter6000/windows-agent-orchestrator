// test/application/upstreamSessionRelease.test.js
//
// TD-250（决定 0056）A1b 钉：验收（run.delivery_accepted）后的线系上游会话卫生。
// 两层：upstreamSessionRelease 纯函数/工厂（注入 registry+backend）；
// decideRunDelivery 触发合同（accepted 才触发、rejected 永不、释放抛错被吞）。

import test from "node:test";
import assert from "node:assert/strict";
import {
  sessionIdFromEvents,
  releaseOutcomeEvent,
  makeAcceptedSessionRelease,
} from "../../src/application/upstreamSessionRelease.js";
import { decideRunDelivery } from "../../src/application/runDelivery.js";

// ===== 纯函数 =====

test("TD-250 A1b: sessionIdFromEvents 取最后一条绑定 session.created；缺席/非数组 → null", () => {
  assert.equal(sessionIdFromEvents([
    { type: "session.created", backendSessionId: "session_first", seq: 1 },
    { type: "run.state_change", seq: 2 },
    { type: "session.created", backendSessionId: "session_second", seq: 3 },
  ]), "session_second");
  assert.equal(sessionIdFromEvents([{ type: "run.metrics" }]), null);
  assert.equal(sessionIdFromEvents([]), null);
  assert.equal(sessionIdFromEvents(null), null);
  assert.equal(sessionIdFromEvents([{ type: "session.created", backendSessionId: "" }]), null);
});

test("TD-250 A1b: releaseOutcomeEvent 闭集映射与 runManager 侧逐字同源", () => {
  assert.deepEqual(releaseOutcomeEvent("s", { outcome: "deleted" }),
    { type: "run.upstream_session_deleted", payload: { backendSessionId: "s" } });
  assert.deepEqual(releaseOutcomeEvent("s", { outcome: "already_gone" }),
    { type: "run.upstream_session_already_gone", payload: { backendSessionId: "s" } });
  assert.deepEqual(releaseOutcomeEvent("s", { outcome: "skipped_busy" }),
    { type: "run.upstream_session_delete_skipped", payload: { backendSessionId: "s", reason: "busy" } });
  assert.deepEqual(releaseOutcomeEvent("s", { outcome: "failed", reason: "upstream_rejected", code: 50001 }),
    { type: "run.upstream_session_delete_failed", payload: { backendSessionId: "s", reason: "upstream_rejected", code: 50001 } });
  assert.deepEqual(releaseOutcomeEvent("s", { outcome: "failed", reason: "bogus" }),
    { type: "run.upstream_session_delete_failed", payload: { backendSessionId: "s", reason: "http_error" } });
  assert.deepEqual(releaseOutcomeEvent("s", null),
    { type: "run.upstream_session_delete_failed", payload: { backendSessionId: "s", reason: "http_error" } });
});

// ===== 工厂（注入 registry / backendFor）=====

function fakeRegistryFn(agent) {
  return async () => ({ getAgent: (id) => (id === agent.id ? agent : (() => { throw new Error("Unknown agent"); })()) });
}

test("TD-250 A1b: makeAcceptedSessionRelease——能力在场+有会话 → 恰一事件落验收转录", async () => {
  const released = [];
  const agent = { id: "kimi", backend: "kimi-web", serveUrl: "http://x", tokenEnv: "T" };
  const release = makeAcceptedSessionRelease({
    registryPath: "/r.json",
    readRegistryFn: fakeRegistryFn(agent),
    backendForFn: () => ({
      supportsSessionRelease: true,
      async releaseSession(a, sid) { released.push({ a: a.id, sid }); return { outcome: "deleted" }; },
    }),
  });
  const appended = [];
  const transcript = { async append(type, payload) { appended.push({ type, payload }); } };
  const fired = await release({
    agentId: "kimi",
    events: [{ type: "session.created", backend: "kimi-web", backendSessionId: "session_lin", agentId: "kimi", seq: 1 }],
    transcript,
  });
  assert.equal(fired, true);
  assert.deepEqual(released, [{ a: "kimi", sid: "session_lin" }]);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].type, "run.upstream_session_deleted");
  assert.equal(appended[0].payload.backendSessionId, "session_lin");
});

test("TD-250 A1b: 能力缺席/无会话/未知 agent/注册表故障 → 零事件零副作用（静默 no-op）", async () => {
  const appended = [];
  const transcript = { async append(type, payload) { appended.push({ type, payload }); } };
  const events = [{ type: "session.created", backend: "kimi-web", backendSessionId: "session_lin", agentId: "kimi", seq: 1 }];
  const mk = ({ backend, registryFn }) => makeAcceptedSessionRelease({
    registryPath: "/r.json",
    readRegistryFn: registryFn ?? fakeRegistryFn({ id: "kimi" }),
    backendForFn: () => backend,
  });
  // 能力缺席
  let fired = await mk({ backend: {} })({ agentId: "kimi", events, transcript });
  assert.equal(fired, false);
  // 无会话（pre-spawn 形态）
  fired = await mk({
    backend: { supportsSessionRelease: true, async releaseSession() { throw new Error("must not"); } },
    registryFn: fakeRegistryFn({ id: "kimi" }),
  })({ agentId: "kimi", events: [], transcript });
  assert.equal(fired, false);
  // agentId unknown 哨兵
  fired = await mk({ backend: { supportsSessionRelease: true } })({ agentId: "unknown", events, transcript });
  assert.equal(fired, false);
  // 注册表抛错
  fired = await mk({
    backend: { supportsSessionRelease: true },
    registryFn: async () => { throw new Error("registry io"); },
  })({ agentId: "kimi", events, transcript });
  assert.equal(fired, false);
  assert.equal(appended.length, 0);
});

// ===== decideRunDelivery 触发合同 =====

test("TD-250 A1b: decide accepted → sessionRelease 恰触发一次并拿到 events/transcript；rejected → 零触发", async () => {
  const mkTranscript = (decisionResult) => {
    const appended = [];
    return {
      appended,
      transcript: {
        async tryAppendDecision() { return decisionResult; },
        async append(type, payload) { appended.push({ type, payload }); },
      },
    };
  };
  const events = [{ type: "session.created", backend: "kimi-web", backendSessionId: "session_lin", agentId: "kimi", seq: 1 }];
  const calls = [];
  const run = async (decision, decisionResult) => {
    const { transcript, appended } = mkTranscript(decisionResult);
    const res = await decideRunDelivery({
      runId: "run_td250_a1b",
      runDir: "/runs",
      decision,
      reason: "ok",
      readTranscriptFn: async () => events,
      transcriptFactory: async () => transcript,
      sessionRelease: async (input) => { calls.push({ decision, hasEvents: Array.isArray(input.events), sameTranscript: input.transcript === transcript }); return true; },
    });
    return { res, appended };
  };
  const ok = await run("accepted", { accepted: true, event: { type: "run.delivery_accepted" } });
  assert.equal(ok.res.accepted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].decision, "accepted");
  assert.equal(calls[0].hasEvents, true);
  assert.equal(calls[0].sameTranscript, true);
  const rej = await run("rejected", { accepted: true, event: { type: "run.delivery_rejected" } });
  assert.equal(rej.res.accepted, true);
  assert.equal(calls.length, 1, "rejected 永不触发释放");
});

test("TD-250 A1b: 释放抛错被吞——验收结果原样返回、不污染返回值", async () => {
  const transcript = {
    async tryAppendDecision() { return { accepted: true, event: { type: "run.delivery_accepted" } }; },
    async append() { throw new Error("must not reach append on throw path"); },
  };
  const res = await decideRunDelivery({
    runId: "run_td250_a1b2",
    runDir: "/runs",
    decision: "accepted",
    reason: "ok",
    readTranscriptFn: async () => [{ type: "session.created", backendSessionId: "s", agentId: "kimi", seq: 1 }],
    transcriptFactory: async () => transcript,
    sessionRelease: async () => { throw new Error("network down"); },
  });
  assert.equal(res.accepted, true, "best-effort：释放失败绝不改写验收事实");
});
