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
//     TD-181 (b, 2026-09-26, audit22 fixes): the failureDetail budget is
//     enforced on the ACTUAL JSON-serialized length (a single test + fileFailure
//     with escaped characters used to exceed it), unknownFailureDetail bounds
//     its reason, and the node-process sample records unknown — never 0 — on
//     non-zero exit / signal / unparseable output, releasing the sampling
//     child's handles on timeout.
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
import { readdirSync, readFileSync, writeFileSync, statSync, unlinkSync, mkdtempSync, rmSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { availableParallelism, cpus, tmpdir } from "node:os";

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
// Concurrency — HISTORICAL measured evidence (filesystem wave, 54 files; frozen
// figures kept for the record, NOT the basis of the current value):
//   @8  = 212s  (argv-order scheduling strands the alphabetically-late pole)
//   @16 = 178s  (conservative knee — solidly past the @8 that failed the target)
//   @24 = 171s  (diminishing: +8 concurrency saves only ~7s past 16)
// Historical conclusion: 16 is the smallest value that comfortably meets the delivery window.
// Current choice: 8, PROVISIONAL (2026-09-26). Basis: a small repeated-case
// comparison observed shorter TAP process duration (excluding queue time waiting
// for a runner slot) at 8, with no observed batch throughput loss. That small
// comparison does NOT establish optimality, full-suite speed, root cause, or
// acceptance.
function hardwareParallelism() {
  try { return availableParallelism ? availableParallelism() : cpus().length; }
  catch { return 4; }
}
const HW = hardwareParallelism();
export const WAVE_PLAN = Object.freeze([
  { name: "pure", concurrency: 8, categories: ["pure"] },
  { name: "filesystem", concurrency: 8, categories: ["git", "worktree"] },
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

// ── TD-248 / 决定 0054: interference-registry auto-adjudication ──────────────
// Owner 2026-10-10 批准的 verdict 派生合同修订（kimi 派形态 pass+标记+衰减；
// opus 必改项全采纳）。资格闭集（缺一即整文件回 fail）：
//   首轮 fail + 隔离复跑 pass + failureDetail 完整（status=collected、无
//   dropped、无 TRUNCATED 标记、失败子测>0）+ 每一个失败子测都命中可用条目
//   （active 且未过期）+ 非 worker 上下文。
// 红线：套件只读登记册（test/interference-registry.json，committed）、绝不写
// 仓库文件；首红原始记录永不删除；worker 上下文恒 fail（防自我洗白）；衰减=
// expiresOn 日期（verdict 依赖时钟——0054 §2 显式记录的确定性让步）。
export const INTERFERENCE_REGISTRY_NAME = "interference-registry.json";
export const INTERFERENCE_STATUSES = Object.freeze(["active", "expired", "superseded"]);

// 固定归一化：数字串→<n>。禁用 RegExp（套件禁令 no runtime regex
// classification 对失败分类面生效；本归一化是测试钉死的字符变换，非分类）。
export function normalizeSignatureText(text) {
  if (typeof text !== "string") return "";
  let out = "";
  let inDigits = false;
  for (const ch of text) {
    if (ch >= "0" && ch <= "9") {
      if (!inDigits) { out += "<n>"; inDigits = true; }
    } else {
      inDigits = false;
      out += ch;
    }
  }
  return out;
}

// 签名源=stack 首行（含 AssertionError 前缀与断言消息——跨运行稳定）。
export function signatureSourceLine(stack) {
  if (typeof stack !== "string" || stack.length === 0) return "";
  const nl = stack.indexOf("\n");
  return nl < 0 ? stack : stack.slice(0, nl);
}

function isValidIsoDate(value) {
  if (typeof value !== "string" || value.length !== 10) return false;
  for (let i = 0; i < 10; i += 1) {
    const c = value[i];
    const ok = i === 4 || i === 7 ? c === "-" : c >= "0" && c <= "9";
    if (!ok) return false;
  }
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

// 登记册 schema 校验（fail-closed：committed 合同破损=套件级错误，不静默降级）。
export function validateInterferenceRegistry(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: ["registry root must be an object"] };
  }
  if (parsed.schemaVersion !== 1) errors.push(`schemaVersion must be 1 (got ${JSON.stringify(parsed.schemaVersion)})`);
  const entries = Array.isArray(parsed.entries) ? parsed.entries : null;
  if (!entries) {
    errors.push("entries must be an array");
    return { ok: false, errors };
  }
  const seen = new Set();
  entries.forEach((e, i) => {
    const at = `entries[${i}]`;
    if (!e || typeof e !== "object" || Array.isArray(e)) { errors.push(`${at} must be an object`); return; }
    for (const k of ["id", "file", "subtest", "signature", "registeredAt", "expiresOn", "owner", "note"]) {
      if (typeof e[k] !== "string" || e[k].length === 0) errors.push(`${at}.${k} must be a non-empty string`);
    }
    if (e.isolationRequired !== true) errors.push(`${at}.isolationRequired must be true`);
    if (!INTERFERENCE_STATUSES.includes(e.status)) errors.push(`${at}.status must be one of ${INTERFERENCE_STATUSES.join("|")}`);
    if (!isValidIsoDate(e.registeredAt)) errors.push(`${at}.registeredAt must be YYYY-MM-DD`);
    if (!isValidIsoDate(e.expiresOn)) errors.push(`${at}.expiresOn must be YYYY-MM-DD`);
    if (isValidIsoDate(e.registeredAt) && isValidIsoDate(e.expiresOn) && e.expiresOn < e.registeredAt) {
      errors.push(`${at}.expiresOn precedes registeredAt`);
    }
    if (typeof e.id === "string" && seen.has(e.id)) errors.push(`${at}.id duplicated`);
    if (typeof e.id === "string") seen.add(e.id);
  });
  return { ok: errors.length === 0, errors };
}

// 条目当日可用：active 且未过期（字符串日期比较=确定性，只依赖 committed 输入+当日）。
export function entryUsableOn(entry, today) {
  return entry.status === "active" && typeof entry.expiresOn === "string" && entry.expiresOn >= today;
}

/**
 * 资格闭集判定（纯函数，元测试双向钉）。返回：
 *   matched      —— 签名面成功（所有门+所有失败子测命中可用条目）
 *   adjudicated  —— matched 且非 worker 上下文（verdict 允许 wash）
 *   matches      —— [{id, subtest}] 逐子测条目引用（worker 抑制时也保留供 advisory）
 *   failedGates  —— 未过的门名列表（诊断用，永远如实）
 */
export function classifyAutoAdjudication({ firstRoundStatus, isolationClassification, failureDetail, file, registryEntries, workerContext, today }) {
  const failedGates = [];
  if (firstRoundStatus !== "fail") failedGates.push("first-round-status");
  if (isolationClassification !== "isolation_pass") failedGates.push("isolation-classification");
  const detail = failureDetail && typeof failureDetail === "object" ? failureDetail : null;
  if (!detail || detail.status !== "collected") failedGates.push("detail-collected");
  if (detail && detail.failingTestsDropped > 0) failedGates.push("detail-dropped");
  if (detail && (Array.isArray(detail.failingTests) ? detail.failingTests : []).some((t) => t && typeof t === "object" && Object.values(t).some((v) => typeof v === "string" && v.includes("[TRUNCATED")))) {
    failedGates.push("detail-truncated");
  }
  const subtests = detail && Array.isArray(detail.failingTests) ? detail.failingTests : [];
  if (subtests.length === 0) failedGates.push("no-failing-subtests");
  const matches = [];
  const notUsable = [];
  if (failedGates.length === 0) {
    for (const t of subtests) {
      const signature = normalizeSignatureText(signatureSourceLine(t.stack));
      const candidates = (registryEntries ?? []).filter(
        (e) => e && e.file === file && e.subtest === t.name && e.signature === signature,
      );
      const hit = candidates.find((e) => entryUsableOn(e, today));
      if (hit) { matches.push({ id: hit.id, subtest: t.name }); continue; }
      if (candidates.length > 0) {
        // 签名命中但条目不可用（expired/superseded）——衰减机制回 fail，可溯源。
        for (const c of candidates) notUsable.push({ id: c.id, status: c.status, expiresOn: c.expiresOn });
        failedGates.push("entry-not-usable");
      } else {
        failedGates.push("signature-match");
      }
      break;
    }
  }
  const matched = failedGates.length === 0;
  const adjudicated = matched && workerContext !== true;
  if (matched && workerContext === true) failedGates.push("worker-context");
  return { matched, adjudicated, matches, notUsable, failedGates };
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

// Advisory only: read at most 8KB, never the full transcript or later events.
export const RUNS_ATTRIBUTION_BYTE_CAP = 8 * 1024;

function firstRunsEvent(filePath) {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(RUNS_ATTRIBUTION_BYTE_CAP);
    let used = 0;
    let newline = -1;
    while (used < buffer.length && newline < 0) {
      const count = readSync(fd, buffer, used, buffer.length - used, null);
      if (count === 0) break;
      used += count;
      newline = buffer.subarray(0, used).indexOf(10);
    }
    if (newline < 0 && used === buffer.length) throw new Error("first event exceeds byte cap");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline < 0 ? used : newline));
    const event = JSON.parse(text);
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("first event is not an object");
    return event;
  } finally {
    closeSync(fd);
  }
}

// Shape mapping does not expand the guard's snapshot depth or change its diff.
// Every I/O/parse failure is an unknown annotation, never a guard decision.
export function runsEntryAttribution(runsDir, entry) {
  const unknown = { entry, parseStatus: "unknown" };
  const unmapped = { entry, parseStatus: "unattributable" };
  const fromFile = (file) => {
    const result = { entry, runId: file.split("/").at(-1).slice(0, -6), parseStatus: "unknown" };
    try {
      const event = firstRunsEvent(join(runsDir, file));
      for (const key of ["cwd", "agentId", "ts"]) {
        if (typeof event[key] === "string") result[key] = event[key];
      }
      if (typeof event.project === "string") result.project = event.project;
      else if (event.project && typeof event.project === "object" && !Array.isArray(event.project)) {
        const project = {};
        for (const key of ["bucket", "key", "displayName"]) {
          if (typeof event.project[key] === "string") project[key] = event.project[key];
        }
        if (Object.keys(project).length > 0) result.project = project;
      }
      result.parseStatus = "parsed";
    } catch { /* Unknown evidence never changes RED or the exit code. */ }
    return result;
  };
  try {
    if (typeof entry !== "string") return [unmapped];
    const normalized = entry.replace(/\/$/, "");
    const parts = normalized.split("/");
    if (parts.some((p) => !p || p === "." || p === ".." || p.includes("\\"))) return [unmapped];
    if (/^run_.+\.jsonl$/.test(parts.at(-1))) return [fromFile(normalized)];
    if (parts.length === 2 && parts[0] === "projects") {
      const files = readdirSync(join(runsDir, normalized), { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
        .map((d) => `${normalized}/${d.name}`).sort();
      return files.length > 0 ? files.map(fromFile) : [unmapped];
    }
    return [unmapped];
  } catch { return [unknown]; }
}

export function runsAttributionLine(attribution) {
  const prefix = "[canonical] 仍然 RED，以下是归属证据：";
  if (attribution.parseStatus === "unattributable") {
    return `${prefix}无法归属（形态：${JSON.stringify(attribution.entry)}）`;
  }
  return prefix + JSON.stringify(attribution);
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

// TD-181 (b, 2026-09-26): the unknown's `reason` rides into the bounded report
// too — a multi-K reportError must not blow the per-file budget. Same bounding
// discipline as every other retained string: worst case a char serializes to 6
// (\u0001), so cap + marker stays under FAILURE_DETAIL_CHAR_BUDGET by
// construction (6 × (1000 + 44) + structure ≪ 8000), and the truncation marker
// keeps the true original length — nothing fabricated.
export function unknownFailureDetail(reason) {
  return { status: "unknown", reason: boundDetailString(String(reason)) ?? "" };
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
//
// TD-181 (b, 2026-09-26): the budget is enforced on the ACTUAL serialized
// length (JSON.stringify of the built detail), not "by construction". The old
// claim "one capped test always fits by construction (6 fields × (cap +
// marker) < budget)" was FALSE: JSON escaping expands one source char to as
// many as 6 serialized chars (\u0001), so even a SINGLE failing test — with or
// without fileFailure — could serialize past the budget (measured 8534/12437
// plain-quoted, 14833 control-char; audit22). The fit ladder below is
// re-derived from the RAW values at every step, so every truncation marker
// states the TRUE shown/total counts and no content is ever fabricated:
//   1. drop trailing failing tests (counted in failingTestsDropped) down to 1;
//   2. drop fileFailure — its message is normally the SAME assertion error the
//      first failing test's stack already carries (redundant content first);
//      recorded explicitly as fileFailureDropped: true. Skipped when it is the
//      ONLY content (no failing subtests were retained);
//   3. halve the per-field cap and re-bound every field from its RAW value
//      (markers restate the smaller cap against the original length);
//   4. cap 0 leaves marker-only strings — if even that cannot fit
//      (pathological), degrade to an honest unknown rather than exceed.
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
    // RAW (unbounded) entries: the ladder re-derives bounded copies from these
    // so each shrink step truncates the ORIGINAL, never a previously-truncated
    // copy (markers would otherwise understate the true original length).
    const rawTests = [];
    for (const t of allFailing.slice(0, FAILURE_DETAIL_TEST_CAP)) {
      const e = t.error && typeof t.error === "object" ? t.error : {};
      rawTests.push({
        name: typeof t.name === "string" ? t.name : null,
        operator: e.operator, expected: e.expected, actual: e.actual,
        diff: e.diff, stack: e.stack,
      });
    }
    const rawFileFailure = suite.fileFailure && typeof suite.fileFailure === "object"
      ? suite.fileFailure : null;
    let kept = rawTests.length;
    let dropped = Math.max(0, allFailing.length - FAILURE_DETAIL_TEST_CAP);
    let cap = FAILURE_DETAIL_TEXT_CAP;
    let fileFailureKept = true;
    const build = () => {
      const detail = {
        status: "collected",
        source: "firstRoundWaveReport",
        failingTestsTotal: allFailing.length,
        failingTestsDropped: dropped,
        failingTests: [],
        fileFailure: null,
      };
      for (const rt of rawTests.slice(0, kept)) {
        detail.failingTests.push({
          name: boundDetailString(rt.name, cap) ?? "(test name unavailable)",
          operator: boundDetailString(rt.operator, cap),
          expected: boundDetailString(rt.expected, cap),
          actual: boundDetailString(rt.actual, cap),
          diff: boundDetailString(rt.diff, cap),
          stack: boundDetailString(rt.stack, cap),
        });
      }
      if (rawFileFailure) {
        if (fileFailureKept) {
          detail.fileFailure = {
            message: boundDetailString(rawFileFailure.message, cap) ?? "(no message)",
            stack: boundDetailString(rawFileFailure.stack, cap),
          };
        } else {
          // explicit drop count — never silently vanish
          detail.fileFailureDropped = true;
        }
      }
      return detail;
    };
    while (JSON.stringify(build()).length > FAILURE_DETAIL_CHAR_BUDGET) {
      if (kept > 1) { kept -= 1; dropped += 1; continue; }
      if (rawFileFailure && fileFailureKept && rawTests.length > 0) { fileFailureKept = false; continue; }
      if (cap > 0) { cap = Math.floor(cap / 2); continue; }
      return unknownFailureDetail("failure detail could not be bounded within the per-file char budget");
    }
    return build();
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
export async function runCanonical({ waveSpecs, reporterArg, runChild, readReport, deleteReport, isolator, onWaveStart, onWaveEnd, testTimeoutMs = TEST_TIMEOUT_MS, observers = null, registryEntries = [], workerContext = null, today = null }) {
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

  // TD-248 / 决定 0054：干扰形自动裁定（资格闭集见 classifyAutoAdjudication）。
  // worker 上下文/当日为套件级一次判定（确定性：同日同输入同结论）；
  // 可注入供元测试。matched-but-suppressed 与过期命中保留为 advisory——
  // 永不静默，也永不改变 fail。firstRoundVerdict 恒为首轮事实（fail），
  // 裁定只作用于 finalVerdict——不重写历史。
  const effectiveWorkerContext = workerContext ?? (process.env.WAO_IN_WORKER === "1" || runIdFromWorktreeCwd(process.cwd()) !== null);
  const effectiveToday = today ?? new Date().toISOString().slice(0, 10);
  const autoAdjudicated = [];
  const adjudicationAdvisories = [];
  if (!suiteAborted) {
    for (const iso of isolation) {
      if (iso.classification !== "isolation_pass") continue;
      const failure = failures.find((r) => r.path === iso.path);
      const verdict0054 = classifyAutoAdjudication({
        firstRoundStatus: failure?.status ?? null,
        isolationClassification: iso.classification,
        failureDetail: failure?.failureDetail,
        file: iso.path,
        registryEntries,
        workerContext: effectiveWorkerContext,
        today: effectiveToday,
      });
      iso.autoAdjudication = { matched: verdict0054.matched, adjudicated: verdict0054.adjudicated, failedGates: verdict0054.failedGates };
      if (verdict0054.adjudicated) {
        autoAdjudicated.push({ path: iso.path, matches: verdict0054.matches });
      } else if (verdict0054.matched && effectiveWorkerContext) {
        adjudicationAdvisories.push({ path: iso.path, kind: "worker-context-suppressed", entryIds: verdict0054.matches.map((m) => m.id) });
      } else if (verdict0054.failedGates.includes("entry-not-usable")) {
        adjudicationAdvisories.push({ path: iso.path, kind: "entry-not-usable", entryIds: verdict0054.notUsable.map((m) => m.id) });
      }
    }
  }
  // finalVerdict 派生：被裁定文件不计入有效失败（首红原始记录仍在
  // firstRound.failures——永不删除）；其余一切不变（groupError/suiteError 同旧）。
  const adjudicatedPaths = new Set(autoAdjudicated.map((a) => a.path));
  const effectiveFailures = failures.filter((r) => !adjudicatedPaths.has(r.path));
  const finalVerdict = (effectiveFailures.length === 0 && !suiteError) ? "pass" : "fail";

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
    finalVerdict, // 首轮事实之外唯一翻绿路径=登记册资格闭集自动裁定（TD-248/0054）；firstRound.verdict 恒为首轮事实
    autoAdjudicated, // TD-248：[{path, matches:[{id, subtest}]}]——verdict=pass 的例外来源，逐条可溯源
    adjudicationAdvisories, // TD-248：matched-but-suppressed（worker 上下文）等观察事实，不改变 verdict
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
//
// TD-181 (b, 2026-09-26, audit22; row-shape strictness re-fixed 2026-09-26 r2):
// a sample that FAILED is unknown, never 0. The previous close handler ignored
// the exit code and signal and counted rows unconditionally — a tasklist that
// died non-zero (or was killed by a signal, or printed an unparseable banner)
// with no node.exe rows was recorded as count 0, fabricating "zero node
// processes". Policy (pinned):
//   non-zero exit        ⇒ unknown (reason names the code)
//   signal exit          ⇒ unknown (reason names the signal)
//   unparseable output   ⇒ unknown — ANY non-blank line that is not a
//                          WELL-FORMED quoted node.exe CSV row (full-line
//                          shape: five columns with valid PID/session IDs):
//                          a `"node.exe"garbage` broken row, a quoted row for
//                          another image (the /FI filter was bypassed / not
//                          tasklist output), or legal rows with unquoted
//                          residue (a truncated buffer or a locale notice —
//                          deliberately NO per-locale notice dictionary: a
//                          notice cannot be PROVEN to be the normal no-match
//                          line, zh-CN prints 「信息: 没有匹配…」, and an
//                          unprovable zero must not be recorded as 0)
//   normal empty sample  ⇒ 0 — the ONLY shape that may record 0: blank/empty
//                          output after a successful process exit
//   all rows well-formed ⇒ their count
// The timeout leg additionally RELEASES the sampling child (kill + pipe
// destroy + unref) before resolving — a hung tasklist must not leave live
// handles holding the runner's natural exit (same F2a discipline as the
// wave/isolation children).
// tasklist /FO CSV /NH has exactly five quoted columns. Session names and
// memory display are localized; only image, PID and numeric session ID have
// machine-readable identities. Escaped quotes and commas remain field content.
const TASKLIST_NODE_CSV_ROW = /^"node\.exe","([0-9]+)","(?:[^"]|"")*","([0-9]+)","(?:[^"]|"")*"$/;
export function parseTasklistSample(out) {
  const lines = typeof out === "string" ? out.split(/\r?\n/) : [];
  const nonBlank = lines.map((l) => l.trim()).filter((l) => l !== "");
  if (nonBlank.length === 0) return { count: 0 };
  for (const l of nonBlank) {
    const fields = TASKLIST_NODE_CSV_ROW.exec(l);
    if (!fields || Number(fields[1]) <= 0 || Number(fields[1]) > 0xffffffff || Number(fields[2]) > 0xffffffff) {
      return { count: null, reason: `unparseable tasklist output: not a well-formed quoted node.exe CSV row (first offending line: ${boundDetailString(l, 120)})` };
    }
  }
  return { count: nonBlank.length };
}

export function defaultCountNodeProcesses({ timeoutMs = 5000, spawnImpl = spawn } = {}) {
  const sampledAt = new Date().toISOString();
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve({ count: null, sampledAt, reason: `unsupported platform ${process.platform} (win32 tasklist sample only)` });
      return;
    }
    let settled = false;
    let out = "";
    let outputTruncated = false;
    let child = null;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    // 采样异常不留活句柄：超时腿在 resolve 前先把采样子进程收掉（kill + 销毁
    // 管道 + unref，全部 best-effort 且带类型守卫——注入的 fake child 可缺方法）。
    const releaseChild = () => {
      if (!child) return;
      try { if (typeof child.kill === "function") child.kill(); } catch { /* best effort */ }
      try { child.stdout?.destroy?.(); } catch { /* best effort */ }
      try { if (typeof child.unref === "function") child.unref(); } catch { /* best effort */ }
    };
    const timer = setTimeout(() => {
      releaseChild();
      finish({ count: null, sampledAt, reason: `sample timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    try {
      child = spawnImpl("tasklist", ["/FI", "IMAGENAME eq node.exe", "/FO", "CSV", "/NH"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch (err) {
      clearTimeout(timer);
      finish({ count: null, sampledAt, reason: `spawn failed: ${err && err.message ? err.message : String(err)}` });
      return;
    }
    child.stdout?.on("data", (c) => {
      if (outputTruncated) return;
      out += c;
      if (out.length > CHILD_BUFFER_CAP) {
        outputTruncated = true;
        out = out.slice(0, CHILD_BUFFER_CAP);
      }
    });
    child.on("error", (err) => { clearTimeout(timer); finish({ count: null, sampledAt, reason: `tasklist failed: ${err && err.message ? err.message : String(err)}` }); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        finish({ count: null, sampledAt, reason: `tasklist exited on signal ${signal}` });
        return;
      }
      if (code !== 0) {
        finish({ count: null, sampledAt, reason: `tasklist exited with code ${code}` });
        return;
      }
      // A truncated sample can end exactly on a valid row boundary. Its rows
      // remain parseable, but cannot prove the total number of processes.
      if (outputTruncated) {
        finish({ count: null, sampledAt, reason: `tasklist sample truncated: output exceeded ${CHILD_BUFFER_CAP} chars` });
        return;
      }
      const parsed = parseTasklistSample(out);
      finish(parsed.count === null ? { count: null, sampledAt, reason: parsed.reason } : { count: parsed.count, sampledAt });
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
    // TD-229（2026-10-07，全量实战暴露）：MCP 认证门禁是部署级开关（User 作用域
    // setx，宿主 spawn 时定格）——若宿主 User env 带它，套件子进程继承后
    // run_dispatch 族夹具车道（无认证记录）全被门拒绝（16 文件 stable_fail 实证；
    // 上午发版套件绿是因跑在 setx 前启动的长命 shell 里）。套件契约=确定性：
    // 钉 "0"（默认关）；门禁自身行为由 mcpCertGate.test.js 自设环境变量覆盖，
    // 不受此钉影响。
    WAO_MCP_REQUIRE_CERTIFIED: "0",
    ...(gateHeld ? { [VERIFICATION_GATE_HELD_ENV]: "1" } : {}),
  };
}

/**
 * TD-223（2026-10-07）+ F-②（2026-10-10 摩擦处置批）：一次性 TEMP 隔离。
 * 套件内多数测试文件构造 ClaudeCodeBackend（只有 1 个注入 fixture 凭据源）——
 * native OAuth 通道的 prepare 会把真实 ~/.claude/.credentials.json 复制进
 * os.tmpdir()，每跑一次就往用户真实 %TEMP% 撒凭据副本（实测 24/24 字节同源）。
 * 本重定向把本进程 os.tmpdir() 与全部子进程 env（TMP/TEMP/TMPDIR）指到一次性
 * 目录，退出时删除；被 watchdog 强杀的残留目录由 wao sweep-claude-config 清扫
 * 兜底。canonical 全量（main）与定向入口（scripts/test-one.mjs）共用本函数——
 * TD-223 的保护不因入口不同而缺席（opus P1 会审必改项）。
 * 必须在任何 childEnv 派生之前调用（childEnv 从 process.env 展开）。
 */
export function isolateSuiteTemp() {
  const realTmp = tmpdir(); // 捕获真实值——重定向后再调 tmpdir() 会拿到套件目录
  const suiteTempRoot = mkdtempSync(join(realTmp, "wao-canonical-temp-"));
  for (const name of ["TMP", "TEMP", "TMPDIR"]) process.env[name] = suiteTempRoot;
  process.on("exit", () => {
    try { rmSync(suiteTempRoot, { recursive: true, force: true }); } catch { /* 强杀/占用残留交 sweep */ }
  });
  return suiteTempRoot;
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

// ── TD-233: worker-context self-awareness + verification lease attribution ────

// runId shape check — a LOCAL copy of the allowlist in src/delivery.js
// isValidRunId (the SSOT): letters/digits/underscore/hyphen, no leading dot or
// dash. scripts/ is test infrastructure and must NOT import src production
// modules (no reverse dependency), so the rule is duplicated here; if
// delivery.js ever tightens the rule, update this copy in step.
export function isValidRunIdShape(runId) {
  if (typeof runId !== "string" || runId.length === 0) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) return false;
  if (/^[.-]/.test(runId)) return false;
  return true;
}

// Derive the delivery-worktree runId from this process's cwd. Delivery
// worktrees are checked out at <repo>/.wao-worktrees/<runId>, so the segment
// right after `.wao-worktrees` is the owning runId. Any other cwd (main repo
// checkout, unexpected nesting, a segment that fails the isValidRunId allowlist)
// yields null — the gate identity then carries no runId, exactly the pre-TD-233
// shape. Directory-name comparison is case-insensitive (Windows paths; a
// `.WAO-WORKTREES` variant must still attribute — 验收会审 astra 反例). An
// over-cap candidate is DROPPED whole, never truncated (a truncated id would
// masquerade as a different run — 验收会审 astra 反例); the ≤64 cap stays the
// display-side bound for the lease record (a gate.log forensic surface), and
// real WAO runIds are far shorter.
export function runIdFromWorktreeCwd(cwd = process.cwd()) {
  const segments = String(cwd ?? "").split(/[\\/]+/);
  let idx = -1;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i].toLowerCase() === ".wao-worktrees") { idx = i; break; }
  }
  const candidate = idx >= 0 && idx + 1 < segments.length ? segments[idx + 1] : undefined;
  if (!candidate || !isValidRunIdShape(candidate)) return null;
  if (candidate.length > 64) return null;
  return candidate;
}

// One-line startup banner for a suite launched INSIDE a worker context.
// Trigger mirrors the 0047 guard exactly (nestedDispatchGuard.js): env marker
// must be the literal "1", and an existing Lead bypass exemption means the
// env arm will NOT block anything — the banner then reports context facts
// only and makes no red/no-red prediction (验收会审 astra 反例：原实现把 "0"
// 当真值触发、有豁免时仍预判会红). Outside a worker context → null. Pure
// advisory: no env is stripped or waived, decision 0047's semantics untouched.
export function workerBannerLine(env = process.env) {
  if (env.WAO_IN_WORKER !== "1") return null;
  const prefix = "[canonical] NOTE: 本进程处于 worker 上下文（WAO_IN_WORKER=1）";
  if (env.WAO_ALLOW_NESTED_DISPATCH === "1") {
    // TD-246（2026-10-10 摩擦处置批）：旧文案"cwd 臂仍按原样生效"与守卫事实矛盾
    // ——nestedDispatchGuard 在豁免口即 return null（:46），env 标记臂与 cwd 臂
    // 【均】不拦截。豁免=0047 语义内的整体旁路，横幅如实报告。
    return `${prefix}，且检测到 Lead 豁免（WAO_ALLOW_NESTED_DISPATCH=1）——0047 语义内的整体旁路：env 标记臂与 cwd 臂均不拦截（守卫在豁免口即返回）；仅报告上下文事实，不预判红绿；未做任何 env 剥除或注入。`;
  }
  return `${prefix}——派发族测试受决定 0047（防向下派发门）约束会变红，属预期行为非回归；未做任何 env 豁免。`;
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..");
  const testDir = join(repoRoot, "test");
  const manifestPath = join(testDir, "manifest.json");
  const reportPath = join(repoRoot, "test-results.json");
  const nodeExe = process.execPath;

  // TD-223 尾项（2026-10-07 opus 验收发现）：套件一次性 TEMP 隔离——具体背景
  // 与纪律见 isolateSuiteTemp() 头注（F-② 抽取共享：定向入口同享此保护）。
  // 必须在 startCanonicalSuite 之前——childEnv 从 process.env 派生。
  isolateSuiteTemp();

  // Decision 0047 self-awareness: say up front that a worker-context suite's
  // red dispatch-family files are by-design (see workerBannerLine). Advisory
  // only — nothing is stripped or waived.
  const banner = workerBannerLine();
  if (banner) console.error(banner);

  // Gate engagement decided ONCE per invocation from the live process env:
  // engaged unless kill-switched off or already held by an ancestor (HELD
  // guard — anti-self-lock). Disabled ⇒ null ⇒ startCanonicalSuite skips the
  // gate segment entirely (degrades to the R22 marker warning layer).
  // TD-233 租约归因：delivery worktree 里跑套件时，把 worktree 的 runId 附进
  // 租约身份（gate.log 取证线索）；主仓/其他 cwd 解析不出 runId ⇒ 不附，保持现状。
  const workerRunId = runIdFromWorktreeCwd();
  const createGate = gateEngaged(process.env)
    ? () => createVerificationGate({ identity: {
      owner: "scripts/canonical-test.mjs",
      ...(workerRunId ? { runId: workerRunId } : {}),
    } })
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
  // TD-248 / 决定 0054：登记册加载（套件只读）。缺文件=空登记册+stderr 注记
  // （方向=更严，安全）；存在但解析/校验失败=套件级错误（committed 合同破损
  // 不得静默降级——fail-closed）。
  let registryEntries = [];
  const registryPath = join(testDir, INTERFERENCE_REGISTRY_NAME);
  let registryParsed = null;
  try {
    registryParsed = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") {
      console.error(`[canonical] interference-registry 不存在（${registryPath}）——按空登记册运行（自动裁定关闭，方向=更严）`);
    } else {
      throw new Error(`interference-registry 解析失败（fail-closed）: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (registryParsed !== null) {
    const validation = validateInterferenceRegistry(registryParsed);
    if (!validation.ok) throw new Error(`interference-registry schema 违约（fail-closed）: ${validation.errors.join("; ")}`);
    registryEntries = registryParsed.entries;
  }

  const outcome = await runCanonicalImpl({
    waveSpecs,
    reporterArg,
    runChild: realRunChild(nodeExe, repoRoot, childEnv),
    readReport: realReadReport(reportPath),
    deleteReport: realDeleteReport(reportPath),
    isolator: realIsolator(nodeExe, repoRoot, childEnv),
    // TD-248：登记册经 runSuite 单点加载后注入（套件对登记册的全部读取=此处一次）。
    registryEntries,
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
  // TD-248 / 0054：自动裁定输出——绿灯来源必须响亮可溯源；advisory 永不静默。
  for (const adj of outcome.autoAdjudicated ?? []) {
    console.error(`[canonical] AUTO-ADJUDICATED（登记册）：${adj.path} 的 pass 来自条目 ${adj.matches.map((m) => m.id).join(",")}——非代码正确性证明；首红原始记录保留在 firstRound.failures。`);
  }
  for (const adv of outcome.adjudicationAdvisories ?? []) {
    if (adv.kind === "worker-context-suppressed") {
      console.error(`[canonical] ADVISORY：${adv.path} 本应命中登记册条目 ${adv.entryIds.join(",")}，但 worker 上下文禁用自动裁定（0054 §1 防自我洗白）——verdict 保持 fail。`);
    } else if (adv.kind === "entry-not-usable") {
      console.error(`[canonical] ADVISORY：${adv.path} 签名命中登记册条目 ${adv.entryIds.join(",")} 但条目已过期/非 active（衰减机制）——verdict 保持 fail；若干扰形仍真实发生，请人工重新裁定登记。`);
    } else {
      console.error(`[canonical] ADVISORY：${adv.path} 裁定观察（kind=${adv.kind}）——不改变 verdict。`);
    }
  }
  // Isolation rechecks spawn children OUTSIDE any wave — sweep them too so a
  // leak during a diagnostic rerun is caught and attributed to this phase.
  const isoFresh = guardRecord("isolation");
  if (isoFresh.length > 0) {
    console.error(`[canonical] runs-guard phase=isolation NEW runs/ entries: ${isoFresh.map((f) => f.file).join(", ")}`);
  }

  const runsAdditions = runsGuard.additions();
  const attribution = runsAdditions.flatMap((a) => runsEntryAttribution(join(repoRoot, "runs"), a.file));
  const report = {
    // schemaVersion 5 (TD-248, 2026-10-10): ADDITIVE over 4 — autoAdjudicated[]
    // (verdict=pass 的例外来源，逐条登记册引用) 与 adjudicationAdvisories[]
    // （worker 上下文抑制等观察事实）。isolation[] 各项增 advisory 级
    // autoAdjudication 子对象。既有字段语义不变。
    schemaVersion: 5,
    generatedAt: new Date().toISOString(),
    runner: { name: "canonical-test", node: process.version, hardwareParallelism: HW, mode: "one-node-test-child-per-wave" },
    discoveredCount: discovered.length,
    executedCount: outcome.firstRound.passed + outcome.firstRound.failed + outcome.firstRound.missing + outcome.firstRound.crashed,
    executionWaves: outcome.waves,
    firstRound: outcome.firstRound,
    isolation: outcome.isolation,
    finalVerdict: outcome.finalVerdict,
    autoAdjudicated: outcome.autoAdjudicated ?? [],
    adjudicationAdvisories: outcome.adjudicationAdvisories ?? [],
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
    runsDirGuard: { additions: runsAdditions, error: runsGuardError, attribution },
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
  // R8-C C-5: the exit decision is the pinned pure function — precedence
  // report_write_failed > guard_error > runs_additions > verdict.
  const final = finalRunnerOutcome({ verdict: outcome.finalVerdict, runsAdditions, runsGuardError, reportWritten });
  console.error(`[canonical] verdict=${outcome.finalVerdict} discovered=${discovered.length} executed=${report.executedCount} passed=${passed} failed=${failed} missing=${missing} crashed=${crashed} isolation=${outcome.isolation.length} auto_adjudicated=${(outcome.autoAdjudicated ?? []).length} waves=${outcome.waves.length} runsGuard=${runsAdditions.length === 0 && !runsGuardError ? "clean" : `RED(+${runsAdditions.length})`} total=${totalMs}ms ⇒ ${reportPath}`);

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
  for (const evidence of attribution) console.log(runsAttributionLine(evidence));
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
    schemaVersion: 5,
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
