#!/usr/bin/env node
// scripts/canonical-test.mjs
//
// TD-107 — the canonical test runner. Zero-dependency, repository-owned, invoked
// through the repo Node22 shim (scripts/wao-node.cjs) so the whole suite runs
// under Node v22. `npm test` is the sole authoritative entry; this script IS the
// implementation of that entry.
//
// Contract (see test/canonicalRunner.test.js for the pinned invariants):
//   - Reads the explicit TRACKED manifest (test/manifest.json) that assigns every
//     test/**/*.test.js to exactly ONE resource CATEGORY (the closed six). Those
//     categories exist for OWNERSHIP + drift detection and are NEVER guessed.
//   - EXECUTION is organized into serial WAVES derived from the categories. A
//     wave may pool one OR MORE categories under a single bounded concurrency so
//     the wave's long-pole files OVERLAP instead of stacking serially. The
//     filesystem wave pools git + worktree (both do real git/worktree I/O on
//     isolated fixtures) so their two long poles overlap under one capped pool;
//     lock stays serial (real singleton port/terminal arbiter).
//   - Validates BOTH the manifest AND the wave plan BEFORE execution:
//       manifest  — missing / duplicate / stale / unknown / unknown-category
//       wave plan  — every category in EXACTLY one wave, no reused/unknown
//                    category, unique wave names, integer concurrency >= 1
//     Any drift is a HARD failure (non-zero, no tests run).
//   - Runs WAVES SERIALLY; within a wave, exactly ONE Node child is spawned:
//       node --test --test-concurrency=<wave limit> --test-reporter ./test/reporter.mjs <files...>
//     Node runs that wave's files (in-process, default isolation) and the custom
//     structured reporter (test/reporter.mjs) writes a structured test-results.json.
//     After each child closes the runner reads+validates that JSON immediately and
//     maps reporter suites to the manifest's expected files (NO human TAP/spec
//     text, NO regex classification). The next wave then overwrites the
//     intermediate report; the bounded aggregate is written at the end.
//   - Runs EVERY wave to completion before summarizing (no early abort).
//   - First-round verdict: any non-pass file (fail / missing suite / crash) OR a
//     nonzero wave exit OR a missing/malformed wave report OR a spawn error ⇒
//     non-green, and that can NEVER be washed green. Each non-pass file gets at
//     most ONE isolation recheck (a single process per failed file — diagnostic,
//     bounded) that only APPENDS a classification
//     (stable_fail / isolation_pass / environment_invalid) — never a pass.
//   - Writes a bounded test-results.json that keeps every failure attributable to
//     BOTH its resource category AND its execution wave: each file records
//     resourceCategory + executionWave; each wave records timing/counts/exit.
//
// Performance: one Node process per WAVE (≈5 starts) instead of one per file
// (≈161 starts) or one per category (6 starts with serial long poles). In-wave
// parallelism is controlled by --test-concurrency, tuned per wave from measured
// evidence. Concurrency never exceeds the proven baseline.
//
// Prohibitions honored: no shell `&&`/`&` (children spawned with explicit argv
// arrays, no shell), no runtime regex classification, no second gate (single
// verdict), no timeout inflation, no skipped failures, no new deps.

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { availableParallelism, cpus } from "node:os";

// ── Resource categories: the closed set named in the TD-107 contract. ─────────
// These seven are the MANIFEST categories used for ownership + drift detection.
// They are NOT the execution units — execution is organized into WAVES (below),
// and one wave may pool several resource categories. `mcp` is the long-lived
// in-memory MCP request category (real SDK transport over an in-memory pair);
// it gets its OWN serial wave so those requests never share the filesystem
// wave's pooled concurrency budget.
export const MANIFEST_GROUPS = Object.freeze([
  "pure", "git", "worktree", "process", "lock", "timeout", "mcp",
]);

// ── Execution waves: serial stages derived from the resource categories. ─────
// Waves run one after another (wave-serial). Within a wave, exactly ONE Node
// child runs all of the wave's files at the wave's bounded concurrency, so the
// wave's long-pole files OVERLAP under a single capped pool instead of stacking
// serially. The filesystem wave pools git + worktree (both do real git/worktree
// I/O on isolated temp fixtures) so their two long poles (runDeliveryReverify in
// git, runDelivery in worktree) overlap instead of running back-to-back; lock
// stays serial (real singleton port/terminal arbiter). The mcp wave is ALSO
// serial (concurrency 1): long-lived in-memory MCP request tests run one at a
// time, isolated from the filesystem wave's pooled budget, so a per-file request
// never competes with cross-file load for the SDK request budget. Every manifest
// category must appear in exactly one wave (validated before execution).
//
// Concurrency is tuned from MEASURED evidence (filesystem wave, 54 files):
//   @8  = 212s  (argv-order scheduling strands the alphabetically-late pole)
//   @16 = 178s  (conservative knee — solidly past the @8 that failed the target)
//   @24 = 171s  (diminishing: +8 concurrency saves only ~7s past 16)
// 16 is the smallest value that comfortably meets the delivery window.
function hardwareParallelism() {
  try { return availableParallelism ? availableParallelism() : cpus().length; }
  catch { return 4; }
}
const HW = hardwareParallelism();
export const WAVE_PLAN = Object.freeze([
  { name: "pure", concurrency: 8, categories: ["pure"] },
  { name: "filesystem", concurrency: 16, categories: ["git", "worktree"] },
  { name: "mcp", concurrency: 1, categories: ["mcp"] },
  { name: "process", concurrency: 3, categories: ["process"] },
  { name: "lock", concurrency: 1, categories: ["lock"] },
  { name: "timeout", concurrency: 2, categories: ["timeout"] },
]);

// Validate the wave plan against the closed category set: every category must
// appear in EXACTLY one wave, no wave may reuse a category, no unknown category,
// wave names must be unique, and every wave needs an integer concurrency >= 1.
// Returns { ok, errors, categoryToWave }.
export function validateWavePlan(wavePlan, categories) {
  const errors = [];
  const categoryToWave = new Map();
  if (!Array.isArray(wavePlan)) return { ok: false, errors: ["wavePlan is not an array"], categoryToWave };
  const known = new Set(categories);
  const waveNames = new Set();
  for (const wave of wavePlan) {
    if (!wave || typeof wave.name !== "string") { errors.push("wave missing a name"); continue; }
    if (waveNames.has(wave.name)) errors.push(`duplicate wave name: '${wave.name}'`);
    else waveNames.add(wave.name);
    if (!Number.isInteger(wave.concurrency) || wave.concurrency < 1) errors.push(`wave '${wave.name}' concurrency must be an integer >= 1`);
    if (!Array.isArray(wave.categories)) { errors.push(`wave '${wave.name}' has no categories array`); continue; }
    for (const cat of wave.categories) {
      if (!known.has(cat)) { errors.push(`unknown category '${cat}' in wave '${wave.name}'`); continue; }
      if (categoryToWave.has(cat)) errors.push(`category '${cat}' in more than one wave ('${categoryToWave.get(cat)}' and '${wave.name}')`);
      else categoryToWave.set(cat, wave.name);
    }
  }
  for (const cat of known) {
    if (!categoryToWave.has(cat)) errors.push(`category '${cat}' is not in any wave`);
  }
  return { ok: errors.length === 0, errors, categoryToWave };
}

// ── Manifest validation (pure, tested in canonicalRunner.test.js) ────────────
//
// `discovered`: iterable of test-relative paths (forward-slashed, e.g.
// "parsers/lineStream.test.js"). Returns { ok, errors, assignment }.
//   missing  — discovered file assigned to no category
//   duplicate — same file in two categories
//   stale    — manifest entry not present on disk (not discovered)
//   unknown  — manifest entry that is not a *.test.js path
//   unknown category — a category name outside the closed set
export function validateManifest(manifest, discovered) {
  const errors = [];
  const assignment = new Map();
  if (!manifest || typeof manifest !== "object" || !manifest.groups || typeof manifest.groups !== "object") {
    return { ok: false, errors: ["manifest: missing or non-object 'groups'"], assignment };
  }
  const discoveredSet = new Set(discovered);
  const known = new Set(MANIFEST_GROUPS);
  for (const [group, files] of Object.entries(manifest.groups)) {
    if (!known.has(group)) { errors.push(`unknown group: '${group}'`); }
    if (!Array.isArray(files)) { errors.push(`group '${group}' is not an array`); continue; }
    for (const entry of files) {
      if (typeof entry !== "string") { errors.push(`group '${group}' has a non-string entry`); continue; }
      if (!entry.endsWith(".test.js")) { errors.push(`unknown: '${entry}' in group '${group}' is not a *.test.js path`); }
      if (!discoveredSet.has(entry)) { errors.push(`stale: '${entry}' in group '${group}' does not exist on disk`); }
      if (assignment.has(entry)) { errors.push(`duplicate: '${entry}' in both '${assignment.get(entry)}' and '${group}'`); }
      else assignment.set(entry, group);
    }
  }
  for (const entry of discoveredSet) {
    if (!assignment.has(entry)) errors.push(`missing: '${entry}' is not assigned to any group`);
  }
  return { ok: errors.length === 0, errors, assignment };
}

// ── Isolation classification (pure, tested in canonicalRunner.test.js) ───────
// A first-round PASS is never rechecked. A non-pass first round gets ONE isolation
// run; its outcome only labels the failure — it can NEVER produce PASS.
export function classifyIsolation(firstRoundStatus, isolationStatus) {
  if (firstRoundStatus === "pass") return "not_rechecked";
  if (isolationStatus === "pass") return "isolation_pass";
  if (isolationStatus === "crash") return "environment_invalid";
  return "stable_fail"; // isolationStatus === "fail"
}

// ── Structured-report → manifest-file mapping (pure, unit-tested) ────────────
// The reporter writes suite.name as a cwd-relative, forward-slashed path
// ("test/<rel>"). Strip the leading "test/" to recover the manifest rel path.
export function suiteRelToManifest(name) {
  if (!name) return "";
  const n = String(name).replace(/\\/g, "/");
  if (n.startsWith("test/")) return n.slice(5);
  const idx = n.indexOf("/test/");
  if (idx >= 0) return n.slice(idx + 6);
  return n;
}

// The ONLY suite status values the reporter emits and that mapReportToFiles
// accepts for a file verdict. test/reporter.mjs sets suite.status to "pass"
// (initial) or "fail" (any failing test) — nothing else. Any other value
// (unknown string, missing, non-string) makes the report INVALID (non-green); it
// NEVER defaults to pass.
const SUITE_STATUS_TO_FILE = Object.freeze({ pass: "pass", fail: "fail" });

// Map a parsed reporter report to a rel→status map for the wave's expected files.
//   pass    — a suite exists with status "pass"
//   fail    — a suite exists with status "fail" (fail wins over pass)
//   missing — expected file with NO suite (did not report — crash/filter quirk)
// reportValid is false (and all files map to "crash") when the report itself is
// missing/malformed/has an unrecognized suite status — that is a WAVE RUNNER
// failure, not per-file.
export function mapReportToFiles(report, expectedRels) {
  const crashAll = (reportError) => ({ reportValid: false, reportError, perFile: new Map(expectedRels.map((r) => [r, "crash"])) });
  if (!report || typeof report !== "object") return crashAll("report missing or not an object");
  if (!Array.isArray(report.suites)) return crashAll("report has no 'suites' array");
  const perFile = new Map(expectedRels.map((r) => [r, "missing"]));
  for (const suite of report.suites) {
    if (!suite || typeof suite.name !== "string") continue;
    // Accept ONLY the closed suite status set. Unknown / missing / non-string
    // status ⇒ the whole report is invalid (non-green), never a silent pass.
    const fileStatus = SUITE_STATUS_TO_FILE[suite.status];
    if (fileStatus === undefined) return crashAll(`suite '${suite.name}' has unrecognized status ${JSON.stringify(suite.status)}`);
    const rel = suiteRelToManifest(suite.name);
    if (!perFile.has(rel)) continue;
    const cur = perFile.get(rel);
    if (cur === "missing" || fileStatus === "fail") perFile.set(rel, fileStatus); // fail wins; never downgrade
  }
  return { reportValid: true, reportError: null, perFile };
}

// ── Discovery: every test/**/*.test.js, test-relative, forward-slashed ───────
function discoverTestFiles(testDir) {
  const out = [];
  function walk(d) {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (entry.endsWith(".test.js")) out.push(relative(testDir, p).split(sep).join("/"));
    }
  }
  walk(testDir);
  return out.sort();
}

// ── Run ONE wave via a single `node --test` child + structured report. ───────
// `runChild`, `readReport`, `deleteReport` are injectable so the orchestration is
// unit-testable with synthetic children/reports and no wall time. The report is
// deleted before the child runs so a crash-before-flush (stale/missing report) is
// detected rather than read as the previous wave's result. A wave failure can
// NEVER surface as zero failures (invariant 4): missing report → all crash;
// nonzero exit with a clean report → groupError; missing suites → non-pass.
//
// A wave pools files from one OR MORE resource categories; each file carries its
// resourceCategory so failures stay attributable to category AND wave. `files` =
// [{ path, resourceCategory }].
export async function runWave({ name, files, concurrency, reporterArg, runChild, readReport, deleteReport }) {
  const start = Date.now();
  if (files.length === 0) return { name, results: [], durationMs: 0, exitCode: 0, groupError: null };

  const expectedRels = files.map((f) => f.path);

  // Delete the intermediate report first so a crash-before-flush (or a delete
  // failure) can NEVER be read as the previous wave's stale result. A delete
  // failure is itself a wave-level non-green: every expected file is marked
  // crash, the child is NOT spawned, and runCanonical continues to later waves.
  try {
    await deleteReport();
  } catch (err) {
    return {
      name, durationMs: Date.now() - start, exitCode: null,
      groupError: `delete report failed: ${err && err.message ? err.message : String(err)}`,
      results: files.map((f) => ({ path: f.path, status: "crash", resourceCategory: f.resourceCategory, executionWave: name })),
    };
  }

  const argv = [
    "--test",
    `--test-concurrency=${concurrency}`,
    "--test-reporter", reporterArg,
    ...expectedRels.map((rel) => "test/" + rel),
  ];

  let child;
  try {
    child = await runChild(argv, {});
  } catch (err) {
    return {
      name, durationMs: Date.now() - start, exitCode: null,
      groupError: `spawn error: ${err && err.message ? err.message : String(err)}`,
      results: files.map((f) => ({ path: f.path, status: "crash", resourceCategory: f.resourceCategory, executionWave: name })),
    };
  }

  const report = await readReport();
  const { reportValid, reportError, perFile } = mapReportToFiles(report, expectedRels);
  const results = files.map((f) => ({ path: f.path, status: perFile.get(f.path) || "missing", resourceCategory: f.resourceCategory, executionWave: name }));

  const hasNonPass = results.some((r) => r.status !== "pass");
  let groupError = null;
  if (!reportValid) {
    groupError = reportError; // missing/malformed report ⇒ wave runner failure
  } else if (child.exitCode !== 0 && !hasNonPass) {
    // Nonzero exit but the report looks clean — cannot attribute; treat as a wave
    // runner failure so it can NEVER silently read as success.
    groupError = `child exit ${child.exitCode} but report shows all pass`;
  }

  return {
    name, results, durationMs: Date.now() - start,
    exitCode: child.exitCode ?? null, groupError,
    childStderr: child.stderr, childStdout: child.stdout,
  };
}

// ── Orchestration: waves serially, then ≤1 isolation rerun per failed file. ──
// Adapters are injectable for deterministic causal tests. The verdict is derived
// ONLY from first-round results (isolation never washes green); any groupError
// also forces non-green. Each wave spec carries its pooled categories so the
// bounded report can attribute every file to category + wave.
export async function runCanonical({ waveSpecs, reporterArg, runChild, readReport, deleteReport, isolator, onWaveStart, onWaveEnd }) {
  const wavesReport = [];
  const firstRound = [];
  let suiteError = false;
  for (const spec of waveSpecs) {
    if (onWaveStart) onWaveStart(spec);
    const w = await runWave({ name: spec.name, files: spec.files, concurrency: spec.concurrency, reporterArg, runChild, readReport, deleteReport });
    if (w.groupError) suiteError = true;
    firstRound.push(...w.results);
    const wave = {
      name: spec.name,
      categories: spec.categories ? [...spec.categories] : [],
      concurrency: spec.concurrency,
      durationMs: w.durationMs,
      exitCode: w.exitCode,
      total: w.results.length,
      passed: w.results.filter((r) => r.status === "pass").length,
      failed: w.results.filter((r) => r.status === "fail").length,
      missing: w.results.filter((r) => r.status === "missing").length,
      crashed: w.results.filter((r) => r.status === "crash").length,
      groupError: w.groupError,
      files: w.results.map((r) => ({ path: r.path, status: r.status, resourceCategory: r.resourceCategory, executionWave: r.executionWave })),
    };
    wavesReport.push(wave);
    if (onWaveEnd) onWaveEnd(wave);
  }

  const failures = firstRound.filter((r) => r.status !== "pass");
  const isolation = [];
  if (isolator) {
    for (const f of failures) {
      const iso = await isolator({ file: f.path });
      isolation.push({
        path: f.path,
        resourceCategory: f.resourceCategory,
        executionWave: f.executionWave,
        firstRoundStatus: f.status,
        isolationStatus: iso.status,
        isolationExitCode: iso.exitCode ?? null,
        classification: classifyIsolation(f.status, iso.status),
        isolationTail: iso.tail,
      });
    }
  }

  const passed = firstRound.filter((r) => r.status === "pass").length;
  const failed = firstRound.filter((r) => r.status === "fail").length;
  const missing = firstRound.filter((r) => r.status === "missing").length;
  const crashed = firstRound.filter((r) => r.status === "crash").length;
  const firstRoundVerdict = (failures.length === 0 && !suiteError) ? "pass" : "fail";

  return {
    waves: wavesReport,
    firstRound: {
      verdict: firstRoundVerdict,
      passed, failed, missing, crashed,
      failures: failures.map((r) => ({ path: r.path, status: r.status })),
    },
    isolation,
    finalVerdict: firstRoundVerdict, // isolation never changes the verdict
    suiteError,
  };
}

// ── Real adapters (used by main(); injectable fakes are used by the meta-tests) ─
const CHILD_BUFFER_CAP = 32768;
const TAIL_CHARS = 2000;

// One `node --test` child per wave. Returns {exitCode, stdout, stderr}; rejects
// on spawn error (caught by runWave → all files crash).
export function realRunChild(nodeExe, repoRoot, env) {
  return (argv, _opts) => new Promise((resolve, reject) => {
    const child = spawn(nodeExe, argv, {
      cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let out = "";
    let err = "";
    const onOut = (c) => { out += c; if (out.length > CHILD_BUFFER_CAP) out = out.slice(out.length - CHILD_BUFFER_CAP); };
    const onErr = (c) => { err += c; if (err.length > CHILD_BUFFER_CAP) err = err.slice(err.length - CHILD_BUFFER_CAP); };
    child.stdout.on("data", onOut);
    child.stderr.on("data", onErr);
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code, stdout: out, stderr: err }));
  });
}

// Read+parse the intermediate structured report; null if missing or unparseable.
export function realReadReport(reportPath) {
  return async () => {
    try { return JSON.parse(readFileSync(reportPath, "utf8")); }
    catch { return null; }
  };
}

// Remove the intermediate report before a wave runs so a crash-before-flush is
// detected as "missing" rather than reading the previous wave's stale result.
// Only ENOENT ("not found") is ignored — that is the normal pre-first-wave state.
// Any other delete failure (EACCES/EPERM/EBUSY/...) is rethrown so runWave fails
// the wave CLOSED (no child spawn, no report read) instead of risking a stale
// read; the failure stays observable.
export function realDeleteReport(reportPath) {
  return async () => {
    try { unlinkSync(reportPath); }
    catch (err) {
      if (err && err.code === "ENOENT") return; // normal: no prior report to clear
      throw err; // any other delete failure must stay observable
    }
  };
}

// One isolated diagnostic child per first-pass failed file. Verdict by EXIT CODE
// so a spawn crash (exit null) stays distinct from a clean failure — that feeds
// classifyIsolation's environment_invalid branch.
export function realIsolator(nodeExe, repoRoot, env) {
  return ({ file }) => new Promise((resolve) => {
    const start = Date.now();
    let err = "";
    const child = spawn(nodeExe, ["--test", "test/" + file], {
      cwd: repoRoot, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
    });
    child.stderr.on("data", (c) => { err += c; if (err.length > CHILD_BUFFER_CAP) err = err.slice(err.length - CHILD_BUFFER_CAP); });
    child.on("error", () => resolve({ status: "crash", exitCode: null, durationMs: Date.now() - start, tail: err.slice(-TAIL_CHARS) }));
    child.on("close", (code) => resolve({
      status: code === 0 ? "pass" : code === null ? "crash" : "fail",
      exitCode: code, durationMs: Date.now() - start, tail: err.slice(-TAIL_CHARS),
    }));
  });
}

// ── main(): load manifest, validate manifest + wave plan, run, report. ───────
async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..");
  const testDir = join(repoRoot, "test");
  const manifestPath = join(testDir, "manifest.json");
  const reportPath = join(repoRoot, "test-results.json");
  const reporterArg = "./test/reporter.mjs";
  const nodeExe = process.execPath;

  const childEnv = { ...process.env, WAO_SKIP_VERSION_GUARD: "1" };

  // 1) Load manifest (invalid JSON / missing file ⇒ invalid environment ⇒ non-zero).
  let manifestText;
  try { manifestText = readFileSync(manifestPath, "utf8"); }
  catch (err) { return failInvalidEnvironment(reportPath, `cannot read manifest ${manifestPath}: ${err.message}`); }
  let manifest;
  try { manifest = JSON.parse(manifestText); }
  catch (err) { return failInvalidEnvironment(reportPath, `manifest is not valid JSON: ${err.message}`); }

  // 2) Discover + validate the manifest (every test assigned exactly once to a
  //    category). Drift ⇒ hard fail BEFORE any test runs.
  const discovered = discoverTestFiles(testDir);
  const validation = validateManifest(manifest, discovered);
  if (!validation.ok) {
    return failInvalidEnvironment(reportPath, "manifest drift detected (fix test/manifest.json):\n  - " + validation.errors.join("\n  - "));
  }

  // 3) Validate the wave plan: every category in EXACTLY one wave. A bad plan is a
  //    programming error (frozen constant) ⇒ hard fail before any test runs.
  const waveValidation = validateWavePlan(WAVE_PLAN, MANIFEST_GROUPS);
  if (!waveValidation.ok) {
    return failInvalidEnvironment(reportPath, "wave plan invalid:\n  - " + waveValidation.errors.join("\n  - "));
  }

  // 4) Build wave specs (serial order; each wave pools its categories' files).
  const waveSpecs = WAVE_PLAN.map((wave) => {
    const files = [];
    for (const cat of wave.categories) {
      for (const p of (manifest.groups[cat] || [])) files.push({ path: p, resourceCategory: cat });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { name: wave.name, concurrency: wave.concurrency, categories: wave.categories, files };
  }).filter((spec) => spec.files.length > 0);

  const t0 = Date.now();
  const outcome = await runCanonical({
    waveSpecs,
    reporterArg,
    runChild: realRunChild(nodeExe, repoRoot, childEnv),
    readReport: realReadReport(reportPath),
    deleteReport: realDeleteReport(reportPath),
    isolator: realIsolator(nodeExe, repoRoot, childEnv),
    onWaveStart: (spec) => console.error(`[canonical] wave=${spec.name} start files=${spec.files.length} categories=${spec.categories.join("+")} concurrency=${spec.concurrency}`),
    onWaveEnd: (w) => {
      const wf = w.failed + w.crashed + w.missing;
      console.error(`[canonical] wave=${w.name} done exit=${w.exitCode} pass=${w.passed} failed=${wf} ${w.durationMs}ms${w.groupError ? " WAVE_ERROR=" + w.groupError : ""}`);
    },
  });
  const totalMs = Date.now() - t0;

  for (const iso of outcome.isolation) {
    console.error(`[canonical] isolation ${iso.path} [${iso.resourceCategory}/${iso.executionWave}] firstRound=${iso.firstRoundStatus} alone=${iso.isolationStatus} ⇒ ${iso.classification}`);
  }

  const report = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    runner: { name: "canonical-test", node: process.version, hardwareParallelism: HW, mode: "one-node-test-child-per-wave" },
    discoveredCount: discovered.length,
    executedCount: outcome.firstRound.passed + outcome.firstRound.failed + outcome.firstRound.missing + outcome.firstRound.crashed,
    executionWaves: outcome.waves,
    firstRound: outcome.firstRound,
    isolation: outcome.isolation,
    finalVerdict: outcome.finalVerdict,
    suiteError: outcome.suiteError,
    totalDurationMs: totalMs,
  };

  // 5) Write bounded aggregate report. Write/parse failure ⇒ non-zero.
  try { writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8"); }
  catch (err) {
    console.error(`[canonical] FATAL: cannot write report ${reportPath}: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  try { JSON.parse(readFileSync(reportPath, "utf8")); }
  catch (err) {
    console.error(`[canonical] FATAL: report failed to round-trip parse: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const { passed, failed, missing, crashed } = outcome.firstRound;
  console.error(`[canonical] verdict=${outcome.finalVerdict} discovered=${discovered.length} executed=${report.executedCount} passed=${passed} failed=${failed} missing=${missing} crashed=${crashed} isolation=${outcome.isolation.length} waves=${outcome.waves.length} total=${totalMs}ms ⇒ ${reportPath}`);
  process.exitCode = outcome.finalVerdict === "pass" ? 0 : 1;
}

// Invalid environment (manifest drift / unreadable / unparseable / bad wave plan):
// no tests run, write a minimal report, exit non-zero.
function failInvalidEnvironment(reportPath, message) {
  console.error(`[canonical] INVALID ENVIRONMENT (no tests run): ${message}`);
  const report = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    runner: { name: "canonical-test", node: process.version },
    finalVerdict: "environment_invalid",
    error: message,
  };
  try { writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8"); } catch { /* best effort */ }
  process.exitCode = 1;
}

// Run main() only when executed directly (not when imported by the meta-tests).
const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) main();
