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

// M12-13: the shared per-command execution timeout/budget bounds (integer ms)
// for delivery verification. ONE range locked here — consumers (the reverify
// CLI constants, the MCP zod schemas, the verification service) alias THESE
// constants so the wire bounds cannot drift. The default applies ONLY when the
// field is ABSENT; a PRESENT-but-malformed value fails closed (never silently
// defaulted, never widened, never retried).
export const VERIFICATION_TIMEOUT_MS_MIN = 1000;
export const VERIFICATION_TIMEOUT_MS_MAX = 7_200_000; // 120 minutes
export const VERIFICATION_TIMEOUT_MS_DEFAULT = 300_000; // 5 minutes

const DELIVERY_IDENTITY = {
  name: "WAO Delivery",
  email: "wao-delivery@local",
};

// ===== Git execution (structured args, never shell strings) =====

/**
 * Run git with structured args, return stdout (utf8 by default).
 * @param {string[]} args
 * @param {{cwd?: string, encoding?: string|null, input?: string|Buffer, env?: object}} [opts]
 * @returns {string|Buffer}
 */
function git(args, opts = {}) {
  return execFileSync("git", args, {
    cwd: opts.cwd,
    encoding: opts.encoding ?? "utf8",
    env: opts.env,
    input: opts.input,
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

/**
 * Exported repo-relative path validator (M11-1A): the single SSOT used by both
 * packaging/inspection and the safe delivery-review projection. Reused by
 * src/application/deliveryReview.js so there is no second path-identity
 * algorithm in the codebase.
 * @param {string} p
 * @returns {boolean}
 */
export function isValidRepoRelativePath(p) {
  return isValidAllowedPath(p);
}

/** Normalize absolute OS path for comparison (resolve + fwd-slash). */
function normAbs(p) {
  return toFwd(resolve(p));
}

// ===== Input validation =====

/**
 * Validate a WAO runId. Must be safe for use as a git ref component in `wao/<runId>`,
 * a filesystem directory name, and a structured-argument value.
 *
 * Uses a conservative allowlist (alphanumeric, underscore, hyphen) to reject
 * ALL shell metacharacters, path separators, quotes, and other injection vectors.
 * This is the single SSOT — isolation.js and runManager.js both reuse it.
 *
 * @param {string} runId
 * @returns {boolean}
 */
export function isValidRunId(runId) {
  if (typeof runId !== "string" || runId.length === 0) return false;
  // Conservative allowlist: letters, digits, underscore, hyphen only.
  // Rejects everything else including &, quotes, path separators, spaces,
  // git ref-special chars, NUL.
  // Additionally reject leading dot or dash (git ref rule + option-injection defense).
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) return false;
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
 *
 * Exported (M12-1S1) so the read-only candidate inventory compares actual
 * changed paths against the ORIGINAL allowedPaths contract via this single
 * SSOT — no duplicated boundary semantics.
 *
 * @param {string} changed
 * @param {string[]} allowed
 * @returns {boolean}
 */
export function isPathAllowed(changed, allowed) {
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

// ===== Delivery identity SSOT (shared by package post-commit + assertCommittedDeliveryRef) =====

/**
 * Verify that a commit has both author AND committer set to the WAO Delivery
 * process identity. This is the single SSOT for identity checks used by both
 * verifyPostCommitIntegrity (packaging) and assertCommittedDeliveryRef /
 * assertDeliveryCommitInRepository (verification proof).
 *
 * @param {string} cwd — repository/worktree path
 * @param {string} errorDeliveryCode — DeliveryCode to throw on mismatch
 *   ("commit_integrity" for packaging, "artifact_mismatch" for verification)
 * @param {string} [commitRef="HEAD"] — the commit to check. Defaults to HEAD for
 *   packaging/linked-worktree callers; the source-repo kernel passes an explicit
 *   full delivery commit hash so the check is independent of the working tree.
 * @throws {DeliveryError} if author or committer identity does not match
 */
function assertDeliveryIdentity(cwd, errorDeliveryCode, commitRef = "HEAD") {
  const ref = commitRef;
  const authorName = String(git(["show", "-s", "--format=%an", ref], { cwd })).trim();
  const authorEmail = String(git(["show", "-s", "--format=%ae", ref], { cwd })).trim();
  const committerName = String(git(["show", "-s", "--format=%cn", ref], { cwd })).trim();
  const committerEmail = String(git(["show", "-s", "--format=%ce", ref], { cwd })).trim();
  if (authorName !== DELIVERY_IDENTITY.name || authorEmail !== DELIVERY_IDENTITY.email) {
    throw new DeliveryError(
      errorDeliveryCode,
      `author identity (${authorName} <${authorEmail}>) != WAO identity`,
    );
  }
  if (committerName !== DELIVERY_IDENTITY.name || committerEmail !== DELIVERY_IDENTITY.email) {
    throw new DeliveryError(
      errorDeliveryCode,
      `committer identity (${committerName} <${committerEmail}>) != WAO identity`,
    );
  }
}

// ===== Persistent linked-worktree proof =====

/**
 * Prove through Git that worktreePath is a persistent linked worktree on the
 * expected branch at the expected base commit.
 *
 * Exported so RunManager.resume() can reuse the same SSOT proof without
 * maintaining a second Git identity checker.
 *
 * @param {object} input — { runId, worktreePath, baseCommit, isolation }
 * @returns {{worktreePath: string, branch: string, canonicalBase: string}}
 * @throws {DeliveryError} on any proof failure
 */
export function proveLinkedWorktree(input) {
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

// ===== Exact committed DeliveryRef proof (Phase 3B) =====

/**
 * M11-3A closeout SSOT: canonical commit-id literal validator.
 *
 * A persisted DeliveryRef commit field is an immutable identity, not a name to
 * be resolved. It MUST be a complete, lowercase, 40- (sha1) or 64- (sha256)
 * character hexadecimal string. Anything else — HEAD, branch, tag, refspec,
 * abbreviated SHA, uppercase, non-hex, option-like, empty — is rejected BEFORE
 * any Git command runs, so the proof never confuses "what this name resolves to
 * now" with "what the transcript recorded immutably".
 *
 * Exported so adapters and tests can share the single contract.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isCanonicalCommitId(v) {
  if (typeof v !== "string") return false;
  return /^[0-9a-f]{40}$/.test(v) || /^[0-9a-f]{64}$/.test(v);
}

/**
 * Source-repository kernel: prove a committed DeliveryRef against EXACT commit
 * objects in a repository, independent of the working tree, HEAD, or any live
 * delivery worktree.
 *
 * M11-3A: extracted from assertCommittedDeliveryRef so read-only review can
 * prove the durable delivery commit from the authorized source repo even after
 * the linked worktree is removed, the source checkout is dirty, or the source
 * HEAD has advanced. Every Git query uses an explicit commit argument (never
 * HEAD), so the working tree is never consulted.
 *
 * Proves (all against `repoRoot`):
 *   - DeliveryRef schemaVersion/kind/runId;
 *   - base/delivery commits resolve and canonicalize;
 *   - delivery parent === base;
 *   - exactly one commit in base..delivery;
 *   - committed paths exactly equal sorted changedFiles;
 *   - commit message is exactly `wao-delivery: <runId>`;
 *   - author and committer are the WAO Delivery identity.
 *
 * Does NOT check: linked-worktree status, branch, HEAD, or clean working tree.
 * Those belong to the verification wrapper (assertCommittedDeliveryRef) and to
 * delivery verification, not to read-only review.
 *
 * @param {object} input
 * @param {string} input.repoRoot — authorized source repository root
 * @param {object} input.deliveryRef — committed DeliveryRef v1
 * @returns {{ deliveryCommit, baseCommit, changedFiles }}
 * @throws {DeliveryError} deliveryCode="artifact_mismatch" on any proof failure
 */
export function assertDeliveryCommitInRepository({ repoRoot, deliveryRef }) {
  if (!deliveryRef || typeof deliveryRef !== "object") {
    throw new DeliveryError("artifact_mismatch", "deliveryRef must be an object");
  }
  if (deliveryRef.schemaVersion !== 1 || deliveryRef.kind !== "git_commit") {
    throw new DeliveryError("artifact_mismatch", "deliveryRef must be schemaVersion 1, kind git_commit");
  }
  if (!isValidRunId(deliveryRef.runId)) {
    throw new DeliveryError("artifact_mismatch", "invalid runId in deliveryRef");
  }
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new DeliveryError("artifact_mismatch", "repoRoot must be a non-empty string");
  }
  // M11-3A closeout: persisted commit fields are immutable literals, not names.
  // Reject HEAD/branch/tag/short-SHA/uppercase/non-hex/option-like/empty BEFORE
  // any Git command, so proof is over the exact recorded identity, not whatever
  // a name resolves to now.
  if (!isCanonicalCommitId(deliveryRef.baseCommit)) {
    throw new DeliveryError("artifact_mismatch", "baseCommit must be a canonical 40/64-hex commit id");
  }
  if (!isCanonicalCommitId(deliveryRef.deliveryCommit)) {
    throw new DeliveryError("artifact_mismatch", "deliveryCommit must be a canonical 40/64-hex commit id");
  }

  const cwd = repoRoot;
  const delivery = deliveryRef.deliveryCommit;
  const expectedMessage = `wao-delivery: ${deliveryRef.runId}`;

  // 1. repoRoot must be a git repository.
  const toplevelRaw = gitSafe(["rev-parse", "--show-toplevel"], { cwd });
  if (toplevelRaw === null) {
    throw new DeliveryError("artifact_mismatch", "repoRoot is not a git repository");
  }

  // 2. Canonicalize base and delivery commits against EXACT objects (not HEAD).
  //    --end-of-options prevents option-like values; ^{commit} requires a commit.
  const canonicalBaseRaw = gitSafe(
    ["rev-parse", "--verify", "--end-of-options", `${deliveryRef.baseCommit}^{commit}`],
    { cwd },
  );
  if (canonicalBaseRaw === null) {
    throw new DeliveryError("artifact_mismatch", "baseCommit does not resolve to a commit");
  }
  const canonicalBase = String(canonicalBaseRaw).trim();
  const canonicalDeliveryRaw = gitSafe(
    ["rev-parse", "--verify", "--end-of-options", `${delivery}^{commit}`],
    { cwd },
  );
  if (canonicalDeliveryRaw === null) {
    throw new DeliveryError("artifact_mismatch", "deliveryCommit does not resolve to a commit");
  }
  const canonicalDelivery = String(canonicalDeliveryRaw).trim();

  // 2b. M11-3A closeout: the resolved canonical commit must equal the persisted
  //     literal exactly. A complete hex id resolves to itself; if it ever does
  //     not, the object database is answering for a different identity than the
  //     transcript recorded — fail closed.
  if (canonicalBase !== deliveryRef.baseCommit) {
    throw new DeliveryError("artifact_mismatch", "resolved baseCommit differs from the persisted literal");
  }
  if (canonicalDelivery !== delivery) {
    throw new DeliveryError("artifact_mismatch", "resolved deliveryCommit differs from the persisted literal");
  }

  // 3. Parent must be exactly baseCommit (explicit object query, not HEAD^).
  const parent = String(git(
    ["rev-parse", "--verify", "--end-of-options", `${canonicalDelivery}^`],
    { cwd },
  )).trim();
  if (parent !== canonicalBase) {
    throw new DeliveryError("artifact_mismatch", "delivery commit parent does not match baseCommit");
  }

  // 4. Exactly one commit in base..delivery.
  const count = Number(String(git(
    ["rev-list", "--count", `${canonicalBase}..${canonicalDelivery}`],
    { cwd },
  )).trim());
  if (count !== 1) {
    throw new DeliveryError("artifact_mismatch", `expected 1 commit in base..delivery, got ${count}`);
  }

  // 5. Committed files must exactly equal sorted changedFiles.
  const committedFiles = parseNul(
    git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", canonicalDelivery], { cwd }),
  ).sort();
  const expectedFiles = [...deliveryRef.changedFiles].sort();
  if (committedFiles.length !== expectedFiles.length ||
      committedFiles.some((p, i) => p !== expectedFiles[i])) {
    throw new DeliveryError("artifact_mismatch", "committed files do not match deliveryRef.changedFiles");
  }

  // 6. Commit message must be exact.
  const msg = String(git(["show", "-s", "--format=%B", canonicalDelivery], { cwd })).trim();
  if (msg !== expectedMessage) {
    throw new DeliveryError("artifact_mismatch", "commit message mismatch");
  }

  // 7. Author/committer must be WAO identity (SSOT, explicit commit).
  assertDeliveryIdentity(cwd, "artifact_mismatch", canonicalDelivery);

  return {
    deliveryCommit: canonicalDelivery,
    baseCommit: canonicalBase,
    changedFiles: expectedFiles,
  };
}

/**
 * Prove that a committed DeliveryRef is an exact, unmutated delivery commit in
 * a LIVE linked worktree, AND that the worktree is at HEAD=deliveryCommit on the
 * expected branch and clean.
 *
 * Reuses the source-repository kernel (assertDeliveryCommitInRepository) for the
 * exact commit proof, then retains the linked-worktree / branch / HEAD / clean
 * checks that delivery verification requires. The kernel runs against the
 * worktree path (which shares the source repo's object database), so behavior is
 * unchanged for verification callers.
 *
 * Used by deliveryVerification.js before and after running verification commands.
 *
 * @param {object} deliveryRef — committed DeliveryRef v1
 * @returns {{ deliveryCommit, baseCommit, branch, worktreePath, changedFiles }}
 * @throws {DeliveryError} with deliveryCode="artifact_mismatch" on any proof failure
 */
export function assertCommittedDeliveryRef(deliveryRef) {
  if (!deliveryRef || typeof deliveryRef !== "object") {
    throw new DeliveryError("artifact_mismatch", "deliveryRef must be an object");
  }
  if (deliveryRef.schemaVersion !== 1 || deliveryRef.kind !== "git_commit") {
    throw new DeliveryError("artifact_mismatch", "deliveryRef must be schemaVersion 1, kind git_commit");
  }
  if (!isValidRunId(deliveryRef.runId)) {
    throw new DeliveryError("artifact_mismatch", `invalid runId in deliveryRef: ${JSON.stringify(deliveryRef.runId)}`);
  }

  const cwd = deliveryRef.worktreePath;
  const expectedBranch = `wao/${deliveryRef.runId}`;

  // 1. Must be a git repository
  const toplevelRaw = gitSafe(["rev-parse", "--show-toplevel"], { cwd });
  if (toplevelRaw === null) {
    throw new DeliveryError("artifact_mismatch", `worktreePath is not a git repository: ${cwd}`);
  }
  if (normAbs(toplevelRaw.trim()) !== normAbs(cwd)) {
    throw new DeliveryError("artifact_mismatch", "git toplevel does not match worktreePath");
  }

  // 2. Must be a linked worktree
  const gitDir = normAbs(String(git(["rev-parse", "--absolute-git-dir"], { cwd })).trim());
  let commonDirRaw = String(git(["rev-parse", "--git-common-dir"], { cwd })).trim();
  if (!isAbsolute(commonDirRaw)) commonDirRaw = resolve(cwd, commonDirRaw);
  if (gitDir === normAbs(commonDirRaw)) {
    throw new DeliveryError("artifact_mismatch", "worktree is primary checkout, not linked");
  }

  // 3. Branch must be exactly wao/<runId>
  const branchRaw = gitSafe(["symbolic-ref", "--short", "HEAD"], { cwd });
  if (branchRaw === null) {
    throw new DeliveryError("artifact_mismatch", "HEAD is detached");
  }
  if (branchRaw.trim() !== expectedBranch) {
    throw new DeliveryError("artifact_mismatch", `HEAD on wrong branch: ${branchRaw.trim()} != ${expectedBranch}`);
  }

  // 4. Exact commit proof via the shared kernel (runs against this worktree's
  //    shared object database; uses explicit commit args, not HEAD).
  const kernel = assertDeliveryCommitInRepository({ repoRoot: cwd, deliveryRef });

  // 5. HEAD must be exactly deliveryCommit (linked-worktree-specific: the
  //    kernel proved the commit object; here we prove the worktree IS at it).
  const head = String(git(["rev-parse", "HEAD"], { cwd })).trim();
  if (head !== kernel.deliveryCommit) {
    throw new DeliveryError("artifact_mismatch", `HEAD (${head}) != deliveryCommit (${kernel.deliveryCommit})`);
  }

  // 6. Worktree must be clean (no non-ignored changes) — verification requirement.
  const porcelain = String(git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd }));
  if (porcelain.trim().length > 0) {
    throw new DeliveryError("artifact_mismatch", `worktree is dirty: ${parseNul(porcelain).join(", ")}`);
  }

  return {
    deliveryCommit: kernel.deliveryCommit,
    baseCommit: kernel.baseCommit,
    branch: expectedBranch,
    worktreePath: cwd,
    changedFiles: kernel.changedFiles,
  };
}

// ===== Change detection (read-only) =====

/**
 * M12-1S1: read-only change listing for the no-model-salvage candidate
 * inventory. Tracked changes relative to baseCommit PLUS non-ignored
 * untracked files — the same two reads detectChanges performs, but WITHOUT
 * the pre-staged rejection and WITHOUT the empty-diff failure: the inventory
 * reports facts (including a truthful empty set), it does not package.
 *
 * BOTH required Git reads must succeed; returns null when either fails —
 * never partial truth. Strictly read-only: no staging, no reset, no writes;
 * branch/HEAD/index/worktree contents are untouched.
 *
 * @param {string} cwd — worktree path
 * @param {string} baseCommit — canonical full hash (callers validate via
 *   isCanonicalCommitId before invoking; git is still invoked with structured
 *   args, never a shell string)
 * @returns {string[]|null} sorted unique repo-relative changed paths, or null
 *   when either required Git read failed
 */
export function listWorktreeChangedPaths(cwd, baseCommit) {
  // Tracked changes (modified/deleted) relative to base
  const tracked = gitSafe(["diff", "--name-only", "-z", baseCommit, "--"], { cwd });
  if (tracked === null) return null;

  // Non-ignored untracked files
  const untracked = gitSafe(["ls-files", "--others", "--exclude-standard", "-z"], { cwd });
  if (untracked === null) return null;

  // Combine, deduplicate, sort
  return [...new Set([...parseNul(tracked), ...parseNul(untracked)])].sort();
}

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
      // M12-6 (FR-05): Lead-authored setup commands. Append-only optional
      // extension — persisted ONLY when declared, so refs without setup stay
      // byte-identical (zero drift). Readers treat absence as "no setup phase".
      ...(verification.setupCommands && verification.setupCommands.length > 0
        ? { setupCommands: [...verification.setupCommands] }
        : {}),
      // M12-13: per-command execution timeout/budget. Append-only optional
      // extension — persisted ONLY when declared, so refs without it stay
      // byte-identical (zero drift). Readers apply the default only on absence.
      ...(verification.verificationTimeoutMs !== undefined
        ? { verificationTimeoutMs: verification.verificationTimeoutMs }
        : {}),
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

  // M12-6 (FR-05): optional Lead-authored setup commands. Validated with the
  // same trim-aware rule as assertions. Optional — absent/empty → [] (no setup
  // phase). Allowed alongside either verificationCommands or unavailableReason.
  const setupCommands = normalizeOptionalVerificationCommands(input.verificationSetupCommands);

  // M12-13: optional per-command execution timeout. Absent → not persisted
  // (zero drift); present but malformed → invalid_verification BEFORE any side
  // effect (this SSOT runs before worktree/spawn/packaging/verification).
  const verificationTimeoutMs = normalizeVerificationTimeoutMs(input.verificationTimeoutMs);

  // Verification object
  const verification = hasCommands
    ? { commands: [...input.verificationCommands], unavailableReason: null, setupCommands }
    : { commands: [], unavailableReason: input.verificationUnavailableReason, setupCommands };
  if (verificationTimeoutMs !== undefined) verification.verificationTimeoutMs = verificationTimeoutMs;

  return {
    runId: input.runId,
    worktreePath: input.worktreePath,
    baseCommit: input.baseCommit,
    isolation,
    allowedPaths,
    verification,
  };
}

// ===== M12-6 (FR-04): verification command absolute-path preflight =====
//
// A deterministic, conservative command-literal detector. It statically
// identifies absolute path literals in a verification command string WITHOUT
// attempting shell interpretation (no variable expansion, no command
// substitution — only quote-aware tokenization). A portability/isolation rule:
// delivery verification must be workspace-portable, so commands embedding
// Windows drive paths (C:\..), UNC paths (\\host\share or //host/share), or
// POSIX absolute paths (/etc/..) are rejected before dispatch.
//
// URL false positives are avoided structurally: a URL token (https://..,
// file://..) never begins with a path indicator — its scheme prefix precedes
// any "//" — so leading-character detection never matches a URL. Relative paths
// (./x, src/y) and command flags (--foo) are not flagged.

/**
 * Test whether a token (a quoted region's content or an unquoted whitespace-
 * delimited token) begins with an absolute path indicator.
 * @param {string} token
 * @returns {boolean}
 */
function isAbsolutePathLiteralStart(token) {
  if (typeof token !== "string" || token.length === 0) return false;
  // UNC: leading \\ or //
  if (token.startsWith("\\\\") || token.startsWith("//")) return true;
  // POSIX absolute: leading /
  if (token.charCodeAt(0) === 47) return true; // '/'
  // Windows drive: exactly one letter + ':' + '\' or '/' (the single-letter
  // requirement distinguishes a drive "C:" from a URL scheme "https:").
  if (token.length >= 3) {
    const a = token.charCodeAt(0);
    const isLetter = (a >= 65 && a <= 90) || (a >= 97 && a <= 122); // A-Z a-z
    if (isLetter && token.charCodeAt(1) === 58) { // ':'
      const sep = token.charCodeAt(2);
      if (sep === 92 || sep === 47) return true; // '\' or '/'
    }
  }
  return false;
}

// M12-6 (FR-04 corner cases): a small EXPLICIT safe delimiter set that may
// introduce an absolute-path literal — assignment ("="), redirection (">" "<"),
// and command separators (";" "|"). A path appearing immediately after one of
// these (e.g. `--require=C:\outside\x.js` or `>C:\outside\out.txt`) is just as
// non-portable as a bare absolute path, so it is flagged too.
//
// This deliberately does NOT split on ":" (a drive needs ":" but so do URL
// schemes and ordinary colon text — splitting there would mass false-positive).
// URL-like tokens (containing "://") are never split: their scheme precedes any
// "//", and an "=" or ";" inside a URL query string (e.g. `?file=/etc/passwd`)
// must not turn the value into a flagged path. This stays a conservative lexical
// scan — NOT a shell interpreter.
const PATH_INTRODUCING_DELIMITERS = /[=<>;|]/;
function tokenHasAbsolutePathLiteral(token) {
  if (isAbsolutePathLiteralStart(token)) return true;
  if (typeof token !== "string" || token.length === 0) return false;
  // URL-like token: only its start matters (checked above); do not split.
  if (token.includes("://")) return false;
  // Prefixed literal: any segment introduced by a safe delimiter that itself
  // begins with an absolute-path indicator.
  const segments = token.split(PATH_INTRODUCING_DELIMITERS);
  for (const seg of segments) {
    if (isAbsolutePathLiteralStart(seg)) return true;
  }
  return false;
}

/**
 * Statically detect the first absolute path literal in a command string, or
 * null if none. Quote-aware: a double- or single-quoted region is treated as
 * one literal even when it contains spaces, so `"C:\Program Files\app"` is
 * detected as one path.
 *
 * This is a conservative lexical scan — NOT a shell interpreter. It does not
 * expand variables, run commands, or resolve redirects; it only recognizes
 * path-indicating leading characters on quote-delimited literals.
 *
 * The returned span is for internal diagnostics ONLY — callers MUST NOT echo it
 * across the MCP trust boundary (the fixed DeliveryError message carries no
 * literal text).
 *
 * @param {string} command
 * @returns {string|null} the verbatim offending span, or null
 */
export function detectAbsolutePathLiteral(command) {
  if (typeof command !== "string") return null;
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command.charCodeAt(i);
    // Skip whitespace (space, tab, LF, CR).
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13) { i += 1; continue; }
    // Quoted region: "..." or '...' (content may contain spaces).
    if (ch === 34 || ch === 39) { // " or '
      const quote = ch;
      const start = i;
      i += 1;
      let buf = "";
      while (i < n && command.charCodeAt(i) !== quote) {
        buf += command[i];
        i += 1;
      }
      if (i < n && command.charCodeAt(i) === quote) i += 1; // consume closer
      if (isAbsolutePathLiteralStart(buf)) return command.slice(start, i);
      continue;
    }
    // Unquoted token: read until whitespace or a quote.
    const start = i;
    let buf = "";
    while (i < n) {
      const c = command.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 34 || c === 39) break;
      buf += command[i];
      i += 1;
    }
    if (tokenHasAbsolutePathLiteral(buf)) return command.slice(start, i);
  }
  return null;
}

/**
 * M12-6 (FR-04): reject statically identifiable absolute path literals across a
 * verification command list. Conservative command-literal detection — no shell
 * interpretation, URL-safe. Throws a DeliveryError whose code is a closed-set
 * label; the offending literal is never placed in the message.
 *
 * @param {string[]} commands
 * @throws {DeliveryError} deliveryCode="invalid_verification_path" if any
 *   command contains a statically identifiable absolute path literal.
 */
function assertNoAbsolutePathInVerification(commands) {
  for (const cmd of commands) {
    if (detectAbsolutePathLiteral(cmd) !== null) {
      throw new DeliveryError(
        "invalid_verification_path",
        "verification command contains a statically identifiable absolute path literal; use a portable workspace-relative command",
      );
    }
  }
}

/**
 * M12-6 (FR-05): normalize the optional Lead-authored environment setup command
 * list. Same trim-aware validation rule as assertion commands, but optional —
 * absent / null / empty yields [] (zero drift: no setup phase). A non-array or
 * any non-string / whitespace-only entry fails closed with invalid_verification.
 *
 * Setup commands only ever come from Lead delivery input, never from worker
 * output. Returned as a defensive copy.
 *
 * @param {unknown} value — input.verificationSetupCommands
 * @returns {string[]} normalized command list (possibly empty)
 * @throws {DeliveryError} deliveryCode="invalid_verification" on a malformed list
 */
function normalizeOptionalVerificationCommands(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new DeliveryError(
      "invalid_verification",
      "verificationSetupCommands must be an array of non-empty command strings",
    );
  }
  for (const c of value) {
    if (typeof c !== "string" || c.trim().length === 0) {
      throw new DeliveryError(
        "invalid_verification",
        "verificationSetupCommands must contain only non-empty command strings",
      );
    }
  }
  return [...value];
}

/**
 * M12-13: normalize the OPTIONAL per-command execution timeout (integer ms).
 *
 * Absent (undefined) → returns undefined (callers MUST NOT persist the key —
 * zero drift). Present but malformed — null, non-integer (string/fraction), or
 * outside the SHARED bounds [VERIFICATION_TIMEOUT_MS_MIN, VERIFICATION_TIMEOUT_MS_MAX]
 * — fails closed with DeliveryError "invalid_verification". Distinguishing
 * absent from present is deliberate: an invalid present value must never be
 * silently defaulted.
 *
 * This leaf is called from prepareDeliveryRequest (start/resume revalidation)
 * BEFORE any side effect — transcript append, worktree mutation, spawn/attach,
 * packaging, verification.
 *
 * @param {unknown} value — delivery.verificationTimeoutMs
 * @returns {number|undefined} validated integer ms, or undefined when absent
 * @throws {DeliveryError} deliveryCode="invalid_verification"
 */
function normalizeVerificationTimeoutMs(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new DeliveryError(
      "invalid_verification",
      `verificationTimeoutMs must be an integer number of milliseconds in [${VERIFICATION_TIMEOUT_MS_MIN}, ${VERIFICATION_TIMEOUT_MS_MAX}], got: ${JSON.stringify(value)}`,
    );
  }
  if (value < VERIFICATION_TIMEOUT_MS_MIN || value > VERIFICATION_TIMEOUT_MS_MAX) {
    throw new DeliveryError(
      "invalid_verification",
      `verificationTimeoutMs must be an integer number of milliseconds in [${VERIFICATION_TIMEOUT_MS_MIN}, ${VERIFICATION_TIMEOUT_MS_MAX}], got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

// ===== Public API: prepareDeliveryRequest =====

/**
 * Validate and normalize a delivery request from RunManager.start() options.
 * This is the SSOT for delivery-request validation — RunManager calls this
 * before backend spawn to fail-closed on invalid delivery configs.
 *
 * Does NOT require worktreePath or baseCommit (those are captured after worktree
 * creation). Validates mode, allowedPaths, and verification declaration only.
 *
 * @param {object} delivery — { mode, allowedPaths, verificationCommands?, verificationUnavailableReason? }
 * @returns {{mode:string, allowedPaths:string[], verification:{commands:string[], unavailableReason:string|null}}}
 * @throws {DeliveryError} on any contract violation
 */
export function prepareDeliveryRequest(delivery) {
  if (!delivery || typeof delivery !== "object") {
    throw new DeliveryError("invalid_input", "delivery must be an object");
  }

  // mode
  if (delivery.mode !== "git_commit_v1") {
    throw new DeliveryError(
      "invalid_mode",
      `delivery.mode must be "git_commit_v1", got: ${JSON.stringify(delivery.mode)}`,
    );
  }

  // allowedPaths — reuse the same SSOT validator
  const allowedPaths = validateAllowedPaths(delivery.allowedPaths);

  // verification — same trim-aware check as validateInput
  const hasCommands =
    Array.isArray(delivery.verificationCommands) &&
    delivery.verificationCommands.length > 0 &&
    delivery.verificationCommands.every(
      (c) => typeof c === "string" && c.trim().length > 0,
    );
  const hasReason =
    typeof delivery.verificationUnavailableReason === "string" &&
    delivery.verificationUnavailableReason.trim().length > 0;

  if (!hasCommands && !hasReason) {
    throw new DeliveryError(
      "invalid_verification",
      "must provide either non-empty verificationCommands or verificationUnavailableReason",
    );
  }

  const verification = hasCommands
    ? { commands: [...delivery.verificationCommands], unavailableReason: null }
    : { commands: [], unavailableReason: delivery.verificationUnavailableReason };

  // M12-6 (FR-05): optional Lead-authored setup commands, same trim-aware rule.
  const setupCommands = normalizeOptionalVerificationCommands(delivery.verificationSetupCommands);

  // M12-13: optional per-command execution timeout. Validated HERE — before any
  // side effect (transcript append, worktree mutation, spawn/attach, packaging,
  // verification). Absent → NOT persisted (zero drift); present-but-malformed →
  // invalid_verification, never silently defaulted.
  const verificationTimeoutMs = normalizeVerificationTimeoutMs(delivery.verificationTimeoutMs);

  // M12-6 (FR-04): reject statically identifiable absolute path literals in
  // verification commands. This is the dispatch preflight SSOT — callers invoke
  // prepareDeliveryRequest before backend spawn, so the check runs before any
  // registry/provider/transcript/worktree work. Conservative command-literal
  // detection (no shell interpretation); URLs are not path literals.
  if (verification.commands.length > 0) {
    assertNoAbsolutePathInVerification(verification.commands);
  }
  // M12-6 (FR-05): the same portability preflight applies to setup commands.
  if (setupCommands.length > 0) {
    assertNoAbsolutePathInVerification(setupCommands);
  }

  // Setup commands are an append-only optional extension: persist only when
  // declared, so requests without setup stay byte-identical (zero drift).
  // The execution timeout follows the same append-only rule (M12-13): only a
  // DECLARED value is persisted — absence means "consumer default applies".
  return {
    mode: "git_commit_v1",
    allowedPaths,
    verification: {
      ...verification,
      ...(setupCommands.length > 0 ? { setupCommands } : {}),
      ...(verificationTimeoutMs !== undefined ? { verificationTimeoutMs } : {}),
    },
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

// ===== Index restoration =====

/**
 * Restore the index to match HEAD (base) after a failed packaging attempt.
 * Uses `git reset -q --` (default --mixed mode) to unstage all changes without
 * touching the working tree. Never uses `--hard` or `git clean`.
 *
 * After reset, verifies HEAD === canonicalBase and cached diff is empty.
 * @param {string} cwd
 * @param {string} canonicalBase
 * @throws {DeliveryError} with deliveryCode="cleanup_failed" if verification fails
 */
function restoreIndex(cwd, canonicalBase) {
  git(["reset", "-q", "--"], { cwd });

  // Verify HEAD at base
  const headAfter = String(git(["rev-parse", "HEAD"], { cwd })).trim();
  if (headAfter !== canonicalBase) {
    throw new DeliveryError(
      "cleanup_failed",
      `index restore verification failed: HEAD (${headAfter}) != baseCommit (${canonicalBase})`,
    );
  }

  // Verify index clean
  const stagedAfter = parseNul(
    git(["diff", "--name-only", "--cached", "-z"], { cwd }),
  );
  if (stagedAfter.length > 0) {
    throw new DeliveryError(
      "cleanup_failed",
      `index restore verification failed: index not clean; staged=[${stagedAfter.join(",")}]`,
    );
  }
}

/**
 * Rollback a delivery branch to baseCommit after a post-update-ref integrity failure.
 * Uses `git reset --mixed <baseCommit>` (NOT --hard) to move HEAD back to base
 * while preserving all working-tree file contents.
 *
 * After rollback, re-verifies HEAD === canonicalBase and cached diff is empty.
 *
 * @param {string} cwd — worktree path
 * @param {string} canonicalBase — canonical full hash of base commit
 * @throws {DeliveryError} with deliveryCode="cleanup_failed" if rollback verification fails
 */
function rollbackToBase(cwd, canonicalBase) {
  git(["reset", "--mixed", "-q", "--end-of-options", canonicalBase], { cwd });

  // Re-verify: HEAD must be at base
  const headAfter = String(git(["rev-parse", "HEAD"], { cwd })).trim();
  if (headAfter !== canonicalBase) {
    throw new DeliveryError(
      "cleanup_failed",
      `rollback verification failed: HEAD (${headAfter}) != baseCommit (${canonicalBase}) after reset --mixed`,
    );
  }

  // Re-verify: index must be clean
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

// ===== M12-7: retained-worktree transition for Lead-authorized continuation =====
//
// prepareContinuationWorktree mechanically restores the SAME retained delivery
// worktree to the persisted base for a child continuation run, so the child can
// resume the provider-native conversation in the parent's worktree WITHOUT a
// fresh worktree, a fresh session, or any scope inference.
//
// Two parent outcomes, one convergence rule:
//   - committed parent (deliveryCommit supplied): re-materialize the parent
//     delivery commit's tree as UNSTAGED working changes at base. The parent
//     commit object is NEVER deleted — it stays reviewable by exact SHA.
//   - uncommitted / backend-failed parent (deliveryCommit null): preserve the
//     retained candidate working tree AS-IS (bytes kept), only re-pinning HEAD
//     to base on the child branch and unstaging.
//
// Crash-safe / idempotent: a retried request (even with a fresh childRunId)
// converges on the same end state — child branch at base, working tree carrying
// the delivery/candidate bytes, index clean — and never destroys the parent
// commit or discards candidate bytes. No Git objects are ever deleted.
//
// Fail closed BEFORE any mutation for drift (detached / primary / wrong toplevel),
// missing repo, non-canonical base/delivery literals, or a delivery commit whose
// parent is not the persisted base.

/**
 * Read-only proof that cwd is a linked WAO worktree on a wao/<runId> branch with
 * a canonical persisted base, and (when committed) a delivery commit whose parent
 * is exactly that base. Shared by the continuation transition. Performs NO
 * mutation — every Git read here runs before the transition touches anything.
 *
 * Accepts the worktree being on ANY wao/<validRunId> branch (the parent's, an
 * already-transitioned child's, or a prior retry's) so a retried transition
 * converges instead of failing. The binding to "the right worktree" is the path
 * itself (the service resolved it from the parent's persisted delivery context);
 * the safety invariant enforced here is "a linked WAO worktree on the persisted
 * base lineage" — never the precious primary checkout.
 *
 * @param {string} cwd — worktree path
 * @param {{baseCommit: string, deliveryCommit: string|null}} input
 * @returns {{worktreePath: string, canonicalBase: string, branch: string}}
 * @throws {DeliveryError} on any proof failure (before any mutation)
 */
export function proveContinuationWorktree(cwd, { baseCommit, deliveryCommit }) {
  // 1. Must be a git repository whose toplevel is exactly this worktree.
  const toplevelRaw = gitSafe(["rev-parse", "--show-toplevel"], { cwd });
  if (toplevelRaw === null) {
    throw new DeliveryError("not_a_git_repo", `worktreePath is not a git repository: ${cwd}`);
  }
  if (normAbs(toplevelRaw.trim()) !== normAbs(cwd)) {
    throw new DeliveryError("worktree_path_mismatch", `git toplevel does not match worktreePath: ${cwd}`);
  }

  // 2. Must be a linked worktree, not the primary checkout.
  const gitDir = normAbs(String(git(["rev-parse", "--absolute-git-dir"], { cwd })).trim());
  let commonDirRaw = String(git(["rev-parse", "--git-common-dir"], { cwd })).trim();
  if (!isAbsolute(commonDirRaw)) commonDirRaw = resolve(cwd, commonDirRaw);
  if (gitDir === normAbs(commonDirRaw)) {
    throw new DeliveryError("primary_checkout", `worktreePath is the primary checkout, not an isolated linked worktree: ${cwd}`);
  }

  // 3. HEAD must be attached to a wao/<validRunId> branch (not detached, not a
  //    non-WAO branch). Accept any valid WAO lineage branch so retries converge.
  const branchRaw = gitSafe(["symbolic-ref", "--short", "HEAD"], { cwd });
  if (branchRaw === null) {
    throw new DeliveryError("detached_head", "HEAD is detached in worktree, expected a wao/<runId> branch");
  }
  const branch = branchRaw.trim();
  const branchMatch = /^wao\/([A-Za-z0-9_-]+)$/.exec(branch);
  if (!branchMatch || !isValidRunId(branchMatch[1])) {
    throw new DeliveryError("wrong_branch", `HEAD is on ${branch}, expected a wao/<runId> branch`);
  }

  // 4. Persisted base must canonicalize to itself (immutable literal, not a name).
  const canonicalBase = String(
    git(["rev-parse", "--verify", "--end-of-options", `${baseCommit}^{commit}`], { cwd }),
  ).trim();
  if (canonicalBase !== baseCommit) {
    throw new DeliveryError("base_commit_mismatch", "resolved baseCommit differs from the persisted literal");
  }

  // 5. Delivery lineage proof (committed) or HEAD-at-base proof (uncommitted).
  if (deliveryCommit !== null) {
    const canonicalDelivery = String(
      git(["rev-parse", "--verify", "--end-of-options", `${deliveryCommit}^{commit}`], { cwd }),
    ).trim();
    if (canonicalDelivery !== deliveryCommit) {
      throw new DeliveryError("artifact_mismatch", "resolved deliveryCommit differs from the persisted literal");
    }
    // The delivery commit must be exactly one generation over the persisted base.
    const parent = String(
      git(["rev-parse", "--verify", "--end-of-options", `${canonicalDelivery}^`], { cwd }),
    ).trim();
    if (parent !== canonicalBase) {
      throw new DeliveryError("artifact_mismatch", "delivery commit parent does not match baseCommit");
    }
  } else {
    // Uncommitted / backend-failed parent: no commit was ever made, so HEAD must
    // still rest at the persisted base. (On a retried transition this also holds,
    // since the transition re-pins HEAD to base.)
    const head = String(git(["rev-parse", "HEAD"], { cwd })).trim();
    if (head !== canonicalBase) {
      throw new DeliveryError("base_commit_mismatch", "uncommitted parent HEAD is not at baseCommit");
    }
  }

  return { worktreePath: normAbs(cwd), canonicalBase, branch };
}

/**
 * Mechanically restore a retained delivery worktree to the persisted base for a
 * child continuation run, preserving the parent's delivery/candidate bytes as
 * unstaged working changes. Creates / resets the child branch `wao/<childRunId>`
 * at base and switches the worktree onto it; the parent branch and parent commit
 * object are never moved or deleted (the parent commit stays reviewable by SHA).
 *
 * Idempotent: a retried transition converges on the same end state. Fails closed
 * BEFORE any mutation on drift, missing repo, or a non-canonical lineage.
 *
 * @param {string} worktreePath — the retained parent delivery worktree
 * @param {{parentRunId: string, childRunId: string, baseCommit: string, deliveryCommit?: string|null}} opts
 * @returns {{worktreePath: string, branch: string, canonicalBase: string}}
 * @throws {DeliveryError} on any proof or transition failure
 */
export function prepareContinuationWorktree(worktreePath, opts) {
  if (!opts || typeof opts !== "object") {
    throw new DeliveryError("invalid_input", "opts must be an object");
  }
  const { parentRunId, childRunId, baseCommit, deliveryCommit = null } = opts;

  // Input validation — fail closed in JS before any Git command runs.
  if (typeof worktreePath !== "string" || worktreePath.length === 0) {
    throw new DeliveryError("invalid_input", "worktreePath must be a non-empty string");
  }
  if (!isValidRunId(parentRunId)) {
    throw new DeliveryError("invalid_run_id", `parentRunId is not a valid run id: ${JSON.stringify(parentRunId)}`);
  }
  if (!isValidRunId(childRunId)) {
    throw new DeliveryError("invalid_run_id", `childRunId is not a valid run id: ${JSON.stringify(childRunId)}`);
  }
  if (!isCanonicalCommitId(baseCommit)) {
    throw new DeliveryError("invalid_base_commit", "baseCommit must be a canonical 40/64-hex commit id");
  }
  if (deliveryCommit !== null && !isCanonicalCommitId(deliveryCommit)) {
    throw new DeliveryError("invalid_delivery_commit", "deliveryCommit must be a canonical 40/64-hex commit id or null");
  }

  const cwd = worktreePath;

  // READ-ONLY PROOF — every Git read here happens before any mutation, so a
  // drift / malformed / cross-workspace input is refused without side effects.
  const proof = proveContinuationWorktree(cwd, { baseCommit, deliveryCommit });
  const canonicalBase = proof.canonicalBase;
  const childBranch = `wao/${childRunId}`;
  const childRef = `refs/heads/${childBranch}`;

  // Defensive: never clobber an existing child branch that already advanced past
  // base (a prior continuation packaged it). The transition only ever owns a
  // child branch at base; anything else is outside its contract — refuse.
  const existingChild = gitSafe(["rev-parse", "--verify", "--end-of-options", childRef], { cwd });
  if (existingChild !== null && String(existingChild).trim() !== canonicalBase) {
    throw new DeliveryError("worktree_busy", `child branch ${childBranch} already advanced past base; refusing to clobber`);
  }

  // TRANSITION — idempotent and transactional. The read-only proof above can
  // fail without cleanup touching externally changed state. Once this function
  // performs its first mutation, any later failure restores the proven parent.
  let mutationStarted = false;
  try {
    // 1. Create / reset the child branch at the persisted base.
    git(["update-ref", childRef, canonicalBase], { cwd });
    mutationStarted = true;
    // 2. Switch HEAD onto the child branch (now resolves to base).
    git(["symbolic-ref", "HEAD", childRef], { cwd });
    // 3. Committed parent: re-materialize the delivery commit's tree as the working
    //    tree (the parent commit object is untouched; read-tree checks out its
    //    tree). Uncommitted parent: skip — preserve the candidate bytes as-is.
    if (deliveryCommit !== null) {
      git(["read-tree", "-u", "--reset", deliveryCommit], { cwd });
    }
    // 4. Unstage everything so the index matches base (clean), while preserving the
    //    working-tree bytes (delivery tree / candidate). restoreIndex verifies
    //    HEAD === base and a clean index.
    restoreIndex(cwd, canonicalBase);

    // 5. Verify the end state: child branch at base.
    const headFinal = String(git(["rev-parse", "HEAD"], { cwd })).trim();
    if (headFinal !== canonicalBase) {
      throw new DeliveryError("cleanup_failed", `post-transition HEAD (${headFinal}) != baseCommit (${canonicalBase})`);
    }
    const branchFinal = String(git(["symbolic-ref", "--short", "HEAD"], { cwd })).trim();
    if (branchFinal !== childBranch) {
      throw new DeliveryError("cleanup_failed", `post-transition branch (${branchFinal}) != ${childBranch}`);
    }
  } catch (error) {
    if (mutationStarted) {
      rollbackContinuationWorktree(cwd, {
        originalBranch: proof.branch,
        childRunId,
        baseCommit,
        deliveryCommit,
      });
    }
    throw error;
  }

  return { worktreePath: proof.worktreePath, branch: childBranch, canonicalBase };
}

/**
 * Roll back a continuation transition that failed before the detached runner
 * was successfully spawned. The original retained-worktree state is restored:
 * committed parents return to their delivery commit with a clean tree;
 * uncommitted/backend-failed parents return to their original branch at base
 * while preserving candidate bytes. The temporary child branch is deleted only
 * when it still points at the persisted base.
 *
 * @param {string} worktreePath
 * @param {{originalBranch:string,childRunId:string,baseCommit:string,deliveryCommit?:string|null}} opts
 * @returns {{worktreePath:string,branch:string}}
 */
export function rollbackContinuationWorktree(worktreePath, opts) {
  if (!opts || typeof opts !== "object") {
    throw new DeliveryError("invalid_input", "opts must be an object");
  }
  const { originalBranch, childRunId, baseCommit, deliveryCommit = null } = opts;
  if (typeof worktreePath !== "string" || worktreePath.length === 0) {
    throw new DeliveryError("invalid_input", "worktreePath must be a non-empty string");
  }
  const branchMatch = /^wao\/([A-Za-z0-9_-]+)$/.exec(originalBranch ?? "");
  if (!branchMatch || !isValidRunId(branchMatch[1]) || !isValidRunId(childRunId)) {
    throw new DeliveryError("invalid_run_id", "continuation rollback requires valid WAO branch/run ids");
  }
  if (!isCanonicalCommitId(baseCommit)
    || (deliveryCommit !== null && !isCanonicalCommitId(deliveryCommit))) {
    throw new DeliveryError("invalid_input", "continuation rollback requires canonical commits");
  }

  const cwd = worktreePath;
  const originalRef = `refs/heads/${originalBranch}`;
  const childRef = `refs/heads/wao/${childRunId}`;
  const originalTarget = deliveryCommit ?? baseCommit;
  const canonicalOriginal = String(
    git(["rev-parse", "--verify", "--end-of-options", `${originalTarget}^{commit}`], { cwd }),
  ).trim();
  if (canonicalOriginal !== originalTarget) {
    throw new DeliveryError("artifact_mismatch", "rollback target differs from persisted commit");
  }

  git(["symbolic-ref", "HEAD", originalRef], { cwd });
  if (deliveryCommit !== null) {
    git(["reset", "--hard", deliveryCommit], { cwd });
  } else {
    restoreIndex(cwd, baseCommit);
  }

  const child = gitSafe(["rev-parse", "--verify", "--end-of-options", childRef], { cwd });
  if (child !== null && String(child).trim() === baseCommit) {
    git(["update-ref", "-d", childRef, baseCommit], { cwd });
  }

  const finalBranch = String(git(["symbolic-ref", "--short", "HEAD"], { cwd })).trim();
  const finalHead = String(git(["rev-parse", "HEAD"], { cwd })).trim();
  if (finalBranch !== originalBranch || finalHead !== originalTarget) {
    throw new DeliveryError("cleanup_failed", "continuation rollback did not restore the retained worktree");
  }
  return { worktreePath: normAbs(cwd), branch: originalBranch };
}

/**
 * Unified post-commit integrity gate. Checks:
 *   1. HEAD === candidateCommit
 *   2. parent of HEAD == canonicalBase
 *   3. exactly one commit in canonicalBase..HEAD
 *   4. HEAD^{tree} === expectedTree
 *   5. committed files exactly match inspected changedFiles
 *   6. commit message is exactly "wao-delivery: <runId>"
 *   7. author/committer identity is WAO process identity
 *   8. worktree is clean (porcelain v1 --untracked-files=all is empty)
 *
 * @param {string} cwd — worktree path
 * @param {string} candidateCommit — expected delivery commit hash
 * @param {string} canonicalBase — canonical full hash of base commit
 * @param {string} expectedTree — tree hash from write-tree
 * @param {string[]} changedFiles — inspected authorized changed files
 * @param {string} expectedMessage — exact commit message
 * @throws {DeliveryError} with deliveryCode="commit_integrity" on any check failure
 */
function verifyPostCommitIntegrity(cwd, candidateCommit, canonicalBase, expectedTree, changedFiles, expectedMessage) {
  // 1. HEAD must be at candidateCommit
  const head = String(git(["rev-parse", "HEAD"], { cwd })).trim();
  if (head !== candidateCommit) {
    throw new DeliveryError(
      "commit_integrity",
      `HEAD (${head}) is not candidate commit (${candidateCommit})`,
    );
  }

  // 2. Parent must be exactly baseCommit
  const parent = String(git(["rev-parse", "HEAD^"], { cwd })).trim();
  if (parent !== canonicalBase) {
    throw new DeliveryError(
      "commit_integrity",
      `delivery commit parent (${parent}) is not baseCommit (${canonicalBase})`,
    );
  }

  // 3. Exactly one commit in baseCommit..HEAD
  const count = Number(
    String(git(["rev-list", "--count", `${canonicalBase}..HEAD`], { cwd })).trim(),
  );
  if (count !== 1) {
    throw new DeliveryError(
      "commit_integrity",
      `expected exactly 1 commit in ${canonicalBase}..HEAD, got ${count}`,
    );
  }

  // 4. Tree hash must match expected (write-tree output)
  const committedTree = String(git(["rev-parse", "HEAD^{tree}"], { cwd })).trim();
  if (committedTree !== expectedTree) {
    throw new DeliveryError(
      "commit_integrity",
      `committed tree (${committedTree}) != expected tree (${expectedTree})`,
    );
  }

  // 5. Committed files must exactly equal inspected changedFiles
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

  // 6. Commit message must be exact
  const msg = String(git(["show", "-s", "--format=%B", "HEAD"], { cwd })).trim();
  if (msg !== expectedMessage) {
    throw new DeliveryError(
      "commit_integrity",
      `commit message (${JSON.stringify(msg)}) != expected (${JSON.stringify(expectedMessage)})`,
    );
  }

  // 7. Author/committer identity must be WAO process identity (SSOT: assertDeliveryIdentity)
  assertDeliveryIdentity(cwd, "commit_integrity");

  // 8. Worktree must be clean
  const porcelain = String(
    git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd }),
  );
  if (porcelain.trim().length > 0) {
    const dirtyPaths = parseNul(porcelain).join(", ");
    throw new DeliveryError(
      "commit_integrity",
      `worktree is dirty after commit: ${dirtyPaths}`,
    );
  }
}

// ===== Public API: packageDelivery =====

/**
 * Package an isolated Git delivery into exactly one reviewable commit.
 *
 * Uses Git plumbing (commit-tree + update-ref) to bypass ALL repository hooks.
 * Hooks belong to project verification policy, not mechanical packaging.
 *
 * Sequence:
 * 1. Re-run full inspection (inspectDelivery) — fail closed before touching anything.
 * 2. Stage exact inspected authorized changed files (`git add -A -- <files...>`).
 * 3. Re-read staged paths, require exact set equality with proposed changedFiles.
 * 4. Capture expected tree: `git write-tree`.
 * 5. Create commit object: `git commit-tree <expectedTree> -p <baseCommit>`
 *    with message via stdin, author/committer identity via process env.
 *    (No hooks run — plumbing commands bypass pre-commit/commit-msg/post-commit.)
 * 6. Atomic CAS update: `git update-ref refs/heads/<branch> <candidate> <baseCommit>`.
 *    If branch ref is not at baseCommit (concurrent change), update fails → branch
 *    does not move, candidate object becomes unreachable.
 * 7. Post-commit integrity gate: verify HEAD/parent/count/tree/files/message/
 *    identity/worktree-clean.
 *    On failure: rollback branch to base (git reset --mixed), preserve working-tree.
 * 8. Only return DeliveryRef when all checks pass.
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
  const baseCommit = proposed.baseCommit;
  const branchRef = `refs/heads/${proposed.branch}`;
  const expectedMessage = `wao-delivery: ${proposed.runId}`;

  // 2. Stage exact inspected authorized paths
  git(["add", "-A", "--", ...changedFiles], { cwd });

  // 3. Re-read staged paths and require exact set equality
  const staged = parseNul(git(["diff", "--name-only", "--cached", "-z"], { cwd }));
  const stagedSet = new Set(staged);
  const changedSet = new Set(changedFiles);
  if (stagedSet.size !== changedSet.size ||
      [...changedSet].some((p) => !stagedSet.has(p))) {
    restoreIndex(cwd, baseCommit);
    throw new DeliveryError(
      "staging_mismatch",
      `staged paths do not match inspected changedFiles; staged=[${staged.join(",")}] expected=[${changedFiles.join(",")}]`,
    );
  }

  // 4. Capture expected tree from the staged index
  const expectedTree = String(git(["write-tree"], { cwd })).trim();

  // 5. Create commit object via plumbing (no hooks execute)
  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: DELIVERY_IDENTITY.name,
    GIT_AUTHOR_EMAIL: DELIVERY_IDENTITY.email,
    GIT_COMMITTER_NAME: DELIVERY_IDENTITY.name,
    GIT_COMMITTER_EMAIL: DELIVERY_IDENTITY.email,
  };

  let candidateCommit;
  try {
    candidateCommit = String(
      git(["commit-tree", expectedTree, "-p", baseCommit], {
        cwd,
        env: commitEnv,
        input: expectedMessage + "\n",
      }),
    ).trim();
  } catch {
    // commit-tree failed — restore index, preserve working-tree
    restoreIndex(cwd, baseCommit);
    throw new DeliveryError(
      "commit_failed",
      `git commit-tree failed for runId=${proposed.runId}; index restored, working-tree preserved`,
    );
  }

  // 6. Atomic CAS update-ref: only move branch if it's still at baseCommit
  let updateRefOk = false;
  try {
    git(["update-ref", branchRef, candidateCommit, baseCommit], { cwd });
    updateRefOk = true;
  } catch {
    // CAS failed — branch did not move, candidate is unreachable
  }

  if (!updateRefOk) {
    // Branch did not move — restore index to match HEAD (still at base)
    restoreIndex(cwd, baseCommit);
    throw new DeliveryError(
      "commit_failed",
      `git update-ref CAS failed for ${branchRef}; branch not moved, candidate ${candidateCommit} is unreachable`,
    );
  }

  // 7. Post-commit integrity gate
  let integrityError = null;
  try {
    verifyPostCommitIntegrity(cwd, candidateCommit, baseCommit, expectedTree, changedFiles, expectedMessage);
  } catch (err) {
    integrityError = err;
  }

  if (integrityError) {
    const originalCode = integrityError.deliveryCode || "commit_integrity";
    const originalMessage = integrityError.message;
    try {
      rollbackToBase(cwd, baseCommit);
    } catch (cleanupErr) {
      throw new DeliveryError(
        "cleanup_failed",
        `integrity failure (${originalCode}: ${originalMessage}) AND rollback failed: ${cleanupErr.message}`,
      );
    }
    throw new DeliveryError(
      originalCode,
      `${originalMessage}; branch rolled back to base, working-tree contents preserved`,
    );
  }

  // 8. All checks passed — build and return committed DeliveryRef
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId: proposed.runId,
    baseCommit: proposed.baseCommit,
    deliveryCommit: candidateCommit,
    branch: proposed.branch,
    worktreePath: proposed.worktreePath,
    changedFiles: [...changedFiles].sort(),
    verification: proposed.verification,
    acceptance: { ...proposed.acceptance },
    integration: { ...proposed.integration },
  };
}

// ===== M12-1S2: model-free repackage resolution (package-or-recover) =====
//
// resolveDeliveryCommit is the deterministic, model-free entry point a repackage
// service calls to obtain the unique DeliveryRef for a retained disallowed_path
// failure. It NEVER calls a model, resumes a worker, or infers scope: it either
// packages fresh (HEAD at base) or recovers the SAME commit from Git exact
// objects (HEAD already past base — a previous package moved the branch but the
// transcript append failed/crashed). Because Git is content-addressed, the same
// inputs converge on the same commit, so "exactly one commit" is inherent.
//
// recoverDeliveryCommit strictly proves the existing HEAD commit against exact
// objects (parent/count/files/message/identity/branch/clean worktree) before
// rebuilding a DeliveryRef — no re-calling the model, no losing the result. The
// rebuilt ref's verification is the ORIGINAL declaration from the caller (the
// service passes run.started's value-for-value), never a caller override.

/**
 * Strictly prove an existing HEAD commit is the WAO delivery commit for this
 * runId and rebuild a DeliveryRef from it. Used when a previous packageDelivery
 * moved the branch to the delivery commit but the transcript append failed or
 * the process crashed (contract #6 recovery).
 *
 * Proves (all against the worktree's shared object database, explicit commit
 * args — never HEAD as a name): linked worktree on wao/<runId>; parent === base;
 * exactly one commit base..HEAD; committed files; exact message; WAO identity;
 * clean worktree. Throws on ANY proof failure — never trusts an unproven HEAD.
 *
 * @param {object} input — same shape as packageDelivery/inspectDelivery
 * @returns {object} committed DeliveryRef rebuilt from the exact commit
 * @throws {DeliveryError} on any proof failure
 */
function recoverDeliveryCommit(input) {
  const validated = validateInput(input);
  const cwd = validated.worktreePath;
  const expectedBranch = `wao/${validated.runId}`;

  // Canonicalize the persisted base (immutable literal — must resolve to itself).
  const canonicalBase = String(
    git(["rev-parse", "--verify", "--end-of-options", `${validated.baseCommit}^{commit}`], { cwd }),
  ).trim();
  if (canonicalBase !== validated.baseCommit) {
    throw new DeliveryError("artifact_mismatch", "resolved baseCommit differs from the persisted literal");
  }

  // HEAD must be a real commit PAST base (the interrupted package moved it).
  const head = String(git(["rev-parse", "HEAD"], { cwd })).trim();
  if (head === canonicalBase) {
    throw new DeliveryError(
      "recovery_unavailable",
      "HEAD is at baseCommit; nothing to recover",
    );
  }
  const canonicalHead = String(
    git(["rev-parse", "--verify", "--end-of-options", `${head}^{commit}`], { cwd }),
  ).trim();
  if (canonicalHead !== head) {
    throw new DeliveryError("artifact_mismatch", "HEAD does not resolve to a canonical commit object");
  }

  // Linked worktree on wao/<runId> (not primary, right branch).
  const toplevelRaw = gitSafe(["rev-parse", "--show-toplevel"], { cwd });
  if (toplevelRaw === null) {
    throw new DeliveryError("artifact_mismatch", "worktreePath is not a git repository");
  }
  if (normAbs(toplevelRaw.trim()) !== normAbs(cwd)) {
    throw new DeliveryError("artifact_mismatch", "git toplevel does not match worktreePath");
  }
  const gitDir = normAbs(String(git(["rev-parse", "--absolute-git-dir"], { cwd })).trim());
  let commonDirRaw = String(git(["rev-parse", "--git-common-dir"], { cwd })).trim();
  if (!isAbsolute(commonDirRaw)) commonDirRaw = resolve(cwd, commonDirRaw);
  if (gitDir === normAbs(commonDirRaw)) {
    throw new DeliveryError("artifact_mismatch", "worktree is primary checkout, not linked");
  }
  const branchRaw = gitSafe(["symbolic-ref", "--short", "HEAD"], { cwd });
  if (branchRaw === null) {
    throw new DeliveryError("artifact_mismatch", "HEAD is detached");
  }
  if (branchRaw.trim() !== expectedBranch) {
    throw new DeliveryError("artifact_mismatch", `HEAD on wrong branch: ${branchRaw.trim()} != ${expectedBranch}`);
  }

  // Parent must be exactly base.
  const parent = String(
    git(["rev-parse", "--verify", "--end-of-options", `${canonicalHead}^`], { cwd }),
  ).trim();
  if (parent !== canonicalBase) {
    throw new DeliveryError("artifact_mismatch", "recovered commit parent does not match baseCommit");
  }

  // Exactly one commit base..HEAD.
  const count = Number(
    String(git(["rev-list", "--count", `${canonicalBase}..${canonicalHead}`], { cwd })).trim(),
  );
  if (count !== 1) {
    throw new DeliveryError("artifact_mismatch", `expected 1 commit in base..HEAD, got ${count}`);
  }

  // Committed files (exact object query).
  const committedFiles = parseNul(
    git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", canonicalHead], { cwd }),
  ).sort();
  const disallowed = committedFiles.filter(
    (p) => !isPathAllowed(p, validated.allowedPaths),
  );
  if (disallowed.length > 0) {
    throw new DeliveryError(
      "disallowed_path",
      `recovered commit contains changes outside allowedPaths: ${disallowed.join(", ")}`,
    );
  }

  // Exact message.
  const msg = String(git(["show", "-s", "--format=%B", canonicalHead], { cwd })).trim();
  const expectedMessage = `wao-delivery: ${validated.runId}`;
  if (msg !== expectedMessage) {
    throw new DeliveryError("artifact_mismatch", "recovered commit message mismatch");
  }

  // WAO identity (SSOT, explicit commit).
  assertDeliveryIdentity(cwd, "artifact_mismatch", canonicalHead);

  // Clean worktree.
  const porcelain = String(git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd }));
  if (porcelain.trim().length > 0) {
    throw new DeliveryError("artifact_mismatch", "worktree is dirty during recovery");
  }

  // Rebuild the DeliveryRef from the exact commit. verification is the ORIGINAL
  // declaration (validated.verification) — reused value-for-value.
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId: validated.runId,
    baseCommit: canonicalBase,
    deliveryCommit: canonicalHead,
    branch: expectedBranch,
    worktreePath: normAbs(cwd),
    changedFiles: committedFiles,
    verification: validated.verification,
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
  };
}

/**
 * Resolve the unique delivery commit for a model-free repackage: package fresh
 * when HEAD is at base, or recover the existing commit when HEAD is already past
 * base (crash/concurrency convergence). Deterministic — same inputs always yield
 * the same commit. On a concurrent package race (update-ref CAS failure while
 * HEAD was at base), falls back to recovering the now-current HEAD instead of
 * erroring, so competing same-input requests converge on one commit.
 *
 * @param {object} input — same shape as packageDelivery/inspectDelivery
 * @returns {{ref: object, source: "packaged"|"recovered"}}
 * @throws {DeliveryError} on any packaging/proof failure
 */
export function resolveDeliveryCommit(input) {
  const validated = validateInput(input);
  const cwd = validated.worktreePath;

  const canonicalBase = String(
    git(["rev-parse", "--verify", "--end-of-options", `${validated.baseCommit}^{commit}`], { cwd }),
  ).trim();
  const head = String(git(["rev-parse", "HEAD"], { cwd })).trim();

  if (head === canonicalBase) {
    // Fresh package. The update-ref CAS makes a concurrent package fail; if HEAD
    // has since advanced, recover the winner's commit (deterministic convergence).
    try {
      const ref = packageDelivery(input);
      return { ref, source: "packaged" };
    } catch (err) {
      const headNow = String(git(["rev-parse", "HEAD"], { cwd })).trim();
      if (headNow !== canonicalBase) {
        return { ref: recoverDeliveryCommit(input), source: "recovered" };
      }
      throw err;
    }
  }
  // HEAD is past base — recover the existing exact delivery commit.
  return { ref: recoverDeliveryCommit(input), source: "recovered" };
}
