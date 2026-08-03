// src/mcp/toolProfiles.js
//
// M12-10 Package A — Protocol-neutral STATIC tool surface.
//
// A tool profile is a closed, Host-neutral subset of WAO's MCP tools, selected
// ONLY at server construction (startup-fixed, frozen for the connection). It is
// a PRESENTATION SURFACE: it decides which tools a Host sees and can call. It is
// NOT a permission, NOT a router, and NOT a Host/runtime-name adapter — there is
// no branching on Claude/Codex/Kimi/OpenCode anywhere. Every tool's
// name/description/inputSchema/outputSchema/annotations are identical across
// profiles; a profile only selects the set.
//
// Why static (not dynamic tools_surface_set / list_changed / connect-time
// enable-disable): a frozen startup surface avoids protocol debt with Hosts that
// do not support dynamic tool changes, keeps the surface auditable, and never
// changes mid-conversation. Switching profiles requires restarting the Host.
//
// This module owns the ONLY closed-set definitions; server.js + stdio.js consume
// them so the parser, the server, and the tests cannot drift.

// The two legal profile values. Anything else is rejected (fail closed) — never
// silently coerced to a default at the value layer.
export const TOOL_PROFILES = Object.freeze(["full", "lead"]);

// full: every WAO tool. The default (zero behavior change for any existing Host
// configuration that passes no flag). Registration order, exactly as emitted by
// tools/list.
export const FULL_TOOLS = Object.freeze([
  "registry_list",
  "workspace_status",
  "workspace_select",
  "lead_preflight",
  "run_dispatch",
  "run_dispatch_contract_check",
  "run_continue",
  "run_status",
  "run_collect",
  "run_diagnose",
  "run_delivery",
  "run_delivery_decide",
  "run_stop",
  "runs_list",
  "run_wait",
  "run_await_result",
  "run_activity",
  "playbook_list",
  "playbook_get",
  "run_delivery_review",
  "run_delivery_review_bundle",
  "run_delivery_repackage",
  "run_delivery_reverify",
]);

// lead: the smaller everyday Lead surface. A closed, opt-in subset of full that
// drops tools already covered by others in the set:
//   workspace_select            — lead_preflight(workspaceRoot) selects the project
//   run_dispatch_contract_check — optional advisory precheck
//   run_wait                    — run_await_result covers default waiting + the
//                                  atomic state/liveness tools remain available
//   playbook_list / playbook_get — optional read-only catalog
// Every tool named by DRILLDOWN_TOOLS is present, so no availableDrilldowns
// entry can advertise a tool the profile hides.
export const LEAD_TOOLS = Object.freeze([
  "registry_list",
  "workspace_status",
  "lead_preflight",
  "run_dispatch",
  "run_continue",
  "run_status",
  "run_collect",
  "run_diagnose",
  "run_delivery",
  "run_delivery_decide",
  "run_stop",
  "runs_list",
  "run_await_result",
  "run_activity",
  "run_delivery_review",
  "run_delivery_review_bundle",
  "run_delivery_repackage",
  "run_delivery_reverify",
]);

// The tools full exposes but lead hides (full \ lead). Exposed for tests/docs.
export const LEAD_HIDDEN_TOOLS = Object.freeze(
  FULL_TOOLS.filter((name) => !LEAD_TOOLS.includes(name)),
);

const _PROFILE_SET = new Set(TOOL_PROFILES);

// Parity + uniqueness invariants — enforced at module load so a future edit that
// breaks the closed-set contract fails loudly here rather than silently at runtime.
//
// No module-shared mutable Set mirrors FULL_TOOLS/LEAD_TOOLS: the checks below
// build LOCAL Sets, and exposedToolSet() builds a fresh Set per call, so a caller
// mutating a returned Set can never poison a later exposedToolSet() call or a
// subsequently constructed server.
function assertUniqueProfileList(list, label) {
  const seen = new Set();
  for (const name of list) {
    if (seen.has(name)) {
      throw new Error(`toolProfiles: ${label} contains a duplicate tool: ${name}`);
    }
    seen.add(name);
  }
}
assertUniqueProfileList(FULL_TOOLS, "FULL_TOOLS");
assertUniqueProfileList(LEAD_TOOLS, "LEAD_TOOLS");
if (LEAD_HIDDEN_TOOLS.length !== FULL_TOOLS.length - LEAD_TOOLS.length) {
  throw new Error("toolProfiles: lead/full set arithmetic is inconsistent");
}
const _fullSeenAtLoad = new Set(FULL_TOOLS);
for (const name of LEAD_TOOLS) {
  if (!_fullSeenAtLoad.has(name)) {
    throw new Error(`toolProfiles: lead tool ${name} is not a full tool`);
  }
}

/**
 * Validate a raw profile value and resolve it to a concrete profile name.
 *
 * undefined resolves to "full" (the default — zero behavior change). "full" and
 * "lead" pass through. Any other value throws (fail closed — no silent fallback
 * to full for an unknown/garbage value, because that would hide a
 * misconfiguration from the operator).
 *
 * @param {string|undefined} profile
 * @returns {"full"|"lead"}
 * @throws {Error} on an unknown profile value
 */
export function resolveToolProfile(profile) {
  if (profile === undefined || profile === "full") return "full";
  if (profile === "lead") return "lead";
  throw new Error("tool-profile: unknown value");
}

/**
 * Whether a raw token is a legal --tool-profile VALUE (used by the stdio arg
 * parser's closed-set check). Note: this validates the VALUE only; the parser
 * separately enforces missing/empty/duplicate.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isKnownProfileValue(value) {
  return typeof value === "string" && _PROFILE_SET.has(value);
}

/**
 * A fresh, caller-isolated Set of the tool names a given profile exposes. Used by
 * the server's registration gate (a single unified registration helper consults
 * this Set to decide whether to attach each tool's handle).
 *
 * A NEW Set is built from the frozen profile array on every call, so callers may
 * freely mutate the returned Set (add/delete/clear) without affecting any later
 * exposedToolSet() call or any subsequently constructed server's tool surface.
 * There is no module-shared mutable Set to poison. (Object.freeze on a Set would
 * not prevent .add/.delete anyway, which is why isolation is by construction.)
 *
 * @param {string|undefined} profile
 * @returns {Set<string>}
 */
export function exposedToolSet(profile) {
  return new Set(
    resolveToolProfile(profile) === "lead" ? LEAD_TOOLS : FULL_TOOLS,
  );
}
