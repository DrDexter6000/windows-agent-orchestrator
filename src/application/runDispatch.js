// src/application/runDispatch.js
//
// M9-2A: Shared application service for background run dispatch.
//
// This module owns the dispatch side of `run --background` / `spawn` (no --wait):
// generating/validating a runId, creating the transcript, writing the initial
// durable facts (background_submitted → pending), and spawning the detached
// background runner. It is the single place where CLI and MCP both dispatch a
// supervised background run.
//
// Architectural contract:
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Depends on transcript.js (JsonlTranscript), delivery.js (isValidRunId),
//     and child_process.spawn (injectable for testing).
//   - prompt stays a bounded task prompt — never injects Lead orchestration context.

import { spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { JsonlTranscript } from "../transcript.js";
import { isValidRunId, prepareDeliveryRequest } from "../delivery.js";

// Default path to the detached runner. Resolved relative to this module so the
// service stays independent of the caller's cwd (CLI vs MCP vs test).
const DEFAULT_RUNNER_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "backgroundRunner.js",
);

const DEFAULT_WAIT_TIMEOUT = 120000;
const DEFAULT_POLL_INTERVAL = 1000;

/**
 * Generate a runId in the same format RunManager uses.
 * @returns {string}
 */
function generateRunId() {
  return `run_${new Date().toISOString().replace(/[-:.TZ]/g, "")}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Dispatch a supervised background run.
 *
 * Writes the initial transcript durable facts and spawns the detached runner
 * that owns the worker handle lifecycle. Returns a structured result; the
 * caller (CLI/MCP) is responsible for any console output formatting.
 *
 * @param {object} input
 * @param {string} input.agentId — required worker id
 * @param {string} input.prompt — required bounded task prompt
 * @param {string} input.registryPath — path to agents.json
 * @param {string} input.runDir — path to runs/ directory
 * @param {string} [input.runId] — optional custom runId (validated)
 * @param {string} [input.cwd] — optional worker cwd
 * @param {number} [input.waitTimeout]
 * @param {number} [input.pollInterval]
 * @param {string} [input.scorecardRules] — raw JSON string
 * @param {string} [input.scorecardMode]
 * @param {boolean} [input.requireCertified=false] — propagated to runner + RunManager
 * @param {Function} [input.spawnFn] — injectable spawn (tests)
 * @param {string} [input.runnerPath] — override detached runner path
 * @param {string} [input.execPath] — override node executable (defaults to process.execPath)
 * @returns {Promise<{accepted:boolean, runId:string, state:string, transcriptPath?:string, terminalState?:string}>}
 */
export async function dispatchRun({
  agentId,
  prompt,
  registryPath,
  runDir,
  runId,
  cwd,
  waitTimeout,
  pollInterval,
  scorecardRules,
  scorecardMode,
  requireCertified = false,
  spawnFn,
  runnerPath,
  execPath,
  delivery,
}) {
  if (!agentId || typeof agentId !== "string") {
    throw new Error("dispatchRun: agentId is required");
  }
  if (!prompt || typeof prompt !== "string") {
    throw new Error("dispatchRun: prompt is required");
  }
  if (!registryPath || typeof registryPath !== "string") {
    throw new Error("dispatchRun: registryPath is required");
  }
  if (!runDir || typeof runDir !== "string") {
    throw new Error("dispatchRun: runDir is required");
  }

  // Validate runId BEFORE any file write or fork. Custom runIds reach transcript
  // paths and runner argv; reject early to prevent path traversal / injection.
  // Reuses the isValidRunId SSOT (same as runManager.js / delivery.js).
  const finalRunId = runId ?? generateRunId();
  if (!isValidRunId(finalRunId)) {
    throw new Error(
      `Invalid runId (contains path separators, shell metacharacters, or traversal): ${JSON.stringify(finalRunId)}`,
    );
  }

  // M9-7A: validate delivery BEFORE any transcript write or fork.
  // prepareDeliveryRequest is the SSOT — it enforces mode/path/verification rules.
  const validatedDelivery = delivery ? prepareDeliveryRequest(delivery) : null;

  const resolvedRunDir = resolve(runDir);
  const resolvedRegistry = resolve(registryPath);
  const transcriptPath = join(resolvedRunDir, `${finalRunId}.jsonl`);
  const transcript = new JsonlTranscript(transcriptPath, { runId: finalRunId, agentId });

  // Initial durable facts, in order: background_submitted, then pending.
  await transcript.append("run.background_submitted", {
    background: true,
    cwd,
    scorecardConfigured: Boolean(scorecardRules),
  });

  // pending via transitionState — first-terminal-wins arbitration. If the
  // runId was reused against an already-terminal transcript, this is rejected
  // and we must NOT fork the detached runner.
  const pendingResult = await transcript.transitionState(null, "pending", "background_spawned");
  if (!pendingResult.accepted) {
    return {
      accepted: false,
      runId: finalRunId,
      state: pendingResult.state,
      transcriptPath,
      terminalState: pendingResult.state,
    };
  }

  // Accepted — spawn the detached runner with the full argv it needs.
  const _spawn = spawnFn ?? spawn;
  const _execPath = execPath ?? process.execPath;
  const _runnerPath = runnerPath ?? DEFAULT_RUNNER_PATH;
  const effectiveWaitTimeout = waitTimeout ?? DEFAULT_WAIT_TIMEOUT;
  const effectivePollInterval = pollInterval ?? DEFAULT_POLL_INTERVAL;

  const runnerArgs = [
    _runnerPath,
    agentId,
    "--prompt", prompt,
    "--run-dir", resolvedRunDir,
    "--run-id", finalRunId,
    "--registry", resolvedRegistry,
    "--wait-timeout", String(effectiveWaitTimeout),
    "--poll-interval", String(effectivePollInterval),
  ];
  if (cwd) runnerArgs.push("--cwd", cwd);
  if (scorecardRules) runnerArgs.push("--scorecard-rules", scorecardRules);
  if (scorecardMode) runnerArgs.push("--scorecard-mode", scorecardMode);
  if (requireCertified) runnerArgs.push("--require-certified");
  // M9-7A: delivery runs force persistent worktree isolation and carry the
  // validated delivery request as structured JSON argv (no shell string).
  if (validatedDelivery) {
    runnerArgs.push("--isolate");
    runnerArgs.push("--delivery-json", JSON.stringify(validatedDelivery));
  }

  // detached: runner survives CLI/MCP process exit; stdio ignore (runner writes
  // transcript); unref so the parent does not wait for it.
  _spawn(_execPath, runnerArgs, { detached: true, stdio: "ignore" }).unref();

  return {
    accepted: true,
    runId: finalRunId,
    state: "pending",
    transcriptPath,
  };
}
