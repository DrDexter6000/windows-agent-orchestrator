// src/commands/observe.js
//
// TD-98 阶段 2e-1a：只读 observe 命令族从 cli.js 拆出（行为不变，纯搬迁）。
//
// 命令族：status / tail / collect（全是只读——查 run 状态、追 transcript、收集消息）。
// 不含 stop（stop 杀进程 + stop verification + alert，非只读，单独拆）。
//
// 依赖：
//   - 外部模块：../transcript.js（findState/findLatest/readTranscript）、
//     ../backends/opencodeServe.js（collect 的 opencode 路径查询服务端 messages）
//   - 共享工具：./shared.js（parseOptions/loadRun，纯函数 + 只读 I/O）
//   - node built-in：fs/promises（readFile）、fs（watchFile/unwatchFile）、path（basename）
//
// 本模块内部 helper（command-local，只 observe 族用）：
//   describeActivity / summarizeToolInput / truncate（status 专用）、
//   reconstructProcessEvent（collect 专用）。

import { readFile } from "node:fs/promises";
import { watchFile, unwatchFile } from "node:fs";
import { resolve } from "node:path";

import { findLatest, readTranscript } from "../transcript.js";
import { OpenCodeServeBackend } from "../backends/opencodeServe.js";
import { parseOptions, loadRun } from "./shared.js";
// M9-3A: status aggregation delegated to shared application service.
import { getRunStatus } from "../application/runStatus.js";

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

/**
 * TD-77 子项 A：把一条 run.event 还原成 collect 输出的时间线条目。
 * 按 runEvent.js 的字段表映射各 kind。thinking 不持久化故不重建（返回 null 被过滤）。
 * 未知 kind 透传原样（向前兼容未来新增的 run.event kind）。
 * @param {Object} ev - transcript 里的一条 run.event
 * @returns {Object|null} 重建条目，或 null（不重建的 kind）
 */
function reconstructProcessEvent(ev) {
  switch (ev.kind) {
    case "message":
      return { kind: "message", role: ev.role, parts: ev.parts };
    case "command":
      return { kind: "command", command: ev.command, ...(ev.exitCode !== undefined ? { exitCode: ev.exitCode } : {}) };
    case "tool_use":
      return { kind: "tool_use", tool: ev.tool, input: ev.input };
    case "tool_result":
      return { kind: "tool_result", tool: ev.tool, output: ev.output, isError: ev.isError };
    case "file_written":
      return { kind: "file_written", path: ev.path };
    case "thinking":
      // runManager 未把 thinking 持久化到 transcript，无东西可重建。
      return null;
    default:
      // 未知 kind（如未来新增）透传 kind + 原始字段，不丢信号。
      return { kind: ev.kind ?? "unknown", ...ev };
  }
}

export async function collectCommand(args, config) {
  const [runId, ...tail] = args;
  const options = parseOptions(tail);
  const { transcript, events } = await loadRun(runId, options, config);
  const session = findLatest(events, "session.created");
  if (!session?.backendSessionId) {
    throw new Error(`Run ${runId} has no session metadata (no session.created event)`);
  }

  // TD-77 子项 A：进程型 run（backendSessionId=proc_<pid>，无 serveUrl）无服务端 session 可查询，
  // 从 transcript 的 run.event 重建 worker 的"做了什么"时间线返回。
  // 旧实现只重建 kind==="message" → 崩在无最终 message 的 run 返回 data:[]，让 Lead
  // 验收失败 run 时两手空空（实测 run_20260628203352049lf1n0l：144 条证据事件全丢）。
  // 现重建所有 run.event kind（message/command/tool_use/tool_result/file_written），
  // 按 runEvent.js 字段表还原。thinking 不重建（runManager 未持久化 thinking 到 transcript）。
  // 与 opencode 路径分流——按 session 标志判定，runtime-agnostic。
  if (!session.serveUrl) {
    const limit = Number(options.limit ?? 50);
    const reconstructed = events
      .filter((e) => e.type === "run.event")
      .map(reconstructProcessEvent)
      .filter((e) => e !== null)
      .slice(-limit);
    await transcript.append("messages.collected", {
      backendSessionId: session.backendSessionId,
      backend: "process",
      count: reconstructed.length,
      reconstructed: true,
    });
    console.log(JSON.stringify({ data: reconstructed, reconstructed: true, backend: "process" }, null, 2));
    return;
  }

  const runStarted = findLatest(events, "run.started");
  const backend = new OpenCodeServeBackend();
  const messages = await backend.messages(session.serveUrl, session.backendSessionId, {
    cwd: runStarted?.cwd,
    limit: Number(options.limit ?? 50),
  });
  await transcript.append("messages.collected", {
    backendSessionId: session.backendSessionId,
    count: messages.data?.length ?? 0,
  });
  console.log(JSON.stringify(messages, null, 2));
}
