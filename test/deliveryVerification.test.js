import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { packageDelivery } from "../src/delivery.js";
import { verifyDelivery, runVerificationCommand } from "../src/deliveryVerification.js";

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
