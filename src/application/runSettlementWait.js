// src/application/runSettlementWait.js
//
// 决定 0095/0096：收口等待器的轮询循环——CLI `runs wait <runId> --until-settled`
// 与 `consult wait <consultId> --until-settled`（逐席调用）共用的**同一**算法。
// 从 src/commands/runs.js 原样上移（2026-11 批：consult --until-settled 需要
// 复用，命令面各自保留自己的渲染与退出码）。
//
// 本模块只负责"等到收口/判死/冲突/中断"这件事：轮询、不可信轮计数、收口后再
// 解析确认、终态等验证的验证者缺席证明（0096 节流）、进度行节流。它不做任何
// 渲染决策、不设 process.exitCode、不碰 process 信号——输出与中断归调用面
//（progress / isInterrupted 注入；SIGINT 注册留在 commands 层，daemon 握手
// 读器同样由 commands 层注入——application 层不得 import daemon.js）。
//
// Architectural contract:
//   - No argv parsing, no console.log/error（进度经注入的 progress 输出）,
//     no process.exit / process.exitCode / process.on.
//   - 收口判定复用 determineRunSettlement（runSettlement.js）——不复制判定。
//   - daemon 握手读器不在本层：verifierProofDeps 原样透传给 verifierGoneFn，
//     缺注入 = 接线错误，由 proveVerifierGone 响亮失败（循环照旧当探测失败，
//     不构成死亡证明）。

import { readTranscript } from "../transcript.js";
import { resolveTranscriptPathDetailed } from "../projectBuckets.js";
import { boundReportScope } from "../metrics.js";
import { determineRunSettlement } from "./runSettlement.js";
import { proveVerifierGone } from "./runSettle.js";
import { runWaitNextStep } from "./runNextStep.js";
import { vitalSignAgeMs, LEAD_ADVISORY_QUIET_SECONDS } from "./runQuietAdvisory.js";

// 决定 0095：轮询参数。间隔 15 秒；不可信轮连续 4 次退出 3；持久冲突立即退出 4；
// SIGINT 退出 130。不设总时长。可信未收口轮的进度行只在首轮、状态或原因变化、
// 不可信轮之后，以及距上一行满 5 分钟时打印：宿主常把命令的整段输出交给模型，
// 逐轮一行（每小时 240 行）只是白耗上下文。
// 决定 0096：终态等验证的轮每 5 分钟至多证明一次验证者已不在；证明成立后重新
// 解析、重读、再判一次：已收口照常退出 0，仍等验证才退出 3。
export const SETTLEMENT_POLL_INTERVAL_MS = 15000;
export const SETTLEMENT_MAX_UNTRUSTED_ROUNDS = 4;
export const SETTLEMENT_PROGRESS_EVERY_MS = 5 * 60 * 1000;
export const SETTLEMENT_VERIFIER_PROOF_EVERY_MS = 5 * 60 * 1000;

/**
 * 等一个运行收口（只读：不改任何状态、不停 worker、不设总时长；永不沿用旧快照
 * 报收口）。每轮串行：解析路径 → 读一份新快照 → 收口判定 + 生命体征 → 进度行
 *（节流，见上方常量）；轮与轮之间 sleep，不重叠。
 *
 * 可信轮 = 解析 found、无冲突，快照读取成功，判定不是 undeterminable；只有
 * 可信轮把不可信计数清零。判定 settled 后再解析一次，路径或冲突状态变了算
 * 不可信轮继续，不变才返回 settled。
 *
 * 决定 0096：可信、终态 completed 且 reason 为 verification_pending 的轮，先
 * 证明验证者已不在（节流 5 分钟；证明本身只读）。成立后重新解析、重读、再判
 * 一次收口：已收口返回 settled；仍等验证则照收口出口再解析一次——冲突返回
 * conflict，解析变了算不可信轮，不变才返回 verifier_gone；重读的解析/读取失败
 * 照原有规则算不可信轮。证明被拒的理由并入本轮进度行明细并参与节流键。
 *
 * 返回闭集 outcome（kind 成员与退出码的映射归调用面——runs wait / consult wait
 * 各自同义映射）：
 *   { kind: "settled", settlement, snapshotReadAt, events }
 *   { kind: "verifier_gone", settlement, basis, snapshotReadAt, events }
 *   { kind: "conflict", settlement, snapshotReadAt, events }
 *   { kind: "untrusted", reason, rounds, settlement, snapshotReadAt, events }
 *   { kind: "interrupted", settlement, snapshotReadAt, events }
 * settlement 是最近一次收口判定（可能为 null——一次判定都没发生过就中断时），
 * 供调用面的中断/无法判定输出带运行状态；snapshotReadAt 是最后一次成功读快照
 * 的时刻（ms；从未读到为 null）；events 是最后一次成功读到的快照事件（决定
 * 0112 起附带，可能为 null——从未读到过），供调用面在同一份快照上做附加判定
 *（runs wait 的可续提示）——绝不另读一份新快照去替代它。
 *
 * @param {object} input
 * @param {string} input.runId
 * @param {string} input.runDir
 * @param {string} [input.label="runs wait"] — 进度行前缀（[<label>] round N: …）
 * @param {Function} [input.progress] — 进度行出口（文本面通常 stdout，JSON 面
 *   通常 stderr；由调用面决定）
 * @param {Function} [input.isInterrupted] — 每轮顶部与打印前询问；返回 true 即
 *   以 interrupted 收口（单一出口：已判收口的一轮也会被它覆盖）
 * @param {object} [input.deps] — { pollIntervalMs, resolveDetailedFn,
 *   readTranscriptFn, nowFn, sleepFn, verifierGoneFn, verifierProofDeps } 测试
 *   确定性注入缝
 * @returns {Promise<object>} 闭集 outcome（见上）
 */
export async function waitRunSettlement({
  runId,
  runDir,
  label = "runs wait",
  progress = () => {},
  isInterrupted = () => false,
  deps = {},
}) {
  const pollIntervalMs = deps.pollIntervalMs ?? SETTLEMENT_POLL_INTERVAL_MS;
  const resolveDetailedFn = deps.resolveDetailedFn ?? resolveTranscriptPathDetailed;
  const readTranscriptFn = deps.readTranscriptFn ?? readTranscript;
  const nowFn = deps.nowFn ?? Date.now;
  const sleepFn = deps.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  // 决定 0096：验证者已不在的证明。daemon 握手 SSOT 在 adapters 层（daemon.js），
  // 由调用面注入；其余读器与 settle 同一套，测试可经 verifierProofDeps 覆写。
  const verifierGoneFn = deps.verifierGoneFn ?? proveVerifierGone;
  const verifierProofDeps = {
    nowFn,
    ...(deps.verifierProofDeps ?? {}),
  };
  let lastVerifierProofAt = null;
  // 建议（会审）：证明被拒的理由并入进度行明细与节流键——sticky 到下一次证明
  // 给出新理由；理由变化立即打印一行，不变时仍按 5 分钟节流。不回显 pid、路径
  // 与命令行。
  let lastProofRefusal = null;

  // 可信未收口轮的进度节流（见上方常量）。不可信轮每轮都打，打过之后下一个
  // 可信轮无条件再打一行。
  let lastProgressKey = null;
  let lastProgressAt = null;
  const untrustedProgress = (line) => {
    progress(line);
    lastProgressKey = null;
  };

  // 单一 outcome：循环里每条路径只赋值一次并 break；函数末尾统一输出一份。
  let outcome = null;
  let lastSettlement = null;
  let lastSnapshotReadAt = null;
  let lastEventsRead = null;
  let lastUntrustedReason = null;

  const safeResolve = () => {
    try {
      return resolveDetailedFn(runDir, runId);
    } catch {
      // 解析链自身的意外 I/O 错误：按不可信轮处理（不当冲突、不当收口）。
      return { path: null, found: false, conflict: false };
    }
  };

  let untrustedRounds = 0;
  // 不可信轮的唯一记账点（进度行文案与计数口径不变）。
  const markUntrusted = (round, reason, text) => {
    untrustedRounds += 1;
    lastUntrustedReason = reason;
    if (!isInterrupted()) {
      untrustedProgress(`[${label}] round ${round}: ${runId} ${text} (untrusted ${untrustedRounds}/${SETTLEMENT_MAX_UNTRUSTED_ROUNDS})`);
    }
  };
  // 读一份快照：成功返回事件数组并记下读取时刻与事件本体（决定 0112：供调用
  // 面在同一份快照上做附加判定）；失败返回 null（调用方按原有规则算不可信轮）。
  const readSnapshot = async (resolution) => {
    try {
      const events = await readTranscriptFn(resolution.path);
      lastSnapshotReadAt = nowFn();
      lastEventsRead = events;
      return events;
    } catch {
      return null;
    }
  };
  for (let round = 1; ; round += 1) {
    if (isInterrupted()) {
      outcome = { kind: "interrupted" };
      break;
    }
    const resolution = safeResolve();
    if (resolution.conflict) {
      outcome = { kind: "conflict" };
      break;
    }
    if (!resolution.found) {
      const [reason, text] = resolution.unreadable
        ? ["copy_unreadable", "transcript copy unreadable (one of several copies failed to hash)"]
        : ["not_found", "transcript not found"];
      markUntrusted(round, reason, text);
    } else {
      const events = await readSnapshot(resolution);
      if (events === null) {
        markUntrusted(round, "snapshot_read_failed", "snapshot read failed");
      } else {
        let settlement = determineRunSettlement(events, runId);
        lastSettlement = settlement;
        if (settlement.status === "undeterminable") {
          markUntrusted(round, `undeterminable:${settlement.reason}`, `settlement undeterminable (${settlement.reason})`);
        } else if (settlement.status === "settled") {
          // 收口判定后再解析一次：路径或冲突状态变了 → 不可信轮继续。
          const confirm = safeResolve();
          if (confirm.conflict || !confirm.found || confirm.path !== resolution.path) {
            markUntrusted(round, "resolution_changed_after_settled", "settled but transcript resolution changed; continuing");
          } else {
            outcome = { kind: "settled", settlement };
            break;
          }
        } else {
          // 可信轮（未收口）：清零不可信计数；进度行按节流规则打印。非终态且转录
          // 满 30 分钟未见新体征时，体征部分换成安静提示（runs settle / stop 两个
          // 出口，只在 Lead 决定时用）。终态等验证的轮不报体征；证明验证者已不在
          // 之后仍等验证才退出 3（见下）。
          untrustedRounds = 0;
          let progressAllowed = true;
          // 进度行的体征取自本轮判定所用的快照——证明后的重读改判时用新快照，
          // 不用首次的 events。
          let progressEvents = events;
          if (settlement.facts.terminal && settlement.reason === "verification_pending") {
            // 决定 0096：终态 completed、验证显式 pending、无结果、无 reverify——
            // 后台验证者可能已经不在了。节流：同一等待器 5 分钟至多证明一次。
            const proofNow = nowFn();
            const proofDue = lastVerifierProofAt === null
              || proofNow - lastVerifierProofAt >= SETTLEMENT_VERIFIER_PROOF_EVERY_MS;
            if (proofDue) {
              lastVerifierProofAt = proofNow;
              let proof;
              try {
                proof = await verifierGoneFn({ events, runId, runDir, deps: verifierProofDeps });
              } catch {
                proof = null; // 探测自身的意外失败不构成死亡证明：继续等
              }
              if (proof?.gone === false && typeof proof.refusal === "string") {
                lastProofRefusal = proof.refusal;
              }
              if (proof?.gone === true) {
                lastProofRefusal = null; // 最新一次证明已成立，旧拒收理由不再挂着
                // 证明成立：重新解析、重读、再判一次收口。解析变更/读取失败按
                // 原有规则算不可信轮——绝不把旧快照当成仍 pending。
                const reResolution = safeResolve();
                if (reResolution.conflict) {
                  outcome = { kind: "conflict" };
                  break;
                }
                if (!reResolution.found) {
                  const [reason, text] = reResolution.unreadable
                    ? ["copy_unreadable", "transcript copy unreadable (one of several copies failed to hash)"]
                    : ["not_found", "transcript not found"];
                  markUntrusted(round, reason, text);
                  progressAllowed = false;
                } else {
                  const reEvents = await readSnapshot(reResolution);
                  if (reEvents === null) {
                    markUntrusted(round, "snapshot_read_failed", "snapshot read failed");
                    progressAllowed = false;
                  } else {
                    const reSettlement = determineRunSettlement(reEvents, runId);
                    lastSettlement = reSettlement;
                    if (reSettlement.status === "undeterminable") {
                      markUntrusted(round, `undeterminable:${reSettlement.reason}`, `settlement undeterminable (${reSettlement.reason})`);
                      progressAllowed = false;
                    } else if (reSettlement.status === "settled") {
                      // 与既有收口出口同一确认：收口后再解析一次。
                      const confirm = safeResolve();
                      if (confirm.conflict || !confirm.found || confirm.path !== reResolution.path) {
                        markUntrusted(round, "resolution_changed_after_settled", "settled but transcript resolution changed; continuing");
                        progressAllowed = false;
                      } else {
                        outcome = { kind: "settled", settlement: reSettlement };
                        break;
                      }
                    } else if (reSettlement.facts.terminal && reSettlement.reason === "verification_pending") {
                      // 重读仍是终态等验证：照"已收口"那一支再解析一次——冲突
                      // 立即返回 conflict；路径变了/未找到算不可信轮继续；不变才
                      // 返回 verifier_gone。
                      const confirm = safeResolve();
                      if (confirm.conflict) {
                        outcome = { kind: "conflict" };
                        break;
                      }
                      if (!confirm.found || confirm.path !== reResolution.path) {
                        markUntrusted(round, "resolution_changed_after_verifier_gone", "verifier proven gone but transcript resolution changed; continuing");
                        progressAllowed = false;
                      } else {
                        outcome = { kind: "verifier_gone", settlement: reSettlement, basis: proof.basis };
                        break;
                      }
                    } else {
                      // 重读后是别的可信未收口形态（例如结果已落、reverify 又
                      // pending）：照常等待，进度行按新判定与新快照打印。
                      settlement = reSettlement;
                      progressEvents = reEvents;
                    }
                  }
                }
              }
            }
          }
          const now = nowFn();
          // 拒收理由注脚只在"终态等验证"的形态上挂着（sticky：直到下一次证明
          // 给出新理由或形态离开）；形态离开即清，复活等别的形态不带旧注脚。
          const stillPendingShape = settlement.facts.terminal && settlement.reason === "verification_pending";
          if (!stillPendingShape) lastProofRefusal = null;
          const proofNote = stillPendingShape && lastProofRefusal !== null
            ? `; verifier proof: ${lastProofRefusal}`
            : "";
          let detail = `; delivery state: wao runs delivery ${runId}${proofNote}`;
          let quiet = false;
          if (!settlement.facts.terminal) {
            const ageMs = vitalSignAgeMs(boundReportScope(progressEvents, runId) ?? progressEvents, now);
            quiet = ageMs !== null && ageMs >= LEAD_ADVISORY_QUIET_SECONDS * 1000;
            detail = ageMs === null
              ? `; vital sign age unknown${proofNote}`
              : quiet
                ? `; ${runWaitNextStep({ surface: "cli", terminal: false, vitalSignAgeMs: ageMs, runId })}${proofNote}`
                : `; last vital sign ${Math.floor(ageMs / 60000)} min ago${proofNote}`;
          }
          const progressKey = `${settlement.facts.state}|${settlement.reason}|${quiet}|${proofNote}`;
          if (progressAllowed && !isInterrupted() && (progressKey !== lastProgressKey || lastProgressAt === null
            || now - lastProgressAt >= SETTLEMENT_PROGRESS_EVERY_MS)) {
            progress(`[${label}] round ${round}: ${runId} state=${settlement.facts.state} not settled (${settlement.reason})${detail}`);
            lastProgressKey = progressKey;
            lastProgressAt = now;
          }
        }
      }
    }
    if (untrustedRounds >= SETTLEMENT_MAX_UNTRUSTED_ROUNDS) {
      outcome = { kind: "untrusted", reason: lastUntrustedReason, rounds: untrustedRounds };
      break;
    }
    // 轮与轮之间 sleep（不重叠）；中断置位后 sleep 照常结束，循环顶部退出。
    await sleepFn(pollIntervalMs);
  }

  return {
    kind: outcome.kind,
    settlement: outcome.settlement ?? lastSettlement,
    snapshotReadAt: lastSnapshotReadAt,
    // 决定 0112：最后一次成功读到的快照事件（可能为 null——从未读到过）。
    events: lastEventsRead,
    ...(outcome.kind === "untrusted" ? { reason: outcome.reason, rounds: outcome.rounds } : {}),
    ...(outcome.kind === "verifier_gone" ? { basis: outcome.basis } : {}),
  };
}
