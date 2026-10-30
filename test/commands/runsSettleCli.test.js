// test/commands/runsSettleCli.test.js
//
// `runs settle` 的 CLI 接线（任务第 3 步）：临时 run 目录上跑一遍列候选、
// dry-run、apply；理由文件缺失/为空的报错。数据逻辑的门测试在
// test/application/runSettle.test.js——这里只钉 argv/输出/退出码。
//
// 进程探测与时钟经 runsCommand 第三参 deps 注入（runsDashboardCommand 同款
// 先例），零真实 PowerShell。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runsCommand, RUNS_SUBCOMMANDS } from "../../src/commands/runs.js";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const OLD = "2026-09-01T00:00:00.000Z";

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

const ev = (runId, seq, type, ts, extra = {}) => ({
  runId, agentId: "coder_x", type, seq, ts, ...extra,
});

function seedCandidate(runDir, runId) {
  writeFileSync(join(runDir, `${runId}.jsonl`), `${[
    ev(runId, 1, "run.started", OLD, { backend: "claude-code" }),
    ev(runId, 2, "run.background_submitted", OLD, { background: true }),
    ev(runId, 3, "run.state_change", OLD, { from: null, to: "pending", reason: "background_spawned" }),
  ].map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
}

function cliDeps() {
  return {
    nowFn: () => NOW,
    ownerLeaseReader: () => ({ present: false }),
    identifyFn: async () => ({ verdict: "gone", basis: "pid_exited" }),
    runnerScanFn: async () => ({ alive: false }),
    handshakeReader: () => ({ present: false }),
    daemonAliveFn: () => false,
  };
}

async function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

test("CLI-SETTLE-0: 子命令登记", () => {
  assert.ok(RUNS_SUBCOMMANDS.includes("settle"));
});

test("CLI-SETTLE-1: 列候选——只读 JSON 输出", async () => {
  const dir = tempDir("wao-cli-settle1-");
  try {
    seedCandidate(dir, "run_cli_a");
    seedCandidate(dir, "run_cli_done");
    writeFileSync(join(dir, "run_cli_done.jsonl"), `${[
      ev("run_cli_done", 1, "run.state_change", OLD, { from: null, to: "completed", reason: "done" }),
    ].map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    const out = await capture(() => runsCommand(["settle", "--run-dir", dir], { runDir: dir }, cliDeps()));
    const parsed = JSON.parse(out);
    assert.equal(parsed.runDir, dir);
    assert.deepEqual(parsed.candidates.map((c) => c.runId), ["run_cli_a"], "终态运行不列");
    assert.equal(parsed.candidates[0].eligible, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI-SETTLE-2: dry-run——逐门事实输出、转录不变", async () => {
  const dir = tempDir("wao-cli-settle2-");
  try {
    seedCandidate(dir, "run_cli_b");
    const reasonFile = join(dir, "reason.txt");
    writeFileSync(reasonFile, "机器重启后 runner 不在了。\n", "utf8");
    const tp = join(dir, "run_cli_b.jsonl");
    const before = readFileSync(tp, "utf8");
    const out = await capture(() => runsCommand(
      ["settle", "--run-id", "run_cli_b", "--reason-file", reasonFile, "--run-dir", dir],
      { runDir: dir },
      cliDeps(),
    ));
    const parsed = JSON.parse(out);
    assert.equal(parsed.eligible, true);
    assert.equal(parsed.sessionShape, "no_session");
    assert.equal(parsed.gates.length, 6, "六道门逐条给事实");
    assert.ok(parsed.gates.every((g) => typeof g.gate === "string" && typeof g.detail === "string"), "每门有 gate + detail");
    assert.ok(parsed.note.includes("dry-run"));
    assert.equal(readFileSync(tp, "utf8"), before, "dry-run 零写入");
    assert.equal(process.exitCode, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI-SETTLE-3: apply——写入终态与确认事实", async () => {
  const dir = tempDir("wao-cli-settle3-");
  try {
    seedCandidate(dir, "run_cli_c");
    const reasonFile = join(dir, "reason.txt");
    writeFileSync(reasonFile, "runner 已死，转录无终态记录。\n", "utf8");
    const out = await capture(() => runsCommand(
      ["settle", "--run-id", "run_cli_c", "--reason-file", reasonFile, "--apply", "--run-dir", dir],
      { runDir: dir },
      cliDeps(),
    ));
    const parsed = JSON.parse(out);
    assert.equal(parsed.settled, true);
    const lines = readFileSync(join(dir, "run_cli_c.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const confirm = lines.find((e) => e.type === "run.process_missing_confirmed");
    const terminal = lines.find((e) => e.type === "run.state_change" && e.to === "failed");
    assert.ok(confirm && terminal, "确认事实 + 终态落盘");
    assert.equal(confirm.reason.trim(), "runner 已死，转录无终态记录。", "理由正文有界落盘（trim 后）");
    assert.equal(terminal.reason, "process_missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI-SETTLE-4: 拒绝时 refused + 退出码 1", async () => {
  const dir = tempDir("wao-cli-settle4-");
  try {
    seedCandidate(dir, "run_cli_d");
    const reasonFile = join(dir, "reason.txt");
    writeFileSync(reasonFile, "前台运行应被拒。\n", "utf8");
    // 前台形状：去掉 background_submitted → foreground_no_session。
    writeFileSync(join(dir, "run_cli_d.jsonl"), `${[
      ev("run_cli_d", 1, "run.started", OLD, { backend: "claude-code" }),
      ev("run_cli_d", 2, "run.state_change", OLD, { from: null, to: "running", reason: "first_event" }),
    ].map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
    const out = await capture(() => runsCommand(
      ["settle", "--run-id", "run_cli_d", "--reason-file", reasonFile, "--run-dir", dir],
      { runDir: dir },
      cliDeps(),
    ));
    const parsed = JSON.parse(out);
    assert.equal(parsed.refused, "foreground_no_session");
    assert.ok(Array.isArray(parsed.gates));
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI-SETTLE-5: --reason-file 缺失或为空 → 报错", async () => {
  const dir = tempDir("wao-cli-settle5-");
  try {
    seedCandidate(dir, "run_cli_e");
    await assert.rejects(
      () => capture(() => runsCommand(
        ["settle", "--run-id", "run_cli_e", "--run-dir", dir],
        { runDir: dir },
        cliDeps(),
      )),
      /--reason-file is required/,
    );
    const empty = join(dir, "empty.txt");
    writeFileSync(empty, "   \n", "utf8");
    await assert.rejects(
      () => capture(() => runsCommand(
        ["settle", "--run-id", "run_cli_e", "--reason-file", empty, "--run-dir", dir],
        { runDir: dir },
        cliDeps(),
      )),
      /non-empty/,
    );
    await assert.rejects(
      () => capture(() => runsCommand(
        ["settle", "--run-id", "run_cli_e", "--reason-file", join(dir, "nope.txt"), "--run-dir", dir],
        { runDir: dir },
        cliDeps(),
      )),
      /could not be read/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI-SETTLE-6: CLI 注入真实三态读器——runDir 里残留读不出内容的 daemon.json → 门 6 daemon_owned", async () => {
  const dir = tempDir("wao-cli-settle6-");
  try {
    seedCandidate(dir, "run_cli_f");
    // 不传 handshakeReader 覆写：生产注入的 readHandshakeDetailed 读真实文件。
    // 半截 JSON（daemon 崩在写一半）不能当成"没有 daemon"放行。
    writeFileSync(join(dir, "daemon.json"), '{"pid":123', "utf8");
    const reasonFile = join(dir, "reason.txt");
    writeFileSync(reasonFile, "runner 已死，但 daemon 握手文件读不出。\n", "utf8");
    const deps = cliDeps();
    delete deps.handshakeReader; // 让生产的真实读器注入生效
    const out = await capture(() => runsCommand(
      ["settle", "--run-id", "run_cli_f", "--reason-file", reasonFile, "--run-dir", dir],
      { runDir: dir },
      deps,
    ));
    const parsed = JSON.parse(out);
    assert.equal(parsed.refused, "daemon_owned");
    const daemonFact = parsed.gates.find((g) => g.gate === "daemon");
    assert.match(daemonFact.detail, /握手文件在但读不出/);
  } finally {
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  }
});
