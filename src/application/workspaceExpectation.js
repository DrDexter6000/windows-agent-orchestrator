// src/application/workspaceExpectation.js
//
// M12-6 (FR-03): workspace/head expectation preflight for run_dispatch.
//
// A Lead may optionally freeze dispatch to expectedGitHead, expectedDirty, and
// expectedWorkspaceRoot. This pure helper compares those expectations against a
// FRESHLY-proven workspace binding (the proveWorkspace result resolved once at
// the dispatch boundary) and returns either:
//   - { matched: true, proof } — every supplied expectation matched the binding;
//   - { matched: false, mismatch } — a closed-set label naming which category
//     mismatched ("gitHead" | "dirty" | "workspaceRoot").
//
// No absolute path, head hash, prompt, or arbitrary input is echoed — the only
// dynamic value a caller can surface is the closed-set mismatch label and the
// bounded proof (which itself exposes no absolute workspace path).
//
// SSOT reuse (no duplicated algorithms):
//   - canonicalizeWorkspacePath + pathsMatch (workspaceBinding.js) for canonical
//     platform-aware path comparison;
//   - EXPECTED_GIT_HEAD_RE (this module, F3) for the 7..64 lowercase-hex head
//     shape — short forms prefix-match, full forms stay exact (see the
//     constant's doc). isCanonicalCommitId (delivery.js) stays the full-form
//     authority for the DELIVERY path; its semantics are unchanged.
//
// Architectural contract:
//   - Does NOT import src/mcp/*, src/commands/*, MCP SDK, or zod.
//   - Pure decision logic: the only side effect is a read-only realpath on a
//     supplied expectedWorkspaceRoot (same canonicalization proveWorkspace uses).
//   - The caller owns binding resolution; this module never re-proves the bound
//     workspace.

import { isAbsolute } from "node:path";

import { canonicalizeWorkspacePath, pathsMatch } from "./workspaceBinding.js";

/**
 * Closed set of mismatch category labels — safe to surface (no values echoed).
 * Each corresponds to one optional expectation input.
 */
export const WORKSPACE_EXPECTATION_MISMATCH_FIELDS = Object.freeze([
  "gitHead",
  "dirty",
  "workspaceRoot",
]);

/**
 * F3 (2026-10-08): the accepted expectedGitHead shape — lowercase 7..64 hex.
 * Short forms (7..39 hex) are a DELIBERATELY WEAKENED assertion: they match the
 * proven head by PREFIX (provenHead.startsWith(expected)). Full forms (40/64
 * hex) are unchanged exact-equality assertions (a same-length prefix IS an
 * exact match). Exported as the SINGLE shape SSOT: src/mcp/server.js binds the
 * run_dispatch / run_dispatch_contract_check inputSchema regex to this same
 * source so the wire pattern and the matching semantics can never drift.
 * isCanonicalCommitId (delivery.js) is intentionally NOT reused here — it stays
 * the full-form-only authority for the DELIVERY path, whose semantics are
 * unchanged.
 */
export const EXPECTED_GIT_HEAD_RE = /^[0-9a-f]{7,64}$/;

/**
 * Maximum byte length of an expectedWorkspaceRoot string (bounded input).
 */
export const EXPECTED_WORKSPACE_ROOT_MAX = 1024;

/**
 * Compare optional workspace expectations against a freshly-proven binding.
 *
 * `binding` is the resolveWorkspaceBinding / proveWorkspace result:
 *   { bound:true, source, root, gitHead, dirty }.
 *
 * Each expectation is OPTIONAL: omitted (undefined/null, or empty string for the
 * root) expectations are not checked and surface as null match booleans in the
 * proof. A supplied expectation that does not conform (non-canonical head,
 * non-boolean dirty, non-absolute/oversized root, or a value that simply differs
 * from the current proof) is a mismatch and returns { matched:false } with the
 * closed-set category label — never the offending value.
 *
 * F3 (2026-10-08): expectedGitHead accepts SHORT hashes (7..39 lowercase hex).
 * A short form is a WEAKENED assertion — it matches by PREFIX
 * (provenHead.startsWith(expected)), so any head sharing that prefix passes.
 * A full 40/64-hex form remains an exact-equality assertion (a same-length
 * prefix is exactly the equality). Consumers that need the strong freeze
 * should pin the full head from workspace_status.
 *
 * @param {object} input
 * @param {{bound:boolean, source?:string, root?:string, gitHead?:string, dirty?:boolean}} input.binding
 * @param {string} [input.expectedGitHead] — lowercase 7..64 hex (short = prefix
 *   match, weakened; 40/64 = exact match)
 * @param {boolean} [input.expectedDirty]
 * @param {string} [input.expectedWorkspaceRoot] — absolute path (bounded)
 * @returns {{matched:true, proof: object} | {matched:false, mismatch: string}}
 */
export function checkWorkspaceExpectation({
  binding,
  expectedGitHead,
  expectedDirty,
  expectedWorkspaceRoot,
} = {}) {
  if (!binding || typeof binding !== "object") {
    // No proof to compare against — treat as a workspaceRoot mismatch (the
    // workspace could not be proven). Closed-set label only.
    return { matched: false, mismatch: "workspaceRoot" };
  }

  const suppliedGitHead = expectedGitHead !== undefined && expectedGitHead !== null;
  const suppliedDirty = expectedDirty !== undefined && expectedDirty !== null;
  const suppliedRoot = typeof expectedWorkspaceRoot === "string"
    && expectedWorkspaceRoot.length > 0;

  // expectedGitHead: must be lowercase 7..64 hex (EXPECTED_GIT_HEAD_RE) AND
  // match the proven head — a full 40/64-hex form is an exact string match (git
  // rev-parse yields lowercase hex); a SHORT form (7..39 hex) is a deliberately
  // WEAKENED prefix assertion (provenHead.startsWith(expected)), so any head
  // sharing the pinned prefix passes (F3, 2026-10-08).
  let expectedGitHeadMatch = null;
  if (suppliedGitHead) {
    const ok = typeof expectedGitHead === "string"
      && EXPECTED_GIT_HEAD_RE.test(expectedGitHead)
      && typeof binding.gitHead === "string"
      && binding.gitHead.startsWith(expectedGitHead);
    if (!ok) return { matched: false, mismatch: "gitHead" };
    expectedGitHeadMatch = true;
  }

  // expectedDirty: must be a boolean AND equal the proven dirty flag.
  let expectedDirtyMatch = null;
  if (suppliedDirty) {
    const ok = typeof expectedDirty === "boolean"
      && typeof binding.dirty === "boolean"
      && binding.dirty === expectedDirty;
    if (!ok) return { matched: false, mismatch: "dirty" };
    expectedDirtyMatch = true;
  }

  // expectedWorkspaceRoot: bounded absolute path, canonicalized the SAME way as
  // the proven root (realpath + forward slash), then compared via the platform-
  // aware pathsMatch SSOT (case-insensitive on win32). A non-existent / non-
  // canonicalizable expected root is a mismatch, never an echo of the input.
  let expectedWorkspaceRootMatch = null;
  if (suppliedRoot) {
    let ok = false;
    if (
      expectedWorkspaceRoot.length <= EXPECTED_WORKSPACE_ROOT_MAX
      && isAbsolute(expectedWorkspaceRoot)
      && typeof binding.root === "string"
    ) {
      let canonicalExpected = null;
      try {
        canonicalExpected = canonicalizeWorkspacePath(expectedWorkspaceRoot);
      } catch {
        canonicalExpected = null;
      }
      ok = canonicalExpected !== null && pathsMatch(canonicalExpected, binding.root);
    }
    if (!ok) return { matched: false, mismatch: "workspaceRoot" };
    expectedWorkspaceRootMatch = true;
  }

  // All supplied expectations matched. The proof exposes the binding's source,
  // canonical head, and dirty flag — NEVER the absolute workspace path — plus
  // nullable booleans proving which expectations were supplied and matched.
  return {
    matched: true,
    proof: {
      source: typeof binding.source === "string" ? binding.source : null,
      gitHead: typeof binding.gitHead === "string" ? binding.gitHead : null,
      dirty: typeof binding.dirty === "boolean" ? binding.dirty : null,
      expectedGitHeadMatch,
      expectedDirtyMatch,
      expectedWorkspaceRootMatch,
    },
  };
}
