// test/registry-roles/kimiHomeTokenReadiness.test.js
//
// 决定 0074（车道就绪事实如实呈现）：声明 kimiHome 的 kimi-web 车道，
// <kimiHome>/server.token 文件就是它的凭据——registry_list 的
// credentialAvailability 按文件取值（inventory 两条路：严格 getRegistryInventory
// 与部分 getRegistryInventoryWithIssues 同口径）；missingCredentialEnvNames 恒
// 空表（无环境变量涉及）；输出不携带文件路径（MCP registry_list 的 AGENT_ENTRY
// 一字节不动，只改取值）。无 kimiHome 的 kimi-web 车道行为不变（仍按 tokenEnv）。
//
// 临时文件按仓规放 os.tmpdir() 下的临时目录（测试结束清理）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  kimiHomeTokenFileState,
  alignReadinessToKimiTokenFile,
  assessWorkerReadiness,
  createEnvResolver,
} from "../../src/application/credentialReadiness.js";
import {
  getRegistryInventory,
  getRegistryInventoryWithIssues,
} from "../../src/application/registryInventory.js";
import { requiredCredentialNames } from "../../src/envPolicy.js";

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** kimi-web + kimiHome 车道的合法 registry 条目（normalizeAgent 可过）。 */
function kimiAgent(home, extra = {}) {
  return {
    backend: "kimi-web",
    serveUrl: "http://127.0.0.1:58628",
    model: { id: "kimi-code/k3-256k" },
    tokenEnv: "TEST_KIMITOKEN_ENV",
    cwd: ".",
    ...(home !== null ? { kimiHome: home } : {}),
    ...extra,
  };
}

function fakeUserEnvReader(map = {}) {
  return async (name) => map[name];
}

async function inventoryFor(dir, agentEntry, withIssues) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents: { kim: agentEntry } }, null, 2), "utf8");
  const input = { registryPath, runDir: dir, userEnvReader: fakeUserEnvReader({}) };
  return withIssues ? getRegistryInventoryWithIssues(input) : getRegistryInventory(input);
}

// ── 单一判定：kimiHomeTokenFileState ─────────────────────────────────────────

test("决定 0074: kimiHomeTokenFileState——在且非空=present；缺失/纯空白/读失败=missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-kimitoken-state-"));
  try {
    const tokenFile = join(dir, "server.token");
    writeFileSync(tokenFile, "  tok-value-1  \n", "utf8");
    assert.equal(await kimiHomeTokenFileState(tokenFile), "present", "去首尾空白后非空");
    writeFileSync(tokenFile, "   \n\t", "utf8");
    assert.equal(await kimiHomeTokenFileState(tokenFile), "missing", "纯空白=空文件");
    rmSync(tokenFile, { force: true });
    assert.equal(await kimiHomeTokenFileState(tokenFile), "missing", "文件缺失");
    // 读失败 → missing（fail-closed，与派发侧 kimiWeb.resolveBearerToken 同口径）。
    assert.equal(
      await kimiHomeTokenFileState(tokenFile, async () => { throw new Error("probe-boom"); }),
      "missing",
      "读失败按缺失处理",
    );
  } finally { cleanupDir(dir); }
});

// ── 取值对齐：alignReadinessToKimiTokenFile ─────────────────────────────────

test("决定 0074: alignReadinessToKimiTokenFile——kimiHome 车道按文件取值；非 kimiHome 车道原样透传", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-kimitoken-align-"));
  try {
    const tokenFile = join(dir, "server.token");
    const agent = kimiAgent(dir);
    // 前置：这种车道 requiredCredentialNames 为空表（决定 0074——token 不经 env）。
    assert.deepEqual(requiredCredentialNames(agent), []);
    const base = await assessWorkerReadiness({ agent, resolver: createEnvResolver(fakeUserEnvReader({})) });
    assert.equal(base.credentialAvailability, "not_required", "对齐前的 env 面基线");

    writeFileSync(tokenFile, "tok-present", "utf8");
    const present = await alignReadinessToKimiTokenFile(agent, base);
    assert.equal(present.credentialAvailability, "available", "文件在且非空 → available");

    rmSync(tokenFile, { force: true });
    const absent = await alignReadinessToKimiTokenFile(agent, base);
    assert.equal(absent.credentialAvailability, "missing", "文件缺失 → missing");
    assert.deepEqual(absent.missingCredentialEnvNames, [], "missing 也不造环境变量名（无 env 涉及）");

    writeFileSync(tokenFile, "\n  ", "utf8");
    const empty = await alignReadinessToKimiTokenFile(agent, base);
    assert.equal(empty.credentialAvailability, "missing", "文件为空（纯空白） → missing");

    const plain = await assessWorkerReadiness({ agent: kimiAgent(null), resolver: createEnvResolver(fakeUserEnvReader({})) });
    assert.equal(await alignReadinessToKimiTokenFile(kimiAgent(null), plain), plain, "非 kimiHome 车道原样透传");
  } finally { cleanupDir(dir); }
});

// ── registry_list 取值（严格 + 部分两路同口径） ─────────────────────────────

test("决定 0074: registry inventory——kimiHome 车道 available/missing/空文件=missing；输出不携带文件路径", async () => {
  for (const withIssues of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), "wao-kimitoken-inv-"));
    try {
      const which = withIssues ? "部分路（MCP registry_list）" : "严格路（CLI registry list）";
      const entryOf = (inv) => (withIssues ? inv.agents : inv).find((a) => a.id === "kim");

      writeFileSync(join(dir, "server.token"), "tok-live", "utf8");
      let entry = entryOf(await inventoryFor(dir, kimiAgent(dir), withIssues));
      assert.equal(entry.credentialAvailability, "available", `${which}：文件在且非空 → available`);
      assert.deepEqual(entry.missingCredentialEnvNames, [], `${which}：无环境变量涉及`);

      writeFileSync(join(dir, "server.token"), "  \n", "utf8");
      entry = entryOf(await inventoryFor(dir, kimiAgent(dir), withIssues));
      assert.equal(entry.credentialAvailability, "missing", `${which}：文件为空 → missing`);

      rmSync(join(dir, "server.token"), { force: true });
      entry = entryOf(await inventoryFor(dir, kimiAgent(dir), withIssues));
      assert.equal(entry.credentialAvailability, "missing", `${which}：文件缺失 → missing`);
      assert.deepEqual(entry.missingCredentialEnvNames, [], `${which}：missing 恒空表`);

      // MCP 面 schema 不动、只改取值：输出绝不携带文件路径/主目录。
      const inv = await inventoryFor(dir, kimiAgent(dir), withIssues);
      assert.ok(!JSON.stringify(inv).includes("server.token"), `${which}：输出不携带 token 文件路径`);
      assert.ok(!JSON.stringify(inv).includes("kimiHome"), `${which}：输出不携带 kimiHome`);
    } finally { cleanupDir(dir); }
  }
});

test("决定 0074: 无 kimiHome 的 kimi-web 车道行为不变——仍按 tokenEnv 探测", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-kimitoken-envvar-"));
  try {
    delete process.env.TEST_KIMITOKEN_ENV;
    const entry = {
      backend: "kimi-web",
      serveUrl: "http://127.0.0.1:58628",
      model: { id: "kimi-code/k3-256k" },
      tokenEnv: "TEST_KIMITOKEN_ENV",
      cwd: ".",
    };
    let agents = await inventoryFor(dir, entry, false);
    assert.equal(agents.find((a) => a.id === "kim").credentialAvailability, "missing", "tokenEnv 未设 → missing");
    assert.deepEqual(
      agents.find((a) => a.id === "kim").missingCredentialEnvNames,
      ["TEST_KIMITOKEN_ENV"],
      "缺失名=声明的 tokenEnv（env 语义不变）",
    );
    process.env.TEST_KIMITOKEN_ENV = "test-key-kimi";
    try {
      agents = await inventoryFor(dir, entry, false);
      assert.equal(agents.find((a) => a.id === "kim").credentialAvailability, "available", "tokenEnv 已设 → available");
    } finally { delete process.env.TEST_KIMITOKEN_ENV; }
  } finally { cleanupDir(dir); }
});
