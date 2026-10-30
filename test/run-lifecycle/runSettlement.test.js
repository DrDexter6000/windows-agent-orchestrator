// test/run-lifecycle/runSettlement.test.js
//
// 决定 0095（第 49 批）：收口判定纯函数 determineRunSettlement 的分支覆盖，
// 外加 vitalSignAgeMs（runQuietAdvisory 的共享体征年龄函数）的毫秒级边界。
// 全部确定性、纯内存事件数组（零 I/O、零时钟注入——年龄由调用方传 ms）。
//
// 收口语义钉：settled 只保证"运行已终态；有交付时验证与 reverify 都已有结果"
//——不含验证通过、不含 Lead 已验收、不含 WAO 收尾完成。

import { test } from "node:test";
import assert from "node:assert/strict";

import { determineRunSettlement } from "../../src/application/runSettlement.js";
import { vitalSignAgeMs, VITAL_SIGN_RECENT_SECONDS, LEAD_ADVISORY_QUIET_SECONDS } from "../../src/application/runQuietAdvisory.js";
import { runWaitNextStep } from "../../src/application/runNextStep.js";

// ===== 事件夹具（envelope 形状与生产追加器一致；DeliveryRef 形状取自
// m11-10-readiness.test.js 的 makeRef 家族） =====

const BASE = "b".repeat(40);
const DELIVERED = "d".repeat(40);

function startedWithDelivery(runId) {
  return {
    type: "run.started",
    runId,
    agentId: "coder_low",
    backend: "claude-code",
    cwd: "D:/fake/ws",
    delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] },
  };
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

function makeVerifiedRef(runId, status) {
  const verification = status === "failed"
    ? { status, failureCode: "command_failed", commands: [], verifiedCommit: DELIVERED, results: [] }
    : status === "unavailable"
      ? { status, unavailableReason: "env gone", commands: [], verifiedCommit: DELIVERED, results: [] }
      : { status, commands: [], verifiedCommit: DELIVERED, results: [] };
  return makeRef(runId, { verification });
}

function created(runId, ref = makeRef(runId)) {
  return { type: "run.delivery_created", runId, agentId: "coder_low", delivery: ref };
}

function outcome(runId, status) {
  return {
    type: `run.delivery_verification_${status}`,
    runId,
    agentId: "coder_low",
    delivery: makeVerifiedRef(runId, status),
  };
}

function pendingRejected(runId, ref = makeRef(runId)) {
  return {
    type: "run.delivery_rejected",
    runId,
    agentId: "coder_low",
    delivery: { ...ref, acceptance: { status: "rejected", reviewerType: "lead_agent" } },
    deliveryCommit: ref.deliveryCommit,
    reason: "settling without an outcome",
  };
}

function decided(runId, decision, ref) {
  return {
    type: decision === "accepted" ? "run.delivery_accepted" : "run.delivery_rejected",
    runId,
    agentId: "coder_low",
    delivery: { ...ref, acceptance: { status: decision, reviewerType: "lead_agent" } },
    deliveryCommit: ref.deliveryCommit,
    reason: "test decision",
  };
}

function reverifyRequested(runId, ref, attempt = 1) {
  return {
    type: "run.delivery_reverification_requested",
    runId,
    agentId: "coder_low",
    delivery: ref,
    deliveryCommit: ref.deliveryCommit,
    reason: "tooling_invalid",
    ...(attempt !== 1 ? { attempt } : {}),
  };
}

function reverifyOutcome(runId, ref, status) {
  const verification = status === "failed"
    ? { status, failureCode: "command_timeout", commands: [], verifiedCommit: ref.deliveryCommit, results: [] }
    : { status, commands: [], verifiedCommit: ref.deliveryCommit, results: [] };
  return {
    type: `run.delivery_reverification_${status}`,
    runId,
    agentId: "coder_low",
    delivery: { ...ref, verification },
    deliveryCommit: ref.deliveryCommit,
  };
}

function terminal(runId, state = "completed") {
  return [
    { type: "run.state_change", runId, agentId: "coder_low", from: "running", to: state, reason: "done" },
  ];
}

function running(runId) {
  return [
    { type: "run.state_change", runId, agentId: "coder_low", from: "pending", to: "running", reason: "first_event" },
  ];
}

function events(...rows) {
  return rows.flat();
}

// ===== 七.1 收口判定分支 =====

test("SETTLE-01: 未终态 → unsettled（not_terminal）", () => {
  const runId = "run_s01";
  const r = determineRunSettlement(events(startedWithDelivery(runId), running(runId)), runId);
  assert.equal(r.status, "unsettled");
  assert.equal(r.reason, "not_terminal");
  assert.equal(r.facts.terminal, false);
});

test("SETTLE-02: 未终态的等待打包形状（终态后才是 ambiguous）→ unsettled，与终态对照", () => {
  const runId = "run_s02";
  const base = events(startedWithDelivery(runId), running(runId));
  // 未终态 + 请求了交付 + 无 created/failed：正常等待打包。
  const nonTerminal = determineRunSettlement(base, runId);
  assert.equal(nonTerminal.status, "unsettled");
  assert.equal(nonTerminal.reason, "not_terminal");
  // 同一形状在终态后：断链，undeterminable（terminal_delivery_ambiguous）。
  const terminalVersion = determineRunSettlement(events(startedWithDelivery(runId), running(runId), terminal(runId)), runId);
  assert.equal(terminalVersion.status, "undeterminable");
  assert.equal(terminalVersion.reason, "terminal_delivery_ambiguous");
});

test("SETTLE-03: 终态未请求交付 → settled（no_delivery_requested）", () => {
  const runId = "run_s03";
  const r = determineRunSettlement(events(
    { type: "run.started", runId, agentId: "coder_low", backend: "claude-code", cwd: "D:/fake/ws" },
    running(runId),
    terminal(runId),
  ), runId);
  assert.equal(r.status, "settled");
  assert.equal(r.reason, "no_delivery_requested");
  assert.equal(r.facts.deliveryRequested, false);
});

test("SETTLE-04: 打包失败 → settled（packaging_failed）", () => {
  const runId = "run_s04";
  const r = determineRunSettlement(events(
    startedWithDelivery(runId),
    running(runId),
    terminal(runId, "failed"),
    { type: "run.delivery_failed", runId, agentId: "coder_low", deliveryCode: "backend_error" },
  ), runId);
  assert.equal(r.status, "settled");
  assert.equal(r.reason, "packaging_failed");
});

test("SETTLE-05: 打包失败多条 → undeterminable（packaging_conflict）", () => {
  const runId = "run_s05";
  const r = determineRunSettlement(events(
    startedWithDelivery(runId),
    running(runId),
    terminal(runId, "failed"),
    { type: "run.delivery_failed", runId, agentId: "coder_low", deliveryCode: "backend_error" },
    { type: "run.delivery_failed", runId, agentId: "coder_low", deliveryCode: "command_failed" },
  ), runId);
  assert.equal(r.status, "undeterminable");
  assert.equal(r.reason, "packaging_conflict");
});

test("SETTLE-06: 隔离失败（workdir_escape）→ settled（isolation_failed）", () => {
  const runId = "run_s06";
  const r = determineRunSettlement(events(
    startedWithDelivery(runId),
    running(runId),
    terminal(runId, "failed"),
    { type: "run.isolation_violation", runId, agentId: "coder_low", code: "workdir_escape", reason: "file_written_outside" },
  ), runId);
  assert.equal(r.status, "settled");
  assert.equal(r.reason, "isolation_failed");
});

test("SETTLE-07: 事实校验 malformed（两条 delivery_created）→ undeterminable（delivery_facts_malformed）", () => {
  const runId = "run_s07";
  const ref = makeRef(runId);
  const r = determineRunSettlement(events(
    startedWithDelivery(runId),
    running(runId),
    terminal(runId),
    created(runId, ref),
    created(runId, ref),
  ), runId);
  assert.equal(r.status, "undeterminable");
  assert.equal(r.reason, "delivery_facts_malformed");
});

test("SETTLE-08: 交付已创建、验证 pending、无决定 → unsettled（verification_pending）", () => {
  const runId = "run_s08";
  const r = determineRunSettlement(events(
    startedWithDelivery(runId),
    running(runId),
    terminal(runId),
    created(runId),
  ), runId);
  assert.equal(r.status, "unsettled");
  assert.equal(r.reason, "verification_pending");
  assert.equal(r.facts.verificationStatus, "pending");
  assert.equal(r.facts.acceptanceStatus, "pending");
});

test("SETTLE-09: 验证中拒收（pending + 已拒收决定）→ 仍 unsettled（verification_pending）——已有决定也要等验证结果", () => {
  const runId = "run_s09";
  const ref = makeRef(runId);
  const r = determineRunSettlement(events(
    startedWithDelivery(runId),
    running(runId),
    terminal(runId),
    created(runId, ref),
    pendingRejected(runId, ref),
  ), runId);
  assert.equal(r.status, "unsettled");
  assert.equal(r.reason, "verification_pending");
  assert.equal(r.facts.verificationStatus, "pending");
  assert.equal(r.facts.acceptanceStatus, "rejected");
});

test("SETTLE-10: 交付已创建、验证有结果 → settled（delivery_settled）", () => {
  for (const status of ["passed", "failed", "unavailable"]) {
    const runId = `run_s10_${status}`;
    const r = determineRunSettlement(events(
      startedWithDelivery(runId),
      running(runId),
      terminal(runId),
      created(runId),
      outcome(runId, status),
    ), runId);
    assert.equal(r.status, "settled", status);
    assert.equal(r.reason, "delivery_settled", status);
    assert.equal(r.facts.verificationStatus, status);
  }
});

test("SETTLE-11: 已决定（accepted/rejected）且验证有结果 → settled，facts 记录决定", () => {
  for (const decision of ["accepted", "rejected"]) {
    const runId = `run_s11_${decision}`;
    const verified = makeVerifiedRef(runId, "passed");
    const r = determineRunSettlement(events(
      startedWithDelivery(runId),
      running(runId),
      terminal(runId),
      created(runId, verified),
      outcome(runId, "passed"),
      decided(runId, decision, verified),
    ), runId);
    assert.equal(r.status, "settled", decision);
    assert.equal(r.facts.acceptanceStatus, decision);
  }
});

test("SETTLE-12: reverify pending → unsettled；reverify complete → settled", () => {
  const pendingId = "run_s12a";
  const a = determineRunSettlement(events(
    startedWithDelivery(pendingId),
    running(pendingId),
    terminal(pendingId),
    created(pendingId),
    outcome(pendingId, "failed"),
    reverifyRequested(pendingId, makeVerifiedRef(pendingId, "failed")),
  ), pendingId);
  assert.equal(a.status, "unsettled");
  assert.equal(a.reason, "reverify_pending");
  assert.equal(a.facts.reverifyStatus, "pending");

  const completeId = "run_s12b";
  const failedRef = makeVerifiedRef(completeId, "failed");
  const b = determineRunSettlement(events(
    startedWithDelivery(completeId),
    running(completeId),
    terminal(completeId),
    created(completeId, failedRef),
    outcome(completeId, "failed"),
    reverifyRequested(completeId, failedRef),
    reverifyOutcome(completeId, failedRef, "passed"),
  ), completeId);
  assert.equal(b.status, "settled");
  assert.equal(b.reason, "delivery_settled");
  assert.equal(b.facts.reverifyStatus, "complete");
});

test("SETTLE-13: 有 created 的 reverify malformed（valid:true 形状）→ undeterminable", () => {
  const runId = "run_s13";
  const failedRef = makeVerifiedRef(runId, "failed");
  // 两条 requested 无 outcome = 断链（pairReverifyLinks malformed），但原验证
  // 有效——validateDeliveryFacts 仍 valid:true。
  const r = determineRunSettlement(events(
    startedWithDelivery(runId),
    running(runId),
    terminal(runId),
    created(runId, failedRef),
    outcome(runId, "failed"),
    reverifyRequested(runId, failedRef),
    reverifyRequested(runId, failedRef),
  ), runId);
  assert.equal(r.status, "undeterminable");
  assert.equal(r.reason, "reverify_malformed");
  assert.equal(r.facts.verificationStatus, "failed", "原验证有结果，但 reverify 断链不可判");
});

test("SETTLE-14: 孤立 reverify 链（无 delivery_created）→ undeterminable（orphan_reverify_chain）", () => {
  const runId = "run_s14";
  const r = determineRunSettlement(events(
    startedWithDelivery(runId),
    running(runId),
    terminal(runId),
    reverifyRequested(runId, makeRef(runId)),
  ), runId);
  assert.equal(r.status, "undeterminable");
  assert.equal(r.reason, "orphan_reverify_chain");
});

test("SETTLE-15: 防御形状——非数组事件 → undeterminable（invalid_snapshot）", () => {
  const r = determineRunSettlement(null, "run_s15");
  assert.equal(r.status, "undeterminable");
  assert.equal(r.reason, "invalid_snapshot");
});

test("SETTLE-16: legacy createdRef（验证状态缺席）→ unsettled（verification_pending）", () => {
  const runId = "run_s16";
  const legacyRef = makeRef(runId);
  delete legacyRef.verification;
  const r = determineRunSettlement(events(
    startedWithDelivery(runId),
    running(runId),
    terminal(runId),
    created(runId, legacyRef),
  ), runId);
  assert.equal(r.status, "unsettled");
  assert.equal(r.reason, "verification_pending");
});

test("SETTLE-17: 原始验证尚无结果却已有 reverify 事实 → undeterminable（legacy ref 与显式 pending 两形）", () => {
  // legacy ref（无 verification 字段）：validateDeliveryFacts 给 unavailable，
  // 不检查 reverify——收口判定必须自己补查，否则会把断链当作"等验证"永远等。
  const legacyId = "run_s17a";
  const legacyRef = makeRef(legacyId);
  delete legacyRef.verification;
  const a = determineRunSettlement(events(
    startedWithDelivery(legacyId),
    running(legacyId),
    terminal(legacyId),
    created(legacyId, legacyRef),
    reverifyRequested(legacyId, legacyRef),
    reverifyRequested(legacyId, legacyRef),
  ), legacyId);
  assert.equal(a.status, "undeterminable");
  assert.equal(a.reason, "delivery_facts_malformed");

  // 显式 pending 的 ref：权威本身判 malformed，结果相同。
  const pendingId = "run_s17b";
  const b = determineRunSettlement(events(
    startedWithDelivery(pendingId),
    running(pendingId),
    terminal(pendingId),
    created(pendingId),
    reverifyRequested(pendingId, makeRef(pendingId)),
  ), pendingId);
  assert.equal(b.status, "undeterminable");
  assert.equal(b.reason, "delivery_facts_malformed");
});

test("SETTLE-18: attempt-2 reverify 仍 pending → unsettled（取最新链）；有结果 → settled", () => {
  const runId = "run_s18";
  const failedRef = makeVerifiedRef(runId, "failed");
  const rows = [
    startedWithDelivery(runId),
    running(runId),
    terminal(runId),
    created(runId, failedRef),
    outcome(runId, "failed"),
    reverifyRequested(runId, failedRef),
    reverifyOutcome(runId, failedRef, "failed"),
    reverifyRequested(runId, failedRef, 2),
  ];
  const a = determineRunSettlement(events(...rows), runId);
  assert.equal(a.status, "unsettled");
  assert.equal(a.reason, "reverify_pending");
  const b = determineRunSettlement(events(...rows, reverifyOutcome(runId, failedRef, "passed")), runId);
  assert.equal(b.status, "settled");
  assert.equal(b.reason, "delivery_settled");
});

test("SETTLE-19: 打包失败后 repackage 恢复——旧 failed 不提前收口；新验证等到结果才收口", () => {
  const runId = "run_s19";
  const ref = makeRef(runId, { changedFiles: ["root.txt", "src/a.js"] });
  const pre = [
    { type: "run.background_submitted", runId, deliveryRequested: true },
    { type: "run.started", runId, delivery: { mode: "git_commit_v1", baseCommit: BASE, allowedPaths: ["src"], verificationCommands: ["npm test"] } },
    { type: "run.delivery_failed", runId, deliveryCode: "disallowed_path" },
    { type: "run.state_change", runId, from: "running", to: "failed", reason: "delivery_failed" },
  ];
  assert.equal(determineRunSettlement(pre, runId).reason, "packaging_failed");
  const recovered = pre.concat([
    created(runId, ref),
    { type: "run.delivery_repackaged", runId, delivery: ref, approvedAllowedPaths: ["root.txt", "src"], source: "packaged" },
  ]);
  const waiting = determineRunSettlement(recovered, runId);
  assert.equal(waiting.status, "unsettled");
  assert.equal(waiting.reason, "verification_pending");
  const done = determineRunSettlement(recovered.concat([outcome(runId, "passed")]), runId);
  assert.equal(done.status, "settled");
  assert.equal(done.reason, "delivery_settled");
});

test("SETTLE-20: 隔离证据 ambiguous（两条违例、未知 code）→ 不提升为隔离失败收口", () => {
  for (const [label, violations] of [
    ["two", [{ code: "workdir_escape" }, { code: "workdir_escape" }]],
    ["unknown code", [{ code: "something_else" }]],
  ]) {
    const runId = `run_s20_${label.replace(" ", "_")}`;
    const r = determineRunSettlement(events(
      startedWithDelivery(runId),
      running(runId),
      terminal(runId, "failed"),
      violations.map((v) => ({ type: "run.isolation_violation", runId, agentId: "coder_low", ...v })),
    ), runId);
    assert.equal(r.status, "undeterminable", label);
    assert.equal(r.reason, "terminal_delivery_ambiguous", label);
  }
});

test("SETTLE-21: 外 run 信封的 reverify 事实也算断链（与 reverify 投影同一保守口径）", () => {
  // 无 created：外 run 的 reverify 事实 → 孤立链。
  const orphanId = "run_s21a";
  const a = determineRunSettlement(events(
    startedWithDelivery(orphanId),
    running(orphanId),
    terminal(orphanId),
    reverifyRequested("run_other", makeRef("run_other")),
  ), orphanId);
  assert.equal(a.reason, "orphan_reverify_chain");
  // 有 created 且原验证有结果：外 run 的 reverify 事实让本 run 的链 malformed。
  const chainId = "run_s21b";
  const failedRef = makeVerifiedRef(chainId, "failed");
  const b = determineRunSettlement(events(
    startedWithDelivery(chainId),
    running(chainId),
    terminal(chainId),
    created(chainId, failedRef),
    outcome(chainId, "failed"),
    reverifyRequested("run_other", makeVerifiedRef("run_other", "failed")),
  ), chainId);
  assert.equal(b.status, "undeterminable");
  assert.equal(b.reason, "reverify_malformed");
});

// ===== 七.2 vitalSignAgeMs（毫秒级边界） =====

test("VITAL-01: 最后一条 worker run.event（含 runtime_activity）的年龄；无 worker 事件 → null", () => {
  const now = 1_700_000_000_000;
  const ts = new Date(now - 60_000).toISOString();
  assert.equal(vitalSignAgeMs([{ type: "run.event", kind: "runtime_activity", ts }], now), 60_000);
  assert.equal(vitalSignAgeMs([{ type: "run.metrics" }], now), null, "run.metrics 不是体征");
});

test("VITAL-02: 非有限时间戳 → null；未来时间钳成 0", () => {
  const now = 1_700_000_000_000;
  assert.equal(vitalSignAgeMs([{ type: "run.event", kind: "message", ts: "not-a-date" }], now), null);
  assert.equal(vitalSignAgeMs([{ type: "run.event", kind: "message", ts: new Date(now + 5_000).toISOString() }], now), 0);
  assert.equal(vitalSignAgeMs([{ type: "run.event", kind: "message", ts: new Date(now).toISOString() }], NaN), null, "now 非有限 → null");
});

test("VITAL-03: 10 分钟与 30 分钟边界毫秒级判定（9 分 59.5 秒仍算 recent；恰好 10 分钟不算；恰好 30 分钟已算 quiet）", () => {
  const now = 1_700_000_000_000;
  const at = (ms) => [{ type: "run.event", kind: "message", ts: new Date(now - ms).toISOString() }];
  const RECENT = VITAL_SIGN_RECENT_SECONDS * 1000;
  const QUIET = LEAD_ADVISORY_QUIET_SECONDS * 1000;
  assert.equal(vitalSignAgeMs(at(RECENT - 500), now), RECENT - 500, "9 分 59.5 秒 → 599500ms");
  assert.equal(vitalSignAgeMs(at(RECENT), now), RECENT, "恰好 10 分钟 → 600000ms");
  assert.equal(vitalSignAgeMs(at(QUIET), now), QUIET, "恰好 30 分钟 → 1800000ms");
  // 分支口径：<10min recent；10–30min ageing；≥30min quiet（runWaitNextStep）。
  const step = (ms) => runWaitNextStep({ surface: "cli", terminal: false, vitalSignAgeMs: ms, runId: "run_v3" });
  assert.match(step(RECENT - 500), /Signs of life were last observed 9 min ago/, "9:59.5 → recent 分支（floor 到 9 分）");
  assert.match(step(RECENT), /may be inside a long-running command/, "恰好 10 分钟 → ageing 分支");
  assert.match(step(QUIET), /No new signs of life in the transcript for 30 min/, "恰好 30 分钟 → quiet 分支");
});
