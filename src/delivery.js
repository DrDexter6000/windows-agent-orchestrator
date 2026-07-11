import { execFileSync } from "node:child_process";
import { resolve, isAbsolute, normalize as posixNormalize } from "node:path";
import { posix } from "node:path";

/**
 * Coder Delivery Contract v1 — deterministic Git delivery packager (Phase 2).
 *
 * This module owns Git delivery inspection and packaging. It is a deep module
 * that must NOT import CLI, RunManager, workflow, transcript, backend, or role
 * modules. Node built-ins only.
 *
 * Git is invoked with structured argument arrays (execFileSync). No shell-built
 * command strings are ever used.
 *
 * Phase 2 boundary:
 * - inspectDelivery: read-only, fail-closed inspection → proposed DeliveryRef
 * - packageDelivery: re-inspect, stage authorized paths, create one commit
 *
 * No transcript events are emitted here. Event ownership belongs to Phase 3.
 */

// ===== Error type =====

export class DeliveryError extends Error {
  constructor(deliveryCode, message) {
    super(message);
    this.name = "DeliveryError";
    this.deliveryCode = deliveryCode;
  }
}

// ===== Constants =====

const DELIVERY_IDENTITY = {
  name: "WAO Delivery",
  email: "wao-delivery@local",
};

// ===== Git execution (structured args, never shell strings) =====

/**
 * Run git with structured args, return stdout (utf8 by default).
 * @param {string[]} args
 * @param {{cwd?: string, encoding?: string|null}} [opts]
 * @returns {string|Buffer}
 */
function git(args, opts = {}) {
  return execFileSync("git", args, {
    cwd: opts.cwd,
    encoding: opts.encoding ?? "utf8",
    stdio: ["pipe", "pipe", "ignore"], // swallow stderr to keep errors clean
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
}

/**
 * Run git, return null on failure (instead of throwing).
 * @param {string[]} args
 * @param {{cwd?: string, encoding?: string|null}} [opts]
 * @returns {string|Buffer|null}
 */
function gitSafe(args, opts = {}) {
  try {
    return git(args, opts);
  } catch {
    return null;
  }
}

// ===== Path normalization =====

/** Normalize a path to forward-slash separators for comparison/output. */
function toFwd(p) {
  return String(p).replace(/\\/g, "/");
}

/** Normalize absolute OS path for comparison (resolve + fwd-slash). */
function normAbs(p) {
  return toFwd(resolve(p));
}

// ===== Input validation =====

/**
 * Validate a WAO runId. Must be safe for use as a git ref component in `wao/<runId>`.
 * @param {string} runId
 * @returns {boolean}
 */
function isValidRunId(runId) {
  if (typeof runId !== "string" || runId.length === 0) return false;
  // No path separators (branch = wao/<runId>, separators would create sub-refs/traversal)
  if (/[\\/]/.test(runId)) return false;
  // No NUL byte
  if (runId.includes("\0")) return false;
  // No traversal
  if (runId.includes("..")) return false;
  // No spaces (git refs cannot contain spaces)
  if (/\s/.test(runId)) return false;
  // No git ref-special characters
  if (/[~^:?*\[]/.test(runId)) return false;
  // Must not start with dot or dash (git ref rule)
  if (/^[.-]/.test(runId)) return false;
  return true;
}

/**
 * Validate an allowedPath entry. Repo-relative path, no traversal/absolute/rooted.
 * Rejects empty segments, trailing slash, leading slash — does not silently rewrite.
 * @param {string} p
 * @returns {boolean}
 */
function isValidAllowedPath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.includes("\0")) return false;
  const fwd = toFwd(p);
  // Reject absolute/drive-qualified/rooted
  if (fwd.startsWith("/")) return false;
  if (/^[a-zA-Z]:/.test(fwd)) return false;
  // Reject "." exactly
  if (fwd === ".") return false;
  // Reject trailing slash (would create empty final segment)
  if (fwd.endsWith("/")) return false;
  const segments = fwd.split("/");
  // Reject any empty segment (catches double slashes, leading slash already caught)
  if (segments.some((s) => s.length === 0)) return false;
  // Reject any "." or ".." segment
  if (segments.some((s) => s === ".." || s === ".")) return false;
  return true;
}

/**
 * Normalize and validate allowedPaths array.
 * @param {string[]} allowedPaths
 * @returns {string[]} normalized forward-slash paths
 */
function validateAllowedPaths(allowedPaths) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    throw new DeliveryError(
      "invalid_allowed_paths",
      "allowedPaths must be a non-empty array",
    );
  }
  for (const p of allowedPaths) {
    if (!isValidAllowedPath(p)) {
      throw new DeliveryError(
        "invalid_allowed_paths",
        `invalid allowedPath: ${JSON.stringify(p)}`,
      );
    }
  }
  // Deduplicate + normalize to forward slash
  const normalized = [...new Set(allowedPaths.map(toFwd))];
  return normalized.sort();
}

/**
 * Check whether a changed path is covered by any allowed path entry
 * (exact match or descendant on a path-segment boundary).
 * @param {string} changed
 * @param {string[]} allowed
 * @returns {boolean}
 */
function isPathAllowed(changed, allowed) {
  const c = toFwd(changed);
  return allowed.some((a) => {
    if (c === a) return true;
    // descendant on segment boundary: "src" allows "src/a.js" but not "src2/a.js"
    if (c.startsWith(a + "/")) return true;
    return false;
  });
}

// ===== NUL-delimited parsing =====

/** Parse NUL-delimited git output into an array of non-empty strings. */
function parseNul(output) {
  return String(output)
    .split("\0")
    .filter((s) => s.length > 0);
}

// ===== Persistent linked-worktree proof =====

/**
 * Prove through Git that worktreePath is a persistent linked worktree on the
 * expected branch at the expected base commit.
 *
 * @param {object} input — validated input (runId, worktreePath, baseCommit, isolation)
 * @returns {{worktreePath: string, branch: string, canonicalBase: string}}
 * @throws {DeliveryError} on any proof failure
 */
function proveLinkedWorktree(input) {
  const { runId, worktreePath, baseCommit, isolation } = input;
  const expectedBranch = `wao/${runId}`;

  // 1. Must be a git repository
  const toplevelRaw = gitSafe(["rev-parse", "--show-toplevel"], {
    cwd: worktreePath,
  });
  if (toplevelRaw === null) {
    throw new DeliveryError(
      "not_a_git_repo",
      `worktreePath is not a git repository: ${worktreePath}`,
    );
  }

  // 2. Toplevel must resolve to the requested worktree path
  const toplevel = normAbs(toplevelRaw.trim());
  if (toplevel !== normAbs(worktreePath)) {
    throw new DeliveryError(
      "worktree_path_mismatch",
      `git toplevel (${toplevel}) does not match worktreePath (${normAbs(worktreePath)})`,
    );
  }

  // 3. Must be a linked worktree, not the primary checkout.
  //    --absolute-git-dir is always absolute. --git-common-dir may be relative
  //    (e.g. ".git") and is resolved relative to the cwd (worktreePath).
  //    Primary checkout: git-dir == common-dir. Linked worktree: they differ
  //    (git-dir = <worktree>/.git, common-dir = <main-repo>/.git).
  const gitDir = normAbs(
    String(git(["rev-parse", "--absolute-git-dir"], { cwd: worktreePath })).trim(),
  );
  let commonDirRaw = String(git(["rev-parse", "--git-common-dir"], { cwd: worktreePath })).trim();
  if (!isAbsolute(commonDirRaw)) {
    commonDirRaw = resolve(worktreePath, commonDirRaw);
  }
  const commonDir = normAbs(commonDirRaw);
  if (gitDir === commonDir) {
    throw new DeliveryError(
      "primary_checkout",
      `worktreePath is the primary checkout, not an isolated linked worktree: ${worktreePath}`,
    );
  }

  // 4. HEAD must be attached to the expected branch (not detached)
  const branchRaw = gitSafe(["symbolic-ref", "--short", "HEAD"], {
    cwd: worktreePath,
  });
  if (branchRaw === null) {
    throw new DeliveryError(
      "detached_head",
      `HEAD is detached in worktree, expected branch ${expectedBranch}`,
    );
  }
  const actualBranch = branchRaw.trim();
  if (actualBranch !== expectedBranch) {
    throw new DeliveryError(
      "wrong_branch",
      `HEAD is on branch ${actualBranch}, expected ${expectedBranch}`,
    );
  }

  // 5. Canonicalize baseCommit and verify HEAD matches.
  //    --end-of-options prevents baseCommit values starting with '-' from being
  //    interpreted as git options (defense in depth — validateInput already rejects them).
  const canonicalBase = String(
    git(["rev-parse", "--verify", "--end-of-options", `${baseCommit}^{commit}`], { cwd: worktreePath }),
  ).trim();
  const headCommit = String(git(["rev-parse", "HEAD"], { cwd: worktreePath })).trim();
  if (headCommit !== canonicalBase) {
    throw new DeliveryError(
      "base_commit_mismatch",
      `worktree HEAD (${headCommit}) does not match baseCommit (${canonicalBase})`,
    );
  }

  return { worktreePath: normAbs(worktreePath), branch: expectedBranch, canonicalBase };
}

// ===== Change detection (read-only) =====

/**
 * Detect all changes in the worktree relative to baseCommit.
 * Rejects pre-staged changes (packager must own staging).
 *
 * @param {string} cwd — worktree path
 * @param {string} baseCommit — canonical full hash
 * @returns {string[]} sorted unique repo-relative changed paths
 * @throws {DeliveryError}
 */
function detectChanges(cwd, baseCommit) {
  // Reject pre-staged changes first
  const staged = parseNul(
    git(["diff", "--name-only", "--cached", "-z"], { cwd }),
  );
  if (staged.length > 0) {
    throw new DeliveryError(
      "pre_staged_changes",
      `worktree has pre-staged changes (${staged.join(", ")}); packager must own staging`,
    );
  }

  // Tracked changes (modified/deleted) relative to base
  const tracked = parseNul(
    git(["diff", "--name-only", "-z", baseCommit, "--"], { cwd }),
  );

  // Non-ignored untracked files
  const untracked = parseNul(
    git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd }),
  );

  // Combine, deduplicate, sort
  const all = [...new Set([...tracked, ...untracked])];
  return all.sort();
}

// ===== DeliveryRef construction =====

/**
 * Build a proposed (uncommitted) DeliveryRef v1.
 * @param {object} params
 * @returns {object} proposed DeliveryRef
 */
function buildProposedRef({
  runId,
  branch,
  worktreePath,
  baseCommit,
  changedFiles,
  verification,
}) {
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId,
    baseCommit,
    deliveryCommit: null,
    branch,
    worktreePath,
    changedFiles,
    verification: {
      status: "pending",
      ...(verification.commands.length > 0 ? { commands: verification.commands } : { commands: [] }),
      ...(verification.unavailableReason ? { unavailableReason: verification.unavailableReason } : {}),
    },
    acceptance: {
      status: "pending",
      reviewerType: "lead_agent",
    },
    integration: {
      status: "pending",
      targetCommit: null,
    },
  };
}

// ===== Input validation (full) =====

/**
 * Validate and normalize the full input object.
 * @param {object} input
 * @returns {object} validated input with normalized fields
 * @throws {DeliveryError}
 */
function validateInput(input) {
  if (!input || typeof input !== "object") {
    throw new DeliveryError("invalid_input", "input must be an object");
  }

  // runId
  if (!isValidRunId(input.runId)) {
    throw new DeliveryError(
      "invalid_run_id",
      `runId is not valid for use as a git ref component: ${JSON.stringify(input.runId)}`,
    );
  }

  // worktreePath
  if (typeof input.worktreePath !== "string" || input.worktreePath.length === 0) {
    throw new DeliveryError(
      "invalid_input",
      "worktreePath must be a non-empty string",
    );
  }

  // baseCommit — reject option-like values to prevent git argument injection
  if (typeof input.baseCommit !== "string" || input.baseCommit.length === 0) {
    throw new DeliveryError(
      "invalid_input",
      "baseCommit must be a non-empty string",
    );
  }
  if (input.baseCommit.startsWith("-")) {
    throw new DeliveryError(
      "invalid_base_commit",
      `baseCommit must not start with '-' (would be interpreted as a git option): ${JSON.stringify(input.baseCommit)}`,
    );
  }

  // isolation
  const isolation = input.isolation;
  if (
    !isolation ||
    isolation.type !== "worktree" ||
    isolation.strategy !== "persistent"
  ) {
    throw new DeliveryError(
      "invalid_isolation",
      `isolation must be {type:"worktree", strategy:"persistent"}, got: ${JSON.stringify(isolation)}`,
    );
  }

  // verification — reject whitespace-only strings (trim before checking emptiness)
  const hasCommands =
    Array.isArray(input.verificationCommands) &&
    input.verificationCommands.length > 0 &&
    input.verificationCommands.every(
      (c) => typeof c === "string" && c.trim().length > 0,
    );
  const hasReason =
    typeof input.verificationUnavailableReason === "string" &&
    input.verificationUnavailableReason.trim().length > 0;

  if (!hasCommands && !hasReason) {
    throw new DeliveryError(
      "invalid_verification",
      "must provide either non-empty verificationCommands or verificationUnavailableReason",
    );
  }

  // allowedPaths
  const allowedPaths = validateAllowedPaths(input.allowedPaths);

  // Verification object
  const verification = hasCommands
    ? { commands: [...input.verificationCommands], unavailableReason: null }
    : { commands: [], unavailableReason: input.verificationUnavailableReason };

  return {
    runId: input.runId,
    worktreePath: input.worktreePath,
    baseCommit: input.baseCommit,
    isolation,
    allowedPaths,
    verification,
  };
}

// ===== Public API: inspectDelivery =====

/**
 * Inspect an isolated Git delivery candidate without mutating any Git state.
 *
 * @param {object} input — { runId, worktreePath, baseCommit, allowedPaths, isolation, verificationCommands?, verificationUnavailableReason? }
 * @returns {object} proposed DeliveryRef (deliveryCommit: null)
 * @throws {DeliveryError} on any contract violation
 */
export function inspectDelivery(input) {
  const validated = validateInput(input);

  // Prove persistent linked worktree at correct branch/base
  const proof = proveLinkedWorktree(validated);

  // Detect changes (rejects pre-staged)
  const changedFiles = detectChanges(validated.worktreePath, proof.canonicalBase);

  // Empty diff fails closed
  if (changedFiles.length === 0) {
    throw new DeliveryError(
      "empty_diff",
      "no changes detected in worktree (empty diff)",
    );
  }

  // Validate all changed paths against allowed paths
  const disallowed = changedFiles.filter(
    (p) => !isPathAllowed(p, validated.allowedPaths),
  );
  if (disallowed.length > 0) {
    throw new DeliveryError(
      "disallowed_path",
      `changes outside allowedPaths detected: ${disallowed.join(", ")}`,
    );
  }

  // Build proposed DeliveryRef
  return buildProposedRef({
    runId: validated.runId,
    branch: proof.branch,
    worktreePath: proof.worktreePath,
    baseCommit: proof.canonicalBase,
    changedFiles,
    verification: validated.verification,
  });
}

// ===== Commit failure cleanup =====

/**
 * Unstage the packager's own staging while preserving working-tree file contents.
 * Never uses `reset --hard` or `git clean`.
 * @param {string} cwd
 */
function unstageOwnChanges(cwd) {
  // `git reset -q --` (no --hard) unstages index changes, preserves working tree.
  // Structured args, no shell string.
  gitSafe(["reset", "-q", "--"], { cwd });
}

/**
 * Rollback a delivery branch to baseCommit after a post-commit integrity failure.
 * Uses `git reset --mixed <baseCommit>` (NOT --hard) to move HEAD back to base
 * while preserving all working-tree file contents (worker changes + hook-generated files).
 *
 * After rollback, re-verifies:
 *   HEAD === canonicalBase
 *   cached diff is empty (index clean)
 *
 * @param {string} cwd — worktree path
 * @param {string} canonicalBase — canonical full hash of base commit
 * @throws {DeliveryError} with deliveryCode="cleanup_failed" if rollback verification fails
 */
function rollbackToBase(cwd, canonicalBase) {
  // `git reset --mixed <base>` — moves HEAD to base, unstages index, preserves working tree.
  // --end-of-options prevents baseCommit from being interpreted as a flag (defense in depth).
  git(["reset", "--mixed", "-q", "--end-of-options", canonicalBase], { cwd });

  // Re-verify: HEAD must be at base
  const headAfter = String(git(["rev-parse", "HEAD"], { cwd })).trim();
  if (headAfter !== canonicalBase) {
    throw new DeliveryError(
      "cleanup_failed",
      `rollback verification failed: HEAD (${headAfter}) != baseCommit (${canonicalBase}) after reset --mixed`,
    );
  }

  // Re-verify: index must be clean (no staged changes)
  const stagedAfter = parseNul(
    git(["diff", "--name-only", "--cached", "-z"], { cwd }),
  );
  if (stagedAfter.length > 0) {
    throw new DeliveryError(
      "cleanup_failed",
      `rollback verification failed: index not clean after reset --mixed; staged=[${stagedAfter.join(",")}]`,
    );
  }
}

/**
 * Unified post-commit integrity gate. Checks:
 *   1. parent of HEAD == canonicalBase
 *   2. exactly one commit in canonicalBase..HEAD
 *   3. committed files exactly match inspected changedFiles
 *   4. worktree is clean (porcelain v1 --untracked-files=all is empty)
 *
 * @param {string} cwd — worktree path
 * @param {string} canonicalBase — canonical full hash of base commit
 * @param {string[]} changedFiles — inspected authorized changed files
 * @returns {string} delivery commit hash (canonical full hash)
 * @throws {DeliveryError} with deliveryCode="commit_integrity" on any check failure
 */
function verifyPostCommitIntegrity(cwd, canonicalBase, changedFiles) {
  const deliveryCommit = String(git(["rev-parse", "HEAD"], { cwd })).trim();

  // 1. Parent must be exactly baseCommit
  const parent = String(git(["rev-parse", "HEAD^"], { cwd })).trim();
  if (parent !== canonicalBase) {
    throw new DeliveryError(
      "commit_integrity",
      `delivery commit parent (${parent}) is not baseCommit (${canonicalBase})`,
    );
  }

  // 2. Exactly one commit in baseCommit..HEAD
  const count = Number(
    String(git(["rev-list", "--count", `${canonicalBase}..HEAD`], { cwd })).trim(),
  );
  if (count !== 1) {
    throw new DeliveryError(
      "commit_integrity",
      `expected exactly 1 commit in ${canonicalBase}..HEAD, got ${count}`,
    );
  }

  // 3. Committed files must exactly equal inspected changedFiles
  const committedFiles = parseNul(
    git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"], { cwd }),
  ).sort();
  const changedSorted = [...changedFiles].sort();
  if (
    committedFiles.length !== changedSorted.length ||
    committedFiles.some((p, i) => p !== changedSorted[i])
  ) {
    throw new DeliveryError(
      "commit_integrity",
      `committed files do not match inspected changedFiles; committed=[${committedFiles.join(",")}] expected=[${changedSorted.join(",")}]`,
    );
  }

  // 4. Worktree must be clean — no tracked changes, no untracked non-ignored files.
  //    porcelain v1 with --untracked-files=all catches all non-ignored untracked files
  //    (including hook-generated ones that were not staged).
  //    Ignored files (matched by .gitignore) do NOT appear and do not block success.
  const porcelain = String(
    git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd }),
  );
  if (porcelain.trim().length > 0) {
    const dirtyPaths = parseNul(porcelain).join(", ");
    throw new DeliveryError(
      "commit_integrity",
      `worktree is dirty after commit (tracked changes or non-ignored untracked files present): ${dirtyPaths}`,
    );
  }

  return deliveryCommit;
}

// ===== Public API: packageDelivery =====

/**
 * Package an isolated Git delivery into exactly one reviewable commit.
 *
 * Sequence:
 * 1. Re-run full inspection (inspectDelivery) — fail closed before touching anything.
 * 2. Stage exact inspected authorized changed files (`git add -A -- <files...>`).
 * 3. Re-read staged paths, require exact set equality with proposed changedFiles.
 * 4. Commit with process-scoped author/committer env, deterministic message,
 *    no signing, no hooks bypass.
 * 5. On commit failure (exit≠0): unstage packager's staging, throw commit_failed.
 * 6. Post-commit integrity gate: verify parent/count/committed-paths/worktree-clean.
 *    On integrity failure: rollback branch to base (git reset --mixed, NOT --hard),
 *    preserve working-tree contents, throw commit_integrity.
 *    If rollback itself fails: throw cleanup_failed (preserves original error summary).
 * 7. Only return DeliveryRef when all integrity checks pass and worktree is clean.
 *
 * @param {object} input — same shape as inspectDelivery
 * @returns {object} committed DeliveryRef (deliveryCommit: full hash)
 * @throws {DeliveryError} on any contract violation or commit failure
 */
export function packageDelivery(input) {
  // 1. Re-inspect (read-only, fail-closed) before touching Git state
  const proposed = inspectDelivery(input);
  const cwd = proposed.worktreePath;
  const changedFiles = proposed.changedFiles;

  // 2. Stage exact inspected authorized paths
  //    `git add -A -- <pathspec...>` — structured args, explicit paths, explicit --
  git(["add", "-A", "--", ...changedFiles], { cwd });

  // 3. Re-read staged paths and require exact set equality
  const staged = parseNul(git(["diff", "--name-only", "--cached", "-z"], { cwd }));
  const stagedSet = new Set(staged);
  const changedSet = new Set(changedFiles);
  if (stagedSet.size !== changedSet.size ||
      [...changedSet].some((p) => !stagedSet.has(p))) {
    // Unstage and fail — staging did not produce exact set equality
    unstageOwnChanges(cwd);
    throw new DeliveryError(
      "staging_mismatch",
      `staged paths do not match inspected changedFiles; staged=[${staged.join(",")}] expected=[${changedFiles.join(",")}]`,
    );
  }

  // 4. Commit with process-scoped identity env
  const commitMessage = `wao-delivery: ${proposed.runId}`;
  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: DELIVERY_IDENTITY.name,
    GIT_AUTHOR_EMAIL: DELIVERY_IDENTITY.email,
    GIT_COMMITTER_NAME: DELIVERY_IDENTITY.name,
    GIT_COMMITTER_EMAIL: DELIVERY_IDENTITY.email,
    // Disable signing so machine-local config cannot block packaging
    GIT_COMMIT_GPGSIGN: "false",
  };

  let commitFailed = false;
  try {
    execFileSync("git", ["commit", "--no-gpg-sign", "-m", commitMessage], {
      cwd,
      env: commitEnv,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"], // a rejecting hook writes to stderr — fail closed
      windowsHide: true,
    });
  } catch {
    commitFailed = true;
  }

  // 5. Commit failure (exit≠0): unstage own staging, verify HEAD at base, throw
  if (commitFailed) {
    unstageOwnChanges(cwd);
    // Verify HEAD didn't move (hook might have staged then aborted)
    const headAfter = String(git(["rev-parse", "HEAD"], { cwd })).trim();
    if (headAfter !== proposed.baseCommit) {
      // Commit somehow partially succeeded or HEAD moved — rollback
      try {
        rollbackToBase(cwd, proposed.baseCommit);
      } catch (cleanupErr) {
        throw new DeliveryError(
          "cleanup_failed",
          `commit failed AND rollback failed: original=commit_failed, cleanup=${cleanupErr.message}`,
        );
      }
    }
    throw new DeliveryError(
      "commit_failed",
      `git commit failed (hook rejection or error) for runId=${proposed.runId}; index restored, worker file contents preserved`,
    );
  }

  // 6. Post-commit integrity gate
  //    Catches: hook staged disallowed files, hook created untracked files,
  //    unexpected commit structure, dirty worktree.
  let integrityError = null;
  let deliveryCommit = null;
  try {
    deliveryCommit = verifyPostCommitIntegrity(cwd, proposed.baseCommit, changedFiles);
  } catch (err) {
    integrityError = err;
  }

  if (integrityError) {
    // Rollback: move branch HEAD back to base, preserve working-tree contents
    const originalCode = integrityError.deliveryCode || "commit_integrity";
    const originalMessage = integrityError.message;
    try {
      rollbackToBase(cwd, proposed.baseCommit);
    } catch (cleanupErr) {
      // Rollback failed — do not swallow, do not claim recovery
      throw new DeliveryError(
        "cleanup_failed",
        `integrity failure (${originalCode}: ${originalMessage}) AND rollback failed: ${cleanupErr.message}`,
      );
    }
    // Rollback succeeded — throw the original integrity error
    throw new DeliveryError(
      originalCode,
      `${originalMessage}; branch rolled back to base, working-tree contents preserved`,
    );
  }

  // 7. All checks passed — build and return committed DeliveryRef
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId: proposed.runId,
    baseCommit: proposed.baseCommit,
    deliveryCommit,
    branch: proposed.branch,
    worktreePath: proposed.worktreePath,
    changedFiles: [...changedFiles].sort(),
    verification: proposed.verification,
    acceptance: { ...proposed.acceptance },
    integration: { ...proposed.integration },
  };
}
