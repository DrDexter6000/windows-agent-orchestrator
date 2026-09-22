import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  certifyCase,
  summarizeCertification,
  mergeCaseResults,
  pruneStaleCases,
} from "../../scripts/reliability/certification.mjs";
import { inconclusiveCheck, naCheck } from "../../scripts/reliability/checkStates.mjs";
import {
  drillTranscriptsDir,
  collectReferencedDrillRunIds,
  missingDrillTranscripts,
  nullUnresolvableDrillRunIds,
  pruneUnreferencedDrillTranscripts,
} from "../../scripts/reliability/drillEvidence.mjs";

function check(name, pass, category, extra = {}) {
  return { name, pass, category, ...extra };
}

test("run-reliability imports child_process APIs it uses", () => {
  const script = readFileSync(new URL("../../scripts/run-reliability.mjs", import.meta.url), "utf8");
  if (/\bexecFileSync\s*\(/.test(script)) {
    assert.match(script, /import\s*\{[^}]*\bexecFileSync\b[^}]*\}\s*from\s*"node:child_process"/s,
      "scripts/run-reliability.mjs 调用 execFileSync 时必须显式导入，避免 isolation drill 在真实 gate 才失败");
  }
});

test("certifyCase: all core, strict, operational, and observability checks pass -> certified", () => {
  const result = certifyCase({
    caseId: "claude+deepseek",
    checks: [
      check("completed", true, "core", { capability: "complete" }),
      check("hasAssistantText", true, "core", { capability: "assistantText" }),
      check("sentinelRead", true, "core", { capability: "readFiles" }),
      check("commandsPassed", true, "strict", { capability: "commandEvidence" }),
      check("filesExist", true, "strict", { capability: "fileEvidence" }),
      check("backendStopQuietVerified", true, "operational", { capability: "backendStopQuiet" }),
      check("metricsNonZero", true, "observability", { capability: "metrics" }),
    ],
  });

  assert.equal(result.status, "certified");
  assert.equal(result.recommendedUse, "strict-dispatch");
  assert.equal(result.capabilities.commandEvidence, true);
  assert.equal(result.capabilities.backendStopQuiet, true);
  assert.equal(result.capabilities.metrics, true);
  assert.deepEqual(result.failedChecks, []);
});

test("certifyCase: failed core check rejects the runtime/model combination", () => {
  const result = certifyCase({
    caseId: "opencode+bad-model",
    checks: [
      check("completed", false, "core", { capability: "complete" }),
      check("commandsPassed", true, "strict", { capability: "commandEvidence" }),
    ],
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.recommendedUse, "do-not-dispatch");
  assert.deepEqual(result.failedChecks.map((c) => c.name), ["completed"]);
});

test("certifyCase: core passes but strict evidence fails -> draft-only", () => {
  const result = certifyCase({
    caseId: "opencode+deepseek",
    checks: [
      check("completed", true, "core", { capability: "complete" }),
      check("hasAssistantText", true, "core", { capability: "assistantText" }),
      check("commandsPassed", false, "strict", { capability: "commandEvidence" }),
    ],
  });

  assert.equal(result.status, "draft-only");
  assert.equal(result.recommendedUse, "draft-only");
  assert.equal(result.capabilities.commandEvidence, false);
});

test("certifyCase F1: required strict N/A stays draft-only without becoming a quality failure", () => {
  const result = certifyCase({
    caseId: "deepseek-acp delta",
    checks: [
      check("completed", true, "core", { capability: "complete" }),
      naCheck(
        "commandsPassed",
        "backend declares reportsCommandExitCode=false",
        "strict",
        { capability: "commandEvidence" },
      ),
      check("isolation", true, "operational", { capability: "isolation" }),
      check("metricsNonZero", true, "observability", { capability: "metrics" }),
    ],
  });

  assert.equal(result.status, "draft-only");
  assert.equal(result.recommendedUse, "draft-only");
  assert.deepEqual(result.failedChecks, [], "N/A is an unavailable qualification axis, not a judged failure");
  assert.equal(result.capabilities.commandEvidence, undefined, "N/A must not create a green or red capability claim");
  assert.match(result.reason, /strict certification evidence is not applicable/i);
});

test("certifyCase G2: required strict inconclusive stays draft-only and does not become a judged failure", () => {
  const result = certifyCase({
    caseId: "deepseek-acp evidence unavailable",
    checks: [
      check("completed", true, "core", { capability: "complete" }),
      inconclusiveCheck(
        "commandsPassed",
        "the harness evidence is missing or unparseable, so command-exit capability is not established",
        "strict",
        { capability: "commandEvidence" },
      ),
      check("isolation", true, "operational", { capability: "isolation" }),
      check("metricsNonZero", true, "observability", { capability: "metrics" }),
    ],
  });

  assert.equal(result.status, "draft-only", "缺关键 strict 证据不得从 dsh 的 draft-only 语义升档");
  assert.equal(result.recommendedUse, "draft-only");
  assert.deepEqual(result.failedChecks, [], "inconclusive 是证据不足，不是已证实的能力失败");
  assert.equal(result.capabilities.commandEvidence, undefined, "inconclusive 不得生成能力绿或红");
  assert.match(result.reason, /strict certification evidence is inconclusive/i);
});

test("certifyCase F1: an all-N/A default case cannot enter the dispatchable set", () => {
  const result = certifyCase({
    caseId: "all-na",
    checks: [
      naCheck("core", "unavailable", "core"),
      naCheck("strict", "unavailable", "strict"),
      naCheck("operational", "unavailable", "operational"),
      naCheck("observability", "unavailable", "observability"),
    ],
  });

  assert.equal(result.status, "draft-only");
  assert.equal(result.recommendedUse, "draft-only");
});

test("certifyCase F2: malformed explicit check state is rejected at the composition boundary", () => {
  assert.throws(
    () => certifyCase({
      caseId: "malformed-na",
      checks: [
        check("core", true, "core"),
        check("strict", true, "strict"),
        check("operational", true, "operational"),
        { name: "bad-na", pass: true, state: "not-applicable", category: "observability" },
      ],
    }),
    /state "not-applicable" requires a non-empty stateReason|contradicts state/,
  );

  assert.throws(
    () => summarizeCertification([{
      caseId: "malformed-cached-case",
      checks: [{ name: "bad-na", pass: true, state: "not-applicable", category: "strict" }],
      certification: { status: "certified", recommendedUse: "strict-dispatch", capabilities: {}, failedChecks: [] },
    }]),
    /state "not-applicable" requires a non-empty stateReason|contradicts state/,
    "a cached on-disk certification must not bypass five-state shape validation",
  );
});

test("certifyCase: core-only sentinel pass is conditional, not strict certified", () => {
  const result = certifyCase({
    caseId: "sentinel-only",
    checks: [
      check("completed", true, "core", { capability: "complete" }),
      check("hasAssistantText", true, "core", { capability: "assistantText" }),
      check("sentinelRead", true, "core", { capability: "readFiles" }),
    ],
  });

  assert.equal(result.status, "conditional");
  assert.equal(result.recommendedUse, "supervised-dispatch");
  assert.match(result.reason, /strict/i);
});

test("certifyCase: core and strict pass but ops or metrics fail -> conditional", () => {
  const result = certifyCase({
    caseId: "claude+deepseek",
    checks: [
      check("completed", true, "core", { capability: "complete" }),
      check("commandsPassed", true, "strict", { capability: "commandEvidence" }),
      check("backendStopQuietVerified", false, "operational", { capability: "backendStopQuiet" }),
      check("metricsNonZero", false, "observability", { capability: "metrics" }),
    ],
  });

  assert.equal(result.status, "conditional");
  assert.equal(result.recommendedUse, "supervised-dispatch");
  assert.equal(result.capabilities.backendStopQuiet, false);
  assert.equal(result.capabilities.metrics, false);
});

test("certifyCase: local stop ledger is not backend stop quietness", () => {
  const result = certifyCase({
    caseId: "opencode-stop",
    checks: [
      check("completed", true, "core", { capability: "complete" }),
      check("commandsPassed", true, "strict", { capability: "commandEvidence" }),
      check("localStopStateAborted", true, "operational", { capability: "localStopLedger" }),
      check("backendStopQuietVerified", false, "operational", { capability: "backendStopQuiet" }),
      check("metricsNonZero", true, "observability", { capability: "metrics" }),
    ],
  });

  assert.equal(result.status, "conditional");
  assert.equal(result.recommendedUse, "supervised-dispatch");
  assert.equal(result.capabilities.localStopLedger, true);
  assert.equal(result.capabilities.backendStopQuiet, false);
});

test("certifyCase: provider or quota failures are blocked, not rejected", () => {
  const result = certifyCase({
    caseId: "glm-5.2",
    error: "provider error [429]: 1310 usage upper limit exceeded",
    checks: [
      check("completed", false, "core", { capability: "complete" }),
    ],
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.recommendedUse, "blocked");
  assert.match(result.reason, /provider\/credential\/quota/i);
});

test("certifyCase: caller can override recommendedUse for suite-level checks", () => {
  const result = certifyCase({
    caseId: "silentTimeout",
    requiredCategories: ["operational"],
    recommendedUse: "suite-operational-check",
    checks: [
      check("silentTimeout", true, "operational", { capability: "silentTimeout" }),
    ],
  });

  assert.equal(result.status, "certified");
  assert.equal(result.recommendedUse, "suite-operational-check");
});

test("summarizeCertification: returns versioned cases and status counts", () => {
  const summary = summarizeCertification([
    {
      caseId: "a",
      checks: [
        check("completed", true, "core"),
        check("commandsPassed", true, "strict"),
        check("backendStopQuietVerified", true, "operational"),
        check("metricsNonZero", true, "observability"),
      ],
    },
    {
      caseId: "b",
      checks: [check("completed", false, "core")],
    },
  ], { generatedAt: "2026-06-18T00:00:00.000Z" });

  assert.equal(summary.version, 1);
  assert.equal(summary.generatedAt, "2026-06-18T00:00:00.000Z");
  assert.equal(summary.counts.certified, 1);
  assert.equal(summary.counts.rejected, 1);
  assert.equal(summary.allCertified, false);
  assert.equal(summary.cases.length, 2);
});

test("summarizeCertification: aggregates agent cases into worker capability summary", () => {
  const summary = summarizeCertification([
    {
      caseId: "researcher strict",
      agentId: "researcher",
      backend: "opencode-serve",
      providerID: "deepseek",
      modelId: "deepseek-v4-flash",
      checks: [
        check("completed", true, "core", { capability: "complete" }),
        check("commandsPassed", true, "strict", { capability: "commandEvidence" }),
        check("backendStopQuietVerified", true, "operational", { capability: "backendStopQuiet" }),
        check("metricsNonZero", true, "observability", { capability: "metrics" }),
      ],
    },
    {
      caseId: "researcher isolate",
      agentId: "researcher",
      checks: [
        check("completed", true, "core", { capability: "complete" }),
        check("isolation", false, "operational", { capability: "isolation" }),
        check("metricsNonZero", true, "observability", { capability: "metrics" }),
      ],
    },
    {
      caseId: "silentTimeout",
      checks: [
        check("silentTimeout", true, "operational", { capability: "silentTimeout" }),
      ],
    },
  ]);

  assert.deepEqual(Object.keys(summary.workers), ["researcher"]);
  assert.equal(summary.workers.researcher.status, "conditional");
  assert.equal(summary.workers.researcher.recommendedUse, "supervised-dispatch");
  assert.equal(summary.workers.researcher.backend, "opencode-serve");
  assert.equal(summary.workers.researcher.providerID, "deepseek");
  assert.equal(summary.workers.researcher.modelId, "deepseek-v4-flash");
  assert.equal(summary.workers.researcher.capabilities.complete, true);
  assert.equal(summary.workers.researcher.capabilities.commandEvidence, true);
  assert.equal(summary.workers.researcher.capabilities.isolation, false);
  assert.deepEqual(summary.workers.researcher.cases, ["researcher strict", "researcher isolate"]);
});

test("summarizeCertification: counts 反映 per-agent 最终状态（非 per-case 重复计数）", () => {
  // bug：原 counts 按 case 累加（一个 agent 多 case → 被计多次），
  // 与 workers（按 agent 聚合，取 worseStatus）不一致 → counts 看起来像 worker 数但实际是 case 数。
  // 修复后：counts 按 agent 最终状态计数（与 workers 一致）。
  // 场景：agent A 有 2 个 case 都 conditional，agent B 1 个 case rejected。
  //   per-case counts（错）= conditional:2, rejected:1（看起来 2 个 conditional worker）
  //   per-agent counts（对）= conditional:1, rejected:1（实际 1 个 conditional worker）
  const summary = summarizeCertification([
    { caseId: "a-1", agentId: "a", checks: [check("completed", true, "core"), check("isolation", false, "operational", { capability: "isolation" })] },
    { caseId: "a-2", agentId: "a", checks: [check("completed", true, "core"), check("isolation", false, "operational", { capability: "isolation" })] },
    { caseId: "b-1", agentId: "b", checks: [check("completed", false, "core")] },
  ]);
  // workers 应是 2 个（a=conditional, b=rejected）
  assert.equal(Object.keys(summary.workers).length, 2, "应聚合为 2 个 worker");
  assert.equal(summary.workers.a.status, "conditional");
  assert.equal(summary.workers.b.status, "rejected");
  // counts 应按 agent 最终状态（conditional:1, rejected:1），不是按 case（conditional:2）
  assert.equal(summary.counts.conditional, 1, "conditional 应按 agent 计数=1（非 per-case 的 2）");
  assert.equal(summary.counts.rejected, 1);
  assert.equal(summary.counts.certified, 0);
});

// --- summarizeWorkers: identity 迁移语义（backend+model 绑定不被旧 identity 掩盖） ---
// 缺陷：summarizeWorkers 按 agentId 聚合全部历史 case 并保留"首个"case 的 backend/model，
// 导致后来认证的 deepseek-harness case 被旧 claude-code identity 掩盖。
// 修复语义：agent 的 active identity = 最近一次观察到的 backend+providerID+modelId；
// 只聚合 active identity 的 case（status/capabilities/cases），历史 case 保留在 summary.cases。

test("summarizeWorkers: 最近观察的 backend+model identity 为 active；旧 identity 失败 case 不拖低状态", () => {
  const summary = summarizeCertification([
    // 历史：claude-code 身份，core 失败 → rejected（旧 identity，最早观察）
    {
      caseId: "coder_low claude legacy",
      agentId: "coder_low",
      backend: "claude-code",
      providerID: "anthropic",
      modelId: "sonnet-4.5",
      checks: [check("completed", false, "core")],
    },
    // 当前：deepseek-harness 身份，全过 → certified（最近观察）
    {
      caseId: "coder_low deepseek-harness",
      agentId: "coder_low",
      backend: "deepseek-harness",
      providerID: "deepseek",
      modelId: "deepseek-v4-flash",
      checks: [
        check("completed", true, "core", { capability: "complete" }),
        check("commandsPassed", true, "strict", { capability: "commandEvidence" }),
        check("isolation", true, "operational", { capability: "isolation" }),
        check("metricsNonZero", true, "observability", { capability: "metrics" }),
      ],
    },
  ]);

  const w = summary.workers.coder_low;
  assert.equal(w.backend, "deepseek-harness", "active identity 的 backend 应为最近观察的 deepseek-harness");
  assert.equal(w.providerID, "deepseek");
  assert.equal(w.modelId, "deepseek-v4-flash");
  assert.equal(w.status, "certified", "旧 claude-code rejected 不得拖低 active identity 状态");
  assert.equal(w.capabilities.isolation, true);
  assert.deepEqual(w.cases, ["coder_low deepseek-harness"], "只聚合 active identity 的 case");
  // counts/allCertified 按 active identity 最终状态计
  assert.equal(summary.counts.certified, 1);
  assert.equal(summary.counts.rejected, 0);
  assert.equal(summary.allCertified, true);
  // 历史 case 不丢：仍在 summary.cases
  assert.equal(summary.cases.length, 2, "旧 identity 的历史 case 保留在 summary.cases");
});

test("summarizeWorkers: 相同 identity 的多 case 聚合进 active summary；旧 identity 历史 case 不进入", () => {
  const summary = summarizeCertification([
    // 最早：claude-code 身份（历史，不该进入 deepseek-harness active 聚合）
    {
      caseId: "coder_low claude",
      agentId: "coder_low",
      backend: "claude-code",
      providerID: "anthropic",
      modelId: "sonnet-4.5",
      checks: [check("completed", true, "core", { capability: "complete" })],
    },
    // 最近观察的 identity 组：deepseek-harness 两个同 identity case，应整体聚合
    {
      caseId: "coder_low dh isolate",
      agentId: "coder_low",
      backend: "deepseek-harness",
      providerID: "deepseek",
      modelId: "deepseek-v4-flash",
      checks: [
        check("completed", true, "core", { capability: "complete" }),
        check("isolation", false, "operational", { capability: "isolation" }),
      ],
    },
    {
      caseId: "coder_low dh strict",
      agentId: "coder_low",
      backend: "deepseek-harness",
      providerID: "deepseek",
      modelId: "deepseek-v4-flash",
      checks: [
        check("completed", true, "core", { capability: "complete" }),
        check("commandsPassed", true, "strict", { capability: "commandEvidence" }),
        check("metricsNonZero", true, "observability", { capability: "metrics" }),
      ],
    },
  ]);

  const w = summary.workers.coder_low;
  assert.equal(w.backend, "deepseek-harness", "active identity 取最近观察，而非首个 claude-code");
  assert.equal(w.providerID, "deepseek");
  assert.equal(w.modelId, "deepseek-v4-flash");
  // 同 identity 多 case 聚合：worseStatus(certified, conditional) = conditional，capabilities 合并
  assert.equal(w.status, "conditional");
  assert.equal(w.capabilities.isolation, false, "来自同 identity 第一个 case");
  assert.equal(w.capabilities.commandEvidence, true, "来自同 identity 第二个 case");
  assert.deepEqual(w.cases, ["coder_low dh isolate", "coder_low dh strict"], "claude 历史 case 不进入 active cases");
  // 历史不丢
  assert.deepEqual(summary.cases.map((c) => c.caseId).sort(), ["coder_low claude", "coder_low dh isolate", "coder_low dh strict"]);
});

// --- mergeCaseResults: 增量合并，解决单跑覆盖 summary 的数据完整性缺口 ---
// 背景：summarizeCertification 只基于本次 case 构建 summary，不读磁盘旧值。
// 后果：单跑 --agent X 会覆盖掉其他 worker 的认证结果。
// mergeCaseResults(prior, fresh) 把磁盘旧 case 与本次 case 合并：本次覆盖同 caseId（重认证刷新），
// 保留未重跑的旧 case（避免丢失）。合并结果再喂给 summarizeCertification。

test("mergeCaseResults: 本次 case 覆盖同 caseId 的旧 case（重认证刷新）", () => {
  // 旧 case: coder_hq rejected（上次 529）
  const prior = [
    { caseId: "GLM-5.2 high", agentId: "coder_hq", checks: [check("completed", false, "core")] },
  ];
  // 本次重跑: 同 caseId 现在四类全过
  const fresh = [
    { caseId: "GLM-5.2 high", agentId: "coder_hq", checks: [check("completed", true, "core"), check("commandsPassed", true, "strict"), check("isolation", true, "operational", { capability: "isolation" }), check("metricsNonZero", true, "observability")] },
  ];
  const merged = mergeCaseResults(prior, fresh);
  assert.equal(merged.length, 1, "同 caseId 不应重复");
  assert.equal(merged[0].caseId, "GLM-5.2 high");
  // 刷新后的状态应反映本次（certified），而非旧的 rejected
  const summary = summarizeCertification(merged);
  assert.equal(summary.workers.coder_hq.status, "certified", "重认证刷新后应为 certified");
});

test("mergeCaseResults: 未重跑的旧 case 保留（不丢失其他 worker）", () => {
  // 这正是单跑 auditor 覆盖 summary 的 bug 场景：5 个 worker 已认证，单独重跑 auditor
  const prior = [
    { caseId: "researcher case", agentId: "researcher", checks: [check("completed", true, "core"), check("commandsPassed", true, "strict"), check("isolation", true, "operational", { capability: "isolation" }), check("metricsNonZero", true, "observability")] },
    { caseId: "coder_low case", agentId: "coder_low", checks: [check("completed", true, "core"), check("commandsPassed", true, "strict"), check("isolation", true, "operational", { capability: "isolation" }), check("metricsNonZero", true, "observability")] },
    { caseId: "auditor case", agentId: "auditor", checks: [check("completed", false, "core")] }, // 旧：rejected
  ];
  // 本次只重跑 auditor（修复了）
  const fresh = [
    { caseId: "auditor case", agentId: "auditor", checks: [check("completed", true, "core"), check("commandsPassed", true, "strict"), check("isolation", true, "operational", { capability: "isolation" }), check("metricsNonZero", true, "observability")] },
  ];
  const merged = mergeCaseResults(prior, fresh);
  // 关键断言：researcher 和 coder_low 没丢
  const summary = summarizeCertification(merged);
  assert.deepEqual(Object.keys(summary.workers).sort(), ["auditor", "coder_low", "researcher"], "未重跑的 worker 必须保留");
  assert.equal(summary.workers.researcher.status, "certified", "researcher 仍 certified");
  assert.equal(summary.workers.coder_low.status, "certified", "coder_low 仍 certified");
  assert.equal(summary.workers.auditor.status, "certified", "auditor 被刷新为 certified");
});

test("mergeCaseResults: 全新 caseId 追加（纯增量）", () => {
  const prior = [
    { caseId: "old", agentId: "researcher", checks: [check("completed", true, "core")] },
  ];
  const fresh = [
    { caseId: "new", agentId: "tester", checks: [check("completed", true, "core")] },
  ];
  const merged = mergeCaseResults(prior, fresh);
  const ids = merged.map((c) => c.caseId).sort();
  assert.deepEqual(ids, ["new", "old"], "新旧 case 都在");
});

test("mergeCaseResults: 空 prior = 全新认证（不报错）", () => {
  const fresh = [
    { caseId: "only", agentId: "researcher", checks: [check("completed", true, "core")] },
  ];
  const merged = mergeCaseResults([], fresh);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].caseId, "only");
});

test("mergeCaseResults: 空 fresh = 仅保留旧 case（幂等，不清空）", () => {
  const prior = [
    { caseId: "old", agentId: "researcher", checks: [check("completed", true, "core")] },
  ];
  const merged = mergeCaseResults(prior, []);
  assert.equal(merged.length, 1, "空 fresh 不应清空已有结果");
  assert.equal(merged[0].caseId, "old");
});

// --- pruneStaleCases: TD-87 清算（2026-08-20，Owner 批准）---
// 背景：mergeCaseResults 以 caseId 为键只覆盖不清理——matrix 行 label 改名后，
// 旧 label 的 case 永远滞留，worker 级最差聚合被陈年记录拖累（coder_mm 曾
// 3 个僵尸 conditional 拖住 1 个现行 certified case）。
// 证伪场景 T1/T2/T3 + 认证级 T4 + glue 结构钉 T5。变异自证：
//   M1 去掉 labels 过滤（恒保留）→ T1/T4 红；M2 去掉 agentIds scope 守卫
//   （只按 labels）→ T2 红；M3 glue 不接 prune → T5 红。复原后全绿。

test("pruneStaleCases T1: 矩阵内 agent 的旧 label case 被修剪，现行 label 保留", () => {
  const rows = [{ agentId: "coder_mm", label: "kimi-code/k3 max（多模态）" }];
  const prior = [
    { caseId: "Kimi K3 via Kimi Code CLI（多模态）", agentId: "coder_mm", checks: [check("completed", true, "core"), check("metricsNonZero", false, "observability")] },
    { caseId: "kimi-code/k3 max（多模态）", agentId: "coder_mm", checks: [check("completed", true, "core"), check("metricsNonZero", true, "observability", { capability: "metrics" })] },
  ];
  const pruned = pruneStaleCases(prior, rows);
  assert.equal(pruned.length, 1, "旧 label 僵尸 case 应被修剪");
  assert.equal(pruned[0].caseId, "kimi-code/k3 max（多模态）");
});

test("pruneStaleCases T2: 矩阵外 agent 的 prior 不动（scope 守卫）", () => {
  const rows = [{ agentId: "coder_mm", label: "kimi-code/k3 max（多模态）" }];
  const prior = [
    { caseId: "某些旧 legacy label", agentId: "legacy_probe_worker" },
    { caseId: "auditor 旧标签", agentId: "auditor" },
  ];
  const pruned = pruneStaleCases(prior, rows);
  assert.equal(pruned.length, 2, "不在矩阵 agentIds 里的 prior 不得被本规则触碰");
});

test("pruneStaleCases T3: 空矩阵 / 空 prior 恒等安全", () => {
  assert.deepEqual(pruneStaleCases([], [{ agentId: "x", label: "l" }]), []);
  assert.deepEqual(pruneStaleCases([{ caseId: "a", agentId: "x" }], []), [{ caseId: "a", agentId: "x" }]);
});

test("pruneStaleCases T4 认证级：清算后 worker 级聚合升 certified（复现 coder_mm 形状）", () => {
  // 复刻 2026-08-20 实况：coder_mm 4 case——3 个旧 label 的 conditional 僵尸
  // （旧 metricsNonZero 失败形状）+ 1 个现行 label 的全绿 case。修复前
  // summarize 取最差 → conditional；prune 后 → certified。
  const rows = [{ agentId: "coder_mm", label: "kimi-code/k3 max / 1M catalog via Kimi Code CLI（多模态）" }];
  const greenChecks = [
    check("completed", true, "core"), check("hasAssistantText", true, "core"),
    check("sentinelA", true, "core"), check("sentinelB", true, "core"),
    check("hasDoneEvent", true, "core"),
    check("commandsPassed", true, "strict"), check("filesExist", true, "strict"), check("hasEvidence", true, "strict"),
    check("workflowRunDir", true, "operational"),
    check("metricsNonZero", true, "observability", { capability: "metrics" }),
  ];
  const prior = [
    { caseId: "kimi-for-coding via kimi-code CLI（多模态）", agentId: "coder_mm", backend: "kimi-code", modelId: "kimi-code/k3", checks: greenChecks.map((c) => c.name === "metricsNonZero" ? check("metricsNonZero", false, "observability") : c) },
    { caseId: "Kimi K3 via Kimi Code CLI（多模态）", agentId: "coder_mm", backend: "kimi-code", modelId: "kimi-code/k3", checks: greenChecks.map((c) => c.name === "metricsNonZero" ? check("metricsNonZero", false, "observability") : c) },
    { caseId: "Kimi K3 max / 1M catalog via Kimi Code CLI（多模态）", agentId: "coder_mm", backend: "kimi-code", modelId: "kimi-code/k3", checks: greenChecks.map((c) => c.name === "metricsNonZero" ? check("metricsNonZero", false, "observability") : c) },
    { caseId: "kimi-code/k3 max / 1M catalog via Kimi Code CLI（多模态）", agentId: "coder_mm", backend: "kimi-code", modelId: "kimi-code/k3", checks: greenChecks },
  ];
  const withoutPrune = summarizeCertification(mergeCaseResults(prior, []));
  assert.equal(withoutPrune.workers.coder_mm.status, "conditional", "前置断言：不 prune 时复现实况（最差聚合）");
  const withPrune = summarizeCertification(mergeCaseResults(pruneStaleCases(prior, rows), []));
  assert.equal(withPrune.workers.coder_mm.status, "certified", "清算后现行 case 主导聚合");
});

test("pruneStaleCases T5 结构钉：run-reliability merge 调用点接线", () => {
  const script = readFileSync(new URL("../../scripts/run-reliability.mjs", import.meta.url), "utf8");
  assert.match(script, /import\s*\{[^}]*\bpruneStaleCases\b[^}]*\}\s*from\s*"\.\/reliability\/certification\.mjs"/s,
    "run-reliability 必须导入 pruneStaleCases");
  assert.match(script, /mergeCaseResults\(pruneStaleCases\(priorCases,\s*MATRIX\),\s*results\)/,
    "merge 调用点必须先 prune 再 merge（僵尸 caseId 清算是 merge 前置步骤）");
});

// =====================================================================
// TD-186（2026-09-22）：认证证据绑定执行画像。
//
// 背景（实证，不重论证）：auditor 席位 effort medium→high 重取证后，summary 里
// status=certified、时间戳刷新，但记录不表达执行画像（effort=null）且 caseId 仍带
// 旧档位字样。新 case 必须记录实际生效的执行画像（modelId/providerID/providerKey/
// effort/runtime/codeRef/capturedAt/drillRunIds）；旧记录不补猜（缺失即 unknown）。
// =====================================================================

// 全绿 case 工厂（四类目覆盖 + 至少一条 pass——不靠 N/A 拿 certified）。
function greenCase(overrides = {}) {
  return {
    caseId: "lane case",
    agentId: "auditor",
    backend: "codex",
    providerID: null,
    modelId: "gpt-6-astra",
    providerKey: undefined,
    checks: [
      check("completed", true, "core", { capability: "complete" }),
      check("commandsPassed", true, "strict", { capability: "commandEvidence" }),
      check("adversarialEscape", true, "operational", { capability: "adversarialEscape" }),
      check("metricsNonZero", true, "observability", { capability: "metrics" }),
    ],
    ...overrides,
  };
}

const PROFILE_HIGH = {
  modelId: "gpt-6-astra",
  providerID: null,
  providerKey: null,
  effort: "high",
  runtime: {
    distribution: "codex",
    version: "codex-cli 0.54.0",
    binaryPath: "C:/tools/codex.cmd",
    fingerprint: "v1-abc123def4567890",
    verified: true,
    reason: null,
  },
  codeRef: "92209bbdeadbeefdeadbeefdeadbeefdeadbeef",
  capturedAt: "2026-09-22T15:05:15.876Z",
  drillRunIds: { sentinel: "run_20260922T1", scorecard: "run_20260922T2", isolation: null },
};

test("TD-186 A: case 的 executionProfile 原样进入 summary.cases 与 worker 记录", () => {
  const fresh = greenCase({ executionProfile: PROFILE_HIGH, lastHealthyRunAt: "2026-09-22T15:05:15.876Z" });
  const summary = summarizeCertification([fresh]);
  // case 级：磁盘 facts 保留执行画像（供审计与详情层读取）。
  assert.deepEqual(summary.cases[0].executionProfile, PROFILE_HIGH);
  // worker 级：active identity 的 case 带画像 → 原样入账（不重算、不裁剪）。
  const w = summary.workers.auditor;
  assert.equal(w.status, "certified");
  assert.deepEqual(w.executionProfile, PROFILE_HIGH);
  assert.equal(w.executionProfile.effort, "high", "effort=null 的旧病灶不再出现于新记录");
});

test("TD-186 A: legacy case 无 executionProfile → worker 记录整体缺失该字段（不补猜）", () => {
  const legacy = greenCase({ caseId: "legacy case" });
  const summary = summarizeCertification([legacy]);
  assert.equal(summary.workers.auditor.status, "certified");
  assert.equal(summary.workers.auditor.executionProfile, undefined,
    "旧记录缺画像 = unknown（undefined），绝不由 summarize 层补猜");
  // 画像不进既有 worker 字段（backend/modelId 等照旧）。
  assert.equal(summary.workers.auditor.modelId, "gpt-6-astra");
});

test("TD-186 A: 同 identity 多 case → worker 取最后一条带画像的记录（重认证后天然最新）", () => {
  const olderProfile = { ...PROFILE_HIGH, effort: "medium", capturedAt: "2026-09-17T10:00:00.000Z" };
  const older = greenCase({
    caseId: "older label",
    executionProfile: olderProfile,
    lastHealthyRunAt: "2026-09-17T10:00:00.000Z",
  });
  // 中间：同 identity 但无画像（模拟部分链路丢字段）——不得回填旧画像冒充最新。
  const middle = greenCase({ caseId: "middle label" });
  const latest = greenCase({
    caseId: "latest label",
    executionProfile: PROFILE_HIGH,
    lastHealthyRunAt: "2026-09-22T15:05:15.876Z",
  });
  const summary = summarizeCertification([older, middle, latest]);
  assert.equal(summary.workers.auditor.executionProfile.effort, "high",
    "最后一条带画像的 active-identity case 胜出（重取证后 medium 历史不覆盖 high 新证据）");
});

test("TD-186 A 结构钉：run-reliability 采集执行画像的字段族接线", () => {
  const script = readFileSync(new URL("../../scripts/run-reliability.mjs", import.meta.url), "utf8");
  // 复用组件层既有探针（不新建指纹平台），一次 spawn / backend。
  assert.match(script, /import\s*\{\s*probeRuntimeIdentity\s*\}\s*from\s*"\.\/reliability\/runtimeIdentity\.mjs"/,
    "运行时身份必须复用 scripts/reliability/runtimeIdentity.mjs");
  // git HEAD 只读获取 + 探不到如实 null（unknown），不猜。
  assert.match(script, /\["rev-parse",\s*"HEAD"\]/, "codeRef 必须来自 git rev-parse HEAD（只读）");
  // effort 取自 agent 配置（reasoning.effort），不是矩阵行文本。
  assert.match(script, /effort:\s*agent\.reasoning\?\.effort\s*\?\?\s*null/,
    "effort 必须来自该 lane 实际生效的 agent 配置");
  // drillRunIds 回填（sentinel/scorecard 记实际 runId，其余如实 null）。
  assert.match(script, /drillRunIds/, "case 必须带各 drill 的 runId 映射");
});

test("TD-186 钉②（不得合并成绿）：历史通过 + 本次失败——worker 状态反映本次失败，全绿时间戳只是历史", () => {
  const history = greenCase({
    caseId: "history label",
    executionProfile: PROFILE_HIGH,
    lastHealthyRunAt: "2026-09-22T15:05:15.876Z",
  });
  // 本次失败：同 identity、同画像、strict 失败 → draft-only。
  const freshFail = {
    ...greenCase({ executionProfile: PROFILE_HIGH }),
    caseId: "fresh fail label",
    checks: [
      check("completed", true, "core", { capability: "complete" }),
      check("commandsPassed", false, "strict", { capability: "commandEvidence" }),
      check("adversarialEscape", true, "operational", { capability: "adversarialEscape" }),
      check("metricsNonZero", true, "observability", { capability: "metrics" }),
    ],
    lastHealthyRunAt: null,
  };
  const summary = summarizeCertification([history, freshFail]);
  const w = summary.workers.auditor;
  assert.equal(w.status, "draft-only", "本次 strict 失败必须压过历史 certified（最差聚合）");
  assert.equal(w.lastHealthyRunAt, "2026-09-22T15:05:15.876Z", "历史全绿时间保留为历史事实（不抹除）");
  // 钉死"合并成绿"的路径：status 与 recommendedUse 都不得因历史全绿而回绿。
  assert.equal(w.recommendedUse, "draft-only");
  assert.equal(summary.allCertified, false);
  // 执行画像仍如实携带（失败证据也表达画像——供适用性比较）。
  assert.equal(w.executionProfile.effort, "high");
});

// =====================================================================
// TD-186 复核 FAIL-B（2026-09-22 第二包）：drillRunIds 取证闭环（写入侧）。
//
// 复核实证：sentinel/scorecard 的 run 转录落在 TMP_DIR/runs/（CLI 子进程 cwd
// 相对解析），run-reliability.mjs 收尾 rmSync(TMP_DIR) 连带删除——summary 里的
// drillRunIds 指向已删除的证据。方案 1（转录保留在可解析位置 runs/reliability/）
// + 写盘守卫 + 引用集清理。本节：drillEvidence.mjs 行为钉 + 入口接线结构钉。
// =====================================================================

function evidenceCase(caseId, drillRunIds) {
  return greenCase({ caseId, executionProfile: { ...PROFILE_HIGH, drillRunIds } });
}

test("TD-186 复核 FAIL-B: collectReferencedDrillRunIds 收集非空字符串 id（去重；null/形状外不收集）", () => {
  const summary = {
    cases: [
      evidenceCase("a", { sentinel: "run_t1", scorecard: "run_t2", isolation: null }),
      evidenceCase("b", { sentinel: "run_t1", scorecard: 7, isolation: null, stop: "" }),
    ],
  };
  assert.deepEqual(collectReferencedDrillRunIds(summary), ["run_t1", "run_t2"],
    "null（如实未记录）/非字符串/空串都不是可回查主张，不进守卫与保留集");
  assert.deepEqual(collectReferencedDrillRunIds({}), []);
  assert.deepEqual(collectReferencedDrillRunIds({ cases: [greenCase({ caseId: "legacy" })] }), [],
    "legacy case 无画像 → 无 id");
});

test("TD-186 复核 FAIL-B: missingDrillTranscripts 守卫——转录在场的 id 不报，缺失的报", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-de-missing-"));
  try {
    const transcriptsDir = drillTranscriptsDir(dir);
    mkdirSync(transcriptsDir, { recursive: true });
    writeFileSync(join(transcriptsDir, "run_t1.jsonl"), "{}\n", "utf8");
    assert.deepEqual(missingDrillTranscripts(["run_t1", "run_t2"], transcriptsDir), ["run_t2"],
      "守卫精确点名不可回查的 id（fail-closed 检测面）");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("TD-186 复核 FAIL-B: nullUnresolvableDrillRunIds——prior 悬空 id 置 null（判定字段一字不动；原数组不被就地改写）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-de-null-"));
  try {
    const transcriptsDir = drillTranscriptsDir(dir);
    mkdirSync(transcriptsDir, { recursive: true });
    writeFileSync(join(transcriptsDir, "run_t1.jsonl"), "{}\n", "utf8");
    // prior case：run_t1 可回查、run_dead 是旧版取证遗留死指针（转录已被清）。
    const prior = evidenceCase("prior case", { sentinel: "run_t1", scorecard: "run_dead", isolation: null });
    const { cases, nulled } = nullUnresolvableDrillRunIds([prior], { transcriptsDir: transcriptsDir });
    assert.deepEqual(nulled, [{ caseId: "prior case", drill: "scorecard", runId: "run_dead" }],
      "每条置 null 都被报告（非静默改史）");
    assert.deepEqual(
      cases[0].executionProfile.drillRunIds,
      { sentinel: "run_t1", scorecard: null, isolation: null },
      "悬空 id 如实置 null；可回查 id 保留",
    );
    assert.deepEqual(prior.executionProfile.drillRunIds, { sentinel: "run_t1", scorecard: "run_dead", isolation: null },
      "入参原对象不被就地改写（纯函数）");
    // 判定字段不动：置 null 只动指针，checks/capturedAt 照旧。
    assert.deepEqual(cases[0].checks, prior.checks);
    assert.equal(cases[0].executionProfile.capturedAt, prior.executionProfile.capturedAt);
    // 置 null 后 summarize 产出（写盘形状）不再含死指针。
    const summary = summarizeCertification(cases);
    assert.equal(summary.workers.auditor.executionProfile.drillRunIds.scorecard, null);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("TD-186 复核 FAIL-B: pruneUnreferencedDrillTranscripts——保留集=引用集；非 runId 形状文件绝不动", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-de-prune-"));
  try {
    const transcriptsDir = drillTranscriptsDir(dir);
    mkdirSync(transcriptsDir, { recursive: true });
    for (const name of ["run_keep.jsonl", "run_stale1.jsonl", "run_stale2.jsonl", "notes.txt", "run_NOTAID.jsonl"]) {
      writeFileSync(join(transcriptsDir, name), "{}\n", "utf8");
    }
    const result = pruneUnreferencedDrillTranscripts(transcriptsDir, ["run_keep"]);
    assert.equal(result.kept, 1, "引用集中的保留");
    assert.equal(result.removed, 2, "被取代认证的转录删除（不无限增长）");
    assert.deepEqual(readdirSync(transcriptsDir).sort(), ["notes.txt", "run_NOTAID.jsonl", "run_keep.jsonl"],
      "非 runId 文件名形状（notes.txt / 大写 run_NOTAID.jsonl）不在清理面");
    // 目录不存在 → 空结果不抛。
    assert.deepEqual(pruneUnreferencedDrillTranscripts(join(dir, "nope"), []), { removed: 0, kept: 0 });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("TD-186 复核 FAIL-B 结构钉: run-reliability 转录持久化 + 写盘守卫 + 悬空置 null + 引用集清理接线", () => {
  const entry = readFileSync(new URL("../../scripts/run-reliability.mjs", import.meta.url), "utf8");
  // ① sentinel/scorecard 派发显式 --run-dir 到持久化转录目录（不再落会被整体删除的 tmpDir）。
  assert.match(entry, /"--run-dir",\s*DRILL_TRANSCRIPTS_DIR/, "sentinel 派发必须 --run-dir 到 DRILL_TRANSCRIPTS_DIR");
  assert.match(entry, /transcriptDir:\s*DRILL_TRANSCRIPTS_DIR/, "createDrills 注入 transcriptDir（scorecard 转录落同处）");
  // ② 写盘守卫：fresh id 缺转录 = 拒绝写 summary 并非零退出（硬禁令：不记录悬空 id）。
  assert.match(entry, /missingDrillTranscripts\(freshRunIds,\s*DRILL_TRANSCRIPTS_DIR\)/, "写盘前逐 id 守卫");
  assert.match(entry, /process\.exit\(3\)/, "守卫失败非零退出");
  // ③ prior 悬空 id 置 null（不可回查就不记 id）。
  assert.match(entry, /nullUnresolvableDrillRunIds\(mergedCases,\s*\{\s*transcriptsDir:\s*DRILL_TRANSCRIPTS_DIR/, "prior 死指针写盘前置 null");
  // ④ 引用集清理（保留集 = 刚写出的 summary 引用集）。
  assert.match(entry, /pruneUnreferencedDrillTranscripts\(\s*DRILL_TRANSCRIPTS_DIR,\s*collectReferencedDrillRunIds\(summary\)/, "写盘后按引用集清理");
  // ⑤ "unknown" 占位绝不入账（它不是可回查 id）。
  assert.match(entry, /value !== "unknown"/, "runId 占位 unknown 如实归 null");
  // ⑥ 转录目录名 SSOT 下向复用（不在 scripts 侧再造第二份名字）。
  const glue = readFileSync(new URL("../../scripts/reliability/drillEvidence.mjs", import.meta.url), "utf8");
  assert.match(glue, /import\s*\{[^}]*CERT_DRILL_TRANSCRIPTS_SUBDIR[^}]*\}\s*from\s*"\.\.\/\.\.\/src\/application\/registryInventory\.js"/,
    "子目录名单一来源 = src/application/registryInventory.js（与只读回查层同名）");
  // 守卫语义独立验证（证伪：守卫不是恒真/恒假）。
  assert.deepEqual(missingDrillTranscripts(["run_x"], "nowhere", () => false), ["run_x"]);
  assert.deepEqual(missingDrillTranscripts(["run_x"], "nowhere", () => true), []);
});

test("TD-186 复核 FAIL-B: 端到端形状——守卫+置 null 后写出的 summary 引用集全部可解析（无死指针）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-de-e2e-"));
  try {
    const transcriptsDir = drillTranscriptsDir(dir);
    mkdirSync(transcriptsDir, { recursive: true });
    writeFileSync(join(transcriptsDir, "run_ok.jsonl"), "{}\n", "utf8");
    // 模拟合并后的 cases（mergeCaseResults 真实顺序：prior 在前、fresh 追加在后）：
    // 一条 prior（死指针）、一条 fresh（id 可回查）。
    const cases = [
      evidenceCase("prior case", { sentinel: "run_dead", scorecard: null }),
      evidenceCase("fresh case", { sentinel: "run_ok", scorecard: null }),
    ];
    // 入口同款顺序：先守卫 fresh（fresh ids 都可回查才继续）……
    const freshIds = collectReferencedDrillRunIds({ cases: cases.slice(1) });
    assert.deepEqual(missingDrillTranscripts(freshIds, transcriptsDir), [], "fresh id 全部可回查（守卫通过）");
    // ……再对合并集置 null prior 死指针，写出的 summary 引用集里只剩可回查 id。
    const { cases: closedCases } = nullUnresolvableDrillRunIds(cases, { transcriptsDir });
    const summary = summarizeCertification(closedCases);
    const referenced = collectReferencedDrillRunIds(summary);
    assert.deepEqual(missingDrillTranscripts(referenced, transcriptsDir), [],
      "写出的 summary 引用的每个 id 都可解析（硬禁令状态不复存在）");
    assert.equal(summary.workers.auditor.executionProfile.drillRunIds.sentinel, "run_ok",
      "同 identity 聚合取最后一条带画像的 case（置 null 后的 prior 不覆盖 fresh）");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

