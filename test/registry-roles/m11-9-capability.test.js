// test/m11-9-capability.test.js
//
// M11-9 final capability/evidence closeout.
//
// Gap: validateAgentPolicy was fail-open (optional-chain + no-op default).
// Backends that don't override it silently accept policies they can't express.
// This test suite proves fail-closed behavior + real RunManager causality.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: dir, stdio: "pipe" });
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ===== A1: ProcessBackend default is fail-closed (rejects structured policy) =====

test("CAP-A1: ProcessBackend default validateAgentPolicy rejects any structured policy", async () => {
  const { ProcessBackend } = await import("../../src/backends/processBackend.js");
  const backend = new ProcessBackend({
    parserClass: class { feed() { return []; } flush() { return []; } },
    buildArgs: () => [],
  });
  // No override → must reject structured model (base class can't express it).
  assert.throws(
    () => backend.validateAgentPolicy({ model: { id: "x" } }),
    /cannot express|not supported|validateAgentPolicy/i,
    "base ProcessBackend rejects structured model (fail-closed)",
  );
  // No structured policy → no throw.
  assert.doesNotThrow(() => backend.validateAgentPolicy({}));
});

// ===== A2: ClaudeCode validator — expressible vs inexpressible =====

test("CAP-A2b-claude-native: model+reasoning accepted (OAuth direct)", async () => {
  const { ClaudeCodeBackend } = await import("../../src/backends/claudeCode.js");
  const backend = new ClaudeCodeBackend();
  assert.doesNotThrow(() => backend.validateAgentPolicy({
    model: { id: "claude-opus-5" },
    reasoning: { effort: "xhigh" },
  }));
});

test("CAP-A2c-claude: contextWindow → reject (no CLI flag to express it)", async () => {
  const { ClaudeCodeBackend } = await import("../../src/backends/claudeCode.js");
  const backend = new ClaudeCodeBackend();
  assert.throws(
    () => backend.validateAgentPolicy({
      model: { id: "claude-opus-5", contextWindow: 200000 },
    }),
    /cannot express|not supported|contextWindow/i,
    "claude-code rejects contextWindow (no CLI flag for it)",
  );
});

// 进程式三件套只把 model.id 交给运行时（--model）——model.providerID /
// model.variant 配了即拒（kimi-web/zcode 同款纪律，不静默丢弃路由字段；providerID
// 还会进车道身份四元组，静默接受会让认证台账记下运行时根本不存在的 provider 区分）。
test("CAP-A2d-claude: model.providerID / model.variant → reject; bare model.id still passes", async () => {
  const { ClaudeCodeBackend } = await import("../../src/backends/claudeCode.js");
  const backend = new ClaudeCodeBackend();
  assert.throws(
    () => backend.validateAgentPolicy({ model: { id: "x", providerID: "deepseek" } }),
    /cannot express model\.providerID\/model\.variant[\s\S]*--model/,
  );
  assert.throws(
    () => backend.validateAgentPolicy({ model: { id: "x", variant: "stable" } }),
    /cannot express model\.providerID\/model\.variant[\s\S]*--model/,
  );
  assert.doesNotThrow(() => backend.validateAgentPolicy({ model: { id: "x" } }));
});

// ===== A3: Codex validator =====

test("CAP-A3-codex: model+reasoning accepted", async () => {
  const { CodexBackend } = await import("../../src/backends/codex.js");
  const backend = new CodexBackend();
  assert.doesNotThrow(() => backend.validateAgentPolicy({
    model: { id: "gpt-5.6-sol" },
    reasoning: { effort: "high" },
  }));
});

test("CAP-A3c-codex: contextWindow → reject", async () => {
  const { CodexBackend } = await import("../../src/backends/codex.js");
  const backend = new CodexBackend();
  assert.throws(
    () => backend.validateAgentPolicy({
      model: { id: "x", contextWindow: 200000 },
    }),
    /cannot express|not supported|contextWindow/i,
  );
});

test("CAP-A3d-codex: model.providerID / model.variant → reject; bare model.id still passes", async () => {
  const { CodexBackend } = await import("../../src/backends/codex.js");
  const backend = new CodexBackend();
  assert.throws(
    () => backend.validateAgentPolicy({ model: { id: "x", providerID: "openai" } }),
    /cannot express model\.providerID\/model\.variant[\s\S]*--model/,
  );
  assert.throws(
    () => backend.validateAgentPolicy({ model: { id: "x", variant: "stable" } }),
    /cannot express model\.providerID\/model\.variant[\s\S]*--model/,
  );
  assert.doesNotThrow(() => backend.validateAgentPolicy({ model: { id: "x" } }));
});

// ===== B: RunManager causality — real Kimi + reasoning → zero side effects =====

test("CAP-B1: RunManager.start with deepseek-acp + reasoning → reject, zero transcript/runDir/worktree/spawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cap-b1-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { coder_mm: { backend: "deepseek-acp", cwd: dir, credentialEnv: "DEEPSEEK_TEST_TOKEN", reasoning: { effort: "xhigh" } } },
    }), "utf8");
    const runDir = join(dir, "runs");

    const { RunManager } = await import("../../src/runManager.js");
    const { DeepSeekAcpBackend } = await import("../../src/backends/deepSeekAcp.js");
    let spawnCount = 0;
    const realAcp = new DeepSeekAcpBackend();
    const origSpawn = realAcp.spawn.bind(realAcp);
    realAcp.spawn = async (...args) => { spawnCount++; return origSpawn(...args); };
    const manager = new RunManager({
      config: { registry: registryPath, runDir, defaultIsolation: "none" },
      readRegistry: async () => { const { readRegistry } = await import("../../src/registry.js"); return readRegistry(registryPath); },
      transcriptDir: runDir, backendFor: () => realAcp, userEnvReader: async () => ({}),
    });
    await assert.rejects(
      () => manager.start("coder_mm", { prompt: "x", runDir, registry: registryPath, fireAndForget: false }),
      /reasoning|cannot express|not supported/i,
    );
    assert.equal(spawnCount, 0, "zero spawn");
    assert.ok(!existsSync(runDir) || readdirSync(runDir).filter((f) => f.endsWith(".jsonl")).length === 0,
      "zero transcript");
  } finally {
    cleanupDir(dir);
  }
});

test("CAP-B2: synthetic backend WITHOUT validateAgentPolicy override + structured policy → reject before side effects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cap-b2-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { w: { backend: "claude-code", cwd: dir, model: { id: "x" } } },
    }), "utf8");
    const runDir = join(dir, "runs");

    const { RunManager } = await import("../../src/runManager.js");
    let spawnCount = 0;
    // A backend that LACKS validateAgentPolicy entirely (not even the base no-op).
    const bareBackend = {
      supportsRoleContract: true, sessionOutlivesProcess: false,
      async spawn() { spawnCount++; throw new Error("should not be called"); },
      defaultBinary() { return "claude"; }, credentialEnvNames: () => [],
    };
    const manager = new RunManager({
      config: { registry: registryPath, runDir, defaultIsolation: "none" },
      readRegistry: async () => { const { readRegistry } = await import("../../src/registry.js"); return readRegistry(registryPath); },
      transcriptDir: runDir, backendFor: () => bareBackend, userEnvReader: async () => ({}),
    });
    await assert.rejects(
      () => manager.start("w", { prompt: "x", runDir, registry: registryPath, fireAndForget: false }),
      /validateAgentPolicy|cannot express|not supported/i,
      "backend without validateAgentPolicy + structured policy → reject",
    );
    assert.equal(spawnCount, 0, "zero spawn");
  } finally {
    cleanupDir(dir);
  }
});

// ===== C: tracked synthetic six-worker fixture passes policy validation =====

test("CAP-C1: tracked synthetic six-worker fixture passes validateAgentPolicy", async () => {
  // TD-107: validate the tracked synthetic six-worker registry — the canonical
  // test stand-in for the gitignored config/agents.json (which does not exist in
  // a clean checkout and is reserved for operation acceptance). Each agent must
  // pass its backend's validateAgentPolicy.
  const { readRegistry } = await import("../../src/registry.js");
  const { ClaudeCodeBackend } = await import("../../src/backends/claudeCode.js");
  const { CodexBackend } = await import("../../src/backends/codex.js");
  const { KimiWebBackend } = await import("../../src/backends/kimiWeb.js");
  const registry = await readRegistry("test/fixtures/agents.six.json");
  const backends = {
    "claude-code": new ClaudeCodeBackend(),
    "codex": new CodexBackend(),
    "kimi-web": new KimiWebBackend(),
  };
  for (const agent of registry.listAgents()) {
    const backend = backends[agent.backend];
    assert.ok(backend, `backend ${agent.backend} has a validator`);
    assert.doesNotThrow(
      () => backend.validateAgentPolicy(agent),
      `${agent.id} (${agent.backend}) passes policy validation`,
    );
  }
});

// ===== B3: RunManager.resume + Kimi + reasoning → zero side effects =====

test("CAP-B3: RunManager.resume with deepseek-acp + reasoning → reject, transcript bytes unchanged, zero append/spawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cap-b3-"));
  try {
    makeGitRepo(dir);
    const runId = "run_cap_b3";
    // Create a real linked worktree (so resume's proveLinkedWorktree passes).
    const wtPath = join(dir, ".wt-b3");
    execSync(`git worktree add "${wtPath}" -b wao/${runId}`, { cwd: dir, stdio: "pipe" });
    const base = execSync("git rev-parse HEAD", { cwd: wtPath, encoding: "utf8" }).trim();

    // Build an existing non-terminal transcript for a deepseek-acp delivery run.
    const transcriptPath = join(dir, "runs", `${runId}.jsonl`);
    mkdirSync(join(dir, "runs"), { recursive: true });
    const events = [
      { type: "run.started", backend: "deepseek-acp", cwd: dir, worktreePath: wtPath, worktreeBranch: `wao/${runId}`, delivery: { mode: "git_commit_v1", baseCommit: base, allowedPaths: ["src"], verificationCommands: ["echo ok"], scorecardRules: { requireEvidence: true, mode: "warn" } }, scorecardConfigured: true, ts: "2026-07-26T00:00:00.000Z", runId, agentId: "coder_mm", seq: 1 },
      { type: "session.created", backend: "deepseek-acp", backendSessionId: "s1", ts: "2026-07-26T00:00:00.200Z", runId, agentId: "coder_mm", seq: 2 },
      { type: "prompt.sent", prompt: "do it", ts: "2026-07-26T00:00:00.300Z", runId, agentId: "coder_mm", seq: 3 },
      { type: "run.state_change", from: "pending", to: "submitted", reason: "spawned", ts: "2026-07-26T00:00:00.400Z", runId, agentId: "coder_mm", seq: 4 },
    ];
    const transcriptContent = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(transcriptPath, transcriptContent, "utf8");
    const bytesBefore = readFileSync(transcriptPath, "utf8").length;

    // Registry: coder_mm requests an effort the ACP settable intersection cannot express.
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { coder_mm: { backend: "deepseek-acp", cwd: dir, credentialEnv: "DEEPSEEK_TEST_TOKEN", reasoning: { effort: "xhigh" } } },
    }), "utf8");

    const { RunManager } = await import("../../src/runManager.js");
    const { DeepSeekAcpBackend } = await import("../../src/backends/deepSeekAcp.js");
    // Use the REAL DeepSeekAcpBackend (not a hand-written check) so the test
    // exercises the actual policy validator.
    let spawnCount = 0;
    const realAcp = new DeepSeekAcpBackend();
    // Wrap spawn to count (the validator throws before spawn is reached).
    const origSpawn = realAcp.spawn.bind(realAcp);
    realAcp.spawn = async (...args) => { spawnCount++; return origSpawn(...args); };

    const manager = new RunManager({
      config: { registry: registryPath, runDir: join(dir, "runs"), defaultIsolation: "none" },
      readRegistry: async () => { const { readRegistry } = await import("../../src/registry.js"); return readRegistry(registryPath); },
      transcriptDir: join(dir, "runs"), backendFor: () => realAcp, userEnvReader: async () => ({}),
    });

    // Snapshot the worktree list BEFORE resume (proves no worktree change).
    const wtListBefore = execSync("git worktree list --porcelain", { cwd: dir, encoding: "utf8" });

    // resume must reject (kimi + reasoning).
    await assert.rejects(
      () => manager.resume(runId, { runDir: join(dir, "runs"), registry: registryPath }),
      /reasoning|cannot express|not supported/i,
      "resume with deepseek-acp + reasoning must reject",
    );

    // Causality assertions: zero side effects.
    assert.equal(spawnCount, 0, "zero spawn on resume rejection");
    const bytesAfter = readFileSync(transcriptPath, "utf8").length;
    assert.equal(bytesAfter, bytesBefore, "transcript bytes unchanged (zero append)");
    // Verify no new events were appended (no run.rerun / session.created / prompt).
    const afterContent = readFileSync(transcriptPath, "utf8");
    assert.equal(afterContent, transcriptContent, "transcript content identical (no append)");
    // Worktree list unchanged — resume did not create/delete/modify any worktree.
    const wtListAfter = execSync("git worktree list --porcelain", { cwd: dir, encoding: "utf8" });
    assert.equal(wtListAfter, wtListBefore, "worktree list unchanged (zero worktree side effects)");
  } finally {
    cleanupDir(dir);
  }
});
