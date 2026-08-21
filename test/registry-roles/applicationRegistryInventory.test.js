// test/applicationRegistryInventory.test.js
//
// M9-0: registry inventory application service — TDD tests.
//
// Proves that CLI can delegate to a shared, console-free, argv-free,
// MCP-free application service for registry inventory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getRegistryInventory,
  getRegistryInventoryWithIssues,
  projectRegistryIssues,
  normalizeInventoryResult,
  REGISTRY_ISSUES_CAP,
  REGISTRY_ISSUE_CODES,
} from "../../src/application/registryInventory.js";
// R23-C F6：buildCertMap 的 providerKey 透传钉（见文末测试）。
import { providerKeyFor } from "../../src/providerFingerprint.js";

// ===== Helpers =====

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

function makeSummary(dir, workers) {
  const runDir = join(dir, "runs");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({ workers }), "utf8");
  return runDir;
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ===== Tests =====

test("M9-0-01: summary exists → correctly merges certification status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m90-01-"));
  try {
    const registryPath = makeRegistry(dir, {
      coder_hq: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
      researcher: { backend: "claude-code", cwd: dir, model: { id: "deepseek-v4-flash" } },
    });
    const runDir = makeSummary(dir, {
      coder_hq: { status: "certified" },
      researcher: { status: "conditional" },
    });

    const result = await getRegistryInventory({ registryPath, runDir });
    assert.equal(result.length, 2);
    const hq = result.find((a) => a.id === "coder_hq");
    const res = result.find((a) => a.id === "researcher");
    assert.equal(hq.certification, "certified");
    assert.equal(res.certification, "conditional");
    assert.equal(hq.backend, "claude-code");
    assert.equal(hq.model, "glm-5.2");
  } finally {
    cleanupDir(dir);
  }
});

test("M9-0-02: summary missing → certification is null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m90-02-"));
  try {
    const registryPath = makeRegistry(dir, {
      coder_hq: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
    });
    // No summary file, runDir points to empty dir
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });

    const result = await getRegistryInventory({ registryPath, runDir });
    assert.equal(result.length, 1);
    assert.equal(result[0].certification, null);
  } finally {
    cleanupDir(dir);
  }
});

test("M9-0-03: summary corrupted JSON → certification is null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m90-03-"));
  try {
    const registryPath = makeRegistry(dir, {
      coder_hq: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
    });
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "reliability-summary.json"), "{ not valid json }", "utf8");

    const result = await getRegistryInventory({ registryPath, runDir });
    assert.equal(result.length, 1);
    assert.equal(result[0].certification, null);
  } finally {
    cleanupDir(dir);
  }
});

test("M9-0-04: explicit model and process backend (default) fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m90-04-"));
  try {
    const registryPath = makeRegistry(dir, {
      coder_hq: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
      coder_mm: { backend: "kimi-code", cwd: dir },
      tester: { backend: "codex", cwd: dir, args: [] },
    });
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });

    const result = await getRegistryInventory({ registryPath, runDir });
    const hq = result.find((a) => a.id === "coder_hq");
    const mm = result.find((a) => a.id === "coder_mm");
    const tester = result.find((a) => a.id === "tester");
    assert.equal(hq.model, "glm-5.2", "explicit model from --model arg");
    assert.equal(mm.model, "(default)", "kimi-code with no model → (default)");
    assert.equal(tester.model, "(default)", "codex with no model → (default)");
  } finally {
    cleanupDir(dir);
  }
});

test("M9-0-05: service returns structured data and does not write to console", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m90-05-"));
  try {
    const registryPath = makeRegistry(dir, {
      coder_hq: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
    });
    const runDir = makeSummary(dir, { coder_hq: { status: "certified" } });

    // Capture console.log to prove the service doesn't write
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => { logs.push(a); };
    try {
      const result = await getRegistryInventory({ registryPath, runDir });
      assert.equal(logs.length, 0, "service must not write to console");
      assert.ok(Array.isArray(result));
      assert.ok(result[0].id);
      assert.ok(result[0].backend);
      assert.ok("model" in result[0]);
      assert.ok("certification" in result[0]);
      assert.ok("cwd" in result[0]);
    } finally {
      console.log = origLog;
    }
  } finally {
    cleanupDir(dir);
  }
});

test("M9-0-06: agent in registry but not in summary → certification null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m90-06-"));
  try {
    const registryPath = makeRegistry(dir, {
      coder_hq: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
      auditor: { backend: "claude-code", cwd: dir, model: { id: "opus" } },
    });
    const runDir = makeSummary(dir, {
      coder_hq: { status: "certified" },
      // auditor not in summary
    });

    const result = await getRegistryInventory({ registryPath, runDir });
    const auditor = result.find((a) => a.id === "auditor");
    assert.equal(auditor.certification, null, "agent not in summary → null");
  } finally {
    cleanupDir(dir);
  }
});

test("M9-0-06b: certification is not inherited after backend or model changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m90-06b-"));
  try {
    const registryPath = makeRegistry(dir, {
      coder_low: {
        backend: "deepseek-harness",
        cwd: dir,
        dshConfigPath: join(dir, "dsh.yml"),
        credentialEnv: "DEEPSEEK_API_KEY",
        model: { id: "deepseek-v4-flash" },
      },
    });
    const runDir = makeSummary(dir, {
      coder_low: {
        status: "certified",
        backend: "claude-code",
        modelId: "deepseek-v4-flash",
      },
    });

    const [result] = await getRegistryInventory({ registryPath, runDir });
    assert.equal(result.certification, null);
  } finally {
    cleanupDir(dir);
  }
});

test("M9-0-07: fake dependency injection — no real filesystem touched", async () => {
  let readRegistryCalled = false;
  let readFileCalled = false;

  // Fake readRegistry returns an in-memory registry — no file read
  const fakeReadRegistry = async () => {
    readRegistryCalled = true;
    return {
      listAgents() {
        return [
          { id: "coder_hq", backend: "claude-code", cwd: "/fake", model: { id: "glm-5.2" } },
          { id: "researcher", backend: "claude-code", cwd: "/fake", model: { id: "opus" } },
        ];
      },
      getAgent(id) { throw new Error(`not implemented for fake: ${id}`); },
    };
  };

  // Fake readFile returns in-memory reliability summary — no file read
  const fakeReadFile = async () => {
    readFileCalled = true;
    return JSON.stringify({
      workers: {
        coder_hq: { status: "certified" },
      },
    });
  };

  const result = await getRegistryInventory({
    registryPath: "/nonexistent/registry.json",
    runDir: "/nonexistent/runs",
    readRegistryFn: fakeReadRegistry,
    readFileFn: fakeReadFile,
  });

  assert.ok(readRegistryCalled, "fake readRegistry was called (not real filesystem)");
  assert.ok(readFileCalled, "fake readFile was called for summary");

  assert.equal(result.length, 2);
  const hq = result.find((a) => a.id === "coder_hq");
  const res = result.find((a) => a.id === "researcher");
  assert.equal(hq.certification, "certified", "certification merged from fake summary");
  assert.equal(res.certification, null, "agent not in fake summary → null");
  assert.equal(hq.model, "glm-5.2");
});

// ===== Boundary test: src/application must not import from src/commands =====

test("M9-0-BOUNDARY: src/application must not import from src/commands", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const appDir = join(process.cwd(), "src", "application");

  let files;
  try {
    files = await readdir(appDir);
  } catch {
    // Directory doesn't exist yet — skip
    return;
  }

  const jsFiles = files.filter((f) => f.endsWith(".js"));
  assert.ok(jsFiles.length > 0, "src/application should have at least one .js file");

  for (const file of jsFiles) {
    const content = await readFile(join(appDir, file), "utf8");
    // Check for any import path that references commands/
    const importLines = content.split("\n").filter((l) => l.trim().startsWith("import"));
    for (const line of importLines) {
      assert.ok(
        !line.includes("../commands/") && !line.includes("/commands/"),
        `src/application/${file} must not import from commands/: ${line.trim()}`,
      );
    }
  }
});

// =====================================================================
// M12-25: partial registry inventory projection (Outcome 1).
//
// A readable registry with one malformed/unsupported entry must NOT erase the
// healthy entries. getRegistryInventoryWithIssues returns the VALID projected
// agents PLUS a bounded, safe per-entry issue list (closed code set; agentId
// projected only when canonical). A whole-file unreadable/invalid JSON registry
// is a DISTINCT failure (throws) — never faked as a partial result. The strict
// getRegistryInventory path stays strict (CLI registry list/validate unchanged);
// the partial path is a SEPARATE application projection used by MCP.
// =====================================================================

test("M12-25-INV-1: readable registry with valid + malformed entry → healthy agent + one bounded issue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1225-inv1-"));
  try {
    const registryPath = makeRegistry(dir, {
      good: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
      // Missing backend → normalizeAgent throws → invalid_configuration.
      broken: { cwd: dir },
    });
    const result = await getRegistryInventoryWithIssues({ registryPath, runDir: join(dir, "runs") });
    assert.deepEqual(result.issues.map((i) => i.code), ["invalid_configuration"]);
    assert.equal(result.issues[0].agentId, "broken", "canonical id projected");
    assert.deepEqual(Object.keys(result.issues[0]).sort(), ["agentId", "code"], "issue shape is exactly {code, agentId}");
    assert.equal(result.agents.length, 1, "healthy entry preserved");
    assert.equal(result.agents[0].id, "good");
    assert.equal(result.issuesTruncated, false);
  } finally {
    cleanupDir(dir);
  }
});

test("M12-25-INV-2: non-canonical id → invalid_id code, agentId null (raw id never echoed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1225-inv2-"));
  // Contains '/' and '|' — outside the canonical alphabet; a malicious id could
  // itself be sensitive or carry an injection payload, so it must NEVER be echoed.
  const LEAK_ID = "leak-attempt/with|injection";
  try {
    const registryPath = makeRegistry(dir, {
      good: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
      [LEAK_ID]: { backend: "claude-code", cwd: dir },
    });
    const result = await getRegistryInventoryWithIssues({ registryPath, runDir: join(dir, "runs") });
    const idIssue = result.issues.find((i) => i.code === "invalid_id");
    assert.ok(idIssue, "invalid_id issue present for a non-canonical id");
    assert.equal(idIssue.agentId, null, "non-canonical id is NOT projected");
    // The raw id (which could be an injection/sensitive payload) must never be echoed.
    const dumped = JSON.stringify(result);
    assert.ok(!dumped.includes(LEAK_ID), "raw malformed id never echoed in output");
    assert.equal(result.agents.length, 1, "healthy entry preserved alongside the bad id");
    assert.equal(result.agents[0].id, "good");
  } finally {
    cleanupDir(dir);
  }
});

test("M12-25-INV-3: whole-file unreadable registry → throws (distinct from per-entry issues)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1225-inv3-"));
  try {
    const missing = join(dir, "does-not-exist.json");
    await assert.rejects(
      () => getRegistryInventoryWithIssues({ registryPath: missing, runDir: join(dir, "runs") }),
      "an unreadable registry source must throw, not be faked as a partial result",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("M12-25-INV-4: whole-file invalid JSON → throws (not faked as partial)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1225-inv4-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, "{ this is not valid json ]", "utf8");
    await assert.rejects(
      () => getRegistryInventoryWithIssues({ registryPath, runDir: join(dir, "runs") }),
      "an invalid-JSON registry source must throw, not be faked as a partial result",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("M12-25-INV-5: many malformed entries → issues capped at REGISTRY_ISSUES_CAP, truncated flag set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1225-inv5-"));
  try {
    const agents = {};
    // CAP + 5 malformed (all canonical ids but missing backend → invalid_configuration).
    for (let i = 0; i < REGISTRY_ISSUES_CAP + 5; i += 1) {
      agents[`broken_${i}`] = { cwd: dir };
    }
    const registryPath = makeRegistry(dir, agents);
    const result = await getRegistryInventoryWithIssues({ registryPath, runDir: join(dir, "runs") });
    assert.equal(result.issues.length, REGISTRY_ISSUES_CAP, "issues capped at the SSOT cap");
    assert.equal(result.issuesTruncated, true, "truncation flag set");
    assert.equal(result.agents.length, 0, "no healthy entries");
  } finally {
    cleanupDir(dir);
  }
});

test("M12-25-INV-6: true empty valid registry → agents [], issues [] (distinct from observed-clean-with-issues)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1225-inv6-"));
  try {
    const registryPath = makeRegistry(dir, {});
    const result = await getRegistryInventoryWithIssues({ registryPath, runDir: join(dir, "runs") });
    assert.deepEqual(result.agents, [], "no agents");
    assert.deepEqual(result.issues, [], "no issues");
    assert.equal(result.issuesTruncated, false);
  } finally {
    cleanupDir(dir);
  }
});

test("M12-25-INV-7: strict getRegistryInventory STILL throws on a malformed entry (strict path preserved)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1225-inv7-"));
  try {
    const registryPath = makeRegistry(dir, {
      good: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
      broken: { cwd: dir }, // missing backend
    });
    // The strict path (CLI registry list/validate) must remain strict — one bad
    // entry still aborts the whole list. The partial path is SEPARATE.
    await assert.rejects(() => getRegistryInventory({ registryPath, runDir: join(dir, "runs") }));
  } finally {
    cleanupDir(dir);
  }
});

test("M12-25-INV-8: healthy agents identical to strict getRegistryInventory output (parity)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1225-inv8-"));
  try {
    const registryPath = makeRegistry(dir, {
      coder_hq: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
      researcher: { backend: "codex", cwd: dir },
    });
    const runDir = makeSummary(dir, { coder_hq: { status: "certified" } });
    const strict = await getRegistryInventory({ registryPath, runDir });
    const partial = await getRegistryInventoryWithIssues({ registryPath, runDir });
    assert.deepEqual(partial.agents, strict, "partial agents deep-equal the strict output");
    assert.deepEqual(partial.issues, []);
    assert.equal(partial.issuesTruncated, false);
  } finally {
    cleanupDir(dir);
  }
});

test("M12-25-INV-9: issue carries no raw error text / config / path / credential value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1225-inv9-"));
  try {
    const registryPath = makeRegistry(dir, {
      good: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
      // Canonical id, malformed config carrying a sensitive-looking credential
      // sentinel + provider payload. It fails normalizeAgent; the issue must carry
      // ONLY {code, agentId} — never the config, the sentinel, or the source path.
      leaker: {
        backend: "claude-code",
        cwd: dir,
        provider: {
          protocol: "bad-protocol-SUPER_SECRET_VALUE",
          baseUrl: "https://leak.example.com/path",
          apiKeyEnv: "SUPER_SECRET_VALUE",
        },
      },
    });
    const result = await getRegistryInventoryWithIssues({ registryPath, runDir: join(dir, "runs") });
    const dumped = JSON.stringify(result);
    assert.ok(!dumped.includes("SUPER_SECRET_VALUE"), "no credential/config value leak");
    assert.ok(!dumped.includes("bad-protocol"), "no provider protocol leak");
    assert.ok(!dumped.includes("leak.example.com"), "no baseUrl leak");
    assert.ok(!dumped.includes(registryPath), "no registry source path leak");
    const issue = result.issues.find((i) => i.agentId === "leaker");
    assert.ok(issue, "leaker produced an issue");
    assert.deepEqual(Object.keys(issue).sort(), ["agentId", "code"], "issue shape is exactly {code, agentId}");
    assert.equal(result.agents.length, 1, "healthy entry preserved");
    assert.equal(result.agents[0].id, "good");
  } finally {
    cleanupDir(dir);
  }
});

test("M12-25-INV-10: REGISTRY_ISSUE_CODES is the frozen closed set", () => {
  assert.ok(Object.isFrozen(REGISTRY_ISSUE_CODES), "closed set is frozen");
  assert.deepEqual([...REGISTRY_ISSUE_CODES], ["invalid_id", "invalid_configuration"]);
});

// M12-25-INV-11: the shared SSOT projector (used by the partial projector, the
// lead_preflight aggregator, and the MCP registry_list handler) is deterministic
// and fail-closed at every boundary: cap, truncate, closed code set, canonical
// agentId-or-null, and NO injected field survives.
test("M12-25-INV-11: projectRegistryIssues bounds/truncates/sanitizes (cap + closed set + canonical id, no leaks)", () => {
  // Under cap, clean source flag → passes through, injected fields stripped.
  const under = projectRegistryIssues(
    [
      { code: "invalid_configuration", agentId: "coder_low", rawError: "leak" },
      { code: "invalid_id", agentId: "NOT CANONICAL!!", path: "/x" },
      { code: "EVIL", agentId: "also-bad" },
    ],
    false,
  );
  assert.equal(under.issuesTruncated, false, "under cap + clean flag → not truncated");
  assert.equal(under.issues.length, 3);
  assert.deepEqual(under.issues[0], { code: "invalid_configuration", agentId: "coder_low" });
  assert.equal(under.issues[1].agentId, null, "non-canonical id → null");
  assert.equal(under.issues[1].code, "invalid_id");
  assert.equal(under.issues[2].code, "invalid_configuration", "out-of-set code collapses to invalid_configuration");
  assert.equal(under.issues[2].agentId, "also-bad", "canonical id (hyphen allowed per ^[A-Za-z0-9._-]+$) passes through");

  // Over cap WITH source issuesTruncated:false → cap + truncation reported.
  const overCount = REGISTRY_ISSUES_CAP + 4;
  const over = projectRegistryIssues(
    Array.from({ length: overCount }, (_, i) => ({
      code: "invalid_configuration", agentId: "coder_low", injected: i,
    })),
    false,
  );
  assert.equal(over.issues.length, REGISTRY_ISSUES_CAP, "capped at REGISTRY_ISSUES_CAP");
  assert.equal(over.issuesTruncated, true, "over-cap array reports truncation despite source false");
  for (const issue of over.issues) {
    assert.ok(REGISTRY_ISSUE_CODES.includes(issue.code), "closed-set code only");
    assert.deepEqual(Object.keys(issue).sort(), ["agentId", "code"], "no injected field survives");
  }

  // Source reports truncation → respected even if the array is itself under cap.
  const sourceTrunc = projectRegistryIssues(
    [{ code: "invalid_id", agentId: null }],
    true,
  );
  assert.equal(sourceTrunc.issues.length, 1);
  assert.equal(sourceTrunc.issuesTruncated, true, "source truncation flag respected");

  // Non-array / null input → empty + not truncated (never throws).
  assert.deepEqual(projectRegistryIssues(null, false), { issues: [], issuesTruncated: false });
  assert.deepEqual(projectRegistryIssues(undefined, false), { issues: [], issuesTruncated: false });
});

// M12-25B: the shared inventory-result normalizer. It accepts exactly the two
// VALID shapes (legacy bare array; partial {agents, issues, issuesTruncated})
// and THROWS on null/malformed so every public adapter fails CLOSED to unknown.
// A genuinely empty-but-readable registry (empty array / {agents:[]}) stays
// observed-empty — only a null/malformed result throws.
test("M12-25B-NORM: normalizeInventoryResult accepts the two valid shapes and throws on null/malformed", () => {
  // Legacy bare array → carried as agents, no issues facet.
  assert.deepEqual(normalizeInventoryResult([{ id: "a" }]), { agents: [{ id: "a" }], issues: [], issuesTruncated: false });
  // Partial projection → agents + raw issues facet carried through (caller projects).
  assert.deepEqual(
    normalizeInventoryResult({ agents: [{ id: "a" }], issues: [{ code: "invalid_id", agentId: null }], issuesTruncated: true }),
    { agents: [{ id: "a" }], issues: [{ code: "invalid_id", agentId: null }], issuesTruncated: true },
  );
  // A genuinely empty-but-readable registry is VALID observed-empty (NOT unknown).
  assert.deepEqual(normalizeInventoryResult([]), { agents: [], issues: [], issuesTruncated: false });
  assert.deepEqual(normalizeInventoryResult({ agents: [] }), { agents: [], issues: [], issuesTruncated: false });
  // Idempotent: a normalized snapshot re-normalizes to itself.
  const norm = normalizeInventoryResult({ agents: [{ id: "a" }], issues: [], issuesTruncated: false });
  assert.deepEqual(normalizeInventoryResult(norm), norm);
  // Null / malformed → throws (fail closed). Unknown, never observed-empty.
  for (const bad of [null, undefined, { noAgentsKey: true }, { agents: "not-an-array" }, 42, "a-string"]) {
    assert.throws(() => normalizeInventoryResult(bad), `malformed inventory result must throw: ${JSON.stringify(bad)}`);
  }
});

// M12-25C (final narrow truth-boundary correction): a PRESENT-but-wrong-typed
// facet is malformed and must THROW. An injected resolver must not smuggle e.g.
// issues:"bad" or issuesTruncated:"false" through as an apparently clean
// observed inventory (the old code silently coerced a present non-array issues
// to [] and Boolean()-coerced a present non-boolean issuesTruncated). Only an
// ABSENT (undefined) optional facet defaults. null counts as present-but-wrong.
test("M12-25C-NORM: present-but-wrong-typed facets throw; missing facets default", () => {
  // Missing optional facets remain valid defaults (no issues/issuesTruncated keys).
  assert.deepEqual(
    normalizeInventoryResult({ agents: [{ id: "a" }] }),
    { agents: [{ id: "a" }], issues: [], issuesTruncated: false },
  );
  // A present EMPTY issues array is VALID (observed-clean), distinct from a
  // present NON-array issues facet which is malformed.
  assert.deepEqual(
    normalizeInventoryResult({ agents: [], issues: [] }),
    { agents: [], issues: [], issuesTruncated: false },
  );
  // Present-but-wrong-typed issues facet → malformed (string / null / number / object).
  for (const badIssues of ["bad", null, 42, {}]) {
    assert.throws(
      () => normalizeInventoryResult({ agents: [], issues: badIssues }),
      `present non-array issues must throw: ${JSON.stringify(badIssues)}`,
    );
  }
  // Present-but-wrong-typed issuesTruncated facet → malformed. String "false"
  // must NOT Boolean-coerce to a clean value; number 1 must NOT pass as truthy.
  for (const badTrunc of ["false", "true", 1, 0, null]) {
    assert.throws(
      () => normalizeInventoryResult({ agents: [], issuesTruncated: badTrunc }),
      `present non-boolean issuesTruncated must throw: ${JSON.stringify(badTrunc)}`,
    );
  }
});

// M12-25C: projectRegistryIssues must project EVERY supplied array element into
// the safe closed shape — malformed elements (null / primitive) become
// {code:"invalid_configuration", agentId:null} and must NOT disappear into a
// clean result (the old code filtered them away). Cap + truncation now count
// every projected element; stripping + closed-set + no-leak behavior preserved.
test("M12-25C-PROJ: every array element projected; malformed → invalid_configuration (none disappear)", () => {
  // Mix of malformed + valid: every element survives, malformed collapse safely.
  const mixed = projectRegistryIssues(
    [null, "x", 42, false, { code: "invalid_id", agentId: "coder_low" }],
    false,
  );
  assert.equal(mixed.issues.length, 5, "no element filtered away");
  assert.deepEqual(mixed.issues[0], { code: "invalid_configuration", agentId: null });
  assert.deepEqual(mixed.issues[1], { code: "invalid_configuration", agentId: null });
  assert.deepEqual(mixed.issues[2], { code: "invalid_configuration", agentId: null });
  assert.deepEqual(mixed.issues[3], { code: "invalid_configuration", agentId: null });
  assert.deepEqual(mixed.issues[4], { code: "invalid_id", agentId: "coder_low" }, "valid object element projected");
  for (const issue of mixed.issues) {
    assert.deepEqual(Object.keys(issue).sort(), ["agentId", "code"], "closed shape, no leak");
  }
  assert.equal(mixed.issuesTruncated, false, "under cap → not truncated");

  // All-malformed over cap: every element counted toward cap + truncation.
  const overMalformed = projectRegistryIssues(
    Array.from({ length: REGISTRY_ISSUES_CAP + 5 }, () => null),
    false,
  );
  assert.equal(overMalformed.issues.length, REGISTRY_ISSUES_CAP, "capped at REGISTRY_ISSUES_CAP");
  assert.equal(overMalformed.issuesTruncated, true, "malformed elements counted toward truncation");
  for (const issue of overMalformed.issues) {
    assert.deepEqual(issue, { code: "invalid_configuration", agentId: null });
  }
});

// =====================================================================
// R23-C F6（2026-08-21，双席会审补钉）：buildCertMap 的 providerKey 透传钉。
//
// matchedCertRecord 已把 providerKey 纳入身份四元组，但投影层要参与该维比对
// 就必须拿得到记录侧的值——TD-131 的 providerID 曾在 buildCertMap 被同一形状
// 的坑丢掉（透传行缺失 → certMap 记录侧 undefined → matchedCertRecord 按
// legacy 跳过该维 → 换接入方的旧认证照常投影继承，静默 fail-open）。本测试
// 以 mutation 思路钉死：删掉 buildCertMap 的 `providerKey: w.providerKey`
// 透传行，下面两个"不继承"断言必红（undefined 跳维 → 认证被继承）。
// =====================================================================

test("R23-C-F6: buildCertMap 透传 providerKey——换接入方/null 对有 provider 的 lane 不再继承认证", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r23c-f6-"));
  try {
    const PROVIDER = {
      protocol: "anthropic-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKeyEnv: "F6_GATE_KEY",
    };
    const registryPath = makeRegistry(dir, {
      f6_w: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" }, provider: PROVIDER },
    });
    // backend/modelId 全匹配，唯独 providerKey 是另一接入方的指纹。
    const runDir = makeSummary(dir, {
      f6_w: {
        status: "certified",
        backend: "claude-code",
        modelId: "glm-5.2",
        providerKey: providerKeyFor({ baseUrl: "https://old-lane.example.com/v1", apiKeyEnv: "F6_OLD_KEY" }),
      },
    });
    const [swapped] = await getRegistryInventory({ registryPath, runDir });
    assert.equal(swapped.certification, null,
      "记录是另一接入方（providerKey 不匹配）→ 认证不可继承（透传缺失时该断言必红）");

    // 记录显式 null（认证时已观察无接入方）↔ agent 现配有 provider 块 → 不继承。
    const nullRunDir = makeSummary(join(dir, "runs-null"), {
      f6_w: { status: "certified", backend: "claude-code", modelId: "glm-5.2", providerKey: null },
    });
    const [observedNone] = await getRegistryInventory({ registryPath, runDir: nullRunDir });
    assert.equal(observedNone.certification, null,
      "null（已观察无接入方）≠ 可派生指纹 → 不继承（透传缺失时 null 被吞成 undefined 跳维，必红）");

    // 正面对照：同接入方不同写法（归一化等价）→ 照常继承（值真实流过比对，不是两侧都缺省）。
    const sameRunDir = makeSummary(join(dir, "runs-same"), {
      f6_w: {
        status: "certified",
        backend: "claude-code",
        modelId: "glm-5.2",
        providerKey: providerKeyFor({ baseUrl: "HTTPS://API.Example.COM:443/v1/", apiKeyEnv: "F6_GATE_KEY" }),
      },
    });
    const [same] = await getRegistryInventory({ registryPath, runDir: sameRunDir });
    assert.equal(same.certification, "certified", "同接入方（归一化等价写法）→ 认证照常继承");
  } finally {
    cleanupDir(dir);
  }
});
