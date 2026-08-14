// test/mcpRunDeliveryReverify.test.js
//
// M12-6 Package 3B2a: MCP run_delivery_reverify transport contract.
//
// A Lead invokes ONE audited unchanged-artifact re-verification over MCP:
//   - exactly one tool `run_delivery_reverify`, strict input (runId + closed-set
//     reason + bounded optional setupCommands/timeoutMs), workspace-bound;
//   - the handler delegates to the existing application service (runDeliveryReverify)
//     and returns the PARSED strict safe output (runId, exact deliveryCommit,
//     created|resumed|idempotent, reason, passed|failed|unavailable, nullable
//     closed-set failureCode, requested, outcomeRecorded) — never commands, paths,
//     stderr, credentials, raw events, environment, or unknown keys;
//   - malformed input / service throw collapse to the fixed safe error;
//   - unknown service fields are stripped; invalid closed-set values are rejected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { createWaoMcpServer } from "../../src/mcp/server.js";
import {
  REVERIFY_REASONS,
  REVERIFY_SETUP_COMMANDS_LIMIT,
  REVERIFY_SETUP_COMMAND_MAX_LENGTH,
  REVERIFY_TIMEOUT_MS_MIN,
  REVERIFY_TIMEOUT_MS_MAX,
  runDeliveryReverify,
} from "../../src/application/runDeliveryReverify.js";
import { resolveDeliveryCommit } from "../../src/delivery.js";
import { verifyDelivery } from "../../src/deliveryVerification.js";
import { readTranscript } from "../../src/transcript.js";
import { proveWorkspace } from "../../src/application/workspaceBinding.js";

// ===== real-git helpers (mirror runDeliveryReverify.test.js) =====

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  }).trim();
}

async function cleanupDirAsync(dir) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt === 5) return;
      await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
    }
  }
}

async function makeRepo(prefix = "3b2a-rv-repo-") {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@test"], repo);
  git(["config", "user.name", "test"], repo);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "a.js"), "const a = 1;\n");
  await writeFile(join(repo, ".gitignore"), "node_modules/\n.wao-worktrees/\n");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
  const baseCommit = git(["rev-parse", "HEAD"], repo);
  return { repo, baseCommit };
}

function makeLinkedWorktree(repo, runId) {
  const worktreePath = join(repo, ".wao-worktrees", runId);
  git(["worktree", "add", worktreePath, "-b", `wao/${runId}`], repo);
  return worktreePath;
}

function seedTranscript(runDir, runId, agentId, events) {
  const filePath = join(runDir, `${runId}.jsonl`);
  const lines = events.map((e, i) => JSON.stringify({
    ts: "2026-08-01T00:00:00.000Z",
    seq: i + 1,
    runId,
    agentId,
    ...e,
  }));
  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

function ok() {
  return { exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 };
}
function fail() {
  return { exitCode: 1, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 };
}

/** After "setup-prepare" runs, "assert-needs-setup" flips to passing. */
function makeFixingRunCommand() {
  let setupRan = false;
  return async (command) => {
    if (command === "setup-prepare") { setupRan = true; return ok(); }
    if (command === "assert-needs-setup") return setupRan ? ok() : fail();
    return fail();
  };
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// A real Git worktree top-level with a valid HEAD — required by the
// workspace-binding proof (proveWorkspace) for workspace-bound tools.
function makeGitRepo(dir) {
  git(["init", "-q"], dir);
  git(["config", "user.email", "t@t"], dir);
  git(["config", "user.name", "T"], dir);
  writeFileSync(join(dir, "R.md"), "x\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "i"], dir);
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

// A fake service result carrying every sensitive field the MCP must NOT expose.
function sensitiveReverifyResult() {
  return {
    runId: "run_x",
    deliveryCommit: "d".repeat(40),
    state: "created",
    reason: "tooling_invalid",
    verificationStatus: "passed",
    failureCode: null,
    requested: true,
    outcomeRecorded: true,
    // Sensitive internals the transport must strip / never echo:
    worktreePath: "C:\\Users\\owner\\secret\\worktree",
    commands: ["npm test -- --run"],
    setupCommands: ["set MY_FLAG=1"],
    stderr: "secret stderr line",
    env: { MY_SECRET_KEY: "AKIAIOSFODNN7EXAMPLE" },
    rawEvents: [{ type: "run.delivery_reverification_passed", delivery: {} }],
  };
}

function serverWith(fakeFn, opts = {}) {
  return createWaoMcpServer({
    registryPath: "/r.json",
    runDir: opts.runDir ?? "/runs",
    workspaceRoot: opts.workspaceRoot ?? undefined,
    runDeliveryReverifyFn: fakeFn,
  });
}

test("3B2a-RV-01: exactly one run_delivery_reverify tool, strict bounded input + annotations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "3b2a-rv-01-"));
  try {
    const rp = join(dir, "agents.json");
    writeFileSync(rp, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const server = createWaoMcpServer({ registryPath: rp, runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const tools = await client.listTools();
      const matches = tools.tools.filter((t) => t.name === "run_delivery_reverify");
      assert.equal(matches.length, 1, "exactly one run_delivery_reverify tool");

      const t = matches[0];
      assert.equal(t.annotations.readOnlyHint, false, "appends transcript events + runs commands");
      assert.equal(t.annotations.destructiveHint, true, "destructive: appends durable events");
      assert.equal(t.annotations.idempotentHint, true, "reentrant/crash-safe — converges in outcome");
      assert.equal(t.annotations.openWorldHint, false, "workspace-bound, no external network");

      // Strict input: only runId + reason + bounded setupCommands/timeoutMs.
      const props = t.inputSchema.properties;
      assert.deepEqual(Object.keys(props).sort(), ["reason", "runId", "setupCommands", "timeoutMs"]);
      assert.equal(t.inputSchema.additionalProperties, false, "strict object");
      assert.equal(props.runId.type, "string");
      assert.deepEqual(props.reason.enum, REVERIFY_REASONS,
        "reason enum = exported REVERIFY_REASONS SSOT");
      assert.deepEqual(props.setupCommands.items.enum, undefined);
      assert.equal(props.setupCommands.maxItems, REVERIFY_SETUP_COMMANDS_LIMIT,
        "setupCommands capped by exported constant");
      assert.equal(props.setupCommands.items.maxLength, REVERIFY_SETUP_COMMAND_MAX_LENGTH,
        "setup command length capped by exported constant");
      assert.equal(props.timeoutMs.minimum, REVERIFY_TIMEOUT_MS_MIN,
        "timeoutMs min = exported constant");
      assert.equal(props.timeoutMs.maximum, REVERIFY_TIMEOUT_MS_MAX,
        "timeoutMs max = exported constant");
    } finally {
      await client.close();
      await server.close();
    }
  } finally { cleanupDir(dir); }
});

test("3B2a-RV-02: success — service called once with server-owned runDir + bound workspace, parsed safe output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "3b2a-rv-02-"));
  try {
    makeGitRepo(dir);
    let calls = 0;
    let captured = null;
    const server = serverWith(async (input) => {
      calls += 1;
      captured = input;
      return sensitiveReverifyResult();
    }, { runDir: "/server/runs", workspaceRoot: dir });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_delivery_reverify",
        arguments: { runId: "run_x", reason: "tooling_invalid", setupCommands: ["npm ci"], timeoutMs: 5000 },
      });
      assert.equal(res.isError, undefined, "success is not an error");
      assert.equal(calls, 1);
      assert.equal(captured.runId, "run_x");
      assert.equal(captured.runDir, "/server/runs", "runDir is server-owned");
      assert.equal(captured.authorizedWorkspaceRoot, proveWorkspace(dir).root, "workspace binding is the server-owned proved root");
      assert.equal(captured.reason, "tooling_invalid");
      assert.deepEqual(captured.setupCommands, ["npm ci"]);
      assert.equal(captured.timeoutMs, 5000);

      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.deepEqual(
        new Set(Object.keys(parsed)),
        new Set(["runId", "deliveryCommit", "state", "reason", "verificationStatus", "failureCode", "requested", "outcomeRecorded"]),
        "exact safe output key set",
      );
      assert.equal(parsed.runId, "run_x");
      assert.equal(parsed.deliveryCommit, "d".repeat(40), "exact deliveryCommit");
      assert.equal(parsed.state, "created");
      assert.equal(parsed.reason, "tooling_invalid");
      assert.equal(parsed.verificationStatus, "passed");
      assert.equal(parsed.failureCode, null);
      assert.equal(parsed.requested, true);
      assert.equal(parsed.outcomeRecorded, true);
      if (res.structuredContent) assert.deepEqual(res.structuredContent, parsed);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { cleanupDir(dir); }
});

test("3B2a-RV-03: strict output — sensitive internals stripped, never echoed", async () => {
  const server = serverWith(async () => sensitiveReverifyResult(), { workspaceRoot: "/ws" });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({
      name: "run_delivery_reverify",
      arguments: { runId: "run_x", reason: "environment_contaminated" },
    });
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes("worktreePath"), "no worktreePath");
    assert.ok(!dumped.includes("C:\\\\Users"), "no absolute path");
    assert.ok(!dumped.includes("npm test"), "no commands");
    assert.ok(!dumped.includes("MY_FLAG"), "no setup commands");
    assert.ok(!dumped.includes("stderr"), "no stderr");
    assert.ok(!dumped.includes("MY_SECRET_KEY"), "no env names");
    assert.ok(!dumped.includes("AKIA"), "no secret values");
    assert.ok(!dumped.includes("rawEvents"), "no raw events");
    assert.ok(!dumped.includes("run.delivery_reverification_passed"), "no raw event types");
  } finally {
    await client.close();
    await server.close();
  }
});

test("3B2a-RV-04: malformed input rejected with zero service calls", async () => {
  let calls = 0;
  const server = serverWith(async () => { calls += 1; return sensitiveReverifyResult(); }, { workspaceRoot: "/ws" });
  const client = await buildInMemoryClient(server);
  try {
    const vectors = [
      ["bad reason", { runId: "r", reason: "hacked" }],
      ["missing reason", { runId: "r" }],
      ["bad runId", { runId: "", reason: "tooling_invalid" }],
      ["missing runId", { reason: "tooling_invalid" }],
      ["setupCommands not array", { runId: "r", reason: "tooling_invalid", setupCommands: "npm ci" }],
      ["setupCommands too many", { runId: "r", reason: "tooling_invalid", setupCommands: Array.from({ length: REVERIFY_SETUP_COMMANDS_LIMIT + 1 }, (_, i) => `cmd${i}`) }],
      ["setup command too long", { runId: "r", reason: "tooling_invalid", setupCommands: ["x".repeat(REVERIFY_SETUP_COMMAND_MAX_LENGTH + 1)] }],
      ["setup command empty", { runId: "r", reason: "tooling_invalid", setupCommands: ["   "] }],
      ["timeoutMs below min", { runId: "r", reason: "tooling_invalid", timeoutMs: REVERIFY_TIMEOUT_MS_MIN - 1 }],
      ["timeoutMs above max", { runId: "r", reason: "tooling_invalid", timeoutMs: REVERIFY_TIMEOUT_MS_MAX + 1 }],
      ["timeoutMs fractional", { runId: "r", reason: "tooling_invalid", timeoutMs: 1.5 }],
      ["extra key runDir", { runId: "r", reason: "tooling_invalid", runDir: "/evil" }],
      ["extra key force", { runId: "r", reason: "tooling_invalid", force: true }],
      ["extra key raw", { runId: "r", reason: "tooling_invalid", raw: true }],
    ];
    for (const [label, args] of vectors) {
      let rejected = false;
      let result = null;
      try { result = await client.callTool({ name: "run_delivery_reverify", arguments: args }); }
      catch { rejected = true; }
      if (!rejected) { assert.equal(result.isError, true, `${label}: must be isError`); rejected = true; }
      assert.ok(rejected, `${label}: must be rejected`);
    }
    assert.equal(calls, 0, "service never called for malformed input");
  } finally {
    await client.close();
    await server.close();
  }
});

test("3B2a-RV-05: service throw → fixed safe error, no leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "3b2a-rv-05-"));
  try {
    makeGitRepo(dir);
    const server = serverWith(async () => { throw new Error("C:\\secret\\path and AKIAIOSFODNN7EXAMPLE and stderr"); }, { workspaceRoot: dir });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_delivery_reverify",
        arguments: { runId: "run_x", reason: "tooling_invalid" },
      });
      assert.equal(res.isError, true);
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes("secret"), "no path leak");
      assert.ok(!dumped.includes("AKIA"), "no token leak");
      assert.ok(!dumped.includes("stderr"), "no stderr leak");
      const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.ok(/run_delivery_reverify failed/.test(text), "fixed safe text");
    } finally {
      await client.close();
      await server.close();
    }
  } finally { cleanupDir(dir); }
});

test("3B2a-RV-06: invalid service values rejected — output rejection policy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "3b2a-rv-06-"));
  try {
    makeGitRepo(dir);
    const vectors = [
      ["bad state", { state: "evil" }],
      ["bad verificationStatus", { verificationStatus: "weird" }],
      ["bad failureCode", { failureCode: "hacked" }],
      ["bad reason", { reason: "hacked" }],
      ["bad deliveryCommit", { deliveryCommit: "not-a-hash" }],
      ["requested not boolean", { requested: "yes" }],
      ["outcomeRecorded not boolean", { outcomeRecorded: 1 }],
    ];
    for (const [label, over] of vectors) {
      const server = serverWith(async () => ({ ...sensitiveReverifyResult(), ...over }), { workspaceRoot: dir });
      const client = await buildInMemoryClient(server);
      try {
        const res = await client.callTool({
          name: "run_delivery_reverify",
          arguments: { runId: "run_x", reason: "tooling_invalid" },
        });
        assert.equal(res.isError, true, `${label}: invalid service value must collapse to fixed error`);
        const dumped = JSON.stringify(res);
        assert.ok(!dumped.includes("evil"), `${label}: no bad value`);
        assert.ok(!dumped.includes("hacked"), `${label}: no bad value`);
        assert.ok(!dumped.includes("weird"), `${label}: no bad value`);
        assert.ok(!dumped.includes("not-a-hash"), `${label}: no bad value`);
        const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
        assert.ok(/run_delivery_reverify failed/.test(text), `${label}: fixed text`);
      } finally { await client.close(); await server.close(); }
    }
  } finally { cleanupDir(dir); }
});

test("3B2a-RV-07: workspace-bound — no binding → fixed error, service not called", async () => {
  let calls = 0;
  const server = serverWith(async () => { calls += 1; return sensitiveReverifyResult(); });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({
      name: "run_delivery_reverify",
      arguments: { runId: "run_x", reason: "tooling_invalid" },
    });
    assert.equal(res.isError, true, "no binding → error");
    assert.equal(calls, 0, "service never called without workspace binding");
    const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
    assert.ok(/workspace|bound/i.test(text), "error mentions workspace not bound");
  } finally {
    await client.close();
    await server.close();
  }
});

test("3B2a-RV-08: invalid runId rejected before service (zero calls)", async () => {
  let calls = 0;
  const server = serverWith(async () => { calls += 1; return sensitiveReverifyResult(); }, { workspaceRoot: "/ws" });
  const client = await buildInMemoryClient(server);
  try {
    let rejected = false;
    let result = null;
    try { result = await client.callTool({ name: "run_delivery_reverify", arguments: { runId: "../escape", reason: "tooling_invalid" } }); }
    catch { rejected = true; }
    if (!rejected) { assert.equal(result.isError, true); rejected = true; }
    assert.ok(rejected);
    assert.equal(calls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("3B2a-RV-09: description does not leak commands/paths and never auto-accepts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "3b2a-rv-09-"));
  try {
    const rp = join(dir, "agents.json");
    writeFileSync(rp, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const server = createWaoMcpServer({ registryPath: rp, runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((x) => x.name === "run_delivery_reverify");
      const d = JSON.stringify((t.description ?? "").toLowerCase());
      for (const bad of ["auto-accept", "auto accept", "merge", "push", "worktree path", "stderr"]) {
        assert.ok(!d.includes(bad), `description must not contain '${bad}'`);
      }
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

test("3B2a-RV-10 (real service + real git): reverify over MCP records one audited chain, effective pass, then explicit accept", async () => {
  const RUN_ID = "run_3b2a_mcp_e2e";
  const AGENT_ID = "coder_low";
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "3b2a-rv-runs-"));
  const worktreePath = makeLinkedWorktree(repo, RUN_ID);
  try {
    // A real change within allowedPaths, left UNSTAGED so the packager owns staging.
    await writeFile(join(worktreePath, "src", "a.js"), "const a = 2;\n");

    const deliveryInput = {
      runId: RUN_ID,
      worktreePath,
      baseCommit,
      isolation: { type: "worktree", strategy: "persistent" },
      allowedPaths: ["src"],
      verificationCommands: ["assert-needs-setup"],
    };
    const { ref: deliveryRef } = resolveDeliveryCommit(deliveryInput);
    const deliveryCommit = deliveryRef.deliveryCommit;

    // ORIGINAL verification FAILED with an eligible code (command_failed).
    const originalRef = {
      ...deliveryRef,
      verification: {
        ...deliveryRef.verification,
        status: "failed",
        failureCode: "command_failed",
        verifiedCommit: deliveryCommit,
        results: [],
      },
    };
    seedTranscript(runDir, RUN_ID, AGENT_ID, [
      { type: "run.background_submitted", cwd: repo, deliveryRequested: true },
      {
        type: "run.started",
        backend: "test",
        cwd: repo,
        worktreePath,
        worktreeBranch: `wao/${RUN_ID}`,
        delivery: { mode: "git_commit_v1", baseCommit, allowedPaths: ["src"], verificationCommands: ["assert-needs-setup"] },
      },
      { type: "run.delivery_created", delivery: deliveryRef, deliveryCommit },
      { type: "run.completed" },
      { type: "run.state_change", from: "running", to: "completed", reason: "completed" },
      { type: "run.delivery_verification_failed", delivery: originalRef, deliveryCommit },
    ]);

    // The MCP server wires the REAL service, with a deterministic command runner.
    const server = createWaoMcpServer({
      registryPath: "/r.json",
      runDir,
      workspaceRoot: repo,
      runDeliveryReverifyFn: (input) => runDeliveryReverify({
        ...input,
        verifyDeliveryFn: (ref, opts) => verifyDelivery(ref, { ...opts, runCommand: makeFixingRunCommand() }),
      }),
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_delivery_reverify",
        arguments: { runId: RUN_ID, reason: "tooling_invalid", setupCommands: ["setup-prepare"], timeoutMs: 30000 },
      });
      assert.equal(res.isError, undefined, "reverify succeeds");
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.runId, RUN_ID);
      assert.equal(parsed.deliveryCommit, deliveryCommit, "exact deliveryCommit");
      assert.equal(parsed.state, "created");
      assert.equal(parsed.reason, "tooling_invalid");
      assert.equal(parsed.verificationStatus, "passed");
      assert.equal(parsed.failureCode, null);
      assert.equal(parsed.requested, true);
      assert.equal(parsed.outcomeRecorded, true);
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes("assert-needs-setup"), "no assertion commands leak");
      assert.ok(!dumped.includes("setup-prepare"), "no setup commands leak");
      assert.ok(!dumped.includes(worktreePath), "no worktree path leak");

      // Exactly one requested + one outcome appended (audited chain).
      const events = await readTranscript(join(runDir, `${RUN_ID}.jsonl`));
      assert.equal(events.filter((e) => e.type === "run.delivery_reverification_requested").length, 1);
      assert.equal(events.filter((e) => e.type === "run.delivery_reverification_passed").length, 1);

      // run_delivery: original failed stays visible, effective passed, chain complete.
      const rd = await client.callTool({ name: "run_delivery", arguments: { runId: RUN_ID } });
      const rdParsed = JSON.parse(rd.content.find((b) => b.type === "text").text);
      assert.equal(rdParsed.verificationStatus, "failed", "old verificationStatus semantics preserved (original)");
      assert.equal(rdParsed.originalVerificationStatus, "failed");
      assert.equal(rdParsed.effectiveVerificationStatus, "passed");
      assert.deepEqual(rdParsed.reverify, { status: "complete", reason: "tooling_invalid" });

      // The Lead may then EXPLICITLY accept the effective-passed delivery.
      const dc = await client.callTool({
        name: "run_delivery_decide",
        arguments: { runId: RUN_ID, decision: "accepted", reason: "reverify passed" },
      });
      assert.equal(dc.isError, undefined, "explicit accept after passed reverify is not an error");
      const dcParsed = JSON.parse(dc.content.find((b) => b.type === "text").text);
      assert.equal(dcParsed.decisionAccepted, true);
      assert.equal(dcParsed.rejectionReason, null);
      const events2 = await readTranscript(join(runDir, `${RUN_ID}.jsonl`));
      assert.equal(events2.filter((e) => e.type === "run.delivery_accepted").length, 1);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await cleanupDirAsync(runDir);
    try { git(["worktree", "remove", "--force", worktreePath], repo); } catch {}
    await cleanupDirAsync(repo);
  }
});
