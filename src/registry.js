import { readFile } from "node:fs/promises";
import { isValidCanonicalAgentId } from "./canonicalAgentId.js";

// M11-9: canonical model/reasoning/provider policy.
// Closed-set effort enum — the complete set of reasoning effort values WAO
// recognizes. Backends translate only these; anything else is malformed.
const REASONING_EFFORTS = Object.freeze([
  "minimal", "low", "medium", "high", "xhigh", "max",
]);

// Flags that, if present in args/prependArgs alongside structured fields,
// indicate a mixed-authority (duplicate) configuration — the single-source
// contract violation this normalizer rejects.
const DUPLICATE_FLAGS = Object.freeze([
  "--model", "--default-model", "--effort", "--context-window",
]);

/**
 * Check whether an args array contains any of the duplicate-authority flags.
 * @param {string[]} args
 * @returns {string|null} the first matching flag, or null
 */
function findDuplicateFlag(args) {
  if (!Array.isArray(args)) return null;
  for (const f of DUPLICATE_FLAGS) {
    if (args.includes(f)) return f;
  }
  return null;
}

/**
 * Extract --flag <value> from an args array. Returns undefined if not found.
 */
function extractFlag(args, flag) {
  if (!Array.isArray(args)) return undefined;
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/**
 * Remove --flag <value> pairs from an args array (returns a new array).
 */
function removeFlagPairs(args, flags) {
  if (!Array.isArray(args)) return [];
  const flagSet = new Set(flags);
  const result = [];
  for (let i = 0; i < args.length; i += 1) {
    if (flagSet.has(args[i])) {
      i += 1; // skip the value too
    } else {
      result.push(args[i]);
    }
  }
  return result;
}

/**
 * M11-9: Validate and normalize the canonical model/reasoning/provider policy.
 *
 * Enforces the CTO contract:
 *   model?:     { id: string, contextWindow?: positive integer }
 *   reasoning?: { effort: "minimal"|"low"|"medium"|"high"|"xhigh"|"max" }
 *   provider?:  { protocol: "anthropic-compatible", baseUrl, apiKeyEnv }
 *
 * Rules:
 *   - provider MUST NOT carry model/effort/contextWindow (old shape → reject).
 *   - structured fields + duplicate flags in args/prependArgs → reject (mixed authority).
 *   - legacy-only (no structured fields, model in args) → normalized to canonical
 *     (model extracted to structured field, flag removed from args). This is the
 *     ONLY compatibility path; it exists solely at this normalization boundary.
 *   - malformed values → reject with a fixed safe error (no echo of malicious value).
 *
 * Mutates `agent` in place: sets model/reasoning/provider canonical fields and
 * cleans args/prependArgs of extracted flags.
 *
 * @param {string} id — agent id (for error clarity, never echoes malicious values)
 * @param {object} agent — raw agent config
 */
function normalizeModelPolicy(id, agent) {
  const hasStructuredModel = agent.model !== undefined && agent.model !== null;
  const hasStructuredReasoning = agent.reasoning !== undefined && agent.reasoning !== null;
  const hasStructuredProvider = agent.provider !== undefined && agent.provider !== null;

  // --- provider validation (must not carry old-shape model/effort/contextWindow) ---
  if (hasStructuredProvider) {
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
    if (typeof p.baseUrl !== "string" || p.baseUrl.length === 0) {
      throw new Error(`Agent ${id}: provider.baseUrl is required`);
    }
    if (typeof p.apiKeyEnv !== "string" || p.apiKeyEnv.length === 0) {
      throw new Error(`Agent ${id}: provider.apiKeyEnv is required`);
    }
  }

  // --- model validation ---
  if (hasStructuredModel) {
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
  if (hasStructuredReasoning) {
    const r = agent.reasoning;
    if (typeof r !== "object") {
      throw new Error(`Agent ${id}: reasoning must be an object`);
    }
    if (!REASONING_EFFORTS.includes(r.effort)) {
      throw new Error(`Agent ${id}: reasoning.effort must be one of the supported values`);
    }
  }

  // --- mixed authority detection ---
  // If ANY structured field is present, duplicate flags in args/prependArgs are rejected.
  const hasAnyStructured = hasStructuredModel || hasStructuredReasoning || hasStructuredProvider;
  const dupInArgs = findDuplicateFlag(agent.args);
  const dupInPrepend = findDuplicateFlag(agent.prependArgs);
  if (hasAnyStructured && (dupInArgs || dupInPrepend)) {
    throw new Error(`Agent ${id}: duplicate model/reasoning flag in args/prependArgs — use structured fields as the single source`);
  }

  // --- legacy-only compatibility: no structured fields, but model/effort in args ---
  if (!hasAnyStructured) {
    const legacyModel = extractFlag(agent.args, "--model") ?? extractFlag(agent.prependArgs, "--model");
    const legacyDefaultModel = extractFlag(agent.args, "--default-model") ?? extractFlag(agent.prependArgs, "--default-model");
    const legacyEffort = extractFlag(agent.args, "--effort") ?? extractFlag(agent.prependArgs, "--effort");
    const legacyContext = extractFlag(agent.args, "--context-window") ?? extractFlag(agent.prependArgs, "--context-window");

    const legacyDetected = legacyModel || legacyDefaultModel || legacyEffort || legacyContext;
    if (legacyDetected) {
      // Normalize: extract to structured fields, remove flags from args/prependArgs.
      // model: --model takes precedence over --default-model (CLI flag > wrapper default).
      const modelId = legacyModel ?? legacyDefaultModel;
      if (modelId) {
        agent.model = { id: modelId };
        if (legacyContext) agent.model.contextWindow = Number(legacyContext);
      }
      if (legacyEffort && REASONING_EFFORTS.includes(legacyEffort)) {
        agent.reasoning = { effort: legacyEffort };
      } else if (legacyEffort) {
        throw new Error(`Agent ${id}: legacy --effort value is not a supported reasoning effort`);
      }
      // Clean flags from args and prependArgs.
      agent.args = removeFlagPairs(agent.args, DUPLICATE_FLAGS);
      agent.prependArgs = removeFlagPairs(agent.prependArgs, DUPLICATE_FLAGS);
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
  // M11-9: canonical model/reasoning/provider policy validation + legacy normalization.
  normalizeModelPolicy(id, agent);
  return {
    id,
    ...agent,
  };
}
