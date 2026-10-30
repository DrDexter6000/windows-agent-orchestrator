// test/delivery/mcpRunDeliveryAdoption.test.js
//
// 决定 0098：MCP run_delivery 出参的 adoption 对象。
//
//   - strict 闭集投影：found/not_found 带提交 sha；unchecked 带闭集原因；
//     服务值缺 adoption → 缺省 unchecked/unbound；malformed → 固定错误。
//   - branch 不上 wire（只给 CLI 文本行用）。
//   - BASE 字节不变：run_delivery 的 outputSchema 含 adoption，而
//     run_delivery_review_bundle（嵌 BASE）的 outputSchema 不含。
//   - 等待路径（waitMs）同样携带 adoption。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWaoMcpServer } from "../../src/mcp/server.js";

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function deliveryView(adoption) {
  return {
    runId: "run_x",
    terminalState: "completed",
    deliveryRef: {
      deliveryCommit: "d".repeat(40),
      baseCommit: "b".repeat(40),
      worktreePath: "C:\\Users\\owner\\secret\\worktree",
      branch: "wao/run_x",
      changedFiles: ["src/a.js"],
      verification: { status: "passed", commands: ["npm test"], results: [], failureCode: null },
      acceptance: { status: "pending", reviewerType: "lead_agent" },
      integration: { status: "pending", targetCommit: null },
    },
    verification: { status: "passed" },
    acceptance: { status: "pending" },
    ...(adoption === undefined ? {} : { adoption }),
  };
}

async function callRunDelivery(server, args = { runId: "run_x" }) {
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_delivery", arguments: args });
    return { res, parsed: JSON.parse(res.content.find((b) => b.type === "text").text) };
  } finally {
    await client.close();
    await server.close();
  }
}

test("0098-MCP-1: found——adoption 投影为 strict 闭集对象，branch 不上 wire", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => deliveryView({
      status: "found",
      commits: ["a".repeat(40), "c".repeat(40)],
      truncated: true,
      uncheckedReason: null,
      branch: "main",
    }),
  });
  const { res, parsed } = await callRunDelivery(server);
  assert.equal(res.isError, undefined);
  assert.deepEqual(parsed.adoption, {
    status: "found",
    commits: ["a".repeat(40), "c".repeat(40)],
    truncated: true,
    uncheckedReason: null,
  });
  assert.equal("branch" in parsed.adoption, false, "branch 只给 CLI 文本行用，不进 MCP 出参");
  assert.ok(res.structuredContent, "structuredContent 在场");
  assert.deepEqual(res.structuredContent.adoption, parsed.adoption);
});

test("0098-MCP-2: 服务值缺 adoption → 缺省 unchecked/unbound（不报错）", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => deliveryView(undefined),
  });
  const { res, parsed } = await callRunDelivery(server);
  assert.equal(res.isError, undefined);
  assert.deepEqual(parsed.adoption, { status: "unchecked", commits: [], truncated: false, uncheckedReason: "unbound" });
});

test("0098-MCP-3: unchecked/timeout 原样过闭集；not_found 不带原因", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => deliveryView({
      status: "unchecked", commits: [], truncated: false, uncheckedReason: "timeout", branch: null,
    }),
  });
  const { parsed } = await callRunDelivery(server);
  assert.deepEqual(parsed.adoption, { status: "unchecked", commits: [], truncated: false, uncheckedReason: "timeout" });

  const server2 = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => deliveryView({
      status: "not_found", commits: [], truncated: false, uncheckedReason: null, branch: "main",
    }),
  });
  const { parsed: parsed2 } = await callRunDelivery(server2);
  assert.deepEqual(parsed2.adoption, { status: "not_found", commits: [], truncated: false, uncheckedReason: null });
});

test("0098-MCP-4: malformed 服务值 → 固定安全错误（不回显动态内容）", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => deliveryView({ status: "very-weird", commits: [], truncated: false, uncheckedReason: null }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
    assert.equal(res.isError, true);
    assert.equal(res.content.find((b) => b.type === "text").text, "run_delivery failed");
  } finally {
    await client.close();
    await server.close();
  }
});

test("0098-MCP-5: BASE 字节不变——bundle 的嵌 delivery schema 不含 adoption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adopt-base-"));
  try {
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
    const client = await buildInMemoryClient(server);
    try {
      const tools = (await client.listTools()).tools;
      const runDelivery = tools.find((t) => t.name === "run_delivery");
      const bundle = tools.find((t) => t.name === "run_delivery_review_bundle");
      assert.ok(runDelivery && bundle, "两个工具都在面");
      assert.ok(JSON.stringify(runDelivery.outputSchema).includes("adoption"),
        "run_delivery 的 outputSchema 含 adoption（standalone 出参）");
      assert.equal(JSON.stringify(bundle.outputSchema).includes("adoption"), false,
        "review_bundle 嵌 BASE，delivery 子 schema 不含 adoption（字节不变）");
    } finally {
      await client.close();
      await server.close();
    }
  } finally { cleanupDir(dir); }
});

test("0098-MCP-6: 等待路径（waitMs）同样携带 adoption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adopt-mcp6-"));
  try {
    const { execFileSync } = await import("node:child_process");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "README.md"), "# t", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir, stdio: "pipe" });
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: join(dir, "runs"), workspaceRoot: dir,
      getRunDeliveryReadinessFn: async () => ({
        runId: "run_x",
        readiness: "waiting_for_packaging",
        waitReturnedEarly: false,
        terminalState: "running",
        deliveryAvailable: false,
        deliveryRequested: true,
        deliveryFailure: null,
        adoption: { status: "found", commits: ["e".repeat(40)], truncated: false, uncheckedReason: null, branch: "main" },
      }),
    });
    const { res, parsed } = await callRunDelivery(server, { runId: "run_x", waitMs: 1000 });
    assert.equal(res.isError, undefined);
    assert.deepEqual(parsed.adoption, { status: "found", commits: ["e".repeat(40)], truncated: false, uncheckedReason: null });
  } finally { cleanupDir(dir); }
});
