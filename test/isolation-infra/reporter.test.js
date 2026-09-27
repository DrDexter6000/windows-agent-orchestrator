import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "wao-reporter-test-"));
  const origCwd = process.cwd;
  process.cwd = () => dir;
  try {
    await fn(dir);
  } finally {
    process.cwd = origCwd;
    await rm(dir, { recursive: true, force: true });
  }
}

function makeCompleteEvent(name, file, passed, duration_ms, errorCause) {
  const details = { duration_ms, passed };
  if (!passed && errorCause) {
    const err = new Error("test failure");
    err.cause = errorCause;
    details.error = err;
  }
  return {
    type: "test:complete",
    data: { name, file, details },
  };
}

function makeSkipEvent(name, file, duration_ms) {
  return {
    type: "test:complete",
    data: { name, file, details: { duration_ms, passed: false, skip: true } },
  };
}

function makeFailEvent(name, file, errorCause) {
  const err = new Error("test failure");
  err.cause = errorCause;
  return {
    type: "test:fail",
    data: {
      name,
      file,
      details: { error: err },
    },
  };
}

test("reporter writes test-results.json with correct summary", async () => {
  await withTempDir(async (dir) => {
    const { default: TestReporter } = await import("../../test/reporter.mjs");
    const reporter = new TestReporter();

    const filePath = join(dir, "test", "foo.test.js");
    reporter.write(makeCompleteEvent("should pass", filePath, true, 10));
    reporter.write(makeCompleteEvent("should fail", filePath, false, 20, {
      actual: "x",
      expected: "y",
      operator: "strictEqual",
      stack: "AssertionError: at line 5",
    }));
    reporter.write(makeSkipEvent("should skip", filePath, 0));

    await new Promise((resolve, reject) => {
      reporter.on("finish", resolve);
      reporter.on("error", reject);
      reporter.end();
    });

    const raw = await readFile(join(dir, "test-results.json"), "utf8");
    const data = JSON.parse(raw);

    assert.equal(data.summary.total, 3);
    assert.equal(data.summary.passed, 1);
    assert.equal(data.summary.failed, 1);
    assert.equal(data.summary.skipped, 1);
    assert.equal(data.suites.length, 1);
    assert.ok(data.suites[0].name.endsWith("test/foo.test.js"));
    assert.equal(data.suites[0].tests.length, 3);

    const failedTest = data.suites[0].tests.find((t) => t.status === "fail");
    assert.ok(failedTest);
    assert.ok(failedTest.error.diff.includes("- Expected:"));
    assert.ok(failedTest.error.diff.includes('"y"'));
    assert.equal(failedTest.error.operator, "strictEqual");
    assert.ok(failedTest.error.stack.length > 0);
  });
});

test("reporter handles multiple suites", async () => {
  await withTempDir(async (dir) => {
    const { default: TestReporter } = await import("../../test/reporter.mjs");
    const reporter = new TestReporter();

    reporter.write(makeCompleteEvent("test one", join(dir, "test/a.test.js"), true, 5));
    reporter.write(makeCompleteEvent("test two", join(dir, "test/b.test.js"), true, 10));
    reporter.write(makeCompleteEvent("test three", join(dir, "test/a.test.js"), true, 15));

    await new Promise((resolve, reject) => {
      reporter.on("finish", resolve);
      reporter.on("error", reject);
      reporter.end();
    });

    const raw = await readFile(join(dir, "test-results.json"), "utf8");
    const data = JSON.parse(raw);

    assert.equal(data.suites.length, 2);
    assert.equal(data.suites[0].tests.length, 2);
    assert.equal(data.suites[1].tests.length, 1);
  });
});

test("reporter skips file-level events", async () => {
  await withTempDir(async (dir) => {
    const { default: TestReporter } = await import("../../test/reporter.mjs");
    const reporter = new TestReporter();

    const filePath = join(dir, "test/foo.test.js");
    const relPath = "test/foo.test.js";

    // name === relPath → should be filtered
    reporter.write(makeCompleteEvent(relPath, filePath, true, 5));
    // name === basename → should be filtered
    reporter.write(makeCompleteEvent("foo.test.js", filePath, true, 3));
    // real test with a proper name → should be kept
    reporter.write(makeCompleteEvent("real test", filePath, true, 10));

    await new Promise((resolve, reject) => {
      reporter.on("finish", resolve);
      reporter.on("error", reject);
      reporter.end();
    });

    const raw = await readFile(join(dir, "test-results.json"), "utf8");
    const data = JSON.parse(raw);
    assert.equal(data.suites[0].tests.length, 1);
    assert.equal(data.suites[0].tests[0].name, "real test");
  });
});

test("reporter deduplicates same test", async () => {
  await withTempDir(async (dir) => {
    const { default: TestReporter } = await import("../../test/reporter.mjs");
    const reporter = new TestReporter();

    const filePath = join(dir, "t.test.js");
    reporter.write(makeCompleteEvent("same test", filePath, true, 10));
    reporter.write(makeCompleteEvent("same test", filePath, true, 20));

    await new Promise((resolve, reject) => {
      reporter.on("finish", resolve);
      reporter.on("error", reject);
      reporter.end();
    });

    const raw = await readFile(join(dir, "test-results.json"), "utf8");
    const data = JSON.parse(raw);
    assert.equal(data.summary.total, 1);
  });
});

test("reporter handles empty test run", async () => {
  await withTempDir(async (dir) => {
    const { default: TestReporter } = await import("../../test/reporter.mjs");
    const reporter = new TestReporter();

    await new Promise((resolve, reject) => {
      reporter.on("finish", resolve);
      reporter.on("error", reject);
      reporter.end();
    });

    const raw = await readFile(join(dir, "test-results.json"), "utf8");
    const data = JSON.parse(raw);
    assert.equal(data.summary.total, 0);
    assert.equal(data.suites.length, 0);
    assert.ok(data.timestamp);
    assert.ok(data.duration >= 0);
  });
});

test("reporter diff format with no actual/expected returns null", async () => {
  await withTempDir(async (dir) => {
    const { default: TestReporter } = await import("../../test/reporter.mjs");
    const reporter = new TestReporter();

    const err = new Error("boom");
    const cause = {};
    err.cause = cause;
    assert.equal(reporter._formatDiff(cause), null);
  });
});

test("reporter _relPath normalizes backslashes", async () => {
  const { default: TestReporter } = await import("../../test/reporter.mjs");
  const reporter = new TestReporter();
  const cwd = process.cwd();

  // Path within cwd always produces forward slashes regardless of platform
  const absPath = join(cwd, "test", "foo.test.js");
  const rel = reporter._relPath(absPath);
  assert.ok(!rel.includes("\\"), "no backslashes in output: " + rel);
  assert.ok(rel === "test/foo.test.js" || rel.endsWith("/test/foo.test.js"), "correct rel path: " + rel);

  // null/undefined guard
  assert.equal(reporter._relPath(null), null);
  assert.equal(reporter._relPath(undefined), undefined);
});

test("reporter _stringify handles objects and primitives", async () => {
  const { default: TestReporter } = await import("../../test/reporter.mjs");
  const reporter = new TestReporter();
  assert.equal(reporter._stringify(undefined), "");
  assert.equal(reporter._stringify("hello"), "hello");
  assert.equal(reporter._stringify(42), "42");
  assert.equal(reporter._stringify({ foo: 1, bar: 2 }), '{"foo":1,"bar":2}');
  assert.equal(reporter._stringify(null), "null");
  assert.equal(reporter._stringify([1, 2, 3]), "[1,2,3]");
});

test("reporter serializes object actual/expected in failing tests", async () => {
  await withTempDir(async (dir) => {
    const { default: TestReporter } = await import("../../test/reporter.mjs");
    const reporter = new TestReporter();

    const filePath = join(dir, "t.test.js");
    reporter.write(makeCompleteEvent("object diff", filePath, false, 10, {
      actual: { foo: 1, bar: 2 },
      expected: { foo: 1, bar: 3 },
      operator: "strictEqual",
      stack: "at line 5",
    }));

    await new Promise((resolve, reject) => {
      reporter.on("finish", resolve);
      reporter.on("error", reject);
      reporter.end();
    });

    const raw = await readFile(join(dir, "test-results.json"), "utf8");
    const data = JSON.parse(raw);
    const failed = data.suites[0].tests[0];
    assert.equal(failed.status, "fail");
    assert.equal(failed.error.actual, '{"foo":1,"bar":2}');
    assert.equal(failed.error.expected, '{"foo":1,"bar":3}');
    assert.ok(failed.error.diff.includes('{"foo":1,"bar":3}'));
  });
});

test("reporter captures error from test:fail event when cause has actual/expected", async () => {
  await withTempDir(async (dir) => {
    const { default: TestReporter } = await import("../../test/reporter.mjs");
    const reporter = new TestReporter();

    const filePath = join(dir, "t.test.js");
    // test:fail must come BEFORE test:complete to be captured
    reporter.write(makeFailEvent("failing test", filePath, {
      actual: "hello",
      expected: "world",
      operator: "strictEqual",
      stack: "at line",
    }));
    reporter.write(makeCompleteEvent("failing test", filePath, false, 30, {
      actual: "hello",
      expected: "world",
      operator: "strictEqual",
      stack: "at line",
    }));

    await new Promise((resolve, reject) => {
      reporter.on("finish", resolve);
      reporter.on("error", reject);
      reporter.end();
    });

    const raw = await readFile(join(dir, "test-results.json"), "utf8");
    const data = JSON.parse(raw);
    const failed = data.suites[0].tests[0];
    assert.equal(failed.status, "fail");
    assert.ok(failed.error);
    assert.equal(failed.error.actual, "hello");
    assert.equal(failed.error.expected, "world");
    assert.ok(failed.error.diff);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// TD-181 (b, 2026-09-26; r2 rework): tools/generate-report.mjs must separate
// OVERALL execution failure from the test verdict and must not fake green.
//   - The canonical run can exit non-zero with JSON finalVerdict "pass"
//     (finalRunnerOutcome: runsDirGuard additions/error), or carry wave-level
//     errors (groupError/suiteError), or abort (suiteAborted) — each INDEPENDENT
//     of finalVerdict. The top bar must show an overall non-pass badge in every
//     such combination and NEVER a green PASS badge next to failure rows; the
//     runner's own test verdict is listed separately (neutral, closed set).
//   - File counts stay FILE counts: diagnostic/runner-level rows are rendered
//     visibly but are NOT folded into the passed/failed denominators (the r1
//     projection rendered the real 243/246 aggregate as "243/247, 4 failed").
//   - Embedded JSON is `<`-escaped so report content can never break out of the
//     script payload; badges use a closed verdict label set only.
//   - fileFailureDropped is displayed as an explicit budget-omission note
//     (same honesty as failingTestsDropped), never counted as a test.
// All assertions run against the ACTUAL rendered HTML from a real child spawn.
// ────────────────────────────────────────────────────────────────────────────

const REPORT_TOOL = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "generate-report.mjs");
// TEMP discipline: render scratch lives under the checkout's .wao/runs/ (git
// ignored), never the system temp dir or the repo root proper.
const RENDER_SCRATCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".wao", "runs");

async function renderReportHtml(prefix, report) {
  await mkdir(RENDER_SCRATCH_ROOT, { recursive: true });
  const dir = await mkdtemp(join(RENDER_SCRATCH_ROOT, prefix));
  try {
    const input = join(dir, "test-results.json");
    const output = join(dir, "test-report.html");
    await writeFile(input, JSON.stringify(report), "utf8");
    const { code, stderr } = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [REPORT_TOOL, input, output], { stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (c) => { err += c; });
      child.on("error", rejectPromise);
      child.on("close", (exitCode) => resolvePromise({ code: exitCode, stderr: err }));
    });
    assert.equal(code, 0, `generate-report exited ${code}: ${stderr}`);
    return await readFile(output, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 提取页面内嵌 test-data JSON 负载（安全转义后应可无损 JSON.parse）。
// 闭合标签拆写以免本测试源码自身被误扫为 script 注入形状。
function extractEmbeddedJson(html) {
  const open = '<script id="test-data" type="application/json">';
  const start = html.indexOf(open);
  assert.ok(start !== -1, "页面缺 test-data script 负载");
  const payloadStart = start + open.length;
  const close = "</scr" + "ipt>";
  const end = html.indexOf(close, payloadStart);
  assert.ok(end !== -1, "test-data 负载未闭合（可能是注入破坏了结构）");
  return html.slice(payloadStart, end);
}

// Execute the generated client, including its initial detail selection. A tiny
// DOM sink is sufficient here: assertions inspect rendered content, not source.
function renderClientDetail(html, suiteName) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", addEventListener() {} });
    return elements.get(id);
  };
  element("test-data").textContent = extractEmbeddedJson(html);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, "one generated application script");
  runInNewContext(scripts[0][1], {
    document: { getElementById: element, querySelectorAll: () => [], querySelector: () => null },
    window: { addEventListener() {} }, location: { hash: `#${suiteName}` },
    history: { replaceState() {} },
  }, { timeout: 1000 });
  return element("content").innerHTML;
}

function canonicalAggregateFixture({ verdict = "fail", suiteError = false, suiteAborted = false, abortOrigin = null,
  guardAdditions = [], guardError = null, waves = [], firstRound = null, discoveredCount = 2 } = {}) {
  return {
    schemaVersion: 4,
    generatedAt: "2026-09-26T00:00:00.000Z",
    runner: { name: "canonical-test", node: "v22.23.1", hardwareParallelism: 8, mode: "one-node-test-child-per-wave" },
    discoveredCount,
    executedCount: 2,
    executionWaves: waves,
    firstRound: firstRound || { verdict: "pass", passed: 2, failed: 0, missing: 0, crashed: 0, failures: [] },
    isolation: [],
    finalVerdict: verdict,
    suiteError,
    suiteAborted,
    abortOrigin,
    runsDirGuard: { additions: guardAdditions, error: guardError },
    totalDurationMs: 42,
  };
}

const PASSING_WAVE = {
  name: "pure", categories: ["pure"], concurrency: 8, durationMs: 5, exitCode: 0, total: 2,
  passed: 2, failed: 0, missing: 0, crashed: 0, groupError: null, observation: null, watchdog: null,
  files: [
    { path: "a.test.js", status: "pass", resourceCategory: "pure", executionWave: "pure", durationMs: 1 },
    { path: "b.test.js", status: "pass", resourceCategory: "pure", executionWave: "pure", durationMs: 1 },
  ],
};

test("TD-181(b) 渲染r2: 整体失败与测试verdict分开——suiteError+波级groupError+runsGuard 且文件全绿 ⇒ 顶部总体 FAIL，文件计数不混入诊断行", async () => {
  const waveWithGroupError = {
    ...PASSING_WAVE, exitCode: 1,
    groupError: "child exit 1 but report shows all pass",
  };
  const html = await renderReportHtml("wao-r2-suiteerror-", canonicalAggregateFixture({
    verdict: "fail",
    suiteError: true,
    guardAdditions: [{ file: "run_2026xyz.jsonl", phase: "pure" }],
    waves: [waveWithGroupError, PASSING_WAVE],
  }));
  // 顶部（服务端渲染）：总体非通过徽标 + 中性单列的 runner 测试 verdict。
  assert.ok(html.includes("canonical overall: FAIL"), "顶部必须明确展示总体非通过");
  assert.ok(!html.includes("canonical overall: PASS"), "不得出现绿色 PASS 总体徽标与失败行并存");
  assert.ok(html.includes("runner verdict: fail"), "原测试 verdict 单列（中性、闭集）");
  // 文件计数保持文件口径：2/2 files，诊断行不得混入分母或失败文件数。
  assert.ok(html.includes("2/2 files passing"), "文件计数保持原样（2 文件全通过）");
  assert.ok(!html.includes("2/5") && !html.includes("3/5") && !html.includes("2/7"), "诊断行不得混入 passing 分母");
  assert.ok(!/✖ [123] files? failed/.test(html), "全绿文件不得被诊断行撑出失败文件数");
  // 波级错误与 runs-guard 条目逐条可见（嵌入数据即客户端树实际渲染的输入）。
  assert.ok(html.includes("child exit 1 but report shows all pass"), "波级 groupError 必须逐条展示");
  assert.ok(html.includes("runs-guard: runs/run_2026xyz.jsonl (first seen: pure)"), "runs-guard 新增条目必须逐条展示");
  assert.ok(html.includes("canonical/overall-verdict"), "套件级失败聚合为可见的合成 suite（另列，不计数）");
});

test("TD-181(b) 渲染r2: 各失败信号独立为真（verdict=pass）⇒ 仍总体 FAIL，绝不绿色 PASS 与失败行并存", async () => {
  // finalRunnerOutcome 的真实语义：runsGuard additions/error 时 exit 非零而 JSON
  // finalVerdict 仍可为 pass——每种信号逐一独立验证（不只与 finalVerdict=fail 组合）。
  const cases = [
    ["runsGuardAdditions-only", canonicalAggregateFixture({ verdict: "pass", guardAdditions: [{ file: "run_x.jsonl", phase: "pure" }], waves: [PASSING_WAVE] })],
    ["runsGuardError-only", canonicalAggregateFixture({ verdict: "pass", guardError: "EACCES: permission denied, scandir runs-dir", waves: [PASSING_WAVE] })],
    ["suiteError-only", canonicalAggregateFixture({ verdict: "pass", suiteError: true, waves: [PASSING_WAVE] })],
    ["groupError-only", canonicalAggregateFixture({
      verdict: "pass",
      waves: [{ ...PASSING_WAVE, groupError: "group diagnostic failed" }],
    })],
    ["suiteAborted-only", canonicalAggregateFixture({
      verdict: "pass", suiteAborted: true, abortOrigin: "wave", waves: [PASSING_WAVE],
    })],
  ];
  for (const [label, fixture] of cases) {
    const html = await renderReportHtml(`wao-r2-${label}-`, fixture);
    assert.ok(html.includes("canonical overall: FAIL"), `${label}: 总体非通过徽标必须在场`);
    assert.ok(!html.includes("canonical overall: PASS"), `${label}: 不得渲染绿色 PASS 总体徽标`);
    assert.ok(html.includes("runner verdict: pass"), `${label}: 原 JSON 测试 verdict 如实单列（pass）`);
    assert.ok(html.includes("2/2 files passing"), `${label}: 文件计数不受诊断行影响`);
    assert.ok(html.includes("canonical/overall-verdict"), `${label}: 失败原因行可见`);
    const detail = renderClientDetail(html, "canonical/overall-verdict");
    assert.match(detail, /[1-9]\d* report entries<\/span>/, `${label}: diagnostic count uses entries`);
    assert.doesNotMatch(detail, /\d+ tests<\/span>/, `${label}: diagnostics are not tests`);
  }
});

test("TD-181(b) 渲染r2: suiteAborted+首轮crash 组合 ⇒ 总体 FAIL + 中止行 + 文件计数=文件口径", async () => {
  const abortedWave = {
    name: "lock", categories: ["lock"], concurrency: 1, durationMs: 1800000, exitCode: null, total: 1,
    passed: 0, failed: 0, missing: 0, crashed: 1,
    groupError: "wave 'lock' ran 1800000ms (wall-clock limit 1800000ms) — watchdog backstop fired; killed child pid 4242; cleanup confirmed",
    observation: null,
    watchdog: { fired: true, confirmed: true, elapsedMs: 1800000, probes: 1, pid: 4242, limitMs: 1800000 },
    files: [{ path: "c.test.js", status: "crash", crashReason: "watchdog_timeout", resourceCategory: "lock", executionWave: "lock", durationMs: null }],
  };
  const html = await renderReportHtml("wao-r2-aborted-", canonicalAggregateFixture({
    verdict: "fail",
    suiteError: true,
    suiteAborted: true,
    abortOrigin: "wave",
    waves: [PASSING_WAVE, abortedWave],
    firstRound: {
      verdict: "fail", passed: 2, failed: 0, missing: 0, crashed: 1,
      failures: [{ path: "c.test.js", status: "crash", crashReason: "watchdog_timeout",
        failureDetail: { status: "unknown", reason: "watchdog_timeout — wave killed by the backstop; no first-round report content can be trusted" } }],
    },
  }));
  assert.ok(html.includes("canonical overall: FAIL"));
  assert.ok(html.includes("runner verdict: fail"));
  assert.ok(html.includes("suite aborted (origin: wave)"), "中止事实必须可见");
  assert.ok(html.includes("did NOT run"), "必须写明中止点之后的波/隔离未运行");
  assert.ok(html.includes("watchdog backstop fired"), "看门狗波级错误逐条展示");
  assert.ok(html.includes("first-round crash — failure detail unknown"), "crash 文件的 unknown 详情如实展示");
  // 文件口径：2 pass + 1 crash = 3 文件，1 文件非通过；诊断行不进分母。
  assert.ok(html.includes("2/3 files passing"), "文件计数 = 文件口径（2 pass + 1 crash）");
  assert.ok(html.includes("✖ 1 file failed"), "失败文件数 = 1（crash 文件）");
  assert.ok(!html.includes("2/4") && !html.includes("2/5"), "诊断行不得混入分母");
});

test("TD-181(b) 渲染r2: 首轮失败 + failureDetail ⇒ 子测试名/断言进页面；fileFailureDropped 显示省略说明且不计作测试", async () => {
  const failingWave = {
    ...PASSING_WAVE, exitCode: 1, passed: 1, failed: 1,
    groupError: null,
    files: [
      { path: "a.test.js", status: "fail", resourceCategory: "pure", executionWave: "pure", durationMs: 5 },
      { path: "b.test.js", status: "pass", resourceCategory: "pure", executionWave: "pure", durationMs: 1 },
    ],
  };
  const html = await renderReportHtml("wao-r2-firstround-", canonicalAggregateFixture({
    verdict: "fail",
    waves: [failingWave],
    firstRound: {
      verdict: "fail", passed: 1, failed: 1, missing: 0, crashed: 0,
      failures: [{
        path: "a.test.js", status: "fail", crashReason: null,
        failureDetail: {
          status: "collected", source: "firstRoundWaveReport", failingTestsTotal: 3, failingTestsDropped: 2,
          failingTests: [{ name: "subtest alpha fails", operator: "strictEqual", expected: "pass", actual: "fail",
            diff: "- Expected: \"pass\"\n+ Received: \"fail\"", stack: "AssertionError [ERR_ASSERTION]: at a.test.js:10:5" }],
          fileFailure: null,
          fileFailureDropped: true, // 预算省略——必须显式展示，且不计作测试
        },
      }],
    },
  }));
  assert.ok(html.includes("canonical overall: FAIL"));
  assert.ok(html.includes("runner verdict: fail"));
  assert.ok(html.includes("subtest alpha fails"), "首轮失败子测试名进入页面（保留的失败详情）");
  assert.ok(html.includes("AssertionError [ERR_ASSERTION]"), "失败堆栈进入页面");
  assert.ok(html.includes("2 more failing test(s) truncated"), "failingTestsDropped 省略计数展示");
  assert.ok(/fileFailure (content )?omitted/.test(html), "fileFailureDropped 必须清楚显示详情因预算省略");
  // 文件口径不受影响：1/2 files，1 file failed——省略说明行不计作测试/文件失败。
  assert.ok(html.includes("1/2 files passing"));
  assert.ok(html.includes("✖ 1 file failed"));
  assert.ok(!html.includes("✖ 2 files failed"), "省略说明行不得撑大失败计数");
  const detail = renderClientDetail(html, "test/a.test.js");
  assert.match(detail, /3 report entries<\/span>/);
  assert.match(detail, /subtest alpha fails/);
  assert.match(detail, /fileFailure (content )?omitted/);
  assert.doesNotMatch(detail, /\d+ tests<\/span>/);
});

test("TD-181(b) 渲染r2: environment_invalid 最小报告 ⇒ 总体 FAIL + 0/0 文件如实（无假 100% 全通过）", async () => {
  const html = await renderReportHtml("wao-r2-envinvalid-", {
    schemaVersion: 4,
    generatedAt: "2026-09-26T00:00:00.000Z",
    runner: { name: "canonical-test", node: "v22.23.1" },
    finalVerdict: "environment_invalid",
    error: "manifest drift detected (fix test/manifest.json): missing: 'x.test.js' is not assigned to any group",
  });
  assert.ok(html.includes("canonical overall: FAIL"), "无波最小报告也必须展示总体非通过");
  assert.ok(html.includes("runner verdict: environment_invalid"), "runner verdict 闭集单列");
  assert.ok(html.includes("0/0 files passing"), "零文件运行如实呈现 0/0（文件口径）");
  assert.ok(html.includes("manifest drift detected"), "错误正文可见");
  assert.ok(!html.includes("0/0 tests passing"), "旧的无单位标签不得再用于 canonical 聚合");
});

test("TD-181(b) 渲染r2: 干净 pass 聚合 ⇒ 绿 PASS 总体徽标且无失败行；旧 reporter 形状原样透传（无徽标、tests 单位）", async () => {
  const passHtml = await renderReportHtml("wao-r2-pass-", canonicalAggregateFixture({
    verdict: "pass", waves: [PASSING_WAVE],
  }));
  assert.ok(passHtml.includes("canonical overall: PASS"));
  assert.ok(passHtml.includes("runner verdict: pass"));
  assert.ok(passHtml.includes("2/2 files passing"));
  assert.ok(!passHtml.includes("canonical/overall-verdict"), "干净 pass 不添加合成套件");

  // 旧 reporter 形状（{summary, suites}）逐字段透传：无 canonical 徽标、计数与单位原样。
  const legacyHtml = await renderReportHtml("wao-r2-legacy-", {
    timestamp: "2026-09-26T00:00:00.000Z", duration: 5,
    summary: { total: 2, passed: 1, failed: 1, skipped: 0, todo: 0 },
    suites: [{ name: "test/legacy.test.js", status: "fail", duration: 2, tests: [
      { name: "legacy ok", status: "pass", duration: 1 },
      { name: "legacy bad", status: "fail", duration: 1, error: { actual: "x", expected: "y", operator: "equal", stack: "at legacy.test.js:3:1", diff: null } },
    ] }],
  });
  assert.ok(!legacyHtml.includes("canonical overall"), "reporter 形状不渲染 canonical 徽标（兼容不破坏）");
  assert.ok(!legacyHtml.includes("runner verdict"), "reporter 形状不渲染 runner verdict 行");
  assert.ok(legacyHtml.includes("1 passed") && legacyHtml.includes("✖ 1 failed"), "计数原样（无单位词）");
  assert.ok(legacyHtml.includes("1/2 tests passing"), "单位保持 tests（旧形状语义）");
  assert.ok(legacyHtml.includes("legacy bad"));
  assert.match(renderClientDetail(legacyHtml, "test/legacy.test.js"), /2 tests<\/span>/);
});

test("TD-181(b) 渲染r2 安全: 恶意错误文本/未知 verdict ⇒ 无注入标签/执行入口，内容经嵌入 JSON 无损还原，徽标只走闭集", async () => {
  const closeTag = "</scr" + "ipt>";
  const evil = closeTag + '<img src=x onerror=alert(1)><script>alert("pwn")' + closeTag;
  const evilWave = {
    ...PASSING_WAVE, exitCode: 1, passed: 1, failed: 1,
    files: [
      { path: "evil.test.js", status: "fail", resourceCategory: "pure", executionWave: "pure", durationMs: 5 },
      { path: "b.test.js", status: "pass", resourceCategory: "pure", executionWave: "pure", durationMs: 1 },
    ],
    groupError: null,
  };
  const html = await renderReportHtml("wao-r2-evil-", canonicalAggregateFixture({
    verdict: "<script>alert(1)" + closeTag, // 未知 verdict（不在闭集）——不得进任何徽标
    waves: [evilWave],
    firstRound: {
      verdict: "fail", passed: 1, failed: 1, missing: 0, crashed: 0,
      failures: [{
        path: "evil.test.js", status: "fail", crashReason: null,
        failureDetail: {
          status: "collected", source: "firstRoundWaveReport", failingTestsTotal: 1, failingTestsDropped: 0,
          failingTests: [{ name: evil, operator: evil, expected: evil, actual: evil, diff: evil, stack: evil }],
          fileFailure: { message: evil, stack: evil },
        },
      }],
    },
    guardError: evil,
  }));
  // 1) 页面结构完好：只有工具自身的两个 script 元素（test-data + 客户端脚本），无注入。
  assert.equal((html.match(/<script/g) || []).length, 2, "不得新增任何 script 开标签（注入即破坏此计数）");
  assert.ok(!html.includes("<img"), "恶意文本不得产出真实 img 标签");
  // 2) 徽标只走闭集：总体 FAIL；runner verdict 显示 unknown，绝不回显原始 script verdict。
  assert.ok(html.includes("canonical overall: FAIL"));
  assert.ok(html.includes("runner verdict: unknown"), "未知 verdict 归入闭集 unknown 展示");
  // 3) 嵌入 JSON 已转义且可无损还原：负载不含原始闭合标签，JSON.parse 后逐字段还原恶意原文。
  const payload = extractEmbeddedJson(html);
  assert.ok(!payload.includes(closeTag), "嵌入负载不得含未转义的闭合 script 标签");
  const ltEscape = "\\" + "u003c"; // \u003c：JSON 转义序列本身（拼接构造避免源码转义歧义）
  assert.ok(payload.includes(ltEscape), "嵌入负载必须以反斜杠u003c转义 <");
  const data = JSON.parse(payload);
  const t = data.suites.flatMap((s) => s.tests || []).find((x) => x.name === evil);
  assert.ok(t, "恶意子测试名经转义负载无损还原（JSON.parse 还原原文）");
  assert.equal(t.error && t.error.actual, evil, "actual 无损还原");
  const diag = data.suites.find((s) => s.name === "canonical/overall-verdict");
  assert.ok(diag, "诊断 suite 在场");
  assert.ok(diag.tests.some((row) => row.name.includes(evil)), "guard error 原文经转义负载无损还原到诊断行（对象级比对，不比再转义后的序列化文本）");

  // 旧 reporter 形状同样受转义保护：恶意测试名不破结构、负载无损。
  const legacyHtml = await renderReportHtml("wao-r2-legacy-evil-", {
    timestamp: "2026-09-26T00:00:00.000Z", duration: 5,
    summary: { total: 1, passed: 0, failed: 1, skipped: 0, todo: 0 },
    suites: [{ name: "test/legacy-evil.test.js", status: "fail", duration: 2, tests: [
      { name: evil, status: "fail", duration: 1, error: { actual: evil, expected: "", operator: "fail", stack: evil, diff: null } },
    ] }],
  });
  assert.equal((legacyHtml.match(/<script/g) || []).length, 2, "旧形状同样不得被注入出新 script");
  const legacyPayload = extractEmbeddedJson(legacyHtml);
  assert.ok(!legacyPayload.includes(closeTag));
  assert.equal(JSON.parse(legacyPayload).suites[0].tests[0].name, evil, "旧形状恶意内容无损还原");
});
