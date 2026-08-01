import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { packageDelivery, prepareDeliveryRequest } from "../src/delivery.js";
import { verifyDelivery } from "../src/deliveryVerification.js";

// M12-6 Package 3A — exact-artifact verifier environment contract (FR-05/FR-06).
//
// These tests pin the frozen CTO contract:
//   - verificationSetupCommands is an optional Lead-authored input that runs
//     sequentially BEFORE assertion commands; absence is byte-level zero drift.
//   - setup failure is a closed, actionable, safe set (setup_failed /
//     setup_timeout / setup_environment_error) — NEVER disguised as assertion
//     command_failed. Commands/paths/stderr never leak.
//   - every setup AND assertion command is followed by an exact delivery-commit
//     / tracked-artifact proof; tracked-artifact or lockfile drift is
//     artifact_mutated, and on setup drift assertions do NOT run.
//   - each attempt gets a unique temp dir injected as TMP/TEMP (+TMPDIR on
//     POSIX); two attempts never reuse one. Environment facts bind to
//     deliveryCommit and persist only safe fields (no absolute paths).

// ===== Helpers =====

const RUN_ID = "run_m126setup";
const BRANCH = `wao/${RUN_ID}`;

/** Create a temp git repo with a linked worktree. Optionally add a lockfile. */
async function makeRepoWithWorktree(prefix = "wao-m126-repo-", opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@test"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: dir, stdio: "ignore" });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.js"), "const a = 1;\n");
  await writeFile(join(dir, ".gitignore"), "node_modules/\n*.log\nbuild/\n");
  if (opts.lockfile) {
    await writeFile(join(dir, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  }
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
  const baseCommit = execSync("git rev-parse HEAD", {
    cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  const wtPath = join(dir, ".wao-worktrees", RUN_ID);
  execSync(`git worktree add "${wtPath}" -b ${BRANCH}`, { cwd: dir, stdio: "ignore" });
  return { repo: dir, baseCommit, wtPath };
}

/** Package a committed DeliveryRef from a worktree change. */
function makeDeliveryRef(wtPath, baseCommit, opts = {}) {
  return packageDelivery({
    runId: RUN_ID,
    worktreePath: wtPath,
    baseCommit,
    allowedPaths: ["src"],
    isolation: { type: "worktree", strategy: "persistent" },
    verificationCommands: opts.verificationCommands ?? ["echo ok"],
    ...(opts.verificationSetupCommands
      ? { verificationSetupCommands: opts.verificationSetupCommands }
      : {}),
    ...opts,
  });
}

async function cleanupDir(dir) {
  try { execSync("git worktree prune", { cwd: dir, stdio: "ignore" }); } catch { /* best effort */ }
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await rm(dir, { recursive: true, force: true }); return; }
    catch { if (attempt === 4) return; await new Promise((r) => setTimeout(r, 50 * (attempt + 1))); }
  }
}

/** Fake runCommand that records the env it was handed and returns exit 0. */
function recordingRunner(log) {
  return async (command, cwd, opts = {}) => {
    log.push({ command, env: opts.env ?? null });
    return { exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 };
  };
}

// ===== Contract #1: no setup → zero drift =====

test("M126-01: no setupCommands → verifier behavior unchanged (passed, single result)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-m126-01-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["echo ok"] });
    const result = await verifyDelivery(ref);
    assert.equal(result.outcome, "passed");
    assert.equal(result.failureCode, undefined);
    assert.equal(result.delivery.verification.results.length, 1);
    assert.equal(result.delivery.verification.results[0].exitCode, 0);
    // setup arrays are absent when none were declared
    assert.ok(!Array.isArray(result.delivery.verification.setupCommands),
      "setupCommands must be absent when none declared");
    assert.ok(!Array.isArray(result.delivery.verification.setupResults),
      "setupResults must be absent when no setup ran");
  } finally {
    await cleanupDir(repo);
  }
});

test("M126-02: no setupCommands → closed-set failure code stays command_failed", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-m126-02-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["exit 7"] });
    const result = await verifyDelivery(ref);
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "command_failed");
  } finally {
    await cleanupDir(repo);
  }
});

// ===== Contract #3: setup runs sequentially before assertions; order observable =====

test("M126-03: setup commands execute before assertion commands (order)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-m126-03-");
  const calls = [];
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationSetupCommands: ["setup-one", "setup-two"],
      verificationCommands: ["assert-one"],
    });
    const result = await verifyDelivery(ref, { runCommand: recordingRunner(calls) });
    assert.equal(result.outcome, "passed");
    assert.deepEqual(calls.map((c) => c.command),
      ["setup-one", "setup-two", "assert-one"],
      "setup must run in order before assertions");
  } finally {
    await cleanupDir(repo);
  }
});

// ===== Contract #3: setup failure vs assertion failure are distinguishable =====

test("M126-04: setup command non-zero → setup_failed, assertions NOT run", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-m126-04-");
  const calls = [];
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationSetupCommands: ["failing-setup"],
      verificationCommands: ["assert-should-not-run"],
    });
    const result = await verifyDelivery(ref, {
      runCommand: async (command) => {
        calls.push(command);
        return command === "failing-setup"
          ? { exitCode: 3, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 }
          : { exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 };
      },
    });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "setup_failed",
      "setup non-zero must be setup_failed, NOT command_failed");
    assert.deepEqual(calls, ["failing-setup"], "assertions must not run after setup failure");
    assert.equal(result.delivery.verification.failedPhase, "setup");
  } finally {
    await cleanupDir(repo);
  }
});

test("M126-05: setup timeout → setup_timeout (not command_timeout/execution_error)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-m126-05-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationSetupCommands: ["slow-setup"],
      verificationCommands: ["assert-x"],
    });
    const result = await verifyDelivery(ref, {
      runCommand: async () => ({ exitCode: null, signal: null, timedOut: true, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 }),
    });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "setup_timeout");
    assert.equal(result.delivery.verification.failedPhase, "setup");
  } finally {
    await cleanupDir(repo);
  }
});

test("M126-06: setup launch error → setup_environment_error (not execution_error)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-m126-06-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationSetupCommands: ["missing-binary"],
      verificationCommands: ["assert-x"],
    });
    const result = await verifyDelivery(ref, {
      runCommand: async () => ({ exitCode: null, signal: null, timedOut: false, durationMs: 0, stdoutBytes: 0, stderrBytes: 0, launchError: true }),
    });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "setup_environment_error",
      "structured launch error in setup must project as environment/tooling, not execution_error");
    assert.equal(result.delivery.verification.failedPhase, "setup");
  } finally {
    await cleanupDir(repo);
  }
});

test("M126-07: setup passes, assertion fails → command_failed (assertion code, failedPhase assertion)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-m126-07-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationSetupCommands: ["setup-ok"],
      verificationCommands: ["assert-fail"],
    });
    const result = await verifyDelivery(ref, {
      runCommand: async (command) => ({
        exitCode: command === "assert-fail" ? 1 : 0,
        signal: null, timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0,
      }),
    });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "command_failed",
      "assertion failure stays command_failed even with setup present (zero drift)");
    assert.equal(result.delivery.verification.failedPhase, "assertion");
    // setup results are recorded even though assertion failed
    assert.equal(result.delivery.verification.setupResults.length, 1);
  } finally {
    await cleanupDir(repo);
  }
});

// ===== Contract #4: setup mutating tracked file / lockfile → artifact_mutated =====

test("M126-08: setup modifies tracked file → artifact_mutated, assertions not run", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-m126-08-");
  const calls = [];
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationSetupCommands: ["mutating-setup"],
      verificationCommands: ["assert-should-not-run"],
    });
    const result = await verifyDelivery(ref, {
      runCommand: async (command, cwd) => {
        calls.push(command);
        if (command === "mutating-setup") {
          await writeFile(join(cwd, "src", "a.js"), "corrupted by setup\n");
        }
        return { exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 };
      },
    });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "artifact_mutated",
      "setup tracked-file drift must be artifact_mutated, not setup_failed");
    assert.deepEqual(calls, ["mutating-setup"], "assertions must not run after setup artifact drift");
    assert.equal(result.delivery.verification.failedPhase, "setup");
  } finally {
    await cleanupDir(repo);
  }
});

test("M126-09: setup modifies lockfile → artifact_mutated", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-m126-09-", { lockfile: true });
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationSetupCommands: ["npm-installish"],
      verificationCommands: ["assert-x"],
    });
    const result = await verifyDelivery(ref, {
      // The lockfile mutation is gated on the SETUP command only — the
      // assertion must be a no-op. This forces the test to prove setup-phase
      // drift (not assertion-phase), so it is a true RED while setup is
      // unimplemented (setup never runs → no drift → outcome passed).
      runCommand: async (command, cwd) => {
        if (command === "npm-installish") {
          await writeFile(join(cwd, "package-lock.json"), '{ "lockfileVersion": 3, "changed": true }\n');
        }
        return { exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 };
      },
    });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "artifact_mutated",
      "lockfile drift in setup must be artifact_mutated");
  } finally {
    await cleanupDir(repo);
  }
});

test("M126-10: setup creates only ignored dependency → passes (allowed setup output)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-m126-10-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationSetupCommands: ["install-deps"],
      verificationCommands: ["echo ok"],
    });
    const result = await verifyDelivery(ref, {
      // node_modules creation is gated on the SETUP command (gitignored — a
      // typical setup-installed dependency); the assertion is a no-op. This is a
      // positive-invariant test: ignored setup output must never count as drift,
      // so it passes both before (no setup runs) and after GREEN (setup runs).
      runCommand: async (command, cwd) => {
        if (command === "install-deps") {
          await mkdir(join(cwd, "node_modules", "some-pkg"), { recursive: true });
          await writeFile(join(cwd, "node_modules", "some-pkg", "index.js"), "module.exports = 1;\n");
        }
        return { exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 };
      },
    });
    assert.equal(result.outcome, "passed",
      "ignored dependency created by setup must not count as artifact drift");
  } finally {
    await cleanupDir(repo);
  }
});

test("M126-11: assertion modifies tracked file → artifact_mutated (setup unaffected)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-m126-11-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationSetupCommands: ["setup-ok"],
      verificationCommands: ["mutating-assert"],
    });
    const result = await verifyDelivery(ref, {
      runCommand: async (command, cwd) => {
        if (command === "mutating-assert") {
          await writeFile(join(cwd, "src", "a.js"), "corrupted by assertion\n");
        }
        return { exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 };
      },
    });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "artifact_mutated");
    assert.equal(result.delivery.verification.failedPhase, "assertion");
  } finally {
    await cleanupDir(repo);
  }
});

// ===== Contract #5: unique TMP/TEMP per attempt; no reuse; no path leakage =====

test("M126-12: two attempts receive distinct TMP/TEMP env values (no reuse)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-m126-12-");
  const temps = [];
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationSetupCommands: ["setup-a"],
      verificationCommands: ["assert-a"],
    });
    await verifyDelivery(ref, {
      runCommand: async (_command, _cwd, opts = {}) => {
        temps.push({ tmp: opts.env?.TMP, temp: opts.env?.TEMP });
        return { exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 };
      },
    });
    assert.equal(temps.length, 2);
    assert.ok(typeof temps[0].tmp === "string" && temps[0].tmp.length > 0, "TMP must be injected");
    assert.ok(typeof temps[0].temp === "string" && temps[0].temp.length > 0, "TEMP must be injected");
    assert.notEqual(temps[0].tmp, temps[1].tmp, "each attempt must get a UNIQUE temp dir");
    assert.equal(temps[0].tmp, temps[0].temp, "TMP and TEMP point at the same per-attempt dir");
  } finally {
    await cleanupDir(repo);
  }
});

test("M126-13: real subprocess observes the injected unique TMP per attempt", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-m126-13-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationSetupCommands: [
        "node -e \"require('fs').mkdirSync('build',{recursive:true});require('fs').writeFileSync('build/m1.txt', process.env.TMP||'')\"",
      ],
      verificationCommands: [
        "node -e \"require('fs').mkdirSync('build',{recursive:true});require('fs').writeFileSync('build/m2.txt', process.env.TMP||'')\"",
      ],
    });
    const result = await verifyDelivery(ref);
    assert.equal(result.outcome, "passed");
    const t1 = await readFile(join(wtPath, "build", "m1.txt"), "utf8");
    const t2 = await readFile(join(wtPath, "build", "m2.txt"), "utf8");
    assert.ok(t1.length > 0, "subprocess must see a non-empty TMP");
    assert.notEqual(t1, t2, "two real attempts must observe distinct TMP values");
  } finally {
    await cleanupDir(repo);
  }
});

test("M126-14: DeliveryRef persists safe environment facts, no absolute temp path leaks", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-m126-14-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationSetupCommands: ["setup-ok"],
      verificationCommands: ["echo ok"],
    });
    const result = await verifyDelivery(ref);
    // Safe environment facts bound to the delivery commit.
    const env = result.delivery.verification.environment;
    assert.ok(env && typeof env === "object", "verification must persist environment facts");
    assert.equal(env.tempPerAttempt, true);
    // The persisted environment fact must not carry any absolute temp path: only
    // safe boolean scalars are allowed (no path string fields at all).
    for (const key of Object.keys(env)) {
      const val = env[key];
      assert.ok(typeof val === "boolean" || (typeof val === "string" && val.length <= 32),
        `environment field "${key}" must be a safe scalar, not an absolute path`);
    }
    assert.equal(env.tempDir, undefined, "no absolute tempDir path may persist");
    assert.equal(env.tmpPath, undefined, "no absolute tmp path may persist");
    // deliveryCommit identity preserved
    assert.equal(result.delivery.deliveryCommit, ref.deliveryCommit);
  } finally {
    await cleanupDir(repo);
  }
});

// ===== Contract #2/#3: no command/path/stderr leakage on setup failure =====

test("M126-15: setup failure result leaks no command body beyond setupResults.command, no stderr/stdout body", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-m126-15-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const sentinel = "M126_SECRET_STDERR";
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationSetupCommands: ["leaky-setup"],
      verificationCommands: ["assert-x"],
    });
    const result = await verifyDelivery(ref, {
      runCommand: async () => ({ exitCode: 2, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 5, stderrBytes: 9 }),
    });
    const json = JSON.stringify(result);
    // sentinel never appears anywhere (it was never even passed as a value here,
    // but assert the result carries no stdout/stderr body fields at all)
    assert.ok(!json.includes(sentinel));
    for (const r of result.delivery.verification.setupResults) {
      assert.ok(!("stdout" in r), "no stdout body field on setup result");
      assert.ok(!("stderr" in r), "no stderr body field on setup result");
    }
  } finally {
    await cleanupDir(repo);
  }
});

// ===== Contract #1/#8: input plumbing — prepareDeliveryRequest accepts setup =====

test("M126-16: prepareDeliveryRequest accepts verificationSetupCommands", () => {
  const prepared = prepareDeliveryRequest({
    mode: "git_commit_v1",
    allowedPaths: ["src"],
    verificationSetupCommands: ["npm ci", "node -e \"1\""],
    verificationCommands: ["npm test"],
  });
  assert.deepEqual(prepared.verification.setupCommands, ["npm ci", "node -e \"1\""]);
  assert.deepEqual(prepared.verification.commands, ["npm test"]);
});

test("M126-17: prepareDeliveryRequest rejects invalid setup (non-array / empty strings)", () => {
  assert.throws(
    () => prepareDeliveryRequest({
      mode: "git_commit_v1", allowedPaths: ["src"],
      verificationSetupCommands: "npm ci",
      verificationCommands: ["npm test"],
    }),
    (err) => err.deliveryCode === "invalid_verification",
  );
  assert.throws(
    () => prepareDeliveryRequest({
      mode: "git_commit_v1", allowedPaths: ["src"],
      verificationSetupCommands: ["   "],
      verificationCommands: ["npm test"],
    }),
    (err) => err.deliveryCode === "invalid_verification",
  );
});

test("M126-18: prepareDeliveryRequest rejects absolute path literals in setup commands", () => {
  assert.throws(
    () => prepareDeliveryRequest({
      mode: "git_commit_v1", allowedPaths: ["src"],
      verificationSetupCommands: ["node C:\\outside\\hook.js"],
      verificationCommands: ["npm test"],
    }),
    (err) => err.deliveryCode === "invalid_verification_path",
  );
});

test("M126-19: setup declared but no assertion commands → setup does not run (unavailable path unchanged)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-m126-19-");
  const calls = [];
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = packageDelivery({
      runId: RUN_ID, worktreePath: wtPath, baseCommit,
      allowedPaths: ["src"],
      isolation: { type: "worktree", strategy: "persistent" },
      verificationSetupCommands: ["setup-would-be-pointless"],
      verificationUnavailableReason: "no test suite",
    });
    const result = await verifyDelivery(ref, {
      runCommand: async (command) => { calls.push(command); return { exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 }; },
    });
    assert.equal(result.outcome, "unavailable");
    assert.deepEqual(calls, [], "setup must not run when there are no assertion commands");
  } finally {
    await cleanupDir(repo);
  }
});

test("M126-20: input DeliveryRef is not mutated by verifyDelivery (setup path)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-m126-20-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationSetupCommands: ["setup-ok"],
      verificationCommands: ["echo ok"],
    });
    const snap = JSON.parse(JSON.stringify(ref));
    await verifyDelivery(ref);
    assert.deepEqual(ref, snap, "input ref must not be mutated");
  } finally {
    await cleanupDir(repo);
  }
});
