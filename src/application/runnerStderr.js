// src/application/runnerStderr.js
//
// TD-341（第 89 批 A）：后台 runner 的 stderr 落每运行文件。
//
// 真实事故：一次内存泄漏让 runner 堆耗尽、V8 直接 abort——stdio 全 ignore，
// 没有任何痕迹，转录停在 running，Lead 的后台等待白等。本模块把派发侧打开的
// `.runner-<runId>.stderr`（与 `.owner-<runId>` 同目录同风格）作为唯一诊断
// 证据位：runner 以退出码 0 退出且文件为空时，由 backgroundRunner 的进程级退出
// 钩子同步删除；非空（之前的崩溃证据、本进程的报错、Node 警告）、非 0 退出、
// 被强杀、V8 abort（不走退出钩子），文件都留下。
//
// 这个文件只作诊断证据，不参与任何状态判定（settle 六道门、收口判定、liveness
// 投影都不读它）。原始 stderr 落盘不截断、不脱敏（捕获 V8 abort 只能这样）；
// 展示时才处理：exact-secret 脱敏 + 形状脱敏 + 控制字符清洗，再限长——顺序复用
// runActivityProjection.js 的同一条管道（tailOfRedactedText），不另写一份。
//
// 清理边界（第 90 批起收紧为一条例外）：只有 `runs prune` 在删/归档某个转录时
// 把该 runId 的 `.runner-*.stderr` 随转录一并删除或归档（runs-archive/<月>，
// 文件名不变；判龄与转录相同）——转录是它唯一的关联证据锚，转录没了留孤立文件
// 只会是无人认领的堆积。除此之外，任何扫描、清理器仍不许碰它：Windows 上文件
// 被持有时 unlink 也会成功，之后的写入就丢了。现有 transcript 枚举只收 `.jsonl`
//（prune 之外的清理面走同一枚举），本文件对它们不可见。
//
// Architectural contract:
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - node:fs / node:path + runActivityProjection.js（同层共享投影）。

import { openSync, closeSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import { tailOfRedactedText } from "./runActivityProjection.js";
import { createSecretRedactor } from "../secretRedaction.js";

/** 尾部读取的缺省字节数（原始字节，展示处理前；也是展示文本的字符上限——
 *  UTF-8 下字符数不超过字节数，只有脱敏标签比原值长时展示才会再截）。 */
export const RUNNER_STDERR_TAIL_DEFAULT_BYTES = 4096;

/** 文件不在/读不到时的固定说明（CLI 面）。 */
export const NO_RUNNER_STDERR_RECORD_TEXT = "无 runner stderr 记录";

/** 文件在但内容为空时的固定说明（CLI 面；与"无文件"分开说）。 */
export const EMPTY_RUNNER_STDERR_RECORD_TEXT = "runner stderr 文件为空";

/**
 * stderr 文件路径（与 .owner-<runId> 同目录同风格）。
 * @param {string} runDir
 * @param {string} runId
 * @returns {string}
 */
export function runnerStderrPath(runDir, runId) {
  return join(runDir, `.runner-${runId}.stderr`);
}

/**
 * 以 append 模式打开（不存在即创建）runner stderr 文件，返回 fd 供派发侧作为
 * spawn 的 stdio[2]。打开失败抛错——调用方（runDispatch / runContinue）退回
 * "ignore"，打开失败不能阻止派发。
 *
 * @param {string} runDir
 * @param {string} runId
 * @returns {number} fd（调用方在 spawn 之后自行关闭）
 */
export function openRunnerStderrFd(runDir, runId) {
  return openSync(runnerStderrPath(runDir, runId), "a");
}

/**
 * 读文件尾部（原始字节，展示处理前）。读不到（文件不在、stat/读失败）返回
 * null。从字节窗口解码 utf8，起始处落在多字节字符中间时以替换字符呈现——
 * 诊断尾部的可接受损耗。
 *
 * @param {string} runDir
 * @param {string} runId
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=RUNNER_STDERR_TAIL_DEFAULT_BYTES]
 * @returns {string|null}
 */
export function readRunnerStderrTail(runDir, runId, { maxBytes = RUNNER_STDERR_TAIL_DEFAULT_BYTES } = {}) {
  const path = runnerStderrPath(runDir, runId);
  try {
    const size = statSync(path).size;
    if (size === 0) return "";
    const start = Math.max(0, size - Math.max(1, Math.trunc(maxBytes)));
    return readTail(path, start, size);
  } catch {
    return null;
  }
}

// readFileSync 不支持偏移读；用底层 fd 读避免整读超大文件（V8 abort 前可能已写
// 进大量 stderr）。保持在本模块内的小工具。
function readTail(path, start, end) {
  const fd = openSync(path, "r");
  try {
    const length = end - start;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * 展示形态的尾部。处理顺序（二轮续修 2/3）：
 *   1. CRLF 规整为 LF（Windows 上 V8 写的是 CRLF；sanitizeControls 会把孤立的
 *      CR 换成替换符，每行末尾多一个 U+FFFD）；
 *   2. 读取窗口从文件中间起（窗口前还有内容）时，丢掉窗口里第一行不完整的
 *      部分——密钥跨在窗口起点时只剩后半截，exact 脱敏认不出来，会原样进展示。
 *      从第一个 \n 之后开始展示；窗口里没有 \n 时整窗丢弃（空尾部）；
 *   3. exact-secret 脱敏 + 形状脱敏 + 控制字符清洗 + 限长（runActivityProjection.js
 *      的同一条管道）。
 * truncated = 窗口前还有内容 **或** 清洗后超长。文件不在/读不到返回 null（调用方
 * 按"无记录"呈现，不伪造空证据）。
 *
 * @param {string} runDir
 * @param {string} runId
 * @param {object} [opts]
 * @param {number} [opts.maxBytes] — 读取窗口（也是展示字符上限）
 * @returns {{ tail: string, truncated: boolean }|null}
 */
export function readRunnerStderrTailDisplay(runDir, runId, { maxBytes = RUNNER_STDERR_TAIL_DEFAULT_BYTES } = {}) {
  const path = runnerStderrPath(runDir, runId);
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return null; // 文件不在/读不到
  }
  const raw = readRunnerStderrTail(runDir, runId, { maxBytes });
  if (raw === null) return null;
  if (raw.length === 0) return { tail: "", truncated: false };
  const windowTruncated = size > maxBytes;
  let normalized = raw.replace(/\r\n/g, "\n");
  if (windowTruncated) {
    // 丢掉被窗口起点切开的第一个不完整行。
    const firstNewline = normalized.indexOf("\n");
    if (firstNewline === -1) return { tail: "", truncated: true };
    normalized = normalized.slice(firstNewline + 1);
    if (normalized.length === 0) return { tail: "", truncated: true };
  }
  const safe = tailOfRedactedText(normalized, createSecretRedactor(), maxBytes);
  return { tail: safe.tail, truncated: windowTruncated || safe.truncated };
}

/**
 * CLI 面的尾部呈现（一处格式化，observe.js 的 `wao status` 与 runs.js 的
 * `runs wait --until-settled` runner_gone 出口共用）：无文件 →"无 runner
 * stderr 记录"；空文件 →"runner stderr 文件为空"；有内容 → 展示处理后的尾部
 *（被截时前缀省略号）。窗口里没有完整行可展示时返回裸 "…"（文件不空、只是
 * 被窗口起点整窗丢弃——不说"文件为空"）。固定文案，不含自由文本拼接。
 *
 * @param {string} runDir
 * @param {string} runId
 * @returns {string}
 */
export function runnerStderrTailText(runDir, runId) {
  const display = readRunnerStderrTailDisplay(runDir, runId);
  if (display === null) return NO_RUNNER_STDERR_RECORD_TEXT;
  if (display.tail.length === 0 && !display.truncated) return EMPTY_RUNNER_STDERR_RECORD_TEXT;
  return display.truncated ? `…${display.tail}` : display.tail;
}
