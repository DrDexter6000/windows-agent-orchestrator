// test/migration-0045/reliabilityScopePin.test.js
//
// 0046 步⑨ 幽灵行+重键沉底修复的防再生钉。
// 缺口形态一（幽灵行）：runner 的 summarizeCertification 不传 scope → 退役审计
// case（kimi_opencode_test 等）混进 workers 聚合（2026-10-06 实证；当时干净台账
// 全靠 resummarize 迁移脚本重生成维持）。
// 缺口形态二（重键沉底）：scope 只按 agentId 字符串匹配 → 重键/改名后旧 agentId
// 的 case 被误排出（kimi-k3→kimi 实证：kimi 免重认证，case 仍挂旧键，worker 行
// 消失）。修复=指纹 scope（case 自带身份事实的指纹 ∈ 当前矩阵车道指纹集）。
// 源扫描钉（staticRunsGuard 同族手法）+ 行为单测双保险。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { summarizeCertification, matrixScopeFromRegistry } from "../../scripts/reliability/certification.mjs";

const src = readFileSync(resolve(import.meta.dirname, "../../scripts/run-reliability.mjs"), "utf8");

test("0046 ⑨ 源钉：runner 的 summarizeCertification 必须携带注册表派生的全量 scope", () => {
  assert.match(
    src,
    /summarizeCertification\(closedCases, MATRIX_SCOPE\)/,
    "调用必须携带 scope（无参调用=幽灵行缺口回归）",
  );
  assert.match(
    src,
    /MATRIX_SCOPE = matrixScopeFromRegistry\(registry\)/,
    "scope 必须经 matrixScopeFromRegistry 从 registry 派生",
  );
  // 负钉：--agent 过滤后的 MATRIX 不得进 scope（增量跑缩表陷阱）。
  const scopeDecl = src.slice(
    src.indexOf("MATRIX_SCOPE = matrixScopeFromRegistry"),
    src.indexOf(";", src.indexOf("MATRIX_SCOPE = matrixScopeFromRegistry")),
  );
  assert.ok(!/\bMATRIX\b/.test(scopeDecl), "scope 禁止引用 ONLY_AGENT 过滤后的 MATRIX");
});

test("0046 ⑨ 行为：指纹 scope——旧 agentId+在册指纹=保住认证；旧模型=审计保留不聚合", () => {
  const registry = {
    agents: {
      kimi: { backend: "kimi-web", model: { id: "kimi-code/k3-256k" } },
      sol: { backend: "codex", model: { id: "gpt-6.1-sol" }, reasoning: { effort: "high" } },
    },
    certification: { matrix: [
      { agentId: "kimi", profile: "delta", drills: ["sentinel"] },
      { agentId: "sol", profile: "strict", drills: ["sentinel", "scorecard"] },
    ] },
  };
  const scope = matrixScopeFromRegistry(registry);
  assert.equal(scope.matrixAgentIds.size, 2);
  assert.equal(scope.matrixLaneKeys.size, 2);

  const green = (agentId) => ({
    agentId, backend: "codex", providerID: null, modelId: "gpt-6.1-sol", providerKey: null,
    requiredCategories: ["core"], profile: "strict", drills: ["sentinel", "scorecard"],
    checks: [{ name: "completed", pass: true, category: "core", detail: "x", capability: "complete" }],
    certification: { status: "certified", recommendedUse: "strict-dispatch", reason: null, reasonCode: null, failedChecks: [], capabilities: {} },
  });
  const cases = [
    // ① 重键 case：agentId=旧键 kimi-k3，指纹=当前 kimi 车道 → 必须保住聚合。
    { agentId: "kimi-k3", backend: "kimi-web", providerID: null, modelId: "kimi-code/k3-256k", providerKey: null,
      requiredCategories: ["core"], profile: "delta", drills: ["sentinel"],
      checks: [{ name: "completed", pass: true, category: "core", detail: "x", capability: "complete" }],
      certification: { status: "conditional", recommendedUse: "supervised-dispatch", reason: "x", reasonCode: null, failedChecks: [], capabilities: {} } },
    // ② 在册 agentId 直配快路径。
    green("sol"),
    // ③ 幽灵：agentId 不在矩阵，模型也不在（退役真身）→ 只留 cases 审计。
    { agentId: "ghost_probe", backend: "claude-code", providerID: null, modelId: "glm-5.3[1m]", providerKey: null,
      requiredCategories: ["core"], profile: "delta", drills: ["sentinel"],
      checks: [{ name: "completed", pass: true, category: "core", detail: "x", capability: "complete" }],
      certification: { status: "conditional", recommendedUse: "supervised-dispatch", reason: "x", reasonCode: null, failedChecks: [], capabilities: {} } },
  ];
  const summary = summarizeCertification(cases, scope);
  const workerIds = new Set(Object.values(summary.workers).map((w) => w.agentId));
  assert.ok(workerIds.has("kimi-k3"), "重键 case（旧 agentId+在册指纹）必须保住 workers 聚合（显示名=provenance 旧键合法）");
  assert.ok(workerIds.has("sol"), "在册 agentId 直配");
  assert.ok(!workerIds.has("ghost_probe"), "退役真身不得进 workers（只留 cases 审计）");
  assert.equal(summary.counts.rejected, 0);
  assert.equal(Object.keys(summary.workers).length, 2);
});
