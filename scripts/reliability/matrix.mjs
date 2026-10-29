// R23-C：providerKey（认证身份第 4 维）归一化单一实现——src 宿主下向 import，
// 与 run-reliability.mjs agentInfo / runManager.matchedCertRecord 同源零漂移。
import { providerKeyFor } from "../../src/providerFingerprint.js";
import { matrixCaseLabel } from "../../src/registry.js";
// 决定 0086：OS 写沙箱能力声明（enforcesWriteSandbox）的读取 SSOT——矩阵构建
// 按声明选 drill 词汇，共享代码不按运行时名分支。
import { backendCapabilitySnapshot } from "../../src/backends/factory.js";

const LEGACY_MATRIX = [
  { agentId: "coder", label: "GLM snapshot-stable", providerID: "zhipuai-coding-plan" },
  { agentId: "researcher", label: "DeepSeek first-stable", providerID: "deepseek" },
  { agentId: "coder_multimodal", label: "Kimi first-stable", providerID: "kimi-for-coding", optional: true },
];

// ADR-0025 §5 / 决定 0084 / 决定 0086：delta 认证子集的 drill 词汇 SSOT。
// 新（harness × 模型）组合走 delta 认证：sentinel（core 能力）+ scorecard（strict 证据）
// + containmentEvidence（越界写拦截的活体取证——承担 isolation 语义，不得省）。
// 通过 → conditional + certificationScope:"delta"。
// DELTA_DRILLS 同时是 scripts/reliability/certification.mjs scope 派生的比对基准
// （单一清单，无第二份）。声明 OS 写沙箱的后端（决定 0086）在同一位置用
// sandboxEnforcement（不经模型的沙箱执行取证）取代 containmentEvidence——
// 词汇选择由 deltaDrillsForBackend(backend) 派生。
export const DELTA_DRILLS = ["sentinel", "scorecard", "containmentEvidence"];

// 决定 0086：enforcesWriteSandbox 后端的 delta 词汇（与 containmentEvidence 同一
// 位置，同一 isolation 语义）。
export const DELTA_DRILLS_WRITE_SANDBOX = ["sentinel", "scorecard", "sandboxEnforcement"];

/** backend 是否声明 OS 写沙箱（读取走 backendCapabilitySnapshot SSOT，strict === true）。 */
export function declaresWriteSandbox(backendName) {
  return typeof backendName === "string"
    && backendCapabilitySnapshot({ backend: backendName })?.enforcesWriteSandbox === true;
}

/** 该 backend 的 delta 子集词汇（沙箱后端为 WRITE_SANDBOX 变体，单一派生无第二份）。 */
export function deltaDrillsForBackend(backendName) {
  return declaresWriteSandbox(backendName) ? DELTA_DRILLS_WRITE_SANDBOX : DELTA_DRILLS;
}

// 决定 0084 退役前的 delta 词汇（adversarialEscape 越界写对抗）。只服务历史
// summary 的 scope 读侧派生——旧 case 的 drills 原样在盘上（历史数据不改写），
// 派生必须保持其 scope 不变。现行矩阵行再声明退役 drill 会被显式拒绝（见
// RETIRED_DRILLS），不会经此清单回流。
export const LEGACY_DELTA_DRILLS = ["sentinel", "scorecard", "adversarialEscape"];

// 已退役 drill 闭集：矩阵行显式声明即解析失败。adversarialEscape 由决定 0084
// 退役、改用 containmentEvidence，静默跳过会把 delta 子集的 isolation 语义悄悄
// 丢掉；workflowRunDir 随决定 0094 的 workflow 层退役，静默跳过会让矩阵行以为
// 跑过了。两者都不得静默跳过。
const RETIRED_DRILLS = Object.freeze({
  workflowRunDir: 'retired by decision 0094 — the workflow layer is gone; remove the drill from the matrix row',
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

export function defaultDrillsForProfile(profile = "basic", backend = null) {
  if (profile === "strict" || profile === "certification") {
    // 全量覆盖超出 delta 子集：另跑 isolation（写入落在工作树、源检出没被写），
    // scope 按实际覆盖记 full；只改标签、drills 仍是 delta 子集的行仍记 delta。
    // 决定 0086：沙箱后端的 containmentEvidence 位置由 sandboxEnforcement 取代。
    return ["sentinel", "scorecard", containmentDrillFor(backend), "isolation"];
  }
  if (profile === "delta") {
    return [...deltaDrillsForBackend(backend)];
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
  const backend = agent.backend ?? tc.backend ?? null;
  const drills = normalizeDrills(tc.drills, profile, backend);
  return {
    agentId: tc.agentId,
    label: matrixCaseLabel(tc.agentId, tc),
    profile,
    drills,
    requiredCategories: mergeCategories(tc.requiredCategories, requiredCategoriesForDrills(drills)),
    optional: tc.optional ?? false,
    expectComplete: tc.expectComplete ?? true,
    expectText: tc.expectText ?? true,
    backend,
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

// 决定 0086：containmentEvidence 的 drill 名在沙箱后端上一律替换为
// sandboxEnforcement（默认集合、strict/certification 补齐集合、行内显式 drills
// 同一替换；替换后去重）。其余后端词汇不变。
function containmentDrillFor(backend) {
  return declaresWriteSandbox(backend) ? "sandboxEnforcement" : "containmentEvidence";
}

function normalizeDrills(drills, profile, backend = null) {
  assertNoRetiredDrill(drills);
  const swapForSandbox = (drill) =>
    drill === "containmentEvidence" ? containmentDrillFor(backend) : drill;
  const out = [];
  for (const drill of (drills ?? defaultDrillsForProfile(profile, backend)).map(swapForSandbox)) {
    if (!out.includes(drill)) out.push(drill);
  }
  if (profile === "strict" || profile === "certification") {
    // 全量画像至少跑这三项：scorecard 的命令/文件证据，加越界写拦截的活体取证
    // 与隔离（决定 0084；沙箱后端的活体取证是 sandboxEnforcement，决定 0086）。
    // 行内显式 drills 少写了也在这里补齐。
    for (const required of ["scorecard", containmentDrillFor(backend), "isolation"]) {
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
  // containmentEvidence / sandboxEnforcement 是 isolation 类检查（越界写拦截的
  // 活体取证，决定 0084 / 0086）：要求 operational 类目——delta 子集不得把
  // isolation 语义降为可选。
  if (
    drills.includes("isolation")
    || drills.includes("stop")
    || drills.includes("containmentEvidence")
    || drills.includes("sandboxEnforcement")
  ) {
    categories.push("operational");
  }
  categories.push("observability");
  return [...new Set(categories)];
}
