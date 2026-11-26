// test/isolation-infra/ownerDashboardV2Stream.test.js
//
// 第 144 批（决定 0131 §4）：Owner 看板 /v2 侧栏 Activity 页签的事件流 GET /api/worker/stream。
// 页面侧的用例在 ownerDashboardV2Activity.test.js，路由守卫（鉴权、方法、参数闭集的逐项边界）在
// ownerDashboardApi.test.js 的 SW 用例里。
//
// 夹具纪律：运行目录与转录全部建在 os.tmpdir() 下，绝不读仓库的 runs/。端到端用真实的
// createOwnerDashboardServer（真实读模型），监听 127.0.0.1 临时端口；帧用页面自己的解析器解析。
//
// 每条声称对应一个能证伪它的用例：
//   U  单元      帧的线上格式；页面解析器（跨块半帧、注释行、多帧一块）；传输游标的编解码；游标代际
//                失效回 reset；积压上限关闭连接；终态排空后发 end；客户端断开立即清理；连接总数上限；
//                定位不到的运行；溢出 / 寻不到的追加 / 坏行
//   E  端到端    追加后 1 秒内收到 rows，且与 projectWorkerActivity({ afterSeq }) 逐字一致；半行只在
//                写完后出帧；update 帧；截断 / 替换 / 移桶后的对账与 reset；终态 end；带 3 条流时
//                close() 1 秒内完成；无令牌 401、参数错 400；带游标续传不重发；一次新增多页分帧送完
//   R  夹具回放  test/fixtures/ 里的转录按随机块追加进临时文件，流交付的那张表与整份翻页的那张表
//                逐一相同（拼装与比对是 helper 的导出函数，Lead 在真实转录上照此再跑）
//
// 关于 R：任务书说的是"test/fixtures/ 里已有的各后端转录夹具"。那里只有两份 .jsonl 转录
// （transcript-evidence-passed-backend-failed、transcript-legacy-evidence-backend-failed）；kimi /
// zcode 三个目录装的是服务商接口的原始抓包，不是转录。回放用的是这两份，外加一份本文件现造的
// 合成转录（标明是合成的）把折叠、缺口、筛选、update 这些路径压到。

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createOwnerDashboardServer } from "../../src/ownerDashboardServer.js";
import { OWNER_SEQ_MAX, projectWorkerActivity } from "../../src/application/ownerWorkerActivity.js";
import * as stream from "../../src/application/ownerWorkerStream.js";
import * as api from "../../src/owner-dashboard/v2/api.js";
import {
  TRANSCRIPT_FIXTURES, chunkPlan, describeRow, eventOf, eventsOfBytes, firstDifference, httpJson, openStream, openStreamWorld,
  replayTranscript, toBytes,
} from "./ownerDashboardV2StreamHelpers.js";

const T0 = Date.parse("2026-11-26T09:00:00.000Z");

/** 给 Promise 加到期失败（断言"1 秒内"用）；无论成败都清掉定时器。 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 事件构造器：seq 是真实事件号，每条事件走 1 秒；skip(n) 留下 n 个没有事件的号（真缺口）。 */
function builder(runId) {
  const events = [];
  let seq = 0;
  let clock = T0;
  const b = {
    events,
    runId,
    skip(n) { seq += n; return b; },
    /** 接着一份已有的事件往下写（续写用）。 */
    adopt(list) {
      for (const event of list) events.push({ ...event });
      seq = Math.max(0, ...list.map((event) => event.seq ?? 0));
      clock = Math.max(T0, ...list.map((event) => Date.parse(event.ts)));
      return b;
    },
    add(type, payload = {}, over = {}) {
      seq += 1;
      const event = { ...payload, type, runId, agentId: "glm-pro", seq, ts: new Date((clock += 1000)).toISOString(), ...over };
      events.push(event);
      return b;
    },
    last: () => events[events.length - 1],
  };
  return b;
}

const message = (text) => ({ kind: "message", role: "assistant", parts: [{ type: "text", text }] });
/** 开工头：run.started（不上时间线）→ pending → running（STATE 行）。 */
function liveHead(runId) {
  const b = builder(runId);
  b.add("run.started", { backend: "claude-code" });
  b.add("run.state_change", { from: "pending", to: "running", reason: "first_event" });
  return b;
}
/** liveHead + session.created（claude-code：命令退出码可由结果推断）。 */
function commandHead(runId) {
  const b = liveHead(runId);
  b.add("session.created", { backend: "claude-code", backendSessionId: "proc_1", serveUrl: null });
  return b;
}
/** 终态：run.completed + running → completed。 */
function finish(b) {
  b.add("run.completed", {});
  b.add("run.state_change", { from: "running", to: "completed", reason: "completed" });
  return b;
}

/** 这一刻整份转录投影出的某一页（帧内容要与它逐字一致）；rows 帧不带 updates。 */
const pageOf = (events, query = {}) => {
  const { updates, ...rest } = projectWorkerActivity({ runId: events[0].runId, events, env: {}, ...query });
  assert.deepEqual(updates, [], "the page of the whole file carries no update here");
  return { ...rest, updates: [] };
};
const ofKind = (tap, kind) => tap.frames.filter((frame) => frame.event === kind);
const seqsOf = (frame) => frame.data.rows.map((row) => (row.row === "event" ? row.seq : `${row.fromSeq}-${row.toSeq}`));

/**
 * 起一个世界并在用例结束时关掉它（失败也关）。它还没有 start()：先写转录、再 await w.start()
 * （读模型是 listen 之后才开始读的，先起服务再写文件的话首轮快照里没有这个运行）。之后新写的
 * 运行要先 await w.server.refreshNow() 才进得了快照。
 */
function world(t, options) {
  const w = openStreamWorld(options);
  t.after(() => w.close());
  return w;
}

/** 起一个已经 start() 的世界：转录先写好（runId → 事件），读模型首轮就看得见。 */
async function startedWorld(t, runs, options) {
  const w = world(t, options);
  for (const [runId, events] of runs) w.write(runId, events);
  await w.start();
  return w;
}

// =====================================================================
// U) 单元
// =====================================================================

test("U1 一帧的线上格式：id / event / data 各一行，data 是单行 JSON，帧以空行结束；没有 id 就没有 id 行；心跳是一行注释", () => {
  const cursor = stream.encodeStreamCursor({ generation: "0123456789abcdef", file: "fedcba9876543210", offset: 48213, seq: 137, chain: "0f1e2d3c4b5a6978" });
  assert.equal(stream.encodeStreamFrame("rows", { runId: "run_x", rows: [] }, cursor), `id: ${cursor}\nevent: rows\ndata: {"runId":"run_x","rows":[]}\n\n`);
  assert.equal(stream.encodeStreamFrame("end", { runId: "run_x" }, null), 'event: end\ndata: {"runId":"run_x"}\n\n');
  assert.equal(stream.heartbeatFrame(), ": hb\n\n");
  // id 只能是传输游标：别的字符串在编码处就拒绝（带换行的 id 会把帧写坏）。
  for (const bad of ["1.abc.def.g.h.i.j", "a\nb", "", 7, undefined]) {
    assert.throws(() => stream.encodeStreamFrame("rows", {}, bad), RangeError, JSON.stringify(bad));
  }
  // 帧的事件名是闭集；别的名字在编码处就拒绝，不会悄悄写上一种页面不认识的帧。
  assert.deepEqual([...stream.OWNER_STREAM_EVENTS], ["rows", "update", "reset", "end"]);
  for (const name of stream.OWNER_STREAM_EVENTS) assert.equal(stream.encodeStreamFrame(name, {}, null).split("\n")[0], `event: ${name}`);
  for (const bad of ["hb", "error", "ROWS", "", "rows "]) assert.throws(() => stream.encodeStreamFrame(bad, {}, null), RangeError, JSON.stringify(bad));
});

test("U2 页面解析器：一块里多帧、一帧跨多块（逐个位置切开都对）、注释行不并帧也不断帧、CRLF、多行 data、没写完的帧不出", () => {
  const two = 'id: a1\nevent: rows\ndata: {"n":1}\n\n: hb\n\nid: b2\nevent: end\ndata: {"n":2}\n\n';
  const parse = (chunks) => {
    const parser = api.createSseParser();
    const out = [];
    for (const chunk of chunks) out.push(...parser.push(chunk));
    out.push(...parser.end());
    return out;
  };
  const expected = [
    { id: "a1", event: "rows", data: '{"n":1}' },
    { id: "b2", event: "end", data: '{"n":2}' },
  ];
  assert.deepEqual(parse([two]), expected, "多帧一块，注释行丢掉");
  // 任意位置切成两块、以及一刀一个字符：结果都一样。
  for (let cut = 0; cut <= two.length; cut += 1) assert.deepEqual(parse([two.slice(0, cut), two.slice(cut)]), expected, `cut at ${cut}`);
  assert.deepEqual(parse([...two]), expected, "one character per chunk");
  // 注释夹在帧的字段之间不打断这一帧。
  assert.deepEqual(parse(["id: a\nevent: rows\n: hb\ndata: {}\n\n"]), [{ id: "a", event: "rows", data: "{}" }]);
  assert.deepEqual(parse(['id: a\r\nevent: rows\r\ndata: {"a":\r\ndata: 1}\r\n\r\n']), [{ id: "a", event: "rows", data: '{"a":\n1}' }], "CRLF 与多行 data");
  assert.deepEqual(parse(["event: update\ndata: {}\n\n"]), [{ id: null, event: "update", data: "{}" }], "没有 id 行");
  assert.deepEqual(parse(["event: rows\ndata: {\n\n"]), [{ id: null, event: "rows", data: "{" }], "不是 JSON 也照原样交出，由调用方处置");
  // 没写完（没有空行）的帧不出；补上空行才出。流结束时残留的半帧丢弃。
  const parser = api.createSseParser();
  assert.deepEqual(parser.push('id: a\nevent: rows\ndata: {"n":1}\n'), []);
  assert.deepEqual(parser.push("\n"), [{ id: "a", event: "rows", data: '{"n":1}' }]);
  assert.deepEqual(parser.push("event: end\ndata: {"), []);
  assert.deepEqual(parser.end(), [], "a frame that never finished is dropped");
});

test("U3 传输游标：编码 → 解码回到同一组值；形状不对（字符、段数、版本、大小写、超长）解不出来；页面那边的形状与它对得上", () => {
  const position = { generation: "0123456789abcdef", file: "fedcba9876543210", offset: 48213, seq: 137, chain: "0f1e2d3c4b5a6978" };
  const cursor = stream.encodeStreamCursor(position);
  assert.deepEqual(stream.decodeStreamCursor(cursor), position);
  assert.match(cursor, /^[0-9a-z.]+$/);
  const longest = stream.encodeStreamCursor({
    generation: "f".repeat(16), file: "f".repeat(16), offset: Number.MAX_SAFE_INTEGER, seq: OWNER_SEQ_MAX, chain: "f".repeat(16),
  });
  assert.equal(longest.length, stream.OWNER_STREAM_CURSOR_MAX_CHARS, "the longest cursor is exactly the cap");
  for (const bad of [
    "", "x",
    "1.0123456789abcdef.fedcba9876543210.48213.137.0f1e2d3c4b5a6978.x", // 多一段
    "2.0123456789abcdef.fedcba9876543210.48213.137.0f1e2d3c4b5a6978", // 不认识的版本
    "1.0123456789ABCDEF.fedcba9876543210.48213.137.0f1e2d3c4b5a6978", // 大写
    "1.0123456789abcdef.fedcba9876543210.48213.137", // 少一段
    `${cursor}.x`, ` ${cursor}`, `${cursor}\n`, "a=b", "a/b", "a+b",
    "1..fedcba9876543210.48213.137.0f1e2d3c4b5a6978",
  ]) {
    assert.equal(stream.decodeStreamCursor(bad), null, JSON.stringify(bad));
    assert.equal(stream.OWNER_STREAM_CURSOR_RE.test(bad), false, JSON.stringify(bad));
  }
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "7", null, NaN]) {
    assert.throws(() => stream.encodeStreamCursor({ ...position, offset: value }), RangeError, `offset ${String(value)}`);
    assert.throws(() => stream.encodeStreamCursor({ ...position, seq: value }), RangeError, `seq ${String(value)}`);
  }
  assert.throws(() => stream.encodeStreamCursor({ ...position, seq: OWNER_SEQ_MAX + 1 }), RangeError, "事件号不超过 OWNER_SEQ_MAX");
  for (const key of ["generation", "file", "chain"]) {
    assert.throws(() => stream.encodeStreamCursor({ ...position, [key]: "xyz" }), RangeError, key);
  }
  // 页面那边的闭集形状与服务端编码同源：服务端编得出的游标，页面的路由校验一定认。
  assert.equal(api.isDataPath(api.streamPath({ runId: "run_x", cursor })), true);
  assert.equal(api.isDataPath(api.streamPath({ runId: "run_x", cursor: longest })), true);
});

// ===== 内存里的转录 + 假响应：不碰磁盘、不靠计时 =====

function memoryIo(bytes) {
  const file = { bytes: toBytes(bytes), ino: 7n, watchers: [] };
  return {
    file,
    watch(path, onEvent, onError) {
      const watcher = { path, onEvent, onError, closed: false };
      file.watchers.push(watcher);
      return () => { watcher.closed = true; };
    },
    stat: async () => ({ dev: 1n, ino: file.ino, size: BigInt(file.bytes.length) }),
    read: async (path, position, length) => file.bytes.subarray(position, position + length),
  };
}
const memoryModel = (io) => ({ locateRunTranscript: async () => ({ path: "/mem/run_x.jsonl", bytes: io.file.bytes }) });

/** 假的流响应：记下写出去的帧；flush=false 时写回调永不触发（读得很慢、根本不读的客户端）。 */
function fakeRes({ flush = true } = {}) {
  const listeners = new Map();
  return {
    status: null, headers: {}, writes: [], ended: false, destroyed: false, unflushed: 0,
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; },
    writeHead(status) { this.status = status; },
    write(chunk, callback) {
      this.writes.push(String(chunk));
      if (callback && flush) setImmediate(callback);
      else if (callback) this.unflushed += 1;
      return true;
    },
    end(chunk, callback) {
      if (chunk !== undefined) this.write(chunk);
      this.ended = true;
      if (callback) setImmediate(callback);
    },
    destroy() { this.destroyed = true; this.emit("close"); },
    on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return this; },
    once(name, fn) { return this.on(name, fn); },
    off(name, fn) { listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== fn)); },
    emit(name, ...args) { for (const fn of [...(listeners.get(name) ?? [])]) fn(...args); },
  };
}
/** 把假响应写出的内容交给页面解析器。 */
const framesWritten = (res) => {
  const parser = api.createSseParser();
  const out = [];
  for (const write of res.writes) out.push(...parser.push(write));
  out.push(...parser.end());
  return out.map((frame) => ({ ...frame, data: JSON.parse(frame.data) }));
};
const hubOf = (io, limits = {}, readModel = memoryModel(io)) => stream.createWorkerStreams({
  readModel, env: {}, io, generation: "0123456789abcdef", limits,
});
const ioSleep = () => new Promise((resolve) => setImmediate(resolve));

test("U4 游标代际失效回 reset：别的服务实例的游标、对不上前缀的游标、越过文件末尾的游标——第一帧就是 reset，随后关流，不发任何行", async () => {
  const io = memoryIo(commandHead("run_x").events);
  const hub = hubOf(io);
  // 先拿一个本实例发出的真游标。
  const first = fakeRes();
  const opened = await hub.open({ runId: "run_x", res: first });
  await ioSleep();
  const real = stream.decodeStreamCursor(framesWritten(first).find((frame) => frame.event === "rows").id);
  opened.connection.close();
  assert.equal(hub.size(), 0);

  const cases = [
    ["cursor", { ...real, generation: "ffffffffffffffff" }], // 服务重启后的旧游标
    ["cursor", { ...real, chain: "0000000000000000" }], // 游标之前的内容被改过
    ["cursor", { ...real, file: "0000000000000000" }], // 转录被换成了另一份文件
    ["cursor", { ...real, offset: io.file.bytes.length + 40 }], // 文件比游标短（截断）
    ["cursor", { ...real, offset: 7 }], // 偏移落在半行中间
  ];
  for (const [reason, position] of cases) {
    const res = fakeRes();
    const got = await hub.open({ runId: "run_x", cursor: stream.encodeStreamCursor(position), res });
    assert.equal(got.ok, true);
    await ioSleep();
    const frames = framesWritten(res);
    assert.deepEqual(frames.map((frame) => frame.event), ["reset"], JSON.stringify(position));
    assert.deepEqual(frames[0].data, { runId: "run_x", reason });
    assert.equal(res.status, 200);
    assert.equal(res.ended, true, "reset 之后这条流就关了");
    assert.equal(hub.size(), 0, "不占连接名额");
  }
  // 根本解不出来的游标同样回 reset（路由层已经把形状不对的挡成 400，这里是不经过路由的兜底）。
  const res = fakeRes();
  await hub.open({ runId: "run_x", cursor: "not-a-cursor", res });
  await ioSleep();
  assert.deepEqual(framesWritten(res).map((frame) => [frame.event, frame.data.reason]), [["reset", "cursor"]]);
  assert.deepEqual([...stream.OWNER_STREAM_RESET_REASONS], ["cursor", "changed", "unreadable", "overflow", "undeliverable", "unreachable"]);
  // 流代际是服务实例自己的：不传的话每个实例各不相同（服务重启后的旧游标因此一律对不上）。
  const generations = new Set([1, 2, 3, 4].map(() => stream.createWorkerStreams({ readModel: {} }).generation));
  assert.deepEqual([generations.size, /^[0-9a-f]{16}$/.test([...generations][0])], [4, true], "四个实例四个代际，各是 16 位十六进制");
  assert.equal(hub.generation, "0123456789abcdef", "传了就用传的（测试用）");
});

test("U4b 带着本实例的真游标重连：接着游标之后的位置读，游标之前已发出的行不重发", async () => {
  const b = commandHead("run_x");
  b.add("run.event", message("sent on the first connection"));
  const io = memoryIo(b.events);
  const hub = hubOf(io);
  const first = fakeRes();
  const opened = await hub.open({ runId: "run_x", afterSeq: 3, res: first });
  await ioSleep();
  const sent = framesWritten(first).at(-1);
  assert.deepEqual([sent.event, sent.data.rows.map((row) => row.seq)], ["rows", [4]]);

  b.add("run.event", message("appended while away"));
  io.file.bytes = toBytes(b.events);
  const second = fakeRes();
  const resumed = await hub.open({ runId: "run_x", cursor: sent.id, res: second });
  await ioSleep();
  const frames = framesWritten(second);
  assert.deepEqual(frames.map((frame) => [frame.event, frame.data.rows.map((row) => row.seq)]), [["rows", [5]]], "只给游标之后的行");
  assert.equal(stream.decodeStreamCursor(frames[0].id).seq, 5);
  resumed.connection.close();
});

test("U5 积压上限关闭连接：写出去没人读的帧超过具名上限，这条连接立即被断开，watcher 一并清掉，不占名额", async () => {
  const b = commandHead("run_x");
  const io = memoryIo(b.events);
  const hub = hubOf(io, { backlogMaxFrames: 2 });
  const res = fakeRes({ flush: false });
  const opened = await hub.open({ runId: "run_x", res });
  assert.equal(opened.ok, true);
  await ioSleep();
  assert.deepEqual([res.unflushed, res.destroyed], [1, false], "开流时的那一帧还没被读走：1 帧在上限内，不断");
  const push = async (i) => {
    b.add("run.event", message(`burst ${i}`));
    io.file.bytes = toBytes(b.events);
    await opened.connection.check();
    await ioSleep();
  };
  await push(0);
  assert.deepEqual([res.writes.length, res.unflushed, res.destroyed], [2, 2, false], "第 2 帧仍在上限内");
  await push(1);
  assert.deepEqual([res.writes.length, res.unflushed, res.destroyed], [3, 3, true], "第 3 帧没人读走：超过上限 2，连接被断开");
  await push(2);
  assert.equal(res.writes.length, 3, "断开之后不再写");
  assert.equal(hub.size(), 0, "名额放掉");
  assert.ok(io.file.watchers.every((watcher) => watcher.closed), "watcher 关了");
  assert.ok(stream.OWNER_STREAM_BACKLOG_MAX_FRAMES >= 2 && stream.OWNER_STREAM_BACKLOG_MAX_FRAMES <= 64);
});

test("U5b 心跳：开着的流每 15 秒发一行注释心跳，别的什么都不多发；连接关闭后两个定时器一并清掉", async (t) => {
  const b = commandHead("run_x");
  const base = memoryIo(b.events);
  let stats = 0;
  const io = { ...base, stat: async (...args) => { stats += 1; return base.stat(...args); } };
  const hub = hubOf(io);
  const settled = async () => { for (let i = 0; i < 12; i += 1) await ioSleep(); };
  t.mock.timers.enable({ apis: ["setInterval"] }); // the hub's poll and heartbeat are interval timers
  try {
    const res = fakeRes();
    const opened = await hub.open({ runId: "run_x", afterSeq: 3, res });
    await settled();
    assert.deepEqual(res.writes.map((text) => text.split("\n")[1]), ["event: rows"], "开流只有那一帧");
    assert.equal(stream.OWNER_STREAM_HEARTBEAT_MS, 15_000);
    // 一秒一秒地过：兜底轮询每秒查一轮，没有新行就不发帧，心跳还没到点。
    for (let second = 1; second <= 14; second += 1) {
      t.mock.timers.tick(1_000);
      await settled();
    }
    assert.deepEqual([res.writes.length, stats], [1, 15], "14 秒：还没有心跳（1 秒一轮的兜底轮询照常查了 14 轮：开流 1 次 + 14 轮）");
    t.mock.timers.tick(1_000);
    assert.deepEqual(res.writes.slice(1), [": hb\n\n"], "15 秒：一行注释心跳");
    t.mock.timers.tick(30_000);
    await settled();
    assert.deepEqual(res.writes.slice(1), [": hb\n\n", ": hb\n\n", ": hb\n\n"], "之后每 15 秒一行，别的没有");
    // 关掉这条连接：定时器清了，再过一分钟也没有任何写入、任何一次检查。
    const before = stats;
    opened.connection.close();
    t.mock.timers.tick(60_000);
    await settled();
    assert.deepEqual([res.writes.length, stats], [4, before], "连接关闭之后不再有心跳，也不再查转录");
  } finally {
    hub.closeAll();
    t.mock.timers.reset();
  }
});

test("U5c watcher 运行中报错失效：关掉它，这条流不断，之后的追加由兜底轮询照常送到", async (t) => {
  const b = commandHead("run_x");
  const io = memoryIo(b.events);
  let onError = null;
  let watcherClosed = 0;
  let watchCalls = 0;
  const hub = hubOf({
    ...io,
    watch: (path, onEvent, fail) => {
      watchCalls += 1;
      onError = fail;
      return () => { watcherClosed += 1; };
    },
  });
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    const res = fakeRes();
    const opened = await hub.open({ runId: "run_x", afterSeq: 3, res });
    for (let i = 0; i < 12; i += 1) await ioSleep();
    assert.deepEqual([typeof onError, watcherClosed, hub.size()], ["function", 0, 1]);
    onError(Object.assign(new Error("EPERM, watch"), { code: "EPERM" })); // Windows 上被占用的文件常这样
    for (let i = 0; i < 12; i += 1) await ioSleep();
    assert.deepEqual([watcherClosed, res.destroyed, hub.size()], [1, false, 1], "watcher 关了，连接还在");
    assert.equal(watchCalls, 1, "没有再建第二个 watcher：之后只靠兜底轮询");
    // 一秒一轮的兜底轮询把追加的事件送到。
    b.add("run.event", message("carried by the poll after the watcher died"));
    io.file.bytes = toBytes(b.events);
    t.mock.timers.tick(1_000);
    for (let i = 0; i < 12; i += 1) await ioSleep();
    assert.deepEqual(
      framesWritten(res).map((frame) => [frame.event, frame.data.rows?.map((row) => row.summary)]),
      [["rows", []], ["rows", ["carried by the poll after the watcher died"]]],
    );
    assert.deepEqual([watchCalls, watcherClosed], [1, 1]);
  } finally {
    hub.closeAll();
    t.mock.timers.reset();
  }
});

test("U6 终态排空后发 end：先送完剩下的行，等一个兜底周期，再整读对账一次，最后发 end 并关流；之后不再有帧", async () => {
  const b = finish(commandHead("run_x"));
  const io = memoryIo(b.events);
  let reads = 0;
  const hub = stream.createWorkerStreams({
    readModel: { locateRunTranscript: async () => { reads += 1; return { path: "/mem/run_x.jsonl", bytes: io.file.bytes }; } },
    env: {}, io, generation: "0123456789abcdef", limits: { endSettleMs: 20 },
  });
  const res = fakeRes();
  const opened = await hub.open({ runId: "run_x", res });
  await ioSleep();
  assert.deepEqual(framesWritten(res).map((frame) => frame.event), ["rows"], "剩下的行先发，不等");
  const wait = async () => { for (let i = 0; i < 40 && !res.ended; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };
  await wait();
  assert.equal(res.ended, true, "终态后的那一定时器到点才收尾");
  const frames = framesWritten(res);
  assert.deepEqual(frames.map((frame) => frame.event), ["rows", "end"]);
  assert.deepEqual(frames[0].data.rows.map((row) => row.seq), [2, 5], "这一页自己带着终态那一行");
  assert.equal(frames[0].data.terminal, true);
  assert.deepEqual(frames[1].data, { runId: "run_x", state: "completed", terminal: true, total: b.events.length });
  assert.equal(frames[1].id, frames[0].id);
  assert.equal(reads, 2, "开流整读一次 + 终态前对账一次");
  assert.equal(hub.size(), 0);
  assert.ok(io.file.watchers.every((watcher) => watcher.closed));
  await opened.connection.check(); // 已关闭：不抛
  assert.equal(stream.OWNER_STREAM_END_SETTLE_MS, 1000, "一个兜底轮询周期");
});

test("U6b 终态之后、收尾之前又追来一条事件（真实转录里紧跟终态的状态变化那一行）：照常送出去，对账后 end 带的事件总数把它算上", async () => {
  const b = commandHead("run_x");
  b.add("run.error", { phase: "wait", error: "boom" });
  const io = memoryIo(b.events);
  const hub = hubOf(io, { endSettleMs: 50 });
  const res = fakeRes();
  const opened = await hub.open({ runId: "run_x", res });
  await ioSleep();
  assert.deepEqual(framesWritten(res).map((frame) => [frame.event, frame.data.total]), [["rows", 4]], "run.error 本身就算终态");
  // 定时器到点之前，状态变化那一行落盘了。
  b.add("run.state_change", { from: "running", to: "failed", reason: "backend_error" });
  io.file.bytes = toBytes(b.events);
  await opened.connection.check();
  for (let i = 0; i < 40 && !res.ended; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(res.ended, true);
  const frames = framesWritten(res);
  assert.deepEqual(frames.map((frame) => [frame.event, frame.data.total, frame.data.rows?.map((row) => row.seq)]), [["rows", 4, [2, 4]], ["rows", 5, [5]], ["end", 5, undefined]], "晚到的那一行没有被漏在流外");
});

test("U7 客户端断开与写入失败：连接立刻清掉 watcher、放开名额，之后的检查不再读文件", async () => {
  const b = commandHead("run_x");
  const io = memoryIo(b.events);
  let reads = 0;
  const hub = stream.createWorkerStreams({
    readModel: memoryModel(io), env: {}, generation: "0123456789abcdef",
    io: { ...io, read: async (...args) => { reads += 1; return io.read(...args); } },
  });
  const gone = fakeRes();
  const first = await hub.open({ runId: "run_x", res: gone });
  await ioSleep();
  gone.emit("close"); // 客户端断开
  assert.equal(hub.size(), 0);
  assert.ok(io.file.watchers.every((watcher) => watcher.closed), "断开时 watcher 立刻关");
  const before = reads;
  b.add("run.event", message("after the client left"));
  io.file.bytes = toBytes(b.events);
  await first.connection.check();
  assert.equal(reads, before, "断开之后不再读转录");

  const broken = fakeRes();
  const second = await hub.open({ runId: "run_x", res: broken });
  await ioSleep();
  broken.emit("error", new Error("EPIPE")); // 写入失败
  assert.equal(hub.size(), 0, "名额放开");
  await second.connection.check(); // 不抛
});

test("U2c 留着的半行后来被抹掉（文件在整行边界之后变短又变长）：那份半行作废，新行原样读到，不与旧半行拼接", async () => {
  const b = commandHead("run_x");
  const io = memoryIo(b.events);
  const hub = hubOf(io);
  const res = fakeRes();
  const opened = await hub.open({ runId: "run_x", afterSeq: 3, res });
  await ioSleep();
  // 一条很长的半行（没有换行）落盘：不出帧，但余量里留着它。
  const partial = Buffer.from(`{"type":"run.event","kind":"message","role":"assistant","parts":[{"type":"text","text":"${"x".repeat(300)}`);
  io.file.bytes = Buffer.concat([toBytes(b.events), partial]);
  await opened.connection.check();
  await ioSleep();
  assert.deepEqual(framesWritten(res).map((frame) => frame.event), ["rows"], "半行不出帧");
  // 尾巴被抹掉，换成一条更短的新行：文件比"读到的地方"短了。
  b.add("run.event", message("short"));
  assert.ok(toBytes([b.last()]).length < partial.length, "新行比那条半行短");
  io.file.bytes = toBytes(b.events);
  await opened.connection.check();
  await ioSleep();
  const frames = framesWritten(res);
  assert.deepEqual(frames.map((frame) => frame.event), ["rows", "rows"], "没有 reset：新行原样读到");
  assert.deepEqual(frames[1].data.rows.map((row) => [row.seq, row.summary]), [[4, "short"]]);
});

test("U7b 读不了的两种：文件系统的错（占用、权限、刚被移走）等宽限期，宽限期内恢复就照常接着、不发 reset；过了宽限期才 reset（unreachable）；不是文件系统的错（代码的错）立刻断开这条连接，不悄悄退化", async () => {
  const b = commandHead("run_x");
  const busy = Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
  const io = memoryIo(b.events);
  let failWith = busy;
  const hub = hubOf({ ...io, read: async (...args) => { if (failWith !== null) throw failWith; return io.read(...args); } }, { lostGraceMs: 60 });
  const res = fakeRes();
  const opened = await hub.open({ runId: "run_x", afterSeq: 3, res });
  await ioSleep();
  b.add("run.event", message("after the busy spell"));
  io.file.bytes = toBytes(b.events);
  await opened.connection.check();
  await ioSleep();
  assert.deepEqual([res.destroyed, res.ended, framesWritten(res).length, hub.size()], [false, false, 1, 1], "宽限期内：不断开，也不发帧");
  // 宽限期内读得动了：照常接着，没有 reset。
  failWith = null;
  await opened.connection.check();
  await ioSleep();
  assert.deepEqual(framesWritten(res).map((frame) => [frame.event, frame.data.rows?.map((row) => row.summary)]), [["rows", []], ["rows", ["after the busy spell"]]]);
  opened.connection.close();

  // 一直读不了：过了宽限期才 reset，放掉名额。（开流之后文件才开始看不住。）
  const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  const io2 = memoryIo(b.events);
  let statBroken = false;
  const hub2 = hubOf({ ...io2, stat: async (...args) => { if (statBroken) throw denied; return io2.stat(...args); } }, { lostGraceMs: 60 });
  const res2 = fakeRes();
  const second = await hub2.open({ runId: "run_x", afterSeq: 3, res: res2 });
  assert.equal(second.ok, true);
  await ioSleep();
  statBroken = true;
  await second.connection.check();
  assert.deepEqual([res2.ended, framesWritten(res2).length], [false, 1], "第一次失败：还在宽限期内");
  await new Promise((resolve) => setTimeout(resolve, 90));
  await second.connection.check();
  await ioSleep();
  assert.deepEqual(framesWritten(res2).slice(1).map((frame) => [frame.event, frame.data.reason]), [["reset", "unreachable"]]);
  assert.deepEqual([res2.ended, hub2.size()], [true, 0]);
  assert.equal(stream.OWNER_STREAM_LOST_GRACE_MS, 5000, "读模型一轮刷新的间隔");

  // 代码的错：不当作读不了去反复试，立刻断开这条连接（不发 reset，不占名额）。
  const io3 = memoryIo(b.events);
  const hub3 = hubOf({ ...io3, read: async () => { throw new TypeError("not a buffer"); } });
  const res3 = fakeRes();
  const third = await hub3.open({ runId: "run_x", afterSeq: 3, res: res3 });
  await ioSleep();
  b.add("run.event", message("never read"));
  io3.file.bytes = toBytes(b.events);
  await third.connection.check();
  await ioSleep();
  assert.deepEqual([res3.destroyed, framesWritten(res3).length, hub3.size()], [true, 1, 0], "断开，不发 reset，不占名额");
});

test("U8 连接总数上限：到具名上限后 open 拒绝；名额在读转录的那一会儿就占着（两个同时到来的开流挤不过同一个名额）；断开一条又能接；closeAll 之后不再接新流", async () => {
  const io = memoryIo(commandHead("run_x").events);
  const hub = hubOf(io, { connectionsMax: 2 });
  const a = await hub.open({ runId: "run_x", res: fakeRes() });
  const b = await hub.open({ runId: "run_x", res: fakeRes() });
  assert.deepEqual([a.ok, b.ok, hub.size(), hub.full()], [true, true, 2, true]);
  assert.deepEqual(await hub.open({ runId: "run_x", res: fakeRes() }), { ok: false, reason: "full" });
  a.connection.close();
  assert.equal(hub.size(), 1);
  assert.equal(hub.full(), false);
  assert.equal((await hub.open({ runId: "run_x", res: fakeRes() })).ok, true);
  hub.closeAll();
  assert.equal(hub.size(), 0);
  assert.deepEqual(await hub.open({ runId: "run_x", res: fakeRes() }), { ok: false, reason: "closed" });
  assert.equal(stream.OWNER_STREAM_CONNECTIONS_MAX, 32);

  // 读转录还没读完的两个开流：还没登记进连接表，名额已经占满。
  const waiting = [];
  const slow = hubOf(io, { connectionsMax: 2 }, {
    locateRunTranscript: () => new Promise((resolve) => waiting.push(() => resolve({ path: "/mem/run_x.jsonl", bytes: io.file.bytes }))),
  });
  const first = slow.open({ runId: "run_x", res: fakeRes() });
  const second = slow.open({ runId: "run_x", res: fakeRes() });
  await ioSleep();
  assert.deepEqual([slow.size(), slow.full(), waiting.length], [0, true, 2], "还没登记进连接表，名额已经占满");
  assert.deepEqual(await slow.open({ runId: "run_x", res: fakeRes() }), { ok: false, reason: "full" }, "第三个挤不进来");
  for (const release of waiting) release();
  assert.deepEqual([(await first).ok, (await second).ok, slow.size(), slow.full()], [true, true, 2, true]);
  // 定位不到的开流不占名额。
  slow.closeAll();
});

test("U9 读模型定位不到（未知运行、读不出、没有读入口、读的时候抛错）→ open 如实说 not_found，不写任何响应、不占名额", async () => {
  const io = memoryIo(commandHead("run_x").events);
  for (const readModel of [{}, { locateRunTranscript: async () => null }, { locateRunTranscript: async () => { throw new Error("EACCES C:\\private\\run_x.jsonl"); } }]) {
    const hub = stream.createWorkerStreams({ readModel, env: {}, io, generation: "0123456789abcdef" });
    const res = fakeRes();
    assert.deepEqual(await hub.open({ runId: "run_x", res }), { ok: false, reason: "not_found" });
    assert.deepEqual([res.status, res.writes.length, hub.size()], [null, 0, 0]);
  }
});

/** 开一条流、追加一些字节、检查一次：返回首帧之后的帧。 */
async function growCase(base, append, limits = {}) {
  const io = memoryIo(base);
  const hub = hubOf(io, limits);
  const res = fakeRes();
  const opened = await hub.open({ runId: "run_x", res });
  await ioSleep();
  const b = builder("run_x").adopt(base);
  append(b);
  io.file.bytes = toBytes(b.events);
  await opened.connection.check();
  await ioSleep();
  return { frames: framesWritten(res).slice(1), res, hub };
}

test("U10 一次新增多过一轮能翻的页数 → reset（overflow）；恰好装满一轮时分帧送完；寻不到的追加（没有号 / 号被复用）→ reset（undeliverable）；整行坏了 → reset（unreadable）", async () => {
  const base = commandHead("run_x").events;
  const round = stream.OWNER_STREAM_LIMIT * stream.OWNER_STREAM_PAGES_MAX;
  const flood = (count) => (b) => { for (let i = 0; i < count; i += 1) b.add("run.event", message(`flood ${i}`)); };

  const exact = await growCase(base, flood(round));
  assert.deepEqual(exact.frames.map((frame) => frame.event), Array(stream.OWNER_STREAM_PAGES_MAX).fill("rows"), "恰好一轮：分帧送完");
  assert.deepEqual(exact.frames.map((frame) => frame.data.rows.length), Array(stream.OWNER_STREAM_PAGES_MAX).fill(stream.OWNER_STREAM_LIMIT));
  assert.equal(exact.res.ended, false);

  const over = await growCase(base, flood(round + 1));
  assert.deepEqual(over.frames.map((frame) => [frame.event, frame.data.reason]), [["reset", "overflow"]], "多一个单位就 reset，不猜从哪续");
  assert.equal(over.res.ended, true);
  assert.equal(over.hub.size(), 0);

  const unnumbered = await growCase(base, (b) => { b.add("run.event", message("no number"), { seq: undefined }); });
  assert.deepEqual(unnumbered.frames.map((frame) => [frame.event, frame.data.reason]), [["reset", "undeliverable"]]);
  const reused = await growCase(base, (b) => { b.add("run.event", message("reused number"), { seq: 2 }); });
  assert.deepEqual(reused.frames.map((frame) => [frame.event, frame.data.reason]), [["reset", "undeliverable"]]);

  // 整行坏了：读不出的事件，与别的接口一样按读不到处理。
  const io = memoryIo(base);
  const hub = hubOf(io);
  const res = fakeRes();
  const opened = await hub.open({ runId: "run_x", res });
  await ioSleep();
  io.file.bytes = Buffer.concat([toBytes(base), Buffer.from('{"type":"run.event","kind":"message"\n')]);
  await opened.connection.check();
  await ioSleep();
  assert.deepEqual(framesWritten(res).slice(1).map((frame) => [frame.event, frame.data.reason]), [["reset", "unreadable"]]);
  assert.equal(res.ended, true);
});

// =====================================================================
// E) 本机 HTTP 端到端（真实 createOwnerDashboardServer，127.0.0.1 临时端口）
// =====================================================================

test("E1 开流后往转录追加事件，由 watcher 唤醒立刻送到（空载时几十毫秒；兜底轮询设在 5 秒作对照，所以 4.5 秒内到的不可能是轮询）；帧内容与 projectWorkerActivity({ afterSeq }) 逐字一致；响应头是事件流", async (t) => {
  const b = liveHead("run_live");
  // 兜底轮询设在 5 秒：所以 1 秒内送到的帧只可能是 watcher 唤醒的（没有 watcher 的对照是 E4b）。
  const w = await startedWorld(t, [["run_live", b.events]], {
    config: { createWorkerStreamsFn: (input) => stream.createWorkerStreams({ ...input, limits: { pollMs: 5000 } }) },
  });
  const tap = await openStream(w, { runId: "run_live", afterSeq: 2 });
  assert.equal(tap.status, 200);
  assert.equal(tap.headers["content-type"], "text/event-stream");
  assert.equal(tap.headers["cache-control"], "no-store");
  assert.equal(tap.headers["x-content-type-options"], "nosniff");
  assert.ok(tap.headers["content-security-policy"]);
  assert.equal(tap.headers["access-control-allow-origin"], undefined);
  assert.equal(await tap.first("rows"), true, "the first frame arrived");
  assert.deepEqual(tap.events, ["rows"]);
  assert.deepEqual(ofKind(tap, "rows")[0].data, pageOf(b.events, { afterSeq: 2 }), "开流先给当前位置之后的那一页（这里没有新行）");
  assert.equal(tap.ended, false);

  const at = Date.now();
  b.add("run.event", message("streamed"));
  w.append("run_live", [b.last()]);
  // 这条流的兜底轮询设在 5 秒：4.5 秒之内送到的只可能是 watcher 唤醒的（没有 watcher 的对照是 E4b）。
  // 空载时实测是几十毫秒；上限不压在 1 秒上，是因为全量并发时机器会卡，而这里要证的是"谁送的"。
  assert.notEqual(await tap.next("rows", 1, 4500), null, "rows delivered by the watcher, not by the 5 s poll");
  const latency = Date.now() - at;
  assert.ok(latency < 4500, `${latency} ms`);
  const frame = ofKind(tap, "rows")[1];
  assert.deepEqual(frame.data, pageOf(b.events, { afterSeq: 2 }));
  assert.deepEqual([frame.data.range, seqsOf(frame)], [{ fromSeq: 3, toSeq: 3 }, [3]]);
  assert.equal(frame.data.rows[0].summary, "streamed");
  assert.equal(stream.decodeStreamCursor(frame.id).seq, 3, "帧的 id 是传输游标：这一帧之后的事件位置");
  assert.equal(tap.ended, false, "运行没结束，流不断");
  tap.close();
});

test("E2 半行分两次写入：只写了前一半时不出帧（等过一个兜底轮询周期），整行写完后 1 秒内才出帧，而且只出这一条", async (t) => {
  const b = liveHead("run_half");
  const w = await startedWorld(t, [["run_half", b.events]]);
  const tap = await openStream(w, { runId: "run_half", afterSeq: 2 });
  assert.equal(await tap.first("rows"), true, "the first frame arrived");

  b.add("run.event", message(`半行 ${"x".repeat(600)}`));
  const line = toBytes([b.last()]);
  const cut = line.length - 70; // 切在正文字符串里
  w.append("run_half", line.subarray(0, cut));
  assert.equal(await tap.next("rows", 1, 1300), null, "半行不出帧");
  assert.equal(tap.frames.length, 1);

  w.append("run_half", line.subarray(cut));
  assert.notEqual(await tap.next("rows", 1, 3000), null, "整行写完后出帧");
  assert.equal(ofKind(tap, "rows").length, 2, "只出这一条，不多不少");
  assert.deepEqual(ofKind(tap, "rows")[1].data, pageOf(b.events, { afterSeq: 2 }));
  tap.close();
});

test("E2c 一块里带着一条整行和下一条的半行：整行立刻出帧，半行留到写完再出——半行不重复读（回放夹具时抓到过的错）", async (t) => {
  const b = liveHead("run_tail");
  const w = await startedWorld(t, [["run_tail", b.events]]);
  const tap = await openStream(w, { runId: "run_tail", afterSeq: 2 });
  assert.equal(await tap.first("rows"), true, "the first frame arrived");

  b.add("run.event", message("whole line"));
  b.add("run.event", message(`half ${"y".repeat(400)}`));
  const [whole, half] = [toBytes([b.events[2]]), toBytes([b.events[3]])];
  w.append("run_tail", Buffer.concat([whole, half.subarray(0, half.length - 50)]));
  assert.notEqual(await tap.next("rows", 1, 3000), null, "整行出帧");
  assert.deepEqual(seqsOf(ofKind(tap, "rows")[1]), [3], "只有那一条整行");
  assert.equal(await tap.next("rows", 1, 1300), null, "半行不出帧（等过一个兜底轮询周期：它没有被当成坏行）");
  assert.deepEqual(tap.events, ["rows", "rows"], "也没有 reset");
  w.append("run_tail", half.subarray(half.length - 50));
  assert.notEqual(await tap.next("rows", 1, 3000), null, "写完后出帧");
  assert.deepEqual(ofKind(tap, "rows")[2].data, pageOf(b.events, { afterSeq: 3 }), "这一帧就是写完的那一行，逐字一致");
  assert.deepEqual(tap.events, ["rows", "rows", "rows"]);
  tap.close();
});

test("E3 命令行先写、结果后写：收到 rows（输出行）与 update（同一条命令行补上了退出码），update 不回拨传输游标", async (t) => {
  const b = commandHead("run_cmd");
  b.add("run.event", { kind: "command", command: "npm test", toolCallId: "c9" });
  const w = await startedWorld(t, [["run_cmd", b.events]]);
  const tap = await openStream(w, { runId: "run_cmd", afterSeq: 4 });
  assert.equal(await tap.first("rows"), true, "the first frame arrived");

  b.add("run.event", { kind: "tool_result", tool: "c9", output: "1 failing test", isError: true });
  w.append("run_cmd", [b.last()]);
  assert.notEqual(await tap.next("update", 1, 3000), null, "update arrives");
  assert.deepEqual(tap.events, ["rows", "rows", "update"], "先是新行，再是就地更新");
  const rowsFrame = ofKind(tap, "rows")[1];
  const update = ofKind(tap, "update")[0];
  const full = projectWorkerActivity({ runId: "run_cmd", events: b.events, env: {}, afterSeq: 4 });
  assert.deepEqual(rowsFrame.data, { ...full, updates: [] }, "rows 帧就是那一页，只是不带 updates");
  assert.deepEqual(seqsOf(rowsFrame), [5]);
  assert.deepEqual(update.data, { runId: "run_cmd", updates: full.updates });
  assert.deepEqual([update.data.updates[0].seq, update.data.updates[0].exitCode, update.data.updates[0].exitSource], [4, 1, "inferred"]);
  assert.equal(update.id, rowsFrame.id, "update 帧沿用 rows 帧推进到的传输游标，不回拨");
  assert.equal(stream.decodeStreamCursor(update.id).seq, 5);
  tap.close();
});

test("E4 截断或替换转录：已发出的部分不再是它的前缀 → reset 并关流；换了文件身份但内容接得上 → 对账后续上，不发 reset；移桶同理", async (t) => {
  // (a) 原地截断
  let b = liveHead("run_cut");
  b.add("run.event", message("kept"));
  const w = await startedWorld(t, [["run_cut", b.events]]);
  let tap = await openStream(w, { runId: "run_cut", afterSeq: 3 });
  assert.equal(await tap.first("rows"), true, "the first frame arrived");
  w.write("run_cut", b.events.slice(0, 1));
  assert.notEqual(await tap.next("reset", 1, 3000), null, "截断后收到 reset");
  assert.deepEqual(ofKind(tap, "reset")[0].data, { runId: "run_cut", reason: "changed" });
  await withTimeout(tap.waitFor(() => tap.ended, 3000), 3000, "reset closes the stream");
  assert.equal(w.server.server.listening, true, "服务本身不受影响");

  // (b) 换成内容不同的另一份文件（新文件改名覆盖：文件身份也换了）
  b = liveHead("run_swap");
  b.add("run.event", message("the original"));
  w.write("run_swap", b.events);
  await w.server.refreshNow();
  tap = await openStream(w, { runId: "run_swap", afterSeq: 3 });
  assert.equal(await tap.first("rows"), true, "the first frame arrived");
  const other = liveHead("run_swap");
  other.events[0].ts = new Date(T0 + 50_000).toISOString();
  other.add("run.event", message("a different file"));
  writeFileSync(join(w.base, "other.jsonl"), toBytes(other.events));
  renameSync(join(w.base, "other.jsonl"), w.fileOf("run_swap"));
  assert.notEqual(await tap.next("reset", 1, 3000), null, "替换后收到 reset");
  assert.equal(ofKind(tap, "reset")[0].data.reason, "changed");
  await withTimeout(tap.waitFor(() => tap.ended, 3000), 3000, "reset closes the stream");

  // (c) 换了文件身份，但内容是已发出的前缀再加一行：重新完整解析后对账接得上，同一条连接继续，不发 reset。
  b = liveHead("run_copy");
  b.add("run.event", message("before the copy"));
  w.write("run_copy", b.events);
  await w.server.refreshNow();
  tap = await openStream(w, { runId: "run_copy", afterSeq: 3 });
  assert.equal(await tap.first("rows"), true, "the first frame arrived");
  let before = tap.frames.length;
  b.add("run.event", message("after the copy"));
  writeFileSync(join(w.base, "copy.jsonl"), toBytes(b.events));
  renameSync(join(w.base, "copy.jsonl"), w.fileOf("run_copy"));
  assert.notEqual(await tap.next("rows", 1, 3000), null, "重新完整解析后把新行送出来");
  assert.deepEqual(tap.frames.slice(before).map((frame) => frame.event), ["rows"], "没有 reset");
  assert.deepEqual(ofKind(tap, "rows").at(-1).data, pageOf(b.events, { afterSeq: 3 }));

  // (d) 移桶：文件挪进项目桶（同一个文件、新的位置）。同一条连接对账后继续。
  const bucket = join(w.runDir, "projects", "moved-11111111");
  mkdirSync(bucket, { recursive: true });
  renameSync(w.fileOf("run_copy"), join(bucket, "run_copy.jsonl"));
  b.add("run.event", message("written in the bucket"));
  appendFileSync(join(bucket, "run_copy.jsonl"), toBytes([b.last()]));
  await w.server.refreshNow();
  before = tap.frames.length;
  assert.notEqual(await tap.next("rows", 1, 3000), null, "移桶之后同一条连接继续送");
  assert.deepEqual(tap.frames.slice(before).map((frame) => frame.event), ["rows"], "没有 reset");
  assert.deepEqual(ofKind(tap, "rows").at(-1).data, pageOf(b.events, { afterSeq: 4 }));
  tap.close();
});

test("E4b 兜底轮询：watcher 建不起来（文件系统的错），追加的事件仍在一个轮询周期内送到；代码的错不吞——它会断开这条流而不是悄悄退化", async (t) => {
  const b = liveHead("run_poll");
  const w = await startedWorld(t, [["run_poll", b.events]], {
    config: {
      createWorkerStreamsFn: (input) => stream.createWorkerStreams({
        ...input,
        io: { watch: () => { throw Object.assign(new Error("EPERM: watch"), { code: "EPERM" }); } },
      }),
    },
  });
  const tap = await openStream(w, { runId: "run_poll", afterSeq: 2 });
  assert.equal(await tap.first("rows"), true, "the first frame arrived");
  const at = Date.now();
  b.add("run.event", message("poll carried"));
  w.append("run_poll", [b.last()]);
  // 轮询 1 秒一轮；追加发生在周期里的哪一点不知道，再留出调度余量（全量并发时机器会卡）。
  assert.notEqual(await tap.next("rows", 1, 4000), null, "the 1 s poll delivers it");
  const latency = Date.now() - at;
  assert.ok(latency < 4000, `${latency} ms`);
  assert.deepEqual(ofKind(tap, "rows")[1].data, pageOf(b.events, { afterSeq: 2 }));
  tap.close();

  // 对照：watcher 抛的不是文件系统的错（代码的错）——不悄悄退回轮询。响应头刚发出这条流就被断开：
  // 客户端要么读到连接重置、要么读到一条没有任何帧就结束的流，不会有一条"看起来还在"的流。
  const w2 = await startedWorld(t, [["run_bug", liveHead("run_bug").events]], {
    config: { createWorkerStreamsFn: (input) => stream.createWorkerStreams({ ...input, io: { watch: () => { throw new TypeError("watcher has no .on"); } } }) },
  });
  const cut = await openStream(w2, { runId: "run_bug", afterSeq: 2 }).catch((error) => error);
  if (!(cut instanceof Error)) {
    await withTimeout(cut.waitFor(() => cut.ended, 2000), 2000, "the stream is cut, not degraded");
    assert.equal(cut.frames.length, 0, "no frame came down a stream that was cut at once");
  } else {
    assert.equal(cut.code, "ECONNRESET", "the connection was reset before any frame");
  }
});

test("E5 写入终态事件：先把剩下的行发完，等一个兜底周期（这时还没有 end），对账后发 end 并关闭这条流；之后再追加也不再有帧", async (t) => {
  const b = liveHead("run_end");
  const w = await startedWorld(t, [["run_end", b.events]]);
  const tap = await openStream(w, { runId: "run_end", afterSeq: 2 });
  assert.equal(await tap.first("rows"), true, "the first frame arrived");
  b.add("run.event", message("last words"));
  w.append("run_end", [b.last()]);
  await tap.next("rows", 1, 3000);
  finish(b);
  const at = Date.now();
  w.append("run_end", b.events.slice(3));
  assert.notEqual(await tap.next("rows", 1, 3000), null, "剩下的行在收尾之前先发完");
  assert.deepEqual(tap.events, ["rows", "rows", "rows"], "终态之后先等一个兜底周期，end 还没发");
  const rows = ofKind(tap, "rows")[2];
  assert.deepEqual(rows.data, pageOf(b.events, { afterSeq: 3 }), "最后一批行 = 终态之后的那一页");
  assert.deepEqual(seqsOf(rows), [5], "run.completed 不上时间线，状态变化那一行在");
  assert.equal(rows.data.terminal, true);
  assert.notEqual(await tap.waitFor((list) => list.some((frame) => frame.event === "end"), 6000), null, "end after the settle period");
  assert.ok(Date.now() - at >= 800, `end waits for the settle period (${Date.now() - at} ms)`);
  assert.deepEqual(tap.events, ["rows", "rows", "rows", "end"], "剩下的行都在 end 之前");
  assert.deepEqual(ofKind(tap, "end")[0].data, { runId: "run_end", state: "completed", terminal: true, total: 5 });
  assert.equal(ofKind(tap, "end")[0].id, rows.id);
  await withTimeout(tap.waitFor(() => tap.ended, 3000), 3000, "the stream closes after end");
  const count = tap.frames.length;
  w.append("run_end", [eventOf("run_end", 6, "run.decision", { decision: "accepted", reason: "ok" }, { tsMs: T0 + 60_000 })]);
  await sleep(300);
  assert.equal(tap.frames.length, count, "终态之后不再有帧");
});

test("E5c 终态事件先落盘、紧跟它的状态变化那一行晚一点才落盘：流不急着收尾——那一行也送出去，end 带的事件总数两条都算上", async (t) => {
  const b = liveHead("run_late");
  // 收尾等待放宽到 3 秒：这台机器卡顿时，第二行也一定落在收尾之前（生产值 1 秒的行为由 U6b / E5 钉着）。
  const w = await startedWorld(t, [["run_late", b.events]], {
    config: { createWorkerStreamsFn: (input) => stream.createWorkerStreams({ ...input, limits: { endSettleMs: 3000 } }) },
  });
  const tap = await openStream(w, { runId: "run_late", afterSeq: 2 });
  assert.equal(await tap.first("rows"), true, "the first frame arrived");
  b.add("run.error", { phase: "wait", error: "upstream 429" });
  w.append("run_late", [b.last()]); // run.error 本身就算终态
  assert.notEqual(await tap.next("rows", 1, 3000), null, "错误行先送到");
  assert.deepEqual(seqsOf(ofKind(tap, "rows")[1]), [3]);
  await sleep(300);
  b.add("run.state_change", { from: "running", to: "failed", reason: "backend_error" });
  w.append("run_late", [b.last()]);
  assert.notEqual(await tap.next("rows", 1, 3000), null, "状态那一行在收尾之前送到");
  assert.notEqual(await tap.waitFor((list) => list.some((frame) => frame.event === "end"), 9000), null, "end after the settle period");
  assert.deepEqual(tap.events, ["rows", "rows", "rows", "end"]);
  assert.deepEqual(seqsOf(ofKind(tap, "rows")[2]), [4], "写在终态事件之后的那一行没有被漏在流外");
  assert.deepEqual(ofKind(tap, "end")[0].data, { runId: "run_late", state: "failed", terminal: true, total: 4 });
  assert.equal(tap.ended, true);
});

test("E5b 开流时转录已经终态：排空 → 等一个兜底周期 → 对账 → end，end 带运行自己的事件总数", async (t) => {
  const b = finish(liveHead("run_done"));
  b.add("run.decision", { decision: "accepted", reason: "ok" }); // 终态之后仍有记账事件（不上时间线）
  const w = await startedWorld(t, [["run_done", b.events]]);
  const tap = await openStream(w, { runId: "run_done", afterSeq: 2 });
  assert.notEqual(await tap.waitFor((list) => list.some((frame) => frame.event === "end"), 6000), null, "end after the settle period");
  assert.deepEqual(tap.events, ["rows", "end"]);
  assert.deepEqual(ofKind(tap, "rows")[0].data, pageOf(b.events, { afterSeq: 2 }));
  assert.deepEqual(ofKind(tap, "end")[0].data, { runId: "run_done", state: "completed", terminal: true, total: b.events.length });
  assert.equal(tap.ended, true);
});

test("E6 带 3 条打开的流调 close()：1 秒内完成，3 条流都断开，端口释放", async (t) => {
  const w = await startedWorld(t, ["run_a", "run_b", "run_c"].map((runId) => [runId, liveHead(runId).events]));
  const taps = [];
  for (const runId of ["run_a", "run_b", "run_c"]) {
    const tap = await openStream(w, { runId, afterSeq: 2 });
    assert.equal(await tap.first("rows"), true, "the first frame arrived");
    assert.equal(tap.ended, false);
    taps.push(tap);
  }
  const at = Date.now();
  await withTimeout(w.server.close(), 1000, "close() with 3 open streams");
  const closeMs = Date.now() - at;
  assert.ok(closeMs < 1000, `close() took ${closeMs} ms`);
  // 服务端已经把三条连接都断了；客户端要到下一个 tick 才读到连接结束。
  await withTimeout(Promise.all(taps.map((tap) => tap.waitFor(() => tap.ended, 3000))), 3000, "every stream ends");
  assert.ok(taps.every((tap) => tap.ended), "每条流都断了");
  assert.equal(w.server.server.listening, false, "server 关了");
  await assert.rejects(httpJson(w, "/health"), "端口不再应答");
});

test("E7 无令牌 401、错令牌 401；参数错 400（多余键、重复键、缺 runId、afterSeq / cursor / filter 形状不对）——都是固定错误体", async (t) => {
  const w = await startedWorld(t, [["run_live", liveHead("run_live").events]]);
  const route = "/api/worker/stream?runId=run_live";
  for (const got of [await httpJson(w, route, { token: null }), await httpJson(w, route, { token: "0".repeat(64) })]) {
    assert.deepEqual([got.status, got.body], [401, { error: "unauthorized" }]);
    assert.equal(got.headers["cache-control"], "no-store");
  }
  const bad = [
    "/api/worker/stream", "/api/worker/stream?runId=", `${route}&x=1`, `${route}&runId=run_live`, `${route}&cursor=abc&cursor=abc`,
    `${route}&afterSeq=-1`, `${route}&afterSeq=01`, `${route}&afterSeq=1000000000`,
    `${route}&cursor=${encodeURIComponent("a b")}`, `${route}&cursor=${"%zz"}`, `${route}&cursor=${"a".repeat(200)}`,
    `${route}&filter=nope`, `${route}&filter=ALL`, `${route}&limit=5`, `${route}&beforeSeq=3`,
  ];
  for (const path of bad) {
    const got = await httpJson(w, path);
    assert.deepEqual([got.status, got.body], [400, { error: "bad_request" }], path);
    assert.equal(got.headers["cache-control"], "no-store");
  }
  // 形状对的请求进流：200。
  const ok = await openStream(w, { runId: "run_live", afterSeq: 0, filter: "commands" });
  assert.equal(ok.status, 200);
  ok.close();
});

test("E8 带游标续传：断开期间追加的行一条不少，断开前已收到的行一条不重发；同时带 afterSeq（轮询已经追平）时不重发", async (t) => {
  const b = liveHead("run_resume");
  const w = await startedWorld(t, [["run_resume", b.events]]);
  const first = await openStream(w, { runId: "run_resume", afterSeq: 2 });
  assert.equal(await first.first("rows"), true, "the first frame arrived");
  b.add("run.event", message("seen before the drop"));
  w.append("run_resume", [b.last()]);
  await first.next("rows", 1, 3000);
  const cursor = ofKind(first, "rows").at(-1).id;
  first.close();
  await withTimeout(first.waitFor(() => first.ended, 3000), 3000, "the old stream closes");

  b.add("run.event", message("appended while away"));
  w.append("run_resume", [b.last()]);
  const second = await openStream(w, { runId: "run_resume", cursor });
  assert.equal(second.status, 200);
  assert.equal(await second.first("rows"), true, "the first frame arrived");
  assert.deepEqual(second.events, ["rows"], "续上：没有 reset");
  assert.deepEqual(second.frames[0].data, pageOf(b.events, { afterSeq: 3 }), "只给游标之后的行");
  assert.deepEqual(seqsOf(second.frames[0]), [4]);
  second.close();

  // 断开期间页面靠轮询追到了 4：带着游标（停在 3）和 afterSeq=4 重连，不重发第 4 条。
  b.add("run.event", message("newer still"));
  w.append("run_resume", [b.last()]);
  const third = await openStream(w, { runId: "run_resume", cursor, afterSeq: 4 });
  assert.equal(await third.first("rows"), true, "the first frame arrived");
  assert.deepEqual(third.events, ["rows"]);
  assert.deepEqual(seqsOf(third.frames[0]), [5]);
  third.close();
});

/** 对整份文件从最新一页往回翻 count 页，按时间顺序排好（每页的 updates 摘空，与 rows 帧同形）。 */
function pagesBack(events, runId, { afterSeq, count }) {
  const back = [];
  let before;
  for (let page = 0; page < count; page += 1) {
    const body = projectWorkerActivity({ runId, events, env: {}, afterSeq, ...(before === undefined ? {} : { beforeSeq: before }) });
    assert.deepEqual(body.updates, []);
    const { updates, ...rest } = body;
    back.unshift({ ...rest, updates: [] });
    before = rest.range.fromSeq;
  }
  return back;
}

test("E9 一次追加 450 条：全部按时间顺序送到、不重不漏，每帧不超过 limit 个单位，拼起来与整份往回翻页的各页相同", async (t) => {
  const b = liveHead("run_burst");
  const w = await startedWorld(t, [["run_burst", b.events]]);
  const tap = await openStream(w, { runId: "run_burst", afterSeq: 2 });
  assert.equal(await tap.first("rows"), true, "the first frame arrived");
  const fresh = [];
  for (let i = 0; i < 450; i += 1) {
    b.add("run.event", message(`burst ${i + 1}`));
    fresh.push(b.last());
  }
  // 一次追加在磁盘上不是原子的：watcher 可能在写到一半时就被唤醒。所以帧怎么切不看，只看不变量。
  w.append("run_burst", fresh);
  const deliveredRows = (list) => ofKind({ frames: list }, "rows").slice(1).reduce((sum, frame) => sum + frame.data.rows.length, 0);
  assert.notEqual(await tap.waitFor((list) => deliveredRows(list) >= 450, 4000), null, "450 条都到");
  const frames = ofKind(tap, "rows").slice(1);
  assert.ok(frames.length >= 3, `${frames.length} 帧`);
  assert.deepEqual(tap.events.filter((event) => event !== "rows"), [], "只有 rows 帧");
  const delivered = [];
  for (const frame of frames) {
    assert.ok(frame.data.rows.length >= 1 && frame.data.rows.length <= stream.OWNER_STREAM_LIMIT, `一帧 ${frame.data.rows.length} 行`);
    assert.deepEqual(frame.data.updates, []);
    delivered.push(...frame.data.rows);
  }
  assert.deepEqual(delivered.map((row) => row.seq), Array.from({ length: 450 }, (_, i) => i + 3), "按时间顺序，不重不漏");
  assert.deepEqual(delivered, pagesBack(b.events, "run_burst", { afterSeq: 2, count: 3 }).flatMap((page) => page.rows), "拼起来 = 往回翻页的各页");
  tap.close();
});

test("E9b 一批 450 条一次性换进来（新文件改名覆盖，内容 = 已发出的前缀 + 450 条）：对账接上，按时间顺序分成 50 + 200 + 200 三帧，逐帧等于往回翻页的各页", async (t) => {
  const b = liveHead("run_swap_burst");
  const w = await startedWorld(t, [["run_swap_burst", b.events]]);
  const tap = await openStream(w, { runId: "run_swap_burst", afterSeq: 2 });
  assert.equal(await tap.first("rows"), true, "the first frame arrived");
  for (let i = 0; i < 450; i += 1) b.add("run.event", message(`burst ${i + 1}`));
  writeFileSync(join(w.base, "burst.jsonl"), toBytes(b.events));
  renameSync(join(w.base, "burst.jsonl"), w.fileOf("run_swap_burst"));
  assert.notEqual(await tap.next("rows", 3, 4000), null, "三帧都到");
  assert.deepEqual(tap.events, ["rows", "rows", "rows", "rows"], "没有 reset：已发出的部分仍是它的前缀");
  const frames = ofKind(tap, "rows").slice(1);
  // 往回翻是从最新一页翻起的：最新两页是满页，最老的一页是剩下的 50 条。
  assert.deepEqual(frames.map((frame) => frame.data.rows.length), [50, 200, 200]);
  assert.deepEqual(frames.map((frame) => frame.data.range), [{ fromSeq: 3, toSeq: 52 }, { fromSeq: 53, toSeq: 252 }, { fromSeq: 253, toSeq: 452 }]);
  assert.deepEqual(frames.map((frame) => frame.data), pagesBack(b.events, "run_swap_burst", { afterSeq: 2, count: 3 }), "分帧送完 = 往回翻页的各页，按时间顺序");
  // 偏移跟着新文件走：之后的追加照常增量读到。
  b.add("run.event", message("after the swap"));
  w.append("run_swap_burst", [b.last()]);
  assert.notEqual(await tap.next("rows", 1, 3000), null);
  assert.deepEqual(seqsOf(ofKind(tap, "rows").at(-1)), [453]);
  tap.close();
});

test("E10 连接总数到上限：多出来的流回 503，固定错误体；断开一条之后又能接", async (t) => {
  const w = await startedWorld(t, [["run_cap", liveHead("run_cap").events]]);
  const taps = [];
  for (let i = 0; i < stream.OWNER_STREAM_CONNECTIONS_MAX; i += 1) {
    const tap = await openStream(w, { runId: "run_cap", afterSeq: 2 });
    assert.equal(tap.status, 200, `stream ${i + 1}`);
    taps.push(tap);
  }
  const refused = await httpJson(w, "/api/worker/stream?runId=run_cap", { headers: { accept: "text/event-stream" } });
  assert.deepEqual([refused.status, refused.body], [503, { error: "unavailable" }]);
  assert.equal(refused.headers["cache-control"], "no-store");
  taps[0].close();
  await withTimeout(taps[0].waitFor(() => taps[0].ended, 3000), 3000, "the first stream closes");
  const again = await openStream(w, { runId: "run_cap", afterSeq: 2 });
  assert.equal(again.status, 200);
  again.close();
  // 别的接口照常。
  assert.equal((await httpJson(w, "/api/worker/activity?runId=run_cap")).status, 200);
});

// =====================================================================
// R) 夹具回放
// =====================================================================

test("R1 两份转录夹具：整份文件按随机块追加进临时文件，经真实服务端流读取；rows / update 拼起来的表与整份往回翻页的表逐一相同", async () => {
  assert.equal(TRANSCRIPT_FIXTURES.length, 2);
  for (const [index, source] of TRANSCRIPT_FIXTURES.entries()) {
    for (const filter of ["all", "messages", "commands", "errors"]) {
      const result = await replayTranscript(source, { seed: 144 + index, filter });
      assert.equal(result.ok, true, `${filter}: ${JSON.stringify(result)}`);
      assert.equal(result.frames.reset, 0, `${filter}: 没有 reset`);
      assert.equal(result.frames.end, 1, `${filter}: 以 end 收尾`);
      assert.equal(result.terminal, true);
      assert.equal(result.streamRows, result.referenceRows);
      assert.ok(result.streamRows > 0, `${filter}: 时间线上有行`);
      assert.ok(result.chunks >= 10, `按随机块追加：${result.chunks} 块`);
    }
  }
});

/** 一份合成转录（本文件现造，不是夹具）：折叠、缺口、时间线之外的事件、命令与结果、失败收尾，共约 430 条。
 *  形态照真实转录：运行中途的重试用运行时活动状态表示；run.error 一出现就是终态事实（状态判定如此，
 *  写入点也都是失败路径），所以它只在收尾处、紧跟 running → failed 那一行。 */
function syntheticTranscript(runId = "run_synthetic") {
  const b = commandHead(runId);
  for (let round = 0; round < 24; round += 1) {
    b.add("run.event", message(`第 ${round + 1} 轮：先说要做什么\n第二行\n第三行`));
    b.add("run.event", { kind: "tool_use", tool: "Read", input: { file_path: `src/round-${round + 1}.js` }, toolCallId: `t${round}` });
    b.add("run.event", { kind: "command", command: `npm run check -- ${round + 1}`, toolCallId: `c${round}` });
    b.add("run.event", { kind: "tool_result", tool: `c${round}`, output: Array.from({ length: 30 }, (_, i) => `out ${i + 1}`).join("\n"), isError: round % 5 === 4 });
    for (let i = 0; i < 12; i += 1) {
      b.add("run.event", { kind: "runtime_activity", status: i % 3 === 2 ? "provider_retry" : i % 2 === 0 ? "streaming" : "process_active" });
    }
    b.add("prompt.sent", { prompt: "# hidden\nnot on the timeline" }); // 不上时间线的事件
    b.add("run.event", { kind: "file_written", path: `src/gen/round-${round + 1}.js` });
    if (round % 6 === 5) b.skip(3); // 真缺口
  }
  b.add("run.error", { phase: "wait", error: "upstream 429, giving up after 24 rounds" });
  b.add("run.state_change", { from: "running", to: "failed", reason: "backend_error" });
  return toBytes(b.events);
}

test("R2 合成转录（折叠 / 缺口 / 不上时间线的事件 / 命令与结果 / 终态）：四个筛选各回放一遍，流交付的表与整份翻页的表逐一相同，update 帧真的出现过", async () => {
  const source = syntheticTranscript();
  assert.ok(eventsOfBytes(source).length > 400, `${eventsOfBytes(source).length} events`);
  for (const filter of ["all", "commands", "errors", "messages"]) {
    const result = await replayTranscript(source, { seed: 7, filter });
    assert.equal(result.ok, true, `${filter}: ${JSON.stringify(result)}`);
    assert.equal(result.frames.reset, 0, `${filter}: 没有 reset`);
    assert.equal(result.frames.end, 1, `${filter}: 以 end 收尾`);
    assert.equal(result.streamRows, result.referenceRows);
    if (filter === "all") assert.ok(result.frames.update > 0, `命令行补退出码的 update 帧：${result.frames.update}`);
    if (filter === "messages") assert.equal(result.frames.update, 0, "消息筛选下没有 update");
  }
});

test("R3 拼装与比对是可复用的导出函数：同一份输入、同一个种子给同一份切法；第一处不同如实指出下标与两边的行", () => {
  const plan = chunkPlan(10_000, { seed: 3, min: 1, max: 400 });
  assert.deepEqual(plan, chunkPlan(10_000, { seed: 3, min: 1, max: 400 }), "同种子同切法");
  assert.notDeepEqual(plan, chunkPlan(10_000, { seed: 4, min: 1, max: 400 }), "不同种子不同切法");
  assert.equal(plan.reduce((sum, n) => sum + n, 0), 10_000, "总和恰为文件大小");
  assert.ok(plan.every((n) => n >= 1 && n <= 400), "每块都在上下限内");
  assert.deepEqual(chunkPlan(0), []);
  assert.throws(() => chunkPlan(10, { min: 5, max: 2 }), RangeError);
  assert.deepEqual(firstDifference([1, 2, 3], [1, 2, 3]), null);
  assert.deepEqual(firstDifference([1, 2, 3], [1, 9, 3]), { at: 1, left: 2, right: 9 });
  assert.deepEqual(firstDifference([1], [1, 2]), { at: 1, left: undefined, right: 2 });
  assert.equal(describeRow(undefined), "<none>");
});
