// test/migration-0045/sessionKeyUpgrade.test.js
//
// 0045 W3c：双会话键材料升维（R4 只增不减）+ 两洞关门。
//   KEY-* 键材料：新组件改变键、缺席=旧材料连续性（钉冻结 uuid）、形状校验闭。
//   HOLE-A runContinue：父 rolePin sha 与当前角色文件不符 → role_contract_drift 拒。
//   HOLE-B dispatchRun：explicit（resolvedLane/Role）× lead_workspace 席 → 不进复用路由。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// 冻结钉：旧材料（无新组件）的 uuid 必须与升级前逐字节一致——键连续性证明
// （派发者升级前后，同三元组的既有路由不孤儿化……在新组件缺席的调用面）。
const FROZEN_LEGACY_UUID = (() => {
  const material = "lead=ls-1\nworkspace=/wsp\nagent=coder_low";
  const digest = createHash("sha256").update(material, "utf8").digest();
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
})();

test("KEY-1: 缺席新组件=旧材料形状（键连续性冻结钉）；新组件在场=键必变", async () => {
  const { deriveOpaqueUuid } = await import("../../src/application/sessionReuse.js");
  const legacy = deriveOpaqueUuid({ leadSession: "ls-1", workspace: "/wsp", agentId: "coder_low" });
  assert.equal(legacy, FROZEN_LEGACY_UUID, "缺席新组件 → 与升级前材料逐字节一致（连续性）");
  const fp = "lane:" + "ab".repeat(8);
  const roleSha = sha256hex("role body");
  const upgraded = deriveOpaqueUuid({ leadSession: "ls-1", workspace: "/wsp", agentId: "coder_low", laneFingerprint: fp, roleSha256: roleSha });
  assert.notEqual(upgraded, legacy, "新组件入材料 → 键必变（一次性新会话）");
  const roleChanged = deriveOpaqueUuid({ leadSession: "ls-1", workspace: "/wsp", agentId: "coder_low", laneFingerprint: fp, roleSha256: sha256hex("role body EDITED") });
  assert.notEqual(roleChanged, upgraded, "改正文必 first（R4 验收项）");
  const noneSeat = deriveOpaqueUuid({ leadSession: "ls-1", workspace: "/wsp", agentId: "coder_low", laneFingerprint: fp, roleSha256: "none" });
  assert.notEqual(noneSeat, upgraded, "无角色显式标记 none（非空串）");
});

test("KEY-2: 谱系键同批升维（含 root 隔离）；形状校验闭（坏指纹/空串角色拒）", async () => {
  const { deriveLineageOpaqueUuid, deriveOpaqueUuid } = await import("../../src/application/sessionReuse.js");
  const base = { leadSession: "ls-1", workspace: "/wsp", agentId: "coder_low", laneFingerprint: "lane:" + "ab".repeat(8), roleSha256: "none" };
  const l1 = deriveLineageOpaqueUuid({ ...base, rootRunId: "run_20261005_aaaaaaaa" });
  const l2 = deriveLineageOpaqueUuid({ ...base, rootRunId: "run_20261005_bbbbbbbb" });
  assert.notEqual(l1, l2, "root 隔离保留");
  assert.notEqual(l1, deriveOpaqueUuid(base), "模式键空间隔离保留");
  assert.throws(() => deriveOpaqueUuid({ ...base, laneFingerprint: "not-a-fp" }), /laneFingerprint/);
  assert.throws(() => deriveOpaqueUuid({ ...base, roleSha256: "" }), /roleSha256/);
  assert.throws(() => deriveLineageOpaqueUuid({ ...base, rootRunId: "bad id" }), /rootRunId/);
});

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name T", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# t\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m i", { cwd: dir, stdio: "pipe" });
}
function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

test("HOLE-A: continue 臂——父 rolePin sha 与当前角色文件不符 → role_contract_drift 拒（同谱系静默换帽关门）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ha-"));
  const ROLES = join(REPO_ROOT, "config", "roles");
  writeFileSync(join(ROLES, "w3c-hat.md"), "# original\nW3C_ORIGINAL\n", "utf8");
  try {
    makeGitRepo(dir);
    const runId = "run_0045_hole_a";
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    const originalSha = sha256hex("# original\nW3C_ORIGINAL\n");
    const lines = [
      { type: "run.started", backend: "claude-code", cwd: dir, rolePin: { systemPrompt: "config/roles/w3c-hat.md", sha256: originalSha }, ts: "2026-10-05T00:00:00.000Z", runId, agentId: "w3c-seat", seq: 1 },
      { type: "session.created", backend: "claude-code", backendSessionId: "s1", ts: "2026-10-05T00:00:00.200Z", runId, agentId: "w3c-seat", seq: 2 },
      { type: "prompt.sent", prompt: "d", ts: "2026-10-05T00:00:00.300Z", runId, agentId: "w3c-seat", seq: 3 },
      { type: "run.state_change", from: "pending", to: "submitted", reason: "spawned", ts: "2026-10-05T00:00:00.400Z", runId, agentId: "w3c-seat", seq: 4 },
      { type: "run.state_change", from: "submitted", to: "completed", reason: "done", ts: "2026-10-05T00:00:01.000Z", runId, agentId: "w3c-seat", seq: 5 },
      { type: "run.session_reuse", mode: "run_lineage", turn: "first", rootRunId: runId, ts: "2026-10-05T00:00:01.050Z", runId, agentId: "w3c-seat", seq: 6 },
      { type: "run.completed", ts: "2026-10-05T00:00:01.100Z", runId, agentId: "w3c-seat", seq: 7 },
    ].map((l) => JSON.stringify(l)).join("\n");
    writeFileSync(join(runDir, `${runId}.jsonl`), lines + "\n", "utf8");
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      "w3c-seat": { backend: "claude-code", cwd: dir, systemPrompt: "config/roles/w3c-hat.md" },
    } }), "utf8");
    const { continueRun } = await import("../../src/application/runContinue.js");
    // 派发后角色文件被改：
    writeFileSync(join(ROLES, "w3c-hat.md"), "# TAMPERED\nW3C_ORIGINAL\n", "utf8");
    const r = await continueRun({
      parentRunId: runId, prompt: "fix",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
      runDir, registryPath, authorizedWorkspaceRoot: dir, leadSession: "ls-1",
      backendFor: () => ({ supportsSessionReuse: true }),
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "role_contract_drift");
    assert.match(r.detail, /SAME provider lineage under a different role/);
  } finally {
    cleanupDir(dir);
    rmSync(join(ROLES, "w3c-hat.md"), { force: true });
  }
});

test("HOLE-B（0052 修订）: dispatchRun——explicit（resolvedLane/Role）× lead_workspace 席 → 进复用路由（洞②开门，护栏在 resolveReuseTurn）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-hb-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      "reuse-seat": { backend: "claude-code", cwd: dir, sessionReuse: "lead_workspace" },
    } }), "utf8");
    const { dispatchRun } = await import("../../src/application/runDispatch.js");
    let argv = null;
    const result = await dispatchRun({
      agentId: "reuse-seat", prompt: "t",
      registryPath, runDir: join(dir, "runs"), runId: "run_0045_hole_b",
      leadSession: "stable-lead-session", cwd: dir,
      resolvedLane: "x-lane", resolvedRole: "x-role",
      spawnFn: (...a) => { argv = a[1]; return { pid: 1, unref() {}, on() {} }; },
      runnerPath: join(dir, "fake-runner.mjs"),
    });
    // 0052 洞②修订：explicit 派发不再被真门排除——生效政策（席位/角色）即分级
    // 开关；失败即弃/epoch/fresh 护栏在 resolveReuseTurn（0045 旧钉"永不进"反转）。
    assert.equal(result.providerSessionRouting !== "not_used" || argv.includes("--session-reuse-json"), true,
      "explicit 派发 × 生效 lead_workspace → 复用路由进入");
    assert.ok(argv.includes("--reuse-material-json"), "材料件随行（roleSha256 取本次派发角色，无角色=none）");
  } finally { cleanupDir(dir); }
});

test("HOLE-B 对照：lead_workspace 派发照常进复用路由（升维材料随行；W4b 政策语义）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-hb2-"));
  const ROLES = join(REPO_ROOT, "config", "roles");
  writeFileSync(join(ROLES, "w4b-hat.md"), "# w4b\nPOL_HAT\n", "utf8");
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    // 0045 W4b：席位字段降级——复用进路由须经 resolvedRoleId（角色政策或原生角色兼容）。
    // 本对照走"原生角色兼容"腿：席位 systemPrompt stem=派发角色+席位自带字段。
    writeFileSync(registryPath, JSON.stringify({ agents: {
      "reuse-seat": { backend: "claude-code", cwd: dir, systemPrompt: "config/roles/w4b-hat.md", sessionReuse: "lead_workspace" },
    } }), "utf8");
    const { dispatchRun } = await import("../../src/application/runDispatch.js");
    let argv = null;
    await dispatchRun({
      agentId: "reuse-seat", prompt: "t", resolvedRoleId: "w4b-hat",
      registryPath, runDir: join(dir, "runs"), runId: "run_0045_hole_b2",
      leadSession: "stable-lead-session", cwd: dir,
      spawnFn: (...a) => { argv = a[1]; return { pid: 1, unref() {}, on() {} }; },
      runnerPath: join(dir, "fake-runner.mjs"),
    });
    assert.ok(argv.includes("--session-reuse-json"), "原生角色兼容腿：复用派发照常路由");
    const matIdx = argv.indexOf("--reuse-material-json");
    assert.ok(matIdx >= 0, "升维材料随行");
    const material = JSON.parse(argv[matIdx + 1]);
    assert.match(material.laneFingerprint, /^lane:[0-9a-f]{16}$/, "车道指纹冻结");
    assert.notEqual(material.roleSha256, "none", "有角色席=正文 sha（非 none）");
  } finally {
    cleanupDir(dir);
    rmSync(join(ROLES, "w4b-hat.md"), { force: true });
  }
});
