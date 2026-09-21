// test/registry-roles/checkStates.test.js
//
// ADR-0032 §8（2026-09-21 落地）：检查结果五态闭集（pass / fail /
// not-applicable / blocked / inconclusive）的一等公民模型测试——证伪优先。
//
// 覆盖面：
//   1. 闭集恰五值（冻结）；
//   2. N/A/blocked/inconclusive 必须带非空原因（构造器当场抛错）；
//   3. checkStateOf 派生：显式 status 优先；legacy 布尔 pass 派生；越闭集抛错；
//   4. pass 与 status 的一致性校验（assertCheckStateShape fail-closed）；
//   5. 组合层消费语义：certifyCase 对 N/A 的类目覆盖/能力跳过/零正向证据守卫、
//      blocked 检查映射 case blocked、inconclusive 不覆盖类目；
//   6. metricsNonZeroCheck 的 N/A 形状（TD-87 症状解除保留 + 能力绿不再伪造）。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHECK_STATES,
  REASONED_CHECK_STATES,
  assertCheckStateShape,
  blockedCheck,
  checkStateOf,
  inconclusiveCheck,
  naCheck,
} from "../../scripts/reliability/checkStates.mjs";
import { certifyCase } from "../../scripts/reliability/certification.mjs";
import { metricsNonZeroCheck } from "../../scripts/reliability/metricsCheck.mjs";

test("closed set: 五态恰五值冻结；REASONED 三态 = N/A/blocked/inconclusive", () => {
  assert.deepEqual([...CHECK_STATES], ["pass", "fail", "not-applicable", "blocked", "inconclusive"]);
  assert.deepEqual([...REASONED_CHECK_STATES], ["not-applicable", "blocked", "inconclusive"]);
});

test("constructors: N/A/blocked/inconclusive 原因必填（空/空白/非字符串当场抛错）", () => {
  for (const ctor of [naCheck, blockedCheck, inconclusiveCheck]) {
    assert.throws(() => ctor("x", "", "core"), /requires a non-empty stateReason/);
    assert.throws(() => ctor("x", "   ", "core"), /requires a non-empty stateReason/);
    assert.throws(() => ctor("x", null, "core"), /requires a non-empty stateReason/);
    const c = ctor("x", "because declared false", "observability", { capability: "metrics" });
    assert.equal(c.pass, false, "三态派生 pass=false——绝不置绿");
    assert.equal(c.stateReason, "because declared false");
    assert.match(c.detail, /because declared false/);
  }
  assert.equal(naCheck("x", "r", "core").state, "not-applicable");
  assert.equal(blockedCheck("x", "r", "core").state, "blocked");
  assert.equal(inconclusiveCheck("x", "r", "core").state, "inconclusive");
});

test("checkStateOf: 显式 status 优先；legacy 布尔派生；越闭集抛错（fail-closed）", () => {
  assert.equal(checkStateOf({ state: "not-applicable", pass: false }), "not-applicable");
  assert.equal(checkStateOf({ pass: true }), "pass");
  assert.equal(checkStateOf({ pass: false }), "fail");
  assert.equal(checkStateOf({}), "fail");
  assert.throws(() => checkStateOf({ state: "skipped", pass: true }), /outside the ADR-0032 §8 closed set/);
  assert.throws(() => checkStateOf({ state: "certified", pass: true }), /outside the ADR-0032 §8 closed set/, "组合层状态词不是检查状态");
});

test("assertCheckStateShape: 三态缺原因抛错；pass 与 status 矛盾抛错；legacy 形状放行", () => {
  assert.throws(() => assertCheckStateShape({ name: "x", state: "not-applicable", pass: false }), /requires a non-empty stateReason/);
  assert.throws(() => assertCheckStateShape({ name: "x", state: "pass", pass: false }), /contradicts state/);
  assert.throws(() => assertCheckStateShape({ name: "x", state: "fail", pass: true }), /contradicts state/);
  assert.equal(assertCheckStateShape({ name: "x", pass: true }), true, "legacy 布尔形状合法");
  assert.equal(assertCheckStateShape({ name: "x", state: "blocked", pass: false, stateReason: "fixture down" }), true);
});

// ── 组合层消费语义（certifyCase）──────────────────────────────────────────────

function baseChecks(extra) {
  return [
    { name: "completed", pass: true, category: "core", capability: "complete" },
    { name: "hasAssistantText", pass: true, category: "core", capability: "assistantText" },
    { name: "commandsPassed", pass: true, category: "strict", capability: "commandEvidence" },
    { name: "isolation", pass: true, category: "operational", capability: "isolation" },
    ...extra,
  ];
}

test("certifyCase: N/A 满足类目覆盖但不贡献能力绿（TD-87 症状解除保留，metrics 绿消失）", () => {
  const na = naCheck("metricsNonZero", "backend declares reportsTokenUsage=false", "observability", { capability: "metrics" });
  const result = certifyCase({
    caseId: "kimi-lane",
    profile: "strict",
    drills: ["sentinel", "scorecard", "isolation"],
    checks: baseChecks([na]),
  });
  assert.equal(result.status, "certified", "类目覆盖由 N/A 满足——不重现 conditional 症状");
  assert.deepEqual(result.failedChecks, [], "N/A 不算失败");
  assert.equal(result.capabilities.metrics, undefined, "N/A 不贡献能力绿（能力轴不被断言）");
  // 对照：pass 形状的同检查仍置能力绿（声明上报的 lane 断言不变）。
  const green = certifyCase({
    caseId: "claude-lane",
    profile: "strict",
    drills: ["sentinel", "scorecard", "isolation"],
    checks: baseChecks([{ name: "metricsNonZero", pass: true, category: "observability", capability: "metrics" }]),
  });
  assert.equal(green.capabilities.metrics, true);
});

test("certifyCase【证伪】: 全 N/A 的 case 不得 certified（零正向证据守卫）", () => {
  const onlyNa = [
    naCheck("metricsNonZero", "declared false", "observability", { capability: "metrics" }),
    naCheck("silentTimeout", "serve down", "operational", { capability: "silentTimeout" }),
  ];
  const result = certifyCase({ caseId: "suite", requiredCategories: ["operational", "observability"], checks: onlyNa });
  assert.equal(result.status, "conditional");
  assert.match(result.reason, /no positive check evidence/);
});

test("certifyCase: 检查级 blocked 映射 case blocked（外部阻塞 ≠ 质量失败）", () => {
  const blocked = blockedCheck("probeX", "fixture infrastructure unavailable", "operational", { capability: "probeX" });
  const result = certifyCase({ caseId: "lane", checks: baseChecks([blocked]) });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /fixture infrastructure unavailable/);
});

test("certifyCase: inconclusive 不覆盖类目 → conditional missing（fail-closed：无法证明即缺）", () => {
  const inconclusive = inconclusiveCheck("metricsNonZero", "usage projection ambiguous", "observability", { capability: "metrics" });
  const result = certifyCase({
    caseId: "lane",
    checks: [
      { name: "completed", pass: true, category: "core", capability: "complete" },
      { name: "commandsPassed", pass: true, category: "strict", capability: "commandEvidence" },
      { name: "isolation", pass: true, category: "operational", capability: "isolation" },
      inconclusive,
    ],
  });
  assert.equal(result.status, "conditional");
  assert.match(result.reason, /missing certification checks: observability/);
});

test("metricsNonZeroCheck: 声明不上报 → N/A 检查（带原因 + 声明值 + input 事实透明）", () => {
  const c = metricsNonZeroCheck({ agent: { backend: "kimi-code", cwd: "D:/x" }, metricsInput: null });
  assert.equal(c.name, "metricsNonZero");
  assert.equal(c.state, "not-applicable");
  assert.equal(c.pass, false, "N/A 绝不置绿");
  assert.match(c.stateReason, /reportsTokenUsage=false \(TD-87 capability declaration\)/);
  assert.match(c.stateReason, /input=null/, "input 事实照常透明");
  assert.equal(c.optional, undefined, "N/A 不得编码为 optional（类目覆盖语义独立承载）");
  // 未知 backend（snapshot=null）→ 同样 N/A（declared=unknown 如实呈现）。
  const unknown = metricsNonZeroCheck({ agent: { backend: "bogus-runtime" }, metricsInput: null });
  assert.equal(unknown.state, "not-applicable");
  assert.match(unknown.stateReason, /reportsTokenUsage=unknown/);
  // 声明上报 → 断言分支形状不变（金丝雀保留）。
  const judged = metricsNonZeroCheck({ agent: { backend: "claude-code", cwd: "D:/x" }, metricsInput: 1234 });
  assert.equal(judged.pass, true);
  assert.equal(judged.state, undefined, "断言分支保持 legacy 两态形状");
  const judgedRed = metricsNonZeroCheck({ agent: { backend: "claude-code", cwd: "D:/x" }, metricsInput: null });
  assert.equal(judgedRed.pass, false);
  assert.equal(judgedRed.detail, "input=null");
});
