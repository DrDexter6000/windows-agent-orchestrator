// R23-C：providerKey（认证身份第 4 维）归一化单一实现——src 宿主下向 import，
// 与 run-reliability.mjs agentInfo / runManager.matchedCertRecord 同源零漂移。
import { providerKeyFor } from "../../src/providerFingerprint.js";
import { matrixCaseLabel } from "../../src/registry.js";

const LEGACY_MATRIX = [
  { agentId: "coder", label: "GLM snapshot-stable", providerID: "zhipuai-coding-plan" },
  { agentId: "researcher", label: "DeepSeek first-stable", providerID: "deepseek" },
  { agentId: "coder_multimodal", label: "Kimi first-stable", providerID: "kimi-for-coding", optional: true },
];

// ADR-0025 §5 / 决定 0084：delta 认证子集的 drill 词汇 SSOT。
// 新（harness × 模型）组合走 delta 认证：sentinel（core 能力）+ scorecard（strict 证据）
// + containmentEvidence（越界写拦截的活体取证——承担 isolation 语义，不得省）。
// 不含 workflowRunDir；通过 → conditional + certificationScope:"delta"。
// DELTA_DRILLS 同时是 scripts/reliability/certification.mjs scope 派生的比对基准
// （单一清单，无第二份）。
export const DELTA_DRILLS = ["sentinel", "scorecard", "containmentEvidence"];

// 决定 0084 退役前的 delta 词汇（adversarialEscape 越界写对抗）。只服务历史
// summary 的 scope 读侧派生——旧 case 的 drills 原样在盘上（历史数据不改写），
// 派生必须保持其 scope 不变。现行矩阵行再声明退役 drill 会被显式拒绝（见
// RETIRED_DRILLS），不会经此清单回流。
export const LEGACY_DELTA_DRILLS = ["sentinel", "scorecard", "adversarialEscape"];

// 已退役 drill 闭集：矩阵行显式声明即解析失败（决定 0084 退役，改用
// containmentEvidence）。不得静默跳过——静默跳过会把 delta 子集的 isolation
// 语义悄悄丢掉。
const RETIRED_DRILLS = Object.freeze({
  adversarialEscape: 'retired by decision 0084 — replace it with "containmentEvidence" (live containment-evidence drill; the adversarial out-of-bounds drill left the delta gate because a compliant model refuses the instruction, leaving nothing to intercept)',
});

function assertNoRetiredDrill(drills) {
  for (const drill of drills ?? []) {
    if (RETIRED_DRILLS[drill]) {
      throw new Error(
        `buildCertificationMatrix: matrix row declares retired drill "${drill}" — ${RETIRED_DRILLS[drill]}. Silent skip is forbidden; fix the matrix row.`,
      );
    }
  }
}

export function defaultDrillsForProfile(profile = "basic") {
  if (profile === "strict" || profile === "certification") {
    // 全量覆盖超出 delta 子集：另跑 isolation（写入落在工作树、源检出没被写），
    // scope 按实际覆盖记 full；只改标签、drills 仍是 delta 子集的行仍记 delta。
    return ["sentinel", "scorecard", "containmentEvidence", "isolation"];
  }
  if (profile === "delta") {
    return [...DELTA_DRILLS];
  }
  return ["sentinel"];
}

export function buildCertificationMatrix({
  registry,
  onlyAgent,
  profileOverride,
} = {}) {
  const agents = registry?.agents ?? {};
  const configured = registry?.certification?.matrix;
  const rawCases = Array.isArray(configured) && configured.length > 0
    ? configured
    : LEGACY_MATRIX;

  return rawCases
    .filter((tc) => !onlyAgent || tc.agentId === onlyAgent)
    .filter((tc) => agents[tc.agentId])
    .map((tc) => normalizeCase(tc, agents[tc.agentId], profileOverride));
}

/**
 * ADR-0032 §6 账实一致：台账身份一律从 agent 配置派生（runner 按 agentId 用 agent 配置派发）。
 * 矩阵行若声明了不同的值，显式告警并仍以 agent 为准——绝不记账一个没有实际派发的身份。
 * @param {string} field
 * @param {string|null} agentValue
 * @param {unknown} rowValue
 * @returns {string|null}
 */
function agentIdentity(field, agentValue, rowValue) {
  if (rowValue !== undefined && rowValue !== null && rowValue !== agentValue) {
    console.warn(
      `[reliability] WARN: 矩阵行 ${field}=${JSON.stringify(rowValue)} 与 agent 实际配置 `
      + `${JSON.stringify(agentValue)} 不一致——以 agent 为准（台账不得记未派发的身份）。`,
    );
  }
  return agentValue;
}

function normalizeCase(tc, agent = {}, profileOverride) {
  const profile = profileOverride ?? tc.profile ?? "basic";
  const drills = normalizeDrills(tc.drills, profile);
  return {
    agentId: tc.agentId,
    label: matrixCaseLabel(tc.agentId, tc),
    profile,
    drills,
    requiredCategories: mergeCategories(tc.requiredCategories, requiredCategoriesForDrills(drills)),
    optional: tc.optional ?? false,
    expectComplete: tc.expectComplete ?? true,
    expectText: tc.expectText ?? true,
    backend: agent.backend ?? tc.backend ?? null,
    // 账实一致（ADR-0032 §6）：runner 按 agentId 用 **agent 配置** 派发，台账身份必须同源。
    // 旧行为允许矩阵行覆盖 providerID/modelId → 存在"账上身份 ≠ 实际派发配置"的路径，
    // 与 :providerKey 同族的教训（TD-133 / TD-169）。行值与 agent 不一致时以 agent 为准并告警。
    providerID: agentIdentity("providerID", agent.model?.providerID ?? null, tc.providerID),
    modelId: agentIdentity("modelId", agent.model?.id ?? null, tc.modelId),
    // R23-C：providerKey 一律从 registry 的 agent.provider 派生，绝不读行值——
    // providerID 硬编码行值导致该维度对现网全部 lane 空转的教训（TD-133 同族）。
    // 无 provider 块 → null（已观察确认无接入方）。
    providerKey: providerKeyFor(agent.provider),
    completionMode: tc.completionMode ?? agent.completionMode ?? "snapshot-stable",
  };
}

function mergeCategories(explicitCategories, impliedCategories) {
  return [...new Set([...(explicitCategories ?? []), ...impliedCategories])];
}

function normalizeDrills(drills, profile) {
  assertNoRetiredDrill(drills);
  const out = [];
  for (const drill of drills ?? defaultDrillsForProfile(profile)) {
    if (!out.includes(drill)) out.push(drill);
  }
  if (profile === "strict" || profile === "certification") {
    // 全量画像至少跑这三项：scorecard 的命令/文件证据，加越界写拦截的活体取证
    // 与隔离（决定 0084）。行内显式 drills 少写了也在这里补齐。
    for (const required of ["scorecard", "containmentEvidence", "isolation"]) {
      if (!out.includes(required)) out.push(required);
    }
  }
  return out;
}

function requiredCategoriesForDrills(drills) {
  const categories = ["core"];
  if (drills.includes("scorecard")) {
    categories.push("strict");
  }
  // containmentEvidence 是 isolation 类检查（越界写拦截的活体取证，决定 0084）：
  // 要求 operational 类目——delta 子集不得把 isolation 语义降为可选。
  if (
    drills.includes("isolation")
    || drills.includes("workflowRunDir")
    || drills.includes("stop")
    || drills.includes("containmentEvidence")
  ) {
    categories.push("operational");
  }
  categories.push("observability");
  return [...new Set(categories)];
}
