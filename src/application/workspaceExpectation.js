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
//   - isCanonicalCommitId (delivery.js) for the 40/64 lowercase-hex head format.
//
// Architectural contract:
//   - Does NOT import src/mcp/*, src/commands/*, MCP SDK, or zod.
//   - Pure decision logic: the only side effect is a read-only realpath on a
//     supplied expectedWorkspaceRoot (same canonicalization proveWorkspace uses).
//   - The caller owns binding resolution; this module never re-proves the bound
//     workspace.

import { isAbsolute } from "node:path";

import { canonicalizeWorkspacePath, pathsMatch } from "./workspaceBinding.js";
import { isCanonicalCommitId } from "../delivery.js";

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
 * @param {object} input
 * @param {{bound:boolean, source?:string, root?:string, gitHead?:string, dirty?:boolean}} input.binding
 * @param {string} [input.expectedGitHead] — canonical lowercase 40/64 hex
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

  // expectedGitHead: must be canonical 40/64 lowercase hex AND exactly equal the
  // proven head. git rev-parse yields lowercase hex, so a canonical literal that
  // resolves to the same object is an exact string match.
  let expectedGitHeadMatch = null;
  if (suppliedGitHead) {
    const ok = isCanonicalCommitId(expectedGitHead)
      && typeof binding.gitHead === "string"
      && binding.gitHead === expectedGitHead;
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
