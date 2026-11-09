// test/application/runnerStderr.test.js
//
// TD-341（第 89 批 A）：runner stderr 证据文件模块单测。
//   - 路径形状（与 .owner-<runId> 同目录同风格）；
//   - openRunnerStderrFd append 模式（不存在即创建，已存在不截断）；
//   - readRunnerStderrTail 尾部读取（缺省 4096 字节窗；文件不在 → null）；
//   - readRunnerStderrTailDisplay 展示处理：exact-secret 脱敏 + 形状脱敏 +
//     控制字符清洗（LF/TAB 保留）+ 限长——顺序复用 runActivityProjection 的同一条
//     管道（造一个含形状秘密与控制字符的文件）。
// spawn 传 fd / 父进程关闭 / 打开失败退回 ignore 的派发侧行为在
// test/run-lifecycle/runDispatch.test.js 与 m12-7-runContinue.test.js。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runnerStderrPath,
  openRunnerStderrFd,
  readRunnerStderrTail,
  readRunnerStderrTailDisplay,
  runnerStderrTailText,
  RUNNER_STDERR_TAIL_DEFAULT_BYTES,
  NO_RUNNER_STDERR_RECORD_TEXT,
  EMPTY_RUNNER_STDERR_RECORD_TEXT,
} from "../../src/application/runnerStderr.js";

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

test("TD-341-A: 路径与 .owner-<runId> 同目录同风格；append 打开创建文件且不截断已有内容", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td341a-open-"));
  try {
    const runId = "run_td341_open";
    const p = runnerStderrPath(dir, runId);
    assert.equal(p, join(dir, `.runner-${runId}.stderr`));
    assert.ok(!existsSync(p));
    const fd = openRunnerStderrFd(dir, runId);
    assert.equal(typeof fd, "number");
    closeSync(fd);
    assert.ok(existsSync(p), "append 打开不存在即创建（空文件）");
    writeFileSync(p, "first line\n", "utf8");
    const fd2 = openRunnerStderrFd(dir, runId);
    closeSync(fd2);
    const tail = readRunnerStderrTail(dir, runId);
    assert.equal(tail, "first line\n", "再次 append 打开不截断已有内容");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-341-A: 尾部读取按字节窗（缺省 4096）；文件不在 → null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td341a-tail-"));
  try {
    const runId = "run_td341_tail";
    assert.equal(readRunnerStderrTail(dir, runId), null, "文件不在 → null");
    // 写一个 8KB 文件：尾部窗只回最后 4096 字节（ASCII 无多字节拆分问题）。
    const big = "y".repeat(20) + "x".repeat(RUNNER_STDERR_TAIL_DEFAULT_BYTES - 9) + "TAIL-MARK";
    writeFileSync(runnerStderrPath(dir, runId), big, "utf8");
    const tail = readRunnerStderrTail(dir, runId);
    assert.ok(tail.endsWith("TAIL-MARK"), "尾部包含文件末尾标记");
    assert.equal(tail.length, RUNNER_STDERR_TAIL_DEFAULT_BYTES, "恰为缺省字节窗大小");
    assert.ok(!tail.includes("y"), "文件开头 20 字节落在窗外（窗口确为尾部）");
    // 自定义窗。
    const small = readRunnerStderrTail(dir, runId, { maxBytes: 9 });
    assert.equal(small, "TAIL-MARK");
    // 空文件 → ""（文件在、内容为空是事实，不是 null）。
    const empty = "run_td341_empty";
    writeFileSync(runnerStderrPath(dir, empty), "", "utf8");
    assert.equal(readRunnerStderrTail(dir, empty), "");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-341-A: 展示处理——CRLF 规整为 LF、exact/形状脱敏、控制字符清洗、读取窗口截断", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td341a-disp-"));
  try {
    const CRLF = String.fromCharCode(13) + "\n";
    const runId = "run_td341_disp";
    // Windows 上 V8 写的是 CRLF；冒烟里堆耗尽的输出约 2.7KB：FATAL 行在前、
    // 30 多行本地调用栈在后，整体落在 4096 字节读取窗口内。
    const stack = Array.from({ length: 34 }, (_, i) => `  at fn${i} (C:/path/file${i}.js:${i + 1}:${i + 2})`).join(CRLF);
    const raw = "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory" + CRLF
      + stack + CRLF;
    writeFileSync(runnerStderrPath(dir, runId), raw, "utf8");
    const display = readRunnerStderrTailDisplay(dir, runId);
    assert.ok(display, "文件在 → 有展示结果");
    const text = display.tail;
    assert.ok(text.includes("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"),
      "FATAL 行在展示文本里（读取窗口内不被截掉）");
    assert.ok(!text.includes(String.fromCharCode(0xFFFD)), "CRLF 已规整为 LF——行尾不再出现替换符");
    assert.ok(text.includes("at fn0 ("), "调用栈保留");
    assert.ok(text.includes("\n"), "LF 保留");
    // 形状脱敏 + 控制字符清洗（同一条管道）。
    const secret = "run_td341_secret";
    writeFileSync(runnerStderrPath(dir, secret),
      "Authorization: Bearer abcdef1234567890abcdef1234567890" + CRLF + "beep\b\x00" + CRLF, "utf8");
    const st = readRunnerStderrTailDisplay(dir, secret).tail;
    assert.ok(!st.includes("abcdef1234567890"), "Bearer 令牌值被脱敏");
    assert.ok(st.includes("Bearer [REDACTED]"), "形状脱敏标签保留");
    assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(st), "C0 控制字符（除 LF/TAB）被清洗");
    // 二轮续修 2/3：文件超过读取窗口 → truncated:true；窗口起点切开的首行不完整
    // 部分整行丢弃（展示从第一个完整行开始）。
    const long = "run_td341_long";
    const line = "B".repeat(64) + "\n";
    writeFileSync(runnerStderrPath(dir, long), line.repeat(Math.ceil((RUNNER_STDERR_TAIL_DEFAULT_BYTES + 500) / line.length)), "utf8");
    const longDisplay = readRunnerStderrTailDisplay(dir, long);
    assert.equal(longDisplay.truncated, true, "窗口前还有内容 → truncated:true");
    assert.ok(longDisplay.tail.length > 0, "窗口里有完整行 → 有尾部");
    // 展示从完整行边界开始（首行残段被丢）；管道的 trimEnd 去掉末尾换行。
    assert.equal((longDisplay.tail.length + 1) % line.length, 0, "尾部由整行组成（减去被 trimEnd 的末位换行）");
    assert.ok(/^B+(\nB+)*$/.test(longDisplay.tail), "尾部只含完整行");
    assert.ok(runnerStderrTailText(dir, long).startsWith("…"), "runnerStderrTailText 截断时以省略号开头");
    // 文件不在 → null（调用方按"无记录"呈现）。
    assert.equal(readRunnerStderrTailDisplay(dir, "run_td341_missing"), null);
    assert.equal(NO_RUNNER_STDERR_RECORD_TEXT, "无 runner stderr 记录", "无记录固定文案");
  } finally {
    cleanupDir(dir);
  }
});


test("TD-341-续修3: runnerStderrTailText——无文件/空文件/有内容三种固定呈现", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td341a-text-"));
  try {
    assert.equal(runnerStderrTailText(dir, "run_never"), NO_RUNNER_STDERR_RECORD_TEXT, "无文件 → 无记录");
    const empty = "run_empty";
    writeFileSync(runnerStderrPath(dir, empty), "", "utf8");
    assert.equal(runnerStderrTailText(dir, empty), EMPTY_RUNNER_STDERR_RECORD_TEXT, "空文件 → 文件为空");
    const has = "run_has";
    writeFileSync(runnerStderrPath(dir, has), "boom" + String.fromCharCode(13) + "\n", "utf8");
    assert.equal(runnerStderrTailText(dir, has), "boom", "有内容 → 展示处理后的尾部（CRLF 规整）");
  } finally {
    cleanupDir(dir);
  }
});


// ── 二轮续修 3：窗口起点切开秘密时，残段所在的不完整行整行丢弃 ───────────────
// createSecretRedactor() 缺省读 process.env——测试里自己设测试变量，结束即删。

test("TD-341-二轮3: env 秘密值完整落在窗口内 → exact 脱敏；跨窗口起点 → 残段整行丢弃", async () => {
  const ENV_NAME = "WAO_TEST_SECRET_TOKEN";
  // 假值不含真实 token 形状（脱敏守卫扫 git 跟踪文件）；exact 脱敏对任意值生效。
  const SECRET = "TD341-test-secret-value-abcdef";
  process.env[ENV_NAME] = SECRET;
  try {
    const dir = mkdtempSync(join(tmpdir(), "wao-td341r3-sec-"));
    try {
      // A：值完整落在窗口内（文件小于窗口）→ [REDACTED:<名字>]。
      const full = "run_r3_full";
      writeFileSync(runnerStderrPath(dir, full), `prefix\n${SECRET}\nsuffix\n`, "utf8");
      const a = readRunnerStderrTailDisplay(dir, full);
      assert.ok(a.tail.includes(`[REDACTED:${ENV_NAME}]`), "exact 脱敏成 [REDACTED:<名字>]");
      assert.ok(!a.tail.includes(SECRET), "秘密值不残留");

      // B：值跨在窗口起点 → 窗口首行（秘密后半截所在的不完整行）整行丢弃。
      // 文件 = "0123456789"(10) + SECRET(28) + "\nTAIL\n"(6) = 44 字节；窗口 20 字节
      // → 起点 byte 24 落在 SECRET 内，首行残段 = 秘密切断的后半截 → 丢弃后只剩 TAIL。
      const straddle = "run_r3_straddle";
      writeFileSync(runnerStderrPath(dir, straddle), `0123456789${SECRET}\nTAIL\n`, "utf8");
      const b = readRunnerStderrTailDisplay(dir, straddle, { maxBytes: 20 });
      assert.equal(b.truncated, true, "窗口前还有内容");
      assert.equal(b.tail, "TAIL", "残段所在的不完整行整行丢弃，只留完整行（末位换行被管道 trimEnd）");
      // 秘密的任何后缀片段都不出现（残段随首行一起丢）。
      for (const frag of [SECRET.slice(-4), SECRET.slice(-10), SECRET.slice(14)]) {
        assert.ok(!b.tail.includes(frag), `秘密片段不出现: 长度 ${frag.length}`);
      }
    } finally {
      cleanupDir(dir);
    }
  } finally {
    delete process.env[ENV_NAME];
  }
});

test("TD-341-二轮3: 窗口里没有完整行（无换行）→ 空尾部 + truncated:true；文本面出裸省略号", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td341r3-nolf-"));
  try {
    const runId = "run_r3_nolf";
    writeFileSync(runnerStderrPath(dir, runId), "A".repeat(5000), "utf8");
    const display = readRunnerStderrTailDisplay(dir, runId);
    assert.deepEqual(display, { tail: "", truncated: true }, "整窗丢弃（无完整行可展示）");
    assert.equal(runnerStderrTailText(dir, runId), "…", "不说\"文件为空\"——文件不空，只是无可展示的完整行");
  } finally {
    cleanupDir(dir);
  }
});
