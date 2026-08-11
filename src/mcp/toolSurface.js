// src/mcp/toolSurface.js
//
// M12-10 progressive-disclosure correction — the FROZEN tool surface SSOT.
//
// WAO exposes EXACTLY 22 always-registered MCP tools. There is NO tool-profile
// model, NO startup flag, and NO restart-to-recover: every operational tool is
// independently callable for the lifetime of the connection. The built-in
// playbook catalog moved OFF the tool surface (it is presented as MCP resources
// — wao://playbooks); what used to be the two playbook tools
// (`playbook_list`, `playbook_get`) are no longer tools at all. M12-16 added
// `run_correct` (queued in-flight correction), taking the surface from 21 to 22.
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

// The 22 always-registered tools, in the exact registration order emitted by
// tools/list. Former 23-tool set MINUS playbook_list + playbook_get (= 21), PLUS
// run_correct (M12-16) = 22.
export const TOOLS = Object.freeze([
  "registry_list",
  "workspace_status",
  "workspace_select",
  "lead_preflight",
  "run_dispatch",
  "run_dispatch_contract_check",
  "run_continue",
  "run_correct",
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
  "run_delivery_review",
  "run_delivery_review_bundle",
  "run_delivery_repackage",
  "run_delivery_reverify",
]);

// Invariant enforced at module load so a future edit that breaks the closed-set
// contract (a duplicate, or an accidental re-add of the removed playbook tools)
// fails loudly here rather than silently at runtime.
{
  const seen = new Set();
  for (const name of TOOLS) {
    if (seen.has(name)) {
      throw new Error(`toolSurface: TOOLS contains a duplicate tool: ${name}`);
    }
    seen.add(name);
  }
  if (TOOLS.length !== 22) {
    throw new Error(`toolSurface: TOOLS must contain exactly 22 tools (got ${TOOLS.length})`);
  }
  if (TOOLS.includes("playbook_list") || TOOLS.includes("playbook_get")) {
    throw new Error("toolSurface: playbook tools must not be on the tool surface (catalog is resources)");
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
