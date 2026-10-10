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
// short-lived `node --test` children (this file belongs to the process wave),
// only against mkdtemp tmpdir synthetic
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
  runsEntryAttribution, runsAttributionLine, RUNS_ATTRIBUTION_BYTE_CAP,
  finalRunnerOutcome,
  createInflightMarker, realInflightAdapter, inflightMarkerPath, INFLIGHT_MARKER_FILENAME,
  // TD-165：三层看门狗的常量与真实适配器（预算全部注入 1-5s 小值，绝不用生产默认值）。
  TEST_TIMEOUT_MS, WAVE_WATCHDOG_MS, WAVE_ALARM_MS, KILL_TREE_DEADLINE_MS,
  defaultKillTree, realRunChild, realIsolator, realReadReport, realDeleteReport,
  createChildSupervisor, runSuite,
  // TD-181 (a)：首轮失败内容保留（有界 + 截断标识 + 采集失败记 unknown）与次级观测。
  firstRoundFailureDetail, staleReportInfo, collectWaveObservation,
  boundDetailString, unknownFailureDetail,
  FAILURE_DETAIL_TEST_CAP, FAILURE_DETAIL_TEXT_CAP, FAILURE_DETAIL_CHAR_BUDGET,
  realWaveObservers, defaultCountNodeProcesses, parseTasklistSample,
  // TD-233：worker 上下文自知（横幅）与验证租约的 worktree runId 归因。
  workerBannerLine, runIdFromWorktreeCwd,
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
  assert.equal(fsWave.concurrency, 8, "filesystem wave concurrency is pinned to exactly 8 (current scheduling policy)");
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
  // It must NOT be pooled into the filesystem wave (which carries git/worktree at concurrency 8).
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

// Synthetic roots only; the real report/output adapters run, no suite is spawned.
async function attributionSuiteFixture(mutate) {
  const root = synthWorkspace("wao-td247-", {
    "a.test.js": SYNTH_OK,
    "manifest.json": JSON.stringify({ groups: { pure: ["a.test.js"], git: [], worktree: [], process: [], lock: [], timeout: [], mcp: [] } }),
  });
  const previousExitCode = process.exitCode;
  const originalLog = console.log;
  const originalError = console.error;
  const stdout = [];
  const stderr = [];
  console.log = (line) => stdout.push(String(line));
  console.error = (line) => stderr.push(String(line));
  try {
    const reportPath = join(root, "test-results.json");
    await runSuite({
      repoRoot: root, testDir: join(root, "test"), manifestPath: join(root, "test", "manifest.json"),
      reportPath, nodeExe: process.execPath, childEnv: {},
      exitFn: () => assert.fail("a completed fixture must not hard-exit"),
      runCanonicalImpl: async ({ onWaveEnd }) => {
        mutate(root);
        const wave = { name: "pure", exitCode: 0, passed: 1, failed: 0, crashed: 0, missing: 0, durationMs: 0 };
        onWaveEnd(wave);
        return {
          waves: [wave], firstRound: { verdict: "pass", passed: 1, failed: 0, missing: 0, crashed: 0, failures: [] },
          isolation: [], finalVerdict: "pass", suiteError: false, suiteAborted: false,
        };
      },
    });
    return { stdout, stderr, exitCode: process.exitCode, report: JSON.parse(readFileSync(reportPath, "utf8")) };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = previousExitCode;
    assert.ok(root.startsWith(tmpdir() + sep), "cleanup stays within the suite's isolated temp directory");
    rmSync(root, { recursive: true, force: true });
  }
}

const ATTRIBUTION_EVENT = {
  type: "run.started", runId: "run_x", cwd: "D:\\projects\\example",
  project: { bucket: "example-abc12345", key: "d:/projects/example" },
  agentId: "coder_test", ts: "2026-10-10T18:08:34.179Z",
};
const ATTRIBUTION_X = {
  entry: "run_x.jsonl", runId: "run_x", parseStatus: "parsed",
  cwd: ATTRIBUTION_EVENT.cwd, agentId: ATTRIBUTION_EVENT.agentId, ts: ATTRIBUTION_EVENT.ts,
  project: ATTRIBUTION_EVENT.project,
};

test("TD-247 ① happy: 首事件四字段落 stdout 与实际 JSON，测试全绿仍 RED/exit 1", async () => {
  const result = await attributionSuiteFixture((root) => {
    mkdirSync(join(root, "runs"));
    writeFileSync(join(root, "runs", "run_x.jsonl"), JSON.stringify(ATTRIBUTION_EVENT) + "\r\n" +
      JSON.stringify({ cwd: "later event must not win", agentId: "later_agent" }) + "\n");
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.finalVerdict, "pass", "the original test verdict stays green; the guard stays red");
  assert.deepEqual(result.report.runsDirGuard, {
    additions: [{ file: "run_x.jsonl", phase: "pure" }], error: null, attribution: [ATTRIBUTION_X],
  });
  assert.deepEqual(result.stdout, ['[canonical] 仍然 RED，以下是归属证据：' + JSON.stringify(ATTRIBUTION_X)]);
  assert.ok(result.stderr.some((line) => line.includes("runsGuard=RED(+1)")));
  assert.ok(result.stderr.includes("  - runs/run_x.jsonl (first seen: pure)"), "existing RED list is retained");
  console.log(result.stdout[0]);
  console.log("[TD-247 actual test-results.json] " + JSON.stringify(result.report.runsDirGuard.attribution[0]));
});

test("TD-247 ② 新建桶: 两个转录各一行，守卫原有单层新增列表不变", async () => {
  const result = await attributionSuiteFixture((root) => {
    const bucket = join(root, "runs", "projects", "foo-abc12345");
    mkdirSync(bucket, { recursive: true });
    writeFileSync(join(bucket, "run_b.jsonl"), JSON.stringify({ agentId: "b", project: { displayName: "Foo" } }) + "\n");
    writeFileSync(join(bucket, "run_a.jsonl"), JSON.stringify({ cwd: "D:/foo", ts: ATTRIBUTION_EVENT.ts }) + "\n");
    writeFileSync(join(bucket, "notes.txt"), "not a transcript");
    mkdirSync(join(bucket, "run_directory.jsonl"));
  });
  const attribution = [
    { entry: "projects", parseStatus: "unattributable" },
    { entry: "projects/foo-abc12345", runId: "run_a", parseStatus: "parsed", cwd: "D:/foo", ts: ATTRIBUTION_EVENT.ts },
    { entry: "projects/foo-abc12345", runId: "run_b", parseStatus: "parsed", agentId: "b", project: { displayName: "Foo" } },
  ];
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.report.runsDirGuard.additions, [
    { file: "projects", phase: "pure" }, { file: "projects/foo-abc12345", phase: "pure" },
  ], "TD-249 scan-depth change is explicitly excluded");
  assert.deepEqual(result.report.runsDirGuard.attribution, attribution);
  assert.deepEqual(result.stdout, attribution.map(runsAttributionLine));
  assert.equal(result.stdout.filter((line) => line.includes('"runId"')).length, 2);
});

test("TD-247 ③ 坏首行/非法 UTF-8/8KB 截断/读取失败: unknown，RED 与退出码不变", async () => {
  const result = await attributionSuiteFixture((root) => {
    const runs = join(root, "runs");
    mkdirSync(runs);
    writeFileSync(join(runs, "run_garbage.jsonl"), "garbage\n" + JSON.stringify(ATTRIBUTION_EVENT));
    writeFileSync(join(runs, "run_utf8.jsonl"), Buffer.from([123, 34, 99, 119, 100, 34, 58, 34, 255, 34, 125, 10]));
    writeFileSync(join(runs, "run_large.jsonl"), JSON.stringify({ cwd: "中".repeat(3000) }) + "\n");
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.report.runsDirGuard.attribution, [
    { entry: "run_garbage.jsonl", runId: "run_garbage", parseStatus: "unknown" },
    { entry: "run_large.jsonl", runId: "run_large", parseStatus: "unknown" },
    { entry: "run_utf8.jsonl", runId: "run_utf8", parseStatus: "unknown" },
  ]);
  assert.deepEqual(result.stdout, result.report.runsDirGuard.attribution.map(runsAttributionLine));
  assert.ok(result.stderr.some((line) => line.includes("runsGuard=RED(+3)")));
  const dir = mkdtempSync(join(tmpdir(), "wao-td247-read-"));
  try {
    assert.deepEqual(runsEntryAttribution(dir, "run_vanished.jsonl"), [
      { entry: "run_vanished.jsonl", runId: "run_vanished", parseStatus: "unknown" },
    ]);
    assert.deepEqual(runsEntryAttribution(dir, "projects/vanished/"), [{ entry: "projects/vanished/", parseStatus: "unknown" }]);
    assert.equal(RUNS_ATTRIBUTION_BYTE_CAP, 8192, "byte budget, not a character budget");
    const atCap = JSON.stringify({ cwd: "x".repeat(8181) }) + "\n";
    assert.equal(Buffer.byteLength(atCap), 8192);
    writeFileSync(join(dir, "run_cap.jsonl"), atCap + "invalid later data".repeat(10000));
    assert.equal(runsEntryAttribution(dir, "run_cap.jsonl")[0].cwd, "x".repeat(8181), "complete first line at byte cap parses");
    writeFileSync(join(dir, "run_cap.jsonl"), JSON.stringify({ cwd: "x".repeat(8182) }) + "\n");
    assert.deepEqual(runsEntryAttribution(dir, "run_cap.jsonl"), [{ entry: "run_cap.jsonl", runId: "run_cap", parseStatus: "unknown" }]);
    for (const text of ["", "null\n", "[]\n", "42\n"]) {
      writeFileSync(join(dir, "run_cap.jsonl"), text);
      assert.equal(runsEntryAttribution(dir, "run_cap.jsonl")[0].parseStatus, "unknown");
    }
  } finally {
    assert.ok(dir.startsWith(tmpdir() + sep));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-247 ④ 无法归属形态: 如实标注，不伪造 runId 或事实字段", async () => {
  const result = await attributionSuiteFixture((root) => {
    mkdirSync(join(root, "runs", ".session-reuse-x"), { recursive: true });
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.report.runsDirGuard.attribution, [{ entry: ".session-reuse-x", parseStatus: "unattributable" }]);
  assert.deepEqual(result.stdout, ['[canonical] 仍然 RED，以下是归属证据：无法归属（形态：".session-reuse-x"）']);
});

test("TD-247 ⑤ 措辞钉: 成功/unknown/无法归属均逐字声明仍然 RED，控制字符不造第二行", () => {
  for (const evidence of [ATTRIBUTION_X, { entry: "run_x.jsonl", parseStatus: "unknown" },
    { entry: ".session-reuse-x", parseStatus: "unattributable" },
    { entry: "run_x.jsonl", cwd: "a\nb\r\u001b", parseStatus: "parsed" }]) {
    const line = runsAttributionLine(evidence);
    assert.ok(line.startsWith("[canonical] 仍然 RED，以下是归属证据："));
    assert.ok(!/[\r\n\u001b]/.test(line), "one physical evidence line");
  }
});

test("TD-247 ⑥ 归属不参与退出判定: clean 不输出，映射/失败/无法归属均同原判定", async () => {
  const clean = await attributionSuiteFixture(() => {});
  assert.equal(clean.exitCode, 0);
  assert.deepEqual(clean.stdout, []);
  assert.deepEqual(clean.report.runsDirGuard, { additions: [], error: null, attribution: [] });
  const cases = [
    (root) => { mkdirSync(join(root, "runs")); writeFileSync(join(root, "runs", "run_x.jsonl"), JSON.stringify(ATTRIBUTION_EVENT)); },
    (root) => { mkdirSync(join(root, "runs")); writeFileSync(join(root, "runs", "run_x.jsonl"), "broken"); },
    (root) => { mkdirSync(join(root, "runs", ".session-reuse-x"), { recursive: true }); },
    (root) => { writeFileSync(join(root, "runs"), "not a directory"); },
  ];
  for (const mutate of cases) {
    const result = await attributionSuiteFixture(mutate);
    const originalDecision = finalRunnerOutcome({
      verdict: result.report.finalVerdict,
      runsAdditions: result.report.runsDirGuard.additions,
      runsGuardError: result.report.runsDirGuard.error,
    });
    assert.equal(result.exitCode, 1, "all original guard RED shapes still fail");
    assert.equal(result.exitCode, originalDecision.exitCode, "annotations cannot change the original pure exit decision");
  }
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
  // TD-229（2026-10-07）：MCP 认证门禁钉 "0"——套件契约=确定性，宿主 User env
  // setx 的部署级开关不得漏进测试子进程（16 文件 stable_fail 实证）。
  assert.equal(bare.WAO_MCP_REQUIRE_CERTIFIED, "0", "认证门禁对套件子进程强制关闭");
  const gateLeaked = buildCanonicalChildEnv(
    { WAO_MCP_REQUIRE_CERTIFIED: "1" }, { gateHeld: false },
  );
  assert.equal(gateLeaked.WAO_MCP_REQUIRE_CERTIFIED, "0", "宿主漏入的门禁值被压回 0（不被部署 env 翻转）");

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
// TD-181（2026-09-27 证明结构修正）："兄弟条目保留可见"与"无兄弟完成时不
// 伪造条目/summary 计数"由 test/isolation-infra/reporter.test.js 以确定性
// 事件序列证明（前提闭合：先喂兄弟通过 complete，再按 Node 真实顺序喂文件级
// failed-complete + fail 两份通知）；文件级超时计时先于子文件完成开始，兄弟
// 完成事件与文件级失败事件的相对顺序未证实（main b119 自然失败），T8 因此
// 不再附带通过兄弟夹具、不再依赖该时序前提。
// ────────────────────────────────────────────────────────────────────────────

test("TD-165 budgets: 生产默认值钉死（1200s per-test / 1800s 波级兜底 / 900s 告警；兜底必须大于 per-test 上限）", () => {
  // TD-173（2026-09-21）重推导：旧基准（最慢文件 133s / 波峰 207s ⇒ 600s 余量 3-4.5x）
  // 已被现测推翻——同一文件单跑 253s、波内 ~598s，filesystem 波 70 文件 @16 容量地板
  // 474s、墙钟 606s；旧 600s 上限因此**误杀波尾的合法慢测试**（全部 isolation_pass），
  // 与该常量自述的保护意图冲突。新值 = 波内峰值 ~2x / 单跑峰值 ~4.7x。
  assert.equal(TEST_TIMEOUT_MS, 1200000, "R1：1200s（2026-09-21 重推导，TD-173：波内峰值 606s ≈ 旧 600s 上限）");
  assert.equal(WAVE_WATCHDOG_MS, 1800000, "R2：1800s（1.5× per-test 上限，严格大于 R1 + 排队余量）");
  assert.equal(WAVE_ALARM_MS, 900000, "R3：900s 信息告警（须高于健康波 ~606s、低于兜底）");
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

// Test our adapter's deadline ordering with a controlled clock. Node's own
// per-file timer is exercised by T1/T2/T8; it is not reimplemented here.
test("TD-165 T3: close before watchdog deadline cancels the kill, even after time advances", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { child } = fakeChild({ pid: 424240 });
  const kills = [];
  const runChild = realRunChild(process.execPath, "unused-root", {}, {
    waveWatchdogMs: 2000, waveAlarmMs: 0,
    killTreeFn: async (pid) => { kills.push(pid); },
  }, () => child);
  const pending = runChild(["--test"], { waveName: "process" });
  t.mock.timers.tick(1999);
  assert.deepEqual(kills, []);
  child.emit("close", 0);
  const result = await pending;
  t.mock.timers.tick(10000);
  assert.equal(result.exitCode, 0);
  assert.ok(!result.watchdog, "completed child must not become a timeout");
  assert.deepEqual(kills, [], "close must disarm the watchdog");
});

test("TD-165 T3 deadline: live child is killed at the deadline and a late close cannot erase timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { child } = fakeChild({ pid: 424241 });
  const kills = [];
  const runChild = realRunChild(process.execPath, "unused-root", {}, {
    waveWatchdogMs: 2000, waveAlarmMs: 0,
    killTreeFn: async (pid) => { kills.push(pid); },
    probeAliveFn: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
  }, () => child);
  const pending = runChild(["--test"], { waveName: "process" });
  t.mock.timers.tick(1999);
  assert.deepEqual(kills, []);
  t.mock.timers.tick(1);
  child.emit("close", 0);
  const result = await pending;
  assert.deepEqual(kills, [child.pid]);
  assert.equal(result.watchdog.fired, true);
  assert.equal(result.watchdog.confirmed, true);
  assert.equal(result.watchdog.elapsedMs, 2000);
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

test("TD-165 T7: slow-wave notices are informational and stop after child close", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  const { child } = fakeChild({ pid: 424247 });
  const lines = [];
  const kills = [];
  const runChild = realRunChild(process.execPath, "unused-root", {}, {
    waveWatchdogMs: 5000, waveAlarmMs: 1000,
    logLine: (line) => lines.push(line),
    killTreeFn: async (pid) => { kills.push(pid); },
  }, () => child);
  const pending = runChild(["--test"], { waveName: "mcp" });
  t.mock.timers.tick(1000);
  assert.deepEqual(lines, ["[canonical] NOTICE: wave=mcp running for 1s (slow-wave alarm, informational)"]);
  child.emit("close", 0);
  const result = await pending;
  t.mock.timers.tick(10000);
  assert.equal(lines.length, 1, "close must cancel subsequent notices");
  assert.deepEqual(kills, [], "notice must never kill a child");
  assert.equal(result.exitCode, 0);
  assert.ok(!result.watchdog);
});

test("TD-165 T8 (F3): 真实 Node22 子进程文件级超时 ⇒ 该文件非 pass 且带结构化 timeout 原因、非零退出、无伪 wave-only groupError、无 watchdog 中止", async () => {
  const root = synthWorkspace("wao-td165-t8-", { "hang.test.js": SYNTH_HANG_ASYNC });
  try {
    const w = await runSynthWave(root, { rels: ["hang.test.js"], testTimeoutMs: 1000, watch: { waveWatchdogMs: 5000 } });
    const r = w.results[0];
    assert.equal(r.path, "hang.test.js");
    assert.notEqual(r.status, "pass", "挂死文件必须非 pass");
    assert.ok(r.status === "fail" || r.status === "missing",
      "必须归因到该文件而非仅波级 groupError（fail/missing 皆可——钉语义不钉实现）");
    // 修复的核心承诺：报告里该文件的 suite 非 pass 且带结构化原因（文件级失败
    // 事件 details.error，非 TAP 文本正则）。
    //
    // TD-181（2026-09-27 证明结构修正）：本用例不再附带"通过兄弟"夹具——Node 的
    // 文件级超时计时先于子文件完成开始，兄弟完成事件与文件级失败事件的相对顺序
    // 未被证实（main b119 自然失败即兄弟记录缺失）。兄弟记录保留、以及无兄弟完成
    // 时不伪造条目/summary 计数，已在 test/isolation-infra/reporter.test.js 以
    // 确定性事件序列（真实 write/end/读盘）证明；本测试只钉真实子进程超时通路。
    const raw = JSON.parse(readFileSync(join(root, "test-results.json"), "utf8"));
    const suite = raw.suites.find((s) => s.name === "test/hang.test.js");
    assert.ok(suite, "报告中有该文件的 suite");
    assert.equal(suite.status, "fail", "suite 非 pass（修复前该形状误记 pass）");
    assert.ok(suite.fileFailure && /test timed out/.test(suite.fileFailure.message),
      `suite 带原因（fileFailure.message 含 "test timed out"，实际 ${JSON.stringify(suite.fileFailure?.message)}）`);
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

// ────────────────────────────────────────────────────────────────────────────
// TD-181 (a, 2026-09-25)：canonical 报告保留**首轮**失败内容（有界 + 明确截断标识
// + 采集失败如实记 unknown，绝不因观测失败制造绿）。覆盖五种形态：
//   缺报告 / 坏报告 / 采集错误 / 截断 / 旧报告残留；
// 外加「波内失败 + 隔离通过」仍保留原失败内容且终判仍 fail，以及次级观测
// （附注，不改判定，不挤占首轮失败内容）。全部走注入 seam，零真实子进程。
// ────────────────────────────────────────────────────────────────────────────

// 带失败内容的波报告夹具：reporter 形状（suite.tests[].error = {actual,expected,
// operator,stack,diff}；suite.fileFailure = {message,stack}）。
function makeRichReport(rel, { failingTests = [], fileFailure = null, timestamp } = {}) {
  return {
    ...(timestamp ? { timestamp } : {}),
    suites: [{
      name: "test/" + rel, status: failingTests.length > 0 || fileFailure ? "fail" : "pass", duration: 42,
      tests: failingTests,
      ...(fileFailure ? { fileFailure } : {}),
    }],
  };
}

test("TD-181(a): 波内失败 + 隔离通过 ⇒ firstRound.failures 保留原失败内容（子测试名/断言/堆栈）且 finalVerdict 仍为 fail", async () => {
  const report = makeRichReport("flake.test.js", {
    failingTests: [
      { name: "subtest A", status: "fail", duration: 5, error: {
        actual: "1", expected: "2", operator: "equal",
        stack: "AssertionError [ERR_ASSERTION]: should be equal\n    at flake.test.js:10:5",
        diff: "- Expected: 2\n+ Received: 1" } },
      { name: "subtest B", status: "pass", duration: 3 },
      { name: "subtest C", status: "fail", duration: 2, error: { actual: "x", expected: "y", operator: "equal", stack: "AssertionError: x !== y", diff: null } },
    ],
  });
  // 次级观测同时在场（rich observers）——证明附注不挤占首轮失败内容。
  const observers = {
    verificationGate: async () => ({ state: "held", holder: { owner: "verifyDelivery", pid: 4242, startedAt: "2026-09-25T00:00:00.000Z" } }),
    concurrentFullSuite: async () => ({ state: "present", pid: 99, startedAt: "2026-09-25T00:01:00.000Z" }),
    nodeProcessCount: async () => ({ count: 7, sampledAt: "2026-09-25T00:02:00.000Z" }),
  };
  const out = await runCanonical({
    waveSpecs: [{ name: "pure", concurrency: 8, categories: ["pure"], files: waveFiles(["flake.test.js"], "pure") }],
    reporterArg: "R",
    runChild: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    readReport: async () => report,
    deleteReport: noopDelete,
    isolator: async () => ({ status: "pass", exitCode: 0, tail: "alone-pass" }),
    observers,
  });
  assert.equal(out.firstRound.verdict, "fail");
  assert.equal(out.finalVerdict, "fail", "隔离通过绝不洗绿（既有钉不变）");
  assert.equal(out.isolation.length, 1);
  assert.equal(out.isolation[0].classification, "isolation_pass");

  const f = out.firstRound.failures[0];
  assert.equal(f.path, "flake.test.js");
  assert.equal(f.status, "fail");
  assert.equal(f.failureDetail.status, "collected", "首轮失败内容已采集");
  assert.equal(f.failureDetail.source, "firstRoundWaveReport");
  assert.equal(f.failureDetail.failingTestsTotal, 2);
  assert.equal(f.failureDetail.failingTests.length, 2, "两个失败子测试都保留（通过的兄弟不进清单）");
  const a = f.failureDetail.failingTests[0];
  assert.equal(a.name, "subtest A");
  assert.equal(a.expected, "2");
  assert.equal(a.actual, "1");
  assert.equal(a.operator, "equal");
  assert.ok(a.stack.includes("at flake.test.js:10:5"), "堆栈原文保留");
  assert.ok(a.diff.includes("+ Received: 1"), "断言 diff 保留");
  assert.equal(f.failureDetail.failingTests[1].name, "subtest C");

  // 附注在场且不挤占：failureDetail 完整的同时 observation 独立成字段。
  const obs = out.waves[0].observation;
  assert.equal(obs.verificationGate.state, "held");
  assert.equal(obs.concurrentFullSuite.state, "present");
  assert.equal(obs.nodeProcessCount.count, 7);
  assert.equal(obs.waveConcurrency, 8);
  assert.equal(obs.advisory, true);
  assert.ok(!Number.isNaN(Date.parse(obs.startedAt)), "波开始时间为可解析 ISO 时间");
  assert.ok(!("failureDetail" in out.waves[0].files[0]), "首轮失败内容只落在 firstRound.failures，不重复进 waves[].files");
});

test("TD-181(a) 形态① 缺报告 ⇒ 全 crash + failureDetail 如实 unknown（记报告缺失）", async () => {
  const files = waveFiles(["a.test.js"], "pure");
  const w = await runWave({
    name: "pure", files, concurrency: 2, reporterArg: "R",
    runChild: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readReport: async () => null, // reporter never flushed
    deleteReport: noopDelete,
  });
  assert.ok(w.groupError, "missing report is a wave error（既有钉）");
  assert.ok(w.results.every((r) => r.status === "crash"));
  for (const r of w.results) {
    assert.equal(r.failureDetail.status, "unknown", "观测失败 ⇒ unknown，不编造内容");
    assert.ok(/missing|not an object/.test(r.failureDetail.reason), `reason 指明缺报告（实际 ${r.failureDetail.reason}）`);
  }
  const out = await runCanonical({
    waveSpecs: [{ name: "pure", concurrency: 2, categories: ["pure"], files }],
    reporterArg: "R", runChild: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readReport: async () => null, deleteReport: noopDelete,
  });
  assert.equal(out.finalVerdict, "fail", "缺报告绝不判绿");
  assert.equal(out.firstRound.failures[0].failureDetail.status, "unknown");
});

test("TD-181(a) 形态② 坏报告（无法识别的 suite status）⇒ invalid + failureDetail unknown（带 reportError 原文）", async () => {
  const files = waveFiles(["a.test.js"], "pure");
  const w = await runWave({
    name: "pure", files, concurrency: 2, reporterArg: "R",
    runChild: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readReport: async () => ({ suites: [{ name: "test/a.test.js", status: "todo", tests: [] }] }),
    deleteReport: noopDelete,
  });
  assert.ok(w.groupError && /unrecognized status/.test(w.groupError));
  assert.equal(w.results[0].status, "crash");
  assert.equal(w.results[0].failureDetail.status, "unknown");
  assert.ok(/unrecognized status/.test(w.results[0].failureDetail.reason), "unknown 的 reason 透传 reportError");
});

test("TD-181(a) 形态③ 采集错误（readReport 抛错）⇒ 波 fail-closed（全 crash + groupError）+ failureDetail unknown；后续波照常", async () => {
  const specs = [
    { name: "pure", concurrency: 2, categories: ["pure"], files: waveFiles(["a.test.js"], "pure") },
    { name: "lock", concurrency: 1, categories: ["lock"], files: waveFiles(["c.test.js"], "lock") },
  ];
  let call = 0;
  const readReport = async () => {
    call += 1;
    if (call === 1) throw new Error("EACCES report read blocked"); // 只有 pure 波采集失败
    return makeReport(["c.test.js"], new Set());
  };
  const out = await runCanonical({
    waveSpecs: specs, reporterArg: "R",
    runChild: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readReport,
    deleteReport: noopDelete,
  });
  const pure = out.waves.find((x) => x.name === "pure");
  assert.ok(/read report failed: EACCES report read blocked/.test(pure.groupError), "采集错误如实入 groupError");
  assert.ok(pure.files.every((f) => f.status === "crash"), "采集失败 ⇒ 全 crash（绝不因观测失败制造绿）");
  const f = out.firstRound.failures.find((x) => x.path === "a.test.js");
  assert.equal(f.failureDetail.status, "unknown");
  assert.ok(/read report failed/.test(f.failureDetail.reason));
  assert.equal(out.finalVerdict, "fail");
  const lock = out.waves.find((x) => x.name === "lock");
  assert.equal(lock.files[0].status, "pass", "后续波不受采集错误连坐（与 delete 失败同语义）");
});

test("TD-181(a) 形态④ 截断 ⇒ 超长子测试计数丢弃、超长字段带明确 TRUNCATED 标识", async () => {
  const longStack = "E".repeat(5000);
  const longExpected = "2".repeat(3000);
  const failingTests = [
    { name: "big one", status: "fail", duration: 5, error: { actual: "1", expected: longExpected, operator: "equal", stack: longStack, diff: "- x" } },
    ...Array.from({ length: 7 }, (_, i) => ({ name: `t${i}`, status: "fail", duration: 1 })),
  ];
  const w = await runWave({
    name: "pure", files: waveFiles(["a.test.js"], "pure"), concurrency: 2, reporterArg: "R",
    runChild: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    readReport: async () => makeRichReport("a.test.js", { failingTests }),
    deleteReport: noopDelete,
  });
  const d = w.results[0].failureDetail;
  assert.equal(d.status, "collected");
  assert.equal(d.failingTestsTotal, 8, "失败子测试总数如实记录");
  assert.equal(d.failingTests.length, FAILURE_DETAIL_TEST_CAP, `最多保留 ${FAILURE_DETAIL_TEST_CAP} 条`);
  assert.equal(d.failingTestsDropped, 3, "丢弃数明确记录");
  const big = d.failingTests[0];
  assert.ok(big.stack.endsWith(`…[TRUNCATED: first ${FAILURE_DETAIL_TEXT_CAP} of 5000 chars]`), "堆栈截断带明确标识与原始长度");
  assert.ok(big.expected.endsWith(`…[TRUNCATED: first ${FAILURE_DETAIL_TEXT_CAP} of 3000 chars]`), "expected 截断带明确标识");
});

test("TD-181(a) 形态④b 每文件字符预算 ⇒ 序列化后不超 FAILURE_DETAIL_CHAR_BUDGET（丢弃计入 dropped）", async () => {
  const bigField = (c) => "z".repeat(c);
  const failingTests = Array.from({ length: 8 }, (_, i) => ({
    name: `t${i}`, status: "fail", duration: 1,
    error: { actual: bigField(1200), expected: bigField(1200), operator: "equal", stack: bigField(1200), diff: bigField(1200) },
  }));
  const out = await runCanonical({
    waveSpecs: [{ name: "pure", concurrency: 2, categories: ["pure"], files: waveFiles(["a.test.js"], "pure") }],
    reporterArg: "R",
    runChild: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    readReport: async () => makeRichReport("a.test.js", { failingTests }),
    deleteReport: noopDelete,
  });
  const d = out.firstRound.failures[0].failureDetail;
  assert.equal(d.failingTestsTotal, 8);
  assert.ok(d.failingTests.length >= 1, "至少保留一条（截断不归零）");
  assert.ok(JSON.stringify(d).length <= FAILURE_DETAIL_CHAR_BUDGET,
    `序列化长度 ${JSON.stringify(d).length} ≤ 预算 ${FAILURE_DETAIL_CHAR_BUDGET}`);
  assert.equal(d.failingTestsTotal - d.failingTests.length, d.failingTestsDropped, "丢弃数 = 总数 - 保留数");
});

test("TD-181(a) 形态⑤ 旧报告残留 ⇒ 时间戳早于波开始 ⇒ 不读作本波结果（即便 suites 全 pass），全 crash + unknown；新鲜时间戳不受误伤", async () => {
  const files = waveFiles(["a.test.js"], "pure");
  const staleReport = {
    timestamp: new Date(Date.now() - 60000).toISOString(), // 波开始前一分钟落盘的残留
    suites: [{ name: "test/a.test.js", status: "pass", duration: 5, tests: [] }],
  };
  const stale = await runWave({
    name: "pure", files, concurrency: 2, reporterArg: "R",
    runChild: async () => ({ exitCode: 1, stdout: "", stderr: "" }), // 子进程其实崩了，没写报告
    readReport: async () => staleReport,
    deleteReport: async () => {}, // noop delete：残留报告可被读到
  });
  assert.ok(/stale report residue/.test(stale.groupError), "groupError 指明残留");
  assert.ok(stale.results.every((r) => r.status === "crash"), "残留内容绝不读作本波结果（含 pass）");
  assert.equal(stale.results[0].failureDetail.status, "unknown");
  assert.ok(/stale report residue/.test(stale.results[0].failureDetail.reason));

  // 对照：新鲜时间戳（波开始之后）照常映射，不误伤。
  const fresh = await runWave({
    name: "pure", files, concurrency: 2, reporterArg: "R",
    runChild: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readReport: async () => ({ timestamp: new Date().toISOString(), suites: [{ name: "test/a.test.js", status: "pass", duration: 5, tests: [] }] }),
    deleteReport: noopDelete,
  });
  assert.equal(fresh.results[0].status, "pass");
  assert.equal(fresh.groupError, null);

  // 纯函数钉：无时间戳 / 不可解析 / 未来时间 ⇒ 不判残留。
  assert.equal(staleReportInfo(null, 0).stale, false);
  assert.equal(staleReportInfo({ suites: [] }, 0).stale, false, "无 timestamp 的报告维持既有校验语义");
  assert.equal(staleReportInfo({ timestamp: "not-a-date" }, 0).stale, false);
  assert.equal(staleReportInfo({ timestamp: new Date(Date.now() + 60000).toISOString() }, Date.now()).stale, false);
});

test("TD-181(a): watchdog 波腿 crash ⇒ failureDetail 如实 unknown（带 watchdog_timeout 原因）", async () => {
  const w = await runWave({
    name: "lock", files: waveFiles(["a.test.js"], "lock"), concurrency: 1, reporterArg: "R",
    runChild: async () => ({ exitCode: null, stdout: "", stderr: "", watchdog: { fired: true, confirmed: true, elapsedMs: 321, probes: 1, pid: 4242, limitMs: 5000 } }),
    readReport: async () => { throw new Error("must not be called"); },
    deleteReport: noopDelete,
  });
  assert.ok(w.results.every((r) => r.status === "crash" && r.crashReason === "watchdog_timeout"));
  for (const r of w.results) {
    assert.equal(r.failureDetail.status, "unknown");
    assert.ok(/watchdog_timeout/.test(r.failureDetail.reason));
  }
});

test("TD-181(a) 次级观测：采集失败/未接线 ⇒ 各自 unknown；观测绝不影响 verdict（含全绿波）", async () => {
  const specs = [{ name: "pure", concurrency: 8, categories: ["pure"], files: waveFiles(["ok.test.js"], "pure") }];
  const readReport = async () => makeReport(["ok.test.js"], new Set(), { "ok.test.js": 45 });
  const runChild = async () => ({ exitCode: 0, stdout: "", stderr: "" });

  // 全部观察器抛错 ⇒ unknown 带 reason，verdict 仍 pass。
  const boom = async () => { throw new Error("observer blew up"); };
  const outThrow = await runCanonical({
    waveSpecs: specs, reporterArg: "R", runChild, readReport, deleteReport: noopDelete,
    observers: { verificationGate: boom, concurrentFullSuite: boom, nodeProcessCount: async () => { throw new Error("count failed"); } },
  });
  const obsT = outThrow.waves[0].observation;
  assert.ok(/observer failed: observer blew up/.test(obsT.verificationGate.reason));
  assert.ok(/observer failed/.test(obsT.concurrentFullSuite.reason));
  assert.equal(obsT.nodeProcessCount.count, null, "计数失败 ⇒ count=null（不编造 0）");
  assert.ok(/observer failed: count failed/.test(obsT.nodeProcessCount.reason));
  assert.equal(outThrow.finalVerdict, "pass", "次级观测失败绝不改变判定");

  // 未接线（observers=null，元测试缺省）⇒ unknown + not provided。
  const outBare = await runCanonical({ waveSpecs: specs, reporterArg: "R", runChild, readReport, deleteReport: noopDelete });
  const obsB = outBare.waves[0].observation;
  assert.ok(/not provided/.test(obsB.verificationGate.reason));
  assert.ok(/not provided/.test(obsB.concurrentFullSuite.reason));
  assert.ok(/not provided/.test(obsB.nodeProcessCount.reason));
  assert.equal(obsB.nodeProcessCount.count, null);
  assert.equal(obsB.waveConcurrency, 8);
  assert.equal(obsB.advisory, true);

  // 观察器返回无 count 的对象 ⇒ count=null + reason（不把 undefined 折成 0）。
  const outNoCount = await runCanonical({
    waveSpecs: specs, reporterArg: "R", runChild, readReport, deleteReport: noopDelete,
    observers: { nodeProcessCount: async () => ({ reason: "sample unsupported" }) },
  });
  assert.equal(outNoCount.waves[0].observation.nodeProcessCount.count, null);
  assert.ok(/sample unsupported/.test(outNoCount.waves[0].observation.nodeProcessCount.reason));
});

test("TD-181(a) 真实观测适配器（注入 fs/gate/count seam，零真实进程表）：marker 三态 + gate status 三态 + tasklist 计数/超时", async () => {
  // marker：none / present（可解析）/ present（撕裂）。
  let markerText = null;
  const markerReader = { readMarker: () => {
    if (markerText === null) return null;
    return markerText;
  } };
  const obs = realWaveObservers({
    createGate: () => ({ status: async () => ({ free: true }) }),
    markerReader,
    countNodeProcesses: async () => ({ count: 2, sampledAt: "2026-09-25T03:00:00.000Z" }),
  });
  assert.equal((await obs.verificationGate()).state, "free");
  assert.equal(obs.concurrentFullSuite().state, "none");
  assert.deepEqual(await obs.nodeProcessCount(), { count: 2, sampledAt: "2026-09-25T03:00:00.000Z" });

  markerText = JSON.stringify({ pid: 4242, startedAt: "2026-09-25T02:00:00.000Z" }) + "\n";
  assert.deepEqual(obs.concurrentFullSuite(), { state: "present", pid: 4242, startedAt: "2026-09-25T02:00:00.000Z" });
  markerText = "{torn";
  const torn = obs.concurrentFullSuite();
  assert.equal(torn.state, "present", "撕裂标记仍是 present（标记存在这一事实独立于可解析性）");
  assert.equal(torn.pid, "unknown");

  // gate：held / corrupt。
  const held = realWaveObservers({
    createGate: () => ({ status: async () => ({ free: false, holder: { owner: "verifyDelivery", pid: 1, startedAt: 100, heartbeatAt: 100, ageMs: 0 } }) }),
    markerReader: { readMarker: () => null },
    countNodeProcesses: async () => ({ count: 0, sampledAt: "t" }),
  });
  const hs = await held.verificationGate();
  assert.equal(hs.state, "held");
  assert.equal(hs.holder.owner, "verifyDelivery");
  const corrupt = realWaveObservers({
    createGate: () => ({ status: async () => ({ free: false, corrupt: true, holder: null }) }),
    markerReader: { readMarker: () => null },
    countNodeProcesses: async () => ({ count: 0, sampledAt: "t" }),
  });
  assert.equal((await corrupt.verificationGate()).state, "corrupt");

  // tasklist 计数：fake spawnImpl 解析完整形状 CSV 行（TD-181(b) 第二轮起行形状
  // 严格化——合法行+未加引号 notice/垃圾残留 ⇒ unknown，因此计数夹具只含合法行；
  // notice 残留形状在「TD-181(b) ③」测试中钉为 unknown）；不返回的 child ⇒ 超时记 unknown。
  const csv = '"node.exe","111","Console","1","1,234 K"\r\n"node.exe","222","Console","1","2,345 K"\r\n';
  const fakeSpawnOk = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit("data", csv); child.emit("close", 0); });
    return child;
  };
  const counted = await defaultCountNodeProcesses({ timeoutMs: 2000, spawnImpl: fakeSpawnOk });
  assert.equal(counted.count, 2, 'CSV 行按完整行形状（"node.exe" + 引号字段）计数');
  assert.ok(!Number.isNaN(Date.parse(counted.sampledAt)), "带采样时间");
  const fakeSpawnHang = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    return child; // 永不 close ⇒ 超时腿
  };
  // fake child 无真实进程句柄撑环——unref 的超时 timer 会让 node:test 判
  // "pending promise + empty loop"（F2a 同款问题）。用 ref'd interval 撑环。
  const keepAlive = setInterval(() => {}, 200);
  let timed;
  try {
    timed = await defaultCountNodeProcesses({ timeoutMs: 60, spawnImpl: fakeSpawnHang });
  } finally { clearInterval(keepAlive); }
  assert.equal(timed.count, null, "采样超时 ⇒ count=null");
  assert.ok(/timed out after 60ms/.test(timed.reason));
});

test("TD-181(a) 纯函数钉：boundDetailString 截断标识 / firstRoundFailureDetail 防御形状（tests 非数组、抛错、fail 胜出）", () => {
  assert.equal(boundDetailString(undefined), null);
  assert.equal(boundDetailString(123), null);
  assert.equal(boundDetailString("short"), "short");
  const cut = boundDetailString("x".repeat(FAILURE_DETAIL_TEXT_CAP + 40));
  assert.ok(cut.endsWith(`…[TRUNCATED: first ${FAILURE_DETAIL_TEXT_CAP} of ${FAILURE_DETAIL_TEXT_CAP + 40} chars]`));
  assert.ok(cut.length <= FAILURE_DETAIL_TEXT_CAP + 60, "截断结果有界");

  assert.equal(firstRoundFailureDetail(null, "a.test.js").status, "unknown");
  assert.equal(firstRoundFailureDetail({ suites: [{ name: "test/a.test.js", status: "fail", tests: "not-an-array" }] }, "a.test.js").status, "collected", "tests 非数组不炸（零失败内容）");
  const weird = { suites: [{ name: "test/a.test.js", status: "fail", tests: [null, 42, { status: "fail" }] }] };
  const wd = firstRoundFailureDetail(weird, "a.test.js");
  assert.equal(wd.status, "collected");
  assert.equal(wd.failingTests[0].name, "(test name unavailable)", "无名失败子测试有明确占位，不编造名字");
  // 抛错防护：把 suites 变成 getter 陷阱。
  const hostile = { get suites() { throw new Error("boom"); } };
  const hd = firstRoundFailureDetail(hostile, "a.test.js");
  assert.equal(hd.status, "unknown");
  assert.ok(/collection error: boom/.test(hd.reason));
  // fail 胜出（与 mapReportToFiles 同语义）。
  const dup = { suites: [
    { name: "test/a.test.js", status: "pass", tests: [] },
    { name: "test/a.test.js", status: "fail", tests: [{ name: "n", status: "fail", duration: 1 }] },
  ] };
  assert.equal(firstRoundFailureDetail(dup, "a.test.js").failingTestsTotal, 1);
  // fileFailure 保留。
  const ff = firstRoundFailureDetail({ suites: [{ name: "test/a.test.js", status: "fail", tests: [], fileFailure: { message: "test timed out after 1000ms", stack: "at x" } }] }, "a.test.js");
  assert.equal(ff.fileFailure.message, "test timed out after 1000ms");
  assert.equal(unknownFailureDetail("r").status, "unknown");
});

// ────────────────────────────────────────────────────────────────────────────
// TD-181 (b, 2026-09-26, audit22 修复钉)：三个可复现缺陷的回归——
//   ① 预算按「实际 JSON 序列化长度」收敛：单条失败子测试 + fileFailure、含 JSON
//      转义字符（控制字符/引号）时旧实现序列化 8534/12437/14833 > 8000；
//   ② unknown 的 reason 限长（旧实现实测 20032）；
//   ③ node 进程观测：非零退出 / 信号 / 不可解析输出必须 unknown（旧实现全记 0），
//      正常空列表才可 0；采样超时释放采样子进程句柄；
//   ④ 端到端回归：走真实 canonical 套件入口（runSuite + 真实子进程适配器），
//      读取实际落盘报告，断言「首轮 fail + 单跑 pass ⇒ 仍 fail、失败详情已保存」
//      ——在落盘前撤掉 failureDetail（audit22 M2 变异）必红。
// ────────────────────────────────────────────────────────────────────────────

test("TD-181(b) ① 单条失败子测试 + fileFailure + 控制字符转义 ⇒ 实际序列化 ≤ 预算，截断标识带真实原始长度", () => {
  const ctl = (n) => "\u0001".repeat(n); // JSON.stringify 每字符膨胀 6 倍（\u0001）
  const report = makeRichReport("a.test.js", {
    failingTests: [{
      name: "the only failing subtest", status: "fail", duration: 1,
      error: {
        actual: ctl(3000) + "|actual-tail", expected: ctl(3000) + "|expected-tail",
        operator: "equal", stack: "AssertionError: values differ\n    at a.test.js:9:5",
        diff: "- Expected: x\n+ Received: y",
      },
    }],
    fileFailure: { message: "file-level failure: " + ctl(600), stack: "    at a.test.js:1:1" },
  });
  const d = firstRoundFailureDetail(report, "a.test.js");
  const len = JSON.stringify(d).length;
  assert.equal(d.status, "collected");
  assert.ok(d.failingTests.length >= 1, "至少保留一条（截断不归零）");
  assert.ok(len <= FAILURE_DETAIL_CHAR_BUDGET, `按实际序列化长度收敛：${len} ≤ ${FAILURE_DETAIL_CHAR_BUDGET}（旧实现此形状 14833）`);
  const t = d.failingTests[0];
  assert.equal(t.name, "the only failing subtest", "子测试名完整保留");
  assert.ok(/\[TRUNCATED: first \d+ of 3012 chars\]/.test(t.actual), `actual 截断标识带真实原始长度（实际 ${JSON.stringify(t.actual.slice(-60))}）`);
  assert.ok(/\[TRUNCATED: first \d+ of 3014 chars\]/.test(t.expected), "expected 截断标识带真实原始长度");
  assert.ok(t.actual.startsWith("\u0001\u0001\u0001"), "截断保留原文前缀，不杜撰内容");
  // 丢弃计数诚实：保留 + 丢弃 = 总数；fileFailure 被丢弃以腾预算时必须显式标注。
  assert.equal(d.failingTestsTotal - d.failingTests.length, d.failingTestsDropped);
  if (!d.fileFailure) assert.equal(d.fileFailureDropped, true, "fileFailure 丢弃必须显式计数，不得静默消失");
});

test("TD-181(b) ① 引号转义（每字符×2）多字段 ⇒ 实际序列化 ≤ 预算；fileFailure 为唯一内容时不被丢弃只缩前缀", () => {
  const q = (n) => '"'.repeat(n); // JSON.stringify 每字符膨胀 2 倍（\"）
  const multi = makeRichReport("a.test.js", {
    failingTests: [{
      name: "quoted subtest", status: "fail", duration: 1,
      error: { actual: q(1500), expected: q(1500), operator: "equal", stack: q(1500), diff: q(1500) },
    }],
    fileFailure: { message: q(1500), stack: q(1500) },
  });
  const md = firstRoundFailureDetail(multi, "a.test.js");
  assert.ok(JSON.stringify(md).length <= FAILURE_DETAIL_CHAR_BUDGET,
    `引号形状同样收敛（实际 ${JSON.stringify(md).length}）`);
  assert.equal(md.status, "collected");

  // fileFailure 是唯一内容（文件级失败、零子测试事件）⇒ 只缩字段前缀，绝不丢弃到空。
  const onlyFile = { suites: [{ name: "test/b.test.js", status: "fail", tests: [], fileFailure: { message: q(4000), stack: q(4000) } }] };
  const od = firstRoundFailureDetail(onlyFile, "b.test.js");
  assert.equal(od.status, "collected");
  assert.ok(od.fileFailure && od.fileFailure.message, "fileFailure 为唯一内容时必须保留（截断而非丢弃）");
  assert.ok(/\[TRUNCATED: first \d+ of 4000 chars\]/.test(od.fileFailure.message), "截断标识带真实原始长度");
  assert.ok(JSON.stringify(od).length <= FAILURE_DETAIL_CHAR_BUDGET, `fileFailure-only 形状同样收敛（实际 ${JSON.stringify(od).length}）`);
});

test("TD-181(b) ② unknown reason 限长 ⇒ 实际序列化 ≤ 预算且保留可辨识前缀（旧实现实测 20032）", async () => {
  const ud = unknownFailureDetail(`suite 'a.test.js' has unrecognized status "todo" — ` + "E".repeat(20032));
  assert.equal(ud.status, "unknown");
  assert.ok(ud.reason.startsWith("suite 'a.test.js' has unrecognized status"), "可辨识前缀保留");
  assert.ok(/\[TRUNCATED: first \d+ of \d+ chars\]/.test(ud.reason), "截断标识在场（真实原始长度）");
  const len = JSON.stringify(ud).length;
  assert.ok(len <= FAILURE_DETAIL_CHAR_BUDGET, `unknown 序列化 ${len} ≤ ${FAILURE_DETAIL_CHAR_BUDGET}`);
  // runWave 的坏报告腿透传 reportError ⇒ 同样有界。
  const w = await runWave({
    name: "pure", files: waveFiles(["a.test.js"], "pure"), concurrency: 1, reporterArg: "R",
    runChild: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readReport: async () => ({ suites: [{ name: "test/a.test.js", status: "nope", tests: [] }] }),
    deleteReport: noopDelete,
  });
  const wd = w.results[0].failureDetail;
  assert.equal(wd.status, "unknown");
  assert.ok(JSON.stringify(wd).length <= FAILURE_DETAIL_CHAR_BUDGET, "波内透传的 unknown 同样受预算约束");
});

test("TD-181(b) ③ node 进程观测：非零退出/信号/不可解析 ⇒ unknown（绝不记 0）；正常空列表才可 0", async () => {
  const csv = '"node.exe","111","Console","1","1,234 K"\r\n"node.exe","222","Console","1","2,345 K"\r\n';
  const fakeSpawn = (output, code = 0, signal = null) => () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit("data", output); child.emit("close", code, signal); });
    return child;
  };
  const sample = (output, code, signal) => defaultCountNodeProcesses({ timeoutMs: 2000, spawnImpl: fakeSpawn(output, code, signal) });

  // 正常：完整形状的 node.exe CSV 行按行计数；正常空输出（无可非难残留）⇒ 0。
  assert.equal((await sample(csv)).count, 2, "正常样本按完整 CSV 行计数");
  assert.equal((await sample("")).count, 0, "正常空列表（空输出）才可记 0");

  // 非零退出——即使输出里全是可数行，也必须 unknown。
  const nonZero = await sample(csv, 1);
  assert.equal(nonZero.count, null, "非零退出绝不记 0");
  assert.match(nonZero.reason, /exited with code 1/);

  // 信号退出 ⇒ unknown。
  const signaled = await sample(csv, null, "SIGKILL");
  assert.equal(signaled.count, null, "信号退出绝不记 0");
  assert.match(signaled.reason, /signal SIGKILL/);

  // 不可解析：无 node 行的非空残留（本地化 notice/垃圾均不可证为正常空列表——不建各语言 notice 字典）⇒ unknown。
  const garbage = await sample("some banner that is not tasklist CSV\r\n");
  assert.equal(garbage.count, null, "不可解析输出绝不记 0");
  assert.match(garbage.reason, /unparseable/);

  // 不可解析：带引号的非 node.exe 行（过滤器被绕过/不是 tasklist 输出）⇒ unknown。
  const otherImage = await sample('"cmd.exe","999","Console","1","1,000 K"\r\n');
  assert.equal(otherImage.count, null);
  assert.match(otherImage.reason, /unparseable/);

  // 不可解析：行首像 node.exe 但行形状不完整（"node.exe"garbage）⇒ unknown——按完整 CSV 行形状验证。
  const brokenRow = await sample('"node.exe"garbage\r\n');
  assert.equal(brokenRow.count, null, '"node.exe"garbage 不是完整 CSV 行 ⇒ unknown（前缀匹配不够）');
  assert.match(brokenRow.reason, /unparseable/);

  // 不可解析：合法行 + 未加引号垃圾残留 ⇒ unknown（残留可能吞掉了被截断的行）。
  const rowsPlusGarbage = await sample('"node.exe","111","Console","1","1,234 K"\r\nleftover junk\r\n');
  assert.equal(rowsPlusGarbage.count, null, "合法行+未加引号垃圾 ⇒ unknown");
  assert.match(rowsPlusGarbage.reason, /unparseable/);

  // 纯函数钉：parseTasklistSample 形状闭集（完整行形状验证）。
  assert.deepEqual(parseTasklistSample(""), { count: 0 });
  assert.deepEqual(parseTasklistSample(csv), { count: 2 });
  assert.equal(parseTasklistSample('"cmd.exe","1","c","0","1 K"').count, null);
  assert.equal(parseTasklistSample('"node.exe"garbage').count, null, "残行不得按前缀计数");
  assert.equal(parseTasklistSample('"node.exe","111","Console","1","1,234 K"\r\n信息: 没有运行的任务匹配指定标准。\r\n').count, null,
    "合法行+本地化 notice ⇒ unknown（无 notice 字典，不可证为正常空列表）");
  assert.equal(parseTasklistSample("信息: 没有运行的任务匹配指定标准。").count, null, "本地化 notice 不可证为正常空列表 ⇒ unknown");
});

test("TD-181(b) ③ node 进程观测：采样超时 ⇒ unknown 且不留活句柄（kill/destroy/unref 各恰一次，先于 resolve）", async () => {
  const calls = { kill: 0, destroy: 0, unref: 0 };
  const fakeSpawnHang = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => { calls.kill += 1; };
    child.stdout.destroy = () => { calls.destroy += 1; };
    child.unref = () => { calls.unref += 1; };
    return child; // 永不 close ⇒ 超时腿
  };
  // fake child 无真实句柄撑环——unref 的超时 timer 会让 node:test 判 "pending
  // promise + empty loop"；用 ref'd interval 模拟真实子进程句柄的撑环效果。
  const keepAlive = setInterval(() => {}, 200);
  let timed;
  try {
    timed = await defaultCountNodeProcesses({ timeoutMs: 60, spawnImpl: fakeSpawnHang });
  } finally { clearInterval(keepAlive); }
  assert.equal(timed.count, null, "超时 ⇒ unknown");
  assert.match(timed.reason, /timed out after 60ms/);
  assert.deepEqual(calls, { kill: 1, destroy: 1, unref: 1 },
    "超时腿释放采样子进程句柄：kill + stdout.destroy + unref 各恰一次（不留活句柄）");
});

// ── TD-181 (b) ④：真实 canonical 入口端到端回归 ──────────────────────────────
// 走 runSuite（main() 调的同一套件函数）+ 生产适配器（真实 node --test 子进程、
// 真实读写中间/聚合报告），夹具为合成 test/ 树 + 仓库 reporter 副本。
// Fixture phase is explicit at the existing adapter boundary: the real wave
// runs first, then the real isolator. Child fixtures read the phase marker;
// no absence timeout can masquerade as isolation. This proves report behavior
// for first-fail/alone-pass, not the cause of real-world process contention.
// 首轮 fail + 单跑 pass ⇒ 终判仍 fail、失败详情已落盘。
// 变异敏感性：落盘前撤掉 failureDetail（M2）或撤掉
// 序列化收敛 ⇒ 本测试红（内容缺失 / 长度超 8000）。
const E2E_SCRATCH_ROOT = join(synthRepoRoot, ".wao", "runs");

test("TD-181(b) tasklist output overflow is unknown even at complete-row boundaries", async () => {
  const prefix = '"node.exe","123","Console","1","';
  const suffix = '"\r\n';
  const row = prefix + "K".repeat(64 - prefix.length - suffix.length) + suffix;
  const atCap = row.repeat(512);
  assert.equal(atCap.length, 32768);
  const sample = (chunks) => defaultCountNodeProcesses({
    timeoutMs: 2000,
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      queueMicrotask(() => {
        for (const chunk of chunks) child.stdout.emit("data", chunk);
        child.emit("close", 0, null);
      });
      return child;
    },
  });
  assert.equal((await sample([atCap])).count, 512, "complete sample exactly at cap remains valid");
  for (const chunks of [[row + atCap], [row, atCap], [atCap, row]]) {
    const result = await sample(chunks);
    assert.equal(result.count, null, "a valid-looking retained tail must never hide omitted rows");
    assert.match(result.reason, /truncated|exceed|overflow/i);
  }
});

test("TD-181(b) tasklist CSV validates all five columns and numeric identities", () => {
  const invalid = [
    '"node.exe"', '"node.exe","123"',
    '"node.exe","123","Console","1"',
    '"node.exe","123","Console","1","1 K","extra"',
    '"node.exe","","Console","1","1 K"',
    '"node.exe","abc","Console","1","1 K"',
    '"node.exe","0","Console","1","1 K"',
    '"node.exe","4294967296","Console","1","1 K"',
    '"node.exe","123","Console","","1 K"',
    '"node.exe","123","Console","-1","1 K"',
    '"node.exe","123","Console","one","1 K"',
    '"node.exe","123","Console","4294967296","1 K"',
    '"node.exe","123","Con"sole","1","1 K"',
  ];
  const valid = '"node.exe","123","控制台, ""local""","0","1,234 K"';
  assert.deepEqual(parseTasklistSample(valid), { count: 1 });
  for (const row of invalid) {
    const result = parseTasklistSample(`${valid}\r\n${row}`);
    assert.equal(result.count, null, row);
    assert.match(result.reason, /unparseable/);
  }
});

test("TD-181(b) ④ 真实入口回归: 首轮 fail + 单跑 pass ⇒ 落盘报告仍 fail、失败详情已保存、有界；verdict 行如实", async () => {
  await mkdirSync(E2E_SCRATCH_ROOT, { recursive: true });
  const root = mkdtempSync(join(E2E_SCRATCH_ROOT, "td181-e2e-"));
  // TEMP 纪律：工作区在 <checkout>/.wao/runs/ 短子目录内（gitignored），不越界。
  assert.ok(root.startsWith(E2E_SCRATCH_ROOT), "夹具工作区必须在授权 scratch 内");
  const prevExitCode = process.exitCode;
  const stderrLines = [];
  const origError = console.error;
  console.error = (line) => { stderrLines.push(String(line)); };
  try {
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n', "utf8");
    mkdirSync(join(root, "test"), { recursive: true });
    // 仓库 reporter 副本：波子进程经 --test-reporter ./test/reporter.mjs 写中间报告。
    writeFileSync(join(root, "test", "reporter.mjs"), readFileSync(join(synthRepoRoot, "test", "reporter.mjs"), "utf8"), "utf8");
    const phasePath = join(root, "td181-fixture-phase.txt");
    writeFileSync(join(root, "test", "partner.test.js"), [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'test("partner passes in first round", () => {',
      '  assert.equal(readFileSync(join(process.cwd(), "td181-fixture-phase.txt"), "utf8"), "first");',
      '});',
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(root, "test", "cofail.test.js"), [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const ctl = (n) => "\\u0001".repeat(n);',
      'test("fixture first-round fail, isolation pass", () => {',
      '  const phase = readFileSync(join(process.cwd(), "td181-fixture-phase.txt"), "utf8");',
      '  assert.ok(phase === "first" || phase === "isolation", "explicit fixture phase required");',
      '  if (phase === "first") assert.equal(ctl(1500) + "|seen-actual", ctl(1500) + "|seen-expected");',
      '});',
      "",
    ].join("\n"), "utf8");
    const manifest = { groups: { pure: ["cofail.test.js", "partner.test.js"], git: [], worktree: [], process: [], lock: [], timeout: [], mcp: [] } };
    const manifestPath = join(root, "test", "manifest.json");
    const reportPath = join(root, "test-results.json");
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    const exitCalls = [];
    await runSuite({
      repoRoot: root, testDir: join(root, "test"), manifestPath, reportPath,
      nodeExe: process.execPath, childEnv: synthChildEnv(),
      exitFn: (code) => exitCalls.push(code),
      runCanonicalImpl: (options) => runCanonical({
        ...options,
        runChild: (...args) => {
          writeFileSync(phasePath, "first", "utf8");
          return options.runChild(...args);
        },
        isolator: (...args) => {
          writeFileSync(phasePath, "isolation", "utf8");
          return options.isolator(...args);
        },
      }),
    });
    assert.deepEqual(exitCalls, [], "无看门狗中止 ⇒ 不强退（有界退出路径不触发）");

    // 读取实际落盘报告（非内存对象）——这是 audit22 M2 变异（落盘前撤掉
    // failureDetail）必须红掉的断言面。
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.finalVerdict, "fail", "首轮 fail + 隔离 pass ⇒ 最终仍 fail（绝不洗绿）");
    assert.equal(report.suiteError, false, "干净波（无波级错误）——失败全部归因到文件");
    assert.equal(report.firstRound.verdict, "fail");
    assert.equal(report.firstRound.passed, 1, "partner 波内通过");
    assert.equal(report.firstRound.failed, 1, "explicit first-round fixture failure");
    const f = report.firstRound.failures.find((x) => x.path === "cofail.test.js");
    assert.ok(f, "failures 含 cofail.test.js");
    assert.equal(f.status, "fail");
    const d = f.failureDetail;
    assert.equal(d.status, "collected", "首轮失败详情已保存（落盘报告内）");
    assert.equal(d.source, "firstRoundWaveReport");
    assert.ok(Array.isArray(d.failingTests) && d.failingTests.length >= 1, "至少一条失败子测试保留");
    assert.equal(d.failingTests[0].name, "fixture first-round fail, isolation pass", "失败子测试名如实保留");
    const dLen = JSON.stringify(d).length;
    assert.ok(dLen <= FAILURE_DETAIL_CHAR_BUDGET, `落盘 failureDetail 实际序列化 ${dLen} ≤ ${FAILURE_DETAIL_CHAR_BUDGET}（撤掉序列化收敛必红）`);
    assert.ok(/\[TRUNCATED: first \d+ of \d+ chars\]/.test(d.failingTests[0].actual), "重内容被截断时带真实原始长度标识");
    assert.ok(d.failingTests[0].actual.startsWith("\u0001\u0001\u0001"), "截断保留原文前缀，不杜撰内容");
    assert.equal(d.failingTestsTotal - d.failingTests.length, d.failingTestsDropped, "丢弃计数诚实");
    const iso = report.isolation.find((x) => x.path === "cofail.test.js");
    assert.ok(iso, "cofail 获得一次隔离重跑");
    assert.equal(iso.isolationStatus, "pass", "单文件重跑通过");
    assert.equal(iso.classification, "isolation_pass", "分类 = isolation_pass");
    assert.deepEqual(report.runsDirGuard.additions, [], "合成根目录无 runs/ 写入");
    // stderr verdict 行如实（runSuite 打印，非内存）。
    assert.ok(stderrLines.some((l) => /verdict=fail /.test(l)), `verdict 行必须如实为 fail（实际首行：${stderrLines.find((l) => l.includes("verdict=")) ?? "(无)"}）`);
    assert.ok(stderrLines.some((l) => /isolation cofail\.test\.js .* ⇒ isolation_pass/.test(l)), "isolation 分类行如实");
  } finally {
    console.error = origError;
    process.exitCode = prevExitCode; // runSuite 置 process.exitCode=1——恢复宿主 runner 状态
    rmSync(root, { recursive: true, force: true });
  }
});

// ── TD-233：worker 上下文自知（横幅）+ 验证租约的 worktree runId 归因 ──────────

test("TD-233: workerBannerLine — 命中 WAO_IN_WORKER 给出 0047 预期红说明，未命中为 null", () => {
  assert.equal(workerBannerLine({}), null, "worker 上下文外不打横幅");
  assert.equal(workerBannerLine({ WAO_IN_WORKER: "" }), null, "空值视为未命中");
  assert.equal(workerBannerLine({ WAO_IN_WORKER: "0" }), null,
    "显式 \"0\" 不触发（验收会审 astra：触发必须镜像守卫的字面 \"1\" 语义）");
  const line = workerBannerLine({ WAO_IN_WORKER: "1" });
  assert.ok(line, "命中必须返回横幅行");
  assert.ok(line.startsWith("[canonical]"), "横幅走套件既有 [canonical] stderr 通道");
  assert.ok(line.includes("WAO_IN_WORKER"), "横幅点名检测到的 env");
  assert.ok(line.includes("0047"), "横幅点名决定 0047（防向下派发门）");
  assert.ok(line.includes("预期") && line.includes("非回归"), "横幅必须说明会红属预期非回归");
});

test("TD-233: workerBannerLine — 已有 Lead 豁免时只报上下文事实，不预判红绿（验收会审 astra 反例）", () => {
  const line = workerBannerLine({ WAO_IN_WORKER: "1", WAO_ALLOW_NESTED_DISPATCH: "1" });
  assert.ok(line, "豁免在场仍返回横幅（上下文事实有价值）");
  assert.ok(line.includes("豁免"), "点名豁免在场");
  assert.ok(!line.includes("会变红"), "env 标记臂被豁免中和，不得预判会红");
  assert.ok(!line.includes("非回归"), "无预判则无非回归声明");
});

test("TD-246: workerBannerLine 豁免分支如实——两臂均不拦截（旧文案与守卫事实矛盾，已修）", () => {
  const line = workerBannerLine({ WAO_IN_WORKER: "1", WAO_ALLOW_NESTED_DISPATCH: "1" });
  assert.ok(line.includes("均不拦截"), "豁免=0047 语义内的整体旁路（守卫在豁免口即返回），横幅必须如实");
  assert.ok(!line.includes("cwd 臂仍按原样生效"), "与守卫事实矛盾的旧措辞必须清除（kimi P1 会审发现）");
});

test("TD-233: runIdFromWorktreeCwd — 从 .wao-worktrees/<runId> 形态解析 runId", () => {
  const worktreeCwd = join(tmpdir(), "host", "repo", ".wao-worktrees", "run_20261008140227412zt6oi1");
  assert.equal(runIdFromWorktreeCwd(worktreeCwd), "run_20261008140227412zt6oi1", "join 形态（平台分隔符）");
  assert.equal(runIdFromWorktreeCwd("C:/host/repo/.wao-worktrees/run_abc123"), "run_abc123", "正斜杠形态同样解析");
});

test("TD-233: runIdFromWorktreeCwd — 解析失败一律返回 null（不附 runId，保持现状）", () => {
  assert.equal(runIdFromWorktreeCwd(join(tmpdir(), "host", "repo")), null, "主仓 checkout（无 .wao-worktrees 段）");
  assert.equal(runIdFromWorktreeCwd(join(tmpdir(), "host", ".wao-worktrees")), null, ".wao-worktrees 是末段（无 runId 跟随）");
  assert.equal(runIdFromWorktreeCwd(join(tmpdir(), "host", "repo", ".wao-worktrees", "bad runid")), null, "段含空格（非 allowlist）");
  assert.equal(runIdFromWorktreeCwd(join(tmpdir(), "host", "repo", ".wao-worktrees", ".hidden")), null, "段以点开头（isValidRunId 同款拒绝）");
  assert.equal(runIdFromWorktreeCwd(join(tmpdir(), "host", "repo", ".wao-worktrees", "-lead")), null, "段以连字符开头（isValidRunId 同款拒绝）");
  assert.equal(runIdFromWorktreeCwd(join(tmpdir(), "host", "repo", ".wao-worktrees", "..")), null, "段是父目录引用（ traversal 拒绝）");
});

test("TD-233: runIdFromWorktreeCwd — 末次出现优先 + Windows 大小写 + 超帽整体丢弃", () => {
  const nested = join(tmpdir(), "host", ".wao-worktrees", "decoy01", "inner", ".wao-worktrees", "run_real1");
  assert.equal(runIdFromWorktreeCwd(nested), "run_real1", "取最后一次 .wao-worktrees 之后的段");
  const long = "a".repeat(100);
  assert.equal(runIdFromWorktreeCwd(join(tmpdir(), "host", "repo", ".wao-worktrees", long)), null,
    "超 64 帽的候选整体丢弃（验收会审 astra：截断会冒充另一个 runId，禁止）");
  assert.equal(runIdFromWorktreeCwd(join(tmpdir(), "host", "repo", ".WAO-WORKTREES", "run_case1")), "run_case1",
    "Windows 大小写变体同样归因（验收会审 astra 反例）");
});
