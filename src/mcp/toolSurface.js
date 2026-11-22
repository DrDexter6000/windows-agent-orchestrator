// src/mcp/toolSurface.js
//
// M12-10 progressive-disclosure correction — the FROZEN tool surface SSOT.
//
// WAO exposes EXACTLY 16 always-registered MCP tools. There is NO tool-profile
// model, NO startup flag, and NO restart-to-recover: every operational tool is
// independently callable for the lifetime of the connection. The built-in
// playbook catalog moved OFF the tool surface (it is presented as MCP resources
// — wao://playbooks); what used to be the two playbook tools
// (`playbook_list`, `playbook_get`) are no longer tools at all. M12-16 added
// `run_correct` (queued in-flight correction); M13 added `run_consult` (Agent
// Union consult primitive). v0.10.0 (batch 119, Owner-approved true-removal
// shrink) deleted the session-selection, binding-status, and MCP long-poll
// wait tools — per-call `expectedWorkspaceRoot` replaces the shared session
// selection, and repeated `run_await_result` replaces the long-poll — taking
// the surface from 23 to 20. Batch 134 (decision 0129, Owner-approved) folded
// four more read-only tools into their survivors: `registry_list` and
// `runs_list` into `lead_preflight` (workers carry the full agent entry;
// optional detail/recentRuns), `run_dispatch_contract_check` into
// `run_dispatch` (in-place precheck; advisories ride the receipt), and
// `run_delivery_review_bundle` into `run_delivery` + `run_delivery_review`.
//
// This module is the single frozen definition of that surface (names + the exact
// registration order emitted by tools/list). server.js registers these tools
// unconditionally at construction; the tool-surface tests assert the live
// tools/list order is byte-equal to TOOLS, so server.js and this SSOT cannot
// drift.
//
// Why a frozen, startup-fixed surface (not dynamic tools_surface_set /
// list_changed / connect-time enable-disable, and NOT a Host/runtime-name
// profile): a frozen surface avoids protocol debt with Hosts that do not support
// dynamic tool changes, keeps the surface auditable, and never changes
// mid-conversation. Progressive disclosure is RESPONSE-DRIVEN via
// availableDrilldowns on tool results, not via hiding tools.

// The 16 always-registered tools, in the exact registration order emitted by
// tools/list. Batch 134 (decision 0129): the former 20-tool set MINUS the four
// read-only tools folded into their survivors = 16 (see the header note).
export const TOOLS = Object.freeze([
  "lead_preflight",
  "run_dispatch",
  "run_consult",
  "run_continue",
  "run_correct",
  "run_status",
  "run_collect",
  "run_diagnose",
  "run_delivery",
  "run_delivery_decide",
  "run_stop",
  "run_await_result",
  "run_activity",
  "run_delivery_review",
  "run_delivery_repackage",
  "run_delivery_reverify",
]);

// Invariant enforced at module load so a future edit that breaks the closed-set
// contract (a duplicate, or an accidental re-add of a removed tool) fails loudly
// here rather than silently at runtime.
{
  const seen = new Set();
  for (const name of TOOLS) {
    if (seen.has(name)) {
      throw new Error(`toolSurface: TOOLS contains a duplicate tool: ${name}`);
    }
    seen.add(name);
  }
  if (TOOLS.length !== 16) {
    throw new Error(`toolSurface: TOOLS must contain exactly 16 tools (got ${TOOLS.length})`);
  }
  if (TOOLS.includes("playbook_list") || TOOLS.includes("playbook_get")) {
    throw new Error("toolSurface: playbook tools must not be on the tool surface (catalog is resources)");
  }
  // 决定 0129（第 134 批）：四个只读工具的能力并进留下的工具后删除——防误加回。
  for (const folded of ["registry_list", "runs_list", "run_dispatch_contract_check", "run_delivery_review_bundle"]) {
    if (TOOLS.includes(folded)) {
      throw new Error(`toolSurface: ${folded} was folded into its survivor (decision 0129) and must not return`);
    }
  }
}

/**
 * A fresh, caller-isolated Set of the tool names on the frozen surface. Built
 * from the frozen TOOLS array on every call, so callers may freely mutate the
 * returned Set without affecting any later call.
 *
 * @returns {Set<string>}
 */
export function toolSurfaceSet() {
  return new Set(TOOLS);
}
