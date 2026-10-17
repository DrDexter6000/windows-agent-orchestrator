// test/m12-10-tool-surface.test.js
//
// M12-10 progressive-disclosure correction — the FROZEN tool surface.
//
// WAO exposes EXACTLY 23 always-registered MCP tools. There is NO tool-profile
// model, NO startup flag, and NO restart-to-recover: every operational tool is
// independently callable for the lifetime of the connection. The built-in
// playbook catalog moved OFF the tool surface entirely (it is presented as MCP
// resources — see test/mcpPlaybook.test.js). What used to be the two playbook
// tools (`playbook_list`, `playbook_get`) are no longer tools at all; the
// remaining 21 are the former 23 minus those two, and M12-16 (queued in-flight
// correction) added `run_correct`, taking the surface to 22; M13-r2 (decision
// 0039 multi-seat read-only council consult) added `run_consult`, 22 → 23.
//
// This is a PRESENTATION/TRUTH lock, not a permission or routing layer. There
// is no branching on Host/runtime name, no `tools/list_changed` dependency, and
// no dynamic registration — the 23 tools are registered unconditionally at
// server construction.
//
// Contracts under test:
//   A — tools/list returns EXACTLY the deterministic 23-tool set, in the frozen
//       registration order, with NO `playbook_list`/`playbook_get` and NO
//       profile-driven variance.
//   B — the three tools the old `lead` profile HID (`workspace_select`,
//       `run_dispatch_contract_check`, `run_wait`) are now advertised AND their
//       handlers are reached on call (not "not found"); every tool is callable.
//   C — the toolProfile model is GONE: `createWaoMcpServer({toolProfile})` does
//       not throw and does not change the 23-tool surface for ANY value.
//   D — stdio `parseMcpArgs` IGNORES legacy `--tool-profile` as an ordinary
//       unknown flag (no parse, no output key, no throw); the legacy
//       `--registry`/`--run-dir`/`--workspace-root` parsing is byte-unchanged.
//   E — `src/mcp/toolSurface.js` is the single frozen SSOT (23 names, frozen,
//       unique, registration order); every DRILLDOWN_TOOLS carrier is a member.
//   F — `src/mcp/toolProfiles.js` is DELETED (the profile model is gone).
//   G — compacted descriptions retain the key semantic guards.
//   H — no-model wire measurement: deterministic 23-tool wire, bounded by a
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
// PLUS run_correct (M12-16 queued in-flight correction) = 22, PLUS run_consult
// (M13-r2 multi-seat read-only council consult, decision 0039) = 23.
const TOOL_SET = Object.freeze([
  "registry_list", "workspace_status", "workspace_select", "lead_preflight",
  "run_dispatch", "run_dispatch_contract_check", "run_consult", "run_continue",
  "run_correct",
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
// A — exact deterministic 23-tool set, no playbook tools, no profile variance
// =====================================================================

test("M12-10-A1: tools/list returns exactly the 23-tool set in deterministic order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-a1-"));
  try {
    makeGitRepo(dir);
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      assert.deepEqual(names, TOOL_SET, "exactly the 23-tool set in registration order");
      assert.equal(names.length, 23, "exactly 23");
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
        assert.ok(surface.has(name), `advertised tool ${name} is in the frozen 23-set`);
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

test("M12-10-C1: createWaoMcpServer ignores toolProfile — same 23 tools for any value, no throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-c1-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir);
    // The legacy values "full" and "lead", plus a totally unknown value, must
    // all yield the SAME 23-tool surface and must NOT throw. (HEAD throws on
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
    // Connected cross-check: default vs explicit "lead" produce identical 23-tool
    // surfaces in the same deterministic order.
    const a = await buildServerClient({ dir, registryPath });
    const b = await buildServerClient({ dir, registryPath, overrides: { toolProfile: "lead" } });
    try {
      const na = (await a.client.listTools()).tools.map((t) => t.name);
      const nb = (await b.client.listTools()).tools.map((t) => t.name);
      assert.deepEqual(na, TOOL_SET, "default = 23");
      assert.deepEqual(nb, TOOL_SET, "toolProfile:'lead' ignored → still 23");
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
// E — toolSurface.js SSOT: frozen 23-set, unique, DRILLDOWN_TOOLS ⊆ surface
// =====================================================================

test("M12-10-E1: src/mcp/toolSurface.js exports the frozen 23-tool SSOT", async () => {
  const { TOOLS } = await import("../../src/mcp/toolSurface.js");
  assert.deepEqual(TOOLS, TOOL_SET, "TOOLS == frozen 23-tool set in registration order");
  assert.equal(TOOLS.length, 23);
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

// Historical 2026-08 23-tool wire baseline (documented reference only; see M12-10-H).
const RED_23_WIRE = 75492;

// 冻结线 = 实测值，只在 Owner 批准的批次里重冻；硬顶与规则见决定 0078。
// 2026-10-15（Owner 批准重冻）：会动工作区的工具（run_dispatch / run_continue /
// run_correct / run_stop / run_collect / run_delivery_decide / run_delivery_
// repackage / run_delivery_reverify / run_consult create）的目标改为只取本次
// 调用的 expectedWorkspaceRoot——八个 runId 工具的 inputSchema 增可选
// expectedWorkspaceRoot、run_consult 增同一字段、WORKSPACE_PROOF.source 枚举
// 增闭集成员 call_target、lead_preflight workspace 增 projectBucket、runs_list
// 增 scope 对象，描述各加一句必传目标说明：85101→87406（实测；Owner 硬顶
// 94532 内）。同批会审修复：run_consult 读取/分页也可带 expectedWorkspaceRoot、
// run_dispatch_contract_check 按调用目标检查并在出参增 workspaceScope、
// run_stop 描述不再说 bound workspace：87406→88048（实测；硬顶同上）。
const FROZEN_23_WIRE_CEILING = 90661;
// 2026-10-16（Owner 批准小幅重冻）：run_delivery_reverify 入参/出参增可选
// attempt（1|2，缺省 1——第二次显式重验机会），描述加一句第二次机会说明：
// 88048→88227（实测；本批批准 wire+desc 合计涨幅 ≤300B，实测合计 +252B）。
// 2026-10-17（Owner 批准重冻）：lead_preflight 出参增 lanes 车道画像紧凑投影
//（scale/dimensionLabels/rows——七格 {stars,basis,n,note}、待复核状态与原因、
// caveats 前 2、cost；独立子 schema 校验，不合格置 null 不连累其余各节），
// 描述改提车道分项星级并压缩原句腾字节（desc/hostVisible 冻结线未抬）：
// 88227→90661（实测；Owner 硬顶 94532 内）。

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

test("M12-10-H: deterministic 23-tool wire at or below the frozen ceiling", async () => {
  const m = await measureWire();
  // The surface is exactly 23 (re-asserted for the measured server).
  assert.equal(m.count, 23, `measured count is 23 (got ${m.count})`);
  assert.deepEqual(m.names, TOOL_SET, "measured set == frozen 23-set");
  // Honest regression narrative (M12-25 re-baseline): the 22-tool wire (75967)
  // now EXCEEDS the historical 75492 23-tool baseline (RED_23_WIRE). The smaller
  // tool count carries materially richer OUTPUT-CONTRACT schemas accumulated
  // across M12-16..M12-25 (delivery correction/execution-stage/recovery-truth/
  // capacity/routing fields), so the old "leaner than the 23-tool surface"
  // comparison no longer holds and is retired here. The meaningful regression
  // guard is the frozen ceiling below (re-frozen at the measured value); the
  // M12-16-A description-stripped SHA guard is the losslessness proof. RED_23_WIRE
  // is retained as a documented historical reference, not an active assertion.
  // (M13-r2 note: the surface is now literally 23 tools again — 84494 measured —
  // and RED_23_WIRE still names the OLD 2026-08 baseline, not this surface.)
  assert.ok(m.wireBytes <= FROZEN_23_WIRE_CEILING,
    `23-tool wire (${m.wireBytes}) <= frozen ceiling (${FROZEN_23_WIRE_CEILING})`);
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
// ADR 0021 (2026-08-16) writes this de facto regime down as policy; this test remains the enforcement.
// Re-measured for Round 4 Bundle B (read-only runs): run_dispatch's
// RUN_DISPATCH_INPUT gained the optional `readOnly` boolean (the Lead's
// read-only declaration) and run_activity's RUN_ACTIVITY_OUTPUT gained the
// OPTIONAL `readOnlyObservation` object (closed status enum derived from the
// READ_ONLY_OBSERVATION_STATUSES SSOT, source literal, counts, and the
// bounded writtenPaths array derived from the READ_ONLY_*_CAP SSOT constants).
// Both additive members are part of the stripped payload, so the SHA changed
// truthfully; no description text is in the stripped payload and none changed
// (M12-16-B still passes — FROZEN_22_DESC_CEILING unchanged). M12-10-H
// re-freezes the wire ceiling; this hash remains the losslessness proof.
// R10-A additive model param: the optional `model` string (per-dispatch
// model-id override) joined the shared RUN_DISPATCH_INPUT stripped payload for
// run_dispatch + run_dispatch_contract_check; SHA re-frozen truthfully.
// R11-1 additive reasoning param: the optional `reasoning` closed-set enum
// (per-dispatch reasoning effort override — the six REASONING_EFFORTS members
// as a zod enum) joined the same shared RUN_DISPATCH_INPUT stripped payload
// for both tools; SHA re-frozen truthfully.
// TD-150 批B scorecard visibility: run_status's RUN_STATUS_OUTPUT gained the
// OPTIONAL `scorecardSummary` object (names-only projection of the latest
// scorecard.checked event) — part of the stripped payload, so the SHA changed
// truthfully; no description text changed (M12-16-B still passes —
// FROZEN_22_DESC_CEILING unchanged). M12-10-H re-freezes the wire ceiling;
// this hash remains the losslessness proof.
// Re-measured for TD-153 (scorecard check-name SSOT, 2026-09-18): that same
// scorecardSummary.failedChecks narrowed to the closed-set enum + catalog-
// derived max (scorecard.js SCORECARD_CHECK_NAMES SSOT) — an output-schema
// change is part of the stripped payload, so the SHA changed truthfully; no
// description text is in the stripped payload and none changed (M12-16-B
// still passes — FROZEN_22_DESC_CEILING unchanged). Sanctioned by the Owner
// 2026-09-18 directive on the two-seat consult (auditor
// run_202609180757006603nxdsx + coder_mm run_20260918075704956eh790g).
// M12-10-H re-freezes the wire ceiling; this hash remains the losslessness
// proof.
// Re-measured for the ADR-0032 revision (2026-09-22, Owner ruling): the
// registry_list INPUT gained the optional closed-set `detail` enum and the
// OUTPUT gained the optional `certificationEvidence` array (per-seat five-
// column read-only evidence rows; applicability three-state enum + two
// ledger-source-state enums derived from the registryInventory.js SSOT).
// Both additive members are part of the stripped payload, so the SHA changed
// truthfully; no other tool's schema, name, order, or annotation changed, and
// the default registry_list projection (agents/issues/issuesTruncated) is
// byte-identical when detail is not requested. M12-10-H re-freezes the wire
// ceiling; this hash remains the losslessness proof.
// Re-measured for M13-r2 (council consult): the 23-tool surface gained
// run_consult (decision 0039) — its dual-mode input schema (consultId XOR
// brief+seats, inline-only, closed-set waitMs 0..600000) and the strict
// council-diff output-schema mirror are part of the stripped payload, so the
// SHA changed truthfully; no other tool's schema, name, order, or annotation
// changed. M12-10-H re-freezes the wire ceiling; this hash remains the
// losslessness proof.
// 0045 §1.4 第 5 步（2026-10-05）：run_dispatch/contract_check 共享入参加
// lane/role（schema 在 stripped 载荷内），SHA 如实变（无损证明语义不变）。
// 0045 窗口门（2026-10-05）：run_consult 出参镜像成员补齐——SHA 如实翻新。
// 0087（2026-10-17，Owner 批准重冻）：lead_preflight 出参增 lanes 车道画像
// 紧凑投影（LANES_PROJECTION_OUTPUT——nullable strict 对象：scale ≤240、
// 七键 dimensionLabels、rows ≤16 的 {id,七格 ratings,ratingsState,
// reviewReasons≤4,caveats≤2,cost}；星级/basis/ratingsState 闭集 enum 派生自
// laneProfile SSOT）——outputSchema 在 stripped 载荷内，SHA 如实翻新；描述句
// 变化不进 stripped 载荷（desc 顶与 hostVisible 顶均未抬、实测复验通过）。
// 0088（2026-10-17，Owner 批准放宽上限）：lanes 每行的 caveats 由前 2 条改为
// 全部（≤4）——outputSchema 的 maxItems 2→4，wire 字节不变，SHA 如实翻新。
const DESC_STRIPPED_CONTRACT_SHA =
  "38d4110294431e2bcc3220e6a24fd97da48e57ded1d49e0eae244067e101034d";
  // （历史值：2a7c060f379efbbaa5547777665a19b14c1be231e3fb3c38bc3b3459676795ac
  // 为 0087 lanes 投影的冻结值；6cb5eba776ec191fb43b658a37c520b6f70ef35cb76623663cc8dca081d3f57f
  // 为 2026-10-15/16 重冻后的实测冻结值——0087 lanes 投影之前的最后值。）
  // 2026-10-16（schema 改动，按实测更新）：run_delivery_reverify 的 input/
  // output schema 各增可选 attempt（integer 1..2）——schema 在 stripped 载荷
  // 内，SHA 如实翻新；描述句变化不进 stripped 载荷（desc 顶另行按实测重冻）。
  // TD-220（2026-10-07）：仅活动 schema 扩闭集，按实测更新无 description 合同 hash。
  // TD-226（2026-10-08）：run_delivery_repackage 出参 schema 增 REQUIRED 闭集
  // rejectionReason（nullable enum）——schema 在 stripped 载荷内，SHA 如实翻新；
  // 无描述字节变化。
  // 集成重冻（Lead，2026-10-08）：TD-227 与 TD-226 并行交付各自重冻结互不包含对方
  // （TD-227 contract_check issueCodes 扩两枚举 + TD-226 rejectionReason schema），
  // 集成后按 main 实测叠加值重冻（85222→85277，Owner 硬顶 85939 余 662B）。
  // TD-224（2026-10-08）：run_collect 出参 messages entries 增可选 const-true
  // continuation 标记 + 顶层可选 compactFallback——两条件目均在 stripped 载荷内，
  // SHA 如实翻新；无描述字节变化。
  // TD-232（2026-10-08）：run_await_result result 子 schema 增可选 compactFallback
  // （too_large 降级指引）——同样在 stripped 载荷内，SHA 如实翻新。
  // F3（2026-10-08 friction batch）：run_dispatch/run_dispatch_contract_check 共享
  // 入参 expectedGitHead 的 pattern 由两分支全形正则换成单分支 7..64 短哈希正则
  // （EXPECTED_GIT_HEAD_RE SSOT）——inputSchema 在 stripped 载荷内，SHA 如实翻新；
  // 无描述字节变化（F5 专属文案为运行时文案，不进 tools/list）。
  // TD-241 C2b（2026-10-09）：repackage/reverify 出参 schema 增 guidance 可选闭集
// 数组（在 stripped 载荷内），SHA 如实翻新；无描述字节变化。
  // 0051（2026-10-09）：run_consult 载荷合同改机械回执+按席分页——inputSchema
// 增可选 seat/page、outputSchema 重构为 view 判别双视图（去 record/attribution
// 镜像），描述扩写分页语义；SHA 与 desc 顶均如实翻新（Owner 批准的三工作批）。
// 0051 验收批（同日）：回执再剥离 perspectiveSnippet（视角全文=破帽项），回执
// 帽 6→8KiB；SHA 再翻新（描述字节未变，desc 顶不动）。
// 0052（2026-10-10）：run_dispatch/run_dispatch_contract_check 共享入参增可选
// fresh 布尔（复用会话逃生口：强制 first+epoch+1）——inputSchema 在 stripped
// 载荷内，SHA 如实翻新；无描述字节变化。
// 0056（2026-10-10，TD-250）：run_activity 出参 envelope enum 增上游会话卫生
// 四标签（upstream_session_deleted/already_gone/delete_skipped/delete_failed，
// 服务端 ENVELOPE_TYPE_TO_LABEL 增四映射的镜像）——outputSchema 在 stripped
// 载荷内，SHA 如实翻新；无描述字节变化；M12-10-H wire 帽复验通过（additive）。
// 0057（2026-10-11，TD-251）：run_activity 出参 envelope enum 再增 worktree 释放
// 四标签（worktree_released/already_gone/release_skipped/release_failed——
// 服务端 ENVELOPE_TYPE_TO_LABEL 增四映射的镜像，W1a 延迟释放+W1b 验收放树
// 共用）——outputSchema 在 stripped 载荷内，SHA 如实翻新；无描述字节变化；
// M12-10-H wire 帽复验通过（additive）。
// 0058（2026-10-11，TD-254）：run_continue 出参 rejectionReason enum 增
// lineage_closed（线系闭合拒因——CONTINUE_REJECTION_REASONS SSOT 扩员）——
// outputSchema 在 stripped 载荷内，SHA 如实翻新；无描述字节变化；帽内 additive。
  // （历史值：7fa75c7525b98023712f30a2bfc2e19ccbc6ac4cb6f4823ba4779efddd56941d
  // 为 2026-10-15 重冻前的实测冻结值；412710ee67e315ccee088b9ed58516cfe36a11c3240d6c51087362a9362f5e0f
  // 为本批首轮重冻值，同批会审修复前的实测值。）
  // 0070（2026-10-13）：run_activity 的 tool_use 条目增可选 detail、tool_result 条目增
  // tail / truncated——outputSchema 在 stripped 载荷内，SHA 如实翻新。
  // 0069（2026-10-13）：run_activity command 条目增 text / truncated、入参增 order、
  // status enum 增 serve_active；run_stop 入参增必填 reason / observedSeq——
  // inputSchema / outputSchema 都在 stripped 载荷内，SHA 如实翻新。
  // 0062（2026-10-11，TD-260 丙′）：run_activity 出参 envelope enum 再增分支回收
  // 两标签（worktree_branch_recycled/kept——服务端 ENVELOPE_TYPE_TO_LABEL 增两
  // 映射的镜像，ephemeral 只读轮树释放成功之后追加）——outputSchema 在 stripped
  // 载荷内，SHA 如实翻新；无描述字节变化；M12-10-H wire 帽复验通过（additive）。
  // 0068（2026-10-12，Owner 批准）：run_status 出参增可选 leadAdvisory（有界
  // 字符串）；run_activity 出参 runtime_status 的 status enum 增 process_active /
  // files_changed（RUNTIME_ACTIVITY_STATUSES 的镜像）——outputSchema 在 stripped
  // 载荷内，SHA 如实翻新；无描述字节变化；wire 实测 85139 → 85221（+82B），
  // M12-10-H 帽 85698 内，未重冻。


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
// 冻结线 = 实测值，只在 Owner 批准的批次里重冻；硬顶与规则见决定 0078。
// 2026-10-15（Owner 批准重冻）：会动工作区的工具改为必传 expectedWorkspaceRoot
// （见 DESC_STRIPPED_CONTRACT_SHA 重冻注释）——各工具描述各加一句必传目标说明：
// 10125→11438（实测；Owner 硬顶 12347 内）。同批会审修复：run_stop 描述改写、
// run_consult 读取模式说明、contract_check 范围说明：11438→11783（实测；硬顶同上）。
const FROZEN_23_DESC_CEILING = 11847;
// 2026-10-16（Owner 批准小幅重冻，与 wire 同批）：run_delivery_reverify 描述
// 加一句 attempt:2 第二次机会说明：11783→11856（实测；wire+desc 合计涨幅
// 批准 ≤300B，实测 +252B）。
// 2026-10-17：lead_preflight 描述改提车道分项星级，压缩原句后净减：11856→11847
//（实测，冻结线下调，未抬）。

// 冻结线 = 实测值，只在 Owner 批准的批次里重冻；口径见 measureSurface()，规则见决定 0078。
// 2026-10-15（Owner 批准重冻）：同上批次——描述句 + inputSchema 增字段进
// hostVisible：20699→22596（实测；hostVisible 无独立硬顶，在 wire 硬顶内）。
// 同批会审修复再实测：22596→22941（硬顶同上）。
const FROZEN_23_HOSTVISIBLE_CEILING = 23058;
// 2026-10-16（Owner 批准小幅重冻，与 wire/desc 同批——同一 attempt 字段的
// inputSchema 字节进 hostVisible）：22941→23067（实测；hostVisible 无独立硬顶，
// 在 wire 硬顶内）。
// 2026-10-17：lead_preflight 描述压缩净减：23067→23058（实测，冻结线下调，未抬）。

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
      // hostVisible = 逐工具 name + description + inputSchema 字节之和——与
      // scripts/measure-mcp-surface.mjs 的 hostVisibleB 同口径（决定 0078）。
      const hostVisible = tools.reduce(
        (s, t) => s + byteLen(t.name) + byteLen(t.description ?? "") + byteLen(JSON.stringify(t.inputSchema ?? {})),
        0,
      );
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
        hostVisibleBytes: hostVisible,
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
  // Same 23 tools, same names, same order.
  assert.equal(m.count, 23, `measured count is 23 (got ${m.count})`);
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

test("M12-16-B: descriptions stay under the frozen ceiling (prevents description creep)", async () => {
  const m = await measureSurface();
  // Frozen ceiling at the achieved GREEN value — prevents description creep.
  assert.ok(
    m.descBytes <= FROZEN_23_DESC_CEILING,
    `desc bytes (${m.descBytes}) <= frozen ceiling (${FROZEN_23_DESC_CEILING})`,
  );
  // Material-reduction floor vs the M12-15 baseline (PRE_M12_16_DESC_BASELINE
  // 11812 − M12_16_DESC_REDUCTION_MIN 500 = 11312): RETIRED at M13-r2, same
  // regime as M12-10-H's retired RED_23_WIRE comparison. The 23-tool surface's
  // description total (11837) structurally exceeds the 21-tool pre-slimming
  // historical baseline because TWO sanctioned tools were added since
  // (run_correct +517, run_consult +620); no description text on the existing
  // tools grew. The meaningful guards are the frozen ceiling above and the
  // M12-16-A stripped-SHA losslessness proof. The two historical consts are
  // retained below as documented references, not active assertions.
});

test("M12-16-C: hostVisible (name + description + inputSchema) at or below the frozen ceiling", async () => {
  const m = await measureSurface();
  // Frozen ceiling at the achieved value — prevents hostVisible creep (the
  // projection every host pays per session; decision 0078 / TD-286).
  assert.ok(
    m.hostVisibleBytes <= FROZEN_23_HOSTVISIBLE_CEILING,
    `hostVisible bytes (${m.hostVisibleBytes}) <= frozen ceiling (${FROZEN_23_HOSTVISIBLE_CEILING})`,
  );
});
