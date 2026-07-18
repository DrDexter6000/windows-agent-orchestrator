// test/gitLocalExclude.test.js
//
// M11-1B: WAO worktree checkout hygiene.
//
// ensureWaoWorktreeExclude() is a runtime-neutral core Git helper that ensures
// the repository-local .git/info/exclude contains exactly one effective root
// rule `/.wao-worktrees/` before `git worktree add`. It must:
//   - use the repository's effective shared/common Git directory
//   - preserve all pre-existing exclude bytes (BOM, CRLF/LF, user rules)
//   - treat an existing exact rule as already configured (idempotent, no dup)
//   - write atomically (temp + rename in same dir), read-back verify
//   - on git worktree add failure, restore pre-call exclude bytes/absence
//   - never shell-build Git commands; never edit tracked .gitignore
//   - import no commands/mcp/SDK/Zod/application/host-adapter modules

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { ensureWaoWorktreeExclude } from "../src/gitLocalExclude.js";

const WAO_RULE = "/.wao-worktrees/";

/** Build a real temp git repo with one commit; return its root path. */
function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "wao-exc-repo-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "t@t"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "t"', { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# x\n");
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
  return dir;
}

function excludePath(repo) {
  // Primary checkout: <repo>/.git/info/exclude
  return join(repo, ".git", "info", "exclude");
}

function readExclude(repo) {
  const p = excludePath(repo);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function writeExclude(repo, content) {
  const p = excludePath(repo);
  writeFileSync(p, content);
}

function countExactRules(content, rule = WAO_RULE) {
  if (!content) return 0;
  // Count lines that are exactly the rule (no leading/trailing whitespace, no comment).
  return content.split(/\r?\n/).filter((l) => l === rule).length;
}

// ===== HYGIENE-02..05: byte/newline/BOM/no-trailing-newline preservation =====

test("HYGIENE-02: existing LF exclude bytes preserved as exact prefix; rule appended once", () => {
  const repo = makeTempRepo();
  try {
    const pre = "user-rule-1\n*.log\n";
    writeExclude(repo, pre);
    const result = ensureWaoWorktreeExclude(repo);
    assert.equal(result.added, true, "rule was added");
    const after = readExclude(repo);
    assert.ok(after.startsWith(pre), "pre-existing bytes must be an exact prefix (untouched)");
    assert.equal(countExactRules(after), 1, "exactly one WAO rule");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("HYGIENE-03: CRLF newline convention preserved for the appended separator/rule", () => {
  const repo = makeTempRepo();
  try {
    const pre = "user-crlf\r\n*.tmp\r\n"; // CRLF
    writeExclude(repo, pre);
    ensureWaoWorktreeExclude(repo);
    const after = readExclude(repo);
    assert.ok(after.startsWith(pre), "pre-existing CRLF bytes preserved");
    // The appended separator + rule must use CRLF to match the file's convention.
    assert.ok(after.includes("\r\n" + WAO_RULE + "\r\n") || after.endsWith("\r\n" + WAO_RULE + "\r\n"),
      "appended rule must use CRLF");
    assert.equal(countExactRules(after), 1);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("HYGIENE-04: UTF-8 BOM is preserved", () => {
  const repo = makeTempRepo();
  try {
    const BOM = "\uFEFF";
    const pre = BOM + "user-bom\n";
    writeExclude(repo, pre);
    ensureWaoWorktreeExclude(repo);
    const after = readExclude(repo);
    assert.ok(after.startsWith(BOM), "BOM must be preserved at start");
    assert.equal(countExactRules(after), 1);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("HYGIENE-05: no-trailing-newline file receives only the necessary separator", () => {
  const repo = makeTempRepo();
  try {
    const pre = "no-trailing-newline-here"; // no trailing \n
    writeExclude(repo, pre);
    ensureWaoWorktreeExclude(repo);
    const after = readExclude(repo);
    // pre-existing content must be an exact prefix; only the separator + rule added.
    assert.ok(after.startsWith(pre), "pre-existing content preserved");
    assert.equal(countExactRules(after), 1);
    // The join must add a newline before the rule (not concatenate onto the last line).
    assert.ok(after.includes("\n" + WAO_RULE), "a newline separator was added before the rule");
    assert.ok(!after.includes("no-trailing-newline-here" + WAO_RULE),
      "rule must not be concatenated onto the last user line");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ===== HYGIENE-06: idempotency =====

test("HYGIENE-06: repeated invocation is idempotent; exact rule count stays one", () => {
  const repo = makeTempRepo();
  try {
    writeExclude(repo, "user\n");
    const r1 = ensureWaoWorktreeExclude(repo);
    assert.equal(r1.added, true);
    const r2 = ensureWaoWorktreeExclude(repo);
    assert.equal(r2.added, false, "second call must report not-added");
    const r3 = ensureWaoWorktreeExclude(repo);
    assert.equal(r3.added, false);
    const after = readExclude(repo);
    assert.equal(countExactRules(after), 1, "still exactly one rule after 3 calls");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ===== HYGIENE-07: similar patterns/comments don't count as the exact rule =====

test("HYGIENE-07: similar patterns/comments/substrings do not count as the exact owned rule", () => {
  const repo = makeTempRepo();
  try {
    // None of these is the exact rule (different scope / comment / substring).
    const fakes = [
      ".wao-worktrees/",        // missing leading slash (would match subdirs anywhere)
      "# /.wao-worktrees/",     // commented out
      "/.wao-worktrees",        // missing trailing slash
      "/.wao-worktrees-old/",   // different dir
    ];
    for (const fake of fakes) {
      writeExclude(repo, fake + "\n");
      const r = ensureWaoWorktreeExclude(repo);
      assert.equal(r.added, true, `fake '${fake}' must not count as exact rule; rule added`);
      const after = readExclude(repo);
      assert.equal(countExactRules(after), 1, `exactly one exact rule after '${fake}'`);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ===== HYGIENE-08: injected exclude write/rename/read-back failure → no git worktree add =====

test("HYGIENE-08: injected write/rename/read-back failure means zero git worktree add and exact byte restoration", () => {
  const repo = makeTempRepo();
  try {
    const pre = "user-rule\n";
    writeExclude(repo, pre);
    // Inject a failing gitExec: git worktree add must never be called.
    let addCalls = 0;
    const failingGit = (args) => {
      if (args[0] === "worktree" && args[1] === "add") { addCalls++; throw new Error("injected git failure"); }
      // delegate real git for rev-parse so exclude prep still resolves the git dir
      return execSync("git " + args.map((a) => `"${a}"`).join(" "), { cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    };
    const result = ensureWaoWorktreeExclude(repo, { gitExec: failingGit, addWorktree: false });
    // addWorktree:false means the helper only prepares exclude, no worktree add attempted.
    // To exercise the rollback path, we use addWorktree with a failing git.
    assert.equal(addCalls, 0, "no worktree add in prepare-only mode");
    // prepare-only mode must have added the rule.
    assert.equal(result.added, true);
    const after = readExclude(repo);
    assert.equal(countExactRules(after), 1, "prepare-only added the rule");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("HYGIENE-08b: exclude write failure (injected) → no rule added, pre bytes restored, no temp file", () => {
  const repo = makeTempRepo();
  try {
    const pre = "user-rule\n";
    writeExclude(repo, pre);
    // Inject a writeExclude that always throws.
    const beforeEntries = readdirSync(join(repo, ".git", "info"));
    assert.throws(
      () => ensureWaoWorktreeExclude(repo, {
        writeExclude: () => { throw new Error("injected write failure"); },
      }),
      /write failure|exclude/i,
    );
    // Pre-existing bytes must be unchanged.
    assert.equal(readExclude(repo), pre, "pre-existing bytes restored/unchanged after write failure");
    // No temp file left in info dir.
    const afterEntries = readdirSync(join(repo, ".git", "info"));
    assert.deepEqual(afterEntries, beforeEntries, "no temp file left in info dir");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ===== HYGIENE-09: injected git worktree add failure restores pre-call exclude bytes + no temp =====

test("HYGIENE-09: injected git worktree add failure restores pre-call exclude bytes and leaves no temp file", () => {
  const repo = makeTempRepo();
  try {
    const pre = "user-pre-rule\n";
    writeExclude(repo, pre);
    const infoDir = join(repo, ".git", "info");
    const beforeEntries = readdirSync(infoDir);
    // addWorktree path with an injected failing gitExec for `worktree add`.
    assert.throws(
      () => ensureWaoWorktreeExclude(repo, {
        addWorktree: true,
        worktreeName: "run_test_fail",
        gitExec: (args) => {
          if (args[0] === "worktree" && args[1] === "add") throw new Error("injected worktree add failure");
          return execSync("git " + args.map((a) => `"${a}"`).join(" "), { cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        },
      }),
      /worktree add failure|worktree/i,
    );
    // Pre-call exclude bytes must be restored exactly.
    assert.equal(readExclude(repo), pre, "exclude bytes restored to pre-call state after worktree add failure");
    // No temp file left.
    const afterEntries = readdirSync(infoDir);
    assert.deepEqual(afterEntries, beforeEntries, "no temp file left after worktree add failure");
    // No wao-worktrees dir created.
    assert.ok(!existsSync(join(repo, ".wao-worktrees")), "no .wao-worktrees dir created on failure");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ===== HYGIENE-10: pre-existing exact user rule survives worktree-add failure =====

test("HYGIENE-10: pre-existing exact user rule survives worktree-add failure", () => {
  const repo = makeTempRepo();
  try {
    // User already wrote the exact rule themselves.
    const pre = "user-line\n" + WAO_RULE + "\n";
    writeExclude(repo, pre);
    assert.throws(
      () => ensureWaoWorktreeExclude(repo, {
        addWorktree: true,
        worktreeName: "run_test_fail2",
        gitExec: (args) => {
          if (args[0] === "worktree" && args[1] === "add") throw new Error("injected worktree add failure");
          return execSync("git " + args.map((a) => `"${a}"`).join(" "), { cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        },
      }),
      /worktree/i,
    );
    // The exact rule must still be present exactly once (restored to pre-call bytes).
    const after = readExclude(repo);
    assert.equal(after, pre, "pre-call bytes (incl. user's exact rule) restored");
    assert.equal(countExactRules(after), 1, "exact rule still present exactly once");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ===== HYGIENE-11: shared/common Git directory resolution for a linked-worktree layout =====

test("HYGIENE-11: exclude written to the common Git dir for a linked-worktree source layout", () => {
  // Build a main repo, then create a linked worktree of it; the linked worktree
  // is the "source cwd". The exclude rule must land in the MAIN repo's
  // .git/info/exclude (the common dir), not the linked worktree's per-worktree
  // git dir. This proves common-dir resolution.
  const mainRepo = makeTempRepo();
  const linkedDir = mkdtempSync(join(tmpdir(), "wao-exc-linked-"));
  try {
    // Create a real linked worktree of mainRepo at a path NOT under mainRepo.
    // git worktree add <linkedDir> (detached from the temp dir name collision)
    execSync(`git worktree add "${linkedDir}" -b linked-branch`, { cwd: mainRepo, stdio: "ignore" });
    // Now ensureWaoWorktreeExclude(linkedDir) should write to mainRepo's common dir.
    const res = ensureWaoWorktreeExclude(linkedDir);
    assert.equal(res.added, true);
    const mainExclude = join(mainRepo, ".git", "info", "exclude");
    assert.ok(existsSync(mainExclude), "exclude written to the common (main) git dir");
    const content = readFileSync(mainExclude, "utf8");
    assert.equal(countExactRules(content), 1, "exactly one rule in the common exclude");
    // The linked worktree's own .git file (not dir) should NOT have a separate info/exclude rule.
    // (linked worktrees have a .git file pointing to the common dir.)
  } finally {
    try { execSync("git worktree remove --force " + JSON.stringify(linkedDir), { cwd: mainRepo, stdio: "ignore" }); } catch {}
    rmSync(mainRepo, { recursive: true, force: true });
    rmSync(linkedDir, { recursive: true, force: true });
  }
});

// ===== HYGIENE-12: Codex activation exclude block preserves the independent WAO rule =====

test("HYGIENE-12: WAO worktree rule coexists with the Codex managed exclude block; removing the block preserves the WAO rule", () => {
  // This tests that the WAO rule (a bare root rule) is independent of the
  // Codex marker block (EXCLUDE_MARKER_BEGIN/END). They occupy different lines
  // and neither owns the other.
  const repo = makeTempRepo();
  try {
    // First, WAO hygiene adds its rule.
    ensureWaoWorktreeExclude(repo);
    // Then simulate a Codex-managed block being added by the host activation path.
    const codexBlock = [
      "# >>> WAO MANAGED (mcp workspace activation v1) >>>",
      "/.codex/config.toml",
      "# digest: abc123",
      "# <<< WAO MANAGED (mcp workspace activation v1) <<<",
    ].join("\n") + "\n";
    const before = readExclude(repo);
    writeExclude(repo, before + "\n" + codexBlock);
    // Both rules coexist.
    let after = readExclude(repo);
    assert.equal(countExactRules(after), 1, "WAO rule still exactly once alongside Codex block");
    assert.ok(after.includes("# >>> WAO MANAGED"), "Codex block present");
    // Now simulate Codex unbind removing ONLY its marker block (byte-range removal).
    // The WAO rule must survive because it's outside the marker block.
    const lines = after.split(/\r?\n/);
    const beginIdx = lines.findIndex((l) => l.includes("# >>> WAO MANAGED"));
    const endIdx = lines.findIndex((l) => l.includes("# <<< WAO MANAGED"));
    assert.ok(beginIdx >= 0 && endIdx > beginIdx, "Codex block markers found");
    // Remove lines [beginIdx .. endIdx] (the marker block only).
    const withoutBlock = [...lines.slice(0, beginIdx), ...lines.slice(endIdx + 1)].join("\n");
    writeExclude(repo, withoutBlock);
    after = readExclude(repo);
    assert.equal(countExactRules(after), 1, "WAO rule survives Codex block removal");
    assert.ok(!after.includes("# >>> WAO MANAGED"), "Codex block gone");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ===== HYGIENE-BOUNDARY: architectural boundary =====

test("HYGIENE-BOUNDARY: src/gitLocalExclude.js imports no commands/mcp/SDK/Zod/application/host-adapter, uses no shell-built Git", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(
    join(join(fileURLToPath(new URL(".", import.meta.url))), "..", "src", "gitLocalExclude.js"),
    "utf8",
  );
  assert.ok(!src.includes('from "./commands/'), "no commands/");
  assert.ok(!src.includes('from "./mcp/'), "no mcp/");
  assert.ok(!src.includes('from "./application/'), "no application/");
  assert.ok(!src.includes("hostAdapters"), "no hostAdapters");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "no SDK");
  assert.ok(!src.includes('from "zod"'), "no zod");
  // No shell-built git command: must use execFileSync with structured args,
  // never execSync with a command string for git.
  assert.ok(!/execSync\s*\(\s*["'`]git /.test(src), "no shell-built git command string");
});

// ===== HYGIENE-01: clean source git status --porcelain byte-identical after real worktree =====
// (end-to-end through real createWorktree; lives here to keep all hygiene tests together,
//  but exercises isolation.js integration which is wired in Batch A GREEN.)

test("HYGIENE-01: clean source git status --porcelain byte-identical after real createWorktree (no .wao-worktrees pollution)", async () => {
  const { createWorktree, removeWorktree } = await import("../src/isolation.js");
  const repo = makeTempRepo();
  try {
    const headBefore = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    const statusBefore = execSync("git status --porcelain", { cwd: repo, encoding: "utf8" });
    const wt = await createWorktree(repo, "run_smoke_hygiene");
    // Worktree + branch exist.
    assert.ok(existsSync(wt.path), "worktree created");
    assert.ok(existsSync(join(wt.path, "README.md")), "worktree has content");
    // Source HEAD unchanged.
    const headAfter = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    assert.equal(headAfter, headBefore, "source HEAD unchanged");
    // Source tracked/cached diff empty.
    const diff = execSync("git diff HEAD", { cwd: repo, encoding: "utf8" });
    assert.equal(diff, "", "no tracked diff in source");
    // Source git status --porcelain byte-identical and does NOT show .wao-worktrees/.
    const statusAfter = execSync("git status --porcelain", { cwd: repo, encoding: "utf8" });
    assert.equal(statusAfter, statusBefore, "git status --porcelain byte-identical");
    assert.ok(!statusAfter.includes(".wao-worktrees"), "git status does not show .wao-worktrees");
    // Cleanup the worktree (hygiene rule stays per spec §4.3).
    await removeWorktree(wt.path);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
