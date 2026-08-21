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
//   - R8-3 runs/ hygiene, TWO layers (R8-C two-layer split, Owner-approved
//     2026-08-17). The invariant "tests must NEVER use the repo's real runs/
//     as their run-dir/cwd — every test owns a tmpdir run-dir" is a STATIC
//     property of the test sources, so the PRIMARY layer is a static scan:
//     test/isolation-infra/staticRunsGuard.test.js scans test/** sources for
//     constructions that point a run-dir/cwd at the repo-relative runs/
//     (repo-root-derived joins, bare relative runDir/cwd="runs", bare
//     --run-dir/--cwd "runs") under an explicit narrow whitelist.
//     The DYNAMIC snapshot guard below is the FALLBACK SECOND layer — the last
//     net for shapes the static scan cannot see (a test resolving runs/ through
//     indirection the scanner does not model). Before the first wave the runner
//     snapshots the ENTIRE REPO_ROOT/runs directory entry set — dot entries,
//     every suffix, subdirectory names, and one level of subdirectory contents
//     (a missing directory is the empty set); after every wave (and after the
//     isolation phase) it diffs. Any NEW entry is recorded with the wave/phase
//     that first saw it; if any addition exists at the end the runner prints an
//     explicit red light (entries + owning wave + "tests must not write the real
//     runs/ — use a tmpdir run-dir") and exits NON-ZERO even when every test
//     passed. The guard itself only ever readdir's runs/ — it never writes it.
//     Known boundaries (deliberate, all fail-visible only for what a sweep can
//     observe):
//       1. Time window (F-7-2 lesson): the guard observes only what exists AT
//          a sweep. A write fully absorbed WITHIN one wave (created and deleted
//          before the next sweep) is invisible; a grandchild that flushes a
//          transcript AFTER the final isolation sweep lands unobserved. The
//          guarantee is "survived across a sweep boundary ⇒ recorded", never
//          "every write leaves a trace".
//       2. Recursion depth: exactly ONE level of subdirectory contents is
//          snapshotted. A new file at depth ≥2 under a pre-existing
//          subdirectory escapes; every known writer (transcripts, .owner-*,
//          daemon*.json, .session-reuse/*, .lineage-reuse/*, workflow
//          subdirectories) is flat at depth 0/1, and a NEW subdirectory at any
//          observed level is itself an entry.
//       3. Concurrent NON-suite writers: while `npm test` runs in the MAIN
//          repo, any non-suite writer (an active daemon appending
//          daemon-health.json, an MCP dispatch, a manual `wao run`) adds a
//          top-level entry that trips the SAME red light with text that
//          wrongly blames "tests". The delivery worktree pipeline is immune
//          (a worktree has no runs/ ⇒ empty baseline). Heartbeat-gating the
//          red light (fresh `.owner-*` ⇒ external writer) was evaluated and
//          REJECTED: it covers only background-runner transcripts — daemon/
//          handshake/health files and foreground dispatches carry no owner
//          heartbeat, and a test writing both a transcript and a fixture
//          `.owner-*` would be misclassified as external, breaching exactly
//          the invariant the guard exists to enforce. A visible red that
//          needs human triage beats a leaky heuristic.
//       4. Two CONCURRENT `npm test` runs can trip each other's guards —
//          concurrent full-suite runs already destroy each other (worktrees,
//          ports, singleton arbiters), so a red light there is a feature, not
//          a false positive. The real-MCP canary (`npm run smoke`) does not go
//          through this runner and is unaffected.
//   - R22 W1 advisory inflight marker: a machine-global marker OUTSIDE every
//     repo checkout, located by src/machineGatePaths.js (%LOCALAPPDATA%\wao on
//     win32, ~/.wao-machine fallback — NEVER derived from TMP/TEMP/TMPDIR; NOT
//     a lock). A second concurrent full suite on this machine prints one
//     WARNING (results may be contaminated by resource contention — remedy:
//     sequential re-run), or a NOTICE downgrade when an existence probe
//     (kill(pid, 0)) provably shows the marker's pid is dead — a stale orphan.
//     It never blocks, never waits, and eats no budget. Deleted on every exit
//     path; a crashed run leaves an orphan whose only consequence is that
//     later runs print the same line.
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

// R23-F/A (TD-130): machine-global gate paths SSOT (scripts→src downward import,
// same direction as scripts/reliability/certification.mjs). The inflight marker's
// LOCATION lives there now (%LOCALAPPDATA%\wao / ~/.wao-machine, never derived
// from TMP/TEMP/TMPDIR — see that module's header for why); this module
// re-exports the constant + resolver below so its pinned public surface stays
// byte-stable for the meta-tests.
import { INFLIGHT_MARKER_FILENAME, inflightMarkerPath } from "../src/machineGatePaths.js";

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

// Advisory timing metadata (R23-F/A A3): a duration rides along with each file
// verdict but NEVER influences it. Only a finite non-negative number counts as
// measured; anything else maps to null — an honest "not measured", never a
// fabricated 0.
const nonNegativeMs = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

// Map a parsed reporter report to a rel→status map for the wave's expected files.
//   pass    — a suite exists with status "pass"
//   fail    — a suite exists with status "fail" (fail wins over pass)
//   missing — expected file with NO suite (did not report — crash/filter quirk)
// Alongside `perFile` this returns `perFileDurationMs`: the winning suite
// record's accumulated duration (test/reporter.mjs sums per-test durations into
// suite.duration) surfaced as advisory timing metadata. pass/fail ⇒ finite
// non-negative ms; missing/crash/invalid-duration ⇒ null. reportValid is false
// (and all files map to "crash" + null durations) when the report itself is
// missing/malformed/has an unrecognized suite status — that is a WAVE RUNNER
// failure, not per-file.
export function mapReportToFiles(report, expectedRels) {
  const crashAll = (reportError) => ({
    reportValid: false, reportError,
    perFile: new Map(expectedRels.map((r) => [r, "crash"])),
    perFileDurationMs: new Map(expectedRels.map((r) => [r, null])),
  });
  if (!report || typeof report !== "object") return crashAll("report missing or not an object");
  if (!Array.isArray(report.suites)) return crashAll("report has no 'suites' array");
  const perFile = new Map(expectedRels.map((r) => [r, "missing"]));
  const perFileDurationMs = new Map(expectedRels.map((r) => [r, null]));
  for (const suite of report.suites) {
    if (!suite || typeof suite.name !== "string") continue;
    // Accept ONLY the closed suite status set. Unknown / missing / non-string
    // status ⇒ the whole report is invalid (non-green), never a silent pass.
    const fileStatus = SUITE_STATUS_TO_FILE[suite.status];
    if (fileStatus === undefined) return crashAll(`suite '${suite.name}' has unrecognized status ${JSON.stringify(suite.status)}`);
    const rel = suiteRelToManifest(suite.name);
    if (!perFile.has(rel)) continue;
    const cur = perFile.get(rel);
    if (cur === "missing" || fileStatus === "fail") {
      perFile.set(rel, fileStatus); // fail wins; never downgrade
      perFileDurationMs.set(rel, nonNegativeMs(suite.duration)); // winner's timing rides along; pass never overwrites a fail's
    }
  }
  return { reportValid: true, reportError: null, perFile, perFileDurationMs };
}

// ── R8-3 layer 2: runs/ snapshot guard (pure logic, unit-tested in canonicalRunner.test.js) ──
//
// Suite-level hygiene FALLBACK (the primary layer is the static scan in
// test/isolation-infra/staticRunsGuard.test.js — see the header contract):
// tests must NEVER write into the repo's REAL runs/ transcript directory —
// every test owns its transcripts via a tmpdir run-dir. The guard snapshots
// the ENTIRE runs/ directory ENTRY SET before the suite starts (dot entries,
// every suffix, subdirectory names, plus ONE level of subdirectory contents —
// R8-C C-1: the old *.jsonl-top-level-only set let real writer shapes escape:
// `.owner-*` heartbeats, daemon.json/daemon-health.json/daemon-supervisor.json,
// `.session-reuse/`+`.lineage-reuse/` slots, workflow transcript subdirectories)
// and diffs after each wave; additions are attributed to the wave (or the
// isolation phase) that first observed them. All decision logic below is PURE
// over an injectable listDir (the meta-tests never touch a real runs/); the
// only real adapter is realListRunsDir, and NOTHING here ever writes runs/.

/**
 * Snapshot a runs directory listing into the guarded set: EVERY top-level
 * entry (dot entries, every suffix, subdirectory names) plus the entries of
 * each top-level subdirectory prefixed `<sub>/` (exactly ONE level of
 * recursion — see header boundary 2). Deduplicated and sorted. `listDir(sub)`
 * returns an array of entry descriptors — plain strings (never recursed) or
 * `{name, isDirectory}` objects — or null when that directory does not exist
 * (the normal pre-first-run state — treated as the EMPTY set, not an error;
 * a vanished subdirectory is likewise just "no entries", i.e. a deletion,
 * which the guard does not police).
 * @param {(sub?: string) => (string[]|{name:string,isDirectory:boolean}[]|null)} listDir
 * @returns {string[]}
 */
export function takeRunsSnapshot(listDir) {
  const entries = listDir("");
  if (!entries) return [];
  const out = new Set();
  for (const entry of entries) {
    if (typeof entry === "string") { out.add(entry); continue; }
    if (!entry || typeof entry.name !== "string") continue;
    out.add(entry.name);
    if (entry.isDirectory) {
      const sub = listDir(entry.name);
      if (!sub) continue; // vanished between listings ⇒ no entries (a deletion — not policed)
      for (const child of sub) {
        const childName = typeof child === "string" ? child : child?.name;
        if (typeof childName === "string") out.add(`${entry.name}/${childName}`);
      }
    }
  }
  return [...out].sort();
}

/**
 * Pure diff: entry names present in `current` but absent from `baseline`,
 * sorted. Deletions are NOT reported (the guard polices writes, not prunes).
 * @param {string[]} baseline
 * @param {string[]} current
 * @returns {string[]}
 */
export function addedRunsFiles(baseline, current) {
  const base = new Set(baseline);
  return current.filter((n) => !base.has(n)).sort();
}

/**
 * Stateful accumulator over the two pure functions above. `recordPhase(label)`
 * re-lists the directory and attributes every not-yet-recorded addition to
 * `label` (a wave name, or the "isolation" phase after the waves). An entry is
 * attributed exactly once — to the phase that FIRST saw it — even if it is
 * still present in later listings. `additions()` returns the cumulative
 * {file, phase} list, sorted by entry name.
 * @param {{listDir: (sub?: string) => (string[]|{name:string,isDirectory:boolean}[]|null)}} input
 */
export function createRunsDirGuard({ listDir }) {
  const baseline = takeRunsSnapshot(listDir);
  const recorded = new Map(); // file -> phase label
  const recordPhase = (phase) => {
    const fresh = [];
    for (const file of addedRunsFiles(baseline, takeRunsSnapshot(listDir))) {
      if (recorded.has(file)) continue;
      recorded.set(file, phase);
      fresh.push({ file, phase });
    }
    return fresh;
  };
  const additions = () => [...recorded.entries()]
    .map(([file, phase]) => ({ file, phase }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { baseline, recordPhase, additions };
}

// Real adapter: list REPO_ROOT/runs (one level deep). ENOENT ("not found") is
// the normal no-runs-yet state and maps to null (empty set) — for the top
// level AND for a subdirectory that vanished between the two listings. Any
// other read failure (EACCES/EPERM/EBUSY/ENOTDIR — runs existing as a FILE —
// ...) is rethrown so the guard fails OBSERVABLY (red, non-zero) instead of
// silently under-reporting what tests wrote.
//
// Cost (Windows): `readdirSync(path, {withFileTypes:true})` derives entry
// kinds from the directory enumeration itself (FindFirstFile/FindNextFile —
// no per-entry stat), so the guarded surface costs ONE readdir per sweep for
// the top level (the ~thousands-of-entries listing that already existed) plus
// ONE readdir per top-level subdirectory actually present (today:
// .session-reuse/ + .lineage-reuse/ — two extra enumerations per sweep).
export function realListRunsDir(runsDir) {
  const list = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
    } catch (err) {
      if (err && err.code === "ENOENT") return null;
      throw err;
    }
  };
  return (sub = "") => list(sub ? join(runsDir, sub) : runsDir);
}

// ── R8-C C-5: post-verdict exit decision (pure, unit-tested) ──────────────────
// main()'s two guard red-light branches had zero automated coverage ("verdict=
// pass cannot be pressed green" was human-evidence-only). The decision is
// extracted here so the precedence is pinned by unit tests:
//   report_write_failed  — the bounded report could not be written/round-tripped
//   guard_error          — the guard could not OBSERVE runs/ (fails closed)
//   runs_additions       — entries appeared in the REAL runs/ during the suite
//                          (non-green EVEN WHEN every test passed)
//   verdict              — the plain first-round verdict decides the exit code
// The three red kinds always yield exitCode 1; only `verdict` may yield 0.
export function finalRunnerOutcome({ verdict, runsAdditions, runsGuardError, reportWritten = true }) {
  if (!reportWritten) return { kind: "report_write_failed", exitCode: 1 };
  if (runsGuardError) return { kind: "guard_error", exitCode: 1 };
  if (runsAdditions.length > 0) return { kind: "runs_additions", exitCode: 1 };
  return { kind: "verdict", exitCode: verdict === "pass" ? 0 : 1 };
}

// ── R22 W1: advisory inflight marker (machine-global, NOT a lock) ────────────
// Two Lead sessions running the full suite on ONE machine shred each other
// (TD-130 isolation_pass family; 2026-08-19 并行实证：单日 5 文件 × 8 轮，两轮
// 走到 reject+前作集成，浪费验证预算). The marker is ADVISORY: it never blocks,
// never waits, and eats no budget — a second concurrent suite simply prints one
// WARNING line so the operator knows its results may be contaminated by
// resource contention (remedy: sequential re-run; see docs/troubleshooting.md
// §8 for the isolation_pass triage rule). Its LOCATION lives in
// src/machineGatePaths.js since R23-F/A (TD-130): %LOCALAPPDATA%\wao on win32
// with ~/.wao-machine as fallback — machine-global, OUTSIDE any repo, and never
// derived from TMP/TEMP/TMPDIR (the delivery harness injects a fresh per-attempt
// temp dir into exactly those variables, which had structurally blinded the old
// os.tmpdir() derivation; see that module's header). This module re-exports the
// SSOT's constant + resolver so the pinned public surface stays byte-stable.
// A crashed run leaves an orphan: since R23-F/A A2 an existence probe
// (killProbe, default process.kill(pid, 0)) distinguishes PROVABLY dead owners —
// those downgrade to a NOTICE (same pid/startedAt anchors, no WARNING) — while
// anything unprovable keeps the WARNING verbatim (fail-safe: no proof of death,
// no downgrade; no grace/reclaim semantics in either branch). None of this
// module executes when the meta-tests import the file: main() only runs under
// the invokedDirectly guard at the bottom.
export { INFLIGHT_MARKER_FILENAME, inflightMarkerPath };

/**
 * Pure decision core over injectable fs primitives (the meta-tests inject
 * fakes; realInflightAdapter is the only code that touches the real machine
 * state dir).
 *   begin() → "created"     — no marker existed; this invocation O_EXCL-claimed
 *                            it ({pid, startedAt}) and owns its deletion.
 *            "observed"    — a marker exists (live suite, crash orphan, or torn
 *                            write): exactly one line is printed — a WARNING
 *                            for anything alive-or-unproven, or (R23-F/A A2)
 *                            a NOTICE downgrade when killProbe PROVABLY shows
 *                            the owner dead. The marker is NOT ours either way —
 *                            a foreign marker must survive our exit (a running
 *                            suite still needs it; no grace/reclaim semantics).
 *            "unavailable" — the machine state dir could not be marked
 *                            (unwritable). Advisory: the suite runs unmarked,
 *                            never a failure.
 *   end()   — deletes the marker ONLY when this invocation created it; acts at
 *             most once; delete failures are silent (worst case = an orphan
 *             that only ever causes the same line on later runs).
 * @param {{readMarker: () => (string|null), createMarker: (text: string) => void, deleteMarker: () => void, warn?: (line: string) => void, killProbe?: (pid: number) => void, pid?: number, now?: () => string}} input
 */
export function createInflightMarker({ readMarker, createMarker, deleteMarker, warn = (line) => console.error(line), killProbe = (probePid) => process.kill(probePid, 0), pid = process.pid, now = () => new Date().toISOString() }) {
  let owned = false;
  const warnExisting = (text) => {
    // Best-effort parse: an orphan from a crashed run — or a torn/empty write —
    // still warns; the printed pid/startedAt just show what could be read.
    let info = {};
    try { info = JSON.parse(text) || {}; } catch { /* keep {} ⇒ "unknown" */ }
    const theirPid = Number.isFinite(info.pid) ? info.pid : "unknown";
    const theirTs = typeof info.startedAt === "string" && info.startedAt ? info.startedAt : "unknown";
    // R23-F/A A2: downgrade to NOTICE only on PROOF of death. The one accepted
    // proof is killProbe(pid, 0) throwing EXACTLY code "ESRCH" ("no such
    // process" — POSIX errno name; empirically the same code string on win32
    // libuv, verified 2026-08-21 against a freshly-exited child pid). A normal
    // return means alive; EPERM (exists but not ours) or any other error means
    // not proven; an unparsable pid means nothing to prove. All of those keep
    // the WARNING verbatim — fail-safe: no proof of death ⇒ no downgrade.
    if (theirPid !== "unknown") {
      let provablyDead = false;
      try { killProbe(theirPid); } catch (err) { provablyDead = !!err && err.code === "ESRCH"; }
      if (provablyDead) {
        warn(`[canonical] NOTICE: stale inflight marker — its suite (pid ${theirPid}, started at ${theirTs}) is gone (kill(pid,0) → ESRCH); continuing (advisory: nothing was blocked or deleted)`);
        return "observed";
      }
    }
    warn(`[canonical] WARNING: another full suite started at ${theirTs} (pid ${theirPid}) — results may be affected by resource contention`);
    return "observed";
  };
  const begin = () => {
    let existing = null;
    try { existing = readMarker(); } catch { existing = null; } // unreadable ≈ absent (advisory)
    if (typeof existing === "string") return warnExisting(existing);
    try {
      createMarker(JSON.stringify({ pid, startedAt: now() }) + "\n");
      owned = true;
      return "created";
    } catch {
      // Lost the O_EXCL race (another suite claimed the marker between our read
      // and our create) — or the state dir is unwritable. Re-read once: a marker
      // that appeared means we raced a real suite; warn like any observer.
      let raced = null;
      try { raced = readMarker(); } catch { raced = null; }
      if (typeof raced === "string") return warnExisting(raced);
      return "unavailable";
    }
  };
  const end = () => {
    if (!owned) return false;
    owned = false;
    try { deleteMarker(); return true; } catch { return false; } // silent: worst case an orphan (WARNING if pid alive/unknown, NOTICE if provably dead — R23-F/A)
  };
  return { begin, end };
}

// Real adapter: the machine-global marker under the WAO machine state dir
// (%LOCALAPPDATA%\wao on win32, ~/.wao-machine fallback — the resolver is
// re-exported verbatim from src/machineGatePaths.js since R23-F/A; deliberately
// NOT under any repo checkout, NEVER derived from TMP/TEMP/TMPDIR). ENOENT on
// read maps to null (the normal no-suite state); any other error propagates to
// the pure core, whose advisory discipline (catch-all, degrade — never block,
// never crash the suite) is the OPPOSITE of the runs-guard's fail-closed: this
// feature must not add any new failure surface. "wx" = O_EXCL: the create is an
// atomic claim.
export function realInflightAdapter(markerPath = inflightMarkerPath()) {
  return {
    readMarker: () => {
      try { return readFileSync(markerPath, "utf8"); }
      catch (err) { if (err && err.code === "ENOENT") return null; throw err; }
    },
    createMarker: (text) => writeFileSync(markerPath, text, { flag: "wx" }),
    deleteMarker: () => unlinkSync(markerPath),
  };
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
      results: files.map((f) => ({ path: f.path, status: "crash", resourceCategory: f.resourceCategory, executionWave: name, durationMs: null })),
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
      results: files.map((f) => ({ path: f.path, status: "crash", resourceCategory: f.resourceCategory, executionWave: name, durationMs: null })),
    };
  }

  const report = await readReport();
  const { reportValid, reportError, perFile, perFileDurationMs } = mapReportToFiles(report, expectedRels);
  // durationMs rides along per file (R23-F/A A3): advisory timing metadata —
  // pass/fail ⇒ finite non-negative ms, missing/crash ⇒ null. Never verdict-
  // affecting.
  const results = files.map((f) => ({ path: f.path, status: perFile.get(f.path) || "missing", resourceCategory: f.resourceCategory, executionWave: name, durationMs: perFileDurationMs.get(f.path) ?? null }));

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
      files: w.results.map((r) => ({ path: r.path, status: r.status, resourceCategory: r.resourceCategory, executionWave: r.executionWave, durationMs: r.durationMs ?? null })),
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

// ── main(): advisory inflight marker, then load manifest, validate, run, report.
async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..");
  const testDir = join(repoRoot, "test");
  const manifestPath = join(testDir, "manifest.json");
  const reportPath = join(repoRoot, "test-results.json");
  const nodeExe = process.execPath;

  const childEnv = { ...process.env, WAO_SKIP_VERSION_GUARD: "1" };

  // 0) R22 W1 advisory inflight marker (machine-global, NOT a lock): claim it
  //    before anything runs — in particular before the runs-guard baseline
  //    snapshot inside runSuite — so a concurrently-starting full suite sees
  //    us; and if one is already mid-run, print one WARNING-or-NOTICE (advisory only:
  //    never blocks, never waits, eats no budget). Deleted on EVERY exit path
  //    (finally) when this invocation owns it.
  const inflight = createInflightMarker(realInflightAdapter());
  inflight.begin();
  try {
    await runSuite({ repoRoot, testDir, manifestPath, reportPath, nodeExe, childEnv });
  } finally {
    inflight.end();
  }
}

// The suite proper (steps 1-5). Extracted from main() so the inflight marker's
// finally covers every return path below without re-indenting the whole body.
async function runSuite({ repoRoot, testDir, manifestPath, reportPath, nodeExe, childEnv }) {
  const reporterArg = "./test/reporter.mjs";

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
  // 4b) R8-3 layer-2 runs/ snapshot guard: baseline BEFORE the first wave.
  //     R8-C C-4: the baseline construction itself is fail-closed — a runs/
  //     that cannot be snapshotted (EACCES/EPERM, or runs existing as a FILE
  //     ⇒ ENOTDIR from readdirSync) must NOT escape as an uncaught throw that
  //     leaves the PREVIOUS run's possibly-green test-results.json on disk for
  //     a later consumer to misread. Route it through the same
  //     invalid-environment path as manifest drift: zero tests run, the stale
  //     report is overwritten by a minimal environment_invalid one, exit 1.
  let runsGuard = null;
  try {
    runsGuard = createRunsDirGuard({ listDir: realListRunsDir(join(repoRoot, "runs")) });
  } catch (err) {
    return failInvalidEnvironment(reportPath, `cannot snapshot runs/ guard baseline (${join(repoRoot, "runs")}): ${err && err.message ? err.message : String(err)}`);
  }
  //     recordPhase failures (non-ENOENT read errors DURING the suite) fail
  //     the guard CLOSED — logged as a guard error and folded into the
  //     non-zero exit by finalRunnerOutcome, never swallowed.
  let runsGuardError = null;
  const guardRecord = (phase) => {
    if (runsGuardError) return [];
    try {
      return runsGuard.recordPhase(phase);
    } catch (err) {
      runsGuardError = err && err.message ? err.message : String(err);
      return [];
    }
  };
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
      const fresh = guardRecord(w.name);
      if (fresh.length > 0) {
        console.error(`[canonical] runs-guard wave=${w.name} NEW runs/ entries: ${fresh.map((f) => f.file).join(", ")}`);
      }
    },
  });
  const totalMs = Date.now() - t0;

  for (const iso of outcome.isolation) {
    console.error(`[canonical] isolation ${iso.path} [${iso.resourceCategory}/${iso.executionWave}] firstRound=${iso.firstRoundStatus} alone=${iso.isolationStatus} ⇒ ${iso.classification}`);
  }
  // Isolation rechecks spawn children OUTSIDE any wave — sweep them too so a
  // leak during a diagnostic rerun is caught and attributed to this phase.
  const isoFresh = guardRecord("isolation");
  if (isoFresh.length > 0) {
    console.error(`[canonical] runs-guard phase=isolation NEW runs/ entries: ${isoFresh.map((f) => f.file).join(", ")}`);
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
    // R8-3: additive field — every entry that appeared in the REAL runs/
    // during the suite (any name/shape — transcripts, dot entries, state
    // files, subdirectory slots), with the wave/phase that first saw it.
    // Empty on a clean run; non-empty ALWAYS pairs with a non-zero exit below.
    runsDirGuard: { additions: runsGuard.additions(), error: runsGuardError },
    totalDurationMs: totalMs,
  };

  // 5) Write bounded aggregate report. Write/parse failure ⇒ non-zero via
  //    finalRunnerOutcome (report_write_failed). The stale-report-on-disk risk
  //    is bounded: this run exits red either way.
  let reportWritten = true;
  try { writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8"); }
  catch (err) {
    reportWritten = false;
    console.error(`[canonical] FATAL: cannot write report ${reportPath}: ${err.message}`);
  }
  if (reportWritten) {
    try { JSON.parse(readFileSync(reportPath, "utf8")); }
    catch (err) {
      reportWritten = false;
      console.error(`[canonical] FATAL: report failed to round-trip parse: ${err.message}`);
    }
  }

  const { passed, failed, missing, crashed } = outcome.firstRound;
  const runsAdditions = runsGuard.additions();
  // R8-C C-5: the exit decision is the pinned pure function — precedence
  // report_write_failed > guard_error > runs_additions > verdict.
  const final = finalRunnerOutcome({ verdict: outcome.finalVerdict, runsAdditions, runsGuardError, reportWritten });
  console.error(`[canonical] verdict=${outcome.finalVerdict} discovered=${discovered.length} executed=${report.executedCount} passed=${passed} failed=${failed} missing=${missing} crashed=${crashed} isolation=${outcome.isolation.length} waves=${outcome.waves.length} runsGuard=${runsAdditions.length === 0 && !runsGuardError ? "clean" : `RED(+${runsAdditions.length})`} total=${totalMs}ms ⇒ ${reportPath}`);

  // R8-3 red lights: tests writing the REAL runs/ is a suite-hygiene violation
  // that must not survive a green test verdict (non-zero exit even when every
  // test passed), and a guard READ error fails closed (observable, never
  // silently under-reported). Boundary note (header 3): while the suite runs
  // in the MAIN repo, a NON-suite writer (daemon/MCP dispatch/manual wao run)
  // trips this same light with text that blames "tests" — the delivery
  // worktree pipeline (no runs/ ⇒ empty baseline) is immune.
  if (final.kind === "guard_error") {
    console.error(`[canonical] RED runs-guard: cannot list runs/ (${runsGuardError}) — failing closed rather than under-reporting`);
  }
  if (final.kind === "runs_additions") {
    console.error(`[canonical] RED runs-guard: ${runsAdditions.length} new entr${runsAdditions.length === 1 ? "y" : "ies"} in the REAL runs/ directory during the suite:`);
    for (const a of runsAdditions) {
      console.error(`  - runs/${a.file} (first seen: ${a.phase})`);
    }
    console.error("  测试不得向真实 runs/ 写入——测试必须用 tmpdir 作为自己的 run-dir/工作目录（写死仓库 runs/ 即违规）。");
  }
  process.exitCode = final.exitCode;
}

// Invalid environment (manifest drift / unreadable / unparseable / bad wave
// plan / unsnapshot-able runs/ guard baseline): no tests run, OVERWRITE any
// stale report on disk with a minimal environment_invalid one (so a leftover
// green test-results.json can never be misread as this run's result), exit
// non-zero.
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
