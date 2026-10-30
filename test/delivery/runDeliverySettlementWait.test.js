// test/delivery/runDeliverySettlementWait.test.js
//
// 决定 0095（第 49 批）第 7.5 节：MCP run_delivery 的有界等待
//（getRunDeliveryReadiness）改由收口判定决定去留后，两种"readiness 显示
// reviewable 但未收口"的形状必须真正等待：
//   ① 验证中拒收（TD-179 pending rejection：pending 验证 + 已拒收决定）；
//   ② reverify pending。
// 对照：settled 形状仍提前返回（waitReturnedEarly:true）。
// 服务级进程内测试：tmp 转录 + 假时钟（sleep 推进），零真实等待。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getRunDeliveryReadiness } from "../../src/application/runDelivery.js";

const BASE = "b".repeat(40);
const DELIVERED = "d".repeat(40);

function makeRunDir() {
  return mkdtempSync(join(tmpdir(), "wao-delivery-settle-wait-"));
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeRef(runId, over = {}) {
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId,
    baseCommit: BASE,
    deliveryCommit: DELIVERED,
    branch: `wao/${runId}`,
    worktreePath: "D:/fake/wt",
    changedFiles: ["src/a.js"],
    verification: { status: "pending", commands: [], verifiedCommit: DELIVERED, results: [] },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
    ...over,
  };
}

function makeVerifiedRef(runId, status, ref = makeRef(runId)) {
  const verification = status === "failed"
    ? { status, failureCode: "command_failed", commands: [], verifiedCommit: ref.deliveryCommit, results: [] }
    : { status, commands: [], verifiedCommit: ref.deliveryCommit, results: [] };
  return { ...ref, verification };
}

function started(runId) {
  return {
    type: "run.started", runId, agentId: "coder_low", backend: "claude-code", cwd: "D:/fake/ws",
    delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] },
  };
}

function stateChange(runId, to) {
  return { type: "run.state_change", runId, agentId: "coder_low", from: "running", to, reason: "done" };
}

function writeEvents(dir, runId, objs) {
  writeFileSync(join(dir, `${runId}.jsonl`), objs.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
}

function appendEvents(dir, runId, objs) {
  appendFileSync(join(dir, `${runId}.jsonl`), objs.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
}

// 假时钟：sleep 推进 ms；可选 onSleep 钩子在每次 sleep 时点改写转录（外部世界
// 落验证结果的确定性模拟）。
function makeClock() {
  let t = 1_000_000;
  return {
    nowFn: () => t,
    sleepFn: async (ms) => { t += ms; },
  };
}

test("DSW-01: 验证中拒收（pending + rejected 决定，readiness reviewable）→ 带 waitMs 真正等待；late outcome 落地后提前返回", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_dsw01";
    const ref = makeRef(runId);
    writeEvents(dir, runId, [
      started(runId),
      { type: "run.delivery_created", runId, agentId: "coder_low", delivery: ref },
      stateChange(runId, "completed"),
      {
        type: "run.delivery_rejected", runId, agentId: "coder_low",
        delivery: { ...ref, acceptance: { status: "rejected", reviewerType: "lead_agent" } },
        deliveryCommit: ref.deliveryCommit, reason: "settling without an outcome",
      },
    ]);
    const clock = makeClock();
    let appended = false;
    const r = await getRunDeliveryReadiness({
      runId, runDir: dir, waitMs: 5000,
      sleepFn: async (ms) => {
        clock.sleepFn(ms);
        if (!appended) {
          appended = true;
          appendEvents(dir, runId, [{
            type: "run.delivery_verification_passed", runId, agentId: "coder_low",
            delivery: makeVerifiedRef(runId, "passed", ref),
          }]);
        }
      },
      nowFn: clock.nowFn,
      pollIntervalMs: 1000,
    });
    assert.equal(r.readiness, "reviewable", "拒收决定使 readiness 仍是 reviewable");
    assert.equal(r.waitReturnedEarly, true, "验证结果落地后收口 → 提前返回（此前它会立即返回 pending 快照）");
    assert.equal(r.verification.status, "passed", "late outcome 是验证真相");
    assert.equal(r.acceptance.status, "rejected", "拒收不被翻案");
  } finally {
    cleanupDir(dir);
  }
});

test("DSW-02: 验证中拒收一直无结果 → 等到 deadline 如实返回（waitReturnedEarly:false）", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_dsw02";
    const ref = makeRef(runId);
    writeEvents(dir, runId, [
      started(runId),
      { type: "run.delivery_created", runId, agentId: "coder_low", delivery: ref },
      stateChange(runId, "completed"),
      {
        type: "run.delivery_rejected", runId, agentId: "coder_low",
        delivery: { ...ref, acceptance: { status: "rejected", reviewerType: "lead_agent" } },
        deliveryCommit: ref.deliveryCommit, reason: "settling without an outcome",
      },
    ]);
    const clock = makeClock();
    const r = await getRunDeliveryReadiness({
      runId, runDir: dir, waitMs: 5000,
      sleepFn: clock.sleepFn, nowFn: clock.nowFn, pollIntervalMs: 1000,
    });
    assert.equal(r.readiness, "reviewable");
    assert.equal(r.waitReturnedEarly, false, "未收口 → 等满窗口（旧行为会立即返回）");
    assert.equal(r.verification.status, "pending", "验证仍无结果，如实报告");
  } finally {
    cleanupDir(dir);
  }
});

test("DSW-03: reverify pending → 真正等待；reverify 结果落地 → 提前返回", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_dsw03";
    const failedRef = makeVerifiedRef(runId, "failed");
    writeEvents(dir, runId, [
      started(runId),
      { type: "run.delivery_created", runId, agentId: "coder_low", delivery: failedRef },
      { type: "run.delivery_verification_failed", runId, agentId: "coder_low", delivery: failedRef },
      stateChange(runId, "completed"),
      {
        type: "run.delivery_reverification_requested", runId, agentId: "coder_low",
        delivery: failedRef, deliveryCommit: failedRef.deliveryCommit, reason: "tooling_invalid",
      },
    ]);
    const clock = makeClock();
    let appended = false;
    const r = await getRunDeliveryReadiness({
      runId, runDir: dir, waitMs: 5000,
      sleepFn: async (ms) => {
        clock.sleepFn(ms);
        if (!appended) {
          appended = true;
          appendEvents(dir, runId, [{
            type: "run.delivery_reverification_passed", runId, agentId: "coder_low",
            delivery: makeVerifiedRef(runId, "passed", failedRef),
            deliveryCommit: failedRef.deliveryCommit,
          }]);
        }
      },
      nowFn: clock.nowFn,
      pollIntervalMs: 1000,
    });
    assert.equal(r.readiness, "reviewable");
    assert.equal(r.waitReturnedEarly, true, "reverify 落结果后收口 → 提前返回（旧行为会立即返回原验证快照）");
    assert.equal(r.reverify.status, "complete");
    assert.equal(r.effectiveVerification.status, "passed", "reverify 通过成为有效验证状态");
  } finally {
    cleanupDir(dir);
  }
});

test("DSW-04: 对照——已收口形状仍立即返回（waitReturnedEarly:true，零 sleep）", async () => {
  const dir = makeRunDir();
  try {
    // 无交付的终态 run。
    const runId = "run_dsw04";
    writeEvents(dir, runId, [
      { type: "run.started", runId, agentId: "coder_low", backend: "claude-code", cwd: "D:/fake/ws" },
      stateChange(runId, "completed"),
    ]);
    let sleeps = 0;
    const r = await getRunDeliveryReadiness({
      runId, runDir: dir, waitMs: 5000,
      sleepFn: async () => { sleeps += 1; }, nowFn: () => 1, pollIntervalMs: 1000,
    });
    assert.equal(r.readiness, "not_requested");
    assert.equal(r.waitReturnedEarly, true);
    assert.equal(sleeps, 0, "settled 形状零等待");
  } finally {
    cleanupDir(dir);
  }
});

test("DSW-05: 读取失败仍按现有口径返回（fail closed 到 ambiguous，不当收口）", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_dsw05";
    const ref = makeRef(runId);
    writeEvents(dir, runId, [
      started(runId),
      { type: "run.delivery_created", runId, agentId: "coder_low", delivery: ref },
      stateChange(runId, "completed"),
    ]);
    const clock = makeClock();
    let reads = 0;
    const r = await getRunDeliveryReadiness({
      runId, runDir: dir, waitMs: 5000,
      readTranscriptFn: async () => {
        reads += 1;
        if (reads === 1) {
          // 初始读成功（返回真内容）；等待中的重读失败 → fail closed。
          const { readTranscript } = await import("../../src/transcript.js");
          return readTranscript(join(dir, `${runId}.jsonl`));
        }
        throw new Error("gone");
      },
      sleepFn: clock.sleepFn, nowFn: clock.nowFn, pollIntervalMs: 1000,
    });
    assert.equal(r.readiness, "ambiguous", "重读失败 fail closed 到既有 ambiguous，不伪装收口");
    assert.equal(r.waitReturnedEarly, true, "提前返回（读取不可信不是等待能改善的）");
  } finally {
    cleanupDir(dir);
  }
});

test("DSW-06: 非终态 run 上的持久冲突（多条验证结果）→ 立即 ambiguous 返回，不进等待（常量时钟下也不许自旋）", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_dsw06";
    const ref = makeRef(runId);
    // 无 run.started / 无终态：created + 两条验证结果 = malformed 事实挂在非终态 run 上。
    writeEvents(dir, runId, [
      { type: "run.delivery_created", runId, agentId: "coder_low", delivery: ref },
      { type: "run.delivery_verification_passed", runId, agentId: "coder_low", delivery: ref },
      { type: "run.delivery_verification_failed", runId, agentId: "coder_low", delivery: ref },
    ]);
    let sleeps = 0;
    const r = await getRunDeliveryReadiness({
      runId, runDir: dir, waitMs: 1000,
      sleepFn: async () => { sleeps += 1; }, nowFn: () => 1,
    });
    assert.equal(r.readiness, "ambiguous");
    assert.equal(r.waitReturnedEarly, true);
    assert.equal(sleeps, 0, "非终态持久冲突不进等待循环（收口判定 unsettled 也不能让等待修断链）");
  } finally {
    cleanupDir(dir);
  }
});

test("DSW-07: 非终态 not_requested / packaging_failed 仍立即返回（legacy 快路径，不进等待）", async () => {
  const dir = makeRunDir();
  try {
    // 无终态 state_change：run.started（无交付）→ not_requested；等待不去管 run 级终态。
    writeEvents(dir, "run_dsw07a", [
      { type: "run.started", runId: "run_dsw07a", agentId: "coder_low", backend: "claude-code", cwd: "D:/fake/ws" },
    ]);
    let sleeps = 0;
    const nr = await getRunDeliveryReadiness({
      runId: "run_dsw07a", runDir: dir, waitMs: 1000,
      sleepFn: async () => { sleeps += 1; }, nowFn: () => 1,
    });
    assert.equal(nr.readiness, "not_requested");
    assert.equal(nr.waitReturnedEarly, true, "非终态 not_requested 立即返回（TD-137② 钉）");

    // 非终态 + 一条打包失败 → packaging_failed 立即返回。
    writeEvents(dir, "run_dsw07b", [
      started("run_dsw07b"),
      { type: "run.delivery_failed", runId: "run_dsw07b", agentId: "coder_low", deliveryCode: "backend_error" },
    ]);
    const pf = await getRunDeliveryReadiness({
      runId: "run_dsw07b", runDir: dir, waitMs: 1000,
      sleepFn: async () => { sleeps += 1; }, nowFn: () => 1,
    });
    assert.equal(pf.readiness, "packaging_failed");
    assert.equal(pf.waitReturnedEarly, true, "非终态 packaging_failed 立即返回");
    assert.equal(sleeps, 0, "两条快路径都零等待");
  } finally {
    cleanupDir(dir);
  }
});

test("DSW-08: 非终态 run 的 reviewable（验证已完备、run 未停）→ 立即返回，不进等待", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_dsw08";
    const ref = makeVerifiedRef(runId, "passed");
    // 无终态 state_change：created + 验证通过挂在仍在跑的 run 上。
    writeEvents(dir, runId, [
      started(runId),
      { type: "run.delivery_created", runId, agentId: "coder_low", delivery: ref },
      { type: "run.delivery_verification_passed", runId, agentId: "coder_low", delivery: ref },
    ]);
    let sleeps = 0;
    const r = await getRunDeliveryReadiness({
      runId, runDir: dir, waitMs: 1000,
      sleepFn: async () => { sleeps += 1; }, nowFn: () => 1,
    });
    assert.equal(r.readiness, "reviewable");
    assert.equal(r.waitReturnedEarly, true, "交付侧已完备——run 级终态不归这个等待管（m11-10 SVC-06 同款形状）");
    assert.equal(sleeps, 0);
  } finally {
    cleanupDir(dir);
  }
});

test("DSW-09: 等待中由正常等验证变成断链（第二条 delivery_created）→ 以 ambiguous 提前返回", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_dsw09";
    const ref = makeRef(runId);
    writeEvents(dir, runId, [
      started(runId),
      { type: "run.delivery_created", runId, agentId: "coder_low", delivery: ref },
      stateChange(runId, "completed"),
    ]);
    let t = 1_000_000;
    let sleeps = 0;
    const r = await getRunDeliveryReadiness({
      runId, runDir: dir, waitMs: 60_000,
      sleepFn: async (ms) => {
        sleeps += 1;
        t += ms;
        if (sleeps === 1) appendEvents(dir, runId, [{ type: "run.delivery_created", runId, agentId: "coder_low", delivery: ref }]);
      },
      nowFn: () => t, pollIntervalMs: 1000,
    });
    assert.equal(r.readiness, "ambiguous");
    assert.equal(r.waitReturnedEarly, true, "断链不是等待能改善的：提前返回");
    assert.equal(sleeps, 1, "第一次重读就返回");
  } finally {
    cleanupDir(dir);
  }
});

test("DSW-10: legacy ref（无验证状态）+ reverify 事实、无原始结果 → readiness ambiguous，立即返回，与收口判定一致", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_dsw10";
    const legacyRef = makeRef(runId);
    delete legacyRef.verification;
    writeEvents(dir, runId, [
      started(runId),
      { type: "run.delivery_created", runId, agentId: "coder_low", delivery: legacyRef },
      stateChange(runId, "completed"),
      {
        type: "run.delivery_reverification_requested", runId, agentId: "coder_low",
        delivery: legacyRef, deliveryCommit: legacyRef.deliveryCommit, reason: "tooling_invalid",
      },
    ]);
    let sleeps = 0;
    const r = await getRunDeliveryReadiness({
      runId, runDir: dir, waitMs: 60_000,
      sleepFn: async () => { sleeps += 1; }, nowFn: () => 1,
    });
    assert.equal(r.readiness, "ambiguous", "不再投影成 waiting_for_verification");
    assert.equal(r.waitReturnedEarly, true);
    assert.equal(sleeps, 0, "不进等待循环（MCP 适配层也就不会附继续等待的 nextStep）");
  } finally {
    cleanupDir(dir);
  }
});
