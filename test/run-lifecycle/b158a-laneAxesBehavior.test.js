// test/run-lifecycle/b158a-laneAxesBehavior.test.js
//
// 第 158a 批行为级机器钉（全部经**既有 API**，不用新导出——保证对批次前实现
// 先红：本文件曾在 git archive HEAD 的干净检出里逐条红过，见交付报告）：
//   1. 显式车道派发：私有残留四轴与车道表不一致 → 解析照常（不再
//      lane_wiring_mismatch 拒绝；接线缺席的拒绝保留）。
//   2. 别名派发：私有残留不一致 → 别名解析不降级 legacy-agent。
//   3. 后台启动端到端：私有条目去四轴 + lanesMergeDoc → run.started 记车道表
//      四轴（合并后启动；私有缺 backend 也不再是死路）。
//   4. 旧谱系续修端到端：run.started.model 与当前 model 键序不同、值相同 →
//      续修照常（旧的 JSON.stringify 整串比较在此误报
//      worker_configuration_changed）。
//   5. RunManager.resume：当前生效四轴与 run.started 记录不一致 → 具名拒绝
//      resume_refused（不用新配置跑后半程）；一致时照常恢复。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { resolveDispatchTarget } from "../../src/dispatchResolution.js";
import { runBackground } from "../../src/backgroundRunner.js";
import { continueRun } from "../../src/application/runContinue.js";
import { RunManager } from "../../src/runManager.js";
import { readTranscript } from "../../src/transcript.js";

const ev = (obj) => JSON.stringify(obj) + "\n";
const cleanupDir = (dir) => rmSync(dir, { recursive: true, force: true });

function git(args, cwd) {
  return String(execSync("git " + args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })).trim();
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "wao-b158a-repo-"));
  git("init -b main", repo);
  git("config user.email t@t.com", repo);
  git("config user.name T", repo);
  writeFileSync(join(repo, "README.md"), "# base\n", "utf8");
  git("add -A", repo);
  git("commit -m base", repo);
  return repo;
}

// lanesDoc 夹具（loadLanesConfig 产物同形状；结构合法、四轴齐备）。
const lanesDocOf = (lanes) => ({
  ok: true, path: "<fixture>", sha256: "f".repeat(64), lanes, issues: [], rolesHint: [],
});
const ROLE_LIBRARY = ["coder", "reviewer"];
const LANES = lanesDocOf([
  {
    id: "opus", backend: "claude-code", model: { id: "claude-opus-5-5" },
    reasoning: { effort: "high" },
    aliases: { reviewer: { role: "reviewer" } },
  },
]);
const LANES_SWITCHED = lanesDocOf([
  {
    id: "opus", backend: "codex", model: { id: "gpt-6.2-astra" },
    reasoning: { effort: "medium" },
    aliases: { reviewer: { role: "reviewer" } },
  },
]);

// ── 1/2：解析器只认接线在场，不再比轴 ────────────────────────────────────────

test("b158a 解析：explicit 车道私有残留四轴不一致 → 照常解析（不再 lane_wiring_mismatch）", () => {
  const registryAgents = {
    opus: { backend: "claude-code", cwd: "D:/w", model: { id: "claude-OLD" }, reasoning: { effort: "low" } },
  };
  const r = resolveDispatchTarget({
    lane: "opus", role: "coder", lanesDoc: LANES, registryAgents, roleLibrary: ROLE_LIBRARY,
  });
  assert.equal(r.kind, "resolved");
  assert.equal(r.source, "explicit");
  assert.equal(r.agentId, "opus");
});

test("b158a 解析：别名席位私有残留四轴不一致 → 别名解析不降级 legacy-agent", () => {
  const registryAgents = {
    opus: { backend: "claude-code", cwd: "D:/w", model: { id: "claude-OLD" } },
  };
  const r = resolveDispatchTarget({
    agentId: "reviewer", lanesDoc: LANES, registryAgents, roleLibrary: ROLE_LIBRARY,
  });
  assert.equal(r.kind, "resolved");
  assert.equal(r.source, "alias", "私有残留不一致不再触发 H2 降级");
  assert.equal(r.agentId, "opus");
  assert.equal(r.roleId, "reviewer");
});

test("b158a 解析：注册表没有接线条目 → lane_wiring_mismatch 拒绝保留", () => {
  const r = resolveDispatchTarget({
    lane: "opus", role: "coder", lanesDoc: LANES, registryAgents: {}, roleLibrary: ROLE_LIBRARY,
  });
  assert.equal(r.kind, "error");
  assert.equal(r.code, "lane_wiring_mismatch");
});

// ── 3：后台启动端到端（对象注册表 + lanesMergeDoc 注入缝） ──────────────────

test("b158a 后台 e2e：私有条目去四轴 + lanesMergeDoc → run.started 记车道表四轴", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b158a-bg-"));
  const runDir = join(dir, "runs");
  try {
    const spawned = [];
    const fakeBackend = {
      validateAgentPolicy() {},
      async spawn(agent) {
        spawned.push(agent);
        return {
          backend: "claude-code", backendSessionId: "s1", messageId: "m1", admittedSeq: 1,
          async *events() { yield { kind: "done", reason: "completed" }; },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    const result = await runBackground({
      agentId: "opus",
      prompt: "do it",
      registry: { agents: { opus: { cwd: dir } } }, // 去四轴：只剩本机接线
      runDir,
      lanesMergeDoc: LANES,
      backendFor: () => fakeBackend,
      waitTimeout: 3000,
      pollInterval: 10,
    });
    assert.equal(result.completed, true, `run completes (error: ${result.error})`);
    assert.equal(spawned[0].backend, "claude-code", "spawn 收到合并后的 backend");
    assert.equal(spawned[0].model.id, "claude-opus-5-5", "spawn 收到车道表 model.id");
    assert.equal(spawned[0].reasoning.effort, "high", "spawn 收到车道表 effort");
    const events = await readTranscript(join(runDir, `${result.runId}.jsonl`));
    const started = events.find((e) => e.type === "run.started");
    assert.equal(started.backend, "claude-code");
    assert.deepEqual(started.model, { id: "claude-opus-5-5" });
    assert.deepEqual(started.reasoning, { effort: "high" });
  } finally {
    cleanupDir(dir);
  }
});

// ── 4：旧谱系续修端到端（model 键序无关） ───────────────────────────────────

test("b158a 续修 e2e：run.started.model 与当前 model 值同键序不同 → 照常续修", async () => {
  const repo = makeRepo();
  const runId = "run_parent_ko";
  const wt = join(repo, ".wao-worktrees", runId);
  git(`worktree add -b wao/${runId} "${wt}"`, repo);
  const base = git("rev-parse HEAD", repo);
  writeFileSync(join(wt, "keep.txt"), "keep-changed\n", "utf8");
  git("add -A", wt);
  git('-c user.name="WAO Delivery" -c user.email="wao-delivery@local" commit -m "wao-delivery: ' + runId + '"', wt);
  const deliveryCommit = git("rev-parse HEAD", wt);
  const dir = mkdtempSync(join(tmpdir(), "wao-b158a-rc-"));
  const registryPath = join(dir, "agents.json");
  try {
    // 父转录：run.started.model = {contextWindow 先、id 后}；注册表条目
    // {id 先、contextWindow 后}——值全同、键序不同。旧的整串 JSON.stringify
    // 比较判漂移拒续；按字段比较（modelPolicyEqual）应当放行。
    writeFileSync(registryPath, JSON.stringify({
      agents: { opus: { backend: "claude-code", cwd: repo, model: { id: "claude-opus-5-5", contextWindow: 200000 } } },
    }), "utf8");
    mkdirSync(dir, { recursive: true });
    const lines = [
      ev({ type: "run.background_submitted", runId, agentId: "opus", background: true, cwd: repo, deliveryRequested: true, ts: "2026-11-27T00:00:00.000Z", seq: 1 }),
      ev({ type: "run.state_change", runId, agentId: "opus", from: null, to: "pending", reason: "background_spawned", ts: "2026-11-27T00:00:00.001Z", seq: 2 }),
      ev({
        type: "run.started", runId, agentId: "opus", backend: "claude-code", cwd: repo,
        worktreePath: wt, worktreeBranch: `wao/${runId}`,
        model: { contextWindow: 200000, id: "claude-opus-5-5" },
        reasoning: { effort: "high" },
        delivery: { mode: "git_commit_v1", baseCommit: base, allowedPaths: ["keep.txt"], verificationCommands: ["node --test"] },
        providerKey: null,
        ts: "2026-11-27T00:00:00.002Z", seq: 3,
      }),
      ev({ type: "run.session_reuse", runId, agentId: "opus", mode: "run_lineage", turn: "first", rootRunId: runId, ts: "2026-11-27T00:00:00.003Z", seq: 4 }),
      ev({ type: "session.created", runId, agentId: "opus", backend: "claude-code", backendSessionId: "provider-session-1", serveUrl: null, ts: "2026-11-27T00:00:00.004Z", seq: 5 }),
      ev({ type: "run.delivery_created", runId, agentId: "opus", deliveryCommit, delivery: { schemaVersion: 1, kind: "git_commit", runId, baseCommit: base, deliveryCommit, branch: `wao/${runId}`, worktreePath: wt, allowedPaths: ["keep.txt"], changedFiles: ["keep.txt"], verification: { commands: ["node --test"] }, acceptance: { status: "pending", reviewerType: "lead_agent" }, integration: { status: "pending", targetCommit: null } }, ts: "2026-11-27T00:00:00.005Z", seq: 6 }),
      ev({ type: "prompt.sent", runId, agentId: "opus", prompt: "first turn", ts: "2026-11-27T00:00:00.006Z", seq: 7 }),
      ev({ type: "run.state_change", runId, agentId: "opus", from: "pending", to: "completed", reason: "done", ts: "2026-11-27T00:00:00.007Z", seq: 8 }),
    ];
    mkdirSync(join(dir, "runs"), { recursive: true });
    writeFileSync(join(dir, "runs", `${runId}.jsonl`), lines.join(""), "utf8");

    const calls = [];
    const fakeSpawn = (cmd, args, opts) => {
      const call = { cmd, args, opts, stdinText: null };
      calls.push(call);
      return {
        unref() {},
        stdin: { once() {}, end(text, cb) { call.stdinText = String(text ?? ""); cb?.(); } },
      };
    };
    const r = await continueRun({
      parentRunId: runId, prompt: "continue it",
      delivery: { mode: "git_commit_v1", allowedPaths: ["keep.txt"], verificationCommands: ["node --test"] },
      runDir: join(dir, "runs"), registryPath,
      authorizedWorkspaceRoot: repo, leadSession: "lead-1",
      backendFor: () => ({ supportsSessionReuse: true }),
      spawnFn: fakeSpawn,
    });
    assert.equal(r.accepted, true, `续修应被受理（实际拒绝：${r.rejectionReason}）`);
    assert.equal(calls.length, 1, "子 runner 恰 fork 一次");
  } finally {
    cleanupDir(dir);
    cleanupDir(repo);
  }
});

// ── 5：RunManager.resume 的四轴复核 ────────────────────────────────────────

function writePlainTranscript(dir, runId, agentId, startedModel) {
  const lines = [
    ev({
      type: "run.started", runId, agentId, backend: "claude-code", cwd: dir,
      ...(startedModel ? { model: startedModel } : {}),
      reasoning: { effort: "high" },
      ts: "2026-11-27T00:00:00.000Z", seq: 1,
    }),
    ev({ type: "session.created", runId, agentId, backend: "claude-code", backendSessionId: "s_old", ts: "2026-11-27T00:00:00.200Z", seq: 2 }),
    ev({ type: "prompt.sent", runId, agentId, prompt: "do it", ts: "2026-11-27T00:00:00.300Z", seq: 3 }),
    ev({ type: "run.state_change", runId, agentId, from: "pending", to: "submitted", reason: "spawned", ts: "2026-11-27T00:00:00.400Z", seq: 4 }),
  ];
  mkdirSync(join(dir, "runs"), { recursive: true });
  writeFileSync(join(dir, "runs", `${runId}.jsonl`), lines.join(""), "utf8");
}

function makeResumeManager(dir, registryPath) {
  const fakeBackend = {
    supportsRoleContract: true, sessionOutlivesProcess: false, replayByRespawn: true,
    validateAgentPolicy() {},
    async spawn() {
      return {
        backend: "claude-code", backendSessionId: "s9", messageId: "m1", admittedSeq: 9,
        async *events() { yield { kind: "done", reason: "completed" }; },
        abort: async () => {},
        isAlive: () => false,
      };
    },
    defaultBinary() { return "claude"; }, credentialEnvNames: () => [],
  };
  return new RunManager({
    config: { registry: registryPath, runDir: join(dir, "runs"), defaultIsolation: "none" },
    readRegistry: async () => (await import("../../src/registry.js")).readRegistry(registryPath),
    transcriptDir: join(dir, "runs"), backendFor: () => fakeBackend, userEnvReader: async () => ({}),
  });
}

test("b158a resume：生效四轴与 run.started 不一致（backend 换了）→ 具名拒绝 resume_refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b158a-rs1-"));
  const registryPath = join(dir, "agents.json");
  try {
    // run.started 记 claude-code；车道表（生效）已换 codex。
    writeFileSync(registryPath, JSON.stringify({ agents: { opus: { cwd: dir } } }), "utf8");
    writePlainTranscript(dir, "run_resume_drift", "opus", { id: "claude-opus-5-5" });
    const manager = makeResumeManager(dir, registryPath);
    await assert.rejects(
      () => manager.resume("run_resume_drift", { runDir: join(dir, "runs"), registry: registryPath, lanesMerge: LANES_SWITCHED }),
      (e) => String(e.message).includes("resume_refused") && String(e.message).includes("worker_configuration_changed"),
    );
  } finally {
    cleanupDir(dir);
  }
});

test("b158a resume：生效四轴与 run.started 一致（私有去四轴）→ 照常恢复", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b158a-rs2-"));
  const registryPath = join(dir, "agents.json");
  try {
    // 私有条目只有本机接线；生效四轴来自车道表，与 run.started 记录一致。
    writeFileSync(registryPath, JSON.stringify({ agents: { opus: { cwd: dir } } }), "utf8");
    writePlainTranscript(dir, "run_resume_ok", "opus", { id: "claude-opus-5-5" });
    const manager = makeResumeManager(dir, registryPath);
    const resumed = await manager.resume("run_resume_ok", {
      runDir: join(dir, "runs"), registry: registryPath, lanesMerge: LANES,
    });
    assert.ok(resumed, "一致时恢复照常");
  } finally {
    cleanupDir(dir);
  }
});

test("b158a resume：无 lanesMerge（停用）时保持既有行为——私有自包含条目照常恢复", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b158a-rs3-"));
  const registryPath = join(dir, "agents.json");
  try {
    writeFileSync(registryPath, JSON.stringify({
      agents: { opus: { backend: "claude-code", cwd: dir, model: { id: "claude-opus-5-5" }, reasoning: { effort: "high" } } },
    }), "utf8");
    writePlainTranscript(dir, "run_resume_plain", "opus", { id: "claude-opus-5-5" });
    const manager = makeResumeManager(dir, registryPath);
    const resumed = await manager.resume("run_resume_plain", { runDir: join(dir, "runs"), registry: registryPath });
    assert.ok(resumed, "停用合并：私有自带四轴的旧语义不变");
  } finally {
    cleanupDir(dir);
  }
});
