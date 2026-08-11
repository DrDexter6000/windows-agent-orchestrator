// test/mcpRunDispatch.test.js
//
// M9-2B: MCP run_dispatch tool — TDD tests.
//
// Proves that an MCP host can dispatch a supervised background run via the
// run_dispatch tool, which calls the M9-2A dispatchRun() application service.
// Covers: tool list shape, exactly-once service invocation, server-owned paths,
// advisory requireCertified:false (certification is recorded reliability
// evidence, never a permission gate — the Lead may dispatch any configured
// worker), safe output (no paths/PID/prompt/argv), strict input rejection (a
// client cannot inject or override the server-owned flag), error redaction,
// real stdio no-model integration, detached runner terminal state after MCP
// host closes, CLI/MCP parity, and the summary-less Fresh clone regression
// (no reliability-summary.json → dispatch reaches the detached path, never a
// certification-gate refusal).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

import { createWaoMcpServer } from "../src/mcp/server.js";
import { dispatchRun as realDispatchRun } from "../src/application/runDispatch.js";
import { readTranscript, findState, findLatest } from "../src/transcript.js";

// ===== Helpers =====

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SHIM = join(REPO_ROOT, "scripts", "wao-node.cjs");
const STDIO_ENTRY = join(REPO_ROOT, "src", "mcp", "stdio.js");

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

function makeSummary(runDir, workers) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({ workers }), "utf8");
  return runDir;
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeGitRepo(dir) {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@test.com', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8');
  execSync('git add README.md', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: dir, stdio: 'pipe' });
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-client", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function buildStdioSubprocessTransport({ registryPath, runDir, workspaceRoot, env = {} }) {
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const childEnv = { ...process.env, WAO_SKIP_VERSION_GUARD: "1", ...env };
  const args = [SHIM, STDIO_ENTRY, "--registry", registryPath, "--run-dir", runDir];
  if (workspaceRoot) args.push("--workspace-root", workspaceRoot);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: childEnv,
  });
  return transport;
}

// ===== Tests =====

// ---------------------------------------------------------------------
// M9-2B-01: tools/list contains exactly registry_list + run_dispatch with correct
//           schemas and annotations.
// ---------------------------------------------------------------------

test("M9-2B-01: tools/list has registry_list + run_dispatch with strict schema and annotations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92b-01-"));
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const server = createWaoMcpServer({ registryPath, runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      assert.ok(names.includes("run_dispatch"), "run_dispatch present");
      assert.ok(names.includes("registry_list"), "registry_list present");

      const rd = tools.tools.find((t) => t.name === "run_dispatch");
      assert.ok(rd, "run_dispatch present");
      // Strict input: agentId + prompt required, delivery + the M12-6 (FR-03)
      // optional workspace/head freeze inputs + the M12-7 optional continuable
      // lineage opt-in + the M12-9 optional executionProfileId + the M12-16
      // optional correctable in-flight-correction opt-in.
      const inputKeys = Object.keys(rd.inputSchema.properties ?? {}).sort();
      assert.deepEqual(inputKeys,
        ["agentId", "continuable", "correctable", "delivery", "executionProfileId", "expectedDirty", "expectedGitHead", "expectedWorkspaceRoot", "prompt"],
        "input schema has agentId + prompt + optional delivery + optional expectations + optional continuable + optional correctable + optional executionProfileId",
      );
      assert.equal(rd.inputSchema.additionalProperties, false, "input is strict");
      // Annotations: not read-only, destructive (worker may modify files/run commands),
      // not idempotent, open-world (dispatches real work).
      assert.equal(rd.annotations.readOnlyHint, false, "readOnlyHint:false");
      assert.equal(rd.annotations.destructiveHint, true, "destructiveHint:true (worker can mutate files/execute commands)");
      assert.equal(rd.annotations.idempotentHint, false, "idempotentHint:false");
      assert.equal(rd.annotations.openWorldHint, true, "openWorldHint:true");
      // Output schema declared.
      assert.ok(rd.outputSchema, "output schema declared");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2B-02: injected dispatcher called exactly once, receives server-owned paths
//           and advisory requireCertified:false; model cannot override paths or
//           the certification flag.
// ---------------------------------------------------------------------

test("M9-2B-02: run_dispatch calls dispatcher once with server paths and advisory requireCertified:false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92b-02-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    let callCount = 0;
    let captured = null;
    const fakeDispatch = async (input) => {
      callCount += 1;
      captured = input;
      return { accepted: true, runId: "run_fake_m92b02", state: "pending", transcriptPath: "/x.jsonl" };
    };

    const server = createWaoMcpServer({
      registryPath,
      runDir: "/server/runs",
      workspaceRoot: dir,
      dispatchRunFn: fakeDispatch,
    });
    const client = await buildInMemoryClient(server);
    try {
      await client.callTool({ name: "run_dispatch", arguments: { agentId: "coder_low", prompt: "do it" } });
      assert.equal(callCount, 1, "dispatcher called exactly once");
      assert.ok(captured.registryPath, "server-owned registryPath passed through");
      assert.equal(captured.runDir, "/server/runs", "server-owned runDir");
      assert.equal(captured.requireCertified, false, "certification is advisory: requireCertified fixed false (not a permission gate)");
      assert.equal(captured.agentId, "coder_low");
      assert.equal(captured.prompt, "do it");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2B-03: success output contains only runId/accepted/state — no paths/PID/prompt/argv.
// ---------------------------------------------------------------------

test("M9-2B-03: run_dispatch success output has only runId/agentId/accepted/state, no leaks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92b-03-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { x: { backend: "claude-code", cwd: dir } });
    const fakeDispatch = async () => ({
      accepted: true,
      runId: "run_ok_m92b03",
      agentId: "x",
      state: "pending",
      transcriptPath: "/secret/runs/run_ok_m92b03.jsonl",
    });

    const server = createWaoMcpServer({
      registryPath,
      runDir: "/server/runs",
      workspaceRoot: dir,
      dispatchRunFn: fakeDispatch,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "secret-prompt-value" } });
      const textBlock = res.content.find((b) => b.type === "text");
      const parsed = JSON.parse(textBlock.text);

      // M11-8B added agentId; M12-6 (FR-03) adds the additive bounded workspaceProof.
      assert.deepEqual(Object.keys(parsed).sort(),
        ["accepted", "agentId", "runId", "state", "workspaceProof"],
        "only runId/agentId/accepted/state + additive workspaceProof");
      assert.equal(parsed.accepted, true);
      assert.equal(parsed.runId, "run_ok_m92b03");
      assert.equal(parsed.agentId, "x");
      assert.equal(parsed.state, "pending");
      // M12-6 (FR-03): the proof is bounded — source/head/dirty + nullable match
      // booleans, NEVER the absolute workspace path.
      assert.deepEqual(Object.keys(parsed.workspaceProof).sort(),
        ["dirty", "expectedDirtyMatch", "expectedGitHeadMatch", "expectedWorkspaceRootMatch", "gitHead", "source"],
        "workspaceProof has source/head/dirty + 3 nullable match booleans");
      assert.ok(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(parsed.workspaceProof.gitHead), "proof gitHead is canonical hex");
      assert.equal(typeof parsed.workspaceProof.dirty, "boolean", "proof dirty is boolean");
      // No expectations were supplied → all match booleans are null.
      assert.equal(parsed.workspaceProof.expectedGitHeadMatch, null);
      assert.equal(parsed.workspaceProof.expectedDirtyMatch, null);
      assert.equal(parsed.workspaceProof.expectedWorkspaceRootMatch, null);

      // No leaks.
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes("/secret/runs"), "no transcriptPath leak");
      assert.ok(!dumped.includes("secret-prompt-value"), "no prompt leak");
      assert.ok(!dumped.includes("argv"), "no argv leak");
      // M12-6 (FR-03): the workspace proof must NOT echo the absolute workspace
      // root (forward-slash canonicalized form included for cross-platform safety).
      assert.ok(!dumped.includes(dir.replace(/\\/g, "/")), "no absolute workspace root leak in proof");
      // structuredContent mirrors content.
      if (res.structuredContent) {
        assert.deepEqual(res.structuredContent, parsed, "structuredContent matches text JSON");
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2B-04: extra/control-plane args rejected by strict schema; dispatcher count 0.
// ---------------------------------------------------------------------

test("M9-2B-04: control-plane args rejected, dispatcher not called", async () => {
  let callCount = 0;
  const fakeDispatch = async () => { callCount += 1; return { accepted: true, runId: "x", state: "pending" }; };

  const server = createWaoMcpServer({
    registryPath: "/server/registry.json",
    runDir: "/server/runs",
    dispatchRunFn: fakeDispatch,
  });
  const client = await buildInMemoryClient(server);
  try {
    const badArgsList = [
      { agentId: "x", prompt: "y", registryPath: "/attacker/r.json" },
      { agentId: "x", prompt: "y", runDir: "/attacker/runs" },
      // requireCertified is server-owned: a client can neither disable the gate
      // (false) nor force it (true) via tool arguments — both are rejected by
      // the strict schema before the service is ever called.
      { agentId: "x", prompt: "y", requireCertified: false },
      { agentId: "x", prompt: "y", requireCertified: true },
      { agentId: "x", prompt: "y", runId: "run_evil" },
      { agentId: "x", prompt: "y", cwd: "/evil" },
      { agentId: "x", prompt: "y", evil: true },
      // M10-pre closeout-2: MCP tool input must NOT control timeout values.
      // waitTimeout and globalWaitTimeout are server-owned; the model cannot set them.
      { agentId: "x", prompt: "y", waitTimeout: 999 },
      { agentId: "x", prompt: "y", waitTimeout: 600000 },
      { agentId: "x", prompt: "y", globalWaitTimeout: 300000 },
      { agentId: "x", prompt: "y", globalWaitTimeout: 999999 },
    ];
    for (const bad of badArgsList) {
      let rejected = false;
      let result = null;
      try {
        result = await client.callTool({ name: "run_dispatch", arguments: bad });
      } catch {
        // A protocol-level rejection (throw) is a valid rejection.
        rejected = true;
      }
      if (!rejected) {
        // If it returned a result, it must be an explicit tool error — never success.
        assert.equal(result.isError, true,
          `control-plane arg ${JSON.stringify(Object.keys(bad))} must be rejected, got success`);
        rejected = true;
      }
      assert.ok(rejected, `every control-plane arg must be rejected: ${JSON.stringify(Object.keys(bad))}`);
    }
    assert.equal(callCount, 0, "dispatcher never called for any control-plane arg");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-2B-05: dispatcher throw with secret + absolute path → fixed "run_dispatch failed".
// ---------------------------------------------------------------------

test("M9-2B-05: dispatcher error returns fixed safe text, no secret/path leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92b-05-"));
  try {
    makeGitRepo(dir);
    const SECRET = "test-secret-dispatch-leak-m92b05";
    const ABS_PATH = "C:\\Users\\leak\\runs\\secret.jsonl";
    const fakeDispatch = async () => {
      throw new Error(`dispatch crashed at ${ABS_PATH} key=${SECRET}`);
    };

    const server = createWaoMcpServer({
      registryPath: "/server/registry.json",
      runDir: "/server/runs",
      workspaceRoot: dir,
      dispatchRunFn: fakeDispatch,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "y" } });
      assert.equal(res.isError, true, "error flagged");
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes(SECRET), "no secret leak");
      assert.ok(!dumped.includes(ABS_PATH), "no absolute path leak");
      assert.ok(!dumped.includes("C:\\\\Users"), "no path fragment leak");
      const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.ok(/run_dispatch failed/.test(text), "fixed safe text present");
      assert.ok(!/at .*\(.+:\d+:\d+\)/.test(text), "no stack frame");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2B-06: real stdio no-model integration — temp registry, fresh summary,
//           nonexistent backend binary. Transcript reaches pending then failed.
// ---------------------------------------------------------------------

test("M9-2B-06: real stdio run_dispatch reaches pending, runner drives to failed terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92b-06-"));
  let client;
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, {
      failing_worker: {
        backend: "claude-code",
        binary: "definitely-nonexistent-m92b-06",
        cwd: dir,
      },
    });
    const runDir = makeSummary(dir, { failing_worker: { status: "certified" } });

    const { Client } = await import("@modelcontextprotocol/sdk/client");
    client = new Client({ name: "wao-m92b-06", version: "0.0.1" }, { capabilities: {} });
    const transport = await buildStdioSubprocessTransport({ registryPath, runDir, workspaceRoot: dir });
    await client.connect(transport);

    const res = await client.callTool({
      name: "run_dispatch",
      arguments: { agentId: "failing_worker", prompt: "bounded task" },
    });
    const textBlock = res.content.find((b) => b.type === "text");
    const parsed = JSON.parse(textBlock.text);
    assert.equal(parsed.accepted, true, "dispatch accepted");
    assert.equal(parsed.state, "pending", "initial state pending");
    const runId = parsed.runId;
    assert.ok(runId, "runId returned");

    // Transcript must already be readable and pending at return time.
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    assert.ok(existsSync(transcriptPath), "transcript exists at MCP return");
    const earlyEvents = await readTranscript(transcriptPath);
    assert.equal(findState(earlyEvents), "pending", "transcript pending at return");

    // Close MCP host — detached runner must continue independently to failed terminal.
    await client.close();
    client = null;

    let events = earlyEvents;
    for (let i = 0; i < 80; i += 1) {
      events = await readTranscript(transcriptPath);
      if (["failed", "completed", "aborted", "timed_out"].includes(findState(events))) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(findState(events), "failed", "runner drove nonexistent binary to failed");

    // Ownership heartbeat file cleared after runner exit.
    const ownerFile = join(runDir, `.owner-${runId}`);
    for (let i = 0; i < 40; i += 1) {
      if (!existsSync(ownerFile)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(!existsSync(ownerFile), "ownership heartbeat cleared after runner exit");
  } finally {
    if (client) await client.close();
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2B-08 (Fresh Host onboarding regression): a configured worker with NO
// reliability-summary.json must dispatch through the real MCP boundary + real
// application service + detached runner. Certification is advisory evidence,
// never a permission gate — the run must NOT die at the certification gate
// before the provider spawns. Fixture is fully synthetic: nonexistent binary,
// no credentials, no model call.
// ---------------------------------------------------------------------

test("M9-2B-08: summary-less Fresh clone dispatches via real MCP + detached runner, no certification-gate refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92b-08-"));
  let client;
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, {
      fresh_worker: {
        backend: "claude-code",
        binary: "definitely-nonexistent-m92b-08",
        cwd: dir,
      },
    });
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    // Causal precondition: this Fresh clone (wao onboarding --apply) has NO
    // reliability-summary.json. Under a hardcoded certification gate the first
    // MCP run would be refused here before the provider ever spawns.
    assert.ok(!existsSync(join(runDir, "reliability-summary.json")),
      "fixture has no reliability-summary.json");

    const { Client } = await import("@modelcontextprotocol/sdk/client");
    client = new Client({ name: "wao-m92b-08", version: "0.0.1" }, { capabilities: {} });
    const transport = await buildStdioSubprocessTransport({ registryPath, runDir, workspaceRoot: dir });
    await client.connect(transport);

    const res = await client.callTool({
      name: "run_dispatch",
      arguments: { agentId: "fresh_worker", prompt: "bounded task" },
    });
    // The certification gate must NOT fire anywhere in the path. Note the gate
    // (when enabled) fires INSIDE the detached runner — RunManager.start appends
    // a certification-gate run.error and refuses before the provider spawns —
    // so the MCP boundary still returns an acceptance; the causal proof lives
    // in the transcript below (no certification-gate event, worker reaches the
    // real detached path).
    assert.equal(res.isError, undefined, "tool returns a normal (non-error) result");
    const textBlock = res.content.find((b) => b.type === "text");
    const parsed = JSON.parse(textBlock.text);
    assert.equal(parsed.accepted, true, "dispatch accepted");
    assert.equal(parsed.state, "pending", "initial state pending");
    const runId = parsed.runId;
    assert.ok(runId, "runId returned");

    // The application/detached path ran: a transcript exists at MCP return and
    // the detached runner drove the nonexistent binary to a terminal failure.
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    assert.ok(existsSync(transcriptPath), "transcript exists at MCP return (application path ran)");
    const earlyEvents = await readTranscript(transcriptPath);
    assert.equal(findState(earlyEvents), "pending", "transcript pending at return");

    // Close MCP host — detached runner must continue independently.
    await client.close();
    client = null;

    let events = earlyEvents;
    for (let i = 0; i < 80; i += 1) {
      events = await readTranscript(transcriptPath);
      if (["failed", "completed", "aborted", "timed_out"].includes(findState(events))) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    // Terminal "failed" from the nonexistent binary — under the old hardcoded
    // gate this terminal would be reached via a certification-gate refusal
    // (run.error phase=certification-gate appended, provider never spawned).
    assert.equal(findState(events), "failed", "runner drove nonexistent binary to failed terminal");
    assert.ok(!events.some((e) => e.type === "run.error" && e.phase === "certification-gate"),
      "no certification-gate error event in transcript (gate never fired)");
  } finally {
    if (client) await client.close();
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2B-07: CLI and MCP dispatch the same agent produce the same initial durable
//           facts (background_submitted + pending) and the same outcome type.
// ---------------------------------------------------------------------

test("M9-2B-07: CLI and MCP dispatch produce same initial durable facts and outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92b-07-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, {
      parity_worker: {
        backend: "claude-code",
        binary: "nonexistent-parity-m92b-07",
        cwd: dir,
      },
    });
    const runDir = makeSummary(dir, { parity_worker: { status: "certified" } });

    // MCP dispatch via in-memory server + real dispatchRun.
    const mcpServer = createWaoMcpServer({ registryPath, runDir, workspaceRoot: dir });
    const mcpClient = await buildInMemoryClient(mcpServer);
    let mcpRunId;
    try {
      const res = await mcpClient.callTool({
        name: "run_dispatch",
        arguments: { agentId: "parity_worker", prompt: "parity task" },
      });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      mcpRunId = parsed.runId;
      await mcpClient.close();
    } finally {
      await mcpServer.close();
    }

    // CLI dispatch (subprocess) with the same registry/runDir.
    const cliRunDir = join(dir, "cli-runs");
    mkdirSync(cliRunDir, { recursive: true });
    // Re-create summary in cli runDir.
    writeFileSync(join(cliRunDir, "reliability-summary.json"), JSON.stringify({ workers: { parity_worker: { status: "certified" } } }), "utf8");
    const cliOut = execSync(
      `node src/cli.js run parity_worker --prompt "parity task" --background --registry ${registryPath} --run-dir ${cliRunDir} --format json`,
      { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" }, timeout: 10000 },
    );
    const cliParsed = JSON.parse(cliOut.slice(cliOut.indexOf("{"), cliOut.lastIndexOf("}") + 1));
    const cliRunId = cliParsed.runId;

    // Wait for both to reach terminal.
    async function waitForTerminal(rd, rid) {
      const tp = join(rd, `${rid}.jsonl`);
      let evs = [];
      for (let i = 0; i < 80; i += 1) {
        if (existsSync(tp)) {
          evs = await readTranscript(tp);
          if (["failed", "completed", "aborted", "timed_out"].includes(findState(evs))) break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return evs;
    }
    const [mcpEvents, cliEvents] = await Promise.all([
      waitForTerminal(runDir, mcpRunId),
      waitForTerminal(cliRunDir, cliRunId),
    ]);

    // Same initial durable facts.
    assert.ok(findLatest(mcpEvents, "run.background_submitted"), "MCP wrote background_submitted");
    assert.ok(findLatest(cliEvents, "run.background_submitted"), "CLI wrote background_submitted");
    assert.ok(mcpEvents.some((e) => e.type === "run.state_change" && e.to === "pending"), "MCP pending");
    assert.ok(cliEvents.some((e) => e.type === "run.state_change" && e.to === "pending"), "CLI pending");
    // Same outcome type (both failed — nonexistent binary).
    assert.equal(findState(mcpEvents), "failed", "MCP failed terminal");
    assert.equal(findState(cliEvents), "failed", "CLI failed terminal");
  } finally {
    cleanupDir(dir);
  }
});

// ===== M9-7A: delivery-capable dispatch tests =====

test("M9-7A-04: MCP run_dispatch with delivery passes delivery to service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m97a-04-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    let callCount = 0;
    let captured = null;
    const fakeDispatch = async (input) => {
      callCount += 1;
      captured = input;
      return { accepted: true, runId: "run_delivery_m97a", agentId: "coder_low", state: "pending", transcriptPath: "/x.jsonl" };
    };
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs",
      workspaceRoot: dir,
      dispatchRunFn: fakeDispatch,
    });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({
      name: "run_dispatch",
      arguments: {
        agentId: "coder_low", prompt: "do it",
        delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] },
      },
    });
    assert.equal(callCount, 1);
    assert.ok(captured.delivery, "service received delivery");
    assert.equal(captured.delivery.mode, "git_commit_v1");
    assert.equal(captured.requireCertified, false, "certification advisory on delivery runs too (never forced)");
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.deepEqual(Object.keys(parsed).sort(),
      ["accepted", "agentId", "runId", "state", "workspaceProof"],
      "output has agentId (M11-8B) + additive workspaceProof (M12-6)");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("M9-7A-05: MCP delivery with both commands+reason rejected, service count 0", async () => {
  let callCount = 0;
  const fakeDispatch = async () => { callCount += 1; return { accepted: true, runId: "x", state: "pending" }; };
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs", dispatchRunFn: fakeDispatch,
  });
  const client = await buildInMemoryClient(server);
  try {
    let rejected = false;
    let result = null;
    try {
      result = await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "x", prompt: "y",
          delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"], verificationUnavailableReason: "no" },
        },
      });
    } catch { rejected = true; }
    if (!rejected) { assert.equal(result.isError, true, "both commands+reason rejected"); rejected = true; }
    assert.ok(rejected);
    assert.equal(callCount, 0, "service never called");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M9-7A-06: MCP delivery with no verification rejected, service count 0", async () => {
  let callCount = 0;
  const fakeDispatch = async () => { callCount += 1; return { accepted: true, runId: "x", state: "pending" }; };
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs", dispatchRunFn: fakeDispatch,
  });
  const client = await buildInMemoryClient(server);
  try {
    let rejected = false;
    let result = null;
    try {
      result = await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "x", prompt: "y",
          delivery: { mode: "git_commit_v1", allowedPaths: ["src"] },
        },
      });
    } catch { rejected = true; }
    if (!rejected) { assert.equal(result.isError, true); rejected = true; }
    assert.ok(rejected);
    assert.equal(callCount, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("M9-7A-07: non-delivery dispatch still works identically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m97a-07-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { x: { backend: "claude-code", cwd: dir } });
    let callCount = 0;
    let captured = null;
    const fakeDispatch = async (input) => {
      callCount += 1;
      captured = input;
      return { accepted: true, runId: "r", state: "pending" };
    };
    const server = createWaoMcpServer({
      registryPath, runDir: "/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatch,
    });
    const client = await buildInMemoryClient(server);
    try {
      await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "y" } });
      assert.equal(callCount, 1);
      assert.ok(!captured.delivery, "no delivery forwarded for non-delivery dispatch");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("M9-7A-08: empty/whitespace verification values rejected at adapter, service count 0", async () => {
  let callCount = 0;
  const fakeDispatch = async () => { callCount += 1; return { accepted: true, runId: "x", state: "pending" }; };
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs", dispatchRunFn: fakeDispatch,
  });
  const client = await buildInMemoryClient(server);
  try {
    const badInputs = [
      { agentId: "x", prompt: "y", delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: [] } },
      { agentId: "x", prompt: "y", delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["   "] } },
      { agentId: "x", prompt: "y", delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationUnavailableReason: "   " } },
    ];
    for (const bad of badInputs) {
      let rejected = false;
      let result = null;
      try { result = await client.callTool({ name: "run_dispatch", arguments: bad }); }
      catch { rejected = true; }
      if (!rejected) { assert.equal(result.isError, true, `rejected: ${JSON.stringify(Object.keys(bad.delivery || {}))}`); rejected = true; }
      assert.ok(rejected);
    }
    assert.equal(callCount, 0, "service never called for empty/whitespace delivery");
  } finally {
    await client.close();
    await server.close();
  }
});
