// test/application/worktreeReclaim.test.js
//
// `wao worktree reclaim` 计划面测试：分类闭集与求值顺序、计划绑定拒绝、
// dry-run 零改动、CLI 适配。全部用真 git 临时仓 + 临时 run 目录（os.tmpdir
// 下），从不指向仓库相对 runs/，也从不触碰真实仓库。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { symlinkSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
import { spawn } from "node:child_process";

import {
  planWorktreeReclaim, computeTreeFingerprint, untrackedIgnoredManifest,
} from "../../src/application/worktreeReclaim.js";
import { worktreeCommand } from "../../src/commands/worktree.js";

import {
  git, makeRepo, mkdtemp, makeWorktree, makeLinkedWorktree, makeRunTreeIn, commitIn, seedTranscript,
  cleanRunEvents, decidedRunEvents, memberRunEvents, cleanupDir, fixedNow, OLD_TS,
  lineageRootRunEvents, lineageChildRunEvents, packagedDeliveryEvents, verifiedDeliveryRef,
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

test("分类（第 120 批）：已打包未裁决但有被采纳的后代（派生被取代）→ 树干净即可回收，条目写明 supersededByRunId", async () => {
  const s = await scenario();
  const wt = s.wt("run_sp_a");
  s.seed("run_sp_a", lineageRootRunEvents({
    runId: "run_sp_a", repo: s.repo, wt, branch: "wao/run_sp_a", baseCommit: s.mainCommit,
  }));
  // 续修子运行与父共享 retained worktree（生产形状），已合法采纳 → 父被取代。
  s.seed("run_sp_b", lineageChildRunEvents({
    runId: "run_sp_b", parentRunId: "run_sp_a", rootRunId: "run_sp_a",
    repo: s.repo, wt, branch: "wao/run_sp_a", baseCommit: s.mainCommit, decision: "accepted",
  }));
  const { plan } = await s.plan();
  const tree = itemsOf(plan, "run_sp_a").find((i) => i.action === "remove_tree");
  assert.ok(tree, `被取代的祖先应可回收: ${JSON.stringify(itemsOf(plan, "run_sp_a"))}`);
  assert.equal(tree.category, "reclaim");
  assert.equal(tree.supersededByRunId, "run_sp_b", "计划条目写明那个被采纳的后代");
  assert.equal(itemsOf(plan, "run_sp_a").filter((i) => i.reason === "delivery_packaged_undecided").length, 0,
    "被取代只撤掉 delivery_packaged_undecided 这一个阻塞");
});

test("分类（第 120 批）：被取代但树脏 → 仍按 undecided_dirty_tree 保留（只撤一个阻塞）", async () => {
  const s = await scenario();
  const wt = s.wt("run_sp_c");
  writeFileSync(join(wt, "uncommitted.txt"), "dirty\n", "utf8");
  s.seed("run_sp_c", lineageRootRunEvents({
    runId: "run_sp_c", repo: s.repo, wt, branch: "wao/run_sp_c", baseCommit: s.mainCommit,
  }));
  s.seed("run_sp_d", lineageChildRunEvents({
    runId: "run_sp_d", parentRunId: "run_sp_c", rootRunId: "run_sp_c",
    repo: s.repo, wt, branch: "wao/run_sp_c", baseCommit: s.mainCommit, decision: "accepted",
  }));
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_sp_c");
  assert.equal(item.category, "pending_lead");
  assert.equal(item.reason, "undecided_dirty_tree", "树脏的字节后代不一定有 → 仍保留");
  assert.equal(item.supersededByRunId, "run_sp_d");
  assert.equal(itemsOf(plan, "run_sp_c").filter((i) => i.action === "remove_tree").length, 0);
});

test("分类（第 120 批）：共享树里另一成员待裁决 → 整棵树保留（被取代的祖先也不回收）", async () => {
  const s = await scenario();
  const wt = s.wt("run_sp_e");
  s.seed("run_sp_e", lineageRootRunEvents({
    runId: "run_sp_e", repo: s.repo, wt, branch: "wao/run_sp_e", baseCommit: s.mainCommit,
  }));
  s.seed("run_sp_f", lineageChildRunEvents({
    runId: "run_sp_f", parentRunId: "run_sp_e", rootRunId: "run_sp_e",
    repo: s.repo, wt, branch: "wao/run_sp_e", baseCommit: s.mainCommit, decision: "accepted",
  }));
  // 同树成员（无续修父边、已打包未裁决、没有已采纳后代）→ 仍待裁决。
  s.seed("run_sp_m", [
    ...memberRunEvents({ repo: s.repo, wt, branch: "wao/run_sp_e", rootRunId: "run_sp_e" }),
    ...packagedDeliveryEvents("run_sp_m", { baseCommit: s.mainCommit }),
  ]);
  const { plan } = await s.plan();
  const member = oneItem(plan, "run_sp_m");
  assert.equal(member.reason, "delivery_packaged_undecided", "成员自己仍待裁决");
  const root = oneItem(plan, "run_sp_e");
  assert.equal(root.category, "tree_shared");
  assert.equal(root.reason, "shared_tree_kept");
  assert.equal(itemsOf(plan, "run_sp_e").filter((i) => i.action === "remove_tree").length, 0);
});

test("分类（第 120 批续修 G1）：只靠路径声明的共享成员带打包未裁决事实 → 整树按 delivery_packaged_undecided 保留", async () => {
  const s = await scenario();
  const wt = s.wt("run_gp_a");
  s.seed("run_gp_a", lineageRootRunEvents({
    runId: "run_gp_a", repo: s.repo, wt, branch: "wao/run_gp_a", baseCommit: s.mainCommit,
  }));
  s.seed("run_gp_b", lineageChildRunEvents({
    runId: "run_gp_b", parentRunId: "run_gp_a", rootRunId: "run_gp_a",
    repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
  }));
  // 只靠 run.started.worktreePath 声明这棵树：没有自有树/分支、不在属主谱系内，
  // 因此不会被逐 runId 分类，但它是整棵树的成员（有打包、未裁决）。
  s.seed("run_gp_m", [
    {
      type: "run.started", backend: "test", cwd: s.repo, worktreePath: wt, worktreeBranch: null,
      delivery: { mode: "git_commit_v1", baseCommit: s.mainCommit },
    },
    { type: "run.state_change", from: null, to: "running", reason: "spawned" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
    { type: "run.delivery_created", delivery: verifiedDeliveryRef("run_gp_m", { baseCommit: s.mainCommit }) },
    { type: "run.delivery_verification_passed", delivery: verifiedDeliveryRef("run_gp_m", { baseCommit: s.mainCommit }) },
  ]);
  const { plan } = await s.plan();
  const root = oneItem(plan, "run_gp_a");
  assert.equal(root.category, "pending_lead", "整树保留");
  assert.equal(root.reason, "delivery_packaged_undecided");
  assert.equal(root.detail, "tree member run_gp_m");
  assert.equal(itemsOf(plan, "run_gp_a").filter((i) => i.action === "remove_tree").length, 0);
});

test("分类（第 120 批续修 G3）：缺交付载荷的采纳事件不算合法裁决 → 整树保留", async () => {
  const s = await scenario();
  const wt = s.wt("run_gd_a");
  s.seed("run_gd_a", [
    ...lineageRootRunEvents({ runId: "run_gd_a", repo: s.repo, wt, branch: "wao/run_gd_a", baseCommit: s.mainCommit }),
    // 裸采纳事件（没有任何交付载荷）：validateDeliveryFacts 判 malformed，不算裁决。
    { type: "run.delivery_accepted" },
  ]);
  s.seed("run_gd_b", lineageChildRunEvents({
    runId: "run_gd_b", parentRunId: "run_gd_a", rootRunId: "run_gd_a",
    repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
  }));
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_gd_a");
  assert.equal(item.category, "pending_lead", "非法采纳不算裁决");
  assert.equal(item.reason, "delivery_packaged_undecided");
  assert.equal(itemsOf(plan, "run_gd_a").filter((i) => i.action === "remove_tree").length, 0);
});

test("分类（第 120 批续修 A1）：祖先自身验证未收口——不推导，仍按 delivery_packaged_undecided 保留", async () => {
  const s = await scenario();
  const wt = s.wt("run_sp_vp");
  s.seed("run_sp_vp", [
    { type: "run.session_reuse", mode: "run_lineage", turn: "first", rootRunId: "run_sp_vp" },
    { type: "run.started", backend: "test", cwd: s.repo, worktreePath: wt, worktreeBranch: "wao/run_sp_vp", delivery: { mode: "git_commit_v1", baseCommit: s.mainCommit } },
    { type: "run.state_change", from: null, to: "running", reason: "spawned" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
    // 只有打包、验证仍 pending → 未收口。
    {
      type: "run.delivery_created",
      delivery: verifiedDeliveryRef("run_sp_vp", { baseCommit: s.mainCommit, verificationStatus: "pending" }),
    },
  ]);
  s.seed("run_sp_vq", lineageChildRunEvents({
    runId: "run_sp_vq", parentRunId: "run_sp_vp", rootRunId: "run_sp_vp",
    repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
  }));
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_sp_vp");
  assert.equal(item.category, "pending_lead", "验证未收口的祖先仍被回收门挡住");
  assert.equal(item.reason, "delivery_packaged_undecided");
  assert.equal(item.supersededByRunId, undefined, "未收口 → 不出派生字段");
  assert.equal(itemsOf(plan, "run_sp_vp").filter((i) => i.action === "remove_tree").length, 0);
});

test("分类（第 120 批续修 C1）：计划树条目写明 supersededMembers（apply 只重证这些成员）", async () => {
  const s = await scenario();
  const wt = s.wt("run_sp_sm");
  s.seed("run_sp_sm", lineageRootRunEvents({
    runId: "run_sp_sm", repo: s.repo, wt, branch: "wao/run_sp_sm", baseCommit: s.mainCommit,
  }));
  s.seed("run_sp_sn", lineageChildRunEvents({
    runId: "run_sp_sn", parentRunId: "run_sp_sm", rootRunId: "run_sp_sm",
    repo: s.repo, wt, branch: "wao/run_sp_sm", baseCommit: s.mainCommit, decision: "accepted",
  }));
  const { plan } = await s.plan();
  const tree = itemsOf(plan, "run_sp_sm").find((i) => i.action === "remove_tree");
  assert.ok(tree, "夹具前提：树可回收");
  assert.deepEqual(tree.supersededMembers, ["run_sp_sm"], "依赖派生放行的成员名单进计划");
  assert.equal(tree.supersededByRunId, "run_sp_sn");
});

test("分类（第 120 批续修第 6 轮 P1）：桶 statSync 持续 EACCES → 计划不出任何删除项", async () => {
  const s = await scenario();
  const wt = s.wt("run_n1_a");
  s.seed("run_n1_a", lineageRootRunEvents({
    runId: "run_n1_a", repo: s.repo, wt, branch: "wao/run_n1_a", baseCommit: s.mainCommit,
  }));
  s.seed("run_n1_accept", lineageChildRunEvents({
    runId: "run_n1_accept", parentRunId: "run_n1_a", rootRunId: "run_n1_a",
    repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
  }));
  // 同根旁支 X↔Y 放在项目桶里：枚举完整时成环 → 不推导；桶读不出时清单漏掉环。
  const member = (runId, parentRunId) => [
    { type: "run.background_submitted", runId, continuation: true, parentRunId, rootRunId: "run_n1_a" },
    { type: "run.session_reuse", runId, mode: "run_lineage", turn: "resume", rootRunId: "run_n1_a" },
    ...packagedDeliveryEvents(runId, { baseCommit: s.mainCommit }),
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
  ];
  s.seed("run_n1_x", member("run_n1_x", "run_n1_y"), { bucket: "proj-a" });
  s.seed("run_n1_y", member("run_n1_y", "run_n1_x"), { bucket: "proj-a" });
  // sol 的两个扩展形状：只有分支还在跑的运行；漏掉已打包未裁决的共享成员。
  git(["branch", "wao/run_n1_active"], s.repo);
  s.seed("run_n1_active", [
    {
      type: "run.started", backend: "test", cwd: s.repo, worktreePath: null,
      worktreeBranch: "wao/run_n1_active",
    },
    { type: "run.state_change", from: null, to: "running", reason: "spawned" },
  ]);
  const tree = s.wt("run_n1_tree");
  s.seed("run_n1_tree", lineageRootRunEvents({
    runId: "run_n1_tree", repo: s.repo, wt: tree, branch: "wao/run_n1_tree",
    baseCommit: s.mainCommit, decision: "accepted",
  }));
  s.seed("run_n1_shared", [
    {
      type: "run.started", backend: "test", cwd: s.repo, worktreePath: tree, worktreeBranch: null,
      delivery: { mode: "git_commit_v1", baseCommit: s.mainCommit },
    },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
    ...packagedDeliveryEvents("run_n1_shared", { baseCommit: s.mainCommit }),
  ]);
  // 健康对照里真的可删的已裁决分支：注入后必须一起消失（证明规则不是空转）。
  git(["branch", "wao/run_n1_del"], s.repo);
  s.seed("run_n1_del", decidedRunEvents({
    repo: s.repo, baseCommit: s.mainCommit, branch: "wao/run_n1_del", decision: "accepted",
  }));
  const normalize = (plan) => plan.items
    .map((i) => ({ runId: i.runId, action: i.action, reason: i.reason ?? null }))
    .sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  const healthy = await s.plan();
  assert.equal(itemsOf(healthy.plan, "run_n1_a").filter((i) => i.action === "delete_branch").length, 0,
    "夹具前提：完整枚举下成环，不出 delete_branch");
  assert.equal(oneItem(healthy.plan, "run_n1_active").reason, "non_terminal", "夹具前提：在跑");
  assert.ok(itemsOf(healthy.plan, "run_n1_del").some((i) => i.action === "delete_branch"),
    "夹具前提：健康计划里有真的删除项");
  assert.equal(oneItem(healthy.plan, "run_n1_tree").reason, "delivery_packaged_undecided",
    "夹具前提：共享成员让整树保留");
  const healthySnapshot = normalize(healthy.plan);
  // 桶 statSync 持续 EACCES：严格枚举抛错 → 退回非严格清单（同样漏掉该桶）+
  // 记枚举不完整。
  const bucketDir = join(s.runDir, "projects", readdirSync(join(s.runDir, "projects"))[0]);
  const fsCjs = require("node:fs");
  const realStat = fsCjs.statSync;
  let injected = 0;
  fsCjs.statSync = (p, ...rest) => {
    if (resolve(String(p)) === resolve(bucketDir)) {
      injected += 1;
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    }
    return realStat(p, ...rest);
  };
  syncBuiltinESMExports();
  let injectedPlan;
  try {
    injectedPlan = await s.plan();
  } finally {
    fsCjs.statSync = realStat;
    syncBuiltinESMExports();
  }
  assert.ok(injected > 0, "注入生效");
  // P1：枚举不完整时整份计划不出任何删除项；所有条目保留、理由 undeterminable。
  const deleting = injectedPlan.plan.items.filter((i) => i.action !== "keep");
  assert.deepEqual(deleting, [], "枚举不完整时计划没有任何删除项");
  for (const item of injectedPlan.plan.items) {
    assert.equal(item.reason, "undeterminable", `${item.runId} 的保留理由`);
    assert.equal(item.detail, "transcript_enumeration_incomplete", `${item.runId} 的 detail`);
  }
  assert.equal(injectedPlan.plan.counts.byCategory.reclaim, 0, "计数里没有回收项");
  assert.equal(injectedPlan.plan.items.length, injectedPlan.plan.counts.byCategory.undeterminable,
    "所有主体都归无法判定，且照常列出条目");
  // 恢复访问后重新出计划：与健康对照一致。
  const restored = await s.plan();
  assert.deepEqual(normalize(restored.plan), healthySnapshot, "恢复后计划与健康对照一致");
});

test("分类（第 120 批续修第 4 轮 L3）：成员门保留整组共享成员——续修子一并保留、外层仍 has_kept_descendant", async () => {
  const s = await scenario();
  const outer = s.wt("run_l3_out");
  const inner = join(outer, ".wao-worktrees", "run_l3_in");
  git(["worktree", "add", inner, "-b", "wao/run_l3_in"], s.repo);
  git(["branch", "wao/run_l3_c"], s.repo);
  s.seed("run_l3_out", decidedRunEvents({
    repo: s.repo, wt: outer, branch: "wao/run_l3_out", baseCommit: s.mainCommit, decision: "accepted",
  }));
  s.seed("run_l3_in", lineageRootRunEvents({
    runId: "run_l3_in", repo: s.repo, wt: inner, branch: "wao/run_l3_in", baseCommit: s.mainCommit, decision: "accepted",
  }));
  // 已采纳、共享内层树的续修子：自己有独立分支（旧行为会出 delete_branch）。
  s.seed("run_l3_c", lineageChildRunEvents({
    runId: "run_l3_c", parentRunId: "run_l3_in", rootRunId: "run_l3_in",
    repo: s.repo, wt: inner, branch: "wao/run_l3_c", baseCommit: s.mainCommit, decision: "accepted",
  }));
  // 阻断内层树的只靠路径声明成员。
  s.seed("run_l3_m", [
    {
      type: "run.started", backend: "test", cwd: s.repo, worktreePath: inner, worktreeBranch: null,
      delivery: { mode: "git_commit_v1", baseCommit: s.mainCommit },
    },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
    { type: "run.delivery_created", delivery: verifiedDeliveryRef("run_l3_m", { baseCommit: s.mainCommit }) },
    { type: "run.delivery_verification_passed", delivery: verifiedDeliveryRef("run_l3_m", { baseCommit: s.mainCommit }) },
  ]);
  const { plan } = await s.plan();
  for (const id of ["run_l3_in", "run_l3_c"]) {
    const item = oneItem(plan, id);
    assert.equal(item.category, "pending_lead", `${id} 整组保留`);
    assert.equal(item.reason, "delivery_packaged_undecided");
    assert.equal(item.detail, "tree member run_l3_m");
    assert.equal(itemsOf(plan, id).filter((i) => i.action === "remove_tree").length, 0);
    assert.equal(itemsOf(plan, id).filter((i) => i.action === "delete_branch").length, 0,
      `${id} 不该出 delete_branch`);
  }
  const outerItem = oneItem(plan, "run_l3_out");
  assert.equal(outerItem.category, "tree_protection");
  assert.equal(outerItem.reason, "has_kept_descendant");
  assert.equal(itemsOf(plan, "run_l3_out").filter((i) => i.action === "remove_tree").length, 0);
  assert.equal(plan.counts.byCategory.reclaim, 0, "计划里没有任何回收项");
  // 计划本身不删分支——分支仍在。
  assert.match(git(["rev-parse", "--verify", "refs/heads/wao/run_l3_c"], s.repo), /^[0-9a-f]{40}$/);
});

test("分类（第 120 批续修第 3 轮 K4）：裸拒收按事件类型算已裁决（拒收兼容例外），进回收", async () => {
  const s = await scenario();
  const wt = s.wt("run_bare_r");
  s.seed("run_bare_r", [
    {
      type: "run.started", backend: "test", cwd: s.repo, worktreePath: wt,
      worktreeBranch: "wao/run_bare_r", delivery: { mode: "git_commit_v1", baseCommit: s.mainCommit },
    },
    { type: "run.state_change", from: null, to: "running", reason: "spawned" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
    // 裸拒收：没有任何交付载荷。拒收沿用 b120 之前的事件类型口径（兼容例外），
    // 与"采纳必须过 validateDeliveryFacts"分开。
    { type: "run.delivery_rejected" },
  ]);
  const { plan } = await s.plan();
  const tree = plan.items.find((i) => i.action === "remove_tree" && i.runId === "run_bare_r");
  assert.ok(tree, "裸拒收照类型算已裁决 → 可回收");
  assert.equal(tree.facts.lastDecision, "rejected", "审批事实如实写 rejected");
});

test("分类（第 120 批续修第 3 轮 J3）：谱系根转录为空（属主是续修子）→ undeterminable/transcript_empty_now", async () => {
  const s = await scenario();
  const wt = s.wt("run_je_o");
  // 属主是续修子 O；谱系根 R 的转录被截空。
  s.seed("run_je_r", []);
  s.seed("run_je_o", lineageChildRunEvents({
    runId: "run_je_o", parentRunId: "run_je_r", rootRunId: "run_je_r",
    repo: s.repo, wt, branch: "wao/run_je_o", baseCommit: s.mainCommit,
  }));
  s.seed("run_je_d", lineageChildRunEvents({
    runId: "run_je_d", parentRunId: "run_je_o", rootRunId: "run_je_r",
    repo: s.repo, baseCommit: s.mainCommit, decision: "accepted",
  }));
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_je_o");
  assert.equal(item.category, "undeterminable", "空转录如实归无法判定");
  assert.equal(item.reason, "transcript_empty_now");
  assert.equal(item.detail, "run_je_r", "点名空转录的谱系成员");
  assert.equal(itemsOf(plan, "run_je_o").filter((i) => i.action === "remove_tree").length, 0);
});

test("分类（第 120 批续修第 3 轮 K1）：内容不同、最后状态相同的孪生成员带打包事实 → 整树保留", async () => {
  const s = await scenario();
  const wt = s.wt("run_kt_a");
  s.seed("run_kt_a", lineageRootRunEvents({
    runId: "run_kt_a", repo: s.repo, wt, branch: "wao/run_kt_a", baseCommit: s.mainCommit, decision: "accepted",
  }));
  // 只靠路径声明共享树、无独立分支的成员 M：两份副本内容不同（副本多一条无害
  // 事件），最后状态与声明路径相同，均带打包事实、未裁决。
  const memberEvents = [
    {
      type: "run.started", backend: "test", cwd: s.repo, worktreePath: wt, worktreeBranch: null,
      delivery: { mode: "git_commit_v1", baseCommit: s.mainCommit },
    },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
    { type: "run.delivery_created", delivery: verifiedDeliveryRef("run_kt_m", { baseCommit: s.mainCommit }) },
    { type: "run.delivery_verification_passed", delivery: verifiedDeliveryRef("run_kt_m", { baseCommit: s.mainCommit }) },
  ];
  s.seed("run_kt_m", memberEvents);
  s.seed("run_kt_m", [...memberEvents, { type: "run.lead_note", text: "harmless" }], { bucket: "conflict" });
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_kt_a");
  assert.equal(item.category, "pending_lead", "歧义成员不能既不当候选又被当成不存在");
  assert.equal(item.reason, "delivery_packaged_undecided");
  assert.equal(item.detail, "tree member run_kt_m");
  assert.equal(itemsOf(plan, "run_kt_a").filter((i) => i.action === "remove_tree").length, 0);
});

test("分类（第 120 批续修第 3 轮 K2）：被成员门保留的内层树 → 外层树在计划里就 has_kept_descendant", async () => {
  const s = await scenario();
  const outer = s.wt("run_kn_out");
  const inner = join(outer, ".wao-worktrees", "run_kn_in");
  git(["worktree", "add", inner, "-b", "wao/run_kn_in"], s.repo);
  s.seed("run_kn_out", decidedRunEvents({
    repo: s.repo, wt: outer, branch: "wao/run_kn_out", baseCommit: s.mainCommit, decision: "accepted",
  }));
  s.seed("run_kn_in", lineageRootRunEvents({
    runId: "run_kn_in", repo: s.repo, wt: inner, branch: "wao/run_kn_in", baseCommit: s.mainCommit, decision: "accepted",
  }));
  // 内层树的只靠路径声明成员：带打包事实、未裁决 → 内层树被成员门保留。
  s.seed("run_kn_m", [
    {
      type: "run.started", backend: "test", cwd: s.repo, worktreePath: inner, worktreeBranch: null,
      delivery: { mode: "git_commit_v1", baseCommit: s.mainCommit },
    },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
    { type: "run.delivery_created", delivery: verifiedDeliveryRef("run_kn_m", { baseCommit: s.mainCommit }) },
    { type: "run.delivery_verification_passed", delivery: verifiedDeliveryRef("run_kn_m", { baseCommit: s.mainCommit }) },
  ]);
  const { plan } = await s.plan();
  assert.equal(oneItem(plan, "run_kn_in").reason, "delivery_packaged_undecided");
  const outerItem = oneItem(plan, "run_kn_out");
  assert.equal(outerItem.category, "tree_protection");
  assert.equal(outerItem.reason, "has_kept_descendant", "外层在计划里就保留，不写出等执行才拦下的 remove_tree");
  assert.equal(itemsOf(plan, "run_kn_out").filter((i) => i.action === "remove_tree").length, 0);
});

test("分类（第 120 批）：末代被拒收——祖先不推导，仍按 delivery_packaged_undecided 保留", async () => {
  const s = await scenario();
  const wt = s.wt("run_sp_g");
  s.seed("run_sp_g", lineageRootRunEvents({
    runId: "run_sp_g", repo: s.repo, wt, branch: "wao/run_sp_g", baseCommit: s.mainCommit,
  }));
  s.seed("run_sp_h", lineageChildRunEvents({
    runId: "run_sp_h", parentRunId: "run_sp_g", rootRunId: "run_sp_g",
    repo: s.repo, wt, branch: "wao/run_sp_g", baseCommit: s.mainCommit,
  }));
  // 末代拒收（不是采纳）——拒收不上传。
  s.seed("run_sp_i", [
    ...lineageChildRunEvents({
      runId: "run_sp_i", parentRunId: "run_sp_h", rootRunId: "run_sp_g",
      repo: s.repo, wt, branch: "wao/run_sp_g", baseCommit: s.mainCommit,
    }),
    {
      type: "run.delivery_rejected",
      delivery: verifiedDeliveryRef("run_sp_i", { baseCommit: s.mainCommit, acceptance: "rejected" }),
      deliveryCommit: verifiedDeliveryRef("run_sp_i", { baseCommit: s.mainCommit }).deliveryCommit,
      reason: "no",
    },
  ]);
  const { plan } = await s.plan();
  // 拒收不进 accepted 集合 → 不派生；线系又未显式关闭 → 既有 reuse_open 门先保留
  //（反正不回收），祖先仍待裁决。
  assert.equal(oneItem(plan, "run_sp_g").category, "reuse_open");
  assert.equal(oneItem(plan, "run_sp_g").reason, "lineage_not_closed");
  assert.equal(oneItem(plan, "run_sp_h").reason, "lineage_not_closed");
  assert.equal(itemsOf(plan, "run_sp_g").filter((i) => i.action === "remove_tree").length, 0);
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

test("分类：分支 tip 短 SHA 被引用 → include_required/referenced_short_sha", async () => {
  const s = await scenario();
  const wt = s.wt("run_ref");
  const sha = commitIn(wt, "feature.txt", "x\n");
  s.seed("run_ref", decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_ref", baseCommit: s.mainCommit, decision: "accepted",
  }));
  writeFileSync(join(s.repo, "docs", "decision-proof.md"), `钉住 ${sha.slice(0, 7)} 不变。\n`, "utf8");
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_ref");
  assert.equal(item.category, "include_required");
  assert.equal(item.reason, "referenced_short_sha");
});

test("分类：只有分支没有树、三处无转录且未并入 → include_required/transcript_missing_unmerged；--include 点名豁免", async () => {
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
  assert.deepEqual(branch.notes, ["--include 点名"]);
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
  // --include 点名豁免的是第 6 类；缺转录的事实缺口点不出事实来。
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

  // b78 续修：sha256 行之后打印可照抄的 apply 命令（实际值，路径带双引号——
  // 含空格的路径照抄才能跑）——计划文件路径、sha256、run-dir 与本次生成一一
  // 对应，Lead 不用猜参数名。
  const applyLine = logs.find((l) => l.includes("wao worktree reclaim --apply"));
  assert.ok(applyLine, `应打印可照抄的 apply 命令行: ${JSON.stringify(logs)}`);
  assert.ok(applyLine.includes(`wao worktree reclaim --apply "${outPath}"`), `命令带实际计划路径（双引号括起）: ${applyLine}`);
  assert.ok(applyLine.includes(`--expect-sha256 ${fileSha}`), `命令带实际 sha256: ${applyLine}`);
  assert.ok(applyLine.includes(`--run-dir "${resolve(s.runDir)}"`), `命令带生成时的 run-dir（双引号括起）: ${applyLine}`);

  // b78：--apply 缺 --expect-sha256 的报错写出命令形状（占位值）。
  await assert.rejects(
    () => worktreeCommand(["reclaim", "--apply", outPath], { runDir: s.runDir }),
    /wao worktree reclaim --apply <plan\.json> --expect-sha256 <hex> --run-dir <生成时的 run-dir>/,
  );
});

// B92：分类计数只显示 running=N——里面"最近 15 分钟内有事件"的保留项（例如刚
// lineage-close）不是回收不了，只是要等静默窗过去。有这类项时摘要多一行固定
// 说明；没有时输出逐字不变。
test("CLI：计划摘要——recent_event 保留项多一行固定说明；无这类项时不打这行", async () => {
  const s = await scenario();
  const outPath = join(s.base, "plan-recent-cli.json");
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    // 基线（无 recent_event 项）：干净终态 run，事件都落在 OLD_TS。
    const wtPlain = s.wt("run_cli_plain");
    s.seed("run_cli_plain", cleanRunEvents({ repo: s.repo, wt: wtPlain, branch: "wao/run_cli_plain" }));
    await worktreeCommand(["reclaim", "--cwd", s.repo, "--out", outPath, "--run-dir", s.runDir], { runDir: s.runDir });
    assert.ok(!logs.some((l) => l.includes("最近 15 分钟内有事件")), "无 recent_event 项时不打说明行");
    // 有 recent_event 项：最后一条绑定事件 30 秒前（CLI 不注入时钟，用真实时钟）。
    logs.length = 0;
    const wtRecent = s.wt("run_cli_recent");
    s.seed("run_cli_recent", cleanRunEvents({ repo: s.repo, wt: wtRecent, branch: "wao/run_cli_recent" })
      .map((e) => (e.type === "run.state_change" && e.to === "completed" ? null : e))
      .filter(Boolean)
      .concat([{ type: "run.state_change", from: "running", to: "completed", reason: "done", ts: new Date(Date.now() - 30_000).toISOString() }]));
    await worktreeCommand(["reclaim", "--cwd", s.repo, "--out", outPath, "--run-dir", s.runDir], { runDir: s.runDir });
    assert.ok(
      logs.includes("  其中 1 项最近 15 分钟内有事件（例如刚关闭谱系），15 分钟后重新生成计划即可按规则判定"),
      `说明行逐字打出: ${JSON.stringify(logs)}`,
    );
    const countLine = logs.find((l) => l.includes("分类计数"));
    assert.ok(countLine.includes("running=1"), `分类计数里 running=1（说明行解释的就是它）: ${countLine}`);
  } finally {
    console.log = origLog;
  }
});

// b78 续修：可照抄的 apply 命令在路径含空格时也要真能照抄——两席实测未加引号
// 时拆词出错（plan_unreadable）。双引号在 PowerShell/cmd/Git Bash 里的拆词规则
// 一致：引号内空格不断词。这里按该规则把打印行拆回参数，交给 worktreeCommand
// 执行，apply 必须成功。
test("b78 续修 CLI：计划路径与 run-dir 都含空格——照抄命令带双引号，按引号规则拆参执行 apply 成功", async () => {
  const base = await mkdtemp("wao-reclaim-quote-");
  bases.push(base);
  const { repo, mainCommit } = await makeRepo("wao-reclaim-quote-repo-");
  const runDir = join(base, "runs with spaces");
  mkdirSync(runDir, { recursive: true });
  const plansDir = join(base, "plans with spaces");
  mkdirSync(plansDir, { recursive: true });
  const outPath = join(plansDir, "reclaim plan.json");
  const wt = makeWorktree(repo, "run_quote");
  seedTranscript(runDir, "run_quote", decidedRunEvents({
    repo, wt, branch: "wao/run_quote", baseCommit: mainCommit, decision: "accepted",
  }));

  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    await worktreeCommand(["reclaim", "--cwd", repo, "--out", outPath, "--run-dir", runDir], { runDir });
  } finally {
    console.log = origLog;
  }
  assert.ok(existsSync(outPath), "计划文件应写出");
  const applyLine = logs.find((l) => l.includes("wao worktree reclaim --apply"));
  assert.ok(applyLine, `应打印可照抄的 apply 命令行: ${JSON.stringify(logs)}`);
  assert.ok(applyLine.includes(`--apply "${outPath}"`), `计划路径用双引号括起: ${applyLine}`);
  assert.ok(applyLine.includes(`--run-dir "${runDir}"`), `run-dir 用双引号括起: ${applyLine}`);

  // 按带引号的规则拆回参数：双引号成对包裹、引号内空格不断词。
  const cmd = applyLine.slice(applyLine.indexOf("wao worktree reclaim"));
  const tokens = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of cmd) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === " " && !inQuotes) {
      if (cur) { tokens.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  assert.deepEqual(tokens.slice(0, 3), ["wao", "worktree", "reclaim"], "拆出的前三个词是 wao worktree reclaim");
  assert.ok(tokens.includes(outPath), "拆出的计划路径还原为原始含空格路径");
  assert.ok(tokens.includes(runDir), "拆出的 run-dir 还原为原始含空格路径");

  // 拆出的参数直接执行（等价于 Lead 在 shell 里照抄运行）——必须成功。
  const applyLogs = [];
  const prevExit = process.exitCode;
  console.log = (...a) => applyLogs.push(a.join(" "));
  try {
    await worktreeCommand(tokens.slice(2), { runDir });
  } finally {
    console.log = origLog;
    process.exitCode = prevExit;
  }
  assert.equal(process.exitCode, prevExit, "apply 成功：不设非零退出码");
  assert.ok(applyLogs.some((l) => l.includes("完成")), `apply 走到完成行: ${JSON.stringify(applyLogs)}`);
  assert.ok(!existsSync(wt), "照抄命令执行后运行树已删");
  assert.ok(
    !git(["for-each-ref", "--format=%(refname:short)", "refs/heads/wao/"], repo).includes("wao/run_quote"),
    "照抄命令执行后 wao/run_* 分支已删（先进 bundle）",
  );
});

test("CLI：worktree remove 只删登记在册的链接工作树——独立仓库、子模块、复制的树、子目录与普通目录拒删且不动盘", async () => {
  const s = await scenario();
  const clone = join(s.base, "private-clone");
  git(["clone", "--shared", "--no-checkout", s.repo, clone], s.base);
  const plain = join(s.base, "plain-dir");
  mkdirSync(plain);
  writeFileSync(join(plain, "keep.txt"), "keep\n");
  // .git 是文件、却不是链接工作树的三种形状：伪指针文件、--separate-git-dir 仓库、子模块。
  const strayGitfile = join(s.base, "stray-gitfile");
  mkdirSync(strayGitfile);
  writeFileSync(join(strayGitfile, ".git"), `gitdir: ${join(s.repo, ".git")}\n`);
  const separate = join(s.base, "separate-repo");
  git(["init", "-q", "--separate-git-dir", join(s.base, "separate-gitdir"), separate], s.base);
  const superRepo = join(s.base, "super");
  git(["init", "-q", superRepo], s.base);
  git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", s.repo, "sub"], superRepo);
  const submodule = join(superRepo, "sub");
  // 复制出来的链接工作树：.git 指针照旧指向原树的管理目录，git 会把它认成原树。
  const copied = join(s.base, "copied-worktree");
  cpSync(s.wt("run_remove_copy_src"), copied, { recursive: true });
  const wt = s.wt("run_remove_cli");
  const sub = join(wt, "docs");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "keep.txt"), "keep\n");
  for (const target of [clone, s.repo, plain, strayGitfile, separate, submodule, copied, sub]) {
    await assert.rejects(
      () => worktreeCommand(["remove", target], {}),
      /只删 git 登记在册的链接工作树/,
      `${target} 应被拒`,
    );
    assert.ok(existsSync(target), `${target} 拒删后应原样在盘`);
  }
  assert.ok(existsSync(join(clone, ".git")), "私有克隆的仓库目录不动");
  assert.ok(existsSync(join(plain, "keep.txt")), "普通目录的文件不动");

  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    await worktreeCommand(["remove", wt], {});
  } finally {
    console.log = origLog;
  }
  assert.ok(!existsSync(wt), "链接工作树照删");
  assert.ok(logs.some((l) => l.includes('"removed"')), "删后打印 removed");
  const spaced = makeLinkedWorktree(s.repo, join(s.base, "带 空格的树"), "dev/spaced");
  console.log = () => {};
  try {
    await worktreeCommand(["remove", spaced], {});
  } finally {
    console.log = origLog;
  }
  assert.ok(!existsSync(spaced), "路径带空格与中文的链接工作树照删");
});

test("CLI：worktree remove 不删上锁的树；经 junction 给出时删的是登记的树，目录还在就报错", async () => {
  const s = await scenario();
  const locked = s.wt("run_remove_locked");
  git(["worktree", "lock", "--reason", "keep", locked], s.repo);
  const lockedLink = join(s.base, "locked-link");
  symlinkSync(locked, lockedLink, "junction");
  for (const target of [locked, lockedLink]) {
    await assert.rejects(() => worktreeCommand(["remove", target], {}), /上锁/, `${target} 应被拒`);
    assert.ok(existsSync(join(locked, "a.txt")), "上锁的树原样在盘");
  }
  assert.ok(git(["worktree", "list", "--porcelain"], s.repo).includes("locked keep"), "登记与锁原样");

  // 有进程以树为当前目录：git 与强删兜底都删不掉它，经 junction 给出时兜底只会删掉 junction。
  const busy = s.wt("run_remove_busy");
  const busyLink = join(s.base, "busy-link");
  symlinkSync(busy, busyLink, "junction");
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: busy, stdio: "ignore", windowsHide: true });
  try {
    await new Promise((r) => holder.once("spawn", r));
    await assert.rejects(() => worktreeCommand(["remove", busyLink], {}), /目录仍在/);
    assert.ok(existsSync(busy), "目标树目录仍在");
  } finally {
    holder.kill();
  }

  const healthy = s.wt("run_remove_via_link");
  const healthyLink = join(s.base, "healthy-link");
  symlinkSync(healthy, healthyLink, "junction");
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    await worktreeCommand(["remove", healthyLink], {});
  } finally {
    console.log = origLog;
  }
  assert.ok(!existsSync(healthy), "junction 指向的链接工作树照删");
  const { removed } = JSON.parse(logs[0]);
  assert.ok(removed.toLowerCase().endsWith("\\.wao-worktrees\\run_remove_via_link"), `报的是登记的树：${removed}`);
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

  // 对照：未并入且 tip 被引用 → 照旧 include_required（要 --include 点名）。
  const wt = s.wt("run_unm");
  const sha = commitIn(wt, "feature.txt", "x\n");
  git(["worktree", "remove", "--force", wt], s.repo); // 只留分支
  writeFileSync(join(s.repo, "docs", "feature-note.md"), `钉住 ${sha.slice(0, 7)}。\n`, "utf8");
  const plan2 = await s.plan();
  assert.equal(oneItem(plan2.plan, "run_unm").category, "include_required");
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
  assert.ok(branch.notes.includes("--include 点名"));
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

test("分类（第 120 批续修第 7 轮 R1）：归档枚举 skipped（归档里的符号链接）→ 枚举不完整，整份计划不出删除项", async () => {
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
  // 口径统一到 P1：所有主体 undeterminable + transcript_enumeration_incomplete。
  assert.equal(item.category, "undeterminable");
  assert.equal(item.reason, "undeterminable");
  assert.equal(item.detail, "transcript_enumeration_incomplete");
  assert.equal(itemsOf(plan, "run_ask").filter((i) => i.action === "remove_tree").length, 0);
  assert.deepEqual(plan.items.filter((i) => i.action !== "keep"), [], "整份计划没有删除项");
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

test("归档根目录读不出（runs-archive 是文件）→ 枚举不完整，整份计划保留（不当成归档为空）", async () => {
  const s = await scenario();
  const wt = s.wt("run_archroot");
  s.seed("run_archroot", decidedRunEvents({
    repo: s.repo, wt, branch: "wao/run_archroot", baseCommit: s.mainCommit, decision: "accepted",
  }));
  writeFileSync(join(s.base, "runs-archive"), "not a directory\n", "utf8");
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_archroot");
  assert.equal(item.category, "undeterminable");
  assert.equal(item.reason, "undeterminable", "归档 skipped 归枚举不完整");
  assert.equal(item.detail, "transcript_enumeration_incomplete");
  assert.equal(itemsOf(plan, "run_archroot").filter((i) => i.action === "remove_tree").length, 0);
  assert.equal(plan.items.filter((i) => i.action !== "keep").length, 0);
});

test("分类（第 120 批续修第 7 轮 R1）：归档月份 readdirSync 持续 EACCES → 计划不出任何删除项", async () => {
  const s = await scenario();
  // 已裁决、健康时可删的纯分支：注入后必须一起保留（证明规则不是空转）。
  git(["branch", "wao/run_r1_del"], s.repo);
  s.seed("run_r1_del", decidedRunEvents({
    repo: s.repo, baseCommit: s.mainCommit, branch: "wao/run_r1_del", decision: "accepted",
  }));
  // 已打包未裁决的纯分支：转录只放在归档月份里——归档读不出时它会"看起来没有转录"。
  git(["branch", "wao/run_r1_und"], s.repo);
  s.seed("run_r1_und", [
    {
      type: "run.started", backend: "test", cwd: s.repo, worktreePath: null, worktreeBranch: "wao/run_r1_und",
    },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
    ...packagedDeliveryEvents("run_r1_und", { baseCommit: s.mainCommit }),
  ], { archiveMonth: "2026-01" });
  const normalize = (plan) => plan.items
    .map((i) => ({ runId: i.runId, action: i.action, reason: i.reason ?? null }))
    .sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  const healthy = await s.plan();
  assert.equal(oneItem(healthy.plan, "run_r1_und").reason, "delivery_packaged_undecided",
    "夹具前提：健康时因已打包未裁决保留");
  assert.ok(itemsOf(healthy.plan, "run_r1_del").some((i) => i.action === "delete_branch"),
    "夹具前提：健康计划里有真的删除项");
  const healthySnapshot = normalize(healthy.plan);
  // 归档月份目录持续 readdirSync EACCES：归档扫描报 skipped。
  const archDir = join(s.base, "runs-archive", "2026-01");
  assert.ok(existsSync(archDir), "夹具前提：归档月份在场");
  const fsCjs = require("node:fs");
  const realReaddir = fsCjs.readdirSync;
  let injected = 0;
  fsCjs.readdirSync = (p, ...rest) => {
    if (resolve(String(p)) === resolve(archDir)) {
      injected += 1;
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    }
    return realReaddir(p, ...rest);
  };
  syncBuiltinESMExports();
  let injectedPlan;
  try {
    injectedPlan = await s.plan();
  } finally {
    fsCjs.readdirSync = realReaddir;
    syncBuiltinESMExports();
  }
  assert.ok(injected > 0, "注入生效");
  assert.deepEqual(injectedPlan.plan.items.filter((i) => i.action !== "keep"), [],
    "归档读不全 → 计划没有任何删除项");
  for (const item of injectedPlan.plan.items) {
    assert.equal(item.reason, "undeterminable", `${item.runId} 的保留理由`);
    assert.equal(item.detail, "transcript_enumeration_incomplete", `${item.runId} 的 detail`);
  }
  assert.equal(injectedPlan.plan.counts.byCategory.reclaim, 0);
  // 恢复访问后重新出计划：与健康对照一致。
  const restored = await s.plan();
  assert.deepEqual(normalize(restored.plan), healthySnapshot, "恢复后计划与健康对照一致");
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

// ── 嵌套范围：关联工作树里的运行树 ──

test("范围：主检出、仓内关联工作树、仓外合法关联工作树三种位置的运行树都按同一套门回收；嵌套项带范围证明；从不同检出生成计划一致", async () => {
  const s = await scenario();
  const wtMain = s.wt("run_pos_m");
  s.seed("run_pos_m", decidedRunEvents({ repo: s.repo, wt: wtMain, branch: "wao/run_pos_m", baseCommit: s.mainCommit, decision: "accepted" }));
  const devIn = makeLinkedWorktree(s.repo, join(s.repo, ".dev", "wt", "devin"), "devin");
  const wtIn = makeRunTreeIn(devIn, "run_pos_in");
  s.seed("run_pos_in", decidedRunEvents({ repo: devIn, wt: wtIn, branch: "wao/run_pos_in", baseCommit: s.mainCommit, decision: "accepted" }));
  const devOut = makeLinkedWorktree(s.repo, join(s.base, "devout"), "devout");
  const wtOut = makeRunTreeIn(devOut, "run_pos_out");
  s.seed("run_pos_out", decidedRunEvents({ repo: devOut, wt: wtOut, branch: "wao/run_pos_out", baseCommit: s.mainCommit, decision: "accepted" }));

  const { plan } = await s.plan();
  for (const runId of ["run_pos_m", "run_pos_in", "run_pos_out"]) {
    const tree = itemsOf(plan, runId).find((i) => i.action === "remove_tree");
    assert.ok(tree, `${runId} 应有 remove_tree（三种位置同一套门）`);
    assert.equal(oneItem(plan, runId).category, "reclaim");
    assert.ok(itemsOf(plan, runId).some((i) => i.action === "delete_branch"));
  }
  // 主根项不带范围证明；嵌套项记录父树真实路径、common git dir、目标真实路径。
  const treeMain = itemsOf(plan, "run_pos_m").find((i) => i.action === "remove_tree");
  assert.ok(!("scopeRoot" in treeMain), "主根项不携带范围证明字段");
  const treeIn = itemsOf(plan, "run_pos_in").find((i) => i.action === "remove_tree");
  assert.equal(treeIn.scopeRoot, realpathSync(devIn));
  assert.equal(treeIn.scopeGitCommonDir, plan.repo.gitCommonDir);
  assert.equal(treeIn.treeRealPath, realpathSync(wtIn));
  const treeOut = itemsOf(plan, "run_pos_out").find((i) => i.action === "remove_tree");
  assert.equal(treeOut.scopeRoot, realpathSync(devOut));
  assert.equal(treeOut.scopeGitCommonDir, plan.repo.gitCommonDir);
  assert.equal(treeOut.treeRealPath, realpathSync(wtOut));
  // 关联工作树本身保留，原因照旧。
  assert.equal(oneItem(plan, "devin").reason, "outside_worktrees_dir");
  assert.equal(oneItem(plan, "devout").reason, "outside_worktrees_dir");
  // 从关联工作树里生成计划：与主检出一致（普查与范围从 porcelain[0] 推导，与
  // 调用 cwd 无关；generatedAt 来自时钟缝，换注入时钟时可能不同，不比）。
  const fromDev = await planWorktreeReclaim({ repoCwd: devOut, runDir: s.runDir, now: fixedNow });
  const stripClock = ({ generatedAt, ...rest }) => rest;
  assert.deepEqual(stripClock(fromDev.plan), stripClock(plan));
});

test("范围：关联工作树本身、其下普通目录、旁边目录与登记不动（不误伤）", async () => {
  const s = await scenario();
  const dev = makeLinkedWorktree(s.repo, join(s.repo, ".dev", "wt", "devkeep"), "devkeep");
  mkdirSync(join(dev, "plaindir"), { recursive: true });
  writeFileSync(join(dev, "plaindir", "keep.txt"), "keep\n", "utf8");
  const wt = makeRunTreeIn(dev, "run_keep");
  s.seed("run_keep", decidedRunEvents({ repo: dev, wt, branch: "wao/run_keep", baseCommit: s.mainCommit, decision: "accepted" }));
  const devNext = makeLinkedWorktree(s.repo, join(s.base, "devnext"), "devnext");
  mkdirSync(join(devNext, "somedir"), { recursive: true });
  const before = {
    entries: git(["worktree", "list", "--porcelain"], s.repo),
    keep: readFileSync(join(dev, "plaindir", "keep.txt"), "utf8"),
  };
  const { plan } = await s.plan();
  assert.equal(oneItem(plan, "run_keep").category, "reclaim");
  assert.equal(oneItem(plan, "devkeep").reason, "outside_worktrees_dir");
  assert.equal(oneItem(plan, "devnext").reason, "outside_worktrees_dir");
  assert.ok(!plan.items.some((i) => i.runId === "plaindir"), "关联工作树下的普通目录不是普查目标");
  assert.ok(!plan.items.some((i) => i.runId === "somedir"), "旁边目录不是普查目标");
  assert.equal(git(["worktree", "list", "--porcelain"], s.repo), before.entries, "dry-run 不动登记");
  assert.equal(readFileSync(join(dev, "plaindir", "keep.txt"), "utf8"), before.keep);
});

test("歧义：不同父树下的重名目录（含大小写变体）→ undeterminable/registration_ambiguous，不取第一项", async () => {
  const s = await scenario();
  const wtMain = s.wt("run_dup");
  s.seed("run_dup", decidedRunEvents({ repo: s.repo, wt: wtMain, branch: "wao/run_dup", baseCommit: s.mainCommit, decision: "accepted" }));
  const dev = makeLinkedWorktree(s.repo, join(s.base, "devdup"), "devdup");
  // 同名目录、另一分支（同名 runId 只能有一棵树绑定同一分支）。
  git(["worktree", "add", join(dev, ".wao-worktrees", "run_dup"), "-b", "devdupA"], dev);
  const dev2 = makeLinkedWorktree(s.repo, join(s.base, "devdup2"), "devdupC");
  // 大小写变体：basename 小写归并后与 run_dup 相撞。
  git(["worktree", "add", join(dev2, ".wao-worktrees", "RUN_DUP"), "-b", "devdupB"], dev2);
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_dup");
  assert.equal(item.category, "undeterminable");
  assert.equal(item.reason, "registration_ambiguous");
  assert.equal(item.action, "keep");
  assert.equal(itemsOf(plan, "run_dup").filter((i) => i.action === "remove_tree").length, 0, "重名时不得取第一项生成删除动作");
  assert.equal(itemsOf(plan, "run_dup").filter((i) => i.action === "delete_branch").length, 0);
  assert.ok(existsSync(wtMain) && existsSync(join(dev, ".wao-worktrees", "run_dup")));
});

test("歧义空壳在可回收树里：外层树因 has_kept_descendant 保留，不会把保留项连带删掉", async () => {
  const s = await scenario();
  const outer = s.wt("run_outer");
  s.seed("run_outer", decidedRunEvents({ repo: s.repo, wt: outer, branch: "wao/run_outer", baseCommit: s.mainCommit, decision: "accepted" }));
  // 外层运行树自己的 .wao-worktrees 下一个非空空壳，主根下另有同名空壳：两处都未登记。
  mkdirSync(join(outer, ".wao-worktrees", "run_dupx"), { recursive: true });
  writeFileSync(join(outer, ".wao-worktrees", "run_dupx", "keep.txt"), "kept\n");
  mkdirSync(join(s.repo, ".wao-worktrees", "run_dupx"), { recursive: true });
  writeFileSync(join(s.repo, ".wao-worktrees", "run_dupx", "keep.txt"), "kept\n");
  const { plan } = await s.plan();
  assert.equal(oneItem(plan, "run_dupx").reason, "registration_ambiguous");
  const outerItems = itemsOf(plan, "run_outer");
  assert.equal(outerItems.filter((i) => i.action === "remove_tree").length, 0, "外层树不得生成删除动作");
  assert.ok(outerItems.some((i) => i.reason === "has_kept_descendant"), "外层树因保留的后代被挡住");
});

test("范围：嵌在外仓关联工作树里的本仓运行树 → outside_worktrees_dir；关联工作树根下的外仓空壳 → foreign_worktree", async () => {
  const s = await scenario();
  seedLibraryDummy(s);
  const other = await makeRepo("wao-reclaim-fp-");
  bases.push(other.repo);
  const foreignParent = makeLinkedWorktree(other.repo, join(other.repo, ".dev", "foreign"), "foreign");
  // 本仓的运行树建在外仓关联工作树里：本仓 porcelain 登记了它，但父树不在本
  // 仓登记里——范围根不成立。
  const wt = join(foreignParent, ".wao-worktrees", "run_fp");
  git(["worktree", "add", wt, "-b", "wao/run_fp"], s.repo);
  s.seed("run_fp", decidedRunEvents({ repo: s.repo, wt, branch: "wao/run_fp", baseCommit: s.mainCommit, decision: "accepted" }));
  // 合法父树下的外仓空壳（本仓视角未登记、含外仓 git 元数据）。
  const dev = makeLinkedWorktree(s.repo, join(s.base, "devfh"), "devfh");
  git(["worktree", "add", join(dev, ".wao-worktrees", "run_fh"), "-b", "wao/run_fh"], other.repo);
  s.seed("run_fh", cleanRunEvents({ repo: other.repo, wt: join(dev, ".wao-worktrees", "run_fh"), branch: "wao/run_fh" }));
  const { plan } = await s.plan();
  assert.equal(oneItem(plan, "run_fp").reason, "outside_worktrees_dir");
  assert.equal(itemsOf(plan, "run_fp").filter((i) => i.action === "remove_tree").length, 0);
  assert.equal(oneItem(plan, "run_fh").reason, "foreign_worktree");
  assert.equal(oneItem(plan, "run_fh").action, "keep");
});

test("范围：父树的 .wao-worktrees 本身是 junction → 根不合格，其下登记树与目录都不入范围", async () => {
  const s = await scenario();
  seedLibraryDummy(s);
  const dev = makeLinkedWorktree(s.repo, join(s.base, "devjx"), "devjx");
  const store = join(s.base, "devjx-store");
  mkdirSync(store, { recursive: true });
  symlinkSync(store, join(dev, ".wao-worktrees"), "junction");
  // 运行树经 junction 落在 store 里（登记路径穿 junction）。
  const wt = join(dev, ".wao-worktrees", "run_jmid");
  git(["worktree", "add", wt, "-b", "wao/run_jmid"], s.repo);
  s.seed("run_jmid", decidedRunEvents({ repo: s.repo, wt, branch: "wao/run_jmid", baseCommit: s.mainCommit, decision: "accepted" }));
  // 不合格根下的未登记目录不枚举（连条目都没有）。
  mkdirSync(join(store, "run_jhusk"), { recursive: true });
  const { plan } = await s.plan();
  assert.equal(oneItem(plan, "run_jmid").reason, "outside_worktrees_dir");
  assert.equal(itemsOf(plan, "run_jmid").filter((i) => i.action === "remove_tree").length, 0);
  assert.ok(!plan.items.some((i) => i.runId === "run_jhusk"), "不合格根下的空壳不枚举");
});

test("空壳：关联工作树根下的空壳同样枚举；空 → rmdir_husk 带范围证明", async () => {
  const s = await scenario();
  seedLibraryDummy(s);
  const dev = makeLinkedWorktree(s.repo, join(s.base, "devhusk"), "devhusk");
  const emptyHusk = join(dev, ".wao-worktrees", "run_husk_n");
  mkdirSync(emptyHusk, { recursive: true });
  s.seed("run_husk_n", cleanRunEvents({ repo: dev, wt: emptyHusk, branch: null }));
  const { plan } = await s.plan();
  const husk = oneItem(plan, "run_husk_n");
  assert.equal(husk.action, "rmdir_husk");
  assert.equal(husk.category, "reclaim");
  assert.equal(husk.scopeRoot, realpathSync(dev));
  assert.equal(husk.scopeGitCommonDir, plan.repo.gitCommonDir);
  assert.equal(husk.treeRealPath, realpathSync(emptyHusk));
});

test("范围：登记失效（树目录已删）的嵌套运行树 → undeterminable/registered_missing", async () => {
  const s = await scenario();
  seedLibraryDummy(s);
  const dev = makeLinkedWorktree(s.repo, join(s.base, "devstale"), "devstale");
  const wt = makeRunTreeIn(dev, "run_stale_n");
  s.seed("run_stale_n", decidedRunEvents({ repo: dev, wt, branch: "wao/run_stale_n", baseCommit: s.mainCommit, decision: "accepted" }));
  rmSync(wt, { recursive: true, force: true });
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_stale_n");
  assert.equal(item.category, "undeterminable");
  assert.equal(item.reason, "registered_missing");
});

test("绑定：可读转录声明的工作树与登记树不一致 → undeterminable/registration_ambiguous（三方绑定的转录腿）", async () => {
  const s = await scenario();
  const wtA = s.wt("run_bnd");
  // 转录声明指向别处（另一条从未登记的路径）：这棵树不能按 run_bnd 的生命周期裁决。
  const declaredElsewhere = join(s.base, "elsewhere-bnd", "run_bnd");
  s.seed("run_bnd", decidedRunEvents({
    repo: s.repo, wt: declaredElsewhere, branch: "wao/run_bnd", baseCommit: s.mainCommit, decision: "accepted",
  }));
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_bnd");
  assert.equal(item.category, "undeterminable");
  assert.equal(item.reason, "registration_ambiguous");
  assert.equal(itemsOf(plan, "run_bnd").filter((i) => i.action === "remove_tree").length, 0);
  assert.equal(itemsOf(plan, "run_bnd").filter((i) => i.action === "delete_branch").length, 0);
});

test("宿主：没有预置 .wao-worktrees/ 忽略规则的宿主里，嵌套运行树照常按同一套门分类", async () => {
  const base = await mkdtemp("wao-reclaim-noignore-");
  bases.push(base);
  const { repo, mainCommit } = await makeRepo("wao-reclaim-noignore-", { ignoreWaoWorktrees: false });
  const runDir = join(base, "runs");
  mkdirSync(runDir, { recursive: true });
  const dev = makeLinkedWorktree(repo, join(base, "devplain"), "devplain");
  const wt = makeRunTreeIn(dev, "run_norule");
  seedTranscript(runDir, "run_norule", decidedRunEvents({ repo: dev, wt, branch: "wao/run_norule", baseCommit: mainCommit, decision: "accepted" }));
  const { plan } = await planWorktreeReclaim({ repoCwd: repo, runDir, now: fixedNow });
  assert.equal(oneItem(plan, "run_norule").category, "reclaim");
  const tree = itemsOf(plan, "run_norule").find((i) => i.action === "remove_tree");
  assert.equal(tree.scopeRoot, realpathSync(dev));
  assert.equal(oneItem(plan, "devplain").reason, "outside_worktrees_dir");
});

test("CLI：嵌套回收项打印目标路径与父树（审阅时看得见删的是哪棵）", async () => {
  const s = await scenario();
  const dev = makeLinkedWorktree(s.repo, join(s.base, "devcli"), "devcli");
  const wt = makeRunTreeIn(dev, "run_cli_n");
  s.seed("run_cli_n", decidedRunEvents({ repo: dev, wt, branch: "wao/run_cli_n", baseCommit: s.mainCommit, decision: "accepted" }));
  const outPath = join(s.base, "plan-cli-nested.json");
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    await worktreeCommand(["reclaim", "--cwd", s.repo, "--out", outPath, "--run-dir", s.runDir], { runDir: s.runDir });
  } finally {
    console.log = origLog;
  }
  const line = logs.find((l) => l.includes("run_cli_n"));
  assert.ok(line, "应打印该回收项");
  assert.match(line, /目标=.*run_cli_n/);
  assert.match(line, new RegExp(`父树=${realpathSync(dev).replace(/\\/g, "\\\\")}`));
});

// 私有索引副本（2026-10-28 会审必改）：computeTreeFingerprint 的工作树 diff
// （diff ... HEAD）经 diff.autoRefreshIndex 会刷新并写回真实索引
// （--no-optional-locks 也拦不住）。改在副本上跑后：真实索引字节不动、不留
// index.lock、mtime-only 不误报 dirty、真实内容改动照报。
test("指纹私有索引：工作树 diff 不写真实索引；mtime-only 不报 dirty、真改动照报", async () => {
  const s = await scenario();
  const wt = s.wt("run_prividx");
  const indexAbs = resolve(wt, git(["rev-parse", "--git-path", "index"], wt));
  const indexBefore = readFileSync(indexAbs);

  // 只改 mtime、内容不变：不得报成 dirty，也不得写真实索引
  const aPath = join(wt, "a.txt");
  const st = lstatSync(aPath);
  utimesSync(aPath, new Date(st.atimeMs), new Date(st.mtimeMs + 5000));
  const fp1 = await computeTreeFingerprint(wt);
  assert.equal(fp1.dirty.unstaged, false, "只改 mtime 不得报成改动");
  assert.equal(fp1.dirty.staged, false);
  assert.equal(fp1.dirty.untracked, false);
  assert.deepEqual(readFileSync(indexAbs), indexBefore, "真实 .git/index 字节必须原样");
  assert.ok(!existsSync(`${indexAbs}.lock`), "不得留下 index.lock 残锁");

  // 真实内容改动仍被报出（比较语义不变），且依旧不写真实索引
  writeFileSync(aPath, "const a = 2;\n", "utf8");
  const fp2 = await computeTreeFingerprint(wt);
  assert.equal(fp2.dirty.unstaged, true, "真实内容改动必须照报");
  assert.notEqual(fp2.worktreeDiffSha256, fp1.worktreeDiffSha256, "工作树 diff 哈希应随内容变化");
  assert.deepEqual(readFileSync(indexAbs), indexBefore, "真实 .git/index 字节仍必须原样");
  assert.ok(!existsSync(`${indexAbs}.lock`), "仍不得留下 index.lock 残锁");
});

// 兜底：未用到的导入保持显式（OLD_TS 供手工调试种子扩展）。
void OLD_TS; void rmSync;

// ===== 决定 0102：私有克隆的盘点识别 =========================================

import { createReadOnlyClone } from "../../src/isolation.js";

/** 私有克隆绑定的终态转录事件（run.started 带 worktreeForm/worktreePath）。 */
function privateCloneRunEvents({ repo, clone, runId, withForm = true }) {
  return [
    {
      type: "run.started", backend: "test", cwd: repo, worktreePath: clone, worktreeBranch: `wao/${runId}`,
      ...(withForm ? { worktreeForm: "private_clone" } : {}),
    },
    { type: "run.state_change", from: null, to: "pending", reason: "created" },
    { type: "run.state_change", from: "pending", to: "running", reason: "spawned" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
  ];
}

test("分类：WAO 私有克隆（真克隆+绑定转录）→ tree_protection/private_clone；源仓工作树计数不含克隆", async () => {
  const s = await scenario();
  // 用生产原语在源仓 .wao-worktrees/<runId> 下建真实私有克隆（冻结基点=建仓提交）
  const clone = await createReadOnlyClone(s.repo, "run_pc", { commitish: s.mainCommit });
  s.seed("run_pc", privateCloneRunEvents({ repo: s.repo, clone: clone.path, runId: "run_pc" }));
  // 前置事实：克隆不在源仓的 worktree 登记里（工作树与分支计数只数源仓自己的登记）
  const wtList = git(["worktree", "list", "--porcelain"], s.repo);
  assert.ok(!wtList.includes("run_pc"), "源仓 worktree list 不含克隆");
  assert.ok(!git(["for-each-ref", "refs/heads/wao/"], s.repo).includes("run_pc"), "源仓无克隆分支");
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_pc");
  assert.equal(item.action, "keep");
  assert.equal(item.category, "tree_protection");
  assert.equal(item.reason, "private_clone");
});

test("分类：转录绑定此目录但没有 worktreeForm（链接树形态的转录）→ foreign_worktree", async () => {
  const s = await scenario();
  const clone = await createReadOnlyClone(s.repo, "run_pc_nf", { commitish: s.mainCommit });
  s.seed("run_pc_nf", privateCloneRunEvents({ repo: s.repo, clone: clone.path, runId: "run_pc_nf", withForm: false }));
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_pc_nf");
  assert.equal(item.action, "keep");
  assert.equal(item.reason, "foreign_worktree");
});

test("分类：转录声明的树路径不是此目录（声明的是源仓）→ foreign_worktree", async () => {
  const s = await scenario();
  await createReadOnlyClone(s.repo, "run_pc_elsewhere", { commitish: s.mainCommit });
  s.seed("run_pc_elsewhere", privateCloneRunEvents({ repo: s.repo, clone: s.repo, runId: "run_pc_elsewhere" }));
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_pc_elsewhere");
  assert.equal(item.action, "keep");
  assert.equal(item.reason, "foreign_worktree");
});

test("分类：同样的克隆但无转录 → out_of_scope/foreign_worktree（认不出来源不误删）", async () => {
  const s = await scenario();
  seedLibraryDummy(s); // 转录库非空：空库+树目标会整体拒绝（8c）
  await createReadOnlyClone(s.repo, "run_pc_nt");
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_pc_nt");
  assert.equal(item.action, "keep");
  assert.equal(item.reason, "foreign_worktree");
});

test("分类：alternates 指向别处的克隆（转录谎报 private_clone）→ foreign_worktree", async () => {
  const s = await scenario();
  const other = await makeRepo("wao-reclaim-pc-foreign-");
  bases.push(other.repo);
  git(["clone", "--shared", "--no-checkout", "--quiet", "--", other.repo, join(s.repo, ".wao-worktrees", "run_alt")], other.repo);
  s.seed("run_alt", privateCloneRunEvents({ repo: s.repo, clone: join(s.repo, ".wao-worktrees", "run_alt"), runId: "run_alt" }));
  const { plan } = await s.plan();
  const item = oneItem(plan, "run_alt");
  assert.equal(item.action, "keep");
  assert.equal(item.reason, "foreign_worktree");
});

test("夹具：fixedNow 在一个测试进程内不前进（每次重读真实时钟时，写心跳到判新鲜一慢就过期）", async () => {
  const t0 = fixedNow();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fixedNow(), t0);
});
