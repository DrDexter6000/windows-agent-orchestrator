// test/playbookCli.test.js
//
// M11-2B: Lead Playbook Catalog CLI adapter (playbook list / playbook show).
//
// Proves that the CLI delegates to the same application service as the MCP
// adapter, formats text and JSON output, handles unknown/malformed ids via the
// M11-2A fixed typed error, and produces JSON that is deeply equal to the MCP
// structuredContent (B08/B09 parity).
//
// The CLI command is imported directly (in-process) so the tests can capture
// console.log without spawning a subprocess. The CLI's only responsibilities
// are argv handling, formatting, and console output — all data logic lives in
// the application service.

import { test } from "node:test";
import assert from "node:assert/strict";

import { playbookCommand } from "../src/commands/playbook.js";
import { listLeadPlaybooks, getLeadPlaybook } from "../src/application/playbookCatalog.js";

// ===== Helpers =====

const KNOWN_ID = "single-coder-delivery";

/** Capture console.log output. */
async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map(String).join("\t")); };
  try { await fn(); }
  finally { console.log = orig; }
  return lines;
}

// =====================================================================
// PB-B08a: playbook list --format json delegates to listLeadPlaybooks and
// emits { playbooks: [...] }.
// =====================================================================

test("PB-B08a: playbook list --format json emits { playbooks: [...] }", async () => {
  const out = await captureLog(() => playbookCommand(["list", "--format", "json"], {}));
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed.playbooks), "playbooks array");
  assert.equal(parsed.playbooks.length, 4, "four built-ins");
  // Deep equality with the direct service output (CLI must not transform data).
  assert.deepEqual(parsed.playbooks, listLeadPlaybooks(),
    "CLI json playbooks deeply equal direct service output");
  // Each entry has exactly the five summary keys.
  for (const e of parsed.playbooks) {
    assert.deepEqual(Object.keys(e).sort(),
      ["id", "lanePattern", "summary", "title", "version"]);
  }
});

// =====================================================================
// PB-B08b: playbook list text format is the stable simple shape
// id<TAB>lanePattern<TAB>title<TAB>summary.
// =====================================================================

test("PB-B08b: playbook list text format is id<TAB>lanePattern<TAB>title<TAB>summary", async () => {
  const out = await captureLog(() => playbookCommand(["list"], {}));
  const lines = out;
  // One line per built-in (no header, no trailing blank).
  assert.equal(lines.length, 4, "four text lines, no header");
  for (let i = 0; i < lines.length; i += 1) {
    const cols = lines[i].split("\t");
    assert.equal(cols.length, 4, `line ${i}: exactly 4 tab-separated columns`);
    assert.ok(cols[0].length > 0, "id non-empty");
    assert.ok(cols[1].length > 0, "lanePattern non-empty");
    assert.ok(cols[2].length > 0, "title non-empty");
    assert.ok(cols[3].length > 0, "summary non-empty");
  }
  // Order matches listLeadPlaybooks (the service's stable order).
  const ids = lines.map((l) => l.split("\t")[0]);
  assert.deepEqual(ids, listLeadPlaybooks().map((p) => p.id), "text order matches service");
});

// =====================================================================
// PB-B08c: playbook show <id> --format json emits { playbook: {...} } and the
// full playbook equals the direct service output.
// =====================================================================

test("PB-B08c: playbook show --format json emits { playbook: {...} } full playbook", async () => {
  const out = await captureLog(() =>
    playbookCommand(["show", KNOWN_ID, "--format", "json"], {}));
  const parsed = JSON.parse(out);
  assert.ok(parsed.playbook, "playbook object present");
  assert.deepEqual(parsed.playbook, getLeadPlaybook({ id: KNOWN_ID }),
    "CLI json playbook deeply equal direct service output");
});

// =====================================================================
// PB-B08d: playbook show <id> text format emits the full playbook as pretty
// JSON (one algorithm — no second summary algorithm).
// =====================================================================

test("PB-B08d: playbook show text format emits full playbook pretty JSON", async () => {
  const out = await captureLog(() => playbookCommand(["show", KNOWN_ID], {}));
  // The text output is the full playbook serialized as pretty JSON.
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, getLeadPlaybook({ id: KNOWN_ID }),
    "text pretty JSON equals full playbook");
});

// =====================================================================
// PB-B08e: unknown/malformed id uses the M11-2A fixed typed error; no raw
// catalog/path content is surfaced.
// =====================================================================

test("PB-B08e: unknown id raises PlaybookNotFoundError via the CLI", async () => {
  // Unknown-but-valid-shaped id: the service throws PlaybookNotFoundError.
  await assert.rejects(
    () => playbookCommand(["show", "definitely-not-a-real-playbook-id"], {}),
    (err) => {
      assert.equal(err.name, "PlaybookNotFoundError");
      assert.equal(err.code, "PLAYBOOK_NOT_FOUND");
      // Fixed message; must not echo the caller's id.
      assert.equal(err.message, "Playbook not found");
      return true;
    },
  );
});

test("PB-B08f: malformed id raises PlaybookValidationError via the CLI", async () => {
  // Uppercase is not valid kebab; the service throws PlaybookValidationError.
  await assert.rejects(
    () => playbookCommand(["show", "UPPER_CASE"], {}),
    (err) => {
      assert.equal(err.name, "PlaybookValidationError");
      assert.equal(err.code, "PLAYBOOK_VALIDATION_ERROR");
      return true;
    },
  );
});

// =====================================================================
// PB-B09: CLI JSON output is deeply equal to MCP structuredContent.
// (Parity between the two adapters over the same service.)
// =====================================================================

test("PB-B09: CLI JSON output is deeply equal to MCP structuredContent", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  const server = createWaoMcpServer({ registryPath: "/x", runDir: "/x" });
  const client = new Client({ name: "wao-parity", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    // list parity
    const mList = await client.callTool({ name: "playbook_list", arguments: {} });
    const cliList = JSON.parse(await captureLog(() =>
      playbookCommand(["list", "--format", "json"], {})));
    assert.deepEqual(cliList, mList.structuredContent,
      "CLI list JSON deeply equal MCP structuredContent");

    // get parity (for each built-in id)
    const ids = mList.structuredContent.playbooks.map((p) => p.id);
    for (const id of ids) {
      const mGet = await client.callTool({ name: "playbook_get", arguments: { id } });
      const cliGet = JSON.parse(await captureLog(() =>
        playbookCommand(["show", id, "--format", "json"], {})));
      assert.deepEqual(cliGet, mGet.structuredContent,
        `CLI/MCP get JSON deeply equal for ${id}`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// PB-B09b: show without an id is a clear CLI usage error (not a silent pass
// to the service).
// =====================================================================

test("PB-B09b: playbook show without id raises a usage error", async () => {
  await assert.rejects(
    () => playbookCommand(["show"], {}),
    (err) => {
      assert.ok(/id/i.test(err.message), "error mentions id");
      return true;
    },
  );
});

// =====================================================================
// PB-B09c: unknown subcommand is a clear CLI error.
// =====================================================================

test("PB-B09c: unknown playbook subcommand raises a usage error", async () => {
  await assert.rejects(
    () => playbookCommand(["frobnicate"], {}),
    (err) => /playbook/i.test(err.message),
  );
});
