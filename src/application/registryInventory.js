// src/application/registryInventory.js
//
// M9-0: Shared application service for registry inventory.
//
// This module is the single owner of the registry list data logic:
// reading agents.json, joining reliability-summary.json certification
// status, and resolving model display labels.
//
// It also owns the displayModel SSOT — the model label resolution logic
// lives here, and src/commands/shared.js re-exports it to preserve the
// existing public contract.
//
// This service performs read-only file I/O (registry + reliability summary).
// It does not import from src/commands/*, does not parse CLI args,
// does not write to console, does not set process.exit, does not depend
// on MCP, does not modify files. (M11-7: it probes whether registry-declared
// credential env NAMES are present — names only; it never surfaces values.)

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readRegistry, normalizeAgent } from "../registry.js";
import { isValidCanonicalAgentId } from "../canonicalAgentId.js";
import { assessWorkerReadiness, createEnvResolver } from "./credentialReadiness.js";
// TD-111: certification advisory context 闭集 SSOT——投影层用它做 fail-closed 校验：
// summary 里的越界码/非 ISO 日期绝不透出（否则 MCP outputSchema 的 enum parse 会把
// 整个 registry_list 打成 error）。MCP schema 的 enum 也从同一常量派生（无第二份清单）。
import { CERTIFICATION_REASON_CODES } from "./certificationReasons.js";
// TD-131: 认证身份匹配 SSOT 从 core 下向复用（../runManager.js 的
// matchedCertRecord——与 runDispatch.js 消费 R10-A/R11-1 覆盖校验器同一
// application→core 下向纪律）。显示层投影与 P1-1 派发门共用同一判定，
// 不存在第二套 identity 匹配规则。
import { matchedCertRecord } from "../runManager.js";
// TD-186：声明侧 providerKey 派生与 matchedCertRecord 记录侧同一 SSOT
// （src/providerFingerprint.js 单一实现，无第二套归一化）。
import { providerKeyFor } from "../providerFingerprint.js";

// ===== M12-6 FR-02: provider readiness truth SSOT =====
//
// Strict truth projection: these fields state ONLY what THIS inventory call
// actually observed — the registry entry was configured, and authentication /
// entitlement / live status were NOT probed (this package never makes provider
// network requests and never reads credential values). The MCP wire schemas
// derive their enums from these frozen arrays (z.enum(CONFIGURATION_STATUSES)
// etc.), so it is structurally impossible for any worker to be projected as
// authenticated/entitled/checked from this inventory path.
//
// The single-element arrays are deliberate: the closed set for each field is
// exactly one value today. Adding a second value requires changing this SSOT —
// there is no second hand-maintained enum to drift.

export const CONFIGURATION_STATUSES = Object.freeze(["configured"]);
export const AUTHENTICATION_STATUSES = Object.freeze(["unknown"]);
export const ENTITLEMENT_STATUSES = Object.freeze(["unknown"]);
export const LIVE_CHECK_STATUSES = Object.freeze(["not_checked"]);

// ===== M12-25 (Outcome 1): bounded safe registry-issue projection =====
//
// When the registry source is readable but one entry cannot be
// normalized/projected, the partial inventory path returns the VALID agents
// PLUS a bounded per-entry issue list instead of aborting the whole list. The
// issue shape is deliberately closed and safe:
//   - code: a CLOSED set. "invalid_id" = the agent id is not canonical; the raw
//     id is NEVER echoed (it could be sensitive or an injection payload).
//     "invalid_configuration" = canonical id but backend/cwd/model/provider/
//     sessionReuse/waitTimeout/systemPrompt validation failed.
//   - agentId: projected ONLY when the id is canonical; otherwise null.
//   - No raw error text, config, path, or credential value is ever carried.
// The MCP wire schemas derive their enums from this frozen array (single SSOT),
// so a malformed/injected issue code can never reach the model.
export const REGISTRY_ISSUE_CODES = Object.freeze(["invalid_id", "invalid_configuration"]);
// Cap on per-entry issues returned (defensive against a pathological registry).
// The true malformed count is unbounded; issuesTruncated reports when the cap
// was hit. Exported so the MCP output schema can enforce the SAME bound.
export const REGISTRY_ISSUES_CAP = 32;

/**
 * Build the strict providerReadiness object for one worker.
 * credentialAvailability (existing closed set) is embedded so the Lead sees
 * registry-config truth and credential-presence truth together.
 * @param {"available"|"missing"|"not_required"} credentialAvailability
 * @returns {{configurationStatus: string, authenticationStatus: string, entitlementStatus: string, liveCheckStatus: string, credentialAvailability: string}}
 */
export function buildProviderReadiness(credentialAvailability) {
  return {
    configurationStatus: "configured",
    authenticationStatus: "unknown",
    entitlementStatus: "unknown",
    liveCheckStatus: "not_checked",
    credentialAvailability,
  };
}

// ===== Private helpers (owned by this module) =====

/**
 * Resolve the model display label for an agent.
 * M11-9: reads the structured `model.id` field (the canonical source after
 * normalization). The legacy args/prependArgs fallbacks are removed — the
 * normalizer already extracted them to structured fields, so there is no
 * second authority to search. provider.model is gone (forbidden by contract).
 * @param {object} agent — normalized agent from registry
 * @returns {string}
 */
export function displayModel(agent) {
  if (typeof agent.model === "string") return agent.model;
  return agent.model?.id
    ?? (["claude-code", "codex", "kimi-code", "deepseek-harness", "deepseek-acp"].includes(agent.backend) ? "(default)" : "-");
}

// ===== Service implementation =====

/**
 * Read reliability-summary.json and build a certification record map.
 * Returns {} on missing file or corrupted JSON (no throw).
 * @param {string} runDir
 * @param {Function} [customReadFile] — injectable for testing
 * @returns {Promise<Record<string, string>>}
 */
async function buildCertMap(runDir, customReadFile) {
  if (!runDir) return {};
  const _readFile = customReadFile ?? readFile;
  try {
    const raw = await _readFile(join(runDir, "reliability-summary.json"), "utf8");
    const summary = JSON.parse(raw);
    const certMap = {};
    for (const [id, w] of Object.entries(summary?.workers ?? {})) {
      certMap[id] = {
        status: w.status ?? "-",
        backend: w.backend,
        modelId: w.modelId,
        // TD-131: providerID 透传（此前在此被丢弃——投影层想做该维度比对也拿不到）。
        // 匹配规则见 matchedCertRecord：仅记录与 agent 双侧声明时才比对。
        providerID: w.providerID,
        // R23-C：providerKey 透传（TD-131 同款坑——投影层共用 matchedCertRecord 做
        // 该维比对必须拿得到）。原样保真三态：undefined = legacy 记录（维度跳过），
        // null = 已观察无接入方——绝不能在此归一成 null 抹掉 undefined/null 差异。
        providerKey: w.providerKey,
        // TD-111: 旧 summary（缺字段）→ undefined → 投影层归一为 null，不伪造。
        reasonCode: w.reasonCode ?? null,
        lastHealthyRunAt: w.lastHealthyRunAt ?? null,
      };
    }
    return certMap;
  } catch {
    return {};
  }
}

/**
 * Get registry inventory — the structured data behind `registry list`.
 *
 * @param {object} input
 * @param {string} input.registryPath — path to agents.json
 * @param {string} [input.runDir] — path to runs/ dir (for reliability-summary.json)
 * @param {Function} [input.readRegistryFn] — injectable readRegistry for testing
 * @param {Function} [input.readFileFn] — injectable readFile for testing
 * @param {Function} [input.userEnvReader] — injectable Windows user-env reader (M11-7)
 * @returns {Promise<Array<{id, backend, model, certification, cwd, credentialAvailability, missingCredentialEnvNames, providerReadiness}>>}
 *   providerReadiness — M12-6 FR-02 strict truth object (configurationStatus
 *   "configured"; authenticationStatus/entitlementStatus "unknown";
 *   liveCheckStatus "not_checked"). Never filled with probed values: this
 *   service performs no provider network request and never reads credential
 *   values, so it can never claim authenticated/entitled/checked.
 */
export async function getRegistryInventory({
  registryPath,
  runDir,
  readRegistryFn,
  readFileFn,
  userEnvReader,
}) {
  const _readRegistry = readRegistryFn ?? readRegistry;
  const registry = await _readRegistry(registryPath);
  const certMap = await buildCertMap(runDir, readFileFn);

  // M11-7 (operation closeout): ONE operation-scoped resolver shared across all
  // workers, and resolve ONLY the required credential names (registry_list shows
  // credentialAvailability, which depends solely on required names). Optional
  // inherited env (OPENAI_BASE_URL, CODEX_HOME, KIMI_MODEL_NAME, ...) is NOT read
  // here — it is irrelevant to the availability status and would add unnecessary
  // cold-start cost. Two workers sharing a required name read it at most ONCE.
  const resolver = createEnvResolver(userEnvReader);
  const results = [];
  for (const agent of registry.listAgents()) {
    const readiness = await assessWorkerReadiness({ agent, resolver });
    results.push(projectInventoryEntry(agent, certMap, readiness));
  }
  return results;
}

/**
 * M12-25: the SINGLE deterministic safe projection for registry issues at every
 * public adapter boundary — used by getRegistryInventoryWithIssues (the partial
 * projector), aggregateLeadPreflight, and the MCP registry_list handler — so the
 * closed-set / canonical-id / cap / truncation rules live in ONE place, not three.
 *
 * Bounds the result to REGISTRY_ISSUES_CAP and derives issuesTruncated = the
 * source's own truncation flag OR the supplied array exceeding the cap (a
 * malicious/injected resolver that passes >cap issues with
 * issuesTruncated:false still reports truncation). Each issue is reduced to the
 * safe {code, agentId} shape: code must be in the frozen closed set (else
 * collapses to "invalid_configuration"); agentId is projected ONLY when
 * canonical, else null. Never carries raw error text, config, path, credential,
 * or any other injected field. Every supplied array element is projected
 * (M12-25C): a malformed/non-object element becomes {invalid_configuration,
 * null} rather than being filtered away, so a bad element can never vanish into
 * a clean result — and it still counts toward the cap/truncation.
 *
 * @param {Array<{code?:string, agentId?:string}>|null|undefined} rawIssues
 * @param {boolean} [sourceTruncated] — truncation flag from the upstream source.
 * @returns {{issues: Array<{code:string, agentId:string|null}>, issuesTruncated: boolean}}
 */
export function projectRegistryIssues(rawIssues, sourceTruncated = false) {
  // M12-25C: project EVERY supplied array element into the safe closed shape —
  // a malformed element (null / primitive / object without a valid code) must
  // NOT disappear into a clean result; it becomes {invalid_configuration, null}.
  // Cap, truncation, closed-set code, canonical-id-or-null, and no-leak still
  // hold; truncation now counts every projected element (malformed included).
  const cleaned = (Array.isArray(rawIssues) ? rawIssues : []).map((i) => {
    const isObj = i && typeof i === "object";
    return {
      code: isObj && REGISTRY_ISSUE_CODES.includes(i.code) ? i.code : "invalid_configuration",
      agentId: isObj && typeof i.agentId === "string" && isValidCanonicalAgentId(i.agentId)
        ? i.agentId
        : null,
    };
  });
  return {
    issues: cleaned.slice(0, REGISTRY_ISSUES_CAP),
    issuesTruncated: Boolean(sourceTruncated) || cleaned.length > REGISTRY_ISSUES_CAP,
  };
}

/**
 * M12-25B: the SINGLE shared normalization of an inventory result at every
 * public adapter boundary — the lead_preflight aggregator, MCP registry_list,
 * the MCP lead_preflight snapshot, and MCP runs_list all consume the default
 * service (getRegistryInventoryWithIssues) or an injected resolver through THIS
 * one function. Accepts exactly the two VALID shapes and THROWS on anything
 * else, so every caller in a try/catch FAILS CLOSED to unknown/error: a
 * null/malformed injected resolver can never masquerade a read failure as an
 * observed-empty (zero-worker) registry. "Could not read" must stay distinct
 * from "read, and there are zero agents".
 *
 * Valid shapes:
 *   - legacy bare array (strict getRegistryInventory / documented direct-
 *     application input) → {agents: <array>, issues: [], issuesTruncated: false}
 *   - partial projection {agents: Array, issues?: Array, issuesTruncated?: boolean}
 *
 * Invalid (throws): null, undefined, a primitive, an object whose `agents`
 * is not an array, OR a present-but-wrong-typed facet (a non-array `issues` or
 * a non-boolean `issuesTruncated`; null counts as present-but-wrong). Only an
 * absent (undefined) optional facet defaults. A genuinely empty-but-readable
 * registry is a VALID empty array (or {agents: []}) — it normalizes to
 * agents:[] (observed-empty), NOT unknown; only a null/malformed result throws.
 * The issues facet is carried through ONLY as-is; callers apply
 * projectRegistryIssues to bound/sanitize it.
 *
 * Idempotent: a normalized {agents, issues, issuesTruncated} re-normalizes to
 * itself, so a caller may normalize eagerly (e.g. for knownAgentIds) and replay
 * the normalized snapshot to an aggregator that normalizes again.
 *
 * @param {*} result
 * @returns {{agents: Array, issues: Array, issuesTruncated: boolean}}
 */
export function normalizeInventoryResult(result) {
  if (Array.isArray(result)) {
    return { agents: result, issues: [], issuesTruncated: false };
  }
  if (result && typeof result === "object" && Array.isArray(result.agents)) {
    // M12-25C narrow truth boundary: a PRESENT-but-wrong-typed facet is
    // malformed (an injected resolver must not smuggle issues:"bad" /
    // issuesTruncated:"false" through as an apparently clean inventory). Only
    // an ABSENT (undefined) optional facet defaults; null counts as
    // present-but-wrong. A valid empty issues array ([]) stays observed-clean.
    if (result.issues !== undefined && !Array.isArray(result.issues)) {
      throw new Error("malformed inventory result");
    }
    if (result.issuesTruncated !== undefined && typeof result.issuesTruncated !== "boolean") {
      throw new Error("malformed inventory result");
    }
    return {
      agents: result.agents,
      issues: Array.isArray(result.issues) ? result.issues : [],
      issuesTruncated: typeof result.issuesTruncated === "boolean" ? result.issuesTruncated : false,
    };
  }
  throw new Error("malformed inventory result");
}

/**
 * M12-25: Partial registry inventory — the structured data behind MCP
 * `registry_list` / `lead_preflight` when the registry source is READABLE but
 * contains one or more malformed/unsupported entries.
 *
 * Distinct from the strict getRegistryInventory (CLI `registry list`/`validate`
 * stay strict — they throw on the first bad entry). This SEPARATE projection
 * reads/normalizes each entry individually: a valid entry is projected exactly
 * as getRegistryInventory would (parity via the shared projectInventoryEntry);
 * an entry that fails normalization produces ONE bounded safe issue instead of
 * aborting the list. A whole-file unreadable/invalid-JSON source is a DISTINCT
 * failure — it throws here (readRegistry reads+JSON.parses once), never faked as
 * a partial result. Zero valid entries WITH issues is NOT an observed-clean
 * empty registry (the issues array is non-empty).
 *
 * @param {object} input — same shape as getRegistryInventory
 * @returns {Promise<{agents: Array, issues: Array<{code:string, agentId:string|null}>, issuesTruncated: boolean}>}
 */
export async function getRegistryInventoryWithIssues({
  registryPath,
  runDir,
  readRegistryFn,
  readFileFn,
  userEnvReader,
}) {
  const _readRegistry = readRegistryFn ?? readRegistry;
  // Read/parse the registry source ONCE. readRegistry throws on a missing file
  // or invalid JSON — that is a whole-source failure, NOT a per-entry issue, so
  // it propagates (the caller surfaces a hard error; never a faked partial list).
  const registry = await _readRegistry(registryPath);
  const certMap = await buildCertMap(runDir, readFileFn);
  const resolver = createEnvResolver(userEnvReader);

  const agents = [];
  const rawIssues = [];
  for (const [id, raw] of registry.rawEntries()) {
    try {
      const agent = normalizeAgent(id, raw);
      const readiness = await assessWorkerReadiness({ agent, resolver });
      agents.push(projectInventoryEntry(agent, certMap, readiness));
    } catch {
      // One malformed/unsupported entry must NOT abort the list. Record a raw
      // safe issue; the shared projector (single SSOT) bounds + truncates +
      // sanitizes it — never the raw error text / config / path / credential.
      const canonical = isValidCanonicalAgentId(id);
      rawIssues.push({
        code: canonical ? "invalid_configuration" : "invalid_id",
        agentId: canonical ? id : null,
      });
    }
  }
  return { agents, ...projectRegistryIssues(rawIssues, false) };
}

/**
 * Project ONE normalized agent into the inventory entry shape. Shared by the
 * strict getRegistryInventory and the partial getRegistryInventoryWithIssues so
 * a valid entry is projected identically in both paths (M9-1-07 CLI/MCP parity
 * is preserved — the MCP agents array deep-equals the strict service output for
 * an all-valid registry).
 */
function projectInventoryEntry(agent, certMap, readiness) {
  // TD-111: certification 与两新 advisory 字段共用同一 identity 匹配规则
  // （backend/modelId 不一致 → 认证不可继承，新字段同样不继承）。
  const certRecord = matchedCertRecord(agent, certMap[agent.id]);
  return {
    id: agent.id,
    backend: agent.backend,
    model: displayModel(agent),
    // M11-9: reasoningEffort from structured field. null when absent (runtime
    // default) — never fabricated, never reverse-parsed from args.
    reasoningEffort: agent.reasoning?.effort ?? null,
    certification: certRecord ? certRecord.status : null,
    // TD-111: certification advisory context（并列新增；certificationFor 返回类型不变）。
    // 闭集外的码 / 非 bounded ISO 形状的日期 fail-closed 为 null，绝不透出。
    certificationReasonCode: boundedReasonCode(certRecord?.reasonCode),
    certificationLastHealthyAt: boundedIsoOrNull(certRecord?.lastHealthyRunAt),
    cwd: agent.cwd,
    // M11-11C: project the configured reuse mode so the Lead sees which
    // experts retain a provider-native conversation across turns. Nullable —
    // most agents do not configure sessionReuse.
    sessionReuse: agent.sessionReuse ?? null,
    credentialAvailability: readiness.credentialAvailability,
    missingCredentialEnvNames: readiness.missingCredentialEnvNames,
    // M12-6 FR-02: strict truth — never claims authenticated/entitled/live.
    providerReadiness: buildProviderReadiness(readiness.credentialAvailability),
  };
}

// TD-111 → TD-131: 单一 identity 匹配规则（matchedCertRecord，TD-131 起自
// ../runManager.js 下向复用，与 P1-1 派发门共用）——summary 记录的 backend/modelId
// （providerID 双侧声明时同比对）与 registry 当前 identity 不一致 → 认证不可继承
// （原 certificationFor 语义，certification 输出 = matched ? matched.status : null，
// 行为不变；两新 advisory 字段共用同一规则）。本模块不再持有私有副本。

// TD-111: 闭集校验——summary 是磁盘数据，可能陈旧/被改；越界码 fail-closed 为 null
// （透出会使 MCP enum parse 把整个工具打成 error）。
function boundedReasonCode(code) {
  return CERTIFICATION_REASON_CODES.includes(code) ? code : null;
}

// TD-111: bounded ISO-8601 UTC 日期字符串（new Date().toISOString() 形状，允许 0-3
// 位毫秒；长度上限防御）。非字符串/不匹配 → null，绝不透出任意文本。
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
function boundedIsoOrNull(value) {
  return typeof value === "string" && value.length <= 32 && ISO_UTC_RE.test(value) ? value : null;
}

// =====================================================================
// TD-186（2026-09-22）：只读认证证据详情 + 适用性三态。
//
// 背景（实证）：auditor 席位 effort medium→high 后重取证，summary 里
// status=certified、时间戳刷新，但记录不表达执行画像（effort=null）且 caseId
// 仍带旧档位字样——旧档证据被读成"当前画像已认证"。
//
// 边界（本节全部承诺）：
//   - 只读：本节不写文件、不派生"总体可用=true"之类的任何布尔 verdict——
//     五列只陈述事实（声明/组件观测/组合结果/证据适用性/限制与来源）。
//   - 三态闭集：matched / mismatched / undeterminable。"undeterminable 绝不算绿"：
//     它只描述"证据是否适用于当前声明画像"，不描述席位质量；适用性列永远与
//     组合结果列并列呈现，不存在合并二者的单一绿。
//   - 来源状态保真：不复用有损的 buildCertMap（缺文件/坏 JSON/读取错误都被吞成
//     空映射）——详情读取器把 missing / unparseable / read-error 分别可辨。
//   - 派发门零改动：matchedCertRecord / --require-certified 语义一律不动
//     （effort 纳入派发身份是 Owner 级决定）；本节的 identity 判定【复用】
//     matchedCertRecord 作为 SSOT 裁决，display 维度明细仅辅助阅读。
// =====================================================================

// 证据适用性三态闭集（frozen；MCP/CLI 展示共用，无第二份清单）。
export const CERT_EVIDENCE_APPLICABILITY = Object.freeze(["matched", "mismatched", "undeterminable"]);

// 详情读取的台账文件状态闭集（来源状态保真——绝不折叠成"空"）。
export const CERT_LEDGER_SOURCE_STATES = Object.freeze(["ok", "missing", "unparseable", "read-error"]);

// 组件层台账文件名（ADR-0032 §5：与 reliability-summary.json 分文件共证据）。
const COMPONENT_LEDGER_FILENAME = "component-checks.json";
// 组件观测投影上限（防御病态台账；超出截断并在 state 注明）。
const COMPONENT_OBSERVATION_CAP = 8;
// 组件层结果闭集（ADR-0032 §1；磁盘数据可能被改，闭集外 → null 不透出）。
const COMPONENT_RESULT_CLOSED_SET = ["pass", "fail", "blocked"];
// 30 天审阅提醒窗（componentLedger.mjs DEFAULT_MAX_AGE_DAYS 同值；此处只是
// 只读提示的计算常数，不是门）。
const EVIDENCE_REVIEW_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

function boundedTextOrNull(value, max) {
  return typeof value === "string" && value.length <= max ? value : null;
}

/**
 * 读一个台账文件并保真来源状态（TD-186 详情路径专用；buildCertMap 的有损
 * 吞错行为保持不变——旧简表不受影响）。三态：missing（ENOENT）/
 * unparseable（JSON 坏或形状坏）/ read-error（其它读失败）。绝不回显原始
 * error 文本（磁盘/路径细节不入投影）；状态本身就是可辨信号。
 * @private
 */
async function readLedgerSourceState(filePath, readFileFn) {
  const _readFile = readFileFn ?? readFile;
  let raw;
  try {
    raw = await _readFile(filePath, "utf8");
  } catch (error) {
    return { state: error?.code === "ENOENT" ? "missing" : "read-error" };
  }
  try {
    return { state: "ok", data: JSON.parse(raw) };
  } catch {
    return { state: "unparseable" };
  }
}

/**
 * 组合层台账（reliability-summary.json）详情读取：workers 非 plain object →
 * unparseable（形状坏与"无记录"严格区分）。
 * @private
 */
async function readReliabilityLedgerDetail(runDir, readFileFn) {
  if (!runDir) return { state: "missing", workers: null };
  const source = await readLedgerSourceState(join(runDir, "reliability-summary.json"), readFileFn);
  if (source.state !== "ok") return { state: source.state, workers: null };
  const workers = source.data?.workers;
  if (!workers || typeof workers !== "object" || Array.isArray(workers)) {
    return { state: "unparseable", workers: null };
  }
  return { state: "ok", workers };
}

/**
 * 组件层台账（component-checks.json）只读观测：按席位 backend 前缀
 * （backend:<name>@）与可派生的 llm 前缀（llm:<providerID>/<modelId>@）列出
 * 观测到的记录（有界投影，闭集校验）。这是观测不是判定：六态分类
 * （stale/blocked/…）的 SSOT 在 scripts/reliability/componentLedger.mjs
 * （src 不得上向 import），此处只投影磁盘事实。
 * @private
 */
async function observeComponentLedgerForSeat({ runDir, readFileFn, agent }) {
  const empty = (llmKeyDerivable) => ({ state: "missing", llmKeyDerivable, backend: [], llm: [], truncated: false });
  const providerID = agent.model?.providerID ?? null;
  const modelId = agent.model?.id ?? null;
  const llmKeyDerivable = providerID !== null && modelId !== null;
  if (!runDir) return empty(llmKeyDerivable);
  const source = await readLedgerSourceState(join(runDir, COMPONENT_LEDGER_FILENAME), readFileFn);
  if (source.state !== "ok") {
    return { state: source.state, llmKeyDerivable, backend: [], llm: [], truncated: false };
  }
  const components = source.data?.components;
  if (!components || typeof components !== "object" || Array.isArray(components)) {
    return { state: "unparseable", llmKeyDerivable, backend: [], llm: [], truncated: false };
  }
  const backendPrefix = `backend:${agent.backend}@`;
  const llmPrefix = llmKeyDerivable ? `llm:${providerID}/${modelId}@` : null;
  const backend = [];
  const llm = [];
  let truncated = false;
  for (const [key, record] of Object.entries(components)) {
    const isBackend = typeof key === "string" && key.startsWith(backendPrefix);
    const isLlm = llmPrefix !== null && typeof key === "string" && key.startsWith(llmPrefix);
    if (!isBackend && !isLlm) continue;
    const bucket = isBackend ? backend : llm;
    if (bucket.length >= COMPONENT_OBSERVATION_CAP) { truncated = true; continue; }
    const r = record && typeof record === "object" ? record : {};
    bucket.push({
      key: boundedTextOrNull(key, 256),
      result: COMPONENT_RESULT_CLOSED_SET.includes(r.result) ? r.result : null,
      lastVerifiedAt: boundedIsoOrNull(r.lastVerifiedAt),
      codeRef: boundedTextOrNull(r.codeRef, 64),
      runtimeFingerprint: boundedTextOrNull(r.runtimeIdentity?.fingerprint, 128),
      runtimeVerified: r.runtimeIdentity
        ? r.runtimeIdentity.verified === true
        : null,
      advisoryCode: boundedTextOrNull(r.advisory?.code, 64),
    });
  }
  return { state: "ok", llmKeyDerivable, backend, llm, truncated };
}

/**
 * worker 记录的有界投影（组合结果列）。磁盘数据可能被改：闭集/形状外的值
 * 一律 null，绝不透出任意文本。executionProfile 缺失（legacy）→ undefined
 * 原样保留（"画像未知"的判据），绝不补猜。
 * @private
 */
function projectWorkerEvidenceRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const profile = record.executionProfile;
  return {
    status: boundedTextOrNull(record.status, 32),
    backend: boundedTextOrNull(record.backend, 64),
    modelId: boundedTextOrNull(record.modelId, 128),
    providerID: boundedTextOrNull(record.providerID, 128),
    // R23-C 三态保真：undefined（legacy 记录）≠ null（已观察无接入方）。
    providerKey: record.providerKey === undefined ? undefined : boundedTextOrNull(record.providerKey, 256),
    certificationScope: boundedTextOrNull(record.certificationScope, 16),
    reasonCode: boundedReasonCode(record.reasonCode),
    lastHealthyRunAt: boundedIsoOrNull(record.lastHealthyRunAt),
    lastFullHealthyRunAt: boundedIsoOrNull(record.lastFullHealthyRunAt),
    executionProfile: profile && typeof profile === "object" && !Array.isArray(profile)
      ? {
        effort: boundedTextOrNull(profile.effort, 16),
        modelId: boundedTextOrNull(profile.modelId, 128),
        providerID: boundedTextOrNull(profile.providerID, 128),
        providerKey: boundedTextOrNull(profile.providerKey, 256),
        runtimeFingerprint: boundedTextOrNull(profile.runtime?.fingerprint, 128),
        runtimeVerified: profile.runtime ? profile.runtime.verified === true : null,
        codeRef: boundedTextOrNull(profile.codeRef, 64),
        capturedAt: boundedIsoOrNull(profile.capturedAt),
        drillRunIds: profile.drillRunIds && typeof profile.drillRunIds === "object"
          ? Object.fromEntries(
            Object.entries(profile.drillRunIds)
              .slice(0, 16)
              .map(([drill, runId]) => [boundedTextOrNull(drill, 64), boundedTextOrNull(runId, 128)]),
          )
          : undefined,
      }
      : undefined,
  };
}

/**
 * identity 不匹配的展示用维度明细。裁决 SSOT 是 matchedCertRecord（本函数只在
 * SSOT 已判 null 后用于指路；若 SSOT 判 null 而此处找不到维度，明细留空——
 * 绝不反向影响裁决）。
 * @private
 */
function identityMismatchDetail(agent, record) {
  const dims = [];
  if (record.backend !== undefined && record.backend !== agent.backend) dims.push("backend");
  const modelId = agent.model?.id ?? null;
  if (record.modelId !== undefined && record.modelId !== modelId) dims.push("modelId");
  const providerID = agent.model?.providerID ?? null;
  if (providerID !== null && record.providerID !== undefined && record.providerID !== providerID) dims.push("providerID");
  if (record.providerKey !== undefined && record.providerKey !== providerKeyFor(agent.provider)) dims.push("providerKey");
  return dims;
}

/**
 * 证据适用性三态判定（纯函数）。
 *
 * 判据（优先级从高到低）：
 *   - 台账来源状态非 ok（missing/unparseable/read-error）→ undeterminable
 *     （来源不可用绝不折叠成"无证据即匹配"）；
 *   - 该席位无 worker 记录 → undeterminable（缺证据 ≠ 匹配）；
 *   - matchedCertRecord（SSOT，与派发门同一规则）判 null → mismatched
 *     （backend/modelId/providerID/providerKey 任一声明不一致）；
 *   - 记录无 executionProfile（legacy）或缺 effort → undeterminable
 *     （旧画像不明时不得宣称当前已验证——TD-186 触发句）；
 *   - 记录 effort ≠ 声明 effort（含 null≠字符串）→ mismatched；
 *   - 其余 → matched。
 *
 * 附加限制项（不改三态，只进 limitations）：30 天审阅窗提醒（组合记录时间戳
 * 超期/缺失）、组件台账来源状态、组件 blocked/advisory 观测。
 *
 * @returns {{applicability: "matched"|"mismatched"|"undeterminable", limitations: string[]}}
 */
export function assessCertEvidenceApplicability({
  agent,
  ledgerState,
  workerRecord,
  componentObservation = null,
  now = new Date().toISOString(),
} = {}) {
  const limitations = [];
  if (ledgerState !== "ok") {
    limitations.push(`reliability-ledger:${ledgerState}`);
    return { applicability: "undeterminable", limitations };
  }
  if (!workerRecord || typeof workerRecord !== "object") {
    limitations.push("no-worker-record: 组合层台账无该席位记录（缺证据 ≠ 匹配）");
    return { applicability: "undeterminable", limitations };
  }
  if (matchedCertRecord(agent, workerRecord) === null) {
    const dims = identityMismatchDetail(agent, workerRecord);
    limitations.push(`identity-mismatch:${dims.length > 0 ? dims.join("+") : "unspecified"}（认证身份不可继承，matchedCertRecord SSOT）`);
    return { applicability: "mismatched", limitations };
  }
  const profile = workerRecord.executionProfile;
  if (!profile || typeof profile !== "object") {
    limitations.push("execution-profile-not-recorded: legacy 证据不表达执行画像（effort 未知），不得当当前画像已验证");
    return { applicability: "undeterminable", limitations };
  }
  if (profile.effort === undefined) {
    limitations.push("execution-profile-effort-missing: 记录缺 effort 字段");
    return { applicability: "undeterminable", limitations };
  }
  const declaredEffort = agent.reasoning?.effort ?? null;
  if (profile.effort !== declaredEffort) {
    limitations.push(`effort-mismatch: declared=${declaredEffort ?? "null"} evidence=${profile.effort ?? "null"}（席位 reasoning 已变，旧证据对新画像不适用——定向重验或记录暂缓）`);
    return { applicability: "mismatched", limitations };
  }
  // 身份与 effort 均匹配 → matched。仍并列非门控限制项（matched ≠ 可用）：
  const basis = workerRecord.lastFullHealthyRunAt ?? workerRecord.lastHealthyRunAt ?? null;
  const basisMs = basis ? Date.parse(basis) : Number.NaN;
  if (!basis || !Number.isFinite(basisMs)) {
    limitations.push("no-all-green-timestamp-on-record: 记录无全绿时间戳（新鲜度不可证）");
  } else {
    const ageDays = Math.floor((Date.parse(now) - basisMs) / DAY_MS);
    if (ageDays > EVIDENCE_REVIEW_WINDOW_DAYS) {
      limitations.push(`evidence-age:${ageDays}d>${EVIDENCE_REVIEW_WINDOW_DAYS}d-review-window: 审阅提醒（窗是提醒不是门，也不能替代配置变更后的影响判断）`);
    }
  }
  if (componentObservation) {
    if (componentObservation.state !== "ok") {
      limitations.push(`component-ledger:${componentObservation.state}（组件观测来源不可用，与组合证据分开可辨）`);
    } else {
      const blocked = [...componentObservation.backend, ...componentObservation.llm]
        .filter((r) => r.result === "blocked").length;
      if (blocked > 0) limitations.push(`component-blocked:${blocked} 条组件记录 blocked（验证时夹具/基础设施不可用）`);
      const advised = [...componentObservation.backend, ...componentObservation.llm]
        .filter((r) => r.advisoryCode).map((r) => r.advisoryCode);
      for (const code of [...new Set(advised)].slice(0, 4)) {
        limitations.push(`component-advisory:${code}`);
      }
    }
  }
  return { applicability: "matched", limitations };
}

/**
 * TD-186 只读认证证据详情：每个在册席位一行五列（声明 / 组件观测 / 组合结果 /
 * 证据适用性 / 限制与来源）。既有查询路径（CLI `registry list --cert-evidence`；
 * MCP 侧共用本服务模块）消费；简表（getRegistryInventory /
 * getRegistryInventoryWithIssues）投影形状零改动。
 *
 * 绝不派生任何"总体可用=true"式布尔——适用性三态是"证据是否适用于当前声明
 * 画像"的事实列，与组合结果（质量）并列呈现，永不合并成单一绿。
 *
 * @param {object} input
 * @param {string} input.registryPath
 * @param {string} [input.runDir]
 * @param {Function} [input.readRegistryFn]
 * @param {Function} [input.readFileFn]
 * @param {string|Date} [input.now] — 新鲜度计算基准（测试注入）
 * @returns {Promise<Array<object>>}
 */
export async function getCertificationEvidenceInventory({
  registryPath,
  runDir,
  readRegistryFn,
  readFileFn,
  now = new Date().toISOString(),
} = {}) {
  const _readRegistry = readRegistryFn ?? readRegistry;
  const registry = await _readRegistry(registryPath);
  const ledger = await readReliabilityLedgerDetail(runDir, readFileFn);
  const rows = [];
  for (const agent of registry.listAgents()) {
    const component = await observeComponentLedgerForSeat({ runDir, readFileFn, agent });
    const workerRecord = ledger.state === "ok" ? ledger.workers[agent.id] : undefined;
    const verdict = assessCertEvidenceApplicability({
      agent,
      ledgerState: ledger.state,
      workerRecord,
      componentObservation: component,
      now,
    });
    rows.push({
      id: agent.id,
      // 列 1：声明（当前 registry 生效画像——与派发同源）。
      declared: {
        backend: agent.backend,
        modelId: agent.model?.id ?? null,
        providerID: agent.model?.providerID ?? null,
        providerKey: providerKeyFor(agent.provider),
        effort: agent.reasoning?.effort ?? null,
      },
      // 列 2：组件观测（component-checks.json 的只读事实，非判定）。
      componentObserved: component,
      // 列 3：组合结果（reliability-summary worker 记录有界投影；无记录 → null）。
      combined: {
        state: ledger.state,
        record: projectWorkerEvidenceRecord(workerRecord),
      },
      // 列 4：证据适用性（三态闭集；"无法判断"绝不算绿）。
      applicability: verdict.applicability,
      // 列 5：限制与来源（两本台账的来源状态分别可辨 + 非门控限制项）。
      limitationsAndSources: {
        limitations: verdict.limitations,
        sources: [
          { file: "runs/reliability-summary.json", state: ledger.state },
          { file: `runs/${COMPONENT_LEDGER_FILENAME}`, state: component.state },
        ],
      },
    });
  }
  return rows;
}
