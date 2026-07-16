// src/application/mcpWorkspaceActivation.js
//
// M10 P0-1: Project-scoped workspace activation for Codex host.
//
// Generates, reads, and removes a WAO-managed block in a target project's
// .codex/config.toml. The block configures the WAO MCP stdio server with
// --workspace-root bound to the project's canonical Git root.
//
// Architectural contract:
//   - Does NOT import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Reuses proveWorkspace from workspaceBinding.js (Git identity proof SSOT).
//   - Never reads the process working directory — cwd is always an explicit argument.
//
// Security contract:
//   - No credential values are written. The managed block contains only paths
//     and command/args for the WAO MCP stdio entry point.
//   - Tracked .codex/config.toml → fail-closed (refuse to modify).
//   - Existing non-WAO [mcp_servers.wao] → fail-closed.
//   - External modification of managed block → fail-closed on unbind.
//   - Only .git/info/exclude is modified (with WAO markers), never tracked .gitignore.
//   - Atomic writes with rollback on verification failure.
//
// Codex override semantics (proven by Stage A probe):
//   - Same-name [mcp_servers.wao] in project config replaces global's command/args.
//   - Global env vars are inherited; project config does NOT need credential values.
//   - The managed block must contain the complete command+args (no reliance on global).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { proveWorkspace } from "./workspaceBinding.js";

// ── Constants ────────────────────────────────────────────────────────────────

const SUPPORTED_HOSTS = ["codex"];

const MANAGED_BEGIN = "# >>> WAO MANAGED BLOCK (mcp workspace activation) >>>";
const MANAGED_END = "# <<< WAO MANAGED BLOCK (mcp workspace activation) <<<";
const MANAGED_VERSION = 1;

const EXCLUDE_MARKER_BEGIN = "# >>> WAO MANAGED (mcp workspace activation) >>>";
const EXCLUDE_MARKER_END = "# <<< WAO MANAGED (mcp workspace activation) <<<";

// Derive the WAO repo root from this module's location.
// This module lives at src/application/mcpWorkspaceActivation.js → repo root is 3 levels up.
const _MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(_MODULE_DIR, "..", "..");

/**
 * Build the absolute path to the WAO Node shim (scripts/wao-node.cjs).
 * This is the same shim used by package.json "mcp" script.
 */
function shimPath() {
  return join(REPO_ROOT, "scripts", "wao-node.cjs");
}

/**
 * Build the absolute path to the WAO MCP stdio entry point.
 */
function stdioPath() {
  return join(REPO_ROOT, "src", "mcp", "stdio.js");
}

/**
 * Build the absolute path to the WAO registry (config/agents.json).
 */
function registryPath() {
  return join(REPO_ROOT, "config", "agents.json");
}

/**
 * Build the absolute path to the WAO run directory.
 */
function runDirPath() {
  return join(REPO_ROOT, "runs");
}

/**
 * Compute a SHA-256 checksum of the managed block payload (everything between
 * the begin/end markers, excluding the checksum line itself). This is embedded
 * in the block so unbind can detect external modification.
 */
function computeChecksum(payloadLines) {
  const text = payloadLines.join("\n");
  return createHash("sha256").update(text, "utf8").digest("hex").substring(0, 16);
}

// ── TOML helpers (no third-party parser) ────────────────────────────────────

/**
 * Format a string as a TOML basic string (double-quoted, escaped).
 * Windows backslashes must be escaped in basic strings.
 */
function tomlBasicString(s) {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Format a string array as a TOML inline array.
 */
function tomlArray(arr) {
  return "[" + arr.map(tomlBasicString).join(", ") + "]";
}

/**
 * Build the WAO managed block content for .codex/config.toml.
 * The block configures [mcp_servers.wao] with the WAO stdio entry point
 * and --workspace-root bound to the project's canonical root.
 *
 * The block includes a SHA-256 checksum line so unbind can detect external
 * modification (fail-closed). The checksum is computed over the payload lines
 * (version + comments + [mcp_servers.wao] section), excluding markers and checksum.
 *
 * @param {string} canonicalRoot — the proven Git top-level (from proveWorkspace)
 * @returns {string} TOML lines for the managed block
 */
function buildManagedBlock(canonicalRoot) {
  const args = [
    shimPath(),
    stdioPath(),
    "--registry", registryPath(),
    "--run-dir", runDirPath(),
    "--workspace-root", canonicalRoot,
  ];
  const payloadLines = [
    `# version = ${MANAGED_VERSION}`,
    `# This block is managed by WAO (wao mcp bind). Do not edit manually.`,
    `# To reconfigure, run: wao mcp unbind --host codex --cwd <root>`,
    `# then: wao mcp bind --host codex --cwd <root>`,
    `[mcp_servers.wao]`,
    `command = ${tomlBasicString("node")}`,
    `args = ${tomlArray(args)}`,
  ];
  const checksum = computeChecksum(payloadLines);
  return [
    MANAGED_BEGIN,
    ...payloadLines,
    `# checksum = ${checksum}`,
    MANAGED_END,
  ].join("\n");
}

/**
 * Verify that the managed block's checksum matches its content.
 * Returns true if the block is intact (checksum matches), false if tampered.
 */
function verifyManagedBlockChecksum(blockLines) {
  // blockLines includes begin marker, payload, checksum line, end marker
  // Find the checksum line
  let checksumLine = null;
  let payloadLines = [];
  for (const line of blockLines) {
    const trimmed = line.trim();
    if (trimmed === MANAGED_BEGIN || trimmed === MANAGED_END) continue;
    if (trimmed.startsWith("# checksum = ")) {
      checksumLine = trimmed;
    } else {
      payloadLines.push(line);
    }
  }
  if (!checksumLine) return false;
  const storedChecksum = checksumLine.replace("# checksum = ", "");
  const computed = computeChecksum(payloadLines);
  return storedChecksum === computed;
}

// ── Config file read/write ──────────────────────────────────────────────────

/**
 * Read .codex/config.toml from a project directory.
 * @param {string} projectDir
 * @returns {string|null} file content, or null if not exists
 */
function readCodexConfigRaw(projectDir) {
  const p = join(projectDir, ".codex", "config.toml");
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

/**
 * Write .codex/config.toml atomically (write+read-back-verify).
 * @param {string} projectDir
 * @param {string} content
 */
function writeCodexConfig(projectDir, content) {
  const codexDir = join(projectDir, ".codex");
  if (!existsSync(codexDir)) mkdirSync(codexDir, { recursive: true });
  const p = join(codexDir, "config.toml");
  writeFileSync(p, content, "utf8");
}

/**
 * Check if .codex/config.toml is tracked by Git.
 * Uses `git ls-files --error-unmatch` which exits non-zero if not tracked.
 */
function isConfigTracked(projectDir) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", ".codex/config.toml"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

// ── Managed block parsing ───────────────────────────────────────────────────

/**
 * Extract the managed block boundaries from config content.
 * @param {string} content
 * @returns {{begin: number, end: number, lines: string[]} | null}
 *   Line indices of begin/end markers (0-based), or null if no managed block.
 */
function findManagedBlock(content) {
  const lines = content.split("\n");
  let beginIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === MANAGED_BEGIN) beginIdx = i;
    if (lines[i].trim() === MANAGED_END) endIdx = i;
  }
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return null;
  return { begin: beginIdx, end: endIdx, lines: lines.slice(beginIdx, endIdx + 1) };
}

/**
 * Check if config content contains a non-WAO-managed [mcp_servers.wao] section
 * that would conflict with the managed block.
 * @param {string} content
 * @param {object|null} managedBlock — result of findManagedBlock
 * @returns {boolean} true if a conflicting non-managed wao server exists
 */
function hasConflictingWaoServer(content, managedBlock) {
  const lines = content.split("\n");
  const headerLine = "[mcp_servers.wao]";
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === headerLine) {
      // Is this inside the managed block?
      if (managedBlock && i > managedBlock.begin && i < managedBlock.end) {
        continue; // this is our managed wao server, not a conflict
      }
      return true; // found a wao server outside the managed block
    }
  }
  return false;
}

/**
 * Insert or replace the managed block in config content.
 * Preserves all existing content. If a managed block already exists, it is replaced.
 * @param {string} content — original config content (may be "")
 * @param {string} block — the managed block lines
 * @returns {string} updated content
 */
function insertManagedBlock(content, block) {
  const existing = findManagedBlock(content);
  if (existing) {
    // Replace the existing managed block
    const lines = content.split("\n");
    const before = lines.slice(0, existing.begin);
    const after = lines.slice(existing.end + 1);
    const parts = [before.join("\n"), block, after.join("\n")].filter((s) => s.length > 0);
    return parts.join("\n") + "\n";
  }
  // No existing managed block — append
  if (content.length === 0) {
    return block + "\n";
  }
  const trimmed = content.endsWith("\n") ? content : content + "\n";
  return trimmed + "\n" + block + "\n";
}

/**
 * Remove the managed block from config content.
 * Preserves user content byte-for-byte outside the managed block region.
 * Only the managed block lines (begin..end inclusive) are removed; the remaining
 * lines are rejoined with the same newline separator they had.
 * @param {string} content
 * @returns {string|null} content without managed block, or null if no managed block found
 */
function removeManagedBlock(content) {
  const existing = findManagedBlock(content);
  if (!existing) return null;
  const lines = content.split("\n");
  const before = lines.slice(0, existing.begin);
  const after = lines.slice(existing.end + 1);
  const remaining = [...before, ...after];
  // If nothing remains, signal "now empty"
  if (remaining.length === 0) return "";
  // Rejoin preserving the original line structure. Clean up only the boundary
  // where the block was removed: collapse exactly the blank lines that separated
  // the block from surrounding content, without touching anything else.
  const result = remaining.join("\n");
  // Only trim a single leading/trailing blank line pair that was adjacent to the
  // removed block — do not normalize the entire file.
  return result.replace(/^\n+/, "").replace(/\n+$/, "") + "\n";
}

// ── .git/info/exclude management ────────────────────────────────────────────

/**
 * Get the .git directory absolute path for a project.
 * Uses `git rev-parse --absolute-git-dir` to find it reliably as an absolute path.
 * Falls back to resolving the relative --git-dir against projectDir for older Git.
 */
function getGitDir(projectDir) {
  let raw;
  try {
    raw = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    raw = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  }
  // Ensure absolute — resolve relative paths against projectDir
  if (!raw.match(/^[A-Za-z]:[\\/]/) && !raw.startsWith("/")) {
    return resolve(projectDir, raw);
  }
  return raw;
}

/**
 * Read .git/info/exclude content.
 */
function readExcludeRaw(gitDir) {
  const p = join(gitDir, "info", "exclude");
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

/**
 * Write .git/info/exclude content.
 */
function writeExcludeRaw(gitDir, content) {
  const excludeDir = join(gitDir, "info");
  const p = join(excludeDir, "exclude");
  writeFileSync(p, content, "utf8");
}

/**
 * Find the WAO exclude marker block boundaries.
 */
function findExcludeBlock(content) {
  const lines = content.split("\n");
  let beginIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === EXCLUDE_MARKER_BEGIN) beginIdx = i;
    if (lines[i].trim() === EXCLUDE_MARKER_END) endIdx = i;
  }
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return null;
  return { begin: beginIdx, end: endIdx };
}

/**
 * Add the WAO exclude rule for /.codex/config.toml if not present.
 * @returns {string} updated exclude content
 */
function addExcludeRule(content) {
  if (findExcludeBlock(content)) return content; // already present
  const block = [
    EXCLUDE_MARKER_BEGIN,
    "/.codex/config.toml",
    EXCLUDE_MARKER_END,
  ].join("\n");
  if (content.length === 0) return block + "\n";
  const trimmed = content.endsWith("\n") ? content : content + "\n";
  return trimmed + block + "\n";
}

/**
 * Remove the WAO exclude rule.
 * @returns {string|null} updated content, or null if no exclude block found
 */
function removeExcludeRule(content) {
  const existing = findExcludeBlock(content);
  if (!existing) return null;
  const lines = content.split("\n");
  const before = lines.slice(0, existing.begin);
  const after = lines.slice(existing.end + 1);
  const result = [...before, ...after].join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return result.length === 0 ? "" : result + "\n";
}

// ── Verify: managed block integrity ─────────────────────────────────────────

/**
 * Verify that a managed block in the written config is intact and matches
 * the expected canonical root.
 * @param {string} content — config file content after write
 * @param {string} canonicalRoot — expected workspace root
 * @returns {boolean} true if verified
 */
function verifyManagedBlock(content, canonicalRoot) {
  const managed = findManagedBlock(content);
  if (!managed) return false;
  const blockText = managed.lines.join("\n");
  // Must contain the workspace-root argument
  if (!blockText.includes("--workspace-root")) return false;
  // Must contain the canonical root value (as a TOML basic string)
  if (!blockText.includes(canonicalRoot.replace(/\\/g, "\\\\"))) return false;
  // Must reference stdio.js
  if (!blockText.includes("stdio.js")) return false;
  return true;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Bind a project as a WAO workspace for the specified host.
 *
 * @param {{host: string, cwd: string}} opts
 * @returns {Promise<{bound: boolean, host: string, workspaceRoot: string, status: string}>}
 * @throws {Error} if host is unsupported, cwd is not a Git top-level,
 *   config is tracked, or there's a conflicting [mcp_servers.wao]
 */
export async function bindWorkspace({ host, cwd }) {
  if (!SUPPORTED_HOSTS.includes(host)) {
    throw new Error(`unsupported host: ${host} (supported: ${SUPPORTED_HOSTS.join(", ")})`);
  }
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("workspace: cwd must be a non-empty string");
  }
  if (!resolve(cwd).match(/^[A-Za-z]:[\\/]/) && !resolve(cwd).startsWith("/")) {
    throw new Error("workspace: cwd must be an absolute path");
  }

  // Prove workspace — reuse the SSOT from workspaceBinding.js
  const proof = proveWorkspace(cwd);
  const canonicalRoot = proof.root;

  // Fail-closed: tracked .codex/config.toml
  if (isConfigTracked(canonicalRoot)) {
    throw new Error(".codex/config.toml is tracked by Git — refuse to modify (fail-closed)");
  }

  // Read existing config
  const existingContent = readCodexConfigRaw(canonicalRoot) ?? "";
  const existingManaged = findManagedBlock(existingContent);

  // Fail-closed: conflicting non-managed [mcp_servers.wao]
  if (hasConflictingWaoServer(existingContent, existingManaged)) {
    throw new Error(
      "conflict: [mcp_servers.wao] already exists and is not WAO-managed — remove it manually or unbind first",
    );
  }

  // Build and insert managed block
  const block = buildManagedBlock(canonicalRoot);
  const newContent = insertManagedBlock(existingContent, block);

  // Save originals for rollback
  const gitDir = getGitDir(canonicalRoot);
  const excludeBefore = readExcludeRaw(gitDir);
  const configBefore = existingContent;

  // Write config
  writeCodexConfig(canonicalRoot, newContent);

  // Verify written config
  const writtenContent = readCodexConfigRaw(canonicalRoot);
  if (!writtenContent || !verifyManagedBlock(writtenContent, canonicalRoot)) {
    // Rollback: restore config
    if (configBefore.length > 0) {
      writeCodexConfig(canonicalRoot, configBefore);
    } else {
      // Config didn't exist before — if it's now empty or just our failed block, remove
      const afterRemove = removeManagedBlock(writtenContent ?? "");
      if (afterRemove === "" || afterRemove === null) {
        // Remove the file if it only had our block
        const { unlinkSync } = await import("node:fs");
        try { unlinkSync(join(canonicalRoot, ".codex", "config.toml")); } catch { /* best effort */ }
      } else {
        writeCodexConfig(canonicalRoot, afterRemove);
      }
    }
    throw new Error("write verification failed — config rolled back to original");
  }

  // Write exclude rule
  const excludeAfter = addExcludeRule(excludeBefore);
  if (excludeAfter !== excludeBefore) {
    writeExcludeRaw(gitDir, excludeAfter);
  }

  return {
    bound: true,
    host,
    workspaceRoot: canonicalRoot,
    status: "configured",
    gitHead: proof.gitHead,
    dirty: proof.dirty,
  };
}

/**
 * Query the workspace binding status for a project.
 *
 * @param {{host: string, cwd: string}} opts
 * @returns {Promise<{bound: boolean, host: string, status: string, workspaceRoot?: string, configPath?: string}>}
 */
export async function statusWorkspace({ host, cwd }) {
  if (!SUPPORTED_HOSTS.includes(host)) {
    return { bound: false, host, status: "unsupported_host" };
  }

  const content = readCodexConfigRaw(cwd);
  if (!content) {
    return { bound: false, host, status: "not_configured" };
  }

  const managed = findManagedBlock(content);
  if (!managed) {
    // Config exists but no WAO managed block
    if (hasConflictingWaoServer(content, null)) {
      return { bound: false, host, status: "external_conflict" };
    }
    return { bound: false, host, status: "not_configured" };
  }

  // Verify managed block integrity
  // Extract the workspace-root from the managed block
  const blockText = managed.lines.join("\n");
  const rootMatch = blockText.match(/--workspace-root",\s*"[^"]*"([^"]*)"/);
  // Simpler: find the workspace-root value in the args array
  const wsRootIdx = blockText.indexOf("--workspace-root");
  let workspaceRoot = null;
  if (wsRootIdx !== -1) {
    // The canonical root follows --workspace-root in the args array
    const afterFlag = blockText.substring(wsRootIdx);
    // Match the next TOML basic string after --workspace-root
    const pathMatch = afterFlag.match(/--workspace-root",\s*"((?:[^"\\]|\\.)*)"/);
    if (pathMatch) {
      workspaceRoot = pathMatch[1].replace(/\\\\/g, "\\");
    }
  }

  return {
    bound: true,
    host,
    status: "configured",
    workspaceRoot,
    configPath: join(cwd, ".codex", "config.toml"),
    managed: true,
  };
}

/**
 * Remove the WAO workspace binding from a project.
 *
 * @param {{host: string, cwd: string}} opts
 * @returns {Promise<{unbound: boolean, status: string}>}
 * @throws {Error} if the managed block was externally modified
 */
export async function unbindWorkspace({ host, cwd }) {
  if (!SUPPORTED_HOSTS.includes(host)) {
    throw new Error(`unsupported host: ${host} (supported: ${SUPPORTED_HOSTS.join(", ")})`);
  }

  const content = readCodexConfigRaw(cwd);
  if (!content) {
    return { unbound: true, status: "already_unbound" };
  }

  const managed = findManagedBlock(content);
  if (!managed) {
    return { unbound: true, status: "already_unbound" };
  }

  // Verify managed block integrity before removal — detect external modification
  if (!verifyManagedBlockChecksum(managed.lines)) {
    throw new Error("managed block was externally modified — refuse to remove (fail-closed)");
  }

  // Remove managed block from config
  const newContent = removeManagedBlock(content);
  if (newContent === null) {
    // No managed block found (shouldn't happen here)
    return { unbound: true, status: "already_unbound" };
  }

  // Write updated config
  if (newContent.length === 0) {
    // Config is now empty — delete the file
    const { unlinkSync } = await import("node:fs");
    try { unlinkSync(join(cwd, ".codex", "config.toml")); } catch { /* best effort */ }
  } else {
    writeCodexConfig(cwd, newContent);
  }

  // Remove exclude rule
  const gitDir = getGitDir(cwd);
  const excludeBefore = readExcludeRaw(gitDir);
  const excludeAfter = removeExcludeRule(excludeBefore);
  if (excludeAfter !== null) {
    writeExcludeRaw(gitDir, excludeAfter);
  }

  return { unbound: true, status: "unbound" };
}

export { SUPPORTED_HOSTS };
