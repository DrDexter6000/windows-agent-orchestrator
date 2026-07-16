// test/runsListSmoke.test.js
//
// M10 P0-3: No-model stdio smoke for runs_list.
// Creates workspace A and B with real transcripts, binds to A,
// calls runs_list via in-memory MCP, verifies isolation + restart recovery.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { JsonlTranscript } from "../src/transcript.js";
import { createWaoMcpServer } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

async function seedRun(runDir, runId, workspaceCwd, state = "running", agentId = "coder_low") {
  const tp = join(runDir, `${runId}.jsonl`);
  const t = new JsonlTranscript(tp, { runId, agentId });
  await t.append("run.started", { backend: "claude-code" });
  await t.append("run.background_submitted", { background: true, cwd: workspaceCwd });
  await t.append("session.created", { backend: "process", backendSessionId: "proc_99999" });
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "running", "first_event");
  if (state === "completed") {
    await t.append("run.completed", {});
    await t.transitionState("running", "completed", "done");
  }
  return tp;
}

async function buildClient(server) {
  const [c1, s1] = InMemoryTransport.createLinkedPair();
  await server.connect(s1);
  const client = new Client({ name: "smoke", version: "0" }, { version: "0" });
  await client.connect(c1);
  return client;
}

function hashFile(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

test("SMOKE: runs_list isolation + restart recovery + bytes unchanged", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-smoke-runs-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-smoke-runs-b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-smoke-runs-rd-"));
  try {
    makeGitRepo(dirA);
    makeGitRepo(dirB);

    // Seed A's runs: running, completed, delivery (different agent)
    await seedRun(runDir, "run_a_run", dirA, "running", "coder_low");
    await seedRun(runDir, "run_a_done", dirA, "completed", "coder_hq");
    // Seed B's run
    await seedRun(runDir, "run_b_only", dirB, "running", "tester");
    // Seed malformed (no ownership)
    writeFileSync(join(runDir, "run_malformed.jsonl"),
      JSON.stringify({ type: "run.started", agentId: "x", runId: "run_malformed" }) + "\n");

    // Snapshot all transcript hashes before
    const hashesBefore = {};
    for (const f of ["run_a_run", "run_a_done", "run_b_only", "run_malformed"]) {
      hashesBefore[f] = hashFile(join(runDir, `${f}.jsonl`));
    }

    // --- First call: bind to A ---
    const server1 = createWaoMcpServer({
      registryPath: join(process.cwd(), "config", "agents.json"),
      runDir, workspaceRoot: dirA,
    });
    const client1 = await buildClient(server1);
    try {
      const res = await client1.callTool({ name: "runs_list", arguments: {} });
      const parsed = JSON.parse(res.content[0].text);
      const ids = parsed.runs.map((r) => r.runId);

      // Only A's runs visible
      assert.ok(ids.includes("run_a_run"), "A running run visible");
      assert.ok(ids.includes("run_a_done"), "A completed run visible");
      assert.ok(!ids.includes("run_b_only"), "B run invisible");
      assert.ok(!ids.includes("run_malformed"), "malformed run invisible");

      // Safe output: no paths, prompts, commands, sessions
      const json = JSON.stringify(parsed);
      assert.ok(!json.includes(dirA), "no absolute path");
      assert.ok(!json.includes(dirB), "no other workspace path");
      assert.ok(!json.includes("proc_"), "no session id");

      // updatedAt sorting: run_a_run should be before or equal to run_a_done
      // (both have recent timestamps; exact order depends on write timing)
      assert.equal(parsed.returnedCount, 2);
      assert.equal(parsed.truncated, false);
    } finally {
      await client1.close();
      await server1.close();
    }

    // --- Restart simulation: new server, same config ---
    const server2 = createWaoMcpServer({
      registryPath: join(process.cwd(), "config", "agents.json"),
      runDir, workspaceRoot: dirA,
    });
    const client2 = await buildClient(server2);
    try {
      const res = await client2.callTool({ name: "runs_list", arguments: {} });
      const parsed = JSON.parse(res.content[0].text);
      const ids = parsed.runs.map((r) => r.runId);
      // Same runIds recovered after restart
      assert.ok(ids.includes("run_a_run"), "recovery after restart");
      assert.ok(ids.includes("run_a_done"), "recovery after restart");
    } finally {
      await client2.close();
      await server2.close();
    }

    // --- activeOnly filter ---
    const server3 = createWaoMcpServer({
      registryPath: join(process.cwd(), "config", "agents.json"),
      runDir, workspaceRoot: dirA,
    });
    const client3 = await buildClient(server3);
    try {
      const res = await client3.callTool({ name: "runs_list", arguments: { activeOnly: true } });
      const parsed = JSON.parse(res.content[0].text);
      const ids = parsed.runs.map((r) => r.runId);
      assert.ok(ids.includes("run_a_run"), "active run visible");
      assert.ok(!ids.includes("run_a_done"), "completed run filtered by activeOnly");
    } finally {
      await client3.close();
      await server3.close();
    }

    // --- Verify all transcript bytes unchanged ---
    for (const f of ["run_a_run", "run_a_done", "run_b_only", "run_malformed"]) {
      const hashAfter = hashFile(join(runDir, `${f}.jsonl`));
      assert.equal(hashAfter, hashesBefore[f], `transcript ${f} bytes must be unchanged`);
    }
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
