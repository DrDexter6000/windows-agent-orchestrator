import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
    const { default: TestReporter } = await import("../test/reporter.mjs");
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
    assert.ok(failedTest.error.operator, "strictEqual");
    assert.ok(failedTest.error.stack.length > 0);
  });
});

test("reporter handles multiple suites", async () => {
  await withTempDir(async (dir) => {
    const { default: TestReporter } = await import("../test/reporter.mjs");
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
    const { default: TestReporter } = await import("../test/reporter.mjs");
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
    const { default: TestReporter } = await import("../test/reporter.mjs");
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
    const { default: TestReporter } = await import("../test/reporter.mjs");
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
    const { default: TestReporter } = await import("../test/reporter.mjs");
    const reporter = new TestReporter();

    const err = new Error("boom");
    const cause = {};
    err.cause = cause;
    assert.equal(reporter._formatDiff(cause), null);
  });
});

test("reporter _relPath normalizes backslashes", async () => {
  const { default: TestReporter } = await import("../test/reporter.mjs");
  const reporter = new TestReporter();
  const cwd = process.cwd();

  // Path within cwd always produces forward slashes regardless of platform
  const absPath = join(cwd, "test", "foo.test.js");
  if (absPath.includes("\\")) {
    assert.ok(true, "Windows: _relPath converts backslashes");
  }
  const rel = reporter._relPath(absPath);
  assert.ok(!rel.includes("\\"), "no backslashes in output: " + rel);
  assert.ok(rel === "test/foo.test.js" || rel.endsWith("/test/foo.test.js"), "correct rel path: " + rel);

  // null/undefined guard
  assert.equal(reporter._relPath(null), null);
  assert.equal(reporter._relPath(undefined), undefined);
});

test("reporter _stringify handles objects and primitives", async () => {
  const { default: TestReporter } = await import("../test/reporter.mjs");
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
    const { default: TestReporter } = await import("../test/reporter.mjs");
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
    const { default: TestReporter } = await import("../test/reporter.mjs");
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
