// src/application/leadPreflight.js
//
// M11-8A: Lead single-call preflight aggregator (ADVISORY, not a gate).
//
// Aggregates the mechanical facts a Lead needs to start WAO orchestration —
// workspace binding, worker credential availability, and active runs — into ONE
// result so the Lead does not have to call workspace_select/status +
// registry_list + runs_list as separate round trips.
//
// This is an OPTIONAL ADVISORY aggregator, NOT an authorization gate:
//   - It never produces permit/token/approval/preflightPassed state.
//   - run_dispatch / workspace_select / registry_list / runs_list do NOT depend
//     on it having succeeded.
//   - Each check is settled INDEPENDENTLY: a failure in one (e.g. runs_list)
//     does NOT swallow the others (workspace/registry results are still returned).
//   - The output reports observations + warnings + manualChecks. It does NOT use
//     PASS/FAIL (which a Lead might misread as a global verdict). A check-level
//     status is `observed` | `warning` | `unknown`.
//   - Active runs, conditional workers, and a dirty workspace are reported as
//     FACTS only — never auto-interpreted as a dispatch prohibition. The Lead
//     decides.
//
// Architectural contract:
//   - Does NOT import src/mcp/*, src/commands/*, MCP SDK, or zod.
//   - Does NOT shell out or call the WAO CLI.
//   - Does NOT dispatch, stop, select a worker, write transcript/worktree/branch,
//     or persist anything.
//   - Composes existing application services (getRegistryInventory, listRuns).

import {
  getRegistryInventory,
  buildProviderReadiness,
  projectRegistryIssues,
  normalizeInventoryResult,
} from "./registryInventory.js";

/**
 * @typedef {Object} PreflightWorkspace
 * @property {boolean} bound
 * @property {("lead_session"|"server_config"|"mcp_root"|null)} source
 * @property {string|null} gitHead
 * @property {boolean|null} dirty
 * @property {("lead_session_git_proof_failed"|"server_config_git_proof_failed"|"no_workspace_authority"|null)} unboundReason
 *   Recovery fact (M12-19): closed-set reason the workspace is not bound.
 *   null when bound, or when the caller supplied no reason (never fabricated).
 */
/**
 * @typedef {Object} PreflightWorker
 * @property {string} id
 * @property {string} backend
 * @property {string} model
 * @property {string|null} certification
 * @property {("available"|"missing"|"not_required")} credentialAvailability
 */
/**
 * @typedef {Object} PreflightActiveRun
 * @property {string} runId
 * @property {string} agentId
 * @property {string} state
 * @property {boolean} terminal
 * @property {string|null} updatedAt
 */

// Cap on active runs returned in one preflight (bounded to keep the advisory
// result small even under runaway conditions). The TRUE count is reported
// separately as activeRunCount + activeRunsTruncated.
// Exported so the MCP output schema enforces the SAME bound (single SSOT).
export const ACTIVE_RUNS_CAP = 10;
// Cap on workers returned (defensive against a pathological registry).
export const WORKERS_CAP = 64;
// Closed set of unbound workspace reasons (M12-19 recovery truth). The smallest
// truthful set distinguishing: (a) a lead_session whose Git proof now fails,
// (b) an explicit server_config whose proof fails, (c) no usable workspace
// authority. mcp_root failures collapse into (c) via the existing fall-through.
// A closed set — the MCP layer derives its zod enums from this SSOT; dynamic
// error text and paths are NEVER returned. Exported so the MCP output schemas
// enforce the SAME set (single SSOT).
export const WORKSPACE_UNBOUND_REASONS = Object.freeze([
  "lead_session_git_proof_failed",
  "server_config_git_proof_failed",
  "no_workspace_authority",
]);

/**
 * Aggregate the mechanical preflight facts. Each section is settled
 * independently — a throw in one section is captured and reported as a warning,
 * never swallowing the others.
 *
 * Truthfulness contract (M11-8A closeout):
 *   - "unknown" (could not read) is NEVER faked as a known-empty/known-false
 *     value. An unreadable section returns null (or unknown), NOT [] / false.
 *     This keeps "could not confirm" structurally distinct from "confirmed none".
 *   - A workspace selection outcome is reported via a closed set:
 *       not_requested      — no workspaceRoot was provided.
 *       selected           — selection succeeded.
 *       failed_using_prior — selection failed but a prior binding is active.
 *       failed_unbound     — selection failed and no prior binding exists.
 *       failed_unknown     — selection failed and the resolver also threw.
 *     All failure states set checkStatus.workspace="warning" and complete=false.
 *   - complete is true ONLY when every requested check was reliably observed
 *     AND no workspace selection failure occurred.
 *
 * @param {object} input
 * @param {{bound:boolean, source?:string, root?:string, gitHead?:string, dirty?:boolean}|null} [input.workspaceBinding]
 *   The already-resolved workspace binding (from the MCP adapter's session state).
 *   null/undefined when the resolver itself threw (→ unknown, not faked unbound).
 * @param {boolean} [input.selectionRequested] — true when a workspaceRoot was
 *   provided (selection was attempted). Combined with the binding outcome this
 *   derives the workspaceSelection value.
 * @param {boolean} [input.selectionFailed] — true when the attempted selection
 *   threw (kept for backward compat; selectionRequested+selectionFailed together
 *   determine the outcome).
 * @param {string} input.registryPath
 * @param {string} input.runDir
 * @param {Function} [input.userEnvReader] — for credential readiness
 * @param {Function} [input.getRegistryInventoryFn] — injectable registry reader.
 *   The MCP handler MUST pass a function that replays its single snapshot
 *   outcome (success → returns the snapshot; failure → throws), so the
 *   aggregator never falls back to a second default read. If omitted (direct
 *   application-layer use / tests), the real getRegistryInventory is used — but
 *   the MCP path always passes an explicit resolver to guarantee one read.
 * @param {Function} [input.listRunsFn] — injectable; signature matches listRuns
 * @param {string[]} [input.knownAgentIds]
 * @returns {Promise<object>} advisory preflight result (see output shape below)
 */
export async function aggregateLeadPreflight({
  workspaceBinding,
  selectionRequested = false,
  selectionFailed = false,
  registryPath,
  runDir,
  userEnvReader,
  getRegistryInventoryFn,
  listRunsFn,
  knownAgentIds = [],
}) {
  const warnings = [];
  const observations = [];
  const checkStatus = {};
  let workspaceSelection = null;

  // --- Section 1: workspace (already resolved by the adapter) ---
  // Distinguish three cases:
  //   (a) resolver threw → workspaceBinding is null → UNKNOWN (not faked unbound)
  //   (b) bound → observed
  //   (c) not bound (resolver returned bound:false) → observed (known unbound)
  let workspace = null;
  if (workspaceBinding == null) {
    // Resolver threw — cannot confirm binding state.
    checkStatus.workspace = "unknown";
    warnings.push("workspace binding could not be resolved — use workspace_status to check directly");
  } else if (workspaceBinding.bound) {
    workspace = {
      bound: true,
      source: workspaceBinding.source ?? null,
      gitHead: workspaceBinding.gitHead ?? null,
      dirty: workspaceBinding.dirty ?? null,
      unboundReason: null,
    };
    checkStatus.workspace = "observed";
    if (workspace.dirty) {
      observations.push("workspace has uncommitted changes (reported only; not a dispatch blocker)");
    }
  } else {
    // M12-19: project the resolver's closed-set recovery fact. The application
    // boundary ENFORCES membership: a reason outside WORKSPACE_UNBOUND_REASONS
    // (dependency-injected or malformed) fails closed to null — the same
    // "unknown, never fabricated" semantics as an absent reason — and is never
    // returned verbatim and never rendered as dynamic text. The MCP wire schema
    // mirrors the same closed set as defense in depth.
    const unboundReason = WORKSPACE_UNBOUND_REASONS.includes(workspaceBinding.unboundReason)
      ? workspaceBinding.unboundReason
      : null;
    workspace = {
      bound: false,
      source: null,
      gitHead: null,
      dirty: null,
      unboundReason,
    };
    checkStatus.workspace = "observed";
    observations.push("workspace not bound — call workspace_select or lead_preflight with workspaceRoot");
  }
  // Derive workspaceSelection from the explicit closed set:
  //   not_requested      — no workspaceRoot was provided.
  //   selected           — selection was requested and succeeded (binding is the
  //                        newly-selected lead_session).
  //   failed_using_prior — selection was requested but failed, and a PRIOR
  //                        binding is still active (the reported workspace is the
  //                        prior one, NOT the requested one).
  //   failed_unbound     — selection was requested but failed, and there was NO
  //                        prior binding (nothing is bound).
  //   failed_unknown     — selection was requested but failed, and the resolver
  //                        also threw (cannot tell if a prior binding exists).
  if (!selectionRequested) {
    workspaceSelection = "not_requested";
  } else if (!selectionFailed) {
    workspaceSelection = "selected";
  } else {
    // Selection failed — distinguish by whether a prior binding exists.
    if (workspaceBinding == null) {
      workspaceSelection = "failed_unknown";
      checkStatus.workspace = "warning";
      warnings.push("workspace selection failed and binding state could not be confirmed — use workspace_status to check directly");
    } else if (workspaceBinding.bound) {
      workspaceSelection = "failed_using_prior";
      checkStatus.workspace = "warning";
      warnings.push("workspace selection failed — prior session selection is unchanged; the reported workspace is the PRIOR selection, not the requested one");
    } else {
      workspaceSelection = "failed_unbound";
      checkStatus.workspace = "warning";
      warnings.push("workspace selection failed and no prior workspace is bound — call workspace_select with a valid Git top-level to retry");
    }
  }

  // --- Section 2: worker credential availability (independent) ---
  // unknown → null (NOT []), so "could not read" is distinct from "zero workers".
  let workers = null;
  // M12-25: bounded safe per-entry issues from the partial inventory projection.
  // Empty when the inventory was observed-clean (or the resolver returned the
  // legacy bare-array shape). Non-empty → checkStatus.workers="warning" and
  // complete=false, but the VALID workers are still returned (one malformed entry
  // never hides the healthy ones). Stays [] when the section is unknown.
  let registryIssues = [];
  let registryIssuesTruncated = false;
  try {
    const invFn = getRegistryInventoryFn ?? getRegistryInventory;
    const invResult = await invFn({ registryPath, runDir, userEnvReader });
    // M12-25B: normalize through the SINGLE shared shape. Accepts the legacy
    // bare array AND the partial {agents, issues, issuesTruncated} projection;
    // THROWS on null/malformed → caught below → checkStatus.workers="unknown"
    // (never observed-empty: a read failure must stay distinct from zero agents).
    const norm = normalizeInventoryResult(invResult);
    const agents = norm.agents;
    // M12-25: the shared SSOT projector bounds + truncates + sanitizes the
    // issues (closed-set code, canonical agentId-or-null, no injected field).
    // An injected resolver cannot smuggle dynamic text, and >cap input with
    // issuesTruncated:false still reports truncation. Same logic as the partial
    // projector and the MCP registry_list handler — one projection, not three.
    const projected = projectRegistryIssues(norm.issues, norm.issuesTruncated);
    registryIssues = projected.issues;
    registryIssuesTruncated = projected.issuesTruncated;
    workers = agents.slice(0, WORKERS_CAP).map((a) => ({
      id: a.id,
      backend: a.backend,
      model: a.model,
      reasoningEffort: a.reasoningEffort ?? null,
      certification: a.certification,
      credentialAvailability: a.credentialAvailability,
      // M12-6 FR-02: strict provider readiness truth. The inventory service
      // provides it; the fallback keeps this aggregator truthful even when a
      // caller supplies a service-shaped inventory without the field (only
      // unknown/not_checked values can be derived here — no probe exists).
      providerReadiness: a.providerReadiness ?? buildProviderReadiness(a.credentialAvailability),
    }));
    checkStatus.workers = "observed";
    if (agents.length > WORKERS_CAP) {
      warnings.push(`worker inventory truncated to ${WORKERS_CAP} (registry has ${agents.length}) — use registry_list for the full list`);
    }
    // M12-25: partial inventory — valid workers are returned, but the workers
    // section is a WARNING (→ complete=false) when any entry was omitted. This
    // keeps "registry had a bad entry" distinct from an observed-clean list and
    // distinct from an unreadable registry (which is unknown, never faked []).
    if (registryIssues.length > 0) {
      checkStatus.workers = "warning";
      warnings.push(
        `worker inventory has ${registryIssues.length} malformed/unsupported entr${registryIssues.length === 1 ? "y" : "ies"} omitted; ` +
        `${workers.length} valid worker(s) returned — use registry_list for the bounded per-entry issue list`,
      );
    }
    const conditional = workers.filter((w) => w.certification === "conditional");
    const missing = workers.filter((w) => w.credentialAvailability === "missing");
    if (conditional.length > 0) {
      observations.push(`${conditional.length} worker(s) have conditional certification (reported only)`);
    }
    if (missing.length > 0) {
      observations.push(`${missing.length} worker(s) are missing a required credential — see registry_list for env names`);
    }
    observations.push(
      "live provider authentication, entitlement, quota, and rate limits were not checked; " +
      "complete means observation completeness, not provider execution readiness",
    );
  } catch {
    checkStatus.workers = "unknown";
    warnings.push("worker inventory could not be read — use registry_list to check directly");
  }

  // --- Section 3: active runs (independent; bounded; only when bound & readable) ---
  let activeRuns = null;
  let activeRunCount = null;
  let activeRunsTruncated = false;
  // M12-15: unresolvedRunCount comes from the SAME listRuns scan/snapshot that
  // produced activeRuns — the Lead must NOT rescan. null = unknown (unreadable),
  // NEVER faked as 0, so "could not confirm" stays distinct from "confirmed none".
  let unresolvedRunCount = null;
  if (workspace && workspace.bound && typeof listRunsFn === "function") {
    try {
      const result = await listRunsFn({
        runDir,
        activeOnly: true,
        latest: ACTIVE_RUNS_CAP,
        authorizedWorkspaceRoot: workspaceBinding.root,
        knownAgentIds,
      });
      const all = result.runs ?? [];
      activeRunCount = typeof result.matchedCount === "number" ? result.matchedCount : all.length;
      unresolvedRunCount = typeof result.unresolvedCount === "number" ? result.unresolvedCount : null;
      // Keep activeRuns entries minimal — no per-run activityStatus. The closed-set
      // activity projection lives on runs_list summaries; here we only report the
      // proven-active count + the bounded run list.
      activeRuns = all.slice(0, ACTIVE_RUNS_CAP).map((r) => ({
        runId: r.runId,
        agentId: r.agentId,
        state: r.state,
        terminal: r.terminal,
        updatedAt: r.updatedAt ?? null,
      }));
      activeRunsTruncated = activeRunCount > activeRuns.length;
      checkStatus.activeRuns = "observed";
      if (activeRunCount > 0) {
        observations.push(`${activeRunCount} active run(s) in this workspace (reported only; not auto-stopped)`);
      }
      // Advisory: a non-terminal run without a fresh owner heartbeat was omitted
      // from activeRuns. It does NOT prove failure or stop — it may still be a
      // legitimately long-running/sleeping run. Surfaced so an empty activeRuns
      // list is never mistaken for a clean workspace.
      if (typeof unresolvedRunCount === "number" && unresolvedRunCount > 0) {
        observations.push(
          `${unresolvedRunCount} unresolved non-terminal run(s) were omitted from activeRuns — ` +
          "they lack a fresh owner heartbeat and do not prove failure or stop; use runs_list to inspect them",
        );
      }
    } catch {
      checkStatus.activeRuns = "unknown";
      warnings.push("active-run query could not be read — use runs_list to check directly");
      // unresolvedRunCount stays null (unknown, NOT faked 0).
    }
  } else if (workspace && !workspace.bound) {
    checkStatus.activeRuns = "unknown";
    observations.push("active-run recovery check skipped (workspace not bound)");
  } else {
    // workspace unknown (resolver threw) → cannot determine; leave activeRuns null.
    checkStatus.activeRuns = "unknown";
  }

  // complete = every section reliably observed AND no selection failure.
  // A selection failure or any "unknown"/"warning" makes it false.
  const sections = ["workspace", "workers", "activeRuns"];
  const allObserved = sections.every((s) => checkStatus[s] === "observed");
  // complete is false if any section is unknown/warning OR a selection failed.
  const complete = allObserved && !(selectionRequested && selectionFailed);

  const manualChecks = [
    "workspace_status — verify binding independently",
    "registry_list — verify configured workers, recorded certification, and credential presence (not live provider quota)",
    "runs_list — verify active runs independently",
  ];

  return {
    workspace,
    workspaceSelection,
    workers,
    // M12-25: bounded safe per-entry issues from the partial inventory (empty when
    // observed-clean or unknown). Non-empty ⇒ checkStatus.workers="warning".
    registryIssues,
    registryIssuesTruncated,
    activeRuns,
    activeRunCount,
    activeRunsTruncated,
    unresolvedRunCount,
    observations,
    warnings,
    manualChecks,
    checkStatus,
    complete,
  };
}
