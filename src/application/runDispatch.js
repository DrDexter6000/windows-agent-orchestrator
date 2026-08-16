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

import { JsonlTranscript, STATE_CHANGE_REASON } from "../transcript.js";
import { isValidRunId, prepareDeliveryRequest } from "../delivery.js";
import { resolveWaitTimeout, validateBoundedWaitTimeout } from "./timeoutPolicy.js";
import { readRegistry } from "../registry.js";
import { assessWorkerReadiness, createEnvResolver } from "./credentialReadiness.js";
import { inheritedEnvNames } from "../envPolicy.js";
import { resolveReuseTurn, resolveLineageFirstTurn } from "./sessionReuse.js";

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

// M11-11C: thrown when a reusable expert already has an active (non-terminal)
// run for the same Lead session + workspace + agent. Carries the active runId
// for server-side routing only — it is NEVER surfaced via MCP. Callers (MCP)
// collapse this to a fixed actionable busy text (contract 6).
export class ReuseBusyError extends Error {
  constructor(activeRunId) {
    super("sessionReuse: prior run still active");
    this.name = "ReuseBusyError";
    this.activeRunId = activeRunId;
  }
}

// Round 4 Bundle B: thrown when a dispatch declares BOTH readOnly and a
// delivery block. A read-only run is advisory observation, never a delivery —
// the combination is contradictory and refused before ANY side effect (zero
// transcript, zero fork). Mirrors the CredentialMissingError form: a typed
// class the MCP adapter recognizes by error.name and collapses to a fixed
// actionable text carrying the closed-set reason code. No dynamic payload.
export class ReadOnlyDeliveryConflictError extends Error {
  constructor() {
    super(
      "dispatchRun: readOnly is mutually exclusive with a delivery block "
      + "(read_only_delivery_conflict) — a read-only run is advisory observation, never a delivery",
    );
    this.name = "ReadOnlyDeliveryConflictError";
    this.reasonCode = "read_only_delivery_conflict";
  }
}

// TD-110 (D2 A3): thrown when a sessionReuse:"lead_workspace" agent is
// dispatched WITHOUT a bound workspace (cwd). The message is the pre-existing
// closed-set text (byte-identical to the old bare Error) — the typed class is
// a pure addition so the CLI background dispatch catch can recognize it by
// error.name and append ONE static guidance line naming the --cwd flag.
// No payload is carried: never echoes cwd paths, Lead ids, or provider data.
export class SessionReuseWorkspaceRequiredError extends Error {
  constructor() {
    super("dispatchRun: bound workspace (cwd) is required for a sessionReuse agent");
    this.name = "SessionReuseWorkspaceRequiredError";
  }
}

// Round 6 Bundle R6-A (F-5-12): thrown when a CLI delivery dispatch carries a
// delivery block but NO explicit --cwd. dispatchRun builds the background
// delivery ownership record (run.background_submitted.cwd, appended below from
// this exact input) — the authority `runs delivery review` verifies against.
// Without it the run is only rejected at REVIEW time ("malformed ownership:
// run.background_submitted.cwd is missing or empty"), after the worker has
// already burned the whole execution chain. The CLI boundary
// (commands/run.js) refuses with this typed error at the argv layer, BEFORE
// any side effect (zero transcript, zero fork, zero worktree). Same closed-set
// form as the typed errors above: stable error.name for scriptable capture,
// fixed actionable text, no dynamic payload. The service-level contract is
// deliberately unchanged — the MCP boundary always threads the host-proven
// workspace root as cwd (this error is unreachable there), and direct service
// callers keep the pinned delivery-without-cwd behavior (runDispatch.test.js
// M9-7A / M12-6-FR05 / M12-25-ROUT-5).
export class DeliveryCwdRequiredError extends Error {
  constructor() {
    super(
      "delivery run requires an explicit --cwd <target project> "
      + "— the delivery ownership record (run.background_submitted.cwd) is built from it; "
      + "refusing before any side effect (re-run with --cwd <target project>)",
    );
    this.name = "DeliveryCwdRequiredError";
    this.reasonCode = "delivery_cwd_required";
  }
}

// Default path to the detached runner. Resolved relative to this module so the
// service stays independent of the caller's cwd (CLI vs MCP vs test).
const DEFAULT_RUNNER_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "backgroundRunner.js",
);

const DEFAULT_POLL_INTERVAL = 1000;

// M12-25 (Outcome 2): the providerSessionRouting closed set — the ROUTING
// REQUEST truth dispatchRun exposes, derived ONLY from the internal routing
// turn it already selected. It states what routing dispatch REQUESTED, never
// whether the provider accepted/resumed:
//   not_used              — no provider-session routing was requested (ordinary
//                           non-reuse dispatch, or a rejected dispatch).
//   first_turn_requested  — dispatch requested the FIRST turn of a provider
//                           session (a reusable expert's first turn, or a
//                           continuable delivery lineage root).
//   resume_requested      — dispatch requested RESUMING an existing provider
//                           session (a reusable expert's follow-up turn).
// The routing MODE (lead_workspace / run_lineage), the opaque session uuid,
// Lead ids, workspace paths, argv, and provider payload are NEVER exposed. The
// MCP wire schema derives its enum from this frozen array (single SSOT).
export const PROVIDER_SESSION_ROUTING = Object.freeze([
  "not_used",
  "first_turn_requested",
  "resume_requested",
]);

/**
 * Derive the bounded providerSessionRouting value from the internal routing
 * turn dispatchRun selected. Only the TURN matters (first → first_turn_requested,
 * resume → resume_requested); the mode and opaque uuid are intentionally dropped.
 * @param {{mode:string, opaqueUuid:string, turn:string}|null} routing
 * @returns {"not_used"|"first_turn_requested"|"resume_requested"}
 */
function deriveProviderSessionRouting(routing) {
  if (!routing) return "not_used";
  if (routing.turn === "first") return "first_turn_requested";
  if (routing.turn === "resume") return "resume_requested";
  return "not_used";
}

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
 * @param {string} [input.cwd] — optional worker cwd. REQUIRED in practice for a
 *   delivery dispatch: it is the sole source of the background ownership record
 *   (run.background_submitted.cwd). The CLI boundary refuses a delivery dispatch
 *   without it up front (typed DeliveryCwdRequiredError, commands/run.js argv
 *   gate); the MCP boundary always supplies the host-proven workspace root.
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
  // M11-11C: server-owned Lead session identity. Required when the agent is
  // configured for sessionReuse; ignored otherwise. Generated/injected by the
  // MCP server (stable per server/Lead session) — never supplied by the model,
  // never returned via MCP. CLI callers pass a one-shot id (always first turn).
  leadSession,
  // M12-6 (P1-A): server-proven frozen HEAD (the MCP boundary's binding.gitHead),
  // threaded to the detached runner as --frozen-git-head so RunManager.start can
  // revalidate the source HEAD against it and pin the worktree base. Never model-
  // supplied — expectedGitHead is the model-owned counterpart and is consumed at
  // the MCP boundary. Absent for CLI callers (argv unchanged).
  frozenGitHead,
  // Server-owned backend capability resolver. Required only for a continuable
  // root so unsupported runtimes fail before the lineage slot/transcript/fork.
  backendFor,
  // M12-7: Lead opt-in marking this delivery as the root of a continuable
  // lineage. When true (delivery-only), dispatch establishes the lineage
  // provider session with turn:first so a future Lead-authorized run_continue
  // can resume the SAME provider-native conversation in the retained worktree.
  // Default false = byte-compatible ordinary delivery dispatch.
  continuable = false,
  // M12-16: Lead opt-in marking this run as correctable — a follow-up user turn
  // may be queued to the RUNNING provider process via run_correct (the
  // transcript-backed durable queue the detached runner drains over stdin).
  // Requires the selected backend to declare supportsInFlightCorrection (gated
  // below, before any transcript write/fork). Default false = byte-compatible
  // ordinary dispatch (argv/stdin/events unchanged).
  correctable = false,
  // M11-7: skip the credential preflight (e.g. when the caller already did it
  // and is passing resolvedCredentials). Default false = always check.
  skipCredentialCheck = false,
  // Round 4 Bundle B: Lead read-only DECLARATION (advisory observation, never
  // a gate). readOnly is mutually exclusive with a delivery block (typed
  // ReadOnlyDeliveryConflictError before any side effect) and compatible with
  // correctable / sessionReuse (a correction is a Lead-ordered instruction —
  // declaration and observation coexist). Threaded to the detached runner as
  // --isolate --read-only so RunManager.start forces isolation and writes the
  // exactly-once run.read_only_declared fact. Default false = byte-compatible.
  readOnly = false,
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

  // Round 4 Bundle B: readOnly × delivery is a contradictory declaration —
  // refuse it FIRST, before any validation side effect, transcript write, or
  // fork (zero orphaned pending transcript). readOnly × continuable needs no
  // new code: continuable is delivery-only, so the existing gate below
  // ("continuable is delivery-only") naturally refuses that combination.
  if (readOnly && delivery) {
    throw new ReadOnlyDeliveryConflictError();
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
    // M12-6 (FR-05): forward Lead-authored setup commands when declared.
    ...(validatedDelivery.verification.setupCommands?.length > 0
      ? { verificationSetupCommands: validatedDelivery.verification.setupCommands }
      : {}),
    // M12-13: forward the per-command execution timeout when declared. Absent →
    // the --delivery-json payload stays byte-identical (zero drift on the wire).
    ...(validatedDelivery.verification.verificationTimeoutMs !== undefined
      ? { verificationTimeoutMs: validatedDelivery.verification.verificationTimeoutMs }
      : {}),
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
  //
  // M11-11C: the agent is ALWAYS resolved here (not only when credential
  // preflight runs) so the sessionReuse policy can be read for reuse resolution
  // below. The credential check reuses the same agent instance.
  let finalCredentials = resolvedCredentials ?? {};
  const registry = await readRegistry(resolvedRegistry);
  const agent = registry.getAgent(agentId);
  if (!skipCredentialCheck) {
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

  // M11-11C: expert session reuse — strictly NON-DELIVERY (delivery dispatch
  // always starts a fresh backend conversation). Resolve the reuse turn
  // (first/resume/busy) BEFORE the transcript write or fork. On busy, throw
  // ReuseBusyError (zero transcript, zero fork — contract 6). The opaque
  // routing {mode, opaqueUuid, turn} is threaded to the detached runner via
  // argv; the opaque uuid is the ONLY identifier handed to the provider
  // (--session-id/--resume). Raw Lead id / workspace / agentId never enter MCP
  // output or the bounded audit event. The routing slot is claimed under a
  // per-key file lock so two concurrent dispatches for the same identity
  // cannot both fork (the second observes the first as busy).
  let sessionReuseRouting = null;
  const reuseEligible = agent.sessionReuse === "lead_workspace" && !publicDelivery;
  if (reuseEligible) {
    if (typeof leadSession !== "string" || leadSession.length === 0) {
      throw new Error("dispatchRun: leadSession is required for a sessionReuse agent (server-owned Lead session identity)");
    }
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new SessionReuseWorkspaceRequiredError();
    }
    const reuseDecision = await resolveReuseTurn({
      runDir: resolvedRunDir,
      runId: finalRunId,
      leadSession,
      workspace: cwd,
      agentId,
    });
    if (reuseDecision.kind === "busy") {
      throw new ReuseBusyError(reuseDecision.activeRunId);
    }
    sessionReuseRouting = reuseDecision.routing;
  }

  // M12-16: correctable opt-in gate. Only a backend that declares
  // supportsInFlightCorrection (a provider-neutral capability boolean) may
  // accept a correctable run — read the declared capability, never branch on
  // the runtime name. This runs BEFORE the continuable lineage-slot claim (and
  // before any transcript write / fork) so a dispatch opting into BOTH
  // continuable + correctable on a backend that supports session reuse but NOT
  // in-flight correction fails closed WITHOUT first claiming — and so leaking —
  // a busy lineage slot. Non-opt-in dispatch skips this entirely (byte-compatible).
  if (correctable) {
    const correctionBackend = typeof backendFor === "function" ? backendFor(agent) : null;
    if (!correctionBackend || correctionBackend.supportsInFlightCorrection !== true) {
      throw new Error("dispatchRun: correctable requires a backend that declares supportsInFlightCorrection");
    }
  }

  // M12-7: continuable delivery = lineage ROOT. Establish the lineage provider
  // session (turn:first) under the lineage key (Lead session + workspace +
  // agent + rootRunId). A future Lead-authorized run_continue resumes the SAME
  // provider conversation (turn:resume) against this rootRunId, reusing the
  // retained worktree. Mutually exclusive with lead_workspace above (that gate
  // is non-delivery-only). Fail-closed: continuable is delivery-only, and a busy
  // lineage slot refuses before any transcript write or fork.
  let lineageRootRunId = null;
  if (continuable) {
    if (!publicDelivery) {
      throw new Error("dispatchRun: continuable is delivery-only (a continuation lineage is rooted in a delivery run)");
    }
    if (typeof leadSession !== "string" || leadSession.length === 0) {
      throw new Error("dispatchRun: leadSession is required for a continuable delivery (server-owned Lead session identity)");
    }
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new Error("dispatchRun: bound workspace (cwd) is required for a continuable delivery");
    }
    const continuationBackend = typeof backendFor === "function" ? backendFor(agent) : null;
    if (!continuationBackend || continuationBackend.supportsSessionReuse !== true) {
      throw new Error("dispatchRun: continuable delivery requires a backend that supports provider session reuse");
    }
    const firstTurn = await resolveLineageFirstTurn({
      runDir: resolvedRunDir,
      runId: finalRunId,
      leadSession,
      workspace: cwd,
      agentId,
      rootRunId: finalRunId,
    });
    if (firstTurn.kind === "busy") {
      throw new ReuseBusyError(firstTurn.activeRunId);
    }
    sessionReuseRouting = firstTurn.routing;
    lineageRootRunId = finalRunId;
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
  // Round 4 Bundle B: a read-only declaration forces isolation on the runner
  // path too (this closes the gap above — the --isolate push used to be
  // delivery-only, so a non-delivery readOnly dispatch would have reached the
  // runner unisolated) and threads the declaration as --read-only so
  // RunManager.start persists the exactly-once declaration fact. Mutually
  // exclusive with delivery (refused above) — the two blocks never coexist.
  if (readOnly) {
    runnerArgs.push("--isolate");
    runnerArgs.push("--read-only");
  }
  // M12-6 (P1-A): thread the server-proven frozen HEAD to the detached runner so
  // RunManager.start can revalidate/pin the base. Server-side argv only (never
  // returned via MCP); absent for CLI callers.
  if (frozenGitHead) {
    runnerArgs.push("--frozen-git-head", frozenGitHead);
  }
  // M11-11C: thread the resolved reuse routing to the detached runner. The
  // payload is opaque ({mode, opaqueUuid, turn}) — it carries no raw Lead id,
  // workspace path, or agentId. Detached-runner argv is server-side (never
  // returned via MCP); the prompt already travels the same channel.
  if (sessionReuseRouting) {
    runnerArgs.push("--session-reuse-json", JSON.stringify(sessionReuseRouting));
  }
  // M12-16: thread correctable to the detached runner so RunManager.start spawns
  // the child with a piped stdin + the stream-json input format and drains the
  // correction queue. Server-side argv only (never returned via MCP).
  if (correctable) {
    runnerArgs.push("--correctable");
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
    // Durable before the detached runner starts so startup failures still
    // preserve whether the Lead requested a delivery.
    deliveryRequested: Boolean(publicDelivery),
    // M12-16: durable correctable marker. The MCP correction service reads this
    // stable fact to gate run_correct (a correction may only queue against a
    // run dispatched correctable). Written before the runner forks.
    ...(correctable ? { correctable: true } : {}),
  });

  // pending via transitionState — first-terminal-wins arbitration. If the
  // runId was reused against an already-terminal transcript, this is rejected
  // and we must NOT fork the detached runner.
  const pendingResult = await transcript.transitionState(null, "pending", STATE_CHANGE_REASON.background_spawned);
  if (!pendingResult.accepted) {
    return {
      accepted: false,
      runId: finalRunId,
      agentId,
      state: pendingResult.state,
      transcriptPath,
      terminalState: pendingResult.state,
      // M12-25: a rejected dispatch never requested a provider session.
      providerSessionRouting: "not_used",
    };
  }

  // M11-11C: persist a BOUNDED routing audit fact for reusable runs (contract
  // 8). Carries only {mode, turn} — never the opaque uuid, Lead id, workspace,
  // prompt, argv, or provider payload. Non-reusable runs write nothing here.
  if (sessionReuseRouting) {
    await transcript.append("run.session_reuse", {
      mode: sessionReuseRouting.mode,
      turn: sessionReuseRouting.turn,
      // M12-7: persist the lineage root for run_lineage routing so a future
      // run_continue can resolve the lineage key from any parent transcript.
      // Absent for lead_workspace (zero drift). Carries only the WAO runId —
      // never the opaque uuid, Lead id, or workspace.
      ...(sessionReuseRouting.mode === "run_lineage" && lineageRootRunId
        ? { rootRunId: lineageRootRunId }
        : {}),
    });
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
    // M12-25: ROUTING REQUEST truth, derived only from the routing turn selected
    // above. Describes what dispatch requested, never provider success. Exposes
    // only the closed-set value — never the mode, opaque uuid, Lead id, or workspace.
    providerSessionRouting: deriveProviderSessionRouting(sessionReuseRouting),
  };
}
