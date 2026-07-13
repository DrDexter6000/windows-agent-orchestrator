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

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createWaoMcpServer } from "./server.js";

const DEFAULT_REGISTRY = "config/agents.json";
const DEFAULT_RUN_DIR = "runs";

/**
 * Parse --registry/--run-dir from argv as discrete flag pairs.
 * Structural parse only — never shell-joins. Unknown flags are ignored.
 * @param {string[]} argv
 * @returns {{registryPath: string, runDir: string}}
 */
export function parseMcpArgs(argv) {
  const out = { registryPath: DEFAULT_REGISTRY, runDir: DEFAULT_RUN_DIR };
  if (!Array.isArray(argv)) return out;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--registry" && i + 1 < argv.length) {
      out.registryPath = argv[i + 1];
      i += 1;
    } else if (arg === "--run-dir" && i + 1 < argv.length) {
      out.runDir = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

async function main() {
  const { registryPath, runDir } = parseMcpArgs(process.argv.slice(2));
  const server = createWaoMcpServer({
    registryPath: resolve(registryPath),
    runDir: resolve(runDir),
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
