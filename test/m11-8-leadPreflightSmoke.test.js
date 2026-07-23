// test/m11-8-leadPreflightSmoke.test.js
//
// M11-8A no-model real stdio smoke.
//
// Proves over the REAL stdio MCP transport that a fresh (unconfigured) Lead can
// discover lead_preflight and complete a full preflight in ONE call:
//   unbound server → lead_preflight(workspaceRoot) → bound lead_session +
//   worker inventory + empty active runs + complete=true. No model invoked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SHIM = join(REPO_ROOT, "scripts", "wao-node.cjs");
const STDIO_ENTRY = join(REPO_ROOT, "src", "mcp", "stdio.js");

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeGitRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
}

async function buildUnboundStdioClient({ registryPath, runDir }) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const childEnv = { ...process.env, WAO_SKIP_VERSION_GUARD: "1" };
  const args = [SHIM, STDIO_ENTRY, "--registry", registryPath, "--run-dir", runDir];
  const transport = new StdioClientTransport({ command: process.execPath, args, env: childEnv });
  const client = new Client({ name: "wao-m118-smoke", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

test("M11-8-SMOKE: unbound → lead_preflight discovers + completes full preflight in one call", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "wao m118 smoke "));
  const workspaceDir = join(baseDir, "my project");
  const waoDir = join(baseDir, "wao");
  const runDir = join(waoDir, "runs");
  try {
    mkdirSync(workspaceDir, { recursive: true });
    makeGitRepo(workspaceDir);
    mkdirSync(waoDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const registryPath = join(waoDir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { w: { backend: "claude-code", cwd: workspaceDir } },
    }), "utf8");

    // Start UNBOUND stdio server (no --workspace-root).
    const { client, transport } = await buildUnboundStdioClient({ registryPath, runDir });
    try {
      // 1. lead_preflight is discoverable.
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === "lead_preflight"), "lead_preflight discoverable over stdio");

      // 2. One call: select workspace + readiness + active runs.
      const res = await client.callTool({
        name: "lead_preflight",
        arguments: { workspaceRoot: workspaceDir },
      });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.workspace.bound, true);
      assert.equal(parsed.workspace.source, "lead_session");
      assert.ok(parsed.workspace.gitHead);
      assert.ok(Array.isArray(parsed.workers));
      assert.ok(parsed.workers.length >= 1, "worker inventory present");
      assert.ok(Array.isArray(parsed.activeRuns));
      assert.equal(parsed.complete, true, "all sections observed");
      assert.ok(Array.isArray(parsed.manualChecks) && parsed.manualChecks.length > 0);
      // No PASS/FAIL verdict.
      assert.ok(!/\bPASS\b|\bFAIL\b/i.test(JSON.stringify(parsed)));
    } finally {
      try { await transport.close(); } catch {}
    }
  } finally {
    cleanupDir(baseDir);
  }
});
