// Workspace hygiene checker — ADR 0035 stage 1 (guard inventory W1-W5).
// Class-B filesystem state + class-A git state. Every RED prints its fix path
// (green-path axiom). Zero dependencies beyond Node builtins. NOT part of the
// canonical suite (R23-D §7: main-repo gitignored state is invisible in worktrees).
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const repo = path.resolve(import.meta.dirname, "..");
const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
const sh = (cmd) => execSync(cmd, { cwd: repo, encoding: "utf8" });

// ---- W1: .wao/runs root whitelist (edit entries + reasons here; changes are
// git-tracked and must be declared per ADR 0035) ----
const ROOT_WHITELIST = new Map([
  ["HANDOFF.md", "墓碑指针：撤销历史'唯一续接状态页'自称"],
  ["HANDOFF-ARCHIVED-20260929.md", "墓碑指向的冻结原文（行号锚点保持）"],
  ["gen-surface-T2.json", "TD-185 引用的验收证据（tracked 文档引用，留明面）"],
  ["gen-surface-T2-binding.json", "TD-185 引用的验收绑定（同上）"],
  ["shared-cost", "活证据（t3 发布验收）+ 三本归档日志 + 墓碑"],
  ["cleanup-consult-20260929", "2026-09 清洁包案卷（ADR 0034/0035 引用）"],
  ["archive-2026-09", "历史证据冷藏室（含 INDEX.md 与移动清单，内容不逐件检查）"],
]);

// ---- W4: branch ratchet cap (raise = edit here + declare; ADR 0035) ----
const BRANCH_CAP = 175; // 2026-09-30 baseline 151 + headroom

// ---- W5: known external checkout roots (add + reason + declare) ----
const EXTERNAL_ROOTS = new Map([
  ["c:/users/17865/.codex/worktrees", "codex clone（filesystem-eight 等持有 246 原始 T2 证据 worktree）"],
  ["d:/projects/.codex-worktrees", "2026-06~08 老 checkout 群（m12-8f 等，物理仍在）"],
  ["d:/projects/windows-agent-orchestrator-poc-dispatch-readiness", "2026-06 dispatch-readiness checkout"],
  ["d:/projects/windows-agent-orchestrator-poc/.dev", ".dev 私有合同 worktree"],
]);

const results = [];
const check = (id, name, fn) => {
  const details = [];
  let ok = true;
  try { ok = fn(details); } catch (e) { ok = false; details.push("检查异常：" + String(e.message).slice(0, 120)); }
  results.push({ id, name, ok, details });
};

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

// W1 root whitelist
check("W1", ".wao/runs 根白名单（逐条带理由）", (d) => {
  const dir = path.join(repo, ".wao/runs");
  const actual = fs.readdirSync(dir);
  let ok = true;
  for (const a of actual) {
    if (!ROOT_WHITELIST.has(a)) {
      ok = false;
      d.push(`多余条目: ${a} → 修复: 移入 .wao/runs/archive-<YYYY-MM>/ 并更新本白名单（带理由+declare），或证明其归属后加列`);
    }
  }
  for (const [w, reason] of ROOT_WHITELIST) {
    if (!actual.includes(w)) { ok = false; d.push(`白名单条目缺失: ${w}（${reason}）→ 修复: 若有意移除，改白名单+declare；否则找回`); }
  }
  return ok;
});

// W2 tombstone bidirectional integrity (depth<=2 .md files)
check("W2", "墓碑双向完整性", (d) => {
  const mdFiles = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "archive-2026-09") walk(f, depth + 1); }
      else if (/\.md$/.test(e.name)) mdFiles.push(f);
    }
  };
  walk(path.join(repo, ".wao/runs"), 0);
  const isTombstone = (f) => { try { return fs.readFileSync(f, "utf8").slice(0, 300).includes("[墓碑]"); } catch { return false; } };
  const archivedFiles = mdFiles.filter((f) => /ARCHIVED-\d{8}/.test(path.basename(f)));
  let ok = true;
  for (const f of mdFiles.filter(isTombstone)) {
    const text = fs.readFileSync(f, "utf8");
    const refs = [...text.matchAll(/([\w.\-]+ARCHIVED-\d{8}(?:\.md)?)/g)].map((m) => m[1]);
    if (refs.length === 0) { ok = false; d.push(`墓碑无指向: ${path.relative(repo, f)} → 修复: 补指向归档件，或撤墓碑标记`); continue; }
    for (const r of refs) {
      if (!exists(path.join(path.dirname(f), r))) { ok = false; d.push(`墓碑指针断裂: ${path.relative(repo, f)} → ${r} 不存在`); }
    }
  }
  for (const a of archivedFiles) {
    const dirFiles = fs.readdirSync(path.dirname(a));
    const hasTomb = mdFiles.some((f) => path.dirname(f) === path.dirname(a) && isTombstone(f) &&
      fs.readFileSync(f, "utf8").includes(path.basename(a)));
    if (!hasTomb) { ok = false; d.push(`归档件无墓碑指回: ${path.relative(repo, a)} → 修复: 在原路径留墓碑，或确认其为无主归档后 declare 豁免`); }
  }
  return ok;
});

// W3 continuation entry
check("W3", "续接入口唯一性（.strategy/AGENTS.md）", (d) => {
  const entry = path.join(repo, ".strategy/AGENTS.md");
  if (!exists(entry)) { d.push("入口文件不存在（可能从未初始化或被删）→ 修复: 新工作流开新入口；无工作流时无需入口"); return true; }
  const text = fs.readFileSync(entry, "utf8");
  if (text.includes("已关闭")) {
    d.push("入口处于关闭态（0 活页）✓");
    return true;
  }
  const m = text.match(/\.wao\/runs\/([\w.\-]+\.md)/);
  if (!m) { d.push("入口未关闭也未指向 .wao/runs 下活页 → 修复: 明确关闭或补指向"); return false; }
  const target = path.join(repo, ".wao/runs", m[1]);
  if (!exists(target)) { d.push(`入口指向的活页不存在: ${m[1]} → 修复: 恢复活页或关闭入口`); return false; }
  if (fs.readFileSync(target, "utf8").slice(0, 300).includes("[墓碑]")) { d.push("入口指向了墓碑 → 修复: 换指向或关闭入口"); return false; }
  d.push(`入口指向活页: ${m[1]}（1 活页）✓`);
  return true;
});

// W4 branch ratchet
check("W4", `wao/run_* 分支棘轮帽 ${BRANCH_CAP}`, (d) => {
  const count = sh('git branch --list "wao/run_*"').split("\n").filter((s) => s.trim()).length;
  d.push(`当前 ${count} / 帽 ${BRANCH_CAP}`);
  if (count > BRANCH_CAP) {
    d.push(`修复: 交付收尾清理（ADR 0035 S5 closeout 前可手工：已决+非脏+活文档零引用→remove+删分支）；确需扩容: 改 scripts/hygiene.mjs BRANCH_CAP + declare`);
    return false;
  }
  return true;
});

// W5 registry drift
check("W5", "worktree 注册漂移", (d) => {
  const raw = sh("git worktree list --porcelain");
  const paths = [...raw.matchAll(/^worktree (.+)$/gm)].map((m) => m[1]);
  let ok = true;
  for (const p of paths) {
    const np = norm(p);
    if (!exists(p)) { ok = false; d.push(`注册指向消失路径: ${p} → 修复: git worktree prune 或恢复目录`); continue; }
    const mainRoot = norm(repo);
    if (np === mainRoot || np.startsWith(mainRoot + "/")) continue;
    const known = [...EXTERNAL_ROOTS].some(([root]) => np.startsWith(root));
    if (!known) { ok = false; d.push(`注册落在未登记根: ${p} → 修复: 确认归属后加 EXTERNAL_ROOTS（带理由+declare），或清理该注册`); }
  }
  return ok;
});

// report
let fail = 0;
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} [${r.id}] ${r.name}`);
  for (const det of r.details) console.log(`    ${det}`);
  if (!r.ok) fail++;
}
console.log(fail === 0 ? "hygiene: PASS (5/5)" : `hygiene: FAIL (${fail} red) — 每条红线上方有修复路径`);
process.exit(fail === 0 ? 0 : 1);
