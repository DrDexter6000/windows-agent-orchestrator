// test/mcp-surface/mcpWaitNextStep.test.js
//
// 决定 0095（第 49 批）第 7.6 节：MCP 等待族 nextStep 的 wire 事实与
// 新上下限/缺省（一律从常量取数）。真实 MCP server + in-memory transport。
// 覆盖：
//   - run_wait：出参 nextStep（非终态/终态都给）≤480、不含 runId；
//     输入缺省/下限取自常量（MCP_RUN_WAIT_DEFAULT_MS / RUN_WAIT_MIN_MS）。
//   - run_await_result：缺省 45000（常量），无 nextStep。
//   - run_consult：缺省 45000（描述与 schema 一致）。
//   - run_delivery_review_bundle：缺省 45000（描述提取值 == handler 实际值）。
//   - run_delivery：带 waitMs 且到期未收口 → nextStep；不带 waitMs → 无。
//   - run_dispatch / run_continue：accepted:true → 静态 nextStep；拒绝不给。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { createWaoMcpServer } from "../../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  runWait as runWaitService,
  RUN_WAIT_MIN_MS,
  RUN_WAIT_MAX_MS,
  MCP_RUN_WAIT_DEFAULT_MS,
} from "../../src/application/runWait.js";
import { RUN_AWAIT_RESULT_DEFAULT_MS } from "../../src/application/runAwaitResult.js";

// ===== Helpers =====

function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

function makeRegistry(dir) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({
    agents: { coder_low: { backend: "claude-code", cwd: dir } },
  }), "utf8");
  return registryPath;
}

async function buildClient(server) {
  const [c1, s1] = InMemoryTransport.createLinkedPair();
  await server.connect(s1);
  const client = new Client({ name: "test", version: "0" }, { version: "0" });
  await client.connect(c1);
  return client;
}

function jl(obj) { return JSON.stringify(obj) + "\n"; }

function seedTranscript(runDir, runId, { terminal = false, workspaceCwd, lastEventTs } = {}) {
  mkdirSync(runDir, { recursive: true });
  const a = "coder_low";
  const lines = [
    jl({ type: "run.submitted", agentId: a, ts: "2026-08-03T00:00:00.000Z", runId }),
    jl({ type: "run.started", backend: "claude-code", ts: "2026-08-03T00:00:01.000Z", runId, agentId: a }),
    jl({ type: "run.background_submitted", background: true, cwd: workspaceCwd, runId, agentId: a }),
    jl({ type: "run.state_change", to: "pending", reason: "created", ts: "2026-08-03T00:00:02.000Z", runId, agentId: a }),
    jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-08-03T00:00:03.000Z", runId, agentId: a }),
    // 体征：最近一条 worker run.event 的时间可注入（决定 0095 的 nextStep 分支依据）。
    jl({
      type: "run.event", kind: "message", role: "assistant",
      parts: [{ type: "text", text: "working" }], ts: lastEventTs ?? "2026-08-03T00:01:00.000Z", runId, agentId: a,
    }),
  ];
  if (terminal) {
    lines.push(jl({ type: "run.completed", ts: "2026-08-03T00:10:00.000Z", runId, agentId: a }));
    lines.push(jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-08-03T00:10:01.000Z", runId, agentId: a }));
  }
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join(""), "utf8");
}

async function buildServerClient({ dir, registryPath, overrides = {} }) {
  const server = createWaoMcpServer({
    registryPath,
    runDir: join(dir, "runs"),
    workspaceRoot: dir,
    ...overrides,
  });
  const client = await buildClient(server);
  return { server, client };
}

// =====================================================================
// run_wait — nextStep on the wire + constants-locked bounds/defaults
// =====================================================================

test("NS-M1: run_wait input bounds/default from constants (30000..600000, default 45000)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ns-m1-"));
  try {
    makeGitRepo(dir);
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((x) => x.name === "run_wait");
      const w = t.inputSchema.properties.waitMs;
      assert.equal(w.minimum, RUN_WAIT_MIN_MS, "下限取自常量（决定 0095：30000）");
      assert.equal(w.maximum, RUN_WAIT_MAX_MS);
      assert.equal(w.default, MCP_RUN_WAIT_DEFAULT_MS, "MCP 缺省取自常量（45000）");
      assert.match(t.description, new RegExp(`default ${MCP_RUN_WAIT_DEFAULT_MS}`));
      // 出参 schema：可选 nextStep，≤480。
      const ns = t.outputSchema.properties.nextStep;
      assert.ok(ns, "output schema 声明 nextStep");
      assert.equal(ns.maxLength, 480);
    } finally {
      await client.close(); await server.close();
    }
  } finally { cleanupDir(dir); }
});

test("NS-M2: run_wait 非终态返回带 nextStep（按体征年龄渲染，不含 runId）；终态也带", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ns-m2-"));
  const runDir = join(dir, "runs");
  try {
    makeGitRepo(dir);
    // 非终态：最近体征 30+ 分钟前 → quiet 分支模板。
    seedTranscript(runDir, "run_ns_quiet", { lastEventTs: "2026-08-02T00:00:00.000Z", workspaceCwd: dir });
    seedTranscript(runDir, "run_ns_term", { terminal: true, workspaceCwd: dir });
    const { server, client } = await buildServerClient({
      dir, registryPath: makeRegistry(dir),
      overrides: {
        runWaitFn: (input) => runWaitService({
          ...input,
          sleepFn: () => Promise.resolve(),
          nowFn: (() => { let t = Date.now(); return () => (t += 200_000); })(),
        }),
      },
    });
    try {
      const res = await client.callTool({
        name: "run_wait",
        arguments: { runId: "run_ns_quiet", waitMs: RUN_WAIT_MIN_MS },
      });
      const parsed = res.structuredContent;
      assert.equal(parsed.terminal, false);
      assert.match(parsed.nextStep, /No new signs of life in the transcript for \d+ min/);
      assert.match(parsed.nextStep, /run_stop is only for an explicit Lead decision/);
      assert.ok(!parsed.nextStep.includes("run_ns_quiet"), "MCP 面 nextStep 不含 runId");
      assert.ok(parsed.nextStep.length <= 480);
      // waitWindowHint / transcriptQuiet 仍不进 wire（TD-149(b) 钉）。
      assert.equal("waitWindowHint" in parsed, false);
      assert.equal("transcriptQuiet" in parsed, false);

      const resT = await client.callTool({
        name: "run_wait",
        arguments: { runId: "run_ns_term", waitMs: RUN_WAIT_MIN_MS },
      });
      const parsedT = resT.structuredContent;
      assert.equal(parsedT.terminal, true);
      assert.match(parsedT.nextStep, /run_delivery with an explicit waitMs/);
      assert.ok(!parsedT.nextStep.includes("run_ns_term"));
    } finally {
      await client.close(); await server.close();
    }
  } finally { cleanupDir(dir); }
});

// =====================================================================
// run_await_result / run_consult / run_delivery_review_bundle — defaults
// =====================================================================

test("NS-M3: run_await_result default 45000 from constants; NO nextStep on the wire schema", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ns-m3-"));
  try {
    makeGitRepo(dir);
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((x) => x.name === "run_await_result");
      assert.equal(t.inputSchema.properties.waitMs.default, RUN_AWAIT_RESULT_DEFAULT_MS, "缺省 45000（常量）");
      assert.equal("nextStep" in (t.outputSchema.properties ?? {}), false, "run_await_result 不加 nextStep");
    } finally {
      await client.close(); await server.close();
    }
  } finally { cleanupDir(dir); }
});

test("NS-M4: run_consult default 45000（描述与 handler 注入一致）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ns-m4-"));
  try {
    makeGitRepo(dir);
    let observedBudget = null;
    const { server, client } = await buildServerClient({
      dir, registryPath: makeRegistry(dir),
      overrides: {
        runConsultFn: async (input) => {
          observedBudget = input.budgetMs;
          return {
            view: "receipt",
            consultId: "consult_20261029220000000abcdef",
            seats: [],
          };
        },
      },
    });
    try {
      const res = await client.callTool({
        name: "run_consult",
        arguments: { brief: "Q1: yes or no?", seats: ["coder_low"], expectedWorkspaceRoot: dir },
      });
      assert.equal(res.isError, undefined);
      assert.equal(observedBudget, 45000, "省略 waitMs → 45000（决定 0095）");
      const tools = await client.listTools();
      assert.match(tools.tools.find((x) => x.name === "run_consult").description, /default 45000/);
    } finally {
      await client.close(); await server.close();
    }
  } finally { cleanupDir(dir); }
});

test("NS-M5: run_delivery_review_bundle 默认 45000（描述提取值 == handler 实际等待值）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ns-m5-"));
  try {
    makeGitRepo(dir);
    let observedWaitMs = null;
    const waitingDelivery = (runId) => ({
      runId,
      readiness: "waiting_for_verification",
      waitReturnedEarly: false,
      terminalState: "completed",
      deliveryAvailable: true,
      deliveryRequested: true,
      deliveryRef: {
        runId, baseCommit: "b".repeat(40), deliveryCommit: "d".repeat(40),
        changedFiles: ["src/a.js"], verification: { status: "pending" },
      },
      deliveryFailure: null,
      verification: { status: "pending" },
      acceptance: { status: "pending" },
    });
    const { server, client } = await buildServerClient({
      dir, registryPath: makeRegistry(dir),
      overrides: {
        getRunDeliveryReadinessFn: async (input) => {
          observedWaitMs = input.waitMs;
          return waitingDelivery(input.runId);
        },
      },
    });
    try {
      const res = await client.callTool({
        name: "run_delivery_review_bundle",
        arguments: { runId: "run_ns_m5", fileIndex: 0 },
      });
      assert.equal(res.isError, undefined);
      assert.equal(observedWaitMs, 45000, "省略 waitMs → 45000（决定 0095）");
      // 描述里的 stated default 与实际一致（M12-3B-12 钉的提取口径）。
      const tools = await client.listTools();
      const stated = Number(/omit = default (\d+) ms wait/.exec(tools.tools.find((x) => x.name === "run_delivery_review_bundle").description)?.[1]);
      assert.equal(stated, 45000);
    } finally {
      await client.close(); await server.close();
    }
  } finally { cleanupDir(dir); }
});

// =====================================================================
// run_delivery — nextStep 只在带 waitMs 且未收口时给
// =====================================================================

test("NS-M6: run_delivery 带 waitMs 到期未收口 → nextStep；不带 waitMs 即时查询 → 无", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ns-m6-"));
  try {
    makeGitRepo(dir);
    const pendingReadiness = (runId) => ({
      runId,
      readiness: "waiting_for_verification",
      waitReturnedEarly: false,
      terminalState: "completed",
      deliveryAvailable: true,
      deliveryRequested: true,
      deliveryRef: {
        runId, baseCommit: "b".repeat(40), deliveryCommit: "d".repeat(40),
        changedFiles: ["src/a.js"], verification: { status: "pending" },
      },
      deliveryFailure: null,
      verification: { status: "pending" },
      acceptance: { status: "pending" },
    });
    const pointInTime = (runId) => ({
      runId,
      terminalState: "completed",
      deliveryAvailable: false,
      deliveryRequested: true,
      deliveryFailure: null,
    });
    const { server, client } = await buildServerClient({
      dir, registryPath: makeRegistry(dir),
      overrides: {
        getRunDeliveryReadinessFn: async (input) => pendingReadiness(input.runId),
        getRunDeliveryFn: async (input) => pointInTime(input.runId),
      },
    });
    try {
      const waited = await client.callTool({
        name: "run_delivery",
        arguments: { runId: "run_ns_m6", waitMs: 1000 },
      });
      assert.equal(waited.isError, undefined);
      assert.match(waited.structuredContent.nextStep, /Delivery is not settled yet/);
      assert.match(waited.structuredContent.nextStep, /Call run_delivery again with waitMs/);

      const immediate = await client.callTool({
        name: "run_delivery",
        arguments: { runId: "run_ns_m6" },
      });
      assert.equal(immediate.isError, undefined);
      assert.equal("nextStep" in immediate.structuredContent, false, "即时查询不给 nextStep");
    } finally {
      await client.close(); await server.close();
    }
    // 带 waitMs 但提前返回（收口或不可判定）→ 不给 nextStep。
    const { server: s2, client: c2 } = await buildServerClient({
      dir, registryPath: makeRegistry(dir),
      overrides: {
        getRunDeliveryReadinessFn: async (input) => ({ ...pendingReadiness(input.runId), readiness: "ambiguous", waitReturnedEarly: true }),
        getRunDeliveryFn: async (input) => pointInTime(input.runId),
      },
    });
    try {
      const early = await c2.callTool({ name: "run_delivery", arguments: { runId: "run_ns_m6", waitMs: 1000 } });
      assert.equal(early.isError, undefined);
      assert.equal("nextStep" in early.structuredContent, false, "waitReturnedEarly:true 不给 nextStep");
    } finally {
      await c2.close(); await s2.close();
    }
  } finally { cleanupDir(dir); }
});

// =====================================================================
// run_dispatch / run_continue — accepted:true 附静态 nextStep；拒绝不给
// =====================================================================

test("NS-M7: run_dispatch accepted:true → nextStep（静态模板，无 runId）；accepted:false 不给", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ns-m7-"));
  try {
    makeGitRepo(dir);
    const fakeDispatch = async () => ({
      accepted: true, runId: "run_ns_m7_ok", agentId: "coder_low", state: "pending",
      providerSessionRouting: "not_used",
    });
    const fakeDispatchRefused = async () => ({
      accepted: false, runId: "run_ns_m7_no", agentId: "coder_low", state: "failed",
      providerSessionRouting: "not_used",
    });
    const { server, client } = await buildServerClient({
      dir, registryPath: makeRegistry(dir), overrides: { dispatchRunFn: fakeDispatch },
    });
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "x", expectedWorkspaceRoot: dir },
      });
      assert.equal(res.isError, undefined);
      assert.match(res.structuredContent.nextStep, /keep a wait attached: call run_wait repeatedly/);
      assert.ok(!res.structuredContent.nextStep.includes("run_ns_m7_ok"), "静态模板不含 runId");
    } finally {
      await client.close(); await server.close();
    }
    const { server: s2, client: c2 } = await buildServerClient({
      dir, registryPath: makeRegistry(dir), overrides: { dispatchRunFn: fakeDispatchRefused },
    });
    try {
      const res = await c2.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "x", expectedWorkspaceRoot: dir },
      });
      assert.equal(res.isError, undefined);
      assert.equal("nextStep" in res.structuredContent, false, "accepted:false 不给 nextStep");
    } finally {
      await c2.close(); await s2.close();
    }
  } finally { cleanupDir(dir); }
});

test("NS-M8: run_continue accepted:true → nextStep；拒收不给", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ns-m8-"));
  try {
    makeGitRepo(dir);
    const fakeContinue = async (input) => ({
      accepted: true,
      parentRunId: input.parentRunId,
      runId: "run_ns_m8_child", agentId: "coder_low", rootRunId: input.parentRunId, state: "pending",
    });
    const { server, client } = await buildServerClient({
      dir, registryPath: makeRegistry(dir), overrides: { continueRunFn: fakeContinue },
    });
    try {
      const res = await client.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_ns_m8_parent", prompt: "fix it", delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] }, expectedWorkspaceRoot: dir },
      });
      assert.equal(res.isError, undefined, `continue must succeed: ${JSON.stringify(res.content?.[0]?.text ?? "")}`);
      assert.match(res.structuredContent.nextStep, /keep a wait attached/);
      assert.ok(!res.structuredContent.nextStep.includes("run_ns_m8_child"));
    } finally {
      await client.close(); await server.close();
    }
    const fakeRefused = async (input) => ({
      accepted: false, parentRunId: input.parentRunId, rejectionReason: "parent_not_terminal",
    });
    const { server: s2, client: c2 } = await buildServerClient({
      dir, registryPath: makeRegistry(dir), overrides: { continueRunFn: fakeRefused },
    });
    try {
      const res = await c2.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_ns_m8_parent", prompt: "fix it", delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] }, expectedWorkspaceRoot: dir },
      });
      assert.equal(res.isError, undefined, `refusal is a structured result: ${JSON.stringify(res.content?.[0]?.text ?? "")}`);
      assert.equal(res.structuredContent.accepted, false);
      assert.equal("nextStep" in res.structuredContent, false, "accepted:false 不给 nextStep");
    } finally {
      await c2.close(); await s2.close();
    }
  } finally { cleanupDir(dir); }
});
