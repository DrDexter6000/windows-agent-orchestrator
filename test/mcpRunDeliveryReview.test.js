// test/mcpRunDeliveryReview.test.js
//
// M11-3C: run_delivery_review MCP adapter — safe projection of the M11-3B
// application service over the MCP protocol.
//
// Coverage:
//   - tool discovery (14 tools, run_delivery_review present)
//   - strict input (extra keys rejected, negative/fractional/string fileIndex)
//   - workspace-bound authorization (no binding → service never called)
//   - safe output: first page, continuation, terminal page
//   - binary / diff_too_large metadata-only results
//   - fixed error on service throw; no structuredContent on error; sentinel leak
//   - adapter does not decode cursor; does not shell out to CLI
//   - malicious service-output attack matrix (runId/commit/index/path/format/fragment/cursor)
//   - no hostDependencies / git executor exposed to the model

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { createWaoMcpServer } from "../src/mcp/server.js";
import { getRunDeliveryReview } from "../src/application/runDeliveryReview.js";

// ===== Helpers =====

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-m113c", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** Create a temp dir that is a real git repo so proveWorkspace accepts it. */
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

// =====================================================================
// Group 1: tool discovery + count + annotations
// =====================================================================

test("M11-3C-01: run_delivery_review is registered; total tools = 16; read-only annotations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m113c-01-"));
  try {
    const rp = join(dir, "agents.json");
    writeFileSync(rp, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const server = createWaoMcpServer({ registryPath: rp, runDir: dir, workspaceRoot: dir });
    const client = await buildInMemoryClient(server);
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.find((t) => t.name === "run_delivery_review"), "run_delivery_review present");
      assert.equal(tools.length, 16, "exactly 16 tools (M11-8A added lead_preflight)");
      const t = tools.find((x) => x.name === "run_delivery_review");
      assert.equal(t.annotations.readOnlyHint, true);
      assert.equal(t.annotations.destructiveHint, false);
      assert.equal(t.annotations.idempotentHint, true);
      assert.equal(t.annotations.openWorldHint, false);
      // input schema: strict, only runId/fileIndex/cursor
      assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ["cursor", "fileIndex", "runId"]);
      assert.equal(t.inputSchema.additionalProperties, false);
      // output schema exists
      assert.ok(t.outputSchema, "output schema present");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 2: strict input
// =====================================================================

test("M11-3C-02: extra input key rejected before service; negative/fractional/string fileIndex rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m113c-02-"));
  try {
    let serviceCalls = 0;
    const server = createWaoMcpServer({
      registryPath: "/x", runDir: dir, workspaceRoot: dir,
      getRunDeliveryReviewFn: () => { serviceCalls++; return { available: true }; },
    });
    const client = await buildInMemoryClient(server);
    try {
      // Extra key → rejected by zod strict
      const extra = await client.callTool({
        name: "run_delivery_review",
        arguments: { runId: "run_x", fileIndex: 0, unexpected: 1 },
      }).catch(() => ({ isError: true }));
      assert.equal(extra.isError, true, "extra key rejected");
      assert.equal(serviceCalls, 0, "service not called for extra key");

      // Negative fileIndex
      const neg = await client.callTool({
        name: "run_delivery_review",
        arguments: { runId: "run_x", fileIndex: -1 },
      }).catch(() => ({ isError: true }));
      assert.equal(neg.isError, true, "negative fileIndex rejected");
      assert.equal(serviceCalls, 0);

      // Fractional
      const frac = await client.callTool({
        name: "run_delivery_review",
        arguments: { runId: "run_x", fileIndex: 0.5 },
      }).catch(() => ({ isError: true }));
      assert.equal(frac.isError, true, "fractional fileIndex rejected");

      // String fileIndex
      const str = await client.callTool({
        name: "run_delivery_review",
        arguments: { runId: "run_x", fileIndex: "0" },
      }).catch(() => ({ isError: true }));
      assert.equal(str.isError, true, "string fileIndex rejected");

      // Missing runId
      const missing = await client.callTool({
        name: "run_delivery_review",
        arguments: { fileIndex: 0 },
      }).catch(() => ({ isError: true }));
      assert.equal(missing.isError, true, "missing runId rejected");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 3: workspace-bound authorization
// =====================================================================

test("M11-3C-03: no workspace binding → service never called", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m113c-03-"));
  try {
    let serviceCalls = 0;
    const server = createWaoMcpServer({
      registryPath: "/x", runDir: dir,
      // No workspaceRoot, no MCP roots capability → not bound
      getRunDeliveryReviewFn: () => { serviceCalls++; return {}; },
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_delivery_review",
        arguments: { runId: "run_x", fileIndex: 0 },
      });
      assert.equal(res.isError, true, "no binding → error result");
      assert.equal(serviceCalls, 0, "service never called without workspace binding");
      const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.ok(/workspace|bound/i.test(text), "error mentions workspace not bound");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 4: safe output — first page, continuation, terminal, binary, too_large
// =====================================================================

// A valid safe service output for a text artifact.
function validTextPage(overrides = {}) {
  return {
    runId: "run_review1",
    deliveryCommit: "a".repeat(40),
    fileIndex: 0,
    changedFileCount: 1,
    changedPath: "src/app.js",
    contentFormat: "unified_diff_v1",
    artifactTextTrust: "untrusted_repository_text",
    available: true,
    unavailableReason: null,
    fragment: "diff --git a/src/app.js b/src/app.js\n+const x = 1;\n",
    fragmentBytes: 51,
    nextCursor: null,
    truncated: false,
    ...overrides,
  };
}

test("M11-3C-04: first page / continuation / terminal page / binary / too_large pass safe output", async () => {
  const dir = makeGitDir("m113c-04-");
  try {
    // First page (has nextCursor)
    let callArgs = [];
    const server = createWaoMcpServer({
      registryPath: "/x", runDir: dir, workspaceRoot: dir,
      getRunDeliveryReviewFn: async (args) => {
        callArgs.push(args);
        // Simulate 2-page artifact
        if (callArgs.length === 1) {
          return validTextPage({
            fragment: "page1".padEnd(100, "x"),
            fragmentBytes: 100,
            nextCursor: "eyJ2IjozLCJhIjoiYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJpIjowLCJvIjoxMDAsImQiOiJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiIn0",
            truncated: true,
          });
        }
        return validTextPage({ fragment: "page2", fragmentBytes: 5, nextCursor: null, truncated: false });
      },
    });
    const client = await buildInMemoryClient(server);
    try {
      // Page 1
      const p1 = await client.callTool({ name: "run_delivery_review", arguments: { runId: "run_review1", fileIndex: 0 } });
      assert.equal(p1.isError, undefined, "page 1 not error");
      assert.ok(p1.structuredContent, "page 1 structuredContent");
      assert.equal(p1.structuredContent.available, true);
      assert.ok(p1.structuredContent.nextCursor, "page 1 has nextCursor");
      assert.equal(p1.structuredContent.truncated, true, "page 1 truncated");
      assert.equal(p1.structuredContent.contentFormat, "unified_diff_v1");
      assert.equal(p1.structuredContent.artifactTextTrust, "untrusted_repository_text");

      // Page 2 (continuation with cursor)
      const p2 = await client.callTool({
        name: "run_delivery_review",
        arguments: { runId: "run_review1", fileIndex: 0, cursor: p1.structuredContent.nextCursor },
      });
      assert.equal(p2.isError, undefined, "page 2 not error");
      assert.equal(p2.structuredContent.nextCursor, null, "page 2 no cursor (terminal)");
      assert.equal(p2.structuredContent.truncated, false, "page 2 not truncated");

      // Cursor was passed through to service opaquely
      assert.ok(callArgs[1].cursor, "cursor passed to service");
    } finally {
      await client.close();
      await server.close();
    }

    // Binary
    {
      const srv2 = createWaoMcpServer({
        registryPath: "/x", runDir: dir, workspaceRoot: dir,
        getRunDeliveryReviewFn: () => validTextPage({
          available: false, unavailableReason: "binary", fragment: "", fragmentBytes: 0,
          nextCursor: null, truncated: false,
        }),
      });
      const c2 = await buildInMemoryClient(srv2);
      try {
        const r = await c2.callTool({ name: "run_delivery_review", arguments: { runId: "run_review1", fileIndex: 0 } });
        assert.equal(r.structuredContent.available, false);
        assert.equal(r.structuredContent.unavailableReason, "binary");
        assert.equal(r.structuredContent.fragment, "");
        assert.equal(r.structuredContent.fragmentBytes, 0);
        assert.equal(r.structuredContent.nextCursor, null);
      } finally {
        await c2.close();
        await srv2.close();
      }
    }

    // diff_too_large
    {
      const srv3 = createWaoMcpServer({
        registryPath: "/x", runDir: dir, workspaceRoot: dir,
        getRunDeliveryReviewFn: () => validTextPage({
          available: false, unavailableReason: "diff_too_large", fragment: "", fragmentBytes: 0,
          nextCursor: null, truncated: false,
        }),
      });
      const c3 = await buildInMemoryClient(srv3);
      try {
        const r = await c3.callTool({ name: "run_delivery_review", arguments: { runId: "run_review1", fileIndex: 0 } });
        assert.equal(r.structuredContent.available, false);
        assert.equal(r.structuredContent.unavailableReason, "diff_too_large");
        assert.equal(r.structuredContent.fragment, "");
      } finally {
        await c3.close();
        await srv3.close();
      }
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 5: fixed error / sentinel leak / no structuredContent on error
// =====================================================================

test("M11-3C-05: service throw → fixed error, no structuredContent, sentinel leak", async () => {
  const SENTINEL = "test-secret-m113c-sentinel";
  const dir = makeGitDir("m113c-05-");
  try {
    const server = createWaoMcpServer({
      registryPath: "/x", runDir: dir, workspaceRoot: dir,
      getRunDeliveryReviewFn: () => { const e = new Error("internal: " + SENTINEL); throw e; },
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery_review", arguments: { runId: "run_x", fileIndex: 0 } });
      assert.equal(res.isError, true, "error flagged");
      assert.ok(!res.structuredContent, "no structuredContent on error");
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes(SENTINEL), "sentinel must not leak");
      const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.equal(text, "run_delivery_review failed", "fixed error text");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 6: malicious service-output attack matrix
// =====================================================================

test("M11-3C-06: malformed/malicious service output collapses to fixed error", async () => {
  const dir = makeGitDir("m113c-06-");
  const attacks = [
    {
      label: "runId mismatch (service returns different runId)",
      output: validTextPage({ runId: "run_IMPOSTOR" }),
    },
    {
      label: "symbolic commit (HEAD)",
      output: validTextPage({ deliveryCommit: "HEAD" }),
    },
    {
      label: "uppercase commit",
      output: validTextPage({ deliveryCommit: "A".repeat(40) }),
    },
    {
      label: "short commit",
      output: validTextPage({ deliveryCommit: "abc123" }),
    },
    {
      label: "extra unknown key",
      output: { ...validTextPage(), secret: "leak" },
    },
    {
      label: "negative fileIndex",
      output: validTextPage({ fileIndex: -1 }),
    },
    {
      label: "fileIndex >= changedFileCount",
      output: validTextPage({ fileIndex: 5, changedFileCount: 1 }),
    },
    {
      label: "changedFileCount 0 but available=true and fileIndex=0",
      output: validTextPage({ changedFileCount: 0 }),
    },
    {
      label: "invalid contentFormat",
      output: validTextPage({ contentFormat: "raw_html" }),
    },
    {
      label: "invalid artifactTextTrust",
      output: validTextPage({ artifactTextTrust: "trusted_safe" }),
    },
    {
      label: "available=true but unavailableReason set",
      output: validTextPage({ available: true, unavailableReason: "binary" }),
    },
    {
      label: "available=false but fragment non-empty",
      output: validTextPage({ available: false, fragment: "should not be here", fragmentBytes: 18 }),
    },
    {
      label: "available=false but nextCursor non-null",
      output: validTextPage({ available: false, nextCursor: "abc", truncated: true }),
    },
    {
      label: "fragment > 16 KiB",
      output: validTextPage({ fragment: "X".repeat(16385), fragmentBytes: 16385 }),
    },
    {
      label: "fragmentBytes mismatch",
      output: validTextPage({ fragment: "hello", fragmentBytes: 999 }),
    },
    {
      label: "nextCursor > 192 chars",
      output: validTextPage({ nextCursor: "A".repeat(193), truncated: true }),
    },
    {
      label: "truncated=true but nextCursor null",
      output: validTextPage({ truncated: true, nextCursor: null }),
    },
  ];
  for (const attack of attacks) {
    const server = createWaoMcpServer({
      registryPath: "/x", runDir: dir, workspaceRoot: dir,
      getRunDeliveryReviewFn: () => attack.output,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_delivery_review",
        arguments: { runId: "run_review1", fileIndex: 0 },
      });
      assert.equal(res.isError, true, `${attack.label}: must be error`);
      assert.ok(!res.structuredContent, `${attack.label}: no structuredContent`);
      const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.equal(text, "run_delivery_review failed", `${attack.label}: fixed error`);
    } finally {
      await client.close();
      await server.close();
    }
  }
  cleanupDir(dir);
});

// =====================================================================
// Group 7: adapter does not decode cursor; does not shell out
// =====================================================================

test("M11-3C-07: cursor passed opaquely; adapter has no shell-out; no hostDependencies exposed", async () => {
  const dir = makeGitDir("m113c-07-");
  const OPAQUE = "an-opaque-token-not-decoded";
  let capturedCursor = null;
  try {
    const server = createWaoMcpServer({
      registryPath: "/x", runDir: dir, workspaceRoot: dir,
      getRunDeliveryReviewFn: async (args) => {
        capturedCursor = args.cursor;
        return validTextPage({ nextCursor: null, truncated: false });
      },
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_delivery_review",
        arguments: { runId: "run_review1", fileIndex: 0, cursor: OPAQUE },
      });
      assert.equal(res.isError, undefined, "valid call passes");
      assert.equal(capturedCursor, OPAQUE, "cursor passed opaquely to service");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }

  // Static check: MCP adapter does not import child_process / does not shell out.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const srvSrc = readFileSync(fileURLToPath(new URL("../src/mcp/server.js", import.meta.url)), "utf8");
  assert.ok(!/node:child_process/.test(srvSrc), "MCP adapter has no child_process import");
  assert.ok(!/shell:\s*true/.test(srvSrc), "no shell:true");
});

// =====================================================================
// M11-3C closeout: shared projection secret redaction + strict input +
// real default-service no-model smoke.
// =====================================================================

// ---- closeout-1: exact secret in changedPath is redacted; secret in fragment fails closed ----
test("M11-3C-CLOSE-1: changedPath secret → [REDACTED]; fragment secret → fixed error", async () => {
  const SECRET = "test-secret-closeout-mcp-path";
  const ENV_VAR = "M113C_CLOSE1_TOKEN";
  const oldVal = process.env[ENV_VAR];
  process.env[ENV_VAR] = SECRET; // configure in process.env so createSecretRedactor() finds it
  const dir = makeGitDir("m113c-close1-");
  try {
    // changedPath contains a configured secret → redacted to [REDACTED]
    {
      const server = createWaoMcpServer({
        registryPath: "/x", runDir: dir, workspaceRoot: dir,
        getRunDeliveryReviewFn: async () => validTextPage({
          runId: "run_close1", changedPath: `src/${SECRET}.js`,
        }),
      });
      const client = await buildInMemoryClient(server);
      try {
        const res = await client.callTool({ name: "run_delivery_review", arguments: { runId: "run_close1", fileIndex: 0 } });
        assert.equal(res.isError, undefined, "valid call");
        assert.equal(res.structuredContent.changedPath, "[REDACTED]", "changedPath collapsed to [REDACTED]");
        assert.ok(!JSON.stringify(res).includes(SECRET), "secret not in result");
      } finally { await client.close(); await server.close(); }
    }
    // fragment contains a configured secret → fail closed
    {
      const server = createWaoMcpServer({
        registryPath: "/x", runDir: dir, workspaceRoot: dir,
        getRunDeliveryReviewFn: async () => validTextPage({
          runId: "run_close1",
          fragment: `+const x = "${SECRET}";\n`,
          fragmentBytes: Buffer.byteLength(`+const x = "${SECRET}";\n`),
        }),
      });
      const client = await buildInMemoryClient(server);
      try {
        const res = await client.callTool({ name: "run_delivery_review", arguments: { runId: "run_close1", fileIndex: 0 } });
        assert.equal(res.isError, true, "fragment secret → error");
        assert.ok(!res.structuredContent, "no structuredContent");
        assert.ok(!JSON.stringify(res).includes(SECRET), "secret not in error result");
      } finally { await client.close(); await server.close(); }
    }
  } finally {
    if (oldVal === undefined) delete process.env[ENV_VAR]; else process.env[ENV_VAR] = oldVal;
    cleanupDir(dir);
  }
});
test("M11-3C-CLOSE-2: whitespace runId / bad cursor rejected before service", async () => {
  const dir = makeGitDir("m113c-close2-");
  try {
    let calls = 0;
    const server = createWaoMcpServer({
      registryPath: "/x", runDir: dir, workspaceRoot: dir,
      getRunDeliveryReviewFn: async () => { calls++; return validTextPage(); },
    });
    const client = await buildInMemoryClient(server);
    try {
      // whitespace runId
      calls = 0;
      await client.callTool({ name: "run_delivery_review", arguments: { runId: "   ", fileIndex: 0 } }).catch(() => {});
      assert.equal(calls, 0, "whitespace runId → 0 calls");

      // empty cursor
      calls = 0;
      const r2 = await client.callTool({ name: "run_delivery_review", arguments: { runId: "run_review1", fileIndex: 0, cursor: "" } }).catch(() => ({ isError: true }));
      assert.equal(r2.isError, true, "empty cursor → error");
      assert.equal(calls, 0, "empty cursor → 0 calls");

      // non-base64url cursor
      calls = 0;
      const r3 = await client.callTool({ name: "run_delivery_review", arguments: { runId: "run_review1", fileIndex: 0, cursor: "bad!token" } }).catch(() => ({ isError: true }));
      assert.equal(r3.isError, true, "non-base64url cursor → error");
      assert.equal(calls, 0, "non-base64url cursor → 0 calls");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

// ---- closeout-3: REAL no-model smoke — default service, real git, real transcript ----
test("M11-3C-CLOSE-3-SMOKE: real default service MCP + CLI parity, inventory unchanged", async () => {
  const { packageDelivery } = await import("../src/delivery.js");
  const { runsDeliveryCommand } = await import("../src/commands/runs.js");
  const { statSync } = await import("node:fs");

  // Build a real git repo with a verified delivery.
  const repo = mkdtempSync(join(tmpdir(), "m113c-smoke-repo-"));
  const runDir = mkdtempSync(join(tmpdir(), "m113c-smoke-td-"));
  try {
    execSync("git init -b main", { cwd: repo, stdio: "ignore" });
    execSync('git config user.email "t@t"', { cwd: repo, stdio: "ignore" });
    execSync('git config user.name "t"', { cwd: repo, stdio: "ignore" });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.js"), "const a = 1;\n");
    execSync("git add . && git commit -m init", { cwd: repo, stdio: "ignore" });
    const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"] }).trim();

    const wt = join(repo, ".wao-worktrees", "run_smoke");
    execSync(`git worktree add "${wt}" -b wao/run_smoke`, { cwd: repo, stdio: "ignore" });
    writeFileSync(join(wt, "src", "a.js"), "const a = 2;\n");
    const ref = packageDelivery({
      runId: "run_smoke", worktreePath: wt, baseCommit: base, allowedPaths: ["src"],
      isolation: { type: "worktree", strategy: "persistent" }, verificationCommands: ["npm test"],
    });

    // Write a real transcript.
    const events = [
      { type: "run.started", runId: "run_smoke", ts: "2026-01-01T00:00:00Z", seq: 1 },
      { type: "run.background_submitted", runId: "run_smoke", ts: "2026-01-01T00:00:00Z", seq: 1, cwd: repo, background: true },
      { type: "run.delivery_created", runId: "run_smoke", ts: "2026-01-01T00:00:01Z", seq: 2, delivery: ref },
      { type: "run.delivery_verification_passed", runId: "run_smoke", ts: "2026-01-01T00:00:02Z", seq: 3, delivery: ref },
      { type: "run.state_change", runId: "run_smoke", ts: "2026-01-01T00:00:03Z", seq: 4, from: "running", to: "completed" },
      { type: "run.completed", runId: "run_smoke", ts: "2026-01-01T00:00:04Z", seq: 5 },
    ];
    writeFileSync(join(runDir, "run_smoke.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    // MCP: default service, no injection — first page
    const server = createWaoMcpServer({ registryPath: "/x", runDir, workspaceRoot: repo });
    const client = await buildInMemoryClient(server);
    try {
      const transcriptBefore = statSync(join(runDir, "run_smoke.jsonl")).size;
      const headBefore = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();

      const res = await client.callTool({
        name: "run_delivery_review",
        arguments: { runId: "run_smoke", fileIndex: 0 },
      });
      assert.equal(res.isError, undefined, "MCP smoke call succeeds");
      assert.ok(res.structuredContent.available, "artifact available");
      assert.ok(res.structuredContent.fragment.includes("const a = 2;"), "diff content present");
      assert.equal(res.structuredContent.changedPath, "src/a.js");
      assert.equal(res.structuredContent.contentFormat, "unified_diff_v1");
      assert.equal(res.structuredContent.artifactTextTrust, "untrusted_repository_text");

      // Inventory unchanged
      const transcriptAfter = statSync(join(runDir, "run_smoke.jsonl")).size;
      const headAfter = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
      assert.equal(transcriptAfter, transcriptBefore, "transcript bytes unchanged");
      assert.equal(headAfter, headBefore, "source HEAD unchanged");
    } finally {
      await client.close();
      await server.close();
    }

    // CLI: default service, --format json — semantic parity with MCP
    {
      const orig = console.log;
      let cliOut = "";
      console.log = (...a) => { cliOut += a.join("\t") + "\n"; };
      try {
        await runsDeliveryCommand(
          ["review", "run_smoke", "--file-index", "0", "--format", "json", "--cwd", repo],
          { runDir },
        );
      } finally { console.log = orig; }
      const cliParsed = JSON.parse(cliOut);
      assert.equal(cliParsed.available, true, "CLI parity: available");
      assert.equal(cliParsed.changedPath, "src/a.js", "CLI parity: changedPath");
      assert.equal(cliParsed.contentFormat, "unified_diff_v1", "CLI parity: contentFormat");
      assert.ok(cliParsed.fragment.includes("const a = 2;"), "CLI parity: fragment content");
    }
  } finally {
    try { execSync("git worktree prune", { cwd: repo, stdio: "ignore" }); } catch {}
    cleanupDir(repo);
    cleanupDir(runDir);
  }
});