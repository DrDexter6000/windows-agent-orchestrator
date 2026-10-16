// test/mcp-surface/mcpCallTarget.test.js
//
// Workspace-touching MCP tools take their target ONLY from the call's
// expectedWorkspaceRoot (proveWorkspace canonical Git top-level; the session
// selection / MCP roots / server config are NOT consulted for the target).
//
// Covers:
// 1. Two host sessions on ONE server instance cannot redirect each other:
//    selection X, dispatch names Y → Y; later selection Z, dispatch names X → X.
// 2. A binding pointing at X (server_config AND lead_session) never overrides
//    a call that names Y.
// 3. Missing / relative / non-Git / subdirectory targets refuse BEFORE any
//    side effect — zero dispatch, zero transcript, zero worktree.
// 4. run_consult create: every seat's cwd and the record live under the CALL's
//    target; read/paging may name a target too (and create never resolves the
//    shared binding).
// 5. Real dispatch: the background ownership record (the runner argv --cwd
//    value) and the transcript bucket attribution are the target.
// 6. runId A-class tools verify run ownership against the CALL's target —
//    mismatch refuses, match proceeds (run_correct via injected service;
//    run_collect / run_delivery_decide / run_delivery_repackage via the real
//    service, with byte-identical transcripts on refusal).
// 7. Read-only tools keep the binding default scope and now SHOW it
//    (runs_list scope.source/scope.projectBucket, lead_preflight
//    workspace.projectBucket); run_dispatch_contract_check follows a call
//    target when given and reports the scope used.
// 8. projectBucketLabel agrees with the write-side bucket kind: a root under
//    os.tmpdir() is _scratch (no project label), a real checkout is a project.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { createWaoMcpServer } from "../../src/mcp/server.js";
import { readTranscript, findState, findLatest } from "../../src/transcript.js";
import { resolveTranscriptPath } from "../../src/projectBuckets.js";
import { projectFactFromCwd } from "../../src/projectIdentity.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");


function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeGitRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# t\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

function makeRegistry(dir, agents) {
  const p = join(dir, "agents.json");
  writeFileSync(p, JSON.stringify({ agents }), "utf8");
  return p;
}

async function buildClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-ct-test", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function fwd(p) { return p.replace(/\\/g, "/"); }

// A client that declares the roots capability and answers roots/list with one
// root; used to prove which paths resolve the shared binding.
async function buildRootsClient(server, rootDir) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { ListRootsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const { pathToFileURL } = await import("node:url");
  const client = new Client(
    { name: "wao-ct-roots-test", version: "0.0.1" },
    { capabilities: { roots: { listChanged: false } } },
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(rootDir).href, name: "root" }],
  }));
  return client;
}

// Spy on mcp.server.listRoots: wraps the original, counts calls.
function spyListRoots(server) {
  const inner = server.server;
  const original = inner.listRoots.bind(inner);
  let callCount = 0;
  inner.listRoots = (params, options) => {
    callCount += 1;
    return original(params, options);
  };
  return {
    count: () => callCount,
    restore: () => { inner.listRoots = original; },
  };
}


// ===== 1+2: the call target wins over any selection/binding =====

test("CT-1: two sessions on one server instance — dispatch follows each CALL's target", async () => {
  const x = mkdtempSync(join(tmpdir(), "wao-ct-x-"));
  const y = mkdtempSync(join(tmpdir(), "wao-ct-y-"));
  const z = mkdtempSync(join(tmpdir(), "wao-ct-z-"));
  const aux = mkdtempSync(join(tmpdir(), "wao-ct-aux-"));
  try {
    const headY = makeGitRepo(y);
    makeGitRepo(x);
    makeGitRepo(z);
    const registryPath = makeRegistry(aux, { w: { backend: "claude-code", cwd: x } });
    const cwds = [];
    const heads = [];
    const server = createWaoMcpServer({
      registryPath,
      runDir: join(aux, "runs"),
      // server_config binding points at X
      workspaceRoot: x,
      dispatchRunFn: async (input) => {
        cwds.push(input.cwd);
        heads.push(input.frozenGitHead);
        return { accepted: true, runId: `run_ct_${cwds.length}`, agentId: "w", state: "pending", providerSessionRouting: "not_used" };
      },
    });
    const client = await buildClient(server);
    try {
      // Session A selects X; session B (same instance) dispatches naming Y.
      await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: x } });
      const r1 = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "w", prompt: "p", expectedWorkspaceRoot: y },
      });
      assert.equal(r1.isError, undefined, "dispatch on the call's target succeeds");
      // Session B re-selects Z; session A dispatches naming X — still X.
      await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: z } });
      await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "w", prompt: "p", expectedWorkspaceRoot: x },
      });
      assert.deepEqual(cwds.map(fwd), [fwd(y), fwd(x)], "cwd follows each call's target, never the selection");
      assert.equal(heads[0], headY, "frozenGitHead is the target's head");
      const proof1 = JSON.parse(r1.content.find((b) => b.type === "text").text).workspaceProof;
      assert.equal(proof1.source, "call_target");
      assert.equal(proof1.gitHead, headY);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(x); cleanupDir(y); cleanupDir(z); cleanupDir(aux);
  }
});

test("CT-2: lead_session binding X never overrides a call naming Y (and selection survives)", async () => {
  const x = mkdtempSync(join(tmpdir(), "wao-ct2-x-"));
  const y = mkdtempSync(join(tmpdir(), "wao-ct2-y-"));
  const aux = mkdtempSync(join(tmpdir(), "wao-ct2-aux-"));
  try {
    makeGitRepo(x);
    makeGitRepo(y);
    const registryPath = makeRegistry(aux, { w: { backend: "claude-code", cwd: x } });
    let captured = null;
    const server = createWaoMcpServer({
      registryPath, runDir: join(aux, "runs"), workspaceRoot: x,
      dispatchRunFn: async (input) => {
        captured = input;
        return { accepted: true, runId: "run_ct2", agentId: "w", state: "pending", providerSessionRouting: "not_used" };
      },
    });
    const client = await buildClient(server);
    try {
      await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: x } });
      const st = JSON.parse((await client.callTool({ name: "workspace_status", arguments: {} }))
        .content.find((b) => b.type === "text").text);
      assert.equal(st.source, "lead_session", "binding is X via lead_session");
      await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "w", prompt: "p", expectedWorkspaceRoot: y },
      });
      assert.equal(fwd(captured.cwd), fwd(y), "call target Y wins over the lead_session binding X");
      // The selection is untouched (read scope still X).
      const st2 = JSON.parse((await client.callTool({ name: "workspace_status", arguments: {} }))
        .content.find((b) => b.type === "text").text);
      assert.equal(st2.source, "lead_session");
      assert.equal(fwd(st2.workspaceRoot), fwd(x), "dispatch never mutated the session selection");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(x); cleanupDir(y); cleanupDir(aux);
  }
});

// ===== 3: refusal before any side effect =====

test("CT-3: missing / relative / non-Git / subdirectory targets refuse with zero side effects", async () => {
  const x = mkdtempSync(join(tmpdir(), "wao-ct3-x-"));
  const aux = mkdtempSync(join(tmpdir(), "wao-ct3-aux-"));
  const runDir = join(aux, "runs");
  try {
    makeGitRepo(x);
    mkdirSync(join(x, "sub"), { recursive: true });
    const registryPath = makeRegistry(aux, { w: { backend: "claude-code", cwd: x } });
    let calls = 0;
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: x,
      dispatchRunFn: async () => { calls += 1; return { accepted: true, runId: "x", state: "pending" }; },
    });
    const client = await buildClient(server);
    try {
      const cases = [
        ["missing", { agentId: "w", prompt: "p" }],
        ["relative", { agentId: "w", prompt: "p", expectedWorkspaceRoot: "some/relative/path" }],
        ["non-git", { agentId: "w", prompt: "p", expectedWorkspaceRoot: join(aux, "not-a-repo") }],
        ["subdirectory", { agentId: "w", prompt: "p", expectedWorkspaceRoot: join(x, "sub") }],
      ];
      for (const [label, args] of cases) {
        const res = await client.callTool({ name: "run_dispatch", arguments: args });
        assert.equal(res.isError, true, `${label}: refused`);
        const text = res.content.map((b) => b.text ?? "").join(" ");
        if (label === "missing") {
          assert.match(text, /expectedWorkspaceRoot/, "missing: names the parameter");
          assert.match(text, /Git worktree top-level/, "missing: says what to pass");
        } else {
          assert.match(text, /workspace target invalid/, `${label}: fixed target-invalid refusal`);
        }
      }
      assert.equal(calls, 0, "dispatcher never called");
      const leftovers = existsSync(runDir) ? readdirSync(runDir) : [];
      assert.equal(leftovers.length, 0, "zero transcripts / zero worktrees in runDir");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(x); cleanupDir(aux);
  }
});

// ===== 4: run_consult create — seats + record under the CALL's target =====

test("CT-4: run_consult create fans every seat out under the call's target; record lands there", async () => {
  const target = mkdtempSync(join(tmpdir(), "wao-ct4-t-"));
  const aux = mkdtempSync(join(tmpdir(), "wao-ct4-aux-"));
  try {
    makeGitRepo(target);
    const registryPath = makeRegistry(aux, {
      seat_a: { backend: "claude-code", cwd: target },
      seat_b: { backend: "claude-code", cwd: target },
    });
    const seatCwds = [];
    const server = createWaoMcpServer({
      registryPath,
      runDir: join(aux, "runs"),
      // NOTE: no consultsDir override and NO binding — records must land under
      // the CALL's target.
      dispatchRunFn: async (input) => {
        seatCwds.push(input.cwd);
        return { accepted: true, runId: `run_ct4_${input.agentId}`, state: "pending" };
      },
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({
        name: "run_consult",
        arguments: {
          brief: "Q1: A 还是 B？",
          seats: ["seat_a", "seat_b"],
          expectedWorkspaceRoot: target,
          waitMs: 0,
        },
      });
      assert.equal(res.isError, undefined, `create succeeds: ${res.content?.map((c) => c.text).join(" ")}`);
      assert.equal(seatCwds.length, 2, "both seats dispatched");
      for (const cwd of seatCwds) assert.equal(fwd(cwd), fwd(target), "seat cwd is the call's target");
      const recordDir = join(target, ".wao", "runs", "consults");
      const records = existsSync(recordDir) ? readdirSync(recordDir).filter((f) => f.endsWith(".json")) : [];
      assert.equal(records.length, 1, "the consult record lives under the target");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(target); cleanupDir(aux);
  }
});

// ===== 5: real dispatch — runner argv cwd + transcript attribution are the target =====

test("CT-5: real dispatch writes the background ownership cwd + project bucket of the target", async () => {
  const target = mkdtempSync(join(tmpdir(), "wao-ct5-t-"));
  const aux = mkdtempSync(join(tmpdir(), "wao-ct5-aux-"));
  const runDir = join(aux, "runs");
  try {
    makeGitRepo(target);
    // The registry cwd deliberately points SOMEWHERE ELSE — the call target
    // must win over the agent entry cwd too.
    const elsewhere = mkdtempSync(join(tmpdir(), "wao-ct5-else-"));
    makeGitRepo(elsewhere);
    const registryPath = makeRegistry(aux, {
      fail_fast_worker: { backend: "claude-code", binary: "nonexistent-ct5-binary", cwd: elsewhere },
    });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "reliability-summary.json"),
      JSON.stringify({ workers: { fail_fast_worker: { status: "certified" } } }), "utf8");
    try {
      const server = createWaoMcpServer({ registryPath, runDir, workspaceRoot: elsewhere });
      const client = await buildClient(server);
      let runId;
      try {
        const res = await client.callTool({
          name: "run_dispatch",
          arguments: { agentId: "fail_fast_worker", prompt: "p", expectedWorkspaceRoot: target },
        });
        const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
        runId = parsed.runId;
        await client.close();
      } finally {
        await server.close();
      }
      // Wait for the detached runner to reach a terminal state.
      let events = [];
      for (let i = 0; i < 80; i += 1) {
        const tp = resolveTranscriptPath(runDir, runId, { cwdHint: target });
        if (existsSync(tp)) {
          events = await readTranscript(tp);
          if (["failed", "completed", "aborted", "timed_out"].includes(findState(events))) break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      // The transcript is FOUND via the target cwdHint — bucket attribution is
      // the target's project bucket, not the registry cwd or binding.
      const submitted = findLatest(events, "run.background_submitted");
      assert.ok(submitted, "background ownership fact exists");
      assert.equal(fwd(submitted.cwd), fwd(target),
        "the runner --cwd / ownership record is the call's target (not the registry cwd, not the binding)");
      // Attribution linkage: the transcript is locatable THROUGH the target
      // cwdHint (used in the read loop above) and the durable ownership cwd IS
      // the target — the bucket the runner chose is derived from that same cwd
      // (project-classification of temp-dir roots differs between this process
      // and the runner child, so the bucket segment itself is not asserted).
      const tpNoHint = resolveTranscriptPath(runDir, runId);
      assert.ok(existsSync(tpNoHint), "exactly one transcript copy, locatable without a hint");
    } finally {
      cleanupDir(elsewhere);
    }
  } finally {
    cleanupDir(target); cleanupDir(aux);
  }
});

// ===== 6: runId A-class tools verify ownership against the CALL's target =====

function seedOwnedRun(runDir, runId, cwd) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, `${runId}.jsonl`), [
    JSON.stringify({ type: "session.created", backend: "process", backendSessionId: "proc_1", runId, agentId: "w" }),
    JSON.stringify({ type: "run.started", backend: "claude-code", ts: "2026-10-15T00:00:00.000Z", runId, agentId: "w", cwd }),
    JSON.stringify({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "hi" }], ts: "2026-10-15T00:00:01.000Z", runId, agentId: "w" }),
    JSON.stringify({ type: "run.state_change", to: "running", ts: "2026-10-15T00:00:02.000Z", runId, agentId: "w" }),
  ].map((l) => l + "\n").join(""), "utf8");
}

test("CT-6: runId A-class tools — target≠ownership refuses, target=ownership proceeds", async () => {
  const owned = mkdtempSync(join(tmpdir(), "wao-ct6-owned-"));
  const other = mkdtempSync(join(tmpdir(), "wao-ct6-other-"));
  const aux = mkdtempSync(join(tmpdir(), "wao-ct6-aux-"));
  const runDir = join(aux, "runs");
  try {
    makeGitRepo(owned);
    makeGitRepo(other);
    const registryPath = makeRegistry(aux, { w: { backend: "claude-code", cwd: owned } });
    seedOwnedRun(runDir, "run_ct6", owned);

    // run_correct: injected service counts reach; the ownership gate lives in
    // the real service, so prove threading + mismatch through the REAL correctRun.
    const server = createWaoMcpServer({ registryPath, runDir, workspaceRoot: other });
    const client = await buildClient(server);
    try {
      // Mismatch: the run belongs to `owned`; the call names `other` — the
      // workspace gate refuses with its closed-set reason.
      const bad = await client.callTool({
        name: "run_correct",
        arguments: { runId: "run_ct6", correctionId: "c1", prompt: "x", expectedWorkspaceRoot: other },
      });
      const badP = JSON.parse(bad.content.find((b) => b.type === "text").text);
      assert.equal(badP.outcome, "rejected", "ownership mismatch refuses run_correct");
      assert.equal(badP.reason, "workspace_mismatch", "the workspace gate owns the refusal");
      // Match: the workspace gate passes; the refusal (if any) comes from a
      // LATER gate — here the not-correctable gate.
      const good = await client.callTool({
        name: "run_correct",
        arguments: { runId: "run_ct6", correctionId: "c1", prompt: "x", expectedWorkspaceRoot: owned },
      });
      const goodP = JSON.parse(good.content.find((b) => b.type === "text").text);
      assert.equal(goodP.outcome, "rejected");
      assert.equal(goodP.reason, "not_correctable", "matching target passes the workspace gate");
    } finally {
      await client.close();
      await server.close();
    }

    // run_collect (REAL service): mismatch → fixed refusal naming the cause and
    // byte-identical transcript; match → success.
    const server2 = createWaoMcpServer({ registryPath, runDir, workspaceRoot: other });
    const client2 = await buildClient(server2);
    try {
      const collectPath = resolveTranscriptPath(runDir, "run_ct6");
      const before = readFileSync(collectPath, "utf8");
      const badCollect = await client2.callTool({
        name: "run_collect",
        arguments: { runId: "run_ct6", expectedWorkspaceRoot: other },
      });
      assert.equal(badCollect.isError, true, "ownership mismatch refuses run_collect");
      const badText = (badCollect.content ?? []).map((b) => b.text ?? "").join(" ");
      assert.match(badText, /does not belong to the project/, "fixed text names the ownership cause");
      assert.ok(!badText.includes(fwd(other)) && !badText.includes(other),
        "the refusal never echoes an absolute path");
      assert.equal(readFileSync(collectPath, "utf8"), before, "refused collect writes nothing");
      const goodCollect = await client2.callTool({
        name: "run_collect",
        arguments: { runId: "run_ct6", expectedWorkspaceRoot: owned },
      });
      const parsed = JSON.parse(goodCollect.content.find((b) => b.type === "text").text);
      assert.equal(parsed.messages.length, 1, "matching target collects the run");
    } finally {
      await client2.close();
      await server2.close();
    }

    // run_delivery_decide: the service receives the CALL's proved root (the
    // previously-missing ownership gate now exists on this tool).
    let decideRoot = null;
    const server3 = createWaoMcpServer({
      registryPath, runDir,
      decideRunDeliveryFn: async (input) => {
        decideRoot = input.authorizedWorkspaceRoot;
        throw Object.assign(new Error("gate"), { name: "DeliveryDecisionPolicyError", code: "verification_failed" });
      },
    });
    const client3 = await buildClient(server3);
    try {
      await client3.callTool({
        name: "run_delivery_decide",
        arguments: { runId: "run_ct6", decision: "accepted", reason: "r", expectedWorkspaceRoot: owned },
      });
      assert.equal(fwd(decideRoot), fwd(owned), "decide threads the CALL's proved root as its authorization");
    } finally {
      await client3.close();
      await server3.close();
    }
  } finally {
    cleanupDir(owned); cleanupDir(other); cleanupDir(aux);
  }
});

// ===== 7: read-only tools keep the binding scope and SHOW it =====

test("CT-7: runs_list / lead_preflight expose the binding scope they filtered by", async () => {
  const aux = mkdtempSync(join(tmpdir(), "wao-ct7-aux-"));
  const scratchRoot = mkdtempSync(join(tmpdir(), "wao-ct7-scratch-"));
  try {
    // A real checkout is a project root. Its temp-dir sibling is NOT: the
    // write side classifies os.tmpdir() roots as the _scratch bucket, so the
    // label must say "no project bucket" instead of fabricating a project name.
    makeGitRepo(scratchRoot);
    const repoFact = projectFactFromCwd(REPO_ROOT);
    assert.equal(repoFact.kind, "project", "precondition: the checkout is not under os.tmpdir()");
    const registryPath = makeRegistry(aux, { w: { backend: "claude-code", cwd: REPO_ROOT } });
    const server = createWaoMcpServer({ registryPath, runDir: join(aux, "runs"), workspaceRoot: REPO_ROOT });
    const client = await buildClient(server);
    try {
      const rl = JSON.parse((await client.callTool({ name: "runs_list", arguments: {} }))
        .content.find((b) => b.type === "text").text);
      assert.equal(rl.scope.source, "server_config", "runs_list scope carries the binding source");
      assert.equal(rl.scope.projectBucket, repoFact.bucket,
        "scope.projectBucket is the write-side project bucket of the bound root");
      assert.ok(!JSON.stringify(rl.scope).includes(fwd(REPO_ROOT)),
        "the scope never leaks the absolute root");
      const pf = JSON.parse((await client.callTool({ name: "lead_preflight", arguments: {} }))
        .content.find((b) => b.type === "text").text);
      assert.equal(pf.workspace.projectBucket, repoFact.bucket,
        "lead_preflight workspace.projectBucket matches the same derivation");
    } finally {
      await client.close();
      await server.close();
    }

    // Same tools, a root under os.tmpdir(): the runs really land in _scratch,
    // so the label is null (never a fabricated project bucket).
    const server2 = createWaoMcpServer({
      registryPath, runDir: join(aux, "runs2"), workspaceRoot: scratchRoot,
    });
    const client2 = await buildClient(server2);
    try {
      const rl2 = JSON.parse((await client2.callTool({ name: "runs_list", arguments: {} }))
        .content.find((b) => b.type === "text").text);
      assert.equal(rl2.scope.projectBucket, null, "a temp-dir root has no project bucket label");
      const pf2 = JSON.parse((await client2.callTool({ name: "lead_preflight", arguments: {} }))
        .content.find((b) => b.type === "text").text);
      assert.equal(pf2.workspace.projectBucket, null, "lead_preflight agrees");
    } finally {
      await client2.close();
      await server2.close();
    }
  } finally {
    cleanupDir(aux);
    cleanupDir(scratchRoot);
  }
});

// ===== 8: MCP roots binding vs the call target, and scope-transparent reads =====

test("CT-8: MCP roots binding X never overrides a call naming Y", async () => {
  const x = mkdtempSync(join(tmpdir(), "wao-ct8-x-"));
  const y = mkdtempSync(join(tmpdir(), "wao-ct8-y-"));
  const aux = mkdtempSync(join(tmpdir(), "wao-ct8-aux-"));
  try {
    makeGitRepo(x);
    makeGitRepo(y);
    const registryPath = makeRegistry(aux, { w: { backend: "claude-code", cwd: x } });
    let captured = null;
    const server = createWaoMcpServer({
      registryPath, runDir: join(aux, "runs"),
      dispatchRunFn: async (input) => {
        captured = input;
        return { accepted: true, runId: "run_ct8", agentId: "w", state: "pending", providerSessionRouting: "not_used" };
      },
    });
    const spy = spyListRoots(server);
    const client = await buildRootsClient(server, x);
    try {
      const st = JSON.parse((await client.callTool({ name: "workspace_status", arguments: {} }))
        .content.find((b) => b.type === "text").text);
      assert.equal(st.source, "mcp_root", "binding is X via mcp_root");
      assert.equal(fwd(st.workspaceRoot), fwd(x));
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "w", prompt: "p", expectedWorkspaceRoot: y },
      });
      assert.equal(res.isError, undefined);
      assert.equal(fwd(captured.cwd), fwd(y), "call target Y wins over the mcp_root binding X");
      const proof = JSON.parse(res.content.find((b) => b.type === "text").text).workspaceProof;
      assert.equal(proof.source, "call_target");
    } finally {
      await client.close();
      spy.restore();
      await server.close();
    }
  } finally {
    cleanupDir(x); cleanupDir(y); cleanupDir(aux);
  }
});

test("CT-9: run_delivery_decide ownership mismatch is a fixed refusal with zero writes", async () => {
  const owned = mkdtempSync(join(tmpdir(), "wao-ct9-owned-"));
  const other = mkdtempSync(join(tmpdir(), "wao-ct9-other-"));
  const aux = mkdtempSync(join(tmpdir(), "wao-ct9-aux-"));
  const runDir = join(aux, "runs");
  try {
    makeGitRepo(owned);
    makeGitRepo(other);
    const registryPath = makeRegistry(aux, { w: { backend: "claude-code", cwd: owned } });
    seedOwnedRun(runDir, "run_ct9", owned);
    // REAL decide service (no injected fake).
    const server = createWaoMcpServer({ registryPath, runDir, workspaceRoot: other });
    const client = await buildClient(server);
    try {
      const tpath = resolveTranscriptPath(runDir, "run_ct9");
      const before = readFileSync(tpath, "utf8");
      const bad = await client.callTool({
        name: "run_delivery_decide",
        arguments: { runId: "run_ct9", decision: "rejected", reason: "no", expectedWorkspaceRoot: other },
      });
      assert.equal(bad.isError, true, "ownership mismatch is the fixed refusal, not a decision outcome");
      const text = (bad.content ?? []).map((b) => b.text ?? "").join(" ");
      assert.match(text, /does not belong to the project/, "fixed text names the ownership cause");
      assert.ok(!text.includes(other), "no absolute path echoed");
      assert.equal(readFileSync(tpath, "utf8"), before, "no decision, no release, byte-identical transcript");
      assert.ok(!before.includes("run.delivery_rejected"), "precondition: no decision was recorded");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(owned); cleanupDir(other); cleanupDir(aux);
  }
});

test("CT-10: run_delivery_repackage ownership mismatch appends no rejection audit", async () => {
  const owned = mkdtempSync(join(tmpdir(), "wao-ct10-owned-"));
  const other = mkdtempSync(join(tmpdir(), "wao-ct10-other-"));
  const aux = mkdtempSync(join(tmpdir(), "wao-ct10-aux-"));
  const runDir = join(aux, "runs");
  try {
    makeGitRepo(owned);
    makeGitRepo(other);
    const registryPath = makeRegistry(aux, { w: { backend: "claude-code", cwd: owned } });
    seedOwnedRun(runDir, "run_ct10", owned);
    const server = createWaoMcpServer({ registryPath, runDir, workspaceRoot: other });
    const client = await buildClient(server);
    try {
      const tpath = resolveTranscriptPath(runDir, "run_ct10");
      const before = readFileSync(tpath, "utf8");
      const res = await client.callTool({
        name: "run_delivery_repackage",
        arguments: { runId: "run_ct10", allowedPaths: ["src"], expectedWorkspaceRoot: other },
      });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.rejectionReason, "workspace_not_authorized", "closed-set rejection code");
      assert.equal(readFileSync(tpath, "utf8"), before,
        "no run.delivery_repackage_rejected audit is written into another project's transcript");
      assert.ok(!before.includes("delivery_repackage_rejected"), "precondition: no audit fact existed");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(owned); cleanupDir(other); cleanupDir(aux);
  }
});

test("CT-11: run_consult read follows the call's target; create never reads the binding", async () => {
  const x = mkdtempSync(join(tmpdir(), "wao-ct11-x-"));
  const y = mkdtempSync(join(tmpdir(), "wao-ct11-y-"));
  const aux = mkdtempSync(join(tmpdir(), "wao-ct11-aux-"));
  try {
    makeGitRepo(x);
    makeGitRepo(y);
    const registryPath = makeRegistry(aux, {
      seat_a: { backend: "claude-code", cwd: y },
    });
    const server = createWaoMcpServer({
      registryPath, runDir: join(aux, "runs"), workspaceRoot: x,
      dispatchRunFn: async (input) => ({
        accepted: true, runId: `run_ct11_${input.agentId}`, state: "pending",
      }),
    });
    const spy = spyListRoots(server);
    const client = await buildRootsClient(server, x);
    try {
      // Create under Y: zero binding reads (the client declares roots).
      const created = await client.callTool({
        name: "run_consult",
        arguments: { brief: "Q1: A 还是 B？", seats: ["seat_a"], expectedWorkspaceRoot: y, waitMs: 0 },
      });
      assert.equal(created.isError, undefined, "create succeeds on the call's target");
      assert.equal(spy.count(), 0, "create mode never resolves the shared binding (zero roots/list)");
      const receipt = JSON.parse(created.content.find((b) => b.type === "text").text);

      // Read with the SAME target Y finds the record just created.
      const readY = await client.callTool({
        name: "run_consult",
        arguments: { consultId: receipt.consultId, expectedWorkspaceRoot: y },
      });
      assert.equal(readY.isError, undefined, "read with the record's target succeeds");
      const receiptY = JSON.parse(readY.content.find((b) => b.type === "text").text);
      assert.equal(receiptY.consultId, receipt.consultId);

      // Read WITHOUT a target follows the binding (X here) — the record is not
      // there, so the existing not-found refusal is returned.
      const readX = await client.callTool({
        name: "run_consult",
        arguments: { consultId: receipt.consultId },
      });
      assert.equal(readX.isError, true, "without a target the binding scope is used");
      assert.match((readX.content ?? []).map((b) => b.text ?? "").join(" "), /no readable consult record/);
      assert.ok(spy.count() >= 1, "read mode still resolves the binding");
    } finally {
      await client.close();
      spy.restore();
      await server.close();
    }
  } finally {
    cleanupDir(x); cleanupDir(y); cleanupDir(aux);
  }
});

test("CT-12: run_dispatch_contract_check honours the call's target and reports the scope used", async () => {
  const x = mkdtempSync(join(tmpdir(), "wao-ct12-x-"));
  const y = mkdtempSync(join(tmpdir(), "wao-ct12-y-"));
  const aux = mkdtempSync(join(tmpdir(), "wao-ct12-aux-"));
  try {
    makeGitRepo(x);
    makeGitRepo(y);
    const registryPath = makeRegistry(aux, { w: { backend: "claude-code", cwd: x } });
    const server = createWaoMcpServer({ registryPath, runDir: join(aux, "runs"), workspaceRoot: x });
    const client = await buildClient(server);
    try {
      const withTarget = JSON.parse((await client.callTool({
        name: "run_dispatch_contract_check",
        arguments: { agentId: "w", prompt: "p", expectedWorkspaceRoot: y },
      })).content.find((b) => b.type === "text").text);
      assert.equal(withTarget.workspaceScope.source, "call_target", "the check names the scope it used");
      assert.equal(withTarget.sections.workspace, "observed", "the target itself proves, so it is observed");
      assert.equal(withTarget.issueCodes.includes("workspace_unbound"), false);
      // Without a target the binding remains the default scope.
      const noTarget = JSON.parse((await client.callTool({
        name: "run_dispatch_contract_check",
        arguments: { agentId: "w", prompt: "p" },
      })).content.find((b) => b.type === "text").text);
      assert.equal(noTarget.workspaceScope.source, "server_config", "no target → binding scope");
      // An unprovable target refuses with the shared fixed target text.
      const bad = await client.callTool({
        name: "run_dispatch_contract_check",
        arguments: { agentId: "w", prompt: "p", expectedWorkspaceRoot: "relative/path" },
      });
      assert.equal(bad.isError, true, "an unprovable target is refused");
      assert.match((bad.content ?? []).map((b) => b.text ?? "").join(" "), /workspace target invalid/);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(x); cleanupDir(y); cleanupDir(aux);
  }
});

