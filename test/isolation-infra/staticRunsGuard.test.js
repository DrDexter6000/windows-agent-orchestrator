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
//
// R23-D (2026-08-21) — environment-blind-spot family. The guard additionally
// pins: a "registry"/"validate" argv pair on a single line WITHOUT --run-dir on
// that same line ⇒ the CLI child resolves config.runDir ("runs") against the
// repo root and reads the REAL runs/reliability-summary.json ledger (present on
// main, absent in delivery-verification worktrees — advisory output silently
// diverges between the two). Scope this round: the validate family ONLY; the
// wider bare-default family (registry list, execSync string-form spawns,
// dashboard --cwd) is registered as a follow-up trigger in
// docs/milestone-discipline.md §7 — deliberately NOT pinned here yet.

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
//
// R23-D shapes are built via q()/string concat (same self-clean discipline as
// the fixtures): this file's own source must never contain a raw matched line.
const RUN_DIR_FLAG = "--run-dir";
const VALIDATE_ARGV = q("registry") + ",\\s*" + q("validate");

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
  {
    // R23-D：validate 族环境盲区。argv 形状单行出现而同行无 --run-dir → 红。
    // 同行带 --run-dir（d368e5f 隔离惯例）即合法——多行 argv 的 token 行也必须
    // 把 flag 写在同一行（单行约定，机械可扫）。
    id: "validate-no-run-dir",
    // R23-D Lead 补全（auditor F4）：--run-dir 必须出现在 validate token 之后——
    // 行内更早位置或无关字符串里的字面量不再免疫真实裸调。
    regex: new RegExp(VALIDATE_ARGV + "(?!.*" + RUN_DIR_FLAG + ")"),
    why: 'registry validate spawned WITHOUT a same-line --run-dir ⇒ the child resolves config.runDir ("runs") against the repo root and reads the REAL runs/reliability-summary.json ledger (R23-D blind spot: on main yes, in delivery-verification worktrees no). Fix: append "--run-dir", join(dir, "runs-none") on the SAME line as the validate tokens (d368e5f isolation convention)',
  },
  {
    // R23-D Lead 补全（auditor F2 + coder_mm"没问但该问"）：字符串形命令——模板串里
    // 出现 registry validate/list 而串内无 --run-dir → 红。覆盖 runCliOnPathNode /
    // execSync 模板串（本轮亲手清扫过的形状，此前守卫结构上看不见）。
    id: "registry-cmd-string-no-run-dir",
    // 命令形约束：registry validate/list 后必须紧跟 flag（--）或插值（${）——
    // 排除注释/散文里的 `registry validate` 反引号引用（低误报契约）。
    regex: /`(?=[^`\n]*\bregistry\s+(?:validate|list)\s+(?:--|\$\{))(?![^`\n]*--run-dir)[^`\n]*`/,
    why: 'template-string registry validate/list WITHOUT --run-dir inside the same template ⇒ reads the REAL runs/ ledger (string form is invisible to the argv rule; R23-D auditor F2)',
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

// ── R23-D: validate-no-run-dir 规则（环境盲区族，本轮唯一新钉）──────────────

test("scan R23-D: validate argv WITHOUT same-line --run-dir FIRES（单行裸 token 行同红）；同行带 --run-dir 不触发", () => {
  const bareSingleLine = `const r = runCli([node, ${q("src/cli.js")}, ${q("registry")}, ${q("validate")}, ${q("--registry")}, regPath]);`;
  const bareMultiLineTokenRow = `      ${q("registry")}, ${q("validate")},`;
  const isolatedSameLine = `spawnSync(node, [${q("src/cli.js")}, ${q("registry")}, ${q("validate")}, ${q("--run-dir")}, join(dir, ${q("runs-none")})]);`;
  const findings = scanTestSourcesForRepoRunsDir([
    { file: "synthetic/r23d-bare.test.js", text: bareSingleLine },
    { file: "synthetic/r23d-multiline.test.js", text: bareMultiLineTokenRow },
    { file: "synthetic/r23d-isolated.test.js", text: isolatedSameLine },
  ]);
  assert.deepEqual(findings.map((f) => [f.file, f.rule]), [
    ["synthetic/r23d-bare.test.js", "validate-no-run-dir"],
    ["synthetic/r23d-multiline.test.js", "validate-no-run-dir"],
  ], "同一行的裸 validate token 红及携带它的多行 argv 裸 token 行红（token 与 flag 必须同行——单行是约定不是不变量，真拆行由字符串形/评审兜）；同行带 --run-dir 的隔离形状不触发");
  // 红灯必须自带修法指引：finding 的 rule 可回查 RULES[].why（REAL TREE 断言
  // 把 why 拼进失败消息，见下）。
  assert.match(RULES.find((r) => r.id === "validate-no-run-dir").why, /--run-dir/,
    "规则 why 必须给出修法指引（--run-dir 同行惯例）");
});

test("scan R23-D 补全: 字符串形 registry validate/list 模板串无 --run-dir FIRES；串内带 --run-dir 不触发", () => {
  // R23-D Lead 补全（auditor F2）：本轮亲手清扫过的 execSync/runCliOnPathNode 形状。
  const bareStringValidate = "const out = runCliOnPathNode(`registry " + "validate --registry ${p}`);";
  const bareStringList = "const out = execSync(`node src/cli.js registry " + "list --registry ${p} --format json`);";
  const isolatedString = 'const out = runCliOnPathNode(`registry ' + 'validate --registry ${p} --run-dir ${join(dir, "runs-none")}`);';
  const unrelatedTemplate = "const msg = `registry of things`;"; // 无 validate/list 命令形——不触发（低误报）
  const findings = scanTestSourcesForRepoRunsDir([
    { file: "synthetic/r23d-str-bare-validate.test.js", text: bareStringValidate },
    { file: "synthetic/r23d-str-bare-list.test.js", text: bareStringList },
    { file: "synthetic/r23d-str-isolated.test.js", text: isolatedString },
    { file: "synthetic/r23d-str-unrelated.test.js", text: unrelatedTemplate },
  ]);
  assert.deepEqual(findings.map((f) => [f.file, f.rule]), [
    ["synthetic/r23d-str-bare-validate.test.js", "registry-cmd-string-no-run-dir"],
    ["synthetic/r23d-str-bare-list.test.js", "registry-cmd-string-no-run-dir"],
  ], "字符串形裸命令红（validate 与 list 两族）；串内带 --run-dir 或非命令形模板不触发");
  assert.match(RULES.find((r) => r.id === "registry-cmd-string-no-run-dir").why, /--run-dir/,
    "字符串形规则 why 必须给出修法指引");
});

// ── Real-tree enforcement (the layer-1 gate) ─────────────────────────────────

test("REAL TREE: zero unwhitelisted repo-relative runs/ run-dir/cwd constructions in test/**", () => {
  const sources = discoverTestSources(TEST_DIR);
  assert.ok(sources.length > 100, `scan surface looks wrong (found ${sources.length} sources)`);
  const findings = scanTestSourcesForRepoRunsDir(sources);
  const violations = findings.filter((f) => !f.whitelisted);
  // R23-D：失败消息自带修法指引——file:line + 命中行 + 该规则的 why（修法）。
  const ruleWhy = (id) => RULES.find((r) => r.id === id)?.why ?? "";
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text} ⇒ 修法: ${ruleWhy(v.rule)}`),
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
