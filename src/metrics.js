import { findState, findLatest, findLatestBound, findFirstBound } from "./transcript.js";
import { backendFor } from "./backends/factory.js";
import { isProcessPlaceholderSessionId } from "./backends/processBackend.js";

/**
 * 用量计量范围闭集（TD-333，决定 0114 §3）。
 *
 * - `run`：后端报的是**本运行**的用量（一次进程/一轮 prompt 的合计）。
 * - `session`：后端报的是**会话累计**用量（resume 轮含前几轮）。读侧要减掉
 *   同一 provider 会话里紧邻的前一轮，才得到本轮自身用量。
 * - `unknown`：后端没有可用的计量通道。
 *
 * 写入侧把范围记在 `run.metrics.usageScope`；旧转录没有该字段时，读侧按
 * `run.started.backend` 对应后端类自己的 `usageScope` 声明解释（不按后端名
 * 分支——声明只在各 backend 类上写一次，这里只做通用查表）。后端类也解析
 * 不出时保持历史读法：自身用量按记下的数（内部状态 `unresolved`）。
 */
export const USAGE_SCOPES = Object.freeze(["run", "session", "unknown"]);
const USAGE_SCOPE_VALUES = new Set(USAGE_SCOPES);
// 后端名 → 类声明快照（进程内缓存；类声明是静态的，重复构造 backend 没有意义）。
// null = 后端不可解析（保持历史读法），不是“显式 unknown”。
const BACKEND_DECLARATIONS = new Map();

/**
 * 自身用量未知的原因闭集。只说明「为什么没有数」，不复述上游内容。
 */
export const SELF_USAGE_UNKNOWN_REASONS = Object.freeze([
  "no_usage",
  "usage_scope_unknown",
  "session_unreadable",
  "no_prior_turn",
  "prior_session_unreadable",
  "prior_session_mismatch",
  "prior_usage_unreadable",
  "prior_scope_mismatch",
]);
const SELF_USAGE_UNKNOWN_REASON_VALUES = new Set(SELF_USAGE_UNKNOWN_REASONS);

/** 把后端/事件上的范围值收窄到闭集；非法或缺失 → "unknown"。 */
export function normalizeUsageScope(value) {
  return USAGE_SCOPE_VALUES.has(value) ? value : "unknown";
}

function validUsageScope(value) {
  return USAGE_SCOPE_VALUES.has(value) ? value : null;
}

function normalizeCacheInclusion(value) {
  if (value === true || value === false) return value;
  return "unknown";
}

/**
 * 后端类声明快照：`usageScope`（run/session/unknown）与 `inputIncludesCacheRead`
 * （input 是否已含缓存读取）。`backendFor` 构造是纯静态的（各构造函数零副作用）；
 * 后端不可解析 → null，由调用方保持历史读法。绝不在共享代码里按后端名分支。
 */
function backendDeclaration(backendName) {
  if (typeof backendName !== "string" || backendName.length === 0) return null;
  if (BACKEND_DECLARATIONS.has(backendName)) return BACKEND_DECLARATIONS.get(backendName);
  let declaration = null;
  try {
    const backend = backendFor({ backend: backendName });
    declaration = {
      usageScope: normalizeUsageScope(backend?.usageScope),
      inputIncludesCacheRead: normalizeCacheInclusion(backend?.inputIncludesCacheRead),
    };
  } catch {
    declaration = null;
  }
  BACKEND_DECLARATIONS.set(backendName, declaration);
  return declaration;
}

/** 旧转录（无 `run.metrics.usageScope`）按后端类声明解释；不可解析 → unknown。 */
export function usageScopeForBackend(backendName) {
  return backendDeclaration(backendName)?.usageScope ?? "unknown";
}

/** 后端类声明 input 是否已含缓存读取；不可解析 → unknown。 */
export function inputIncludesCacheReadForBackend(backendName) {
  return backendDeclaration(backendName)?.inputIncludesCacheRead ?? "unknown";
}

/**
 * 首个请求用量：只承载上游逐请求通道实际报出的数（input / cacheRead），
 * 缺哪个就少哪个；两者都没有 → null（不虚构字段）。
 */
export function normalizeFirstRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const first = {};
  if (typeof value.input === "number" && Number.isFinite(value.input)) first.input = value.input;
  if (typeof value.cacheRead === "number" && Number.isFinite(value.cacheRead)) {
    first.cacheRead = value.cacheRead;
  }
  return Object.keys(first).length > 0 ? first : null;
}

// 缓存占比按后端声明算：input 已含缓存读取 → cacheRead ÷ input；
// 不含 → cacheRead ÷ (input + cacheRead)。声明未知或缓存读取缺失 → 未知。
function ratioFromTokens(tokens, inputIncludesCacheRead) {
  const read = tokens?.cacheRead;
  const input = tokens?.input;
  if (typeof read !== "number" || typeof input !== "number") return null;
  if (inputIncludesCacheRead !== true && inputIncludesCacheRead !== false) return null;
  const denominator = inputIncludesCacheRead === true ? input : input + read;
  if (!(denominator > 0)) return null;
  return read / denominator;
}

function hasNumbers(tokens) {
  return tokens && typeof tokens === "object"
    && Object.values(tokens).some((value) => typeof value === "number" && Number.isFinite(value));
}

/**
 * R18（TD-128 W1）：观测报表面的 runId 绑定作用域——单一定义处。
 *
 * 注册危害（TD-128 P3 观测面）：append-only transcript 尾部的伪造/外 run 行可
 * 污染 tokens/cost/duration/scorecard 报表值。本函数把报表读取收窄到「请求
 * runId 的信封绑定事件」；首/末条序语义仍由 transcript.js 的绑定读取器 SSOT
 * 承担（findFirstBound/findLatestBound），此处只定义「何时绑定」。
 *
 * 返回值：
 *   - 绑定数组：提供了 runId 且 transcript 存在信封（任一事件带 runId 字段）。
 *   - null：无法绑定——未提供 runId（R19 起 aggregateSummary 的 --summary 调用
 *     方逐文件传入文件名 stem 作为权威 runId，其余调用方缺省），或【全无信封的
 *     legacy transcript】（pre-envelope，事件一律无 runId 字段）。null 时调用方
 *     保持历史无绑定读法。
 *
 * legacy 行为选择（真实判据 = 该面有无既有 pre-envelope 契约钉住，而非
 * "观测面一律降级不设门"——R20-C 勘误，auditor P3-1）：全无信封的 legacy
 * transcript 不拒绝、不出空报表——保持既有读法照常出报表
 * （test/isolation-infra/cli.test.js 的 pre-envelope 三态 JSON 契约钉住该行
 * 为；本函数服务的报表/观测面恰属此类）。任一事件带信封（含伪造尾行）即
 * 严格绑定：外 run/无信封行不可见，宁可让报表可见地缺事实（pending/无
 * tokens），也不静默采信不可归属的值。对照面：同为纯观测的 runDelivery
 * terminalState（R20 M5）无 pre-envelope 契约钉住旧读法，故取严格档——
 * 不可归属直接降 pending、无 legacy 回退；两档分野由"既有契约是否钉住"
 * 决定，不由"是否观测面"决定（M5 纯观测却严格档即为反例）。绑定只杀跨
 * run 注入/错读；同 runId 伪造追加 = runs/ 写权限攻击面，读侧无解
 * （transcript.js 绑定读取器同口径）。
 *
 * @param {Array} events transcript 事件序列
 * @param {string|null} runId 调用方权威 runId（CLI 命令经 isValidRunId 后的用户输入）
 * @returns {Array|null} 绑定事件子集；null = 无法绑定（调用方退回历史读法）
 */
export function boundReportScope(events, runId) {
  if (typeof runId !== "string" || runId.length === 0) return null;
  if (!Array.isArray(events) || !events.some((e) => e && typeof e.runId === "string")) return null;
  return events.filter((e) => e && e.runId === runId);
}

function firstEvent(events) {
  return Array.isArray(events) ? events[0] : undefined;
}

function parseTs(ts) {
  if (typeof ts !== "string") return null;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// provider 会话 id：优先独立绑定事实 run.provider_session_bound 的 native id；
// 没有该事实时取 LAST-bound session.created（进程占位 proc_<pid> 不是 provider
// 会话 id）。绑定事实在场但坏 → 不回落旧值（与共享续接读取器同口径）。
function providerSessionIdFrom(events, scope, runId) {
  const bound = scope
    ? findLatestBound(events, "run.provider_session_bound", runId)
    : findLatest(events, "run.provider_session_bound");
  if (bound) {
    const native = bound.providerSessionId;
    return typeof native === "string" && native.length > 0 && !isProcessPlaceholderSessionId(native)
      ? native
      : null;
  }
  const created = scope
    ? findLatestBound(events, "session.created", runId)
    : findLatest(events, "session.created");
  const id = created?.backendSessionId;
  return typeof id === "string" && id.length > 0 && !isProcessPlaceholderSessionId(id) ? id : null;
}

/**
 * 读一个 run 的用量事实（绑定后）。返回值是报表读侧的唯一形状：
 * 记录值 tokens、计量范围、首个请求、provider 会话身份（用于找同一会话
 * 紧邻的前一轮）与展示字段。
 *
 * @param {Array} events transcript 事件序列
 * @param {string|null} runId 权威 runId；缺省保持历史无绑定读法
 * @returns {object}
 */
export function runUsageFacts(events, runId = null) {
  const scope = boundReportScope(events, runId);
  const scoped = scope ?? (Array.isArray(events) ? events : []);
  const state = findState(scoped);
  const metricsEvent = scope
    ? findLatestBound(scoped, "run.metrics", runId)
    : findLatest(scoped, "run.metrics");
  const started = scope
    ? findFirstBound(scoped, "run.started", runId)
    : scoped.find((e) => e.type === "run.started");
  const sessionReuse = scope
    ? findLatestBound(scoped, "run.session_reuse", runId)
    : findLatest(scoped, "run.session_reuse");
  const backgroundSubmitted = scope
    ? findFirstBound(scoped, "run.background_submitted", runId)
    : scoped.find((e) => e.type === "run.background_submitted");

  const tokens = metricsEvent?.tokens && typeof metricsEvent.tokens === "object"
    ? metricsEvent.tokens
    : {};
  const backend = typeof started?.backend === "string" ? started.backend : null;
  const declaration = backendDeclaration(backend);

  // 事件写了范围就用事件；字段缺席才回退到后端类声明。两者都没有 →
  // unresolved（历史读法：自身用量按记下的数）。事件字段在场但非法 →
  // explicit unknown（不拿后端声明掩盖坏值）。
  let scopeState;
  if (Object.hasOwn(metricsEvent ?? {}, "usageScope")) {
    scopeState = normalizeUsageScope(metricsEvent.usageScope);
  } else {
    scopeState = declaration === null ? "unresolved" : declaration.usageScope;
  }
  const usageScope = scopeState === "unresolved" ? "unknown" : scopeState;
  const inputIncludesCacheRead = declaration?.inputIncludesCacheRead ?? "unknown";

  const backgroundSubmittedContinuation = backgroundSubmitted?.continuation === true;
  const parentRunId = backgroundSubmittedContinuation
    && typeof backgroundSubmitted.parentRunId === "string"
    ? backgroundSubmitted.parentRunId
    : null;
  const rootRunId = sessionReuse?.mode === "run_lineage"
    && typeof sessionReuse.rootRunId === "string"
    ? sessionReuse.rootRunId
    : (backgroundSubmittedContinuation
      && typeof backgroundSubmitted.rootRunId === "string"
      ? backgroundSubmitted.rootRunId
      : null);

  const first = firstEvent(scoped);
  const startedAt = parseTs(started?.ts) ?? parseTs(first?.ts);
  // 续轮标记：线系子轮 / 会话复用 turn:"resume"。首轮不需要上一轮；
  // 会话累计范围的续轮没有可读的 provider 会话 id 时如实记未知。
  const continuation = sessionReuse?.turn === "resume"
    || backgroundSubmittedContinuation
    || (rootRunId !== null && rootRunId !== (typeof runId === "string" ? runId : first?.runId));
  const last = scoped.at(-1);
  const durationMs = started?.ts && last?.ts
    ? Math.max(0, new Date(last.ts).getTime() - new Date(started.ts).getTime())
    : 0;

  const costUsd = typeof metricsEvent?.costUsd === "number" ? metricsEvent.costUsd : undefined;
  const facts = {
    runId: typeof runId === "string" && runId.length > 0
      ? runId
      : (typeof first?.runId === "string" ? first.runId : null),
    agentId: typeof started?.agentId === "string"
      ? started.agentId
      : (typeof first?.agentId === "string" ? first.agentId : null),
    backend,
    startedAt,
    state,
    tokens,
    usageScope,
    scopeState,
    inputIncludesCacheRead,
    continuation,
    providerSessionId: providerSessionIdFrom(scoped, scope, runId),
    firstRequest: normalizeFirstRequest(metricsEvent?.firstRequest),
    durationMs,
    rootRunId,
    parentRunId,
  };
  if (costUsd !== undefined) facts.costUsd = costUsd;
  return facts;
}

function selfUsageUnknown(reason) {
  if (!SELF_USAGE_UNKNOWN_REASON_VALUES.has(reason)) {
    throw new Error(`metrics: unknown self-usage reason ${reason}`);
  }
  return { selfTokens: null, selfUsageUnknownReason: reason };
}

/**
 * 自身用量（单运行 / --lineage / --summary 共用这一份）：
 *
 * - 显式 unknown 范围 → 未知。
 * - 会话第一轮 → 记下的数（不论范围；只有显式 unknown 才例外）。
 * - 后续轮：run 范围 → 记下的数；unresolved 旧事件 → 保持历史读法（记下的数）；
 *   session 范围 → 记下的数减同一会话链上**紧邻**的前一轮；紧邻前一轮没有
 *   run.metrics、范围不同、或会话 id 读不出/对不上 → 未知。不得越过它去减更早轮。
 */
function computeSelfUsage(facts, prior, isFirstInSession) {
  if (facts.scopeState === "unknown") return selfUsageUnknown("usage_scope_unknown");
  if (!hasNumbers(facts.tokens)) return selfUsageUnknown("no_usage");
  if (isFirstInSession) {
    if (facts.scopeState === "session" && facts.continuation) {
      return selfUsageUnknown(
        facts.providerSessionId === null ? "session_unreadable" : "no_prior_turn",
      );
    }
    return { selfTokens: { ...facts.tokens } };
  }
  if (facts.scopeState === "run" || facts.scopeState === "unresolved") {
    return { selfTokens: { ...facts.tokens } };
  }
  // 后续轮 + 会话累计范围。
  if (!prior) {
    return selfUsageUnknown(
      facts.providerSessionId === null ? "session_unreadable" : "no_prior_turn",
    );
  }
  // 紧邻前一轮必须能被认出是同一 provider 会话：读不出 id 或 id 不同都不能减。
  if (facts.providerSessionId === null) return selfUsageUnknown("session_unreadable");
  if (prior.providerSessionId === null) return selfUsageUnknown("prior_session_unreadable");
  if (prior.providerSessionId !== facts.providerSessionId) {
    return selfUsageUnknown("prior_session_mismatch");
  }
  if (prior.scopeState !== "session") return selfUsageUnknown("prior_scope_mismatch");
  if (!hasNumbers(prior.tokens)) return selfUsageUnknown("prior_usage_unreadable");

  const self = {};
  for (const [key, value] of Object.entries(facts.tokens)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const previous = prior.tokens?.[key];
    if (typeof previous !== "number" || !Number.isFinite(previous)) {
      return selfUsageUnknown("prior_usage_unreadable");
    }
    const delta = value - previous;
    if (delta < 0) return selfUsageUnknown("prior_usage_unreadable");
    self[key] = delta;
  }
  return Object.keys(self).length > 0
    ? { selfTokens: self }
    : selfUsageUnknown("no_usage");
}

function buildResult(facts, prior, isFirstInSession) {
  const self = computeSelfUsage(facts, prior, isFirstInSession);
  const result = {
    state: facts.state,
    tokens: facts.tokens,
    usageScope: facts.usageScope,
    inputIncludesCacheRead: facts.inputIncludesCacheRead,
    selfTokens: self.selfTokens,
    cacheRatio: self.selfTokens
      ? ratioFromTokens(self.selfTokens, facts.inputIncludesCacheRead)
      : null,
    firstRequest: facts.firstRequest,
    firstRequestCacheRatio: facts.firstRequest
      ? ratioFromTokens(facts.firstRequest, facts.inputIncludesCacheRead)
      : null,
    durationMs: facts.durationMs,
  };
  if (self.selfTokens === null) result.selfUsageUnknownReason = self.selfUsageUnknownReason;
  if (facts.costUsd !== undefined) result.costUsd = facts.costUsd;
  return result;
}

function orderFacts(left, right) {
  const a = left.startedAt;
  const b = right.startedAt;
  if (a !== null && b !== null && a !== b) return a - b;
  if (a !== null && b === null) return -1;
  if (a === null && b !== null) return 1;
  const leftId = left.runId ?? "";
  const rightId = right.runId ?? "";
  if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  return (left.index ?? 0) - (right.index ?? 0);
}

// 会话链：谱系成员一律按线系根成链（即使中间轮只留下 proc_<pid> 也要留在链上，
// 下一轮才能看见“紧邻前一轮读不出”）；非谱系复用按同一 backend + native
// session id 成链。按开始时间排序后，每轮的前一轮就是链上紧邻的那一轮——
// 不按 lineage 请求的父运行、也不按文件名猜。
function sessionChainKey(facts) {
  if (facts.rootRunId !== null) return `lineage:${facts.rootRunId}`;
  if (facts.providerSessionId !== null) {
    return `provider:${facts.backend ?? "unknown"}:${facts.providerSessionId}`;
  }
  return null;
}

function attachSelfUsage(factsList) {
  const sorted = [...factsList].sort(orderFacts);
  const groups = new Map();
  for (const facts of sorted) {
    const key = sessionChainKey(facts);
    if (key === null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(facts);
  }
  const processed = new Set();
  for (const facts of sorted) {
    if (processed.has(facts)) continue;
    const key = sessionChainKey(facts);
    const group = key === null ? [facts] : groups.get(key);
    for (let index = 0; index < group.length; index += 1) {
      const item = group[index];
      item.selfResult = buildResult(item, index > 0 ? group[index - 1] : null, index === 0);
      processed.add(item);
    }
  }
  return sorted;
}

/**
 * 给一组运行算自身用量（单运行 / --lineage / --summary 共用的唯一入口）。
 * 返回值按输入 runs 顺序，带 runId/agentId。
 *
 * @param {Array<Array>} runs 事件序列数组
 * @param {string[]|null} [runIds] 与 runs 等长的权威 runId 数组
 * @returns {Array<object>}
 */
export function aggregateRunUsages(runs, runIds = null) {
  const bound = Array.isArray(runIds) && runIds.length === runs.length;
  const factsList = runs.map((events, index) => {
    const facts = runUsageFacts(events, bound ? runIds[index] : null);
    facts.index = index;
    return facts;
  });
  attachSelfUsage(factsList);
  return factsList.map((facts) => ({
    runId: facts.runId,
    agentId: facts.agentId,
    ...facts.selfResult,
  }));
}

/**
 * 从单个 run 的事件序列聚合指标（M4-4）。
 *
 * 单 run 没有同会话上下文时按“会话第一轮/历史读法”解释；CLI 的单 run 查询
 * 与 --lineage/--summary 一样走 aggregateRunUsages，把同会话其它轮一起传入。
 *
 * R18（TD-128 W1）：三处事实读取（state/run.metrics/run.started）与 duration
 * 终点（末事件 ts）全部经 boundReportScope 收窄——外 run 尾条的 state_change/
 * run.metrics/ts 不再污染报表。序语义保持既有纪律：run.metrics 末条
 * （metrics.test.js 钉住的"取最后一条"）、run.started 首条（R12-C 首写纪律）。
 * 全绑定合法 transcript 上过滤器恒等 → 行为零变化。
 *
 * @param {Array} events transcript 事件序列
 * @param {string|null} [runId] 权威 runId；缺省保持历史无绑定读法
 * @returns {{state, tokens, usageScope, selfTokens, selfUsageUnknownReason?,
 *   cacheRatio, firstRequest, firstRequestCacheRatio, costUsd?, durationMs}}
 */
export function aggregateRunMetrics(events, runId = null) {
  const [row] = aggregateRunUsages([events], runId ? [runId] : null);
  const { runId: _runId, agentId: _agentId, ...result } = row;
  return result;
}

/**
 * 跨 run 聚合（M4-4）。
 *
 * `totalTokens` 按**自身用量**相加（同一 provider 会话只计每轮增量），
 * 未知自身用量的 run 单列 `unknownSelfUsageCount`，不重复也不补 0。
 *
 * R19（TD-128 W1 报表污染类；L1 勘误：原注释误标 W2——按 TD-128 登记表真实
 * 编号，--summary 逐文件聚合属 R18 W1 报表污染类同族）：--summary 调用方逐文件读取时【文件名 stem 即权威 runId】，
 * 经 runIds 逐 run 传入绑定读者（boundReportScope 单一定义处复用，不新写）——
 * 单文件内的外 run/伪造尾条不再污染聚合。runIds 缺省（历史调用方/测试）时逐
 * run 无绑定（历史读法）；提供了 stem 时交由 boundReportScope 自身规则：全无
 * 信封的 legacy transcript 保持历史无绑定读法，任一事件带信封即严格绑定（外
 * run/无信封行不可见——宁可可见地缺事实）。全绑定合法 transcript 上过滤器恒
 * 等 → 行为零变化。
 *
 * @param {Array<Array>} runs 多个 run 的事件序列数组
 * @param {string[]|null} [runIds] 与 runs 等长的权威 runId 数组（文件名 stem）；
 *   缺省逐 run 无绑定（历史读法）
 * @returns {{totalRuns, byState, successRate, totalTokens, avgDurationMs,
 *   unknownSelfUsageCount}}
 */
export function aggregateSummary(runs, runIds = null) {
  if (runs.length === 0) {
    return {
      totalRuns: 0,
      byState: {},
      successRate: 0,
      totalTokens: {},
      avgDurationMs: 0,
      unknownSelfUsageCount: 0,
    };
  }
  const rows = aggregateRunUsages(runs, runIds);
  const byState = {};
  let successCount = 0;
  const totalTokens = {};
  let totalDuration = 0;
  let unknownSelfUsageCount = 0;

  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
    if (row.state === "completed") successCount += 1;
    totalDuration += row.durationMs;
    if (row.selfTokens === null) {
      unknownSelfUsageCount += 1;
    } else {
      for (const [key, value] of Object.entries(row.selfTokens)) {
        totalTokens[key] = (totalTokens[key] ?? 0) + value;
      }
    }
  }

  return {
    totalRuns: runs.length,
    byState,
    successRate: successCount / runs.length,
    totalTokens,
    avgDurationMs: Math.round(totalDuration / runs.length),
    unknownSelfUsageCount,
  };
}

/** 格式化毫秒为人读时长 */
export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}
