// test/backends/kimiServeOps.test.js
//
// TD-256 批（TD-252 收口）原语钉：probeServeSession 缺字段纪律 + listServeSessions
// 的 archived_only 面。
//
// 契约：
//   - probeServeSession：detail 返回 code 0 但 busy/main_turn_active 双字段全部
//     缺席 → {ok:false, reason:"shape_unknown"}——"未知"不得折叠成"空闲"（sweep
//     会据此删会话；sol 会审以注入响应实证旧实现返回 busy:false）。
//   - listServeSessions({archivedOnly:true})：同一端点 + archived_only=true 查询参
//     （0057 W2 实测：sessions:archive 归档的会话默认列表隐藏、此参数可见——
//     归档≠不可运行）；翻页/fail-closed 语义与默认面同款（既有钉在
//     serveMaintenance.test.js 的 ops 注入面，这里只钉 URL 形状与去重）。

import test from "node:test";
import assert from "node:assert/strict";
import { probeServeSession, listServeSessions } from "../../src/backends/kimiServeOps.js";

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
    fetchImpl: async () => jsonResponse({ code: 0, data: { busy: true } }),
  });
  assert.deepEqual({ ok: r.ok, busy: r.busy }, { ok: true, busy: true });
  r = await probeServeSession({
    baseUrl: "http://x", token: "t", sessionId: "s1",
    fetchImpl: async () => jsonResponse({ code: 0, data: { main_turn_active: true } }),
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
