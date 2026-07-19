// src/gitLocalExclude.js
//
// M11-1B (reframed): Runtime-neutral WAO worktree checkout hygiene.
//
// `ensureWaoWorktreeExclude` is a SHORT transaction that ensures the
// repository-local .git/info/exclude contains exactly one effective root rule
// `/.wao-worktrees/`. The cross-process lock covers ONLY the exclude
// read/normalize/write/read-back verify. After the lock is released, the
// caller (src/isolation.js) runs `git worktree add` WITHOUT holding the lock.
//
// Per CTO reframe (M11-1B round 2): `/.wao-worktrees/` is a STABLE repository-
// local hygiene rule. It is NOT removed when a worktree is removed, and it is
// NOT rolled back when `git worktree add` fails. Folding worktree-add into the
// exclude transaction was an over-design that produced a long lock and
// fragile re-ensure branches; it is removed.
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
// Lock contract (owner-token age-based lease; no PID/liveness detection):
//   - Each acquirer writes a random owner token. The token proves OWNERSHIP
//     IDENTITY for safe release — it does NOT prove the owner process is still
//     alive. This is an age-based lease, not a liveness probe.
//   - Release only deletes the lock if the on-disk token still matches — never
//     unlinks a lock a new owner already acquired.
//   - A valid token younger than LOCK_STALE_MS is retained (fresh lease).
//   - A valid token older than LOCK_STALE_MS is treated as a stale lease and
//     may be recovered (the owner is assumed to have crashed or hung). There is
//     no PID probe — age alone governs stale recovery.
//   - Empty/corrupt locks (no parseable token) are recovered only after an mtime
//     grace window, to avoid racing a writer between file creation and token
//     write.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, statSync,
} from "node:fs";
import { open, unlink, readFile, stat } from "node:fs/promises";
import { join, resolve, isAbsolute, dirname } from "node:path";

/** The single exact root rule WAO owns in .git/info/exclude. */
export const WAO_WORKTREE_EXCLUDE_RULE = "/.wao-worktrees/";

const LOCK_TIMEOUT_MS = 10000;   // how long to wait to acquire the lock
const LOCK_STALE_MS = 60000;     // a token older than this is considered stale
const LOCK_CORRUPT_GRACE_MS = 5000; // empty/corrupt lock must sit this long before recovery

// ── Git dir resolution ───────────────────────────────────────────────────────

/**
 * Resolve the repository's effective shared/common Git directory for a source
 * checkout. Uses `--git-common-dir` so linked-worktree sources land the rule
 * in the shared common dir (where info/exclude is read for all linked worktrees).
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

// ── Pure byte helpers ────────────────────────────────────────────────────────

function detectNewline(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Count lines that are exactly the rule. A rule on the first line preceded by
 * a UTF-8 BOM counts (the BOM is an encoding marker, not part of the rule).
 */
export function countExactRule(content, rule = WAO_WORKTREE_EXCLUDE_RULE) {
  if (!content) return 0;
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

/**
 * Compute new exclude content that converges the WAO rule to exactly one
 * occurrence while preserving every non-WAO line byte-for-byte (BOM, CRLF/LF,
 * user rules, comment lines). Keeps the first exact-rule occurrence; drops
 * subsequent duplicate exact-rule lines. Appends one rule if none exists.
 *
 * @param {string} content - current exclude content (may be null/empty)
 * @returns {{ content: string, mutated: boolean }}
 */
function prepareExcludedContent(content) {
  const rule = WAO_WORKTREE_EXCLUDE_RULE;
  const hadContent = content && content.length > 0;

  if (!hadContent) {
    return { content: rule + "\n", mutated: true };
  }

  const nl = detectNewline(content);
  const lines = content.split(/(\r?\n)/); // [line, sep, line, sep, ...]
  let seenRule = false;
  const out = [];
  let removedDup = false;
  const stripBom = (s) => (s.startsWith("\uFEFF") ? s.slice(1) : s);
  for (let i = 0; i < lines.length; i += 1) {
    const seg = lines[i];
    const isLineText = (i % 2 === 0);
    if (isLineText && stripBom(seg) === rule) {
      if (!seenRule) {
        seenRule = true;
        out.push(seg); // keep first occurrence (preserve any BOM prefix)
      } else {
        removedDup = true;
        if (i + 1 < lines.length && /^\r?\n$/.test(lines[i + 1])) i += 1; // drop separator too
      }
    } else {
      out.push(seg);
    }
  }
  let newContent = out.join("");
  if (seenRule) return { content: newContent, mutated: removedDup };

  // No exact rule → append, preserving BOM at start.
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? content.slice(1) : content;
  const needsSep = body.length > 0 && !body.endsWith("\n") && !body.endsWith("\r\n");
  const sep = needsSep ? nl : "";
  newContent = bom + body + sep + rule + nl;
  return { content: newContent, mutated: true };
}

function restoreSnapshot(excludeFile, snapExists, snapBytes, writeExclude) {
  if (!snapExists) {
    try { unlinkSync(excludeFile); } catch (err) { if (err.code !== "ENOENT") throw err; }
    return;
  }
  writeExclude(excludeFile, snapBytes.toString("utf8"));
}

function tryRestore(excludeFile, snapExists, snapBytes, writeExclude) {
  try {
    restoreSnapshot(excludeFile, snapExists, snapBytes, writeExclude);
    return null;
  } catch (err) {
    return err;
  }
}

// ── Owner-token cross-process lock ───────────────────────────────────────────

/**
 * Parse a lock file body. Returns { token, ts } or null if not a valid
 * owner-token record (empty/corrupt). The token is an ownership identity
 * marker for safe release — it does NOT prove the owner process is alive.
 * Absence of a parseable record means the lock is recoverable.
 */
function parseLock(raw) {
  if (!raw || raw.length === 0) return null;
  try {
    const data = JSON.parse(raw);
    if (typeof data.token === "string" && data.token.length > 0 && typeof data.ts === "number") {
      return { token: data.token, ts: data.ts };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Acquire the cross-process lock. Returns { release } where release only
 * deletes the lock if THIS owner still owns it (token match). Never unlinks a
 * lock that a new owner has acquired.
 *
 * Stale recovery rules (age-based lease; no PID/liveness probe):
 *   - A lock with a valid token younger than LOCK_STALE_MS is a fresh lease:
 *     retained (not removed). The token identifies ownership for safe release;
 *     it does NOT prove the owner process is alive.
 *   - A lock with a valid token older than LOCK_STALE_MS is a stale lease:
 *     recovered (removed), assuming the owner crashed or hung. Age alone
 *     governs; there is no PID probe.
 *   - An empty/corrupt lock (no parseable token) is removed only if its mtime
 *     is older than LOCK_CORRUPT_GRACE_MS, to avoid racing a writer between
 *     file creation and token write.
 */
async function acquireExcludeLock(lockPath) {
  const start = Date.now();
  const myToken = randomBytes(16).toString("hex");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ token: myToken, ts: Date.now() }), "utf8");
      await handle.close().catch(() => {});
      const release = async () => {
        // Only delete the lock if WE still own it (token match). A new owner
        // that acquired after we released/crashed must not be deleted.
        try {
          const cur = await readFile(lockPath, "utf8");
          const parsed = parseLock(cur);
          if (parsed && parsed.token === myToken) {
            await unlink(lockPath).catch(() => {});
          }
          // If the token differs or the lock is gone, another owner has it — leave it.
        } catch {
          // Lock already gone — nothing to release.
        }
      };
      return release;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await maybeRecoverStaleLock(lockPath);
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for WAO exclude lock: ${lockPath}`);
      }
      await sleep(5);
    }
  }
}

async function maybeRecoverStaleLock(lockPath) {
  let raw;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    return; // unreadable / gone — let the normal acquire path retry
  }
  const parsed = parseLock(raw);
  if (parsed) {
    // Valid token. A fresh lease (younger than LOCK_STALE_MS) is retained — we
    // do not remove it. A stale lease (older than LOCK_STALE_MS) is recovered.
    // The token identifies ownership for safe release; it does NOT prove the
    // owner is alive. Age alone governs stale recovery (no PID probe).
    if (Date.now() - parsed.ts > LOCK_STALE_MS) {
      await unlink(lockPath).catch(() => {});
    }
    return;
  }
  // Empty or corrupt lock. Require an mtime grace window to avoid racing a
  // writer between file creation and token write.
  try {
    const st = await stat(lockPath);
    if (Date.now() - st.mtimeMs > LOCK_CORRUPT_GRACE_MS) {
      await unlink(lockPath).catch(() => {});
    }
  } catch {
    // stat failed — let acquire retry
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensure the repository-local exclude contains exactly one WAO worktree rule.
 * SHORT transaction: acquires the cross-process lock, reads the current
 * exclude, normalizes it (exact-one convergence), writes atomically, read-back
 * verifies, releases the lock. On any read/write/verify failure, restores the
 * locked-time bytes/absence and surfaces the error (original + cleanup if
 * restore also fails).
 *
 * This does NOT run `git worktree add`. The caller runs that AFTER this
 * returns, without holding the exclude lock. The rule is STABLE: a failed
 * `git worktree add` does NOT roll it back.
 *
 * @param {string} sourceCwd
 * @param {object} [opts]
 * @param {Function} [opts.gitExec]
 * @param {Function} [opts.writeExclude] - (filePath, content) => void
 * @param {Function} [opts.readExclude] - (filePath) => string|null
 * @returns {Promise<{added: boolean, repaired: boolean, alreadyPresent: boolean}>}
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
    // Snapshot the LOCKED-TIME state (rollback target for exclude-internal failures).
    const snapExists = existsSync(excludeFile);
    const snapBytes = snapExists ? readFileSync(excludeFile) : null;
    const currentContent = snapExists ? snapBytes.toString("utf8") : "";

    const wasPresent = countExactRule(currentContent) >= 1;
    const prepared = prepareExcludedContent(currentContent);

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
