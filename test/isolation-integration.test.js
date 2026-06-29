import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { RunManager } from "../src/runManager.js";
import { OpenCodeServeBackend } from "../src/backends/opencodeServe.js";
import { readTranscript } from "../src/transcript.js";

function createMockFetch() {
  const sessions = new Map();
  return async (url, init = {}) => {
    const urlStr = String(url);
    if (init.method === "POST" && urlStr.endsWith("/api/session")) {
      const id = `ses_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      sessions.set(id, { messages: [] });
      return {
        ok: true, status: 200,
        async json() { return { data: { id } }; },
        async text() { return "{}"; },
      };
    }
    if (init.method === "POST" && urlStr.includes("/prompt_async")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const body = JSON.parse(init.body);
      const session = sessions.get(sessionId);
      if (session) {
        session.messages.push({ info: { id: body.messageID, role: "user" }, parts: body.parts });
        session.messages.push({
          info: { id: "msg_reply", role: "assistant" },
          parts: [{ type: "text", text: "ok" }],
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
        async text() { return "[]"; },
      };
    }
    if (init.method === "POST" && urlStr.includes("/abort")) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    return { ok: false, status: 404, async text() { return ""; } };
  };
}

async function makeTempRepo() {
  const dir = await mkdtemp(join(tmpdir(), "wao-iso-rm-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "t@t"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "t"', { cwd: dir, stdio: "ignore" });
  await writeFile(join(dir, "README.md"), "# test\n");
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeManager(dir, fetchImpl, repoDir) {
  const config = {
    registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 2000,
    timeout: 5000, retries: 0, defaultIsolation: "none",
  };
  const readRegistry = async () => ({
    getAgent(id, overrides = {}) {
      // filter undefined（和真 registry.js 一致）
      const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
      return {
        id, backend: "opencode-serve", serveUrl: "http://127.0.0.1:4299",
        agent: "build", cwd: repoDir ?? dir,
        model: { providerID: "p", id: "m" },
        ...defined,
      };
    },
    listAgents() { return []; },
  });
  return new RunManager({
    config, readRegistry,
    backendFor: () => new OpenCodeServeBackend({ fetchImpl, timeout: 1000, retries: 0 }),
  });
}

test("isolate:true 创建 worktree，cwd 指向 worktree", async () => {
  const repo = await makeTempRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rm-wt-"));
  try {
    const mgr = makeManager(runDir, createMockFetch(), repo);
    const run = await mgr.start("test", { prompt: "hi", isolate: true, runId: "wt_test_1" });
    const events = await readTranscript(run.transcript.filePath);
    const started = events.find((e) => e.type === "run.started");
    assert.ok(started.worktreePath, "transcript should record worktreePath");
    assert.ok(existsSync(started.worktreePath), "worktree should exist on disk");
    await run.waitForCompletion({});
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});

test("isolate:false 不创建 worktree（行为不变）", async () => {
  const repo = await makeTempRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rm-nowt-"));
  try {
    const mgr = makeManager(runDir, createMockFetch(), repo);
    const run = await mgr.start("test", { prompt: "hi", isolate: false });
    const events = await readTranscript(run.transcript.filePath);
    const started = events.find((e) => e.type === "run.started");
    assert.ok(!started.worktreePath, "should not have worktreePath");
    await run.waitForCompletion({});
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});

test("ephemeral worktree: run 完成后被清理", async () => {
  const repo = await makeTempRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rm-eph-"));
  try {
    const config = {
      registry: "x", runDir, pollInterval: 10, waitTimeout: 2000,
      timeout: 5000, retries: 0, defaultIsolation: "none",
    };
    const readRegistry = async () => ({
      getAgent(id, overrides = {}) {
        const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
        return {
          id, backend: "opencode-serve", serveUrl: "http://127.0.0.1:4299",
          agent: "build", cwd: repo, model: { providerID: "p", id: "m" },
          isolation: { type: "worktree", strategy: "ephemeral" },
          ...defined,
        };
      },
      listAgents() { return []; },
    });
    const mgr = new RunManager({
      config, readRegistry,
      backendFor: () => new OpenCodeServeBackend({ fetchImpl: createMockFetch(), timeout: 1000, retries: 0 }),
    });
    const run = await mgr.start("test", { prompt: "hi", runId: "eph_test_1" });
    const events = await readTranscript(run.transcript.filePath);
    const started = events.find((e) => e.type === "run.started");
    const wtPath = started.worktreePath;
    assert.ok(existsSync(wtPath), "worktree exists during run");
    await run.waitForCompletion({});
    // ephemeral → 完成后应被清理
    assert.ok(!existsSync(wtPath), "worktree should be removed after ephemeral run completes");
    const cleanupEvent = events.find((e) => e.type === "run.cleanup_done")
      || (await readTranscript(run.transcript.filePath)).find((e) => e.type === "run.cleanup_done");
    assert.ok(cleanupEvent, "should have cleanup_done event");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});

test("persistent worktree: run 完成后保留", async () => {
  const repo = await makeTempRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-rm-per-"));
  try {
    const mgr = makeManager(runDir, createMockFetch(), repo);
    const run = await mgr.start("test", { prompt: "hi", isolate: true, runId: "per_test_1" });
    const events = await readTranscript(run.transcript.filePath);
    const wtPath = events.find((e) => e.type === "run.started").worktreePath;
    await run.waitForCompletion({});
    // persistent → 保留
    assert.ok(existsSync(wtPath), "worktree should persist after run");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});
