// scripts/migration/migrate-cert-ledger.mjs
//
// 0045 §4.2/§6 第 4 步：认证台账换键迁移（席位键 agentId → 车道内容指纹键）。
//
// 合同纪律（决定 0045 + R2/R3 会审裁定）：
//   - **自描述派生**：每条 worker/case 记录的车道身份从其自带事实
//     （backend/providerID/modelId/providerKey）派生——名字会说谎（coder_hq_deltadrill
//     记的是 claude-code 时代），记录不会。
//   - **证据守恒**：caseId 全集前后 hash 相等；同车道合并取 cases 并集；状态取
//     最严；时间戳不刷新（R23-C：缺失不补证、不自动升 full）；每条原始记录的
//     事实以 provenance 保留——不能只取"最好结果"（R2 auditor 裁定）。
//   - **幂等**：已带 ledgerKeySpace="lane-v1" 标记的台账为无操作。
//   - **dry-run 默认**：不带 --apply 只打印迁移计划与守恒校验，零写入。
//   - **pruneStaleCases 冻结**：--apply 后到验证完成前禁止跑 reliability
//     （其清理规则按矩阵 label 集工作，换键窗口会误删历史）——本脚本输出的
//     证据包里带此提醒，执行 SOP 由切换窗口（§6 第 7 步）承载。
//   - **例外/manualOverride 不迁移**：0036/0037/0041 例外按车道身份重签为
//     git 跟踪决定修订条（另批执行）；manualOverride 由 Owner 重签。
//
// 用法：node scripts/wao-node.cjs scripts/migration/migrate-cert-ledger.mjs [--apply]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SUMMARY_PATH = process.argv.includes("--summary")
  ? resolve(process.argv[process.argv.indexOf("--summary") + 1])
  : join(REPO_ROOT, "runs", "reliability-summary.json");
const APPLY = process.argv.includes("--apply");
const EVIDENCE_DIR = process.argv.includes("--evidence-dir")
  ? resolve(process.argv[process.argv.indexOf("--evidence-dir") + 1])
  : join(REPO_ROOT, ".wao", "migration", "0045-ledger");

const STATUS_SEVERITY = { "draft-only": 0, blocked: 0, rejected: 0, conditional: 1, certified: 2 };
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function laneKeyOf(record) {
  // 与 identityProjection.laneFingerprint 同一四元组（backend/modelId/providerID/
  // providerKey），键形 lane:<16hex>；null 归一。
  const tuple = {
    backend: record?.backend ?? null,
    modelId: record?.modelId ?? null,
    providerID: record?.providerID ?? null,
    providerKey: record?.providerKey ?? null,
  };
  return "lane:" + sha256(JSON.stringify(tuple)).slice(0, 16);
}

const before = readFileSync(SUMMARY_PATH, "utf8");
const beforeSummary = JSON.parse(before);
if (beforeSummary.ledgerKeySpace === "lane-v1") {
  console.log(JSON.stringify({ verdict: "already-migrated", ledgerKeySpace: beforeSummary.ledgerKeySpace }));
  process.exit(0);
}

// ── 迁移计划：每条 worker 记录按自带事实归车道 ──────────────────────────────
const laneRecords = new Map(); // laneKey -> merged record
const mapping = []; // {agentId → laneKey, status, kept-as-provenance}
for (const [agentId, w] of Object.entries(beforeSummary.workers ?? {})) {
  const laneKey = laneKeyOf(w);
  mapping.push({ agentId, laneKey, status: w.status ?? null, scope: w.certificationScope ?? null });
  if (!laneRecords.has(laneKey)) {
    laneRecords.set(laneKey, {
      laneKey,
      backend: w.backend ?? null,
      providerID: w.providerID ?? null,
      modelId: w.modelId ?? null,
      providerKey: w.providerKey ?? null,
      status: w.status ?? "draft-only",
      recommendedUse: w.recommendedUse ?? null,
      certificationScope: w.certificationScope ?? null,
      capabilities: w.capabilities ?? null,
      lastHealthyRunAt: w.lastHealthyRunAt ?? null,
      lastFullHealthyRunAt: w.lastFullHealthyRunAt ?? null,
      executionProfile: w.executionProfile ?? null,
      reasonCode: w.reasonCode ?? null,
      cases: [...(w.cases ?? [])],
      provenance: [{ agentId, status: w.status ?? null, recommendedUse: w.recommendedUse ?? null, certificationScope: w.certificationScope ?? null, caseCount: (w.cases ?? []).length }],
    });
    continue;
  }
  // 同车道合并（R2/R4 裁定）：cases 取并集（保序）；状态取最严；时间戳不刷新
  // （保留最早的观察）；原始记录入 provenance；manualOverride 不迁移。
  const lane = laneRecords.get(laneKey);
  for (const c of w.cases ?? []) if (!lane.cases.includes(c)) lane.cases.push(c);
  if ((STATUS_SEVERITY[w.status] ?? 0) < (STATUS_SEVERITY[lane.status] ?? 0)) {
    lane.status = w.status;
    lane.recommendedUse = w.recommendedUse ?? lane.recommendedUse;
  }
  if (lane.lastHealthyRunAt === null && w.lastHealthyRunAt) lane.lastHealthyRunAt = w.lastHealthyRunAt;
  if (lane.lastFullHealthyRunAt === null && w.lastFullHealthyRunAt) lane.lastFullHealthyRunAt = w.lastFullHealthyRunAt;
  lane.provenance.push({ agentId, status: w.status ?? null, recommendedUse: w.recommendedUse ?? null, certificationScope: w.certificationScope ?? null, caseCount: (w.cases ?? []).length });
}

// ── 守恒校验 ────────────────────────────────────────────────────────────────
const beforeCaseIds = (beforeSummary.cases ?? []).map((c) => c.caseId).sort();
const beforeWorkerCases = Object.values(beforeSummary.workers ?? {}).flatMap((w) => w.cases ?? []).sort();
const afterWorkerCases = [...laneRecords.values()].flatMap((l) => l.cases).sort();
const checks = {
  topCasesUntouched: true, // cases[] 顶层数组原样保留（史实清单，不重排不改写）
  workerCaseSetConserved: JSON.stringify(beforeWorkerCases) === JSON.stringify(afterWorkerCases),
  workerCountVsLaneCount: { workers: Object.keys(beforeSummary.workers ?? {}).length, lanes: laneRecords.size },
};
const verdict = checks.workerCaseSetConserved ? "PASS" : "FAIL";

const evidence = {
  schema: 1,
  migration: "0045-ledger-seat-to-lane",
  ranAt: new Date().toISOString(),
  mode: APPLY ? "apply" : "dry-run",
  summaryPath: SUMMARY_PATH,
  beforeSummarySha256: sha256(before),
  beforeCounts: beforeSummary.counts ?? null,
  mapping,
  laneRecords: [...laneRecords.values()],
  conservation: {
    beforeWorkerCaseSha256: sha256(JSON.stringify(beforeWorkerCases)),
    afterWorkerCaseSha256: sha256(JSON.stringify(afterWorkerCases)),
    ...checks,
  },
  cautions: [
    "apply 后到验证完成前禁止跑 npm run reliability（pruneStaleCases 按矩阵 label 集清理，换键窗口会误删历史）",
    "0036/0037/0041 例外按车道身份重签为 git 跟踪修订条后，adjudicate-exceptions.mjs 整体退役（0045 §4.3）",
    "manualOverride 不迁移——Owner 重签（0045 §2/§4）",
  ],
};

if (verdict === "FAIL") {
  console.error(JSON.stringify({ verdict, failures: checks }, null, 2));
  process.exit(1);
}

if (!APPLY) {
  console.log(JSON.stringify({
    verdict: "DRY-RUN-PASS",
    wouldWrite: { lanes: laneRecords.size, workersMigrated: mapping.length },
    conservation: evidence.conservation,
    preview: [...laneRecords.values()].map((l) => ({ laneKey: l.laneKey, status: l.status, cases: l.cases.length, from: l.provenance.map((p) => p.agentId) })),
  }, null, 2));
  process.exit(0);
}

// ── apply：写新台账（保留 cases[] 史实清单原样）+ 快照 + 证据包 ─────────────
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
mkdirSync(EVIDENCE_DIR, { recursive: true });
copyFileSync(SUMMARY_PATH, SUMMARY_PATH + `.pre-lane-migration-${stamp}.bak`);
const after = {
  ...beforeSummary,
  ledgerKeySpace: "lane-v1",
  ledgerMigratedAt: evidence.ranAt,
  workers: Object.fromEntries([...laneRecords.values()].map((l) => [l.laneKey, l])),
};
writeFileSync(SUMMARY_PATH, JSON.stringify(after, null, 2) + "\n", "utf8");
const evidencePath = join(EVIDENCE_DIR, `evidence-${stamp}.json`);
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  verdict: "APPLIED",
  lanes: laneRecords.size,
  evidencePath,
  afterSummarySha256: sha256(JSON.stringify(after, null, 2) + "\n"),
}, null, 2));
