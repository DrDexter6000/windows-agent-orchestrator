// Thin CLI for the hygiene library (ADR 0035 W1-W5). No args accepted; see
// scripts/hygiene.mjs for the importable library and configuration.
import path from "node:path";
import {
  ROOT_WHITELIST, BRANCH_CAP, REGISTRY_EXTERNAL_ROOTS,
  listWorktreePaths, countRunBranches, classifyRegistryEntries, classifyBranchCount,
  checkRootWhitelist, checkTombstones, checkContinuationEntry,
} from "./hygiene.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const runsDir = path.join(repo, ".wao/runs");
const results = [];
const add = (id, name, r) => results.push({ id, name, ok: r.ok, lines: [...(r.problems ?? []), ...(r.notes ?? [])] });

add("W1", ".wao/runs 根白名单（逐条带理由）", checkRootWhitelist(runsDir));
add("W2", "墓碑双向完整性", checkTombstones(runsDir));
add("W3", "续接入口唯一性（.strategy/AGENTS.md）", checkContinuationEntry(path.join(repo, ".strategy/AGENTS.md"), runsDir));

const drift = classifyRegistryEntries(listWorktreePaths(repo), { repo });
const driftProblems = drift.filter((d) => d.status !== "ok-main" && d.status !== "ok-external")
  .map((d) => d.status === "missing"
    ? `注册指向消失路径: ${d.path} → 修复: git worktree prune 或恢复目录`
    : `注册落在未登记根: ${d.path} → 修复: 确认归属后加 REGISTRY_EXTERNAL_ROOTS（带理由+declare），或清理该注册`);
add("W5", "worktree 注册漂移", { ok: driftProblems.length === 0, problems: driftProblems });

const bc = classifyBranchCount(countRunBranches(repo));
add("W4", `wao/run_* 分支棘轮帽 ${BRANCH_CAP}`, {
  ok: bc.ok,
  problems: bc.ok ? [] : [`当前 ${bc.count} > 帽 ${bc.cap} → 修复: 交付收尾清理（已决+非脏+活文档零引用→remove+删分支）；确需扩容: 改 hygiene.mjs BRANCH_CAP + declare`],
  notes: bc.ok ? [`当前 ${bc.count} / 帽 ${bc.cap}`] : [],
});

let fail = 0;
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} [${r.id}] ${r.name}`);
  for (const l of r.lines) console.log(`    ${l}`);
  if (!r.ok) fail++;
}
console.log(fail === 0 ? "hygiene: PASS (5/5)" : `hygiene: FAIL (${fail} red) — 每条红线上方有修复路径`);
process.exit(fail === 0 ? 0 : 1);
