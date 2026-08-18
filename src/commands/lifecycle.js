// src/commands/lifecycle.js
//
// TD-98 阶段 2e-2：retry/resume 命令从 cli.js 拆出（行为不变，纯搬迁）。
//
// 命令族：retry <runId> / resume <runId>
// retry：读旧 run 的 prompt.sent 重新 spawn（新 runId）。
// resume：attach 到已有 session（opencode HTTP 类，进程已死则重 spawn）。
//
// 依赖：
//   - 外部模块：../transcript.js（findLatestBound/findFirstBound——R13 起 retry
//     的 prompt.sent/run.started 读取走带 runId 绑定的共享读取器）
//   - 共享工具：./shared.js（parseOptions/loadRun/newRunManager/resolveIsolateFlag）
//   - 核心门：../runManager.js（R12 覆盖形状/闭集校验 SSOT——与 run/resume 同源）
//
// retry/resume 不是 public export（无 test 直接 import，无 re-export 需求）。

import { findLatestBound, findFirstBound } from "../transcript.js";
import { parseOptions, loadRun, newRunManager, resolveIsolateFlag } from "./shared.js";
// R12: the per-dispatch override shape SSOT (hosted in runManager.js with the
// synthesis site). Same import discipline as run.js's validators — one source
// for the CLI/MCP/start faces, zero drift. Adapters(0)→core(2) is downward.
import { assertValidModelOverride, assertValidReasoningOverride, isValidModelOverride, isValidReasoningOverride } from "../runManager.js";

/**
 * R13-C (TD-127 rework): retry's task-text read — the LAST prompt.sent BOUND
 * to this runId, in PURE binding semantics. The legal TD-54 double-write
 * shape is preserved order-wise (runManager.start appends a bare {prompt}
 * BEFORE spawn and a second write AFTER; both carry the same .prompt, so
 * last-bound == the authoritative second write).
 *
 * Security posture, honestly scoped:
 *   - runId binding kills cross-run injection (a tail-appended prompt.sent
 *     carrying a FOREIGN runId is never picked) and cross-run misreads.
 *   - Binding CANNOT stop a forged SAME-runId tail append — on disk it is
 *     shape-identical to a legal append and the attacker already has runs/
 *     write power. R13 tried a "prefer the last event WITH a messageId"
 *     narrowing on top; R13-C REMOVED it: for the ProcessBackend family
 *     (claudeCode.js / kimiCode.js / codex.js all extend ProcessBackend)
 *     the spawn result carries messageId: undefined, which transcript
 *     serialization drops — BOTH legal writes land bare, so the narrowing
 *     was dead code for that family (a bare forged tail beat it via the
 *     fallback). A same-runId append forgery — bare or shape-complete —
 *     is a runs/-write-capability attack surface the READ side cannot
 *     solve; the real boundary is write-end integrity.
 *   - Behavior on envelope-era LEGAL shapes is byte-identical to the
 *     pre-R13 findLatest: single {prompt} → it; legal double → the second
 *     (last bound). Pre-envelope LEGACY transcripts (events with no runId
 *     field) yield no bound match → retry refuses (see the error below);
 *     the byte-identity claim is envelope-era only.
 *   - runStageProjection.js:53-58 deliberately keeps envelope-less legacy
 *     events IN scope; retry deliberately does NOT: that projection is a
 *     read-only display lane, while retry RE-DISPATCHES text — an
 *     envelope-less line staying in scope here would mean dispatching
 *     text the binding discipline cannot attribute to this run.
 */
function findRetryPromptEvent(events, runId) {
  return findLatestBound(events, "prompt.sent", runId);
}

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
  // R13-C (TD-127 rework): the task text is read through the runId-BOUND
  // reader (findRetryPromptEvent above) — a tail-appended forged prompt.sent
  // with a FOREIGN runId is never the re-dispatched prompt. A same-runId
  // forged append still lands (runs/ write power) — that residual is
  // write-end territory, not solvable at this read site; see the honest
  // scoping above.
  const promptEvent = findRetryPromptEvent(events, runId);
  if (!promptEvent?.prompt) {
    // R13-C honesty fix: this refusal fires for TWO shapes — a transcript
    // with no prompt.sent at all, and a pre-envelope legacy transcript whose
    // prompt.sent lines carry no runId (invisible to the bound reader). The
    // old "runs before v0.0.2 may not store prompts" text claimed only the
    // first; the wording below covers both and names the escape hatch.
    throw new Error(
      `Run ${runId}: no runId-bound prompt.sent found in this transcript — pre-envelope legacy `
      + "formats are not retryable through the bound reader; re-dispatch explicitly with `run`",
    );
  }
  // R12 (Owner 2026-08-18; hardened R12-C C-1): retry INHERITS the source
  // run's per-dispatch overrides from its run.started fact — the FIRST
  // run.started bound to this runId (the envelope-binding discipline this repo
  // already applies to run.started authority, e.g. transcript.js /
  // runDelivery.js / runScopeObservation.js) and the same first-match lookup
  // resume uses. R13: the read goes through the shared findFirstBound reader
  // (behavior-equivalent swap — the discipline now has a single definition in
  // transcript.js). A tail-appended forged run.started — even one with a
  // shape-legal modelOverride/reasoningOverride — is never picked up.
  // Scope honesty (R12-C C-3): retry re-dispatches the task text and the
  // per-dispatch overrides ONLY. delivery/readOnly/isolation shape are NOT
  // inherited (pre-R12 behavior) — a full-shape re-send is `run`'s job.
  // Explicit --model/--reasoning REPLACE the corresponding inherited value;
  // absent flags keep it; source-without-override + no flags = zero overrides
  // (byte-compatible with the pre-R12 face). A source transcript with NO
  // runId-bound run.started (pre-R10 old format) leniently retries with zero
  // overrides (`?.` chain) — resume instead refuses; each is correct for its
  // own lane (R12-C C-5).
  const runStarted = findFirstBound(events, "run.started", runId);
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
    // the closed-set/shape assert, the requireCertified mutex (retry has no
    // such flag, so that door stays closed by construction), and the
    // synthesis that persists the explicit run.started override facts on the
    // NEW run. Absent when neither source nor flag supplied one.
    // Reuse truth (R12-C C-2): retry is a FOREGROUND start call — it does not
    // resolve sessionReuse routing (only the background dispatch lane does),
    // so start's sessionReuse mutex (runManager.js: it fires only when the
    // CALLER supplies sessionReuse) cannot fire here. A source agent
    // reconfigured into a reuse shape between dispatches still retries,
    // dispatched with a FRESH provider session (same family as a foreground
    // `run`) — the correct semantics for a re-dispatch, not a refusal.
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
