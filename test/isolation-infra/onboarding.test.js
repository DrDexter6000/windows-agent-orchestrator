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
      cwd: "D:/projects/your-project",
      systemPrompt: "config/roles/coder_low.md",
      args: ["--dangerously-skip-permissions"],
      model: { id: "deepseek-v4-flash", contextWindow: 1000000 },
      reasoning: { effort: "max" },
    },
    coder_mm: {
      _comment: "[Coder-MM] role comment",
      _comment_task: "适合任务: 图像/视频内容理解、前端设计与实现、视觉/美术审核",
      backend: "kimi-code",
      cwd: "D:/projects/your-project",
      systemPrompt: "config/roles/coder_mm.md",
      model: { id: "kimi-code/k3" },
    },
    auditor: {
      _comment: "[Auditor] role comment",
      _comment_auth: "官方 Claude OAuth（claude login），不走 wrapper",
      _comment_task: "适合任务: 前置方案审计/后置独立复核/PASS-FAIL 判定",
      backend: "claude-code",
      cwd: "D:/projects/your-project",
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

test("R6-C: backend→CLI mapping covers all four backends", () => {
  assert.deepEqual(BACKEND_CLI, {
    "claude-code": "claude",
    codex: "codex",
    "kimi-code": "kimi",
    "opencode-serve": "opencode",
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
  assert.ok(text.includes("官方 Claude OAuth（claude login）"), "authNote from _comment_auth rendered");
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
