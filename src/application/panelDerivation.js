// src/application/panelDerivation.js
//
// 0065（2026-10-12）：0045 §1.2 终局执行——对抗性从审者车道×作者车道关系派生
// （取代人工 seatRole 声明）。TD-264 落地件。
//
// 定位（会审 consult_20261012122731994yv6bty 双席 P1 全采纳）：
//   - **不持第二套判定**：车道关系复用 consultService.deriveIndependenceRelations
//     （0045 R4——laneFingerprint 指纹比对，same_lane/different_lane/unknown 三态，
//     缺事实=unknown 绝不折叠成 false）。本模块只做编排 + 新增族系粗粒度维
//     （modelFamilyOf：cross/same/unknown）。
//   - **比对依据=车道指纹，不是 agentId 字符串**（opus/sol 一致红队）：旧席位名
//     （gpt-astra/kimi-k3 等 legacy 名）字符串不等会漏报回避违反；同四元组改
//     effort 注册双键会虚报跨车道。
//   - **作者侧只认被审 run 的 run.started 钉住事实**（deriveStartedIdentity），
//     绝不拿 agentId 反查当前 registry（键可能已换绑新模型）。
//   - **席位侧=registry 当前配置事实**（登记时快照）——记录必须携带来源声明：
//     自报席位 + 当前注册表轴 ≠ 实际评审发生的证明（sol）。
//   - **多作者**（0019 §3 "作者或共同作者"）：--reviewed-run 支持多值；席位对
//     作者集合的 authorRelation = same_lane（任一作者同车道）> unknown（任一
//     比对缺事实）> different_lane（全部可比且全部不同）——fail-closed。
//   - 措辞纪律（opus）：车道不同=「对抗前提成立」，不是「对抗成立」——0019 §3
//     还有两条派生不出的回避（前置意见已被采纳者回避、方案/验收两阶段换人）。
//
// 纯编排层：IO（转录读取/路径解析）注入；registry 事实由调用方传入归一化条目。

import { deriveStartedIdentity, laneFingerprint } from "./identityProjection.js";
import { deriveIndependenceRelations } from "./consultService.js";
import { modelFamilyOf, UNKNOWN_FAMILY } from "./modelFamily.js";
import { providerKeyFor } from "../providerFingerprint.js";

/** 席位侧事实：registry 归一化条目 → 与 run.started 同形的四元组指纹 + 族系。
 *  条目缺席（自报 id 不在注册表）= laneFingerprint null + resolution unknown-agent
 *  ——关系判定自然落 unknown，不猜。 */
export function seatFactsFromRegistry(seatIds, agentsById) {
  return (seatIds ?? []).map((id) => {
    const agent = agentsById?.get?.(id) ?? agentsById?.[id] ?? null;
    if (!agent || typeof agent !== "object") {
      return { agentId: id, laneFingerprint: null, modelId: null, family: UNKNOWN_FAMILY, registryResolution: "unknown-agent" };
    }
    const identity = {
      backend: typeof agent.backend === "string" ? agent.backend : null,
      modelId: agent.model && typeof agent.model.id === "string" ? agent.model.id : null,
      providerID: agent.model && typeof agent.model.providerID === "string" ? agent.model.providerID : null,
      providerKey: providerKeyFor(agent.provider) ?? null,
    };
    const hasAnyAxis = identity.backend !== null || identity.modelId !== null;
    return {
      agentId: id,
      // 与作者侧对称：任一轴在场即可派生指纹（providerKey 缺席=显式 null——
      // 同 run.started 的三态纪律，两侧同形故可比）。
      laneFingerprint: hasAnyAxis ? laneFingerprint(identity) : null,
      modelId: identity.modelId,
      family: modelFamilyOf({ modelId: identity.modelId, backend: identity.backend }),
      registryResolution: "ok",
    };
  });
}

/** 作者侧观察闭集（记录携带，不静默）：
 *  derived（读到 run.started 且能派生身份）/ missing_started（转录可读但无
 *  run.started）/ unreadable（转录不可读/不可解析）/ not_provided（未给旗标）。 */
async function observeAuthor(runId, { readEventsFn, resolvePathFn, runDir }) {
  let events = null;
  try {
    const path = resolvePathFn(runDir, runId);
    events = await readEventsFn(path);
  } catch {
    return { runId, observation: "unreadable", agentId: null, laneFingerprint: null, modelId: null, family: null };
  }
  const started = (events ?? []).find((e) => e && e.type === "run.started" && e.runId === runId);
  if (!started) return { runId, observation: "missing_started", agentId: null, laneFingerprint: null, modelId: null, family: null };
  const identity = deriveStartedIdentity(started);
  if (!identity) return { runId, observation: "missing_started", agentId: null, laneFingerprint: null, modelId: null, family: null };
  return {
    runId,
    observation: "derived",
    agentId: typeof started.agentId === "string" ? started.agentId : null,
    laneFingerprint: laneFingerprint(identity),
    modelId: identity.modelId,
    family: identity.modelId === null ? UNKNOWN_FAMILY : modelFamilyOf({ modelId: identity.modelId, backend: identity.backend }),
  };
}

/** 多作者合并（fail-closed）：same_lane（任一）> unknown（任一缺事实）> different_lane。 */
function mergeAuthorRelation(perAuthor) {
  const comparable = perAuthor.filter((r) => r !== "unknown");
  if (comparable.some((r) => r === "same_lane")) return "same_lane";
  if (comparable.length < perAuthor.length || perAuthor.length === 0) return "unknown";
  return "different_lane";
}

/** 族系同款合并：same（任一作者同族）> unknown（任一不可比）> cross。 */
function mergeFamilyRelation(perAuthor) {
  const comparable = perAuthor.filter((r) => r !== "unknown");
  if (comparable.some((r) => r === "same")) return "same";
  if (comparable.length < perAuthor.length || perAuthor.length === 0) return "unknown";
  return "cross";
}

/**
 * 派生编排（异步：作者侧读转录）。席位侧事实由调用方从 registry 构造
 * （seatFactsFromRegistry）；作者侧本函数读各 reviewed run 的 run.started。
 *
 * @param {object} input
 * @param {Array<{agentId, laneFingerprint: string|null, modelId: string|null,
 *   family: string, registryResolution: string}>} input.seatFacts
 * @param {string[]} [input.reviewedRunIds] 被审 run（0..n；空=无作者上下文）
 * @param {string} input.runDir
 * @param {Function} input.readEventsFn (path) => events[]
 * @param {Function} input.resolvePathFn (runDir, runId) => path
 */
export async function derivePanelFacts({ seatFacts, reviewedRunIds = [], runDir, readEventsFn, resolvePathFn }) {
  const authors = [];
  for (const runId of reviewedRunIds) {
    authors.push(await observeAuthor(runId, { readEventsFn, resolvePathFn, runDir }));
  }
  const derivedAuthors = authors.filter((a) => a.observation === "derived");

  // 车道关系：复用 deriveIndependenceRelations 逐作者调用（同一判定权威），
  // 席位侧逐作者合并（same > unknown > different——fail-closed）。
  // 不可读/缺 started 的作者以 unknown 参与合并（不滤出——滤出会把"部分作者
  // 缺事实"折叠成"全部回避"，违反 fail-closed；实施期测试实锤）。
  const perSeat = (seatFacts ?? []).map((f) => {
    const perAuthorLane = authors.map((a) => (a.observation === "derived"
      ? deriveIndependenceRelations({
        seatFacts: [f],
        authorFacts: { laneFingerprint: a.laneFingerprint, modelId: a.modelId },
      }).seats[0].authorRelation
      : "unknown"));
    const perAuthorFamily = authors.map((a) => {
      if (a.observation !== "derived") return "unknown";
      if (f.family === UNKNOWN_FAMILY || a.family === UNKNOWN_FAMILY) return "unknown";
      return f.family === a.family ? "same" : "cross";
    });
    return {
      agentId: f.agentId,
      laneFingerprint: f.laneFingerprint,
      modelId: f.modelId,
      family: f.family,
      registryResolution: f.registryResolution ?? "ok",
      authorRelation: mergeAuthorRelation(perAuthorLane),
      familyVsAuthors: mergeFamilyRelation(perAuthorFamily),
    };
  });

  // 席位间两两族系事实（stage 2 方案会审无作者上下文时的主事实——sol P1）。
  const pairwise = [];
  for (let i = 0; i < perSeat.length; i++) {
    for (let j = i + 1; j < perSeat.length; j++) {
      const a = perSeat[i];
      const b = perSeat[j];
      pairwise.push({
        a: a.agentId,
        b: b.agentId,
        familyRelation: a.family === UNKNOWN_FAMILY || b.family === UNKNOWN_FAMILY ? "unknown" : (a.family === b.family ? "same" : "cross"),
      });
    }
  }

  const authorContext = reviewedRunIds.length === 0 ? "not_provided"
    : derivedAuthors.length === reviewedRunIds.length ? "derived"
      : derivedAuthors.length === 0 ? "unreadable_or_missing"
        : "partial";

  return {
    authorContext,
    reviewedRunIds: [...reviewedRunIds],
    authors: authors.map((a) => ({
      runId: a.runId, observation: a.observation,
      agentId: a.agentId, laneFingerprint: a.laneFingerprint, modelId: a.modelId, family: a.family,
    })),
    seats: perSeat,
    pairwise,
    authorAvoidanceViolations: perSeat.filter((s) => s.authorRelation === "same_lane").map((s) => s.agentId),
    // 来源声明（sol P1：记录必须携带；自报席位富化≠实际会审验证）。
    basis: "seats=registry 当前配置事实（登记时快照）；authors=各被审 run 的 run.started 钉住事实（车道指纹比对）。车道不同=对抗前提成立，非对抗成立（0019 §3 其余回避规则仍由 Lead 判断）；本派生不证明实际评审发生。",
  };
}
