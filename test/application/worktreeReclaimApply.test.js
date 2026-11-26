// test/application/worktreeReclaimApply.test.js
//
// `wao worktree reclaim --apply` 执行面测试：计划绑定拒绝（仓库身份/保全目
// 录/bundle 失败）、批准后变化的逐项跳过（指纹四件套各一）、执行保全与删除
// 语义（bundle 覆盖恢复、ref CAS、摘树失败不删分支、记录落盘）。全部用真
// git 临时仓 + 临时 run 目录，从不触碰真实仓库。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
import { planWorktreeReclaim, applyWorktreeReclaim, isAbnormalBackupSegment } from "../../src/application/worktreeReclaim.js";
import { lineageMemberFiles } from "../../src/application/lineageClose.js";
import { worktreeCommand } from "../../src/commands/worktree.js";

import {
  git, makeRepo, mkdtemp, makeWorktree, makeLinkedWorktree, makeRunTreeIn, commitIn, seedTranscript,
  cleanRunEvents, decidedRunEvents, memberRunEvents, cleanupDir, fixedNow, OLD_TS,
  lineageRootRunEvents, lineageChildRunEvents, verifiedDeliveryRef,
} from "../_worktreeReclaimHarness.mjs";

const bases = [];
after(async () => {
  for (const b of bases) await cleanupDir(b);
});

async function scenario(prefix = "wao-reclaim-apply-") {
  const base = await mkdtemp(prefix);
  bases.push(base);
  const { repo, mainCommit } = await makeRepo(prefix);
  const runDir = join(base, "runs");
  mkdirSync(runDir, { recursive: true });
  return {
    base, repo, mainCommit, runDir,
    wt(runId) { return makeWorktree(repo, runId); },
    seed(runId, events, where) { return seedTranscript(runDir, runId, events, where); },
    accepted(runId, wt, extraEvents = []) {
      return this.seed(runId, [
        ...decidedRunEvents({ repo, wt, branch: `wao/${runId}`, baseCommit: mainCommit, decision: "accepted" }),
        ...extraEvents,
      ]);
    },
    async planAndApply({ mutate, ...applyOpts } = {}) {
      const outPath = join(this.base, "plan.json");
      const { planSha256 } = await planWorktreeReclaim({ repoCwd: this.repo, runDir: this.runDir, outPath, now: fixedNow });
      if (mutate) await mutate();
      const result = await applyWorktreeReclaim({ planPath: outPath, expectSha256: planSha256, runDir: this.runDir, now: fixedNow, ...applyOpts });
      return { result, planSha256, outPath };
    },
  };
}

function outcomeOf(result, action, runId) {
  return result.results.find((r) => r.action === action && r.runId === runId);
}

test("绑定：仓库身份不符 → 整体拒绝，零删除", async () => {
  const s = await scenario();
  const wt = s.wt("run_ident");
  s.accepted("run_ident", wt);
  const outPath = join(s.base, "plan.json");
  const { planSha256 } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath, now: fixedNow });
  // 篡改仓库身份并按新字节重算 sha（sha 门通过、身份门必须单独拦下）。
  const plan = JSON.parse(readFileSync(outPath, "utf8"));
  plan.repo.gitCommonDir = plan.repo.gitCommonDir.replace(/\\.git$/, "\\.git-tampered");
  const tampered = Buffer.from(JSON.stringify(plan, null, 2) + "\n", "utf8");
  writeFileSync(outPath, tampered);
  const tamperedSha = createHash("sha256").update(tampered).digest("hex");
  const result = await applyWorktreeReclaim({ planPath: outPath, expectSha256: tamperedSha, runDir: s.runDir });
  assert.equal(result.refused, "repo_identity_mismatch");
  assert.ok(existsSync(wt));
  assert.ok(git(["branch", "--list", "wao/run_ident"], s.repo).length > 0);
});

test("绑定：保全目录落在删除目标内 → 整体拒绝，零删除", async () => {
  const s = await scenario();
  const wt = s.wt("run_pv");
  // runDir 放进待删树内：保全目录（runDir 同级 runs-archive/…）随之落进目标。
  const innerRunDir = join(wt, "runs");
  mkdirSync(innerRunDir, { recursive: true });
  seedTranscript(innerRunDir, "run_pv", [
    ...decidedRunEvents({ repo: s.repo, wt, branch: "wao/run_pv", baseCommit: s.mainCommit, decision: "accepted" }),
  ]);
  const outPath = join(s.base, "plan.json");
  const { planSha256 } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: innerRunDir, outPath, now: fixedNow });
  const result = await applyWorktreeReclaim({ planPath: outPath, expectSha256: planSha256, runDir: innerRunDir });
  assert.equal(result.refused, "preserve_dir_inside_target");
  assert.ok(existsSync(wt), "拒绝后树不动");
});

test("执行：bundle 创建失败（runs-archive 是文件）→ 零删除", async () => {
  const s = await scenario();
  const wt = s.wt("run_bf");
  s.accepted("run_bf", wt);
  // 计划生成后再把 runs-archive 占成文件：计划面读归档根须是干净形态（读不
  // 出会让计划整体毒化），apply 侧保全目录建不起来才触发 bundle 拒绝。
  const { result } = await s.planAndApply({
    mutate: async () => { writeFileSync(join(s.base, "runs-archive"), "not a directory\n", "utf8"); },
  });
  assert.equal(result.refused, "bundle_create_failed");
  assert.ok(existsSync(wt), "bundle 失败后树不动");
  assert.ok(git(["branch", "--list", "wao/run_bf"], s.repo).length > 0, "bundle 失败后分支不动");
});

test("执行：两条待删分支互相覆盖同一提交 → 都进 bundle，独立空仓可恢复全部被删分支", async () => {
  const s = await scenario();
  const wtA = s.wt("run_ca");
  const shared = commitIn(wtA, "shared.txt", "same commit on both refs\n");
  git(["branch", "wao/run_cb", shared], s.repo);
  s.accepted("run_ca", wtA);
  s.seed("run_cb", decidedRunEvents({
    repo: s.repo, wt: null, branch: "wao/run_cb", baseCommit: s.mainCommit, decision: "rejected",
  }));
  const { result } = await s.planAndApply();
  assert.ok(!result.refused, `不应拒绝：${result.refused}`);
  assert.equal(outcomeOf(result, "delete_branch", "run_ca").outcome, "deleted");
  assert.equal(outcomeOf(result, "delete_branch", "run_cb").outcome, "deleted");
  assert.equal(git(["branch", "--list", "wao/*"], s.repo), "", "两条分支都应删除");
  // 恢复：在独立空仓里从 bundle fetch 回**全部**被删分支，核对每条 tip 与历史。
  const freshRepo = join(s.base, "restore-repo");
  mkdirSync(freshRepo, { recursive: true });
  git(["init", "-b", "main"], freshRepo);
  git(["config", "user.email", "t@t"], freshRepo);
  git(["config", "user.name", "t"], freshRepo);
  const planItems = JSON.parse(readFileSync(join(s.base, "plan.json"), "utf8")).items;
  const deletedBranches = planItems.filter((i) => i.action === "delete_branch");
  assert.ok(deletedBranches.length >= 2, "前置：至少两条被删分支");
  for (const item of deletedBranches) {
    git(["fetch", result.bundlePath, `refs/heads/${item.branch}:refs/heads/${item.branch}`], freshRepo);
    assert.equal(
      git(["rev-parse", `refs/heads/${item.branch}`], freshRepo),
      item.branchTip,
      `${item.branch} 应能从 bundle 恢复到计划 tip`,
    );
  }
  assert.equal(git(["log", "-1", "--format=%s", "refs/heads/wao/run_ca"], freshRepo), "add shared.txt", "历史完整可读");
  // 记录：bundle sha256 与文件吻合。
  assert.equal(readFileSync(join(result.preserveDir, "bundle-sha256.txt"), "utf8").trim(), result.bundleSha256);
});

test("执行：预检之后、CAS 删除之前 ref 被推进 → update-ref -d 拒删", async () => {
  const s = await scenario();
  const wt = s.wt("run_cas");
  const shared = commitIn(wt, "cas.txt", "x\n");
  git(["branch", "wao/run_cas2", shared], s.repo);
  s.seed("run_cas2", decidedRunEvents({
    repo: s.repo, wt: null, branch: "wao/run_cas2", baseCommit: s.mainCommit, decision: "rejected",
  }));
  s.accepted("run_cas", wt);
  const outPath = join(s.base, "plan.json");
  const { planSha256 } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath, now: fixedNow });
  // 钩子在分支预检（ref 快照、bundle）之后、update-ref -d 之前推进 ref——证明
  // 比较后删除这道门本身起作用，不是预检拦下的。
  let advanced = false;
  const result = await applyWorktreeReclaim({
    planPath: outPath, expectSha256: planSha256, runDir: s.runDir, now: fixedNow,
    beforeBranchDelete: async (item) => {
      if (item.branch !== "wao/run_cas2" || advanced) return;
      advanced = true;
      git(["update-ref", "refs/heads/wao/run_cas2", s.mainCommit], s.repo); // 推进到别的提交
    },
  });
  assert.ok(advanced, "钩子应在预检之后、CAS 之前被调到");
  assert.equal(outcomeOf(result, "delete_branch", "run_cas2").outcome, "skipped");
  assert.equal(outcomeOf(result, "delete_branch", "run_cas2").reason, "ref_moved");
  assert.ok(git(["branch", "--list", "wao/run_cas2"], s.repo).includes("run_cas2"), "被推进的分支必须保留");
  // 同一把门对未变的 ref 照常放行。
  assert.equal(outcomeOf(result, "delete_branch", "run_cas").outcome, "deleted");
});

test("执行：摘树失败（注入缝）→ 对应分支不删", async () => {
  const s = await scenario();
  const wt = s.wt("run_lk");
  s.accepted("run_lk", wt);
  // removeTreeExec 缝：git remove 失败、目录仍在——确定性注入，代替独占文件锁
  //（旧写法靠"PowerShell 在 1.5 秒内拿到独占锁"，机器负载高时会偶发失败）。
  const { result } = await s.planAndApply({
    removeTreeExec: async () => { throw new Error("injected worktree remove failure"); },
  });
  assert.ok(!result.refused, `不应拒绝：${result.refused}`);
  assert.equal(outcomeOf(result, "remove_tree", "run_lk").outcome, "failed_still_present");
  assert.equal(outcomeOf(result, "delete_branch", "run_lk").outcome, "skipped");
  assert.equal(outcomeOf(result, "delete_branch", "run_lk").reason, "tree_not_removed");
  assert.ok(existsSync(wt), "目录仍在");
  assert.ok(git(["branch", "--list", "wao/run_lk"], s.repo).length > 0, "摘树失败的分支必须保留");
});

test("批准后变化：已脏树的内容再变 → 跳过（content_changed）", async () => {
  const s = await scenario();
  const wt = s.wt("run_d1c");
  writeFileSync(join(wt, "dirty.txt"), "v1\n", "utf8");
  s.accepted("run_d1c", wt);
  const { result } = await s.planAndApply({
    mutate: async () => { writeFileSync(join(wt, "dirty.txt"), "v2-longer-content\n", "utf8"); },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_d1c").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_d1c").reason, "content_changed");
  assert.ok(existsSync(wt));
});

test("批准后变化：只改暂存区（暂存 v2、工作区还原 HEAD）→ 跳过", async () => {
  const s = await scenario();
  const wt = s.wt("run_st");
  s.accepted("run_st", wt);
  const { result } = await s.planAndApply({
    mutate: async () => {
      writeFileSync(join(wt, "a.txt"), "staged v2\n", "utf8");
      git(["add", "a.txt"], wt);
      git(["restore", "--source=HEAD", "--worktree", "a.txt"], wt);
      // 工作区 == HEAD，暂存区 == v2：工作区 diff 为空，只有暂存件套变化。
    },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_st").reason, "content_changed");
  assert.ok(existsSync(wt));
});

test("批准后变化：被忽略目录深处文件变了 → 跳过（清单指纹）", async () => {
  const s = await scenario();
  const wt = s.wt("run_ig");
  mkdirSync(join(wt, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(wt, "node_modules", "pkg", "data.bin"), "v1\n", "utf8");
  s.accepted("run_ig", wt);
  const { result } = await s.planAndApply({
    mutate: async () => {
      writeFileSync(join(wt, "node_modules", "pkg", "deep"), "new nested file\n", "utf8");
    },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_ig").reason, "content_changed");
  assert.ok(existsSync(wt));
});

test("批准后变化：树变脏（新增未跟踪文件）→ 跳过", async () => {
  const s = await scenario();
  const wt = s.wt("run_dt");
  s.accepted("run_dt", wt);
  const { result } = await s.planAndApply({
    mutate: async () => { writeFileSync(join(wt, "untracked-new.txt"), "x\n", "utf8"); },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_dt").reason, "content_changed");
  assert.ok(existsSync(wt));
});

test("批准后变化：tip 变化（树上推进提交）→ 跳过（head_changed）", async () => {
  const s = await scenario();
  const wt = s.wt("run_tip");
  s.accepted("run_tip", wt);
  const { result } = await s.planAndApply({
    mutate: async () => { commitIn(wt, "moved-on.txt", "x\n"); },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_tip").reason, "head_changed");
  assert.equal(outcomeOf(result, "delete_branch", "run_tip").reason, "ref_moved");
  assert.ok(existsSync(wt));
});

test("批准后变化：树换成 junction → 跳过（symlink_now）", async () => {
  const s = await scenario();
  const wt = s.wt("run_jn");
  s.accepted("run_jn", wt);
  const elsewhere = join(s.base, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  const { result } = await s.planAndApply({
    mutate: async () => {
      rmSync(wt, { recursive: true, force: true });
      symlinkSync(elsewhere, wt, "junction");
    },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_jn").reason, "symlink_now");
  assert.ok(existsSync(wt), "junction 本身不动（不跟随、不删除链接）");
});

test("批准后变化：计划后切 detached + 新提交 → 删前复核跳过（head_changed）", async () => {
  const s = await scenario();
  const wt = s.wt("run_dh");
  s.accepted("run_dh", wt);
  const { result } = await s.planAndApply({
    mutate: async () => {
      git(["checkout", "--detach", "HEAD"], wt);
      commitIn(wt, "detached.txt", "x\n");
    },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_dh").reason, "head_changed");
  assert.ok(existsSync(wt));
});

test("执行：脏树删除前落快照；记录目录含计划副本与逐项结果", async () => {
  const s = await scenario();
  const wt = s.wt("run_snap");
  writeFileSync(join(wt, "dirty.txt"), "about to be dropped\n", "utf8");
  s.accepted("run_snap", wt);
  const { result } = await s.planAndApply();
  assert.ok(!result.refused, `不应拒绝：${result.refused}`);
  assert.equal(outcomeOf(result, "remove_tree", "run_snap").outcome, "removed");
  assert.ok(!existsSync(wt), "脏树（已裁决）按放弃处理删除");
  assert.ok(existsSync(join(result.preserveDir, "plan.json")), "计划副本");
  assert.ok(existsSync(join(result.preserveDir, "plan-sha256.txt")), "计划 sha256");
  assert.ok(existsSync(join(result.preserveDir, "results.json")), "逐项结果");
  const dirtyDir = join(result.preserveDir, "dirty");
  assert.ok(existsSync(dirtyDir) && readFileSync(join(dirtyDir, "run_snap.status.txt")).includes("dirty.txt"),
    "脏树快照应记下被丢弃的路径");
});

test("执行：干净闭环——树删、分支删、计数对账", async () => {
  const s = await scenario();
  const wt = s.wt("run_ok");
  s.accepted("run_ok", wt);
  const { result } = await s.planAndApply();
  assert.ok(!result.refused);
  assert.equal(outcomeOf(result, "remove_tree", "run_ok").outcome, "removed");
  assert.equal(outcomeOf(result, "delete_branch", "run_ok").outcome, "deleted");
  assert.ok(!existsSync(wt));
  assert.equal(git(["branch", "--list", "wao/run_ok"], s.repo), "");
  assert.equal(result.countsBefore.worktrees - result.countsAfter.worktrees, 1);
  assert.equal(result.countsBefore.waoBranches - result.countsAfter.waoBranches, 1);
});

test("apply：树目录批准后被外部删除（登记残留）→ 树跳过、分支 registration_stale 保守跳过；登记清掉后下一轮可删", async () => {
  const s = await scenario();
  const wt = s.wt("run_co");
  s.seed("run_co", cleanRunEvents({ repo: s.repo, wt, branch: "wao/run_co" }));
  // 计划后手工 rmSync 树（登记残留——目录缺失的在册登记）。
  const { result } = await s.planAndApply({
    mutate: async () => { rmSync(wt, { recursive: true, force: true }); },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_co").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_co").reason, "tree_missing");
  // apply 不做仓库级 prune（与并发 worktree add 的竞争关不掉）：stale 登记不
  // 清、无法证明没有活检出在用它 → 分支保守跳过并上报。
  assert.equal(outcomeOf(result, "delete_branch", "run_co").outcome, "skipped");
  assert.equal(outcomeOf(result, "delete_branch", "run_co").reason, "registration_stale");
  assert.ok(result.staleRegistrations?.some((p) => p.toLowerCase().includes("run_co")), "stale 登记应上报");
  assert.ok(git(["branch", "--list", "wao/run_co"], s.repo).includes("run_co"));
  // 模拟通用清扫（serve 维护 / runs verify-commit 的 prune --expire）清掉登记
  // 后重跑同一计划：分支不再被登记挡住，可删——闭环收口。
  rmSync(join(s.repo, ".git", "worktrees", "run_co"), { recursive: true, force: true });
  const result2 = await applyWorktreeReclaim({
    planPath: join(s.base, "plan.json"), expectSha256: shaOfPlan(s), runDir: s.runDir, now: fixedNow,
  });
  assert.equal(outcomeOf(result2, "delete_branch", "run_co").outcome, "deleted");
  assert.equal(git(["branch", "--list", "wao/run_co"], s.repo), "");
});

function shaOfPlan(s) {
  return createHash("sha256").update(readFileSync(join(s.base, "plan.json"))).digest("hex");
}

test("apply：另传不同 runDir → 整体拒绝 run_dir_mismatch（apply 一律用计划里的库）", async () => {
  const s = await scenario();
  const wt = s.wt("run_rd");
  s.accepted("run_rd", wt);
  const outPath = join(s.base, "plan.json");
  const { planSha256 } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath, now: fixedNow });
  const other = join(s.base, "other-runs");
  mkdirSync(other, { recursive: true });
  const result = await applyWorktreeReclaim({ planPath: outPath, expectSha256: planSha256, runDir: other });
  assert.equal(result.refused, "run_dir_mismatch");
  assert.ok(existsSync(wt), "拒绝后树不动");
  assert.ok(git(["branch", "--list", "wao/run_rd"], s.repo).length > 0, "拒绝后分支不动");
});

test("apply（第 120 批）：删树路径——计划后后代转录被删，派生被取代不再成立 → 跳过并如实记原因", async () => {
  const s = await scenario();
  const wt = s.wt("run_sup_a");
  s.seed("run_sup_a", lineageRootRunEvents({
    runId: "run_sup_a", repo: s.repo, wt, branch: "wao/run_sup_a", baseCommit: s.mainCommit,
  }));
  // 子运行不声明这棵树（树的成员只有 run_sup_a）——删前复核必须靠"被取代"重证。
  s.seed("run_sup_b", lineageChildRunEvents({
    runId: "run_sup_b", parentRunId: "run_sup_a", rootRunId: "run_sup_a",
    repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
  }));
  const planPath = join(s.base, "plan.json");
  const { plan } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  assert.ok(plan.items.some((i) => i.action === "remove_tree" && i.runId === "run_sup_a"),
    "夹具前提：计划里 run_sup_a 可回收（被取代）");
  // 批准之后被采纳后代转录被删：执行时重新推导不出来 → 跳过。
  rmSync(join(s.runDir, "run_sup_b.jsonl"));
  const result = await applyWorktreeReclaim({ planPath, expectSha256: shaOfPlan(s), runDir: s.runDir, now: fixedNow });
  const tree = outcomeOf(result, "remove_tree", "run_sup_a");
  assert.equal(tree.outcome, "skipped");
  assert.equal(tree.reason, "supersession_unproven_now");
  assert.equal(tree.detail, "run_sup_a");
  assert.ok(existsSync(wt), "证不出被取代 → 树保留");
  assert.equal(outcomeOf(result, "delete_branch", "run_sup_a").reason, "tree_not_removed");
  assert.ok(git(["branch", "--list", "wao/run_sup_a"], s.repo).length > 0, "分支保留");
});

test("apply（第 120 批）：只删分支路径——同样重证被取代；证不出则跳过、分支保留", async () => {
  const s = await scenario();
  // 只有分支、没有树的目标。
  git(["branch", "wao/run_sup_c"], s.repo);
  s.seed("run_sup_c", lineageRootRunEvents({
    runId: "run_sup_c", repo: s.repo, baseCommit: s.mainCommit,
  }));
  s.seed("run_sup_d", lineageChildRunEvents({
    runId: "run_sup_d", parentRunId: "run_sup_c", rootRunId: "run_sup_c",
    repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
  }));
  const planPath = join(s.base, "plan.json");
  const { plan } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  assert.ok(plan.items.some((i) => i.action === "delete_branch" && i.runId === "run_sup_c"),
    "夹具前提：计划里 run_sup_c 的分支可删（被取代）");
  rmSync(join(s.runDir, "run_sup_d.jsonl"));
  const result = await applyWorktreeReclaim({ planPath, expectSha256: shaOfPlan(s), runDir: s.runDir, now: fixedNow });
  const branch = outcomeOf(result, "delete_branch", "run_sup_c");
  assert.equal(branch.outcome, "skipped");
  assert.equal(branch.reason, "supersession_unproven_now");
  assert.ok(git(["branch", "--list", "wao/run_sup_c"], s.repo).length > 0, "证不出 → 分支保留");
});

test("apply（第 120 批续修 C1）：无转录分支恢复 b120 之前逻辑——已并入 / --include 点名的照旧可删", async () => {
  const s = await scenario();
  // 转录库非空（普查到树目标时空库整体拒绝）。
  seedTranscript(s.runDir, "run_dummy_lib", [
    { type: "run.state_change", from: null, to: "completed", reason: "done" },
  ]);
  // run_mrg：只有分支、已并入 main、三处无转录。
  git(["branch", "wao/run_mrg"], s.repo);
  // run_nom：只有分支、未并入、三处无转录，靠 --include 点名放行。
  const tmpWt = s.wt("run_nom_work");
  const orphan = commitIn(tmpWt, "orphan.txt", "x\n");
  git(["worktree", "remove", "--force", tmpWt], s.repo);
  git(["branch", "-D", "wao/run_nom_work"], s.repo);
  git(["branch", "wao/run_nom", orphan], s.repo);
  const planPath = join(s.base, "plan.json");
  const { planSha256 } = await planWorktreeReclaim({
    repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow, includeRunIds: ["run_nom"],
  });
  const result = await applyWorktreeReclaim({ planPath, expectSha256: planSha256, runDir: s.runDir, now: fixedNow });
  assert.equal(outcomeOf(result, "delete_branch", "run_mrg")?.outcome, "deleted",
    "已并入 main 的无转录分支照旧可删（不再被 transcript_missing_now 挡住）");
  assert.equal(outcomeOf(result, "delete_branch", "run_nom")?.outcome, "deleted",
    "--include 点名的无转录分支照旧可删");
  assert.equal(git(["branch", "--list", "wao/run_mrg"], s.repo), "");
  assert.equal(git(["branch", "--list", "wao/run_nom"], s.repo), "");
});

test("apply（第 120 批续修 C2）：祖先转录被截空 → 执行时跳过（不把空转录当可读且无交付）", async () => {
  const s = await scenario();
  const wt = s.wt("run_sup_t");
  s.seed("run_sup_t", lineageRootRunEvents({
    runId: "run_sup_t", repo: s.repo, wt, branch: "wao/run_sup_t", baseCommit: s.mainCommit,
  }));
  s.seed("run_sup_u", lineageChildRunEvents({
    runId: "run_sup_u", parentRunId: "run_sup_t", rootRunId: "run_sup_t",
    repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
  }));
  const planPath = join(s.base, "plan.json");
  const { plan } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  assert.ok(plan.items.some((i) => i.action === "remove_tree" && i.runId === "run_sup_t"),
    "夹具前提：计划里 run_sup_t 可回收（被取代）");
  // 祖先转录被截空：既有"线系成员状态不可证"复核与新增的派生重证都必须拦下。
  // 第 120 批续修（G4）：空转录如实归 undeterminable_now（detail 写明为空），
  // 不再报成"观测到在跑"的 running_now。
  writeFileSync(join(s.runDir, "run_sup_t.jsonl"), "", "utf8");
  const result = await applyWorktreeReclaim({ planPath, expectSha256: shaOfPlan(s), runDir: s.runDir, now: fixedNow });
  const tree = outcomeOf(result, "remove_tree", "run_sup_t");
  assert.equal(tree.outcome, "skipped", `空转录必须跳过: ${JSON.stringify(tree)}`);
  assert.equal(tree.reason, "undeterminable_now", `空转录理由: ${JSON.stringify(tree)}`);
  assert.match(String(tree.detail), /transcript_empty_now/, "detail 写明转录为空");
  assert.ok(existsSync(wt), "祖先转录为空 → 树保留");
  assert.equal(outcomeOf(result, "delete_branch", "run_sup_t").reason, "tree_not_removed");
});

// ═══ 第 120 批续修第 2 轮（G2/G3）：执行门对所有成员成立 ═══

test("apply（G2）：计划后新出现的、已打包未裁决的共享成员 → 整树跳过并记原因", async () => {
  const s = await scenario();
  const wt = s.wt("run_gm_a");
  s.seed("run_gm_a", lineageRootRunEvents({
    runId: "run_gm_a", repo: s.repo, wt, branch: "wao/run_gm_a", baseCommit: s.mainCommit,
  }));
  s.seed("run_gm_b", lineageChildRunEvents({
    runId: "run_gm_b", parentRunId: "run_gm_a", rootRunId: "run_gm_a",
    repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
  }));
  const planPath = join(s.base, "plan.json");
  const { plan } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  assert.ok(plan.items.some((i) => i.action === "remove_tree" && i.runId === "run_gm_a"),
    "夹具前提：计划里 run_gm_a 可回收（被取代）");
  // 批准之后才出现的共享成员：只声明这棵树，有打包事实、未裁决。
  s.seed("run_gm_new", [
    {
      type: "run.started", backend: "test", cwd: s.repo, worktreePath: wt, worktreeBranch: null,
      delivery: { mode: "git_commit_v1", baseCommit: s.mainCommit },
    },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
    { type: "run.delivery_created", delivery: verifiedDeliveryRef("run_gm_new", { baseCommit: s.mainCommit }) },
    { type: "run.delivery_verification_passed", delivery: verifiedDeliveryRef("run_gm_new", { baseCommit: s.mainCommit }) },
  ]);
  const result = await applyWorktreeReclaim({ planPath, expectSha256: shaOfPlan(s), runDir: s.runDir, now: fixedNow });
  const tree = outcomeOf(result, "remove_tree", "run_gm_a");
  assert.equal(tree.outcome, "skipped", JSON.stringify(tree));
  assert.equal(tree.reason, "delivery_packaged_undecided_now");
  assert.equal(tree.detail, "run_gm_new");
  assert.ok(existsSync(wt), "新成员挡住整棵树");
  assert.equal(outcomeOf(result, "delete_branch", "run_gm_a").reason, "tree_not_removed");
});

test("apply（G2）：旧形状计划缺 supersededMembers → 成员仍按通用门重证（后代消失即跳过）", async () => {
  const s = await scenario();
  const wt = s.wt("run_go_a");
  // 属主已裁决（合法）；成员 M 是属主的续修子（与树共享 retained worktree），
  // 自己未裁决、只靠后代 D 的采纳放行 → 计划记 supersededMembers。
  s.seed("run_go_a", lineageRootRunEvents({
    runId: "run_go_a", repo: s.repo, wt, branch: "wao/run_go_a", baseCommit: s.mainCommit, decision: "accepted",
  }));
  s.seed("run_go_m", lineageChildRunEvents({
    runId: "run_go_m", parentRunId: "run_go_a", rootRunId: "run_go_a",
    repo: s.repo, wt, branch: null, baseCommit: s.mainCommit,
  }));
  s.seed("run_go_d", lineageChildRunEvents({
    runId: "run_go_d", parentRunId: "run_go_m", rootRunId: "run_go_a",
    repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
  }));
  const planPath = join(s.base, "plan.json");
  const { plan } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  const treeItem = plan.items.find((i) => i.action === "remove_tree" && i.runId === "run_go_a");
  assert.ok(treeItem, "夹具前提：树可回收");
  assert.deepEqual(treeItem.supersededMembers, ["run_go_m"], "成员靠派生放行");
  // 旧形状：只去掉 supersededMembers（保留 treeMembers），按新字节重算 sha。
  const oldPlan = JSON.parse(readFileSync(planPath, "utf8"));
  for (const item of oldPlan.items) delete item.supersededMembers;
  const bytes = Buffer.from(JSON.stringify(oldPlan, null, 2) + "\n", "utf8");
  writeFileSync(planPath, bytes);
  const oldSha = createHash("sha256").update(bytes).digest("hex");
  rmSync(join(s.runDir, "run_go_d.jsonl"));
  const result = await applyWorktreeReclaim({ planPath, expectSha256: oldSha, runDir: s.runDir, now: fixedNow });
  const tree = outcomeOf(result, "remove_tree", "run_go_a");
  assert.equal(tree.outcome, "skipped", JSON.stringify(tree));
  assert.equal(tree.reason, "delivery_packaged_undecided_now", "旧计划也按通用门重证");
  assert.equal(tree.detail, "run_go_m");
  assert.ok(existsSync(wt));
});

test("apply（G3）：缺交付载荷的采纳事件不算合法裁决 → 跳过", async () => {
  const s = await scenario();
  const wt = s.wt("run_gl_a");
  s.seed("run_gl_a", lineageRootRunEvents({
    runId: "run_gl_a", repo: s.repo, wt, branch: "wao/run_gl_a", baseCommit: s.mainCommit,
  }));
  s.seed("run_gl_b", lineageChildRunEvents({
    runId: "run_gl_b", parentRunId: "run_gl_a", rootRunId: "run_gl_a",
    repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
  }));
  const planPath = join(s.base, "plan.json");
  const { plan } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  assert.ok(plan.items.some((i) => i.action === "remove_tree" && i.runId === "run_gl_a"),
    "夹具前提：计划里 run_gl_a 可回收（被取代）");
  // 移除已采纳后代；祖先只留一个缺交付载荷的采纳事件（validateDeliveryFacts 不合法）。
  rmSync(join(s.runDir, "run_gl_b.jsonl"));
  s.seed("run_gl_a", [
    ...lineageRootRunEvents({ runId: "run_gl_a", repo: s.repo, wt, branch: "wao/run_gl_a", baseCommit: s.mainCommit }),
    { type: "run.delivery_accepted" },
  ]);
  const result = await applyWorktreeReclaim({ planPath, expectSha256: shaOfPlan(s), runDir: s.runDir, now: fixedNow });
  const tree = outcomeOf(result, "remove_tree", "run_gl_a");
  assert.equal(tree.outcome, "skipped", JSON.stringify(tree));
  // sol 复核 2：缺载荷的采纳让交付事实 malformed（收口 undeterminable）→ 活动
  // 门按保守先拦（running_now:delivery_unsettled:delivery_facts_malformed）；
  // 派生重证的 supersession_unproven_now 路径由下方 C1 用例（run_sup_c）钉。
  assert.equal(tree.reason, "running_now");
  assert.match(String(tree.detail ?? ""), /delivery_unsettled:delivery_facts_malformed/);
  assert.ok(existsSync(wt), "非法采纳不算裁决 → 树保留");
});

test("apply（G2/F2）：执行过程中（beforeBranchDelete）新出现的冲突副本 → 后续条目跳过", async () => {
  const s = await scenario();
  // 两条"只删分支"的目标，各自靠一个已采纳后代放行。
  for (const [id, child] of [["run_gc1", "run_gc1_c"], ["run_gc2", "run_gc2_c"]]) {
    git(["branch", `wao/${id}`], s.repo);
    s.seed(id, lineageRootRunEvents({ runId: id, repo: s.repo, baseCommit: s.mainCommit }));
    s.seed(child, lineageChildRunEvents({
      runId: child, parentRunId: id, rootRunId: id, repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
    }));
  }
  const planPath = join(s.base, "plan.json");
  const { plan } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  assert.ok(plan.items.filter((i) => i.action === "delete_branch").length >= 2, "夹具前提：两条分支可删");
  let injected = false;
  const result = await applyWorktreeReclaim({
    planPath,
    expectSha256: shaOfPlan(s),
    runDir: s.runDir,
    now: fixedNow,
    beforeBranchDelete: async (item) => {
      if (injected) return;
      injected = true;
      // 在第一个分支删除前，给第二个目标的已采纳后代放进一份内容不同的副本。
      seedTranscript(s.runDir, "run_gc2_c", [
        { type: "run.delivery_created", delivery: verifiedDeliveryRef("run_gc2_c", { baseCommit: s.mainCommit }) },
      ], { bucket: "conflict" });
    },
  });
  // 先删的那条照常成功；注入之后的那条必须跳过（refresh 看到新文件）。
  const deleted = ["run_gc1", "run_gc2"].filter((id) => outcomeOf(result, "delete_branch", id)?.outcome === "deleted");
  const skipped = ["run_gc1", "run_gc2"].filter((id) => outcomeOf(result, "delete_branch", id)?.outcome === "skipped");
  assert.equal(deleted.length, 1, `先删一条: ${JSON.stringify(result.results)}`);
  assert.equal(skipped.length, 1, "注入后的一条跳过");
  assert.equal(outcomeOf(result, "delete_branch", skipped[0]).reason, "supersession_unproven_now");
});

test("apply（第 120 批续修 C2）：祖先转录还在但交付事实没了 → supersession_unproven_now，树保留", async () => {
  const s = await scenario();
  const wt = s.wt("run_sup_v");
  s.seed("run_sup_v", lineageRootRunEvents({
    runId: "run_sup_v", repo: s.repo, wt, branch: "wao/run_sup_v", baseCommit: s.mainCommit,
  }));
  s.seed("run_sup_w", lineageChildRunEvents({
    runId: "run_sup_w", parentRunId: "run_sup_v", rootRunId: "run_sup_v",
    repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
  }));
  const planPath = join(s.base, "plan.json");
  const { plan } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  assert.ok(plan.items.some((i) => i.action === "remove_tree" && i.runId === "run_sup_v"),
    "夹具前提：计划里 run_sup_v 可回收（被取代）");
  // 截成"只有终态、没有交付事实"的转录：可读、可判终态，但打包事实没了。
  s.seed("run_sup_v", cleanRunEvents({ repo: s.repo, wt, branch: "wao/run_sup_v" }));
  const result = await applyWorktreeReclaim({ planPath, expectSha256: shaOfPlan(s), runDir: s.runDir, now: fixedNow });
  const tree = outcomeOf(result, "remove_tree", "run_sup_v");
  assert.equal(tree.outcome, "skipped");
  assert.equal(tree.reason, "supersession_unproven_now", JSON.stringify(tree));
  assert.ok(existsSync(wt), "交付事实没了 → 树保留");
});

test("apply（第 120 批续修 C2）：删空壳路径也重证——计划后后代消失 → 跳过、空壳保留", async () => {
  const s = await scenario();
  const husk = join(s.repo, ".wao-worktrees", "run_sup_husk");
  mkdirSync(husk, { recursive: true });
  s.seed("run_sup_husk", lineageRootRunEvents({
    runId: "run_sup_husk", repo: s.repo, baseCommit: s.mainCommit,
  }));
  s.seed("run_sup_husk_c", lineageChildRunEvents({
    runId: "run_sup_husk_c", parentRunId: "run_sup_husk", rootRunId: "run_sup_husk",
    repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
  }));
  const planPath = join(s.base, "plan.json");
  const { plan } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  const huskItem = plan.items.find((i) => i.action === "rmdir_husk" && i.runId === "run_sup_husk");
  assert.ok(huskItem, "夹具前提：计划里空壳可删（被取代）");
  assert.equal(huskItem.supersededByRunId, "run_sup_husk_c");
  rmSync(join(s.runDir, "run_sup_husk_c.jsonl"));
  const result = await applyWorktreeReclaim({ planPath, expectSha256: shaOfPlan(s), runDir: s.runDir, now: fixedNow });
  const huskOutcome = outcomeOf(result, "rmdir_husk", "run_sup_husk");
  assert.equal(huskOutcome.outcome, "skipped");
  assert.equal(huskOutcome.reason, "supersession_unproven_now");
  assert.ok(existsSync(husk), "证不出被取代 → 空壳保留");
});

// ═══ 第 120 批续修第 3 轮（J1/J2/J3/K1）：刷新内容变化、刷新失败、空谱系根、孪生副本 ═══

test("apply（J1）：两次删分支之间已有文件长出根引用并成环 → 后一条跳过", async () => {
  const s = await scenario();
  for (const [id, child] of [["run_j1a", "run_j1a_c"], ["run_j1b", "run_j1b_c"]]) {
    git(["branch", `wao/${id}`], s.repo);
    s.seed(id, lineageRootRunEvents({ runId: id, repo: s.repo, baseCommit: s.mainCommit }));
    s.seed(child, lineageChildRunEvents({
      runId: child, parentRunId: id, rootRunId: id, repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
    }));
  }
  // X、Y 先在清单里、还不含任何根引用（预筛不会把它们当候选）。
  s.seed("run_j1x", cleanRunEvents({ repo: s.repo }));
  s.seed("run_j1y", cleanRunEvents({ repo: s.repo }));
  const planPath = join(s.base, "plan.json");
  const { plan } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  assert.ok(plan.items.filter((i) => i.action === "delete_branch").length >= 2, "夹具前提：两条分支可删");
  let injected = false;
  const result = await applyWorktreeReclaim({
    planPath,
    expectSha256: shaOfPlan(s),
    runDir: s.runDir,
    now: fixedNow,
    beforeBranchDelete: async (item) => {
      if (injected) return;
      injected = true;
      // 已有文件此刻才长出同根声明并互相成环（X↔Y，根都记第二条目标）。
      const loop = (runId, parentRunId) => [
        {
          type: "run.background_submitted", runId, continuation: true,
          parentRunId, rootRunId: "run_j1b",
        },
        { type: "run.session_reuse", runId, mode: "run_lineage", turn: "resume", rootRunId: "run_j1b" },
        { type: "run.delivery_created", delivery: verifiedDeliveryRef(runId, { baseCommit: s.mainCommit }) },
        { type: "run.state_change", from: "running", to: "completed", reason: "done" },
      ];
      s.seed("run_j1x", loop("run_j1x", "run_j1y"));
      s.seed("run_j1y", loop("run_j1y", "run_j1x"));
    },
  });
  const deleted = ["run_j1a", "run_j1b"].filter((id) => outcomeOf(result, "delete_branch", id)?.outcome === "deleted");
  const skipped = ["run_j1a", "run_j1b"].filter((id) => outcomeOf(result, "delete_branch", id)?.outcome === "skipped");
  assert.equal(deleted.length, 1, `先删一条: ${JSON.stringify(result.results)}`);
  assert.equal(skipped.length, 1, "成环后的一条跳过");
  assert.equal(outcomeOf(result, "delete_branch", skipped[0]).reason, "supersession_unproven_now");
});

test("apply（J2）：删前刷新枚举失败 → 跳过（不拿旧索引放行删除）", async () => {
  const s = await scenario();
  for (const [id, child] of [["run_j2a", "run_j2a_c"], ["run_j2b", "run_j2b_c"]]) {
    git(["branch", `wao/${id}`], s.repo);
    s.seed(id, lineageRootRunEvents({ runId: id, repo: s.repo, baseCommit: s.mainCommit }));
    s.seed(child, lineageChildRunEvents({
      runId: child, parentRunId: id, rootRunId: id, repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
    }));
  }
  const planPath = join(s.base, "plan.json");
  await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  // 第 1 次是执行开头的批量预筛枚举；第 2 次是第一条的删前刷新；第 3 次是第二条。
  let calls = 0;
  const supersessionEnumerateFn = (dir) => {
    calls += 1;
    if (calls === 3) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return lineageMemberFiles(dir);
  };
  const result = await applyWorktreeReclaim({
    planPath,
    expectSha256: shaOfPlan(s),
    runDir: s.runDir,
    now: fixedNow,
    supersessionEnumerateFn,
  });
  const outcomes = ["run_j2a", "run_j2b"].map((id) => outcomeOf(result, "delete_branch", id));
  assert.equal(outcomes.filter((o) => o?.outcome === "deleted").length, 1, JSON.stringify(result.results));
  const skipped = outcomes.find((o) => o?.outcome === "skipped");
  assert.equal(skipped.reason, "undeterminable_now", "刷新失败必须跳过");
  assert.match(String(skipped.detail), /refresh_failed_now/, "detail 写明刷新失败");
});

test("apply（J3）：属主是续修子、被截空的是谱系根 → undeterminable_now / transcript_empty_now", async () => {
  const s = await scenario();
  const wt = s.wt("run_j3_o");
  s.seed("run_j3_r", lineageRootRunEvents({
    runId: "run_j3_r", repo: s.repo, wt, branch: null, baseCommit: s.mainCommit,
  }));
  s.seed("run_j3_o", lineageChildRunEvents({
    runId: "run_j3_o", parentRunId: "run_j3_r", rootRunId: "run_j3_r",
    repo: s.repo, wt, branch: "wao/run_j3_o", baseCommit: s.mainCommit,
  }));
  s.seed("run_j3_d", lineageChildRunEvents({
    runId: "run_j3_d", parentRunId: "run_j3_o", rootRunId: "run_j3_r",
    repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
  }));
  const planPath = join(s.base, "plan.json");
  const { plan } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  assert.ok(plan.items.some((i) => i.action === "remove_tree" && i.runId === "run_j3_o"),
    "夹具前提：属主的树可回收（被取代）");
  // 计划之后才把谱系根截空。
  writeFileSync(join(s.runDir, "run_j3_r.jsonl"), "", "utf8");
  const result = await applyWorktreeReclaim({ planPath, expectSha256: shaOfPlan(s), runDir: s.runDir, now: fixedNow });
  const tree = outcomeOf(result, "remove_tree", "run_j3_o");
  assert.equal(tree.outcome, "skipped", JSON.stringify(tree));
  assert.equal(tree.reason, "undeterminable_now", "空转录不是'在跑'");
  assert.match(String(tree.detail), /transcript_empty_now/, "detail 写明转录为空");
  assert.match(String(tree.detail), /run_j3_r/, "点名空的谱系成员");
  assert.ok(existsSync(wt), "树保留");
});

test("apply（K1）：计划后出现内容冲突的孪生成员（最后状态相同）→ 跳过，不当成无转录放行", async () => {
  const s = await scenario();
  const wt = s.wt("run_k1_a");
  s.seed("run_k1_a", decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_k1_a", baseCommit: s.mainCommit, decision: "accepted",
  }));
  const planPath = join(s.base, "plan.json");
  const { plan } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  assert.ok(plan.items.some((i) => i.action === "remove_tree" && i.runId === "run_k1_a"), "夹具前提：树可回收");
  // 批准之后才出现只靠路径声明的成员 M：两份副本内容不同、最后状态相同、带打包事实。
  const memberEvents = [
    {
      type: "run.started", backend: "test", cwd: s.repo, worktreePath: wt, worktreeBranch: null,
      delivery: { mode: "git_commit_v1", baseCommit: s.mainCommit },
    },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
    { type: "run.delivery_created", delivery: verifiedDeliveryRef("run_k1_m", { baseCommit: s.mainCommit }) },
    { type: "run.delivery_verification_passed", delivery: verifiedDeliveryRef("run_k1_m", { baseCommit: s.mainCommit }) },
  ];
  s.seed("run_k1_m", memberEvents);
  s.seed("run_k1_m", [...memberEvents, { type: "run.lead_note", text: "harmless" }], { bucket: "conflict" });
  const result = await applyWorktreeReclaim({ planPath, expectSha256: shaOfPlan(s), runDir: s.runDir, now: fixedNow });
  const tree = outcomeOf(result, "remove_tree", "run_k1_a");
  assert.equal(tree.outcome, "skipped", JSON.stringify(tree));
  assert.equal(tree.reason, "undeterminable_now");
  assert.match(String(tree.detail), /transcript_conflict_now/, "内容冲突各写各的原因");
  assert.ok(existsSync(wt), "歧义成员挡住整棵树");
});

test("apply：转录此刻缺失 → 按无法判定跳过（找不到转录≠不在跑）", async () => {
  const s = await scenario();
  const wt = s.wt("run_gone");
  const transcriptPath = s.accepted("run_gone", wt);
  const { result } = await s.planAndApply({
    mutate: async () => { rmSync(transcriptPath); },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_gone").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_gone").reason, "undeterminable_now");
  assert.match(outcomeOf(result, "remove_tree", "run_gone").detail ?? "", /transcript_missing_now/);
  assert.ok(existsSync(wt), "无法判定时树不动");
  assert.equal(outcomeOf(result, "delete_branch", "run_gone").reason, "tree_not_removed");
});

test("apply：批准后非主人成员有新鲜心跳 → 整树跳过（成员复核不只查树的主人）", async () => {
  const s = await scenario();
  const wt = s.wt("run_shr");
  s.accepted("run_shr", wt);
  s.seed("run_shm", memberRunEvents({ repo: s.repo, wt, branch: "wao/run_shr", rootRunId: "run_shr", terminal: true }));
  const { result } = await s.planAndApply({
    mutate: async () => {
      writeFileSync(join(s.runDir, ".owner-run_shm"), JSON.stringify({ heartbeatAt: fixedNow() - 1000 }), "utf8");
    },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_shr").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_shr").reason, "running_now");
  assert.match(outcomeOf(result, "remove_tree", "run_shr").detail ?? "", /run_shm:fresh_owner_heartbeat/);
  assert.ok(existsSync(wt), "成员在跑时整树不动");
  assert.equal(outcomeOf(result, "delete_branch", "run_shr").reason, "tree_not_removed");
});

test("apply：子树因新鲜心跳跳过 → 父树连带跳过，子树原样在册", async () => {
  const s = await scenario();
  const outer = s.wt("run_par");
  const inner = join(outer, ".wao-worktrees", "run_chi");
  git(["worktree", "add", inner, "-b", "wao/run_chi"], s.repo);
  s.accepted("run_par", outer);
  s.accepted("run_chi", inner);
  const { result } = await s.planAndApply({
    mutate: async () => {
      writeFileSync(join(s.runDir, ".owner-run_chi"), JSON.stringify({ heartbeatAt: fixedNow() - 1000 }), "utf8");
    },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_chi").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_chi").reason, "running_now");
  // 子树跳过后必须从"将被删除"集合拿掉：父树复核看到在册后代 → 连带跳过。
  assert.equal(outcomeOf(result, "remove_tree", "run_par").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_par").reason, "kept_descendant_now");
  assert.ok(existsSync(inner), "子树原样在册");
  assert.ok(existsSync(outer), "父树不动");
  assert.ok(git(["branch", "--list", "wao/run_par"], s.repo).length > 0);
  assert.ok(git(["branch", "--list", "wao/run_chi"], s.repo).length > 0);
});

test("apply：脏树快照写失败 → 这棵树不删、分支不删、记为跳过", async () => {
  const s = await scenario();
  const wt = s.wt("run_snapf");
  writeFileSync(join(wt, "dirty.txt"), "about to be dropped\n", "utf8");
  s.accepted("run_snapf", wt);
  const { result } = await s.planAndApply({
    beforeTreeSnapshot: async (item, claimed) => {
      if (item.runId !== "run_snapf") return;
      // 把 <保全目录>/dirty 占成文件：快照的 mkdir 必然失败。
      writeFileSync(join(claimed, "dirty"), "not a directory\n", "utf8");
    },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_snapf").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_snapf").reason, "dirty_snapshot_failed");
  assert.ok(existsSync(wt), "快照失败时树不动");
  assert.equal(outcomeOf(result, "delete_branch", "run_snapf").reason, "tree_not_removed");
});

// ── TD-374：删脏树前备份内容（受控改动 diff + 未被忽略的新文件副本）──
// 备份落在本次回收记录目录的 dirty/ 下：<runId>.diff、<runId>.untracked/<相对路径>、
// <runId>.untracked-links.txt；被忽略的文件（node_modules、dist 之类）不备份。

/** 递归列出目录下全部非目录条目（绝对路径；不跟随链接）。 */
function filesUnder(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

/** 在干净检出上依次回放两层补丁：先 --index 应用暂存层（索引与工作区一起变），再把工作区层打到工作区上。
 * 空补丁（0 字节）不是合法的 git apply 输入，跳过。 */
function replayBackup(clean, stagedPath, unstagedPath) {
  for (const [path, args] of [[stagedPath, ["--index"]], [unstagedPath, []]]) {
    if (statSync(path).size === 0) continue;
    execFileSync("git", ["apply", "--check", ...args, path], { cwd: clean, stdio: "pipe" });
    execFileSync("git", ["apply", ...args, path], { cwd: clean, stdio: "pipe" });
  }
}

test("执行（TD-374）：staged、unstaged、未忽略新文件的树 → 删前备份；两层补丁依次回放到干净检出，新文件副本逐字节一致，被忽略文件不进备份", async () => {
  const s = await scenario();
  const wt = s.wt("run_bk1");
  // staged：新增文本与二进制文件；unstaged：改已跟踪的 a.txt；untracked：未忽略的新文件
  //（含子目录）；ignored：node_modules 里的文件。
  const bin = Buffer.from([0, 1, 2, 255, 254, 0, 7, 8, 9, 0]);
  writeFileSync(join(wt, "staged.txt"), "staged new file\n");
  writeFileSync(join(wt, "staged.bin"), bin);
  git(["add", "staged.txt", "staged.bin"], wt);
  writeFileSync(join(wt, "a.txt"), "const a = 2; // unstaged edit\n");
  mkdirSync(join(wt, "notes", "deep"), { recursive: true });
  writeFileSync(join(wt, "notes", "deep", "untracked.txt"), "untracked content\n");
  mkdirSync(join(wt, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(wt, "node_modules", "pkg", "ignored.js"), "IGNORED-MARKER\n");
  s.accepted("run_bk1", wt);
  const { result } = await s.planAndApply();
  assert.ok(!result.refused, `不应拒绝：${result.refused}`);
  assert.equal(outcomeOf(result, "remove_tree", "run_bk1").outcome, "removed");
  assert.ok(!existsSync(wt), "树照常删除");

  const dirtyDir = join(result.preserveDir, "dirty");
  assert.ok(existsSync(join(dirtyDir, "run_bk1.status.txt")), "状态快照照旧保存");
  // 第 150 批修正一：暂存层（HEAD→索引）与工作区层（索引→工作区）分开存——
  // 合成一份 `git diff HEAD` 会丢掉被工作区改动抵消的暂存内容。
  const stagedPath = join(dirtyDir, "run_bk1.staged.diff");
  const unstagedPath = join(dirtyDir, "run_bk1.unstaged.diff");
  assert.ok(existsSync(stagedPath), "暂存层补丁在备份目录里");
  assert.ok(existsSync(unstagedPath), "工作区层补丁在备份目录里");
  assert.ok(!existsSync(join(dirtyDir, "run_bk1.diff")), "不再有合成的 .diff");
  assert.equal(
    readFileSync(join(dirtyDir, "run_bk1.untracked", "notes", "deep", "untracked.txt"), "utf8"),
    "untracked content\n",
    "未忽略的新文件副本保留相对路径、内容一致",
  );
  const copied = filesUnder(dirtyDir);
  assert.ok(!copied.some((p) => readFileSync(p).includes("IGNORED-MARKER")), "被忽略的文件不备份");
  assert.ok(!existsSync(join(dirtyDir, "run_bk1.untracked-links.txt")), "没有链接或目录时不出 links 清单");

  // 回放：在干净检出（基点提交）上先 --index 应用暂存层，再应用工作区层，内容与删前一致。
  const clean = join(s.base, "clean-checkout");
  git(["worktree", "add", "--detach", clean, s.mainCommit], s.repo);
  replayBackup(clean, stagedPath, unstagedPath);
  assert.equal(readFileSync(join(clean, "a.txt"), "utf8"), "const a = 2; // unstaged edit\n", "unstaged 改动回放");
  assert.equal(readFileSync(join(clean, "staged.txt"), "utf8"), "staged new file\n", "staged 新文件回放");
  assert.deepEqual(readFileSync(join(clean, "staged.bin")), bin, "二进制文件逐字节回放");
  assert.equal(git(["show", ":staged.txt"], clean), "staged new file", "暂存区里也有 staged 新文件");

  // 输出与记录：备份了哪棵树、存在哪里。
  assert.equal(result.dirtyBackups.length, 1);
  assert.equal(result.dirtyBackups[0].runId, "run_bk1");
  assert.equal(result.dirtyBackups[0].stagedPath, stagedPath);
  assert.equal(result.dirtyBackups[0].unstagedPath, unstagedPath);
  const rec = JSON.parse(readFileSync(join(result.preserveDir, "results.json"), "utf8"));
  assert.deepEqual(rec.dirtyBackups.map((b) => b.runId), ["run_bk1"]);
});

test("执行（TD-374）：只有被忽略文件的树 → 只存状态快照，不生成 .diff 与 .untracked，照旧删除", async () => {
  const s = await scenario();
  const wt = s.wt("run_bki");
  mkdirSync(join(wt, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(wt, "node_modules", "pkg", "ignored.js"), "IGNORED-MARKER\n");
  s.accepted("run_bki", wt);
  const { result } = await s.planAndApply();
  assert.equal(outcomeOf(result, "remove_tree", "run_bki").outcome, "removed");
  assert.ok(!existsSync(wt));
  const dirtyDir = join(result.preserveDir, "dirty");
  assert.deepEqual(readdirSync(dirtyDir).sort(), ["run_bki.status.txt"], "只有状态快照");
  assert.deepEqual(result.dirtyBackups, [], "没有树被备份");
});

// ── 树里有链接（第 150 批修正一，真删，不注入失败）──
// junction（和 Node 分不开的目录符号链接）：apply 在算指纹、备份之前不跟进链接地走一遍整棵
// 树，发现就保留整棵树（tree_contains_junction）——git diff/status 会读进目标的内容，而
// 原生 git 删树还会删掉目标里的文件。指向文件的符号链接 git 不跟进：照常备份（记进 links
// 清单）、照常删除，树外文件原样。
const OUTSIDE_MARKER = "OUTSIDE-SECRET-MARKER";

/** 树外目录 + 里面的 secret.txt。 */
function plantOutside(s) {
  const outside = join(s.base, "outside-dir");
  mkdirSync(outside, { recursive: true });
  const secret = join(outside, "secret.txt");
  writeFileSync(secret, `${OUTSIDE_MARKER}\n`);
  return { outside, secret };
}

for (const kind of ["junction", "dir"]) {
  test(`执行（TD-374）：树里有指向树外的 ${kind} 链接 → 整棵树保留、记 tree_contains_junction，不备份、不删树、不删分支，树外文件不动`, async (t) => {
    const s = await scenario();
    const wt = s.wt("run_bkj");
    const { outside, secret } = plantOutside(s);
    try {
      symlinkSync(outside, join(wt, "linkdir"), kind);
    } catch {
      t.skip(`此环境不允许创建 ${kind} 链接，无法构造树内链接`);
      return;
    }
    writeFileSync(join(wt, "plain.txt"), "plain untracked\n");
    s.accepted("run_bkj", wt);
    const { result } = await s.planAndApply();
    const r = outcomeOf(result, "remove_tree", "run_bkj");
    assert.equal(r.outcome, "skipped");
    assert.equal(r.reason, "tree_contains_junction");
    assert.match(String(r.detail), /^linkdir/, `detail 点名链接的相对路径：${r.detail}`);
    assert.equal(outcomeOf(result, "delete_branch", "run_bkj").reason, "tree_not_removed", "分支不删");
    assert.ok(git(["branch", "--list", "wao/run_bkj"], s.repo).length > 0);
    assert.ok(existsSync(wt) && lstatSync(join(wt, "linkdir")).isSymbolicLink(), "整棵树与链接原样");
    assert.equal(readFileSync(join(wt, "plain.txt"), "utf8"), "plain untracked\n");
    assert.equal(readFileSync(secret, "utf8"), `${OUTSIDE_MARKER}\n`, "树外文件原样不动");
    assert.deepEqual(result.dirtyBackups, [], "没有备份");
    assert.ok(
      !filesUnder(result.preserveDir).some((p) => readFileSync(p).includes(OUTSIDE_MARKER)),
      "树外文件的内容不在记录目录的任何文件里",
    );
    assert.ok(!existsSync(join(result.preserveDir, "dirty")), "没碰内容：连状态快照目录都没建");
  });
}

test("执行（TD-374）：受控目录被换成指向树外的 junction → 整棵树保留，git diff 读到的树外内容不进任何备份文件", async (t) => {
  const s = await scenario();
  const wt = s.wt("run_bkt");
  mkdirSync(join(wt, "tracked"), { recursive: true });
  commitIn(wt, "tracked/f.txt", "original\n");
  s.accepted("run_bkt", wt);
  const { outside } = plantOutside(s);
  writeFileSync(join(outside, "f.txt"), `${OUTSIDE_MARKER}-TRACKED\n`);
  rmSync(join(wt, "tracked"), { recursive: true, force: true });
  try {
    symlinkSync(outside, join(wt, "tracked"), "junction");
  } catch {
    t.skip("此环境不允许创建 junction，无法构造");
    return;
  }
  assert.ok(git(["status", "--porcelain"], wt).includes("tracked/f.txt"), "前置：git 把 junction 里的内容当成受控文件的改动");
  const { result } = await s.planAndApply();
  const r = outcomeOf(result, "remove_tree", "run_bkt");
  assert.equal(r.outcome, "skipped");
  assert.equal(r.reason, "tree_contains_junction");
  assert.ok(existsSync(wt), "树还在");
  assert.ok(
    !filesUnder(result.preserveDir).some((p) => readFileSync(p).includes(OUTSIDE_MARKER)),
    "树外文件的内容不在记录目录的任何文件里",
  );
  assert.equal(readFileSync(join(outside, "f.txt"), "utf8"), `${OUTSIDE_MARKER}-TRACKED\n`, "树外文件原样不动");
});

test("执行（TD-374）：删前整树检查之后才冒出的 junction（竞态）→ 备份不跟进、摘树不跟进，树真删、树外文件原样", async (t) => {
  // "已知不防"的竞态之外还剩两道：备份逐级 lstat 父目录（记链接本身、不复制），摘树走
  // isolation.removeWorktree（rmSync，不跟进）。测试缝在删前复核之后、备份之前，在这里建
  // junction。旧实现（git worktree remove --force）下，这条会把树外的 secret.txt 删掉。
  const s = await scenario();
  const wt = s.wt("run_bkrace");
  const { outside, secret } = plantOutside(s);
  writeFileSync(join(wt, "plain.txt"), "plain untracked\n");
  s.accepted("run_bkrace", wt);
  let linked = true;
  const { result } = await s.planAndApply({
    beforeTreeSnapshot: async (item) => {
      if (item.runId !== "run_bkrace") return;
      try {
        symlinkSync(outside, join(wt, "linkdir"), "junction");
      } catch {
        linked = false;
      }
    },
  });
  if (!linked) {
    t.skip("此环境不允许创建 junction，无法构造");
    return;
  }
  assert.equal(outcomeOf(result, "remove_tree", "run_bkrace").outcome, "removed");
  assert.ok(!existsSync(wt), "树删净（含 junction 本身）");
  assert.equal(readFileSync(secret, "utf8"), `${OUTSIDE_MARKER}\n`, "树外文件原样不动");
  const dirtyDir = join(result.preserveDir, "dirty");
  assert.equal(readFileSync(join(dirtyDir, "run_bkrace.untracked", "plain.txt"), "utf8"), "plain untracked\n");
  const links = readFileSync(join(dirtyDir, "run_bkrace.untracked-links.txt"), "utf8").split(/\r?\n/).filter(Boolean);
  assert.deepEqual(links, ["linkdir"], "穿过 junction 才走得到的条目记链接本身");
  assert.ok(
    !filesUnder(result.preserveDir).some((p) => readFileSync(p).includes(OUTSIDE_MARKER)),
    "树外文件的内容不在记录目录的任何文件里",
  );
});

test("执行（TD-374）：指向树外文件的符号链接 → 照常备份（路径记进 links 清单、不复制目标）、真删树，树外文件原样", async (t) => {
  const s = await scenario();
  const wt = s.wt("run_bkl");
  const { secret } = plantOutside(s);
  try {
    symlinkSync(secret, join(wt, "leak.txt"), "file");
  } catch {
    t.skip("此环境不允许创建文件符号链接，无法构造");
    return;
  }
  writeFileSync(join(wt, "plain.txt"), "plain untracked\n");
  s.accepted("run_bkl", wt);
  const { result } = await s.planAndApply();
  assert.equal(outcomeOf(result, "remove_tree", "run_bkl").outcome, "removed", "真删，没有注入");
  assert.ok(!existsSync(wt));
  const dirtyDir = join(result.preserveDir, "dirty");
  assert.equal(readFileSync(join(dirtyDir, "run_bkl.untracked", "plain.txt"), "utf8"), "plain untracked\n", "普通新文件照常复制");
  const links = readFileSync(join(dirtyDir, "run_bkl.untracked-links.txt"), "utf8").split(/\r?\n/).filter(Boolean);
  assert.deepEqual(links, ["leak.txt"], "只有链接进 links 清单");
  assert.ok(!existsSync(join(dirtyDir, "run_bkl.untracked", "leak.txt")), "不复制链接目标文件");
  assert.ok(
    !filesUnder(result.preserveDir).some((p) => readFileSync(p).includes(OUTSIDE_MARKER)),
    "树外文件的内容不在记录目录的任何文件里",
  );
  assert.equal(readFileSync(secret, "utf8"), `${OUTSIDE_MARKER}\n`, "树外文件原样不动");
});

test("执行（TD-374）：单树备份字节数超上限 → 这棵树不删、分支不删、记 dirty_backup_too_large；上限按单棵树算", async () => {
  const s = await scenario();
  const big = "x".repeat(4096);
  const treeUntracked = s.wt("run_tl1");
  writeFileSync(join(treeUntracked, "big.txt"), big); // 未忽略新文件超限
  const treeStaged = s.wt("run_tl2");
  writeFileSync(join(treeStaged, "big-staged.txt"), big); // diff 本身超限
  git(["add", "big-staged.txt"], treeStaged);
  const treeSmall = s.wt("run_tl3");
  writeFileSync(join(treeSmall, "small.txt"), "tiny\n"); // 在限内
  for (const [id, wt] of [["run_tl1", treeUntracked], ["run_tl2", treeStaged], ["run_tl3", treeSmall]]) s.accepted(id, wt);
  const { result } = await s.planAndApply({ dirtyBackupMaxBytes: 2048 });
  for (const id of ["run_tl1", "run_tl2"]) {
    const r = outcomeOf(result, "remove_tree", id);
    assert.equal(r.outcome, "skipped", id);
    assert.equal(r.reason, "dirty_backup_too_large", id);
    assert.equal(outcomeOf(result, "delete_branch", id).reason, "tree_not_removed", `${id} 的分支不删`);
    assert.ok(git(["branch", "--list", `wao/${id}`], s.repo).length > 0, `${id} 分支还在`);
  }
  assert.ok(existsSync(treeUntracked) && existsSync(treeStaged), "超限的树都还在");
  assert.equal(readFileSync(join(treeUntracked, "big.txt"), "utf8"), big, "树里的内容原样");
  const dirtyFiles = readdirSync(join(result.preserveDir, "dirty")).sort();
  assert.ok(
    !dirtyFiles.some((n) => n.startsWith("run_tl1.") && n.endsWith(".diff")) && !dirtyFiles.some((n) => n.startsWith("run_tl2.") && n.endsWith(".diff")),
    `超限时不写半截备份：${dirtyFiles}`,
  );
  assert.ok(!dirtyFiles.some((n) => n === "run_tl1.untracked"), `超限时不写半截备份：${dirtyFiles}`);
  assert.equal(outcomeOf(result, "remove_tree", "run_tl3").outcome, "removed", "限内的树照常备份、删除");
  assert.ok(existsSync(join(result.preserveDir, "dirty", "run_tl3.untracked", "small.txt")));
});

test("执行（TD-374）：备份写失败 → 这棵树不删、分支不删、记 dirty_backup_failed（状态快照已写成）；已存在的同名文件不被覆盖（独占创建）", async () => {
  const s = await scenario();
  const wt = s.wt("run_bkf");
  writeFileSync(join(wt, "dirty.txt"), "about to be dropped\n", "utf8");
  s.accepted("run_bkf", wt);
  let squatted = null;
  const { result } = await s.planAndApply({
    // 测试缝在状态快照之前：把 <runId>.staged.diff 抢先建成普通文件——状态快照照常写成，备份
    // 独占创建（wx）这个文件时必然 EEXIST：失败留树，且不把别人的文件覆盖掉。
    beforeTreeSnapshot: async (item, claimed) => {
      if (item.runId !== "run_bkf") return;
      mkdirSync(join(claimed, "dirty"), { recursive: true });
      squatted = join(claimed, "dirty", "run_bkf.staged.diff");
      writeFileSync(squatted, "SQUATTER\n", "utf8");
    },
  });
  const r = outcomeOf(result, "remove_tree", "run_bkf");
  assert.equal(r.outcome, "skipped");
  assert.equal(r.reason, "dirty_backup_failed");
  assert.equal(r.detail, "EEXIST");
  assert.equal(readFileSync(squatted, "utf8"), "SQUATTER\n", "独占创建：已存在的文件不被覆盖");
  assert.ok(existsSync(wt), "备份失败时树不动");
  assert.equal(readFileSync(join(wt, "dirty.txt"), "utf8"), "about to be dropped\n");
  assert.equal(outcomeOf(result, "delete_branch", "run_bkf").reason, "tree_not_removed", "分支不删");
  assert.ok(git(["branch", "--list", "wao/run_bkf"], s.repo).length > 0);
  assert.ok(existsSync(join(result.preserveDir, "dirty", "run_bkf.status.txt")), "状态快照先于备份、已写成（失败点确在备份这一步）");
  assert.deepEqual(result.dirtyBackups, [], "失败的备份不算数");
});

test("执行（TD-374）：同一文件 MM（暂存 B、工作区改回 A）→ 两层补丁都在，依次回放后暂存区里是 B、工作区是 A", async () => {
  // 旧写法只存 `git diff HEAD`：工作区改回 HEAD 的内容时它输出空补丁，暂存区里的 B 随树一起丢。
  const s = await scenario();
  const wt = s.wt("run_bkmm");
  const original = readFileSync(join(wt, "a.txt"), "utf8");
  writeFileSync(join(wt, "a.txt"), "const a = 'B-staged';\n");
  git(["add", "a.txt"], wt);
  writeFileSync(join(wt, "a.txt"), original);
  assert.equal(git(["status", "--porcelain"], wt), "MM a.txt", "前置：同一文件暂存 B、工作区改回 A");
  assert.equal(git(["diff", "HEAD"], wt), "", "前置：git diff HEAD 是空的（旧写法会丢 B）");
  s.accepted("run_bkmm", wt);
  const { result } = await s.planAndApply();
  assert.equal(outcomeOf(result, "remove_tree", "run_bkmm").outcome, "removed");
  const dirtyDir = join(result.preserveDir, "dirty");
  const stagedPath = join(dirtyDir, "run_bkmm.staged.diff");
  const unstagedPath = join(dirtyDir, "run_bkmm.unstaged.diff");
  assert.ok(statSync(stagedPath).size > 0, "暂存层补丁非空");
  assert.ok(statSync(unstagedPath).size > 0, "工作区层补丁非空");
  const clean = join(s.base, "clean-mm");
  git(["worktree", "add", "--detach", clean, s.mainCommit], s.repo);
  replayBackup(clean, stagedPath, unstagedPath);
  assert.equal(git(["show", ":a.txt"], clean), "const a = 'B-staged';", "暂存区里的 B 回来了");
  assert.equal(readFileSync(join(clean, "a.txt"), "utf8"), original, "工作区是 A");
});

test("执行（TD-374）：补丁不受 diff 配置影响——diff.noprefix / mnemonicPrefix / 外部 diff 与 textconv 都不改变补丁的可回放性", async () => {
  const s = await scenario();
  const wt = s.wt("run_bkcfg");
  git(["config", "diff.noprefix", "true"], s.repo);
  git(["config", "diff.mnemonicPrefix", "true"], s.repo);
  // 外部 diff 与 textconv 配成必然失败的命令（false）：任何没带 --no-ext-diff / --no-textconv 的
  // git diff 都会在这里炸掉或输出非补丁内容。
  git(["config", "diff.external", "false"], s.repo);
  git(["config", "diff.badconv.textconv", "false"], s.repo);
  appendFileSync(join(s.repo, ".git", "info", "attributes"), "*.txt diff=badconv\n", "utf8");
  writeFileSync(join(wt, "a.txt"), "const a = 3; // edited\n");
  writeFileSync(join(wt, "staged.txt"), "staged\n");
  git(["add", "staged.txt"], wt);
  s.accepted("run_bkcfg", wt);
  const { result } = await s.planAndApply();
  assert.equal(outcomeOf(result, "remove_tree", "run_bkcfg").outcome, "removed");
  const dirtyDir = join(result.preserveDir, "dirty");
  const stagedPath = join(dirtyDir, "run_bkcfg.staged.diff");
  const unstagedPath = join(dirtyDir, "run_bkcfg.unstaged.diff");
  assert.match(readFileSync(unstagedPath, "utf8"), /^diff --git a\/a\.txt b\/a\.txt$/m, "固定 a/ b/ 前缀");
  const clean = join(s.base, "clean-cfg");
  git(["worktree", "add", "--detach", clean, s.mainCommit], s.repo);
  replayBackup(clean, stagedPath, unstagedPath); // 默认 -p1 的 git apply 能回放
  assert.equal(readFileSync(join(clean, "a.txt"), "utf8"), "const a = 3; // edited\n");
});

test("执行（TD-374）：状态显示有暂存改动、暂存层补丁却为空 → 无法可靠表示，留树（dirty_backup_failed/staged_patch_empty）", async () => {
  const s = await scenario();
  const wt = s.wt("run_bkse");
  writeFileSync(join(wt, "staged.txt"), "staged\n");
  git(["add", "staged.txt"], wt);
  s.accepted("run_bkse", wt);
  // 真实 git 造不出"status 报暂存、git diff --cached 却为空"：用备份的 git 执行缝，让 --cached 那条返回空。
  const { result } = await s.planAndApply({
    backupGitExec: (args, opts) => (args.includes("--cached") ? Buffer.alloc(0) : execFileSync("git", args, opts)),
  });
  const r = outcomeOf(result, "remove_tree", "run_bkse");
  assert.equal(r.outcome, "skipped");
  assert.equal(r.reason, "dirty_backup_failed");
  assert.equal(r.detail, "staged_patch_empty");
  assert.ok(existsSync(join(wt, "staged.txt")), "树原样");
  assert.equal(outcomeOf(result, "delete_branch", "run_bkse").reason, "tree_not_removed");
});

test("执行（TD-374）：skip-worktree 的树 → 留树（清点不了：改动被索引标志藏起来，status 看着是干净的）", async () => {
  const s = await scenario();
  const wt = s.wt("run_bksw");
  git(["update-index", "--skip-worktree", "a.txt"], wt);
  writeFileSync(join(wt, "a.txt"), "const a = 'hidden change';\n");
  assert.equal(git(["status", "--porcelain"], wt), "", "前置：status 干净，改动被藏起来了");
  s.accepted("run_bksw", wt);
  const { result } = await s.planAndApply();
  const r = outcomeOf(result, "remove_tree", "run_bksw");
  assert.equal(r.outcome, "skipped");
  assert.equal(r.reason, "inventory_unreadable");
  assert.equal(readFileSync(join(wt, "a.txt"), "utf8"), "const a = 'hidden change';\n", "被藏起来的改动还在");
  assert.equal(outcomeOf(result, "delete_branch", "run_bksw").reason, "tree_not_removed");
});

test("执行（TD-374）：assume-unchanged 的树同样留树", async () => {
  const s = await scenario();
  const wt = s.wt("run_bkau");
  git(["update-index", "--assume-unchanged", "a.txt"], wt);
  s.accepted("run_bkau", wt);
  const { result } = await s.planAndApply();
  assert.equal(outcomeOf(result, "remove_tree", "run_bkau").reason, "inventory_unreadable");
  assert.ok(existsSync(wt));
});

test("执行（TD-374）：计划后 .git/info/exclude 改了，原本被忽略的文件变成未忽略 → 跳过（content_changed），不凭旧状态只留清单就删", async () => {
  const s = await scenario();
  const wt = s.wt("run_bkex");
  const excludePath = join(s.repo, ".git", "info", "exclude");
  appendFileSync(excludePath, "gen/\n", "utf8");
  mkdirSync(join(wt, "gen"), { recursive: true });
  writeFileSync(join(wt, "gen", "out.txt"), "generated, later un-ignored\n");
  s.accepted("run_bkex", wt);
  const { result } = await s.planAndApply({
    mutate: async () => {
      // 只改忽略规则：文件路径、大小、时间戳都不变，指纹四件套不动，但它现在是未忽略的新文件。
      writeFileSync(excludePath, "/.wao-worktrees/\n", "utf8");
    },
  });
  const r = outcomeOf(result, "remove_tree", "run_bkex");
  assert.equal(r.outcome, "skipped");
  assert.equal(r.reason, "content_changed");
  assert.ok(existsSync(join(wt, "gen", "out.txt")), "树里的文件原样");
  assert.equal(outcomeOf(result, "delete_branch", "run_bkex").reason, "tree_not_removed");
});

test("执行（TD-374）：两个文件在计划后互换忽略身份（四个脏标志都不变）→ 跳过 content_changed，树和分支保留，不凭旧身份删", async () => {
  // 计划时：a 未忽略（会被备份）、b 被忽略（只留清单）；批准后只改 .git/info/exclude 把两者
  // 对调。路径、字节数、mtime 都没变，staged/unstaged/untracked/ignored 四个标志也都还是
  // 旧值——只有"哪个文件属于哪一类"变了。旧清单看不出，apply 会备份新变成未忽略的 b、把原本
  // 该备份的 a 随树删掉。
  const s = await scenario();
  const wt = s.wt("run_bkswap");
  const excludePath = join(s.repo, ".git", "info", "exclude");
  appendFileSync(excludePath, "\nb_swap.txt\n", "utf8");
  writeFileSync(join(wt, "a_swap.txt"), "A-content\n");
  writeFileSync(join(wt, "b_swap.txt"), "B-content\n");
  const statusNow = () => git(["status", "--porcelain", "--ignored"], wt).split(/\r?\n/).sort();
  assert.deepEqual(statusNow().filter((l) => l.includes("_swap")), ["!! b_swap.txt", "?? a_swap.txt"], "前置：a 未忽略、b 被忽略");
  s.accepted("run_bkswap", wt);
  const { result } = await s.planAndApply({
    mutate: async () => {
      writeFileSync(excludePath, readFileSync(excludePath, "utf8").replace("b_swap.txt", "a_swap.txt"), "utf8");
      assert.deepEqual(statusNow().filter((l) => l.includes("_swap")), ["!! a_swap.txt", "?? b_swap.txt"], "前置：对调完成");
    },
  });
  const r = outcomeOf(result, "remove_tree", "run_bkswap");
  assert.equal(r.outcome, "skipped");
  assert.equal(r.reason, "content_changed");
  assert.ok(existsSync(join(wt, "a_swap.txt")) && existsSync(join(wt, "b_swap.txt")), "树里的文件原样");
  assert.equal(outcomeOf(result, "delete_branch", "run_bkswap").reason, "tree_not_removed", "分支保留");
  assert.ok(git(["branch", "--list", "wao/run_bkswap"], s.repo).length > 0);
  assert.deepEqual(result.dirtyBackups, [], "没有凭旧状态做备份");
});

test("执行（TD-374）：用户配了 diff.context=0 → 补丁固定 3 行上下文，普通 git apply 能依次回放两层", async () => {
  // diff.context=0 时 git diff 不输出上下文行，默认的 git apply 不收这样的补丁（需要
  // --unidiff-zero）。备份显式带 --unified=3，不受用户配置影响。
  const s = await scenario();
  const wt = s.wt("run_bkctx");
  const original = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  commitIn(wt, "multi.txt", original);
  const head = git(["rev-parse", "HEAD"], wt);
  git(["config", "diff.context", "0"], s.repo);
  // 暂存层改第 3 行，工作区层改第 7 行（同一个文件）。
  writeFileSync(join(wt, "multi.txt"), original.replace("line 3", "line 3 STAGED"));
  git(["add", "multi.txt"], wt);
  const finalText = original.replace("line 3", "line 3 STAGED").replace("line 7", "line 7 WORKTREE");
  writeFileSync(join(wt, "multi.txt"), finalText);
  s.accepted("run_bkctx", wt);
  const { result } = await s.planAndApply();
  assert.equal(outcomeOf(result, "remove_tree", "run_bkctx").outcome, "removed");
  const dirtyDir = join(result.preserveDir, "dirty");
  const stagedPath = join(dirtyDir, "run_bkctx.staged.diff");
  const unstagedPath = join(dirtyDir, "run_bkctx.unstaged.diff");
  assert.match(readFileSync(stagedPath, "utf8"), /^ line 2$/m, "补丁带上下文行");
  const clean = join(s.base, "clean-ctx");
  git(["worktree", "add", "--detach", clean, head], s.repo);
  replayBackup(clean, stagedPath, unstagedPath); // 普通 git apply --index / git apply，不加 --unidiff-zero
  assert.equal(readFileSync(join(clean, "multi.txt"), "utf8"), finalText, "工作区是最终内容");
  assert.equal(git(["show", ":multi.txt"], clean), original.replace("line 3", "line 3 STAGED").trimEnd(), "暂存区里只有暂存层的改动");
});

test("执行（TD-374）：归档根预先被设成 junction → 整体拒绝（preserve_dir_unsafe），不写任何备份，树与分支不动", async (t) => {
  const s = await scenario();
  const wt = s.wt("run_bkarch");
  writeFileSync(join(wt, "dirty.txt"), "about to be dropped\n", "utf8");
  s.accepted("run_bkarch", wt);
  const elsewhere = join(s.base, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  let linked = true;
  const { result } = await s.planAndApply({
    // 计划面读归档根须是干净形态（链接会让计划整体毒化），apply 前才把它换成 junction。
    mutate: async () => {
      try {
        symlinkSync(elsewhere, join(s.base, "runs-archive"), "junction");
      } catch {
        linked = false;
      }
    },
  });
  if (!linked) {
    t.skip("此环境不允许创建 junction，无法构造");
    return;
  }
  assert.equal(result.refused, "preserve_dir_unsafe");
  assert.deepEqual(readdirSync(elsewhere), [], "物理上的另一目录里什么都没写");
  assert.ok(existsSync(join(wt, "dirty.txt")), "树原样");
  assert.ok(git(["branch", "--list", "wao/run_bkarch"], s.repo).length > 0, "分支原样");
});

test("备份路径段：Windows 保留名、点段、带冒号的段、空段一律拒绝；普通名字放行", () => {
  for (const bad of ["..", ".", "", "a:b", "C:", "CON", "con", "NUL.txt", "aux.tar.gz", "COM1", "lpt9.log", "Prn"]) {
    assert.equal(isAbnormalBackupSegment(bad), true, `应拒绝：${JSON.stringify(bad)}`);
  }
  for (const ok of ["a.txt", "console.log", "com10", "lpt0x", "notes", "..hidden", "a..b", "nul-file", "auxiliary.txt", ".gitignore"]) {
    assert.equal(isAbnormalBackupSegment(ok), false, `应放行：${JSON.stringify(ok)}`);
  }
});

test("apply CLI（TD-374）：输出说明备份了几棵树、存在哪里", async () => {
  const s = await scenario();
  const wt = s.wt("run_bkc");
  writeFileSync(join(wt, "dirty.txt"), "about to be dropped\n", "utf8");
  s.accepted("run_bkc", wt);
  const outPath = join(s.base, "plan.json");
  const { planSha256 } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath, now: fixedNow });
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    await worktreeCommand(["reclaim", "--apply", outPath, "--expect-sha256", planSha256, "--run-dir", s.runDir], {});
  } finally {
    console.log = origLog;
  }
  const done = logs.find((l) => l.trim().startsWith("[worktree reclaim] 完成"));
  assert.ok(done, `应打印完成：${logs.join(" | ")}`);
  const preserveDir = done.slice(done.indexOf("记录：") + "记录：".length).trim();
  const line = logs.find((l) => l.includes("脏树备份"));
  assert.ok(line, `应有脏树备份行：${logs.join(" | ")}`);
  assert.ok(line.includes("1 棵"), `备份了几棵：${line}`);
  assert.ok(line.includes(join(preserveDir, "dirty")), `存在哪里：${line}`);
});

test("apply（L1）：对某根是候选的已有文件改成另一根的 X↔Y → 后一条跳过", async () => {
  const s = await scenario();
  git(["branch", "wao/run_l1a"], s.repo);
  git(["branch", "wao/run_l1b"], s.repo);
  for (const id of ["run_l1a", "run_l1b"]) {
    s.seed(id, lineageRootRunEvents({ runId: id, repo: s.repo, baseCommit: s.mainCommit }));
    s.seed(`${id}_c`, lineageChildRunEvents({
      runId: `${id}_c`, parentRunId: id, rootRunId: id, repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
    }));
  }
  // X、Y 先命中根 A（A 的成员；对根 B 不是候选）。
  const asMember = (runId, parentRunId, rootRunId) => [
    {
      type: "run.background_submitted", runId, continuation: true,
      parentRunId, rootRunId,
    },
    { type: "run.session_reuse", runId, mode: "run_lineage", turn: "resume", rootRunId },
    { type: "run.delivery_created", delivery: verifiedDeliveryRef(runId, { baseCommit: s.mainCommit }) },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
  ];
  s.seed("run_l1x", asMember("run_l1x", "run_l1a", "run_l1a"));
  s.seed("run_l1y", asMember("run_l1y", "run_l1a_c", "run_l1a"));
  const planPath = join(s.base, "plan.json");
  const { plan } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  assert.ok(plan.items.filter((i) => i.action === "delete_branch").length >= 2, "夹具前提：两条分支可删");
  let injected = false;
  const result = await applyWorktreeReclaim({
    planPath,
    expectSha256: shaOfPlan(s),
    runDir: s.runDir,
    now: fixedNow,
    beforeBranchDelete: async () => {
      if (injected) return;
      injected = true;
      // 已有文件改成根 B 的 X↔Y（它们对 A 仍是候选、对 B 不是）。多一条无害
      // 事件让新内容变长——同尺寸改写只能靠 mtime 判断，粗粒度时间戳会偶发漏检。
      const rewritten = (runId, parentRunId) => [
        ...asMember(runId, parentRunId, "run_l1b"),
        { type: "run.lead_note", text: "rewritten after plan" },
      ];
      s.seed("run_l1x", rewritten("run_l1x", "run_l1y"));
      s.seed("run_l1y", rewritten("run_l1y", "run_l1x"));
    },
  });
  const deleted = ["run_l1a", "run_l1b"].filter((id) => outcomeOf(result, "delete_branch", id)?.outcome === "deleted");
  const skipped = ["run_l1a", "run_l1b"].filter((id) => outcomeOf(result, "delete_branch", id)?.outcome === "skipped");
  assert.equal(deleted.length, 1, `先删一条: ${JSON.stringify(result.results)}`);
  assert.equal(skipped.length, 1, "成环后的一条跳过");
  assert.equal(outcomeOf(result, "delete_branch", skipped[0]).reason, "supersession_unproven_now");
});

test("apply（N2/O2）：未预热读器 + 桶 statSync EACCES（真实调用链）→ 跳过、分支保留", async () => {
  const s = await scenario();
  git(["branch", "wao/run_n2_br"], s.repo);
  s.seed("run_n2_br", decidedRunEvents({
    repo: s.repo, baseCommit: s.mainCommit, branch: "wao/run_n2_br", decision: "accepted",
  }));
  // 项目桶在场（里面有转录），给桶目录的 statSync 注入 EACCES。
  s.seed("run_bucket_dummy", cleanRunEvents({ repo: s.repo }), { bucket: "proj-a" });
  const planPath = join(s.base, "plan.json");
  const { plan } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  assert.ok(plan.items.some((i) => i.action === "delete_branch" && i.runId === "run_n2_br"),
    "夹具前提：已裁决分支可删（读器未预热、无派生需求）");
  const bucketDir = join(s.runDir, "projects", "proj-a");
  const fsCjs = require("node:fs");
  const realStat = fsCjs.statSync;
  let injected = 0;
  fsCjs.statSync = (p, ...rest) => {
    if (String(p) === bucketDir) {
      injected += 1;
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    }
    return realStat(p, ...rest);
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = await applyWorktreeReclaim({ planPath, expectSha256: shaOfPlan(s), runDir: s.runDir, now: fixedNow });
  } finally {
    fsCjs.statSync = realStat;
    syncBuiltinESMExports();
  }
  assert.ok(injected > 0, "注入生效");
  const outcome = outcomeOf(result, "delete_branch", "run_n2_br");
  assert.equal(outcome.outcome, "skipped", JSON.stringify(result.results));
  assert.equal(outcome.reason, "undeterminable_now", "首次刷新遇到枚举异常也跳过");
  assert.match(String(outcome.detail), /refresh_failed_now/);
  assert.match(git(["rev-parse", "--verify", "refs/heads/wao/run_n2_br"], s.repo), /^[0-9a-f]{40}$/, "分支仍在");
});

test("apply（L2）：执行中归档面变得不可枚举 → 跳过（不按 missing 放行）", async () => {
  const s = await scenario();
  git(["branch", "wao/run_l2a"], s.repo);
  git(["branch", "wao/run_l2b"], s.repo);
  s.seed("run_l2a", lineageRootRunEvents({ runId: "run_l2a", repo: s.repo, baseCommit: s.mainCommit }));
  s.seed("run_l2a_c", lineageChildRunEvents({
    runId: "run_l2a_c", parentRunId: "run_l2a", rootRunId: "run_l2a", repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
  }));
  // 第二条是"计划时确无转录"的已并入分支：旧逻辑会放行。
  git(["merge", "--no-ff", "-m", "m", "wao/run_l2b"], s.repo);
  const planPath = join(s.base, "plan.json");
  const { plan } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  assert.ok(plan.items.some((i) => i.action === "delete_branch" && i.runId === "run_l2b"),
    "夹具前提：无转录的已并入分支可删");
  const archiveRoot = join(dirname(s.runDir), "runs-archive");
  let swapped = false;
  const result = await applyWorktreeReclaim({
    planPath,
    expectSha256: shaOfPlan(s),
    runDir: s.runDir,
    now: fixedNow,
    beforeBranchDelete: async () => {
      if (swapped) return;
      swapped = true;
      // 归档面在两次删除之间变得读不出（占成文件 → 枚举 skipped）。
      rmSync(archiveRoot, { recursive: true, force: true });
      writeFileSync(archiveRoot, "not a directory\n", "utf8");
    },
  });
  const skipped = outcomeOf(result, "delete_branch", "run_l2b");
  assert.equal(skipped.outcome, "skipped", JSON.stringify(result.results));
  assert.equal(skipped.reason, "undeterminable_now", "枚举不完整不能按缺失放行");
  assert.match(String(skipped.detail), /refresh_failed_now/);
  assert.match(git(["rev-parse", "--verify", "refs/heads/wao/run_l2b"], s.repo), /^[0-9a-f]{40}$/, "分支仍在");
});

test("apply（M2）：转录读不出（目录占位）→ 删分支、删空壳都跳过并写准原因", async () => {
  const s = await scenario();
  const husk = join(s.repo, ".wao-worktrees", "run_m2_husk");
  mkdirSync(husk, { recursive: true });
  git(["branch", "wao/run_m2_br"], s.repo);
  s.seed("run_m2_br", decidedRunEvents({
    repo: s.repo, baseCommit: s.mainCommit, branch: "wao/run_m2_br", decision: "accepted",
  }));
  s.seed("run_m2_husk", decidedRunEvents({
    repo: s.repo, baseCommit: s.mainCommit, branch: null, runId: "run_m2_husk", decision: "accepted",
  }));
  const planPath = join(s.base, "plan.json");
  const { plan } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  assert.ok(plan.items.some((i) => i.action === "delete_branch" && i.runId === "run_m2_br"));
  assert.ok(plan.items.some((i) => i.action === "rmdir_husk" && i.runId === "run_m2_husk"));
  // 计划后把两份转录换成同名目录：readFile 报 EISDIR → unreadable。
  for (const id of ["run_m2_br", "run_m2_husk"]) {
    const p = join(s.runDir, `${id}.jsonl`);
    rmSync(p, { force: true });
    mkdirSync(p);
  }
  const result = await applyWorktreeReclaim({ planPath, expectSha256: shaOfPlan(s), runDir: s.runDir, now: fixedNow });
  const br = outcomeOf(result, "delete_branch", "run_m2_br");
  assert.equal(br.outcome, "skipped", JSON.stringify(result.results));
  assert.equal(br.reason, "undeterminable_now");
  assert.match(String(br.detail), /transcript_unreadable_now/);
  const hu = outcomeOf(result, "rmdir_husk", "run_m2_husk");
  assert.equal(hu.outcome, "skipped", JSON.stringify(result.results));
  assert.equal(hu.reason, "undeterminable_now");
  assert.match(String(hu.detail), /transcript_unreadable_now/);
  assert.ok(existsSync(husk), "空壳保留");
});

test("apply（P2）：计划后出现非终态转录的普通分支 → 跳过 running_now、分支保留", async () => {
  const s = await scenario();
  git(["branch", "wao/run_p2_br"], s.repo);
  // 计划时这条运行没有转录、分支已并入：按旧逻辑归"无转录的已并入分支"，可删。
  git(["merge", "--no-ff", "-m", "m", "wao/run_p2_br"], s.repo);
  const planPath = join(s.base, "plan.json");
  const { plan } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: planPath, now: fixedNow });
  assert.ok(plan.items.some((i) => i.action === "delete_branch" && i.runId === "run_p2_br"),
    "夹具前提：计划里可删（无转录、已并入）");
  // 批准后才出现这份转录：运行仍在跑。
  s.seed("run_p2_br", [
    {
      type: "run.started", backend: "test", cwd: s.repo, worktreePath: null, worktreeBranch: "wao/run_p2_br",
    },
    { type: "run.state_change", from: null, to: "running", reason: "spawned" },
  ]);
  const result = await applyWorktreeReclaim({ planPath, expectSha256: shaOfPlan(s), runDir: s.runDir, now: fixedNow });
  const outcome = outcomeOf(result, "delete_branch", "run_p2_br");
  assert.equal(outcome.outcome, "skipped", JSON.stringify(result.results));
  assert.equal(outcome.reason, "running_now", "转录可读而运行尚未终态 → 跳过");
  assert.match(String(outcome.detail), /non_terminal/);
  assert.match(git(["rev-parse", "--verify", "refs/heads/wao/run_p2_br"], s.repo), /^[0-9a-f]{40}$/, "分支仍在");
});

test("apply：最终记录写失败 → 如实标记，CLI 非零退出码且不打印完成（删除照实列出）", async () => {
  const s = await scenario();
  // 只含空壳回收的计划：无 bundle、无快照，保全目录只在记录落盘时创建。
  // 让记录必失败：把保全目录所用的**月份目录**占成文件（归档枚举只看目录，
  // 非目录条目静默跳过——不会像"归档根不可读"那样按枚举不完整拦住删除）。
  const base = dirname(s.runDir);
  const month = (() => {
    const d = new Date(fixedNow());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();
  const archiveMonthFile = join(base, "runs-archive", month);
  mkdirSync(join(base, "runs-archive"), { recursive: true });
  const husk = join(s.repo, ".wao-worktrees", "run_rechusk");
  mkdirSync(husk, { recursive: true });
  s.seed("run_rechusk", cleanRunEvents({ repo: s.repo, wt: husk, branch: null }));
  const outPath = join(s.base, "plan.json");
  const { planSha256 } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath, now: fixedNow });
  writeFileSync(archiveMonthFile, "not a directory\n", "utf8");
  const result = await applyWorktreeReclaim({ planPath: outPath, expectSha256: planSha256, runDir: s.runDir, now: fixedNow });
  assert.ok(!result.refused, `不应拒绝：${result.refused}`);
  assert.equal(outcomeOf(result, "rmdir_husk", "run_rechusk").outcome, "removed");
  assert.ok(!existsSync(husk), "空壳已删除");
  assert.equal(result.recordsWriteFailed, true, "记录失败必须如实标记");
  assert.equal(result.preserveDir, null, "保全目录未建立");

  // CLI 合同：非零退出码、不打印"完成"、已删除部分照实列出。
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  let exitCodeSeen = null;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errors.push(a.join(" "));
  try {
    const husk2 = join(s.repo, ".wao-worktrees", "run_rechusk2");
    mkdirSync(husk2, { recursive: true });
    s.seed("run_rechusk2", cleanRunEvents({ repo: s.repo, wt: husk2, branch: null }));
    // 第二份计划须在归档月份目录可读时生成（生成后再占成文件，让记录落盘失败、
    // 删除已发生）。
    rmSync(archiveMonthFile, { force: true });
    const outPath2 = join(s.base, "plan2.json");
    const { planSha256: sha2 } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: outPath2, now: fixedNow });
    writeFileSync(archiveMonthFile, "not a directory\n", "utf8");
    await worktreeCommand(["reclaim", "--apply", outPath2, "--expect-sha256", sha2, "--run-dir", s.runDir], {});
    exitCodeSeen = process.exitCode;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExit;
  }
  assert.equal(exitCodeSeen, 1, "记录写失败必须以非零退出码结束");
  assert.ok(errors.some((l) => l.includes("记录写入失败")), "stderr 应说明记录写入失败");
  assert.ok(!logs.some((l) => l.includes("完成")), "不得打印完成");
  assert.ok(logs.some((l) => l.includes("run_rechusk2") && l.includes("removed")), "已删除部分照实列出");
});

test("apply：父子两树都回收 → 一轮 apply 清完（嵌套树不计入外树清单指纹）", async () => {
  const s = await scenario();
  const outer = s.wt("run_opar");
  const inner = join(outer, ".wao-worktrees", "run_oin");
  git(["worktree", "add", inner, "-b", "wao/run_oin"], s.repo);
  s.accepted("run_opar", outer);
  s.accepted("run_oin", inner);
  const { result } = await s.planAndApply();
  assert.ok(!result.refused, `不应拒绝：${result.refused}`);
  assert.equal(outcomeOf(result, "remove_tree", "run_oin").outcome, "removed");
  assert.equal(outcomeOf(result, "remove_tree", "run_opar").outcome, "removed", "内树删掉后外树指纹不得变化——一轮清完");
  assert.ok(!existsSync(inner));
  assert.ok(!existsSync(outer));
  assert.equal(git(["branch", "--list", "wao/*"], s.repo), "");
  // 逐类计数与 plan 同口径（按 runId 计）：两个回收 runId 各计一次。
  assert.equal(result.byCategory.reclaim, 2);
  assert.equal(result.byCategory.out_of_scope, 1);
});

test("apply：同一秒两次 apply → 保全目录换名，记录不互相覆盖", async () => {
  const s = await scenario();
  // 固定时刻须晚于种子事件的 OLD_TS（2026-01-01），否则事件落进 recent 窗。
  const FIXED = Date.parse("2027-01-01T00:00:00Z");
  const wtA = s.wt("run_s1");
  s.accepted("run_s1", wtA);
  const outA = join(s.base, "planA.json");
  const { planSha256: shaA } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: outA, now: () => FIXED });
  const r1 = await applyWorktreeReclaim({ planPath: outA, expectSha256: shaA, runDir: s.runDir, now: () => FIXED });

  const wtB = s.wt("run_s2");
  s.accepted("run_s2", wtB);
  const outB = join(s.base, "planB.json");
  const { planSha256: shaB } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: outB, now: () => FIXED });
  const r2 = await applyWorktreeReclaim({ planPath: outB, expectSha256: shaB, runDir: s.runDir, now: () => FIXED });

  assert.ok(!r1.refused && !r2.refused, `不应拒绝：${r1.refused ?? r2.refused}`);
  assert.notEqual(r1.preserveDir, r2.preserveDir, "同秒两次 apply 必须落到不同保全目录");
  assert.ok(existsSync(join(r1.preserveDir, "results.json")), "第一次的记录仍在");
  assert.ok(existsSync(join(r2.preserveDir, "results.json")), "第二次的记录独立落盘");
  assert.equal(readFileSync(join(r1.preserveDir, "bundle-sha256.txt"), "utf8").trim(), r1.bundleSha256, "第一次的 bundle sha 不被覆盖");
  const rec1 = JSON.parse(readFileSync(join(r1.preserveDir, "results.json"), "utf8"));
  assert.ok(rec1.results.some((r) => r.runId === "run_s1" && r.outcome === "removed"));
  const rec2 = JSON.parse(readFileSync(join(r2.preserveDir, "results.json"), "utf8"));
  assert.ok(rec2.results.some((r) => r.runId === "run_s2" && r.outcome === "removed"));
});

test("apply：成员转录批准后消失且仍有新鲜心跳 → 整树跳过（计划成员名单兜底）", async () => {
  const s = await scenario();
  const wt = s.wt("run_pm1");
  s.accepted("run_pm1", wt);
  const memberPath = s.seed("run_pm1_m", memberRunEvents({ repo: s.repo, wt, branch: "wao/run_pm1", rootRunId: "run_pm1", terminal: true }));
  const { result } = await s.planAndApply({
    mutate: async () => {
      rmSync(memberPath);
      // 成员转录没了，但成员仍有新鲜心跳：只看"当前声明这棵树的成员"会漏掉它
      //（apply 索引里已无此 runId），计划成员名单必须兜底。
      writeFileSync(join(s.runDir, ".owner-run_pm1_m"), JSON.stringify({ heartbeatAt: fixedNow() - 1000 }), "utf8");
    },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_pm1").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_pm1").reason, "running_now");
  assert.match(outcomeOf(result, "remove_tree", "run_pm1").detail ?? "", /run_pm1_m:fresh_owner_heartbeat/);
  assert.ok(existsSync(wt), "成员在跑时整树不动");
  assert.equal(outcomeOf(result, "delete_branch", "run_pm1").reason, "tree_not_removed");
});

test("apply：计划成员转录此刻缺失（无心跳）→ 按无法判定跳过整树", async () => {
  const s = await scenario();
  const wt = s.wt("run_pm2");
  s.accepted("run_pm2", wt);
  const memberPath = s.seed("run_pm2_m", memberRunEvents({ repo: s.repo, wt, branch: "wao/run_pm2", rootRunId: "run_pm2", terminal: true }));
  const { result } = await s.planAndApply({
    mutate: async () => { rmSync(memberPath); },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_pm2").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_pm2").reason, "undeterminable_now");
  assert.match(outcomeOf(result, "remove_tree", "run_pm2").detail ?? "", /run_pm2_m:transcript_missing_now/);
  assert.ok(existsSync(wt), "无法判定时整树不动");
});

test("apply：索引建好后成员新增 running 事件 → 删前现读发现，整树跳过", async () => {
  const s = await scenario();
  const wt = s.wt("run_fev");
  s.accepted("run_fev", wt);
  // 成员只经 run.started.worktreePath 绑定共享树（无线系绑定）：属主的线系
  // 枚举不包含它，只有逐成员复核的现读能发现它复活。
  const memberPath = s.seed("run_fev_m", [
    { type: "run.started", backend: "test", cwd: s.repo, worktreePath: wt, worktreeBranch: "wao/run_fev" },
    { type: "run.state_change", from: null, to: "running", reason: "spawned" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
  ]);
  // afterTranscriptIndex 缝：apply 的事实索引建好之后、摘树之前，在磁盘上给
  // 成员追加 running 事件——索引缓存看不到，删除前的逐成员现读必须看到。
  const { result } = await s.planAndApply({
    afterTranscriptIndex: async () => {
      appendFileSync(memberPath, `${JSON.stringify({
        ts: new Date(fixedNow()).toISOString(),
        seq: 99,
        runId: "run_fev_m",
        agentId: "coder_hq",
        type: "run.state_change",
        from: "completed",
        to: "running",
        reason: "resumed",
      })}\n`);
    },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_fev").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_fev").reason, "running_now");
  assert.match(outcomeOf(result, "remove_tree", "run_fev").detail ?? "", /run_fev_m:non_terminal/);
  assert.ok(existsSync(wt), "成员复活时整树不动");
  assert.equal(outcomeOf(result, "delete_branch", "run_fev").reason, "tree_not_removed");
});

test("apply：摘树后只清本次摘掉树的管理条目——其他条目（含进行中 add 的裸条目）原样保留", async () => {
  const s = await scenario();
  const wt = s.wt("run_ke");
  s.accepted("run_ke", wt);
  // 模拟另一会话 `git worktree add` 进行中：管理目录既无 locked 也无 gitdir——
  // 仓库级 prune 对这种条目无条件清掉（--expire 管不到），定向清理永不波及。
  const midAdd = join(s.repo, ".git", "worktrees", "run_adding_mid");
  mkdirSync(midAdd, { recursive: true });
  // 外部删除的 stale 登记（目录没了、登记还在）。
  const staleWt = s.wt("run_ke_stale");
  rmSync(staleWt, { recursive: true, force: true });

  const { result } = await s.planAndApply();

  assert.equal(outcomeOf(result, "remove_tree", "run_ke").outcome, "removed");
  const admins = readdirSync(join(s.repo, ".git", "worktrees"));
  assert.ok(!admins.includes("run_ke"), "本次摘掉的树的条目应清除");
  assert.ok(admins.includes("run_adding_mid"), "进行中 add 的裸条目必须原样保留");
  assert.ok(admins.includes("run_ke_stale"), "其他 stale 登记必须原样保留（无仓库级 prune）");
});

test("apply：索引建好后新出现一份转录声明这棵共享树、状态 running → 删前刷新发现，整树跳过", async () => {
  const s = await scenario();
  const wt = s.wt("run_nm");
  s.accepted("run_nm", wt);
  // 新成员的转录在 apply 索引建好之后才出现（afterTranscriptIndex 缝）：索引的
  // byDeclaredReal 里没有它，计划名单（批准时点）也没有它——只有删树前的增量
  // 刷新（新文件现读 → 重算声明绑定）能看到。
  const { result } = await s.planAndApply({
    afterTranscriptIndex: async () => {
      s.seed("run_nm_new", [
        { type: "run.started", backend: "test", cwd: s.repo, worktreePath: wt, worktreeBranch: "wao/run_nm" },
        { type: "run.state_change", from: null, to: "running", reason: "spawned" },
      ]);
    },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_nm").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_nm").reason, "running_now");
  assert.match(outcomeOf(result, "remove_tree", "run_nm").detail ?? "", /run_nm_new:non_terminal/);
  assert.ok(existsSync(wt), "新成员在跑时整树不动");
  assert.equal(outcomeOf(result, "delete_branch", "run_nm").reason, "tree_not_removed");
});

test("apply：索引建好后已有成员转录追加了绑定线系根的事件、成员仍在跑 → 线系枚举看到它，整树跳过", async () => {
  const s = await scenario();
  const wt = s.wt("run_lg");
  s.accepted("run_lg", wt);
  // run_lg_m2 在计划与索引时点都是无关的终态孤立运行（不声明这棵树）——属主
  // 的线系候选集里没有它。索引建好之后它的转录追加了绑定 run_lg 的事件并回到
  // running：删树前的增量刷新重算线系归属（byRoot），属主的线系枚举才看得到。
  const m2Path = s.seed("run_lg_m2", [
    { type: "run.started", backend: "test", cwd: s.repo, worktreePath: null, worktreeBranch: null },
    { type: "run.state_change", from: null, to: "running", reason: "spawned" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
  ]);
  const { result } = await s.planAndApply({
    afterTranscriptIndex: async () => {
      appendFileSync(m2Path, [
        { type: "run.session_reuse", rootRunId: "run_lg" },
        { type: "run.state_change", from: "completed", to: "running", reason: "resumed" },
      ].map((e) => JSON.stringify({
        ts: new Date(0).toISOString(), seq: 90 + 1, runId: "run_lg_m2", agentId: "coder_hq", ...e,
      })).map((l) => `${l}\n`).join(""), "utf8");
    },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_lg").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_lg").reason, "running_now");
  assert.match(outcomeOf(result, "remove_tree", "run_lg").detail ?? "", /run_lg:lineage_member_active/);
  assert.ok(existsSync(wt), "线系成员复活时整树不动");
  assert.equal(outcomeOf(result, "delete_branch", "run_lg").reason, "tree_not_removed");
});

test("apply：删分支阶段实时登记读取失败（注入缝）→ 无任何 update-ref -d，分支逐条跳过", async () => {
  const s = await scenario();
  const wt = s.wt("run_lr");
  s.accepted("run_lr", wt);
  const { execFileSync } = await import("node:child_process");
  const realPorcelain = () => execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: s.repo, encoding: "utf8", windowsHide: true,
  });
  const { result } = await s.planAndApply({
    // 摘树阶段的复核照常用真实登记；删分支阶段的读取注入 git 失败。
    worktreeListFn: (phase) => {
      if (phase === "branch_delete") throw new Error("injected git failure");
      return realPorcelain();
    },
  });
  assert.ok(!result.refused, `不应拒绝：${result.refused}`);
  assert.equal(outcomeOf(result, "remove_tree", "run_lr").outcome, "removed", "树照常摘除（与登记读取无关）");
  assert.equal(outcomeOf(result, "delete_branch", "run_lr").outcome, "skipped");
  assert.equal(outcomeOf(result, "delete_branch", "run_lr").reason, "live_registration_unreadable");
  assert.equal(result.liveRegistrationUnreadable, true, "结果里如实标记");
  assert.ok(git(["branch", "--list", "wao/run_lr"], s.repo).includes("run_lr"), "分支必须原样保留（零 update-ref -d）");
  // 记录落盘且含标记。
  const rec = JSON.parse(readFileSync(join(result.preserveDir, "results.json"), "utf8"));
  assert.equal(rec.liveRegistrationUnreadable, true);
});

test("apply CLI：实时登记读不出（真损坏：worktree 管理条目 commondir 失效）→ 分支全跳过，CLI 非零退出码", async () => {
  const s = await scenario();
  const wt = s.wt("run_lrc");
  s.accepted("run_lrc", wt);
  const outPath = join(s.base, "plan.json");
  const { planSha256 } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath, now: fixedNow });
  // 计划后把该树管理条目的 commondir 指到不存在的路径——`git worktree list
  // --porcelain` 从此 exit 128（实测行为）：摘树复核与删分支阶段的实时登记读
  // 取都失败，树与分支全部跳过，CLI 以非零退出码结束。
  writeFileSync(join(s.repo, ".git", "worktrees", "run_lrc", "commondir"), "C:/nonexistent-commondir/.git\n", "utf8");
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  let exitCodeSeen = null;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errors.push(a.join(" "));
  try {
    await worktreeCommand(["reclaim", "--apply", outPath, "--expect-sha256", planSha256, "--run-dir", s.runDir], {});
    exitCodeSeen = process.exitCode;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExit;
  }
  assert.equal(exitCodeSeen, 1, "实时登记读不出必须以非零退出码结束");
  assert.ok(errors.some((l) => l.includes("实时登记读取失败")), "stderr 应说明实时登记读不出");
  assert.ok(!logs.some((l) => l.trim().startsWith("[worktree reclaim] 完成")), "不得打印完成");
  assert.ok(logs.some((l) => l.includes("live_registration_unreadable")), "分支逐条记为跳过");
  assert.ok(existsSync(wt), "树不动");
  // commondir 失效后连 `git branch` 都会 fatal——用松散 ref 文件断言分支仍在。
  assert.ok(existsSync(join(s.repo, ".git", "refs", "heads", "wao", "run_lrc")), "分支不动");
});


test("apply：根 + 无独立条目的共享成员 → plan 与 apply 的分类计数相同（沿用计划 byCategory）", async () => {
  const s = await scenario();
  const wt = s.wt("run_cnt");
  // 根已裁决；成员经 session_reuse 绑进线系并声明共享树（无自有树/分支 → 无
  // 独立条目）。两者都终态、树干净 → 都归 reclaim：plan 按 runId 计 reclaim=2。
  s.accepted("run_cnt", wt);
  s.seed("run_cnt_m", memberRunEvents({ repo: s.repo, wt, branch: "wao/run_cnt", rootRunId: "run_cnt", terminal: true }));
  const outPath = join(s.base, "plan.json");
  const { plan, planSha256 } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath, now: fixedNow });
  assert.equal(plan.counts.byCategory.reclaim, 2, "前置：两个 runId 都归 reclaim（成员无独立条目）");
  assert.equal(plan.items.filter((i) => i.category === "reclaim").length, 2, "前置：条目只有根的 remove_tree + delete_branch");
  const result = await applyWorktreeReclaim({ planPath: outPath, expectSha256: planSha256, runDir: s.runDir, now: fixedNow });
  assert.ok(!result.refused, `不应拒绝：${result.refused}`);
  assert.deepEqual(result.byCategory, plan.counts.byCategory, "apply 的分类计数必须与计划相同（沿用计划文件）");
  assert.equal(result.executionCounts["remove_tree:removed"], 1);
  assert.equal(result.executionCounts["delete_branch:deleted"], 1);
  assert.ok(!existsSync(wt));
  assert.equal(git(["branch", "--list", "wao/run_cnt"], s.repo), "");

  // CLI 输出层：plan 与 apply 打印的分类计数行完全一致（同一口径——按 runId、
  // 沿用计划）；apply 另有按条目计的执行结果行。
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let applyCatLine = null;
  try {
    const wt2 = s.wt("run_cnt2");
    s.accepted("run_cnt2", wt2);
    s.seed("run_cnt2_m", memberRunEvents({ repo: s.repo, wt: wt2, branch: "wao/run_cnt2", rootRunId: "run_cnt2", terminal: true }));
    const out2 = join(s.base, "plan2.json");
    await worktreeCommand(["reclaim", "--cwd", s.repo, "--out", out2, "--run-dir", s.runDir], {});
    const planCatLine = logs.find((l) => l.includes("分类计数（按 runId"));
    await worktreeCommand(["reclaim", "--apply", out2, "--expect-sha256", shaOfPlan2(s), "--run-dir", s.runDir], {});
    applyCatLine = logs.find((l) => l.includes("分类计数（按 runId") && l !== planCatLine);
    assert.ok(planCatLine?.includes("reclaim=2"), `plan 行应含 reclaim=2：${planCatLine}`);
    // 标签各自写清口径（plan="按 runId，含无独立条目的共享成员"、apply="按
    // runId，沿用计划，含无独立条目的共享成员"），计数部分必须相同。
    assert.ok(applyCatLine?.includes("沿用计划"), `apply 行应标明沿用计划：${applyCatLine}`);
    assert.equal(
      applyCatLine?.split("）：")[1],
      planCatLine?.split("）：")[1],
      "plan 与 apply 输出的分类计数必须相同",
    );
    assert.ok(logs.some((l) => l.includes("执行结果（按条目计") && l.includes("remove_tree:removed=1")), "执行结果行按条目计");
  } finally {
    console.log = origLog;
  }
});

function shaOfPlan2(s) {
  return createHash("sha256").update(readFileSync(join(s.base, "plan2.json"))).digest("hex");
}

// ── 嵌套范围：关联工作树里的运行树（apply 面重证）──

test("apply：嵌套运行树清退——树删、分支删、bundle 可恢复、父工作树内容与登记不变", async () => {
  const s = await scenario();
  const dev = makeLinkedWorktree(s.repo, join(s.base, "devok"), "devok");
  commitIn(dev, "devwork.txt", "dev content\n");
  const wt = makeRunTreeIn(dev, "run_nested_ok");
  s.accepted("run_nested_ok", wt);
  const { result } = await s.planAndApply();
  assert.ok(!result.refused, `不应拒绝：${result.refused}`);
  assert.equal(outcomeOf(result, "remove_tree", "run_nested_ok").outcome, "removed");
  assert.equal(outcomeOf(result, "delete_branch", "run_nested_ok").outcome, "deleted");
  assert.ok(!existsSync(wt), "嵌套树应删除");
  assert.equal(git(["branch", "--list", "wao/run_nested_ok"], s.repo), "");
  // 父开发工作树的内容与登记不变。
  assert.equal(readFileSync(join(dev, "devwork.txt"), "utf8"), "dev content\n");
  const listed = git(["worktree", "list", "--porcelain"], s.repo).split(/\r?\n/).filter((l) => l.startsWith("worktree ")).join("\n").toLowerCase();
  assert.ok(listed.includes("devok"), "父开发工作树仍在册");
  assert.ok(git(["branch", "--list", "devok"], s.repo).includes("devok"), "父树分支不动");
  // bundle 里能恢复嵌套树的分支。
  const planItems = JSON.parse(readFileSync(join(s.base, "plan.json"), "utf8")).items;
  const branchItem = planItems.find((i) => i.action === "delete_branch" && i.runId === "run_nested_ok");
  const freshRepo = join(s.base, "restore-nested");
  mkdirSync(freshRepo, { recursive: true });
  git(["init", "-b", "main"], freshRepo);
  git(["fetch", result.bundlePath, `refs/heads/${branchItem.branch}:refs/heads/${branchItem.branch}`], freshRepo);
  assert.equal(git(["rev-parse", `refs/heads/${branchItem.branch}`], freshRepo), branchItem.branchTip, "嵌套树分支应能从 bundle 恢复到计划 tip");
});

test("apply：批准后父树登记消失（prune 形态）→ scope_parent_gone，树与分支保留", async () => {
  const s = await scenario();
  const dev = makeLinkedWorktree(s.repo, join(s.base, "devgone"), "devgone");
  const wt = makeRunTreeIn(dev, "run_pg");
  s.accepted("run_pg", wt);
  const { result } = await s.planAndApply({
    mutate: async () => {
      // 只删父树的管理登记（父树目录与嵌套树都还在盘上）：apply 重证时父树不在册。
      rmSync(join(s.repo, ".git", "worktrees", "devgone"), { recursive: true, force: true });
    },
  });
  assert.ok(!result.refused, `不应拒绝：${result.refused}`);
  assert.equal(outcomeOf(result, "remove_tree", "run_pg").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_pg").reason, "scope_parent_gone");
  assert.ok(existsSync(wt), "父树登记消失时嵌套树不动");
  assert.equal(outcomeOf(result, "delete_branch", "run_pg").outcome, "skipped");
  assert.ok(git(["branch", "--list", "wao/run_pg"], s.repo).length > 0, "分支必须保留");
});

test("apply：批准后父树换仓（.git 指向另一仓的 common dir）→ scope_common_dir_mismatch，树与分支保留", async () => {
  const s = await scenario();
  const dev = makeLinkedWorktree(s.repo, join(s.base, "devcc"), "devcc");
  const wt = makeRunTreeIn(dev, "run_cc");
  s.accepted("run_cc", wt);
  const { result } = await s.planAndApply({
    mutate: async () => {
      // 另一仓先备一个 worktree 管理条目，再把父树的 .git 指针改指过去：父树
      // 目录与登记都未动，但 common git dir 已不是本仓。
      const other = await makeRepo("wao-reclaim-cc2-");
      bases.push(other.repo);
      // 另一仓的关联工作树放在本用例自己的临时目录里，随 bases 一起清掉。
      const otherBase = await mkdtemp("wao-reclaim-cc2-wt-");
      bases.push(otherBase);
      const owt = makeLinkedWorktree(other.repo, join(otherBase, "owt"), "ow");
      // 指针指向另一仓真实存在的管理目录：common dir 读得出来，只是不属于本仓——
      // 走的是"读出另一个 common dir"那条拒绝，而不是"读不出"。
      const otherGitDir = git(["rev-parse", "--absolute-git-dir"], owt).trim();
      // worktree 的 .git 指针文件带 Hidden 属性（chmod 清不掉）：unlink 后重建。
      rmSync(join(dev, ".git"), { force: true });
      writeFileSync(join(dev, ".git"), `gitdir: ${otherGitDir.replace(/\\/g, "/")}\n`, "utf8");
    },
  });
  assert.ok(!result.refused, `不应拒绝：${result.refused}`);
  assert.equal(outcomeOf(result, "remove_tree", "run_cc").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_cc").reason, "scope_common_dir_mismatch");
  assert.ok(existsSync(wt), "父树换仓时嵌套树不动");
  assert.ok(git(["branch", "--list", "wao/run_cc"], s.repo).length > 0, "分支必须保留");
});

test("apply：批准后中间级换成 junction → scope_symlink_now，树与分支保留（不跟随链接）", async () => {
  const s = await scenario();
  const dev = makeLinkedWorktree(s.repo, join(s.base, "devmid"), "devmid");
  const wt = makeRunTreeIn(dev, "run_mid");
  s.accepted("run_mid", wt);
  const { result } = await s.planAndApply({
    mutate: async () => {
      // 把 .wao-worktrees 整体挪走后用 junction 顶替：目标的 raw 路径仍可解析，
      // 但从父树根到目标的中间一级已是链接。
      renameSync(join(dev, ".wao-worktrees"), join(s.base, "devmid-store"));
      symlinkSync(join(s.base, "devmid-store"), join(dev, ".wao-worktrees"), "junction");
    },
  });
  assert.ok(!result.refused, `不应拒绝：${result.refused}`);
  assert.equal(outcomeOf(result, "remove_tree", "run_mid").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_mid").reason, "scope_symlink_now");
  assert.ok(existsSync(wt), "中间级是链接时嵌套树不动");
  assert.equal(outcomeOf(result, "delete_branch", "run_mid").outcome, "skipped");
  assert.ok(git(["branch", "--list", "wao/run_mid"], s.repo).length > 0, "分支必须保留");
});

test("apply：旧形状计划（嵌套项无范围证明字段）→ scope_proof_missing，不动", async () => {
  const s = await scenario();
  const dev = makeLinkedWorktree(s.repo, join(s.base, "devold"), "devold");
  const wt = makeRunTreeIn(dev, "run_oldshape");
  s.accepted("run_oldshape", wt);
  const outPath = join(s.base, "plan.json");
  const { planSha256 } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath, now: fixedNow });
  void planSha256;
  // 模拟旧形状计划：去掉嵌套项的范围证明字段，按新字节重算 sha（审阅的
  // 就是这份字节），apply 不得因为换了新代码就自动扩域。
  const plan = JSON.parse(readFileSync(outPath, "utf8"));
  for (const item of plan.items) {
    delete item.scopeRoot;
    delete item.scopeGitCommonDir;
  }
  const bytes = Buffer.from(JSON.stringify(plan, null, 2) + "\n", "utf8");
  writeFileSync(outPath, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const result = await applyWorktreeReclaim({ planPath: outPath, expectSha256: sha, runDir: s.runDir, now: fixedNow });
  assert.ok(!result.refused, `不应拒绝：${result.refused}`);
  assert.equal(outcomeOf(result, "remove_tree", "run_oldshape").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_oldshape").reason, "scope_proof_missing");
  assert.ok(existsSync(wt), "无范围证明的嵌套项不动");
  assert.equal(outcomeOf(result, "delete_branch", "run_oldshape").outcome, "skipped");
  assert.equal(outcomeOf(result, "delete_branch", "run_oldshape").reason, "tree_not_removed");
  assert.ok(git(["branch", "--list", "wao/run_oldshape"], s.repo).length > 0, "分支必须保留");
});

test("apply：嵌套树批准后内容变化 → content_changed 跳过（销毁门与主根同套）", async () => {
  const s = await scenario();
  const dev = makeLinkedWorktree(s.repo, join(s.base, "devchg"), "devchg");
  const wt = makeRunTreeIn(dev, "run_nchg");
  s.accepted("run_nchg", wt);
  const { result } = await s.planAndApply({
    mutate: async () => { writeFileSync(join(wt, "untracked-new.txt"), "x\n", "utf8"); },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_nchg").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_nchg").reason, "content_changed");
  assert.ok(existsSync(wt));
  assert.equal(outcomeOf(result, "delete_branch", "run_nchg").reason, "tree_not_removed");
});

test("apply：嵌套空壳带范围证明照常删除；父工作树不动", async () => {
  const s = await scenario();
  const dev = makeLinkedWorktree(s.repo, join(s.base, "devhusk2"), "devhusk2");
  const husk = join(dev, ".wao-worktrees", "run_husk_apply");
  mkdirSync(husk, { recursive: true });
  s.seed("run_husk_apply", cleanRunEvents({ repo: dev, wt: husk, branch: null }));
  const { result } = await s.planAndApply();
  assert.ok(!result.refused, `不应拒绝：${result.refused}`);
  assert.equal(outcomeOf(result, "rmdir_husk", "run_husk_apply").outcome, "removed");
  assert.ok(!existsSync(husk), "嵌套空壳应删除");
  assert.ok(existsSync(dev) && existsSync(join(dev, "a.txt")), "父工作树不动");
});


test("apply：孪生副本平铺有刚发生的绑定事件、归档较旧、两份都是 completed → 判为在跑（recent_event），树不删", async () => {
  const s = await scenario();
  const wt = s.wt("run_tw4");
  const flatPath = s.accepted("run_tw4", wt);
  const original = readFileSync(flatPath, "utf8");
  const { result } = await s.planAndApply({
    mutate: async () => {
      // 平铺副本追加刚发生的事件（completed→running→completed，ts=现在）；
      // 归档副本是追加前的旧内容（较旧事件在"后"也不能盖住它）。
      appendFileSync(flatPath, [
        { type: "run.state_change", from: "completed", to: "running", reason: "resumed" },
        { type: "run.state_change", from: "running", to: "completed", reason: "done" },
      ].map((e) => JSON.stringify({
        ts: new Date(fixedNow() - 1000).toISOString(), seq: 80 + 1, runId: "run_tw4", agentId: "coder_hq", ...e,
      })).map((l) => `${l}\n`).join(""), "utf8");
      s.seed("run_tw4", [], { archiveMonth: "2026-01" });
      writeFileSync(join(dirname(s.runDir), "runs-archive", "2026-01", "run_tw4.jsonl"), original, "utf8");
    },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_tw4").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_tw4").reason, "running_now");
  assert.match(outcomeOf(result, "remove_tree", "run_tw4").detail ?? "", /run_tw4:recent_event/);
  assert.ok(existsSync(wt), "平铺副本的近期事件必须触发 15 分钟保护");
});

// ── 第 133 批：执行门与计划共用"跳过 Lead 记账事件"的近期活动取时 ──

/** 计划批准后往转录尾部追加"刚发生"的事件行（envelope 同 seedTranscript）。 */
function appendFreshEvents(path, runId, events) {
  appendFileSync(path, events.map((e, i) => JSON.stringify({
    ts: new Date(fixedNow() - 1000).toISOString(), seq: 90 + i, runId, agentId: "coder_hq", ...e,
  })).map((l) => `${l}\n`).join(""), "utf8");
}

test("apply（第 133 批）：批准后追加 Lead 记账事件（裁决/放树/收集/谱系关闭）→ 执行门不拦，树与分支照删", async () => {
  const s = await scenario();
  const wt = s.wt("run_bk_apply");
  const p = s.accepted("run_bk_apply", wt);
  const { result } = await s.planAndApply({
    mutate: async () => {
      appendFreshEvents(p, "run_bk_apply", [
        { type: "run.worktree_released" },
        { type: "messages.collected" },
        { type: "run.lineage_closed", rootRunId: "run_bk_apply" },
      ]);
    },
  });
  assert.ok(!result.refused, `不应拒绝：${result.refused}`);
  assert.equal(outcomeOf(result, "remove_tree", "run_bk_apply").outcome, "removed",
    "记账事件不重置窗口，执行门放行");
  assert.equal(outcomeOf(result, "delete_branch", "run_bk_apply").outcome, "deleted");
  assert.ok(!existsSync(wt), "树应删除");
});

test("apply（第 133 批）反例：批准后追加 run.delivery_repackage_rejected → 执行门仍按 recent_event 拦下", async () => {
  const s = await scenario();
  const wt = s.wt("run_bk_rp");
  const p = s.accepted("run_bk_rp", wt);
  const { result } = await s.planAndApply({
    mutate: async () => {
      appendFreshEvents(p, "run_bk_rp", [
        { type: "run.delivery_repackage_rejected", rejectionReason: "disallowed_path" },
      ]);
    },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_bk_rp").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_bk_rp").reason, "running_now");
  assert.match(outcomeOf(result, "remove_tree", "run_bk_rp").detail ?? "", /run_bk_rp:recent_event/);
  assert.ok(existsSync(wt), "重新打包被拒（补救中）必须触发 15 分钟保护");
});

// ── sol 会审 1/3：收口门与"只剩分支"删除路径 ──

test("apply（sol 会审 1）：批准后事实变为验证 pending + 已拒收（前台形状，事件都早于窗口）→ 执行门按收口拦下，树不删", async () => {
  const s = await scenario();
  const wt = s.wt("run_fg2");
  const p = s.accepted("run_fg2", wt);
  const { result } = await s.planAndApply({
    mutate: async () => {
      // 重写为前台拒收形状：created 声明验证 pending、已拒收、终态，全部落在
      // OLD_TS——近期窗口不触发，拦下的必须是收口门而不是时间窗。
      const created = verifiedDeliveryRef("run_fg2", { baseCommit: s.mainCommit, verificationStatus: "pending" });
      const rejected = verifiedDeliveryRef("run_fg2", { baseCommit: s.mainCommit, acceptance: "rejected", verificationStatus: "pending" });
      writeFileSync(p, [
        { type: "run.started", backend: "test", cwd: s.repo, worktreePath: wt, worktreeBranch: "wao/run_fg2", delivery: { mode: "git_commit_v1", baseCommit: s.mainCommit } },
        { type: "run.state_change", from: null, to: "running", reason: "spawned" },
        { type: "run.delivery_created", delivery: created },
        { type: "run.state_change", from: "running", to: "completed", reason: "done" },
        { type: "run.delivery_rejected", delivery: rejected, deliveryCommit: created.deliveryCommit, reason: "reject" },
      ].map((e, i) => JSON.stringify({ ts: OLD_TS, seq: i + 1, runId: "run_fg2", agentId: "coder_hq", ...e })).join("\n") + "\n", "utf8");
    },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_fg2").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_fg2").reason, "running_now");
  assert.match(outcomeOf(result, "remove_tree", "run_fg2").detail ?? "", /run_fg2:delivery_unsettled:verification_pending/);
  assert.ok(existsSync(wt), "验证未收口（可能在机器验证闸前排队、无心跳）必须保留");
});

test("apply（sol 会审 3）：只剩分支的运行——批准后追加 run.delivery_repackage_rejected → 删 ref 前被拦下", async () => {
  const s = await scenario();
  // 树早已自动释放、只剩分支的旧运行形态：建分支不建树。
  git(["branch", "wao/run_bo1", s.mainCommit], s.repo);
  s.seed("run_bo1", decidedRunEvents({ repo: s.repo, wt: null, branch: "wao/run_bo1", baseCommit: s.mainCommit, decision: "accepted" }));
  const { result } = await s.planAndApply({
    mutate: async () => {
      appendFreshEvents(join(s.runDir, "run_bo1.jsonl"), "run_bo1", [
        { type: "run.delivery_repackage_rejected", rejectionReason: "disallowed_path" },
      ]);
    },
  });
  assert.equal(outcomeOf(result, "delete_branch", "run_bo1").outcome, "skipped");
  assert.equal(outcomeOf(result, "delete_branch", "run_bo1").reason, "running_now",
    "分支路径删 ref 前同样复核近期活动（此前只有成员门）");
  assert.match(outcomeOf(result, "delete_branch", "run_bo1").detail ?? "", /run_bo1:recent_event/);
  assert.ok(git(["branch", "--list", "wao/run_bo1"], s.repo).length > 0, "ref 保留");
});

test("apply（sol 会审 1×3）：只剩分支的运行——批准后落盘 pending 的补验证请求（事件早于窗口）→ 删 ref 前被收口门拦下", async () => {
  const s = await scenario();
  git(["branch", "wao/run_bo2", s.mainCommit], s.repo);
  s.seed("run_bo2", decidedRunEvents({ repo: s.repo, wt: null, branch: "wao/run_bo2", baseCommit: s.mainCommit, decision: "accepted" }));
  const { result } = await s.planAndApply({
    mutate: async () => {
      // ts 用 OLD_TS：近期窗口不触发，证明拦下的是收口判定。
      const created = verifiedDeliveryRef("run_bo2", { baseCommit: s.mainCommit });
      appendFileSync(join(s.runDir, "run_bo2.jsonl"), [
        { type: "run.delivery_reverification_requested", delivery: created, deliveryCommit: created.deliveryCommit, reason: "tooling_invalid" },
      ].map((e) => JSON.stringify({ ts: OLD_TS, seq: 90, runId: "run_bo2", agentId: "coder_hq", ...e })).map((l) => `${l}\n`).join(""), "utf8");
    },
  });
  assert.equal(outcomeOf(result, "delete_branch", "run_bo2").outcome, "skipped");
  assert.equal(outcomeOf(result, "delete_branch", "run_bo2").reason, "running_now");
  assert.match(outcomeOf(result, "delete_branch", "run_bo2").detail ?? "", /run_bo2:delivery_unsettled:reverify_pending/);
  assert.ok(git(["branch", "--list", "wao/run_bo2"], s.repo).length > 0, "ref 保留");
});

test("apply（sol 复核 1）：计划同时含摘树与删分支、执行前树与登记已不在——批后追加 run.lead_commit_check_started → ref 保留", async () => {
  const s = await scenario();
  const wt = s.wt("run_vcy");
  const p = s.accepted("run_vcy", wt);
  const { result } = await s.planAndApply({
    mutate: async () => {
      // 形态：runs verify-commit 在独立 detached 树里核验，原工作树及其 Git 登记
      // 被正常移除（分支与 tip 保留），核验 started 落在 15 分钟窗口内。
      git(["worktree", "remove", "--force", wt], s.repo);
      appendFreshEvents(p, "run_vcy", [
        { type: "run.lead_commit_check_started", checkId: "c9", commit: "c".repeat(40), commands: ["npm test"] },
      ]);
    },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_vcy").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_vcy").reason, "tree_missing");
  const br = outcomeOf(result, "delete_branch", "run_vcy");
  assert.equal(br.outcome, "skipped", "摘树复核因 tree_missing 提前返回，分支不得继承未跑完的复核");
  assert.equal(br.reason, "running_now", "核验还在跑（started 在窗口内）→ 活动门拦下");
  assert.match(br.detail ?? "", /run_vcy:recent_event/);
  assert.ok(git(["branch", "--list", "wao/run_vcy"], s.repo).length > 0, "ref 保留");
});

test("apply（sol 复核 2）：孪生副本两份相同的 pending 转录——收口按副本各判，任一 unsettled 即保留", async () => {
  const s = await scenario();
  const wt = s.wt("run_tw_pend");
  const p = s.accepted("run_tw_pend", wt);
  const { result } = await s.planAndApply({
    mutate: async () => {
      // 两份内容相同的前台拒收形状副本（平铺 + 归档），全部 OLD_TS：拼接判会把
      // 两条 delivery_created 读成 malformed 而漏放行——按副本各判则各自
      // verification_pending。
      const created = verifiedDeliveryRef("run_tw_pend", { baseCommit: s.mainCommit, verificationStatus: "pending" });
      const rejected = verifiedDeliveryRef("run_tw_pend", { baseCommit: s.mainCommit, acceptance: "rejected", verificationStatus: "pending" });
      const lines = [
        { type: "run.started", backend: "test", cwd: s.repo, worktreePath: wt, worktreeBranch: "wao/run_tw_pend", delivery: { mode: "git_commit_v1", baseCommit: s.mainCommit } },
        { type: "run.state_change", from: null, to: "running", reason: "spawned" },
        { type: "run.delivery_created", delivery: created },
        { type: "run.state_change", from: "running", to: "completed", reason: "done" },
        { type: "run.delivery_rejected", delivery: rejected, deliveryCommit: created.deliveryCommit, reason: "reject" },
      ].map((e, i) => JSON.stringify({ ts: OLD_TS, seq: i + 1, runId: "run_tw_pend", agentId: "coder_hq", ...e })).join("\n") + "\n";
      writeFileSync(p, lines, "utf8");
      s.seed("run_tw_pend", [], { archiveMonth: "2026-01" });
      writeFileSync(join(dirname(s.runDir), "runs-archive", "2026-01", "run_tw_pend.jsonl"), lines, "utf8");
    },
  });
  assert.equal(outcomeOf(result, "remove_tree", "run_tw_pend").outcome, "skipped");
  assert.equal(outcomeOf(result, "remove_tree", "run_tw_pend").reason, "running_now");
  assert.match(outcomeOf(result, "remove_tree", "run_tw_pend").detail ?? "", /run_tw_pend:delivery_unsettled:verification_pending/);
  assert.ok(existsSync(wt), "孪生 pending 副本不能因拼接判 malformed 而放行删除");
});

test("apply：批准后树目录被外部删除（登记残留）→ 那棵树跳过、记录落盘、CLI 非零退出码", async () => {
  const s = await scenario();
  const wtA = s.wt("run_gone6");
  const wtB = s.wt("run_alive6");
  s.accepted("run_gone6", wtA);
  s.accepted("run_alive6", wtB);
  const outPath = join(s.base, "plan.json");
  const { planSha256 } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath, now: fixedNow });
  rmSync(wtA, { recursive: true, force: true }); // 目录缺失的登记
  const result = await applyWorktreeReclaim({ planPath: outPath, expectSha256: planSha256, runDir: s.runDir, now: fixedNow });
  assert.ok(!result.refused, `不应拒绝：${result.refused}`);
  assert.equal(outcomeOf(result, "remove_tree", "run_gone6").reason, "tree_missing");
  assert.equal(outcomeOf(result, "delete_branch", "run_gone6").reason, "registration_stale");
  // 正常树照常回收。
  assert.equal(outcomeOf(result, "remove_tree", "run_alive6").outcome, "removed");
  assert.equal(outcomeOf(result, "delete_branch", "run_alive6").outcome, "deleted");
  // 记录落盘（含 stale 登记上报）。
  const rec = JSON.parse(readFileSync(join(result.preserveDir, "results.json"), "utf8"));
  assert.ok(rec.results.some((r) => r.runId === "run_alive6" && r.outcome === "removed"), "已删除部分入记录");
  assert.ok(rec.staleRegistrations.some((p) => p.toLowerCase().includes("run_gone6")), "stale 登记入记录");

  // CLI 合同：发现目录缺失的登记 → 非零退出码 + stderr 说明（再造一个场景）。
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  let exitCodeSeen = null;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errors.push(a.join(" "));
  try {
    const wtC = s.wt("run_gone6c");
    s.accepted("run_gone6c", wtC);
    const outPath2 = join(s.base, "plan2.json");
    const { planSha256: sha2 } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: outPath2, now: fixedNow });
    rmSync(wtC, { recursive: true, force: true });
    await worktreeCommand(["reclaim", "--apply", outPath2, "--expect-sha256", sha2, "--run-dir", s.runDir], {});
    exitCodeSeen = process.exitCode;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExit;
  }
  assert.equal(exitCodeSeen, 1, "发现 stale 登记必须以非零退出码结束");
  assert.ok(errors.some((l) => l.includes("目录缺失的在册登记")), "stderr 应说明 stale 登记");
  assert.ok(!logs.some((l) => l.trim().startsWith("[worktree reclaim] 完成")), "有异常面时不得打印完成");
});
