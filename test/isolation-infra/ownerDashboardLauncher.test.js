// test/ownerDashboardLauncher.test.js
//
// `wao dashboard` 启动器与 `wao` 全局 bin（第 145b 批改定）。
//
//   A) BIN/WRAPPER — package.json 的 bin 声明、经 wao-node.cjs 的 v22 选择链、
//      假 WAO_NODE 仍被 127 守卫拦下。
//   D) HELP — 常驻实例四条命令行都在帮助页上（含 --state-root 的内部旗标注记）。
//   E) PRODUCTION CODE CONTRACT — 打开器只用结构化 argv（无 shell、无 cmd.exe）。
//   F) OPENER — 打开器的注入缝：spawn 事件即回、unref、预先失败拒绝、
//      永不退出的浏览器进程拖不住启动器。
//
// 启动/复用/停机的行为面（URL 形态、stdout 纪律、build 提示、restart 中止）在
// ownerDashboardCli.test.js；真实 WMI 端到端在 ownerDashboardE2e.test.js。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { dashboardCommand, openInWindowsDefaultBrowser } from "../../src/commands/dashboard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const BIN_WRAPPER = join(ROOT, "bin", "wao.js");

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
  assert.ok(src.includes("wao-node.cjs"), "wrapper references scripts/wao-node.cjs");
  assert.ok(src.includes("cli.js"), "wrapper forwards to src/cli.js");
  assert.ok(!/WAO_NODE|nodejs-v22/.test(src), "wrapper contains no duplicated v22 lookup");
  assert.ok(!/shell\s*:\s*true/.test(src), "wrapper never uses shell:true");
});

test("BIN: wrapper → shim → cli chain runs help on the SELECTED node (WAO_NODE honored)", () => {
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
// D) HELP — the persistent-instance command family is documented
// =====================================================================
test("HELP: the dashboard family is listed with its launcher and ops subcommands", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "src", "cli.js"), "help"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dashboard \[--cwd DIR\] \[--port N\] \[--run-dir DIR\] \[--no-open\]/,
    "the primary launcher line");
  for (const sub of ["dashboard status", "dashboard stop", "dashboard restart"]) {
    assert.ok(r.stdout.includes(sub), `${sub} is documented`);
  }
  // 145a 的退役旗标不再出现；文本看板行原样。
  assert.doesNotMatch(r.stdout, /runs dashboard --web/, "the retired `runs dashboard --web` line is gone");
  assert.match(r.stdout, /runs dashboard \[--watch N\]/, "the text dashboard line itself is unchanged");
});

// =====================================================================
// E) PRODUCTION CODE CONTRACT — spawn, structured argv, no shell
// =====================================================================
test("SECURITY: launcher source uses structured argv only (spawn opener, detached+unref, no shell)", () => {
  const src = readFileSync(join(ROOT, "src", "commands", "dashboard.js"), "utf8");
  assert.ok(!/shell\s*:\s*true/.test(src), "never shell:true");
  assert.ok(!/["'(`]cmd\.exe/.test(src), "cmd.exe is never invoked as a program");
  assert.ok(!/["']\/c["']/.test(src), "cmd /c builtin is never used");
  assert.ok(!/start\s+["']?http/i.test(src), "no shell `start <url>` builtin command");
  assert.ok(/rundll32/.test(src), "Windows default handler via rundll32 (executable, no shell)");
  assert.ok(/\bspawn\b/.test(src), "uses spawn (structured argv)");
  assert.ok(!/execFile\(/.test(src), "no execFile-based opener (that would resolve only on child exit)");
  assert.ok(/unref\(\)/.test(src), "opener unref()es the child after spawn");
  assert.ok(/detached\s*:\s*true/.test(src), "child detached from the launcher process");
  assert.ok(/windowsHide\s*:\s*true/.test(src), "child console hidden");
});

// =====================================================================
// F) OPENER — injected spawn seam: resolve on spawn, unref, reject pre-spawn
// =====================================================================
function assertOpenerSeamPresent() {
  const src = readFileSync(join(ROOT, "src", "commands", "dashboard.js"), "utf8");
  assert.ok(/spawnFn/.test(src), "opener spawn seam injected (RED pre-fix: seam absent)");
}

test("OPENER: a child that emits spawn but never exits → opener resolves and unref()es it", async () => {
  assertOpenerSeamPresent();
  const url = `http://127.0.0.1:7654/v2/#code=${"ab".repeat(32)}`;
  let spawnCb = null;
  let unrefCalled = false;
  let got = null;
  const fakeChild = {
    once(ev, cb) { if (ev === "spawn") spawnCb = cb; return this; },
    unref() { unrefCalled = true; },
  };
  const opened = openInWindowsDefaultBrowser(url, {
    spawnFn: (cmd, args, opts) => { got = { cmd, args, opts }; return fakeChild; },
  });
  assert.ok(spawnCb, "spawn listener registered");
  spawnCb();
  await Promise.race([
    opened,
    new Promise((_, reject) => setTimeout(() => reject(new Error("opener did not resolve on spawn")), 3000)),
  ]);
  assert.equal(unrefCalled, true, "unref() called after spawn → child cannot hold the launcher open");
  assert.equal(got.cmd, "rundll32", "real executable, structured argv, no shell");
  assert.deepEqual(got.args, ["url.dll,FileProtocolHandler", url], "URL travels as ONE argv element");
  assert.equal(got.opts.shell, undefined, "no shell");
  assert.equal(got.opts.detached, true, "detached: handler runs outside the launcher process group");
  assert.deepEqual(got.opts.stdio, "ignore", "stdio ignored: no pipes to read");
  assert.equal(got.opts.windowsHide, true, "hidden: no console flash");
});

test("OPENER: a pre-spawn error rejects (so the advisory print path runs)", async () => {
  assertOpenerSeamPresent();
  const fakeChild = {
    once(ev, cb) {
      if (ev === "error") setImmediate(() => cb(new Error("ENOENT: rundll32 missing")));
      return this;
    },
    unref() { throw new Error("must not unref a child that failed to spawn"); },
  };
  await assert.rejects(
    openInWindowsDefaultBrowser(`http://127.0.0.1:7654/v2/#code=${"ab".repeat(32)}`, { spawnFn: () => fakeChild }),
    /ENOENT/,
    "pre-spawn error rejects so the launcher prints the URL",
  );
});

test("OPENER: a spawnFn that throws synchronously also rejects", async () => {
  assertOpenerSeamPresent();
  await assert.rejects(
    openInWindowsDefaultBrowser(`http://127.0.0.1:7654/v2/#code=${"ab".repeat(32)}`, {
      spawnFn: () => { throw new Error("invalid argv"); },
    }),
    /invalid argv/,
  );
});

test("LAUNCHER: the command completes though the fake browser child never exits", async (t) => {
  assertOpenerSeamPresent();
  // 145b：启动器不再有前台生命周期——复用注入的 controlIo 直接走“复用”分支，
  // 打开器只被 await 一次（spawn 事件即回），命令随即收口。
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { resolve } = await import("node:path");
  const { normalizeRunDir } = await import("../../src/application/dashboardPaths.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-life-"));
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const instance = {
    protocol: 1, runDir: normalizeRunDir(resolve(dir)), pid: 42, processCreatedAt: 1, port: 8123,
    nonce: "ab".repeat(16), generation: "a".repeat(16),
    build: { readable: true, srcTree: "f".repeat(40), dirty: false },
  };
  const fakeChild = {
    once(ev, cb) { if (ev === "spawn") setImmediate(() => cb()); return this; },
    unref() {},
  };
  const out = await dashboardCommand(["--run-dir", dir], { runDir: dir }, {
    controlIo: {
      now: () => 1_000_000, sleep: async () => {}, ensureStateDir: async () => ({ ok: true }), verifyStateDir: async () => ({ ok: true }),
      readInstanceEx: async () => ({ status: "present", raw: instance, record: instance }), publishInstance: async () => {},
      readCandidate: async () => null, readResult: async () => null, removeResult: async () => {},
      createLock: async () => ({ ok: false, lock: null }), readLock: async () => null,
      takeOverStale: async () => false, writeStopRequest: async () => {},
      probeIdentity: async () => "same",
      listenerPids: async (port) => (port === 8123 ? [42] : []),
      health: async (port) => (port === 8123 ? { ok: true, nonce: instance.nonce } : { ok: false }),
      spawnServe: async () => ({ ok: true, pid: 1 }),
      issueCode: async () => ({ code: "0f".repeat(32) }),
      buildSnapshot: async () => instance.build,
    },
    spawnFn: () => fakeChild,
    log: () => {},
  });
  assert.equal(out.outcome, "reused");
});
