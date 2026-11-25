// test/application/ownerAttention.test.js
//
// 第 140c 批（决定 0131）：Owner 看板的事项推导 deriveOwnerAttention，以及同源的两个纯
// 选择函数——Workers 默认范围（selectOwnerWorkers）与车道汇总（ownerLanes）。
//
// 夹具纪律：全部用手写的快照对象（形状取自 ownerReadModel.snapshot 的返回值），不读盘、
// 不调 git、不起服务；时间一律是 NOW 之前的相对时刻，所以每个阈值都有"恰好不越过 /
// 越过一毫秒"两侧的用例。
//
// 覆盖面（每条声称对应一个能证伪它的用例）：
//   - consult_split：不一致 / FIX_FIRST 成立；一致、Q1 全空、未声明 Q1、找不到被审运行
//     不成立；裁决 / 被取代解除；解除不了也确认不了时是 unknown
//   - 交付验证类：failed / unavailable 成立且 unavailable 不当作通过；passed、pending 不
//     成立（pending 计入 verifying）；复验通过、裁决、被取代三种解除；收口判定不清
//   - delivery_ambiguous：有交付记录（commit 读得到或 ambiguous 为真）才成立；没有交付记录
//     的失败 / 中止运行不算交付事项，也不进 Workers 默认范围
//   - awaiting_decision：超过 2 小时才列；取代判定不了时照样列但标 unknown；收口时刻读不
//     到时是 unknown
//   - branchPresent 三值：true 才列；false 不列（已裁决的也不进 resolved）；null 不列、
//     计入 deliveryUnobservable
//   - 额度：按车道键分组取最后一次观测；quota_exhausted 进 decide、rate_limited / overloaded
//     进 anomalies，都带 capacityCode；同一运行的 failed 异常照留；后续成功解除；证据最多
//     带最新 10 次观测（按观测时刻升序，解除证据附在末尾）；6 小时与 24 小时两侧；车道键
//     回退 agentId；没有车道键、观测时刻读不到不成立
//   - 24 小时窗口按种类：failed 与额度未了结项按证据时刻；交付类与会审事项不设年龄窗口；
//     已了结一律按 resolvedAt（失败 / 额度证据多老都不影响已了结栏）
//   - failed：后续成功（同谱系 / retryOf，且 startedAt >= 失败 terminalAt；并发兄弟不算）、
//     裁决解除；后续在跑与看不到后续两种 followUp（running 同样只认失败之后才开始的运行）；
//     只给 failure.{category, code}
//   - silent / process_only：超过 30 分钟才列；只有现时状态，不进 resolved
//   - 项目归属：projectSlugs（会审含会审所在项目与被审运行项目，其余含全部 runIds 的项目）；
//     Workers 的 attentionIds 与 /api/attention 同一筛选
//   - 读不到的运行不产生任何事项；稳定 id；kind / state / resolution / followUp 的闭集（每一种
//     都真的会出现）；resolved 的 24 小时窗口与排序；counts 与列表一致；标题取谱系根；
//     Workers 默认范围与排序；车道汇总

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  OWNER_ATTENTION_ANOMALY_KINDS,
  OWNER_ATTENTION_CAPACITY_EVIDENCE_MAX,
  OWNER_ATTENTION_CAPACITY_FRESH_MS,
  OWNER_ATTENTION_DECIDE_AFTER_MS,
  OWNER_ATTENTION_DECIDE_KINDS,
  OWNER_ATTENTION_FOLLOW_UPS,
  OWNER_ATTENTION_KINDS,
  OWNER_ATTENTION_QUIET_AFTER_MS,
  OWNER_ATTENTION_RESOLUTIONS,
  OWNER_ATTENTION_STATES,
  OWNER_ATTENTION_WINDOW_MS,
  deriveOwnerAttention,
  ownerLanes,
  selectOwnerWorkers,
} from "../../src/application/ownerAttention.js";

// ===== 夹具 =====

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;
/** NOW 之前 ms 毫秒的 ISO 时刻。 */
const ago = (ms) => new Date(NOW - ms).toISOString();
const ALPHA = { slug: "alpha", name: "Alpha", repo: "available", branchesObservedAt: ago(0), consultRecords: "available" };
const BETA = { slug: "beta", name: "Beta", repo: "available", branchesObservedAt: ago(0), consultRecords: "available" };
const NONE = { status: "none", reason: null };
const LANE = { laneId: "glm-pro", agentId: "glm-pro" };

/** 一个"读得出"的运行行；缺省是已完成的根运行。字段集与 ownerReadModel.projectRun 一致。 */
function run(overrides = {}) {
  const runId = overrides.runId ?? "run_a";
  return {
    runId,
    project: { slug: "alpha", name: "Alpha" },
    availability: "ok",
    state: "completed",
    terminal: true,
    liveness: "terminal",
    stage: "terminal",
    agentId: "glm-pro",
    laneId: "glm-pro",
    roleId: "coder",
    readOnly: false,
    deliveryRequested: true,
    title: `任务 ${runId}`,
    titleBasis: "first_line",
    taskType: "code",
    typeBasis: "persisted",
    startedAt: ago(5 * HOUR),
    terminalAt: ago(4 * HOUR),
    stageSince: ago(5 * HOUR),
    lastEffectAt: ago(4 * HOUR),
    quietSince: ago(5 * HOUR),
    lastVitalAt: ago(4 * HOUR),
    lastProcessActiveAt: null,
    retryOf: null,
    parentRunId: null,
    delivery: null,
    failure: null,
    capacity: null,
    lineageRootRunId: runId,
    lineageRootConflict: false,
    supersessionUndeterminable: false,
    legalDecision: null,
    supersededByRunId: null,
    ...overrides,
  };
}

/** 读不出的运行行（availability 非 ok 时读模型给的全部空值形状）。 */
const unreadable = (overrides = {}) => run({
  availability: "unreadable", project: null, state: null, terminal: null, liveness: "unknown", stage: "stage_unknown",
  agentId: null, laneId: null, roleId: null, readOnly: null, deliveryRequested: null, title: null, titleBasis: null,
  taskType: null, typeBasis: null, startedAt: null, terminalAt: null, stageSince: null, lastEffectAt: null,
  quietSince: null, lastVitalAt: null, lastProcessActiveAt: null, retryOf: null, parentRunId: null, delivery: null,
  failure: null, capacity: null, lineageRootRunId: null, lineageRootConflict: null, supersessionUndeterminable: null,
  legalDecision: null, supersededByRunId: null,
  ...overrides,
});

/** 一个仍在跑的运行。 */
const live = (overrides = {}) => run({
  state: "running", terminal: false, liveness: "progress", stage: "active", deliveryRequested: false,
  ...overrides,
});

/** 交付事实（projectDelivery 的形状）；缺省是验证通过、待裁决、分支还在的已收口交付。 */
function delivered(overrides = {}) {
  return {
    settlement: { status: "settled", reason: "delivery_settled" },
    commit: "c".repeat(40),
    verification: { status: "passed", reverify: NONE },
    acceptance: { status: "pending", decidedAt: null },
    settledAt: ago(4 * HOUR),
    ambiguous: false,
    packagingFailure: null,
    isolationFailure: null,
    branchPresent: true,
    ...overrides,
  };
}
const FAILED_VERIFICATION = { status: "failed", reverify: NONE };
/** 刚收口不到 2 小时的交付：不触发"等裁决"，用在只关心别的事项的用例里。 */
const fresh = (overrides = {}) => delivered({ settledAt: ago(HOUR), ...overrides });

/** 一个失败的运行（没有交付、没有额度证据）。 */
const failedRun = (overrides = {}) => run({
  state: "failed",
  failure: { category: "provider_error", code: "backend_error" },
  deliveryRequested: false,
  ...overrides,
});

/** 一次额度观测：失败的运行带着 capacity 事实。 */
const exhausted = (lane, observedAgoMs, overrides = {}) => failedRun({
  failure: { category: "provider_capacity", code: "quota_exhausted" },
  capacity: { code: "quota_exhausted", observedAt: ago(observedAgoMs) },
  laneId: lane.laneId,
  agentId: lane.agentId,
  ...overrides,
});

function consult(overrides = {}) {
  return {
    consultId: "consult_1",
    projectSlug: "alpha",
    createdAt: ago(3 * HOUR),
    reviewedRunId: "run_rev",
    q1Declared: true,
    seats: [],
    ...overrides,
  };
}
const seat = (runId, q1) => ({ agentId: "seat", runId, runState: q1 === null ? "running" : "completed", q1 });

function snapshot(runs, consults = [], projects = [ALPHA]) {
  return { generatedAt: ago(0), projects, runs, consults };
}

const derive = (snap, now = NOW) => deriveOwnerAttention(snap, { now });
const ids = (items) => items.map((item) => item.id);
const kinds = (items) => items.map((item) => item.kind);
const byId = (items, id) => items.find((item) => item.id === id) ?? null;
/** 一份结果的骨架：未了结事项的 id 与状态、已了结事项的解除依据与时刻。 */
const outcome = (out) => ({
  decide: out.decide.map((item) => [item.id, item.state]),
  anomalies: out.anomalies.map((item) => [item.id, item.state]),
  resolved: out.resolved.map((item) => [item.id, item.resolution, item.resolvedAt]),
});
/** "这件事不成立"：三栏都没有它。 */
const nowhere = (out, id) => assert.deepEqual(
  [...out.decide, ...out.anomalies, ...out.resolved].filter((item) => item.id === id), [], id,
);

// =====================================================================
// 阈值是导出的常量（待校准）
// =====================================================================
test("阈值常量：等裁决 2 小时、额度证据 6 小时、静默 30 分钟、窗口 24 小时、额度证据最多 10 条", () => {
  assert.equal(OWNER_ATTENTION_DECIDE_AFTER_MS, 2 * HOUR);
  assert.equal(OWNER_ATTENTION_CAPACITY_FRESH_MS, 6 * HOUR);
  assert.equal(OWNER_ATTENTION_QUIET_AFTER_MS, 30 * MINUTE);
  assert.equal(OWNER_ATTENTION_WINDOW_MS, 24 * HOUR);
  assert.equal(OWNER_ATTENTION_CAPACITY_EVIDENCE_MAX, 10);
});

// =====================================================================
// consult_split — 交付会审结论不一致
// =====================================================================
test("consult_split: 各席 Q1 不一致 → 挂在被审运行上的 open 事项，证据是给出结论的席位", () => {
  const snap = snapshot(
    [
      run({ runId: "run_rev", title: "被审交付", delivery: fresh() }),
      run({ runId: "run_s1", title: "席 A", delivery: null, deliveryRequested: false, terminalAt: ago(2 * HOUR) }),
      run({ runId: "run_s2", title: "席 B", delivery: null, deliveryRequested: false, terminalAt: ago(HOUR) }),
    ],
    [consult({ seats: [seat("run_s1", "PASS"), seat("run_s2", "PASS_WITH_NOTES")] })],
  );
  const out = derive(snap);
  assert.deepEqual(out.decide, [{
    id: "consult_split:alpha:consult_1",
    kind: "consult_split",
    state: "open",
    runIds: ["run_rev"],
    projectSlugs: ["alpha"],
    since: ago(3 * HOUR),
    evidence: [
      { runId: "run_s1", at: ago(2 * HOUR), seq: null },
      { runId: "run_s2", at: ago(HOUR), seq: null },
    ],
  }]);
  assert.deepEqual(out.anomalies, []);
  assert.deepEqual(out.resolved, []);
});

test("consult_split: 有一席判 FIX_FIRST 就成立（哪怕只有一席给了结论）；结论一致不成立", () => {
  const snap = (seats) => snapshot([run({ runId: "run_rev", delivery: fresh() })], [consult({ seats })]);
  const oneSeat = derive(snap([seat(null, "FIX_FIRST")]));
  assert.deepEqual(kinds(oneSeat.decide), ["consult_split"]);
  assert.deepEqual(oneSeat.decide[0].evidence, [], "席位没有可指的运行就没有证据条目，但结论照样参与判定");
  assert.deepEqual(kinds(derive(snap([seat("run_s1", "PASS"), seat("run_s2", "PASS"), seat("run_s3", "PASS")])).decide), []);
  assert.deepEqual(kinds(derive(snap([seat("run_s1", "PASS_WITH_NOTES"), seat("run_s2", "PASS_WITH_NOTES")])).decide), []);
});

test("consult_split: Q1 为 null 的席位不参与判定，也不进证据；全部为 null 不成立", () => {
  // 一席 PASS、一席还没给结论：参与判定的席位一致。
  const consistent = derive(snapshot([run({ runId: "run_rev", delivery: fresh() })], [consult({
    seats: [seat("run_s1", "PASS"), seat("run_s2", null)],
  })]));
  assert.deepEqual(consistent.decide, []);
  // 参与的席位不一致时，证据里只有给了结论的那几席；席位运行不在快照里，时刻如实为 null。
  const split = derive(snapshot([run({ runId: "run_rev", delivery: fresh() })], [consult({
    seats: [seat("run_s1", "PASS"), seat("run_s2", null), seat("run_s3", "FIX_FIRST")],
  })]));
  assert.deepEqual(split.decide[0].evidence, [
    { runId: "run_s1", at: null, seq: null },
    { runId: "run_s3", at: null, seq: null },
  ]);
  // 没有任何席位给出结论：无从判定，不成立。
  const silent = derive(snapshot([run({ runId: "run_rev", delivery: fresh() })], [consult({
    seats: [seat("run_s1", null), seat(null, null)],
  })]));
  assert.deepEqual(silent.decide, []);
  assert.deepEqual(silent.resolved, []);
});

test("consult_split: 不是交付会审（没有被审运行 / 未声明 Q1）或被审运行不在快照里 → 不成立", () => {
  const seats = [seat("run_s1", "PASS"), seat("run_s2", "FIX_FIRST")];
  const reviewed = run({ runId: "run_rev", delivery: fresh() });
  for (const consultRow of [consult({ seats, reviewedRunId: null }), consult({ seats, q1Declared: false }), consult({ seats, q1Declared: null })]) {
    nowhere(derive(snapshot([reviewed], [consultRow])), "consult_split:alpha:consult_1");
  }
  nowhere(derive(snapshot([run({ runId: "run_other" })], [consult({ seats })])), "consult_split:alpha:consult_1");
  // 被审运行在快照里但读不出：没有交付事实可挂，同样不成立。
  nowhere(derive(snapshot([unreadable({ runId: "run_rev" })], [consult({ seats })])), "consult_split:alpha:consult_1");
});

test("consult_split: 被审运行已裁决 → resolved / decided，resolvedAt 是裁决时间", () => {
  const out = derive(snapshot(
    [run({ runId: "run_rev", delivery: fresh({ acceptance: { status: "accepted", decidedAt: ago(HOUR) } }) })],
    [consult({ seats: [seat("run_s1", "PASS"), seat("run_s2", "FIX_FIRST")] })],
  ));
  assert.deepEqual(out.decide, []);
  assert.deepEqual(out.resolved, [{
    id: "consult_split:alpha:consult_1",
    kind: "consult_split",
    state: "resolved",
    runIds: ["run_rev"],
    projectSlugs: ["alpha"],
    since: ago(3 * HOUR),
    resolvedAt: ago(HOUR),
    resolution: "decided",
    evidence: [
      { runId: "run_s1", at: null, seq: null },
      { runId: "run_s2", at: null, seq: null },
      { runId: "run_rev", at: ago(HOUR), seq: null },
    ],
  }]);
});

test("consult_split: 被审运行已被取代 → resolved / superseded，resolvedAt 取取代者的裁决时间，取不到为 null", () => {
  const reviewed = run({
    runId: "run_rev",
    delivery: fresh({ acceptance: { status: "pending", decidedAt: null } }),
    supersededByRunId: "run_child",
  });
  const seats = [seat("run_s1", "PASS"), seat("run_s2", "FIX_FIRST")];
  const child = run({ runId: "run_child", lineageRootRunId: "run_rev", delivery: fresh({ acceptance: { status: "accepted", decidedAt: ago(30 * MINUTE) } }) });
  const out = derive(snapshot([reviewed, child], [consult({ seats })]));
  assert.deepEqual(out.decide, []);
  assert.deepEqual(outcome(out).resolved, [["consult_split:alpha:consult_1", "superseded", ago(30 * MINUTE)]]);
  assert.deepEqual(out.resolved[0].evidence.at(-1), { runId: "run_child", at: ago(30 * MINUTE), seq: null });
  // 取代者不在快照里：仍是 resolved，但 resolvedAt 取不到，不进"已了结"栏。
  const gone = derive(snapshot([reviewed], [consult({ seats })]));
  assert.deepEqual(gone.decide, []);
  assert.deepEqual(gone.resolved, []);
});

test("consult_split: 解除不了、也确认不了「仍未解除」→ state: unknown，绝不写成已了结", () => {
  const seats = [seat("run_s1", "PASS"), seat("run_s2", "FIX_FIRST")];
  // "是否已被取代"没能判定。
  const undeterminable = derive(snapshot([run({ runId: "run_rev", delivery: fresh(), supersessionUndeterminable: true })], [consult({ seats })]));
  assert.deepEqual(outcome(undeterminable).decide, [["consult_split:alpha:consult_1", "unknown"]]);
  assert.equal("resolution" in undeterminable.decide[0], false, "unknown 不带解除依据");
  // 裁决状态读不到（没有可裁决的交付视图）同样确认不了。
  const noAcceptance = run({ runId: "run_rev", delivery: fresh({ acceptance: { status: null, decidedAt: null } }) });
  assert.deepEqual(outcome(derive(snapshot([noAcceptance], [consult({ seats })]))).decide, [["consult_split:alpha:consult_1", "unknown"]]);
  assert.deepEqual(undeterminable.resolved, []);
});

test("项目归属: 会审事项含会审所在项目与被审运行的项目；Workers 的 attentionIds 与 /api/attention 同一筛选", () => {
  const seats = [seat("run_s1", "PASS"), seat("run_s2", "FIX_FIRST")];
  // 会审开在 beta，被审运行在 alpha。
  const snap = snapshot(
    [run({ runId: "run_rev", delivery: fresh() })],
    [consult({ projectSlug: "beta", seats })],
    [ALPHA, BETA],
  );
  const out = derive(snap);
  assert.deepEqual(out.decide[0].projectSlugs, ["alpha", "beta"], "去重排序：会审所在项目与被审运行的项目");
  // 被审运行在 alpha：alpha 的 Workers 行挂着它，attention 在 alpha 与 beta 下都查得到；
  // beta 没有这个运行的行，但事项本身在 beta 下可见。两个筛选下都不会"有 id 查不到"。
  assert.deepEqual(
    selectOwnerWorkers(snap, out, { now: NOW, project: "alpha" }).map((row) => [row.run.runId, row.attentionIds]),
    [["run_rev", ["consult_split:beta:consult_1"]]],
  );
  assert.deepEqual(selectOwnerWorkers(snap, out, { now: NOW, project: "beta" }), []);
  for (const slug of ["alpha", "beta"]) {
    assert.ok(out.decide.some((item) => item.projectSlugs.includes(slug)), slug);
  }
  // 不属于这个项目的运行进不了 Workers，事项也挂不上去。
  assert.deepEqual(selectOwnerWorkers(snap, out, { now: NOW, project: "gamma" }), []);
});

// =====================================================================
// 交付验证类 — verification_failed / verification_unavailable / delivery_ambiguous
// =====================================================================
test("verification_failed / verification_unavailable: 有效状态决定种类；unavailable 不当作通过", () => {
  const failed = derive(snapshot([run({ delivery: fresh({ verification: FAILED_VERIFICATION }) })]));
  assert.deepEqual(failed.decide, [{
    id: "verification_failed:run_a",
    kind: "verification_failed",
    state: "open",
    runIds: ["run_a"],
    projectSlugs: ["alpha"],
    since: ago(HOUR),
    evidence: [{ runId: "run_a", at: ago(HOUR), seq: null }],
  }]);
  const unavailable = derive(snapshot([run({ delivery: fresh({ verification: { status: "unavailable", reverify: NONE } }) })]));
  assert.deepEqual(outcome(unavailable), { decide: [["verification_unavailable:run_a", "open"]], anomalies: [], resolved: [] });
});

test("交付验证类: passed 不是事项；pending 不是事项、计入 verifying；没有验证事实不成立", () => {
  const passed = derive(snapshot([run({ delivery: fresh() })]));
  assert.deepEqual(passed.decide, []);
  assert.equal(passed.counts.verifying, 0);
  const pending = derive(snapshot([run({ delivery: delivered({ verification: { status: "pending", reverify: NONE }, settledAt: ago(HOUR) }) })]));
  assert.deepEqual(pending.decide, []);
  assert.equal(pending.counts.verifying, 1);
  // 打包失败：没有交付视图，验证与裁决都是 null——不成立，也不进 resolved，也不算"正在验证"。
  const packagingFailed = delivered({
    settlement: { status: "settled", reason: "packaging_failed" }, verification: null,
    acceptance: { status: null, decidedAt: null }, packagingFailure: "no_changes",
  });
  const out = derive(snapshot([run({ delivery: packagingFailed })]));
  assert.deepEqual(outcome(out), { decide: [], anomalies: [], resolved: [] });
  assert.equal(out.counts.verifying, 0);
});

test("交付验证类: 同一交付复验通过 → resolved / reverify_passed", () => {
  const out = derive(snapshot([run({ delivery: delivered({
    verification: { status: "passed", reverify: { status: "complete", reason: "tooling_invalid" } },
    settledAt: ago(HOUR),
  }) })]));
  assert.deepEqual(out.decide, []);
  assert.deepEqual(out.resolved, [{
    id: "verification_failed:run_a",
    kind: "verification_failed",
    state: "resolved",
    runIds: ["run_a"],
    projectSlugs: ["alpha"],
    since: ago(HOUR),
    resolvedAt: ago(HOUR),
    resolution: "reverify_passed",
    evidence: [{ runId: "run_a", at: ago(HOUR), seq: null }],
  }]);
  // 复验还在跑：有效状态仍是失败，事项照旧 open。
  const reverifying = derive(snapshot([run({ delivery: fresh({ verification: { status: "failed", reverify: { status: "pending", reason: null } } }) })]));
  assert.deepEqual(outcome(reverifying).decide, [["verification_failed:run_a", "open"]]);
  // 复验没通过（有效状态 unavailable）：按有效状态归 verification_unavailable，仍未了结。
  const reverted = derive(snapshot([run({ delivery: fresh({ verification: { status: "unavailable", reverify: { status: "complete", reason: "environment_contaminated" } } }) })]));
  assert.deepEqual(outcome(reverted).decide, [["verification_unavailable:run_a", "open"]]);
});

test("交付验证类: 已裁决 → resolved / decided；已被取代 → resolved / superseded", () => {
  const decided = derive(snapshot([run({ delivery: fresh({ verification: FAILED_VERIFICATION, acceptance: { status: "rejected", decidedAt: ago(HOUR) } }) })]));
  assert.deepEqual(outcome(decided), { decide: [], anomalies: [], resolved: [["verification_failed:run_a", "decided", ago(HOUR)]] });
  const superseded = derive(snapshot([
    run({ delivery: fresh({ verification: FAILED_VERIFICATION }), supersededByRunId: "run_child" }),
    run({ runId: "run_child", lineageRootRunId: "run_a", delivery: fresh({ acceptance: { status: "accepted", decidedAt: ago(HOUR) } }) }),
  ]));
  assert.deepEqual(outcome(superseded).resolved, [["verification_failed:run_a", "superseded", ago(HOUR)]]);
  assert.deepEqual(superseded.decide, []);
});

test("交付验证类: 取代判定不了 → unknown；裁决状态读不到 → unknown", () => {
  const undeterminable = derive(snapshot([run({ delivery: fresh({ verification: FAILED_VERIFICATION }), supersessionUndeterminable: true })]));
  assert.deepEqual(outcome(undeterminable).decide, [["verification_failed:run_a", "unknown"]]);
  const noAcceptance = derive(snapshot([run({ delivery: fresh({ verification: FAILED_VERIFICATION, acceptance: { status: null, decidedAt: null } }) })]));
  assert.deepEqual(outcome(noAcceptance).decide, [["verification_failed:run_a", "unknown"]]);
  assert.deepEqual(undeterminable.resolved, []);
  assert.deepEqual(noAcceptance.resolved, []);
});

test("delivery_ambiguous: 有交付记录且收口判定为 undeterminable / terminal_delivery_ambiguous 才成立；没有交付记录的不算", () => {
  const undeterminable = derive(snapshot([run({ delivery: delivered({
    settlement: { status: "undeterminable", reason: "delivery_facts_malformed" }, settledAt: null,
  }) })]));
  // 收口不清时读模型不给交付视图：裁决状态是 null，所以确认不了"仍未解除"→ unknown。
  const noView = delivered({
    settlement: { status: "undeterminable", reason: "terminal_delivery_ambiguous" }, settledAt: null,
    verification: null, acceptance: { status: null, decidedAt: null }, ambiguous: true,
  });
  assert.deepEqual(outcome(undeterminable).decide, [["delivery_ambiguous:run_a", "open"]]);
  assert.equal(undeterminable.decide[0].since, ago(4 * HOUR));
  assert.deepEqual(outcome(derive(snapshot([run({ delivery: noView })]))).decide, [["delivery_ambiguous:run_a", "unknown"]]);
  // 理由是 terminal_delivery_ambiguous 时不论 status 写的是什么都成立。
  assert.deepEqual(outcome(derive(snapshot([run({ delivery: { ...noView, settlement: { status: null, reason: "terminal_delivery_ambiguous" } } })]))).decide,
    [["delivery_ambiguous:run_a", "unknown"]]);
  // 有提交、收口不明（事实自相矛盾）→ 成立。
  assert.deepEqual(outcome(derive(snapshot([run({ delivery: delivered({
    settlement: { status: "undeterminable", reason: "delivery_facts_malformed" }, settledAt: null, ambiguous: false,
  }) })]))).decide, [["delivery_ambiguous:run_a", "open"]]);
  // 真实存储里那批 failed / aborted 运行：terminal_delivery_ambiguous，commit 与 ambiguous
  // 都读不出（只是隔离时建的分支没回收）→ 不成立，也不进 Workers 默认范围。
  const noRecord = run({
    runId: "run_dead", state: "failed", terminalAt: ago(891 * HOUR), startedAt: ago(892 * HOUR),
    deliveryRequested: true,
    delivery: delivered({
      settlement: { status: "undeterminable", reason: "terminal_delivery_ambiguous" }, settledAt: null,
      verification: null, acceptance: { status: null, decidedAt: null }, commit: null, ambiguous: false,
    }),
  });
  const dead = derive(snapshot([noRecord]));
  nowhere(dead, "delivery_ambiguous:run_dead");
  assert.deepEqual(dead.decide, []);
  assert.deepEqual(selectOwnerWorkers(snapshot([noRecord]), dead, { now: NOW }), [], "没有交付记录就不把运行带进 Workers 默认范围");
  // 同样形状但视图 ambiguous 为真（交付事实自相矛盾）：仍成立。
  const contradicted = derive(snapshot([run({
    runId: "run_dead", delivery: delivered({
      settlement: { status: "undeterminable", reason: "delivery_facts_malformed" }, settledAt: null,
      verification: null, acceptance: { status: null, decidedAt: null }, commit: null, ambiguous: true,
    }),
  })]));
  assert.deepEqual(outcome(contradicted).decide, [["delivery_ambiguous:run_dead", "unknown"]]);
  // 已收口、没有歧义的交付不成立。
  assert.deepEqual(derive(snapshot([run({ delivery: fresh() })])).decide, []);
});

// =====================================================================
// awaiting_decision — 等裁决超过 2 小时
// =====================================================================
test("awaiting_decision: 交付已收口、待裁决、超过 2 小时 → open；2 小时以内不成立", () => {
  const out = derive(snapshot([run({ delivery: delivered({ settledAt: ago(3 * HOUR) }) })]));
  assert.deepEqual(out.decide, [{
    id: "awaiting_decision:run_a",
    kind: "awaiting_decision",
    state: "open",
    runIds: ["run_a"],
    projectSlugs: ["alpha"],
    since: ago(3 * HOUR),
    evidence: [{ runId: "run_a", at: ago(3 * HOUR), seq: null }],
  }]);
  nowhere(derive(snapshot([run({ delivery: delivered({ settledAt: ago(HOUR) }) })])), "awaiting_decision:run_a");
  // 阈值两侧：恰好 2 小时不算"超过"，多一毫秒就算。
  nowhere(derive(snapshot([run({ delivery: delivered({ settledAt: ago(OWNER_ATTENTION_DECIDE_AFTER_MS) }) })])), "awaiting_decision:run_a");
  assert.deepEqual(outcome(derive(snapshot([run({ delivery: delivered({ settledAt: ago(OWNER_ATTENTION_DECIDE_AFTER_MS + 1) }) })]))).decide,
    [["awaiting_decision:run_a", "open"]]);
});

test("awaiting_decision: 没收口（验证还在跑）的不算等裁决", () => {
  const unsettled = delivered({
    settlement: { status: "unsettled", reason: "verification_pending" },
    verification: { status: "pending", reverify: NONE }, settledAt: null,
  });
  nowhere(derive(snapshot([run({ delivery: unsettled })])), "awaiting_decision:run_a");
});

test("awaiting_decision: supersessionUndeterminable 为真时照样列，但标 unknown", () => {
  const out = derive(snapshot([run({ delivery: delivered({ settledAt: ago(3 * HOUR) }), supersessionUndeterminable: true })]));
  assert.deepEqual(outcome(out).decide, [["awaiting_decision:run_a", "unknown"]]);
  assert.equal("resolution" in out.decide[0], false);
  assert.deepEqual(out.resolved, []);
});

test("awaiting_decision: 收口时刻读不到 → 列为 unknown（since 为 null），不猜时长", () => {
  const out = derive(snapshot([run({ delivery: delivered({ settledAt: null }) })]));
  assert.deepEqual(outcome(out).decide, [["awaiting_decision:run_a", "unknown"]]);
  assert.equal(out.decide[0].since, null);
});

test("awaiting_decision: 已裁决 → resolved / decided（accepted 与 rejected 都算）；已被取代 → superseded", () => {
  for (const status of ["accepted", "rejected"]) {
    // 缺省夹具收口于 4 小时前、裁决于 1 小时前：等过 3 小时，才进"已了结"。
    const out = derive(snapshot([run({ delivery: delivered({ acceptance: { status, decidedAt: ago(HOUR) } }) })]));
    assert.deepEqual(outcome(out), { decide: [], anomalies: [], resolved: [["awaiting_decision:run_a", "decided", ago(HOUR)]] }, status);
  }
  const superseded = derive(snapshot([
    run({ delivery: delivered({ settledAt: ago(5 * HOUR) }), supersededByRunId: "run_child" }),
    run({ runId: "run_child", lineageRootRunId: "run_a", delivery: fresh({ acceptance: { status: "accepted", decidedAt: ago(HOUR) } }) }),
  ]));
  assert.deepEqual(outcome(superseded), { decide: [], anomalies: [], resolved: [["awaiting_decision:run_a", "superseded", ago(HOUR)]] });
});

test("awaiting_decision: 等了多久算到解除那一刻——不到 2 小时就裁决的哪一栏都不在；等过才裁决的裁决当下就进已了结", () => {
  const decidedAfter = (waitedMs) => derive(snapshot([run({
    delivery: delivered({ settledAt: ago(waitedMs + HOUR), acceptance: { status: "accepted", decidedAt: ago(HOUR) } }),
  })]));
  nowhere(decidedAfter(HOUR), "awaiting_decision:run_a");
  nowhere(decidedAfter(OWNER_ATTENTION_DECIDE_AFTER_MS), "awaiting_decision:run_a");
  assert.deepEqual(outcome(decidedAfter(OWNER_ATTENTION_DECIDE_AFTER_MS + 1)).resolved, [["awaiting_decision:run_a", "decided", ago(HOUR)]]);
  // 已被取代、但取代者没有裁决时间：说不清它等过多久，不进"已了结"。
  nowhere(derive(snapshot([run({ delivery: delivered({ settledAt: ago(5 * HOUR) }), supersededByRunId: "run_child" })])), "awaiting_decision:run_a");
  // 已裁决、但收口时刻读不到：同样说不清它等过多久，不进"已了结"（不拿 0 当收口时刻）。
  nowhere(derive(snapshot([run({ delivery: fresh({ settledAt: null, acceptance: { status: "accepted", decidedAt: ago(HOUR) } }) })])), "awaiting_decision:run_a");
});

// =====================================================================
// 交付类事项的前提：branchPresent 三值
// =====================================================================
test("branchPresent: true 才列；false（交付已回收）不列，已裁决的也不进 resolved；null（仓库不可观测）不列、计入 deliveryUnobservable", () => {
  assert.equal(derive(snapshot([run({ delivery: fresh({ verification: FAILED_VERIFICATION, branchPresent: true }) })])).decide.length, 1);

  const reclaimed = derive(snapshot([
    run({ runId: "run_open", delivery: delivered({ verification: FAILED_VERIFICATION, branchPresent: false }) }),
    run({ runId: "run_decided", delivery: delivered({ acceptance: { status: "accepted", decidedAt: ago(HOUR) }, branchPresent: false }) }),
  ]));
  assert.deepEqual(outcome(reclaimed), { decide: [], anomalies: [], resolved: [] });
  assert.equal(reclaimed.counts.deliveryUnobservable, 0, "分支确认不在不算不可观测");

  const unobservable = derive(snapshot([
    run({ runId: "run_open", delivery: fresh({ verification: FAILED_VERIFICATION, branchPresent: null }) }),
    run({ runId: "run_decided", delivery: delivered({ acceptance: { status: "accepted", decidedAt: ago(HOUR) }, branchPresent: null }) }),
  ]));
  assert.deepEqual(outcome(unobservable), { decide: [], anomalies: [], resolved: [] });
  assert.equal(unobservable.counts.deliveryUnobservable, 2);
  assert.deepEqual(unobservable.counts.projects, [{
    slug: "alpha", running: 0, starting: 0,
    liveness: { terminal: 2, progress: 0, process_only: 0, silent: 0, unknown: 0 },
    verifying: 0, deliveryUnobservable: 2, decide: { open: 0, unknown: 0 }, anomalies: { open: 0, unknown: 0 },
  }]);
  // 没有请求交付的运行不算；分支都在的快照是 0，而不是缺这一项。
  assert.equal(derive(snapshot([run({ delivery: null })])).counts.deliveryUnobservable, 0);
  assert.equal(derive(snapshot([run({ delivery: fresh() })])).counts.deliveryUnobservable, 0);
});

// =====================================================================
// quota_exhausted / rate_limited — 按车道键分组
// =====================================================================
test("quota_exhausted: open 事项，id 是 capacity:<车道键>，since 与证据是额度观测", () => {
  const out = derive(snapshot([exhausted(LANE, HOUR)]));
  assert.deepEqual(out.decide, [{
    id: "capacity:glm-pro",
    kind: "quota_exhausted",
    state: "open",
    runIds: ["run_a"],
    projectSlugs: ["alpha"],
    since: ago(HOUR),
    laneKey: "glm-pro",
    capacityCode: "quota_exhausted",
    evidence: [{ runId: "run_a", at: ago(HOUR), seq: null }],
  }]);
  assert.deepEqual(outcome(out).anomalies, [["failed:run_a", "open"]], "失败的运行本身另有一条异常");
});

test("quota_exhausted: 同车道多次观测合成一组，取最后一次观测；不同车道各成一组", () => {
  const out = derive(snapshot([
    exhausted(LANE, 4 * HOUR, { runId: "run_old" }),
    exhausted(LANE, HOUR, { runId: "run_new" }),
  ]));
  assert.deepEqual(out.decide, [{
    id: "capacity:glm-pro",
    kind: "quota_exhausted",
    state: "open",
    runIds: ["run_old", "run_new"],
    projectSlugs: ["alpha"],
    since: ago(HOUR),
    laneKey: "glm-pro",
    capacityCode: "quota_exhausted",
    evidence: [
      { runId: "run_old", at: ago(4 * HOUR), seq: null }, // 证据按观测时刻从早到晚
      { runId: "run_new", at: ago(HOUR), seq: null },
    ],
  }]);
  const two = derive(snapshot([
    exhausted(LANE, HOUR),
    exhausted({ laneId: "kimi", agentId: "kimi" }, HOUR, { runId: "run_b" }),
  ]));
  assert.deepEqual(ids(two.decide), ["capacity:glm-pro", "capacity:kimi"]);
});

test("quota_exhausted: 车道键回退 agentId（会审席没有 laneId）", () => {
  const out = derive(snapshot([exhausted({ laneId: null, agentId: "auditor-seat" }, HOUR)]));
  assert.deepEqual(out.decide.map((item) => [item.id, item.laneKey]), [["capacity:auditor-seat", "auditor-seat"]]);
});

test("quota_exhausted: 同车道在观测之后有运行完成 → resolved / later_success", () => {
  const done = (runId, terminalAgoMs, lane = LANE) => run({
    runId, laneId: lane.laneId, agentId: lane.agentId, terminalAt: ago(terminalAgoMs), deliveryRequested: false,
  });
  const out = derive(snapshot([exhausted(LANE, HOUR), done("run_ok", 30 * MINUTE)]));
  assert.deepEqual(outcome(out), { decide: [], anomalies: [["failed:run_a", "open"]], resolved: [["capacity:glm-pro", "later_success", ago(30 * MINUTE)]] });
  assert.deepEqual(out.resolved[0].evidence, [
    { runId: "run_a", at: ago(HOUR), seq: null },
    { runId: "run_ok", at: ago(30 * MINUTE), seq: null },
  ]);
  // 不算后续成功：完成在观测之前、同 agentId 但 laneId 不同、同车道但没完成（又是失败）。
  for (const runs of [
    [exhausted(LANE, HOUR), done("run_early", 2 * HOUR)],
    [exhausted(LANE, HOUR), done("run_other_lane", 30 * MINUTE, { laneId: "kimi", agentId: "glm-pro" })],
    [exhausted(LANE, HOUR), exhausted(LANE, 30 * MINUTE, { runId: "run_again" })],
  ]) {
    assert.deepEqual(outcome(derive(snapshot(runs))).decide.filter(([id]) => id === "capacity:glm-pro"), [["capacity:glm-pro", "open"]]);
  }
});

test("quota_exhausted: 按车道键跨项目分组——别的项目里同车道后来跑成了，也算后续成功", () => {
  const kimis = { laneId: "kimi", agentId: "kimi" };
  const inBeta = { project: { slug: "beta", name: "Beta" } };
  const later = derive(snapshot([
    exhausted(kimis, 2 * HOUR, { runId: "run_q" }),
    run({ runId: "run_ok", ...kimis, ...inBeta, terminalAt: ago(HOUR), deliveryRequested: false }),
  ], [], [ALPHA, BETA]));
  assert.deepEqual(outcome(later).resolved, [["capacity:kimi", "later_success", ago(HOUR)]]);
  assert.deepEqual(later.resolved[0].projectSlugs, ["alpha"], "只有一次观测：事项归属观测所在的项目");
  // 同一车道的观测分布在两个项目：仍是一组；projectSlugs 含全部观测所在的项目，计数两边都算
  // ——与 /api/attention?project=X 能查到它一致。
  const spread = derive(snapshot([
    exhausted(kimis, 4 * HOUR, { runId: "run_q_alpha" }),
    exhausted(kimis, HOUR, { runId: "run_q_beta", ...inBeta }),
  ], [], [ALPHA, BETA]));
  assert.deepEqual(outcome(spread).decide, [["capacity:kimi", "open"]]);
  assert.deepEqual(spread.decide[0].projectSlugs, ["alpha", "beta"]);
  assert.deepEqual(spread.decide[0].runIds, ["run_q_alpha", "run_q_beta"]);
  assert.deepEqual(spread.counts.projects.map((entry) => entry.slug), ["alpha", "beta"]);
  assert.deepEqual(
    spread.counts.projects.map((entry) => entry.decide),
    [{ open: 1, unknown: 0 }, { open: 1, unknown: 0 }],
  );
});

test("quota_exhausted: 没有后续成功时，证据不超过 6 小时 open，超过 6 小时 unknown", () => {
  assert.deepEqual(outcome(derive(snapshot([exhausted(LANE, OWNER_ATTENTION_CAPACITY_FRESH_MS)]))).decide, [["capacity:glm-pro", "open"]]);
  assert.deepEqual(outcome(derive(snapshot([exhausted(LANE, OWNER_ATTENTION_CAPACITY_FRESH_MS + 1)]))).decide, [["capacity:glm-pro", "unknown"]]);
});

test("quota_exhausted: 只列 24 小时内的观测；观测时刻读不到、没有车道键的不成立", () => {
  assert.equal(derive(snapshot([exhausted(LANE, OWNER_ATTENTION_WINDOW_MS)])).decide.length, 1);
  nowhere(derive(snapshot([exhausted(LANE, OWNER_ATTENTION_WINDOW_MS + 1)])), "capacity:glm-pro");
  nowhere(derive(snapshot([exhausted(LANE, HOUR, { capacity: { code: "quota_exhausted", observedAt: null } })])), "capacity:glm-pro");
  nowhere(derive(snapshot([exhausted({ laneId: null, agentId: null }, HOUR)])), "capacity:glm-pro");
});

test("24 小时窗口: 未了结按证据时刻列，已了结按 resolvedAt 列——25 小时前的证据 + 1 小时前的后续成功仍进已了结", () => {
  const done = (runId, terminalAgoMs, startedAgoMs) => run({
    runId, laneId: LANE.laneId, agentId: LANE.agentId, startedAt: ago(startedAgoMs), terminalAt: ago(terminalAgoMs), deliveryRequested: false,
  });
  // 额度：观测在 25 小时前（窗口外），同车道 1 小时前跑成（resolvedAt 在窗口内）。
  const quota = derive(snapshot([exhausted(LANE, OWNER_ATTENTION_WINDOW_MS + HOUR), done("run_ok", HOUR, 2 * HOUR)]));
  assert.deepEqual(outcome(quota).decide, []);
  assert.deepEqual(outcome(quota).resolved, [["capacity:glm-pro", "later_success", ago(HOUR)]]);
  // 同一份证据窗口外、又没有后续成功：不成立（未了结按证据窗口）。
  const staleQuota = derive(snapshot([exhausted(LANE, OWNER_ATTENTION_WINDOW_MS + HOUR)]));
  nowhere(staleQuota, "capacity:glm-pro");
  assert.deepEqual(staleQuota.resolved, []);
  // 后续成功也在窗口外（30 小时前跑成）：不是"已了结"栏里的事项。
  const oldSuccess = derive(snapshot([exhausted(LANE, OWNER_ATTENTION_WINDOW_MS + HOUR), done("run_ok", 30 * HOUR, 40 * HOUR)]));
  assert.deepEqual(oldSuccess.resolved, []);
  // failed：25 小时前失败、1 小时前有后续成功（在失败之后才开始）→ 只进已了结，不进异常。
  const failed = failedRun({ runId: "run_root", terminalAt: ago(OWNER_ATTENTION_WINDOW_MS + HOUR) });
  const recovered = derive(snapshot([
    failed,
    run({ runId: "run_child", lineageRootRunId: "run_root", startedAt: ago(OWNER_ATTENTION_WINDOW_MS + 30 * MINUTE), terminalAt: ago(HOUR), deliveryRequested: false }),
  ]));
  assert.deepEqual(outcome(recovered).anomalies, []);
  assert.deepEqual(outcome(recovered).resolved, [["failed:run_root", "later_success", ago(HOUR)]]);
});

test("额度事项的证据只留最新 10 条观测（按观测时刻升序）；解除证据照旧附在末尾", () => {
  // 同一车道 12 次观测，时刻从 12 小时前到 1 小时前（数组顺序故意打乱：按时刻取最新 10 条）。
  const observations = [];
  for (const observedAgoMs of [1, 5, 9, 2, 6, 10, 3, 7, 11, 4, 8, 12]) {
    observations.push(exhausted(LANE, observedAgoMs * HOUR, { runId: `run_${observedAgoMs}` }));
  }
  const out = derive(snapshot(observations));
  const item = byId(out.decide, "capacity:glm-pro");
  assert.equal(item.evidence.length, OWNER_ATTENTION_CAPACITY_EVIDENCE_MAX, "只留 10 条");
  assert.deepEqual(item.evidence.map((entry) => entry.at), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((h) => ago(h * HOUR)),
    "取观测时刻最新的 10 条，再按时刻升序（11 小时前与 12 小时前的两条被截掉）");
  assert.deepEqual(item.evidence.map((entry) => entry.runId), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((h) => `run_${h}`));
  assert.equal(item.runIds.length, 12, "runIds 仍列全部观测（只有证据有上限）");
  assert.equal(item.since, ago(HOUR), "since 仍是最后一次观测");
  // 加了后续成功：解除证据追加在（截断后的）观测证据末尾。
  const resolved = derive(snapshot([
    ...observations,
    run({ runId: "run_ok", laneId: LANE.laneId, agentId: LANE.agentId, startedAt: ago(2 * HOUR), terminalAt: ago(30 * MINUTE), deliveryRequested: false }),
  ]));
  const resolvedItem = byId(resolved.resolved, "capacity:glm-pro");
  assert.equal(resolvedItem.evidence.length, OWNER_ATTENTION_CAPACITY_EVIDENCE_MAX + 1);
  assert.deepEqual(resolvedItem.evidence.at(-1), { runId: "run_ok", at: ago(30 * MINUTE), seq: null });
});

test("rate_limited: 限流与上游过载进异常栏（不进口袋事项），分组与窗口/解除规则同额度；同一运行的 failed 异常照留", () => {
  const limited = (code, runId, observedAgoMs) => exhausted(LANE, observedAgoMs, {
    runId,
    failure: { category: "provider_capacity", code },
    capacity: { code, observedAt: ago(observedAgoMs) },
  });
  const out = derive(snapshot([limited("rate_limited", "run_a", HOUR), limited("overloaded", "run_b", 2 * HOUR)]));
  assert.deepEqual(out.decide, [], "限流不是拿主意事项");
  // 同一运行另有 failed 异常照留；一组额度事项取最后一次观测（rate_limited），页面据此写"限流"。
  assert.deepEqual(outcome(out).anomalies, [
    ["failed:run_a", "open"],
    ["failed:run_b", "open"],
    ["rate_limited:glm-pro", "open"],
  ]);
  assert.deepEqual(byId(out.anomalies, "rate_limited:glm-pro"), {
    id: "rate_limited:glm-pro",
    kind: "rate_limited",
    state: "open",
    runIds: ["run_a", "run_b"],
    projectSlugs: ["alpha"],
    since: ago(HOUR),
    laneKey: "glm-pro",
    capacityCode: "rate_limited",
    evidence: [
      { runId: "run_b", at: ago(2 * HOUR), seq: null },
      { runId: "run_a", at: ago(HOUR), seq: null },
    ],
  });
  // capacityCode 是实际的额度码：只看一次 overloaded 观测时页面写"上游过载"。
  const overloaded = derive(snapshot([limited("overloaded", "run_a", HOUR)]));
  assert.equal(byId(overloaded.anomalies, "rate_limited:glm-pro").capacityCode, "overloaded");
  // 与 quota_exhausted 分属两组、两栏，互不吞并。
  const mixed = derive(snapshot([limited("rate_limited", "run_a", HOUR), exhausted(LANE, HOUR, { runId: "run_q" })]));
  assert.deepEqual(ids(mixed.decide), ["capacity:glm-pro"]);
  assert.deepEqual(ids(mixed.anomalies), ["failed:run_a", "failed:run_q", "rate_limited:glm-pro"]);
  // 6 小时两侧与"之后有运行完成"同一套规则。
  assert.deepEqual(outcome(derive(snapshot([limited("overloaded", "run_a", OWNER_ATTENTION_CAPACITY_FRESH_MS + 1)]))).anomalies
    .filter(([id]) => id === "rate_limited:glm-pro"), [["rate_limited:glm-pro", "unknown"]]);
  const done = run({ runId: "run_ok", terminalAt: ago(30 * MINUTE), deliveryRequested: false });
  assert.deepEqual(outcome(derive(snapshot([limited("rate_limited", "run_a", HOUR), done]))).resolved,
    [["rate_limited:glm-pro", "later_success", ago(30 * MINUTE)]]);
  // 额度码不在闭集里的容量事实不成立。
  nowhere(derive(snapshot([failedRun({ capacity: { code: "mystery", observedAt: ago(HOUR) } })])), "capacity:glm-pro");
});

// =====================================================================
// failed — 失败的运行
// =====================================================================
test("failed: 24 小时内失败的运行 → open 异常，followUp: unknown（看不到后续），原因只给 category 与 code", () => {
  const out = derive(snapshot([failedRun({ terminalAt: ago(HOUR), failure: { category: "provider_error", code: "backend_error", evidence: "SECRET /d/private/x" } })]));
  assert.deepEqual(out.anomalies, [{
    id: "failed:run_a",
    kind: "failed",
    state: "open",
    runIds: ["run_a"],
    projectSlugs: ["alpha"],
    since: ago(HOUR),
    followUp: "unknown",
    failure: { category: "provider_error", code: "backend_error" },
    evidence: [{ runId: "run_a", at: ago(HOUR), seq: null }],
  }]);
  assert.deepEqual(out.decide, []);
  assert.deepEqual(out.resolved, []);
});

test("failed: 超过 24 小时、终态时刻读不到、不是 failed 的不成立", () => {
  assert.equal(derive(snapshot([failedRun({ terminalAt: ago(OWNER_ATTENTION_WINDOW_MS) })])).anomalies.length, 1);
  nowhere(derive(snapshot([failedRun({ terminalAt: ago(OWNER_ATTENTION_WINDOW_MS + 1) })])), "failed:run_a");
  nowhere(derive(snapshot([failedRun({ terminalAt: null })])), "failed:run_a");
  nowhere(derive(snapshot([run({ terminalAt: ago(HOUR) })])), "failed:run_a");
});

test("failed: 同一谱系里有运行在它之后完成 → resolved / later_success（取最早的那个）", () => {
  const root = failedRun({ runId: "run_root", lineageRootRunId: "run_root", terminalAt: ago(3 * HOUR) });
  // 后续运行在失败之后才开始（startedAt >= 失败的 terminalAt），完成时刻是 terminalAt。
  const child = (runId, terminalAgoMs) => run({
    runId, lineageRootRunId: "run_root", startedAt: ago(terminalAgoMs + 5 * MINUTE), terminalAt: ago(terminalAgoMs), deliveryRequested: false,
  });
  const out = derive(snapshot([root, child("run_c1", 2 * HOUR)]));
  assert.deepEqual(outcome(out), { decide: [], anomalies: [], resolved: [["failed:run_root", "later_success", ago(2 * HOUR)]] });
  assert.deepEqual(out.resolved[0], {
    id: "failed:run_root",
    kind: "failed",
    state: "resolved",
    runIds: ["run_root"],
    projectSlugs: ["alpha"],
    since: ago(3 * HOUR),
    resolvedAt: ago(2 * HOUR),
    resolution: "later_success",
    failure: { category: "provider_error", code: "backend_error" },
    evidence: [
      { runId: "run_root", at: ago(3 * HOUR), seq: null },
      { runId: "run_c1", at: ago(2 * HOUR), seq: null },
    ],
  });
  // 多个后续完成取最早的那个；完成在失败之前的不算。
  const several = derive(snapshot([root, child("run_c2", 50 * MINUTE), child("run_c1", 2 * HOUR), child("run_c0", 5 * HOUR)]));
  assert.equal(several.resolved[0].resolvedAt, ago(2 * HOUR));
  assert.deepEqual(several.resolved[0].evidence.at(-1), { runId: "run_c1", at: ago(2 * HOUR), seq: null });
});

test("failed: retryOf 指向它的运行在它之后完成也算后续成功（且在失败之后才开始）", () => {
  const out = derive(snapshot([
    failedRun({ runId: "run_first", terminalAt: ago(3 * HOUR) }),
    run({ runId: "run_retry", retryOf: "run_first", startedAt: ago(2 * HOUR), terminalAt: ago(HOUR), deliveryRequested: false }),
  ]));
  assert.deepEqual(outcome(out).resolved, [["failed:run_first", "later_success", ago(HOUR)]]);
  assert.deepEqual(out.anomalies, []);
});

test("failed: 并发跑着的兄弟运行不算解除——即使它完成得比失败晚，开始却在失败之前", () => {
  const root = failedRun({ runId: "run_root", lineageRootRunId: "run_root", terminalAt: ago(2 * HOUR) });
  // 兄弟运行 3 小时前就开始了（与失败并发），1 小时前完成：不是"后续成功"。
  const sibling = run({
    runId: "run_sibling", lineageRootRunId: "run_root", startedAt: ago(3 * HOUR), terminalAt: ago(HOUR), deliveryRequested: false,
  });
  const out = derive(snapshot([root, sibling]));
  assert.deepEqual(outcome(out).anomalies, [["failed:run_root", "open"]]);
  assert.deepEqual(out.resolved, []);
  // startedAt 读不到时也确认不了"在失败之后开始"：不当作后续成功。
  const unknownStart = run({
    runId: "run_child", lineageRootRunId: "run_root", startedAt: null, terminalAt: ago(HOUR), deliveryRequested: false,
  });
  assert.deepEqual(derive(snapshot([root, unknownStart])).resolved, []);
  // 等于失败时刻（同一毫秒）算"之后开始"。
  const sameMs = run({
    runId: "run_child", lineageRootRunId: "run_root", startedAt: ago(2 * HOUR), terminalAt: ago(HOUR), deliveryRequested: false,
  });
  assert.deepEqual(outcome(derive(snapshot([root, sameMs]))).resolved, [["failed:run_root", "later_success", ago(HOUR)]]);
  // followUp: running 也认同一个"后续"：并发在跑的兄弟（开始于失败之前）不算后续，
  // 开始时刻读不到也不算；在失败之后才开始的才算。
  const liveSibling = live({ runId: "run_live_sibling", lineageRootRunId: "run_root", startedAt: ago(3 * HOUR) });
  assert.equal(derive(snapshot([root, liveSibling])).anomalies[0].followUp, "unknown");
  const liveUnknownStart = live({ runId: "run_live_unknown", lineageRootRunId: "run_root", startedAt: null });
  assert.equal(derive(snapshot([root, liveUnknownStart])).anomalies[0].followUp, "unknown");
  const liveLater = live({ runId: "run_live_later", lineageRootRunId: "run_root", startedAt: ago(2 * HOUR) });
  assert.equal(derive(snapshot([root, liveLater])).anomalies[0].followUp, "running");
});

test("failed: 有后续还在跑 → open + followUp: running（同谱系或 retryOf，且在失败之后才开始）", () => {
  const root = failedRun({ runId: "run_root", lineageRootRunId: "run_root", terminalAt: ago(3 * HOUR) });
  const byLineage = derive(snapshot([root, live({ runId: "run_child", lineageRootRunId: "run_root", startedAt: ago(2 * HOUR) })]));
  assert.deepEqual(outcome(byLineage).anomalies, [["failed:run_root", "open"]]);
  assert.equal(byLineage.anomalies[0].followUp, "running");
  const byRetry = derive(snapshot([
    failedRun({ runId: "run_first", terminalAt: ago(3 * HOUR) }),
    live({ runId: "run_retry", retryOf: "run_first", startedAt: ago(2 * HOUR) }),
  ]));
  assert.equal(byRetry.anomalies[0].followUp, "running");
});

test("failed: 它的交付已裁决 → resolved / decided", () => {
  const out = derive(snapshot([failedRun({
    terminalAt: ago(HOUR),
    delivery: fresh({ acceptance: { status: "rejected", decidedAt: ago(30 * MINUTE) } }),
  })]));
  assert.deepEqual(outcome(out), { decide: [], anomalies: [], resolved: [["failed:run_a", "decided", ago(30 * MINUTE)]] });
});

test("failed: 后续认不出时不说「没有后续」——谱系根读不到、后续运行读不出，followUp 都是 unknown；原因照抄闭集码", () => {
  const conflict = derive(snapshot([failedRun({
    lineageRootRunId: null, lineageRootConflict: true, terminalAt: ago(HOUR), failure: { category: "unknown", code: null },
  })]));
  assert.equal(conflict.anomalies[0].followUp, "unknown");
  assert.deepEqual(conflict.anomalies[0].failure, { category: "unknown", code: null });
  const blind = derive(snapshot([
    failedRun({ runId: "run_root", lineageRootRunId: "run_root", terminalAt: ago(3 * HOUR) }),
    unreadable({ runId: "run_child" }),
  ]));
  assert.equal(blind.anomalies[0].followUp, "unknown");
  // 没有请求交付的失败运行不存在"已裁决"：仍是 open。
  assert.equal(blind.anomalies[0].state, "open");
});

// =====================================================================
// silent / process_only — 只有现时状态
// =====================================================================
test("silent / process_only: 非终态且超过 30 分钟才列；恰好 30 分钟不算", () => {
  const quietAgo = OWNER_ATTENTION_QUIET_AFTER_MS + 1;
  const silent = derive(snapshot([live({ liveness: "silent", quietSince: ago(quietAgo) })]));
  assert.deepEqual(silent.anomalies, [{
    id: "silent:run_a",
    kind: "silent",
    state: "open",
    runIds: ["run_a"],
    projectSlugs: ["alpha"],
    since: ago(quietAgo),
    evidence: [{ runId: "run_a", at: ago(quietAgo), seq: null }],
  }]);
  assert.deepEqual(derive(snapshot([live({ liveness: "silent", quietSince: ago(OWNER_ATTENTION_QUIET_AFTER_MS) })])).anomalies, []);
  const processOnly = derive(snapshot([live({ liveness: "process_only", quietSince: ago(HOUR) })]));
  assert.deepEqual(processOnly.anomalies.map((item) => [item.id, item.state, item.since]), [["process_only:run_a", "open", ago(HOUR)]]);
  // 有进展的、已终态的不列。
  assert.deepEqual(derive(snapshot([live({ liveness: "progress", quietSince: ago(HOUR) })])).anomalies, []);
  assert.deepEqual(derive(snapshot([run({ liveness: "silent", quietSince: ago(HOUR) })])).anomalies, []);
});

test("silent / process_only: quietSince 读不到 → 列为 unknown；只有现时状态，不进 resolved", () => {
  const unknownSince = derive(snapshot([live({ liveness: "silent", quietSince: null })]));
  assert.deepEqual(unknownSince.anomalies.map((item) => [item.id, item.state, item.since]), [["silent:run_a", "unknown", null]]);
  // 同一份快照，now 推进 11 分钟：越过门限后出现。
  const quiet = snapshot([live({ liveness: "silent", quietSince: ago(20 * MINUTE) })]);
  assert.deepEqual(derive(quiet).anomalies, []);
  assert.deepEqual(ids(derive(quiet, NOW + 11 * MINUTE).anomalies), ["silent:run_a"]);
  // 活性一旦不是 silent（运行有了进展），事项从列表消失，resolved 里也没有它。
  const progressed = snapshot([live({ liveness: "progress", quietSince: ago(20 * MINUTE) })]);
  assert.deepEqual(outcome(derive(progressed, NOW + 11 * MINUTE)), { decide: [], anomalies: [], resolved: [] });
});

// =====================================================================
// 读不到不当成"没有"或"已了结"
// =====================================================================
test("读不出的运行不产生任何事项，只计入 liveness.unknown", () => {
  const out = derive(snapshot([unreadable()]));
  assert.deepEqual(outcome(out), { decide: [], anomalies: [], resolved: [] });
  assert.equal(out.counts.liveness.unknown, 1);
  assert.equal(out.counts.running, 0);
  assert.equal(out.counts.deliveryUnobservable, 0);
});

test("deriveOwnerAttention: now 不是可表示的时刻 → TypeError（调用方的错，不发一份残缺结果）", () => {
  for (const options of [{ now: NaN }, { now: undefined }, { now: "1760000000000" }, {}]) {
    assert.throws(() => deriveOwnerAttention(snapshot([]), options), /now/i, JSON.stringify(options));
  }
});

test("deriveOwnerAttention: 不改动传入的快照（纯函数）", () => {
  const snap = mixedSnapshot();
  const before = JSON.stringify(snap);
  const first = derive(snap);
  selectOwnerWorkers(snap, first, { now: NOW });
  ownerLanes(snap, first);
  assert.equal(JSON.stringify(snap), before);
});

// =====================================================================
// 稳定 id、resolved 窗口、counts —— 共用一份混合夹具
// =====================================================================
function mixedSnapshot() {
  return snapshot([
    live({ runId: "run_live", quietSince: ago(40 * MINUTE), liveness: "silent", stage: "starting" }),
    exhausted({ laneId: "kimi", agentId: "kimi" }, HOUR, { runId: "run_fail", project: { slug: "beta", name: "Beta" } }),
    run({ runId: "run_wait", delivery: delivered({ settledAt: ago(3 * HOUR) }) }),
    run({ runId: "run_decided", delivery: delivered({
      verification: FAILED_VERIFICATION, acceptance: { status: "accepted", decidedAt: ago(HOUR) }, settledAt: ago(4 * HOUR),
    }) }),
    run({ runId: "run_unseen", delivery: delivered({ settledAt: ago(HOUR), branchPresent: null }) }),
  ], [consult({ reviewedRunId: "run_wait", seats: [seat("run_live", "FIX_FIRST"), seat("run_wait", "PASS")] })], [ALPHA, BETA]);
}

test("稳定 id: 同一份快照算两次结果相同；换 now 只改时效，id 不变", () => {
  const first = derive(mixedSnapshot());
  assert.deepEqual(derive(mixedSnapshot()), first);
  const later = derive(mixedSnapshot(), NOW + 10 * MINUTE);
  assert.deepEqual(outcome(later), outcome(first));
  // 未了结的按 since 从早到晚（等得最久的在前），同一时刻按 id。
  assert.deepEqual(ids(first.decide), ["awaiting_decision:run_wait", "consult_split:alpha:consult_1", "capacity:kimi"]);
  assert.deepEqual(ids(first.anomalies), ["failed:run_fail", "silent:run_live"]);
  assert.deepEqual(ids(first.resolved), ["awaiting_decision:run_decided", "verification_failed:run_decided"]);
});

test("闭集: 每种事项、每种状态、每种解除都出现，且字段取值都在导出的闭集里", () => {
  // 把剩余的种类与解除依据凑齐（mixedSnapshot 已有会审、等裁决、额度、失败、静默、裁决）。
  const kimis = { laneId: "kimi", agentId: "kimi" };
  const rich = derive(snapshot([
    exhausted(kimis, 2 * HOUR, { runId: "run_q" }), // 之后同车道有运行完成 → later_success
    run({ runId: "run_ok", ...kimis, terminalAt: ago(HOUR), deliveryRequested: false }),
    exhausted(LANE, HOUR, { // overloaded → rate_limited
      runId: "run_rl", failure: { category: "provider_capacity", code: "overloaded" }, capacity: { code: "overloaded", observedAt: ago(HOUR) },
    }),
    run({ runId: "run_unavail", delivery: fresh({ verification: { status: "unavailable", reverify: NONE } }) }),
    run({ runId: "run_amb", delivery: fresh({ settlement: { status: "undeterminable", reason: "delivery_facts_malformed" }, settledAt: null }) }),
    run({ runId: "run_reverify", delivery: fresh({ verification: { status: "passed", reverify: { status: "complete", reason: "tooling_invalid" } } }) }),
    run({ runId: "run_sup", delivery: delivered({ settledAt: ago(5 * HOUR) }), supersededByRunId: "run_child" }),
    run({ runId: "run_child", lineageRootRunId: "run_sup", delivery: fresh({ acceptance: { status: "accepted", decidedAt: ago(HOUR) } }) }),
    live({ runId: "run_po", liveness: "process_only", quietSince: ago(HOUR) }),
    live({ runId: "run_unk", liveness: "silent", quietSince: null }),
    live({ runId: "run_rl_child", lineageRootRunId: "run_rl", startedAt: ago(3 * HOUR) }), // run_rl 的后续还在跑（在失败之后开始）→ followUp: running
  ]));
  const all = [derive(mixedSnapshot()), rich].flatMap((out) => [...out.decide, ...out.anomalies, ...out.resolved]);
  for (const item of all) {
    assert.ok(OWNER_ATTENTION_STATES.includes(item.state), item.id);
    assert.ok(OWNER_ATTENTION_KINDS.includes(item.kind), item.id);
    assert.equal("resolution" in item, item.state === "resolved", `${item.id}: resolution 只在 resolved 时有`);
    assert.equal("resolvedAt" in item, item.state === "resolved", `${item.id}: resolvedAt 只在 resolved 时有`);
    if (item.state === "resolved") assert.ok(OWNER_ATTENTION_RESOLUTIONS.includes(item.resolution), item.id);
    if ("followUp" in item) {
      assert.equal(item.kind, "failed", item.id);
      assert.ok(OWNER_ATTENTION_FOLLOW_UPS.includes(item.followUp), item.id);
    }
    for (const entry of item.evidence) assert.deepEqual(entry, { runId: entry.runId, at: entry.at, seq: null }, `${item.id} 的证据只有 runId / at / seq`);
  }
  for (const out of [derive(mixedSnapshot()), rich]) {
    for (const item of out.decide) assert.ok(OWNER_ATTENTION_DECIDE_KINDS.includes(item.kind), `${item.id} 在 decide 栏`);
    for (const item of out.anomalies) assert.ok(OWNER_ATTENTION_ANOMALY_KINDS.includes(item.kind), `${item.id} 在 anomalies 栏`);
  }
  // 闭集里没有凑数的成员：每一种都真的会出现。
  assert.deepEqual([...new Set(all.map((item) => item.kind))].sort(), [...OWNER_ATTENTION_KINDS].sort());
  assert.deepEqual([...new Set(all.map((item) => item.state))].sort(), [...OWNER_ATTENTION_STATES].sort());
  assert.deepEqual([...new Set(all.map((item) => item.resolution).filter((value) => value !== undefined))].sort(), [...OWNER_ATTENTION_RESOLUTIONS].sort());
  assert.deepEqual([...new Set(all.map((item) => item.followUp).filter((value) => value !== undefined))].sort(), [...OWNER_ATTENTION_FOLLOW_UPS].sort());
});

test("resolved: 只收 resolvedAt 在 24 小时内的，按 resolvedAt 倒序；resolvedAt 为 null 的不进", () => {
  const decidedAt = (label, ms) => run({
    runId: `run_${label}`,
    // 收口后等了 3 小时才裁决（settledAt 比裁决早 3 小时），所以这件"等裁决"是成立过的。
    delivery: delivered({ acceptance: { status: "accepted", decidedAt: ago(ms) }, settledAt: ago(ms + 3 * HOUR) }),
  });
  const out = derive(snapshot([
    decidedAt("5h", 5 * HOUR),
    decidedAt("1h", HOUR),
    decidedAt("24h", OWNER_ATTENTION_WINDOW_MS),
    decidedAt("25h", OWNER_ATTENTION_WINDOW_MS + 1),
    run({ runId: "run_null", delivery: delivered({ acceptance: { status: "rejected", decidedAt: null }, settledAt: ago(30 * HOUR) }) }),
  ]));
  assert.deepEqual(out.resolved.map((item) => [item.id, item.resolvedAt]), [
    ["awaiting_decision:run_1h", ago(HOUR)],
    ["awaiting_decision:run_5h", ago(5 * HOUR)],
    ["awaiting_decision:run_24h", ago(OWNER_ATTENTION_WINDOW_MS)],
  ]);
  assert.deepEqual(out.decide, []);
});

test("counts: 全局与按项目，和 decide / anomalies 列表逐项一致", () => {
  const out = derive(mixedSnapshot());
  assert.deepEqual(out.counts, {
    running: 1, // run_live
    starting: 1, // run_live
    liveness: { terminal: 4, progress: 0, process_only: 0, silent: 1, unknown: 0 },
    verifying: 0,
    deliveryUnobservable: 1, // run_unseen：仓库不可观测，不当作 0
    decide: { open: 3, unknown: 0 }, // run_wait、run_decided 的会审、kimi 车道的额度
    anomalies: { open: 2, unknown: 0 }, // run_fail、run_live
    projects: [
      {
        slug: "alpha", running: 1, starting: 1,
        liveness: { terminal: 3, progress: 0, process_only: 0, silent: 1, unknown: 0 },
        verifying: 0, deliveryUnobservable: 1, decide: { open: 2, unknown: 0 }, anomalies: { open: 1, unknown: 0 },
      },
      {
        slug: "beta", running: 0, starting: 0,
        liveness: { terminal: 1, progress: 0, process_only: 0, silent: 0, unknown: 0 },
        verifying: 0, deliveryUnobservable: 0, decide: { open: 1, unknown: 0 }, anomalies: { open: 1, unknown: 0 },
      },
    ],
  });
  // 计数不是另算的：与列表逐项对得上。
  for (const [counts, slug] of [[out.counts, null], [out.counts.projects[0], "alpha"], [out.counts.projects[1], "beta"]]) {
    const inProject = (item) => slug === null || item.projectSlugs.includes(slug);
    for (const [list, key] of [[out.decide, "decide"], [out.anomalies, "anomalies"]]) {
      assert.deepEqual(counts[key], {
        open: list.filter((item) => item.state === "open" && inProject(item)).length,
        unknown: list.filter((item) => item.state === "unknown" && inProject(item)).length,
      });
    }
  }
});

test("counts: 活性各值都数；定不了项目的运行只进全局；正在验证计入 verifying", () => {
  const out = derive(snapshot([
    live({ runId: "run_p", liveness: "progress", quietSince: ago(HOUR) }),
    live({ runId: "run_o", liveness: "process_only", quietSince: ago(5 * MINUTE) }),
    live({ runId: "run_s", liveness: "silent", quietSince: ago(5 * MINUTE) }),
    live({ runId: "run_v", deliveryRequested: true, delivery: delivered({
      settlement: { status: "unsettled", reason: "verification_pending" },
      verification: { status: "pending", reverify: NONE }, settledAt: null,
    }) }),
    run({ runId: "run_t" }),
    unreadable({ runId: "run_u", project: null }),
  ]));
  assert.deepEqual(out.counts.liveness, { terminal: 1, progress: 2, process_only: 1, silent: 1, unknown: 1 });
  assert.equal(out.counts.running, 4);
  assert.equal(out.counts.starting, 0);
  assert.equal(out.counts.verifying, 1);
  assert.equal(out.counts.projects.length, 1, "定不了项目的运行不凭空造出一个项目行");
  assert.deepEqual(out.counts.projects[0].liveness, { terminal: 1, progress: 2, process_only: 1, silent: 1, unknown: 0 });
  // 分支不可观测的"正在验证"不计入 verifying，计入 deliveryUnobservable。
  const blind = derive(snapshot([live({ runId: "run_v", delivery: delivered({
    settlement: { status: "unsettled", reason: "verification_pending" },
    verification: { status: "pending", reverify: NONE }, settledAt: null, branchPresent: null,
  }) })]));
  assert.equal(blind.counts.verifying, 0);
  assert.equal(blind.counts.deliveryUnobservable, 1);
});

// =====================================================================
// Workers 默认范围、卡片标题、车道汇总
// =====================================================================
test("selectOwnerWorkers: 默认范围 = 非终态 ∪ 挂着 open / unknown 交付或会审事项 ∪ 24 小时内终态；按 startedAt 倒序", () => {
  const snap = snapshot([
    run({ runId: "run_old", terminalAt: ago(30 * HOUR) }), // 太旧的终态
    live({ runId: "run_live", startedAt: ago(HOUR) }),
    run({ runId: "run_recent", startedAt: ago(3 * HOUR), terminalAt: ago(2 * HOUR) }),
    run({ runId: "run_wait", startedAt: ago(50 * HOUR), terminalAt: ago(49 * HOUR), delivery: delivered({ settledAt: ago(49 * HOUR) }) }),
    failedRun({ runId: "run_fail", startedAt: ago(2 * HOUR + 30 * MINUTE), terminalAt: ago(2 * HOUR) }),
    unreadable({ runId: "run_unreadable" }),
  ]);
  const out = derive(snap);
  const rows = selectOwnerWorkers(snap, out, { now: NOW });
  assert.deepEqual(rows.map((row) => [row.run.runId, row.attentionIds, row.laneKey]), [
    ["run_live", [], "glm-pro"],
    ["run_fail", ["failed:run_fail"], "glm-pro"],
    ["run_recent", [], "glm-pro"],
    ["run_wait", ["awaiting_decision:run_wait"], "glm-pro"],
  ]);
  // 额度 / 失败事项不把运行带进默认范围：终态超过 24 小时、只挂着额度事项的运行不列。
  const capacityOnly = snapshot([
    exhausted(LANE, 20 * HOUR, { runId: "run_q", terminalAt: ago(30 * HOUR), startedAt: ago(31 * HOUR) }),
    live({ runId: "run_z" }),
  ]);
  const only = derive(capacityOnly);
  assert.deepEqual(ids(only.decide), ["capacity:glm-pro"], "前提：额度事项本身成立");
  assert.deepEqual(selectOwnerWorkers(capacityOnly, only, { now: NOW }).map((row) => row.run.runId), ["run_z"]);
  // 24 小时窗口两侧：恰好 24 小时还算在内，多一毫秒就不算。
  const justIn = snapshot([run({ runId: "run_edge", terminalAt: ago(OWNER_ATTENTION_WINDOW_MS) })]);
  assert.deepEqual(selectOwnerWorkers(justIn, derive(justIn), { now: NOW }).map((row) => row.run.runId), ["run_edge"]);
  const justOut = snapshot([run({ runId: "run_edge", terminalAt: ago(OWNER_ATTENTION_WINDOW_MS + 1) })]);
  assert.deepEqual(selectOwnerWorkers(justOut, derive(justOut), { now: NOW }), []);
});

test("selectOwnerWorkers: 按项目筛选；同一运行挂着多个事项时全部列出；已了结的事项不算挂着", () => {
  const snap = snapshot([
    exhausted(LANE, HOUR, { runId: "run_fail", startedAt: ago(2 * HOUR), project: { slug: "beta", name: "Beta" }, capacity: { code: "rate_limited", observedAt: ago(HOUR) }, failure: { category: "provider_capacity", code: "rate_limited" } }),
    live({ runId: "run_live", startedAt: ago(HOUR), project: { slug: "beta", name: "Beta" } }),
    live({ runId: "run_other", project: { slug: "gamma", name: "Gamma" }, laneId: null, agentId: "auditor-seat" }),
  ], [], [ALPHA, BETA, { slug: "gamma", name: "Gamma", repo: "unknown", branchesObservedAt: null, consultRecords: "unknown" }]);
  const out = derive(snap);
  const project = (slug) => selectOwnerWorkers(snap, out, { now: NOW, project: slug }).map((row) => [row.run.runId, row.attentionIds, row.laneKey]);
  // 限流事项在 anomalies 里；同一运行的 failed 异常照留。两条在 beta 下都查得到。
  assert.deepEqual(project("beta"), [["run_live", [], "glm-pro"], ["run_fail", ["failed:run_fail", "rate_limited:glm-pro"], "glm-pro"]]);
  assert.deepEqual(project("gamma"), [["run_other", [], "auditor-seat"]]);
  assert.deepEqual(project("delta"), []);
  assert.equal(selectOwnerWorkers(snap, out, { now: NOW }).length, 3, "不筛项目就是全部");
});

test("selectOwnerWorkers: 续修运行的标题取谱系根，本轮标题作副标题；根不在快照里只用本轮标题", () => {
  const snap = snapshot([
    run({ runId: "run_root", title: "根任务", terminalAt: ago(30 * HOUR), startedAt: ago(40 * HOUR) }),
    run({ runId: "run_child", title: "第 2 轮", lineageRootRunId: "run_root", terminalAt: ago(30 * HOUR), startedAt: ago(31 * HOUR), delivery: delivered({ settledAt: ago(29 * HOUR) }) }),
    run({ runId: "run_orphan", title: "孤儿续修", lineageRootRunId: "run_gone", terminalAt: ago(30 * HOUR), startedAt: ago(32 * HOUR), delivery: delivered({ settledAt: ago(29 * HOUR) }) }),
    live({ runId: "run_live", title: null, startedAt: ago(60 * HOUR) }),
    run({ runId: "run_plain", title: "普通运行", terminalAt: ago(30 * HOUR), startedAt: ago(33 * HOUR), delivery: delivered({ settledAt: ago(29 * HOUR) }) }),
  ]);
  const rows = selectOwnerWorkers(snap, derive(snap), { now: NOW });
  assert.deepEqual(rows.map((row) => [row.run.runId, row.title, row.subtitle]), [
    ["run_child", "根任务", "第 2 轮"],
    ["run_orphan", "孤儿续修", null],
    ["run_plain", "普通运行", null],
    ["run_live", null, null],
  ]);
  // 根运行自己的 lineageRootRunId 就是自己：不给自己当副标题。
  const rootRows = selectOwnerWorkers(snapshot([run({ runId: "run_root", title: "根任务" })]), derive(snapshot([])), { now: NOW });
  assert.deepEqual(rootRows.map((row) => [row.title, row.subtitle]), [["根任务", null]]);
});

test("ownerLanes: 有运行在跑或有额度事项的车道各一行；车道键回退 agentId", () => {
  const snap = snapshot([
    live({ runId: "run_1" }),
    live({ runId: "run_2" }),
    live({ runId: "run_seat", laneId: null, agentId: "auditor-seat" }),
    exhausted({ laneId: "kimi", agentId: "kimi" }, HOUR, { runId: "run_q" }),
    run({ runId: "run_idle", laneId: "idle", agentId: "idle", terminalAt: ago(HOUR) }), // 没在跑、没额度事项
    unreadable({ runId: "run_u" }),
  ]);
  assert.deepEqual(ownerLanes(snap, derive(snap)), [
    { laneKey: "auditor-seat", running: 1, capacity: null },
    { laneKey: "glm-pro", running: 2, capacity: null },
    { laneKey: "kimi", running: 0, capacity: { kind: "quota_exhausted", state: "open", observedAt: ago(HOUR) } },
  ]);
  // 额度事项只摘要未了结的：同车道之后有运行完成、事项进了"已了结"，车道就不再列出
  // （它既没在跑，也没有未了结的额度事项）。
  const recovered = snapshot([
    exhausted({ laneId: "kimi", agentId: "kimi" }, HOUR, { runId: "run_q" }),
    run({ runId: "run_ok", laneId: "kimi", agentId: "kimi", terminalAt: ago(30 * MINUTE), deliveryRequested: false }),
  ]);
  assert.deepEqual(derive(recovered).resolved.map((item) => item.id), ["capacity:kimi"], "前提：额度事项确已了结");
  assert.deepEqual(ownerLanes(recovered, derive(recovered)), []);
  // 证据超过 6 小时的额度事项是 unknown：照样占着车道的额度摘要。
  const staleQuota = snapshot([exhausted({ laneId: "kimi", agentId: "kimi" }, 7 * HOUR, { runId: "run_q" })]);
  assert.deepEqual(ownerLanes(staleQuota, derive(staleQuota)), [
    { laneKey: "kimi", running: 0, capacity: { kind: "quota_exhausted", state: "unknown", observedAt: ago(7 * HOUR) } },
  ]);
  // 同一车道既有 quota_exhausted 又有 rate_limited：摘要取 since 更晚的那一件；同一时刻
  // quota_exhausted 在前。
  const kimis = { laneId: "kimi", agentId: "kimi" };
  const limitedAt = (runId, observedAgoMs) => exhausted(kimis, observedAgoMs, {
    runId, failure: { category: "provider_capacity", code: "rate_limited" }, capacity: { code: "rate_limited", observedAt: ago(observedAgoMs) },
  });
  const tie = snapshot([exhausted(kimis, HOUR, { runId: "run_q" }), limitedAt("run_r", HOUR)]);
  assert.deepEqual(ownerLanes(tie, derive(tie)), [
    { laneKey: "kimi", running: 0, capacity: { kind: "quota_exhausted", state: "open", observedAt: ago(HOUR) } },
  ]);
  const laterLimited = snapshot([exhausted(kimis, 2 * HOUR, { runId: "run_q" }), limitedAt("run_r", 30 * MINUTE)]);
  assert.deepEqual(ownerLanes(laterLimited, derive(laterLimited)), [
    { laneKey: "kimi", running: 0, capacity: { kind: "rate_limited", state: "open", observedAt: ago(30 * MINUTE) } },
  ]);
  // 只有限流事项（在 anomalies 栏）的车道：照样有额度摘要。
  const limitedOnly = snapshot([limitedAt("run_r", HOUR)]);
  assert.deepEqual(ownerLanes(limitedOnly, derive(limitedOnly)), [
    { laneKey: "kimi", running: 0, capacity: { kind: "rate_limited", state: "open", observedAt: ago(HOUR) } },
  ]);
});
