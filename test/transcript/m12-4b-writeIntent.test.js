import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { projectCollectResult } from "../../src/application/runCollectProjection.js";
import { collectRunMessages } from "../../src/application/runCollect.js";
import { ClaudeStreamParser } from "../../src/backends/parsers/claudeCode.js";
import { Run } from "../../src/runManager.js";
import { JsonlTranscript, readTranscript } from "../../src/transcript.js";

const RUN_ID = "run_m124b_write_intent";

async function makeFixture({ delivery = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "wao-m124b-write-intent-"));
  const effectiveCwd = join(root, "delivery-worktree");
  const runDir = join(root, "runs");
  const transcriptPath = join(runDir, `${RUN_ID}.jsonl`);
  await mkdir(effectiveCwd, { recursive: true });
  const transcript = new JsonlTranscript(transcriptPath, {
    runId: RUN_ID,
    agentId: "coder_hq",
  });
  await transcript.append("session.created", {
    backend: "claude-code",
    backendSessionId: "session_m124b",
  });
  let packageCount = 0;
  let eventFactory = async function* eventFactoryDefault() {
    yield { kind: "done", reason: "completed" };
  };
  const handle = {
    backend: "claude-code",
    backendSessionId: "session_m124b",
    events(...args) {
      return eventFactory(...args);
    },
    async abort() {},
  };
  const run = new Run({
    runId: RUN_ID,
    agentId: "coder_hq",
    agent: { id: "coder_hq", cwd: effectiveCwd },
    backend: {},
    handle,
    transcript,
    result: {
      backend: "claude-code",
      backendSessionId: "session_m124b",
      messageId: "message_m124b",
      admittedSeq: 1,
    },
    config: { runDir },
    onRemove: () => {},
    initialState: "submitted",
    effectiveCwd,
    deliveryContext: delivery ? { runId: RUN_ID } : null,
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
    runDir,
    transcriptPath,
    run,
    setEvents(factory) {
      eventFactory = factory;
    },
    getPackageCount() {
      return packageCount;
    },
  };
}

async function finishFixture(fixture) {
  const result = await fixture.run.waitForCompletion({ pollInterval: 1 });
  const events = await readTranscript(fixture.transcriptPath);
  return { result, events };
}

async function createFile(path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "confirmed", "utf8");
}

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

test("M12-4B-C: direct new file passes intent ancestor check and confirmed target check", async () => {
  const fixture = await makeFixture();
  const relativePath = join("src", "new.js");
  fixture.setEvents(async function* events() {
    yield {
      kind: "write_intent",
      path: relativePath,
      toolCallId: "write_direct",
      correlationStatus: "tracked",
    };
    yield { kind: "tool_result", tool: "write_direct", output: "ok", isError: false };
    await createFile(join(fixture.effectiveCwd, relativePath));
    yield { kind: "file_written", path: relativePath, toolCallId: "write_direct" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 1);
    assert.ok(!output.events.some((event) => event.type === "run.isolation_violation"));
    assert.equal(
      output.events.filter((event) => event.type === "run.event" && event.kind === "file_written").length,
      1,
    );
    const raw = await collectRunMessages({
      runId: RUN_ID,
      runDir: fixture.runDir,
      deferAppend: true,
    });
    const projected = projectCollectResult(raw, { runId: RUN_ID, mode: "compact" });
    assert.equal(projected.evidenceCounts.fileWritten, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-4B-D: nested new directories use the nearest existing inside ancestor", async () => {
  const fixture = await makeFixture();
  const relativePath = join("new", "nested", "tree", "result.js");
  fixture.setEvents(async function* events() {
    yield {
      kind: "write_intent",
      path: relativePath,
      toolCallId: "write_nested",
      correlationStatus: "tracked",
    };
    await createFile(join(fixture.effectiveCwd, relativePath));
    yield { kind: "file_written", path: relativePath, toolCallId: "write_nested" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 1);
    assert.ok(!output.events.some((event) => event.type === "run.isolation_violation"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-4B-E: existing-file edit remains strict and passes", async () => {
  const fixture = await makeFixture();
  const relativePath = join("src", "existing.js");
  await createFile(join(fixture.effectiveCwd, relativePath));
  fixture.setEvents(async function* events() {
    yield {
      kind: "write_intent",
      path: relativePath,
      toolCallId: "edit_existing",
      correlationStatus: "tracked",
    };
    yield { kind: "file_written", path: relativePath, toolCallId: "edit_existing" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 1);
    assert.ok(!output.events.some((event) => event.type === "run.isolation_violation"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const [label, pathFactory] of [
  ["relative traversal", (fixture) => join("..", "escaped.js")],
  ["absolute outside", (fixture) => join(fixture.root, "outside", "escaped.js")],
  ["sibling-prefix outside", (fixture) => join(`${fixture.effectiveCwd}-evil`, "escaped.js")],
  ["blank path", () => "   "],
]) {
  test(`M12-4B-F: ${label} intent fails before execution with isolation facts`, async () => {
    const fixture = await makeFixture();
    fixture.setEvents(async function* events() {
      yield {
        kind: "write_intent",
        path: pathFactory(fixture),
        toolCallId: `bad_${label}`,
        correlationStatus: "tracked",
      };
      yield { kind: "done", reason: "completed" };
    });
    try {
      const output = await finishFixture(fixture);
      assert.equal(fixture.getPackageCount(), 0);
      assert.equal(output.result.isolationViolation, true);
      assert.equal(fixture.run.state, "failed");
      assert.ok(output.events.some(
        (event) => event.type === "run.isolation_violation"
          && event.code === "workdir_escape"
          && event.eventKind === "write_intent",
      ));
      const rawTranscript = await readFile(fixture.transcriptPath, "utf8");
      assert.ok(!rawTranscript.includes("escaped.js"), "untrusted rejected path is not persisted");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("M12-4B-F: existing junction ancestor outside fails at intent", async (t) => {
  const fixture = await makeFixture();
  const outside = join(fixture.root, "outside-target");
  await mkdir(outside, { recursive: true });
  const linked = join(fixture.effectiveCwd, "linked");
  if (!await createJunctionOrSkip(t, outside, linked)) {
    await rm(fixture.root, { recursive: true, force: true });
    return;
  }
  fixture.setEvents(async function* events() {
    yield {
      kind: "write_intent",
      path: join("linked", "new.js"),
      toolCallId: "junction_intent",
      correlationStatus: "tracked",
    };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assert.equal(output.result.isolationViolation, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-4B-F: non-ENOENT path errors fail closed without ancestor walking", async () => {
  const fixture = await makeFixture();
  fixture.setEvents(async function* events() {
    yield {
      kind: "write_intent",
      path: "invalid\0path.js",
      toolCallId: "invalid_path_intent",
      correlationStatus: "tracked",
    };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assert.equal(output.result.isolationViolation, true);
    assert.ok(output.events.some(
      (event) => event.type === "run.isolation_violation"
        && event.eventKind === "write_intent",
    ));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const [label, resultEvent] of [
  ["missing result", null],
  [
    "mismatched result",
    { kind: "tool_result", tool: "another_call", output: "ok", isError: false },
  ],
  [
    "matching successful result without confirmation",
    { kind: "tool_result", tool: "pending_write", output: "ok", isError: false },
  ],
]) {
  test(`M12-4B-P1: ${label} leaves a tracked write pending and blocks packaging`, async () => {
    const fixture = await makeFixture();
    fixture.setEvents(async function* events() {
      yield {
        kind: "write_intent",
        path: join("src", "pending.js"),
        toolCallId: "pending_write",
        correlationStatus: "tracked",
      };
      if (resultEvent) yield resultEvent;
      yield { kind: "done", reason: "completed" };
    });
    try {
      const output = await finishFixture(fixture);
      assert.equal(fixture.getPackageCount(), 0);
      assert.equal(fixture.run.state, "failed");
      assert.equal(output.result.isolationViolation, true);
      assert.equal(
        output.events.filter(
          (event) => event.type === "run.event" && event.kind === "file_written",
        ).length,
        0,
      );
      const violation = output.events.find(
        (event) => event.type === "run.isolation_violation",
      );
      assert.equal(violation?.eventKind, "write_intent");
      assert.ok(!Object.hasOwn(violation ?? {}, "path"));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("M12-4B-P1: matching error result resolves a pending write without isolation failure", async () => {
  const fixture = await makeFixture();
  fixture.setEvents(async function* events() {
    yield {
      kind: "write_intent",
      path: join("src", "failed.js"),
      toolCallId: "failed_write",
      correlationStatus: "tracked",
    };
    yield { kind: "tool_result", tool: "failed_write", output: "denied", isError: true };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 1);
    assert.equal(output.result.isolationViolation, undefined);
    assert.ok(!output.events.some((event) => event.type === "run.isolation_violation"));
    assert.equal(
      output.events.filter(
        (event) => event.type === "run.event" && event.kind === "file_written",
      ).length,
      0,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-4B-G: confirmation rejects a junction replacement after intent and skips packaging", async (t) => {
  const fixture = await makeFixture();
  const outside = join(fixture.root, "outside-after-intent");
  await mkdir(outside, { recursive: true });
  await createFile(join(outside, "escaped.js"));
  const linked = join(fixture.effectiveCwd, "late-link");
  const probe = join(fixture.effectiveCwd, "junction-capability-probe");
  if (!await createJunctionOrSkip(t, outside, probe)) {
    await rm(fixture.root, { recursive: true, force: true });
    return;
  }
  await rm(probe, { force: true });
  fixture.setEvents(async function* events() {
    yield {
      kind: "write_intent",
      path: join("late-link", "escaped.js"),
      toolCallId: "junction_after_intent",
      correlationStatus: "tracked",
    };
    await symlink(outside, linked, "junction");
    yield {
      kind: "tool_result",
      tool: "junction_after_intent",
      output: "ok",
      isError: false,
    };
    yield {
      kind: "file_written",
      path: join("late-link", "escaped.js"),
      toolCallId: "junction_after_intent",
    };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assert.equal(output.result.isolationViolation, true);
    assert.ok(output.events.some(
      (event) => event.type === "run.isolation_violation"
        && event.eventKind === "file_written",
    ));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-4B-P1: unresolved intent blocks packaging after ancestor becomes an outside junction", async (t) => {
  const fixture = await makeFixture();
  const outside = join(fixture.root, "outside-unconfirmed");
  await mkdir(outside, { recursive: true });
  const linked = join(fixture.effectiveCwd, "late-unconfirmed-link");
  const probe = join(fixture.effectiveCwd, "junction-capability-probe-unconfirmed");
  if (!await createJunctionOrSkip(t, outside, probe)) {
    await rm(fixture.root, { recursive: true, force: true });
    return;
  }
  await rm(probe, { force: true });
  fixture.setEvents(async function* events() {
    yield {
      kind: "write_intent",
      path: join("late-unconfirmed-link", "escaped.js"),
      toolCallId: "unconfirmed_junction_write",
      correlationStatus: "tracked",
    };
    await symlink(outside, linked, "junction");
    await writeFile(join(linked, "escaped.js"), "outside", "utf8");
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(await readFile(join(outside, "escaped.js"), "utf8"), "outside");
    assert.equal(fixture.getPackageCount(), 0);
    assert.equal(fixture.run.state, "failed");
    assert.equal(output.result.isolationViolation, true);
    const violation = output.events.find(
      (event) => event.type === "run.isolation_violation",
    );
    assert.equal(violation?.eventKind, "write_intent");
    assert.ok(!Object.hasOwn(violation ?? {}, "path"));
    assert.equal(
      output.events.filter(
        (event) => event.type === "run.event" && event.kind === "file_written",
      ).length,
      0,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-4B-G: successful result without materialized target fails strict confirmation", async () => {
  const fixture = await makeFixture();
  const parser = new ClaudeStreamParser();
  const parsed = parser.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"write_missing","name":"Write","input":{"file_path":"src/missing.js"}}]}}\n'
    + '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"write_missing","content":"ok","is_error":false}]}}\n'
    + '{"type":"result","subtype":"success","is_error":false}\n',
  );
  fixture.setEvents(async function* events() {
    yield* parsed;
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assert.equal(output.result.isolationViolation, true);
    const raw = await collectRunMessages({
      runId: RUN_ID,
      runDir: fixture.runDir,
      deferAppend: true,
    });
    const projected = projectCollectResult(raw, { runId: RUN_ID, mode: "compact" });
    assert.equal(projected.evidenceCounts.fileWritten, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const [label, lines, expectedPersistedIntents] of [
  [
    "missing call id",
    [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"src/missing-id.js"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"must not persist"}]}}',
      '{"type":"result","subtype":"success","is_error":false}',
    ],
    0,
  ],
  [
    "duplicate open call id",
    [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"duplicate_open","name":"Write","input":{"file_path":"src/first.js"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"duplicate_open","name":"Edit","input":{"file_path":"src/second.js"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"duplicate_open","content":"ok"}]}}',
      '{"type":"result","subtype":"success","is_error":false}',
    ],
    1,
  ],
]) {
  test(`M12-4B-P1: ${label} aborts delivery before following events or packaging`, async () => {
    const fixture = await makeFixture();
    const parser = new ClaudeStreamParser();
    const parsed = parser.feed(`${lines.join("\n")}\n`);
    fixture.setEvents(async function* events() {
      yield* parsed;
    });
    try {
      const output = await finishFixture(fixture);
      assert.equal(fixture.getPackageCount(), 0);
      assert.equal(output.result.isolationViolation, true);
      assert.equal(
        output.events.filter(
          (event) => event.type === "run.event" && event.kind === "write_intent",
        ).length,
        expectedPersistedIntents,
      );
      assert.equal(
        output.events.filter(
          (event) => event.type === "run.event" && event.kind === "file_written",
        ).length,
        0,
      );
      assert.ok(!output.events.some(
        (event) => event.type === "run.event"
          && event.kind === "message"
          && event.parts?.some((part) => part.text === "must not persist"),
      ));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("M12-4B-P1: pending-map overflow aborts delivery before confirmation or packaging", async () => {
  const fixture = await makeFixture();
  const parser = new ClaudeStreamParser();
  const intents = Array.from({ length: 257 }, (_, index) => (
    `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"overflow_${index}","name":"Write","input":{"file_path":"src/file_${index}.js"}}]}}`
  ));
  const parsed = parser.feed(
    `${intents.join("\n")}\n`
    + '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"overflow_0","content":"ok"}]}}\n'
    + '{"type":"result","subtype":"success","is_error":false}\n',
  );
  fixture.setEvents(async function* events() {
    yield* parsed;
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assert.equal(output.result.isolationViolation, true);
    assert.equal(
      output.events.filter(
        (event) => event.type === "run.event" && event.kind === "write_intent",
      ).length,
      256,
    );
    assert.equal(
      output.events.filter(
        (event) => event.type === "run.event" && event.kind === "file_written",
      ).length,
      0,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-4B-P1: non-delivery run does not isolation-gate an unconfirmable intent", async () => {
  const fixture = await makeFixture({ delivery: false });
  fixture.setEvents(async function* events() {
    yield {
      kind: "write_intent",
      path: "src/missing-id.js",
      toolCallId: "unknown",
      correlationStatus: "missing_tool_call_id",
    };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(output.result.completed, true);
    assert.ok(!output.events.some((event) => event.type === "run.isolation_violation"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-4B-H/J: failed tool result persists intent/result but collect counts zero confirmed writes", async () => {
  const fixture = await makeFixture();
  const parser = new ClaudeStreamParser();
  const parsed = parser.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"write_failed","name":"Write","input":{"file_path":"src/not-created.js"}}]}}\n'
    + '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"write_failed","content":"denied","is_error":true}]}}\n'
    + '{"type":"result","subtype":"success","is_error":false}\n',
  );
  fixture.setEvents(async function* events() {
    yield* parsed;
  });
  try {
    await finishFixture(fixture);
    const raw = await collectRunMessages({
      runId: RUN_ID,
      runDir: fixture.runDir,
      deferAppend: true,
    });
    const projected = projectCollectResult(raw, { runId: RUN_ID, mode: "compact" });
    assert.equal(projected.evidenceCounts.fileWritten, 0);
    assert.equal(raw.data.filter((event) => event.kind === "file_written").length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-4B-I: non-delivery confirmed file_written behavior remains unchanged", async () => {
  const fixture = await makeFixture({ delivery: false });
  const outside = join(fixture.root, "outside", "confirmed.js");
  await createFile(outside);
  fixture.setEvents(async function* events() {
    yield { kind: "file_written", path: outside };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(output.result.completed, true);
    assert.ok(output.events.some(
      (event) => event.type === "run.event"
        && event.kind === "file_written"
        && event.path === outside,
    ));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
