// test/m12-10-tool-surface.test.js
//
// M12-10 progressive-disclosure correction — the FROZEN tool surface.
//
// WAO exposes EXACTLY 22 always-registered MCP tools. There is NO tool-profile
// model, NO startup flag, and NO restart-to-recover: every operational tool is
// independently callable for the lifetime of the connection. The built-in
// playbook catalog moved OFF the tool surface entirely (it is presented as MCP
// resources — see test/mcpPlaybook.test.js). What used to be the two playbook
// tools (`playbook_list`, `playbook_get`) are no longer tools at all; the
// remaining 21 are the former 23 minus those two, and M12-16 (queued in-flight
// correction) added `run_correct`, taking the surface to 22.
//
// This is a PRESENTATION/TRUTH lock, not a permission or routing layer. There
// is no branching on Host/runtime name, no `tools/list_changed` dependency, and
// no dynamic registration — the 22 tools are registered unconditionally at
// server construction.
//
// Contracts under test:
//   A — tools/list returns EXACTLY the deterministic 22-tool set, in the frozen
//       registration order, with NO `playbook_list`/`playbook_get` and NO
//       profile-driven variance.
//   B — the three tools the old `lead` profile HID (`workspace_select`,
//       `run_dispatch_contract_check`, `run_wait`) are now advertised AND their
//       handlers are reached on call (not "not found"); every tool is callable.
//   C — the toolProfile model is GONE: `createWaoMcpServer({toolProfile})` does
//       not throw and does not change the 22-tool surface for ANY value.
//   D — stdio `parseMcpArgs` IGNORES legacy `--tool-profile` as an ordinary
//       unknown flag (no parse, no output key, no throw); the legacy
//       `--registry`/`--run-dir`/`--workspace-root` parsing is byte-unchanged.
//   E — `src/mcp/toolSurface.js` is the single frozen SSOT (22 names, frozen,
//       unique, registration order); every DRILLDOWN_TOOLS carrier is a member.
//   F — `src/mcp/toolProfiles.js` is DELETED (the profile model is gone).
//   G — compacted descriptions retain the key semantic guards.
//   H — no-model wire measurement: deterministic 22-tool wire, bounded by a
//       frozen ceiling (regression protection), and honestly recorded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

// ---- Frozen closed set (the contract) ----

// Registration order exactly as emitted by tools/list. The former 23-tool full
// set MINUS playbook_list + playbook_get (the catalog is now resources) = 21,
// PLUS run_correct (M12-16 queued in-flight correction) = 22.
const TOOL_SET = Object.freeze([
  "registry_list", "workspace_status", "workspace_select", "lead_preflight",
  "run_dispatch", "run_dispatch_contract_check", "run_continue", "run_correct",
  "run_status", "run_collect", "run_diagnose", "run_delivery", "run_delivery_decide",
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
  const { createWaoMcpServer } = await import("../../src/mcp/server.js");
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
// A — exact deterministic 22-tool set, no playbook tools, no profile variance
// =====================================================================

test("M12-10-A1: tools/list returns exactly the 22-tool set in deterministic order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-a1-"));
  try {
    makeGitRepo(dir);
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      assert.deepEqual(names, TOOL_SET, "exactly the 22-tool set in registration order");
      assert.equal(names.length, 22, "exactly 22");
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
        assert.ok(surface.has(name), `advertised tool ${name} is in the frozen 22-set`);
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

test("M12-10-C1: createWaoMcpServer ignores toolProfile — same 22 tools for any value, no throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-c1-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir);
    // The legacy values "full" and "lead", plus a totally unknown value, must
    // all yield the SAME 22-tool surface and must NOT throw. (HEAD throws on
    // "bogus" and yields 18 on "lead" — this test reverses that.)
    for (const profile of ["full", "lead", "bogus", undefined]) {
      const { createWaoMcpServer } = await import("../../src/mcp/server.js");
      assert.doesNotThrow(() => {
        // Construct only (no connect) — proves the factory does not reject the
        // legacy param. The live surface is asserted via a connected client below
        // for the default; here we additionally build connected clients.
        createWaoMcpServer({ toolProfile: profile, registryPath, runDir: join(dir, "runs"), workspaceRoot: dir });
      }, `toolProfile=${String(profile)} must not throw`);
    }
    // Connected cross-check: default vs explicit "lead" produce identical 22-tool
    // surfaces in the same deterministic order.
    const a = await buildServerClient({ dir, registryPath });
    const b = await buildServerClient({ dir, registryPath, overrides: { toolProfile: "lead" } });
    try {
      const na = (await a.client.listTools()).tools.map((t) => t.name);
      const nb = (await b.client.listTools()).tools.map((t) => t.name);
      assert.deepEqual(na, TOOL_SET, "default = 22");
      assert.deepEqual(nb, TOOL_SET, "toolProfile:'lead' ignored → still 22");
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
  const { parseMcpArgs } = await import("../../src/mcp/stdio.js");
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
  const { parseMcpArgs } = await import("../../src/mcp/stdio.js");
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
// E — toolSurface.js SSOT: frozen 22-set, unique, DRILLDOWN_TOOLS ⊆ surface
// =====================================================================

test("M12-10-E1: src/mcp/toolSurface.js exports the frozen 22-tool SSOT", async () => {
  const { TOOLS } = await import("../../src/mcp/toolSurface.js");
  assert.deepEqual(TOOLS, TOOL_SET, "TOOLS == frozen 22-tool set in registration order");
  assert.equal(TOOLS.length, 22);
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
  const { DRILLDOWN_TOOLS } = await import("../../src/application/runDrilldowns.js");
  const { TOOLS } = await import("../../src/mcp/toolSurface.js");
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
    () => import("../../src/mcp/toolProfiles.js"),
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
    // run_wait is a long observation primitive, not a point-in-time alias.
    assert.match(d("run_wait"), /180000\.\.600000/);
    assert.match(d("run_wait"), /default 270000/);
    assert.match(d("run_wait"), /waitMs=0 is intentionally invalid/i);
    assert.match(d("run_wait"), /run_await_result\(waitMs:0\).*run_status/i);
    // M12-19: wait-capable tools truthfully state that Host transport
    // loss/cancellation does not stop the detached run — re-read point-in-time.
    assert.match(d("run_wait"), /Host transport loss\/cancellation does not stop the detached run/);
    assert.match(d("run_wait"), /re-read point-in-time/);
    assert.match(d("run_await_result"), /Host transport loss\/cancellation does not stop the detached run/);
    assert.match(d("run_await_result"), /re-read point-in-time/);
    // M12-19: run_activity tells the cursor-rejection recovery path (fixed
    // generic error; page-1 fresh chain or afterSeq from a known sequence).
    assert.match(d("run_activity"), /fixed generic error/);
    assert.match(d("run_activity"), /afterSeq/);
    // M12-19: the delivery waitMs contract is stated truthfully on both
    // wait-capable delivery tools (no hidden clamp, no altered range/default).
    assert.match(d("run_delivery"), /1000\.\.300000/);
    assert.match(d("run_delivery"), /waitMs=0 is invalid/);
    assert.match(d("run_delivery_review_bundle"), /1000\.\.300000/);
    assert.match(d("run_delivery_review_bundle"), /waitMs=0 is invalid/);
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

// Frozen deterministic ceiling — frozen at the achieved GREEN value, to prevent
// wire regression creep. The measurement is deterministic (same code ⇒ identical
// bytes), so freezing at the achieved value gives full regression protection:
// any further description growth or tool-schema bloat trips the ceiling.
//
// Re-baselined for M12-11: run_wait and run_await_result gained the bounded,
// closed-set `observation`/`termination` nested facts (additive; no arrays or
// dynamic payloads) and Host-neutral transport-recovery description text.
// Ceiling re-frozen to the new achieved value (69031 bytes: 21 tools, desc total
// 11958). Prior M12-10 value was 65625 (desc total 10642); the ~3.4k delta is
// the sanctioned M12-11 addition, still well under the 23-tool baseline below.
//
// Re-baselined for M12-12 (Self-Describing Results): the four standalone
// observation/delivery/diagnosis tools (run_wait, run_await_result, run_delivery,
// run_diagnose) gained the REQUIRED `semanticNotes` array — a 1..4-entry array of
// three-key notes plus a concise description sentence on each. No new tools, no
// validation removed, no hidden tools.
//
// M12-12 wire correction: the note `id` is a BOUNDED SHAPE in the output schema —
// the frozen namespace pattern + max length derived from the SSOT — NOT the full
// catalog enum. Serializing a 33+-element zod enum once per output schema had
// pushed the wire to 74559; the bounded shape (zod `.regex()` → JSON-Schema
// `pattern`, no enum) drops it back to 71495 while keeping exact three-key strict
// response parsing and the application SSOT as the catalog-membership authority.
// Ceiling re-frozen to the new achieved value (71495 bytes: 21 tools). The 21-tool
// wire (71495) remains below the 23-tool baseline (75492) with comfortable margin.
//
// Follow-up UX correction: run_wait now self-describes its accepted waitMs range
// and the point-in-time alternative. This adds 138 description bytes and no
// schema/tool/runtime behavior. Ceiling re-frozen at the measured 71633 bytes.
//
// M12-13 re-baseline: run_dispatch, run_continue, run_reverify and the profile
// paths gained the shared per-command execution timeout/budget —
// delivery.verificationTimeoutMs [1000, 7200000] — and run_delivery/run_await_result
// gained the nullable isolationFailure / isolationFailureCode projection fields.
// No new tools, no validation removed. The measured wire grew +602 bytes over
// M12-12; ceiling re-frozen at the achieved value, still comfortably below the
// 23-tool baseline.
//
// M12-15 re-baseline: runs_list gained two closed-set per-run activity facts and
// unresolvedCount; lead_preflight gained unresolvedRunCount. These additive,
// bounded fields distinguish proven-active runs from historical non-terminal
// transcripts without hiding evidence or inferring failure. No new tools or
// validation were removed. Ceiling re-frozen at the measured 72739 bytes, still
// below the 23-tool baseline.
//
// M12-16 re-baseline (Package A — lossless context slimming): every tool's
// human-language description was materially shortened to drop tools/list context
// cost. The same 21 tools, the exact same wire schema/annotations/names/order —
// proven by M12-16-A's description-stripped SHA-256 contract, which is unchanged.
// Description bytes fell 11812 -> 8873 (-2939, -25%); the wire fell by the same
// 2939 bytes (description is the only variable field) to 69800. No schema,
// handler, annotation, name, order, or behavior change. Ceiling re-frozen at the
// measured 69800 bytes, still well below the 23-tool baseline.
//
// M12-16 re-baseline (queued in-flight correction — run_correct added): the
// surface grew from 21 to 22 tools. run_correct carries its own
// input/output schemas + annotations + a 517-byte description, and run_dispatch
// gained a one-sentence correctable clause. The description-stripped SHA-256
// therefore changed (a new tool's schema is in the stripped payload) and was
// re-measured truthfully (see DESC_STRIPPED_CONTRACT_SHA). Description bytes rose
// 8873 -> 9576 (+703); the wire rose by the same description delta plus run_correct's
// schema bytes to 71677. Ceiling re-frozen at the measured 71677 bytes, STILL below
// the 23-tool baseline (75492) — 22 tools now vs 23 then, with more function.
//
// M12-16 re-baseline (correction lifecycle visibility in run_activity): the
// run_activity output schema gained the closed-set `correction` activity variant
// (status enum over requested/claimed/delivered/delivery_failed/rejected + a
// bounded correctionId) and a `correction` counts key, so the correction lifecycle
// is visible as meaningful safe labels WITHOUT ever exposing correction
// prompt/body/reason/provider session/path. No new tools, no validation removed,
// no description change (M12-16-B still passes). The wire grew +451 bytes
// (schema-only); ceiling re-frozen at 72128, still well below the 23-tool baseline.
//
// M12-17 re-baseline (submitted-stage execution semantics): the run_status
// OUTPUT schema gained the REQUIRED closed-set `executionStage` object
// ({ phase, sinceTs, secondsSince } — phases from the runStageProjection.js SSOT
// enum, nullable sinceTs/secondsSince). No new tools, no validation removed, no
// description text change (M12-16-B still passes — desc bytes unchanged). The
// wire grew +307 bytes (schema-only); ceiling re-frozen at the measured 72435,
// still well below the 23-tool baseline (75492).
//
// M12-19 re-baseline (supervision recovery truth): workspace_status AND the
// lead_preflight workspace projection gained the REQUIRED closed-set
// `unboundReason` nullable enum (zod enum derived from the WORKSPACE_UNBOUND_REASONS
// application SSOT) — additive schema on two output schemas, plus sanctioned
// recovery-truth description text on workspace_status/lead_preflight/run_wait/
// run_await_result/run_activity/run_delivery/run_delivery_review_bundle (waitMs
// range + 0-invalid + point-in-time alternative + cursor-rejection recovery +
// Host transport-loss truth; NO wait ranges, defaults, or behavior changed).
// No new tools, no validation removed. The wire grew +1512 bytes; ceiling
// re-frozen at the measured 73947, still well below the 23-tool baseline (75492).
//
// M12-19 re-baseline (process-missing delivery recovery): RECOVERY_CANDIDATE_KINDS
// gained the REQUIRED closed-set member `process_missing` — the wire
// RECOVERY_CANDIDATE_KIND_SCHEMA (zod enum derived from that application SSOT,
// auto-extending with the array) now serializes three members instead of two in
// the run_delivery / run_delivery_repackage / run_delivery_decide output schemas
// (+54 bytes, part of the stripped payload — see DESC_STRIPPED_CONTRACT_SHA),
// plus sanctioned host-neutral advisory/settlement description text on
// run_delivery and run_delivery_repackage (candidateKind=process_missing means the
// detached runner/provider process is provably gone and retained work is
// recoverable but not accepted; settlement is a first-terminal-wins failed with a
// safe confirmation fact; NO PID/path/error leakage, no auto-accept). No new
// tools, no validation removed. Description bytes rose 10734 -> 11225 (+491); the
// wire rose by the same description delta plus the enum bytes (+545 total).
// Ceiling re-frozen at the measured 74492, still well below the 23-tool baseline
// (75492).
//
// M12-22 re-baseline (continuation cumulative-scope truth): the run_continue
// output schema (RUN_CONTINUE_OUTPUT) gained six nullable-optional cumulative-
// scope fields (inheritedChangedPaths/Count/Truncated +
// uncoveredInheritedPaths/Count/Truncated), populated ONLY on the new closed-set
// `continuation_scope_incomplete` eligibility refusal — additive optional schema,
// so success and every other refusal stay byte-identical (zero drift). No new
// tools (count stays 22), no validation removed, no description text changed
// (FROZEN_22_DESC_CEILING unchanged at 11225). The output schema is part of the
// stripped payload, so DESC_STRIPPED_CONTRACT_SHA changed truthfully (see below).
// The wire grew +583 bytes; ceiling re-frozen at the measured 75075, still well
// below the 23-tool baseline (75492).
// M12-24 adds the provider_capacity category and two safe diagnosis codes to
// existing output enums. The surface remains 22 tools; the intentional schema
// change adds 106 bytes, so the ceiling is re-frozen at the exact 75181.
// M12-25 adds the bounded registry-issue projection (issues/issuesTruncated on
// registry_list, registryIssues/registryIssuesTruncated on lead_preflight) and
// the providerSessionRouting closed set on run_dispatch. The surface remains 22
// tools; the intentional additive output schemas add 786 bytes (75181 → 75967),
// which crosses the historical 75492 23-tool baseline (the "leaner than 23 tools"
// narrative no longer holds — see M12-10-H). The regression guard is this frozen
// ceiling, re-frozen at the exact measured 75967.
// TD-111 adds the certification advisory context fields (certificationReasonCode
// enum derived from the CERTIFICATION_REASON_CODES SSOT + nullable
// certificationLastHealthyAt) to AGENT_ENTRY and the lead_preflight workers
// entries. The surface remains 22 tools; the additive output schemas add 617
// bytes (75967 → 76584). Ceiling re-frozen at the exact measured 76584.
const FROZEN_22_WIRE_CEILING = 76584;

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

test("M12-10-H: deterministic 22-tool wire at or below the frozen ceiling", async () => {
  const m = await measureWire();
  // The surface is exactly 22 (re-asserted for the measured server).
  assert.equal(m.count, 22, `measured count is 22 (got ${m.count})`);
  assert.deepEqual(m.names, TOOL_SET, "measured set == frozen 22-set");
  // Honest regression narrative (M12-25 re-baseline): the 22-tool wire (75967)
  // now EXCEEDS the historical 75492 23-tool baseline (RED_23_WIRE). The smaller
  // tool count carries materially richer OUTPUT-CONTRACT schemas accumulated
  // across M12-16..M12-25 (delivery correction/execution-stage/recovery-truth/
  // capacity/routing fields), so the old "leaner than the 23-tool surface"
  // comparison no longer holds and is retired here. The meaningful regression
  // guard is the frozen ceiling below (re-frozen at the measured value); the
  // M12-16-A description-stripped SHA guard is the losslessness proof. RED_23_WIRE
  // is retained as a documented historical reference, not an active assertion.
  assert.ok(m.wireBytes <= FROZEN_22_WIRE_CEILING,
    `22-tool wire (${m.wireBytes}) <= frozen ceiling (${FROZEN_22_WIRE_CEILING})`);
});

// =====================================================================
// M12-16 — lossless tools/list context slimming (Package A)
// =====================================================================
//
// The 21-tool tools/list payload is large because each tool carries a verbose
// human-language description. M12-16 shortens every description to drop context
// cost WITHOUT touching anything else: the same 21 tools, the exact same wire
// schema/annotations/names/order. Two guards prove the slimming is lossless:
//
//   M12-16-A — the description-stripped tools/list payload hashes to a FROZEN
//     SHA-256. Recursively removing every `description` key (the 21 top-level
//     tool descriptions plus any nested schema descriptions) leaves names,
//     order, input/output schemas, annotations, and every other field
//     byte-identical. If a schema, annotation, name, or order changes by a
//     single byte, this hash breaks — so it is the losslessness proof.
//
//   M12-16-B — the description total is materially below the M12-15 baseline
//     (frozen at the achieved GREEN value). This is the regression ceiling: it
//     proves the slimming was real (not cosmetic) and prevents description creep.
//
// The frozen hash below was measured against the PRE-slimming code (it is
// independent of description TEXT — only structure matters), and it MUST NOT
// change across the slimming.

// Frozen description-stripped tools/list contract (names + order + input/output
// schemas + annotations + every non-description field, recursively stripped of
// all `description` keys, then JSON.stringify'd). Measured on the M12-15 surface,
// re-measured for M12-16 run_correct (the added tool's input/output schemas +
// annotations are part of the stripped payload, so the SHA changed truthfully);
// re-measured again for the M12-16 correction-category run_activity output-schema
// variant (a new union member + counts key change the stripped payload, so the SHA
// changed truthfully); re-measured once more for M12-17 (the run_status output
// schema gained the closed-set `executionStage` object — its zod enum + strict
// object are part of the stripped payload, so the SHA changed truthfully; no
// description text changed); re-measured for M12-19 (workspace_status AND the
// lead_preflight workspace projection gained the closed-set `unboundReason`
// nullable enum — both output schemas are part of the stripped payload, so the
// SHA changed truthfully; no description text is in the stripped payload);
// re-measured once more for the M12-19 process-missing delivery recovery (the
// RECOVERY_CANDIDATE_KINDS closed set gained `process_missing` — the wire
// RECOVERY_CANDIDATE_KIND_SCHEMA enum serializes three members instead of two in
// the run_delivery / run_delivery_repackage / run_delivery_decide output schemas,
// which ARE part of the stripped payload, so the SHA changed truthfully; no
// description text is in the stripped payload).
// Re-measured for M12-21 (completed-empty wire truth): the run_diagnose and
// run_await_result terminal-outcome diagnosis `code` enums gained the closed-set
// `completed_empty` member — the unified DIAGNOSIS_CODES SSOT replaced the
// provider-only enum on the wire, so both output schemas serialize one more enum
// member as part of the stripped payload, and the SHA changed truthfully; no
// description text is in the stripped payload.
// Re-measured for M12-22 (continuation cumulative-scope truth): the run_continue
// output schema (RUN_CONTINUE_OUTPUT) gained six nullable-optional cumulative-
// scope fields (inheritedChangedPaths/Count/Truncated +
// uncoveredInheritedPaths/Count/Truncated), present ONLY on the new closed-set
// `continuation_scope_incomplete` refusal. Additive optional output-schema
// members are part of the stripped payload, so the SHA changed truthfully; no
// description text is in the stripped payload.
// Re-measured for M12-24: existing diagnosis/wait output enums gained only
// provider_capacity + rate_limited/quota_exhausted. M12-24-MCP2 locks those
// intended members explicitly; this hash continues to catch all other drift.
// Re-measured for M12-25: registry_list/lead_preflight output schemas gained the
// bounded issue projection (issues/registryIssues + issuesTruncated, with the
// closed-set REGISTRY_ISSUE object), and run_dispatch gained the closed-set
// providerSessionRouting enum. Those additive schemas are part of the stripped
// payload, so the SHA changed truthfully; no description text changed. M12-10-H
// re-freezes the wire ceiling; this hash remains the losslessness proof.
// Re-measured for TD-111: the registry_list AGENT_ENTRY and lead_preflight
// workers output schemas gained the certification advisory context fields
// (certificationReasonCode — an enum derived from the CERTIFICATION_REASON_CODES
// SSOT — and the nullable certificationLastHealthyAt string). Those additive
// schemas are part of the stripped payload, so the SHA changed truthfully; no
// description text changed. M12-10-H re-freezes the wire ceiling; this hash
// remains the losslessness proof.
const DESC_STRIPPED_CONTRACT_SHA =
  "73bea15f73b2366060ddac81320caf0132ea20bfeeb57fd1be617394de82b5fc";

// Description bytes on the M12-15 surface, BEFORE M12-16 slimming (frozen fact).
const PRE_M12_16_DESC_BASELINE = 11812;
// Material-reduction floor: the slimming must cut at least this many description
// bytes vs the M12-15 baseline, so a one-word edit cannot satisfy the ceiling.
// Re-based for the run_correct addition (M12-16 in-flight correction): the added
// tool raised the description total, so the net cut vs M12-15 is now 2236 bytes
// (11812 − 9576). 2000 keeps the "material, not cosmetic" intent with headroom.
// Re-based for M12-19 (supervision recovery truth): the sanctioned
// recovery-truth clauses on workspace_status/lead_preflight/run_wait/
// run_await_result/run_activity/run_delivery/run_delivery_review_bundle raised
// the description total to 10734, so the net cut vs M12-15 is now 1078 bytes
// (11812 − 10734). 1000 keeps the "material, not cosmetic" intent with headroom
// while acknowledging the sanctioned M12-19 addition.
// Re-based again for the M12-19 process-missing delivery recovery: the sanctioned
// host-neutral advisory/settlement description text on run_delivery and
// run_delivery_repackage raised the description total to 11225, so the net cut vs
// M12-15 is now 587 bytes (11812 − 11225). 500 keeps the "material, not cosmetic"
// intent with headroom while acknowledging the sanctioned process_missing
// addition.
const M12_16_DESC_REDUCTION_MIN = 500;
// Frozen at the achieved GREEN value AFTER run_correct was added. Prevents creep.
// Re-baselined for M12-19 (recovery-truth descriptions, +1158 bytes over the
// M12-17 value); re-frozen at the measured 10734.
// Re-baselined again for the M12-19 process-missing delivery recovery (the
// sanctioned advisory/settlement description text, +491 bytes over the
// supervision-recovery-truth value); re-frozen at the measured 11225.
const FROZEN_22_DESC_CEILING = 11225;

// Recursively remove every `description` key from a tools/list payload (the 21
// top-level tool descriptions and any nested schema descriptions). Returns a new
// object graph; the input is untouched.
function stripDescriptions(value) {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === "description") continue;
      out[key] = stripDescriptions(val);
    }
    return out;
  }
  return value;
}

// Measure the live 21-tool surface: byte totals (wire + description), the frozen
// names/order, and the SHA-256 of the description-stripped payload.
async function measureSurface() {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1216-"));
  try {
    makeGitRepo(dir);
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    try {
      const tools = (await client.listTools()).tools;
      const wire = JSON.stringify({ tools });
      const descTotal = tools.reduce((s, t) => s + byteLen(t.description), 0);
      // The frozen contract hash is over the tools ARRAY with every `description`
      // key recursively removed (the 21 top-level tool descriptions; there are no
      // nested schema descriptions today), then JSON.stringify'd. Hashing the
      // array — not the {tools} envelope — matches the frozen contract exactly.
      const stripped = stripDescriptions(tools);
      const schemaSha = createHash("sha256").update(JSON.stringify(stripped)).digest("hex");
      return {
        count: tools.length,
        wireBytes: byteLen(wire),
        descBytes: descTotal,
        names: tools.map((t) => t.name),
        schemaSha,
        stripped,
      };
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("M12-16-A: description-stripped tools/list contract is byte-stable (SHA-256 losslessness guard)", async () => {
  const m = await measureSurface();
  // Same 22 tools, same names, same order.
  assert.equal(m.count, 22, `measured count is 22 (got ${m.count})`);
  assert.deepEqual(m.names, TOOL_SET, "names/order unchanged by slimming");
  // The description-stripped payload must hash to the frozen contract. ANY change
  // to a schema, annotation, name, or order — anything but a tool's description
  // text — breaks this hash. This is the losslessness proof for the slimming.
  assert.equal(
    m.schemaSha,
    DESC_STRIPPED_CONTRACT_SHA,
    `description-stripped SHA-256 must equal the frozen contract; got ${m.schemaSha}`,
  );
  // Defense-in-depth: stripping removed only `description`; every tool still
  // carries its non-description fields intact.
  for (const t of m.stripped) {
    assert.equal("description" in t, false, `${t.name} has no description key after strip`);
    assert.ok(t.inputSchema, `${t.name} retains inputSchema`);
    assert.ok(t.annotations, `${t.name} retains annotations`);
  }
});

test("M12-16-B: descriptions are materially shorter (frozen ceiling below the M12-15 baseline)", async () => {
  const m = await measureSurface();
  // Frozen ceiling at the achieved GREEN value — prevents description creep.
  assert.ok(
    m.descBytes <= FROZEN_22_DESC_CEILING,
    `desc bytes (${m.descBytes}) <= frozen ceiling (${FROZEN_22_DESC_CEILING})`,
  );
  // Material reduction (not cosmetic): even with run_correct added, the 22-tool
  // description total remains materially below the 21-tool M12-15 baseline.
  assert.ok(
    m.descBytes <= PRE_M12_16_DESC_BASELINE - M12_16_DESC_REDUCTION_MIN,
    `material reduction: desc bytes (${m.descBytes}) <= ${
      PRE_M12_16_DESC_BASELINE - M12_16_DESC_REDUCTION_MIN
    } (baseline ${PRE_M12_16_DESC_BASELINE} minus ${M12_16_DESC_REDUCTION_MIN})`,
  );
});
