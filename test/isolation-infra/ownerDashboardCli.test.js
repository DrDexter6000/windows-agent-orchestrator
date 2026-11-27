// test/ownerDashboardCli.test.js
//
// 第 145b 批：`wao dashboard` 命令层（常驻实例启动器与运维出口的 CLI 适配）。
//
// 经注入 controlIo（假的世界）驱动 launch/status/stop/restart 的对外行为：
//   - 启动/复用都签发启动码，URL 只进片段（#code=…，或带项目筛选的
//     #workers?project=…&code=…），绝不进查询串；
//   - --no-open 或打开失败时 URL 打印一次（只进 stdout）；
//   - build 三态的提示行；运行目录缺失的固定报错；
//   - status 如实（不含启动码与令牌）；stop 超时不强杀的文案；restart 中止。
// 无真实实例、无网络、无浏览器、无 WMI——那些在 ownerDashboardE2e.test.js。
// `runs dashboard --web` 的退役墓碑仍在此处一行。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { dashboardCommand } from "../../src/commands/dashboard.js";
import { runsDashboardCommand } from "../../src/commands/runs.js";
import { RUNS_DASHBOARD_WEB_RETIRED_MESSAGE } from "../../src/cliHelp.js";
import { normalizeRunDir } from "../../src/application/dashboardPaths.js";

/** 一个假的世界：controlIo 全可控；world.candidate 决定拉起的候选。时钟随 sleep 前进。 */
function makeIo(world) {
  let clock = 1_000_000;
  return {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    ensureStateDir: async () => ({ ok: true }),
    verifyStateDir: async () => ({ ok: true }),
    stateDirPresent: async () => true,
    readInstanceEx: async () => (world.instance == null
      ? { status: "absent" }
      : { status: "present", raw: world.instance, record: world.badShape === true ? null : world.instance }),
    publishInstance: async (dir, record) => { world.published = record; },
    readCandidate: async () => world.candidate ?? null,
    candidateBuild: null,
    readResult: async () => world.result ?? null,
    removeResult: async () => {},
    createLock: async (d, g, dl) => {
      if (world.lock === undefined || world.lock === null) { world.lock = { generation: g, deadline: dl }; return { ok: true }; }
      return { ok: false, lock: world.lock };
    },
    readLock: async () => world.lock ?? null,
    takeOverStale: async () => false,
    releaseLock: async () => true,
    sweepLeftovers: async () => 0,
    removeCandidate: async () => {},
    writeStopRequest: async (dir, generation, nonce) => { (world.stopRequests ??= []).push({ generation, nonce }); },
    probeIdentity: async () => world.identity ?? "same",
    listenerPids: async (port) => {
      const pids = [];
      if (world.candidate != null && port === world.candidate.port) pids.push(world.candidate.pid);
      if (world.instance != null && port === world.instance.port) pids.push(world.instance.pid);
      return pids;
    },
    health: async (port) => {
      if (world.candidate != null && port === world.candidate.port) return { ok: true, nonce: world.candidate.nonce };
      if (world.instance != null && port === world.instance.port) return { ok: true, nonce: world.instance.nonce };
      return { ok: false };
    },
    spawnServe: async ({ generation }) => {
      world.spawned = generation;
      world.candidate ??= { port: 9001, pid: 777, nonce: "ab".repeat(16), processCreatedAt: 1_700_000_000_000 };
      return { ok: true, pid: world.candidate.pid };
    },
    issueCode: async () => ({ code: "0f".repeat(32) }),
    buildSnapshot: async () => world.buildNow ?? { readable: true, srcTree: "f".repeat(40), dirty: false },
  };
}

const runDirOf = (dir) => normalizeRunDir(resolve(dir));

function tempRunDir() {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-cli-"));
  mkdirSync(dir, { recursive: true });
  return [dir, () => rmSync(dir, { recursive: true, force: true })];
}

const baseConfig = { runDir: "/runs", registry: "config/agents.json" };

// =====================================================================
// LAUNCH — the start-code URL, the open, the print discipline
// =====================================================================

test("LAUNCH: fresh instance — URL is /v2/#code=<64hex> (fragment only), opener called once, nothing printed", async () => {
  const [dir, done] = tempRunDir();
  try {
    const world = {};
    const opened = [];
    const logs = [];
    const out = await dashboardCommand(["--run-dir", dir], baseConfig, {
      controlIo: makeIo(world),
      openUrlFn: async (url) => { opened.push(url); },
      log: (s) => logs.push(s),
    });
    assert.equal(out.outcome, "launched");
    assert.deepEqual(opened, [`http://127.0.0.1:9001/v2/#code=${"0f".repeat(32)}`]);
    assert.ok(!opened[0].includes("?"), "no query string — the code only rides the fragment");
    assert.ok(!logs.some((l) => l.includes("#code=")), "the URL is NOT printed when the opener worked");
    assert.ok(logs.some((l) => l.includes("已启动")));
  } finally {
    done();
  }
});

test("LAUNCH: --cwd inside a known project adds the project filter to the fragment", async () => {
  const [dir, done] = tempRunDir();
  try {
    const world = {};
    const opened = [];
    await dashboardCommand(["--run-dir", dir, "--cwd", "D:/proj/shop"], baseConfig, {
      controlIo: makeIo(world),
      filterIo: {
        identifyFn: (cwd) => ({ kind: "project", key: "d:/proj/shop", displayName: "shop" }),
        bucketIndexFn: () => ({ entries: { "d:/proj/shop": "shop-api" } }),
      },
      openUrlFn: async (url) => { opened.push(url); },
      log: () => {},
    });
    assert.deepEqual(opened, [`http://127.0.0.1:9001/v2/#workers?project=shop-api&code=${"0f".repeat(32)}`]);
  } finally {
    done();
  }
});

test("LAUNCH: --cwd that maps to no known project opens the unfiltered overview", async () => {
  const [dir, done] = tempRunDir();
  try {
    const world = {};
    const opened = [];
    await dashboardCommand(["--run-dir", dir, "--cwd", "D:/elsewhere"], baseConfig, {
      controlIo: makeIo(world),
      filterIo: {
        identifyFn: () => ({ kind: "unattributed" }),
        bucketIndexFn: () => ({ entries: {} }),
      },
      openUrlFn: async (url) => { opened.push(url); },
      log: () => {},
    });
    assert.match(opened[0], /\/v2\/#code=[0-9a-f]{64}$/);
  } finally {
    done();
  }
});

test("LAUNCH: --no-open prints the URL exactly once to stdout; reuse prints the build drift lines", async () => {
  const [dir, done] = tempRunDir();
  try {
    const world = {
      instance: {
        protocol: 1, runDir: runDirOf(dir), pid: 42, processCreatedAt: 1, port: 8123,
        nonce: "ab".repeat(16), generation: "a".repeat(16),
        build: { readable: true, srcTree: "f".repeat(40), dirty: false },
      },
      buildNow: { readable: true, srcTree: "e".repeat(40), dirty: false },
    };
    const logs = [];
    const out = await dashboardCommand(["--run-dir", dir, "--no-open"], baseConfig, {
      controlIo: makeIo(world),
      log: (s) => logs.push(s),
    });
    assert.equal(out.outcome, "reused");
    const urlLines = logs.filter((l) => l.includes("#code="));
    assert.equal(urlLines.length, 1, "the URL is printed exactly once");
    assert.match(urlLines[0], /^http:\/\/127\.0\.0\.1:8123\/v2\/#code=[0-9a-f]{64}$/);
    assert.ok(logs.some((l) => l.includes("旧版本代码")));
    const world2 = { ...world, buildNow: { readable: true, srcTree: "f".repeat(40), dirty: true } };
    const logs2 = [];
    await dashboardCommand(["--run-dir", dir, "--no-open"], baseConfig, {
      controlIo: makeIo(world2),
      log: (s) => logs2.push(s),
    });
    assert.ok(logs2.some((l) => l.includes("无法确认实例版本")));
  } finally {
    done();
  }
});

test("LAUNCH: a failing opener prints the URL once (stdout) and still completes", async () => {
  const [dir, done] = tempRunDir();
  try {
    const world = {};
    const logs = [];
    const out = await dashboardCommand(["--run-dir", dir], baseConfig, {
      controlIo: makeIo(world),
      openUrlFn: async () => { throw new Error("rundll32 missing"); },
      log: (s) => logs.push(s),
    });
    assert.equal(out.outcome, "launched");
    assert.equal(logs.filter((l) => l.includes("#code=")).length, 1, "printed once");
    assert.ok(logs.some((l) => l.includes("无法自动打开浏览器")));
  } finally {
    done();
  }
});

test("LAUNCH: a missing run directory is a fixed error before anything starts", async () => {
  const missing = join(tmpdir(), "wao-dash-cli-no-such-" + Date.now());
  let spawned = 0;
  await assert.rejects(
    dashboardCommand(["--run-dir", missing], baseConfig, {
      controlIo: { ...makeIo({}), spawnServe: async () => { spawned += 1; return { ok: true, pid: 1 }; } },
      log: () => {},
    }),
    /运行目录/,
  );
  assert.equal(spawned, 0);
});

test("LAUNCH: a protocol-incompatible record refuses to issue a code (restart hint)", async () => {
  const [dir, done] = tempRunDir();
  try {
    const world = {
      instance: {
        protocol: 2, runDir: runDirOf(dir), pid: 42, processCreatedAt: 1, port: 8123,
        nonce: "ab".repeat(16), generation: "a".repeat(16),
        build: { readable: true, srcTree: "f".repeat(40), dirty: false },
      },
    };
    await assert.rejects(
      dashboardCommand(["--run-dir", dir], baseConfig, { controlIo: makeIo(world), log: () => {} }),
      /restart/,
    );
  } finally {
    done();
  }
});

// =====================================================================
// STATUS / STOP / RESTART
// =====================================================================

test("STATUS (145b-fix): prints the reuse-check verdict and names WHICH check failed; never a code or token", async () => {
  const [dir, done] = tempRunDir();
  try {
    const world = {
      instance: {
        protocol: 1, runDir: runDirOf(dir), pid: 42, processCreatedAt: 1_700_000_000_000, port: 8123,
        nonce: "ab".repeat(16), generation: "a".repeat(16),
        build: { readable: true, srcTree: "f".repeat(40), dirty: false },
      },
    };
    const logs = [];
    await dashboardCommand(["status", "--run-dir", dir], baseConfig, {
      controlIo: makeIo(world),
      log: (s) => logs.push(s),
    });
    const text = logs.join("\n");
    assert.ok(text.includes("pid 42") && text.includes("端口 8123") && text.includes("协议版本 1"));
    assert.ok(!/[0-9a-f]{64}/.test(text), "no start code or token in status output");
    const empty = [];
    await dashboardCommand(["status", "--run-dir", dir], baseConfig, {
      controlIo: makeIo({}),
      log: (s) => empty.push(s),
    });
    assert.ok(empty.some((l) => l.includes("没有正在运行的看板实例")));
  } finally {
    done();
  }
});

// ---- 活进程配形状不对的记录：不绕成死圈（修正二第 9 条） ----

const badShapeWorld = (dir) => ({
  badShape: true,
  instance: { protocol: 1, runDir: runDirOf(dir), pid: 42, processCreatedAt: 1, port: 8123, extra: true },
});
const closeItFirst = (error) => {
  assert.match(error.message, /pid 42 的看板实例无响应，请先关掉它/);
  assert.doesNotMatch(error.message, /restart/, "restart would come back to the very same error");
  return true;
};

test("LAUNCH/STOP/RESTART (145b-fix2): a LIVE pid with a malformed record is reported as 'pid N unresponsive, close it first' — never a restart hint, never a stop request", async () => {
  const [dir, done] = tempRunDir();
  try {
    for (const argv of [[], ["stop"], ["restart"]]) {
      const world = badShapeWorld(dir);
      let spawned = 0;
      const io = makeIo(world);
      io.spawnServe = async () => { spawned += 1; return { ok: true, pid: 1 }; };
      await assert.rejects(
        dashboardCommand([...argv, "--run-dir", dir, "--no-open"], baseConfig, { controlIo: io, log: () => {} }),
        closeItFirst,
        `dashboard ${argv.join(" ")}`,
      );
      assert.equal(spawned, 0, "no second instance is started");
      assert.equal(world.stopRequests, undefined, "no stop request is written");
    }
  } finally {
    done();
  }
});

test("STATUS (145b-fix2): a live pid with a malformed record says to close it first — not 'restart'", async () => {
  const [dir, done] = tempRunDir();
  try {
    const logs = [];
    await dashboardCommand(["status", "--run-dir", dir], baseConfig, { controlIo: makeIo(badShapeWorld(dir)), log: (s) => logs.push(s) });
    const text = logs.join("\n");
    assert.match(text, /pid 42/);
    assert.match(text, /请先关掉/);
    assert.doesNotMatch(text, /restart/);
  } finally {
    done();
  }
});
test("STOP: timeout reports honestly (no kill, no record deletion) with the fixed lines", async () => {
  const [dir, done] = tempRunDir();
  try {
    const world = {
      instance: {
        protocol: 1, runDir: runDirOf(dir), pid: 42, processCreatedAt: 1, port: 8123,
        nonce: "ab".repeat(16), generation: "a".repeat(16),
        build: { readable: true, srcTree: "f".repeat(40), dirty: false },
      },
    };
    const io = makeIo(world);
    io.probeIdentity = async () => "same"; // 活着不退：等满 STOP_WAIT（注入 sleep 即时返回）
    await assert.rejects(
      dashboardCommand(["stop", "--run-dir", dir], baseConfig, { controlIo: io, log: () => {} }),
      /没有按时退出/,
    );
    assert.notEqual(world.instance, null, "the record is kept");
  } finally {
    done();
  }
});

test("RESTART: aborted when stop fails — no spawn, the fixed stop-failed text", async () => {
  const [dir, done] = tempRunDir();
  try {
    const world = {
      instance: {
        protocol: 1, runDir: runDirOf(dir), pid: 42, processCreatedAt: 1, port: 8123,
        nonce: "ab".repeat(16), generation: "a".repeat(16),
        build: { readable: true, srcTree: "f".repeat(40), dirty: false },
      },
    };
    const io = makeIo(world);
    io.probeIdentity = async () => "same";
    let spawned = 0;
    io.spawnServe = async () => { spawned += 1; return { ok: true, pid: 1 }; };
    await assert.rejects(
      dashboardCommand(["restart", "--run-dir", dir], baseConfig, { controlIo: io, log: () => {} }),
      /没有按时退出|中止/,
    );
    assert.equal(spawned, 0, "restart never starts a second instance when stop failed");
  } finally {
    done();
  }
});

// =====================================================================
// RETIRED — `runs dashboard --web` keeps its tombstone
// =====================================================================

test("RETIRED: runs dashboard --web throws the fixed text and starts nothing", async () => {
  await assert.rejects(
    () => runsDashboardCommand(["--web"], baseConfig),
    (error) => error.message === RUNS_DASHBOARD_WEB_RETIRED_MESSAGE,
  );
});
