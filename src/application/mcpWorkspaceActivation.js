// src/application/mcpWorkspaceActivation.js
//
// M10 P0-1 Reframe: Project-scoped workspace activation for Codex host.
//
// WAO orchestrates the activation: prove workspace, compute the expected MCP
// server contract, delegate Codex config CRUD to the Codex CLI adapter, and
// own the .git/info/exclude protection block. WAO does NOT parse or write TOML.
//
// Architectural contract:
//   - Does NOT import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Reuses proveWorkspace from workspaceBinding.js (Git identity proof SSOT).
//   - Never reads the process working directory — cwd is always an explicit argument.
//   - Codex config I/O is delegated to src/hostAdapters/codexMcpConfig.js.
//
// Transaction contract (crash-safe ordering):
//   bind:  write exclude FIRST → codex mcp add → verify exact contract.
//          A crash after step 1 only leaves an extra ignore rule (harmless).
//          A crash after step 2 leaves both exclude + config (activation_incomplete,
//          re-bindable).
//   unbind: ALL preflight before mutation → codex mcp remove → verify absent →
//          remove exclude block.
//
// Ownership contract:
//   - "configured" requires BOTH exact server contract AND exact WAO-owned
//     exclude metadata. Neither alone is sufficient.
//   - An exact server without WAO exclude metadata is "unmanaged_exact_server"
//     — WAO never auto-claims or deletes it.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync,
  readdirSync, rmdirSync, lstatSync, realpathSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { proveWorkspace } from "./workspaceBinding.js";
import {
  codexMcpList,
  codexMcpGet,
  codexMcpAdd,
  codexMcpRemove,
} from "../hostAdapters/codexMcpConfig.js";

// ── Constants ────────────────────────────────────────────────────────────────

const SUPPORTED_HOSTS = ["codex"];

const EXCLUDE_MARKER_BEGIN = "# >>> WAO MANAGED (mcp workspace activation v1) >>>";
const EXCLUDE_MARKER_END = "# <<< WAO MANAGED (mcp workspace activation v1) <<<";

// Derive WAO repo root from this module's location.
// src/application/ → ../.. = repo root.
const _MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(_MODULE_DIR, "..", "..");

function shimPath() { return join(REPO_ROOT, "scripts", "wao-node.cjs"); }
function stdioPath() { return join(REPO_ROOT, "src", "mcp", "stdio.js"); }
function registryPath() { return join(REPO_ROOT, "config", "agents.json"); }
function runDirPath() { return join(REPO_ROOT, "runs"); }

// ── Expected server contract ─────────────────────────────────────────────────

/**
 * Compute the exact MCP server contract WAO expects in the Codex config.
 * The args array order and values are precise — any deviation is a conflict.
 */
function expectedServerContract(canonicalRoot) {
  const args = [
    shimPath(),
    stdioPath(),
    "--registry", registryPath(),
    "--run-dir", runDirPath(),
    "--workspace-root", canonicalRoot,
  ];
  return {
    version: 1,
    name: "wao",
    enabled: true,
    transport: {
      type: "stdio",
      command: process.execPath,
      args,
      cwd: null,
      env: null,
      env_vars: [],
    },
    workspaceRoot: canonicalRoot,
  };
}

/**
 * Compute a digest of the expected server contract for ownership verification.
 * Covers the full normalized contract. This digest is stored in the exclude
 * block and verified on every status/bind/unbind to detect drift.
 */
function contractDigest(expected) {
  const text = JSON.stringify(expected);
  return createHash("sha256").update(text, "utf8").digest("hex").substring(0, 16);
}

/**
 * Build the exact exclude ownership block content.
 * Includes: the ignore rule + a digest of the expected server contract.
 */
function buildExcludeBlock(expected) {
  const digest = contractDigest(expected);
  return [
    EXCLUDE_MARKER_BEGIN,
    "/.codex/config.toml",
    `# digest: ${digest}`,
    EXCLUDE_MARKER_END,
  ].join("\n") + "\n";
}

// ── Exact server matching (nested JSON) ──────────────────────────────────────

/**
 * Check if a Codex server object exactly matches the expected contract.
 *
 * Per CTO correction: ALL execution-behavior fields must match precisely:
 *   - transport fields must equal expected.transport
 *   - transport.cwd must be null
 *   - transport.env must be null
 *   - transport.env_vars must be empty array []
 *   - name must match
 *   - enabled must be true
 *
 * Extra fields that don't affect execution (timeout, auth_status) are allowed.
 */
function serverMatchesExpected(server, expected) {
  if (!server) return false;
  if (server.name !== expected.name) return false;
  if (server.enabled !== expected.enabled) return false;
  const t = server.transport;
  if (!t) return false;
  const expectedTransport = expected.transport;
  if (t.type !== expectedTransport.type) return false;
  if (t.command !== expectedTransport.command) return false;
  // Args: exact array equality
  if (!Array.isArray(t.args)) return false;
  if (t.args.length !== expectedTransport.args.length) return false;
  for (let i = 0; i < expectedTransport.args.length; i++) {
    if (t.args[i] !== expectedTransport.args[i]) return false;
  }
  // cwd must be null (no working directory override)
  if (t.cwd !== expectedTransport.cwd) return false;
  // env must be null (no extra env vars injected by Codex config)
  if (t.env !== expectedTransport.env) return false;
  // env_vars must be empty (no env var names declared)
  if (!Array.isArray(t.env_vars) || t.env_vars.length !== expectedTransport.env_vars.length) {
    return false;
  }
  return true;
}

/**
 * Check if a Codex server has name "wao" but does NOT match the expected contract.
 * This distinguishes "our exact server" from "someone else's wao server".
 */
function isDifferentWaoServer(server, expected) {
  if (!server) return false;
  if (server.name !== "wao") return false;
  return !serverMatchesExpected(server, expected);
}

// ── Git helpers ──────────────────────────────────────────────────────────────

function getGitDir(projectDir) {
  let raw;
  try {
    raw = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: projectDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    raw = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: projectDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  }
  if (!raw.match(/^[A-Za-z]:[\\/]/) && !raw.startsWith("/")) {
    return resolve(projectDir, raw);
  }
  return raw;
}

function isConfigTracked(projectDir) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", ".codex/config.toml"], {
      cwd: projectDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

// ── Paths ────────────────────────────────────────────────────────────────────

function codexHomePath(canonicalRoot) { return join(canonicalRoot, ".codex"); }
function codexConfigPath(canonicalRoot) { return join(canonicalRoot, ".codex", "config.toml"); }
function excludePath(gitDir) { return join(gitDir, "info", "exclude"); }

function pathsEqual(a, b) {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function assertLocalCodexPaths(canonicalRoot) {
  const codexHome = codexHomePath(canonicalRoot);
  if (!existsSync(codexHome)) return;
  const homeStat = lstatSync(codexHome);
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    throw new Error("unsafe codex home: .codex must be a local directory, not a link");
  }
  if (!pathsEqual(realpathSync.native(codexHome), codexHome)) {
    throw new Error("unsafe codex home: resolved path escapes the workspace");
  }
  const configPath = codexConfigPath(canonicalRoot);
  if (!existsSync(configPath)) return;
  const configStat = lstatSync(configPath);
  if (configStat.isSymbolicLink() || !configStat.isFile()) {
    throw new Error("unsafe config link: .codex/config.toml must be a local regular file");
  }
  if (!pathsEqual(realpathSync.native(configPath), configPath)) {
    throw new Error("unsafe config link: resolved path escapes the workspace");
  }
}

// ── Atomic file write ────────────────────────────────────────────────────────

/**
 * Atomically write a file: temp in same dir + renameSync.
 * Temp file is cleaned up on failure.
 */
function atomicWriteFile(filePath, content) {
  const dir = dirname(filePath);
  const tmp = join(dir, `.wao-tmp-${Date.now()}-${process.pid}`);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

// ── Exclude block management (byte-offset operations) ────────────────────────

/**
 * Find marker line offsets in content. Returns positions for exactly 1 begin + 1 end.
 * Throws on duplicate/nested/single-sided markers.
 */
function findExcludeBlock(content) {
  const lines = content.split("\n");
  let beginCount = 0, endCount = 0;
  let beginIdx = -1, endIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === EXCLUDE_MARKER_BEGIN) { beginCount++; beginIdx = i; }
    if (t === EXCLUDE_MARKER_END) { endCount++; endIdx = i; }
  }
  if (beginCount === 0 && endCount === 0) return null;
  if (beginCount !== 1 || endCount !== 1) {
    throw new Error(`exclude markers corrupted: ${beginCount} begin + ${endCount} end`);
  }
  if (endIdx <= beginIdx) throw new Error("exclude markers corrupted: end before begin");
  // Return byte offsets into the original content string
  let beginOffset = 0;
  for (let i = 0; i < beginIdx; i++) beginOffset += lines[i].length + 1; // +1 for \n
  let endOffset = beginOffset;
  for (let i = beginIdx; i <= endIdx; i++) endOffset += lines[i].length + 1;
  return { beginOffset, endOffset, lines: lines.slice(beginIdx, endIdx + 1) };
}

/**
 * Verify an exclude block has exact expected content: rule + digest.
 * Returns true only if every line matches precisely.
 */
function excludeBlockMatches(blockLines, expected) {
  const expectedBlock = buildExcludeBlock(expected);
  const actual = blockLines.join("\n") + "\n";
  return actual === expectedBlock;
}

/**
 * Read the exclude file content as string (or null if not exists).
 */
function readExcludeStr(gitDir) {
  const p = excludePath(gitDir);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

// ── Snapshot / rollback ──────────────────────────────────────────────────────

function snapshotFile(filePath) {
  if (!existsSync(filePath)) return { path: filePath, exists: false, bytes: null };
  return { path: filePath, exists: true, bytes: readFileSync(filePath) };
}

/**
 * Restore a file from snapshot using atomic write.
 * Only ignores ENOENT on delete — never swallows EACCES/EPERM.
 */
function restoreFile(snap) {
  if (!snap.exists) {
    try {
      unlinkSync(snap.path);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // ENOENT = already gone, that's fine
    }
    return;
  }
  // Atomic restore: write to temp + rename
  atomicWriteFile(snap.path, snap.bytes);
}

/**
 * Rollback multiple snapshots. If any restore fails, wraps original error
 * in cleanup_failed with the original failure code/message preserved.
 */
function rollback(snapshots, originalReason, removeEmptyDirs = []) {
  const errors = [];
  for (const snap of snapshots) {
    try {
      restoreFile(snap);
    } catch (err) {
      errors.push(`${snap.path}: ${err.message}`);
    }
  }
  for (const dir of removeEmptyDirs) {
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    } catch (err) {
      errors.push(`${dir}: ${err.message}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `cleanup_failed: ${originalReason} — restoration incomplete: ${errors.join("; ")}`,
    );
  }
}

// ── Default hooks (DI for testing) ───────────────────────────────────────────

function defaultHooks() {
  return {
    codexList: (opts) => codexMcpList(opts),
    codexGet: (opts) => codexMcpGet(opts),
    codexAdd: (opts) => codexMcpAdd(opts),
    codexRemove: (opts) => codexMcpRemove(opts),
    writeExclude: (gitDir, content) => {
      const infoDir = join(gitDir, "info");
      if (!existsSync(infoDir)) mkdirSync(infoDir, { recursive: true });
      atomicWriteFile(excludePath(gitDir), content);
    },
    readExclude: (gitDir) => readExcludeStr(gitDir),
  };
}

// ── Status classification ────────────────────────────────────────────────────

/**
 * Classify the current activation state.
 *
 * State logic (unified exclude semantics — no managed_modified):
 *   1. codexList → find "wao" server
 *   2. exclude block → check existence + exact content
 *
 * Combinations:
 *   exact server + exact exclude       → configured
 *   exact server + no/different exclude → unmanaged_exact_server
 *   exact server + exclude damaged     → exclude_missing_or_modified
 *   different wao server               → external_conflict
 *   no server + exact exclude          → activation_incomplete
 *   no server + no exclude             → not_configured
 *   no server + exclude damaged        → exclude_missing_or_modified
 *   codex unavailable                   → codex_cli_unavailable
 */
async function classifyState(h, canonicalRoot, expected) {
  const codexHome = codexHomePath(canonicalRoot);
  assertLocalCodexPaths(canonicalRoot);

  // 1. Check server via list (authoritative existence check)
  let servers;
  try {
    servers = await h.codexList({ codexHome });
  } catch {
    return { status: "codex_cli_unavailable" };
  }
  const waoServer = servers.find((s) => s.name === "wao");
  const hasExactServer = waoServer && serverMatchesExpected(waoServer, expected);
  const hasDifferentWao = waoServer && isDifferentWaoServer(waoServer, expected);

  // 2. Check exclude block
  const gitDir = getGitDir(canonicalRoot);
  const excludeContent = h.readExclude(gitDir);
  let excludeBlock = null;
  let excludeDamaged = false;
  if (excludeContent) {
    try {
      excludeBlock = findExcludeBlock(excludeContent);
      if (excludeBlock && !excludeBlockMatches(excludeBlock.lines, expected)) {
        excludeDamaged = true; // exists but content doesn't match
      }
    } catch {
      excludeDamaged = true; // markers corrupted
    }
  }

  // 3. Classify
  if (hasDifferentWao) {
    return { status: "external_conflict", hasServer: true };
  }
  if (excludeDamaged) {
    return { status: "exclude_missing_or_modified", hasServer: !!waoServer };
  }
  if (hasExactServer && excludeBlock) {
    return { status: "configured", hasServer: true, hasExclude: true };
  }
  if (hasExactServer && !excludeBlock) {
    return { status: "unmanaged_exact_server", hasServer: true };
  }
  if (!waoServer && excludeBlock) {
    return { status: "activation_incomplete", hasExclude: true };
  }
  return { status: "not_configured" };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Bind a project as a WAO workspace for the specified host.
 *
 * Ordering (crash-safe):
 *   1. prove + tracked + classify preflight (all before mutation)
 *   2. snapshot config + exclude
 *   3. write exclude ownership block (crash → only extra ignore)
 *   4. codex mcp add
 *   5. codex mcp get verify exact contract
 *   6. failure → rollback both
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
  const expected = expectedServerContract(canonicalRoot);
  assertLocalCodexPaths(canonicalRoot);

  // 2. Fail-closed: tracked config
  if (isConfigTracked(canonicalRoot)) {
    throw new Error(".codex/config.toml is tracked by Git — refuse to modify (fail-closed)");
  }

  // 3. Classify current state (preflight — no mutation)
  const state = await classifyState(h, canonicalRoot, expected);
  if (state.status === "external_conflict") {
    throw new Error("conflict: a different [mcp_servers.wao] exists — remove it manually first");
  }
  if (state.status === "exclude_missing_or_modified") {
    throw new Error(
      "exclude ownership block is missing or damaged — run mcp unbind to clean up, then mcp bind",
    );
  }
  if (state.status === "configured") {
    // Idempotent — already fully configured
    return {
      bound: true, host, workspaceRoot: canonicalRoot, status: "configured",
      gitHead: proof.gitHead, dirty: proof.dirty,
    };
  }
  // activation_incomplete, not_configured, unmanaged_exact_server, codex_cli_unavailable
  if (state.status === "codex_cli_unavailable") {
    throw new Error("codex_cli_unavailable: codex CLI not found or not functional");
  }
  if (state.status === "unmanaged_exact_server") {
    throw new Error(
      "unmanaged_exact_server: exact wao server exists but no WAO ownership metadata — " +
      "remove it manually (codex mcp remove wao) and run mcp bind again",
    );
  }

  // 4. Snapshot for rollback
  const gitDir = getGitDir(canonicalRoot);
  const codexHome = codexHomePath(canonicalRoot);
  const configPath = codexConfigPath(canonicalRoot);
  const codexHomeExisted = existsSync(codexHome);
  const configSnap = snapshotFile(configPath);
  const excludeSnap = snapshotFile(excludePath(gitDir));
  const snapshots = [configSnap, excludeSnap];
  const cleanupDirs = codexHomeExisted ? [] : [codexHome];

  // 5. Write exclude block FIRST (crash → only extra ignore, no config exposure)
  const excludeContent = excludeSnap.exists ? excludeSnap.bytes.toString("utf8") : "";
  let existingExcludeBlock = null;
  if (excludeContent) {
    try { existingExcludeBlock = findExcludeBlock(excludeContent); } catch { /* damaged, will append */ }
  }
  const block = buildExcludeBlock(expected);
  let newExcludeContent;
  if (existingExcludeBlock) {
    newExcludeContent = excludeContent.substring(0, existingExcludeBlock.beginOffset) +
      block + excludeContent.substring(existingExcludeBlock.endOffset);
  } else {
    newExcludeContent = excludeContent.length === 0 ? block : excludeContent + "\n" + block;
  }
  try {
    h.writeExclude(gitDir, newExcludeContent);
  } catch (err) {
    rollback(snapshots, `exclude write failed: ${err.message}`, cleanupDirs);
    throw new Error(`exclude write failed: ${err.message}`);
  }
  try {
    if (h.readExclude(gitDir) !== newExcludeContent) {
      throw new Error("written bytes do not match expected ownership block");
    }
  } catch (err) {
    rollback(snapshots, `exclude verify failed: ${err.message}`, cleanupDirs);
    throw new Error(`exclude verify failed: ${err.message}`);
  }

  // 6. codex mcp add
  try {
    if (!existsSync(codexHome)) mkdirSync(codexHome, { recursive: true });
    assertLocalCodexPaths(canonicalRoot);
    await h.codexAdd({
      codexHome,
      name: expected.name,
      command: expected.transport.command,
      args: expected.transport.args,
    });
  } catch (err) {
    rollback(snapshots, `codex mcp add failed: ${err.message}`, cleanupDirs);
    throw new Error(`codex mcp add failed: ${err.message}`);
  }

  // 7. Verify exact server contract via get
  let added;
  try {
    assertLocalCodexPaths(canonicalRoot);
    added = await h.codexGet({ codexHome, name: expected.name });
  } catch (err) {
    rollback(snapshots, `codex mcp get verify failed: ${err.message}`, cleanupDirs);
    throw new Error(`verify failed after add: ${err.message}`);
  }
  if (!serverMatchesExpected(added, expected)) {
    rollback(snapshots, "server contract mismatch after add", cleanupDirs);
    throw new Error("server contract mismatch after add — rolled back");
  }
  let finalState;
  try {
    finalState = await classifyState(h, canonicalRoot, expected);
  } catch (err) {
    rollback(snapshots, `final state verification failed: ${err.message}`, cleanupDirs);
    throw new Error(`final state verification failed after bind: ${err.message}`);
  }
  if (finalState.status !== "configured") {
    rollback(snapshots, `final state verification failed: ${finalState.status}`, cleanupDirs);
    throw new Error(`final state verification failed after bind: ${finalState.status}`);
  }

  return {
    bound: true, host, workspaceRoot: canonicalRoot, status: "configured",
    gitHead: proof.gitHead, dirty: proof.dirty,
  };
}

/**
 * Query the workspace binding status.
 * Runs proveWorkspace (canonical proof, not just string matching).
 */
export async function statusWorkspace({ host, cwd, hooks }) {
  if (!SUPPORTED_HOSTS.includes(host)) {
    return { bound: false, host, status: "unsupported_host" };
  }

  const h = { ...defaultHooks(), ...hooks };

  let canonicalRoot;
  try {
    const proof = proveWorkspace(cwd);
    canonicalRoot = proof.root;
  } catch (err) {
    return { bound: false, host, status: "invalid_workspace", error: err.message };
  }
  try {
    assertLocalCodexPaths(canonicalRoot);
  } catch (err) {
    return { bound: false, host, status: "unsafe_codex_home", error: err.message };
  }

  if (isConfigTracked(canonicalRoot)) {
    return { bound: false, host, status: "tracked_config" };
  }

  const expected = expectedServerContract(canonicalRoot);
  let state;
  try {
    state = await classifyState(h, canonicalRoot, expected);
  } catch (err) {
    return { bound: false, host, status: "unsafe_codex_home", error: err.message };
  }

  return {
    bound: state.status === "configured",
    host,
    status: state.status,
    workspaceRoot: state.status === "configured" ? canonicalRoot : undefined,
    configPath: state.status === "configured" ? codexConfigPath(canonicalRoot) : undefined,
  };
}

/**
 * Remove the WAO workspace binding.
 *
 * ALL preflight before any mutation:
 *   1. prove + exact server + exact exclude preflight
 *   2. snapshot
 *   3. codex mcp remove
 *   4. verify absent via list
 *   5. remove exclude block
 *   6. failure → rollback
 */
export async function unbindWorkspace({ host, cwd, hooks }) {
  if (!SUPPORTED_HOSTS.includes(host)) {
    throw new Error(`unsupported host: ${host} (supported: ${SUPPORTED_HOSTS.join(", ")})`);
  }

  const h = { ...defaultHooks(), ...hooks };

  // 1. Prove workspace
  const proof = proveWorkspace(cwd);
  const canonicalRoot = proof.root;
  const expected = expectedServerContract(canonicalRoot);
  assertLocalCodexPaths(canonicalRoot);
  const gitDir = getGitDir(canonicalRoot);
  const codexHome = codexHomePath(canonicalRoot);

  if (isConfigTracked(canonicalRoot)) {
    throw new Error(".codex/config.toml is tracked by Git — refuse to modify (fail-closed)");
  }

  // 2. Classify state (preflight — all checks before mutation)
  const state = await classifyState(h, canonicalRoot, expected);
  if (state.status === "not_configured") {
    return { unbound: true, status: "already_unbound" };
  }
  if (state.status === "external_conflict") {
    throw new Error(
      "refuse to unbind: a different [mcp_servers.wao] exists — remove it manually",
    );
  }
  if (state.status === "unmanaged_exact_server") {
    throw new Error(
      "unmanaged_exact_server: exact wao server exists but no WAO ownership metadata — " +
      "remove it manually (codex mcp remove wao) before unbind",
    );
  }
  if (state.status === "exclude_missing_or_modified") {
    throw new Error(
      "refuse to unbind: exclude ownership block is missing or damaged — " +
      "inspect .git/info/exclude and .codex/config.toml manually before proceeding",
    );
  }
  // configured or activation_incomplete → proceed with unbind
  if (state.status === "codex_cli_unavailable") {
    throw new Error("codex_cli_unavailable: cannot verify or remove server");
  }

  // 3. Snapshot for rollback
  const configSnap = snapshotFile(codexConfigPath(canonicalRoot));
  const excludeSnap = snapshotFile(excludePath(gitDir));
  const snapshots = [configSnap, excludeSnap];

  // 4. Remove server if it exists
  if (state.hasServer) {
    try {
      assertLocalCodexPaths(canonicalRoot);
      await h.codexRemove({ codexHome, name: expected.name });
    } catch (err) {
      rollback(snapshots, `codex mcp remove failed: ${err.message}`);
      throw new Error(`codex mcp remove failed: ${err.message}`);
    }
    // 5. Verify server is absent
    let servers;
    try {
      assertLocalCodexPaths(canonicalRoot);
      servers = await h.codexList({ codexHome });
    } catch (err) {
      rollback(snapshots, `post-remove verify failed: ${err.message}`);
      throw new Error(`post-remove verify failed: ${err.message}`);
    }
    if (servers.some((s) => s.name === "wao")) {
      rollback(snapshots, "server still present after remove");
      throw new Error("server still present after remove — rolled back");
    }
  }

  // 6. Remove exclude block
  if (state.hasExclude || excludeSnap.exists) {
    const excludeContent = excludeSnap.exists ? excludeSnap.bytes.toString("utf8") : "";
    let existingBlock = null;
    if (excludeContent) {
      try { existingBlock = findExcludeBlock(excludeContent); } catch { /* damaged */ }
    }
    if (existingBlock) {
      const before = excludeContent.substring(0, existingBlock.beginOffset);
      const after = excludeContent.substring(existingBlock.endOffset);
      const newContent = before + after;
      try {
        if (newContent.trim().length === 0 && before.length === 0) {
          // Exclude file had only our block at the start
          h.writeExclude(gitDir, newContent.trim() + "\n");
        } else {
          h.writeExclude(gitDir, newContent);
        }
      } catch (err) {
        rollback(snapshots, `exclude remove failed: ${err.message}`);
        throw new Error(`exclude remove failed: ${err.message}`);
      }
      const expectedContent = newContent.trim().length === 0 && before.length === 0
        ? newContent.trim() + "\n"
        : newContent;
      try {
        if (h.readExclude(gitDir) !== expectedContent) {
          throw new Error("written bytes do not match expected exclude content");
        }
      } catch (err) {
        rollback(snapshots, `exclude verify failed after remove: ${err.message}`);
        throw new Error(`exclude verify failed after remove: ${err.message}`);
      }
    }
  }

  let finalState;
  try {
    finalState = await classifyState(h, canonicalRoot, expected);
  } catch (err) {
    rollback(snapshots, `final state verification failed: ${err.message}`);
    throw new Error(`final state verification failed after unbind: ${err.message}`);
  }
  if (finalState.status !== "not_configured") {
    rollback(snapshots, `final state verification failed: ${finalState.status}`);
    throw new Error(`final state verification failed after unbind: ${finalState.status}`);
  }

  return { unbound: true, status: "unbound" };
}

export { SUPPORTED_HOSTS };
