// test/m12-7-continuationWorktree.test.js
//
// M12-7: retained-worktree transition for a Lead-authorized correction
// continuation. Exercises the real Git mechanics in delivery.js
// (prepareContinuationWorktree) against temporary repositories.
//
// Contract:
//   - Committed parent: mechanically restore the SAME retained worktree to the
//     persisted base, preserving the parent delivery commit's tree as UNSTAGED
//     working changes; the parent commit must remain reviewable by SHA.
//   - Packaging/backend-failed (no commit) parent: preserve the retained
//     uncommitted candidate AS-IS after proving the persisted base.
//   - Crash-safe/idempotent: a repeated request converges on the same end state
//     and never destroys the parent commit or discards candidate bytes.
//   - Drift / missing / malformed: fail closed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareContinuationWorktree, DeliveryError } from "../../src/delivery.js";

function git(args, cwd) {
  return String(execSync("git " + args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })).trim();
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "wao-m127-wt-"));
  git("init -b main", repo);
  git('config user.email t@t.com', repo);
  git('config user.name T', repo);
  writeFileSync(join(repo, "README.md"), "# base\n", "utf8");
  writeFileSync(join(repo, "keep.txt"), "keep\n", "utf8");
  git("add -A", repo);
  git("commit -m base", repo);
  return repo;
}

function addWorktree(repo, runId) {
  const wt = join(repo, ".wao-worktrees", runId);
  git(`worktree add -b wao/${runId} "${wt}"`, repo);
  return wt;
}

test("M12-7-WT-01: committed parent unpacks to base with delivery tree as UNSTAGED working changes", () => {
  const repo = makeRepo();
  const parentRunId = "run_parent_20260801";
  const childRunId = "run_child_20260801";
  const wt = addWorktree(repo, parentRunId);
  try {
    const base = git("rev-parse HEAD", repo);
    // Parent delivery: modify an allowed file + add a new file, commit on the worktree.
    writeFileSync(join(wt, "keep.txt"), "keep-changed\n", "utf8");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src/new.js"), "new();\n", "utf8");
    git("add -A", wt);
    git("commit -m delivery", wt);
    const deliveryCommit = git("rev-parse HEAD", wt);

    const res = prepareContinuationWorktree(wt, {
      parentRunId, childRunId, baseCommit: base, deliveryCommit,
    });

    // Now on the CHILD branch at base.
    assert.equal(res.branch, `wao/${childRunId}`);
    assert.equal(git("symbolic-ref --short HEAD", wt), `wao/${childRunId}`);
    assert.equal(git("rev-parse HEAD", wt), base, "HEAD restored to persisted base");

    // The delivery tree is preserved as UNSTAGED working changes against base.
    const status = git("status --porcelain=v1 --untracked-files=all", wt);
    assert.match(status, /keep\.txt/);
    assert.match(status, /src\/new\.js/);
    // Nothing staged (index is clean at base).
    assert.equal(git("diff --name-only --cached", wt), "", "index clean (nothing staged)");

    // Parent commit object remains reviewable by exact SHA.
    assert.equal(git(`rev-parse ${deliveryCommit}`, wt), deliveryCommit, "parent commit still resolves");
    assert.doesNotThrow(() => git(`cat-file -e ${deliveryCommit}`, wt), "parent commit object exists");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("M12-7-WT-02: idempotent re-run converges and never destroys the parent commit", () => {
  const repo = makeRepo();
  const parentRunId = "run_parent_20260801b";
  const wt = addWorktree(repo, parentRunId);
  try {
    const base = git("rev-parse HEAD", repo);
    writeFileSync(join(wt, "keep.txt"), "keep-changed\n", "utf8");
    git("add -A", wt);
    git("commit -m delivery", wt);
    const deliveryCommit = git("rev-parse HEAD", wt);

    prepareContinuationWorktree(wt, { parentRunId, childRunId: "run_child_a", baseCommit: base, deliveryCommit });
    // A second transition (new child id, simulating a retried request) must
    // converge on the same end state without losing the delivery tree or the parent commit.
    prepareContinuationWorktree(wt, { parentRunId, childRunId: "run_child_b", baseCommit: base, deliveryCommit });

    assert.equal(git("symbolic-ref --short HEAD", wt), "wao/run_child_b");
    assert.equal(git("rev-parse HEAD", wt), base);
    const status = git("status --porcelain=v1", wt);
    assert.match(status, /keep\.txt/, "delivery tree still present as working changes");
    assert.equal(git(`cat-file -e ${deliveryCommit}`, wt), "", "parent commit object still exists");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("M12-7-WT-03: uncommitted/backend-failed candidate is preserved AS-IS", () => {
  const repo = makeRepo();
  const parentRunId = "run_parent_uncom";
  const childRunId = "run_child_uncom";
  const wt = addWorktree(repo, parentRunId);
  try {
    const base = git("rev-parse HEAD", repo);
    // No delivery commit — packaging failed. Leave a candidate working tree.
    writeFileSync(join(wt, "cand.txt"), "candidate-bytes\n", "utf8");
    git("add -A", wt); // candidate may be staged

    const res = prepareContinuationWorktree(wt, {
      parentRunId, childRunId, baseCommit: base, deliveryCommit: null,
    });
    assert.equal(res.branch, `wao/${childRunId}`);
    assert.equal(git("rev-parse HEAD", wt), base, "HEAD stays at persisted base");
    // Candidate bytes preserved (file present).
    assert.ok(existsSync(join(wt, "cand.txt")), "candidate file preserved");
    assert.equal(git("symbolic-ref --short HEAD", wt), `wao/${childRunId}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("M12-7-WT-04: drift / wrong state fails closed", () => {
  const repo = makeRepo();
  const parentRunId = "run_parent_drift";
  const wt = addWorktree(repo, parentRunId);
  const base = git("rev-parse HEAD", repo);
  try {
    // Detached HEAD -> refuse.
    git("checkout --detach", wt);
    assert.throws(
      () => prepareContinuationWorktree(wt, { parentRunId, childRunId: "run_c", baseCommit: base, deliveryCommit: null }),
      DeliveryError,
    );
    // Restore attached state for the primary-checkout assertion.
    git("checkout wao/" + parentRunId, wt);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }

  // Primary checkout (the main repo itself) is not an isolated linked worktree.
  const repo2 = makeRepo();
  try {
    const base2 = git("rev-parse HEAD", repo2);
    assert.throws(
      () => prepareContinuationWorktree(repo2, { parentRunId: "run_x", childRunId: "run_c", baseCommit: base2, deliveryCommit: null }),
      DeliveryError,
    );
  } finally {
    rmSync(repo2, { recursive: true, force: true });
  }
});

test("M12-7-WT-05: non-canonical base/delivery commit fails closed before mutation", () => {
  const repo = makeRepo();
  const parentRunId = "run_parent_canon";
  const wt = addWorktree(repo, parentRunId);
  try {
    const base = git("rev-parse HEAD", repo);
    assert.throws(
      () => prepareContinuationWorktree(wt, { parentRunId, childRunId: "run_c", baseCommit: "not-a-commit", deliveryCommit: null }),
      DeliveryError,
    );
    // deliveryCommit non-canonical when supplied.
    assert.throws(
      () => prepareContinuationWorktree(wt, { parentRunId, childRunId: "run_c", baseCommit: base, deliveryCommit: "HEAD" }),
      DeliveryError,
    );
    // Worktree was NOT mutated by the failed calls.
    assert.equal(git("symbolic-ref --short HEAD", wt), `wao/${parentRunId}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// TD-138 C：续接证明（proveContinuationWorktree，经 prepareContinuationWorktree
// 的只读证明段触达）的三个拓扑事实（toplevel / git dir / common dir）一次合
// 并 rev-parse 读取——经委托 spy 数真实子进程调用，不是速度阈值。
test("TD-138-C1: proveContinuationWorktree issues exactly ONE merged topology query per proof", () => {
  const repo = makeRepo();
  const parentRunId = "run_parent_td138";
  const wt = addWorktree(repo, parentRunId);
  const require = createRequire(import.meta.url);
  const childProcess = require("node:child_process");
  const realExecFileSync = childProcess.execFileSync;
  const counts = { merged: 0, single: 0 };
  try {
    const base = git("rev-parse HEAD", repo);
    writeFileSync(join(wt, "keep.txt"), "keep-changed\n", "utf8");
    git("add -A", wt);
    git("commit -m delivery", wt);
    const deliveryCommit = git("rev-parse HEAD", wt);

    childProcess.execFileSync = (cmd, args, opts) => {
      if (cmd === "git" && Array.isArray(args) && args[0] === "rev-parse") {
        const has = (flag) => args.includes(flag);
        if (has("--show-toplevel") && has("--absolute-git-dir") && has("--git-common-dir")) counts.merged += 1;
        else if (args.length === 2
          && ["--show-toplevel", "--absolute-git-dir", "--git-common-dir"].includes(args[1])) counts.single += 1;
      }
      return realExecFileSync(cmd, args, opts);
    };
    syncBuiltinESMExports();
    const res = prepareContinuationWorktree(wt, {
      parentRunId, childRunId: "run_child_td138", baseCommit: base, deliveryCommit,
    });
    assert.equal(res.branch, "wao/run_child_td138", "transition must succeed unchanged under the spy");
  } finally {
    childProcess.execFileSync = realExecFileSync;
    syncBuiltinESMExports();
    rmSync(repo, { recursive: true, force: true });
  }
  assert.equal(counts.merged, 1,
    `continuation proof must issue exactly ONE merged topology query (observed ${counts.merged})`);
  assert.equal(counts.single, 0,
    `happy path must not fall back to single-question topology queries (observed ${counts.single})`);
});
