import { readFile } from "node:fs/promises";

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
  return {
    id,
    ...agent,
  };
}
