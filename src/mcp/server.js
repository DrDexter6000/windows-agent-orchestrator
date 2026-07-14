// src/mcp/server.js
//
// WAO MCP server factory — agent-facing control plane over stdio.
//
// This is the agent-facing MCP adapter. It exposes WAO application services as
// MCP tools so an MCP host can list configured agents (registry_list) and
// dispatch supervised background runs (run_dispatch) over the MCP protocol.
//
// Architectural contract (see docs/02-architecture.md):
//   - This module imports the MCP SDK + zod (the ONLY place allowed besides tests).
//   - It depends on src/application/registryInventory.js and runDispatch.js — it
//     does NOT import src/commands/*, does NOT shell out to the CLI, does NOT
//     read credentials, does NOT write transcripts directly.
//   - registry_list is read-only. run_dispatch spawns a supervised worker via the
//     dispatchRun service (which forks a detached runner); it is destructive.
//
// The factory is dependency-injectable for testing: production wires the real
// services, tests may pass fakes to assert exactly-once invocation,
// path-non-override, and error containment without touching the filesystem.
//
// M9-1 audit closeout: this module uses the SDK high-level McpServer so that
// input validation, unknown-tool rejection, and output-schema validation are
// owned by the SDK's protocol layer (not hand-rolled). On service failure it
// returns a FIXED safe text and never concatenates err.message, stack, paths,
// env, or stderr into the result.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getRegistryInventory } from "../application/registryInventory.js";
import { dispatchRun } from "../application/runDispatch.js";
import { getRunStatus } from "../application/runStatus.js";

// Stable server identity advertised at initialize.
const SERVER_NAME = "wao-mcp";
const SERVER_VERSION = "0.0.1";

/**
 * Defensive field check for run_status payload normalization: a field counts as
 * a usable string only if it is a non-empty finite string. null/undefined/NaN/
 * empty all fail, collapsing incomplete event/activity pairs to null.
 * @param {unknown} v
 * @returns {boolean}
 */
function isStringField(v) {
  return typeof v === "string" && v.length > 0;
}

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

// Fixed safe text returned when run dispatch fails. Never concatenate dynamic
// content (err.message, path, argv, env) — the model learns only that dispatch
// failed, never operational detail.
const DISPATCH_ERROR_TEXT = "run_dispatch failed";

// run_dispatch input: only agentId + prompt. Strict — rejects registryPath,
// runDir, runId, cwd, requireCertified, timeouts, isolation, delivery, etc.
// Those are server-owned config; a model must not override them per call.
const RUN_DISPATCH_INPUT = z.object({
  agentId: z.string().min(1),
  prompt: z.string().min(1),
}).strict();

// run_dispatch output: only runId + accepted + state. No paths, PID, prompt, argv.
const RUN_DISPATCH_OUTPUT = z.object({
  runId: z.string(),
  accepted: z.boolean(),
  state: z.string(),
});

// Dispatch spawns a worker that executes commands, modifies files, and may
// reach external systems — it is destructive (not append-only) per the SDK
// annotation contract. Not read-only, not idempotent, open world.
const RUN_DISPATCH_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const RUN_DISPATCH_DESCRIPTION =
  "Dispatch a supervised background run to a worker agent. The worker receives " +
  "a bounded task prompt; WAO owns dispatch, the detached runner, and the transcript. " +
  "Returns a runId the Lead can supervise later. Only agentId and prompt are accepted; " +
  "registry, run directory, and certification are fixed by the server.";

// Fixed safe text for run_status failure. Never concatenates dynamic content.
const STATUS_ERROR_TEXT = "run_status failed";

// run_status input: only runId. runDir is server-owned; a model cannot override it.
const RUN_STATUS_INPUT = z.object({
  runId: z.string().min(1),
}).strict();

// run_status output: ONLY safe machine fields. No raw event payloads, commands,
// paths, messages, tool input, or error content. lastEvent/lastActivity are null
// when absent.
const RUN_STATUS_OUTPUT = z.object({
  runId: z.string(),
  state: z.string(),
  terminal: z.boolean(),
  lastEvent: z.object({
    type: z.string(),
    ts: z.string(),
  }).nullable(),
  lastActivity: z.object({
    kind: z.string(),
    ts: z.string(),
    secondsSince: z.number().nullable(),
  }).nullable(),
});

const RUN_STATUS_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const RUN_STATUS_DESCRIPTION =
  "Query the point-in-time status of a run: its state, whether it is terminal, and " +
  "the last event / last worker activity timestamp and age. Read-only. Returns only " +
  "safe machine fields — no command text, file paths, tool inputs, messages, or error " +
  "content. Accepts only runId; the run directory is fixed by the server.";

/**
 * Create a WAO MCP server with registry_list, run_dispatch, and run_status tools.
 *
 * @param {object} input
 * @param {string} input.registryPath — path to agents.json (startup config)
 * @param {string} input.runDir — path to runs/ dir
 * @param {Function} [input.getRegistryInventoryFn] — injectable for testing
 * @param {Function} [input.dispatchRunFn] — injectable dispatcher for testing
 * @param {Function} [input.getRunStatusFn] — injectable status service for testing
 * @returns {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer}
 */
export function createWaoMcpServer({
  registryPath,
  runDir,
  getRegistryInventoryFn,
  dispatchRunFn,
  getRunStatusFn,
}) {
  const service = getRegistryInventoryFn ?? getRegistryInventory;
  const dispatcher = dispatchRunFn ?? dispatchRun;
  const statusService = getRunStatusFn ?? getRunStatus;

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

  mcp.registerTool(
    "run_dispatch",
    {
      description: RUN_DISPATCH_DESCRIPTION,
      inputSchema: RUN_DISPATCH_INPUT,
      outputSchema: RUN_DISPATCH_OUTPUT,
      annotations: RUN_DISPATCH_ANNOTATIONS,
    },
    async ({ agentId, prompt }) => {
      let result;
      try {
        result = await dispatcher({
          agentId,
          prompt,
          registryPath,
          runDir,
          // MCP always requires certification — the control plane decides this,
          // never the model. Background path now propagates it (M9-2A).
          requireCertified: true,
        });
      } catch {
        // Redaction: fixed safe text. Never surface err.message/path/argv/env.
        return {
          isError: true,
          content: [{ type: "text", text: DISPATCH_ERROR_TEXT }],
        };
      }
      // Only runId/accepted/state — strip transcriptPath and any internal detail.
      const payload = {
        runId: result.runId,
        accepted: result.accepted,
        state: result.state,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  );

  mcp.registerTool(
    "run_status",
    {
      description: RUN_STATUS_DESCRIPTION,
      inputSchema: RUN_STATUS_INPUT,
      outputSchema: RUN_STATUS_OUTPUT,
      annotations: RUN_STATUS_ANNOTATIONS,
    },
    async ({ runId }) => {
      // The entire service call + safe-payload construction + output-schema
      // validation are inside ONE try/catch. Any malformed service result or
      // schema mismatch must collapse to the fixed safe text — never leak the
      // SDK's detailed Output validation error (which can include field names,
      // expected types, or internal structure).
      try {
        const status = await statusService({ runId, runDir });
        // Normalize timestamps defensively: a legacy/malformed transcript event
        // may have lastEventType present but lastEventTs null/NaN/non-string.
        // Incomplete pairs collapse to null rather than producing a payload that
        // would fail output-schema validation downstream.
        const lastEvent = isStringField(status.lastEventType) && isStringField(status.lastEventTs)
          ? { type: status.lastEventType, ts: status.lastEventTs }
          : null;
        const lastActivity = isStringField(status.lastActivityTs) && isStringField(status.lastActivityEventKind)
          ? {
              kind: status.lastActivityEventKind,
              ts: status.lastActivityTs,
              secondsSince: typeof status.secondsSinceActivity === "number" && Number.isFinite(status.secondsSinceActivity)
                ? status.secondsSinceActivity
                : null,
            }
          : null;
        const payload = {
          runId: status.runId,
          state: status.state,
          terminal: status.terminal,
          lastEvent,
          lastActivity,
        };
        // Pre-validate against the output schema BEFORE returning. If this
        // throws (malformed service result that normalization could not fix),
        // the catch collapses it to the fixed safe text — ahead of the SDK
        // framework's own validateToolOutput, which would otherwise emit a
        // detailed Output validation error.
        RUN_STATUS_OUTPUT.parse(payload);
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      } catch {
        // Redaction: fixed safe text. Covers service throw, malformed result,
        // and any payload/schema mismatch. Never surface err.message/path/secret
        // or SDK validation detail.
        return {
          isError: true,
          content: [{ type: "text", text: STATUS_ERROR_TEXT }],
        };
      }
    },
  );

  return mcp;
}

export { SERVER_NAME, SERVER_VERSION };
