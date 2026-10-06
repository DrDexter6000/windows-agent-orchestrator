// test/mcp-surface/mcpCertGate.test.js
//
// 0046 §5 步⑨（D10 认证清单门禁）单元钉：部署级开关 WAO_MCP_REQUIRE_CERTIFIED
// （默认关）只驻 MCP 边界——开着时 run_dispatch 仅放行认证清单成员
// （selectCertRecord 双空间命中 + status ∈ {certified, conditional}；新鲜度不进门），
// 台账缺失/键空间不对=fail-closed 拒绝；关着时行为零变化（advisory 语义保留）。
// 修订背景：ADR 0018"认证非 permission gate"的 0046 §1.4 部署级例外（Owner 指令
// "派发只派认证清单中的"），CLI 保持特权通道（认证 drill 自举路径）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createWaoMcpServer } from "../../src/mcp/server.js";

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

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-gate-test-client", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function dispatchOnce({ dir, gateEnv, summaryWorkers, laneKey }) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents: {
    fresh_lane: { backend: "codex", model: { id: "gpt-6.1-sol" }, reasoning: { effort: "high" }, cwd: dir },
  } }), "utf8");
  const runDir = join(dir, "runs");
  mkdirSync(runDir, { recursive: true });
  if (summaryWorkers !== null) {
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
      ledgerKeySpace: "lane-v1",
      workers: summaryWorkers ?? {},
    }), "utf8");
  }
  let dispatched = null;
  const server = createWaoMcpServer({
    registryPath, runDir, workspaceRoot: dir,
    dispatchRunFn: async (args) => {
      dispatched = args;
      return { runId: "run_gate_probe", state: "submitted" };
    },
  });
  const prev = process.env.WAO_MCP_REQUIRE_CERTIFIED;
  try {
    if (gateEnv === undefined) delete process.env.WAO_MCP_REQUIRE_CERTIFIED;
    else process.env.WAO_MCP_REQUIRE_CERTIFIED = gateEnv;
    const client = await buildInMemoryClient(server);
    const res = await client.callTool({
      name: "run_dispatch",
      arguments: { agentId: "fresh_lane", prompt: "gate probe" },
    });
    const text = res.content?.find((b) => b.type === "text")?.text ?? "";
    return { dispatched, isError: Boolean(res.isError), text };
  } finally {
    if (prev === undefined) delete process.env.WAO_MCP_REQUIRE_CERTIFIED;
    else process.env.WAO_MCP_REQUIRE_CERTIFIED = prev;
    await server.close();
  }
}

// 认证记录形（matchedCertRecord 事实匹配面）：backend/modelId 对得上即可命中。
const CERTIFIED_REC = { agentId: "fresh_lane", backend: "codex", modelId: "gpt-6.1-sol", status: "certified" };
const CONDITIONAL_REC = { agentId: "fresh_lane", backend: "codex", modelId: "gpt-6.1-sol", status: "conditional" };

test("D10 门禁默认关：无台账也放行（advisory 语义零变化）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-gate-off-"));
  try {
    makeGitRepo(dir);
    const { dispatched, text } = await dispatchOnce({ dir, gateEnv: undefined, summaryWorkers: null });
    assert.ok(dispatched, "门关=dispatcher 被调用");
    assert.ok(!/certification-list gate/.test(text), "门关=不得出现门禁文案");
  } finally { cleanupDir(dir); }
});

test("D10 门禁开：certified/conditional 成员放行（含例外条款族 conditional）", async () => {
  for (const rec of [CERTIFIED_REC, CONDITIONAL_REC]) {
    const dir = mkdtempSync(join(tmpdir(), "wao-gate-member-"));
    try {
      makeGitRepo(dir);
      const { dispatched, text } = await dispatchOnce({ dir, gateEnv: "1", summaryWorkers: { fresh_lane: rec } });
      assert.ok(dispatched, `status=${rec.status} 成员必须放行`);
      assert.ok(!/certification-list gate/.test(text), `status=${rec.status} 成员不得吃门禁文案`);
    } finally { cleanupDir(dir); }
  }
});

test("D10 门禁开：不在清单=fail-closed 拒绝（零 dispatch，固定文案含纠正路径）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-gate-refuse-"));
  try {
    makeGitRepo(dir);
    const { dispatched, isError, text } = await dispatchOnce({ dir, gateEnv: "1", summaryWorkers: {} });
    assert.equal(dispatched, null, "拒绝=零 dispatch");
    assert.equal(isError, true);
    assert.match(text, /certification-list gate/);
    assert.match(text, /fresh_lane/);
    assert.match(text, /npm run reliability -- --agent/);
    assert.match(text, /cannot be changed from tool arguments/);
  } finally { cleanupDir(dir); }
});

test("D10 门禁开：台账缺失/键空间不对=fail-closed（不静默放行）", async () => {
  for (const scenario of ["missing", "keyspace"]) {
    const dir = mkdtempSync(join(tmpdir(), "wao-gate-closed-"));
    try {
      makeGitRepo(dir);
      // keyspace 场景：预写旧键空间表 + summaryWorkers=null 防 dispatchOnce 覆写。
      if (scenario === "keyspace") {
        const runDir = join(dir, "runs");
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
          ledgerKeySpace: "seat-v0",
          workers: { other_lane: CERTIFIED_REC },
        }), "utf8");
      }
      const workers = scenario === "missing" ? null : { fresh_lane: CERTIFIED_REC };
      const { dispatched, isError, text } = await dispatchOnce({ dir, gateEnv: "1", summaryWorkers: scenario === "keyspace" ? null : workers });
      assert.equal(dispatched, null, `${scenario}=零 dispatch`);
      assert.equal(isError, true);
      assert.match(text, /ledger state: (unreadable|keyspace)/);
    } finally { cleanupDir(dir); }
  }
});
