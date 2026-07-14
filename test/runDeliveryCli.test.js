// test/runDeliveryCli.test.js
//
// TD-103 Phase 3C-1: public foreground run delivery via --delivery-spec-file
//
// Tests the CLI surface: file loading, validation, rejection of invalid combos,
// and JSON output preservation of the DeliveryRef + verification flags.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { runCommand, spawnCommand } from "../src/commands/run.js";
import { readTranscript, findState } from "../src/transcript.js";

// ===== Helpers =====

/** Create a temp git repo with initial structure. Returns { repo, baseCommit }. */
function makeRepo(prefix = "wao-3c1-repo-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@test"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.js"), "const a = 1;\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n*.log\n.wao-worktrees/\n");
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
  const baseCommit = execSync("git rev-parse HEAD", {
    cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  return { repo: dir, baseCommit };
}

async function cleanupDir(dir) {
  try { execSync("git worktree prune", { cwd: dir, stdio: "ignore" }); } catch { /* best effort */ }
  for (let attempt = 0; attempt < 5; attempt++) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { if (attempt === 4) return; await new Promise((r) => setTimeout(r, 50 * (attempt + 1))); }
  }
}

/** Capture console.log output. */
async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(" ")); };
  try { await fn(); }
  finally { console.log = orig; }
  return lines.join("\n");
}

/** Mock fetch for opencode-serve backend (worker writes a file, then done). */
function createMockFetch({ replies = ["Mock response"] } = {}) {
  const sessions = new Map();
  return async (url, init = {}) => {
    const urlStr = String(url);
    if (init.method === "POST" && urlStr.endsWith("/api/session")) {
      const id = `ses_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      sessions.set(id, { messages: [], replies: [...replies] });
      return {
        ok: true, status: 200,
        async json() { return { data: { id } }; },
        async text() { return JSON.stringify({ data: { id } }); },
      };
    }
    if (init.method === "POST" && urlStr.includes("/prompt_async")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const session = sessions.get(sessionId);
      if (session) {
        const body = JSON.parse(init.body);
        session.messages.push({ info: { id: body.messageID, role: "user" }, parts: body.parts });
        const reply = session.replies.shift() ?? "done";
        session.messages.push({
          info: { id: "msg_reply", role: "assistant" },
          parts: [{ type: "text", text: reply }],
        });
      }
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    if (init.method === "GET" && urlStr.includes("/message")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const session = sessions.get(sessionId);
      return {
        ok: true, status: 200,
        async json() { return session?.messages ?? []; },
        async text() { return JSON.stringify(session?.messages ?? []); },
      };
    }
    if (init.method === "POST" && urlStr.includes("/abort")) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    return { ok: false, status: 404, async text() { return "not found"; } };
  };
}

/** Mock fetch that writes a file to the worktree during prompt processing. */
function createWorkerFetch({ writePath, writeContent = "modified\n" } = {}) {
  const sessions = new Map();
  return async (url, init = {}) => {
    const urlStr = String(url);
    if (init.method === "POST" && urlStr.endsWith("/api/session")) {
      const id = `ses_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      sessions.set(id, { messages: [], writePath, writeContent });
      return {
        ok: true, status: 200,
        async json() { return { data: { id } }; },
        async text() { return JSON.stringify({ data: { id } }); },
      };
    }
    if (init.method === "POST" && urlStr.includes("/prompt_async")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const session = sessions.get(sessionId);
      if (session) {
        const body = JSON.parse(init.body);
        session.messages.push({ info: { id: body.messageID, role: "user" }, parts: body.parts });
        if (session.writePath) {
          const { writeFile: wf } = await import("node:fs/promises");
          await wf(session.writePath, session.writeContent);
        }
        session.messages.push({
          info: { id: "msg_reply", role: "assistant" },
          parts: [{ type: "text", text: "done" }],
        });
      }
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    if (init.method === "GET" && urlStr.includes("/message")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const session = sessions.get(sessionId);
      return {
        ok: true, status: 200,
        async json() { return session?.messages ?? []; },
        async text() { return JSON.stringify(session?.messages ?? []); },
      };
    }
    if (init.method === "POST" && urlStr.includes("/abort")) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    return { ok: false, status: 404, async text() { return "not found"; } };
  };
}

const { OpenCodeServeBackend } = await import("../src/backends/opencodeServe.js");

/** Build config with mock backend. */
function makeConfig(runDir, repoDir, fetchImpl) {
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 1000, retries: 0 });
  return {
    registry: "x",
    runDir,
    pollInterval: 10,
    waitTimeout: 5000,
    timeout: 5000,
    retries: 0,
    defaultIsolation: "none",
    backendFor: () => backend,
    readRegistry: async () => ({
      getAgent(id, overrides = {}) {
        const defined = Object.fromEntries(
          Object.entries(overrides).filter(([, v]) => v !== undefined),
        );
        return {
          id,
          backend: "opencode-serve",
          serveUrl: "http://127.0.0.1:4299",
          agent: "build",
          cwd: repoDir ?? runDir,
          model: { providerID: "p", id: "m" },
          ...defined,
        };
      },
      listAgents() { return []; },
    }),
  };
}

const RUN_ID = "run_3c1_test";

// ===== 3C-1 RED tests =====

/**
 * 3C1-01: valid file forwards a normalized delivery request and isolate:true to RunManager.start.
 * The worker writes to the worktree, packaging succeeds, and the result has a delivery ref.
 */
test("3C1-01: valid delivery-spec-file forwards delivery request + isolate to manager.start", async () => {
  const { repo, baseCommit } = makeRepo("wao-3c1-01-");
  const runDir = mkdtempSync(join(tmpdir(), "wao-3c1-01-"));
  try {
    const specPath = join(runDir, "delivery.json");
    writeFileSync(specPath, JSON.stringify({
      mode: "git_commit_v1",
      allowedPaths: ["src"],
      verificationCommands: ["echo ok"],
    }), "utf8");

    const testRunId = RUN_ID + "_01";
    // Worker writes to the worktree (path is predictable: repo/.wao-worktrees/<runId>)
    const worktreePath = join(repo, ".wao-worktrees", testRunId);
    const config = makeConfig(runDir, repo, createWorkerFetch({
      writePath: join(worktreePath, "src", "a.js"),
      writeContent: "modified\n",
    }));
    const out = await captureLog(async () => {
      await runCommand([
        "test", "--prompt", "hi",
        "--delivery-spec-file", specPath,
        "--isolate",
        "--run-id", testRunId,
        "--format", "json",
        "--run-dir", runDir,
      ], config);
    });

    const parsed = JSON.parse(out);
    assert.ok(parsed.completed, "run must complete");
    assert.ok(parsed.delivery, "result must have delivery ref");
    assert.ok(parsed.delivery.deliveryCommit, "delivery must have deliveryCommit");
    assert.equal(parsed.delivery.verification.status, "passed",
      "default verification should pass with echo ok");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

/**
 * 3C1-02: invalid JSON fails before manager/backend start.
 */
test("3C1-02: invalid JSON fails before manager/backend start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-3c1-02-"));
  try {
    const specPath = join(dir, "bad.json");
    writeFileSync(specPath, "{ not valid json }", "utf8");

    const config = makeConfig(dir, dir, createMockFetch());
    await assert.rejects(
      () => runCommand([
        "test", "--prompt", "hi",
        "--delivery-spec-file", specPath,
        "--isolate",
        "--run-dir", dir,
      ], config),
      /json/i,
      "invalid JSON should fail with a parse error before backend start",
    );
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C1-03: valid JSON with invalid delivery schema fails through prepareDeliveryRequest before spawn.
 */
test("3C1-03: valid JSON with invalid delivery schema fails through prepareDeliveryRequest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-3c1-03-"));
  try {
    const specPath = join(dir, "bad-schema.json");
    writeFileSync(specPath, JSON.stringify({
      mode: "wrong_mode",
      allowedPaths: ["src"],
      verificationCommands: ["echo ok"],
    }), "utf8");

    const config = makeConfig(dir, dir, createMockFetch());
    await assert.rejects(
      () => runCommand([
        "test", "--prompt", "hi",
        "--delivery-spec-file", specPath,
        "--isolate",
        "--run-dir", dir,
      ], config),
      (err) => /invalid_mode|git_commit_v1/i.test(err.message),
      "invalid delivery mode should fail through prepareDeliveryRequest",
    );
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C1-04: missing --isolate fails before spawn.
 */
test("3C1-04: missing --isolate fails before spawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-3c1-04-"));
  try {
    const specPath = join(dir, "delivery.json");
    writeFileSync(specPath, JSON.stringify({
      mode: "git_commit_v1",
      allowedPaths: ["src"],
      verificationCommands: ["echo ok"],
    }), "utf8");

    const config = makeConfig(dir, dir, createMockFetch());
    await assert.rejects(
      () => runCommand([
        "test", "--prompt", "hi",
        "--delivery-spec-file", specPath,
        // no --isolate
        "--run-dir", dir,
      ], config),
      /isolate/i,
      "delivery without --isolate should fail before spawn",
    );
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C1-05: background run with delivery produces full lifecycle events (M9-7A closeout).
 * Uses a real git repo + a fake process worker script that writes a file and exits 0.
 * Dispatches via CLI subprocess, polls transcript to terminal, verifies delivery events.
 */
test("3C1-05: background delivery produces delivery_created + verification + terminal", async () => {
  const { repo, baseCommit } = makeRepo("wao-3c1-05-");
  try {
    const runDir = join(repo, "runs");
    mkdirSync(runDir, { recursive: true });

    // Registry pointing to a fake worker binary that writes src/out.js and exits 0.
    const fakeWorker = join(import.meta.dirname, "fixtures", "fake-worker-writefile.cjs");
    const registryPath = join(repo, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        fake_worker: {
          backend: "claude-code",
          binary: process.execPath,
          prependArgs: [fakeWorker, "out.js", "fake output"],
          cwd: repo,
          args: [],
        },
      },
    }), "utf8");

    const specPath = join(repo, "delivery.json");
    writeFileSync(specPath, JSON.stringify({
      mode: "git_commit_v1",
      allowedPaths: ["src"],
      verificationCommands: ["echo ok"],
    }), "utf8");

    // Dispatch via CLI subprocess — the detached runner runs independently.
    const cliOut = execSync(
      `node src/cli.js run fake_worker --prompt "write a file" ` +
      `--delivery-spec-file ${specPath} --background --isolate ` +
      `--registry ${registryPath} --run-dir ${runDir}`,
      { cwd: process.cwd(), encoding: "utf8", timeout: 15000,
        env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" } },
    );
    const parsed = JSON.parse(cliOut.slice(cliOut.indexOf("{"), cliOut.lastIndexOf("}") + 1));
    const runId = parsed.runId;
    assert.ok(runId, "background delivery returns runId");

    // Poll transcript to terminal.
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    let events = [];
    for (let i = 0; i < 120; i += 1) {
      if (existsSync(transcriptPath)) {
        events = await readTranscript(transcriptPath);
        const st = findState(events);
        if (["completed", "failed", "aborted", "timed_out"].includes(st)) break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    // After reaching terminal, re-read to capture all events (verification may
    // be written immediately after the terminal state_change). Retry a few
    // times to handle flush timing under load.
    for (let r = 0; r < 10; r += 1) {
      await new Promise((res) => setTimeout(res, 500));
      events = await readTranscript(transcriptPath);
      const hasVerification = events.some((e) =>
        e.type === "run.delivery_verification_passed" ||
        e.type === "run.delivery_verification_failed" ||
        e.type === "run.delivery_verification_unavailable");
      if (hasVerification) break;
    }

    const finalState = findState(events);
    assert.equal(finalState, "completed",
      `background delivery must complete successfully (got ${finalState})`);

    // Precise delivery event counts.
    const deliveryCreated = events.filter((e) => e.type === "run.delivery_created");
    assert.equal(deliveryCreated.length, 1, "exactly 1 delivery_created");

    const verificationPassed = events.filter((e) => e.type === "run.delivery_verification_passed");
    assert.equal(verificationPassed.length, 1, "exactly 1 delivery_verification_passed");

    const deliveryFailed = events.filter((e) => e.type === "run.delivery_failed");
    assert.equal(deliveryFailed.length, 0, "0 delivery_failed");

    const verificationFailed = events.filter((e) => e.type === "run.delivery_verification_failed");
    assert.equal(verificationFailed.length, 0, "0 verification_failed");
    const verificationUnavailable = events.filter((e) => e.type === "run.delivery_verification_unavailable");
    assert.equal(verificationUnavailable.length, 0, "0 verification_unavailable");

    // Source checkout unchanged.
    const sourceFiles = execSync("git diff --name-only HEAD", { cwd: repo, encoding: "utf8" }).trim();
    assert.equal(sourceFiles, "", "source checkout unchanged by worker");

    // Heartbeat cleared.
    const ownerFile = join(runDir, `.owner-${runId}`);
    for (let i = 0; i < 40; i += 1) {
      if (!existsSync(ownerFile)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(!existsSync(ownerFile), "heartbeat cleared after runner exit");
  } finally {
    await cleanupDir(repo);
  }
});

/**
 * 3C1-06: spawn with delivery fails explicitly.
 */
test("3C1-06: spawn with delivery fails explicitly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-3c1-06-"));
  try {
    const specPath = join(dir, "delivery.json");
    writeFileSync(specPath, JSON.stringify({
      mode: "git_commit_v1",
      allowedPaths: ["src"],
      verificationCommands: ["echo ok"],
    }), "utf8");

    const config = makeConfig(dir, dir, createMockFetch());
    await assert.rejects(
      () => spawnCommand([
        "test", "--prompt", "hi",
        "--delivery-spec-file", specPath,
        "--wait",
        "--run-dir", dir,
      ], config),
      /delivery|spawn/i,
      "spawn with delivery should fail explicitly",
    );
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C1-07: ordinary foreground run is byte/shape compatible and does not gain a delivery field.
 */
test("3C1-07: ordinary foreground run without delivery does not gain a delivery field", async () => {
  const { ClaudeCodeBackend } = await import("../src/backends/claudeCode.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-3c1-07-"));
  try {
    const claudeLines = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}',
      '{"type":"result","subtype":"success","is_error":false}',
    ];
    const payload = Buffer.from(claudeLines.join("\n")).toString("base64");
    const script = `process.stdout.write(Buffer.from("${payload}","base64").toString("utf8")+"\\n");`;
    const backend = new ClaudeCodeBackend({ buildArgs: () => ["-e", script] });
    backend.defaultBinary = () => process.execPath;
    const config = {
      registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 5000,
      timeout: 5000, retries: 0,
      backendFor: () => backend,
      readRegistry: async () => ({
        getAgent(id, overrides = {}) {
          return { id, backend: "claude-code", cwd: dir, ...overrides };
        },
        listAgents() { return []; },
      }),
    };

    const out = await captureLog(async () => {
      await runCommand([
        "claude_worker", "--prompt", "hi",
        "--format", "json",
        "--run-dir", dir,
      ], config);
    });
    const parsed = JSON.parse(out);
    assert.ok(!("delivery" in parsed), "ordinary run must not gain a delivery field");
    assert.ok(!("deliveryError" in parsed), "ordinary run must not gain a deliveryError field");
    assert.ok(!("verificationFailed" in parsed), "ordinary run must not gain verificationFailed");
    assert.ok(!("verificationUnavailable" in parsed), "ordinary run must not gain verificationUnavailable");
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C1-08: JSON output preserves verified DeliveryRef and verification flags.
 * Uses a delivery with verificationUnavailableReason to test the unavailable flag.
 */
test("3C1-08: JSON output preserves verified DeliveryRef and verification flags", async () => {
  const { repo, baseCommit } = makeRepo("wao-3c1-08-");
  const runDir = mkdtempSync(join(tmpdir(), "wao-3c1-08-"));
  try {
    const specPath = join(runDir, "delivery.json");
    writeFileSync(specPath, JSON.stringify({
      mode: "git_commit_v1",
      allowedPaths: ["src"],
      verificationUnavailableReason: "no test suite",
    }), "utf8");

    const testRunId = RUN_ID + "_08";
    const worktreePath = join(repo, ".wao-worktrees", testRunId);
    const config = makeConfig(runDir, repo, createWorkerFetch({
      writePath: join(worktreePath, "src", "a.js"),
      writeContent: "modified\n",
    }));
    const out = await captureLog(async () => {
      await runCommand([
        "test", "--prompt", "hi",
        "--delivery-spec-file", specPath,
        "--isolate",
        "--run-id", testRunId,
        "--format", "json",
        "--run-dir", runDir,
      ], config);
    });

    const parsed = JSON.parse(out);
    assert.ok(parsed.completed, "run must complete");
    assert.ok(parsed.delivery, "result must have delivery ref");
    assert.equal(parsed.delivery.verification.status, "unavailable");
    assert.equal(parsed.verificationUnavailable, true,
      "verificationUnavailable flag must be true");
    assert.ok(!parsed.verificationFailed, "verificationFailed must be false for unavailable");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

/**
 * 3C1-09: help exposes the new option exactly once.
 */
test("3C1-09: help exposes --delivery-spec-file exactly once", async () => {
  const out = await captureLog(async () => {
    const { printHelp } = await import("../src/cli.js");
    // printHelp is not exported — use the CLI process instead
  }).catch(() => null);

  // Use the actual CLI process for help
  const result = execSync("node src/cli.js --help 2>&1", {
    cwd: resolve(process.cwd()),
    encoding: "utf8",
  });
  const count = (result.match(/--delivery-spec-file/g) || []).length;
  assert.equal(count, 1, "help must mention --delivery-spec-file exactly once");
});
