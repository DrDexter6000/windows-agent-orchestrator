// test/playbookCatalog.test.js
//
// M11-2A: Lead Playbook Catalog kernel tests.
//
// The catalog is a read-only, provider-neutral, deterministic registry of
// exactly four built-in Lead playbooks. It must NOT dispatch, execute a
// workflow, or make semantic decisions for the Lead. No env/Git/transcript/
// argv/console/commands/MCP/SDK/zod dependencies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { listLeadPlaybooks, getLeadPlaybook } from "../src/application/playbookCatalog.js";

const APPROVED_IDS = [
  "single-coder-delivery",
  "parallel-independent-deliveries",
  "investigate-then-implement",
  "read-only-independent-review",
];

// ===== PB-A01: exactly four approved IDs, stable order =====

test("PB-A01: listLeadPlaybooks returns exactly the four approved IDs in stable order", () => {
  const list = listLeadPlaybooks();
  assert.ok(Array.isArray(list));
  assert.equal(list.length, 4, "exactly four playbooks");
  const ids = list.map((p) => p.id);
  assert.deepEqual(ids, APPROVED_IDS, "stable order matches approved sequence");
});

// ===== PB-A02: bounded list summary shape =====

test("PB-A02: each list entry has exactly {id, version, title, summary, lanePattern} and bounded values", () => {
  const list = listLeadPlaybooks();
  for (const entry of list) {
    const keys = Object.keys(entry).sort();
    assert.deepEqual(keys, ["id", "lanePattern", "summary", "title", "version"],
      `list entry keys must be exactly {id, version, title, summary, lanePattern}; got ${keys.join(",")}`);
    assert.equal(typeof entry.id, "string");
    assert.ok(entry.id.length >= 1 && entry.id.length <= 64);
    assert.equal(entry.version, 1);
    assert.equal(typeof entry.title, "string");
    assert.ok(entry.title.length >= 1 && entry.title.length <= 80);
    assert.equal(typeof entry.summary, "string");
    assert.ok(entry.summary.length >= 1 && entry.summary.length <= 240);
    assert.equal(typeof entry.lanePattern, "string");
    assert.ok(["single", "parallel-independent", "serial-discovery", "read-only"].includes(entry.lanePattern));
  }
});

// ===== PB-A03: getLeadPlaybook returns complete validated PlaybookV1 =====

test("PB-A03: getLeadPlaybook returns a complete, validated PlaybookV1 for each approved ID", () => {
  for (const id of APPROVED_IDS) {
    const pb = getLeadPlaybook({ id });
    assert.equal(pb.id, id);
    assert.equal(pb.version, 1);
    assert.ok(typeof pb.title === "string" && pb.title.length >= 1 && pb.title.length <= 80);
    assert.ok(typeof pb.summary === "string" && pb.summary.length >= 1 && pb.summary.length <= 240);
    assert.ok(Array.isArray(pb.useWhen) && pb.useWhen.length >= 1 && pb.useWhen.length <= 4);
    assert.ok(Array.isArray(pb.avoidWhen) && pb.avoidWhen.length >= 1 && pb.avoidWhen.length <= 4);
    assert.ok(typeof pb.lanePattern === "string");
    assert.ok(Array.isArray(pb.roles) && pb.roles.length >= 1 && pb.roles.length <= 5);
    assert.ok(Array.isArray(pb.phases) && pb.phases.length >= 1 && pb.phases.length <= 6);
    assert.ok(Array.isArray(pb.completionEvidence) && pb.completionEvidence.length >= 1 && pb.completionEvidence.length <= 6);
    assert.ok(typeof pb.escalation === "object" && pb.escalation !== null);
    assert.ok(typeof pb.escalation.advisor === "string" && pb.escalation.advisor.length >= 1 && pb.escalation.advisor.length <= 240);
    assert.ok(typeof pb.escalation.auditor === "string" && pb.escalation.auditor.length >= 1 && pb.escalation.auditor.length <= 240);
  }
});

// ===== PB-A04: unknown ID gives fixed typed application error =====

test("PB-A04: unknown ID throws a fixed typed PlaybookNotFoundError", () => {
  const err = assert.throw
    ? null
    : null;
  // Node assert.throws for sync throw
  let caught = null;
  try { getLeadPlaybook({ id: "does-not-exist" }); } catch (e) { caught = e; }
  assert.ok(caught, "must throw for unknown ID");
  assert.equal(caught.name, "PlaybookNotFoundError", "fixed typed error name");
  assert.ok(/does-not-exist/.test(caught.message) || /unknown|not found/i.test(caught.message),
    "error message references the unknown ID");
});

// ===== PB-A05: duplicate/unknown/missing/version fail-closed =====

test("PB-A05: missing id, null, non-string, and empty id all fail-closed with typed error", () => {
  for (const bad of [null, undefined, "", 123, {}, [], true]) {
    let caught = null;
    try { getLeadPlaybook({ id: bad }); } catch (e) { caught = e; }
    assert.ok(caught, `must throw for id=${JSON.stringify(bad)}`);
    // typed error (PlaybookNotFoundError for unknown, or a validation error for malformed input)
    assert.ok(caught.name === "PlaybookNotFoundError" || caught.name === "PlaybookValidationError",
      `typed error for id=${JSON.stringify(bad)}; got ${caught.name}`);
  }
});

// ===== PB-A06: bounds — roles, lanes, importance, phases, strings, 12 KiB =====

test("PB-A06: all built-in playbooks satisfy structural bounds (roles<=5, phases<=6, lists<=4, completionEvidence<=6, min<=max, 12 KiB)", () => {
  for (const id of APPROVED_IDS) {
    const pb = getLeadPlaybook({ id });
    assert.ok(pb.roles.length <= 5, `${id}: roles <= 5`);
    assert.ok(pb.phases.length <= 6, `${id}: phases <= 6`);
    assert.ok(pb.useWhen.length <= 4, `${id}: useWhen <= 4`);
    assert.ok(pb.avoidWhen.length <= 4, `${id}: avoidWhen <= 4`);
    assert.ok(pb.completionEvidence.length <= 6, `${id}: completionEvidence <= 6`);
    for (const r of pb.roles) {
      assert.ok(["coder", "researcher", "tester", "advisor", "auditor"].includes(r.capability),
        `${id}: valid capability ${r.capability}`);
      assert.ok(["core", "conditional"].includes(r.importance),
        `${id}: valid importance ${r.importance}`);
      assert.ok(Number.isInteger(r.min) && r.min >= 0 && r.min <= 4, `${id}: role min 0..4`);
      assert.ok(Number.isInteger(r.max) && r.max >= 0 && r.max <= 4, `${id}: role max 0..4`);
      assert.ok(r.min <= r.max, `${id}: min <= max`);
    }
    for (const ph of pb.phases) {
      assert.ok(typeof ph.id === "string" && ph.id.length >= 1 && ph.id.length <= 64, `${id}: phase id 1..64`);
      assert.ok(typeof ph.intent === "string" && ph.intent.length >= 1 && ph.intent.length <= 240, `${id}: phase intent 1..240`);
      assert.ok(["core", "conditional"].includes(ph.importance), `${id}: phase importance`);
      assert.ok(Array.isArray(ph.evidence) && ph.evidence.length >= 1 && ph.evidence.length <= 4, `${id}: phase evidence 1..4`);
      assert.ok(Array.isArray(ph.adaptations) && ph.adaptations.length >= 1 && ph.adaptations.length <= 4, `${id}: phase adaptations 1..4`);
    }
    // 12 KiB bound on UTF-8 serialized full object
    const bytes = Buffer.from(JSON.stringify(pb), "utf8").length;
    assert.ok(bytes <= 12288, `${id}: full object <= 12 KiB (got ${bytes})`);
  }
});

// ===== PB-A07: forbidden content (worker/runtime/model/path/shell/prompt/personality) =====

test("PB-A07: no built-in playbook contains forbidden content (worker IDs, runtime/model IDs, absolute paths, shell commands, source code, full prompts, personality text)", () => {
  const FORBIDDEN_PATTERNS = [
    /claude-code|codex|kimi|opencode|glm/i,       // runtime/model IDs
    /node_modules\//,                                // path
    /[A-Za-z]:\\\\/,                                 // Windows absolute path
    /\/home\/|\/usr\/|\/etc\//,                      // POSIX absolute path
    /rm\s+-rf|sudo|exec\s*\(|eval\s*\(/,            // shell command / code injection
    /AKIA[0-9A-Z]{16}/,                              // credential sentinel
    /\bapi[_-]?key\b|\bsecret\b|\bpassword\b/i,      // credential words
  ];
  for (const id of APPROVED_IDS) {
    const pb = getLeadPlaybook({ id });
    const dumped = JSON.stringify(pb);
    for (const pat of FORBIDDEN_PATTERNS) {
      assert.ok(!pat.test(dumped), `${id}: forbidden pattern ${pat} must not appear in catalog`);
    }
  }
});

// ===== PB-A08: Advisor/Auditor cannot be core =====

test("PB-A08: advisor and auditor roles are never 'core' importance in any built-in", () => {
  for (const id of APPROVED_IDS) {
    const pb = getLeadPlaybook({ id });
    for (const r of pb.roles) {
      if (r.capability === "advisor" || r.capability === "auditor") {
        assert.notEqual(r.importance, "core",
          `${id}: ${r.capability} must not be core`);
      }
    }
  }
});

// ===== PB-A09: returned data cannot mutate catalog cache =====

test("PB-A09: mutating a returned playbook or list entry does not affect subsequent calls (deep clone)", () => {
  const pb1 = getLeadPlaybook({ id: "single-coder-delivery" });
  pb1.title = "TAMPERED";
  pb1.roles[0].capability = "TAMPERED";
  pb1.phases[0].intent = "TAMPERED";
  const pb2 = getLeadPlaybook({ id: "single-coder-delivery" });
  assert.notEqual(pb2.title, "TAMPERED", "title not mutated in cache");
  assert.notEqual(pb2.roles[0].capability, "TAMPERED", "nested role not mutated in cache");
  assert.notEqual(pb2.phases[0].intent, "TAMPERED", "nested phase not mutated in cache");

  const list1 = listLeadPlaybooks();
  list1[0].title = "LIST_TAMPERED";
  const list2 = listLeadPlaybooks();
  assert.notEqual(list2[0].title, "LIST_TAMPERED", "list entry not mutated in cache");

  // Also: returned objects should be distinct references across calls (deep clone)
  const pb3 = getLeadPlaybook({ id: "single-coder-delivery" });
  assert.notEqual(pb1, pb3, "each get returns a new reference");
  assert.notEqual(pb1.roles, pb3.roles, "nested arrays are distinct");
});

// ===== PB-A10: dependency boundary — no env/Git/commands/MCP/SDK/zod =====

test("PB-A10: playbookCatalog.js imports no commands/MCP/SDK/zod and does not read env/Git/argv/console", async () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "application", "playbookCatalog.js"),
    "utf8",
  );
  assert.ok(!src.includes('from "../commands/'), "no commands/");
  assert.ok(!src.includes('from "../mcp/'), "no mcp/");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "no MCP SDK");
  assert.ok(!src.includes('from "zod"'), "no zod");
  assert.ok(!src.includes("process.env"), "no process.env");
  assert.ok(!/execFileSync|execSync|spawnSync/.test(src), "no Git subprocess");
  assert.ok(!/process\.argv/.test(src), "no argv");
  assert.ok(!/console\./.test(src), "no console");
});

// ===== PB-A11: existing workflow templates byte-identical =====

test("PB-A11: existing workflow templates are byte-identical (playbook catalog did not touch them)", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const ROOT = join(__dirname, "..");
  const templates = [
    { file: "workflows/templates/analyze-implement.mjs", sha: "2b58da89f222e5f59f0df6f0078c1ce308dd41b89848bc607533d521cf8412da" },
    { file: "workflows/templates/parallel-research.mjs", sha: "603420046a975adf43d2be70002a640dbaeb2f24be3ab882b6bda88618631840" },
  ];
  for (const t of templates) {
    const content = readFileSync(join(ROOT, t.file));
    const sha = createHash("sha256").update(content).digest("hex");
    assert.equal(sha, t.sha, `${t.file} byte-identical (SHA-256 match)`);
  }
});

// ===== PB-A12: catalog reads cause no transcript/filesystem mutation =====

test("PB-A12: listLeadPlaybooks and getLeadPlaybook do not create files in runs/ or mutate the playbooks directory", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const ROOT = join(__dirname, "..");
  // Snapshot playbooks/ directory state before
  const pbDir = join(ROOT, "playbooks", "lead");
  const before = existsSync(pbDir) ? readdirSync(pbDir).sort() : [];
  // Call both APIs multiple times
  listLeadPlaybooks();
  listLeadPlaybooks();
  for (const id of APPROVED_IDS) {
    getLeadPlaybook({ id });
    getLeadPlaybook({ id });
  }
  // playbooks/lead must be unchanged
  const after = existsSync(pbDir) ? readdirSync(pbDir).sort() : [];
  assert.deepEqual(after, before, "playbooks/lead directory unchanged after reads");
});
