// test/isolation-infra/staticRunsGuard.test.js
//
// R8-C C-6 — LAYER 1 (PRIMARY) of the runs/ hygiene invariant.
//
// Invariant: "tests must NEVER point a run-dir/cwd at the repo-relative runs/"
// is a STATIC property of the test sources — it can be checked by READING the
// sources, with no time window at all. This scan is that check. The dynamic
// snapshot guard in scripts/canonical-test.mjs (R8-3) is the FALLBACK LAYER 2:
// the last net for shapes static analysis cannot see (indirect resolution the
// scanner does not model). Layer 2's known boundaries (same-wave
// write-then-delete, post-final-sweep grandchild flush, depth ≥2) do not
// weaken layer 1 — a construction written in source is visible here forever.
//
// Design contract (low false positives, explicit narrow whitelist):
//   - Only test/** SOURCE files are scanned (.js/.mjs/.cjs — the universe the
//     manifest tracks plus its helpers; fixtures/ holds data, not code paths).
//   - The DANGEROUS shape is a run-dir/cwd that resolves to THE REPO's runs/:
//     a bare relative "runs" (resolves against process cwd = repo root under
//     npm test) or a join with a REPO-ROOT-DERIVED base. The codebase's naming
//     convention is relied on as a contract: repo-root bases are spelled
//     REPO_ROOT / repoRoot / repo_root / WAO_ROOT; temp fixtures use dir /
//     repo / root from mkdtemp/makeRepo — bare `repo` is deliberately NOT a
//     marker (test/delivery/runDeliveryCli.test.js uses it for a TEMP git
//     repo's runs dir). join(dir, "runs") is the dominant LEGITIMATE shape
//     (tmpdir run-dir) and never fires.
//   - Every rule fires on a SINGLE LINE with a "runs" string literal in
//     double quotes (repo style). Multi-line indirection is layer-2 territory.
//   - The whitelist below is EXPLICIT and NARROW: a finding is suppressed only
//     when BOTH the file and the line pattern match, each entry carries a
//     reason, and a freshness test fails when an entry's file no longer
//     contains a matching line (dead whitelist entries must be pruned, not
//     accumulated).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Build quoted literals WITHOUT writing the matched shape into this file's own
// source (the real-tree sweep scans THIS file too — its fixtures must not flag
// themselves).
const Q = '"';
const q = (s) => Q + s + Q;

// ── Closed rule set ──────────────────────────────────────────────────────────
// id → single-line regex. Double-quoted literals only (repo style).
const RULES = [
  {
    id: "repo-root-join",
    regex: /(?:join|resolve)\(\s*(?:REPO_ROOT|repoRoot|repo_root|WAO_ROOT|process\.cwd\(\))\s*,\s*"runs(?:\/[^"]*)?"\s*\)/,
    why: "run-dir/cwd built from a REPO-ROOT-DERIVED base + runs ⇒ resolves into the repo's real runs/",
  },
  {
    id: "bare-runDir",
    regex: /\brunDir\s*[:=]\s*"runs(?:\/[^"]*)?"/,
    why: "bare relative runDir value resolves against process cwd = repo root under npm test",
  },
  {
    id: "bare-cwd",
    regex: /\bcwd\s*[:=]\s*"runs(?:\/[^"]*)?"/,
    why: "bare relative cwd value resolves against process cwd = repo root under npm test",
  },
  {
    id: "flag-run-dir",
    regex: /"--run-dir",\s*"runs(?:\/[^"]*)?"/,
    why: "CLI child spawned with --run-dir runs ⇒ its transcripts land in the repo's real runs/",
  },
  {
    id: "flag-cwd",
    regex: /"--cwd",\s*"runs(?:\/[^"]*)?"/,
    why: "CLI child spawned with --cwd runs ⇒ the worker runs in the repo's real runs/",
  },
];

// ── Explicit narrow whitelist ────────────────────────────────────────────────
// A finding is suppressed ONLY when both file and line match. Every entry
// carries the reason the reference is legitimate. The freshness test below
// fails when an entry stops matching anything (stale entry ⇒ prune it).
const WHITELIST = [
  {
    file: "isolation-infra/ownerDashboardInstallRoot.test.js",
    line: /\brunDir\s*[:=]\s*"runs"/,
    reason: "pure resolveConfigPath/rebaseConfigPaths INPUT — the value only flows through path-rebase pure functions to assert rebasing math; it is never dispatched to or written through",
  },
  {
    file: "mcp-surface/mcpBind.test.js",
    line: /(?:join|resolve)\(\s*REPO_ROOT\s*,\s*"runs"\s*\)/,
    reason: "expected-args fixture for the MCP registration argv COMPARISON (makeExpectedServer) — asserts what bind registers; no dispatch, no write",
  },
  {
    file: "mcp-surface/m12-12-semantics-mcp.test.js",
    line: /(?:join|resolve)\(\s*repoRoot\s*,\s*"runs"\s*\)/,
    reason: "read-only best-effort smoke over REAL transcripts (existsSync-guarded skip, bounded sample, never writes) — reading the real runs/ to smoke-test a pure selector is legitimate",
  },
  {
    file: "run-lifecycle/m12-9-smoke.test.js",
    line: /(?:join|resolve)\(\s*process\.cwd\(\)\s*,\s*"runs"\s*\)/,
    reason: "read-only robustness smoke over REAL transcripts (existsSync-guarded skip, per-file size + count caps, sha byte-identical assertion — provably never writes; found by this scanner's first real-tree run and judged legitimate 2026-08-17)",
  },
];

// ── Pure scan ────────────────────────────────────────────────────────────────
// sources: [{ file: "isolation-infra/x.test.js", text: "<full source>" }]
// Returns findings: [{ file, line, text, rule, whitelisted, reason? }].
// Whitelisted findings are returned with whitelisted=true so callers/tests can
// distinguish "suppressed" from "absent"; the real-tree assertion requires
// zero UNwhitelisted findings.
export function scanTestSourcesForRepoRunsDir(sources) {
  const findings = [];
  for (const src of sources) {
    const wl = WHITELIST.filter((w) => w.file === src.file);
    const lines = src.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const rule of RULES) {
        if (!rule.regex.test(lines[i])) continue;
        const hit = wl.find((w) => w.line.test(lines[i]));
        findings.push({
          file: src.file,
          line: i + 1,
          text: lines[i].trim(),
          rule: rule.id,
          whitelisted: Boolean(hit),
          reason: hit ? hit.reason : undefined,
        });
        break; // one rule per line is enough to report
      }
    }
  }
  return findings;
}

// ── Real-tree sweep helpers ──────────────────────────────────────────────────
const TEST_DIR = join(fileURLToPath(import.meta.url), "..", "..");
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

function discoverTestSources(testDir) {
  const out = [];
  function walk(d) {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else {
        const dot = entry.lastIndexOf(".");
        if (dot > 0 && SOURCE_EXTENSIONS.has(entry.slice(dot))) {
          out.push({ file: relative(testDir, p).split(sep).join("/"), text: readFileSync(p, "utf8") });
        }
      }
    }
  }
  walk(testDir);
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

// ── Unit tests over synthetic sources ────────────────────────────────────────

test("scan: repo-root-derived join with runs FIRES (the invariant's core shape)", () => {
  const findings = scanTestSourcesForRepoRunsDir([
    { file: "synthetic/a.test.js", text: `const runsDir = join(REPO_ROOT, ${q("runs")});` },
    { file: "synthetic/b.test.js", text: `const d = resolve(repoRoot, ${q("runs")});` },
    { file: "synthetic/c.test.js", text: `const d = join(process.cwd(), ${q("runs")});` },
  ]);
  assert.equal(findings.length, 3, "all three repo-root-derived shapes flag");
  assert.ok(findings.every((f) => f.rule === "repo-root-join" && !f.whitelisted));
});

test("scan: bare relative runDir/cwd values and bare --run-dir/--cwd flags FIRE", () => {
  const findings = scanTestSourcesForRepoRunsDir([
    { file: "synthetic/d.test.js", text: `const cfg = { runDir: ${q("runs")}, other: 1 };` },
    { file: "synthetic/e.test.js", text: `spawnSync(node, [${q("src/cli.js")}, ${q("runs")}, ${q("list")}])` },
    { file: "synthetic/f.test.js", text: `const opts = { cwd: ${q("runs")} };` },
    { file: "synthetic/g.test.js", text: `node, ${q("src/cli.js")}, ${q("run")}, x, ${q("--cwd")}, ${q("runs")}` },
  ]);
  // note: e.test.js uses a bare argv word "runs" (the runs COMMAND), not a
  // --run-dir value — it must NOT flag. The flag rules fire only on the
  // explicit flag shapes (see h/i below).
  assert.deepEqual(findings.map((f) => f.file), ["synthetic/d.test.js", "synthetic/f.test.js", "synthetic/g.test.js"],
    "runDir/cwd bare values + bare --cwd flag fire; a bare runs COMMAND word does not");
  const flagFindings = scanTestSourcesForRepoRunsDir([
    { file: "synthetic/h.test.js", text: `spawnSync(node, [cli, run, id, ${q("--run-dir")}, ${q("runs")}])` },
    { file: "synthetic/i.test.js", text: `spawnSync(node, [cli, run, id, ${q("--run-dir")}, ${q("runs/sub")}], { cwd: repo })` },
  ]);
  assert.equal(flagFindings.length, 2, "bare --run-dir runs (and runs/… subpaths) fire");
});

test("scan: the dominant LEGITIMATE shape join(dir, \"runs\") does NOT fire (tmpdir convention)", () => {
  const findings = scanTestSourcesForRepoRunsDir([
    { file: "synthetic/j.test.js", text: `const runDir = join(dir, ${q("runs")});` },
    { file: "synthetic/k.test.js", text: `const runDir = join(repo, ${q("runs")}); mkdirSync(runDir, { recursive: true });` },
    { file: "synthetic/l.test.js", text: `const runDir2 = path.join(dir2, ${q("runs")});` },
    { file: "synthetic/m.test.js", text: `runDir: join(root, ${q("runs")}), workspaceRoot: dir,` },
  ]);
  assert.deepEqual(findings, [],
    "dir/repo/root (temp-fixture names) + runs 是 tmpdir run-dir 惯例——不触发（低误报契约）");
});

test("scan: whitelist suppresses ONLY the exact file+line combo", () => {
  const wlEntry = WHITELIST[0];
  const sameTextElsewhere = `const cfg = { runDir: ${q("runs")} };`;
  const findings = scanTestSourcesForRepoRunsDir([
    { file: wlEntry.file, text: sameTextElsewhere }, // suppressed: whitelisted file + line
    { file: "synthetic/other.test.js", text: sameTextElsewhere }, // NOT suppressed: different file
  ]);
  assert.equal(findings.length, 2, "both produce findings; suppression is per-finding");
  assert.equal(findings[0].whitelisted, true, "whitelisted file+line combo is marked suppressed");
  assert.equal(findings[0].reason, wlEntry.reason, "suppressed finding carries the whitelist reason");
  assert.equal(findings[1].whitelisted, false, "the SAME line in a different file still flags — the whitelist is file-scoped, not text-scoped");
});

// ── Real-tree enforcement (the layer-1 gate) ─────────────────────────────────

test("REAL TREE: zero unwhitelisted repo-relative runs/ run-dir/cwd constructions in test/**", () => {
  const sources = discoverTestSources(TEST_DIR);
  assert.ok(sources.length > 100, `scan surface looks wrong (found ${sources.length} sources)`);
  const findings = scanTestSourcesForRepoRunsDir(sources);
  const violations = findings.filter((f) => !f.whitelisted);
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text}`),
    [],
    "test 源码不得构造指向仓库相对 runs/ 的 run-dir/cwd（静态主层；动态逃逸面归 canonical-test.mjs 快照守卫兜底）",
  );
  // The whitelist must actually be IN USE — each entry still matches ≥1 line in
  // its file. A stale entry (refactor removed the reference) must fail here so
  // it gets pruned instead of rotting.
  for (const w of WHITELIST) {
    const src = sources.find((s) => s.file === w.file);
    assert.ok(src, `whitelist entry file missing on disk: ${w.file}`);
    assert.ok(src.text.split(/\r?\n/).some((l) => w.line.test(l)),
      `whitelist entry no longer matches any line in ${w.file} — the reference was removed/refactored; prune the entry`);
  }
});

test("REAL TREE: scan surface includes helpers and this scanner itself (self-clean discipline)", () => {
  const sources = discoverTestSources(TEST_DIR);
  const names = new Set(sources.map((s) => s.file));
  assert.ok(names.has("isolation-infra/staticRunsGuard.test.js"), "scanner scans itself (its fixtures must stay literal-shape-free)");
  assert.ok([...names].some((n) => n.endsWith(".mjs")), "helper .mjs files are in scope");
  // Fixture discipline: this file's own source must not contain the raw matched
  // shapes — fixtures build quoted literals via q() so the sweep stays green.
  const self = sources.find((s) => s.file === "isolation-infra/staticRunsGuard.test.js");
  const selfFindings = scanTestSourcesForRepoRunsDir([self]);
  assert.deepEqual(selfFindings, [], "scanner 源码自身零命中（fixture 用 q() 拼接，不落原始形状）");
});
