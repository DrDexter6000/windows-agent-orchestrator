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
import { resolveWaitTimeout, validateBoundedWaitTimeout } from "./timeoutPolicy.js";
import { readRegistry } from "../registry.js";
import { assessWorkerReadiness, createEnvResolver } from "./credentialReadiness.js";
import { inheritedEnvNames } from "../envPolicy.js";

// M11-7: thrown when a worker's REQUIRED credential is missing at dispatch time.
// Carries the missing env NAMES (never values). Callers (MCP) collapse to a
// fixed actionable text.
export class CredentialMissingError extends Error {
  constructor(missingNames) {
    super(`credential missing: ${missingNames.join(", ")}`);
    this.name = "CredentialMissingError";
    this.missingCredentialEnvNames = missingNames;
  }
}

// Default path to the detached runner. Resolved relative to this module so the
// service stays independent of the caller's cwd (CLI vs MCP vs test).
const DEFAULT_RUNNER_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "backgroundRunner.js",
);

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
 * @param {number} [input.waitTimeout] — explicit override (range-validated 1000..600000)
 * @param {number} [input.globalWaitTimeout] — server-owned global config.waitTimeout (trusted)
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
  globalWaitTimeout,
  pollInterval,
  scorecardRules,
  scorecardMode,
  requireCertified = false,
  spawnFn,
  runnerPath,
  execPath,
  delivery,
  resolvedCredentials,
  userEnvReader,
  // M11-7: skip the credential preflight (e.g. when the caller already did it
  // and is passing resolvedCredentials). Default false = always check.
  skipCredentialCheck = false,
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

  // M10-pre closeout: validate explicit waitTimeout BEFORE any transcript write or fork.
  // The explicit value comes from CLI --wait-timeout or a trusted internal caller.
  // MCP run_dispatch schema does NOT accept waitTimeout — the model cannot set it.
  // It must pass full production range [1000, 600000]. An invalid value must fail-closed
  // with zero transcript, zero fork — no orphaned pending transcript.
  // validateBoundedWaitTimeout throws on out-of-range/NaN/non-integer.
  if (waitTimeout !== undefined && waitTimeout !== null) {
    validateBoundedWaitTimeout(waitTimeout);
  }
  // M10-pre closeout-2: validate server-owned globalWaitTimeout too.
  // A corrupted config/default.json or broken internal caller could pass an out-of-range
  // value. Same boundary gate, same fail-closed semantics: zero transcript, zero fork.
  // MCP run_dispatch schema does NOT accept globalWaitTimeout — the model cannot set it.
  if (globalWaitTimeout !== undefined && globalWaitTimeout !== null) {
    validateBoundedWaitTimeout(globalWaitTimeout);
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
  // The validated result has internal shape {verification:{commands,unavailableReason}},
  // but RunManager.start expects the public shape {verificationCommands|verificationUnavailableReason}.
  // Convert to public shape here — do NOT let runner or RunManager re-implement conversion.
  const validatedDelivery = delivery ? prepareDeliveryRequest(delivery) : null;
  const publicDelivery = validatedDelivery ? {
    mode: validatedDelivery.mode,
    allowedPaths: validatedDelivery.allowedPaths,
    ...(validatedDelivery.verification.commands.length > 0
      ? { verificationCommands: validatedDelivery.verification.commands }
      : { verificationUnavailableReason: validatedDelivery.verification.unavailableReason }),
  } : null;

  const resolvedRunDir = resolve(runDir);
  const resolvedRegistry = resolve(registryPath);

  // M11-7: credential preflight BEFORE any transcript write or fork. Reads the
  // registry to resolve the agent, then assesses credential availability via the
  // shared SSOT. A missing REQUIRED credential throws CredentialMissingError
  // (zero transcript, zero fork). The resolved VALUES are threaded into the
  // runner env so the worker child inherits them (and the redactor scrubs them).
  // Dispatch resolves ALL inherited env names (required + optional) so optional
  // Kimi/Codex config is bridged too — unlike registry_list, which only reads
  // required names. One operation-scoped resolver per dispatch (no cross-op cache).
  let finalCredentials = resolvedCredentials ?? {};
  if (!skipCredentialCheck) {
    const registry = await readRegistry(resolvedRegistry);
    const agent = registry.getAgent(agentId);
    const resolver = createEnvResolver(userEnvReader);
    const readiness = await assessWorkerReadiness({
      agent, resolver, names: inheritedEnvNames(agent),
    });
    if (readiness.credentialAvailability === "missing") {
      throw new CredentialMissingError(readiness.missingCredentialEnvNames);
    }
    finalCredentials = Object.fromEntries(
      Object.entries({ ...finalCredentials, ...readiness.resolvedEnv })
        .filter(([, v]) => typeof v === "string" && v.length > 0),
    );
  }

  // Construct runner argv BEFORE any transcript write. All static preflight
  // (argv length guard, delivery validation) must happen before a single
  // durable fact is written — otherwise a rejected dispatch leaves an
  // orphaned pending transcript with no owner.
  const _spawn = spawnFn ?? spawn;
  const _execPath = execPath ?? process.execPath;
  const _runnerPath = runnerPath ?? DEFAULT_RUNNER_PATH;
  // M10-pre: only pass --wait-timeout to runner when explicitly set.
  // RunManager resolves timeout from agent > config > default internally.
  const effectivePollInterval = pollInterval ?? DEFAULT_POLL_INTERVAL;

  const runnerArgs = [
    _runnerPath,
    agentId,
    "--prompt", prompt,
    "--run-dir", resolvedRunDir,
    "--run-id", finalRunId,
    "--registry", resolvedRegistry,
    "--poll-interval", String(effectivePollInterval),
  ];
  // M10-pre: only pass --wait-timeout when explicitly provided (CLI override).
  // RunManager resolves from agent.waitTimeout > config.waitTimeout > default.
  if (waitTimeout !== undefined && waitTimeout !== null) {
    runnerArgs.push("--wait-timeout", String(waitTimeout));
  }
  // M10-pre closeout: thread server-owned global config.waitTimeout to the runner.
  // This is NOT --wait-timeout (which would become "explicit" in precedence).
  // The runner sets RunManager config.waitTimeout from this value, so the full
  // precedence explicit > agent > global > default is preserved in the detached process.
  if (globalWaitTimeout !== undefined && globalWaitTimeout !== null) {
    runnerArgs.push("--global-wait-timeout", String(globalWaitTimeout));
  }
  if (cwd) runnerArgs.push("--cwd", cwd);
  if (scorecardRules) runnerArgs.push("--scorecard-rules", scorecardRules);
  if (scorecardMode) runnerArgs.push("--scorecard-mode", scorecardMode);
  if (requireCertified) runnerArgs.push("--require-certified");
  if (publicDelivery) {
    runnerArgs.push("--isolate");
    runnerArgs.push("--delivery-json", JSON.stringify(publicDelivery));
  }

  // Conservative total argv length guard — BEFORE transcript write.
  const ARGV_MAX_TOTAL = 24000;
  const totalArgvLen = runnerArgs.reduce((sum, a) => sum + String(a).length + 1, 0);
  if (totalArgvLen > ARGV_MAX_TOTAL) {
    throw new Error(`runner argv too long (${totalArgvLen} > ${ARGV_MAX_TOTAL}); reduce prompt/delivery/scorecard size`);
  }

  // All preflight passed — now write transcript durable facts.
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
      agentId,
      state: pendingResult.state,
      transcriptPath,
      terminalState: pendingResult.state,
    };
  }

  // detached: runner survives CLI/MCP process exit; stdio ignore (runner writes
  // transcript); unref so the parent does not wait for it.
  // M11-7: thread resolved credential VALUES into the runner's env (NOT argv —
  // values must never appear in argv). The runner's ProcessBackend then inherits
  // them via process.env (buildChildEnv) and redacts them (createSecretRedactor).
  const runnerEnv = { ...process.env, ...finalCredentials };
  _spawn(_execPath, runnerArgs, { detached: true, stdio: "ignore", env: runnerEnv }).unref();

  return {
    accepted: true,
    runId: finalRunId,
    // M11-8B: echo the canonical agentId so the Lead gets a unified identity
    // from dispatch onward. This is the registry id the caller supplied —
    // the same value the transcript envelope will carry — never worker text.
    agentId,
    state: "pending",
    transcriptPath,
  };
}
