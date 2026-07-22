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
//   - 外部模块：../transcript.js（findLatest/readTranscript）、
//     ../backends/opencodeServe.js（tail 不直接用，保留供未来；collect serve 路径走 service）
//   - 共享工具：./shared.js（parseOptions/loadRun）
//   - 共享 service：../application/runStatus.js（status）、../application/runCollect.js（collect）
//   - 共享投影：../application/runCollectProjection.js（M11-4 collect continuation）
//   - node built-in：fs/promises（readFile）、fs（watchFile/unwatchFile）、path（resolve）

import { readFile } from "node:fs/promises";
import { watchFile, unwatchFile } from "node:fs";
import { resolve } from "node:path";

import { findLatest, readTranscript } from "../transcript.js";
import { OpenCodeServeBackend } from "../backends/opencodeServe.js";
import { parseOptions, loadRun } from "./shared.js";
// M9-3A: status aggregation delegated to shared application service.
import { getRunStatus } from "../application/runStatus.js";
// M9-4A: collection delegated to shared application service.
import { collectRunMessages } from "../application/runCollect.js";
// M11-4: shared safe projection — same module MCP uses, so CLI continuation
// output is deep-equal to MCP structuredContent.
import { projectCollectResult } from "../application/runCollectProjection.js";

// M9-3A: describeActivity/summarizeToolInput/truncate were the local copy of the
// status activity algorithm. They have been migrated to the shared application
// service (src/application/runStatus.js) so CLI and MCP use one algorithm.
// statusCommand now delegates to getRunStatus; the local copies are removed to
// prevent drift (no second algorithm).

export async function statusCommand(args, config) {
  const [runId, ...tail] = args;
  const options = parseOptions(tail);
  const runDir = resolve(options.runDir ?? config.runDir);
  // M9-3A: aggregation delegated to shared application service. The CLI prints
  // the existing TD-75 field subset (byte-compatible output); the service also
  // returns machine fields for MCP that the CLI does not print.
  const status = await getRunStatus({ runId, runDir });
  console.log(JSON.stringify({
    runId: status.runId,
    state: status.state,
    last: status.last,
    lastActivityTs: status.lastActivityTs,
    secondsSinceActivity: status.secondsSinceActivity,
    lastActivityKind: status.lastActivityKind,
    lastActivitySummary: status.lastActivitySummary,
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
const COLLECT_PROJECTION_KNOWN_FLAGS = new Set([
  "cursor", "format", "runDir", "cwd",
]);

// base64url, no padding, ≤192 chars — same alphabet as the MCP cursor field.
const COLLECT_CURSOR_RE = /^[A-Za-z0-9_-]+$/;
const COLLECT_CURSOR_MAX = 192;

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

  // M11-4: projection mode is engaged by --cursor OR --format json. This is
  // the machine-readable continuation entry that delegates to the SAME safe
  // projection as MCP. The default `collect <runId>` (no cursor, no format)
  // keeps its existing raw-ops output byte-compatible.
  const hasCursor = typeof options.cursor === "string" && options.cursor.length > 0;
  const isProjectionMode = hasCursor || options.format === "json";

  if (!isProjectionMode) {
    // Default raw-ops surface (unchanged since M9-4A). Prints the raw service
    // result: process {data, reconstructed, backend}; serve messages response.
    // M11-4 CTO rework (Fix E): --limit is honored here (legacy raw CLI
    // contract). In projection mode --limit is rejected below (the projection
    // owns pagination; a user-supplied limit would silently conflict).
    const result = await collectRunMessages({
      runId,
      runDir,
      limit: Number(options.limit ?? 50),
    });
    console.log(JSON.stringify(result, null, 2));
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
  const knownValueFlags = new Set(["--cursor", "--format", "--limit", "--run-dir", "--cwd"]);
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

  // Validate cursor if present.
  let cursor = null;
  if (hasCursor) {
    cursor = String(options.cursor);
    if (cursor.length === 0 || cursor.length > COLLECT_CURSOR_MAX) {
      throw new Error("collect projection mode: invalid cursor length");
    }
    if (!COLLECT_CURSOR_RE.test(cursor)) {
      throw new Error("collect projection mode: cursor must be base64url");
    }
  }

  // format=json is the only supported value in projection mode.
  if (options.format !== undefined && options.format !== "json") {
    throw new Error("collect projection mode: --format only supports json");
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
  const raw = await collectRunMessages({ runId, runDir, cursor, deferAppend: true });
  const payload = projectCollectResult(raw, { runId, cursor });
  // Projection succeeded → safe to commit the audit.
  if (typeof raw.commitAppend === "function") {
    await raw.commitAppend();
  }
  console.log(JSON.stringify(payload, null, 2));
}
