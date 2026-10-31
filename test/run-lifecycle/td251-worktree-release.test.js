// test/run-lifecycle/td251-worktree-release.test.js
//
// TD-251（决定 0057，会审 consult_202610110709306023ro7zi opus+sol 修正案）钉：
// W1a——readOnly 强制隔离非复用轮=ephemeral，删除延迟到停止验证确认之后；
//       复用轮保持 persistent（kimi 会话 server 侧 cwd 钉首轮树——opus 反例）。
// W1b——验收放树四道门（tip 归属/路径证明/独立释放/事后验证）+ 分支保留。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { RunManager, Run } from "../../src/runManager.js";
import { JsonlTranscript } from "../../src/transcript.js";
import { recycleRunBranch } from "../../src/isolation.js";
import {
  worktreeReleaseVerdict,
  worktreeFactsFromEvents,
  makeAcceptedSessionRelease,
} from "../../src/application/upstreamSessionRelease.js";
import { deriveOpaqueUuid } from "../../src/application/sessionReuse.js";

function cleanupDir(dir) { rmSync(dir, { recursive: true, force: true }); }

const WT_EVENT_TYPES = [
  "run.worktree_released",
  "run.worktree_already_gone",
  "run.worktree_release_skipped",
  "run.worktree_release_failed",
];

// TD-260（0062 丙′）：分支回收事件族（树释放成功之后追加）。
const BRANCH_EVENT_TYPES = [
  "run.worktree_branch_recycled",
  "run.worktree_branch_kept",
];

// ===== W1a：readOnly ephemeral 延迟释放 =====

function fakeBackend({ handleExtra = {} } = {}) {
  return {
    supportsRoleContract: true,
    supportsSessionReuse: true,
    validateAgentPolicy() {},
    async spawn() {
      return {
        backend: "kimi-web",
        backendSessionId: "session_td251",
        events: async function* () {
          yield { kind: "message", parts: [{ type: "text", text: "ok" }] };
          yield { kind: "done", reason: "completed" };
        },
        abort: async () => {},
        ...handleExtra,
      };
    },
  };
}

function makeManager(dir, backend, { sessionReuse = undefined } = {}) {
  const readRegistry = async () => ({
    getAgent(id) { return { id, backend: "kimi-web", cwd: dir }; },
    listAgents() { return []; },
  });
  return new RunManager({
    config: {
      registry: "x", runDir: dir, pollInterval: 5, waitTimeout: 2000,
      timeout: 5000, retries: 0, defaultIsolation: "none",
    },
    readRegistry,
    transcriptDir: dir,
    backendFor: () => backend,
    ...(sessionReuse !== undefined ? {} : {}),
  });
}

test("TD-251 W1a: readOnly 非复用 run → ephemeral，completed+停止确认后树自动回收", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td251-ro-"));
  try {
    makeGitRepo(dir);
    const baseHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    // isAlive:false → verifyProcessExit quiet → stop_verified → 停止确认。
    const backend = fakeBackend({ handleExtra: { isAlive: () => false } });
    const mgr = makeManager(dir, backend);
    const run = await mgr.start("kimi", { prompt: "hi", readOnly: true, runId: "run_td251_ro1" });
    await run.waitForCompletion({});
    const events = readFileSync(run.transcript.filePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const started = events.find((e) => e.type === "run.started");
    assert.ok(started?.worktreePath, "readOnly 强制隔离在场");
    // TD-262（0063）：策略事实持久化——resume 恢复只认此字段（opus 条款）。
    assert.equal(started.worktreeStrategy, "ephemeral", "readOnly 非复用轮=ephemeral（resume 资格事实）");
    // 决定 0102：ephemeral 只读轮的树形态=私有克隆，绑定事实随 run.started 落盘。
    assert.equal(started.worktreeForm, "private_clone");
    assert.equal(started.worktreeBaseCommit, baseHead, "冻结基点=源仓 HEAD 完整 SHA");
    assert.ok(!existsSync(started.worktreePath), "停止确认后树已回收（延迟释放）");
    const wt = events.filter((e) => WT_EVENT_TYPES.includes(e.type));
    assert.deepEqual(wt.map((e) => e.type), ["run.worktree_released"]);
    assert.ok(events.some((e) => e.type === "run.stop_verified"), "停止确认事实在树释放之前");
    // 决定 0102：私有克隆不触发 0062 分支回收——分支活在克隆的 .git 里，源仓
    // 既没有登记也没有分支；克隆随目录删除一起消失。
    const br = events.filter((e) => BRANCH_EVENT_TYPES.includes(e.type));
    assert.deepEqual(br.map((e) => e.type), [], "私有克隆零分支回收事件");
    let branchMissing = false;
    try { execSync("git rev-parse refs/heads/wao/run_td251_ro1", { cwd: dir, stdio: "pipe" }); }
    catch { branchMissing = true; }
    assert.ok(branchMissing, "源仓没有克隆的分支（rev-parse 对缺失 ref 退出非零）");
  } finally { cleanupDir(dir); }
});

test("TD-251 W1a: 停止未确认（无 isAlive/session 探针缺席）→ 留树 + skipped{stop_unconfirmed}", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td251-unconf-"));
  try {
    makeGitRepo(dir);
    const backend = fakeBackend(); // 无 isAlive；session 探针路径 serveUrl 缺席 → 早退
    const mgr = makeManager(dir, backend);
    const run = await mgr.start("kimi", { prompt: "hi", readOnly: true, runId: "run_td251_uc1" });
    await run.waitForCompletion({});
    const events = readFileSync(run.transcript.filePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const started = events.find((e) => e.type === "run.started");
    assert.ok(existsSync(started.worktreePath), "停止未确认 → 留树（迟到收取窗口）");
    const wt = events.filter((e) => WT_EVENT_TYPES.includes(e.type));
    assert.deepEqual(wt.map((e) => [e.type, e.reason]), [["run.worktree_release_skipped", "stop_unconfirmed"]]);
  } finally { cleanupDir(dir); }
});

test("TD-251 W1a: sessionReuse 复用轮 → persistent（树保留、零 worktree 事件）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td251-reuse-"));
  try {
    makeGitRepo(dir);
    const backend = fakeBackend();
    const mgr = makeManager(dir, backend);
    const run = await mgr.start("kimi", {
      prompt: "hi",
      readOnly: true,
      runId: "run_td251_ru1",
      sessionReuse: { mode: "lead_workspace", opaqueUuid: deriveOpaqueUuid({ leadSession: "lead-td251", workspace: dir, agentId: "kimi" }), turn: "first" },
    });
    await run.waitForCompletion({});
    const events = readFileSync(run.transcript.filePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const started = events.find((e) => e.type === "run.started");
    assert.ok(started?.worktreePath, "复用轮仍有强制隔离");
    assert.equal(started.worktreeStrategy, "persistent", "复用轮=persistent（resume 不得误删——opus 反例）");
    assert.ok(existsSync(started.worktreePath), "复用轮树保留（kimi 会话 cwd 钉首轮树——opus 反例）");
    assert.equal(events.filter((e) => WT_EVENT_TYPES.includes(e.type)).length, 0, "零 worktree 事件");
  } finally { cleanupDir(dir); }
});

test("TD-251 W1a: 直接构造 Run——already_gone 与 still_present（removeWorktree 违约恒 resolve）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td251-direct-"));
  try {
    const mk = (extra) => {
      const filePath = join(dir, `run_${Math.random().toString(36).slice(2)}.jsonl`);
      const transcript = new JsonlTranscript(filePath, { runId: "run_x", agentId: "kimi", initialSeq: 0 });
      writeFileSync(filePath, "", "utf8");
      const handle = { backend: "kimi-web", backendSessionId: "s", events: async function* () {}, abort: async () => {} };
      return new Run({
        runId: "run_x", agentId: "kimi", agent: { id: "kimi", backend: "kimi-web", cwd: dir },
        backend: {}, handle, transcript, result: handle, config: {},
        onRemove: () => {}, initialState: "completed",
        ...(extra.deferredWorktreeRelease ? { deferredWorktreeRelease: extra.deferredWorktreeRelease } : {}),
        ...(extra.removeWorktreeForRelease ? { removeWorktreeForRelease: extra.removeWorktreeForRelease } : {}),
      });
    };
    // already_gone：路径不存在
    const gone = mk({ deferredWorktreeRelease: join(dir, "no-such-wt") });
    gone._stopQuietConfirmed = true;
    await gone._runCleanup();
    const goneEvents = readFileSync(gone.transcript.filePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(goneEvents.filter((e) => WT_EVENT_TYPES.includes(e.type)).map((e) => e.type), ["run.worktree_already_gone"]);

    // still_present：removeWorktree 违约不删（isolation.removeWorktree 恒 resolve——
    // "不抛错≠已删除"，opus Q2-3）
    const wtPath = join(dir, "wt-stub");
    mkdirSync(wtPath, { recursive: true });
    const stuck = mk({ deferredWorktreeRelease: wtPath, removeWorktreeForRelease: async () => {} });
    stuck._stopQuietConfirmed = true;
    await stuck._runCleanup();
    const stuckEvents = readFileSync(stuck.transcript.filePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(
      stuckEvents.filter((e) => WT_EVENT_TYPES.includes(e.type)).map((e) => [e.type, e.reason]),
      [["run.worktree_release_failed", "still_present"]],
    );
    // 幂等：双入不重复
    await stuck._runCleanup();
    assert.equal(readFileSync(stuck.transcript.filePath, "utf8").trim().split("\n")
      .filter((l) => l.includes("run.worktree_")).length, 1);
  } finally { cleanupDir(dir); }
});

// ===== W1b：验收放树四道门（纯函数 + 集成）=====

test("TD-251 W1b: worktreeReleaseVerdict 闭集（no_worktree/gone/unproven/not_tip/ready）", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wao-td251-vd-"));
  try {
    const wt = join(tmp, ".wao-worktrees", "run_x");
    mkdirSync(wt, { recursive: true });
    const C = "a".repeat(40);
    const gitOk = () => C;
    assert.equal(worktreeReleaseVerdict({ worktreePath: null, runId: "run_x", deliveryCommit: C }), "no_worktree");
    assert.equal(worktreeReleaseVerdict({ worktreePath: join(tmp, "gone-wt"), runId: "run_x", deliveryCommit: C }), "gone");
    // 形状外（父目录名不是 .wao-worktrees）
    const foreign = join(tmp, "plain", "run_x");
    mkdirSync(foreign, { recursive: true });
    assert.equal(worktreeReleaseVerdict({ worktreePath: foreign, runId: "run_x", deliveryCommit: C }), "unproven_path");
    // 符号链接/junction（lstat 报 isSymbolicLink——rmSync 兜底会穿透目标，sol）
    const link = join(tmp, "link-wt");
    execSync(`cmd /c mklink /J "${link}" "${wt}"`, { stdio: "ignore" });
    assert.equal(worktreeReleaseVerdict({ worktreePath: link, runId: "run_x", deliveryCommit: C, gitRev: gitOk }), "unproven_path");
    // tip 门三分支：分支不匹配 / HEAD 不匹配 / git 抛错 → not_tip
    assert.equal(worktreeReleaseVerdict({
      worktreePath: wt, runId: "run_x", deliveryCommit: C,
      gitRev: (_p, args) => (args[1] === "HEAD" ? C : "wao/run_other"),
    }), "not_tip", "分支已被子轮接管（wao/<childRunId>）→ not_tip");
    assert.equal(worktreeReleaseVerdict({
      worktreePath: wt, runId: "run_x", deliveryCommit: C,
      gitRev: (_p, args) => (args[1] === "HEAD" ? "b".repeat(40) : "wao/run_x"),
    }), "not_tip", "HEAD≠deliveryCommit（树上有验收后的新提交）→ not_tip");
    assert.equal(worktreeReleaseVerdict({
      worktreePath: wt, runId: "run_x", deliveryCommit: C,
      gitRev: () => { throw new Error("git unavailable"); },
    }), "not_tip", "git 不可读=归属不可证 → not_tip");
    // 全绿
    assert.equal(worktreeReleaseVerdict({
      worktreePath: wt, runId: "run_x", deliveryCommit: C,
      gitRev: (_p, args) => (args[1] === "HEAD" ? "A".repeat(40) : "wao/run_x"),
    }), "ready", "HEAD 大小写折叠比较");
  } finally { cleanupDir(tmp); }
});

test("TD-251 W1b: makeAcceptedSessionRelease Part B 独立于 Part A（无能力也放树）+ released 事件", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wao-td251-rel-"));
  try {
    const wt = join(tmp, ".wao-worktrees", "run_acc1");
    mkdirSync(wt, { recursive: true });
    const appended = [];
    const transcript = { async append(type, payload) { appended.push({ type, payload }); } };
    const release = makeAcceptedSessionRelease({
      registryPath: "/r.json",
      readRegistryFn: async () => { throw new Error("registry down"); }, // Part A 全灭
      removeWorktreeFn: async (p) => { rmSync(p, { recursive: true, force: true }); },
      gitRev: (_p, args) => (args[1] === "HEAD" ? "d".repeat(40) : "wao/run_acc1"),
    });
    const out = await release({
      runId: "run_acc1",
      agentId: "kimi",
      events: [
        { type: "run.started", runId: "run_acc1", worktreePath: wt, cwd: tmp, seq: 1 },
        { type: "session.created", backend: "kimi-web", backendSessionId: "session_lin", runId: "run_acc1", seq: 2 },
      ],
      transcript,
      deliveryCommit: "d".repeat(40),
    });
    assert.equal(out.session, false, "Part A 静默 no-op");
    assert.equal(out.worktree, "released");
    assert.deepEqual(appended.map((a) => a.type), ["run.worktree_released"], "Part B 照常（独立释放——sol）");
    assert.ok(!existsSync(wt));
  } finally { cleanupDir(tmp); }
});

test("TD-251 W1b: 集成——真 git 仓真 worktree，accepted 放树且 wao/<runId> 分支保留", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wao-td251-git-"));
  try {
    makeGitRepo(tmp);
    const runId = "run_acc2";
    const wt = join(tmp, ".wao-worktrees", runId);
    execSync(`git worktree add -b wao/${runId} "${wt}"`, { cwd: tmp, stdio: "ignore" });
    execSync(`git commit --allow-empty -m x`, { cwd: wt, stdio: "ignore" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt }).toString().trim();
    const appended = [];
    const transcript = { async append(type, payload) { appended.push({ type, payload }); } };
    const release = makeAcceptedSessionRelease({ registryPath: "/r.json" });
    const out = await release({
      runId,
      agentId: "unknown", // Part A 无席位解析 → no-op
      events: [{ type: "run.started", runId, worktreePath: wt, cwd: tmp, seq: 1 }],
      transcript,
      deliveryCommit: head,
    });
    assert.equal(out.worktree, "released");
    assert.ok(!existsSync(wt), "真 worktree 已删");
    // 分支保留（accepted commit 可达性——opus Q2-7）
    const branchOk = execFileSync("git", ["rev-parse", "--verify", `refs/heads/wao/${runId}`], { cwd: tmp }).toString().trim();
    assert.ok(branchOk.length >= 7, "wao/<runId> 分支仍在");
    assert.deepEqual(appended.map((a) => a.type), ["run.worktree_released"]);
  } finally { cleanupDir(tmp); }
});

// ===== 辅助 =====

function makeGitRepo(dir) {
  execSync("git init -q", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "t@t"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "t"', { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "a.txt"), "a\n", "utf8");
  execSync("git add . && git commit -qm init", { cwd: dir, stdio: "ignore" });
}

// worktreeFactsFromEvents 顺带钉（绑定事实提取）。
test("TD-251 W1b: worktreeFactsFromEvents 取绑定 run.started 的树路径与仓库锚", () => {
  const { worktreePath, repoCwd } = worktreeFactsFromEvents([
    { type: "run.metrics" },
    { type: "run.started", worktreePath: "D:\\p\\.wao-worktrees\\run_1", cwd: "D:\\p", seq: 1 },
  ]);
  assert.equal(worktreePath, "D:\\p\\.wao-worktrees\\run_1");
  assert.equal(repoCwd, "D:\\p");
  assert.deepEqual(worktreeFactsFromEvents([]), { worktreePath: null, repoCwd: null });
  assert.deepEqual(worktreeFactsFromEvents(null), { worktreePath: null, repoCwd: null });
});

// ===== TD-260（决定 0062 丙′，审核修订）：ephemeral 只读轮零独有分支回收 =====

test("TD-260 丙′: recycleRunBranch 形状（真 git 仓：absent/recycled/kept_unique + 注入 probe/delete 失败）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td260-unit-"));
  try {
    makeGitRepo(dir);
    // absent：分支不存在（rev-parse exit 1）
    assert.deepEqual(recycleRunBranch(dir, "run_nobranch"), { outcome: "absent" });

    // probe 失败（git 不可用等非 exit-1 错误）→ kept{probe_failed}，不得折叠为 absent（sol 审核条款）
    const probeGone = recycleRunBranch(dir, "run_nobranch", {
      execFn: () => { const e = new Error("spawn ENOENT"); return (() => { throw e; })(); },
    });
    assert.deepEqual(probeGone, { outcome: "kept", reason: "probe_failed" });

    // zero-unique：分支=HEAD 同点（无 worker 提交）→ recycled + 分支消失
    execSync("git branch wao/run_z1", { cwd: dir, stdio: "ignore" });
    assert.deepEqual(recycleRunBranch(dir, "run_z1"), { outcome: "recycled" });
    let z1Gone = false;
    try { execSync("git rev-parse refs/heads/wao/run_z1", { cwd: dir, stdio: "ignore" }); }
    catch { z1Gone = true; }
    assert.ok(z1Gone, "零独有分支已物理删除");

    // kept_unique：分支上有一个 worker 提交 → kept{uniqueCommits:1} + 分支保留
    execSync("git checkout -q -b wao/run_u1", { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "u.txt"), "u\n", "utf8");
    execSync("git add . && git commit -qm u1", { cwd: dir, stdio: "ignore" });
    execSync("git checkout -q -", { cwd: dir, stdio: "ignore" }); // 回默认分支（main/master）
    const kept = recycleRunBranch(dir, "run_u1");
    assert.deepEqual(kept, { outcome: "kept", uniqueCommits: 1 });
    execSync("git rev-parse refs/heads/wao/run_u1", { cwd: dir, stdio: "ignore" });
    // 违规提交的证据可达性必须保留（readOnly 声明不强制——0057 Q2-7 边界收窄）。

    // 同名 tag 遮蔽钉（判别形）：分支 wao/run_u1 带独有提交 B；同名 tag 指向
    // main 基点——短名解析 tag 优先会数成 0（灾难性误删），正向 revision 用
    // 全名 refs/heads/… 必须仍判 kept（opus 审核条款）。
    const mainTip = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
    execSync("git tag wao/run_u1 " + mainTip, { cwd: dir, stdio: "ignore" });
    assert.deepEqual(recycleRunBranch(dir, "run_u1"), { outcome: "kept", uniqueCommits: 1 },
      "同名 tag 遮蔽下按全名判定——独有提交不可因 tag 解析优先而误删");
    execSync("git tag -d wao/run_u1", { cwd: dir, stdio: "ignore" });

    // 计数解析拒绝空输出（注入缝不得伪造 0——sol 审核条款）
    execSync("git branch wao/run_e1", { cwd: dir, stdio: "ignore" });
    const emptyCount = recycleRunBranch(dir, "run_e1", {
      execFn: (cmd, args) => {
        if (args[0] === "rev-list") return "";
        return execFileSync(cmd, args, { cwd: dir, windowsHide: true });
      },
    });
    assert.deepEqual(emptyCount, { outcome: "kept", reason: "probe_failed" });

    // 零独有 + 同名 tag 正例：tag 与分支同在 HEAD → 全名计数 0 → recycled
    //（tag 不在排除集，不挡零独有分支回收——tag 覆盖的提交仍在）。
    execSync("git tag wao/run_t1", { cwd: dir, stdio: "ignore" });
    execSync("git branch wao/run_t1", { cwd: dir, stdio: "ignore" });
    assert.deepEqual(recycleRunBranch(dir, "run_t1"), { outcome: "recycled" });
    execSync("git tag -d wao/run_t1", { cwd: dir, stdio: "ignore" });

    // delete 失败：branch -d 抛错 → kept{reason:"delete_failed"}
    execSync("git branch wao/run_d1", { cwd: dir, stdio: "ignore" });
    const deleteFail = recycleRunBranch(dir, "run_d1", {
      execFn: (cmd, args) => {
        if (args[0] === "branch") throw new Error("delete refused");
        return execFileSync(cmd, args, { cwd: dir, windowsHide: true });
      },
    });
    assert.deepEqual(deleteFail, { outcome: "kept", reason: "delete_failed" });

    // 非法 runId → absent（不触 git）
    assert.deepEqual(recycleRunBranch(dir, "../escape"), { outcome: "absent" });
  } finally { cleanupDir(dir); }
});

test("TD-260 丙′: 直接构造 Run——树释放成功后 kept{uniqueCommits}（独有提交保留+事件）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td260-run-"));
  try {
    makeGitRepo(dir);
    const runId = "run_k1";
    const wt = join(dir, ".wao-worktrees", runId);
    execSync(`git worktree add -b wao/${runId} "${wt}"`, { cwd: dir, stdio: "ignore" });
    writeFileSync(join(wt, "k.txt"), "k\n", "utf8");
    execSync("git add . && git commit -qm k1", { cwd: wt, stdio: "ignore" }); // 分支 1 个独有提交
    const filePath = join(dir, `${runId}.jsonl`);
    const transcript = new JsonlTranscript(filePath, { runId, agentId: "kimi", initialSeq: 0 });
    writeFileSync(filePath, "", "utf8");
    const handle = { backend: "kimi-web", backendSessionId: "s", events: async function* () {}, abort: async () => {}, isAlive: () => false };
    const run = new Run({
      runId, agentId: "kimi", agent: { id: "kimi", backend: "kimi-web", cwd: dir },
      backend: {}, handle, transcript, result: handle, config: {},
      onRemove: () => {}, initialState: "completed",
      deferredWorktreeRelease: wt,
    });
    run._stopQuietConfirmed = true;
    await run._runCleanup();
    const events = readFileSync(filePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(
      events.filter((e) => [...WT_EVENT_TYPES, ...BRANCH_EVENT_TYPES].includes(e.type)).map((e) => [e.type, e.uniqueCommits ?? e.reason]),
      [["run.worktree_released", undefined], ["run.worktree_branch_kept", 1]],
      "先放树、后保留独有分支并记数",
    );
    execSync(`git rev-parse refs/heads/wao/${runId}`, { cwd: dir, stdio: "ignore" });
    assert.ok(!existsSync(wt), "树已删");
  } finally { cleanupDir(dir); }
});

test("TD-260 丙′（审核修订）: skipped/still_present 臂不调分支回收；already_gone 臂调（spy 钉）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td260-spy-"));
  try {
    makeGitRepo(dir);
    const mk = (extra) => {
      const filePath = join(dir, `run_${Math.random().toString(36).slice(2)}.jsonl`);
      const transcript = new JsonlTranscript(filePath, { runId: "run_x", agentId: "kimi", initialSeq: 0 });
      writeFileSync(filePath, "", "utf8");
      const handle = { backend: "kimi-web", backendSessionId: "s", events: async function* () {}, abort: async () => {} };
      const calls = [];
      const run = new Run({
        runId: "run_x", agentId: "kimi", agent: { id: "kimi", backend: "kimi-web", cwd: dir },
        backend: {}, handle, transcript, result: handle, config: {},
        onRemove: () => {}, initialState: "completed",
        ...(extra.deferredWorktreeRelease ? { deferredWorktreeRelease: extra.deferredWorktreeRelease } : {}),
        ...(extra.removeWorktreeForRelease ? { removeWorktreeForRelease: extra.removeWorktreeForRelease } : {}),
        recycleBranchForRelease: (...a) => { calls.push(a); return { outcome: "absent" }; },
      });
      return { run, calls };
    };
    // skipped（停止未确认）：不回收。
    const wtPath = join(dir, "wt-skipped");
    mkdirSync(wtPath, { recursive: true });
    const skipped = mk({ deferredWorktreeRelease: wtPath });
    await skipped.run._runCleanup();
    assert.equal(skipped.calls.length, 0, "stop_unconfirmed 臂不得触发分支回收（迟到收取窗）");

    // still_present（removeWorktree 违约）：不回收（树在，分支多半被检出）。
    const stuckPath = join(dir, "wt-stuck");
    mkdirSync(stuckPath, { recursive: true });
    const stuck = mk({ deferredWorktreeRelease: stuckPath, removeWorktreeForRelease: async () => {} });
    stuck.run._stopQuietConfirmed = true;
    await stuck.run._runCleanup();
    assert.equal(stuck.calls.length, 0, "still_present 臂不回收——留待荚清扫/普查（TD-262）");

    // already_gone（树已不在）：回收开放（opus 审核条款）。
    const gone = mk({ deferredWorktreeRelease: join(dir, "no-such-wt") });
    gone.run._stopQuietConfirmed = true;
    await gone.run._runCleanup();
    assert.equal(gone.calls.length, 1, "already_gone 臂（停止确认后）开放分支回收");
  } finally { cleanupDir(dir); }
});

test("TD-262（0062 审核轮）: readOnly 轮 spawn 失败 → 树清理（决定 0102：私有克隆形态）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td262-spawn-"));
  try {
    makeGitRepo(dir);
    const backend = {
      supportsRoleContract: true,
      validateAgentPolicy() {},
      async spawn() { throw new Error("serve down"); },
    };
    const mgr = makeManager(dir, backend);
    await assert.rejects(
      mgr.start("kimi", { prompt: "hi", readOnly: true, runId: "run_td262_s1" }),
      /serve down/,
      "spawn 失败照常上抛（语义不变）",
    );
    // D2-②b 分桶布局：转录落在 <dir>/projects/<slug>/ 下——递归定位。
    let tPath = null;
    const find = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) find(p);
        else if (e.name === "run_td262_s1.jsonl") tPath = p;
      }
    };
    find(dir);
    assert.ok(tPath, "spawn 失败轮转录在场");
    const events = readFileSync(tPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(!existsSync(join(dir, ".wao-worktrees", "run_td262_s1")), "spawn 失败后克隆已清理");
    assert.deepEqual(
      events.filter((e) => [...WT_EVENT_TYPES, ...BRANCH_EVENT_TYPES].includes(e.type)).map((e) => e.type),
      ["run.worktree_released"],
      "spawn 失败轮：released 事件入账（克隆不再泄漏——opus 实锤修复）；分支回收不适用（决定 0102）",
    );
    let branchGone = false;
    try { execSync("git rev-parse refs/heads/wao/run_td262_s1", { cwd: dir, stdio: "pipe" }); }
    catch { branchGone = true; }
    assert.ok(branchGone, "源仓没有克隆的分支");
  } finally { cleanupDir(dir); }
});
