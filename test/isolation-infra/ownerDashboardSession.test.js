// test/isolation-infra/ownerDashboardSession.test.js
//
// 第 145b 批（决定 0131 第 2 条）：一次性启动码 → 会话令牌 的服务端契约。
//
//   - GET /api/session：码在 Authorization 头（不进查询串——有查询参数一律 400）；
//     缺头/形状不对直接 401 且不碰文件系统（之后同一码仍可兑换成功）；
//   - 严格 Host（127.0.0.1:<实际端口>）与 Sec-Fetch-Site（有就只认 same-origin）；
//   - 兑换只查一个文件；存在、未过期（60s）、删除成功才发会话；并发兑换只有一个赢家；
//     过期/未知/二次兑换一律固定 401；
//   - bearerOk 接受未过期会话（进程令牌照旧）；会话 24h 绝对过期、32 条 FIFO 淘汰；
//   - 开着的流在会话过期后的复核里 reset(revoked)。
//
// 确定性：真临时 codes 目录 + 注入时钟；无网络、无子进程。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOwnerDashboardServer } from "../../src/ownerDashboardServer.js";
import { issueStartCode } from "../../src/application/dashboardCodes.js";
import { createSessionStore } from "../../src/application/dashboardSession.js";
import * as stream from "../../src/application/ownerWorkerStream.js";
import * as api from "../../src/owner-dashboard/v2/api.js";

const PORT = 18080;
const GEN = "0123456789abcdef"; // 本测试里"本实例"的代际
const HOST = `127.0.0.1:${PORT}`;
let clock = 2_000_000_000_000; // 一只可拨的钟（每个用例自己重置）

function makeServer(extra = {}) {
  clock = 2_000_000_000_000;
  return createOwnerDashboardServer({
    runDir: "/server/owned/runs",
    env: {},
    port: PORT,
    nowFn: () => clock,
    createReadModelFn: () => ({ refresh: async () => {}, snapshot: () => ({ generatedAt: "", projects: [], runs: [], consults: [] }) }),
    createWorkerStreamsFn: () => ({ full: () => false, open: async () => ({ ok: true }), closeAll: () => {} }),
    ...extra,
  });
}

function drive(handler, { method = "GET", url = "/", headers = {} } = {}) {
  const req = { method, url, headers: { ...headers } };
  const state = { statusCode: 200, headers: {}, body: "", ended: false };
  const res = {
    setHeader(k, v) { state.headers[String(k).toLowerCase()] = v; },
    writeHead(status) { state.statusCode = status; },
    write(c) { state.body += typeof c === "string" ? c : Buffer.from(c).toString("utf8"); },
    end(c) { if (c !== undefined) this.write(c); state.ended = true; },
  };
  return Promise.resolve(handler(req, res)).then(() => ({ status: state.statusCode, headers: state.headers, body: state.body }));
}
const jsonOf = (r) => JSON.parse(r.body);

function codesDir() {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-sess-"));
  return [dir, () => rmSync(dir, { recursive: true, force: true })];
}

const redeem = (s, code, extraHeaders = {}) => drive(s.handler, {
  url: "/api/session",
  headers: { host: HOST, authorization: `Bearer ${code}`, ...extraHeaders },
});

test("no Authorization header -> fixed 401 and the file system is never touched", async (t) => {
  const [dir, done] = codesDir();
  t.after(done);
  const s = makeServer({ codesDir: dir, generation: GEN });
  t.after(() => s.close());
  const { code } = issueStartCode(dir, GEN, { now: () => clock });
  const r = await drive(s.handler, { url: "/api/session", headers: { host: HOST } });
  assert.deepEqual([r.status, jsonOf(r)], [401, { error: "unauthorized" }]);
  // 文件系统没被动过：同一个码随后仍然兑换成功。
  const ok = await redeem(s, code);
  assert.equal(ok.status, 200, "the code was not consumed by the headerless request");
});

test("a malformed code (non-hex / bad scheme / empty) -> 401 without touching the codes dir", async (t) => {
  const [dir, done] = codesDir();
  t.after(done);
  const s = makeServer({ codesDir: dir, generation: GEN });
  t.after(() => s.close());
  const { code } = issueStartCode(dir, GEN, { now: () => clock });
  for (const headers of [
    { authorization: "Bearer not-hex" },
    { authorization: "Bearer NOTHEX0123456789" },
    { authorization: "bearer " + code },
    { authorization: "Bearer" },
    { authorization: `Bearer ${code} extra` },
    { authorization: "" },
  ]) {
    const r = await drive(s.handler, { url: "/api/session", headers: { host: HOST, ...headers } });
    assert.deepEqual([r.status, jsonOf(r)], [401, { error: "unauthorized" }], JSON.stringify(headers));
  }
  assert.equal((await redeem(s, code)).status, 200, "no malformed request consumed the code");
});

test("any query parameter at all is the fixed 400 (the code never rides a query string)", async (t) => {
  const [dir, done] = codesDir();
  t.after(done);
  const s = makeServer({ codesDir: dir, generation: GEN });
  t.after(() => s.close());
  const { code } = issueStartCode(dir, GEN, { now: () => clock });
  for (const url of ["/api/session?code=x", "/api/session?x=1", "/api/session?"]) {
    const r = await drive(s.handler, { url, headers: { host: HOST, authorization: `Bearer ${code}` } });
    assert.deepEqual([r.status, jsonOf(r)], [400, { error: "bad_request" }], url);
  }
});

test("strict Host: anything but 127.0.0.1:<this port> is the fixed 401", async (t) => {
  const [dir, done] = codesDir();
  t.after(done);
  const s = makeServer({ codesDir: dir, generation: GEN });
  t.after(() => s.close());
  const { code } = issueStartCode(dir, GEN, { now: () => clock });
  for (const host of [`localhost:${PORT}`, "127.0.0.1:9999", "127.0.0.2:" + PORT, "[::1]:" + PORT, undefined, ""]) {
    const headers = { authorization: `Bearer ${code}` };
    if (host !== undefined) headers.host = host;
    const r = await drive(s.handler, { url: "/api/session", headers });
    assert.equal(r.status, 401, `host ${String(host)} -> 401`);
    assert.deepEqual(jsonOf(r), { error: "unauthorized" });
  }
  // 对的 Host 兑换成功（码没有被上面的请求消耗：它们都在碰文件之前被拒）。
  assert.equal((await redeem(s, code)).status, 200);
});

test("Sec-Fetch-Site: absent or same-origin passes; anything else is refused", async (t) => {
  const [dir, done] = codesDir();
  t.after(done);
  const s = makeServer({ codesDir: dir, generation: GEN });
  t.after(() => s.close());
  const sameOrigin = issueStartCode(dir, GEN, { now: () => clock });
  const absent = issueStartCode(dir, GEN, { now: () => clock });
  const cross = issueStartCode(dir, GEN, { now: () => clock });
  assert.equal((await redeem(s, sameOrigin.code, { "sec-fetch-site": "same-origin" })).status, 200);
  assert.equal((await redeem(s, absent.code)).status, 200);
  const refused = await redeem(s, cross.code, { "sec-fetch-site": "cross-site" });
  assert.deepEqual([refused.status, jsonOf(refused)], [401, { error: "unauthorized" }]);
  // same-origin 之后同一个码还有效吗：被拒的那次没有碰文件——码换手成功。
  assert.equal((await redeem(s, cross.code)).status, 200, "the refused request never reached the codes dir");
});

test("redemption: unknown code, expired code and a second use are all the fixed 401", async (t) => {
  const [dir, done] = codesDir();
  t.after(done);
  const s = makeServer({ codesDir: dir, generation: GEN });
  t.after(() => s.close());
  assert.equal((await redeem(s, "ab".repeat(32))).status, 401, "unknown code");
  const stale = issueStartCode(dir, GEN, { now: () => clock - 120_000 }); // 2 分钟前签发：已过期
  assert.equal((await redeem(s, stale.code)).status, 401, "expired code");
  const fresh = issueStartCode(dir, GEN, { now: () => clock });
  const first = await redeem(s, fresh.code);
  assert.equal(first.status, 200);
  assert.equal((await redeem(s, fresh.code)).status, 401, "one-time: the file is gone");
  // 快到期的边界：59 秒前签发仍可兑换。
  const edge = issueStartCode(dir, GEN, { now: () => clock - 59_000 });
  assert.equal((await redeem(s, edge.code)).status, 200);
});

test("redemption: concurrent requests have exactly one winner", async (t) => {
  const [dir, done] = codesDir();
  t.after(done);
  const s = makeServer({ codesDir: dir, generation: GEN });
  t.after(() => s.close());
  const { code } = issueStartCode(dir, GEN, { now: () => clock });
  const results = await Promise.all(Array.from({ length: 8 }, () => redeem(s, code)));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 401).length, 7);
});

test("no codesDir configured (foreground / tests) -> always the fixed 401", async (t) => {
  const [dir, done] = codesDir();
  t.after(done);
  const s = makeServer();
  t.after(() => s.close());
  const { code } = issueStartCode(dir, GEN, { now: () => clock });
  assert.equal((await redeem(s, code)).status, 401);
});

test("the issued session token works as a bearer; the process token still works", async (t) => {
  const [dir, done] = codesDir();
  t.after(done);
  const s = makeServer({ codesDir: dir, generation: GEN });
  t.after(() => s.close());
  const { code } = issueStartCode(dir, GEN, { now: () => clock });
  const r = await redeem(s, code);
  const body = jsonOf(r);
  assert.match(body.token, /^[0-9a-f]{64}$/, "the session token is 64 lowercase hex");
  assert.equal(body.expiresAt, clock + 24 * 60 * 60_000, "absolute expiry");
  const withSession = await drive(s.handler, { url: "/api/overview", headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(withSession.status, 200, "a session token authorizes the data routes");
  const withProcess = await drive(s.handler, { url: "/api/overview", headers: { authorization: `Bearer ${s.token}` } });
  assert.equal(withProcess.status, 200, "the process token keeps working");
  const withNothing = await drive(s.handler, { url: "/api/overview", headers: {} });
  assert.equal(withNothing.status, 401);
});

test("a session dies at its own deadline; later sessions survive", async (t) => {
  const [dir, done] = codesDir();
  t.after(done);
  const s = makeServer({ codesDir: dir, generation: GEN });
  t.after(() => s.close());
  const first = jsonOf(await redeem(s, issueStartCode(dir, GEN, { now: () => clock }).code));
  clock += 24 * 60 * 60_000 - 1;
  assert.equal((await drive(s.handler, { url: "/api/overview", headers: { authorization: `Bearer ${first.token}` } })).status, 200);
  clock += 1;
  assert.equal((await drive(s.handler, { url: "/api/overview", headers: { authorization: `Bearer ${first.token}` } })).status, 401, "expired at the absolute deadline");
  const second = jsonOf(await redeem(s, issueStartCode(dir, GEN, { now: () => clock }).code));
  assert.equal((await drive(s.handler, { url: "/api/overview", headers: { authorization: `Bearer ${second.token}` } })).status, 200);
});

test("the session cap evicts in issuance order", async (t) => {
  const [dir, done] = codesDir();
  t.after(done);
  const s = makeServer({ codesDir: dir, generation: GEN, sessionMax: 3 });
  t.after(() => s.close());
  const tokens = [];
  for (let i = 0; i < 4; i += 1) {
    const body = jsonOf(await redeem(s, issueStartCode(dir, GEN, { now: () => clock }).code));
    tokens.push(body.token);
  }
  const statusOf = (token) => drive(s.handler, { url: "/api/overview", headers: { authorization: `Bearer ${token}` } });
  assert.equal((await statusOf(tokens[0])).status, 401, "the oldest was evicted");
  for (const token of tokens.slice(1)) assert.equal((await statusOf(token)).status, 200);
});


// ===== 流：会话过期 → reset(revoked) —— 走真实路由（修正一 #13） =====
// createOwnerDashboardServer → 真实 /api/worker/stream（真实 hub、真实 SSE 响应、
// 真转录文件），不再在测试里另抄一份 authorize。会话过期由注入的时钟驱动（服务的
// nowFn 同时也是流 hub 的时钟——145b 修正一绑定）。

import { writeFileSync, mkdirSync, mkdtempSync as mkdtempSync2, rmSync as rmSync2, readFileSync as readFileSync2 } from "node:fs";

function tempWorld() {
  const base = mkdtempSync2(join(tmpdir(), "wao-dash-sess-route-"));
  const codesDir = join(base, "codes");
  mkdirSync(codesDir, { recursive: true });
  const transcript = join(base, "run_x.jsonl");
  writeFileSync(transcript, [
    JSON.stringify({ type: "run.started", runId: "run_x", seq: 1, ts: "2026-11-26T09:00:01.000Z" }),
    JSON.stringify({ type: "run.state_change", runId: "run_x", seq: 2, ts: "2026-11-26T09:00:02.000Z", from: "pending", to: "running", reason: "first_event" }),
    "",
  ].join("" + String.fromCharCode(10)), "utf8");
  const bytes = readFileSync2(transcript);
  return {
    base, codesDir, transcript, bytes,
    cleanup: () => rmSync2(base, { recursive: true, force: true }),
  };
}

/** 一条 availability=ok 的运行行（snapshot 里的形状；时间都相对注入的钟）。 */
function runRow(at) {
  return {
    runId: "run_x",
    project: null,
    availability: "ok",
    state: "running",
    terminal: false,
    liveness: "progress",
    stage: "active",
    agentId: "glm-pro",
    laneId: "glm-pro",
    roleId: "coder",
    readOnly: false,
    deliveryRequested: false,
    title: "run_x",
    titleBasis: "first_line",
    taskType: "code",
    typeBasis: "persisted",
    startedAt: new Date(at - 60_000).toISOString(),
    terminalAt: null,
    stageSince: new Date(at - 60_000).toISOString(),
    lastEffectAt: new Date(at - 60_000).toISOString(),
    quietSince: new Date(at - 60_000).toISOString(),
    lastVitalAt: new Date(at - 30_000).toISOString(),
    delivery: null,
    failure: null,
    consultGroupId: null,
    consultSeats: null,
  };
}

test("REAL ROUTE: an open stream resets (revoked) once its session token expires; the process token never does", async (t) => {
  const world = tempWorld();
  t.after(world.cleanup);
  let clock = Date.now(); // 从真实时钟起步（兑换的 mtime 判定要一致），由测试拨动
  const server = createOwnerDashboardServer({
    runDir: world.base,
    env: {},
    port: 0,
    sessionTtlMs: 400,
    codesDir: world.codesDir,
    generation: GEN,
    nowFn: () => clock,
    createReadModelFn: () => ({
      refresh: async () => {},
      snapshot: () => ({
        generatedAt: new Date(clock).toISOString(),
        projects: [],
        runs: [runRow(clock)],
        consults: [],
      }),
      locateRunTranscript: async () => ({ path: world.transcript, bytes: world.bytes }),
    }),
  });
  t.after(() => server.close());
  const addr = await server.listen();

  // 兑换一张会话令牌（真路由：签码 → /api/session）。
  const { code } = issueStartCode(world.codesDir, GEN, { now: () => clock });
  const exchanged = await fetch(`http://127.0.0.1:${addr.port}/api/session`, {
    headers: { host: `127.0.0.1:${addr.port}`, authorization: `Bearer ${code}` },
  });
  assert.equal(exchanged.status, 200);
  const session = await exchanged.json();
  assert.match(session.token, /^[0-9a-f]{64}$/);

  /** 打开一条流并读帧（真实 SSE 响应），直到谓词命中或预算耗尽。 */
  async function openStream(token) {
    const response = await fetch(`http://127.0.0.1:${addr.port}/api/worker/stream?runId=run_x`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = api.createSseParser();
    const frames = [];
    const readUntil = async (predicate, budgetMs) => {
      const deadline = Date.now() + budgetMs;
      for (;;) {
        const hit = frames.find(predicate);
        if (hit !== undefined) return hit;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        const outcome = await Promise.race([
          reader.read().then((r) => r, () => ({ done: true })),
          new Promise((r) => setTimeout(() => r(null), remaining)),
        ]);
        if (outcome === null) continue; // 预算未尽，继续等
        if (outcome.done) return null;
        for (const frame of parser.push(decoder.decode(outcome.value, { stream: true }))) frames.push(frame);
      }
    };
    return { readUntil };
  }

  const sessionStream = await openStream(session.token);
  const first = await sessionStream.readUntil((f) => f.event === "rows", 5000);
  assert.notEqual(first, null, "rows arrived while the session was live");

  // 拨过会话期限【和】流的复核间隔（authMs=5s）；等一个轮询周期（真实 1s）触发复核。
  clock += 6000;
  const resetFrame = await sessionStream.readUntil((f) => f.event === "reset", 5000);
  assert.notEqual(resetFrame, null, "the re-authorization ran through the REAL route");
  assert.equal(JSON.parse(resetFrame.data).reason, "revoked", "the expired session resets the stream");

  // 进程令牌的流在同样的时钟推进后照常活着。
  const processStream = await openStream(server.token);
  const rows = await processStream.readUntil((f) => f.event === "rows", 5000);
  assert.notEqual(rows, null, "the process token streams fine");
  clock += 60_000;
  const late = await processStream.readUntil((f) => f.event === "reset", 2500);
  assert.equal(late, null, "the process token never expires");
});

// ===== 145b 修正二：码绑定代际 + 流握手的真实路由守卫 =====

test("a code issued for ANOTHER generation is the fixed 401 through the route — no claim is left, the issuing generation can still redeem it", async (t) => {
  const [dir, done] = codesDir();
  t.after(done);
  const OTHER = "fedcba9876543210";
  const s = makeServer({ codesDir: dir, generation: GEN });
  t.after(() => s.close());
  const old = issueStartCode(dir, OTHER, { now: () => clock }); // 上一代签发、还没用掉的码
  const before = readdirSync(dir).sort();
  const refused = await redeem(s, old.code);
  assert.deepEqual([refused.status, jsonOf(refused)], [401, { error: "unauthorized" }]);
  assert.deepEqual(readdirSync(dir).sort(), before, "treated exactly like an unknown code: nothing written, nothing consumed");
  // 这一代自己签发的码照常兑换；别代的码此刻也还在原处，签发它的那一代仍可兑换。
  assert.equal((await redeem(s, issueStartCode(dir, GEN, { now: () => clock }).code)).status, 200);
  const sibling = makeServer({ codesDir: dir, generation: OTHER });
  t.after(() => sibling.close());
  assert.equal((await redeem(sibling, old.code)).status, 200, "the generation that issued it still redeems it");
});

test("the start-code directory needs a valid generation: codesDir without one (or with a malformed one) fails closed at construction", () => {
  const [dir, done] = codesDir();
  try {
    for (const generation of [undefined, "", "xyz", "0123456789ABCDEF", 7]) {
      assert.throws(() => makeServer({ codesDir: dir, generation }), TypeError, `generation ${String(generation)}`);
    }
  } finally {
    done();
  }
});

test("REAL ROUTE: a stream handshake WITHOUT a usable token is the fixed 401 and never reaches the stream hub", async (t) => {
  const opens = [];
  let clockNow = Date.now();
  const server = createOwnerDashboardServer({
    runDir: "/server/owned/runs",
    env: {},
    port: 0,
    nowFn: () => clockNow,
    createReadModelFn: () => ({
      refresh: async () => {},
      snapshot: () => ({ generatedAt: new Date(clockNow).toISOString(), projects: [], runs: [runRow(clockNow)], consults: [] }),
    }),
    // 流枢纽的替身只记录"谁到了这里"：到得了的就 404（与 401 区分）。
    createWorkerStreamsFn: () => ({
      full: () => false,
      open: async (input) => { opens.push(input); return { ok: false, reason: "not_found" }; },
      closeAll: () => {},
    }),
  });
  t.after(() => server.close());
  const addr = await server.listen();
  const url = `http://127.0.0.1:${addr.port}/api/worker/stream?runId=run_x`;
  const handshake = async (headers) => {
    const response = await fetch(url, { headers });
    return [response.status, await response.json()];
  };
  const unauthorized = [401, { error: "unauthorized" }];
  assert.deepEqual(await handshake({}), unauthorized, "no Authorization header at all");
  assert.deepEqual(await handshake({ authorization: "Bearer" }), unauthorized, "scheme without a token");
  assert.deepEqual(await handshake({ authorization: "Bearer " }), unauthorized, "an empty token");
  assert.deepEqual(await handshake({ authorization: "Bearer " + "0".repeat(64) }), unauthorized, "a well-formed token nobody issued");
  assert.deepEqual(await handshake({ authorization: "Basic " + server.token }), unauthorized, "the right secret under the wrong scheme");
  assert.deepEqual(opens, [], "none of those handshakes reached the hub: no stream was opened for a missing token");
  // 对照：进程令牌过了闸，到达枢纽，并且枢纽拿到的就是这条握手的令牌（之后每次复核都用它）。
  assert.deepEqual(await handshake({ authorization: `Bearer ${server.token}` }), [404, { error: "not_found" }]);
  assert.equal(opens.length, 1);
  assert.equal(opens[0].token, server.token, "the hub is handed the handshake's bearer for re-authorization");
});