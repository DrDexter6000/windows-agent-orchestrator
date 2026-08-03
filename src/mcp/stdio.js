// src/mcp/stdio.js
//
// M9-1: Production MCP stdio entrypoint.
//
// Launches the WAO MCP server over stdio using the official StdioServerTransport.
// An MCP host spawns this process and speaks the MCP protocol over its stdin/stdout.
//
// Boundaries:
//   - stdout carries ONLY MCP protocol frames. Any diagnostic (startup banner,
//     errors, help) goes to stderr. Mixing banner text into stdout would corrupt
//     the protocol stream that hosts parse line-by-line.
//   - argv is parsed structurally (discrete --flag value pairs), never joined
//     into a shell string. This keeps Windows paths with spaces correct and
//     avoids shell injection.
//   - registryPath/runDir default to the repo's config/agents.json and runs/ to
//     match the CLI's existing defaults, but the CLI's config behavior itself
//     is NOT changed here.
//
// Entrypoint: invoked via the repo Node shim (see package.json "mcp" script):
//   node scripts/wao-node.cjs src/mcp/stdio.js [--registry PATH] [--run-dir PATH]

import { resolve, dirname, join, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import process from "node:process";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createWaoMcpServer } from "./server.js";
import { isKnownProfileValue } from "./toolProfiles.js";

const DEFAULT_REGISTRY = "config/agents.json";
const DEFAULT_RUN_DIR = "runs";
// M10-pre3: default execution deadline is disabled (null).
// Previously 300000, which caused real workers still making progress to be killed.

// M10-pre closeout-2: derive the WAO repo root from THIS module's location, not
// process.cwd(). An MCP host's cwd is not guaranteed to be the WAO repo — it
// could be anywhere. stdio.js lives at src/mcp/stdio.js, so repo root is two
// levels up (src/mcp/ → src/ → repo root).
const _MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(_MODULE_DIR, "..", "..");

/**
 * Resolve the config/default.json path relative to the WAO repo root, not the
 * host's cwd. Optionally accepts an explicit override path for testing.
 * @param {string} [override] — explicit config path (tests)
 * @returns {string} absolute path to config/default.json
 */
function resolveConfigPath(override) {
  return override ? resolve(override) : join(REPO_ROOT, "config", "default.json");
}

/**
 * Load global config.waitTimeout from config/default.json.
 *
 * The config path is derived from THIS module's location (src/mcp/stdio.js →
 * repo root → config/default.json), NOT from process.cwd(). An MCP host may
 * have any cwd; relying on it would silently read the wrong file or miss it.
 *
 * Contract on missing/corrupt config:
 *   - If the file is missing, unparseable, or waitTimeout is null/undefined,
 *     the function returns null (disabled). It NEVER silently falls back to 300000.
 *   - A valid explicit integer in [1000, 600000] is passed through.
 *
 * @param {string} [configOverride] — explicit config path (tests only)
 * @returns {Promise<number|null>} validated timeout or null (disabled)
 */
async function loadGlobalWaitTimeout(configOverride) {
  const configPath = resolveConfigPath(configOverride);
  if (!existsSync(configPath)) return null;
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    // M10-pre3: null/undefined means disabled
    if (parsed.waitTimeout === null || parsed.waitTimeout === undefined) return null;
    const wt = Number(parsed.waitTimeout);
    if (Number.isFinite(wt) && Number.isInteger(wt) && wt >= 1000 && wt <= 600000) {
      return wt;
    }
  } catch {
    // fall through to disabled
  }
  return null;
}

// Exported for the cwd-independence test (M10pre-C2-06). This function is
// server-internal; it is NOT part of the MCP tool surface.
export { loadGlobalWaitTimeout as loadGlobalWaitTimeoutForTest };

/**
 * Parse --registry/--run-dir/--workspace-root/--tool-profile from argv as
 * discrete flag pairs. Structural parse only — never shell-joins. Unknown flags
 * are ignored.
 *
 * --workspace-root has strict fail-closed semantics:
 *   - Missing value (flag at end of argv): throw
 *   - Empty string or whitespace-only value: throw
 *   - Relative path: throw
 *   - Duplicate flag: throw
 *   The throw propagates to main().catch() which prints the fixed startup fatal
 *   text — the path value is never printed.
 *
 * --tool-profile (M12-10) is the protocol-neutral static tool surface selector.
 * It is ADDITIVE — it never changes --registry/--run-dir/--workspace-root
 * semantics. Strict fail-closed:
 *   - Missing value (flag at end of argv): throw
 *   - Empty string or whitespace-only value: throw
 *   - Duplicate flag: throw
 *   - Value outside the closed set {full, lead}: throw
 *   Absent flag => toolProfile undefined, and the server resolves that to "full"
 *   (the default 23-tool surface — zero behavior change for any existing Host).
 *   The throw propagates to main().catch() which prints the fixed startup fatal
 *   text — the offending value is never printed.
 *
 * --registry and --run-dir keep their existing lenient behavior (last-wins,
 * missing value ignored) to avoid regressions in existing host configurations.
 *
 * @param {string[]} argv
 * @returns {{registryPath: string, runDir: string, workspaceRoot: string|undefined, toolProfile: string|undefined}}
 * @throws {Error} on malformed --workspace-root or --tool-profile
 */
export function parseMcpArgs(argv) {
  const out = { registryPath: DEFAULT_REGISTRY, runDir: DEFAULT_RUN_DIR, workspaceRoot: undefined, toolProfile: undefined };
  if (!Array.isArray(argv)) return out;
  let workspaceRootSeen = false;
  let toolProfileSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--registry" && i + 1 < argv.length) {
      out.registryPath = argv[i + 1];
      i += 1;
    } else if (arg === "--run-dir" && i + 1 < argv.length) {
      out.runDir = argv[i + 1];
      i += 1;
    } else if (arg === "--tool-profile") {
      // Duplicate detection — fail closed on ambiguity.
      if (toolProfileSeen) {
        throw new Error("tool-profile: duplicate flag");
      }
      toolProfileSeen = true;
      // Missing value — flag at end of argv with no following argument.
      if (i + 1 >= argv.length) {
        throw new Error("tool-profile: missing value");
      }
      const value = argv[i + 1];
      // Empty or whitespace-only value.
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("tool-profile: empty value");
      }
      // Closed-set membership — never silently coerce an unknown value to full.
      if (!isKnownProfileValue(value)) {
        throw new Error("tool-profile: unknown value");
      }
      out.toolProfile = value;
      i += 1;
    } else if (arg === "--workspace-root") {
      // Duplicate detection — fail closed on ambiguity.
      if (workspaceRootSeen) {
        throw new Error("workspace-root: duplicate flag");
      }
      workspaceRootSeen = true;
      // Missing value — flag at end of argv with no following argument.
      if (i + 1 >= argv.length) {
        throw new Error("workspace-root: missing value");
      }
      const value = argv[i + 1];
      // Empty or whitespace-only value.
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("workspace-root: empty value");
      }
      // Must be absolute — relative paths are rejected.
      if (!isAbsolute(value)) {
        throw new Error("workspace-root: relative path");
      }
      out.workspaceRoot = value;
      i += 1;
    }
  }
  return out;
}

async function main() {
  let parsed;
  try {
    parsed = parseMcpArgs(process.argv.slice(2));
  } catch {
    // parseMcpArgs throws on malformed --workspace-root (missing/empty/relative/duplicate).
    // The error is caught here — the path value or error detail is never printed.
    process.stderr.write("[wao-mcp] fatal: startup failed\n");
    process.exitCode = 1;
    return;
  }
  const { registryPath, runDir, workspaceRoot, toolProfile } = parsed;
  // M10-pre2: workspaceRoot has already been validated by parseMcpArgs
  // (absolute, non-empty, non-duplicate). Resolve it for canonical form.
  let validatedWorkspaceRoot;
  if (workspaceRoot !== undefined) {
    validatedWorkspaceRoot = resolve(workspaceRoot);
  }
  // M10-pre closeout: load server-owned global waitTimeout so the MCP dispatch
  // path threads it to the detached runner — same precedence as CLI background.
  const globalWaitTimeout = await loadGlobalWaitTimeout();
  const server = createWaoMcpServer({
    registryPath: resolve(registryPath),
    runDir: resolve(runDir),
    globalWaitTimeout,
    // M12-10: toolProfile is undefined when no --tool-profile flag is present;
    // the server then resolves the default full 23-tool surface. Only forward
    // it when explicitly set.
    ...(toolProfile ? { toolProfile } : {}),
    ...(validatedWorkspaceRoot ? { workspaceRoot: validatedWorkspaceRoot } : {}),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Diagnostics to stderr only; stdout stays protocol-pure. The banner is a
  // FIXED string — never echo registryPath/runDir here, because MCP hosts
  // collect stderr and those absolute paths are host-local sensitive data.
  process.stderr.write("[wao-mcp] stdio server ready\n");
}

// Only run when invoked directly as an entrypoint, not when imported by tests.
// Compare via file URLs to stay platform-agnostic (Windows drive letters, slashes).
const entryUrl = pathToFileURL(resolve(process.argv[1] ?? "")).href;
const invokedDirectly = entryUrl === import.meta.url;

if (invokedDirectly) {
  main().catch(() => {
    // Fixed safe text only — never echo err.message, stack, or paths to
    // stderr (MCP hosts collect stderr and raw messages can leak internals).
    process.stderr.write("[wao-mcp] fatal: startup failed\n");
    process.exitCode = 1;
  });
}

export { main };
