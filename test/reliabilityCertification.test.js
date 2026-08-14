import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  certifyCase,
  summarizeCertification,
  mergeCaseResults,
} from "../scripts/reliability/certification.mjs";

function check(name, pass, category, extra = {}) {
  return { name, pass, category, ...extra };
}

test("run-reliability imports child_process APIs it uses", () => {
  const script = readFileSync(new URL("../scripts/run-reliability.mjs", import.meta.url), "utf8");
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
