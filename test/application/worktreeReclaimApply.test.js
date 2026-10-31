// test/application/worktreeReclaimApply.test.js
//
// `wao worktree reclaim --apply` 执行面测试：计划绑定拒绝（仓库身份/保全目
// 录/bundle 失败）、批准后变化的逐项跳过（指纹四件套各一）、执行保全与删除
// 语义（bundle 覆盖恢复、ref CAS、摘树失败不删分支、记录落盘）。全部用真
// git 临时仓 + 临时 run 目录，从不触碰真实仓库。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { planWorktreeReclaim, applyWorktreeReclaim } from "../../src/application/worktreeReclaim.js";
import { worktreeCommand } from "../../src/commands/worktree.js";

import {
  git, makeRepo, mkdtemp, makeWorktree, makeLinkedWorktree, makeRunTreeIn, commitIn, seedTranscript,
  cleanRunEvents, decidedRunEvents, memberRunEvents, cleanupDir, fixedNow,
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

test("apply：最终记录写失败 → 如实标记，CLI 非零退出码且不打印完成（删除照实列出）", async () => {
  const s = await scenario();
  // 只含空壳回收的计划：无 bundle、无快照，保全目录只在记录落盘时创建——
  // runs-archive 是文件时记录必失败，而删除已发生。
  const husk = join(s.repo, ".wao-worktrees", "run_rechusk");
  mkdirSync(husk, { recursive: true });
  s.seed("run_rechusk", cleanRunEvents({ repo: s.repo, wt: husk, branch: null }));
  const outPath = join(s.base, "plan.json");
  const { planSha256 } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath, now: fixedNow });
  writeFileSync(join(dirname(s.runDir), "runs-archive"), "not a directory\n", "utf8");
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
    // 第二份计划须在归档根可读时生成（读不出会把计划整体毒化）；生成后再占
    // 成文件，让记录落盘失败、删除已发生。
    rmSync(join(dirname(s.runDir), "runs-archive"), { force: true });
    const outPath2 = join(s.base, "plan2.json");
    const { planSha256: sha2 } = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, outPath: outPath2, now: fixedNow });
    writeFileSync(join(dirname(s.runDir), "runs-archive"), "not a directory\n", "utf8");
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
