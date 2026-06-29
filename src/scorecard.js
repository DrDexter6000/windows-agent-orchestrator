import { stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * scorecard：证据链门控（M6-5，spec §6.1）。
 *
 * 定位：横切层，独立于编排和执行。
 *   - 不信任 agent 自报的"完成"
 *   - 检查 transcript 里的真实事件（命令是否真跑、产出文件是否存在、测试是否真通过）
 *   - 门控判定来自程序检查，不来自 LLM 理解
 *
 * 输入：transcript 事件数组（含 run.event 类型的证据事件）。
 * 不读 transcript 文件——调用方负责读（和 aggregateRunMetrics 一致）。
 *
 * @typedef {Object} ScorecardRules
 * @property {string[]} [requireCommands]  必须执行且 exitCode=0 的命令（包含匹配）
 * @property {string[]} [requireFiles]    必须写入且真实存在的文件（cwd 相对路径）
 * @property {boolean} [requireEvidence]  true=必须有至少一条证据事件
 *
 * @typedef {Object} ScorecardCheck
 * @property {string} name
 * @property {boolean} passed
 * @property {string} evidence    证据描述（人读）
 * @property {string} [detail]    失败时的详情
 *
 * @typedef {Object} ScorecardResult
 * @property {boolean} passed
 * @property {ScorecardCheck[]} checks
 */

/**
 * 执行 scorecard 检查。
 * @param {{events: Array, cwd: string, rules: ScorecardRules}} ctx
 * @returns {Promise<ScorecardResult>}
 */
export async function checkScorecard({ events, cwd, rules }) {
  const evidenceEvents = (events ?? []).filter((e) => e.type === "run.event");
  const toolResults = evidenceEvents.filter((e) => e.kind === "tool_result");
  const commands = evidenceEvents
    .filter((e) => e.kind === "command")
    .map((cmd) => withInferredCommandExitCode(cmd, toolResults));
  const files = evidenceEvents.filter((e) => e.kind === "file_written");
  const hasDone = (events ?? []).some((e) => e.type === "run.completed");

  const checks = [];

  // 1. hasDoneEvent：节点是否真跑完（transcript 有完整事件链到 done）
  checks.push({
    name: "hasDoneEvent",
    passed: hasDone,
    evidence: hasDone ? "run.completed present" : "run.completed missing",
    ...(hasDone ? {} : { detail: "no run.completed event in transcript" }),
  });

  // 2. commandsPassed：requireCommands 里每个命令必须出现且 exitCode=0
  if (Array.isArray(rules?.requireCommands) && rules.requireCommands.length > 0) {
    checks.push(checkCommandsPassed(rules.requireCommands, commands));
  }

  // 3. filesExist：requireFiles 里每个文件必须 file_written + fs 真实存在
  if (Array.isArray(rules?.requireFiles) && rules.requireFiles.length > 0) {
    checks.push(await checkFilesExist(rules.requireFiles, files, cwd));
  }

  // 4. hasEvidence：requireEvidence 时检查至少一条证据
  if (rules?.requireEvidence) {
    const hasAny = evidenceEvents.length > 0;
    checks.push({
      name: "hasEvidence",
      passed: hasAny,
      evidence: `${evidenceEvents.length} evidence event(s) found`,
      ...(hasAny ? {} : { detail: "no command/file_written/tool_use/tool_result events" }),
    });
  }

  // 5. hasAssistantText：requireAssistantText 时检查至少一条 assistant message 含非空 text。
  // 纵深防御（codex 实测建议）：防 completed 但 assistantTextCount=0 的伪完成。
  if (rules?.requireAssistantText) {
    const messageEvents = (events ?? []).filter((e) => e.type === "run.message");
    const hasText = messageEvents.some(
      (m) => m.role === "assistant" && Array.isArray(m.parts) &&
             m.parts.some((p) => p.type === "text" && p.text),
    );
    checks.push({
      name: "hasAssistantText",
      passed: hasText,
      evidence: hasText ? "assistant text answer present" : "no assistant text answer",
      ...(hasText ? {} : { detail: "completed but no assistant text part — possible pseudo-completion" }),
    });
  }

  // 6. requireAcceptance（P4 融合项 #4，决策 0011）：用户验收脚本。
  // 与 requireCommands 的语义差：requireCommands 验 worker 自己跑了什么命令；
  // requireAcceptance 验 worker 干的是对的——lead/user 提供的独立 oracle 脚本，
  // exit 0 = passed，exit≠0 = failed，detail 透传 stderr。是 scorecard 的新 check，非替代。
  if (rules?.requireAcceptance) {
    checks.push(await checkAcceptance(rules.requireAcceptance, cwd));
  }

  const passed = checks.every((c) => c.passed);
  return { passed, checks };
}

/**
 * 检查 requireAcceptance：跑用户提供的验收脚本，exit 0 = 通过。
 * 决策 0011：acceptance script 是独立 oracle（lead/user 提供，非 worker 自己跑产出），
 * exit≠0 或抛异常 = 验收失败，stderr 透传到 detail。
 * 脚本路径相对 cwd 解析。用 node 跑（统一入口，避免 shebang/扩展名平台差异）。
 */
async function checkAcceptance(scriptPath, cwd) {
  const absPath = isAbsolute(scriptPath) ? scriptPath : resolve(cwd, scriptPath);
  try {
    // node 跑脚本：统一入口，跨平台稳（不需 .mjs 在 PATH 或 shebang）。
    execFileSync(process.execPath, [absPath], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 60000 });
    return { name: "acceptance", passed: true, evidence: `exit 0: ${scriptPath}` };
  } catch (e) {
    // exit≠0、超时、脚本抛错都进 catch。
    const stderr = (e.stderr?.toString("utf8") ?? "").trim();
    const reason = e.status != null ? `exit ${e.status}`
      : e.killed ? `timed out (60s)`
      : (e.message ?? "failed");
    const detail = stderr ? `${reason}: ${stderr}` : reason;
    return { name: "acceptance", passed: false, evidence: `exit≠0: ${scriptPath}`, detail };
  }
}

function withInferredCommandExitCode(command, toolResults) {
  if (typeof command.exitCode === "number") return command;
  if (typeof command.toolCallId !== "string") return command;
  const result = toolResults.find((r) => r.tool === command.toolCallId);
  if (!result || typeof result.isError !== "boolean") return command;
  return { ...command, exitCode: result.isError ? 1 : 0 };
}

/**
 * 检查 requireCommands：每个命令必须在 command 证据里出现且 exitCode===0。
 * 包含匹配（因 runtime 可能包装命令，如 "npm test --verbose"）。
 */
function checkCommandsPassed(requireCommands, commands) {
  const missing = [];
  const failed = [];
  for (const required of requireCommands) {
    const matched = commands.find((c) =>
      typeof c.command === "string" && c.command.includes(required),
    );
    if (!matched) {
      missing.push(required);
    } else if (matched.exitCode !== 0) {
      failed.push(`${required} (exitCode=${matched.exitCode ?? "undefined"})`);
    }
  }
  const passed = missing.length === 0 && failed.length === 0;
  const details = [];
  if (missing.length > 0) details.push(`not executed: ${missing.join(", ")}`);
  if (failed.length > 0) details.push(`failed (exitCode!=0): ${failed.join(", ")}`);
  return {
    name: "commandsPassed",
    passed,
    evidence: `${commands.length} command(s) recorded`,
    ...(passed ? {} : { detail: details.join("; ") }),
  };
}

/**
 * 检查 requireFiles：每个文件 file_written 证据（首选）或磁盘存在（fallback）即通过。
 * 方案A（2026-06-25）：codex 有时用 command_execution（shell）写文件，不 emit file_written
 * 事件。原逻辑无 file_written 直接判 missing（即使磁盘有文件）→ 误判 codex 任务失败。
 * 现改为：无 file_written 证据时，fallback 查磁盘——文件在 cwd 存在就算通过（任务真完成了）。
 */
async function checkFilesExist(requireFiles, fileEvents, cwd) {
  const missing = [];
  const notOnDisk = [];
  const onDiskOnly = []; // 方案A：无证据但磁盘存在的文件（记录来源，审计用）
  for (const required of requireFiles) {
    // 路径匹配要灵活：runtime 可能传绝对路径（claude Write 工具），
    // 而 requireFiles 里可能是相对路径。用尾部匹配兼容（同 command 的包含匹配逻辑）。
    const declared = fileEvents.find(
      (f) => typeof f.path === "string" && pathMatches(f.path, required),
    );
    if (!declared) {
      // 方案A fallback：无 file_written 证据时查磁盘。codex 用 command 写文件时证据缺失，
      // 但文件真实写了（磁盘存在）→ 算通过。文件既无证据又不在磁盘才判 missing。
      try {
        await stat(resolve(cwd, required));
        onDiskOnly.push(required); // 磁盘存在但无证据——通过，但记录审计
        continue;
      } catch {
        missing.push(required);
        continue;
      }
    }
    // 文件存在检查：优先用 file_written 事件里的真实路径（绝对或相对），
    // 再 fallback 到 cwd 拼接 required。
    const checkPath = isAbsolute(declared.path) ? declared.path : resolve(cwd, declared.path);
    try {
      await stat(checkPath);
    } catch {
      notOnDisk.push(required);
    }
  }
  const passed = missing.length === 0 && notOnDisk.length === 0;
  const details = [];
  if (missing.length > 0) details.push(`not written: ${missing.join(", ")}`);
  if (notOnDisk.length > 0) details.push(`written but missing on disk: ${notOnDisk.join(", ")}`);
  if (onDiskOnly.length > 0) details.push(`exists on disk, no file_written evidence: ${onDiskOnly.join(", ")}`);
  return {
    name: "filesExist",
    passed,
    evidence: `${fileEvents.length} file_written event(s) recorded`,
    ...(passed ? {} : { detail: details.join("; ") }),
  };
}

/**
 * 路径匹配：精确匹配 OR 尾部匹配（兼容绝对路径 vs 相对路径）。
 * 规范化分隔符后比较（Windows 下 file_written 可能是反斜杠）。
 */
function pathMatches(actual, required) {
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = norm(actual);
  const r = norm(required);
  if (a === r) return true;
  // 尾部匹配：required 是 actual 的后缀（如 required="out.js", actual="D:/proj/out.js"）
  return a.endsWith("/" + r);
}
