// TD-111: certification advisory context 闭集 SSOT（reasonCode 与自由文本 reason
// 并列；blockerReason 原文绝不进码）。certifyCase/summarizeWorkers 经它映射。
import { reasonCodeFor } from "../../src/application/certificationReasons.js";
// ADR-0025 §5（批次 3）：delta drill 子集 SSOT（scope 派生的比对基准，单一清单）。
import { DELTA_DRILLS } from "./matrix.mjs";

export const CERTIFICATION_STATUSES = [
  "certified",
  "conditional",
  "draft-only",
  "blocked",
  "rejected",
];

const RECOMMENDED_USE = {
  certified: "strict-dispatch",
  conditional: "supervised-dispatch",
  "draft-only": "draft-only",
  blocked: "blocked",
  rejected: "do-not-dispatch",
};

const CATEGORY_ORDER = ["core", "strict", "operational", "observability"];
const DEFAULT_REQUIRED_CATEGORIES = ["core", "strict", "operational", "observability"];
const STATUS_SEVERITY = {
  certified: 0,
  conditional: 1,
  "draft-only": 2,
  blocked: 3,
  rejected: 4,
};

// ADR-0025 §5（批次 3）：certificationScope 派生——case 走 delta 规程 ⇔
// profile 显式 "delta"，或（无 profile 的手写/legacy case）drill 覆盖未超出
// delta 子集且含越界写对抗。scope 是磁盘 summary 的事实字段，只活在 summary +
// 文档层：不动 CERTIFICATION_STATUSES 闭集、不进 CLI/MCP inventory 投影
// （registryInventory.js 的 buildCertMap 按白名单字段取值，scope 不会被透出）。
export function certificationScopeForCase(caseResult = {}) {
  if (caseResult?.profile === "delta") return "delta";
  const drills = Array.isArray(caseResult?.drills)
    ? caseResult.drills.filter((d) => typeof d === "string")
    : [];
  if (
    drills.length > 0
    && drills.includes("adversarialEscape")
    && drills.every((d) => DELTA_DRILLS.includes(d))
  ) {
    return "delta";
  }
  return "full";
}

// worker 级聚合取保守值：任一 active-identity case 是 delta → delta（弱声明胜）。
function mergeCertificationScope(left, right) {
  return left === "delta" || right === "delta" ? "delta" : "full";
}

export function certifyCase(caseResult = {}) {
  const checks = normalizeChecks(caseResult.checks);
  const failedChecks = checks.filter((c) => c.pass === false && !c.optional);
  const capabilities = aggregateCapabilities(checks);
  const blockerReason = caseResult.blockedReason ?? classifyExternalBlocker(caseResult.error);
  const missingCategories = findMissingRequiredCategories(
    checks,
    caseResult.requiredCategories ?? DEFAULT_REQUIRED_CATEGORIES,
  );

  let status;
  let reason;
  if (caseResult.blocked === true || blockerReason) {
    status = "blocked";
    reason = blockerReason || "case explicitly marked blocked";
  } else if (hasFailedCategory(failedChecks, "core")) {
    status = "rejected";
    reason = "core checks failed";
  } else if (hasFailedCategory(failedChecks, "strict")) {
    status = "draft-only";
    reason = "strict evidence checks failed";
  } else if (
    hasFailedCategory(failedChecks, "operational") ||
    hasFailedCategory(failedChecks, "observability")
  ) {
    status = "conditional";
    reason = "operational or observability checks failed";
  } else if (missingCategories.length > 0) {
    status = "conditional";
    reason = `missing certification checks: ${missingCategories.join(", ")}`;
  } else if (certificationScopeForCase(caseResult) === "delta") {
    // ADR-0025 §5（Owner 方案 A，2026-08-19）：delta 子集全过 ≠ 全量认证——
    // status 落 conditional；升级唯一路径 = 全量重跑（mergeCaseResults 增量
    // 覆盖同 caseId，requiredCategories/drills 换全量后重判）。
    // reasonCode 诚实为 null：CERTIFICATION_REASON_CODES 闭集无 delta 码，且为
    // 保 MCP 面零改动不加码——wire 上该形状投影为 certificationReasonCode:null
    // （自由文本 reason 只在磁盘 summary，是另一层契约）。
    status = "conditional";
    reason = "delta certification scope passed: full rerun required to upgrade to certified";
  } else {
    status = "certified";
    reason = "all required checks passed";
  }

  // TD-111: 闭集机器码（经 SSOT 映射，与上面 if-else 同优先级）。certified → null。
  // 与自由文本 reason 并列新增；reason 原文一个字节不动（磁盘契约）。
  const reasonCode = reasonCodeFor({ status, failedChecks, blockerReason, missingCategories });

  return {
    status,
    recommendedUse: caseResult.recommendedUse ?? RECOMMENDED_USE[status],
    reason,
    reasonCode,
    failedChecks: failedChecks.map(({ name, category, detail, capability }) => ({
      name,
      category,
      detail,
      capability,
    })),
    capabilities,
  };
}

export function summarizeCertification(caseResults = [], options = {}) {
  const cases = caseResults.map((caseResult) => {
    const certification = caseResult.certification ?? certifyCase(caseResult);
    return { ...caseResult, certification };
  });
  const workers = summarizeWorkers(cases);
  // counts 按 agent 最终状态计数（与 workers 一致），非 per-case（否则一个 agent 多 case 被重复计）。
  // 有 agentId 的 case → 按 worker 最终状态计 1 次；
  // 无 agentId 的 case（suite-level，如 silentTimeout）→ 各自独立计 1 次。
  const countedAgents = new Set();
  const counts = Object.fromEntries(CERTIFICATION_STATUSES.map((status) => [status, 0]));
  for (const c of cases) {
    if (c.agentId) {
      if (countedAgents.has(c.agentId)) continue; // 同一 agent 只按最终状态计一次
      countedAgents.add(c.agentId);
      counts[workers[c.agentId].status] += 1;
    } else {
      counts[c.certification.status] += 1; // suite-level case
    }
  }

  return {
    version: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    counts,
    allCertified: Object.keys(workers).length > 0 && Object.values(workers).every((w) => w.status === "certified"),
    workers,
    cases,
  };
}

// 增量合并：把磁盘旧 case（prior）与本次 case（fresh）合并。
// 解决"单跑 --agent X 覆盖掉其他 worker 认证结果"的数据完整性缺口：
// summarizeCertification 只吃本次 case，不读磁盘；调用方需先用本函数把上次 summary 的 cases
// 与本次合并，再 summarize。
// 语义：以 caseId 为键，本次 fresh 覆盖同 caseId 的旧 case（重认证刷新），
// 未重跑的旧 case 保留（不丢失）。全新 caseId 追加到末尾。
// 纯函数（不碰磁盘），便于测试。prior/fresh 任一为空均安全。
export function mergeCaseResults(priorCases = [], freshCases = []) {
  const freshIds = new Set(freshCases.map((c) => c.caseId));
  const retained = priorCases.filter((c) => !freshIds.has(c.caseId));
  return [...retained, ...freshCases];
}

// TD-87 清算（2026-08-20，Owner 批准）：修剪已退出认证矩阵的僵尸 caseId。
// 背景：mergeCaseResults 以 caseId 为键只覆盖不清理——matrix 行的 label 改名后，
// 旧 label 的 case（典型：kimi 旧标签的历史 conditional）永远滞留，worker 级
// 最差聚合被陈年记录拖累（coder_mm 曾因此 4 case 里 3 个僵尸 conditional）。
// 规则：currentRows 为当前矩阵行（{agentId, label}）——prior case 满足以下任一
// 即保留：(a) caseId 仍在矩阵 labels 里；(b) 其 agentId 不在矩阵 agentIds 里
// （未被当前矩阵覆盖的 agent——如 legacy/孤儿记录——scope 之外不动）。
// 纯函数；与 mergeCaseResults 组合使用（调用方先 prune 再 merge）。
export function pruneStaleCases(priorCases = [], currentRows = []) {
  const labels = new Set(currentRows.map((r) => r?.label).filter(Boolean));
  const agentIds = new Set(currentRows.map((r) => r?.agentId).filter(Boolean));
  return priorCases.filter((c) => labels.has(c.caseId) || !agentIds.has(c.agentId));
}

function summarizeWorkers(cases) {
  const workers = {};
  const byAgent = new Map();
  for (const c of cases) {
    if (!c.agentId) continue;
    if (!byAgent.has(c.agentId)) byAgent.set(c.agentId, []);
    byAgent.get(c.agentId).push(c);
  }
  for (const [agentId, agentCases] of byAgent) {
    // active identity = 该 agent 最近一次观察到的 backend+providerID+modelId。
    // 只把 active identity 的 case 聚合进 worker summary；历史旧 identity 的 case
    // 不进入 status/capabilities/cases 聚合（避免旧 claude-code 掩盖新 deepseek-harness），
    // 但仍保留在 summarizeCertification 的 summary.cases（可审计历史）。
    const active = findActiveIdentity(agentCases);
    let summary = null;
    for (const c of agentCases) {
      if (!matchesActiveIdentity(c, active)) continue;
      const status = worseStatus(summary?.status, c.certification.status);
      // TD-111: worker 的 reasonCode 取"决定最终（最差）status 的那个 case"的码。
      // 分支语境（如 blocked 优先于 core 失败）只在 case 级成立，聚合层不可用
      // 合并后的 failedChecks 重建；平级 status 冲突时保留先观察到的 case 的码（确定性）。
      const adoptsWorse =
        summary === null || STATUS_SEVERITY[c.certification.status] > STATUS_SEVERITY[summary.status];
      summary = {
        agentId,
        backend: active.backend,
        providerID: active.providerID,
        modelId: active.modelId,
        status,
        recommendedUse: RECOMMENDED_USE[status],
        // ADR-0025 §5：认证范围事实字段（"full"|"delta"），按 active-identity 各
        // case 的 profile/drill 覆盖派生，混合取保守值（任一 delta → delta）。
        // 只活在磁盘 summary + 文档层，不进 CLI/MCP inventory 投影。
        certificationScope: mergeCertificationScope(
          summary?.certificationScope,
          certificationScopeForCase(c),
        ),
        reasonCode: adoptsWorse ? workerReasonCode(c.certification) : summary.reasonCode,
        // TD-111: 该 worker（active identity 的 case）最近一次全绿的时间；从未全绿 → null。
        lastHealthyRunAt: latestTimestamp(summary?.lastHealthyRunAt ?? null, c.lastHealthyRunAt ?? null),
        capabilities: mergeCapabilities(
          summary?.capabilities ?? {},
          c.certification.capabilities ?? {},
        ),
        cases: [...(summary?.cases ?? []), c.caseId],
      };
    }
    if (summary) workers[agentId] = summary;
  }
  return workers;
}

// case 级 certification → 闭集码。新数据用 certifyCase 产出的 reasonCode（权威）；
// legacy 磁盘 case（预置 certification、无 reasonCode）经 SSOT 尽力重 derive——
// blocked 分支在 SSOT 中优先，故 blocked+core 失败的旧数据仍映射正确；
// 无法安全归类（如旧 conditional-missing 无 failedChecks 可辨）→ null，不伪造。
function workerReasonCode(cert) {
  if (!cert) return null;
  if (cert.reasonCode !== undefined) return cert.reasonCode ?? null;
  return reasonCodeFor({ status: cert.status, failedChecks: cert.failedChecks ?? [] });
}

// 两个 ISO-8601 UTC 时间戳取较新者（同格式 ISO 字符串字典序即时间序）；均无 → null。
function latestTimestamp(left, right) {
  if (left == null) return right ?? null;
  if (right == null) return left;
  return right > left ? right : left;
}

// case 声明 identity 当且仅当至少一个 identity 字段非 null/undefined/空串。
// active identity 取最后一个声明过 identity 的 case 所声明的字段。
// 从未声明 identity 的 agent（旧数据）→ active 全 null，全部 case 聚合（legacy 行为）。
function findActiveIdentity(agentCases) {
  let active = { backend: null, providerID: null, modelId: null };
  for (const c of agentCases) {
    const declared = declaredIdentity(c);
    if (declared.backend !== null || declared.providerID !== null || declared.modelId !== null) {
      active = declared;
    }
  }
  return active;
}

// case 属于 active identity 当且仅当：其声明过的每个 identity 字段与 active 对应字段一致。
// 未声明任何 identity 字段的 case（如历史聚合 fixture）继承 active identity，保持同 identity 聚合。
function matchesActiveIdentity(c, active) {
  const declared = declaredIdentity(c);
  if (declared.backend === null && declared.providerID === null && declared.modelId === null) {
    return true;
  }
  return (declared.backend === null || declared.backend === active.backend) &&
         (declared.providerID === null || declared.providerID === active.providerID) &&
         (declared.modelId === null || declared.modelId === active.modelId);
}

function declaredIdentity(c) {
  return {
    backend: normalizeIdentityField(c.backend),
    providerID: normalizeIdentityField(c.providerID),
    modelId: normalizeIdentityField(c.modelId),
  };
}

function normalizeIdentityField(value) {
  return value === null || value === undefined || value === "" ? null : value;
}

function normalizeChecks(checks = []) {
  return checks.map((check) => ({
    ...check,
    name: String(check.name),
    pass: Boolean(check.pass),
    category: normalizeCategory(check.category),
  }));
}

function normalizeCategory(category) {
  if (CATEGORY_ORDER.includes(category)) return category;
  return "core";
}

function hasFailedCategory(failedChecks, category) {
  return failedChecks.some((check) => check.category === category);
}

function findMissingRequiredCategories(checks, requiredCategories) {
  return requiredCategories
    .filter((category) => CATEGORY_ORDER.includes(category))
    .filter((category) =>
      !checks.some((check) =>
        check.category === category &&
        check.pass === true &&
        check.optional !== true
      )
    );
}

function aggregateCapabilities(checks) {
  const capabilities = {};
  for (const check of checks) {
    if (!check.capability) continue;
    const value = check.optional && check.pass === false ? "unknown" : check.pass;
    if (!(check.capability in capabilities)) {
      capabilities[check.capability] = value;
      continue;
    }
    capabilities[check.capability] = mergeCapability(
      capabilities[check.capability],
      value,
    );
  }
  return capabilities;
}

function mergeCapability(left, right) {
  if (left === false || right === false) return false;
  if (left === "unknown" || right === "unknown") return "unknown";
  return Boolean(left && right);
}

function worseStatus(left = "certified", right = "certified") {
  return STATUS_SEVERITY[right] > STATUS_SEVERITY[left] ? right : left;
}

function mergeCapabilities(left, right) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (!(key in merged)) {
      merged[key] = value;
      continue;
    }
    merged[key] = mergeCapability(merged[key], value);
  }
  return merged;
}

function classifyExternalBlocker(error) {
  if (!error) return null;
  const text = String(error);
  if (
    /quota|credit|insufficient|upper limit|rate limit|429|1310|额度|余额/i.test(text) ||
    /401|403|unauthori[sz]ed|authentication|api key|authorization|身份验证|鉴权|权限/i.test(text) ||
    /not in registry|missing.*agent|missing.*provider|ECONNREFUSED|connection refused/i.test(text)
  ) {
    return "provider/credential/quota blocker";
  }
  return null;
}
