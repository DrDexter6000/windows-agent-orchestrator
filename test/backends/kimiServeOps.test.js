// test/backends/kimiServeOps.test.js
//
// TD-256 批（TD-252 收口）原语钉：probeServeSession 缺字段纪律 + listServeSessions
// 的 archived_only 面。
//
// 契约：
//   - probeServeSession：detail 返回 code 0 但 busy/main_turn_active 双字段全部
//     缺席 → {ok:false, reason:"shape_unknown"}——"未知"不得折叠成"空闲"（sweep
//     会据此删会话；sol 会审以注入响应实证旧实现返回 busy:false）。TD-362 起投影后
//     还要求 detail 有非空 id（缺身份不证成"这个会话"）。
//   - listServeSessions({archivedOnly:true})：同一端点 + archived_only=true 查询参
//     （0057 W2 实测：sessions:archive 归档的会话默认列表隐藏、此参数可见——
//     归档≠不可运行）；翻页/fail-closed 语义与默认面同款（既有钉在
//     serveMaintenance.test.js 的 ops 注入面，这里只钉 URL 形状与去重）。
//
// TD-362（kimi 2.7.2，2026-11-20 实测）：2.7 会话对象用 activity 闭集
// idle|turn|background 取代 2.6 的 busy/main_turn_active——本文件用
// test/fixtures/kimi-2.7.2/ 的实录钉投影函数与两个 ops 读取点。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { probeServeSession, listServeSessions, projectSessionActivity } from "../../src/backends/kimiServeOps.js";

function jsonResponse(body) {
  return { status: 200, text: async () => JSON.stringify(body) };
}

test("TD-256: probeServeSession——双忙碌字段全缺席 → shape_unknown 拒判（不折叠成空闲）", async () => {
  const r = await probeServeSession({
    baseUrl: "http://x", token: "t", sessionId: "s1",
    fetchImpl: async () => jsonResponse({ code: 0, msg: "ok", data: { workspace_id: "wd_1" } }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "shape_unknown");
});

test("TD-256: probeServeSession——单字段在场即可判（busy:true 主导；main_turn_active:true 同）", async () => {
  let r = await probeServeSession({
    baseUrl: "http://x", token: "t", sessionId: "s1",
    fetchImpl: async () => jsonResponse({ code: 0, data: { id: "s1", busy: true } }),
  });
  assert.deepEqual({ ok: r.ok, busy: r.busy }, { ok: true, busy: true });
  r = await probeServeSession({
    baseUrl: "http://x", token: "t", sessionId: "s1",
    fetchImpl: async () => jsonResponse({ code: 0, data: { id: "s1", main_turn_active: true } }),
  });
  assert.deepEqual({ ok: r.ok, busy: r.busy }, { ok: true, busy: true });
});

test("TD-252①: listServeSessions archivedOnly=true——URL 带 archived_only 参数；分页/去重同款", async () => {
  const paths = [];
  const makePage = (items, hasMore) => ({ code: 0, data: { items, has_more: hasMore } });
  const r = await listServeSessions({
    baseUrl: "http://x", token: "t", archivedOnly: true,
    fetchImpl: async (url) => {
      paths.push(String(url));
      if (paths.length === 1) return jsonResponse(makePage([{ id: "arch1", busy: false, main_turn_active: false, workspace_id: "w1" }, { id: "arch1", busy: false }], true));
      return jsonResponse(makePage([{ id: "arch2", busy: true, main_turn_active: false }], false));
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 2, "同 id 去重");
  assert.deepEqual(r.items.map((i) => i.id), ["arch1", "arch2"]);
  assert.ok(paths[0].includes("archived_only=true"), `URL 必须带归档参数：${paths[0]}`);
  assert.ok(paths[1].includes("archived_only=true"), "翻页页同样带参");
  assert.ok(paths[1].includes("before_id=arch1"), "游标翻页同款");
  // 默认面不带参（既有语义回归）
  const p2 = [];
  await listServeSessions({
    baseUrl: "http://x", token: "t",
    fetchImpl: async (url) => { p2.push(String(url)); return jsonResponse(makePage([], false)); },
  });
  assert.ok(!p2[0].includes("archived_only"), "默认面不带归档参数");
});

test("TD-256 验收 sol#3: 列表层三形状拒判——缺 has_more/缺 id/双忙碌字段全缺 → shape_unknown", async () => {
  const call = (data) => listServeSessions({
    baseUrl: "http://x", token: "t",
    fetchImpl: async () => jsonResponse(data),
  });
  let r = await call({ code: 0, data: { items: [{ id: "s1", busy: false }] } }); // 无 has_more
  assert.equal(r.ok, false); assert.equal(r.reason, "shape_unknown");
  r = await call({ code: 0, data: { items: [{ id: "s1", busy: false }], has_more: false, extra: [{ noId: true }] } });
  r = await call({ code: 0, data: { items: [{ busy: false }], has_more: false } }); // 条目缺 id
  assert.equal(r.ok, false); assert.equal(r.reason, "shape_unknown");
  r = await call({ code: 0, data: { items: [{ id: "s1", workspace_id: "w" }], has_more: false } }); // 双忙碌字段全缺
  assert.equal(r.ok, false); assert.equal(r.reason, "shape_unknown");
});

// ===== TD-362（kimi 2.7.2）：activity → busy/main_turn_active 读取边界投影 =====

const KIMI_272_DIR = new URL("../fixtures/kimi-2.7.2/", import.meta.url);
const KIMI_263_DIR = new URL("../fixtures/kimi-2.6.3/", import.meta.url);
/** 读一份实录响应：{http, json}。 */
const recorded = (dir, name) => JSON.parse(readFileSync(new URL(name, dir), "utf8"));

test("TD-362: projectSessionActivity——2.7 的 idle/turn/background 投影成 2.6 双字段（实录三份详情）", () => {
  // 三个值各取一份真实 2.7.2 详情：新建会话（idle）、工具调用在途（turn）、
  // 轮结束后后台任务还在跑（background）。
  const cases = [
    ["session-detail-fresh.json", "idle", false, false],
    ["t1-tools-session-running.json", "turn", true, true],
    ["t6-background-session-after-turn.json", "background", true, false],
  ];
  for (const [name, activity, busy, mainTurnActive] of cases) {
    const detail = recorded(KIMI_272_DIR, name).json.data;
    assert.equal(detail.activity, activity, `${name} 的 activity 原值`);
    const projected = projectSessionActivity(detail);
    assert.deepEqual(
      { busy: projected.busy, main_turn_active: projected.main_turn_active },
      { busy, main_turn_active: mainTurnActive },
      `${name}：${activity} 的对应关系`,
    );
    assert.equal(projected.activity, activity, "副本保留 activity 原值");
    assert.equal(projected.id, detail.id, "副本保留其余字段");
    assert.equal(detail.busy, undefined, "原对象不被改写（2.7 实录本来没有双字段）");
  }
});

test("TD-362: projectSessionActivity——activity 闭集外 → null（形状不认识）；2.6 形状原样返回", () => {
  for (const activity of ["paused", "TURN", "", null, 0, true, "toString"]) {
    assert.equal(
      projectSessionActivity({ id: "s1", activity }),
      null,
      `闭集外 activity=${JSON.stringify(activity)} 必须拒判（原型链上的键同样不算）`,
    );
  }
  // ToPropertyKey 陷阱（sol 会审复现）：数组会被折叠成属性键 "idle"——类型必须先卡，
  // 否则 {"activity":["idle"]} 会被当成空闲。数字/对象/null 同罪。
  const nonStringActivity = [["idle"], ["turn"], ["background"], 42, { value: "idle" }, null];
  for (const activity of nonStringActivity) {
    assert.equal(
      projectSessionActivity({ id: "s1", activity }),
      null,
      `非字符串 activity=${JSON.stringify(activity)} 不得被折叠成闭集值`,
    );
  }
  // 2.6.3 的后台任务详情（轮已结束、后台任务在跑）：原样返回，不加 activity 侧判断。
  const legacy = recorded(KIMI_263_DIR, "background-task-session-detail.json").json.data;
  assert.equal(legacy.activity, undefined, "2.6 实录没有 activity");
  assert.equal(legacy.busy, true);
  assert.equal(legacy.main_turn_active, false);
  assert.equal(projectSessionActivity(legacy), legacy, "2.6 原样返回（同一对象、不造副本）");
});

test("TD-362: listServeSessions——2.7 列表条目按 activity 投影 busy 标志（list-with-background 实录）", async () => {
  const firstPage = recorded(KIMI_272_DIR, "list-with-background.json").json;
  let reads = 0;
  const r = await listServeSessions({
    baseUrl: "http://x", token: "t",
    fetchImpl: async () => {
      reads += 1;
      return jsonResponse(reads === 1 ? firstPage : { code: 0, data: { items: [], has_more: false } });
    },
  });
  assert.equal(r.ok, true);
  assert.equal(reads, 2, "has_more:true 继续翻页（2.7 同款游标）");
  assert.deepEqual(r.items, [
    {
      id: "session_e8e6ec53-68d9-4600-8f65-632bc57dd3fb",
      workspaceId: "wd_cwd_f0c6643ba75d",
      busy: true,
      mainTurnActive: false,
    },
    {
      id: "session_466e7943-c871-4ec2-9472-ad4ca7bee41d",
      workspaceId: "wd_run_20261120232427086mnhnvr_181a5b23ff94",
      busy: false,
      mainTurnActive: false,
    },
    {
      id: "session_e449b3f2-133b-45b6-bb21-83f7b883a368",
      workspaceId: "wd_reliability-tmp_82eccca01297",
      busy: false,
      mainTurnActive: false,
    },
  ], "background 条目 busy:true/mainTurnActive:false；idle 条目双 false");
});

test("TD-362: listServeSessions——条目 activity 闭集外 → shape_unknown（绝不折叠成空闲）", async () => {
  const r = await listServeSessions({
    baseUrl: "http://x", token: "t",
    fetchImpl: async () => jsonResponse({ code: 0, data: { items: [{ id: "s1", activity: "paused" }], has_more: false } }),
  });
  assert.deepEqual(r, { ok: false, reason: "shape_unknown" });
});

test("TD-362: probeServeSession——2.7 详情投影（background 忙/idle 闲）、闭集外 shape_unknown、40401 已亡", async () => {
  const probe = (body) => probeServeSession({
    baseUrl: "http://x", token: "t", sessionId: "s1",
    fetchImpl: async () => jsonResponse(body),
  });
  let r = await probe(recorded(KIMI_272_DIR, "t6-background-session-after-turn.json").json);
  assert.deepEqual(
    { ok: r.ok, gone: r.gone, busy: r.busy, workspaceId: r.workspaceId },
    { ok: true, gone: false, busy: true, workspaceId: "wd_cwd_f0c6643ba75d" },
    "background：busy 真（2.6 下 main_turn_active 假）→ probe 的任一真即忙",
  );
  r = await probe(recorded(KIMI_272_DIR, "session-detail-fresh.json").json);
  assert.deepEqual({ ok: r.ok, busy: r.busy }, { ok: true, busy: false }, "idle → 不忙");
  r = await probe({ code: 0, data: { id: "s1", activity: "paused" } });
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "shape_unknown" });
  r = await probe(recorded(KIMI_272_DIR, "session-detail-gone-40401.json").json);
  assert.deepEqual({ ok: r.ok, gone: r.gone }, { ok: true, gone: true }, "2.7 实录的会话不存在信封");
});

test("TD-362: probeServeSession——投影后缺非空 id → shape_unknown（2.6 与 2.7 形状各一；不给 sweep 假 busy:false）", async () => {
  const probe = (data) => probeServeSession({
    baseUrl: "http://x", token: "t", sessionId: "s1",
    fetchImpl: async () => jsonResponse({ code: 0, data }),
  });
  // 2.7 残件：activity 在场、busy 可投影，但没有 id——不能证成"这个会话"。
  let r = await probe({ activity: "idle", workspace_id: "w1" });
  assert.deepEqual(r, { ok: false, reason: "shape_unknown" });
  // 2.6 同款缺口：双字段全 false 但没有 id。
  r = await probe({ busy: false, main_turn_active: false, workspace_id: "w1" });
  assert.deepEqual(r, { ok: false, reason: "shape_unknown" });
  // 空串 id 同罪。
  r = await probe({ id: "", activity: "idle" });
  assert.deepEqual(r, { ok: false, reason: "shape_unknown" });
});

// ===== TD-261a（0063）：连接拒绝单列分类 =====

import { serveRequest } from "../../src/backends/kimiServeOps.js";

test("TD-261a: serveRequest 连接拒绝分类——直抛/cause 包装/AggregateError 全员 ECONNREFUSED 才算；混合即不可证死", async () => {
  const call = (error) => serveRequest({ baseUrl: "http://127.0.0.1:1", token: "t", method: "GET", path: "/x", fetchImpl: async () => { throw error; } });
  // 直抛形状
  let r = await call(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
  assert.deepEqual(r, { connectionRefused: true }, "error.code 直判");
  // undici 包装形状（cause）
  r = await call(Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("inner"), { code: "ECONNREFUSED" }) }));
  assert.deepEqual(r, { connectionRefused: true }, "cause.code 判");
  // AggregateError：happy-eyeballs 多地址全拒（localhost 常见——opus 实测点）
  r = await call(Object.assign(new Error("agg"), {
    cause: Object.assign(new AggregateError([
      Object.assign(new Error("a"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("b"), { code: "ECONNREFUSED" }),
    ]), { code: undefined }),
  }));
  assert.deepEqual(r, { connectionRefused: true }, "子错误全员拒绝才算");
  // AggregateError 混合（含超时形状）→ 不可证死
  r = await call(Object.assign(new Error("agg-mixed"), {
    cause: new AggregateError([
      Object.assign(new Error("a"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("b"), { code: "ETIMEDOUT" }),
    ]),
  }));
  assert.deepEqual(r, { transportError: true }, "混合子错误→http_error（不可证死）");
  // 其它传输错误 → http_error
  r = await call(Object.assign(new Error("dns"), { code: "ENOTFOUND" }));
  assert.deepEqual(r, { transportError: true });
  // AbortError → timeout（既有语义不变）
  const abortErr = new Error("abort"); abortErr.name = "AbortError";
  r = await call(abortErr);
  assert.deepEqual(r, { aborted: true });
});

test("TD-261a: listServeSessions 把 connection_refused 映射为新 reason（http_error 不变）", async () => {
  let r = await listServeSessions({
    baseUrl: "http://x", token: "t",
    fetchImpl: async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
  });
  assert.equal(r.ok, false); assert.equal(r.reason, "connection_refused");
  r = await listServeSessions({
    baseUrl: "http://x", token: "t",
    fetchImpl: async () => { throw Object.assign(new Error("dns"), { code: "ENOTFOUND" }); },
  });
  assert.equal(r.ok, false); assert.equal(r.reason, "http_error");
});
