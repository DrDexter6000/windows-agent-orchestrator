// src/mcp/server.js
//
// M9-1: WAO MCP server factory — read-only registry_list vertical slice.
//
// This is the agent-facing MCP adapter. It exposes WAO's registry inventory
// (the M9-0 `getRegistryInventory()` application service) as a single MCP tool
// so an MCP host can list configured agents over the MCP protocol.
//
// Architectural contract (see docs/02-architecture.md):
//   - This module imports the MCP SDK + zod (the ONLY place allowed besides tests).
//   - It depends on src/application/registryInventory.js — it does NOT import
//     src/commands/*, does NOT shell out to the CLI, does NOT write transcripts,
//     does NOT spawn runs, does NOT read credentials.
//   - The tool is strictly read-only: it returns data, never mutates state.
//
// The factory is dependency-injectable for testing: production wires the real
// `getRegistryInventory`, tests may pass a fake to assert exactly-once
// invocation and path-non-override without touching the filesystem.
//
// M9-1 audit closeout: this module uses the SDK high-level McpServer so that
// input validation, unknown-tool rejection, and output-schema validation are
// owned by the SDK's protocol layer (not hand-rolled). On service failure it
// returns a FIXED safe text and never concatenates err.message, stack, paths,
// env, or stderr into the result.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getRegistryInventory } from "../application/registryInventory.js";

// Stable server identity advertised at initialize.
const SERVER_NAME = "wao-mcp";
const SERVER_VERSION = "0.0.1";

// Fixed safe text returned when the underlying service fails. Intentionally
// constant — never concatenate dynamic content here (no err.message, no path,
// no env). This is the redaction contract: the model learns only that the
// read failed, never why in operational detail.
const SERVICE_ERROR_TEXT = "registry_list failed";

// The registry_list tool input: a strict empty object. Extra keys are rejected
// by zod validation before the service is ever called, so a model cannot
// override server-side registryPath/runDir via tool arguments.
const REGISTRY_LIST_INPUT = z.object({}).strict();

// The structured output shape: { agents: [...] }. certification is nullable
// because an agent may have no reliability-summary entry.
const AGENT_ENTRY = z.object({
  id: z.string(),
  backend: z.string(),
  model: z.string(),
  certification: z.string().nullable(),
  cwd: z.string(),
});

const REGISTRY_LIST_OUTPUT = z.object({
  agents: z.array(AGENT_ENTRY),
});

// Read-only annotations tell MCP hosts this tool is safe to cache/retry and
// does not mutate the world.
const REGISTRY_LIST_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const REGISTRY_LIST_DESCRIPTION =
  "List configured WAO worker agents with their backend, model, and reliability " +
  "certification status. Read-only. Accepts no file-path arguments; the registry " +
  "and run directory are fixed at server startup.";

/**
 * Create a WAO MCP server with a single read-only tool: registry_list.
 *
 * @param {object} input
 * @param {string} input.registryPath — path to agents.json (startup config)
 * @param {string} input.runDir — path to runs/ dir (for reliability-summary.json)
 * @param {Function} [input.getRegistryInventoryFn] — injectable for testing
 * @returns {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer}
 */
export function createWaoMcpServer({
  registryPath,
  runDir,
  getRegistryInventoryFn,
}) {
  const service = getRegistryInventoryFn ?? getRegistryInventory;

  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { version: SERVER_VERSION },
  );

  mcp.registerTool(
    "registry_list",
    {
      description: REGISTRY_LIST_DESCRIPTION,
      inputSchema: REGISTRY_LIST_INPUT,
      outputSchema: REGISTRY_LIST_OUTPUT,
      annotations: REGISTRY_LIST_ANNOTATIONS,
    },
    async () => {
      let agents;
      try {
        agents = await service({ registryPath, runDir });
      } catch {
        // Redaction contract: fixed safe text only. Never surface err.message,
        // stack, paths, env, or any dynamic detail to the model.
        return {
          isError: true,
          content: [{ type: "text", text: SERVICE_ERROR_TEXT }],
        };
      }
      const payload = { agents };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  );

  return mcp;
}

export { SERVER_NAME, SERVER_VERSION };
