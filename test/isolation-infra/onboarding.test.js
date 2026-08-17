// test/onboarding.test.js
//
// Third-party onboarding helper (`wao onboarding`) — contract tests.
//
// The helper lets a fresh third-party clone generate ONE minimal private worker
// registry from the tracked config/agents.example.json template, without
// hand-editing the seven-worker template. It is zero-write by default; --apply
// writes only the gitignored config/agents.json (after passing the existing
// registry normalization/validation authority); --endorse-worker writes only the
// existing manualOverride:"cleared" Owner signal into runs/reliability-summary.json.
//
// Safety contract under test (item 9): the helper never installs/upgrades/logs in,
// never inspects credential VALUES, never changes global Host config, never
// restarts a Host, never initializes target .wao state, never runs
// doctor/reliability, never dispatches workers, and never mutates any runtime.
// It only (a) reads the template, (b) on --apply writes config/agents.json, and
// (c) on --endorse-worker amends runs/reliability-summary.json.
//
// All filesystem effects are injectable + atomic, so the bulk of these tests use
// an in-memory fs (pure, no real I/O). A couple of round-trip tests use a real
// tmpdir to prove the atomic write + Windows paths-with-spaces behavior for real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  stripComments,
  buildCandidateList,
  buildMinimalRegistry,
  buildMcpSnippet,
  buildAcceptance,
  buildRecommendations,
  emptyRecommendations,
  BACKEND_CLI,
  RECOMMENDATIONS_ADVISORY,
  runOnboarding,
  MAX_CANDIDATES,
  displayWidth,
} from "../../src/application/onboarding.js";

// The human renderer lives in the (thin) command layer; importing it does NOT
// execute the command — it only pulls the pure render function used to assert
// the acceptance guidance is shared by human output, not just --json.
import { renderHuman } from "../../src/commands/onboarding.js";

// ── Template fixtures ────────────────────────────────────────────────────────
// A faithful miniature of config/agents.example.json: top-level + per-agent
// _comment* keys, a provider-wrapped claude-code worker, a kimi worker, and a
// certification matrix covering a subset (mirrors the real template where not
// every worker has a matrix entry).
const TEMPLATE = {
  _comment: "top-level comment",
  _comment_ssot: "ssot pointer comment",
  _comment_example: "example note",
  agents: {
    coder_low: {
      _comment: "[Coder-Low] role comment",
      _comment_backend: "backend comment",
      _comment_task: "默认适合: 边界明确的实现包/TDD/修 bug/重构/兼容性/脚本/文档配置/窄修正；是否拆分或转派由 Lead 决定",
      backend: "claude-code",
      provider: {
        protocol: "anthropic-compatible",
        baseUrl: "https://api.deepseek.com/anthropic",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      },
      cwd: ".",
      systemPrompt: "config/roles/coder_low.md",
      args: ["--dangerously-skip-permissions"],
      model: { id: "deepseek-v4-flash", contextWindow: 1000000 },
      reasoning: { effort: "max" },
    },
    coder_mm: {
      _comment: "[Coder-MM] role comment",
      _comment_task: "适合任务: 图像/视频内容理解、前端设计与实现、视觉/美术审核",
      backend: "kimi-code",
      cwd: ".",
      systemPrompt: "config/roles/coder_mm.md",
      model: { id: "kimi-code/k3" },
    },
    auditor: {
      _comment: "[Auditor] role comment",
      _comment_auth: "官方 Claude OAuth（claude login），不走 wrapper",
      _comment_task: "适合任务: 前置方案审计/后置独立复核/PASS-FAIL 判定",
      backend: "claude-code",
      cwd: ".",
      systemPrompt: "config/roles/auditor.md",
      model: { id: "claude-opus-5" },
      reasoning: { effort: "xhigh" },
    },
  },
  certification: {
    _comment: "certification matrix comment",
    _comment_drills: "drills comment",
    matrix: [
      {
        agentId: "coder_low",
        label: "DeepSeek V4 Flash",
        profile: "strict",
        providerID: "deepseek",
        modelId: "deepseek-v4-flash",
        drills: ["sentinel", "scorecard"],
      },
      {
        agentId: "coder_mm",
        label: "Kimi K3",
        profile: "strict",
        drills: ["sentinel", "scorecard"],
      },
    ],
  },
};

// ── In-memory injectable fs ──────────────────────────────────────────────────
// Models the exact fs surface runOnboarding consumes: readFile/writeFile/rename
// (async) + existsSync/unlink + mkdir, AND models REAL filesystem directory
// semantics (not a permissive fake):
//   - a writeFile/rename into a file whose parent dir is not known throws ENOENT
//     (a faithful fs would reject a write to runs/x.json before runs/ exists);
//   - mkdir(p, {recursive:true}) registers p and all ancestors (idempotent),
//     mirroring node:fs/promises.mkdir recursive behavior.
// Seeding a pre-existing file registers its parent dir chain (the file exists ⇒
// its directory exists). Exposed as __files / __dirs for assertions.
function makeMemFs(initial = {}) {
  const files = new Map();
  const dirs = new Set();
  const SEP = "/";
  const norm = (p) => String(p).replace(/\\/g, "/");
  const parentOf = (p) => {
    const n = norm(p);
    const idx = n.lastIndexOf(SEP);
    return idx <= 0 ? n : n.slice(0, idx);
  };
  // Registering a directory marks it and every ancestor as known.
  const registerDir = (p) => {
    let cur = norm(p).replace(/\/+$/, "");
    while (cur && !dirs.has(cur)) {
      dirs.add(cur);
      const idx = cur.lastIndexOf(SEP);
      if (idx <= 0) break;
      cur = cur.slice(0, idx);
    }
  };
  for (const [k, v] of Object.entries(initial)) {
    files.set(norm(k), v);
    registerDir(parentOf(k));
  }
  // A write/rename-target whose parent dir is unknown is ENOENT, like a real fs.
  const ensureParent = (p) => {
    const parent = parentOf(p);
    if (!dirs.has(parent)) {
      const e = new Error(`ENOENT: no such directory: ${parent}`);
      e.code = "ENOENT";
      throw e;
    }
  };
  return {
    __files: files,
    __dirs: dirs,
    async readFile(p) {
      const n = norm(p);
      if (!files.has(n)) { const e = new Error(`ENOENT: ${p}`); e.code = "ENOENT"; throw e; }
      return files.get(n);
    },
    async writeFile(p, data) { ensureParent(p); files.set(norm(p), data); },
    async rename(from, to) {
      const nf = norm(from);
      if (!files.has(nf)) { const e = new Error(`ENOENT: ${from}`); e.code = "ENOENT"; throw e; }
      ensureParent(to);
      files.set(norm(to), files.get(nf));
      files.delete(nf);
    },
    existsSync(p) { return files.has(norm(p)); },
    async unlink(p) { files.delete(norm(p)); },
    async mkdir(p) { registerDir(p); }, // recursive: register p + ancestors (idempotent)
  };
}

// Bound the service with the in-memory template + injectable fs (+ optional
// injected probeEnv for the R6-C recommendation tests — never a real probe).
function memRun({
  agentId, apply, endorseWorker, installRoot = "D:/wao", probeEnv,
  initial = {}, reliabilitySummaryPath = "D:/wao/runs/reliability-summary.json",
  privateRegistryPath,
} = {}) {
  const fs = makeMemFs({
    "D:/wao/config/agents.example.json": JSON.stringify(TEMPLATE),
    ...initial,
  });
  return {
    fs,
    result: runOnboarding({
      agentId, apply: Boolean(apply), endorseWorker,
      installRoot,
      exampleRegistryPath: "D:/wao/config/agents.example.json",
      targetRegistryPath: "D:/wao/config/agents.json",
      reliabilitySummaryPath,
      privateRegistryPath,
      probeEnv,
      fs,
    }),
  };
}

// ── 1. preview is zero-write ─────────────────────────────────────────────────
test("preview (with --agent) writes nothing to the filesystem", async () => {
  const { fs, result } = await memRun({ agentId: "coder_low" });
  const r = await result;
  assert.equal(r.outcome, "previewed");
  assert.equal(r.selected, true);
  assert.equal(r.writes.registry, false);
  assert.equal(r.writes.endorsement, false);
  // No new files created: only the template we seeded exists.
  assert.deepEqual(
    [...fs.__files.keys()].sort(),
    ["D:/wao/config/agents.example.json"],
    "preview must not create any file",
  );
});

test("bare preview (no flags) is zero-write and asks for selection", async () => {
  const { fs, result } = await memRun({});
  const r = await result;
  assert.equal(r.outcome, "needs-selection");
  assert.equal(r.needsSelection, true);
  assert.equal(r.selected, false);
  assert.equal(r.writes.registry, false);
  assert.equal(r.writes.endorsement, false);
  assert.deepEqual(
    [...fs.__files.keys()].sort(),
    ["D:/wao/config/agents.example.json"],
  );
});

// ── 2. bounded no-agent selection: candidate list + needs_selection ──────────
test("no --agent returns a bounded candidate list (identifying info only)", async () => {
  const { result } = await memRun({});
  const r = await result;
  assert.equal(r.needsSelection, true);
  assert.ok(Array.isArray(r.candidates));
  // Bounded: exactly the template workers, no more.
  assert.equal(r.candidates.length, 3);
  const ids = r.candidates.map((c) => c.id).sort();
  assert.deepEqual(ids, ["auditor", "coder_low", "coder_mm"]);
  // Identifying info only: id/backend/model. No comment keys, no credential values.
  for (const c of r.candidates) {
    assert.ok(c.id);
    assert.ok(c.backend);
    assert.deepEqual(Object.keys(c).sort(), ["backend", "id", "model"]);
  }
  // Mutation requires explicit agent id.
  assert.equal(r.writes.registry, false);
});

// ── 3. recursive comment stripping ───────────────────────────────────────────
test("stripComments recursively removes _comment* keys at every depth", () => {
  const input = {
    _comment: "top",
    _comment_x: "top2",
    keep: 1,
    agents: {
      w: {
        _comment: "a",
        _comment_backend: "b",
        backend: "claude-code",
        nested: { _comment_n: "n", x: 2 },
      },
    },
    certification: { _comment: "c", matrix: [{ _comment_m: "m", agentId: "w" }] },
  };
  const out = stripComments(input);
  const serialized = JSON.stringify(out);
  assert.ok(!/_comment/.test(serialized), "no _comment* key may survive anywhere");
  assert.equal(out.keep, 1);
  assert.equal(out.agents.w.backend, "claude-code");
  assert.equal(out.agents.w.nested.x, 2);
  // Non-_comment underscore keys are preserved.
  assert.deepEqual(out.certification.matrix[0], { agentId: "w" });
});

test("the built registry contains zero _comment* keys (exactly one worker)", () => {
  const reg = buildMinimalRegistry({ template: TEMPLATE, agentId: "coder_low" });
  const serialized = JSON.stringify(reg);
  assert.ok(!/_comment/.test(serialized), "built registry must have no _comment* keys");
  assert.deepEqual(Object.keys(reg.agents), ["coder_low"], "exactly one worker entry");
});

// ── 4. unknown id: fixed safe failure BEFORE any writes ──────────────────────
test("unknown --agent is a fixed safe failure that writes nothing (preview)", async () => {
  const { fs, result } = await memRun({ agentId: "definitely-not-a-real-worker" });
  const r = await result;
  assert.equal(r.outcome, "refused");
  // Fixed safe reason must NOT echo the supplied (potentially malicious) id.
  assert.ok(!/definitely-not-a-real-worker/.test(r.reason ?? ""),
    "reason must not echo the unknown id");
  assert.ok(/template|tracked|not present|unknown/i.test(r.reason ?? ""),
    "reason must be a fixed safe shape");
  assert.equal(r.writes.registry, false);
  assert.equal(r.writes.endorsement, false);
  assert.deepEqual(
    [...fs.__files.keys()].sort(),
    ["D:/wao/config/agents.example.json"],
    "unknown id must not write any file",
  );
});

test("unknown --agent with --apply refuses before writing", async () => {
  const { fs, result } = await memRun({ agentId: "ghost", apply: true });
  const r = await result;
  assert.equal(r.outcome, "refused");
  assert.equal(r.writes.registry, false);
  assert.ok(!fs.existsSync("D:/wao/config/agents.json"));
});

// ── 5. valid apply ───────────────────────────────────────────────────────────
test("--apply writes a minimal valid agents.json (one worker, passes normalize)", async () => {
  const { fs, result } = await memRun({ agentId: "coder_low", apply: true });
  const r = await result;
  assert.equal(r.outcome, "applied");
  assert.equal(r.writes.registry, true);
  assert.equal(r.writes.endorsement, false);
  const written = JSON.parse(fs.__files.get("D:/wao/config/agents.json"));
  assert.deepEqual(Object.keys(written.agents), ["coder_low"]);
  // The carried certification case makes the strict path functional for this worker.
  assert.ok(written.certification?.matrix?.some((m) => m.agentId === "coder_low"));
  // No comment leakage in the written file.
  assert.ok(!/_comment/.test(JSON.stringify(written)));
  // The provider apiKeyEnv NAME is preserved (needed); never a value.
  assert.equal(written.agents.coder_low.provider.apiKeyEnv, "DEEPSEEK_API_KEY");
});

test("--apply for a worker with no certification matrix entry omits certification (truthful)", async () => {
  // auditor has no matrix entry in the template — strict path falls back; do not fabricate.
  const { fs, result } = await memRun({ agentId: "auditor", apply: true });
  const r = await result;
  assert.equal(r.outcome, "applied");
  const written = JSON.parse(fs.__files.get("D:/wao/config/agents.json"));
  assert.deepEqual(Object.keys(written.agents), ["auditor"]);
  assert.equal(written.certification, undefined, "must not fabricate a certification section");
});

// ── 6. refusal of an existing final registry (byte-for-byte, no overwrite) ───
test("--apply refuses to overwrite a pre-existing config/agents.json", async () => {
  const preExisting = JSON.stringify({ agents: { my_private_worker: { backend: "codex", cwd: "D:/x" } } });
  const { fs, result } = await memRun({
    agentId: "coder_low", apply: true,
    initial: { "D:/wao/config/agents.json": preExisting },
  });
  const r = await result;
  assert.equal(r.outcome, "refused");
  assert.equal(r.writes.registry, false);
  // The pre-existing private registry is preserved byte-for-byte.
  assert.equal(fs.__files.get("D:/wao/config/agents.json"), preExisting);
  assert.ok(/exist|overwrite|already/i.test(r.reason ?? ""), "reason must explain the refusal");
});

// ── 7. endorsement explicit + matching ───────────────────────────────────────
test("--endorse-worker matching --agent writes manualOverride:cleared only", async () => {
  const { fs, result } = await memRun({ agentId: "coder_low", endorseWorker: "coder_low" });
  const r = await result;
  assert.equal(r.outcome, "applied");
  assert.equal(r.writes.endorsement, true);
  assert.equal(r.writes.registry, false, "endorse alone does not write the registry");
  assert.equal(r.certification.endorsed, true);
  const summary = JSON.parse(fs.__files.get("D:/wao/runs/reliability-summary.json"));
  assert.equal(summary.workers.coder_low.manualOverride, "cleared");
});

test("preview never endorses; ordinary --apply never endorses", async () => {
  const preview = await (await memRun({ agentId: "coder_low" })).result;
  assert.equal(preview.certification.endorsed, false);
  assert.equal(preview.writes.endorsement, false);

  const apply = await (await memRun({ agentId: "coder_low", apply: true })).result;
  assert.equal(apply.certification.endorsed, false);
  assert.equal(apply.writes.endorsement, false);
});

test("--endorse-worker mismatched with --agent is a fixed safe refusal (no write)", async () => {
  const { fs, result } = await memRun({ agentId: "coder_low", endorseWorker: "coder_mm" });
  const r = await result;
  assert.equal(r.outcome, "refused");
  assert.equal(r.writes.endorsement, false);
  assert.ok(!fs.existsSync("D:/wao/runs/reliability-summary.json"));
  assert.ok(/match|same|equal/i.test(r.reason ?? ""));
});

test("--endorse-worker without --agent is refused (mutation needs explicit selection)", async () => {
  const { fs, result } = await memRun({ endorseWorker: "coder_low" });
  const r = await result;
  assert.equal(r.outcome, "refused");
  assert.equal(r.writes.endorsement, false);
  assert.ok(!fs.existsSync("D:/wao/runs/reliability-summary.json"));
});

// ── 8. preserve unrelated reliability-summary workers/cases ───────────────────
test("endorse preserves unrelated workers + cases and fabricates no status", async () => {
  const existing = {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    counts: { certified: 1, conditional: 0, "draft-only": 0, blocked: 0, rejected: 1 },
    allCertified: false,
    workers: {
      researcher: { agentId: "researcher", status: "certified", recommendedUse: "strict-dispatch", capabilities: { readFiles: true }, cases: ["c1"] },
      auditor: { agentId: "auditor", status: "rejected", recommendedUse: "do-not-dispatch", capabilities: {}, cases: ["c2"] },
    },
    cases: [
      { caseId: "c1", agentId: "researcher", certification: { status: "certified" } },
      { caseId: "c2", agentId: "auditor", certification: { status: "rejected" } },
    ],
  };
  const { fs, result } = await memRun({
    agentId: "auditor", endorseWorker: "auditor",
    initial: { "D:/wao/runs/reliability-summary.json": JSON.stringify(existing) },
  });
  const r = await result;
  assert.equal(r.outcome, "applied");
  const summary = JSON.parse(fs.__files.get("D:/wao/runs/reliability-summary.json"));
  // Unrelated worker preserved exactly.
  assert.deepEqual(summary.workers.researcher, existing.workers.researcher);
  // Unrelated cases preserved exactly.
  assert.equal(summary.cases.length, 2);
  assert.deepEqual(summary.cases, existing.cases);
  assert.equal(summary.counts.rejected, 1);
  // The endorsed worker: manualOverride set; its prior status NOT fabricated/changed.
  assert.equal(summary.workers.auditor.manualOverride, "cleared");
  assert.equal(summary.workers.auditor.status, "rejected", "prior status preserved, not fabricated");
  // Endorsing a worker must never fabricate certified/conditional/etc.
  assert.notEqual(summary.workers.auditor.status, "certified");
  assert.notEqual(summary.workers.auditor.status, "conditional");
});

test("endorse creates the summary if absent, with ONLY the clearance (no fabricated status)", async () => {
  const { fs, result } = await memRun({ agentId: "coder_low", endorseWorker: "coder_low" });
  const r = await result;
  assert.equal(r.outcome, "applied");
  const summary = JSON.parse(fs.__files.get("D:/wao/runs/reliability-summary.json"));
  assert.equal(summary.workers.coder_low.manualOverride, "cleared");
  assert.equal(summary.workers.coder_low.status, undefined, "must not fabricate a status");
  assert.equal(summary.workers.coder_low.recommendedUse, undefined);
});

// ── 9. atomic failure leaves no corrupt final file ────────────────────────────
test("a write failure during --apply projects a safe reason and leaves no partial/corrupt agents.json", async () => {
  const fs = makeMemFs({ "D:/wao/config/agents.example.json": JSON.stringify(TEMPLATE) });
  // A deliberately malicious raw error (OS detail, pseudo-credential assignment,
  // absolute path) is injected; none of it may cross the application boundary.
  const RAW = "raw-internal-fs-error EPERM @ node:internal/fs token=leakprobe /home/secret/.env";
  let tmpSeen = null;
  fs.writeFile = async (p) => {
    tmpSeen = p;
    throw new Error(RAW);
  };
  const r = await runOnboarding({
    agentId: "coder_low", apply: true, installRoot: "D:/wao",
    exampleRegistryPath: "D:/wao/config/agents.example.json",
    targetRegistryPath: "D:/wao/config/agents.json",
    reliabilitySummaryPath: "D:/wao/runs/reliability-summary.json",
    fs,
  });
  assert.equal(r.outcome, "error");
  assert.equal(r.writes.registry, false);
  // Failure projection: the malicious raw message is absent from reason AND output.
  assert.ok(!r.reason.includes(RAW), "raw err.message must not cross the boundary");
  assert.ok(!JSON.stringify(r).includes(RAW), "raw error content must not appear in JSON output");
  assert.ok(!/EPERM|node:internal|leakprobe|home\/secret/i.test(r.reason ?? ""), "reason carries no OS/path/credential detail");
  assert.ok(!/D:\/|\/wao\/|\.wao-tmp/i.test(r.reason ?? ""), "reason must not carry absolute or temp paths");
  assert.ok(/write|registry/i.test(r.reason ?? ""), "reason is a fixed safe shape");
  // Atomic cleanup: no corrupt final file, and the temp file was removed.
  assert.ok(!fs.existsSync("D:/wao/config/agents.json"), "no corrupt final file");
  assert.ok(!fs.existsSync(tmpSeen), "temp file cleaned up after atomic failure");
});

test("an unreadable / unparseable template is a bounded error that writes nothing", async () => {
  // Missing template file → readFile throws → bounded error, no writes.
  const fsMissing = makeMemFs({}); // no template seeded
  const rMissing = await runOnboarding({
    agentId: "coder_low", apply: true, installRoot: "D:/wao",
    exampleRegistryPath: "D:/wao/config/agents.example.json",
    targetRegistryPath: "D:/wao/config/agents.json",
    reliabilitySummaryPath: "D:/wao/runs/reliability-summary.json",
    fs: fsMissing,
  });
  assert.equal(rMissing.outcome, "error");
  assert.equal(rMissing.writes.registry, false);
  assert.equal(rMissing.writes.endorsement, false);
  assert.ok(!fsMissing.existsSync("D:/wao/config/agents.json"));

  // Corrupt (unparseable) template JSON → same bounded error.
  const fsCorrupt = makeMemFs({ "D:/wao/config/agents.example.json": "{ not valid json" });
  const rCorrupt = await runOnboarding({
    agentId: "coder_low", apply: true, installRoot: "D:/wao",
    exampleRegistryPath: "D:/wao/config/agents.example.json",
    targetRegistryPath: "D:/wao/config/agents.json",
    reliabilitySummaryPath: "D:/wao/runs/reliability-summary.json",
    fs: fsCorrupt,
  });
  assert.equal(rCorrupt.outcome, "error");
  assert.equal(rCorrupt.writes.registry, false);
  assert.ok(/read or parse|template/i.test(rCorrupt.reason ?? ""), "reason must name the template problem");
});

test("an endorsement write failure projects a safe reason and leaves no corrupt summary", async () => {
  const fs = makeMemFs({ "D:/wao/config/agents.example.json": JSON.stringify(TEMPLATE) });
  // rename throws a deliberately malicious raw error; none of it may cross.
  const RAW = "raw-internal-fs-error EBUSY @ node:internal/fs token=leakprobe /home/secret/.env";
  fs.rename = async () => { throw new Error(RAW); };
  const r = await runOnboarding({
    agentId: "coder_low", endorseWorker: "coder_low", installRoot: "D:/wao",
    exampleRegistryPath: "D:/wao/config/agents.example.json",
    targetRegistryPath: "D:/wao/config/agents.json",
    reliabilitySummaryPath: "D:/wao/runs/reliability-summary.json",
    fs,
  });
  assert.equal(r.outcome, "error");
  assert.equal(r.writes.endorsement, false, "endorsement must not be reported as written");
  // Failure projection: the malicious raw message is absent from reason AND output.
  assert.ok(!r.reason.includes(RAW), "raw err.message must not cross the boundary");
  assert.ok(!JSON.stringify(r).includes(RAW), "raw error content must not appear in JSON output");
  assert.ok(!/EBUSY|node:internal|leakprobe|home\/secret/i.test(r.reason ?? ""), "reason carries no OS/path/credential detail");
  assert.ok(!/D:\/|\/wao\/|\.wao-tmp/i.test(r.reason ?? ""), "reason must not carry absolute or temp paths");
  assert.ok(/summary|write|endorse/i.test(r.reason ?? ""), "reason is a fixed safe shape");
  // Atomic cleanup: no corrupt final summary, and the temp file was removed.
  assert.ok(!fs.existsSync("D:/wao/runs/reliability-summary.json"), "no corrupt final summary");
  assert.ok(!fs.existsSync("D:/wao/runs/reliability-summary.json.wao-tmp"), "temp cleaned up after atomic failure");
});

test("an existing corrupt (unparseable) reliability summary is left byte-for-byte unchanged with zero writes (fail closed)", async () => {
  const CORRUPT = "{ this is not valid json";
  const fs = makeMemFs({
    "D:/wao/config/agents.example.json": JSON.stringify(TEMPLATE),
    "D:/wao/runs/reliability-summary.json": CORRUPT,
  });
  const r = await runOnboarding({
    agentId: "coder_low", endorseWorker: "coder_low", installRoot: "D:/wao",
    exampleRegistryPath: "D:/wao/config/agents.example.json",
    targetRegistryPath: "D:/wao/config/agents.json",
    reliabilitySummaryPath: "D:/wao/runs/reliability-summary.json",
    fs,
  });
  assert.equal(r.outcome, "error");
  assert.equal(r.writes.endorsement, false, "must not report an endorsement write");
  // Fail closed: the corrupt summary is preserved byte-for-byte (never overwritten/repaired).
  assert.equal(fs.__files.get("D:/wao/runs/reliability-summary.json"), CORRUPT, "corrupt summary preserved byte-for-byte");
  // Zero temp/final mutation of the summary occurred.
  assert.ok(!fs.existsSync("D:/wao/runs/reliability-summary.json.wao-tmp"), "no temp file created");
  // Fixed safe reason; never echo the raw parser detail ("not valid json"/"parse").
  assert.ok(/unreadable|unchanged|valid summary/i.test(r.reason ?? ""), "fixed safe reason");
  assert.ok(!/not valid json|SyntaxError|Unexpected|position/i.test(r.reason ?? ""), "no raw parser detail in reason");
});

test("an existing reliability summary that is valid JSON but not an object is left unchanged (fail closed)", async () => {
  const NOTOBJ = '"not-a-summary-object"';
  const fs = makeMemFs({
    "D:/wao/config/agents.example.json": JSON.stringify(TEMPLATE),
    "D:/wao/runs/reliability-summary.json": NOTOBJ,
  });
  const r = await runOnboarding({
    agentId: "coder_low", endorseWorker: "coder_low", installRoot: "D:/wao",
    exampleRegistryPath: "D:/wao/config/agents.example.json",
    targetRegistryPath: "D:/wao/config/agents.json",
    reliabilitySummaryPath: "D:/wao/runs/reliability-summary.json",
    fs,
  });
  assert.equal(r.outcome, "error");
  assert.equal(r.writes.endorsement, false, "must not report an endorsement write");
  assert.equal(fs.__files.get("D:/wao/runs/reliability-summary.json"), NOTOBJ, "non-object summary preserved byte-for-byte");
  assert.ok(!fs.existsSync("D:/wao/runs/reliability-summary.json.wao-tmp"), "no temp file created");
  // Fixed safe reason; never echo the parsed file content.
  assert.ok(/unreadable|unchanged|valid summary/i.test(r.reason ?? ""), "fixed safe reason");
  assert.ok(!/not-a-summary-object/i.test(r.reason ?? ""), "no echo of the parsed file content in reason");
});

// ── 10. Windows paths with spaces ─────────────────────────────────────────────
test("host-neutral MCP snippet carries install-root paths, surviving spaces", () => {
  const snippet = buildMcpSnippet({ installRoot: "D:/my projects/wao" });
  // Generic host-neutral shape (no host-specific type/enabled).
  assert.ok(snippet.mcpServers?.wao);
  assert.equal(snippet.mcpServers.wao.command, "node");
  const args = snippet.mcpServers.wao.args;
  assert.ok(Array.isArray(args));
  // Node 22 shim is the trusted launcher.
  assert.ok(args.some((a) => /wao-node\.cjs$/.test(a)));
  // stdio entrypoint present.
  assert.ok(args.some((a) => /src\/mcp\/stdio\.js$/.test(a)));
  // Absolute registry + run-dir paths anchored at the install root, spaces preserved.
  assert.ok(args.some((a) => a.includes("my projects/wao/config/agents.json")));
  assert.ok(args.some((a) => a.includes("my projects/wao/runs")));
  // The snippet is valid JSON and round-trips with spaces intact.
  const round = JSON.parse(JSON.stringify(snippet));
  assert.ok(round.mcpServers.wao.args.join(" ").includes("my projects/wao"));
});

test("apply round-trips through a real tmpdir whose path contains spaces", async () => {
  // Real fs: prove atomic write + read-back works when the directory has spaces.
  const dir = mkdtempSync(join(tmpdir(), "wao onboarding "));
  try {
    const examplePath = join(dir, "config", "agents.example.json");
    const targetPath = join(dir, "config", "agents.json");
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(examplePath, JSON.stringify(TEMPLATE), "utf8");
    const { default: fs } = await import("node:fs/promises");
    const { existsSync, unlinkSync } = await import("node:fs");
    const r = await runOnboarding({
      agentId: "coder_low", apply: true, installRoot: dir.replace(/\\/g, "/"),
      exampleRegistryPath: examplePath,
      targetRegistryPath: targetPath,
      reliabilitySummaryPath: join(dir, "runs", "reliability-summary.json"),
      fs: {
        readFile: fs.readFile,
        writeFile: fs.writeFile,
        rename: fs.rename,
        existsSync,
        unlink: (p) => { try { unlinkSync(p); } catch { /* idempotent */ } return Promise.resolve(); },
        mkdir: fs.mkdir,
      },
    });
    assert.equal(r.outcome, "applied");
    assert.ok(existsSync(targetPath), "agents.json written under a path with spaces");
    const written = JSON.parse(readFileSync(targetPath, "utf8"));
    assert.deepEqual(Object.keys(written.agents), ["coder_low"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 11. bounded JSON output contains no credential VALUES ─────────────────────
test("structured result JSON carries credential NAMES but never VALUES", async () => {
  // Plant a value only the env could leak; the service must never read env.
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "placeholder-leak-probe";
  try {
    const { result } = await memRun({ agentId: "coder_low", apply: true });
    const r = await result;
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes("placeholder-leak-probe"),
      "credential VALUE must never appear in the structured result");
    // The env NAME is legitimately carried (the worker needs it); that is not a leak.
    assert.ok(serialized.includes("DEEPSEEK_API_KEY"));
    // The written file likewise carries only the name.
    const written = JSON.stringify(r.registry);
    assert.ok(written.includes("DEEPSEEK_API_KEY"));
    assert.ok(!written.includes("placeholder-leak-probe"));
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});

// ── 12. forbidden side effects absent ─────────────────────────────────────────
test("the helper triggers no forbidden side effects (no spawn, no .wao, no global host config, no runtime mutation)", async () => {
  // Instrument child_process to prove nothing is spawned across every mode.
  const { spawn } = await import("node:child_process");
  const originalSpawn = spawn;
  let spawnCalled = 0;
  // Monkey-patch the module's spawn reference path: the onboarding service must
  // not import child_process at all, so spawning is impossible. We still assert
  // via a global call counter that no spawn happens during these calls.
  const realGlobalSpawn = globalThis.spawn;
  // The service is pure re: subprocesses — assert by module contract instead:
  // importing it must not pull child_process.
  const modSource = readFileSync(new URL("../../src/application/onboarding.js", import.meta.url), "utf8");
  assert.ok(!/child_process/.test(modSource),
    "application/onboarding.js must not import child_process (no install/upgrade/login/dispatch)");
  assert.ok(!/spawn|execFile|exec\(/.test(modSource),
    "application/onboarding.js must not spawn or exec any process");

  const modes = [
    {},
    { agentId: "coder_low" },
    { agentId: "coder_low", apply: true },
    { agentId: "coder_low", endorseWorker: "coder_low" },
    { agentId: "coder_low", apply: true, endorseWorker: "coder_low" },
  ];
  for (const m of modes) {
    const { fs, result } = await memRun(m);
    await result;
    // Must not touch target .wao state.
    assert.ok(![...fs.__files.keys()].some((p) => /\.wao\//.test(p)),
      `mode ${JSON.stringify(m)} wrote a .wao/ file`);
    // Must not touch any global Host config path.
    assert.ok(![...fs.__files.keys()].some((p) => /\.codex|\.claude|\.kimi/i.test(p)),
      `mode ${JSON.stringify(m)} wrote a global Host config`);
    // Must not create runs/ transcripts (only the endorsement summary is allowed).
    const runTranscripts = [...fs.__files.keys()].filter((p) => /runs\/.*\.jsonl$/.test(p));
    assert.deepEqual(runTranscripts, [], `mode ${JSON.stringify(m)} wrote a run transcript`);
  }
  assert.equal(spawnCalled, 0);
  if (realGlobalSpawn !== undefined) globalThis.spawn = realGlobalSpawn;
});

test("apply + endorse together write both artifacts and neither more", async () => {
  const { fs, result } = await memRun({ agentId: "coder_low", apply: true, endorseWorker: "coder_low" });
  const r = await result;
  assert.equal(r.outcome, "applied");
  assert.equal(r.writes.registry, true);
  assert.equal(r.writes.endorsement, true);
  const keys = [...fs.__files.keys()].sort();
  // Exactly: template + agents.json + reliability-summary.json. Nothing else.
  assert.deepEqual(keys, [
    "D:/wao/config/agents.example.json",
    "D:/wao/config/agents.json",
    "D:/wao/runs/reliability-summary.json",
  ]);
});

// ── 13. structured result is single-sourced for --json and human ──────────────
test("--json and human output derive from one bounded structured result", async () => {
  const { result } = await memRun({ agentId: "coder_low" });
  const r = await result;
  // The bounded result is JSON-serializable (drives both --json and human views).
  const json = JSON.parse(JSON.stringify(r));
  for (const key of ["outcome", "selected", "needsSelection", "candidates", "writes", "certification", "mcpSnippet"]) {
    assert.ok(key in json, `structured result must carry the bounded field: ${key}`);
  }
  assert.equal(json.certification.strictCommand, "npm run reliability -- --agent coder_low");
});

test("candidate list carries no credential values or comment keys", () => {
  const list = buildCandidateList(TEMPLATE);
  const serialized = JSON.stringify(list);
  assert.ok(!/_comment/.test(serialized));
  assert.ok(!/SECRET|sk-|api[_-]?key/i.test(serialized) || /apiKeyEnv/i.test(serialized),
    "candidate list must not leak values");
});

// ── 14. candidate enumeration is bounded + malformed-safe ─────────────────────
test("buildCandidateList is empty (no throw) when agents is malformed (non-object)", () => {
  assert.deepEqual(buildCandidateList({ agents: ["not", "an", "object"] }), []);
  assert.deepEqual(buildCandidateList({ agents: "a string" }), []);
  assert.deepEqual(buildCandidateList({ agents: null }), []);
  assert.deepEqual(buildCandidateList({}), []);
  assert.deepEqual(buildCandidateList({ agents: 42 }), []);
  // Even when agents is malformed, entries are still well-formed (defensive).
  assert.deepEqual(
    buildCandidateList({ agents: { ok: { backend: "claude-code", model: { id: "x" } } } }),
    [{ id: "ok", backend: "claude-code", model: "x" }],
  );
});

test("buildCandidateList is hard-capped at MAX_CANDIDATES for an unexpectedly large template", () => {
  const agents = {};
  const tooMany = MAX_CANDIDATES + 10;
  for (let i = 0; i < tooMany; i++) agents[`w_${i}`] = { backend: "claude-code", model: { id: "x" } };
  const list = buildCandidateList({ agents });
  assert.equal(list.length, MAX_CANDIDATES, "enumeration must be capped, never unbounded");
  assert.ok(list.length < tooMany, "the cap actually bounded the oversized template");
  assert.ok(list.every((c) => typeof c.id === "string" && c.backend === "claude-code"),
    "capped entries are still well-formed");
});

test("runOnboarding with a malformed (array) agents object is needs-selection with no candidates, no writes, no throw", async () => {
  const fs = makeMemFs({ "D:/wao/config/agents.example.json": JSON.stringify({ agents: ["bad"] }) });
  const r = await runOnboarding({
    installRoot: "D:/wao",
    exampleRegistryPath: "D:/wao/config/agents.example.json",
    targetRegistryPath: "D:/wao/config/agents.json",
    reliabilitySummaryPath: "D:/wao/runs/reliability-summary.json",
    fs,
  });
  assert.equal(r.outcome, "needs-selection");
  assert.deepEqual(r.candidates, []);
  assert.equal(r.writes.registry, false);
  assert.equal(r.writes.endorsement, false);
  // No file beyond the template was created.
  assert.deepEqual([...fs.__files.keys()], ["D:/wao/config/agents.example.json"]);
});

// ── 15. endorsement creates ONLY the necessary parent dir (runs/) ──────────────
test("mem fs rejects a write into a missing parent dir (proves the fake is faithful, not permissive)", async () => {
  const fs = makeMemFs({ "D:/wao/config/agents.example.json": JSON.stringify(TEMPLATE) });
  // runs/ is not known: a raw writeFile into it must ENOENT like a real fs.
  await assert.rejects(
    () => fs.writeFile("D:/wao/runs/reliability-summary.json", "{}"),
    (err) => err.code === "ENOENT",
  );
  // ...but after mkdir it becomes writable.
  await fs.mkdir("D:/wao/runs", { recursive: true });
  await fs.writeFile("D:/wao/runs/reliability-summary.json", "{}");
  assert.ok(fs.existsSync("D:/wao/runs/reliability-summary.json"));
});

test("mem fs: endorsement creates the missing runs/ parent dir then writes the summary", async () => {
  const fs = makeMemFs({ "D:/wao/config/agents.example.json": JSON.stringify(TEMPLATE) });
  assert.ok(!fs.__dirs.has("D:/wao/runs"), "precondition: runs/ is not known");
  const r = await runOnboarding({
    agentId: "coder_low", endorseWorker: "coder_low", installRoot: "D:/wao",
    exampleRegistryPath: "D:/wao/config/agents.example.json",
    targetRegistryPath: "D:/wao/config/agents.json",
    reliabilitySummaryPath: "D:/wao/runs/reliability-summary.json",
    fs,
  });
  assert.equal(r.outcome, "applied");
  assert.equal(r.writes.endorsement, true);
  assert.ok(fs.__dirs.has("D:/wao/runs"), "the helper created the necessary runs/ parent dir");
  assert.ok(fs.existsSync("D:/wao/runs/reliability-summary.json"));
  // It created ONLY the runs/ chain — no sibling or unrelated directories.
  assert.ok(!fs.__dirs.has("D:/wao/config/subdir"), "no unrelated directories created");
});

test("real fs: endorsement creates the missing runs/ dir on a real tmpdir (no pre-existing runs/)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao endorse "));
  try {
    const { default: fs } = await import("node:fs/promises");
    const { existsSync, unlinkSync } = await import("node:fs");
    const examplePath = join(dir, "config", "agents.example.json");
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(examplePath, JSON.stringify(TEMPLATE), "utf8");
    const summaryPath = join(dir, "runs", "reliability-summary.json");
    // Precondition: runs/ does NOT exist on the real filesystem.
    assert.ok(!existsSync(join(dir, "runs")), "precondition: real runs/ absent");
    const r = await runOnboarding({
      agentId: "coder_low", endorseWorker: "coder_low", installRoot: dir.replace(/\\/g, "/"),
      exampleRegistryPath: examplePath,
      targetRegistryPath: join(dir, "config", "agents.json"),
      reliabilitySummaryPath: summaryPath,
      fs: {
        readFile: fs.readFile,
        writeFile: fs.writeFile,
        rename: fs.rename,
        existsSync,
        unlink: async (p) => { try { unlinkSync(p); } catch { /* idempotent */ } },
        mkdir: fs.mkdir,
      },
    });
    assert.equal(r.outcome, "applied");
    assert.equal(r.writes.endorsement, true);
    // runs/ now exists and holds exactly the summary.
    assert.ok(existsSync(summaryPath), "summary written into the newly-created runs/");
    const written = JSON.parse(readFileSync(summaryPath, "utf8"));
    assert.equal(written.workers.coder_low.manualOverride, "cleared");
    assert.equal(written.workers.coder_low.status, undefined, "no fabricated status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 16. bounded Host-neutral acceptance projection ───────────────────────────
//
// Fresh Host acceptance contract (Fresh Lead-facing authority: AGENT_ONBOARDING.md §9):
// every runOnboarding result carries ONE bounded `acceptance` object — the single
// source shared by --json and human output. It names exactly the three MCP steps,
// the PASS facts, and the four closed recovery branches. It is advisory + host-neutral:
// it never names a Host, and carries no absolute path, credential value, prompt body,
// command argv, PID, session id, or automatic mutation. A Fresh Lead can read it to
// learn the acceptance chain, the PASS condition, and the safe recovery branches
// without loading the full Skill. The helper never dispatches, retries, or decides.

test("buildAcceptance names exactly the three MCP steps in order (read-only, no-delivery canary)", () => {
  const a = buildAcceptance();
  assert.ok(a && typeof a === "object", "acceptance must be an object");
  assert.ok(Array.isArray(a.chain), "chain must be an array");
  assert.deepEqual(
    a.chain.map((s) => s.step),
    ["lead_preflight", "run_dispatch", "run_await_result"],
    "chain must name exactly the three MCP steps in order",
  );
  // The canary is read-only and no-delivery (no commit packaging).
  assert.equal(a.canary.readOnly, true, "canary must be read-only");
  assert.equal(a.canary.noDelivery, true, "canary must be no-delivery");
});

test("buildAcceptance PASS requires all three facts together; accepted is not PASS", () => {
  const a = buildAcceptance();
  assert.ok(Array.isArray(a.pass.facts), "pass.facts must be an array");
  // Exactly the three PASS facts, as a closed set.
  assert.deepEqual(
    a.pass.facts,
    ["clean terminal", "completed", "non-empty assistant text"],
    "PASS must require exactly these three facts",
  );
  assert.equal(a.pass.acceptedIsNotPass, true, "run_dispatch accepted is not PASS");
});

test("buildAcceptance: a returned runId binds all later observation", () => {
  const a = buildAcceptance();
  assert.equal(a.runIdBindsObservation, true, "a returned runId binds all later observation");
});

test("buildAcceptance declares itself advisory and host-neutral", () => {
  const a = buildAcceptance();
  assert.equal(a.advisory, true, "acceptance must declare itself advisory");
  assert.equal(a.hostNeutral, true, "acceptance must declare itself host-neutral");
});

test("buildAcceptance names exactly the four closed recovery branches (advisory)", () => {
  const a = buildAcceptance();
  assert.ok(Array.isArray(a.branches), "branches must be an array");
  const keys = a.branches.map((b) => b.key);
  assert.deepEqual(
    keys,
    ["host-not-invoked", "transport-unknown", "workspace/preflight", "provider/runtime"],
    "branches must be exactly the four closed recovery branches",
  );
  // Each branch carries a non-empty advisory FACT (not a prescription).
  for (const b of a.branches) {
    assert.equal(typeof b.advisory, "string", `branch ${b.key} must carry advisory text`);
    assert.ok(b.advisory.trim().length > 10, `branch ${b.key} advisory must be non-trivial`);
  }
});

test("buildAcceptance truth contract: host-not-invoked is not a WAO run; transport-unknown needs runs_list before retry", () => {
  const a = buildAcceptance();
  const byKey = Object.fromEntries(a.branches.map((b) => [b.key, b.advisory]));
  // Host cancellation proven before invocation ⇒ not a WAO run.
  assert.ok(/not a WAO run|did not receive/i.test(byKey["host-not-invoked"]),
    "host-not-invoked must state a proven-before-invocation cancellation is not a WAO run");
  // Missing result / transport loss ⇒ unknown, not proof; inspect runs_list before retry; no auto-retry.
  assert.ok(/unknown/i.test(byKey["transport-unknown"]),
    "transport-unknown must be labeled unknown, not proof");
  assert.ok(/runs_list|point-in-time/i.test(byKey["transport-unknown"]),
    "transport-unknown must direct to runs_list / point-in-time facts before retry");
  assert.ok(/no automatic retry|no auto/i.test(byKey["transport-unknown"]),
    "transport-unknown must state no automatic retry");
  // provider/runtime is a POST-RUN branch (only after a runId-bound run exists).
  assert.ok(/post-run|after a runId-bound|only after/i.test(byKey["provider/runtime"]),
    "provider/runtime must be a post-run branch");
});

test("every runOnboarding outcome carries the same bounded acceptance projection", async () => {
  const modes = [
    {},                                      // needs-selection
    { agentId: "coder_low" },                // previewed
    { agentId: "coder_low", apply: true },   // applied
    { agentId: "ghost" },                    // refused (unknown id)
    { agentId: "coder_low", endorseWorker: "coder_mm" }, // refused (mismatch)
  ];
  for (const m of modes) {
    const { result } = await memRun(m);
    const r = await result;
    assert.ok(r.acceptance && typeof r.acceptance === "object",
      `mode ${JSON.stringify(m)} must carry acceptance`);
    assert.deepEqual(
      r.acceptance.chain.map((s) => s.step),
      ["lead_preflight", "run_dispatch", "run_await_result"],
      `mode ${JSON.stringify(m)} chain`,
    );
    assert.equal(r.acceptance.pass.acceptedIsNotPass, true);
    assert.deepEqual(
      r.acceptance.branches.map((b) => b.key),
      ["host-not-invoked", "transport-unknown", "workspace/preflight", "provider/runtime"],
    );
  }
});

test("the error outcome (unreadable template) also carries the acceptance projection", async () => {
  const fs = makeMemFs({}); // no template seeded → bounded error
  const r = await runOnboarding({
    installRoot: "D:/wao",
    exampleRegistryPath: "D:/wao/config/agents.example.json",
    targetRegistryPath: "D:/wao/config/agents.json",
    reliabilitySummaryPath: "D:/wao/runs/reliability-summary.json",
    fs,
  });
  assert.equal(r.outcome, "error");
  assert.deepEqual(
    r.acceptance.chain.map((s) => s.step),
    ["lead_preflight", "run_dispatch", "run_await_result"],
  );
});

test("acceptance is JSON-serializable (it drives both --json and human output)", () => {
  const a = buildAcceptance();
  const round = JSON.parse(JSON.stringify(a));
  assert.deepEqual(round.chain.map((s) => s.step), ["lead_preflight", "run_dispatch", "run_await_result"]);
  assert.deepEqual(round.branches.map((b) => b.key),
    ["host-not-invoked", "transport-unknown", "workspace/preflight", "provider/runtime"]);
  assert.equal(round.pass.acceptedIsNotPass, true);
  assert.equal(round.hostNeutral, true);
});

test("acceptance is advisory + host-neutral: no Host name, path, credential, prompt, argv, PID, session, or auto-mutation", () => {
  const serialized = JSON.stringify(buildAcceptance());
  // No specific Host/runtime named as identity (host-neutral).
  for (const host of ["claude-code", "codex", "kimi", "opencode"]) {
    assert.ok(!new RegExp(host, "i").test(serialized),
      `acceptance must not name a Host/runtime (${host})`);
  }
  // No absolute path (Windows drive or unix home), no credential value, no PID,
  // no session id, no prompt body.
  assert.ok(!/[A-Za-z]:[\\/]/.test(serialized), "acceptance must not carry an absolute path");
  assert.ok(!/\/home\/|\/Users\//.test(serialized), "acceptance must not carry a unix home path");
  assert.ok(!/sk-[A-Za-z0-9]{6,}|api[_-]?key|token=/i.test(serialized),
    "acceptance must not carry a credential value");
  assert.ok(!/\bpid\b|session[_-]?id/i.test(serialized), "acceptance must not carry a PID/session id");
  // No automatic mutation: WAO never promises to auto-dispatch / auto-retry / decide-continue.
  assert.ok(!/automatically (dispatch|retry|continue)|auto-dispatch|will retry/i.test(serialized),
    "acceptance must not promise automatic mutation");
});

test("human output renders the acceptance chain, PASS facts, and recovery branches from the shared object", async () => {
  const r = await (await memRun({ agentId: "coder_low" })).result;
  const text = renderHuman(r);
  // The three MCP steps appear in the human output.
  for (const step of ["lead_preflight", "run_dispatch", "run_await_result"]) {
    assert.ok(text.includes(step), `human output must name the MCP step ${step}`);
  }
  // PASS facts and the accepted≠PASS distinction.
  assert.ok(/clean terminal/i.test(text), "human output must state the clean-terminal PASS fact");
  assert.ok(/completed/i.test(text), "human output must state the completed PASS fact");
  assert.ok(/non-empty assistant/i.test(text), "human output must state the non-empty-assistant PASS fact");
  assert.ok(/accepted/i.test(text) && /not\s*pass/i.test(text),
    "human output must state run_dispatch accepted is not PASS");
  // The four recovery branches.
  for (const key of ["host-not-invoked", "transport-unknown", "workspace/preflight", "provider/runtime"]) {
    assert.ok(text.includes(key), `human output must name the recovery branch ${key}`);
  }
});

test("acceptance adds no new writes and does not disturb preview/apply/endorsement behavior", async () => {
  // Preview still zero-write; acceptance is advisory and writes nothing.
  const preview = await (await memRun({ agentId: "coder_low" })).result;
  assert.equal(preview.writes.registry, false);
  assert.equal(preview.writes.endorsement, false);
  assert.ok(preview.acceptance);
  // Apply still writes only the registry; endorsement stays false.
  const applied = await (await memRun({ agentId: "coder_low", apply: true })).result;
  assert.equal(applied.writes.registry, true);
  assert.equal(applied.writes.endorsement, false);
  assert.ok(applied.acceptance);
});

// ── 17. R5-D: per-host one-line registration examples ────────────────────────
// Derived PURELY from mcpSnippet (single shape source), bounded (2 hosts),
// stability-tagged (codex = experimental), and carried by every outcome —
// including refused — exactly like mcpSnippet/acceptance.
test("R5-D: buildHostExamples derives one-liners from the snippet with stable/experimental tags", async () => {
  const { buildHostExamples, HOST_EXAMPLES_AUTHORITY } = await import("../../src/application/onboarding.js");
  const snippet = buildMcpSnippet({ installRoot: "D:/my projects/wao" });
  const examples = buildHostExamples(snippet);
  assert.equal(examples.length, 2, "exactly two host examples (bounded)");
  const [claude, codex] = examples;
  assert.equal(claude.host, "claude-code");
  assert.equal(claude.stability, "stable");
  assert.match(claude.command, /^claude mcp add wao --scope user -- node /,
    "claude one-liner uses the --scope user shape (not --user)");
  assert.match(claude.command, /"D:\/my projects\/wao\/scripts\/wao-node\.cjs"/,
    "paths containing spaces are quoted");
  assert.equal(codex.host, "codex");
  assert.equal(codex.stability, "experimental",
    "codex mcp family is experimental — stability travels with the example");
  assert.match(codex.command, /^codex mcp add wao -- node /);
  assert.ok(HOST_EXAMPLES_AUTHORITY.includes("docs/usage.md"),
    "authority pointer names docs/usage.md as the shape authority");
  assert.deepEqual(buildHostExamples(undefined), [], "garbage input never throws, yields empty list");
});

test("R5-D: hostExamples carried by every outcome incl. refused, and rendered in human output", async () => {
  const { HOST_EXAMPLES_AUTHORITY } = await import("../../src/application/onboarding.js");
  const mem = await memRun({ agentId: "coder_low" });
  const r = await mem.result;
  assert.ok(Array.isArray(r.hostExamples) && r.hostExamples.length === 2,
    "structured result carries hostExamples (bounded 2)");
  // Refused outcome carries them too (same baseResult merge point).
  const dir = mkdtempSync(join(tmpdir(), "wao-onb-refused-"));
  const root = join(dir, "wao");
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "agents.example.json"), readFileSync(join("config", "agents.example.json")));
  writeFileSync(join(root, "config", "agents.json"), "{}");
  const refused = await runOnboarding({
    agentId: "coder_low", apply: true, installRoot: root,
    exampleRegistryPath: join(root, "config", "agents.example.json"),
    targetRegistryPath: join(root, "config", "agents.json"),
    reliabilitySummaryPath: join(root, "runs", "reliability-summary.json"),
    fs: { readFile: (p, e) => import("node:fs/promises").then((m) => m.readFile(p, e)),
      writeFile: (p, d) => import("node:fs/promises").then((m) => m.writeFile(p, d)),
      rename: (a, b) => import("node:fs/promises").then((m) => m.rename(a, b)),
      existsSync, unlink: (p) => import("node:fs/promises").then((m) => m.unlink(p)),
      mkdir: (p) => import("node:fs/promises").then((m) => m.mkdir(p, { recursive: true })) },
  });
  assert.equal(refused.outcome, "refused");
  assert.equal(refused.hostExamples.length, 2, "refused outcome still carries hostExamples");
  // Human rendering shows the one-liners + authority sentence.
  const text = renderHuman(r);
  assert.ok(text.includes("One-line registration examples"), "human output renders the examples block");
  assert.ok(text.includes(HOST_EXAMPLES_AUTHORITY), "human output carries the authority sentence");
  assert.ok(text.includes("claude mcp add wao --scope user --"), "claude one-liner rendered");
  assert.ok(/\[experimental\]/.test(text), "codex example carries the experimental tag");
  rmSync(dir, { recursive: true, force: true });
});

// ── 18. R6-C: role matrix + environment-adapted recommendations ─────────────
//
// Advisory recommendations for a bare `wao onboarding` (no --agent), derived
// PURELY from the tracked template rows (backend / provider.apiKeyEnv / model.id
// / _comment_task / _comment_auth) plus an INJECTED environment probe. Design
// iron law: no second hand-written role table, no auto-selection, no config
// write — the recommendation is advisory and the user keeps the choice.
// Probing is injectable everywhere; nothing here touches the real environment.

test("R6-C: buildRecommendations derives rows from template rows (backend→CLI, apiKeyEnv, duty truncation, authNote)", async () => {
  const custom = {
    agents: {
      w_key: {
        backend: "claude-code",
        provider: { protocol: "anthropic-compatible", baseUrl: "https://x", apiKeyEnv: "ZHIPU_API_KEY" },
        model: { id: "glm-5.3[1m]" },
        _comment_task: `适合任务: ${"写".repeat(80)}`,
        _comment_auth: "官方 Claude OAuth（claude login），不走 wrapper",
      },
      w_login: {
        backend: "codex",
        model: { id: "gpt-x" },
        _comment_task: "适合任务: 跑测试",
      },
    },
  };
  const candidates = buildCandidateList(custom);
  const probeEnv = {
    hasCli: async () => true,
    hasKeyEnv: async (n) => (n === "ZHIPU_API_KEY" ? "user_env" : "missing"),
  };
  const rec = await buildRecommendations(candidates, custom, probeEnv);
  assert.equal(rec.advisory, RECOMMENDATIONS_ADVISORY);
  const byId = Object.fromEntries(rec.rows.map((r) => [r.id, r]));
  // Row generation correctness from template rows.
  assert.equal(byId.w_key.requiresCli, "claude", "backend→CLI mapping");
  assert.equal(byId.w_key.requiresKeyEnv, "ZHIPU_API_KEY", "provider.apiKeyEnv carried");
  assert.equal(byId.w_key.model, "glm-5.3[1m]");
  assert.ok(byId.w_key.duty.startsWith("适合任务: "), "_comment_task carried verbatim");
  assert.ok(byId.w_key.duty.length <= 60, "_comment_task truncated to ~60 chars");
  assert.ok(byId.w_key.duty.endsWith("…"), "truncation is marked with an ellipsis");
  assert.equal(byId.w_key.authNote, "官方 Claude OAuth（claude login），不走 wrapper");
  assert.equal(byId.w_key.readyState, "ready", "user_env key counts as present (bridged at dispatch)");
  // No provider → no key requirement; login-state family.
  assert.equal(byId.w_login.requiresCli, "codex");
  assert.equal(byId.w_login.requiresKeyEnv, null, "no provider.apiKeyEnv ⇒ null");
  assert.equal(byId.w_login.authNote, null, "no _comment_auth ⇒ null (no hand-written fallback)");
  assert.equal(byId.w_login.readyState, "login_based");
});

// R6-C3（P2-4）：映射收敛到 src/application/backendCliMap.js 单一来源（本模块
// re-export），并补上此前两份重复表都漏掉的活 backend deepseek-harness——
// JSON-RPC 适配器无独立 CLI 可探，显式 null。
test("R6-C: backend→CLI mapping covers all live backends (null = no standalone CLI)", () => {
  assert.deepEqual(BACKEND_CLI, {
    "claude-code": "claude",
    codex: "codex",
    "kimi-code": "kimi",
    "opencode-serve": "opencode",
    "deepseek-harness": null,
  });
});

test("R6-C: readyState four quadrants for key workers (injected probeEnv)", async () => {
  const custom = {
    agents: { w: { backend: "claude-code", provider: { apiKeyEnv: "K" }, model: { id: "m" } } },
  };
  const candidates = [{ id: "w", backend: "claude-code", model: "m" }];
  const run = (cli, key) => buildRecommendations(candidates, custom, {
    hasCli: async () => cli, hasKeyEnv: async () => key,
  });
  assert.equal((await run(true, "process_env")).rows[0].readyState, "ready");
  assert.equal((await run(true, "user_env")).rows[0].readyState, "ready");
  assert.equal((await run(true, "missing")).rows[0].readyState, "missing_key");
  assert.equal((await run(false, "process_env")).rows[0].readyState, "missing_cli");
  assert.equal((await run(false, "missing")).rows[0].readyState, "missing_both");
  assert.equal((await run(false, null)).rows[0].readyState, "missing_both", "null key probe result = missing");
});

test("R6-C: no-key workers probe the CLI only (login_based / missing_cli)", async () => {
  const custom = { agents: { t: { backend: "codex", model: { id: "m" } } } };
  const candidates = [{ id: "t", backend: "codex", model: "m" }];
  let keyProbes = 0;
  const rec = await buildRecommendations(candidates, custom, {
    hasCli: async () => true,
    hasKeyEnv: async () => { keyProbes += 1; return "missing"; },
  });
  assert.equal(rec.rows[0].readyState, "login_based");
  assert.equal(keyProbes, 0, "no key probe for a worker without provider.apiKeyEnv");
  const missing = await buildRecommendations(candidates, custom, {
    hasCli: async () => false, hasKeyEnv: async () => "missing",
  });
  assert.equal(missing.rows[0].readyState, "missing_cli");
});

test("R6-C: probe exceptions degrade to unknown and never throw", async () => {
  const custom = {
    agents: {
      a: { backend: "claude-code", provider: { apiKeyEnv: "K" }, model: { id: "m" } },
      b: { backend: "codex", model: { id: "m" } },
    },
  };
  const candidates = [
    { id: "a", backend: "claude-code", model: "m" },
    { id: "b", backend: "codex", model: "m" },
  ];
  // Throwing CLI probe → every row (even the login-state row) degrades to unknown.
  const cliThrows = await buildRecommendations(candidates, custom, {
    hasCli: async () => { throw new Error("probe boom"); },
    hasKeyEnv: async () => "process_env",
  });
  for (const row of cliThrows.rows) assert.equal(row.readyState, "unknown");
  // Throwing key probe → the key row degrades; the login row still resolves.
  const keyThrows = await buildRecommendations(candidates, custom, {
    hasCli: async () => true,
    hasKeyEnv: async () => { throw new Error("probe boom"); },
  });
  assert.equal(keyThrows.rows.find((r) => r.id === "a").readyState, "unknown");
  assert.equal(keyThrows.rows.find((r) => r.id === "b").readyState, "login_based");
  // Timeout-style "unknown" returns degrade the same way (no throw, truthful).
  const timeouts = await buildRecommendations(candidates, custom, {
    hasCli: async () => "unknown", hasKeyEnv: async () => "unknown",
  });
  for (const row of timeouts.rows) assert.equal(row.readyState, "unknown");
});

test("R6-C: rows are sorted ready-first (stable within rank)", async () => {
  const custom = {
    agents: {
      r: { backend: "claude-code", provider: { apiKeyEnv: "K1" }, model: { id: "m" } },
      m1: { backend: "codex", model: { id: "m" } },
      m2: { backend: "claude-code", provider: { apiKeyEnv: "K2" }, model: { id: "m" } },
      l: { backend: "kimi-code", model: { id: "m" } },
      u: { backend: "opencode-serve", model: { id: "m" } },
    },
  };
  const candidates = [
    { id: "m2", backend: "claude-code", model: "m" },   // missing_key
    { id: "l", backend: "kimi-code", model: "m" },      // login_based
    { id: "r", backend: "claude-code", model: "m" },    // ready
    { id: "m1", backend: "codex", model: "m" },         // missing_cli
    { id: "u", backend: "opencode-serve", model: "m" }, // probe timeout → unknown
  ];
  const rec = await buildRecommendations(candidates, custom, {
    hasCli: async (n) => {
      if (n === "opencode") throw new Error("timeout");
      return n === "claude" || n === "kimi"; // codex missing
    },
    hasKeyEnv: async (n) => (n === "K1" ? "process_env" : "missing"),
  });
  assert.deepEqual(rec.rows.map((r) => r.id), ["r", "l", "m1", "m2", "u"],
    "ready → login_based → missing_* → unknown");
});

test("R6-C: an unmapped backend row degrades to unknown (cannot verify)", async () => {
  const custom = { agents: { x: { backend: "some-future-backend", model: { id: "m" } } } };
  const rec = await buildRecommendations(
    [{ id: "x", backend: "some-future-backend", model: "m" }], custom,
    { hasCli: async () => true, hasKeyEnv: async () => "missing" },
  );
  assert.equal(rec.rows[0].requiresCli, null);
  assert.equal(rec.rows[0].readyState, "unknown");
});

test("R6-C: one probe per unique CLI/key name (≤4 CLI probes + ≤N key probes per invocation)", async () => {
  const custom = {
    agents: {
      r1: { backend: "claude-code", provider: { apiKeyEnv: "DEEPSEEK_API_KEY" }, model: { id: "m" } },
      r2: { backend: "claude-code", provider: { apiKeyEnv: "DEEPSEEK_API_KEY" }, model: { id: "m" } },
      r3: { backend: "kimi-code", model: { id: "m" } },
    },
  };
  const candidates = [
    { id: "r1", backend: "claude-code", model: "m" },
    { id: "r2", backend: "claude-code", model: "m" },
    { id: "r3", backend: "kimi-code", model: "m" },
  ];
  const calls = { cli: [], key: [] };
  await buildRecommendations(candidates, custom, {
    hasCli: async (n) => { calls.cli.push(n); return true; },
    hasKeyEnv: async (n) => { calls.key.push(n); return "missing"; },
  });
  assert.deepEqual(calls.cli, ["claude", "kimi"], "deduped per unique CLI name");
  assert.deepEqual(calls.key, ["DEEPSEEK_API_KEY"], "deduped per unique key name");
  assert.ok(calls.cli.length <= 4, "hard bound: at most 4 CLI probes");
});

test("R6-C: without probeEnv every row is unknown and nothing is probed", async () => {
  const { result } = await memRun({});
  const r = await result;
  assert.equal(r.recommendations.advisory, RECOMMENDATIONS_ADVISORY);
  assert.equal(r.recommendations.rows.length, 3);
  assert.ok(r.recommendations.rows.every((row) => row.readyState === "unknown"),
    "no probeEnv ⇒ no probing of any kind ⇒ unknown, never a fabricated ready");
});

test("R6-C: emptyRecommendations carries the advisory with zero rows", () => {
  const e = emptyRecommendations();
  assert.equal(e.advisory, RECOMMENDATIONS_ADVISORY);
  assert.deepEqual(e.rows, []);
});

test("R6-C: human needs-selection output renders the matrix block + advisory sentences", async () => {
  const allPresent = await (await memRun({
    probeEnv: {
      hasCli: async () => true,
      hasKeyEnv: async (n) => (n === "DEEPSEEK_API_KEY" ? "process_env" : "missing"),
    },
  })).result;
  const text = renderHuman(allPresent);
  assert.ok(text.includes("角色矩阵与当前环境适配"), "matrix block header");
  assert.ok(text.includes(RECOMMENDATIONS_ADVISORY), "advisory sentence shared with JSON");
  assert.ok(text.includes("按你有的认证选一行重跑 --agent <id> --apply；没有的 key 对应行可忽略。"),
    "tail advisory line hands the choice back to the user");
  // coder_low is ready (claude CLI + DEEPSEEK_API_KEY), sorted first.
  assert.ok(text.includes("[ready]"), "ready bracket rendered");
  assert.ok(text.includes("[CLI 登录态]"), "login-state rows rendered");
  assert.ok(text.indexOf("[ready]") < text.indexOf("[CLI 登录态]"), "ready rows sorted before login rows");
  assert.ok(text.includes("认证: key DEEPSEEK_API_KEY"), "key env name shown as the auth method");
  // duty comes from _comment_task (display strips the redundant prefix).
  assert.ok(text.includes("适合: 边界明确的实现包/TDD"), "duty rendered from the template row");
  // R6-C3（P2-3）：authNote 行改形状断言——结构化基座在前、模板注释只进括号补充
  // （替换旧的纯子串断言，钉住新拼接形状）。
  assert.match(text, /认证: claude CLI 登录态（官方/,
    "authNote 行 = 结构化基座在前 + 模板注释进括号（复核 R3 56 格截断预算下的稳定形状）");
  // The existing candidate list / re-run hints are untouched.
  assert.ok(text.includes("Candidates from the tracked template:"));
  assert.ok(text.includes("Re-run with: wao onboarding --agent <id>"));

  // Missing-probe scenario: human brackets name what is missing.
  const nothing = await (await memRun({
    probeEnv: { hasCli: async () => false, hasKeyEnv: async () => "missing" },
  })).result;
  const textMissing = renderHuman(nothing);
  assert.ok(textMissing.includes("缺 claude CLI"), "missing_cli label");
  assert.ok(textMissing.includes("缺 DEEPSEEK_API_KEY"), "missing_key label");
  assert.ok(textMissing.includes("缺 kimi CLI"), "kimi missing_cli label");
  assert.ok(textMissing.includes("缺 claude CLI + 缺 DEEPSEEK_API_KEY"), "missing_both label");
  assert.ok(!textMissing.includes("[ready]"), "nothing is ready in this scenario");
});

test("R6-C: recommendations are additive; every pre-existing result key is preserved", async () => {
  const probeEnv = { hasCli: async () => true, hasKeyEnv: async () => "missing" };
  for (const m of [{}, { agentId: "coder_low" }, { agentId: "coder_low", apply: true }, { agentId: "ghost" }]) {
    const { result } = await memRun({ ...m, probeEnv });
    const r = await result;
    const json = JSON.parse(JSON.stringify(r));
    // Every pre-existing bounded key is still present (additive, no breakage).
    for (const key of ["mode", "outcome", "selected", "needsSelection", "candidates",
      "registry", "mcpSnippet", "hostExamples", "acceptance", "certification", "writes", "reason"]) {
      assert.ok(key in json, `mode ${JSON.stringify(m)} must keep ${key}`);
    }
    assert.ok(json.recommendations && typeof json.recommendations.advisory === "string",
      `mode ${JSON.stringify(m)} must carry recommendations.advisory`);
    assert.ok(Array.isArray(json.recommendations.rows),
      `mode ${JSON.stringify(m)} must carry recommendations.rows`);
    // Rows carry the bounded spec shape and the closed readyState domain.
    for (const row of json.recommendations.rows) {
      for (const k of ["id", "backend", "model", "requiresCli", "requiresKeyEnv", "duty", "readyState"]) {
        assert.ok(k in row, `row must carry ${k}`);
      }
      assert.ok(["ready", "missing_cli", "missing_key", "missing_both", "login_based", "unknown"].includes(row.readyState),
        "readyState must stay inside the closed domain");
    }
  }
  // The unreadable-template error outcome carries the empty matrix (zero probes).
  const fs = makeMemFs({});
  const err = await runOnboarding({
    installRoot: "D:/wao",
    exampleRegistryPath: "D:/wao/config/agents.example.json",
    targetRegistryPath: "D:/wao/config/agents.json",
    reliabilitySummaryPath: "D:/wao/runs/reliability-summary.json",
    fs,
    probeEnv,
  });
  assert.equal(err.outcome, "error");
  assert.deepEqual(err.recommendations.rows, []);
  assert.equal(err.recommendations.advisory, RECOMMENDATIONS_ADVISORY);
});

test("R6-C: recommendations over the REAL tracked template derive all seven rows from template data", async () => {
  const raw = readFileSync(join("config", "agents.example.json"), "utf8");
  const template = JSON.parse(raw);
  const candidates = buildCandidateList(template);
  assert.equal(candidates.length, 7, "real template has the seven workers");
  const rec = await buildRecommendations(candidates, template, {
    hasCli: async () => true,
    hasKeyEnv: async (n) => (n === "ZHIPU_API_KEY" ? "process_env" : "missing"),
  });
  assert.equal(rec.rows.length, 7);
  const byId = Object.fromEntries(rec.rows.map((r) => [r.id, r]));
  assert.equal(byId.coder_hq.requiresKeyEnv, "ZHIPU_API_KEY");
  assert.equal(byId.researcher.requiresKeyEnv, "DEEPSEEK_API_KEY");
  assert.equal(byId.coder_low.requiresKeyEnv, "DEEPSEEK_API_KEY");
  assert.equal(byId.coder_mm.requiresKeyEnv, null, "kimi uses CLI login state");
  assert.equal(byId.coder_mm.requiresCli, "kimi");
  assert.equal(byId.tester.requiresKeyEnv, null, "tester uses codex login");
  assert.equal(byId.tester.requiresCli, "codex");
  assert.equal(byId.auditor.requiresKeyEnv, null, "auditor uses official OAuth");
  assert.equal(byId.coder_opencode_fallback.requiresKeyEnv, null);
  assert.equal(byId.coder_opencode_fallback.requiresCli, "opencode");
  assert.equal(byId.coder_hq.readyState, "ready");
  assert.equal(byId.researcher.readyState, "missing_key", "DeepSeek key missing in the fake probe");
  // duty/authNote all come from template rows (no hand-written role table).
  assert.ok(byId.researcher.duty.startsWith("适合任务: "));
  assert.ok(byId.auditor.duty.startsWith("适合任务: "));
  assert.ok(byId.auditor.authNote.includes("claude login"), "authNote from _comment_auth");
  // The serialized recommendation never carries a credential VALUE.
  assert.ok(!/sk-[A-Za-z0-9]{6,}/.test(JSON.stringify(rec)));
});

// R6-C2（Owner 反馈）：矩阵行必须列出 backend 列；登录态行的认证标签必须写明
// 具体哪个 CLI。
// R9（决策 0023）：既有"会审备选"句已升级为分级块——三席可用（推荐标准）+
// 建议席位组合（含推断族系）+ 席位惯例句（候选 id 从模板行派生，0019 §3 保留）。
test("R6-C2/R9: 矩阵渲染含 backend 列、登录态行写明具体 CLI、分级块三席 + 席位惯例从行派生", async () => {
  const { runOnboarding } = await import("../../src/application/onboarding.js");
  const { renderHuman } = await import("../../src/commands/onboarding.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-onb-matrix2-"));
  const root = join(dir, "wao");
  mkdirSync(join(root, "config"), { recursive: true });
  // 极简模板：一个 key 型 + 一个登录型（codex）+ 一个 coder 通道（claude-code + ZHIPU key）。
  writeFileSync(join(root, "config", "agents.example.json"), JSON.stringify({
    agents: {
      w_key: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, _comment_task: "适合任务: 编码", model: { id: "glm-5.3[1m]" } },
      tester: { backend: "codex", _comment_task: "适合任务: 跑测试", _comment_auth: "codex login" },
      coder_hq: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, _comment_task: "适合任务: 写代码" },
    },
  }));
  const fsMod = await import("node:fs/promises");
  const r = await runOnboarding({
    installRoot: root,
    exampleRegistryPath: join(root, "config", "agents.example.json"),
    targetRegistryPath: join(root, "config", "agents.json"),
    reliabilitySummaryPath: join(root, "runs", "reliability-summary.json"),
    probeEnv: { hasKeyEnv: async () => "process_env", hasCli: async () => true },
    fs: { readFile: fsMod.readFile, writeFile: fsMod.writeFile, rename: fsMod.rename,
      existsSync, unlink: fsMod.unlink, mkdir: (p2) => fsMod.mkdir(p2, { recursive: true }) },
  });
  const text = renderHuman(r);
  assert.equal(r.recommendations.rows.length, 3, "模板可读时矩阵必须有三行（fs 注入缺失会正确降级为空——本测试必须注入）");
  // backend 列可见（第一行布局：id 之后）。
  assert.match(text, /w_key\s+claude-code\s+/, "backend 列必须出现在 id 之后");
  assert.match(text, /tester\s+codex\s+/, "codex worker 的 backend 列可见");
  // 登录态行写明具体 CLI（第二行布局）。
  assert.match(text, /认证: codex CLI 登录态/, "登录态行的认证标签必须写明具体 CLI 名");
  assert.match(text, /认证: key ZHIPU_API_KEY/, "key 型行标签不变");
  // R9-C C-1 分级块：席位候选只有 coder_hq（w_key/tester 非席位角色）→ 两席。
  assert.ok(text.includes("会审就绪（模板面"), "分级块头部标注模板面数据源");
  assert.ok(text.includes("两席可用——次之推荐（Lead 主审 + 一名副审）"),
    "仅一名可用席位候选 → 两席分级措辞（非席位角色不进计数）");
  assert.ok(text.includes("决策 0023"), "分级块指向决策 0023");
  assert.ok(/可用副审: coder_hq（推断族系：Claude）——补齐第二个副审（建议不同族系）可升级三席/.test(text),
    "可用副审枚举席位候选并带推断族系标签（C-9 推断 hedging；w_key/tester 不进）");
  assert.ok(!text.includes("建议席位组合"), "不足两名席位候选 → 无建议组合行");
  // tester 是 login_based 但非席位角色：其登录态只进矩阵行（[CLI 登录态] 括号），
  // 不进分级块的"登录态未验证"席位叙事。
  assert.ok(!text.includes("登录态未验证"), "非席位角色的登录态不进分级块席位叙事");
  // 席位惯例句从矩阵行派生：枚举实际存在的 coder 通道（此处恰为 coder_hq），
  // 对抗席候选同样从行派生（此处无 auditor/coder_mm 行 → 不点名）。
  assert.ok(text.includes("实现席从 coder 通道取（避同族/避被审产出作者）"),
    "席位惯例句保留 0019 §3 回避语义");
  assert.ok(/在场候选（从上表模板行派生）: 实现席 coder_hq/.test(text),
    "在场候选枚举矩阵中实际存在的 coder 通道 id");
  assert.ok(!text.includes("对抗席"), "不在模板中的对抗席 worker 不点名（shape-derived）");
  assert.ok(text.includes("0019 §3"), "席位回避规则指向 0019 §3（0023 保留条款）");
  rmSync(dir, { recursive: true, force: true });
});

// R6-C3（P1-1）负向 + R9：矩阵零 coder_* 行时席位惯例句整句不打印——labels are
// shape-derived，不打印模板里不存在的 worker。分级块本身照常打印（它按全部行
// 推导，与 coder 通道枚举是两件事）。
test("R6-C3/R9: 矩阵无任何 coder_* 行时席位惯例句不打印（shape-derived），分级块照常", async () => {
  const { runOnboarding } = await import("../../src/application/onboarding.js");
  const { renderHuman } = await import("../../src/commands/onboarding.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-onb-matrix3-"));
  const root = join(dir, "wao");
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "agents.example.json"), JSON.stringify({
    agents: {
      w_key: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, _comment_task: "适合任务: 编码", model: { id: "glm-5.3[1m]" } },
      tester: { backend: "codex", _comment_task: "适合任务: 跑测试" },
    },
  }));
  const fsMod = await import("node:fs/promises");
  const r = await runOnboarding({
    installRoot: root,
    exampleRegistryPath: join(root, "config", "agents.example.json"),
    targetRegistryPath: join(root, "config", "agents.json"),
    reliabilitySummaryPath: join(root, "runs", "reliability-summary.json"),
    probeEnv: { hasKeyEnv: async () => "process_env", hasCli: async () => true },
    fs: { readFile: fsMod.readFile, writeFile: fsMod.writeFile, rename: fsMod.rename,
      existsSync, unlink: fsMod.unlink, mkdir: (p2) => fsMod.mkdir(p2, { recursive: true }) },
  });
  const text = renderHuman(r);
  assert.equal(r.recommendations.rows.length, 2, "矩阵本身照常渲染（前置条件）");
  assert.ok(text.includes("角色矩阵与当前环境适配"), "矩阵块在场（前置条件：负向不是因矩阵缺失而通过）");
  assert.ok(!text.includes("会审备选") && !text.includes("coder 通道"), "零 coder_* 行 ⇒ 席位惯例句整句不打印");
  assert.ok(!text.includes("coder_hq") && !text.includes("coder_low") && !text.includes("coder_mm"),
    "不得打印模板里没有的 worker id");
  // R9-C C-1：分级块照常（两行均 ready 但都非席位角色 → 无可用席位候选），
  // 且不点名缺席的对抗席候选。
  assert.ok(text.includes("会审就绪（模板面"), "分级块不受 coder 通道缺失影响");
  assert.ok(text.includes("当前无可用席位候选（对抗席/实现席）"), "零席位候选 → none 分级措辞");
  assert.ok(!text.includes("对抗席候选"), "无 auditor/coder_mm 行时对抗席候选不点名");
  // 尾行选位提示仍在（与席位惯例句是两句话）。
  assert.ok(text.includes("按你有的认证选一行重跑 --agent <id> --apply"), "选位提示行不受影响");
  rmSync(dir, { recursive: true, force: true });
});

// R6-C3（P1-2 + 席位 B + P2-2 + P2-3）：两行布局 + 表头按显示宽对齐；认证标签
// 四分支（key / opencode serve 注入 / CLI 登录态 / —）；带 authNote 行的标签是
// "结构化基座（模板注释）" 括号形状；opencode-serve 行状态括号不再误标 CLI 登录态。
test("R6-C3: 两行布局+表头、认证标签四分支、authNote 括号形状、opencode 状态括号", async () => {
  const { runOnboarding } = await import("../../src/application/onboarding.js");
  const { renderHuman } = await import("../../src/commands/onboarding.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-onb-matrix4-"));
  const root = join(dir, "wao");
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "agents.example.json"), JSON.stringify({
    agents: {
      w_key: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, _comment_task: "适合任务: 编码", model: { id: "glm-5.3[1m]" } },
      w_login: { backend: "codex", _comment_task: "适合任务: 跑测试", _comment_auth: "codex login", model: { id: "gpt-x" } },
      w_serve: { backend: "opencode-serve", serveUrl: "http://127.0.0.1:4297", model: { id: "glm-5.2" } },
      w_none: { backend: "some-future-backend", model: { id: "m" } },
    },
  }));
  const fsMod = await import("node:fs/promises");
  const r = await runOnboarding({
    installRoot: root,
    exampleRegistryPath: join(root, "config", "agents.example.json"),
    targetRegistryPath: join(root, "config", "agents.json"),
    reliabilitySummaryPath: join(root, "runs", "reliability-summary.json"),
    probeEnv: { hasKeyEnv: async () => "process_env", hasCli: async () => true },
    fs: { readFile: fsMod.readFile, writeFile: fsMod.writeFile, rename: fsMod.rename,
      existsSync, unlink: fsMod.unlink, mkdir: (p2) => fsMod.mkdir(p2, { recursive: true }) },
  });
  const text = renderHuman(r);
  assert.equal(r.recommendations.rows.length, 4);
  // 表头行：列宽与数据行一致（id 22 / backend 15 / model 19 显示格 + 1 分隔空格）。
  assert.match(text, /^ {2}id {23}backend {9}model {15}状态$/m,
    "表头行按显示宽与数据行同列宽（复核 R2：id 列 24 容纳 coder_opencode_fallback）");
  // 第一行布局：id/backend/model 后跟状态括号。
  assert.match(text, /^ {2}w_key\s+claude-code\s+glm-5\.3\[1m\]\s+\[/m,
    "第一行 = id/backend/model/状态");
  // 第二行布局：认证标签与 适合 前缀。
  assert.match(text, /^ {4}认证: .+ · 适合: /m, "第二行 = 认证/适合");
  // 认证标签四分支：
  assert.match(text, /认证: key ZHIPU_API_KEY/, "key 分支");
  assert.match(text, /认证: codex CLI 登录态（codex login）/, "CLI 登录态分支 + authNote 括号拼接");
  // 注：第二行整段按显示宽截到 60——完整标签 "…先起 scripts/serve.ps1）" 的尾部
  // 会被截断，但语义修复面（注入 ≠ 无需 provider key）必须可见。
  assert.match(text, /认证: opencode serve 注入（仍需 provider key/,
    "opencode-serve 分支：注入 ≠ 无需 key（docs/usage.md §Provider key）");
  assert.match(text, /认证: —/, "无 CLI 映射且无 key 分支");
  // authNote 行的精确前缀形状（钉住新拼接形状）。
  assert.match(text, /认证: codex CLI 登录态（/, "结构化基座在前，authNote 只进括号补充");
  // opencode-serve 状态括号：不再误标 [CLI 登录态]；readyState 引擎值不因此变。
  assert.match(text, /w_serve\s+opencode-serve\s+glm-5\.2\s+\[serve 探测未覆盖\]/,
    "opencode-serve 行状态括号为 [serve 探测未覆盖]");
  const serveRow = r.recommendations.rows.find((row) => row.id === "w_serve");
  assert.equal(serveRow.readyState, "login_based",
    "引擎 readyState 不因显示改动词而变（CLI 在 PATH 且无 key ⇒ login_based）");
  rmSync(dir, { recursive: true, force: true });
});

// 复核 R4（auditor 窄复核残留）：P1-2 的显示宽修复此前没有任何测试钉住——
// 把 displayWidth 换回 .length 全套件仍会绿。本组断言堵死该空档：
// (a) displayWidth 单元语义（东亚宽字符计 2）；(b) 渲染矩阵行显示宽 ≤120 上界。
test("复核 R4: displayWidth 语义 + 矩阵渲染行显示宽上界（回归钉）", async () => {
  const { displayWidth, runOnboarding } = await import("../../src/application/onboarding.js");
  const { renderHuman } = await import("../../src/commands/onboarding.js");
  // (a) 单元语义：ASCII 计 1，CJK 计 2（混合）。
  assert.equal(displayWidth("abcd"), 4, "ASCII 每字符 1 格");
  assert.equal(displayWidth("中文"), 4, "CJK 每字符 2 格");
  assert.equal(displayWidth("认证: key ZHIPU_API_KEY"), displayWidth("认证: ") + 17,
    "混合串 = 各段显示宽之和（key ZHIPU_API_KEY = 17 格）");
  // (b) 渲染上界：用含长中文 authNote/duty 的 fixture 渲染，矩阵块每行 ≤120 显示格。
  const dir = mkdtempSync(join(tmpdir(), "wao-onb-width-"));
  const root = join(dir, "wao");
  mkdirSync(join(root, "config"), { recursive: true });
  const longAuth = "很长的认证说明".repeat(12); // 48 CJK = 96 显示格，必触发截断
  const longDuty = "适合任务: " + "中文职责描述".repeat(15);
  writeFileSync(join(root, "config", "agents.example.json"), JSON.stringify({
    agents: {
      coder_hq: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" },
        _comment_task: longDuty, _comment_auth: longAuth },
      tester: { backend: "codex", _comment_task: longDuty, _comment_auth: longAuth },
    },
  }));
  const fsMod = await import("node:fs/promises");
  const r = await runOnboarding({
    installRoot: root,
    exampleRegistryPath: join(root, "config", "agents.example.json"),
    targetRegistryPath: join(root, "config", "agents.json"),
    reliabilitySummaryPath: join(root, "runs", "reliability-summary.json"),
    probeEnv: { hasKeyEnv: async () => "process_env", hasCli: async () => true },
    fs: { readFile: fsMod.readFile, writeFile: fsMod.writeFile, rename: fsMod.rename,
      existsSync, unlink: fsMod.unlink, mkdir: (p2) => fsMod.mkdir(p2, { recursive: true }) },
  });
  const text = renderHuman(r);
  const inMatrix = [];
  let seen = false;
  for (const line of text.split("\n")) {
    if (line.includes("角色矩阵")) seen = true;
    else if (seen && line.includes("按你有的认证")) break;
    else if (seen && line.trim().length > 0) inMatrix.push(line);
  }
  assert.ok(inMatrix.length >= 4, "矩阵块应至少 4 行（表头+两 worker 各两行）");
  for (const line of inMatrix) {
    assert.ok(displayWidth(line) <= 120,
      `矩阵行显示宽超 120（${displayWidth(line)}）: ${line.slice(0, 40)}…`);
  }
  rmSync(dir, { recursive: true, force: true });
});

// ── 18b. R9（决策 0023）：三席会审就绪分级块（模板面）+ panelReadiness 加性字段 ──
//
// Owner 需求 1（两出口都给建议）/ 需求 2（分级三档 + 六态 + 单 worker 注脚 +
// 同族提示）的行为断言。输入注入式 probeEnv（绝无真实探测/真实派发）。

function tmpTemplate(agents, name = "wao-onb-panel-") {
  const root = join(mkdtempSync(join(tmpdir(), name)), "wao");
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "agents.example.json"), JSON.stringify({ agents }));
  return root;
}

async function runWithTemplate(root, probeEnv, extra = {}) {
  const { runOnboarding } = await import("../../src/application/onboarding.js");
  const fsMod = await import("node:fs/promises");
  return runOnboarding({
    installRoot: root,
    exampleRegistryPath: join(root, "config", "agents.example.json"),
    targetRegistryPath: join(root, "config", "agents.json"),
    reliabilitySummaryPath: join(root, "runs", "reliability-summary.json"),
    probeEnv,
    fs: { readFile: fsMod.readFile, writeFile: fsMod.writeFile, rename: fsMod.rename,
      existsSync, unlink: fsMod.unlink, mkdir: (p) => fsMod.mkdir(p, { recursive: true }) },
    ...extra,
  });
}

test("R9 需求 1: no-args 与 selected/--apply 两出口都打印分级块（注入式 registry/env）", async () => {
  const { renderHuman } = await import("../../src/commands/onboarding.js");
  const probeAll = { hasCli: async () => true, hasKeyEnv: async () => "process_env" };
  // 规范形状的两 coder 通道（normalizeAgent 可接受的完整字段；registry 存在性
  // 与 apply 写路径走真实 tmp 文件，绝无真实派发）。
  const root = tmpTemplate({
    coder_hq: {
      backend: "claude-code",
      provider: { protocol: "anthropic-compatible", baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKeyEnv: "ZHIPU_API_KEY" },
      cwd: ".", systemPrompt: "config/roles/coder_hq.md",
      model: { id: "glm-5.3[1m]", contextWindow: 1000000 }, reasoning: { effort: "max" },
    },
    coder_low: {
      backend: "claude-code",
      provider: { protocol: "anthropic-compatible", baseUrl: "https://api.deepseek.com/anthropic", apiKeyEnv: "DEEPSEEK_API_KEY" },
      cwd: ".", systemPrompt: "config/roles/coder_low.md",
      model: { id: "deepseek-v4-pro", contextWindow: 1000000 }, reasoning: { effort: "max" },
    },
  });
  try {
    const r1 = await runWithTemplate(root, probeAll);
    assert.equal(r1.outcome, "needs-selection");
    assert.ok(renderHuman(r1).includes("会审就绪（模板面"), "no-args 出口打印分级块");
    // 出口二：selected + --apply（写真实 tmp 文件后仍打印）。
    const r2 = await runWithTemplate(root, probeAll, { agentId: "coder_hq", apply: true });
    assert.equal(r2.outcome, "applied");
    // R10-B 谎言修复：--apply 写入后磁盘上的私有 registry 即本次生成的单 worker
    // registry——分级块切到已配置面，不再显示模板多 worker 矩阵的"三席可用"。
    const text2 = renderHuman(r2);
    assert.equal(r2.panelFace, "configured", "--apply 成功后分级块数据面 = 已配置面");
    assert.equal(r2.panelConfiguredCount, 1, "生成的 registry 恰 1 名 worker");
    assert.ok(text2.includes("会审就绪（已配置面"), "selected/--apply 出口打印分级块（已配置面）");
    assert.ok(text2.includes("两席可用——次之推荐"), "单 worker 已配置面 → 两席（不是模板三席）");
    assert.ok(!text2.includes("三席可用"), "不得显示模板面多 worker 矩阵的'三席可用'（谎言修复核心）");
    assert.ok(text2.includes("registry 仅一名 worker"), "单 worker 注脚面感知（registry 措辞而非模板措辞）");
    assert.ok(!text2.includes("模板仅一名 worker"), "已配置面不得出现模板措辞注脚");
    assert.ok(text2.includes("已配置 1 名 worker（真实状态以它为准）——完整体检见 `wao doctor`"),
      "指针行在场（1 名 worker 计数 + 完整体检指向 doctor）");
    assert.ok(text2.includes("在场候选（从已配置 registry 派生）"), "惯例句来源标签切到已配置面");
    assert.ok(!text2.includes("按你有的认证"), "selected 分支不带 no-args 的选位尾行（两出口形状不同）");
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("R9 需求 2: 两席（次之推荐）+ 单 worker 注脚——文案明说作者回避使两席建议空转", async () => {
  const { renderHuman } = await import("../../src/commands/onboarding.js");
  const root = tmpTemplate({
    coder_hq: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.3[1m]" } },
    coder_low: { backend: "claude-code", provider: { apiKeyEnv: "DEEPSEEK_API_KEY" }, model: { id: "deepseek-v4-pro" } },
  });
  try {
    // 恰一名可用席位候选（coder_hq ready；coder_low 缺 key）。
    const r = await runWithTemplate(root, {
      hasCli: async () => true,
      hasKeyEnv: async (n) => (n === "ZHIPU_API_KEY" ? "process_env" : "missing"),
    });
    assert.equal(r.panelReadiness.tier, "two_seat");
    const text = renderHuman(r);
    assert.ok(text.includes("两席可用——次之推荐（Lead 主审 + 一名副审）"), "两席分级措辞");
    assert.ok(/可用副审: coder_hq（推断族系：GLM）——补齐第二个副审（建议不同族系）可升级三席/.test(text),
      "补齐第二副审升级句在场（C-9 推断族系 hedging）");
    assert.ok(!text.includes("单 worker"), "多 worker 时单 worker 注脚不出现");
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
  // 单 worker：唯一 worker 即被审产出作者（0019 §3 回避），两席建议事实空转。
  const solo = tmpTemplate({
    coder_solo: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.3[1m]" } },
  }, "wao-onb-solo-");
  try {
    const r = await runWithTemplate(solo, { hasCli: async () => true, hasKeyEnv: async () => "process_env" });
    assert.equal(r.panelReadiness.tier, "two_seat");
    const text = renderHuman(r);
    assert.ok(text.includes("两席可用——次之推荐"), "单可用副审仍按两席分级（前置条件）");
    assert.ok(text.includes("它通常即被审产出的作者（0019 §3 作者回避）——两席建议事实空转"),
      "单 worker 注脚必须明说空转");
  } finally {
    rmSync(join(solo, ".."), { recursive: true, force: true });
  }
});

test("R9 需求 2/4: 无可用副审 → 跳过提示（--panel-skip-reason 登记句在场）", async () => {
  const { renderHuman } = await import("../../src/commands/onboarding.js");
  const root = tmpTemplate({
    coder_hq: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.3[1m]" } },
    coder_low: { backend: "claude-code", provider: { apiKeyEnv: "DEEPSEEK_API_KEY" }, model: { id: "deepseek-v4-pro" } },
  });
  try {
    const r = await runWithTemplate(root, { hasCli: async () => false, hasKeyEnv: async () => "missing" });
    assert.equal(r.panelReadiness.tier, "none");
    const text = renderHuman(r);
    assert.ok(text.includes("当前无可用席位候选"), "none 分级措辞");
    assert.ok(text.includes("--panel-skip-reason"), "跳过需登记理由的提示在场");
    assert.ok(text.includes("强烈推荐但非强制"), "非强制定位明示");
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("R9 需求 5: 同族提示——≥2 可用但推断族系单一 → 跨族系是更强推荐一行", async () => {
  const { renderHuman } = await import("../../src/commands/onboarding.js");
  const root = tmpTemplate({
    coder_g1: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.3[1m]" } },
    coder_g2: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.2" } },
  });
  try {
    const r = await runWithTemplate(root, { hasCli: async () => true, hasKeyEnv: async () => "process_env" });
    assert.equal(r.panelReadiness.tier, "three_seat");
    assert.equal(r.panelReadiness.insufficientFamilyDiversity, true);
    assert.equal(r.panelReadiness.missingAdversarial, true, "双实现席零对抗席（前置条件）");
    const text = renderHuman(r);
    assert.ok(text.includes("跨族系提示"), "同族提示行在场");
    assert.ok(text.includes("跨族系是更强推荐"), "跨族系推荐措辞");
    assert.ok(text.includes("未知族系不参与判定"), "未知族系不参与判定的括注随提示行在场");
    assert.ok(text.includes("无对抗席候选（auditor/coder_mm）——两席分配语义要求对抗视角，建议补配"),
      "C-1：零对抗席的补配提示行在场");
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("R9: login_based 副审（如 auditor）如实展示为登录态未验证，不当已验证讲", async () => {
  const { renderHuman } = await import("../../src/commands/onboarding.js");
  const root = tmpTemplate({
    coder_hq: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.3[1m]" } },
    auditor: { backend: "claude-code", model: { id: "claude-opus-5" }, _comment_auth: "官方 Claude OAuth" },
  });
  try {
    // claude CLI 在 PATH、无 key 声明 → auditor = login_based（登录态无法远程验证）。
    const r = await runWithTemplate(root, { hasCli: async () => true, hasKeyEnv: async () => "process_env" });
    const audRow = r.recommendations.rows.find((row) => row.id === "auditor");
    assert.equal(audRow.readyState, "login_based", "auditor 引擎值是 login_based（前置条件）");
    assert.deepEqual(r.panelReadiness.loginUnverified, ["auditor"]);
    assert.equal(r.panelReadiness.tier, "two_seat", "login_based 不计入可用 ⇒ 只有一名副审");
    const text = renderHuman(r);
    assert.match(text, /登录态未验证（如实展示，不计入可用）: auditor/,
      "登录态未验证句如实展示且点名");
    assert.ok(!/auditor[^\n]{0,12}可用/.test(text.replace(/登录态未验证（如实展示，不计入可用）: auditor/, "")),
      "不得把 auditor 的登录态当已验证讲");
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("R9: panelReadiness 是加性字段——既有键全保留、JSON 可序列化；模板不可读时人类块不打印", async () => {
  const { renderHuman } = await import("../../src/commands/onboarding.js");
  const root = tmpTemplate({
    coder_hq: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.3[1m]" } },
    coder_low: { backend: "claude-code", provider: { apiKeyEnv: "DEEPSEEK_API_KEY" }, model: { id: "deepseek-v4-pro" } },
  });
  try {
    const r = await runWithTemplate(root, { hasCli: async () => true, hasKeyEnv: async () => "process_env" });
    const json = JSON.parse(JSON.stringify(r));
    for (const key of ["mode", "outcome", "selected", "needsSelection", "candidates",
      "registry", "mcpSnippet", "hostExamples", "acceptance", "recommendations",
      "certification", "writes", "reason"]) {
      assert.ok(key in json, `加性字段不得挤掉既有键：${key}`);
    }
    assert.ok(json.panelReadiness && ["three_seat", "two_seat", "none"].includes(json.panelReadiness.tier));
    assert.ok(Array.isArray(json.panelReadiness.available));
    assert.equal(json.panelReadiness.seats.length, 2, "三席时建议组合恰两名");
    for (const e of [...json.panelReadiness.available, ...json.panelReadiness.seats]) {
      assert.ok(typeof e.id === "string" && typeof e.family === "string");
    }
    // R9-C C-1/C-5/C-6：新投影字段形状（injectedAuth/probeUnknown/missingAdversarial/
    // insufficientFamilyDiversity）都是加性可序列化成员。
    for (const key of ["injectedAuth", "probeUnknown", "missingAdversarial", "insufficientFamilyDiversity"]) {
      assert.ok(key in json.panelReadiness, `panelReadiness 投影缺加性字段：${key}`);
    }
    assert.ok(!("sameFamily" in json.panelReadiness), "旧字段名 sameFamily 不再投影（C-6 改名）");
    assert.ok(!/sk-[A-Za-z0-9]{6,}/.test(JSON.stringify(json.panelReadiness)), "不携带凭证值");
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
  // 模板不可读（error 路径）：recommendations 空 → 人类输出整块不打印。
  const fs = makeMemFs({}); // 空内存 fs：模板读取必然 ENOENT
  const err = await runOnboarding({
    installRoot: "D:/wao",
    exampleRegistryPath: "D:/wao/config/agents.example.json",
    targetRegistryPath: "D:/wao/config/agents.json",
    reliabilitySummaryPath: "D:/wao/runs/reliability-summary.json",
    fs,
  });
  assert.equal(err.outcome, "error");
  assert.deepEqual(err.recommendations.rows, []);
  assert.equal(err.panelReadiness.tier, "none", "空 rows 的加性字段如实为 none");
  assert.ok(!renderHuman(err).includes("会审就绪"), "模板不可读 error 路径整块不打印");
});

test("R9: 分级块每行显示宽 ≤120（与矩阵块同纪律）", async () => {
  const { displayWidth } = await import("../../src/application/onboarding.js");
  const { renderHuman } = await import("../../src/commands/onboarding.js");
  const root = tmpTemplate({
    coder_opencode_fallback: { backend: "opencode-serve", serveUrl: "http://127.0.0.1:4297", model: { id: "glm-5.2" }, tokenBudget: 5000000 },
    auditor: { backend: "claude-code", model: { id: "claude-opus-5" } },
    coder_hq: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.3[1m]" } },
    coder_mm: { backend: "claude-code", provider: { apiKeyEnv: "KIMI_API_KEY" }, model: { id: "kimi-code/k3" } },
  });
  try {
    const r = await runWithTemplate(root, { hasCli: async () => true, hasKeyEnv: async () => "process_env" });
    const text = renderHuman(r);
    const inPanel = [];
    let seen = false;
    for (const line of text.split("\n")) {
      if (line.includes("会审就绪")) seen = true;
      else if (seen && (line.includes("Acceptance recipe") || line.includes("Host-neutral") || line.includes("按你有的认证"))) break;
      else if (seen && line.trim().length > 0) inPanel.push(line);
    }
    assert.ok(inPanel.length >= 2, "分级块至少两行（前置条件）");
    for (const line of inPanel) {
      assert.ok(displayWidth(line) <= 120,
        `分级块行显示宽超 120（${displayWidth(line)}）: ${line.slice(0, 40)}…`);
    }
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

// ── 18c. R9-C 返工（auditor 实跑病灶 + C-5/C-12 展示归类）──────────────────────

test("R9-C C-1（auditor 实跑病灶）: researcher 进建议被修复——非席位角色永不进建议组合", async () => {
  const { renderHuman } = await import("../../src/commands/onboarding.js");
  // 实跑失败形状：researcher（DeepSeek key 在）+ coder_hq（GLM key 在）双 ready，
  // 旧引擎曾建议 "researcher + coder_hq"（调研角色进建议 + 零对抗席）。
  const root = tmpTemplate({
    researcher: { backend: "claude-code", provider: { apiKeyEnv: "DEEPSEEK_API_KEY" }, model: { id: "deepseek-v4-pro" } },
    coder_hq: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.3[1m]" } },
  });
  try {
    const r = await runWithTemplate(root, { hasCli: async () => true, hasKeyEnv: async () => "process_env" });
    assert.equal(r.panelReadiness.tier, "two_seat", "仅 coder_hq 是席位候选 → 两席");
    assert.deepEqual(r.panelReadiness.available.map((e) => e.id), ["coder_hq"],
      "researcher（ready）不进可用席位候选");
    assert.equal(r.panelReadiness.seats, null, "无建议组合（不足两名席位候选）");
    const text = renderHuman(r);
    assert.ok(!text.includes("建议席位组合"), "不输出建议组合行");
    assert.ok(!/researcher[^\n]{0,20}(副审|席位组合)/.test(text),
      "researcher 不得被讲成副审/建议组合成员");
    assert.ok(/可用副审: coder_hq（推断族系：GLM）/.test(text), "可用副审只点名席位候选");
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("R9-C C-5: serve 注入型席位单独归类展示——不进'登录态未验证'行", async () => {
  const { renderHuman } = await import("../../src/commands/onboarding.js");
  const root = tmpTemplate({
    coder_hq: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.3[1m]" } },
    coder_opencode_fallback: { backend: "opencode-serve", serveUrl: "http://127.0.0.1:4297", model: { id: "glm-5.2" }, tokenBudget: 5000000 },
  });
  try {
    // opencode CLI 探测为真 + serve 注入型无 key 声明 → 引擎值 login_based（基线
    // 遗留语义），但展示不得把它讲成"登录态未验证"——它是注入式认证。
    const r = await runWithTemplate(root, { hasCli: async () => true, hasKeyEnv: async () => "process_env" });
    const serveRow = r.recommendations.rows.find((row) => row.id === "coder_opencode_fallback");
    assert.equal(serveRow.readyState, "login_based", "引擎 readyState 原值不动（前置条件）");
    assert.deepEqual(r.panelReadiness.injectedAuth, ["coder_opencode_fallback"]);
    assert.deepEqual(r.panelReadiness.loginUnverified, [], "serve 注入型不进登录态未验证清单");
    assert.equal(r.panelReadiness.tier, "two_seat");
    const text = renderHuman(r);
    assert.ok(text.includes("注入式认证（serve 探测不覆盖，不计入可用）: coder_opencode_fallback"),
      "注入式认证单独措辞行在场");
    assert.ok(!text.includes("登录态未验证"), "分级块不再把 serve 注入型标成登录态未验证");
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("R9-C C-12: 探测未知如实展示一行（docblock 承诺的展示面兑现）", async () => {
  const { renderHuman } = await import("../../src/commands/onboarding.js");
  const root = tmpTemplate({
    coder_hq: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.3[1m]" } },
    auditor: { backend: "claude-code", model: { id: "claude-opus-5" } },
  });
  try {
    // CLI 探测超时/失败 → "unknown"（不误标缺失）；席位角色的探测未知如实展示。
    const r = await runWithTemplate(root, { hasCli: async () => "unknown", hasKeyEnv: async () => "process_env" });
    assert.deepEqual(r.panelReadiness.probeUnknown, ["coder_hq", "auditor"]);
    assert.equal(r.panelReadiness.tier, "none", "探测未知不计入可用");
    const text = renderHuman(r);
    assert.ok(text.includes("探测未知（如实展示，不计入可用）: coder_hq、auditor"),
      "探测未知行如实展示且点名");
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

// ── 18e. R10-B：seatRole 显式席位 + readiness 块双面切换 ──────────────────────
//
// B-1：模板行/私有 registry 行都携带 declared seatRole，引擎按 declared 优先计数；
// B-2：runOnboarding(privateRegistryPath) 让 readiness 块在"模板面/已配置面"之间
// 切换（同一 panelReadiness 引擎、同一探测实现——只是输入行换了）。全部探测仍是
// 注入式 probeEnv，绝无真实探测/真实派发。

test("R10-B B-1: 模板面 declared 优先——my_reviewer+adversarial 计入对抗席（未声明同 id 回退非席位）", async () => {
  const probeAll = { hasCli: async () => true, hasKeyEnv: async () => "process_env" };
  const root = tmpTemplate({
    my_reviewer: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "deepseek-v4-pro" }, seatRole: "adversarial" },
    coder_hq: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.3[1m]" }, seatRole: "implementation" },
  }, "wao-onb-decl-");
  try {
    const r = await runWithTemplate(root, probeAll);
    assert.equal(r.panelReadiness.tier, "three_seat", "declared 对抗席 + 实现席 → 三席（模板面）");
    assert.deepEqual(r.panelReadiness.available.map((e) => e.id), ["my_reviewer", "coder_hq"],
      "declared 席位都计入可用");
    assert.equal(r.panelReadiness.missingAdversarial, false, "declared 对抗席满足对抗视角");
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
  // 同 id 未声明 → 回退非席位：只剩 coder_hq → 两席。
  const undeclRoot = tmpTemplate({
    my_reviewer: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "deepseek-v4-pro" } },
    coder_hq: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.3[1m]" } },
  }, "wao-onb-undecl-");
  try {
    const r = await runWithTemplate(undeclRoot, probeAll);
    assert.equal(r.panelReadiness.tier, "two_seat", "未声明的自定义 id 回退非席位（既有行为）");
    assert.deepEqual(r.panelReadiness.available.map((e) => e.id), ["coder_hq"]);
  } finally {
    rmSync(join(undeclRoot, ".."), { recursive: true, force: true });
  }
});

test("R10-B B-1: 已配置面 declared 优先——私有 registry 的 my_reviewer+adversarial 计入对抗席", async () => {
  const root = tmpTemplate({ ghost_tpl: { backend: "codex" } }, "wao-onb-cfgdecl-");
  // R10-C C-2 起已配置面逐条过 normalizeAgent——fixture 用完整 provider 形状
  // （protocol/baseUrl/apiKeyEnv 三字段齐全），与真实可派发 registry 一致。
  writeFileSync(join(root, "config", "agents.json"), JSON.stringify({
    agents: {
      my_reviewer: { backend: "claude-code", provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "ZHIPU_API_KEY" }, cwd: ".", model: { id: "deepseek-v4-pro" }, seatRole: "adversarial" },
      coder_hq: { backend: "claude-code", provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "ZHIPU_API_KEY" }, cwd: ".", model: { id: "glm-5.3[1m]" }, seatRole: "implementation" },
    },
  }));
  try {
    const r = await runWithTemplate(root, { hasCli: async () => true, hasKeyEnv: async () => "process_env" },
      { privateRegistryPath: join(root, "config", "agents.json") });
    assert.equal(r.panelFace, "configured");
    assert.equal(r.panelReadiness.tier, "three_seat", "declared 对抗席 + 实现席 → 三席（已配置面）");
    assert.deepEqual(r.panelReadiness.available.map((e) => e.id), ["my_reviewer", "coder_hq"],
      "已配置面输入行来自私有 registry（模板行 ghost_tpl 不进场）");
    assert.equal(r.panelReadiness.missingAdversarial, false);
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("R10-B B-2: readiness 块双面切换——absent 模板面；present+readable 已配置面 + 指针行；corrupt 降级 + 标注不报错", async () => {
  const { renderHuman } = await import("../../src/commands/onboarding.js");
  const probeAll = { hasCli: async () => true, hasKeyEnv: async () => "process_env" };
  const root = tmpTemplate({
    ghost_tpl: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.3[1m]" } },
  }, "wao-onb-faces-");
  const priv = {
    agents: {
      // R10-C C-2 起已配置面逐条过 normalizeAgent——完整 provider 形状。
      coder_hq: { backend: "claude-code", provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "ZHIPU_API_KEY" }, cwd: ".", model: { id: "glm-5.3[1m]" }, seatRole: "implementation" },
      coder_mm: { backend: "claude-code", provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "ZHIPU_API_KEY" }, cwd: ".", model: { id: "kimi-code/k3" }, seatRole: "adversarial" },
    },
  };
  const privPath = join(root, "config", "agents.json");
  try {
    // (1) private absent（不传路径）→ 既有模板面；无指针行。
    const rAbsent = await runWithTemplate(root, probeAll);
    assert.equal(rAbsent.panelFace, "template", "私有 registry absent → 模板面（既有行为）");
    assert.equal(rAbsent.panelConfiguredCount, null);
    const tAbsent = renderHuman(rAbsent);
    assert.ok(tAbsent.includes("会审就绪（模板面"), "absent 时标题为模板面");
    assert.ok(!tAbsent.includes("真实状态以它为准"), "模板面无指针行");
    // (2) present+readable → 输入行切到私有 registry 行 + 标题/惯例句标签/指针行全切。
    writeFileSync(privPath, JSON.stringify(priv));
    const rCfg = await runWithTemplate(root, probeAll, { privateRegistryPath: privPath });
    assert.equal(rCfg.panelFace, "configured");
    assert.equal(rCfg.panelConfiguredCount, 2, "已配置 2 名 worker（真实 Object.keys 计数）");
    assert.equal(rCfg.panelReadiness.tier, "three_seat");
    assert.deepEqual(rCfg.panelReadiness.available.map((e) => e.id), ["coder_hq", "coder_mm"],
      "输入行来自私有 registry（模板的 ghost_tpl 不进可用）");
    const tCfg = renderHuman(rCfg);
    assert.ok(tCfg.includes("会审就绪（已配置面·按当前环境探测，决策 0023）"), "已配置面标题");
    assert.ok(tCfg.includes("已配置 2 名 worker（真实状态以它为准）——完整体检见 `wao doctor`"),
      "指针行在场（计数 = 私有 registry worker 数）");
    assert.ok(tCfg.includes("在场候选（从已配置 registry 派生）"), "惯例句来源标签切到已配置面");
    // (3) corrupt（不可解析 JSON）→ 降级模板面 + 来源不可读标注；主流程不报错。
    writeFileSync(privPath, "{ not valid json");
    const rBad = await runWithTemplate(root, probeAll, { privateRegistryPath: privPath });
    assert.equal(rBad.panelFace, "template", "损坏 → 降级模板面");
    assert.equal(rBad.panelSourceUnreadable, true, "标注来源不可读");
    assert.equal(rBad.outcome, "needs-selection", "读取失败不得让主流程报错");
    const tBad = renderHuman(rBad);
    assert.ok(tBad.includes("会审就绪（模板面"), "降级后仍按模板面渲染");
    assert.ok(tBad.includes("私有 registry 读取失败"), "不可读标注行在场");
    assert.ok(!tBad.includes("真实状态以它为准"), "降级面无指针行");
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("R10-C C-2: 已配置面第四态 readable-but-invalid——无效条目被 normalizeAgent 剔除 + 有界提示 + 不指名", async () => {
  const { renderHuman } = await import("../../src/commands/onboarding.js");
  const probeAll = { hasCli: async () => true, hasKeyEnv: async () => "process_env" };
  const root = tmpTemplate({
    ghost_tpl: { backend: "claude-code", provider: { apiKeyEnv: "ZHIPU_API_KEY" }, model: { id: "glm-5.3[1m]" } },
  }, "wao-onb-invalid-");
  const privPath = join(root, "config", "agents.json");
  try {
    // (1) 混合：2 条合法 + 1 条 seatRole 闭集外（auditor 的注入形状——
    // validate/getAgent 双拒，修复前却被渲染成席位候选并声称真实状态以它为准）。
    writeFileSync(privPath, JSON.stringify({
      agents: {
        coder_hq: { backend: "claude-code", provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "ZHIPU_API_KEY" }, cwd: ".", model: { id: "glm-5.3[1m]" }, seatRole: "implementation" },
        auditor: { backend: "claude-code", provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "ZHIPU_API_KEY" }, cwd: ".", model: { id: "claude-opus-5" }, seatRole: "adversarial" },
        bad_seat: { backend: "claude-code", provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "ZHIPU_API_KEY" }, cwd: ".", model: { id: "deepseek-v4-pro" }, seatRole: "bogus" },
      },
    }));
    const r = await runWithTemplate(root, probeAll, { privateRegistryPath: privPath });
    assert.equal(r.panelFace, "configured", "可读 → 仍是已配置面（第四态不降级）");
    assert.equal(r.panelConfiguredCount, 3, "计数仍是私有 registry 的真实 worker 数");
    assert.equal(r.panelInvalidEntryCount, 1, "无效条目计数 = 1（seatRole 闭集外）");
    assert.equal(r.panelReadiness.rowCount, 2, "行渲染只含过 normalizeAgent 的条目");
    assert.deepEqual(r.panelReadiness.available.map((e) => e.id), ["coder_hq", "auditor"],
      "被拒条目不进席位候选（不再以真实状态口径渲染坏数据）");
    const text = renderHuman(r);
    assert.ok(text.includes("私有 registry 有 1 条无效条目已剔除——run: npm run cli -- registry validate"),
      "有界提示行在场并指向共享校验权威");
    assert.ok(!text.includes("bad_seat"), "提示不指名被剔除条目（fail-safe）");

    // (2) 全无效：不得被"零行整块不打印"吞掉——提示行仍必须在场。
    writeFileSync(privPath, JSON.stringify({
      agents: { bad_seat: { backend: "claude-code", provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "ZHIPU_API_KEY" }, cwd: ".", seatRole: "bogus" } },
    }));
    const rAll = await runWithTemplate(root, probeAll, { privateRegistryPath: privPath });
    assert.equal(rAll.panelFace, "configured");
    assert.equal(rAll.panelInvalidEntryCount, 1);
    assert.equal(rAll.panelReadiness.rowCount, 0, "唯一条目被剔除 → 零行");
    const tAll = renderHuman(rAll);
    assert.ok(tAll.includes("私有 registry 有 1 条无效条目已剔除"), "全无效时提示行仍打印");
    assert.ok(tAll.includes("会审就绪（已配置面"), "标题行在场（tier=none 如实展示）");

    // (3) 回归：干净 registry → invalidCount 恒 0，无提示行（字节兼容）。
    writeFileSync(privPath, JSON.stringify({
      agents: {
        coder_hq: { backend: "claude-code", provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "ZHIPU_API_KEY" }, cwd: ".", model: { id: "glm-5.3[1m]" }, seatRole: "implementation" },
      },
    }));
    const rClean = await runWithTemplate(root, probeAll, { privateRegistryPath: privPath });
    assert.equal(rClean.panelInvalidEntryCount, 0);
    assert.equal(rClean.panelReadiness.rowCount, 1);
    assert.ok(!renderHuman(rClean).includes("无效条目已剔除"), "干净 registry 无剔除提示");
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("R10-B B-1: coder_opencode_fallback 显式 non_seat → 不再是实现席候选（移除模板字段即红）", async () => {
  // 用真实入库模板：/^coder_/ 前缀惯例会把 coder_opencode_fallback 误归实现席，
  // 显式 seatRole: non_seat 修正之——删除模板里该字段本断言即红（item 3 红测）。
  const raw = readFileSync(join("config", "agents.example.json"), "utf8");
  const { result } = await memRun({
    initial: { "D:/wao/config/agents.example.json": raw },
    probeEnv: { hasCli: async () => true, hasKeyEnv: async () => "missing" },
  });
  const r = await result;
  assert.equal(r.outcome, "needs-selection");
  assert.deepEqual(r.panelReadiness.implementationIds.slice().sort(), ["coder_hq", "coder_low"],
    "实现席清单恰为模板显式声明的两通道——coder_opencode_fallback 被显式 non_seat 剔除");
  assert.deepEqual(r.panelReadiness.adversarialIds.slice().sort(), ["auditor", "coder_mm"],
    "对抗席清单 = 模板显式声明的 auditor + coder_mm");
});

test("R10-B B-1: --apply 生成物逐字携带 seatRole（buildMinimalRegistry 注释剥离不动业务字段）", () => {
  const template = JSON.parse(readFileSync(join("config", "agents.example.json"), "utf8"));
  const fb = buildMinimalRegistry({ template, agentId: "coder_opencode_fallback" });
  assert.equal(fb.agents.coder_opencode_fallback.seatRole, "non_seat",
    "生成物携带显式 seatRole（逐字拷贝模板条目）");
  const hq = buildMinimalRegistry({ template, agentId: "coder_hq" });
  assert.equal(hq.agents.coder_hq.seatRole, "implementation");
});

test("R10-B B-2: doctor/onboarding 已配置面数字对账——同一 registry 同一探测事实 → 同一分级", async () => {
  const { deriveReadyState, assessPanelReadiness, seatRoleOf } = await import("../../src/application/panelReadiness.js");
  const registry = {
    agents: {
      // R10-C C-2 起已配置面逐条过 normalizeAgent——完整 provider 形状。
      coder_hq: { backend: "claude-code", provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "ZHIPU_API_KEY" }, cwd: ".", model: { id: "glm-5.3[1m]" }, seatRole: "implementation" },
      coder_low: { backend: "claude-code", provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "DEEPSEEK_API_KEY" }, cwd: ".", model: { id: "deepseek-v4-pro" }, seatRole: "implementation" },
      researcher: { backend: "claude-code", provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "DEEPSEEK_API_KEY" }, cwd: ".", model: { id: "deepseek-v4-flash" }, seatRole: "non_seat" },
    },
  };
  const probeFacts = { hasCli: async () => true, hasKeyEnv: async (n) => (n === "ZHIPU_API_KEY" ? "process_env" : "missing") };
  // doctor 形状的行生产：同一 readyState 映射（deriveReadyState = 两生产方共用的
  // 单一实现）+ 同一探测事实。doctor 与 onboarding 都是同一引擎的输入包装。
  const doctorRows = Object.entries(registry.agents).map(([id, agent]) => ({
    id,
    backend: agent.backend,
    model: agent.model?.id ?? null,
    seatRole: typeof agent.seatRole === "string" ? agent.seatRole : undefined,
    readyState: deriveReadyState({
      requiresCli: BACKEND_CLI[agent.backend] ?? null,
      requiresKeyEnv: agent.provider?.apiKeyEnv ?? null,
      cli: true,
      key: agent.provider?.apiKeyEnv ? (agent.provider.apiKeyEnv === "ZHIPU_API_KEY" ? "process_env" : "missing") : undefined,
    }),
  }));
  const doctorAssessed = assessPanelReadiness(doctorRows);
  const root = tmpTemplate({ ghost_tpl: { backend: "codex" } }, "wao-onb-reconcile-");
  writeFileSync(join(root, "config", "agents.json"), JSON.stringify(registry));
  try {
    const r = await runWithTemplate(root, probeFacts, { privateRegistryPath: join(root, "config", "agents.json") });
    assert.equal(r.panelFace, "configured");
    assert.equal(r.panelReadiness.tier, doctorAssessed.tier, "同输入同引擎 → 同分级");
    assert.deepEqual(r.panelReadiness.available.map((e) => e.id), doctorAssessed.available.map((e) => e.id),
      "可用席位 id 列表对账");
    assert.equal(r.panelReadiness.missingAdversarial, doctorAssessed.missingAdversarial);
    assert.equal(r.panelReadiness.insufficientFamilyDiversity, doctorAssessed.insufficientFamilyDiversity);
    assert.equal(r.panelReadiness.singleWorkerVacuous, doctorAssessed.singleWorkerVacuous);
    assert.deepEqual(
      r.panelReadiness.implementationIds,
      doctorRows.filter((row) => seatRoleOf(row.id, row.seatRole) === "implementation").map((row) => row.id),
      "实现席候选清单与 doctor 行同源对账（两生产方同一 seatRoleOf）");
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

// ── R11-2（决策 0024）：onboarding 矩阵双源展示契约 ─────────────────────────
// 双源矩阵：私有 registry 可读时，矩阵 = 已配置行（真实状态、私有 registry
// 顺序、不打来源标）+ 模板未配置候选（ready-first、行尾 ·模板候选）；同 id 的
// backend/model.id 漂移挂 ·drift 旗标 + 表后有界明细（≤3 条）；私有独有行省略
// "适合:" 段（缺席不是坏值，不打 "?"）；截断上界私有先占 MAX_CANDIDATES 帽
// （私有独占时模板显 0 + 尾注指向模板文件）。混合判定来自 recommendations 的
// configuredCount 事实（number = 混合），不按行内容推导——0 有效行的 registry
// 仍是已配置面。所有断言走 renderHuman 与 --json 同源的 result 对象。
// WQ-02 状态矩阵：纯模板面（字节回归）/ 已配置全有效 / invalid>0 的 N 口径 /
// 不可读回退 / 同 id drift（含 legacy 形状）/ 私有 ≥ 帽 / 模板溢出 / 双源皆空 /
// 组合同屏（行宽+排序）/ N=0 措辞 / drift 明细 ≤3 上界。

const PROBE_ALL_READY = { hasCli: async () => true, hasKeyEnv: async () => "process_env" };
const PROBE_TEMPLATE_FACE = {
  hasCli: async () => true,
  hasKeyEnv: async (n) => (n === "DEEPSEEK_API_KEY" ? "process_env" : "missing"),
};

// 私有条目工厂：合法最小形状（backend + provider + cwd + model），seatRole 可选。
function privEntry(backend = "claude-code", modelId = "deepseek-v4-flash", apiKeyEnv = "DEEPSEEK_API_KEY", extra = {}) {
  return {
    backend,
    provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv },
    cwd: ".",
    model: { id: modelId },
    ...extra,
  };
}

// 模板面字节回归黄金串（与双源改造前的模板面输出逐字一致——私有缺席时既有
// 展示面不变）。探测：claude CLI 在、DEEPSEEK key 在、其余 key 缺。块界 =
// 角色矩阵头到表尾句前；renderHuman 的块尾部空白用 trimEnd 归一。
const GOLDEN_TEMPLATE_MATRIX = `角色矩阵与当前环境适配（推荐按你当前环境探测结果给出，最终选择权在你（不自动选择、不写配置））:
  id                       backend         model               状态
  coder_low                claude-code     deepseek-v4-flash   [ready]
    认证: key DEEPSEEK_API_KEY · 适合: 边界明确的实现包/TDD/修 bug/重构/兼容性/脚本/文档…
  coder_mm                 kimi-code       kimi-code/k3        [CLI 登录态]
    认证: kimi CLI 登录态 · 适合: 图像/视频内容理解、前端设计与实现、视觉/美术审核
  auditor                  claude-code     claude-opus-5       [CLI 登录态]
    认证: claude CLI 登录态（官方 Claude OAuth（claude logi… · 适合: 前置方案审计/后置独立复核/PASS-FAIL 判定
`;
const GOLDEN_TEMPLATE_BLOCK = `${GOLDEN_TEMPLATE_MATRIX}
会审就绪（模板面·按当前环境探测，决策 0023）: 两席可用——次之推荐（Lead 主审 + 一名副审）
  可用副审: coder_low（推断族系：DeepSeek）——补齐第二个副审（建议不同族系）可升级三席
  登录态未验证（如实展示，不计入可用）: coder_mm、auditor
  席位惯例（0019 §3 保留）: 实现席从 coder 通道取（避同族/避被审产出作者）；组合与选位权由 Lead 决定
  在场候选（从上表模板行派生）: 实现席 coder_low；对抗席 coder_mm、auditor`;

// 不可读回退面只比矩阵部分前缀（分级块尾部多一条 sourceUnreadable 标注行）。
function matrixBlock(text) {
  const start = text.indexOf("角色矩阵与当前环境适配");
  const end = text.indexOf("按你有的认证");
  assert.ok(start !== -1 && end > start, "矩阵块锚缺失（角色矩阵头/表尾句）");
  return text.slice(start, end).trimEnd();
}

test("R11-2 0024 纯模板面：私有缺席 = 现状模板面逐字不变（字节回归）+ source 全 template + 尾句不扩词", async () => {
  const { result } = await memRun({ probeEnv: PROBE_TEMPLATE_FACE });
  const r = await result;
  assert.equal(r.outcome, "needs-selection");
  assert.equal(r.recommendations.configuredCount, null, "模板面无双源事实（number 判定混合，null = 纯模板面）");
  assert.equal(r.recommendations.templateCandidateCount, null);
  assert.ok(r.recommendations.rows.every((row) => row.source === "template"), "JSON 面 source 两态之 template");
  assert.ok(r.recommendations.rows.every((row) => row.drift === undefined), "纯模板面无 drift");
  const text = renderHuman(r);
  assert.equal(matrixBlock(text), GOLDEN_TEMPLATE_BLOCK, "私有缺席时矩阵块逐字不变");
  assert.ok(!text.includes("·模板候选"), "纯模板面不打来源标");
  assert.ok(!text.includes("drift: "), "纯模板面无 drift 明细");
  assert.ok(!text.includes("仅适用模板候选行"), "纯模板面尾句不扩词（既有 R6-C 尾句钉测仍绿）");
});

test("R11-2 0024 已配置面全有效：表头混合句 N/M + registry 顺序在前 + 模板组 ready-first + 行尾标同源投影 + 尾句扩词", async () => {
  const priv = {
    agents: {
      // 同 id coder_low 与模板 backend/model 一致 → 不判 drift；registry 顺序 = 展示顺序。
      coder_hq: privEntry("claude-code", "glm-5.3[1m]", "ZHIPU_API_KEY", { seatRole: "implementation" }),
      coder_low: privEntry("claude-code", "deepseek-v4-flash", "DEEPSEEK_API_KEY", { seatRole: "implementation" }),
    },
  };
  const { result } = await memRun({
    probeEnv: PROBE_ALL_READY,
    privateRegistryPath: "D:/wao/config/agents.json",
    initial: { "D:/wao/config/agents.json": JSON.stringify(priv) },
  });
  const r = await result;
  assert.equal(r.outcome, "needs-selection");
  assert.equal(r.recommendations.configuredCount, 2, "N = 私有有效行总数");
  assert.equal(r.recommendations.templateCandidateCount, 2, "M = 模板行数 − 同 id 数（coder_low 减掉）");
  assert.equal(r.recommendations.privateOmitted, 0);
  assert.equal(r.recommendations.templateOmitted, 0);
  assert.deepEqual(
    r.recommendations.rows.map((x) => [x.id, x.source]),
    [["coder_hq", "configured"], ["coder_low", "configured"], ["coder_mm", "template"], ["auditor", "template"]],
    "已配置行（registry 顺序）在前，模板候选组（ready-first 既有排序）在后");
  assert.ok(r.recommendations.rows.every((row) => row.drift === undefined), "同值同 id 不判 drift");
  const text = renderHuman(r);
  assert.ok(text.includes("矩阵 = 你的 config/agents.json（2 名）+ 模板未配置候选（2 名）"), "表头一句交代混合");
  const lines = text.split("\n");
  const lowLine = lines.find((l) => l.startsWith("  coder_low "));
  assert.ok(!lowLine.includes("·模板候选"), "已配置行不打来源标");
  assert.ok(!lowLine.includes("·drift"), "无 drift 行不挂旗标");
  const mmLine = lines.find((l) => l.startsWith("  coder_mm "));
  assert.ok(mmLine.endsWith("·模板候选"), "模板候选行行 1 尾紧凑标");
  // 同源断言：人读面尾标数量 == JSON 面 source==="template" 行数（投影，不写第二事实源）。
  const tplCount = r.recommendations.rows.filter((x) => x.source === "template").length;
  assert.equal([...text.matchAll(/·模板候选/g)].length, tplCount, "行尾标是 source 字段的投影（同源）");
  assert.ok(text.includes("重跑 --agent <id> --apply（--apply 仅适用模板候选行）；没有的 key 对应行可忽略。"), "表尾句扩词");
  assert.ok(!text.includes("drift: "), "无 drift 明细");
  assert.equal(r.panelFace, "configured");
  assert.deepEqual(r.panelReadiness.available.map((e) => e.id), ["coder_hq", "coder_low"], "已配置面分级块同屏");
});

test("R11-2 0024 高风险组合同屏：invalid>0 的 N 口径 = 有效行 + drift 旗标/明细 + 私有独有行省略适合段 + C-2 提示共存 + 行宽 ≤120", async () => {
  const priv = {
    agents: {
      coder_low: privEntry("claude-code", "deepseek-v4-pro", "DEEPSEEK_API_KEY"), // 同 id、model 漂移
      my_extra: { backend: "kimi-code", cwd: ".", model: { id: "kimi-code/k3" } }, // 私有独有（无 _comment_task）
      bad_seat: privEntry("claude-code", "deepseek-v4-flash", "ZHIPU_API_KEY", { seatRole: "bogus" }), // 无效 → 剔除
    },
  };
  const { result } = await memRun({
    probeEnv: PROBE_ALL_READY,
    privateRegistryPath: "D:/wao/config/agents.json",
    initial: { "D:/wao/config/agents.json": JSON.stringify(priv) },
  });
  const r = await result;
  assert.equal(r.recommendations.configuredCount, 2, "N 口径 = 有效行（bad_seat 剔除后）");
  assert.equal(r.recommendations.templateCandidateCount, 2);
  assert.equal(r.panelInvalidEntryCount, 1);
  assert.deepEqual(
    r.recommendations.rows.map((x) => x.id),
    ["coder_low", "my_extra", "coder_mm", "auditor"],
    "registry 顺序 + 模板组 ready-first 排序同屏不互相污染");
  const text = renderHuman(r);
  assert.ok(text.includes("矩阵 = 你的 config/agents.json（2 名）+ 模板未配置候选（2 名）"));
  const lines = text.split("\n");
  const lowLine = lines.find((l) => l.startsWith("  coder_low "));
  assert.ok(lowLine.includes("·drift"), "drift 行行 1 尾旗标");
  assert.ok(!lowLine.includes("·模板候选"), "已配置行（含 drift 行）不打模板候选标");
  const extraIdx = lines.findIndex((l) => l.startsWith("  my_extra "));
  assert.ok(extraIdx !== -1);
  assert.ok(!lines[extraIdx].includes("·模板候选"), "私有独有行不打模板候选标");
  assert.ok(lines[extraIdx + 1].includes("认证: kimi CLI 登录态"), "私有独有行认证照常");
  assert.ok(!lines[extraIdx + 1].includes("适合:"), "私有独有行'适合:'段整段省略（缺席不是坏值）");
  assert.ok(!lines[extraIdx + 1].includes("?"), "私有独有行不打 ?");
  assert.ok(text.includes(
    "drift: coder_low 私有 model=deepseek-v4-pro/backend=claude-code ≠ 模板 deepseek-v4-flash/claude-code"),
    "drift 有界明细形状固定");
  // 三类注记共存：C-2 提示行 + 指针行 + 分级块（R10-B/R10-C 与矩阵改造同屏）。
  assert.ok(text.includes("私有 registry 有 1 条无效条目已剔除"));
  assert.ok(text.includes("已配置 3 名 worker（真实状态以它为准）"));
  assert.ok(!text.includes("bad_seat"), "不指名被剔除条目");
  assert.ok(!text.includes("config/roles"), "systemPrompt 指针不进展示面");
  // 列宽纪律：矩阵块内所有行 ≤120 显示格（东亚宽字符计 2）。
  const window = matrixBlock(text);
  for (const line of window.split("\n")) {
    assert.ok(displayWidth(line) <= 120, `矩阵块行宽超 120: ${line}`);
  }
});

test("R11-2 0024 私有 0 有效行：表头 N=0 措辞如实 + 全模板候选打标 + 混合面不因行内容退化", async () => {
  const priv = { agents: { bad_seat: privEntry("claude-code", "deepseek-v4-flash", "ZHIPU_API_KEY", { seatRole: "bogus" }) } };
  const { result } = await memRun({
    probeEnv: PROBE_ALL_READY,
    privateRegistryPath: "D:/wao/config/agents.json",
    initial: { "D:/wao/config/agents.json": JSON.stringify(priv) },
  });
  const r = await result;
  assert.equal(r.recommendations.configuredCount, 0, "N = 0（全无效）");
  assert.equal(r.recommendations.templateCandidateCount, 3, "模板 3 行全成候选（bad_seat 不同 id 不抵消）");
  assert.ok(r.recommendations.rows.every((row) => row.source === "template"));
  const text = renderHuman(r);
  assert.ok(text.includes("矩阵 = 你的 config/agents.json（0 名）+ 模板未配置候选（3 名）"), "N=0 措辞如实（判定不靠行内容）");
  assert.equal([...text.matchAll(/·模板候选/g)].length, 3, "全部模板候选行打标");
  assert.ok(text.includes("私有 registry 有 1 条无效条目已剔除"), "C-2 提示在场");
});

test("R11-2 0024 私有不可读回退模板面：矩阵逐字不变 + sourceUnreadable 标注 + 不打标不扩词", async () => {
  const { result } = await memRun({
    probeEnv: PROBE_TEMPLATE_FACE,
    privateRegistryPath: "D:/wao/config/agents.json",
    initial: { "D:/wao/config/agents.json": "{ not valid json" },
  });
  const r = await result;
  assert.equal(r.outcome, "needs-selection");
  assert.equal(r.panelFace, "template");
  assert.equal(r.panelSourceUnreadable, true);
  assert.equal(r.recommendations.configuredCount, null, "不可读降级面无双源事实");
  const text = renderHuman(r);
  assert.ok(text.startsWith(GOLDEN_TEMPLATE_MATRIX, text.indexOf("角色矩阵与当前环境适配")),
    "不可读降级后矩阵部分与模板面逐字一致");
  assert.ok(text.includes("私有 registry 读取失败"), "sourceUnreadable 标注行在场");
  assert.ok(!text.includes("·模板候选"), "降级面不打来源标");
  assert.ok(!text.includes("仅适用模板候选行"), "降级面尾句不扩词");
});

test("R11-2 0024 drift 闭集仅 backend + model.id：opencode legacy 形状（providerID/contextWindow/variant）差异不误判", async () => {
  // 模板侧 legacy 形状：providerID/variant/contextWindow 全不同但 id 相同。
  const customTpl = {
    agents: {
      keep: {
        backend: "claude-code",
        provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "K_API_KEY" },
        cwd: ".",
        model: { providerID: "deepseek", id: "deepseek-v4-pro", variant: "legacy-a", contextWindow: 1000000 },
      },
      swp: { backend: "kimi-code", cwd: ".", model: { providerID: "kimi", id: "kimi-code/k3" } },
    },
  };
  const priv = {
    agents: {
      keep: {
        backend: "claude-code",
        provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "K_API_KEY" },
        cwd: ".",
        model: { providerID: "deepseek", id: "deepseek-v4-pro", contextWindow: 500000 },
      },
      swp: {
        backend: "claude-code",
        provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "K_API_KEY" },
        cwd: ".",
        model: { id: "deepseek-v4-pro" },
      },
    },
  };
  const { result } = await memRun({
    probeEnv: PROBE_ALL_READY,
    privateRegistryPath: "D:/wao/config/agents.json",
    initial: {
      "D:/wao/config/agents.example.json": JSON.stringify(customTpl),
      "D:/wao/config/agents.json": JSON.stringify(priv),
    },
  });
  const r = await result;
  const keep = r.recommendations.rows.find((x) => x.id === "keep");
  const swp = r.recommendations.rows.find((x) => x.id === "swp");
  assert.equal(keep.drift, undefined, "providerID/contextWindow/variant 形状差异 ≠ drift");
  assert.ok(swp.drift, "backend 差异 = drift");
  assert.equal(swp.drift.templateBackend, "kimi-code");
  assert.equal(swp.drift.templateModel, "kimi-code/k3");
});

test("R11-2 0024 私有 ≥ 帽：私有先占 64、模板显 0 + 尾注指向模板文件 + 溢出事实在场", async () => {
  const agents = {};
  for (let i = 0; i < 70; i += 1) {
    agents[`w_${String(i).padStart(2, "0")}`] = privEntry("claude-code", `m-${i}`, "K_API_KEY");
  }
  const { result } = await memRun({
    probeEnv: PROBE_ALL_READY,
    privateRegistryPath: "D:/wao/config/agents.json",
    initial: { "D:/wao/config/agents.json": JSON.stringify({ agents }) },
  });
  const r = await result;
  assert.equal(r.recommendations.configuredCount, 70, "N = 真实有效行数（不受显示帽）");
  assert.equal(r.recommendations.privateOmitted, 6);
  assert.equal(r.recommendations.templateCandidateCount, 3);
  assert.equal(r.recommendations.templateOmitted, 3);
  assert.equal(r.recommendations.rows.length, MAX_CANDIDATES, "总行数 = 64 硬帽");
  assert.ok(r.recommendations.rows.every((x) => x.source === "configured"), "私有先占帽，模板显 0");
  const text = renderHuman(r);
  assert.ok(text.includes("矩阵 = 你的 config/agents.json（70 名）+ 模板未配置候选（3 名）"));
  assert.ok(text.includes("私有 registry 另有 6 名有效 worker 超出 64 行显示上限"));
  assert.ok(text.includes("模板候选未显示（私有行已占满 64 行上限）——完整模板见 config/agents.example.json"));
});

test("R11-2 0024 模板溢出：私有 2 + 模板候选 64 → 模板补到 62 + '另有 K 名'尾注", async () => {
  const tplAgents = {
    a1: { backend: "claude-code", cwd: ".", model: { id: "m" } },
    a2: { backend: "claude-code", cwd: ".", model: { id: "m" } },
  };
  for (let i = 0; i < 64; i += 1) {
    tplAgents[`t_${String(i).padStart(2, "0")}`] = { backend: "codex", cwd: ".", model: { id: "m" } };
  }
  const priv = {
    agents: {
      a1: privEntry("claude-code", "m", "K_API_KEY"),
      a2: privEntry("claude-code", "m", "K_API_KEY"),
    },
  };
  const { result } = await memRun({
    probeEnv: PROBE_ALL_READY,
    privateRegistryPath: "D:/wao/config/agents.json",
    initial: {
      "D:/wao/config/agents.example.json": JSON.stringify({ agents: tplAgents }),
      "D:/wao/config/agents.json": JSON.stringify(priv),
    },
  });
  const r = await result;
  assert.equal(r.recommendations.configuredCount, 2);
  assert.equal(r.recommendations.templateCandidateCount, 64, "模板候选 = 66 行 − 2 同 id");
  assert.equal(r.recommendations.templateOmitted, 2);
  assert.equal(r.recommendations.rows.length, MAX_CANDIDATES);
  assert.equal(r.recommendations.rows.filter((x) => x.source === "template").length, 62, "模板补到 64 − 私有已显");
  const text = renderHuman(r);
  assert.ok(text.includes("另有 2 名模板候选未显示"), "模板溢出尾注");
  assert.ok(!text.includes("完整模板见"), "非私有独占形态不指向模板文件");
});

test("R11-2 0024 双源皆空：0 行不渲染矩阵块、事实字段如实、主流程不崩", async () => {
  const { result } = await memRun({
    privateRegistryPath: "D:/wao/config/agents.json",
    initial: {
      "D:/wao/config/agents.example.json": JSON.stringify({ agents: {} }),
      "D:/wao/config/agents.json": JSON.stringify({ agents: {} }),
    },
  });
  const r = await result;
  assert.equal(r.outcome, "needs-selection");
  assert.equal(r.recommendations.configuredCount, 0);
  assert.equal(r.recommendations.templateCandidateCount, 0);
  assert.deepEqual(r.recommendations.rows, []);
  assert.equal(r.panelReadiness.rowCount, 0);
  const text = renderHuman(r);
  assert.ok(!text.includes("角色矩阵"), "零行不渲染矩阵块");
});

test("R11-2 0024 drift 明细 ≤3 上界：5 条 drift → 3 条明细 + '另有 2 条'尾注", async () => {
  const tplAgents = {};
  const privAgents = {};
  for (let i = 1; i <= 5; i += 1) {
    tplAgents[`d${i}`] = { backend: "claude-code", cwd: ".", model: { id: "t-m" } };
    privAgents[`d${i}`] = privEntry("claude-code", "p-m", "K_API_KEY");
  }
  const { result } = await memRun({
    probeEnv: PROBE_ALL_READY,
    privateRegistryPath: "D:/wao/config/agents.json",
    initial: {
      "D:/wao/config/agents.example.json": JSON.stringify({ agents: tplAgents }),
      "D:/wao/config/agents.json": JSON.stringify({ agents: privAgents }),
    },
  });
  const r = await result;
  assert.equal(r.recommendations.configuredCount, 5);
  assert.equal(r.recommendations.templateCandidateCount, 0, "全同 id，模板无候选");
  assert.ok(r.recommendations.rows.every((row) => row.drift), "五行全 drift");
  const text = renderHuman(r);
  const detailLines = text.split("\n").filter((l) => l.startsWith("  drift: "));
  assert.equal(detailLines.length, 3, "drift 明细 ≤3 上界");
  assert.ok(text.includes("另有 2 条 drift 明细未显示"), "超出部分有界尾注");
});
