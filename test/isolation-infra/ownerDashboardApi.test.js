// test/isolation-infra/ownerDashboardApi.test.js
//
// 第 140c 批（决定 0131）：看板服务接上读模型，以及三个只读接口 /api/overview、
// /api/workers、/api/attention。
//
// 驱动方式与 ownerDashboardServer.test.js 相同：直接调 handler + 假 req/res（不起端口），
// 读模型用注入的假工厂 createReadModelFn。刷新不依赖真实计时：单轮靠 refreshNow()，定时器链
// 靠 node:test 的假计时器（t.mock.timers）。
//
// 覆盖面（每条声称对应一个能证伪它的用例）：
//   - 三个接口逐请求验 bearer（无令牌 / 错令牌 401）、只许 GET、参数闭集（未知键、重复键、
//     坏 slug 400）、固定错误体、SAFE_HEADERS
//   - 刷新状态：首轮完成前 loading（200、不带数据，绝不返回 0 个运行）→ ready → 某轮失败
//     保留上一份发布并标 stale（带首次失败时刻、错误原文不出接口）→ 下一轮成功恢复 ready；
//     从未发布且最近一轮失败 → unavailable（带首次失败时刻）；失败的各种来源（refresh 同步抛 /
//     拒绝、坏时钟、snapshot 抛、推导抛）走同一条路径且链不断；时钟在每轮开始先校验——
//     不可表示的 now 不刷新、不取快照、不发布；连续失败的 staleSince 只在首个失败轮设定
//     （首轮时钟读不出就保持 null，后面的时钟不补）；鉴权与参数校验先于 loading
//   - 同一个 now：snapshot({ now }) 与事项推导用的是同一轮的同一个时刻；三个接口读同一份
//     发布，状态 / 时刻 / 计数一致
//   - DTO 白名单：行与事项只有页面要的字段（事项带 projectSlugs 与 capacityCode；Overview
//     项目行带 branchesObservedAt），快照里的敌意附加字段一个都不透传；响应里没有路径形状
//     的字符串
//   - Workers：默认范围、按 startedAt 倒序、上限 500 与 truncated、按项目筛选；跨项目事项
//     在两边都可查，attentionIds 与 /api/attention 同一筛选
//   - 刷新任务：并发的 refreshNow 只跑一轮；server 一开始监听就冷刷新（listen() 之前不碰读
//     模型），之后定时器链按间隔（缺省 5000）刷新且不重叠；close() 停掉定时器、等在途刷新
//     结束、之后不再发布/刷新（迟到的 listening、定时器回调、refreshNow 都不行）
//   - 真实 listen()：端口 0、127.0.0.1 起服务等首轮发布后 close()，读模型不再被调用；
//     listen() 后立刻 close()（listening 还没发出）也不启动链，socket 最终关掉
//   - 生命周期（真实端口）：listen() 因端口被占拒绝后 close() 立即完成；close() 幂等
//     （每次返回同一个 Promise，成功后重复调用也一样）；close() 之后 listen() 拒绝、不开端口
//   - 缺省接线：不注入时用 createOwnerReadModel({ runDir, nowFn })；非法 refreshIntervalMs
//     在构造时就拒绝
//   - 旧的 /api/runs 与 /api/activity 不受刷新状态影响

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOwnerDashboardServer } from "../../src/ownerDashboardServer.js";

// ===== 假 req/res =====

function drive(handler, { method = "GET", url = "/", headers = {} } = {}) {
  const req = { method, url, headers: { ...headers } };
  const state = { statusCode: 200, headers: {}, body: "", ended: false };
  const res = {
    setHeader(k, v) { state.headers[String(k).toLowerCase()] = v; },
    writeHead(status) { state.statusCode = status; },
    write(c) { state.body += typeof c === "string" ? c : Buffer.from(c).toString("utf8"); },
    end(c) { if (c !== undefined) this.write(c); state.ended = true; },
    getHeader(k) { return state.headers[String(k).toLowerCase()]; },
  };
  const p = handler(req, res);
  return Promise.resolve(p).then(() => ({
    status: state.statusCode, headers: state.headers, body: state.body, ended: state.ended,
  }));
}
const jsonOf = (r) => JSON.parse(r.body);
/** 让已经排队的微任务与 setImmediate 回调跑完（假计时器只接管 setTimeout）。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));
/** 模拟 server 开始监听：Node 在 listen() 成功后会发 "listening"，刷新链挂在它上面（不起端口）。 */
const startListening = (s) => s.server.emit("listening");

/** 真起端口时的一次 GET（带 bearer），返回解析后的 JSON。 */
function httpJson(s, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: s.address().port, path, method: "GET",
      headers: { authorization: "Bearer " + s.token },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** 轮询到 predicate 为真（用于等首轮发布）；超时后返回最后一次结果。 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return last;
}

/** 给 Promise 加到期失败（用于断言 close 不会永远挂起）；无论成败都清掉定时器。 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** 占用一个 127.0.0.1 的临时端口，返回 blocker 与端口（测试结束要 close）。 */
async function occupyPort() {
  const blocker = http.createServer((req, res) => res.end());
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  return { blocker, port: blocker.address().port };
}
const sortedKeys = (value) => Object.keys(value).sort();

// ===== 夹具 =====

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();
const HOUR = 3_600_000;
const SECOND = 1000;
const ago = (ms) => new Date(NOW - ms).toISOString();
const iso = (ms) => new Date(ms).toISOString();
/** 服务端自己的路径：任何一个出现在响应里都算泄漏。 */
const RUN_DIR = "D:\\private\\dashboard-runs";
const WORKSPACE_ROOT = "D:\\private\\repos\\alpha";
const REFRESH_ERROR = `EACCES: permission denied, open '${RUN_DIR}\\projects\\alpha\\run_x.jsonl'`;
const ROUTES = ["/api/overview", "/api/workers", "/api/attention"];
const ZERO_COUNTS = {
  running: 0, starting: 0,
  liveness: { terminal: 0, progress: 0, process_only: 0, silent: 0, unknown: 0 },
  verifying: 0, deliveryUnobservable: 0, decide: { open: 0, unknown: 0 }, anomalies: { open: 0, unknown: 0 },
};

/** 一个快照运行行（ownerReadModel.projectRun 的形状）+ 几个敌意附加字段。 */
function runRow(overrides = {}) {
  const runId = overrides.runId ?? "run_a";
  return {
    runId,
    project: { slug: "alpha", name: "Alpha", key: WORKSPACE_ROOT },
    availability: "ok",
    state: "completed",
    terminal: true,
    liveness: "terminal",
    stage: "terminal",
    agentId: "glm-pro",
    laneId: "glm-pro",
    roleId: "coder",
    readOnly: false,
    deliveryRequested: true,
    title: `任务 ${runId}`,
    titleBasis: "first_line",
    taskType: "code",
    typeBasis: "persisted",
    startedAt: ago(4 * HOUR),
    terminalAt: ago(3 * HOUR),
    stageSince: ago(4 * HOUR),
    lastEffectAt: ago(3 * HOUR),
    quietSince: ago(4 * HOUR),
    lastVitalAt: ago(3 * HOUR),
    lastProcessActiveAt: null,
    retryOf: null,
    parentRunId: null,
    delivery: null,
    failure: null,
    capacity: null,
    lineageRootRunId: runId,
    lineageRootConflict: false,
    supersessionUndeterminable: false,
    legalDecision: null,
    supersededByRunId: null,
    // 敌意附加字段：不在快照合同里，任何一个出现在响应里都算整包透传。
    transcriptPath: `${RUN_DIR}\\projects\\alpha\\${runId}.jsonl`,
    cwd: WORKSPACE_ROOT,
    worktreePath: `${WORKSPACE_ROOT}\\.wao-worktrees\\${runId}`,
    prompt: "PROMPT_MARKER",
    backendSessionId: "SESSION_MARKER",
    pid: 424242,
    ...overrides,
  };
}

/** 三种运行：在跑的、带额度证据的失败、等裁决的交付。 */
function fixtureSnapshot() {
  return {
    generatedAt: NOW_ISO,
    projects: [{
      slug: "alpha", name: "Alpha", repo: "available", branchesObservedAt: NOW_ISO, consultRecords: "available",
      key: WORKSPACE_ROOT,
    }],
    runs: [
      runRow({
        runId: "run_live", state: "running", terminal: false, liveness: "progress", stage: "active",
        deliveryRequested: false, startedAt: ago(HOUR), terminalAt: null,
      }),
      runRow({
        runId: "run_fail", laneId: "kimi", agentId: "kimi", state: "failed", startedAt: ago(2 * HOUR), terminalAt: ago(HOUR),
        deliveryRequested: false,
        failure: { category: "provider_capacity", code: "quota_exhausted", evidence: "SECRET_MARKER" },
        capacity: { code: "quota_exhausted", observedAt: ago(HOUR) },
      }),
      runRow({
        runId: "run_wait",
        delivery: {
          settlement: { status: "settled", reason: "delivery_settled", worktreePath: `${WORKSPACE_ROOT}\\.wao-worktrees\\run_wait` },
          commit: "c".repeat(40),
          verification: { status: "passed", reverify: { status: "none", reason: null } },
          acceptance: { status: "pending", decidedAt: null },
          settledAt: ago(3 * HOUR),
          ambiguous: false,
          packagingFailure: null,
          isolationFailure: null,
          branchPresent: true,
          worktreePath: `${WORKSPACE_ROOT}\\.wao-worktrees\\run_wait`,
        },
      }),
    ],
    consults: [],
  };
}

const ALPHA_COUNTS = {
  running: 1, starting: 0,
  liveness: { terminal: 2, progress: 1, process_only: 0, silent: 0, unknown: 0 },
  verifying: 0, deliveryUnobservable: 0,
  decide: { open: 2, unknown: 0 }, // 等裁决 + kimi 额度用尽
  anomalies: { open: 2, unknown: 0 }, // 失败的运行 + kimi 额度用尽的镜像（额度用尽也计入 Alerts）
};
const EXPECTED_OVERVIEW = {
  status: "ready",
  generatedAt: NOW_ISO,
  counts: ALPHA_COUNTS,
  projects: [{
    slug: "alpha", name: "Alpha", repo: "available", branchesObservedAt: NOW_ISO, consultRecords: "available", counts: ALPHA_COUNTS,
  }],
  lanes: [
    { laneKey: "glm-pro", running: 1, capacity: null },
    { laneKey: "kimi", running: 0, capacity: { kind: "quota_exhausted", state: "open", observedAt: ago(HOUR) } },
  ],
};
const EXPECTED_ATTENTION = {
  status: "ready",
  generatedAt: NOW_ISO,
  decide: [
    {
      id: "awaiting_decision:run_wait", kind: "awaiting_decision", state: "open", runIds: ["run_wait"],
      projectSlugs: ["alpha"], since: ago(3 * HOUR), evidence: [{ runId: "run_wait", at: ago(3 * HOUR), seq: null }],
      commit: "c".repeat(40),
    },
    {
      id: "capacity:kimi", kind: "quota_exhausted", state: "open", runIds: ["run_fail"], projectSlugs: ["alpha"],
      since: ago(HOUR), laneKey: "kimi", capacityCode: "quota_exhausted", evidence: [{ runId: "run_fail", at: ago(HOUR), seq: null }],
    },
  ],
  anomalies: [
    {
      id: "capacity_alert:kimi", kind: "quota_exhausted", state: "open", runIds: ["run_fail"], projectSlugs: ["alpha"],
      since: ago(HOUR), laneKey: "kimi", capacityCode: "quota_exhausted", evidence: [{ runId: "run_fail", at: ago(HOUR), seq: null }],
    },
    {
      id: "failed:run_fail", kind: "failed", state: "open", runIds: ["run_fail"], projectSlugs: ["alpha"], since: ago(HOUR),
      followUp: "none", followUpRuns: [], failure: { category: "provider_capacity", code: "quota_exhausted" },
      evidence: [{ runId: "run_fail", at: ago(HOUR), seq: null }],
    },
  ],
  resolved: [],
};
const ALPHA = { slug: "alpha", name: "Alpha" };
const EXPECTED_WORKERS = {
  status: "ready",
  generatedAt: NOW_ISO,
  truncated: false,
  workers: [
    {
      runId: "run_live", project: ALPHA, title: "任务 run_live", subtitle: null, taskType: "code", laneKey: "glm-pro",
      roleId: "coder", state: "running", liveness: "progress", stage: "active", startedAt: ago(HOUR), terminalAt: null,
      lastEffectAt: ago(3 * HOUR), quietSince: ago(4 * HOUR), delivery: null, failure: null, attentionIds: [], consult: null,
    },
    {
      runId: "run_fail", project: ALPHA, title: "任务 run_fail", subtitle: null, taskType: "code", laneKey: "kimi",
      roleId: "coder", state: "failed", liveness: "terminal", stage: "terminal", startedAt: ago(2 * HOUR),
      terminalAt: ago(HOUR), lastEffectAt: ago(3 * HOUR), quietSince: ago(4 * HOUR), delivery: null,
      failure: { category: "provider_capacity", code: "quota_exhausted" },
      attentionIds: ["capacity:kimi", "capacity_alert:kimi", "failed:run_fail"], consult: null,
    },
    {
      runId: "run_wait", project: ALPHA, title: "任务 run_wait", subtitle: null, taskType: "code", laneKey: "glm-pro",
      roleId: "coder", state: "completed", liveness: "terminal", stage: "terminal", startedAt: ago(4 * HOUR),
      terminalAt: ago(3 * HOUR), lastEffectAt: ago(3 * HOUR), quietSince: ago(4 * HOUR),
      delivery: {
        settlement: { status: "settled", reason: "delivery_settled" },
        verification: { status: "passed" },
        acceptance: { status: "pending" },
        branchPresent: true,
      },
      failure: null, attentionIds: ["awaiting_decision:run_wait"], consult: null,
    },
  ],
};

/**
 * 假读模型 + 调用账。snapshot 尊重传入的 now（generatedAt 由它算），这样"同一个 now"
 * 能从外部观察到；onRefresh(n) 可以为某一轮注入失败或挂起。
 */
function fakeReadModel({ snapshotFactory = () => fixtureSnapshot(), onRefresh = null } = {}) {
  const calls = { refresh: 0, snapshot: 0, snapshotArgs: [] };
  const model = {
    async refresh() {
      calls.refresh += 1;
      if (onRefresh !== null) await onRefresh(calls.refresh);
    },
    snapshot(args) {
      calls.snapshot += 1;
      calls.snapshotArgs.push(args);
      const snap = snapshotFactory(args);
      return { ...snap, generatedAt: iso(args.now) };
    },
  };
  return { model, calls };
}

const unusedRunsFn = async () => ({ runs: [], returnedCount: 0, matchedCount: 0, truncated: false });
const unusedActivityFn = async (input) => ({
  runId: input.runId, available: true, unavailableReason: null,
  activity: { entries: [], total: 0, counts: {}, nextCursor: null },
  liveness: { ownerHeartbeat: "n/a", secondsSinceHeartbeat: null },
});

/** 建服务：缺省注入假读模型（不注入时走缺省工厂，见 DEFAULT WIRING）。 */
function makeServer({ readModel, refreshIntervalMs, nowFn, port } = {}) {
  const clock = typeof nowFn === "function" ? nowFn : () => NOW;
  return createOwnerDashboardServer({
    runDir: RUN_DIR, workspaceRoot: WORKSPACE_ROOT, knownAgentIds: [], env: {},
    getOwnerRunsFn: unusedRunsFn, getOwnerActivityFn: unusedActivityFn,
    nowFn: clock,
    ...(readModel !== undefined ? { createReadModelFn: () => readModel } : {}),
    ...(refreshIntervalMs !== undefined ? { refreshIntervalMs } : {}),
    ...(port !== undefined ? { port } : {}),
  });
}
const auth = (s) => ({ authorization: "Bearer " + s.token });

/** 响应里没有任何路径形状的串：服务端自己的路径、盘符、UNC、绝对 POSIX 路径都不在。 */
function assertNoPaths(r) {
  assert.ok(!r.body.includes(RUN_DIR), "runDir 不出接口");
  assert.ok(!r.body.includes(WORKSPACE_ROOT), "workspaceRoot 不出接口");
  assert.ok(!/[A-Za-z]:[\\/]/.test(r.body), "no drive-letter path");
  assert.ok(!r.body.includes("\\\\"), "no UNC / escaped-backslash path");
  assert.ok(!r.body.includes("/"), "no slash at all in this fixture (so no POSIX path can hide)");
}

function assertSafeHeaders(r) {
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.ok(r.headers["content-security-policy"], "CSP set");
  assert.ok(!("access-control-allow-origin" in r.headers), "no CORS opt-in");
  assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
}

async function readyServer(options) {
  const { model, calls } = fakeReadModel(options);
  const s = makeServer({ readModel: model, refreshIntervalMs: options?.refreshIntervalMs, nowFn: options?.nowFn });
  assert.equal(await s.refreshNow(), "ready");
  return { s, calls };
}

// =====================================================================
// 鉴权与方法
// =====================================================================
test("AUTH: 三个接口逐请求验 bearer——无令牌 / 错令牌 401，固定错误体，令牌不出现在响应里", async () => {
  const { s } = await readyServer();
  for (const url of ROUTES) {
    const bare = await drive(s.handler, { url });
    assert.equal(bare.status, 401, `${url} 无令牌 → 401`);
    assert.deepEqual(jsonOf(bare), { error: "unauthorized" });
    assertSafeHeaders(bare);
    for (const headers of [
      { authorization: "Bearer " + "0".repeat(64) },
      { authorization: s.token },
      { authorization: "bearer " + s.token },
      { authorization: "Bearer" },
    ]) {
      const wrong = await drive(s.handler, { url, headers });
      assert.equal(wrong.status, 401, `${url} 错令牌 → 401`);
      assert.deepEqual(jsonOf(wrong), { error: "unauthorized" });
    }
    // 未通过鉴权时不透露任何数据：连 loading 状态都不给。
    const body = await drive(s.handler, { url });
    assert.ok(!body.body.includes(s.token));
    assert.ok(!JSON.stringify(body.headers).includes(s.token));
  }
});

test("METHOD: 三个接口只许 GET——其余方法 405 + Allow: GET，OPTIONS 不开 CORS", async () => {
  const { s } = await readyServer();
  for (const url of ROUTES) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const r = await drive(s.handler, { method, url, headers: auth(s) });
      assert.equal(r.status, 405, `${method} ${url} → 405`);
      assert.equal(r.headers.allow, "GET");
      assert.deepEqual(jsonOf(r), { error: "method_not_allowed" });
      assertSafeHeaders(r);
    }
  }
});

// =====================================================================
// 参数闭集
// =====================================================================
test("QUERY: /api/overview 无参数——任何键都 400；/api/workers 与 /api/attention 只认 project", async () => {
  const { s } = await readyServer();
  for (const url of ["/api/overview?project=alpha", "/api/overview?x=1", "/api/overview?project="]) {
    const r = await drive(s.handler, { url, headers: auth(s) });
    assert.equal(r.status, 400, `${url} → 400`);
    assert.deepEqual(jsonOf(r), { error: "bad_request" });
    assertSafeHeaders(r);
  }
  for (const route of ["/api/workers", "/api/attention"]) {
    for (const url of [
      `${route}?project=alpha&limit=5`,
      `${route}?project=alpha&project=alpha`, // 重复键
      `${route}?runDir=${encodeURIComponent(RUN_DIR)}`,
      `${route}?workspaceRoot=/evil`,
    ]) {
      const r = await drive(s.handler, { url, headers: auth(s) });
      assert.equal(r.status, 400, `${url} → 400`);
      assert.deepEqual(jsonOf(r), { error: "bad_request" });
      assertSafeHeaders(r);
    }
    const ok = await drive(s.handler, { url: `${route}?project=alpha`, headers: auth(s) });
    assert.equal(ok.status, 200, `${route}?project=alpha → 200`);
  }
});

test("QUERY: project 形状不合 → 400（空、前导 - 或 .、分隔符、空白、盘符）；固定错误体不回显输入", async () => {
  const { s } = await readyServer();
  for (const route of ["/api/workers", "/api/attention"]) {
    for (const bad of ["", "-x", ".x", "../x", "a/b", "a\\b", "a b", "C:", "a%20b", "a?b", "a&b", "a=b"]) {
      const r = await drive(s.handler, { url: `${route}?project=${encodeURIComponent(bad)}`, headers: auth(s) });
      assert.equal(r.status, 400, `${route}?project=${JSON.stringify(bad)} → 400`);
      assert.deepEqual(jsonOf(r), { error: "bad_request" });
      assertSafeHeaders(r);
    }
  }
});

test("QUERY: 形状合辙但不存在的项目 → 200 空结果（形状错才 400）", async () => {
  const { s } = await readyServer();
  const w = await drive(s.handler, { url: "/api/workers?project=nowhere-9", headers: auth(s) });
  assert.deepEqual(jsonOf(w), { status: "ready", generatedAt: NOW_ISO, truncated: false, workers: [] });
  const a = await drive(s.handler, { url: "/api/attention?project=nowhere-9", headers: auth(s) });
  assert.deepEqual(jsonOf(a), { status: "ready", generatedAt: NOW_ISO, decide: [], anomalies: [], resolved: [] });
});

// =====================================================================
// 刷新状态：loading → ready → stale → 恢复
// =====================================================================
test("LOADING: 首轮完成前三个接口都是 200 + status: loading，不带任何数据（绝不返回 0 个运行）", async () => {
  const { model } = fakeReadModel();
  const s = makeServer({ readModel: model });
  for (const url of ROUTES) {
    const r = await drive(s.handler, { url, headers: auth(s) });
    assert.equal(r.status, 200, `${url} → 200`);
    assert.deepEqual(jsonOf(r), { status: "loading" }, `${url} 只有 status 一个键`);
    assertSafeHeaders(r);
  }
});

test("UNAVAILABLE: 首轮刷新就失败、从未发布过——状态是 unavailable（不是 loading），带首次失败时刻，错误原文不出接口", async () => {
  let clock = NOW;
  let failing = true;
  const { model } = fakeReadModel({ onRefresh: () => { if (failing) throw new Error(REFRESH_ERROR); } });
  const s = makeServer({ readModel: model, nowFn: () => clock });
  assert.equal(await s.refreshNow(), "unavailable");
  clock = NOW + 10 * SECOND;
  assert.equal(await s.refreshNow(), "unavailable");
  for (const url of ROUTES) {
    const r = await drive(s.handler, { url, headers: auth(s) });
    assert.deepEqual(jsonOf(r), { status: "unavailable", staleSince: NOW_ISO }, `${url}: 带首次失败时刻`);
    assert.ok(!r.body.includes("EACCES"), "错误原文不出接口");
    assertNoPaths(r);
  }
  // 失败没有把状态钉死：下一轮成功 → ready，staleSince 清掉。
  failing = false;
  clock = NOW + 20 * SECOND;
  assert.equal(await s.refreshNow(), "ready");
  const recovered = jsonOf(await drive(s.handler, { url: "/api/overview", headers: auth(s) }));
  assert.equal(recovered.status, "ready");
  assert.ok(!("staleSince" in recovered));
  assert.equal(recovered.generatedAt, iso(NOW + 20 * SECOND));
});

test("LOADING + 坏参数 / 无鉴权: 鉴权与参数校验先于 loading——未发布时坏参数照样 400，无令牌照样 401", async () => {
  const { model } = fakeReadModel();
  const s = makeServer({ readModel: model });
  for (const [url, expected] of [["/api/workers?project=../x", 400], ["/api/overview?x=1", 400], ["/api/workers?project=a&project=b", 400]]) {
    const r = await drive(s.handler, { url, headers: auth(s) });
    assert.equal(r.status, expected, `${url} → ${expected} even while loading`);
    assert.deepEqual(jsonOf(r), { error: "bad_request" });
  }
  assert.equal((await drive(s.handler, { url: "/api/attention?project=../x" })).status, 401, "鉴权先于参数校验");
});

test("REFRESH ERROR SOURCES: refresh() 同步抛、snapshot() 抛、时钟超出 Date 范围、事项推导抛——都是失败轮，保留上一份并恢复", async () => {
  // refresh() 同步抛：从未发布 → unavailable；下一轮成功后 ready（失败没有把链/状态钉死）。
  let syncFailing = true;
  const syncThrow = {
    refresh() { if (syncFailing) throw new Error(`sync exploded at ${RUN_DIR}`); },
    snapshot: () => ({ generatedAt: NOW_ISO, projects: [], runs: [], consults: [] }),
  };
  const s = makeServer({ readModel: syncThrow, nowFn: () => NOW });
  assert.equal(await s.refreshNow(), "unavailable", "同步抛也是失败轮");
  syncFailing = false;
  assert.equal(await s.refreshNow(), "ready", "同步抛之后下一轮照常成功");
  // snapshot() 抛：从未发布 → unavailable，错误原文不出接口。
  const brokenSnapshot = { refresh: async () => {}, snapshot: () => { throw new TypeError(`snapshot exploded at ${RUN_DIR}`); } };
  const s2 = makeServer({ readModel: brokenSnapshot });
  assert.equal(await s2.refreshNow(), "unavailable");
  assert.equal(await s2.refreshNow(), "unavailable");
  for (const url of ROUTES) {
    const r = await drive(s2.handler, { url, headers: auth(s2) });
    assert.deepEqual(jsonOf(r), { status: "unavailable", staleSince: NOW_ISO });
    assert.ok(!r.body.includes("exploded"), "错误原文不出接口");
    assertNoPaths(r);
  }
  // 时钟返回有限但超出 Date 范围的值（9e15）：一轮开始就校验，按失败轮处理——不取快照、
  // 不发布。已有发布时 → stale，且失败时刻表示不了如实 null。
  let clock = NOW;
  let snapshotCalls = 0;
  const steady = {
    refresh: async () => {},
    snapshot: () => {
      snapshotCalls += 1;
      return { generatedAt: NOW_ISO, projects: [], runs: [], consults: [] };
    },
  };
  const s3 = makeServer({ readModel: steady, nowFn: () => clock });
  assert.equal(await s3.refreshNow(), "ready");
  assert.equal(snapshotCalls, 1);
  clock = 9e15;
  assert.equal(await s3.refreshNow(), "stale", "接不住的时钟不许冒成异常");
  assert.equal(snapshotCalls, 1, "坏时钟不调 snapshot");
  const brokenClock = jsonOf(await drive(s3.handler, { url: "/api/overview", headers: auth(s3) }));
  assert.equal(brokenClock.status, "stale");
  assert.equal(brokenClock.generatedAt, NOW_ISO, "数据仍是上一份发布");
  assert.equal(brokenClock.staleSince, null, "表示不了失败时刻就如实 null");
  clock = NOW + SECOND;
  assert.equal(await s3.refreshNow(), "ready", "时钟恢复后下一轮成功");
  assert.equal(snapshotCalls, 2);
  // 时钟不可用（NaN）同样在取快照之前失败：已有发布 → stale。
  clock = NaN;
  assert.equal(await s3.refreshNow(), "stale", "坏时钟 → 保留上一份发布并标 stale");
  assert.equal(snapshotCalls, 2, "坏时钟不调 snapshot");
  assert.equal(jsonOf(await drive(s3.handler, { url: "/api/attention", headers: auth(s3) })).status, "stale");
  clock = NOW + 2 * SECOND;
  assert.equal(await s3.refreshNow(), "ready", "时钟恢复后下一轮成功");
  assert.equal(snapshotCalls, 3);
});

test("CLOCK: 有限但超出 Date 范围的 now 是失败轮——注入的读模型即使能出快照也不取、不发布", async () => {
  let clock = 9e15;
  const { model, calls } = fakeReadModel(); // snapshot 本身不会抛：坏时钟必须由服务先拦下
  const s = makeServer({ readModel: model, nowFn: () => clock });
  assert.equal(await s.refreshNow(), "unavailable", "坏时钟不能发布成 ready");
  assert.equal(calls.refresh, 0, "一轮开始先校验时钟：坏时钟连读模型都不刷新");
  assert.equal(calls.snapshot, 0, "坏时钟不调 snapshot");
  for (const url of ROUTES) {
    assert.deepEqual(jsonOf(await drive(s.handler, { url, headers: auth(s) })), { status: "unavailable", staleSince: null }, url);
  }
  // 时钟恢复 → 正常发布。
  clock = NOW;
  assert.equal(await s.refreshNow(), "ready");
  assert.equal(calls.snapshot, 1);
  // 已发布之后坏时钟：保留上一份、标 stale，不再出版本。
  clock = 9e15;
  assert.equal(await s.refreshNow(), "stale");
  assert.equal(calls.snapshot, 1, "坏时钟不调 snapshot（不发布新的一轮）");
  const body = jsonOf(await drive(s.handler, { url: "/api/overview", headers: auth(s) }));
  assert.equal(body.status, "stale");
  assert.equal(body.generatedAt, NOW_ISO, "还是上一份发布");
  assert.deepEqual(body.counts, ALPHA_COUNTS);
});

test("STALE: 连续失败保留首个失败轮的时刻——首轮时钟读不出就保持 null，后面的时钟不补", async () => {
  let clock = NaN; // 首个失败轮的时钟读不出 → staleSince 为 null
  let failing = true;
  const { model } = fakeReadModel({ onRefresh: () => { if (failing) throw new Error(REFRESH_ERROR); } });
  const s = makeServer({ readModel: model, nowFn: () => clock });
  const overview = async () => jsonOf(await drive(s.handler, { url: "/api/overview", headers: auth(s) }));
  assert.equal(await s.refreshNow(), "unavailable");
  assert.deepEqual(await overview(), { status: "unavailable", staleSince: null }, "首个失败轮时钟读不出：staleSince 如实 null");
  // 同一段连续失败的第二个失败轮：时钟恢复，但不得把 staleSince 补成这一刻。
  clock = NOW;
  assert.equal(await s.refreshNow(), "unavailable");
  assert.deepEqual(await overview(), { status: "unavailable", staleSince: null }, "连续失败不补首次失败时刻");
  clock = NOW + 10 * SECOND;
  assert.equal(await s.refreshNow(), "unavailable");
  assert.deepEqual(await overview(), { status: "unavailable", staleSince: null });
  // 恢复后开始新的一段失败：首个失败轮的时刻就是这一段起点。
  failing = false;
  assert.equal(await s.refreshNow(), "ready");
  failing = true;
  clock = NOW + 30 * SECOND;
  assert.equal(await s.refreshNow(), "stale");
  assert.equal((await overview()).staleSince, iso(NOW + 30 * SECOND), "新一段失败从它的第一个失败轮算起");
  clock = NOW + 40 * SECOND;
  assert.equal(await s.refreshNow(), "stale");
  assert.equal((await overview()).staleSince, iso(NOW + 30 * SECOND), "同一段里不覆盖");
});

test("READY: 一轮成功后发布一份 { generatedAt, snapshot, attention }，三个接口读同一份", async () => {
  const { s, calls } = await readyServer();
  assert.equal(calls.refresh, 1);
  assert.deepEqual(calls.snapshotArgs, [{ now: NOW }], "快照按同一个 now 出");
  const overview = await drive(s.handler, { url: "/api/overview", headers: auth(s) });
  const workers = await drive(s.handler, { url: "/api/workers", headers: auth(s) });
  const attention = await drive(s.handler, { url: "/api/attention", headers: auth(s) });
  for (const r of [overview, workers, attention]) {
    assert.equal(r.status, 200);
    assertSafeHeaders(r);
    assert.equal(jsonOf(r).status, "ready");
    assert.equal(jsonOf(r).generatedAt, NOW_ISO);
    assert.ok(!("staleSince" in jsonOf(r)), "ready 不带 staleSince");
  }
  assert.deepEqual(jsonOf(overview), EXPECTED_OVERVIEW);
  assert.deepEqual(jsonOf(workers), EXPECTED_WORKERS);
  assert.deepEqual(jsonOf(attention), EXPECTED_ATTENTION);
  // 读接口不再碰读模型：发的就是那一份发布。
  assert.equal(calls.refresh, 1);
  assert.equal(calls.snapshot, 1);
});

test("SAME NOW: snapshot({ now }) 与事项推导用同一轮的同一个时刻（时钟每调一次走一格）", async () => {
  // 时钟第一格是 NOW，之后每调一次 +2 小时。三条运行的归属在两格之间各不相同：
  //   - run_edge 失败于 23 小时前：NOW 在 24 小时窗口内，+2 小时落在窗口外；
  //   - run_soon 收口于 1.5 小时前、待裁决：NOW 不到 2 小时，+2 小时就该提醒；
  //   - run_quota 额度观测于 5 小时前：NOW 不超过 6 小时是 open，+2 小时变成 unknown。
  // 推导若另取了一格时钟，三条里至少有一条对不上。
  const edge = () => ({
    generatedAt: NOW_ISO,
    projects: [{ slug: "alpha", name: "Alpha", repo: "available", branchesObservedAt: NOW_ISO, consultRecords: "available" }],
    runs: [
      runRow({ runId: "run_edge", state: "failed", deliveryRequested: false, startedAt: ago(24 * HOUR), terminalAt: ago(23 * HOUR), failure: { category: "provider_error", code: "backend_error" } }),
      runRow({ runId: "run_soon", startedAt: ago(2 * HOUR), terminalAt: ago(2 * HOUR), delivery: {
        settlement: { status: "settled", reason: "delivery_settled" }, commit: null, verification: { status: "passed", reverify: { status: "none", reason: null } },
        acceptance: { status: "pending", decidedAt: null }, settledAt: ago(90 * 60 * SECOND), ambiguous: false,
        packagingFailure: null, isolationFailure: null, branchPresent: true,
      } }),
      runRow({ runId: "run_quota", laneId: "kimi", agentId: "kimi", state: "failed", deliveryRequested: false, terminalAt: ago(5 * HOUR), failure: { category: "provider_capacity", code: "quota_exhausted" }, capacity: { code: "quota_exhausted", observedAt: ago(5 * HOUR) } }),
    ],
    consults: [],
  });
  let ticks = 0;
  const { model, calls } = fakeReadModel({ snapshotFactory: edge });
  const s = makeServer({ readModel: model, nowFn: () => NOW + ticks++ * 2 * HOUR });
  assert.equal(await s.refreshNow(), "ready");
  assert.equal(ticks, 1, "一轮只取一次时钟");
  assert.deepEqual(calls.snapshotArgs, [{ now: NOW }], "快照按同一个 now 出");
  const r = jsonOf(await drive(s.handler, { url: "/api/attention", headers: auth(s) }));
  assert.equal(r.generatedAt, NOW_ISO, "generatedAt 是同一个 now");
  assert.deepEqual(r.decide.map((item) => [item.id, item.state]), [["capacity:kimi", "open"]]);
  // 异常按 since 从早到晚：失败得更早的 run_edge（23 小时前）在 run_quota（5 小时前）之前。
  assert.deepEqual(r.anomalies.map((item) => item.id), ["failed:run_edge", "capacity_alert:kimi", "failed:run_quota"]);
});

test("STALE: 某轮失败保留上一份发布、标 stale 并带首次失败时刻；下一轮成功恢复 ready", async () => {
  let clock = NOW;
  let failing = false;
  let version = 0;
  const { model } = fakeReadModel({
    snapshotFactory: () => {
      const snap = fixtureSnapshot();
      snap.projects[0].name = `Alpha v${version}`;
      return snap;
    },
    onRefresh: () => {
      if (failing) throw new Error(REFRESH_ERROR);
      version += 1;
    },
  });
  const s = makeServer({ readModel: model, nowFn: () => clock });
  const get = async (url) => jsonOf(await drive(s.handler, { url, headers: auth(s) }));

  assert.equal(await s.refreshNow(), "ready");
  assert.equal((await get("/api/overview")).projects[0].name, "Alpha v1");

  failing = true;
  clock = NOW + 10 * SECOND;
  assert.equal(await s.refreshNow(), "stale");
  for (const url of ROUTES) {
    const body = await get(url);
    assert.equal(body.status, "stale", url);
    assert.equal(body.staleSince, iso(NOW + 10 * SECOND), "staleSince 是首次失败的时刻");
    assert.equal(body.generatedAt, NOW_ISO, "数据仍是上一份发布");
  }
  assert.equal((await get("/api/overview")).projects[0].name, "Alpha v1");
  assert.equal((await get("/api/workers")).workers.length, 3, "保留上一份，不返回 0 个运行");
  const stale = await drive(s.handler, { url: "/api/attention", headers: auth(s) });
  assert.ok(!stale.body.includes("EACCES"), "错误原文不出接口");
  assert.ok(!stale.body.includes("permission denied"));
  assertNoPaths(stale);
  assertSafeHeaders(stale);

  clock = NOW + 20 * SECOND;
  assert.equal(await s.refreshNow(), "stale");
  assert.equal((await get("/api/overview")).staleSince, iso(NOW + 10 * SECOND), "连续失败只记第一次");

  failing = false;
  clock = NOW + 30 * SECOND;
  assert.equal(await s.refreshNow(), "ready");
  for (const url of ROUTES) {
    const body = await get(url);
    assert.equal(body.status, "ready", url);
    assert.ok(!("staleSince" in body), "恢复后不带 staleSince");
    assert.equal(body.generatedAt, iso(NOW + 30 * SECOND));
  }
  assert.equal((await get("/api/overview")).projects[0].name, "Alpha v2");
});

// =====================================================================
// DTO 白名单与"接口不出现路径"
// =====================================================================
test("WHITELIST: 行与事项只有页面要的字段；快照里的敌意附加字段一个都不透传；响应里没有路径", async () => {
  const { s } = await readyServer();
  const workers = jsonOf(await drive(s.handler, { url: "/api/workers", headers: auth(s) }));
  const attention = jsonOf(await drive(s.handler, { url: "/api/attention", headers: auth(s) }));
  const overview = jsonOf(await drive(s.handler, { url: "/api/overview", headers: auth(s) }));
  assert.deepEqual(sortedKeys(overview), ["counts", "generatedAt", "lanes", "projects", "status"]);
  assert.deepEqual(sortedKeys(overview.counts), ["anomalies", "decide", "deliveryUnobservable", "liveness", "running", "starting", "verifying"]);
  assert.deepEqual(sortedKeys(overview.projects[0]), ["branchesObservedAt", "consultRecords", "counts", "name", "repo", "slug"]);
  assert.deepEqual(sortedKeys(overview.lanes[1]), ["capacity", "laneKey", "running"]);
  assert.deepEqual(sortedKeys(overview.lanes[1].capacity), ["kind", "observedAt", "state"]);
  assert.deepEqual(sortedKeys(workers), ["generatedAt", "status", "truncated", "workers"]);
  assert.deepEqual(sortedKeys(workers.workers[0]), [
    "attentionIds", "consult", "delivery", "failure", "laneKey", "lastEffectAt", "liveness", "project", "quietSince", "roleId",
    "runId", "stage", "startedAt", "state", "subtitle", "taskType", "terminalAt", "title",
  ]);
  assert.deepEqual(sortedKeys(workers.workers[0].project), ["name", "slug"]);
  assert.deepEqual(sortedKeys(workers.workers[2].delivery), ["acceptance", "branchPresent", "settlement", "verification"]);
  assert.deepEqual(sortedKeys(workers.workers[2].delivery.settlement), ["reason", "status"]);
  assert.deepEqual(sortedKeys(workers.workers[2].delivery.verification), ["status"]);
  assert.deepEqual(sortedKeys(workers.workers[2].delivery.acceptance), ["status"]);
  assert.deepEqual(sortedKeys(workers.workers[1].failure), ["category", "code"]);
  assert.deepEqual(sortedKeys(attention), ["anomalies", "decide", "generatedAt", "resolved", "status"]);
  assert.deepEqual(sortedKeys(attention.decide[0]), ["commit", "evidence", "id", "kind", "projectSlugs", "runIds", "since", "state"]);
  assert.deepEqual(sortedKeys(attention.decide[1]), ["capacityCode", "evidence", "id", "kind", "laneKey", "projectSlugs", "runIds", "since", "state"]);
  assert.deepEqual(sortedKeys(attention.anomalies[0]), ["capacityCode", "evidence", "id", "kind", "laneKey", "projectSlugs", "runIds", "since", "state"]);
  assert.deepEqual(sortedKeys(attention.anomalies[1]), ["evidence", "failure", "followUp", "followUpRuns", "id", "kind", "projectSlugs", "runIds", "since", "state"]);
  assert.deepEqual(sortedKeys(attention.anomalies[1].evidence[0]), ["at", "runId", "seq"]);
  for (const marker of ["PROMPT_MARKER", "SESSION_MARKER", "424242", "SECRET_MARKER", "transcriptPath", "worktreePath", "cwd", "prompt", "pid", "availability"]) {
    for (const body of [JSON.stringify(workers), JSON.stringify(attention), JSON.stringify(overview)]) {
      assert.ok(!body.includes(`"${marker}`), `${marker} 不透传`);
      assert.ok(!body.includes(marker), `${marker} 不透传（值也不行）`);
    }
  }
  // 交付摘要不带提交号、收口时刻、复验链与裁决时间；行里没有 lastVitalAt / readOnly / 谱系等内部事实。
  assert.ok(!JSON.stringify(workers).includes("c".repeat(40)));
  assert.ok(!JSON.stringify(workers).includes("settledAt"));
  assert.ok(!JSON.stringify(workers).includes("reverify"));
  assert.ok(!JSON.stringify(workers).includes("decidedAt"));
  assert.ok(!JSON.stringify(workers).includes("lineageRootRunId"));
  assert.ok(!JSON.stringify(workers).includes("supersededByRunId"));
});

test("NO PATHS: 三个接口的响应里没有任何路径形状的串", async () => {
  const { s } = await readyServer();
  for (const url of ROUTES) {
    const r = await drive(s.handler, { url, headers: auth(s) });
    assert.equal(r.status, 200);
    assertNoPaths(r);
    assert.ok(!JSON.stringify(r.headers).includes(RUN_DIR), "响应头里也没有");
  }
});

test("NO PATHS: 标题里的绝对路径已由读模型折过；接口照抄折后的标题，不另做加工", async () => {
  // 读模型保证快照里没有路径；这里钉的是接口不把别的字段拼进标题。
  const titled = () => ({
    generatedAt: NOW_ISO,
    projects: [{ slug: "alpha", name: "Alpha", repo: "unknown", branchesObservedAt: null, consultRecords: "available" }],
    runs: [runRow({ runId: "run_t", title: "改 …/ownerAttention.js 的 …/runs", terminalAt: null, terminal: false, state: "running", liveness: "progress", stage: "active" })],
    consults: [],
  });
  const { model } = fakeReadModel({ snapshotFactory: titled });
  const s = makeServer({ readModel: model });
  await s.refreshNow();
  const r = await drive(s.handler, { url: "/api/workers", headers: auth(s) });
  assert.equal(jsonOf(r).workers[0].title, "改 …/ownerAttention.js 的 …/runs");
});

// =====================================================================
// Workers：范围、排序、上限、按项目筛选
// =====================================================================
test("WORKERS: 默认范围与非默认范围——读不出的运行、太旧且没挂事项的终态不列", async () => {
  const snap = () => ({
    generatedAt: NOW_ISO,
    projects: [{ slug: "alpha", name: "Alpha", repo: "unknown", branchesObservedAt: null, consultRecords: "available" }],
    runs: [
      runRow({ runId: "run_live", state: "running", terminal: false, liveness: "progress", stage: "active", deliveryRequested: false, terminalAt: null, startedAt: ago(HOUR) }),
      runRow({ runId: "run_recent", startedAt: ago(2 * HOUR), terminalAt: ago(HOUR) }),
      // 打包失败的交付：没有交付视图，验证与裁决在快照里是 null——摘要里也如实是 null，不是空对象。
      runRow({
        runId: "run_pkg", startedAt: ago(90 * 60 * SECOND), terminalAt: ago(HOUR),
        delivery: {
          settlement: { status: "settled", reason: "packaging_failed" }, commit: null, verification: null,
          acceptance: null, settledAt: ago(HOUR), ambiguous: false, packagingFailure: "no_changes",
          isolationFailure: null, branchPresent: true,
        },
      }),
      runRow({ runId: "run_old", terminalAt: ago(30 * HOUR), startedAt: ago(31 * HOUR) }),
      runRow({
        runId: "run_unreadable", availability: "unreadable", project: null, state: null, terminal: null, liveness: "unknown",
        stage: "stage_unknown", title: null, startedAt: null, terminalAt: null,
      }),
    ],
    consults: [],
  });
  const { model } = fakeReadModel({ snapshotFactory: snap });
  const s = makeServer({ readModel: model });
  await s.refreshNow();
  const r = jsonOf(await drive(s.handler, { url: "/api/workers", headers: auth(s) }));
  assert.deepEqual(r.workers.map((row) => row.runId), ["run_live", "run_pkg", "run_recent"]);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.workers[1].delivery, {
    settlement: { status: "settled", reason: "packaging_failed" }, verification: null, acceptance: null, branchPresent: true,
  });
});

test("WORKERS: 按 startedAt 倒序（读不到的排最后）；上限 500，超出给 truncated: true", async () => {
  const runs = Array.from({ length: 503 }, (_, i) => runRow({
    runId: `run_${String(i).padStart(3, "0")}`,
    state: "running", terminal: false, liveness: "progress", stage: "active", deliveryRequested: false, terminalAt: null,
    startedAt: i === 501 ? null : ago((1000 - i) * SECOND),
  }));
  const snap = () => ({
    generatedAt: NOW_ISO,
    projects: [{ slug: "alpha", name: "Alpha", repo: "unknown", branchesObservedAt: null, consultRecords: "available" }],
    runs,
    consults: [],
  });
  const { model } = fakeReadModel({ snapshotFactory: snap });
  const s = makeServer({ readModel: model });
  await s.refreshNow();
  const r = jsonOf(await drive(s.handler, { url: "/api/workers", headers: auth(s) }));
  assert.equal(r.truncated, true);
  assert.equal(r.workers.length, 500);
  // startedAt 最新的 500 个：run_502（498 秒前）、run_500、…、run_002（没有 startedAt 的 run_501
  // 排最后，被截掉；有时刻的是 502 个，取前 500 个到 run_002 为止）。
  assert.deepEqual([r.workers[0].runId, r.workers[1].runId, r.workers[499].runId], ["run_502", "run_500", "run_002"]);
  assert.ok(!r.workers.some((row) => row.runId === "run_501"));
  assert.ok(!r.workers.some((row) => row.runId === "run_001"));
  // 恰好 500 个不截断（留下前 500 个，含没有 startedAt 的 run_501）。
  runs.splice(500);
  await s.refreshNow();
  const exact = jsonOf(await drive(s.handler, { url: "/api/workers", headers: auth(s) }));
  assert.equal(exact.workers.length, 500);
  assert.equal(exact.truncated, false);
});

test("WORKERS + ATTENTION: 按项目筛选——workers 只留该项目的行，attention 只留该项目的事项", async () => {
  const snap = () => {
    const base = fixtureSnapshot();
    base.projects.push({ slug: "beta", name: "Beta", repo: "unknown", branchesObservedAt: null, consultRecords: "unknown" });
    base.runs.push(runRow({
      runId: "run_beta", project: { slug: "beta", name: "Beta" }, state: "running", terminal: false, liveness: "progress",
      stage: "active", deliveryRequested: false, terminalAt: null, startedAt: ago(30 * 60 * SECOND),
    }));
    base.runs.push(runRow({
      runId: "run_beta_wait", project: { slug: "beta", name: "Beta" }, startedAt: ago(50 * HOUR), terminalAt: ago(49 * HOUR),
      delivery: {
        settlement: { status: "settled", reason: "delivery_settled" }, commit: "d".repeat(40), verification: null,
        acceptance: { status: "pending", decidedAt: null }, settledAt: ago(49 * HOUR), ambiguous: false,
        packagingFailure: null, isolationFailure: null, branchPresent: true,
      },
    }));
    return base;
  };
  const { model } = fakeReadModel({ snapshotFactory: snap });
  const s = makeServer({ readModel: model });
  await s.refreshNow();
  const workers = jsonOf(await drive(s.handler, { url: "/api/workers?project=beta", headers: auth(s) }));
  assert.deepEqual(workers.workers.map((row) => [row.runId, row.attentionIds]), [["run_beta", []], ["run_beta_wait", ["awaiting_decision:run_beta_wait"]]]);
  assert.deepEqual(workers.workers.map((row) => row.project), [{ slug: "beta", name: "Beta" }, { slug: "beta", name: "Beta" }]);
  const attention = jsonOf(await drive(s.handler, { url: "/api/attention?project=beta", headers: auth(s) }));
  assert.deepEqual(attention.decide.map((item) => item.id), ["awaiting_decision:run_beta_wait"]);
  assert.deepEqual(attention.anomalies, []);
  const alpha = jsonOf(await drive(s.handler, { url: "/api/attention?project=alpha", headers: auth(s) }));
  assert.deepEqual(alpha.decide.map((item) => item.id), ["awaiting_decision:run_wait", "capacity:kimi"]);
  // 不筛项目时全量，且与 overview 的计数口径一致（计数是全局的，不随 project 参数变）。
  const all = jsonOf(await drive(s.handler, { url: "/api/workers", headers: auth(s) }));
  assert.equal(all.workers.length, 5);
  const overview = jsonOf(await drive(s.handler, { url: "/api/overview", headers: auth(s) }));
  assert.equal(overview.counts.decide.open, 3);
  assert.deepEqual(overview.projects.map((project) => [project.slug, project.counts.decide.open]), [["alpha", 2], ["beta", 1]]);
});

test("PROJECT SLUGS: 跨项目额度事项在两边都能查到；Workers attentionIds 与 attention 同一筛选；项目计数与筛选一致", async () => {
  const snap = () => ({
    generatedAt: NOW_ISO,
    projects: [
      { slug: "alpha", name: "Alpha", repo: "unknown", branchesObservedAt: null, consultRecords: "available" },
      { slug: "beta", name: "Beta", repo: "unknown", branchesObservedAt: null, consultRecords: "available" },
    ],
    runs: [
      runRow({
        runId: "run_alpha", state: "failed", startedAt: ago(3 * HOUR), terminalAt: ago(2 * HOUR), deliveryRequested: false,
        failure: { category: "provider_capacity", code: "quota_exhausted" },
        capacity: { code: "quota_exhausted", observedAt: ago(2 * HOUR) },
      }),
      runRow({
        runId: "run_beta", project: { slug: "beta", name: "Beta" }, state: "failed", startedAt: ago(2 * HOUR), terminalAt: ago(HOUR),
        deliveryRequested: false, failure: { category: "provider_capacity", code: "quota_exhausted" },
        capacity: { code: "quota_exhausted", observedAt: ago(HOUR) },
      }),
    ],
    consults: [],
  });
  const { model } = fakeReadModel({ snapshotFactory: snap });
  const s = makeServer({ readModel: model });
  await s.refreshNow();
  for (const slug of ["alpha", "beta"]) {
    const attention = jsonOf(await drive(s.handler, { url: `/api/attention?project=${slug}`, headers: auth(s) }));
    assert.deepEqual(attention.decide.map((item) => [item.id, item.projectSlugs]), [["capacity:glm-pro", ["alpha", "beta"]]], slug);
    const workers = jsonOf(await drive(s.handler, { url: `/api/workers?project=${slug}`, headers: auth(s) }));
    const findable = new Set([...attention.decide, ...attention.anomalies, ...attention.resolved].map((item) => item.id));
    // 该项目的 Workers 行带着的 id，同一个筛选下 /api/attention 一定查得到。
    for (const row of workers.workers) {
      for (const id of row.attentionIds) assert.ok(findable.has(id), `${slug}: ${id} 可查`);
    }
  }
  const overview = jsonOf(await drive(s.handler, { url: "/api/overview", headers: auth(s) }));
  assert.deepEqual(overview.projects.map((project) => [project.slug, project.counts.decide.open]), [["alpha", 1], ["beta", 1]],
    "跨项目事项在每个归属项目都计一次，与其筛选下能查到它一致");
});

// =====================================================================
// 刷新任务：并发合并、定时器链、close()
// =====================================================================
test("REFRESH: 并发的 refreshNow() 只跑一轮（不重叠）", async () => {
  let release = null;
  const { model, calls } = fakeReadModel({
    onRefresh: (n) => (n === 1 ? new Promise((resolve) => { release = resolve; }) : undefined),
  });
  const s = makeServer({ readModel: model });
  const first = s.refreshNow();
  const second = s.refreshNow();
  await settle();
  assert.equal(calls.refresh, 1, "第二轮并入在途的那一轮");
  release();
  assert.deepEqual(await Promise.all([first, second]), ["ready", "ready"]);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.snapshot, 1, "只发布一次");
});

test("REFRESH LOOP: server 一开始监听就冷刷新（listen() 之前不碰读模型），之后 setTimeout 链按间隔刷新", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { model, calls } = fakeReadModel();
  const s = makeServer({ readModel: model, refreshIntervalMs: 5000 });
  assert.equal(calls.refresh, 0, "构造时不刷新");
  assert.equal(calls.snapshot, 0);
  // 驱动几次请求也不会触发刷新：只有"开始监听"才会。
  await drive(s.handler, { url: "/api/overview", headers: auth(s) });
  await drive(s.handler, { url: "/api/workers", headers: auth(s) });
  assert.equal(calls.refresh, 0, "读接口不触发刷新");
  startListening(s);
  await settle();
  assert.equal(calls.refresh, 1, "开始监听后先跑一次冷刷新");
  const r = await drive(s.handler, { url: "/api/overview", headers: auth(s) });
  assert.equal(jsonOf(r).status, "ready");
  t.mock.timers.tick(4999);
  await settle();
  assert.equal(calls.refresh, 1, "间隔未到不刷新");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(calls.refresh, 2, "到点刷新一轮");
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(calls.refresh, 3, "一轮结束后才排下一轮");
  await s.close();
});

test("REFRESH LOOP: 上一轮没结束时不排新一轮（不重叠）；结束后接着排", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release = null;
  const { model, calls } = fakeReadModel({
    onRefresh: (n) => (n === 2 ? new Promise((resolve) => { release = resolve; }) : undefined),
  });
  const s = makeServer({ readModel: model, refreshIntervalMs: 5000 });
  startListening(s);
  await settle();
  t.mock.timers.tick(5000); // 第 2 轮开始，挂起
  await settle();
  assert.equal(calls.refresh, 2);
  t.mock.timers.tick(20 * 5000); // 在途期间过了四个间隔
  await settle();
  assert.equal(calls.refresh, 2, "在途的刷新没结束，不再起新一轮");
  const r = await drive(s.handler, { url: "/api/attention", headers: auth(s) });
  assert.equal(jsonOf(r).status, "ready", "在途期间读接口照常读上一份发布");
  release();
  await settle();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(calls.refresh, 3, "在途的那轮结束后，下一个间隔照常刷新");
  await s.close();
});

test("REFRESH LOOP: 失败的 rounds 也接着排——stale 之后到点自动恢复 ready", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let failing = true;
  const { model } = fakeReadModel({ onRefresh: () => { if (failing) throw new Error(REFRESH_ERROR); } });
  const s = makeServer({ readModel: model, refreshIntervalMs: 5000 });
  startListening(s);
  await settle();
  failing = false;
  t.mock.timers.tick(5000);
  await settle();
  const r = await drive(s.handler, { url: "/api/workers", headers: auth(s) });
  assert.equal(jsonOf(r).status, "ready", "首轮失败后链条没有断");
  await s.close();
});

test("REFRESH LOOP: 注入的 refresh() 同步抛错不把链钉死——排下一轮、到点恢复 ready", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let syncFailing = true;
  let refreshes = 0;
  const syncThrowModel = {
    refresh() {
      refreshes += 1;
      if (syncFailing) throw new Error(REFRESH_ERROR); // 同步抛，不是拒绝
    },
    snapshot: ({ now }) => ({ generatedAt: new Date(now).toISOString(), projects: [], runs: [], consults: [] }),
  };
  const s = makeServer({ readModel: syncThrowModel, refreshIntervalMs: 5000 });
  startListening(s);
  await settle();
  assert.equal(refreshes, 1, "首轮同步抛错");
  assert.equal(jsonOf(await drive(s.handler, { url: "/api/workers", headers: auth(s) })).status, "unavailable");
  syncFailing = false;
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(refreshes, 2, "同步抛错之后链照常排下一轮");
  assert.equal(jsonOf(await drive(s.handler, { url: "/api/workers", headers: auth(s) })).status, "ready");
  await s.close();
});

test("CLOSE: 停掉定时器——在途的那轮结束后不再排下一轮，到点不再刷新", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release = null;
  const { model, calls } = fakeReadModel({
    onRefresh: (n) => (n === 2 ? new Promise((resolve) => { release = resolve; }) : undefined),
  });
  const s = makeServer({ readModel: model, refreshIntervalMs: 5000 });
  startListening(s);
  await settle();
  // 第 2 轮在途时 close：close 等它结束，它结束后不得再排定时器。
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(calls.refresh, 2);
  const closing = s.close();
  release();
  await closing;
  t.mock.timers.tick(60 * 5000);
  await settle();
  assert.equal(calls.refresh, 2, "close 之后没有再刷新");
  const r = await drive(s.handler, { url: "/api/overview", headers: auth(s) });
  assert.equal(jsonOf(r).status, "ready");
});

test("CLOSE: 等在途刷新结束才返回；关掉之后在途轮次不发布", async () => {
  let release = null;
  const { model, calls } = fakeReadModel({ onRefresh: () => new Promise((resolve) => { release = resolve; }) });
  const s = makeServer({ readModel: model });
  const round = s.refreshNow();
  await settle();
  assert.equal(calls.refresh, 1);
  let closed = false;
  const closing = s.close().then(() => { closed = true; });
  await settle();
  assert.equal(closed, false, "在途刷新没结束，close 不返回");
  release();
  assert.equal(await round, "loading", "close 之后在途轮次不发布：状态仍是 loading");
  await closing;
  assert.equal(closed, true);
  assert.equal(calls.snapshot, 0, "close 之后 snapshot 都不取");
  // 关闭之后 refreshNow() 直接返回，不再调读模型。
  assert.equal(await s.refreshNow(), "loading");
  assert.equal(calls.refresh, 1, "关闭之后不调读模型");
});

test("CLOSE: close() 之后迟到的 listening 不启动刷新链；定时器回调与 refreshNow() 都不再发布", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { model, calls } = fakeReadModel();
  const s = makeServer({ readModel: model, refreshIntervalMs: 5000 });
  await s.close();
  startListening(s); // listen() 的 "listening" 在 close() 之后才到
  await settle();
  assert.equal(calls.refresh, 0, "迟到的 listening 不启动刷新链");
  t.mock.timers.tick(60 * 5000);
  await settle();
  assert.equal(calls.refresh, 0, "已触发未执行的定时器也不会再刷新");
  assert.equal(await s.refreshNow(), "loading", "关闭之后 refreshNow 直接返回");
  assert.equal(calls.refresh, 0, "关闭之后 refreshNow 不调读模型");
});

test("REFRESH LOOP: 缺省刷新间隔是 5000（不显式传 refreshIntervalMs）", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { model, calls } = fakeReadModel();
  const s = makeServer({ readModel: model });
  startListening(s);
  await settle();
  assert.equal(calls.refresh, 1, "冷刷新");
  t.mock.timers.tick(4999);
  await settle();
  assert.equal(calls.refresh, 1, "缺省间隔 5000：4999 毫秒不刷新");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(calls.refresh, 2, "到 5000 毫秒刷新");
  await s.close();
});

test("LISTEN (real): 127.0.0.1:0 真起服务、等首轮发布后 close()——之后读模型不再被调用", async () => {
  const { model, calls } = fakeReadModel();
  const s = makeServer({ readModel: model, refreshIntervalMs: 20 });
  const address = await s.listen();
  assert.equal(address.host, "127.0.0.1");
  assert.ok(Number.isInteger(address.port) && address.port > 0, "真实端口");
  // 等首轮发布：真发 HTTP 请求直到 status: ready。
  const ready = await waitFor(async () => {
    const body = await httpJson(s, "/api/overview");
    return body.status === "ready" ? body : null;
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.generatedAt, NOW_ISO);
  const beforeClose = calls.refresh;
  assert.ok(beforeClose >= 1);
  await s.close();
  assert.equal(s.address(), null, "端口已关");
  const afterClose = calls.refresh;
  await new Promise((resolve) => setTimeout(resolve, 100)); // 5 个刷新间隔
  assert.equal(calls.refresh, afterClose, "close 之后读模型不再被调用");
  assert.equal(await s.refreshNow(), "ready", "已发布过：关闭后直接返回当前状态");
  assert.equal(calls.refresh, afterClose, "关闭之后 refreshNow 不调读模型");
});

test("LISTEN (real): listen() 后立刻 close()（listening 还没发出）——迟到的 listening 不启动链，socket 关掉", async () => {
  const { model, calls } = fakeReadModel();
  const s = makeServer({ readModel: model, refreshIntervalMs: 20 });
  const listening = s.listen();
  const closing = s.close(); // 不等 listening
  await Promise.all([listening, closing]);
  await new Promise((resolve) => setTimeout(resolve, 80)); // 4 个刷新间隔
  assert.equal(calls.refresh, 0, "close 之后迟到的 listening 没启动刷新链");
  assert.equal(calls.snapshot, 0);
  assert.equal(s.address(), null, "socket 已关");
  assert.equal(await s.refreshNow(), "loading", "关闭之后 refreshNow 直接返回");
  assert.equal(calls.refresh, 0);
});

// =====================================================================
// LIFECYCLE：listen() / close() 的终局与幂等（真实端口）
// =====================================================================
test("LIFECYCLE: listen() 撞上已占用端口 → 拒绝；close() 立即完成（不挂起）", async () => {
  const { blocker, port } = await occupyPort();
  try {
    const { model, calls } = fakeReadModel();
    const s = makeServer({ readModel: model, port });
    await assert.rejects(withTimeout(s.listen(), 3000, "listen"), /EADDRINUSE/);
    // listen 失败不是"在途 listen"：close 必须立即完成，而不是等一个永远不会来的 listening。
    await withTimeout(s.close(), 2000, "close after failed listen");
    assert.equal(s.address(), null);
    assert.equal(s.server.listening, false);
    assert.equal(calls.refresh, 0, "listen 失败没有启动刷新链");
    // 失败之后重复 close 也完成（同一个 Promise）。
    const again = s.close();
    await withTimeout(again, 2000, "second close after failed listen");
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test("LIFECYCLE: close() 幂等——两次调用返回同一个 Promise，都完成；成功关闭后重复调用也一样", async () => {
  const { model } = fakeReadModel();
  // ① 从未 listen：第一次与第二次是同一个 Promise，且立刻完成。
  const s = makeServer({ readModel: model });
  try {
    const first = s.close();
    const second = s.close();
    assert.equal(first, second, "同一个 Promise");
    await withTimeout(first, 2000, "first close");
    assert.equal(s.close(), first, "完成之后仍返回同一个（已完成的）Promise");
    await withTimeout(second, 2000, "second close");
  } finally {
    await withTimeout(s.close(), 2000, "cleanup close");
  }
  // ② 真监听后 close()：并发两次拿到同一个 Promise，都完成、端口关掉。
  const listening = makeServer({ readModel: fakeReadModel().model, refreshIntervalMs: 20 });
  try {
    await withTimeout(listening.listen(), 3000, "listen");
    const a = listening.close();
    const b = listening.close();
    assert.equal(a, b, "监听中 close 也返回同一个 Promise");
    await withTimeout(Promise.all([a, b]), 3000, "close after listen");
    assert.equal(listening.address(), null, "端口已关");
    assert.equal(listening.close(), a, "关闭后重复调用还是同一个 Promise");
  } finally {
    // 失败路径（例如旧实现不是幂等）也要把端口关掉，别让测试进程挂着。
    await withTimeout(listening.close(), 3000, "cleanup close after listen");
  }
});

test("LIFECYCLE: close() 之后 listen() 直接拒绝，不再打开端口", async () => {
  const { model, calls } = fakeReadModel();
  const s = makeServer({ readModel: model });
  try {
    await withTimeout(s.close(), 2000, "close");
    await assert.rejects(withTimeout(s.listen(), 2000, "listen after close"), /closed/i);
    assert.equal(s.address(), null, "没有打开端口");
    assert.equal(s.server.listening, false);
    assert.equal(calls.refresh, 0, "没有启动刷新链");
  } finally {
    // 旧实现会真的把端口开起来（测试此时已失败）：这里再关一次，别留下监听句柄。
    await withTimeout(s.close(), 3000, "cleanup close after late listen");
  }
});

// =====================================================================
// 缺省接线与配置校验
// =====================================================================
test("DEFAULT WIRING: 不注入 createReadModelFn 时用 createOwnerReadModel({ runDir, nowFn })", async () => {
  // 不存在的运行目录 = 空存储：零个运行，如实报告（不碰仓库的 runs/）。
  const base = mkdtempSync(join(tmpdir(), "wao-od-api-"));
  const runDir = join(base, "runs");
  try {
    const s = createOwnerDashboardServer({
      runDir, workspaceRoot: join(base, "ws"), knownAgentIds: [], env: {},
      getOwnerRunsFn: unusedRunsFn, getOwnerActivityFn: unusedActivityFn,
      nowFn: () => NOW,
    });
    assert.equal(await s.refreshNow(), "ready");
    const r = await drive(s.handler, { url: "/api/overview", headers: auth(s) });
    assert.deepEqual(jsonOf(r), {
      status: "ready", generatedAt: NOW_ISO, counts: ZERO_COUNTS, projects: [], lanes: [],
    });
    assert.ok(!r.body.includes(base), "运行目录不出接口");
    const w = await drive(s.handler, { url: "/api/workers", headers: auth(s) });
    assert.deepEqual(jsonOf(w), { status: "ready", generatedAt: NOW_ISO, truncated: false, workers: [] });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("CONFIG: refreshIntervalMs 缺省 5000；不是正整数时构造时就拒绝（listen 之前）", async () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, "5000", null]) {
    assert.throws(() => makeServer({ readModel: fakeReadModel().model, refreshIntervalMs: bad }), /refreshIntervalMs/i,
      `rejects ${String(bad)} before listen`);
  }
  for (const good of [1, 5000, 60_000]) {
    assert.doesNotThrow(() => makeServer({ readModel: fakeReadModel().model, refreshIntervalMs: good }), `accepts ${good}`);
  }
});

// =====================================================================
// 旧接口不受影响
// =====================================================================
test("LEGACY: /api/runs 与 /api/activity 不受刷新状态影响——loading 时照常服务，读模型一轮都没跑", async () => {
  const { model, calls } = fakeReadModel();
  let runsCalls = 0;
  let activityCalls = 0;
  const s = createOwnerDashboardServer({
    runDir: RUN_DIR, workspaceRoot: WORKSPACE_ROOT, knownAgentIds: [], env: {},
    getOwnerRunsFn: async () => { runsCalls += 1; return { runs: [{ runId: "run_a" }], returnedCount: 1, matchedCount: 1, truncated: false }; },
    getOwnerActivityFn: async (input) => { activityCalls += 1; return { ...unusedActivityFn(input), liveness: { ownerHeartbeat: "fresh", secondsSinceHeartbeat: 1 } }; },
    nowFn: () => NOW,
    createReadModelFn: () => model,
  });
  const runs = await drive(s.handler, { url: "/api/runs?limit=1", headers: auth(s) });
  assert.deepEqual(jsonOf(runs), { runs: [{ runId: "run_a" }], returnedCount: 1, matchedCount: 1, truncated: false });
  const activity = await drive(s.handler, { url: "/api/activity?runId=run_a", headers: auth(s) });
  assert.equal(jsonOf(activity).liveness.ownerHeartbeat, "fresh");
  assert.equal(runsCalls, 1);
  assert.equal(activityCalls, 1);
  assert.equal(calls.refresh, 0, "旧接口不触发读模型刷新");
  // 旧接口的查询参数闭集不变。
  const bad = await drive(s.handler, { url: "/api/runs?project=alpha", headers: auth(s) });
  assert.equal(bad.status, 400);
  const unknown = await drive(s.handler, { url: "/api/overview/runs", headers: auth(s) });
  assert.equal(unknown.status, 404);
});

test("TOKEN: 令牌不出现在三个接口任何状态的响应体或响应头里", async () => {
  const { model } = fakeReadModel();
  const s = makeServer({ readModel: model });
  const cases = [
    ...ROUTES.map((url) => ({ url, headers: auth(s) })), // loading
    ...ROUTES.map((url) => ({ url })), // 401
    { url: "/api/workers?project=../x", headers: auth(s) }, // 400
    { url: "/api/overview?x=1", headers: auth(s) }, // 400
    { method: "POST", url: "/api/attention", headers: auth(s) }, // 405
  ];
  for (const c of cases) {
    const r = await drive(s.handler, c);
    assert.ok(!r.body.includes(s.token), `token absent from body (${c.method || "GET"} ${c.url})`);
    assert.ok(!JSON.stringify(r.headers).includes(s.token), `token absent from headers (${c.method || "GET"} ${c.url})`);
    assertSafeHeaders(r);
  }
  await s.refreshNow();
  for (const url of ROUTES) {
    const r = await drive(s.handler, { url, headers: auth(s) });
    assert.ok(!r.body.includes(s.token));
    assertSafeHeaders(r);
  }
});

// =====================================================================
// 第 142 批修正一：线上（真实推导 + 真实 DTO）的事件号、交付提交、会审席、额度进 Alerts
// =====================================================================
const getJson = async (s, url) => jsonOf(await drive(s.handler, { url, headers: auth(s) }));

/** 在 fixtureSnapshot 的基础上改运行行 / 加会审组（快照形状，和读模型给的一致）。 */
function snapshotWith(mutate) {
  return () => {
    const snap = fixtureSnapshot();
    mutate(snap);
    return snap;
  };
}

test("WIRE SEQ: 快照里记下的事件号经事项推导与 DTO 原样到线上；读不到的仍是 null，不合法的不透传", async () => {
  const { s } = await readyServer({
    snapshotFactory: snapshotWith((snap) => {
      const byId = (id) => snap.runs.find((run) => run.runId === id);
      byId("run_fail").terminalSeq = 41;
      byId("run_fail").capacity.observedSeq = 33;
      byId("run_wait").delivery.settledSeq = 52;
      // 一个静默的运行：quietSince 所取事件的事件号。
      snap.runs.push(runRow({
        runId: "run_quiet", state: "running", terminal: false, liveness: "silent", stage: "active", deliveryRequested: false,
        startedAt: ago(3 * HOUR), terminalAt: null, quietSince: ago(HOUR), quietSinceSeq: 17,
      }));
      // 一个已裁决的交付：裁决事件号进解除证据。
      snap.runs.push(runRow({
        runId: "run_done", delivery: {
          settlement: { status: "settled", reason: "delivery_settled" }, commit: "d".repeat(40),
          verification: { status: "passed", reverify: { status: "none", reason: null } },
          acceptance: { status: "accepted", decidedAt: ago(HOUR), decidedSeq: 63 }, settledAt: ago(4 * HOUR), settledSeq: 62,
          ambiguous: false, packagingFailure: null, isolationFailure: null, branchPresent: true,
        },
      }));
      // 事件号不合法的运行：线上是 null（不透传 "7"、0、小数）。
      snap.runs.push(runRow({
        runId: "run_badseq", state: "failed", deliveryRequested: false, terminalAt: ago(2 * HOUR), terminalSeq: "7",
        failure: { category: "provider_error", code: "backend_error" },
      }));
    }),
  });
  const attention = await getJson(s, "/api/attention");
  const item = (list, id) => list.find((entry) => entry.id === id);
  assert.deepEqual(item(attention.decide, "awaiting_decision:run_wait").evidence, [{ runId: "run_wait", at: ago(3 * HOUR), seq: 52 }]);
  assert.deepEqual(item(attention.decide, "capacity:kimi").evidence, [{ runId: "run_fail", at: ago(HOUR), seq: 33 }]);
  assert.deepEqual(item(attention.anomalies, "capacity_alert:kimi").evidence, [{ runId: "run_fail", at: ago(HOUR), seq: 33 }]);
  assert.deepEqual(item(attention.anomalies, "failed:run_fail").evidence, [{ runId: "run_fail", at: ago(HOUR), seq: 41 }]);
  assert.deepEqual(item(attention.anomalies, "silent:run_quiet").evidence, [{ runId: "run_quiet", at: ago(HOUR), seq: 17 }]);
  assert.deepEqual(item(attention.resolved, "awaiting_decision:run_done").evidence.map((entry) => entry.seq), [62, 63]);
  assert.deepEqual(item(attention.anomalies, "failed:run_badseq").evidence.map((entry) => entry.seq), [null]);
  // 没记事件号的旧行：全是 null（没有编造）。
  assert.deepEqual(attention.anomalies.flatMap((entry) => entry.evidence).filter((entry) => entry.runId === "run_wait"), []);
});

test("WIRE COMMIT + SEATS: 交付类事项带当前提交（读不出是 null）；会审事项带被审运行的提交与全部席位运行；别的种类没有这两项", async () => {
  const seat = (runId, q1, extra = {}) => ({ agentId: `seat_${runId}`, runId, runState: "completed", q1, replied: true, ...extra });
  const { s } = await readyServer({
    snapshotFactory: snapshotWith((snap) => {
      snap.runs.push(
        runRow({ runId: "run_seat1", deliveryRequested: false }),
        runRow({ runId: "run_seat2", deliveryRequested: false }),
        runRow({ runId: "run_seat3", deliveryRequested: false, state: "running", terminal: false, liveness: "progress", stage: "active", terminalAt: null }),
        // 提交读不出（创建与验证引用了不同提交）的交付：事项在，commit 为 null。
        runRow({
          runId: "run_nocommit", delivery: {
            settlement: { status: "undeterminable", reason: "delivery_facts_malformed" }, commit: null, verification: null,
            acceptance: { status: null, decidedAt: null }, settledAt: null, ambiguous: true,
            packagingFailure: null, isolationFailure: null, branchPresent: true,
          },
        }),
      );
      snap.consults = [{
        consultId: "consult_1", projectSlug: "alpha", createdAt: ago(3 * HOUR), reviewedRunId: "run_wait", q1Declared: true, declaredFields: null,
        seats: [seat("run_seat1", "PASS"), seat("run_seat2", "FIX_FIRST"), seat("run_seat3", null, { runState: "running", replied: false })],
      }];
    }),
  });
  const attention = await getJson(s, "/api/attention");
  const item = (list, id) => list.find((entry) => entry.id === id);
  const split = item(attention.decide, "consult_split:alpha:consult_1");
  assert.equal(split.commit, "c".repeat(40), "被审运行 run_wait 的提交");
  assert.deepEqual(split.runIds, ["run_wait"]);
  assert.deepEqual(split.seatRunIds, ["run_seat1", "run_seat2", "run_seat3"], "全部席位运行，含还没给结论的");
  assert.deepEqual(split.evidence.map((entry) => entry.runId), ["run_seat1", "run_seat2"], "证据只列给了结论的席位");
  assert.equal(item(attention.decide, "awaiting_decision:run_wait").commit, "c".repeat(40));
  assert.equal(item(attention.decide, "delivery_ambiguous:run_nocommit").commit, null, "读不出：null，页面标未知");
  assert.equal("seatRunIds" in item(attention.decide, "awaiting_decision:run_wait"), false);
  for (const id of ["failed:run_fail", "capacity_alert:kimi"]) {
    const entry = item(attention.anomalies, id);
    assert.equal("commit" in entry, false, `${id} 不是交付类事项`);
    assert.equal("seatRunIds" in entry, false);
  }
  assert.equal("commit" in item(attention.decide, "capacity:kimi"), false);
  // 提交只在事项里，不进 /api/workers 的交付摘要。
  assert.ok(!JSON.stringify(await getJson(s, "/api/workers")).includes("c".repeat(40)));
});

test("WIRE SEATS: /api/workers 的行给会审席位所在组的摘要 { groupId, seatsIn, seatsTotal }；不是席位 / 没有组记录是 null", async () => {
  const seats = [
    { agentId: "a", runId: "run_seat1", runState: "completed", q1: "PASS", replied: true },
    { agentId: "b", runId: "run_seat2", runState: "completed", q1: null, replied: false },
    { agentId: "c", runId: "run_seat3", runState: "running", q1: null, replied: false },
  ];
  const live = (runId) => runRow({ runId, state: "running", terminal: false, liveness: "progress", stage: "active", deliveryRequested: false, terminalAt: null });
  const { s } = await readyServer({
    snapshotFactory: snapshotWith((snap) => {
      snap.runs.push(live("run_seat1"), live("run_seat2"), live("run_seat3"));
      snap.consults = [{ consultId: "consult_9", projectSlug: "alpha", createdAt: ago(HOUR), reviewedRunId: "run_wait", q1Declared: false, declaredFields: null, seats }];
    }),
  });
  const workers = (await getJson(s, "/api/workers")).workers;
  const row = (id) => workers.find((entry) => entry.runId === id);
  for (const id of ["run_seat1", "run_seat2", "run_seat3"]) {
    assert.deepEqual(row(id).consult, { groupId: "alpha:consult_9", seatsIn: 1, seatsTotal: 3 }, `${id}: 完成且答复的一席已到；完成没答复的、在跑的不算`);
    assert.deepEqual(sortedKeys(row(id).consult), ["groupId", "seatsIn", "seatsTotal"]);
  }
  assert.equal(row("run_live").consult, null, "不是会审席位");
  assert.equal(row("run_wait").consult, null, "被审运行不是席位");
  assert.ok(!JSON.stringify(workers).includes("seatRunIds"));
});

test("WIRE ALERTS: 额度用尽与限流同时出现——顶部计数、项目计数、两栏列表同口径；Needs you 只数额度用尽，Alerts 数镜像 + 限流 + 失败", async () => {
  const limited = (runId, laneId) => runRow({
    runId, laneId, agentId: laneId, state: "failed", deliveryRequested: false, terminalAt: ago(HOUR),
    failure: { category: "provider_capacity", code: "rate_limited" }, capacity: { code: "rate_limited", observedAt: ago(HOUR) },
  });
  const { s } = await readyServer({ snapshotFactory: snapshotWith((snap) => { snap.runs.push(limited("run_rl", "opus")); }) });
  const overview = await getJson(s, "/api/overview");
  const attention = await getJson(s, "/api/attention");
  // fixture：等裁决 + kimi 额度用尽 → Needs you 2；失败的 run_fail、run_rl + kimi 额度镜像 + opus 限流 → Alerts 4。
  assert.deepEqual(attention.decide.map((item) => item.id), ["awaiting_decision:run_wait", "capacity:kimi"]);
  assert.deepEqual(attention.anomalies.map((item) => item.id).sort(), ["capacity_alert:kimi", "failed:run_fail", "failed:run_rl", "rate_limited:opus"]);
  assert.deepEqual(overview.counts.decide, { open: attention.decide.length, unknown: 0 });
  assert.deepEqual(overview.counts.anomalies, { open: attention.anomalies.length, unknown: 0 });
  assert.deepEqual(overview.projects[0].counts.decide, overview.counts.decide, "项目计数与全局同口径");
  assert.deepEqual(overview.projects[0].counts.anomalies, overview.counts.anomalies);
  // 车道行点名两条车道，各一行。
  assert.deepEqual(overview.lanes.filter((lane) => lane.capacity !== null).map((lane) => [lane.laneKey, lane.capacity.kind]), [["kimi", "quota_exhausted"], ["opus", "rate_limited"]]);
  // 按项目筛选同口径。
  const filtered = await getJson(s, "/api/attention?project=alpha");
  assert.deepEqual(filtered.anomalies.map((item) => item.id).sort(), attention.anomalies.map((item) => item.id).sort());
});

test("WIRE FOLLOW-UP: a failure whose retry already started and failed again says 'exists' with the retry's state; no retry (complete census) is 'none'; an unreadable run makes it 'unknown'", async () => {
  const failedRow = (runId, over = {}) => runRow({
    runId, state: "failed", deliveryRequested: false, terminalAt: ago(3 * HOUR), failure: { category: "provider_error", code: "backend_error" }, ...over,
  });
  const retryRow = (runId, state, over = {}) => runRow({
    runId, retryOf: "run_first", state, terminal: state !== "running", deliveryRequested: false, startedAt: ago(2 * HOUR),
    terminalAt: state === "running" ? null : ago(HOUR), ...over,
  });
  const followUpOf = async (rows) => {
    const { s } = await readyServer({ snapshotFactory: snapshotWith((snap) => { snap.runs = rows; }) });
    const item = (await getJson(s, "/api/attention")).anomalies.find((entry) => entry.id === "failed:run_first");
    return { followUp: item.followUp, followUpRuns: item.followUpRuns };
  };
  assert.deepEqual(await followUpOf([failedRow("run_first"), retryRow("run_retry", "failed")]), { followUp: "exists", followUpRuns: [{ runId: "run_retry", state: "failed" }] });
  assert.deepEqual(await followUpOf([failedRow("run_first"), retryRow("run_retry", "running")]), { followUp: "exists", followUpRuns: [{ runId: "run_retry", state: "running" }] });
  assert.deepEqual(await followUpOf([failedRow("run_first")]), { followUp: "none", followUpRuns: [] });
  assert.deepEqual(await followUpOf([failedRow("run_first"), runRow({ runId: "run_blind", availability: "unreadable", project: null })]), { followUp: "unknown", followUpRuns: [] });
  // Only the two whitelisted keys of a follow-up run reach the wire (a hostile extra field on the row does not).
  const { s } = await readyServer({ snapshotFactory: snapshotWith((snap) => { snap.runs = [failedRow("run_first"), retryRow("run_retry", "failed", { secret: "SECRET_MARKER" })]; }) });
  const body = await getJson(s, "/api/attention");
  assert.deepEqual(sortedKeys(body.anomalies.find((entry) => entry.id === "failed:run_first").followUpRuns[0]), ["runId", "state"]);
  assert.ok(!JSON.stringify(body).includes("SECRET_MARKER"));
});
