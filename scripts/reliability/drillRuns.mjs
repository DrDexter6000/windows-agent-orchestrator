// scripts/reliability/drillRuns.mjs
//
// Plumbing shared by the two live session-reuse drills (dsh-acp/wao-reuse-drill.mjs and
// session-reuse-drill.mjs): where the live registry is, and how to read the run records
// their dispatches write. Run records are bucketed by project, so every lookup goes through
// src/projectBuckets.js.

import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { listTranscriptsDeep, resolveTranscriptPath } from "../../src/projectBuckets.js";

/** The main checkout's config/agents.json. It is gitignored, so a linked worktree has none;
 * the git common dir locates the main checkout from either. */
export function mainCheckoutRegistry(repoRoot) {
  const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoRoot, encoding: "utf8" }).trim();
  return join(dirname(commonDir), "config", "agents.json");
}

/** Path of a run's record under runDir (its project bucket, or the legacy flat file). */
export function transcriptPathOf(runDir, runId, repoRoot) {
  return resolveTranscriptPath(runDir, runId, { cwdHint: repoRoot });
}

/** Every run record under runDir, keyed by its path relative to runDir. The key keeps the
 * bucket, so a same-named record written into another bucket still counts as new. */
export function transcriptSnapshot(runDir, { io } = {}) {
  return new Set(listTranscriptsDeep(runDir, { io }).map((t) => relative(runDir, t.path)));
}

/** Keys present in `after` but not in `before`. */
export function addedSince(before, after) {
  return [...after].filter((key) => !before.has(key));
}
