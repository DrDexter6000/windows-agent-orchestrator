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
import { collectRunMessages } from "../application/runCollect.js";
import { getRunDiagnosis } from "../application/runDiagnosis.js";
import { getRunDelivery, decideRunDelivery } from "../application/runDelivery.js";
import { DIAGNOSIS_CATEGORIES } from "../diagnosis.js";
import { RUN_STATES } from "../transcript.js";
import { createSecretRedactor } from "../secretRedaction.js";

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

// ===== run_collect bounded projection constants =====

const COLLECT_ERROR_TEXT = "run_collect failed";
const COLLECT_LIMIT = 50;
const COLLECT_MAX_MESSAGES = 8;
const COLLECT_MAX_TEXT_CHARS = 4000;
const COLLECT_MAX_TOTAL_CHARS = 12000;

const RUN_COLLECT_INPUT = z.object({
  runId: z.string().min(1),
}).strict();

const COLLECTED_MESSAGE = z.object({
  role: z.string(),
  text: z.string(),
  truncated: z.boolean(),
});

const RUN_COLLECT_OUTPUT = z.object({
  runId: z.string(),
  backend: z.string(),
  reconstructed: z.boolean(),
  itemCount: z.number(),
  messages: z.array(COLLECTED_MESSAGE),
  evidenceCounts: z.object({
    message: z.number(),
    command: z.number(),
    toolUse: z.number(),
    toolResult: z.number(),
    fileWritten: z.number(),
    other: z.number(),
  }),
  truncated: z.boolean(),
});

const RUN_COLLECT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const RUN_COLLECT_DESCRIPTION =
  "Collect a run's worker output: bounded, redacted assistant-authored text plus " +
  "evidence counts (no raw commands, tool inputs/outputs, file paths, or unknown " +
  "payloads). Each successful call appends one messages.collected audit event to the " +
  "transcript (not idempotent). Accepts only runId; the run directory and limit are "  +
  "fixed by the server.";

/**
 * Project a raw collect result into a bounded, redacted MCP-safe output.
 *
 * Extracts ONLY assistant-authored text parts. Applies per-message (4000 char) and
 * total (12000 char) and count (8 message) caps with accurate truncated flags.
 * Secrets in text are redacted via the process secret redactor. Evidence kinds are
 * counted (no raw payload). Unknown/malformed entries count as "other" only.
 *
 * @param {object} rawResult — collectRunMessages return value
 * @param {string} runId
 * @returns {object} bounded projection matching RUN_COLLECT_OUTPUT
 */
function projectCollectResult(rawResult, runId) {
  const redactor = createSecretRedactor();
  const items = Array.isArray(rawResult.data) ? rawResult.data : [];

  const evidenceCounts = { message: 0, command: 0, toolUse: 0, toolResult: 0, fileWritten: 0, other: 0 };
  const messages = [];
  let totalChars = 0;
  let messagesTruncated = false;

  for (const item of items) {
    // Tally evidence counts by kind — no payload included. This happens for
    // EVERY item regardless of text/quota limits, so evidenceCounts always
    // covers the full set.
    const kind = item?.kind;
    // Serve messages lack `kind`; detect them by the {info:{role}, parts} shape.
    const isServeMessage = !kind && item?.info && Array.isArray(item.parts);
    if (kind === "message" || isServeMessage) evidenceCounts.message += 1;
    else if (kind === "command") evidenceCounts.command += 1;
    else if (kind === "tool_use") evidenceCounts.toolUse += 1;
    else if (kind === "tool_result") evidenceCounts.toolResult += 1;
    else if (kind === "file_written") evidenceCounts.fileWritten += 1;
    else evidenceCounts.other += 1;

    // Only extract assistant text; skip everything else from the messages array.
    if (kind !== "message" && !isServeMessage) continue;
    // Process: {role, parts}. Serve: {info:{role}, parts}. Only assistant.
    const role = item.role ?? item.info?.role;
    if (role !== "assistant") continue;

    // Extract text parts. A message with NO non-empty text (e.g. tool_use-only)
    // is counted in evidenceCounts but does NOT enter the messages array and
    // does NOT consume the 8-message quota — it carries no Lead-readable result.
    const parts = Array.isArray(item.parts) ? item.parts : [];
    const textParts = parts
      .filter((p) => p && p.type === "text" && typeof p.text === "string" && p.text.length > 0)
      .map((p) => p.text);
    if (textParts.length === 0) continue;

    let text = redactor.redactString(textParts.join("\n"));

    // Per-text cap (4000 chars).
    let perTruncated = false;
    if (text.length > COLLECT_MAX_TEXT_CHARS) {
      text = text.slice(0, COLLECT_MAX_TEXT_CHARS);
      perTruncated = true;
      messagesTruncated = true;
    }

    // Total cap (12000 chars). When the budget is exhausted, stop collecting
    // text but CONTINUE the loop so later items are still counted in
    // evidenceCounts. (Old code used `break`, which skipped later tallies.)
    if (totalChars + text.length > COLLECT_MAX_TOTAL_CHARS) {
      const remaining = COLLECT_MAX_TOTAL_CHARS - totalChars;
      messagesTruncated = true;
      if (remaining > 0 && messages.length < COLLECT_MAX_MESSAGES) {
        text = text.slice(0, remaining);
        perTruncated = true;
        totalChars += text.length;
        messages.push({ role: "assistant", text, truncated: perTruncated });
      }
      continue;
    }

    // 8-message count cap.
    if (messages.length >= COLLECT_MAX_MESSAGES) {
      messagesTruncated = true;
      continue;
    }

    totalChars += text.length;
    messages.push({ role: "assistant", text, truncated: perTruncated });
  }

  return {
    runId,
    backend: rawResult.backend ?? "unknown",
    reconstructed: Boolean(rawResult.reconstructed),
    itemCount: items.length,
    messages,
    evidenceCounts,
    truncated: messagesTruncated,
  };
}

// ===== run_diagnose safe projection constants =====

const DIAGNOSE_ERROR_TEXT = "run_diagnose failed";
const DIAGNOSE_MAX_SIGNALS = 8;
const DIAGNOSE_MAX_TYPE_CHARS = 64;

// Exact set of event types that diagnoseFailure evidence can legitimately
// produce. Only these pass through the MCP projection verbatim; everything
// else — including paths, commands, control chars, and pure-ASCII
// secret-shaped strings — maps to "unknown". This is a closed set, not a
// character-class filter, so no attacker-controlled string can sneak through
// by being purely alphanumeric.
const SAFE_DIAGNOSIS_EVENT_TYPES = new Set([
  "run.stop_requested",
  "run.aborted",
  "run.state_change",
  "run.error",
  "run.timed_out",
  "scorecard.checked",
  "run.evidence_audit",
  "run.event",
]);

const RUN_DIAGNOSE_INPUT = z.object({
  runId: z.string().min(1),
}).strict();

// Category enum from the diagnosis SSOT — no second hand-maintained list.
const DIAGNOSIS_CATEGORY_ENUM = z.enum(DIAGNOSIS_CATEGORIES);

const RUN_DIAGNOSE_OUTPUT = z.object({
  runId: z.string(),
  state: z.string(),
  terminal: z.boolean(),
  category: DIAGNOSIS_CATEGORY_ENUM,
  signalEventTypes: z.array(z.string().min(1).max(DIAGNOSE_MAX_TYPE_CHARS)).max(DIAGNOSE_MAX_SIGNALS),
  signalCount: z.number().int().nonnegative(),
  signalsTruncated: z.boolean(),
});

const RUN_DIAGNOSE_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const RUN_DIAGNOSE_DESCRIPTION =
  "Diagnose a run's failure category and signal event types. Read-only, idempotent. " +
  "Returns only safe machine fields (category, event types, counts). Does not return " +
  "raw error text, commands, file paths, or tool payloads. The Lead decides what to " +
  "do next; this tool gives facts only.";

// ===== run_delivery (read-only query) constants =====

const DELIVERY_QUERY_ERROR_TEXT = "run_delivery failed";
const COMMIT_HASH_RE = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;
const COMMIT_HASH_SCHEMA = z.string().regex(COMMIT_HASH_RE);
const SAFE_VERIFICATION_STATUSES = new Set(["pending", "passed", "failed", "unavailable"]);
const SAFE_FAILURE_CODES = new Set(["command_failed", "command_timeout", "artifact_mutated", "artifact_mismatch", "execution_error", "unknown"]);
const SAFE_ACCEPTANCE_STATUSES = new Set(["pending", "accepted", "rejected"]);
const SAFE_DECISION_TYPES = new Set(["run.delivery_accepted", "run.delivery_rejected"]);
const TERMINAL_STATE_ENUM = z.enum(RUN_STATES);
const VERIFICATION_STATUS_ENUM = z.enum(["pending", "passed", "failed", "unavailable"]);
const ACCEPTANCE_STATUS_ENUM = z.enum(["pending", "accepted", "rejected"]);
const FAILURE_CODE_ENUM = z.enum(["command_failed", "command_timeout", "artifact_mutated", "artifact_mismatch", "execution_error", "unknown"]);
const DECISION_TYPE_ENUM = z.enum(["run.delivery_accepted", "run.delivery_rejected"]);

const RUN_DELIVERY_INPUT = z.object({
  runId: z.string().min(1),
}).strict();

const RUN_DELIVERY_OUTPUT = z.object({
  runId: z.string().min(1),
  terminalState: TERMINAL_STATE_ENUM,
  baseCommit: COMMIT_HASH_SCHEMA,
  deliveryCommit: COMMIT_HASH_SCHEMA,
  changedFileCount: z.number().int().nonnegative(),
  verificationStatus: VERIFICATION_STATUS_ENUM,
  verificationFailureCode: FAILURE_CODE_ENUM.nullable(),
  acceptanceStatus: ACCEPTANCE_STATUS_ENUM,
  decisionType: DECISION_TYPE_ENUM.nullable(),
});

const RUN_DELIVERY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const RUN_DELIVERY_DESCRIPTION =
  "Query the delivery status of a run: terminal state, delivery/base commit hashes, " +
  "changed file count, verification status, and acceptance status. Read-only. Does not " +
  "return changed file names, worktree paths, verification commands, or decision reasons.";

// ===== run_delivery_decide (durable decision) constants =====

const DELIVERY_DECIDE_ERROR_TEXT = "run_delivery_decide failed";

const RUN_DELIVERY_DECIDE_INPUT = z.object({
  runId: z.string().min(1),
  decision: z.enum(["accepted", "rejected"]),
  reason: z.string().trim().min(1).max(2000),
}).strict();

const RUN_DELIVERY_DECIDE_OUTPUT = z.object({
  runId: z.string().min(1),
  decisionAccepted: z.boolean(),
  deliveryCommit: COMMIT_HASH_SCHEMA,
  acceptanceStatus: z.enum(["accepted", "rejected"]),
  existingStatus: z.enum(["accepted", "rejected"]).nullable(),
});

const RUN_DELIVERY_DECIDE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const RUN_DELIVERY_DECIDE_DESCRIPTION =
  "Record an explicit Lead decision (accepted or rejected) on a delivery. The first " +
  "durable decision wins; later attempts lose without error. Does not decide correctness " +
  "automatically. Does not return the decision reason or delivery details.";

/**
 * Create a WAO MCP server with registry_list, run_dispatch, run_status, run_collect, run_diagnose, run_delivery, run_delivery_decide.
 *
 * @param {object} input
 * @param {string} input.registryPath — path to agents.json (startup config)
 * @param {string} input.runDir — path to runs/ dir
 * @param {Function} [input.getRegistryInventoryFn] — injectable for testing
 * @param {Function} [input.dispatchRunFn] — injectable dispatcher for testing
 * @param {Function} [input.getRunStatusFn] — injectable status service for testing
 * @param {Function} [input.collectRunMessagesFn] — injectable collect service for testing
 * @param {Function} [input.getRunDiagnosisFn] — injectable diagnosis service for testing
 * @param {Function} [input.getRunDeliveryFn] — injectable delivery query service for testing
 * @param {Function} [input.decideRunDeliveryFn] — injectable delivery decision service for testing
 * @returns {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer}
 */
export function createWaoMcpServer({
  registryPath,
  runDir,
  getRegistryInventoryFn,
  dispatchRunFn,
  getRunStatusFn,
  collectRunMessagesFn,
  getRunDiagnosisFn,
  getRunDeliveryFn,
  decideRunDeliveryFn,
}) {
  const service = getRegistryInventoryFn ?? getRegistryInventory;
  const dispatcher = dispatchRunFn ?? dispatchRun;
  const statusService = getRunStatusFn ?? getRunStatus;
  const collectService = collectRunMessagesFn ?? collectRunMessages;
  const diagnosisService = getRunDiagnosisFn ?? getRunDiagnosis;
  const deliveryQueryService = getRunDeliveryFn ?? getRunDelivery;
  const deliveryDecideService = decideRunDeliveryFn ?? decideRunDelivery;

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

  mcp.registerTool(
    "run_collect",
    {
      description: RUN_COLLECT_DESCRIPTION,
      inputSchema: RUN_COLLECT_INPUT,
      outputSchema: RUN_COLLECT_OUTPUT,
      annotations: RUN_COLLECT_ANNOTATIONS,
    },
    async ({ runId }) => {
      // Entire service call + projection + redaction + output validation in ONE
      // try/catch. Any failure collapses to the fixed safe text — never leak
      // SDK output-validation error, raw exception, path, or secret.
      try {
        const raw = await collectService({ runId, runDir, limit: COLLECT_LIMIT });
        const payload = projectCollectResult(raw, runId);
        RUN_COLLECT_OUTPUT.parse(payload);
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: COLLECT_ERROR_TEXT }],
        };
      }
    },
  );

  mcp.registerTool(
    "run_diagnose",
    {
      description: RUN_DIAGNOSE_DESCRIPTION,
      inputSchema: RUN_DIAGNOSE_INPUT,
      outputSchema: RUN_DIAGNOSE_OUTPUT,
      annotations: RUN_DIAGNOSE_ANNOTATIONS,
    },
    async ({ runId }) => {
      // Entire service call + safe projection + output validation in ONE try/catch.
      try {
        const diag = await diagnosisService({ runId, runDir });
        // Safe projection: only event TYPES from evidence (no raw fact/error/path).
        // Exact-set filter: only the 8 types diagnoseFailure can legitimately produce
        // pass through. Everything else — paths, commands, control chars, and
        // pure-ASCII secret-shaped strings — maps to "unknown".
        const allTypes = (Array.isArray(diag.evidence) ? diag.evidence : [])
          .map((e) => {
            const t = e?.eventType;
            if (typeof t !== "string" || t.length === 0 || t.length > DIAGNOSE_MAX_TYPE_CHARS) return "unknown";
            return SAFE_DIAGNOSIS_EVENT_TYPES.has(t) ? t : "unknown";
          });
        const signalEventTypes = allTypes.slice(0, DIAGNOSE_MAX_SIGNALS);
        const payload = {
          runId: diag.runId,
          state: diag.state,
          terminal: diag.terminal,
          category: diag.category,
          signalEventTypes,
          signalCount: allTypes.length,
          signalsTruncated: allTypes.length > DIAGNOSE_MAX_SIGNALS,
        };
        RUN_DIAGNOSE_OUTPUT.parse(payload);
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: DIAGNOSE_ERROR_TEXT }],
        };
      }
    },
  );

  mcp.registerTool(
    "run_delivery",
    {
      description: RUN_DELIVERY_DESCRIPTION,
      inputSchema: RUN_DELIVERY_INPUT,
      outputSchema: RUN_DELIVERY_OUTPUT,
      annotations: RUN_DELIVERY_ANNOTATIONS,
    },
    async ({ runId }) => {
      try {
        const delivery = await deliveryQueryService({ runId, runDir });
        // Use the request runId — never echo the service result's runId,
        // which could differ and leak arbitrary content.
        if (delivery.runId !== runId) throw new Error("runId mismatch");
        const ref = delivery.deliveryRef ?? {};
        // Every scalar must pass a closed-set check. Malformed values throw
        // → caught by the outer try/catch → fixed safe error.
        const baseCommit = COMMIT_HASH_SCHEMA.parse(ref.baseCommit);
        const deliveryCommit = COMMIT_HASH_SCHEMA.parse(ref.deliveryCommit);
        if (!Array.isArray(ref.changedFiles)) throw new Error("changedFiles not array");
        const changedFileCount = ref.changedFiles.length;
        const rawVStatus = delivery.verification?.status ?? "pending";
        if (!SAFE_VERIFICATION_STATUSES.has(rawVStatus)) throw new Error("bad verificationStatus");
        const verificationStatus = rawVStatus;
        const rawFailureCode = delivery.verification?.failureCode;
        const verificationFailureCode = rawFailureCode
          ? (SAFE_FAILURE_CODES.has(rawFailureCode) ? rawFailureCode : "unknown")
          : null;
        const rawAcceptance = delivery.acceptance?.status ?? "pending";
        if (!SAFE_ACCEPTANCE_STATUSES.has(rawAcceptance)) throw new Error("bad acceptanceStatus");
        const acceptanceStatus = rawAcceptance;
        const rawDecisionType = delivery.acceptance?.decisionEvent?.type ?? null;
        const decisionType = rawDecisionType && SAFE_DECISION_TYPES.has(rawDecisionType) ? rawDecisionType : null;
        const terminalState = delivery.terminalState;
        if (!RUN_STATES.includes(terminalState)) throw new Error("bad terminalState");
        const payload = {
          runId,
          terminalState,
          baseCommit,
          deliveryCommit,
          changedFileCount,
          verificationStatus,
          verificationFailureCode,
          acceptanceStatus,
          decisionType,
        };
        RUN_DELIVERY_OUTPUT.parse(payload);
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: DELIVERY_QUERY_ERROR_TEXT }],
        };
      }
    },
  );

  mcp.registerTool(
    "run_delivery_decide",
    {
      description: RUN_DELIVERY_DECIDE_DESCRIPTION,
      inputSchema: RUN_DELIVERY_DECIDE_INPUT,
      outputSchema: RUN_DELIVERY_DECIDE_OUTPUT,
      annotations: RUN_DELIVERY_DECIDE_ANNOTATIONS,
    },
    async ({ runId, decision, reason }) => {
      try {
        const result = await deliveryDecideService({ runId, runDir, decision, reason });
        // Strict validation: every scalar must pass closed-set checks.
        // Malformed service result → throw → fixed safe error.
        if (typeof result.accepted !== "boolean") throw new Error("accepted not boolean");
        let payload;
        if (result.accepted) {
          const deliveryCommit = COMMIT_HASH_SCHEMA.parse(result.event?.deliveryCommit);
          payload = {
            runId,
            decisionAccepted: true,
            deliveryCommit,
            acceptanceStatus: decision,
            existingStatus: null,
          };
        } else {
          const existingStatus = result.existing?.status;
          if (existingStatus !== "accepted" && existingStatus !== "rejected") throw new Error("bad existing status");
          const deliveryCommit = COMMIT_HASH_SCHEMA.parse(result.existing?.deliveryCommit);
          payload = {
            runId,
            decisionAccepted: false,
            deliveryCommit,
            acceptanceStatus: existingStatus,
            existingStatus,
          };
        }
        RUN_DELIVERY_DECIDE_OUTPUT.parse(payload);
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: DELIVERY_DECIDE_ERROR_TEXT }],
        };
      }
    },
  );

  return mcp;
}

export { SERVER_NAME, SERVER_VERSION };
