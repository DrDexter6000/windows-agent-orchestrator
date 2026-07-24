import { readFile } from "node:fs/promises";
import { isValidCanonicalAgentId } from "./canonicalAgentId.js";

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
      throw new Error(`Agent ${id} has invalid systemPrompt: must be a non-empty string when present`);
    }
  }
  return {
    id,
    ...agent,
  };
}
