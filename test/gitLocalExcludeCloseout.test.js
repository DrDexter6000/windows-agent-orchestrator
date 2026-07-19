// test/gitLocalExcludeCloseout.test.js
//
// M11-1B REFRAME closeout: deterministic tests for the short-transaction design.
//
// Per CTO reframe: `/.wao-worktrees/` is a STABLE hygiene rule. `git worktree
// add` failure must NOT roll it back. The exclude lock covers only exclude
// read/normalize/write/verify. There is no `prepareAndRunWorktreeAdd`.
//
// A. worktree add failure: rule stays exactly one, error propagates, no
//    rollback claimed, source status not polluted by a missing rule.
// B. real two-child-process concurrent createWorktree: both succeed, rule
//    exactly one, source git status clean.
// C. lock ownership: release never deletes a lock a new owner acquired; active
//    owner not deleted merely for exceeding stale time; corrupt/empty lock
//    recoverable after grace; no lock/temp residue on any path.
// D. exclude ensure failure (write/read-back/verify): no git worktree add,
//    bytes/absence restored, original + cleanup both surfaced on double failure.
// P2-A. duplicate exact rules converge to exactly one (byte-preserved).
// P2-B. real bindWorkspace/unbindWorkspace leaves exactly one rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ensureWaoWorktreeExclude, WAO_WORKTREE_EXCLUDE_RULE } from "../src/gitLocalExclude.js";
import { createWorktree } from "../src/isolation.js";

const RULE = WAO_WORKTREE_EXCLUDE_RULE;

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "wao-close-repo-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "t@t"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "t"', { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# x\n");
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
  return dir;
}

function excludePath(repo) { return join(repo, ".git", "info", "exclude"); }
function readExclude(repo) { const p = excludePath(repo); return existsSync(p) ? readFileSync(p, "utf8") : null; }
function writeExclude(repo, content) { writeFileSync(excludePath(repo), content); }
function countExact(content, rule = RULE) {
  if (!content) return 0;
  const stripped = content.startsWith("\uFEFF") ? content.slice(1) : content;
  return stripped.split(/\r?\n/).filter((l) => l === rule).length;
}

// ===== A. worktree add failure keeps the stable rule; error propagates =====

test("A: git worktree add failure keeps the stable rule exactly one, error propagates, source status not polluted", async () => {
  const repo = makeTempRepo();
  try {
    // Force `git worktree add` to fail by pre-creating the worktree path as a
    // non-empty dir (git refuses). createWorktree must propagate the error but
    // the exclude rule must remain exactly one (NOT rolled back).
    const wtDir = join(repo, ".wao-worktrees", "run_a_fail");
    // Pre-create with a blocker file so `git worktree add` errors.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "blocker"), "x");

    await assert.rejects(
      () => createWorktree(repo, "run_a_fail"),
      /already exists|worktree|fatal/i,
    );

    // Rule must still be exactly one (stable — not rolled back).
    assert.equal(countExact(readExclude(repo)), 1, "rule stays exactly one after worktree add failure");
    // Source git status must not be polluted by a missing rule.
    const status = execSync("git status --porcelain", { cwd: repo, encoding: "utf8" });
    assert.ok(!status.includes(".wao-worktrees"), "source git status clean after worktree add failure");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ===== B. real two-child-process concurrent createWorktree =====

test("B: two real child processes calling createWorktree concurrently both succeed, rule exactly one, source status clean", async () => {
  const repo = makeTempRepo();
  const runIds = ["run_conc_a", "run_conc_b"];
  const { pathToFileURL } = await import("node:url");
  const { writeFileSync: wfs, mkdtempSync: mktmp } = await import("node:fs");
  const scriptDir = mktmp(join(tmpdir(), "wao-conc-runner-"));
  try {
    // Write a real runner .mjs that imports isolation.js via file:// URL (ESM
    // requires URL scheme on Windows). Each child gets its runId via argv.
    const isoUrl = pathToFileURL(join(process.cwd(), "src", "isolation.js")).href;
    const runnerPath = join(scriptDir, "runner.mjs");
    wfs(runnerPath,
      `import { createWorktree } from ${JSON.stringify(isoUrl)};\n` +
      `const r = await createWorktree(process.argv[2], process.argv[3]);\n` +
      `process.stdout.write(JSON.stringify(r));\n`,
      "utf8");
    const runnerUrl = pathToFileURL(runnerPath).href;
    const runner = (runId) => new Promise((resolveP, rejectP) => {
      // Pass the real file path (Node detects .mjs as ESM); the runner's own
      // import of isolation.js uses a file:// URL internally (Windows-safe).
      const child = spawn(process.execPath, [runnerPath, repo, runId], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => { out += c; });
      child.stderr.on("data", (c) => { err += c; });
      child.on("close", (code) => {
        if (code !== 0) rejectP(new Error(`child for ${runId} exited ${code}: ${err}`));
        else resolveP(out);
      });
    });
    const [a, b] = await Promise.all([runner(runIds[0]), runner(runIds[1])]);
    const ra = JSON.parse(a);
    const rb = JSON.parse(b);
    assert.ok(existsSync(ra.path), "A worktree exists");
    assert.ok(existsSync(rb.path), "B worktree exists");
    assert.notEqual(ra.path, rb.path, "different worktree paths");
    assert.equal(countExact(readExclude(repo)), 1, "exactly one rule after two concurrent createWorktree");
    const status = execSync("git status --porcelain", { cwd: repo, encoding: "utf8" });
    assert.ok(!status.includes(".wao-worktrees"), "source git status clean after concurrent createWorktree");
    const lockPath = excludePath(repo) + ".wao-lock";
    assert.ok(!existsSync(lockPath), "no exclude lock residue after both calls done");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(scriptDir, { recursive: true, force: true });
  }
});

// ===== C. lock ownership (age-based lease; no PID/liveness) =====

test("C-1: production release does not delete a lock a new owner acquired (via injected writeExclude)", async () => {
  // Exercise the REAL production release path (not a hand-written token check).
  // Inject writeExclude so that, while the production ensureWaoWorktreeExclude
  // holds the lock (owner1 token), we overwrite the lock body with owner2's
  // token. When production's finally/release runs, it must see the mismatched
  // token and NOT delete the lock.
  const repo = makeTempRepo();
  try {
    const lockPath = excludePath(repo) + ".wao-lock";
    let hijacked = false;
    await ensureWaoWorktreeExclude(repo, {
      writeExclude: (filePath, content) => {
        // Real write of the exclude file.
        writeFileSync(filePath, content, "utf8");
        // While we hold the lock, overwrite the lock body with owner2 token
        // (simulate a new owner acquiring after a crash). Do this only once.
        if (!hijacked) {
          hijacked = true;
          writeFileSync(lockPath, JSON.stringify({ token: "owner2-hijack", ts: Date.now() }), "utf8");
        }
      },
    });
    // The lock must STILL exist after production release — owner2 owns it now.
    assert.ok(existsSync(lockPath), "production release did not delete owner2's lock (token mismatch)");
    await unlinkSafe(lockPath);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("C-2: fresh valid lease is retained (not removed) within the acquisition timeout", async () => {
  // A lock with a fresh valid token (ts within stale threshold) is a fresh
  // lease: retained. ensureWaoWorktreeExclude must time out because the fresh
  // lease is not removable, and the lock must survive.
  const repo = makeTempRepo();
  try {
    const lockPath = excludePath(repo) + ".wao-lock";
    const { open } = await import("node:fs/promises");
    // Plant a FRESH valid-token lock owned by someone else.
    const h = await open(lockPath, "wx");
    await h.writeFile(JSON.stringify({ token: "other-fresh", ts: Date.now() }), "utf8");
    await h.close();
    const start = Date.now();
    await assert.rejects(
      () => ensureWaoWorktreeExclude(repo),
      /Timed out waiting for WAO exclude lock/i,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 9000, `should wait ~lock timeout (10s); elapsed ${elapsed}ms`);
    // The fresh lease must still exist (retained, not removed by stale recovery).
    assert.ok(existsSync(lockPath), "fresh valid lease retained (not removed)");
    await unlinkSafe(lockPath);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("C-2b: valid stale lease (token older than LOCK_STALE_MS) is recovered; rule ensured; no lock residue", async () => {
  // A lock with a valid token but ts older than 60s is a stale lease: recovered.
  const repo = makeTempRepo();
  try {
    const lockPath = excludePath(repo) + ".wao-lock";
    // Plant a valid-token lock with an OLD timestamp (stale lease).
    const staleTs = Date.now() - 120000; // 120s ago, > LOCK_STALE_MS (60s)
    writeFileSync(lockPath, JSON.stringify({ token: "stale-owner", ts: staleTs }), "utf8");
    // ensureWaoWorktreeExclude should recover the stale lease and succeed.
    const r = await ensureWaoWorktreeExclude(repo);
    assert.ok(r.added || r.alreadyPresent, "recovered from stale lease and ensured rule");
    assert.equal(countExact(readExclude(repo)), 1, "rule ensured after stale-lease recovery");
    // No lock residue (the stale lock was removed; the new owner's release cleaned up).
    assert.ok(!existsSync(lockPath), "no lock residue after stale-lease recovery");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("C-3: empty/corrupt lock recoverable after grace window; no permanent stuck", async () => {
  const repo = makeTempRepo();
  try {
    const lockPath = excludePath(repo) + ".wao-lock";
    // Plant a corrupt (non-JSON) lock with an OLD mtime (beyond grace).
    writeFileSync(lockPath, "not-json-garbage");
    const oldTime = (Date.now() - 10000) / 1000; // 10s ago, > grace (5s)
    const { utimes } = await import("node:fs/promises");
    await utimes(lockPath, oldTime, oldTime);
    const r = await ensureWaoWorktreeExclude(repo);
    assert.ok(r.added || r.alreadyPresent, "recovered from corrupt stale lock and ensured rule");
    assert.equal(countExact(readExclude(repo)), 1, "rule ensured after corrupt-lock recovery");
    assert.ok(!existsSync(lockPath), "no lock residue after recovery");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

async function unlinkSafe(p) { try { const { unlink } = await import("node:fs/promises"); await unlink(p); } catch {} }

// ===== D. exclude ensure failure: no worktree add, bytes restored, double-fail surfaced =====

test("D-1: injected readExclude throw → no rule residue, no worktree add, no temp", async () => {
  const repo = makeTempRepo();
  try {
    const pre = "user-rule\n";
    writeExclude(repo, pre);
    const infoDir = join(repo, ".git", "info");
    const beforeEntries = readdirSync(infoDir).filter((e) => e !== "exclude.wao-lock");
    await assert.rejects(
      () => ensureWaoWorktreeExclude(repo, {
        readExclude: () => { throw new Error("injected read-back failure"); },
      }),
      /read-back|verify|exclude/i,
    );
    assert.equal(readExclude(repo), pre, "pre-call bytes restored (no rule residue)");
    assert.deepEqual(
      readdirSync(infoDir).filter((e) => e !== "exclude.wao-lock"),
      beforeEntries,
      "no temp file left",
    );
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("D-2: read-back throw AND rollback failure → both errors surfaced", async () => {
  const repo = makeTempRepo();
  try {
    const pre = "user-rule\n";
    writeExclude(repo, pre);
    await assert.rejects(
      () => ensureWaoWorktreeExclude(repo, {
        readExclude: () => { throw new Error("injected read-back failure"); },
        writeExclude: () => { throw new Error("injected restore failure"); },
      }),
      (err) => {
        const msg = String(err.message);
        return /read-back|verify|exclude/i.test(msg) && /restore|cleanup/i.test(msg);
      },
      "both original and cleanup failures must be surfaced",
    );
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ===== P2-A: duplicate convergence =====

test("P2-A-1: two pre-existing exact rules converge to exactly one, non-WAO lines byte-preserved", async () => {
  const repo = makeTempRepo();
  try {
    const dup = "user-keep-1\n" + RULE + "\nsome-other\n" + RULE + "\nuser-keep-2\n";
    writeExclude(repo, dup);
    const r = await ensureWaoWorktreeExclude(repo);
    const after = readExclude(repo);
    assert.equal(countExact(after), 1, "must converge to exactly one WAO rule");
    for (const userLine of ["user-keep-1", "some-other", "user-keep-2"]) {
      assert.ok(after.includes(userLine), `non-WAO line preserved: ${userLine}`);
    }
    assert.equal(r.repaired, true, "reported as repaired (collapsed duplicates)");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("P2-A-2: BOM immediately followed by the rule — idempotent, BOM preserved, exactly one rule", async () => {
  const repo = makeTempRepo();
  try {
    const BOM = "\uFEFF";
    writeExclude(repo, BOM + RULE + "\nuser-after\n");
    const r1 = await ensureWaoWorktreeExclude(repo);
    const r2 = await ensureWaoWorktreeExclude(repo);
    const after = readExclude(repo);
    assert.ok(after.startsWith(BOM), "BOM preserved at start");
    assert.equal(countExact(after), 1, "exactly one rule after idempotent re-call");
    assert.ok(after.includes("user-after"), "user line preserved");
    assert.equal(r1.alreadyPresent, true);
    assert.equal(r2.alreadyPresent, true);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ===== P2-B: real bindWorkspace/unbindWorkspace interop =====

test("P2-B: real bindWorkspace then unbindWorkspace leaves exactly one /.wao-worktrees/ rule", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-close-bind-"));
  try {
    execSync("git init -b main", { cwd: dir, stdio: "ignore" });
    execSync('git config user.email "t@t"', { cwd: dir, stdio: "ignore" });
    execSync('git config user.name "t"', { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "README.md"), "# x\n");
    execSync("git add .", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });

    await ensureWaoWorktreeExclude(dir);
    const targetExclude = join(dir, ".git", "info", "exclude");
    assert.equal(countExact(readFileSync(targetExclude, "utf8")), 1, "WAO rule present after hygiene");

    const { bindWorkspace, unbindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    const fk = fakeCodexHooks();
    await bindWorkspace({ host: "codex", cwd: dir, hooks: fk });

    let content = readFileSync(targetExclude, "utf8");
    assert.equal(countExact(content), 1, "WAO rule still exactly one after Codex bind");
    assert.ok(content.includes("# >>> WAO MANAGED"), "Codex marker block added");

    await unbindWorkspace({ host: "codex", cwd: dir, hooks: fk });

    content = readFileSync(targetExclude, "utf8");
    assert.equal(countExact(content), 1, "WAO rule still exactly one after Codex unbind");
    assert.ok(!content.includes("# >>> WAO MANAGED"), "Codex marker block removed by unbind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeCodexHooks(initialServers = []) {
  const servers = new Map();
  for (const s of initialServers) servers.set(s.name, s);
  return {
    codexList: async () => [...servers.values()],
    codexGet: async ({ name }) => servers.get(name) ?? null,
    codexAdd: async ({ name, command, args }) => {
      servers.set(name, {
        name, enabled: true,
        transport: { type: "stdio", command, args, env: null, env_vars: [], cwd: null },
      });
    },
    codexRemove: async ({ name }) => { servers.delete(name); },
  };
}
