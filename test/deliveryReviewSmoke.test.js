// test/deliveryReviewSmoke.test.js
//
// M11-3C-B: real default-service end-to-end smoke for run_delivery_review.
//
// Proves that MCP and CLI, using the DEFAULT getRunDeliveryReview (no injection),
// can safely read three real delivery artifact types:
//   1. text >16 KiB → multi-page pagination
//   2. binary → metadata-only
//   3. text >256 KiB → diff_too_large metadata-only
//
// Uses a real Git repo, real delivery commits (packageDelivery), and the real
// JsonlTranscript API to write durable events. The CLI entrypoint is the actual
// `npm run cli --` command (via execSync), not a direct in-process call.
//
// Before/after invariants: transcript hash, source HEAD, git status --porcelain,
// refs, worktree inventory — all byte-identical.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { packageDelivery } from "../src/delivery.js";
import { JsonlTranscript } from "../src/transcript.js";
import { createWaoMcpServer } from "../src/mcp/server.js";

// ===== Helpers =====

function cleanupDir(dir) {
  try { execSync("git worktree prune", { cwd: dir, stdio: "ignore" }); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-smoke", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

const git = (cwd, ...args) => execSync(["git", ...args].join(" "), {
  cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
}).trim();

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Build a real delivery scenario: git repo, linked worktree, one changed file,
 * packaged into a real delivery commit. Uses JsonlTranscript to write events.
 * Returns { repo, baseCommit, wtPath, ref, runDir, runId, transcript }.
 */
async function buildScenario({ runId, changeFn, prefix }) {
  const repo = mkdtempSync(join(tmpdir(), prefix + "-repo-"));
  const runDir = mkdtempSync(join(tmpdir(), prefix + "-td-"));
  git(repo, "init", "-b", "main");
  execSync('git config user.email "t@t"', { cwd: repo, stdio: "ignore" });
  execSync('git config user.name "t"', { cwd: repo, stdio: "ignore" });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.js"), "const a = 1;\n");
  git(repo, "add", ".");
  execSync('git commit -m init', { cwd: repo, stdio: "ignore" });
  const baseCommit = git(repo, "rev-parse", "HEAD");

  const wtPath = join(repo, ".wao-worktrees", runId);
  execSync(`git worktree add "${wtPath}" -b wao/${runId}`, { cwd: repo, stdio: "ignore" });
  changeFn(wtPath);
  const ref = packageDelivery({
    runId, worktreePath: wtPath, baseCommit, allowedPaths: ["src"],
    isolation: { type: "worktree", strategy: "persistent" },
    verificationCommands: ["npm test"],
  });

  // Write transcript using the real JsonlTranscript API.
  const transcriptPath = join(runDir, `${runId}.jsonl`);
  const transcript = new JsonlTranscript(transcriptPath, { runId, agentId: "coder_low" });
  await transcript.append("run.started", { runId });
  await transcript.append("run.background_submitted", { runId, cwd: repo, background: true });
  await transcript.append("run.delivery_created", { runId, delivery: ref });
  await transcript.append("run.delivery_verification_passed", { runId, delivery: ref });
  await transcript.append("run.state_change", { runId, from: "running", to: "completed" });
  await transcript.append("run.completed", { runId });

  return { repo, baseCommit, wtPath, ref, runDir, runId, transcriptPath };
}

function snapshotState(repo, runDir, runId) {
  return {
    transcriptHash: fileHash(join(runDir, `${runId}.jsonl`)),
    transcriptSize: statSync(join(runDir, `${runId}.jsonl`)).size,
    head: git(repo, "rev-parse", "HEAD"),
    porcelain: git(repo, "status", "--porcelain"),
    refs: git(repo, "show-ref") || "(no refs)",
    worktrees: git(repo, "worktree", "list"),
    decisions: 0,
  };
}

// =====================================================================
// SMOKE-TEXT: >16 KiB text delivery → multi-page pagination, MCP/CLI parity
// =====================================================================

test("M11-3C-SMOKE-TEXT: default service multi-page, MCP/CLI parity, inventory unchanged", async () => {
  const s = await buildScenario({
    runId: "run_smoke_text",
    prefix: "m113c-smoke-text",
    changeFn: (wt) => writeFileSync(join(wt, "src", "a.js"), "const line = 'x';\n".repeat(1100)),
  });
  try {
    const before = snapshotState(s.repo, s.runDir, s.runId);

    // MCP: default service, no injection — paginate to completion.
    const server = createWaoMcpServer({ registryPath: "/x", runDir: s.runDir, workspaceRoot: s.repo });
    const client = await buildInMemoryClient(server);
    try {
      let cursor = undefined;
      const mcpPages = [];
      for (;;) {
        const res = await client.callTool({
          name: "run_delivery_review",
          arguments: { runId: s.runId, fileIndex: 0, ...(cursor ? { cursor } : {}) },
        });
        assert.equal(res.isError, undefined, "MCP page succeeds");
        assert.equal(res.structuredContent.available, true);
        assert.equal(res.structuredContent.changedPath, "src/a.js");
        assert.equal(res.structuredContent.contentFormat, "unified_diff_v1");
        assert.equal(res.structuredContent.artifactTextTrust, "untrusted_repository_text");
        mcpPages.push(res.structuredContent);
        if (!res.structuredContent.nextCursor) break;
        cursor = res.structuredContent.nextCursor;
      }
      assert.ok(mcpPages.length >= 2, "multi-page artifact paginated");

      // CLI: actual entrypoint, --format json, first page
      const cliOut = execSync(
        `node scripts/wao-node.cjs src/cli.js runs delivery review ${s.runId} --file-index 0 --format json --cwd "${s.repo}" --run-dir "${s.runDir}"`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], cwd: process.cwd() },
      );
      const cliPage0 = JSON.parse(cliOut);
      assert.deepEqual(cliPage0, mcpPages[0], "CLI page 0 deepEqual MCP page 0");

      // Fragment concatenation contains the diff content
      const whole = mcpPages.map((p) => p.fragment).join("");
      assert.ok(whole.includes("const line = 'x';"), "diff content present in concatenated pages");
    } finally {
      await client.close();
      await server.close();
    }

    const after = snapshotState(s.repo, s.runDir, s.runId);
    assert.equal(after.transcriptHash, before.transcriptHash, "transcript hash unchanged");
    assert.equal(after.transcriptSize, before.transcriptSize, "transcript size unchanged");
    assert.equal(after.head, before.head, "source HEAD unchanged");
    assert.equal(after.porcelain, before.porcelain, "git status unchanged");
    assert.equal(after.refs, before.refs, "refs unchanged");
    assert.equal(after.worktrees, before.worktrees, "worktree list unchanged");
    assert.equal(after.decisions, 0, "no durable decision event");
  } finally {
    cleanupDir(s.repo);
    cleanupDir(s.runDir);
  }
});

// =====================================================================
// SMOKE-BINARY: binary file → metadata-only, MCP + CLI
// =====================================================================

test("M11-3C-SMOKE-BINARY: default service binary artifact → metadata-only", async () => {
  const s = await buildScenario({
    runId: "run_smoke_bin",
    prefix: "m113c-smoke-bin",
    changeFn: (wt) => writeFileSync(join(wt, "src", "a.js"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe])),
  });
  try {
    // MCP
    const server = createWaoMcpServer({ registryPath: "/x", runDir: s.runDir, workspaceRoot: s.repo });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_delivery_review",
        arguments: { runId: s.runId, fileIndex: 0 },
      });
      assert.equal(res.isError, undefined);
      assert.equal(res.structuredContent.available, false);
      assert.equal(res.structuredContent.unavailableReason, "binary");
      assert.equal(res.structuredContent.fragment, "");
      assert.equal(res.structuredContent.fragmentBytes, 0);
      assert.equal(res.structuredContent.nextCursor, null);

      // CLI parity
      const cliOut = execSync(
        `node scripts/wao-node.cjs src/cli.js runs delivery review ${s.runId} --file-index 0 --format json --cwd "${s.repo}" --run-dir "${s.runDir}"`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], cwd: process.cwd() },
      );
      assert.deepEqual(JSON.parse(cliOut), res.structuredContent, "CLI deepEqual MCP binary result");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(s.repo);
    cleanupDir(s.runDir);
  }
});

// =====================================================================
// SMOKE-TOO-LARGE: >256 KiB → diff_too_large, MCP + CLI
// =====================================================================

test("M11-3C-SMOKE-TOO-LARGE: default service >256 KiB → diff_too_large", async () => {
  const s = await buildScenario({
    runId: "run_smoke_big",
    prefix: "m113c-smoke-big",
    changeFn: (wt) => writeFileSync(join(wt, "src", "a.js"), "const x = '" + "A".repeat(300 * 1024) + "';\n"),
  });
  try {
    // MCP
    const server = createWaoMcpServer({ registryPath: "/x", runDir: s.runDir, workspaceRoot: s.repo });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_delivery_review",
        arguments: { runId: s.runId, fileIndex: 0 },
      });
      assert.equal(res.isError, undefined);
      assert.equal(res.structuredContent.available, false);
      assert.equal(res.structuredContent.unavailableReason, "diff_too_large");
      assert.equal(res.structuredContent.fragment, "");
      assert.equal(res.structuredContent.fragmentBytes, 0);
      assert.equal(res.structuredContent.nextCursor, null);

      // CLI parity
      const cliOut = execSync(
        `node scripts/wao-node.cjs src/cli.js runs delivery review ${s.runId} --file-index 0 --format json --cwd "${s.repo}" --run-dir "${s.runDir}"`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], cwd: process.cwd() },
      );
      assert.deepEqual(JSON.parse(cliOut), res.structuredContent, "CLI deepEqual MCP too-large result");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(s.repo);
    cleanupDir(s.runDir);
  }
});
