// test/m11-8b-wire.test.js
//
// M11-8B final pre-dispatch / wire-schema micro-closeout.
//
// Two narrow gaps from the CTO verdict on bdabbda:
//   RED-1: an invalid/unknown requested agentId still reached the dispatcher
//          (callCount=1). Validation must happen at the handler top, before
//          workspace resolution or any dispatcher call (callCount=0).
//   RED-2: the wire-visible outputSchema could not distinguish dispatch's
//          real-only agentId from the read tools' real-or-unknown agentId.
//          zod .refine() is dropped by JSON Schema serialization, so both
//          serialized to the identical pattern. The split must be expressible
//          at the JSON-Schema layer (not rely on refine).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

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

async function buildClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-client", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

// =====================================================================
// RED-1: invalid/unknown requested agentId must NOT reach the dispatcher
// =====================================================================

test("WIRE-RED1: invalid requested agentId does not call dispatcher (callCount=0)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wire-red1-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    let callCount = 0;
    const fakeDispatch = async () => {
      callCount += 1;
      return { accepted: true, runId: "r", agentId: "x", state: "pending" };
    };
    const { createWaoMcpServer } = await import("../src/mcp/server.js");
    const server = createWaoMcpServer({
      registryPath, runDir: join(dir, "runs"), workspaceRoot: dir, dispatchRunFn: fakeDispatch,
    });
    const client = await buildClient(server);
    try {
      for (const bad of ["bad id", "unknown"]) {
        callCount = 0;
        const res = await client.callTool({
          name: "run_dispatch",
          arguments: { agentId: bad, prompt: "task" },
        });
        assert.equal(res.isError, true, `${JSON.stringify(bad)} → isError`);
        assert.equal(callCount, 0, `dispatcher NOT called for ${JSON.stringify(bad)} (callCount=0)`);
        assert.equal(res.structuredContent, undefined, "no structuredContent");
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// RED-2: wire-visible outputSchema distinguishes dispatch vs read agentId
// =====================================================================

test("WIRE-RED2: dispatch agentId wire schema rejects 'unknown'; read tools accept it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wire-red2-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const { createWaoMcpServer } = await import("../src/mcp/server.js");
    const server = createWaoMcpServer({ registryPath, runDir: join(dir, "runs"), workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const dispatch = tools.tools.find((t) => t.name === "run_dispatch");
      const status = tools.tools.find((t) => t.name === "run_status");
      const wait = tools.tools.find((t) => t.name === "run_wait");
      const collect = tools.tools.find((t) => t.name === "run_collect");
      const dispatchSchema = dispatch.outputSchema.properties.agentId;
      const statusSchema = status.outputSchema.properties.agentId;
      const waitSchema = wait.outputSchema.properties.agentId;
      const collectSchema = collect.outputSchema.properties.agentId;
      const dispatchStr = JSON.stringify(dispatchSchema);
      const statusStr = JSON.stringify(statusSchema);

      // 1. dispatch schema must structurally EXCLUDE "unknown" at the wire layer.
      //    It must NOT be a bare pattern that "unknown" satisfies; the JSON-Schema
      //    representation must make "unknown" invalid for dispatch.
      assert.ok(!isSchemaAcceptingUnknown(dispatchSchema),
        "dispatch agentId wire schema rejects literal 'unknown'");
      // 2. read tools must structurally ACCEPT "unknown" at the wire layer.
      for (const [name, sch] of [["run_status", statusSchema], ["run_wait", waitSchema], ["run_collect", collectSchema]]) {
        assert.ok(isSchemaAcceptingUnknown(sch),
          `${name} agentId wire schema accepts literal 'unknown'`);
      }
      // 3. the two schemas are NOT identical (the split is wire-visible).
      assert.notEqual(dispatchStr, statusStr,
        "dispatch and status agentId schemas differ at the wire layer");
      // 4. both reuse the SAME SSOT real-id wire pattern + max (no second
      //    hand-maintained regex). The SSOT wire pattern excludes "unknown".
      const { REAL_AGENT_ID_WIRE_PATTERN, CANONICAL_AGENT_ID_MAX } = await import("../src/canonicalAgentId.js");
      assert.equal(realPattern(dispatchSchema), REAL_AGENT_ID_WIRE_PATTERN, "dispatch reuses SSOT real wire pattern");
      assert.equal(realPattern(statusSchema), REAL_AGENT_ID_WIRE_PATTERN, "status reuses SSOT real wire pattern");
      assert.equal(realMax(dispatchSchema), CANONICAL_AGENT_ID_MAX, "dispatch reuses SSOT max");
      assert.equal(realMax(statusSchema), CANONICAL_AGENT_ID_MAX, "status reuses SSOT max");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---- schema inspection helpers ----
// A schema "accepts unknown" if the literal "unknown" would validate against
// its wire (JSON-Schema) representation. This is checked by evaluating the
// schema's OWN pattern (including any negative lookahead) and its const/enum/
// union alternatives — NOT by assuming a bare alphabet pattern accepts it.
function schemaAccepts(schema, value) {
  if (!schema || typeof schema !== "object") return false;
  // anyOf / oneOf union: accepts if any branch accepts the value.
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[key])) {
      if (schema[key].some((b) => schemaAccepts(b, value))) return true;
    }
  }
  // const === value.
  if (Object.prototype.hasOwnProperty.call(schema, "const") && schema.const === value) return true;
  // enum includes value.
  if (Array.isArray(schema.enum) && schema.enum.includes(value)) return true;
  // pattern: evaluate the schema's OWN pattern (anchored) against the value.
  // This correctly rejects "unknown" for dispatch's (?!unknown$) lookahead.
  if (typeof schema.pattern === "string") {
    // The patterns are already anchored (^...$); wrap to be safe.
    try {
      const re = new RegExp(schema.pattern);
      if (re.test(value)) return true;
    } catch { /* ignore malformed */ }
  }
  return false;
}

function isSchemaAcceptingUnknown(schema) {
  return schemaAccepts(schema, "unknown");
}

function realPattern(schema) {
  // For a union, find the branch carrying the real-id pattern (the one that
  // is NOT the const sentinel).
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[key])) {
      for (const branch of schema[key]) {
        if (typeof branch?.pattern === "string" && branch.const === undefined) return branch.pattern;
      }
    }
  }
  return typeof schema.pattern === "string" ? schema.pattern : null;
}

function realMax(schema) {
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[key])) {
      for (const branch of schema[key]) {
        if (typeof branch?.maxLength === "number" && branch.const === undefined) return branch.maxLength;
      }
    }
  }
  return typeof schema.maxLength === "number" ? schema.maxLength : null;
}
