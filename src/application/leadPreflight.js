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

import { getRegistryInventory } from "./registryInventory.js";

/**
 * @typedef {Object} PreflightWorkspace
 * @property {boolean} bound
 * @property {("lead_session"|"server_config"|"mcp_root"|null)} source
 * @property {string|null} gitHead
 * @property {boolean|null} dirty
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
    };
    checkStatus.workspace = "observed";
    if (workspace.dirty) {
      observations.push("workspace has uncommitted changes (reported only; not a dispatch blocker)");
    }
  } else {
    workspace = { bound: false, source: null, gitHead: null, dirty: null };
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
  try {
    const invFn = getRegistryInventoryFn ?? getRegistryInventory;
    const agents = await invFn({ registryPath, runDir, userEnvReader });
    workers = agents.slice(0, WORKERS_CAP).map((a) => ({
      id: a.id,
      backend: a.backend,
      model: a.model,
      certification: a.certification,
      credentialAvailability: a.credentialAvailability,
    }));
    checkStatus.workers = "observed";
    if (agents.length > WORKERS_CAP) {
      warnings.push(`worker inventory truncated to ${WORKERS_CAP} (registry has ${agents.length}) — use registry_list for the full list`);
    }
    const conditional = workers.filter((w) => w.certification === "conditional");
    const missing = workers.filter((w) => w.credentialAvailability === "missing");
    if (conditional.length > 0) {
      observations.push(`${conditional.length} worker(s) have conditional certification (reported only)`);
    }
    if (missing.length > 0) {
      observations.push(`${missing.length} worker(s) are missing a required credential — see registry_list for env names`);
    }
  } catch {
    checkStatus.workers = "unknown";
    warnings.push("worker inventory could not be read — use registry_list to check directly");
  }

  // --- Section 3: active runs (independent; bounded; only when bound & readable) ---
  let activeRuns = null;
  let activeRunCount = null;
  let activeRunsTruncated = false;
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
    } catch {
      checkStatus.activeRuns = "unknown";
      warnings.push("active-run query could not be read — use runs_list to check directly");
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
    "registry_list — verify worker certification + credential availability",
    "runs_list — verify active runs independently",
  ];

  return {
    workspace,
    workspaceSelection,
    workers,
    activeRuns,
    activeRunCount,
    activeRunsTruncated,
    observations,
    warnings,
    manualChecks,
    checkStatus,
    complete,
  };
}
