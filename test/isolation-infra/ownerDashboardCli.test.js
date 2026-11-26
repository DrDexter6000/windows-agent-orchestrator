// test/ownerDashboardCli.test.js
//
// `runDashboardWeb` — the launcher behind `wao dashboard` (145a: `runs dashboard
// --web` is retired; this is the only caller left, so the old legacy seams are
// gone with it).
//
// The web command is exercised via INJECTION: a fake server factory, a controllable
// shutdown lifecycle, and a capturing stdout sink. No real socket is bound, no git
// is run, no registry file is read, and no OS signal is delivered — so startup /
// fragment / retirement / shutdown are all deterministic.
//
// Non-web behavior is byte-compatible (covered by test/cli.test.js); here we
// only assert the web surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDashboardWeb, runsDashboardCommand } from "../../src/commands/runs.js";
import { RUNS_DASHBOARD_WEB_RETIRED_MESSAGE } from "../../src/cliHelp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

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
    lifecycle: lc,
    log: () => {},
    ...extras,
  };
}

// =====================================================================
// STARTUP + FRAGMENT — exactly one URL (token in fragment) + Ctrl-C line
// =====================================================================
test("STARTUP: prints exactly one URL (#token=<64hex>, the /v2/ entry) + Ctrl-C line", async () => {
  const lc = makeControllableLifecycle();
  const logs = [];
  const server = makeFakeServer({ port: 7654, token: "ab".repeat(32) });
  let created = null;

  const p = runDashboardWeb(
    { web: true, port: "7654" },
    baseConfig,
    {
      createServerFn: (cfg) => { created = cfg; return server; },
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
  assert.match(logs[0], /^http:\/\/127\.0\.0\.1:7654\/v2\/#token=[0-9a-f]{64}$/, "URL shape: host:port/v2/#token=<64hex>");
  assert.ok(logs[0].endsWith("#token=" + "ab".repeat(32)), "token is the server-issued 64-hex");
  assert.ok(!logs[0].includes("?"), "no query string — token only in fragment");
  assert.equal(logs[1], "(Ctrl-C to stop)");

  // Server-owned inputs threaded from the ONE remaining caller: the run directory and the port.
  assert.equal(created.port, 7654);
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
      lifecycle: lc,
      log: (s) => logs.push(s),
    },
  );
  await flush();
  assert.equal(created.port, 0, "no --port → ephemeral (0) sent to the server");
  assert.match(logs[0], /^http:\/\/127\.0\.0\.1:4321\/v2\/#token=[0-9a-f]{64}$/, "URL uses listen port and the /v2/ entry");
  lc.resolve();
  await p;
});

// =====================================================================
// RETIRED — `runs dashboard --web` fails with the fixed text (the `wao ask` style)
// =====================================================================
test("RETIRED: runs dashboard --web throws the fixed text pointing at wao dashboard (never reaches a server)", async () => {
  for (const args of [["--web"], ["--web", "--port", "7654"], ["--web", "--watch", "5"], ["--web", "--format", "json"]]) {
    await assert.rejects(
      () => runsDashboardCommand(args, baseConfig),
      (error) => error.message === RUNS_DASHBOARD_WEB_RETIRED_MESSAGE,
      args.join(" "),
    );
  }
  assert.match(RUNS_DASHBOARD_WEB_RETIRED_MESSAGE, /runs dashboard --web/);
  assert.match(RUNS_DASHBOARD_WEB_RETIRED_MESSAGE, /wao dashboard/);
});

test("RETIRED: the CLI exits non-zero with that text (and prints no URL)", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "src", "cli.js"), "runs", "dashboard", "--web"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(r.status, 1, `exit code 1 (stderr: ${r.stderr})`);
  assert.ok(r.stderr.includes(RUNS_DASHBOARD_WEB_RETIRED_MESSAGE), "the fixed text is on stderr");
  assert.ok(!/http:\/\/127\.0\.0\.1/.test(r.stdout + r.stderr), "no dashboard URL is printed");
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
// AUTHORITY — the server-owned runDir + explicit port are threaded; no legacy
// workspace/registry resolution remains (145a: only `wao dashboard` calls this)
// =====================================================================
test("AUTHORITY: the server receives the runDir from config and the explicit port; nothing legacy is resolved", async () => {
  const lc = makeControllableLifecycle();
  let created = null;
  const p = runDashboardWeb(
    { web: true, port: "7654", runDir: "/explicit/runs" },
    baseConfig,
    {
      createServerFn: (cfg) => { created = cfg; return makeFakeServer(); },
      // Legacy seams are gone: providing them changes nothing, because nothing reads them.
      proveWorkspaceFn: () => { throw new Error("must not be called"); },
      readRegistryFn: async () => { throw new Error("must not be called"); },
      lifecycle: lc,
      log: () => {},
    },
  );
  await flush();
  assert.deepEqual(Object.keys(created).sort(), ["port", "runDir"], "exactly the two server-owned inputs remain");
  assert.equal(created.port, 7654);
  assert.equal(created.runDir, resolve("/explicit/runs"), "an explicit --run-dir wins over config.runDir (resolved from the caller cwd)");
  lc.resolve();
  await p;
});

test("AUTHORITY: without --run-dir the config runDir is used", async () => {
  const lc = makeControllableLifecycle();
  let created = null;
  const p = runDashboardWeb(
    { web: true },
    baseConfig,
    {
      createServerFn: (cfg) => { created = cfg; return makeFakeServer(); },
      lifecycle: lc,
      log: () => {},
    },
  );
  await flush();
  assert.equal(created.runDir, resolve(baseConfig.runDir), "config.runDir resolved for the server");
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
