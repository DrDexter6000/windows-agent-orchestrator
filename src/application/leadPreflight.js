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

/**
 * Aggregate the mechanical preflight facts. Each section is settled
 * independently — a throw in one section is captured and reported as a warning,
 * never swallowing the others.
 *
 * @param {object} input
 * @param {{bound:boolean, source?:string, root?:string, gitHead?:string, dirty?:boolean}} [input.workspaceBinding]
 *   The already-resolved workspace binding (from the MCP adapter's session state).
 *   Omitted/null → unbound.
 * @param {string} input.registryPath
 * @param {string} input.runDir
 * @param {Function} [input.userEnvReader] — for credential readiness
 * @param {Function} [input.getRegistryInventoryFn] — injectable for testing
 * @param {Function} [input.listRunsFn] — injectable; signature matches listRuns
 * @param {string[]} [input.knownAgentIds]
 * @returns {Promise<object>} advisory preflight result (see output shape below)
 */
export async function aggregateLeadPreflight({
  workspaceBinding,
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

  // --- Section 1: workspace (already resolved by the adapter) ---
  const workspace = workspaceBinding && workspaceBinding.bound
    ? {
        bound: true,
        source: workspaceBinding.source ?? null,
        gitHead: workspaceBinding.gitHead ?? null,
        dirty: workspaceBinding.dirty ?? null,
      }
    : { bound: false, source: null, gitHead: null, dirty: null };
  checkStatus.workspace = "observed";
  if (!workspace.bound) {
    observations.push("workspace not bound — call workspace_select or lead_preflight with workspaceRoot");
  } else if (workspace.dirty) {
    observations.push("workspace has uncommitted changes (reported only; not a dispatch blocker)");
  }

  // --- Section 2: worker credential availability (independent) ---
  let workers = [];
  try {
    const invFn = getRegistryInventoryFn ?? getRegistryInventory;
    const agents = await invFn({ registryPath, runDir, userEnvReader });
    // Project only safe fields (drop cwd, missingCredentialEnvNames values are
    // names-only; the aggregator output keeps credentialAvailability only).
    workers = agents.map((a) => ({
      id: a.id,
      backend: a.backend,
      model: a.model,
      certification: a.certification,
      credentialAvailability: a.credentialAvailability,
    }));
    checkStatus.workers = "observed";
    // Advisory observations about conditional / credential-missing workers.
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

  // --- Section 3: active runs (independent; only when workspace is bound) ---
  let activeRuns = [];
  if (workspace.bound && typeof listRunsFn === "function") {
    try {
      const result = await listRunsFn({
        runDir,
        activeOnly: true,
        authorizedWorkspaceRoot: workspaceBinding.root,
        knownAgentIds,
      });
      activeRuns = (result.runs ?? []).map((r) => ({
        runId: r.runId,
        agentId: r.agentId,
        state: r.state,
        terminal: r.terminal,
        updatedAt: r.updatedAt ?? null,
      }));
      checkStatus.activeRuns = "observed";
      if (activeRuns.length > 0) {
        observations.push(`${activeRuns.length} active run(s) in this workspace (reported only; not auto-stopped)`);
      }
    } catch {
      checkStatus.activeRuns = "unknown";
      warnings.push("active-run query could not be read — use runs_list to check directly");
    }
  } else if (!workspace.bound) {
    checkStatus.activeRuns = "unknown";
    observations.push("active-run recovery check skipped (workspace not bound)");
  }

  // complete = every section settled to "observed" (mechanical: were the facts
  // readable?). It does NOT mean "safe to dispatch" — that is the Lead's call.
  const sections = ["workspace", "workers", "activeRuns"];
  const complete = sections.every((s) => checkStatus[s] === "observed");

  // manualChecks point at the original tools so the Lead can re-verify any
  // section independently (and may reach a different conclusion from direct
  // evidence — that is allowed and recorded as friction).
  const manualChecks = [
    "workspace_status — verify binding independently",
    "registry_list — verify worker certification + credential availability",
    "runs_list — verify active runs independently",
  ];

  return {
    workspace,
    workers,
    activeRuns,
    observations,
    warnings,
    manualChecks,
    checkStatus,
    complete,
  };
}
