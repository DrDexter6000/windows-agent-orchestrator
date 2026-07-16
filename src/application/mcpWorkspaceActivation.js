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
// Transactional write contract (P1-A):
//   bind and unbind are two-resource transactions (config + exclude).
//   Both resources are saved (original bytes + existence) before any write.
//   Writes use same-directory temp file + atomic renameSync (so a crash mid-write
//   never leaves a half-written file). If any step fails after the first resource
//   is written, all previously written resources are restored to their exact
//   original bytes. If restoration itself fails, the original failure is wrapped
//   in a cleanup_failed error — we never silently report success.
//
// Integrity contract (P1-C):
//   - Managed block markers must be exactly 1 begin + 1 end, in order.
//   - Duplicate, nested, or single-sided markers → fail-closed.
//   - Checksum is verified before bind/rebind, status, and unbind.
//   - External modification of the managed block → fail-closed (never overwrite).
//   - status distinguishes: not_configured, external_conflict, tracked_config,
//     managed_modified, exclude_missing_or_modified, configured.
//   - Only a fully verified contract returns bound:true.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
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
const _MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(_MODULE_DIR, "..", "..");

function shimPath() {
  return join(REPO_ROOT, "scripts", "wao-node.cjs");
}
function stdioPath() {
  return join(REPO_ROOT, "src", "mcp", "stdio.js");
}
function registryPath() {
  return join(REPO_ROOT, "config", "agents.json");
}
function runDirPath() {
  return join(REPO_ROOT, "runs");
}

// ── Checksum ────────────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 checksum (truncated to 16 hex chars) over the managed block
 * payload lines (everything between markers, excluding the checksum line itself).
 */
function computeChecksum(payloadLines) {
  const text = payloadLines.join("\n");
  return createHash("sha256").update(text, "utf8").digest("hex").substring(0, 16);
}

// ── TOML helpers ─────────────────────────────────────────────────────────────

function tomlBasicString(s) {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function tomlArray(arr) {
  return "[" + arr.map(tomlBasicString).join(", ") + "]";
}

/**
 * Build the managed block content for .codex/config.toml.
 * The block includes a SHA-256 checksum for tamper detection.
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
    `# Managed by WAO. To reconfigure: run mcp unbind then mcp bind (via scripts/wao-cli.cmd or npm run cli).`,
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
  ].join("\n") + "\n";
}

/**
 * Verify that the managed block's checksum matches its content.
 * Returns true if the block is intact, false if tampered.
 */
function verifyManagedBlockChecksum(blockLines) {
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

// ── Marker cardinality ───────────────────────────────────────────────────────

/**
 * Find all occurrences of a line marker in the content.
 * A "line marker" matches when a line (trimmed of \r) equals the marker string.
 * Returns an array of {lineStart, lineEnd} byte offsets for each matching line.
 *
 * @param {string} content
 * @param {string} marker
 * @returns {Array<{lineStart: number, lineEnd: number, nlStart: number, nlEnd: number}>}
 *   lineStart/lineEnd = the marker text boundaries (excluding newline);
 *   nlStart/nlEnd = the newline boundaries after the marker line (may be empty at EOF).
 */
function findMarkerLineOffsets(content, marker) {
  const results = [];
  let pos = 0;
  while (pos < content.length) {
    // Find start of next line
    let lineStart = pos;
    // Find end of this line (next \n or end of content)
    let nlIdx = content.indexOf("\n", pos);
    if (nlIdx === -1) nlIdx = content.length;
    // Extract the line text, stripping a trailing \r for CRLF
    let lineText = content.substring(lineStart, nlIdx);
    if (lineText.endsWith("\r")) lineText = lineText.slice(0, -1);
    if (lineText.trim() === marker) {
      // Record the full line including its newline
      const lineEnd = nlIdx < content.length ? nlIdx + 1 : nlIdx; // include \n
      results.push({ lineStart, lineEnd, text: lineText });
    }
    pos = nlIdx < content.length ? nlIdx + 1 : nlIdx;
    if (nlIdx === content.length) break;
  }
  return results;
}

/**
 * Find exactly one begin + one end marker, in order.
 * Returns {beginOffset, endOffset, blockText} or null if no markers.
 * Throws on duplicate, nested, or single-sided markers (fail-closed).
 *
 * Offsets are byte positions into content:
 *   beginOffset = start of the begin marker line
 *   endOffset = end of the end marker line (including its trailing newline, if any)
 *
 * @param {string} content
 * @param {string} beginMarker
 * @param {string} endMarker
 * @returns {{beginOffset: number, endOffset: number, blockText: string} | null}
 * @throws {Error} if markers are duplicated, out of order, or single-sided
 */
function findMarkerBlock(content, beginMarker, endMarker) {
  const begins = findMarkerLineOffsets(content, beginMarker);
  const ends = findMarkerLineOffsets(content, endMarker);
  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1) {
    throw new Error(
      `managed markers corrupted: found ${begins.length} begin + ${ends.length} end (expected 1+1)`,
    );
  }
  if (ends[0].lineStart <= begins[0].lineStart) {
    throw new Error("managed markers corrupted: end before begin");
  }
  const blockText = content.substring(begins[0].lineStart, ends[0].lineEnd);
  // Lines for checksum verification: split without trailing empty from final \n
  const rawLines = blockText.split("\n");
  // Drop trailing empty string if blockText ends with \n (the marker line's newline)
  const lines = rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;
  return {
    beginOffset: begins[0].lineStart,
    endOffset: ends[0].lineEnd,
    blockText,
    lines,
  };
}

// ── Config file operations (atomic) ─────────────────────────────────────────

/**
 * Atomically write a file: write to same-directory temp, then renameSync.
 * This ensures a crash mid-write never leaves a half-written file.
 * The temp file is always cleaned up on failure.
 */
function atomicWriteFile(filePath, content) {
  const dir = dirname(filePath);
  const tmp = join(dir, `.wao-tmp-${Date.now()}-${process.pid}`);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
    throw err;
  }
}

/**
 * Read file content as exact bytes (Buffer) for byte-fidelity comparison.
 */
function readFileBytes(filePath) {
  return readFileSync(filePath);
}

/**
 * Read file content as string, or null if not exists.
 */
function readFileStr(filePath) {
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf8");
}

// ── Config paths ────────────────────────────────────────────────────────────

function codexConfigPath(projectDir) {
  return join(projectDir, ".codex", "config.toml");
}

function excludePath(gitDir) {
  return join(gitDir, "info", "exclude");
}

/**
 * Get the .git directory absolute path.
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
  if (!raw.match(/^[A-Za-z]:[\\/]/) && !raw.startsWith("/")) {
    return resolve(projectDir, raw);
  }
  return raw;
}

/**
 * Check if .codex/config.toml is tracked by Git.
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

// ── Managed block insert/remove (byte-fidelity) ──────────────────────────────

/**
 * Insert or replace the managed block in config content.
 * Preserves all existing content byte-for-byte using string substring operations.
 *
 * When replacing an existing block, the new block occupies exactly the same
 * byte range [beginOffset, endOffset) — no separator is added or removed.
 *
 * When appending a new block at end-of-file, a separator of exactly "\n\n" is
 * inserted before the block. This means:
 *   - Content ending with "\n" → original + "\n\n" + block
 *   - Content not ending with "\n" → original + "\n\n" + block
 * In both cases exactly 2 separator bytes are added. removeManagedBlock strips
 * exactly 2 bytes when the block was at EOF, restoring the original perfectly.
 *
 * @param {string} content — original config content
 * @param {string} block — the managed block text (including trailing newline)
 * @param {object|null} existing — result of findMarkerBlock, or null
 * @returns {string} updated content
 */
function insertManagedBlock(content, block, existing) {
  if (existing) {
    // Replace the existing managed block region byte-for-byte
    return content.substring(0, existing.beginOffset) + block + content.substring(existing.endOffset);
  }
  // No existing managed block — append with deterministic separator
  if (content.length === 0) {
    return block;
  }
  // Always add exactly "\n\n" separator (2 bytes)
  return content + "\n\n" + block;
}

/**
 * Remove the managed block from config content.
 * Preserves user content byte-for-byte.
 *
 * When the block was at end-of-file (after is empty/whitespace), strips the
 * exactly 2-byte separator ("\n\n") that insertManagedBlock added. This is the
 * only case where we strip — if content exists after the block, the separator
 * is between content sections and the block is replaced in-place.
 *
 * @param {string} content
 * @param {object} existing — result of findMarkerBlock
 * @returns {string} content without managed block
 */
function removeManagedBlock(content, existing) {
  const before = content.substring(0, existing.beginOffset);
  const after = content.substring(existing.endOffset);

  if (after.trim().length === 0 && before.length >= 2 && before.endsWith("\n\n")) {
    // Block was at EOF — strip the exactly 2-byte separator
    return before.substring(0, before.length - 2) + after;
  }
  return before + after;
}

// ── Exclude rule insert/remove ───────────────────────────────────────────────

const EXCLUDE_BLOCK = [EXCLUDE_MARKER_BEGIN, "/.codex/config.toml", EXCLUDE_MARKER_END].join("\n") + "\n";

/**
 * Add or replace the WAO exclude rule. Byte-fidelity for surrounding content.
 * Uses the same deterministic "\n\n" separator pattern as insertManagedBlock.
 */
function insertExcludeRule(content, existing) {
  if (existing) {
    return content.substring(0, existing.beginOffset) + EXCLUDE_BLOCK + content.substring(existing.endOffset);
  }
  if (content.length === 0) return EXCLUDE_BLOCK;
  return content + "\n\n" + EXCLUDE_BLOCK;
}

/**
 * Remove the WAO exclude rule. Byte-fidelity for surrounding content.
 */
function removeExcludeRule(content, existing) {
  const before = content.substring(0, existing.beginOffset);
  const after = content.substring(existing.endOffset);
  if (after.trim().length === 0 && before.length >= 2 && before.endsWith("\n\n")) {
    return before.substring(0, before.length - 2) + after;
  }
  return before + after;
}

// ── Conflict detection ──────────────────────────────────────────────────────

/**
 * Check if config content contains a non-WAO-managed [mcp_servers.wao] section
 * outside the managed block boundaries.
 * Uses byte offsets to determine if the header is inside the managed block.
 */
function hasConflictingWaoServer(content, managedBlock) {
  // Find all [mcp_servers.wao] header positions as byte offsets
  const header = "[mcp_servers.wao]";
  let pos = 0;
  while (true) {
    const idx = content.indexOf(header, pos);
    if (idx === -1) break;
    // Check if this is at the start of a line (preceded by \n or start of content)
    const lineStart = idx === 0 || content[idx - 1] === "\n";
    if (!lineStart) {
      pos = idx + 1;
      continue;
    }
    // Check if this header is inside the managed block
    if (managedBlock && idx > managedBlock.beginOffset && idx < managedBlock.endOffset) {
      pos = idx + 1;
      continue;
    }
    return true; // found a wao server header outside the managed block
  }
  return false;
}

// ── Transactional resource snapshot ─────────────────────────────────────────

/**
 * Capture the exact bytes and existence state of a file for rollback.
 */
function snapshotFile(filePath) {
  if (!existsSync(filePath)) return { path: filePath, exists: false, bytes: null };
  return { path: filePath, exists: true, bytes: readFileBytes(filePath) };
}

/**
 * Restore a file to its snapshot state (exact bytes or delete).
 */
function restoreFile(snap) {
  if (!snap.exists) {
    try { unlinkSync(snap.path); } catch { /* already gone */ }
    return;
  }
  writeFileSync(snap.path, snap.bytes);
}

// ── Dependency injection points for testing ─────────────────────────────────

/**
 * Default file operation hooks. Tests can inject failures at specific points.
 * Each function receives the same args as the real operation.
 * A hook that throws aborts the transaction and triggers rollback.
 */
function defaultHooks() {
  return {
    writeConfig: (projectDir, content) => atomicWriteFile(codexConfigPath(projectDir), content),
    readConfig: (projectDir) => readFileStr(codexConfigPath(projectDir)),
    verifyConfig: (_projectDir, content, canonicalRoot) => {
      // Real verification: check the managed block is present and checksum is valid.
      let managed;
      try {
        managed = findMarkerBlock(content, MANAGED_BEGIN, MANAGED_END);
      } catch {
        return false;
      }
      if (!managed) return false;
      if (!verifyManagedBlockChecksum(managed.lines)) return false;
      // Check the workspace-root in the block matches the canonical root
      return managed.blockText.includes(canonicalRoot.replace(/\\/g, "\\\\"));
    },
    writeExclude: (gitDir, content) => {
      // Ensure info/ dir exists
      const infoDir = join(gitDir, "info");
      if (!existsSync(infoDir)) mkdirSync(infoDir, { recursive: true });
      atomicWriteFile(excludePath(gitDir), content);
    },
    mkdirCodex: (projectDir) => {
      const codexDir = join(projectDir, ".codex");
      if (!existsSync(codexDir)) mkdirSync(codexDir, { recursive: true });
    },
    deleteConfig: (projectDir) => {
      unlinkSync(codexConfigPath(projectDir));
    },
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Bind a project as a WAO workspace for the specified host.
 *
 * Transaction order:
 *   1. Prove workspace (canonical root + Git top-level proof)
 *   2. Check tracked → fail-closed
 *   3. Read existing config + exclude bytes (snapshot)
 *   4. Find + verify existing managed blocks (checksum)
 *   5. Check for conflicts
 *   6. Write config (atomic temp+rename) ← first resource
 *   7. Read back + verify config integrity ← verification point
 *   8. Write exclude (atomic temp+rename) ← second resource
 *   9. If any step 6-8 fails: restore both resources from snapshot, throw
 *
 * @param {{host: string, cwd: string, hooks?: object}} opts
 * @returns {Promise<{bound: boolean, host: string, workspaceRoot: string, status: string}>}
 */
export async function bindWorkspace({ host, cwd, hooks }) {
  if (!SUPPORTED_HOSTS.includes(host)) {
    throw new Error(`unsupported host: ${host} (supported: ${SUPPORTED_HOSTS.join(", ")})`);
  }
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("workspace: cwd must be a non-empty string");
  }
  const resolvedCwd = resolve(cwd);
  if (!resolvedCwd.match(/^[A-Za-z]:[\\/]/) && !resolvedCwd.startsWith("/")) {
    throw new Error("workspace: cwd must be an absolute path");
  }

  const h = { ...defaultHooks(), ...hooks };

  // 1. Prove workspace
  const proof = proveWorkspace(cwd);
  const canonicalRoot = proof.root;

  // 2. Fail-closed: tracked config
  if (isConfigTracked(canonicalRoot)) {
    throw new Error(".codex/config.toml is tracked by Git — refuse to modify (fail-closed)");
  }

  const gitDir = getGitDir(canonicalRoot);
  const configP = codexConfigPath(canonicalRoot);
  const excludeP = excludePath(gitDir);

  // 3. Snapshot both resources
  const configSnap = snapshotFile(configP);
  const excludeSnap = snapshotFile(excludeP);

  // 4. Find + verify existing managed blocks
  const existingContent = configSnap.exists ? configSnap.bytes.toString("utf8") : "";
  let configManaged = null;
  if (existingContent.length > 0) {
    configManaged = findMarkerBlock(existingContent, MANAGED_BEGIN, MANAGED_END);
    if (configManaged && !verifyManagedBlockChecksum(configManaged.lines)) {
      throw new Error(
        "existing managed block was externally modified — refuse to overwrite (fail-closed). Run mcp unbind manually after verifying the changes.",
      );
    }
  }

  let excludeManaged = null;
  const existingExclude = excludeSnap.exists ? excludeSnap.bytes.toString("utf8") : "";
  if (existingExclude.length > 0) {
    excludeManaged = findMarkerBlock(existingExclude, EXCLUDE_MARKER_BEGIN, EXCLUDE_MARKER_END);
  }

  // 5. Check for conflicts
  if (hasConflictingWaoServer(existingContent, configManaged)) {
    throw new Error(
      "conflict: [mcp_servers.wao] already exists and is not WAO-managed — remove it manually first",
    );
  }

  // 6. Build new content
  const block = buildManagedBlock(canonicalRoot);
  const newConfigContent = insertManagedBlock(existingContent, block, configManaged);
  const newExcludeContent = insertExcludeRule(existingExclude, excludeManaged);

  // 7. Write config (first resource) — may throw via hook
  h.mkdirCodex(canonicalRoot);
  try {
    h.writeConfig(canonicalRoot, newConfigContent);
  } catch (err) {
    // Config write failed — nothing was written yet (atomicWriteFile cleaned temp)
    throw err;
  }

  // 8. Read back + verify config — wrapped in try/catch because read-back or
  //    verify can throw (disk error, permission, concurrent deletion). Any throw
  //    must trigger rollback, not leave config written without exclude.
  let verified = false;
  try {
    const writtenConfig = h.readConfig(canonicalRoot);
    verified = !!writtenConfig && h.verifyConfig(canonicalRoot, writtenConfig, canonicalRoot);
  } catch (verifyErr) {
    _rollback(configSnap, excludeSnap, "config verification step threw");
    throw new Error(`config verification step failed — rolled back to original: ${verifyErr.message}`);
  }
  if (!verified) {
    // Verification returned false — rollback config to snapshot
    _rollback(configSnap, excludeSnap, "config verification failed");
    throw new Error("config write verification failed — rolled back to original");
  }

  // 9. Write exclude (second resource) — may throw via hook
  try {
    h.writeExclude(gitDir, newExcludeContent);
  } catch (err) {
    // Exclude write failed — rollback config (already written) to snapshot
    _rollback(configSnap, excludeSnap, "exclude write failed");
    throw err;
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
 * Proves workspace and verifies managed block integrity + exclude presence.
 *
 * Status values:
 *   - not_configured: no managed block
 *   - external_conflict: non-WAO [mcp_servers.wao] exists
 *   - tracked_config: .codex/config.toml is Git-tracked
 *   - managed_modified: managed block checksum mismatch
 *   - exclude_missing_or_modified: config OK but exclude block missing/corrupted
 *   - configured: all checks pass
 */
export async function statusWorkspace({ host, cwd }) {
  if (!SUPPORTED_HOSTS.includes(host)) {
    return { bound: false, host, status: "unsupported_host" };
  }

  // Prove workspace — must be a real Git top-level
  let canonicalRoot;
  try {
    const proof = proveWorkspace(cwd);
    canonicalRoot = proof.root;
  } catch (err) {
    return { bound: false, host, status: "invalid_workspace", error: err.message };
  }

  // Check tracked
  if (isConfigTracked(canonicalRoot)) {
    return { bound: false, host, status: "tracked_config" };
  }

  const configP = codexConfigPath(canonicalRoot);
  const content = readFileStr(configP);
  if (!content) {
    return { bound: false, host, status: "not_configured" };
  }

  let configManaged;
  try {
    configManaged = findMarkerBlock(content, MANAGED_BEGIN, MANAGED_END);
  } catch (err) {
    return { bound: false, host, status: "managed_modified", error: err.message };
  }

  if (!configManaged) {
    if (hasConflictingWaoServer(content, null)) {
      return { bound: false, host, status: "external_conflict" };
    }
    return { bound: false, host, status: "not_configured" };
  }

  // Verify checksum
  if (!verifyManagedBlockChecksum(configManaged.lines)) {
    return { bound: false, host, status: "managed_modified" };
  }

  // Verify exclude block
  const gitDir = getGitDir(canonicalRoot);
  const excludeContent = readFileStr(excludePath(gitDir));
  let excludeManaged = null;
  if (excludeContent) {
    try {
      excludeManaged = findMarkerBlock(excludeContent, EXCLUDE_MARKER_BEGIN, EXCLUDE_MARKER_END);
    } catch {
      excludeManaged = null;
    }
  }
  if (!excludeManaged) {
    return { bound: false, host, status: "exclude_missing_or_modified" };
  }

  return {
    bound: true,
    host,
    status: "configured",
    workspaceRoot: canonicalRoot,
    configPath: configP,
    managed: true,
  };
}

/**
 * Remove the WAO workspace binding from a project.
 *
 * Transaction order:
 *   1. Prove workspace
 *   2. Read existing config + exclude bytes (snapshot)
 *   3. Verify managed block checksum (fail-closed on tamper)
 *   4. Remove managed block from config content
 *   5. Write config (atomic) ← first resource
 *   6. Remove exclude rule / write updated exclude ← second resource
 *   7. If step 6 fails: restore both resources, throw
 */
export async function unbindWorkspace({ host, cwd, hooks }) {
  if (!SUPPORTED_HOSTS.includes(host)) {
    throw new Error(`unsupported host: ${host} (supported: ${SUPPORTED_HOSTS.join(", ")})`);
  }

  const h = { ...defaultHooks(), ...hooks };

  // 1. Prove workspace
  const proof = proveWorkspace(cwd);
  const canonicalRoot = proof.root;

  const gitDir = getGitDir(canonicalRoot);
  const configP = codexConfigPath(canonicalRoot);
  const excludeP = excludePath(gitDir);

  // 2. Snapshot
  const configSnap = snapshotFile(configP);
  const excludeSnap = snapshotFile(excludeP);

  const content = configSnap.exists ? configSnap.bytes.toString("utf8") : "";
  if (!content) {
    return { unbound: true, status: "already_unbound" };
  }

  let configManaged;
  try {
    configManaged = findMarkerBlock(content, MANAGED_BEGIN, MANAGED_END);
  } catch (err) {
    throw new Error(
      `managed markers corrupted — refuse to remove (fail-closed): ${err.message}`,
    );
  }

  if (!configManaged) {
    return { unbound: true, status: "already_unbound" };
  }

  // 3. Verify checksum
  if (!verifyManagedBlockChecksum(configManaged.lines)) {
    throw new Error(
      "managed block was externally modified — refuse to remove (fail-closed)",
    );
  }

  // 4. Remove managed block
  const newConfigContent = removeManagedBlock(content, configManaged);
  // Check if only whitespace/newlines remain → delete file
  const configIsEmpty = newConfigContent.trim().length === 0;

  // 5. Write config (first resource)
  if (configIsEmpty) {
    // Config had only the managed block — delete the file
    try { h.deleteConfig(canonicalRoot); } catch (err) {
      throw err;
    }
  } else {
    try { h.writeConfig(canonicalRoot, newConfigContent); } catch (err) {
      throw err;
    }
  }

  // 6. Remove exclude rule (second resource)
  const excludeContent = excludeSnap.exists ? excludeSnap.bytes.toString("utf8") : "";
  let excludeManaged = null;
  if (excludeContent) {
    try {
      excludeManaged = findMarkerBlock(excludeContent, EXCLUDE_MARKER_BEGIN, EXCLUDE_MARKER_END);
    } catch {
      excludeManaged = null;
    }
  }

  if (excludeManaged) {
    const newExcludeContent = removeExcludeRule(excludeContent, excludeManaged);
    const trimmedExclude = newExcludeContent.replace(/^\n+/, "").replace(/\n+$/, "");
    try {
      if (trimmedExclude.length === 0) {
        // Exclude file becomes empty — write empty (keep file, git default)
        h.writeExclude(gitDir, "");
      } else {
        h.writeExclude(gitDir, newExcludeContent);
      }
    } catch (err) {
      // Exclude write failed — rollback config
      _rollback(configSnap, excludeSnap, "exclude write failed during unbind");
      throw err;
    }
  }

  return { unbound: true, status: "unbound" };
}

/**
 * Rollback both resources to their snapshot state.
 * If restoration fails, wraps the original error in cleanup_failed.
 */
function _rollback(configSnap, excludeSnap, reason) {
  let cleanupError = null;
  try {
    restoreFile(configSnap);
  } catch (e) {
    cleanupError = e;
  }
  try {
    restoreFile(excludeSnap);
  } catch (e) {
    cleanupError = cleanupError || e;
  }
  // Clean up any temp files
  for (const snap of [configSnap, excludeSnap]) {
    const dir = dirname(snap.path);
    const tmpPattern = `.wao-tmp-`;
    // Best-effort: temp files are cleaned by atomicWriteFile on failure
  }
  if (cleanupError) {
    throw new Error(
      `cleanup_failed: ${reason} — restoration may be incomplete: ${cleanupError.message}`,
    );
  }
}

export { SUPPORTED_HOSTS };
