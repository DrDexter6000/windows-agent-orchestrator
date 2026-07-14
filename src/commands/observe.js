// src/commands/observe.js
//
// Observe 命令族：status（只读查询）/ tail（只读追 transcript）/ collect（收集消息，
// 每次成功追加一个 messages.collected 审计事件，非只读）。不含 stop（杀进程，单独拆）。
//
// status 和 collect 已委托共享 application service（runStatus.js / runCollect.js）；
// 本模块只保留 argv 解析、text/JSON 输出适配，以及 tailCommand 的文件轮询逻辑。
//
// 依赖：
//   - 外部模块：../transcript.js（findLatest/readTranscript）、
//     ../backends/opencodeServe.js（tail 不直接用，保留供未来；collect serve 路径走 service）
//   - 共享工具：./shared.js（parseOptions/loadRun）
//   - 共享 service：../application/runStatus.js（status）、../application/runCollect.js（collect）
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

export async function collectCommand(args, config) {
  const [runId, ...tail] = args;
  const options = parseOptions(tail);
  const runDir = resolve(options.runDir ?? config.runDir);
  // M9-4A: collection delegated to shared application service. The CLI prints
  // the raw result (process: {data, reconstructed, backend}; serve: messages
  // response) — the human/ops surface keeps full detail; MCP applies its own
  // bounded projection.
  const result = await collectRunMessages({
    runId,
    runDir,
    limit: Number(options.limit ?? 50),
  });
  console.log(JSON.stringify(result, null, 2));
}
