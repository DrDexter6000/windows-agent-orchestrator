import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { raiseAlert } from "../src/alerts.js";

test("S1-3: raiseAlert 写 ALERTS.log（含 runId + level + 时间戳）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-alert-"));
  try {
    const logPath = join(dir, "ALERTS.log");
    await raiseAlert("budget", "token budget exceeded: used 500000 of 100000", {
      runId: "run_test_123",
      logPath,
      notify: async () => {}, // 不弹窗
    });
    assert.ok(existsSync(logPath), "ALERTS.log 必须被创建");
    const content = readFileSync(logPath, "utf8");
    assert.match(content, /run_test_123/, "日志必须含 runId");
    assert.match(content, /budget/, "日志必须含 level");
    assert.match(content, /\d{4}-\d{2}-\d{2}T/, "日志必须含 ISO 时间戳");
    assert.match(content, /token budget exceeded/, "日志必须含 message");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S1-3: 多次 raiseAlert 追加到同一 ALERTS.log（不覆盖）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-alert-"));
  try {
    const logPath = join(dir, "ALERTS.log");
    await raiseAlert("budget", "first alert", { runId: "r1", logPath, notify: async () => {} });
    await raiseAlert("stop_unverified", "second alert", { runId: "r2", logPath, notify: async () => {} });
    const content = readFileSync(logPath, "utf8");
    assert.match(content, /first alert/);
    assert.match(content, /second alert/);
    // 两行（每条 alert 一行）
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 2, "两次告警应追加为两行");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S1-3: notify 抛错时降级 — 不影响日志写入，不抛出（告警失败不阻塞 run 终态）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-alert-"));
  try {
    const logPath = join(dir, "ALERTS.log");
    // notify 抛错模拟 msg.exe 不可用
    await raiseAlert("stop_unverified", "backend still running after abort", {
      runId: "r3",
      logPath,
      notify: async () => { throw new Error("msg.exe not found"); },
    });
    // 关键：raiseAlert 不应抛错（告警失败不阻塞）
    assert.ok(existsSync(logPath), "即使 notify 失败，日志仍必须写入");
    const content = readFileSync(logPath, "utf8");
    assert.match(content, /r3/, "日志正常写入");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S1-3: logPath 写入失败时也不抛错（降级到 stderr，绝不阻塞 run 终态）", async () => {
  // 不传 logPath → 默认路径可能不可写，但 raiseAlert 必须不抛
  await assert.doesNotReject(async () => {
    await raiseAlert("budget", "test", {
      runId: "r4",
      logPath: "Z:/nonexistent/path/ALERTS.log", // 不可写路径
      notify: async () => {},
    });
  });
});
