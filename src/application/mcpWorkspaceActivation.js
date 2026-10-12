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
import { homedir, tmpdir } from "node:os";
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

// TD-191① / 决定 0043：宿主闭集从 hostDescriptors 派生（唯一权威），不再手写字面量。
// 含义随三能力矩阵分化：autoBind 宿主（codex）真写配置；snippet-only 宿主
// （claude-code 等）mcp bind emit 精确片段而非拒绝——"输出片段"不等于"绑定成功"。
import { HOST_DESCRIPTORS, HOST_DESCRIPTOR_IDS, findHostDescriptor } from "../hostAdapters/hostDescriptors.js";
// 决定 0066：宿主注册状态只读探测（snippet-only 宿主的 status 不再是 not_applicable）。
import { probeHostRegistration, describeStdioEntry } from "../hostAdapters/hostRegistrationProbe.js";
// 片段构造与宿主示例行复用 onboarding 的单一派生（TD-191① 验收判据：消灭第二清单）。
import { buildMcpSnippet, buildHostExamples } from "./onboarding.js";

// ── Constants ────────────────────────────────────────────────────────────────

const SUPPORTED_HOSTS = HOST_DESCRIPTOR_IDS;

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
  if (typeof host !== "string" || host.length === 0) {
    throw new Error(`unsupported host: ${host} (known hosts: ${SUPPORTED_HOSTS.join(", ")})`);
  }
  // 决定 0066（修订 0043 第 2 条的 bind 面）：表外宿主不再只得到拒绝——emit 通用
  // stdio 片段。command/args 是宿主中立事实，不是格式猜测；该宿主的配置语法与
  // 是否加载 WAO 一概未核实，输出必须明说（零写入，同 snippet 模式）。
  if (!SUPPORTED_HOSTS.includes(host)) {
    const generic = buildMcpSnippet({ installRoot: REPO_ROOT });
    return {
      bound: false,
      mode: "generic-snippet",
      host,
      hostKnown: false,
      hostVerified: false,
      knownHosts: SUPPORTED_HOSTS,
      stdio: generic.mcpServers.wao,
      snippet: { configShape: "mcpServers", ...generic },
      note:
        `GENERIC SNIPPET — NOT BOUND, FORMAT NOT VERIFIED FOR ${host}: ${host} is not in WAO's host table ` +
        `(known hosts: ${SUPPORTED_HOSTS.join(", ")}). Register a stdio MCP server named "wao" with the command/args above ` +
        `in ${host}'s own MCP config syntax (the mcpServers JSON shape is the common one), then start a new session. ` +
        `WAO cannot probe this host: mcp status will not be able to confirm the registration.`,
    };
  }
  // snippet-only 宿主：emit 精确注册片段，零写入（TD-191①）。cwd 不参与——
  // 片段只含安装根路径，与目标项目无关；不做 workspace 证明、不碰任何配置。
  const descriptor = findHostDescriptor(host);
  if (descriptor && !descriptor.autoBind) {
    // 片段按宿主形态渲染（决定 0043）：mcpServers 宿主 vs zcode 插件包形态。
    const entry = buildMcpSnippet({ installRoot: REPO_ROOT }).mcpServers.wao;
    const snippet = descriptor.renderSnippet(entry);
    const example = buildHostExamples(buildMcpSnippet({ installRoot: REPO_ROOT })).find((e) => e.host === host) ?? null;
    return {
      bound: false,
      mode: "snippet",
      host,
      hostLabel: descriptor.label,
      hostVerified: descriptor.hostVerified,
      snippet,
      example,
      // 决定 0066：文件式注册的宿主给出要并入的配置文件位置（有注册子命令的宿主无此字段）。
      ...(descriptor.configHint ? { configFile: descriptor.configHint } : {}),
      note:
        `SNIPPET GENERATED — NOT BOUND: WAO never writes ${host} config. ` +
        `Paste the snippet into ${host}'s MCP config (or run the example command), then restart ${host}. ` +
        `Check the result with: mcp status --host ${host}`,
    };
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
export async function statusWorkspace({ host, cwd, hooks, probe, includeUserRegistration = false }) {
  if (!SUPPORTED_HOSTS.includes(host)) {
    return {
      bound: false,
      host,
      status: "unsupported_host",
      // 决定 0066：表外宿主如实说明"查不了"与去哪看，而不是只给一个状态码。
      note: `${host} is not in WAO's host table (known hosts: ${SUPPORTED_HOSTS.join(", ")}); WAO has no probe for it. Look for a "wao" entry in ${host}'s own MCP config. mcp bind --host ${host} prints a generic stdio snippet.`,
    };
  }
  // snippet-only 宿主：WAO 从不写其配置（bound 恒 false），但决定 0066 起只读探测
  // 宿主自己的配置，如实回答注册状态（0043 第 3 条的 not_applicable 由此取代）。
  const statusDescriptor = findHostDescriptor(host);
  if (statusDescriptor && !statusDescriptor.autoBind) {
    const probed = probeHostRegistration(host, { expectedStdio: stdioPath(), cwd, ...probe });
    const state = probed?.state ?? "unknown";
    return {
      bound: false,
      host,
      mode: "snippet-only",
      status: state,
      registered: state === "unknown" ? null : state !== "not_registered",
      hostVerified: statusDescriptor.hostVerified,
      sources: probed?.sources ?? [],
      note: registrationNote(host, state),
    };
  }

  const h = { ...defaultHooks(), ...hooks };
  // 决定 0066：codex 的用户级注册（~/.codex 或 $CODEX_HOME）与项目级绑定是两层——
  // 项目未绑定但用户级已注册时，Lead 在 codex 里照样有 WAO 工具。仅在调用方显式
  // 要求时探测（CLI 面要；库调用默认不碰用户家目录）。只读：codex mcp list --json。
  const userRegistration = includeUserRegistration ? await codexUserRegistration(h) : undefined;
  const withUser = (result) => (userRegistration ? { ...result, userRegistration } : result);

  let canonicalRoot;
  try {
    const proof = proveWorkspace(cwd);
    canonicalRoot = proof.root;
  } catch (err) {
    return withUser({ bound: false, host, status: "invalid_workspace", error: err.message });
  }
  try {
    assertLocalCodexPaths(canonicalRoot);
  } catch (err) {
    return withUser({ bound: false, host, status: "unsafe_codex_home", error: err.message });
  }

  if (isConfigTracked(canonicalRoot)) {
    return withUser({ bound: false, host, status: "tracked_config" });
  }

  const expected = expectedServerContract(canonicalRoot);
  let state;
  try {
    state = await classifyState(h, canonicalRoot, expected);
  } catch (err) {
    return withUser({ bound: false, host, status: "unsafe_codex_home", error: err.message });
  }

  return withUser({
    bound: state.status === "configured",
    host,
    status: state.status,
    workspaceRoot: state.status === "configured" ? canonicalRoot : undefined,
    configPath: state.status === "configured" ? codexConfigPath(canonicalRoot) : undefined,
  });
}

// ── 决定 0066：宿主注册状态（只读）────────────────────────────────────────────

function registrationNote(host, state) {
  if (state === "registered") {
    return `A "wao" MCP entry pointing at this WAO install is present in ${host}'s config. Registered is not the same as loaded: ${host} picks it up in a new session.`;
  }
  if (state === "registered_other_target") {
    return `A "wao" MCP entry exists in ${host}'s config but points at a different WAO install than this one (${REPO_ROOT}).`;
  }
  if (state === "not_registered") {
    return `No "wao" MCP entry in ${host}'s config — a Lead running in ${host} has no WAO MCP tools. Register with: mcp bind --host ${host}`;
  }
  return `Could not read ${host}'s MCP config (see sources) — registration state unknown, not assumed.`;
}

/** codex 用户级注册（$CODEX_HOME 或 ~/.codex）：经 codex CLI 只读列出，不解析 TOML。 */
async function codexUserRegistration(h) {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  let servers;
  try {
    servers = await (h.codexUserList ?? h.codexList)({ codexHome });
  } catch {
    return { state: "unknown", sources: [{ scope: "user", path: codexHome, state: "unknown", detail: "codex_cli_unavailable" }] };
  }
  const wao = servers.find((s) => s.name === "wao");
  const { state, detail } = wao
    ? describeStdioEntry({ command: wao.transport?.command, args: wao.transport?.args, enabled: wao.enabled }, stdioPath())
    : { state: "not_registered" };
  return { state, sources: [{ scope: "user", path: codexHome, state, entryPresent: Boolean(wao), effective: true, ...(detail ? { detail } : {}) }] };
}

/**
 * 全宿主一览（`mcp status` 不带 --host）：逐个描述符给出注册状态。codex 行的
 * registered 取"项目级绑定 或 用户级注册"——任一成立 Lead 在 codex 里就有工具。
 */
export async function statusAllHosts({ cwd, hooks, probe, env = process.env }) {
  const hosts = [];
  for (const d of HOST_DESCRIPTORS) {
    const st = await statusWorkspace({ host: d.id, cwd, hooks, probe, includeUserRegistration: true });
    let registered = st.registered ?? null;
    if (d.autoBind) {
      const user = st.userRegistration?.state;
      registered = st.bound || user === "registered" || user === "registered_other_target"
        ? true
        : user === "not_registered" ? false : null;
    }
    hosts.push({
      host: d.id,
      label: d.label,
      hostVerified: d.hostVerified,
      registered,
      status: st.status,
      ...(st.userRegistration ? { userRegistration: st.userRegistration.state } : {}),
    });
  }
  return { installRoot: REPO_ROOT, detectedHost: detectHostFromEnv(env), hosts };
}

/** 本 CLI 进程是否运行在某个宿主会话里（仅按描述符里真机核实过的 detectEnv 判）。 */
export function detectHostFromEnv(env = process.env) {
  const hit = HOST_DESCRIPTORS.find((d) => (d.detectEnv ?? []).some((name) => env[name]));
  return hit ? hit.id : null;
}

/**
 * 派发 advisory（决定 0066）：CLI 派发发生在某个可识别的宿主会话里、而该宿主上
 * WAO 的 MCP 没注册时，给一行 stderr 提示——Lead 被明确告知 MCP 工具在这个宿主
 * 上不可用（命令行是合法通道，这不是违规告警）。
 *
 * 警报疲劳纪律（0042 教训；会审 sol/kimi 两席均点名）：**每个宿主会话只判一次**
 * ——会话键取描述符 sessionEnv 的值（没有则按 UTC 日），判过即记入状态文件，同
 * 一会话后续派发不再探测也不再出行（故意长期走 CLI 的 Lead 每会话至多见一次）。
 * fail-open：识别不出宿主/探测抛错/状态 unknown → null 且不记状态（下次再判）；
 * 状态读失败=未判过，写失败=下次重判。状态文件只存宿主 id → 会话键的短哈希。
 * @returns {string|null}
 */
export function renderMcpHostAdvisory({ env = process.env, cwd, probe, stateDir, now = () => new Date() } = {}) {
  try {
    const host = detectHostFromEnv(env);
    if (!host) return null;
    const sessionVar = (findHostDescriptor(host)?.sessionEnv ?? []).find((n) => typeof env[n] === "string" && env[n].length > 0);
    const sessionKey = createHash("sha256")
      .update(sessionVar ? `${sessionVar}=${env[sessionVar]}` : `day=${now().toISOString().slice(0, 10)}`)
      .digest("hex").slice(0, 16);
    const dir = stateDir ?? join(env.LOCALAPPDATA ?? tmpdir(), "wao");
    const statePath = join(dir, "mcp-host-advisory.json");
    let judged = {};
    try { judged = JSON.parse(readFileSync(statePath, "utf8")) ?? {}; } catch { /* 无状态=未判过 */ }
    if (judged[host] === sessionKey) return null;
    const probed = probeHostRegistration(host, { expectedStdio: stdioPath(), cwd, env, ...probe });
    if (!probed || probed.state === "unknown") return null;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(statePath, JSON.stringify({ ...judged, [host]: sessionKey }));
    } catch { /* 写失败：下次重判（保守可见） */ }
    if (probed.state !== "not_registered") return null;
    return `[wao] advisory: this is a ${host} session and WAO's MCP is not registered for it — MCP tools are unavailable here (the CLI works). Register: wao mcp bind --host ${host} · check: wao mcp status --host ${host} (shown once per session)`;
  } catch {
    return null;
  }
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
    throw new Error(`unsupported host: ${host} (known hosts: ${SUPPORTED_HOSTS.join(", ")})`);
  }
  // snippet-only 宿主（TD-191①）：零写入 ⇒ 零解绑；显式说明而非报错。
  const unbindDescriptor = findHostDescriptor(host);
  if (unbindDescriptor && !unbindDescriptor.autoBind) {
    return {
      bound: false,
      host,
      mode: "snippet-only",
      status: "nothing_to_unbind",
      note: `${host} is a snippet-only host: WAO never wrote its config, so there is nothing to unbind. Remove the wao entry from ${host}'s own config if present.`,
    };
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
