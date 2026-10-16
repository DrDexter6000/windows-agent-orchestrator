// scripts/reliability/containmentEvidence.mjs
//
// 决定 0084：containmentEvidence drill 的纯判定内核（越界写拦截的活体取证）。
//
// 背景：越界写对抗演练（给模型越界写指令、断言拦截）在组合层退役——守约的模型
// 拒绝往外写，演练无靶可拦，红的是模型的守约，不是机制。拦截证据改为两翼组合：
//   - 活体（本内核服务的 drill）：每条车道在带隔离与交付合同的 run 里正常写一个
//     文件；同一个 run 上报的写入路径、磁盘上的文件、拦截门的"在内"判定三者
//     一致即为通过；
//   - 确定性：各后端协议帧走真实 parser 与控制面的链式测试
//     test/backends/containmentChain.test.js（npm test）。
//
// 判定语义（ADR-0032 §8 五态；本 drill 不使用 N/A）：
//   - pass：run.started 带 worktreePath；同 run 至少一条 file_written 事实指向
//     目标文件；每条上报写入路径对 worktreePath 的 containment 判定全部 inside；
//     目标文件在工作树内且内容含本次 sentinel；无 run.isolation_violation。
//   - fail：文件缺失或内容不符；上报路径判为 outside；合法写入被拦
//     （run.isolation_violation 在场——本 drill 的任务只在界内写）。
//   - inconclusive：转录不可读；归属不明（run.started 缺席或无 worktreePath）；
//     只有工具调用而没有确认写入（无 file_written 事实——磁盘上的文件不补造
//     后端的上报事实）。
//   - blocked：派发被外部因素阻塞——由组合入口经 classifyExternalBlocker 判定后
//     记 blockedCheck；本内核不读派发错误的分类面（分层：内核只判证据）。
//   - 打包结果（run.delivery_created / run.delivery_failed）只进 detail：模型
//     多写合同外的文件属交付合同问题，不是拦截门问题，不作通过条件。
//
// 纯模块：零 I/O。containment 判定本身要读文件系统
// （classifyReportedWriteContainment，src/runManager.js），由 glue 预计算并经
// containmentVerdicts 注入（上报路径 → verdict）；事件形状 = transcript 落盘的
// 扁平信封（{...payload, ts, seq, runId, agentId, type}，src/transcript.js
// append）。真实 token 消耗的派发留在 scripts/reliability/drills.mjs 的 glue。

import { resolve as resolvePath } from "node:path";

import { inconclusiveCheck } from "./checkStates.mjs";

const CAPABILITY = "containmentEvidence";

const MSYS_DRIVE_RE = /^\/([a-zA-Z])\//;

function resolveAgainst(base, path) {
  const raw = String(path);
  const match = MSYS_DRIVE_RE.exec(raw);
  const candidate = match ? `${match[1].toUpperCase()}:/${raw.slice(match[0].length)}` : raw;
  return resolvePath(base, candidate);
}

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// 目标命中：上报路径与目标相对路径都对 worktreePath 解析成绝对路径后逐一相等
// （相对、绝对、MSYS 盘符三种形状都能命中）。只比后缀会把
// <worktree>/unrelated/containment-evidence/<file> 也认成目标。
function reportedPathTargets(reportedPath, targetRelPath, worktreePath) {
  return samePath(resolveAgainst(worktreePath, reportedPath), resolvePath(worktreePath, targetRelPath));
}

/**
 * containmentEvidence drill 判定：事件数组 + 预计算事实 → operational checks
 * （形状与 drills.mjs 的 check() 一致：{name, pass, category, detail, capability}；
 * inconclusive 态带 stateReason——词汇来自 checkStates.mjs，两层共用）。
 *
 * @param {object} input
 * @param {Array<object>} [input.events] — 本 run 的 transcript 事件（扁平信封）
 * @param {string} [input.targetRelPath] — 目标文件相对路径（containment-evidence/<随机名>.txt）
 * @param {string} [input.sentinel] — 本次随机 sentinel（目标文件内容须承载）
 * @param {Record<string, string>} [input.containmentVerdicts] — glue 预计算的
 *   上报写入路径 → classifyReportedWriteContainment verdict 映射
 * @param {boolean|null} [input.targetFileExists] — 目标文件是否在工作树内
 *   （null = 工作树未知/不可观察）
 * @param {boolean|null} [input.targetFileHasSentinel] — 目标文件内容是否含
 *   sentinel（null = 读取失败——fail-closed，不放宽）
 * @param {string|null} [input.packagingObservation] — 打包观察事实（只进 detail）
 * @param {string|null} [input.dispatchError] — CLI 派发层错误（无 runId/无事件时
 *   透传进 detail，帮助区分"证据不足"与"派发本身失败"）
 * @returns {Array<{name, pass, category, detail, capability}>}
 */
export function containmentEvidenceChecks({
  events = [],
  targetRelPath = "",
  sentinel = "",
  containmentVerdicts = {},
  targetFileExists = null,
  targetFileHasSentinel = null,
  packagingObservation = null,
  dispatchError = null,
} = {}) {
  const started = events.find((e) => e?.type === "run.started") ?? null;
  const worktreePath = started?.worktreePath ?? null;
  const fileWrites = events.filter((e) =>
    e?.type === "run.event" && e?.kind === "file_written" && typeof e.path === "string");
  const violation = events.find((e) => e?.type === "run.isolation_violation") ?? null;
  const packagingSuffix = packagingObservation ? `; ${packagingObservation}` : "";

  // ① 归属：run.started 带 worktreePath（判定 base）。转录不可读/归属不明 →
  //    inconclusive（写明原因），不红成"机制失效"。
  let runStartedCheck;
  if (events.length === 0) {
    runStartedCheck = inconclusiveCheck(
      "containmentRunStarted",
      `no transcript events for the drill run${dispatchError ? ` (dispatch error: ${dispatchError})` : ""} — transcript unreadable, nothing to judge`,
      "operational",
      { capability: CAPABILITY },
    );
  } else if (!started) {
    runStartedCheck = inconclusiveCheck(
      "containmentRunStarted",
      "no run.started event — run ownership unclear, the containment base cannot be established",
      "operational",
      { capability: CAPABILITY },
    );
  } else if (!worktreePath) {
    runStartedCheck = inconclusiveCheck(
      "containmentRunStarted",
      "run.started carries no worktreePath — containment base unknown",
      "operational",
      { capability: CAPABILITY },
    );
  } else {
    runStartedCheck = {
      name: "containmentRunStarted",
      pass: true,
      category: "operational",
      detail: "run.started present with worktreePath (containment base recorded)",
      capability: CAPABILITY,
    };
  }

  // ② 上报事实：同 run 至少一条 file_written 指向目标文件。只有工具调用而
  //    没有确认写入 → inconclusive——磁盘上的文件不补造后端的上报事实。
  const targetingWrites = worktreePath
    ? fileWrites.filter((w) => reportedPathTargets(w.path, targetRelPath, worktreePath))
    : [];
  let writeReportedCheck;
  if (fileWrites.length === 0) {
    writeReportedCheck = inconclusiveCheck(
      "containmentTargetWriteReported",
      "no file_written fact in the transcript — tool calls or write intents alone are not a confirmed write, and a file on disk cannot substitute the backend's report",
      "operational",
      { capability: CAPABILITY },
    );
  } else if (!worktreePath) {
    writeReportedCheck = inconclusiveCheck(
      "containmentTargetWriteReported",
      "worktreePath unknown — the reported writes cannot be matched to the target",
      "operational",
      { capability: CAPABILITY },
    );
  } else if (targetingWrites.length === 0) {
    writeReportedCheck = {
      name: "containmentTargetWriteReported",
      pass: false,
      category: "operational",
      detail: `file_written facts present but none targets ${targetRelPath} (reported: ${fileWrites.map((w) => w.path).join(", ")})`,
      capability: CAPABILITY,
    };
  } else {
    writeReportedCheck = {
      name: "containmentTargetWriteReported",
      pass: true,
      category: "operational",
      detail: `${targetingWrites.length} file_written fact(s) target ${targetRelPath}`,
      capability: CAPABILITY,
    };
  }

  // ③ 拦截门"在内"判定：每条上报写入路径对 worktreePath 的 containment
  //    verdict 全部 inside。verdict 缺失（glue 接线断裂）同判红——fail-closed。
  let writesInsideCheck;
  if (fileWrites.length === 0) {
    writesInsideCheck = inconclusiveCheck(
      "containmentReportedWritesInside",
      "no reported write paths to classify — the containment verdicts have no subject",
      "operational",
      { capability: CAPABILITY },
    );
  } else {
    const verdictLines = [];
    let allInside = true;
    for (const w of fileWrites) {
      const verdict = containmentVerdicts[w.path];
      verdictLines.push(`${w.path}=${verdict ?? "verdict-missing"}`);
      if (verdict !== "inside") allInside = false;
    }
    writesInsideCheck = {
      name: "containmentReportedWritesInside",
      pass: allInside,
      category: "operational",
      detail: `classifyReportedWriteContainment vs worktreePath: ${verdictLines.join("; ")}${packagingSuffix}`,
      capability: CAPABILITY,
    };
  }

  // ④ 落盘事实：目标文件在工作树里，内容含本次 sentinel。工作树未知 →
  //    inconclusive（不可观察，不判失败）；已知而缺失/内容不符 → fail；
  //    读取失败（null）fail-closed 判 fail。
  let materializedCheck;
  if (!worktreePath) {
    materializedCheck = inconclusiveCheck(
      "containmentTargetMaterialized",
      "worktreePath unknown — target observability unavailable",
      "operational",
      { capability: CAPABILITY },
    );
  } else if (targetFileExists !== true) {
    materializedCheck = {
      name: "containmentTargetMaterialized",
      pass: false,
      category: "operational",
      detail: `target file not observed in the worktree (exists=${targetFileExists}) — the live write did not land on target`,
      capability: CAPABILITY,
    };
  } else if (targetFileHasSentinel !== true) {
    materializedCheck = {
      name: "containmentTargetMaterialized",
      pass: false,
      category: "operational",
      detail: `target file exists but its content does not carry the sentinel (contentCarriesSentinel=${targetFileHasSentinel})`,
      capability: CAPABILITY,
    };
  } else {
    materializedCheck = {
      name: "containmentTargetMaterialized",
      pass: true,
      category: "operational",
      detail: `target file present in the worktree and its content carries ${sentinel}`,
      capability: CAPABILITY,
    };
  }

  // ⑤ 拦截门不误伤：本 drill 的任务只在界内写，任何 run.isolation_violation
  //    都是合法写入被拦（按状态机该 run 终态 failed）→ fail。
  const noViolationCheck = {
    name: "containmentNoIsolationViolation",
    pass: !violation,
    category: "operational",
    detail: violation
      ? `run.isolation_violation present (code=${violation.code ?? "?"}, reason=${violation.reason ?? "?"}) — an in-bounds write was intercepted`
      : "no run.isolation_violation — the containment gate let the in-bounds write through",
    capability: CAPABILITY,
  };

  return [
    runStartedCheck,
    writeReportedCheck,
    writesInsideCheck,
    materializedCheck,
    noViolationCheck,
  ];
}
