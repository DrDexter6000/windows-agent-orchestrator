// test/ownerDashboardLauncher.test.js
//
// M12-8F Package F — top-level `wao dashboard` human Owner launcher + `wao`
// global bin (TDD).
//
// Three deterministic surfaces are covered here:
//
//   A) BIN/WRAPPER — package.json declares `bin.wao` → bin/wao.js; the wrapper
//      forwards through scripts/wao-node.cjs (the single Node v22 selector) and
//      never duplicates the version lookup or bypasses the guard. Proven both
//      statically (source contract) and behaviorally (spawn the wrapper with a
//      deterministic WAO_NODE; spawn it again with a bogus WAO_NODE → the shim's
//      127 guard still fires).
//
//   B) LAUNCHER — dashboardCommand via NARROW injection seams (server factory,
//      git-root resolver, browser opener, lifecycle, logger). No real socket is
//      bound, no git is run (except the two real-git canonical-root cases), no
//      browser is launched, no OS signal is delivered.
//
//   C) LEGACY — `runs dashboard --web` does not auto-open and keeps its
//      fail-soft non-Git fallback; `node src/cli.js help` documents the primary
//      `wao dashboard` command.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { dashboardCommand, resolveCanonicalGitRoot } from "../src/commands/dashboard.js";
import { runDashboardWeb, runsDashboardCommand } from "../src/commands/runs.js";
import { canonicalizeWorkspacePath } from "../src/application/workspaceBinding.js";
import { rmrfRetry } from "./_rmrfHelper.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BIN_WRAPPER = join(ROOT, "bin", "wao.js");

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

// Controllable lifecycle: wait() parks until resolve() is called.
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

// Default launcher injections: deterministic fakes that park at lifecycle.wait.
function launcherInjections(server, lc, extras = {}) {
  return {
    gitRootFn: () => "/canonical/ws",
    openUrlFn: async () => {},
    createServerFn: () => server,
    readRegistryFn: async () => ({ agents: [] }),
    lifecycle: lc,
    log: () => {},
    ...extras,
  };
}

// =====================================================================
// A) BIN / WRAPPER — package bin declaration + Node22 shim forwarding
// =====================================================================
test("BIN: package.json declares bin.wao → a tracked bin/wao.js", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.bin?.wao, "bin/wao.js", "bin.wao must point at bin/wao.js");
  assert.ok(existsSync(BIN_WRAPPER), "bin/wao.js exists (tracked wrapper)");
});

test("BIN: wrapper forwards through wao-node.cjs and does NOT duplicate the v22 lookup", () => {
  const src = readFileSync(BIN_WRAPPER, "utf8");
  // It must route through the existing shim — the single Node-version selector.
  assert.ok(src.includes("wao-node.cjs"), "wrapper references scripts/wao-node.cjs");
  assert.ok(src.includes("cli.js"), "wrapper forwards to src/cli.js");
  // It must NOT re-implement the selector (no WAO_NODE / system v22 path logic)
  // and must not use a shell-built command.
  assert.ok(!/WAO_NODE|nodejs-v22/.test(src), "wrapper contains no duplicated v22 lookup");
  assert.ok(!/shell\s*:\s*true/.test(src), "wrapper never uses shell:true");
});

test("BIN: wrapper → shim → cli chain runs help on the SELECTED node (WAO_NODE honored)", () => {
  // Behaviorally proves the full routing chain: npm-style `node bin/wao.js <args>`
  // → scripts/wao-node.cjs → the node WAO_NODE selects → src/cli.js. Deterministic
  // on any machine: WAO_NODE points at the very node running the test.
  const r = spawnSync(process.execPath, [BIN_WRAPPER, "help"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, WAO_NODE: process.execPath },
    timeout: 30000,
  });
  assert.equal(r.status, 0, `wrapper chain exited 0 (stderr: ${r.stderr})`);
  assert.ok(r.stdout.includes("dashboard"), "help output reaches the CLI");
});

test("BIN: wrapper does NOT bypass the v22 guard (bogus WAO_NODE → shim 127)", () => {
  // If the wrapper did its own node selection instead of routing through the
  // shim, a bogus WAO_NODE would be silently ignored and help would still print.
  // The shim's guard must fire → exit 127 with the guidance message.
  const r = spawnSync(process.execPath, [BIN_WRAPPER, "help"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, WAO_NODE: join(tmpdir(), "wao-no-such-node.exe") },
    timeout: 30000,
  });
  assert.equal(r.status, 127, "shim guard exits 127");
  assert.ok(/需要 Node v22/.test(r.stderr), "shim guidance printed (guard not bypassed)");
});

// =====================================================================
// B) LAUNCHER — strict Git-root + auto-open defaults
// =====================================================================
test("LAUNCHER: defaults are strict Git-root + auto-open once (target cwd = process.cwd())", async () => {
  const lc = makeControllableLifecycle();
  const server = makeFakeServer();
  const gitCalls = [];
  const openUrls = [];
  let created = null;
  const prevEnv = process.env.WAO_TARGET_CWD;
  try {
    // The human launcher must default to process.cwd(), NOT the worker-dispatch
    // WAO_TARGET_CWD env (resolveTargetCwd's chain is for workers, not humans).
    process.env.WAO_TARGET_CWD = "/env/injected/project";
    const p = dashboardCommand([], baseConfig, launcherInjections(server, lc, {
      gitRootFn: (cwd) => { gitCalls.push(cwd); return "/canonical/ws"; },
      openUrlFn: async (url) => { openUrls.push(url); },
      createServerFn: (cfg) => { created = cfg; return server; },
      log: () => {},
    }));
    await flush();
    assert.deepEqual(gitCalls, [process.cwd()],
      "strict Git-root resolved from process.cwd() by default (WAO_TARGET_CWD ignored)");
    assert.equal(created.workspaceRoot, "/canonical/ws", "canonical root threaded to the server");
    assert.equal(openUrls.length, 1, "auto-open defaults ON, exactly once");
    assert.match(openUrls[0], /^http:\/\/127\.0\.0\.1:7654\/#token=[0-9a-f]{64}$/,
      "opened URL is the generated fragment-token URL");
    assert.ok(!openUrls[0].includes("?"), "no query string — token only in fragment");
    lc.resolve();
    await p;
  } finally {
    if (prevEnv === undefined) delete process.env.WAO_TARGET_CWD;
    else process.env.WAO_TARGET_CWD = prevEnv;
  }
});

test("LAUNCHER: nested Git directory resolves the canonical root (real git)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-root-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    const nested = join(dir, "sub", "deep");
    mkdirSync(nested, { recursive: true });
    const root = resolveCanonicalGitRoot(nested);
    assert.equal(root, canonicalizeWorkspacePath(dir),
      "canonical root of a nested dir is the worktree top-level");
  } finally {
    rmrfRetry(dir);
  }
});

test("LAUNCHER: non-Git cwd without --cwd rejects BEFORE listen and BEFORE open", async () => {
  const lc = makeControllableLifecycle();
  let createCalls = 0;
  let openCalls = 0;
  await assert.rejects(
    dashboardCommand([], baseConfig, launcherInjections(makeFakeServer(), lc, {
      gitRootFn: () => { throw new Error("not a git repo"); },
      createServerFn: () => { createCalls += 1; return makeFakeServer(); },
      openUrlFn: async () => { openCalls += 1; },
    })),
    /Git|--cwd/i,
  );
  assert.equal(createCalls, 0, "server factory never invoked → no listen");
  assert.equal(openCalls, 0, "browser opener never invoked");
});

test("LAUNCHER: explicit --cwd with spaces works (real git, full chain)", async () => {
  const base = mkdtempSync(join(tmpdir(), "wao-dash-spc-"));
  const dir = join(base, "wao dash space", "project");
  try {
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    const lc = makeControllableLifecycle();
    const server = makeFakeServer();
    const openUrls = [];
    let created = null;
    const p = dashboardCommand(["--cwd", dir], baseConfig, launcherInjections(server, lc, {
      // Real strict resolver against the real git repo (spaces in the path).
      gitRootFn: (cwd) => resolveCanonicalGitRoot(cwd),
      openUrlFn: async (url) => { openUrls.push(url); },
      createServerFn: (cfg) => { created = cfg; return server; },
      log: () => {},
    }));
    await flush();
    assert.equal(created.workspaceRoot, canonicalizeWorkspacePath(dir),
      "--cwd with spaces resolves through git to the canonical root");
    assert.equal(openUrls.length, 1, "URL opened once");
    assert.match(openUrls[0], /^http:\/\/127\.0\.0\.1:7654\/#token=[0-9a-f]{64}$/);
    lc.resolve();
    await p;
  } finally {
    rmrfRetry(base);
  }
});

test("LAUNCHER: --no-open makes ZERO browser-open attempts", async () => {
  const lc = makeControllableLifecycle();
  const server = makeFakeServer();
  let openCalls = 0;
  const p = dashboardCommand(["--no-open"], baseConfig, launcherInjections(server, lc, {
    openUrlFn: async () => { openCalls += 1; },
  }));
  await flush();
  assert.equal(server.listenCalled, true, "server still starts with --no-open");
  assert.equal(openCalls, 0, "--no-open → zero open attempts");
  lc.resolve();
  await p;
  assert.equal(openCalls, 0, "still zero after lifecycle completes");
});

test("LAUNCHER: browser opener failure logs a warning, lifecycle stays active, close only on completion", async () => {
  const lc = makeControllableLifecycle();
  const server = makeFakeServer();
  const logs = [];
  const p = dashboardCommand([], baseConfig, launcherInjections(server, lc, {
    openUrlFn: async () => { throw new Error("rundll32 launch failed"); },
    log: (s) => logs.push(s),
  }));
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  // Advisory: warning printed, server keeps running, URL already printed.
  assert.equal(settled, false, "dashboard stays alive after opener failure");
  assert.equal(server.listenCalled, true);
  assert.equal(server.closeCalled, false, "server NOT closed by an opener failure");
  assert.ok(logs.some((l) => /无法自动打开浏览器/.test(l)),
    "concise warning logged on opener failure");
  assert.ok(logs.some((l) => /^http:\/\/127\.0\.0\.1:7654\/#token=/.test(l)),
    "URL line still printed (manual open possible)");
  // The server closes ONLY on lifecycle completion.
  lc.resolve();
  await p;
  assert.equal(settled, true);
  assert.equal(server.closeCalled, true, "server closed only after lifecycle completion");
});

// =====================================================================
// C) LEGACY — `runs dashboard --web` unchanged (no auto-open, fail-soft)
// =====================================================================
test("LEGACY: runs dashboard --web does NOT auto-open and retains the non-Git fallback", async () => {
  const lc = makeControllableLifecycle();
  const server = makeFakeServer();
  const logs = [];
  let created = null;
  const p = runsDashboardCommand(["--web"], baseConfig, {
    createServerFn: (cfg) => { created = cfg; return server; },
    proveWorkspaceFn: () => { throw new Error("not a git repo"); },
    readRegistryFn: async () => ({ agents: [] }),
    lifecycle: lc,
    log: (s) => logs.push(s),
  });
  await flush();
  assert.equal(server.listenCalled, true, "legacy still starts (fail-soft, no Git needed)");
  assert.ok(typeof created.workspaceRoot === "string" && created.workspaceRoot.length > 0,
    "fail-soft fallback root is non-empty (dashboard starts without Git)");
  assert.equal(logs.length, 2, "exactly two lines — no auto-open, no browser noise");
  assert.ok(!logs.join("\n").includes("打开"), "no browser-open wording in legacy output");
  lc.resolve();
  await p;
});

test("LEGACY: runDashboardWeb without the new hooks behaves byte-identically (2 log lines)", async () => {
  const lc = makeControllableLifecycle();
  const logs = [];
  const server = makeFakeServer();
  const p = runDashboardWeb({ web: true, port: "7654" }, baseConfig, {
    createServerFn: () => server,
    proveWorkspaceFn: (cwd) => ({ root: cwd }),
    readRegistryFn: async () => ({ agents: [] }),
    lifecycle: lc,
    log: (s) => logs.push(s),
  });
  await flush();
  assert.equal(logs.length, 2, "URL + Ctrl-C only");
  lc.resolve();
  await p;
});

// =====================================================================
// D) HELP — the primary command is documented
// =====================================================================
test("HELP: `wao dashboard` is listed with its launcher flags", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "src", "cli.js"), "help"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dashboard \[--cwd DIR\] \[--port N\] \[--run-dir DIR\] \[--no-open\]/,
    "help documents the primary `wao dashboard` command and its flags");
});

// =====================================================================
// E) PRODUCTION CODE CONTRACT — no shell-built browser command
// =====================================================================
test("SECURITY: launcher source uses structured argv only (no shell, no shell-built browser command)", () => {
  const src = readFileSync(join(ROOT, "src", "commands", "dashboard.js"), "utf8");
  // Code-level checks (patterns that can only appear in real invocations, not prose).
  assert.ok(!/shell\s*:\s*true/.test(src), "never shell:true");
  assert.ok(!/["'(`]cmd\.exe/.test(src), "cmd.exe is never invoked as a program");
  assert.ok(!/["']\/c["']/.test(src), "cmd /c builtin is never used");
  assert.ok(!/start\s+["']?http/i.test(src), "no shell `start <url>` builtin command");
  // The opener must pass the URL as an argv element to a real executable.
  assert.ok(/rundll32/.test(src), "Windows default handler via rundll32 (executable, no shell)");
  assert.ok(/execFile\(/.test(src), "uses execFile (structured argv)");
});
