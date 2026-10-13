// src/commands/observe.js
//
// Observe 命令族：status（只读查询）/ tail（只读追 transcript）/ collect（收集消息，
// 每次成功追加一个 messages.collected 审计事件，非只读）。不含 stop（杀进程，单独拆）。
//
// status 和 collect 已委托共享 application service（runStatus.js / runCollect.js）；
// 本模块只保留 argv 解析、text/JSON 输出适配，以及 tailCommand 的文件轮询逻辑。
//
// M11-4: collect 新增 continuation 入口（--cursor / --format json），委托与 MCP 相同
// 的安全投影（runCollectProjection.js）。默认 `collect <runId>` 保持原 raw ops 输出
// 不变（byte-compatible），新入口是 opt-in。
//
// 依赖：
//   - 外部模块：../transcript.js（readTranscript——R13-C 清理了本文件不再
//     使用的 findLatest 死 import）、
//     ../backends/opencodeServe.js（tail 不直接用，保留供未来；collect serve 路径走 service）
//   - 共享工具：./shared.js（parseOptions/loadRun）
//   - 共享 service：../application/runStatus.js（status）、../application/runCollect.js（collect）
//   - 共享投影：../application/runCollectProjection.js（M11-4 collect continuation）
//   - node built-in：fs/promises（readFile）、fs（watchFile/unwatchFile）、path（resolve）

import { readFile, writeFile } from "node:fs/promises";
import { watchFile, unwatchFile } from "node:fs";
import { resolve } from "node:path";

import { readTranscript } from "../transcript.js";
import { OpenCodeServeBackend } from "../backends/opencodeServe.js";
import { parseOptions, loadRun } from "./shared.js";
// M9-3A: status aggregation delegated to shared application service.
import { getRunStatus } from "../application/runStatus.js";
// M9-4A: collection delegated to shared application service.
import { collectRunMessages } from "../application/runCollect.js";
// F5 (2026-10-08): 投影层解码/校验路径抛出的类型化 cursor 拒绝信号——CLI 折叠
// 用（run_activity M12-19 定义的同一类）。
import { CursorRejectedError } from "../application/runActivityProjection.js";
// M11-4: shared safe projection — same module MCP uses, so CLI continuation
// output is deep-equal to MCP structuredContent.
import { projectCollectResult } from "../application/runCollectProjection.js";

// M9-3A: describeActivity/summarizeToolInput/truncate were the local copy of the
// status activity algorithm. They have been migrated to the shared application
// service (src/application/runStatus.js) so CLI and MCP use one algorithm.
// statusCommand now delegates to getRunStatus; the local copies are removed to
// prevent drift (no second algorithm).

// 2026-10-12 消费者侧反馈：`last` 原样回显末事件——末事件是一次文件读取的
// tool_result 时，整份文件正文刷满终端，真正要看的 state/lastActivity 被淹没。
// 显示层把超长字符串叶子截到有界长度并标出省略量：键与结构不变、仍是合法 JSON；
// 全文仍在转录里（tail / collect）。
const LAST_STRING_LIMIT = 300;

function boundLongStrings(value) {
  if (typeof value === "string") {
    return value.length > LAST_STRING_LIMIT
      ? `${value.slice(0, LAST_STRING_LIMIT)}… [+${value.length - LAST_STRING_LIMIT} chars; full text: tail/collect]`
      : value;
  }
  if (Array.isArray(value)) return value.map(boundLongStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, boundLongStrings(v)]));
  }
  return value;
}

export async function statusCommand(args, config) {
  const [runId, ...tail] = args;
  const options = parseOptions(tail);
  const runDir = resolve(options.runDir ?? config.runDir);
  // M9-3A: aggregation delegated to shared application service. The CLI prints
  // the existing TD-75 field subset (byte-compatible output); the service also
  // returns machine fields for MCP that the CLI does not print.
  const status = await getRunStatus({ runId, runDir });
  // TD-150 批B + 审计修正：scorecard.checked 成为末事件时，裸 `last` 会把
  // evidence/detail 自由文本一并回显（非泄漏形状被旧字段绕过）。CLI 显示层把该
  // 形态投影为闭集安全视图；其余末事件原样保留。
  const lastDisplay = status.last && status.last.type === "scorecard.checked"
    ? {
        type: "scorecard.checked",
        passed: status.scorecardSummary ? status.scorecardSummary.passed === true : null,
      }
    : status.last;
  const sc = status.scorecardSummary;
  const scorecard = sc
    ? {
        verdict: sc.passed ? "passed"
          : status.state === "completed" ? "warn"
          : "failed",
        failedChecks: Array.isArray(sc.failedChecks) ? sc.failedChecks : [],
      }
    : undefined;
  console.log(JSON.stringify({
    runId: status.runId,
    agentId: status.agentId,
    state: status.state,
    // M12-17: submitted-stage execution semantics — printed via the service's
    // additive executionStage projection (never re-derived in the CLI).
    executionStage: status.executionStage,
    last: boundLongStrings(lastDisplay),
    lastActivityTs: status.lastActivityTs,
    secondsSinceActivity: status.secondsSinceActivity,
    // 决定 0069：这次读取看到的转录位置——stop 的 --observed-seq 取它。
    observedSeq: status.observedSeq,
    lastActivityKind: status.lastActivityKind,
    lastActivitySummary: status.lastActivitySummary,
    // TD-150 批B + 审计修正：摘要折叠进 JSON 对象（纯 JSON 可解析契约不破），
    // 不再在 JSON 块后追加行。无 scorecard.checked 的 run 字段 absent。
    ...(scorecard ? { scorecard } : {}),
    // 决定 0067：很久没有新动作/正文的未终态 run 附一句 advisory（去留由 Lead 定）。
    ...(status.leadAdvisory ? { advisory: status.leadAdvisory } : {}),
  }, null, 2));
}

export async function tailCommand(args, config) {
  const [runId, ...tail] = args;
  const options = parseOptions(tail);
  const { transcript } = await loadRun(runId, options, config);
  const filePath = transcript.filePath;
  const limit = Number(options.limit ?? 20);
  if (options.follow) {
    let lastSize = 0;
    let lastLineCount = 0;
    const events = await readTranscript(filePath);
    for (const event of events.slice(-limit)) {
      console.log(JSON.stringify(event));
    }
    lastLineCount = events.length;
    lastSize = (await readFile(filePath, "utf8")).length;
    console.log(`--- following ${filePath} (Ctrl+C to stop) ---`);
    await new Promise((resolve) => {
      const watcher = () => {
        readFile(filePath, "utf8").then((content) => {
          if (content.length < lastSize) return;
          const allLines = content.split(/\r?\n/).filter(Boolean);
          if (allLines.length > lastLineCount) {
            for (let i = lastLineCount; i < allLines.length; i += 1) {
              try {
                console.log(JSON.stringify(JSON.parse(allLines[i])));
              } catch {
                console.log(allLines[i]);
              }
            }
            lastLineCount = allLines.length;
          }
          lastSize = content.length;
        });
      };
      watchFile(filePath, { interval: 1000 }, watcher);
      process.on("SIGINT", () => {
        unwatchFile(filePath);
        resolve();
      });
    });
  } else {
    const { events } = await loadRun(runId, options, config);
    for (const event of events.slice(-limit)) {
      console.log(JSON.stringify(event));
    }
  }
}

// M9-4A: reconstructProcessEvent migrated to the shared application service
// (src/application/runCollect.js) so CLI and MCP use one algorithm.

// M11-4: strict flag set for collect projection mode. The default raw-ops
// mode keeps its existing loose parsing (it is the documented human/ops
// surface). Projection mode (engaged by --cursor or --format json) is a
// machine-readable contract and must reject unknown flags so a Lead script
// does not silently get wrong output from a typo'd flag.
//
// M11-4 CTO rework (Fix E): --limit is NOT in this set. The projection owns
// pagination; a user-supplied limit would silently conflict. Legacy raw CLI
// mode still honors --limit.
// TD-112 (D2 A4): "final" is a BOOLEAN flag (never takes a value — it must NOT
// enter the knownValueFlags walk below, or it would swallow the next token).
const COLLECT_PROJECTION_KNOWN_FLAGS = new Set([
  "cursor", "format", "mode", "runDir", "cwd", "final", "out",
]);

// base64url, no padding, ≤192 chars — same alphabet as the MCP cursor field.
const COLLECT_CURSOR_RE = /^[A-Za-z0-9_-]+$/;
const COLLECT_CURSOR_MAX = 192;

// F5 (2026-10-08): 坏 cursor 专属 CLI 文案——与 MCP 面 run_collect 的专属拒绝文案
// 同义（静态恢复指引：第 1 页重取、勿手工修改；不透子类型：过期/跨 run/被改
// 不区分）。既用于本地语法拒绝（长度/字母表），也用于共享投影抛出的
// CursorRejectedError 折叠。
const COLLECT_CURSOR_REJECTED_TEXT =
  "collect cursor rejected: the cursor is invalid or expired — re-run from page 1 " +
  "(omit --cursor); a cursor token is opaque and must never be hand-modified";

// TD-112 (D2 A4): fixed markers for collect --final's bounded states. Static
// text only — never interpolates run/worker content.
// D1-D3 收口（Bug#3 尾巴）: the too_large marker must name the runnable
// escape hatch — WITHOUT --final. The old "use collect --format json" advice
// was a dead end for a user who copied it verbatim: with --final still on
// the command line, the four-state rendering takes over and JSON is never printed.
// TD-119 (2026-08-15, panel rework): the marker names the chunk semantics AND
// the message-boundary rule — naive whole-page concatenation would glue two
// distinct messages together (an entry with truncated:false ends a message).
const COLLECT_FINAL_EMPTY_MARKER = "[final: no assistant message]";
const COLLECT_FINAL_TOO_LARGE_MARKER =
  "final message exceeds bounded projection; write it to a file: collect <runId> --final --out FILE - or re-run without --final: collect <runId> --format json (slices of one message concatenate - an entry with truncated:false ends a message; follow nextCursor across pages)";

const COLLECT_OUT_MAX_CHARS = 1_000_000;
const COLLECT_OUT_CHANGED_TEXT =
  "collect --final --out: the transcript changed while it was being read (the run is still producing " +
  "output) — nothing was written; run it again once the run is terminal";
const COLLECT_OUT_LIMIT_TEXT =
  "collect --final --out: a message in this transcript is longer than 1,000,000 characters, " +
  "the most this command reads — nothing was written";

/**
 * 逐页读完全量投影，拼出最后一条 assistant 消息的完整文本。同一条消息的切片
 * 首尾相接，`truncated: false` 的切片是这条消息的末尾。只读：这些翻页不追加审计
 * 事件。单条消息最多读 COLLECT_OUT_MAX_CHARS 个字符（分页游标能寻址的范围略大于
 * 此数，这里取整并明确执行）：读到的内容一超过就报固定文案、不写文件。读取途中
 * 游标被拒，说明转录在读的过程中变了，报另一句固定文案。
 */
async function readFinalMessageByPages({ runId, runDir }) {
  let cursor;
  let current = "";
  let currentRole = null;
  let last = "";
  for (let page = 0; page < 2000; page += 1) {
    const raw = await collectRunMessages({ runId, runDir, cursor, deferAppend: true });
    let payload;
    try {
      payload = projectCollectResult(raw, { runId, cursor, mode: "full" });
    } catch (error) {
      if (error instanceof CursorRejectedError) throw new Error(COLLECT_OUT_CHANGED_TEXT);
      throw error;
    }
    for (const entry of payload.messages ?? []) {
      if (entry.role !== currentRole) { current = ""; currentRole = entry.role; }
      current += entry.text ?? "";
      if (current.length > COLLECT_OUT_MAX_CHARS) throw new Error(COLLECT_OUT_LIMIT_TEXT);
      if (entry.truncated !== true) {
        if (entry.role === "assistant") last = current;
        current = "";
        currentRole = null;
      }
    }
    cursor = payload.nextCursor ?? undefined;
    if (!cursor) return last;
  }
  throw new Error(COLLECT_OUT_LIMIT_TEXT);
}

export async function collectCommand(args, config) {
  const [runId, ...tail] = args;
  const options = parseOptions(tail);
  const runDir = resolve(options.runDir ?? config.runDir);

  // M11-4 CTO rework (Fix E): --cursor with NO value (parseOptions sets it
  // to boolean true) must be rejected BEFORE any read/append. The OLD code
  // treated cursor===true as "no cursor" and silently fell through to raw
  // collect (RED-4). Now: any presence of --cursor without a real string
  // value is a hard error, regardless of mode.
  if (options.cursor === true) {
    throw new Error("collect: --cursor requires a value");
  }
  if (options.format === true) {
    throw new Error("collect: --format requires a value");
  }
  // M12-2A: --mode with NO value (parseOptions sets it to boolean true) is
  // rejected BEFORE any read/append, regardless of mode.
  if (options.mode === true) {
    throw new Error("collect: --mode requires a value");
  }

  // M11-4: projection mode is engaged by --cursor OR --format json. This is
  // the machine-readable continuation entry that delegates to the SAME safe
  // projection as MCP. The default `collect <runId>` (no cursor, no format)
  // keeps its existing raw-ops output byte-compatible.
  // M12-2A: --mode (full|compact) also engages projection; compact delegates
  // to the same shared projection as MCP.
  // TD-112 (D2 A4): --final (boolean) also engages projection mode and reuses
  // the compact branch — it renders its own four-state text output below.
  const hasCursor = typeof options.cursor === "string" && options.cursor.length > 0;
  const hasMode = options.mode !== undefined;
  const hasFinal = options.final !== undefined;
  const hasOut = options.out !== undefined;
  if (hasOut && (typeof options.out !== "string" || options.out.length === 0)) {
    throw new Error("collect: --out requires a file path");
  }
  if (hasOut && !hasFinal) {
    throw new Error("collect: --out goes with --final (write the complete final message to a file)");
  }
  const isProjectionMode = hasCursor || options.format === "json" || hasMode || hasFinal;

  if (!isProjectionMode) {
    // Default raw-ops surface (unchanged since M9-4A). Prints the raw service
    // result: process {data, reconstructed, backend}; serve messages response.
    // M11-4 CTO rework (Fix E): --limit is honored here (legacy raw CLI
    // contract). In projection mode --limit is rejected below (the projection
    // owns pagination; a user-supplied limit would silently conflict).
    // 2026-10-02 Lead 体验批（会审定稿）：取回失败 ≠ 运行失败——错误原样抛出、
    // 追加诊断指路（不写 "failure cause"：成功 run 的会话被回收时 collect 失败
    // 但 diagnose 无运行失败可报，措辞只指向"已记录的运行状态与失败证据"）。
    try {
      const result = await collectRunMessages({
        runId,
        runDir,
        limit: Number(options.limit ?? 50),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      throw new Error(`${error.message}\n  — 查看已记录的运行状态与失败证据：npm run cli -s -- runs diagnose ${runId} --format json`);
    }
    return;
  }

  // ===== Projection mode (M11-4) =====
  //
  // Strict parse: exactly one positional (runId), no duplicate flags, cursor
  // must be base64url, format must be json (only supported value). Unknown
  // flags are rejected so a typo does not silently produce wrong output.

  // Re-walk tail with a flag-aware cursor so that a flag's value (which may
  // not start with --, e.g. --run-dir /abs/path) is not mis-counted as a
  // positional. Only bare positionals (not preceded by a value-expecting
  // flag) count.
  let extraPositionals = 0;
  const knownValueFlags = new Set(["--cursor", "--format", "--limit", "--mode", "--run-dir", "--cwd", "--out"]);
  for (let i = 0; i < tail.length; i += 1) {
    const a = tail[i];
    if (a.startsWith("--")) {
      // Known value flag consumes the next token as its value.
      if (knownValueFlags.has(a) && i + 1 < tail.length) {
        i += 1; // skip the value
      }
      continue;
    }
    // Not a flag → positional. There should be zero of these in tail (runId
    // was already consumed as args[0]).
    extraPositionals += 1;
  }
  if (extraPositionals > 0) {
    throw new Error("collect projection mode: exactly one positional (runId) required");
  }

  // Reject duplicate flags. parseOptions silently overwrites; detect by
  // counting occurrences in the raw tail.
  const flagCounts = {};
  for (const a of tail) {
    if (a.startsWith("--")) {
      const key = a.slice(2);
      flagCounts[key] = (flagCounts[key] ?? 0) + 1;
    }
  }
  for (const [k, c] of Object.entries(flagCounts)) {
    if (c > 1) throw new Error(`collect projection mode: duplicate flag --${k}`);
  }

  // Reject unknown flags.
  for (const k of Object.keys(options)) {
    if (!COLLECT_PROJECTION_KNOWN_FLAGS.has(k)) {
      throw new Error(`collect projection mode: unknown flag --${k}`);
    }
  }

  // Validate cursor if present. F5: 本地语法拒绝与投影层语义拒绝共用同一条
  // 专属恢复文案（修法相同：从第 1 页重取）。
  let cursor = null;
  if (hasCursor) {
    cursor = String(options.cursor);
    if (cursor.length === 0 || cursor.length > COLLECT_CURSOR_MAX) {
      throw new Error(COLLECT_CURSOR_REJECTED_TEXT);
    }
    if (!COLLECT_CURSOR_RE.test(cursor)) {
      throw new Error(COLLECT_CURSOR_REJECTED_TEXT);
    }
  }

  // format=json is the only supported value in projection mode.
  if (options.format !== undefined && options.format !== "json") {
    throw new Error("collect projection mode: --format only supports json");
  }

  // M12-2A: --mode is a closed set {full|compact}. compact does NOT accept a
  // cursor (cursor is full-only); rejected here BEFORE any read/append.
  if (options.mode !== undefined && options.mode !== "full" && options.mode !== "compact") {
    throw new Error("collect projection mode: --mode only supports full|compact");
  }
  if (options.mode === "compact" && hasCursor) {
    throw new Error("collect projection mode: --mode compact does not accept --cursor");
  }
  // TD-112 (D2 A4): --final reuses the compact projection (its own bounded
  // view), so it follows the SAME mutual-exclusion discipline as compact.
  if (hasFinal && hasCursor) {
    throw new Error("collect projection mode: --final does not accept --cursor");
  }

  // M11-4 CTO rework (Fix E): --limit is REJECTED in projection mode. The
  // projection layer owns pagination (8/4000/12000 caps); a user-supplied
  // limit would silently conflict with the safe continuation contract.
  // Legacy raw CLI mode still honors --limit (byte-compatible).
  if (options.limit !== undefined) {
    throw new Error("collect projection mode: --limit is not allowed (pagination is fixed)");
  }

  // Delegate to the shared projection — same module MCP uses.
  // M11-4 CTO rework (Fix D): projection mode ALWAYS defers the audit append
  // until projection + output validation succeed. This covers page 1 too
  // (cursor-less), so any projection/schema failure produces ZERO appends.
  // M12-2A: thread --mode into the shared projection (compact branch).
  // TD-112 (D2 A4): --final implies the compact projection (same redaction +
  // C0/C1/DEL sanitization + ≤4000-char bound, no pagination) and renders its
  // own four-state text output instead of the projection JSON. It is NOT
  // exempt from the audit append — collect is non-read-only, --final keeps
  // exactly one messages.collected per successful call.
  const mode = hasFinal || options.mode === "compact" ? "compact" : "full";
  // 会审补全（auditor 验证）：JSON/projection 模式的取回失败同样指路——指路恒带
  // 实际 runDir（复制即用）；仅包裹服务调用本身，参数/游标解析错误不机械追加。
  let raw;
  try {
    raw = await collectRunMessages({ runId, runDir, cursor, deferAppend: true });
  } catch (error) {
    throw new Error(`${error.message}
  — 查看已记录的运行状态与失败证据：npm run cli -s -- runs diagnose ${runId} --run-dir ${runDir} --format json`);
  }
  // F5: 投影抛出的 CursorRejectedError（过期/跨 run/被改——不透子类型）折叠为
  // 专属恢复文案；其余投影错误原样上抛。折叠发生在 commitAppend 之前——被拒
  // cursor 零审计追加（messages.collected 不写入）。
  let payload;
  try {
    payload = projectCollectResult(raw, { runId, cursor, mode });
  } catch (error) {
    if (error instanceof CursorRejectedError) {
      throw new Error(COLLECT_CURSOR_REJECTED_TEXT);
    }
    throw error;
  }
  // --out：先把要写的全文取齐、写进文件，再追加审计事件——逐页读取或写文件失败时
  // 与其它投影失败一样零追加。文本经同一套投影逐页取回，脱敏与控制字符清理与分页
  // 读取完全相同（写进文件的是清理后的文本，不是转录里的原始字节）。
  let outReport = null;
  if (hasOut) {
    const text = payload.compactStatus === "available"
      ? payload.messages[0].text
      : payload.compactStatus === "empty" ? "" : await readFinalMessageByPages({ runId, runDir });
    const target = resolve(options.out);
    await writeFile(target, text, "utf8");
    outReport = payload.compactStatus === "empty"
      ? `${COLLECT_FINAL_EMPTY_MARKER} (empty file written to ${target})`
      : `final message: ${text.length} chars written to ${target}`;
  }
  // Projection succeeded → safe to commit the audit.
  if (typeof raw.commitAppend === "function") {
    await raw.commitAppend();
  }
  if (hasFinal) {
    // TD-153(b): --final × --format json is an ACCEPTED combination (json is
    // the only legal format value) but --final renders its own four-state
    // TEXT — the projection JSON envelope is intentionally never printed.
    // That used to be a silent contract break for scripts; the combination
    // now warns ONCE on stderr (stdout stays byte-identical) and points at
    // the paged projection as the machine-readable path: drop --final,
    // follow nextCursor across pages.
    if (options.format === "json" && !hasOut) {
      console.error(
        "[collect] warning: --final does not emit the --format json envelope — stdout stays the four-state text; "
        + "for machine-readable output drop --final and page through collect <runId> --format json (follow nextCursor across pages)",
      );
    }
    if (outReport !== null) {
      console.log(outReport);
      return;
    }
    if (payload.compactStatus === "available") {
      console.log(payload.messages[0].text);
    } else if (payload.compactStatus === "empty") {
      console.log(COLLECT_FINAL_EMPTY_MARKER);
    } else {
      console.log(COLLECT_FINAL_TOO_LARGE_MARKER);
    }
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}
