// src/application/serverBuildFacts.js
//
// Server-build facts for lead_preflight observability: the WAO CODE checkout
// (the repo containing src/, derived from import.meta.url) self-reports its
// start time and git facts — deliberately NOT the bound workspace, which may
// be any unrelated project.
//
// At MODULE LOAD it records startedAt (ISO-8601 UTC) plus the code checkout's
// git HEAD and the src/ TREE hash (`git rev-parse HEAD:src`) at that moment.
// The exported query re-reads `git rev-parse HEAD`, `git rev-parse HEAD:src`
// and `git status --porcelain -- src/` at call time. The restart-drift
// comparison authority is the src/ tree hash + src/ dirty state: the tree hash
// changes ONLY when the committed content of src/ changes, so a commit that
// touches nothing under src/ (lane profile data, docs, tests) is not server
// code drift even though HEAD moves. HEAD is retained as an observability
// fact only (the consumer's observation line still names it). These are
// CONTENT facts: file mtime is never a criterion (checkout/stash refresh
// mtimes without changing content and would produce false drift reports).
//
// Architectural contract:
//   - Does NOT import src/mcp/*, src/commands/*, MCP SDK, or zod.
//   - Shells out ONLY to git via execFileSync with a structured argv array —
//     never a shell command string, never shell:true (workspaceBinding.js
//     precedent).
//   - EVERY git failure degrades to null / readable:false — never throws.
//   - Returns structured facts only; message assembly belongs to the consumer
//     (leadPreflight.js). No absolute path is returned in any field (paths
//     exist only as internal derivation inputs).
//
// Degradation truth table (what each failure returns):
//   - code root underivable, git binary missing, not a Git repo, no src/ tree
//     in HEAD, or a hash malformed/unreadable → { readable:false,
//     srcTreeAtStart:null (or the load-time value), srcTreeNow:null,
//     srcDirtyNow:null } — the consumer degrades to a start-time +
//     package-version observation, never a warning.
//   - src tree hash readable but `git status --porcelain -- src/` fails →
//     { readable:true, srcDirtyNow:null } — dirty UNKNOWN, never faked clean.
//   - All reads succeed → full comparison facts.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// <repoRoot>/src/application/serverBuildFacts.js → repo root is two levels up.
function deriveCodeRoot() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "..", "..");
  } catch {
    return null;
  }
}

function readPackageVersion() {
  try {
    const version = createRequire(import.meta.url)("../../package.json").version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

// Full commit hash only (40-hex or 64-hex — the same shape gate as
// workspaceBinding.proveWorkspace). Any other output (branch name, error
// text) is unreadable, not a HEAD.
function revParseHead(root, gitBin) {
  try {
    const out = execFileSync(gitBin, ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

// Tree hash of HEAD:src only (same 40/64-hex shape gate). This is the
// restart-drift comparison authority: it moves ONLY when the committed
// content of src/ moves, so commits that leave src/ untouched keep it stable
// while HEAD (the observability fact above) drifts.
function revParseHeadSrcTree(root, gitBin) {
  try {
    const out = execFileSync(gitBin, ["rev-parse", "HEAD:src"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

// src/ dirty status from porcelain output (empty = clean). null = unreadable.
function srcDirty(root, gitBin) {
  try {
    const out = execFileSync(gitBin, ["--no-optional-locks", "status", "--porcelain", "--", "src/"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return out.length > 0;
  } catch {
    return null;
  }
}

// Module-load capture. In the MCP server this module loads at startup, so
// these pin the build the server actually booted from. src/ dirtiness is
// captured at load too — without it, a start-dirty → still-dirty checkout
// would be indistinguishable from start-clean → stayed-clean, and the consumer
// could not tell "matches start" from "cannot confirm" (验收会审 astra/sol
// 反例：仅凭启动事实判"unchanged"超出证据).
const STARTED_AT = new Date().toISOString();
const CODE_ROOT = deriveCodeRoot();
const HEAD_AT_START = CODE_ROOT != null ? revParseHead(CODE_ROOT, "git") : null;
const SRC_TREE_AT_START = CODE_ROOT != null ? revParseHeadSrcTree(CODE_ROOT, "git") : null;
// Only meaningful when the load-time src tree was readable; otherwise null
// (the start-state dirty flag alone proves nothing about what was loaded).
const SRC_DIRTY_AT_START = CODE_ROOT != null && SRC_TREE_AT_START != null
  ? srcDirty(CODE_ROOT, "git")
  : null;
const PACKAGE_VERSION = readPackageVersion();

/**
 * Read the structured server-build facts (pure read; no writes, no caching
 * of call-time results).
 *
 * The call-time reads (HEAD, src tree, src/ dirty) are NOT atomic with each
 * other or with the load-time capture: a checkout/restore landing between
 * them can make the pair momentarily inconsistent. Consumers must treat these
 * as ADVISORY facts, never as proof of what modules are loaded.
 *
 * @param {{gitBin?: string, codeRoot?: string}} [opts] — injection points for
 *   tests (fake git binary / relocated code root).
 * @returns {{startedAt: string, headAtStart: string|null, headNow: string|null,
 *   srcTreeAtStart: string|null, srcTreeNow: string|null,
 *   srcDirtyAtStart: boolean|null, srcDirtyNow: boolean|null, readable: boolean,
 *   packageVersion: string|null}}
 *   readable is true ONLY when both the load-time and current src/ tree
 *   hashes were read — the comparison authority — a null on either side is
 *   "cannot confirm", never "matches". headAtStart/headNow are observability
 *   facts only; they stay null exactly when the HEAD reads fail.
 */
export function readServerBuildFacts(opts = {}) {
  const gitBin = opts.gitBin ?? "git";
  const root = typeof opts.codeRoot === "string" && opts.codeRoot.length > 0
    ? opts.codeRoot
    : CODE_ROOT;
  const headNow = root != null ? revParseHead(root, gitBin) : null;
  const srcTreeNow = root != null ? revParseHeadSrcTree(root, gitBin) : null;
  const srcDirtyNow = root != null && srcTreeNow != null ? srcDirty(root, gitBin) : null;
  return {
    startedAt: STARTED_AT,
    headAtStart: HEAD_AT_START,
    headNow,
    srcTreeAtStart: SRC_TREE_AT_START,
    srcTreeNow,
    srcDirtyAtStart: SRC_DIRTY_AT_START,
    srcDirtyNow,
    readable: SRC_TREE_AT_START != null && srcTreeNow != null,
    packageVersion: PACKAGE_VERSION,
  };
}
