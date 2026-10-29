// ADR 0035 S2: class-A hygiene guards in the canonical suite.
// Fixture unit tests for the classifiers + real-state assertions for this repo.
// Class-A facts (branch refs, worktree registry) live in the common git dir, so
// these checks observe identical state from the main repo and any worktree —
// unlike class-B filesystem state which stays in `npm run hygiene` (docs/milestone-discipline.md §7).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  BRANCH_CAP, REGISTRY_EXTERNAL_ROOTS, ROOT_WHITELIST,
  classifyRegistryEntries, classifyBranchCount,
  listWorktreePaths, countRunBranches, normPath,
  primaryWorktreePath,
} from "../../scripts/hygiene.mjs";

const repo = primaryWorktreePath(path.resolve(import.meta.dirname, "..", ".."));
const thisTreeRoot = path.resolve(import.meta.dirname, "..", "..");
const never = () => false;
const always = () => true;

test("classifyRegistryEntries: main-repo and allowed external roots are ok", () => {
  const main = normPath(repo);
  const external = [...REGISTRY_EXTERNAL_ROOTS.keys()][0];
  const rows = classifyRegistryEntries(
    [repo, main + "/.wao-worktrees/run_x", external + "/some/run_y"],
    { repo, existsFn: always },
  );
  assert.deepEqual(rows.map((r) => r.status), ["ok-main", "ok-main", "ok-external"]);
});

test("classifyRegistryEntries: missing path and unknown root are red", () => {
  const rows = classifyRegistryEntries(
    ["D:/gone/checkout", "Z:/mystery/root/run_z"],
    { repo, existsFn: (p) => !p.startsWith("D:/gone") },
  );
  assert.equal(rows[0].status, "missing");
  assert.equal(rows[1].status, "unknown-root");
});

test("classifyRegistryEntries: case and separator insensitive against roots", () => {
  const [row] = classifyRegistryEntries(
    ["D:\\Projects\\.codex-worktrees\\wao\\m12-8f-final"],
    { repo, existsFn: always },
  );
  assert.equal(row.status, "ok-external");
});

test("classifyBranchCount: ratchet boundary", () => {
  assert.equal(classifyBranchCount(BRANCH_CAP).ok, true);
  assert.equal(classifyBranchCount(BRANCH_CAP + 1).ok, false);
  assert.equal(classifyBranchCount(0).ok, true);
});

test("BRANCH_CAP and external roots carry ADR 0035 values", () => {
  // 2026-10-02 175→185（历史：M13-r1 交付分支顶帽 176）；2026-10-11
  // 0062 批 185→60（存量清理 190→33 后下调，回收机制实地验证期
  // 保留棘轮报警灵敏度——只降方向，0042 允许，opus 审核意见；记录=注释+本钉+0062）。
  assert.equal(BRANCH_CAP, 60);
  // 决定 0042（Owner 2026-10-02）：帽只降不升——SSOT 已迁 src/dispatchResourceAdvisory.js
  //（本文件经 hygiene re-export 消费，值不变）；上调须 Owner 明示并同步 dispatchResourceAdvisory.test.js 的只降钉。
  assert.ok(BRANCH_CAP <= 185, "BRANCH_CAP 只降不升（决定 0042）");
  for (const [root, reason] of REGISTRY_EXTERNAL_ROOTS) {
    assert.match(root, /^[a-z]:\//, "roots are stored normalized");
    assert.ok(reason.length > 5, "every allowlist entry carries a reason");
  }
});

test("real state: registry drift is green and branch count under cap", () => {
  const drift = classifyRegistryEntries(listWorktreePaths(repo), { repo });
  const bad = drift.filter((d) => d.status === "missing" || d.status === "unknown-root");
  assert.deepEqual(bad, [], `unexpected drift (fix or extend allowlist with reason + declare): ${JSON.stringify(bad, null, 2)}`);
  const bc = classifyBranchCount(countRunBranches(repo));
  assert.equal(bc.ok, true, `branch ratchet exceeded: ${bc.count} > ${bc.cap} — close out decided deliveries or raise cap via declare`);
});

// W1（ADR 0035）：.wao/runs 根白名单 vs 写入侧交叉钉——控制面自己往根上写的目录
// 改名而白名单没跟（或反之）在这里红。只校验映射本身，不触主检出文件系统
//（checkRootWhitelist 是 class-B，归 npm run hygiene）。
test("W1: ROOT_WHITELIST covers WAO-written live state and drill scratch with reasons", async () => {
  const { serveMaintenanceDir } = await import("../../src/application/serveMaintenance.js");
  // serve 清扫台账/回收锁/lineage 锁的目录名必须逐字在白名单（写入侧 SSOT：serveMaintenanceDir）
  assert.equal(path.basename(serveMaintenanceDir("D:/proj")), "serve-maintenance");
  assert.ok(ROOT_WHITELIST.has("serve-maintenance"), "serveMaintenanceDir 写入的目录必须列在 W1 白名单");
  assert.ok(ROOT_WHITELIST.has("session-reuse-drill"), "TD-184 drill scratch 子目录必须列在 W1 白名单");
  for (const name of ["serve-maintenance", "session-reuse-drill"]) {
    assert.ok(ROOT_WHITELIST.get(name).length > 5, `白名单条目 ${name} 必须带理由`);
  }
  // drill 脚本顶层即执行（不可导入），用源文本钉 scratch 落点与白名单条目一致
  for (const rel of [["session-reuse-drill.mjs"], ["dsh-acp", "wao-reuse-drill.mjs"]]) {
    const drillSrc = readFileSync(path.join(thisTreeRoot, "scripts", "reliability", ...rel), "utf8");
    assert.match(drillSrc, /join\(ROOT, "\.wao", "runs", "session-reuse-drill"\)/,
      `${rel.join("/")} 的 scratchDir 必须收在白名单子目录 .wao/runs/session-reuse-drill 内`);
  }
});
