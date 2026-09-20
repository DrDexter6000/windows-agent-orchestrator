// scripts/reliability/componentLedger.mjs
//
// ADR-0032 §5：组件层台账（component ledger）——纯函数模块，可单测。
// 两层验证的组件层基础设施：llm 与 backend 的单独验证结果落
// runs/component-checks.json（独立于组合层的 runs/reliability-summary.json）。
//
// 词汇分层（ADR-0032 §1，硬约束）：
//   - 组件层结果闭集 = pass / fail / blocked。本模块【绝不】import
//     certification.mjs 的状态闭集（certified/conditional 是组合层独占词汇，
//     已被派发门与 wire 投影消费——复用即语义泄漏）。
//   - 从 certification.mjs 只 import 两个无状态纯工具（mergeCaseResults /
//     pruneStaleCases——二者不含任何组合层状态词汇），作为合并/修剪语义的
//     单一实现复用（不复制第二套语义）。
//
// 隔离硬保证（§5）：
//   - 组件台账绝不写 workers 映射、绝不写组合层 status / recommendedUse /
//     lastFullHealthyRunAt（以及 legacy 的 lastHealthyRunAt）——写入/序列化/
//     解析三处都有 assertNoCompositionLayerLeak 机械把关。
//   - 时间字段名固定 lastVerifiedAt。src/runManager.js 的认证新鲜度门
//     （legacy 回落）只认 lastHealthyRunAt / lastFullHealthyRunAt——新名字
//     天然隔离，门没有任何路径能误读组件新鲜度。
//
// 身份键（kind 命名空间，与 ADR-0026 四元组键空间不相交——四元组活在
// reliability-summary 的 workers 映射里，键是裸 agentId；组件键恒带
// "backend:" / "llm:" 前缀）：
//   - backend → backend:<name>@<codeRef>（codeRef = 验证时 WAO repo 的 git HEAD）
//   - llm     → llm:<providerID>/<modelId>@<providerKey>
//
// 消费路径六态（§5，返回显式状态而非布尔）：
//   normal / ledger-missing / unparseable / stale / blocked / fixture-decayed

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
// 复用（非复制）组合层既有纯函数：mergeCaseResults（caseId 键的增量合并）与
// pruneStaleCases（TD-87 僵尸清理 + scope 守卫形状）。这两个函数不携带
// certified/conditional 词汇——ADR-0032 §1 禁的是状态闭集，不是整个模块。
import { mergeCaseResults, pruneStaleCases } from "./certification.mjs";

// ── 闭集与常量 ────────────────────────────────────────────────────────────────

// 组件层结果三值闭集（ADR-0032 §1）。禁止出现 certified/conditional——那是
// 组合层独占词（DISPATCHABLE 集合 / buildCertMap 投影已加载）。
export const COMPONENT_RESULTS = ["pass", "fail", "blocked"];

// 消费路径六态闭集（ADR-0032 §5）。
export const COMPONENT_LEDGER_STATES = [
  "normal",
  "ledger-missing",
  "unparseable",
  "stale",
  "blocked",
  "fixture-decayed",
];

// 组件身份的两族 kind 命名空间。
export const COMPONENT_KINDS = ["backend", "llm"];

// 夹具资格依据（ADR-0032 §4）：新鲜组合认证记录 或 Owner 显式指定参照装配。
export const FIXTURE_QUALIFICATION_BASES = ["composition-cert", "owner-declared"];

// 台账文件名（ADR-0032 §5：分文件、共证据——独立于 reliability-summary.json）。
export const COMPONENT_LEDGER_FILENAME = "component-checks.json";
export const COMPONENT_LEDGER_VERSION = 1;

// 组合层保留键：组件台账任何层级都不得出现这些键名（隔离硬保证的机械判据）。
// lastHealthyRunAt 一并保留——它是 runManager.js 新鲜度门的 legacy 回落名，
// 组件台账同样不得使用（时间字段只允许 lastVerifiedAt）。
export const COMPOSITION_RESERVED_KEYS = [
  "workers",
  "status",
  "recommendedUse",
  "lastFullHealthyRunAt",
  "lastHealthyRunAt",
];

// 组件记录默认新鲜期（天）：超期 → stale（advisory）。可被 context.maxAgeDays 覆盖。
export const DEFAULT_MAX_AGE_DAYS = 30;
// 夹具组合认证默认新鲜期（天）：超期 → fixture-decayed（advisory）。
export const DEFAULT_FIXTURE_MAX_AGE_DAYS = 30;

const DAY_MS = 86_400_000;

// readComponentLedgerFile 的三态文件状态（六态的前三态来源）。
const COMPONENT_LEDGER_FILE_STATES = ["ledger-missing", "unparseable", "loaded"];

// ── 身份键构造（kind 命名空间） ──────────────────────────────────────────────

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`component key component "${label}" must be a non-empty string, got ${JSON.stringify(value)}`);
  }
}

// "@" / "/" 分隔符约束保证键可逆解析、族内单射：backend name 与 codeRef 不含
// "@"；providerID 不含 "/" 与 "@"（族内边界）；modelId 不含 "@"（可含 "/"，
// 如 "kimi-code/k3"）；providerKey 不含 "@"（真实指纹形如 "<baseUrl>|<env>"，
// 恒含 "|"，故字面 "null" 编码与任何真实指纹不可能碰撞）。
function assertNoSeparator(value, label, chars) {
  for (const ch of chars) {
    if (value.includes(ch)) {
      throw new Error(`component key component "${label}" must not contain "${ch}" (namespace key injectivity), got ${JSON.stringify(value)}`);
    }
  }
}

// backend → backend:<name>@<codeRef>（codeRef = 验证时 WAO repo 的 git HEAD）。
export function backendComponentKey({ name, codeRef } = {}) {
  assertNonEmptyString(name, "backend name");
  assertNoSeparator(name, "backend name", ["@"]);
  assertNonEmptyString(codeRef, "codeRef");
  assertNoSeparator(codeRef, "codeRef", ["@"]);
  return `backend:${name}@${codeRef}`;
}

// llm → llm:<providerID>/<modelId>@<providerKey>。
// providerKey = null（已观察、确认无接入方）→ 字面 "null" 编码；undefined 拒绝
// （undefined 只保留给组合层 legacy 记录，组件层是新账，必须显式声明）。
export function llmComponentKey({ providerID, modelId, providerKey } = {}) {
  assertNonEmptyString(providerID, "providerID");
  assertNoSeparator(providerID, "providerID", ["/", "@"]);
  assertNonEmptyString(modelId, "modelId");
  assertNoSeparator(modelId, "modelId", ["@"]);
  let encodedProviderKey;
  if (providerKey === null) {
    encodedProviderKey = "null";
  } else {
    // undefined（未声明）在这里是调用方 bug：组件层记录必须显式给 string|null。
    assertNonEmptyString(providerKey, "providerKey");
    assertNoSeparator(providerKey, "providerKey", ["@"]);
    encodedProviderKey = providerKey;
  }
  return `llm:${providerID}/${modelId}@${encodedProviderKey}`;
}

// 按 kind 派发构造（输入为扁平身份字段）。
export function componentKeyFor(input = {}) {
  if (input.kind === "backend") {
    return backendComponentKey({ name: input.name, codeRef: input.codeRef });
  }
  if (input.kind === "llm") {
    return llmComponentKey({
      providerID: input.providerID,
      modelId: input.modelId,
      providerKey: input.providerKey,
    });
  }
  throw new Error(
    `component kind must be one of [backend|llm] (ADR-0032 kind namespaces), got ${JSON.stringify(input.kind)}`,
  );
}

// 键 → kind。无命名空间前缀（如 workers 映射的裸 agentId "researcher"）→ null，
// 即组件键空间与 ADR-0026 四元组键空间（workers 映射）结构性不相交。
export function componentKeyKind(key) {
  if (typeof key !== "string") return null;
  if (key.startsWith("backend:")) return "backend";
  if (key.startsWith("llm:")) return "llm";
  return null;
}

function assertNamespacedKey(key, label = "component key") {
  if (componentKeyKind(key) === null) {
    throw new Error(
      `${label} must be a namespaced component key ("backend:<name>@<codeRef>" or "llm:<providerID>/<modelId>@<providerKey>"), got ${JSON.stringify(key)}`,
    );
  }
}

// 消费侧便利：runDir 下的组件台账路径（与 reliability-summary.json 平级分文件）。
export function componentLedgerPathFor(runDir) {
  return join(runDir, COMPONENT_LEDGER_FILENAME);
}

// ── 隔离硬保证：组合层保留键守卫 ─────────────────────────────────────────────

// 递归键行走：payload 任何层级的键名都不得命中组合层保留键。写入、序列化、
// 解析三处统一调用——泄漏在落盘之前即被拒绝（fail-closed，显式报错）。
export function assertNoCompositionLayerLeak(node, label = "component ledger payload") {
  const walk = (value, path) => {
    if (!value || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      if (COMPOSITION_RESERVED_KEYS.includes(k)) {
        throw new Error(
          `${label}: composition-layer reserved key "${k}" leaked at ${path}.${k} `
          + `(ADR-0032 §5 isolation: component ledger must never carry workers/status/recommendedUse/lastFullHealthyRunAt)`,
        );
      }
      walk(v, `${path}.${k}`);
    }
  };
  walk(node, "$");
}

// ── 记录构造 ─────────────────────────────────────────────────────────────────

function normalizeComponentChecks(checks) {
  if (checks === undefined || checks === null) return [];
  if (!Array.isArray(checks)) {
    throw new Error(`component checks must be an array, got ${JSON.stringify(checks)}`);
  }
  return checks.map((check) => ({
    name: String(check?.name),
    pass: check?.pass === true,
    detail: check?.detail ?? null,
  }));
}

// 夹具身份复合引用（ADR-0026 四元组的确定性编码）。JSON 数组编码单射无歧义
// （providerKey 自身含 "|"，不能用分隔符拼接）。
export function fixtureIdentityKey(identity = {}) {
  return JSON.stringify([
    identity.backend ?? null,
    identity.providerID ?? null,
    identity.modelId ?? null,
    identity.providerKey ?? null,
  ]);
}

function normalizeFixtureRecord(fixture, subjectKind) {
  if (fixture === undefined || fixture === null) return null;
  if (typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new Error(`fixture must be an object, got ${JSON.stringify(fixture)}`);
  }
  const identity = fixture.identity ?? {};
  if (!FIXTURE_QUALIFICATION_BASES.includes(fixture.qualifiedBy)) {
    throw new Error(
      `fixture qualifiedBy must be one of [composition-cert|owner-declared] (ADR-0032 §4 fixture qualification basis), got ${JSON.stringify(fixture.qualifiedBy)}`,
    );
  }
  return {
    // 夹具是对侧组件：验 backend 挂 llm，验 llm 挂 backend。缺省按对侧推导。
    kind: fixture.kind ?? (subjectKind === "backend" ? "llm" : "backend"),
    // ADR-0026 全身份四元组（backend / providerID / modelId / providerKey）。
    identity: {
      backend: identity.backend ?? null,
      providerID: identity.providerID ?? null,
      modelId: identity.modelId ?? null,
      providerKey: identity.providerKey ?? null,
    },
    identityKey: fixtureIdentityKey(identity),
    runtimeVersion: fixture.runtimeVersion ?? null,
    adapterVersion: fixture.adapterVersion ?? null,
    configDigest: fixture.configDigest ?? null,
    // ADR-0032 §1：backend conformant 必须附合同名称与版本。
    contract: fixture.contract
      ? { name: String(fixture.contract.name), version: String(fixture.contract.version) }
      : null,
    environment: fixture.environment ?? null,
    // 实际 runId（资格证据的可追溯锚点）。
    runId: fixture.runId ?? null,
    qualifiedBy: fixture.qualifiedBy,
    qualifiedAt: fixture.qualifiedAt ?? null,
    // Owner 显式指定的参照装配可带有效期；缺省不判过期（诚实返回 unknown）。
    ownerValidUntil: fixture.ownerValidUntil ?? null,
  };
}

function normalizeAdvisory(advisory) {
  if (!advisory || typeof advisory !== "object") {
    throw new Error(`advisory must be an object { code, reason, at }, got ${JSON.stringify(advisory)}`);
  }
  if (advisory.code !== "fixture-decayed") {
    throw new Error(`advisory.code closed set is ["fixture-decayed"], got ${JSON.stringify(advisory.code)}`);
  }
  return {
    code: advisory.code,
    reason: advisory.reason ?? "fixture qualification expired",
    at: advisory.at ?? new Date().toISOString(),
  };
}

function assertParseableTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) {
    throw new Error(`${label} must be a parseable ISO-8601 timestamp, got ${JSON.stringify(value)}`);
  }
}

// 构造一条组件验证记录。输入为扁平身份字段 + 结果 + 夹具账（ADR-0032 §4：
// 记录显式分 subject 与 fixture 两字段，夹具记全身份四元组 + runtime/适配器
// 版本 + 配置/合同摘要 + 环境 + 实际 runId + 资格依据）。
// 时间字段名固定 lastVerifiedAt（绝不 lastHealthyRunAt/lastFullHealthyRunAt——
// 那两个名字会被 src/runManager.js:1254 的 legacy 回落读到）。
export function recordComponentCheck(input = {}) {
  const kind = input.kind;
  if (!COMPONENT_KINDS.includes(kind)) {
    throw new Error(
      `component kind must be one of [backend|llm] (ADR-0032 kind namespaces), got ${JSON.stringify(kind)}`,
    );
  }
  const key = componentKeyFor(input);
  const result = input.result;
  if (!COMPONENT_RESULTS.includes(result)) {
    throw new Error(
      `component result must be one of [${COMPONENT_RESULTS.join("|")}] `
      + `(component-layer closed set, ADR-0032 §1 — certified/conditional are composition-layer words), `
      + `got ${JSON.stringify(result)}`,
    );
  }
  const lastVerifiedAt = input.lastVerifiedAt ?? new Date().toISOString();
  assertParseableTimestamp(lastVerifiedAt, "lastVerifiedAt");

  const record = {
    // mergeCaseResults 复用的合并键（与 key 同值：同组件键 = 同记录刷新）。
    caseId: key,
    key,
    kind,
    subject: kind === "backend"
      ? { kind, name: input.name, codeRef: input.codeRef }
      : {
        kind,
        providerID: input.providerID,
        modelId: input.modelId,
        providerKey: input.providerKey ?? null,
      },
    // codeRef 普遍落账（llm 侧是验证时 harness 的来源指纹，供 stale 比对）。
    codeRef: kind === "backend" ? input.codeRef : (input.codeRef ?? null),
    result,
    reason: input.reason ?? null,
    blockedReason: result === "blocked"
      ? (input.blockedReason ?? "fixture-unavailable")
      : (input.blockedReason ?? null),
    lastVerifiedAt,
    checks: normalizeComponentChecks(input.checks),
    fixture: normalizeFixtureRecord(input.fixture, kind),
  };
  if (input.advisory !== undefined) {
    record.advisory = normalizeAdvisory(input.advisory);
  }
  assertNoCompositionLayerLeak(record, `component record ${key}`);
  return record;
}

// ── 记录校验（磁盘侧 fail-closed） ───────────────────────────────────────────

// 校验一条记录的结构完整性：键命名空间、kind 一致、结果闭集、lastVerifiedAt
// 可解析、caseId === key、subject 重派生键一致（防磁盘被改后的身份漂移）。
// 违规抛显式错误——绝不静默跳过（ADR-0032 §5 unparseable 纪律）。
export function validateComponentRecord(record, label = "component record") {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${label}: must be an object, got ${JSON.stringify(record)}`);
  }
  assertNamespacedKey(record.key, `${label}.key`);
  const kind = componentKeyKind(record.key);
  if (record.kind !== kind) {
    throw new Error(`${label}: kind ${JSON.stringify(record.kind)} does not match key namespace "${kind}"`);
  }
  if (record.caseId !== record.key) {
    throw new Error(`${label}: caseId must equal key (merge key integrity), got ${JSON.stringify(record.caseId)}`);
  }
  if (!COMPONENT_RESULTS.includes(record.result)) {
    throw new Error(
      `${label}: result must be one of [${COMPONENT_RESULTS.join("|")}] (component-layer closed set), got ${JSON.stringify(record.result)}`,
    );
  }
  assertParseableTimestamp(record.lastVerifiedAt, `${label}.lastVerifiedAt`);
  const subject = record.subject ?? {};
  const rederived = kind === "backend"
    ? backendComponentKey({ name: subject.name, codeRef: subject.codeRef })
    : llmComponentKey({
      providerID: subject.providerID,
      modelId: subject.modelId,
      providerKey: subject.providerKey,
    });
  if (rederived !== record.key) {
    throw new Error(
      `${label}: subject identity ${rederived} does not re-derive the record key ${record.key} (on-disk identity drift)`,
    );
  }
  if (record.advisory !== undefined) normalizeAdvisory(record.advisory);
  return true;
}

// ── 夹具资格状态（fixture-decayed 的判定基础） ───────────────────────────────

// 返回显式状态（非布尔）：
//   "absent"  —— 记录没有夹具账（无基准可判）；
//   "fresh"   —— 资格依据仍在有效期内；
//   "expired" —— 夹具认证过期（composition-cert 超 fixtureMaxAgeDays，或
//               owner-declared 超 ownerValidUntil）→ fixture-decayed；
//   "unknown" —— 有夹具账但缺可解析的时效基准（诚实返回，不猜、不算过期）。
export function fixtureQualificationState(fixture, { now, fixtureMaxAgeDays = DEFAULT_FIXTURE_MAX_AGE_DAYS } = {}) {
  if (!fixture) return "absent";
  const nowMs = Date.parse(now ?? new Date().toISOString());
  if (!Number.isFinite(nowMs)) return "unknown";
  if (fixture.qualifiedBy === "owner-declared") {
    if (fixture.ownerValidUntil == null) return "unknown";
    const untilMs = Date.parse(fixture.ownerValidUntil);
    if (!Number.isFinite(untilMs)) return "unknown";
    return nowMs > untilMs ? "expired" : "fresh";
  }
  if (fixture.qualifiedAt == null) return "unknown";
  const atMs = Date.parse(fixture.qualifiedAt);
  if (!Number.isFinite(atMs)) return "unknown";
  return (nowMs - atMs) > fixtureMaxAgeDays * DAY_MS ? "expired" : "fresh";
}

// ── 合并 / 修剪 / 汇总（复用 certification.mjs 纯函数形状） ──────────────────

// 增量合并：直接委托 certification.mjs::mergeCaseResults（caseId 键——组件
// 记录的 caseId 即组件键）。本次刷新同键、未重跑的保留、全新键追加。
// 单跑某组件不得覆盖其它组件的记录——与组合层 merge 语义同一实现，零复制。
export function mergeComponentRecords(priorRecords = [], freshRecords = []) {
  return mergeCaseResults(priorRecords, freshRecords);
}

// 修剪：形状复用 certification.mjs::pruneStaleCases（TD-87）。语义映射：
//   - currentKeys 是检查器当前管理的【全量】键清单（类比 MATRIX 全表，不是
//     本次运行的子集——部分重跑不得连坐）；
//   - prior 记录保留 ⇔ 其键仍在 currentKeys（身份现行）或其 kind 未被
//     currentKeys 覆盖（scope 守卫：本轮只管 backend 时，llm 旧记录不动）；
//   - 同 kind 且键不在清单（如 codeRef 滚动后的旧 backend 键）→ 修剪——
//     这是键级僵尸清理；【内容级】陈旧（键仍现行但超期/codeRef 不匹配）不走
//     修剪，走消费侧 stale advisory（ADR-0032 §5）。
export function pruneComponentRecords(priorRecords = [], currentKeys = []) {
  for (const key of currentKeys) assertNamespacedKey(key, "pruneComponentRecords currentKeys entry");
  // 适配层：pruneStaleCases 按 case.agentId 做 scope 守卫——组件记录没有
  // agentId 字段（那是组合层 workers 映射的键位），此处以【记录的 kind】充当
  // scope 维：kind 被本轮清单覆盖且键已不在清单 → 僵尸；kind 未覆盖 → 不动。
  // 包装/解包不改动记录本身（零形状污染）。
  const wrapped = priorRecords.map((record) => ({
    record,
    caseId: record?.caseId ?? record?.key,
    agentId: componentKeyKind(record?.key),
  }));
  const kept = pruneStaleCases(
    wrapped,
    currentKeys.map((key) => ({ agentId: componentKeyKind(key), label: key })),
  );
  return kept.map((entry) => entry.record);
}

// 汇总：形状复用 certification.mjs::summarizeCertification（versioned +
// generatedAt + counts + 按 identity 聚合 + 全量记录），但聚合键是组件键、
// counts 按组件层三值闭集、绝无 workers/status/recommendedUse 字段。
export function summarizeComponentLedger(records = [], options = {}) {
  const normalized = records.map((record) => {
    validateComponentRecord(record, "summarizeComponentLedger record");
    return record;
  });
  const components = {};
  for (const record of normalized) components[record.key] = record;
  const counts = Object.fromEntries(COMPONENT_RESULTS.map((r) => [r, 0]));
  for (const key of Object.keys(components)) counts[components[key].result] += 1;
  const summary = {
    version: COMPONENT_LEDGER_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    counts,
    allPassed: Object.keys(components).length > 0
      && Object.values(components).every((r) => r.result === "pass"),
    components,
    records: [...normalized],
  };
  assertNoCompositionLayerLeak(summary, "component ledger summary");
  return summary;
}

// ── fixture-decayed：历史记录降 advisory，不删 ───────────────────────────────

// 把依赖已过期夹具资格的历史记录标注为 advisory。匹配器：runId（资格证据的
// 实际运行锚点）和/或 identityKey（ADR-0026 四元组复合引用），至少给一个。
// 返回新数组：命中记录浅拷贝加 advisory，未命中原样引用——数组长度恒不变
// （“不删”是该状态的硬语义；清理只能走 pruneComponentRecords 的键级僵尸路径）。
export function annotateFixtureDecay(records = [], decay = {}) {
  const matchers = [];
  if (decay.runId != null) matchers.push((fixture) => fixture?.runId === decay.runId);
  if (decay.identityKey != null) matchers.push((fixture) => fixture?.identityKey === decay.identityKey);
  if (matchers.length === 0) {
    throw new Error("annotateFixtureDecay requires at least one matcher: runId and/or identityKey");
  }
  const advisory = normalizeAdvisory({
    code: "fixture-decayed",
    reason: decay.reason ?? "fixture qualification expired (composition certification aged out or owner validity lapsed)",
    at: decay.at ?? new Date().toISOString(),
  });
  return records.map((record) => {
    const hit = record?.fixture && matchers.some((match) => match(record.fixture));
    if (!hit) return record;
    return { ...record, advisory };
  });
}

// ── 台账读写（runs/component-checks.json，独立文件） ─────────────────────────

// 校验整份台账形状：version 数字、components 对象、逐记录结构校验、组合层
// 保留键零容忍。违规抛显式错误（parse 侧转 ok:false —— unparseable 态）。
export function assertComponentLedgerShape(ledger, label = "component ledger") {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    throw new Error(`${label}: top level must be an object, got ${JSON.stringify(ledger)}`);
  }
  assertNoCompositionLayerLeak(ledger, label);
  if (typeof ledger.version !== "number") {
    throw new Error(`${label}: missing numeric "version"`);
  }
  if (!ledger.components || typeof ledger.components !== "object" || Array.isArray(ledger.components)) {
    throw new Error(`${label}: missing object "components" map`);
  }
  for (const [key, record] of Object.entries(ledger.components)) {
    if (record?.key !== key) {
      throw new Error(`${label}: components["${key}"] must carry key === "${key}"`);
    }
    validateComponentRecord(record, `${label}.components["${key}"]`);
  }
  if (ledger.counts !== undefined) {
    if (!ledger.counts || typeof ledger.counts !== "object" || Array.isArray(ledger.counts)) {
      throw new Error(`${label}: "counts" must be an object`);
    }
    for (const k of Object.keys(ledger.counts)) {
      if (!COMPONENT_RESULTS.includes(k)) {
        throw new Error(
          `${label}: counts key ${JSON.stringify(k)} outside component closed set [${COMPONENT_RESULTS.join("|")}]`,
        );
      }
    }
  }
  return true;
}

// 纯解析：文本 → { ok: true, ledger } | { ok: false, error }（显式错误，
// 绝不静默跳过）。
export function parseComponentLedger(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `component ledger JSON unparseable: ${err?.message ?? err}` };
  }
  try {
    assertComponentLedgerShape(data);
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
  return { ok: true, ledger: data };
}

// 序列化（落盘前再过一次隔离守卫——防调用方在 summary 构造后注入组合层字段）。
export function serializeComponentLedger(summary) {
  assertNoCompositionLayerLeak(summary, "component ledger serialization");
  return JSON.stringify(summary, null, 2) + "\n";
}

// 读台账文件 → 三态文件状态（六态的前三态来源）：
//   ledger-missing：文件不存在（组件“未验证”——不是红也不是绿）；
//   unparseable：  JSON 坏 / 形状坏 / 含组合层保留键 / 读失败（显式报错）；
//   loaded：       解析 + 形状校验通过。
export function readComponentLedgerFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {
        state: "ledger-missing",
        path,
        reason: "component ledger file not found — component is 未验证 (neither red nor green)",
      };
    }
    return { state: "unparseable", path, error: `component ledger unreadable: ${err?.message ?? err}` };
  }
  const parsed = parseComponentLedger(text);
  if (!parsed.ok) return { state: "unparseable", path, error: parsed.error };
  return { state: "loaded", path, ledger: parsed.ledger };
}

// 写台账文件（隔离守卫 fail-closed：payload 含组合层保留键即抛错拒绝写入）。
export function writeComponentLedgerFile(path, summary) {
  const text = serializeComponentLedger(summary);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return { path, bytes: Buffer.byteLength(text, "utf8") };
}

// ── 六态分类（消费路径） ─────────────────────────────────────────────────────

function shortRef(ref) {
  const s = String(ref);
  return s.length > 12 ? s.slice(0, 12) + "…" : s;
}

// 对单个组件键做台账消费分类。fileState = readComponentLedgerFile 的返回值；
// context（全部可注入，测试确定性）：
//   now               —— 分类基准时刻（默认当前时间）；
//   currentCodeRef    —— 当前 WAO repo git HEAD（codeRef 比对维；缺省跳过该维）；
//   maxAgeDays        —— 组件记录新鲜期（默认 30 天）；
//   fixtureMaxAgeDays —— 夹具组合认证新鲜期（默认 30 天）。
//
// 返回 { state, reason, record?, error? } —— 显式状态，绝非布尔。
// 判定优先级（确定性，先高后低）：
//   1. ledger-missing —— 台账文件不存在，或键无记录（两者 reason 区分；都显示
//                        “未验证”——不是红也不是绿）；
//   2. unparseable    —— 台账不可解析/形状非法/含组合层保留键（显式报错，
//                        消费方必须浮出，绝不静默跳过）；
//   3. blocked        —— 记录结果是 blocked（验证时夹具不可用）；
//   4. fixture-decayed—— 记录已被 annotateFixtureDecay 标注，或夹具资格现判
//                        过期（历史记录降 advisory，不删——record 原样带回）；
//                        优先于 stale：证据基准腐烂比记录自身陈旧更强；
//   5. stale          —— codeRef 不匹配，或 lastVerifiedAt 缺失/不可解析
//                        （fail-closed：无法证明新鲜即按陈旧处理），或超期；
//   6. normal         —— 记录现行且新鲜（record.result 可能是 pass 或 fail——
//                        六态描述台账数据的可信度，组件判定词在 record.result）。
export function classifyComponent(fileState, key, context = {}) {
  assertNamespacedKey(key);
  if (!fileState || typeof fileState !== "object" || !COMPONENT_LEDGER_FILE_STATES.includes(fileState.state)) {
    throw new Error(
      `classifyComponent: fileState must come from readComponentLedgerFile ({state: ledger-missing|unparseable|loaded}), got ${JSON.stringify(fileState?.state ?? fileState)}`,
    );
  }
  if (fileState.state === "ledger-missing") {
    return {
      state: "ledger-missing",
      reason: fileState.reason
        ?? "component ledger file not found — component is 未验证 (neither red nor green)",
    };
  }
  if (fileState.state === "unparseable") {
    return {
      state: "unparseable",
      reason: "component ledger unparseable — surface this as an explicit error, never skip silently (ADR-0032 §5)",
      error: fileState.error ?? "unknown parse error",
    };
  }
  const record = fileState.ledger?.components?.[key];
  if (!record) {
    return {
      state: "ledger-missing",
      reason: `no record for component key "${key}" in the component ledger — component is 未验证 (neither red nor green)`,
    };
  }
  if (record.result === "blocked") {
    return {
      state: "blocked",
      reason: record.blockedReason ?? "fixture unavailable at verification time (ADR-0032 §4)",
      record,
    };
  }
  if (record.advisory?.code === "fixture-decayed") {
    return {
      state: "fixture-decayed",
      reason: record.advisory.reason ?? "fixture qualification expired",
      record,
    };
  }
  if (record.fixture) {
    const fixtureState = fixtureQualificationState(record.fixture, context);
    if (fixtureState === "expired") {
      return {
        state: "fixture-decayed",
        reason: `fixture qualification expired (qualifiedBy ${record.fixture.qualifiedBy}) — historical record demoted to advisory, retained not deleted (ADR-0032 §5)`,
        record,
      };
    }
  }
  // stale 维 1：codeRef 不匹配（组件验证时的 repo 状态 ≠ 当前 HEAD）。
  if (
    context.currentCodeRef != null
    && record.codeRef != null
    && record.codeRef !== context.currentCodeRef
  ) {
    return {
      state: "stale",
      reason: `codeRef mismatch: record verified at ${shortRef(record.codeRef)}, current HEAD ${shortRef(context.currentCodeRef)} — advisory (ADR-0032 §5)`,
      record,
    };
  }
  // stale 维 2：lastVerifiedAt 缺失/不可解析 → fail-closed（无法证明新鲜）。
  const verifiedMs = typeof record.lastVerifiedAt === "string"
    ? new Date(record.lastVerifiedAt).getTime()
    : Number.NaN;
  if (!Number.isFinite(verifiedMs)) {
    return {
      state: "stale",
      reason: "lastVerifiedAt missing or unparseable — cannot prove freshness, treated as stale (fail-closed)",
      record,
    };
  }
  // stale 维 3：超期。
  const nowMs = Date.parse(context.now ?? new Date().toISOString());
  const maxAgeDays = context.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const ageDays = (nowMs - verifiedMs) / DAY_MS;
  if (ageDays > maxAgeDays) {
    return {
      state: "stale",
      reason: `record expired: lastVerifiedAt is ${Math.max(0, Math.round(ageDays))} days old (> ${maxAgeDays}) — advisory (ADR-0032 §5)`,
      record,
    };
  }
  return {
    state: "normal",
    reason: `record current: result=${record.result}, verified within ${maxAgeDays} days`,
    record,
  };
}

// 一步便利：读文件 + 分类（消费路径的最小接线）。
export function classifyComponentFromFile(path, key, context = {}) {
  return classifyComponent(readComponentLedgerFile(path), key, context);
}
