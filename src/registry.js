import { readFile } from "node:fs/promises";
import { isValidCanonicalAgentId } from "./canonicalAgentId.js";
import { isValidSessionReuseMode } from "./application/sessionReuse.js";

// M11-9: canonical model/reasoning/provider policy.
// Closed-set effort enum — the complete set of reasoning effort values WAO
// recognizes. Backends translate only these; anything else is malformed.
// R11-1: EXPORTED so the per-dispatch reasoning override SSOT
// (runManager.js isValid/assertValidReasoningOverride, re-exported downward
// through runDispatch.js for the CLI/MCP boundaries — the MODEL_OVERRIDE
// hosting precedent) validates against THIS array with zero drift; the MCP
// z.enum wire schema serializes the same six members from the same source.
export const REASONING_EFFORTS = Object.freeze([
  "minimal", "low", "medium", "high", "xhigh", "max",
]);

// R10-B: seat role closed set (decision 0023 seat vocabulary — registry schema、
// panelReadiness 引擎、展示层共用一个词汇表)。SEAT_ROLES 的家在 registry.js
// (core)：panelReadiness.js（application）下向 import 它合法；反过来
// registry→application 是上向边，触犯 L4 分层（TD-122 白名单已归零）。
export const SEAT_ROLES = Object.freeze([
  "adversarial", "implementation", "non_seat",
]);

// TD-161: backend closed set SSOT — the complete list of runtimes WAO can
// dispatch to. EXPORTED so every consumer validates against THIS array with
// zero drift (same discipline as REASONING_EFFORTS/SEAT_ROLES above): the
// unknown-backend gate in normalizeAgent below is the runtime authority, and
// the commands layer (registry validate) imports it downward (commands →
// core is a legal edge; the old hand-copied literal there is deleted).
// Adding/removing a member is an Owner decision — see ADR-0028.
// 注（auditor 2026-09-17 复核收窄）：本 SSOT 只覆盖"成员校验"面（闭集名单
// 出现的每一处都读它）；per-backend 专属字段校验分支、factory 构造器分发
// 与能力映射各自承载不同语义，不在单点修改承诺内。
export const KNOWN_BACKENDS = Object.freeze([
  "opencode-serve", "claude-code", "codex", "kimi-code", "deepseek-harness",
  // ADR-0031（B-2）：DSH ACP 集成面 backend（dsh --profile acp）。闭集 5→6
  // 扩员由 ADR-0031 提议，待 Owner 裁定 accepted（Owner 未决——不声称已授权）。
  // 新旧两线并存；旧 deepseek-harness 保留至新线认证通过后由 Owner 决定去留
  // （ADR-0031 §3.7）。回退面集中：移除本成员 + factory/registry/docs 同步即可。
  "deepseek-acp",
]);

// TD-161（auditor F3 修复）：unknown-backend 指路文案的单一真相——
// normalizeAgent 的 throw 与 commands 层 validate 的 issue 共用，保证组合
// 错误路径（坏 backend + 其他硬错误，normalizeAgent 先抛别的错）下支持集
// 提示仍完整且恰好出现一次。静态文案：只含支持集与指路，无用户数据。
export function unknownBackendGuidance(backend) {
  return (
    `unknown backend: ${backend} (supported: ${KNOWN_BACKENDS.join("/")}). ` +
    `To use a different model, configure the model/provider fields on an existing backend; ` +
    `to add a new backend (a different CLI/runtime), that is an Owner decision — ` +
    `see ADR-0028 (previously evaluated candidates, e.g. zcode) in .wao/decisions/.`
  );
}

// Flags that are MANAGED by the structured model/reasoning/provider fields.
// If ANY of these appear in args/prependArgs, the configuration is using the
// old hand-crafted form. M11-9 CTO closeout: there is NO transparent legacy
// extraction — these flags in args/prependArgs are a fixed migration error.
// The user must migrate to structured fields explicitly.
const MANAGED_FLAGS = Object.freeze([
  "--model", "--default-model", "--effort", "--context-window",
]);

/**
 * Check whether an args array contains any managed flag.
 * @param {string[]} args
 * @returns {string|null} the first matching flag, or null
 */
function findManagedFlag(args) {
  if (!Array.isArray(args)) return null;
  for (const f of MANAGED_FLAGS) {
    if (args.includes(f)) return f;
  }
  return null;
}

/**
 * M11-9: Validate the canonical model/reasoning/provider policy.
 *
 * Enforces the CTO contract:
 *   model?:     { id: string, contextWindow?: positive integer }
 *   reasoning?: { effort: "minimal"|"low"|"medium"|"high"|"xhigh"|"max" }
 *   provider?:  { protocol: "anthropic-compatible", baseUrl: string, apiKeyEnv: string }
 *
 * Rules:
 *   - provider MUST NOT carry model/effort/contextWindow (old shape → reject).
 *   - provider present → protocol/baseUrl/apiKeyEnv ALL required and non-blank.
 *     A half-provider must NOT trigger the wrapper path.
 *   - managed flags (--model/--default-model/--effort/--context-window) in
 *     args/prependArgs → fixed migration error. No transparent extraction.
 *   - malformed values → reject with a fixed safe error (no echo of malicious value).
 *
 * @param {string} id — agent id (for error clarity, never echoes malicious values)
 * @param {object} agent — raw agent config
 */
function normalizeModelPolicy(id, agent) {
  // --- managed-flag detection (args/prependArgs) ---
  // M11-9 CTO closeout: NO legacy extraction. Any managed flag in args/prependArgs
  // is a fixed migration error — the config must use structured fields.
  const flagInArgs = findManagedFlag(agent.args);
  const flagInPrepend = findManagedFlag(agent.prependArgs);
  if (flagInArgs || flagInPrepend) {
    throw new Error(
      `Agent ${id}: model/reasoning flags in args/prependArgs are no longer supported — ` +
      `migrate to structured model/reasoning fields (see docs/02-architecture.md M11-9)`,
    );
  }

  // --- provider validation (strict: all three required when present) ---
  if (agent.provider !== undefined && agent.provider !== null) {
    const p = agent.provider;
    if (typeof p !== "object") {
      throw new Error(`Agent ${id}: provider must be an object`);
    }
    if (p.model !== undefined || p.effort !== undefined || p.contextWindow !== undefined) {
      throw new Error(`Agent ${id}: provider must not carry model/effort/contextWindow (use top-level model/reasoning)`);
    }
    if (p.protocol !== "anthropic-compatible") {
      throw new Error(`Agent ${id}: provider.protocol must be "anthropic-compatible"`);
    }
    if (typeof p.baseUrl !== "string" || p.baseUrl.trim().length === 0) {
      throw new Error(`Agent ${id}: provider.baseUrl is required and must be a non-blank string`);
    }
    if (typeof p.apiKeyEnv !== "string" || p.apiKeyEnv.trim().length === 0) {
      throw new Error(`Agent ${id}: provider.apiKeyEnv is required and must be a non-blank string`);
    }
  }

  // --- model validation ---
  if (agent.model !== undefined && agent.model !== null) {
    const m = agent.model;
    if (typeof m !== "object") {
      throw new Error(`Agent ${id}: model must be an object`);
    }
    if (typeof m.id !== "string" || m.id.length === 0) {
      throw new Error(`Agent ${id}: model.id must be a non-empty string`);
    }
    if (m.contextWindow !== undefined) {
      if (typeof m.contextWindow !== "number" || !Number.isInteger(m.contextWindow) || m.contextWindow <= 0) {
        throw new Error(`Agent ${id}: model.contextWindow must be a positive integer`);
      }
    }
  }

  // --- reasoning validation ---
  if (agent.reasoning !== undefined && agent.reasoning !== null) {
    const r = agent.reasoning;
    if (typeof r !== "object") {
      throw new Error(`Agent ${id}: reasoning must be an object`);
    }
    if (!REASONING_EFFORTS.includes(r.effort)) {
      throw new Error(`Agent ${id}: reasoning.effort must be one of the supported values`);
    }
  }
}

export async function readRegistry(filePath) {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  const agents = parsed.agents ?? {};

  return {
    listAgents() {
      return Object.entries(agents).map(([id, agent]) => normalizeAgent(id, agent));
    },
    getAgent(id, overrides = {}) {
      if (!agents[id]) {
        throw new Error(`Unknown agent: ${id}`);
      }
      const definedOverrides = Object.fromEntries(
        Object.entries(overrides).filter(([, value]) => value !== undefined),
      );
      return normalizeAgent(id, { ...agents[id], ...definedOverrides });
    },
    // M12-25: raw [id, agentConfig] pairs WITHOUT normalization. Used ONLY by the
    // partial inventory projector (getRegistryInventoryWithIssues) so a single
    // malformed/unsupported entry cannot abort the whole list — the projector
    // normalizes each entry individually and collects bounded safe issues. The
    // strict paths (listAgents / getAgent) remain strict and are NOT weakened:
    // they still throw on the first bad entry (CLI `registry list`/`validate`).
    rawEntries() {
      return Object.entries(agents);
    },
  };
}

export function normalizeAgent(id, agent) {
  // M11-8B closeout: the agentId must be a valid canonical id (closed-set
  // alphabet A-Z/a-z/0-9/._-, 1..128). This is a configuration-validity check,
  // not a Lead workflow gate — an invalid id is rejected before any
  // transcript/spawn. The error is a FIXED SAFE SHAPE: it never echoes the
  // supplied id (a malicious id could itself be sensitive or carry an
  // injection payload into logs/errors).
  if (!isValidCanonicalAgentId(id)) {
    throw new Error("registry contains an agent with an invalid id (must match [A-Za-z0-9._-], 1..128 chars)");
  }
  if (!agent.backend) {
    throw new Error(`Agent ${id} is missing backend`);
  }
  if (!agent.cwd) {
    throw new Error(`Agent ${id} is missing cwd`);
  }
  // R7-C (C-8): a non-string truthy cwd (e.g. {} / 42 / true) used to pass
  // this truthiness check and silently skip the R7-AB cwd-existence early
  // refusal downstream (runManager.js resolvePredictedDispatchCwd only
  // recognizes strings) — fail closed at the registry SSOT instead, exactly
  // like `registry validate` surfaces every other malformed entry.
  if (typeof agent.cwd !== "string") {
    throw new Error(`Agent ${id}: cwd must be a non-empty string`);
  }
  // TD-161: unknown-backend gate — closed-set membership via the
  // KNOWN_BACKENDS SSOT above (replaces the else-arm throw that used to tail
  // the per-backend chain; the field-validation branches below are unchanged
  // and together cover every member). Fixed-safe: static supported set +
  // static guidance; only the bad value itself is echoed (existing behavior).
  // rejected backend candidates (e.g. zcode → ADR-0028) are Owner decisions;
  // pointer only, never reasons here
  if (!KNOWN_BACKENDS.includes(agent.backend)) {
    throw new Error(`Agent ${id} has ${unknownBackendGuidance(agent.backend)}`);
  }
  if (agent.backend === "opencode-serve") {
    if (!agent.serveUrl) {
      throw new Error(`Agent ${id} is missing serveUrl`);
    }
    if (!agent.model?.providerID || !agent.model?.id) {
      throw new Error(`Agent ${id} is missing model.providerID/model.id`);
    }
  } else if (agent.backend === "claude-code" || agent.backend === "codex" || agent.backend === "kimi-code") {
    // 进程式 backend：serveUrl/model 非必填（进程自带模型配置）。
    // binary 可选（默认走 PATH 里的 claude/codex/kimi）。
  } else if (agent.backend === "deepseek-harness") {
    if (typeof agent.dshConfigPath !== "string" || agent.dshConfigPath.trim().length === 0) {
      throw new Error(`Agent ${id} is missing dshConfigPath`);
    }
    if (typeof agent.credentialEnv !== "string" || agent.credentialEnv.trim().length === 0) {
      throw new Error(`Agent ${id}: credentialEnv is required and must be a non-blank string`);
    }
    if (Object.prototype.hasOwnProperty.call(agent, "dshProvider")
      && (typeof agent.dshProvider !== "string" || agent.dshProvider.trim().length === 0)) {
      throw new Error(`Agent ${id}: dshProvider must be a non-blank string when present`);
    }
  } else if (agent.backend === "deepseek-acp") {
    // ADR-0031：组合面固定为 `dsh --profile acp --patch <containment>`——
    // dshConfigPath/dshProvider 属旧线字段，本线不用；binary 可选（缺省 dsh）。
    if (typeof agent.credentialEnv !== "string" || agent.credentialEnv.trim().length === 0) {
      throw new Error(`Agent ${id}: credentialEnv is required and must be a non-blank string`);
    }
  }
  // M10-pre: validate agent.waitTimeout if present (production range).
  if (agent.waitTimeout !== undefined && agent.waitTimeout !== null) {
    const wt = Number(agent.waitTimeout);
    if (!Number.isFinite(wt) || !Number.isInteger(wt) || wt < 1000 || wt > 600000) {
      throw new Error(
        `Agent ${id} has invalid waitTimeout: must be an integer in [1000, 600000], got: ${JSON.stringify(agent.waitTimeout)}`,
      );
    }
  }
  // M11-5 Package C3: systemPrompt uses OWN-PROPERTY semantics.
  //   - property ABSENT (not an own property)  → no role contract (legitimate).
  //   - own property present, value undefined / null / blank / non-string → REJECT.
  //   - own property present, non-empty trimmed string                     → legitimate.
  // Own-property semantics distinguish "field omitted" from "field set to
  // undefined" — the latter is a malformed registry entry, not "no role".
  // The error is a FIXED SAFE SHAPE: it never echoes the supplied value, a
  // path, role content, or any sentinel (a bad value could itself be sensitive
  // or inject a payload into logs).
  if (Object.prototype.hasOwnProperty.call(agent, "systemPrompt")) {
    const sp = agent.systemPrompt;
    if (typeof sp !== "string" || sp.trim().length === 0) {
      throw new Error(`Agent ${id}: systemPrompt: must be a non-empty string when present`);
    }
  }
  // M11-11C: sessionReuse policy is a closed set. A value outside the set is a
  // malformed registry entry — rejected before any transcript/spawn. Absent is
  // legitimate (agent retains current behavior). The error is a fixed safe
  // shape; it does not echo the supplied value.
  if (agent.sessionReuse !== undefined && agent.sessionReuse !== null) {
    if (!isValidSessionReuseMode(agent.sessionReuse)) {
      throw new Error(`Agent ${id}: sessionReuse must be one of the supported modes (got an unsupported value)`);
    }
  }
  // R10-B: seatRole uses OWN-PROPERTY semantics like systemPrompt.
  //   - property ABSENT → legitimate：席位角色回退既有命名惯例
  //     （panelReadiness.seatRoleOf 的 adversarial/implementation/non_seat 分类，
  //     老 registry 零迁移）。
  //   - own property present, value non-string / outside the SEAT_ROLES closed
  //     set → REJECT（显式声明必须落在闭集内；非席位用 "non_seat" 显式声明）。
  // The error is a FIXED SAFE SHAPE: it never echoes the supplied value
  // （坏值本身可能敏感或带注入载荷）。
  if (Object.prototype.hasOwnProperty.call(agent, "seatRole")) {
    if (typeof agent.seatRole !== "string" || !SEAT_ROLES.includes(agent.seatRole)) {
      throw new Error(`Agent ${id}: seatRole must be one of the supported seat roles (adversarial/implementation/non_seat)`);
    }
  }
  // M11-9: canonical model/reasoning/provider policy validation + legacy normalization.
  normalizeModelPolicy(id, agent);
  return {
    id,
    ...agent,
  };
}

/**
 * R23-C §5: half-migration visibility for certification records.
 *
 * A reliability-summary worker record written before R23-C lacks BOTH new
 * fields:
 *   - providerKey        (identity dimension #4 — normalized baseUrl +
 *                        apiKeyEnv NAME fingerprint)
 *   - lastFullHealthyRunAt (full-scope-only freshness basis; the dispatch
 *                        gate falls back to lastHealthyRunAt while absent)
 *
 * This helper states that fact as NON-BLOCKING advisories (validate output —
 * the registry entry itself is valid; only its certification ledger predates
 * the schema). Tri-state discipline, same as matchedCertRecord consumes:
 *   - field ABSENT (undefined)          → legacy record → advisory.
 *   - field present as null             → observed fact (no derivable provider
 *                                         / never full-scope green) → MIGRATED,
 *                                         no advisory.
 *   - field present as a string         → migrated → no advisory.
 * No record at all (never certified) → no advisory — there is no ledger to
 * migrate.
 *
 * Pure: takes the raw worker record object (or undefined), returns string[]
 * WITHOUT the agent-id prefix — callers render as `⚠ ${id}: ${msg}`, matching
 * the existing registry-validate warning convention. Never echoes record
 * values (disk data may be tampered).
 *
 * @param {object|undefined} workerRecord — one entry of summary.workers
 * @returns {string[]}
 */
export function certMigrationAdvisories(workerRecord) {
  const advisories = [];
  if (!workerRecord || typeof workerRecord !== "object") return advisories;
  if (workerRecord.providerKey === undefined) {
    advisories.push("认证记录缺少 providerKey（R23-C 第 4 身份维）——legacy 台账，该维度暂不参与比对；重跑 reliability 认证后自动补全");
  }
  if (workerRecord.lastFullHealthyRunAt === undefined) {
    advisories.push("认证记录缺少 lastFullHealthyRunAt（R23-C 全量新鲜度判据）——派发门暂回落 lastHealthyRunAt；重跑全量认证后切换");
  }
  return advisories;
}
