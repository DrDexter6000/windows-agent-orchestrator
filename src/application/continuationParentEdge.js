// src/application/continuationParentEdge.js
//
// 第 120 批续修（审查 D2）：续修父边判定的唯一实现，从 runDeliveryReview.js 抽到
// 依赖更低的 application 模块——`runDelivery.js` → `lineageSupersession.js` →
// 本模块，不再经由 `runDeliveryReview.js`（后者导入 `runDelivery.js`，会成环）。
//
// 只认一条已证明的父边（决定 0116 的 `--since-parent` 与本批的"被取代"派生共用）：
//   - 子运行转录里 runId 绑定的 `run.background_submitted`、`continuation:true`、
//     合法 parentRunId/rootRunId，且必须是该转录的第一条事件（runContinue 第 15
//     步在 spawn 之前写它；之后追加的续修事实一律当伪造，拒为"没有父运行"）；
//   - 恰好一条才算（重复/冲突 → ambiguous）；
//   - 子运行自己的 `run.session_reuse` 谱系根必须等于事实根（决定 0112 SSOT）；
//   - 父转录可读；
//   - 调用方给了授权根时，父 run 必须属于该根（`--since-parent` 的归属门）；
//   - 父运行自己的谱系根必须等于事实根。
// 复用槽的 `priorRunId` 不是交付父边，这里从不读取它。
//
// 拒绝文案是闭集固定英文。六条 `--since-parent` 拒绝里有四条在本模块（父事实
// 缺失 / 歧义 / 跨工作区 / 谱系不一致），另两条（父无已证明交付、本轮无增量）
// 留在 runDeliveryReview.js 的父交付证明里，由
// `sinceParentRejection` 打上 `waoSinceParentRejection` 标记，供 CLI `--all`
// 适配层原样透出、其余异常照旧折叠成固定失败文案。行为与文案逐字节保持不变。

import { readTranscript } from "../transcript.js";
import { resolveTranscriptPath } from "../projectBuckets.js";
import { isValidRunId } from "../delivery.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";
import { continuableLineageFact } from "./runContinue.js";

export const SINCE_PARENT_NO_PARENT_TEXT =
  "--since-parent is only available for a continuation child run: no bound parent run fact";
export const SINCE_PARENT_AMBIGUOUS_TEXT =
  "--since-parent rejected: ambiguous continuation facts (expected exactly one bound run.background_submitted continuation fact)";
export const SINCE_PARENT_WORKSPACE_TEXT =
  "--since-parent rejected: the parent run does not belong to the authorized workspace";
export const SINCE_PARENT_LINEAGE_TEXT =
  "--since-parent rejected: lineage mismatch (rootRunId does not match the parent lineage)";

/**
 * Closed-set marker on the fixed --since-parent rejection errors, so the CLI
 * --all adapter can surface exactly these fixed texts while folding every
 * OTHER unexpected exception into the generic review failure copy.
 * @param {string} text
 * @returns {Error}
 */
export function sinceParentRejection(text) {
  const error = new Error(text);
  error.waoSinceParentRejection = true;
  return error;
}

/**
 * Count the runId-BOUND run.background_submitted continuation facts. Shared by
 * the getRunDeliveryReview gate (so a duplicated fact is classified as the
 * closed-set ambiguity rejection BEFORE the workspace-ownership verifier would
 * reject the same transcript for a less specific reason) and by
 * resolveContinuationParentEdge (the authoritative shape checks).
 * @param {object[]} events
 * @param {string} runId
 * @returns {object[]}
 */
export function continuationFactCandidates(events, runId) {
  const candidates = [];
  for (const e of events) {
    if (!e || e.runId !== runId) continue;
    if (e.type !== "run.background_submitted" || e.continuation !== true) continue;
    candidates.push(e);
  }
  return candidates;
}

/**
 * Resolve the PROVEN parent edge for a continuation child run.
 *
 * @param {object} input
 * @param {string} input.runId — the child run id (facts are read bound to it)
 * @param {object[]} input.events — the child transcript snapshot
 * @param {string} input.runDir
 * @param {string} [input.authorizedWorkspaceRoot] — when supplied, the parent
 *   must belong to it (the `--since-parent` gate); the "被取代" derivation has
 *   no caller authorization root and omits it
 * @param {Function} [input.readTranscriptFn] — path reader (default: readTranscript)
 * @param {Function} [input.readParentEventsFn] — (runDir, parentRunId) => events[]|null;
 *   overrides the parent read (lineageSupersession reads through its own
 *   archive-aware file index). Throw/null = parent transcript unreadable.
 * @returns {Promise<{parentRunId: string, rootRunId: string, parentEvents: object[]}>}
 * @throws {Error} sinceParentRejection (closed-set fixed text)
 */
export async function resolveContinuationParentEdge({
  runId, events, runDir, authorizedWorkspaceRoot, readTranscriptFn, readParentEventsFn,
}) {
  // 1. The continuation fact: runId-BOUND run.background_submitted with
  //    continuation:true — count them ALL; exactly one is acceptable.
  //    run.started parent fields are never a fact source. AND that fact must
  //    be THIS run's FIRST transcript event: runContinue step 15 writes it
  //    before anything else (before the runner starts), so a continuation
  //    fact appended later — a foreground run, or an ordinary background
  //    dispatch — is a forgery, refused as "no parent run".
  const candidates = continuationFactCandidates(events, runId);
  if (candidates.length > 1) {
    throw sinceParentRejection(SINCE_PARENT_AMBIGUOUS_TEXT);
  }
  const factEvent = candidates[0];
  if (!factEvent
    || events[0] !== factEvent
    || typeof factEvent.parentRunId !== "string" || !isValidRunId(factEvent.parentRunId)
    || typeof factEvent.rootRunId !== "string" || !isValidRunId(factEvent.rootRunId)
    || factEvent.parentRunId === runId) {
    throw sinceParentRejection(SINCE_PARENT_NO_PARENT_TEXT);
  }
  const fact = { parentRunId: factEvent.parentRunId, rootRunId: factEvent.rootRunId };

  // 2. The child's own lineage fact must agree: the continuation fact's
  //    rootRunId must equal the root of THIS run's bound run.session_reuse
  //    (decision 0112 SSOT — no second membership algorithm).
  const childLineage = continuableLineageFact(events, runId);
  if (!childLineage || childLineage.rootRunId !== fact.rootRunId) {
    throw sinceParentRejection(SINCE_PARENT_LINEAGE_TEXT);
  }

  // 3. Read the parent transcript (unreadable/malformed = no parent run).
  let parentEvents;
  if (typeof readParentEventsFn === "function") {
    try {
      parentEvents = await readParentEventsFn(runDir, fact.parentRunId);
    } catch {
      throw sinceParentRejection(SINCE_PARENT_NO_PARENT_TEXT);
    }
  } else {
    try {
      parentEvents = await (readTranscriptFn ?? readTranscript)(
        resolveTranscriptPath(runDir, fact.parentRunId),
      );
    } catch {
      throw sinceParentRejection(SINCE_PARENT_NO_PARENT_TEXT);
    }
  }
  if (!Array.isArray(parentEvents)) {
    throw sinceParentRejection(SINCE_PARENT_NO_PARENT_TEXT);
  }

  // 4. The parent must belong to the SAME authorized workspace (before any
  //    Git proof, same gate order as the child). Only when the caller supplied
  //    an authorization root — the derivation path has none.
  if (authorizedWorkspaceRoot !== undefined) {
    try {
      verifyRunWorkspaceOwnership(parentEvents, authorizedWorkspaceRoot, fact.parentRunId);
    } catch {
      throw sinceParentRejection(SINCE_PARENT_WORKSPACE_TEXT);
    }
  }

  // 5. The parent must be a member of the SAME lineage (its own lineage root
  //    equals the fact's rootRunId — a root run satisfies this trivially).
  const parentLineage = continuableLineageFact(parentEvents, fact.parentRunId);
  if (!parentLineage || parentLineage.rootRunId !== fact.rootRunId) {
    throw sinceParentRejection(SINCE_PARENT_LINEAGE_TEXT);
  }
  return { parentRunId: fact.parentRunId, rootRunId: fact.rootRunId, parentEvents };
}
