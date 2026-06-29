import test from "node:test";
import assert from "node:assert/strict";
import { messageEvent, doneEvent, metricsEvent, commandEvent, fileWrittenEvent, toolUseEvent, toolResultEvent, RUN_EVENT_KINDS } from "../src/runEvent.js";

test("messageEvent constructs correct shape", () => {
  const ev = messageEvent("assistant", [{ type: "text", text: "hello" }]);
  assert.deepEqual(ev, {
    kind: "message",
    role: "assistant",
    parts: [{ type: "text", text: "hello" }],
  });
});

test("doneEvent with completed reason", () => {
  const ev = doneEvent("completed");
  assert.deepEqual(ev, { kind: "done", reason: "completed" });
});

test("doneEvent with failed reason and error", () => {
  const ev = doneEvent("failed", "backend exploded");
  assert.deepEqual(ev, { kind: "done", reason: "failed", error: "backend exploded" });
});

test("doneEvent rejects invalid reason", () => {
  assert.throws(() => doneEvent("timed_out"), /completed\|failed/);
  assert.throws(() => doneEvent("pending"), /completed\|failed/);
  assert.throws(() => doneEvent(undefined), /completed\|failed/);
});

test("metricsEvent with tokens and cost", () => {
  const ev = metricsEvent({ input: 100, output: 50, reasoning: 10, costUsd: 0.01 });
  assert.equal(ev.kind, "metrics");
  assert.deepEqual(ev.tokens, { input: 100, output: 50, reasoning: 10 });
  assert.equal(ev.costUsd, 0.01);
});

test("metricsEvent omits undefined fields", () => {
  const ev = metricsEvent({ input: 100 });
  assert.deepEqual(ev.tokens, { input: 100 });
  assert.equal(ev.costUsd, undefined);
  assert.ok(!("costUsd" in ev), "costUsd should be absent when undefined");
});

test("metricsEvent with empty object produces empty tokens", () => {
  const ev = metricsEvent({});
  assert.equal(ev.kind, "metrics");
  assert.deepEqual(ev.tokens, {});
});

test("RUN_EVENT_KINDS contains all 7 kinds", () => {
  assert.ok(RUN_EVENT_KINDS.includes("message"));
  assert.ok(RUN_EVENT_KINDS.includes("done"));
  assert.ok(RUN_EVENT_KINDS.includes("metrics"));
  assert.ok(RUN_EVENT_KINDS.includes("command"));
  assert.ok(RUN_EVENT_KINDS.includes("file_written"));
  assert.ok(RUN_EVENT_KINDS.includes("tool_use"));
  assert.ok(RUN_EVENT_KINDS.includes("tool_result"));
  assert.equal(RUN_EVENT_KINDS.length, 7);
});

// ===== M6-1: 证据链事件 =====

test("commandEvent with exitCode", () => {
  const ev = commandEvent("npm test", 0);
  assert.deepEqual(ev, { kind: "command", command: "npm test", exitCode: 0 });
});

test("commandEvent omits exitCode when undefined", () => {
  const ev = commandEvent("echo hi");
  assert.deepEqual(ev, { kind: "command", command: "echo hi" });
  assert.ok(!("exitCode" in ev), "exitCode should be absent when undefined");
});

test("commandEvent can carry toolCallId for later tool_result correlation", () => {
  const ev = commandEvent("node --version", undefined, { toolCallId: "call_1" });
  assert.deepEqual(ev, { kind: "command", command: "node --version", toolCallId: "call_1" });
});

test("commandEvent with non-zero exitCode", () => {
  const ev = commandEvent("npm test", 1);
  assert.equal(ev.exitCode, 1);
});

test("fileWrittenEvent shape", () => {
  const ev = fileWrittenEvent("src/result.js");
  assert.deepEqual(ev, { kind: "file_written", path: "src/result.js" });
});

test("toolUseEvent shape", () => {
  const ev = toolUseEvent("Grep", { pattern: "TODO" });
  assert.deepEqual(ev, { kind: "tool_use", tool: "Grep", input: { pattern: "TODO" } });
});

test("toolResultEvent with isError true", () => {
  const ev = toolResultEvent("Bash", "command not found", true);
  assert.deepEqual(ev, {
    kind: "tool_result",
    tool: "Bash",
    output: "command not found",
    isError: true,
  });
});

test("toolResultEvent with isError false", () => {
  const ev = toolResultEvent("Write", "ok", false);
  assert.equal(ev.isError, false);
});

test("toolResultEvent rejects missing isError", () => {
  assert.throws(() => toolResultEvent("Bash", "out"), /isError/);
  assert.throws(() => toolResultEvent("Bash", "out", undefined), /isError/);
  assert.throws(() => toolResultEvent("Bash", "out", "yes"), /isError/);
});
