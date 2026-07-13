// src/mcp/server.js
//
// M9-1: WAO MCP server factory — read-only registry_list vertical slice.
//
// This is the agent-facing MCP adapter. It exposes WAO's registry inventory
// (the M9-0 `getRegistryInventory()` application service) as a single MCP tool
// so an MCP host can list configured agents over the MCP protocol.
//
// Architectural contract (see docs/02-architecture.md):
//   - This module imports the MCP SDK (the ONLY place allowed besides tests).
//   - It depends on src/application/registryInventory.js — it does NOT import
//     src/commands/*, does NOT shell out to the CLI, does NOT write transcripts,
//     does NOT spawn runs, does NOT read credentials.
//   - The tool is strictly read-only: it returns data, never mutates state.
//
// The factory is dependency-injectable for testing: production wires the real
// `getRegistryInventory`, tests may pass a fake to assert exactly-once
// invocation and path-non-override without touching the filesystem.

import { Server } from "@modelcontextprotocol/sdk/server";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { getRegistryInventory } from "../application/registryInventory.js";

// Stable server identity advertised at initialize.
const SERVER_NAME = "wao-mcp";
const SERVER_VERSION = "0.0.1";

// The only tool this server registers. No write/dispatch/run tools here —
// exposing mutation surface is out of scope for M9-1 and would violate the
// read-only boundary.
const REGISTRY_LIST_TOOL = {
  name: "registry_list",
  description:
    "List configured WAO worker agents with their backend, model, and reliability " +
    "certification status. Read-only. Accepts no file-path arguments; the registry " +
    "and run directory are fixed at server startup.",
  // The tool deliberately takes NO parameters. registryPath/runDir are startup
  // configuration — a model must not override them per call.
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

/**
 * Create a WAO MCP server with a single read-only tool: registry_list.
 *
 * @param {object} input
 * @param {string} input.registryPath — path to agents.json (startup config)
 * @param {string} input.runDir — path to runs/ dir (for reliability-summary.json)
 * @param {Function} [input.getRegistryInventoryFn] — injectable for testing
 * @returns {import("@modelcontextprotocol/sdk/server").Server}
 */
export function createWaoMcpServer({
  registryPath,
  runDir,
  getRegistryInventoryFn,
}) {
  const service = getRegistryInventoryFn ?? getRegistryInventory;

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [REGISTRY_LIST_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request?.params?.name;
    if (toolName !== REGISTRY_LIST_TOOL.name) {
      // Unknown tool — return a bounded MCP error result, no stack.
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${toolName}` }],
      };
    }

    try {
      const agents = await service({ registryPath, runDir });
      const payload = { agents };
      const text = JSON.stringify(payload);
      const result = {
        content: [{ type: "text", text }],
      };
      // v1 SDK transparently passes structuredContent through to the client when
      // present. We include it so hosts that prefer structured data get the same
      // object. If a future SDK strips it, the text content above is the contract.
      result.structuredContent = payload;
      return result;
    } catch (err) {
      // Containment: never leak raw stack, env, or arbitrary error properties.
      // Surface only a bounded, safe message as an MCP tool error result.
      const message = err && typeof err.message === "string" ? err.message : "registry_list failed";
      return {
        isError: true,
        content: [{ type: "text", text: `registry_list failed: ${message}` }],
      };
    }
  });

  return server;
}

export { SERVER_NAME, SERVER_VERSION, REGISTRY_LIST_TOOL };
