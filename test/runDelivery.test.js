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

test("3A1-15: delivery-enabled resume uses worktree cwd + restores scorecard + produces correct DeliveryRef", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-15-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
    );
    const run = await mgr.start("test", {
      prompt: "hi",
      isolate: true,
      runId: "run_delivtest_15",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const originalWorktree = run.deliveryContext.worktreePath;

    // Simulate worker writing to the worktree
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(originalWorktree, "src", "a.js"), "resume modified\n");

    // Source checkout must NOT have the worker's file
    const sourceContent = await import("node:fs/promises").then(m => m.readFile(
      join(repo, "src", "a.js"), "utf8",
    ));
    assert.equal(sourceContent, "const a = 1;\n", "source must be unchanged");

    // Resume the run
    const resumedRun = await mgr.resume("run_delivtest_15", { runDir });
    assert.ok(resumedRun, "resume must succeed for delivery-enabled run");
    assert.ok(resumedRun.deliveryContext, "resumed run must have deliveryContext");
    assert.equal(resumedRun.deliveryContext.baseCommit, baseCommit);
    assert.equal(resumedRun.deliveryContext.worktreePath, originalWorktree);
    assert.deepEqual(resumedRun.deliveryContext.allowedPaths, ["src"]);

    // Resume must use worktree as effectiveCwd, NOT source repo
    assert.equal(resumedRun.effectiveCwd, originalWorktree,
      "resumed run effectiveCwd must be worktree, not source repo");

    // Scorecard rules must be restored
    assert.ok(resumedRun.scorecardRules, "resumed run must have scorecardRules");

    // Complete the resumed run — delivery must package correctly
    const result = await resumedRun.waitForCompletion({});
    assert.equal(result.completed, true, "resumed run must complete");
    assert.ok(result.delivery, "resumed run must produce delivery");
    assert.ok(result.delivery.deliveryCommit, "delivery commit must exist");
    assert.deepEqual(result.delivery.changedFiles, ["src/a.js"]);

    // Source checkout still unchanged
    const sourceContentAfter = await import("node:fs/promises").then(m => m.readFile(
      join(repo, "src", "a.js"), "utf8",
    ));
    assert.equal(sourceContentAfter, "const a = 1;\n", "source must still be unchanged");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A1-15b: resume fails closed when delivery worktree branch has advanced", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-15b-"));
  try {
    const mgr = makeManager(runDir, repo, createMockFetch());
    const run = await mgr.start("test", {
      prompt: "hi",
      isolate: true,
      runId: "run_delivtest_15b",
      delivery: deliveryOpts(repo, baseCommit),
    });
    // Advance the worktree branch past base (simulating partial commit or corruption)
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "advanced\n");
    execSync("git add .", { cwd: run.deliveryContext.worktreePath, stdio: "ignore" });
    execSync('git commit -m "advanced"', {
      cwd: run.deliveryContext.worktreePath, stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });

    // Resume should fail closed — HEAD no longer at base
    const resumedRun = await mgr.resume("run_delivtest_15b", { runDir });
    assert.equal(resumedRun, null, "resume must fail closed when worktree HEAD != base");
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

// ===== Batch 3A-2: Package before terminal completion =====

/** Create a manager with injectable packageDeliveryFn. */
function makeManagerWithPackager(runDir, repoDir, fetchImpl, packageDeliveryFn, opts = {}) {
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
    packageDeliveryFn,
  });
}

/** Mock fetch that writes a file to the worktree via evidence, simulating worker output. */
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
      const body = JSON.parse(init.body);
      const session = sessions.get(sessionId);
      if (session) {
        session.messages.push({ info: { id: body.messageID, role: "user" }, parts: body.parts });
        // Simulate worker writing a file
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

test("3A2-01: completed backend + valid diff packages exactly one delivery commit", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-01-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg01-"));
  let packageCount = 0;
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo,
      createMockFetch(),
      (input) => { packageCount++; return packageDelivery(input); },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p01",
      delivery: deliveryOpts(repo, baseCommit),
      // Write a file to worktree to create a diff
    });
    // Simulate worker writing to the worktree
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");

    const result = await run.waitForCompletion({});
    assert.equal(packageCount, 1, "packager called exactly once");
    assert.equal(result.completed, true);
    assert.ok(result.delivery, "result must contain delivery DeliveryRef");
    assert.ok(result.delivery.deliveryCommit, "deliveryRef must have deliveryCommit");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-04: hard scorecard failure never calls packager and leaves worker diff uncommitted", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-04-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg04-"));
  let packageCount = 0;
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo,
      createMockFetch(),
      () => { packageCount++; return {}; },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p04",
      delivery: deliveryOpts(repo, baseCommit),
      scorecardMode: "hard",
    });
    // Don't write any files → no evidence → hard scorecard will fail
    const result = await run.waitForCompletion({});
    assert.equal(packageCount, 0, "packager must not be called on hard scorecard failure");
    assert.equal(result.completed, false);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-05: backend failure never calls packager", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-05-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg05-"));
  let packageCount = 0;
  try {
    // Mock where /message throws → streamEvents emits done(failed)
    const failingFetch = async (url, init = {}) => {
      const urlStr = String(url);
      if (init.method === "POST" && urlStr.endsWith("/api/session")) {
        return {
          ok: true, status: 200,
          async json() { return { data: { id: "ses_fail" } }; },
          async text() { return "{}"; },
        };
      }
      if (init.method === "POST" && urlStr.includes("/prompt_async")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      if (init.method === "GET" && urlStr.includes("/message")) {
        throw new Error("backend gone");
      }
      if (init.method === "POST" && urlStr.includes("/abort")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      return { ok: false, status: 404, async text() { return ""; } };
    };
    const mgr = makeManagerWithPackager(
      runDir, repo, failingFetch,
      () => { packageCount++; return {}; },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p05",
      delivery: deliveryOpts(repo, baseCommit),
    });
    try {
      await run.waitForCompletion({ waitTimeout: 500, pollInterval: 10 });
    } catch { /* expected backend failure */ }
    assert.equal(packageCount, 0, "packager must not be called on backend failure");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-09: empty diff produces run.delivery_failed, run.error phase=delivery, terminal failed, deliveryError", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-09-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg09-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input), // real packager — will hit empty_diff
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p09",
      delivery: deliveryOpts(repo, baseCommit),
    });
    // Don't write any files → empty diff → packaging fails

    const result = await run.waitForCompletion({});
    assert.equal(result.completed, false, "must not be completed");
    assert.equal(result.failed, true, "must be failed");
    assert.ok(result.deliveryError, "must have deliveryError");
    assert.equal(result.deliveryError.code, "empty_diff");

    // Check transcript events
    const events = await readTranscript(run.transcript.filePath);
    const deliveryFailed = events.find((e) => e.type === "run.delivery_failed");
    assert.ok(deliveryFailed, "must have run.delivery_failed event");
    assert.equal(deliveryFailed.deliveryCode, "empty_diff");
    const runError = events.find((e) => e.type === "run.error" && e.phase === "delivery");
    assert.ok(runError, "must have run.error phase=delivery");
    assert.equal(run.state, "failed");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-11: unknown packager exception maps to delivery_error without stack/stderr leakage", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-11-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg11-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      () => { throw new Error("something broke: /secret/path api_key=123"); },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p11",
      delivery: deliveryOpts(repo, baseCommit),
    });
    // Write a file so diff is non-empty (gets past empty_diff to actual package call)
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");

    const result = await run.waitForCompletion({});
    assert.equal(result.failed, true);
    assert.ok(result.deliveryError);
    assert.equal(result.deliveryError.code, "delivery_error");
    // Must not leak the stack trace or secret details
    assert.ok(!result.deliveryError.message.includes("api_key"),
      "deliveryError message must not leak secret values");
    assert.ok(!result.deliveryError.message.includes("/secret/path"),
      "deliveryError message must not leak paths");

    const events = await readTranscript(run.transcript.filePath);
    const deliveryFailed = events.find((e) => e.type === "run.delivery_failed");
    assert.ok(deliveryFailed);
    assert.equal(deliveryFailed.deliveryCode, "delivery_error");
    assert.ok(!JSON.stringify(deliveryFailed).includes("api_key"),
      "transcript must not leak secrets");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-12: success result includes exact DeliveryRef returned by packager", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-12-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg12-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p12",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");

    const result = await run.waitForCompletion({});
    assert.ok(result.delivery, "result must contain delivery");
    assert.ok(result.delivery.deliveryCommit, "deliveryCommit must be set");
    assert.equal(result.delivery.schemaVersion, 1);
    assert.equal(result.delivery.kind, "git_commit");
    assert.equal(result.delivery.baseCommit, baseCommit);
    assert.equal(result.delivery.branch, "wao/run_delivtest_p12");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-13: success event stores exact DeliveryRef under delivery", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-13-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg13-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p13",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");

    const result = await run.waitForCompletion({});
    const events = await readTranscript(run.transcript.filePath);
    const deliveryCreated = events.find((e) => e.type === "run.delivery_created");
    assert.ok(deliveryCreated, "must have run.delivery_created event");
    assert.ok(deliveryCreated.delivery, "event must contain delivery DeliveryRef");
    assert.equal(deliveryCreated.delivery.deliveryCommit, result.delivery.deliveryCommit);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-14: event order on success is scorecard.checked -> delivery_created -> completed -> state_change", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-14-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg14-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p14",
      delivery: deliveryOpts(repo, baseCommit),
      scorecardMode: "warn", // default warn
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");

    await run.waitForCompletion({});
    const events = await readTranscript(run.transcript.filePath);
    const deliveryCreatedIdx = events.findIndex((e) => e.type === "run.delivery_created");
    const completedIdx = events.findIndex((e) => e.type === "run.completed");
    const stateChangeCompletedIdx = events.findIndex(
      (e) => e.type === "run.state_change" && e.to === "completed",
    );

    assert.ok(deliveryCreatedIdx >= 0, "delivery_created must exist");
    assert.ok(completedIdx >= 0, "run.completed must exist");
    assert.ok(stateChangeCompletedIdx >= 0, "state_change completed must exist");
    assert.ok(deliveryCreatedIdx < completedIdx, "delivery_created before run.completed");
    assert.ok(completedIdx < stateChangeCompletedIdx || completedIdx === stateChangeCompletedIdx - 1,
      "run.completed before or adjacent to state_change completed");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-15: event order on packaging failure is delivery_failed -> run.error -> state_change failed", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-15-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg15-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input), // will hit empty_diff
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p15",
      delivery: deliveryOpts(repo, baseCommit),
    });
    // No file write → empty diff

    await run.waitForCompletion({});
    const events = await readTranscript(run.transcript.filePath);
    const deliveryFailedIdx = events.findIndex((e) => e.type === "run.delivery_failed");
    const runErrorIdx = events.findIndex((e) => e.type === "run.error" && e.phase === "delivery");
    const stateChangeFailedIdx = events.findIndex(
      (e) => e.type === "run.state_change" && e.to === "failed",
    );

    assert.ok(deliveryFailedIdx >= 0, "delivery_failed must exist");
    assert.ok(runErrorIdx >= 0, "run.error phase=delivery must exist");
    assert.ok(stateChangeFailedIdx >= 0, "state_change failed must exist");
    assert.ok(deliveryFailedIdx < runErrorIdx, "delivery_failed before run.error");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-16: package function is called exactly once even if result read multiple times", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-16-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg16-"));
  let packageCount = 0;
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => { packageCount++; return packageDelivery(input); },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p16",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");

    await run.waitForCompletion({});
    // Reading result again or transcript multiple times should not re-package
    await readTranscript(run.transcript.filePath);
    await readTranscript(run.transcript.filePath);
    assert.equal(packageCount, 1, "packager called exactly once");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-17: ordinary non-delivery completed run never calls packager and retains event shape", async () => {
  const { repo } = await makeRepo("wao-rd-pkg-17-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg17-"));
  let packageCount = 0;
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      () => { packageCount++; return {}; },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p17",
      // No delivery option
    });
    const result = await run.waitForCompletion({});
    assert.equal(packageCount, 0, "packager must not be called for non-delivery run");
    assert.equal(result.completed, true);
    assert.ok(!result.delivery, "result must not contain delivery for ordinary run");
    assert.ok(!result.deliveryError, "result must not contain deliveryError");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-21: source checkout remains unchanged; only wao/<runId> advances", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-21-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg21-"));
  try {
    const sourceHeadBefore = execSync("git rev-parse HEAD", {
      cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p21",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    await run.waitForCompletion({});

    const sourceHeadAfter = execSync("git rev-parse HEAD", {
      cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    assert.equal(sourceHeadAfter, sourceHeadBefore, "source HEAD must not move");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-22: successful worktree remains persistent and clean at delivery commit", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-22-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg22-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p22",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    const result = await run.waitForCompletion({});

    const wtPath = run.deliveryContext.worktreePath;
    assert.ok(existsSync(wtPath), "worktree must persist after delivery");

    const wtHead = execSync("git rev-parse HEAD", {
      cwd: wtPath, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    assert.equal(wtHead, result.delivery.deliveryCommit, "worktree HEAD = delivery commit");

    const wtStatus = execSync("git status --porcelain", {
      cwd: wtPath, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    assert.equal(wtStatus, "", "worktree must be clean");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-23: verification/acceptance/integration fields remain pending; no Phase 3B events", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-23-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg23-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p23",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    const result = await run.waitForCompletion({});

    assert.equal(result.delivery.verification.status, "pending");
    assert.equal(result.delivery.acceptance.status, "pending");
    assert.equal(result.delivery.integration.status, "pending");

    // No Phase 3B events
    const events = await readTranscript(run.transcript.filePath);
    assert.ok(!events.some((e) => e.type === "run.delivery_verified"), "no verification event");
    assert.ok(!events.some((e) => e.type === "run.delivery_accepted"), "no acceptance event");
    assert.ok(!events.some((e) => e.type === "run.delivery_integrated"), "no integration event");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-19: race — external aborted terminal wins during packaging; delivery_created as attempt fact", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-19-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg19-"));
  try {
    // Inject a packager that performs an external aborted transition before returning
    const racingPackager = async (input) => {
      const ref = packageDelivery(input);
      // After packaging succeeds, simulate external abort winning
      // by writing an aborted terminal state to the transcript
      const transcriptPath = run._testTranscriptPath;
      if (transcriptPath) {
        const { JsonlTranscript } = await import("../src/transcript.js");
        const ts = new JsonlTranscript(transcriptPath, {
          runId: input.runId, agentId: "test",
        });
        await ts.transitionState("running", "aborted", "external_abort", {
          factEvents: [{ type: "run.aborted", payload: { reason: "external" } }],
        });
      }
      return ref;
    };

    const mgr = makeManagerWithPackager(runDir, repo, createMockFetch(), racingPackager);
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p19",
      delivery: deliveryOpts(repo, baseCommit),
    });
    // Expose transcript path for the racing packager
    run._testTranscriptPath = run.transcript.filePath;

    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");

    const result = await run.waitForCompletion({});
    // The external aborted terminal won
    assert.equal(result.aborted, true, "result must reflect aborted terminal");
    // But delivery is still present (recoverable artifact)
    assert.ok(result.delivery, "delivery must be present even on rejected race");
    assert.ok(result.delivery.deliveryCommit, "delivery commit must exist");

    // Transcript must have delivery_created as an attempt fact
    const events = await readTranscript(run.transcript.filePath);
    const deliveryCreated = events.find((e) => e.type === "run.delivery_created");
    assert.ok(deliveryCreated, "delivery_created must be in transcript");

    // Only one terminal state_change
    const terminalStateChanges = events.filter(
      (e) => e.type === "run.state_change" && ["completed", "failed", "aborted", "timed_out"].includes(e.to),
    );
    assert.equal(terminalStateChanges.length, 1, "exactly one terminal state change");
    assert.equal(terminalStateChanges[0].to, "aborted", "terminal must be aborted");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-20: race — external aborted terminal wins during packaging that throws; delivery_failed as attempt fact", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-20-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg20-"));
  try {
    // Inject a packager that writes external aborted terminal, then throws
    const racingFailingPackager = async (input) => {
      // First simulate external abort winning
      const transcriptPath = run._testTranscriptPath;
      if (transcriptPath) {
        const { JsonlTranscript } = await import("../src/transcript.js");
        const ts = new JsonlTranscript(transcriptPath, {
          runId: input.runId, agentId: "test",
        });
        await ts.transitionState("running", "aborted", "external_abort", {
          factEvents: [{ type: "run.aborted", payload: { reason: "external" } }],
        });
      }
      // Then throw — packaging failed
      throw new Error("packaging exploded");
    };

    const mgr = makeManagerWithPackager(runDir, repo, createMockFetch(), racingFailingPackager);
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p20",
      delivery: deliveryOpts(repo, baseCommit),
    });
    run._testTranscriptPath = run.transcript.filePath;

    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");

    const result = await run.waitForCompletion({});
    assert.equal(result.aborted, true, "result must reflect aborted terminal");
    assert.ok(result.deliveryError, "deliveryError must be present");

    const events = await readTranscript(run.transcript.filePath);
    const deliveryFailed = events.find((e) => e.type === "run.delivery_failed");
    assert.ok(deliveryFailed, "delivery_failed must be in transcript");

    const terminalStateChanges = events.filter(
      (e) => e.type === "run.state_change" && ["completed", "failed", "aborted", "timed_out"].includes(e.to),
    );
    assert.equal(terminalStateChanges.length, 1, "exactly one terminal state change");
    assert.equal(terminalStateChanges[0].to, "aborted", "terminal must be aborted");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

// ===== Batch 3A-2: Missing mandatory test coverage (audit follow-up) =====

test("3A2-02: hard scorecard pass packages after scorecard.checked and before terminal completed", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-02-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg02-"));
  let packageCount = 0;
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => { packageCount++; return packageDelivery(input); },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p02",
      delivery: deliveryOpts(repo, baseCommit),
      // Explicit hard scorecard with requireAssistantText only (mock provides assistant text)
      scorecard: { rules: { requireAssistantText: true, mode: "hard" } },
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");

    const result = await run.waitForCompletion({});
    assert.equal(packageCount, 1, "packager called exactly once after hard scorecard pass");
    assert.equal(result.completed, true);
    assert.ok(result.delivery, "delivery must be present");

    const events = await readTranscript(run.transcript.filePath);
    // Verify hard scorecard actually passed (not warn)
    const scorecardChecked = events.find((e) => e.type === "scorecard.checked");
    assert.ok(scorecardChecked, "scorecard.checked must exist");
    assert.equal(scorecardChecked.passed, true, "hard scorecard must pass");
    // Verify scorecard.checked is before delivery_created
    const scorecardIdx = events.findIndex((e) => e.type === "scorecard.checked");
    const deliveryIdx = events.findIndex((e) => e.type === "run.delivery_created");
    assert.ok(deliveryIdx >= 0, "delivery_created must exist");
    assert.ok(scorecardIdx < deliveryIdx, "scorecard.checked before delivery_created");

    // Verify scorecard.rules persisted in run.started (for resume)
    const started = events.find((e) => e.type === "run.started");
    assert.ok(started.scorecardRules, "run.started must persist scorecardRules");
    assert.equal(started.scorecardRules.mode, "hard", "persisted mode must be hard");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-03: warn-mode scorecard failure records warning and still packages", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-03-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg03-"));
  let packageCount = 0;
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => { packageCount++; return packageDelivery(input); },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p03",
      delivery: deliveryOpts(repo, baseCommit),
      scorecardMode: "warn",
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");

    const result = await run.waitForCompletion({});
    assert.equal(packageCount, 1, "packager must be called even with warn scorecard failure");
    assert.equal(result.completed, true, "warn scorecard failure does not block completion");

    const events = await readTranscript(run.transcript.filePath);
    const scorecardWarn = events.find((e) => e.type === "scorecard.warn");
    assert.ok(scorecardWarn, "scorecard.warn event must exist");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-06: timeout never calls packager", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-06-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg06-"));
  let packageCount = 0;
  try {
    const timeoutFetch = async (url, init = {}) => {
      const urlStr = String(url);
      if (init.method === "POST" && urlStr.endsWith("/api/session")) {
        return {
          ok: true, status: 200,
          async json() { return { data: { id: "ses_timeout" } }; },
          async text() { return "{}"; },
        };
      }
      if (init.method === "POST" && urlStr.includes("/prompt_async")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      if (init.method === "GET" && urlStr.includes("/message")) {
        return { ok: true, status: 200, async json() { return []; }, async text() { return "[]"; } };
      }
      if (init.method === "POST" && urlStr.includes("/abort")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      return { ok: false, status: 404, async text() { return ""; } };
    };
    const mgr = makeManagerWithPackager(
      runDir, repo, timeoutFetch,
      () => { packageCount++; return {}; },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p06",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const result = await run.waitForCompletion({ waitTimeout: 200, pollInterval: 10 });
    assert.equal(packageCount, 0, "packager must not be called on timeout");
    assert.equal(result.timedOut, true, "must be timed out");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-07: budget failure never calls packager", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-07-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg07-"));
  let packageCount = 0;
  try {
    // Mock that returns session with large token count → budget exceeded.
    // Returns empty messages first so metrics polling (every 5 polls) triggers
    // before completion detection.
    let pollCount = 0;
    const budgetFetch = async (url, init = {}) => {
      const urlStr = String(url);
      if (init.method === "POST" && urlStr.endsWith("/api/session")) {
        return {
          ok: true, status: 200,
          async json() { return { data: { id: "ses_budget" } }; },
          async text() { return "{}"; },
        };
      }
      if (init.method === "POST" && urlStr.includes("/prompt_async")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      if (init.method === "GET" && urlStr.includes("/message")) {
        pollCount++;
        // Return empty for first 6 polls so metrics polling triggers,
        // then return assistant message
        if (pollCount < 7) {
          return { ok: true, status: 200, async json() { return []; }, async text() { return "[]"; } };
        }
        return {
          ok: true, status: 200,
          async json() {
            return [{
              info: { id: "msg_reply", role: "assistant" },
              parts: [{ type: "text", text: "done" }],
            }];
          },
          async text() { return "[]"; },
        };
      }
      // Session endpoint for metrics polling — return large token count.
      // trySessionMetrics reads sess.tokens directly (not under .data).
      if (init.method === "GET" && urlStr.includes("/session/")) {
        return {
          ok: true, status: 200,
          async json() {
            return { tokens: { input: 1000, output: 1000, reasoning: 0 } };
          },
          async text() { return "{}"; },
        };
      }
      if (init.method === "POST" && urlStr.includes("/abort")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      return { ok: false, status: 404, async text() { return ""; } };
    };
    const mgr = makeManagerWithPackager(
      runDir, repo, budgetFetch,
      () => { packageCount++; return {}; },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p07",
      delivery: deliveryOpts(repo, baseCommit),
    });
    // Pass token budget via waitForCompletion options
    const result = await run.waitForCompletion({ tokenBudget: 10, tokenBudgetMultiplier: 1 });
    assert.equal(packageCount, 0, "packager must not be called on budget failure");
    assert.equal(result.budgetExceeded, true, "must be budget exceeded");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-08: manual abort before packaging never calls packager", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-08-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg08-"));
  let packageCount = 0;
  try {
    const slowFetch = async (url, init = {}) => {
      const urlStr = String(url);
      if (init.method === "POST" && urlStr.endsWith("/api/session")) {
        return {
          ok: true, status: 200,
          async json() { return { data: { id: "ses_slow" } }; },
          async text() { return "{}"; },
        };
      }
      if (init.method === "POST" && urlStr.includes("/prompt_async")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      if (init.method === "GET" && urlStr.includes("/message")) {
        return { ok: true, status: 200, async json() { return []; }, async text() { return "[]"; } };
      }
      if (init.method === "POST" && urlStr.includes("/abort")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      return { ok: false, status: 404, async text() { return ""; } };
    };
    const mgr = makeManagerWithPackager(
      runDir, repo, slowFetch,
      () => { packageCount++; return {}; },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p08",
      delivery: deliveryOpts(repo, baseCommit),
    });

    await run.abort("user");
    const result = await run.waitForCompletion({ waitTimeout: 5000, pollInterval: 10 });
    assert.equal(packageCount, 0, "packager must not be called on abort");
    assert.equal(result.completed, false, "must not be completed");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-10: disallowed path produces failed lifecycle with original delivery code", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-10-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg10-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p10",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "README.md"), "# changed\n");

    const result = await run.waitForCompletion({});
    assert.equal(result.failed, true, "must be failed");
    assert.ok(result.deliveryError, "must have deliveryError");
    assert.equal(result.deliveryError.code, "disallowed_path");

    const events = await readTranscript(run.transcript.filePath);
    const deliveryFailed = events.find((e) => e.type === "run.delivery_failed");
    assert.ok(deliveryFailed);
    assert.equal(deliveryFailed.deliveryCode, "disallowed_path");
    assert.equal(run.state, "failed");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A2-18: external terminal wins before package gate — no Git commit and no delivery event", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-pkg-18-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-pkg18-"));
  let packageCount = 0;
  try {
    // Mock that returns one assistant message so backend reports done:completed.
    // But we externally claim aborted before waitForCompletion reaches packaging.
    const completeFetch = async (url, init = {}) => {
      const urlStr = String(url);
      if (init.method === "POST" && urlStr.endsWith("/api/session")) {
        return {
          ok: true, status: 200,
          async json() { return { data: { id: "ses_stop_gate" } }; },
          async text() { return "{}"; },
        };
      }
      if (init.method === "POST" && urlStr.includes("/prompt_async")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      if (init.method === "GET" && urlStr.includes("/message")) {
        return {
          ok: true, status: 200,
          async json() {
            return [{
              info: { id: "msg_reply", role: "assistant" },
              parts: [{ type: "text", text: "done" }],
            }];
          },
          async text() { return "[]"; },
        };
      }
      if (init.method === "POST" && urlStr.includes("/abort")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      return { ok: false, status: 404, async text() { return ""; } };
    };

    const mgr = makeManagerWithPackager(
      runDir, repo, completeFetch,
      () => { packageCount++; return {}; },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_delivtest_p18",
      delivery: deliveryOpts(repo, baseCommit),
    });

    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");

    // Deterministically claim aborted terminal BEFORE waitForCompletion.
    // The run is in "submitted" state. We claim aborted via the same transcript.
    const { JsonlTranscript } = await import("../src/transcript.js");
    const extTs = new JsonlTranscript(run.transcript.filePath, {
      runId: "run_delivtest_p18", agentId: "test",
      initialSeq: run.transcript.seq,
    });
    const claimResult = await extTs.transitionState("submitted", "aborted", "external_stop", {
      factEvents: [{ type: "run.aborted", payload: { reason: "external" } }],
    });
    assert.equal(claimResult.accepted, true, "external aborted claim must be accepted");

    // Now waitForCompletion — it should detect the external terminal and return
    // a loser result without calling the packager.
    const result = await run.waitForCompletion({ waitTimeout: 2000, pollInterval: 10 });

    // Deterministic assertions
    assert.equal(packageCount, 0, "packager must not be called when external terminal exists");
    assert.equal(result.aborted, true, "result must reflect aborted terminal");

    // Transcript: exactly one terminal state_change, and it's aborted
    const events = await readTranscript(run.transcript.filePath);
    const terminalStateChanges = events.filter(
      (e) => e.type === "run.state_change" && ["completed", "failed", "aborted", "timed_out"].includes(e.to),
    );
    assert.equal(terminalStateChanges.length, 1, "exactly one terminal state change");
    assert.equal(terminalStateChanges[0].to, "aborted", "terminal must be aborted");

    // No delivery events at all
    assert.ok(!events.some((e) => e.type === "run.delivery_created"), "no delivery_created");
    assert.ok(!events.some((e) => e.type === "run.delivery_failed"), "no delivery_failed");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A1-15c: resume restores hard scorecard mode (not downgraded to warn)", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-15c-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
    );
    const run = await mgr.start("test", {
      prompt: "hi",
      isolate: true,
      runId: "run_delivtest_15c",
      delivery: deliveryOpts(repo, baseCommit),
      // Explicit hard scorecard with requireAssistantText
      scorecard: { rules: { requireAssistantText: true, mode: "hard" } },
    });
    const originalWorktree = run.deliveryContext.worktreePath;

    // Simulate worker writing to the worktree
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(originalWorktree, "src", "a.js"), "resume hard\n");

    // Verify run.started persisted the exact hard rules
    const events = await readTranscript(run.transcript.filePath);
    const started = events.find((e) => e.type === "run.started");
    assert.ok(started.scorecardRules, "run.started must persist scorecardRules");
    assert.equal(started.scorecardRules.mode, "hard", "persisted mode must be hard");

    // Resume the run
    const resumedRun = await mgr.resume("run_delivtest_15c", { runDir });
    assert.ok(resumedRun, "resume must succeed");

    // Resumed run must have hard mode, NOT downgraded to warn
    assert.ok(resumedRun.scorecardRules, "resumed run must have scorecardRules");
    assert.equal(resumedRun.scorecardRules.mode, "hard",
      "resumed scorecard mode must be hard, not downgraded to warn");

    // Complete the resumed run — scorecard.checked should pass (assistant text present)
    const result = await resumedRun.waitForCompletion({});
    assert.equal(result.completed, true);

    // Verify scorecard.checked was written with mode hard
    const eventsAfter = await readTranscript(run.transcript.filePath);
    const scorecardChecked = eventsAfter.find((e) => e.type === "scorecard.checked");
    assert.ok(scorecardChecked, "scorecard.checked must exist on resumed run");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A1-15d: resume fails closed when scorecard rules snapshot is missing", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-15d-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
    );
    const run = await mgr.start("test", {
      prompt: "hi",
      isolate: true,
      runId: "run_delivtest_15d",
      delivery: deliveryOpts(repo, baseCommit),
      scorecardMode: "hard",
    });

    // Simulate worker writing
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "corrupt\n");

    // Corrupt the transcript: remove scorecardRules from run.started but keep scorecardConfigured=true
    const { readFile, writeFile: wfRaw } = await import("node:fs/promises");
    const raw = await readFile(run.transcript.filePath, "utf8");
    const lines = raw.trim().split("\n").map(l => {
      const ev = JSON.parse(l);
      if (ev.type === "run.started" && ev.scorecardConfigured) {
        delete ev.scorecardRules;
      }
      return JSON.stringify(ev);
    });
    await wfRaw(run.transcript.filePath, lines.join("\n") + "\n");

    // Resume should fail closed — scorecard configured but rules snapshot missing
    const resumedRun = await mgr.resume("run_delivtest_15d", { runDir });
    assert.equal(resumedRun, null, "resume must fail closed when scorecard rules missing");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});
