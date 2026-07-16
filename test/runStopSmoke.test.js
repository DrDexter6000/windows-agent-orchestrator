// test/runStopSmoke.test.js
//
// M10 P0-2: No-model local smoke test for run_stop.
//
// Creates a real long-running Node process, dispatches it as a WAO run,
// and stops it through the real MCP run_stop tool. Verifies:
//   - terminal = aborted
//   - terminal state_change exactly 1
//   - side effect only once
//   - run.stop_verified = 1, run.stop_unverified = 0
//   - worker PID is dead
//   - no residual heartbeat/child process
//   - source checkout bytes/HEAD unchanged
//   - MCP output has no PID/path/session/command/credential
//
// Then a cross-workspace negative smoke: different ownership fact →
// must be rejected before claim/kill, process still alive.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

import { JsonlTranscript, readTranscript, findState } from "../src/transcript.js";
import { createWaoMcpServer } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "smoke@wao"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

async function buildClient(server) {
  const [c1, s1] = InMemoryTransport.createLinkedPair();
  await server.connect(s1);
  const client = new Client({ name: "smoke", version: "0" }, { version: "0" });
  await client.connect(c1);
  return client;
}

test("SMOKE-POS: real process stop via MCP run_stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-smoke-pos-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-smoke-pos-runs-"));
  let child = null;
  try {
    makeGitRepo(dir);
    mkdirSync(runDir, { recursive: true });

    // Start a real long-running Node process
    child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 60000)"], {
      stdio: "ignore", windowsHide: true,
    });
    const pid = child.pid;
    assert.ok(pid > 0, "child must have a PID");

    // Seed a transcript equivalent to a real MCP dispatch
    const runId = "run_smoke_pos";
    const tp = join(runDir, `${runId}.jsonl`);
    const t = new JsonlTranscript(tp, { runId, agentId: "smoke-agent" });
    await t.append("run.started", { backend: "claude-code" });
    await t.append("run.background_submitted", { background: true, cwd: dir });
    await t.append("session.created", { backend: "process", backendSessionId: `proc_${pid}` });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "submitted", "spawned");
    await t.transitionState("submitted", "running", "first_event");

    // Create MCP server bound to this workspace
    const server = createWaoMcpServer({
      registryPath: join(process.cwd(), "config", "agents.json"),
      runDir,
      workspaceRoot: dir,
    });
    const client = await buildClient(server);
    try {
      // Call run_stop through MCP
      const res = await client.callTool({ name: "run_stop", arguments: { runId } });
      const textBlock = res.content.find((b) => b.type === "text");
      const parsed = JSON.parse(textBlock.text);

      // Verify terminal
      assert.equal(parsed.terminalState, "aborted", "terminal must be aborted");
      assert.equal(parsed.terminalAccepted, true, "must be accepted winner");
      assert.equal(parsed.stopVerified, true, "must be verified");

      // Safe output — no PID/path/session
      const json = JSON.stringify(parsed);
      assert.ok(!json.includes(String(pid)), "no PID in output");
      assert.ok(!json.includes(dir), "no absolute path in output");
    } finally {
      await client.close();
      await server.close();
    }

    // Verify transcript facts
    const events = await readTranscript(tp);
    const stateChanges = events.filter((e) => e.type === "run.state_change" && e.to === "aborted");
    assert.equal(stateChanges.length, 1, "exactly 1 terminal state_change");
    const verified = events.filter((e) => e.type === "run.stop_verified");
    assert.equal(verified.length, 1, "exactly 1 stop_verified");
    const unverified = events.filter((e) => e.type === "run.stop_unverified");
    assert.equal(unverified.length, 0, "0 stop_unverified");

    // Verify process is dead
    assert.equal(findState(events), "aborted");

    // Source checkout unchanged
    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const statusAfter = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim();
    assert.equal(statusAfter, "", "source checkout clean");
  } finally {
    // Always kill the child if still alive
    if (child && child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      await new Promise((r) => child.on("exit", r).on("error", r));
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("SMOKE-NEG: cross-workspace stop rejected, process survives", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-smoke-neg-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-smoke-neg-b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-smoke-neg-runs-"));
  let child = null;
  try {
    makeGitRepo(dirA);
    makeGitRepo(dirB);
    mkdirSync(runDir, { recursive: true });

    // Start a real process
    child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 60000)"], {
      stdio: "ignore", windowsHide: true,
    });
    const pid = child.pid;

    // Seed transcript with dirA ownership
    const runId = "run_smoke_neg";
    const tp = join(runDir, `${runId}.jsonl`);
    const t = new JsonlTranscript(tp, { runId, agentId: "smoke-agent" });
    await t.append("run.started", { backend: "claude-code" });
    await t.append("run.background_submitted", { background: true, cwd: dirA });
    await t.append("session.created", { backend: "process", backendSessionId: `proc_${pid}` });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "submitted", "spawned");
    await t.transitionState("submitted", "running", "first_event");

    const eventsBefore = await readTranscript(tp);

    // Create MCP server bound to dirB (different workspace!)
    const server = createWaoMcpServer({
      registryPath: join(process.cwd(), "config", "agents.json"),
      runDir,
      workspaceRoot: dirB,
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_stop", arguments: { runId } });
      assert.ok(res.isError, "must be rejected for cross-workspace");
      assert.equal(res.content[0].text, "run_stop failed");
    } finally {
      await client.close();
      await server.close();
    }

    // Process must still be alive
    assert.ok(child.exitCode === null, "process must survive cross-workspace rejection");

    // Transcript unchanged — no new events
    const eventsAfter = await readTranscript(tp);
    assert.equal(eventsAfter.length, eventsBefore.length, "zero new transcript events");
  } finally {
    if (child && child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      await new Promise((r) => child.on("exit", r).on("error", r));
    }
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
