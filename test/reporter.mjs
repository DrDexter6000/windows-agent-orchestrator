import { Transform } from "node:stream";
import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

export default class TestReporter extends Transform {
  constructor() {
    super({ writableObjectMode: true, readableObjectMode: true });
    this._suites = new Map();
    this._failErrors = new Map();
    this._processed = new Set();
    this._startTime = Date.now();
    this._summary = { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
    this._cwd = process.cwd();
  }

  _relPath(absPath) {
    if (!absPath) return absPath;
    const rel = relative(this._cwd, absPath);
    return rel.replace(/\\/g, "/");
  }

  _transform(event, encoding, callback) {
    if (event.type === "test:fail") {
      const err = event.data?.details?.error;
      const cause = err?.cause;
      if (cause && (cause.actual !== undefined || cause.expected !== undefined)) {
        const key = `${event.data.file}:${event.data.name}`;
        this._failErrors.set(key, {
          actual: this._stringify(cause.actual),
          expected: this._stringify(cause.expected),
          operator: cause.operator ?? "fail",
          stack: cause.stack ?? "",
          diff: this._formatDiff(cause),
        });
      }
      return callback(null);
    }

    if (event.type === "test:complete") {
      const { name, file, details } = event.data;
      if (!file) return callback(null);

      const normName = name.replace(/\\/g, "/");
      const normFile = file.replace(/\\/g, "/");
      const fileName = normFile.split("/").pop();
      const relativeName = relative(this._cwd, file).replace(/\\/g, "/");
      if (normName === normFile || normName === fileName || normName === relativeName) return callback(null);

      const dedupKey = `${file}:${name}`;
      if (this._processed.has(dedupKey)) return callback(null);
      this._processed.add(dedupKey);

      const status = details?.passed ? "pass" : details?.skip ? "skip" : "fail";

      const suiteName = this._relPath(file);
      if (!this._suites.has(file)) {
        this._suites.set(file, { name: suiteName, status: "pass", duration: 0, tests: [] });
      }
      const suite = this._suites.get(file);

      const entry = {
        name,
        status,
        duration: details?.duration_ms ?? 0,
      };
      if (status === "fail") {
        const stored = this._failErrors.get(dedupKey) || this._extractError(event);
        if (stored) entry.error = stored;
        suite.status = "fail";
      }

      suite.tests.push(entry);
      suite.duration += entry.duration;
      this._summary.total += 1;
      if (status === "pass") this._summary.passed += 1;
      else if (status === "fail") this._summary.failed += 1;
      else if (status === "skip") this._summary.skipped += 1;
      else this._summary.todo += 1;

      return callback(null);
    }

    callback(null);
  }

  _flush(callback) {
    const data = {
      timestamp: new Date().toISOString(),
      duration: Date.now() - this._startTime,
      summary: this._summary,
      suites: [...this._suites.values()],
    };
    const outPath = join(process.cwd(), "test-results.json");
    writeFile(outPath, JSON.stringify(data, null, 2), "utf8")
      .then(() => callback())
      .catch((err) => callback(err));
  }

  _extractError(event) {
    const err = event.data?.details?.error;
    if (!err) return null;
    const cause = err.cause;
    if (cause) {
      return {
        actual: this._stringify(cause.actual),
        expected: this._stringify(cause.expected),
        operator: cause.operator ?? "fail",
        stack: cause.stack ?? err.stack ?? "",
        diff: this._formatDiff(cause),
      };
    }
    return {
      actual: "",
      expected: "",
      operator: "fail",
      stack: err.stack ?? "",
      diff: null,
    };
  }

  _stringify(value) {
    if (value === undefined) return "";
    if (typeof value === "object" && value !== null) {
      try { return JSON.stringify(value); } catch { return String(value); }
    }
    return String(value);
  }

  _formatDiff(error) {
    const actual = error.actual;
    const expected = error.expected;
    if (actual === undefined && expected === undefined) return null;
    return `- Expected: ${JSON.stringify(expected)}\n+ Received: ${JSON.stringify(actual)}`;
  }
}
