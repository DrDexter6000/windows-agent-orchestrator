// test/delivery/verificationTailCapture.test.js
//
// R17 / TD-130 W1: bounded failure-diagnostic output tails on delivery
// verification results.
//
// Contract under test (src/deliveryVerification.js):
//   - runVerificationCommand ALWAYS returns additive `stdoutTail`/`stderrTail`
//     string fields. They carry content ONLY on a non-success outcome
//     (non-zero exit, timeout, launch error); a green command records empty
//     strings — success keeps the byte-count-only contract pinned by
//     3B-07/3B-25 (no output body on passing results).
//   - Each tail retains at most TAIL_MAX_BYTES (8192) bytes of raw output,
//     prefixed with an explicit `…[truncated N bytes]` marker (N = exact
//     dropped byte count) when output was dropped.
//   - _recordResult (the persistence seam used for BOTH assertion and setup
//     results) passes failure tails through verbatim, normalizes missing tail
//     fields (legacy injected runners) to "", and structurally enforces the
//     green-no-tail contract even if a custom runner reports content on a
//     success-shaped result.
//   - Serialization: the whole delivery payload (tails included) rides the
//     transcript append path, which applies the existing exact-secret
//     redactor to every string — a literal secret inside a tail is rewritten
//     to its [REDACTED:NAME] marker before hitting disk.
//
// The MCP run_delivery boundary is NOT widened here: verificationFailureSummary
// stays the strict 8-key scalar object (guarded separately in
// m11-12b-verificationSummary.test.js).

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { packageDelivery } from "../../src/delivery.js";
import { verifyDelivery, runVerificationCommand } from "../../src/deliveryVerification.js";
import { JsonlTranscript } from "../../src/transcript.js";

// ===== Helpers =====

const RUN_ID = "run_r17tail001";
const TAIL_MAX_BYTES = 8192;

/** Temp scratch cwd for direct runner tests (no git needed). */
async function makeScratchDir(prefix = "wao-r17-tail-") {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Create a temp git repo with initial structure + a linked worktree. */
async function makeRepoWithWorktree(prefix = "wao-r17-repo-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@test"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: dir, stdio: "ignore" });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.js"), "const a = 1;\n");
  await writeFile(join(dir, ".gitignore"), "node_modules/\n*.log\nbuild/\n");
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync("git commit -m init", { cwd: dir, stdio: "ignore" });
  const baseCommit = execSync("git rev-parse HEAD", {
    cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  const wtPath = join(dir, ".wao-worktrees", RUN_ID);
  execSync(`git worktree add "${wtPath}" -b wao/${RUN_ID}`, { cwd: dir, stdio: "ignore" });
  return { repo: dir, baseCommit, wtPath };
}

/** Create a committed DeliveryRef by writing to the worktree and packaging. */
function makeDeliveryRef(wtPath, baseCommit, opts = {}) {
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

/** Clean up a temp dir with bounded retry (Windows handle-release tolerance). */
async function cleanupDir(dir) {
  try { execSync("git worktree prune", { cwd: dir, stdio: "ignore" }); } catch { /* best effort */ }
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await rm(dir, { recursive: true, force: true }); return; }
    catch { if (attempt === 4) return; await new Promise(r => setTimeout(r, 50 * (attempt + 1))); }
  }
}

// =====================================================================
// A. Real runner: runVerificationCommand direct (the spawn-based seam)
// =====================================================================

test("R17-T1: failing command carries distinct stdout/stderr tail content", async () => {
  const dir = await makeScratchDir("wao-r17-t1-");
  try {
    const r = await runVerificationCommand(
      'node -e "process.stdout.write(\'OUT-R17-AAA\'); process.stderr.write(\'ERR-R17-BBB\'); process.exit(3)"',
      dir,
      { timeoutMs: 30_000 },
    );
    assert.equal(r.exitCode, 3);
    assert.equal(r.timedOut, false);
    assert.ok(r.stdoutBytes > 0);
    assert.ok(r.stderrBytes > 0);
    assert.ok(r.stdoutTail.includes("OUT-R17-AAA"), "stdout tail carries stdout content");
    assert.ok(r.stderrTail.includes("ERR-R17-BBB"), "stderr tail carries stderr content");
    assert.ok(!r.stdoutTail.includes("ERR-R17-BBB"), "streams do not cross-contaminate");
    assert.ok(!r.stderrTail.includes("OUT-R17-AAA"), "streams do not cross-contaminate");
    assert.ok(!r.stdoutTail.includes("truncated"), "small output is not marked truncated");
  } finally {
    await cleanupDir(dir);
  }
});

test("R17-T2: succeeding command with output → tail fields present but EMPTY (green stays byte-counted)", async () => {
  const dir = await makeScratchDir("wao-r17-t2-");
  try {
    const r = await runVerificationCommand(
      'node -e "process.stdout.write(\'GREEN-R17-OUT\'); process.stderr.write(\'GREEN-R17-ERR\')"',
      dir,
      { timeoutMs: 30_000 },
    );
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdoutBytes > 0, "byte counts still recorded");
    assert.ok(r.stderrBytes > 0, "byte counts still recorded");
    // Fields exist (additive shape) but carry no content on success.
    assert.equal(r.stdoutTail, "", "green stdout tail must be empty");
    assert.equal(r.stderrTail, "", "green stderr tail must be empty");
  } finally {
    await cleanupDir(dir);
  }
});

test("R17-T3: output beyond the cap → bounded tail + exact truncation marker", async () => {
  const dir = await makeScratchDir("wao-r17-t3-");
  try {
    const total = 20_000;
    const r = await runVerificationCommand(
      `node -e "process.stdout.write('A'.repeat(${total})); process.exit(1)"`,
      dir,
      { timeoutMs: 30_000 },
    );
    assert.equal(r.exitCode, 1);
    assert.equal(r.stdoutBytes, total, "all bytes counted");
    const marker = `…[truncated ${total - TAIL_MAX_BYTES} bytes]`;
    assert.ok(r.stdoutTail.startsWith(`${marker}\n`), `tail must start with the exact marker; got head: ${JSON.stringify(r.stdoutTail.slice(0, 60))}`);
    const body = r.stdoutTail.slice(r.stdoutTail.indexOf("\n") + 1);
    assert.equal(Buffer.byteLength(body, "utf8"), TAIL_MAX_BYTES, "retained body is exactly the cap");
    assert.ok(/^A+$/.test(body), "the LAST bytes are retained (tail semantics)");
    assert.equal(r.stderrTail, "", "stderr had no output → empty string shape");
  } finally {
    await cleanupDir(dir);
  }
});

test("R17-T4: failing command with zero output → empty-string tails (shape stability)", async () => {
  const dir = await makeScratchDir("wao-r17-t4-");
  try {
    const r = await runVerificationCommand("node -e \"process.exit(7)\"", dir, { timeoutMs: 30_000 });
    assert.equal(r.exitCode, 7);
    assert.equal(r.stdoutBytes, 0);
    assert.equal(r.stderrBytes, 0);
    assert.equal(r.stdoutTail, "");
    assert.equal(r.stderrTail, "");
  } finally {
    await cleanupDir(dir);
  }
});

test("R17-T5: timeout retains the partial output emitted before the kill", async () => {
  const dir = await makeScratchDir("wao-r17-t5-");
  try {
    const r = await runVerificationCommand(
      'node -e "process.stdout.write(\'PARTIAL-R17\'); process.stdout.write(\'-BEFORE-KILL\'); setTimeout(()=>{},60000)"',
      dir,
      { timeoutMs: 1_500 },
    );
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
    assert.ok(r.stdoutTail.includes("PARTIAL-R17-BEFORE-KILL"),
      `partial pre-kill output must survive in the tail; got ${JSON.stringify(r.stdoutTail)}`);
  } finally {
    await cleanupDir(dir);
  }
});

// =====================================================================
// B. verifyDelivery persistence seam (_recordResult) via injected runners
// =====================================================================

test("R17-T6: fake-runner failure tails pass through verbatim into verification.results", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-r17-t6-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["npm test"] });
    const result = await verifyDelivery(ref, {
      runCommand: async () => ({
        exitCode: 1, signal: null, timedOut: false, durationMs: 42,
        stdoutBytes: 3, stderrBytes: 4,
        stdoutTail: "TAP-stdout-fragment", stderrTail: "TAP-stderr-fragment",
      }),
    });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "command_failed");
    const r = result.delivery.verification.results[0];
    assert.equal(r.stdoutTail, "TAP-stdout-fragment");
    assert.equal(r.stderrTail, "TAP-stderr-fragment");
    // Additive: the pre-existing scalar facts are unchanged.
    assert.equal(r.exitCode, 1);
    assert.equal(r.stderrBytes, 4);
  } finally {
    await cleanupDir(repo);
  }
});

test("R17-T7: legacy fake runner without tail fields normalizes to empty strings (same result shape)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-r17-t7-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["npm test"] });
    const result = await verifyDelivery(ref, {
      runCommand: async () => ({ exitCode: 2, signal: null, timedOut: false, durationMs: 5, stdoutBytes: 0, stderrBytes: 9 }),
    });
    assert.equal(result.outcome, "failed");
    const r = result.delivery.verification.results[0];
    assert.equal(r.stdoutTail, "");
    assert.equal(r.stderrTail, "");
    assert.ok("stdoutTail" in r && "stderrTail" in r, "fields present even when the runner omits them");
  } finally {
    await cleanupDir(repo);
  }
});

test("R17-T8: success-shaped result with reported tails records EMPTY tails (structural green gate)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-r17-t8-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, { verificationCommands: ["npm test"] });
    const result = await verifyDelivery(ref, {
      runCommand: async () => ({
        exitCode: 0, signal: null, timedOut: false, durationMs: 5, stdoutBytes: 10, stderrBytes: 0,
        stdoutTail: "should-not-persist", stderrTail: "neither-should-this",
      }),
    });
    assert.equal(result.outcome, "passed");
    const r = result.delivery.verification.results[0];
    assert.equal(r.stdoutTail, "", "green result must never persist output content");
    assert.equal(r.stderrTail, "", "green result must never persist output content");
    const dumped = JSON.stringify(result);
    assert.ok(!dumped.includes("should-not-persist"), "no green output body anywhere in the result");
  } finally {
    await cleanupDir(repo);
  }
});

test("R17-T10: setup-phase failure carries tails in setupResults (same seam, phase-aware)", async () => {
  const { repo, baseCommit, wtPath } = await makeRepoWithWorktree("wao-r17-t10-");
  try {
    await writeFile(join(wtPath, "src", "a.js"), "modified\n");
    const ref = makeDeliveryRef(wtPath, baseCommit, {
      verificationCommands: ["npm test"],
      verificationSetupCommands: ["npm ci"],
    });
    const result = await verifyDelivery(ref, {
      runCommand: async () => ({
        exitCode: 1, signal: null, timedOut: false, durationMs: 7, stdoutBytes: 2, stderrBytes: 5,
        stdoutTail: "", stderrTail: "setup-err-tail",
      }),
    });
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, "setup_failed");
    assert.equal(result.delivery.verification.setupResults[0].stderrTail, "setup-err-tail");
    // Assertions never ran → no assertion results, no tail leakage there.
    assert.deepEqual(result.delivery.verification.results, []);
  } finally {
    await cleanupDir(repo);
  }
});

// =====================================================================
// C. Serialization path: transcript append round-trip + redaction
// =====================================================================

test("R17-T9: transcript append persists tails through JSON and exact-secret-redacts them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r17-t9-"));
  const SECRET_NAME = "WAO_R17_TAIL_SECRET";
  const SECRET_VALUE = "r17-tail-secret-abcdef";
  process.env[SECRET_NAME] = SECRET_VALUE;
  try {
    // The transcript's redactor snapshots process.env at construction — the
    // secret must be present BEFORE the JsonlTranscript is built.
    const transcript = new JsonlTranscript(join(dir, `${RUN_ID}.jsonl`), {
      runId: RUN_ID, agentId: "lead_agent",
    });
    const delivery = {
      schemaVersion: 1,
      kind: "git_commit",
      runId: RUN_ID,
      deliveryCommit: "d".repeat(40),
      baseCommit: "b".repeat(40),
      changedFiles: ["src/a.js"],
      verification: {
        status: "failed",
        commands: ["npm test"],
        verifiedCommit: "d".repeat(40),
        timeoutMs: 300000,
        results: [{
          index: 0,
          command: "npm test",
          exitCode: 1,
          signal: null,
          timedOut: false,
          durationMs: 722709,
          stdoutBytes: 1024,
          stderrBytes: 1150,
          stdoutTail: "",
          stderrTail: `npm error boom ${SECRET_VALUE} tail-end`,
        }],
        failureCode: "command_failed",
        failedCommandIndex: 0,
      },
    };
    await transcript.append("run.delivery_verification_failed", { delivery });
    const line = readFileSync(join(dir, `${RUN_ID}.jsonl`), "utf8").trim();
    // Round-trip: the tail field survives JSON serialization.
    const event = JSON.parse(line);
    const r = event.delivery.verification.results[0];
    assert.equal(r.durationMs, 722709);
    assert.ok(r.stderrTail.includes("npm error boom"));
    assert.ok(r.stderrTail.endsWith("tail-end"));
    // Redaction: the literal secret value is rewritten, the marker survives.
    assert.ok(!line.includes(SECRET_VALUE), "literal secret inside a tail must not hit disk");
    assert.ok(r.stderrTail.includes(`[REDACTED:${SECRET_NAME}]`), "exact-secret redactor rewrites the tail in place");
  } finally {
    delete process.env[SECRET_NAME];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
