// test/process/kimiWebIdentityProbe.test.js
//
// kimi-web 服务身份探针回归（2026-10-02 双席会审修正落地）：凭据纪律、错误
// 分类、输出只含受约束身份字段（原始正文/异常 message 绝不进输出）。
// fetch 全部注入（确定性、零网络）；子进程用例只走凭据缺失路径（零请求）。

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, probeIdentity, main } from "../../scripts/reliability/kimi-web-identity-probe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "scripts", "reliability", "kimi-web-identity-probe.mjs");
const ENV = { KIMI_WEB_TOKEN: "test-secret-token-value-do-not-leak" };

function fetchReturning({ status = 200, body = "{}", captureInto = null } = {}) {
  return async (url, options) => {
    if (captureInto) { captureInto.url = url; captureInto.options = options; }
    if (status !== 200) return { status, json: async () => JSON.parse(body) };
    return { status, json: async () => JSON.parse(body) };
  };
}

test("probe: 凭据缺失 → exit 1 + 固定文案，零请求（fetch 不被调用）", async () => {
  let called = false;
  const r = await probeIdentity({ url: "http://127.0.0.1:1", tokenEnv: "KIMI_WEB_TOKEN", env: {}, userEnvReader: async () => undefined, fetchFn: async () => { called = true; } });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /credential missing: env KIMI_WEB_TOKEN not set and no Windows user-scope value/);
  assert.equal(called, false);
});

// ===== TD-208 (2026-10-03)：两级凭据解析（env → HKCU 同权威回退）=====
test("probe TD208: env 空但 HKCU 命中 → 回退值承重（Bearer 用回退值发请求）", async () => {
  const captured = {};
  const r = await probeIdentity({
    url: "http://127.0.0.1:58627", tokenEnv: "KIMI_WEB_TOKEN", env: {},
    userEnvReader: async (name) => (name === "KIMI_WEB_TOKEN" ? "hkcu-fallback-token-value" : undefined),
    fetchFn: fetchReturning({ captureInto: captured }),
  });
  assert.equal(r.exitCode, 0);
  assert.equal(captured.options.headers.Authorization, "Bearer hkcu-fallback-token-value", "回退值真实承重");
});

test("probe TD208: env 值优先于 HKCU（同级同值时绝不双读覆盖）+ 空串 env 也走回退", async () => {
  const captured = {};
  let readerCalled = 0;
  await probeIdentity({
    url: "http://127.0.0.1:58627", tokenEnv: "KIMI_WEB_TOKEN", env: ENV,
    userEnvReader: async () => { readerCalled += 1; return "hkcu-fallback-token-value"; },
    fetchFn: fetchReturning({ captureInto: captured }),
  });
  assert.equal(readerCalled, 0, "env 命中时根本不读 HKCU");
  assert.equal(captured.options.headers.Authorization, "Bearer test-secret-token-value-do-not-leak");

  const captured2 = {};
  await probeIdentity({
    url: "http://127.0.0.1:58627", tokenEnv: "KIMI_WEB_TOKEN", env: { KIMI_WEB_TOKEN: "" },
    userEnvReader: async () => "hkcu-fallback-token-value",
    fetchFn: fetchReturning({ captureInto: captured2 }),
  });
  assert.equal(captured2.options.headers.Authorization, "Bearer hkcu-fallback-token-value", "空串 env 同样走回退");
});

test("probe TD208: reader 抛错按缺失处理 → exit 1 固定文案，值/错误绝不回显", async () => {
  let called = false;
  const r = await probeIdentity({
    url: "http://127.0.0.1:1", tokenEnv: "KIMI_WEB_TOKEN", env: {},
    userEnvReader: async () => { throw new Error("registry read failed with secret-token-value"); },
    fetchFn: async () => { called = true; },
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /credential missing/);
  assert.equal(r.stderr.includes("secret-token-value"), false, "reader 错误文本绝不透传");
  assert.equal(called, false);
});

test("probe: 非回环目标拒跑（明文 HTTP + Bearer 不得上网，凭据检查之前）", async () => {
  let called = false;
  const r = await probeIdentity({ url: "http://192.168.1.5:58627", tokenEnv: "KIMI_WEB_TOKEN", env: ENV, fetchFn: async () => { called = true; } });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /refusing non-loopback target/);
  assert.equal(called, false, "拒绝发生在任何请求之前");
});

test("probe: 401 → http-error + 状态码，零正文字段", async () => {
  const r = await probeIdentity({ url: "http://127.0.0.1:1", tokenEnv: "KIMI_WEB_TOKEN", env: ENV, fetchFn: fetchReturning({ status: 401, body: "{\"error\":\"Bearer test-secret-token-value-do-not-leak rejected\"}" }) });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.outcome, "http-error");
  assert.equal(r.stdout.status, 401);
  assert.equal(JSON.stringify(r.stdout).includes("secret-token-value"), false, "错误正文绝不进输出");
});

test("probe: 请求形状——Bearer 头内存构造、禁重定向", async () => {
  const captured = {};
  await probeIdentity({ url: "http://127.0.0.1:58627/", tokenEnv: "KIMI_WEB_TOKEN", env: ENV, fetchFn: fetchReturning({ captureInto: captured }) });
  assert.equal(captured.url, "http://127.0.0.1:58627/openapi.json", "尾斜杠归一 + 固定路径");
  assert.equal(captured.options.headers.Authorization, "Bearer test-secret-token-value-do-not-leak");
  assert.equal(captured.options.redirect, "manual");
  assert.ok(captured.options.signal, "超时信号在场");
});

test("probe: 200 + 规格体 → 受约束身份字段 + 上游自报语义标注；正文回显凭据不泄漏", async () => {
  const body = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "kimi web", version: "2.1.1-doc" },
    version: "2.1.1",
    note: "echo test-secret-token-value-do-not-leak",
    paths: { "/a": {}, "/b": {}, "/c": {} },
  });
  const r = await probeIdentity({ url: "http://127.0.0.1:58627", tokenEnv: "KIMI_WEB_TOKEN", env: ENV, fetchFn: fetchReturning({ body }) });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.outcome, "responded");
  assert.equal(r.stdout.serverVersion, "2.1.1");
  assert.equal(r.stdout.serverVersionSemantics, "upstream-self-reported");
  assert.equal(r.stdout.docVersion, "2.1.1-doc");
  assert.equal(r.stdout.pathCount, 3);
  assert.equal(r.stdout.authObserved, true);
  assert.equal(JSON.stringify(r.stdout).includes("secret-token-value"), false, "输出只含受约束字段——正文回显不透传");
});

test("probe: 超长字段截断到 120、畸形响应 unparseable-body、网络错误只出分类名", async () => {
  const long = "v".repeat(300);
  const bounded = await probeIdentity({ url: "http://127.0.0.1:1", tokenEnv: "KIMI_WEB_TOKEN", env: ENV, fetchFn: fetchReturning({ body: JSON.stringify({ version: long }) }) });
  assert.equal(bounded.stdout.serverVersion.length, 120);

  const bad = await probeIdentity({ url: "http://127.0.0.1:1", tokenEnv: "KIMI_WEB_TOKEN", env: ENV, fetchFn: fetchReturning({ body: "not json <<<" }) });
  assert.equal(bad.stdout.outcome, "unparseable-body");

  const err = new Error("connect ECONNREFUSED http://127.0.0.1:1 with test-secret-token-value-do-not-leak");
  err.name = "Error";
  const netErr = await probeIdentity({ url: "http://127.0.0.1:1", tokenEnv: "KIMI_WEB_TOKEN", env: ENV, fetchFn: async () => { throw err; } });
  assert.equal(netErr.stdout.outcome, "network-error");
  assert.equal(netErr.stdout.errorKind, "Error");
  assert.equal(JSON.stringify(netErr.stdout).includes("secret-token-value"), false, "异常 message 绝不进输出");
});

test("probe: 子进程凭据缺失路径（--token-env 指向不存在的变量）→ exit 1", () => {
  let code = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [SCRIPT, "--url", "http://127.0.0.1:1", "--token-env", "WAO_PROBE_TEST_ABSENT_VAR"], { encoding: "utf8", windowsHide: true });
  } catch (error) {
    code = error.status ?? 1;
    stderr = error.stderr ?? "";
  }
  assert.equal(code, 1);
  assert.match(stderr, /credential missing/);
});

test("main/parseArgs：--help exit 0、裸 flag 抛错、非 http(s) url 拒绝", async () => {
  const out = []; const err = [];
  const stdout = { write: (s) => out.push(s) };
  const stderr = { write: (s) => err.push(s) };
  assert.equal(await main(["--help"], { stdout, stderr }), 0);
  assert.match(out.join(""), /--url/);
  assert.equal(await main(["--url"], { stdout, stderr }), 1);
  assert.match(err.join(""), /--url requires a value/);
  assert.equal(await main(["--url", "ftp://nope"], { stdout, stderr }), 1);
  assert.throws(() => parseArgs(["--nope"]), /unknown flag: --nope/);
});
