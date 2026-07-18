// src/gitLocalExclude.js
//
// M11-1B: Runtime-neutral WAO worktree checkout hygiene.
//
// Before `git worktree add` creates <source>/.wao-worktrees/<name>, this helper
// ensures the repository-local .git/info/exclude contains exactly one effective
// root rule `/.wao-worktrees/`, so the persistent worktree directory does not
// pollute the source checkout's ordinary `git status --porcelain` output.
//
// Architectural contract:
//   - Runtime-neutral: no Codex/OpenCode/MCP host dependency.
//   - Does NOT import src/commands/*, src/mcp/*, src/application/*, or any host
//     adapter module. No MCP SDK or zod.
//   - Uses Node built-ins and structured `execFileSync` Git calls only.
//   - Never shell-builds a Git command string.
//   - Never edits the tracked `.gitignore`. Only the repository-local
//     `.git/info/exclude` (which is not tracked by Git).
//   - Never normalizes, trims, reorders, or rewrites unrelated exclude bytes.
//     Preserves BOM, CRLF/LF convention, and the existing byte order.
//
// Ownership contract:
//   - The WAO rule `/.wao-worktrees/` is a stable repository-local hygiene rule.
//     It is independent of any host-managed marker block (e.g. Codex activation).
//   - `ensureWaoWorktreeExclude` only ever adds/removes its own exact rule line;
//     it never touches marker blocks or unrelated lines.
//   - On `git worktree add` failure, the helper restores the pre-call exclude
//     bytes (or absence) so a failed attempt leaves no exclude mutation.

import { execFileSync } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync,
} from "node:fs";
import { join, resolve, isAbsolute, dirname } from "node:path";

/** The single exact root rule WAO owns in .git/info/exclude. */
export const WAO_WORKTREE_EXCLUDE_RULE = "/.wao-worktrees/";

/**
 * Resolve the repository's effective shared/common Git directory for a source
 * checkout path. Uses `--git-common-dir` so that, when the source itself is a
 * linked worktree, the exclude lands in the shared common dir (where
 * info/exclude is read for all linked worktrees). Relative output is resolved
 * against the source cwd (Git resolves `--git-common-dir` relative to cwd).
 *
 * @param {string} sourceCwd
 * @param {Function} [gitExec] - injectable (args, opts) => stdout string
 * @returns {string} absolute common git dir path
 */
export function resolveCommonGitDir(sourceCwd, gitExec) {
  const git = gitExec ?? defaultGitExec;
  let raw = git(["rev-parse", "--git-common-dir"], { cwd: sourceCwd, encoding: "utf8" });
  raw = String(raw).trim();
  // Git may return a relative path (e.g. ".git" or "../../.git"); resolve it.
  if (!isAbsolute(raw)) {
    raw = resolve(sourceCwd, raw);
  }
  return raw;
}

/**
 * Detect the newline convention of a string. Returns "\r\n" if any CRLF is
 * present, else "\n". (Git info/exclude on Windows is often LF; we follow the
 * file's existing convention when determinable.)
 */
function detectNewline(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Count how many lines in the content are exactly the WAO rule (no leading/
 * trailing whitespace, no comment prefix). A commented-out, differently scoped,
 * or substring variant does not count.
 */
export function countExactRule(content, rule = WAO_WORKTREE_EXCLUDE_RULE) {
  if (!content) return 0;
  return content.split(/\r?\n/).filter((l) => l === rule).length;
}

/**
 * Default git executor: structured execFileSync, no shell string.
 */
function defaultGitExec(args, opts) {
  return execFileSync("git", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...opts });
}

/**
 * Default exclude writer: atomic (temp + rename in same dir). Creates the info
 * dir if missing.
 */
function defaultWriteExclude(excludeFilePath, content) {
  const infoDir = dirname(excludeFilePath);
  if (!existsSync(infoDir)) mkdirSync(infoDir, { recursive: true });
  atomicWrite(excludeFilePath, content);
}

/**
 * Atomic write: temp file in the SAME directory as the target, then rename.
 * Temp file is removed on failure.
 */
function atomicWrite(filePath, content) {
  const infoDir = dirname(filePath);
  const tmp = join(infoDir, `.wao-tmp-${Date.now()}-${process.pid}`);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, filePath);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Ensure the repository-local exclude contains the WAO worktree rule.
 *
 * Modes:
 *   - prepare-only (default, `addWorktree` falsy): only ensure the exclude rule
 *     is present exactly once; do NOT run `git worktree add`. Returns
 *     `{ added, alreadyPresent }`.
 *   - `addWorktree: true`: prepare the exclude, then run
 *     `git worktree add <sourceCwd>/.wao-worktrees/<worktreeName> -b wao/<worktreeName>`.
 *     On worktree-add failure, restore the pre-call exclude bytes/absence and
 *     rethrow. Returns `{ added, alreadyPresent, worktree }`.
 *
 * @param {string} sourceCwd - the source checkout (primary or linked worktree)
 * @param {object} [opts]
 * @param {boolean} [opts.addWorktree=false]
 * @param {string} [opts.worktreeName] - required when addWorktree=true
 * @param {Function} [opts.gitExec] - injectable (args, opts) => stdout
 * @param {Function} [opts.writeExclude] - injectable (filePath, content) => void
 * @param {Function} [opts.readExclude] - injectable (filePath) => string|null
 * @returns {{added: boolean, alreadyPresent: boolean, worktree?: {path, branch}}}
 */
export function ensureWaoWorktreeExclude(sourceCwd, opts = {}) {
  const {
    addWorktree = false,
    worktreeName,
    gitExec,
    writeExclude = defaultWriteExclude,
    readExclude = defaultReadExclude,
  } = opts;

  const git = gitExec ?? defaultGitExec;
  const commonDir = resolveCommonGitDir(sourceCwd, git);
  const excludeFile = join(commonDir, "info", "exclude");

  // Snapshot pre-call exclude state for rollback.
  const preExists = existsSync(excludeFile);
  const preBytes = preExists ? readFileSync(excludeFile) : null;
  const preContent = preExists ? preBytes.toString("utf8") : "";

  // Determine whether the exact rule is already effectively present.
  const alreadyPresent = countExactRule(preContent) >= 1;
  let addedByThisCall = false;

  if (!alreadyPresent) {
    // Append the rule, preserving BOM/CRLF/LF/no-trailing-newline.
    const nl = detectNewline(preContent);
    let newContent;
    if (!preExists || preContent.length === 0) {
      // No existing content (or empty): just the rule + trailing newline.
      newContent = WAO_WORKTREE_EXCLUDE_RULE + nl;
    } else {
      // Preserve BOM if present at the start.
      const bom = preContent.startsWith("\uFEFF") ? "\uFEFF" : "";
      const body = bom ? preContent.slice(1) : preContent;
      // If the existing content has no trailing newline, add the necessary
      // separator before the rule. Otherwise just append.
      const needsSep = body.length > 0 && !body.endsWith("\n") && !body.endsWith("\r\n");
      const sep = needsSep ? nl : "";
      newContent = bom + body + sep + WAO_WORKTREE_EXCLUDE_RULE + nl;
    }
    try {
      writeExclude(excludeFile, newContent);
    } catch (err) {
      // Write failed before any worktree add. Restore pre-call state.
      restoreExclude(excludeFile, preExists, preBytes, writeExclude);
      throw new Error(`exclude write failure: ${err.message}`);
    }
    // Read-back verify: the exact rule must be present exactly once, and the
    // pre-existing bytes must be an exact prefix.
    const verifyContent = readExclude(excludeFile);
    if (verifyContent === null || countExactRule(verifyContent) !== 1) {
      restoreExclude(excludeFile, preExists, preBytes, writeExclude);
      throw new Error("exclude read-back verification failed: rule not present exactly once");
    }
    if (preExists && !verifyContent.startsWith(preContent)) {
      restoreExclude(excludeFile, preExists, preBytes, writeExclude);
      throw new Error("exclude read-back verification failed: pre-existing bytes not preserved");
    }
    addedByThisCall = true;
  }

  // Prepare-only mode: done.
  if (!addWorktree) {
    return { added: addedByThisCall, alreadyPresent };
  }

  if (!worktreeName) {
    // No worktree to create; just report the exclude state.
    return { added: addedByThisCall, alreadyPresent };
  }

  // Run `git worktree add`. On failure, restore pre-call exclude bytes/absence.
  const wtPath = join(resolve(sourceCwd), ".wao-worktrees", worktreeName);
  const branch = `wao/${worktreeName}`;
  try {
    git(["worktree", "add", wtPath, "-b", branch], { cwd: resolve(sourceCwd), encoding: "utf8" });
  } catch (err) {
    // Rollback exclude mutation made by THIS call only. If the rule pre-existed
    // (addedByThisCall=false), we leave it intact (it was the user's/ours before).
    if (addedByThisCall) {
      const restoreErr = tryRestore(excludeFile, preExists, preBytes, writeExclude);
      if (restoreErr) {
        throw new Error(
          `git worktree add failure: ${err.message} — AND exclude restore failed: ${restoreErr.message} (manual cleanup required)`,
        );
      }
    }
    throw new Error(`git worktree add failure: ${err.message}`);
  }

  return { added: addedByThisCall, alreadyPresent, worktree: { path: wtPath, branch } };
}

function defaultReadExclude(filePath) {
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf8");
}

/**
 * Restore exclude to a snapshot. Only ENOENT on delete is swallowed.
 * Throws on restore failure so callers can surface explicit cleanup failure.
 */
function restoreExclude(filePath, snapExists, snapBytes, writeExclude) {
  if (!snapExists) {
    try { unlinkSync(filePath); } catch (err) { if (err.code !== "ENOENT") throw err; }
    return;
  }
  writeExclude(filePath, snapBytes.toString("utf8"));
}

/**
 * Best-effort restore that captures (not throws) the error, for use in the
 * worktree-add rollback path where we must surface the original error.
 * Returns null on success or an Error on failure.
 */
function tryRestore(filePath, snapExists, snapBytes, writeExclude) {
  try {
    restoreExclude(filePath, snapExists, snapBytes, writeExclude);
    return null;
  } catch (err) {
    return err;
  }
}
