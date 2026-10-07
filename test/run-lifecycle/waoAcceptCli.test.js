// test/run-lifecycle/waoAcceptCli.test.js
//
// TD-219 第一步（2026-10-06）：wao accept CLI 接线测试。
//
// 直接调命令处理函数（waoCommand，来自 src/commands/wao.js）——不把断言挂进
// test/isolation-infra/cli.test.js 全量套件（TD-219 任务合同明确）。覆盖：
//   - 参数解析：--run/--decision/--reason/--evidence-digest/--evidence-summary
//     透传落盘（--run-dir 与 config.runDir 两条解析路径）；
//   - --show 输出：列既有 acceptance.recorded、count、不追加；
//   - 错误文案：缺必填参数、在途 run 终态门、非法 decision 的透传文案。
//
// fixture 全在 os.tmpdir() 自建临时目录（Windows 纪律：显式 mkdtemp，不用
// /tmp 字面量），不触碰 runs/ 真实案卷。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { waoCommand, WAO_SUBCOMMANDS } from "../../src/commands/wao.js";
import { AcceptanceRecordError } from "../../src/application/acceptanceRecord.js";
import { recordAcceptance } from "../../src/application/acceptanceRecord.js";

// ===== Helpers =====

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function ev(obj) {
  return JSON.stringify(obj) + "\n";
}

function writeTranscript(dir, runId, lines) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.jsonl`), lines, "utf8");
}

function terminalTranscript(runId) {
  return [
    ev({ type: "run.submitted", ts: "2026-10-06T10:00:00.000Z", runId, agentId: "lead", seq: 1 }),
    ev({ type: "run.state_change", from: "running", to: "completed", reason: "done", ts: "2026-10-06T11:00:00.000Z", runId, agentId: "lead", seq: 2 }),
  ].join("");
}

function inflightTranscript(runId) {
  return [
    ev({ type: "run.submitted", ts: "2026-10-06T10:00:00.000Z", runId, agentId: "lead", seq: 1 }),
    ev({ type: "run.state_change", from: "pending", to: "running", reason: "started", ts: "2026-10-06T10:01:00.000Z", runId, agentId: "lead", seq: 2 }),
  ].join("");
}

function readLines(dir, runId) {
  return readFileSync(join(dir, `${runId}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** 捕获一次命令调用的 console.log 输出（与既有 CLI 测试同款 idiom）。 */
async function captureOutput(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

// ===== Tests =====

test("TD-219: wao accept 参数解析——--run/--decision/--reason/--evidence-* 透传并落盘", async () => {
  const dir = makeTempDir("wao-accept-cli-");
  try {
    const runId = "run_acceptcli12";
    writeTranscript(dir, runId, terminalTranscript(runId));
    const output = await captureOutput(() => waoCommand(
      [
        "accept",
        "--run", runId,
        "--decision", "accepted",
        "--reason", "harness 配置安装完成",
        "--evidence-digest", "0".repeat(64),
        "--evidence-summary", "证据：install.log 校验通过",
        "--run-dir", dir,
      ],
      { runDir: "runs" },
    ));
    const out = JSON.parse(output[0]);
    assert.equal(out.appended, true, "成功输出 appended:true");
    assert.equal(out.runId, runId, "输出回显 runId");
    assert.equal(out.seq, 3, "输出追加事件 seq");
    assert.equal(out.decision, "accepted", "输出回显 decision");

    const event = readLines(dir, runId)[2];
    assert.equal(event.type, "acceptance.recorded");
    assert.equal(event.reason, "harness 配置安装完成");
    assert.equal(event.evidenceDigest, "0".repeat(64));
    assert.equal(event.evidenceSummary, "证据：install.log 校验通过");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-219: wao accept 缺省 --run-dir 时用 config.runDir 解析", async () => {
  const dir = makeTempDir("wao-accept-configdir-");
  try {
    const runId = "run_acceptcfgdir13";
    writeTranscript(dir, runId, terminalTranscript(runId));
    const output = await captureOutput(() => waoCommand(
      ["accept", "--run", runId, "--decision", "rejected", "--reason", "证据不足"],
      { runDir: dir },
    ));
    const out = JSON.parse(output[0]);
    assert.equal(out.appended, true, "config.runDir 路径解析成功");
    assert.equal(readLines(dir, runId)[2].decision, "rejected");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-219: wao accept --show 只列既有 acceptance.recorded 并退出（不追加）", async () => {
  const dir = makeTempDir("wao-accept-show-");
  try {
    const runId = "run_acceptshow14";
    writeTranscript(dir, runId, terminalTranscript(runId));
    await recordAcceptance({ runsDir: dir, runId, decision: "rejected", reason: "第一笔：返工", now: "2026-10-06T12:00:00.000Z" });
    await recordAcceptance({ runsDir: dir, runId, decision: "accepted", reason: "第二笔：接受", now: "2026-10-06T13:00:00.000Z" });
    const before = readLines(dir, runId).length;

    const output = await captureOutput(() => waoCommand(
      ["accept", "--run", runId, "--show", "--run-dir", dir],
      { runDir: "runs" },
    ));
    const out = JSON.parse(output[0]);
    assert.equal(out.runId, runId);
    assert.equal(out.count, 2, "--show 列出全部既有记录");
    assert.equal(out.records[0].decision, "rejected");
    assert.equal(out.records[1].decision, "accepted", "追加顺序保留，最新一笔在末尾");
    assert.equal(out.records[1].reason, "第二笔：接受");
    assert.equal(readLines(dir, runId).length, before, "--show 不追加任何事件");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-219: wao accept --show 无记录 → count 0（exit 语义：正常输出，不报错）", async () => {
  const dir = makeTempDir("wao-accept-show-empty-");
  try {
    const runId = "run_acceptshowempty15";
    writeTranscript(dir, runId, terminalTranscript(runId));
    const output = await captureOutput(() => waoCommand(
      ["accept", "--run", runId, "--show", "--run-dir", dir],
      { runDir: "runs" },
    ));
    const out = JSON.parse(output[0]);
    assert.equal(out.count, 0, "无记录 → count 0");
    assert.deepEqual(out.records, [], "无记录 → 空数组");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-219: wao accept 错误文案——缺必填参数 fail-fast", async () => {
  const dir = makeTempDir("wao-accept-argv-");
  try {
    const runId = "run_acceptargv16";
    writeTranscript(dir, runId, terminalTranscript(runId));
    await assert.rejects(
      () => waoCommand(["accept", "--run-dir", dir], { runDir: "runs" }),
      /wao accept requires --run <runId>/,
      "缺 --run 报固定文案",
    );
    await assert.rejects(
      () => waoCommand(["accept", "--run", runId, "--reason", "x", "--run-dir", dir], { runDir: "runs" }),
      /wao accept requires --decision <accepted\|rejected>/,
      "缺 --decision 报固定文案",
    );
    await assert.rejects(
      () => waoCommand(["accept", "--run", runId, "--decision", "accepted", "--run-dir", dir], { runDir: "runs" }),
      /wao accept requires --reason <text>/,
      "缺 --reason 报固定文案",
    );
    await assert.rejects(
      () => waoCommand(["accept", "--show", "--run-dir", dir], { runDir: "runs" }),
      /wao accept --show requires --run <runId>/,
      "--show 缺 --run 报固定文案",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("TD-219: wao accept 服务错误透传——终态门与 decision 闭集文案", async () => {
  const dir = makeTempDir("wao-accept-errors-");
  try {
    const inflightId = "run_accepterrinflight17";
    const terminalId = "run_accepterrterminal18";
    writeTranscript(dir, inflightId, inflightTranscript(inflightId));
    writeTranscript(dir, terminalId, terminalTranscript(terminalId));

    await assert.rejects(
      () => waoCommand(["accept", "--run", inflightId, "--decision", "accepted", "--reason", "x", "--run-dir", dir], { runDir: "runs" }),
      (error) => error instanceof AcceptanceRecordError
        && error.code === "run_not_terminal"
        && /只对终态 run 记验收/.test(error.message),
      "在途 run 终态门拒绝文案透传（typed 错误）",
    );
    await assert.rejects(
      () => waoCommand(["accept", "--run", terminalId, "--decision", "maybe", "--reason", "x", "--run-dir", dir], { runDir: "runs" }),
      (error) => error instanceof AcceptanceRecordError
        && error.code === "invalid_decision"
        && /accepted 或 rejected/.test(error.message),
      "非法 decision 闭集拒绝文案透传（typed 错误）",
    );
    assert.equal(readLines(dir, terminalId).length, 2, "拒绝路径零追加");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-219: WAO_SUBCOMMANDS 闭集包含 accept（与 dispatch 同步）", () => {
  assert.ok(WAO_SUBCOMMANDS.includes("accept"), "accept 在 wao 子命令闭集");
});
