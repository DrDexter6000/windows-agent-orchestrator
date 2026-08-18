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
//   - 核心门：../runManager.js（R12 覆盖形状/闭集校验 SSOT——与 run/resume 同源）
//
// retry/resume 不是 public export（无 test 直接 import，无 re-export 需求）。

import { findLatest } from "../transcript.js";
import { parseOptions, loadRun, newRunManager, resolveIsolateFlag } from "./shared.js";
// R12: the per-dispatch override shape SSOT (hosted in runManager.js with the
// synthesis site). Same import discipline as run.js's validators — one source
// for the CLI/MCP/start faces, zero drift. Adapters(0)→core(2) is downward.
import { assertValidModelOverride, assertValidReasoningOverride, isValidModelOverride, isValidReasoningOverride } from "../runManager.js";

export async function retryCommand(args, config) {
  const [runId, ...tail] = args;
  if (!runId) {
    throw new Error("retry requires <runId>");
  }
  const options = parseOptions(tail);
  // R12: CLI shape gates for the explicit replacement flags — the SAME SSOT
  // validators `run` uses, at the same pre-side-effect position (loadRun is
  // read-only, but fail-fast still wins: a malformed --model/--reasoning is
  // rejected before any file is touched). Fixed safe text, never echoes the
  // supplied value.
  if (options.model !== undefined) {
    assertValidModelOverride(options.model);
  }
  if (options.reasoning !== undefined) {
    assertValidReasoningOverride(options.reasoning);
  }
  const { events } = await loadRun(runId, options, config);
  const agentId = events[0]?.agentId;
  if (!agentId) {
    throw new Error(`Run ${runId} has no agentId`);
  }
  const promptEvent = findLatest(events, "prompt.sent");
  if (!promptEvent?.prompt) {
    throw new Error(`Run ${runId} has no stored prompt (runs before v0.0.2 may not store prompts)`);
  }
  // R12 ("同形重试", Owner 2026-08-18): retry INHERITS the source run's
  // per-dispatch overrides from its run.started facts (the same durable
  // authority resume rebuilds from, R10-C C-1 / R11-1) — a retry re-dispatches
  // the SAME shape, symmetric with resume's "keep the dispatched model" rule.
  // Explicit --model/--reasoning REPLACE the corresponding inherited value;
  // absent flags keep it; source-without-override + no flags = zero overrides
  // (byte-compatible with the pre-R12 face).
  const runStarted = findLatest(events, "run.started");
  const inheritedModel = runStarted?.modelOverride;
  const inheritedReasoning = runStarted?.reasoningOverride;
  // Fail-closed on a bad PERSISTED value (corrupt/tampered transcript): retry
  // refuses BEFORE manager.start — zero new transcript, never spawns a model
  // the transcript does not license, never silently degrades to the registry
  // policy. Fixed text pointing at the SOURCE run (the operator's fix is to
  // re-dispatch explicitly with `run`, not to hand-edit transcripts).
  if (inheritedModel !== null && inheritedModel !== undefined && !isValidModelOverride(inheritedModel)) {
    throw new Error(
      `Run ${runId}: retry refuses to inherit this run's model override — the persisted `
      + "run.started.modelOverride is not a valid model override id (corrupt or tampered transcript; "
      + "retry_inherit_model_invalid). Retry re-dispatches with the SAME override or none — it never "
      + "silently falls back to the registry model. Re-dispatch explicitly with `run --model <id>` instead.",
    );
  }
  if (inheritedReasoning !== null && inheritedReasoning !== undefined && !isValidReasoningOverride(inheritedReasoning)) {
    throw new Error(
      `Run ${runId}: retry refuses to inherit this run's reasoning override — the persisted `
      + "run.started.reasoningOverride is not in the closed effort set (corrupt or tampered transcript; "
      + "retry_inherit_reasoning_invalid). Retry re-dispatches with the SAME override or none — it never "
      + "silently falls back to the registry effort. Re-dispatch explicitly with `run --reasoning <effort>` instead.",
    );
  }
  const modelOverride = options.model !== undefined ? options.model : inheritedModel;
  const reasoningOverride = options.reasoning !== undefined ? options.reasoning : inheritedReasoning;
  const manager = newRunManager(config);
  const run = await manager.start(agentId, {
    prompt: promptEvent.prompt,
    registry: options.registry,
    runDir: options.runDir,
    tags: options.tag,
    cwd: options.cwd,
    isolate: resolveIsolateFlag(options),
    // R12: inherited (or flag-replaced) overrides ride start's EXISTING gates —
    // the closed-set/shape assert, the requireCertified/sessionReuse mutexes
    // (retry has neither flag, so those doors stay closed by construction; a
    // source agent reconfigured into a reuse shape between dispatches is
    // refused HERE by start, which is the correct authority), and the
    // synthesis that persists the explicit run.started override facts on the
    // NEW run. Absent when neither source nor flag supplied one.
    ...(modelOverride !== null && modelOverride !== undefined ? { modelOverride } : {}),
    ...(reasoningOverride !== null && reasoningOverride !== undefined ? { reasoningOverride } : {}),
  });
  // R12: advisory inheritance echo — present ONLY when an override is actually
  // in play. Each member carries the value plus a closed-set source marker:
  //   "inherited" — threaded verbatim from the source run.started fact;
  //   "replaced"  — an explicit --model/--reasoning flag replaced it (or
  //                 supplied one the source never had).
  // Same wording discipline as the "effective model" echo: it shows what WAO
  // threaded, not that the provider accepts the value. Absent entirely for an
  // ordinary no-override retry (byte-compatible output).
  const overrideEcho = {};
  if (modelOverride !== null && modelOverride !== undefined) {
    overrideEcho.model = { value: modelOverride, source: options.model !== undefined ? "replaced" : "inherited" };
  }
  if (reasoningOverride !== null && reasoningOverride !== undefined) {
    overrideEcho.reasoning = { value: reasoningOverride, source: options.reasoning !== undefined ? "replaced" : "inherited" };
  }
  console.log(JSON.stringify({
    originalRunId: runId,
    newRunId: run.transcript.context.runId,
    transcript: run.transcript.filePath,
    ...run.result,
    ...(Object.keys(overrideEcho).length > 0 ? { inheritedOverrides: overrideEcho } : {}),
  }, null, 2));
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
