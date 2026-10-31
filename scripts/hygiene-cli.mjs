// Thin CLI for the hygiene library (ADR 0035 W1-W5). No args accepted; see
// scripts/hygiene.mjs for the importable library and configuration.
import path from "node:path";
import {
  ROOT_WHITELIST, BRANCH_CAP, REGISTRY_EXTERNAL_ROOTS,
  listWorktreePaths, countRunBranches, classifyRegistryEntries, classifyBranchCount,
  checkRootWhitelist, checkTombstones, checkContinuationEntry,
} from "./hygiene.mjs";
// 反馈收件箱提示：根用与 CLI 同一个解析函数（主检出，不看 cwd）；提示不是第六个
// 检查项——不改变 W1-W5 判定、PASS 文案与退出码，异常整段吞掉。
import { feedbackInboxHintLines, resolveFeedbackInboxDir } from "../src/application/feedbackInbox.js";

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
  problems: bc.ok ? [] : [`当前 ${bc.count} > 帽 ${bc.cap} → 修复: wao worktree reclaim 清退（规程见 docs/usage/maintenance.md）；确需扩容: 改 hygiene.mjs BRANCH_CAP + declare`],
  notes: bc.ok ? [`当前 ${bc.count} / 帽 ${bc.cap}`] : [],
});

let fail = 0;
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} [${r.id}] ${r.name}`);
  for (const l of r.lines) console.log(`    ${l}`);
  if (!r.ok) fail++;
}
console.log(fail === 0 ? "hygiene: PASS (5/5)" : `hygiene: FAIL (${fail} red) — 每条红线上方有修复路径`);
// W1-W5 之后的收件箱提示（只报计数，不报标题与正文；任何异常都不影响上面的判定与退出码）。
try {
  const lines = feedbackInboxHintLines({ inboxDir: resolveFeedbackInboxDir({ packageRoot: repo }) });
  for (const line of lines) console.log(line);
} catch { /* 提示不是检查项：吞掉，绝不让 hygiene 提前终止或变红 */ }
process.exit(fail === 0 ? 0 : 1);
