// src/application/certificationReasons.js
//
// TD-111: certification advisory context — 闭集 reasonCode SSOT。
//
// 认证 summary 的自由文本 `reason`（scripts/reliability/certification.mjs）会携带
// 调用方/错误派生文本（blockerReason 原文、missingCategories 插值等）——那是磁盘
// 契约，永不改写；但 wire（registry_list / lead_preflight）需要一个**机器可读、
// 安全**的 advisory 码：闭集、冻结、与 reason 分支一一对应。
//
// 本模块是该闭集的唯一权威（single source of truth）：
//   - certification.mjs 用 reasonCodeFor() 在 case 级产出 reasonCode；
//   - registryInventory.js 用 CERTIFICATION_REASON_CODES 在投影层做闭集校验
//     （越界码 fail-closed 为 null，绝不透出到 MCP enum parse）；
//   - src/mcp/server.js 的 AGENT_ENTRY / LEAD_PREFLIGHT_OUTPUT enum 从本常量
//     派生（READ_FAILURE_REASONS 同源接线范式），无第二份手工清单。
//
// 安全铁律：blockerReason 原文（含路径/命令/stderr/配额错误文本）绝不进码、
// 绝不进任何输出——码只描述"哪个分支"，不携带任何分支输入的原文。
//
// 纯模块：零 import、零 I/O，模块加载期自检（闭集去重）。

// 五个码与 certifyCase 的五条失败分支（scripts/reliability/certification.mjs
// :38-56 的 if-else 顺序）一一对应：
//   case_blocked                        ← blocked===true || blockerReason（分支 1）
//   core_checks_failed                  ← core 类失败（分支 2，rejected）
//   strict_evidence_failed              ← strict 类失败（分支 3，draft-only）
//   operational_or_observability_failed ← operational/observability 类失败（分支 4，conditional）
//   missing_certification_checks        ← 必需类别缺失（分支 5，conditional）
const CODES = [
  "case_blocked",
  "core_checks_failed",
  "strict_evidence_failed",
  "operational_or_observability_failed",
  "missing_certification_checks",
];

// 模块加载期去重自检：闭集含重复码是编程错误，fail fast 而不是静默漂移。
if (new Set(CODES).size !== CODES.length) {
  throw new Error("CERTIFICATION_REASON_CODES contains duplicate codes");
}

export const CERTIFICATION_REASON_CODES = Object.freeze([...CODES]);

/**
 * 纯映射：certification 分支输入 → 闭集码。
 *
 * 分支优先级与 certifyCase 的 if-else 链一致（blocked 优先于 core 失败——
 * blocked case 常伴随 core 失败，因为 run 从未完成；分支语境只在 case 级成立，
 * 聚合层必须沿用 case 级已判定的码，不可用合并后的 failedChecks 重建）。
 *
 * @param {object} input
 * @param {string} input.status — certifyCase 判定的 status（certified 时无 advisory 码）
 * @param {Array<{category?: string}>} [input.failedChecks] — 归一化后的失败 checks
 * @param {string|null} [input.blockerReason] — 自由文本 blocker 原文（只决定分支，绝不进码）
 * @param {string[]} [input.missingCategories] — 缺失的必需类别
 * @returns {string|null} 闭集码；certified → null；无法安全分类 → null（绝不伪造）
 */
export function reasonCodeFor({
  status,
  failedChecks = [],
  blockerReason = null,
  missingCategories = [],
} = {}) {
  if (status === "certified") return null;
  if (status === "blocked" || blockerReason) return "case_blocked";
  const failed = Array.isArray(failedChecks) ? failedChecks : [];
  if (failed.some((c) => c?.category === "core")) return "core_checks_failed";
  if (failed.some((c) => c?.category === "strict")) return "strict_evidence_failed";
  if (
    failed.some((c) => c?.category === "operational" || c?.category === "observability")
  ) {
    return "operational_or_observability_failed";
  }
  if (Array.isArray(missingCategories) && missingCategories.length > 0) {
    return "missing_certification_checks";
  }
  // 非 certified 但无法安全归类（如手写 legacy summary 的 conditional-missing 类）：
  // null（诚实缺失），绝不挑一个近似码伪造。
  return null;
}
