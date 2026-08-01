// test/runsDeliveryReverifyCli.test.js
//
// M12-6 FR-07 closeout: CLI `runs delivery reverify <runId>` — the CLI fallback
// for the audited unchanged-artifact re-verification.
//
// The CLI is a THIN adapter: it delegates to the existing runDeliveryReverify
// application service (same one the MCP tool uses). It never re-implements the
// algorithm, never parses the transcript, never copies boundary constants, and
// can never override the original assertion commands. The CLI owns only:
//   - strict argv parsing (reverify recognized before ordinary delivery parsing)
//   - --setup-commands-file UTF-8 JSON string-array validation (service bounds)
//   - --timeout-ms strict-integer validation (service min/max)
//   - authorizedWorkspaceRoot from the existing cwd/workspace proof path
//   - safe JSON/text output of service-approved fields ONLY
//
// Any reverify never auto-accepts/rejects; original verification + commands are
// permanently preserved; the CLI offers no assertion-command override flag.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runsDeliveryCommand } from "../src/commands/runs.js";
import {
  REVERIFY_REASONS,
  REVERIFY_SETUP_COMMANDS_LIMIT,
  REVERIFY_SETUP_COMMAND_MAX_LENGTH,
  REVERIFY_TIMEOUT_MS_MIN,
  REVERIFY_TIMEOUT_MS_MAX,
} from "../src/application/runDeliveryReverify.js";

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map(String).join("\t")); };
  try { await fn(); }
  finally { console.log = orig; }
  return lines.join("\n");
}

function validServiceResult(overrides = {}) {
  return {
    runId: "run_reverify1",
    deliveryCommit: "a".repeat(40),
    state: "created",
    reason: "tooling_invalid",
    verificationStatus: "passed",
    failureCode: undefined,
    requested: true,
    outcomeRecorded: true,
    ...overrides,
  };
}

/** Counting injectable service — asserts "service called once" semantics. */
function countingService(result) {
  const calls = [];
  const svc = async (input) => { calls.push(input); return result; };
  svc.calls = calls;
  return svc;
}

const SAFE_FIELDS = [
  "runId", "deliveryCommit", "state", "reason",
  "verificationStatus", "failureCode", "requested", "outcomeRecorded",
];

function assertSafeJsonOnly(out) {
  const parsed = JSON.parse(out);
  assert.deepEqual(Object.keys(parsed).sort(), [...SAFE_FIELDS].sort(),
    "JSON output must contain exactly the service-approved safe fields");
  return parsed;
}

// =====================================================================
// Group 1: success — JSON output + service delegation
// =====================================================================

test("FR07-CLI-01: runs delivery reverify <runId> --reason tooling_invalid --format json outputs safe result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr07-cli-01-"));
  try {
    const svc = countingService(validServiceResult());
    const config = { runDir: dir };
    const out = await captureLog(async () => {
      await runsDeliveryCommand(["reverify", "run_reverify1", "--reason", "tooling_invalid", "--format", "json"], config, { runDeliveryReverifyFn: svc });
    });
    const parsed = assertSafeJsonOnly(out);
    assert.equal(parsed.runId, "run_reverify1");
    assert.equal(parsed.deliveryCommit, "a".repeat(40));
    assert.equal(parsed.state, "created");
    assert.equal(parsed.reason, "tooling_invalid");
    assert.equal(parsed.verificationStatus, "passed");
    assert.equal(parsed.failureCode, null, "failureCode normalizes to null when absent");
    assert.equal(parsed.requested, true);
    assert.equal(parsed.outcomeRecorded, true);
    // Delegated exactly once to the shared service, with the derived workspace root.
    assert.equal(svc.calls.length, 1, "service called exactly once");
    const arg = svc.calls[0];
    assert.equal(arg.runId, "run_reverify1");
    assert.equal(arg.reason, "tooling_invalid");
    assert.equal(arg.runDir, dir);
    assert.equal(arg.setupCommands, undefined, "missing setup file → omitted (service default empty array)");
    assert.equal(arg.timeoutMs, undefined, "missing timeout → omitted (service default)");
  } finally {
    cleanupDir(dir);
  }
});

test("FR07-CLI-02: setup-commands-file + timeout-ms are parsed and passed to the service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr07-cli-02-"));
  try {
    const setupFile = join(dir, "setup.json");
    writeFileSync(setupFile, JSON.stringify(["npm ci", "npm run build"]), "utf8");
    const svc = countingService(validServiceResult());
    const config = { runDir: dir };
    const out = await captureLog(async () => {
      await runsDeliveryCommand(
        ["reverify", "run_reverify1", "--reason", "dependency_setup_missing",
          "--setup-commands-file", setupFile, "--timeout-ms", "5000", "--format", "json"],
        config,
        { runDeliveryReverifyFn: svc },
      );
    });
    assertSafeJsonOnly(out);
    assert.equal(svc.calls.length, 1, "service called exactly once");
    assert.deepEqual(svc.calls[0].setupCommands, ["npm ci", "npm run build"]);
    assert.equal(svc.calls[0].timeoutMs, 5000);
    // Commands are NEVER echoed in the output.
    assert.ok(!out.includes("npm ci"), "setup commands must not leak into output");
  } finally {
    cleanupDir(dir);
  }
});

test("FR07-CLI-03: empty setup array passes through as []", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr07-cli-03-"));
  try {
    const setupFile = join(dir, "empty-setup.json");
    writeFileSync(setupFile, "[]", "utf8");
    const svc = countingService(validServiceResult());
    const config = { runDir: dir };
    await captureLog(async () => {
      await runsDeliveryCommand(
        ["reverify", "run_reverify1", "--reason", "environment_contaminated", "--setup-commands-file", setupFile],
        config,
        { runDeliveryReverifyFn: svc },
      );
    });
    assert.equal(svc.calls.length, 1);
    assert.deepEqual(svc.calls[0].setupCommands, [], "explicit empty array passes through");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 2: idempotent / concurrent state passes through the service truth
// =====================================================================

test("FR07-CLI-04: idempotent/resumed states from the service are passed through unmodified", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr07-cli-04-"));
  try {
    for (const [state, requested, outcomeRecorded] of [
      ["idempotent", false, false],
      ["resumed", false, true],
    ]) {
      const svc = countingService(validServiceResult({ state, requested, outcomeRecorded }));
      const config = { runDir: dir };
      const out = await captureLog(async () => {
        await runsDeliveryCommand(
          ["reverify", "run_reverify1", "--reason", "tooling_invalid", "--format", "json"],
          config,
          { runDeliveryReverifyFn: svc },
        );
      });
      const parsed = assertSafeJsonOnly(out);
      assert.equal(parsed.state, state, `state ${state} passed through from service truth`);
      assert.equal(parsed.requested, requested);
      assert.equal(parsed.outcomeRecorded, outcomeRecorded);
    }
  } finally {
    cleanupDir(dir);
  }
});

test("FR07-CLI-05: failed verification passes through failureCode; text output is concise", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr07-cli-05-"));
  try {
    const svc = countingService(validServiceResult({
      verificationStatus: "failed",
      failureCode: "command_timeout",
    }));
    const config = { runDir: dir };
    // JSON mode
    const jsonOut = await captureLog(async () => {
      await runsDeliveryCommand(
        ["reverify", "run_reverify1", "--reason", "tooling_invalid", "--format", "json"],
        config,
        { runDeliveryReverifyFn: svc },
      );
    });
    const parsed = assertSafeJsonOnly(jsonOut);
    assert.equal(parsed.verificationStatus, "failed");
    assert.equal(parsed.failureCode, "command_timeout");
    // Text mode
    const textOut = await captureLog(async () => {
      await runsDeliveryCommand(
        ["reverify", "run_reverify1", "--reason", "tooling_invalid"],
        config,
        { runDeliveryReverifyFn: svc },
      );
    });
    assert.ok(textOut.includes("run_reverify1"), "text output has runId");
    assert.ok(textOut.includes("a".repeat(40)), "text output has deliveryCommit");
    assert.ok(/tooling_invalid/.test(textOut), "text output has reason");
    assert.ok(/failed/.test(textOut) && /command_timeout/.test(textOut),
      "text output has verification status + failure code");
    assert.ok(!textOut.includes("npm ci"), "text output must not echo commands");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 3: reason validation
// =====================================================================

test("FR07-CLI-06: missing reason rejected before service call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr07-cli-06-"));
  try {
    const svc = countingService(validServiceResult());
    const config = { runDir: dir };
    await assert.rejects(
      () => runsDeliveryCommand(["reverify", "run_reverify1", "--format", "json"], config, { runDeliveryReverifyFn: svc }),
      /--reason/,
      "missing --reason rejected",
    );
    assert.equal(svc.calls.length, 0, "service never called on missing reason");
  } finally {
    cleanupDir(dir);
  }
});

test("FR07-CLI-07: unknown reason rejected before service call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr07-cli-07-"));
  try {
    const svc = countingService(validServiceResult());
    const config = { runDir: dir };
    await assert.rejects(
      () => runsDeliveryCommand(["reverify", "run_reverify1", "--reason", "some_random_excuse"], config, { runDeliveryReverifyFn: svc }),
      new RegExp(REVERIFY_REASONS.join("|")),
      "unknown reason rejected with the closed set",
    );
    assert.equal(svc.calls.length, 0, "service never called on unknown reason");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 4: --setup-commands-file validation (service bounds reused)
// =====================================================================

test("FR07-CLI-08: non-JSON / non-array / extra-semantics setup files rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr07-cli-08-"));
  try {
    const cases = [
      ["not-json", "not json at all", /JSON/],
      ["object", '{"cmd":"npm ci"}', /array/i],
      ["null", "null", /array/i],
      ["string", '"npm ci"', /array/i],
      ["number-element", '[42]', /string/i],
      ["null-element", '[null]', /string/i],
      ["object-element", '[{"cmd":"x"}]', /string/i],
      ["nested-array-element", '[["npm ci"]]', /string/i],
    ];
    for (const [name, content, pattern] of cases) {
      const setupFile = join(dir, `${name}.json`);
      writeFileSync(setupFile, content, "utf8");
      const svc = countingService(validServiceResult());
      const config = { runDir: dir };
      await assert.rejects(
        () => runsDeliveryCommand(
          ["reverify", "run_reverify1", "--reason", "tooling_invalid", "--setup-commands-file", setupFile],
          config,
          { runDeliveryReverifyFn: svc },
        ),
        pattern,
        `${name} setup file rejected`,
      );
      assert.equal(svc.calls.length, 0, `service never called for ${name}`);
    }
  } finally {
    cleanupDir(dir);
  }
});

test("FR07-CLI-09: blank / oversize setup commands rejected (service constants reused)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr07-cli-09-"));
  try {
    // Blank element (whitespace-only).
    const blankFile = join(dir, "blank.json");
    writeFileSync(blankFile, JSON.stringify(["  ", "npm ci"]), "utf8");
    let svc = countingService(validServiceResult());
    await assert.rejects(
      () => runsDeliveryCommand(
        ["reverify", "run_reverify1", "--reason", "tooling_invalid", "--setup-commands-file", blankFile],
        { runDir: dir },
        { runDeliveryReverifyFn: svc },
      ),
      /blank|empty|non-empty/i,
      "blank setup command rejected",
    );
    assert.equal(svc.calls.length, 0);

    // Oversize count (> REVERIFY_SETUP_COMMANDS_LIMIT).
    const tooMany = Array.from({ length: REVERIFY_SETUP_COMMANDS_LIMIT + 1 }, (_, i) => `cmd${i}`);
    const manyFile = join(dir, "many.json");
    writeFileSync(manyFile, JSON.stringify(tooMany), "utf8");
    svc = countingService(validServiceResult());
    await assert.rejects(
      () => runsDeliveryCommand(
        ["reverify", "run_reverify1", "--reason", "tooling_invalid", "--setup-commands-file", manyFile],
        { runDir: dir },
        { runDeliveryReverifyFn: svc },
      ),
      new RegExp(`${REVERIFY_SETUP_COMMANDS_LIMIT}`),
      "oversize setup list rejected with the shared cap",
    );
    assert.equal(svc.calls.length, 0);

    // Oversize single command (> REVERIFY_SETUP_COMMAND_MAX_LENGTH).
    const longCmd = "x".repeat(REVERIFY_SETUP_COMMAND_MAX_LENGTH + 1);
    const longFile = join(dir, "long.json");
    writeFileSync(longFile, JSON.stringify([longCmd]), "utf8");
    svc = countingService(validServiceResult());
    await assert.rejects(
      () => runsDeliveryCommand(
        ["reverify", "run_reverify1", "--reason", "tooling_invalid", "--setup-commands-file", longFile],
        { runDir: dir },
        { runDeliveryReverifyFn: svc },
      ),
      new RegExp(`${REVERIFY_SETUP_COMMAND_MAX_LENGTH}`),
      "oversize setup command rejected with the shared cap",
    );
    assert.equal(svc.calls.length, 0);
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 5: --timeout-ms validation (service min/max reused)
// =====================================================================

test("FR07-CLI-10: bad timeout rejected before service call; omitted → service default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr07-cli-10-"));
  try {
    const badValues = [
      ["abc", /integer/i],
      ["1.5", /integer/i],
      [`${REVERIFY_TIMEOUT_MS_MIN - 1}`, /integer/i],
      [`${REVERIFY_TIMEOUT_MS_MAX + 1}`, /integer/i],
      ["-5", /integer/i],
    ];
    for (const [value, pattern] of badValues) {
      const svc = countingService(validServiceResult());
      await assert.rejects(
        () => runsDeliveryCommand(
          ["reverify", "run_reverify1", "--reason", "tooling_invalid", "--timeout-ms", value],
          { runDir: dir },
          { runDeliveryReverifyFn: svc },
        ),
        pattern,
        `timeout ${JSON.stringify(value)} rejected`,
      );
      assert.equal(svc.calls.length, 0, `service never called for timeout ${JSON.stringify(value)}`);
    }
    // Boundary values are accepted.
    const svc = countingService(validServiceResult());
    await captureLog(async () => {
      await runsDeliveryCommand(
        ["reverify", "run_reverify1", "--reason", "tooling_invalid",
          "--timeout-ms", `${REVERIFY_TIMEOUT_MS_MIN}`],
        { runDir: dir },
        { runDeliveryReverifyFn: svc },
      );
    });
    assert.equal(svc.calls[0].timeoutMs, REVERIFY_TIMEOUT_MS_MIN, "min boundary accepted");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 6: workspace ownership — root comes from the CLI cwd proof path
// =====================================================================

test("FR07-CLI-11: authorizedWorkspaceRoot derived from --cwd; no flag can override it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr07-cli-11-"));
  const customCwd = mkdtempSync(join(tmpdir(), "fr07-cli-11-cwd-"));
  try {
    const svc = countingService(validServiceResult());
    const config = { runDir: dir };
    await captureLog(async () => {
      await runsDeliveryCommand(
        ["reverify", "run_reverify1", "--reason", "tooling_invalid", "--cwd", customCwd],
        config,
        { runDeliveryReverifyFn: svc },
      );
    });
    assert.equal(svc.calls.length, 1);
    assert.equal(svc.calls[0].authorizedWorkspaceRoot, customCwd,
      "authorizedWorkspaceRoot = resolved --cwd (existing cwd proof path)");

    // No workspace-root / authorized-workspace-root input flag exists — rejected.
    const svc2 = countingService(validServiceResult());
    await assert.rejects(
      () => runsDeliveryCommand(
        ["reverify", "run_reverify1", "--reason", "tooling_invalid", "--authorized-workspace-root", "/some/other/project"],
        config,
        { runDeliveryReverifyFn: svc2 },
      ),
      /unknown flag/i,
      "workspace root cannot be set by caller input",
    );
    assert.equal(svc2.calls.length, 0);
  } finally {
    cleanupDir(dir);
    cleanupDir(customCwd);
  }
});

test("FR07-CLI-12: workspace mismatch from the service surfaces as rejection, no partial output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr07-cli-12-"));
  try {
    const svc = async () => {
      throw new Error("runDeliveryReverify: run does not belong to the authorized workspace");
    };
    const config = { runDir: dir };
    const lines = [];
    const orig = console.log;
    console.log = (...a) => { lines.push(a.map(String).join("\t")); };
    try {
      await assert.rejects(
        () => runsDeliveryCommand(["reverify", "run_reverify1", "--reason", "tooling_invalid"], config, { runDeliveryReverifyFn: svc }),
        /workspace/i,
        "workspace mismatch rejected (service is the authority)",
      );
    } finally {
      console.log = orig;
    }
    assert.equal(lines.length, 0, "no partial output on rejection");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 7: sensitive fields never leak
// =====================================================================

test("FR07-CLI-13: extra/junk service fields never reach the output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr07-cli-13-"));
  try {
    const junk = {
      ...validServiceResult(),
      // A hostile/buggy service result carrying sensitive fields — the CLI
      // projection must drop all of them.
      setupCommands: ["npm ci", "rm -rf /secrets"],
      stderr: "super secret stderr",
      env: { PATH: "/usr/bin", SECRET: "hunter2" },
      absolutePath: "C:\\Users\\lead\\projects\\target",
      rawEvents: [{ type: "run.delivery_created", prompt: "secret prompt" }],
      assertionCommands: ["git push origin main"],
    };
    const config = { runDir: dir };
    const out = await captureLog(async () => {
      await runsDeliveryCommand(
        ["reverify", "run_reverify1", "--reason", "tooling_invalid", "--format", "json"],
        config,
        { runDeliveryReverifyFn: async () => junk },
      );
    });
    const parsed = assertSafeJsonOnly(out);
    assert.equal(parsed.setupCommands, undefined);
    assert.equal(parsed.stderr, undefined);
    assert.equal(parsed.env, undefined);
    assert.equal(parsed.absolutePath, undefined);
    assert.equal(parsed.rawEvents, undefined);
    assert.equal(parsed.assertionCommands, undefined);
    assert.ok(!out.includes("rm -rf"), "no command text leaks");
    assert.ok(!out.includes("hunter2"), "no secret leaks");
    assert.ok(!out.includes("C:\\Users"), "no absolute path leaks");
  } finally {
    cleanupDir(dir);
  }
});

test("FR07-CLI-14: malformed service result (bad state) fails closed with no output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr07-cli-14-"));
  try {
    const config = { runDir: dir };
    const lines = [];
    const orig = console.log;
    console.log = (...a) => { lines.push(a.map(String).join("\t")); };
    try {
      await assert.rejects(
        () => runsDeliveryCommand(
          ["reverify", "run_reverify1", "--reason", "tooling_invalid", "--format", "json"],
          config,
          { runDeliveryReverifyFn: async () => validServiceResult({ state: "bogus_state" }) },
        ),
        /state/i,
        "unknown state fails closed",
      );
    } finally {
      console.log = orig;
    }
    assert.equal(lines.length, 0, "no output on malformed service result");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 8: original commands can never be overridden
// =====================================================================

test("FR07-CLI-15: no assertion-command override flag exists — unknown flags rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr07-cli-15-"));
  try {
    for (const flag of ["--assertion-commands-file", "--verification-commands-file", "--commands-file", "--force", "--reason-file"]) {
      const svc = countingService(validServiceResult());
      await assert.rejects(
        () => runsDeliveryCommand(
          ["reverify", "run_reverify1", "--reason", "tooling_invalid", flag, "/some/file.json"],
          { runDir: dir },
          { runDeliveryReverifyFn: svc },
        ),
        /unknown flag/i,
        `${flag} rejected — original assertions cannot be overridden`,
      );
      assert.equal(svc.calls.length, 0, `service never called for ${flag}`);
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 9: parsing strictness — dispatch, duplicates, positionals
// =====================================================================

test("FR07-CLI-16: reverify recognized before ordinary runs delivery parsing; runId required", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr07-cli-16-"));
  try {
    // Missing runId.
    const svc = countingService(validServiceResult());
    await assert.rejects(
      () => runsDeliveryCommand(["reverify", "--reason", "tooling_invalid"], { runDir: dir }, { runDeliveryReverifyFn: svc }),
      /runId/,
      "missing runId rejected",
    );
    assert.equal(svc.calls.length, 0);
    // Whitespace runId.
    await assert.rejects(
      () => runsDeliveryCommand(["reverify", "   ", "--reason", "tooling_invalid"], { runDir: dir }, { runDeliveryReverifyFn: svc }),
      /runId/i,
      "whitespace runId rejected",
    );
    assert.equal(svc.calls.length, 0);
    // Extra positional.
    await assert.rejects(
      () => runsDeliveryCommand(
        ["reverify", "run_x", "run_y", "--reason", "tooling_invalid"],
        { runDir: dir },
        { runDeliveryReverifyFn: svc },
      ),
      /exactly one|runId/i,
      "extra positional rejected",
    );
    assert.equal(svc.calls.length, 0);
    // Duplicate flags.
    await assert.rejects(
      () => runsDeliveryCommand(
        ["reverify", "run_x", "--reason", "tooling_invalid", "--reason", "tooling_invalid"],
        { runDir: dir },
        { runDeliveryReverifyFn: svc },
      ),
      /multiple|duplicate/i,
      "duplicate --reason rejected",
    );
    assert.equal(svc.calls.length, 0);
    // Unknown flag.
    await assert.rejects(
      () => runsDeliveryCommand(
        ["reverify", "run_x", "--reason", "tooling_invalid", "--wat"],
        { runDir: dir },
        { runDeliveryReverifyFn: svc },
      ),
      /unknown flag/i,
      "unknown flag rejected",
    );
    assert.equal(svc.calls.length, 0);
    // Non-json format rejected.
    await assert.rejects(
      () => runsDeliveryCommand(
        ["reverify", "run_x", "--reason", "tooling_invalid", "--format", "xml"],
        { runDir: dir },
        { runDeliveryReverifyFn: svc },
      ),
      /format|json/i,
      "unknown format rejected",
    );
    assert.equal(svc.calls.length, 0);
  } finally {
    cleanupDir(dir);
  }
});

test("FR07-CLI-17: ordinary delivery query/accept/reject parsing is unaffected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fr07-cli-17-"));
  try {
    const svc = countingService(validServiceResult());
    await assert.rejects(
      () => runsDeliveryCommand(["reverify"], { runDir: dir }, { runDeliveryReverifyFn: svc }),
      /runId/,
      "bare 'reverify' is the sub-command and requires a runId",
    );
    // Ordinary query (no accept/reject) still works and never touches the
    // reverify service. Uses a real non-delivery transcript (fixture copy).
    const fixture = join(process.cwd(), "test", "fixtures", "transcript-evidence-passed-backend-failed.jsonl");
    const target = join(dir, "run_fixture_evidence_passed.jsonl");
    const { copyFileSync } = await import("node:fs");
    copyFileSync(fixture, target);
    const out = await captureLog(async () => {
      await runsDeliveryCommand(["run_fixture_evidence_passed"], { runDir: dir }, { runDeliveryReverifyFn: svc });
    });
    assert.ok(out.includes("run_fixture_evidence_passed"), "ordinary query still works");
    assert.equal(svc.calls.length, 0, "ordinary query never calls the reverify service");
  } finally {
    cleanupDir(dir);
  }
});
