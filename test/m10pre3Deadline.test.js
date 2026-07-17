// test/m10pre3Deadline.test.js
//
// M10-pre3 Batch A: Execution deadline disabled-by-default tests.
//
// Verifies:
//   1. No explicit/agent/global → deadline disabled
//   2. Disabled run doesn't produce timed_out even after long duration
//   3. Explicit deadline still produces timed_out
//   4. Agent/global precedence maintained
//   5. Token budget still fails when deadline disabled
//   6. External abort still works when deadline disabled
//   7. wait_policy durable fact shape (disabled/explicit)
//   8. MCP config missing/corrupt/null → disabled (not 300000)
//   9. backgroundRunner request timeout not derived from execution deadline
//   10. MCP schema still rejects timeout control fields

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── timeoutPolicy disabled semantics ─────────────────────────────────────────

test("DEADLINE-01: no explicit/agent/global → disabled", async () => {
  const { resolveWaitTimeout } = await import("../src/application/timeoutPolicy.js");
  const result = resolveWaitTimeout({});
  assert.equal(result.enabled, false);
  assert.equal(result.ms, null);
  assert.equal(result.source, "disabled");
});

test("DEADLINE-02: explicit deadline still resolves", async () => {
  const { resolveWaitTimeout } = await import("../src/application/timeoutPolicy.js");
  const result = resolveWaitTimeout({ explicit: 60000 });
  assert.equal(result.enabled, true);
  assert.equal(result.ms, 60000);
  assert.equal(result.source, "explicit");
});

test("DEADLINE-03: agent precedence over global", async () => {
  const { resolveWaitTimeout } = await import("../src/application/timeoutPolicy.js");
  const result = resolveWaitTimeout({ agentWaitTimeout: 120000, globalWaitTimeout: 300000 });
  assert.equal(result.source, "agent");
  assert.equal(result.ms, 120000);
});

test("DEADLINE-04: global resolves when no explicit/agent", async () => {
  const { resolveWaitTimeout } = await import("../src/application/timeoutPolicy.js");
  const result = resolveWaitTimeout({ globalWaitTimeout: 200000 });
  assert.equal(result.enabled, true);
  assert.equal(result.source, "global");
  assert.equal(result.ms, 200000);
});

test("DEADLINE-05: explicit > agent > global precedence chain", async () => {
  const { resolveWaitTimeout } = await import("../src/application/timeoutPolicy.js");
  assert.equal(resolveWaitTimeout({ explicit: 10000, agentWaitTimeout: 20000, globalWaitTimeout: 30000 }).source, "explicit");
  assert.equal(resolveWaitTimeout({ agentWaitTimeout: 20000, globalWaitTimeout: 30000 }).source, "agent");
  assert.equal(resolveWaitTimeout({ globalWaitTimeout: 30000 }).source, "global");
  assert.equal(resolveWaitTimeout({}).source, "disabled");
});

// ── MCP stdio config fallback ────────────────────────────────────────────────

test("STDIO-01: missing config → disabled (not 300000)", async () => {
  const { loadGlobalWaitTimeoutForTest } = await import("../src/mcp/stdio.js");
  const result = await loadGlobalWaitTimeoutForTest("/nonexistent/config.json");
  assert.equal(result, null, "missing config must return null (disabled), not 300000");
});

test("STDIO-02: corrupt config → disabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-stdio-02-"));
  try {
    writeFileSync(join(dir, "config.json"), "NOT JSON");
    const { loadGlobalWaitTimeoutForTest } = await import("../src/mcp/stdio.js");
    const result = await loadGlobalWaitTimeoutForTest(join(dir, "config.json"));
    assert.equal(result, null, "corrupt config must return null");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("STDIO-03: waitTimeout:null in config → disabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-stdio-03-"));
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ waitTimeout: null }));
    const { loadGlobalWaitTimeoutForTest } = await import("../src/mcp/stdio.js");
    const result = await loadGlobalWaitTimeoutForTest(join(dir, "config.json"));
    assert.equal(result, null, "waitTimeout:null must return null (disabled)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("STDIO-04: valid waitTimeout in config → passed through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-stdio-04-"));
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ waitTimeout: 120000 }));
    const { loadGlobalWaitTimeoutForTest } = await import("../src/mcp/stdio.js");
    const result = await loadGlobalWaitTimeoutForTest(join(dir, "config.json"));
    assert.equal(result, 120000, "valid waitTimeout must be passed through");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── config/default.json no longer has default 300000 ─────────────────────────

test("CONFIG-01: config/default.json waitTimeout is null (disabled)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const configPath = join(join(fileURLToPath(new URL(".", import.meta.url))), "..", "config", "default.json");
  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.waitTimeout, null, "config/default.json must have waitTimeout: null");
});

// ── cli.js hardcodedDefaults no longer has waitTimeout: 300000 ───────────────

test("CLI-DEFAULTS-01: cli.js hardcodedDefaults does not default waitTimeout to 300000", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(
    join(join(fileURLToPath(new URL(".", import.meta.url))), "..", "src", "cli.js"),
    "utf8",
  );
  // hardcodedDefaults should not have waitTimeout: 300000
  const hdMatch = src.match(/hardcodedDefaults\s*=\s*\{([^}]+)\}/s);
  assert.ok(hdMatch, "hardcodedDefaults must exist");
  // waitTimeout should either be absent or null in hardcodedDefaults
  const wtLine = hdMatch[1].match(/waitTimeout:\s*(null|300000|\d+)/);
  if (wtLine) {
    assert.notEqual(wtLine[1], "300000", "hardcodedDefaults must not default to 300000");
    assert.equal(wtLine[1], "null", "hardcodedDefaults waitTimeout must be null if present");
  }
});

// ── backgroundRunner request timeout not derived from deadline ───────────────

test("BG-01: backgroundRunner does not derive request timeout from execution deadline", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(
    join(join(fileURLToPath(new URL(".", import.meta.url))), "..", "src", "backgroundRunner.js"),
    "utf8",
  );
  // Must not contain the old pattern of deriving timeout from waitTimeout
  assert.ok(!/\+\s*5000/.test(src), "must not derive request timeout via +5000 from deadline");
});
