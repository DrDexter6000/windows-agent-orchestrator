// test/run-lifecycle/td262-resume-recovery.test.js
//
// TD-262b（决定 0063）钉：resume 对 ephemeral 只读轮的恢复——
//   - 资格只认 run.started.worktreeStrategy === "ephemeral"（opus 条款：复用轮/
//     旧转录不恢复）；persistent/legacy → 不带 deferred 释放。
//   - 执行位置=隔离树（修"resume 后 worker 跑在源仓"旧缺陷——opus 实锤）；
//     Run.agent 保持源仓解析（分支回收 git 落源仓）。
//   - 树缺失 → refuse resume（零转录写入，fail-closed）。
//   - 终态清理走既有 _releaseDeferredWorktree：stop 确认后放树+零独有分支回收。
//   - 停止确认旗以 run.stop_verified append 成功为准（sol 条款：写盘失败不删树）。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { RunManager } from "../../src/runManager.js";

function cleanupDir(dir) { rmSync(dir, { recursive: true, force: true }); }

function makeGitRepo(dir) {
  execSync("git init -q", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "t@t"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "t"', { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "a.txt"), "a\n", "utf8");
  execSync("git add . && git commit -qm init", { cwd: dir, stdio: "ignore" });
}

const ev = (obj) => JSON.stringify(obj) + "\n";

function makeManager(dir, registryPath, spawnAgentCapture) {
  const fakeBackend = {
    supportsRoleContract: true, sessionOutlivesProcess: false, replayByRespawn: true,
    async spawn(agent, task) {
      if (spawnAgentCapture) spawnAgentCapture.agent = agent;
      return {
        backend: "claude-code", backendSessionId: "s9", messageId: "m1", admittedSeq: 9,
        async *events() { yield { kind: "done", reason: "completed" }; },
        abort: async () => {},
        isAlive: () => false, // 终态清理的 process 臂 → stop 确认可过
      };
    },
    defaultBinary() { return "claude"; }, credentialEnvNames: () => [],
  };
  return new RunManager({
    config: { registry: registryPath, runDir: join(dir, "runs"), defaultIsolation: "none" },
    readRegistry: async () => { const { readRegistry } = await import("../../src/registry.js"); return readRegistry(registryPath); },
    transcriptDir: join(dir, "runs"), backendFor: () => fakeBackend, userEnvReader: async () => ({}),
  });
}

// 手写转录：run.started（带 worktreeStrategy）+ read_only_declared + session +
// prompt + 非终态。每行带 runId+agentId（R13-C 绑定读要求——缺 agentId 的行不匹配）。
function writeEphemeralTranscript(dir, runId, agentId, { strategy = "ephemeral", worktreePath, readOnly = true } = {}) {
  const lines = [
    ev({ type: "run.started", runId, agentId, backend: "claude-code", cwd: dir, worktreePath, worktreeBranch: `wao/${runId}`, ...(strategy ? { worktreeStrategy: strategy } : {}), ts: "2026-10-12T00:00:00.000Z", seq: 1 }),
  ];
  if (readOnly) lines.push(ev({ type: "run.read_only_declared", runId, agentId, ts: "2026-10-12T00:00:00.100Z", seq: 2 }));
  lines.push(
    ev({ type: "session.created", runId, agentId, backend: "claude-code", backendSessionId: "s_old", ts: "2026-10-12T00:00:00.200Z", seq: 3 }),
    ev({ type: "prompt.sent", runId, agentId, prompt: "do it", ts: "2026-10-12T00:00:00.300Z", seq: 4 }),
    ev({ type: "run.state_change", runId, agentId, from: "pending", to: "submitted", reason: "spawned", ts: "2026-10-12T00:00:00.400Z", seq: 5 }),
  );
  mkdirSync(join(dir, "runs"), { recursive: true });
  writeFileSync(join(dir, "runs", `${runId}.jsonl`), lines.join(""), "utf8");
}

test("TD-262b: resume 恢复 ephemeral——deferred 释放在场+执行位置=树+agent 保持源仓+终态放树收分支", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-262rr-1-"));
  try {
    makeGitRepo(dir);
    const runId = "run_262rr1";
    const wt = join(dir, ".wao-worktrees", runId);
    execSync(`git worktree add -b wao/${runId} "${wt}"`, { cwd: dir, stdio: "ignore" });
    writeEphemeralTranscript(dir, runId, "rr1", { worktreePath: wt });
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { rr1: { backend: "claude-code", cwd: dir } } }), "utf8");
    const capture = {};
    const manager = makeManager(dir, registryPath, capture);
    const resumed = await manager.resume(runId, { runDir: join(dir, "runs"), registry: registryPath });
    assert.equal(resumed.deferredWorktreeRelease, wt, "deferred 释放恢复");
    assert.equal(resumed.effectiveCwd, wt, "执行位置=隔离树（修源仓续跑缺陷）");
    assert.equal(resumed.agent.cwd, dir, "Run.agent 保持源仓解析（分支回收 git 落源仓）");
    assert.equal(capture.agent.cwd, wt, "replay spawn 的执行 cwd=隔离树");
    await resumed.waitForCompletion({ pollInterval: 1 });
    const events = readFileSync(join(dir, "runs", `${runId}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(!existsSync(wt), "resume 终态后树已释放");
    assert.ok(events.some((e) => e.type === "run.worktree_released"));
    assert.ok(events.some((e) => e.type === "run.worktree_branch_recycled"), "零独有分支回收");
  } finally { cleanupDir(dir); }
});

test("TD-262b: persistent/legacy 转录 → 不恢复 deferred（persistent 树由终态自动回收放、legacy 保留）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-262rr-2-"));
  try {
    makeGitRepo(dir);
    for (const [runId, opts] of [
      ["run_262rr_p", { strategy: "persistent" }],
      ["run_262rr_l", { strategy: null }],
    ]) {
      const wt = join(dir, ".wao-worktrees", runId);
      execSync(`git worktree add -b wao/${runId} "${wt}"`, { cwd: dir, stdio: "ignore" });
      writeEphemeralTranscript(dir, runId, "rr2", { ...opts, worktreePath: wt });
    }
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { rr2: { backend: "claude-code", cwd: dir } } }), "utf8");
    const manager = makeManager(dir, registryPath, null);
    const resumedP = await manager.resume("run_262rr_p", { runDir: join(dir, "runs"), registry: registryPath });
    assert.equal(resumedP.deferredWorktreeRelease, null, "persistent 不恢复 W1a deferred（opus 反例边界不变）");
    await resumedP.waitForCompletion({ pollInterval: 1 }).catch(() => {});
    // persistent 树不再无条件保留：终态自动回收（第四条路径）对无路由、无线系、
    // 无交付、内容全净的 persistent 树生效——树释放、分支保留。
    assert.ok(!existsSync(join(dir, ".wao-worktrees", "run_262rr_p")), "persistent 树由终态自动回收释放");
    const eventsP = readFileSync(join(dir, "runs", "run_262rr_p.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(eventsP.some((e) => e.type === "run.worktree_released"), "释放事实入账");
    execSync("git rev-parse refs/heads/wao/run_262rr_p", { cwd: dir, stdio: "ignore" });
    const resumedL = await manager.resume("run_262rr_l", { runDir: join(dir, "runs"), registry: registryPath });
    assert.equal(resumedL.deferredWorktreeRelease, null, "legacy（无策略字段）不恢复——交普查");
    await resumedL.waitForCompletion({ pollInterval: 1 }).catch(() => {});
    assert.ok(existsSync(join(dir, ".wao-worktrees", "run_262rr_l")), "legacy 树保留（终态自动回收只认持久化 persistent 事实）");
  } finally { cleanupDir(dir); }
});

test("TD-262b: 树缺失 → refuse resume（零转录写入，fail-closed）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-262rr-3-"));
  try {
    makeGitRepo(dir);
    const runId = "run_262rr3";
    writeEphemeralTranscript(dir, runId, "rr3", { worktreePath: join(dir, ".wao-worktrees", runId) });
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { rr3: { backend: "claude-code", cwd: dir } } }), "utf8");
    const manager = makeManager(dir, registryPath, null);
    await assert.rejects(
      manager.resume(runId, { runDir: join(dir, "runs"), registry: registryPath }),
      /resume_refused: ephemeral worktree missing/,
      "树不在=只读隔离合同不可在源仓兑现——拒绝续跑",
    );
    const events = readFileSync(join(dir, "runs", `${runId}.jsonl`), "utf8").trim().split("\n");
    assert.equal(events.length, 5, "拒绝零转录写入");
  } finally { cleanupDir(dir); }
});

test("TD-262b: 停止确认旗以 run.stop_verified append 成功为准（sol 条款——写盘失败不删树）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-262rr-4-"));
  try {
    makeGitRepo(dir);
    const runId = "run_262rr4";
    const wt = join(dir, ".wao-worktrees", runId);
    execSync(`git worktree add -b wao/${runId} "${wt}"`, { cwd: dir, stdio: "ignore" });
    writeEphemeralTranscript(dir, runId, "rr4", { worktreePath: wt });
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { rr4: { backend: "claude-code", cwd: dir } } }), "utf8");
    const capture = {};
    const manager = makeManager(dir, registryPath, capture);
    const resumed = await manager.resume(runId, { runDir: join(dir, "runs"), registry: registryPath });
    // 注入：stop_verified 事实写盘失败（证据写失败≠已确认——0057 合同）。
    const origAppend = resumed.transcript.append.bind(resumed.transcript);
    resumed.transcript.append = async (type, payload) => {
      if (type === "run.stop_verified") throw new Error("disk full");
      return origAppend(type, payload);
    };
    await resumed.waitForCompletion({ pollInterval: 1 }).catch(() => {});
    assert.ok(existsSync(wt), "stop_verified 写盘失败 → 树保留（确认旗不置真）");
    const events = readFileSync(join(dir, "runs", `${runId}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(!events.some((e) => e.type === "run.worktree_released"), "未确认不释放");
  } finally { cleanupDir(dir); }
});
