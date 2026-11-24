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
//     首轮就失败且从未发布时仍是 loading；失败的三种来源（refresh / snapshot / 推导抛）走
//     同一条路径；鉴权与参数校验先于 loading
//   - 同一个 now：snapshot({ now }) 与事项推导用的是同一轮的同一个时刻；三个接口读同一份
//     发布，状态 / 时刻 / 计数一致
//   - DTO 白名单：行与事项只有页面要的字段，快照里的敌意附加字段一个都不透传；响应里没有
//     路径形状的字符串
//   - Workers：默认范围、按 startedAt 倒序、上限 500 与 truncated、按项目筛选
//   - 刷新任务：并发的 refreshNow 只跑一轮；server 一开始监听就冷刷新（listen() 之前不碰读
//     模型），之后定时器链按间隔刷新且不重叠；close() 停掉定时器、等在途刷新结束
//   - 缺省接线：不注入时用 createOwnerReadModel({ runDir, nowFn })；非法 refreshIntervalMs
//     在构造时就拒绝
//   - 旧的 /api/runs 与 /api/activity 不受刷新状态影响

import { test } from "node:test";
import assert from "node:assert/strict";
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
  verifying: 0, deliveryUnobservable: 0, decide: { open: 2, unknown: 0 }, anomalies: { open: 1, unknown: 0 },
};
const EXPECTED_OVERVIEW = {
  status: "ready",
  generatedAt: NOW_ISO,
  counts: ALPHA_COUNTS,
  projects: [{
    slug: "alpha", name: "Alpha", repo: "available", consultRecords: "available", counts: ALPHA_COUNTS,
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
      projectSlug: "alpha", since: ago(3 * HOUR), evidence: [{ runId: "run_wait", at: ago(3 * HOUR), seq: null }],
    },
    {
      id: "capacity:kimi", kind: "quota_exhausted", state: "open", runIds: ["run_fail"], projectSlug: "alpha",
      since: ago(HOUR), laneKey: "kimi", evidence: [{ runId: "run_fail", at: ago(HOUR), seq: null }],
    },
  ],
  anomalies: [{
    id: "failed:run_fail", kind: "failed", state: "open", runIds: ["run_fail"], projectSlug: "alpha", since: ago(HOUR),
    followUp: "unknown", failure: { category: "provider_capacity", code: "quota_exhausted" },
    evidence: [{ runId: "run_fail", at: ago(HOUR), seq: null }],
  }],
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
      lastEffectAt: ago(3 * HOUR), quietSince: ago(4 * HOUR), delivery: null, failure: null, attentionIds: [],
    },
    {
      runId: "run_fail", project: ALPHA, title: "任务 run_fail", subtitle: null, taskType: "code", laneKey: "kimi",
      roleId: "coder", state: "failed", liveness: "terminal", stage: "terminal", startedAt: ago(2 * HOUR),
      terminalAt: ago(HOUR), lastEffectAt: ago(3 * HOUR), quietSince: ago(4 * HOUR), delivery: null,
      failure: { category: "provider_capacity", code: "quota_exhausted" }, attentionIds: ["capacity:kimi", "failed:run_fail"],
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
      failure: null, attentionIds: ["awaiting_decision:run_wait"],
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
function makeServer({ readModel, refreshIntervalMs, nowFn } = {}) {
  const clock = typeof nowFn === "function" ? nowFn : () => NOW;
  return createOwnerDashboardServer({
    runDir: RUN_DIR, workspaceRoot: WORKSPACE_ROOT, knownAgentIds: [], env: {},
    getOwnerRunsFn: unusedRunsFn, getOwnerActivityFn: unusedActivityFn,
    nowFn: clock,
    ...(readModel !== undefined ? { createReadModelFn: () => readModel } : {}),
    ...(refreshIntervalMs !== undefined ? { refreshIntervalMs } : {}),
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

test("LOADING: 首轮刷新就失败、从未发布过——仍是 loading，错误原文不出接口", async () => {
  const { model } = fakeReadModel({ onRefresh: () => { throw new Error(REFRESH_ERROR); } });
  const s = makeServer({ readModel: model });
  assert.equal(await s.refreshNow(), "loading");
  assert.equal(await s.refreshNow(), "loading");
  for (const url of ROUTES) {
    const r = await drive(s.handler, { url, headers: auth(s) });
    assert.deepEqual(jsonOf(r), { status: "loading" });
    assert.ok(!r.body.includes("EACCES"), "错误原文不出接口");
    assertNoPaths(r);
  }
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

test("REFRESH ERROR SOURCES: snapshot() 抛、事项推导抛——与 refresh() 抛走同一条失败路径，错误原文不出接口", async () => {
  // snapshot() 抛：从未发布，仍是 loading。
  const brokenSnapshot = { refresh: async () => {}, snapshot: () => { throw new TypeError(`snapshot exploded at ${RUN_DIR}`); } };
  const s = makeServer({ readModel: brokenSnapshot });
  assert.equal(await s.refreshNow(), "loading");
  assert.equal(await s.refreshNow(), "loading");
  for (const url of ROUTES) {
    const r = await drive(s.handler, { url, headers: auth(s) });
    assert.deepEqual(jsonOf(r), { status: "loading" });
    assert.ok(!r.body.includes("exploded"), "错误原文不出接口");
    assertNoPaths(r);
  }
  // 事项推导抛：now 不是可表示的时刻时 deriveOwnerAttention 抛 TypeError（真实链路里读模型的
  // snapshot 会先抛，走的是同一条路径）。
  let clock = NOW;
  const steady = { refresh: async () => {}, snapshot: () => ({ generatedAt: NOW_ISO, projects: [], runs: [], consults: [] }) };
  const s2 = makeServer({ readModel: steady, nowFn: () => clock });
  assert.equal(await s2.refreshNow(), "ready");
  clock = NaN;
  assert.equal(await s2.refreshNow(), "stale", "推导抛错 → 保留上一份发布并标 stale");
  for (const url of ROUTES) {
    const body = jsonOf(await drive(s2.handler, { url, headers: auth(s2) }));
    assert.equal(body.status, "stale", url);
    assert.equal(body.generatedAt, NOW_ISO, "数据仍是上一份发布");
    assert.equal(body.staleSince, null, "时钟坏了就说不清失败时刻，如实 null");
  }
  clock = NOW + SECOND;
  assert.equal(await s2.refreshNow(), "ready", "时钟恢复后下一轮成功");
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
  assert.deepEqual(r.anomalies.map((item) => item.id), ["failed:run_edge", "failed:run_quota"]);
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
  assert.deepEqual(sortedKeys(overview.projects[0]), ["consultRecords", "counts", "name", "repo", "slug"]);
  assert.deepEqual(sortedKeys(overview.lanes[1]), ["capacity", "laneKey", "running"]);
  assert.deepEqual(sortedKeys(overview.lanes[1].capacity), ["kind", "observedAt", "state"]);
  assert.deepEqual(sortedKeys(workers), ["generatedAt", "status", "truncated", "workers"]);
  assert.deepEqual(sortedKeys(workers.workers[0]), [
    "attentionIds", "delivery", "failure", "laneKey", "lastEffectAt", "liveness", "project", "quietSince", "roleId",
    "runId", "stage", "startedAt", "state", "subtitle", "taskType", "terminalAt", "title",
  ]);
  assert.deepEqual(sortedKeys(workers.workers[0].project), ["name", "slug"]);
  assert.deepEqual(sortedKeys(workers.workers[2].delivery), ["acceptance", "branchPresent", "settlement", "verification"]);
  assert.deepEqual(sortedKeys(workers.workers[2].delivery.settlement), ["reason", "status"]);
  assert.deepEqual(sortedKeys(workers.workers[2].delivery.verification), ["status"]);
  assert.deepEqual(sortedKeys(workers.workers[2].delivery.acceptance), ["status"]);
  assert.deepEqual(sortedKeys(workers.workers[1].failure), ["category", "code"]);
  assert.deepEqual(sortedKeys(attention), ["anomalies", "decide", "generatedAt", "resolved", "status"]);
  assert.deepEqual(sortedKeys(attention.decide[0]), ["evidence", "id", "kind", "projectSlug", "runIds", "since", "state"]);
  assert.deepEqual(sortedKeys(attention.decide[1]), ["evidence", "id", "kind", "laneKey", "projectSlug", "runIds", "since", "state"]);
  assert.deepEqual(sortedKeys(attention.anomalies[0]), ["evidence", "failure", "followUp", "id", "kind", "projectSlug", "runIds", "since", "state"]);
  assert.deepEqual(sortedKeys(attention.anomalies[0].evidence[0]), ["at", "runId", "seq"]);
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

test("CLOSE: 等在途刷新结束才返回", async () => {
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
  assert.equal(await round, "ready");
  await closing;
  assert.equal(closed, true);
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
