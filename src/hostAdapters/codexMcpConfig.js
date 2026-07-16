// src/hostAdapters/codexMcpConfig.js
//
// M10 P0-1 Reframe: Codex CLI owns Codex config.toml.
//
// This adapter delegates MCP server CRUD to the Codex CLI itself:
//   codex mcp add/get/remove/list --json
//
// WAO does NOT parse or write TOML. Codex's own parser/writer handles
// escaping, quoted keys, comments, and field semantics.
//
// Architectural contract:
//   - Does NOT import src/commands/*, src/mcp/*, src/application/*, MCP SDK, or zod.
//   - Uses execFileSync with structured argv — never shell strings.
//   - Child env only overrides CODEX_HOME; everything else inherits from process.env.
//   - Never runs `codex exec` or any model-invoking command.
//
// Isolation contract:
//   - codexHome is always provided by the caller (child-scoped to a project's .codex/).
//   - This module never reads or writes ~/.codex/config.toml.
//   - stderr is captured (not mixed into errors) to avoid leaking internal paths.

import { execFileSync } from "node:child_process";

/**
 * Resolve the Codex binary invocation for the current platform.
 *
 * On Windows, npm-installed CLIs are .cmd wrappers. Node's execFileSync cannot
 * execute .cmd files directly without shell:true (which is forbidden — security).
 * The structured-argv solution is to invoke cmd.exe (ComSpec) with /c and pass
 * the .cmd file + args as discrete argv elements. This is NOT shell string
 * concatenation — each arg is a separate process argument.
 *
 * On non-Windows, "codex" is a regular binary on PATH.
 *
 * Tests inject opts.codexBin to bypass real CLI execution.
 */
function resolveCodexInvocation(opts) {
  if (opts.codexBin) {
    return { bin: opts.codexBin, args: [] };
  }
  if (process.platform === "win32") {
    // Use cmd.exe /c to run codex.cmd — structured argv, no shell string
    const comspec = process.env.ComSpec || "cmd.exe";
    return { bin: comspec, args: ["/c", "codex"] };
  }
  return { bin: "codex", args: [] };
}

/**
 * Run a codex CLI command with structured argv.
 *
 * @param {string[]} args — structured argv (e.g. ["mcp", "list", "--json"])
 * @param {{ codexBin?: string, codexHome: string }} opts
 * @returns {string} stdout (trimmed)
 * @throws {Error} if codex is unavailable or returns non-zero exit
 */
function runCodex(args, opts) {
  const { bin, args: prefix } = resolveCodexInvocation(opts);
  return execFileSync(bin, [...prefix, ...args], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: opts.codexHome },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    timeout: 15000,
  }).trim();
}

/**
 * List all MCP servers in the given CODEX_HOME.
 *
 * Uses `codex mcp list --json` which returns:
 *   - `[]` when no servers exist (exit 0)
 *   - `[{ name, enabled, transport: { type, command, args, env, env_vars, cwd }, ... }]` when servers exist
 *
 * This is the authoritative "does server X exist?" check — do NOT rely on
 * `codex mcp get` exit code, which is 1 for both "not found" and "CLI crash".
 *
 * @param {{ codexBin?: string, codexHome: string }} opts
 * @returns {Promise<Array<object>>} array of server objects (may be empty)
 * @throws {Error} "codex_cli_unavailable" if codex is missing or crashes
 */
export async function codexMcpList(opts) {
  let stdout;
  try {
    stdout = runCodex(["mcp", "list", "--json"], opts);
  } catch (err) {
    throw new Error(`codex_cli_unavailable: ${err.message}`);
  }
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error("codex_cli_unavailable: mcp list --json returned unparseable output");
  }
}

/**
 * Get a specific MCP server's full configuration.
 *
 * Uses `codex mcp get <name> --json` which returns:
 *   { name, enabled, transport: { type, command, args, env, env_vars, cwd }, ... }
 *
 * Not-found detection: caller should use codexMcpList first to check existence.
 * If get is called on a non-existent server, codex exits 1 with an error message.
 * We catch that and return null.
 *
 * @param {{ codexBin?: string, codexHome: string, name: string }} opts
 * @returns {Promise<object|null>} server object, or null if not found
 * @throws {Error} "codex_cli_error" for non-not-found failures
 */
export async function codexMcpGet(opts) {
  let stdout;
  try {
    stdout = runCodex(["mcp", "get", opts.name, "--json"], opts);
  } catch (err) {
    const msg = err.stderr?.toString?.() ?? err.message ?? "";
    // "No MCP server named '...' found." → not-found, not a crash
    if (msg.includes("No MCP server named")) {
      return null;
    }
    throw new Error(`codex_cli_error: ${err.message}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("codex_cli_error: mcp get --json returned unparseable output");
  }
}

/**
 * Add (or overwrite) an MCP server.
 *
 * Uses `codex mcp add <name> -- <command> <args...>`.
 * Codex's TOML writer handles all escaping and formatting.
 *
 * @param {{ codexBin?: string, codexHome: string, name: string, command: string, args: string[] }} opts
 * @returns {Promise<void>}
 * @throws {Error} on failure
 */
export async function codexMcpAdd(opts) {
  try {
    runCodex(["mcp", "add", opts.name, "--", opts.command, ...opts.args], opts);
  } catch (err) {
    throw new Error(`codex_cli_error: mcp add failed: ${err.message}`);
  }
}

/**
 * Remove an MCP server.
 *
 * Uses `codex mcp remove <name>`.
 * Codex preserves all other servers and settings.
 * Remove of a non-existent server exits 0 with an info message (idempotent).
 *
 * @param {{ codexBin?: string, codexHome: string, name: string }} opts
 * @returns {Promise<void>}
 * @throws {Error} on failure
 */
export async function codexMcpRemove(opts) {
  try {
    runCodex(["mcp", "remove", opts.name], opts);
  } catch (err) {
    throw new Error(`codex_cli_error: mcp remove failed: ${err.message}`);
  }
}
