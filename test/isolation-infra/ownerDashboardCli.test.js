// test/ownerDashboardCli.test.js
//
// M12-8D Package D — `runs dashboard --web` CLI adapter (TDD).
//
// The web command is exercised via INJECTION: a fake server factory, a fake
// workspace authority, a fake registry reader, a controllable shutdown lifecycle,
// and a capturing stdout sink. No real socket is bound, no git is run, no
// registry file is read, and no OS signal is delivered — so startup / fragment /
// conflict / shutdown are all deterministic.
//
// Non-web behavior is byte-compatible (covered by test/cli.test.js); here we
// only assert the new --web surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDashboardWeb, runsDashboardCommand } from "../../src/commands/runs.js";
import { readRegistry } from "../../src/registry.js";

// Flush the microtask + macrotask queues so an async function can run until it
// parks at an injected await (here: lifecycle.wait()).
const flush = () => new Promise((r) => setImmediate(r));

// Fake server: deterministic token/port, tracks listen + close.
function makeFakeServer(opts = {}) {
  const token = opts.token || "ab".repeat(32);
  const port = opts.port ?? 7654;
  const self = {
    token,
    listenCalled: false,
    closeCalled: false,
    listen: async () => { self.listenCalled = true; return { port, host: "127.0.0.1", family: "IPv4" }; },
    close: async () => { self.closeCalled = true; },
  };
  return self;
}

// Controllable lifecycle: wait() parks until resolve() is called (the test
// "delivers the shutdown signal"). No `this` dependency.
function makeControllableLifecycle() {
  let resolveWait;
  const done = new Promise((r) => { resolveWait = r; });
  return {
    wait: () => done,
    resolve: () => resolveWait(),
    cancel() {},
  };
}

const baseConfig = { runDir: "/runs", registry: "config/agents.json" };

// Default injections: minimal fakes that let the command park at lifecycle.wait.
function defaultInjections(server, lc, extras = {}) {
  return {
    createServerFn: () => server,
    proveWorkspaceFn: (cwd) => ({ root: cwd }),
    readRegistryFn: async () => ({ listAgents: () => [] }),
    lifecycle: lc,
    log: () => {},
    ...extras,
  };
}

// =====================================================================
// STARTUP + FRAGMENT — exactly one URL (token in fragment) + Ctrl-C line
// =====================================================================
test("STARTUP: prints exactly one URL (#token=<64hex>, path '/') + Ctrl-C line", async () => {
  const lc = makeControllableLifecycle();
  const logs = [];
  const server = makeFakeServer({ port: 7654, token: "ab".repeat(32) });
  let created = null;

  const p = runDashboardWeb(
    { web: true, port: "7654" },
    baseConfig,
    {
      createServerFn: (cfg) => { created = cfg; return server; },
      proveWorkspaceFn: (cwd) => ({ root: "/canonical/ws" }),
      readRegistryFn: async () => ({ listAgents: () => [{ id: "coder_low" }] }),
      lifecycle: lc,
      log: (s) => logs.push(s),
    },
  );

  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await flush();

  // Stays alive until the shutdown signal (parked at lifecycle.wait).
  assert.equal(settled, false, "stays alive until shutdown signal");
  assert.equal(server.listenCalled, true, "listened");
  assert.equal(logs.length, 2, "exactly two log lines (no auto-open / no extra noise)");
  assert.match(logs[0], /^http:\/\/127\.0\.0\.1:7654\/#token=[0-9a-f]{64}$/, "URL shape: host:port/#token=<64hex>");
  assert.ok(logs[0].endsWith("#token=" + "ab".repeat(32)), "token is the server-issued 64-hex");
  assert.ok(!logs[0].includes("?"), "no query string — token only in fragment");
  assert.equal(logs[1], "(Ctrl-C to stop)");

  // Server-owned inputs threaded from the SHARED authorities.
  assert.equal(created.port, 7654);
  assert.deepEqual(created.knownAgentIds, ["coder_low"]);
  assert.equal(created.workspaceRoot, "/canonical/ws");
  assert.ok(typeof created.runDir === "string" && created.runDir.length > 0);

  // Shutdown: resolving the lifecycle closes the server and the command returns.
  lc.resolve();
  await p;
  assert.equal(settled, true);
  assert.equal(server.closeCalled, true, "server closed on shutdown");
});

test("FRAGMENT: default port (ephemeral) — printed URL uses the listen port, not 0", async () => {
  const lc = makeControllableLifecycle();
  const logs = [];
  const server = makeFakeServer({ port: 4321, token: "0".repeat(64) });
  let created = null;
  const p = runDashboardWeb(
    { web: true },
    baseConfig,
    {
      createServerFn: (cfg) => { created = cfg; return server; },
      proveWorkspaceFn: (cwd) => ({ root: cwd }),
      readRegistryFn: async () => ({ listAgents: () => [] }),
      lifecycle: lc,
      log: (s) => logs.push(s),
    },
  );
  await flush();
  assert.equal(created.port, 0, "no --port → ephemeral (0) sent to the server");
  assert.match(logs[0], /^http:\/\/127\.0\.0\.1:4321\/#token=[0-9a-f]{64}$/, "URL uses listen port");
  lc.resolve();
  await p;
});

// =====================================================================
// CONFLICT — --web rejects --watch and --format json (async → assert.rejects)
// =====================================================================
test("CONFLICT: --web with --watch is rejected (clear error, before any server)", async () => {
  await assert.rejects(
    () => runsDashboardCommand(["--web", "--watch", "5"], baseConfig),
    /--web.*--watch|--watch.*--web/i,
  );
});

test("CONFLICT: --web with --format json is rejected", async () => {
  await assert.rejects(
    () => runsDashboardCommand(["--web", "--format", "json"], baseConfig),
    /--web.*--format|--format.*--web/i,
  );
});

test("CONFLICT: --web alone does NOT throw on the conflict checks", async () => {
  // Reaches runDashboardWeb (which then parks at the injected lifecycle). The
  // conflict checks themselves must pass for plain --web.
  const lc = makeControllableLifecycle();
  const server = makeFakeServer();
  const p = runsDashboardCommand(["--web"], baseConfig, defaultInjections(server, lc));
  await flush();
  assert.equal(server.listenCalled, true, "--web reached the server");
  lc.resolve();
  await p;
});

// =====================================================================
// PORT — optional --port must be an integer
// =====================================================================
test("PORT: non-integer --port is rejected before the server is created", async () => {
  const lc = makeControllableLifecycle();
  let createCalls = 0;
  await assert.rejects(
    runDashboardWeb(
      { web: true, port: "abc" },
      baseConfig,
      defaultInjections(makeFakeServer(), lc, {
        createServerFn: () => { createCalls += 1; return makeFakeServer(); },
      }),
    ),
    /--port must be an integer/i,
  );
  assert.equal(createCalls, 0, "no server created on bad port");
});

// =====================================================================
// SHARED AUTHORITY — workspace + registry results threaded; fail-soft
// =====================================================================
test("AUTHORITY: proveWorkspace + readRegistry outputs threaded to the server", async () => {
  const lc = makeControllableLifecycle();
  let created = null;
  let proveCalled = false;
  let registryCalled = false;
  const p = runDashboardWeb(
    { web: true },
    baseConfig,
    {
      createServerFn: (cfg) => { created = cfg; return makeFakeServer(); },
      proveWorkspaceFn: () => { proveCalled = true; return { root: "/canonical/root" }; },
      readRegistryFn: async () => { registryCalled = true; return { listAgents: () => [{ id: "coder_hq" }, { id: "kimi_low" }] }; },
      lifecycle: lc,
      log: () => {},
    },
  );
  await flush();
  assert.equal(proveCalled, true, "shared workspace authority invoked");
  assert.equal(registryCalled, true, "shared registry reader invoked");
  assert.equal(created.workspaceRoot, "/canonical/root", "canonical root threaded");
  assert.deepEqual(created.knownAgentIds, ["coder_hq", "kimi_low"], "registry ids threaded");
  lc.resolve();
  await p;
});

test("AUTHORITY: unprovable workspace fails SOFT (dashboard still starts)", async () => {
  const lc = makeControllableLifecycle();
  let created = null;
  const p = runDashboardWeb(
    { web: true },
    baseConfig,
    {
      createServerFn: (cfg) => { created = cfg; return makeFakeServer(); },
      proveWorkspaceFn: () => { throw new Error("not a git repo"); },
      readRegistryFn: async () => ({ listAgents: () => [] }),
      lifecycle: lc,
      log: () => {},
    },
  );
  await flush();
  assert.ok(typeof created.workspaceRoot === "string" && created.workspaceRoot.length > 0, "falls back without crashing");
  lc.resolve();
  await p;
});

test("AUTHORITY: registry unavailable fails SOFT (empty knownAgentIds)", async () => {
  const lc = makeControllableLifecycle();
  let created = null;
  const p = runDashboardWeb(
    { web: true },
    baseConfig,
    {
      createServerFn: (cfg) => { created = cfg; return makeFakeServer(); },
      proveWorkspaceFn: (cwd) => ({ root: cwd }),
      readRegistryFn: async () => { throw new Error("no registry"); },
      lifecycle: lc,
      log: () => {},
    },
  );
  await flush();
  assert.deepEqual(created.knownAgentIds, [], "registry failure → empty ids, no crash");
  lc.resolve();
  await p;
});

// =====================================================================
// SHUTDOWN — close is called even if the wait rejects (process signal kill)
// =====================================================================
test("SHUTDOWN: server is closed in a finally (runs even if wait rejects)", async () => {
  const server = makeFakeServer();
  const lc = {
    wait: () => Promise.reject(new Error("signal")),
    cancel() {},
  };
  await assert.rejects(
    runDashboardWeb(
      { web: true },
      baseConfig,
      defaultInjections(server, lc),
    ),
    /signal/,
  );
  assert.equal(server.closeCalled, true, "close ran in finally despite the rejected wait");
});

// =====================================================================
// P0 (2026-10-03) — REAL registry shape regression pins.
//
// The production readRegistry() has ALWAYS returned {listAgents, getAgent,
// rawEntries} and never an `agents` array; runDashboardWeb's old
// Array.isArray(reg.agents) check was a day-one wiring defect that silently
// emptied knownAgentIds (every production run showed agentId "unknown";
// injected fakes matched the wrong shape and hid it — same family as the
// M12-25B finding in the MCP path). These pins bind the dashboard wiring to
// the REAL reader + REAL file shape so the seam cannot drift silently again.
// =====================================================================

// Real fs reads park on the libuv thread pool — one setImmediate flush is not
// enough for the real reader. Bounded poll until the command reaches
// createServerFn (or fail loudly if it never does).
async function waitFor(pred, label) {
  for (let i = 0; i < 200 && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(pred(), label);
}

function writeRegistry(dir, agents) {
  const regPath = join(dir, "agents.json");
  writeFileSync(regPath, JSON.stringify({ agents }), "utf8");
  return regPath;
}

test("P0 REAL-SHAPE: real readRegistry ids reach the server (exact ids, not just non-empty)", async () => {
  const lc = makeControllableLifecycle();
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-reg-"));
  let created = null;
  try {
    // codex entries: process backend with no registry-required extras, so the
    // pin exercises the wiring, not per-backend validation.
    const regPath = writeRegistry(dir, {
      coder_hq: { backend: "codex", cwd: "/x" },
      researcher: { backend: "codex", cwd: "/x" },
    });
    const p = runDashboardWeb(
      { web: true },
      { ...baseConfig, registry: regPath },
      {
        createServerFn: (cfg) => { created = cfg; return makeFakeServer(); },
        proveWorkspaceFn: (cwd) => ({ root: cwd }),
        // NOTE: no readRegistryFn — the PRODUCTION reader runs against a real file.
        lifecycle: lc,
        log: () => {},
      },
    );
    await waitFor(() => created !== null, "createServerFn reached (real fs read settled)");
    assert.deepEqual(created.knownAgentIds, ["coder_hq", "researcher"],
      "exact real-registry ids threaded (order = file order)");
    lc.resolve();
    await p;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0 FROZEN-SHAPE: readRegistry exposes listAgents() and no agents array", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-shape-"));
  try {
    const regPath = writeRegistry(dir, { coder_hq: { backend: "codex", cwd: "/x" } });
    const reg = await readRegistry(regPath);
    assert.equal(typeof reg.listAgents, "function", "listAgents is the dashboard/MCP consumption surface");
    assert.ok(Array.isArray(reg.listAgents()), "listAgents() returns an array");
    assert.ok(!Array.isArray(reg.agents), "no agents array on the service shape — consumers must use listAgents()");
    assert.deepEqual(reg.listAgents().map((a) => a.id), ["coder_hq"], "normalized entries carry id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0 DEGRADED: corrupt registry file fails SOFT (empty ids, no crash)", async () => {
  const lc = makeControllableLifecycle();
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-corrupt-"));
  let created = null;
  try {
    const regPath = join(dir, "agents.json");
    writeFileSync(regPath, "{ not json", "utf8");
    const p = runDashboardWeb(
      { web: true },
      { ...baseConfig, registry: regPath },
      {
        createServerFn: (cfg) => { created = cfg; return makeFakeServer(); },
        proveWorkspaceFn: (cwd) => ({ root: cwd }),
        lifecycle: lc,
        log: () => {},
      },
    );
    await waitFor(() => created !== null, "createServerFn reached despite corrupt registry");
    assert.deepEqual(created.knownAgentIds, [], "corrupt registry → empty ids (degraded 'unknown'), server still starts");
    lc.resolve();
    await p;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0 DEGRADED: one malformed entry fails the whole list SOFT (documented readRegistry semantics)", async () => {
  const lc = makeControllableLifecycle();
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-badentry-"));
  let created = null;
  try {
    const regPath = writeRegistry(dir, {
      coder_hq: { backend: "codex", cwd: "/x" },
      broken: {}, // missing backend → normalizeAgent throws inside listAgents()
    });
    const p = runDashboardWeb(
      { web: true },
      { ...baseConfig, registry: regPath },
      {
        createServerFn: (cfg) => { created = cfg; return makeFakeServer(); },
        proveWorkspaceFn: (cwd) => ({ root: cwd }),
        lifecycle: lc,
        log: () => {},
      },
    );
    await waitFor(() => created !== null, "createServerFn reached despite malformed entry");
    assert.deepEqual(created.knownAgentIds, [],
      "single malformed entry → whole list degrades to empty (agentIds 'unknown'), no crash");
    lc.resolve();
    await p;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
