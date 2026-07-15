// src/application/workspaceBinding.js
//
// M10-pre2: Host-authorized workspace binding — proof SSOT.
//
// Given a host-authorized absolute path (from MCP --workspace-root startup flag
// or MCP client roots/list), prove it is a real Git worktree top-level directory
// and return its canonical root, full HEAD commit, and dirty status.
//
// This is the dispatch target / authority boundary for MCP run_dispatch. The
// canonical root from this proof becomes the server-owned `cwd` passed to
// dispatchRun — the model cannot provide arbitrary paths.
//
// Architectural contract:
//   - Does NOT import src/mcp/*, src/commands/*, MCP SDK, or zod.
//   - Uses execFileSync with structured argv arrays — never shell command strings.
//   - Never uses shell:true.
//
// Security contract:
//   - Input must be an absolute path.
//   - The path must be a Git worktree top-level directory (git rev-parse --show-toplevel
//     canonical result must match the input path after realpath normalization).
//   - A subdirectory of a Git repo is REJECTED — no silent upward authorization expansion.
//   - All Git command failures fail closed (throw).
//
// Note: Workspace binding is a dispatch authority boundary, not an OS filesystem sandbox.
// Documentation must not claim workers absolutely cannot access paths outside the workspace;
// strong isolation still follows the TD-104 delivery worktree boundary.

import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { execFileSync } from "node:child_process";

// Windows: normalize drive letter casing and slashes for comparison.
function normalizePath(p) {
  return realpathSync(p).replace(/\\/g, "/");
}

/**
 * Run a git command with structured argv (no shell string).
 * @param {string[]} args
 * @param {string} cwd
 * @param {{ gitBin?: string }} [opts]
 * @returns {string} stdout trimmed
 */
function git(args, cwd, opts = {}) {
  const bin = opts.gitBin ?? "git";
  return execFileSync(bin, args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/**
 * Check if a Git repo has dirty (tracked + untracked) changes.
 * Uses `git status --porcelain` — empty output means clean.
 * @param {string} cwd
 * @param {{ gitBin?: string }} [opts]
 * @returns {boolean}
 */
function isDirty(cwd, opts) {
  const output = git(["status", "--porcelain"], cwd, opts);
  return output.length > 0;
}

/**
 * Prove that a host-authorized path is a Git worktree top-level directory.
 *
 * @param {string} pathStr — absolute path to prove
 * @param {{ gitBin?: string }} [opts] — optional git binary override (tests)
 * @returns {{ root: string, gitHead: string, dirty: boolean }}
 * @throws {Error} if the path is not absolute, not a directory, not a Git top-level,
 *   or any Git command fails
 */
export function proveWorkspace(pathStr, opts = {}) {
  if (typeof pathStr !== "string" || pathStr.length === 0) {
    throw new Error("workspace: path must be a non-empty string");
  }
  if (!isAbsolute(pathStr)) {
    throw new Error("workspace: path must be absolute");
  }

  // Normalize the input path via realpath (resolves symlinks, canonicalizes).
  // If the directory does not exist, realpathSync throws — fail closed.
  const canonicalInput = normalizePath(pathStr);

  // Ask Git for the worktree top-level of this directory.
  // If this is not inside a Git repo, the command fails — fail closed.
  const toplevelRaw = git(["rev-parse", "--show-toplevel"], pathStr, opts);
  const canonicalToplevel = normalizePath(toplevelRaw);

  // The input path MUST be the Git top-level — not a subdirectory.
  // A subdirectory would silently expand authorization, which is forbidden.
  if (canonicalInput !== canonicalToplevel) {
    throw new Error("workspace: path must be a Git worktree top-level, not a subdirectory");
  }

  // Read the full HEAD commit (40-char hex on most systems; 64 on SHA-256 repos).
  const gitHead = git(["rev-parse", "HEAD"], pathStr, opts);
  // Validate it looks like a commit hash.
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(gitHead)) {
    throw new Error("workspace: git rev-parse HEAD returned malformed output");
  }

  // Check dirty status (tracked + untracked changes). Dirty is report-only;
  // it does NOT block binding because delivery creates an isolated worktree from HEAD.
  const dirty = isDirty(pathStr, opts);

  return {
    root: canonicalToplevel,
    gitHead,
    dirty,
  };
}
