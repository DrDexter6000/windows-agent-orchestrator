// test/mcp-surface/mcpContinuableAuto.test.js
//
// 第 154 批（决定 0133）：MCP run_dispatch 的 continuable 三态——
//   - 穿线：缺省不传键（服务自动判定）、false / true 原样穿，能力解析器恒透传；
//   - 回执：continuable 所有派发都带，自动模式带交付没开成时带闭集 continuableOff；
//   - outputSchema：continuable 必填布尔，continuableOff 枚举 = 派发服务 SSOT；
//   - 真实服务串联：真实 dispatchRun + MCP 的真实能力解析器 + 假 spawn。
// 用例名标明"自动"或"显式"。不调用付费运行时。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWaoMcpServer } from "../../src/mcp/server.js";
import { dispatchRun as realDispatchRun, CONTINUABLE_OFF_REASONS } from "../../src/application/runDispatch.js";

const DELIVERY = { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] };
const TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: dir, stdio: "pipe" });
}
async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-client", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}
const textOf = (res) => res.content.find((b) => b.type === "text").text;

// 一个 git 工作区 + registry；回调拿到 call(args, dispatcherFn)。
async function withServer(agents, dispatchRunFn, fn) {
  const dir = mkdtempSync(join(tmpdir(), "wao-b154-mcp-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
    const server = createWaoMcpServer({ registryPath, runDir: join(dir, "runs"), workspaceRoot: dir, dispatchRunFn });
    const client = await buildInMemoryClient(server);
    try {
      const call = async (args) => {
        const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "seat", prompt: "do it", expectedWorkspaceRoot: dir, ...args } });
        return res.isError ? { isError: true, text: textOf(res) } : JSON.parse(textOf(res));
      };
      return await fn({ call, client, dir });
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CLAUDE_SEAT = (dir) => ({ seat: { backend: "claude-code", cwd: dir } });
function fakeDispatcher(extra = {}) {
  const inputs = [];
  const fn = async (input) => {
    inputs.push(input);
    return { accepted: true, runId: "run_b154_mcp", agentId: "seat", state: "pending", providerSessionRouting: "not_used", transcriptPath: "/x.jsonl", ...extra };
  };
  return { fn, inputs };
}

test("MCP 穿线：自动 = 不传 continuable 键；显式 false / true 原样穿；能力解析器恒透传（自动判定靠它）", async () => {
  const { fn, inputs } = fakeDispatcher();
  await withServer({ seat: { backend: "claude-code", cwd: tmpdir() } }, fn, async ({ call }) => {
    await call({ delivery: DELIVERY });
    await call({ delivery: DELIVERY, continuable: false });
    await call({ delivery: DELIVERY, continuable: true });
  });
  assert.equal(inputs.length, 3);
  assert.equal("continuable" in inputs[0], false, "自动：键不传");
  assert.equal(inputs[1].continuable, false, "显式 false 不会被当成缺省");
  assert.equal(inputs[2].continuable, true);
  for (const input of inputs) assert.equal(typeof input.backendFor, "function");
});

test("MCP 回执：continuable 严格 === true 才读成 true；缺失 → false 且不带 continuableOff；服务给的闭集原因原样带出", async () => {
  const cases = [
    [{ continuable: true }, { continuable: true }],
    [{}, { continuable: false }],
    [{ continuable: false, continuableOff: "override" }, { continuable: false, continuableOff: "override" }],
    [{ continuable: false, continuableOff: "argv_budget" }, { continuable: false, continuableOff: "argv_budget" }],
    [{ continuable: false, continuableOff: "lineage_slot_unavailable" }, { continuable: false, continuableOff: "lineage_slot_unavailable" }],
    [{ continuable: "yes" }, { continuable: false }],
  ];
  for (const [serviceExtra, wire] of cases) {
    const { fn } = fakeDispatcher(serviceExtra);
    await withServer({ seat: { backend: "claude-code", cwd: tmpdir() } }, fn, async ({ call }) => {
      const parsed = await call({ delivery: DELIVERY });
      assert.equal(parsed.continuable, wire.continuable);
      assert.equal(parsed.continuableOff, wire.continuableOff);
      assert.equal("continuableOff" in parsed, "continuableOff" in wire);
    });
  }
});

test("MCP 回执：闭集之外的 continuableOff（含已退出的 read_only / lead_workspace）→ 固定派发错误，不透传", async () => {
  for (const bad of ["read_only", "lead_workspace", "foreground", "weird"]) {
    const { fn } = fakeDispatcher({ continuable: false, continuableOff: bad });
    await withServer({ seat: { backend: "claude-code", cwd: tmpdir() } }, fn, async ({ call }) => {
      const res = await call({ delivery: DELIVERY });
      assert.equal(res.isError, true, `${bad} 不在闭集`);
      assert.equal(res.text.includes(bad), false, "不回显域外值");
    });
  }
});

test("MCP outputSchema：continuable 必填布尔；continuableOff 可选，枚举与派发服务闭集同源", async () => {
  await withServer({ seat: { backend: "claude-code", cwd: tmpdir() } }, fakeDispatcher().fn, async ({ client }) => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "run_dispatch");
    const props = tool.outputSchema.properties;
    assert.equal(props.continuable.type, "boolean");
    assert.ok(tool.outputSchema.required.includes("continuable"));
    assert.deepEqual(props.continuableOff.enum, [...CONTINUABLE_OFF_REASONS]);
    assert.equal(tool.outputSchema.required.includes("continuableOff"), false);
    // 输入面不变：continuable 仍是可选布尔。
    assert.equal(tool.inputSchema.properties.continuable.type, "boolean");
    assert.equal((tool.inputSchema.required ?? []).includes("continuable"), false);
  });
});

// ── 真实服务串联 ──────────────────────────────────────────────────────────

function realService(extra = {}) {
  const spawned = [];
  const spawnFn = (cmd, args) => { spawned.push(args); return { unref() {} }; };
  const fn = (input) => realDispatchRun({ ...input, spawnFn, skipCredentialCheck: true, ...extra });
  return { fn, spawned };
}

test("MCP 自动（真实服务 + 真实解析器）：交付 + codex 席位 → 开；非交付 → continuable:false 不带原因；model 覆盖 → 关 + override", async () => {
  const { fn, spawned } = realService();
  await withServer({ seat: { backend: "codex", cwd: tmpdir(), model: { id: "fixture-model" } } }, fn, async ({ call }) => {
    const rooted = await call({ delivery: DELIVERY });
    assert.equal(rooted.accepted, true);
    assert.equal(rooted.continuable, true);
    assert.equal("continuableOff" in rooted, false);
    assert.equal(rooted.providerSessionRouting, "first_turn_requested");

    const plain = await call({});
    assert.equal(plain.continuable, false);
    assert.equal("continuableOff" in plain, false, "非交付派发不带这个键");

    const overridden = await call({ delivery: DELIVERY, model: "fixture-model-2" });
    assert.equal(overridden.accepted, true, "覆盖在自动模式下不拒绝");
    assert.equal(overridden.continuable, false);
    assert.equal(overridden.continuableOff, "override");
  });
  assert.equal(spawned.length, 3, "三次派发都 fork 了 runner");
});

test("MCP 自动（真实服务 + 真实解析器）：claude-code 无令牌 → 静默关闭、派发成功、session_reuse_unavailable；显式 true 照旧受理建谱系；显式 false 不带原因", async () => {
  const { fn } = realService({ resolvedCredentials: { [TOKEN_ENV]: "" } });
  await withServer(CLAUDE_SEAT(tmpdir()), fn, async ({ call }) => {
    const auto = await call({ delivery: DELIVERY });
    assert.equal(auto.accepted, true);
    assert.equal(auto.continuable, false);
    assert.equal(auto.continuableOff, "session_reuse_unavailable");
    assert.equal(auto.providerSessionRouting, "not_used");

    const explicitOn = await call({ delivery: DELIVERY, continuable: true });
    assert.equal(explicitOn.continuable, true, "显式 true 行为不变（令牌条件只在 spawn 时失败）");

    const explicitOff = await call({ delivery: DELIVERY, continuable: false });
    assert.equal(explicitOff.continuable, false);
    assert.equal("continuableOff" in explicitOff, false);
  });
});

test("MCP 自动（真实服务）：有令牌的 claude-code → 开", async () => {
  const { fn } = realService({ resolvedCredentials: { [TOKEN_ENV]: "fixture-oauth-value" } });
  await withServer(CLAUDE_SEAT(tmpdir()), fn, async ({ call }) => {
    const r = await call({ delivery: DELIVERY });
    assert.equal(r.continuable, true);
    assert.equal(r.providerSessionRouting, "first_turn_requested");
  });
});

test("MCP 显式 true（真实服务）：model 覆盖仍按固定文案拒绝", async () => {
  const { fn } = realService({ resolvedCredentials: { [TOKEN_ENV]: "fixture-oauth-value" } });
  await withServer(CLAUDE_SEAT(tmpdir()), fn, async ({ call }) => {
    const res = await call({ delivery: DELIVERY, continuable: true, model: "fixture-model-2" });
    assert.equal(res.isError, true);
    assert.match(res.text, /model_override_reuse_conflict/);
  });
});
