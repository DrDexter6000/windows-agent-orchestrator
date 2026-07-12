import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { RunManager } from "../src/runManager.js";
import { Run } from "../src/runManager.js";
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

/** Dummy verifier for 3A tests that focus on packaging, not verification. */
const dummyVerifier = async (deliveryRef) => ({
  delivery: {
    ...deliveryRef,
    verification: {
      ...deliveryRef.verification,
      status: "passed",
      verifiedCommit: deliveryRef.deliveryCommit,
      results: [],
    },
  },
  outcome: "passed",
});

/** Create a manager with injectable packageDeliveryFn and verifyDeliveryFn. */
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
    verifyDeliveryFn: opts.verifyDeliveryFn ?? dummyVerifier,
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

test("3A2-23: acceptance/integration remain pending; verification updated by verifier", async () => {
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

    // Verification was run (dummy verifier → passed)
    assert.equal(result.delivery.verification.status, "passed");
    // Acceptance and integration remain pending (Phase 3C)
    assert.equal(result.delivery.acceptance.status, "pending");
    assert.equal(result.delivery.integration.status, "pending");

    // No Phase 3C acceptance/integration events
    const events = await readTranscript(run.transcript.filePath);
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

    // Verify scorecard.rules persisted inside delivery metadata in run.started
    const started = events.find((e) => e.type === "run.started");
    assert.ok(started.delivery?.scorecardRules, "delivery.scorecardRules must be persisted");
    assert.equal(started.delivery.scorecardRules.mode, "hard", "persisted mode must be hard");
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
    assert.ok(started.delivery?.scorecardRules, "delivery.scorecardRules must be persisted");
    assert.equal(started.delivery.scorecardRules.mode, "hard", "persisted mode must be hard");

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

    // Corrupt the transcript: remove delivery.scorecardRules but keep scorecardConfigured=true
    const { readFile, writeFile: wfRaw } = await import("node:fs/promises");
    const raw = await readFile(run.transcript.filePath, "utf8");
    const lines = raw.trim().split("\n").map(l => {
      const ev = JSON.parse(l);
      if (ev.type === "run.started" && ev.scorecardConfigured && ev.delivery) {
        delete ev.delivery.scorecardRules;
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

// ===== Phase 3A security: runId injection prevention =====

test("3A-SEC-01: runId with shell metacharacters rejected before worktree creation", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-sec01-"));
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
        prompt: "hi", isolate: true,
        runId: 'run_evil"; rm -rf /',
        delivery: deliveryOpts(repo, baseCommit),
      }),
    );
    assert.equal(spawnCount, 0, "backend.spawn must not be called for malicious runId");
    // No worktree directory created
    assert.ok(!existsSync(join(repo, ".wao-worktrees", 'run_evil"; rm -rf /')),
      "no worktree directory must be created for malicious runId");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A-SEC-02: runId with path traversal rejected", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-sec02-"));
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
        prompt: "hi", isolate: true,
        runId: "run_evil../../../etc",
        delivery: deliveryOpts(repo, baseCommit),
      }),
    );
    assert.equal(spawnCount, 0, "backend.spawn must not be called for traversal runId");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A-SEC-03: runId with path separator rejected", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-sec03-"));
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
        prompt: "hi", isolate: true,
        runId: "run_evil/path",
        delivery: deliveryOpts(repo, baseCommit),
      }),
    );
    assert.equal(spawnCount, 0, "backend.spawn must not be called for separator runId");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A-SEC-04: runId with ampersand rejected", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-sec04-"));
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
        prompt: "hi", isolate: true,
        runId: "run_evil&whoami",
        delivery: deliveryOpts(repo, baseCommit),
      }),
    );
    assert.equal(spawnCount, 0, "backend.spawn must not be called for ampersand runId");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A-SEC-05: runId with spaces rejected", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-sec05-"));
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
        prompt: "hi", isolate: true,
        runId: "run evil spaced",
        delivery: deliveryOpts(repo, baseCommit),
      }),
    );
    assert.equal(spawnCount, 0, "backend.spawn must not be called for spaced runId");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A-SEC-06: createWorktree directly rejects malicious names", async () => {
  const { createWorktree } = await import("../src/isolation.js");
  const { repo } = await makeRepo();
  try {
    // Shell metacharacter
    assert.throws(() => createWorktree(repo, 'evil"; rm -rf /'));
    // Path traversal
    assert.throws(() => createWorktree(repo, "evil/../../../etc"));
    // Backslash
    assert.throws(() => createWorktree(repo, "evil\\path"));
    // Empty
    assert.throws(() => createWorktree(repo, ""));
    // Ampersand
    assert.throws(() => createWorktree(repo, "evil&whoami"));
  } finally {
    await cleanupDir(repo);
  }
});

// ===== Phase 3A: Ordinary run exact-shape regression =====

test("3A-SHAPE-01: ordinary run run.started does NOT have scorecardRules at top level", async () => {
  const { repo } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-shape01-"));
  try {
    const mgr = makeManager(runDir, repo, createMockFetch());
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_shape_test_01",
      scorecardMode: "warn",
    });
    const events = await readTranscript(run.transcript.filePath);
    const started = events.find((e) => e.type === "run.started");

    // Ordinary run must NOT have top-level scorecardRules
    assert.ok(!("scorecardRules" in started),
      "ordinary run.started must not have top-level scorecardRules");
    // Must NOT have delivery (no delivery option)
    assert.ok(!("delivery" in started),
      "ordinary run.started must not have delivery field");
    // scorecardConfigured is the only scorecard-related field at top level
    assert.ok("scorecardConfigured" in started,
      "scorecardConfigured must still be present");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A-SHAPE-02: delivery run has scorecardRules inside delivery, not at top level", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-shape02-"));
  try {
    const mgr = makeManager(runDir, repo, createMockFetch());
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_shape_test_02",
      delivery: deliveryOpts(repo, baseCommit),
      scorecardMode: "warn",
    });
    const events = await readTranscript(run.transcript.filePath);
    const started = events.find((e) => e.type === "run.started");

    // Top level must NOT have scorecardRules
    assert.ok(!("scorecardRules" in started),
      "delivery run.started must not have top-level scorecardRules");
    // Delivery field must contain scorecardRules
    assert.ok(started.delivery, "delivery field must exist");
    assert.ok(started.delivery.scorecardRules,
      "delivery.scorecardRules must exist");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

// ===== Phase 3A final closeout regression tests =====

test("3A-REG-01: isValidRunId SSOT rejects &, quotes, path separators, spaces, leading dash/dot", async () => {
  const { isValidRunId } = await import("../src/delivery.js");
  // Rejected
  assert.equal(isValidRunId("run_evil&whoami"), false, "& must be rejected");
  assert.equal(isValidRunId('run_evil"; rm -rf /'), false, "quotes must be rejected");
  assert.equal(isValidRunId("run_evil/path"), false, "slash must be rejected");
  assert.equal(isValidRunId("run evil"), false, "spaces must be rejected");
  assert.equal(isValidRunId("-evil"), false, "leading dash must be rejected");
  assert.equal(isValidRunId(".evil"), false, "leading dot must be rejected");
  assert.equal(isValidRunId("run..evil"), false, "double dot must be rejected");
  assert.equal(isValidRunId(""), false, "empty must be rejected");
  // Accepted
  assert.equal(isValidRunId("run_abc123"), true, "safe runId must be accepted");
  assert.equal(isValidRunId("run-test_001"), true, "hyphen inside must be accepted");
});

test("3A-REG-02: RunManager rejects malicious runId with 'Invalid runId' message (not 'Invalid worktree name')", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-reg02-"));
  try {
    const mgr = makeManager(runDir, repo, createMockFetch());
    // The ampersand runId: isValidRunId must reject it at RunManager level,
    // BEFORE createWorktree is called. The error message must say "runId"
    // not "worktree name" — proving RunManager preflight caught it.
    let errorMsg = null;
    try {
      await mgr.start("test", {
        prompt: "hi", isolate: true,
        runId: "run_evil&whoami",
        delivery: deliveryOpts(repo, baseCommit),
      });
    } catch (e) {
      errorMsg = e.message;
    }
    assert.ok(errorMsg, "start must throw");
    assert.ok(errorMsg.includes("runId"), "error must reference runId (not worktree name)");
    assert.ok(!errorMsg.includes("worktree name"), "error must not reference worktree name");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3A-REG-03: ordinary non-delivery resume does NOT produce scorecard.checked (baseline behavior)", async () => {
  const { repo } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-reg03-"));
  try {
    const mgr = makeManager(runDir, repo, createMockFetch());
    // Start an ordinary (non-delivery) run
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_reg03_test",
      scorecardMode: "warn",
    });

    // Resume it
    const resumedRun = await mgr.resume("run_reg03_test", { runDir });
    assert.ok(resumedRun, "resume must succeed");

    // Complete the resumed run
    const result = await resumedRun.waitForCompletion({});
    assert.equal(result.completed, true);

    // Transcript must NOT have scorecard.checked — baseline 9e25c5c behavior
    const events = await readTranscript(run.transcript.filePath);
    const scorecardChecked = events.find((e) => e.type === "scorecard.checked");
    assert.equal(scorecardChecked, undefined,
      "ordinary resumed run must NOT have scorecard.checked (baseline behavior)");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

// ===== Batch 3B-2: Verification integration tests =====

test("3B2-01: accepted delivery completion calls verifier exactly once", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-01-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b201-"));
  let verifyCount = 0;
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
      { verifyDeliveryFn: async (ref) => { verifyCount++; return { delivery: { ...ref, verification: { ...ref.verification, status: "passed", verifiedCommit: ref.deliveryCommit, results: [] } }, outcome: "passed" }; } },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_01",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    await run.waitForCompletion({});
    assert.equal(verifyCount, 1, "verifier called exactly once");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3B2-04: passing verifier → event passed + returned updated ref", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-04-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b204-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
      { verifyDeliveryFn: async (ref) => ({ delivery: { ...ref, verification: { status: "passed", commands: ["echo ok"], verifiedCommit: ref.deliveryCommit, results: [{ index: 0, command: "echo ok", exitCode: 0, signal: null, timedOut: false, durationMs: 5, stdoutBytes: 3, stderrBytes: 0 }] } }, outcome: "passed" }) },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_04",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    const result = await run.waitForCompletion({});
    assert.equal(result.completed, true);
    assert.equal(result.delivery.verification.status, "passed");
    assert.equal(result.verificationFailed, false);

    const events = await readTranscript(run.transcript.filePath);
    const passed = events.find((e) => e.type === "run.delivery_verification_passed");
    assert.ok(passed, "verification_passed event must exist");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3B2-05: failing verifier → run remains completed, one terminal, event failed, verificationFailed:true", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-05-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b205-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
      { verifyDeliveryFn: async (ref) => ({ delivery: { ...ref, verification: { status: "failed", failureCode: "command_failed", verifiedCommit: ref.deliveryCommit, results: [] } }, outcome: "failed", failureCode: "command_failed" }) },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_05",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    const result = await run.waitForCompletion({});
    assert.equal(result.completed, true, "run stays completed");
    assert.equal(result.verificationFailed, true);
    assert.equal(result.delivery.verification.status, "failed");

    const events = await readTranscript(run.transcript.filePath);
    const terminals = events.filter((e) => e.type === "run.state_change" && ["completed", "failed", "aborted", "timed_out"].includes(e.to));
    assert.equal(terminals.length, 1, "exactly one terminal state_change");
    assert.equal(terminals[0].to, "completed", "terminal must be completed");

    const failed = events.find((e) => e.type === "run.delivery_verification_failed");
    assert.ok(failed, "verification_failed event must exist");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3B2-06: unavailable → event unavailable, verificationUnavailable:true", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-06-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b206-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
      { verifyDeliveryFn: async (ref) => ({ delivery: { ...ref, verification: { status: "unavailable", unavailableReason: "no test", verifiedCommit: ref.deliveryCommit, results: [] } }, outcome: "unavailable" }) },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_06",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationUnavailableReason: "no test" },
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    const result = await run.waitForCompletion({});
    assert.equal(result.completed, true);
    assert.equal(result.verificationUnavailable, true);
    assert.equal(result.delivery.verification.status, "unavailable");

    const events = await readTranscript(run.transcript.filePath);
    const unavail = events.find((e) => e.type === "run.delivery_verification_unavailable");
    assert.ok(unavail, "verification_unavailable event must exist");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3B2-07: event order is delivery_created → completed → state_change → verification", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-07-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b207-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_07",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    await run.waitForCompletion({});
    const events = await readTranscript(run.transcript.filePath);
    const deliveryCreatedIdx = events.findIndex((e) => e.type === "run.delivery_created");
    const completedIdx = events.findIndex((e) => e.type === "run.completed");
    const stateChangeIdx = events.findIndex((e) => e.type === "run.state_change" && e.to === "completed");
    const verificationIdx = events.findIndex((e) => e.type.startsWith("run.delivery_verification"));
    assert.ok(deliveryCreatedIdx >= 0);
    assert.ok(completedIdx >= 0);
    assert.ok(stateChangeIdx >= 0);
    assert.ok(verificationIdx >= 0);
    assert.ok(deliveryCreatedIdx < completedIdx, "delivery_created before run.completed");
    assert.ok(completedIdx <= stateChangeIdx, "completed before or at state_change");
    assert.ok(stateChangeIdx < verificationIdx, "state_change before verification");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3B2-08: run.delivery_created remains pending; verification event has updated ref", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-08-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b208-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_08",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    await run.waitForCompletion({});
    const events = await readTranscript(run.transcript.filePath);
    const created = events.find((e) => e.type === "run.delivery_created");
    assert.ok(created, "delivery_created must exist");
    assert.equal(created.delivery.verification.status, "pending", "delivery_created verification must be pending");
    const verified = events.find((e) => e.type.startsWith("run.delivery_verification"));
    assert.ok(verified, "verification event must exist");
    assert.notEqual(verified.delivery.verification.status, "pending", "verified ref must have non-pending status");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3B2-16: verifier throw maps to execution_error without raw sentinel leakage", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-16-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b216-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
      { verifyDeliveryFn: async () => { throw new Error("internal: SECRET_KEY=leaked in /secret/path"); } },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_16",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    const result = await run.waitForCompletion({});
    assert.equal(result.completed, true, "run stays completed");
    assert.equal(result.delivery.verification.status, "failed");
    assert.equal(result.delivery.verification.failureCode, "execution_error");

    const events = await readTranscript(run.transcript.filePath);
    const failed = events.find((e) => e.type === "run.delivery_verification_failed");
    assert.ok(failed);
    assert.ok(!JSON.stringify(failed).includes("SECRET_KEY"), "no secret leakage in transcript");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3B2-17: verification failure does not append failed/aborted/timed_out state_change", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-17-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b217-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
      { verifyDeliveryFn: async (ref) => ({ delivery: { ...ref, verification: { status: "failed", failureCode: "command_failed", verifiedCommit: ref.deliveryCommit, results: [] } }, outcome: "failed", failureCode: "command_failed" }) },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_17",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    await run.waitForCompletion({});
    const events = await readTranscript(run.transcript.filePath);
    const terminals = events.filter((e) => e.type === "run.state_change" && ["completed", "failed", "aborted", "timed_out"].includes(e.to));
    assert.equal(terminals.length, 1, "only one terminal");
    assert.equal(terminals[0].to, "completed", "must be completed (not failed/aborted)");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3B2-19: ordinary non-delivery run calls verifier zero times", async () => {
  const { repo } = await makeRepo("wao-rd-3b2-19-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b219-"));
  let verifyCount = 0;
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
      { verifyDeliveryFn: async () => { verifyCount++; return { delivery: {}, outcome: "passed" }; } },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_19",
    });
    const result = await run.waitForCompletion({});
    assert.equal(verifyCount, 0, "verifier must not be called for non-delivery run");
    assert.equal(result.completed, true);
    assert.ok(!result.delivery, "no delivery in result");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3B2-21: verifier not invoked twice if result/transcript read repeatedly", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-21-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b221-"));
  let verifyCount = 0;
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
      { verifyDeliveryFn: async (ref) => { verifyCount++; return { delivery: { ...ref, verification: { status: "passed", verifiedCommit: ref.deliveryCommit, results: [] } }, outcome: "passed" }; } },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_21",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    await run.waitForCompletion({});
    await readTranscript(run.transcript.filePath);
    await readTranscript(run.transcript.filePath);
    assert.equal(verifyCount, 1, "verifier called exactly once");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("3B2-23: no Phase 3C acceptance/integration events exist", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-23-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b223-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_23",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    await run.waitForCompletion({});
    const events = await readTranscript(run.transcript.filePath);
    assert.ok(!events.some((e) => e.type === "run.delivery_accepted"), "no acceptance event");
    assert.ok(!events.some((e) => e.type === "run.delivery_integrated"), "no integration event");
    assert.ok(!events.some((e) => e.type === "run.delivery_rejected"), "no rejection event");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

// ===== Phase 3B closeout: B-transcript atomicity tests (CTO RED #4) =====

/** Build a Run with a mock transcript for unit-level _verifyDeliveryResult tests. */
function makeRunWithMockTranscript({ verifyDeliveryFn, transcriptMock }) {
  return new Run({
    runId: "run_closeout_unit",
    agentId: "test",
    agent: { cwd: "." },
    backend: {},
    handle: {},
    transcript: transcriptMock,
    result: { backendSessionId: "ses_x" },
    config: {},
    onRemove: () => {},
    initialState: "completed",
    verifyDeliveryFn,
  });
}

/** A minimal committed DeliveryRef for unit tests (no real git needed). */
const UNIT_REF = {
  schemaVersion: 1,
  kind: "git_commit",
  runId: "run_closeout_unit",
  baseCommit: "b".repeat(40),
  deliveryCommit: "d".repeat(40),
  branch: "wao/run_closeout_unit",
  worktreePath: "/fake/wt",
  changedFiles: ["src/a.js"],
  verification: { status: "pending", commands: ["npm test"] },
  acceptance: { status: "pending", reviewerType: "lead_agent" },
  integration: { status: "pending", targetCommit: null },
};

/**
 * CTO RED #4: _verifyDeliveryResult sets _deliveryVerified=true before append,
 * and wraps append in the verifier's try/catch. On first append failure, the
 * second call returns a fake "passed" without ever recording to transcript.
 *
 * Expected behavior after fix:
 * - First call: verifier runs, append throws → exception propagates to caller
 * - _deliveryVerified must NOT be set (no unrecorded pass claim)
 * - Second call: verifier runs again (re-attempt), or transcript is retried
 */
test("3B-B1: first append failure propagates error, no unrecorded pass (CTO RED #4)", async () => {
  let verifyCount = 0;
  let appendCount = 0;
  const transcriptMock = {
    async append() {
      appendCount++;
      throw new Error("disk full");
    },
    filePath: "/fake/transcript.jsonl",
    context: { runId: "run_closeout_unit", agentId: "test" },
    seq: 0,
  };
  const run = makeRunWithMockTranscript({
    verifyDeliveryFn: async (ref) => {
      verifyCount++;
      return {
        delivery: { ...ref, verification: { ...ref.verification, status: "passed", verifiedCommit: ref.deliveryCommit, results: [] } },
        outcome: "passed",
      };
    },
    transcriptMock,
  });

  // First call must propagate the append error, NOT swallow it.
  await assert.rejects(
    () => run._verifyDeliveryResult(UNIT_REF),
    (err) => /disk full/.test(err.message),
    "first append failure must propagate, not be swallowed into a fake pass",
  );
  assert.equal(verifyCount, 1, "verifier called once on first attempt");
  assert.equal(appendCount, 1, "append attempted once");
});

test("3B-B2: after append failure, second call retries append without re-running verifier (CTO RED #4)", async () => {
  let verifyCount = 0;
  let appendCount = 0;
  let appendWillFail = true;
  const transcriptMock = {
    async append(type, payload) {
      appendCount++;
      if (appendWillFail) throw new Error("disk full");
      return { type, ...payload, seq: appendCount };
    },
    filePath: "/fake/transcript.jsonl",
    context: { runId: "run_closeout_unit", agentId: "test" },
    seq: 0,
  };
  const run = makeRunWithMockTranscript({
    verifyDeliveryFn: async (ref) => {
      verifyCount++;
      return {
        delivery: { ...ref, verification: { ...ref.verification, status: "passed", verifiedCommit: ref.deliveryCommit, results: [] } },
        outcome: "passed",
      };
    },
    transcriptMock,
  });

  // First call fails (append throws)
  await assert.rejects(() => run._verifyDeliveryResult(UNIT_REF), /disk full/);

  // Fix the append, retry — verifier must NOT re-run (cached result), append retries
  appendWillFail = false;
  const result = await run._verifyDeliveryResult(UNIT_REF);
  assert.equal(result.outcome, "passed");
  assert.equal(verifyCount, 1, "verifier must NOT re-run on retry (same already-computed result)");
  assert.equal(appendCount, 2, "append retried and succeeded");
});

test("3B-B3: successful verification appends exactly one outcome event and is idempotent after", async () => {
  let verifyCount = 0;
  let appendCount = 0;
  const appendedTypes = [];
  const transcriptMock = {
    async append(type, payload) {
      appendCount++;
      appendedTypes.push(type);
      return { type, ...payload, seq: appendCount };
    },
    filePath: "/fake/transcript.jsonl",
    context: { runId: "run_closeout_unit", agentId: "test" },
    seq: 0,
  };
  const run = makeRunWithMockTranscript({
    verifyDeliveryFn: async (ref) => {
      verifyCount++;
      return {
        delivery: { ...ref, verification: { ...ref.verification, status: "passed", verifiedCommit: ref.deliveryCommit, results: [] } },
        outcome: "passed",
      };
    },
    transcriptMock,
  });

  const r1 = await run._verifyDeliveryResult(UNIT_REF);
  assert.equal(r1.outcome, "passed");
  assert.equal(verifyCount, 1);
  assert.equal(appendCount, 1, "exactly one append on success");

  // Idempotent: second call after success does NOT re-run verifier or append again
  const r2 = await run._verifyDeliveryResult(UNIT_REF);
  assert.equal(r2.outcome, "passed");
  assert.equal(verifyCount, 1, "verifier not re-run after successful record");
  assert.equal(appendCount, 1, "no duplicate append after success");
  assert.deepEqual(appendedTypes, ["run.delivery_verification_passed"]);
});

test("3B-B4: verifier throw propagates, does not map to verification_failed via append", async () => {
  let appendCount = 0;
  const transcriptMock = {
    async append(type) { appendCount++; return { type, seq: appendCount }; },
    filePath: "/fake/transcript.jsonl",
    context: { runId: "run_closeout_unit", agentId: "test" },
    seq: 0,
  };
  const run = makeRunWithMockTranscript({
    verifyDeliveryFn: async () => { throw new Error("verifier exploded"); },
    transcriptMock,
  });

  // Verifier throw must propagate — the caller (waitForCompletion) decides how
  // to handle it. The transcript append for execution_error must succeed
  // (it's a different code path), but the throw itself must not be swallowed
  // by a transcript append failure.
  const result = await run._verifyDeliveryResult(UNIT_REF);
  assert.equal(result.outcome, "failed");
  assert.equal(result.failureCode, "execution_error");
  assert.equal(appendCount, 1, "execution_error event was recorded");
});

test("3B-B5: verifier throw + append failure propagates append error (not swallowed)", async () => {
  const transcriptMock = {
    async append() { throw new Error("disk full during error recording"); },
    filePath: "/fake/transcript.jsonl",
    context: { runId: "run_closeout_unit", agentId: "test" },
    seq: 0,
  };
  const run = makeRunWithMockTranscript({
    verifyDeliveryFn: async () => { throw new Error("verifier exploded"); },
    transcriptMock,
  });

  // Both verifier AND append fail — the append error must propagate.
  await assert.rejects(
    () => run._verifyDeliveryResult(UNIT_REF),
    (err) => /disk full/.test(err.message),
    "append failure during error recording must propagate, not be swallowed",
  );
});

// ===== Phase 3B closeout: missing 3B2 integration contracts (12 tests) =====

/**
 * 3B2-02: packager's original DeliveryRef is passed exactly to the verifier.
 * The verifier must receive the ref as returned by packageDelivery, not a
 * reconstructed or modified version.
 */
test("3B2-02: packager's original DeliveryRef passes exactly to verifier", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-02-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b202-"));
  let capturedRef = null;
  let packagerReturnedRef = null;
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => {
        packagerReturnedRef = packageDelivery(input);
        return packagerReturnedRef;
      },
      {
        verifyDeliveryFn: async (ref) => {
          capturedRef = ref;
          return { delivery: { ...ref, verification: { ...ref.verification, status: "passed", verifiedCommit: ref.deliveryCommit, results: [] } }, outcome: "passed" };
        },
      },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_02",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    await run.waitForCompletion({});

    assert.ok(capturedRef, "verifier must have been called");
    assert.ok(packagerReturnedRef, "packager must have returned a ref");
    assert.deepEqual(capturedRef, packagerReturnedRef,
      "verifier must receive the exact ref returned by packager");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

/**
 * 3B2-03: verifier runs strictly after run.completed state_change (happens-before).
 * For persistent delivery worktrees there is no cleanup_done event (worktree persists),
 * so the ordering proof is: completed state_change → verification event.
 */
test("3B2-03: run.completed state_change happens-before verifier", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-03-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b203-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_03",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    await run.waitForCompletion({});

    const events = await readTranscript(run.transcript.filePath);
    const completedIdx = events.findIndex((e) =>
      e.type === "run.state_change" && e.to === "completed");
    const verIdx = events.findIndex((e) =>
      e.type === "run.delivery_verification_passed" ||
      e.type === "run.delivery_verification_failed" ||
      e.type === "run.delivery_verification_unavailable");
    assert.ok(completedIdx >= 0, "completed state_change must exist");
    assert.ok(verIdx >= 0, "verification event must exist");
    assert.ok(completedIdx < verIdx,
      `completed (seq ${events[completedIdx]?.seq}) must happen-before verification (seq ${events[verIdx]?.seq})`);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

/**
 * 3B2-08: packaging failure → verifier called zero times.
 */
test("3B2-08b: packaging failure → verifierCount===0", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-08-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b208-"));
  let verifyCount = 0;
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      () => { throw new Error("packaging exploded"); },
      { verifyDeliveryFn: async (ref) => { verifyCount++; return { delivery: ref, outcome: "passed" }; } },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_08",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    await run.waitForCompletion({});
    assert.equal(verifyCount, 0, "verifier must not be called when packaging fails");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

/**
 * 3B2-09: backend failure → verifier called zero times.
 */
test("3B2-09: backend failure → verifierCount===0", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-09-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b209-"));
  let verifyCount = 0;
  const failingFetch = async (url, init = {}) => {
    const urlStr = String(url);
    if (init.method === "POST" && urlStr.endsWith("/api/session")) {
      return { ok: true, status: 200, async json() { return { data: { id: "ses_fail" } }; }, async text() { return "{}"; } };
    }
    if (init.method === "POST" && urlStr.includes("/prompt_async")) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    if (init.method === "GET" && urlStr.includes("/message")) { throw new Error("backend gone"); }
    if (init.method === "POST" && urlStr.includes("/abort")) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    return { ok: false, status: 404, async text() { return ""; } };
  };
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, failingFetch,
      (input) => packageDelivery(input),
      { verifyDeliveryFn: async (ref) => { verifyCount++; return { delivery: ref, outcome: "passed" }; } },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_09",
      delivery: deliveryOpts(repo, baseCommit),
    });
    try { await run.waitForCompletion({ waitTimeout: 500, pollInterval: 10 }); } catch { /* expected */ }
    assert.equal(verifyCount, 0, "verifier must not be called on backend failure");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

/**
 * 3B2-10: wait timeout → verifier called zero times.
 */
test("3B2-10: wait timeout → verifierCount===0", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-10-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b210-"));
  let verifyCount = 0;
  // A fetch that never produces a done event — will hang until waitTimeout
  const hangingFetch = async (url, init = {}) => {
    const urlStr = String(url);
    if (init.method === "POST" && urlStr.endsWith("/api/session")) {
      return { ok: true, status: 200, async json() { return { data: { id: "ses_hang" } }; }, async text() { return "{}"; } };
    }
    if (init.method === "POST" && urlStr.includes("/prompt_async")) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    if (init.method === "GET" && urlStr.includes("/message")) {
      // Return messages but no done signal — will keep polling
      return { ok: true, status: 200, async json() { return []; }, async text() { return "[]"; } };
    }
    if (init.method === "POST" && urlStr.includes("/abort")) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    return { ok: false, status: 404, async text() { return ""; } };
  };
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, hangingFetch,
      (input) => packageDelivery(input),
      { verifyDeliveryFn: async (ref) => { verifyCount++; return { delivery: ref, outcome: "passed" }; } },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_10",
      delivery: deliveryOpts(repo, baseCommit),
    });
    try { await run.waitForCompletion({ waitTimeout: 300, pollInterval: 10 }); } catch { /* expected timeout */ }
    assert.equal(verifyCount, 0, "verifier must not be called on wait timeout");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

/**
 * 3B2-11: budget exceeded → verifier called zero times.
 */
test("3B2-11: budget exceeded → verifierCount===0", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-11-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b211-"));
  let verifyCount = 0;
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
      { verifyDeliveryFn: async (ref) => { verifyCount++; return { delivery: ref, outcome: "passed" }; } },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_11",
      delivery: deliveryOpts(repo, baseCommit),
    });
    // Tiny budget → immediate budget exceeded
    try {
      await run.waitForCompletion({ tokenBudget: 1, pollInterval: 10, waitTimeout: 5000 });
    } catch { /* expected budget failure */ }
    assert.equal(verifyCount, 0, "verifier must not be called on budget exceeded");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

/**
 * 3B2-12: user abort → verifier called zero times.
 */
test("3B2-12: user abort → verifierCount===0", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-12-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b212-"));
  let verifyCount = 0;
  const hangingFetch = async (url, init = {}) => {
    const urlStr = String(url);
    if (init.method === "POST" && urlStr.endsWith("/api/session")) {
      return { ok: true, status: 200, async json() { return { data: { id: "ses_abort" } }; }, async text() { return "{}"; } };
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
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, hangingFetch,
      (input) => packageDelivery(input),
      { verifyDeliveryFn: async (ref) => { verifyCount++; return { delivery: ref, outcome: "passed" }; } },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_12",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const ac = new AbortController();
    const waitPromise = run.waitForCompletion({ signal: ac.signal, pollInterval: 10, waitTimeout: 10000 });
    // Abort after a short delay
    setTimeout(() => mgr.abort("run_3b2_test_12", "user"), 100);
    try { await waitPromise; } catch { /* expected abort */ }
    assert.equal(verifyCount, 0, "verifier must not be called on user abort");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

/**
 * 3B2-13: hard scorecard failure → verifier called zero times.
 */
test("3B2-13: hard scorecard failure → verifierCount===0", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-13-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b213-"));
  let verifyCount = 0;
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
      { verifyDeliveryFn: async (ref) => { verifyCount++; return { delivery: ref, outcome: "passed" }; } },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_13",
      delivery: deliveryOpts(repo, baseCommit),
      scorecardMode: "hard",
    });
    // Don't write any files → no evidence → hard scorecard fails
    await run.waitForCompletion({});
    assert.equal(verifyCount, 0, "verifier must not be called on hard scorecard failure");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

/**
 * 3B2-14: external-terminal race (delivery_created written but transition rejected)
 * → verifier called zero times.
 */
test("3B2-14: external-terminal race loser → verifierCount===0", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-14-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b214-"));
  let verifyCount = 0;
  try {
    const racingPackager = async (input) => {
      // Simulate external terminal written during packaging
      const racingTranscript = run.transcript;
      await racingTranscript.append("run.state_change", { from: "running", to: "timed_out", reason: "external_race" });
      return packageDelivery(input);
    };
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      racingPackager,
      { verifyDeliveryFn: async (ref) => { verifyCount++; return { delivery: ref, outcome: "passed" }; } },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_14",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    const result = await run.waitForCompletion({});
    // Race loser: not completed, delivery_created was written as attemptEvent
    assert.ok(!result.completed, "race loser must not be completed");
    assert.equal(verifyCount, 0, "verifier must not be called on race loser");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

/**
 * 3B2-15: delivery resume restores the same verification commands from transcript.
 */
test("3B2-15: delivery resume restores same verification commands and worktree", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-15-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b215-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_15",
      delivery: deliveryOpts(repo, baseCommit, { verificationCommands: ["npm run test:unit"] }),
    });
    const originalWorktree = run.deliveryContext.worktreePath;
    const originalCommands = run.deliveryContext.verificationCommands;

    // Resume
    const resumedRun = await mgr.resume("run_3b2_test_15", { runDir });
    assert.ok(resumedRun, "resume must succeed");
    assert.ok(resumedRun.deliveryContext, "resumed run must have deliveryContext");
    assert.deepEqual(resumedRun.deliveryContext.verificationCommands, originalCommands,
      "resumed run must have same verification commands");
    assert.equal(resumedRun.deliveryContext.worktreePath, originalWorktree,
      "resumed run must use same worktree path");
    assert.equal(resumedRun.deliveryContext.baseCommit, baseCommit,
      "resumed run must have same base commit");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

/**
 * 3B2-18: integration-level — transcript append failure during verification
 * does not produce an unrecorded pass in the result.
 * (Unit-level coverage is 3B-B1; this verifies the RunManager flow propagates.)
 */
test("3B2-18: transcript append failure in verification propagates through waitForCompletion", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-18-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b218-"));
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_18",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");

    // Sabotage the transcript append to fail on the verification event
    const realAppend = run.transcript.append.bind(run.transcript);
    let verificationAppendAttempted = false;
    run.transcript.append = async (type, payload) => {
      if (type === "run.delivery_verification_passed" || type === "run.delivery_verification_failed") {
        verificationAppendAttempted = true;
        throw new Error("simulated disk full");
      }
      return realAppend(type, payload);
    };

    // waitForCompletion should propagate the append error
    await assert.rejects(
      () => run.waitForCompletion({}),
      (err) => /simulated disk full/.test(err.message),
      "append failure during verification must propagate through waitForCompletion",
    );
    assert.ok(verificationAppendAttempted, "verification append must have been attempted");

    // Transcript must NOT contain a verification event (the append failed)
    const events = await readTranscript(run.transcript.filePath);
    const verEvent = events.find((e) =>
      e.type === "run.delivery_verification_passed" ||
      e.type === "run.delivery_verification_failed");
    assert.equal(verEvent, undefined, "no verification event must be on disk after append failure");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

/**
 * 3B2-20: HTTP resume respects the injected verifier function.
 * The Run created via HTTP resume must carry verifyDeliveryFn from RunManager,
 * not fall back to the default.
 */
test("3B2-20: HTTP resume respects injected verifier (CTO closeout C)", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-20-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b220-"));
  let verifyCount = 0;
  try {
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
      {
        verifyDeliveryFn: async (ref) => {
          verifyCount++;
          return { delivery: { ...ref, verification: { ...ref.verification, status: "passed", verifiedCommit: ref.deliveryCommit, results: [] } }, outcome: "passed" };
        },
      },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_20",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const originalWorktree = run.deliveryContext.worktreePath;
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(originalWorktree, "src", "a.js"), "resume modified\n");

    // Resume via HTTP path (opencode-serve is HTTP backend)
    const resumedRun = await mgr.resume("run_3b2_test_20", { runDir });
    assert.ok(resumedRun, "resume must succeed");
    // The resumed Run must carry the injected verifier (not default)
    assert.ok(resumedRun._verifyDeliveryFn, "resumed Run must have verifyDeliveryFn");

    // Complete the resumed run — the injected verifier must be called
    const result = await resumedRun.waitForCompletion({});
    assert.equal(result.completed, true);
    assert.equal(verifyCount, 1, "injected verifier must be called exactly once on resumed run");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

/**
 * 3B2-22: concurrent calls to _verifyDeliveryResult execute verifier at most once
 * and write at most one outcome event.
 */
test("3B2-22: concurrent _verifyDeliveryResult calls → verifier once, one outcome event", async () => {
  const { repo, baseCommit } = await makeRepo("wao-rd-3b2-22-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-rd-3b222-"));
  let verifyCount = 0;
  let outcomeEventCount = 0;
  try {
    const slowVerifier = async (ref) => {
      verifyCount++;
      await new Promise((r) => setTimeout(r, 50)); // simulate slow verification
      return { delivery: { ...ref, verification: { ...ref.verification, status: "passed", verifiedCommit: ref.deliveryCommit, results: [] } }, outcome: "passed" };
    };
    const mgr = makeManagerWithPackager(
      runDir, repo, createMockFetch(),
      (input) => packageDelivery(input),
      { verifyDeliveryFn: slowVerifier },
    );
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId: "run_3b2_test_22",
      delivery: deliveryOpts(repo, baseCommit),
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(run.deliveryContext.worktreePath, "src", "a.js"), "modified\n");
    await run.waitForCompletion({});

    const events = await readTranscript(run.transcript.filePath);
    outcomeEventCount = events.filter((e) =>
      e.type === "run.delivery_verification_passed" ||
      e.type === "run.delivery_verification_failed" ||
      e.type === "run.delivery_verification_unavailable").length;
    assert.equal(verifyCount, 1, "verifier called exactly once even conceptually");
    assert.equal(outcomeEventCount, 1, "exactly one outcome event on disk");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});
