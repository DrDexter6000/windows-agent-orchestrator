// src/commands/lifecycle.js
//
// TD-98 阶段 2e-2：retry/resume 命令从 cli.js 拆出（行为不变，纯搬迁）。
//
// 命令族：retry <runId> / resume <runId>
// retry：读旧 run 的 prompt.sent 重新 spawn（新 runId）。
// resume：attach 到已有 session（opencode HTTP 类，进程已死则重 spawn）。
//
// 依赖：
//   - 外部模块：../transcript.js（findLatest——retry 取 prompt.sent 事件）
//   - 共享工具：./shared.js（parseOptions/loadRun/newRunManager/resolveIsolateFlag）
//
// retry/resume 不是 public export（无 test 直接 import，无 re-export 需求）。

import { findLatest } from "../transcript.js";
import { parseOptions, loadRun, newRunManager, resolveIsolateFlag } from "./shared.js";

export async function retryCommand(args, config) {
  const [runId, ...tail] = args;
  if (!runId) {
    throw new Error("retry requires <runId>");
  }
  const options = parseOptions(tail);
  const { events } = await loadRun(runId, options, config);
  const agentId = events[0]?.agentId;
  if (!agentId) {
    throw new Error(`Run ${runId} has no agentId`);
  }
  const promptEvent = findLatest(events, "prompt.sent");
  if (!promptEvent?.prompt) {
    throw new Error(`Run ${runId} has no stored prompt (runs before v0.0.2 may not store prompts)`);
  }
  const manager = newRunManager(config);
  const run = await manager.start(agentId, {
    prompt: promptEvent.prompt,
    registry: options.registry,
    runDir: options.runDir,
    tags: options.tag,
    cwd: options.cwd,
    isolate: resolveIsolateFlag(options),
  });
  console.log(JSON.stringify({ originalRunId: runId, newRunId: run.transcript.context.runId, transcript: run.transcript.filePath, ...run.result }, null, 2));
  if (options.wait) {
    const waitResult = await run.waitForCompletion(options);
    console.log(JSON.stringify({ completed: waitResult.completed }, null, 2));
  }
}

export async function resumeCommand(args, config) {
  const [runId, ...tail] = args;
  if (!runId) {
    throw new Error("resume requires <runId>");
  }
  const options = parseOptions(tail);
  const manager = newRunManager(config);
  const run = await manager.resume(runId, { runDir: options.runDir, registry: options.registry });
  if (!run) {
    console.log(JSON.stringify({ runId, resumed: false, reason: "terminal or not found" }));
    return;
  }
  console.log(JSON.stringify({ runId, resumed: true, state: run.state, sessionId: run.result?.backendSessionId }));
  if (options.wait) {
    const waitResult = await run.waitForCompletion(options);
    console.log(JSON.stringify({ runId, completed: waitResult.completed }));
  }
}
