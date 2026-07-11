import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { inspectDelivery } from "../src/delivery.js";

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

// Helper for reading file content in sync test
import { readFile } from "node:fs/promises";
