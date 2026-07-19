// test/mcpPlaybook.test.js
//
// M11-2B: Lead Playbook Catalog MCP adapters (playbook_list / playbook_get).
//
// Proves that a real MCP host can, over the in-memory MCP transport, call WAO's
// two read-only Lead playbook tools and receive exactly the M11-2A application
// service output (projected + schema-validated). Covers: discovery includes
// list/get and excludes any executor surface (B01, B11); strict empty input for
// list and strict kebab id input for get (B02, B03); complete output schemas
// with exact bounds (B04); fixed-error collapse on malformed/oversized/unknown-
// key service payloads with no raw-value leak (B05); precise read-only
// annotations (B06); no workspace binding and no transcript/run file dependency
// (B07); CLI/MCP JSON parity is asserted in playbookCli.test.js (B08/B09);
// MCP does not shell out and the application service keeps zero adapter reverse
// dependency (B10); existing workflow CLI tests unchanged (B12 — covered by
// running the existing workflow suite in the canonical npm test).
//
// Dependencies note: this test file imports the MCP SDK client/in-memory
// transport (allowed — MCP-specific tests). src/application/** must NOT.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWaoMcpServer } from "../src/mcp/server.js";
import { listLeadPlaybooks, getLeadPlaybook } from "../src/application/playbookCatalog.js";

// ===== Helpers =====

/**
 * Build an in-memory server+client pair (no subprocess). Returns the connected
 * client. The caller owns cleanup (close both client and server).
 */
async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-m11-2b-client", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** A valid real built-in id used across tests. */
const KNOWN_ID = "single-coder-delivery";

// =====================================================================
// PB-B01: discovery includes playbook_list and playbook_get.
// =====================================================================

test("PB-B01: listTools includes playbook_list and playbook_get", async () => {
  const server = createWaoMcpServer({ registryPath: "/x", runDir: "/x" });
  const client = await buildInMemoryClient(server);
  try {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    assert.ok(names.includes("playbook_list"), "playbook_list exposed");
    assert.ok(names.includes("playbook_get"), "playbook_get exposed");
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// PB-B11: discovery exposes NO executor surface (run/start/next/recommend).
// =====================================================================

test("PB-B11: no playbook_run/start/next/recommend tool is exposed", async () => {
  const server = createWaoMcpServer({ registryPath: "/x", runDir: "/x" });
  const client = await buildInMemoryClient(server);
  try {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    const forbidden = names.filter((n) =>
      ["playbook_run", "playbook_start", "playbook_next", "playbook_recommend"].includes(n),
    );
    assert.deepEqual(forbidden, [], "no executor/recommendation surface exposed");
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// PB-B02: playbook_list requires a strict empty object; extra keys do not
// reach the service (service count stays 0), and a valid call returns the
// bounded summary array.
// =====================================================================

test("PB-B02: playbook_list strict empty input; extra key keeps service call count 0", async () => {
  let callCount = 0;
  const fakeList = () => { callCount += 1; return listLeadPlaybooks(); };
  const server = createWaoMcpServer({
    registryPath: "/x", runDir: "/x", listLeadPlaybooksFn: fakeList,
  });
  const client = await buildInMemoryClient(server);
  try {
    // Extra key must be rejected by the protocol layer before the service runs.
    // The MCP SDK returns this as an error RESULT (isError:true), not a throw.
    // Either way, the key invariant is: the service is never invoked.
    const extraRes = await client.callTool({
      name: "playbook_list", arguments: { unexpected: 1 },
    }).catch((e) => ({ isError: true, _caught: e }));
    assert.equal(extraRes.isError, true, "extra key rejected (error result)");
    assert.equal(callCount, 0, "service NOT invoked for rejected extra-key input");

    // Valid empty-object call reaches the service exactly once.
    const res = await client.callTool({ name: "playbook_list", arguments: {} });
    assert.equal(callCount, 1, "service invoked exactly once for empty input");
    assert.equal(res.isError, undefined, "valid list is not an error");
    assert.ok(Array.isArray(res.content), "content present");

    // Structured content: { playbooks: [{id,version,title,summary,lanePattern}] }.
    assert.ok(res.structuredContent, "structuredContent present");
    const pb = res.structuredContent.playbooks;
    assert.ok(Array.isArray(pb), "playbooks is array");
    assert.equal(pb.length, 4, "exactly four built-ins");
    const sample = pb[0];
    assert.deepEqual(
      Object.keys(sample).sort(),
      ["id", "lanePattern", "summary", "title", "version"],
      "summary entry has exactly the five bounded keys",
    );
    assert.equal(sample.version, 1, "version is 1");
    assert.equal(typeof sample.lanePattern, "string", "lanePattern is string");
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// PB-B03: playbook_get input is strict; required kebab id 1..64; extra key
// rejected; malformed/oversized id rejected — none reach the service.
// =====================================================================

test("PB-B03: playbook_get input strict kebab id; malformed/oversized/extra rejected pre-service", async () => {
  let callCount = 0;
  const fakeGet = ({ id }) => { callCount += 1; return getLeadPlaybook({ id }); };
  const server = createWaoMcpServer({
    registryPath: "/x", runDir: "/x", getLeadPlaybookFn: fakeGet,
  });
  const client = await buildInMemoryClient(server);
  try {
    const badIds = [
      "",                       // empty
      "UPPER",                  // uppercase
      "has space",              // space
      "trailing-",              // trailing hyphen
      "double--hyphen",         // double hyphen
      "a".repeat(65),           // >64 chars
      "under_score",            // underscore
    ];
    for (const id of badIds) {
      // The MCP SDK returns input-validation failures as error RESULTS
      // (isError:true), not throws. The invariant under test is: the service
      // is never invoked for a malformed id.
      const res = await client.callTool({
        name: "playbook_get", arguments: { id },
      }).catch(() => ({ isError: true }));
      assert.equal(res.isError, true, `id ${JSON.stringify(id)} rejected before service`);
    }
    assert.equal(callCount, 0, "no malformed id reached the service");

    // Missing id entirely must also be rejected pre-service.
    const missingRes = await client.callTool({
      name: "playbook_get", arguments: {},
    }).catch(() => ({ isError: true }));
    assert.equal(missingRes.isError, true, "missing id rejected before service");
    assert.equal(callCount, 0, "missing id did not reach service");

    // Extra key alongside a valid id must be rejected pre-service.
    const extraRes = await client.callTool({
      name: "playbook_get",
      arguments: { id: KNOWN_ID, extra: 1 },
    }).catch(() => ({ isError: true }));
    assert.equal(extraRes.isError, true, "extra key rejected before service");
    assert.equal(callCount, 0, "extra key did not reach service");

    // A valid-shaped but unknown id reaches the service, which returns NotFound;
    // the MCP layer collapses it to the fixed error (asserted in B05).
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// PB-B04: both output schemas are complete and enforce exact bounds — a
// well-formed service payload passes, and the live schemas are advertised
// on the tool definitions.
// =====================================================================

test("PB-B04: playbook_list/get output schemas are advertised and bound the payload", async () => {
  const server = createWaoMcpServer({ registryPath: "/x", runDir: "/x" });
  const client = await buildInMemoryClient(server);
  try {
    const { tools } = await client.listTools();
    const listTool = tools.find((t) => t.name === "playbook_list");
    const getTool = tools.find((t) => t.name === "playbook_get");
    assert.ok(listTool.outputSchema, "playbook_list advertises outputSchema");
    assert.ok(getTool.outputSchema, "playbook_get advertises outputSchema");

    // The list output schema must describe { playbooks: [...] }.
    const listProps = listTool.outputSchema.properties ?? {};
    assert.ok(listProps.playbooks, "list schema has playbooks");
    // The get output schema must describe { playbook: {...} }.
    const getProps = getTool.outputSchema.properties ?? {};
    assert.ok(getProps.playbook, "get schema has playbook");

    // Live call returns a payload that satisfies the advertised schema shape.
    const listRes = await client.callTool({ name: "playbook_list", arguments: {} });
    const listSC = listRes.structuredContent;
    assert.ok(Array.isArray(listSC.playbooks), "list structuredContent.playbooks is array");
    for (const entry of listSC.playbooks) {
      assert.equal(typeof entry.id, "string");
      assert.equal(entry.version, 1);
      assert.equal(typeof entry.title, "string");
      assert.equal(typeof entry.summary, "string");
      assert.equal(typeof entry.lanePattern, "string");
    }

    const getRes = await client.callTool({ name: "playbook_get", arguments: { id: KNOWN_ID } });
    const getSC = getRes.structuredContent;
    assert.ok(getSC.playbook, "get structuredContent.playbook present");
    const pb = getSC.playbook;
    // Complete PlaybookV1 fields are present (the projection does not strip).
    for (const key of ["id", "version", "title", "summary", "useWhen", "avoidWhen",
      "lanePattern", "roles", "phases", "completionEvidence", "escalation"]) {
      assert.ok(key in pb, `playbook has ${key}`);
    }
    assert.equal(pb.id, KNOWN_ID);
    assert.equal(pb.version, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// PB-B05: service returning a malformed / oversized / unknown-key payload,
// or throwing, collapses to a fixed typed error with no raw value leak.
// =====================================================================

test("PB-B05: malformed/oversized/unknown-key/throwing service collapses to fixed error, no leak", async () => {
  // A sentinel that must NEVER appear in any MCP result.
  const SECRET = "test-secret-sentinel-pb-b05";

  const cases = [
    {
      label: "list throws",
      listFn: () => { const e = new Error("boom"); e.token = SECRET; throw e; },
      getFn: null,
      tool: "playbook_list", args: {},
      fixedText: "playbook_list failed",
    },
    {
      label: "list returns malformed (not array)",
      listFn: () => ({ not: "an array", secret: SECRET }),
      getFn: null,
      tool: "playbook_list", args: {},
      fixedText: "playbook_list failed",
    },
    {
      label: "get throws",
      listFn: null,
      getFn: () => { const e = new Error("boom"); e.token = SECRET; throw e; },
      tool: "playbook_get", args: { id: KNOWN_ID },
      fixedText: "playbook_get failed",
    },
    {
      label: "get returns unknown-key payload",
      listFn: null,
      getFn: () => ({ id: KNOWN_ID, version: 1, title: "x", summary: "y", lanePattern: "single",
        useWhen: ["a"], avoidWhen: ["b"], roles: [], phases: [], completionEvidence: ["c"],
        escalation: { advisor: "d", auditor: "e" }, secret: SECRET }),
      tool: "playbook_get", args: { id: KNOWN_ID },
      fixedText: "playbook_get failed",
    },
  ];

  for (const c of cases) {
    const server = createWaoMcpServer({
      registryPath: "/x", runDir: "/x",
      ...(c.listFn ? { listLeadPlaybooksFn: c.listFn } : {}),
      ...(c.getFn ? { getLeadPlaybookFn: c.getFn } : {}),
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: c.tool, arguments: c.args });
      assert.equal(res.isError, true, `${c.label}: result flagged error`);
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes(SECRET), `${c.label}: secret must not leak`);
      const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.equal(text, c.fixedText, `${c.label}: fixed error text`);
      assert.ok(!/at .*\(.+:\d+:\d+\)/.test(text), `${c.label}: no stack frame leaked`);
      // The fixed error must not echo the request id or any catalog content.
      if (c.tool === "playbook_get") {
        // The known id is also a catalog id, so we only assert no SECRET; the id
        // itself is caller-supplied and may legitimately appear in the request,
        // but the fixed text must be exactly the constant (already asserted).
      }
    } finally {
      await client.close();
      await server.close();
    }
  }
});

// =====================================================================
// PB-B06: both tools advertise precise read-only annotations.
// =====================================================================

test("PB-B06: playbook_list/get annotations are precisely read-only", async () => {
  const server = createWaoMcpServer({ registryPath: "/x", runDir: "/x" });
  const client = await buildInMemoryClient(server);
  try {
    const { tools } = await client.listTools();
    const expected = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
    for (const name of ["playbook_list", "playbook_get"]) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool.annotations, `${name} has annotations`);
      assert.deepEqual(tool.annotations, expected, `${name} annotations precise`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// PB-B07: no workspace binding and no run/transcript file dependency — the
// tools work without any registry, runDir, workspace root, or roots capability.
// =====================================================================

test("PB-B07: playbook tools work without workspace binding, registry, or run files", async () => {
  // Empty temp runDir; the tools must not create any files in it and must not
  // require a roots capability from the client.
  const dir = mkdtempSync(join(tmpdir(), "wao-m11-2b-b07-"));
  try {
    const server = createWaoMcpServer({ registryPath: "/nonexistent", runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const before = new Set(readdirSync(dir));

      const listRes = await client.callTool({ name: "playbook_list", arguments: {} });
      assert.equal(listRes.isError, undefined, "list succeeds without workspace");
      assert.equal(listRes.structuredContent.playbooks.length, 4, "list returns four");

      const getRes = await client.callTool({
        name: "playbook_get", arguments: { id: KNOWN_ID },
      });
      assert.equal(getRes.isError, undefined, "get succeeds without workspace");
      assert.equal(getRes.structuredContent.playbook.id, KNOWN_ID, "get returns the id");

      const after = new Set(readdirSync(dir));
      const added = [...after].filter((f) => !before.has(f));
      assert.deepEqual(added, [], "no run/transcript files created in runDir");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// =====================================================================
// PB-B10: the application service keeps ZERO adapter reverse dependency, and
// the MCP adapter does not shell out. (Static import-boundary guard.)
// =====================================================================

test("PB-B10: application service has no MCP/CLI/SDK reverse dependency", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const serviceSrc = readFileSync(
    fileURLToPath(new URL("../src/application/playbookCatalog.js", import.meta.url)),
    "utf8",
  );
  // The service must not import the adapter layer, MCP SDK, zod, or commands.
  const forbidden = [
    /from\s+["']\.\.\/mcp\b/,
    /from\s+["']\.\.\/\.\.\/src\/mcp\b/,
    /from\s+["']\.\.\/commands\b/,
    /@modelcontextprotocol/,
    /from\s+["']zod["']/,
    /from\s+["']node:child_process["']/,
  ];
  for (const re of forbidden) {
    assert.ok(!re.test(serviceSrc), `service must not match ${re}`);
  }

  // The MCP adapter may import the SDK and the service, but must NOT shell out.
  const mcpSrc = readFileSync(
    fileURLToPath(new URL("../src/mcp/server.js", import.meta.url)),
    "utf8",
  );
  // Shelling out would require child_process; the adapter does not import it.
  assert.ok(!/from\s+["']node:child_process["']/.test(mcpSrc),
    "MCP adapter does not shell out (no child_process import)");
  // The adapter must delegate playbook data to the application service.
  assert.ok(/playbookCatalog\.js/.test(mcpSrc),
    "MCP adapter imports the application playbook service");
});
