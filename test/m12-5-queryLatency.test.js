import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { listRuns } from "../src/application/runList.js";

// M12-16 (Package B): the per-history Git-proof latency is REMOVED causally.
// The authorized root is proved exactly once (construction). Per-run ownership
// identity is canonical-path equality with that proof — an absolute cwd whose
// realpath resolves to the same canonical directory is already the identical
// proven workspace, so no per-run Git subprocess can add identity information.
// These tests prove the absence of per-run Git with spies (the Git-proof
// function is the ONLY process-spawning entry point), not with a loose
// wall-clock threshold, and no second cache/index/sidecar is created.

// Distinct RAW spellings of the same proven directory. Production realpathSync
// resolves each of these to ONE canonical identity; the injectable double
// mirrors realpathSync for the fixture spellings.
const ALIAS_CWDS = [
  "C:\\Target\\Repo",
  "C:\\TARGET\\REPO",
  "C:\\target\\repo",
  "C:/Target/Repo",
  "C:/TARGET/REPO/",
  "C:\\Target\\Repo\\",
];

// Git-proof spy: the ONLY legal call is the authorized root at construction.
function authorizedOnlyProve(proofCalls, authorizedRoot) {
  return (path) => {
    proofCalls.push(path);
    if (path === authorizedRoot) {
      return { root: "C:/Target/Repo", gitHead: "a".repeat(40), dirty: false };
    }
    throw new Error("probe sentinel: per-run Git proof must not happen");
  };
}

// Canonicalization double mirroring realpathSync for the fixtures: same-directory
// spellings (case, separators, trailing separators) → one canonical identity;
// a foreign directory → its own identity; everything else → unrealpathable.
function fixtureCanonicalizer(canonicalCalls) {
  return (path) => {
    canonicalCalls.push(path);
    const norm = path.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
    if (norm === "c:/target/repo") return "C:/Target/Repo";
    if (norm === "d:/other/repo") return "D:/Other/Repo";
    throw new Error("unrealpathable probe sentinel");
  };
}

function runEvents(runId, cwd, ts) {
  return [
    { type: "run.started", runId, agentId: "coder_low", ts, seq: 1 },
    { type: "run.background_submitted", runId, agentId: "coder_low", cwd, ts, seq: 2 },
    {
      type: "run.state_change",
      runId,
      agentId: "coder_low",
      from: "running",
      to: "completed",
      ts,
      seq: 3,
    },
  ];
}

test("M12-5-RED-01: one list query creates one workspace verifier and reuses it for every run", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m125-list-"));
  const runIds = [
    "run_20260729170000001alpha",
    "run_20260729170000002bravo",
    "run_20260729170000003charlie",
  ];
  const eventsByFile = new Map();
  try {
    runIds.forEach((runId, index) => {
      const file = `${runId}.jsonl`;
      writeFileSync(join(runDir, file), "", "utf8");
      eventsByFile.set(
        file,
        runEvents(runId, "C:\\Target\\Repo", `2026-07-29T17:00:0${index}.000Z`),
      );
    });

    let factoryCalls = 0;
    let verifierCalls = 0;
    const result = await listRuns({
      runDir,
      authorizedWorkspaceRoot: "C:\\Target\\Repo",
      knownAgentIds: ["coder_low"],
      readTranscriptFn: async (filePath) => eventsByFile.get(basename(filePath)),
      createWorkspaceVerifierFn: (authorizedRoot) => {
        factoryCalls += 1;
        assert.equal(authorizedRoot, "C:\\Target\\Repo");
        return (events) => {
          verifierCalls += 1;
          assert.equal(events[1].cwd, authorizedRoot);
          return { authorized: true, ownershipCwd: events[1].cwd };
        };
      },
    });

    assert.equal(factoryCalls, 1);
    assert.equal(verifierCalls, 3);
    assert.equal(result.matchedCount, 3);
    assert.deepEqual(result.runs.map((run) => run.runId), runIds.toReversed());
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("M12-5-RED-02: verifier proves the authorized root once; ownership identity comes from canonical path equality, never Git", async () => {
  const ownership = await import("../src/application/runWorkspaceOwnership.js");
  assert.equal(typeof ownership.createRunWorkspaceVerifier, "function");

  const proofCalls = [];
  const canonicalCalls = [];
  const verify = ownership.createRunWorkspaceVerifier("C:\\Target\\Repo", {
    proveWorkspaceFn: authorizedOnlyProve(proofCalls, "C:\\Target\\Repo"),
    canonicalizeWorkspacePathFn: fixtureCanonicalizer(canonicalCalls),
  });
  // Same-directory ALIAS (different casing): accepted via canonical identity —
  // the identical proven workspace, no second Git proof.
  const first = runEvents("run_20260729170000004delta", "C:\\TARGET\\REPO", "2026-07-29T17:00:04.000Z");
  const second = runEvents("run_20260729170000005echo", "C:\\TARGET\\REPO", "2026-07-29T17:00:05.000Z");

  assert.equal(verify(first).authorized, true);
  assert.equal(verify(second).authorized, true);
  assert.deepEqual(proofCalls, ["C:\\Target\\Repo"], "the ONLY Git proof is the authorized root at construction");
  assert.deepEqual(canonicalCalls, ["C:\\TARGET\\REPO"], "the alias is canonicalized once, not per run");

  // A DIFFERENT canonical identity still fails closed — and still spawns no Git.
  const crossWorkspace = runEvents(
    "run_20260729170000006foxtrot",
    "D:\\Other\\Repo",
    "2026-07-29T17:00:06.000Z",
  );
  assert.throws(() => verify(crossWorkspace), /workspace mismatch/);
  assert.deepEqual(proofCalls, ["C:\\Target\\Repo"], "fail-closed mismatch never spawns Git");
  assert.deepEqual(canonicalCalls, ["C:\\TARGET\\REPO", "D:\\Other\\Repo"]);
});

test("M12-5-RED-03: cached verifier keeps missing, malformed, and ambiguous ownership fail-closed", async () => {
  const ownership = await import("../src/application/runWorkspaceOwnership.js");
  assert.equal(typeof ownership.createRunWorkspaceVerifier, "function");

  const proofCalls = [];
  const verify = ownership.createRunWorkspaceVerifier("C:\\Target\\Repo", {
    proveWorkspaceFn: authorizedOnlyProve(proofCalls, "C:\\Target\\Repo"),
    canonicalizeWorkspacePathFn: fixtureCanonicalizer([]),
  });

  assert.throws(() => verify([]), /missing ownership/);
  assert.throws(
    () => verify([{ type: "run.background_submitted", cwd: "" }]),
    /malformed ownership/,
  );
  assert.throws(
    () => verify([
      { type: "run.background_submitted", cwd: "C:\\Target\\Repo" },
      { type: "run.background_submitted", cwd: "C:\\Target\\Repo" },
    ]),
    /ambiguous ownership/,
  );
  assert.deepEqual(proofCalls, ["C:\\Target\\Repo"], "fail-closed facts never reach Git");
});

test("M12-5-RED-04: repeated unrealpathable ownership cwd is canonicalized once and remains fail-closed", async () => {
  const ownership = await import("../src/application/runWorkspaceOwnership.js");
  const proofCalls = [];
  const canonicalCalls = [];
  const verify = ownership.createRunWorkspaceVerifier("C:\\Target\\Repo", {
    proveWorkspaceFn: authorizedOnlyProve(proofCalls, "C:\\Target\\Repo"),
    canonicalizeWorkspacePathFn: (path) => {
      canonicalCalls.push(path);
      if (path === "C:\\Missing\\Repo") throw new Error("unrealpathable probe sentinel");
      return "C:/Target/Repo";
    },
  });
  const events = runEvents(
    "run_20260729170000007golf",
    "C:\\Missing\\Repo",
    "2026-07-29T17:00:07.000Z",
  );

  assert.throws(() => verify(events), /unprovable ownership workspace/);
  assert.throws(() => verify(events), /unprovable ownership workspace/);
  assert.deepEqual(proofCalls, ["C:\\Target\\Repo"], "an unrealpathable cwd never reaches Git");
  assert.deepEqual(canonicalCalls, ["C:\\Missing\\Repo"], "the unrealpathable cwd is canonicalized exactly once");
});

test("M12-16-LAT-01: many runs with distinct raw cwds cause exactly ONE Git proof — zero per-run Git processes", async () => {
  const ownership = await import("../src/application/runWorkspaceOwnership.js");
  const AUTHORIZED = "C:\\Target\\Repo";
  const proofCalls = [];
  const canonicalCalls = [];
  const verify = ownership.createRunWorkspaceVerifier(AUTHORIZED, {
    proveWorkspaceFn: authorizedOnlyProve(proofCalls, AUTHORIZED),
    canonicalizeWorkspacePathFn: fixtureCanonicalizer(canonicalCalls),
  });

  const runIds = Array.from({ length: 36 }, (_, i) => `run_20260729170${String(i).padStart(3, "0")}m1216`);
  for (let i = 0; i < runIds.length; i++) {
    const events = runEvents(runIds[i], ALIAS_CWDS[i % ALIAS_CWDS.length], `2026-07-29T17:${String(i).padStart(2, "0")}.000Z`);
    assert.equal(verify(events, runIds[i]).authorized, true, `run ${runIds[i]}`);
  }
  assert.deepEqual(proofCalls, [AUTHORIZED], "the ONLY Git proof is the authorized root at construction");
  assert.equal(canonicalCalls.length, ALIAS_CWDS.length, "one canonicalization per DISTINCT raw cwd, not per run");

  // Repeat pass over the same runs: the raw-cwd cache means ZERO additional
  // canonicalization AND ZERO additional Git — the per-history cost is one
  // in-process canonicalization per distinct spelling, paid once.
  for (let i = 0; i < runIds.length; i++) {
    const events = runEvents(runIds[i], ALIAS_CWDS[i % ALIAS_CWDS.length], `2026-07-29T18:${String(i).padStart(2, "0")}.000Z`);
    assert.equal(verify(events, runIds[i]).authorized, true, `repeat run ${runIds[i]}`);
  }
  assert.deepEqual(proofCalls, [AUTHORIZED], "repeat pass: still no per-run Git");
  assert.equal(canonicalCalls.length, ALIAS_CWDS.length, "repeat pass: raw cwds canonicalized once in the verifier lifetime");

  // A foreign canonical identity still fails closed — with no Git either.
  const foreign = runEvents("run_20260729170999m1216zulu", "D:\\Other\\Repo", "2026-07-29T17:99:00.000Z");
  assert.throws(() => verify(foreign, "run_20260729170999m1216zulu"), /workspace mismatch/);
  assert.deepEqual(proofCalls, [AUTHORIZED], "fail-closed mismatch never spawns Git");
});

test("M12-16-LAT-02: runs_list over 40 runs with distinct raw cwds performs ZERO per-run Git proofs", async () => {
  const ownership = await import("../src/application/runWorkspaceOwnership.js");
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1216-lat-"));
  const AUTHORIZED = "C:\\Target\\Repo";
  const proofCalls = [];
  const canonicalCalls = [];
  const runIds = Array.from({ length: 40 }, (_, i) => `run_2026072917000${String(i).padStart(2, "0")}nov${i}`);
  const foreignId = "run_20260729170099zulu";
  const eventsByFile = new Map();
  try {
    for (const id of [...runIds, foreignId]) writeFileSync(join(runDir, `${id}.jsonl`), "", "utf8");
    runIds.forEach((runId, i) => {
      eventsByFile.set(
        `${runId}.jsonl`,
        runEvents(runId, ALIAS_CWDS[i % ALIAS_CWDS.length], `2026-07-29T17:${String(i).padStart(2, "0")}.000Z`),
      );
    });
    eventsByFile.set(`${foreignId}.jsonl`, runEvents(foreignId, "D:\\Other\\Repo", "2026-07-29T17:59:00.000Z"));

    const result = await listRuns({
      runDir,
      authorizedWorkspaceRoot: AUTHORIZED,
      knownAgentIds: ["coder_low"],
      readTranscriptFn: async (filePath) => eventsByFile.get(basename(filePath)),
      createWorkspaceVerifierFn: (root) => ownership.createRunWorkspaceVerifier(root, {
        proveWorkspaceFn: authorizedOnlyProve(proofCalls, AUTHORIZED),
        canonicalizeWorkspacePathFn: fixtureCanonicalizer(canonicalCalls),
      }),
    });

    assert.equal(result.matchedCount, runIds.length, "all in-workspace runs matched");
    assert.ok(!result.runs.some((r) => r.runId === foreignId), "foreign-workspace run excluded");
    assert.deepEqual(proofCalls, [AUTHORIZED], "the whole inventory scan spawns exactly ONE Git proof (authorized root)");
    // 40 runs + 1 foreign run → exactly ONE canonicalization per DISTINCT raw
    // spelling (6 same-directory aliases + the foreign cwd = 7), never per run.
    const distinctCwds = [...ALIAS_CWDS, "D:\\Other\\Repo"];
    assert.equal(canonicalCalls.length, distinctCwds.length, "no per-run canonicalization");
    for (const cwd of distinctCwds) {
      assert.equal(
        canonicalCalls.filter((c) => c === cwd).length,
        1,
        `raw cwd canonicalized exactly once across the full history: ${cwd}`,
      );
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// M12-20: the Owner Dashboard active fast-path keeps the EXPENSIVE per-run work
// O(current lease candidates). Active scope enumerates owner-lease candidates
// (.owner-<runId> files — the CURRENT leases) and opens/parses ONLY those
// transcripts (plus per-run workspace verification + ownerLiveness). The runDir
// directory IS still enumerated once by readdirSync (its cost grows with the
// total entry count, including historical transcripts), but no historical
// transcript is opened, parsed, or verified. With one active lease amid 50
// historical runs, active scope reads exactly ONE transcript. This is the
// machine-checked answer to the independent-review question: "Can the expensive
// active-scope work still scale with the entire historical transcript
// inventory?" — No; only the single directory read touches the inventory.
test("M12-20-LAT-01: active scope opens/parses O(current lease candidates) — no historical transcript is read", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1220-lat-"));
  const AUTHORIZED = "C:\\Target\\Repo";
  const HIST_COUNT = 50;
  const historical = Array.from({ length: HIST_COUNT }, (_, i) => `run_2026080100000${String(i).padStart(2, "0")}hist`);
  const active = "run_20260812000000000alive";
  const eventsByFile = new Map();
  const proofCalls = [];
  const canonicalCalls = [];
  const ownership = await import("../src/application/runWorkspaceOwnership.js");
  try {
    // Every run has a transcript file on disk; only `active` has a CURRENT lease.
    for (const id of [...historical, active]) writeFileSync(join(runDir, `${id}.jsonl`), "", "utf8");
    writeFileSync(join(runDir, `.owner-${active}`), JSON.stringify({ heartbeatAt: 1_700_000_000_000 - 1000, pid: 12345 }), "utf8");
    historical.forEach((runId, i) => {
      eventsByFile.set(`${runId}.jsonl`, runEvents(runId, AUTHORIZED, `2026-08-01T00:00:${String(i).padStart(2, "0")}.000Z`));
    });
    eventsByFile.set(`${active}.jsonl`, [
      { type: "run.started", runId: active, agentId: "coder_low", ts: "2026-08-12T00:00:00.000Z", seq: 1 },
      { type: "run.background_submitted", runId: active, agentId: "coder_low", cwd: AUTHORIZED, ts: "2026-08-12T00:00:00.000Z", seq: 2 },
      { type: "run.state_change", runId: active, agentId: "coder_low", from: "pending", to: "running", reason: "go", ts: "2026-08-12T00:00:00.000Z", seq: 3 },
    ]);

    const reads = [];
    const result = await listRuns({
      runDir,
      scanScope: "active",
      nowMs: 1_700_000_000_000,
      authorizedWorkspaceRoot: AUTHORIZED,
      knownAgentIds: ["coder_low"],
      readTranscriptFn: async (filePath) => { reads.push(basename(filePath)); return eventsByFile.get(basename(filePath)); },
      createWorkspaceVerifierFn: (root) => ownership.createRunWorkspaceVerifier(root, {
        proveWorkspaceFn: authorizedOnlyProve(proofCalls, AUTHORIZED),
        canonicalizeWorkspacePathFn: fixtureCanonicalizer(canonicalCalls),
      }),
    });

    // Exactly ONE transcript read — the active candidate. None of the 50
    // historical transcripts was opened or parsed (the directory was enumerated
    // once by readdirSync, but only the active candidate's transcript is read).
    assert.equal(reads.length, 1, `active opened exactly ONE transcript (got ${reads.length}); no historical transcript read`);
    assert.equal(reads[0], `${active}.jsonl`);
    assert.deepEqual(result.runs.map((r) => r.runId), [active]);
    assert.equal(result.runs[0].activityStatus, "active");
    assert.equal(result.scanScope, "active");
    assert.ok(!("unresolvedCount" in result), "active never reports a full-inventory count");
    // The active enumeration also spawns no per-run Git (one construction proof).
    assert.deepEqual(proofCalls, [AUTHORIZED]);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// The default scope (MCP runs_list / CLI — no scanScope) STILL scans the full
// inventory and reports unresolvedCount. This guards against accidentally
// narrowing the default path: the active fast-path is opt-in via scanScope only.
test("M12-20-LAT-02: default scope (no scanScope) still scans the full inventory and reports unresolvedCount", async () => {
  const ownership = await import("../src/application/runWorkspaceOwnership.js");
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1220-def-"));
  const AUTHORIZED = "C:\\Target\\Repo";
  const ids = [
    "run_20260801000000001def",
    "run_20260801000000002def",
    "run_20260801000000003def",
  ];
  const eventsByFile = new Map();
  try {
    ids.forEach((runId, i) => {
      writeFileSync(join(runDir, `${runId}.jsonl`), "", "utf8");
      eventsByFile.set(`${runId}.jsonl`, runEvents(runId, AUTHORIZED, `2026-08-01T00:00:0${i}.000Z`));
    });
    const reads = [];
    const result = await listRuns({
      runDir,
      authorizedWorkspaceRoot: AUTHORIZED,
      knownAgentIds: ["coder_low"],
      nowMs: 1_700_000_000_000,
      readTranscriptFn: async (filePath) => { reads.push(basename(filePath)); return eventsByFile.get(basename(filePath)); },
      createWorkspaceVerifierFn: (root) => ownership.createRunWorkspaceVerifier(root, {
        proveWorkspaceFn: authorizedOnlyProve([], AUTHORIZED),
        canonicalizeWorkspacePathFn: fixtureCanonicalizer([]),
      }),
    });
    assert.equal(reads.length, ids.length, "default scope reads EVERY transcript (full inventory)");
    assert.equal(result.matchedCount, ids.length);
    assert.ok(!("scanScope" in result), "default scope carries no scanScope");
    assert.equal(typeof result.unresolvedCount, "number", "default scope reports the full-scan unresolvedCount");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
