// scripts/migration/resummarize-cert.mjs
//
// 0045 §4.3 判定层修复工具：从磁盘 cases 重新 summarize 台账（零 token——例外
// 是判定不是事实；drill 转录/runId/时间戳全部原样）。用于例外消费方落地后修复
// 被机械降级的车道记录，不重跑任何 drill。
// 用法：node scripts/wao-node.cjs scripts/migration/resummarize-cert.mjs [--dry-run]
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { summarizeCertification, pruneStaleCases } from "../reliability/certification.mjs";

const SUMMARY = "runs/reliability-summary.json";
const DRY = process.argv.includes("--dry-run");
const before = readFileSync(SUMMARY, "utf8");
const prior = JSON.parse(before);
if (!Array.isArray(prior.cases)) throw new Error("summary.cases 缺失——无法重判");
// TD-87 清算（与全量 reliability 的 merge 前清理同规则）：退役矩阵行的陈年 caseId
// 不再拖累聚合。currentRows=当前 config/agents.json certification.matrix。
const registry = JSON.parse(readFileSync("config/agents.json", "utf8"));
const currentRows = registry.certification?.matrix ?? [];
const cases = pruneStaleCases(prior.cases, currentRows);
const pruned = prior.cases.length - cases.length;
const matrixAgentIds = new Set(currentRows.map((r) => r.agentId).filter(Boolean));
const after = summarizeCertification(cases, { generatedAt: new Date().toISOString(), matrixAgentIds });
const rows = [];
for (const key of new Set([...Object.keys(prior.workers ?? {}), ...Object.keys(after.workers)])) {
  const a = prior.workers?.[key];
  const b = after.workers?.[key];
  if ((a?.status ?? "-") === (b?.status ?? "-")) continue;
  rows.push({ key, from: a?.status ?? "(new)", to: b?.status ?? "-", backend: b?.backend ?? a?.backend, modelId: b?.modelId ?? a?.modelId });
}
console.log(JSON.stringify({ verdict: rows.length ? (DRY ? "DRY-RUN-CHANGES" : "RESUMMARIZED") : "NO-CHANGES", prunedStaleCases: pruned, changes: rows, dryRun: DRY }, null, 2));
if (!DRY && rows.length) {
  copyFileSync(SUMMARY, SUMMARY + ".pre-resummarize.bak");
  writeFileSync(SUMMARY, JSON.stringify(after, null, 2) + "\n", "utf8");
}
