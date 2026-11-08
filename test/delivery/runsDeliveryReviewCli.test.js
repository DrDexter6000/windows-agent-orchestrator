// test/runsDeliveryReviewCli.test.js
//
// M11-3C: CLI `runs delivery review` sub-command — safe projection of the
// M11-3B application service over the CLI.
//
// Tests input parsing, JSON/text output parity with MCP, and regression of the
// existing delivery query/accept/reject commands.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { runsDeliveryCommand } from "../../src/commands/runs.js";

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map(String).join("\t")); };
  try { await fn(); }
  finally { console.log = orig; }
  return lines.join("\n");
}

function validReviewResult(overrides = {}) {
  return {
    runId: "run_review1",
    deliveryCommit: "a".repeat(40),
    fileIndex: 0,
    changedFileCount: 1,
    changedPath: "src/app.js",
    contentFormat: "unified_diff_v1",
    artifactTextTrust: "untrusted_repository_text",
    available: true,
    unavailableReason: null,
    fragment: "diff --git\n+hello\n",
    fragmentBytes: 18,
    nextCursor: null,
    truncated: false,
    ...overrides,
  };
}

// =====================================================================
// Group 1: review recognized + JSON output
// =====================================================================

test("M11-3C-CLI-01: runs delivery review <runId> --file-index 0 --format json outputs safe result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m113c-cli-01-"));
  try {
    const result = validReviewResult();
    const config = { runDir: dir };
    const out = await captureLog(async () => {
      await runsDeliveryCommand(["review", "run_review1", "--file-index", "0", "--format", "json"], config, { getRunDeliveryReviewFn: async () => result });
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.runId, "run_review1");
    assert.equal(parsed.available, true);
    assert.equal(parsed.contentFormat, "unified_diff_v1");
    assert.equal(parsed.artifactTextTrust, "untrusted_repository_text");
    assert.equal(parsed.fragment, result.fragment);
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 2: missing/duplicate/empty/negative/fractional file-index
// =====================================================================

test("M11-3C-CLI-02: missing/duplicate/empty/negative/fractional file-index rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m113c-cli-02-"));
  try {
    const config = { runDir: dir };
    // Missing --file-index
    await assert.rejects(
      () => runsDeliveryCommand(["review", "run_x"], config, { getRunDeliveryReviewFn: async () => validReviewResult() }),
      /file-index/i,
      "missing --file-index rejected",
    );
    // Duplicate --file-index
    await assert.rejects(
      () => runsDeliveryCommand(["review", "run_x", "--file-index", "0", "--file-index", "1"], config, { getRunDeliveryReviewFn: async () => validReviewResult() }),
      /file-index|duplicate/i,
      "duplicate --file-index rejected",
    );
    // Empty --file-index
    await assert.rejects(
      () => runsDeliveryCommand(["review", "run_x", "--file-index", ""], config, { getRunDeliveryReviewFn: async () => validReviewResult() }),
      /file-index|empty/i,
      "empty --file-index rejected",
    );
    // Negative
    await assert.rejects(
      () => runsDeliveryCommand(["review", "run_x", "--file-index", "-1"], config, { getRunDeliveryReviewFn: async () => validReviewResult() }),
      /file-index|negative|non-negative|integer/i,
      "negative file-index rejected",
    );
    // Fractional
    await assert.rejects(
      () => runsDeliveryCommand(["review", "run_x", "--file-index", "0.5"], config, { getRunDeliveryReviewFn: async () => validReviewResult() }),
      /file-index|integer/i,
      "fractional file-index rejected",
    );
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 3: missing runId / whitespace runId
// =====================================================================

test("M11-3C-CLI-03: missing/whitespace runId rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m113c-cli-03-"));
  try {
    const config = { runDir: dir };
    await assert.rejects(
      () => runsDeliveryCommand(["review", "--file-index", "0"], config, { getRunDeliveryReviewFn: async () => validReviewResult() }),
      /runId/i,
      "missing runId rejected",
    );
    await assert.rejects(
      () => runsDeliveryCommand(["review", "   ", "--file-index", "0"], config, { getRunDeliveryReviewFn: async () => validReviewResult() }),
      /runId|empty|whitespace/i,
      "whitespace runId rejected",
    );
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 4: text mode output (fragment + cursor + unavailable)
// =====================================================================

test("M11-3C-CLI-04: text mode outputs fragment + cursor + unavailable status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m113c-cli-04-"));
  try {
    // Available with continuation
    const config = { runDir: dir };
    const out1 = await captureLog(async () => {
      await runsDeliveryCommand(["review", "run_x", "--file-index", "0"], config, {
        getRunDeliveryReviewFn: async () => validReviewResult({
          runId: "run_x",
          fragment: "line1\nline2\n",
          fragmentBytes: 12,
          nextCursor: "abc123cursor",
          truncated: true,
        }),
      });
    });
    assert.ok(out1.includes("line1"), "text output contains fragment");
    assert.ok(/abc123cursor/.test(out1), "text output contains continuation cursor");

    // Binary
    const out2 = await captureLog(async () => {
      await runsDeliveryCommand(["review", "run_x", "--file-index", "0"], config, {
        getRunDeliveryReviewFn: async () => validReviewResult({
          runId: "run_x",
          available: false, unavailableReason: "binary", fragment: "", fragmentBytes: 0, nextCursor: null, truncated: false,
        }),
      });
    });
    assert.ok(/binary/i.test(out2), "text output mentions binary");

    // diff_too_large
    const out3 = await captureLog(async () => {
      await runsDeliveryCommand(["review", "run_x", "--file-index", "0"], config, {
        getRunDeliveryReviewFn: async () => validReviewResult({
          runId: "run_x",
          available: false, unavailableReason: "diff_too_large", fragment: "", fragmentBytes: 0, nextCursor: null, truncated: false,
        }),
      });
    });
    assert.ok(/diff_too_large|too.large/i.test(out3), "text output mentions diff_too_large");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 5: --cursor passed opaquely
// =====================================================================

test("M11-3C-CLI-05: --cursor passed opaquely to service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m113c-cli-05-"));
  try {
    let captured = null;
    const config = { runDir: dir };
    await captureLog(async () => {
      await runsDeliveryCommand(["review", "run_x", "--file-index", "0", "--cursor", "opaque-token"], config, {
        getRunDeliveryReviewFn: async (args) => { captured = args.cursor; return validReviewResult({ runId: "run_x" }); },
      });
    });
    assert.equal(captured, "opaque-token", "cursor passed opaquely");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// M11-3C closeout: CLI strict parser — extra positional, duplicate flags,
// whitespace, unknown format all rejected.
// =====================================================================

test("M11-3C-CLI-CLOSE: extra positional / duplicate flags / whitespace / unknown format rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m113c-cli-close-"));
  try {
    const config = { runDir: dir };
    const svc = async () => validReviewResult({ runId: "run_x" });

    // extra positional (two runIds)
    await assert.rejects(
      () => runsDeliveryCommand(["review", "run_x", "extra", "--file-index", "0"], config, { getRunDeliveryReviewFn: svc }),
      /exactly one|runId/i,
      "extra positional rejected",
    );
    // duplicate --format
    await assert.rejects(
      () => runsDeliveryCommand(["review", "run_x", "--file-index", "0", "--format", "json", "--format", "json"], config, { getRunDeliveryReviewFn: svc }),
      /multiple|duplicate/i,
      "duplicate --format rejected",
    );
    // duplicate --cwd
    await assert.rejects(
      () => runsDeliveryCommand(["review", "run_x", "--file-index", "0", "--cwd", "/a", "--cwd", "/b"], config, { getRunDeliveryReviewFn: svc }),
      /multiple|duplicate/i,
      "duplicate --cwd rejected",
    );
    // whitespace cursor
    await assert.rejects(
      () => runsDeliveryCommand(["review", "run_x", "--file-index", "0", "--cursor", "   "], config, { getRunDeliveryReviewFn: svc }),
      /cursor|non-empty|opaque/i,
      "whitespace cursor rejected",
    );
    // unknown format
    await assert.rejects(
      () => runsDeliveryCommand(["review", "run_x", "--file-index", "0", "--format", "xml"], config, { getRunDeliveryReviewFn: svc }),
      /format|json/i,
      "unknown format rejected",
    );
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// M11-3C closeout: --run-dir is an authorized CLI parity flag
// =====================================================================

test("M11-3C-CLI-RUNDIR: --run-dir passes through to service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m113c-cli-rd-"));
  const customRunDir = mkdtempSync(join(tmpdir(), "m113c-cli-rd-custom-"));
  try {
    let capturedRunDir = null;
    const config = { runDir: dir };
    await captureLog(async () => {
      await runsDeliveryCommand(
        ["review", "run_x", "--file-index", "0", "--run-dir", customRunDir],
        config,
        { getRunDeliveryReviewFn: async (args) => {
          capturedRunDir = args.runDir;
          return validReviewResult({ runId: "run_x" });
        } },
      );
    });
    assert.equal(capturedRunDir, customRunDir, "--run-dir overrides config.runDir");
  } finally {
    cleanupDir(dir);
    cleanupDir(customRunDir);
  }
});

// =====================================================================
// TD-324（83 批 W2）：CLI 单文件 review 的归属拒绝专属固定文案——运行不属于
// --cwd（缺省当前目录）给的工作区时打印「run_delivery_review refused: … pass
// --cwd with the run's own project root」并抛错（cli.js 顶层 catch 置非零退
// 出）；其它失败照旧原样上抛（既有失败形状不变）。
// =====================================================================

test("TD-324-CLI: ownership refusal → dedicated fixed text, non-zero exit shape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "td324-cli-rev-"));
  try {
    const config = { runDir: dir };
    // 服务层以 typed code 拒绝（真实链由 MCP 面的 TD-324 用例证明；此处钉 CLI 折叠）。
    const typedRefusal = () => {
      const e = new Error("workspace mismatch: run ownership does not match authorized workspace");
      e.code = "workspace_not_authorized";
      throw e;
    };
    await assert.rejects(
      () => runsDeliveryCommand(
        ["review", "run_td324", "--file-index", "0"],
        config,
        { getRunDeliveryReviewFn: typedRefusal },
      ),
      (err) => {
        assert.match(err.message, /^run_delivery_review refused: this run cannot be shown to belong to the workspace given by --cwd \(default: the current directory\)/,
          "归属拒绝专属 CLI 固定文案");
        assert.match(err.message, /duplicated, incomplete \(no cwd\) or in conflict/, "原因清单为完整的六类");
        assert.match(err.message, /Pass --cwd with the run's own project root and retry\.$/, "结尾指引换根重试");
        assert.ok(!err.message.includes("run_delivery_review failed"), "不再报笼统失败文案");
        assert.ok(!err.message.includes(dir), "不回显路径");
        return true;
      },
      "ownership refusal rejects with the dedicated fixed text",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("TD-324-CLI: other service failure → original raw error shape unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "td324-cli-rev2-"));
  try {
    const config = { runDir: dir };
    // 非归属失败（如资格不足）照旧原样上抛——单文件模式的既有失败形状不变。
    await assert.rejects(
      () => runsDeliveryCommand(
        ["review", "run_td324b", "--file-index", "0"],
        config,
        { getRunDeliveryReviewFn: async () => { throw new Error("delivery facts not reviewable: no usable delivery_created"); } },
      ),
      /delivery facts not reviewable/,
      "other failures keep the original raw error message",
    );
  } finally {
    cleanupDir(dir);
  }
});
