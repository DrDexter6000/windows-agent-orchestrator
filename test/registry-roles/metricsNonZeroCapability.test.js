// test/registry-roles/metricsNonZeroCapability.test.js
//
// TD-87 认证面症状解除（2026-08-20，Owner 批准）：metricsNonZero 检查能力化
// ——证伪优先（falsification-first）测试。
//
// 背景：kimi-code stream-json 无 usage 字段（TD-87），metricsNonZero 断言 input
// 非空使 coder_mm 每轮落 conditional、lastHealthyRunAt 永远 null。旧代码用
// `providerID !== "kimi-for-coding"` 名字分支整个省略检查 → observability 必需
// 类目缺失 → conditional（missing certification checks）。能力化后：检查恒落账，
// 判定源是 ADR-0025 批次 2 的 backendCapabilitySnapshot SSOT。
//
//   T1（能力跳过）：声明 reportsTokenUsage=false（kimi 形状，真 SSOT 路径或
//       快照注入）+ input=null → 检查通过且 detail 明示 not applicable。
//       变异对照：去掉能力门（还原为无条件断言）→ T1 红。
//   T1B（症状解除，认证级）：kernel 产出进 checks → certifyCase 不再因
//       observability 缺失落 conditional；对照面（检查整个不落账）= 旧行为。
//   T2（金丝雀保留）：声明 reportsTokenUsage=true + input=null/0 → 检查红。
//       变异对照：去掉非空断言 → T2 红。
//   T3（判定源结构钉）：run-reliability 的判定源就是 batch 2 snapshot——
//       kernel import backendCapabilitySnapshot（无第二套判定）、drill glue
//       恒推检查（旧 providerID 名字分支必须消失）、五 backend 真实矩阵
//       断言仍由 backendCapabilityValidate.test.js 的 ADR25-B2-MATRIX 承载
//       （本文件引用不重写）。
//
// 分层：纯函数腿直接驱动 kernel（零进程、零 I/O——backendCapabilitySnapshot
// 构造零副作用）；源级钉读 scripts/ 源码（run-reliability.mjs 是执行顶层矩阵
// 的 monolith，不可 import，reliabilityDelta.test.js 同款纪律）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { metricsNonZeroCheck } from "../../scripts/reliability/metricsCheck.mjs";
import { certifyCase } from "../../scripts/reliability/certification.mjs";

// ════ T1: 能力跳过——声明不上报 usage 的 lane 检查通过且明示不适用 ════

test("TD87-CERT-T1: kimi 形状（真 SSOT 路径）+ input=null → 通过 + detail 含 not applicable", () => {
  // 真 registry 条目形状（backendCapabilitySnapshot 只读 agent.backend，
  // 构造零副作用）——不注入快照，走的就是 run-reliability 生产路径。
  const c = metricsNonZeroCheck({ agent: { backend: "kimi-code", cwd: "D:/x" }, metricsInput: null });
  assert.equal(c.name, "metricsNonZero");
  assert.equal(c.pass, true, "声明不上报 usage → 检查跳过（通过落账）");
  assert.equal(c.category, "observability");
  assert.equal(c.capability, "metrics");
  assert.match(c.detail, /not applicable: backend declares reportsTokenUsage=false \(TD-87 capability declaration\)/,
    "detail 明示不适用 + 判定来源（TD-87 能力声明）");
  assert.match(c.detail, /input=null/, "input 事实照常透明");
  // 跳过≠可选检查：optional 未设置——满足 observability 必需类目（certifyCase
  // 的 findMissingRequiredCategories 拒绝 optional 检查顶类目）。
  assert.notEqual(c.optional, true, "跳过不得编码为 optional（否则重现类目缺失症状）");

  // 投影给出 0（而非 null）的同形状：同样跳过——判定源是声明，不是本 run 巧合。
  const zero = metricsNonZeroCheck({ agent: { backend: "kimi-code", cwd: "D:/x" }, metricsInput: 0 });
  assert.equal(zero.pass, true);
  assert.match(zero.detail, /not applicable/);
});

test("TD87-CERT-T1: 快照注入（非 kimi 名的伪造形状）→ 同样跳过（名字分支复活即红）", () => {
  // 伪造 backend 名 + 注入 reportsTokenUsage=false 快照：旧 providerID 名字
  // 分支（或任何按名字白名单的第二套判定）对这个形状不生效。
  const c = metricsNonZeroCheck({
    agent: { backend: "fake-harness", cwd: "D:/x" },
    metricsInput: null,
    capabilitySnapshot: { reportsTokenUsage: false, supportsSessionReuse: false },
  });
  assert.equal(c.pass, true, "快照注入声明 false → 跳过（判定不看名字）");
  assert.match(c.detail, /not applicable: backend declares reportsTokenUsage=false/);
});

test("TD87-CERT-T1: 未知 backend（snapshot=null）→ 严格 !== true 读为跳过（fail 方向钉住）", () => {
  const c = metricsNonZeroCheck({ agent: { backend: "bogus-runtime" }, metricsInput: null });
  assert.equal(c.pass, true, "null 快照的 reportsTokenUsage !== true → 同样跳过（任务裁定的 fail 方向）");
  assert.match(c.detail, /not applicable: backend declares reportsTokenUsage=unknown/);
});

// ════ T1B: 认证级症状解除——checks 恒含 metricsNonZero（pass）不再缺类目 ════

test("TD87-CERT-T1B: kernel 产出进 checks → kimi 形状 case 全绿时 certifyCase 为 certified（非 conditional）", () => {
  const checks = [
    { name: "completed", pass: true, category: "core", capability: "complete" },
    { name: "hasAssistantText", pass: true, category: "core", capability: "assistantText" },
    { name: "sentinelA", pass: true, category: "core", capability: "readFiles" },
    { name: "sentinelB", pass: true, category: "core", capability: "readFiles" },
    { name: "commandsPassed", pass: true, category: "strict", capability: "commandEvidence" },
    { name: "isolation", pass: true, category: "operational", capability: "isolation" },
    metricsNonZeroCheck({ agent: { backend: "kimi-code", cwd: "D:/x" }, metricsInput: null }),
  ];
  const result = certifyCase({
    caseId: "kimi-lane",
    profile: "strict",
    drills: ["sentinel", "scorecard", "isolation"],
    checks,
  });
  assert.equal(result.status, "certified",
    "observability 类目由跳过检查（pass + not applicable）满足——不再 missing → conditional");
  assert.equal(result.capabilities.metrics, true);

  // 对照面（旧行为）：检查整个不落账 → observability 缺失 → conditional。
  // 这正是修复前的症状（lastHealthyRunAt 永远 null 的机制根源）。
  const withoutMetrics = checks.filter((c) => c.name !== "metricsNonZero");
  const old = certifyCase({
    caseId: "kimi-lane",
    profile: "strict",
    drills: ["sentinel", "scorecard", "isolation"],
    checks: withoutMetrics,
  });
  assert.equal(old.status, "conditional");
  assert.match(old.reason, /missing certification checks: observability/);
});

// ════ T2: 金丝雀保留——声明上报 usage 的 lane 断言不变 ════

test("TD87-CERT-T2: 声明 reportsTokenUsage=true + input=null → 检查红（parser 回归金丝雀）", () => {
  const c = metricsNonZeroCheck({ agent: { backend: "claude-code", cwd: "D:/x" }, metricsInput: null });
  assert.equal(c.pass, false, "声明上报 usage 的 lane，input 缺失必须红");
  assert.equal(c.detail, "input=null", "断言分支 detail 形状不变");
  assert.doesNotMatch(c.detail, /not applicable/);
});

test("TD87-CERT-T2: input=0 同样红；input>0 绿（非空断言语义不变）", () => {
  const zero = metricsNonZeroCheck({ agent: { backend: "claude-code", cwd: "D:/x" }, metricsInput: 0 });
  assert.equal(zero.pass, false, "input=0 ≠ 非零");

  const ok = metricsNonZeroCheck({ agent: { backend: "claude-code", cwd: "D:/x" }, metricsInput: 1234 });
  assert.equal(ok.pass, true);
  assert.equal(ok.detail, "input=1234");

  // 快照注入的伪造 true 形状（非 claude 名）同样走断言——判定不看名字。
  const injected = metricsNonZeroCheck({
    agent: { backend: "fake-harness", cwd: "D:/x" },
    metricsInput: null,
    capabilitySnapshot: { reportsTokenUsage: true, supportsSessionReuse: false },
  });
  assert.equal(injected.pass, false, "注入声明 true + input=null → 红（断言对声明生效）");
});

test("TD87-CERT-T2: 认证级——上报 usage 的 lane metrics 断裂仍落 conditional（症状解除不泄漏到金丝雀面）", () => {
  const checks = [
    { name: "completed", pass: true, category: "core", capability: "complete" },
    { name: "commandsPassed", pass: true, category: "strict", capability: "commandEvidence" },
    { name: "isolation", pass: true, category: "operational", capability: "isolation" },
    metricsNonZeroCheck({ agent: { backend: "claude-code", cwd: "D:/x" }, metricsInput: null }),
  ];
  const result = certifyCase({
    caseId: "claude-lane",
    profile: "strict",
    drills: ["sentinel", "scorecard", "isolation"],
    checks,
  });
  assert.equal(result.status, "conditional", "observability 失败语义不变");
  assert.deepEqual(result.failedChecks.map((c) => c.name), ["metricsNonZero"]);
  assert.equal(result.capabilities.metrics, false);
});

// ════ T3: 判定源结构钉——run-reliability 消费的就是 batch 2 snapshot ════

test("TD87-CERT-T3: 源级钉——run-reliability 经 metricsCheck.mjs 消费 SSOT，恒推检查、名字分支消失", () => {
  const script = readFileSync(new URL("../../scripts/run-reliability.mjs", import.meta.url), "utf8");
  // 判定内核来自纯模块（本文件测的内核）：
  assert.match(script, /import\s*\{[^}]*\bmetricsNonZeroCheck\b[^}]*\}\s*from\s*"\.\/reliability\/metricsCheck\.mjs"/,
    "run-reliability.mjs 必须从 ./reliability/metricsCheck.mjs import 判定内核");
  // sentinel drill 内恒推检查（无 providerID/名字条件包裹）：
  const sentinelBody = script.slice(
    script.indexOf('if (tc.drills.includes("sentinel"))'),
    script.indexOf('if (tc.drills.includes("scorecard"))'),
  );
  assert.match(sentinelBody, /checks\.push\(metricsNonZeroCheck\(\{/,
    "metricsNonZero 检查必须无条件落账（能力门在 kernel 内，不在 glue 层）");
  // 旧名字分支（第二套判定）必须消失：
  assert.ok(!script.includes("kimi-for-coding"),
    "run-reliability.mjs 不得残留 providerID 名字分支（判定源唯一 = 能力声明）");
});

test("TD87-CERT-T3: 源级钉——metricsCheck.mjs 的判定源是 backendCapabilitySnapshot（无第二套判定）", () => {
  const kernel = readFileSync(new URL("../../scripts/reliability/metricsCheck.mjs", import.meta.url), "utf8");
  assert.match(kernel, /import\s*\{\s*backendCapabilitySnapshot\s*\}\s*from\s*"\.\.\/\.\.\/src\/backends\/factory\.js"/,
    "kernel 必须消费 ADR-0025 批次 2 SSOT（src/backends/factory.js）");
  assert.ok(!/"(?:kimi-code|claude-code|codex|deepseek-harness|opencode-serve)"/.test(kernel),
    "kernel 代码不得含 backend 名字字面量分支（声明是唯一判定源；注释提及形状不算分支）");
  assert.ok(!/\bproviderID\b/.test(kernel), "kernel 不得读 providerID（名字分支复活即红）");
});

test("TD87-CERT-T3: 五 backend 真实矩阵不漂移仍由 ADR25-B2-MATRIX 承载（引用不重写）", () => {
  // 真实矩阵断言（五个 backend 的 snapshot = 类声明）已在
  // test/registry-roles/backendCapabilityValidate.test.js 的 ADR25-B2-MATRIX——
  // 本文件只引用。此钉守住"引用仍存在且覆盖五 backend"（被删/被收窄即红，
  // 提示本文件的 kimi/claude 形状前提失去真实矩阵锚）。
  const matrixTest = readFileSync(new URL("./backendCapabilityValidate.test.js", import.meta.url), "utf8");
  assert.match(matrixTest, /ADR25-B2-MATRIX/, "ADR25-B2-MATRIX 矩阵断言必须存在");
  for (const backend of ["claude-code", "codex", "kimi-code", "deepseek-harness", "opencode-serve"]) {
    assert.ok(matrixTest.includes(`"${backend}"`), `MATRIX 断言必须覆盖 ${backend}`);
  }
});
