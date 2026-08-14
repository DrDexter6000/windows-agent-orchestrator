// test/canonicalRunner.test.js
//
// TD-107: meta-tests for the canonical test runner (scripts/canonical-test.mjs).
// The runner is a zero-dependency, repository-owned Node runner; these tests pin
// its deterministic invariants WITHOUT spawning children:
//   - manifest validation hard-fails on missing/duplicate/stale/unknown/unknown-group,
//   - the resource-category set is the closed seven,
//   - the frozen WAVE PLAN covers every category in EXACTLY one wave,
//   - isolation classification can NEVER wash a first-round failure into PASS.
//
// The full orchestration (wave-serial execution, per-wave concurrency, child
// spawn, bounded report) is exercised end-to-end by `npm test` itself; these unit
// tests lock the decision logic that keeps the verdict truthful and attributable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateManifest, classifyIsolation, MANIFEST_GROUPS,
  runWave, runCanonical, mapReportToFiles, suiteRelToManifest,
  WAVE_PLAN, validateWavePlan,
} from "../../scripts/canonical-test.mjs";

function manifestFixture() {
  return {
    groups: {
      pure: ["a.test.js", "b.test.js"],
      git: ["g.test.js"],
      worktree: [],
      process: [],
      lock: [],
      timeout: [],
      mcp: [],
    },
  };
}

// Build a wave's file list: each entry carries its resourceCategory so failures
// stay attributable to category AND wave in the bounded report.
function waveFiles(rels, category) {
  return rels.map((path) => ({ path, resourceCategory: category }));
}

test("validateManifest: clean manifest passes with no errors", () => {
  const r = validateManifest(manifestFixture(), ["a.test.js", "b.test.js", "g.test.js"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("validateManifest: missing — a discovered file assigned to no group", () => {
  const r = validateManifest(manifestFixture(), ["a.test.js", "b.test.js", "g.test.js", "orphan.test.js"]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /missing/.test(e) && e.includes("orphan.test.js")));
});

test("validateManifest: duplicate — the same file in two groups", () => {
  const m = manifestFixture();
  m.groups.git.push("a.test.js"); // already in pure
  const r = validateManifest(m, ["a.test.js", "b.test.js", "g.test.js"]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /duplicate/.test(e) && e.includes("a.test.js")));
});

test("validateManifest: stale — a manifest entry absent from disk", () => {
  const m = manifestFixture();
  m.groups.pure.push("ghost.test.js"); // not discovered
  const r = validateManifest(m, ["a.test.js", "b.test.js", "g.test.js"]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /stale/.test(e) && e.includes("ghost.test.js")));
});

test("validateManifest: unknown — an entry that is not a *.test.js path", () => {
  const m = manifestFixture();
  m.groups.pure.push("not-a-test.txt");
  const r = validateManifest(m, ["a.test.js", "b.test.js", "g.test.js", "not-a-test.txt"]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown/.test(e) && e.includes("not-a-test.txt")));
});

test("validateManifest: unknown GROUP name is rejected", () => {
  const m = manifestFixture();
  m.groups.bogus = ["x.test.js"];
  const r = validateManifest(m, ["a.test.js", "b.test.js", "g.test.js", "x.test.js"]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown group/.test(e) && e.includes("bogus")));
});

test("MANIFEST_GROUPS is exactly the closed set of seven resource categories", () => {
  assert.deepEqual([...MANIFEST_GROUPS].sort(), ["git", "lock", "mcp", "process", "pure", "timeout", "worktree"]);
});

test("classifyIsolation: fail-alone→pass stays isolation_pass (NEVER washed to PASS)", () => {
  assert.equal(classifyIsolation("fail", "pass"), "isolation_pass");
});
test("classifyIsolation: fail-alone→fail is stable_fail", () => {
  assert.equal(classifyIsolation("fail", "fail"), "stable_fail");
});
test("classifyIsolation: an isolation crash is environment_invalid", () => {
  assert.equal(classifyIsolation("fail", "crash"), "environment_invalid");
  assert.equal(classifyIsolation("crash", "crash"), "environment_invalid");
});
test("classifyIsolation: a first-round pass is never rechecked", () => {
  assert.equal(classifyIsolation("pass", "pass"), "not_rechecked");
});

test("frozen manifest: every discovered test/*.test.js is assigned exactly once (no drift)", () => {
  const here = fileURLToPath(import.meta.url);
  const repoRoot = join(here, "..", "..", "..");
  const testDir = join(repoRoot, "test");
  const discovered = [];
  function walk(d) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".test.js")) discovered.push(relative(testDir, p).split(sep).join("/"));
    }
  }
  walk(testDir);
  const manifest = JSON.parse(readFileSync(join(testDir, "manifest.json"), "utf8"));
  const r = validateManifest(manifest, discovered.sort());
  assert.equal(r.ok, true, `manifest drift detected:\n${r.errors.join("\n")}`);
});

// ────────────────────────────────────────────────────────────────────────────
// Wave-plan coverage: the frozen WAVE_PLAN must map every resource category to
// EXACTLY one execution wave (no missing, no duplicate, no unknown category).
// ────────────────────────────────────────────────────────────────────────────

test("validateWavePlan: a plan covering every category exactly once is valid", () => {
  const r = validateWavePlan(WAVE_PLAN, MANIFEST_GROUPS);
  assert.equal(r.ok, true, r.errors.join("\n"));
  for (const cat of MANIFEST_GROUPS) assert.ok(r.categoryToWave.has(cat), `${cat} is mapped to a wave`);
});

test("validateWavePlan: a missing category, a duplicated category, and an unknown category are all rejected", () => {
  // missing: drop the lock wave → 'lock' uncovered
  const missing = WAVE_PLAN.filter((w) => w.name !== "lock");
  assert.equal(validateWavePlan(missing, MANIFEST_GROUPS).ok, false);
  // duplicate: also place 'git' in the process wave
  const dup = WAVE_PLAN.map((w) => (w.name === "process" ? { ...w, categories: [...w.categories, "git"] } : w));
  assert.equal(validateWavePlan(dup, MANIFEST_GROUPS).ok, false);
  // unknown category referenced by a wave
  const unk = WAVE_PLAN.map((w) => (w.name === "pure" ? { ...w, categories: [...w.categories, "bogus"] } : w));
  assert.equal(validateWavePlan(unk, MANIFEST_GROUPS).ok, false);
});

test("WAVE_PLAN: lock is strictly serial; the filesystem wave pools git+worktree", () => {
  const r = validateWavePlan(WAVE_PLAN, MANIFEST_GROUPS);
  assert.equal(r.ok, true);
  const byName = new Map(WAVE_PLAN.map((w) => [w.name, w]));
  assert.equal(byName.get("lock").concurrency, 1, "lock wave is strictly serial");
  const fsWave = byName.get("filesystem");
  assert.deepEqual([...fsWave.categories].sort(), ["git", "worktree"], "filesystem wave pools git+worktree");
  assert.ok(fsWave.concurrency >= 8, "filesystem wave has bounded concurrency (>= 8)");
});

// ────────────────────────────────────────────────────────────────────────────
// Causal tests for the one-child-per-wave design. Orchestration is driven
// through injectable runChild/readReport/deleteReport/isolator adapters, so these
// are deterministic and do NOT depend on wall time. They pin the required
// properties:
//   (1) ONE child invocation per non-empty wave (not one per file, not per category),
//   (2) structured reporter suites map to the exact rel file (no regex text),
//   (3) every wave runs even after an earlier wave fails (no early abort),
//   (4) a missing/malformed wave report, or a nonzero exit with a clean report,
//       is non-green — a wave failure can NEVER surface as zero failures,
//   (5) a first-round failure can NEVER wash green even if isolation alone passes,
//   (6) git + worktree files share ONE invocation under the filesystem wave,
//   (7) building wave specs from the manifest never duplicates a file across waves,
//   (8) category→wave coverage is exact and total (every category once).
// ────────────────────────────────────────────────────────────────────────────

// Build a synthetic structured report shaped like test/reporter.mjs output:
// { suites: [{ name: "test/<rel>", status, tests: [] }, ...] }.
function makeReport(files, failSet) {
  return {
    suites: files.map((rel) => ({ name: "test/" + rel, status: failSet.has(rel) ? "fail" : "pass", tests: [] })),
  };
}
const noopDelete = async () => {};

test("suiteRelToManifest: strips the leading test/ prefix (handles subdirs)", () => {
  assert.equal(suiteRelToManifest("test/a.test.js"), "a.test.js");
  assert.equal(suiteRelToManifest("test/parsers/x.test.js"), "parsers/x.test.js");
  assert.equal(suiteRelToManifest("a.test.js"), "a.test.js"); // already rel
});

test("mapReportToFiles: maps suites to rel files; fail status wins over pass", () => {
  const files = ["a.test.js", "b.test.js", "c.test.js"];
  const { reportValid, perFile } = mapReportToFiles(makeReport(files, new Set(["b.test.js"])), files);
  assert.equal(reportValid, true);
  assert.equal(perFile.get("a.test.js"), "pass");
  assert.equal(perFile.get("b.test.js"), "fail");
  assert.equal(perFile.get("c.test.js"), "pass");
});

test("mapReportToFiles: an expected file with no suite is 'missing' (non-pass)", () => {
  const { perFile } = mapReportToFiles(
    { suites: [{ name: "test/a.test.js", status: "pass", tests: [] }] },
    ["a.test.js", "ghost.test.js"],
  );
  assert.equal(perFile.get("a.test.js"), "pass");
  assert.equal(perFile.get("ghost.test.js"), "missing");
});

test("mapReportToFiles: null / malformed report is invalid (wave runner failure)", () => {
  assert.equal(mapReportToFiles(null, ["a.test.js"]).reportValid, false);
  assert.equal(mapReportToFiles({}, ["a.test.js"]).reportValid, false);
  assert.equal(mapReportToFiles({ suites: "nope" }, ["a.test.js"]).reportValid, false);
  // invalid report ⇒ every file is a crash (never silently all-pass)
  assert.equal(mapReportToFiles(null, ["a.test.js"]).perFile.get("a.test.js"), "crash");
});

test("mapReportToFiles: an UNKNOWN suite status makes the report invalid (never defaults to pass)", () => {
  const { reportValid, perFile } = mapReportToFiles(
    { suites: [{ name: "test/a.test.js", status: "todo", tests: [] }] },
    ["a.test.js"],
  );
  assert.equal(reportValid, false, "an unknown suite status ⇒ invalid report");
  assert.equal(perFile.get("a.test.js"), "crash", "invalid ⇒ crash, never a silent pass");
});

test("mapReportToFiles: a MISSING or NON-STRING suite status makes the report invalid", () => {
  assert.equal(mapReportToFiles({ suites: [{ name: "test/a.test.js", tests: [] }] }, ["a.test.js"]).reportValid, false); // missing
  assert.equal(mapReportToFiles({ suites: [{ name: "test/a.test.js", status: null }] }, ["a.test.js"]).reportValid, false); // null
  assert.equal(mapReportToFiles({ suites: [{ name: "test/a.test.js", status: 1 }] }, ["a.test.js"]).reportValid, false); // non-string number
  assert.equal(mapReportToFiles({ suites: [{ name: "test/a.test.js" }] }, ["a.test.js"]).perFile.get("a.test.js"), "crash");
});

test("mapReportToFiles: fail status still wins over pass for valid duplicate suite records", () => {
  const files = ["a.test.js"];
  const r1 = mapReportToFiles({ suites: [
    { name: "test/a.test.js", status: "pass", tests: [] },
    { name: "test/a.test.js", status: "fail", tests: [] },
  ] }, files);
  assert.equal(r1.reportValid, true);
  assert.equal(r1.perFile.get("a.test.js"), "fail", "pass-then-fail duplicate ⇒ fail wins");
  const r2 = mapReportToFiles({ suites: [
    { name: "test/a.test.js", status: "fail", tests: [] },
    { name: "test/a.test.js", status: "pass", tests: [] },
  ] }, files);
  assert.equal(r2.reportValid, true);
  assert.equal(r2.perFile.get("a.test.js"), "fail", "fail-then-pass duplicate ⇒ fail still wins");
});

test("runWave: ONE child invocation per non-empty wave; empty waves skip it", async () => {
  let calls = 0;
  const files = waveFiles(["a.test.js", "b.test.js", "c.test.js"], "pure");
  const runChild = async () => { calls++; return { exitCode: 0, stdout: "", stderr: "" }; };
  const readReport = async () => makeReport(files.map((f) => f.path), new Set());
  const w = await runWave({ name: "pure", files, concurrency: 4, reporterArg: "R", runChild, readReport, deleteReport: noopDelete });
  assert.equal(calls, 1, "one child for the whole wave, not one per file");
  assert.equal(w.results.length, 3);
  assert.equal(w.results.every((r) => r.status === "pass"), true);
  assert.equal(w.results.every((r) => r.resourceCategory === "pure" && r.executionWave === "pure"), true);
  assert.equal(w.groupError, null);

  calls = 0;
  const e = await runWave({ name: "lock", files: [], concurrency: 1, reporterArg: "R", runChild, readReport, deleteReport: noopDelete });
  assert.equal(calls, 0, "empty wave does not spawn a child");
  assert.equal(e.results.length, 0);
});

test("runWave: nonzero child exit with an all-pass report is still non-green", async () => {
  const files = waveFiles(["a.test.js"], "pure");
  const runChild = async () => ({ exitCode: 1, stdout: "", stderr: "" });
  const readReport = async () => makeReport(["a.test.js"], new Set()); // report looks clean
  const w = await runWave({ name: "pure", files, concurrency: 2, reporterArg: "R", runChild, readReport, deleteReport: noopDelete });
  assert.ok(w.groupError, "nonzero exit + clean report is a wave error (never silent success)");
});

test("runWave: a missing wave report is non-green with every file crashed", async () => {
  const files = waveFiles(["a.test.js", "b.test.js"], "pure");
  const runChild = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  const readReport = async () => null; // reporter never flushed
  const w = await runWave({ name: "pure", files, concurrency: 2, reporterArg: "R", runChild, readReport, deleteReport: noopDelete });
  assert.ok(w.groupError, "missing report is a wave error");
  assert.ok(w.results.every((r) => r.status === "crash"), "missing report ⇒ all files crashed");
});

test("runWave: a deleteReport failure does NOT spawn the child and marks every file crash", async () => {
  let spawned = 0;
  let readCalled = 0;
  const files = waveFiles(["a.test.js", "b.test.js"], "pure");
  const deleteReport = async () => { throw new Error("EPERM delete blocked"); };
  const runChild = async () => { spawned++; return { exitCode: 0, stdout: "", stderr: "" }; };
  const readReport = async () => { readCalled++; return makeReport(files.map((f) => f.path), new Set()); };
  const w = await runWave({ name: "pure", files, concurrency: 4, reporterArg: "R", runChild, readReport, deleteReport });
  assert.equal(spawned, 0, "a delete failure MUST NOT spawn the wave child");
  assert.equal(readCalled, 0, "a delete failure MUST NOT read a (possibly stale) report");
  assert.ok(w.groupError, "delete failure is a wave-level error");
  assert.equal(w.exitCode, null);
  assert.ok(w.results.every((r) => r.status === "crash"), "all expected files crash (never pass)");
});

test("causal: a deleteReport failure fails the wave closed — no spawn, no stale read, non-green, later waves still run", async () => {
  const spawnArgv = [];
  let readCount = 0;
  let deleteCount = 0;
  const deleteReport = async () => { deleteCount += 1; if (deleteCount === 1) throw new Error("EPERM delete blocked"); };
  const runChild = async (argv) => { spawnArgv.push(argv); return { exitCode: 0, stdout: "", stderr: "" }; };
  // Only the later wave reaches readReport; it returns that wave's own clean report.
  const readReport = async () => { readCount += 1; return makeReport(["c.test.js"], new Set()); };
  const specs = [
    { name: "pure", concurrency: 2, categories: ["pure"], files: waveFiles(["a.test.js", "b.test.js"], "pure") },
    { name: "process", concurrency: 2, categories: ["process"], files: waveFiles(["c.test.js"], "process") },
  ];
  const out = await runCanonical({ waveSpecs: specs, reporterArg: "R", runChild, readReport, deleteReport });

  // The first wave (pure) hit the delete failure: its child was NOT spawned and
  // its report was NOT read, so a stale report could not be consumed for it.
  assert.equal(spawnArgv.length, 1, "only the later wave spawned a child");
  assert.ok(spawnArgv[0].includes("test/c.test.js"), "the single spawn was the later wave");
  assert.ok(!spawnArgv.some((a) => a.includes("test/a.test.js")), "the delete-failed wave never spawned");
  assert.equal(readCount, 1, "only the later wave read a report — no stale read for the failed wave");

  const pureWave = out.waves.find((w) => w.name === "pure");
  assert.ok(pureWave.groupError, "delete failure is a wave-level error");
  assert.ok(pureWave.files.every((f) => f.status === "crash"), "the failed wave's files all crashed");

  assert.equal(out.suiteError, true);
  assert.equal(out.finalVerdict, "fail", "a delete failure cannot produce a green verdict");

  // No early abort: the later wave ran and passed normally.
  const procWave = out.waves.find((w) => w.name === "process");
  assert.equal(procWave.total, 1);
  assert.equal(procWave.files[0].status, "pass");
  assert.equal(procWave.groupError, null);
});

test("runCanonical: every wave runs even after an earlier wave fails; verdict is fail", async () => {
  const visited = [];
  const specs = [
    { name: "pure", concurrency: 2, categories: ["pure"], files: waveFiles(["fail1.test.js"], "pure") },
    { name: "filesystem", concurrency: 8, categories: ["git", "worktree"], files: [...waveFiles(["g.test.js"], "git"), ...waveFiles(["w.test.js"], "worktree")] },
  ];
  const runChild = async (argv) => {
    const isFailWave = argv.includes("test/fail1.test.js");
    visited.push(isFailWave ? "pure" : "filesystem");
    return { exitCode: isFailWave ? 1 : 0, stdout: "", stderr: "" };
  };
  const readReport = async () => {
    const last = visited[visited.length - 1];
    return last === "pure"
      ? makeReport(["fail1.test.js"], new Set(["fail1.test.js"]))
      : makeReport(["g.test.js", "w.test.js"], new Set());
  };
  const out = await runCanonical({ waveSpecs: specs, reporterArg: "R", runChild, readReport, deleteReport: noopDelete });
  assert.deepEqual(visited, ["pure", "filesystem"], "both waves ran (no early abort)");
  assert.equal(out.waves.length, 2);
  assert.equal(out.finalVerdict, "fail");
});

test("runCanonical: a missing wave report is non-green (never silent success)", async () => {
  const runChild = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  const readReport = async () => null;
  const out = await runCanonical({ waveSpecs: [{ name: "pure", concurrency: 2, categories: ["pure"], files: waveFiles(["a.test.js"], "pure") }], reporterArg: "R", runChild, readReport, deleteReport: noopDelete });
  assert.equal(out.suiteError, true);
  assert.equal(out.finalVerdict, "fail");
});

test("runCanonical: a first-round failure CANNOT wash green even if isolation alone passes", async () => {
  const files = waveFiles(["flake.test.js"], "worktree");
  const runChild = async () => ({ exitCode: 1, stdout: "", stderr: "" });
  const readReport = async () => makeReport(["flake.test.js"], new Set(["flake.test.js"])); // first round fail
  const isolator = async () => ({ status: "pass", exitCode: 0, tail: "alone-pass" });
  const out = await runCanonical({ waveSpecs: [{ name: "filesystem", concurrency: 8, categories: ["git", "worktree"], files }], reporterArg: "R", runChild, readReport, deleteReport: noopDelete, isolator });
  assert.equal(out.firstRound.verdict, "fail");
  assert.equal(out.finalVerdict, "fail", "isolation pass does NOT change the verdict");
  assert.equal(out.isolation.length, 1);
  assert.equal(out.isolation[0].classification, "isolation_pass");
  assert.equal(out.isolation[0].resourceCategory, "worktree");
  assert.equal(out.isolation[0].executionWave, "filesystem");
});

test("causal: git + worktree files share ONE invocation under the filesystem wave", async () => {
  let calls = 0;
  let seenArgv = null;
  const files = [...waveFiles(["runDelivery.test.js"], "worktree"), ...waveFiles(["runDeliveryReverify.test.js"], "git")];
  const runChild = async (argv) => { calls++; seenArgv = argv; return { exitCode: 0, stdout: "", stderr: "" }; };
  const readReport = async () => makeReport(files.map((f) => f.path), new Set());
  const w = await runWave({ name: "filesystem", files, concurrency: 8, reporterArg: "R", runChild, readReport, deleteReport: noopDelete });
  assert.equal(calls, 1, "git+worktree share ONE child invocation, not one per category");
  assert.ok(seenArgv.includes("test/runDelivery.test.js") && seenArgv.includes("test/runDeliveryReverify.test.js"), "both categories' files are in the single argv");
  assert.equal(w.results.length, 2);
  assert.equal(w.results.find((r) => r.path === "runDelivery.test.js").resourceCategory, "worktree");
  assert.equal(w.results.find((r) => r.path === "runDeliveryReverify.test.js").resourceCategory, "git");
  assert.equal(w.results.every((r) => r.executionWave === "filesystem"), true);
});

test("causal: building wave specs from the manifest never duplicates a file across waves", () => {
  // Mirror main()'s waveSpec construction on a synthetic manifest that exercises
  // every category, including the multi-category filesystem wave.
  const manifest = {
    groups: {
      pure: ["p1.test.js"],
      git: ["g1.test.js", "g2.test.js"],
      worktree: ["w1.test.js"],
      process: ["pr1.test.js"],
      lock: ["l1.test.js"],
      timeout: ["t1.test.js"],
      mcp: ["mc1.test.js"],
    },
  };
  const seen = new Map(); // path -> wave
  for (const wave of WAVE_PLAN) {
    for (const cat of wave.categories) {
      for (const p of (manifest.groups[cat] || [])) {
        assert.ok(!seen.has(p), `file ${p} duplicated across waves (${seen.get(p)} and ${wave.name})`);
        seen.set(p, wave.name);
      }
    }
  }
  const allFiles = Object.values(manifest.groups).flat();
  assert.equal(seen.size, allFiles.length, "every manifest file placed exactly once");
  for (const p of allFiles) assert.ok(seen.has(p));
});

test("causal: category→wave coverage is exact and total (every category in exactly one wave)", () => {
  const { ok, categoryToWave } = validateWavePlan(WAVE_PLAN, MANIFEST_GROUPS);
  assert.equal(ok, true);
  assert.equal(categoryToWave.size, MANIFEST_GROUPS.length, "no category unmapped, none extra");
  // git and worktree are deliberately pooled into the SAME wave (the long-pole overlap).
  assert.equal(categoryToWave.get("git"), "filesystem");
  assert.equal(categoryToWave.get("worktree"), "filesystem");
  assert.equal(categoryToWave.get("git"), categoryToWave.get("worktree"), "git and worktree share one wave");
  // every other category is its own wave.
  for (const cat of ["pure", "process", "lock", "timeout", "mcp"]) assert.equal(categoryToWave.get(cat), cat);
});

test("causal: the mcp wave is a serial, exclusive wave that never pools with git/worktree", () => {
  // Long-lived in-memory MCP request tests get their OWN serial wave so a per-file
  // request never competes with cross-file load for the SDK request budget.
  const byName = new Map(WAVE_PLAN.map((w) => [w.name, w]));
  const mcpWave = byName.get("mcp");
  assert.ok(mcpWave, "a dedicated 'mcp' wave exists");
  assert.equal(mcpWave.concurrency, 1, "the mcp wave runs serially (concurrency 1)");
  assert.deepEqual([...mcpWave.categories].sort(), ["mcp"], "the mcp wave owns exactly the mcp category");
  // It must NOT be pooled into the filesystem wave (which carries git/worktree at concurrency 16).
  const fsWave = byName.get("filesystem");
  assert.ok(fsWave, "filesystem wave exists");
  assert.ok(!fsWave.categories.includes("mcp"), "mcp is NOT pooled into the filesystem wave");
  assert.ok(!mcpWave.categories.includes("git") && !mcpWave.categories.includes("worktree"),
    "the mcp wave carries neither git nor worktree");
  // mcp is owned by EXACTLY one wave, and that wave is 'mcp'.
  const owners = WAVE_PLAN.filter((w) => w.categories.includes("mcp"));
  assert.equal(owners.length, 1, "exactly one wave owns mcp");
  assert.equal(owners[0].name, "mcp", "the mcp category's owning wave is named 'mcp'");
});
