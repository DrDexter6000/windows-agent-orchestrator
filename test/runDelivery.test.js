import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { RunManager } from "../src/runManager.js";
import { OpenCodeServeBackend } from "../src/backends/opencodeServe.js";
import { readTranscript, findState } from "../src/transcript.js";
import { packageDelivery } from "../src/delivery.js";

// ===== Helpers =====

const RUN_ID_PREFIX = "run_delivtest";

/** Create a temp git repo with initial structure. Returns { repo, baseCommit }. */
async function makeRepo(prefix = "wao-rd-repo-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@test"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: dir, stdio: "ignore" });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.js"), "const a = 1;\n");
  await writeFile(join(dir, ".gitignore"), "node_modules/\n*.env\n.wao-worktrees/\n");
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
  const baseCommit = execSync("git rev-parse HEAD", {
    cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  return { repo: dir, baseCommit };
}

/** Clean up with retry (Windows file lock resilience). */
async function cleanupDir(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt === 4) return;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

/** Mock fetch that simulates assistant response + file_written evidence. */
function createMockFetch({ replies = ["Mock response"], evidence = [] } = {}) {
  const sessions = new Map();
  return async (url, init = {}) => {
    const urlStr = String(url);
    if (init.method === "POST" && urlStr.endsWith("/api/session")) {
      const id = `ses_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      sessions.set(id, { messages: [], replies: [...replies], evidence: [...evidence] });
      return {
        ok: true, status: 200,
        async json() { return { data: { id } }; },
        async text() { return JSON.stringify({ data: { id } }); },
      };
    }
    if (init.method === "POST" && urlStr.includes("/prompt_async")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const body = JSON.parse(init.body);
      const session = sessions.get(sessionId);
      if (session) {
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

/** Create RunManager backed by mock fetch + temp repo. */
function makeManager(runDir, repoDir, fetchImpl, opts = {}) {
  const config = {
    registry: "x",
    runDir,
    pollInterval: 10,
    waitTimeout: 5000,
    timeout: 5000,
    retries: 0,
    defaultIsolation: "none",
    ...opts.config,
  };
  const readRegistry = async () => ({
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
  });
  return new RunManager({
    config,
    readRegistry,
    backendFor: () => new OpenCodeServeBackend({ fetchImpl, timeout: 1000, retries: 0 }),
    ...opts.manager,
  });
}

/** Valid delivery option. */
function deliveryOpts(repoDir, baseCommit, overrides = {}) {
  return {
    mode: "git_commit_v1",
    allowedPaths: ["src"],
    verificationCommands: ["npm test"],
    ...overrides,
  };
}

const norm = (p) => p.replace(/\\/g, "/");

// ===== Batch 3A-1: Prepare run delivery context =====

test("3A1-01: valid delivery request captures full base hash before worker mutation", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-01-"));
  try {
    const mgr = makeManager(runDir, repo, createMockFetch());
    const run = await mgr.start("test", {
      prompt: "hi",
      isolate: true,
      runId: "run_delivtest_01",
      delivery: deliveryOpts(repo, baseCommit),
    });

    // The Run should have a prepared delivery context with a full base hash
    assert.ok(run.deliveryContext, "Run must have deliveryContext");
    assert.match(run.deliveryContext.baseCommit, /^[0-9a-f]{40}$/);
    assert.equal(run.deliveryContext.baseCommit, baseCommit);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A1-02: run.started.delivery contains normalized mode/base/allowedPaths/verification", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-02-"));
  try {
    const mgr = makeManager(runDir, repo, createMockFetch());
    const run = await mgr.start("test", {
      prompt: "hi",
      isolate: true,
      runId: "run_delivtest_02",
      delivery: deliveryOpts(repo, baseCommit),
    });

    const events = await readTranscript(run.transcript.filePath);
    const started = events.find((e) => e.type === "run.started");
    assert.ok(started.delivery, "run.started must contain delivery object");
    assert.equal(started.delivery.mode, "git_commit_v1");
    assert.equal(started.delivery.baseCommit, baseCommit);
    assert.deepEqual(started.delivery.allowedPaths, ["src"]);
    assert.deepEqual(started.delivery.verificationCommands, ["npm test"]);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A1-03: Run receives persistent worktree path and prepared delivery input", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-03-"));
  try {
    const mgr = makeManager(runDir, repo, createMockFetch());
    const run = await mgr.start("test", {
      prompt: "hi",
      isolate: true,
      runId: "run_delivtest_03",
      delivery: deliveryOpts(repo, baseCommit),
    });

    assert.ok(run.deliveryContext.worktreePath, "deliveryContext must have worktreePath");
    assert.ok(existsSync(run.deliveryContext.worktreePath), "worktree must exist on disk");
    assert.equal(run.deliveryContext.isolation.type, "worktree");
    assert.equal(run.deliveryContext.isolation.strategy, "persistent");
    assert.equal(run.deliveryContext.runId, "run_delivtest_03");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A1-04: missing delivery option preserves existing behavior and emits no delivery metadata", async () => {
  const { repo } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-04-"));
  try {
    const mgr = makeManager(runDir, repo, createMockFetch());
    const run = await mgr.start("test", {
      prompt: "hi",
      isolate: true,
      runId: "run_delivtest_04",
    });

    assert.ok(!run.deliveryContext, "no deliveryContext for ordinary run");
    const events = await readTranscript(run.transcript.filePath);
    const started = events.find((e) => e.type === "run.started");
    assert.ok(!started.delivery, "run.started must not contain delivery for ordinary run");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A1-05: unsupported mode rejects before backend.spawn", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-05-"));
  let spawnCount = 0;
  try {
    const fetchImpl = createMockFetch();
    // Wrap fetch to count spawn attempts
    const origFetch = fetchImpl;
    const countingFetch = async (...args) => {
      const urlStr = String(args[0]);
      if (urlStr.includes("/api/session")) spawnCount++;
      return origFetch(...args);
    };
    const mgr = makeManager(runDir, repo, countingFetch);
    await assert.rejects(
      () => mgr.start("test", {
        prompt: "hi",
        isolate: true,
        runId: "run_delivtest_05",
        delivery: deliveryOpts(repo, baseCommit, { mode: "patch_v1" }),
      }),
    );
    assert.equal(spawnCount, 0, "backend.spawn must not be called for invalid delivery mode");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A1-06: delivery with isolation none rejects before backend.spawn", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-06-"));
  let spawnCount = 0;
  try {
    const fetchImpl = createMockFetch();
    const origFetch = fetchImpl;
    const countingFetch = async (...args) => {
      const urlStr = String(args[0]);
      if (urlStr.includes("/api/session")) spawnCount++;
      return origFetch(...args);
    };
    const mgr = makeManager(runDir, repo, countingFetch);
    await assert.rejects(
      () => mgr.start("test", {
        prompt: "hi",
        isolate: false,
        runId: "run_delivtest_06",
        delivery: deliveryOpts(repo, baseCommit),
      }),
    );
    assert.equal(spawnCount, 0, "backend.spawn must not be called when isolation is none");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A1-07: delivery with ephemeral worktree rejects before backend.spawn", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-07-"));
  let spawnCount = 0;
  try {
    const fetchImpl = createMockFetch();
    const origFetch = fetchImpl;
    const countingFetch = async (...args) => {
      const urlStr = String(args[0]);
      if (urlStr.includes("/api/session")) spawnCount++;
      return origFetch(...args);
    };
    const mgr = makeManager(runDir, repo, countingFetch, {
      config: { defaultIsolation: "none" },
    });
    await assert.rejects(
      () => mgr.start("test", {
        prompt: "hi",
        runId: "run_delivtest_07",
        delivery: deliveryOpts(repo, baseCommit),
      }),
      // agent isolation is ephemeral → should reject
    );
    assert.equal(spawnCount, 0, "backend.spawn must not be called for ephemeral delivery isolation");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A1-08: invalid allowedPaths rejects before spawn using delivery-kernel codes", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-08-"));
  let spawnCount = 0;
  try {
    const fetchImpl = createMockFetch();
    const countingFetch = async (...args) => {
      if (String(args[0]).includes("/api/session")) spawnCount++;
      return fetchImpl(...args);
    };
    const mgr = makeManager(runDir, repo, countingFetch);
    await assert.rejects(
      () => mgr.start("test", {
        prompt: "hi",
        isolate: true,
        runId: "run_delivtest_08",
        delivery: deliveryOpts(repo, baseCommit, { allowedPaths: ["../evil"] }),
      }),
      /invalid_allowed_paths|disallowed|delivery/i,
    );
    assert.equal(spawnCount, 0, "backend.spawn must not be called");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A1-09: missing or whitespace-only verification declaration rejects before spawn", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-09-"));
  let spawnCount = 0;
  try {
    const fetchImpl = createMockFetch();
    const countingFetch = async (...args) => {
      if (String(args[0]).includes("/api/session")) spawnCount++;
      return fetchImpl(...args);
    };
    const mgr = makeManager(runDir, repo, countingFetch);

    // Whitespace-only verificationCommands
    await assert.rejects(
      () => mgr.start("test", {
        prompt: "hi",
        isolate: true,
        runId: "run_delivtest_09a",
        delivery: deliveryOpts(repo, baseCommit, { verificationCommands: ["   "] }),
      }),
      /invalid_verification|delivery/i,
    );

    // Missing both commands and reason
    const delivery2 = deliveryOpts(repo, baseCommit);
    delete delivery2.verificationCommands;
    await assert.rejects(
      () => mgr.start("test", {
        prompt: "hi",
        isolate: true,
        runId: "run_delivtest_09b",
        delivery: delivery2,
      }),
      /invalid_verification|delivery/i,
    );

    assert.equal(spawnCount, 0, "backend.spawn must not be called");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A1-10: worktree creation failure in delivery mode is fail-closed, not source-checkout fallback", async () => {
  // Use a non-git path as agent.cwd → createWorktree will fail
  const nonGitDir = await mkdtemp(join(tmpdir(), "wao-notgit-deliv-"));
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-10-"));
  try {
    const mgr = makeManager(runDir, nonGitDir, createMockFetch());
    await assert.rejects(
      () => mgr.start("test", {
        prompt: "hi",
        isolate: true,
        runId: "run_delivtest_10",
        delivery: {
          mode: "git_commit_v1",
          allowedPaths: ["src"],
          verificationCommands: ["npm test"],
        },
      }),
    );
    // Must not have created a transcript with a worktreePath (no fallback)
    // The start should throw before spawn
  } finally {
    await cleanupDir(nonGitDir);
    await cleanupDir(runDir);
  }
});

test("3A1-11: ordinary non-delivery worktree creation retains current fallback behavior", async () => {
  // Non-delivery worktree failure should fall back to source cwd (existing behavior)
  const nonGitDir = await mkdtemp(join(tmpdir(), "wao-notgit-ord-"));
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-11-"));
  try {
    const mgr = makeManager(runDir, nonGitDir, createMockFetch());
    // Should NOT throw — falls back to source cwd (existing behavior)
    const run = await mgr.start("test", {
      prompt: "hi",
      isolate: true,
      runId: "run_delivtest_11",
    });
    const events = await readTranscript(run.transcript.filePath);
    // Should have isolation_failed but still proceed
    const isolationFailed = events.find((e) => e.type === "run.isolation_failed");
    assert.ok(isolationFailed, "non-delivery worktree failure should be recorded but not fatal");
  } finally {
    await cleanupDir(nonGitDir);
    await cleanupDir(runDir);
  }
});

test("3A1-12: base commit remains original source HEAD even after worker writes files", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-12-"));
  try {
    const mgr = makeManager(runDir, repo, createMockFetch());
    const run = await mgr.start("test", {
      prompt: "hi",
      isolate: true,
      runId: "run_delivtest_12",
      delivery: deliveryOpts(repo, baseCommit),
    });

    // Simulate worker writing a file to the worktree
    await writeFile(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");

    // baseCommit in deliveryContext must still be the original source HEAD
    assert.equal(run.deliveryContext.baseCommit, baseCommit);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A1-13: no source checkout branch/HEAD/status mutation", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-13-"));
  try {
    const sourceHeadBefore = execSync("git rev-parse HEAD", {
      cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const sourceBranchBefore = execSync("git branch --show-current", {
      cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    const mgr = makeManager(runDir, repo, createMockFetch());
    const run = await mgr.start("test", {
      prompt: "hi",
      isolate: true,
      runId: "run_delivtest_13",
      delivery: deliveryOpts(repo, baseCommit),
    });

    // Worker writes to worktree
    await writeFile(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");

    const sourceHeadAfter = execSync("git rev-parse HEAD", {
      cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const sourceBranchAfter = execSync("git branch --show-current", {
      cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const sourceStatus = execSync("git status --porcelain", {
      cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    assert.equal(sourceHeadAfter, sourceHeadBefore, "source HEAD must not move");
    assert.equal(sourceBranchAfter, sourceBranchBefore, "source branch must not change");
    assert.equal(sourceStatus, "", "source status must be clean");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A1-14: prepared context can be reconstructed from run.started for resume", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-14-"));
  try {
    const mgr = makeManager(runDir, repo, createMockFetch());
    const run = await mgr.start("test", {
      prompt: "hi",
      isolate: true,
      runId: "run_delivtest_14",
      delivery: deliveryOpts(repo, baseCommit),
    });

    const events = await readTranscript(run.transcript.filePath);
    const started = events.find((e) => e.type === "run.started");
    // All fields needed to reconstruct delivery input must be in run.started
    assert.ok(started.delivery.mode);
    assert.ok(started.delivery.baseCommit);
    assert.ok(started.delivery.allowedPaths);
    assert.ok(started.delivery.verificationCommands || started.delivery.verificationUnavailableReason);
    assert.ok(started.worktreePath, "worktreePath must be in run.started for resume");
    assert.ok(started.worktreeBranch, "worktreeBranch must be in run.started for resume");

    // Reconstruct the delivery input from transcript
    const reconstructed = {
      runId: "run_delivtest_14",
      worktreePath: started.worktreePath,
      baseCommit: started.delivery.baseCommit,
      allowedPaths: started.delivery.allowedPaths,
      isolation: { type: "worktree", strategy: "persistent" },
      ...(started.delivery.verificationCommands
        ? { verificationCommands: started.delivery.verificationCommands }
        : { verificationUnavailableReason: started.delivery.verificationUnavailableReason }),
    };
    // The reconstructed input should be usable by inspectDelivery
    // (just verify shape — not running full inspect here as worker hasn't done work yet)
    assert.equal(reconstructed.baseCommit, baseCommit);
    assert.equal(reconstructed.worktreePath, run.deliveryContext.worktreePath);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A1-15: delivery-enabled resume preserves original base/worktree/allowed paths/verification", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-15-"));
  try {
    const mgr = makeManager(runDir, repo, createMockFetch());
    const run = await mgr.start("test", {
      prompt: "hi",
      isolate: true,
      runId: "run_delivtest_15",
      delivery: deliveryOpts(repo, baseCommit),
    });

    // Abort before completion so resume is possible
    // (don't waitForCompletion — just let it be in submitted state)
    const originalWorktree = run.deliveryContext.worktreePath;

    // Now try to resume
    const resumedRun = await mgr.resume("run_delivtest_15", { runDir });
    assert.ok(resumedRun, "resume must succeed for delivery-enabled run");
    assert.ok(resumedRun.deliveryContext, "resumed run must have deliveryContext");
    assert.equal(resumedRun.deliveryContext.baseCommit, baseCommit);
    assert.equal(resumedRun.deliveryContext.worktreePath, originalWorktree);
    assert.deepEqual(resumedRun.deliveryContext.allowedPaths, ["src"]);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A1-16: verificationUnavailableReason is accepted in delivery mode", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-16-"));
  try {
    const mgr = makeManager(runDir, repo, createMockFetch());
    const delivery = deliveryOpts(repo, baseCommit);
    delete delivery.verificationCommands;
    delivery.verificationUnavailableReason = "no test suite";
    const run = await mgr.start("test", {
      prompt: "hi",
      isolate: true,
      runId: "run_delivtest_16",
      delivery,
    });

    const events = await readTranscript(run.transcript.filePath);
    const started = events.find((e) => e.type === "run.started");
    assert.ok(!started.delivery.verificationCommands, "commands should be absent");
    assert.equal(started.delivery.verificationUnavailableReason, "no test suite");
    assert.equal(run.deliveryContext.verificationUnavailableReason, "no test suite");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});
