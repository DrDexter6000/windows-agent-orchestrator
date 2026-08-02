// test/mcpRunAwaitResult.test.js
//
// M12-3 Package A CORRECTION: run_await_result MCP adapter — TDD RED→GREEN.
//
// The MCP tool wraps the read-only composite service runAwaitResult. It:
//   - is read-only + idempotent, workspace-bound, openWorldHint:false (snapshot-only),
//   - accepts runId + optional waitMs (0..270000, default 270000) + optional afterSeq,
//   - returns a partitioned payload: run observation (terminal/liveness/cursor/
//     observationOutcome) + independent result partition,
//   - carries a mandatory observationOutcome closed-set field distinguishing a
//     clean read from a transcript read failure,
//   - reports NULL (not fabricated) result fields when nothing was collected,
//   - collapses ANY failure to a fixed safe text (no path/prompt/command/
//     session/PID/secret leak),
//   - throttles notifications/progress at a 30000 ms default INDEPENDENT of the
//     internal poll interval (provable upper bound via real MCP transport),
//   - never appends messages.collected (unlike run_collect).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { createWaoMcpServer } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CompatibilityCallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// ===== Helpers =====

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

function jl(obj) { return JSON.stringify(obj) + "\n"; }

function seedTranscript(runDir, runId, { agentId = "coder_low", messages = [], terminal = false, workspaceCwd } = {}) {
  mkdirSync(runDir, { recursive: true });
  const lines = [
    jl({ type: "run.submitted", agentId, ts: "2026-07-28T00:00:00.000Z", runId }),
    jl({ type: "session.created", backend: "process", backendSessionId: "proc_await", runId, agentId }),
    jl({ type: "run.started", backend: "claude-code", ts: "2026-07-28T00:00:01.000Z", runId, agentId }),
    jl({ type: "run.background_submitted", background: true, cwd: workspaceCwd, runId, agentId }),
    jl({ type: "run.state_change", to: "pending", reason: "created", ts: "2026-07-28T00:00:02.000Z", runId, agentId }),
    jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-07-28T00:00:03.000Z", runId, agentId }),
  ];
  for (const [i, text] of messages.entries()) {
    lines.push(jl({
      type: "run.event", kind: "message", role: "assistant",
      parts: [{ type: "text", text }], ts: `2026-07-28T00:00:${10 + i}.000Z`, runId, agentId,
    }));
  }
  if (terminal) {
    lines.push(jl({ type: "run.completed", ts: "2026-07-28T00:10:00.000Z", runId, agentId }));
    lines.push(jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-28T00:10:01.000Z", runId, agentId }));
  }
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join(""), "utf8");
}

function countAudits(transcriptPath) {
  try {
    return readFileSync(transcriptPath, "utf8").trim().split("\n")
      .filter((l) => l.includes('"messages.collected"')).length;
  } catch { return 0; }
}

async function buildClient(server) {
  const [c1, s1] = InMemoryTransport.createLinkedPair();
  await server.connect(s1);
  const client = new Client({ name: "test", version: "0" }, { version: "0" });
  await client.connect(c1);
  return client;
}

// A service wrapper that drives the REAL composite with a fake clock so a long
// waitMs completes instantly. The default progress interval (30000) is NOT
// overridden. Application tests prove it is independent from poll cadence;
// this transport fixture keeps one poll per interval so notification delivery,
// rather than repeated transcript I/O, is the causal subject.
function fakeClockService() {
  let clock = 1000000;
  return {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fn: async (input) => {
      const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
      return runAwaitResult({
        ...input,
        nowFn: () => clock,
        sleepFn: async (ms) => { clock += ms; },
        pollIntervalMs: 30000,
      });
    },
  };
}

// =====================================================================
// Discovery + annotations + schema.
// =====================================================================

test("MAR-01: tool discoverable; read-only/idempotent/openWorldHint:false annotations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mar01-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((x) => x.name === "run_await_result");
      assert.ok(t, "run_await_result discoverable");
      assert.equal(t.annotations.readOnlyHint, true);
      assert.equal(t.annotations.destructiveHint, false);
      assert.equal(t.annotations.idempotentHint, true);
      // Snapshot-only: no network I/O → openWorldHint:false is accurate.
      assert.equal(t.annotations.openWorldHint, false, "snapshot-only → openWorld stays false");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MAR-02: input schema — runId required, waitMs default+max 270000 min 0, afterSeq optional, strict", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mar02-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((x) => x.name === "run_await_result");
      const props = t.inputSchema.properties ?? {};
      assert.deepEqual(Object.keys(props).sort(), ["afterSeq", "runId", "waitMs"].sort());
      assert.equal(t.inputSchema.additionalProperties, false, "strict input");
      assert.equal(props.waitMs.default, 270000, "default 270000");
      assert.equal(props.waitMs.maximum, 270000, "max 270000");
      assert.equal(props.waitMs.minimum, 0, "min 0 (point-in-time)");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MAR-03: output schema is strict + partitioned; status closed set has NO deferred; observationOutcome closed set; nullable result fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mar03-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((x) => x.name === "run_await_result");
      const props = t.outputSchema.properties ?? {};
      assert.equal(t.outputSchema.additionalProperties, false, "strict output");
      // Mandatory observation closed-set field.
      assert.ok(props.observationOutcome, "output has observationOutcome");
      assert.deepEqual([...(props.observationOutcome.enum ?? [])].sort(), ["observed", "read_failure"]);
      for (const k of ["runId", "agentId", "state", "terminal", "cursor", "returnedEarly",
        "waitedMs", "observationOutcome", "liveness", "activityEventCount", "lastActivityKind",
        "ownerHeartbeat", "result"]) {
        assert.ok(props[k], `output has ${k}`);
      }
      const rprops = props.result.properties ?? {};
      // No "deferred": snapshot-only collect is bounded, terminal always collects.
      assert.deepEqual([...(rprops.status.enum ?? [])].sort(),
        ["available", "empty", "not_terminal", "too_large", "unavailable"].sort(),
        "result.status closed set (no deferred)");
      // Unobserved result fields are nullable (truthful null, not fabricated).
      for (const k of ["evidenceCounts", "itemCount", "assistantMessageCount", "backend", "reconstructed"]) {
        const nullable = rprops[k]?.anyOf?.some((s) => s.type === "null")
          || rprops[k]?.nullable === true
          || (Array.isArray(rprops[k]?.type) && rprops[k].type.includes("null"));
        assert.ok(nullable, `result.${k} must be nullable (truthful unobserved)`);
      }
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =====================================================================
// Input validation / fail-closed.
// =====================================================================

test("MAR-04: invalid runId → fixed error, service not called", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mar04-"));
  try {
    makeGitRepo(dir);
    let calls = 0;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      runAwaitResultFn: async () => { calls++; return {}; },
    });
    const client = await buildClient(server);
    try {
      await client.callTool({ name: "run_await_result", arguments: { runId: "../escape", waitMs: 0 } });
    } catch { /* may throw or isError */ }
    finally { await client.close(); await server.close(); }
    assert.equal(calls, 0, "service must not run for invalid runId");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MAR-05: extra args rejected (strict input)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mar05-"));
  try {
    makeGitRepo(dir);
    let calls = 0;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      runAwaitResultFn: async () => { calls++; return {}; },
    });
    const client = await buildClient(server);
    try {
      await client.callTool({ name: "run_await_result", arguments: { runId: "run_x", evil: true } });
    } catch { /* zod rejects */ }
    finally { await client.close(); await server.close(); }
    assert.equal(calls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MAR-06: waitMs bounds — >270000 rejected; 0 accepted (point-in-time)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mar06-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-mar06-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_x", { workspaceCwd: dir, messages: [], terminal: false });
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      // waitMs > 270000 must not succeed (zod rejects the input pre-handler).
      let oobFailed = false;
      try {
        const res = await client.callTool({ name: "run_await_result", arguments: { runId: "run_x", waitMs: 270001 } });
        if (res?.isError || !res?.structuredContent) oobFailed = true;
      } catch { oobFailed = true; }
      assert.ok(oobFailed, "waitMs > 270000 must not succeed");

      // waitMs=0 must be accepted and reach the real service end-to-end.
      const res = await client.callTool({ name: "run_await_result", arguments: { runId: "run_x", waitMs: 0 } });
      assert.equal(res.isError, undefined, "waitMs=0 accepted");
      assert.equal(res.structuredContent.result.status, "not_terminal");
      assert.equal(res.structuredContent.observationOutcome, "observed");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// =====================================================================
// Integration: terminal compact via real service, ZERO audit append.
// =====================================================================

test("MAR-07: terminal → compact result via real service, ZERO audit (read-only vs run_collect)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mar07-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-mar07-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_int", { workspaceCwd: dir, messages: ["draft", "FINAL"], terminal: true });
    const tp = join(runDir, "run_int.jsonl");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_await_result", arguments: { runId: "run_int", waitMs: 0 } });
      assert.equal(res.isError, undefined);
      const parsed = res.structuredContent;
      assert.equal(parsed.terminal, true);
      assert.equal(parsed.observationOutcome, "observed");
      assert.equal(parsed.result.status, "available");
      assert.deepEqual(parsed.result.messages, [{ role: "assistant", text: "FINAL", truncated: false }]);
      assert.equal(parsed.result.assistantMessageCount, 2);
      assert.equal(countAudits(tp), 0, "run_await_result must NOT append messages.collected");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("MAR-08: non-terminal → not_terminal with NULL unobserved result fields (point-in-time)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mar08-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-mar08-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_nt", { workspaceCwd: dir, messages: [], terminal: false });
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_await_result", arguments: { runId: "run_nt", waitMs: 0 } });
      const parsed = res.structuredContent;
      assert.equal(parsed.terminal, false);
      assert.equal(parsed.observationOutcome, "observed");
      assert.equal(parsed.result.status, "not_terminal");
      assert.equal(parsed.result.evidenceCounts, null);
      assert.equal(parsed.result.itemCount, null);
      assert.equal(parsed.result.assistantMessageCount, null);
      assert.equal(parsed.result.reconstructed, null);
      assert.equal(parsed.result.backend, null);
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// =====================================================================
// Error containment / no leak.
// =====================================================================

test("MAR-09: malformed service result → fixed safe text, no SDK leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mar09-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      runAwaitResultFn: async () => ({ garbage: true }),
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_await_result", arguments: { runId: "run_x", waitMs: 0 } });
      const dumped = JSON.stringify(res);
      assert.ok(dumped.includes("run_await_result failed"), "fixed safe text");
      assert.ok(!dumped.includes("Expected") && !dumped.includes("invalid_enum") && !dumped.includes("Received"),
        "no zod validation leak");
      assert.ok(!res.structuredContent, "no partial structuredContent");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MAR-10: malicious transcript payload → no secret/path/command/session leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mar10-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-mar10-rd-"));
  try {
    makeGitRepo(dir);
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const a = "coder_low", id = "run_leak";
    const lines = [
      jl({ type: "run.submitted", agentId: a, ts: "2026-07-28T00:00:00.000Z", runId: id }),
      jl({ type: "session.created", backend: "process", backendSessionId: "proc_await_4242", runId: id, agentId: a }),
      jl({ type: "run.background_submitted", background: true, cwd: dir, runId: id, agentId: a }),
      jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-07-28T00:00:03.000Z", runId: id, agentId: a }),
      jl({ type: "run.event", kind: "command", command: `rm -rf / && cat ${secret}`, exitCode: 0, runId: id, agentId: a }),
      jl({ type: "run.event", kind: "tool_use", tool: "Bash", input: { cmd: `/bin/sh -c 'leak ${secret}'` }, runId: id, agentId: a }),
      jl({ type: "run.event", kind: "file_written", path: "C:\\Users\\secret\\key.pem", runId: id, agentId: a }),
      jl({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "Done: result is 42." }], ts: "2026-07-28T00:00:10.000Z", runId: id, agentId: a }),
      jl({ type: "run.completed", ts: "2026-07-28T00:10:00.000Z", runId: id, agentId: a }),
      jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-28T00:10:01.000Z", runId: id, agentId: a }),
    ];
    writeFileSync(join(runDir, `${id}.jsonl`), lines.join(""), "utf8");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_await_result", arguments: { runId: id, waitMs: 0 } });
      assert.equal(res.isError, undefined, "call must succeed (benign assistant text)");
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes(secret), "no secret");
      assert.ok(!dumped.toLowerCase().includes("c:\\\\users\\\\secret"), "no windows path");
      assert.ok(!dumped.includes("/bin/sh"), "no posix path / command");
      assert.ok(!dumped.includes("4242"), "no PID/session id");
      assert.ok(!dumped.includes("rm -rf"), "no command string");
      assert.ok(!dumped.includes("proc_await"), "no backend session id");
      assert.ok(dumped.includes("Done: result is 42."), "benign assistant text is returned");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("MAR-11: cross-workspace → fixed error (workspace-bound)", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-mar11a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-mar11b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-mar11-rd-"));
  try {
    makeGitRepo(dirA); makeGitRepo(dirB);
    seedTranscript(runDir, "run_xws", { workspaceCwd: dirA, messages: [], terminal: false });
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dirB });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_await_result", arguments: { runId: "run_xws", waitMs: 0 } });
      const dumped = JSON.stringify(res);
      assert.ok(dumped.includes("run_await_result failed"), "fixed safe text on cross-workspace");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// =====================================================================
// Progress keepalive — 30000 ms DEFAULT throttle bound via REAL MCP transport.
// The bound is INDEPENDENT of the internal poll interval. Opt-in: no
// progressToken → zero notifications. Terminal still returns early.
// =====================================================================

test("MAR-12: default 30s progress bound via real transport — notifications ≤ floor(waitMs/30000)+1, opt-in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mar12-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-mar12-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_ka", { workspaceCwd: dir, messages: [], terminal: false });
    const fc = fakeClockService();
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir, workspaceRoot: dir,
      runAwaitResultFn: fc.fn,
    });
    const client = await buildClient(server);
    try {
      let progressCb = 0;
      let rejected = false; let rejectErr = null;
      const WAIT = 90000;
      try {
        await client.callTool(
          { name: "run_await_result", arguments: { runId: "run_ka", waitMs: WAIT } },
          CompatibilityCallToolResultSchema,
          { timeout: 5000, resetTimeoutOnProgress: true, onprogress: () => { progressCb++; } },
        );
      } catch (e) { rejected = true; rejectErr = e; }
      assert.equal(rejected, false, `must not reject; got ${rejectErr?.message ?? ""}`);
      const bound = Math.floor(WAIT / 30000) + 1; // default progress 30000 → bound = 4
      assert.ok(progressCb > 0, "onprogress must fire at least once (throttled, opt-in)");
      assert.ok(progressCb <= bound,
        `progress bound violated via real transport: ${progressCb} > ${bound}`);
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("MAR-13: no progressToken → zero notifications (standard opt-in)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mar13-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-mar13-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_nopr", { workspaceCwd: dir, messages: [], terminal: false });
    const fc = fakeClockService();
    const notifications = [];
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir, workspaceRoot: dir,
      runAwaitResultFn: fc.fn,
    });
    const [c1, s1] = InMemoryTransport.createLinkedPair();
    const origSend = s1.send.bind(s1);
    s1.send = async (msg, opts) => {
      try {
        const parsed = typeof msg === "string" ? JSON.parse(msg) : msg;
        if (parsed && parsed.method === "notifications/progress") notifications.push(parsed);
      } catch { /* ignore */ }
      return origSend(msg, opts);
    };
    await server.connect(s1);
    const client = new Client({ name: "test", version: "0" }, { version: "0" });
    await client.connect(c1);
    try {
      // NO onprogress → no progressToken → server must NOT emit.
      await client.callTool({ name: "run_await_result", arguments: { runId: "run_nopr", waitMs: 30000 } });
    } finally { await client.close(); await server.close(); }
    assert.equal(notifications.length, 0, "no progress notifications when client did not request them");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// =====================================================================
// Idempotency / read-only repeat.
// =====================================================================

test("MAR-14: repeated terminal calls append ZERO audits (idempotent read-only)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mar14-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-mar14-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_idem", { workspaceCwd: dir, messages: ["final"], terminal: true });
    const tp = join(runDir, "run_idem.jsonl");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      await client.callTool({ name: "run_await_result", arguments: { runId: "run_idem", waitMs: 0 } });
      await client.callTool({ name: "run_await_result", arguments: { runId: "run_idem", waitMs: 0 } });
    } finally { await client.close(); await server.close(); }
    assert.equal(countAudits(tp), 0, "two terminal calls → zero audit appends");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("MAR-15: current tool count is 22 after run_continue + run_activity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mar15-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      assert.ok(tools.tools.find((x) => x.name === "run_await_result"), "run_await_result present");
      assert.equal(tools.tools.length, 22, "exactly 22 tools after M12-7 run_continue + M12-8 run_activity");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =====================================================================
// M12-6: non-usable transcript events (null/primitive/array) via the REAL MCP
// client. Historical JSONL may contain JSON-valid but non-usable entries; the
// composite reduces the snapshot to usable events and returns a STRUCTURED
// read_failure — it must NOT collapse to the fixed "run_await_result failed"
// text (which only happens when the service throws an uncaught TypeError). No
// raw event content or error detail is leaked.
// =====================================================================

test("MAR-16: null/primitive/array transcript → structured read_failure via real client, no leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mar16-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-mar16-rd-"));
  try {
    makeGitRepo(dir);
    const secret = "AKIAIOSFODNN7EXAMPLE"; // AWS docs example, not a live key
    const a = "coder_low", id = "run_shape";
    const lines = [
      jl({ type: "run.submitted", agentId: a, ts: "2026-07-28T00:00:00.000Z", runId: id }),
      jl({ type: "session.created", backend: "process", backendSessionId: "proc_await", runId: id, agentId: a }),
      jl({ type: "run.background_submitted", background: true, cwd: dir, runId: id, agentId: a }),
      jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-07-28T00:00:03.000Z", runId: id, agentId: a }),
      jl({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: `leak ${secret} now` }], ts: "2026-07-28T00:00:10.000Z", runId: id, agentId: a }),
      // JSON-valid but non-usable entries — the root cause of the reference crash.
      "null\n",
      "42\n",
      "[1,2,3]\n",
    ];
    writeFileSync(join(runDir, `${id}.jsonl`), lines.join(""), "utf8");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_await_result", arguments: { runId: id, waitMs: 0 } });
      const parsed = res.structuredContent;
      assert.ok(parsed, "structured read_failure returned (NOT the fixed error text)");
      assert.equal(res.isError, undefined, "not an error response — no TypeError escaped the service");
      assert.equal(parsed.observationOutcome, "read_failure");
      assert.equal(parsed.result.status, "unavailable");
      assert.deepEqual(parsed.result.messages, []);
      assert.equal(parsed.runId, id, "trusted runId preserved");
      assert.equal(parsed.state, "running", "durable state preserved from the usable subset");
      assert.equal(parsed.terminal, false);
      assert.equal(parsed.cursor, null, "cursor nulled (untrusted on a corrupt snapshot)");
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes("run_await_result failed"),
        "no top-level failure text — the service did not throw");
      assert.ok(!dumped.includes(secret), "no secret leak — collect never ran on the corrupt snapshot");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});
