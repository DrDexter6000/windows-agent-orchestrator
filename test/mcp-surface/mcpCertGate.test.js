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

async function dispatchOnce({ dir, gateEnv, summaryWorkers }) {
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
  // 0064 注入缝：门禁经 server-owned certGateOverride 注入——不碰进程级 env
  // （并行测试文件会互踩，实测误伤 model-override 用例）。
  const server = createWaoMcpServer({
    registryPath, runDir, workspaceRoot: dir,
    certGateOverride: gateEnv === "1",
    dispatchRunFn: async (args) => {
      dispatched = args;
      return { runId: "run_gate_probe", state: "submitted" };
    },
  });
  try {
    const client = await buildInMemoryClient(server);
    const res = await client.callTool({
      name: "run_dispatch",
      arguments: { agentId: "fresh_lane", prompt: "gate probe" },
    });
    const text = res.content?.find((b) => b.type === "text")?.text ?? "";
    return { dispatched, isError: Boolean(res.isError), text };
  } finally {
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
      const { dispatched, text: passText } = await dispatchOnce({ dir, gateEnv: "1", summaryWorkers: { fresh_lane: rec } });
      assert.ok(dispatched, `status=${rec.status} 成员必须放行`);
      assert.ok(!/certification-list gate/.test(passText), `status=${rec.status} 成员不得吃门禁文案`);
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
      assert.match(text, /certification-list gate/, `${scenario}=门禁文案在场（统一文案，无状态后缀）`);
    } finally { cleanupDir(dir); }
  }
});

// ── 0046 收口补丁回归钉（三席会审双洞，opus 席复现表后两行） ────────────────

test("D10 双洞①：门开 + per-dispatch model 覆盖 = 拒绝（P1-1 互斥继承，零 dispatch）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-gate-mo-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      fresh_lane: { backend: "codex", model: { id: "gpt-6.1-sol" }, reasoning: { effort: "high" }, cwd: dir },
    } }), "utf8");
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
      ledgerKeySpace: "lane-v1",
      workers: { fresh_lane: CERTIFIED_REC },
    }), "utf8");
    let dispatched = null;
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: dir,
      certGateOverride: true,
      dispatchRunFn: async (args) => { dispatched = args; return { runId: "r", state: "submitted" }; },
    });
    try {
      const client = await buildInMemoryClient(server);
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "fresh_lane", prompt: "x", model: "never-certified-model" },
      });
      const text = res.content?.find((b) => b.type === "text")?.text ?? "";
      assert.equal(dispatched, null, "model 覆盖×门开=零 dispatch");
      assert.equal(Boolean(res.isError), true);
      assert.match(text, /mutually exclusive with the gate/);
      assert.match(text, /P1-1 precedent/);
    } finally {
      await server.close();
    }
  } finally { cleanupDir(dir); }
});

test("D10 双洞②：门开 + run_consult 席位不在清单 = 整体拒绝点名缺席者（零扇出）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-gate-cc-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      listed_lane: { backend: "codex", model: { id: "gpt-6.1-sol" }, reasoning: { effort: "high" }, cwd: dir },
      unlisted_lane: { backend: "codex", model: { id: "gpt-6-astra" }, reasoning: { effort: "high" }, cwd: dir },
    } }), "utf8");
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
      ledgerKeySpace: "lane-v1",
      workers: { listed_lane: { agentId: "listed_lane", backend: "codex", modelId: "gpt-6.1-sol", status: "certified" } },
    }), "utf8");
    let consultDispatches = 0;
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: dir,
      certGateOverride: true,
      dispatchRunFn: async () => { consultDispatches += 1; return { runId: "r", state: "submitted" }; },
    });
    try {
      const client = await buildInMemoryClient(server);
      const res = await client.callTool({
        name: "run_consult",
        arguments: { brief: "gate consult probe", seats: ["listed_lane", "unlisted_lane"] },
      });
      const text = res.content?.find((b) => b.type === "text")?.text ?? "";
      assert.equal(consultDispatches, 0, "任一席位不在清单=整体零扇出");
      assert.equal(Boolean(res.isError), true);
      assert.match(text, /unlisted_lane/);
      assert.match(text, /Consult only fans out to list members/);
      assert.ok(!/listed_lane(?!,)/.test(text.split(":")[2] ?? "") || text.includes("unlisted_lane"), "点名缺席者");
    } finally {
      await server.close();
    }
  } finally { cleanupDir(dir); }
});

// ── B1/B4 回归钉（Owner 2026-10-06 批） ─────────────────────────────────────

test("B1：门开 + per-dispatch reasoning 覆盖 = 拒绝（effort 轴在指纹内，同洞 P1-1）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-gate-b1-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      fresh_lane: { backend: "codex", model: { id: "gpt-6.1-sol" }, reasoning: { effort: "high" }, cwd: dir },
    } }), "utf8");
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
      ledgerKeySpace: "lane-v1", workers: { fresh_lane: CERTIFIED_REC },
    }), "utf8");
    let dispatched = null;
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: dir, certGateOverride: true,
      dispatchRunFn: async (args) => { dispatched = args; return { runId: "r", state: "submitted" }; },
    });
    try {
      const client = await buildInMemoryClient(server);
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "fresh_lane", prompt: "x", reasoning: "max" },
      });
      const text = res.content?.find((b) => b.type === "text")?.text ?? "";
      assert.equal(dispatched, null, "reasoning 覆盖×门开=零 dispatch");
      assert.equal(Boolean(res.isError), true);
      assert.match(text, /reasoning override is mutually exclusive with the gate/);
      assert.match(text, /deliberately excludes effort/);
      assert.match(text, /delta re-evidence per 0046/);
    } finally { await server.close(); }
  } finally { cleanupDir(dir); }
});

test("B1 负钉：门关 + reasoning 覆盖 = 正常透传（advisory 语义不变）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-gate-b1n-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      fresh_lane: { backend: "codex", model: { id: "gpt-6.1-sol" }, reasoning: { effort: "high" }, cwd: dir },
    } }), "utf8");
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    let dispatched = null;
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: dir, certGateOverride: false,
      dispatchRunFn: async (args) => { dispatched = args; return { runId: "r", state: "submitted" }; },
    });
    try {
      const client = await buildInMemoryClient(server);
      await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "fresh_lane", prompt: "x", reasoning: "max" },
      });
      assert.ok(dispatched, "门关=reasoning 覆盖正常透传");
    } finally { await server.close(); }
  } finally { cleanupDir(dir); }
});

// ── opus 补席审计盲区钉：持久 effort 漂移不设防（实验实证后修复） ────────────

test("opus 盲区钉：门开 + 车道 effort 与记录 executionProfile.effort 漂移 = 拒绝", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-gate-drift-"));
  try {
    makeGitRepo(dir);
    // 注册表车道 effort=high（已从取证时的值漂移）；台账记录 executionProfile.effort=max。
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      fresh_lane: { backend: "codex", model: { id: "gpt-6.1-sol" }, reasoning: { effort: "high" }, cwd: dir },
    } }), "utf8");
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
      ledgerKeySpace: "lane-v1",
      workers: { fresh_lane: { ...CERTIFIED_REC, executionProfile: { modelId: "gpt-6.1-sol", providerID: null, providerKey: null, effort: "max", runtime: {}, codeRef: "x", capturedAt: "2026-10-06T00:00:00Z", drillRunIds: {} } } },
    }), "utf8");
    let dispatched = null;
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: dir, certGateOverride: true,
      dispatchRunFn: async (args) => { dispatched = args; return { runId: "r", state: "submitted" }; },
    });
    try {
      const client = await buildInMemoryClient(server);
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "fresh_lane", prompt: "x" },
      });
      assert.equal(dispatched, null, "effort 漂移=零 dispatch（一次性覆盖已拒，配置漂移不得旁路）");
      assert.equal(Boolean(res.isError), true);
    } finally { await server.close(); }
  } finally { cleanupDir(dir); }
});

test("opus 盲区钉负例：effort 一致（含 null≡null 通道不可表达）= 照常放行", async () => {
  for (const [laneEffortField, profileEffort] of [[{ effort: "high" }, "high"], [{}, null]]) {
    const dir = mkdtempSync(join(tmpdir(), "wao-gate-driftn-"));
    try {
      makeGitRepo(dir);
      const registryPath = join(dir, "agents.json");
      writeFileSync(registryPath, JSON.stringify({ agents: {
        fresh_lane: { backend: "codex", model: { id: "gpt-6.1-sol" }, ...(Object.keys(laneEffortField).length ? { reasoning: laneEffortField } : {}), cwd: dir },
      } }), "utf8");
      const runDir = join(dir, "runs");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
        ledgerKeySpace: "lane-v1",
        workers: { fresh_lane: { ...CERTIFIED_REC, executionProfile: { modelId: "gpt-6.1-sol", providerID: null, providerKey: null, effort: profileEffort, runtime: {}, codeRef: "x", capturedAt: "2026-10-06T00:00:00Z", drillRunIds: {} } } },
      }), "utf8");
      let dispatched = null;
      const server = createWaoMcpServer({
        registryPath, runDir, workspaceRoot: dir, certGateOverride: true,
        dispatchRunFn: async (args) => { dispatched = args; return { runId: "r", state: "submitted" }; },
      });
      try {
        const client = await buildInMemoryClient(server);
        await client.callTool({ name: "run_dispatch", arguments: { agentId: "fresh_lane", prompt: "x" } });
        assert.ok(dispatched, `effort 一致（profile=${profileEffort}）必须放行`);
      } finally { await server.close(); }
    } finally { cleanupDir(dir); }
  }
});

// ── B4 回归钉（opus 补席：实现无钉） ────────────────────────────────────────

test("B4 钉：门开 + run_continue 父车道不在清单 = 拒绝（零 fork）；父不可解析 = 透传下游", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-gate-b4-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      fresh_lane: { backend: "codex", model: { id: "gpt-6.1-sol" }, reasoning: { effort: "high" }, cwd: dir },
    } }), "utf8");
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
      ledgerKeySpace: "lane-v1", workers: {},
    }), "utf8");
    // 父转录：最小 run.started（agentId=fresh_lane）。
    writeFileSync(join(runDir, "run_parent_probe.jsonl"),
      JSON.stringify({ type: "run.started", agentId: "fresh_lane", runId: "run_parent_probe", ts: "2026-10-06T00:00:00Z" }) + "\n", "utf8");
    let continued = 0;
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: dir, certGateOverride: true,
      continueRunFn: async () => { continued += 1; return { runId: "run_child", state: "submitted" }; },
    });
    try {
      const client = await buildInMemoryClient(server);
      const res = await client.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_parent_probe", prompt: "x", delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationUnavailableReason: "probe" } },
      });
      const text = res.content?.find((b) => b.type === "text")?.text ?? "";
      assert.equal(continued, 0, "父车道不在清单=零 fork");
      assert.equal(Boolean(res.isError), true);
      assert.match(text, /parent lane fresh_lane has no certified\/conditional record/);
      // 父不可解析（无转录）：门不猜——透传给 continueService（注入桩计数）。
      const res2 = await client.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_ghost_missing", prompt: "x", delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationUnavailableReason: "probe" } },
      });
      assert.equal(continued, 1, "父不可解析=门上透传（下游 continueService 自身父校验接管）");
    } finally { await server.close(); }
  } finally { cleanupDir(dir); }
});