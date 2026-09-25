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
//       node --test --test-concurrency=<wave limit> --test-timeout=<per-test cap>
//                --test-reporter ./test/reporter.mjs <files...>
//     Node runs that wave's files (in-process, default isolation) and the custom
//     structured reporter (test/reporter.mjs) writes a structured test-results.json.
//     After each child closes the runner reads+validates that JSON immediately and
//     maps reporter suites to the manifest's expected files (NO human TAP/spec
//     text, NO regex classification). The next wave then overwrites the
//     intermediate report; the bounded aggregate is written at the end.
//   - Runs EVERY wave to completion before summarizing (no early abort — the
//     ONE deliberate exception is TD-165 R2.4: a watchdog kill whose cleanup
//     could NOT be confirmed stops every later wave; suspected residue must
//     never be carried forward into more spawns).
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
//   - TD-165 hang watchdogs, THREE layers (before this, a hung test file could
//     stall a wave FOREVER: both child adapters only awaited `close`, and
//     nothing anywhere owned a timer):
//       R1 per-test timeout (main line of defense) — every `node --test` child
//          argv (wave first-round AND per-file isolation recheck) carries
//          --test-timeout=<TEST_TIMEOUT_MS>. Node enforces it at the FILE
//          level from its OWN parent process, so even a synchronous
//          `while (true)` body (child event loop blocked) is collected.
//       R2 wave watchdog (backstop) — a wall-clock timer per spawned child; on
//          expiry it kills EXACTLY that child's process tree
//          (taskkill /PID <its own pid> /T /F — never a global node.exe hunt),
//          confirms death via kill(pid, 0) → ESRCH probes (3 × 500ms), records
//          the wave's files as crash with crashReason "watchdog_timeout" and a
//          groupError naming the wave + elapsed ms. An UNCONFIRMED kill writes
//          "cleanup unconfirmed", starts NO further waves, and forces
//          verdict=fail. A watchdog-killed ISOLATION rerun classifies
//          stable_fail (the file hangs ALONE = a true test hang), NOT
//          environment_invalid. Fix round (TD-165 audit): the killTree call is
//          deadline-raced (KILL_TREE_DEADLINE_MS — a kill that never returns
//          must not stall the probe loop; the probes alone decide liveness);
//          an UNCONFIRMED outcome also detaches the still-alive child's pipe
//          handles (destroy + unref) before the adapter resolves, and runSuite
//          force-exits non-zero AFTER the report is written — pipe handles of
//          unconfirmed residue must never block the runner's own exit. The
//          isolation entries carry the isolator's watchdog record verbatim
//          (pid/confirmed/probes…), and the suiteAborted stderr line + report
//          name the abort ORIGIN (wave leg vs isolation leg).
//       R3 slow-wave alarm (pure read) — one informational stderr NOTICE per
//          elapsed alarm period; never kills, never touches the verdict.
//     All budgets and kill/probe seams are injectable; the meta-tests inject
//     small values (1-5s) and NEVER the production defaults.
//   - Writes a bounded test-results.json that keeps every failure attributable to
//     BOTH its resource category AND its execution wave: each file records
//     resourceCategory + executionWave; each wave records timing/counts/exit.
//     TD-181 (a, 2026-09-25): every non-pass firstRound.failures[] entry ALSO
//     retains the wave's own bounded failure content (failing sub-test names,
//     assertion/error text, stacks — explicit truncation markers; collection
//     failures recorded as unknown, never green), and each wave carries an
//     advisory `observation` annotation (start time / concurrency / gate /
//     concurrent-suite marker / node-process count with sampling time).
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

// R23-F/B Round B (TD-130): the machine-level verification lease gate. main()
// wraps ONE canonical invocation (the same granularity as a verifyDelivery
// command sequence) in acquire → suite → release; wave children see
// WAO_VERIFICATION_GATE_HELD=1 via buildCanonicalChildEnv and skip claiming.
// Kill switch (WAO_VERIFICATION_GATE=off) is judged here by gateDisabled().
import {
  VERIFICATION_GATE_HELD_ENV,
  createVerificationGate,
  gateEngaged,
} from "../src/verificationGate.js";

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

// ── TD-165: hang-watchdog budgets (all three injectable; never hardcode) ─────
// R1 per-test timeout, passed as --test-timeout on every `node --test` child
// (wave first-round AND isolation recheck). Node enforces it per test at the
// FILE level from its own parent process (verified 2026-09-19, Node v22.23.1:
// a synchronous `while (true)` body is collected even with the child's event
// loop blocked).
//
// Derivation — RE-DERIVED 2026-09-21 (TD-173). The original basis was falsified
// by measurement, not by preference; the constant's own stated purpose is that
// "a legal slow test is never falsely killed", and that purpose was being
// violated:
//   - original basis (2026-09-19): slowest single file deliveryVerification
//     .test.js = 133s; filesystem WAVE peak = 207s (54 files @ concurrency 16)
//     ⇒ 600s ≈ 3-4.5x headroom.
//   - measured 2026-09-21 (test-results.json, idle machine, commit 2c39093):
//     the SAME file is 253s alone and ~598s INSIDE the wave; the filesystem wave
//     is 70 files @ 16 with a capacity floor of 474s and a wall clock of 606s —
//     i.e. the in-wave peak now EQUALS the old 600s cap, so legal slow tests in
//     the wave tail were killed by R1 and reported as failures while every one
//     of them was classified isolation_pass (they pass when run alone).
//   - new value = ~2x the measured in-wave peak (606s; the passing run's own
//     report shows deliveryVerification.test.js at 752724ms) and ~4.7x the
//     measured alone peak (253s).
//   - WHAT THIS DOES AND DOES NOT CHANGE (audit correction, 2026-09-21): it
//     changes only the TIME BOUNDARY. Functional assertions, required file
//     coverage, and the fail/missing/crash verdict rules are untouched, and a
//     first-round failure is never washed green by an isolation re-run (see the
//     isolation-pass handling below). So this is NOT "stricter verification" —
//     it removes a boundary that sat below the suite's legitimate need. The cost
//     is real and must be stated: hang-detection latency doubles, bounded as
//     before by R2.
//   - Re-derive again from fresh measurement whenever the wave composition or
//     the machine changes; never tighten below the measured in-wave peak.
export const TEST_TIMEOUT_MS = 1200000;

// R2 wave watchdog (wall-clock backstop per spawned child). Derivation: 1.5x the
// per-test cap (the original ratio, 900s/600s) — strictly greater than the
// per-test cap plus intra-wave queueing margin, so the backstop fires only when
// R1 could not collect the hang itself. Re-derived together with R1 (TD-173).
export const WAVE_WATCHDOG_MS = 1800000;

// R3 slow-wave alarm (informational only): must sit between a healthy wave's
// completion and the watchdog — early enough to flag a stall in the operator's
// terminal, late enough to stay quiet on every legal wave. Re-derived with R1
// (TD-173): a healthy filesystem wave now measures ~606s, so the old 300s alarm
// fired on every legal run and had lost its signal value.
export const WAVE_ALARM_MS = 900000;

// Fix round (TD-165 audit, residual must-fix): the watchdog's killTreeFn call
// is raced against this deadline. An injected implementation (or a taskkill
// pathology) that never returns must not turn the watchdog itself into an
// unbounded wait — on expiry the wait is abandoned and the probe loop runs
// anyway (the probes alone decide liveness/death; they never depended on the
// kill's return value).
export const KILL_TREE_DEADLINE_MS = 10000;

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
// TD-165 R5: an isolation rerun killed by the wave watchdog
// (crashReason "watchdog_timeout") means the file hangs ALONE — a TRUE test
// hang, not a broken environment — so it classifies stable_fail like any
// honest re-failure. An UNATTRIBUTED crash keeps the original
// environment_invalid semantics (spawn-level failure ⇒ suspect environment).
export function classifyIsolation(firstRoundStatus, isolationStatus, isolationCrashReason = null) {
  if (firstRoundStatus === "pass") return "not_rechecked";
  if (isolationStatus === "pass") return "isolation_pass";
  if (isolationStatus === "crash") {
    if (isolationCrashReason === "watchdog_timeout") return "stable_fail";
    return "environment_invalid";
  }
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

// ── TD-181 (a): first-round failure-detail retention (bounded, additive) ─────
// The wave child's structured report carries the ONLY copy of a first-round
// failure's content (failing sub-test names, assertion/error text, stacks).
// runWave() reads it but the aggregate used to keep only per-file STATUS, and
// isolationTail comes from the RERUN — it can never reconstruct what the FIRST
// round printed. These helpers retain a BOUNDED copy of that content for every
// non-pass file, with explicit truncation markers; any collection failure is
// recorded honestly as { status: "unknown", reason } — an observation failure
// must never manufacture a green (or a fabricated detail).
export const FAILURE_DETAIL_TEST_CAP = 5;   // max failing sub-tests kept per file
export const FAILURE_DETAIL_TEXT_CAP = 1000; // max chars per retained string field
export const FAILURE_DETAIL_CHAR_BUDGET = 8000; // max serialized chars per file

export function unknownFailureDetail(reason) {
  return { status: "unknown", reason: String(reason) };
}

// Bounded string: null for non-strings; over-cap strings are cut with an
// EXPLICIT truncation marker carrying the shown/total counts.
export function boundDetailString(value, cap = FAILURE_DETAIL_TEXT_CAP) {
  if (typeof value !== "string") return null;
  if (value.length <= cap) return value;
  return value.slice(0, cap) + `…[TRUNCATED: first ${cap} of ${value.length} chars]`;
}

// Stale-report residue detection (shape 5 of the TD-181 collection contract).
// The reporter stamps report.timestamp at flush time; a report that predates
// the wave's own start can only be residue (a skipped/failed pre-spawn delete,
// a leftover from an earlier run) — its content is NOT this wave's and must
// never be read as this wave's result (including as a green). Only a parseable
// timestamp that provably precedes the wave start flags stale; a missing or
// unparseable timestamp keeps the existing validation semantics untouched.
export function staleReportInfo(report, waveStartMs) {
  if (!report || typeof report !== "object") return { stale: false };
  const ts = report.timestamp;
  if (typeof ts !== "string" || !ts) return { stale: false };
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return { stale: false };
  if (t < waveStartMs) return { stale: true, timestamp: ts };
  return { stale: false };
}

// Extract the bounded first-round failure detail for ONE file from a VALID
// wave report. Defensive by contract: any surprise (missing suite, weird
// shapes, a throw) degrades to { status: "unknown", reason } — never a crash,
// never a fabricated pass. fail-status suites win over pass duplicates,
// mirroring mapReportToFiles.
export function firstRoundFailureDetail(report, rel) {
  try {
    let suite = null;
    const suites = report && Array.isArray(report.suites) ? report.suites : [];
    for (const s of suites) {
      if (!s || typeof s.name !== "string") continue;
      if (suiteRelToManifest(s.name) !== rel) continue;
      if (!suite || s.status === "fail") suite = s;
    }
    if (!suite) return unknownFailureDetail("no suite for this file in the wave report");
    if (suite.status !== "fail") return unknownFailureDetail(`suite status '${suite.status}' — no failure content to retain`);
    const allFailing = (Array.isArray(suite.tests) ? suite.tests : [])
      .filter((t) => t && typeof t === "object" && t.status === "fail");
    const detail = {
      status: "collected",
      source: "firstRoundWaveReport",
      failingTestsTotal: allFailing.length,
      failingTestsDropped: Math.max(0, allFailing.length - FAILURE_DETAIL_TEST_CAP),
      failingTests: [],
      fileFailure: null,
    };
    for (const t of allFailing.slice(0, FAILURE_DETAIL_TEST_CAP)) {
      const e = t.error && typeof t.error === "object" ? t.error : {};
      detail.failingTests.push({
        name: boundDetailString(t.name) ?? "(test name unavailable)",
        operator: boundDetailString(e.operator),
        expected: boundDetailString(e.expected),
        actual: boundDetailString(e.actual),
        diff: boundDetailString(e.diff),
        stack: boundDetailString(e.stack),
      });
    }
    if (suite.fileFailure && typeof suite.fileFailure === "object") {
      detail.fileFailure = {
        message: boundDetailString(suite.fileFailure.message) ?? "(no message)",
        stack: boundDetailString(suite.fileFailure.stack),
      };
    }
    // Per-file char budget: drop trailing failing tests (counted as dropped)
    // until the serialized detail fits; one capped test always fits by
    // construction (6 fields × (cap + marker) < budget).
    while (detail.failingTests.length > 1 && JSON.stringify(detail).length > FAILURE_DETAIL_CHAR_BUDGET) {
      detail.failingTests.pop();
      detail.failingTestsDropped += 1;
    }
    return detail;
  } catch (err) {
    return unknownFailureDetail(`collection error: ${err && err.message ? err.message : String(err)}`);
  }
}

// ── TD-181 (a): per-wave SECONDARY observations (advisory annotations) ───────
// One bounded annotation per wave: start time, the wave's configured
// concurrency, the machine verification-gate state, the advisory inflight
// marker (another full suite), and a node-process count WITH its sampling
// timestamp. Every observation is advisory — it NEVER influences the verdict —
// and every collection failure (or unwired observer) is recorded as an honest
// unknown, mirroring the failure-detail discipline. These live in their own
// report field so they can never crowd out first-round failure content.
export async function collectWaveObservation(spec, observers) {
  const startedAt = new Date().toISOString();
  const obs = observers && typeof observers === "object" ? observers : {};
  const wrap = async (label, fn) => {
    if (typeof fn !== "function") return { state: "unknown", reason: `${label} observer not provided` };
    try {
      const v = await fn(spec);
      return v ?? { state: "unknown", reason: `${label} observer returned nothing` };
    } catch (err) {
      return { state: "unknown", reason: `${label} observer failed: ${err && err.message ? err.message : String(err)}` };
    }
  };
  let nodeProcessCount = { count: null, sampledAt: startedAt, reason: "nodeProcessCount observer not provided" };
  if (typeof obs.nodeProcessCount === "function") {
    try {
      const v = await obs.nodeProcessCount(spec);
      nodeProcessCount = v && Number.isFinite(v.count)
        ? { count: v.count, sampledAt: typeof v.sampledAt === "string" && v.sampledAt ? v.sampledAt : startedAt }
        : { count: null, sampledAt: startedAt, reason: v && v.reason ? String(v.reason) : "observer returned no count" };
    } catch (err) {
      nodeProcessCount = { count: null, sampledAt: startedAt, reason: `nodeProcessCount observer failed: ${err && err.message ? err.message : String(err)}` };
    }
  }
  return {
    startedAt,
    waveConcurrency: spec && Number.isInteger(spec.concurrency) ? spec.concurrency : null,
    advisory: true, // annotations only — never verdict-affecting
    verificationGate: await wrap("verificationGate", obs.verificationGate),
    concurrentFullSuite: await wrap("concurrentFullSuite", obs.concurrentFullSuite),
    nodeProcessCount,
  };
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
// TD-165 R1: the child argv carries --test-timeout (per-test cap, Node enforces
// it at the file level from its own parent). TD-165 R2: when the runChild result
// reports a fired watchdog, the wave is terminal — the (already-deleted) report
// is NOT read; every file records crash with crashReason "watchdog_timeout" and
// a groupError naming the wave + elapsed ms + cleanup status. abortSuite=true
// (cleanup unconfirmed) tells runCanonical to start NO further waves.
//
// A wave pools files from one OR MORE resource categories; each file carries its
// resourceCategory so failures stay attributable to category AND wave. `files` =
// [{ path, resourceCategory }].
export async function runWave({ name, files, concurrency, reporterArg, runChild, readReport, deleteReport, testTimeoutMs = TEST_TIMEOUT_MS }) {
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
    const reason = `delete report failed: ${err && err.message ? err.message : String(err)}`;
    return {
      name, durationMs: Date.now() - start, exitCode: null,
      groupError: reason,
      results: files.map((f) => ({ path: f.path, status: "crash", resourceCategory: f.resourceCategory, executionWave: name, durationMs: null, failureDetail: unknownFailureDetail(reason) })),
    };
  }

  const argv = [
    "--test",
    `--test-concurrency=${concurrency}`,
    `--test-timeout=${testTimeoutMs}`, // TD-165 R1: per-test cap, enforced by Node at the file level
    "--test-reporter", reporterArg,
    ...expectedRels.map((rel) => "test/" + rel),
  ];

  let child;
  try {
    // waveName rides the second argument so the adapter's alarm lines (R3) can
    // name the wave; existing injected fakes ignore it.
    child = await runChild(argv, { waveName: name });
  } catch (err) {
    const reason = `spawn error: ${err && err.message ? err.message : String(err)}`;
    return {
      name, durationMs: Date.now() - start, exitCode: null,
      groupError: reason,
      results: files.map((f) => ({ path: f.path, status: "crash", resourceCategory: f.resourceCategory, executionWave: name, durationMs: null, failureDetail: unknownFailureDetail(reason) })),
    };
  }

  // TD-165 R2: the wave-level watchdog killed the child — terminal for the
  // whole wave. The report was deleted pre-spawn and cannot be trusted now, so
  // the files are recorded crash with the watchdog attribution directly and
  // the readReport/map path below is skipped entirely.
  if (child.watchdog && child.watchdog.fired) {
    const { confirmed, elapsedMs, probes, pid, limitMs } = child.watchdog;
    const groupError = confirmed
      ? `wave '${name}' ran ${elapsedMs}ms (wall-clock limit ${limitMs}ms) — watchdog backstop fired; killed child pid ${pid} via taskkill /PID ${pid} /T /F; cleanup confirmed (kill(pid,0) → ESRCH after ${probes} probe(s))`
      : `wave '${name}' ran ${elapsedMs}ms (wall-clock limit ${limitMs}ms) — watchdog backstop fired; cleanup unconfirmed (pid ${pid} still alive after taskkill + ${probes} probe(s)); subsequent waves will NOT start`;
    return {
      name, durationMs: Date.now() - start, exitCode: child.exitCode ?? null, groupError,
      results: files.map((f) => ({ path: f.path, status: "crash", crashReason: "watchdog_timeout", resourceCategory: f.resourceCategory, executionWave: name, durationMs: null, failureDetail: unknownFailureDetail("watchdog_timeout — wave killed by the backstop; no first-round report content can be trusted") })),
      watchdog: child.watchdog,
      childStderr: child.stderr, childStdout: child.stdout,
      abortSuite: !confirmed,
    };
  }

  // TD-181 (a) shape "collection error": a readReport that THROWS is a failed
  // observation, not a silent zero-failure success. The wave fails CLOSED
  // (every file crash + groupError; later waves still run) and the detail is
  // an honest unknown — an observation failure must never manufacture green.
  let report;
  try {
    report = await readReport();
  } catch (err) {
    const reason = `read report failed: ${err && err.message ? err.message : String(err)}`;
    return {
      name, durationMs: Date.now() - start, exitCode: child.exitCode ?? null,
      groupError: reason,
      results: files.map((f) => ({ path: f.path, status: "crash", resourceCategory: f.resourceCategory, executionWave: name, durationMs: null, failureDetail: unknownFailureDetail(reason) })),
      childStderr: child.stderr, childStdout: child.stdout,
    };
  }

  // TD-181 (a) shape "stale report residue": a report whose flush timestamp
  // provably predates this wave's start is residue, never this wave's result —
  // not even when its suites claim the expected files pass.
  const stale = staleReportInfo(report, start);
  const { reportValid, reportError, perFile, perFileDurationMs } = stale.stale
    ? {
        reportValid: false,
        reportError: `stale report residue: report timestamp ${stale.timestamp} predates wave start (${new Date(start).toISOString()}) — content is not from this wave`,
        perFile: new Map(expectedRels.map((r) => [r, "crash"])),
        perFileDurationMs: new Map(expectedRels.map((r) => [r, null])),
      }
    : mapReportToFiles(report, expectedRels);
  // durationMs rides along per file (R23-F/A A3): advisory timing metadata —
  // pass/fail ⇒ finite non-negative ms, missing/crash ⇒ null. Never verdict-
  // affecting. TD-181 (a): every NON-PASS file also carries its bounded
  // first-round failure detail (collected from THIS wave's report, or an
  // honest unknown when the report is missing/malformed/stale).
  const results = files.map((f) => {
    const status = perFile.get(f.path) || "missing";
    const r = { path: f.path, status, resourceCategory: f.resourceCategory, executionWave: name, durationMs: perFileDurationMs.get(f.path) ?? null };
    if (status !== "pass") {
      r.failureDetail = reportValid ? firstRoundFailureDetail(report, f.path) : unknownFailureDetail(reportError);
    }
    return r;
  });

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
// TD-165 R2.4: the ONE no-early-abort exception — when a wave dies to the
// watchdog and cleanup is UNCONFIRMED (possible residue), later waves are NOT
// started and isolation reruns are skipped; the verdict is fail either way.
export async function runCanonical({ waveSpecs, reporterArg, runChild, readReport, deleteReport, isolator, onWaveStart, onWaveEnd, testTimeoutMs = TEST_TIMEOUT_MS, observers = null }) {
  const wavesReport = [];
  const firstRound = [];
  let suiteError = false;
  let suiteAborted = false;
  // TD-165 F6: which leg stopped the suite — "wave" (a wave's watchdog kill was
  // unconfirmed ⇒ later waves never started) or "isolation" (a rerun's kill was
  // unconfirmed ⇒ no further reruns; first-round waves already completed).
  let abortOrigin = null;
  for (const spec of waveSpecs) {
    // TD-181 (a): advisory per-wave secondary observation — collected BEFORE
    // the wave runs; every failure inside it degrades to unknown and none of
    // it can affect the verdict (injectable seam; production wires
    // realWaveObservers in runSuite).
    const observation = await collectWaveObservation(spec, observers);
    if (onWaveStart) onWaveStart(spec);
    const w = await runWave({ name: spec.name, files: spec.files, concurrency: spec.concurrency, reporterArg, runChild, readReport, deleteReport, testTimeoutMs });
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
      // TD-181 (a): advisory annotations (startedAt / concurrency / gate /
      // concurrent-suite marker / node-process count with sampling time).
      // Additive; never verdict-affecting; separate from failure content.
      observation,
      // TD-165 R2: wave-level watchdog record (null when it never fired) —
      // fired/confirmed/elapsedMs/probes/pid for triage; verdict-relevant parts
      // already surface via groupError + per-file crashReason.
      watchdog: w.watchdog ?? null,
      files: w.results.map((r) => ({ path: r.path, status: r.status, resourceCategory: r.resourceCategory, executionWave: r.executionWave, durationMs: r.durationMs ?? null })),
    };
    wavesReport.push(wave);
    if (onWaveEnd) onWaveEnd(wave);
    if (w.abortSuite) {
      suiteAborted = true;
      abortOrigin = "wave";
      break; // R2.4: residue suspected — no further wave may spawn
    }
  }

  const failures = firstRound.filter((r) => r.status !== "pass");
  const isolation = [];
  if (isolator && !suiteAborted) {
    for (const f of failures) {
      const iso = await isolator({ file: f.path });
      isolation.push({
        path: f.path,
        resourceCategory: f.resourceCategory,
        executionWave: f.executionWave,
        firstRoundStatus: f.status,
        isolationStatus: iso.status,
        isolationExitCode: iso.exitCode ?? null,
        // TD-165 R5: a watchdog-killed rerun (crashReason watchdog_timeout)
        // classifies stable_fail — see classifyIsolation.
        crashReason: iso.crashReason ?? null,
        // B5 (R23/F/A follow-up): realIsolator already measures durationMs —
        // carry it into the bounded report instead of dropping it. Absent or
        // non-finite normalizes to null (never fabricated 0).
        isolationDurationMs: nonNegativeMs(iso.durationMs),
        classification: classifyIsolation(f.status, iso.status, iso.crashReason ?? null),
        isolationTail: iso.tail,
        // TD-165 F6: the isolator's watchdog record rides into the bounded
        // report verbatim (fired/confirmed/elapsedMs/probes/pid/limitMs) —
        // "the report carries the pid" must hold for BOTH legs, not only the
        // wave leg.
        watchdog: iso.watchdog ?? null,
      });
      // R2.4, isolation leg: an UNCONFIRMED watchdog kill during a rerun is the
      // same residue signal as in a wave — spawn no further isolation children.
      // (The verdict is already fail — the first-round failure is why this
      // rerun exists at all; isolation can never wash it green.)
      if (iso.watchdog && iso.watchdog.fired && !iso.watchdog.confirmed) {
        suiteAborted = true;
        abortOrigin = "isolation";
        break;
      }
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
      // TD-181 (a): every first-round failure carries the bounded content of
      // WHAT failed in the wave (sub-test names, assertion/error text, stacks
      // — with explicit truncation markers), or an honest unknown when it could
      // not be collected. Isolation reruns append a classification; they can
      // never replace this first-round content nor wash the verdict green.
      failures: failures.map((r) => ({ path: r.path, status: r.status, crashReason: r.crashReason ?? null, failureDetail: r.failureDetail ?? unknownFailureDetail("no first-round detail collected") })),
    },
    isolation,
    finalVerdict: firstRoundVerdict, // isolation never changes the verdict
    suiteError,
    suiteAborted, // TD-165 R2.4: true ⇒ waves after the abort point did NOT run
    abortOrigin, // TD-165 F6: "wave" | "isolation" | null — which leg aborted
  };
}

// ── Real adapters (used by main(); injectable fakes are used by the meta-tests) ─
const CHILD_BUFFER_CAP = 32768;
const TAIL_CHARS = 2000;

// ── TD-165 R2/R3: wall-clock supervision for ONE spawned child ──────────────
// Shared by both real adapters (the wave child and the isolation recheck).
// Pure orchestration over injectable seams — the supervisionLoop idiom from
// scripts/dispatch-with-liveness.mjs: killTreeFn / probeAliveFn / sleepFn /
// logLine are all injectable so the meta-tests never touch a real taskkill or
// a live pid. Two unref'd timers are armed per child:
//   alarm (R3)    — an interval that only ever prints ONE informational stderr
//                   line per elapsed period; never kills, never verdict-affects.
//   watchdog (R2) — a timeout that fires ONCE, marks `fired` SYNCHRONOUSLY
//                   (from that instant the child's own close/error events no
//                   longer settle the adapter — the probe loop owns the
//                   outcome), asks killTreeFn to kill exactly THIS child's pid
//                   tree, then probes liveness up to probeAttempts times at
//                   probeDelayMs intervals. A probe throwing EXACTLY
//                   { code: "ESRCH" } is the only accepted proof of death —
//                   same kill(pid, 0) win32-libuv evidence as
//                   createInflightMarker's killProbe (EPERM or any other error
//                   means alive; fail-safe). watchdogOutcome resolves to null
//                   when nothing fired, or { fired, confirmed, elapsedMs,
//                   probes, pid, limitMs } once the watchdog path completes.
//                   Fix round: killTreeFn is raced against killTreeDeadlineMs
//                   (default KILL_TREE_DEADLINE_MS) — a kill that never returns
//                   is abandoned at the deadline and the probe loop proceeds;
//                   the probes decide liveness, never the kill's return.
export function createChildSupervisor({
  label,
  waveWatchdogMs = WAVE_WATCHDOG_MS,
  waveAlarmMs = WAVE_ALARM_MS,
  killTreeFn = defaultKillTree,
  probeAliveFn = defaultProbeAlive,
  probeDelayMs = 500,
  probeAttempts = 3,
  killTreeDeadlineMs = KILL_TREE_DEADLINE_MS,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  logLine = (line) => console.error(line),
  now = Date.now,
}) {
  const start = now();
  let alarmTimer = null;
  let watchdogTimer = null;
  let fired = false;
  let resolveOutcome;
  const watchdogOutcome = new Promise((res) => { resolveOutcome = res; });
  const arm = (child) => {
    if (waveAlarmMs > 0) {
      alarmTimer = setInterval(() => {
        logLine(`[canonical] NOTICE: wave=${label} running for ${Math.round((now() - start) / 1000)}s (slow-wave alarm, informational)`);
      }, waveAlarmMs);
      alarmTimer.unref();
    }
    if (waveWatchdogMs > 0) {
      watchdogTimer = setTimeout(() => {
        fired = true; // synchronous: close/error on the child are moot from here
        if (alarmTimer) { clearInterval(alarmTimer); alarmTimer = null; } // the child is dying — stop the slow alarm
        const elapsedMs = now() - start;
        (async () => {
          // Fix round (residual must-fix): killTreeFn has a deadline. Race the
          // kill against killTreeDeadlineMs; on expiry abandon the wait and run
          // the probes anyway (a hung kill must not stall the watchdog itself).
          // The deadline timer is unref'd and cleared once the race settles, so
          // a fast kill never leaves a stray timer holding the event loop.
          let deadlineTimer = null;
          try {
            await Promise.race([
              Promise.resolve(killTreeFn(child.pid)).catch(() => {}),
              new Promise((_, missDeadline) => {
                deadlineTimer = setTimeout(() => missDeadline(new Error(`killTree exceeded ${killTreeDeadlineMs}ms deadline`)), killTreeDeadlineMs);
                if (typeof deadlineTimer.unref === "function") deadlineTimer.unref();
              }),
            ]);
          } catch {
            logLine(`[canonical] NOTICE: killTree did not return within ${killTreeDeadlineMs}ms — proceeding to liveness probes (they decide)`);
          } finally {
            if (deadlineTimer) clearTimeout(deadlineTimer);
          }
          let confirmed = false;
          let probes = 0;
          for (let attempt = 0; attempt < probeAttempts && !confirmed; attempt += 1) {
            if (attempt > 0) await sleepFn(probeDelayMs);
            probes = attempt + 1;
            try {
              probeAliveFn(child.pid); // normal return ⇒ still alive
            } catch (err) {
              if (err && err.code === "ESRCH") confirmed = true;
            }
          }
          resolveOutcome({ fired: true, confirmed, elapsedMs, probes, pid: child.pid, limitMs: waveWatchdogMs });
        })();
      }, waveWatchdogMs);
      watchdogTimer.unref();
    }
  };
  const dispose = () => {
    if (alarmTimer) { clearInterval(alarmTimer); alarmTimer = null; }
    if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
  };
  return { arm, dispose, fired: () => fired, watchdogOutcome };
}

// Default R2 kill: taskkill /PID <pid> /T /F — kills EXACTLY this child's
// process tree (a hung test may have spawned grandchildren that outlive it;
// verified 2026-09-19: without /T they are orphaned). NEVER a global node.exe
// hunt — `taskkill /IM node.exe` would kill the runner itself, sibling waves,
// and every unrelated Node process on the machine. The pid is additionally
// guarded against our own process.pid. Non-win32 degrades to SIGKILL on the
// direct child only (the production surface is win32; the probe loop decides
// "confirmed" either way, so the fallback cannot fake success).
export function defaultKillTree(pid) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) { resolve(false); return; }
    if (process.platform !== "win32") {
      try { process.kill(pid, "SIGKILL"); } catch { /* probe decides */ }
      resolve(true);
      return;
    }
    const tk = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    tk.on("error", () => resolve(false));
    tk.on("close", () => resolve(true));
  });
}

// Default R2 liveness probe: kill(pid, 0) — throws ESRCH iff the pid is gone
// (win32 libuv emits the POSIX errno name; verified 2026-08-21 — see the
// killProbe note in createInflightMarker for the same evidence).
export function defaultProbeAlive(pid) {
  process.kill(pid, 0);
}

// One `node --test` child per wave. Returns {exitCode, stdout, stderr}; rejects
// on spawn error (caught by runWave → all files crash). TD-165: every child is
// supervised (R2 watchdog backstop + R3 slow alarm) — once the watchdog fires,
// the child's own close/error events no longer settle this promise; the probe
// loop resolves it with { watchdog } so runWave can attribute the kill. The
// timers are unref'd so a normally-closed child never lingers.
// Fix round (TD-165 F2a): on an UNCONFIRMED watchdog outcome the child may
// still be alive holding our pipe handles — the runner could then never exit
// naturally. Before resolving, the adapter destroys both pipes and unrefs the
// child. `spawnImpl` (default spawn) is the injection seam the meta-tests use
// to drive this path with a fake child (assert destroy/unref were called).
export function realRunChild(nodeExe, repoRoot, env, watchOpts = {}, spawnImpl = spawn) {
  return (argv, opts = {}) => new Promise((resolve, reject) => {
    const child = spawnImpl(nodeExe, argv, {
      cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let out = "";
    let err = "";
    const onOut = (c) => { out += c; if (out.length > CHILD_BUFFER_CAP) out = out.slice(out.length - CHILD_BUFFER_CAP); };
    const onErr = (c) => { err += c; if (err.length > CHILD_BUFFER_CAP) err = err.slice(err.length - CHILD_BUFFER_CAP); };
    child.stdout.on("data", onOut);
    child.stderr.on("data", onErr);
    const supervisor = createChildSupervisor({ label: opts.waveName ?? "wave", ...watchOpts });
    supervisor.arm(child);
    child.on("error", (e) => { if (!supervisor.fired()) { supervisor.dispose(); reject(e); } });
    child.on("close", (code) => { if (!supervisor.fired()) { supervisor.dispose(); resolve({ exitCode: code, stdout: out, stderr: err }); } });
    supervisor.watchdogOutcome.then((wd) => {
      if (wd) {
        // TD-165 F2a: release the pipe handles of a possibly-still-alive child
        // BEFORE resolving, so the caller's bounded-exit path is not blocked.
        if (!wd.confirmed) {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
        }
        resolve({ exitCode: null, stdout: out, stderr: err, watchdog: wd });
      }
    });
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
// classifyIsolation's environment_invalid branch. TD-165: the argv carries the
// per-test timeout (R1) and the child is supervised exactly like a wave child
// (R2 backstop + R3 alarm); a watchdog kill resolves crash with crashReason
// "watchdog_timeout" — classifyIsolation reads it as a TRUE test hang
// (stable_fail), never environment_invalid.
// Fix round (TD-165 F2a): same pipe-handle release as realRunChild on an
// UNCONFIRMED watchdog outcome (stdout is null here — stdio ignores it — the
// optional chaining handles that); spawnImpl is the fake-child injection seam.
export function realIsolator(nodeExe, repoRoot, env, watchOpts = {}, spawnImpl = spawn) {
  const { testTimeoutMs = TEST_TIMEOUT_MS } = watchOpts;
  return ({ file }) => new Promise((resolve) => {
    const start = Date.now();
    let err = "";
    const child = spawnImpl(nodeExe, ["--test", `--test-timeout=${testTimeoutMs}`, "test/" + file], {
      cwd: repoRoot, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
    });
    child.stderr.on("data", (c) => { err += c; if (err.length > CHILD_BUFFER_CAP) err = err.slice(err.length - CHILD_BUFFER_CAP); });
    const supervisor = createChildSupervisor({ label: `isolation/${file}`, ...watchOpts });
    supervisor.arm(child);
    child.on("error", () => { if (!supervisor.fired()) { supervisor.dispose(); resolve({ status: "crash", exitCode: null, durationMs: Date.now() - start, tail: err.slice(-TAIL_CHARS) }); } });
    child.on("close", (code) => {
      if (!supervisor.fired()) {
        supervisor.dispose();
        resolve({
          status: code === 0 ? "pass" : code === null ? "crash" : "fail",
          exitCode: code, durationMs: Date.now() - start, tail: err.slice(-TAIL_CHARS),
        });
      }
    });
    supervisor.watchdogOutcome.then((wd) => {
      if (wd) {
        // TD-165 F2a: release the (possibly still-alive) child's pipe handles
        // BEFORE resolving — same bounded-exit rationale as realRunChild.
        if (!wd.confirmed) {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
        }
        resolve({ status: "crash", exitCode: null, crashReason: "watchdog_timeout", durationMs: Date.now() - start, tail: err.slice(-TAIL_CHARS), watchdog: wd });
      }
    });
  });
}

// ── TD-181 (a): real secondary-observation adapters (read-only, bounded) ─────
// node-process count with sampling time: one bounded `tasklist` sample on
// win32 (timeout-raced; the timer is unref'd so a hung tasklist can never
// stall the suite), honest {count:null, reason} everywhere else. Advisory only.
export function defaultCountNodeProcesses({ timeoutMs = 5000, spawnImpl = spawn } = {}) {
  const sampledAt = new Date().toISOString();
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve({ count: null, sampledAt, reason: `unsupported platform ${process.platform} (win32 tasklist sample only)` });
      return;
    }
    let settled = false;
    let out = "";
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const timer = setTimeout(() => finish({ count: null, sampledAt, reason: `sample timed out after ${timeoutMs}ms` }), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    let child;
    try {
      child = spawnImpl("tasklist", ["/FI", "IMAGENAME eq node.exe", "/FO", "CSV", "/NH"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch (err) {
      clearTimeout(timer);
      finish({ count: null, sampledAt, reason: `spawn failed: ${err && err.message ? err.message : String(err)}` });
      return;
    }
    child.stdout?.on("data", (c) => { out += c; if (out.length > CHILD_BUFFER_CAP) out = out.slice(out.length - CHILD_BUFFER_CAP); });
    child.on("error", (err) => { clearTimeout(timer); finish({ count: null, sampledAt, reason: `tasklist failed: ${err && err.message ? err.message : String(err)}` }); });
    child.on("close", () => {
      clearTimeout(timer);
      const count = out.split(/\r?\n/).filter((l) => /^"node\.exe"/i.test(l.trim())).length;
      finish({ count, sampledAt });
    });
  });
}

// Production observer bundle wired by runSuite: verification-gate state (the
// read-only status() query — no acquire, no side effects), the advisory
// inflight marker (another full suite on this machine), and the bounded node
// count. Every piece is read-only and degrades to unknown on any failure.
export function realWaveObservers({
  createGate = () => createVerificationGate({ identity: { owner: "scripts/canonical-test.mjs#observation" } }),
  markerReader = realInflightAdapter(),
  countNodeProcesses = defaultCountNodeProcesses,
} = {}) {
  let gate = null;
  return {
    verificationGate: async () => {
      gate ??= createGate();
      const st = await gate.status();
      if (st && st.free) return { state: "free" };
      if (st && st.corrupt) return { state: "corrupt" };
      if (st && st.holder) {
        return { state: "held", holder: { owner: st.holder.owner ?? null, pid: st.holder.pid ?? null, startedAt: st.holder.startedAt ?? null } };
      }
      return { state: "unknown", reason: "gate status returned an unrecognized shape" };
    },
    concurrentFullSuite: () => {
      const raw = markerReader.readMarker();
      if (raw === null) return { state: "none" };
      try {
        const info = JSON.parse(raw) || {};
        return { state: "present", pid: Number.isFinite(info.pid) ? info.pid : "unknown", startedAt: typeof info.startedAt === "string" && info.startedAt ? info.startedAt : "unknown" };
      } catch {
        return { state: "present", pid: "unknown", startedAt: "unknown", note: "marker present but unparseable" };
      }
    },
    nodeProcessCount: () => countNodeProcesses(),
  };
}

// ── main(): verification gate, then advisory inflight marker, then the suite.

/**
 * R23-F/B Round B: build the env handed to every wave child. Base behavior
 * unchanged (WAO_SKIP_VERSION_GUARD=1); when this process holds the machine
 * lease, add WAO_VERIFICATION_GATE_HELD=1 — env hop 2 (canonical parent → wave
 * children), so a child that itself reaches full-suite verification skips
 * claiming instead of deadlocking on its own ancestor's lease. Constructing
 * this AFTER acquire is what makes the held flag expressible at all — building
 * it before would freeze a pre-acquire snapshot (the same class of ordering
 * defect R22 fixed for the marker).
 *
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {{gateHeld: boolean}} opts
 */
export function buildCanonicalChildEnv(baseEnv, { gateHeld }) {
  return {
    ...baseEnv,
    WAO_SKIP_VERSION_GUARD: "1",
    ...(gateHeld ? { [VERIFICATION_GATE_HELD_ENV]: "1" } : {}),
  };
}

/**
 * R23-F/B Round B: ONE canonical invocation under the machine lease — the same
 * granularity as a whole verifyDelivery command sequence. Hard order:
 *
 *   acquire → buildChildEnv → marker.begin → suite → marker.end → release
 *
 *   · The lease is acquired BEFORE any child can spawn; queueing happens before
 *     any wave timer arms, so waiting never eats suite budget.
 *   · The R22 advisory inflight marker stays as the degraded-state warning
 *     layer (fail-open / kill switch / single-file runs): begin/end bracket the
 *     suite exactly as before and are deleted on EVERY exit path.
 *   · finally discipline: marker.end then release, on success AND failure; a
 *     suite error propagates untouched (the gate never changes semantics).
 *   · createGate === null (kill switch off / HELD set) ⇒ the gate segment is
 *     skipped entirely; marker layer remains.
 *
 * All collaborators injectable for the meta-tests; defaults are production.
 *
 * @param {{repoRoot: string, testDir: string, manifestPath: string, reportPath: string,
 *           nodeExe: string, env?: NodeJS.ProcessEnv,
 *           createGate?: (() => object)|null,
 *           createMarker?: () => {begin: Function, end: Function},
 *           runSuiteFn?: (args: object) => Promise<void>}} args
 */
export async function startCanonicalSuite({
  repoRoot, testDir, manifestPath, reportPath, nodeExe,
  env = process.env,
  createGate = null,
  createMarker = () => createInflightMarker(realInflightAdapter()),
  runSuiteFn = runSuite,
}) {
  const gate = typeof createGate === "function" ? createGate() : null;
  const handle = gate ? await gate.acquire() : null;
  try {
    const childEnv = buildCanonicalChildEnv(env, { gateHeld: Boolean(handle) });
    const inflight = createMarker();
    inflight.begin();
    try {
      await runSuiteFn({ repoRoot, testDir, manifestPath, reportPath, nodeExe, childEnv });
    } finally {
      inflight.end();
    }
  } finally {
    if (handle) await handle.release();
  }
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..");
  const testDir = join(repoRoot, "test");
  const manifestPath = join(testDir, "manifest.json");
  const reportPath = join(repoRoot, "test-results.json");
  const nodeExe = process.execPath;

  // Gate engagement decided ONCE per invocation from the live process env:
  // engaged unless kill-switched off or already held by an ancestor (HELD
  // guard — anti-self-lock). Disabled ⇒ null ⇒ startCanonicalSuite skips the
  // gate segment entirely (degrades to the R22 marker warning layer).
  const createGate = gateEngaged(process.env)
    ? () => createVerificationGate({ identity: { owner: "scripts/canonical-test.mjs" } })
    : null;

  await startCanonicalSuite({
    repoRoot, testDir, manifestPath, reportPath, nodeExe,
    env: process.env,
    createGate,
  });
}

// The suite proper (steps 1-5). Extracted from main() so the inflight marker's
// finally covers every return path below without re-indenting the whole body.
// Fix-round seams (both default to production): `exitFn` (default process.exit)
// lets the meta-tests pin the TD-165 F2b bounded exit — called exactly once,
// non-zero, AFTER the report is written and every line is printed; and
// `runCanonicalImpl` (default runCanonical) lets them drive a synthetic
// suiteAborted outcome without spawning children.
export async function runSuite({ repoRoot, testDir, manifestPath, reportPath, nodeExe, childEnv, exitFn = process.exit, runCanonicalImpl = runCanonical }) {
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
  const outcome = await runCanonicalImpl({
    waveSpecs,
    reporterArg,
    runChild: realRunChild(nodeExe, repoRoot, childEnv),
    readReport: realReadReport(reportPath),
    deleteReport: realDeleteReport(reportPath),
    isolator: realIsolator(nodeExe, repoRoot, childEnv),
    // TD-181 (a): advisory per-wave secondary observations (read-only, bounded,
    // failure-degrades-to-unknown, never verdict-affecting).
    observers: realWaveObservers(),
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

  // TD-165 R2.4 + F6: unconfirmed watchdog cleanup — the suite stopped early on
  // purpose; say so explicitly, naming WHICH leg stopped (the verdict is fail
  // via the aborting leg's groupError either way).
  if (outcome.suiteAborted) {
    if (outcome.abortOrigin === "isolation") {
      console.error("[canonical] watchdog cleanup unconfirmed during an isolation rerun — isolation rerun stopped; no further reruns (first-round waves already completed; possible process residue; do not re-run until the stray pid is gone; pid is in the report's isolation[].watchdog); verdict=fail");
    } else {
      console.error("[canonical] watchdog cleanup unconfirmed — later waves were NOT started (possible process residue; do not re-run until the stray pid is gone; pid is in the report's executionWaves[].watchdog); verdict=fail");
    }
  }

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
    // schemaVersion 4 (TD-181, 2026-09-25): ADDITIVE over 3 — every non-pass
    // firstRound.failures[] entry now carries bounded `failureDetail` (or an
    // honest unknown), and each executionWaves[] entry carries the advisory
    // `observation` annotation. Existing fields are unchanged.
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
    runner: { name: "canonical-test", node: process.version, hardwareParallelism: HW, mode: "one-node-test-child-per-wave" },
    discoveredCount: discovered.length,
    executedCount: outcome.firstRound.passed + outcome.firstRound.failed + outcome.firstRound.missing + outcome.firstRound.crashed,
    executionWaves: outcome.waves,
    firstRound: outcome.firstRound,
    isolation: outcome.isolation,
    finalVerdict: outcome.finalVerdict,
    suiteError: outcome.suiteError,
    // TD-165 R2.4: true ⇒ a watchdog kill with UNCONFIRMED cleanup stopped the
    // suite; waves after the abort point did NOT run.
    suiteAborted: outcome.suiteAborted,
    // TD-165 F6: which leg aborted ("wave" | "isolation" | null) — the pid for
    // residue triage lives in executionWaves[].watchdog.pid (wave leg) or
    // isolation[].watchdog.pid (isolation leg).
    abortOrigin: outcome.abortOrigin ?? null,
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
    console.error("  若本机同时有另一会话在用 WAO 派发（新转录即新增条目），可能是并发撞车而非测试写入——所有新增都会如实红灯（.owner- 心跳豁免曾评估并被否决，见本文件头注），排水规程见 docs/troubleshooting.md §8.2。");
  }
  process.exitCode = final.exitCode;
  // TD-165 F2b: 报告已写盘，这里必须有界退出——未确认残留的管道句柄会阻止自然退出。
  // (The hard exit skips startCanonicalSuite's finally: the inflight marker is
  // orphaned and the verification lease goes stale exactly like a crashed run —
  // both documented, recoverable states (stale-marker NOTICE downgrade; lease
  // staleness takeover). A bounded exit wins over clean unwinding here.)
  if (outcome.suiteAborted) exitFn(final.exitCode || 1);
}

// Invalid environment (manifest drift / unreadable / unparseable / bad wave
// plan / unsnapshot-able runs/ guard baseline): no tests run, OVERWRITE any
// stale report on disk with a minimal environment_invalid one (so a leftover
// green test-results.json can never be misread as this run's result), exit
// non-zero.
function failInvalidEnvironment(reportPath, message) {
  console.error(`[canonical] INVALID ENVIRONMENT (no tests run): ${message}`);
  const report = {
    schemaVersion: 4,
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
