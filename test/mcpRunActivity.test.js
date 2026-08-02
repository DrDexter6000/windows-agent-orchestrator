// test/mcpRunActivity.test.js
//
// M12-8 Package A — run_activity MCP adapter (TDD RED→GREEN).
//
// run_activity is the bounded Lead-view MCP tool over the shared read-only
// activity projector. It is workspace-bound, read-only, idempotent,
// openWorldHint:false (single snapshot, zero append). It exposes ONLY closed-set
// safe activity facts and NEVER raw command text / tool payload / error text /
// credentials / PID/session / absolute path / unknown payload, and it makes NO
// semantic summary/recommendation/progress estimate.
//
// Covers matrix item #13 (strict MCP output schema + caps) end-to-end via a
// real MCP transport, plus workspace binding (#12), zero append (#14), cursor
// continuity (#3/#4), and no-leak (#10) at the MCP boundary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { createWaoMcpServer } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ACTIVITY_CATEGORIES,
  LEAD_PAGE_HARD_CAP,
  LEAD_TEXT_EXCERPT_CAP,
  ACTIVITY_ROLE_CAP,
  ACTIVITY_LABEL_CAP,
  ACTIVITY_TOOL_NAME_CAP,
  ACTIVITY_PATH_CAP,
  ACTIVITY_TS_CAP,
  ACTIVITY_CURSOR_MAX_CHARS,
} from "../src/application/runActivityProjection.js";

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

function seedTranscript(runDir, runId, {
  agentId = "coder_low", messages = [], terminal = false, workspaceCwd, extraEvents = [],
} = {}) {
  mkdirSync(runDir, { recursive: true });
  const lines = [
    jl({ type: "run.submitted", agentId, ts: "2026-08-02T00:00:00.000Z", runId }),
    jl({ type: "session.created", backend: "process", backendSessionId: "proc_act", runId, agentId }),
    jl({ type: "run.started", backend: "claude-code", ts: "2026-08-02T00:00:01.000Z", runId, agentId }),
    jl({ type: "run.background_submitted", background: true, cwd: workspaceCwd, runId, agentId }),
    jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-08-02T00:00:02.000Z", runId, agentId }),
  ];
  for (const [i, text] of messages.entries()) {
    lines.push(jl({
      type: "run.event", kind: "message", role: "assistant",
      parts: [{ type: "text", text }], ts: `2026-08-02T00:00:${10 + i}.000Z`, runId, agentId,
    }));
  }
  for (const e of extraEvents) lines.push(jl(e));
  if (terminal) {
    lines.push(jl({ type: "run.completed", ts: "2026-08-02T00:10:00.000Z", runId, agentId }));
    lines.push(jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-08-02T00:10:01.000Z", runId, agentId }));
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

// =====================================================================
// #13a Discovery + annotations.
// =====================================================================
test("MAA-01: tool discoverable; read-only/idempotent/openWorldHint:false annotations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-maa01-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((x) => x.name === "run_activity");
      assert.ok(t, "run_activity discoverable");
      assert.equal(t.annotations.readOnlyHint, true);
      assert.equal(t.annotations.destructiveHint, false);
      assert.equal(t.annotations.idempotentHint, true);
      assert.equal(t.annotations.openWorldHint, false, "single snapshot, no network I/O");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =====================================================================
// #13b Input schema — runId required; categories/afterSeq/cursor/pageSize; strict.
// =====================================================================
test("MAA-02: input schema — runId required, categories enum, afterSeq int≥0, pageSize int, cursor string; strict", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-maa02-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((x) => x.name === "run_activity");
      const props = t.inputSchema.properties ?? {};
      assert.equal(t.inputSchema.additionalProperties, false, "strict input");
      assert.ok(props.runId, "runId present");
      assert.ok(props.categories, "categories present");
      assert.ok(props.afterSeq, "afterSeq present");
      assert.ok(props.cursor, "cursor present");
      assert.ok(props.pageSize, "pageSize present");
      assert.deepEqual(Object.keys(props).sort(), ["afterSeq", "categories", "cursor", "pageSize", "runId"].sort());
      // categories is a closed set matching ACTIVITY_CATEGORIES.
      const catEnum = props.categories.items?.enum ?? props.categories.enum ?? [];
      assert.deepEqual([...catEnum].sort(),
        ["command", "file_written", "message", "other", "state", "tool_result", "tool_use"].sort(),
        "categories closed set");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =====================================================================
// #13c Output schema strict; entries discriminated by category; NO raw-payload
// fields (no command/input/output/error); counts closed set.
// =====================================================================
test("MAA-03: output schema strict; entries discriminated by category; counts closed set; no raw payload fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-maa03-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((x) => x.name === "run_activity");
      const props = t.outputSchema.properties ?? {};
      assert.equal(t.outputSchema.additionalProperties, false, "strict output");
      for (const k of ["runId", "agentId", "backend", "state", "terminal", "counts", "total", "entries", "pageSize", "truncated", "nextCursor"]) {
        assert.ok(props[k], `output has ${k}`);
      }
      // counts covers exactly the 7 closed-set categories.
      assert.deepEqual(Object.keys(props.counts.properties ?? {}).sort(),
        ["command", "file_written", "message", "other", "state", "tool_result", "tool_use"].sort());
      // entries is a discriminated union on `category` (serialized under items.anyOf).
      const entryItems = props.entries.items ?? props.entries;
      const members = entryItems.oneOf ?? entryItems.anyOf ?? [];
      const cats = members.map((m) => m.properties?.category?.const ?? m.properties?.category?.enum?.[0]).filter(Boolean);
      assert.deepEqual([...cats].sort(),
        ["command", "file_written", "message", "other", "state", "tool_result", "tool_use"].sort(),
        "entry variants cover the closed-set categories");
      // Flatten every field name appearing across entry variants: NONE may be a
      // raw payload channel (command/input/output/error/payload/path-absolute).
      const allEntryFields = new Set();
      for (const m of members) for (const f of Object.keys(m.properties ?? {})) allEntryFields.add(f);
      for (const forbidden of ["input", "output", "error", "payload", "command", "exitCode", "callId"]) {
        assert.ok(!allEntryFields.has(forbidden), `entries must not expose raw field '${forbidden}'`);
      }
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =====================================================================
// #13d Input validation — invalid runId, extra args, bad pageSize all rejected
// before the service runs.
// =====================================================================
test("MAA-04: invalid runId → service not called", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-maa04-"));
  try {
    makeGitRepo(dir);
    let calls = 0;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      readRunActivityFn: async () => { calls++; return { events: [], agentId: "unknown", backend: "process", state: "running", terminal: false }; },
    });
    const client = await buildClient(server);
    try {
      await client.callTool({ name: "run_activity", arguments: { runId: "../escape" } });
    } catch { /* may throw */ }
    finally { await client.close(); await server.close(); }
    assert.equal(calls, 0, "service must not run for invalid runId");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MAA-05: extra args rejected (strict input)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-maa05-"));
  try {
    makeGitRepo(dir);
    let calls = 0;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      readRunActivityFn: async () => { calls++; return { events: [], agentId: "unknown", backend: "process", state: "running", terminal: false }; },
    });
    const client = await buildClient(server);
    try {
      await client.callTool({ name: "run_activity", arguments: { runId: "run_x", evil: true } });
    } catch { /* zod rejects */ }
    finally { await client.close(); await server.close(); }
    assert.equal(calls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MAA-06: pageSize bounds — 0 rejected, over hard cap rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-maa06-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-maa06-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_x", { workspaceCwd: dir, messages: ["a"], terminal: true });
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((x) => x.name === "run_activity");
      const ps = t.inputSchema.properties.pageSize;
      // Tightened: EXACT caps, not >=1 (the wire schema must match the
      // projector's LEAD_PAGE_HARD_CAP exactly — no drift).
      assert.equal(ps.minimum, 1, "pageSize min exactly 1");
      assert.equal(ps.maximum, LEAD_PAGE_HARD_CAP, "pageSize max exactly the projector hard cap");
      // pageSize=0 must be rejected pre-handler.
      let zeroRejected = false;
      try {
        const res = await client.callTool({ name: "run_activity", arguments: { runId: "run_x", pageSize: 0 } });
        if (res?.isError || !res?.structuredContent) zeroRejected = true;
      } catch { zeroRejected = true; }
      assert.ok(zeroRejected, "pageSize=0 rejected");
      // over the hard cap rejected.
      let overRejected = false;
      try {
        const res = await client.callTool({ name: "run_activity", arguments: { runId: "run_x", pageSize: ps.maximum + 5 } });
        if (res?.isError || !res?.structuredContent) overRejected = true;
      } catch { overRejected = true; }
      assert.ok(overRejected, "pageSize over hard cap rejected");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("MAA-17: duplicate categories rejected at the wire (at most one per category)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-maa17-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-maa17-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_x", { workspaceCwd: dir, messages: ["a"], terminal: true });
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      let rejected = false;
      try {
        const res = await client.callTool({ name: "run_activity", arguments: { runId: "run_x", categories: ["message", "message"] } });
        if (res?.isError || !res?.structuredContent) rejected = true;
      } catch { rejected = true; }
      assert.ok(rejected, "duplicate categories rejected pre-handler");
      // positive control: a single category still returns structured entries.
      const ok = await client.callTool({ name: "run_activity", arguments: { runId: "run_x", categories: ["message"] } });
      assert.equal(ok.isError, undefined, "single category accepted");
      assert.ok(Array.isArray(ok.structuredContent?.entries));
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// =====================================================================
// #3/#14 Integration: full ordered chain via cursor replay, real service, zero append.
// =====================================================================
test("MAA-07: terminal run → ordered activity + cursor replay walks the whole chain; zero audit append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-maa07-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-maa07-rd-"));
  try {
    makeGitRepo(dir);
    const msgs = Array.from({ length: 25 }, (_, i) => `m${i}`);
    seedTranscript(runDir, "run_int", { workspaceCwd: dir, messages: msgs, terminal: true });
    const tp = join(runDir, "run_int.jsonl");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const collected = [];
      let cursor = null;
      let guard = 0;
      while (true) {
        const res = await client.callTool({
          name: "run_activity",
          arguments: { runId: "run_int", pageSize: 10, ...(cursor ? { cursor } : {}) },
        });
        assert.equal(res.isError, undefined, `page ok (cursor=${cursor})`);
        const parsed = res.structuredContent;
        assert.equal(parsed.runId, "run_int");
        assert.equal(parsed.terminal, true);
        collected.push(...parsed.entries);
        cursor = parsed.nextCursor;
        if (!cursor) break;
        guard += 1;
        if (guard > 10) throw new Error("runaway pagination");
      }
      // reconstructed all 25 assistant texts in order + the terminal state entry.
      const texts = collected.filter((e) => e.category === "message").map((e) => e.text);
      assert.equal(texts.length, 25);
      for (let i = 0; i < 25; i += 1) assert.equal(texts[i], `m${i}`, `msg ${i} in order`);
      assert.ok(collected.some((e) => e.category === "state" && e.to === "completed"), "terminal state entry present");
      assert.equal(countAudits(tp), 0, "run_activity appends ZERO audits");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// =====================================================================
// #12 Workspace-bound: cross-workspace → fixed error, no leak.
// =====================================================================
test("MAA-08: cross-workspace → fixed error text, no leak", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-maa08a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-maa08b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-maa08-rd-"));
  try {
    makeGitRepo(dirA); makeGitRepo(dirB);
    seedTranscript(runDir, "run_xws", { workspaceCwd: dirA, messages: [], terminal: false });
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dirB });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_activity", arguments: { runId: "run_xws" } });
      const dumped = JSON.stringify(res);
      assert.ok(dumped.includes("run_activity failed"), "fixed safe text on cross-workspace");
      assert.ok(!res.structuredContent, "no partial structuredContent");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// =====================================================================
// Error containment: malformed service result → fixed safe text, no leak.
// =====================================================================
test("MAA-09: malformed service result → fixed safe text, no SDK leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-maa09-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      readRunActivityFn: async () => ({ garbage: true }),
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_activity", arguments: { runId: "run_x" } });
      const dumped = JSON.stringify(res);
      assert.ok(dumped.includes("run_activity failed"), "fixed safe text");
      assert.ok(!dumped.includes("Expected") && !dumped.includes("invalid_enum") && !dumped.includes("Received"), "no zod leak");
      assert.ok(!res.structuredContent, "no partial structuredContent");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =====================================================================
// #10 No-leak: malicious transcript → no secret/path/command/session leak.
// =====================================================================
test("MAA-10: malicious transcript → no secret/path/command/session leak across MCP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-maa10-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-maa10-rd-"));
  try {
    makeGitRepo(dir);
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const a = "coder_low", id = "run_leak";
    const lines = [
      jl({ type: "run.submitted", agentId: a, ts: "2026-08-02T00:00:00.000Z", runId: id }),
      jl({ type: "session.created", backend: "process", backendSessionId: "proc_act_4242", runId: id, agentId: a }),
      jl({ type: "run.background_submitted", background: true, cwd: dir, runId: id, agentId: a }),
      jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-08-02T00:00:02.000Z", runId: id, agentId: a }),
      jl({ type: "run.event", kind: "command", command: `rm -rf / && cat ${secret}`, exitCode: 0, runId: id, agentId: a }),
      jl({ type: "run.event", kind: "tool_use", tool: "Bash", input: { cmd: `/bin/sh -c 'leak ${secret}'` }, runId: id, agentId: a }),
      jl({ type: "run.event", kind: "file_written", path: "C:\\Users\\secret\\key.pem", runId: id, agentId: a }),
      jl({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "Done: result is 42." }], ts: "2026-08-02T00:00:10.000Z", runId: id, agentId: a }),
      jl({ type: "run.completed", ts: "2026-08-02T00:10:00.000Z", runId: id, agentId: a }),
      jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-08-02T00:10:01.000Z", runId: id, agentId: a }),
    ];
    writeFileSync(join(runDir, `${id}.jsonl`), lines.join(""), "utf8");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_activity", arguments: { runId: id } });
      assert.equal(res.isError, undefined, "call succeeds (benign assistant text)");
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes(secret), "no secret");
      assert.ok(!dumped.toLowerCase().includes("c:\\\\users\\\\secret"), "no windows path");
      assert.ok(!dumped.includes("/bin/sh"), "no posix path/command");
      assert.ok(!dumped.includes("4242"), "no PID/session id");
      assert.ok(!dumped.includes("rm -rf"), "no command string");
      assert.ok(!dumped.includes("proc_act"), "no backend session id");
      assert.ok(dumped.includes("Done: result is 42."), "benign assistant text returned");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// =====================================================================
// #8 Redaction across MCP: secret in assistant text → [REDACTED].
// =====================================================================
test("MAA-11: secret in assistant text redacted across MCP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-maa11-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-maa11-rd-"));
  try {
    makeGitRepo(dir);
    const secret = "test-secret-maa11";
    seedTranscript(runDir, "run_red", { workspaceCwd: dir, messages: [`result: LEAK=${secret} done`], terminal: true });
    // The MCP redactor reads process.env (same as collect/await) and only
    // redacts env vars whose NAME matches the secret heuristic. Seed a
    // matching name, restore afterward — proves production redaction end-to-end.
    const prev = process.env.MAA11_SECRET;
    process.env.MAA11_SECRET = secret;
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_activity", arguments: { runId: "run_red" } });
      const parsed = res.structuredContent;
      const text = parsed.entries.find((e) => e.category === "message").text;
      assert.ok(!text.includes(secret), "raw secret redacted");
      assert.ok(/\[REDACTED:/.test(text), "redaction marker present");
    } finally {
      await client.close(); await server.close();
      if (prev === undefined) delete process.env.MAA11_SECRET; else process.env.MAA11_SECRET = prev;
    }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// =====================================================================
// #6 Cursor continuity: cross-run / cross-filter cursor rejected → fixed error.
// =====================================================================
test("MAA-12: a cursor bound to a different run is rejected (fixed error)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-maa12-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-maa12-rd-"));
  try {
    makeGitRepo(dir);
    const msgs = Array.from({ length: 25 }, (_, i) => `m${i}`);
    seedTranscript(runDir, "run_A", { workspaceCwd: dir, messages: msgs, terminal: false });
    seedTranscript(runDir, "run_B", { workspaceCwd: dir, messages: msgs, terminal: false });
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const pageA = await client.callTool({ name: "run_activity", arguments: { runId: "run_A", pageSize: 10 } });
      const cursorA = pageA.structuredContent.nextCursor;
      assert.ok(cursorA, "page A has a cursor");
      // reuse run_A's cursor against run_B → must fail closed.
      const res = await client.callTool({ name: "run_activity", arguments: { runId: "run_B", cursor: cursorA } });
      const dumped = JSON.stringify(res);
      assert.ok(dumped.includes("run_activity failed"), "cross-run cursor rejected with fixed text");
      assert.ok(!res.structuredContent, "no partial structuredContent");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// =====================================================================
// Tool count guard: adding run_activity brings the total to 22.
// =====================================================================
test("MAA-13: tool count is 22 after run_activity (was 21)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-maa13-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      assert.ok(tools.tools.find((x) => x.name === "run_activity"), "run_activity present");
      assert.equal(tools.tools.length, 22, "exactly 22 tools after M12-8 run_activity");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =====================================================================
// Exact run binding at the MCP boundary: one mismatched event carrying
// assistant text + a secret fails closed — fixed error text, NO partial
// structuredContent, no text/secret in the raw response dump.
// =====================================================================
test("MAA-14: envelope runId mismatch (assistant text + secret) → fixed error, no leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-maa14-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-maa14-rd-"));
  try {
    makeGitRepo(dir);
    const secret = "test-secret-maa14";
    const a = "coder_low", id = "run_mism";
    const lines = [
      jl({ type: "run.submitted", agentId: a, ts: "2026-08-02T00:00:00.000Z", runId: id }),
      jl({ type: "session.created", backend: "process", backendSessionId: "p", runId: id, agentId: a }),
      jl({ type: "run.background_submitted", background: true, cwd: dir, runId: id, agentId: a }),
      // The mismatched event: assistant text + a secret, envelope runId "run_OTHER".
      jl({
        type: "run.event", kind: "message", role: "assistant",
        parts: [{ type: "text", text: `assistant says ${secret}` }],
        ts: "2026-08-02T00:00:10.000Z", runId: "run_OTHER", agentId: a,
      }),
    ];
    writeFileSync(join(runDir, `${id}.jsonl`), lines.join(""), "utf8");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_activity", arguments: { runId: id } });
      const dumped = JSON.stringify(res);
      assert.ok(dumped.includes("run_activity failed"), "fixed safe error text on envelope mismatch");
      assert.ok(!res.structuredContent, "no partial structuredContent on envelope mismatch");
      assert.ok(!dumped.includes(secret), "secret never crosses");
      assert.ok(!dumped.includes("assistant says"), "mismatched assistant text never crosses");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// =====================================================================
// Uniform dynamic-string safety at the MCP boundary: secrets in tool name /
// backend / role / unknown kind label / relative path are redacted or
// sentineled — the raw secret NEVER crosses a single output field.
// =====================================================================
test("MAA-15: secrets in tool name / backend / role / unknown label / relative path never cross", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-maa15-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-maa15-rd-"));
  try {
    makeGitRepo(dir);
    const secret = "test-secret-maa15";
    const a = "coder_low", id = "run_dyn";
    const lines = [
      jl({ type: "run.submitted", agentId: a, ts: "2026-08-02T00:00:00.000Z", runId: id }),
      // secret inside the BACKEND fact.
      jl({ type: "session.created", backend: "process_" + secret, backendSessionId: "p", runId: id, agentId: a }),
      jl({ type: "run.background_submitted", background: true, cwd: dir, runId: id, agentId: a }),
      jl({ type: "run.state_change", to: "running", reason: "x", ts: "2026-08-02T00:00:02.000Z", runId: id, agentId: a }),
      // secret inside the TOOL NAME.
      jl({ type: "run.event", kind: "tool_use", tool: "Bash_" + secret, input: {}, runId: id, agentId: a }),
      // secret inside a RELATIVE PATH.
      jl({ type: "run.event", kind: "file_written", path: "src/" + secret + "/keep.js", runId: id, agentId: a }),
      // secret inside the ROLE.
      jl({ type: "run.event", kind: "message", role: "assistant_" + secret, parts: [{ type: "text", text: "hi" }], ts: "2026-08-02T00:00:10.000Z", runId: id, agentId: a }),
      // UNKNOWN KIND whose name itself is the secret → must become the fixed
      // sentinel label, never echo the secret as a label.
      jl({ type: "run.event", kind: secret + "_kind", runId: id, agentId: a }),
    ];
    writeFileSync(join(runDir, `${id}.jsonl`), lines.join(""), "utf8");
    const prev = process.env.MAA15_TOKEN;
    process.env.MAA15_TOKEN = secret;
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_activity", arguments: { runId: id } });
      assert.equal(res.isError, undefined, "call succeeds — every dynamic field sanitized");
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes(secret), "raw secret NEVER crosses any output field");
      assert.ok(dumped.includes("[REDACTED"), "redaction markers present");
      assert.ok(dumped.includes("[unknown_event]"), "unknown kind → fixed sentinel label, not the secret");
      const parsed = res.structuredContent;
      assert.ok(parsed.backend.includes("[REDACTED"), "backend redacted in place");
      const tu = parsed.entries.find((e) => e.category === "tool_use");
      assert.ok(tu.tool.includes("[REDACTED"), "tool name redacted in place");
      const fw = parsed.entries.find((e) => e.category === "file_written");
      assert.ok(fw.path.includes("[REDACTED") && fw.path.startsWith("src/"), "relative path redacted in place");
      const msg = parsed.entries.find((e) => e.category === "message");
      assert.ok(msg.role.includes("[REDACTED"), "role redacted in place");
    } finally {
      await client.close(); await server.close();
      if (prev === undefined) delete process.env.MAA15_TOKEN; else process.env.MAA15_TOKEN = prev;
    }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// =====================================================================
// Wire schema parity: every declared bound is EXACTLY the projector constant
// (cursor base64url+256 both directions, categories ≤ closed-set count,
// entries ≤ LEAD_PAGE_HARD_CAP, every dynamic string ≤ its *_CAP, pageSize
// exact [1, LEAD_PAGE_HARD_CAP], message text ≤ LEAD_TEXT_EXCERPT_CAP).
// =====================================================================
test("MAA-16: wire schema declares EXACT caps — cursor, categories, entries, strings, pageSize", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-maa16-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((x) => x.name === "run_activity");
      const input = t.inputSchema.properties;
      // Input cursor: base64url + max ACTIVITY_CURSOR_MAX_CHARS.
      assert.equal(input.cursor.pattern, "^[A-Za-z0-9_-]+$", "input cursor base64url pattern");
      assert.equal(input.cursor.maxLength, ACTIVITY_CURSOR_MAX_CHARS, "input cursor max 256");
      // categories: closed set, at most the closed-set count.
      assert.deepEqual(input.categories.items.enum, [...ACTIVITY_CATEGORIES], "categories enum = closed set");
      assert.equal(input.categories.minItems, 1);
      assert.equal(input.categories.maxItems, ACTIVITY_CATEGORIES.length, "categories max = closed-set count");
      // pageSize exact bounds.
      assert.equal(input.pageSize.minimum, 1);
      assert.equal(input.pageSize.maximum, LEAD_PAGE_HARD_CAP);

      const output = t.outputSchema.properties;
      // Entries per page ≤ LEAD_PAGE_HARD_CAP; pageSize exact.
      assert.equal(output.entries.maxItems, LEAD_PAGE_HARD_CAP, "entries max = LEAD_PAGE_HARD_CAP");
      assert.equal(output.pageSize.maximum, LEAD_PAGE_HARD_CAP, "output pageSize max = LEAD_PAGE_HARD_CAP");
      // nextCursor: base64url + max 256. The SDK serializes nullable as
      // anyOf [{type:string, pattern, maxLength}, {type:null}] — the exact
      // bounds live on the string branch.
      const nextCursorString = output.nextCursor.anyOf?.[0] ?? output.nextCursor;
      assert.equal(nextCursorString.pattern, "^[A-Za-z0-9_-]+$", "nextCursor base64url pattern");
      assert.equal(nextCursorString.maxLength, ACTIVITY_CURSOR_MAX_CHARS, "nextCursor max 256");
      // backend/state bounded by the label cap.
      assert.equal(output.backend.maxLength, ACTIVITY_LABEL_CAP);
      assert.equal(output.state.maxLength, ACTIVITY_LABEL_CAP);
      // Every dynamic string in every entry variant matches its projector cap.
      const members = output.entries.items.oneOf ?? output.entries.items.anyOf ?? [];
      const byCat = {};
      for (const m of members) byCat[m.properties.category.const] = m.properties;
      assert.equal(byCat.message.ts.maxLength, ACTIVITY_TS_CAP);
      assert.equal(byCat.message.role.maxLength, ACTIVITY_ROLE_CAP);
      assert.equal(byCat.message.text.maxLength, LEAD_TEXT_EXCERPT_CAP, "message text max = LEAD_TEXT_EXCERPT_CAP");
      assert.equal(byCat.tool_use.tool.maxLength, ACTIVITY_TOOL_NAME_CAP);
      assert.equal(byCat.file_written.path.maxLength, ACTIVITY_PATH_CAP);
      assert.equal(byCat.state.to.maxLength, ACTIVITY_LABEL_CAP);
      assert.equal(byCat.other.label.maxLength, ACTIVITY_LABEL_CAP);
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
