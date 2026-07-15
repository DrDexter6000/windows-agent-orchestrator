// src/commands/run.js
//
// TD-98 阶段 2e-3（TD-98 收尾）：run/spawn 命令族从 cli.js 拆出（行为不变，纯搬迁）。
//
// 命令族：run <agentId> / spawn <agentId> [agentId2 ...]
// 这是核心派工闭环——RunManager 驱动、background fork、scorecard 门控、失败诊断注入。
//
// 对外导出：spawnCommand / runCommand / runAndWait
// 模块内部 helper（不导出）：parseAgentList / loadScorecardRules / parseScorecardRules /
//   loadScorecardFromTranscript / spawnBackgroundRunner
//
// 依赖：
//   - 共享工具：./shared.js（parseOptions/loadPrompt/newRunManager/resolveIsolateFlag）
//   - 外部模块：../transcript.js（JsonlTranscript/readTranscript）、../cliRunSummary.js
//     （renderRunSummary）
//   - 动态 import（runAndWait catch 块）：../diagnosis.js、../transcript.js
//   - node built-in：fs/promises（readFile）、child_process（spawn）、path（join/resolve/dirname）、
//     url（fileURLToPath）
//
// 路径修正（TD-98 阶段 2e-3，从 src/cli.js 搬到 src/commands/run.js）：
//   1. backgroundRunner.js：原 join(dirname(import.meta.url), "backgroundRunner.js") 解析到
//      src/backgroundRunner.js；现在多一层 .. → src/backgroundRunner.js（src/commands/ -> src/）。
//   2. runAndWait 动态 import：./diagnosis.js → ../diagnosis.js，./transcript.js → ../transcript.js。

import { readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readTranscript } from "../transcript.js";
import { renderRunSummary } from "../cliRunSummary.js";
import { parseOptions, loadPrompt, newRunManager, resolveIsolateFlag } from "./shared.js";
import { prepareDeliveryRequest } from "../delivery.js";
// M9-2A: background dispatch delegated to shared application service.
import { dispatchRun } from "../application/runDispatch.js";

function parseAgentList(args) {
  const agents = [];
  let i = 0;
  while (i < args.length && !args[i].startsWith("--")) {
    agents.push(args[i]);
    i += 1;
  }
  const options = parseOptions(args.slice(i));
  if (agents.length === 0) {
    throw new Error("requires at least one <agentId>");
  }
  return { agents, options };
}

async function loadScorecardRules(options) {
  if (options.scorecardRules && options.scorecardRulesFile) {
    throw new Error("--scorecard-rules and --scorecard-rules-file are mutually exclusive");
  }
  if (options.scorecardRulesFile) {
    options.scorecardRules = await readFile(resolve(options.scorecardRulesFile), "utf8");
    options.scorecardRulesSource = "--scorecard-rules-file";
  } else if (options.scorecardRules) {
    options.scorecardRulesSource = "--scorecard-rules";
  }
  return options;
}

/**
 * TD-103 Phase 3C-1: Load and validate a delivery spec from a JSON file.
 *
 * The file contains the existing RunManager delivery request:
 *   { mode: "git_commit_v1", allowedPaths: [...], verificationCommands: [...] }
 *
 * Validates through the existing prepareDeliveryRequest() SSOT — does not
 * duplicate mode/path/verification rules. Returns the validated delivery
 * object suitable for RunManager.start({delivery}), or undefined if no
 * --delivery-spec-file was given.
 *
 * @param {object} options — parsed CLI options
 * @returns {Promise<object|undefined>} validated delivery request or undefined
 */
async function loadDeliverySpec(options) {
  if (!options.deliverySpecFile) return undefined;
  const raw = await readFile(resolve(options.deliverySpecFile), "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--delivery-spec-file must contain valid JSON: ${options.deliverySpecFile}`);
  }
  // Validate through SSOT — throws DeliveryError on schema violations.
  const validated = prepareDeliveryRequest(parsed);
  return {
    mode: validated.mode,
    allowedPaths: validated.allowedPaths,
    ...(validated.verification.commands.length > 0
      ? { verificationCommands: validated.verification.commands }
      : { verificationUnavailableReason: validated.verification.unavailableReason }),
  };
}

/**
 * 解析 --scorecard-rules 的值（JSON 字符串）。
 * 例：'{"requireCommands":["npm test"],"requireFiles":["out.js"]}'
 */
function parseScorecardRules(raw, source = "--scorecard-rules") {
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${source} must be valid JSON, got: ${raw}`);
  }
}

// P4 决策A：从 transcript 取已落盘的 scorecard.checked 事件（runManager 无论通过/失败
// 都 append）。无 scorecard（run 没配规则）→ null，renderRunSummary 不输出 scorecard 段。
async function loadScorecardFromTranscript(transcriptPath) {
  try {
    const events = await readTranscript(transcriptPath);
    const sc = events.find((e) => e.type === "scorecard.checked");
    return sc ? { passed: sc.passed, checks: sc.checks } : null;
  } catch {
    return null; // transcript 读失败不阻断 header 渲染
  }
}

// P2（M7）→ M9-2A：fork detached runner 托管一个 background run。
// 派发逻辑已提取到共享 application service (dispatchRun)；本函数只负责 CLI 适配——
// 选项整理 + 把 service 结构化结果映射到既有 JSON 输出契约（不变）。
async function spawnBackgroundRunner(agentId, options, config, delivery) {
  if (options.scorecardRules) {
    parseScorecardRules(options.scorecardRules, options.scorecardRulesSource);
  }
  // TD-98 阶段 2e-3 路径修正：本模块在 src/commands/，backgroundRunner.js 在 src/。
  const runnerPath = join(dirname(fileURLToPath(import.meta.url)), "..", "backgroundRunner.js");
  const result = await dispatchRun({
    agentId,
    prompt: options.prompt ?? "",
    registryPath: resolve(options.registry ?? config.registry),
    runDir: resolve(options.runDir ?? config.runDir),
    runId: options.runId,
    cwd: options.cwd,
    waitTimeout: options.waitTimeout ? Number(options.waitTimeout) : undefined,
    pollInterval: options.pollInterval ?? config.pollInterval ?? 1000,
    scorecardRules: options.scorecardRules,
    scorecardMode: options.scorecardMode,
    // M9-2A (§70)：background 路径不再静默忽略 requireCertified——与 foreground 一致透传。
    requireCertified: Boolean(options.requireCertified),
    // M9-7A: forward validated delivery request for background delivery runs.
    delivery,
    runnerPath,
  });
  if (!result.accepted) {
    console.log(JSON.stringify({
      runId: result.runId,
      transcript: result.transcriptPath,
      background: true,
      terminalAccepted: false,
      terminalState: result.terminalState,
      note: `not forked: transcript already terminal (${result.terminalState})`,
    }, null, 2));
    return;
  }
  console.log(JSON.stringify({
    runId: result.runId,
    transcript: result.transcriptPath,
    background: true,
    note: "detached runner owns lifecycle (token gate / abort / state). Poll with `status`/`tail`.",
  }, null, 2));
}

export async function spawnCommand(args, config) {
  const { agents, options } = parseAgentList(args);
  if (options.deliverySpecFile) {
    throw new Error("delivery mode is only supported on `run`, not `spawn`");
  }
  const manager = newRunManager(config);
  // P2（M7）：单 agent spawn 不带 --wait = 后台托管（detached runner）。
  // 替代旧 TD-39 "拒绝裸 spawn"——现在不拒，而是托管：runner 拥有 handle 驱动 wait+gate+abort，
  // 不再产生孤儿会话（06-18 事故架构洞的正解）。多 agent spawn 仍要求 --wait（并行 background 留 P3 daemon）。
  if (agents.length === 1 && !options.wait) {
    options.prompt = await loadPrompt(options);
    await loadScorecardRules(options);
    return spawnBackgroundRunner(agents[0], options, config);
  }
  await loadScorecardRules(options);
  if (agents.length === 1) {
    const run = await manager.start(agents[0], {
      prompt: await loadPrompt(options),
      registry: options.registry,
      runDir: options.runDir,
      tags: options.tag,
      cwd: options.cwd,
      isolate: resolveIsolateFlag(options),
      ...(options.scorecardRules ? { scorecard: { rules: parseScorecardRules(options.scorecardRules, options.scorecardRulesSource) } } : {}),
      // P0-1 护栏：不带 --wait = fire-and-forget。遇 sessionOutlivesProcess 的 backend 会被
      // RunManager.start 拒绝（06-18 事故防线）。带 --wait 时 fireAndForget=false，护栏放行。
      fireAndForget: !options.wait,
    });
    console.log(JSON.stringify({ runId: run.transcript.context.runId, transcript: run.transcript.filePath, ...run.result }, null, 2));
    if (options.wait) {
      const waitResult = await runAndWait(run, options);
      console.log(JSON.stringify(waitResult, null, 2));
    }
    return;
  }
  const spawned = await Promise.all(agents.map((id) =>
    manager.start(id, {
      prompt: options.prompt,
      registry: options.registry,
      runDir: options.runDir,
      tags: options.tag,
      cwd: options.cwd,
      isolate: resolveIsolateFlag(options),
      ...(options.scorecardRules ? { scorecard: { rules: parseScorecardRules(options.scorecardRules, options.scorecardRulesSource) } } : {}),
      fireAndForget: !options.wait, // P0-1 护栏（同单 agent 路径）
    }),
  ));
  for (const run of spawned) {
    console.log(JSON.stringify({ runId: run.transcript.context.runId, transcript: run.transcript.filePath, ...run.result }, null, 2));
  }
  if (options.wait) {
    const results = await Promise.all(spawned.map((run) =>
      runAndWait(run, options).then((w) => ({ run, ...w })),
    ));
    console.log("--- parallel wait complete ---");
    for (const r of results) {
      const status = r.failed ? "failed" : (r.completed ? "completed" : "timed out");
      const detail = r.failed ? ` (${r.error})` : "";
      console.log(`${r.run.transcript.context.runId}: ${status}${detail}`);
    }
  }
}

export async function runCommand(args, config) {
  const [agentId, ...tail] = args;
  if (!agentId) {
    throw new Error("run requires <agentId>");
  }
  const options = parseOptions(tail);
  // TD-103 Phase 3C-1: load and validate delivery spec before any side effects.
  const delivery = await loadDeliverySpec(options);
  // Delivery requires --isolate; reject before spawn.
  if (delivery && !resolveIsolateFlag(options)) {
    throw new Error("delivery mode requires --isolate (persistent worktree isolation)");
  }
  // M9-7A: background delivery is now supported — the delivery request is
  // forwarded through the shared dispatchRun service to the detached runner.
  // P2（M7）：--background = detached runner 托管。CLI 预生成 runId、fork runner、立即返回。
  // runner 拥有 worker handle，驱动 waitForCompletion（含 token 闸门/超时/兜底 abort），
  // 写共享 transcript。这是 06-18 事故架构洞的正解——把"拒绝裸 spawn"换"托管生命周期"。
  if (options.background) {
    options.prompt = await loadPrompt(options);
    await loadScorecardRules(options);
    return spawnBackgroundRunner(agentId, options, config, delivery);
  }
  options.wait = true;
  await loadScorecardRules(options);
  const manager = newRunManager(config);
  const run = await manager.start(agentId, {
    prompt: await loadPrompt(options),
    registry: options.registry,
    runDir: options.runDir,
    tags: options.tag,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    isolate: resolveIsolateFlag(options),
    requireCertified: Boolean(options.requireCertified),
    // M8-1：默认 scorecard 模式。warn(默认)=开启留痕不阻塞 | hard=升级硬闸 | off=完全关闭。
    ...(options.scorecardMode ? { scorecardMode: options.scorecardMode } : {}),
    ...(options.scorecardRules ? { scorecard: { rules: parseScorecardRules(options.scorecardRules, options.scorecardRulesSource) } } : {}),
    // TD-103 Phase 3C-1: pass validated delivery request to RunManager.
    ...(delivery ? { delivery } : {}),
  });
  const format = options.format ?? "text";
  const waitResult = await runAndWait(run, options);
  // P4 决策A：scorecard 从 transcript 的 scorecard.checked 事件取（runManager 无论通过/失败都落盘）。
  // TD-53 修复：注入前置于格式分支之前——原 json 分支 early-return 在注入之前，丢字段。
  // 现 json 与 text 两路都带 scorecard（renderRunSummary 读 waitResult.scorecard，行为不变）。
  const scorecard = await loadScorecardFromTranscript(run.transcript.filePath);
  if (scorecard) waitResult.scorecard = scorecard;
  if (format === "json") {
    console.log(JSON.stringify(waitResult, null, 2));
    return;
  }
  console.log(renderRunSummary(waitResult, { agentId }));
  // 失败时 header 已含 error，不再 dump assistant 文本。
  if (waitResult.failed) return;
  // 成功：header 之下打印 worker 的 assistant 文本（保留既有产出可见性）。
  if (waitResult.messages) {
    for (const msg of waitResult.messages) {
      if (msg.info?.role === "assistant" && msg.parts) {
        for (const part of msg.parts) {
          if (part.type === "text" && part.text) {
            console.log(part.text);
          }
        }
      }
    }
  }
}

/**
 * 包装 waitForCompletion：捕获 failed 抛错，转为结构化结果返回。
 * 让主控能看到 worker 失败的证据（runId/failed/error），决定是否接手，
 * 而不是 CLI 崩溃 exit 1 什么也不输出。
 *
 * TD-95 #6（复盘）：error 截断到 500 字符（后端 raw stderr 最多 4000 字符，噪声高）；
 * failed 时注入 diagnosis 字段（复用 diagnoseFailure，帮 Lead 快速分类不用读 raw error）。
 */
export async function runAndWait(run, options) {
  try {
    const result = await run.waitForCompletion(options);
    return { runId: run.transcript.context.runId, ...result };
  } catch (error) {
    // waitForCompletion 在 done(failed) 时抛错。转为结构化失败结果，
    // 让调用方（主控/CLI）能看到失败原因，而非裸 crash。
    const rawError = error.message ?? String(error);
    // TD-95 #6：截断 error 到 500 字符（含后缀）+ 附 transcript path
    const MAX_ERROR = 500;
    const SUFFIX = `... (truncated, ${rawError.length} chars total — see transcript)`;
    const truncatedError = rawError.length > MAX_ERROR
      ? rawError.slice(0, MAX_ERROR - SUFFIX.length) + SUFFIX
      : rawError;
    // TD-95 #6：注入 diagnosis（读 transcript 分类）。transcript 不存在也给 unknown（不崩）。
    // TD-98 阶段 2e-3 路径修正：本模块在 src/commands/，diagnosis.js/transcript.js 在 src/，
    // 故动态 import 用 ../（原 cli.js 在 src/ 用 ./）。
    let diagnosis = null;
    try {
      const { diagnoseFailure } = await import("../diagnosis.js");
      const { readTranscript: readTranscriptForDiagnosis } = await import("../transcript.js");
      let events = [];
      try { events = await readTranscriptForDiagnosis(run.transcript.filePath); } catch {}
      diagnosis = diagnoseFailure(events);
    } catch {
      // diagnoseFailure 本身崩（不该发生）→ diagnosis 留 null
    }
    return {
      runId: run.transcript.context.runId,
      completed: false,
      failed: true,
      timedOut: false,
      error: truncatedError,
      transcript: run.transcript.filePath,
      ...(diagnosis ? { diagnosis } : {}),
    };
  }
}
