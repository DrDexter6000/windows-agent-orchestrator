// test/mcp-surface/mcpStatusDiagnoseTarget.test.js
//
// 批 119（A4）：run_status / run_diagnose 的可选 expectedWorkspaceRoot。
// - 带对的项目根：证明通过、归属核验通过、输出与省略该参数时同形。
// - 带错的项目根（运行属于另一项目）：fail-closed 归属拒绝——服务抛
//   code="workspace_not_authorized"，MCP 面折成同款固定文案（不回显路径/runId）。
// - 带证明不过的根：固定 target-invalid 文案（与其它读工具同款）。
// - 省略该参数：按 runId 直读，行为逐字节不变（无归属核验分支）。
// 同一服务实例上带/不带目标的调用互不影响（无共享状态）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { createWaoMcpServer } from "../../src/mcp/server.js";

function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir, stdio: "pipe" });
}

function makeRegistry(dir) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({
    agents: { w: { backend: "claude-code", cwd: dir } },
  }), "utf8");
  return registryPath;
}

// 最小 owned 转录：run.started 的 cwd 是归属事实（envelope 绑定 runId）。
function seedOwnedRun(runDir, runId, cwd) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, `${runId}.jsonl`), [
    JSON.stringify({ type: "run.submitted", runId, agentId: "w", ts: "2026-11-19T00:00:00.000Z" }),
    JSON.stringify({ type: "run.started", backend: "claude-code", ts: "2026-11-19T00:00:01.000Z", runId, agentId: "w", cwd }),
    JSON.stringify({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-11-19T00:00:02.000Z", runId, agentId: "w" }),
  ].map((l) => l + "\n").join(""), "utf8");
}

async function buildClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

const RUN_ID = "run_a4_target_001";

for (const tool of ["run_status", "run_diagnose"]) {
  test(`A4-${tool}-1: 正确项目根 → 证明+归属通过；省略参数的响应与之完全相等`, async () => {
    const owned = mkdtempSync(join(tmpdir(), "wao-a4-ok-"));
    const aux = mkdtempSync(join(tmpdir(), "wao-a4-ok-aux-"));
    try {
      makeGitRepo(owned);
      const runDir = join(aux, "runs");
      seedOwnedRun(runDir, RUN_ID, owned);
      const server = createWaoMcpServer({ registryPath: makeRegistry(aux), runDir });
      const client = await buildClient(server);
      try {
        const res = await client.callTool({ name: tool, arguments: { runId: RUN_ID, expectedWorkspaceRoot: owned } });
        assert.equal(res.isError, undefined, `must succeed: ${(res.content ?? []).map((b) => b.text ?? "").join(" ")}`);
        assert.equal(res.structuredContent.runId, RUN_ID);
        // 119 续修 2（会审必改）：同一夹具下，省略参数与带正确根的两次响应
        // 完全相等——省略 = 按 runId 直读，不引入任何其它差异。
        const omitted = await client.callTool({ name: tool, arguments: { runId: RUN_ID } });
        assert.equal(omitted.isError, undefined);
        assert.deepStrictEqual(omitted.content, res.content, "content（含 text JSON）完全相等");
        assert.deepStrictEqual(omitted.structuredContent, res.structuredContent, "structuredContent 完全相等");
      } finally { await client.close(); await server.close(); }
    } finally { cleanupDir(owned); cleanupDir(aux); }
  });

  test(`A4-${tool}-2: 错误项目根 → 归属拒绝固定文案，不回显路径/runId`, async () => {
    const owned = mkdtempSync(join(tmpdir(), "wao-a4-owned-"));
    const other = mkdtempSync(join(tmpdir(), "wao-a4-other-"));
    const aux = mkdtempSync(join(tmpdir(), "wao-a4-mm-aux-"));
    try {
      makeGitRepo(owned);
      makeGitRepo(other);
      const runDir = join(aux, "runs");
      seedOwnedRun(runDir, RUN_ID, owned);
      const server = createWaoMcpServer({ registryPath: makeRegistry(aux), runDir });
      const client = await buildClient(server);
      try {
        const res = await client.callTool({ name: tool, arguments: { runId: RUN_ID, expectedWorkspaceRoot: other } });
        assert.equal(res.isError, true, "ownership mismatch refuses");
        const text = (res.content ?? []).map((b) => b.text ?? "").join(" ");
        assert.match(text, new RegExp(`^${tool} refused: this run cannot be shown to belong to this call's workspace`));
        assert.match(text, /pass that project's root as expectedWorkspaceRoot and retry/);
        for (const p of [owned, other]) {
          assert.ok(!text.includes(p) && !text.includes(p.replace(/\\/g, "/")), "no path echo");
        }
        assert.ok(!text.includes(RUN_ID), "no runId echo");
        // 拒绝后同一实例上省略参数的直读照常（无共享状态被破坏）。
        const after = await client.callTool({ name: tool, arguments: { runId: RUN_ID } });
        assert.equal(after.isError, undefined, "omitted-target read still works after a refusal");
      } finally { await client.close(); await server.close(); }
    } finally { cleanupDir(owned); cleanupDir(other); cleanupDir(aux); }
  });

  test(`A4-${tool}-3: 证明不过的根 → 固定 target-invalid 文案`, async () => {
    const owned = mkdtempSync(join(tmpdir(), "wao-a4-inv-"));
    const aux = mkdtempSync(join(tmpdir(), "wao-a4-inv-aux-"));
    try {
      makeGitRepo(owned);
      const runDir = join(aux, "runs");
      seedOwnedRun(runDir, RUN_ID, owned);
      const server = createWaoMcpServer({ registryPath: makeRegistry(aux), runDir });
      const client = await buildClient(server);
      try {
        const res = await client.callTool({ name: tool, arguments: { runId: RUN_ID, expectedWorkspaceRoot: join(aux, "not-a-repo") } });
        assert.equal(res.isError, true);
        const text = (res.content ?? []).map((b) => b.text ?? "").join(" ");
        assert.match(text, /workspace target invalid: expectedWorkspaceRoot must be an absolute path to a canonical/);
      } finally { await client.close(); await server.close(); }
    } finally { cleanupDir(owned); cleanupDir(aux); }
  });

  test(`A4-${tool}-4: 省略参数（未绑定实例）→ 按 runId 直读成功`, async () => {
    const owned = mkdtempSync(join(tmpdir(), "wao-a4-omit-"));
    const aux = mkdtempSync(join(tmpdir(), "wao-a4-omit-aux-"));
    try {
      makeGitRepo(owned);
      const runDir = join(aux, "runs");
      seedOwnedRun(runDir, RUN_ID, owned);
      // 未绑定实例 + 无目标：run_status/run_diagnose 照常直读（不做归属核验）。
      const server = createWaoMcpServer({ registryPath: makeRegistry(aux), runDir });
      const client = await buildClient(server);
      try {
        const res = await client.callTool({ name: tool, arguments: { runId: RUN_ID } });
        assert.equal(res.isError, undefined);
        assert.equal(res.structuredContent.runId, RUN_ID);
      } finally { await client.close(); await server.close(); }
    } finally { cleanupDir(owned); cleanupDir(aux); }
  });
}

// A3 补钉：同一服务实例上两个调用互不影响（不同目标的 preflight 连续调用 +
// 无目标调用都保持各自语义——实例上没有任何共享目标状态）。
test("A3-preflight-no-shared-state: per-call targets never leak across calls on one instance", async () => {
  const a = mkdtempSync(join(tmpdir(), "wao-a3-a-"));
  const b = mkdtempSync(join(tmpdir(), "wao-a3-b-"));
  const aux = mkdtempSync(join(tmpdir(), "wao-a3-aux-"));
  try {
    makeGitRepo(a);
    makeGitRepo(b);
    const server = createWaoMcpServer({ registryPath: makeRegistry(aux), runDir: join(aux, "runs") });
    const client = await buildClient(server);
    try {
      const pa = JSON.parse((await client.callTool({ name: "lead_preflight", arguments: { expectedWorkspaceRoot: a } }))
        .content.find((x) => x.type === "text").text);
      assert.equal(pa.workspace.source, "call_target");
      assert.equal(pa.workspace.workspaceRoot.replace(/\\/g, "/"), a.replace(/\\/g, "/"));
      const pb = JSON.parse((await client.callTool({ name: "lead_preflight", arguments: { expectedWorkspaceRoot: b } }))
        .content.find((x) => x.type === "text").text);
      assert.equal(pb.workspace.source, "call_target");
      assert.equal(pb.workspace.workspaceRoot.replace(/\\/g, "/"), b.replace(/\\/g, "/"));
      // 无目标调用不被前两次调用影响：仍是未绑定（没有共享选择被建立）。
      const pn = JSON.parse((await client.callTool({ name: "lead_preflight", arguments: {} }))
        .content.find((x) => x.type === "text").text);
      assert.equal(pn.workspace.bound, false, "no shared target state was established");
      assert.equal(pn.workspace.unboundReason, "no_workspace_authority");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(a); cleanupDir(b); cleanupDir(aux); }
});
