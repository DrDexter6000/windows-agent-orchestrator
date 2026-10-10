// F-②（2026-10-10 摩擦处置批）：`npm run test:one` shim 的行为钉。
// 声称瞄准（纪律一）：
//   1. env 中和生效——父进程带 WAO_MCP_REQUIRE_CERTIFIED=1，靶件看到 0（单一来源
//      buildCanonicalChildEnv 被真实消费，而非本测试复述清单）；
//   2. 目录形式被响亮拒绝（F-② 的第三件套陷阱变成显式失败+用法行）；
//   3. glob 展开只认 test/ 树、零匹配明确失败；
//   4. 退出码透传（靶件红→shim 非零，靶件绿→0）。
// 靶件在 test/fixtures/test-one/（manifest 是套件唯一枚举源，靶件不注册、不进全量）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIM = join(repoRoot, "scripts", "test-one.mjs");

function runShim(args, envOverrides = {}) {
  return spawnSync(process.execPath, [SHIM, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...envOverrides },
  });
}

test("test:one：env 中和从 canonical 单一来源生效（父带 =1 也被钉 0）", () => {
  const r = runShim(["test/fixtures/test-one/env-echo.target.test.js"], {
    WAO_MCP_REQUIRE_CERTIFIED: "1",
  });
  assert.equal(r.status, 0, `靶件应绿。stdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.doesNotMatch(r.stderr, /certification-list gate/);
});

test("test:one：目录形式响亮拒绝并给用法行", () => {
  const r = runShim(["test/fixtures/test-one"]);
  assert.notEqual(r.status, 0);
  assert.ok(r.status !== null, "shim 应自退出而非被信号杀");
  assert.match(r.stderr, /目录/);
  assert.match(r.stderr, /用法：npm run test:one/);
});

test("test:one：glob 展开（test/ 树、命中即跑）", () => {
  const r = runShim(["test/fixtures/test-one/env-*.target.test.js"]);
  assert.equal(r.status, 0, `glob 命中靶件应绿。stdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.match(r.stdout, /ok 1 - target: canonical env discipline/);
  // glob 精度：env-* 模式不得误吞 fail 靶件（成功路径的 TAP 不含文件名，
  // 以未出现故意红标记为准）
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /intentional-fail-marker/);
});

test("test:one：glob 零匹配明确失败（不静默传给 node --test）", () => {
  const r = runShim(["test/fixtures/test-one/no-such-*.test.js"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /零匹配/);
});

test("test:one：glob 越界（非 test/ 开头）明确失败", () => {
  const r = runShim(["scripts/*.mjs"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /必须以 test\/ 开头/);
});

test("test:one：靶件红的退出码透传", () => {
  const r = runShim(["test/fixtures/test-one/fail.target.test.js"]);
  assert.notEqual(r.status, 0);
  assert.ok(r.status !== null);
  assert.match(`${r.stdout}${r.stderr}`, /intentional-fail-marker/);
});

test("test:one：缺文件参数明确失败", () => {
  const r = runShim([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /缺测试文件参数/);
});

test("test:one：worker 上下文横幅与全量同源同措辞（无豁免形态）", () => {
  const r = runShim(["test/fixtures/test-one/env-echo.target.test.js"], {
    WAO_IN_WORKER: "1",
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /worker 上下文（WAO_IN_WORKER=1）/);
  assert.match(r.stderr, /决定 0047/);
});

test("test:one：worker 上下文 + Lead 豁免时横幅如实报告（豁免形态）", () => {
  const r = runShim(["test/fixtures/test-one/env-echo.target.test.js"], {
    WAO_IN_WORKER: "1",
    WAO_ALLOW_NESTED_DISPATCH: "1",
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Lead 豁免/);
});
