// src/application/identityProjection.js
//
// 0045 §1.5 读取侧：历史身份自描述派生 + 冻结 legacy 席位名闭集 + 投影三态。
//
// 合同（决定 0045，Owner 2026-10-05 签署）：
//   - 历史 lane 身份从记录自带事实派生（run.started 的 backend/model/providerID/
//     providerKey/reasoning），**不从当前注册表倒推**——"researcher → 当前某 lane
//     不是历史映射，是把过去改成现在"（R2 会审 auditor 裁定）。
//   - 冻结 legacy 席位名闭集：仅显示用（让离册名如实显示原名而非折叠 unknown），
//     git 跟踪；名单损坏/缺项时投影退回 unknown，可见可接受。扩集=蓄意事件
//     （更新本文件 + 同步 identityProjection.test.js 的冻结钉）。
//   - 身份投影三态闭集：normal（在册）/ legacy（离册但在冻结名单）/ unknown。
//   - 车道内容指纹（§1.1）：四元组 {backend, model.id, providerID, providerKey}
//     的稳定哈希——认证门 matchedCertRecord 已在比对的同一集合；effort 是车道
//     默认参数，**不进指纹**。
//
// 架构契约：纯函数模块——不 import registry/命令层/MCP，不做任何 I/O（读真实
// 案卷的一次性验证已随 0045 迁移完成）；依赖仅
// node:crypto。消费面接线（runList/registryInventory 换显示）在 0045 §6 第 3 步
// 写侧批——本模块先落地先验证，不改任何既有投影行为（§6 "第 0–2 步不改行为"）。
import { createHash } from "node:crypto";

/**
 * 冻结的 legacy 席位名闭集（0045 §1.5，2026-10-05 冻结）。
 * 数据驱动来源：runs/ 全部 590 份真实转录的事件 agentId 全集扫描（12 名：
 * 在册 9 + 退役 3；0046 ·2 步②️ 扩编 6 车道旧键）。仅显示用；扩集须同步更新
 * test/migration-0045/identityProjection.test.js 的冻结钉。
 */
export const LEGACY_AGENT_NAMES = Object.freeze([
  "claude-opus",
  "coder",
  "coder_hq",
  "coder_low",
  "coder_low_dsh",
  "coder_mm",
  "coder_temp",
  "glm_worker",
  "parallel-verify",
  "researcher",
  "auditor",
  "auditor_claude",
  "tester",
  // 0046 µ2 步②️ 重键扩编：6 个车道旧键陈历史名
  "ds-acp",
  "gpt-astra",
  "gpt-sol-56",
  "gpt-sol-61",
  "kimi-k3",
]);

/** 身份投影三态闭集（0045 §1.5 原文用词）。 */
export const IDENTITY_PROJECTION_STATES = Object.freeze(["normal", "legacy", "unknown"]);

/**
 * 从 run.started 事件的自带事实派生历史 lane 身份（§1.5 自描述派生）。
 * 字段如实传递：providerKey 字段在真实案卷里存在但常为 null（580 在场/159 为
 * 字符串，2026-10-05 实测）——null ≠ undefined ≠ 字符串，三者都原样保留，
 * 不补写、不归一（R23-C missing/null/value 区分纪律的读取侧同款）。
 * 最低可派生判据：backend 或 model.id 至少一项在场（与 matchedCertRecord 的
 * 比较轴一致）；全缺 → null（如实"未记录"，不伪造）。
 * @param {object|null|undefined} started - run.started 事件载荷
 * @returns {{backend:(string|null), modelId:(string|null), providerID:(string|null),
 *            providerKey:(string|null), reasoningEffort:(string|null)}|null}
 */
export function deriveStartedIdentity(started) {
  if (!started || typeof started !== "object") return null;
  const backend = typeof started.backend === "string" ? started.backend : null;
  const modelId = started.model && typeof started.model.id === "string" ? started.model.id : null;
  if (backend === null && modelId === null) return null;
  return {
    backend,
    modelId,
    providerID: started.model && typeof started.model.providerID === "string"
      ? started.model.providerID
      : null,
    providerKey: typeof started.providerKey === "string" ? started.providerKey : null,
    reasoningEffort: started.reasoning && typeof started.reasoning.effort === "string"
      ? started.reasoning.effort
      : null,
  };
}

/**
 * 0045 R5（W4a）：台账键派生——tri-state 严格（undefined=从未观察 / null=已观察
 * 无 / string=有值，三种各成键成分，与 R23-C 记录纪律同轴）。认证写入器
 * （certification.mjs）与迁移器共用本 SSOT；键形 lane:<16hex>。
 * 与 laneFingerprint（null 归并版，读取侧展示用）刻意不同：台账身份必须保真
 * 三态——R4 auditor 阻断项"laneFingerprint 合并缺失与 null"的修正落点。
 */
export function laneLedgerKey(declared) {
  // 三态哨兵以 U+0000 开头，与任何 `s:` 值都不相撞；台账已按这些键落盘（冻结见
  // test/migration-0045/laneKeyedWriter.test.js KEYW-2b）。
  const enc = (v) => (v === undefined ? "\u0000u" : v === null ? "\u0000n" : `s:${v}`);
  const tuple = JSON.stringify([enc(declared?.backend), enc(declared?.modelId), enc(declared?.providerID), enc(declared?.providerKey)]);
  return "lane:" + createHash("sha256").update(tuple, "utf8").digest("hex").slice(0, 16);
}

/**
 * 车道内容指纹（0045 §1.1）：四元组 {backend, model.id, providerID, providerKey}
 * 的稳定短哈希。键序固定（canonical JSON）——同四元组跨进程跨时间同指纹；
 * effort 不进指纹（车道默认参数非身份）。null 与 undefined 归一为 null（指纹
 * 关心取值不关心字段在场性——在场性纪律属于派生层，不属于指纹层）。
 * @param {{backend:string|null, modelId:string|null, providerID:string|null,
 *          providerKey:string|null}} identity
 * @returns {string} "lane:" + sha256 前 16 hex
 */
export function laneFingerprint(identity) {
  const tuple = {
    backend: identity?.backend ?? null,
    modelId: identity?.modelId ?? null,
    providerID: identity?.providerID ?? null,
    providerKey: identity?.providerKey ?? null,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(tuple), "utf8")
    .digest("hex");
  return `lane:${digest.slice(0, 16)}`;
}

/**
 * 身份投影三态（0045 §1.5）。
 *   normal  —— agentId 在当前注册表（knownAgentIds）：显示原名。
 *   legacy  —— 不在注册表但在冻结 legacy 名单：显示原名（史实名）。
 *   unknown —— 两边都不在：维持现行 unknown 折叠（名单损坏退回此态，可见）。
 * 身份派生与名字状态**正交**（R2 会审 coder_hq 陷阱：名字在册≠当时车道=今天
 * 车道，其 claude-code 时代 121 份记录与 zcode 时代 28 份是两条不同车道）——
 * 任何状态的记录都从自身 started 事实派生 identity+指纹；缺 started/缺字段 →
 * identity=null（如实"未记录"，不伪造）。
 * @param {{agentId:(string|null|undefined), started?(object|null),
 *          knownAgentIds:string[]}} input
 * @returns {{state:("normal"|"legacy"|"unknown"), displayName:(string|null),
 *            identity:object|null, fingerprint:(string|null)}}
 */
export function projectAgentIdentity({ agentId, started, knownAgentIds }) {
  const known = Array.isArray(knownAgentIds) ? knownAgentIds : [];
  const name = typeof agentId === "string" ? agentId : null;
  const identity = deriveStartedIdentity(started ?? null);
  const fingerprint = identity === null ? null : laneFingerprint(identity);
  if (name !== null && known.includes(name)) {
    return { state: "normal", displayName: name, identity, fingerprint };
  }
  if (name !== null && LEGACY_AGENT_NAMES.includes(name)) {
    return { state: "legacy", displayName: name, identity, fingerprint };
  }
  return { state: "unknown", displayName: null, identity, fingerprint };
}
