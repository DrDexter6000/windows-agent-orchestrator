import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { packageDelivery } from "../../src/delivery.js";
import { verifyDelivery, runVerificationCommand } from "../../src/deliveryVerification.js";
import { VERIFICATION_GATE_HELD_ENV, VERIFICATION_GATE_OFF_ENV } from "../../src/verificationGate.js";

// ===== Helpers =====

const RUN_ID = "run_vertest001";
const BRANCH = `wao/${RUN_ID}`;

/** Create a temp git repo with initial structure + a linked worktree. */
async function makeRepoWithWorktree(prefix = "wao-ver-repo-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@test"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: dir, stdio: "ignore" });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.js"), "const a = 1;\n");
  await writeFile(join(dir, ".gitignore"), "node_modules/\n*.log\nbuild/\n");
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
  const baseCommit = execSync("git rev-parse HEAD", {
    cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  const wtPath = join(dir, ".wao-worktrees", RUN_ID);
  execSync(`git worktree add "${wtPath}" -b wao/${RUN_ID}`, { cwd: dir, stdio: "ignore" });
  return { repo: dir, baseCommit, wtPath };
}

/** Create a committed DeliveryRef by writing to the worktree and packaging. */
function makeDeliveryRef(wtPath, baseCommit, opts = {}) {
  // Worker change
  return packageDelivery({
    runId: RUN_ID,
    worktreePath: wtPath,
    baseCommit,
    allowedPaths: ["src"],
    isolation: { type: "worktree", strategy: "persistent" },
    verificationCommands: opts.verificationCommands ?? ["echo ok"],
    ...opts,
  });
}

/** Clean up temp repo with retry. */
async function cleanupDir(dir) {
  try { execSync("git worktree prune", { cwd: dir, stdio: "ignore" }); } catch { /* best effort */ }
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await rm(dir, { recursive: true, force: true }); return; }
    catch { if (attempt === 4) return; await new Promise(r => setTimeout(r, 50 * (attempt + 1))); }
  }
}

// ===== 3B-1 Tests =====

test("3B-01: one passing command updates status to passed and pins verifiedCommit", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-01-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });
    const result = await verifyDelivery(ref);
    assert.equal(result.outcome, "passed");
    assert.equal(result.delivery.verification.status, "passed");
    assert.equal(result.delivery.verification.verifiedCommit, ref.deliveryCommit);
    assert.equal(result.delivery.verification.results.length, 1);
    assert.equal(result.delivery.verification.results[0].exitCode, 0);
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-02: two passing commands execute in order and produce two result entries", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-02-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo first", "echo second"] });
    const result = await verifyDelivery(ref);
    assert.equal(result.outcome, "passed");
    assert.equal(result.delivery.verification.results.length, 2);
    assert.equal(result.delivery.verification.results[0].command, "echo first");
    assert.equal(result.delivery.verification.results[1].command, "echo second");
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-03: first command non-zero -> failed/command_failed; second not run", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-03-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["exit 1", "echo should_not_run"] });
    const result = await verifyDelivery(ref);
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "command_failed");
    assert.equal(result.delivery.verification.results.length, 1);
    assert.equal(result.delivery.verification.results[0].exitCode, 1);
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-04: timeout -> failed/command_timeout and timedOut true", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-04-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationCommands: ["node -e \"setTimeout(()=>{},99999)\""],
    });
    const result = await verifyDelivery(ref, { timeoutMs: 500 });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "command_timeout");
    assert.equal(result.delivery.verification.results[0].timedOut, true);
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-05: timeout kills the real process tree; PID no longer alive after bounded polling", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-05-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    // Command writes its PID to a file, then sleeps
    const pidFile = join(tmpdir(), `wao-ver-pid-${Date.now()}.txt`);
    const cmd = `node -e "require('fs').writeFileSync('${pidFile.replace(/\\/g, "/")}', String(process.pid)); setTimeout(()=>{},99999)"`;
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: [cmd] });
    const result = await verifyDelivery(ref, { timeoutMs: 500 });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "command_timeout");

    // Bounded polling for process death (up to 5s with backoff)
    const { readFile } = await import("node:fs/promises");
    let pid;
    try { pid = Number(await readFile(pidFile, "utf8")); } catch { pid = 0; }
    if (pid > 0) {
      let alive = true;
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(r => setTimeout(r, 200));
        try { process.kill(pid, 0); } catch { alive = false; break; }
      }
      assert.equal(alive, false, "timed-out verification process must be dead");
    }
    try { await rm(pidFile, { force: true }); } catch { /* best effort */ }
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-06: command launch/internal error -> failed/execution_error without raw exception leakage", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-06-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });
    // Inject a runCommand that simulates a launch error
    const result = await verifyDelivery(ref, {
      runCommand: async () => ({ exitCode: null, signal: null, timedOut: false, durationMs: 0, stdoutBytes: 0, stderrBytes: 0, launchError: true }),
    });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "execution_error");
    // No raw exception in result
    const json = JSON.stringify(result);
    assert.ok(!json.includes("Error:"), "no raw exception leakage");
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-07: command with stdout/stderr records byte counts but no output body fields", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-07-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo hello && echo err >&2"] });
    const result = await verifyDelivery(ref);
    assert.equal(result.outcome, "passed");
    const r = result.delivery.verification.results[0];
    assert.ok(r.stdoutBytes > 0, "stdoutBytes must be > 0");
    assert.ok(r.stderrBytes > 0, "stderrBytes must be > 0");
    // No output body fields
    assert.ok(!("stdout" in r), "no stdout field");
    assert.ok(!("stderr" in r), "no stderr field");
    assert.ok(!("output" in r), "no output field");
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-08: command executes in delivery worktree, proven by reading committed file via cwd", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-08-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "const a = 999;\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["node -e \"require('fs').readFileSync('src/a.js','utf8')\""] });
    const result = await verifyDelivery(ref);
    assert.equal(result.outcome, "passed");
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-09: source checkout is not used or modified", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-09-");
  try {
    const sourceHeadBefore = execSync("git rev-parse HEAD", {
      cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });
    await verifyDelivery(ref);
    const sourceHeadAfter = execSync("git rev-parse HEAD", {
      cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    assert.equal(sourceHeadAfter, sourceHeadBefore, "source HEAD must not change");
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-10: wrong HEAD before verification -> artifact_mismatch, zero command calls", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-10-");
  let commandCount = 0;
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });
    // Corrupt: advance worktree HEAD past delivery
    execSync("git checkout --detach", { cwd: wtPath, stdio: "ignore" });
    await assert.rejects(
      () => verifyDelivery(ref, { runCommand: async () => { commandCount++; return { exitCode: 0, stdoutBytes: 0, stderrBytes: 0, durationMs: 0, timedOut: false, signal: null }; } }),
      (err) => err.deliveryCode === "artifact_mismatch",
    );
    assert.equal(commandCount, 0, "zero commands must run on artifact mismatch");
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-11: wrong branch/detached/primary checkout -> artifact_mismatch, zero command calls", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-11-");
  let commandCount = 0;
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });
    // Switch to wrong branch
    execSync("git checkout -b wrong_branch", { cwd: wtPath, stdio: "ignore" });
    await assert.rejects(
      () => verifyDelivery(ref, { runCommand: async () => { commandCount++; return { exitCode: 0, stdoutBytes: 0, stderrBytes: 0, durationMs: 0, timedOut: false, signal: null }; } }),
      (err) => err.deliveryCode === "artifact_mismatch",
    );
    assert.equal(commandCount, 0, "zero commands on wrong branch");
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-12: forged parent/baseCommit -> artifact_mismatch", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-12-");
  let commandCount = 0;
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });
    // Forge baseCommit
    const forged = { ...ref, baseCommit: "0".repeat(40) };
    await assert.rejects(
      () => verifyDelivery(forged, { runCommand: async () => { commandCount++; return { exitCode: 0, stdoutBytes: 0, stderrBytes: 0, durationMs: 0, timedOut: false, signal: null }; } }),
      (err) => err.deliveryCode === "artifact_mismatch",
    );
    assert.equal(commandCount, 0, "zero commands on forged base");
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-13: forged changedFiles set -> artifact_mismatch", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-13-");
  let commandCount = 0;
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });
    const forged = { ...ref, changedFiles: ["src/nonexistent.js"] };
    await assert.rejects(
      () => verifyDelivery(forged, { runCommand: async () => { commandCount++; return { exitCode: 0, stdoutBytes: 0, stderrBytes: 0, durationMs: 0, timedOut: false, signal: null }; } }),
      (err) => err.deliveryCode === "artifact_mismatch",
    );
    assert.equal(commandCount, 0, "zero commands on forged changedFiles");
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-14: dirty worktree before verification -> artifact_mismatch, zero command calls", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-14-");
  let commandCount = 0;
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });
    // Dirty the worktree
    await writeFile(join(wtPath, "src", "a.js"), "dirty_after_packaging\n");
    await assert.rejects(
      () => verifyDelivery(ref, { runCommand: async () => { commandCount++; return { exitCode: 0, stdoutBytes: 0, stderrBytes: 0, durationMs: 0, timedOut: false, signal: null }; } }),
      (err) => err.deliveryCode === "artifact_mismatch",
    );
    assert.equal(commandCount, 0, "zero commands on dirty worktree");
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-15: exit-0 command modifies tracked file -> failed/artifact_mutated", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-15-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo mutate"] });
    // Inject command that modifies a tracked file
    const result = await verifyDelivery(ref, {
      runCommand: async (cmd, cwd) => {
        // Simulate the command modifying a tracked file
        const { writeFile: wf } = await import("node:fs/promises");
        await wf(join(cwd, "src", "a.js"), "mutated by command\n");
        return { exitCode: 0, signal: null, timedOut: false, durationMs: 10, stdoutBytes: 0, stderrBytes: 0 };
      },
    });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "artifact_mutated");
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-16: exit-0 command creates non-ignored untracked file -> failed/artifact_mutated", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-16-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo mutate"] });
    const result = await verifyDelivery(ref, {
      runCommand: async (cmd, cwd) => {
        const { writeFile: wf } = await import("node:fs/promises");
        await wf(join(cwd, "non_ignored.txt"), "created\n");
        return { exitCode: 0, signal: null, timedOut: false, durationMs: 10, stdoutBytes: 0, stderrBytes: 0 };
      },
    });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "artifact_mutated");
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-17: exit-0 command creates only ignored output -> passed", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-17-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });
    const result = await verifyDelivery(ref, {
      runCommand: async (cmd, cwd) => {
        // Create an ignored file (*.log in .gitignore)
        const { writeFile: wf, mkdir: mkd } = await import("node:fs/promises");
        await mkd(join(cwd, "build"), { recursive: true });
        await wf(join(cwd, "build", "output.log"), "build output\n");
        return { exitCode: 0, signal: null, timedOut: false, durationMs: 10, stdoutBytes: 0, stderrBytes: 0 };
      },
    });
    assert.equal(result.outcome, "passed");
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-18: command changes HEAD -> failed/artifact_mutated", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-18-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });
    const result = await verifyDelivery(ref, {
      runCommand: async (cmd, cwd) => {
        // Simulate command changing HEAD (amend)
        const { writeFile: wf } = await import("node:fs/promises");
        await wf(join(cwd, "src", "a.js"), "amended\n");
        execSync("git add src/a.js", { cwd, stdio: "ignore" });
        execSync('git commit --amend --no-edit', {
          cwd, stdio: "ignore",
          env: { ...process.env, GIT_AUTHOR_NAME: "WAO Delivery", GIT_AUTHOR_EMAIL: "wao-delivery@local", GIT_COMMITTER_NAME: "WAO Delivery", GIT_COMMITTER_EMAIL: "wao-delivery@local" },
        });
        return { exitCode: 0, signal: null, timedOut: false, durationMs: 10, stdoutBytes: 0, stderrBytes: 0 };
      },
    });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "artifact_mutated");
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-19: input pending DeliveryRef is unchanged after pass/fail", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-19-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });
    const originalSnapshot = JSON.parse(JSON.stringify(ref));
    await verifyDelivery(ref);
    assert.deepEqual(ref, originalSnapshot, "input ref must not be mutated");
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-20: acceptance/integration remain pending and unchanged", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-20-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });
    const result = await verifyDelivery(ref);
    assert.equal(result.delivery.acceptance.status, "pending");
    assert.equal(result.delivery.acceptance.reviewerType, "lead_agent");
    assert.equal(result.delivery.integration.status, "pending");
    assert.equal(result.delivery.integration.targetCommit, null);
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-21: unavailableReason with no commands -> unavailable, zero command calls", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-21-");
  let commandCount = 0;
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = packageDelivery({
      runId: RUN_ID, worktreePath: wtPath, baseCommit,
      allowedPaths: ["src"],
      isolation: { type: "worktree", strategy: "persistent" },
      verificationUnavailableReason: "no test suite",
    });
    const result = await verifyDelivery(ref, {
      runCommand: async () => { commandCount++; return { exitCode: 0, stdoutBytes: 0, stderrBytes: 0, durationMs: 0, timedOut: false, signal: null }; },
    });
    assert.equal(result.outcome, "unavailable");
    assert.equal(commandCount, 0, "zero commands on unavailable");
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-22: missing commands and missing unavailableReason fails closed", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-22-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    // Create a ref with empty verification (no commands, no reason)
    const ref = packageDelivery({
      runId: RUN_ID, worktreePath: wtPath, baseCommit,
      allowedPaths: ["src"],
      isolation: { type: "worktree", strategy: "persistent" },
      verificationCommands: ["echo ok"],
    });
    // Forge: remove commands and reason
    const forged = {
      ...ref,
      verification: { status: "pending", commands: [] },
    };
    delete forged.verification.unavailableReason;
    await assert.rejects(
      () => verifyDelivery(forged),
      (err) => err.deliveryCode === "execution_error",
    );
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-23: invalid timeout (0/negative/NaN/string) fails before command execution", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-23-");
  let commandCount = 0;
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });
    for (const badTimeout of [0, -1, NaN, "300000"]) {
      commandCount = 0;
      await assert.rejects(
        () => verifyDelivery(ref, {
          timeoutMs: badTimeout,
          runCommand: async () => { commandCount++; return { exitCode: 0, stdoutBytes: 0, stderrBytes: 0, durationMs: 0, timedOut: false, signal: null }; },
        }),
        (err) => err.deliveryCode === "execution_error",
      );
      assert.equal(commandCount, 0, `zero commands for invalid timeout ${badTimeout}`);
    }
  } finally {
    await cleanupDir(repo);
  }
});

test("3B-24: malformed DeliveryRef fails closed without executing a command", async () => {
  let commandCount = 0;
  const fakeRunCommand = async () => { commandCount++; return { exitCode: 0, stdoutBytes: 0, stderrBytes: 0, durationMs: 0, timedOut: false, signal: null }; };

  // Not an object
  await assert.rejects(
    () => verifyDelivery(null, { runCommand: fakeRunCommand }),
    (err) => err.deliveryCode === "artifact_mismatch" || err.deliveryCode === "execution_error",
  );
  // Wrong schema
  await assert.rejects(
    () => verifyDelivery({ schemaVersion: 2, kind: "patch" }, { runCommand: fakeRunCommand }),
    (err) => err.deliveryCode === "artifact_mismatch" || err.deliveryCode === "execution_error",
  );
  assert.equal(commandCount, 0, "zero commands on malformed ref");
});

test("3B-25: verification result contains no stdout/stderr body, stack, env, or secret sentinel", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-25-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    // Use a command that outputs a sentinel to stdout/stderr — only byte counts should survive.
    // The sentinel "UNIQUE_STDOUT_SENTINEL" appears in command string but must NOT appear
    // in any result field other than the command string itself.
    const sentinel = "UNIQUE_STDOUT_SENTINEL";
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: [`echo ${sentinel}`] });
    const result = await verifyDelivery(ref);
    const json = JSON.stringify(result);
    // The sentinel appears in the command string (expected), but must NOT appear in
    // result fields (stdout/stderr body). Check results entries specifically.
    for (const r of result.delivery.verification.results) {
      const rJson = JSON.stringify(r);
      // The command field legitimately contains the sentinel, so exclude it from check.
      const rWithoutCommand = { ...r };
      delete rWithoutCommand.command;
      assert.ok(!JSON.stringify(rWithoutCommand).includes(sentinel),
        "sentinel must not appear in result fields other than command");
      assert.ok(!("stdout" in r), "no stdout body field");
      assert.ok(!("stderr" in r), "no stderr body field");
    }
    assert.ok(!json.includes("process.env"), "no env leakage");
  } finally {
    await cleanupDir(repo);
  }
});

// ===== 3B closeout RED tests (CTO 4 confirmed REDs) =====

/**
 * CTO RED #3: assertCommittedDeliveryRef only checks author, not committer.
 * An "Evil Committer <evil@local>" commit passes verification.
 */
test("3B-C1: forged committer identity -> artifact_mismatch (CTO RED #3)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-c1-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });

    // Forge ONLY the committer identity using plumbing (commit-tree + update-ref).
    // Author stays WAO identity; committer is corrupted to "Evil Committer".
    // Tree, parent, and message are preserved exactly so no other check trips.
    const { execFileSync: ef } = await import("node:child_process");
    const tree = ef("git", ["rev-parse", "HEAD^{tree}"], { cwd: wtPath, encoding: "utf8" }).trim();
    const parent = ef("git", ["rev-parse", "HEAD^"], { cwd: wtPath, encoding: "utf8" }).trim();
    const evilEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "WAO Delivery",
      GIT_AUTHOR_EMAIL: "wao-delivery@local",
      GIT_COMMITTER_NAME: "Evil Committer",
      GIT_COMMITTER_EMAIL: "evil@local",
    };
    const evilCommit = ef("git", ["commit-tree", tree, "-p", parent], {
      cwd: wtPath, encoding: "utf8", env: evilEnv,
      input: `wao-delivery: ${RUN_ID}\n`,
    }).trim();
    // Move the branch ref so HEAD (symbolic-ref) follows
    ef("git", ["update-ref", `refs/heads/${BRANCH}`, evilCommit], { cwd: wtPath, stdio: "ignore" });
    const forgedRef = { ...ref, deliveryCommit: evilCommit };

    await assert.rejects(
      () => verifyDelivery(forgedRef),
      (err) => err.deliveryCode === "artifact_mismatch",
      "forged committer must be caught as artifact_mismatch",
    );
  } finally {
    await cleanupDir(repo);
  }
});

/**
 * CTO RED #1: unavailable path returns before asserting committed DeliveryRef.
 * A dirty/forged worktree still gets status:"unavailable".
 */
test("3B-C2: dirty worktree + unavailableReason -> artifact_mismatch, zero commands (CTO RED #1)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-c2-");
  let commandCount = 0;
  const fakeRunCommand = async () => { commandCount++; return { exitCode: 0, stdoutBytes: 0, stderrBytes: 0, durationMs: 0, timedOut: false, signal: null }; };
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationCommands: [],
      verificationUnavailableReason: "no test suite",
    });

    // Dirty the worktree AFTER packaging — now the committed state is violated.
    await writeFile(join(wtPath, "src", "a.js"), "tampered\n");

    await assert.rejects(
      () => verifyDelivery(ref, { runCommand: fakeRunCommand }),
      (err) => err.deliveryCode === "artifact_mismatch",
      "dirty worktree with unavailableReason must fail as artifact_mismatch before returning unavailable",
    );
    assert.equal(commandCount, 0, "zero commands must execute for unavailable path");
  } finally {
    await cleanupDir(repo);
  }
});

/**
 * CTO RED #2: failed/timeout/launch-error paths skip post-command proof.
 * A command that modifies a tracked file AND exits non-zero should be
 * artifact_mutated, not command_failed.
 */
test("3B-C3: exit-1 command modifies tracked file -> artifact_mutated (CTO RED #2)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-c3-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationCommands: ['node -e "require(\'fs\').writeFileSync(\'src/a.js\', \'corrupted\\n\')" && exit 1'],
    });

    const result = await verifyDelivery(ref);
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "artifact_mutated",
      "exit-1 + file mutation must be artifact_mutated, NOT command_failed");
  } finally {
    await cleanupDir(repo);
  }
});

/**
 * CTO RED #2 variant: timeout command modifies tracked file -> artifact_mutated.
 */
test("3B-C4: timeout command modifies tracked file -> artifact_mutated (CTO RED #2)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-c4-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationCommands: ['node -e "require(\'fs\').writeFileSync(\'src/a.js\', \'corrupted\\n\')" && sleep 10'],
    });

    const result = await verifyDelivery(ref, { timeoutMs: 500 });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "artifact_mutated",
      "timeout + file mutation must be artifact_mutated, NOT command_timeout");
  } finally {
    await cleanupDir(repo);
  }
});

/**
 * CTO RED #2 variant: launch-error command modifies tracked file -> artifact_mutated.
 */
test("3B-C5: launch-error command modifies tracked file -> artifact_mutated (CTO RED #2)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-c5-");
  let fakeCalled = false;
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationCommands: ["fake-command"],
    });

    // Simulate: command mutates the file then fails to launch (launchError).
    // The real mutation happens via the fakeRunCommand side-effect.
    const { writeFile: wf } = await import("node:fs/promises");
    const fakeRunCommand = async () => {
      fakeCalled = true;
      await wf(join(wtPath, "src", "a.js"), "corrupted\n");
      return { exitCode: null, signal: null, timedOut: false, durationMs: 0, stdoutBytes: 0, stderrBytes: 0, launchError: true };
    };

    const result = await verifyDelivery(ref, { runCommand: fakeRunCommand });
    assert.ok(fakeCalled, "fake command must have been called");
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "artifact_mutated",
      "launch-error + file mutation must be artifact_mutated, NOT execution_error");
  } finally {
    await cleanupDir(repo);
  }
});

/**
 * CTO RED #2 variant: launch-error command on a clean worktree -> execution_error,
 * NOT artifact_mismatch (proves the post-proof is actually running, not just always-passing).
 */
test("3B-C6: launch-error command on clean worktree -> execution_error (proves post-proof runs)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-c6-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["fake-command"] });

    const fakeRunCommand = async () => {
      return { exitCode: null, signal: null, timedOut: false, durationMs: 0, stdoutBytes: 0, stderrBytes: 0, launchError: true };
    };

    const result = await verifyDelivery(ref, { runCommand: fakeRunCommand });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "execution_error",
      "launch-error on clean worktree must be execution_error");
  } finally {
    await cleanupDir(repo);
  }
});

/**
 * CTO RED #1 variant: unavailable with valid (unmutated) worktree still returns unavailable
 * and still calls zero commands. Proves the unavailable path works correctly when proof passes.
 */
test("3B-C7: valid unavailable -> unavailable outcome, zero commands, proof passed", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-c7-");
  let commandCount = 0;
  const fakeRunCommand = async () => { commandCount++; return { exitCode: 0, stdoutBytes: 0, stderrBytes: 0, durationMs: 0, timedOut: false, signal: null }; };
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationCommands: [],
      verificationUnavailableReason: "no test suite",
    });

    const result = await verifyDelivery(ref, { runCommand: fakeRunCommand });
    assert.equal(result.outcome, "unavailable");
    assert.equal(commandCount, 0, "valid unavailable must execute zero commands");
  } finally {
    await cleanupDir(repo);
  }
});

// ===== R23-F/B Round B (TD-130) B2: machine-level serialization gate seam =====
//
// verifyDelivery 函数体本身不进闸（33 处直调测试与单文件跑不得入闸）；闸经
// `opts.gate` 注入缝显式开启（默认关）。契约：
//   · acquire 先于第一条命令——排队等待不计入任何命令预算（per-command 计时器
//     在 runVerificationCommand 内 spawn 时才武装；传入的 timeoutMs 原样透传）；
//   · 持闸期间每个 attempt env 注入 WAO_VERIFICATION_GATE_HELD=1（子进程见即
//     跳过——防自锁）；fail-open（acquire ⇒ null）不注入、无闸继续跑；
//   · finally 释放：passed/failed/抛错路径都恰好 release 一次；
//   · 零断言 + unavailableReason 的路径零命令 ⇒ 不触碰闸。
// 这些测试只注入假 gate/runCommand，绝不触碰真实机器租约。

/** 记录调用的假 runCommand（成功形状，可注入覆盖）。 */
function recordingRunCommand(calls, overrides = {}) {
  return async (command, cwd, opts) => {
    calls.push({ kind: "cmd", command, opts });
    return {
      command, exitCode: 0, signal: null, timedOut: false,
      durationMs: 1, stdoutBytes: 0, stderrBytes: 0, ...overrides,
    };
  };
}

/** 可手动放行的阻塞假 gate；记录调用序。 */
function blockingFakeGate(calls) {
  let releaseAcquire = null;
  const acquired = new Promise((resolve) => { releaseAcquire = resolve; });
  return {
    releaseAcquire,
    acquire: async () => {
      calls.push("acquire:start");
      await acquired;
      calls.push("acquire:end");
      return {
        token: "tok-fake-b2",
        lost: () => false,
        release: async () => { calls.push("release"); return true; },
      };
    },
  };
}

/** 立即到手的假 gate（只测 env 注入/释放纪律，不制造等待）。 */
function okFakeGate(released) {
  return {
    acquire: async () => ({
      token: "tok-fake-b2-ok",
      lost: () => false,
      release: async () => { if (released) released.push("release"); return true; },
    }),
  };
}

test("B2-① RED 顺序断言：acquire 先于首条命令且排队不计预算（timeoutMs 未被扣减）", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-b2a-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationCommands: ["echo one", "echo two"],
    });

    const calls = [];
    const capturedOpts = [];
    const gate = blockingFakeGate(calls);
    const runCommand = async (command, cwd, opts) => {
      capturedOpts.push(opts);
      return recordingRunCommand(calls)(command, cwd, opts);
    };

    const pending = verifyDelivery(ref, { timeoutMs: 12345, runCommand, gate });
    // 闸阻塞期间：任何命令都不得启动（acquire 未决）。
    await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(calls, ["acquire:start"], "acquire 未决期间不得启动任何验证命令");

    gate.releaseAcquire();
    const result = await pending;
    assert.equal(result.outcome, "passed");
    assert.equal(calls[1], "acquire:end", "第二条事件是 acquire 完成");
    assert.match(calls[2]?.kind === "cmd" ? calls[2].command : String(calls[2]), /echo one/,
      "acquire 完成后第一件事才是首条验证命令");
    assert.equal(calls[calls.length - 1], "release", "finally 必须释放闸（恰好最后一步）");
    // 排队不计预算：传给每条命令的 timeoutMs 是原始声明值，未被等待时长扣减
    // （计时器在 spawn 时才武装——结构上保证等待永不吃执行预算）。
    assert.equal(capturedOpts.length, 2);
    for (const o of capturedOpts) {
      assert.equal(o.timeoutMs, 12345, "timeoutMs 必须原样透传（排队不扣减）");
    }
  } finally {
    await cleanupDir(repo);
  }
});

test("B2-② env 两跳·harness 父→子：持闸时每个 attempt env 注入 HELD=1；无闸时绝不注入", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-b2b-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationCommands: ["echo a", "echo b"],
    });

    // 持闸：每条命令的 env 都必须带 WAO_VERIFICATION_GATE_HELD=1。
    const heldCalls = [];
    const released = [];
    const heldResult = await verifyDelivery(ref, {
      runCommand: recordingRunCommand(heldCalls),
      gate: okFakeGate(released),
    });
    assert.equal(heldResult.outcome, "passed");
    assert.equal(heldCalls.length, 2);
    for (const c of heldCalls) {
      assert.equal(c.opts.env?.[VERIFICATION_GATE_HELD_ENV], "1",
        "持闸时子进程 env 必须注入 WAO_VERIFICATION_GATE_HELD=1（防自锁）");
    }
    assert.deepEqual(released, ["release"], "成功路径恰好释放一次");

    // 无闸（默认关）：verifyDelivery 自己绝不注入 HELD——但环境里可能本就带着
    // 继承值（如 canonical 父进程持闸时注入的 wave 子进程）；继承值原样透传是
    // 正确行为（子进程确实有持闸祖先），剥离反而会诱发自锁。因此断言分两支：
    // 环境无值 ⇒ env 必须无值；环境有值 ⇒ env 恰等于继承值。
    const inherited = process.env[VERIFICATION_GATE_HELD_ENV];
    const bareCalls = [];
    const bareResult = await verifyDelivery(ref, { runCommand: recordingRunCommand(bareCalls) });
    assert.equal(bareResult.outcome, "passed");
    for (const c of bareCalls) {
      if (inherited === undefined) {
        assert.ok(!c.opts.env || c.opts.env[VERIFICATION_GATE_HELD_ENV] === undefined,
          "默认（无 gate）且环境无标记时不得注入 HELD");
      } else {
        assert.equal(c.opts.env?.[VERIFICATION_GATE_HELD_ENV], inherited,
          "无 gate 时只允许继承值原样透传，不得凭空新增/改写");
      }
    }
  } finally {
    await cleanupDir(repo);
  }
});

test("B2-③ fail-open：acquire 返回 null ⇒ 无闸继续跑、env 不注入、release 不调用", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-b2c-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });

    const calls = [];
    const released = [];
    const failOpenGate = {
      acquire: async () => { calls.push("acquire"); return null; },
    };
    const result = await verifyDelivery(ref, {
      runCommand: async (...args) => {
        const r = await recordingRunCommand(calls)(...args);
        return r;
      },
      gate: failOpenGate,
    });
    assert.equal(result.outcome, "passed", "基础设施 fail-open 后验证照常完成");
    assert.deepEqual(calls.filter((c) => c === "acquire"), ["acquire"]);
    // 同 B2-② 无闸支：环境可能本就带着继承值（canonical 持闸父进程的 wave 子
    // 进程）；fail-open 的契约是"不新增/不谎报"——继承值原样透传合法。
    const inherited = process.env[VERIFICATION_GATE_HELD_ENV];
    for (const c of calls) {
      if (c?.kind === "cmd") {
        if (inherited === undefined) {
          assert.ok(!c.opts.env || c.opts.env[VERIFICATION_GATE_HELD_ENV] === undefined,
            "fail-open（未真正持闸）且环境无标记时不得谎报 HELD");
        } else {
          assert.equal(c.opts.env?.[VERIFICATION_GATE_HELD_ENV], inherited,
            "fail-open 只允许继承值原样透传，不得凭空新增");
        }
      }
    }
  } finally {
    await cleanupDir(repo);
  }
});

test("B2-④ 失败路径也释放且语义不变：首命令失败 ⇒ release 恰一次 + command_failed 原样", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-b2d-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationCommands: ["exit 1", "echo never"],
    });

    const calls = [];
    const gate = {
      acquire: async () => ({
        token: "tok-fake-b2d",
        lost: () => false,
        release: async () => { calls.push("release"); return true; },
      }),
    };
    const result = await verifyDelivery(ref, {
      runCommand: async (command, cwd, opts) => ({
        command, exitCode: command === "exit 1" ? 1 : 0, signal: null,
        timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0,
      }),
      gate,
    });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "command_failed", "闸不得改变失败码语义（fail-open 方向红线）");
    assert.equal(result.delivery.verification.results.length, 1, "失败后后续命令不再运行（原语义）");
    assert.deepEqual(calls, ["release"], "失败返回路径也必须恰好释放一次");
  } finally {
    await cleanupDir(repo);
  }
});

test("B2-⑤ 零断言 + unavailableReason 路径不入闸（gate.acquire 零调用）", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-b2e-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationCommands: [],
      verificationUnavailableReason: "no test suite",
    });

    let acquires = 0;
    const gate = { acquire: async () => { acquires += 1; return null; } };
    const result = await verifyDelivery(ref, {
      runCommand: async () => { throw new Error("must not run"); },
      gate,
    });
    assert.equal(result.outcome, "unavailable");
    assert.equal(acquires, 0, "零命令序列没有可串行化的 spawn——不得触碰闸");
  } finally {
    await cleanupDir(repo);
  }
});

// ── B2-⑥ 生产路径入闸判定（createCallerGate）──
//
// 三条生产路径的开启纪律收敛为一个导出工厂：只有"调用方依赖默认验证器"
// （注入了 verifyDeliveryFn 的测试/内部复用一律不得入闸——否则 33 处注入式
// 测试会在 npm test 期间真实争抢机器租约）且 gateEngaged() 时才创建闸对象。
// 闸生命周期（acquire/release）仍由 verifyDelivery 内部的缝负责。

test("B2-⑥a createCallerGate：默认验证器 + 干净 env ⇒ 返回真闸对象（acquire/status/breakLock 面）", async () => {
  const { createCallerGate } = await import("../../src/deliveryVerification.js");
  const gate = createCallerGate({
    usesDefaultVerifier: true,
    env: {},
    identity: { owner: "RunManager._verifyDeliveryResult", runId: "run_x", agentId: "coder_high" },
  });
  // 只验对象面（acquire 前零 fs 触碰——绝不在这类单测里认领真实机器租约）。
  // release 在 acquire 返回的 handle 上（B1 状态测试已钉），不在闸本体。
  assert.ok(gate && typeof gate.acquire === "function");
  assert.ok(typeof gate.status === "function");
  assert.ok(typeof gate.breakLock === "function");
});

test("B2-⑥b createCallerGate：注入了自定义验证器的调用方绝不创建闸（测试面零牵连）", async () => {
  const { createCallerGate } = await import("../../src/deliveryVerification.js");
  const gate = createCallerGate({ usesDefaultVerifier: false, env: {}, identity: { owner: "x" } });
  assert.equal(gate, null, "注入 verifyDeliveryFn 的调用方（全部测试 + 内部复用）不入闸");
});

test("B2-⑥c createCallerGate：kill switch off / HELD=1 ⇒ null（gateEngaged 收口）", async () => {
  const { createCallerGate } = await import("../../src/deliveryVerification.js");
  assert.equal(
    createCallerGate({ usesDefaultVerifier: true, env: { [VERIFICATION_GATE_OFF_ENV]: "off" }, identity: {} }),
    null,
  );
  assert.equal(
    createCallerGate({ usesDefaultVerifier: true, env: { [VERIFICATION_GATE_HELD_ENV]: "1" }, identity: {} }),
    null,
    "子进程看到 HELD 标记不再认领（防自锁第二道防线）",
  );
});
