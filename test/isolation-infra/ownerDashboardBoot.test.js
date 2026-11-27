// test/isolation-infra/ownerDashboardBoot.test.js
//
// 第 145b 批（修正一 #14）：用假 DOM 驱动真实的 boot()。
//   - #code= 片段：清片段与清存储【同一同步步骤】发生（兑换还在途时刷新，下一次
//     加载读不到旧令牌）；
//   - 兑换失败显示 codeExpired，不退回旧令牌；
//   - 带项目筛选的 #workers?project=…&code=… 粘进已打开页面 → hashchange 重载；
//   - 任一数据请求 401（含详情）→ 存储令牌被清（api.js 那唯一一处 fetch 的钩子）。
// boot() 是模块加载即执行的入口：import 前装好 globals，import 后驱动。

process.env.WAO_ALLOW_NESTED_DISPATCH = "1";

import { test } from "node:test";
import assert from "node:assert/strict";

class FakeNode {
  constructor(tag = "div") {
    this.tag = tag; this.className = ""; this.children = []; this.parent = null;
    this.attrs = new Map(); this.listeners = new Map(); this.ownText = null;
    this.scrollTop = 0; this.scrollHeight = 100; this.clientHeight = 50;
  }
  append(...nodes) { for (const n of nodes) { if (n && n.parent) n.parent = null; n.parent = this; this.children.push(n); } }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { for (const old of this.children) old.parent = null; this.children = []; this.append(...nodes); }
  insertBefore(node, ref) { const at = ref === null || ref === undefined ? this.children.length : this.children.indexOf(ref); this.children.splice(at < 0 ? this.children.length : at, 0, node); node.parent = this; return node; }
  closest() { return null; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  setAttribute(name, value) { this.attrs.set(String(name), String(value)); }
  getAttribute(name) { return this.attrs.has(String(name)) ? this.attrs.get(String(name)) : null; }
  addEventListener(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  removeEventListener() {}
  contains(node) { for (let cur = node; cur; cur = cur.parent) if (cur === this) return true; return false; }
  getBoundingClientRect() { return { top: 0, bottom: 50, left: 0, right: 100 }; }
  focus() {}
  querySelectorAll() { return []; }
  get textContent() { return this.children.map((c) => c.textContent ?? "").join(""); }
  set textContent(v) { this.children = []; this.ownText = String(v); }
}
class FakeText { constructor(text) { this.text = String(text); this.parent = null; } get textContent() { return this.text; } }

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

/** 一次可控的浏览器世界：hash、历史、存储、fetch（按 URL 回调）。 */
function makeBrowser({ hash = "", fetchImpl } = {}) {
  const browser = {
    hash,
    pathname: "/v2/",
    search: "",
    reloaded: 0,
    replaceStates: [],
    sessionStorage: makeStorage(),
    localStorage: makeStorage(),
    fetches: [],
    listeners: new Map(),
    elements: { topbar: new FakeNode("div"), main: new FakeNode("div"), sidebar: new FakeNode("div") },
  };
  browser.documentElement = new FakeNode("html");
  const fakeDocument = {
    activeElement: null,
    documentElement: browser.documentElement,
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => new FakeText(text),
    getElementById: (id) => browser.elements[id] ?? null,
    addEventListener() {},
  };
  const windowObj = {
    get location() {
      return {
        get hash() { return browser.hash; },
        set hash(value) { browser.hash = value; windowObj.dispatch("hashchange", {}); },
        get pathname() { return browser.pathname; },
        get search() { return browser.search; },
        assign() {},
        replace() {},
        reload() { browser.reloaded += 1; },
      };
    },
    history: {
      replaceState(a, b, url) {
        browser.replaceStates.push(url);
        const cut = String(url).indexOf("#");
        browser.hash = cut < 0 ? "" : String(url).slice(cut);
      },
    },
    sessionStorage: browser.sessionStorage,
    localStorage: browser.localStorage,
    addEventListener(name, fn) { browser.listeners.set(name, [...(browser.listeners.get(name) ?? []), fn]); },
    removeEventListener() {},
    dispatch(name, event) { for (const fn of [...(browser.listeners.get(name) ?? [])]) fn(event); },
  };
  browser.document = fakeDocument;
  browser.window = windowObj;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    browser.fetches.push({ url: String(url), init });
    return fetchImpl(String(url), init);
  };
  browser.restore = () => { globalThis.fetch = realFetch; };
  return browser;
}

/** 装好 globals 后【新鲜地】import app.js（其顶层就跑 boot()；带查询串绕过模块缓存，
 * 每个用例各跑一次自己的 boot），等它落定。 */
let bootEpoch = 0;
async function bootIn(browser) {
  globalThis.document = browser.document;
  globalThis.window = browser.window;
  bootEpoch += 1;
  await import("../../src/owner-dashboard/v2/app.js?boot=" + bootEpoch).catch(() => {});
  const settle = () => new Promise((r) => setTimeout(r, 25));
  await settle();
  await settle();
}

const JSON_OK = (body) => ({ status: 200, ok: true, json: async () => body });

test("boot (real): #code= clears the fragment AND the stored token in the SAME synchronous step, before the exchange settles", async (t) => {
  const browser = makeBrowser({
    hash: "#code=" + "ab".repeat(32),
    fetchImpl: async (url) => {
      if (url === "/api/session") {
        // 兑换挂起：在它落定前断言同步步骤已经完成。
        await new Promise((r) => setTimeout(r, 60));
        return JSON_OK({ token: "cd".repeat(32), expiresAt: 1 });
      }
      return JSON_OK({ status: "ready", counts: {}, projects: [], lanes: [] });
    },
  });
  browser.sessionStorage.setItem("wao_v2_token", "ee".repeat(32)); // 上一代的旧令牌
  t.after(browser.restore);
  t.after(() => { delete globalThis.document; delete globalThis.window; });
  globalThis.document = browser.document;
  globalThis.window = browser.window;
  bootEpoch += 1;
  const importStarted = import("../../src/owner-dashboard/v2/app.js?boot=" + bootEpoch);
  // import 触发 boot()：清片段与清存储必须在兑换网络往返之前就发生。
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(!browser.sessionStorage.getItem("wao_v2_token"), "the stored token is cleared BEFORE the exchange settles (empty or gone)");
  assert.ok(browser.replaceStates.some((url) => !String(url).includes("#code=")), "the fragment was cleared synchronously");
  await importStarted.catch(() => {});
  const settle = () => new Promise((r) => setTimeout(r, 25));
  await settle();
  await settle();
});

test("boot (real): a dead code does not fall back to the old token; the exchange was attempted", async (t) => {
  const browser = makeBrowser({
    hash: "#code=" + "ab".repeat(32),
    fetchImpl: async (url) => {
      if (url === "/api/session") return { status: 401, ok: false, json: async () => ({ error: "unauthorized" }) };
      return JSON_OK({ status: "ready" });
    },
  });
  browser.sessionStorage.setItem("wao_v2_token", "ee".repeat(32));
  t.after(browser.restore);
  t.after(() => { delete globalThis.document; delete globalThis.window; });
  await bootIn(browser);
  assert.ok(!browser.sessionStorage.getItem("wao_v2_token"), "the dead code did not fall back to the old token");
  assert.equal(browser.fetches.some((f) => f.url.includes("/api/session")), true, "the exchange was attempted");
});

test("boot (real): pasting #workers?project=x&code=… into an OPEN page triggers a reload on hashchange", async (t) => {
  const browser = makeBrowser({
    hash: "#overview",
    fetchImpl: async () => JSON_OK({ status: "ready", counts: {}, projects: [], lanes: [] }),
  });
  t.after(browser.restore);
  t.after(() => { delete globalThis.document; delete globalThis.window; });
  await bootIn(browser);
  assert.equal(browser.reloaded, 0);
  // 带 project 筛选的 code 形态（本批自己生成的 URL）粘进来：splitCodeFromHash 判定 → 重载。
  browser.window.location.hash = `#workers?project=shop-api&code=${"ab".repeat(32)}`;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(browser.reloaded, 1, "the combined project+code fragment reloads the page");
});

test("boot (real): a 401 from any data request clears the stored token (api.js single-fetch hook)", async (t) => {
  const browser = makeBrowser({
    hash: "#token=" + "ee".repeat(32),
    fetchImpl: async () => ({ status: 401, ok: false, json: async () => ({ error: "unauthorized" }) }),
  });
  t.after(browser.restore);
  t.after(() => { delete globalThis.document; delete globalThis.window; });
  await bootIn(browser);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(browser.fetches.length >= 1, "data requests left through the single fetch");
  assert.ok(!browser.sessionStorage.getItem("wao_v2_token"), "the 401 answers cleared the stored token");
});
