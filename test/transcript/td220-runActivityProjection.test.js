import { test } from "node:test";
import assert from "node:assert/strict";
import { projectRunActivity, ENVELOPE_ACTIVITY_LABELS } from "../../src/application/runActivityProjection.js";
import { withInferredCommandExitCode } from "../../src/scorecard.js";

const runId = "run_td220";
const ts = "2026-10-07T00:00:00Z";
function project(items, opts = {}) {
  const events = items.map((e, i) => ({ runId, ts, seq: i + 1, type: "run.event", ...e }));
  return projectRunActivity({ events, backend: "claude-code", state: "running" }, {
    runId, pageSize: 50, env: {}, ...opts,
  });
}

test("TD-220: wire wins; inferred success/failure; unresolved commands omit source and raw data", () => {
  const r = project([
    { kind: "command", exitCode: 0, toolCallId: "wire", command: "SECRET" },
    { kind: "command", exitCode: 7 },
    { kind: "command", toolCallId: "ok", exitCode: undefined },
    { kind: "command", toolCallId: "failed" },
    { kind: "command", toolCallId: "missing" },
    { kind: "tool_result", tool: "wire", isError: true },
    { kind: "tool_result", tool: "ok", isError: false },
    { kind: "tool_result", tool: "failed", isError: true },
  ], { categories: ["command"] });
  assert.deepEqual(r.entries.map((e) => [e.exitStatus, e.exitStatusSource]), [
    ["ok", "wire"], ["failed", "wire"], ["ok", "inferred"], ["failed", "inferred"], ["unknown", undefined],
  ]);
  for (const e of r.entries) {
    assert.deepEqual(Object.keys(e).sort(), ["category", "exitStatus", ...(e.exitStatusSource ? ["exitStatusSource"] : []), "seq", "ts"]);
  }
  assert.equal(r.counts.tool_result, 0, "pre-scan includes results outside the category filter");
});

test("TD-220: inference matches scorecard first-result semantics and requires a boolean result", () => {
  for (const results of [[{ isError: "false" }], [{ isError: false }, { isError: true }],
    [{ isError: true }, { isError: false }], [{}, { isError: false }]]) {
    const command = { kind: "command", toolCallId: "id" };
    const toolResults = results.map((r) => ({ kind: "tool_result", tool: "id", ...r }));
    const inferred = withInferredCommandExitCode(command, toolResults);
    const entry = project([command, ...toolResults], { categories: ["command"] }).entries[0];
    assert.equal(entry.exitStatus, inferred.exitCode === 0 ? "ok" : inferred.exitCode === 1 ? "failed" : "unknown");
    assert.equal(Object.hasOwn(entry, "exitStatusSource"), inferred.exitCode !== undefined);
  }
  assert.equal(project([{ kind: "command" }]).entries[0].exitStatus, "unknown");
});

test("TD-220: cursor replay ignores appended results outside the frozen window; fresh window can infer", () => {
  const items = [{ kind: "thinking" }, { kind: "command", toolCallId: "later" }];
  const first = project(items, { pageSize: 1 });
  const grown = [...items, { kind: "tool_result", tool: "later", isError: false }];
  const replay = project(grown, { pageSize: 1, cursor: first.nextCursor });
  assert.equal(replay.entries[0].exitStatus, "unknown");
  assert.equal(Object.hasOwn(replay.entries[0], "exitStatusSource"), false);
  const fresh = project(grown, { categories: ["command"], afterSeq: 1 });
  assert.equal(fresh.entries[0].exitStatusSource, "inferred");
});

test("TD-220 验收修: inference gated to proven backends — kimi-web tool_done never becomes exit 0", () => {
  // sol 会审 Q2 实测：kimi run …itm1mx 三条命令曾被全数 inferred。kimiWeb.js 声明
  // 无已证退出码通道（tool done ≠ exit 0）——推断必须只对 ADR-0032 §8 证明过的
  // backend（claude-code）生效；闭集外 exitStatus 如实 unknown（wire 退出码仍直读）。
  const items = [
    { kind: "command", toolCallId: "k1", exitCode: undefined },
    { kind: "tool_result", tool: "k1", isError: false },
    { kind: "command", exitCode: 3 },
  ];
  for (const backend of ["kimi-web", "codex", "zcode", "", undefined]) {
    const r = projectRunActivity(
      { events: items.map((e, i) => ({ runId, ts, seq: i + 1, type: "run.event", ...e })), backend, state: "running" },
      { runId, pageSize: 50, env: {} },
    );
    const commands = r.entries.filter((e) => e.category === "command");
    assert.deepEqual(
      commands.map((e) => [e.exitStatus, e.exitStatusSource]),
      [["unknown", undefined], ["failed", "wire"]],
      `backend=${backend}: 未证通道不得推断（unknown/无 source），wire 退出码照直读`,
    );
  }
  // 闭集内（claude-code）同形状照常推断——防门控误伤。
  const trusted = project(items, { categories: ["command"] });
  assert.deepEqual(
    trusted.entries.map((e) => [e.exitStatus, e.exitStatusSource]),
    [["ok", "inferred"], ["failed", "wire"]],
  );
});

test("TD-220: thinking is count-only; envelope labels fixed; collect audits skipped; unknown remains opaque", () => {
  const types = ["prompt.sent", "run.wait_policy", "run.metrics", "scorecard.checked", "run.stop_verified",
    "run.cleanup_done", "run.session_reuse", "run.provider_session_bound"];
  const labels = ["prompt", "wait_policy", "metrics", "scorecard", "stop_verified",
    "cleanup_done", "session_reuse", "provider_session_bound"];
  assert.deepEqual([...ENVELOPE_ACTIVITY_LABELS], labels);
  const payload = { text: "SECRET", payload: "SECRET", prompt: "SECRET", parts: [{ text: "SECRET" }], kind: "SECRET" };
  for (const audience of ["lead", "owner"]) {
    const r = project([
      { ...payload, kind: "thinking" },
      ...types.map((type) => ({ type, ...payload })),
      { type: "messages.collected", ...payload },
      { type: "unrecognized", ...payload },
      { kind: "future_worker_kind", payload: "SECRET" },
      { type: "toString", ...payload },
    ], { audience });
    assert.deepEqual(r.entries[0], { category: "thinking", ts, seq: 1 });
    assert.deepEqual(r.entries.slice(1, 9).map((e) => e.kind), labels);
    for (const e of r.entries.slice(1, 9)) assert.deepEqual(Object.keys(e).sort(), ["category", "kind", "seq", "ts"]);
    assert.equal(r.counts.thinking, 1);
    assert.equal(r.counts.envelope, 8);
    assert.equal(r.counts.other, 3);
    assert.equal(r.total, 12);
    assert.equal(JSON.stringify(r).includes("SECRET"), false);
    for (const e of r.entries.slice(9)) assert.equal(e.label, "[unknown_event]");
  }
});
