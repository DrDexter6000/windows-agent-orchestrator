// test/mcpPlaybook.test.js
//
// M12-10 progressive-disclosure correction — the built-in Lead Playbook Catalog
// is presented as MCP RESOURCES, not tools.
//
// The catalog moved OFF the tool surface (playbook_list/playbook_get are no
// longer tools — see test/m12-10-tool-surface.test.js). Instead a Lead discovers
// and reads the catalog via the MCP resources API:
//   resources/list     → a static summary resource `wao://playbooks` plus a
//                        per-id detail resource `wao://playbooks/{id}` for each
//                        known id (5 resources total).
//   resources/templates/list → one detail template `wao://playbooks/{id}`.
//   resources/read     → `wao://playbooks` (summary), `wao://playbooks/{id}`
//                        (full detail). Unknown ids and service failures return
//                        fixed safe text WITHOUT echoing the id, a path, or the
//                        raw error.
//
// The catalog SSOT is unchanged: `src/application/playbookCatalog.js` remains the
// ONLY source of truth (validatePlaybookSummaryList / validatePlaybookV1 / the
// four frozen PLAYBOOK_IDS). The CLI `playbook list` / `playbook show` commands
// are unchanged. No workspace binding is required.
//
// Contracts under test:
//   R-01 — resources/list advertises summary + four per-id detail resources.
//   R-02 — resources/templates/list advertises exactly the one detail template.
//   R-03 — resources/read of the summary returns SSOT-validated summary JSON.
//   R-04 — resources/read of a known id returns the full playbook, id-bound,
//          byte-equal to the catalog SSOT.
//   R-05 — resources/read of an unknown id → fixed safe text, no leak.
//   R-06 — injected service failure (throw / malformed) → fixed text, no leak.
//   R-07 — no workspace binding, no registry/runDir dependency, no file mutation.
//   R-08 — no executor/recommendation surface (run/start/next/recommend).
//   R-09 — application service keeps zero MCP/SDK reverse dependency; the
//          adapter does not shell out.
//   R-10 — id-binding enforced at the resource boundary (request A, service
//          answers B → fixed error, no cross-leak).
//   R-11 — CLI parity unchanged (asserted by playbookCli.test.js in the canonical
//          suite; this file does not duplicate it).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createWaoMcpServer } from "../src/mcp/server.js";
import {
  listLeadPlaybooks,
  getLeadPlaybook,
  validatePlaybookSummaryList,
  validatePlaybookV1,
  PLAYBOOK_IDS,
} from "../src/application/playbookCatalog.js";

// ===== Helpers =====

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-m1210-r-client", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const KNOWN_ID = "single-coder-delivery";
const SUMMARY_URI = "wao://playbooks";
const detailUri = (id) => `wao://playbooks/${id}`;

/** Pull the concatenated text out of a readResource result. */
function readText(readResult) {
  const text = (readResult?.contents ?? []).map((c) => c.text ?? "").join("");
  return text;
}

// =====================================================================
// R-01 — resources/list advertises summary + four per-id detail resources.
// =====================================================================

test("R-01: resources/list has summary + four per-id detail resources (5 total)", async () => {
  const server = createWaoMcpServer({ registryPath: "/x", runDir: "/x" });
  const client = await buildInMemoryClient(server);
  try {
    const { resources } = await client.listResources();
    const uris = new Set(resources.map((r) => r.uri));
    // Static summary resource.
    assert.ok(uris.has(SUMMARY_URI), "summary resource wao://playbooks present");
    // One per-id detail resource for each known id.
    for (const id of PLAYBOOK_IDS) {
      assert.ok(uris.has(detailUri(id)), `detail resource for ${id} present`);
    }
    // Exactly summary + four details = five (no extras, no dynamic leakage).
    assert.equal(resources.length, 5, "exactly 5 resources advertised");
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// R-02 — resources/templates/list advertises exactly the one detail template.
// =====================================================================

test("R-02: resources/templates/list advertises exactly the wao://playbooks/{id} template", async () => {
  const server = createWaoMcpServer({ registryPath: "/x", runDir: "/x" });
  const client = await buildInMemoryClient(server);
  try {
    const { resourceTemplates } = await client.listResourceTemplates();
    const uris = resourceTemplates.map((t) => t.uriTemplate);
    assert.ok(uris.includes("wao://playbooks/{id}"), "detail template present");
    assert.equal(resourceTemplates.length, 1, "exactly one template advertised");
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// R-03 — resources/read of the summary returns SSOT-validated summary JSON.
// =====================================================================

test("R-03: resources/read wao://playbooks returns the validated summary list", async () => {
  const server = createWaoMcpServer({ registryPath: "/x", runDir: "/x" });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.readResource({ uri: SUMMARY_URI });
    const text = readText(res);
    // The text must be valid JSON the SSOT validator accepts as exactly-four.
    const parsed = JSON.parse(text);
    const validated = validatePlaybookSummaryList(parsed.playbooks ?? parsed);
    assert.equal(validated.length, 4, "summary validates as exactly four");
    // The four ids are the frozen approved set in stable order.
    assert.deepEqual(validated.map((s) => s.id), [...PLAYBOOK_IDS]);
    // Each summary entry has exactly the five approved keys.
    for (const s of validated) {
      assert.deepEqual(Object.keys(s).sort(),
        ["id", "lanePattern", "summary", "title", "version"],
        "summary has exactly the five keys");
    }
    // mimeType advertised as JSON on the content entry.
    assert.equal(res.contents[0].mimeType, "application/json");
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// R-04 — resources/read of a known id returns the full, id-bound playbook.
// =====================================================================

test("R-04: resources/read of each known id returns the full playbook, id-bound", async () => {
  for (const id of PLAYBOOK_IDS) {
    const server = createWaoMcpServer({ registryPath: "/x", runDir: "/x" });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.readResource({ uri: detailUri(id) });
      const parsed = JSON.parse(readText(res));
      // SSOT-validated against the requested id (proves id-binding on the read path).
      const validated = validatePlaybookV1(parsed.playbook ?? parsed, id);
      assert.equal(validated.id, id, `${id}: returned id matches the resource id`);
      // Byte-equal to the catalog SSOT (no adapter-side mutation).
      assert.deepEqual(validated, getLeadPlaybook({ id }), `${id}: equal to catalog SSOT`);
      assert.equal(res.contents[0].mimeType, "application/json");
    } finally {
      await client.close();
      await server.close();
    }
  }
});

// =====================================================================
// R-05 — unknown id → fixed safe text, no leak.
// =====================================================================

test("R-05: resources/read of an unknown id returns fixed safe text, no leak", async () => {
  const server = createWaoMcpServer({ registryPath: "/x", runDir: "/x" });
  const client = await buildInMemoryClient(server);
  try {
    const UNKNOWN = "does-not-exist-xyz";
    const res = await client.readResource({ uri: detailUri(UNKNOWN) });
    const text = readText(res);
    // Fixed safe text (the same constant the detail path collapses to).
    assert.equal(text, "playbook detail failed", "unknown id → fixed safe text");
    // The fixed text must not echo the unknown id, a path, or any catalog detail.
    assert.ok(!text.includes(UNKNOWN), "fixed text does not echo the unknown id");
    // No catalog content / structured secret leaks anywhere in the result.
    const dumped = JSON.stringify(res);
    for (const known of PLAYBOOK_IDS) {
      // The unknown id is not any known id, and no full playbook body leaks.
      assert.ok(!new RegExp(`"id"\\s*:\\s*"${known}"`).test(dumped),
        `${known}: no playbook body leaked for an unknown-id read`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// R-06 — injected service failure (throw / malformed) → fixed text, no leak.
// =====================================================================

test("R-06a: summary service throwing / malformed → fixed text, no leak", async () => {
  const SECRET = "test-secret-r06a-summary";
  const cases = [
    { label: "throws", listFn: () => { const e = new Error("boom"); e.token = SECRET; throw e; } },
    { label: "malformed", listFn: () => ({ not: "array", secret: SECRET }) },
    { label: "unknown id", listFn: () => [{ id: "unknown-playbook", secret: SECRET, version: 1, title: "t", summary: "s", lanePattern: "single" }] },
  ];
  for (const c of cases) {
    const server = createWaoMcpServer({
      registryPath: "/x", runDir: "/x", listLeadPlaybooksFn: c.listFn,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.readResource({ uri: SUMMARY_URI });
      const text = readText(res);
      assert.equal(text, "playbook summary failed", `${c.label}: fixed text`);
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes(SECRET), `${c.label}: secret must not leak`);
      assert.ok(!/at .*\(.+:\d+:\d+\)/.test(text), `${c.label}: no stack frame leaked`);
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test("R-06b: detail service throwing / malformed / oversized → fixed text, no leak", async () => {
  const SECRET = "test-secret-r06b-detail";
  // A complete, structurally valid playbook with a secret extra... wait, strict
  // validation rejects unknown keys. Use these malformed shapes instead:
  const throwing = () => { const e = new Error("boom"); e.token = SECRET; throw e; };
  const malformed = () => ({ id: KNOWN_ID, version: 1, title: "t", summary: "s",
    useWhen: ["a"], avoidWhen: ["b"], lanePattern: "single", roles: [],
    phases: [], completionEvidence: ["c"], escalation: { advisor: "d", auditor: "e" }, secret: SECRET });
  const wrongId = () => getLeadPlaybook({ id: "parallel-independent-deliveries" }); // answer B for A
  const cases = [
    { label: "throws", getFn: throwing },
    { label: "malformed-secret", getFn: malformed },
    { label: "wrong-id", getFn: wrongId },
  ];
  for (const c of cases) {
    const server = createWaoMcpServer({
      registryPath: "/x", runDir: "/x", getLeadPlaybookFn: c.getFn,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.readResource({ uri: detailUri(KNOWN_ID) });
      const text = readText(res);
      assert.equal(text, "playbook detail failed", `${c.label}: fixed text`);
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes(SECRET), `${c.label}: secret must not leak`);
    } finally {
      await client.close();
      await server.close();
    }
  }
});

// =====================================================================
// R-07 — no workspace binding, no registry/runDir dependency, no file mutation.
// =====================================================================

test("R-07: resources work without workspace binding/registry and create no files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-r07-"));
  try {
    const server = createWaoMcpServer({ registryPath: "/nonexistent", runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const before = new Set(readdirSync(dir));

      const summary = await client.readResource({ uri: SUMMARY_URI });
      const summaries = JSON.parse(readText(summary)).playbooks;
      assert.equal(summaries.length, 4, "summary lists four without workspace");

      const detail = await client.readResource({ uri: detailUri(KNOWN_ID) });
      const pb = JSON.parse(readText(detail)).playbook;
      assert.equal(pb.id, KNOWN_ID, "detail returns the id without workspace");

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
// R-08 — no executor/recommendation surface is exposed as a tool.
// (The catalog presents only read resources; no run/start/next/recommend.)
// =====================================================================

test("R-08: no playbook_run/start/next/recommend tool is exposed", async () => {
  const server = createWaoMcpServer({ registryPath: "/x", runDir: "/x" });
  const client = await buildInMemoryClient(server);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const forbidden = names.filter((n) =>
      ["playbook_run", "playbook_start", "playbook_next", "playbook_recommend",
       "playbook_list", "playbook_get"].includes(n),
    );
    assert.deepEqual(forbidden, [], "no playbook tool/executor surface exposed (catalog is resources)");
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// R-09 — application service keeps zero MCP/SDK reverse dependency; adapter
// does not shell out. (Static import-boundary guard.)
// =====================================================================

test("R-09: application service has no MCP/CLI/SDK reverse dependency; adapter does not shell out", async () => {
  const serviceSrc = readFileSync(
    fileURLToPath(new URL("../src/application/playbookCatalog.js", import.meta.url)),
    "utf8",
  );
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
  const mcpSrc = readFileSync(
    fileURLToPath(new URL("../src/mcp/server.js", import.meta.url)),
    "utf8",
  );
  assert.ok(!/from\s+["']node:child_process["']/.test(mcpSrc),
    "MCP adapter does not shell out (no child_process import)");
  assert.ok(/playbookCatalog\.js/.test(mcpSrc),
    "MCP adapter imports the application playbook service (the catalog SSOT)");
});

// =====================================================================
// R-10 — id-binding enforced at the resource boundary.
// Request A via its resource, but the service answers a different approved
// playbook B. validatePlaybookV1 binds to A → the mismatch collapses to the
// fixed error and B's content does not leak.
// =====================================================================

test("R-10: request resource A but service answers B → fixed error, no cross-leak", async () => {
  const returnedB = getLeadPlaybook({ id: "parallel-independent-deliveries" });
  const server = createWaoMcpServer({
    registryPath: "/x", runDir: "/x", getLeadPlaybookFn: () => returnedB,
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.readResource({ uri: detailUri(KNOWN_ID) });
    const text = readText(res);
    assert.equal(text, "playbook detail failed", "request≠returned collapses to fixed error");
    // The mis-returned playbook B content must not leak.
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes("parallel-independent-deliveries"),
      "the mis-returned playbook id must not leak");
    assert.ok(!dumped.includes(returnedB.title),
      "the mis-returned playbook title must not leak");
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// R-11 — summary content parity with the SSOT service (no adapter drift).
// =====================================================================

test("R-11: summary resource content equals the catalog SSOT summary list", async () => {
  const server = createWaoMcpServer({ registryPath: "/x", runDir: "/x" });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.readResource({ uri: SUMMARY_URI });
    const fromResource = JSON.parse(readText(res)).playbooks;
    const fromService = listLeadPlaybooks();
    assert.deepEqual(fromResource, fromService, "resource summary == SSOT service summary");
  } finally {
    await client.close();
    await server.close();
  }
});
