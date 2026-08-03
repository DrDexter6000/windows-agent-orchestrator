// test/m12-10-tool-surface.test.js
//
// M12-10 progressive-disclosure correction — the FROZEN tool surface.
//
// WAO exposes EXACTLY 21 always-registered MCP tools. There is NO tool-profile
// model, NO startup flag, and NO restart-to-recover: every operational tool is
// independently callable for the lifetime of the connection. The built-in
// playbook catalog moved OFF the tool surface entirely (it is presented as MCP
// resources — see test/mcpPlaybook.test.js). What used to be the two playbook
// tools (`playbook_list`, `playbook_get`) are no longer tools at all; the
// remaining 21 are the former 23 minus those two.
//
// This is a PRESENTATION/TRUTH lock, not a permission or routing layer. There
// is no branching on Host/runtime name, no `tools/list_changed` dependency, and
// no dynamic registration — the 21 tools are registered unconditionally at
// server construction.
//
// Contracts under test:
//   A — tools/list returns EXACTLY the deterministic 21-tool set, in the frozen
//       registration order, with NO `playbook_list`/`playbook_get` and NO
//       profile-driven variance.
//   B — the three tools the old `lead` profile HID (`workspace_select`,
//       `run_dispatch_contract_check`, `run_wait`) are now advertised AND their
//       handlers are reached on call (not "not found"); every tool is callable.
//   C — the toolProfile model is GONE: `createWaoMcpServer({toolProfile})` does
//       not throw and does not change the 21-tool surface for ANY value.
//   D — stdio `parseMcpArgs` IGNORES legacy `--tool-profile` as an ordinary
//       unknown flag (no parse, no output key, no throw); the legacy
//       `--registry`/`--run-dir`/`--workspace-root` parsing is byte-unchanged.
//   E — `src/mcp/toolSurface.js` is the single frozen SSOT (21 names, frozen,
//       unique, registration order); every DRILLDOWN_TOOLS carrier is a member.
//   F — `src/mcp/toolProfiles.js` is DELETED (the profile model is gone).
//   G — compacted descriptions retain the key semantic guards.
//   H — no-model wire measurement: deterministic 21-tool wire, bounded by a
//       frozen ceiling (regression protection), and honestly recorded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

// ---- Frozen closed set (the contract) ----

// Registration order exactly as emitted by tools/list. The former 23-tool full
// set MINUS playbook_list + playbook_get (the catalog is now resources).
const TOOL_SET = Object.freeze([
  "registry_list", "workspace_status", "workspace_select", "lead_preflight",
  "run_dispatch", "run_dispatch_contract_check", "run_continue", "run_status",
  "run_collect", "run_diagnose", "run_delivery", "run_delivery_decide",
  "run_stop", "runs_list", "run_wait", "run_await_result", "run_activity",
  "run_delivery_review", "run_delivery_review_bundle", "run_delivery_repackage",
  "run_delivery_reverify",
]);

// The two former playbook tools that MUST NOT appear on the tool surface.
const REMOVED_PLAYBOOK_TOOLS = Object.freeze(["playbook_list", "playbook_get"]);

// The three tools the old `lead` profile hid. They must now be advertised and
// callable (the profile model is reversed).
const FORMERLY_HIDDEN = Object.freeze([
  "workspace_select", "run_dispatch_contract_check", "run_wait",
]);

// ---- harness ----

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
    JSON.stringify({ agents: { coder_low: { backend: "claude-code", cwd: dir } } }),
    "utf8",
  );
  return registryPath;
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

function byteLen(s) {
  return Buffer.byteLength(s ?? "", "utf8");
}

function notFound(res) {
  // SDK returns a non-throwing, fixed fail-closed result for an unregistered tool.
  return res?.isError === true
    && Array.isArray(res.content)
    && /Tool .* not found/i.test(res.content.map((c) => c.text || "").join(" "));
}

// =====================================================================
// A — exact deterministic 21-tool set, no playbook tools, no profile variance
// =====================================================================

test("M12-10-A1: tools/list returns exactly the 21-tool set in deterministic order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-a1-"));
  try {
    makeGitRepo(dir);
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      assert.deepEqual(names, TOOL_SET, "exactly the 21-tool set in registration order");
      assert.equal(names.length, 21, "exactly 21");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-10-A2: no playbook_list / playbook_get tool is exposed (catalog is resources)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-a2-"));
  try {
    makeGitRepo(dir);
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const name of REMOVED_PLAYBOOK_TOOLS) {
        assert.ok(!names.includes(name), `${name} must NOT be a tool (catalog is resources)`);
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-10-A3: every advertised tool is a member of the frozen TOOL_SET (closed surface)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-a3-"));
  try {
    makeGitRepo(dir);
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    try {
      const surface = new Set(TOOL_SET);
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const name of names) {
        assert.ok(surface.has(name), `advertised tool ${name} is in the frozen 21-set`);
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// B — formerly-hidden tools are advertised and callable (handlers reached)
// =====================================================================

test("M12-10-B1: the formerly-hidden tools are advertised (no profile hides them)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-b1-"));
  try {
    makeGitRepo(dir);
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    try {
      const advertised = new Set((await client.listTools()).tools.map((t) => t.name));
      for (const name of FORMERLY_HIDDEN) {
        assert.ok(advertised.has(name), `${name} is advertised (no profile hides it)`);
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-10-B2: calling formerly-hidden tools reaches the service (not 'not found')", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-b2-"));
  try {
    makeGitRepo(dir);
    let contractCalls = 0;
    let waitCalls = 0;
    const { server, client } = await buildServerClient({
      dir, registryPath: makeRegistry(dir),
      overrides: {
        runDispatchContractCheckFn: async () => { contractCalls += 1; return {}; },
        runWaitFn: async () => { waitCalls += 1; return {}; },
      },
    });
    try {
      // workspace_select reaches its handler — it re-proves the workspace and
      // either selects or returns a fixed error, but never "not found".
      const ws = await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: dir } });
      assert.equal(notFound(ws), false, "workspace_select handler reached (not not-found)");

      // run_dispatch_contract_check: handler reaches the service (counter=1),
      // then collapses the {} payload to its fixed error — NOT a not-found.
      const cc = await client.callTool({
        name: "run_dispatch_contract_check",
        arguments: { agentId: "coder_low", prompt: "x" },
      });
      assert.equal(contractCalls, 1, "run_dispatch_contract_check service reached");
      assert.equal(notFound(cc), false, "run_dispatch_contract_check handler reached (not not-found)");

      // run_wait: handler reaches the service (counter=1) — NOT a not-found.
      const w = await client.callTool({ name: "run_wait", arguments: { runId: "run_20260803090000000alpha" } });
      assert.equal(waitCalls, 1, "run_wait service reached");
      assert.equal(notFound(w), false, "run_wait handler reached (not not-found)");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// C — the toolProfile model is gone (ignored, never throws, never varies)
// =====================================================================

test("M12-10-C1: createWaoMcpServer ignores toolProfile — same 21 tools for any value, no throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-c1-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir);
    // The legacy values "full" and "lead", plus a totally unknown value, must
    // all yield the SAME 21-tool surface and must NOT throw. (HEAD throws on
    // "bogus" and yields 18 on "lead" — this test reverses that.)
    for (const profile of ["full", "lead", "bogus", undefined]) {
      const { createWaoMcpServer } = await import("../src/mcp/server.js");
      assert.doesNotThrow(() => {
        // Construct only (no connect) — proves the factory does not reject the
        // legacy param. The live surface is asserted via a connected client below
        // for the default; here we additionally build connected clients.
        createWaoMcpServer({ toolProfile: profile, registryPath, runDir: join(dir, "runs"), workspaceRoot: dir });
      }, `toolProfile=${String(profile)} must not throw`);
    }
    // Connected cross-check: default vs explicit "lead" produce identical 21-tool
    // surfaces in the same deterministic order.
    const a = await buildServerClient({ dir, registryPath });
    const b = await buildServerClient({ dir, registryPath, overrides: { toolProfile: "lead" } });
    try {
      const na = (await a.client.listTools()).tools.map((t) => t.name);
      const nb = (await b.client.listTools()).tools.map((t) => t.name);
      assert.deepEqual(na, TOOL_SET, "default = 21");
      assert.deepEqual(nb, TOOL_SET, "toolProfile:'lead' ignored → still 21");
      assert.deepEqual(nb, na, "no profile variance");
    } finally {
      await a.client.close(); await a.server.close();
      await b.client.close(); await b.server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// D — parseMcpArgs ignores legacy --tool-profile; legacy args unchanged
// =====================================================================

test("M12-10-D1: parseMcpArgs ignores --tool-profile as an ordinary unknown flag", async () => {
  const { parseMcpArgs } = await import("../src/mcp/stdio.js");
  // The flag and its value are silently ignored — no parsed output key, no throw.
  assert.equal("toolProfile" in parseMcpArgs(["--tool-profile", "lead"]), false,
    "no toolProfile key in parsed output");
  assert.doesNotThrow(() => parseMcpArgs(["--tool-profile", "bogus"]),
    "unknown --tool-profile value does NOT throw (ignored as unknown flag)");
  assert.doesNotThrow(() => parseMcpArgs(["--tool-profile"]),
    "missing --tool-profile value does NOT throw (ignored as unknown flag)");
  assert.doesNotThrow(() => parseMcpArgs(["--tool-profile", ""]),
    "empty --tool-profile value does NOT throw (ignored as unknown flag)");
});

test("M12-10-D2: legacy --registry/--run-dir/--workspace-root parsing is byte-unchanged", async () => {
  const { parseMcpArgs } = await import("../src/mcp/stdio.js");
  const parsed = parseMcpArgs([
    "--registry", "C:\\repo\\agents.json",
    "--run-dir", "C:\\repo\\runs",
    "--workspace-root", "C:\\repo",
  ]);
  assert.equal(parsed.registryPath, "C:\\repo\\agents.json");
  assert.equal(parsed.runDir, "C:\\repo\\runs");
  assert.equal(parsed.workspaceRoot, "C:\\repo");
  // --workspace-root keeps its strict fail-closed behavior (independent of any
  // removed --tool-profile handling).
  assert.throws(() => parseMcpArgs(["--workspace-root"]), /workspace-root/i);
  assert.throws(() => parseMcpArgs(["--workspace-root", "relative"]), /workspace-root/i);
});

// =====================================================================
// E — toolSurface.js SSOT: frozen 21-set, unique, DRILLDOWN_TOOLS ⊆ surface
// =====================================================================

test("M12-10-E1: src/mcp/toolSurface.js exports the frozen 21-tool SSOT", async () => {
  const { TOOLS } = await import("../src/mcp/toolSurface.js");
  assert.deepEqual(TOOLS, TOOL_SET, "TOOLS == frozen 21-tool set in registration order");
  assert.equal(TOOLS.length, 21);
  assert.ok(Object.isFrozen(TOOLS), "TOOLS is frozen");
  // Uniqueness (no tool registered twice).
  assert.equal(new Set(TOOLS).size, TOOLS.length, "TOOLS has no duplicates");
  // The removed playbook tools are NOT members.
  const set = new Set(TOOLS);
  for (const name of REMOVED_PLAYBOOK_TOOLS) {
    assert.ok(!set.has(name), `${name} is not in the surface`);
  }
});

test("M12-10-E2: every DRILLDOWN_TOOLS carrier is a member of the surface (no drilldown advertises an uncallable tool)", async () => {
  const { DRILLDOWN_TOOLS } = await import("../src/application/runDrilldowns.js");
  const { TOOLS } = await import("../src/mcp/toolSurface.js");
  const surface = new Set(TOOLS);
  assert.ok(DRILLDOWN_TOOLS.length > 0, "drilldown carriers exist");
  for (const name of DRILLDOWN_TOOLS) {
    assert.ok(surface.has(name), `drilldown carrier ${name} is callable on the surface`);
  }
});

// =====================================================================
// F — src/mcp/toolProfiles.js is deleted (the profile model is gone)
// =====================================================================

test("M12-10-F1: src/mcp/toolProfiles.js is deleted (import rejects)", async () => {
  await assert.rejects(
    () => import("../src/mcp/toolProfiles.js"),
    /Cannot find package|Failed to resolve|ERR_MODULE_NOT_FOUND|is not a file|no such file/i,
    "toolProfiles.js must not exist (the profile model is gone)",
  );
});

// =====================================================================
// G — compacted descriptions retain the key semantic guards
// =====================================================================

test("M12-10-G: descriptions retain the key semantic guards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-g-"));
  try {
    makeGitRepo(dir);
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    let byName;
    try {
      byName = new Map((await client.listTools()).tools.map((t) => [t.name, t.description || ""]));
    } finally {
      await client.close();
      await server.close();
    }
    const d = (name) => byName.get(name);

    // advisory-not-gate: lead_preflight must say it is advisory, not a gate.
    assert.match(d("lead_preflight"), /advisory/i);
    assert.match(d("lead_preflight"), /not a gate/i);
    // Lead decides: run_diagnose keeps the Lead-decides boundary.
    assert.match(d("run_diagnose"), /lead/i);
    // run_collect non-idempotent: the audit-append side effect remains.
    assert.match(d("run_collect"), /not idempotent/i);
    // untrusted diff: run_delivery_review marks the fragment untrusted.
    assert.match(d("run_delivery_review"), /untrusted/i);
    // run_stop destructive + first-terminal-wins.
    assert.match(d("run_stop"), /destructive/i);
    assert.match(d("run_stop"), /first-terminal-wins/i);
    // run_delivery_decide: first durable decision wins.
    assert.match(d("run_delivery_decide"), /first/i);
    // run_dispatch: only agentId + prompt are accepted.
    assert.match(d("run_dispatch"), /agentId/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// H — no-model wire measurement: deterministic 21-tool wire, bounded + honest
// =====================================================================

// Recorded BEFORE this change (the 23-tool HEAD baseline) for the regression
// narrative: the surface dropped playbook_list/playbook_get, so the 21-tool wire
// is materially smaller than the 23-tool baseline.
const RED_23_WIRE = 75492;

// Frozen deterministic ceiling — tightened to the achieved GREEN value
// (65625 bytes: 21 tools, desc total 10642), to prevent wire regression creep.
// The measurement is deterministic (same code ⇒ identical bytes), so freezing
// at the achieved value gives full regression protection: any description growth
// or tool-schema bloat trips the ceiling.
const FROZEN_21_WIRE_CEILING = 65625;

async function measureWire() {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-wire-"));
  try {
    makeGitRepo(dir);
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    try {
      const tools = (await client.listTools()).tools;
      const wire = JSON.stringify({ tools });
      const descTotal = tools.reduce((s, t) => s + byteLen(t.description), 0);
      return {
        count: tools.length,
        wireBytes: byteLen(wire),
        descBytes: descTotal,
        names: tools.map((t) => t.name),
      };
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("M12-10-H: deterministic 21-tool wire below frozen ceiling and below the 23-tool baseline", async () => {
  const m = await measureWire();
  // The surface is exactly 21 (re-asserted for the measured server).
  assert.equal(m.count, 21, `measured count is 21 (got ${m.count})`);
  assert.deepEqual(m.names, TOOL_SET, "measured set == frozen 21-set");
  // Honest regression narrative: the 21-tool wire must be smaller than the prior
  // 23-tool baseline (the two playbook tools and their schemas are gone).
  assert.ok(m.wireBytes < RED_23_WIRE,
    `21-tool wire (${m.wireBytes}) < 23-tool baseline (${RED_23_WIRE})`);
  // Frozen ceiling prevents creep.
  assert.ok(m.wireBytes <= FROZEN_21_WIRE_CEILING,
    `21-tool wire (${m.wireBytes}) <= frozen ceiling (${FROZEN_21_WIRE_CEILING})`);
});
