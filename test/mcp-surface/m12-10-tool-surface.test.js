// test/m12-10-tool-surface.test.js
//
// M12-10 progressive-disclosure correction — the FROZEN tool surface.
//
// WAO exposes EXACTLY 17 always-registered MCP tools. There is NO tool-profile
// model, NO startup flag, and NO restart-to-recover: every operational tool is
// independently callable for the lifetime of the connection. The built-in
// playbook catalog moved OFF the tool surface entirely (it is presented as MCP
// resources — see test/mcpPlaybook.test.js). What used to be the two playbook
// tools (`playbook_list`, `playbook_get`) are no longer tools at all. Batch 119
// (v0.10.0, Owner-approved true-removal shrink) deleted three more tools — the
// session workspace selection, the binding-status query, and the MCP long-poll
// wait — taking the surface from 23 to 20: per-call `expectedWorkspaceRoot`
// replaces the shared session selection, `lead_preflight.workspace` carries the
// binding facts, and repeated `run_await_result` (CLI `runs wait` for long
// waits) replaces the long-poll. Batch 134 (decision 0129, Owner-approved)
// folded three read-only tools into their survivors, taking the surface from 20
// to 17: `registry_list`/`runs_list` into `lead_preflight` (workers carry the
// full agent entry; optional detail/recentRuns), and `run_delivery_review_bundle`
// into `run_delivery` + `run_delivery_review`. `run_dispatch_contract_check` is
// KEPT: its check-only (preview without dispatch) and availableProfiles listing
// have no MCP equivalent (batch-134 review correction).
//
// This is a PRESENTATION/TRUTH lock, not a permission or routing layer. There
// is no branching on Host/runtime name, no `tools/list_changed` dependency, and
// no dynamic registration — the 17 tools are registered unconditionally at
// server construction.
//
// Contracts under test:
//   A — tools/list returns EXACTLY the deterministic 17-tool set, in the frozen
//       registration order, with NO `playbook_list`/`playbook_get`, NO
//       batch-119/134-removed tool, and NO profile-driven variance.
//   B — the batch-119/134-removed tools are NOT advertised and calling them
//       returns the SDK's fixed not-found; the retained contract_check handler
//       is reachable.
//   C — the toolProfile model is GONE: `createWaoMcpServer({toolProfile})` does
//       not throw and does not change the 17-tool surface for ANY value.
//   D — stdio `parseMcpArgs` IGNORES legacy `--tool-profile` as an ordinary
//       unknown flag (no parse, no output key, no throw); the legacy
//       `--registry`/`--run-dir`/`--workspace-root` parsing is byte-unchanged.
//   E — `src/mcp/toolSurface.js` is the single frozen SSOT (17 names, frozen,
//       unique, registration order); every DRILLDOWN_TOOLS carrier is a member.
//   F — `src/mcp/toolProfiles.js` is DELETED (the profile model is gone).
//   G — compacted descriptions retain the key semantic guards.
//   H — no-model wire measurement: deterministic 17-tool wire, bounded by a
//       frozen ceiling (regression protection), and honestly recorded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

// ---- Frozen closed set (the contract) ----

// Registration order exactly as emitted by tools/list. Batch 134 (decision
// 0129, Owner-approved; review correction keeps run_dispatch_contract_check):
// the former 20-tool set MINUS the three folded read-only tools = 17.
const TOOL_SET = Object.freeze([
  "lead_preflight",
  "run_dispatch", "run_dispatch_contract_check", "run_consult", "run_continue",
  "run_correct",
  "run_status", "run_collect", "run_diagnose", "run_delivery", "run_delivery_decide",
  "run_stop", "run_await_result", "run_activity",
  "run_delivery_review", "run_delivery_repackage",
  "run_delivery_reverify",
]);

// The two former playbook tools that MUST NOT appear on the tool surface.
const REMOVED_PLAYBOOK_TOOLS = Object.freeze(["playbook_list", "playbook_get"]);

// The three tools batch 119 true-removed (v0.10.0). They must NOT be advertised
// and calling them must return the SDK's fixed not-found.
const REMOVED_V10_TOOLS = Object.freeze([
  "workspace_select", "workspace_status", "run_wait",
]);

// 决定 0129（第 134 批，Owner 批准）：三个只读工具的能力并进留下的工具后
// 删除；run_dispatch_contract_check 因"只预检不派发"无等价物而保留（会审修正）。
const REMOVED_134_TOOLS = Object.freeze([
  "registry_list", "runs_list", "run_delivery_review_bundle",
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
// A — exact deterministic 20-tool set, no removed tools, no profile variance
// =====================================================================

test("M12-10-A1: tools/list returns exactly the 17-tool set in deterministic order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-a1-"));
  try {
    makeGitRepo(dir);
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      assert.deepEqual(names, TOOL_SET, "exactly the 17-tool set in registration order");
      assert.equal(names.length, 17, "exactly 17");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-10-A2: no playbook tool and no batch-119/134-removed tool is exposed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-a2-"));
  try {
    makeGitRepo(dir);
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const name of REMOVED_PLAYBOOK_TOOLS) {
        assert.ok(!names.includes(name), `${name} must NOT be a tool (catalog is resources)`);
      }
      for (const name of REMOVED_V10_TOOLS) {
        assert.ok(!names.includes(name), `${name} must NOT be a tool (v0.10.0 true-removal shrink)`);
      }
      for (const name of REMOVED_134_TOOLS) {
        assert.ok(!names.includes(name), `${name} must NOT be a tool (decision 0129 fold-in shrink)`);
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
        assert.ok(surface.has(name), `advertised tool ${name} is in the frozen 17-set`);
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
// B — removed tools are not-found; formerly-hidden contract_check stays callable
// =====================================================================

test("M12-10-B1: calling the batch-119/134-removed tools returns the SDK's fixed not-found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-b1-"));
  try {
    makeGitRepo(dir);
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    try {
      const advertised = new Set((await client.listTools()).tools.map((t) => t.name));
      for (const name of [...REMOVED_V10_TOOLS, ...REMOVED_134_TOOLS]) {
        assert.ok(!advertised.has(name), `${name} is not advertised (true-removal shrink)`);
        const res = await client.callTool({ name, arguments: {} });
        assert.equal(notFound(res), true, `${name} call returns the fixed not-found`);
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-10-B2: folded-in survivors stay advertised; the retained contract_check handler is reached (decision 0129)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-b2-"));
  try {
    makeGitRepo(dir);
    let contractCalls = 0;
    const { server, client } = await buildServerClient({
      dir,
      registryPath: makeRegistry(dir),
      overrides: {
        runDispatchContractCheckFn: async () => { contractCalls += 1; return {}; },
      },
    });
    try {
      // The folded tools' survivors plus the RETAINED contract_check are on the
      // surface; the preflight call reaches its handler (advisory payload, NOT a
      // not-found), and the contract_check handler reaches its service (the {}
      // payload then collapses to that tool's own fixed error — still not a
      // not-found).
      const advertised = new Set((await client.listTools()).tools.map((t) => t.name));
      for (const name of ["lead_preflight", "run_dispatch", "run_dispatch_contract_check", "run_delivery", "run_delivery_review"]) {
        assert.ok(advertised.has(name), `${name} stays advertised (decision 0129 surface)`);
      }
      const pf = await client.callTool({ name: "lead_preflight", arguments: {} });
      assert.equal(notFound(pf), false, "lead_preflight handler reached (not not-found)");
      const cc = await client.callTool({
        name: "run_dispatch_contract_check",
        arguments: { agentId: "coder_low", prompt: "x" },
      });
      assert.equal(contractCalls, 1, "run_dispatch_contract_check service reached");
      assert.equal(notFound(cc), false, "run_dispatch_contract_check handler reached (not not-found)");
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

test("M12-10-C1: createWaoMcpServer ignores toolProfile — same 17 tools for any value, no throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1210-c1-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir);
    // The legacy values "full" and "lead", plus a totally unknown value, must
    // all yield the SAME 17-tool surface and must NOT throw.
    for (const profile of ["full", "lead", "bogus", undefined]) {
      const { createWaoMcpServer } = await import("../../src/mcp/server.js");
      assert.doesNotThrow(() => {
        // Construct only (no connect) — proves the factory does not reject the
        // legacy param. The live surface is asserted via a connected client below
        // for the default; here we additionally build connected clients.
        createWaoMcpServer({ toolProfile: profile, registryPath, runDir: join(dir, "runs"), workspaceRoot: dir });
      }, `toolProfile=${String(profile)} must not throw`);
    }
    // Connected cross-check: default vs explicit "lead" produce identical 17-tool
    // surfaces in the same deterministic order.
    const a = await buildServerClient({ dir, registryPath });
    const b = await buildServerClient({ dir, registryPath, overrides: { toolProfile: "lead" } });
    try {
      const na = (await a.client.listTools()).tools.map((t) => t.name);
      const nb = (await b.client.listTools()).tools.map((t) => t.name);
      assert.deepEqual(na, TOOL_SET, "default = 17");
      assert.deepEqual(nb, TOOL_SET, "toolProfile:'lead' ignored → still 17");
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
// E — toolSurface.js SSOT: frozen 20-set, unique, DRILLDOWN_TOOLS ⊆ surface
// =====================================================================

test("M12-10-E1: src/mcp/toolSurface.js exports the frozen 17-tool SSOT", async () => {
  const { TOOLS } = await import("../../src/mcp/toolSurface.js");
  assert.deepEqual(TOOLS, TOOL_SET, "TOOLS == frozen 17-tool set in registration order");
  assert.equal(TOOLS.length, 17);
  assert.ok(Object.isFrozen(TOOLS), "TOOLS is frozen");
  // Uniqueness (no tool registered twice).
  assert.equal(new Set(TOOLS).size, TOOLS.length, "TOOLS has no duplicates");
  // The removed playbook tools and the batch-119/134-removed tools are NOT members.
  const set = new Set(TOOLS);
  for (const name of [...REMOVED_PLAYBOOK_TOOLS, ...REMOVED_V10_TOOLS, ...REMOVED_134_TOOLS]) {
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
    // M12-19: wait-capable tools truthfully state that Host transport
    // loss/cancellation does not stop the detached run — re-read point-in-time.
    assert.match(d("run_await_result"), /Host transport loss\/cancellation does not stop the detached run/);
    assert.match(d("run_await_result"), /re-read point-in-time/);
    // M12-19: run_activity tells the cursor-rejection recovery path (fixed
    // generic error; page-1 fresh chain or afterSeq from a known sequence).
    assert.match(d("run_activity"), /fixed generic error/);
    assert.match(d("run_activity"), /afterSeq/);
    // M12-19: the delivery waitMs contract is stated truthfully on the
    // wait-capable delivery tool (no hidden clamp, no altered range/default).
    // (决定 0129：review bundle 已删，该合同只在 run_delivery 一处陈述。)
    assert.match(d("run_delivery"), /1000\.\.300000/);
    assert.match(d("run_delivery"), /waitMs=0 is invalid/);
    // 决定 0129：lead_preflight 描述说明两个新选项与 unresolved 语义。
    assert.match(d("lead_preflight"), /detail=certificationEvidence/);
    assert.match(d("lead_preflight"), /recentRuns/);
    assert.match(d("lead_preflight"), /never inferred failed\/dead\/stopped/);
    // 决定 0129 会审修正：保留的预检工具必须写明 advisory/not a gate 与独有
    // 能力（check-only、availableProfiles）——这是它不被并进 run_dispatch 的理由。
    assert.match(d("run_dispatch_contract_check"), /advisory/i);
    assert.match(d("run_dispatch_contract_check"), /not a gate/i);
    assert.match(d("run_dispatch_contract_check"), /check-only/i);
    assert.match(d("run_dispatch_contract_check"), /available profiles/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// H — no-model wire measurement: deterministic 17-tool wire, bounded + honest
// =====================================================================

// Historical 2026-08 23-tool wire baseline (documented reference only; see M12-10-H).
const RED_23_WIRE = 75492;

// 冻结线 = 实测值，只在 Owner 批准的批次里重冻；硬顶与规则见决定 0078。
// TD-354（2026-11-20，批次合同授权的闭集扩员、additive）：run_activity 出参
// envelope enum 增固定标签 error（服务端 ENVELOPE_TYPE_TO_LABEL 增 run.error
// 映射的镜像，失败事实不再落 [unknown_event]）：87149→87157（实测；Owner 硬顶
// 94532 内）。描述与 inputSchema 零改动（desc/hostVisible 冻结线未动）。
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
// TD-267（2026-10-29，Owner 批准的批次）：run_delivery 出参增可选 verificationGate：
// 90795→91293（实测；硬顶 94532 内）。
// 第 118 批：7 个读工具加可选 expectedWorkspaceRoot：93324→93849（实测；Owner 硬顶内）。
// 第 119 批（v0.10.0 真删除式减面，Owner 批准）：删会话选择/绑定查询/MCP 长轮询
// 三个工具（23→20）；lead_preflight 输入改名 expectedWorkspaceRoot、workspace 增
// workspaceRoot/call_target、run_status/run_diagnose 增可选目标、runs_list scope
// 收 call_target 语义：93849→87149（实测；Owner 硬顶 94532 内）。
// 第 134 批（决定 0129，Owner 批准的真删除式减面 + 会审修正）：删 registry_list /
// runs_list / run_delivery_review_bundle 三个只读工具（能力并入 lead_preflight 与
// 原子审查对；run_dispatch_contract_check 因"只预检不派发"与 availableProfiles
// 无等价物而**保留**），lead_preflight 输入增 detail/recentRuns（recentRuns 带
// limit 1..100 与 activeOnly）、workers 条目改 AGENT_ENTRY 同形且**不设上限**、
// 输出增可选 certificationEvidence/recentRuns、run_dispatch 出参增可选
// contractAdvisories：87157→76543（实测；Owner 硬顶 94532 内；仍低于 2a1875ac
// 的 87157）。三条冻结线与 SHA 均按实测下调重冻。
// 第 135 批（决定 0130，Owner 2026-11-22 同意执行头脑风暴结论；本批任务书授权
// 重冻，只降不升）：八个写类工具的 inputSchema 把 expectedWorkspaceRoot 标
// required（run_dispatch 从与 contract_check 共享的基础对象派生严格版），
// DELIVERY_INPUT 的 mode 可省（缺省 git_commit_v1）、run_continue 的 delivery
// 可省（省略继承父运行已生效合同）；八工具描述同步精简抵消（"is required" 句、
// 与 schema 重复的枚举句等）：76543→76532（实测；Owner 硬顶 94532 内）。
// 第 135 批续修（两席会审 FIX_FIRST 后 Lead 裁定）：run_continue 出参增可选
// guidance（仅继承合同复验失败的拒绝携带，+45B schema），run_collect 恢复
// "cursor = prior nextCursor"、run_stop 恢复 "(any worker event)"（schema 表达
// 不了的指路语义），同批压 reverify/repackage/stop/continue 的 schema 重复措辞
// 抵消：76532→76535（实测；不高于 main 的 76543，Owner 硬顶 94532 内）。
// 第 141b 批（决定 0021 / 0078 手续，Owner 批准本批合理抬高上限）：run_dispatch 入参增
// 可选 taskType（enum ["image"]，决定 0131 §5；只加在派发 schema 上，预检工具的输入面
// 不动）、run_diagnose 出参增可选 isolationViolation（reason/destination 闭集 enum、
// 三个路径字段 maxLength 300；只在 workdir_escape 且有可信字段时带，TD-373 的 MCP 面）、
// run_activity 出参 envelope enum 增固定标签 isolation_violation（服务端
// ENVELOPE_TYPE_TO_LABEL 增 run.isolation_violation 映射的镜像）：76535→77446（实测；
// 改动前同口径实测 76529；Owner 硬顶 94532 内）。
const FROZEN_17_WIRE_CEILING = 77446;
// 第 87 批（TD-343，Owner 2026-11-08 批准重冻）：lead_preflight 描述补 open item
// 行：93212→93324（实测；Owner 硬顶 94532 内）。inputSchema/outputSchema 零改动。
// （scripts/measure-mcp-surface.mjs 的 fullWire=93358 与本测量的口径差是
// JSON-RPC 响应整行 vs JSON.stringify({tools}) 的封套差，非面变更。）
// TD-329（2026-11-03，TD-329 批次合同授权重冻；闭集扩员、additive）：run_diagnose 与
// run_await_result 出参 code enum 增 overloaded（PROVIDER_CAPACITY_DIAGNOSIS_CODES
// SSOT 扩员——上游模型满载的瞬时容量事实）：93186→93212（实测；Owner 硬顶 94532 内）。
// 描述与 inputSchema 零改动（desc/hostVisible 冻结线未动）。
// TD-327（2026-11-01，Owner 批准重冻；闭集扩员、additive）：run_continue 出参 rejectionReason
// enum 增 explicit_dispatch_continuable_unsupported（CONTINUE_REJECTION_REASONS
// SSOT 扩员）：93142→93186（实测；Owner 硬顶 94532 内）。描述与 inputSchema
// 零改动（desc/hostVisible 冻结线未动）。
// 0098（2026-10-30，Owner 批准本批重冻）：run_delivery 出参增 adoption 三态
// 对象（status/commits≤5/truncated/uncheckedReason，闭集从 adoptionQuery SSOT
// 派生；BASE 不带——review bundle 嵌 BASE 字节不变）、lead_preflight lanes
// 每行增 videoInput：92639→93142（实测；Owner 硬顶 94532 内）。描述与
// inputSchema 零改动（desc/hostVisible 冻结线未动）。
// 0097（2026-10-30，Owner 批准的批次）：选车道的关键事实送到 Lead 面前——
// lead_preflight 出参 lanes 增 costTierScale/ownerRules 顶层键、每行增 costTier、
// research/code/review 三格增可选 score；run_dispatch 出参增可选 laneFacts：
// 91730→92639（实测；Owner 硬顶 94532 内）。描述与 hostVisible 冻结线未动
//（描述与 inputSchema 零改动）。
// 0096（2026-10-30，Owner 批准的批次）：run_consult 回执增可选 nextStep（string
// ≤480）与描述一句"有未终态席位时带 nextStep"：91612→91730（实测；Owner 硬顶
// 94532 内）。
// 0095（2026-10-29，Owner 批准的批次）：Lead 及时得知运行收口——run_wait 输入
// 下限 30000/缺省 45000、出参增可选 nextStep；run_await_result/run_consult/
// run_delivery_review_bundle 的 MCP 缺省改 45000；run_delivery 出参增可选
// nextStep；run_dispatch/run_continue 出参增可选 nextStep；相关描述同步：
// 91293→91612（实测；Owner 硬顶 94532 内）。
// 2026-10-16（Owner 批准小幅重冻）：run_delivery_reverify 入参/出参增可选
// attempt（1|2，缺省 1——第二次显式重验机会），描述加一句第二次机会说明：
// 88048→88227（实测；本批批准 wire+desc 合计涨幅 ≤300B，实测合计 +252B）。
// 2026-10-17（Owner 批准重冻）：lead_preflight 出参增 lanes 车道画像紧凑投影
//（scale/dimensionLabels/rows——七格 {stars,basis,n,note}、待复核状态与原因、
// caveats 前 2、cost；独立子 schema 校验，不合格置 null 不连累其余各节），
// 描述改提车道分项星级并压缩原句腾字节（desc/hostVisible 冻结线未抬）：
// 88227→90661（实测；Owner 硬顶 94532 内）。
// 0089（2026-10-17 Owner 批准放宽画像预算）：lanes 每行增 dispatchHold、
// contextWindowTokens、imageInput，七格改为可缺省（未评不投影）：
// 90661→90744（实测；描述未改，desc/hostVisible 冻结线未动）。
// 0090（2026-10-18，Owner 的画像预算授权）：lanes 每行增 family（推断族系，
// 会审选不同族系的副审用）：90744→90795（实测；描述未改，desc/hostVisible 冻结线未动）。

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

test("M12-10-H: deterministic 17-tool wire at or below the frozen ceiling", async () => {
  const m = await measureWire();
  // The surface is exactly 17 (re-asserted for the measured server).
  assert.equal(m.count, 17, `measured count is 17 (got ${m.count})`);
  assert.deepEqual(m.names, TOOL_SET, "measured set == frozen 17-set");
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
  assert.ok(m.wireBytes <= FROZEN_17_WIRE_CEILING,
    `17-tool wire (${m.wireBytes}) <= frozen ceiling (${FROZEN_17_WIRE_CEILING})`);
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
// 0089（2026-10-17，Owner 批准放宽画像预算）：lanes 每行增 dispatchHold、
// contextWindowTokens、imageInput，七格改为 optional——SHA 如实翻新。
// 0090（2026-10-18）：lanes 每行增 family（string ≤32）——SHA 如实翻新。
// 0088 修订条（2026-10-28，Owner 批准放宽）：lanes 每行的 caveats 上限 4→6
// （CAVEATS_CAP）——outputSchema 的 maxItems 改一位数，wire 字节不变，SHA 如实翻新。
// TD-354（2026-11-20，批次合同授权的闭集扩员、additive）：run_activity 出参
// envelope enum 增固定标签 error（服务端 ENVELOPE_TYPE_TO_LABEL 增 run.error
// 映射的镜像——失败事实此前落 [unknown_event]）——outputSchema 在 stripped 载荷
// 内，SHA 如实翻新；无描述字节变化；wire 帽同批重冻（87149→87157，帽内 additive）。
// TD-267（2026-10-29，Owner 批准的批次）：run_delivery 出参增可选 verificationGate——SHA 如实翻新。
// 0096（2026-10-30，Owner 批准的批次）：run_consult 出参增可选 nextStep——outputSchema
// 在 stripped 载荷内，SHA 如实翻新（决定 0096，工具面重冻）。
// 0097（2026-10-30，Owner 批准的批次）：lanes 投影增 costTierScale/ownerRules/
// costTier 与三格可选 score、run_dispatch 增可选 laneFacts——outputSchema 在
// stripped 载荷内，SHA 如实翻新（决定 0097，工具面重冻；描述与 inputSchema
// 零改动，desc/hostVisible 冻结线未动）。
// TD-329（2026-11-03，TD-329 批次合同授权重冻；闭集扩员、additive）：run_diagnose 与
// run_await_result 出参 code enum 增 overloaded（PROVIDER_CAPACITY_DIAGNOSIS_CODES
// SSOT 扩员——上游模型满载的瞬时容量事实）——outputSchema 在 stripped 载荷内，
// SHA 如实翻新；无描述字节变化；wire 帽同批重冻（93186→93212，帽内 additive）。
// （历史值：e91d5a6e1fddf5850ff8a9df0514892e69d5f2d20a2b77d324c978809f7776f1
// 为 TD-327 explicit_dispatch_continuable_unsupported 后的冻结值。）
// 0114（2026-11-05，决定 0114）：run_continue 出参 rejectionReason enum 删除
// explicit_dispatch_continuable_unsupported（explicit 父档可续；CONTINUE_REJECTION_REASONS
// SSOT 缩员）——outputSchema 在 stripped 载荷内，SHA 如实翻新；描述与 inputSchema
// 零改动（desc/hostVisible 冻结线未动）。（历史值：5f79ca12afe1d343f606547a5d3fe2d1e2549344e86fda618cdee6c6bbf73d55
// 为 TD-329 后的冻结值。）
// 第 118 批：7 个读工具输入增 expectedWorkspaceRoot、runs_list scope.source 增
// call_target——schema 在 stripped 载荷内，SHA 如实翻新；描述零增量。
// 第 134 批（决定 0129，Owner 批准 + 会审修正）：三个只读工具整面移出
//（registry_list / runs_list / run_delivery_review_bundle 的 schemas 随之离开
// stripped 载荷）；run_dispatch_contract_check **保留**（其 schema 仍在
// stripped 载荷内）；lead_preflight 输入增 detail/recentRuns（recentRuns 的
// limit/activeOnly 对象）、workers 改 AGENT_ENTRY 同形且不设 max、输出增可选
// certificationEvidence/recentRuns、run_dispatch 出参增可选 contractAdvisories
// ——SHA 如实翻新。（历史值：
// 90e8445d93d72b778e75ebed3cc9da503d0c1cf5cf7760bf4d5deadabe5528d2 为
// 0129 首轮（四删、20→16）后的冻结值；
// b5abee2571f96bcbbeaa1742a54ab6be0bf21c1ef7cc9c2dcc2fbdc6665d3667 为
// TD-354 后的冻结值。）
// 第 135 批（决定 0130，本批任务书授权重冻）：八个写类工具 inputSchema 的
// expectedWorkspaceRoot 标 required（run_dispatch 从共享基础对象派生严格版）、
// DELIVERY_INPUT 的 mode 可省、run_continue 的 delivery 可省——SHA 如实翻新。
// （历史值：d398828b8eef5da845ed66f579ab4906860303b3a7989556e8c2644ac70625b8
// 为第 134 批后的冻结值。）
// 第 135 批续修：run_continue 出参增可选 guidance——SHA 如实翻新。
// （历史值：82b48f5bd1f7fa26c1d0685d61313c14e9f08d877fe3239104a83a7ca03a46fc
// 为第 135 批首交付（cfbf522f）的冻结值。）
// 第 141b 批（决定 0021 / 0078 手续，Owner 批准本批合理抬高上限）：run_dispatch 入参增
// 可选 taskType（enum ["image"]）、run_diagnose 出参增可选 isolationViolation、
// run_activity 出参 envelope enum 增 isolation_violation——三处 schema 都在 stripped
// 载荷内，SHA 如实翻新；描述只有 run_dispatch 增一句 taskType 说明（不进 stripped 载荷）。
// （历史值：e3de9cbb1ba6720b0d6e750b267d841727fcbbafa31749c4aecc1f75ea8e7295
// 为第 135 批续修后的冻结值。）
const DESC_STRIPPED_CONTRACT_SHA =
  "e2db4509d342a49eb33866c19b134ba0af5c411cc48b268e7c927bb7f222927a";
// 第 119 批（v0.10.0 真删除式减面，Owner 批准）：三个工具整面移出（schemas 随之
// 离开 stripped 载荷）、lead_preflight 输入改名 expectedWorkspaceRoot 并增
// workspaceRoot/call_target、run_status/run_diagnose 输入增可选目标——SHA 如实翻新。
// （历史值：0be12f41e3926e9cb4dd85bffd9f2d3d5d7d0ee32e2cd26d2de2b9386a183360
// 为第 118 批后的冻结值。）
// TD-327（2026-11-01，Owner 批准重冻；闭集扩员、additive）：run_continue 出参 rejectionReason
// enum 增 explicit_dispatch_continuable_unsupported（TD-327 具名拒因——
// CONTINUE_REJECTION_REASONS SSOT 扩员）——outputSchema 在 stripped 载荷内，
// SHA 如实翻新；无描述字节变化；wire 帽同批重冻（93142→93186），帽内 additive。
// （历史值：a31ff42f8790f05601d26907f6907db16d8f05c7613544066660d1cc298702d1
// 为 0098 adoption/videoInput 后的冻结值。）
// 0098（2026-10-30，Owner 批准本批重冻）：run_delivery 出参增 adoption 三态
// 对象、lead_preflight lanes 每行增 videoInput——两个 outputSchema 都在
// stripped 载荷内，SHA 如实翻新（描述与 inputSchema 零改动，desc/hostVisible
// 冻结线未动；BASE 不带 adoption，review bundle 嵌 BASE 字节不变）。
// （历史值：73e46657303d73dea7750a8575ea58bf367671190183254742837c241bc14844
// 为 0097 lanes costTier/score 与 laneFacts 后的冻结值；38e9f93b791e5c9cc21fb3289584f55b109a6c688eaa019cd2d467b8527413a3
// 为 0096 run_consult nextStep 后的冻结值。）
// 0095（2026-10-29）：run_wait/run_delivery/run_dispatch/run_continue 出参增
// 可选 nextStep（string≤480，取自 LEAD_ADVISORY_WIRE_MAX_LEN）、run_wait 输入
// waitMs 的 min/default 变化（30000/45000）——schema 在 stripped 载荷内，SHA
// 如实翻新（决定 0095，Owner 批准本批重冻）。
  // （历史值：3b3e4fe6fa873d9bcf800218f95af41c132179f0514b58bdce1e1bce1bc6e556
  // 为 0088 修订条放宽 caveats 上限后的冻结值；b103cb7263a9a02c4036a1149788975487630e500945331e5122febac0b7712d
  // 为 0090 family 字段增补后的冻结值；ccd1adeb0bab708e5fa7cbf85032090e3a5ef72ac52000e1caa304239c60db61
  // 为 0089 投影字段增补后的冻结值；38d4110294431e2bcc3220e6a24fd97da48e57ded1d49e0eae244067e101034d
  // 为 0088 caveats 放宽后的冻结值；2a7c060f379efbbaa5547777665a19b14c1be231e3fb3c38bc3b3459676795ac
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
// 第 118 批：7 个读工具加可选 expectedWorkspaceRoot：12219→12219（实测；Owner 硬顶内）。
// 第 119 批（v0.10.0 真删除式减面，Owner 批准）：删三工具、preflight 描述改写、
// run_status/run_diagnose 描述加目标根一句：12219→11291（实测；Owner 硬顶 12347 内）。
// 第 134 批（决定 0129，Owner 批准 + 会审修正）：删三个只读工具、保留
// contract_check（其描述随之回面）、lead_preflight 描述加新选项说明与
// unresolved 语义句：11291→10402（实测；Owner 硬顶 12347 内；仍低于 2a1875ac
// 的 11291）。
// 第 135 批（决定 0130，本批任务书授权重冻，只降不升）：八写类工具描述删
// "is required" 句（schema 标必填后冗余），同批压 schema 重复的枚举句
// （closed-set outcome、cursor=nextCursor、accepted/rejected）与 stop 的
// "(any worker event)" 等：10402→10231（实测；Owner 硬顶 12347 内）。
// 第 135 批续修：恢复 cursor=nextCursor 与 "(any worker event)" 两句（schema
// 表达不了），同批压 reverify/repackage/stop/continue 的重复措辞净减：
// 10231→10189（实测；不高于 main 的 10402，Owner 硬顶 12347 内）。
// 第 141b 批（决定 0021 / 0078 手续，Owner 批准本批合理抬高上限）：run_dispatch 描述加
// 一句 taskType:"image" 的说明（生图任务、给 Owner 看板分类用，不影响派发）：
// 10189→10296（实测；改动前同口径实测 10183；Owner 硬顶 12347 内）。
const FROZEN_17_DESC_CEILING = 10296;
// 第 87 批（TD-343，Owner 2026-11-08 批准重冻）：lead_preflight 描述补 open item
// 行：12063→12219（实测；Owner 硬顶 12347 内）。
// 0096（2026-10-30，Owner 批准的批次）：run_consult 描述加一句"回执在有未终态
// 席位时带 nextStep"：11990→12063（实测；Owner 硬顶 12347 内）。
// 0095（2026-10-29，Owner 批准重冻）：run_wait 描述改写区间/缺省并加 nextStep
// 一句：11847→11990（实测）。
// 2026-10-16（Owner 批准小幅重冻，与 wire 同批）：run_delivery_reverify 描述
// 加一句 attempt:2 第二次机会说明：11783→11856（实测；wire+desc 合计涨幅
// 批准 ≤300B，实测 +252B）。
// 2026-10-17：lead_preflight 描述改提车道分项星级，压缩原句后净减：11856→11847
//（实测，冻结线下调，未抬）。

// 冻结线 = 实测值，只在 Owner 批准的批次里重冻；口径见 measureSurface()，规则见决定 0078。
// 2026-10-15（Owner 批准重冻）：同上批次——描述句 + inputSchema 增字段进
// hostVisible：20699→22596（实测；hostVisible 无独立硬顶，在 wire 硬顶内）。
// 同批会审修复再实测：22596→22941（硬顶同上）。
// 第 118 批：7 个读工具加可选 expectedWorkspaceRoot：23426→23937（实测；Owner 硬顶内）。
// 第 119 批（v0.10.0 真删除式减面，Owner 批准）：删三工具、其余 inputSchema 增删
// 如批注：23937→22436（实测；hostVisible 无独立硬顶，在 wire 硬顶 94532 内）。
// 第 134 批（决定 0129，Owner 批准 + 会审修正）：删三个只读工具、保留
// contract_check、preflight 输入增 recentRuns 对象（limit/activeOnly）+ workers
// 不设 max：22436→20870（实测；hostVisible 无独立硬顶，在 wire 硬顶 94532 内；
// 仍低于 2a1875ac 的 22436）。
// 第 135 批（决定 0130，本批任务书授权重冻，只降不升）：inputSchema 的
// required 增八条、mode/delivery 必填项减少，描述精简抵消后按实测：
// 20870→20859（hostVisible 无独立硬顶，在 wire 硬顶 94532 内）。
// 第 135 批续修：guidance 字段进 outputSchema（+45B）、两句描述恢复与同批
// 精简相抵后按实测：20859→20817（不高于 main 的 20870，wire 硬顶 94532 内）。
// 第 141b 批（决定 0021 / 0078 手续，Owner 批准本批合理抬高上限）：run_dispatch 的
// taskType 入参字段与描述一句进 hostVisible：20817→20970（实测；改动前同口径实测
// 20811；hostVisible 无独立硬顶，在 wire 硬顶 94532 内）。
const FROZEN_17_HOSTVISIBLE_CEILING = 20970;
// 第 87 批（TD-343，Owner 2026-11-08 批准重冻）：lead_preflight 描述补 open item
// 行：23270→23426（实测；hostVisible 无独立硬顶，在 wire 硬顶 94532 内）。
// 0096（2026-10-30，Owner 批准的批次）：run_consult 的 nextStep 输出字段与描述句
// 进 hostVisible：23197→23270（实测）。
// 0095（2026-10-29，Owner 批准重冻）：与 wire/desc 同批——nextStep 输出字段与
// 新默认值进 inputSchema/description：23058→23197（实测）。
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
  // Same 17 tools, same names, same order.
  assert.equal(m.count, 17, `measured count is 17 (got ${m.count})`);
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
    m.descBytes <= FROZEN_17_DESC_CEILING,
    `desc bytes (${m.descBytes}) <= frozen ceiling (${FROZEN_17_DESC_CEILING})`,
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
    m.hostVisibleBytes <= FROZEN_17_HOSTVISIBLE_CEILING,
    `hostVisible bytes (${m.hostVisibleBytes}) <= frozen ceiling (${FROZEN_17_HOSTVISIBLE_CEILING})`,
  );
});
