import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { inspectDelivery, packageDelivery, DeliveryError } from "../src/delivery.js";

// ===== Constants =====

const RUN_ID = "run_test0001";
const BRANCH = `wao/${RUN_ID}`;

// ===== Helpers =====

/** Create a temp git repo with initial structure. Returns { repo, baseCommit }. */
async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), "wao-deliv-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@test"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: dir, stdio: "ignore" });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.js"), "const a = 1;\n");
  await writeFile(join(dir, "src", "b.js"), "const b = 2;\n");
  await writeFile(join(dir, "README.md"), "# test\n");
  await writeFile(join(dir, ".gitignore"), "node_modules/\n*.env\nsecret/\n");
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
  const baseCommit = execSync("git rev-parse HEAD", {
    cwd: dir,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  return { repo: dir, baseCommit };
}

/** Create a linked worktree at wao/<runId>. */
function makeWorktree(repo, runId = RUN_ID) {
  const wtPath = join(repo, ".wao-worktrees", runId);
  execSync(`git worktree add "${wtPath}" -b wao/${runId}`, {
    cwd: repo,
    stdio: "ignore",
  });
  return wtPath;
}

/** Clean up temp repo with retry (Windows file lock resilience). */
async function cleanupRepo(repo) {
  try {
    execSync("git worktree prune", { cwd: repo, stdio: "ignore" });
  } catch { /* best effort */ }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(repo, { recursive: true, force: true });
      return;
    } catch {
      if (attempt === 4) return; // best effort — don't mask test failures
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

/** Build a valid base input, allowing overrides. */
function baseInput(worktreePath, baseCommit, overrides = {}) {
  return {
    runId: RUN_ID,
    worktreePath,
    baseCommit,
    allowedPaths: ["src"],
    isolation: { type: "worktree", strategy: "persistent" },
    verificationCommands: ["npm test"],
    ...overrides,
  };
}

/** Assert that a delivery call throws with a specific deliveryCode. */
function assertDeliveryError(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(
      err.deliveryCode,
      code,
      `expected deliveryCode=${code}, got ${err.deliveryCode}: ${err.message}`,
    );
    return true;
  });
}

const norm = (p) => p.replace(/\\/g, "/");

// ===== 2A Tests: Happy path inspection =====

test("2A-01: inspectDelivery returns proposed DeliveryRef for one allowed modified tracked file", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "const a = 2;\n");
    const ref = inspectDelivery(baseInput(wtPath, baseCommit));
    assert.equal(ref.schemaVersion, 1);
    assert.equal(ref.kind, "git_commit");
    assert.equal(ref.runId, RUN_ID);
    assert.equal(ref.baseCommit, baseCommit);
    assert.equal(ref.deliveryCommit, null);
    assert.equal(ref.branch, BRANCH);
    assert.deepEqual(ref.changedFiles, ["src/a.js"]);
    assert.equal(ref.verification.status, "pending");
    assert.deepEqual(ref.verification.commands, ["npm test"]);
    assert.equal(ref.acceptance.status, "pending");
    assert.equal(ref.acceptance.reviewerType, "lead_agent");
    assert.equal(ref.integration.status, "pending");
    assert.equal(ref.integration.targetCommit, null);
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-02: inspectDelivery includes allowed untracked non-ignored file", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "new.js"), "export const x = 1;\n");
    const ref = inspectDelivery(baseInput(wtPath, baseCommit));
    assert.ok(ref.changedFiles.includes("src/new.js"));
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-03: modified + deleted + untracked produce sorted unique changedFiles", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    // modify a.js, delete b.js, create c.js (untracked)
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    await rm(join(wtPath, "src", "b.js"));
    await writeFile(join(wtPath, "src", "c.js"), "new\n");
    const ref = inspectDelivery(baseInput(wtPath, baseCommit));
    assert.deepEqual(ref.changedFiles, ["src/a.js", "src/b.js", "src/c.js"]);
  } finally {
    await cleanupRepo(repo);
  }
});

// ===== 2A Tests: Disallowed paths =====

test("2A-04: disallowed modified tracked file fails closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "README.md"), "# changed\n");
    assertDeliveryError(
      () => inspectDelivery(baseInput(wtPath, baseCommit)),
      "disallowed_path",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-05: disallowed untracked file fails closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    // Allowed change + disallowed untracked
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    await mkdir(join(wtPath, "other"), { recursive: true });
    await writeFile(join(wtPath, "other", "hack.js"), "bad\n");
    assertDeliveryError(
      () => inspectDelivery(baseInput(wtPath, baseCommit)),
      "disallowed_path",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-06: ignored untracked file is not included in delivery content", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    // Allowed change
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    // Ignored file (*.env in .gitignore)
    await writeFile(join(wtPath, "src", "secret.env"), "KEY=123\n");
    const ref = inspectDelivery(baseInput(wtPath, baseCommit));
    assert.ok(!ref.changedFiles.includes("src/secret.env"));
    assert.ok(ref.changedFiles.includes("src/a.js"));
  } finally {
    await cleanupRepo(repo);
  }
});

// ===== 2A Tests: Fail-closed conditions =====

test("2A-07: empty diff fails closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    assertDeliveryError(
      () => inspectDelivery(baseInput(wtPath, baseCommit)),
      "empty_diff",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-08: non-Git path fails closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-notgit-"));
  try {
    assertDeliveryError(
      () => inspectDelivery(baseInput(dir, "0".repeat(40))),
      "not_a_git_repo",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("2A-09: primary checkout fails as non-isolated", async () => {
  const { repo, baseCommit } = await makeRepo();
  try {
    // The primary checkout is on main. To isolate the primary-checkout test
    // from the wrong-branch check, put the primary worktree on wao/<runId>
    // so the only failure is "this is the main checkout, not a linked one".
    execSync(`git checkout -b ${BRANCH}`, { cwd: repo, stdio: "ignore" });
    await writeFile(join(repo, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () => inspectDelivery(baseInput(repo, baseCommit)),
      "primary_checkout",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

// ===== 2A Tests: Isolation validation =====

test("2A-10: isolation strategy ephemeral fails closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () =>
        inspectDelivery(
          baseInput(wtPath, baseCommit, {
            isolation: { type: "worktree", strategy: "ephemeral" },
          }),
        ),
      "invalid_isolation",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-11: isolation type none fails closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () =>
        inspectDelivery(
          baseInput(wtPath, baseCommit, {
            isolation: { type: "none", strategy: "persistent" },
          }),
        ),
      "invalid_isolation",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-12: missing isolation fails closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const input = baseInput(wtPath, baseCommit);
    delete input.isolation;
    assertDeliveryError(() => inspectDelivery(input), "invalid_isolation");
  } finally {
    await cleanupRepo(repo);
  }
});

// ===== 2A Tests: Git state validation =====

test("2A-13: detached HEAD fails closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    execSync("git checkout --detach", { cwd: wtPath, stdio: "ignore" });
    assertDeliveryError(
      () => inspectDelivery(baseInput(wtPath, baseCommit)),
      "detached_head",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-14: wrong branch fails closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = join(repo, ".wao-worktrees", "other");
  execSync(`git worktree add "${wtPath}" -b wao/wrong_branch`, {
    cwd: repo,
    stdio: "ignore",
  });
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () => inspectDelivery(baseInput(wtPath, baseCommit)),
      "wrong_branch",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-15: base commit mismatch fails closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    // Advance worktree HEAD past base
    await writeFile(join(wtPath, "src", "new.js"), "new\n");
    execSync("git add .", { cwd: wtPath, stdio: "ignore" });
    execSync('git commit -m "advance"', { cwd: wtPath, stdio: "ignore" });
    assertDeliveryError(
      () => inspectDelivery(baseInput(wtPath, baseCommit)),
      "base_commit_mismatch",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-16: pre-staged worker changes fail closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    execSync("git add src/a.js", { cwd: wtPath, stdio: "ignore" });
    assertDeliveryError(
      () => inspectDelivery(baseInput(wtPath, baseCommit)),
      "pre_staged_changes",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

// ===== 2A Tests: allowedPaths validation =====

test("2A-17a: invalid allowedPath — path traversal fails closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () =>
        inspectDelivery(
          baseInput(wtPath, baseCommit, { allowedPaths: ["../evil"] }),
        ),
      "invalid_allowed_paths",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-17b: invalid allowedPath — absolute Windows path fails closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () =>
        inspectDelivery(
          baseInput(wtPath, baseCommit, { allowedPaths: ["C:/evil"] }),
        ),
      "invalid_allowed_paths",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-17c: invalid allowedPath — rooted slash fails closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () =>
        inspectDelivery(
          baseInput(wtPath, baseCommit, { allowedPaths: ["/evil"] }),
        ),
      "invalid_allowed_paths",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-17d: invalid allowedPath — empty string fails closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () =>
        inspectDelivery(
          baseInput(wtPath, baseCommit, { allowedPaths: [""] }),
        ),
      "invalid_allowed_paths",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-17e: invalid allowedPath — dot fails closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () =>
        inspectDelivery(
          baseInput(wtPath, baseCommit, { allowedPaths: ["."] }),
        ),
      "invalid_allowed_paths",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-17f: invalid allowedPath — NUL byte fails closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () =>
        inspectDelivery(
          baseInput(wtPath, baseCommit, { allowedPaths: ["foo\0bar"] }),
        ),
      "invalid_allowed_paths",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-17g: empty allowedPaths array fails closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () =>
        inspectDelivery(
          baseInput(wtPath, baseCommit, { allowedPaths: [] }),
        ),
      "invalid_allowed_paths",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-18: path-segment boundary — src accepts src/a.js but rejects src2/a.js", async () => {
  const { repo, baseCommit } = await makeRepo();
  // Positive: src/a.js under allowed "src"
  const wt1 = makeWorktree(repo, RUN_ID);
  try {
    await writeFile(join(wt1, "src", "a.js"), "modified\n");
    const ref = inspectDelivery(baseInput(wt1, baseCommit));
    assert.deepEqual(ref.changedFiles, ["src/a.js"]);
  } finally {
    await cleanupRepo(repo);
  }

  // Negative: src2/a.js not under allowed "src"
  const { repo: repo2, baseCommit: base2 } = await makeRepo();
  const wt2 = makeWorktree(repo2, RUN_ID);
  try {
    await mkdir(join(wt2, "src2"), { recursive: true });
    await writeFile(join(wt2, "src2", "a.js"), "sneaky\n");
    await writeFile(join(wt2, "src", "a.js"), "legit\n");
    assertDeliveryError(
      () => inspectDelivery(baseInput(wt2, base2)),
      "disallowed_path",
    );
  } finally {
    await cleanupRepo(repo2);
  }
});

// ===== 2A Tests: Special cases =====

test("2A-19: allowed path and changed filename containing spaces work", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "my file.js"), "spaced\n");
    const ref = inspectDelivery(baseInput(wtPath, baseCommit));
    assert.ok(ref.changedFiles.includes("src/my file.js"));
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-20: missing verification commands and missing reason fail closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const input = baseInput(wtPath, baseCommit);
    delete input.verificationCommands;
    assertDeliveryError(() => inspectDelivery(input), "invalid_verification");
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-20b: verification unavailable reason is accepted", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = inspectDelivery(
      baseInput(wtPath, baseCommit, {
        verificationCommands: undefined,
        verificationUnavailableReason: "no test suite",
      }),
    );
    assert.deepEqual(ref.verification.commands, []);
    assert.equal(ref.verification.unavailableReason, "no test suite");
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-21: inspection is read-only — HEAD, branch, index, working tree unchanged", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");

    // Capture state before
    const headBefore = execSync("git rev-parse HEAD", {
      cwd: wtPath, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const branchBefore = execSync("git symbolic-ref --short HEAD", {
      cwd: wtPath, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const stagedBefore = execSync("git diff --name-only --cached", {
      cwd: wtPath, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    inspectDelivery(baseInput(wtPath, baseCommit));

    // Capture state after
    const headAfter = execSync("git rev-parse HEAD", {
      cwd: wtPath, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const branchAfter = execSync("git symbolic-ref --short HEAD", {
      cwd: wtPath, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const stagedAfter = execSync("git diff --name-only --cached", {
      cwd: wtPath, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    assert.equal(headAfter, headBefore, "HEAD must not change");
    assert.equal(branchAfter, branchBefore, "branch must not change");
    assert.equal(stagedAfter, stagedBefore, "index must not change");

    // Working tree content intact
    const content = await readFile(join(wtPath, "src", "a.js"), "utf8");
    assert.equal(content, "modified\n");

    // Source checkout HEAD unchanged
    const mainHead = execSync("git rev-parse HEAD", {
      cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    assert.equal(mainHead, baseCommit, "source checkout must not move");
  } finally {
    await cleanupRepo(repo);
  }
});

test("2A-22: DeliveryRef has exact v1 defaults and canonical full hashes", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = inspectDelivery(baseInput(wtPath, baseCommit));

    // Canonical full hash: 40 hex chars
    assert.match(ref.baseCommit, /^[0-9a-f]{40}$/);
    assert.equal(ref.baseCommit, baseCommit);
    assert.equal(ref.deliveryCommit, null);
    assert.equal(ref.schemaVersion, 1);
    assert.equal(ref.kind, "git_commit");
    assert.equal(ref.branch, BRANCH);
    assert.deepEqual(ref.verification, {
      status: "pending",
      commands: ["npm test"],
    });
    assert.deepEqual(ref.acceptance, {
      status: "pending",
      reviewerType: "lead_agent",
    });
    assert.deepEqual(ref.integration, {
      status: "pending",
      targetCommit: null,
    });
  } finally {
    await cleanupRepo(repo);
  }
});

// ===== 2A Tests: Invalid runId =====

test("2A-23: invalid runId with slash fails closed", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () =>
        inspectDelivery(
          baseInput(wtPath, baseCommit, { runId: "run_evil/../path" }),
        ),
      "invalid_run_id",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

// ===== 2B Tests: packageDelivery =====

// Helper: get full HEAD hash of a worktree
function getHead(cwd) {
  return execSync("git rev-parse HEAD", {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
}

// Helper: get repo-local user.name/user.email
function getRepoIdentity(cwd) {
  const name = execSync("git config user.name", {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  const email = execSync("git config user.email", {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  return { name, email };
}

// Helper: list files in a commit (sorted)
function commitFiles(cwd, commit) {
  const out = execSync(`git diff-tree --no-commit-id --name-only -r -z ${commit}`, {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  });
  return out.split("\0").filter((s) => s.length > 0).sort();
}

// Helper: get commit author + committer as "Name <email>"
function commitIdentity(cwd, commit) {
  const authorName = execSync(
    `git show -s --format=%an ${commit}`,
    { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
  ).trim();
  const authorEmail = execSync(
    `git show -s --format=%ae ${commit}`,
    { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
  ).trim();
  const committerName = execSync(
    `git show -s --format=%cn ${commit}`,
    { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
  ).trim();
  const committerEmail = execSync(
    `git show -s --format=%ce ${commit}`,
    { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
  ).trim();
  return {
    author: `${authorName} <${authorEmail}>`,
    committer: `${committerName} <${committerEmail}>`,
  };
}

// Helper: rev-count between two commits
function revCount(cwd, from, to) {
  return Number(
    execSync(`git rev-list --count ${from}..${to}`, {
      cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim(),
  );
}

// Helper: get parent of a commit (use ~1, not ^ — caret is cmd.exe escape char)
function parentHash(cwd, commit) {
  return execSync(`git rev-parse ${commit}~1`, {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
}

// Helper: get commit message (subject only)
function commitMessage(cwd, commit) {
  return execSync(`git show -s --format=%s ${commit}`, {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
}

// Helper: get current branch of HEAD
function currentBranch(cwd) {
  return execSync("git symbolic-ref --short HEAD", {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
}

test("2B-01: packageDelivery creates one commit for allowed tracked + deleted + untracked files", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    await rm(join(wtPath, "src", "b.js"));
    await writeFile(join(wtPath, "src", "c.js"), "new\n");

    const ref = packageDelivery(baseInput(wtPath, baseCommit));
    assert.ok(ref.deliveryCommit, "deliveryCommit must be set");
    assert.match(ref.deliveryCommit, /^[0-9a-f]{40}$/);

    // Exactly one commit in baseCommit..deliveryCommit
    assert.equal(revCount(wtPath, baseCommit, ref.deliveryCommit), 1);
    // Files match inspected changedFiles
    assert.deepEqual(
      commitFiles(wtPath, ref.deliveryCommit),
      ["src/a.js", "src/b.js", "src/c.js"],
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2B-02: commit message is exactly 'wao-delivery: <runId>'", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = packageDelivery(baseInput(wtPath, baseCommit));
    assert.equal(commitMessage(wtPath, ref.deliveryCommit), `wao-delivery: ${RUN_ID}`);
  } finally {
    await cleanupRepo(repo);
  }
});

test("2B-03: parent is exactly base commit and rev-count is exactly one", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = packageDelivery(baseInput(wtPath, baseCommit));
    assert.equal(parentHash(wtPath, ref.deliveryCommit), baseCommit);
    assert.equal(revCount(wtPath, baseCommit, ref.deliveryCommit), 1);
  } finally {
    await cleanupRepo(repo);
  }
});

test("2B-04: commit contains only sorted authorized changed files", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "m\n");
    await writeFile(join(wtPath, "src", "new.js"), "n\n");
    const ref = packageDelivery(baseInput(wtPath, baseCommit));
    assert.deepEqual(commitFiles(wtPath, ref.deliveryCommit), ["src/a.js", "src/new.js"]);
    assert.deepEqual(ref.changedFiles, ["src/a.js", "src/new.js"]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("2B-05: source checkout HEAD/branch/status remain unchanged", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    const sourceHeadBefore = getHead(repo);
    const sourceBranchBefore = currentBranch(repo);
    const sourceStatus = execSync("git status --porcelain", {
      cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    packageDelivery(baseInput(wtPath, baseCommit));

    assert.equal(getHead(repo), sourceHeadBefore, "source HEAD must not move");
    assert.equal(currentBranch(repo), sourceBranchBefore, "source branch must not change");
    const sourceStatusAfter = execSync("git status --porcelain", {
      cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    assert.equal(sourceStatusAfter, sourceStatus, "source status must not change");
  } finally {
    await cleanupRepo(repo);
  }
});

test("2B-06: delivery worktree HEAD advances to delivery commit and is clean", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = packageDelivery(baseInput(wtPath, baseCommit));

    assert.equal(getHead(wtPath), ref.deliveryCommit, "worktree HEAD must be delivery commit");
    assert.equal(currentBranch(wtPath), BRANCH, "worktree branch must remain wao/<runId>");
    const status = execSync("git status --porcelain", {
      cwd: wtPath, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    assert.equal(status, "", "worktree must be clean after packaging");
  } finally {
    await cleanupRepo(repo);
  }
});

test("2B-07: returned DeliveryRef fills deliveryCommit and preserves pending lifecycle", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = packageDelivery(baseInput(wtPath, baseCommit));

    assert.match(ref.deliveryCommit, /^[0-9a-f]{40}$/);
    assert.equal(ref.baseCommit, baseCommit);
    assert.equal(ref.branch, BRANCH);
    assert.deepEqual(ref.verification, { status: "pending", commands: ["npm test"] });
    assert.deepEqual(ref.acceptance, { status: "pending", reviewerType: "lead_agent" });
    assert.deepEqual(ref.integration, { status: "pending", targetCommit: null });
  } finally {
    await cleanupRepo(repo);
  }
});

test("2B-08: repository-local user.name and user.email are byte-for-byte unchanged", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    const before = getRepoIdentity(wtPath);
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    packageDelivery(baseInput(wtPath, baseCommit));
    const after = getRepoIdentity(wtPath);
    assert.equal(after.name, before.name);
    assert.equal(after.email, before.email);
  } finally {
    await cleanupRepo(repo);
  }
});

test("2B-09: commit author/committer are the WAO process-scoped identity", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = packageDelivery(baseInput(wtPath, baseCommit));
    const identity = commitIdentity(wtPath, ref.deliveryCommit);
    assert.equal(identity.author, "WAO Delivery <wao-delivery@local>");
    assert.equal(identity.committer, "WAO Delivery <wao-delivery@local>");
  } finally {
    await cleanupRepo(repo);
  }
});

test("2B-10: spaces in paths are committed correctly without shell quoting tricks", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "my file.js"), "spaced content\n");
    const ref = packageDelivery(baseInput(wtPath, baseCommit));
    assert.ok(ref.changedFiles.includes("src/my file.js"));
    assert.deepEqual(commitFiles(wtPath, ref.deliveryCommit), ["src/my file.js"]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("2B-11: empty diff and disallowed paths fail before staging/commit", async () => {
  // Empty diff
  const { repo, baseCommit } = await makeRepo();
  const wt1 = makeWorktree(repo);
  try {
    assertDeliveryError(
      () => packageDelivery(baseInput(wt1, baseCommit)),
      "empty_diff",
    );
    // No commit created
    assert.equal(getHead(wt1), baseCommit);
  } finally {
    await cleanupRepo(repo);
  }

  // Disallowed path
  const { repo: repo2, baseCommit: base2 } = await makeRepo();
  const wt2 = makeWorktree(repo2);
  try {
    await writeFile(join(wt2, "README.md"), "# changed\n");
    assertDeliveryError(
      () => packageDelivery(baseInput(wt2, base2)),
      "disallowed_path",
    );
    assert.equal(getHead(wt2), base2);
  } finally {
    await cleanupRepo(repo2);
  }
});

test("2B-12: rejecting pre-commit hook makes packaging fail", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");

    // Install a rejecting pre-commit hook in the main repo (shared by linked worktree)
    const hookDir = join(repo, ".git", "hooks");
    await mkdir(hookDir, { recursive: true });
    const hookPath = join(hookDir, "pre-commit");
    await writeFile(
      hookPath,
      "#!/bin/sh\necho 'rejected by test hook' >&2\nexit 1\n",
    );
    // Make hook executable (chmod may not matter on Windows but set anyway)
    try { execSync(`chmod +x "${hookPath}"`, { stdio: "ignore" }); } catch { /* best effort */ }

    assertDeliveryError(
      () => packageDelivery(baseInput(wtPath, baseCommit)),
      "commit_failed",
    );

    // Branch HEAD remains at base
    assert.equal(getHead(wtPath), baseCommit, "HEAD must remain at base after hook rejection");
  } finally {
    await cleanupRepo(repo);
  }
});

test("2B-13: after commit failure, branch HEAD remains at base, index restored, worker file contents remain present", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "worker modified\n");
    await writeFile(join(wtPath, "src", "new.js"), "worker new\n");

    // Install rejecting hook
    const hookDir = join(repo, ".git", "hooks");
    await mkdir(hookDir, { recursive: true });
    const hookPath = join(hookDir, "pre-commit");
    await writeFile(hookPath, "#!/bin/sh\nexit 1\n");
    try { execSync(`chmod +x "${hookPath}"`, { stdio: "ignore" }); } catch { /* best effort */ }

    assertDeliveryError(
      () => packageDelivery(baseInput(wtPath, baseCommit)),
      "commit_failed",
    );

    // HEAD at base
    assert.equal(getHead(wtPath), baseCommit);
    // Index clean (no staged changes — packager unstaged its own staging)
    const staged = execSync("git diff --name-only --cached", {
      cwd: wtPath, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    assert.equal(staged, "", "index must be restored to clean after commit failure");

    // Worker file contents remain present (not reset/discarded)
    const aContent = await readFile(join(wtPath, "src", "a.js"), "utf8");
    assert.equal(aContent, "worker modified\n", "worker content must survive commit failure");
    const newContent = await readFile(join(wtPath, "src", "new.js"), "utf8");
    assert.equal(newContent, "worker new\n", "worker content must survive commit failure");
  } finally {
    await cleanupRepo(repo);
  }
});

test("2B-14: repeated packaging with the same base fails closed rather than creating a second commit", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref1 = packageDelivery(baseInput(wtPath, baseCommit));

    // HEAD is now at delivery commit, not base — second package should fail
    assertDeliveryError(
      () => packageDelivery(baseInput(wtPath, baseCommit)),
      "base_commit_mismatch",
    );
    // Still only one commit
    assert.equal(revCount(wtPath, baseCommit, ref1.deliveryCommit), 1);
  } finally {
    await cleanupRepo(repo);
  }
});

test("2B-15: packaging never pushes and creates no remote refs", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    // Add a remote (bare) to verify no push happens
    const bareDir = await mkdtemp(join(tmpdir(), "wao-bare-"));
    execSync(`git init --bare "${bareDir}"`, { stdio: "ignore" });
    execSync(`git remote add origin "${bareDir}"`, { cwd: repo, stdio: "ignore" });

    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    packageDelivery(baseInput(wtPath, baseCommit));

    // Remote should have no refs
    const remoteBranches = execSync("git branch -r", {
      cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    assert.equal(remoteBranches, "", "no remote refs should exist");

    // Clean up bare repo
    await rm(bareDir, { recursive: true, force: true });
  } finally {
    await cleanupRepo(repo);
  }
});

// Helper: get porcelain status (tracked + untracked non-ignored), NUL-delimited
function porcelainStatus(cwd) {
  return execSync("git status --porcelain -z", {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
}

// Helper: get porcelain v1 with untracked-files=all, NUL-delimited
function porcelainAll(cwd) {
  return execSync("git status --porcelain=v1 -z --untracked-files=all", {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
}

// Helper: check if a commit hash is reachable from a branch
function isReachable(cwd, commit, fromRef) {
  try {
    execSync(`git merge-base --is-ancestor ${commit} ${fromRef}`, {
      cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

// Helper: list all commits reachable from a ref (one per line)
function reachableCommits(cwd, fromRef) {
  return execSync(`git rev-list ${fromRef}`, {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim().split(/\s+/).filter(Boolean);
}

// Helper: get cached (staged) diff file list
function cachedDiff(cwd) {
  return execSync("git diff --name-only --cached", {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
}

// ===== 2C Tests: Post-commit integrity gate + hook mutation rollback =====

test("2C-01: hook stages disallowed file + exit 0 → packageDelivery must fail-closed and rollback", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    // Legitimate worker change
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");

    // Install a malicious pre-commit hook: creates + stages evil.txt, then exits 0
    const hookDir = join(repo, ".git", "hooks");
    await mkdir(hookDir, { recursive: true });
    const hookPath = join(hookDir, "pre-commit");
    await writeFile(
      hookPath,
      "#!/bin/sh\necho 'evil' > evil.txt\ngit add evil.txt\nexit 0\n",
    );
    try { execSync(`chmod +x "${hookPath}"`, { stdio: "ignore" }); } catch { /* best effort */ }

    // packageDelivery must throw (fail-closed)
    assertDeliveryError(
      () => packageDelivery(baseInput(wtPath, baseCommit)),
      "commit_integrity",
    );

    // branch HEAD must be back at baseCommit
    assert.equal(getHead(wtPath), baseCommit, "HEAD must be rolled back to base");

    // index must be clean
    assert.equal(cachedDiff(wtPath), "", "index must be empty after rollback");

    // worker change must be preserved in working tree
    const aContent = await readFile(join(wtPath, "src", "a.js"), "utf8");
    assert.equal(aContent, "modified\n", "worker content must survive rollback");

    // hook-generated file must be preserved in working tree (not cleaned)
    const evilContent = await readFile(join(wtPath, "evil.txt"), "utf8");
    assert.equal(evilContent, "evil\n", "hook-generated file must survive rollback");

    // no reachable delivery commit on the branch (branch HEAD = base)
    const commits = reachableCommits(wtPath, BRANCH);
    assert.ok(
      !commits.some((c) => c !== baseCommit),
      "branch must not have any reachable commit beyond base",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2C-02: hook creates unstaged disallowed file + exit 0 → must detect dirty worktree and rollback", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");

    // Hook creates evil.txt but does NOT stage it, exits 0
    const hookDir = join(repo, ".git", "hooks");
    await mkdir(hookDir, { recursive: true });
    const hookPath = join(hookDir, "pre-commit");
    await writeFile(
      hookPath,
      "#!/bin/sh\necho 'evil' > evil.txt\nexit 0\n",
    );
    try { execSync(`chmod +x "${hookPath}"`, { stdio: "ignore" }); } catch { /* best effort */ }

    // Must fail-closed — worktree is dirty after commit
    assertDeliveryError(
      () => packageDelivery(baseInput(wtPath, baseCommit)),
      "commit_integrity",
    );

    // HEAD back at base
    assert.equal(getHead(wtPath), baseCommit, "HEAD must be rolled back to base");

    // Index clean
    assert.equal(cachedDiff(wtPath), "", "index must be empty after rollback");

    // Worker content preserved
    const aContent = await readFile(join(wtPath, "src", "a.js"), "utf8");
    assert.equal(aContent, "modified\n", "worker content must survive rollback");

    // Hook-generated file preserved
    const evilContent = await readFile(join(wtPath, "evil.txt"), "utf8");
    assert.equal(evilContent, "evil\n", "hook-generated file must survive rollback");

    // No reachable delivery commit
    const commits = reachableCommits(wtPath, BRANCH);
    assert.ok(
      !commits.some((c) => c !== baseCommit),
      "branch must not have any reachable commit beyond base",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2C-03: normal success path — worktree must be clean (tracked + untracked non-ignored) after packaging", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    await writeFile(join(wtPath, "src", "new.js"), "new\n");
    const ref = packageDelivery(baseInput(wtPath, baseCommit));

    // HEAD at delivery commit
    assert.equal(getHead(wtPath), ref.deliveryCommit);

    // porcelain status must be empty (tracked + untracked non-ignored)
    assert.equal(porcelainStatus(wtPath), "", "worktree must be clean after success");
  } finally {
    await cleanupRepo(repo);
  }
});

test("2C-04: ignored files do not affect success — porcelain non-ignored is clean", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    // Create an ignored file (*.env pattern in .gitignore)
    await writeFile(join(wtPath, "src", "secret.env"), "KEY=123\n");
    const ref = packageDelivery(baseInput(wtPath, baseCommit));

    assert.equal(getHead(wtPath), ref.deliveryCommit);
    // Non-ignored porcelain must be clean
    assert.equal(porcelainStatus(wtPath), "", "ignored files must not block success");
    // porcelain with --untracked-files=all shows ignored? No — porcelain doesn't show ignored.
    // But the ignored file should not appear in changedFiles
    assert.ok(!ref.changedFiles.includes("src/secret.env"));
  } finally {
    await cleanupRepo(repo);
  }
});

// ===== 2C Tests: Input boundary hardening =====

test("2C-05: baseCommit starting with '--' must not be interpreted as a git option", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () =>
        inspectDelivery(
          baseInput(wtPath, baseCommit, { baseCommit: "--evil" }),
        ),
      "invalid_base_commit",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2C-06: verificationCommands with only whitespace must be rejected", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () =>
        inspectDelivery(
          baseInput(wtPath, baseCommit, { verificationCommands: ["   "] }),
        ),
      "invalid_verification",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2C-07: verificationUnavailableReason with only whitespace must be rejected", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () =>
        inspectDelivery(
          baseInput(wtPath, baseCommit, {
            verificationCommands: undefined,
            verificationUnavailableReason: "   ",
          }),
        ),
      "invalid_verification",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2C-08: allowedPaths with empty segment must be rejected", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () =>
        inspectDelivery(
          baseInput(wtPath, baseCommit, { allowedPaths: ["src//a.js"] }),
        ),
      "invalid_allowed_paths",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2C-09: allowedPaths with trailing slash must be rejected", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () =>
        inspectDelivery(
          baseInput(wtPath, baseCommit, { allowedPaths: ["src/"] }),
        ),
      "invalid_allowed_paths",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2C-10: allowedPaths with leading slash (rooted) must be rejected", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    assertDeliveryError(
      () =>
        inspectDelivery(
          baseInput(wtPath, baseCommit, { allowedPaths: ["/src"] }),
        ),
      "invalid_allowed_paths",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("2C-11: legal paths with normal spaces still work after hardening", async () => {
  const { repo, baseCommit } = await makeRepo();
  const wtPath = makeWorktree(repo);
  try {
    await writeFile(join(wtPath, "src", "my file.js"), "spaced\n");
    const ref = inspectDelivery(baseInput(wtPath, baseCommit));
    assert.ok(ref.changedFiles.includes("src/my file.js"));
  } finally {
    await cleanupRepo(repo);
  }
});

// Helper for reading file content in sync test
import { readFile } from "node:fs/promises";
