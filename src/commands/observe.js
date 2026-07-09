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
import { basename } from "node:path";

import { findState, findLatest, readTranscript } from "../transcript.js";
import { OpenCodeServeBackend } from "../backends/opencodeServe.js";
import { parseOptions, loadRun } from "./shared.js";

/**
 * TD-75 补全：把最后一条 run.event 映射成 Lead 可读的活动类型 + 摘要。
 * 只给"在干啥"的人类可读描述，不泄露完整内容（summary 截断/取关键标识，防 token 膨胀）。
 * @param {Object} ev - 最后一条 run.event（可为 null）
 * @returns {{lastActivityKind: string|null, lastActivitySummary: string|null}}
 */
function describeActivity(ev) {
  if (!ev) return { lastActivityKind: null, lastActivitySummary: null };
  switch (ev.kind) {
    case "message":
      return { lastActivityKind: "在说话", lastActivitySummary: `worker 发言（${ev.role ?? "?"}）` };
    case "thinking":
      // TD-76：思考期间心跳持续，Lead 知道"在想"而非"假死"（不存内容）
      return { lastActivityKind: "在思考", lastActivitySummary: "worker 正在 reasoning" };
    case "command":
      return { lastActivityKind: "跑命令", lastActivitySummary: truncate(ev.command ?? "", 80) };
    case "tool_use":
      return { lastActivityKind: `用工具 ${ev.tool ?? "?"}`, lastActivitySummary: summarizeToolInput(ev.tool, ev.input) };
    case "tool_result":
      return { lastActivityKind: "收工具结果", lastActivitySummary: `${ev.tool ?? "?"} 返回${ev.isError ? "（错误）" : ""}` };
    case "file_written":
      return { lastActivityKind: "在写文件", lastActivitySummary: basename(ev.path ?? "") };
    default:
      return { lastActivityKind: ev.kind ?? "未知", lastActivitySummary: "" };
  }
}

function summarizeToolInput(tool, input) {
  if (!input || typeof input !== "object") return "";
  // 取最能标识"在干啥"的字段：路径/命令/pattern 优先
  const key = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query;
  return key ? truncate(String(key), 80) : "";
}

function truncate(s, n) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

export async function statusCommand(args, config) {
  const [runId, ...tail] = args;
  const { events } = await loadRun(runId, parseOptions(tail), config);
  const last = events.at(-1);
  const state = findState(events);
  // TD-75 worker 心跳：lastActivityTs = 最后一条 run.event 的 ts。
  // appendFile 每 event flush（transcript.js），故这是实时的"生命体征"——
  // Lead 据此判 worker 活性：< 120s 还活着别动（守"宁慢勿杀"）；≥120s 才是掉链子信号。
  // 只算 run.event（thinking/text/tool_use/tool_result/command/file_written），不计
  // state_change/error/metrics 等编排事件——心跳要反映"worker 在产出"。
  // 无 run.event（纯启动失败）→ null。终态 run 也输出（Lead 看死前是否还在跳）。
  //
  // TD-75 补全：同一条事件还带 kind（message/command/tool_use/tool_result/file_written），
  // 映射成 lastActivityKind（人类可读活动类型）+ lastActivitySummary（带具体内容，如命令名/
  // 工具名/文件名）。让 Lead 从"47s 前还活着"升级到"47s 前在跑 npm test"——掌握 worker 在干啥，
  // 减少因"不知道在干啥"而误判停（守"宁慢勿杀"）。
  const lastActivity = [...events].reverse().find((e) => e.type === "run.event");
  const lastActivityTs = lastActivity?.ts ?? null;
  const secondsSinceActivity = lastActivityTs
    ? Math.round((Date.now() - new Date(lastActivityTs).getTime()) / 1000)
    : null;
  const { lastActivityKind, lastActivitySummary } = describeActivity(lastActivity);
  console.log(JSON.stringify({ runId, state, last, lastActivityTs, secondsSinceActivity, lastActivityKind, lastActivitySummary }, null, 2));
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
