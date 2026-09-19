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
//
// TD-165 exception: the watchdog tests at the bottom of this file DO spawn real
// short-lived `node --test` children — but only against mkdtemp tmpdir synthetic
// test/ trees with 1-5s injected budgets (never the repo's own test/ tree,
// never production defaults). Everything else stays child-free.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync, statSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep, isAbsolute, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// R23-F/A A1：机器级闸路径 SSOT（src/machineGatePaths.js）。钉住 canonical-test.mjs
// 导出的 inflightMarkerPath 必须与它逐字节同源——runner 侧不得再长出第二份路径推导。
import { inflightMarkerPath as gateInflightMarkerPath } from "../../src/machineGatePaths.js";
// R23-F/B Round B：env 第二跳的变量名 SSOT。
import { VERIFICATION_GATE_HELD_ENV } from "../../src/verificationGate.js";

import {
  validateManifest, classifyIsolation, MANIFEST_GROUPS,
  runWave, runCanonical, mapReportToFiles, suiteRelToManifest,
  WAVE_PLAN, validateWavePlan,
  takeRunsSnapshot, addedRunsFiles, createRunsDirGuard, realListRunsDir,
  finalRunnerOutcome,
  createInflightMarker, realInflightAdapter, inflightMarkerPath, INFLIGHT_MARKER_FILENAME,
  // TD-165：三层看门狗的常量与真实适配器（预算全部注入 1-5s 小值，绝不用生产默认值）。
  TEST_TIMEOUT_MS, WAVE_WATCHDOG_MS, WAVE_ALARM_MS, KILL_TREE_DEADLINE_MS,
  defaultKillTree, realRunChild, realIsolator, realReadReport, realDeleteReport,
  createChildSupervisor, runSuite,
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
// { suites: [{ name: "test/<rel>", status, duration, tests: [] }, ...] }.
// `durations` is an optional rel→ms map (the reporter accumulates suite.duration
// from per-test durations; R23-F/A A3 maps that onto durationMs).
function makeReport(files, failSet, durations = {}) {
  return {
    suites: files.map((rel) => ({
      name: "test/" + rel,
      status: failSet.has(rel) ? "fail" : "pass",
      duration: durations[rel],
      tests: [],
    })),
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
  const { reportValid, perFile, perFileDurationMs } = mapReportToFiles(
    makeReport(files, new Set(["b.test.js"]), { "a.test.js": 12, "b.test.js": 34, "c.test.js": 0 }), files);
  assert.equal(reportValid, true);
  assert.equal(perFile.get("a.test.js"), "pass");
  assert.equal(perFile.get("b.test.js"), "fail");
  assert.equal(perFile.get("c.test.js"), "pass");
  // R23-F/A A3：reporter 的 suite 累计时长随判定透传（pass/fail ⇒ 非负数值原样）。
  assert.equal(perFileDurationMs.get("a.test.js"), 12);
  assert.equal(perFileDurationMs.get("b.test.js"), 34);
  assert.equal(perFileDurationMs.get("c.test.js"), 0, "0ms 是合法非负值（不得折算成 null）");
});

test("mapReportToFiles: an expected file with no suite is 'missing' (non-pass)", () => {
  const r = mapReportToFiles(
    { suites: [{ name: "test/a.test.js", status: "pass", duration: 5, tests: [] }] },
    ["a.test.js", "ghost.test.js"],
  );
  assert.equal(r.perFile.get("a.test.js"), "pass");
  assert.equal(r.perFile.get("ghost.test.js"), "missing");
  assert.equal(r.perFileDurationMs.get("a.test.js"), 5);
  assert.equal(r.perFileDurationMs.get("ghost.test.js"), null, "missing 文件没有可信耗时 ⇒ durationMs=null");
});

test("mapReportToFiles: null / malformed report is invalid (wave runner failure)", () => {
  assert.equal(mapReportToFiles(null, ["a.test.js"]).reportValid, false);
  assert.equal(mapReportToFiles({}, ["a.test.js"]).reportValid, false);
  assert.equal(mapReportToFiles({ suites: "nope" }, ["a.test.js"]).reportValid, false);
  // invalid report ⇒ every file is a crash (never silently all-pass)
  assert.equal(mapReportToFiles(null, ["a.test.js"]).perFile.get("a.test.js"), "crash");
  // A3：invalid report ⇒ 没有任何文件有可信耗时
  assert.equal(mapReportToFiles(null, ["a.test.js"]).perFileDurationMs.get("a.test.js"), null);
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
    { name: "test/a.test.js", status: "pass", duration: 5, tests: [] },
    { name: "test/a.test.js", status: "fail", duration: 7, tests: [] },
  ] }, files);
  assert.equal(r1.reportValid, true);
  assert.equal(r1.perFile.get("a.test.js"), "fail", "pass-then-fail duplicate ⇒ fail wins");
  assert.equal(r1.perFileDurationMs.get("a.test.js"), 7, "duration 跟随胜出的（fail）记录");
  const r2 = mapReportToFiles({ suites: [
    { name: "test/a.test.js", status: "fail", duration: 7, tests: [] },
    { name: "test/a.test.js", status: "pass", duration: 5, tests: [] },
  ] }, files);
  assert.equal(r2.reportValid, true);
  assert.equal(r2.perFile.get("a.test.js"), "fail", "fail-then-pass duplicate ⇒ fail still wins");
  assert.equal(r2.perFileDurationMs.get("a.test.js"), 7, "pass 不得覆盖已判 fail 记录的 duration");
});

// ── R23-F/A A3: durationMs 透传（advisory 计时元数据；绝不参与 verdict）────────
test("mapReportToFiles: durationMs normalization — missing/invalid suite.duration ⇒ null (never a fabricated 0)", () => {
  const suites = [
    { name: "test/a.test.js", status: "pass", tests: [] },                        // duration 缺失
    { name: "test/b.test.js", status: "pass", duration: -3, tests: [] },          // 负数
    { name: "test/c.test.js", status: "pass", duration: Number.NaN, tests: [] },  // NaN
    { name: "test/d.test.js", status: "pass", duration: "12", tests: [] },        // 非数值类型
  ];
  const rels = ["a.test.js", "b.test.js", "c.test.js", "d.test.js"];
  const { reportValid, perFileDurationMs } = mapReportToFiles({ suites }, rels);
  assert.equal(reportValid, true, "duration 形状不影响 verdict 面（report 仍有效）");
  for (const rel of rels) {
    assert.equal(perFileDurationMs.get(rel), null, `${rel}: 非法 duration ⇒ null（诚实的"未测得"，不编造 0）`);
  }
});

test("runWave: results carry durationMs from the winning suite record; crash paths (missing report / delete failure) are null", async () => {
  const files = waveFiles(["a.test.js", "b.test.js"], "pure");
  const runChild = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  const readReport = async () => makeReport(["a.test.js", "b.test.js"], new Set(["b.test.js"]), { "a.test.js": 120, "b.test.js": 30 });
  const w = await runWave({ name: "pure", files, concurrency: 2, reporterArg: "R", runChild, readReport, deleteReport: noopDelete });
  assert.deepEqual(
    w.results.map((r) => ({ path: r.path, status: r.status, durationMs: r.durationMs })),
    [
      { path: "a.test.js", status: "pass", durationMs: 120 },
      { path: "b.test.js", status: "fail", durationMs: 30 },
    ],
    "每个 result 带 durationMs（pass/fail ⇒ 非负数值）",
  );

  const crashed = await runWave({ name: "pure", files, concurrency: 2, reporterArg: "R", runChild, readReport: async () => null, deleteReport: noopDelete });
  assert.ok(crashed.results.every((r) => r.status === "crash" && r.durationMs === null), "报告缺失 ⇒ 全 crash ⇒ durationMs=null");

  const blocked = await runWave({
    name: "pure", files, concurrency: 2, reporterArg: "R",
    runChild, readReport: async () => makeReport(["a.test.js"], new Set()),
    deleteReport: async () => { throw new Error("EPERM delete blocked"); },
  });
  assert.ok(blocked.results.every((r) => r.status === "crash" && r.durationMs === null), "delete 失败（未读报告）⇒ crash + durationMs=null");
});

test("A3 pin: executionWaves[].files[].durationMs — pass/fail non-negative numeric, missing/crash null", async () => {
  const specs = [
    { name: "pure", concurrency: 2, categories: ["pure"], files: waveFiles(["ok.test.js"], "pure") },
    { name: "process", concurrency: 1, categories: ["process"], files: waveFiles(["bad.test.js"], "process") },
  ];
  let call = 0;
  const reports = [
    makeReport(["ok.test.js"], new Set(), { "ok.test.js": 45 }),
    makeReport(["bad.test.js"], new Set(["bad.test.js"]), { "bad.test.js": 0 }),
  ];
  const out = await runCanonical({
    waveSpecs: specs, reporterArg: "R",
    runChild: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readReport: async () => reports[call++],
    deleteReport: noopDelete,
  });
  assert.equal(out.waves.length, 2);
  assert.deepEqual(
    out.waves.flatMap((w) => w.files),
    [
      { path: "ok.test.js", status: "pass", resourceCategory: "pure", executionWave: "pure", durationMs: 45 },
      { path: "bad.test.js", status: "fail", resourceCategory: "process", executionWave: "process", durationMs: 0 },
    ],
    "bounded 报告的 executionWaves[].files[] 形状：durationMs 是 pass/fail 文件的非负数值（0 合法）",
  );
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
// R22 W1 + R23-F/A A2: advisory inflight marker — pure decision core over an
// injectable fs adapter (finalRunnerOutcome idiom). The marker is machine-
// global under %LOCALAPPDATA%\wao (fallback ~/.wao-machine, via the
// src/machineGatePaths.js SSOT this file pins below) — deliberately NOT inside
// any repo (never entangled with runs-guard/gitignore) and NEVER derived from
// TMP/TEMP/TMPDIR. It is advisory ONLY: a second concurrent full suite prints
// one line and keeps running — never blocks, never waits, no budget. Since A2
// that line is severity-split by an injectable existence probe (killProbe,
// default process.kill(pid, 0)): a PROVABLY dead owner (probe → ESRCH)
// downgrades to a NOTICE; alive / EPERM / unprovable / unparsable-pid keep the
// original WARNING verbatim (fail-safe: no proof of death ⇒ no downgrade).
// These meta-tests inject a fake fs AND a fake probe, so they never touch a
// real process or the machine's real marker; the real-adapter test below uses
// a mkdtemp tmpdir. Nothing here executes main(): importing canonical-test.mjs
// never runs the marker logic (invokedDirectly guard).
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
// A2 注入形状：存在性探针的"证死"错误。win32 libuv 实证（2026-08-21，对已退出
// 子进程 pid 调 process.kill(pid, 0)）：`Error: kill ESRCH`，code 字符串恰为
// "ESRCH"（POSIX errno 名；实现只认这个精确码——任何其它抛错一律不降级）。
const esrhError = () => { const e = new Error("kill ESRCH"); e.code = "ESRCH"; return e; };
function markerOver(fsx, extras = {}) {
  return createInflightMarker({
    readMarker: fsx.readMarker, createMarker: fsx.createMarker, deleteMarker: fsx.deleteMarker,
    warn: extras.warn, killProbe: extras.killProbe, pid: extras.pid, now: extras.now,
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
  // A2：注入活体探针（返回即存活）——本测试钉的是"对方活着 ⇒ WARNING"分支，
  // 与机器上 pid 111 真实死活无关（默认探针会让该断言依赖宿主进程表，不可确定）。
  const m = markerOver(fsx, { warn: (l) => warnings.push(l), killProbe: () => {} });
  assert.equal(m.begin(), "observed");
  assert.equal(warnings.length, 1, "恰一行 WARNING（advisory，不阻塞不等待）");
  assert.ok(warnings[0].includes("[canonical] WARNING: another full suite started at 2026-08-19T23:00:00.000Z (pid 111) — results may be affected by resource contention"),
    "WARNING 文案带对方 startedAt/pid 与资源争用提示");
  assert.equal(fsx.ops.creates.length, 0, "标记已存在 ⇒ 不覆盖（非锁，不抢）");
  assert.equal(m.end(), false, "别人的标记不归本次删除——对方退出时自删，第三套件仍要能看到");
  assert.equal(fsx.ops.deletes, 0);
});

test("inflight marker: a stale orphan with a LIVE-looking pid keeps the WARNING; torn/unparseable content ALWAYS warns as WARNING", () => {
  // A2 后语义更新：孤儿与在跑套件不再无条件不可区分——存在性探针证得死
  // （kill(pid,0) → ESRCH）才降 NOTICE。本测试钉住降级的另一半：探针说活
  // （注入活体 probe）时孤儿照旧 WARNING；损坏 JSON 即使探针会说死也维持
  // WARNING（fail-safe：证不出死就不降级），printed ts/pid 落到 unknown 占位、
  // 不 crash、无宽限/重建语义。
  const stale = fakeInflightFs(JSON.stringify({ pid: 7, startedAt: "2026-08-01T00:00:00.000Z" }));
  const staleWarnings = [];
  markerOver(stale, { warn: (l) => staleWarnings.push(l), killProbe: () => {} }).begin();
  assert.equal(staleWarnings.length, 1);
  assert.ok(staleWarnings[0].includes("started at 2026-08-01T00:00:00.000Z (pid 7)"), "探针说活 ⇒ 孤儿标记照打 WARNING，ts/pid 原样可见");

  for (const torn of ["", "{not json"]) {
    const fsx = fakeInflightFs(torn);
    const warnings = [];
    assert.equal(markerOver(fsx, { warn: (l) => warnings.push(l), killProbe: () => { throw esrhError(); } }).begin(), "observed");
    assert.equal(warnings.length, 1, `torn content ${JSON.stringify(torn)} 仍告警`);
    assert.ok(warnings[0].includes("started at unknown") && warnings[0].includes("(pid unknown)"),
      "不可解析内容降级为 unknown 占位，不 crash");
  }
});

// ── R23-F/A A2：死 pid 降级 NOTICE（killProbe 注入；默认 process.kill(pid, 0)）──
test("A2①: provably-dead marker pid (probe → ESRCH) ⇒ exactly one NOTICE carrying pid+startedAt, never the word WARNING", () => {
  const fsx = fakeInflightFs(JSON.stringify({ pid: 7, startedAt: "2026-08-01T00:00:00.000Z" }) + "\n");
  const lines = [];
  const m = markerOver(fsx, {
    warn: (l) => lines.push(l),
    killProbe: () => { throw esrhError(); }, // 存在性探针证死（win32 实证 shape：code "ESRCH"）
  });
  assert.equal(m.begin(), "observed", "降级只改告警文案与严重度——观察者返回值/语义不变");
  assert.equal(lines.length, 1, "恰一行输出");
  assert.ok(!lines[0].includes("WARNING"), "NOTICE 行绝不含 WARNING 字样（两种严重度机器可区分）");
  assert.ok(lines[0].includes("[canonical] NOTICE:"), "降级为 NOTICE 前缀");
  assert.ok(lines[0].includes("(pid 7") && lines[0].includes("2026-08-01T00:00:00.000Z"),
    "NOTICE 带 marker 内的 pid 与 startedAt（人眼判 staleness 的锚点保留）");
  assert.equal(fsx.ops.creates.length, 0, "无宽限/重建语义：证死也不覆盖别人的标记");
  assert.equal(m.end(), false, "无接管语义：证死也不删别人的标记（删除权仍归写入者自己）");
});

test("A2②: alive pid (probe returns normally) and EPERM (exists but not ours) both keep the original WARNING verbatim", () => {
  const cases = [
    ["alive", () => {}],
    ["EPERM", () => { const e = new Error("kill EPERM"); e.code = "EPERM"; throw e; }],
  ];
  for (const [label, probe] of cases) {
    const fsx = fakeInflightFs(JSON.stringify({ pid: 4242, startedAt: "2026-08-20T09:00:00.000Z" }) + "\n");
    const warnings = [];
    markerOver(fsx, { warn: (l) => warnings.push(l), killProbe: probe }).begin();
    assert.equal(warnings.length, 1, `${label}: 恰一行`);
    assert.ok(
      warnings[0].startsWith("[canonical] WARNING: another full suite started at 2026-08-20T09:00:00.000Z (pid 4242) — results may be affected by resource contention"),
      `${label}: WARNING 原文逐字不变（证不出死就不降级）`,
    );
    assert.ok(!warnings[0].includes("NOTICE"), `${label}: 不混入 NOTICE 字样`);
  }
});

test("A2③: fail-safe — unparseable / pid-less marker content NEVER downgrades even though the injected probe says dead", () => {
  const torn = [
    "",                                  // 空写
    "{not json",                         // 撕裂 JSON
    "null",                              // 解析为 null（|| {} 兜底）
    "{}",                                // 无 pid
    '{"pid":"7"}',                       // pid 非数值
    '{"startedAt":"2026-08-01T00:00:00.000Z"}', // 只有 ts、无 pid
  ];
  for (const content of torn) {
    const fsx = fakeInflightFs(content);
    const lines = [];
    markerOver(fsx, { warn: (l) => lines.push(l), killProbe: () => { throw esrhError(); } }).begin();
    assert.equal(lines.length, 1, `${JSON.stringify(content)}: 仍恰一行`);
    assert.ok(lines[0].startsWith("[canonical] WARNING:") && !lines[0].includes("NOTICE"),
      `${JSON.stringify(content)}: 证不出 pid 的死活 ⇒ 维持 WARNING，绝不降级`);
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
  // A2：注入活体探针——winner pid 999 在本测试里必须按"活着"处理（与宿主进程表解耦）。
  const m = markerOver(fsx, { warn: (l) => warnings.push(l), pid: 1, killProbe: () => {} });
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

test("inflight marker: machine-global location derives from %LOCALAPPDATA%\\wao via the machineGatePaths SSOT — NEVER a repo, NEVER tmpdir", () => {
  const p = inflightMarkerPath();
  // A1：runner 侧不再自有推导——必须与 src/machineGatePaths.js 逐字节同源（纯委托）。
  assert.equal(p, gateInflightMarkerPath(), "canonical-test.mjs 的 inflightMarkerPath 是 machineGatePaths SSOT 的纯委托");
  // A1 pinning：%LOCALAPPDATA%\wao 派生（win32）；LOCALAPPDATA 缺失回落 ~/.wao-machine。
  const expectedDir = process.platform === "win32" && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "wao")
    : join(homedir(), ".wao-machine");
  assert.equal(dirname(p), expectedDir, `标记目录须为机器级状态目录（实际 ${p}）`);
  assert.equal(basename(p), INFLIGHT_MARKER_FILENAME, "固定名 wao-canonical-test.inflight，机器全局");
  // env 免疫（本模块存在的理由）：绝不从 TMP/TEMP/TMPDIR 推导——delivery harness
  // 注入 fresh per-attempt temp 的正是这三个变量。
  for (const t of [process.env.TEMP, process.env.TMP, process.env.TMPDIR]) {
    if (!t) continue;
    const norm = t.replace(/[\\/]+$/, "").toLowerCase();
    assert.ok(!p.toLowerCase().startsWith(norm + "\\") && !p.toLowerCase().startsWith(norm + "/") && p.toLowerCase() !== norm,
      `路径不得落在注入的 TEMP/TMP/TMPDIR 下（${t}）——实际 ${p}`);
  }
  // 必须仓外：仓内标记会被 runs-guard / gitignore 牵连（R22 W1 硬要求，语义保留）。
  const here = fileURLToPath(import.meta.url);
  const repoRoot = join(here, "..", "..", "..");
  const rel = relative(repoRoot, p);
  const insideRepo = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  assert.equal(insideRepo, false, `标记路径必须在仓外（实际 ${p}，repoRoot ${repoRoot}）`);
});

// ===== R23-F/B Round B (TD-130) B2⑥/⑦ + B5: canonical main() 的闸包裹 =====
//
// main() 的编排在 startCanonicalSuite 里可注入重放（createGate/createMarkerAdapter/
// runSuiteFn 全部可换）。硬顺序：acquire → childEnv（此刻才注入 HELD——R22 的
// :725-before-:733 快照顺序缺陷的闸版不许重演）→ marker.begin → suite →
// marker.end → release。kill switch 关闭 ⇒ createGate 为 null ⇒ 完全跳过闸段，
// marker 层原样保留（降级态告警层）。
//
// 新导出用动态 import：导出缺失只红新测试，不炸本文件其余 60+ 条已钉死的
// 不变量（静态 import 会在链接期让整个文件失败）。

test("B2-⑥ buildCanonicalChildEnv：基础注入 WAO_SKIP_VERSION_GUARD；held 才注入 HELD=1", async () => {
  const { buildCanonicalChildEnv } = await import("../../scripts/canonical-test.mjs");

  const bare = buildCanonicalChildEnv({ PATH: "keep" }, { gateHeld: false });
  assert.equal(bare.WAO_SKIP_VERSION_GUARD, "1", "版本守卫豁免是既有行为（语义保留）");
  assert.equal(bare.PATH, "keep", "其余 env 原样透传");
  assert.equal(bare[VERIFICATION_GATE_HELD_ENV], undefined, "未持闸不得主动注入 HELD 标记");

  const held = buildCanonicalChildEnv({ PATH: "keep" }, { gateHeld: true });
  assert.equal(held[VERIFICATION_GATE_HELD_ENV], "1", "持闸时 wave 子进程必须看到 HELD=1（env 第二跳）");

  // 祖先真持闸时继承进来的 HELD 值必须原样透传（剥离它会让子进程在祖先仍持
  // 租约时去重新认领——自锁）。gateHeld:false 只表示"本进程不新增标记"。
  const inherited = buildCanonicalChildEnv(
    { [VERIFICATION_GATE_HELD_ENV]: "1" }, { gateHeld: false },
  );
  assert.equal(inherited[VERIFICATION_GATE_HELD_ENV], "1", "继承的标记不得被剥离");
});

test("B2-⑦ startCanonicalSuite 编排硬顺序：acquire→childEnv→marker.begin→suite→marker.end→release", async () => {
  const { startCanonicalSuite } = await import("../../scripts/canonical-test.mjs");
  const ops = [];
  let seenSuiteArgs = null;
  const fakeGate = {
    acquire: async () => {
      ops.push("gate:acquire");
      return { token: "tok-canonical", lost: () => false, release: async () => { ops.push("gate:release"); return true; } };
    },
  };
  const fakeInflight = {
    begin: () => { ops.push("marker:begin"); return "created"; },
    end: () => { ops.push("marker:end"); return true; },
  };

  await startCanonicalSuite({
    repoRoot: ".", testDir: "test", manifestPath: "test/manifest.json",
    reportPath: "test-results.json", nodeExe: process.execPath,
    env: { BASE: "1" },
    createGate: () => fakeGate,
    createMarker: () => fakeInflight,
    runSuiteFn: async (args) => { ops.push("suite"); seenSuiteArgs = args; },
  });

  assert.deepEqual(ops,
    ["gate:acquire", "marker:begin", "suite", "marker:end", "gate:release"],
    "硬顺序：先入闸再开跑；marker.end 先于 release（finally 纪律）");
  // childEnv 在 acquire 之后构造的可观察证据：交给 suite 的 env 带 HELD=1
  // （若先构 env 后 acquire，HELD 无从注入——顺序缺陷会在这里现形）。
  assert.equal(seenSuiteArgs.childEnv[VERIFICATION_GATE_HELD_ENV], "1",
    "suite 收到的 childEnv 必须已含 HELD=1（env 第二跳）");
  assert.equal(seenSuiteArgs.childEnv.WAO_SKIP_VERSION_GUARD, "1");
  assert.equal(seenSuiteArgs.childEnv.BASE, "1", "基础 env 原样透传");
});

test("B2-⑦b kill switch（createGate=null）⇒ 零闸段、marker 层原样、env 无 HELD", async () => {
  const { startCanonicalSuite } = await import("../../scripts/canonical-test.mjs");
  const ops = [];
  let seenSuiteArgs = null;
  await startCanonicalSuite({
    repoRoot: ".", testDir: "test", manifestPath: "test/manifest.json",
    reportPath: "test-results.json", nodeExe: process.execPath,
    env: {},
    createGate: null,
    createMarker: () => ({
      begin: () => { ops.push("marker:begin"); return "created"; },
      end: () => { ops.push("marker:end"); return true; },
    }),
    runSuiteFn: async (args) => { ops.push("suite"); seenSuiteArgs = args; },
  });
  assert.deepEqual(ops, ["marker:begin", "suite", "marker:end"],
    "停用开关下完全绕过闸（降级为 R22 marker 告警层）");
  assert.equal(seenSuiteArgs.childEnv[VERIFICATION_GATE_HELD_ENV], undefined);
});

test("B2-⑦c suite 抛错 ⇒ marker.end 与 release 仍按序执行，错误向上传播", async () => {
  const { startCanonicalSuite } = await import("../../scripts/canonical-test.mjs");
  const ops = [];
  const boom = new Error("suite exploded");
  await assert.rejects(
    startCanonicalSuite({
      repoRoot: ".", testDir: "test", manifestPath: "test/manifest.json",
      reportPath: "test-results.json", nodeExe: process.execPath,
      env: {},
      createGate: () => ({
        acquire: async () => ({
          token: "tok-x", lost: () => false,
          release: async () => { ops.push("gate:release"); return true; },
        }),
      }),
      createMarker: () => ({
        begin: () => { ops.push("marker:begin"); return "created"; },
        end: () => { ops.push("marker:end"); return true; },
      }),
      runSuiteFn: async () => { ops.push("suite"); throw boom; },
    }),
    (err) => err === boom,
    "闸包裹不得吞掉 suite 错误（验证语义不被闸改变）",
  );
  assert.deepEqual(ops, ["marker:begin", "suite", "marker:end", "gate:release"],
    "失败路径的 finally 纪律与成功路径一致");
});

test("B5 RED isolationDurationMs 透传：isolator 的 durationMs 进入 isolation 条目；缺失=null", async () => {
  const files = waveFiles(["flake.test.js"], "worktree");
  const runChild = async () => ({ exitCode: 1, stdout: "", stderr: "" });
  const readReport = async () => makeReport(["flake.test.js"], new Set(["flake.test.js"]));
  const out = await runCanonical({
    waveSpecs: [{ name: "filesystem", concurrency: 8, categories: ["git", "worktree"], files }],
    reporterArg: "R", runChild, readReport, deleteReport: noopDelete,
    isolator: async () => ({ status: "fail", exitCode: 1, durationMs: 123, tail: "t" }),
  });
  assert.equal(out.isolation.length, 1);
  assert.equal(out.isolation[0].isolationDurationMs, 123,
    "realIsolator 已算出的 durationMs 必须进 bounded report（B5：:677-686 丢弃缺陷）");

  const outNoDur = await runCanonical({
    waveSpecs: [{ name: "filesystem", concurrency: 8, categories: ["git", "worktree"], files }],
    reporterArg: "R", runChild, readReport, deleteReport: noopDelete,
    isolator: async () => ({ status: "fail", exitCode: 1, tail: "t" }),
  });
  assert.equal(outNoDur.isolation[0].isolationDurationMs, null, "缺失时归一为 null（不编造 0）");
});

// ────────────────────────────────────────────────────────────────────────────
// TD-165：canonical runner 挂死看门狗（三层）。
//
//   R1 per-test 超时直通 —— 每个 `node --test` 子进程 argv 带 --test-timeout
//      （首轮波 + 隔离重跑两个适配器都要）；Node 在文件级从它自己的父进程
//      执行超时，同步 while(true) 也拦得住（2026-09-19 v22.23.1 实测）。
//   R2 波级兜底看门狗 —— 每个子进程墙钟 timer；到期 taskkill /PID <自己的
//      pid> /T /F（绝不全局杀 node.exe），kill(pid,0)→ESRCH 探针确认死透
//      （500ms × 最多 3 次）；确认 ⇒ 全文件 crash + crashReason
//      "watchdog_timeout" + groupError（波名/耗时/标记/清理状态）；未确认 ⇒
//      "cleanup unconfirmed"，不再启动后续波次，verdict=fail。
//   R3 慢波告警 —— 纯读 NOTICE 行，不杀不影响 verdict。
//
// 预算注入纪律（F4 修复轮收紧）：真实子进程测试一律注入 1-5s 区间小值
// （supervisionLoop 注入先例），绝不用生产默认值，也不再用越界的 0.2-10s。
// 真实子进程全部跑在 mkdtemp tmpdir 的合成 test/ 树上（reporter 用 file://
// 绝对 URL 指向仓库自带 test/reporter.mjs，报告落在 tmpdir/test-results.json）
// ——绝不触碰仓库自己的 test/ 与 test-results.json，manifest/discovery 不受影响。
// 记账事实（2026-09-19 实测钉死，F3 修复轮更新）：挂死测试自身永不产生
// test:complete；Node 以文件级事件收尾——test:complete(name=文件路径,
// passed=false) 与 test:fail(同 name)，details.error.message="test timed out
// after Nms"。reporter（F3 后）把文件级失败事件记入 suite：status=fail +
// fileFailure 原因，同文件已通过的兄弟条目保留可见 ⇒ runWave 映射为
// "fail"（带原因、指名文件，且进隔离重跑）。修复前的形状：无 suite ⇒
// missing；兄弟通过时 suite 误记 pass、只剩波级 groupError 不指名文件。
// ────────────────────────────────────────────────────────────────────────────

test("TD-165 budgets: 生产默认值钉死（600s per-test / 900s 波级兜底 / 300s 告警；兜底必须大于 per-test 上限）", () => {
  assert.equal(TEST_TIMEOUT_MS, 600000, "R1：600s（实测最慢文件 133s / 波峰 207s 的 3-4.5 倍余量）");
  assert.equal(WAVE_WATCHDOG_MS, 900000, "R2：900s（3× 实测波峰 207s 向上取整）");
  assert.equal(WAVE_ALARM_MS, 300000, "R3：300s 信息告警");
  assert.ok(WAVE_WATCHDOG_MS > TEST_TIMEOUT_MS, "兜底必须严格大于 per-test 上限 + 排队余量（先 R1 后 R2）");
  assert.ok(WAVE_ALARM_MS < WAVE_WATCHDOG_MS, "告警先于兜底");
  assert.ok(WAVE_ALARM_MS > 0 && TEST_TIMEOUT_MS > 0 && WAVE_WATCHDOG_MS > 0);
  // 修复轮（残余必修）：killTree 有期限竞速常量——kill 挂住不得拖垮看门狗自身。
  assert.equal(KILL_TREE_DEADLINE_MS, 10000, "killTree 竞速期限 10s（到期放弃等待，照常进探针环节）");
});

test("TD-165 R1 wiring: runWave 的 argv 默认带 --test-timeout=<生产常量>；注入值覆盖；波名随第二参透传（告警归因）", async () => {
  let seenArgv = null;
  let seenOpts = null;
  const files = waveFiles(["a.test.js"], "pure");
  const drive = async (testTimeoutMs, runChild) => runWave({
    name: "pure", files, concurrency: 1, reporterArg: "R", runChild,
    readReport: async () => makeReport(["a.test.js"], new Set()), deleteReport: noopDelete,
    ...(testTimeoutMs !== undefined ? { testTimeoutMs } : {}),
  });
  await drive(undefined, async (argv, opts) => { seenArgv = argv; seenOpts = opts; return { exitCode: 0, stdout: "", stderr: "" }; });
  assert.ok(seenArgv.includes(`--test-timeout=${TEST_TIMEOUT_MS}`), "缺省 ⇒ 生产常量直通（R1 主防线默认在场）");
  assert.equal(seenOpts.waveName, "pure", "波名经第二参注入（R3 告警行 / R2 归因用）");
  assert.ok(seenArgv.includes("--test") && seenArgv.includes("--test-concurrency=1"));

  await drive(1234, async (argv) => { seenArgv = argv; return { exitCode: 0, stdout: "", stderr: "" }; });
  assert.ok(seenArgv.includes("--test-timeout=1234") && !seenArgv.includes(`--test-timeout=${TEST_TIMEOUT_MS}`),
    "注入小值必须精确覆盖（测试纪律：绝不用生产默认值）");
});

test("TD-165 R2（纯）: runChild 报 watchdog ⇒ 不读报告、全文件 crash+watchdog_timeout、groupError 四要素齐、abortSuite=false", async () => {
  let readCalls = 0;
  const w = await runWave({
    name: "lock", files: waveFiles(["a.test.js", "b.test.js"], "lock"), concurrency: 1, reporterArg: "R",
    runChild: async () => ({ exitCode: null, stdout: "", stderr: "", watchdog: { fired: true, confirmed: true, elapsedMs: 321, probes: 1, pid: 4242, limitMs: 5000 } }),
    readReport: async () => { readCalls += 1; return null; },
    deleteReport: noopDelete,
  });
  assert.equal(readCalls, 0, "watchdog 分支绝不读报告（spawn 前已删的旧报告不可信）");
  assert.ok(w.results.every((r) => r.status === "crash" && r.crashReason === "watchdog_timeout"), "全文件 crash 且带 crashReason");
  assert.ok(w.groupError.includes("'lock'"), "groupError 含波名");
  assert.ok(w.groupError.includes("321ms"), "groupError 含已耗时 ms");
  assert.ok(w.groupError.includes("watchdog backstop fired"), "groupError 含 watchdog 标记");
  assert.ok(w.groupError.includes("cleanup confirmed"), "groupError 含清理已确认");
  assert.equal(w.abortSuite, false, "确认死透 ⇒ 不中止套件（后续波照常）");
  assert.equal(w.watchdog.confirmed, true);
});

test("TD-165 R2（纯）: cleanup 未确认 ⇒ abortSuite=true + groupError 写明 cleanup unconfirmed", async () => {
  const w = await runWave({
    name: "pure", files: waveFiles(["a.test.js"], "pure"), concurrency: 1, reporterArg: "R",
    runChild: async () => ({ exitCode: null, stdout: "", stderr: "", watchdog: { fired: true, confirmed: false, elapsedMs: 999, probes: 3, pid: 7, limitMs: 500 } }),
    readReport: async () => null, deleteReport: noopDelete,
  });
  assert.equal(w.abortSuite, true, "未确认死透 ⇒ 中止（不许带残留继续跑）");
  assert.ok(w.groupError.includes("cleanup unconfirmed"), "groupError 写明 cleanup unconfirmed");
  assert.ok(w.groupError.includes("'pure'") && w.groupError.includes("999ms") && w.groupError.includes("watchdog backstop fired"));
  assert.ok(w.results.every((r) => r.status === "crash" && r.crashReason === "watchdog_timeout"));
});

test("TD-165 R5（纯）: 看门狗杀掉的隔离重跑 ⇒ stable_fail（真挂死）；无归因 crash 仍 environment_invalid（既有语义不动）", () => {
  assert.equal(classifyIsolation("fail", "crash", "watchdog_timeout"), "stable_fail", "单独跑也挂死 = 真测试挂死");
  assert.equal(classifyIsolation("crash", "crash", "watchdog_timeout"), "stable_fail");
  assert.equal(classifyIsolation("fail", "crash", null), "environment_invalid", "无归因 crash 语义保持");
  assert.equal(classifyIsolation("fail", "crash"), "environment_invalid", "两参调用形状（既有钉）保持");
  assert.equal(classifyIsolation("fail", "crash", "spawn_enoent"), "environment_invalid", "只有 watchdog_timeout 是特例");
  assert.equal(classifyIsolation("pass", "crash", "watchdog_timeout"), "not_rechecked", "首轮 pass 永不重查（既有钉）");
});

test("TD-165 R2.4（纯，隔离腿）: 隔离重跑遇未确认清理 ⇒ 该条目入列后不再 spawn 后续重跑", async () => {
  const isoCalls = [];
  const specs = [{ name: "pure", concurrency: 2, categories: ["pure"], files: waveFiles(["a.test.js", "b.test.js"], "pure") }];
  const out = await runCanonical({
    waveSpecs: specs, reporterArg: "R",
    runChild: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    readReport: async () => makeReport(["a.test.js", "b.test.js"], new Set(["a.test.js", "b.test.js"])),
    deleteReport: noopDelete,
    isolator: async ({ file }) => {
      isoCalls.push(file);
      // 第一个重跑被兜底收杀且清理未确认；第二个不得再 spawn。
      if (isoCalls.length === 1) {
        return { status: "crash", exitCode: null, crashReason: "watchdog_timeout", durationMs: 5, tail: "t",
          watchdog: { fired: true, confirmed: false, elapsedMs: 5, probes: 3, pid: 11, limitMs: 10 } };
      }
      return { status: "fail", exitCode: 1, tail: "t" };
    },
  });
  assert.deepEqual(isoCalls, ["a.test.js"], "未确认清理后不再启动后续隔离重跑（不许带残留继续跑）");
  assert.equal(out.isolation.length, 1);
  assert.equal(out.isolation[0].crashReason, "watchdog_timeout");
  // F6：隔离条目透传 watchdog 全字段——"报告可拿到 pid"的承诺对隔离腿也成立。
  assert.deepEqual(out.isolation[0].watchdog, { fired: true, confirmed: false, elapsedMs: 5, probes: 3, pid: 11, limitMs: 10 },
    "isolation 条目带 fired/confirmed/elapsedMs/probes/pid/limitMs（聚合报告不再丢弃）");
  assert.equal(out.suiteAborted, true);
  assert.equal(out.abortOrigin, "isolation", "F6：中止来源=隔离腿（首轮波其实已跑完，停的是后续重跑）");
  assert.equal(out.finalVerdict, "fail");
});

// ── TD-165 真实子进程夹具：合成 test/ 树（tmpdir）+ 仓库 reporter 的 file:// URL ──
const synthRepoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");
const SYNTH_REPORTER = pathToFileURL(join(synthRepoRoot, "test", "reporter.mjs")).href;
const SYNTH_OK = 'import { test } from "node:test";\ntest("ok", () => {});\n';
const SYNTH_HANG_ASYNC = [
  'import { test } from "node:test";',
  'test("hangs forever", () => new Promise(() => {}));',
  "const iv = setInterval(() => {}, 50); // pending handle：文件活到超时收杀为止",
  "",
].join("\n");
const SYNTH_HANG_SYNC = 'import { test } from "node:test";\ntest("sync infinite loop", () => { while (true) {} });\n';
// F3 审计场景：同文件 1 个通过兄弟 + 1 个挂死测试——修复前 suite 误记 pass、
// 只剩波级 groupError 不指名文件的正是这个形状。
const SYNTH_HANG_SIB = [
  'import { test } from "node:test";',
  'test("passes fine", () => {});',
  'test("hangs forever", () => new Promise(() => {}));',
  "const iv = setInterval(() => {}, 50); // pending handle：文件活到超时收杀为止",
  "",
].join("\n");
const synthSlowOk = (ms) => `import { test } from "node:test";\ntest("slow but legal", () => new Promise((r) => setTimeout(r, ${ms})));\n`;

function synthWorkspace(prefix, files) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n', "utf8");
  mkdirSync(join(root, "test"), { recursive: true });
  for (const [rel, source] of Object.entries(files)) writeFileSync(join(root, "test", rel), source, "utf8");
  return root;
}

// 本文件自身跑在 `node --test` 之下，其 env 带 node 注入的 NODE_TEST_CONTEXT；
// 原样传给合成孙进程会让 node 认为"在测试文件里递归 run()"——跳过执行所有
// 文件、秒退且无报告（实测：exit 0 + "run() is being called recursively"）。
// 剥离后再传。生产 runner 不经此路径（npm test 的 runner 进程不是 --test 子进程）。
function synthChildEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// 真适配器驱动一个合成波（cwd=tmpdir ⇒ reporter 报告写 tmpdir/test-results.json）。
async function runSynthWave(root, { name = "pure", rels, category = "pure", concurrency = 2, testTimeoutMs, watch = {} }) {
  return runWave({
    name, files: waveFiles(rels, category), concurrency, reporterArg: SYNTH_REPORTER,
    runChild: realRunChild(process.execPath, root, synthChildEnv(), { waveAlarmMs: 0, ...watch }),
    readReport: realReadReport(join(root, "test-results.json")),
    deleteReport: realDeleteReport(join(root, "test-results.json")),
    testTimeoutMs,
  });
}

test("TD-165 T1: 异步 never-resolve + 注入 1s per-test 超时 ⇒ 该文件非 pass、波正常收尾、同波其他文件不受影响", async () => {
  const root = synthWorkspace("wao-td165-t1-", { "hang.test.js": SYNTH_HANG_ASYNC, "ok.test.js": SYNTH_OK });
  try {
    const w = await runSynthWave(root, { rels: ["hang.test.js", "ok.test.js"], testTimeoutMs: 1000, watch: { waveWatchdogMs: 5000 } });
    const byPath = new Map(w.results.map((r) => [r.path, r]));
    assert.equal(byPath.get("ok.test.js").status, "pass", "同波其他文件不受影响");
    assert.notEqual(byPath.get("hang.test.js").status, "pass", "挂死文件必须非 pass");
    // F3 修复轮：断言钉语义不钉实现——非 pass 且归因到该文件（fail=文件级失败
    // 事件带原因 / missing=无 suite；两者都是文件级归因，区别于 crash=波级失能）。
    const hangStatus = byPath.get("hang.test.js").status;
    assert.ok(hangStatus === "fail" || hangStatus === "missing",
      `挂死文件必须归因到该文件（fail|missing，实际 ${hangStatus}）——R1 主防线把它变成有界等待`);
    assert.equal(w.groupError, null, "per-test 超时是正常失败事件（非波级失能），波照常收尾");
    assert.ok(!w.abortSuite && !w.watchdog);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("TD-165 T2: 同步 while(true) 死循环 + 注入 1s per-test 超时 ⇒ 父进程级收杀，同样有界收尾", async () => {
  const root = synthWorkspace("wao-td165-t2-", { "loop.test.js": SYNTH_HANG_SYNC, "ok.test.js": SYNTH_OK });
  try {
    const w = await runSynthWave(root, { rels: ["loop.test.js", "ok.test.js"], testTimeoutMs: 1000, watch: { waveWatchdogMs: 5000 } });
    const byPath = new Map(w.results.map((r) => [r.path, r]));
    assert.equal(byPath.get("ok.test.js").status, "pass");
    // F3 修复轮：同 T1——钉"非 pass 且归因到该文件"的语义，不钉 missing 这个具体值。
    const loopStatus = byPath.get("loop.test.js").status;
    assert.notEqual(loopStatus, "pass", "挂死文件必须非 pass");
    assert.ok(loopStatus === "fail" || loopStatus === "missing",
      `事件循环阻塞拦不住父进程级超时（v22 实测）：文件被收杀且归因到该文件（实际 ${loopStatus}）`);
    assert.equal(w.groupError, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("TD-165 T3: 竞态——恰在注入超时之下完成的测试正常通过，无误杀", async () => {
  // F5 修复轮：完成时间 ≈ 注入超时的 70%（1400ms / 2000ms）。余量取舍：300ms/2500ms
  // （8%）证不了"恰在超时之下"；90%+ 又会把慢机调度抖动放大成误杀假阳性；70%
  // 离边界近到能证"之下不误杀"，同时 600ms 余量吸收子进程启动/调度延迟。
  const root = synthWorkspace("wao-td165-t3-", { "slow.test.js": synthSlowOk(1400) });
  try {
    const w = await runSynthWave(root, { rels: ["slow.test.js"], testTimeoutMs: 2000, watch: { waveWatchdogMs: 5000 } });
    assert.equal(w.results[0].status, "pass", "1400ms 慢而合法的测试在 2000ms 上限（70% 边界）内 ⇒ pass（不误杀）");
    assert.equal(w.groupError, null);
    assert.ok(!w.watchdog, "兜底未触发");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("TD-165 T4: 波级兜底先于 per-test 超时触发（注入小 watchdogMs + 真实 taskkill）⇒ 全文件 crash + crashReason + groupError 四要素", async () => {
  const root = synthWorkspace("wao-td165-t4-", { "hang.test.js": SYNTH_HANG_ASYNC, "ok.test.js": SYNTH_OK });
  try {
    const w = await runSynthWave(root, {
      name: "filesystem", rels: ["hang.test.js", "ok.test.js"], category: "git",
      testTimeoutMs: 5000, watch: { waveWatchdogMs: 1200 }, // 兜底先于 R1（两者都在 1-5s 注入区间）
    });
    assert.ok(w.results.every((r) => r.status === "crash" && r.crashReason === "watchdog_timeout"),
      "该波全部文件记 crash 且带 crashReason=watchdog_timeout（含早已完成的 ok.test.js——波级失能不偏袒）");
    assert.ok(w.groupError.includes("'filesystem'") && w.groupError.includes("watchdog backstop fired"), "groupError 含波名 + watchdog 标记");
    assert.ok(/ran \d+ms/.test(w.groupError), "groupError 含已耗时 ms");
    assert.ok(w.groupError.includes("cleanup confirmed"), "真实 taskkill /T /F + 探针证死 ⇒ 清理已确认");
    assert.ok(w.watchdog && w.watchdog.confirmed === true && w.watchdog.pid > 0 && w.watchdog.limitMs === 1200);
    assert.equal(w.abortSuite, false, "确认死透 ⇒ 不中止后续波");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("TD-165 T5: 清理未确认（killTreeFn 空操作 + probeAliveFn 恒活）⇒ 后续波不启动 + cleanup unconfirmed + verdict=fail + 隔离跳过", async () => {
  const root = synthWorkspace("wao-td165-t5-", { "hang.test.js": synthSlowOk(5000) }); // 活过兜底窗口但终会自退
  let isoCalls = 0;
  let out = null;
  try {
    out = await runCanonical({
      waveSpecs: [
        { name: "pure", concurrency: 2, categories: ["pure"], files: waveFiles(["hang.test.js"], "pure") },
        { name: "lock", concurrency: 1, categories: ["lock"], files: waveFiles(["never.test.js"], "lock") },
      ],
      reporterArg: SYNTH_REPORTER,
      // F4 修复轮：testTimeoutMs 显式注入（原来漏注入 ⇒ 用了生产 600s）；
      // watchdog 2000ms（1-5s 区间）先于 5s 慢测完成 ⇒ 兜底真实触发。
      testTimeoutMs: 5000,
      runChild: realRunChild(process.execPath, root, synthChildEnv(), {
        waveWatchdogMs: 2000, waveAlarmMs: 0,
        killTreeFn: async () => {},   // 空操作：杀不掉
        probeAliveFn: () => {},       // 恒活：探针证不出死
        sleepFn: async () => {},      // 探针间隔即时（不等 500ms）
      }),
      readReport: realReadReport(join(root, "test-results.json")),
      deleteReport: realDeleteReport(join(root, "test-results.json")),
      isolator: async () => { isoCalls += 1; return { status: "fail", exitCode: 1, tail: "" }; },
    });
    assert.equal(out.waves.length, 1, "第二个波（lock）绝不启动——不许带残留继续跑");
    assert.ok(out.waves[0].groupError.includes("cleanup unconfirmed"), "groupError 写明 cleanup unconfirmed");
    assert.equal(out.suiteAborted, true);
    assert.equal(out.abortOrigin, "wave", "F6：中止来源=波腿（后续波未启动）");
    assert.equal(out.suiteError, true);
    assert.equal(out.finalVerdict, "fail");
    assert.ok(out.waves[0].files.every((f) => f.status === "crash"));
    assert.equal(isoCalls, 0, "中止后隔离重跑也一并跳过（不再 spawn 任何子进程）");
    assert.ok(out.firstRound.failures.every((f) => f.crashReason === "watchdog_timeout"), "failures 条目带 crashReason 归因");
  } finally {
    // killTreeFn 被注入为空操作 ⇒ 残留是真的：用真实 taskkill 收尸，绝不泄漏。
    const pid = out?.waves?.[0]?.watchdog?.pid;
    if (pid) await defaultKillTree(pid);
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-165 T6: 隔离重跑再挂 ⇒ 兜底收杀重跑 + 分类不是 environment_invalid + 终判 fail", async () => {
  const root = synthWorkspace("wao-td165-t6-", { "hang.test.js": SYNTH_HANG_ASYNC, "ok.test.js": SYNTH_OK });
  try {
    const out = await runCanonical({
      waveSpecs: [{ name: "pure", concurrency: 2, categories: ["pure"], files: waveFiles(["hang.test.js", "ok.test.js"], "pure") }],
      reporterArg: SYNTH_REPORTER,
      testTimeoutMs: 1000, // 首轮：R1 收杀挂死文件（fail ⇒ 非 pass、指名）
      runChild: realRunChild(process.execPath, root, synthChildEnv(), { waveWatchdogMs: 5000, waveAlarmMs: 0 }),
      readReport: realReadReport(join(root, "test-results.json")),
      deleteReport: realDeleteReport(join(root, "test-results.json")),
      // 重跑：testTimeout 5s、兜底 1500ms 先杀（都在 1-5s 注入区间）—— 单独跑也挂死。
      isolator: realIsolator(process.execPath, root, synthChildEnv(), { testTimeoutMs: 5000, waveWatchdogMs: 1500, waveAlarmMs: 0 }),
    });
    assert.equal(out.finalVerdict, "fail");
    assert.equal(out.isolation.length, 1, "只有首轮非 pass 的 hang.test.js 进入重跑");
    const iso = out.isolation[0];
    assert.equal(iso.path, "hang.test.js");
    assert.equal(iso.isolationStatus, "crash");
    assert.equal(iso.crashReason, "watchdog_timeout", "重跑被兜底收杀的归因进报告");
    assert.equal(iso.classification, "stable_fail", "该文件单独跑也挂死 = 真测试挂死（R5 新语义）");
    assert.notEqual(iso.classification, "environment_invalid", "不得再归环境无效");
    // F6：隔离腿的 watchdog 记录透传进聚合报告（pid/confirmed 全字段，真路径实证）。
    assert.ok(iso.watchdog && iso.watchdog.fired === true && iso.watchdog.confirmed === true,
      "isolation 条目携带 watchdog（真实 taskkill + 探针证死 ⇒ confirmed）");
    assert.ok(iso.watchdog.pid > 0 && iso.watchdog.limitMs === 1500, "pid 与注入的 limitMs 原样在场");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("TD-165 T7: 慢波告警（注入小 alarmMs）⇒ stderr 出现 NOTICE 行，verdict 不受影响", async () => {
  // F4 修复轮：全部注入值收进 1-5s 区间——慢测 3s 完成于 5s 上限内、1s 告警先响
  // （约 3 行）、5s 兜底不触发。
  const root = synthWorkspace("wao-td165-t7-", { "slow.test.js": synthSlowOk(3000) });
  const lines = [];
  try {
    const w = await runSynthWave(root, {
      name: "mcp", rels: ["slow.test.js"], category: "mcp", concurrency: 1,
      testTimeoutMs: 5000, watch: { waveWatchdogMs: 5000, waveAlarmMs: 1000, logLine: (l) => lines.push(l) },
    });
    assert.ok(lines.length >= 1, "至少一条告警行（子进程墙钟 > alarmMs）");
    for (const line of lines) {
      assert.ok(/^\[canonical\] NOTICE: wave=mcp running for \d+s \(slow-wave alarm, informational\)$/.test(line),
        `告警行形状（纯读、带波名与秒数）：${line}`);
    }
    assert.equal(w.results[0].status, "pass", "告警绝不影响结果（纯读）");
    assert.equal(w.groupError, null);
    assert.ok(!w.watchdog, "告警不是兜底：绝不杀进程");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("TD-165 T8 (F3): 挂死文件含 1 个通过兄弟 + 注入小 per-test 超时 ⇒ 该文件非 pass 且指名（带原因），不只波级 groupError", async () => {
  const root = synthWorkspace("wao-td165-t8-", { "hangsib.test.js": SYNTH_HANG_SIB });
  try {
    const w = await runSynthWave(root, { rels: ["hangsib.test.js"], testTimeoutMs: 1000, watch: { waveWatchdogMs: 5000 } });
    const r = w.results[0];
    assert.equal(r.path, "hangsib.test.js");
    assert.notEqual(r.status, "pass", "挂死文件必须非 pass");
    assert.ok(r.status === "fail" || r.status === "missing",
      "必须归因到该文件而非仅波级 groupError（fail/missing 皆可——钉语义不钉实现）");
    // 修复的核心承诺：报告里该文件的 suite 非 pass 且带结构化原因（文件级失败
    // 事件 details.error，非 TAP 文本正则）；同文件的通过兄弟仍可见。
    const raw = JSON.parse(readFileSync(join(root, "test-results.json"), "utf8"));
    const suite = raw.suites.find((s) => s.name === "test/hangsib.test.js");
    assert.ok(suite, "报告中有该文件的 suite");
    assert.equal(suite.status, "fail", "suite 非 pass（修复前该形状误记 pass）");
    assert.ok(suite.fileFailure && /test timed out/.test(suite.fileFailure.message),
      `suite 带原因（fileFailure.message 含 "test timed out"，实际 ${JSON.stringify(suite.fileFailure?.message)}）`);
    const sib = suite.tests.find((t) => t.name === "passes fine");
    assert.ok(sib && sib.status === "pass", "同文件的通过兄弟条目仍可见");
    // 波级语义如常：失败已归因到文件 ⇒ "exit≠0 但报告全 pass" 的 groupError 不再
    // 触发（该规则本身未动）；该文件作为非 pass 进入后续隔离重跑资格。
    assert.equal(w.groupError, null, "归因到文件后不再只剩波级 groupError");
    assert.notEqual(w.exitCode, 0, "子进程自身仍非零退出（失败如实）");
    assert.ok(!w.abortSuite && !w.watchdog, "R1 主防线收尾：无兜底、无中止");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── TD-165 F2a：未确认清理路径上，适配器必须在 resolve 前释放子进程管道句柄 ────
// （否则存活子进程的 stdout/stderr 管道会让 runner 进程无法自然退出）。用
// spawnImpl 注入 fake child 断言 destroy/unref 被调用——与真实进程表解耦。
function fakeChild({ pid, withStdout = true }) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = withStdout ? new EventEmitter() : null;
  child.stderr = new EventEmitter();
  const calls = { stdoutDestroy: 0, stderrDestroy: 0, unref: 0 };
  if (child.stdout) child.stdout.destroy = () => { calls.stdoutDestroy += 1; };
  child.stderr.destroy = () => { calls.stderrDestroy += 1; };
  child.unref = () => { calls.unref += 1; };
  return { child, calls };
}

test("TD-165 F2a: 未确认清理 ⇒ 适配器 resolve 前销毁管道 + unref（波腿与隔离腿）；确认清理则不销毁", async () => {
  // fake child 没有真实进程句柄：生产里子进程句柄（管道/进程对象）会撑住事件循环，
  // 让 unref 的看门狗 timer 得以到期；fake 环境里循环会提前清空 ⇒ node:test 判
  // "pending promise + empty loop"。用一个 ref'd interval 模拟真实句柄的撑环效果
  // （finally 清理，绝不泄漏）。
  const withKeepAlive = async (fn) => {
    const keepAlive = setInterval(() => {}, 200);
    try { return await fn(); } finally { clearInterval(keepAlive); }
  };
  // 波腿·未确认：destroy/unref 在同一个同步块里先于 resolve 执行——await 返回后
  // 计数必为 1，即证明它们先于适配器 settle 发生。
  const wave = fakeChild({ pid: 424242 });
  const runChildUnconfirmed = realRunChild(process.execPath, "unused-root", {}, {
    waveWatchdogMs: 1000, waveAlarmMs: 0,
    killTreeFn: async () => {},  // 空操作
    probeAliveFn: () => {},      // 恒活 ⇒ 未确认
    sleepFn: async () => {},
  }, () => wave.child);
  const resWave = await withKeepAlive(() => runChildUnconfirmed(["--test"], { waveName: "pure" }));
  assert.equal(resWave.watchdog.fired, true);
  assert.equal(resWave.watchdog.confirmed, false, "探针恒活 ⇒ 未确认");
  assert.deepEqual(wave.calls, { stdoutDestroy: 1, stderrDestroy: 1, unref: 1 },
    "未确认路径：stdout.destroy + stderr.destroy + unref 各恰一次（resolve 前）");

  // 波腿·确认：探针证死 ⇒ 不销毁、不 unref（正常路径句柄交由 close 事件收尾）。
  const waveOk = fakeChild({ pid: 424243 });
  const esrch = () => { const e = new Error("kill ESRCH"); e.code = "ESRCH"; throw e; };
  const runChildConfirmed = realRunChild(process.execPath, "unused-root", {}, {
    waveWatchdogMs: 1000, waveAlarmMs: 0,
    killTreeFn: async () => {},
    probeAliveFn: esrch,
    sleepFn: async () => {},
  }, () => waveOk.child);
  const resOk = await withKeepAlive(() => runChildConfirmed(["--test"], { waveName: "pure" }));
  assert.equal(resOk.watchdog.confirmed, true, "探针证死 ⇒ 确认");
  assert.deepEqual(waveOk.calls, { stdoutDestroy: 0, stderrDestroy: 0, unref: 0 },
    "确认路径：不销毁不 unref（子进程已死，句柄自然关闭）");

  // 隔离腿·未确认：stdio ignore stdout ⇒ child.stdout 为 null，可选链必须兜住。
  const iso = fakeChild({ pid: 424244, withStdout: false });
  const isolator = realIsolator(process.execPath, "unused-root", {}, {
    testTimeoutMs: 5000, waveWatchdogMs: 1000, waveAlarmMs: 0,
    killTreeFn: async () => {},
    probeAliveFn: () => {},
    sleepFn: async () => {},
  }, () => iso.child);
  const resIso = await withKeepAlive(() => isolator({ file: "x.test.js" }));
  assert.equal(resIso.status, "crash");
  assert.equal(resIso.crashReason, "watchdog_timeout");
  assert.equal(resIso.watchdog.confirmed, false);
  assert.deepEqual(iso.calls, { stdoutDestroy: 0, stderrDestroy: 1, unref: 1 },
    "隔离腿未确认：stderr.destroy + unref 各一次；stdout=null 被可选链兜住（不炸）");
});

test("TD-165 killTree 有期限: killTreeFn 永不 resolve ⇒ 期限到放弃等待、照常进探针（看门狗自己不做无限等待）", async () => {
  let killCalled = 0;
  const supervisor = createChildSupervisor({
    label: "pure",
    waveWatchdogMs: 1000, waveAlarmMs: 0,
    killTreeFn: () => { killCalled += 1; return new Promise(() => {}); }, // 永不返回
    probeAliveFn: () => { const e = new Error("kill ESRCH"); e.code = "ESRCH"; throw e; }, // 证死
    sleepFn: async () => {},
    killTreeDeadlineMs: 1000,
    logLine: () => {},
  });
  supervisor.arm({ pid: 999999 });
  // 同 F2a：无真实子进程句柄撑环——keep-alive interval 让 unref 的 timer 到期。
  const keepAlive = setInterval(() => {}, 200);
  let wd;
  try {
    wd = await supervisor.watchdogOutcome; // 若无期限竞速，这里会永久挂住 ⇒ 测试超时红
  } finally { clearInterval(keepAlive); }
  assert.equal(killCalled, 1, "killTreeFn 确被调用");
  assert.equal(wd.fired, true);
  assert.equal(wd.confirmed, true, "放弃等待 kill 后探针照常裁决——死活从不依赖 kill 的返回值");
  assert.equal(wd.probes, 1);
  assert.ok(wd.elapsedMs < 5000, `有界完成（elapsedMs=${wd.elapsedMs} < 5000）`);
});

test("TD-165 F2b: suiteAborted ⇒ 报告落盘且全部打印之后 exitFn(非零) 有界退出；未中止则不强退", async () => {
  const manifest = { groups: { pure: ["a.test.js"], git: [], worktree: [], process: [], lock: [], timeout: [], mcp: [] } };
  const abortedOutcome = {
    waves: [],
    firstRound: { verdict: "fail", passed: 0, failed: 0, missing: 0, crashed: 1,
      failures: [{ path: "a.test.js", status: "crash", crashReason: "watchdog_timeout" }] },
    isolation: [], finalVerdict: "fail", suiteError: true,
    suiteAborted: true, abortOrigin: "wave",
  };
  const cleanOutcome = {
    waves: [],
    firstRound: { verdict: "pass", passed: 1, failed: 0, missing: 0, crashed: 0, failures: [] },
    isolation: [], finalVerdict: "pass", suiteError: false,
    suiteAborted: false, abortOrigin: null,
  };
  const drive = async (prefix, outcome) => {
    const root = synthWorkspace(prefix, { "a.test.js": SYNTH_OK, "manifest.json": JSON.stringify(manifest) });
    const exitCalls = [];
    try {
      await runSuite({
        repoRoot: root, testDir: join(root, "test"), manifestPath: join(root, "test", "manifest.json"),
        reportPath: join(root, "test-results.json"), nodeExe: process.execPath, childEnv: {},
        exitFn: (code) => {
          // 断言时机：exitFn 被调用时报告必须已在盘上且可解析（写盘先于强退）。
          const parsed = JSON.parse(readFileSync(join(root, "test-results.json"), "utf8"));
          exitCalls.push({ code, reportSeen: parsed.suiteAborted === outcome.suiteAborted && parsed.finalVerdict === outcome.finalVerdict });
        },
        runCanonicalImpl: async () => outcome,
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
    return exitCalls;
  };
  const aborted = await drive("wao-td165-f2b-a-", abortedOutcome);
  assert.equal(aborted.length, 1, "恰一次显式非零退出（有界，不赌自然退出）");
  assert.equal(aborted[0].code, 1, "非零（verdict=fail ⇒ 1）");
  assert.equal(aborted[0].reportSeen, true, "报告先于退出落盘且内容完整（bounded 报告不因强退丢失）");
  const clean = await drive("wao-td165-f2b-c-", cleanOutcome);
  assert.equal(clean.length, 0, "未中止 ⇒ 不强退（自然退出路径保持不变）");
});
