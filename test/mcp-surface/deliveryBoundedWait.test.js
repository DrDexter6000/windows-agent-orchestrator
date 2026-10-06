// test/mcp-surface/deliveryBoundedWait.test.js
//
// TD-215 钉：repackage/reverify 有界等待——服务超窗=text-only pending 回执（验证
// 继续于服务进程）；窗内完成=既有契约原样。冻结 output schema 零触碰。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createWaoMcpServer } from "../../src/mcp/server.js";

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name T", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# t\n", "utf8");
  execSync("git add README.md && git commit -m init", { cwd: dir, stdio: "pipe" });
}

async function buildClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "bw-test", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

test("TD-215 ①: 服务超窗 → text-only pending 回执（isError 未设、无 structuredContent、指向 run_delivery）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bw-1-"));
  try {
    makeGitRepo(dir);
    // 注入永不 resolve 的 repackage 服务 + 极短等待窗。
    const prev = process.env.WAO_DELIVERY_WAIT_MS;
    process.env.WAO_DELIVERY_WAIT_MS = "50";
    const server = createWaoMcpServer({
      registryPath: join(dir, "agents.json"),
      runDir: join(dir, "runs"),
      workspaceRoot: dir,
      getRunDeliveryRepackageFn: () => new Promise(() => {}), // 永不完成（模拟长验证）
    });
    try {
      const client = await buildClient(server);
      const res = await client.callTool({
        name: "run_delivery_repackage",
        arguments: { runId: "run_202610061200000000000000", allowedPaths: ["src"] },
      });
      const text = res.content?.find((b) => b.type === "text")?.text ?? "";
      assert.notEqual(res.isError, true, "pending 不是错误");
      // TD-215 定稿：schema 增 status 枚举（会审批准的契约最小扩展）——pending 带
      // structuredContent={status:"pending", runId}；ok 字段缺席（.optional 化）。
      assert.deepEqual(
        Object.keys(res.structuredContent ?? {}).sort(),
        ["runId", "status"],
      );
      assert.equal(res.structuredContent?.status, "pending");
      assert.match(text, /run_delivery_repackage pending/);
      assert.match(text, /CONTINUES server-side/);
      assert.match(text, /Poll run_delivery/);
    } finally {
      if (prev === undefined) delete process.env.WAO_DELIVERY_WAIT_MS;
      else process.env.WAO_DELIVERY_WAIT_MS = prev;
      await server.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("TD-215 ②: 窗内完成 → 既有契约原样（payload 字段齐全）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bw-2-"));
  try {
    makeGitRepo(dir);
    mkdirSync(join(dir, "runs"), { recursive: true });
    const server = createWaoMcpServer({
      registryPath: join(dir, "agents.json"),
      runDir: join(dir, "runs"),
      workspaceRoot: dir,
      getRunDeliveryRepackageFn: async () => ({
        runId: "run_202610061200000000000000",
        deliveryCommit: "a".repeat(40),
        verificationStatus: "passed",
        source: "packaged",
        recoveryKind: "backend_failed",
        created: true,
      }),
    });
    try {
      const client = await buildClient(server);
      const res = await client.callTool({
        name: "run_delivery_repackage",
        arguments: { runId: "run_202610061200000000000000", allowedPaths: ["src"] },
      });
      assert.notEqual(res.isError, true);
      const sc = res.structuredContent ?? {};
      assert.equal(sc.status, "ok", "窗内=既有契约同步返回（status:ok）");
      assert.equal(sc.verificationStatus, "passed");
      assert.equal(sc.deliveryCommit, "a".repeat(40));
    } finally { await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
