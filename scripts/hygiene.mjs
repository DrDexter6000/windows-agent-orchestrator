// Workspace hygiene library — ADR 0035 guard inventory W1-W5.
// Pure/classifying functions + fact collectors; importable with zero side
// effects (thin CLI: scripts/hygiene-cli.mjs). Zero dependencies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

export const normPath = (p) => p.replace(/\\/g, "/").toLowerCase();
export const defaultExists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

// ---- W1 config: .wao/runs root whitelist (edit + reason + declare per ADR 0035) ----
export const ROOT_WHITELIST = new Map([
  ["HANDOFF.md", "墓碑指针：撤销历史'唯一续接状态页'自称"],
  ["HANDOFF-ARCHIVED-20260929.md", "墓碑指向的冻结原文（行号锚点保持）"],
  ["gen-surface-T2.json", "TD-185 引用的验收证据（tracked 文档引用，留明面）"],
  ["gen-surface-T2-binding.json", "TD-185 引用的验收绑定（同上）"],
  ["shared-cost", "活证据（t3 发布验收）+ 三本归档日志 + 墓碑"],
  ["cleanup-consult-20260929", "2026-09 清洁包案卷（ADR 0034/0035 引用）"],
  ["s3-integration-t3-20260930", "S3 前作集成的 T3 证据目录（工作流闭合时移入 archive 并除名）"],
  ["archive-2026-09", "历史证据冷藏室（含 INDEX.md 与移动清单，内容不逐件检查）"],
]);

// ---- W4 config ----
export const BRANCH_CAP = 175; // 2026-09-30 baseline 151 + headroom

// ---- W5 config: known external checkout roots ----
// 用户名相关根从 os.homedir() 运行时派生（tracked 文件不得含本机绝对路径——
// 脱敏守卫 desensitization.test.js 的铁律）；无用户名的根才用字面量。
export const REGISTRY_EXTERNAL_ROOTS = new Map([
  [normPath(path.join(os.homedir(), ".codex", "worktrees")), "codex clone（filesystem-eight 等持有 246 原始 T2 证据 worktree）"],
  ["d:/projects/.codex-worktrees", "2026-06~08 老 checkout 群（m12-8f 等，物理仍在）"],
  ["d:/projects/windows-agent-orchestrator-poc-dispatch-readiness", "2026-06 dispatch-readiness checkout"],
  ["d:/projects/windows-agent-orchestrator-poc/.dev", ".dev 私有合同 worktree"],
]);

// ---- A-class classifiers (pure, fixture-testable) ----
export function classifyRegistryEntries(paths, { repo, externalRoots = REGISTRY_EXTERNAL_ROOTS, existsFn = defaultExists }) {
  const mainRoot = normPath(repo);
  return paths.map((p) => {
    const np = normPath(p);
    if (!existsFn(p)) return { path: p, status: "missing" };
    if (np === mainRoot || np.startsWith(mainRoot + "/")) return { path: p, status: "ok-main" };
    for (const [root] of externalRoots) if (np.startsWith(root)) return { path: p, status: "ok-external" };
    return { path: p, status: "unknown-root" };
  });
}

export function classifyBranchCount(count, cap = BRANCH_CAP) {
  return { ok: count <= cap, count, cap };
}

// ---- A-class fact collectors (spawn git; consistent from any worktree of this repo) ----
export function listWorktreePaths(cwd) {
  const raw = execSync("git worktree list --porcelain", { cwd, encoding: "utf8" });
  return [...raw.matchAll(/^worktree (.+)$/gm)].map((m) => m[1]);
}

export function countRunBranches(cwd) {
  return execSync('git branch --list "wao/run_*"', { cwd, encoding: "utf8" })
    .split("\n").filter((s) => s.trim()).length;
}

// ---- B-class checks (main-repo filesystem state only; NOT suite-safe per R23-D §7) ----
export function checkRootWhitelist(runsDir, whitelist = ROOT_WHITELIST) {
  const actual = fs.readdirSync(runsDir);
  const problems = [];
  for (const a of actual) if (!whitelist.has(a))
    problems.push(`多余条目: ${a} → 修复: 移入 .wao/runs/archive-<YYYY-MM>/ 并更新白名单（带理由+declare），或证明归属后加列`);
  for (const [w] of whitelist) if (!actual.includes(w))
    problems.push(`白名单条目缺失: ${w} → 修复: 有意移除则改白名单+declare；否则找回`);
  return { ok: problems.length === 0, problems };
}

export function checkTombstones(runsDir) {
  const mdFiles = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "archive-2026-09") walk(f, depth + 1); }
      else if (/\.md$/.test(e.name)) mdFiles.push(f);
    }
  };
  walk(runsDir, 0);
  const isTombstone = (f) => { try { return fs.readFileSync(f, "utf8").slice(0, 300).includes("[墓碑]"); } catch { return false; } };
  const problems = [];
  for (const f of mdFiles.filter(isTombstone)) {
    const text = fs.readFileSync(f, "utf8");
    const refs = [...text.matchAll(/([\w.\-]+ARCHIVED-\d{8}(?:\.md)?)/g)].map((m) => m[1]);
    if (refs.length === 0) { problems.push(`墓碑无指向: ${path.basename(f)} → 修复: 补指向或撤墓碑标记`); continue; }
    for (const r of refs) if (!defaultExists(path.join(path.dirname(f), r)))
      problems.push(`墓碑指针断裂: ${path.basename(f)} → ${r} 不存在`);
  }
  for (const a of mdFiles.filter((f) => /ARCHIVED-\d{8}/.test(path.basename(f)))) {
    const hasTomb = mdFiles.some((f) => path.dirname(f) === path.dirname(a) && isTombstone(f) &&
      fs.readFileSync(f, "utf8").includes(path.basename(a)));
    if (!hasTomb) problems.push(`归档件无墓碑指回: ${path.basename(a)} → 修复: 原路径留墓碑或 declare 豁免`);
  }
  return { ok: problems.length === 0, problems };
}

export function checkContinuationEntry(strategyEntry, runsDir) {
  const notes = [];
  if (!defaultExists(strategyEntry)) return { ok: true, problems: [], notes: ["入口文件不存在（无工作流时合法）"] };
  const text = fs.readFileSync(strategyEntry, "utf8");
  if (text.includes("已关闭")) return { ok: true, problems: [], notes: ["入口处于关闭态（0 活页）"] };
  const m = text.match(/\.wao\/runs\/([\w.\-]+\.md)/);
  if (!m) return { ok: false, problems: ["入口未关闭也未指向 .wao/runs 活页 → 修复: 明确关闭或补指向"], notes };
  const target = path.join(runsDir, m[1]);
  if (!defaultExists(target)) return { ok: false, problems: [`入口指向的活页不存在: ${m[1]} → 修复: 恢复或关闭`], notes };
  if (fs.readFileSync(target, "utf8").slice(0, 300).includes("[墓碑]"))
    return { ok: false, problems: ["入口指向了墓碑 → 修复: 换指向或关闭"], notes };
  return { ok: true, problems: [], notes: [`入口指向活页: ${m[1]}（1 活页）`] };
}
