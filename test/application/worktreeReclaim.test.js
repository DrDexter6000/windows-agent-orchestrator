// test/application/worktreeReclaim.test.js
//
// `wao worktree reclaim` 计划面测试：分类闭集与求值顺序、计划绑定拒绝、
// dry-run 零改动、CLI 适配。全部用真 git 临时仓 + 临时 run 目录（os.tmpdir
// 下），从不指向仓库相对 runs/，也从不触碰真实仓库。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { symlinkSync } from "node:fs";

import {
  planWorktreeReclaim, computeTreeFingerprint, untrackedIgnoredManifest,
} from "../../src/application/worktreeReclaim.js";
import { worktreeCommand } from "../../src/commands/worktree.js";

import {
  git, makeRepo, mkdtemp, makeWorktree, commitIn, seedTranscript,
  cleanRunEvents, decidedRunEvents, memberRunEvents, cleanupDir, fixedNow, OLD_TS,
} from "../_worktreeReclaimHarness.mjs";

const bases = [];
before(() => {});
after(async () => {
  for (const b of bases) await cleanupDir(b);
});

/** 一条与普查目标无关的终态转录：让转录库非空（8c 拒绝只针对空库）。 */
function seedLibraryDummy(s) {
  s.seed("run_dummy_lib", [
    { type: "run.state_change", from: null, to: "completed", reason: "done" },
  ]);
}

/** 一个场景：自己的 repo + 自己的 runDir（避免跨场景转录污染线系枚举）。 */
async function scenario(prefix = "wao-reclaim-plan-") {
  const base = await mkdtemp(prefix);
  bases.push(base);
  const { repo, mainCommit } = await makeRepo(prefix);
  // makeRepo 在自己的 mkdtemp 下建仓；把 repo 挪进 base 由调用方管理太绕——
  // 直接让 repo 就是这个临时目录（makeRepo 返回的即是独立目录）。
  const runDir = join(base, "runs");
  mkdirSync(runDir, { recursive: true });
  return {
    base, repo, mainCommit, runDir,
    wt(runId) { return makeWorktree(repo, runId); },
    seed(runId, events, where) { return seedTranscript(runDir, runId, events, where); },
    async plan(opts = {}) {
      return planWorktreeReclaim({ repoCwd: repo, runDir, now: fixedNow, ...opts });
    },
  };
}

function itemsOf(plan, runId) {
  return plan.items.filter((i) => i.runId === runId);
}
function oneItem(plan, runId) {
  const items = itemsOf(plan, runId);
  assert.ok(items.length > 0, `plan 应含 ${runId} 的条目`);
  return items[0];
}

test("分类：源工作树本身 → out_of_scope/source_worktree", async () => {
  const s = await scenario();
  const { plan } = await s.plan();
  const mainItem = oneItem(plan, s.repo.split(/[\\/]/).pop());
  assert.equal(mainItem.action, "keep");
  assert.equal(mainItem.reason, "source_worktree");
});

test("分类：仓外路径的 worktree → out_of_scope/outside_worktrees_dir", async () => {
  const s = await scenario();
  const outside = join(s.base, "elsewhere", "run_out");
  git(["worktree", "add", outside, "-b", "wao/run_out"], s.repo);
  s.seed("run_out", cleanRunEvents({ repo: s.repo, wt: outside, branch: "wao/run_out" }));
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_out");
  assert.equal(item.action, "keep");
  assert.equal(item.reason, "outside_worktrees_dir");
});

test("分类：未登记的 junction → out_of_scope/symlink_or_junction（不跟随）", async () => {
  const s = await scenario();
  const target = join(s.base, "junction-target");
  mkdirSync(target, { recursive: true });
  mkdirSync(join(s.repo, ".wao-worktrees"), { recursive: true });
  symlinkSync(target, join(s.repo, ".wao-worktrees", "run_jx"), "junction");
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_jx");
  assert.equal(item.action, "keep");
  assert.equal(item.reason, "symlink_or_junction");
});

test("分类：外仓 worktree 的空壳 → out_of_scope/foreign_worktree", async () => {
  const s = await scenario();
  seedLibraryDummy(s); // 转录库非空：空库+树目标会整体拒绝（8c）
  const other = await makeRepo("wao-reclaim-foreign-");
  bases.push(other.repo);
  git(["worktree", "add", join(s.repo, ".wao-worktrees", "run_fo"), "-b", "wao/run_fo"], other.repo);
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_fo");
  assert.equal(item.action, "keep");
  assert.equal(item.reason, "foreign_worktree");
});

test("分类：转录损坏 → undeterminable，且优先于回收类（已 accepted 也不回收）", async () => {
  const s = await scenario();
  const wt = s.wt("run_corr");
  const p = s.seed("run_corr", decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_corr", baseCommit: s.mainCommit, decision: "accepted",
  }));
  writeFileSync(p, "{ this is not jsonl\n", "utf8");
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_corr");
  assert.equal(item.category, "undeterminable");
  assert.equal(item.reason, "transcript_unreadable");
  assert.equal(item.action, "keep");
  assert.equal(itemsOf(plan, "run_corr").filter((i) => i.action === "remove_tree").length, 0);
});

test("分类：twin 转录 → undeterminable/twin_transcripts", async () => {
  const s = await scenario();
  const wt = s.wt("run_tw");
  const events = decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_tw", baseCommit: s.mainCommit, decision: "accepted",
  });
  s.seed("run_tw", events);
  s.seed("run_tw", events, { bucket: "projx" });
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_tw");
  assert.equal(item.category, "undeterminable");
  assert.equal(item.reason, "twin_transcripts");
});

test("分类：非终态 → running/non_terminal", async () => {
  const s = await scenario();
  const wt = s.wt("run_nt");
  s.seed("run_nt", [
    { type: "run.started", backend: "test", cwd: s.repo, worktreePath: wt, worktreeBranch: "wao/run_nt" },
    { type: "run.state_change", from: null, to: "running", reason: "spawned" },
  ]);
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_nt");
  assert.equal(item.category, "running");
  assert.equal(item.reason, "non_terminal");
  assert.equal(item.action, "keep");
});

test("分类：最后一条绑定事件 15 分钟内 → running/recent_event", async () => {
  const s = await scenario();
  const wt = s.wt("run_rec");
  s.seed("run_rec", cleanRunEvents({ repo: s.repo, wt, branch: "wao/run_rec" })
    .map((e) => (e.type === "run.state_change" && e.to === "completed" ? null : e))
    .filter(Boolean)
    .concat([{ type: "run.state_change", from: "running", to: "completed", reason: "done", ts: new Date(fixedNow() - 30_000).toISOString() }]));
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_rec");
  assert.equal(item.reason, "recent_event");
});

test("分类：新鲜 owner 心跳 → running/fresh_owner_heartbeat", async () => {
  const s = await scenario();
  const wt = s.wt("run_hb");
  s.seed("run_hb", cleanRunEvents({ repo: s.repo, wt, branch: "wao/run_hb" }));
  writeFileSync(join(s.runDir, ".owner-run_hb"), JSON.stringify({ heartbeatAt: fixedNow() - 1000 }), "utf8");
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_hb");
  assert.equal(item.reason, "fresh_owner_heartbeat");
});

test("分类：线系成员非终态 → reuse_open/lineage_member_active（共享树）", async () => {
  const s = await scenario();
  const wt = s.wt("run_root1");
  s.seed("run_root1", cleanRunEvents({ repo: s.repo, wt, branch: "wao/run_root1" }));
  s.seed("run_mem1", memberRunEvents({ repo: s.repo, wt, branch: "wao/run_root1", rootRunId: "run_root1", terminal: false }));
  const { plan } = await s.plan();
  assert.equal(oneItem(plan, "run_root1").reason, "lineage_member_active");
  assert.equal(itemsOf(plan, "run_root1").filter((i) => i.action === "remove_tree").length, 0);
});

test("分类：槽目录新鲜认领 → reuse_open/slot_claim_fresh", async () => {
  const s = await scenario();
  const wt = s.wt("run_root2");
  s.seed("run_root2", cleanRunEvents({ repo: s.repo, wt, branch: "wao/run_root2" }));
  s.seed("run_mem2", memberRunEvents({ repo: s.repo, wt, branch: "wao/run_root2", rootRunId: "run_root2" }));
  const slotDir = join(s.runDir, ".lineage-reuse");
  mkdirSync(slotDir, { recursive: true });
  writeFileSync(join(slotDir, "k.json"), JSON.stringify({ runId: "run_mem2", updatedAt: fixedNow() - 1000 }), "utf8");
  const { plan } = await s.plan();
  assert.equal(oneItem(plan, "run_root2").reason, "slot_claim_fresh");
});

test("分类：线系未闭未收 → reuse_open/lineage_not_closed", async () => {
  const s = await scenario();
  const wt = s.wt("run_root3");
  s.seed("run_root3", cleanRunEvents({ repo: s.repo, wt, branch: "wao/run_root3" }));
  s.seed("run_mem3", memberRunEvents({ repo: s.repo, wt, branch: "wao/run_root3", rootRunId: "run_root3" }));
  const { plan } = await s.plan();
  assert.equal(oneItem(plan, "run_root3").category, "reuse_open");
  assert.equal(oneItem(plan, "run_root3").reason, "lineage_not_closed");
});

test("分类：已打包未裁决 → pending_lead/delivery_packaged_undecided", async () => {
  const s = await scenario();
  const wt = s.wt("run_pk");
  s.seed("run_pk", [
    { type: "run.started", backend: "test", cwd: s.repo, worktreePath: wt, worktreeBranch: "wao/run_pk", delivery: { mode: "git_commit_v1", baseCommit: s.mainCommit } },
    { type: "run.state_change", from: null, to: "running", reason: "spawned" },
    { type: "run.delivery_created" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
  ]);
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_pk");
  assert.equal(item.category, "pending_lead");
  assert.equal(item.reason, "delivery_packaged_undecided");
});

test("分类：未裁决且树脏 → pending_lead/undecided_dirty_tree", async () => {
  const s = await scenario();
  const wt = s.wt("run_ud");
  writeFileSync(join(wt, "uncommitted.txt"), "dirty\n", "utf8");
  s.seed("run_ud", cleanRunEvents({ repo: s.repo, wt, branch: "wao/run_ud" }));
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_ud");
  assert.equal(item.category, "pending_lead");
  assert.equal(item.reason, "undecided_dirty_tree");
});

test("分界：未裁决脏树保留；线系已关后脏树回收并标注丢弃", async () => {
  const s = await scenario();
  const wtA = s.wt("run_line_a");
  writeFileSync(join(wtA, "uncommitted.txt"), "dirty\n", "utf8");
  s.seed("run_line_a", [
    ...cleanRunEvents({ repo: s.repo, wt: wtA, branch: "wao/run_line_a" }),
    { type: "run.lineage_closed", rootRunId: "run_line_a" },
  ]);
  const { plan } = await s.plan();
  const tree = itemsOf(plan, "run_line_a").find((i) => i.action === "remove_tree");
  assert.ok(tree, "线系已关的脏树应回收");
  assert.ok(tree.notes.includes("脏树：删除即丢弃未提交内容"));
});

test("分类：共享树有一个成员保留 → 整树保留 tree_shared/shared_tree_kept", async () => {
  const s = await scenario();
  const wt = s.wt("run_root4");
  writeFileSync(join(wt, "uncommitted.txt"), "dirty\n", "utf8");
  s.seed("run_root4", decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_root4", baseCommit: s.mainCommit, decision: "accepted",
  }));
  // 成员未裁决且树脏（同一棵树）→ 成员 pending_lead，根 reclaim 候选被树共享挡下。
  s.seed("run_mem4", memberRunEvents({ repo: s.repo, wt, branch: "wao/run_root4", rootRunId: "run_root4" }));
  const { plan } = await s.plan();
  assert.equal(oneItem(plan, "run_mem4").reason, "undecided_dirty_tree");
  assert.equal(oneItem(plan, "run_root4").category, "tree_shared");
  assert.equal(oneItem(plan, "run_root4").reason, "shared_tree_kept");
  assert.equal(itemsOf(plan, "run_root4").filter((i) => i.action === "remove_tree").length, 0);
});

test("分类：分支 tip 短 SHA 被引用 → owner_nomination/referenced_short_sha", async () => {
  const s = await scenario();
  const wt = s.wt("run_ref");
  const sha = commitIn(wt, "feature.txt", "x\n");
  s.seed("run_ref", decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_ref", baseCommit: s.mainCommit, decision: "accepted",
  }));
  writeFileSync(join(s.repo, "docs", "decision-proof.md"), `钉住 ${sha.slice(0, 7)} 不变。\n`, "utf8");
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_ref");
  assert.equal(item.category, "owner_nomination");
  assert.equal(item.reason, "referenced_short_sha");
});

test("分类：只有分支没有树、三处无转录且未并入 → owner_nomination/transcript_missing_unmerged；--include 点名豁免", async () => {
  const s = await scenario();
  seedLibraryDummy(s);
  // 孤立提交：先借一棵临时树造提交，再把树与临时分支清掉，只留 wao/run_nom。
  const tmpWt = s.wt("run_nom_work");
  const orphan = commitIn(tmpWt, "orphan.txt", "x\n");
  git(["worktree", "remove", "--force", tmpWt], s.repo);
  git(["branch", "-D", "wao/run_nom_work"], s.repo);
  git(["branch", "wao/run_nom", orphan], s.repo);
  // 无转录（run_nom 无树无转录）。
  const plain = await s.plan();
  assert.equal(oneItem(plain.plan, "run_nom").reason, "transcript_missing_unmerged");
  assert.equal(oneItem(plain.plan, "run_nom").action, "keep");

  const named = await s.plan({ includeRunIds: ["run_nom"] });
  const branch = itemsOf(named.plan, "run_nom").find((i) => i.action === "delete_branch");
  assert.ok(branch, "点名后应回收分支");
  assert.deepEqual(branch.notes, ["Owner 点名"]);
});

test("分类：有树但三处无转录 → undeterminable/transcript_missing（刚开跑形态不落回收类；--include 不豁免）", async () => {
  const s = await scenario();
  seedLibraryDummy(s);
  // 刚开跑、树还干净、tip==main 的形态：转录缺失曾被当成可回收，拆掉在跑
  // worker 的工作目录——现在一律归无法判定并保留。
  const wt = s.wt("run_fresh");
  const plain = await s.plan();
  const item = oneItem(plain.plan, "run_fresh");
  assert.equal(item.category, "undeterminable");
  assert.equal(item.reason, "transcript_missing");
  assert.equal(item.action, "keep");
  assert.equal(itemsOf(plain.plan, "run_fresh").filter((i) => i.action === "remove_tree").length, 0);
  // Owner 点名豁免的是第 6 类；缺转录的事实缺口点不出事实来。
  const named = await s.plan({ includeRunIds: ["run_fresh"] });
  assert.equal(oneItem(named.plan, "run_fresh").reason, "transcript_missing");
  assert.equal(itemsOf(named.plan, "run_fresh").filter((i) => i.action === "remove_tree").length, 0);
});

test("分类：detached HEAD + 新提交（计划前切）→ tree_protection/head_drift", async () => {
  const s = await scenario();
  const wt = s.wt("run_hd");
  git(["checkout", "--detach", "HEAD"], wt);
  commitIn(wt, "drift.txt", "x\n");
  s.seed("run_hd", decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_hd", baseCommit: s.mainCommit, decision: "accepted",
  }));
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_hd");
  assert.equal(item.category, "tree_protection");
  assert.equal(item.reason, "head_drift");
});

test("分类：嵌套保护 → tree_protection/has_kept_descendant", async () => {
  const s = await scenario();
  const outer = s.wt("run_outer");
  const inner = join(outer, ".wao-worktrees", "run_inner");
  git(["worktree", "add", inner, "-b", "wao/run_inner"], s.repo);
  s.seed("run_outer", decidedRunEvents({
    repo: s.repo, wt: outer, branch: "wao/run_outer", baseCommit: s.mainCommit, decision: "accepted",
  }));
  s.seed("run_inner", [
    { type: "run.started", backend: "test", cwd: s.repo, worktreePath: inner, worktreeBranch: "wao/run_inner" },
    { type: "run.state_change", from: null, to: "running", reason: "spawned" },
  ]);
  const { plan } = await s.plan();
  assert.equal(oneItem(plan, "run_outer").reason, "has_kept_descendant");
  assert.equal(oneItem(plan, "run_inner").reason, "non_terminal");
});

test("回收：已裁决（accepted/rejected）→ remove_tree + delete_branch + 信息字段", async () => {
  const s = await scenario();
  const wtA = s.wt("run_ok_a");
  const wtR = s.wt("run_ok_r");
  s.seed("run_ok_a", decidedRunEvents({
    repo: s.repo, wt: wtA, branch: "wao/run_ok_a", baseCommit: s.mainCommit, decision: "accepted",
  }));
  s.seed("run_ok_r", decidedRunEvents({
    repo: s.repo, wt: wtR, branch: "wao/run_ok_r", baseCommit: s.mainCommit, decision: "rejected",
  }));
  const { plan, planSha256 } = await s.plan();
  for (const runId of ["run_ok_a", "run_ok_r"]) {
    const tree = itemsOf(plan, runId).find((i) => i.action === "remove_tree");
    const branch = itemsOf(plan, runId).find((i) => i.action === "delete_branch");
    assert.ok(tree && branch, `${runId} 应有 remove_tree + delete_branch`);
    assert.equal(tree.category, "reclaim");
    assert.ok(tree.fingerprint.head && tree.fingerprint.worktreeDiffSha256
      && tree.fingerprint.indexDiffSha256 && tree.fingerprint.untrackedIgnoredManifestSha256);
    assert.ok(branch.info && typeof branch.info.mergedIntoMain === "boolean"
      && typeof branch.info.cherryPlus === "number"
      && typeof branch.info.uniqueCommitsVsKept === "number");
  }
  assert.match(planSha256, /^[0-9a-f]{64}$/);
  assert.equal(plan.repo.mainBranch, "main");
  assert.ok(plan.generatedAt);
});

test("回收：未裁决但树完全干净 → reclaim", async () => {
  const s = await scenario();
  const wt = s.wt("run_clean");
  s.seed("run_clean", cleanRunEvents({ repo: s.repo, wt, branch: "wao/run_clean" }));
  const { plan } = await s.plan();
  assert.ok(itemsOf(plan, "run_clean").some((i) => i.action === "remove_tree"));
  assert.ok(itemsOf(plan, "run_clean").some((i) => i.action === "delete_branch"));
});

test("空壳：空目录 → rmdir_husk；非空目录 → keep（undecided_dirty_tree / husk_not_empty）", async () => {
  const s = await scenario();
  seedLibraryDummy(s);
  const emptyHusk = join(s.repo, ".wao-worktrees", "run_husk_empty");
  mkdirSync(emptyHusk, { recursive: true });
  const nonEmpty = join(s.repo, ".wao-worktrees", "run_husk_full");
  mkdirSync(nonEmpty, { recursive: true });
  writeFileSync(join(nonEmpty, "leftover.txt"), "x\n", "utf8");
  // 无转录的空壳现在归 undeterminable/transcript_missing；有种子的按原语义判。
  s.seed("run_husk_empty", cleanRunEvents({ repo: s.repo, wt: emptyHusk, branch: null }));
  s.seed("run_husk_full", cleanRunEvents({ repo: s.repo, wt: nonEmpty, branch: null }));
  const { plan } = await s.plan();
  assert.equal(oneItem(plan, "run_husk_empty").action, "rmdir_husk");
  assert.equal(oneItem(plan, "run_husk_full").reason, "undecided_dirty_tree");

  // 已裁决 run 的非空空壳 → 不满足第 8 类空判据 → keep/tree_protection+husk_not_empty
  //（不再记成 reclaim 类，计数不虚高）。
  const decidedFull = join(s.repo, ".wao-worktrees", "run_husk_dec");
  mkdirSync(decidedFull, { recursive: true });
  writeFileSync(join(decidedFull, "leftover.txt"), "x\n", "utf8");
  s.seed("run_husk_dec", decidedRunEvents({
    repo: s.repo, wt: decidedFull, branch: null, baseCommit: s.mainCommit, decision: "rejected",
  }));
  git(["branch", "wao/run_husk_dec"], s.repo); // 分支存在但树不登记（空壳）
  const plan2 = await planWorktreeReclaim({ repoCwd: s.repo, runDir: s.runDir, now: fixedNow });
  const huskItem = plan2.plan.items.find((i) => i.runId === "run_husk_dec" && i.action === "keep");
  assert.ok(huskItem, "已裁决 run 的非空空壳应保留");
  assert.equal(huskItem.reason, "husk_not_empty");
  assert.equal(huskItem.category, "tree_protection", "非空空壳的保留不再计入 reclaim");
  assert.equal(plan2.plan.counts.byCategory.reclaim, 1, "reclaim 计数只含真正的回收项（空壳 rmdir）");
});

test("归档转录参与分类：只存在于 runs-archive/ 的 accepted run → reclaim", async () => {
  const s = await scenario();
  const wt = s.wt("run_arch");
  s.seed("run_arch", decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_arch", baseCommit: s.mainCommit, decision: "accepted",
  }), { archiveMonth: "2026-09" });
  const { plan } = await s.plan();
  assert.ok(itemsOf(plan, "run_arch").some((i) => i.action === "remove_tree"), "归档转录应被读到并判为已裁决");
});

test("归档转录参与成员枚举：归档成员非终态 → 根 reuse_open", async () => {
  const s = await scenario();
  const wt = s.wt("run_root5");
  s.seed("run_root5", cleanRunEvents({ repo: s.repo, wt, branch: "wao/run_root5" }));
  // 成员只在归档里，且非终态——枚举不到就会误回收根的树。
  s.seed("run_mem5", memberRunEvents({
    repo: s.repo, wt, branch: "wao/run_root5", rootRunId: "run_root5", terminal: false,
  }), { archiveMonth: "2026-09" });
  const { plan } = await s.plan();
  assert.equal(oneItem(plan, "run_root5").reason, "lineage_member_active");
  assert.equal(itemsOf(plan, "run_root5").filter((i) => i.action === "remove_tree").length, 0);
});

test("计划绑定：--expect-sha256 不符 → 整体拒绝，零删除", async () => {
  const s = await scenario();
  const wt = s.wt("run_bind");
  s.seed("run_bind", decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_bind", baseCommit: s.mainCommit, decision: "accepted",
  }));
  const outPath = join(s.base, "plan.json");
  const { planSha256 } = await s.plan({ outPath });
  const { applyWorktreeReclaim } = await import("../../src/application/worktreeReclaim.js");
  // 构造一个必然不同的 sha（末位翻转）。
  const flipped = planSha256.slice(0, 63) + (planSha256[63] === "0" ? "1" : "0");
  const result = await applyWorktreeReclaim({
    planPath: outPath, expectSha256: flipped, runDir: s.runDir,
  });
  assert.equal(result.refused, "sha_mismatch");
  assert.ok(existsSync(wt), "拒绝后树不动");
  assert.ok(git(["for-each-ref", "--format=%(refname:short)", "refs/heads/wao/"], s.repo).includes("wao/run_bind"));
});

test("dry-run：计划生成零改动（分支/树指纹/转录字节/索引文件）", async () => {
  const s = await scenario();
  const wt = s.wt("run_dry");
  writeFileSync(join(wt, "wip.txt"), "wip\n", "utf8");
  mkdirSync(join(wt, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(wt, "node_modules", "pkg", "data.bin"), "binary\n", "utf8");
  s.seed("run_dry", decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_dry", baseCommit: s.mainCommit, decision: "accepted",
  }));
  const transcriptPath = join(s.runDir, "run_dry.jsonl");

  const before = {
    refs: git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"], s.repo),
    fingerprint: JSON.stringify(await computeTreeFingerprint(wt)),
    transcript: readFileSync(transcriptPath, "utf8"),
    indexes: snapshotIndexes(s.repo),
    worktreeFiles: readdirSync(wt).sort().join(","),
  };
  const outPath = join(s.base, "plan-dry.json");
  await s.plan({ outPath });
  const after = {
    refs: git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"], s.repo),
    fingerprint: JSON.stringify(await computeTreeFingerprint(wt)),
    transcript: readFileSync(transcriptPath, "utf8"),
    indexes: snapshotIndexes(s.repo),
    worktreeFiles: readdirSync(wt).sort().join(","),
  };
  assert.deepEqual(after, before, "计划生成（dry-run）不得改动任何 git/转录状态");
});

function snapshotIndexes(repo) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.name === "index" && name.isFile()) out[prefix + name.name] = readFileSync(p).toString("base64");
      else if (name.isDirectory()) walk(p, `${prefix}${name.name}/`);
    }
  };
  walk(join(repo, ".git", "worktrees"), "");
  out["main-index"] = readFileSync(join(repo, ".git", "index")).toString("base64");
  return out;
}

test("CLI：worktree reclaim 计划模式打印 sha256 并写文件；--apply 缺 --expect-sha256 报错", async () => {
  const s = await scenario();
  const outPath = join(s.base, "plan-cli.json");
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    await worktreeCommand(["reclaim", "--cwd", s.repo, "--out", outPath, "--run-dir", s.runDir], { runDir: s.runDir });
  } finally {
    console.log = origLog;
  }
  assert.ok(existsSync(outPath), "计划文件应写出");
  const shaLine = logs.find((l) => l.includes("sha256"));
  assert.ok(shaLine, "应打印计划 sha256");
  const printed = shaLine.match(/[0-9a-f]{64}/)?.[0];
  const { createHash } = await import("node:crypto");
  const fileSha = createHash("sha256").update(readFileSync(outPath)).digest("hex");
  assert.equal(printed, fileSha, "打印的 sha256 应绑定写出的计划文件字节");

  await assert.rejects(
    () => worktreeCommand(["reclaim", "--apply", outPath], { runDir: s.runDir }),
    /--expect-sha256/,
  );
});

test("CLI：未知子命令报错列出新子命令", async () => {
  await assert.rejects(
    () => worktreeCommand(["frobnicate"], {}),
    /list \| remove \| reclaim/,
  );
});

test("分类：孪生成员（无自有树/分支、终态相同）绑定共享树 → 整树保留", async () => {
  const s = await scenario();
  const wt = s.wt("run_twroot");
  s.seed("run_twroot", decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_twroot", baseCommit: s.mainCommit, decision: "accepted",
  }));
  const events = memberRunEvents({ repo: s.repo, wt, branch: "wao/run_twroot", rootRunId: "run_twroot", terminal: true });
  s.seed("run_twmem", events);
  s.seed("run_twmem", events, { bucket: "projx" });
  const { plan } = await s.plan();
  // 孪生成员归 undeterminable；路径绑定发生在保留判定之前，整树分组看得到
  // 这个成员——属主树连带保留，不再生成删除动作。
  assert.equal(oneItem(plan, "run_twmem").category, "undeterminable");
  assert.equal(oneItem(plan, "run_twmem").reason, "twin_transcripts");
  assert.equal(oneItem(plan, "run_twroot").category, "tree_shared");
  assert.equal(oneItem(plan, "run_twroot").reason, "shared_tree_kept");
  assert.equal(itemsOf(plan, "run_twroot").filter((i) => i.action === "remove_tree").length, 0);
});

test("分类：已并入 main 且 tip 被引用 → 照常回收（引用检查只对未并入分支）", async () => {
  const s = await scenario();
  seedLibraryDummy(s);
  // 分支指在 main 提交上（已并入），tip 短 SHA 被 docs 引用——只读评审运行形态。
  git(["branch", "wao/run_mrg", s.mainCommit], s.repo);
  writeFileSync(join(s.repo, "docs", "review-note.md"), `评审基线 ${s.mainCommit.slice(0, 7)}。\n`, "utf8");
  const { plan } = await s.plan();
  const mergedItem = oneItem(plan, "run_mrg");
  assert.equal(mergedItem.category, "reclaim");
  assert.equal(mergedItem.action, "delete_branch");

  // 对照：未并入且 tip 被引用 → 照旧 owner_nomination（要 Owner 点名）。
  const wt = s.wt("run_unm");
  const sha = commitIn(wt, "feature.txt", "x\n");
  git(["worktree", "remove", "--force", wt], s.repo); // 只留分支
  writeFileSync(join(s.repo, "docs", "feature-note.md"), `钉住 ${sha.slice(0, 7)}。\n`, "utf8");
  const plan2 = await s.plan();
  assert.equal(oneItem(plan2.plan, "run_unm").category, "owner_nomination");
  assert.equal(oneItem(plan2.plan, "run_unm").reason, "referenced_short_sha");
});

test("拒绝：转录库为空且普查到树目标 → 整体拒绝；只有分支没有树不触发", async () => {
  const s = await scenario();
  const emptyRunDir = join(s.base, "empty-runs");
  mkdirSync(emptyRunDir, { recursive: true });
  s.wt("run_never"); // 树目标 + 空转录库
  await assert.rejects(
    () => s.plan({ runDir: emptyRunDir }),
    /--run-dir/,
  );
  // 分支-only 目标不受空库拒绝（并入与否是 git 事实，不依赖转录）。
  const s2 = await scenario();
  const emptyRunDir2 = join(s2.base, "empty-runs");
  mkdirSync(emptyRunDir2, { recursive: true });
  git(["branch", "wao/run_bo", s2.mainCommit], s2.repo);
  const { plan } = await s2.plan({ runDir: emptyRunDir2 });
  assert.equal(oneItem(plan, "run_bo").action, "delete_branch");
});

test("CLI：不传 --run-dir 时运行目录缺省取安装根（WAO_INSTALL_ROOT）", async () => {
  const s = await scenario();
  const install = join(s.base, "install-root");
  mkdirSync(join(install, "runs"), { recursive: true });
  const outPath = join(s.base, "plan-installroot.json");
  const prev = process.env.WAO_INSTALL_ROOT;
  process.env.WAO_INSTALL_ROOT = install;
  try {
    await worktreeCommand(["reclaim", "--cwd", s.repo, "--out", outPath], {});
  } finally {
    if (prev === undefined) delete process.env.WAO_INSTALL_ROOT;
    else process.env.WAO_INSTALL_ROOT = prev;
  }
  const plan = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(plan.runDir, join(install, "runs"), "缺省运行目录应锚在安装根，不在进程当前目录");
});

test("CLI：--include=<id> 等号写法生效（不再静默忽略）", async () => {
  const s = await scenario();
  seedLibraryDummy(s);
  const tmpWt = s.wt("run_incl_work");
  const orphan = commitIn(tmpWt, "orphan.txt", "x\n");
  git(["worktree", "remove", "--force", tmpWt], s.repo);
  git(["branch", "-D", "wao/run_incl_work"], s.repo);
  git(["branch", "wao/run_incl", orphan], s.repo);
  const outPath = join(s.base, "plan-incl-eq.json");
  await worktreeCommand(["reclaim", "--cwd", s.repo, "--out", outPath, "--include=run_incl", "--run-dir", s.runDir], {});
  const plan = JSON.parse(readFileSync(outPath, "utf8"));
  assert.deepEqual(plan.include, ["run_incl"], "--include= 等号写法应被收进点名名单");
  const branch = plan.items.find((i) => i.runId === "run_incl" && i.action === "delete_branch");
  assert.ok(branch, "点名后分支应回收");
  assert.ok(branch.notes.includes("Owner 点名"));
});

test("分类：引用文本读不出（注入缝，无独占锁）→ 已并入分支照常回收；未并入分支 undeterminable/reference_scan_failed", async () => {
  const s = await scenario();
  // 已并入分支（tip = main 提交，只读评审形态）：引用检查对它不生效，扫描失败
  // 也不受影响（第 7 条：先判并入，再看扫描）。
  git(["branch", "wao/run_mrg_rf", s.mainCommit], s.repo);
  // 未并入分支：需要引用证据，扫描失败 → 无法断言"未被引用" → 无法判定保留。
  const wt = s.wt("run_rf");
  commitIn(wt, "feature.txt", "x\n");
  s.seed("run_rf", decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_rf", baseCommit: s.mainCommit, decision: "accepted",
  }));
  const doc = join(s.repo, "docs", "locked.md");
  writeFileSync(doc, "x\n", "utf8");
  const scanIo = {
    lstatSync,
    readdirSync,
    readFileSync: (p, enc) => {
      if (p === doc) {
        const err = new Error("injected read failure");
        err.code = "EBUSY";
        throw err;
      }
      return readFileSync(p, enc);
    },
  };
  const { plan } = await s.plan({ referenceScanIo: scanIo });
  assert.equal(oneItem(plan, "run_mrg_rf").category, "reclaim", "已并入分支不需要引用检查");
  const item = oneItem(plan, "run_rf");
  assert.equal(item.category, "undeterminable");
  assert.equal(item.reason, "reference_scan_failed");
  assert.equal(item.action, "keep");
  assert.equal(itemsOf(plan, "run_rf").filter((i) => i.action === "remove_tree").length, 0);
});

test("分类：归档枚举 skipped（归档里的符号链接）→ 线系枚举拒绝，undeterminable/lineage_refused", async () => {
  const s = await scenario();
  const wt = s.wt("run_ask");
  s.seed("run_ask", decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_ask", baseCommit: s.mainCommit, decision: "accepted",
  }));
  // 归档月份里放一个符号链接转录：枚举面读不干净，成员集不再可信。
  const archDir = join(s.base, "runs-archive", "2026-09");
  mkdirSync(archDir, { recursive: true });
  symlinkSync("C:/nowhere-run-ask", join(archDir, "run_ask_link.jsonl"), "file");
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_ask");
  assert.equal(item.category, "undeterminable");
  assert.equal(item.reason, "lineage_refused");
  assert.match(item.detail ?? "", /archive_enumeration_skipped/);
});

test("清单指纹：lstat/readdir 读不出 → 抛错（读不出就保留，不静默漏项）", async () => {
  const dir = await mkdtemp("wao-manifest-");
  bases.push(dir);
  writeFileSync(join(dir, "a.txt"), "x\n");
  // record 指向不存在的路径 → lstat ENOENT → 抛错。
  assert.throws(
    () => untrackedIgnoredManifest(dir, [{ x: "?", y: "?", path: "missing.txt" }]),
    /lstat failed/,
  );
  // 目录遍历读不出（注入缝）→ 抛错。
  mkdirSync(join(dir, "sub"), { recursive: true });
  assert.throws(
    () => untrackedIgnoredManifest(dir, [{ x: "?", y: "?", path: "sub" }], [], {
      readdirSync: () => { throw new Error("boom"); },
      lstatSync,
    }),
    /readdir failed/,
  );
});

test("清单指纹：在册嵌套 worktree 子树不计入外树清单（嵌套一轮清完的前提）", async () => {
  const dir = await mkdtemp("wao-manifest-");
  bases.push(dir);
  mkdirSync(join(dir, "inner"), { recursive: true });
  writeFileSync(join(dir, "inner", "deep.txt"), "x\n");
  const withoutExcl = untrackedIgnoredManifest(dir, [{ x: "?", y: "?", path: "inner" }]);
  assert.ok(withoutExcl.length > 0, "无排除时清单含嵌套树内容");
  const withExcl = untrackedIgnoredManifest(dir, [{ x: "?", y: "?", path: "inner" }], ["inner"]);
  assert.equal(withExcl.length, 0, "排除后清单不含嵌套树内容");
  // 防御分支：record 落在嵌套树内部也按祖先前缀排除。
  const nestedRecord = untrackedIgnoredManifest(dir, [{ x: "?", y: "?", path: "inner/deep.txt" }], ["inner"]);
  assert.equal(nestedRecord.length, 0);
});

test("计划：remove_tree 条目记录共享树当时的全部成员（treeMembers）", async () => {
  const s = await scenario();
  const wt = s.wt("run_tmem");
  s.seed("run_tmem", decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_tmem", baseCommit: s.mainCommit, decision: "accepted",
  }));
  s.seed("run_tmem_m", memberRunEvents({ repo: s.repo, wt, branch: "wao/run_tmem", rootRunId: "run_tmem", terminal: true }));
  const { plan } = await s.plan();
  const tree = itemsOf(plan, "run_tmem").find((i) => i.action === "remove_tree");
  assert.ok(tree, "应有 remove_tree 条目");
  assert.deepEqual(tree.treeMembers, ["run_tmem", "run_tmem_m"], "成员名单=属主+当时声明绑定到这棵树的全部 runId");
});

test("毒化局部化：无关线系有孪生冲突 → 正常线系照常回收；冲突线系 undeterminable/lineage_refused", async () => {
  const s = await scenario();
  // 无关的正常线系：已裁决、树干净 → 回收。
  const wtA = s.wt("run_norm");
  s.seed("run_norm", decidedRunEvents({
    repo: s.repo, wt: wtA, branch: "wao/run_norm", baseCommit: s.mainCommit, decision: "accepted",
  }));
  // 冲突线系：成员 run_twcp 的孪生转录状态不一致（一份 completed、一份 running），
  // 且两份都声明绑定 run_twroot 的线系与同一棵树。
  const wtB = s.wt("run_twroot");
  s.seed("run_twroot", decidedRunEvents({
    repo: s.repo, wt: wtB, branch: "wao/run_twroot", baseCommit: s.mainCommit, decision: "accepted",
  }));
  const memberBase = memberRunEvents({ repo: s.repo, wt: wtB, branch: "wao/run_twroot", rootRunId: "run_twroot", terminal: true });
  s.seed("run_twcp", memberBase);
  const diverged = memberBase.map((e) => (e.type === "run.state_change" && e.to === "completed"
    ? { type: "run.state_change", from: "running", to: "running", reason: "still" }
    : e));
  s.seed("run_twcp", diverged, { bucket: "projx" });
  // 自有分支让 run_twcp 成为普查目标（线系枚举拒绝时成员不入列，普查面直接
  // 分类它）。
  git(["branch", "wao/run_twcp", s.mainCommit], s.repo);
  const { plan } = await s.plan();
  // 冲突成员自身：twin_transcripts；其线系根：枚举拒绝（候选集含该孪生）。
  assert.equal(oneItem(plan, "run_twcp").category, "undeterminable");
  assert.equal(oneItem(plan, "run_twcp").reason, "twin_transcripts");
  const rootItem = oneItem(plan, "run_twroot");
  assert.equal(rootItem.category, "undeterminable", "冲突线系的根应无法判定");
  assert.equal(rootItem.reason, "lineage_refused");
  assert.match(rootItem.detail ?? "", /twin_state_mismatch:run_twcp/);
  assert.equal(itemsOf(plan, "run_twroot").filter((i) => i.action === "remove_tree").length, 0, "冲突线系的树不删");
  // 无关线系不受牵连（不再全局毒化）。
  assert.ok(itemsOf(plan, "run_norm").some((i) => i.action === "remove_tree"), "无关线系照常回收");
});

test("归档根目录读不出（runs-archive 是文件）→ 相关项 undeterminable/lineage_refused，不当成归档为空", async () => {
  const s = await scenario();
  const wt = s.wt("run_archroot");
  s.seed("run_archroot", decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_archroot", baseCommit: s.mainCommit, decision: "accepted",
  }));
  writeFileSync(join(s.base, "runs-archive"), "not a directory\n", "utf8");
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_archroot");
  assert.equal(item.category, "undeterminable");
  assert.equal(item.reason, "lineage_refused");
  assert.match(item.detail ?? "", /archive_enumeration_skipped/);
  assert.equal(itemsOf(plan, "run_archroot").filter((i) => i.action === "remove_tree").length, 0);
});

test("分类：登记指向的目录已不存在 → undeterminable/registered_missing，计划不崩", async () => {
  const s = await scenario();
  const wt = s.wt("run_gone_dir");
  s.seed("run_gone_dir", decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_gone_dir", baseCommit: s.mainCommit, decision: "accepted",
  }));
  // 批准前树目录被外部删掉（登记还在）：plan 的 realpath 崩溃面由此复现。
  rmSync(wt, { recursive: true, force: true });
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_gone_dir");
  assert.equal(item.category, "undeterminable");
  assert.equal(item.reason, "registered_missing");
  assert.equal(item.action, "keep");
  assert.equal(itemsOf(plan, "run_gone_dir").filter((i) => i.action === "remove_tree").length, 0);
});

test("CLI：显式相对 --run-dir 按进程当前目录解析（不被锚到安装根）", async () => {
  const s = await scenario();
  const install = join(s.base, "install-root2");
  mkdirSync(join(install, "rel-runs"), { recursive: true });
  // 当前目录与安装根下各放一个同名的相对运行目录，显式 --run-dir rel-runs 只该命中前者。
  const cwdRuns = join(s.base, "cwdroot", "rel-runs");
  mkdirSync(cwdRuns, { recursive: true });
  const outPath = join(s.base, "plan-rundir.json");
  const prev = process.env.WAO_INSTALL_ROOT;
  process.env.WAO_INSTALL_ROOT = install;
  const prevCwd = process.cwd();
  let plan;
  try {
    process.chdir(join(s.base, "cwdroot"));
    await worktreeCommand(["reclaim", "--cwd", s.repo, "--out", outPath, "--run-dir", "rel-runs"], {});
    plan = JSON.parse(readFileSync(outPath, "utf8"));
  } finally {
    process.chdir(prevCwd);
    if (prev === undefined) delete process.env.WAO_INSTALL_ROOT;
    else process.env.WAO_INSTALL_ROOT = prev;
  }
  assert.equal(plan.runDir, cwdRuns, "显式相对 --run-dir 应按进程当前目录解析");
});

test("计划条目：保留与回收条目都带审批事实（决定/终态/转录位置）；CLI 逐条打印回收项", async () => {
  const s = await scenario();
  seedLibraryDummy(s);
  // 回收项 1：已裁决 run（决定=accepted、终态=completed、转录在 runs/ 平铺）。
  const wtAcc = s.wt("run_f6a");
  s.seed("run_f6a", decidedRunEvents({
    repo: s.repo, wt: wtAcc, branch: "wao/run_f6a", baseCommit: s.mainCommit, decision: "accepted",
  }));
  // 回收项 2：未裁决干净 run（决定=none）+ 转录在 projects 桶。
  const wtClean = s.wt("run_f6b");
  s.seed("run_f6b", cleanRunEvents({ repo: s.repo, wt: wtClean, branch: "wao/run_f6b" }), { bucket: "demo" });
  // 回收项 3：空壳（转录在归档）。
  const husk = join(s.repo, ".wao-worktrees", "run_f6c");
  mkdirSync(husk, { recursive: true });
  s.seed("run_f6c", cleanRunEvents({ repo: s.repo, wt: husk, branch: null }), { archiveMonth: "2026-09" });
  // 保留项：孪生转录（平铺+归档两份、终态相同）→ keep，决定/终态缺席（不可
  // 知），但转录位置两处都在场。
  const wtTwin = s.wt("run_f6d");
  s.seed("run_f6d", decidedRunEvents({
    repo: s.repo, wt: wtTwin, branch: "wao/run_f6d", baseCommit: s.mainCommit, decision: "rejected",
  }));
  s.seed("run_f6d", decidedRunEvents({
    repo: s.repo, wt: wtTwin, branch: "wao/run_f6d", baseCommit: s.mainCommit, decision: "rejected",
  }), { archiveMonth: "2026-09" });

  const outPath = join(s.base, "plan-f6.json");
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let plan;
  try {
    await worktreeCommand(["reclaim", "--cwd", s.repo, "--out", outPath, "--run-dir", s.runDir], {});
    plan = JSON.parse(readFileSync(outPath, "utf8"));
  } finally {
    console.log = origLog;
  }

  const accItems = itemsOf(plan, "run_f6a");
  assert.equal(accItems.length, 2, "remove_tree + delete_branch 两条目");
  for (const item of accItems) {
    assert.deepEqual(item.facts, { lastDecision: "accepted", terminalState: "completed", transcriptLocations: ["flat"] });
  }
  assert.deepEqual(oneItem(plan, "run_f6b").facts, {
    lastDecision: "none", terminalState: "completed", transcriptLocations: ["projects"],
  });
  assert.deepEqual(oneItem(plan, "run_f6c").facts, {
    lastDecision: "none", terminalState: "completed", transcriptLocations: ["archive"],
  });
  const twinItem = oneItem(plan, "run_f6d");
  assert.equal(twinItem.action, "keep");
  assert.equal(twinItem.category, "undeterminable");
  assert.deepEqual(twinItem.facts, { transcriptLocations: ["archive", "flat"] }, "孪生：决定/终态缺席，位置恒在场");

  // CLI 逐条打印回收项：runId、决定、终态、转录位置、已并入、cherry、脏树标注。
  const reclaimLines = logs.filter((l) => l.trimStart().startsWith("回收 "));
  const lineOf = (id) => reclaimLines.find((l) => l.includes(` ${id}  `));
  assert.ok(reclaimLines.length >= 3, `应逐条打印回收项（实际 ${reclaimLines.length} 行）`);
  assert.match(lineOf("run_f6a"), /决定=accepted/);
  assert.match(lineOf("run_f6a"), /终态=completed/);
  assert.match(lineOf("run_f6a"), /转录=flat/);
  assert.match(lineOf("run_f6a"), /已并入=(是|否)/);
  assert.match(lineOf("run_f6a"), /cherry\+=\d+/);
  assert.match(lineOf("run_f6b"), /决定=none/);
  assert.match(lineOf("run_f6b"), /转录=projects/);
  assert.match(lineOf("run_f6c"), /转录=archive/);
  assert.ok(!lineOf("run_f6d"), "保留项不进回收项打印");
  // 脏树标注：run_f6a 树脏时打印丢弃标注。
  const reclaimIds = reclaimLines.map((l) => l.trim().split(/\s+/)[1]);
  assert.ok(reclaimIds.includes("run_f6a") && reclaimIds.includes("run_f6c"), "回收项逐条在列");
});

test("计划条目：脏树回收项打印「删除即丢弃未提交内容」标注", async () => {
  const s = await scenario();
  seedLibraryDummy(s);
  const wt = s.wt("run_f6e");
  writeFileSync(join(wt, "dirty.txt"), "dropped\n", "utf8");
  s.seed("run_f6e", decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_f6e", baseCommit: s.mainCommit, decision: "rejected",
  }));
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    await worktreeCommand(["reclaim", "--cwd", s.repo, "--out", join(s.base, "plan-f6e.json"), "--run-dir", s.runDir], {});
  } finally {
    console.log = origLog;
  }
  const line = logs.find((l) => l.includes("run_f6e"));
  assert.ok(line, "应打印该回收项");
  assert.match(line, /脏树：删除即丢弃未提交内容/);
});

// 兜底：未用到的导入保持显式（OLD_TS 供手工调试种子扩展）。
void OLD_TS; void rmSync;
