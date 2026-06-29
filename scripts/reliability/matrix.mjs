const LEGACY_MATRIX = [
  { agentId: "coder", label: "GLM snapshot-stable", providerID: "zhipuai-coding-plan" },
  { agentId: "researcher", label: "DeepSeek first-stable", providerID: "deepseek" },
  { agentId: "coder_multimodal", label: "Kimi first-stable", providerID: "kimi-for-coding", optional: true },
];

export function defaultDrillsForProfile(profile = "basic") {
  if (profile === "strict" || profile === "certification") {
    return ["sentinel", "scorecard"];
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
  if (drills.includes("isolation") || drills.includes("workflowRunDir") || drills.includes("stop")) {
    categories.push("operational");
  }
  categories.push("observability");
  return [...new Set(categories)];
}
