// test/ownerDashboardInstallRoot.test.js
//
// M12-8F correction — trusted installation-root config resolution (TDD).
//
// RED root cause this locks down: the global `wao` bin opens the dashboard, but
// src/cli.js loadConfig() resolved config/default.json from process.cwd(), and
// runDashboardWeb then resolved config.runDir + config.registry from
// process.cwd(). So `wao dashboard --cwd <target>` launched from a non-repo Home
// silently backed the dashboard with <Home>/runs + <Home>/config instead of the
// linked WAO checkout's real shared run/registry state.
//
// Fix contract proven here (deterministic; never binds a socket, never opens a
// browser, never mutates global npm/env state):
//
//   R) RESOLVER (pure) — readInstallRoot / computeInstallRoot / resolveConfigPath /
//      rebaseConfigPaths: the single named normalizer for WAO-owned shared state.
//   D) DASHBOARD (in-process) — a rebased config makes runDashboardWeb read
//      runDir + registry from the install root; --cwd stays the observed Git
//      workspace; explicit --run-dir is NOT rebased.
//   G) GLOBAL-BIN-LIKE (spawn from a non-repo Home) — WAO_INSTALL_ROOT makes the
//      CLI read the install-root runDir; the legacy npm-script path (no env) keeps
//      cwd resolution; explicit --run-dir is honored even with the root set.
//   S) SECURITY — bin/wao.js passes the trusted root as a child-only env value
//      (no shell, no argv interpolation), derived from import.meta.url; no
//      permanent environment or config mutation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  INSTALL_ROOT_ENV,
  computeInstallRoot,
  readInstallRoot,
  resolveConfigPath,
  rebaseConfigPaths,
} from "../../src/installRoot.js";
import { dashboardCommand, resolveCanonicalGitRoot } from "../../src/commands/dashboard.js";
import { canonicalizeWorkspacePath } from "../../src/application/workspaceBinding.js";
import { rmrfRetry } from "../_rmrfHelper.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const CLI_PATH = join(ROOT, "src", "cli.js");
const BIN_PATH = join(ROOT, "bin", "wao.js");

// A one-line valid run transcript (terminal state_change) so `runs list` lists it.
const MARKER_RUN = (runId) =>
  JSON.stringify({
    type: "run.state_change",
    from: "running",
    to: "completed",
    runId,
    ts: "2026-01-01T00:00:00.000Z",
    seq: 1,
  }) + "\n";

// Flush microtask + macrotask queues so an async fn can park at an injected await.
const flush = () => new Promise((r) => setImmediate(r));

function makeFakeServer(port = 7654) {
  const self = {
    token: "ab".repeat(32),
    listenCalled: false,
    closeCalled: false,
    listen: async () => { self.listenCalled = true; return { port, host: "127.0.0.1", family: "IPv4" }; },
    close: async () => { self.closeCalled = true; },
  };
  return self;
}

function makeControllableLifecycle() {
  let resolveWait;
  const done = new Promise((r) => { resolveWait = r; });
  return { wait: () => done, resolve: () => resolveWait(), cancel() {} };
}

// Build a real throwaway Git repo (the observed target workspace) and return its path.
function makeGitRepo(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

// =====================================================================
// R) RESOLVER — pure unit tests of the single named normalizer
// =====================================================================
test("RESOLVER: INSTALL_ROOT_ENV is the documented child-only env name", () => {
  assert.equal(INSTALL_ROOT_ENV, "WAO_INSTALL_ROOT");
});

test("RESOLVER: readInstallRoot returns null when absent, the value when absolute, null when relative/empty", () => {
  assert.equal(readInstallRoot({}), null, "absent → null");
  assert.equal(readInstallRoot({ WAO_INSTALL_ROOT: "" }), null, "empty → null");
  assert.equal(readInstallRoot({ WAO_INSTALL_ROOT: "relative/path" }), null, "relative → null (fail closed)");
  assert.equal(readInstallRoot({ WAO_INSTALL_ROOT: 42 }), null, "non-string → null");
  const abs = process.platform === "win32" ? "D:\\wao\\root" : "/wao/root";
  assert.equal(readInstallRoot({ WAO_INSTALL_ROOT: abs }), abs, "absolute → trusted as-is");
});

test("RESOLVER: computeInstallRoot derives one level up from a bin file URL", () => {
  const install = mkdtempSync(join(tmpdir(), "wao-comp-"));
  try {
    const binUrl = pathToFileURL(join(install, "bin", "wao.js")).href;
    assert.equal(computeInstallRoot(binUrl), resolve(install),
      "bin/wao.js → one level up is the install root");
  } finally {
    rmrfRetry(install);
  }
});

test("RESOLVER: resolveConfigPath anchors relative paths at the root, falls back to cwd, never rebases absolute", () => {
  const root = process.platform === "win32" ? "D:\\wao" : "/wao";
  assert.equal(resolveConfigPath("config/default.json", root), resolve(join(root, "config/default.json")),
    "relative + root → under root");
  assert.equal(resolveConfigPath("config/default.json", null), resolve("config/default.json"),
    "relative + no root → caller cwd (legacy, byte-for-byte)");
  const abs = process.platform === "win32" ? "E:\\elsewhere\\default.json" : "/elsewhere/default.json";
  assert.equal(resolveConfigPath(abs, root), resolve(abs),
    "absolute → never rebased (resolved as-is)");
});

test("RESOLVER: rebaseConfigPaths rebases WAO-owned runDir+registry, leaves absolute/per-project keys, does NOT mutate input, no-op without root", () => {
  const root = process.platform === "win32" ? "D:\\wao" : "/wao";
  const input = {
    runDir: "runs",
    registry: "config/agents.json",
    stateDir: ".wao", // per-project workspace state — must NOT be rebased
    pollInterval: 5000,
    portRange: [30000, 31000],
  };
  const same = rebaseConfigPaths(input, null);
  assert.equal(same, input, "no root → exact same object reference (legacy preserved)");

  const out = rebaseConfigPaths(input, root);
  assert.notEqual(out, input, "root present → new object (no mutation)");
  assert.equal(input.runDir, "runs", "input.runDir unchanged (no mutation)");
  assert.equal(input.registry, "config/agents.json", "input.registry unchanged (no mutation)");
  assert.equal(out.runDir, resolve(join(root, "runs")), "runDir rebased under root");
  assert.equal(out.registry, resolve(join(root, "config/agents.json")), "registry rebased under root");
  assert.equal(out.stateDir, ".wao", "per-project stateDir NOT rebased");
  assert.equal(out.pollInterval, 5000, "scalar keys untouched");
  assert.deepEqual(out.portRange, [30000, 31000], "array keys untouched");

  // Absolute paths pass through unchanged even with a root present.
  const absIn = { runDir: resolve("/abs/runs"), registry: "config/agents.json" };
  const absOut = rebaseConfigPaths(absIn, root);
  assert.equal(absOut.runDir, resolve("/abs/runs"), "absolute runDir never rebased");
  assert.equal(absOut.registry, resolve(join(root, "config/agents.json")), "relative registry still rebased");
});

// =====================================================================
// D) DASHBOARD (in-process) — rebased config → install-root runDir/registry;
//    --cwd stays the workspace; --run-dir NOT rebased.
// =====================================================================
test("DASHBOARD: rebased config → server runDir + registry from install root; workspace stays the --cwd Git project", async () => {
  const install = mkdtempSync(join(tmpdir(), "wao-dash-install-"));
  const target = makeGitRepo("wao-dash-target-");
  try {
    // Simulate exactly what loadConfig produces under the global bin: rebase a
    // base config (relative runDir/registry) against the trusted install root.
    const config = rebaseConfigPaths(
      { runDir: "runs", registry: "config/agents.json" },
      install,
    );
    const lc = makeControllableLifecycle();
    const server = makeFakeServer();
    let created = null;
    let regPath = null;
    const p = dashboardCommand(["--cwd", target], config, {
      gitRootFn: (cwd) => resolveCanonicalGitRoot(cwd),
      openUrlFn: async () => {},
      createServerFn: (cfg) => { created = cfg; return server; },
      readRegistryFn: async (rp) => { regPath = rp; return { agents: [] }; },
      lifecycle: lc,
      log: () => {},
    });
    await flush();
    assert.equal(created.runDir, join(install, "runs"),
      "runDir resolved from the install root, not the caller cwd");
    assert.equal(regPath, join(install, "config", "agents.json"),
      "registry read from the install root, not the caller cwd");
    assert.equal(created.workspaceRoot, canonicalizeWorkspacePath(target),
      "workspaceRoot is the --cwd Git project, NOT the install root");
    lc.resolve();
    await p;
  } finally {
    rmrfRetry(install);
    rmrfRetry(target);
  }
});

test("DASHBOARD: explicit --run-dir is NOT rebased (stays relative to the caller cwd)", async () => {
  const install = mkdtempSync(join(tmpdir(), "wao-dash-rd-install-"));
  const target = makeGitRepo("wao-dash-rd-target-");
  try {
    const config = rebaseConfigPaths(
      { runDir: "runs", registry: "config/agents.json" },
      install,
    );
    const lc = makeControllableLifecycle();
    const server = makeFakeServer();
    let created = null;
    const p = dashboardCommand(["--cwd", target, "--run-dir", "explicit/relative/runs"], config, {
      gitRootFn: (cwd) => resolveCanonicalGitRoot(cwd),
      openUrlFn: async () => {},
      createServerFn: (cfg) => { created = cfg; return server; },
      readRegistryFn: async () => ({ agents: [] }),
      lifecycle: lc,
      log: () => {},
    });
    await flush();
    assert.equal(created.runDir, resolve("explicit/relative/runs"),
      "explicit --run-dir resolved against caller cwd (NOT rebased under install root)");
    assert.ok(!created.runDir.startsWith(install),
      "explicit --run-dir never lands under the install root");
    lc.resolve();
    await p;
  } finally {
    rmrfRetry(install);
    rmrfRetry(target);
  }
});

// =====================================================================
// G) GLOBAL-BIN-LIKE — spawn `node src/cli.js` (what the bin spawns) from a
//    non-repo Home; WAO_INSTALL_ROOT redirects shared-state resolution.
// =====================================================================
function envWithoutInstallRoot() {
  const env = { ...process.env, WAO_SKIP_VERSION_GUARD: "1" };
  delete env.WAO_INSTALL_ROOT;
  return env;
}

function runCliFromCwd(cwd, args, env) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
    env,
    timeout: 30000,
  });
}

test("GLOBAL-BIN-LIKE: WAO_INSTALL_ROOT makes `runs list` read the install-root runDir (config/default.json from install root)", () => {
  const home = mkdtempSync(join(tmpdir(), "wao-home-A-"));
  const install = mkdtempSync(join(tmpdir(), "wao-install-A-"));
  try {
    // Install root owns a DISTINCTIVE runDir via config/default.json + a marker run.
    mkdirSync(join(install, "config"), { recursive: true });
    writeFileSync(join(install, "config", "default.json"), JSON.stringify({ runDir: "from-install" }));
    mkdirSync(join(install, "from-install"), { recursive: true });
    writeFileSync(join(install, "from-install", "run_INSTALL.jsonl"), MARKER_RUN("run_INSTALL"));
    // Home also has a runs dir with a DIFFERENT marker — must NOT be read.
    mkdirSync(join(home, "runs"), { recursive: true });
    writeFileSync(join(home, "runs", "run_HOME.jsonl"), MARKER_RUN("run_HOME"));

    const r = runCliFromCwd(home, ["runs", "list"], {
      ...envWithoutInstallRoot(),
      [INSTALL_ROOT_ENV]: install,
    });
    assert.equal(r.status, 0, `cli exited 0 (stderr: ${r.stderr})`);
    assert.ok(r.stdout.includes("run_INSTALL"), "install-root run is visible");
    assert.ok(!r.stdout.includes("run_HOME"), "Home run is NOT read (resolution anchored at install root)");
  } finally {
    rmrfRetry(home);
    rmrfRetry(install);
  }
});

test("LEGACY: without WAO_INSTALL_ROOT the npm-script path keeps cwd resolution (Home run visible, install run not)", () => {
  const home = mkdtempSync(join(tmpdir(), "wao-home-B-"));
  const install = mkdtempSync(join(tmpdir(), "wao-install-B-"));
  try {
    mkdirSync(join(install, "config"), { recursive: true });
    writeFileSync(join(install, "config", "default.json"), JSON.stringify({ runDir: "from-install" }));
    mkdirSync(join(install, "from-install"), { recursive: true });
    writeFileSync(join(install, "from-install", "run_INSTALL.jsonl"), MARKER_RUN("run_INSTALL"));
    mkdirSync(join(home, "runs"), { recursive: true });
    writeFileSync(join(home, "runs", "run_HOME.jsonl"), MARKER_RUN("run_HOME"));

    // No WAO_INSTALL_ROOT: exactly the `npm run cli -- runs list` path.
    const r = runCliFromCwd(home, ["runs", "list"], envWithoutInstallRoot());
    assert.equal(r.status, 0, `cli exited 0 (stderr: ${r.stderr})`);
    assert.ok(r.stdout.includes("run_HOME"), "cwd/Home run is visible (legacy resolution intact)");
    assert.ok(!r.stdout.includes("run_INSTALL"), "install root is NOT consulted on the legacy path");
  } finally {
    rmrfRetry(home);
    rmrfRetry(install);
  }
});

test("GLOBAL-BIN-LIKE: explicit --run-dir override is honored even with WAO_INSTALL_ROOT set (not rebased)", () => {
  const home = mkdtempSync(join(tmpdir(), "wao-home-C-"));
  const install = mkdtempSync(join(tmpdir(), "wao-install-C-"));
  const override = mkdtempSync(join(tmpdir(), "wao-override-C-"));
  try {
    mkdirSync(join(install, "config"), { recursive: true });
    writeFileSync(join(install, "config", "default.json"), JSON.stringify({ runDir: "from-install" }));
    mkdirSync(join(install, "from-install"), { recursive: true });
    writeFileSync(join(install, "from-install", "run_INSTALL.jsonl"), MARKER_RUN("run_INSTALL"));
    // The explicit override dir holds a distinct marker.
    writeFileSync(join(override, "run_OVERRIDE.jsonl"), MARKER_RUN("run_OVERRIDE"));

    const r = runCliFromCwd(home, ["runs", "list", "--run-dir", override], {
      ...envWithoutInstallRoot(),
      [INSTALL_ROOT_ENV]: install,
    });
    assert.equal(r.status, 0, `cli exited 0 (stderr: ${r.stderr})`);
    assert.ok(r.stdout.includes("run_OVERRIDE"), "explicit --run-dir wins");
    assert.ok(!r.stdout.includes("run_INSTALL"), "install-root runDir is NOT used when --run-dir is explicit");
  } finally {
    rmrfRetry(home);
    rmrfRetry(install);
    rmrfRetry(override);
  }
});

test("GLOBAL-BIN-LIKE: install root path containing spaces resolves correctly (no shell)", () => {
  const base = mkdtempSync(join(tmpdir(), "wao-spc-base-"));
  const home = join(base, "my home dir");
  const install = join(base, "wao install root");
  try {
    mkdirSync(home, { recursive: true });
    mkdirSync(join(install, "config"), { recursive: true });
    writeFileSync(join(install, "config", "default.json"), JSON.stringify({ runDir: "from-install" }));
    mkdirSync(join(install, "from-install"), { recursive: true });
    writeFileSync(join(install, "from-install", "run_SPACED.jsonl"), MARKER_RUN("run_SPACED"));

    const r = runCliFromCwd(home, ["runs", "list"], {
      ...envWithoutInstallRoot(),
      [INSTALL_ROOT_ENV]: install,
    });
    assert.equal(r.status, 0, `cli exited 0 with spaced paths (stderr: ${r.stderr})`);
    assert.ok(r.stdout.includes("run_SPACED"), "spaced install-root path resolved (structured env, no shell)");
  } finally {
    rmrfRetry(base);
  }
});

// =====================================================================
// S) SECURITY — bin passes a child-only trusted root (no shell, no argv);
//    no permanent environment / config mutation.
// =====================================================================
test("SECURITY: bin/wao.js derives the trusted root from import.meta.url and passes it as a child-only env (no shell, no argv)", () => {
  const src = readFileSync(BIN_PATH, "utf8");
  assert.ok(src.includes("computeInstallRoot"), "bin computes the root via the shared helper");
  assert.ok(src.includes("import.meta.url"), "root derived from the bin's own location, not caller cwd");
  assert.ok(src.includes(INSTALL_ROOT_ENV), "root travels as the child-only env name");
  assert.ok(/env\s*:/.test(src), "root passed through the spawn env option (not argv)");
  assert.ok(!/shell\s*:\s*true/.test(src), "no shell");
  // The bin must OVERWRITE any caller-supplied value (trusted), so the env
  // spread places INSTALL_ROOT_ENV after ...process.env.
  assert.ok(/\.\.\.process\.env[^\]]*\[[^\]]*INSTALL_ROOT_ENV[^\]]*\]/.test(src.replace(/\s+/g, " ")),
    "INSTALL_ROOT_ENV overwrites any caller value (trusted, not injectable)");
});

test("SECURITY: cli.js loadConfig routes config/default.json + runDir/registry through the install-root resolver", () => {
  const src = readFileSync(join(ROOT, "src", "cli.js"), "utf8");
  assert.ok(src.includes("resolveConfigPath"), "loadConfig resolves config/default.json via the resolver");
  assert.ok(src.includes("rebaseConfigPaths"), "loadConfig rebases WAO-owned paths via the resolver");
  assert.ok(src.includes("readInstallRoot"), "loadConfig reads the trusted root from env");
});

test("SECURITY: no permanent mutation — resolver never touches process.env and never mutates its input", () => {
  // The resolver is pure: it must not write process.env. The spawn-based tests
  // above run the CLI in a CHILD process, so the parent (test) env is untouched;
  // assert the parent never grew the key just by importing the resolver.
  assert.equal(process.env[INSTALL_ROOT_ENV], undefined,
    "importing/using the resolver does not set the env key in the parent process");
  const before = { ...process.env };
  const cfg = { runDir: "runs", registry: "config/agents.json" };
  rebaseConfigPaths(cfg, process.platform === "win32" ? "D:\\wao" : "/wao");
  assert.deepEqual({ ...process.env }, before, "resolver leaves process.env untouched");
  assert.equal(cfg.runDir, "runs", "input config object not mutated in place");
});

// Sanity: the stub used during RED records a functional failure for rebase
// (removed/equivalent once GREEN lands — this guards against accidental revert
// to a no-op resolver).
test("GUARD: rebaseConfigPaths is not a legacy no-op (install root is honored)", () => {
  const root = process.platform === "win32" ? "D:\\wao" : "/wao";
  const out = rebaseConfigPaths({ runDir: "runs", registry: "config/agents.json" }, root);
  assert.notEqual(out.runDir, "runs", "runDir was rebased (resolver is live, not a stub)");
});
