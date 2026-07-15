// test/workspaceBinding.test.js
//
// M10-pre2 Batch A: workspace binding application service — TDD RED tests.
//
// This module proves that a host-authorized absolute path is a real Git worktree
// top-level directory, reads its HEAD commit and dirty status, and rejects
// everything else (relative paths, non-existent dirs, non-Git dirs, subdirs of
// Git repos, malformed Git output).
//
// Contract:
//   - Input: an absolute path (from MCP roots or explicit --workspace-root).
//   - Output: { root: <canonical absolute path>, gitHead: <hex>, dirty: <boolean> }
//   - Failures throw — caller (MCP/CLI) decides how to surface them.
//   - Never uses shell command strings — always execFile/execFileSync.
//   - Does NOT import src/mcp/*, src/commands/*, or MCP SDK.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { proveWorkspace } from "../src/application/workspaceBinding.js";

// ===== Helpers: create temporary Git repos for testing =====

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "wao-ws-"));
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

/**
 * Create a temporary Git repo with one initial commit.
 * Returns { dir, headCommit }.
 */
function makeGitRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  return { dir, headCommit: head };
}

// ===== Tests =====

// 1. Absolute Git top-level path → canonical root, full HEAD, dirty=false
test("WS-01: clean Git repo → bound with canonical root, full HEAD, dirty=false", () => {
  const tmp = makeTempDir();
  try {
    const { dir, headCommit } = makeGitRepo(tmp);
    const result = proveWorkspace(dir);
    assert.equal(result.root, dir.replace(/\\/g, "/"));
    assert.equal(result.gitHead, headCommit);
    assert.equal(result.dirty, false);
  } finally {
    cleanupDir(tmp);
  }
});

// 2. dirty repo → dirty=true, still bound
test("WS-02: dirty Git repo → bound, dirty=true", () => {
  const tmp = makeTempDir();
  try {
    makeGitRepo(tmp);
    // Make it dirty: add an untracked file + modify a tracked file
    writeFileSync(join(tmp, "untracked.txt"), "x", "utf8");
    writeFileSync(join(tmp, "README.md"), "# modified\n", "utf8");
    const result = proveWorkspace(tmp);
    assert.equal(result.root, tmp.replace(/\\/g, "/"));
    assert.equal(result.dirty, true);
  } finally {
    cleanupDir(tmp);
  }
});

// 3. Path with spaces; Windows-feasible non-ASCII
test("WS-03: path with spaces → bound", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wao ws spaces "));
  try {
    const { dir, headCommit } = makeGitRepo(tmp);
    const result = proveWorkspace(dir);
    // proveWorkspace normalizes paths (realpath + forward slash); compare canonical form.
    const expected = dir.replace(/\\/g, "/");
    assert.equal(result.root, expected);
    assert.equal(result.gitHead, headCommit);
  } finally {
    cleanupDir(tmp);
  }
});

// 4. Relative path rejected
test("WS-04: relative path rejected", () => {
  assert.throws(() => proveWorkspace("relative/path"));
  assert.throws(() => proveWorkspace("./relative"));
});

// 5. Non-existent directory rejected
test("WS-05: non-existent directory rejected", () => {
  assert.throws(() => proveWorkspace(join(tmpdir(), "definitely-nonexistent-ws-05")));
});

// 6. Non-Git directory rejected
test("WS-06: non-Git directory rejected", () => {
  const tmp = makeTempDir();
  try {
    writeFileSync(join(tmp, "file.txt"), "not a git repo", "utf8");
    assert.throws(() => proveWorkspace(tmp));
  } finally {
    cleanupDir(tmp);
  }
});

// 7. Git repo subdirectory rejected (must not silently expand authorization)
test("WS-07: Git repo subdirectory rejected (no silent upward expansion)", () => {
  const tmp = makeTempDir();
  try {
    makeGitRepo(tmp);
    const subdir = join(tmp, "subdir");
    mkdirSync(subdir);
    assert.throws(() => proveWorkspace(subdir));
  } finally {
    cleanupDir(tmp);
  }
});

// 8. Malformed Git output / command failure fail closed
test("WS-08: malformed Git output fails closed", () => {
  // A non-Git directory will cause `git rev-parse --show-toplevel` to fail.
  // The error must propagate (throw), not silently succeed.
  const tmp = makeTempDir();
  try {
    assert.throws(() => proveWorkspace(tmp));
  } finally {
    cleanupDir(tmp);
  }
});

// 9. Application service does not import src/mcp/*, src/commands/*, or MCP SDK
test("WS-09: workspaceBinding.js does not import mcp/commands/SDK", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const content = await readFile(join(process.cwd(), "src", "application", "workspaceBinding.js"), "utf8");
  const importLines = content.split("\n").filter((l) => l.trim().startsWith("import"));
  const forbidden = /from\s+['"](?:\.\.\/commands\/|\.\.\/mcp\/|@modelcontextprotocol|zod)/;
  for (const line of importLines) {
    assert.ok(!forbidden.test(line), `forbidden import: ${line.trim()}`);
  }
});

// 10. No shell command string — uses execFile/execFileSync
test("WS-10: workspaceBinding.js does not use shell:true or shell command strings", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const content = await readFile(join(process.cwd(), "src", "application", "workspaceBinding.js"), "utf8");
  // Check actual executable code, not comments. Remove comment lines first.
  const codeOnly = content.split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  assert.ok(!/shell:\s*true/.test(codeOnly), "must not use shell:true");
  assert.ok(!/execSync\s*\(/.test(codeOnly), "must not use execSync (use execFileSync/execFile)");
});
