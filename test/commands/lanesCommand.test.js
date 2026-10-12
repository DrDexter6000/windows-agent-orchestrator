// test/commands/lanesCommand.test.js
//
// 0064：`wao lanes` 命令适配层钉（夹具面——非默认 registry 与显式车道表成对）：
//   - 防跨绑成对规则：单独 --registry 拒绝；--registry+--lanes-file 放行+注记；
//   - --json 白名单投影：不泄漏 cwd/sessionReuse/missingCredentialEnvNames；
//   - 车道表权威失败：exitCode 1 + 不渲染正常车道面；
//   - 未知选项 fail-fast。
// readyState 断言只验闭集成员（真探测随机器环境变化——不断言具体值）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lanesCommand } from "../../src/commands/lanes.js";

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const READY_STATES = new Set([
  "ready", "missing_cli", "missing_key", "missing_both", "login_based",
  "key_only_present", "key_only_missing", "unknown",
]);

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "wao-lanescmd-"));
  mkdirSync(join(dir, "runs"), { recursive: true });
  // 夹具车道表：两条车道（l1 与 registry 四轴一致；l2 漂移）。
  writeFileSync(join(dir, "lanes.json"), JSON.stringify({
    schema: 2,
    lanes: [
      { id: "l1", backend: "zcode", model: { id: "bigmodel-api/GLM-5.3" }, reasoning: { effort: "max" }, aliases: {} },
      { id: "l2", backend: "codex", model: { id: "gpt-6.1-sol" }, reasoning: { effort: "high" }, aliases: {} },
    ],
  }), "utf8");
  // 夹具 registry：l1 接线一致；l2 的 model 漂移（G4 判定=drift）。
  writeFileSync(join(dir, "agents.json"), JSON.stringify({
    agents: {
      l1: { backend: "zcode", model: { id: "bigmodel-api/GLM-5.3" }, reasoning: { effort: "max" }, binary: "C:/wao-test-zcode/zcode.cjs", cwd: dir, seatRole: "adversarial" },
      l2: { backend: "codex", model: { id: "gpt-6-astra" }, reasoning: { effort: "high" }, cwd: dir },
    },
  }), "utf8");
  // 夹具台账：l1 匹配记录（certified）；l2 记录身份与 registry 不匹配（→null）。
  writeFileSync(join(dir, "runs", "reliability-summary.json"), JSON.stringify({
    ledgerKeySpace: "lane-v1",
    workers: {
      "lane:deadbeef": {
        status: "certified", backend: "zcode", modelId: "bigmodel-api/GLM-5.3",
        lastHealthyRunAt: "2026-10-06T00:00:00.000Z",
      },
    },
  }), "utf8");
  return dir;
}

test("wao lanes：成对面渲染——drift 判定/cert null 语义/readyState 闭集（0065：seatRole 列退役）", async () => {
  const dir = makeEnv();
  try {
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => { lines.push(a.join(" ")); };
    try {
      await lanesCommand(
        ["--registry", join(dir, "agents.json"), "--lanes-file", join(dir, "lanes.json"), "--run-dir", join(dir, "runs")],
        { registry: "config/agents.json", runDir: join(dir, "runs") },
      );
    } finally { console.log = origLog; }
    const text = lines.join("\n");
    assert.ok(text.includes("显式拼接面"), "成对放行有横幅注记");
    assert.ok(text.includes("lane l1"), "l1 在场");
    assert.ok(/接线: 漂移——explicit 派发将拒绝/.test(text), "l2 drift 判定与拒绝语义");
    assert.ok(!text.includes("seatRole:"), "seatRole 列已退役（0065）");
    assert.ok(text.includes("certification: certified"), "台账匹配记录显示");
    assert.ok(text.includes("未取得匹配认证"), "l2 身份不匹配→null 语义文案");
    assert.equal(process.exitCode, undefined, "正常面不改退出码");
  } finally { cleanupDir(dir); }
});

test("wao lanes --json：白名单投影——不泄漏 cwd/sessionReuse/missingCredentialEnvNames", async () => {
  const dir = makeEnv();
  try {
    let payload = null;
    const origLog = console.log;
    console.log = (s) => { payload = JSON.parse(s); };
    try {
      await lanesCommand(
        ["--json", "--registry", join(dir, "agents.json"), "--lanes-file", join(dir, "lanes.json"), "--run-dir", join(dir, "runs")],
        { registry: "config/agents.json", runDir: join(dir, "runs") },
      );
    } finally { console.log = origLog; }
    const l1 = payload.lanes.find((r) => r.id === "l1");
    assert.equal(l1.wiring, "wired");
    assert.equal(l1.certification, "certified");
    assert.ok(READY_STATES.has(l1.readyState), `readyState 闭集成员（got ${l1.readyState}）`);
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes("sessionReuse"), "不泄漏 sessionReuse");
    assert.ok(!serialized.includes("missingCredentialEnvNames"), "不泄漏凭据名");
    assert.ok(!serialized.includes("credentialAvailability"), "不泄漏凭据可用性");
    assert.ok(!/"cwd"/.test(serialized), "不泄漏 cwd");
    assert.ok(payload.registryPath.endsWith("agents.json"));
  } finally { cleanupDir(dir); }
});

test("wao lanes：防跨绑——单独非默认 --registry 拒绝；未知选项 fail-fast", async () => {
  const dir = makeEnv();
  try {
    await assert.rejects(
      lanesCommand(["--registry", join(dir, "agents.json")], { registry: "config/agents.json", runDir: join(dir, "runs") }),
      /防跨绑/,
      "单独 --registry（无 --lanes-file）拒绝",
    );
    await assert.rejects(
      lanesCommand(["--bogus"], { registry: "config/agents.json", runDir: join(dir, "runs") }),
      /unknown option/,
      "未知选项 fail-fast",
    );
  } finally { cleanupDir(dir); }
});

test("wao lanes：车道表权威失败（结构非法）→ exitCode 1 + 不渲染车道面", async () => {
  const dir = makeEnv();
  try {
    // 结构非法反例：未知顶层键（TOP_KEYS 白名单违规 → ok:false）。
    // 注：lanes 非数组会被 loadLanesConfig 静默归 []（合法空表面）——不是结构
    // 非法形状；结构非法走白名单违规。
    writeFileSync(join(dir, "lanes.json"), JSON.stringify({ schema: 2, lanes: [], bogusKey: 1 }), "utf8");
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => { lines.push(a.join(" ")); };
    const prevExit = process.exitCode;
    try {
      await lanesCommand(
        ["--registry", join(dir, "agents.json"), "--lanes-file", join(dir, "lanes.json"), "--run-dir", join(dir, "runs")],
        { registry: "config/agents.json", runDir: join(dir, "runs") },
      );
    } finally { console.log = origLog; }
    const text = lines.join("\n");
    assert.ok(text.includes("车道表不可用"), "失败面标题");
    assert.ok(!text.includes("lane l1"), "不渲染正常车道面");
    assert.equal(process.exitCode, 1, "exitCode 1");
    process.exitCode = prevExit;
  } finally { cleanupDir(dir); }
});
