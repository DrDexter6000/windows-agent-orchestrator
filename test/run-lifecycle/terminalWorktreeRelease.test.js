// test/run-lifecycle/terminalWorktreeRelease.test.js
//
// 终态零丢失自动回收（只删树，分支一律保留）——第四条树回收路径：
//   - 能删：干净、无复用、无线系、无交付、无人占用的普通 persistent 隔离运行，
//     终态收尾后确实释放（不是永远保留）；从关联工作树派发的树同样可回收
//     （身份锚 = 本 run 自己的派发目录，不是主检出）；
//   - 内容：staged/unstaged/untracked/ignored 各一种 + detached/HEAD 漂移 → 保留
//     并给出对应闭集原因；
//   - 用途：sessionReuse 路由、线系成员、delivery_created（undecided/rejected/
//     accepted）→ 零事件保留；打包失败（delivery_failed、无 delivery_created），
//     树全净 → 回收，树有改动 → content_present 保留；
//   - 占用：别的尚未终态 run 的 cwd/worktreePath 在本树上（含等于树根、跨项目
//     桶、树共享形状）→ tree_in_use 保留；那个 run 已终态 → 正常回收；来源
//     读不出、存储根不在、尚未终态且位置证不了 → occupancy_unprovable 保留；
//     别的 run 混写进来的事件不算数；已终态的坏转录不挡回收；
//   - 时序：停止未确认 / 终态未落盘 → 不删；
//   - 占用：删除失败（EPERM 同型）与删后目录仍在 → still_present 保留，不强删，
//     分支不动；
//   - 结构：登记在册嵌套树（含目录已消失的悬空登记）→ nested_tree_present；
//   - 幂等：重复 cleanup / already_gone → 每 run 恰一条。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { RunManager, Run, worktreeOccupiedByOtherRuns } from "../../src/runManager.js";
import { JsonlTranscript } from "../../src/transcript.js";
import { removeWorktreeNoForce, terminalWorktreeVerdict } from "../../src/isolation.js";
import { listTranscriptsDeep } from "../../src/projectBuckets.js";

function cleanupDir(dir) { rmSync(dir, { recursive: true, force: true }); }

const WT_EVENT_TYPES = [
  "run.worktree_released",
  "run.worktree_already_gone",
  "run.worktree_release_skipped",
  "run.worktree_release_failed",
];

function makeGitRepo(dir) {
  execSync("git init -q", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "t@t"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "t"', { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "a.txt"), "a\n", "utf8");
  writeFileSync(join(dir, ".gitignore"), "*.log\n", "utf8");
  execSync("git add . && git commit -qm init", { cwd: dir, stdio: "ignore" });
  // 生产形状：.wao-worktrees/ 是仓库级 exclude 稳定规则（createWorktree 侧写入）。
  execSync("echo /.wao-worktrees/ >> .git/info/exclude", { cwd: dir, stdio: "ignore" });
}

function addWorktree(repo, runId) {
  const wt = join(repo, ".wao-worktrees", runId);
  execSync(`git worktree add -q -b wao/${runId} "${wt}"`, { cwd: repo, stdio: "ignore" });
  return wt;
}

/** 直接构造 Run（转录事实驱动），默认形状：persistent 隔离 + 终态 completed 落盘。 */
async function makeRun({
  repo, runId, wt, events = [], stopConfirmed = true, removeFn, terminal = true,
}) {
  const filePath = join(repo, `${runId}.jsonl`);
  const transcript = new JsonlTranscript(filePath, { runId, agentId: "kimi", initialSeq: 0 });
  writeFileSync(filePath, "", "utf8");
  const handle = { backend: "kimi-web", backendSessionId: "s", events: async function* () {}, abort: async () => {} };
  const run = new Run({
    runId, agentId: "kimi", agent: { id: "kimi", backend: "kimi-web", cwd: repo },
    backend: {}, handle, transcript, result: handle, config: {},
    onRemove: () => {}, initialState: "completed",
    // 占用扫描的运行存储根：测试里转录就写在 repo（即 runsRoot）下。
    runsRoot: repo,
    ...(removeFn ? { removeWorktreeForTerminalRelease: removeFn } : {}),
  });
  // 基线事实：persistent 隔离绑定（+ 默认终态 completed 落盘）。额外事件由调用方追加。
  const baseline = [
    ["run.started", {
      cwd: repo, worktreePath: wt, worktreeBranch: `wao/${runId}`, worktreeStrategy: "persistent",
    }],
    ...(terminal ? [["run.state_change", { from: "running", to: "completed", reason: "done" }]] : []),
  ];
  for (const [type, payload] of [...baseline, ...events]) {
    await transcript.append(type, payload);
  }
  run._stopQuietConfirmed = stopConfirmed === true;
  return { run, filePath };
}

function readEvents(filePath) {
  return readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function wtEvents(events) {
  return events.filter((e) => WT_EVENT_TYPES.includes(e.type)).map((e) => [e.type, e.reason]);
}

function branchExists(repo, runId) {
  try {
    execSync(`git rev-parse refs/heads/wao/${runId}`, { cwd: repo, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** 写一个"别的 run"的转录（占用扫描的证据面）。bucket=null 写根层，否则写
 * projects/<bucket>/（跨项目桶——run 的桶由它的 cwd 决定，与 A 不同桶）。 */
async function writeForeignRun({ dir, bucket = null, runId, started, events = [] }) {
  const target = bucket === null ? dir : join(dir, "projects", bucket);
  mkdirSync(target, { recursive: true });
  const filePath = join(target, `${runId}.jsonl`);
  const transcript = new JsonlTranscript(filePath, { runId, agentId: "kimi", initialSeq: 0 });
  writeFileSync(filePath, "", "utf8");
  await transcript.append("run.started", started);
  for (const [type, payload] of events) {
    await transcript.append(type, payload);
  }
  return filePath;
}

// ===== 能删：集成（RunManager.start，真 git 仓）=====

function fakeBackend() {
  return {
    supportsRoleContract: true,
    supportsSessionReuse: true,
    validateAgentPolicy() {},
    async spawn() {
      return {
        backend: "kimi-web",
        backendSessionId: "session_twr",
        events: async function* () {
          yield { kind: "message", parts: [{ type: "text", text: "ok" }] };
          yield { kind: "done", reason: "completed" };
        },
        abort: async () => {},
        isAlive: () => false, // 停止验证静默 → stop_verified → 停止确认
      };
    },
  };
}

function makeManager(dir, backend) {
  return new RunManager({
    config: {
      registry: "x", runDir: dir, pollInterval: 5, waitTimeout: 2000,
      timeout: 5000, retries: 0, defaultIsolation: "none",
    },
    readRegistry: async () => ({ getAgent: (id) => ({ id, backend: "kimi-web", cwd: dir }), listAgents: () => [] }),
    transcriptDir: dir,
    backendFor: () => backend,
  });
}

test("终态自动回收: 普通 persistent 隔离运行，干净收尾后树释放、分支保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-rel-"));
  try {
    makeGitRepo(dir);
    const backend = fakeBackend();
    const mgr = makeManager(dir, backend);
    const run = await mgr.start("kimi", { prompt: "hi", isolate: true, runId: "run_twr_ok1" });
    await run.waitForCompletion({});
    const events = readEvents(run.transcript.filePath);
    const started = events.find((e) => e.type === "run.started");
    assert.equal(started.worktreeStrategy, "persistent");
    assert.ok(!existsSync(started.worktreePath), "干净普通隔离树在收尾后确实释放");
    assert.deepEqual(wtEvents(events), [["run.worktree_released", undefined]], "恰好一条 released");
    assert.ok(events.some((e) => e.type === "run.stop_verified"), "停止确认在树释放之前");
    assert.ok(branchExists(dir, "run_twr_ok1"), "分支一律保留（与只读树释放后的分支回收不同）");
    assert.ok(events.some((e) => e.type === "run.cleanup_done"), "cleanup 序列不受影响");
  } finally { cleanupDir(dir); }
});

test("终态自动回收: 从关联工作树派发、树全净 → 回收，分支保留（身份锚=本 run 派发目录）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-lw-"));
  const linked = mkdtempSync(join(tmpdir(), "wao-twr-lw-link-"));
  try {
    makeGitRepo(dir);
    // 关联工作树（派发目录形状，如 .dev/wt/<批>）——树登记在同一 common git dir
    execSync(`git worktree add -q -b lwbase "${linked}"`, { cwd: dir, stdio: "ignore" });
    // 本 run 的树建在 linked/.wao-worktrees/<runId>（createWorktree 的恒定形状）
    const wt = join(linked, ".wao-worktrees", "run_twr_lw1");
    execSync(`git worktree add -q -b wao/run_twr_lw1 "${wt}"`, { cwd: linked, stdio: "ignore" });
    const r = await makeRun({ repo: linked, runId: "run_twr_lw1", wt });
    await r.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(r.filePath)),
      [["run.worktree_released", undefined]], "关联工作树下的树不再 unproven_path");
    assert.ok(!existsSync(wt), "树确实释放");
    assert.ok(branchExists(dir, "run_twr_lw1"), "分支保留（refs 在共享 common git dir）");
  } finally {
    cleanupDir(linked);
    cleanupDir(dir);
  }
});

test("终态自动回收: sessionReuse 路由在场 → 零事件保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-reuse-"));
  try {
    makeGitRepo(dir);
    const { deriveOpaqueUuid } = await import("../../src/application/sessionReuse.js");
    const mgr = makeManager(dir, fakeBackend());
    const run = await mgr.start("kimi", {
      prompt: "hi", isolate: true, runId: "run_twr_ru1",
      sessionReuse: { mode: "lead_workspace", opaqueUuid: deriveOpaqueUuid({ leadSession: "lead-twr", workspace: dir, agentId: "kimi" }), turn: "first" },
    });
    await run.waitForCompletion({});
    const events = readEvents(run.transcript.filePath);
    const started = events.find((e) => e.type === "run.started");
    assert.ok(existsSync(started.worktreePath), "复用轮树保留");
    assert.equal(wtEvents(events).length, 0, "零 worktree 事件（非本臂对象）");
  } finally { cleanupDir(dir); }
});

test("终态自动回收: readOnly ephemeral 轮仍走只读树释放（W1a 行为不变，本臂零增量事件）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-ro-"));
  try {
    makeGitRepo(dir);
    const mgr = makeManager(dir, fakeBackend());
    const run = await mgr.start("kimi", { prompt: "hi", readOnly: true, runId: "run_twr_ro1" });
    await run.waitForCompletion({});
    const events = readEvents(run.transcript.filePath);
    const types = events.filter((e) => WT_EVENT_TYPES.includes(e.type)).map((e) => e.type);
    assert.deepEqual(types, ["run.worktree_released"], "只读轮的释放事实仍是 W1a 的那一条");
    assert.ok(!existsSync(join(dir, ".wao-worktrees", "run_twr_ro1")));
  } finally { cleanupDir(dir); }
});

// ===== 用途门：零事件保留 =====

test("终态自动回收: 线系成员（run_lineage）与交付打包轮 → 零事件保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-scope-"));
  try {
    makeGitRepo(dir);
    const mk = async (runId, extra) => {
      const wt = addWorktree(dir, runId);
      return makeRun({ repo: dir, runId, wt, events: extra });
    };
    // 线系根（run_lineage first）
    const lin = await mk("run_twr_lin1", [["run.session_reuse", { mode: "run_lineage", turn: "first", rootRunId: "run_twr_lin1" }]]);
    await lin.run._runCleanup();
    assert.equal(wtEvents(readEvents(lin.filePath)).length, 0, "线系根零事件");
    assert.ok(existsSync(join(dir, ".wao-worktrees", "run_twr_lin1")), "线系根树保留");

    // 线系子轮（background_submitted 携 rootRunId）
    const child = await mk("run_twr_lin2", [["run.background_submitted", { background: true, continuation: true, parentRunId: "run_twr_lin1", rootRunId: "run_twr_lin1" }]]);
    await child.run._runCleanup();
    assert.equal(wtEvents(readEvents(child.filePath)).length, 0, "线系子轮零事件");
    assert.ok(existsSync(join(dir, ".wao-worktrees", "run_twr_lin2")));

    // 交付打包轮：undecided / rejected / accepted 三形一律不碰
    for (const [name, extra] of [
      ["undecided", []],
      ["rejected", [["run.delivery_rejected", { reason: "nope" }]]],
      ["accepted", [["run.delivery_accepted", { reason: "ok" }]]],
    ]) {
      const runId = `run_twr_dlv_${name}`;
      const wt = addWorktree(dir, runId);
      const d = await makeRun({ repo: dir, runId, wt, events: [["run.delivery_created", { delivery: { deliveryCommit: "a".repeat(40) } }], ...extra] });
      await d.run._runCleanup();
      assert.equal(wtEvents(readEvents(d.filePath)).length, 0, `${name} 交付轮零事件`);
      assert.ok(existsSync(wt), `${name} 交付树保留（处置权在 Lead）`);
    }
  } finally { cleanupDir(dir); }
});

// ===== 打包失败的交付运行（无 delivery_created → 本臂适用对象）=====

test("终态自动回收: 打包失败、树全净的交付运行 → 回收分支保留；树有改动 → content_present 保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-pf-"));
  try {
    makeGitRepo(dir);
    const mkDlv = async (runId, dirty) => {
      const wt = addWorktree(dir, runId);
      if (dirty) writeFileSync(join(wt, "u.txt"), "u\n", "utf8");
      return makeRun({
        repo: dir, runId, wt, terminal: false,
        events: [
          ["run.delivery_failed", { error: "empty diff", errorClass: "empty_diff" }],
          ["run.state_change", { from: "running", to: "failed", reason: "delivery_failed" }],
        ],
      });
    };
    // 树全净（如 empty diff 打包失败）→ 回收，分支保留
    const clean = await mkDlv("run_twr_pf1", false);
    await clean.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(clean.filePath)),
      [["run.worktree_released", undefined]], "打包失败但树全净 → 回收");
    assert.ok(branchExists(dir, "run_twr_pf1"), "分支保留");

    // 树有改动（未提交的 worker 产物留在树上）→ content_present
    const dirty = await mkDlv("run_twr_pf2", true);
    await dirty.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(dirty.filePath)),
      [["run.worktree_release_skipped", "content_present"]], "打包失败且树脏 → 保留");
    assert.ok(existsSync(join(dir, ".wao-worktrees", "run_twr_pf2", "u.txt")), "产物不被强删");
    assert.ok(branchExists(dir, "run_twr_pf2"));
  } finally { cleanupDir(dir); }
});

// ===== 时序门 =====

test("终态自动回收: 停止未确认 → skipped{stop_unconfirmed}；终态未落盘 → skipped{state_unproven}", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-timing-"));
  try {
    makeGitRepo(dir);
    // 停止未确认：留树（迟到收取窗口，W1a 同款门）
    const wt1 = addWorktree(dir, "run_twr_uc1");
    const uc = await makeRun({ repo: dir, runId: "run_twr_uc1", wt: wt1, stopConfirmed: false });
    await uc.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(uc.filePath)), [["run.worktree_release_skipped", "stop_unconfirmed"]]);
    assert.ok(existsSync(wt1));

    // 终态未落盘（转录无终态 state_change）
    const wt2 = addWorktree(dir, "run_twr_st1");
    const st = await makeRun({ repo: dir, runId: "run_twr_st1", wt: wt2, terminal: false });
    await st.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(st.filePath)), [["run.worktree_release_skipped", "state_unproven"]]);
    assert.ok(existsSync(wt2), "终态未落盘 → 留树");
  } finally { cleanupDir(dir); }
});

// ===== "不在使用中"门（运行存储占用扫描）=====

test("终态自动回收: 别的尚未终态 run 的 cwd 在本树内/等于树根 → tree_in_use；树共享形状同；该 run 已终态 → 正常回收", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-use-"));
  try {
    makeGitRepo(dir);
    // B1：cwd 严格在树内，落在**另一个项目桶**（run 的桶由它的 cwd 决定）
    const wt1 = addWorktree(dir, "run_twr_use1");
    await writeForeignRun({
      dir, bucket: "otherproj-11111111", runId: "run_twr_user1",
      started: { cwd: join(wt1, "subdir"), backend: "kimi-web" },
    });
    const u1 = await makeRun({ repo: dir, runId: "run_twr_use1", wt: wt1 });
    await u1.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(u1.filePath)),
      [["run.worktree_release_skipped", "tree_in_use"]], "树内 cwd → 占用保留");
    assert.equal(readEvents(u1.filePath).find((e) => e.type === "run.worktree_release_skipped")?.byRunId,
      "run_twr_user1", "事件带占用者 runId");
    assert.ok(existsSync(wt1), "被占用树保留");
    assert.ok(branchExists(dir, "run_twr_use1"));

    // B2：cwd 恰好等于树根
    const wt2 = addWorktree(dir, "run_twr_use2");
    await writeForeignRun({
      dir, bucket: "otherproj-11111111", runId: "run_twr_user2",
      started: { cwd: wt2, backend: "kimi-web" },
    });
    const u2 = await makeRun({ repo: dir, runId: "run_twr_use2", wt: wt2 });
    await u2.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(u2.filePath)),
      [["run.worktree_release_skipped", "tree_in_use"]], "cwd=树根 → 占用保留");
    assert.ok(existsSync(wt2));

    // B3：worktreePath 恰好等于本树（树共享形状——cwd 在别处、树被声明为本树）
    const wt3 = addWorktree(dir, "run_twr_use3");
    await writeForeignRun({
      dir, bucket: "otherproj-11111111", runId: "run_twr_user3",
      started: { cwd: dir, backend: "kimi-web", worktreePath: wt3, worktreeStrategy: "persistent" },
    });
    const u3 = await makeRun({ repo: dir, runId: "run_twr_use3", wt: wt3 });
    await u3.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(u3.filePath)),
      [["run.worktree_release_skipped", "tree_in_use"]], "树共享 → 占用保留");
    assert.ok(existsSync(wt3));

    // B4：cwd 在树内但**已终态** → 不构成占用，A 正常回收
    const wt4 = addWorktree(dir, "run_twr_use4");
    await writeForeignRun({
      dir, bucket: "otherproj-11111111", runId: "run_twr_user4",
      started: { cwd: join(wt4, "x"), backend: "kimi-web" },
      events: [["run.state_change", { from: "running", to: "completed", reason: "done" }]],
    });
    const u4 = await makeRun({ repo: dir, runId: "run_twr_use4", wt: wt4 });
    await u4.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(u4.filePath)),
      [["run.worktree_released", undefined]], "占用者已终态 → 正常回收");
    assert.ok(!existsSync(wt4));
    assert.ok(branchExists(dir, "run_twr_use4"), "分支保留");
  } finally { cleanupDir(dir); }
});

test("终态自动回收: 占用证据来源读不出（桶内转录无派发事实）→ 按占用保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-src-"));
  try {
    makeGitRepo(dir);
    const wt = addWorktree(dir, "run_twr_use5");
    const r = await makeRun({ repo: dir, runId: "run_twr_use5", wt });
    // 破坏源放在证据面里（run_ 前缀、占用扫描头读窗内无可解析派发事实）
    const broken = join(dir, "projects", "broken-22222222", "run_twr_garbage.jsonl");
    mkdirSync(dirname(broken), { recursive: true });
    writeFileSync(broken, "{not-json\n", "utf8");
    await r.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(r.filePath)),
      [["run.worktree_release_skipped", "occupancy_unprovable"]], "来源读不出 → fail-closed 保留，原因与确有占用分开");
    assert.ok(existsSync(wt));
  } finally { cleanupDir(dir); }
});

test("终态自动回收: 占用路径大小写形态不同（不在盘上，词法兜底）→ 仍按占用保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-case-"));
  try {
    makeGitRepo(dir);
    const wt = addWorktree(dir, "run_twr_use6");
    // cwd 不在盘上（realpath 不可得 → 词法锚），且大小写形态与树不同
    await writeForeignRun({
      dir, bucket: "otherproj-33333333", runId: "run_twr_user6",
      started: { cwd: join(wt.toUpperCase(), "SUB"), backend: "kimi-web" },
    });
    const r = await makeRun({ repo: dir, runId: "run_twr_use6", wt });
    await r.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(r.filePath)),
      [["run.worktree_release_skipped", "tree_in_use"]], "大小写折叠 + 词法兜底命中");
    assert.ok(existsSync(wt));
  } finally { cleanupDir(dir); }
});

// ===== 内容门：四种内容 + HEAD 形态 =====

test("终态自动回收: staged/unstaged/untracked/ignored 各一种 → skipped{content_present}", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-content-"));
  try {
    makeGitRepo(dir);
    const cases = [
      ["staged", (wt) => {
        writeFileSync(join(wt, "s.txt"), "s\n", "utf8");
        execSync("git add s.txt", { cwd: wt, stdio: "ignore" });
      }],
      ["unstaged", (wt) => {
        writeFileSync(join(wt, "a.txt"), "changed\n", "utf8");
      }],
      ["untracked", (wt) => {
        writeFileSync(join(wt, "u.txt"), "u\n", "utf8");
      }],
      ["ignored", (wt) => {
        writeFileSync(join(wt, "x.log"), "log\n", "utf8"); // .gitignore 覆盖 *.log
      }],
    ];
    for (const [name, dirty] of cases) {
      const runId = `run_twr_c_${name}`;
      const wt = addWorktree(dir, runId);
      dirty(wt);
      const r = await makeRun({ repo: dir, runId, wt });
      await r.run._runCleanup();
      assert.deepEqual(wtEvents(readEvents(r.filePath)),
        [["run.worktree_release_skipped", "content_present"]], `${name} 内容保留`);
      assert.ok(existsSync(wt), `${name} 树保留`);
      assert.ok(branchExists(dir, runId), `${name} 分支保留`);
    }
  } finally { cleanupDir(dir); }
});

test("终态自动回收: detached HEAD 与别的分支 → skipped{not_tip}（含真 Run 集成）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-head-"));
  try {
    makeGitRepo(dir);
    // detached：HEAD 仍在原 tip（干净），但不附着在 wao/<runId>
    const wt1 = addWorktree(dir, "run_twr_det1");
    execSync("git checkout -q --detach", { cwd: wt1, stdio: "ignore" });
    const det = await makeRun({ repo: dir, runId: "run_twr_det1", wt: wt1 });
    await det.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(det.filePath)), [["run.worktree_release_skipped", "not_tip"]], "detached → not_tip");
    assert.ok(existsSync(wt1));

    // 换分支（worker 在树上 checkout 了别的分支）
    const wt2 = addWorktree(dir, "run_twr_br1");
    execSync("git checkout -q -b other", { cwd: wt2, stdio: "ignore" });
    const br = await makeRun({ repo: dir, runId: "run_twr_br1", wt: wt2 });
    await br.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(br.filePath)), [["run.worktree_release_skipped", "not_tip"]], "非本 run 分支 → not_tip");
    assert.ok(existsSync(wt2));

    // 头指针漂移（HEAD ≠ 分支 tip 的读取竞争）：判定核心注入 git 缝钉
    const wt3 = addWorktree(dir, "run_twr_tip1");
    const realGit = (cwd, args) => execFileSync("git", ["--no-optional-locks", ...args], {
      cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    const verdict = terminalWorktreeVerdict({
      worktreePath: wt3, runId: "run_twr_tip1", repoCwd: dir,
      git: (cwd, args) => {
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "wao/run_twr_tip1\n";
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "b".repeat(40) + "\n";
        if (args[0] === "rev-parse" && args[1] === "refs/heads/wao/run_twr_tip1") return "c".repeat(40) + "\n";
        return realGit(cwd, args);
      },
    });
    assert.equal(verdict, "not_tip", "HEAD≠tip（分支被并发移动）→ not_tip");
  } finally { cleanupDir(dir); }
});

// ===== 占用/删除失败 =====

test("终态自动回收: 删除失败（EPERM 同型）与删后目录仍在 → failed{still_present}，不强删，分支不动", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-fail-"));
  try {
    makeGitRepo(dir);
    // 删除原语失败（EPERM/占用同型：返回 false，目录原样）
    const wt1 = addWorktree(dir, "run_twr_f1");
    const f1 = await makeRun({ repo: dir, runId: "run_twr_f1", wt: wt1, removeFn: async () => false });
    await f1.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(f1.filePath)), [["run.worktree_release_failed", "still_present"]]);
    assert.ok(existsSync(wt1), "占用中的树保留");
    assert.ok(existsSync(join(wt1, "a.txt")), "不强删：内容原样");
    assert.ok(branchExists(dir, "run_twr_f1"));

    // 原语报告成功但目录仍在（删后目录仍在）
    const wt2 = addWorktree(dir, "run_twr_f2");
    const f2 = await makeRun({ repo: dir, runId: "run_twr_f2", wt: wt2, removeFn: async () => true });
    await f2.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(f2.filePath)), [["run.worktree_release_failed", "still_present"]]);
    assert.ok(existsSync(wt2));
  } finally { cleanupDir(dir); }
});

// ===== 结构门 =====

test("终态自动回收: 嵌套在册树（含悬空登记）与未登记有内容的子目录 → 保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-nested-"));
  try {
    makeGitRepo(dir);
    // 在册嵌套树（真实目录在场；status 也会看到 ignored 内容 → content/nested 皆保留，
    // 此处断言保留事实与闭集原因之一）
    const wt1 = addWorktree(dir, "run_twr_n1");
    execSync(`git worktree add -q -b wao/run_twr_nchild "${join(wt1, ".wao-worktrees", "run_twr_nchild")}"`, { cwd: dir, stdio: "ignore" });
    const n1 = await makeRun({ repo: dir, runId: "run_twr_n1", wt: wt1 });
    await n1.run._runCleanup();
    const e1 = wtEvents(readEvents(n1.filePath));
    assert.equal(e1.length, 1);
    assert.ok(e1[0][0] === "run.worktree_release_skipped"
      && ["content_present", "nested_tree_present"].includes(e1[0][1]),
      `在册嵌套树保留（实际 ${JSON.stringify(e1)}）`);
    assert.ok(existsSync(wt1));
    execSync("git worktree remove --force " + JSON.stringify(join(wt1, ".wao-worktrees", "run_twr_nchild")), { cwd: dir, stdio: "ignore" });

    // 悬空登记：子树目录从盘上消失（连同 .wao-worktrees 目录，status 无内容可报）
    // 但登记仍在册（prunable）→ nested_tree_present
    const wt2 = addWorktree(dir, "run_twr_n2");
    const childPath = join(wt2, ".wao-worktrees", "run_twr_nchild2");
    execSync(`git worktree add -q -b wao/run_twr_nchild2 "${childPath}"`, { cwd: dir, stdio: "ignore" });
    rmSync(join(wt2, ".wao-worktrees"), { recursive: true, force: true });
    const n2 = await makeRun({ repo: dir, runId: "run_twr_n2", wt: wt2 });
    await n2.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(n2.filePath)),
      [["run.worktree_release_skipped", "nested_tree_present"]], "悬空登记按在册保留");
    assert.ok(existsSync(wt2));

    // 未登记但有内容的子目录（.wao-worktrees/ 下）：status 看到 ignored 内容 → 保留
    const wt3 = addWorktree(dir, "run_twr_n3");
    mkdirSync(join(wt3, ".wao-worktrees", "run_twr_husk"), { recursive: true });
    writeFileSync(join(wt3, ".wao-worktrees", "run_twr_husk", "f.txt"), "x\n", "utf8");
    const n3 = await makeRun({ repo: dir, runId: "run_twr_n3", wt: wt3 });
    await n3.run._runCleanup();
    const e3 = wtEvents(readEvents(n3.filePath));
    assert.equal(e3.length, 1);
    assert.ok(e3[0][0] === "run.worktree_release_skipped"
      && ["content_present", "nested_tree_present"].includes(e3[0][1]),
      `未登记有内容子目录保留（实际 ${JSON.stringify(e3)}）`);
    assert.ok(existsSync(wt3));
  } finally { cleanupDir(dir); }
});

// ===== 幂等 / already_gone =====

test("终态自动回收: 幂等（重复 cleanup 恰一条）与 already_gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-idem-"));
  try {
    makeGitRepo(dir);
    // 重复 cleanup：恰一条事件
    const wt1 = addWorktree(dir, "run_twr_i1");
    const i1 = await makeRun({ repo: dir, runId: "run_twr_i1", wt: wt1 });
    await i1.run._runCleanup();
    await i1.run._runCleanup();
    const evs1 = readEvents(i1.filePath).filter((e) => WT_EVENT_TYPES.includes(e.type));
    assert.equal(evs1.length, 1, "重复 cleanup 不重复记账");
    assert.equal(evs1[0].type, "run.worktree_released");
    assert.ok(!existsSync(wt1));

    // 树已不在（already_gone）
    const wt2 = join(dir, ".wao-worktrees", "run_twr_i2");
    const i2 = await makeRun({ repo: dir, runId: "run_twr_i2", wt: wt2 });
    await i2.run._runCleanup();
    const evs2 = readEvents(i2.filePath).filter((e) => WT_EVENT_TYPES.includes(e.type));
    assert.deepEqual(evs2.map((e) => e.type), ["run.worktree_already_gone"]);
    await i2.run._runCleanup();
    assert.equal(readEvents(i2.filePath).filter((e) => WT_EVENT_TYPES.includes(e.type)).length, 1, "already_gone 也恰一条");
  } finally { cleanupDir(dir); }
});

// ===== 身份门（判定核心，注入 git/io 缝的闭集钉）=====

test("terminalWorktreeVerdict: 身份不可证形态 → unproven_path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-verdict-"));
  try {
    makeGitRepo(dir);
    const wt = addWorktree(dir, "run_twr_v1");
    const V = (p) => terminalWorktreeVerdict(p);
    // 全绿基线
    assert.equal(V({ worktreePath: wt, runId: "run_twr_v1", repoCwd: dir }), "ready");
    // 树不在 → gone
    assert.equal(V({ worktreePath: join(dir, ".wao-worktrees", "run_missing"), runId: "run_missing", repoCwd: dir }), "gone");
    // 目录名 ≠ runId（被别的 runId 共享的形状）
    assert.equal(V({ worktreePath: wt, runId: "run_other", repoCwd: dir }), "unproven_path");
    // 符号链接/junction 路径
    const link = join(dir, "wt-link");
    execSync(`cmd /c mklink /J "${link}" "${wt}"`, { stdio: "ignore" });
    assert.equal(V({ worktreePath: link, runId: "run_twr_v1", repoCwd: dir }), "unproven_path");
    // 不在 .wao-worktrees 父段下
    const foreign = join(dir, "plain", "run_twr_v1");
    mkdirSync(foreign, { recursive: true });
    assert.equal(V({ worktreePath: foreign, runId: "run_twr_v1", repoCwd: dir }), "unproven_path");
    // git worktree 登记读不出
    assert.equal(V({
      worktreePath: wt, runId: "run_twr_v1", repoCwd: dir,
      git: (cwd, args) => {
        if (args[0] === "worktree") throw new Error("git down");
        return execFileSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).toString();
      },
    }), "unproven_path");
    // 与绑定源仓库不同仓（repoCwd 指向别的 git 仓）
    const other = mkdtempSync(join(tmpdir(), "wao-twr-other-"));
    try {
      execSync("git init -q && git config user.email t@t && git config user.name t && echo x > x && git add . && git commit -qm i", { cwd: other, stdio: "ignore" });
      assert.equal(V({ worktreePath: wt, runId: "run_twr_v1", repoCwd: other }), "unproven_path");
    } finally { cleanupDir(other); }
    // 同仓但锚不匹配：树在主检出 .wao-worktrees 下，本 run 的派发目录却是同仓
    // 的另一个关联工作树（锚只认派发目录自己的 .wao-worktrees/<runId>）
    const anchorDir = mkdtempSync(join(tmpdir(), "wao-twr-anchor-"));
    try {
      execSync(`git worktree add -q -b anchorbase "${anchorDir}"`, { cwd: dir, stdio: "ignore" });
      assert.equal(V({ worktreePath: wt, runId: "run_twr_v1", repoCwd: anchorDir }), "unproven_path");
    } finally {
      execSync(`git worktree remove --force "${anchorDir}"`, { cwd: dir, stdio: "ignore" });
      cleanupDir(anchorDir);
    }
  } finally { cleanupDir(dir); }
});

test("terminalWorktreeVerdict: 清点不了 → inventory_unreadable（skip-worktree/子模块/status 读失败）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-inv-"));
  try {
    makeGitRepo(dir);
    // status 读失败
    const wt = addWorktree(dir, "run_twr_inv1");
    assert.equal(terminalWorktreeVerdict({
      worktreePath: wt, runId: "run_twr_inv1", repoCwd: dir,
      git: (cwd, args) => {
        if (args.includes("status")) throw new Error("status failed"); // 首参是调用处写的 --no-optional-locks
        return execFileSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).toString();
      },
    }), "inventory_unreadable");
    // skip-worktree 位
    const wt2 = addWorktree(dir, "run_twr_inv2");
    execSync("git update-index --skip-worktree a.txt", { cwd: wt2, stdio: "ignore" });
    assert.equal(terminalWorktreeVerdict({ worktreePath: wt2, runId: "run_twr_inv2", repoCwd: dir }), "inventory_unreadable");
  } finally { cleanupDir(dir); }
});

// ===== 删除原语 =====

test("removeWorktreeNoForce: 干净树删除；脏树拒绝且不强删", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-nf-"));
  try {
    makeGitRepo(dir);
    // 干净树 → 删除成功
    const wt1 = addWorktree(dir, "run_twr_nf1");
    assert.equal(removeWorktreeNoForce(wt1), true);
    assert.ok(!existsSync(wt1));
    assert.ok(branchExists(dir, "run_twr_nf1"), "分支保留");

    // 脏树 → git 拒绝（不加 force），目录与内容原样
    const wt2 = addWorktree(dir, "run_twr_nf2");
    writeFileSync(join(wt2, "dirty.txt"), "d\n", "utf8");
    assert.equal(removeWorktreeNoForce(wt2), false);
    assert.ok(existsSync(join(wt2, "dirty.txt")), "无 force 兜底：脏内容不被强删");
    assert.ok(branchExists(dir, "run_twr_nf2"));

    // 不在盘上 → true（无事可做）
    assert.equal(removeWorktreeNoForce(join(dir, ".wao-worktrees", "run_absent")), true);
  } finally { cleanupDir(dir); }
});

test("终态自动回收: 派发事实缺工作目录 → occupancy_unprovable，不当作无关记录跳过", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-nocwd-"));
  try {
    makeGitRepo(dir);
    const wt = addWorktree(dir, "run_twr_use7");
    await writeForeignRun({ dir, bucket: "otherproj-44444444", runId: "run_twr_user7", started: { backend: "kimi-web" } });
    const r = await makeRun({ repo: dir, runId: "run_twr_use7", wt });
    await r.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(r.filePath)), [["run.worktree_release_skipped", "occupancy_unprovable"]]);
    assert.ok(existsSync(wt));
  } finally { cleanupDir(dir); }
});

test("终态自动回收: 占用者转录里混入别的 run 的终态 → 不能替它作证，仍按占用保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-bound-"));
  try {
    makeGitRepo(dir);
    const wt = addWorktree(dir, "run_twr_use8");
    const foreign = await writeForeignRun({
      dir, bucket: "otherproj-55555555", runId: "run_twr_user8",
      started: { cwd: join(wt, "sub"), backend: "kimi-web" },
    });
    // 另一个 run 的终态行被拼进了这份转录
    appendFileSync(foreign, JSON.stringify({
      ts: new Date().toISOString(), seq: 99, runId: "run_twr_someone_else", agentId: "kimi",
      type: "run.state_change", from: "running", to: "completed", reason: "done",
    }) + "\n", "utf8");
    const r = await makeRun({ repo: dir, runId: "run_twr_use8", wt });
    await r.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(r.filePath)), [["run.worktree_release_skipped", "tree_in_use"]]);
    assert.ok(existsSync(wt), "占用者自己仍未终态 → 保留");
  } finally { cleanupDir(dir); }
});

test("listTranscriptsDeep strict: 桶目录 stat 失败（非 ENOENT）抛出；默认模式跳过", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-strict-"));
  try {
    const bucket = join(dir, "projects", "locked-66666666");
    mkdirSync(bucket, { recursive: true });
    writeFileSync(join(bucket, "run_x.jsonl"), "", "utf8");
    const io = {
      statSync(p) {
        if (String(p).endsWith("locked-66666666")) {
          const e = new Error("EPERM: operation not permitted");
          e.code = "EPERM";
          throw e;
        }
        return statSync(p);
      },
    };
    assert.throws(() => listTranscriptsDeep(dir, { io, strict: true }), /EPERM/);
    assert.deepEqual(listTranscriptsDeep(dir, { io }).map((e) => e.name), [], "默认模式如旧跳过");
  } finally { cleanupDir(dir); }
});

test("终态自动回收: 旧格式后台提交不带 cwd、紧跟的 run.started 带 cwd → 按 run.started 判；后台 run 的工作树就是本树 → 占用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-bg-"));
  try {
    makeGitRepo(dir);
    // 旧格式：background_submitted 无 cwd，run.started 在别处 → 无关，A 正常回收
    const wt1 = addWorktree(dir, "run_twr_use9");
    const old = join(dir, "projects", "otherproj-77777777", "run_twr_user9.jsonl");
    mkdirSync(dirname(old), { recursive: true });
    writeFileSync(old, [
      JSON.stringify({ ts: new Date().toISOString(), seq: 1, runId: "run_twr_user9", agentId: "kimi", type: "run.background_submitted", background: true }),
      JSON.stringify({ ts: new Date().toISOString(), seq: 2, runId: "run_twr_user9", agentId: "kimi", type: "run.started", cwd: join(dir, "elsewhere"), backend: "kimi-web" }),
    ].join("\n") + "\n", "utf8");
    const r1 = await makeRun({ repo: dir, runId: "run_twr_use9", wt: wt1 });
    await r1.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(r1.filePath)), [["run.worktree_released", undefined]],
      "旧格式后台提交不让扫描判不定");

    // 后台 run：提交时 cwd 在仓库，run.started 声明的工作树就是本树 → 占用
    const wt2 = addWorktree(dir, "run_twr_use10");
    const shared = join(dir, "projects", "otherproj-77777777", "run_twr_user10.jsonl");
    writeFileSync(shared, [
      JSON.stringify({ ts: new Date().toISOString(), seq: 1, runId: "run_twr_user10", agentId: "kimi", type: "run.background_submitted", background: true, cwd: dir }),
      JSON.stringify({ ts: new Date().toISOString(), seq: 2, runId: "run_twr_user10", agentId: "kimi", type: "run.started", cwd: dir, backend: "kimi-web", worktreePath: wt2, worktreeStrategy: "persistent" }),
    ].join("\n") + "\n", "utf8");
    const r2 = await makeRun({ repo: dir, runId: "run_twr_use10", wt: wt2 });
    await r2.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(r2.filePath)), [["run.worktree_release_skipped", "tree_in_use"]],
      "后台 run 的 worktreePath 也在比对面内");
    assert.ok(existsSync(wt2));
  } finally { cleanupDir(dir); }
});

test("终态自动回收: 别的 run 的 run.started 混进占用者转录头部 → 不顶替它自己的派发事实，仍按占用保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-mixhead-"));
  try {
    makeGitRepo(dir);
    const wt = addWorktree(dir, "run_twr_use11");
    // B 的后台提交 cwd 就是本树、B 尚未终态；随后混进 C 的 run.started（cwd 在别处）
    const file = join(dir, "projects", "otherproj-88888888", "run_twr_user11.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, [
      JSON.stringify({ ts: new Date().toISOString(), seq: 1, runId: "run_twr_user11", agentId: "kimi", type: "run.background_submitted", background: true, cwd: wt }),
      JSON.stringify({ ts: new Date().toISOString(), seq: 2, runId: "run_twr_someone_else", agentId: "kimi", type: "run.started", cwd: join(dir, "elsewhere"), backend: "kimi-web" }),
    ].join("\n") + "\n", "utf8");
    const r = await makeRun({ repo: dir, runId: "run_twr_use11", wt });
    await r.run._runCleanup();
    const skipped = readEvents(r.filePath).filter((e) => e.type === "run.worktree_release_skipped");
    assert.deepEqual(skipped.map((e) => [e.reason, e.byRunId]), [["tree_in_use", "run_twr_user11"]]);
    assert.ok(existsSync(wt));
  } finally { cleanupDir(dir); }
});

test("终态自动回收: 别的 run 的派发路径解析出错而不是不在盘上（非法路径）→ occupancy_unprovable，不退回词法比较", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-resolve-"));
  try {
    makeGitRepo(dir);
    const wt = addWorktree(dir, "run_twr_use13");
    // 路径里带 NUL：realpath 报 ERR_INVALID_ARG_VALUE（不是 ENOENT）。它的词法形态在树外，
    // 退回词法比较就会当作无关记录跳过——解析失败可能藏着指向本树的别名，必须判不定。
    await writeForeignRun({
      dir, bucket: "otherproj-aaaaaaaa", runId: "run_twr_user13",
      started: { cwd: join(dir, "elsewhere\u0000alias"), backend: "kimi-web" },
    });
    const r = await makeRun({ repo: dir, runId: "run_twr_use13", wt });
    await r.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(r.filePath)), [["run.worktree_release_skipped", "occupancy_unprovable"]]);
    assert.ok(existsSync(wt));
  } finally { cleanupDir(dir); }
});

/** 按原样写一份别的 run 的转录（逐行；坏行原样写入）。 */
function writeRawForeign(dir, bucket, runId, lines) {
  const file = join(dir, "projects", bucket, `${runId}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify({
    ts: new Date().toISOString(), runId, agentId: "kimi", ...l,
  }))).join("\n") + "\n", "utf8");
}

test("终态自动回收: 占用者的 run.started 写坏、提交时的 cwd 在别处、尚未终态 → occupancy_unprovable，不按提交时的 cwd 排除", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-badstart-"));
  try {
    makeGitRepo(dir);
    const wt = addWorktree(dir, "run_twr_use14");
    // 不显式传 --cwd 时 runner 开跑会重读注册表：提交时的 cwd 与实际 cwd 可以不同
    writeRawForeign(dir, "otherproj-bbbbbbbb", "run_twr_user14", [
      { seq: 1, type: "run.background_submitted", background: true, cwd: join(dir, "elsewhere") },
      JSON.stringify({ ts: new Date().toISOString(), seq: 2, runId: "run_twr_user14", agentId: "kimi", type: "run.started", cwd: wt }).slice(0, -1),
      { seq: 3, type: "run.state_change", from: "submitted", to: "running", reason: "spawned" },
    ]);
    const r = await makeRun({ repo: dir, runId: "run_twr_use14", wt });
    await r.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(r.filePath)), [["run.worktree_release_skipped", "occupancy_unprovable"]]);
    assert.ok(existsSync(wt));
  } finally { cleanupDir(dir); }
});

test("终态自动回收: 已终态的别的 run，头读下不了结论（没有 run.started、有坏行）→ 不挡回收；尚未开跑的排队 run 提交 cwd 在别处 → occupancy_unprovable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-terminalbad-"));
  try {
    makeGitRepo(dir);
    const wt1 = addWorktree(dir, "run_twr_use15");
    // 只有提交与结算（runner 没开跑就被结算为 failed），中间夹一行写坏的
    writeRawForeign(dir, "otherproj-cccccccc", "run_twr_user15", [
      { seq: 1, type: "run.background_submitted", background: true, cwd: join(dir, "elsewhere") },
      "{half-written",
      { seq: 3, type: "run.state_change", from: "submitted", to: "failed", reason: "settled" },
    ]);
    const r1 = await makeRun({ repo: dir, runId: "run_twr_use15", wt: wt1 });
    await r1.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(r1.filePath)), [["run.worktree_released", undefined]],
      "终态 run 不占用，坏行不让它挡住回收");
    assert.ok(!existsSync(wt1));

    // 尚未开跑：位置要等 runner 开跑才确定，提交时的 cwd 证明不了它不在本树
    const wt2 = addWorktree(dir, "run_twr_use16");
    writeRawForeign(dir, "otherproj-cccccccc", "run_twr_user16", [
      { seq: 1, type: "run.background_submitted", background: true, cwd: join(dir, "elsewhere") },
    ]);
    const r2 = await makeRun({ repo: dir, runId: "run_twr_use16", wt: wt2 });
    await r2.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(r2.filePath)), [["run.worktree_release_skipped", "occupancy_unprovable"]]);
    assert.ok(existsSync(wt2));
  } finally { cleanupDir(dir); }
});

test("终态自动回收: 候选转录读不出（同名目录：打得开、读时 EISDIR）→ occupancy_unprovable，不误记 still_present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-eisdir-"));
  try {
    makeGitRepo(dir);
    const wt = addWorktree(dir, "run_twr_use12");
    mkdirSync(join(dir, "projects", "otherproj-99999999", "run_twr_user12.jsonl"), { recursive: true });
    const r = await makeRun({ repo: dir, runId: "run_twr_use12", wt });
    await r.run._runCleanup();
    assert.deepEqual(wtEvents(readEvents(r.filePath)), [["run.worktree_release_skipped", "occupancy_unprovable"]]);
    assert.ok(existsSync(wt));
  } finally { cleanupDir(dir); }
});

test("占用扫描: 存储根不在 → 判不定（不在不等于空存储）；projects/ stat 失败（非 ENOENT）strict 抛出", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-twr-noroot-"));
  try {
    const tree = join(dir, "tree");
    mkdirSync(tree);
    const missing = join(dir, "runs-gone");
    assert.deepEqual(await worktreeOccupiedByOtherRuns(missing, "run_self", tree), { inUse: false, unprovable: true });
    assert.throws(() => listTranscriptsDeep(missing, { strict: true }), /ENOENT/);
    assert.deepEqual(listTranscriptsDeep(missing), [], "默认模式如旧：不在即空");
    const store = join(dir, "runs");
    mkdirSync(join(store, "projects"), { recursive: true });
    assert.deepEqual(await worktreeOccupiedByOtherRuns(store, "run_self", tree), { inUse: false }, "空存储如实无人占用");
    const io = {
      statSync(p) {
        if (String(p).endsWith("projects")) {
          const e = new Error("EPERM: operation not permitted");
          e.code = "EPERM";
          throw e;
        }
        return statSync(p);
      },
    };
    assert.throws(() => listTranscriptsDeep(store, { io, strict: true }), /EPERM/);
    assert.deepEqual(listTranscriptsDeep(store, { io }), [], "默认模式如旧");
  } finally { cleanupDir(dir); }
});
