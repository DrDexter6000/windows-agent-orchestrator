// test/commands/registryListDispatchHold.test.js
//
// TD-283：CLI `registry list` 的 dispatchHold 显示钉：
//   - --format json：每个条目带 dispatchHold: string | null（服务层 join 的
//     直投影；MCP registry_list 同源，wire 面另钉于 mcpRegistry.test.js）。
//   - 人读表：任一车道带说明才追加 dispatchHold 列（无暂停时输出与旧表逐字节
//     一致）；值缺席显示 "-"。
// 车道表走夹具（经 config.lanesDocFn 测试缝注入 inventory 服务）——本文件不读
// 真实 config/lanes.json（解除暂停改表后这里不红），Owner 原话不抄第二份。
// registry/runDir 全走临时目录，零真实派发。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registryCommand } from "../../src/commands/registry.js";

// 夹具车道表：一条带 dispatchHold 的车道 + 一条无说明车道。
const LANES = {
  ok: true, path: "fixture", sha256: "ab".repeat(32), issues: [],
  lanes: [
    { id: "held-lane", backend: "claude-code", model: { id: "fixture-m" }, reasoning: null, aliases: {}, dispatchHold: "夹具：暂停说明" },
    { id: "plain-lane", backend: "claude-code", model: { id: "fixture-m" }, reasoning: null, aliases: {} },
  ],
};
const HELD = LANES.lanes[0];

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeEnv(agentIds) {
  const dir = mkdtempSync(join(tmpdir(), "wao-reglist-hold-"));
  const runDir = join(dir, "runs");
  mkdirSync(runDir, { recursive: true });
  const registryPath = join(dir, "agents.json");
  const agents = {};
  for (const id of agentIds) agents[id] = { backend: "claude-code", cwd: dir };
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return { dir, runDir, registryPath };
}

async function runList(args, { registryPath, runDir }) {
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => { lines.push(a.join(" ")); };
  try {
    await registryCommand(args, { registry: registryPath, runDir, lanesDocFn: () => LANES });
  } finally {
    console.log = origLog;
  }
  return lines;
}

test("TD-283 registry list --format json：条目带 dispatchHold（有说明=原文，无=null）", async () => {
  const env = makeEnv([HELD.id, "plain-agent"]);
  try {
    const lines = await runList(["list", "--registry", env.registryPath, "--run-dir", env.runDir, "--format", "json"], env);
    const payload = JSON.parse(lines.join("\n"));
    assert.equal(payload.find((a) => a.id === HELD.id).dispatchHold, HELD.dispatchHold, "车道表夹具说明原文透出");
    assert.equal(payload.find((a) => a.id === "plain-agent").dispatchHold, null, "非车道/无说明 → null");
  } finally { cleanupDir(env.dir); }
});

test("TD-283 registry list 人读表：有说明才加列；值缺席显示 '-'；无暂停时表头逐字节不变", async () => {
  const held = makeEnv([HELD.id, "plain-agent"]);
  try {
    const lines = await runList(["list", "--registry", held.registryPath, "--run-dir", held.runDir], held);
    assert.ok(lines[0].endsWith("\tdispatchHold"), "表头追加 dispatchHold 列");
    const heldRow = lines.find((l) => l.startsWith(`${HELD.id}\t`));
    const plainRow = lines.find((l) => l.startsWith("plain-agent\t"));
    assert.ok(heldRow.endsWith(`\t${HELD.dispatchHold}`), "夹具说明原文入行");
    assert.ok(plainRow.endsWith("\t-"), "无说明行显示 '-'");
  } finally { cleanupDir(held.dir); }

  // 无任何带说明车道的注册面：表头/行与旧输出逐字节一致（零说明=零列）。
  const plain = makeEnv(["plain-agent"]);
  try {
    const lines = await runList(["list", "--registry", plain.registryPath, "--run-dir", plain.runDir], plain);
    assert.deepEqual(lines, [
      "id\tbackend\tmodel\tcertification\tcwd",
      `plain-agent\tclaude-code\t(default)\t-\t${plain.dir}`,
    ], "无暂停说明时人读表字节不变");
  } finally { cleanupDir(plain.dir); }
});

test("TD-283 registry list：非默认 --registry → 车道表停用，dispatchHold 为 null", async () => {
  const env = makeEnv([HELD.id]);
  try {
    const otherRegistry = join(env.dir, "other-agents.json");
    writeFileSync(otherRegistry, JSON.stringify({ agents: { [HELD.id]: { backend: "claude-code", cwd: env.dir } } }), "utf8");
    const lines = await runList(["list", "--registry", otherRegistry, "--run-dir", env.runDir, "--format", "json"], env);
    const payload = JSON.parse(lines.join("\n"));
    assert.equal(payload.find((a) => a.id === HELD.id).dispatchHold, null, "非默认注册表不按本仓库车道表 join");
  } finally { cleanupDir(env.dir); }
});
