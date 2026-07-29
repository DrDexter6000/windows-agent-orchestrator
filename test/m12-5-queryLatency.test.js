import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { listRuns } from "../src/application/runList.js";

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

test("M12-5-RED-02: verifier proves the authorized root once and each distinct ownership cwd once", async () => {
  const ownership = await import("../src/application/runWorkspaceOwnership.js");
  assert.equal(typeof ownership.createRunWorkspaceVerifier, "function");

  const proofCalls = [];
  const proveWorkspaceFn = (path) => {
    proofCalls.push(path);
    if (path === "C:\\Target\\Repo" || path === "C:\\TARGET\\REPO") {
      return { root: "C:/Target/Repo", gitHead: "a".repeat(40), dirty: false };
    }
    if (path === "D:\\Other\\Repo") {
      return { root: "D:/Other/Repo", gitHead: "b".repeat(40), dirty: false };
    }
    throw new Error("unprovable");
  };

  const verify = ownership.createRunWorkspaceVerifier("C:\\Target\\Repo", {
    proveWorkspaceFn,
  });
  const first = runEvents("run_20260729170000004delta", "C:\\TARGET\\REPO", "2026-07-29T17:00:04.000Z");
  const second = runEvents("run_20260729170000005echo", "C:\\TARGET\\REPO", "2026-07-29T17:00:05.000Z");

  assert.equal(verify(first).authorized, true);
  assert.equal(verify(second).authorized, true);
  assert.deepEqual(proofCalls, ["C:\\Target\\Repo", "C:\\TARGET\\REPO"]);

  const crossWorkspace = runEvents(
    "run_20260729170000006foxtrot",
    "D:\\Other\\Repo",
    "2026-07-29T17:00:06.000Z",
  );
  assert.throws(() => verify(crossWorkspace), /workspace mismatch/);
  assert.deepEqual(
    proofCalls,
    ["C:\\Target\\Repo", "C:\\TARGET\\REPO", "D:\\Other\\Repo"],
  );
});

test("M12-5-RED-03: cached verifier keeps missing, malformed, and ambiguous ownership fail-closed", async () => {
  const ownership = await import("../src/application/runWorkspaceOwnership.js");
  assert.equal(typeof ownership.createRunWorkspaceVerifier, "function");

  const verify = ownership.createRunWorkspaceVerifier("C:\\Target\\Repo", {
    proveWorkspaceFn: (path) => ({
      root: path.replace(/\\/g, "/"),
      gitHead: "a".repeat(40),
      dirty: false,
    }),
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
});

test("M12-5-RED-04: repeated unprovable ownership path is proved once and remains fail-closed", async () => {
  const ownership = await import("../src/application/runWorkspaceOwnership.js");
  const proofCalls = [];
  const verify = ownership.createRunWorkspaceVerifier("C:\\Target\\Repo", {
    proveWorkspaceFn: (path) => {
      proofCalls.push(path);
      if (path === "C:\\Target\\Repo") {
        return {
          root: "C:/Target/Repo",
          gitHead: "a".repeat(40),
          dirty: false,
        };
      }
      throw new Error("probe sentinel must not escape");
    },
  });
  const events = runEvents(
    "run_20260729170000007golf",
    "C:\\Missing\\Repo",
    "2026-07-29T17:00:07.000Z",
  );

  assert.throws(() => verify(events), /unprovable ownership workspace/);
  assert.throws(() => verify(events), /unprovable ownership workspace/);
  assert.deepEqual(proofCalls, ["C:\\Target\\Repo", "C:\\Missing\\Repo"]);
});
