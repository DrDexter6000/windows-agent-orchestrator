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
    // TD-255（决定 0059）：文件级根失败的可归属性判定需要三类"事实"，
    // 本 reporter 只记录、不判定（判定=canonical-test.mjs 的纯函数，
    // 与 classifyAutoAdjudication 同处，旧报告缺字段自然判非回响）：
    //   _fileSummaries   — 逐文件 test:summary 的 counts（echo 形态有、
    //                      提前退出/超时击杀形态缺——node v22.23.1 实测）
    //   _fileDiagnostics — 带 file 的 test:diagnostic 计数（迟到异步错误
    //                      只进这里，tests[] 看不见——sol 反例防线）
    //   _fileLevelOnly   — 文件级 complete(passed=true) 且零子测事件的文件
    //                      （顶层脚本形状；状态仍 missing，只是原因可判定）
    this._fileSummaries = new Map();
    this._fileDiagnostics = new Map();
    this._fileLevelOnly = new Set();
  }

  _relPath(absPath) {
    if (!absPath) return absPath;
    const rel = relative(this._cwd, absPath);
    return rel.replace(/\\/g, "/");
  }

  _transform(event, encoding, callback) {
    if (event.type === "test:summary") {
      // 逐文件 summary（data.file 在场）：node 在文件正常跑完时发，提前
      // exit/被杀/超时击杀时缺——"子进程跑完了"的完成性证明。
      const file = event.data?.file;
      if (typeof file === "string" && file) {
        const counts = event.data?.counts;
        this._fileSummaries.set(file, counts && typeof counts === "object" ? { ...counts } : null);
      }
      return callback(null);
    }

    if (event.type === "test:diagnostic") {
      // 只数带 file 的诊断（文件关联的未归属错误——迟到异步 throw 只进这里）。
      // file=null 的根级诊断（运行器自身输出）不计。
      const file = event.data?.file;
      if (typeof file === "string" && file) {
        this._fileDiagnostics.set(file, (this._fileDiagnostics.get(file) ?? 0) + 1);
      }
      return callback(null);
    }

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
      // TD-165 F3: a file-level test:fail (name is the file path) is the only
      // structured failure signal a timed-out test ever emits — the hung test
      // itself never reports. Record it on the suite so the failure stays
      // attributable to the FILE (never only a wave-level groupError).
      if (this._isFileLevelName(event.data?.name, event.data?.file)) {
        this._recordFileLevelFailure(event.data, err);
      }
      return callback(null);
    }

    if (event.type === "test:complete") {
      const { name, file, details } = event.data;
      if (!file) return callback(null);

      if (this._isFileLevelName(name, file)) {
        // TD-165 F3: a file-level completion that FAILED (e.g. node timed a
        // test out — details.error carries the structured reason) must leave
        // the suite non-pass WITH that reason. A file-level PASS stays
        // filtered exactly as before (no entry, no summary count) — but a
        // file that produces ZERO subtest events is a distinct, diagnosable
        // shape (top-level-script), so TD-255 records it as a fact.
        if (details?.passed === false) this._recordFileLevelFailure(event.data, details?.error);
        else if (!this._suites.has(file)) this._fileLevelOnly.add(file);
        return callback(null);
      }

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
    // TD-255 事实面：逐文件 summary/diagnostic 挂到对应 suite（键=绝对路径，
    // 与 _suites 同键）；fileLevelOnly 以相对名输出（后来出现子测事件的文件
    // 被过滤——顺序防御，正常顺序本就文件级最后）。
    for (const [file, suite] of this._suites) {
      suite.fileSummary = this._fileSummaries.get(file) ?? null;
      suite.fileDiagnostics = this._fileDiagnostics.get(file) ?? 0;
    }
    const data = {
      timestamp: new Date().toISOString(),
      duration: Date.now() - this._startTime,
      summary: this._summary,
      suites: [...this._suites.values()],
      fileLevelOnly: [...this._fileLevelOnly]
        .filter((file) => !this._suites.has(file))
        .map((file) => this._relPath(file)),
    };
    const outPath = join(process.cwd(), "test-results.json");
    writeFile(outPath, JSON.stringify(data, null, 2), "utf8")
      .then(() => callback())
      .catch((err) => callback(err));
  }

  _isFileLevelName(name, file) {
    if (!name || !file) return false;
    const normName = String(name).replace(/\\/g, "/");
    const normFile = String(file).replace(/\\/g, "/");
    const fileName = normFile.split("/").pop();
    const relativeName = relative(this._cwd, file).replace(/\\/g, "/");
    return normName === normFile || normName === fileName || normName === relativeName;
  }

  // TD-165 F3: mark the file's suite failed with the structured reason from a
  // file-level failure event. Idempotent (fail is sticky, first reason wins);
  // never adds a tests[] entry or summary count — those belong to real
  // test:complete events only, so existing accounting is unchanged.
  // TD-255（0059）：除 message/stack 外保留 code/failureType 原始字段——
  // 消费侧回响判据用（"test failed"+ERR_TEST_FAILURE+subtestsFailed）。
  _recordFileLevelFailure(data, err) {
    const file = data?.file;
    if (!file || typeof file !== "string") return;
    const suiteName = this._relPath(file);
    if (!this._suites.has(file)) {
      this._suites.set(file, { name: suiteName, status: "pass", duration: 0, tests: [] });
    }
    const suite = this._suites.get(file);
    suite.status = "fail";
    if (!suite.fileFailure && err) {
      suite.fileFailure = {
        message: err.message ?? "",
        stack: err.stack ?? "",
        code: err.code ?? null,
        failureType: err.failureType ?? null,
      };
    }
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
