// src/gitLocalExclude.js
//
// M11-1B: Runtime-neutral WAO worktree checkout hygiene (transactional).
//
// Before `git worktree add` creates <source>/.wao-worktrees/<name>, this helper
// ensures the repository-local .git/info/exclude contains exactly one effective
// root rule `/.wao-worktrees/`, so the persistent worktree directory does not
// pollute the source checkout's ordinary `git status --porcelain` output.
//
// Transaction contract (M11-1B closeout):
//   The whole operation (read exclude → prepare/repair rule → optional
//   `git worktree add` → verify → rollback on failure) runs UNDER a single
//   cross-process mutex held on a lock file beside the exclude file. This makes
//   interleaved concurrent success/failure safe: a caller whose own prepare
//   added the rule, but whose `git worktree add` fails after ANOTHER caller has
//   created a real worktree, restores the LOCKED-TIME snapshot — which still
//   contains the rule, because the other caller's success did not remove it.
//
//   Rollback always restores the locked-time exclude bytes/absence, never the
//   pre-this-call bytes. So a failed caller cannot delete a rule that a
//   concurrently-succeeded caller's worktree depends on.
//
// Architectural contract:
//   - Runtime-neutral: no Codex/OpenCode/MCP host dependency.
//   - Does NOT import src/commands/*, src/mcp/*, src/application/*, or any host
//     adapter module. No MCP SDK or zod.
//   - Uses Node built-ins and structured `execFileSync` Git calls only.
//   - Never shell-builds a Git command string.
//   - Never edits the tracked `.gitignore`. Only the repository-local
//     `.git/info/exclude` (which is not tracked by Git).
//
// Worktree authority:
//   `ensureWaoWorktreeExclude` does NOT validate the worktree name for path/
//   ref safety — that stays in src/isolation.js (the worktree authority). The
//   helper only owns the exclude hygiene rule. `prepareAndRunWorktreeAdd` is the
//   callback form: isolation.js acquires the lock, then calls git worktree add
//   itself, inside the locked section.

import { execFileSync } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync,
} from "node:fs";
import { open, unlink, readFile } from "node:fs/promises";
import { join, resolve, isAbsolute, dirname } from "node:path";

/** The single exact root rule WAO owns in .git/info/exclude. */
export const WAO_WORKTREE_EXCLUDE_RULE = "/.wao-worktrees/";

const LOCK_TIMEOUT_MS = 10000;
const LOCK_STALE_MS = 60000;

/**
 * Resolve the repository's effective shared/common Git directory for a source
 * checkout path. Uses `--git-common-dir` so linked-worktree sources land the
 * rule in the shared common dir.
 *
 * @param {string} sourceCwd
 * @param {Function} [gitExec] - injectable (args, opts) => stdout string
 * @returns {string} absolute common git dir path
 */
export function resolveCommonGitDir(sourceCwd, gitExec) {
  const git = gitExec ?? defaultGitExec;
  let raw = git(["rev-parse", "--git-common-dir"], { cwd: sourceCwd, encoding: "utf8" });
  raw = String(raw).trim();
  if (!isAbsolute(raw)) raw = resolve(sourceCwd, raw);
  return raw;
}

/**
 * Detect newline convention. CRLF if present, else LF.
 */
function detectNewline(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Count lines that are exactly the rule (no whitespace/comment). A rule on the
 * first line preceded by a UTF-8 BOM still counts (the BOM is an encoding
 * marker, not part of the rule text).
 */
export function countExactRule(content, rule = WAO_WORKTREE_EXCLUDE_RULE) {
  if (!content) return 0;
  // Strip a leading BOM so a rule at the very first position (BOM + rule) counts.
  const stripped = content.startsWith("\uFEFF") ? content.slice(1) : content;
  return stripped.split(/\r?\n/).filter((l) => l === rule).length;
}

function defaultGitExec(args, opts) {
  return execFileSync("git", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...opts });
}

/**
 * Atomic write: temp in same dir + rename. Temp removed on failure.
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

function defaultWriteExclude(excludeFilePath, content) {
  const infoDir = dirname(excludeFilePath);
  if (!existsSync(infoDir)) mkdirSync(infoDir, { recursive: true });
  atomicWrite(excludeFilePath, content);
}

function defaultReadExclude(filePath) {
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf8");
}

// ── Cross-process lock (mirrors src/transcript.js style) ─────────────────────

async function acquireExcludeLock(lockPath) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }), "utf8");
      return async () => {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await removeStaleLock(lockPath);
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for WAO exclude lock: ${lockPath}`);
      }
      await sleep(5);
    }
  }
}

async function removeStaleLock(lockPath) {
  try {
    const raw = await readFile(lockPath, "utf8");
    const data = JSON.parse(raw);
    if (Date.now() - Number(data.ts) > LOCK_STALE_MS) {
      await unlink(lockPath).catch(() => {});
    }
  } catch {
    // unreadable → let the timeout path decide
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Rule preparation (pure byte operations) ──────────────────────────────────

/**
 * Compute the new exclude content that converges the WAO rule to exactly one
 * occurrence while preserving every non-WAO line byte-for-byte.
 *
 * Rules:
 *   - Pre-existing exact rule(s): collapse to exactly ONE, keeping the position
 *     of the FIRST occurrence; remove only subsequent exact-rule lines.
 *   - No exact rule: append one, preserving BOM/CRLF/LF/no-trailing-newline.
 *   - Never touches comment lines, similar-but-not-exact patterns, or user
 *     lines other than removing subsequent duplicate exact-rule lines.
 *
 * @param {string} content - current exclude content (may be null/empty)
 * @returns {{ content: string, mutated: boolean, rulePresentAfter: boolean }}
 */
function prepareExcludedContent(content) {
  const rule = WAO_WORKTREE_EXCLUDE_RULE;
  const hadContent = content && content.length > 0;

  if (!hadContent) {
    // No existing content → just the rule + newline.
    const nl = "\n";
    return { content: rule + nl, mutated: true, rulePresentAfter: true };
  }

  const nl = detectNewline(content);
  // Split keeping line endings so we preserve CRLF exactly.
  const lines = content.split(/(\r?\n)/); // alternating: line, sep, line, sep, ...
  // Rebuild non-rule lines, keeping the first exact-rule occurrence.
  let seenRule = false;
  const out = [];
  let removedDup = false;
  // A BOM may prefix the very first line text; treat a BOM-prefixed rule line
  // as the exact rule (the BOM is an encoding marker, not rule text).
  const stripBom = (s) => (s.startsWith("\uFEFF") ? s.slice(1) : s);
  for (let i = 0; i < lines.length; i += 1) {
    const seg = lines[i];
    // A "line text" segment is at even index (separators at odd indices).
    const isLineText = (i % 2 === 0);
    if (isLineText && stripBom(seg) === rule) {
      if (!seenRule) {
        seenRule = true;
        out.push(seg); // keep first occurrence (preserve any BOM prefix)
      } else {
        removedDup = true; // drop subsequent exact-rule line (and its separator below)
        // Also drop the following separator segment if present.
        if (i + 1 < lines.length && /^\r?\n$/.test(lines[i + 1])) {
          i += 1; // skip separator
        }
      }
    } else {
      out.push(seg);
    }
  }
  let newContent = out.join("");

  if (seenRule) {
    // Rule already present (possibly collapsed from duplicates).
    return { content: newContent, mutated: removedDup, rulePresentAfter: true };
  }

  // No exact rule present → append. Preserve BOM at start; add separator if
  // the body does not end with a newline.
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? content.slice(1) : content;
  const needsSep = body.length > 0 && !body.endsWith("\n") && !body.endsWith("\r\n");
  const sep = needsSep ? nl : "";
  newContent = bom + body + sep + rule + nl;
  return { content: newContent, mutated: true, rulePresentAfter: true };
}

/**
 * Restore exclude to a snapshot. Only ENOENT on delete is swallowed.
 * Throws on restore failure so callers can surface cleanup failure.
 */
function restoreSnapshot(excludeFile, snapExists, snapBytes, writeExclude) {
  if (!snapExists) {
    try { unlinkSync(excludeFile); } catch (err) { if (err.code !== "ENOENT") throw err; }
    return;
  }
  writeExclude(excludeFile, snapBytes.toString("utf8"));
}

/**
 * Best-effort restore that captures (not throws) the error, for use in failure
 * paths where the original error must be surfaced. Returns null on success.
 */
function tryRestore(excludeFile, snapExists, snapBytes, writeExclude) {
  try {
    restoreSnapshot(excludeFile, snapExists, snapBytes, writeExclude);
    return null;
  } catch (err) {
    return err;
  }
}

/**
 * Ensure the repository-local exclude contains exactly one WAO worktree rule.
 * Prepare-only (no `git worktree add`). Runs under a cross-process lock; on any
 * read-back/verify failure, restores the locked-time exclude bytes/absence.
 *
 * @param {string} sourceCwd
 * @param {object} [opts]
 * @param {Function} [opts.gitExec]
 * @param {Function} [opts.writeExclude] - (filePath, content) => void
 * @param {Function} [opts.readExclude] - (filePath) => string|null
 * @returns {Promise<{added: boolean, alreadyPresent: boolean, repaired: boolean}>}
 *   added: this call appended a new rule (none existed before).
 *   repaired: this call collapsed duplicates to exactly one (or otherwise mutated).
 *   alreadyPresent: rule was already exactly-one before this call.
 */
export async function ensureWaoWorktreeExclude(sourceCwd, opts = {}) {
  const {
    gitExec,
    writeExclude = defaultWriteExclude,
    readExclude = defaultReadExclude,
  } = opts;
  const git = gitExec ?? defaultGitExec;
  const commonDir = resolveCommonGitDir(sourceCwd, git);
  const excludeFile = join(commonDir, "info", "exclude");
  const lockPath = `${excludeFile}.wao-lock`;

  const release = await acquireExcludeLock(lockPath);
  try {
    // Snapshot the LOCKED-TIME state (this is the rollback target, NOT pre-call).
    const snapExists = existsSync(excludeFile);
    const snapBytes = snapExists ? readFileSync(excludeFile) : null;
    const currentContent = snapExists ? snapBytes.toString("utf8") : "";

    const wasPresent = countExactRule(currentContent) >= 1;
    const prepared = prepareExcludedContent(currentContent);

    if (prepared.mutated) {
      try {
        writeExclude(excludeFile, prepared.content);
      } catch (writeErr) {
        // Restore locked-time bytes (the pre-mutation state under this lock).
        const restoreErr = tryRestore(excludeFile, snapExists, snapBytes, writeExclude);
        if (restoreErr) {
          throw new Error(
            `exclude write failure: ${writeErr.message} — AND restore failed: ${restoreErr.message} (manual cleanup required)`,
          );
        }
        throw new Error(`exclude write failure: ${writeErr.message}`);
      }
      // Read-back verify (this is the verify boundary — injected throw covered here).
      let verifyContent;
      try {
        verifyContent = readExclude(excludeFile);
      } catch (readErr) {
        const restoreErr = tryRestore(excludeFile, snapExists, snapBytes, writeExclude);
        if (restoreErr) {
          throw new Error(
            `exclude read-back failure: ${readErr.message} — AND restore failed: ${restoreErr.message} (manual cleanup required)`,
          );
        }
        throw new Error(`exclude read-back failure: ${readErr.message}`);
      }
      if (verifyContent === null || countExactRule(verifyContent) !== 1) {
        const restoreErr = tryRestore(excludeFile, snapExists, snapBytes, writeExclude);
        if (restoreErr) {
          throw new Error(
            `exclude verify failed: rule not exactly one — AND restore failed: ${restoreErr.message} (manual cleanup required)`,
          );
        }
        throw new Error("exclude verify failed: rule not present exactly once after write");
      }
      // For a repair (was already present), verifyContent is acceptable as long
      // as exactly-one. We do NOT require pre-existing-bytes-prefix when we
      // collapsed duplicates (the bytes legitimately changed).
    }

    return {
      added: !wasPresent && prepared.mutated,
      repaired: wasPresent && prepared.mutated,
      alreadyPresent: wasPresent && !prepared.mutated,
    };
  } finally {
    await release();
  }
}

/**
 * Transactional form used by src/isolation.js: acquire the cross-process lock,
 * prepare the exclude rule, run the caller's `git worktree add` callback INSIDE
 * the locked section, and on any failure (prepare or add) restore the
 * locked-time exclude bytes/absence.
 *
 * isolation.js retains worktree authority (name validation, branch naming); the
 * helper only owns the exclude hygiene transaction.
 *
 * @param {string} sourceCwd
 * @param {object} opts
 * @param {Function} opts.runWorktreeAdd - () => void; called inside the lock after exclude prep.
 *   Must throw on failure; the helper handles exclude rollback.
 * @param {Function} [opts.gitExec]
 * @param {Function} [opts.writeExclude]
 * @param {Function} [opts.readExclude]
 * @returns {Promise<{added: boolean, repaired: boolean, alreadyPresent: boolean}>}
 */
export async function prepareAndRunWorktreeAdd(sourceCwd, opts) {
  const {
    runWorktreeAdd,
    gitExec,
    writeExclude = defaultWriteExclude,
    readExclude = defaultReadExclude,
  } = opts;
  if (typeof runWorktreeAdd !== "function") {
    throw new Error("prepareAndRunWorktreeAdd: runWorktreeAdd callback required");
  }
  const git = gitExec ?? defaultGitExec;
  const commonDir = resolveCommonGitDir(sourceCwd, git);
  const excludeFile = join(commonDir, "info", "exclude");
  const lockPath = `${excludeFile}.wao-lock`;

  const release = await acquireExcludeLock(lockPath);
  try {
    const snapExists = existsSync(excludeFile);
    const snapBytes = snapExists ? readFileSync(excludeFile) : null;
    const currentContent = snapExists ? snapBytes.toString("utf8") : "";

    const wasPresent = countExactRule(currentContent) >= 1;
    const prepared = prepareExcludedContent(currentContent);
    let didMutateExclude = false;

    if (prepared.mutated) {
      try {
        writeExclude(excludeFile, prepared.content);
      } catch (writeErr) {
        const restoreErr = tryRestore(excludeFile, snapExists, snapBytes, writeExclude);
        if (restoreErr) {
          throw new Error(
            `exclude write failure: ${writeErr.message} — AND restore failed: ${restoreErr.message} (manual cleanup required)`,
          );
        }
        throw new Error(`exclude write failure: ${writeErr.message}`);
      }
      let verifyContent;
      try {
        verifyContent = readExclude(excludeFile);
      } catch (readErr) {
        const restoreErr = tryRestore(excludeFile, snapExists, snapBytes, writeExclude);
        if (restoreErr) {
          throw new Error(
            `exclude read-back failure: ${readErr.message} — AND restore failed: ${restoreErr.message} (manual cleanup required)`,
          );
        }
        throw new Error(`exclude read-back failure: ${readErr.message}`);
      }
      if (verifyContent === null || countExactRule(verifyContent) !== 1) {
        const restoreErr = tryRestore(excludeFile, snapExists, snapBytes, writeExclude);
        if (restoreErr) {
          throw new Error(
            `exclude verify failed: rule not exactly one — AND restore failed: ${restoreErr.message} (manual cleanup required)`,
          );
        }
        throw new Error("exclude verify failed: rule not present exactly once after write");
      }
      didMutateExclude = true;
    }

    // Run git worktree add INSIDE the lock. On failure, restore locked-time bytes.
    try {
      runWorktreeAdd();
    } catch (addError) {
      // Restore the LOCKED-TIME snapshot (not pre-this-call bytes). This is the
      // key fix for P1-A: if another caller created a real worktree that needs
      // the rule (the rule was added under this lock before the add), restoring
      // locked-time bytes would drop the rule and re-pollute source git status.
      //
      // Spec §4.3: the WAO rule is a STABLE repository-local hygiene rule. It is
      // not tied to a single worktree's lifetime. So on worktree-add failure we
      // restore locked-time bytes — UNLESS a real .wao-worktrees/ worktree now
      // exists, in which case the rule must be re-ensured (kept) so that
      // worktree's source git status stays clean.
      if (didMutateExclude) {
        const restoreErr = tryRestore(excludeFile, snapExists, snapBytes, writeExclude);
        if (restoreErr) {
          throw new Error(
            `git worktree add failure: ${addError.message} — AND exclude restore failed: ${restoreErr.message} (manual cleanup required)`,
          );
        }
        // Re-ensure the rule if a real worktree now exists under .wao-worktrees/
        // (e.g. the callback created B's worktree before failing A's add). The
        // rule is stable hygiene and must protect any existing worktree dir.
        const sourceResolved = resolve(sourceCwd);
        const waoWtDir = join(sourceResolved, ".wao-worktrees");
        if (existsSync(waoWtDir)) {
          try {
            const cur = readExclude(excludeFile) ?? "";
            if (countExactRule(cur) < 1) {
              const rePrepared = prepareExcludedContent(cur);
              if (rePrepared.mutated) {
                writeExclude(excludeFile, rePrepared.content);
              }
            }
          } catch {
            // best-effort; the original addError is the primary signal
          }
        }
      }
      throw new Error(`git worktree add failure: ${addError.message}`);
    }

    return {
      added: !wasPresent && didMutateExclude,
      repaired: wasPresent && didMutateExclude,
      alreadyPresent: wasPresent && !didMutateExclude,
    };
  } finally {
    await release();
  }
}
