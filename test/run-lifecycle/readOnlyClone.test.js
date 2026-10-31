// test/run-lifecycle/readOnlyClone.test.js
//
// 决定 0102（batch 57）钉：ephemeral 只读轮的私有克隆接线——
//   - 建树分流：readOnly 非复用走 createReadOnlyCloneFn（冻结基点照传）；交付/
//     复用/持久等其余路径仍走 createWorktreeFn，一字不变；
//   - run.started 持久化 worktreeForm/worktreeBaseCommit；
//   - spawn 失败与延迟释放共用处置原语（released / branch_kept{uniqueCommits|reason} /
//     already_gone / skipped{stop_unconfirmed}），私有克隆不触发 0062 分支回收；
//   - 两处 resume 从 run.started 恢复形态与基点；旧转录（无 worktreeForm）=
//     链接树，照旧走 removeWorktree + 分支回收。
// 注入写法照 td251-worktree-release / td262-resume-recovery / readOnlyDispatch。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { RunManager, Run, ReadOnlyWorktreeRequiredError } from "../../src/runManager.js";
import { JsonlTranscript } from "../../src/transcript.js";
import { createReadOnlyClone } from "../../src/isolation.js";
import { deriveOpaqueUuid } from "../../src/application/sessionReuse.js";

function cleanupDir(dir) { rmSync(dir, { recursive: true, force: true }); }

function makeGitRepo(dir) {
  execSync("git init -q", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "t@t"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "t"', { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "a.txt"), "a\n", "utf8");
  execSync("git add . && git commit -qm init", { cwd: dir, stdio: "ignore" });
}

const gitOut = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", windowsHide: true }).trim();

const WT_EVENT_TYPES = [
  "run.worktree_released",
  "run.worktree_already_gone",
  "run.worktree_release_skipped",
  "run.worktree_release_failed",
  "run.worktree_branch_recycled",
  "run.worktree_branch_kept",
];

const readEvents = (filePath) => readFileSync(filePath, "utf8").trim().split("\n").filter((l) => l.length > 0)
  .map((l) => JSON.parse(l));

// ===== start 路径 =====

function fakeBackend({ spawnAgentCapture = null, spawnThrows = null, isAlive = () => false } = {}) {
  return {
    supportsRoleContract: true,
    supportsSessionReuse: true,
    validateAgentPolicy() {},
    async spawn(agent) {
      if (spawnAgentCapture) spawnAgentCapture.cwd = agent.cwd;
      if (spawnThrows) throw new Error(spawnThrows);
      return {
        backend: "kimi-web",
        backendSessionId: "session_pc",
        events: async function* () {
          yield { kind: "message", parts: [{ type: "text", text: "ok" }] };
          yield { kind: "done", reason: "completed" };
        },
        abort: async () => {},
        isAlive,
      };
    },
  };
}

function makeManager(dir, backend, { createReadOnlyCloneFn, createWorktreeFn } = {}) {
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
    ...(createReadOnlyCloneFn ? { createReadOnlyCloneFn } : {}),
    ...(createWorktreeFn ? { createWorktreeFn } : {}),
  });
}

const recordingCloneFn = (calls) => async (...a) => {
  calls.clone += 1;
  return createReadOnlyClone(...a);
};
const recordingWorktreeFn = (calls, real) => async (...a) => {
  calls.worktree += 1;
  return real(...a);
};

test("0102: 只读非复用走私有克隆——run.started 新字段、worker cwd=克隆、终态释放且不回收分支", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-pc-start-"));
  try {
    makeGitRepo(dir);
    const calls = { clone: 0, worktree: 0 };
    const capture = {};
    const backend = fakeBackend({ spawnAgentCapture: capture });
    const mgr = makeManager(dir, backend, {
      createReadOnlyCloneFn: recordingCloneFn(calls),
      createWorktreeFn: recordingWorktreeFn(calls, (await import("../../src/isolation.js")).createWorktree),
    });
    const run = await mgr.start("kimi", { prompt: "hi", readOnly: true, runId: "run_pc_l1" });
    assert.equal(calls.clone, 1, "建树走克隆缝");
    assert.equal(calls.worktree, 0, "createWorktreeFn 不被调用");
    const clonePath = join(dir, ".wao-worktrees", "run_pc_l1");
    assert.equal(capture.cwd, clonePath, "worker 执行位置=克隆");
    const started = readEvents(run.transcript.filePath).find((e) => e.type === "run.started");
    assert.equal(started.worktreePath, clonePath);
    assert.equal(started.worktreeBranch, "wao/run_pc_l1");
    assert.equal(started.worktreeStrategy, "ephemeral");
    assert.equal(started.worktreeForm, "private_clone");
    assert.equal(started.worktreeBaseCommit, gitOut(["rev-parse", "HEAD"], dir), "基点=源仓 HEAD 完整 SHA");
    assert.ok(existsSync(clonePath), "克隆在场");
    await run.waitForCompletion({});
    assert.ok(!existsSync(clonePath), "停止确认后克隆已释放");
    const events = readEvents(run.transcript.filePath);
    assert.deepEqual(
      events.filter((e) => WT_EVENT_TYPES.includes(e.type)).map((e) => e.type),
      ["run.worktree_released"],
      "只记 released——克隆不触发 0062 分支回收（分支活在克隆里）",
    );
    let srcBranchMissing = false;
    try { execSync("git rev-parse --verify refs/heads/wao/run_pc_l1", { cwd: dir, stdio: "pipe" }); }
    catch { srcBranchMissing = true; }
    assert.ok(srcBranchMissing, "源仓自始就没有克隆的分支");
  } finally { cleanupDir(dir); }
});

test("0102: 复用轮仍走链接树——persistent、无 worktreeForm、克隆缝零调用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-pc-reuse-"));
  try {
    makeGitRepo(dir);
    const calls = { clone: 0, worktree: 0 };
    const backend = fakeBackend({ isAlive: () => true });
    const mgr = makeManager(dir, backend, {
      createReadOnlyCloneFn: recordingCloneFn(calls),
      createWorktreeFn: recordingWorktreeFn(calls, (await import("../../src/isolation.js")).createWorktree),
    });
    const run = await mgr.start("kimi", {
      prompt: "hi",
      readOnly: true,
      runId: "run_pc_ru1",
      sessionReuse: { mode: "lead_workspace", opaqueUuid: deriveOpaqueUuid({ leadSession: "lead-pc", workspace: dir, agentId: "kimi" }), turn: "first" },
    });
    assert.equal(calls.clone, 0, "复用轮不走克隆缝");
    assert.equal(calls.worktree, 1, "复用轮走 createWorktreeFn");
    const started = readEvents(run.transcript.filePath).find((e) => e.type === "run.started");
    assert.equal(started.worktreeStrategy, "persistent");
    assert.equal(started.worktreeForm, undefined, "链接树无 worktreeForm");
    assert.ok(existsSync(started.worktreePath), "persistent 树保留");
    assert.equal(readEvents(run.transcript.filePath).filter((e) => WT_EVENT_TYPES.includes(e.type)).length, 0,
      "零 worktree 事件");
  } finally { cleanupDir(dir); }
});

test("0102: 建克隆失败 → ReadOnlyWorktreeRequiredError（零转录副作用）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-pc-fail-"));
  try {
    makeGitRepo(dir);
    const backend = fakeBackend();
    const mgr = makeManager(dir, backend, {
      createReadOnlyCloneFn: async () => { throw new Error("disk full"); },
    });
    await assert.rejects(
      mgr.start("kimi", { prompt: "hi", readOnly: true, runId: "run_pc_fail" }),
      ReadOnlyWorktreeRequiredError,
    );
  } finally { cleanupDir(dir); }
});

test("0102: Run 构造之前退出（pending 被拒、认证门、fire-and-forget 护栏）→ 克隆走同一处置，不泄漏", async () => {
  for (const [label, startOpts, backendExtra] of [
    ["pending", {}, {}],
    ["cert", { requireCertified: true }, {}],
    ["faf", { fireAndForget: true }, { sessionOutlivesProcess: true }],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), `wao-pc-early-${label}-`));
    try {
      makeGitRepo(dir);
      const runId = `run_pc_early_${label}`;
      if (label === "pending") {
        // 同 runId 已有终态转录（TD-99 形状）→ pending 被拒
        const seed = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "kimi" });
        await seed.append("run.started", { backend: "kimi-web" });
        await seed.transitionState(null, "running", "first_message");
        await seed.transitionState("running", "failed", "backend_error");
      }
      const mgr = makeManager(dir, { ...fakeBackend(), ...backendExtra });
      await assert.rejects(mgr.start("kimi", { prompt: "hi", readOnly: true, runId, ...startOpts }));
      assert.ok(!existsSync(join(dir, ".wao-worktrees", runId)), `${label}: 克隆已删`);
      let tPath = null;
      const find = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) find(p);
          else if (e.name === `${runId}.jsonl`) tPath = p;
        }
      };
      find(dir);
      assert.deepEqual(readEvents(tPath).filter((e) => WT_EVENT_TYPES.includes(e.type)).map((e) => e.type),
        ["run.worktree_released"], `${label}: 处置事件入账`);
    } finally { cleanupDir(dir); }
  }
});

test("0102: spawn 失败——干净克隆 released；带独有提交的克隆 branch_kept（证据保留）", async () => {
  for (const [label, seedCommit] of [["clean", false], ["unique", true]]) {
    const dir = mkdtempSync(join(tmpdir(), `wao-pc-spawn-${label}-`));
    try {
      makeGitRepo(dir);
      const backend = fakeBackend({ spawnThrows: "serve down" });
      const mgr = makeManager(dir, backend, {
        createReadOnlyCloneFn: async (...a) => {
          const info = await createReadOnlyClone(...a);
          if (seedCommit) {
            writeFileSync(join(info.path, "u.txt"), "u\n", "utf8");
            execSync("git add .", { cwd: info.path, stdio: "ignore" });
            execSync('git commit -qm worker', { cwd: info.path, stdio: "ignore" });
          }
          return info;
        },
      });
      await assert.rejects(
        mgr.start("kimi", { prompt: "hi", readOnly: true, runId: "run_pc_s1" }),
        /serve down/,
      );
      const clonePath = join(dir, ".wao-worktrees", "run_pc_s1");
      let tPath = null;
      const find = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) find(p);
          else if (e.name === "run_pc_s1.jsonl") tPath = p;
        }
      };
      find(dir);
      const events = readEvents(tPath).filter((e) => WT_EVENT_TYPES.includes(e.type));
      if (seedCommit) {
        assert.deepEqual(events.map((e) => [e.type, e.uniqueCommits ?? e.reason]),
          [["run.worktree_branch_kept", 1]], "独有提交=必须保留的证据");
        assert.ok(existsSync(clonePath), "证据克隆整个保留");
      } else {
        assert.deepEqual(events.map((e) => e.type), ["run.worktree_released"], "干净克隆直接释放");
        assert.ok(!existsSync(clonePath), "克隆已删");
        assert.ok(!events.some((e) => e.type === "run.worktree_branch_recycled"), "无分支回收事件");
      }
    } finally { cleanupDir(dir); }
  }
});

// ===== 直接构造 Run：延迟释放四臂 + 注入缝 =====

function makeRun(dir, extra = {}) {
  const filePath = join(dir, `run_${Math.random().toString(36).slice(2)}.jsonl`);
  const transcript = new JsonlTranscript(filePath, { runId: "run_pc_x", agentId: "kimi", initialSeq: 0 });
  writeFileSync(filePath, "", "utf8");
  const handle = { backend: "kimi-web", backendSessionId: "s", events: async function* () {}, abort: async () => {} };
  return new Run({
    runId: "run_pc_x", agentId: "kimi", agent: { id: "kimi", backend: "kimi-web", cwd: dir },
    backend: {}, handle, transcript, result: handle, config: {},
    onRemove: () => {}, initialState: "completed",
    ...extra,
  });
}

test("0102: 延迟释放——干净克隆 released；独有提交 branch_kept{uniqueCommits} 且克隆保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-pc-defer-"));
  try {
    makeGitRepo(dir);
    // 干净克隆 → released
    const clean = await createReadOnlyClone(dir, "run_pc_x");
    const c1 = gitOut(["rev-parse", "HEAD"], dir);
    const cleanRun = makeRun(dir, {
      deferredWorktreeRelease: clean.path,
      deferredWorktreeForm: "private_clone",
      deferredWorktreeBaseCommit: clean.baseCommit,
    });
    cleanRun._stopQuietConfirmed = true;
    await cleanRun._runCleanup();
    assert.ok(!existsSync(clean.path), "干净克隆已释放");
    assert.deepEqual(
      readEvents(cleanRun.transcript.filePath).filter((e) => WT_EVENT_TYPES.includes(e.type)).map((e) => e.type),
      ["run.worktree_released"],
    );

    // 独有提交 → branch_kept{uniqueCommits:1}，整个克隆保留
    const kept = await createReadOnlyClone(dir, "run_pc_x");
    writeFileSync(join(kept.path, "u.txt"), "u\n", "utf8");
    execSync("git add .", { cwd: kept.path, stdio: "ignore" });
    execSync('git commit -qm worker', { cwd: kept.path, stdio: "ignore" });
    const keptRun = makeRun(dir, {
      deferredWorktreeRelease: kept.path,
      deferredWorktreeForm: "private_clone",
      deferredWorktreeBaseCommit: c1,
    });
    keptRun._stopQuietConfirmed = true;
    await keptRun._runCleanup();
    assert.ok(existsSync(kept.path), "证据克隆保留");
    assert.deepEqual(
      readEvents(keptRun.transcript.filePath).filter((e) => WT_EVENT_TYPES.includes(e.type))
        .map((e) => [e.type, e.uniqueCommits ?? e.reason]),
      [["run.worktree_branch_kept", 1]],
    );
    await import("node:fs").then((fs) => fs.rmSync(kept.path, { recursive: true, force: true }));
  } finally { cleanupDir(dir); }
});

test("0102: 注入缝——probe keep{reason} / remove 违约 still_present / already_gone / skipped 停止未确认", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-pc-seam-"));
  try {
    makeGitRepo(dir);
    const clone = await createReadOnlyClone(dir, "run_pc_x");

    // probe 注入缝：keep{reason:head_drift} → branch_kept{reason}，克隆保留，remove 不被调
    const removed = [];
    const drift = makeRun(dir, {
      deferredWorktreeRelease: clone.path,
      deferredWorktreeForm: "private_clone",
      deferredWorktreeBaseCommit: clone.baseCommit,
      probeReadOnlyCloneForRelease: () => ({ outcome: "keep", reason: "head_drift" }),
      removeReadOnlyCloneForRelease: (p) => { removed.push(p); },
    });
    drift._stopQuietConfirmed = true;
    await drift._runCleanup();
    assert.ok(existsSync(clone.path), "probe keep → 克隆保留");
    assert.equal(removed.length, 0, "probe keep 不进删除");
    assert.deepEqual(
      readEvents(drift.transcript.filePath).filter((e) => WT_EVENT_TYPES.includes(e.type))
        .map((e) => [e.type, e.uniqueCommits ?? e.reason]),
      [["run.worktree_branch_kept", "head_drift"]],
    );

    // remove 注入缝违约：clean 但删不掉 → still_present
    const stuck = makeRun(dir, {
      deferredWorktreeRelease: clone.path,
      deferredWorktreeForm: "private_clone",
      deferredWorktreeBaseCommit: clone.baseCommit,
      removeReadOnlyCloneForRelease: () => {},
    });
    stuck._stopQuietConfirmed = true;
    await stuck._runCleanup();
    assert.ok(existsSync(clone.path), "remove 违约 → 克隆仍在");
    assert.deepEqual(
      readEvents(stuck.transcript.filePath).filter((e) => WT_EVENT_TYPES.includes(e.type))
        .map((e) => [e.type, e.uniqueCommits ?? e.reason]),
      [["run.worktree_release_failed", "still_present"]],
    );

    // already_gone：目录已不在
    const gonePath = join(dir, ".wao-worktrees", "run_pc_gone");
    const gone = makeRun(dir, {
      deferredWorktreeRelease: gonePath,
      deferredWorktreeForm: "private_clone",
      deferredWorktreeBaseCommit: clone.baseCommit,
      probeReadOnlyCloneForRelease: () => { throw new Error("probe 不得被调用"); },
    });
    gone._stopQuietConfirmed = true;
    await gone._runCleanup();
    assert.deepEqual(
      readEvents(gone.transcript.filePath).filter((e) => WT_EVENT_TYPES.includes(e.type)).map((e) => e.type),
      ["run.worktree_already_gone"],
    );

    // 停止未确认 → skipped{stop_unconfirmed}，probe/remove 都不被调
    const skipped = makeRun(dir, {
      deferredWorktreeRelease: clone.path,
      deferredWorktreeForm: "private_clone",
      deferredWorktreeBaseCommit: clone.baseCommit,
      probeReadOnlyCloneForRelease: () => { throw new Error("未确认不得 probe"); },
      removeReadOnlyCloneForRelease: () => { throw new Error("未确认不得删"); },
    });
    await skipped._runCleanup();
    assert.ok(existsSync(clone.path), "停止未确认 → 克隆保留");
    assert.deepEqual(
      readEvents(skipped.transcript.filePath).filter((e) => WT_EVENT_TYPES.includes(e.type))
        .map((e) => [e.type, e.uniqueCommits ?? e.reason]),
      [["run.worktree_release_skipped", "stop_unconfirmed"]],
    );
    await import("node:fs").then((fs) => fs.rmSync(clone.path, { recursive: true, force: true }));
  } finally { cleanupDir(dir); }
});

// ===== resume 路径 =====

const ev = (obj) => JSON.stringify(obj) + "\n";

function writeEphemeralTranscript(dir, runId, agentId, { worktreePath, baseCommit, withForm = true, strategy = "ephemeral" } = {}) {
  const lines = [
    ev({
      type: "run.started", runId, agentId, backend: "claude-code", cwd: dir,
      worktreePath, worktreeBranch: `wao/${runId}`,
      ...(strategy ? { worktreeStrategy: strategy } : {}),
      ...(withForm ? { worktreeForm: "private_clone", worktreeBaseCommit: baseCommit } : {}),
      ts: "2026-10-12T00:00:00.000Z", seq: 1,
    }),
    ev({ type: "run.read_only_declared", runId, agentId, ts: "2026-10-12T00:00:00.100Z", seq: 2 }),
    ev({ type: "session.created", runId, agentId, backend: "claude-code", backendSessionId: "s_old", ts: "2026-10-12T00:00:00.200Z", seq: 3 }),
    ev({ type: "prompt.sent", runId, agentId, prompt: "do it", ts: "2026-10-12T00:00:00.300Z", seq: 4 }),
    ev({ type: "run.state_change", runId, agentId, from: "pending", to: "submitted", reason: "spawned", ts: "2026-10-12T00:00:00.400Z", seq: 5 }),
  ];
  mkdirSync(join(dir, "runs"), { recursive: true });
  writeFileSync(join(dir, "runs", `${runId}.jsonl`), lines.join(""), "utf8");
}

function makeResumeManager(dir, registryPath, spawnAgentCapture, { mode = "replay" } = {}) {
  const fakeBackend = {
    supportsRoleContract: true, sessionOutlivesProcess: false,
    async spawn(agent) {
      if (spawnAgentCapture) spawnAgentCapture.cwd = agent.cwd;
      return {
        backend: "claude-code", backendSessionId: "s9", messageId: "m1", admittedSeq: 9,
        async *events() { yield { kind: "done", reason: "completed" }; },
        abort: async () => {},
        isAlive: () => false,
      };
    },
    // attach 路径（replayByRespawn 非 true 且有 streamEvents）的事件流。
    ...(mode === "attach" ? { async *streamEvents() { yield { kind: "done", reason: "completed" }; } } : {}),
    defaultBinary() { return "claude"; },
    credentialEnvNames: () => [],
  };
  return new RunManager({
    config: { registry: registryPath, runDir: join(dir, "runs"), defaultIsolation: "none" },
    readRegistry: async () => {
      const { readRegistry } = await import("../../src/registry.js");
      return readRegistry(registryPath);
    },
    transcriptDir: join(dir, "runs"), backendFor: () => fakeBackend, userEnvReader: async () => ({}),
  });
}

test("0102: resume（replay）恢复形态与基点——执行位置=克隆，终态克隆释放且不回收分支", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-pc-resume-"));
  try {
    makeGitRepo(dir);
    const runId = "run_pc_r1";
    const c1 = gitOut(["rev-parse", "HEAD"], dir);
    const clone = await createReadOnlyClone(dir, runId, { commitish: c1 });
    writeEphemeralTranscript(dir, runId, "pc1", { worktreePath: clone.path, baseCommit: c1 });
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { pc1: { backend: "claude-code", cwd: dir } } }), "utf8");
    const capture = {};
    const manager = makeResumeManager(dir, registryPath, capture);
    const resumed = await manager.resume(runId, { runDir: join(dir, "runs"), registry: registryPath });
    assert.equal(resumed.deferredWorktreeRelease, clone.path);
    assert.equal(resumed.deferredWorktreeForm, "private_clone", "形态恢复");
    assert.equal(resumed.deferredWorktreeBaseCommit, c1, "基点恢复");
    assert.equal(resumed.effectiveCwd, clone.path, "执行位置=克隆");
    assert.equal(resumed.agent.cwd, dir, "Run.agent 保持源仓解析");
    assert.equal(capture.cwd, clone.path, "replay spawn 的执行 cwd=克隆");
    await resumed.waitForCompletion({ pollInterval: 1 });
    assert.ok(!existsSync(clone.path), "终态后克隆已释放");
    const events = readEvents(join(dir, "runs", `${runId}.jsonl`));
    assert.deepEqual(
      events.filter((e) => WT_EVENT_TYPES.includes(e.type)).map((e) => e.type),
      ["run.worktree_released"],
      "克隆路径无分支回收事件",
    );
  } finally { cleanupDir(dir); }
});

test("0102: resume（attach）同样恢复形态与基点", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-pc-attach-"));
  try {
    makeGitRepo(dir);
    const runId = "run_pc_a1";
    const c1 = gitOut(["rev-parse", "HEAD"], dir);
    const clone = await createReadOnlyClone(dir, runId, { commitish: c1 });
    writeEphemeralTranscript(dir, runId, "pc2", { worktreePath: clone.path, baseCommit: c1 });
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { pc2: { backend: "claude-code", cwd: dir } } }), "utf8");
    const manager = makeResumeManager(dir, registryPath, null, { mode: "attach" });
    const resumed = await manager.resume(runId, { runDir: join(dir, "runs"), registry: registryPath });
    assert.equal(resumed.deferredWorktreeRelease, clone.path, "attach 路径也恢复 deferred");
    assert.equal(resumed.deferredWorktreeForm, "private_clone");
    assert.equal(resumed.deferredWorktreeBaseCommit, c1);
    assert.equal(resumed.effectiveCwd, clone.path);
    resumed._stopQuietConfirmed = true;
    await resumed._runCleanup();
    assert.ok(!existsSync(clone.path), "克隆已释放");
  } finally { cleanupDir(dir); }
});

test("0102: 旧转录（无 worktreeForm）= 链接树——deferred 恢复但走原路径（released+分支回收）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-pc-legacy-"));
  try {
    makeGitRepo(dir);
    const runId = "run_pc_lg1";
    const wt = join(dir, ".wao-worktrees", runId);
    execSync(`git worktree add "${wt}" -b wao/${runId}`, { cwd: dir, stdio: "ignore" });
    writeEphemeralTranscript(dir, runId, "pc3", { worktreePath: wt, withForm: false });
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { pc3: { backend: "claude-code", cwd: dir } } }), "utf8");
    const manager = makeResumeManager(dir, registryPath, null);
    const resumed = await manager.resume(runId, { runDir: join(dir, "runs"), registry: registryPath });
    assert.equal(resumed.deferredWorktreeRelease, wt, "链接树的 deferred 照旧恢复");
    assert.equal(resumed.deferredWorktreeForm, null, "无 worktreeForm → 链接树（原路径）");
    assert.equal(resumed.deferredWorktreeBaseCommit, null);
    await resumed.waitForCompletion({ pollInterval: 1 });
    assert.ok(!existsSync(wt), "链接树照旧释放");
    const events = readEvents(join(dir, "runs", `${runId}.jsonl`));
    assert.deepEqual(
      events.filter((e) => WT_EVENT_TYPES.includes(e.type)).map((e) => e.type),
      ["run.worktree_released", "run.worktree_branch_recycled"],
      "旧转录仍走 0062 分支回收",
    );
  } finally { cleanupDir(dir); }
});
