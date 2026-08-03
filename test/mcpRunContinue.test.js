// test/mcpRunContinue.test.js
//
// M12-7: run_continue MCP adapter — safe projection of the Lead-authorized
// correction continuation service over the MCP protocol.
//
// Coverage:
//   - tool discovery (current tool count, run_continue present) + annotations +
//     strict input (parentRunId/prompt/delivery required; extra keys rejected)
//   - workspace-bound authorization (no binding → service never called)
//   - service threading: authorizedWorkspaceRoot = bound root, server-owned
//     leadSession, requireCertified:true, backendFor capability resolver
//   - structured success output (dispatch identity + parentRunId + continuation +
//     rootRunId) and refusal output (closed-set rejectionReason)
//   - redaction: the opaque provider uuid, Lead session id, workspace path, and
//     any active lineage runId NEVER appear in MCP output (busy is a label only)
//   - fixed safe error on credential-missing vs generic service throw

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { execSync } from "node:child_process";

import { createWaoMcpServer } from "../src/mcp/server.js";
import { CredentialMissingError } from "../src/application/runDispatch.js";

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-m127-rc", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function makeGitDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "t@t"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "t"', { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.js"), "1\n");
  execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

const DELIVERY = { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] };
const SENTINEL_LEAD = "lead-session-sentinel-uuid";
const SENTINEL_OPAQUE = "11111111-2222-4333-8444-555555555555";
const SENTINEL_ACTIVE = "run_inflight_sentinel";

/** Build a server whose injected continuation service records every call + args. */
function makeServer({ dir, serviceResult, serviceThrow, workspaceRoot = dir, leadSession = SENTINEL_LEAD, globalWaitTimeout }) {
  const calls = [];
  const fake = async (args) => {
    calls.push(args);
    if (serviceThrow) {
      if (typeof serviceThrow === "function") throw serviceThrow();
      throw new Error(serviceThrow);
    }
    return typeof serviceResult === "function" ? serviceResult(args) : serviceResult;
  };
  const server = createWaoMcpServer({
    registryPath: join(dir, "agents.json"),
    runDir: dir,
    workspaceRoot,
    leadSession,
    ...(globalWaitTimeout !== undefined ? { globalWaitTimeout } : {}),
    continueRunFn: fake,
  });
  return { server, calls };
}

function successResult(args) {
  return {
    accepted: true,
    runId: "run_child_ok",
    agentId: "coder_hq",
    parentRunId: args.parentRunId,
    continuation: true,
    rootRunId: args.parentRunId,
    state: "pending",
    transcriptPath: join(args.runDir, "run_child_ok.jsonl"),
    // Adapter must strip these — never surfaced via MCP.
    opaqueUuid: SENTINEL_OPAQUE,
    leadSession: SENTINEL_LEAD,
  };
}

// =====================================================================
// Group 1: tool discovery + count + annotations + strict input
// =====================================================================

test("M12-7-MRC-M1: run_continue registered; total tools = 21; destructive + workspace-bound", async () => {
  const dir = makeGitDir("m127-mrc-m1-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server } = makeServer({ dir, serviceResult: successResult });
    const client = await buildInMemoryClient(server);
    try {
      const { tools } = await client.listTools();
      const t = tools.find((x) => x.name === "run_continue");
      assert.ok(t, "run_continue present");
      assert.equal(tools.length, 21, "exactly 21 tools (M12-10 moved playbook catalog to resources)");
      // Resumes a provider conversation + mutates the retained worktree: destructive.
      assert.equal(t.annotations.destructiveHint, true);
      assert.equal(t.annotations.readOnlyHint, false);
      assert.equal(t.annotations.idempotentHint, false);
      assert.equal(t.annotations.openWorldHint, true);
      // Strict input: parentRunId + prompt + required delivery.
      assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ["delivery", "parentRunId", "prompt"]);
      assert.equal(t.inputSchema.additionalProperties, false);
      assert.ok(t.outputSchema, "output schema present");
    } finally { await client.close(); await server.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test("M12-7-MRC-M2: extra key / missing fields rejected before service", async () => {
  const dir = makeGitDir("m127-mrc-m2-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server, calls } = makeServer({ dir, serviceResult: successResult });
    const client = await buildInMemoryClient(server);
    try {
      const cases = [
        { args: { parentRunId: "run_p", prompt: "fix", delivery: DELIVERY, unexpected: 1 }, label: "extra key" },
        { args: { parentRunId: "run_p", delivery: DELIVERY }, label: "missing prompt" },
        { args: { prompt: "fix", delivery: DELIVERY }, label: "missing parentRunId" },
        { args: { parentRunId: "run_p", prompt: "fix" }, label: "missing delivery" },
        { args: { parentRunId: "run_p", prompt: "fix", delivery: { mode: "git_commit_v1", allowedPaths: ["src"] } }, label: "delivery without verification" },
        { args: { parentRunId: "run_p", prompt: "fix", delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: [], verificationUnavailableReason: "x" } }, label: "both verification fields" },
      ];
      for (const { args, label } of cases) {
        const r = await client.callTool({ name: "run_continue", arguments: args }).catch(() => ({ isError: true }));
        assert.equal(r.isError, true, `${label} → error`);
      }
      assert.equal(calls.length, 0, "service never called for malformed input");
    } finally { await client.close(); await server.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

// =====================================================================
// Group 2: workspace-bound authorization
// =====================================================================

test("M12-7-MRC-M3: unbound workspace → service never called, fixed error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m127-mrc-m3-"));
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    // No workspaceRoot, no roots capability → unbound.
    const { server, calls } = makeServer({ dir, serviceResult: successResult, workspaceRoot: undefined });
    const client = await buildInMemoryClient(server);
    try {
      const r = await client.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_p", prompt: "fix", delivery: DELIVERY },
      }).catch(() => ({ isError: true }));
      assert.equal(r.isError, true, "unbound → error");
      assert.equal(calls.length, 0, "service never called when workspace unbound");
    } finally { await client.close(); await server.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

// =====================================================================
// Group 3: service threading + structured success output + redaction
// =====================================================================

test("M12-7-MRC-M4: service threaded with bound workspace + leadSession + requireCertified; structured success output; no leaks", async () => {
  const dir = makeGitDir("m127-mrc-m4-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server, calls } = makeServer({ dir, serviceResult: successResult, globalWaitTimeout: 60000 });
    const client = await buildInMemoryClient(server);
    try {
      const r = await client.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_parent_ok", prompt: "correct the bug", delivery: DELIVERY },
      });
      assert.equal(r.isError, undefined, "success is not an error");
      assert.equal(calls.length, 1, "service called exactly once");
      const call = calls[0];
      // Server-owned authority threaded verbatim; never model-supplied. The
      // bound root is the git-canonical toplevel (forward-slash on Windows).
      const toFwd = (p) => p.split(sep).join("/");
      assert.equal(call.parentRunId, "run_parent_ok");
      assert.equal(call.prompt, "correct the bug");
      assert.equal(toFwd(call.authorizedWorkspaceRoot), toFwd(dir), "bound workspace root threaded");
      assert.equal(call.leadSession, SENTINEL_LEAD, "server-owned Lead session threaded");
      assert.equal(call.requireCertified, true, "MCP always requires certification");
      assert.equal(call.runDir, dir);
      assert.equal(call.globalWaitTimeout, 60000, "global wait timeout threaded");
      assert.equal(typeof call.backendFor, "function", "backend capability resolver threaded");

      const parsed = r.structuredContent;
      assert.deepEqual(Object.keys(parsed).sort(),
        ["accepted", "agentId", "continuation", "parentRunId", "rejectionReason", "rootRunId", "runId", "state"],
        "strict output keys only");
      assert.equal(parsed.accepted, true);
      assert.equal(parsed.runId, "run_child_ok");
      assert.equal(parsed.agentId, "coder_hq");
      assert.equal(parsed.parentRunId, "run_parent_ok");
      assert.equal(parsed.continuation, true);
      assert.equal(parsed.rootRunId, "run_parent_ok");
      assert.equal(parsed.state, "pending");
      assert.equal(parsed.rejectionReason, null);

      // Redaction: the opaque provider uuid, Lead session id, workspace path,
      // transcript path, and any active runId NEVER appear in MCP output.
      const dumped = JSON.stringify(r);
      assert.ok(!dumped.includes(SENTINEL_OPAQUE), "opaque uuid never in MCP output");
      assert.ok(!dumped.includes(SENTINEL_LEAD), "Lead session id never in MCP output");
      assert.ok(!dumped.includes(dir), "workspace path never in MCP output");
      assert.ok(!dumped.includes("transcriptPath"), "transcript path never in MCP output");
    } finally { await client.close(); await server.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

// =====================================================================
// Group 4: structured refusal + busy redaction
// =====================================================================

test("M12-7-MRC-M5: refusal → structured accepted:false + closed-set rejectionReason; success fields null", async () => {
  const dir = makeGitDir("m127-mrc-m5-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server } = makeServer({
      dir,
      serviceResult: (args) => ({ accepted: false, parentRunId: args.parentRunId, continuation: true, rejectionReason: "not_continuable" }),
    });
    const client = await buildInMemoryClient(server);
    try {
      const r = await client.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_parent_legacy", prompt: "fix", delivery: DELIVERY },
      });
      assert.equal(r.isError, undefined, "a closed-set refusal is a normal outcome, not an error");
      const parsed = r.structuredContent;
      assert.equal(parsed.accepted, false);
      assert.equal(parsed.parentRunId, "run_parent_legacy");
      assert.equal(parsed.continuation, true);
      assert.equal(parsed.rejectionReason, "not_continuable");
      assert.equal(parsed.runId, null);
      assert.equal(parsed.agentId, null);
      assert.equal(parsed.rootRunId, null);
      assert.equal(parsed.state, null);
    } finally { await client.close(); await server.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test("M12-7-MRC-M6: busy refusal redacts the active lineage runId (label only)", async () => {
  const dir = makeGitDir("m127-mrc-m6-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server } = makeServer({
      dir,
      serviceResult: (args) => ({
        accepted: false, parentRunId: args.parentRunId, continuation: true,
        rejectionReason: "busy", activeRunId: SENTINEL_ACTIVE,
      }),
    });
    const client = await buildInMemoryClient(server);
    try {
      const r = await client.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_parent_busy", prompt: "fix", delivery: DELIVERY },
      });
      const parsed = r.structuredContent;
      assert.equal(parsed.accepted, false);
      assert.equal(parsed.rejectionReason, "busy");
      // The active runId is internal routing state — never surfaced (matches the
      // run_dispatch reuse-busy redaction contract).
      const dumped = JSON.stringify(r);
      assert.ok(!dumped.includes(SENTINEL_ACTIVE), "active lineage runId never in MCP output");
      assert.ok(!dumped.includes("activeRunId"), "no activeRunId field in MCP output");
    } finally { await client.close(); await server.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

// =====================================================================
// Group 5: environmental failures collapse to fixed safe text
// =====================================================================

test("M12-7-MRC-M7: credential-missing → fixed actionable text; generic throw → fixed safe text", async () => {
  const dir = makeGitDir("m127-mrc-m7-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    // Credential missing: actionable text, names only (no values), no structuredContent.
    const { server: s1 } = makeServer({ dir, serviceThrow: () => new CredentialMissingError(["WAO_FOO_KEY"]) });
    const c1 = await buildInMemoryClient(s1);
    try {
      const r = await c1.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_p", prompt: "fix", delivery: DELIVERY },
      });
      assert.equal(r.isError, true);
      const txt = r.content?.[0]?.text ?? "";
      assert.ok(/missing a required credential/.test(txt), "credential-missing actionable text");
      assert.equal(r.structuredContent, undefined, "no structured content on error");
    } finally { await c1.close(); await s1.close(); }

    // Generic throw: fixed safe text, no leak of err.message.
    const { server: s2 } = makeServer({ dir, serviceThrow: "boom-secret-detail-42" });
    const c2 = await buildInMemoryClient(s2);
    try {
      const r = await c2.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_p", prompt: "fix", delivery: DELIVERY },
      });
      assert.equal(r.isError, true);
      const txt = r.content?.[0]?.text ?? "";
      assert.equal(txt, "run_continue failed", "fixed safe text");
      assert.ok(!txt.includes("boom-secret-detail-42"), "no dynamic error leak");
    } finally { await c2.close(); await s2.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});
