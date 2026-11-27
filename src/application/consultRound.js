// src/application/consultRound.js
//
// 第 155 批（台账 TD-385）：会审轮次。同一个审查对象的会审超过 2 轮时提醒 Lead，
// 只提醒——不阻止、不改任何结果。
//
// 轮次怎么算（本文件是唯一定义处）：
//   - 交付会审（有 reviewedRunId）：同一条交付谱系上的会审算同一个对象。谱系根取被审
//     运行自己转录里声明的根（declaredLineageRoot，复用现有谱系事实读取，不另写）；
//     轮次 = 会审记录里被审运行属于同一谱系的记录数 + 本次。数记录时状态目录与决定 0111
//     保留的旧落点两处合并，按 consultId 去重（与 consult show / wait 读记录的口径一致）。
//   - 手动接续（follows = 上一场的 consultId）：轮次 = 那一场的轮次 + 1；那一场读不出
//     就具名拒绝，不猜。
//   - 两者都给时取较大值；都没有 = 第 1 轮。
//
// 组记录里写 round（与可选的 follows）。交付会审的新记录还写 lineageRoot——创建时从被审
// 转录核实到的谱系根；以后数记录直接用它，只有没有这个字段的旧记录才回读转录（旧记录不回写）。
// 被审转录读不出（或根声明自相矛盾）时不写 lineageRoot，改写 roundMayBeLow:true——
// 这一场的轮次可能偏低。旧记录没有 round：按读到的事实现算（只算谱系：当时已有的同谱系
// 会审数 + 1）。
//
// 读不出的转录、坏记录、读不了的目录一律少算而不是报错——提醒是 advisory，宁可晚报
// 也不能因为它让一场会审失败。
//
// Architectural contract: 只读；不 import src/commands/*、src/mcp/*、MCP SDK、zod。

import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readTranscript } from "../transcript.js";
import { resolveTranscriptPath } from "../projectBuckets.js";
import { declaredLineageRoot } from "./lineageSupersession.js";

/** Owner 给定的提醒原文（一字不改）。 */
export const CONSULT_ROUND_ADVISORY = "本次会审已超过2轮，请注意掌握节奏、请独立思考、客观判断：继续会审的必要性和ROI。";

const ADVISORY_FROM_ROUND = 3;
const CONSULT_RECORD_FILE_RE = /^consult_[A-Za-z0-9_-]+\.json$/;

/** 第 3 轮起带 {round, roundAdvisory}；第 1、2 轮什么都不带（输出与改前逐字节相同）。 */
export function consultRoundFacts(round) {
  return Number.isInteger(round) && round >= ADVISORY_FROM_ROUND
    ? { round, roundAdvisory: CONSULT_ROUND_ADVISORY }
    : {};
}

/** follows 指向的会审不存在或读不出：创建面的具名拒绝（零派发；MCP 面原样回文案）。 */
export class ConsultFollowsRefusalError extends Error {
  constructor(follows) {
    super(`consult refused: follows ${JSON.stringify(follows)} — no readable consult record with this consultId; `
      + "nothing was dispatched (check the id, or drop follows)");
    this.name = "ConsultFollowsRefusalError";
  }
}

/** 数记录的目录集合：状态目录 + 旧落点 + 调用方给的其它目录，resolve 后去重（先到先得）。 */
function recordDirs(io) {
  const dirs = [io.consultsDir, io.fallbackConsultsDir, ...(Array.isArray(io.lineageDirs) ? io.lineageDirs : [])];
  return [...new Set(dirs.filter((d) => typeof d === "string" && d.length > 0).map((d) => resolve(d)))];
}

/** 合并读取各目录的会审组记录，按 consultId 去重；读不出的目录/记录不计入。 */
async function listConsultRecords(ctx) {
  const seen = new Set();
  const records = [];
  for (const dir of ctx.dirs) {
    let names;
    try { names = await ctx.readdirFn(dir); } catch { continue; }
    for (const name of names) {
      if (!CONSULT_RECORD_FILE_RE.test(name)) continue;
      try {
        const record = JSON.parse(await ctx.readFileFn(join(dir, name), "utf8"));
        if (!record || typeof record !== "object" || typeof record.consultId !== "string") continue;
        if (seen.has(record.consultId)) continue;
        seen.add(record.consultId);
        records.push(record);
      } catch { /* 读不出的记录不计入 */ }
    }
  }
  return records;
}

/**
 * 被审运行所在谱系的根（从它自己的转录核实）；读不出或根声明自相矛盾 = null（未核实）。
 * 同一次计数内按 runId 缓存。
 */
async function verifiedLineageRoot(runId, ctx) {
  if (ctx.memo.has(runId)) return ctx.memo.get(runId);
  let root = null;
  try {
    const declared = declaredLineageRoot(
      await ctx.readTranscriptFn(resolveTranscriptPath(resolve(ctx.runDir), runId)),
      runId,
    );
    if (!declared.conflict && typeof declared.rootRunId === "string") root = declared.rootRunId;
  } catch { /* 转录读不出：未核实 */ }
  ctx.memo.set(runId, root);
  return root;
}

/** a 是否早于 b：createdAt 优先；时间缺失或相同按 consultId 字典序。 */
function createdBefore(a, b) {
  const ta = Date.parse(a.createdAt ?? "");
  const tb = Date.parse(b.createdAt ?? "");
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta < tb;
  return String(a.consultId) < String(b.consultId);
}

/**
 * 与 rootKey 同谱系的会审组记录数（exclude=本场自己；before=只数早于它的）。记录里写了
 * lineageRoot 就直接比，不读转录；只有没有这个字段的旧记录才回读它被审运行的转录。
 */
async function countLineageRecords({ reviewedRunId, rootKey, exclude, before }, ctx) {
  let count = 0;
  for (const record of await listConsultRecords(ctx)) {
    if (record.consultId === exclude) continue;
    if (typeof record.reviewedRunId !== "string" || record.reviewedRunId.length === 0) continue;
    if (before && !createdBefore(record, before)) continue;
    if (record.reviewedRunId === reviewedRunId || record.reviewedRunId === rootKey) {
      count += 1;
    } else if (typeof record.lineageRoot === "string" && record.lineageRoot.length > 0) {
      if (record.lineageRoot === rootKey) count += 1;
    } else if ((await verifiedLineageRoot(record.reviewedRunId, ctx) ?? record.reviewedRunId) === rootKey) {
      count += 1;
    }
  }
  return count;
}

function makeContext(io) {
  return {
    dirs: recordDirs(io),
    runDir: io.runDir,
    readTranscriptFn: io.readTranscriptFn ?? readTranscript,
    readdirFn: io.readdirFn ?? readdir,
    readFileFn: io.readFileFn ?? readFile,
    memo: new Map(),
  };
}

/**
 * 一份已落盘组记录的轮次：写了合法 round 就用它；旧记录（没有 round）按谱系现算。
 * io.consultsDir = 这份记录实际所在的目录；io.fallbackConsultsDir / io.lineageDirs = 一起数的其它目录。
 * @returns {Promise<number>}
 */
export async function consultRoundOfRecord(record, io) {
  if (Number.isInteger(record?.round) && record.round >= 1) return record.round;
  if (typeof record?.reviewedRunId === "string" && record.reviewedRunId.length > 0) {
    const ctx = makeContext(io);
    const rootKey = typeof record.lineageRoot === "string" && record.lineageRoot.length > 0
      ? record.lineageRoot
      : (await verifiedLineageRoot(record.reviewedRunId, ctx) ?? record.reviewedRunId);
    const count = await countLineageRecords(
      { reviewedRunId: record.reviewedRunId, rootKey, exclude: record.consultId, before: record },
      ctx,
    );
    return count + 1;
  }
  return 1;
}

/**
 * 将要创建的这场会审的轮次（写记录之前、等席位之前算）。
 * @param {object} input
 * @param {string} [input.reviewedRunId]
 * @param {string} [input.follows] 上一场的 consultId
 * @param {Function} input.loadFollowed (consultId) => Promise<{record, consultsDir}>；
 *   抛错 = 读不出 → ConsultFollowsRefusalError
 * @param {object} io {consultsDir, fallbackConsultsDir?, runDir, readTranscriptFn?, readdirFn?, readFileFn?}
 * @returns {Promise<{round: number, lineageRoot?: string, roundMayBeLow: boolean}>}
 *   lineageRoot = 创建时从被审转录核实到的谱系根（未核实则缺省，此时 roundMayBeLow=true）。
 */
export async function resolveNewConsultRound({ reviewedRunId, follows, loadFollowed }, io) {
  const ctx = makeContext(io);
  let followedRound = 0;
  if (typeof follows === "string" && follows.length > 0) {
    let loaded;
    try { loaded = await loadFollowed(follows); } catch { throw new ConsultFollowsRefusalError(follows); }
    followedRound = await consultRoundOfRecord(loaded.record, { ...io, lineageDirs: [loaded.consultsDir, ...(io.lineageDirs ?? [])] });
  }
  let lineageRound = 1;
  let lineageRoot;
  let roundMayBeLow = false;
  if (typeof reviewedRunId === "string" && reviewedRunId.length > 0) {
    const verified = await verifiedLineageRoot(reviewedRunId, ctx);
    lineageRoot = verified ?? undefined;
    roundMayBeLow = verified === null;
    lineageRound = 1 + await countLineageRecords({ reviewedRunId, rootKey: verified ?? reviewedRunId }, ctx);
  }
  return {
    round: Math.max(lineageRound, followedRound + 1),
    ...(lineageRoot !== undefined ? { lineageRoot } : {}),
    roundMayBeLow,
  };
}
