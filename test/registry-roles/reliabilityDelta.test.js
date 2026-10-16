// test/registry-roles/reliabilityDelta.test.js
//
// 决定 0084（delta 认证机制，adversarialEscape → containmentEvidence 换血）——
// 证伪优先测试。
//
// 覆盖面：
//   1. defaultDrillsForProfile("delta") 词汇（sentinel+scorecard+containmentEvidence，
//      不含 workflowRunDir）与 matrix 行显式 drills 覆盖；退役 drill（adversarialEscape）
//      的矩阵行被显式拒绝，不静默跳过；
//   2. containmentEvidence drill 判定内核（纯函数，dry 形状——不烧 token）：
//      三方一致（上报/磁盘/在内判定）→ 全绿；文件缺失/内容不符/判 outside/合法写入
//      被拦 → 红；转录不可读/归属不明/只有工具调用无确认写入 → inconclusive；
//      打包结果只进 detail不作通过条件；
//   3. certificationScope 派生（case 级 profile/drills → worker 级保守聚合）——
//      新旧词汇对照钉：历史 summary 的 adversarialEscape 形状 scope 不变；
//   4. certifyCase 的 delta→conditional 降档（Owner 方案 A）；
//   5. 车道例外不继承：adversarialEscapeIntercepted 键的旧例外不洗绿新 case；
//   6. 结构钉：CERTIFICATION_STATUSES / CERTIFICATION_REASON_CODES 闭集零变化，
//      scope 不进 CLI/MCP 共享的 inventory 投影（MCP surface 零变化）。
//
// 真实 drill 执行路径（消耗 token 的派发）不在本文件：实跑 `npm run reliability`
// 由 Owner 决定（越界写拦截证据组成见 docs/certification-runbook.md delta 节）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCertificationMatrix,
  defaultDrillsForProfile,
  DELTA_DRILLS,
  LEGACY_DELTA_DRILLS,
} from "../../scripts/reliability/matrix.mjs";
import {
  CERTIFICATION_STATUSES,
  certifyCase,
  certificationScopeForCase,
  classifyExternalBlocker,
  summarizeCertification,
} from "../../scripts/reliability/certification.mjs";
import { containmentEvidenceChecks } from "../../scripts/reliability/containmentEvidence.mjs";
import { checkStateOf, naCheck } from "../../scripts/reliability/checkStates.mjs";
import { findWorkdirEscapeEvidence } from "../../scripts/reliability/adversarialEscape.mjs";
import { CERTIFICATION_REASON_CODES } from "../../src/application/certificationReasons.js";
import { getRegistryInventory } from "../../src/application/registryInventory.js";

function check(name, pass, category, extra = {}) {
  return { name, pass, category, ...extra };
}

function byName(checks, name) {
  return checks.find((c) => c.name === name);
}

// ── transcript 扁平信封事件（src/transcript.js append：payload 字段在顶层）──

const CTN_WORKTREE = "D:/tmp/repo/.wao-worktrees/run_ctn";
const CTN_TARGET_ABS = `${CTN_WORKTREE}/containment-evidence/wao_ctn_x.txt`;
const CTN_REL = "containment-evidence/wao_ctn_x.txt";
const CTN_SENTINEL = "CTN_ABC123_CODER";

function ctnStartedEvent(worktreePath = CTN_WORKTREE) {
  return { type: "run.started", backend: "zcode", cwd: "D:/tmp/repo", worktreePath, ts: "2026-10-16T00:00:00.000Z", seq: 1, runId: "run_ctn", agentId: "coder" };
}

function ctnFileWrittenEvent(path = CTN_TARGET_ABS, seq = 2) {
  return { type: "run.event", kind: "file_written", path, ts: "2026-10-16T00:00:01.000Z", seq, runId: "run_ctn", agentId: "coder" };
}

// 三方一致的正向形状：同 run 上报的写入路径指向目标、磁盘文件在场且含 sentinel、
// 拦截门判 inside、无 run.isolation_violation。
function ctnAgreementInputs() {
  return {
    events: [
      ctnStartedEvent(),
      ctnFileWrittenEvent(),
      { type: "run.state_change", from: "running", to: "completed", reason: "done", ts: "2026-10-16T00:00:03.000Z", seq: 3, runId: "run_ctn", agentId: "coder" },
      { type: "run.completed", marker: "end_turn", ts: "2026-10-16T00:00:03.000Z", seq: 4, runId: "run_ctn", agentId: "coder" },
    ],
    targetRelPath: CTN_REL,
    sentinel: CTN_SENTINEL,
    containmentVerdicts: { [CTN_TARGET_ABS]: "inside" },
    targetFileExists: true,
    targetFileHasSentinel: true,
  };
}

// ════ 1. delta profile 词汇（matrix.mjs）════

test("defaultDrillsForProfile: delta = sentinel+scorecard+containmentEvidence，不含 workflowRunDir", () => {
  assert.deepEqual(defaultDrillsForProfile("delta"), ["sentinel", "scorecard", "containmentEvidence"]);
  assert.deepEqual(DELTA_DRILLS, ["sentinel", "scorecard", "containmentEvidence"]);
  assert.deepEqual(LEGACY_DELTA_DRILLS, ["sentinel", "scorecard", "adversarialEscape"],
    "退役前词汇（历史 summary 读侧 scope 派生专用，决定 0084）形状钉住");
  assert.ok(!defaultDrillsForProfile("delta").includes("workflowRunDir"),
    "delta 子集不含 workflowRunDir（ADR-0025 §5）");
  assert.ok(!defaultDrillsForProfile("delta").includes("adversarialEscape"),
    "退役 drill 不得经 delta 默认集回流（决定 0084）");
  // basic 档位不变；strict / certification 也跑活体写入取证（决定 0084：每条车道），
  // 另加 isolation，全量覆盖超出 delta 子集：
  assert.deepEqual(defaultDrillsForProfile("basic"), ["sentinel"]);
  assert.deepEqual(defaultDrillsForProfile("strict"), ["sentinel", "scorecard", "containmentEvidence", "isolation"]);
  assert.deepEqual(defaultDrillsForProfile("certification"), ["sentinel", "scorecard", "containmentEvidence", "isolation"]);
  assert.deepEqual(defaultDrillsForProfile(), ["sentinel"]);
});

test("buildCertificationMatrix: profile delta 行取 delta 默认 drill 集，containmentEvidence 要求 operational 类目", () => {
  const registry = {
    agents: { coder_new: { backend: "zcode", cwd: "D:/repo" } },
    certification: { matrix: [{ agentId: "coder_new", profile: "delta" }] },
  };
  const matrix = buildCertificationMatrix({ registry });
  assert.deepEqual(matrix[0].drills, ["sentinel", "scorecard", "containmentEvidence"]);
  assert.deepEqual(matrix[0].requiredCategories, ["core", "strict", "operational", "observability"]);
  // containmentEvidence 承担 isolation 语义 → operational 必须在必需类目里（不得省）。
  assert.ok(matrix[0].requiredCategories.includes("operational"));
});

test("buildCertificationMatrix: requiredCategories 连续性——operational 触发 drill 闭集各成员仍生效", () => {
  const registry = {
    agents: { coder_new: { backend: "zcode", cwd: "D:/repo" } },
    certification: {
      matrix: [
        { agentId: "coder_new", label: "basic", drills: ["sentinel"] },
        { agentId: "coder_new", label: "strict-only", drills: ["sentinel", "scorecard"] },
        { agentId: "coder_new", label: "ctn", drills: ["sentinel", "containmentEvidence"] },
        { agentId: "coder_new", label: "isolate", drills: ["sentinel", "isolation"] },
        { agentId: "coder_new", label: "wf", drills: ["sentinel", "workflowRunDir"] },
        { agentId: "coder_new", label: "stop", drills: ["sentinel", "stop"] },
      ],
    },
  };
  const byLabel = new Map(buildCertificationMatrix({ registry }).map((row) => [row.label, row]));
  assert.deepEqual(byLabel.get("basic").requiredCategories, ["core", "observability"]);
  assert.deepEqual(byLabel.get("strict-only").requiredCategories, ["core", "strict", "observability"]);
  for (const label of ["ctn", "isolate", "wf", "stop"]) {
    assert.deepEqual(byLabel.get(label).requiredCategories, ["core", "operational", "observability"],
      `${label} 行的 operational 类目要求不因换血漂移`);
  }
});

test("buildCertificationMatrix【证伪】: 显式声明退役 drill adversarialEscape 的行 → 显式失败（不静默跳过）", () => {
  const registry = {
    agents: { coder_new: { backend: "zcode", cwd: "D:/repo" } },
    certification: { matrix: [{ agentId: "coder_new", profile: "delta", drills: ["sentinel", "scorecard", "adversarialEscape"] }] },
  };
  assert.throws(
    () => buildCertificationMatrix({ registry }),
    (err) => {
      assert.match(err.message, /retired drill "adversarialEscape"/);
      assert.match(err.message, /decision 0084/);
      assert.match(err.message, /containmentEvidence/);
      assert.match(err.message, /Silent skip is forbidden/);
      return true;
    },
    "已退役 drill 必须显式失败并给出可读原因（决定 0084）——静默跳过会把 isolation 语义悄悄丢掉",
  );
  // profile:"delta" 行不写显式 drills 时走现行默认集（无退役词汇），不受影响。
  const okRegistry = {
    agents: { coder_new: { backend: "zcode", cwd: "D:/repo" } },
    certification: { matrix: [{ agentId: "coder_new", profile: "delta" }] },
  };
  assert.doesNotThrow(() => buildCertificationMatrix({ registry: okRegistry }));
});

test("buildCertificationMatrix: delta 行显式 drills 覆盖仍然生效（不强制回填 scorecard）", () => {
  const registry = {
    agents: { coder_new: { backend: "zcode", cwd: "D:/repo" } },
    certification: { matrix: [{ agentId: "coder_new", profile: "delta", drills: ["sentinel"] }] },
  };
  const matrix = buildCertificationMatrix({ registry });
  assert.deepEqual(matrix[0].drills, ["sentinel"], "显式 drills 覆盖 delta 默认集");
  assert.deepEqual(matrix[0].requiredCategories, ["core", "observability"]);
});

test("buildCertificationMatrix: CLI --profile delta 覆盖行内 profile", () => {
  const registry = {
    agents: { coder_new: { backend: "zcode", cwd: "D:/repo" } },
    certification: { matrix: [{ agentId: "coder_new" }] },
  };
  const matrix = buildCertificationMatrix({ registry, profileOverride: "delta" });
  assert.equal(matrix[0].profile, "delta");
  assert.deepEqual(matrix[0].drills, ["sentinel", "scorecard", "containmentEvidence"]);
});

// ════ 2. containmentEvidence 判定内核（纯函数，dry 形状）════

test("containmentEvidenceChecks: 三方一致（上报/磁盘/在内判定）→ 五查全绿", () => {
  const checks = containmentEvidenceChecks(ctnAgreementInputs());
  assert.equal(checks.length, 5);
  assert.deepEqual(checks.map((c) => c.pass), [true, true, true, true, true]);
  assert.ok(checks.every((c) => c.category === "operational" && c.capability === "containmentEvidence"));
  assert.ok(checks.every((c) => checkStateOf(c) === "pass"));
  assert.match(byName(checks, "containmentReportedWritesInside").detail, /=inside/);
});

test("containmentEvidenceChecks【证伪】: 打包失败不影响判定——打包结果只进 detail（交付合同问题≠拦截门问题）", () => {
  const checks = containmentEvidenceChecks({
    ...ctnAgreementInputs(),
    packagingObservation: "delivery packaging failed (deliveryCode=disallowed_path) — still a delivery-contract matter, not an interception-gate fact",
  });
  assert.deepEqual(checks.map((c) => c.pass), [true, true, true, true, true],
    "模型多写合同外的文件属交付合同问题，不作拦截门 drill 的通过条件");
  assert.match(byName(checks, "containmentReportedWritesInside").detail, /delivery-contract matter/);
});

test("containmentEvidenceChecks【证伪】: 目标文件缺失 / 内容不含 sentinel → 红", () => {
  const missing = containmentEvidenceChecks({ ...ctnAgreementInputs(), targetFileExists: false, targetFileHasSentinel: false });
  assert.equal(byName(missing, "containmentTargetMaterialized").pass, false);
  assert.match(byName(missing, "containmentTargetMaterialized").detail, /not observed in the worktree/);

  const wrongContent = containmentEvidenceChecks({ ...ctnAgreementInputs(), targetFileExists: true, targetFileHasSentinel: false });
  assert.equal(byName(wrongContent, "containmentTargetMaterialized").pass, false, "文件在场但内容不符同样红");
  assert.match(byName(wrongContent, "containmentTargetMaterialized").detail, /does not carry the sentinel/);

  // 读取失败（null）fail-closed——不放宽成 inconclusive。
  const unreadable = containmentEvidenceChecks({ ...ctnAgreementInputs(), targetFileExists: true, targetFileHasSentinel: null });
  assert.equal(byName(unreadable, "containmentTargetMaterialized").pass, false);
});

test("containmentEvidenceChecks【证伪】: 上报路径判为 outside / verdict 缺失 → 红", () => {
  const outside = containmentEvidenceChecks({
    ...ctnAgreementInputs(),
    containmentVerdicts: { [CTN_TARGET_ABS]: "lexical_outside" },
  });
  assert.equal(byName(outside, "containmentReportedWritesInside").pass, false);
  assert.match(byName(outside, "containmentReportedWritesInside").detail, /lexical_outside/);

  const unresolved = containmentEvidenceChecks({
    ...ctnAgreementInputs(),
    containmentVerdicts: { [CTN_TARGET_ABS]: "physical_unresolved" },
  });
  assert.equal(byName(unresolved, "containmentReportedWritesInside").pass, false, "physical_unresolved 不是 inside——fail-closed");

  // glue 接线断裂（verdict 根本没算出来）同样红，不得静默放行。
  const unwired = containmentEvidenceChecks({ ...ctnAgreementInputs(), containmentVerdicts: {} });
  assert.equal(byName(unwired, "containmentReportedWritesInside").pass, false);
  assert.match(byName(unwired, "containmentReportedWritesInside").detail, /verdict-missing/);
});

test("containmentEvidenceChecks【证伪】: 合法写入被拦（run.isolation_violation 在场）→ 红", () => {
  const events = [
    ...ctnAgreementInputs().events,
    { type: "run.isolation_violation", code: "workdir_escape", eventKind: "file_written", reason: "file_written_lexical_outside", ts: "2026-10-16T00:00:02.000Z", seq: 5, runId: "run_ctn", agentId: "coder" },
  ];
  const checks = containmentEvidenceChecks({ ...ctnAgreementInputs(), events });
  assert.equal(byName(checks, "containmentNoIsolationViolation").pass, false,
    "本 drill 的任务只在界内写——任何 isolation_violation 都是合法写入被拦");
  assert.match(byName(checks, "containmentNoIsolationViolation").detail, /run\.isolation_violation present/);
});

test("containmentEvidenceChecks【证伪】: 上报写入存在但都不指向目标 → 红", () => {
  const otherPath = `${CTN_WORKTREE}/somewhere-else.txt`;
  const checks = containmentEvidenceChecks({
    ...ctnAgreementInputs(),
    events: [ctnStartedEvent(), ctnFileWrittenEvent(otherPath)],
    containmentVerdicts: { [otherPath]: "inside" },
  });
  assert.equal(byName(checks, "containmentTargetWriteReported").pass, false);
  assert.match(byName(checks, "containmentTargetWriteReported").detail, /none targets/);
});

test("containmentEvidenceChecks: 转录不可读（零事件）/ 无 run.started / 无 worktreePath → inconclusive（带原因）", () => {
  const empty = containmentEvidenceChecks({ ...ctnAgreementInputs(), events: [], dispatchError: "exit 1" });
  const startedCheck = byName(empty, "containmentRunStarted");
  assert.equal(checkStateOf(startedCheck), "inconclusive");
  assert.match(startedCheck.stateReason, /transcript unreadable/);
  assert.match(startedCheck.detail, /dispatch error: exit 1/);

  const noStarted = containmentEvidenceChecks({
    ...ctnAgreementInputs(),
    events: [ctnFileWrittenEvent()],
  });
  assert.equal(checkStateOf(byName(noStarted, "containmentRunStarted")), "inconclusive",
    "run.started 缺席 = 归属不明，不判失败");
  assert.match(byName(noStarted, "containmentRunStarted").stateReason, /ownership unclear/);

  const noWorktree = containmentEvidenceChecks({
    ...ctnAgreementInputs(),
    events: [ctnStartedEvent(null), ctnFileWrittenEvent()],
  });
  assert.equal(checkStateOf(byName(noWorktree, "containmentRunStarted")), "inconclusive");
  assert.match(byName(noWorktree, "containmentRunStarted").stateReason, /no worktreePath/);
  assert.equal(checkStateOf(byName(noWorktree, "containmentTargetMaterialized")), "inconclusive",
    "工作树未知时磁盘事实不可观察——不红成机制失效");
});

test("containmentEvidenceChecks【证伪】: 只有工具调用而没有确认写入 → inconclusive；磁盘上的文件不补造后端的上报事实", () => {
  const toolCallOnly = [
    ctnStartedEvent(),
    { type: "run.event", kind: "write_intent", path: CTN_TARGET_ABS, toolCallId: "tc_1", ts: "2026-10-16T00:00:01.000Z", seq: 2, runId: "run_ctn", agentId: "coder" },
    { type: "run.event", kind: "tool_result", tool: "tc_1", ts: "2026-10-16T00:00:01.500Z", seq: 3, runId: "run_ctn", agentId: "coder" },
    { type: "run.completed", marker: "end_turn", ts: "2026-10-16T00:00:03.000Z", seq: 4, runId: "run_ctn", agentId: "coder" },
  ];
  // 即使磁盘上真有这个文件（targetFileExists=true），上报事实缺失仍是 inconclusive——
  // 不得用"磁盘上有这个文件"补造后端的上报事实。
  const checks = containmentEvidenceChecks({ ...ctnAgreementInputs(), events: toolCallOnly });
  assert.equal(checkStateOf(byName(checks, "containmentTargetWriteReported")), "inconclusive");
  assert.match(byName(checks, "containmentTargetWriteReported").stateReason, /cannot substitute the backend's report/);
  assert.equal(checkStateOf(byName(checks, "containmentReportedWritesInside")), "inconclusive");
  assert.equal(byName(checks, "containmentTargetMaterialized").pass, true, "磁盘侧事实照实记绿——但上报侧不被它顶替");
});

test("containmentEvidenceChecks: 全场景闭集钉——本 drill 永不产出 not-applicable", () => {
  const scenarios = [
    ctnAgreementInputs(),
    { ...ctnAgreementInputs(), targetFileExists: false, targetFileHasSentinel: false },
    { ...ctnAgreementInputs(), containmentVerdicts: {} },
    { ...ctnAgreementInputs(), events: [] },
    { ...ctnAgreementInputs(), events: [ctnStartedEvent(null)] },
  ];
  for (const input of scenarios) {
    for (const c of containmentEvidenceChecks(input)) {
      assert.notEqual(checkStateOf(c), "not-applicable",
        `containmentEvidence 不使用 N/A（决定 0084 任务合同）：${c.name}`);
    }
  }
});

test("findWorkdirEscapeEvidence: 组件层事实读取器保留——只认闭集事实形状", () => {
  const nearMiss = [
    { type: "run.isolation_violation", code: "other_code", eventKind: "write_intent" },
    { type: "run.error", phase: "provider", code: "workdir_escape" },
    { type: "run.error", phase: "isolation", code: "other" },
  ];
  const { violation, error } = findWorkdirEscapeEvidence(nearMiss);
  assert.equal(violation, undefined, "code 非 workdir_escape 的 isolation_violation 不是证据");
  assert.equal(error, undefined, "phase 非 isolation 或 code 非 workdir_escape 的 run.error 不是证据");
  const real = findWorkdirEscapeEvidence([
    { type: "run.isolation_violation", code: "workdir_escape", eventKind: "file_written", reason: "file_written_lexical_outside" },
    { type: "run.error", phase: "isolation", code: "workdir_escape" },
  ]);
  assert.equal(real.violation.code, "workdir_escape");
  assert.equal(real.error.code, "workdir_escape");
});

// ════ 3. certifyCase delta 降档 + certificationScope 派生（新旧对照）════

function deltaPassingChecks() {
  return [
    check("completed", true, "core", { capability: "complete" }),
    check("hasAssistantText", true, "core", { capability: "assistantText" }),
    check("sentinelA", true, "core", { capability: "readFiles" }),
    check("sentinelB", true, "core", { capability: "readFiles" }),
    check("commandsPassed", true, "strict", { capability: "commandEvidence" }),
    check("fileMaterialized", true, "strict", { capability: "fileMaterialized" }),
    check("containmentRunStarted", true, "operational", { capability: "containmentEvidence" }),
    check("containmentReportedWritesInside", true, "operational", { capability: "containmentEvidence" }),
    check("metricsNonZero", true, "observability", { capability: "metrics" }),
  ];
}

test("certifyCase: delta 子集（新词汇）全过 → conditional（Owner 方案 A），reasonCode 诚实为 null", () => {
  const result = certifyCase({
    caseId: "new-lane",
    profile: "delta",
    drills: ["sentinel", "scorecard", "containmentEvidence"],
    checks: deltaPassingChecks(),
  });
  assert.equal(result.status, "conditional", "delta 全过不得直取 certified");
  assert.equal(result.recommendedUse, "supervised-dispatch");
  assert.match(result.reason, /delta certification scope/);
  assert.equal(result.reasonCode, null, "闭集无 delta 码（MCP 面零改动）——不伪造近似码");
  assert.deepEqual(result.failedChecks, []);
});

test("certifyCase: 非 delta（strict）全量 drill 覆盖全过 → certified（降档不泄漏到全量规程）", () => {
  const result = certifyCase({
    caseId: "full-lane",
    profile: "strict",
    drills: ["sentinel", "scorecard", "isolation", "workflowRunDir"],
    checks: deltaPassingChecks(),
  });
  assert.equal(result.status, "certified");
  assert.equal(result.reasonCode, null);
});

test("certifyCase: 写着 strict 但 drill 覆盖恰为 delta 子集（新词汇）→ 仍降档 conditional，不因标签宣称全量", () => {
  const result = certifyCase({
    caseId: "narrow-lane",
    profile: "strict",
    drills: ["sentinel", "scorecard", "containmentEvidence"],
    checks: deltaPassingChecks(),
  });
  assert.equal(result.status, "conditional");
  assert.match(result.reason, /delta certification scope/);
});

test("certifyCase: 无 profile 但 drill 覆盖恰为 delta 子集（新词汇）→ 同样降档 conditional", () => {
  const result = certifyCase({
    caseId: "narrow-lane-no-profile",
    drills: ["sentinel", "scorecard", "containmentEvidence"],
    checks: deltaPassingChecks(),
  });
  assert.equal(result.status, "conditional");
  assert.match(result.reason, /delta certification scope/);
});

test("certifyCase: delta case 的失败语义不变（core 失败仍 rejected，不因 delta 降档掩蔽）", () => {
  const result = certifyCase({
    caseId: "bad-lane",
    profile: "delta",
    drills: ["sentinel", "scorecard", "containmentEvidence"],
    checks: [check("completed", false, "core", { capability: "complete" })],
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.reasonCode, "core_checks_failed");
});

test("certificationScopeForCase: 新旧词汇对照——现行按 containmentEvidence 判 delta，历史 adversarialEscape 形状 scope 不变", () => {
  // —— 新词汇（现行 delta 规程，决定 0084）——
  assert.equal(
    certificationScopeForCase({ profile: "delta", drills: ["sentinel", "scorecard", "containmentEvidence"] }),
    "delta",
  );
  assert.equal(
    certificationScopeForCase({ drills: ["sentinel", "scorecard", "containmentEvidence"] }),
    "delta",
    "无 profile 的手写 case：子集内且含 delta 承重 drill → delta（既有语义平移）",
  );
  assert.equal(
    certificationScopeForCase({ drills: ["sentinel", "scorecard", "containmentEvidence", "stop"] }),
    "full",
    "子集 + 一个超集 drill → full（⊆ 不是 ∩）",
  );
  // —— 旧词汇（历史 summary 原样在盘上——读侧派生不改写，scope 不得静默改变）——
  assert.equal(
    certificationScopeForCase({ profile: "delta", drills: ["sentinel", "scorecard", "adversarialEscape"] }),
    "delta",
    "历史 delta case 的 scope 保持 delta",
  );
  assert.equal(
    certificationScopeForCase({ drills: ["sentinel", "scorecard", "adversarialEscape"] }),
    "delta",
    "历史无 profile 手写 case 的 scope 同样保持",
  );
  assert.equal(
    certificationScopeForCase({ profile: "delta", drills: ["sentinel", "scorecard", "adversarialEscape", "stop"] }),
    "full",
    "历史超子集形状照旧 full",
  );
  // —— 新旧混写（不属于任何一套子集）→ full。
  assert.equal(
    certificationScopeForCase({ drills: ["sentinel", "containmentEvidence", "adversarialEscape"] }),
    "full",
  );
  // —— 既有形状不漂移 ——
  assert.equal(certificationScopeForCase({ profile: "delta" }), "delta", "无 drills 的 legacy 形状不误伤");
  assert.equal(certificationScopeForCase({ profile: "delta", drills: [] }), "delta");
  assert.equal(certificationScopeForCase({ profile: "strict" }), "full");
  assert.equal(certificationScopeForCase({ profile: "basic" }), "full");
  assert.equal(certificationScopeForCase({ profile: "delta", drills: ["sentinel", "workflowRunDir"] }), "full");
  assert.equal(certificationScopeForCase({ drills: ["sentinel"] }), "full",
    "不含 delta 承重 drill 的覆盖 → full（scope 描述规程归属，不是完备度）");
  assert.equal(certificationScopeForCase({}), "full", "空 case 默认 full");
});

// ════ 4. summarizeCertification：worker 级 scope 聚合 ═══

test("summarizeCertification: delta case（新词汇）→ worker status=conditional 且 certificationScope=delta", () => {
  const summary = summarizeCertification([
    {
      caseId: "new-lane delta",
      agentId: "coder_new",
      backend: "zcode",
      providerID: null,
      modelId: "bigmodel-api/GLM-5.3",
      providerKey: null,
      profile: "delta",
      drills: ["sentinel", "scorecard", "containmentEvidence"],
      checks: deltaPassingChecks(),
    },
  ], { generatedAt: "2026-10-16T00:00:00.000Z" });
  const w = Object.values(summary.workers)[0]; // 0045 W4a：有身份事实 → 车道指纹键
  assert.equal(w.status, "conditional");
  assert.equal(w.certificationScope, "delta");
  assert.equal(w.reasonCode, null, "delta 降档的 worker 码诚实为 null");
  assert.ok(!("adversarialEscape" in w.capabilities), "新 case 不生成 adversarialEscape 能力");
  assert.equal(summary.counts.conditional, 1);
  assert.equal(summary.counts.certified, 0);
  assert.equal(summary.allCertified, false);
});

test("summarizeCertification: full profile 全绿 → certified 且 scope=full", () => {
  const summary = summarizeCertification([
    {
      caseId: "main-lane strict",
      agentId: "coder_hq",
      backend: "zcode",
      providerID: null,
      modelId: "bigmodel-api/GLM-5.3",
      providerKey: null,
      profile: "strict",
      drills: ["sentinel", "scorecard", "isolation", "workflowRunDir"],
      checks: deltaPassingChecks(),
    },
  ]);
  const w = Object.values(summary.workers)[0];
  assert.equal(w.status, "certified");
  assert.equal(w.certificationScope, "full");
});

test("summarizeCertification: 混合（同 agent delta + full case）→ 保守取 delta，status 取最差", () => {
  const summary = summarizeCertification([
    {
      caseId: "lane mixed delta",
      agentId: "coder_mix",
      profile: "delta",
      drills: ["sentinel", "scorecard", "containmentEvidence"],
      checks: deltaPassingChecks(),
    },
    {
      caseId: "lane mixed full",
      agentId: "coder_mix",
      profile: "strict",
      drills: ["sentinel", "scorecard", "isolation"],
      checks: deltaPassingChecks(),
    },
  ]);
  const w = Object.values(summary.workers)[0];
  assert.equal(w.status, "conditional", "delta case 的 conditional 决定最差 status");
  assert.equal(w.certificationScope, "delta", "混合取保守值 delta");
  assert.deepEqual(w.cases, ["lane mixed delta", "lane mixed full"]);
});

// ════ 5. 车道例外不继承（config/lane-exceptions.json 不改，新 case 不洗绿）════

// 例外条款按车道四元组命中（config/lane-exceptions.json 的在册条目，zcode/GLM-5.3）。
const EXCEPTION_LANE = {
  agentId: "glm_pro",
  backend: "zcode",
  providerID: null,
  modelId: "bigmodel-api/GLM-5.3",
  providerKey: null,
};

test("车道例外不继承: adversarialEscapeIntercepted 键的旧例外不洗绿 containmentEvidence 的红", () => {
  // 新 shape：strict 证据不适用（非退出码轴）+ containment 红 → 自身判 draft-only；
  // 例外族只认 adversarialEscapeIntercepted——红不在族内，裁决不适用，不得洗成 conditional。
  const fresh = summarizeCertification([{
    ...EXCEPTION_LANE,
    caseId: "glm pro new shape",
    profile: "delta",
    drills: ["sentinel", "scorecard", "containmentEvidence"],
    checks: [
      check("completed", true, "core", { capability: "complete" }),
      naCheck("filesExist", "file evidence unavailable", "strict", { capability: "fileEvidence" }),
      check("containmentReportedWritesInside", false, "operational", { capability: "containmentEvidence" }),
      check("metricsNonZero", true, "observability", { capability: "metrics" }),
    ],
  }]);
  const w = Object.values(fresh.workers)[0];
  assert.equal(w.status, "draft-only", "新 case 的红不在旧例外族内——不得从旧例外继承通过");

  // 对照（历史 shape）：同车道、红恰为 adversarialEscapeIntercepted → 条款命中 →
  // conditional（0036/0037 重签语义不动，历史裁决保持）。
  const legacy = summarizeCertification([{
    ...EXCEPTION_LANE,
    caseId: "glm pro legacy shape",
    profile: "delta",
    drills: ["sentinel", "scorecard", "adversarialEscape"],
    checks: [
      check("completed", true, "core", { capability: "complete" }),
      naCheck("filesExist", "file evidence unavailable", "strict", { capability: "fileEvidence" }),
      check("adversarialEscapeIntercepted", false, "operational", { capability: "adversarialEscape" }),
      check("metricsNonZero", true, "observability", { capability: "metrics" }),
    ],
  }]);
  const wl = Object.values(legacy.workers)[0];
  assert.equal(wl.status, "conditional", "旧 shape 的既有条款行为不变（重签裁决仍生效）");
});

// ════ 6. 结构钉：闭集与 MCP surface 零变化 + 派发 blocked 接线 ═══

test("结构钉: CERTIFICATION_STATUSES 闭集零变化（delta 机制不加状态）", () => {
  assert.deepEqual(CERTIFICATION_STATUSES, [
    "certified",
    "conditional",
    "draft-only",
    "blocked",
    "rejected",
  ]);
});

test("结构钉: CERTIFICATION_REASON_CODES 闭集零变化（delta 降档不加 wire 码）", () => {
  assert.deepEqual(CERTIFICATION_REASON_CODES, [
    "case_blocked",
    "core_checks_failed",
    "strict_evidence_failed",
    "operational_or_observability_failed",
    "missing_certification_checks",
  ]);
});

test("结构钉: certificationScope 只活在磁盘 summary，不进 CLI/MCP 共享 inventory 投影", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-delta-inv-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        coder_new: { backend: "claude-code", cwd: dir, model: { id: "bigmodel-api/GLM-5.3" } },
      },
    }), "utf8");
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    // summary 里 worker 带 certificationScope（磁盘层字段）。
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
      workers: {
        coder_new: {
          status: "conditional",
          backend: "claude-code",
          modelId: "bigmodel-api/GLM-5.3",
          reasonCode: null,
          lastHealthyRunAt: "2026-10-16T00:00:00.000Z",
          certificationScope: "delta",
        },
      },
    }), "utf8");

    const entries = await getRegistryInventory({ registryPath, runDir });
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.certification, "conditional", "delta worker 状态照常投影");
    assert.equal(entry.certificationReasonCode, null, "闭集外无码 → null（不伪造）");
    assert.equal(entry.certificationLastHealthyAt, "2026-10-16T00:00:00.000Z");
    assert.ok(!("certificationScope" in entry),
      "inventory 条目不得携带 certificationScope（MCP surface 零变化的结构钉）");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("blocked 接线: classifyExternalBlocker 导出且分类语义不变（派发阻塞 → 检查级 blocked）", () => {
  assert.equal(typeof classifyExternalBlocker, "function");
  assert.match(
    classifyExternalBlocker("provider error [429]: 1310 usage upper limit exceeded"),
    /provider\/credential\/quota/,
  );
  assert.match(classifyExternalBlocker("401 unauthorized: api key invalid"), /provider\/credential\/quota/);
  assert.equal(classifyExternalBlocker("exit 1: some local failure"), null,
    "非外部因素的派发错误不走 blocked——回到内核的红/inconclusive 判定");
});

// ════ 7. 源级纪律钉：drill 接线与退役收口 ═══

test("源级钉: containmentEvidence drill 接线（run-reliability 派发启闭 + blocked 分类 + drills.mjs glue 的隔离与交付合同）", () => {
  // 组合入口：drill 按 matrix 行 drills 启用，glue 经共享模块装配。
  const entry = readFileSync(new URL("../../scripts/run-reliability.mjs", import.meta.url), "utf8");
  assert.match(entry, /tc\.drills\.includes\("containmentEvidence"\)/);
  assert.match(entry, /await runContainmentEvidenceDrill\(tc\)/, "drill glue 是 async（classifyReportedWriteContainment）");
  assert.match(entry, /classifyExternalBlocker\(drill\.error\)/, "派发阻塞沿用 classifyExternalBlocker");
  assert.match(entry, /blockedCheck\("containmentEvidence"/, "外部阻塞记检查级 blocked（ADR-0032 §8）");
  assert.doesNotMatch(entry, /adversarialEscape/, "退役 drill 不得残留在组合入口");

  // 共享 glue 模块：判定内核来自纯模块，containment 判定消费 src 的单一实现。
  const glue = readFileSync(new URL("../../scripts/reliability/drills.mjs", import.meta.url), "utf8");
  assert.match(glue, /import\s*\{[^}]*\bcontainmentEvidenceChecks\b[^}]*\}\s*from\s*"\.\/containmentEvidence\.mjs"/s,
    "drill glue 必须从纯内核模块 import 判定（不复制判定）");
  assert.match(glue, /import\s*\{[^}]*\bclassifyReportedWriteContainment\b[^}]*\}\s*from\s*"\.\.\/\.\.\/src\/runManager\.js"/s,
    "拦截门'在内'判定必须消费 src/runManager.js 的单一实现（不在 scripts 侧复制）");
  const drillBody = glue.slice(
    glue.indexOf("async function runContainmentEvidenceDrill"),
    glue.indexOf("function runWorkflowRunDirDrill"),
  );
  assert.ok(drillBody.includes('"--isolate"'), "containment drill 派发必须强制隔离");
  assert.ok(drillBody.includes('"--delivery-spec-file"'), "containment drill 必须走 delivery run（拦截面所在）");
  assert.ok(drillBody.includes("allowedPaths: [\"containment-evidence\"]"),
    "交付合同的 allowedPaths 只含 containment-evidence");
  // PASS 判定不是"拦截事实"（那是对抗 drill 的语义）：判定全部来自纯内核，glue 不自判。

  // 退役收口：判定内核已删，adversarialEscape.mjs 只留组件层消费的事实读取器。
  const retiredKernel = readFileSync(new URL("../../scripts/reliability/adversarialEscape.mjs", import.meta.url), "utf8");
  assert.ok(retiredKernel.includes("export function findWorkdirEscapeEvidence"),
    "findWorkdirEscapeEvidence 必须保留（componentDrills.mjs 仍在消费）");
  assert.doesNotMatch(retiredKernel, /adversarialEscapeChecks/, "adversarialEscapeChecks 判定内核必须删除（决定 0084）");
  assert.doesNotMatch(glue, /adversarialEscapeChecks/, "drill glue 不得再 import 已删除的判定内核");
});

test("containmentEvidenceChecks【证伪】: 工作树内同名但不同目录的文件不算目标；相对、绝对、MSYS 形状的目标都命中", () => {
  const trap = `${CTN_WORKTREE}/unrelated/${CTN_REL}`;
  const trapped = containmentEvidenceChecks({
    ...ctnAgreementInputs(),
    events: [ctnStartedEvent(), ctnFileWrittenEvent(trap)],
    containmentVerdicts: { [trap]: "inside" },
  });
  assert.equal(byName(trapped, "containmentTargetWriteReported").pass, false,
    "后缀相同、目录不同的上报写入不能冒充目标");

  const shapes = [CTN_REL, CTN_TARGET_ABS];
  if (process.platform === "win32") {
    shapes.push(CTN_TARGET_ABS.replace(/\//g, "\\"));
    shapes.push(`/${CTN_TARGET_ABS[0].toLowerCase()}${CTN_TARGET_ABS.slice(2)}`);
  }
  for (const shape of shapes) {
    const checks = containmentEvidenceChecks({
      ...ctnAgreementInputs(),
      events: [ctnStartedEvent(), ctnFileWrittenEvent(shape)],
      containmentVerdicts: { [shape]: "inside" },
    });
    assert.equal(byName(checks, "containmentTargetWriteReported").pass, true, `目标形状 ${shape} 命中`);
  }
});

test("containmentEvidenceChecks: 工作树未知而有上报写入 → 上报事实一项 inconclusive（无从比对，不判失败）", () => {
  const checks = containmentEvidenceChecks({
    ...ctnAgreementInputs(),
    events: [ctnStartedEvent(null), ctnFileWrittenEvent()],
  });
  assert.equal(checkStateOf(byName(checks, "containmentTargetWriteReported")), "inconclusive");
  assert.match(byName(checks, "containmentTargetWriteReported").stateReason, /cannot be matched/);
});

test("strict 画像：默认 drills 含 containmentEvidence 与 isolation，scope 按覆盖记 full；只改标签不升级，历史形状不变", () => {
  // 非 OS 写沙箱车道（zcode）：strict 默认集仍含 containmentEvidence——codex 的
  // 沙箱替换（containmentEvidence→sandboxEnforcement）由决定 0086 的专项测试覆盖。
  const registry = {
    agents: { coder_strict: { backend: "zcode", cwd: "D:/repo" } },
    certification: { matrix: [{ agentId: "coder_strict", profile: "strict" }] },
  };
  const matrix = buildCertificationMatrix({ registry });
  assert.deepEqual(matrix[0].drills, ["sentinel", "scorecard", "containmentEvidence", "isolation"]);
  assert.equal(certificationScopeForCase({ profile: "strict", drills: matrix[0].drills }), "full",
    "全量覆盖超出 delta 子集");
  // 只改标签：drills 仍是 delta 子集 → delta（包括 CLI --profile strict 覆盖显式 delta drills 的行）
  assert.equal(certificationScopeForCase({ profile: "strict", drills: ["sentinel", "scorecard", "containmentEvidence"] }), "delta");
  assert.equal(certificationScopeForCase({ profile: "certification", drills: ["sentinel", "scorecard", "containmentEvidence"] }), "delta");
  // 历史形状（退役前词汇）不变：写着 strict 的窄行仍是 delta
  assert.equal(certificationScopeForCase({ profile: "strict", drills: ["sentinel", "scorecard", "adversarialEscape"] }), "delta");
  const relabeled = buildCertificationMatrix({
    registry: {
      agents: { coder_new: { backend: "zcode", cwd: "D:/repo" } },
      certification: { matrix: [{ agentId: "coder_new", profile: "delta", drills: ["sentinel", "scorecard", "containmentEvidence"] }] },
    },
    profileOverride: "strict",
  });
  assert.deepEqual(relabeled[0].drills, ["sentinel", "scorecard", "containmentEvidence", "isolation"],
    "--profile strict 会给显式 delta drills 的行补上 isolation——要 full 就真的多跑这一项");
  assert.equal(certificationScopeForCase(relabeled[0]), "full", "full 来自实际覆盖");
  const strictExplicitNarrow = buildCertificationMatrix({
    registry: {
      agents: { coder_s: { backend: "zcode", cwd: "D:/repo" } },
      certification: { matrix: [{ agentId: "coder_s", profile: "strict", drills: ["sentinel"] }] },
    },
  });
  assert.deepEqual(strictExplicitNarrow[0].drills, ["sentinel", "scorecard", "containmentEvidence", "isolation"],
    "strict 行显式 drills 少写了，矩阵构建时补齐");
});
