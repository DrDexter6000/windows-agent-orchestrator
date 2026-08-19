const LEGACY_MATRIX = [
  { agentId: "coder", label: "GLM snapshot-stable", providerID: "zhipuai-coding-plan" },
  { agentId: "researcher", label: "DeepSeek first-stable", providerID: "deepseek" },
  { agentId: "coder_multimodal", label: "Kimi first-stable", providerID: "kimi-for-coding", optional: true },
];

// ADR-0025 §5（批次 3）：delta 认证子集的 drill 词汇 SSOT。
// 新（harness × 模型）组合走 delta 认证：sentinel（core 能力）+ scorecard（strict 证据）
// + adversarialEscape（越界写对抗——承担 isolation 语义，顾问一致要求 isolation 类
// 不得省）。不含 workflowRunDir；通过 → conditional + certificationScope:"delta"。
// DELTA_DRILLS 同时是 scripts/reliability/certification.mjs scope 派生的比对基准
// （单一清单，无第二份）。
export const DELTA_DRILLS = ["sentinel", "scorecard", "adversarialEscape"];

export function defaultDrillsForProfile(profile = "basic") {
  if (profile === "strict" || profile === "certification") {
    return ["sentinel", "scorecard"];
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

function normalizeCase(tc, agent = {}, profileOverride) {
  const profile = profileOverride ?? tc.profile ?? "basic";
  const drills = normalizeDrills(tc.drills, profile);
  return {
    agentId: tc.agentId,
    label: tc.label ?? tc.agentId,
    profile,
    drills,
    requiredCategories: mergeCategories(tc.requiredCategories, requiredCategoriesForDrills(drills)),
    optional: tc.optional ?? false,
    expectComplete: tc.expectComplete ?? true,
    expectText: tc.expectText ?? true,
    backend: agent.backend ?? tc.backend ?? null,
    providerID: tc.providerID ?? agent.model?.providerID ?? null,
    modelId: tc.modelId ?? agent.model?.id ?? null,
    completionMode: tc.completionMode ?? agent.completionMode ?? "snapshot-stable",
  };
}

function mergeCategories(explicitCategories, impliedCategories) {
  return [...new Set([...(explicitCategories ?? []), ...impliedCategories])];
}

function normalizeDrills(drills, profile) {
  const out = [];
  for (const drill of drills ?? defaultDrillsForProfile(profile)) {
    if (!out.includes(drill)) out.push(drill);
  }
  if ((profile === "strict" || profile === "certification") && !out.includes("scorecard")) {
    out.push("scorecard");
  }
  return out;
}

function requiredCategoriesForDrills(drills) {
  const categories = ["core"];
  if (drills.includes("scorecard")) {
    categories.push("strict");
  }
  // adversarialEscape 是 isolation 类检查（越界写拦截，ADR-0025 批次 3）：要求
  // operational 类目——delta 子集不得把 isolation 语义降为可选。
  if (
    drills.includes("isolation")
    || drills.includes("workflowRunDir")
    || drills.includes("stop")
    || drills.includes("adversarialEscape")
  ) {
    categories.push("operational");
  }
  categories.push("observability");
  return [...new Set(categories)];
}
