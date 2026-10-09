// test/migration-0045/rolePinning.test.js
//
// 0045 §1.3 角色钉住（P1 增量，修 R1 会审 coder_mm 抓的洞）：
//   派发时把 {systemPrompt, 正文 sha256} 钉进 run.started；resume 钉优先——
//   从钉住路径加载并校验，不再从当前注册表重读。防两类静默换身份：
//   ①派发后改注册表 systemPrompt 指向（换文件）②派发后改角色文件内容；
//   另防一类静默丢角色：③派发后注册表撤掉 systemPrompt。
//   legacy 无钉档案行为逐字保留（第 3 步切换批的遗留五态再收紧）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { listTranscriptsDeep } from "../../src/projectBuckets.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const ROLES_DIR = join(REPO_ROOT, "config", "roles");

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
function ev(obj) { return JSON.stringify(obj) + "\n"; }
function writeTranscript(dir, runId, lines) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.jsonl`), typeof lines === "string" ? lines : lines.join(""), "utf8");
}
function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}
function writeRoleFile(name, content) {
  writeFileSync(join(ROLES_DIR, name), content, "utf8");
  return `config/roles/${name}`;
}
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function baseEvents(runId, agentId, startedExtra = "") {
  return [
    ev({ type: "run.started", backend: "claude-code", cwd: DIR_PLACEHOLDER, ts: "2026-10-05T00:00:00.000Z", runId, agentId, seq: 1, ...(startedExtra ? JSON.parse(startedExtra) : {}) }),
    ev({ type: "session.created", backend: "claude-code", backendSessionId: "s1", serveUrl: undefined, ts: "2026-10-05T00:00:00.200Z", runId, agentId, seq: 2 }),
    ev({ type: "prompt.sent", prompt: "do it", ts: "2026-10-05T00:00:00.300Z", runId, agentId, seq: 3 }),
    ev({ type: "run.state_change", from: "pending", to: "submitted", reason: "spawned", ts: "2026-10-05T00:00:00.400Z", runId, agentId, seq: 4 }),
  ];
}
// baseEvents 需要 cwd 占位符在运行时替换（每测试的 tmpdir 不同）。
let DIR_PLACEHOLDER = "__DIR__";

async function makeManager(dir, registryPath, spawnCapture) {
  const { RunManager } = await import("../../src/runManager.js");
  const fakeBackend = {
    supportsRoleContract: true, sessionOutlivesProcess: false,
    async spawn(agent, task) {
      spawnCapture.task = task;
      return {
        backend: "claude-code", backendSessionId: "s2", messageId: "m1", admittedSeq: 5,
        async *events() { yield { kind: "done", reason: "completed" }; },
        abort: async () => {},
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

test("PIN-1: start 钉 rolePin{systemPrompt,sha256} 进 run.started；无角色派发缺席（字节兼容）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-pin1-"));
  const roleA = writeRoleFile("_0045_pin_a.md", "# Pin A\nMARKER_ROLE_A\n");
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { _0045_pin: { backend: "claude-code", cwd: dir, systemPrompt: roleA } });
    const capture = {};
    const manager = await makeManager(dir, registryPath, capture);
    const run = await manager.start("_0045_pin", { prompt: "task", runDir: join(dir, "runs"), registry: registryPath });
    try { await run.waitForCompletion({ pollInterval: 1 }); } catch { /* tolerate */ }

    const runDir = join(dir, "runs");
    // D2-②b：深层枚举（新 run 转录在 projects/<slug>/ 桶内）。
    const started = listTranscriptsDeep(runDir)
      .map((e) => readFileSync(e.path, "utf8").split("\n"))
      .flat()
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((o) => o?.type === "run.started");
    assert.ok(started, "run.started 存在");
    assert.deepEqual(started.rolePin, { systemPrompt: roleA, sha256: sha("# Pin A\nMARKER_ROLE_A\n") },
      "钉 = registry 声明路径 + 正文 sha256");
  } finally {
    cleanupDir(dir);
    rmSync(join(ROLES_DIR, "_0045_pin_a.md"), { force: true });
  }
});

test("PIN-2: resume 钉优先——注册表改指向别文件后，续跑仍用钉住角色（洞①关闭）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-pin2-"));
  const roleA = writeRoleFile("_0045_pin_a.md", "# Pin A\nMARKER_ROLE_A\n");
  const roleB = writeRoleFile("_0045_pin_b.md", "# Pin B\nMARKER_ROLE_B\n");
  try {
    makeGitRepo(dir);
    const runId = "run_0045_pin2";
    const pin = JSON.stringify({ rolePin: { systemPrompt: roleA, sha256: sha("# Pin A\nMARKER_ROLE_A\n") } });
    DIR_PLACEHOLDER = dir;
    writeTranscript(join(dir, "runs"), runId, baseEvents(runId, "_0045_pin", pin));
    // 派发后注册表指向改为 B（旧世界的洞：resume 会静默换成 B 的身份）
    const registryPath = makeRegistry(dir, { _0045_pin: { backend: "claude-code", cwd: dir, systemPrompt: roleB } });
    const capture = {};
    const manager = await makeManager(dir, registryPath, capture);
    const resumed = await manager.resume(runId, { runDir: join(dir, "runs"), registry: registryPath });
    try { await resumed.waitForCompletion({ pollInterval: 1 }); } catch { /* tolerate */ }

    assert.ok(capture.task?.roleContract, "roleContract 注入");
    assert.match(capture.task.roleContract, /MARKER_ROLE_A/, "用的是钉住的 A 正文");
    assert.ok(!capture.task.roleContract.includes("MARKER_ROLE_B"), "注册表新指向 B 未被采用——静默换身份洞关闭");
  } finally {
    cleanupDir(dir);
    rmSync(join(ROLES_DIR, "_0045_pin_a.md"), { force: true });
    rmSync(join(ROLES_DIR, "_0045_pin_b.md"), { force: true });
  }
});

test("PIN-3: 钉住文件内容被改 → role_contract_drift 具名拒绝，零 respawn、转录字节不变（洞②关闭）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-pin3-"));
  const roleA = writeRoleFile("_0045_pin_a.md", "# Pin A\nMARKER_ROLE_A\n");
  try {
    makeGitRepo(dir);
    const runId = "run_0045_pin3";
    const pin = JSON.stringify({ rolePin: { systemPrompt: roleA, sha256: sha("# Pin A\nMARKER_ROLE_A\n") } });
    DIR_PLACEHOLDER = dir;
    const transcriptPath = join(dir, "runs", `${runId}.jsonl`);
    writeTranscript(join(dir, "runs"), runId, baseEvents(runId, "_0045_pin", pin));
    const bytesBefore = readFileSync(transcriptPath, "utf8");
    // 派发后角色文件被编辑
    writeRoleFile("_0045_pin_a.md", "# Pin A TAMPERED\nMARKER_ROLE_A\n");

    const registryPath = makeRegistry(dir, { _0045_pin: { backend: "claude-code", cwd: dir, systemPrompt: roleA } });
    const capture = {};
    const manager = await makeManager(dir, registryPath, capture);
    await assert.rejects(
      () => manager.resume(runId, { runDir: join(dir, "runs"), registry: registryPath }),
      (e) => {
        assert.match(e.message, /role_contract_drift/, "具名闭集原因码");
        assert.match(e.message, /refusing to resume/, "固定拒绝文案");
        return true;
      },
      "内容漂移必须具名 fail-closed",
    );
    assert.equal(capture.task, undefined, "零 respawn（spawn 未发生）");
    assert.equal(readFileSync(transcriptPath, "utf8"), bytesBefore, "转录字节不变");
  } finally {
    cleanupDir(dir);
    rmSync(join(ROLES_DIR, "_0045_pin_a.md"), { force: true });
  }
});

test("PIN-4: legacy 无钉档案 → 从当前注册表读取（行为逐字保留，零回归）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-pin4-"));
  const roleB = writeRoleFile("_0045_pin_b.md", "# Pin B\nMARKER_ROLE_B\n");
  try {
    makeGitRepo(dir);
    const runId = "run_0045_pin4";
    DIR_PLACEHOLDER = dir;
    writeTranscript(join(dir, "runs"), runId, baseEvents(runId, "_0045_pin"));
    const registryPath = makeRegistry(dir, { _0045_pin: { backend: "claude-code", cwd: dir, systemPrompt: roleB } });
    const capture = {};
    const manager = await makeManager(dir, registryPath, capture);
    const resumed = await manager.resume(runId, { runDir: join(dir, "runs"), registry: registryPath });
    try { await resumed.waitForCompletion({ pollInterval: 1 }); } catch { /* tolerate */ }
    assert.match(capture.task.roleContract, /MARKER_ROLE_B/, "legacy 档案照旧读注册表指向");
  } finally {
    cleanupDir(dir);
    rmSync(join(ROLES_DIR, "_0045_pin_b.md"), { force: true });
  }
});

test("PIN-5: 有钉但注册表已撤 systemPrompt → 仍加载钉住角色（洞③静默丢角色关闭）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-pin5-"));
  const roleA = writeRoleFile("_0045_pin_a.md", "# Pin A\nMARKER_ROLE_A\n");
  try {
    makeGitRepo(dir);
    const runId = "run_0045_pin5";
    const pin = JSON.stringify({ rolePin: { systemPrompt: roleA, sha256: sha("# Pin A\nMARKER_ROLE_A\n") } });
    DIR_PLACEHOLDER = dir;
    writeTranscript(join(dir, "runs"), runId, baseEvents(runId, "_0045_pin", pin));
    // 派发后注册表撤掉了角色（旧世界：resume 静默丢角色裸跑）
    const registryPath = makeRegistry(dir, { _0045_pin: { backend: "claude-code", cwd: dir } });
    const capture = {};
    const manager = await makeManager(dir, registryPath, capture);
    const resumed = await manager.resume(runId, { runDir: join(dir, "runs"), registry: registryPath });
    try { await resumed.waitForCompletion({ pollInterval: 1 }); } catch { /* tolerate */ }
    assert.match(capture.task.roleContract, /MARKER_ROLE_A/, "撤掉注册表指向后仍按钉加载——静默丢角色洞关闭");
  } finally {
    cleanupDir(dir);
    rmSync(join(ROLES_DIR, "_0045_pin_a.md"), { force: true });
  }
});
