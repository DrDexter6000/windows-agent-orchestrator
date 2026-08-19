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
import { readdirSync, readFileSync, statSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateManifest, classifyIsolation, MANIFEST_GROUPS,
  runWave, runCanonical, mapReportToFiles, suiteRelToManifest,
  WAVE_PLAN, validateWavePlan,
  takeRunsSnapshot, addedRunsFiles, createRunsDirGuard, realListRunsDir,
  finalRunnerOutcome,
  createInflightMarker, realInflightAdapter, inflightMarkerPath, INFLIGHT_MARKER_FILENAME,
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

// ────────────────────────────────────────────────────────────────────────────
// R8-3 layer 2: runs/ snapshot guard — pure logic over an injectable listDir.
// These meta-tests never touch the REPO's real runs/ directory (the adapter
// test below uses a tmpdir), and the guard itself has NO write path at all
// (structural: it only consumes the injected listing).
// R8-C C-1: the guarded set is the ENTIRE directory entry set (dot entries,
// every suffix, subdirectory names + ONE level of subdirectory contents) —
// the old *.jsonl-top-level-only set let real writer shapes escape
// (.owner-* heartbeats, daemon*.json, .session-reuse/ slots, non-jsonl files).
// ────────────────────────────────────────────────────────────────────────────

test("takeRunsSnapshot: missing directory (listDir → null) is the EMPTY set, not an error", () => {
  assert.deepEqual(takeRunsSnapshot(() => null), [], "runs/ 不存在 = 空集（正常初态）");
  assert.deepEqual(takeRunsSnapshot(() => []), [], "空目录 = 空集");
});

test("takeRunsSnapshot: EVERY entry is guarded — dot entries, non-.jsonl suffixes, dedup + sort", () => {
  const snap = takeRunsSnapshot(() => ["b.jsonl", "notes.txt", "a.jsonl", "b.jsonl", "c.json", ".owner-run_x", "daemon.json"]);
  assert.deepEqual(snap,
    [".owner-run_x", "a.jsonl", "b.jsonl", "c.json", "daemon.json", "notes.txt"],
    "R8-C C-1：dot 条目、非 .jsonl 后缀全部入集（旧 *.jsonl 过滤曾放走 .owner-*/daemon*.json）；去重 + 排序");
});

test("takeRunsSnapshot: subdirectory names AND one level of their contents are guarded (sub/ prefix)", () => {
  const top = [
    { name: "run_a.jsonl", isDirectory: false },
    { name: ".session-reuse", isDirectory: true },
    { name: "wf_1", isDirectory: true },
  ];
  const subdirs = new Map([
    [".session-reuse", [{ name: "lead.json", isDirectory: false }]],
    ["wf_1", [{ name: "run_b.jsonl", isDirectory: false }, { name: "nested", isDirectory: true }]],
  ]);
  const snap = takeRunsSnapshot((sub) => (sub ? (subdirs.get(sub) ?? null) : top));
  assert.deepEqual(snap, [
    ".session-reuse",
    ".session-reuse/lead.json",
    "run_a.jsonl",
    "wf_1",
    "wf_1/nested",
    "wf_1/run_b.jsonl",
  ], "子目录名本身 + 一层内容（sub/ 前缀）入集；深度恰一层（wf_1/nested 的内容不展开）");
});

test("takeRunsSnapshot: a vanished subdirectory (listDir(sub) → null) is just no entries — not an error", () => {
  const snap = takeRunsSnapshot((sub) => (sub === "" ? [{ name: "gone", isDirectory: true }] : null));
  assert.deepEqual(snap, ["gone"], "子目录在两次列举之间消失 = 删除（守卫不管清理），只剩目录名本身");
});

test("addedRunsFiles: pure diff — additions only, deletions not reported", () => {
  assert.deepEqual(addedRunsFiles([], ["run_a.jsonl"]), ["run_a.jsonl"], "空基线：全部为新增");
  assert.deepEqual(addedRunsFiles(["run_a.jsonl"], ["run_a.jsonl"]), [], "无变化 → 零新增");
  assert.deepEqual(
    addedRunsFiles(["run_a.jsonl", "run_b.jsonl"], ["run_b.jsonl", "run_c.jsonl"]),
    ["run_c.jsonl"],
    "仅新增面；删除（run_a 消失）不报——守卫管写入不管清理",
  );
});

test("runs guard: real writer shapes all count as additions (dot entry, state file, subdirectory slot)", () => {
  let listing = null; // runs/ does not exist yet
  const guard = createRunsDirGuard({ listDir: () => listing });
  assert.deepEqual(guard.recordPhase("pure"), [], "wave pure：无新增");
  listing = [".owner-run_1", "daemon.json", ".session-reuse", "run_x.jsonl"];
  const fresh = guard.recordPhase("process");
  assert.deepEqual(fresh.map((f) => f.file), [".owner-run_1", ".session-reuse", "daemon.json", "run_x.jsonl"],
    "R8-C C-1 回归：旧 *.jsonl 过滤下 .owner-*/daemon.json/.session-reuse 全部逃逸（runsGuard=clean + exit 0）——现在全部留痕");
});

test("runs guard: a new file INSIDE a pre-existing subdirectory counts (sub/child)", () => {
  let top = [{ name: ".session-reuse", isDirectory: true }];
  let sessionReuseEntries = [{ name: "lead.json", isDirectory: false }];
  let lineageReuseEntries = null;
  const guard = createRunsDirGuard({
    listDir: (sub) => (sub === "" ? top : sub === ".session-reuse" ? sessionReuseEntries : lineageReuseEntries),
  });
  assert.deepEqual(guard.recordPhase("pure"), [], "基线含 .session-reuse/lead.json：无新增");
  sessionReuseEntries = [{ name: "lead.json", isDirectory: false }, { name: "lead2.json", isDirectory: false }];
  assert.deepEqual(guard.recordPhase("mcp"), [{ file: ".session-reuse/lead2.json", phase: "mcp" }],
    "既有子目录内新增文件 = 新增（sub/ 前缀）");
  top = [{ name: ".session-reuse", isDirectory: true }, { name: ".lineage-reuse", isDirectory: true }];
  sessionReuseEntries = [{ name: "lead.json", isDirectory: false }];
  lineageReuseEntries = [{ name: "lineage.json", isDirectory: false }];
  assert.deepEqual(guard.recordPhase("lock"), [
    { file: ".lineage-reuse", phase: "lock" },
    { file: ".lineage-reuse/lineage.json", phase: "lock" },
  ], "新子目录槽位本身即新增，其一层内容同 sweep 一并留痕（.session-reuse 删除 lead2 不报——守卫不管清理）");
});

test("runs guard: clean suite (empty dir throughout) → zero additions", () => {
  const guard = createRunsDirGuard({ listDir: () => null });
  assert.deepEqual(guard.baseline, []);
  assert.deepEqual(guard.recordPhase("pure"), []);
  assert.deepEqual(guard.recordPhase("filesystem"), []);
  assert.deepEqual(guard.additions(), [], "全程空目录 → 无红灯素材");
});

test("runs guard: addition is attributed to the wave that FIRST saw it (exactly once)", () => {
  let listing = null; // runs/ does not exist yet
  const guard = createRunsDirGuard({ listDir: () => listing });
  assert.deepEqual(guard.recordPhase("pure"), [], "wave pure：无新增");

  listing = ["run_x.jsonl"]; // a test in the filesystem wave leaked a transcript
  assert.deepEqual(guard.recordPhase("filesystem"), [{ file: "run_x.jsonl", phase: "filesystem" }],
    "新增归属首次观察到的 wave");

  listing = ["run_x.jsonl", "run_y.jsonl"]; // later wave adds another, first still present
  assert.deepEqual(guard.recordPhase("process"), [{ file: "run_y.jsonl", phase: "process" }],
    "已记录文件不重复归属；新文件归属当前 wave");
  assert.deepEqual(guard.additions(), [
    { file: "run_x.jsonl", phase: "filesystem" },
    { file: "run_y.jsonl", phase: "process" },
  ], "累计清单按文件名排序，phase 归属正确");
});

test("runs guard: a file observed once and later DELETED still counts (survived a sweep boundary)", () => {
  let listing = null;
  const guard = createRunsDirGuard({ listDir: () => listing });
  listing = ["leak.jsonl"];
  guard.recordPhase("mcp");
  listing = null; // deleted before the next sweep — the write still happened
  guard.recordPhase("isolation");
  assert.deepEqual(guard.additions(), [{ file: "leak.jsonl", phase: "mcp" }],
    "跨 sweep 边界存活过即留痕（观察期内删除不能洗白）；对拍面见下一条——同 wave 内写完即删不可见");
});

test("runs guard: KNOWN boundary — a write created AND deleted WITHIN one sweep window is invisible", () => {
  // 诚实化边界（R8-C C-2）：守卫只在 sweep 时刻观察目录。同 wave 内"写完即删"
  // （下一次列举前完整吸收）不产生任何观察记录——保证是"跨 sweep 边界存活过 ⇒
  // 留痕"，不是"每次写入都留痕"。静态主层（staticRunsGuard）管源码形状，不受此窗影响。
  let listing = null;
  const guard = createRunsDirGuard({ listDir: () => listing });
  // wave pure 内部：某测试写了 leak.jsonl 又删掉——两次列举之间目录回到原状
  guard.recordPhase("pure");
  listing = null;
  guard.recordPhase("lock");
  assert.deepEqual(guard.additions(), [], "同 sweep 窗内写完即删 = 零观察记录（时间窗边界，见 canonical-test.mjs 头注释 boundary 1）");
});

test("runs guard: guard interacts with the filesystem ONLY through the injected listDir (no write path)", () => {
  let reads = 0;
  const guard = createRunsDirGuard({ listDir: () => { reads += 1; return null; } });
  guard.recordPhase("pure");
  guard.recordPhase("lock");
  guard.additions();
  assert.equal(reads, 3, "每次 recordPhase 恰一次列目录（构造基线 1 次 + 两阶段各 1 次）；additions() 不再读");
  assert.deepEqual(guard.additions(), []);
});

test("realListRunsDir + takeRunsSnapshot: real readdir surface on a tmpdir — dot entries, non-jsonl, subdirs (one level)", () => {
  // R8-C C-1 端到端回归（真 readdir 路径，tmpdir——绝不触碰仓库真实 runs/）：
  // 审计沙箱实证的 5 类真实写入形状全部必须入集。
  const dir = mkdtempSync(join(tmpdir(), "wao-runs-guard-surface-"));
  try {
    writeFileSync(join(dir, "run_a.jsonl"), "", "utf8");
    writeFileSync(join(dir, ".owner-run_a"), "", "utf8");
    writeFileSync(join(dir, "daemon.json"), "{}", "utf8");
    writeFileSync(join(dir, "daemon-health.json"), "{}", "utf8");
    writeFileSync(join(dir, "daemon-supervisor.json"), "{}", "utf8");
    mkdirSync(join(dir, ".session-reuse"));
    writeFileSync(join(dir, ".session-reuse", "lead.json"), "{}", "utf8");
    mkdirSync(join(dir, "wf_1"));
    writeFileSync(join(dir, "wf_1", "run_b.jsonl"), "", "utf8");
    const listDir = realListRunsDir(dir);
    const snap = takeRunsSnapshot(listDir);
    assert.ok(snap.includes(".owner-run_a"), ".owner-* 心跳文件入集");
    assert.ok(snap.includes("daemon.json") && snap.includes("daemon-health.json") && snap.includes("daemon-supervisor.json"),
      "daemon 握手/健康/监督文件（非 .jsonl 后缀）入集");
    assert.ok(snap.includes(".session-reuse") && snap.includes(".session-reuse/lead.json"),
      ".session-reuse/ 槽位目录名 + 一层内容入集");
    assert.ok(snap.includes("wf_1/run_b.jsonl"), "子目录 transcript 入集");
    // 逃逸面修复的判别断言：旧实现（仅顶层 *.jsonl）会得到恰好 1 条 —— 现在必须更多。
    assert.ok(snap.length >= 9, `全集大小 ${snap.length} ≥ 9（旧 *.jsonl 顶层过滤只剩 1）`);
    // 缺失目录 = null（空基线），不是错误
    assert.equal(realListRunsDir(join(dir, "no-such-runs"))(""), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// R8-C C-5: finalRunnerOutcome — the post-verdict exit decision, extracted
// from main() so the red-light branches have automated coverage (previously
// "verdict=pass cannot be pressed green" had human evidence only).
// ────────────────────────────────────────────────────────────────────────────

test("finalRunnerOutcome: verdict=pass + runs additions NON-EMPTY ⇒ red (a green test verdict cannot press the exit green)", () => {
  const r = finalRunnerOutcome({ verdict: "pass", runsAdditions: [{ file: "leak.jsonl", phase: "filesystem" }], runsGuardError: null });
  assert.deepEqual(r, { kind: "runs_additions", exitCode: 1 });
});

test("finalRunnerOutcome: verdict=failed + zero additions ⇒ exit 1 via the VERDICT path, not the guard", () => {
  const r = finalRunnerOutcome({ verdict: "fail", runsAdditions: [], runsGuardError: null });
  assert.deepEqual(r, { kind: "verdict", exitCode: 1 }, "零新增时退出码只由 first-round verdict 决定");
});

test("finalRunnerOutcome: clean pass ⇒ exit 0", () => {
  assert.deepEqual(
    finalRunnerOutcome({ verdict: "pass", runsAdditions: [], runsGuardError: null }),
    { kind: "verdict", exitCode: 0 },
  );
});

test("finalRunnerOutcome: a guard READ error fails closed ⇒ red even with a pass verdict and zero additions", () => {
  const r = finalRunnerOutcome({ verdict: "pass", runsAdditions: [], runsGuardError: "EPERM" });
  assert.deepEqual(r, { kind: "guard_error", exitCode: 1 }, "无法观察 runs/ = 红（宁可误红不可漏报）");
});

test("finalRunnerOutcome: report write failure ⇒ red regardless of everything else", () => {
  assert.deepEqual(
    finalRunnerOutcome({ verdict: "pass", runsAdditions: [], runsGuardError: null, reportWritten: false }),
    { kind: "report_write_failed", exitCode: 1 },
  );
  assert.deepEqual(
    finalRunnerOutcome({ verdict: "fail", runsAdditions: [{ file: "x.jsonl", phase: "mcp" }], runsGuardError: "EACCES", reportWritten: false }),
    { kind: "report_write_failed", exitCode: 1 },
    "precedence: report_write_failed > guard_error > runs_additions > verdict",
  );
});

// ────────────────────────────────────────────────────────────────────────────
// R22 W1: advisory inflight marker — pure decision core over an injectable fs
// adapter (finalRunnerOutcome idiom). The marker is machine-global under
// os.tmpdir(), deliberately NOT inside any repo (never entangled with
// runs-guard/gitignore). It is advisory ONLY: a second concurrent full suite
// prints one WARNING and keeps running — never blocks, never waits, no budget.
// These meta-tests inject a fake fs; the real-adapter test below uses a
// mkdtemp tmpdir and never touches the machine's real marker. Nothing here
// executes main(): importing canonical-test.mjs never runs the marker logic
// (invokedDirectly guard).
// ────────────────────────────────────────────────────────────────────────────

// In-memory marker fs: content === null means "absent". createMarker enforces
// O_EXCL semantics ("wx") like the real adapter; deleteMarker throws ENOENT on
// an absent file.
function fakeInflightFs(initial) {
  let content = initial === undefined ? null : initial;
  const ops = { creates: [], deletes: 0 };
  const e = (code) => { const err = new Error(code); err.code = code; return err; };
  return {
    ops,
    set: (t) => { content = t; },
    readMarker: () => content,
    createMarker: (text) => { if (content !== null) throw e("EEXIST"); content = text; ops.creates.push(text); },
    deleteMarker: () => { if (content === null) throw e("ENOENT"); content = null; ops.deletes += 1; },
  };
}
function markerOver(fsx, extras = {}) {
  return createInflightMarker({
    readMarker: fsx.readMarker, createMarker: fsx.createMarker, deleteMarker: fsx.deleteMarker,
    warn: extras.warn, pid: extras.pid, now: extras.now,
  });
}

test("inflight marker: no existing marker → begin creates {pid, startedAt}, end deletes it", () => {
  const fsx = fakeInflightFs();
  const warnings = [];
  const m = markerOver(fsx, { warn: (l) => warnings.push(l), pid: 4242, now: () => "2026-08-20T00:00:00.000Z" });
  assert.equal(m.begin(), "created", "无标记 ⇒ O_EXCL 创建并持有删除权");
  assert.equal(warnings.length, 0, "干净启动零输出");
  assert.equal(fsx.ops.creates.length, 1);
  assert.deepEqual(JSON.parse(fsx.ops.creates[0]), { pid: 4242, startedAt: "2026-08-20T00:00:00.000Z" },
    "标记内容 = {pid, startedAt}");
  assert.equal(m.end(), true);
  assert.equal(fsx.ops.deletes, 1, "自己创建的标记在退出路径被删除");
});

test("inflight marker: existing marker → exactly one WARNING line; no create; foreign marker NOT deleted", () => {
  const fsx = fakeInflightFs(JSON.stringify({ pid: 111, startedAt: "2026-08-19T23:00:00.000Z" }) + "\n");
  const warnings = [];
  const m = markerOver(fsx, { warn: (l) => warnings.push(l) });
  assert.equal(m.begin(), "observed");
  assert.equal(warnings.length, 1, "恰一行 WARNING（advisory，不阻塞不等待）");
  assert.ok(warnings[0].includes("[canonical] WARNING: another full suite started at 2026-08-19T23:00:00.000Z (pid 111) — results may be affected by resource contention"),
    "WARNING 文案带对方 startedAt/pid 与资源争用提示");
  assert.equal(fsx.ops.creates.length, 0, "标记已存在 ⇒ 不覆盖（非锁，不抢）");
  assert.equal(m.end(), false, "别人的标记不归本次删除——对方退出时自删，第三套件仍要能看到");
  assert.equal(fsx.ops.deletes, 0);
});

test("inflight marker: a crashed-run orphan marker warns the same way (stale JSON verbatim; torn write → unknown)", () => {
  // 崩溃残留（孤儿）与在跑套件在标记层面不可区分——printed ts/pid 让人眼可判 staleness；
  // 唯一后果就是下次打 WARNING，不产生新失败面。
  const stale = fakeInflightFs(JSON.stringify({ pid: 7, startedAt: "2026-08-01T00:00:00.000Z" }));
  const staleWarnings = [];
  markerOver(stale, { warn: (l) => staleWarnings.push(l) }).begin();
  assert.equal(staleWarnings.length, 1);
  assert.ok(staleWarnings[0].includes("started at 2026-08-01T00:00:00.000Z (pid 7)"), "孤儿标记照打 WARNING，ts/pid 原样可见");

  for (const torn of ["", "{not json"]) {
    const fsx = fakeInflightFs(torn);
    const warnings = [];
    assert.equal(markerOver(fsx, { warn: (l) => warnings.push(l) }).begin(), "observed");
    assert.equal(warnings.length, 1, `torn content ${JSON.stringify(torn)} 仍告警`);
    assert.ok(warnings[0].includes("started at unknown") && warnings[0].includes("(pid unknown)"),
      "不可解析内容降级为 unknown 占位，不 crash");
  }
});

test("inflight marker: end() delete failure is silent (no crash) and end acts at most once", () => {
  const fsx = fakeInflightFs();
  fsx.deleteMarker = () => { throw new Error("EPERM"); };
  const m = markerOver(fsx, {});
  assert.equal(m.begin(), "created");
  assert.doesNotThrow(() => m.end(), "删除失败必须静默——最坏情形只是孤儿标记（下次仅 WARNING）");
  assert.equal(m.end(), false, "end 至多作用一次：失败后不再重试不再抛");
});

test("inflight marker: an unreadable marker (fs error) degrades to absent — the suite is never blocked", () => {
  const fsx = fakeInflightFs();
  fsx.readMarker = () => { throw new Error("EACCES"); };
  const m = markerOver(fsx, {});
  assert.equal(m.begin(), "created", "读失败 ≈ 无标记（advisory 纪律：绝不阻断套件）");
});

test("inflight marker: losing the O_EXCL create race → re-read warns about the winner (no double claim)", () => {
  // 两套件几乎同时启动：我们的 read 看到 null，但 create 窗口里对方先claim——
  // create 抛 EEXIST，re-read 发现 winner ⇒ 照常 WARNING（这正是标记要捕捉的场景）。
  const winnerText = JSON.stringify({ pid: 999, startedAt: "2026-08-20T01:00:00.000Z" }) + "\n";
  const fsx = fakeInflightFs();
  fsx.createMarker = (text) => { fsx.set(winnerText); const err = new Error("EEXIST"); err.code = "EEXIST"; throw err; };
  const warnings = [];
  const m = markerOver(fsx, { warn: (l) => warnings.push(l), pid: 1 });
  assert.equal(m.begin(), "observed", "race 输家按观察者处理");
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("(pid 999)"));
  assert.equal(m.end(), false, "winner 持有标记，输家不删");
});

test("inflight marker: create failure with no marker behind it → 'unavailable' (suite runs unmarked)", () => {
  const fsx = fakeInflightFs();
  fsx.createMarker = () => { throw new Error("EPERM"); };
  const warnings = [];
  const m = markerOver(fsx, { warn: (l) => warnings.push(l) });
  assert.equal(m.begin(), "unavailable", "tmpdir 不可写 ⇒ 无标记继续跑，绝不是失败");
  assert.equal(warnings.length, 0);
  assert.equal(m.end(), false);
});

test("inflight marker: real adapter surface on a tmpdir — read null → wx-create → read → owned delete", () => {
  // 端到端回归（真 fs 路径，mkdtemp tmpdir——绝不触碰机器真实标记文件）。
  const dir = mkdtempSync(join(tmpdir(), "wao-inflight-surface-"));
  try {
    const adapter = realInflightAdapter(join(dir, INFLIGHT_MARKER_FILENAME));
    assert.equal(adapter.readMarker(), null, "缺失 = null（ENOENT 归一）");
    const warnings = [];
    const m = createInflightMarker({ ...adapter, warn: (l) => warnings.push(l), pid: 31337, now: () => "2026-08-20T02:00:00.000Z" });
    assert.equal(m.begin(), "created");
    assert.equal(warnings.length, 0);
    assert.deepEqual(JSON.parse(adapter.readMarker()), { pid: 31337, startedAt: "2026-08-20T02:00:00.000Z" });
    assert.equal(m.end(), true);
    assert.equal(adapter.readMarker(), null, "自己创建的标记退出即删");

    // 观察者路径也走真 fs：留下标记 → begin 告警 → end 不删。
    const m2 = createInflightMarker({ ...adapter, warn: (l) => warnings.push(l) });
    assert.equal(m2.begin(), "created"); // fresh dir state: previous marker was deleted
    assert.equal(m2.end(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inflight marker: machine-global location is os.tmpdir(), NEVER inside a repo", () => {
  const p = inflightMarkerPath();
  assert.equal(p, join(tmpdir(), INFLIGHT_MARKER_FILENAME), "固定名 wao-canonical-test.inflight，机器全局");
  // 必须仓外：仓内标记会被 runs-guard / gitignore 牵连（R22 W1 硬要求）。
  const here = fileURLToPath(import.meta.url);
  const repoRoot = join(here, "..", "..", "..");
  const rel = relative(repoRoot, p);
  const insideRepo = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  assert.equal(insideRepo, false, `标记路径必须在仓外（实际 ${p}，repoRoot ${repoRoot}）`);
});
