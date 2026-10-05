// test/migration-0045/mcpExplicitDispatch.test.js
//
// 0045 §6 第 5 步：run_dispatch 的 lane/role 显式派发（MCP 面）。
//   W5-1 explicit：{lane, role} → 解析（接线席位）→ dispatcher 收 resolvedLane/Role。
//   W5-2 选择器错误：未知 lane / 混用 → isError 固定文案（闭集码+合法全集+修正例），零派发。
//   W5-3 旧调用兼容：仅 {agentId} → dispatcher 收 agentId 原值、无 resolvedLane/Role。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const { createWaoMcpServer } = await import("../../src/mcp/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name T", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# t\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m i", { cwd: dir, stdio: "pipe" });
}
function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpw5-"));
  try {
    makeGitRepo(dir);
    // 注册表与在库车道表 claude-opus 轴一致（公开轴=backend/model/effort）
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      "claude-opus": { backend: "claude-code", model: { id: "claude-opus-5-5" }, reasoning: { effort: "xhigh" }, cwd: dir },
      legacy_seat: { backend: "claude-code", cwd: dir },
    } }), "utf8");
    const dispatches = [];
    const server = createWaoMcpServer({
      registryPath, runDir: dir, workspaceRoot: dir,
      dispatchRunFn: async (input) => {
        dispatches.push(input);
        return { accepted: true, runId: "run_0045_w5_fake", agentId: input.agentId, state: "pending", providerSessionRouting: "not_used" };
      },
    });
    const client = new Client({ name: "wao-test", version: "0.0.1" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      await fn({ dir, client, dispatches });
    } finally {
      await client.close();
      await server.close();
    }
  } finally { cleanupDir(dir); }
}

test("W5-1: MCP explicit {lane,role} 派发——dispatcher 收接线席位+resolvedLane/Role", async () => {
  await withServer(async ({ client, dispatches }) => {
    const res = await client.callTool({
      name: "run_dispatch",
      arguments: { lane: "claude-opus", role: "auditor", prompt: "review this" },
    });
    assert.equal(res.isError, undefined, `unexpected error: ${JSON.stringify(res.content ?? res).slice(0, 200)}`);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].agentId, "claude-opus", "W4d：接线=注册表车道键（解析结果）");
    assert.equal(dispatches[0].resolvedLane, "claude-opus");
    assert.equal(dispatches[0].resolvedRole, "auditor");
    assert.equal(res.structuredContent.agentId, "claude-opus", "出参绑定=解析后身份（车道键）");
  });
});

test("W5-2: 选择器错误→isError 固定文案（闭集码+合法全集+修正例），零派发", async () => {
  await withServer(async ({ client, dispatches }) => {
    const unknownLane = await client.callTool({
      name: "run_dispatch",
      arguments: { lane: "claude-opus1", role: "auditor", prompt: "x" },
    });
    assert.equal(unknownLane.isError, true);
    const text = unknownLane.content[0].text;
    assert.match(text, /unknown_lane/);
    assert.match(text, /known lanes \(\d+\): /);
    assert.ok(text.includes("claude-opus"), "合法全集含正确车道");
    assert.match(text, /fix: run_dispatch\(/);

    const mixed = await client.callTool({
      name: "run_dispatch",
      arguments: { agentId: "legacy_seat", lane: "claude-opus", role: "auditor", prompt: "x" },
    });
    assert.equal(mixed.isError, true);
    assert.match(mixed.content[0].text, /dispatch_selector_invalid/);
    assert.equal(dispatches.length, 0, "零派发（两种错误都不触达 dispatcher）");
  });
});

test("W5-3: 旧调用 {agentId} 字节兼容——无 lane/role 时 dispatcher 收原值、无解析字段", async () => {
  await withServer(async ({ client, dispatches }) => {
    const res = await client.callTool({
      name: "run_dispatch",
      arguments: { agentId: "legacy_seat", prompt: "same as ever" },
    });
    assert.equal(res.isError, undefined);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].agentId, "legacy_seat");
    assert.equal(dispatches[0].resolvedLane, undefined, "无解析字段（字节兼容）");
    assert.equal(dispatches[0].resolvedRole, undefined);
  });
});
