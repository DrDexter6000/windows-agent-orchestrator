// test/migration-0045/explicitDispatch.test.js
//
// 0045 §1.4 W2a 集成测试：explicit 车道+角色派发在 RunManager.start 生效
// （角色经 P1 钉住机制、身份注记落 run.started）、alias 注解不执行、
// legacy 无注解字节兼容、runContinue 对 explicit 父具名拒绝、CLI 解析层
// （--explain / 错误全集文案 / 混用拒绝）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const ROLES_DIR = join(REPO_ROOT, "config", "roles");

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name T", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# t\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m i", { cwd: dir, stdio: "pipe" });
}
function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

async function makeManager(dir, registryPath, spawnCapture) {
  const { RunManager } = await import("../../src/runManager.js");
  const fakeBackend = {
    supportsRoleContract: true, sessionOutlivesProcess: false,
    async spawn(agent, task) {
      spawnCapture.task = task; spawnCapture.agentId = agent.id ?? null;
      return {
        backend: "zcode", backendSessionId: "s1", messageId: "m1", admittedSeq: 5,
        async *events() { yield { kind: "done", reason: "completed" }; },
        abort: async () => {},
      };
    },
    defaultBinary() { return "node"; }, credentialEnvNames: () => [],
  };
  return new RunManager({
    config: { registry: registryPath, runDir: join(dir, "runs"), defaultIsolation: "none" },
    readRegistry: async () => { const { readRegistry } = await import("../../src/registry.js"); return readRegistry(registryPath); },
    transcriptDir: join(dir, "runs"), backendFor: () => fakeBackend, userEnvReader: async () => ({}),
  });
}
function readStarted(dir, runDirName = "runs") {
  const runDir = join(dir, runDirName);
  for (const f of readdirSync(runDir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(runDir, f), "utf8").split("\n")) {
      try { const o = JSON.parse(line); if (o.type === "run.started") return o; } catch { /* skip */ }
    }
  }
  return null;
}

test("EXPL-1: explicit 派发——角色=角色库文件（非接线席位默认帽），注记五件套落档", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-expl1-"));
  // 角色库两个可区分角色：接线席位默认帽 coder_low、目标帽 researcher
  const roleCoderLow = "# coder_low\nMARKER_DEFAULT_HAT\n";
  const roleResearcher = "# researcher\nMARKER_RESEARCHER_HAT\n";
  writeFileSync(join(ROLES_DIR, "_0045_w2_coder_low.md"), roleCoderLow, "utf8");
  writeFileSync(join(ROLES_DIR, "_0045_w2_researcher.md"), roleResearcher, "utf8");
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      _0045_w2_lane_seat: { backend: "claude-code", cwd: dir, systemPrompt: "config/roles/_0045_w2_coder_low.md" },
    } }), "utf8");
    const capture = {};
    const manager = await makeManager(dir, registryPath, capture);
    const run = await manager.start("_0045_w2_lane_seat", {
      prompt: "task", runDir: join(dir, "runs"), registry: registryPath,
      resolvedTarget: {
        kind: "resolved", source: "explicit", agentId: "_0045_w2_lane_seat",
        laneId: "test-lane", roleId: "_0045_w2_researcher",
        wiringAgent: "_0045_w2_lane_seat", lanesSha256: "ab" .repeat(32),
      },
    });
    try { await run.waitForCompletion({ pollInterval: 1 }); } catch { /* tolerate */ }

    const started = readStarted(dir);
    assert.ok(started, "run.started 存在");
    assert.equal(started.resolvedFrom, "explicit");
    assert.equal(started.laneId, "test-lane");
    assert.equal(started.roleId, "_0045_w2_researcher");
    assert.equal(started.wiringAgent, "_0045_w2_lane_seat");
    assert.equal(started.lanesSha256, "ab".repeat(32));
    assert.equal(started.sessionReuseDecision, "fresh_identity_transition", "R3 裁定⑥：有界 fresh 原因");
    // 角色钉住指向角色库目标帽（P1 机制承载 W2 的角色生效）
    assert.deepEqual(started.rolePin, {
      systemPrompt: "config/roles/_0045_w2_researcher.md",
      sha256: sha(roleResearcher),
    });
    assert.match(capture.task.roleContract, /MARKER_RESEARCHER_HAT/, "worker 收到目标帽正文");
    assert.ok(!capture.task.roleContract.includes("MARKER_DEFAULT_HAT"), "接线席位默认帽未被注入");
  } finally {
    cleanupDir(dir);
    rmSync(join(ROLES_DIR, "_0045_w2_coder_low.md"), { force: true });
    rmSync(join(ROLES_DIR, "_0045_w2_researcher.md"), { force: true });
  }
});

test("EXPL-2: alias 注解——执行零变化（角色仍=registry 的 systemPrompt）+ 注记在档", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-expl2-"));
  const roleDefault = "# default\nMARKER_REGISTRY_HAT\n";
  writeFileSync(join(ROLES_DIR, "_0045_w2_coder_low.md"), roleDefault, "utf8");
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      _0045_w2_lane_seat: { backend: "claude-code", cwd: dir, systemPrompt: "config/roles/_0045_w2_coder_low.md" },
    } }), "utf8");
    const capture = {};
    const manager = await makeManager(dir, registryPath, capture);
    const run = await manager.start("_0045_w2_lane_seat", {
      prompt: "task", runDir: join(dir, "runs"), registry: registryPath,
      resolvedTarget: {
        kind: "resolved", source: "alias", agentId: "_0045_w2_lane_seat",
        laneId: "test-lane", roleId: "some-hat",
        wiringAgent: "_0045_w2_lane_seat", lanesSha256: "cd".repeat(32),
      },
    });
    try { await run.waitForCompletion({ pollInterval: 1 }); } catch { /* tolerate */ }
    const started = readStarted(dir);
    assert.equal(started.resolvedFrom, "alias");
    assert.equal(started.laneId, "test-lane");
    assert.equal(started.roleId, "some-hat");
    assert.equal(started.wiringAgent, undefined, "alias 注解不带 wiringAgent（执行不经接线）");
    assert.equal(started.sessionReuseDecision, undefined, "alias 无 fresh 注记（行为零变化）");
    assert.deepEqual(started.rolePin, { systemPrompt: "config/roles/_0045_w2_coder_low.md", sha256: sha(roleDefault) },
      "alias 角色钉=registry 的 systemPrompt（H1 注解不执行）");
    assert.match(capture.task.roleContract, /MARKER_REGISTRY_HAT/);
  } finally {
    cleanupDir(dir);
    rmSync(join(ROLES_DIR, "_0045_w2_coder_low.md"), { force: true });
  }
});

test("EXPL-3: 无 resolvedTarget → run.started 无新字段（字节兼容）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-expl3-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      _0045_w2_seat: { backend: "claude-code", cwd: dir },
    } }), "utf8");
    const capture = {};
    const manager = await makeManager(dir, registryPath, capture);
    const run = await manager.start("_0045_w2_seat", { prompt: "t", runDir: join(dir, "runs"), registry: registryPath });
    try { await run.waitForCompletion({ pollInterval: 1 }); } catch { /* tolerate */ }
    const started = readStarted(dir);
    for (const k of ["laneId", "roleId", "resolvedFrom", "wiringAgent", "lanesSha256", "sessionReuseDecision", "rolePin"]) {
      assert.equal(started[k], undefined, `${k} 缺席（字节兼容）`);
    }
  } finally { cleanupDir(dir); }
});

test("CONT-1: explicit 父 run 不可 continue——具名拒绝（H3）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cont1-"));
  try {
    makeGitRepo(dir);
    const runId = "run_0045_cont1";
    const runDir = join(dir, "runs");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(runDir, { recursive: true });
    const lines = [
      { type: "run.started", backend: "claude-code", cwd: dir, resolvedFrom: "explicit", laneId: "test-lane", roleId: "researcher", ts: "2026-10-05T00:00:00.000Z", runId, agentId: "_0045_w2_seat", seq: 1 },
      { type: "session.created", backend: "claude-code", backendSessionId: "s1", ts: "2026-10-05T00:00:00.200Z", runId, agentId: "_0045_w2_seat", seq: 2 },
      { type: "prompt.sent", prompt: "d", ts: "2026-10-05T00:00:00.300Z", runId, agentId: "_0045_w2_seat", seq: 3 },
      { type: "run.state_change", from: "pending", to: "submitted", reason: "spawned", ts: "2026-10-05T00:00:00.400Z", runId, agentId: "_0045_w2_seat", seq: 4 },
      { type: "run.state_change", from: "submitted", to: "completed", reason: "done", ts: "2026-10-05T00:00:01.000Z", runId, agentId: "_0045_w2_seat", seq: 5 },
      { type: "run.session_reuse", mode: "run_lineage", turn: "first", rootRunId: runId, ts: "2026-10-05T00:00:01.050Z", runId, agentId: "_0045_w2_seat", seq: 6 },
      { type: "run.completed", ts: "2026-10-05T00:00:01.100Z", runId, agentId: "_0045_w2_seat", seq: 7 },
    ].map((l) => JSON.stringify(l)).join("\n");
    writeFileSync(join(runDir, `${runId}.jsonl`), lines + "\n", "utf8");
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      _0045_w2_seat: { backend: "claude-code", cwd: dir },
    } }), "utf8");
    const { continueRun } = await import("../../src/application/runContinue.js");
    const result = await continueRun({
      parentRunId: runId, prompt: "next",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
      runDir, registryPath, authorizedWorkspaceRoot: dir, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }),
    });
    assert.equal(result.accepted, false);
    assert.equal(result.rejectionReason, "explicit_dispatch_continuable_unsupported");
    assert.match(result.detail, /silent hat switch/);
  } finally { cleanupDir(dir); }
});

// ── CLI 层（--explain / 错误全集文案 / 混用拒绝）─────────────────────────────

async function runCli(args, registryPath) {
  const { runCommand } = await import("../../src/commands/run.js");
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    await runCommand(args, { registry: registryPath, runDir: join(tmpdir(), "wao-unused-runs") });
    return { threw: null, logs };
  } catch (e) {
    return { threw: e.message, logs };
  } finally {
    console.log = origLog;
  }
}

test("CLI-1: --explain 别名解析打印 resolved JSON、零副作用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cli1-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      auditor_claude: { backend: "claude-code", model: { id: "claude-opus-5-5" }, reasoning: { effort: "xhigh" }, cwd: dir },
    } }), "utf8");
    const { threw, logs } = await runCli(["auditor_claude", "--explain"], registryPath);
    assert.equal(threw, null);
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.status, "resolved");
    assert.equal(out.source, "alias");
    assert.equal(out.laneId, "claude-opus");
    assert.equal(out.roleId, "auditor");
    assert.equal(out.wiringAgent, "auditor_claude");
  } finally { cleanupDir(dir); }
});

test("CLI-2: 未知 lane → 抛错含闭集码+完整合法 lane 全集+修正例", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cli2-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      auditor_claude: { backend: "claude-code", model: { id: "claude-opus-5-5" }, reasoning: { effort: "xhigh" }, cwd: dir },
    } }), "utf8");
    const { threw } = await runCli(["--lane", "claude-opus1", "--role", "auditor", "--prompt", "t"], registryPath);
    assert.ok(threw.includes("unknown_lane"), "闭集码在场");
    assert.ok(threw.includes("合法 lane: "), "合法全集行在场");
    assert.ok(threw.includes("claude-opus"), "全集含正确车道");
    assert.ok(threw.includes("修正示例"), "修正例在场");
  } finally { cleanupDir(dir); }
});

test("CLI-3: agentId 与 lane/role 混用 → dispatch_selector_invalid", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cli3-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      auditor_claude: { backend: "claude-code", model: { id: "claude-opus-5-5" }, reasoning: { effort: "xhigh" }, cwd: dir },
    } }), "utf8");
    const { threw } = await runCli(["auditor_claude", "--lane", "claude-opus", "--role", "auditor", "--prompt", "t"], registryPath);
    assert.ok(threw.includes("dispatch_selector_invalid"), "混用被拒");
    assert.ok(threw.includes("合法形态"), "二选一形态说明在场");
  } finally { cleanupDir(dir); }
});
