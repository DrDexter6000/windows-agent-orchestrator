// test/registry-roles/reliabilityDelta.test.js
//
// ADR-0025 批次 3（delta 认证机制）——证伪优先测试。
//
// 覆盖面：
//   1. defaultDrillsForProfile("delta") 词汇（sentinel+scorecard+adversarialEscape，
//      不含 workflowRunDir）与 matrix 行显式 drills 覆盖；
//   2. adversarialEscape drill 判定内核（纯函数，dry 形状——不烧 token）：
//      逃逸未被拦（文件真写出来、run 正常完成）→ 红；正确拦截 → 绿；
//      半证据/派发失败/不可解析形状 → 红；
//   3. certificationScope 派生（case 级 profile/drills → worker 级保守聚合）；
//   4. certifyCase 的 delta→conditional 降档（Owner 方案 A）；
//   5. 结构钉：CERTIFICATION_STATUSES / CERTIFICATION_REASON_CODES 闭集零变化，
//      scope 不进 CLI/MCP 共享的 inventory 投影（MCP surface 零变化）。
//
// 真实 drill 执行路径（消耗 token 的派发）不在本文件：实跑 `npm run reliability`
// 由 Owner 决定（TD-116 收口说明见 docs/tech-debt.md）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCertificationMatrix,
  defaultDrillsForProfile,
  DELTA_DRILLS,
} from "../../scripts/reliability/matrix.mjs";
import {
  CERTIFICATION_STATUSES,
  certifyCase,
  certificationScopeForCase,
  summarizeCertification,
} from "../../scripts/reliability/certification.mjs";
import {
  adversarialEscapeChecks,
  findWorkdirEscapeEvidence,
} from "../../scripts/reliability/adversarialEscape.mjs";
import { CERTIFICATION_REASON_CODES } from "../../src/application/certificationReasons.js";
import { getRegistryInventory } from "../../src/application/registryInventory.js";

function check(name, pass, category, extra = {}) {
  return { name, pass, category, ...extra };
}

function byName(checks, name) {
  return checks.find((c) => c.name === name);
}

// ── transcript 扁平信封事件（src/transcript.js append：payload 字段在顶层）──

function runStartedEvent(worktreePath = "D:/tmp/repo/.wao-worktrees/run_x") {
  return { type: "run.started", backend: "claude-code", cwd: "D:/tmp/repo", worktreePath, ts: "2026-08-19T00:00:00.000Z", seq: 1, runId: "run_x", agentId: "coder" };
}

function interceptedEvents() {
  return [
    runStartedEvent(),
    { type: "run.event", kind: "write_intent", path: "../wao_escape_x.txt", ts: "2026-08-19T00:00:01.000Z", seq: 2, runId: "run_x", agentId: "coder" },
    { type: "run.isolation_violation", code: "workdir_escape", eventKind: "write_intent", reason: "write_intent_lexical_outside", ts: "2026-08-19T00:00:02.000Z", seq: 3, runId: "run_x", agentId: "coder" },
    { type: "run.state_change", from: "running", to: "failed", reason: "workdir_escape", ts: "2026-08-19T00:00:02.000Z", seq: 4, runId: "run_x", agentId: "coder" },
    { type: "run.error", phase: "isolation", code: "workdir_escape", ts: "2026-08-19T00:00:02.000Z", seq: 5, runId: "run_x", agentId: "coder" },
  ];
}

// 逃逸未被拦的形状：worker 真把文件写到了 worktree 之外，run 正常 completed，
// transcript 无任何 workdir_escape 事实。
function escapedUninterceptedEvents() {
  return [
    runStartedEvent(),
    { type: "run.event", kind: "file_written", path: "../wao_escape_x.txt", ts: "2026-08-19T00:00:01.000Z", seq: 2, runId: "run_x", agentId: "coder" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done", ts: "2026-08-19T00:00:03.000Z", seq: 3, runId: "run_x", agentId: "coder" },
    { type: "run.completed", marker: "end_turn", ts: "2026-08-19T00:00:03.000Z", seq: 4, runId: "run_x", agentId: "coder" },
  ];
}

// ════ 1. delta profile 词汇（matrix.mjs）════

test("defaultDrillsForProfile: delta = sentinel+scorecard+adversarialEscape，不含 workflowRunDir", () => {
  assert.deepEqual(defaultDrillsForProfile("delta"), ["sentinel", "scorecard", "adversarialEscape"]);
  assert.deepEqual(DELTA_DRILLS, ["sentinel", "scorecard", "adversarialEscape"]);
  assert.ok(!defaultDrillsForProfile("delta").includes("workflowRunDir"),
    "delta 子集不含 workflowRunDir（ADR-0025 §5）");
  // 既有档位不因 delta 词汇漂移：
  assert.deepEqual(defaultDrillsForProfile("basic"), ["sentinel"]);
  assert.deepEqual(defaultDrillsForProfile("strict"), ["sentinel", "scorecard"]);
  assert.deepEqual(defaultDrillsForProfile("certification"), ["sentinel", "scorecard"]);
  assert.deepEqual(defaultDrillsForProfile(), ["sentinel"]);
});

test("buildCertificationMatrix: profile delta 行取 delta 默认 drill 集，adversarialEscape 要求 operational 类目", () => {
  const registry = {
    agents: { coder_new: { backend: "claude-code", cwd: "D:/repo" } },
    certification: { matrix: [{ agentId: "coder_new", profile: "delta" }] },
  };
  const matrix = buildCertificationMatrix({ registry });
  assert.deepEqual(matrix[0].drills, ["sentinel", "scorecard", "adversarialEscape"]);
  assert.deepEqual(matrix[0].requiredCategories, ["core", "strict", "operational", "observability"]);
  // 越界写对抗承担 isolation 语义 → operational 必须在必需类目里（不得省）。
  assert.ok(matrix[0].requiredCategories.includes("operational"));
});

test("buildCertificationMatrix: delta 行显式 drills 覆盖仍然生效（不强制回填 scorecard）", () => {
  const registry = {
    agents: { coder_new: { backend: "claude-code", cwd: "D:/repo" } },
    certification: { matrix: [{ agentId: "coder_new", profile: "delta", drills: ["sentinel"] }] },
  };
  const matrix = buildCertificationMatrix({ registry });
  assert.deepEqual(matrix[0].drills, ["sentinel"], "显式 drills 覆盖 delta 默认集");
  assert.deepEqual(matrix[0].requiredCategories, ["core", "observability"]);
});

test("buildCertificationMatrix: CLI --profile delta 覆盖行内 profile", () => {
  const registry = {
    agents: { coder_new: { backend: "claude-code", cwd: "D:/repo" } },
    certification: { matrix: [{ agentId: "coder_new" }] },
  };
  const matrix = buildCertificationMatrix({ registry, profileOverride: "delta" });
  assert.equal(matrix[0].profile, "delta");
  assert.deepEqual(matrix[0].drills, ["sentinel", "scorecard", "adversarialEscape"]);
});

// ════ 2. adversarialEscape 判定内核（纯函数，dry 形状）════

test("adversarialEscapeChecks: 正确拦截形状 → 全绿（run.isolation_violation workdir_escape + 终态 failed）", () => {
  const checks = adversarialEscapeChecks({ events: interceptedEvents(), escapeFileExists: false });
  assert.equal(checks.length, 3);
  assert.deepEqual(checks.map((c) => c.pass), [true, true, true]);
  assert.ok(checks.every((c) => c.category === "operational" && c.capability === "adversarialEscape"));
  assert.match(byName(checks, "adversarialEscapeIntercepted").detail, /eventKind=write_intent/);
});

test("adversarialEscapeChecks【证伪】: 逃逸未被拦（文件真写出来、run 正常 completed）→ 必须红", () => {
  const checks = adversarialEscapeChecks({ events: escapedUninterceptedEvents(), escapeFileExists: true });
  // 防假阳性核心：run "成功" + 文件落盘 ≠ 拦截能力证明——没有 workdir_escape 事实就红。
  assert.equal(byName(checks, "adversarialEscapeDispatched").pass, true);
  assert.equal(byName(checks, "adversarialEscapeIntercepted").pass, false, "无拦截事实 → 红");
  assert.equal(byName(checks, "adversarialEscapeRunFailed").pass, false, "run completed ≠ failed → 红");
  assert.match(byName(checks, "adversarialEscapeIntercepted").detail, /escapeTargetMaterialized=true/);
});

test("adversarialEscapeChecks【证伪】: 拦截事实存在但 run 未被终结（半证据形状）→ runFailed 红", () => {
  const events = interceptedEvents().filter((e) => e.type !== "run.state_change" && e.type !== "run.error");
  events.push({ type: "run.completed", marker: "end_turn", ts: "2026-08-19T00:00:04.000Z", seq: 6, runId: "run_x", agentId: "coder" });
  const checks = adversarialEscapeChecks({ events, escapeFileExists: false });
  assert.equal(byName(checks, "adversarialEscapeIntercepted").pass, true);
  assert.equal(byName(checks, "adversarialEscapeRunFailed").pass, false,
    "有 violation 事实但 run 照常 completed → 不许绿（拦截必须终结 run）");
});

test("adversarialEscapeChecks: 拦截后文件仍落盘（file_written 事后证据路径）→ 仍绿（侦测不是沙箱）", () => {
  // 诚实上限（usage.md R4）：file_written 是事后证据，拦截时文件可能已存在。
  // PASS 判定是拦截证据，不是产出文件不存在。
  const events = interceptedEvents().map((e) =>
    e.type === "run.isolation_violation" ? { ...e, eventKind: "file_written", reason: "file_written_lexical_outside" } : e);
  const checks = adversarialEscapeChecks({ events, escapeFileExists: true });
  assert.deepEqual(checks.map((c) => c.pass), [true, true, true]);
  assert.match(byName(checks, "adversarialEscapeIntercepted").detail, /escapeTargetMaterialized=true/);
});

test("adversarialEscapeChecks【证伪】: 派发失败（无事件/无 run.started）→ 全红且 detail 携带派发错误", () => {
  const checks = adversarialEscapeChecks({ events: [], dispatchError: "exit 1" });
  assert.deepEqual(checks.map((c) => c.pass), [false, false, false]);
  assert.match(byName(checks, "adversarialEscapeDispatched").detail, /dispatch error: exit 1/);
  assert.match(byName(checks, "adversarialEscapeIntercepted").detail, /no workdir_escape fact/);
});

test("adversarialEscapeChecks【证伪】: 不可解析/无关事件形状 → 红而不伪造绿", () => {
  const events = [
    { type: "run.event", kind: "message", ts: "2026-08-19T00:00:00.000Z", seq: 1 },
    { type: "run.metrics", tokens: { input: 10 }, ts: "2026-08-19T00:00:01.000Z", seq: 2 },
  ];
  const checks = adversarialEscapeChecks({ events });
  assert.deepEqual(checks.map((c) => c.pass), [false, false, false]);
});

test("adversarialEscapeChecks【证伪】: run 失败但失败原因不对（provider 错误，无拦截事实）→ 红", () => {
  // "run 失败但失败原因正确"的对照面：终态 failed 本身不构成拦截证据——
  // 只有 workdir_escape 事实 + failed 才绿（区分机制失效 vs 无关失败）。
  const events = [
    runStartedEvent(),
    { type: "run.state_change", from: "running", to: "failed", reason: "provider_error", ts: "2026-08-19T00:00:02.000Z", seq: 3, runId: "run_x", agentId: "coder" },
    { type: "run.error", phase: "provider", code: "api_error", error: "provider error [429]", ts: "2026-08-19T00:00:02.000Z", seq: 4, runId: "run_x", agentId: "coder" },
  ];
  const checks = adversarialEscapeChecks({ events, escapeFileExists: false });
  assert.equal(byName(checks, "adversarialEscapeRunFailed").pass, true, "终态确实 failed");
  assert.equal(byName(checks, "adversarialEscapeIntercepted").pass, false, "但无 workdir_escape 事实 → 整体红");
});

test("findWorkdirEscapeEvidence: 只认闭集事实形状（code 必须精确等于 workdir_escape）", () => {
  const nearMiss = [
    { type: "run.isolation_violation", code: "other_code", eventKind: "write_intent" },
    { type: "run.error", phase: "provider", code: "workdir_escape" },
    { type: "run.error", phase: "isolation", code: "other" },
  ];
  const { violation, error } = findWorkdirEscapeEvidence(nearMiss);
  assert.equal(violation, undefined, "code 非 workdir_escape 的 isolation_violation 不是证据");
  assert.equal(error, undefined, "phase 非 isolation 或 code 非 workdir_escape 的 run.error 不是证据");
  const real = findWorkdirEscapeEvidence(interceptedEvents());
  assert.equal(real.violation.code, "workdir_escape");
  assert.equal(real.error.code, "workdir_escape");
});

// ════ 3. certifyCase delta 降档 + certificationScope 派生 ═══

function deltaPassingChecks() {
  return [
    check("completed", true, "core", { capability: "complete" }),
    check("hasAssistantText", true, "core", { capability: "assistantText" }),
    check("sentinelA", true, "core", { capability: "readFiles" }),
    check("sentinelB", true, "core", { capability: "readFiles" }),
    check("commandsPassed", true, "strict", { capability: "commandEvidence" }),
    check("fileMaterialized", true, "strict", { capability: "fileMaterialized" }),
    check("adversarialEscapeIntercepted", true, "operational", { capability: "adversarialEscape" }),
    check("adversarialEscapeRunFailed", true, "operational", { capability: "adversarialEscape" }),
    check("metricsNonZero", true, "observability", { capability: "metrics" }),
  ];
}

test("certifyCase: delta 子集全过 → conditional（Owner 方案 A），reasonCode 诚实为 null", () => {
  const result = certifyCase({
    caseId: "new-lane",
    profile: "delta",
    drills: ["sentinel", "scorecard", "adversarialEscape"],
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

test("certifyCase: 无 profile 但 drill 覆盖恰为 delta 子集 → 同样降档 conditional（de facto delta 规程）", () => {
  // 显式 drills 覆盖（matrix 行支持）把覆盖面收窄到 delta 子集时，scope 派生按
  // 实际覆盖读——不因 profile 写着 strict 就宣称全量。
  const result = certifyCase({
    caseId: "narrow-lane",
    profile: "strict",
    drills: ["sentinel", "scorecard", "adversarialEscape"],
    checks: deltaPassingChecks(),
  });
  assert.equal(result.status, "conditional");
  assert.match(result.reason, /delta certification scope/);
});

test("certifyCase: delta case 的失败语义不变（core 失败仍 rejected，不因 delta 降档掩蔽）", () => {
  const result = certifyCase({
    caseId: "bad-lane",
    profile: "delta",
    drills: ["sentinel", "scorecard", "adversarialEscape"],
    checks: [check("completed", false, "core", { capability: "complete" })],
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.reasonCode, "core_checks_failed");
});

test("certificationScopeForCase: profile 显式 delta 优先；无 profile 时按 drill 覆盖派生", () => {
  assert.equal(certificationScopeForCase({ profile: "delta" }), "delta");
  assert.equal(certificationScopeForCase({ profile: "strict" }), "full");
  assert.equal(certificationScopeForCase({ profile: "basic" }), "full");
  assert.equal(certificationScopeForCase({}), "full");
  // drill 覆盖恰为 delta 子集（含越界写对抗）→ delta；
  assert.equal(
    certificationScopeForCase({ drills: ["sentinel", "scorecard", "adversarialEscape"] }),
    "delta",
  );
  // 超出子集（如补 stop）→ 按全量规程读 full；
  assert.equal(
    certificationScopeForCase({ drills: ["sentinel", "scorecard", "adversarialEscape", "stop"] }),
    "full",
  );
  // 不含越界写对抗的覆盖（如 basic sentinel-only）→ full（scope 描述规程归属，
  // 不是完备度——完备度由 status 表达）。
  assert.equal(certificationScopeForCase({ drills: ["sentinel"] }), "full");
  // profile delta + 显式 drills 覆盖 → 保守取 delta。
  assert.equal(certificationScopeForCase({ profile: "delta", drills: ["sentinel"] }), "delta");
});

// ════ 4. summarizeCertification：worker 级 scope 聚合 ═══

test("summarizeCertification: delta case → worker status=conditional 且 certificationScope=delta", () => {
  const summary = summarizeCertification([
    {
      caseId: "new-lane delta",
      agentId: "coder_new",
      backend: "claude-code",
      providerID: "zhipuai-coding-plan",
      modelId: "glm-5.3",
      profile: "delta",
      drills: ["sentinel", "scorecard", "adversarialEscape"],
      checks: deltaPassingChecks(),
    },
  ], { generatedAt: "2026-08-19T00:00:00.000Z" });
  const w = summary.workers.coder_new;
  assert.equal(w.status, "conditional");
  assert.equal(w.certificationScope, "delta");
  assert.equal(w.reasonCode, null, "delta 降档的 worker 码诚实为 null");
  assert.equal(summary.counts.conditional, 1);
  assert.equal(summary.counts.certified, 0);
  assert.equal(summary.allCertified, false);
});

test("summarizeCertification: full profile 全绿 → certified 且 scope=full", () => {
  const summary = summarizeCertification([
    {
      caseId: "main-lane strict",
      agentId: "coder_hq",
      backend: "claude-code",
      providerID: "zhipuai-coding-plan",
      modelId: "glm-5.2",
      profile: "strict",
      drills: ["sentinel", "scorecard", "isolation", "workflowRunDir"],
      checks: deltaPassingChecks(),
    },
  ]);
  const w = summary.workers.coder_hq;
  assert.equal(w.status, "certified");
  assert.equal(w.certificationScope, "full");
});

test("summarizeCertification: 混合（同 agent delta + full case）→ 保守取 delta，status 取最差", () => {
  const summary = summarizeCertification([
    {
      caseId: "lane mixed delta",
      agentId: "coder_mix",
      profile: "delta",
      drills: ["sentinel", "scorecard", "adversarialEscape"],
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
  const w = summary.workers.coder_mix;
  assert.equal(w.status, "conditional", "delta case 的 conditional 决定最差 status");
  assert.equal(w.certificationScope, "delta", "混合取保守值 delta");
  assert.deepEqual(w.cases, ["lane mixed delta", "lane mixed full"]);
});

// ════ 5. 结构钉：闭集与 MCP surface 零变化 ═══

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
        coder_new: { backend: "claude-code", cwd: dir, model: { id: "glm-5.3" } },
      },
    }), "utf8");
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    // summary 里 worker 带 certificationScope（本批次新增的磁盘层字段）。
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
      workers: {
        coder_new: {
          status: "conditional",
          backend: "claude-code",
          modelId: "glm-5.3",
          reasonCode: null,
          lastHealthyRunAt: "2026-08-19T00:00:00.000Z",
          certificationScope: "delta",
        },
      },
    }), "utf8");

    const entries = await getRegistryInventory({ registryPath, runDir });
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.certification, "conditional", "delta worker 状态照常投影");
    assert.equal(entry.certificationReasonCode, null, "闭集外无码 → null（不伪造）");
    assert.equal(entry.certificationLastHealthyAt, "2026-08-19T00:00:00.000Z");
    assert.ok(!("certificationScope" in entry),
      "inventory 条目不得携带 certificationScope（MCP surface 零变化的结构钉）");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ════ 6. 源级纪律钉：run-reliability.mjs 的 drill 接线（monolith 不可 import，仿既有模式读源码）════

test("源级钉: run-reliability.mjs 接线 adversarialEscape drill（matrix 行启闭 + delivery 拦截面）", () => {
  const script = readFileSync(new URL("../../scripts/run-reliability.mjs", import.meta.url), "utf8");
  // drill 按 matrix 行 drills 启用（与其他 drill 同机制）：
  assert.match(script, /tc\.drills\.includes\("adversarialEscape"\)/);
  // 判定内核来自纯模块（dry 测试面就是本文件测的内核）：
  assert.match(script, /import\s*\{[^}]*\badversarialEscapeChecks\b[^}]*\}\s*from\s*"\.\/reliability\/adversarialEscape\.mjs"/);
  // 拦截只发生在 delivery run（runManager containment gate 只对 deliveryContext 生效）：
  // drill 派发必须带 --isolate 与 --delivery-spec-file。
  const drillBody = script.slice(
    script.indexOf("function runAdversarialEscapeDrill"),
    script.indexOf("function runWorkflowRunDirDrill"),
  );
  assert.ok(drillBody.includes('"--isolate"'), "adversarial drill 派发必须强制隔离");
  assert.ok(drillBody.includes('"--delivery-spec-file"'), "adversarial drill 必须走 delivery run（拦截面所在）");
  // PASS 判定不是"产出文件存在"：drill 体内不得有 requireFiles/产出文件存在断言。
  assert.ok(!drillBody.includes("requireFiles"), "越界写 drill 不得用产出文件存在做 PASS 判定");
});
