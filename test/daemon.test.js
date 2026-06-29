// test/daemon.test.js
//
// P3-T1（M7）：持久 daemon + 命名管道 IPC 的红绿测试。
// 见 docs/m7-phases.md P3、ADR 0012（IPC = 命名管道）。
//
// 纪律：新模块严格红绿。每个 increment 先写测试（红）→ 确认红是"符号未定义"→ 实现（绿）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawnSync as _ss } from "node:child_process";
import { findState } from "../src/transcript.js";

import {
  readHandshake,
  isDaemonAlive,
  scanResumableRuns,
  connectDaemon,
  startDaemon,
  isRunOwned,
  ownerFilePath,
  HANDSHAKE_FILE,
} from "../src/daemon.js";
// D-F2：scanAllRuns 是统一视图的纯函数（标 owner: daemon/external/orphan）。
// 注：导入可能在符号未定义时失败——这正是红绿第一步期望的"符号未定义"红。
import { scanAllRuns } from "../src/daemon.js";

// ---------- helpers ----------

function makeRunDir() {
  const dir = mkdtempSync(join(tmpdir(), "wao-daemon-"));
  return dir;
}

/** 写一个 transcript 文件，给定的 state_change.to 决定 findState 的结果。 */
function writeTranscript(runDir, runId, stateChangeTo, agentId = "test_agent") {
  const lines = [
    { ts: "2026-06-25T00:00:00.000Z", seq: 1, runId, agentId, type: "run.created" },
    { ts: "2026-06-25T00:00:01.000Z", seq: 2, runId, agentId, type: "session.created", backendSessionId: "s_x", backend: "opencode-serve" },
    { ts: "2026-06-25T00:00:02.000Z", seq: 3, runId, agentId, type: "run.started", cwd: runDir, backend: "opencode-serve" },
  ];
  if (stateChangeTo) {
    lines.push({ ts: "2026-06-25T00:00:03.000Z", seq: 4, runId, agentId, type: "run.state_change", from: "submitted", to: stateChangeTo });
  }
  writeFileSync(
    join(runDir, `${runId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf8",
  );
}

// ============================================================
// Increment 1 — 纯函数（无 IO 依赖的逻辑，最先做，最稳）
// ============================================================

test("readHandshake: 读出 runDir/daemon.json 内容", () => {
  const runDir = makeRunDir();
  try {
    const hs = { pid: 12345, pipe: "\\\\.\\pipe\\wao-daemon", startedAt: 1000, heartbeatAt: 2000 };
    writeFileSync(join(runDir, HANDSHAKE_FILE), JSON.stringify(hs), "utf8");
    const got = readHandshake(runDir);
    assert.deepEqual(got, hs);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("readHandshake: 文件不存在返回 null", () => {
  const runDir = makeRunDir();
  try {
    assert.equal(readHandshake(runDir), null);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("isDaemonAlive: heartbeatAt 在阈值内 = 活", () => {
  const now = 10000;
  const hs = { heartbeatAt: 9500 }; // 500ms 前
  assert.equal(isDaemonAlive(hs, now, 2000), true);
});

test("isDaemonAlive: heartbeatAt 超过阈值 = 死", () => {
  const now = 10000;
  const hs = { heartbeatAt: 7000 }; // 3000ms 前，阈值 2000
  assert.equal(isDaemonAlive(hs, now, 2000), false);
});

test("isDaemonAlive: null handshake = 死", () => {
  assert.equal(isDaemonAlive(null, 10000, 2000), false);
});

test("scanResumableRuns: 只返回非终态 run 的 runId", () => {
  const runDir = makeRunDir();
  try {
    writeTranscript(runDir, "run_running", "running");
    writeTranscript(runDir, "run_pending", "pending");
    writeTranscript(runDir, "run_completed", "completed");
    writeTranscript(runDir, "run_aborted", "aborted");
    const resumable = scanResumableRuns(runDir);
    assert.ok(resumable.includes("run_running"), "running 应可 resume");
    assert.ok(resumable.includes("run_pending"), "pending 应可 resume");
    assert.ok(!resumable.includes("run_completed"), "completed 不可 resume");
    assert.ok(!resumable.includes("run_aborted"), "aborted 不可 resume");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("scanResumableRuns: 空 runDir 返回空数组", () => {
  const runDir = makeRunDir();
  try {
    assert.deepEqual(scanResumableRuns(runDir), []);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ============================================================
// D-F3 修复：ownership 心跳判活（弃用 staleness 启发式）
// ============================================================
// RunMaestro 教训：纯事件时间判活对长任务（全量 CI 40min 沉默）误判。
// 正解：owner 进程心跳——P2 runner 写 .owner-<runId> {pid, heartbeatAt}，
// daemon resume 前查 owner 活则 skip（哪怕 run 沉默，owner 在更新心跳就不劫持）。

test("isRunOwned: owner 文件新鲜（心跳在阈值内）= true", () => {
  const runDir = makeRunDir();
  try {
    writeFileSync(ownerFilePath(runDir, "run_x"), JSON.stringify({ pid: 999, heartbeatAt: 9500 }), "utf8");
    assert.equal(isRunOwned(runDir, "run_x", 10000, 2000), true, "心跳 500ms 前 = owner 活");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("isRunOwned: owner 心跳过期 = false（owner 死了）", () => {
  const runDir = makeRunDir();
  try {
    writeFileSync(ownerFilePath(runDir, "run_x"), JSON.stringify({ pid: 999, heartbeatAt: 7000 }), "utf8");
    assert.equal(isRunOwned(runDir, "run_x", 10000, 2000), false, "心跳 3000ms 前（超阈值 2000）= owner 死");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("isRunOwned: 无 owner 文件 = false（无 owner 或已清理）", () => {
  const runDir = makeRunDir();
  try {
    assert.equal(isRunOwned(runDir, "run_x", 10000, 2000), false, "无 owner 文件 = 可 resume");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("isRunOwned: 坏 JSON owner 文件 = false（容错）", () => {
  const runDir = makeRunDir();
  try {
    writeFileSync(ownerFilePath(runDir, "run_x"), "{not json", "utf8");
    assert.equal(isRunOwned(runDir, "run_x", 10000, 2000), false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("scanResumableRuns: 有活 owner 的 run 不返回（D-F3 防劫持）", () => {
  const runDir = makeRunDir();
  const now = Date.now();
  try {
    writeTranscript(runDir, "run_owned_live", "running");
    writeTranscript(runDir, "run_orphan", "running");
    // run_owned_live 有活 owner（心跳新鲜）
    writeFileSync(ownerFilePath(runDir, "run_owned_live"), JSON.stringify({ pid: 999, heartbeatAt: now }), "utf8");
    // run_orphan 无 owner 文件（owner 死了/清理了）
    const resumable = scanResumableRuns(runDir, now, 10000);
    assert.ok(!resumable.includes("run_owned_live"), "有活 owner 的 run 不应被 resume（防劫持）");
    assert.ok(resumable.includes("run_orphan"), "无 owner 的孤儿 run 应可 resume");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("D-F3 dogfood 竞态复现：活 owner 的 run 不被劫持，owner 死则可 resume", () => {
  // 模拟 P2 --background + 立即 daemon --resume-on-start 的竞态：
  // run 卡 running，owner 文件新鲜（P2 runner 还活着）→ scanResumableRuns 不返回它（不劫持）。
  // owner 死（删 owner 文件，模拟 runner 崩溃清理）→ scanResumableRuns 返回它（resume）。
  const runDir = makeRunDir();
  try {
    writeTranscript(runDir, "run_race", "running");
    const ownerPath = ownerFilePath(runDir, "run_race");
    const now = Date.now();

    // 阶段1：owner 活着（心跳新鲜）→ 不应被 resume（防双所有者）
    writeFileSync(ownerPath, JSON.stringify({ pid: 12345, heartbeatAt: now }), "utf8");
    let resumable = scanResumableRuns(runDir, now, 10000);
    assert.ok(!resumable.includes("run_race"),
      "活 owner 的 run 不应被 resume（D-F3：防劫持 P2 runner 还在驱动的 run）");

    // 阶段2：owner 死了（删 owner 文件，模拟崩溃清理）→ 可 resume
    rmSync(ownerPath, { force: true });
    resumable = scanResumableRuns(runDir, now, 10000);
    assert.ok(resumable.includes("run_race"),
      "owner 死后的孤儿 run 应可 resume");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ============================================================
// D-F2 修复：统一视图（daemon list 看到所有非终态 run，标 owner）
// ============================================================
// D-F2 痛点（research/14）：`run --background`（P2 runner）派发的 run 不出现在 daemon
// list 里——两套所有者隔离。D-F1 只解了 daemon 自己派发的 run 的可见性。
// 正解（统一视图，forward-compatible）：daemon list 不再只报 in-memory（daemon-owned）
// run，而是扫 runDir 全部非终态 run，按 owner 来源分类标记：
//   - "daemon"   ：daemon in-memory 拥有（已知，是它自己派的）
//   - "external" ：有活 owner 文件（.owner-<runId>）但不在 daemon in-memory → 别人（如 P2
//                  background runner）在驱动，daemon 不劫持但**可见**（D-F2 核心）
//   - "orphan"   ：非终态但无 owner（owner 进程死了/没写 owner）→ resume 候选
// 这不动两套所有者模型（彻底统一是 P4 范围的设计决策，handoff §5 明示），只补可见性。
// owner 文件机制沿用 D-F3（isRunOwned/ownerFilePath），纯函数 scanAllRuns 可单测。

test("scanAllRuns: 返回所有非终态 run，终态 run 不返回", () => {
  const runDir = makeRunDir();
  const now = Date.now();
  try {
    writeTranscript(runDir, "r_running", "running");
    writeTranscript(runDir, "r_submitted", null); // 无 state_change = submitted
    writeTranscript(runDir, "r_done", "completed"); // 终态，不返回
    const runs = scanAllRuns(runDir, now, 10000);
    const ids = runs.map((r) => r.runId).sort();
    assert.deepEqual(ids, ["r_running", "r_submitted"], "只返回非终态 run");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("scanAllRuns: 无 owner 文件的非终态 run 标 orphan（resume 候选）", () => {
  const runDir = makeRunDir();
  const now = Date.now();
  try {
    writeTranscript(runDir, "r_orphan", "running");
    const runs = scanAllRuns(runDir, now, 10000);
    const r = runs.find((x) => x.runId === "r_orphan");
    assert.ok(r, "orphan run 应返回");
    assert.equal(r.owner, "orphan", "无 owner 文件 = orphan");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("scanAllRuns: 有活 owner 文件的非终态 run 标 external（别人在驱动，可见不劫持）", () => {
  const runDir = makeRunDir();
  const now = Date.now();
  try {
    writeTranscript(runDir, "r_external", "running");
    // P2 background runner 还活着（心跳新鲜）→ external，不是 orphan
    writeFileSync(ownerFilePath(runDir, "r_external"), JSON.stringify({ pid: 8888, heartbeatAt: now }), "utf8");
    const runs = scanAllRuns(runDir, now, 10000);
    const r = runs.find((x) => x.runId === "r_external");
    assert.ok(r, "external-owned run 应返回（D-F2：可见）");
    assert.equal(r.owner, "external", "活 owner 文件 = external");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("scanAllRuns: 心跳过期的 owner 文件当 orphan（owner 死了）", () => {
  const runDir = makeRunDir();
  const now = 20000;
  try {
    writeTranscript(runDir, "r_dead_owner", "running");
    // owner 心跳 3000ms 前，阈值 2000 → owner 死 → orphan（resume 候选）
    writeFileSync(ownerFilePath(runDir, "r_dead_owner"), JSON.stringify({ pid: 8888, heartbeatAt: 17000 }), "utf8");
    const runs = scanAllRuns(runDir, now, 2000);
    const r = runs.find((x) => x.runId === "r_dead_owner");
    assert.equal(r.owner, "orphan", "owner 死（心跳过期）= orphan");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("scanAllRuns: 混合——daemon-owned（in-memory 集合）+ external + orphan 同列", () => {
  const runDir = makeRunDir();
  const now = Date.now();
  try {
    writeTranscript(runDir, "r_daemon", "running");   // 将标 daemon（在 in-memory 集合里）
    writeTranscript(runDir, "r_external", "running"); // external（活 owner 文件）
    writeTranscript(runDir, "r_orphan", "running");   // orphan（无 owner）
    writeFileSync(ownerFilePath(runDir, "r_external"), JSON.stringify({ pid: 8888, heartbeatAt: now }), "utf8");
    const runs = scanAllRuns(runDir, now, 10000, new Set(["r_daemon"]));
    const byId = Object.fromEntries(runs.map((r) => [r.runId, r.owner]));
    assert.equal(byId.r_daemon, "daemon", "in-memory = daemon");
    assert.equal(byId.r_external, "external", "活 owner 文件 = external");
    assert.equal(byId.r_orphan, "orphan", "无 owner = orphan");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("scanAllRuns: 空目录/无 run 返回空数组", () => {
  const runDir = makeRunDir();
  try {
    assert.deepEqual(scanAllRuns(runDir, Date.now(), 10000), []);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("scanAllRuns: 坏 transcript 文件跳过（不拖垮整个扫描）", () => {
  const runDir = makeRunDir();
  try {
    writeTranscript(runDir, "r_ok", "running");
    writeFileSync(join(runDir, "r_bad.jsonl"), "{not json", "utf8");
    const runs = scanAllRuns(runDir, Date.now(), 10000);
    assert.deepEqual(runs.map((r) => r.runId), ["r_ok"], "坏文件跳过，好的照常返回");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("D-F2: daemon list 含 external（活 owner 文件）的 run，不只是 daemon-owned", async () => {
  // 复现 D-F2：daemon list 当前只报 in-memory run，看不到 P2 background runner 派发的。
  // 修复后 list 扫 runDir，external（活 owner）run 也出现（标 owner:external）。
  const runDir = makeRunDir();
  const pipe = uniquePipe();
  const daemon = await startDaemon({ runDir, pipe, registry: mockRegistry(runDir), fetchImpl: makeMockFetch(), waitTimeout: 3000, pollInterval: 50 });
  try {
    // 模拟 P2 background runner 派发了一个 run（非终态 + 活 owner 文件，daemon 不持有它）
    writeTranscript(runDir, "r_external", "running");
    writeFileSync(ownerFilePath(runDir, "r_external"), JSON.stringify({ pid: 8888, heartbeatAt: Date.now() }), "utf8");
    const res = await connectDaemon(pipe, { cmd: "list" });
    assert.equal(res.ok, true);
    const r = res.runs.find((x) => x.runId === "r_external");
    assert.ok(r, "D-F2：external（P2 runner 派发）的 run 应出现在 daemon list（统一视图）");
    assert.equal(r.owner, "external");
  } finally {
    await daemon.stop();
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("D-F2: daemon list 含 daemon-owned run 仍标 daemon", async () => {
  const runDir = makeRunDir();
  const pipe = uniquePipe();
  // silent fetch：/message 永远空 → run 卡 running 不自终，给 list 创造窗口看到 in-memory run。
  // （makeMockFetch 会立即 completed，run 从内存移除，list 看不到——故用 silent。）
  const silentFetch = async (url, init = {}) => {
    const urlStr = String(url);
    if (init.method === "POST" && urlStr.endsWith("/api/session")) {
      return { ok: true, status: 200, async json() { return { data: { id: "ses_d" } }; }, async text() { return JSON.stringify({ data: { id: "ses_d" } }); } };
    }
    if (init.method === "POST" && urlStr.includes("/prompt_async")) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    if (init.method === "GET" && urlStr.includes("/message")) {
      return { ok: true, status: 200, async json() { return []; }, async text() { return "[]"; } };
    }
    return { ok: false, status: 404, async text() { return "x"; } };
  };
  const daemon = await startDaemon({ runDir, pipe, registry: mockRegistry(runDir), fetchImpl: silentFetch, waitTimeout: 60000, pollInterval: 50 });
  try {
    const startRes = await connectDaemon(pipe, { cmd: "start", agentId: "worker_a", prompt: "x" });
    await new Promise((r) => setTimeout(r, 200)); // 让 run 进入 running 并落盘
    const res = await connectDaemon(pipe, { cmd: "list" });
    const r = res.runs.find((x) => x.runId === startRes.runId);
    assert.ok(r, "daemon 派发的 run 应在 list");
    assert.equal(r.owner, "daemon", "daemon 派发的 run 标 daemon");
  } finally {
    await daemon.stop();
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ============================================================
// Increment 2 — IPC 客户端 connectDaemon + JSON-line 帧
// ============================================================
// 用进程内 net.createServer 做回环：客户端发请求 → server 回响应。
// 管道名唯一（避并发冲突），每个测试自己起/关 server。

import { createServer as netCreateServer } from "node:net";

function uniquePipe() {
  return `\\\\.\\pipe\\wao-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 起一个回环 echo-ish server：收到一行 JSON 请求，回一行 JSON 响应（带 echo）。 */
function startEchoServer(pipe) {
  const server = netCreateServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const req = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        sock.write(JSON.stringify({ ok: true, echo: req.cmd, at: 1 }) + "\n");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(pipe, () => resolve(server));
  });
}

test("connectDaemon: 发 ping 收响应（JSON-line 帧正确）", async () => {
  const pipe = uniquePipe();
  const server = await startEchoServer(pipe);
  try {
    const res = await connectDaemon(pipe, { cmd: "ping" });
    assert.equal(res.ok, true);
    assert.equal(res.echo, "ping");
  } finally {
    server.close();
  }
});

test("connectDaemon: 连不上（无 daemon）抛错", async () => {
  const pipe = uniquePipe(); // 无人 listen
  await assert.rejects(() => connectDaemon(pipe, { cmd: "ping" }, { timeoutMs: 500 }));
});

// ============================================================
// Increment 3 — IPC server handler (ping/list/status/start/stop)
// ============================================================
// in-process 起 daemon server（mock registry + mock fetch 注入，不烧 token）。

// mock fetch：opencode-serve 回环，session 创建后 prompt_async 推一条 assistant 消息。
function makeMockFetch() {
  const sessions = new Map();
  return async (url, init = {}) => {
    const urlStr = String(url);
    if (init.method === "POST" && urlStr.endsWith("/api/session")) {
      const id = `ses_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      sessions.set(id, { messages: [] });
      return { ok: true, status: 200, async json() { return { data: { id } }; }, async text() { return JSON.stringify({ data: { id } }); } };
    }
    if (init.method === "POST" && urlStr.includes("/prompt_async")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const body = JSON.parse(init.body);
      const session = sessions.get(sessionId);
      if (session) {
        session.messages.push({ info: { id: body.messageID, role: "user" }, parts: body.parts });
        session.messages.push({ info: { id: "msg_reply", role: "assistant" }, parts: [{ type: "text", text: "ok" }] });
      }
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    if (init.method === "GET" && urlStr.includes("/message")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const session = sessions.get(sessionId);
      return { ok: true, status: 200, async json() { return session?.messages ?? []; }, async text() { return JSON.stringify(session?.messages ?? []); } };
    }
    if (init.method === "POST" && urlStr.includes("/abort")) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    return { ok: false, status: 404, async text() { return "not found"; } };
  };
}

function mockRegistry(runDir) {
  return { agents: { worker_a: { backend: "opencode-serve", serveUrl: "http://127.0.0.1:4299", agent: "build", cwd: runDir, model: { providerID: "p", id: "m" }, completionMode: "first-stable" } } };
}

test("daemon server: ping 返回 ok", async () => {
  const runDir = makeRunDir();
  const pipe = uniquePipe();
  const daemon = await startDaemon({ runDir, pipe, registry: mockRegistry(runDir), fetchImpl: makeMockFetch() });
  try {
    const res = await connectDaemon(pipe, { cmd: "ping" });
    assert.equal(res.ok, true);
    assert.ok(res.pid, "ping 应带 pid");
  } finally {
    await daemon.stop();
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("daemon server: list 返回空 run 列表（无活动 run）", async () => {
  const runDir = makeRunDir();
  const pipe = uniquePipe();
  const daemon = await startDaemon({ runDir, pipe, registry: mockRegistry(runDir), fetchImpl: makeMockFetch() });
  try {
    const res = await connectDaemon(pipe, { cmd: "list" });
    assert.equal(res.ok, true);
    assert.deepEqual(res.runs, []);
  } finally {
    await daemon.stop();
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("daemon server: start 派发 run 并推进到终态（mock fetch）", async () => {
  const runDir = makeRunDir();
  const pipe = uniquePipe();
  const daemon = await startDaemon({ runDir, pipe, registry: mockRegistry(runDir), fetchImpl: makeMockFetch(), waitTimeout: 3000, pollInterval: 20 });
  try {
    const res = await connectDaemon(pipe, { cmd: "start", agentId: "worker_a", prompt: "do it" });
    assert.equal(res.ok, true, "start 应返回 ok");
    assert.ok(res.runId, "start 应返回 runId");

    // 轮询 transcript 直到终态（daemon 在后台驱动 waitForCompletion）
    const deadline = Date.now() + 8000;
    let state = "pending";
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const raw = readFileSync(join(runDir, `${res.runId}.jsonl`), "utf8");
        const events = raw.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
        state = findState(events);
        if (["completed", "failed", "aborted", "timed_out"].includes(state)) break;
      } catch { /* 还没写 */ }
    }
    assert.equal(state, "completed", "daemon start 的 run 应被驱动到 completed");
  } finally {
    await daemon.stop();
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("daemon server: status 返回指定 run 的状态", async () => {
  const runDir = makeRunDir();
  const pipe = uniquePipe();
  const daemon = await startDaemon({ runDir, pipe, registry: mockRegistry(runDir), fetchImpl: makeMockFetch(), waitTimeout: 3000, pollInterval: 20 });
  try {
    const startRes = await connectDaemon(pipe, { cmd: "start", agentId: "worker_a", prompt: "x" });
    // 给一点时间让 run 建起来
    await new Promise((r) => setTimeout(r, 150));
    const res = await connectDaemon(pipe, { cmd: "status", runId: startRes.runId });
    assert.equal(res.ok, true);
    assert.equal(res.runId, startRes.runId);
    assert.ok(typeof res.state === "string", "status 应带 state");
  } finally {
    await daemon.stop();
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("daemon server: stop <runId> 中止 in-memory run", async () => {
  const runDir = makeRunDir();
  const pipe = uniquePipe();
  // silent fetch：/message 永远空 → run 卡 running 不自终，给 stop 创造窗口
  const silentFetch = async (url, init = {}) => {
    const urlStr = String(url);
    if (init.method === "POST" && urlStr.endsWith("/api/session")) {
      return { ok: true, status: 200, async json() { return { data: { id: "ses_s" } }; }, async text() { return JSON.stringify({ data: { id: "ses_s" } }); } };
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
    return { ok: false, status: 404, async text() { return "x"; } };
  };
  const daemon = await startDaemon({ runDir, pipe, registry: mockRegistry(runDir), fetchImpl: silentFetch, waitTimeout: 60000, pollInterval: 50 });
  try {
    const startRes = await connectDaemon(pipe, { cmd: "start", agentId: "worker_a", prompt: "x" });
    await new Promise((r) => setTimeout(r, 200)); // 让 run 进入 running
    const res = await connectDaemon(pipe, { cmd: "stop", runId: startRes.runId });
    assert.equal(res.ok, true);
    assert.equal(res.stopped, true, "stop 应成功中止 in-memory run");
    // list 应不再含该 run
    const listRes = await connectDaemon(pipe, { cmd: "list" });
    assert.ok(!listRes.runs.some((r) => r.runId === startRes.runId), "stop 后 list 不应再含该 run");
  } finally {
    await daemon.stop();
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("daemon server: 未知 cmd 返回错误响应（不崩）", async () => {
  const runDir = makeRunDir();
  const pipe = uniquePipe();
  const daemon = await startDaemon({ runDir, pipe, registry: mockRegistry(runDir), fetchImpl: makeMockFetch() });
  try {
    const res = await connectDaemon(pipe, { cmd: "bogus" });
    assert.equal(res.ok, false);
    assert.match(res.error, /unknown.*cmd|bogus/i);
  } finally {
    await daemon.stop();
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ============================================================
// Increment 4 — 心跳 + 握手写 + 优雅退出
// ============================================================

test("心跳：startDaemon 写 daemon.json，heartbeatAt 在动", async () => {
  const runDir = makeRunDir();
  const pipe = uniquePipe();
  const daemon = await startDaemon({ runDir, pipe, registry: mockRegistry(runDir), fetchImpl: makeMockFetch(), heartbeatIntervalMs: 200 });
  try {
    // 启动即写 handshake
    const hs1 = readHandshake(runDir);
    assert.ok(hs1, "启动应写 daemon.json");
    assert.equal(hs1.pid, process.pid);
    assert.equal(hs1.pipe, pipe);

    // 等两次心跳间隔，heartbeatAt 应推进
    await new Promise((r) => setTimeout(r, 500));
    const hs2 = readHandshake(runDir);
    assert.ok(hs2.heartbeatAt > hs1.heartbeatAt, "heartbeatAt 应被心跳推进");
    assert.ok(isDaemonAlive(hs2, Date.now(), 5000), "判活应返回 true");
  } finally {
    await daemon.stop();
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("优雅退出：stop 后 daemon.json 删除", async () => {
  const runDir = makeRunDir();
  const pipe = uniquePipe();
  const daemon = await startDaemon({ runDir, pipe, registry: mockRegistry(runDir), fetchImpl: makeMockFetch() });
  assert.ok(readHandshake(runDir), "运行中 handshake 存在");
  await daemon.stop();
  try {
    assert.equal(readHandshake(runDir), null, "stop 后 handshake 应删除");
    // pipe 不再 listen：connect 应失败
    await assert.rejects(() => connectDaemon(pipe, { cmd: "ping" }, { timeoutMs: 500 }));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ============================================================
// Increment 5 — 重启 resume-scan（daemon 启动时接管未完成 run）
// ============================================================

test("resume-scan: 启动时扫到未完成 run，daemon 接管并推进到终态", async () => {
  const runDir = makeRunDir();
  const pipe = uniquePipe();
  try {
    // 预置一个 running 态 transcript（模拟 daemon 重启前的残留 in-flight run）
    // agentId 必须在 registry 里（resume 会 getAgent），用 worker_a。
    writeTranscript(runDir, "run_leftover", "running", "worker_a");
    const resumed = scanResumableRuns(runDir);
    assert.deepEqual(resumed, ["run_leftover"], "scanResumableRuns 应扫到残留 run");

    const daemon = await startDaemon({
      runDir, pipe,
      registry: mockRegistry(runDir),
      fetchImpl: makeMockFetch(),
      resumeOnStart: true,
      waitTimeout: 3000,
      pollInterval: 20,
    });
    try {
      // resume 后 daemon 应把 run_leftover 推进到终态（mock fetch 立即回 assistant）
      const deadline = Date.now() + 8000;
      let state = "running";
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          const raw = readFileSync(join(runDir, "run_leftover.jsonl"), "utf8");
          const events = raw.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
          state = findState(events);
          if (["completed", "failed", "aborted", "timed_out"].includes(state)) break;
        } catch { /* */ }
      }
      assert.ok(["completed", "failed", "aborted", "timed_out"].includes(state),
        `resume-scan 应把残留 run 推进到终态，实际=${state}`);
    } finally {
      await daemon.stop();
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ============================================================
// Increment 6 — CLI daemon 命令族 E2E（真实 spawn CLI）
// ============================================================
// 纪律：触外部系统（真实 detached 进程 + 真实 pipe），milestone-discipline §4 要求。
// 每测试必须清 daemon 进程（06-18 教训：绝不留孤儿）。

function cliDaemon(args, { cwd, timeout = 10000 } = {}) {
  return spawnSync(process.execPath, ["src/cli.js", "daemon", ...args], {
    cwd: cwd ?? process.cwd(),
    encoding: "utf8",
    timeout,
  });
}

// 兜底清 daemon 进程（读 daemon.json.pid → taskkill /T /F）。
function killDaemonFromHandshake(runDir) {
  const hs = readHandshake(runDir);
  if (hs?.pid) {
    try {
      spawnSync("taskkill", ["/pid", String(hs.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch { /* 尽力 */ }
  }
}

test("CLI daemon ping: 无 daemon 时返回非 0 + 提示未运行", () => {
  const runDir = makeRunDir();
  try {
    const res = cliDaemon(["ping", "--run-dir", runDir], { timeout: 8000 });
    assert.notEqual(res.status, 0, "无 daemon 时 ping 应非 0 退出");
    assert.match((res.stdout + res.stderr), /not running|未运行|no daemon/i);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("CLI daemon start: 退出 0 + 写 daemon.json + 后续 ping 通", async () => {
  const runDir = makeRunDir();
  try {
    const startRes = cliDaemon(["start", "--run-dir", runDir], { timeout: 8000 });
    assert.equal(startRes.status, 0, "daemon start 应退出 0");

    // daemon.json 应出现（detached 进程异步写，轮询一下）
    let hs = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !hs) {
      hs = readHandshake(runDir);
      if (!hs) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(hs, "daemon start 后应写 daemon.json");
    assert.ok(hs.pid, "handshake 应带 pid");

    // 后续 ping 应通
    const pingRes = cliDaemon(["ping", "--run-dir", runDir], { timeout: 8000 });
    assert.equal(pingRes.status, 0, "daemon 运行时 ping 应退出 0");
    assert.match(pingRes.stdout, /"ok":\s*true/);
  } finally {
    killDaemonFromHandshake(runDir);
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("CLI daemon stop: 让 daemon 退出，daemon.json 消失", async () => {
  const runDir = makeRunDir();
  try {
    cliDaemon(["start", "--run-dir", runDir], { timeout: 8000 });
    // 等 daemon 起来
    let hs = null;
    const dl = Date.now() + 3000;
    while (Date.now() < dl && !hs) { hs = readHandshake(runDir); if (!hs) await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(hs, "前置：daemon 应已起来");

    const stopRes = cliDaemon(["stop", "--run-dir", runDir], { timeout: 8000 });
    assert.equal(stopRes.status, 0, "daemon stop 应退出 0");

    // daemon.json 应消失（轮询，因 detached 退出异步）
    let gone = false;
    const dl2 = Date.now() + 3000;
    while (Date.now() < dl2 && !gone) { gone = readHandshake(runDir) === null; if (!gone) await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(gone, "stop 后 daemon.json 应消失");
  } finally {
    killDaemonFromHandshake(runDir);
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ============================================================
// D-F1 修复：daemon run CLI bridge（让 daemon 真正能派发 worker）
// ============================================================
// dogfood（research/14 D-F1）发现：daemon 有 start IPC handler 但无 CLI 入口，
// agent 起 daemon 后无法通过它派发 worker。本测试验证补的 `daemon run` CLI：
// 派发的 run 经 daemon 持有，出现在 `daemon list` 里（统一视图，解 D-F2）。

test("D-F1: daemon run 经 CLI 派发，run 出现在 daemon list（解 D-F1 + D-F2 可见性）", async () => {
  const runDir = makeRunDir();
  // 用 in-process daemon + mock fetch（不烧 token），CLI 经默认 pipe 连它。
  // 注意：必须用异步 spawn（非 spawnSync）——spawnSync 阻塞父事件循环，
  // in-process daemon 无法 accept 连接（named pipe server 要事件循环驱动）。
  // 用 silent fetch（/message 永远空）让 run 卡 running，这样 daemon list 查询时它还在。
  const silentFetch = async (url, init = {}) => {
    const u = String(url);
    if (init.method === "POST" && u.endsWith("/api/session")) return { ok: true, status: 200, async json() { return { data: { id: "ses_df1" } }; }, async text() { return JSON.stringify({ data: { id: "ses_df1" } }); } };
    if (init.method === "POST" && u.includes("/prompt_async")) return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    if (init.method === "GET" && u.includes("/message")) return { ok: true, status: 200, async json() { return []; }, async text() { return "[]"; } };
    if (init.method === "POST" && u.includes("/abort")) return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    return { ok: false, status: 404, async text() { return "x"; } };
  };
  const daemon = await startDaemon({
    runDir,
    pipe: "\\\\.\\pipe\\wao-daemon",
    registry: mockRegistry(runDir),
    fetchImpl: silentFetch,
    waitTimeout: 60000,
    pollInterval: 50,
  });
  try {
    // 异步 spawn CLI daemon run（不阻塞 daemon 事件循环）
    const { spawn } = await import("node:child_process");
    const runChild = spawn(process.execPath, ["src/cli.js", "daemon", "run", "worker_a", "--prompt", "do it", "--run-dir", runDir], { cwd: process.cwd() });
    let runOut = "";
    runChild.stdout.on("data", (d) => { runOut += d.toString(); });
    await new Promise((r, rej) => { runChild.on("close", r); runChild.on("error", rej); });

    assert.ok(runOut.includes('"runId"'), `daemon run 应返回 runId，实际输出: ${runOut}`);
    const parsed = JSON.parse(runOut.slice(runOut.indexOf("{"), runOut.lastIndexOf("}") + 1));
    assert.ok(parsed.runId, "daemon run 应返回 runId");

    // 派发的 run 应出现在 daemon list（D-F2 可见性：daemon 持有它）。
    // 也用异步 spawn（同样不阻塞）。
    const listChild = spawn(process.execPath, ["src/cli.js", "daemon", "list", "--run-dir", runDir], { cwd: process.cwd() });
    let listOut = "";
    listChild.stdout.on("data", (d) => { listOut += d.toString(); });
    await new Promise((r) => { listChild.on("close", r); });
    const lparsed = JSON.parse(listOut.slice(listOut.indexOf("{"), listOut.lastIndexOf("}") + 1));
    assert.ok(lparsed.runs.some((r) => r.runId === parsed.runId),
      "daemon list 应含 daemon run 派发的 run（统一视图）");
  } finally {
    await daemon.stop();
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("D-F1: daemon run 在 daemon 未运行时报错（引导先 start）", () => {
  const runDir = makeRunDir();
  try {
    const res = cliDaemon(["run", "worker_a", "--prompt", "x", "--run-dir", runDir], { timeout: 8000 });
    assert.notEqual(res.status, 0, "无 daemon 时 daemon run 应非 0 退出");
    assert.match((res.stdout + res.stderr), /not running|未运行|no daemon|start/i);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
