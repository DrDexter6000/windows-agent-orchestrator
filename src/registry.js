import { readFile } from "node:fs/promises";
import { isValidCanonicalAgentId } from "./canonicalAgentId.js";
import { isValidSessionReuseMode } from "./application/sessionReuse.js";

// M11-9: canonical model/reasoning/provider policy.
// Closed-set effort enum — the complete set of reasoning effort values WAO
// recognizes. Backends translate only these; anything else is malformed.
const REASONING_EFFORTS = Object.freeze([
  "minimal", "low", "medium", "high", "xhigh", "max",
]);

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
  } else {
    throw new Error(`Agent ${id} has unknown backend: ${agent.backend}`);
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
  // M11-9: canonical model/reasoning/provider policy validation + legacy normalization.
  normalizeModelPolicy(id, agent);
  return {
    id,
    ...agent,
  };
}
