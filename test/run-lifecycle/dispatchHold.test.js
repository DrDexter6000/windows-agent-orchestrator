// test/run-lifecycle/dispatchHold.test.js
//
// TD-283（Owner 批准，车道"暂停派发"成为结构化事实）的派发面钉：
//   - CLI run / spawn 的 stderr advisory：恰一行、只提示不拦截、派发照常完成、
//     退出码不变。
// 车道表走夹具（经 config.loadLanesConfigFn 测试缝注入）——本文件不读真实
// config/lanes.json（解除暂停改表后这里不红），Owner 原话不抄第二份。
// 注册表与 backend 全注入，零真实派发。
//
// 嵌套派发门说明：runCommand/spawnCommand 经 RunManager.start（嵌套派发门咽喉），
// 测试自身不向下派发任何真实 worker，但保留显式豁免（WAO_ALLOW_NESTED_DISPATCH=1，
// src/nestedDispatchGuard.js，f3-shortHeadExpectation 同款先例）。
process.env.WAO_ALLOW_NESTED_DISPATCH = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { laneDispatchHold } from "../../src/dispatchResolution.js";
import { readRegistry } from "../../src/registry.js";
import { runCommand, spawnCommand } from "../../src/commands/run.js";
import { lanesDocForCall } from "../../src/commands/shared.js";

// 夹具车道表：一条带 dispatchHold 的车道 + 一条无说明车道。
const LANES = {
  ok: true, path: "fixture", sha256: "ab".repeat(32), issues: [], rolesHint: [],
  lanes: [
    { id: "held-lane", backend: "claude-code", model: { id: "fixture-m" }, reasoning: null, aliases: {}, dispatchHold: "夹具：暂停说明" },
    { id: "plain-lane", backend: "claude-code", model: { id: "fixture-m" }, reasoning: null, aliases: {} },
  ],
};
const HELD = LANES.lanes[0];

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name T", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# t\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m i", { cwd: dir, stdio: "pipe" });
}
function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

/** 假 backend：spawn 即完成（done），计数供"派发照常进行"断言。 */
function fakeBackendFactory(capture) {
  return {
    supportsRoleContract: true, sessionOutlivesProcess: false,
    async spawn(agent, task) {
      capture.spawned += 1;
      capture.lastAgentId = agent.id ?? null;
      return {
        backend: "zcode", backendSessionId: "s1", messageId: "m1", admittedSeq: 5,
        async *events() { yield { kind: "done", reason: "completed" }; },
        abort: async () => {},
      };
    },
    defaultBinary() { return "node"; }, credentialEnvNames: () => [],
  };
}

function writeRegistry(dir, ids) {
  const registryPath = join(dir, "agents.json");
  const agents = {};
  for (const id of ids) agents[id] = { backend: "claude-code", cwd: dir };
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

/** 捕获 console.error/log 的执行器（stdout/stderr 分开收集）。 */
async function withCapturedConsole(fn) {
  const stderr = [];
  const stdout = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a) => { stderr.push(a.join(" ")); };
  console.log = (...a) => { stdout.push(a.join(" ")); };
  try {
    await fn();
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
  return { stderr, stdout };
}

// ── CLI run / spawn 的 stderr advisory ──────────────────────────────────────

test("TD-283 CLI run：目标车道带说明 → stderr 恰一行 advisory，派发照常完成、退出码不变", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td283-cli-"));
  try {
    makeGitRepo(dir);
    const registryPath = writeRegistry(dir, [HELD.id, "plain-agent"]);
    const capture = { spawned: 0 };
    const cfg = {
      registry: registryPath,
      runDir: join(dir, "runs"),
      readRegistry: async () => readRegistry(registryPath),
      backendFor: () => fakeBackendFactory(capture),
      loadLanesConfigFn: () => LANES,
    };
    const prevExit = process.exitCode;
    const { stderr } = await withCapturedConsole(async () => {
      await runCommand([HELD.id, "--prompt", "t"], cfg);
    });
    const holdLines = stderr.filter((l) => l.includes("dispatchHold="));
    assert.equal(holdLines.length, 1, "恰一行 dispatchHold advisory");
    assert.ok(holdLines[0].startsWith(`[wao] advisory: lane ${HELD.id} dispatchHold=`), "形制同资源计数行");
    assert.ok(holdLines[0].includes(HELD.dispatchHold), "夹具说明原文入行");
    assert.ok(holdLines[0].includes("照常进行"), "文案明示派发照常进行");
    assert.equal(capture.spawned, 1, "派发照常进行（backend 已 spawn）");
    assert.equal(process.exitCode ?? 0, prevExit ?? 0, "退出码不变");

    const { stderr: stderr2 } = await withCapturedConsole(async () => {
      await runCommand(["plain-agent", "--prompt", "t"], cfg);
    });
    assert.equal(stderr2.filter((l) => l.includes("dispatchHold=")).length, 0, "非车道目标 → 零 advisory");
    assert.equal(capture.spawned, 2, "第二次派发也照常完成");
  } finally { cleanupDir(dir); }
});

test("TD-283 CLI spawn：裸键 spawn 到带说明车道 → 同一行 advisory；派发照常完成", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td283-spawn-"));
  try {
    makeGitRepo(dir);
    const registryPath = writeRegistry(dir, [HELD.id]);
    const capture = { spawned: 0 };
    const cfg = {
      registry: registryPath,
      runDir: join(dir, "runs"),
      readRegistry: async () => readRegistry(registryPath),
      backendFor: () => fakeBackendFactory(capture),
      loadLanesConfigFn: () => LANES,
    };
    const prevExit = process.exitCode;
    const { stderr } = await withCapturedConsole(async () => {
      await spawnCommand([HELD.id, "--prompt", "t", "--wait"], cfg);
    });
    const holdLines = stderr.filter((l) => l.includes("dispatchHold="));
    assert.equal(holdLines.length, 1, "恰一行");
    assert.ok(holdLines[0].includes(HELD.dispatchHold), "夹具说明原文入行");
    assert.equal(capture.spawned, 1, "spawn 照常进行");
    assert.equal(process.exitCode ?? 0, prevExit ?? 0, "退出码不变");
    assert.equal(laneDispatchHold(LANES, HELD.id), HELD.dispatchHold, "选样自夹具车道表（守恒自检）");
  } finally { cleanupDir(dir); }
});

// ── 非默认 --registry：车道表停用（防跨绑，lanesDocForCall） ────────────────

test("lanesDocForCall：默认注册表 → 读车道表；非默认 --registry → 停用的空表（不读）", () => {
  let loads = 0;
  const loadFn = () => { loads += 1; return LANES; };
  const config = { registry: "C:/wao/config/agents.json" };
  assert.equal(lanesDocForCall({}, config, loadFn), LANES, "未给 --registry → 车道表");
  assert.equal(lanesDocForCall({ registry: "C:/wao/config/agents.json" }, config, loadFn), LANES, "--registry 等于默认 → 车道表");
  const off = lanesDocForCall({ registry: "C:/elsewhere/agents.json" }, config, loadFn);
  assert.equal(loads, 2, "非默认 --registry 不读车道表");
  assert.deepEqual(off.lanes, [], "停用的空表");
  assert.equal(laneDispatchHold(off, HELD.id), null, "停用的空表 → 无暂停说明");
});

test("TD-283 CLI run：非默认 --registry → 零 advisory，派发照常", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td283-otherreg-"));
  try {
    makeGitRepo(dir);
    const registryPath = writeRegistry(dir, [HELD.id]);
    const otherRegistry = join(dir, "other-agents.json");
    writeFileSync(otherRegistry, JSON.stringify({ agents: { [HELD.id]: { backend: "claude-code", cwd: dir } } }), "utf8");
    const capture = { spawned: 0 };
    const cfg = {
      registry: registryPath,
      runDir: join(dir, "runs"),
      readRegistry: async () => readRegistry(otherRegistry),
      backendFor: () => fakeBackendFactory(capture),
      loadLanesConfigFn: () => LANES,
    };
    const { stderr } = await withCapturedConsole(async () => {
      await runCommand([HELD.id, "--prompt", "t", "--registry", otherRegistry], cfg);
    });
    assert.equal(stderr.filter((l) => l.includes("dispatchHold=")).length, 0, "非默认注册表 → 零 advisory");
    assert.equal(capture.spawned, 1, "派发照常进行");
  } finally { cleanupDir(dir); }
});
