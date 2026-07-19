// test/gitLocalExcludeCloseout.test.js
//
// M11-1B CTO closeout: deterministic RED tests for four contract gaps.
//
// P1-A: interleaved concurrent success/failure must not delete a rule another
//       successful caller depends on (source git status must stay clean).
//       Uses prepareAndRunWorktreeAdd; the runWorktreeAdd callback deterministically
//       creates B's worktree before failing A's own add.
// P1-B: injected read-back throw must roll back to pre-call exact bytes/absence,
//       never call worktree add, leave no temp, and surface both errors if
//       rollback also fails.
// P2-A: pre-existing duplicate exact rules must converge to exactly one, while
//       preserving every non-WAO line byte-for-byte (incl. BOM/newline).
// P2-B: HYGIENE-12 exercises the real bindWorkspace/unbindWorkspace path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ensureWaoWorktreeExclude, prepareAndRunWorktreeAdd, WAO_WORKTREE_EXCLUDE_RULE } from "../src/gitLocalExclude.js";

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
  // Strip a leading UTF-8 BOM so a rule at the very first position (BOM + rule)
  // counts — the BOM is an encoding marker, not part of the rule text.
  const stripped = content.startsWith("\uFEFF") ? content.slice(1) : content;
  return stripped.split(/\r?\n/).filter((l) => l === rule).length;
}

// ===== P1-A: interleaved success/failure =====

test("P1-A: when A's own prepare wrote the rule but B created a real worktree before A failed, A's rollback must NOT delete the rule B depends on", async () => {
  // Deterministic interleave reproducing the real concurrent-dispatch race:
  //   1. A starts with NO rule; A's prepare writes the rule (didMutateExclude=true).
  //   2. A's runWorktreeAdd callback FIRST creates B's real worktree (rule now
  //      protects B's worktree dir), THEN fails A's own add.
  // GREEN: cross-process lock + restore-locked-snapshot keeps the rule because
  // the locked snapshot is taken AFTER prepare (rule present), and rollback
  // restores that — which still contains the rule.
  const repo = makeTempRepo();
  try {
    const bWtName = "run_p1a_b";
    let bCreated = false;
    await assert.rejects(
      () => prepareAndRunWorktreeAdd(repo, {
        runWorktreeAdd: () => {
          // B sneaks in a real worktree add (rule present from A's prepare).
          execSync(`git worktree add "${join(repo, ".wao-worktrees", bWtName)}" -b wao/${bWtName}`,
            { cwd: repo, stdio: "ignore" });
          bCreated = true;
          // Now A's own add fails.
          throw new Error("injected A worktree add failure");
        },
      }),
      /worktree/i,
    );
    assert.ok(bCreated, "B's worktree was created during A's runWorktreeAdd");
    assert.ok(existsSync(join(repo, ".wao-worktrees", bWtName)), "B worktree exists");

    // GREEN contract: the rule must STILL be present (B's worktree depends on it).
    assert.equal(countExact(readExclude(repo)), 1,
      "rule must survive A's rollback because B's real worktree now depends on it");
    // Source git status must NOT show .wao-worktrees/.
    const status = execSync("git status --porcelain", { cwd: repo, encoding: "utf8" });
    assert.ok(!status.includes(".wao-worktrees"),
      "source git status clean of .wao-worktrees after interleaved success/failure");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ===== P1-B: injected read-back throw rolls back; both errors surfaced if rollback fails =====

test("P1-B-1: injected readExclude throw → no rule residue, no worktree add, no temp", async () => {
  const repo = makeTempRepo();
  try {
    const pre = "user-rule\n";
    writeExclude(repo, pre);
    const infoDir = join(repo, ".git", "info");
    const beforeEntries = readdirSync(infoDir).filter((e) => e !== "exclude.wao-lock");
    let worktreeAddCalls = 0;
    await assert.rejects(
      () => prepareAndRunWorktreeAdd(repo, {
        readExclude: () => { throw new Error("injected read-back failure"); },
        runWorktreeAdd: () => { worktreeAddCalls++; },
      }),
      /read-back|verify|exclude/i,
    );
    assert.equal(worktreeAddCalls, 0, "no worktree add after read-back throw");
    assert.equal(readExclude(repo), pre, "pre-call bytes restored (no rule residue)");
    assert.deepEqual(
      readdirSync(infoDir).filter((e) => e !== "exclude.wao-lock"),
      beforeEntries,
      "no temp file left",
    );
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("P1-B-2: read-back throw AND rollback failure → both errors surfaced (original + cleanup)", async () => {
  const repo = makeTempRepo();
  try {
    const pre = "user-rule\n";
    writeExclude(repo, pre);
    // readExclude throws on read-back; writeExclude (used by restore) also throws.
    await assert.rejects(
      () => prepareAndRunWorktreeAdd(repo, {
        readExclude: () => { throw new Error("injected read-back failure"); },
        writeExclude: () => { throw new Error("injected restore failure"); },
        runWorktreeAdd: () => {},
      }),
      (err) => {
        const msg = String(err.message);
        return /read-back|verify|exclude/i.test(msg) && /restore|cleanup/i.test(msg);
      },
      "both original and cleanup failures must be surfaced",
    );
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ===== P2-A: pre-existing duplicate exact rules converge to exactly one =====

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
    assert.equal(r.added, false, "no new rule added — converged existing duplicates");
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
    assert.equal(r1.added, false);
    assert.equal(r1.alreadyPresent, true);
    assert.equal(r2.added, false);
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
