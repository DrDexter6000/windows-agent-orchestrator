// src/application/lineageSupersession.js
//
// 第 120 批（Owner 批准）：由谱系派生"被取代"——一条续修谱系只裁决最终候选。
// 采纳了后代，沿已证明父边的祖先就"被取代"：这是**派生事实**，不写任何事件，
// 不改 acceptance/acceptanceStatus 的取值。
//
// 第 120 批续修（sol/opus 审查 A、B 两组）：派生条件收紧、性能重做。
//
// 只认已证明的父边（与 `runs delivery review --since-parent` 同一份检查——
// application/continuationParentEdge.js 的 resolveContinuationParentEdge，不另写
// 第二份）：唯一一条 runId 绑定的 run.background_submitted（continuation:true、
// 合法 parentRunId/rootRunId、且必须是该转录的第一条事件）；子运行自己的
// run.session_reuse 根与事实根一致；父转录可读；父运行自己的谱系根也一致。
// 复用槽的 `priorRunId` 不是交付父边，这里从不读取它。
//
// 运行 X 判为被取代，必须同时满足五条：
//   1. X 有已打包的交付（绑定本 runId 的 `run.delivery_created`）；
//   2. X 自身没有裁决事件（`run.delivery_accepted` / `run.delivery_rejected`）；
//   3. X 自身已收口（`determineRunSettlement(X).status === "settled"`——验证未
//      收口/重验证 pending 的祖先不推导，回收照旧挡住它）；
//   4. X 所在谱系没有显式关闭（根转录里没有绑定根 runId 的 `run.lineage_closed`）；
//   5. 沿已证明父边往下存在后代 D 带**合法**的 `run.delivery_accepted`（合法性
//      用采纳事实读面的同一判定），且 X 与 D 都沿已证明父边连回声明的根——路径
//      上任何节点缺父、自称别的根、或转录里有互相矛盾的 `rootRunId`，都不推导。
// 多个合格后代取距离最近的；同距按 runId 字典序（码元比较）取第一个。
// 兄弟不传染（A→B、A→C 只采纳 C：A 被取代、B 仍待裁决）；末代被 rejected
// 时祖先不推导（拒收不上传）。
//
// 保守面（一律"不推导"，保持待裁决）：同一根内任何成员（含旁支）有内容不同的
// 副本；归档枚举 skipped / 枚举错误；根或成员转录读不出、为空、自称别的根；成员
// 转录缺失/读不出导致一条已证明的父边或一个运行被丢掉（derived:false，调用方不得
// 当成"确定未被取代"缓存）；同一根内已证明父边有任何环（整根不推导，含与根不相连
// 的旁支环）；断链。
//
// 性能（审查 B/E 组）：派生路径先按**原始字节**预筛成员候选——文件名就是根的
// 直接保留，否则读原文做 `Buffer.includes(根 runId)`（有界并发）；读原文失败
// 的文件保留，让后面的解析失败照旧走拒绝。只有候选文件被 JSON 解析（memo 不再
// 留住整库）。`filesByRun` 与副本冲突检查仍用全量文件列表（文件名层面）。一次
// 请求可 `prepare([...roots])` 只扫一遍库；同一实例按根缓存派生结果。只有会真
// 正走到 `forRoot` 的运行才该被收集为根——`supersessionCandidateGate` 是
// `forRun` 与调用方收根共用的那一份判定（普通运行/已裁决/未打包/未收口不预筛）。
// `refresh()` 在执行期重新枚举文件清单：新出现的文件按已准备的根补预筛，新出现
// 的归档 skipped 让整根不可信。
// 不做时间前缀排除：runId 用墙上时钟生成、不单调，筛掉一个成员会改变结论。
// 前提：WAO 自己写的转录里 runId 原样出现（runId 只含 `[a-z0-9_]`，
// `JSON.stringify` 不转义），伪造转录不在防范范围。`runs lineage-close` 的
// 全量枚举保持不变（本模块只给自己用预筛）。
//
// 架构契约：只读（零转录写入、零事件、零 spawn）；不 import src/commands/**、
// src/mcp/**、MCP SDK 或 zod。

import { readFile, stat } from "node:fs/promises";

import { readTranscript, validateDeliveryFacts } from "../transcript.js";
import { isValidRunId } from "../delivery.js";
import { continuableLineageFact } from "./runContinue.js";
import { determineRunSettlement } from "./runSettlement.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";
import {
  enumerateLineageMembers,
  lineageClosedIn,
  lineageMemberFiles,
} from "./lineageClose.js";
import { resolveContinuationParentEdge } from "./continuationParentEdge.js";

const PACKAGED_TYPE = "run.delivery_created";
const DECISION_TYPES = new Set(["run.delivery_accepted", "run.delivery_rejected"]);
const ROOT_REF_TYPES = new Set(["run.session_reuse", "run.background_submitted"]);
/** 字节预筛的并发上限（审查 B2：有界并发 8–16）。 */
const PREFILTER_CONCURRENCY = 12;

/** 绑定本 runId 的事件判定（TD-128 族：只认 runId 绑定的信封）。 */
function hasBound(events, type, runId) {
  return events.some((e) => e && e.type === type && e.runId === runId);
}

/** 最后一条绑定 state_change 的 `to`（没有则 null）——执行期门判"是否尚未终态"。 */
function lastBoundState(events, runId) {
  let state = null;
  for (const e of events) {
    if (e && e.type === "run.state_change" && e.runId === runId && typeof e.to === "string") state = e.to;
  }
  return state;
}

function runIdOfFile(file) {
  const name = typeof file?.name === "string" ? file.name : "";
  if (!name.endsWith(".jsonl")) return null;
  const runId = name.slice(0, -".jsonl".length);
  return isValidRunId(runId) ? runId : null;
}

/**
 * 采纳事实读面的同一判定：合法 decision（validateDeliveryFacts 的 runId 绑定
 * 模式）+ 决策事件类型是 accepted。pending 上的 accepted 不合法（写面与读面
 * 同一判据），因此不会被当成"已采纳的后代"。
 */
function isAcceptedDelivery(events, runId) {
  try {
    const facts = validateDeliveryFacts(events, {
      expectedRunId: runId,
      allowVerificationPending: true,
    });
    return facts.valid === true && facts.decisionEvent?.type === "run.delivery_accepted";
  } catch {
    return false;
  }
}

/**
 * 回收侧"合法裁决"的唯一判定（第 120 批续修 G3）：与计划分类判"已裁决"共用。
 * 采纳（accepted）必须是合法 durable 事实——`validateDeliveryFacts` 的 runId
 * 绑定模式通过且决策事件是 accepted（缺交付载荷/损坏的采纳事件不算裁决）。
 * 拒收（rejected）沿用 b120 之前的事件类型口径（**兼容例外**：认最后一条绑定
 * 拒收事件，不要求通过完整事实校验）——因此审批事实里的 `rejected` 只表示
 * "最后一条决策事件是拒收"，不代表这条运行交付事实合法。
 * 注意：派生模块自己的 `decided` 只用于"不推导"（保守），与这里分开。
 * @param {object[]} events
 * @param {string} runId
 * @returns {"accepted"|"rejected"|null}
 */
export function legalDeliveryDecision(events, runId) {
  let decision = null;
  if (!Array.isArray(events)) return null;
  for (const e of events) {
    if (!e || e.runId !== runId) continue;
    if (e.type === "run.delivery_accepted") decision = "accepted";
    else if (e.type === "run.delivery_rejected") decision = "rejected";
  }
  if (decision !== "accepted") return decision;
  return isAcceptedDelivery(events, runId) ? "accepted" : null;
}

/**
 * 派生入口门（第 120 批续修 E1）：`forRun` 与"收集待预筛的根"共用这一份判定，
 * 不写两份。条件：自身有谱系引用（可能是别人的后代）、有已打包的交付、自身
 * 没有裁决事件、自身已收口。只有满足它的运行才会走到 `forRoot`（全库预筛）。
 * @param {object[]} events
 * @param {string} runId
 * @returns {{candidate: boolean, lineageRef: boolean, packaged: boolean, decided: boolean, settled: boolean}}
 */
export function supersessionCandidateGate(events, runId) {
  const gate = { candidate: false, lineageRef: false, packaged: false, decided: false, settled: false };
  if (!Array.isArray(events)) return gate;
  gate.lineageRef = events.some((e) => e && e.runId === runId
    && ROOT_REF_TYPES.has(e.type) && typeof e.rootRunId === "string");
  gate.packaged = hasBound(events, PACKAGED_TYPE, runId);
  gate.decided = events.some((e) => e && e.runId === runId && DECISION_TYPES.has(e.type));
  try {
    gate.settled = determineRunSettlement(events, runId).status === "settled";
  } catch {
    gate.settled = false;
  }
  gate.candidate = gate.lineageRef && gate.packaged && !gate.decided && gate.settled;
  return gate;
}

/**
 * 声明的谱系根（纯函数，供批量预筛先收集根）：本转录里所有 runId 绑定的
 * `run.session_reuse` / `run.background_submitted` 的 rootRunId 必须唯一。
 * 一个转录里出现多个不同的 rootRunId → `conflict`（lineageRootFromEvents 取首条、
 * continuableLineageFact 取末条，这个分歧不能被利用）；一条都没有 → 本 run 就是
 * 自己的根（普通运行）。
 * @param {object[]} events
 * @param {string} runId
 * @returns {{rootRunId: string|null, conflict: boolean}}
 */
export function declaredLineageRoot(events, runId) {
  const roots = new Set();
  if (!Array.isArray(events)) return { rootRunId: null, conflict: false };
  for (const e of events) {
    if (!e || e.runId !== runId) continue;
    if (!ROOT_REF_TYPES.has(e.type)) continue;
    if (typeof e.rootRunId === "string" && isValidRunId(e.rootRunId)) roots.add(e.rootRunId);
  }
  if (roots.size > 1) return { rootRunId: null, conflict: true };
  return { rootRunId: roots.size === 1 ? [...roots][0] : runId, conflict: false };
}

/**
 * 最近的合格后代：逐层向下 BFS；同层命中取 runId 字典序第一个（码元比较，
 * 不随 locale 漂移）。
 */
function nearestAcceptedDescendant(startRunId, childrenOf, accepted) {
  if (accepted.size === 0) return null;
  let frontier = [...(childrenOf.get(startRunId) ?? [])];
  const seen = new Set([startRunId]);
  while (frontier.length > 0) {
    const next = [];
    const hits = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (accepted.has(id)) hits.push(id);
      for (const child of childrenOf.get(id) ?? []) {
        if (!seen.has(child)) next.push(child);
      }
    }
    if (hits.length > 0) {
      hits.sort();
      return hits[0];
    }
    frontier = next;
  }
  return null;
}

/** 有界并发 map（结果无关；用于字节预筛）。 */
async function forEachLimit(items, limit, fn) {
  let index = 0;
  const workers = [];
  const workerCount = Math.min(Math.max(1, limit), items.length);
  for (let w = 0; w < workerCount; w += 1) {
    workers.push((async () => {
      for (;;) {
        const i = index;
        index += 1;
        if (i >= items.length) return;
        await fn(items[i]);
      }
    })());
  }
  await Promise.all(workers);
}

/**
 * 一次请求内的谱系派生器（按根缓存 + 一次批量预筛）。同一个实例就是"同一次
 * 请求"：调用方（preflight / 交付读面 / 回收计划与执行）各自建一个，不跨请求
 * 共享。
 *
 * @param {object} input
 * @param {string} input.runDir — runs/ 目录（三处枚举的根；归档从 dirname 推导）
 * @param {Function} [input.readTranscriptFn] — (path) => Promise<events[]>；缺省
 *   readTranscript。注入面与 leadOpenItems 等既有调用方同款。
 * @param {Array<{name: string, path: string}>} [input.files] — 已枚举好的转录文件集
 *   （worktree reclaim 的共享事实索引用它，避免重复枚举）；缺省
 *   lineageMemberFiles(runDir, { strict: true }).files。派生读器一律严格枚举：
 *   存储根/桶目录读不出时抛出（把"枚举不完整"与"确实没有"分开，L2）。
 * @param {Function} [input.memberFilesForRoot] — (rootRunId) => files[]；给了就
 *   完全替代字节预筛（回收计划复用事实索引的 byRoot，零额外 I/O）。
 * @param {Function} [input.readBytesFn] — (path) => Promise<Buffer>；字节预筛的
 *   读缝（缺省 node:fs/promises.readFile；测试注入计数用）。
 * @param {Function} [input.statFn] — (path) => Promise<{size, mtimeMs}>；refresh
 *   判断"已有文件内容变了"的 stat 缝（缺省 node:fs/promises.stat）。
 * @param {Function} [input.enumerateFilesFn] — (runDir) => {files, skipped}；
 *   文件枚举缝（缺省严格版 lineageMemberFiles；测试注入枚举失败用）。
 * @param {boolean} [input.filesIncomplete] — 注入的 `files` 清单不完整（调用方
 *   枚举时已失败、退回了非严格清单）→ 实例不出任何"被取代"依据（N1）。
 * @param {string} [input.descendantWorkspaceRoot] — 给了就要求被采纳的后代 D
 *   通过该根的归属核验（审查 A5）；不给则不核验（CLI 特权通道/内部消费方）。
 * @returns {{prepare: Function, forRoot: Function, forRun: Function, forRunId: Function, rootOfRun: Function, refresh: Function}}
 */
export function createLineageSupersession({
  runDir,
  readTranscriptFn = readTranscript,
  readBytesFn = readFile,
  statFn = stat,
  enumerateFilesFn = (dir) => lineageMemberFiles(dir, { strict: true }),
  files = null,
  filesIncomplete = false,
  memberFilesForRoot = null,
  descendantWorkspaceRoot,
} = {}) {
  const memo = new Map(); // 文件路径 → {ok, events}（只装候选/被查询的文件）
  const rootCache = new Map(); // rootRunId → Promise<派生结果>
  const edgeCache = new Map(); // runId → 已证明的父边 | null
  const candidates = new Map(); // rootRunId → files[] | null（null = 枚举面不可信）
  const prepared = new Map(); // rootRunId → 在途/已完成的预筛 Promise（F3：并发串行化）
  const fileStats = new Map(); // 文件路径 → {size, mtimeMs}（J1：refresh 判内容变的基准）
  const fixedFileList = Array.isArray(files); // 注入的文件集不可重枚举（回收计划）
  let fileList = null;
  let enumerationSkipped = null;
  let filesByRun = null;
  let refreshFailed = false; // 刷新失败一次后整个实例不可信（J2：之后的查询都不推导）
  // L2：枚举不完整（严格枚举抛错，或归档面 skipped）时，"确实没有这份转录"的
  // 判断不可信——调用方必须按无法判定跳过，不能拿 missing 走旧逻辑放行删除。
  // N1：注入的清单不完整（filesIncomplete）同样按"枚举不完整"处理，且不推导。
  let enumerationIncomplete = filesIncomplete === true;

  function enumerateFiles() {
    return enumerateFilesFn(runDir);
  }

  async function readSafe(path) {
    if (!memo.has(path)) {
      memo.set(path, (async () => {
        try {
          const events = await readTranscriptFn(path);
          return Array.isArray(events) ? { ok: true, events } : { ok: false };
        } catch {
          return { ok: false };
        }
      })());
    }
    return memo.get(path);
  }

  /** 文件清单并入索引（全量文件名层面；幂等）。 */
  function indexFiles(files) {
    for (const f of files) {
      const runId = runIdOfFile(f);
      if (runId === null || typeof f?.path !== "string") continue;
      if (!filesByRun.has(runId)) filesByRun.set(runId, []);
      filesByRun.get(runId).push(f);
    }
  }

  function ensureFiles() {
    if (fileList !== null) return;
    filesByRun = new Map();
    if (fixedFileList) {
      fileList = files;
      enumerationSkipped = [];
    } else {
      try {
        const enumerated = enumerateFiles();
        fileList = enumerated.files;
        enumerationSkipped = Array.isArray(enumerated.skipped) ? enumerated.skipped : [];
      } catch {
        fileList = [];
        enumerationSkipped = [{ reason: "enumeration_failed" }];
      }
      enumerationIncomplete = enumerationSkipped.length > 0;
    }
    indexFiles(fileList);
  }

  /**
   * 一个 runId 的转录事实。`state`: ok | missing | unreadable | conflict | empty。
   * 同 runId 多份副本内容不同 → conflict（决定 0100 同一查重纪律）。
   */
  async function runEvents(runId) {
    ensureFiles();
    const runFiles = filesByRun.get(runId);
    if (!runFiles || runFiles.length === 0) return { state: "missing", events: null };
    const reads = [];
    for (const f of runFiles) {
      const r = await readSafe(f.path);
      if (!r.ok) return { state: "unreadable", events: null };
      reads.push(r.events);
    }
    if (reads.length > 1) {
      const canon = JSON.stringify(reads[0]);
      if (reads.some((events) => JSON.stringify(events) !== canon)) {
        return { state: "conflict", events: null };
      }
    }
    if (reads[0].length === 0) return { state: "empty", events: reads[0] };
    return { state: "ok", events: reads[0] };
  }

  /** 一批文件按一批根做字节预筛（文件名命中 / 原文含根 / 原文读不出 → 保留）。
   * 顺带记下每个文件的 size/mtimeMs（J1：refresh 只重扫变化了的非候选文件）。 */
  async function prefilter(filesToScan, roots) {
    const needles = new Map(roots.map((root) => [root, Buffer.from(root, "utf8")]));
    const buckets = new Map(roots.map((root) => [root, []]));
    await forEachLimit(filesToScan, PREFILTER_CONCURRENCY, async (file) => {
      const fileRunId = runIdOfFile(file);
      try {
        const st = await statFn(file.path);
        fileStats.set(file.path, { size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        fileStats.delete(file.path); // 记不下基准：refresh 时按"变了"重扫
      }
      let bytes = null;
      try {
        bytes = await readBytesFn(file.path);
      } catch {
        bytes = null; // 读不出：保留给每个根，交给解析失败照旧拒绝
      }
      for (const root of roots) {
        if (fileRunId === root || bytes === null || bytes.includes(needles.get(root))) {
          buckets.get(root).push(file);
        }
      }
    });
    return buckets;
  }

  /**
   * 字节预筛：对 pending 的根各给一份候选文件集。一次调用只扫一遍库。
   * - 文件名就是根 → 直接保留；
   * - 原文包含根 runId 字节 → 保留；
   * - 读原文失败 → 保留（让后面的解析失败照旧走拒绝）；
   * - 归档枚举 skipped / 枚举失败 → 整根不可信（candidates = null）。
   * 每个根一个 Promise（第 120 批续修 F3）：并发 `prepare` 与 `forRoot` 时，
   * `forRoot` 先等该根的在途预筛完成，不会把"还没准备好"的空结果缓存下来。
   */
  function prepareRoots(rootIds) {
    ensureFiles();
    const pending = [...new Set(rootIds)]
      .filter((r) => typeof r === "string" && isValidRunId(r) && !prepared.has(r));
    if (pending.length === 0) return Promise.resolve();
    const task = (async () => {
      if (enumerationSkipped.length > 0) {
        for (const root of pending) candidates.set(root, null);
        return;
      }
      if (typeof memberFilesForRoot === "function") {
        for (const root of pending) {
          try {
            candidates.set(root, memberFilesForRoot(root) ?? []);
          } catch {
            candidates.set(root, null);
          }
        }
        return;
      }
      const buckets = await prefilter(fileList, pending);
      for (const root of pending) candidates.set(root, buckets.get(root));
    })();
    for (const root of pending) prepared.set(root, task);
    return task;
  }

  /** 确保该根的预筛已完成（在途 Promise 先等；没有就现建一次）。 */
  async function ensurePrepared(rootRunId) {
    let task = prepared.get(rootRunId);
    if (!task) {
      await prepareRoots([rootRunId]);
      task = prepared.get(rootRunId);
    }
    if (task) await task;
  }

  /** 后代 D 的归属核验（只在调用方给了授权根时执行；与读面同一 SSOT）。 */
  function descendantOwnedByAuthorizedRoot(events, runId) {
    if (typeof descendantWorkspaceRoot !== "string" || descendantWorkspaceRoot.length === 0) return true;
    try {
      verifyRunWorkspaceOwnership(events, descendantWorkspaceRoot, runId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 已证明的父边（与 --since-parent 同一份检查）。返回 { edge, parentUnreadable }：
   *   - edge = {parentRunId} 只在这条边被证明时给出（= 链成立，是结论）；
   *   - parentUnreadable = true 表示这次没证明出边、并且原因是**父转录读不出 / 缺失 /
   *     冲突 / 为空**（`readParentEventsFn` 返回 null 或父运行状态不是 ok）——这时不能
   *     把"没有边"当成链不成立的结论；派生结果要标 derived:false。
   *   真正"链不成立"（父子转录都读得出，但续修事实不成立、根不一致等）仍是结论。
   */
  async function parentEdge(runId, events, rootRunId) {
    if (edgeCache.has(runId)) return edgeCache.get(runId);
    const result = { edge: null, parentUnreadable: false };
    const declared = declaredLineageRoot(events, runId);
    if (!declared.conflict && declared.rootRunId === rootRunId && continuableLineageFact(events, runId)) {
      // 父转录读没读成：resolveContinuationParentEdge 把"父读不出"折成固定拒绝文案，
      // 只有在读缝旁记下父运行状态才能把它和"本来就没有父边"分开。
      let parentReadState = "not_attempted";
      try {
        const resolved = await resolveContinuationParentEdge({
          runId,
          events,
          runDir,
          readParentEventsFn: async (_dir, parentRunId) => {
            const parentRead = await runEvents(parentRunId);
            parentReadState = parentRead.state;
            return parentRead.state === "ok" ? parentRead.events : null;
          },
        });
        if (resolved.rootRunId === rootRunId) result.edge = { parentRunId: resolved.parentRunId };
      } catch {
        result.edge = null;
      }
      if (result.edge === null && parentReadState !== "not_attempted" && parentReadState !== "ok") {
        result.parentUnreadable = true;
      }
    }
    edgeCache.set(runId, result);
    return result;
  }

  /**
   * 一条谱系（按根）的派生：{rootRunId, lineageClosed, byRunId, derived}。
   * byRunId：runId → supersededByRunId（只含被取代的运行）。
   * derived：这次派生有没有得出**结论**。false = 没能推导（枚举不完整、根/成员
   * 读不出、成员缺失导致丢边或丢运行、冲突、拒绝、断链、有环等保守出口）——调用方
   * 不得把它的结果当成"确定未被取代"缓存下来，要下一轮重试；true = 结论有效（可能是
   * "无人被取代"；也包含"转录都读得出、只是父边证不出来"这种真正的链不成立）。
   */
  async function deriveForRoot(rootRunId) {
    const empty = { rootRunId, lineageClosed: false, byRunId: new Map(), derived: false };
    // J2：刷新失败过的实例不再推导；N1：枚举不完整（含调用方注入的不完整清单）
    // 时不出"被取代"依据——看不全清单就不能断言谱系里没有环。
    if (refreshFailed || enumerationIncomplete) return empty;
    // F3：先等在途预筛（同一次请求里并发 prepare 时不能在"还没准备好"上缓存空结果）。
    await ensurePrepared(rootRunId);
    const cand = candidates.get(rootRunId);
    if (!cand) return empty; // 枚举面不可信（归档 skipped / 枚举失败）
    const rootRead = await runEvents(rootRunId);
    if (rootRead.state !== "ok") return empty;
    const rootEvents = rootRead.events;
    if (lineageClosedIn(rootEvents, rootRunId)) {
      // 优先级：谱系显式关闭 > 派生被取代——关闭的谱系不再派生。关闭是结论。
      return { rootRunId, lineageClosed: true, byRunId: new Map(), derived: true };
    }
    const rootDeclared = declaredLineageRoot(rootEvents, rootRunId);
    if (rootDeclared.conflict || rootDeclared.rootRunId !== rootRunId) return empty;

    let enumerated;
    try {
      enumerated = await enumerateLineageMembers(rootRunId, cand, readSafe);
    } catch {
      return empty;
    }
    if (enumerated.refuse) return empty;

    // 成员事实：任何成员转录冲突/读不出/为空/自称别的根 → 整根不推导。
    const facts = new Map();
    for (const member of enumerated.members) {
      const runId = member.runId;
      if (!isValidRunId(runId)) return empty;
      const read = await runEvents(runId);
      if (read.state !== "ok") return empty;
      const declared = declaredLineageRoot(read.events, runId);
      if (declared.conflict || declared.rootRunId !== rootRunId) return empty;
      const parent = await parentEdge(runId, read.events, rootRunId);
      facts.set(runId, {
        events: read.events,
        edge: parent.edge,
        parentUnreadable: parent.parentUnreadable,
        packaged: hasBound(read.events, PACKAGED_TYPE, runId),
        decided: read.events.some((e) => e && e.runId === runId && DECISION_TYPES.has(e.type)),
        settled: determineRunSettlement(read.events, runId).status === "settled",
      });
    }

    // 只保留两端都已证明的父边（父运行必须是本谱系可读的成员）。边是因为父转录
    // 读不出/缺失才丢的（parentUnreadable），或父边证明了却缺父运行的事实——都说明
    // 有一个成员没读成，整条派生不能当结论（F1）；链本身不成立（转录都读得出、
    // 只是证不出父边）仍是结论。
    let derived = true;
    const parentOf = new Map();
    for (const [runId, fact] of facts) {
      if (!fact.edge) {
        if (fact.parentUnreadable) derived = false;
        continue;
      }
      if (!facts.has(fact.edge.parentRunId)) {
        derived = false;
        continue;
      }
      parentOf.set(runId, fact.edge.parentRunId);
    }
    // 第 120 批续修（审查 F1）：同一根内已证明父边只要有环，整根不推导（恢复
    // 92babef3 的行为）——旁支自己成环也要拒绝，不能把环上节点剔掉后继续给肯定。
    const acyclic = (() => {
      for (const start of parentOf.keys()) {
        const seen = new Set();
        let current = start;
        while (parentOf.has(current)) {
          if (seen.has(current)) return false;
          seen.add(current);
          current = parentOf.get(current);
        }
      }
      return true;
    })();
    if (!acyclic) return empty;
    // 节点必须沿已证明父边连回声明的根（断链、中途自称别的根都不算）。
    const connectsToRoot = (startRunId) => {
      const seen = new Set();
      let current = startRunId;
      for (;;) {
        const parentRunId = parentOf.get(current);
        if (parentRunId === undefined) return current === rootRunId;
        if (seen.has(current)) return false;
        seen.add(current);
        current = parentRunId;
      }
    };
    const connected = new Set();
    for (const runId of facts.keys()) {
      if (connectsToRoot(runId)) connected.add(runId);
    }

    const childrenOf = new Map();
    for (const [runId, parentRunId] of parentOf) {
      if (!connected.has(runId) || !connected.has(parentRunId)) continue;
      if (!childrenOf.has(parentRunId)) childrenOf.set(parentRunId, []);
      childrenOf.get(parentRunId).push(runId);
    }
    const accepted = new Set();
    for (const runId of connected) {
      const fact = facts.get(runId);
      if (!isAcceptedDelivery(fact.events, runId)) continue;
      if (!descendantOwnedByAuthorizedRoot(fact.events, runId)) continue;
      accepted.add(runId);
    }
    const byRunId = new Map();
    if (accepted.size > 0) {
      for (const runId of connected) {
        const fact = facts.get(runId);
        if (!fact.packaged || fact.decided || !fact.settled) continue;
        const descendant = nearestAcceptedDescendant(runId, childrenOf, accepted);
        if (descendant) byRunId.set(runId, descendant);
      }
    }
    return { rootRunId, lineageClosed: false, byRunId, derived };
  }

  /** 按根派生（同一次请求内缓存；任何失败折叠成"不推导"）。 */
  async function forRoot(rootRunId) {
    if (typeof rootRunId !== "string" || !isValidRunId(rootRunId)) {
      return { rootRunId: null, lineageClosed: false, byRunId: new Map(), derived: false };
    }
    if (!rootCache.has(rootRunId)) {
      rootCache.set(rootRunId, (async () => {
        try {
          return await deriveForRoot(rootRunId);
        } catch {
          return { rootRunId, lineageClosed: false, byRunId: new Map(), derived: false };
        }
      })());
    }
    return rootCache.get(rootRunId);
  }

  /** 只读根转录判闭态（不触发全库派生）。 */
  async function readLineageClosed(rootRunId, hintEvents) {
    if (Array.isArray(hintEvents)) return lineageClosedIn(hintEvents, rootRunId);
    const read = await runEvents(rootRunId);
    return read.state === "ok" && lineageClosedIn(read.events, rootRunId);
  }

  /** 一个运行的声明根（只读它自己的转录；供批量预筛收集根）。 */
  async function rootOfRun(runId) {
    const result = { runId, transcriptReadable: false, rootRunId: null, conflict: false };
    if (typeof runId !== "string" || !isValidRunId(runId)) return result;
    const read = await runEvents(runId);
    if (read.state !== "ok") return result;
    const declared = declaredLineageRoot(read.events, runId);
    return {
      runId,
      transcriptReadable: true,
      rootRunId: declared.conflict ? null : declared.rootRunId,
      conflict: declared.conflict,
    };
  }

  /**
   * 一个运行的派生事实。`events` 供给时用它（调用方手上的同一份快照——
   * 自身已裁决/未打包/未收口时直接返回，不触全库派生）。
   *
   * `derived` 表示这次派生有没有得出**结论**（false = 没能推导：枚举不完整、
   * 根/成员读不出、冲突、拒绝、刷新失败等）。调用方只有拿到 `derived === true`
   * 才能把 supersededByRunId 当"确定未被取代"缓存；false 要下一轮重试、按无法
   * 判定发布。
   *
   * `transcriptState` 如实说明读不出转录的原因（missing | empty | unreadable |
   * conflict | untrusted | ok），调用方据此给各写各的跳过理由；`refreshFailed`
   * 表示此前 refresh 失败（枚举抛错/不完整）、本实例已不可信；`enumerationIncomplete`
   * 表示枚举面不完整——**只在真正枚举过之后才填**（Q2）：还没枚举时是 `null`
   * （不是 false，免得把"不知道"误报成"完整"），枚举后是布尔值，刷新失败时为
   * true（Q1）。`lastState` 是该运行最后一条绑定 state_change 的 `to`（没有则
   * null）——回收的执行期普通分支门用它判"是否尚未终态"。
   *
   * @returns {Promise<{runId: string, rootRunId: string, transcriptReadable: boolean,
   *   transcriptState: string, refreshFailed: boolean, enumerationIncomplete: boolean|null,
   *   lastState: string|null,
   *   decided: boolean, legalDecision: "accepted"|"rejected"|null,
   *   packaged: boolean, settled: boolean, lineageClosed: boolean, derived: boolean,
   *   supersededByRunId: string|null}>}
   */
  async function forRun({ runId, events } = {}) {
    const result = {
      runId,
      rootRunId: runId,
      transcriptReadable: false,
      transcriptState: refreshFailed ? "untrusted" : "missing",
      refreshFailed,
      enumerationIncomplete: null,
      lastState: null,
      decided: false,
      legalDecision: null,
      packaged: false,
      settled: false,
      lineageClosed: false,
      derived: false,
      supersededByRunId: null,
    };
    // 诊断字段只在真正枚举过（fileList 已建）之后才填；刷新失败时枚举不完整，
    // 不能显示成 false（Q1）。
    const finish = (r) => {
      r.enumerationIncomplete = refreshFailed ? true : (fileList === null ? null : enumerationIncomplete);
      return r;
    };
    if (refreshFailed) return finish(result); // J2：刷新失败过的实例不再推导
    if (typeof runId !== "string" || !isValidRunId(runId)) return finish(result);
    const own = Array.isArray(events)
      ? { state: events.length === 0 ? "empty" : "ok", events }
      : await runEvents(runId);
    result.transcriptState = own.state;
    if (own.state !== "ok") return finish(result);
    const ownEvents = own.events;
    result.transcriptReadable = true;
    result.lastState = lastBoundState(ownEvents, runId);
    // 派生模块自己的 decided 只用于"不推导"（按事件类型，保守）；回收侧的
    // "合法裁决"走同一个 legalDeliveryDecision（G3）——两者分开。
    const gate = supersessionCandidateGate(ownEvents, runId);
    result.packaged = gate.packaged;
    result.decided = gate.decided;
    result.settled = gate.settled;
    result.legalDecision = legalDeliveryDecision(ownEvents, runId);
    const declared = declaredLineageRoot(ownEvents, runId);
    if (declared.conflict) return finish(result); // 根不一致：什么都不判（也不判关闭）
    // 非续修谱系成员（自身没有任何 rootRunId 引用）不可能有已证明的后代——
    // 子运行的父边检查要求父运行自己带 run.session_reuse 谱系根。直接按闭态
    // 收口、不触全库预筛（普通交付查询/等待的读面代价为零，Q2 也不做目录枚举）。
    // "不是谱系成员"本身就是结论：不会有人被它取代。
    if (!gate.lineageRef) {
      result.lineageClosed = lineageClosedIn(ownEvents, runId);
      result.derived = true;
      return finish(result);
    }
    const rootRunId = declared.rootRunId;
    result.rootRunId = rootRunId;
    // 审查 A2：调用方快照已裁决 / 未打包 / 未收口 → 不调 forRoot，只读根转录判闭态。
    // 这三条规则各自已经确定"是否被取代"为 null，是结论，不是"没能推导"。
    if (!gate.candidate) {
      result.lineageClosed = await readLineageClosed(rootRunId, rootRunId === runId ? ownEvents : null);
      result.derived = true;
      return finish(result);
    }
    const derived = await forRoot(rootRunId);
    // 根就是本 run 时，调用方手上的快照是同一份权威事实：文件索引读不出
    // （注入读器的调用面/归档缺席）时用它兜底判闭态——闭态是结论。
    const ownClosed = rootRunId === runId && lineageClosedIn(ownEvents, rootRunId);
    result.lineageClosed = derived.lineageClosed === true || ownClosed;
    result.derived = derived.derived === true || ownClosed;
    result.supersededByRunId = result.lineageClosed
      ? null
      : (derived.byRunId.get(runId) ?? null);
    return finish(result);
  }

  /** 按 runId 派生（文件索引读转录）。 */
  async function forRunId(runId) {
    return forRun({ runId });
  }

  /**
   * 丢弃内容与派生缓存，并重新枚举文件清单（第 120 批续修 F2/J1/J2/L2）：回收
   * 执行在删前对"授权所用的那几份转录"现读重证时用它。三类变化都会并入候选：
   *   - 新出现的文件（按已准备的根补一次字节预筛）；
   *   - 已有文件的内容变化——prepare 时记了 size/mtimeMs，**清单里每个文件**
   *     （含候选）逐个 stat，变了才重扫。不能只查"非候选"：同一份文件可能对
   *     根 A 是候选、对根 B 不是，只按候选并集排除会漏掉它对 B 的变化。
   *   - 归档枚举 skipped / 严格枚举抛错（枚举不完整）→ 整实例不可信并抛错。
   * 边界：这是追加写入模型下的 **元数据检查**（size+mtimeMs），不是内容完整性
   * 校验——同尺寸、同 mtimeMs 的改写看不到；WAO 自己只追加写入。
   * 枚举失败/不完整（J2/L2）：实例标记为不可信并抛错——调用方必须按"无法判定"
   * 跳过，不能拿旧索引放行删除；此后本实例的任何查询都不再推导。
   * 成本（sol 复量，合成库 5,800 份约 1 KiB）：有已准备的根时每次刷新中位数约
   * 0.4–0.9 秒（逐文件 stat 5,800 次）；没有已准备的根时约 0.03–0.07 秒且不做
   * stat。只在回收执行里按条目调用。
   * 注入的文件集（回收计划复用的索引）不重枚举：它的调用面不做 refresh。
   */
  async function refresh() {
    memo.clear();
    rootCache.clear();
    edgeCache.clear();
    if (fixedFileList) return;
    // N2：刷新过程中任何一次枚举失败（含"读器还没预热"的第一次）都按刷新失败
    // 处理并抛错——不能先吞一次故障再重新枚举成功、然后照常放行删除。
    let enumerated;
    try {
      enumerated = enumerateFiles();
    } catch {
      refreshFailed = true;
      enumerationIncomplete = true;
      for (const root of prepared.keys()) candidates.set(root, null);
      throw new Error("lineage supersession: refresh enumeration failed");
    }
    const skippedNow = Array.isArray(enumerated.skipped) ? enumerated.skipped : [];
    if (skippedNow.length > 0) {
      // 归档面读不全（月份目录读不出/链接不跟随）：枚举不完整，不能证明任何
      // 运行"确实没有转录"——与抛错同口径处置。
      enumerationSkipped = skippedNow;
      refreshFailed = true;
      enumerationIncomplete = true;
      for (const root of prepared.keys()) candidates.set(root, null);
      throw new Error("lineage supersession: refresh enumeration incomplete");
    }
    const known = new Set((fileList ?? []).map((f) => f.path));
    const added = enumerated.files.filter((f) => !known.has(f.path));
    fileList = enumerated.files;
    enumerationIncomplete = false;
    // Q1：成功刷新时同步"跳过清单"等 ensureFiles 维护的状态——否则冷启动刷新后
    // enumerationSkipped 还是 null，随后 prepare() 读 .length 会抛错（被派生
    // 调用方吞掉，本来能推导的运行变成不推导）。
    enumerationSkipped = [];
    // 按新清单重建文件索引（被删掉的文件不再留在索引里）。
    filesByRun = new Map();
    indexFiles(fileList);
    const roots = [...prepared.keys()];
    if (roots.length === 0) return;
    if (typeof memberFilesForRoot === "function") {
      for (const root of roots) {
        try {
          candidates.set(root, memberFilesForRoot(root) ?? []);
        } catch {
          candidates.set(root, null);
        }
      }
      return;
    }
    // 候选集按新清单收窄（去掉已消失的文件）。
    const present = new Set(fileList.map((f) => f.path));
    for (const root of roots) {
      const current = candidates.get(root);
      if (!Array.isArray(current)) continue;
      candidates.set(root, current.filter((f) => present.has(f.path)));
    }
    // 已有文件的内容变化：清单里每个文件都 stat（含候选——候选对别的根可能
    // 不是候选，见函数注释）。
    const changed = [];
    const addedPaths = new Set(added.map((f) => f.path));
    for (const f of fileList) {
      if (addedPaths.has(f.path)) continue;
      let st;
      try {
        st = await statFn(f.path);
      } catch {
        changed.push(f); // stat 不出：按"变了"重扫（读不出→保留给每个根，保守）
        continue;
      }
      const prev = fileStats.get(f.path);
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
      changed.push(f);
    }
    const toScan = [...added, ...changed];
    if (toScan.length === 0) return;
    const buckets = await prefilter(toScan, roots);
    for (const root of roots) {
      const current = candidates.get(root);
      if (!Array.isArray(current)) continue; // 已不可信
      const have = new Set(current.map((f) => f.path));
      candidates.set(root, [...current, ...buckets.get(root).filter((f) => !have.has(f.path))]);
    }
  }

  return {
    prepare: (rootIds) => prepareRoots(Array.isArray(rootIds) ? rootIds : [rootIds]),
    forRoot,
    forRun,
    forRunId,
    rootOfRun,
    refresh,
  };
}
