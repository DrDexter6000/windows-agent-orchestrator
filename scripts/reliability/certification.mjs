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
  } else {
    status = "certified";
    reason = "all required checks passed";
  }

  return {
    status,
    recommendedUse: caseResult.recommendedUse ?? RECOMMENDED_USE[status],
    reason,
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

function summarizeWorkers(cases) {
  const workers = {};
  for (const c of cases) {
    if (!c.agentId) continue;
    const existing = workers[c.agentId];
    const status = worseStatus(existing?.status, c.certification.status);
    workers[c.agentId] = {
      agentId: c.agentId,
      backend: existing?.backend ?? c.backend ?? null,
      providerID: existing?.providerID ?? c.providerID ?? null,
      modelId: existing?.modelId ?? c.modelId ?? null,
      status,
      recommendedUse: RECOMMENDED_USE[status],
      capabilities: mergeCapabilities(
        existing?.capabilities ?? {},
        c.certification.capabilities ?? {},
      ),
      cases: [...(existing?.cases ?? []), c.caseId],
    };
  }
  return workers;
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
