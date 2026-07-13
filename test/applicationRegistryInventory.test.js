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

import { getRegistryInventory } from "../src/application/registryInventory.js";

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
      coder_hq: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5.2"] },
      researcher: { backend: "claude-code", cwd: dir, args: ["--model", "deepseek-v4-flash"] },
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
      coder_hq: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5.2"] },
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
      coder_hq: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5.2"] },
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
      coder_hq: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5.2"] },
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
      coder_hq: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5.2"] },
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
      coder_hq: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5.2"] },
      auditor: { backend: "claude-code", cwd: dir, args: ["--model", "opus"] },
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

test("M9-0-07: fake dependency injection — no real filesystem touched", async () => {
  let readRegistryCalled = false;
  let readFileCalled = false;

  // Fake readRegistry returns an in-memory registry — no file read
  const fakeReadRegistry = async () => {
    readRegistryCalled = true;
    return {
      listAgents() {
        return [
          { id: "coder_hq", backend: "claude-code", cwd: "/fake", args: ["--model", "glm-5.2"] },
          { id: "researcher", backend: "claude-code", cwd: "/fake", args: ["--model", "opus"] },
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
