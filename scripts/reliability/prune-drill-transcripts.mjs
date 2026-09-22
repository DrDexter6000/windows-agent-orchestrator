// scripts/reliability/prune-drill-transcripts.mjs
//
// drill 转录的【显式维护步骤】（2026-09-22 审计收口：交错发布误删证据）。
//
// 背景：旧版 run-reliability.mjs 在写盘后按【进程内】summary 的引用集清理
// runs/reliability/——与其他发布者不协调，交错收尾时互删对方刚发布的证据
// （A 写 summary→B 写 summary 并清理→A 恢复清理 ⇒ 最终 summary 引用的转录
// 不存在）。根修后【发布路径零删除】，删除唯一入口 = 本脚本（薄壳；判定内核
// 在 drillEvidence.mjs::sweepStaleDrillTranscripts）：
//   - 删除前重新读取磁盘上的当前 summary（runs/reliability-summary.json）；
//   - 只删「未被任何条目引用 且 超过年龄阈值（默认 7 天，--max-age-days 覆盖）」
//     的 run_*.jsonl；被引用的绝不删（无论多老）；非 runId 文件名形状一律不动；
//   - summary 缺失/不可解析 → 一个都不删（fail-closed），如实报告原因。
//
// 用法（经 v22 shim，与既有入口同款）：
//   node scripts/wao-node.cjs scripts/reliability/prune-drill-transcripts.mjs
//   node scripts/wao-node.cjs scripts/reliability/prune-drill-transcripts.mjs --max-age-days 30
//   node scripts/wao-node.cjs scripts/reliability/prune-drill-transcripts.mjs --dry-run
//
// 运行纪律（与 runs prune 清扫 runbook 同款）：维护时无进行中的 reliability
// 运行。年龄阈值是维护步骤自身 TOCTOU 窗口的兜底（并发发布者刚写出的转录必然
// 年轻），不是并发协调机制——不要在认证运行中途执行本脚本。
//
// 零第三方依赖；参数解析在本文件内（reliability 共享 args.mjs 保持不动——
// component-check 的 componentArgs.mjs 同款先例）。

import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  drillTranscriptsDir,
  sweepStaleDrillTranscripts,
  DEFAULT_STALE_DRILL_TRANSCRIPT_AGE_MS,
} from "./drillEvidence.mjs";

const USAGE = `WAO drill 转录维护步骤（清理未被引用且超龄的 runs/reliability/ 转录；不消耗 token）

用法: node scripts/wao-node.cjs scripts/reliability/prune-drill-transcripts.mjs
                  [--max-age-days <n>] [--dry-run]

  --max-age-days <n>  未引用转录的年龄阈值（默认 7；须为正数）
  --dry-run           只判定不删除（列出将被清理的 runId）

删除前提：删除前重新读取磁盘当前 runs/reliability-summary.json；只删
「未被任何条目引用 且 超过年龄阈值」的 run_*.jsonl。被引用的绝不删。
summary 缺失/不可解析时一个都不删（fail-closed）。未知参数一律拒绝（exit 2）。`;

// --- 参数解析（纯判定；未知 flag 拒绝——与 reliability 入口同款纪律）---
function parseArgs(argv) {
  const values = { maxAgeDays: "7", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") return { help: true, values };
    if (token === "--dry-run") {
      values.dryRun = true;
      continue;
    }
    if (token === "--max-age-days") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { help: false, error: "--max-age-days requires a value", values };
      }
      if (!/^[0-9]+(\.[0-9]+)?$/.test(value) || Number(value) <= 0) {
        return { help: false, error: `--max-age-days must be a positive number (got: ${value})`, values };
      }
      values.maxAgeDays = value;
      i += 1;
      continue;
    }
    return { help: false, error: `unknown option: ${token} (see --help)`, values };
  }
  return { help: false, error: null, values };
}

const _argResult = parseArgs(process.argv.slice(2));
if (_argResult.help) {
  console.log(USAGE);
  process.exit(0);
}
if (_argResult.error) {
  console.error(`[prune-drill-transcripts] ${_argResult.error}`);
  console.error(USAGE);
  process.exit(2);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const RUNS_DIR = join(ROOT, "runs");
const TRANSCRIPTS_DIR = drillTranscriptsDir(RUNS_DIR);
const SUMMARY_PATH = join(RUNS_DIR, "reliability-summary.json");
const MAX_AGE_MS = Number(_argResult.values.maxAgeDays) * 24 * 60 * 60 * 1000;

const result = sweepStaleDrillTranscripts(TRANSCRIPTS_DIR, SUMMARY_PATH, {
  maxAgeMs: MAX_AGE_MS,
  dryRun: _argResult.values.dryRun,
});

if (result.status !== "pruned") {
  // fail-closed：没有任何删除发生；status 区分缺文件/不可解析/读错误。
  console.log(`[prune-drill-transcripts] nothing pruned (${result.status}) — summary: ${SUMMARY_PATH}`);
  if (result.status === "summary-missing") {
    console.log("[prune-drill-transcripts] 先跑 npm run reliability 产生 summary，再执行维护。");
  }
  process.exit(0);
}

console.log(`Drill transcripts (${TRANSCRIPTS_DIR.split("\\").join("/")}): ` + (
  _argResult.values.dryRun
    ? `dry-run — would prune ${result.wouldRemove.length}, referenced kept ${result.keptReferenced}, under-age kept ${result.keptYoung}`
    : `pruned ${result.removed} unreferenced (age > ${_argResult.values.maxAgeDays}d), referenced kept ${result.keptReferenced}, under-age kept ${result.keptYoung}`
));
if (result.wouldRemove.length > 0) {
  console.log(`  would remove: ${result.wouldRemove.join(", ")}`);
}
if (result.skipped > 0) {
  console.log(`  skipped ${result.skipped} (stat/delete failed — file lock? retry next maintenance run)`);
}
process.exit(0);
