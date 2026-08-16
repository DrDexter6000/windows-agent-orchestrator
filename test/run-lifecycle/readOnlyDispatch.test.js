// test/run-lifecycle/readOnlyDispatch.test.js
//
// Round 4 Bundle B — read-only run DECLARATION wiring (advisory + in-flight
// alerting, NO hard gate) across the four boundaries:
//
//   1. dispatchRun service   — readOnly pushes --isolate --read-only to the
//      detached runner argv (closing the delivery-only --isolate gap for the
//      non-delivery branch); readOnly × delivery is refused by a TYPED error
//      (ReadOnlyDeliveryConflictError) before ANY side effect; readOnly ×
//      continuable is naturally refused by the existing delivery-only gate;
//      readOnly × correctable coexists (a correction is a Lead instruction).
//   2. RunManager.start      — readOnly FORCES persistent worktree isolation
//      (overriding an explicit isolate:false), fails CLOSED on worktree
//      creation failure (typed ReadOnlyWorktreeRequiredError, zero transcript
//      side effects — the legacy degrade-to-source-cwd stays readOnly-free),
//      and persists the exactly-once run.read_only_declared durable fact with
//      an empty bounded payload.
//   3. MCP run_dispatch      — handler-layer mutual exclusion (fixed safe text
//      + closed-set reason code read_only_delivery_conflict; NOT a top-level
//      schema .refine()), readOnly threading to the dispatcher, and the
//      additive input/output schema members on tools/list.
//   4. CLI `run --read-only` — × --delivery-spec-file / × --no-isolate are
//      refused before any side effect; the foreground path threads the
//      declaration into RunManager.start.
//
// Owner constraint pinned here (the no-hard-gate regression): a read-only run
// whose worker writes files anyway reaches its NATURAL terminal state —
// nothing stops, aborts, or fails the run — while the confirmed file_written
// evidence stays in the transcript (the evidence channel) and the activity
// projection surfaces writes_observed for the Lead's final judgment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { dispatchRun, ReadOnlyDeliveryConflictError } from "../../src/application/runDispatch.js";
import { RunManager, ReadOnlyWorktreeRequiredError } from "../../src/runManager.js";
import { readTranscript, findState } from "../../src/transcript.js";
import { readRunActivity } from "../../src/application/runActivity.js";
import { projectRunActivity } from "../../src/application/runActivityProjection.js";

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name t", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: dir, stdio: "pipe" });
}

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

function makeFakeSpawn() {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { unref() {} };
  };
  return { fakeSpawn, calls };
}

const FAKE_WORKTREE = "D:/wao-fake/worktree_wt";

/** A recording process backend whose event stream is configurable. */
function recordingBackend(events = []) {
  const spawns = [];
  const backend = {
    supportsRoleContract: true,
    sessionOutlivesProcess: false,
    async spawn(agent, task) {
      spawns.push({ agent, task });
      return {
        backend: "claude-code",
        backendSessionId: "s1",
        messageId: "m1",
        admittedSeq: 1,
        async *events() {
          for (const ev of events) yield ev;
        },
        abort: async () => {},
        isAlive: () => false,
      };
    },
  };
  return { backend, spawns };
}

/** RunManager with an injectable createWorktreeFn + fake backend. */
function makeManager({ dir, backend, createWorktreeFn }) {
  return new RunManager({
    config: {
      registry: join(dir, "agents.json"),
      runDir: join(dir, "runs"),
      pollInterval: 10,
      waitTimeout: 5000,
      timeout: 5000,
      retries: 0,
      defaultIsolation: "none",
    },
    readRegistry: async () => ({
      getAgent(id, overrides = {}) {
        const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
        return { id, backend: "claude-code", cwd: dir, ...defined };
      },
      listAgents() { return []; },
    }),
    backendFor: () => backend,
    userEnvReader: async () => ({}),
    ...(createWorktreeFn ? { createWorktreeFn } : {}),
  });
}

// =====================================================================
// 1. dispatchRun service
// =====================================================================

test("RO-D1: readOnly:true pushes BOTH --isolate and --read-only to the runner argv (non-delivery branch)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ro-d1-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const result = await dispatchRun({
      agentId: "coder_low",
      prompt: "survey only",
      registryPath,
      runDir: join(dir, "runs"),
      readOnly: true,
      spawnFn: fakeSpawn,
    });
    assert.equal(result.accepted, true);
    assert.equal(calls.length, 1, "spawn exactly once");
    const argv = calls[0].args;
    assert.ok(argv.includes("--isolate"), "readOnly forces --isolate on the runner path");
    assert.ok(argv.includes("--read-only"), "readOnly threads the declaration flag");
    assert.ok(!argv.includes("--delivery-json"), "no delivery payload on a read-only dispatch");
  } finally {
    cleanupDir(dir);
  }
});

test("RO-D2: no readOnly → argv carries NEITHER flag (byte-compatible ordinary dispatch)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ro-d2-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    await dispatchRun({
      agentId: "coder_low",
      prompt: "ordinary task",
      registryPath,
      runDir: join(dir, "runs"),
      spawnFn: fakeSpawn,
    });
    const argv = calls[0].args;
    assert.ok(!argv.includes("--isolate"), "no --isolate without readOnly/delivery");
    assert.ok(!argv.includes("--read-only"), "no --read-only without the declaration");
  } finally {
    cleanupDir(dir);
  }
});

test("RO-D3: readOnly × delivery → typed ReadOnlyDeliveryConflictError, zero transcript, zero fork", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ro-d3-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const runDir = join(dir, "runs");
    await assert.rejects(
      () => dispatchRun({
        agentId: "coder_low",
        prompt: "x",
        registryPath,
        runDir,
        readOnly: true,
        delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
        spawnFn: fakeSpawn,
      }),
      (e) => {
        assert.equal(e.name, "ReadOnlyDeliveryConflictError", "typed error name");
        assert.equal(e.reasonCode, "read_only_delivery_conflict", "closed-set reason code");
        assert.match(e.message, /read_only_delivery_conflict/);
        return true;
      },
    );
    assert.equal(calls.length, 0, "no fork on the contradictory declaration");
    const files = existsSync(runDir) ? execSync("cmd /c dir /b", { cwd: runDir, stdio: "pipe" }).toString() : "";
    assert.equal(files.trim(), "", "zero transcript written (no orphaned pending run)");
  } finally {
    cleanupDir(dir);
  }
});

test("RO-D4: readOnly × correctable coexists (a correction is a Lead instruction, not a delivery)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ro-d4-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    await dispatchRun({
      agentId: "coder_low",
      prompt: "x",
      registryPath,
      runDir: join(dir, "runs"),
      readOnly: true,
      correctable: true,
      // correctable requires a backend declaring the capability
      backendFor: () => ({ supportsInFlightCorrection: true }),
      spawnFn: fakeSpawn,
    });
    const argv = calls[0].args;
    assert.ok(argv.includes("--correctable"));
    assert.ok(argv.includes("--isolate"));
    assert.ok(argv.includes("--read-only"));
  } finally {
    cleanupDir(dir);
  }
});

test("RO-D5: readOnly × continuable is naturally refused by the existing delivery-only gate (no new code)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ro-d5-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    await assert.rejects(
      () => dispatchRun({
        agentId: "coder_low",
        prompt: "x",
        registryPath,
        runDir: join(dir, "runs"),
        readOnly: true,
        continuable: true,
        leadSession: "lead-session-1",
        cwd: dir,
        backendFor: () => ({ supportsSessionReuse: true }),
        spawnFn: fakeSpawn,
      }),
      /continuable is delivery-only/,
      "the pre-existing delivery-only gate refuses the combination",
    );
    assert.equal(calls.length, 0, "no fork");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 2. RunManager.start
// =====================================================================

test("RO-R1: readOnly forces worktree isolation over an explicit isolate:false and writes the declaration exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ro-r1-"));
  try {
    makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const { backend, spawns } = recordingBackend([{ kind: "done", reason: "completed" }]);
    let wtCalls = 0;
    const manager = makeManager({
      dir,
      backend,
      createWorktreeFn: async () => {
        wtCalls += 1;
        return { path: FAKE_WORKTREE, branch: "wao/run_ro_r1" };
      },
    });
    const run = await manager.start("coder_low", {
      prompt: "survey",
      // The declaration must override an explicit opt-OUT of isolation.
      isolate: false,
      readOnly: true,
    });
    assert.equal(wtCalls, 1, "worktree created despite isolate:false");
    // The worker spawns INSIDE the worktree.
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].agent.cwd, FAKE_WORKTREE, "backend spawn cwd is the worktree");
    const events = await readTranscript(run.transcript.filePath);
    const started = events.find((e) => e.type === "run.started");
    assert.equal(started.worktreePath, FAKE_WORKTREE, "run.started persists the worktree authority");
    const declarations = events.filter((e) => e.type === "run.read_only_declared");
    assert.equal(declarations.length, 1, "exactly one declaration fact");
    // Bounded, no sensitive payload: the envelope IS the fact.
    const payloadKeys = Object.keys(declarations[0]).filter((k) => !["ts", "seq", "runId", "agentId", "type"].includes(k));
    assert.deepEqual(payloadKeys, [], "declaration payload is empty by construction");
  } finally {
    cleanupDir(dir);
  }
});

test("RO-R2: worktree creation failure × readOnly → typed fail-closed refusal with ZERO side effects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ro-r2-"));
  try {
    makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const { backend, spawns } = recordingBackend([{ kind: "done", reason: "completed" }]);
    const manager = makeManager({
      dir,
      backend,
      createWorktreeFn: async () => {
        throw new Error("git worktree add failed");
      },
    });
    await assert.rejects(
      () => manager.start("coder_low", { prompt: "x", readOnly: true }),
      (e) => {
        assert.equal(e.name, "ReadOnlyWorktreeRequiredError", "typed error name");
        assert.equal(e.reasonCode, "read_only_worktree_required", "closed-set reason code");
        assert.ok(!e.message.includes("git worktree add failed"), "no operational detail echoed");
        return true;
      },
    );
    assert.equal(spawns.length, 0, "no backend spawn");
    // Zero transcript side effects: no run.started, no run.isolation_failed,
    // no declaration, no pending transition — the degrade path is plugged.
    const runFiles = existsSync(join(dir, "runs")) ? join(dir, "runs") : null;
    if (runFiles) {
      const jsonl = execSync("cmd /c dir /b", { cwd: runFiles, stdio: "pipe" }).toString().split(/\r?\n/).filter((f) => f.endsWith(".jsonl"));
      assert.deepEqual(jsonl, [], "no transcript file written");
    }
  } finally {
    cleanupDir(dir);
  }
});

test("RO-R3: worktree creation failure WITHOUT readOnly keeps the legacy degrade (run.isolation_failed, source cwd)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ro-r3-"));
  try {
    makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const { backend, spawns } = recordingBackend([{ kind: "done", reason: "completed" }]);
    const manager = makeManager({
      dir,
      backend,
      createWorktreeFn: async () => {
        throw new Error("git worktree add failed");
      },
    });
    // Isolation requested (flag true) but NOT read-only → legacy degrade.
    const run = await manager.start("coder_low", { prompt: "x", isolate: true });
    const events = await readTranscript(run.transcript.filePath);
    assert.ok(events.some((e) => e.type === "run.isolation_failed"), "legacy degrade fact persisted");
    assert.ok(!events.some((e) => e.type === "run.read_only_declared"), "no declaration on an ordinary run");
    assert.equal(spawns.length, 1, "ordinary degraded run still spawns");
  } finally {
    cleanupDir(dir);
  }
});

test("RO-R4: RunManager.start refuses readOnly × delivery (defense-in-depth at the spawn authority)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ro-r4-"));
  try {
    makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const { backend } = recordingBackend([]);
    const manager = makeManager({ dir, backend });
    await assert.rejects(
      () => manager.start("coder_low", {
        prompt: "x",
        readOnly: true,
        delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
      }),
      /read_only_delivery_conflict/,
    );
    const runDir = join(dir, "runs");
    if (existsSync(runDir)) {
      const jsonl = execSync("cmd /c dir /b", { cwd: runDir, stdio: "pipe" }).toString().split(/\r?\n/).filter((f) => f.endsWith(".jsonl"));
      assert.deepEqual(jsonl, [], "zero transcript on the refusal");
    }
  } finally {
    cleanupDir(dir);
  }
});

test("RO-R5: NO HARD GATE — a readOnly run with confirmed writes reaches its NATURAL terminal state; evidence + observation stay honest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ro-r5-"));
  try {
    makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    // The worker writes two files INSIDE the isolated worktree, then completes.
    // Nothing below stops, aborts, or fails the run on the observed writes.
    const { backend } = recordingBackend([
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "editing" }] },
      { kind: "file_written", path: `${FAKE_WORKTREE}/src/a.js`, tool: "Write", toolCallId: "tc1" },
      { kind: "file_written", path: `${FAKE_WORKTREE}/docs/b.md`, tool: "Write", toolCallId: "tc2" },
      { kind: "done", reason: "completed" },
    ]);
    const manager = makeManager({
      dir,
      backend,
      createWorktreeFn: async () => ({ path: FAKE_WORKTREE, branch: "wao/run_ro_r5" }),
    });
    const run = await manager.start("coder_low", { prompt: "supposedly read-only", readOnly: true });
    const waitResult = await run.waitForCompletion({ pollInterval: 10 });

    // Natural terminal state: completed — NOT aborted/failed by the writes.
    assert.equal(waitResult.completed, true, "run completes naturally despite observed writes");
    const events = await readTranscript(run.transcript.filePath);
    assert.equal(findState(events), "completed", "state machine settles completed");
    assert.ok(!events.some((e) => e.type === "run.stop_requested"), "no stop side effect");
    assert.ok(!events.some((e) => e.type === "run.aborted"), "no abort side effect");
    // The evidence channel is ALIVE: confirmed file_written facts hit the transcript.
    const writes = events.filter((e) => e.type === "run.event" && e.kind === "file_written");
    assert.equal(writes.length, 2, "both writes persisted as durable evidence");

    // The shared read-only observation over the REAL transcript: writes_observed.
    const snapshot = await readRunActivity({
      runId: run.transcript.context.runId,
      runDir: join(dir, "runs"),
    });
    const page = projectRunActivity(snapshot, {
      runId: run.transcript.context.runId,
      audience: "lead",
    });
    assert.equal(page.readOnlyObservation.status, "writes_observed");
    assert.equal(page.readOnlyObservation.complete, true);
    assert.deepEqual(page.readOnlyObservation.writtenPaths, ["docs/b.md", "src/a.js"]);
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 3. MCP run_dispatch surface
// =====================================================================

async function buildServerClient({ dir, registryPath, dispatcher }) {
  const { createWaoMcpServer } = await import("../../src/mcp/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createWaoMcpServer({
    registryPath,
    runDir: join(dir, "runs"),
    workspaceRoot: dir,
    ...(dispatcher ? { dispatchRunFn: dispatcher } : {}),
  });
  const client = new Client({ name: "wao-test-client", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { server, client };
}

function fakeDispatchResult() {
  return {
    accepted: true,
    runId: "run_20260816090000000rotest",
    agentId: "coder_low",
    state: "pending",
    providerSessionRouting: "not_used",
  };
}

test("RO-M1: MCP readOnly+delivery → fixed safe text + closed-set reason code; dispatcher never called", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ro-m1-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    let calls = 0;
    const { server, client } = await buildServerClient({
      dir, registryPath,
      dispatcher: async () => { calls += 1; return fakeDispatchResult(); },
    });
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "coder_low",
          prompt: "x",
          readOnly: true,
          delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
        },
      });
      assert.equal(res.isError, true, "refused");
      const text = res.content.map((c) => c.text || "").join(" ");
      assert.match(text, /read_only_delivery_conflict/, "closed-set reason code surfaces");
      assert.match(text, /never a delivery/, "fixed actionable guidance");
      assert.equal(calls, 0, "dispatcher call count stays 0 (zero transcript, zero fork)");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("RO-M2: MCP readOnly:true threads readOnly to the dispatcher; accepted dispatch returns the structured result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ro-m2-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const seen = [];
    const { server, client } = await buildServerClient({
      dir, registryPath,
      dispatcher: async (input) => { seen.push(input); return fakeDispatchResult(); },
    });
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "survey only", readOnly: true },
      });
      assert.equal(res.isError, undefined, "accepted");
      assert.equal(seen.length, 1);
      assert.equal(seen[0].readOnly, true, "declaration threaded to the service");
      assert.equal(res.structuredContent.runId, "run_20260816090000000rotest");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("RO-M3: MCP dispatch WITHOUT readOnly threads no readOnly key (byte-unchanged ordinary path)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ro-m3-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const seen = [];
    const { server, client } = await buildServerClient({
      dir, registryPath,
      dispatcher: async (input) => { seen.push(input); return fakeDispatchResult(); },
    });
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "ordinary" },
      });
      assert.equal(res.isError, undefined);
      assert.equal(seen.length, 1);
      assert.equal("readOnly" in seen[0], false, "no readOnly key on the ordinary path");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("RO-M4: tools/list schemas are additive — run_dispatch input gains readOnly; run_activity output gains optional readOnlyObservation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ro-m4-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const { server, client } = await buildServerClient({ dir, registryPath });
    try {
      const tools = (await client.listTools()).tools;
      const rd = tools.find((t) => t.name === "run_dispatch");
      assert.ok(rd.inputSchema.properties.readOnly, "readOnly input member present");
      assert.equal(rd.inputSchema.properties.readOnly.type, "boolean");
      assert.equal(rd.inputSchema.additionalProperties, false, "input stays strict");
      assert.ok(!rd.inputSchema.required.includes("readOnly"), "readOnly stays optional (absent = old behavior)");
      const ra = tools.find((t) => t.name === "run_activity");
      assert.ok(ra.outputSchema.properties.readOnlyObservation, "readOnlyObservation output member present");
      assert.ok(!ra.outputSchema.required.includes("readOnlyObservation"),
        "readOnlyObservation is optional (undeclared runs keep the field absent)");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 4. CLI `run --read-only`
// =====================================================================

test("RO-C1: run --read-only × --delivery-spec-file is rejected before any side effect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ro-c1-"));
  try {
    const spec = join(dir, "spec.json");
    writeFileSync(spec, JSON.stringify({
      mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"],
    }), "utf8");
    const { runCommand } = await import("../../src/commands/run.js");
    await assert.rejects(
      () => runCommand(["coder_low", "--prompt", "x", "--read-only", "--delivery-spec-file", spec, "--isolate"], {}),
      (e) => {
        assert.match(e.message, /read_only_delivery_conflict/);
        assert.match(e.message, /--read-only is mutually exclusive with --delivery-spec-file/);
        return true;
      },
    );
    // Zero side effects: the rejection happens before manager construction /
    // transcript writes (config {} has no runDir writes here).
  } finally {
    cleanupDir(dir);
  }
});

test("RO-C2: run --read-only × --no-isolate is rejected as a contradictory declaration", async () => {
  const { runCommand } = await import("../../src/commands/run.js");
  await assert.rejects(
    () => runCommand(["coder_low", "--prompt", "x", "--read-only", "--no-isolate"], {}),
    /--no-isolate contradicts a read-only declaration/,
  );
});

test("RO-C3: the usage page and command summary list --read-only", async () => {
  const { RUN_USAGE_TEXT, HELP_TEXT } = await import("../../src/cliHelp.js");
  assert.match(RUN_USAGE_TEXT, /--read-only/, "RUN_USAGE_TEXT lists the flag");
  const runLine = HELP_TEXT.split(/\r?\n/).find((l) => l.startsWith("  run <agentId>"));
  assert.ok(runLine, "HELP_TEXT has the run summary line");
  assert.match(runLine, /\[--read-only\]/, "summary line carries the flag");
  // The honest advisory-not-gate semantics ride the usage page.
  assert.match(RUN_USAGE_TEXT, /never a gate|advisory observation/i);
});

test("RO-C4: foreground `run --read-only` forces isolation and persists the declaration (real git worktree)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ro-c4-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const { runCommand } = await import("../../src/commands/run.js");
    const { backend } = recordingBackend([{ kind: "done", reason: "completed" }]);

    // No --isolate on the argv: the declaration alone must force the worktree.
    const config = {
      registry: registryPath,
      runDir: join(dir, "runs"),
      backendFor: () => backend,
    };
    const origLog = console.log;
    const lines = [];
    console.log = (...a) => { lines.push(a.map(String).join(" ")); };
    try {
      await runCommand(["coder_low", "--prompt", "survey", "--read-only"], config);
    } finally {
      console.log = origLog;
    }
    const runLine = lines.find((l) => l.includes("run_2"));
    assert.ok(runLine, "run summary printed");
    const runIdSeen = runLine.match(/run_\d+[a-z0-9]+/)?.[0];
    assert.ok(runIdSeen, "runId captured");

    const events = await readTranscript(join(dir, "runs", `${runIdSeen}.jsonl`));
    const started = events.find((e) => e.type === "run.started");
    assert.ok(started.worktreePath, "foreground readOnly run started inside a REAL worktree");
    assert.ok(started.worktreePath.includes(".wao-worktrees"), "worktree under the repo's worktree root");
    assert.ok(events.some((e) => e.type === "run.read_only_declared"), "declaration persisted on the CLI foreground path");
  } finally {
    cleanupDir(dir);
  }
});
