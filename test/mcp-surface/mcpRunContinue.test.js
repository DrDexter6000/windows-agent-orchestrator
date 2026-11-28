// test/mcpRunContinue.test.js
//
// M12-7: run_continue MCP adapter — safe projection of the Lead-authorized
// correction continuation service over the MCP protocol.
//
// Coverage:
//   - tool discovery (current tool count, run_continue present) + annotations +
//     strict input (parentRunId/prompt required; delivery optional-inherits,
//     expectedWorkspaceRoot schema-required — 决定 0130; extra keys rejected)
//   - workspace-bound authorization (no binding → service never called)
//   - service threading: authorizedWorkspaceRoot = bound root, advisory
//     requireCertified:false (certification is recorded reliability evidence,
//     never a permission gate), backendFor capability resolver; the server-owned
//     Lead session is NOT part of lineage continuation (decision 0114)
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

import { createWaoMcpServer } from "../../src/mcp/server.js";
import { TOOLS } from "../../src/mcp/toolSurface.js";
import { CredentialMissingError } from "../../src/application/runDispatch.js";
import { deriveOwnerTitle } from "../../src/application/ownerReadModel.js";
import { createSecretRedactor } from "../../src/secretRedaction.js";

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
// b158a 修复二：认证门按车道表生效四轴裁决（不再按私有原文）
// =====================================================================

function laneCoderDoc() {
  return {
    ok: true, path: "<fixture>", sha256: "a".repeat(64), issues: [], rolesHint: [],
    lanes: [{ id: "coder_hq", backend: "codex", model: { id: "gpt-6.1-sol" }, reasoning: { effort: "high" }, aliases: {} }],
  };
}

test("b158a 修复二 run_continue 认证门：去四轴放行；保留旧 effort 时按车道表 effort 裁决", async () => {
  for (const scenario of ["stripped", "old-effort"]) {
    const dir = makeGitDir(`m127-fix2-gate-${scenario}-`);
    try {
      const registryPath = join(dir, "agents.json");
      const privateAgent = scenario === "stripped"
        ? { cwd: dir }
        : { cwd: dir, backend: "codex", model: { id: "gpt-6.1-sol" }, reasoning: { effort: "low" } };
      writeFileSync(registryPath, JSON.stringify({ agents: { coder_hq: privateAgent } }), "utf8");
      const runDir = join(dir, "runs");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
        ledgerKeySpace: "lane-v1",
        workers: {
          coder_hq: {
            backend: "codex", modelId: "gpt-6.1-sol", status: "certified",
            executionProfile: { effort: "high" },
          },
        },
      }), "utf8");
      const lanesDoc = laneCoderDoc();
      let lanesLoads = 0;
      const calls = [];
      const server = createWaoMcpServer({
        registryPath, runDir, workspaceRoot: dir,
        certGateOverride: true,
        // 让临时注册表成为本次安装的"默认注册表"→ 合并启用。
        pairedDefaultRegistryPathFn: () => registryPath,
        loadLanesConfigFn: () => { lanesLoads += 1; return lanesDoc; },
        getRunStatusFn: async () => ({ agentId: "coder_hq" }),
        continueRunFn: async (input) => { calls.push(input); return successResult(input); },
      });
      const client = await buildInMemoryClient(server);
      try {
        const res = await client.callTool({
          name: "run_continue",
          arguments: { parentRunId: "run_parent_gate", prompt: "fix", expectedWorkspaceRoot: dir },
        });
        const text = (res.content ?? []).map((c) => c.text || "").join(" ");
        assert.notEqual(res.isError, true, `${scenario}: 门按生效条目放行（实际：${text}）`);
        assert.equal(calls.length, 1, `${scenario}: 服务被调用`);
        assert.equal(calls[0].lanesMergeDoc, lanesDoc, `${scenario}: 门与服务的表是同一个对象`);
        assert.equal(lanesLoads, 1, `${scenario}: 一次请求恰读一次车道表`);
      } finally { await client.close(); await server.close(); }
    } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
});

test("b158a 修复二 run_continue：车道表不可用 → 门前固定 lanes_merge_unavailable 文案（零服务调用）", async () => {
  const dir = makeGitDir("m127-fix2-gate-bad-");
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { coder_hq: { cwd: dir } } }), "utf8");
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    let serviceCalls = 0;
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: dir,
      certGateOverride: true,
      pairedDefaultRegistryPathFn: () => registryPath,
      loadLanesConfigFn: () => ({ ok: false, path: "<fixture>", sha256: null, lanes: [], issues: ["fixture bad"] }),
      getRunStatusFn: async () => ({ agentId: "coder_hq" }),
      continueRunFn: async () => { serviceCalls += 1; throw new Error("must not be called"); },
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_parent_bad", prompt: "fix", expectedWorkspaceRoot: dir },
      });
      const text = (res.content ?? []).map((c) => c.text || "").join(" ");
      assert.equal(res.isError, true, "坏表拒绝");
      assert.match(text, /lanes_merge_unavailable/, "固定原因码文案");
      assert.match(text, /config\/lanes\.json/, "指向车道表");
      assert.equal(serviceCalls, 0, "门前拒绝，零服务调用");
    } finally { await client.close(); await server.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});



// =====================================================================
// Group 1: tool discovery + count + annotations + strict input
// =====================================================================

test("M12-7-MRC-M1: run_continue registered; total tools = TOOLS.length (toolSurface SSOT); destructive + workspace-bound", async () => {
  const dir = makeGitDir("m127-mrc-m1-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server } = makeServer({ dir, serviceResult: successResult });
    const client = await buildInMemoryClient(server);
    try {
      const { tools } = await client.listTools();
      const t = tools.find((x) => x.name === "run_continue");
      assert.ok(t, "run_continue present");
      assert.equal(tools.length, TOOLS.length, "tool count equals toolSurface TOOLS.length SSOT (M12-10 moved playbook catalog to resources; M12-16 added run_correct)");
      // Resumes a provider conversation + mutates the retained worktree: destructive.
      assert.equal(t.annotations.destructiveHint, true);
      assert.equal(t.annotations.readOnlyHint, false);
      assert.equal(t.annotations.idempotentHint, false);
      assert.equal(t.annotations.openWorldHint, true);
      // Strict input: parentRunId + prompt required; delivery optional-inherits（决定 0130）.
      assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ["delivery", "expectedWorkspaceRoot", "parentRunId", "prompt"]);
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
        // requireCertified is server-owned: a client cannot force the gate via
        // tool arguments — rejected before the service is ever called.
        { args: { parentRunId: "run_p", prompt: "fix", delivery: DELIVERY, requireCertified: true }, label: "client cannot force requireCertified" },
        { args: { parentRunId: "run_p", delivery: DELIVERY }, label: "missing prompt" },
        { args: { prompt: "fix", delivery: DELIVERY }, label: "missing parentRunId" },
        // 第 135 批续修：delivery 可省——原 "missing delivery" 用例已移除：省略
        // delivery 是合法继承请求（0130-MRC-1 用注入服务钉住成功路径），且旧用例
        // 不带 expectedWorkspaceRoot，真实拒因是 wire 必填目标。
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
        arguments: { parentRunId: "run_p", prompt: "fix", delivery: DELIVERY, expectedWorkspaceRoot: dir },
      }).catch(() => ({ isError: true }));
      assert.equal(r.isError, true, "unbound → error");
      assert.equal(calls.length, 0, "service never called when workspace unbound");
    } finally { await client.close(); await server.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

// =====================================================================
// Group 3: service threading + structured success output + redaction
// =====================================================================

test("M12-7-MRC-M4: service threaded with bound workspace + requireCertified (no Lead session); structured success output; no leaks", async () => {
  const dir = makeGitDir("m127-mrc-m4-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server, calls } = makeServer({ dir, serviceResult: successResult, globalWaitTimeout: 60000 });
    const client = await buildInMemoryClient(server);
    try {
      const r = await client.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_parent_ok", prompt: "correct the bug", delivery: DELIVERY, expectedWorkspaceRoot: dir },
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
      // 决定 0114：谱系身份只取谱系自身事实——run_continue 不再携带 Lead 会话。
      assert.equal(Object.hasOwn(call, "leadSession"), false, "no Lead session threaded into lineage continuation");
      assert.equal(call.requireCertified, false, "certification is advisory: MCP never forces it (not a permission gate)");
      assert.equal(call.runDir, dir);
      assert.equal(call.globalWaitTimeout, 60000, "global wait timeout threaded");
      assert.equal(typeof call.backendFor, "function", "backend capability resolver threaded");

      const parsed = r.structuredContent;
      // 第 156 批：受理回执增 label；laneRules 有意不带（车道随谱系固定）。
      assert.deepEqual(Object.keys(parsed).sort(),
        ["accepted", "agentId", "continuation", "label", "nextStep", "parentRunId", "rejectionReason", "rootRunId", "runId", "state"],
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
        arguments: { parentRunId: "run_parent_legacy", prompt: "fix", delivery: DELIVERY, expectedWorkspaceRoot: dir },
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
        arguments: { parentRunId: "run_parent_busy", prompt: "fix", delivery: DELIVERY, expectedWorkspaceRoot: dir },
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

// 决定 0114：explicit_dispatch_continuable_unsupported 已从闭集删除（explicit
// 父档可续）。本腿保留原覆盖面：一个闭集内的具名拒绝仍以结构化 accepted:false
// 输出（schema enum 派生自同一 SSOT，不是 isError），服务层 detail 不进线上。
test("0114: closed-set refusal (role_contract_drift) → structured accepted:false + named code; detail never leaks", async () => {
  const dir = makeGitDir("wao-0114-mrc-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server } = makeServer({
      dir,
      serviceResult: (args) => ({
        accepted: false,
        parentRunId: args.parentRunId,
        continuation: true,
        rejectionReason: "role_contract_drift",
        detail: "the role contract pinned by the lineage root has changed since dispatch",
      }),
    });
    const client = await buildInMemoryClient(server);
    try {
      const r = await client.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_parent_explicit", prompt: "fix", delivery: DELIVERY, expectedWorkspaceRoot: dir },
      });
      assert.equal(r.isError, undefined, "closed-set refusal is a normal outcome, not an error");
      const parsed = r.structuredContent;
      assert.equal(parsed.accepted, false);
      assert.equal(parsed.parentRunId, "run_parent_explicit");
      assert.equal(parsed.continuation, true);
      assert.equal(parsed.rejectionReason, "role_contract_drift");
      assert.equal(parsed.runId, null);
      assert.equal(parsed.agentId, null);
      assert.equal(parsed.rootRunId, null);
      assert.equal(parsed.state, null);
      const dumped = JSON.stringify(r);
      assert.ok(!dumped.includes("has changed since dispatch"), "service detail text never in MCP output");
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
        arguments: { parentRunId: "run_p", prompt: "fix", delivery: DELIVERY, expectedWorkspaceRoot: dir },
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
        arguments: { parentRunId: "run_p", prompt: "fix", delivery: DELIVERY, expectedWorkspaceRoot: dir },
      });
      assert.equal(r.isError, true);
      const txt = r.content?.[0]?.text ?? "";
      assert.equal(txt, "run_continue failed", "fixed safe text");
      assert.ok(!txt.includes("boom-secret-detail-42"), "no dynamic error leak");
    } finally { await c2.close(); await s2.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

// =====================================================================
// Group 6: M12-22 continuation_scope_incomplete — cumulative-scope truth
// =====================================================================

test("M12-7-MRC-M8: continuation_scope_incomplete refusal surfaces bounded cumulative facts; wire-visible schema; unknown fields cannot pass", async () => {
  const dir = makeGitDir("m127-mrc-m8-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server } = makeServer({
      dir,
      serviceResult: () => ({
        accepted: false,
        parentRunId: "run_parent_scope",
        continuation: true,
        rejectionReason: "continuation_scope_incomplete",
        inheritedChangedPaths: ["a.txt", "b.txt", "c.txt"],
        inheritedChangedCount: 3,
        inheritedChangedTruncated: false,
        uncoveredInheritedPaths: ["a.txt", "b.txt"],
        uncoveredInheritedCount: 2,
        uncoveredInheritedTruncated: false,
        // Unknown / leak-attempt fields that MUST NOT cross the MCP boundary.
        evilSecret: "SHOULD-NOT-APPEAR",
        absolutePath: "C:\\secrets\\key.txt",
      }),
    });
    const client = await buildInMemoryClient(server);
    try {
      // Wire-visible schema: the cumulative-scope fields are declared on the
      // run_continue outputSchema, so a Lead/host can see the shape on tools/list.
      const { tools } = await client.listTools();
      const t = tools.find((x) => x.name === "run_continue");
      const props = t.outputSchema.properties;
      for (const field of [
        "inheritedChangedPaths", "inheritedChangedCount", "inheritedChangedTruncated",
        "uncoveredInheritedPaths", "uncoveredInheritedCount", "uncoveredInheritedTruncated",
      ]) {
        assert.ok(props[field], `wire-visible schema declares ${field}`);
      }

      const r = await client.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_parent_scope", prompt: "fix", delivery: DELIVERY, expectedWorkspaceRoot: dir },
      });
      assert.equal(r.isError, undefined, "a closed-set refusal is a normal outcome, not an error");

      // Parsed structured output with the bounded cumulative facts.
      const parsed = r.structuredContent;
      assert.equal(parsed.accepted, false);
      assert.equal(parsed.rejectionReason, "continuation_scope_incomplete");
      assert.deepEqual(parsed.inheritedChangedPaths, ["a.txt", "b.txt", "c.txt"]);
      assert.equal(parsed.inheritedChangedCount, 3);
      assert.equal(parsed.inheritedChangedTruncated, false);
      assert.deepEqual(parsed.uncoveredInheritedPaths, ["a.txt", "b.txt"]);
      assert.equal(parsed.uncoveredInheritedCount, 2);
      assert.equal(parsed.uncoveredInheritedTruncated, false);
      // Success-only fields stay null on a refusal.
      assert.equal(parsed.runId, null);
      assert.equal(parsed.state, null);

      // Unknown fields cannot pass; nothing leaked (incl. the absolute path).
      const dumped = JSON.stringify(r);
      assert.ok(!dumped.includes("evilSecret"), "unknown field never in output");
      assert.ok(!dumped.includes("SHOULD-NOT-APPEAR"), "unknown value never in output");
      assert.ok(!dumped.includes("absolutePath"), "absolute-path field never in output");
      assert.ok(!dumped.includes("secrets"), "absolute path value never in output");
    } finally { await client.close(); await server.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test("M12-7-MRC-M9: a malformed path inside the cumulative arrays fails closed — reason stays, arrays drop, nothing leaks", async () => {
  const dir = makeGitDir("m127-mrc-m9-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server } = makeServer({
      dir,
      serviceResult: () => ({
        accepted: false,
        parentRunId: "run_parent_scope",
        continuation: true,
        rejectionReason: "continuation_scope_incomplete",
        // An absolute path inside the array is NOT a safe repo-relative fact.
        inheritedChangedPaths: ["a.txt", "/etc/passwd"],
        inheritedChangedCount: 2,
        inheritedChangedTruncated: false,
        uncoveredInheritedPaths: ["/etc/passwd"],
        uncoveredInheritedCount: 1,
        uncoveredInheritedTruncated: false,
      }),
    });
    const client = await buildInMemoryClient(server);
    try {
      const r = await client.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_parent_scope", prompt: "fix", delivery: DELIVERY, expectedWorkspaceRoot: dir },
      });
      assert.equal(r.isError, undefined, "refusal still a normal outcome");
      const parsed = r.structuredContent;
      // The closed-set reason survives so the Lead still knows it is a scope
      // issue, but the untrustworthy arrays are dropped (verify manually).
      assert.equal(parsed.rejectionReason, "continuation_scope_incomplete");
      assert.equal(parsed.inheritedChangedPaths, undefined);
      assert.equal(parsed.uncoveredInheritedPaths, undefined);
      // The absolute path never leaks.
      const dumped = JSON.stringify(r);
      assert.ok(!dumped.includes("/etc/passwd"), "absolute path never leaks");
    } finally { await client.close(); await server.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

// =====================================================================
// 第 135 批（决定 0130）：delivery 可省——省略时继承父运行已生效的合同
// =====================================================================

test("0130-MRC-1: delivery omitted → handler does NOT enforce inline verification; service receives undefined; accepted receipt's nextStep names the inherited contract", async () => {
  const dir = makeGitDir("m127-mrc-0130-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server, calls } = makeServer({ dir, serviceResult: successResult });
    const client = await buildInMemoryClient(server);
    try {
      const r = await client.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_parent_ok", prompt: "correct the bug", expectedWorkspaceRoot: dir },
      });
      assert.equal(r.isError, undefined, "omitted delivery is a valid request (inheritance)");
      assert.equal(calls.length, 1, "service called once");
      assert.equal(calls[0].delivery, undefined, "service sees the omission (inherits in the service)");
      const parsed = r.structuredContent;
      assert.equal(parsed.accepted, true);
      // 受理回执写明这次用的是继承来的合同（nextStep 半句，无新增 wire 字段）。
      assert.match(parsed.nextStep, /Delivery contract inherited from the parent run\./);
      // 第 136 批：CLI 半句带子运行自己的 runId（不是 parentRunId），排在"继承合同"
      // 那半句之前。第 156 批：命名短提示（后台任务可命名 <label>）挂最末。
      assert.ok(parsed.nextStep.endsWith(
        `wao runs wait ${parsed.runId} --until-settled there; one command waits until settlement. `
        + `Delivery contract inherited from the parent run. （后台任务可命名 ${parsed.label}）`),
      `继承后缀 + 命名短提示在末尾: ${parsed.nextStep}`);
      assert.ok(!parsed.nextStep.includes(parsed.parentRunId), "不带 parentRunId");
      // Explicit-delivery receipts do NOT carry the clause.
      const r2 = await client.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_parent_ok", prompt: "correct the bug", delivery: DELIVERY, expectedWorkspaceRoot: dir },
      });
      assert.equal(r2.structuredContent.accepted, true);
      assert.ok(!r2.structuredContent.nextStep.includes("inherited"), "explicit delivery keeps the plain nextStep");
      assert.ok(r2.structuredContent.nextStep.endsWith(
        `wao runs wait ${r2.structuredContent.runId} --until-settled there; one command waits until settlement.`
        + ` （后台任务可命名 ${r2.structuredContent.label}）`),
      `显式合同：无继承半句、命名短提示在末尾: ${r2.structuredContent.nextStep}`);
    } finally { await client.close(); await server.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

// 第 136 批续修（会审 kimi 复现）：合法的长 runId 不能让已经受理的续修变成报错。
// 继承合同的后缀要和 CLI 半句一起算——半句本身放得下、加上后缀放不下时，服务器
// 若仍是"先渲染后半句再拼后缀"，整句会超 480 过不了出参校验。
test("136-L3: 长子 runId 的续修（delivery 省略、继承合同后缀）→ 受理成功；nextStep ≤ 480、继承后缀在末尾", async () => {
  const id140 = "run_" + "y".repeat(136); // 半句 + 继承后缀恰好放得下（479）
  const id150 = "run_" + "x".repeat(146); // 半句本身放得下（438），加继承后缀放不下（489）
  const id156 = "run_" + "z".repeat(152); // 同上：旧实现"先渲染半句再拼后缀"会得到 489、过不了出参校验
  const base = "Background run accepted. Before ending the turn, keep a wait attached: call run_await_result repeatedly with its default waitMs on this run until it settles.";
  const dir = makeGitDir("m136-mrc-longid-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    const ids = [id140, id150, id156];
    let served = 0;
    const { server, calls } = makeServer({
      dir,
      serviceResult: (args) => ({ ...successResult(args), runId: ids[served] }),
    });
    const client = await buildInMemoryClient(server);
    try {
      const args = { parentRunId: "run_parent_ok", prompt: "correct the bug", expectedWorkspaceRoot: dir };
      const call = async (id) => {
        const r = await client.callTool({ name: "run_continue", arguments: args });
        served += 1;
        assert.equal(calls.length, served, "续修服务已经受理");
        assert.equal(r.isError, undefined, `${id.length} 字符：受理不能变成报错（实测：${JSON.stringify(r.content?.[0]?.text ?? "")}）`);
        assert.equal(r.structuredContent.accepted, true);
        assert.equal(r.structuredContent.runId, id);
        assert.ok(r.structuredContent.nextStep.length <= 480, `${id.length} 字符整句 ${r.structuredContent.nextStep.length} ≤ 480`);
        assert.ok(!r.structuredContent.nextStep.includes("run_parent_ok"), "不带 parentRunId");
        return r.structuredContent.nextStep;
      };
      // 140 字符：整句 479——第 156 批的命名短提示放不下，只丢提示（原句不变）。
      assert.equal(await call(id140),
        `${base} If your host has a background shell, you can instead run wao runs wait ${id140} --until-settled there; one command waits until settlement. Delivery contract inherited from the parent run.`);
      // 150 与 156 字符：整句放不下 CLI 半句——MCP 写法与继承后缀照旧，命名短
      // 提示放得下、挂最末（第 156 批）。
      for (const id of [id150, id156]) {
        assert.equal(await call(id), `${base} Delivery contract inherited from the parent run. （后台任务可命名 [coder_hq] correct the bug）`);
      }
    } finally { await client.close(); await server.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test("0130-MRC-2: an EXPLICIT delivery without inline verification is still refused (the 0130 relaxation is inheritance-only)", async () => {
  const dir = makeGitDir("m127-mrc-0130b-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server, calls } = makeServer({ dir, serviceResult: successResult });
    const client = await buildInMemoryClient(server);
    try {
      const r = await client.callTool({
        name: "run_continue",
        arguments: {
          parentRunId: "run_parent_ok", prompt: "fix",
          delivery: { mode: "git_commit_v1", allowedPaths: ["src"] },
          expectedWorkspaceRoot: dir,
        },
      });
      assert.equal(r.isError, true, "explicit delivery without verification refused");
      const text = (r.content ?? []).map((c) => c.text ?? "").join("");
      assert.match(text, /must declare inline verification/, "fixed actionable refusal retained");
      assert.equal(calls.length, 0, "service never called");
    } finally { await client.close(); await server.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test("0130-MRC-3: run_continue input schema — delivery optional, expectedWorkspaceRoot required (wire-advertised)", async () => {
  const dir = makeGitDir("m127-mrc-0130c-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server } = makeServer({ dir, serviceResult: successResult });
    const client = await buildInMemoryClient(server);
    try {
      const { tools } = await client.listTools();
      const t = tools.find((x) => x.name === "run_continue");
      const required = t.inputSchema.required;
      assert.ok(required.includes("parentRunId") && required.includes("prompt"), "parentRunId + prompt stay required");
      assert.ok(required.includes("expectedWorkspaceRoot"), "expectedWorkspaceRoot is schema-required (第 135 批)");
      assert.ok(!required.includes("delivery"), "delivery is no longer schema-required");
      // 第 135 批续修：查 delivery 子对象自己的 required（顶层从不含 mode，
      // 旧断言是空断言）。
      assert.ok(Array.isArray(t.inputSchema.properties.delivery.required)
        && !t.inputSchema.properties.delivery.required.includes("mode"),
        "delivery.mode not required within the delivery object (defaults to git_commit_v1)");
    } finally { await client.close(); await server.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

// =====================================================================
// 第 135 批续修 5：继承合同复验失败的拒绝带 guidance（仅 delivery 省略时）
// =====================================================================

test("0130-续修5: invalid_delivery on an omitted (inherited) contract carries the fixed guidance; explicit-delivery refusal and other refusals do not", async () => {
  const dir = makeGitDir("m127-mrc-0130g-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    // 1) omitted delivery + invalid_delivery → guidance 在场（固定文案，指路显式 delivery）。
    const { server: s1 } = makeServer({
      dir,
      serviceResult: () => ({ accepted: false, parentRunId: "run_x", continuation: true, rejectionReason: "invalid_delivery" }),
    });
    const c1 = await buildInMemoryClient(s1);
    try {
      const r1 = await c1.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_x", prompt: "fix", expectedWorkspaceRoot: dir },
      });
      assert.equal(r1.structuredContent.rejectionReason, "invalid_delivery");
      assert.equal(
        r1.structuredContent.guidance,
        "the inherited delivery contract failed revalidation; pass an explicit delivery to override it.",
        "拒绝文案告诉 Lead 显式传 delivery",
      );
    } finally { await c1.close(); await s1.close(); }
    // 2) 显式 delivery + invalid_delivery → guidance 键缺席（继承语义不适用）。
    const { server: s2 } = makeServer({
      dir,
      serviceResult: () => ({ accepted: false, parentRunId: "run_x", continuation: true, rejectionReason: "invalid_delivery" }),
    });
    const c2 = await buildInMemoryClient(s2);
    try {
      const r2 = await c2.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_x", prompt: "fix", delivery: DELIVERY, expectedWorkspaceRoot: dir },
      });
      assert.equal(r2.structuredContent.guidance, undefined);
    } finally { await c2.close(); await s2.close(); }
    // 3) 省略 delivery + 其它拒因 → guidance 键缺席。
    const { server: s3 } = makeServer({
      dir,
      serviceResult: () => ({ accepted: false, parentRunId: "run_x", continuation: true, rejectionReason: "not_continuable" }),
    });
    const c3 = await buildInMemoryClient(s3);
    try {
      const r3 = await c3.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_x", prompt: "fix", expectedWorkspaceRoot: dir },
      });
      assert.equal(r3.structuredContent.guidance, undefined);
    } finally { await c3.close(); await s3.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

// =====================================================================
// 第 137a 批：回执投影下沉到应用层——MCP 的 structuredContent（除按面渲染的
// nextStep）就是 projectContinueOutcome 的产物；CLI `runs continue` 输出同一个
// 函数的结果（见 test/delivery/runsContinueCorrectRepackageCli.test.js），
// 两面不会各改各的。
// =====================================================================

test("137a-MRC: MCP 回执 = 应用层 projectContinueOutcome + 按面的 nextStep（受理、每个拒绝码、累计范围事实、继承合同 guidance）", async () => {
  const { projectContinueOutcome, CONTINUE_REJECTION_REASONS, CONTINUE_INHERITED_DELIVERY_NOTE } =
    await import("../../src/application/runContinue.js");
  const { buildNextStep, NEXT_STEP_MAX_LEN } = await import("../../src/application/runNextStep.js");
  const { buildDispatchLabel, appendLabelHint } = await import("../../src/application/dispatchLabel.js");
  const dir = makeGitDir("m137a-mrc-proj-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    const PARENT = "run_parent_proj";
    const refused = (rejectionReason, extra = {}) => ({ accepted: false, parentRunId: PARENT, continuation: true, rejectionReason, ...extra });
    const cases = [
      { label: "受理·合同省略", delivery: undefined, raw: () => successResult({ parentRunId: PARENT, runDir: dir }) },
      { label: "受理·显式合同", delivery: DELIVERY, raw: () => successResult({ parentRunId: PARENT, runDir: dir }) },
      ...CONTINUE_REJECTION_REASONS.map((reason) => ({ label: `拒绝·${reason}`, delivery: undefined, raw: () => refused(reason) })),
      { label: "继承合同复验失败·显式合同不带 guidance", delivery: DELIVERY, raw: () => refused("invalid_delivery") },
      {
        label: "累计范围·截断标记合法",
        delivery: DELIVERY,
        raw: () => refused("continuation_scope_incomplete", {
          inheritedChangedPaths: ["src/a.js", "src/b.js"], inheritedChangedCount: 3, inheritedChangedTruncated: true,
          uncoveredInheritedPaths: ["src/b.js"], uncoveredInheritedCount: 1, uncoveredInheritedTruncated: false,
        }),
      },
      {
        label: "累计范围·不安全路径整组省略",
        delivery: DELIVERY,
        raw: () => refused("continuation_scope_incomplete", {
          inheritedChangedPaths: ["src/a.js"], inheritedChangedCount: 1, inheritedChangedTruncated: false,
          uncoveredInheritedPaths: ["../outside.js"], uncoveredInheritedCount: 1, uncoveredInheritedTruncated: false,
        }),
      },
      {
        label: "累计范围·计数与截断矛盾整组省略",
        delivery: DELIVERY,
        raw: () => refused("continuation_scope_incomplete", {
          inheritedChangedPaths: ["src/a.js"], inheritedChangedCount: 1, inheritedChangedTruncated: true,
          uncoveredInheritedPaths: [], uncoveredInheritedCount: 0, uncoveredInheritedTruncated: false,
        }),
      },
    ];
    for (const c of cases) {
      const rawValue = c.raw();
      const { server } = makeServer({ dir, serviceResult: () => rawValue });
      const client = await buildInMemoryClient(server);
      try {
        const r = await client.callTool({
          name: "run_continue",
          arguments: { parentRunId: PARENT, prompt: "fix", expectedWorkspaceRoot: dir, ...(c.delivery ? { delivery: c.delivery } : {}) },
        });
        assert.equal(r.isError, undefined, `${c.label}: 不是错误`);
        const expected = {
          ...projectContinueOutcome(rawValue, c.delivery),
          ...(rawValue.accepted
            ? (() => {
              // 第 156 批：受理回执带 label；nextStep 末尾挂命名短提示（同一实现）。
              const label = buildDispatchLabel({ lane: rawValue.agentId, prompt: "fix", fallbackId: rawValue.runId });
              return {
                ...(label != null ? { label } : {}),
                nextStep: appendLabelHint(buildNextStep({
                  surface: "mcp", situation: "dispatch_accepted", runId: rawValue.runId,
                  suffix: c.delivery === undefined ? CONTINUE_INHERITED_DELIVERY_NOTE : "",
                }), label, NEXT_STEP_MAX_LEN),
              };
            })()
            : {}),
        };
        assert.deepEqual(r.structuredContent, expected, `${c.label}: structuredContent 就是共享投影 + nextStep`);
        assert.deepEqual(JSON.parse(r.content[0].text), expected, `${c.label}: text 与 structuredContent 同一份`);
      } finally { await client.close(); await server.close(); }
    }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test("156 修正一: run_continue 的 label 与 Owner 看板同一条脱敏链（无令牌形状的环境秘密原值也遮住）", async () => {
  const dir = makeGitDir("m127-rc-redact-");
  const prev = process.env.WAO_TEST_API_KEY;
  const secret = "plain-secret-15";
  process.env.WAO_TEST_API_KEY = secret;
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { coder_hq: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server } = makeServer({ dir, serviceResult: successResult });
    const client = await buildInMemoryClient(server);
    try {
      const prompt = `# 修 ${secret} 的部署\n正文`;
      const r = await client.callTool({
        name: "run_continue",
        arguments: { parentRunId: "run_parent", prompt, expectedWorkspaceRoot: dir, delivery: DELIVERY },
      });
      assert.equal(r.isError, undefined, `受理照常：${r.content?.[0]?.text ?? ""}`);
      const expectedTitle = deriveOwnerTitle(prompt, createSecretRedactor(process.env).redactString);
      assert.equal(r.structuredContent.label, `[coder_hq] ${expectedTitle}`, "与看板对同一输入逐字相同");
      assert.ok(!r.structuredContent.label.includes(secret), "秘密原值不进 label");
      assert.ok(r.structuredContent.label.includes("[REDACTED:WAO_TEST_API_KEY]"), "精确脱敏标记");
      assert.ok(!r.content[0].text.includes(secret), "整份回执不出现秘密原值");
    } finally { await client.close(); await server.close(); }
  } finally {
    if (prev === undefined) delete process.env.WAO_TEST_API_KEY;
    else process.env.WAO_TEST_API_KEY = prev;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
