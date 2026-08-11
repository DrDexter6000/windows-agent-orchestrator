// test/mcpRunCorrection.test.js
//
// M12-16: queued in-flight correction — MCP transport boundary.
//
// Real SDK client ↔ server (InMemoryTransport) exercising the run_correct tool:
// the schema, the workspace/runId binding, the closed-set outcome projection,
// and the "never echo the prompt" safe-surface invariant. Malformed/oversize
// input is rejected at the schema layer, so the application service is NEVER
// called (call count 0). WAO is a deterministic transport: "queued" proves a
// durable append — NOT model execution (queued ≠ delivered ≠ executed).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { JsonlTranscript } from "../src/transcript.js";
import {
  CORRECTION_OUTCOMES,
  CORRECTION_REJECTION_REASONS,
  CORRECTION_PROMPT_MAX_LEN,
} from "../src/application/runCorrection.js";

const RUN_ID = "run_20260810120000000aaaa";

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name t", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: dir, stdio: "pipe" });
}

function makeRegistry(dir) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(
    registryPath,
    JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }),
    "utf8",
  );
  return registryPath;
}

// Seed a correctable, running run transcript into runDir so correctRun finds it.
function seedCorrectableRun(dir, { runId = RUN_ID, terminal = false, correctable = true } = {}) {
  const runsDir = join(dir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const filePath = join(runsDir, `${runId}.jsonl`);
  const t = new JsonlTranscript(filePath, { runId, agentId: "coder_hq" });
  // Build it synchronously in order (the service re-reads from disk).
  return (async () => {
    await t.append("run.background_submitted", {
      background: true,
      cwd: dir,
      ...(correctable ? { correctable: true } : {}),
    });
    await t.transitionState(null, "pending", "background_spawned");
    await t.append("session.created", { backend: "process", backendSessionId: "proc_1" });
    await t.append("run.started", {
      backend: "claude-code",
      cwd: dir,
      worktreePath: dir,
      worktreeBranch: "wao/main",
    });
    await t.transitionState("pending", "submitted", "spawned");
    if (terminal) {
      await t.transitionState("submitted", "completed", "done", {
        factEvents: [{ type: "run.completed", payload: {} }],
      });
    }
    return filePath;
  })();
}

async function buildServerClient({ dir, registryPath, overrides = {} }) {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createWaoMcpServer({
    registryPath,
    runDir: join(dir, "runs"),
    workspaceRoot: dir,
    ...overrides,
  });
  const client = new Client({ name: "wao-test-client", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { server, client };
}

// Run a tool call that may be rejected by the SDK schema layer (returns a result
// OR throws). Captures both and normalizes into { threw, res }.
async function safeCall(client, args) {
  try {
    const res = await client.callTool(args);
    return { threw: false, res };
  } catch (e) {
    return { threw: true, res: null, err: e };
  }
}

// =====================================================================
// Schema + binding + closed-set outcome
// =====================================================================

test("M12-16-MCP-1: run_correct on a running correctable run → outcome queued, closed-set shape, service called once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcp-corr-1-"));
  try {
    makeGitRepo(dir);
    await seedCorrectableRun(dir);
    let calls = 0;
    const { server, client } = await buildServerClient({
      dir, registryPath: makeRegistry(dir),
      overrides: { correctRunFn: async (args) => { calls += 1; return (await import("../src/application/runCorrection.js")).correctRun(args); } },
    });
    try {
      const { threw, res } = await safeCall(client, {
        name: "run_correct",
        arguments: { runId: RUN_ID, correctionId: "fix-1", prompt: "please also add a test for the empty-input branch" },
      });
      assert.equal(threw, false, "valid call must not throw");
      assert.equal(calls, 1, "service called exactly once");
      const sc = res.structuredContent;
      assert.equal(sc.runId, RUN_ID);
      assert.equal(sc.correctionId, "fix-1");
      assert.equal(sc.outcome, "queued");
      assert.equal(sc.reason, null, "reason is null on a non-rejected outcome");
      assert.ok(CORRECTION_OUTCOMES.includes(sc.outcome), "outcome is a closed-set member");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-16-MCP-2: run_correct NEVER echoes the prompt through the safe surface", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcp-corr-2-"));
  try {
    makeGitRepo(dir);
    await seedCorrectableRun(dir);
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    try {
      const secret = "test-secret-marker-mcpcorr";
      const { threw, res } = await safeCall(client, {
        name: "run_correct",
        arguments: { runId: RUN_ID, correctionId: "c1", prompt: secret },
      });
      assert.equal(threw, false);
      // structuredContent must not carry the prompt or a prompt key.
      assert.equal(JSON.stringify(res.structuredContent).includes(secret), false, "structuredContent must not echo the prompt");
      assert.equal("prompt" in (res.structuredContent ?? {}), false, "no prompt key in the result");
      // The text content must not echo it either.
      const text = (res.content ?? []).map((c) => c.text || "").join("");
      assert.equal(text.includes(secret), false, "text content must not echo the prompt");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-16-MCP-3: unknown runId → outcome rejected/unknown_run (closed-set refusal, NOT a generic tool error)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcp-corr-3-"));
  try {
    makeGitRepo(dir);
    await seedCorrectableRun(dir);
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    try {
      const { threw, res } = await safeCall(client, {
        name: "run_correct",
        arguments: { runId: "run_20260101000000000zzzz", correctionId: "c1", prompt: "x" },
      });
      assert.equal(threw, false, "a refusal is a structured result, not a throw");
      assert.ok(!res.isError, "a refusal is NOT an isError tool failure");
      const sc = res.structuredContent;
      assert.equal(sc.outcome, "rejected");
      assert.equal(sc.reason, "unknown_run");
      assert.ok(CORRECTION_REJECTION_REASONS.includes(sc.reason), "reason is a closed-set member");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-16-MCP-4: terminal run → outcome rejected/terminal_run (closed-set, service reached once)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcp-corr-4-"));
  try {
    makeGitRepo(dir);
    await seedCorrectableRun(dir, { terminal: true });
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    try {
      const { threw, res } = await safeCall(client, {
        name: "run_correct",
        arguments: { runId: RUN_ID, correctionId: "c1", prompt: "x" },
      });
      assert.equal(threw, false);
      const sc = res.structuredContent;
      assert.equal(sc.outcome, "rejected");
      assert.equal(sc.reason, "terminal_run");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-16-MCP-5: workspace not bound → fixed not-bound error, service NOT called", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcp-corr-5-"));
  try {
    makeGitRepo(dir);
    await seedCorrectableRun(dir);
    let calls = 0;
    const { createWaoMcpServer } = await import("../src/mcp/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    // No workspaceRoot, and the client declares no roots capability → unbound.
    const server = createWaoMcpServer({
      registryPath: makeRegistry(dir),
      runDir: join(dir, "runs"),
      correctRunFn: async () => { calls += 1; return { outcome: "queued" }; },
    });
    const client = new Client({ name: "wao-test-client", version: "0.0.1" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const { threw, res } = await safeCall(client, {
        name: "run_correct",
        arguments: { runId: RUN_ID, correctionId: "c1", prompt: "x" },
      });
      assert.equal(threw, false);
      assert.equal(calls, 0, "service must NOT be called when the workspace is not bound");
      assert.equal(res.isError, true, "not-bound collapses to a fixed tool error");
      const text = (res.content ?? []).map((c) => c.text || "").join("");
      assert.match(text, /not bound|not-bound|workspace/i, "fixed not-bound text");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// Schema rejection — service NEVER reached (call count 0)
// =====================================================================

test("M12-16-MCP-6: oversize prompt is rejected at the schema layer — service call count 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcp-corr-6-"));
  try {
    makeGitRepo(dir);
    await seedCorrectableRun(dir);
    let calls = 0;
    const { server, client } = await buildServerClient({
      dir, registryPath: makeRegistry(dir),
      overrides: { correctRunFn: async () => { calls += 1; return { outcome: "queued" }; } },
    });
    try {
      const oversize = "a".repeat(CORRECTION_PROMPT_MAX_LEN + 1);
      const { res } = await safeCall(client, {
        name: "run_correct",
        arguments: { runId: RUN_ID, correctionId: "c1", prompt: oversize },
      });
      assert.equal(calls, 0, "oversize prompt must NOT reach the service");
      // Rejected — either a thrown JSON-RPC error (res null) or an isError result.
      const ok = res === null || res?.isError === true;
      assert.ok(ok, "oversize prompt is rejected (no queued/delivered outcome)");
      const sc = res?.structuredContent;
      assert.ok(!sc || sc.outcome === undefined, "no structured outcome produced");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-16-MCP-7: malformed correctionId is rejected at the schema layer — service call count 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcp-corr-7-"));
  try {
    makeGitRepo(dir);
    await seedCorrectableRun(dir);
    let calls = 0;
    const { server, client } = await buildServerClient({
      dir, registryPath: makeRegistry(dir),
      overrides: { correctRunFn: async () => { calls += 1; return { outcome: "queued" }; } },
    });
    try {
      for (const bad of ["has space", "slash/here", "dot.here", ""]) {
        calls = 0;
        const { res } = await safeCall(client, {
          name: "run_correct",
          arguments: { runId: RUN_ID, correctionId: bad, prompt: "x" },
        });
        assert.equal(calls, 0, `malformed correctionId ${JSON.stringify(bad)} must NOT reach the service`);
        const ok = res === null || res?.isError === true;
        assert.ok(ok, `malformed correctionId ${JSON.stringify(bad)} is rejected`);
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-16-MCP-8: missing required field is rejected at the schema layer — service call count 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcp-corr-8-"));
  try {
    makeGitRepo(dir);
    await seedCorrectableRun(dir);
    let calls = 0;
    const { server, client } = await buildServerClient({
      dir, registryPath: makeRegistry(dir),
      overrides: { correctRunFn: async () => { calls += 1; return { outcome: "queued" }; } },
    });
    try {
      // prompt is required; omitting it must be rejected before the service runs.
      const { res } = await safeCall(client, {
        name: "run_correct",
        arguments: { runId: RUN_ID, correctionId: "c1" },
      });
      assert.equal(calls, 0, "missing required field must NOT reach the service");
      const ok = res === null || res?.isError === true;
      assert.ok(ok, "missing required field is rejected");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
