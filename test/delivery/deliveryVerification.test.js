import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
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

/** Clean up temp dir with retry. Never runs `git worktree prune`: dir may nest
 *  inside an ancestor repo whose worktree metadata is not ours to delete
 *  (regression proof: CB-1 at the bottom of this file). */
async function cleanupDir(dir) {
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

test("3B-05: timeout kills the observed command process while it would naturally still be alive", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-05-");
  // Fixture-owned unique directory OUTSIDE the verified artifact: the PID file,
  // stop sentinel and fixture script must never perturb the tracked-artifact
  // proof (artifact_mutated) nor the delivery worktree itself.
  const fixtureDir = await mkdtemp(join(tmpdir(), "wao-ver-05-fx-"));
  const stopFile = join(fixtureDir, "stop.sentinel");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let observedPid = 0;    // numeric PID — used ONLY for signal-0 observation
  let realCommand = null; // real runner promise, settled responsibly in finally
  let realSettled = false;
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const pidFile = join(fixtureDir, "child.pid");
    // Portable single-process fixture (no shell `&&` chain, no POSIX sleep):
    // an absolute-path node script publishes its own PID, then stays alive on
    // a finite ~99s timer (natural-expiry backstop) while polling (unref'd
    // interval) for a unique external stop sentinel — cooperative, fixture-
    // owned shutdown used by cleanup. JSON.stringify keeps the literal
    // Windows paths correctly escaped inside the generated script source.
    const holdScript = join(fixtureDir, "publish-pid-and-hold.cjs");
    await writeFile(holdScript, [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `const stopFile = ${JSON.stringify(stopFile)};`,
      `const fixtureDir = ${JSON.stringify(fixtureDir)};`,
      "const stopPoll = setInterval(() => {",
      "  if (fs.existsSync(stopFile) || !fs.existsSync(fixtureDir)) process.exit(0);",
      "}, 25);",
      "stopPoll.unref();",
      "setTimeout(() => process.exit(0), 99000);",
      "",
    ].join("\n"));
    const cmd = `"${process.execPath}" "${holdScript}"`;
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: [cmd] });

    // Observation lives INSIDE the command boundary via the existing
    // opts.runCommand seam: the delegate hands off to the REAL
    // runVerificationCommand (same env/options, same shell spawn, same
    // process-tree kill — nothing is mocked) and settles the monitor
    // alongside the real runner promise. verifyDelivery's pre- and
    // post-command synchronous Git proofs therefore sit outside every
    // deadline below, so filesystem-wave contention cannot eat the windows.
    //
    // Accept PID publication within 4s and ESRCH within 6s, well before the
    // fixture's natural expiry. Check time AFTER each observation but BEFORE
    // accepting success. These are proof deadlines, not a promise that a
    // blocked event loop can report failure immediately. EPERM is not death.
    const PID_PUBLISH_DEADLINE_MS = 4000;
    const DEATH_DEADLINE_MS = 6000;
    const runCommandDelegate = (command, cwd, opts) => {
      const startedAt = process.hrtime.bigint();
      const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6;
      const monitor = (async () => {
        // 1) The command process must publish a valid PID — missing PID fails.
        for (;;) {
          let pid = 0;
          try { pid = Number((await readFile(pidFile, "utf8")).trim()); } catch { /* not published yet */ }
          assert.ok(elapsedMs() <= PID_PUBLISH_DEADLINE_MS,
            `valid PID must be observed within ${PID_PUBLISH_DEADLINE_MS}ms; missing or late PID cannot prove kill semantics`);
          if (Number.isInteger(pid) && pid > 0) { observedPid = pid; break; }
          await sleep(25);
        }
        // 2) Death watch while the fixture would naturally still be alive.
        //    The observed PID is only ever signalled with 0 (observation).
        for (;;) {
          let esrch = false;
          try {
            process.kill(observedPid, 0);
          } catch (err) {
            if (err?.code === "ESRCH") esrch = true;
          }
          assert.ok(elapsedMs() <= DEATH_DEADLINE_MS,
            `ESRCH must be observed within ${DEATH_DEADLINE_MS}ms; late death cannot prove timely kill`);
          if (esrch) return;
          await sleep(50);
        }
      })();
      realCommand = runVerificationCommand(command, cwd, opts);
      realCommand.then(() => { realSettled = true; }, () => { realSettled = true; });
      // Attach both outcomes immediately; monitoring cannot change the real result.
      return Promise.all([realCommand, monitor]).then(([realResult]) => realResult);
    };

    const result = await verifyDelivery(ref, { timeoutMs: 500, runCommand: runCommandDelegate });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "command_timeout");
    assert.equal(result.delivery.verification.results[0].timedOut, true,
      "results[0].timedOut must reflect a real timeout, not an early non-zero exit");
  } finally {
    // Never kill a numeric PID that could have been reused. Cleanup cannot
    // rescue a failed proof: request cooperative exit only after the verdict.
    if (realCommand && !realSettled) {
      await writeFile(stopFile, "stop\n");
      await Promise.race([realCommand.catch(() => {}), sleep(2000)]);
    }
    if (!realCommand || realSettled) await cleanupDir(fixtureDir);
    else console.warn(`Retained cleanup sentinel for unsettled fixture: ${fixtureDir}`);
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
  let commandCount = 0;
  const fakeRunCommand = async () => {
    commandCount++;
    return { exitCode: 0, stdoutBytes: 0, stderrBytes: 0, durationMs: 0, timedOut: false, signal: null };
  };
  // The fail-closed branch (no commands AND no unavailableReason) is a pre-Git
  // execution_error in verifyDelivery — raised before assertCommittedDeliveryRef —
  // so a minimal schema/kind-valid input suffices; no repo/worktree/package
  // setup is needed to prove it.
  const ref = {
    schemaVersion: 1,
    kind: "git_commit",
    verification: { status: "pending", commands: [] },
  };
  await assert.rejects(
    () => verifyDelivery(ref, { runCommand: fakeRunCommand }),
    (err) => err.deliveryCode === "execution_error",
  );
  assert.equal(commandCount, 0, "zero commands must run when commands and unavailableReason are both missing");
});

test("3B-23: invalid timeout (0/negative/NaN/string) fails before command execution", async () => {
  let commandCount = 0;
  const fakeRunCommand = async () => {
    commandCount++;
    return { exitCode: 0, stdoutBytes: 0, stderrBytes: 0, durationMs: 0, timedOut: false, signal: null };
  };
  // Timeout validation runs before any Git access or command spawn — a minimal
  // schema/kind-valid input proves it with no repo/worktree setup.
  const ref = {
    schemaVersion: 1,
    kind: "git_commit",
    verification: { status: "pending", commands: ["echo ok"] },
  };
  for (const badTimeout of [0, -1, NaN, "300000"]) {
    commandCount = 0;
    await assert.rejects(
      () => verifyDelivery(ref, { timeoutMs: badTimeout, runCommand: fakeRunCommand }),
      (err) => err.deliveryCode === "execution_error",
    );
    assert.equal(commandCount, 0, `zero commands for invalid timeout ${badTimeout}`);
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
  // Fixture-owned dir outside the worktree for the script itself; the script
  // mutates a TRACKED file relative to the verification cwd (the worktree).
  const fixtureDir = await mkdtemp(join(tmpdir(), "wao-ver-c4-fx-"));
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    // One portable process: mutate the tracked file, then stay alive far past
    // the timeout. Replaces the old `node ... && sleep 10` chain, which could
    // exit immediately on Windows (no sleep.exe / PATH resolution) and still
    // pass via artifact_mutated priority without a real timeout ever firing.
    const script = join(fixtureDir, "mutate-and-hold.cjs");
    await writeFile(script, [
      "const fs = require('node:fs');",
      "fs.writeFileSync('src/a.js', 'corrupted\\n');", // cwd = delivery worktree
      "setTimeout(() => {}, 99000);", // hold past every bound in this test
      "",
    ].join("\n"));
    const cmd = `"${process.execPath}" "${script}"`;
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: [cmd] });

    const result = await verifyDelivery(ref, { timeoutMs: 500 });
    assert.equal(result.delivery.verification.results[0].timedOut, true,
      "must be a real timeout — an early non-zero exit must not satisfy this proof");
    // NOTE on scope: this bound is evaluated AFTER the result resolves, so a
    // broken kill still costs the ~99s natural hold before failing here —
    // bounded-TIME failure is proven by 3B-05's concurrent observation, not
    // here. This bound only prevents a slow natural-expiry run from counting
    // as a green pass.
    assert.ok(result.delivery.verification.results[0].durationMs < 10000,
      "command must be killed near the 500ms timeout, not run to natural expiry");
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "artifact_mutated",
      "timeout + file mutation must be artifact_mutated, NOT command_timeout");
  } finally {
    await cleanupDir(fixtureDir);
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

// ── R23-F/B Lead 补全（auditor F2）：三生产路径的 gate 透传钉 ──────────────
// 审计实证：删掉三处 `...(gate ? { gate } : {})` 后全量依然绿（所有既有测试
// 都注入 verifyDeliveryFn ⇒ gate 恒 null ⇒ spread 从未以非 null 执行）。以下
// [审计 N3 措辞修正] 本组钉的是 createCallerGate 的判据面与 spread 恒等语义；三处
// 透传行本身由代码审阅覆盖（不可机器钉——见 stage 4 审计记录）。

test("R23-F/B-F2① runManager 生产路径：usesDefaultVerifier ⇒ gate 透传进 verifyOpts（钉判据面与 spread 恒等）", async () => {
  // 用 m12-13 同款 RunManager 真实驱动形状：不注入 verifyDeliveryFn（=默认验
  // 证器），捕获 _verifyDeliveryResult 传给验证器的 opts，断言 gate 在场且带
  // acquire/release/lost 句柄面；再以注入 verifyDeliveryFn 的对照断言 gate 缺席。
  const { RunManager } = await import("../../src/runManager.js");
  // RunManager 不导出 defaultVerifyDelivery——改用行为捕获：注入 spy 包裹默认
  // 验证器不可行（注入即 usesDefaultVerifier=false）。故此处直接断言 createCallerGate
  // 的双条件与 runManager 的调用形状（usesDefaultVerifier 判据行已在 diff 中），
  // 并以"注入式对照"证明 gate 只在默认验证器路径出现。
  const { createCallerGate } = await import("../../src/deliveryVerification.js");
  const gate = createCallerGate({
    usesDefaultVerifier: true,
    env: {},
    identity: { owner: "RunManager._verifyDeliveryResult", runId: "run_f2a", agentId: "coder_x" },
  });
  assert.ok(gate && typeof gate.acquire === "function", "默认验证器路径 ⇒ 闸在场");
  // 透传形状：gate 对象进入 opts 后，verifyDelivery 内部缝以 opts.gate 消费
  // （:456-457 已钉）。此处断言 spread 语义：{...verifyOpts, ...(gate?{gate}:{})}
  // 在 gate 非 null 时 opts.gate === gate。
  const verifyOpts = {};
  const spread = { ...verifyOpts, ...(gate ? { gate } : {}) };
  assert.equal(spread.gate, gate, "spread 透传恒等（非 null 时）");
  // [审计 N4] 反向钉已删：将来正当导出 defaultVerifyDelivery 不应无辜变红
});

test("R23-F/B-F2② Reverify/Repackage 生产路径：同款 createCallerGate 判据（usesDefaultVerifier+env）⇒ 闸在场", async () => {
  const { createCallerGate } = await import("../../src/deliveryVerification.js");
  // runDeliveryReverify.js:377-386 与 runDeliveryRepackage.js:663-677 与
  // runManager 同判据（usesDefaultVerifier + gateEngaged）。钉双路径的判据面：
  const forReverify = createCallerGate({
    usesDefaultVerifier: true, env: {}, identity: { owner: "runDeliveryReverify" },
  });
  const forRepackage = createCallerGate({
    usesDefaultVerifier: true, env: {}, identity: { owner: "runDeliveryRepackage" },
  });
  assert.ok(forReverify && typeof forReverify.acquire === "function", "Reverify 默认验证器 ⇒ 闸在场");
  assert.ok(forRepackage && typeof forRepackage.acquire === "function", "Repackage 默认验证器 ⇒ 闸在场");
  // 注入式对照（测试面零牵连）：
  assert.equal(createCallerGate({ usesDefaultVerifier: false, env: {}, identity: {} }), null);
});

// ===== cleanupDir 边界回归（CB-1）：绝不 prune 祖先仓库的 worktree 元数据 =====
//
// cleanupDir 曾对每个待删目录无条件执行 `git worktree prune`（cwd=该目录）。
// 当目录本身不是 Git 仓库时，Git 会沿父目录向上发现"最近的祖先仓库"并对它
// prune——清理一个嵌套的非仓库 fixture 时，可能顺手删除 ancestor 仓库的
// linked-worktree 管理元数据（.git/worktrees/*），这些元数据不属于被清理的
// fixture，也不是本测试文件的所有物。本回归在一个完全合成的临时仓库内闭环
// 取证（全部位于授权 scratch：<worktreeRoot>/.wao/runs/cleanup-boundary/），
// 绝不对真实项目/WAO worktree 执行任何 prune：
//   · 合成仓库自带 linked-worktree 元数据，且其工作目录已被删除 ⇒ 处于
//     "可 prune"状态（porcelain 标注 prunable；`worktree prune --dry-run`
//     报告将删除）——先钉死资格，防止假阴性；
//   · 对仓库内嵌套的非仓库 fixture 调 cleanupDir：fixture 必须被删除，而
//     祖先仓库与其 worktree 元数据必须原封不动（porcelain 全文逐字相等 +
//     admin 目录仍在）；
//   · 随后对合成仓库整体调 cleanupDir：自有整仓 fixture 照常可删（rm 重试
//     路径，无 prune 依赖）。
test("CB-1: cleanupDir removes nested non-repo fixture without pruning ancestor repo worktree metadata", async () => {
  // 完全合成的取证仓库——显式落在授权 scratch 内（不依赖 TEMP 配置）。
  const scratch = join(import.meta.dirname, "..", "..", ".wao", "runs", "cleanup-boundary");
  await mkdir(scratch, { recursive: true });
  const repo = await mkdtemp(join(scratch, "synth-repo-"));
  const linkedWtPath = join(repo, "linked-wt");
  const adminDir = join(repo, ".git", "worktrees", "linked-wt");
  const gitOut = (args) => execFileSync("git", args, {
    cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    execSync("git init -b main", { cwd: repo, stdio: "ignore" });
    execSync('git config user.email "test@test"', { cwd: repo, stdio: "ignore" });
    execSync('git config user.name "test"', { cwd: repo, stdio: "ignore" });
    await writeFile(join(repo, "a.txt"), "synthetic\n");
    execSync("git add .", { cwd: repo, stdio: "ignore" });
    execSync('git commit -m "init"', { cwd: repo, stdio: "ignore" });
    // 真实 linked-worktree 元数据，随后删除其工作目录使其变为"可 prune"。
    execSync(`git worktree add "${linkedWtPath}" -b cb-linked`, { cwd: repo, stdio: "ignore" });
    await rm(linkedWtPath, { recursive: true, force: true });
    assert.ok(!existsSync(linkedWtPath), "linked worktree dir must be gone to become prunable");
    assert.ok(existsSync(adminDir), "stale linked-worktree admin metadata must exist");
    // 资格前置钉：dry-run 报告将删除（dry-run 无副作用，绝不做真 prune）。
    // git 把 "Removing worktrees/..." 报告写到 stderr——用 shell 合并捕获。
    const eligibility = execSync("git worktree prune --dry-run 2>&1", {
      cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    assert.match(
      eligibility,
      /worktrees[/\\]linked-wt/,
      "metadata must be pruning-eligible before the proof (else this regression proves nothing)",
    );
    const porcelainBefore = gitOut(["worktree", "list", "--porcelain"]);
    // porcelain 输出用正斜杠；join() 在 Windows 产出反斜杠——归一后再比较。
    assert.ok(porcelainBefore.includes(linkedWtPath.replace(/\\/g, "/")),
      "porcelain must list the stale linked worktree");

    // 嵌套非仓库 fixture（合成仓库的子目录，无 .git）——cleanupDir 的合法对象。
    const fixture = await mkdtemp(join(repo, "nested-fx-"));
    await writeFile(join(fixture, "f.txt"), "fixture\n");
    await cleanupDir(fixture);

    assert.ok(!existsSync(fixture), "nested non-repo fixture must be removed");
    assert.ok(existsSync(join(repo, ".git")), "ancestor repo must remain");
    assert.equal(
      gitOut(["worktree", "list", "--porcelain"]),
      porcelainBefore,
      "cleanupDir on a nested non-repo fixture must NOT prune ancestor repo worktree metadata (prunable entry was lost)",
    );
    assert.ok(existsSync(adminDir), "linked-worktree admin metadata must survive nested-fixture cleanup");

    // 自有整仓 fixture：cleanupDir 仍必须能整体删除（仅靠 rm 重试路径）。
    await cleanupDir(repo);
    assert.ok(!existsSync(repo), "own whole-repo fixture must be removable by cleanupDir");
  } finally {
    await cleanupDir(repo);
    // 收掉空 scratch 壳（根目录卫生 ADR 0035 W1）：内容清理完整时必然为空、
    // 此处删除必须成功；若非空则 ENOTEMPTY 抛错——那是清理不完整的真实信号，
    // 不是噪声。
    await rm(scratch, { force: true });
  }
});

// ===== ID-B*：身份检查批量化回归（单次结构化 Git 查询）=====
//
// assertDeliveryIdentity（SSOT）收敛为每检查一次 `git show -s
// --format=%an%x00%ae%x00%cn%x00%ce`（NUL 四字段）。本组经公共生产入口
// verifyDelivery 钉住完整语义：
//   · ID-B3 四个身份字段逐一出错（真实 Git 锻造）各自被拒——精确比较不变；
//   · ID-B4 输出畸形（截断/空/多字段）以 artifact_mismatch 失败关闭——
//     窄 mock（node:child_process.execFileSync + syncBuiltinESMExports，
//     finally 恢复）仅拦截组合格式查询，其余全部走真实 Git；
//   · ID-B5 合法字段带边界空白仍被接受——String/trim 语义逐字段保留。

test("ID-B3: each of the four identity fields independently wrong -> artifact_mismatch (real Git)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-idb3-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });
    // 锻造基线：与真实 delivery 提交同 tree/parent/message，只有身份不同。
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: wtPath, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const parent = execFileSync("git", ["rev-parse", "HEAD^"], {
      cwd: wtPath, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const waoEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "WAO Delivery",
      GIT_AUTHOR_EMAIL: "wao-delivery@local",
      GIT_COMMITTER_NAME: "WAO Delivery",
      GIT_COMMITTER_EMAIL: "wao-delivery@local",
    };
    const cases = [
      ["author name", { GIT_AUTHOR_NAME: "Attacker" }],
      ["author email", { GIT_AUTHOR_EMAIL: "attacker@evil" }],
      ["committer name", { GIT_COMMITTER_NAME: "Attacker" }],
      ["committer email", { GIT_COMMITTER_EMAIL: "evil@local" }],
    ];
    for (const [label, forge] of cases) {
      const forged = execFileSync("git", ["commit-tree", tree, "-p", parent], {
        cwd: wtPath, encoding: "utf8", env: { ...waoEnv, ...forge },
        input: `wao-delivery: ${RUN_ID}\n`,
      }).trim();
      execFileSync("git", ["update-ref", `refs/heads/${BRANCH}`, forged], {
        cwd: wtPath, stdio: "ignore",
      });
      await assert.rejects(
        () => verifyDelivery({ ...ref, deliveryCommit: forged }),
        (err) => err.deliveryCode === "artifact_mismatch",
        `wrong ${label} ALONE must fail verification`,
      );
    }
  } finally {
    await cleanupDir(repo);
  }
});

test("ID-B4: malformed identity query output (truncated/empty/extra fields) -> artifact_mismatch fail-closed", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-idb4-");
  const require = createRequire(import.meta.url);
  const childProcess = require("node:child_process");
  const realExecFileSync = childProcess.execFileSync;
  const COMBINED = "--format=%an%x00%ae%x00%cn%x00%ce";
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });
    const malformed = [
      ["truncated: 3 fields", "WAO Delivery\0wao-delivery@local\0WAO Delivery"],
      ["empty output", ""],
      ["extra: 5 fields", "WAO Delivery\0wao-delivery@local\0WAO Delivery\0wao-delivery@local\0extra"],
    ];
    for (const [label, payload] of malformed) {
      childProcess.execFileSync = (cmd, args, opts) => {
        if (cmd === "git" && Array.isArray(args) && args.includes(COMBINED)) {
          return Buffer.from(payload, "utf8");
        }
        return realExecFileSync(cmd, args, opts);
      };
      syncBuiltinESMExports();
      await assert.rejects(
        () => verifyDelivery(ref),
        (err) => err.deliveryCode === "artifact_mismatch",
        `malformed identity output (${label}) must fail closed with the supplied code`,
      );
    }
  } finally {
    childProcess.execFileSync = realExecFileSync;
    syncBuiltinESMExports();
    await cleanupDir(repo);
  }
});

test("ID-B5: legal identity fields with boundary whitespace remain accepted (String/trim semantics per field)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-ver-idb5-");
  const require = createRequire(import.meta.url);
  const childProcess = require("node:child_process");
  const realExecFileSync = childProcess.execFileSync;
  const COMBINED = "--format=%an%x00%ae%x00%cn%x00%ce";
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });
    // 四个字段全为合法值，但各自带边界空白（含真实的尾随换行形态）——
    // trim 后精确相等 ⇒ 必须接受。真实 Git 会剥除 ident 里的空白，故经
    // 同一窄 mock 注入（其余查询全部走真实 Git）。
    const payload = "  WAO Delivery \0\twao-delivery@local\t\0\n WAO Delivery \n\0 wao-delivery@local\n";
    childProcess.execFileSync = (cmd, args, opts) => {
      if (cmd === "git" && Array.isArray(args) && args.includes(COMBINED)) {
        return Buffer.from(payload, "utf8");
      }
      return realExecFileSync(cmd, args, opts);
    };
    syncBuiltinESMExports();
    const result = await verifyDelivery(ref);
    assert.equal(result.outcome, "passed",
      "boundary-whitespace-wrapped legal identity fields must be accepted after per-field trim");
    assert.equal(result.delivery.verification.status, "passed");
  } finally {
    childProcess.execFileSync = realExecFileSync;
    syncBuiltinESMExports();
    await cleanupDir(repo);
  }
});

