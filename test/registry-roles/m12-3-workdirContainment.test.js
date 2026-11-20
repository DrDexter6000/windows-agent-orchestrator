import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { composeDeliveryExecutionContract } from "../../src/application/roleContract.js";
import { diagnoseFailure } from "../../src/diagnosis.js";
import { Run } from "../../src/runManager.js";
import { JsonlTranscript, readTranscript } from "../../src/transcript.js";

async function makeDeliveryRun({
  reportedPath,
  redact,
  deliveryContext = { runId: "run_m123_containment" },
}) {
  const root = await mkdtemp(join(tmpdir(), "wao-m123-containment-"));
  const effectiveCwd = join(root, "delivery-worktree");
  const transcriptPath = join(root, "runs", "run_m123_containment.jsonl");
  const transcript = new JsonlTranscript(transcriptPath, {
    runId: "run_m123_containment",
    agentId: "coder_hq",
  });
  let abortCount = 0;
  let packageCount = 0;
  const handle = {
    backend: "claude-code",
    backendSessionId: "session_m123",
    ...(redact ? { redact } : {}),
    async *events() {
      yield { kind: "file_written", path: reportedPath };
      yield { kind: "done", reason: "completed" };
    },
    async abort() {
      abortCount += 1;
    },
  };
  const run = new Run({
    runId: "run_m123_containment",
    agentId: "coder_hq",
    agent: { id: "coder_hq", cwd: effectiveCwd },
    backend: {},
    handle,
    transcript,
    result: {
      backend: "claude-code",
      backendSessionId: "session_m123",
      messageId: "message_m123",
      admittedSeq: 1,
    },
    config: { runDir: dirname(transcriptPath) },
    onRemove: () => {},
    initialState: "submitted",
    effectiveCwd,
    deliveryContext,
    packageDeliveryFn: async () => {
      packageCount += 1;
      const error = new Error("fixture stops after containment check");
      error.deliveryCode = "empty_diff";
      throw error;
    },
  });
  return {
    root,
    effectiveCwd,
    transcriptPath,
    run,
    getAbortCount: () => abortCount,
    getPackageCount: () => packageCount,
  };
}

async function runFixture(reportedPathFactory) {
  const fixture = await makeDeliveryRun({ reportedPath: "" });
  fixture.run.handle.events = async function* events() {
    yield { kind: "file_written", path: await reportedPathFactory(fixture) };
    yield { kind: "done", reason: "completed" };
  };
  try {
    const result = await fixture.run.waitForCompletion({ pollInterval: 1 });
    const events = await readTranscript(fixture.transcriptPath);
    const rawTranscript = await readFile(fixture.transcriptPath, "utf8");
    return { ...fixture, result, events, rawTranscript };
  } catch (error) {
    error.fixture = fixture;
    throw error;
  }
}

async function runFixtureWithRedactor(reportedPathFactory, redact) {
  const fixture = await makeDeliveryRun({ reportedPath: "", redact });
  fixture.run.handle.events = async function* events() {
    yield { kind: "file_written", path: await reportedPathFactory(fixture) };
    yield { kind: "done", reason: "completed" };
  };
  const result = await fixture.run.waitForCompletion({ pollInterval: 1 });
  const events = await readTranscript(fixture.transcriptPath);
  const rawTranscript = await readFile(fixture.transcriptPath, "utf8");
  return { ...fixture, result, events, rawTranscript };
}

async function createReportedFile(path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "reported", "utf8");
  return path;
}

test("M12-3-ISO-C1: delivery contract pins all work to process cwd / WAO_TARGET_CWD", () => {
  const contract = composeDeliveryExecutionContract();
  assert.match(contract, /current working directory|process cwd/i);
  assert.match(contract, /WAO_TARGET_CWD/);
  assert.match(contract, /do not.*(?:cd|chdir|pushd).*outside/i);
  assert.match(contract, /relative paths/i);
});

test("M12-3-ISO-R1: delivery run rejects an absolute file_written outside effectiveCwd before packaging", async () => {
  const output = await runFixture(({ root }) => (
    createReportedFile(join(root, "source-checkout", "src", "escaped.js"))
  ));
  try {
    assert.equal(output.getPackageCount(), 0, "packager must not inspect an escaped worktree");
    assert.equal(output.run.state, "failed");
    assert.equal(output.result.completed, false);
    assert.equal(output.result.isolationViolation, true);
    assert.equal(output.getAbortCount(), 1, "cleanup aborts the worker session exactly once");
    const violation = output.events.find((event) => event.type === "run.isolation_violation");
    assert.deepEqual(
      {
        type: violation?.type,
        code: violation?.code,
        eventKind: violation?.eventKind,
      },
      {
        type: "run.isolation_violation",
        code: "workdir_escape",
        eventKind: "file_written",
      },
    );
    assert.ok(!output.rawTranscript.includes("source-checkout"), "unsafe path is never persisted");
    assert.deepEqual(
      diagnoseFailure(output.events, "run_m123_containment"),
      {
        category: "workdir_escape",
        // M12-6 FR-02: code is the nullable closed-set provider diagnosis code —
        // null for every non-provider_auth category.
        code: null,
        evidence: [{
          eventType: "run.isolation_violation",
          fact: "worker reported a file write outside the authorized delivery worktree",
        }],
      },
    );
    assert.notEqual(
      diagnoseFailure(output.events, "run_other").category,
      "workdir_escape",
      "a cross-run violation cannot pollute this diagnosis",
    );
  } finally {
    await rm(output.root, { recursive: true, force: true });
  }
});

test("M12-3-ISO-R2: delivery run rejects relative traversal before packaging", async () => {
  const output = await runFixture(async ({ effectiveCwd }) => {
    const reportedPath = join("..", "source-checkout", "escaped.js");
    await createReportedFile(join(effectiveCwd, reportedPath));
    return reportedPath;
  });
  try {
    assert.equal(output.getPackageCount(), 0);
    assert.equal(output.run.state, "failed");
    assert.equal(output.result.completed, false);
    assert.equal(output.result.isolationViolation, true);
    assert.ok(output.events.some(
      (event) => event.type === "run.error"
        && event.phase === "isolation"
        && event.code === "workdir_escape",
    ));
  } finally {
    await rm(output.root, { recursive: true, force: true });
  }
});

test("M12-3-ISO-R3: containment uses the raw path before redaction can rewrite it", async () => {
  const output = await runFixtureWithRedactor(
    ({ root }) => createReportedFile(join(root, "secret-source", "escaped.js")),
    (value) => value?.kind === "file_written"
      ? { ...value, path: join("src", "apparently-inside.js") }
      : value,
  );
  try {
    assert.equal(output.getPackageCount(), 0);
    assert.equal(output.run.state, "failed");
    assert.equal(output.result.isolationViolation, true);
    assert.ok(!output.rawTranscript.includes("secret-source"));
  } finally {
    await rm(output.root, { recursive: true, force: true });
  }
});

test("M12-3-ISO-G1: repo-relative file_written inside effectiveCwd still reaches packaging", async () => {
  const output = await runFixture(async ({ effectiveCwd }) => {
    const reportedPath = join("src", "inside.js");
    await createReportedFile(join(effectiveCwd, reportedPath));
    return reportedPath;
  });
  try {
    assert.equal(output.getPackageCount(), 1);
    assert.ok(!output.events.some((event) => event.type === "run.isolation_violation"));
  } finally {
    await rm(output.root, { recursive: true, force: true });
  }
});

test("M12-3-ISO-G2: absolute file_written inside effectiveCwd still reaches packaging", async () => {
  const output = await runFixture(({ effectiveCwd }) => (
    createReportedFile(join(effectiveCwd, "src", "inside.js"))
  ));
  try {
    assert.equal(output.getPackageCount(), 1);
    assert.ok(!output.events.some((event) => event.type === "run.isolation_violation"));
  } finally {
    await rm(output.root, { recursive: true, force: true });
  }
});

test("M12-3-ISO-G3: non-delivery runs preserve existing file_written behavior", async () => {
  const fixture = await makeDeliveryRun({
    reportedPath: "",
    deliveryContext: null,
  });
  const outsidePath = join(fixture.root, "outside", "reported.js");
  await createReportedFile(outsidePath);
  fixture.run.handle.events = async function* events() {
    yield { kind: "file_written", path: outsidePath };
    yield { kind: "done", reason: "completed" };
  };
  try {
    const result = await fixture.run.waitForCompletion({ pollInterval: 1 });
    const events = await readTranscript(fixture.transcriptPath);
    assert.equal(result.completed, true);
    assert.equal(fixture.run.state, "completed");
    assert.equal(fixture.getPackageCount(), 0);
    assert.ok(!events.some((event) => event.type === "run.isolation_violation"));
    assert.ok(events.some(
      (event) => event.type === "run.event"
        && event.kind === "file_written"
        && event.path === outsidePath,
    ));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-3-ISO-R4: junction to an outside directory fails before packaging", async () => {
  const output = await runFixture(async ({ root, effectiveCwd }) => {
    const outsideDir = join(root, "outside-target");
    const outsideFile = await createReportedFile(join(outsideDir, "escaped.js"));
    const link = join(effectiveCwd, "linked");
    await mkdir(effectiveCwd, { recursive: true });
    await symlink(outsideDir, link, "junction");
    assert.equal(await readFile(join(link, "escaped.js"), "utf8"), await readFile(outsideFile, "utf8"));
    return join(link, "escaped.js");
  });
  try {
    assert.equal(output.getPackageCount(), 0);
    assert.equal(output.run.state, "failed");
    assert.equal(output.result.isolationViolation, true);
    assert.ok(output.events.some(
      (event) => event.type === "run.isolation_violation"
        && event.code === "workdir_escape",
    ));
    assert.ok(!output.rawTranscript.includes("outside-target"));
  } finally {
    await rm(output.root, { recursive: true, force: true });
  }
});

test("M12-3-ISO-R5: blank file_written paths fail closed before packaging", async () => {
  const output = await runFixture(async () => "   ");
  try {
    assert.equal(output.getPackageCount(), 0);
    assert.equal(output.run.state, "failed");
    assert.equal(output.result.isolationViolation, true);
  } finally {
    await rm(output.root, { recursive: true, force: true });
  }
});

// ===== TD-357: unresolved post-write targets fail closed =====
// The batch's containment fix is parser-side only (a codex file_change whose
// status is not "completed" is no longer reported as file_written). The gate
// itself is unchanged: a reported write whose target realpath cannot resolve
// (missing leaf, dangling link, removed junction, outside junction) still ends
// the run as workdir_escape before packaging. These regressions pin the
// fail-closed end-to-end behavior; no missing-leaf case passes.

async function createJunctionOrSkip(t, target, path) {
  try {
    await symlink(target, path, "junction");
    return true;
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`junction creation denied by platform: ${error.code}`);
      return false;
    }
    throw error;
  }
}

test("M12-3-ISO-R6: a dangling link at the reported leaf still fails closed (TD-357)", async (t) => {
  const fixture = await makeDeliveryRun({ reportedPath: "" });
  const link = join(fixture.effectiveCwd, "src", "dangling.js");
  await mkdir(dirname(link), { recursive: true });
  if (!await createJunctionOrSkip(t, join(fixture.root, "missing-r6-target"), link)) {
    await rm(fixture.root, { recursive: true, force: true });
    return;
  }
  fixture.run.handle.events = async function* events() {
    yield { kind: "file_written", path: join("src", "dangling.js") };
    yield { kind: "done", reason: "completed" };
  };
  try {
    const result = await fixture.run.waitForCompletion({ pollInterval: 1 });
    const events = await readTranscript(fixture.transcriptPath);
    assert.equal(fixture.getPackageCount(), 0);
    assert.equal(fixture.run.state, "failed");
    assert.equal(result.isolationViolation, true);
    const violation = events.find((event) => event.type === "run.isolation_violation");
    assert.equal(violation?.eventKind, "file_written");
    assert.equal(violation?.reason, "file_written_physical_unresolved");
    assert.equal(violation?.errorCode, "ENOENT");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-3-ISO-R7: a missing leaf under an outside junction stays an escape", async (t) => {
  const fixture = await makeDeliveryRun({ reportedPath: "" });
  const outside = join(fixture.root, "outside-r7");
  await mkdir(outside, { recursive: true });
  await mkdir(fixture.effectiveCwd, { recursive: true });
  if (!await createJunctionOrSkip(t, outside, join(fixture.effectiveCwd, "linked-r7"))) {
    await rm(fixture.root, { recursive: true, force: true });
    return;
  }
  fixture.run.handle.events = async function* events() {
    yield { kind: "file_written", path: join("linked-r7", "never-created.js") };
    yield { kind: "done", reason: "completed" };
  };
  try {
    const result = await fixture.run.waitForCompletion({ pollInterval: 1 });
    const events = await readTranscript(fixture.transcriptPath);
    assert.equal(fixture.getPackageCount(), 0);
    assert.equal(fixture.run.state, "failed");
    assert.equal(result.isolationViolation, true);
    const violation = events.find((event) => event.type === "run.isolation_violation");
    assert.equal(violation?.eventKind, "file_written");
    assert.equal(violation?.reason, "file_written_physical_unresolved");
    assert.equal(violation?.errorCode, "ENOENT");
    assert.equal(violation?.path, "linked-r7/never-created.js");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-3-ISO-R8 (sol scenario): write through an in-tree junction, then remove it → fails closed", async (t) => {
  const fixture = await makeDeliveryRun({ reportedPath: "" });
  const outside = join(fixture.root, "outside-r8");
  await mkdir(outside, { recursive: true });
  await mkdir(fixture.effectiveCwd, { recursive: true });
  const link = join(fixture.effectiveCwd, "shared-fixtures");
  if (!await createJunctionOrSkip(t, outside, link)) {
    await rm(fixture.root, { recursive: true, force: true });
    return;
  }
  // A worker mistakes the junction for an independent copy and writes a test
  // config through it; routine cleanup removes the junction before the
  // transcript is classified. The outside file survives.
  await writeFile(join(link, "wao-test-config.json"), "{\"fixture\":true}\n", "utf8");
  await rm(link, { recursive: true, force: true });
  fixture.run.handle.events = async function* events() {
    yield { kind: "file_written", path: join("shared-fixtures", "wao-test-config.json") };
    yield { kind: "done", reason: "completed" };
  };
  try {
    const result = await fixture.run.waitForCompletion({ pollInterval: 1 });
    const events = await readTranscript(fixture.transcriptPath);
    assert.equal(
      await readFile(join(outside, "wao-test-config.json"), "utf8"),
      "{\"fixture\":true}\n",
      "the write really landed outside the worktree",
    );
    assert.equal(fixture.getPackageCount(), 0, "the package must not run on this escape");
    assert.equal(fixture.run.state, "failed");
    assert.equal(result.isolationViolation, true);
    const violation = events.find((event) => event.type === "run.isolation_violation");
    assert.equal(violation?.eventKind, "file_written");
    assert.equal(violation?.reason, "file_written_physical_unresolved");
    assert.equal(violation?.errorCode, "ENOENT");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
