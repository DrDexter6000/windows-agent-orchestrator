// test/transcript/acceptanceRecord.test.js
//
// TD-219 第一步（2026-10-06）：非 delivery run 的 Lead 侧验收落盘——application
// 服务单测（recordAcceptance / listAcceptance）。
//
// 覆盖合同面：
//   - decision 闭集拒绝（accepted/rejected 之外一律 typed 拒绝、零追加）；
//   - reason 必填非空 / 超长拒绝（固定文案不回显超长原文）；
//   - evidenceDigest 格式拒绝（sha256 hex 闭集）/ evidenceSummary 超长与非字符串拒绝；
//   - runId 闭集拒绝（run_<字母数字>，对照仓库生成模式）+ 缺失拒绝；
//   - 终态门：终态 fixture 通过、在途 fixture typed 拒绝且文案说明"只对终态 run 记验收"；
//   - 追加事件形状：精确键集（无多余键）+ 净化（剥控制字符）+ 信封 seq 递增；
//   - 多笔追加合法（审计日志语义，最新一笔为当前结论）；
//   - listAcceptance 只返回本 run 的 acceptance.recorded；transcript 缺失 typed 错误。
//
// fixture 全在 os.tmpdir() 自建临时目录（Windows 纪律：显式 mkdtemp，不用 /tmp 字面量），
// 不触碰 runs/ 真实案卷。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  recordAcceptance,
  listAcceptance,
  AcceptanceRecordError,
  ACCEPTANCE_DECISIONS,
  REASON_MAX_LENGTH,
  EVIDENCE_SUMMARY_MAX_LENGTH,
} from "../../src/application/acceptanceRecord.js";

// ===== Helpers =====

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function writeTranscript(dir, runId, lines) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.jsonl`), lines, "utf8");
}

function ev(obj) {
  return JSON.stringify(obj) + "\n";
}

function readLines(dir, runId) {
  return readFileSync(join(dir, `${runId}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const FIXED_NOW = "2026-10-06T12:00:00.000Z";
const VALID_DIGEST = "0123456789abcdef".repeat(4); // 恰 64 位小写十六进制

/** 终态 fixture：completed 终态（TERMINAL_STATES 闭集成员）。 */
function terminalTranscript(runId) {
  return [
    ev({ type: "run.submitted", ts: "2026-10-06T10:00:00.000Z", runId, agentId: "lead", seq: 1 }),
    ev({ type: "run.state_change", from: "running", to: "completed", reason: "done", ts: "2026-10-06T11:00:00.000Z", runId, agentId: "lead", seq: 2 }),
  ].join("");
}

/** 在途 fixture：running 非终态。 */
function inflightTranscript(runId) {
  return [
    ev({ type: "run.submitted", ts: "2026-10-06T10:00:00.000Z", runId, agentId: "lead", seq: 1 }),
    ev({ type: "run.state_change", from: "pending", to: "running", reason: "started", ts: "2026-10-06T10:01:00.000Z", runId, agentId: "lead", seq: 2 }),
  ].join("");
}

// ===== Tests =====

test("TD-219: decision 闭集——accepted/rejected 之外一律 typed 拒绝且零追加", async () => {
  const dir = makeTempDir("wao-accept-decision-");
  try {
    const runId = "run_acceptdecision1";
    writeTranscript(dir, runId, terminalTranscript(runId));
    for (const bad of ["maybe", "ACCEPTED", "", "accepted ", " accepted", "reject", undefined, 42]) {
      await assert.rejects(
        () => recordAcceptance({ runsDir: dir, runId, decision: bad, reason: "验收通过", now: FIXED_NOW }),
        (error) => error instanceof AcceptanceRecordError && error.code === "invalid_decision",
        `decision=${JSON.stringify(bad)} 必须被 typed 拒绝`,
      );
    }
    assert.equal(readLines(dir, runId).length, 2, "全部拒绝路径零追加");
    // 闭集常量自洽：两个合法值都能走通。
    assert.deepEqual(ACCEPTANCE_DECISIONS, ["accepted", "rejected"], "decision 闭集 SSOT 漂移");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-219: reason 必填非空，超长 typed 拒绝且固定文案不回显超长原文", async () => {
  const dir = makeTempDir("wao-accept-reason-");
  try {
    const runId = "run_acceptreason2";
    writeTranscript(dir, runId, terminalTranscript(runId));
    for (const bad of [undefined, null, "", "   ", "\t\n"]) {
      await assert.rejects(
        () => recordAcceptance({ runsDir: dir, runId, decision: "accepted", reason: bad, now: FIXED_NOW }),
        (error) => error instanceof AcceptanceRecordError && error.code === "invalid_reason",
        `reason=${JSON.stringify(bad)} 必须被 typed 拒绝`,
      );
    }
    const longReason = "长".repeat(REASON_MAX_LENGTH + 1);
    await assert.rejects(
      () => recordAcceptance({ runsDir: dir, runId, decision: "accepted", reason: longReason, now: FIXED_NOW }),
      (error) => error instanceof AcceptanceRecordError
        && error.code === "invalid_reason"
        && !error.message.includes(longReason)
        && error.message.includes(String(REASON_MAX_LENGTH)),
      "超长 reason 拒绝文案为固定文本，绝不回显超长原文",
    );
    assert.equal(readLines(dir, runId).length, 2, "拒绝路径零追加");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-219: evidenceDigest 格式拒绝——只收 64 位小写十六进制（sha256 hex）", async () => {
  const dir = makeTempDir("wao-accept-digest-");
  try {
    const runId = "run_acceptdigest3";
    writeTranscript(dir, runId, terminalTranscript(runId));
    const bad = [
      "abc",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
      "0".repeat(63) + "x",
      12345,
    ];
    for (const digest of bad) {
      await assert.rejects(
        () => recordAcceptance({ runsDir: dir, runId, decision: "accepted", reason: "x", evidenceDigest: digest, now: FIXED_NOW }),
        (error) => error instanceof AcceptanceRecordError && error.code === "invalid_evidence_digest",
        `digest=${JSON.stringify(digest)} 必须被 typed 拒绝`,
      );
    }
    // 合法 sha256 hex 通过并落盘。
    const result = await recordAcceptance({
      runsDir: dir, runId, decision: "accepted", reason: "x", evidenceDigest: VALID_DIGEST, now: FIXED_NOW,
    });
    assert.equal(result.appended, true, "合法 digest 追加成功");
    const event = readLines(dir, runId)[2];
    assert.equal(event.evidenceDigest, VALID_DIGEST, "合法 digest 原样落盘");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-219: evidenceSummary 非字符串/超长 typed 拒绝", async () => {
  const dir = makeTempDir("wao-accept-summary-");
  try {
    const runId = "run_acceptsummary4";
    writeTranscript(dir, runId, terminalTranscript(runId));
    await assert.rejects(
      () => recordAcceptance({ runsDir: dir, runId, decision: "accepted", reason: "x", evidenceSummary: 42, now: FIXED_NOW }),
      (error) => error instanceof AcceptanceRecordError && error.code === "invalid_evidence_summary",
      "非字符串 evidenceSummary 必须被 typed 拒绝",
    );
    const longSummary = "摘".repeat(EVIDENCE_SUMMARY_MAX_LENGTH + 1);
    await assert.rejects(
      () => recordAcceptance({ runsDir: dir, runId, decision: "accepted", reason: "x", evidenceSummary: longSummary, now: FIXED_NOW }),
      (error) => error instanceof AcceptanceRecordError
        && error.code === "invalid_evidence_summary"
        && !error.message.includes(longSummary),
      "超长 evidenceSummary 拒绝文案为固定文本，不回显超长原文",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("TD-219: runId 闭集拒绝（run_<字母数字>，含缺失）", async () => {
  const dir = makeTempDir("wao-accept-runid-");
  try {
    const runId = "run_acceptrunid5";
    writeTranscript(dir, runId, terminalTranscript(runId));
    const bad = [
      undefined, null, "", "run_", "run_has space", "run-x", "run_x-y",
      "run_/etc", "../run_escape", "run_中文", "no_prefix", "RUN_x", "run_!@#", 42,
    ];
    for (const badRunId of bad) {
      await assert.rejects(
        () => recordAcceptance({ runsDir: dir, runId: badRunId, decision: "accepted", reason: "x", now: FIXED_NOW }),
        (error) => error instanceof AcceptanceRecordError && error.code === "invalid_run_id",
        `runId=${JSON.stringify(badRunId)} 必须被 typed 拒绝`,
      );
    }
    // 对照仓库生成模式（backgroundRunner.js：run_<时间戳><随机36进制>）的形态可通过。
    const generated = "run_20261006230352elywk9";
    writeTranscript(dir, generated, terminalTranscript(generated));
    const result = await recordAcceptance({ runsDir: dir, runId: generated, decision: "accepted", reason: "x", now: FIXED_NOW });
    assert.equal(result.appended, true, "生成模式形态的 runId 可通过");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-219: 终态门——终态 fixture 通过、在途 fixture typed 拒绝且文案说明只对终态 run 记验收", async () => {
  const dir = makeTempDir("wao-accept-gate-");
  try {
    const terminalId = "run_acceptterminal6";
    const inflightId = "run_acceptinflight7";
    writeTranscript(dir, terminalId, terminalTranscript(terminalId));
    writeTranscript(dir, inflightId, inflightTranscript(inflightId));

    const ok = await recordAcceptance({ runsDir: dir, runId: terminalId, decision: "accepted", reason: "终态验收", now: FIXED_NOW });
    assert.deepEqual(ok, { appended: true, seq: 3 }, "终态 run 追加成功，seq 递增");

    await assert.rejects(
      () => recordAcceptance({ runsDir: dir, runId: inflightId, decision: "accepted", reason: "x", now: FIXED_NOW }),
      (error) => error instanceof AcceptanceRecordError
        && error.code === "run_not_terminal"
        && /只对终态 run 记验收/.test(error.message),
      "在途 run 必须被 typed 拒绝，文案说明只对终态 run 记验收",
    );
    assert.equal(readLines(dir, inflightId).length, 2, "在途拒绝零追加");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-219: transcript 缺失——recordAcceptance 与 listAcceptance 都 typed 错误", async () => {
  const dir = makeTempDir("wao-accept-missing-");
  try {
    const runId = "run_acceptmissing8";
    await assert.rejects(
      () => recordAcceptance({ runsDir: dir, runId, decision: "accepted", reason: "x", now: FIXED_NOW }),
      (error) => error instanceof AcceptanceRecordError && error.code === "run_transcript_missing",
      "recordAcceptance 对缺失 transcript 必须 typed 拒绝",
    );
    await assert.rejects(
      () => listAcceptance({ runsDir: dir, runId }),
      (error) => error instanceof AcceptanceRecordError && error.code === "run_transcript_missing",
      "listAcceptance 对缺失 transcript 必须 typed 拒绝",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("TD-219: 追加事件形状——精确键集（无多余键）、净化 reason、recordedBy/recordedAt/source", async () => {
  const dir = makeTempDir("wao-accept-shape-");
  try {
    const runId = "run_acceptshape9";
    writeTranscript(dir, runId, terminalTranscript(runId));
    // reason/summary 混入 C0/C1/DEL 控制字符 + 首尾空白 → 净化后落盘。
    const reason = "  完成\u0000配置\u0007\u001F安装\u007F  ";
    const summary = "证据\u0000摘要\u001F  ";
    const result = await recordAcceptance({
      runsDir: dir,
      runId,
      decision: "accepted",
      reason,
      evidenceDigest: VALID_DIGEST,
      evidenceSummary: summary,
      now: FIXED_NOW,
    });
    assert.deepEqual(result, { appended: true, seq: 3 }, "返回 {appended:true, seq}");

    const lines = readLines(dir, runId);
    assert.equal(lines.length, 3, "恰追加一笔");
    const event = lines[2];
    assert.deepEqual(
      Object.keys(event).sort(),
      ["agentId", "decision", "evidenceDigest", "evidenceSummary", "reason", "recordedAt", "recordedBy", "runId", "seq", "source", "ts", "type"].sort(),
      "精确键集——无多余键",
    );
    assert.equal(event.type, "acceptance.recorded");
    assert.equal(event.decision, "accepted");
    assert.equal(event.reason, "完成配置安装", "reason 剥控制字符 + trim");
    assert.equal(event.evidenceDigest, VALID_DIGEST);
    assert.equal(event.evidenceSummary, "证据摘要", "summary 剥控制字符 + trim");
    assert.equal(event.recordedBy, "lead");
    assert.equal(event.recordedAt, FIXED_NOW, "recordedAt = 传入的 now ISO");
    assert.equal(event.source, "cli");
    assert.equal(event.runId, runId, "信封 runId 绑定");
    assert.equal(event.agentId, "lead", "信封 agentId 来自 transcript 上下文（与 runCollect 同通道）");
    assert.equal(typeof event.ts, "string", "信封 ts 存在");
    assert.equal(event.seq, 3);

    // 无可选字段：精确键集不含 evidenceDigest/evidenceSummary。
    await recordAcceptance({ runsDir: dir, runId, decision: "rejected", reason: "返工", now: FIXED_NOW });
    const second = readLines(dir, runId)[3];
    assert.deepEqual(
      Object.keys(second).sort(),
      ["agentId", "decision", "reason", "recordedAt", "recordedBy", "runId", "seq", "source", "ts", "type"].sort(),
      "可选字段缺省时键集不含 evidenceDigest/evidenceSummary",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("TD-219: 多笔追加合法——审计日志语义，最新一笔为当前结论", async () => {
  const dir = makeTempDir("wao-accept-multi-");
  try {
    const runId = "run_acceptmulti10";
    writeTranscript(dir, runId, terminalTranscript(runId));
    const first = await recordAcceptance({ runsDir: dir, runId, decision: "rejected", reason: "第一笔：返工", now: "2026-10-06T12:00:00.000Z" });
    const second = await recordAcceptance({ runsDir: dir, runId, decision: "accepted", reason: "第二笔：接受", now: "2026-10-06T13:00:00.000Z" });
    assert.equal(first.seq, 3);
    assert.equal(second.seq, 4);
    const records = await listAcceptance({ runsDir: dir, runId });
    assert.equal(records.length, 2, "两笔都在，不互相覆盖");
    assert.equal(records[0].decision, "rejected");
    assert.equal(records[1].decision, "accepted", "追加顺序保留，最新一笔在末尾 = 当前结论");
    assert.equal(records[1].reason, "第二笔：接受");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-219: listAcceptance 只返回本 run 的 acceptance.recorded；无记录返回空数组", async () => {
  const dir = makeTempDir("wao-accept-list-");
  try {
    const runId = "run_acceptlist11";
    // 无 acceptance 事件 → 空数组。
    writeTranscript(dir, runId, terminalTranscript(runId));
    assert.deepEqual(await listAcceptance({ runsDir: dir, runId }), [], "无记录 → 空数组");

    // 追加一笔 + 一笔外 run 信封的 acceptance.recorded（bound 过滤，不误报）。
    await recordAcceptance({ runsDir: dir, runId, decision: "accepted", reason: "本 run 验收", now: FIXED_NOW });
    writeFileSync(join(dir, `${runId}.jsonl`), ev({
      type: "acceptance.recorded",
      decision: "accepted",
      reason: "外 run 伪造尾条",
      recordedBy: "lead",
      recordedAt: FIXED_NOW,
      source: "cli",
      ts: FIXED_NOW,
      seq: 99,
      runId: "run_foreigntail99",
      agentId: "lead",
    }), { encoding: "utf8", flag: "a" });

    const records = await listAcceptance({ runsDir: dir, runId });
    assert.equal(records.length, 1, "外 run 信封事件不计入");
    assert.equal(records[0].decision, "accepted");
    assert.equal(records[0].reason, "本 run 验收");
  } finally {
    cleanupDir(dir);
  }
});
