import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessBackend } from "./processBackend.js";
import { ClaudeStreamParser } from "./parsers/claudeCode.js";
import { resolveProviderArgs } from "./claudeCodeProvider.js";
import { inheritedEnvNames } from "../envPolicy.js";

// claude-code-provider-wrapper.mjs 的绝对路径（本文件同目录的 ../../scripts/wrappers/）。
const WRAPPER_PATH = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "wrappers", "claude-code-provider-wrapper.mjs"));

// M12-14 worker 上下文隔离：provider auto-memory 让 supervised worker 在 WAO 检测
// workdir_escape 之前编辑了 worktree 之外的全局 memory 文件。对【每一个】claude 子
// 进程（native OAuth / provider wrapper / start / resume）强制关闭 auto-memory。
// 经 backend 自己的 runtimeEnv 注入——runtimeEnv 在每次 spawn 都跑，无需 RunManager
// 或 runtime-name 分支；buildChildEnv 合并序保证它压过同名 agent.env。
const DISABLE_AUTO_MEMORY_ENV = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";

/**
 * Claude Code backend（M2-6）。
 * 薄封装：ProcessBackend + ClaudeStreamParser + 参数构造。
 *
 * 调用：claude -p "<prompt>" --output-format stream-json --verbose
 *
 * P4 融合项 #3（决策B）：优先用 agent.provider 一等字段推导参数（wrapper prependArgs +
 * claude CLI flags），单一真相源防漂移（opus-4.8 bug 温床）。无 provider 时向后兼容，
 * 走旧 agent.binary/prependArgs/args（手拼形态）。
 *
 * agent.args：仅作真正 ad-hoc 的 CLI flag 透传（如 ["--dangerously-skip-permissions"]）。
 *
 * M11-5 角色合同（TD-89 修复）：role contract 由 RunManager 经共享加载器
 * （roleContract.js）验证后，以 task.roleContract（已验证的字符串内容）传入。
 * 这里用 `--append-system-prompt <content>` 恰好一次注入——直接传内容，不传
 * 文件路径，消除 TOCTOU 竞态（加载验证 ROLE_A 后文件被替换为 ROLE_B 的窗口）。
 */
export class ClaudeCodeBackend extends ProcessBackend {
  // M11-5 Package A2: explicit role-contract capability declaration.
  // RunManager reads this boolean to decide whether a configured
  // agent.systemPrompt may be injected — it must NOT branch on the runtime
  // name. claude-code injects via --append-system-prompt (content, once).
  supportsRoleContract = true;

  // M11-11C: explicit provider-session-reuse capability declaration.
  // RunManager reads this boolean to gate sessionReuse routing provider-
  // neutrally (no runtime-name branch). claude-code expresses reuse natively:
  // first turn `--session-id <uuid>`, later turn `--resume <same uuid>`. The
  // opaque uuid is the only identifier handed to the provider; it derives from
  // (Lead session + bound workspace + agentId) deterministically, so the raw
  // Lead id / workspace / agentId never reach the provider.
  supportsSessionReuse = true;

  /**
   * M11-9 capability: declare exactly what this backend can express.
   *
   * Provider path (wrapper): model, reasoning, contextWindow, provider — all
   * translated by resolveProviderArgs.
   * Native OAuth path (no provider): model, reasoning — translated by buildArgs
   * directly. contextWindow and provider cannot be expressed natively (no
   * wrapper to set --context-window; provider without wrapper is meaningless).
   */
  validateAgentPolicy(agent) {
    const hasProvider = !!agent?.provider;
    // Provider path: can express everything.
    if (hasProvider) return; // model/reasoning/contextWindow/provider all OK.
    // Native path: model + reasoning OK; contextWindow/provider NOT expressible.
    if (agent?.model?.contextWindow) {
      throw new Error("claude-code native path (no provider) cannot express model.contextWindow — requires a provider wrapper");
    }
    // model.id and reasoning.effort are fine on native path.
  }

  constructor(opts = {}) {
    super({
      parserClass: ClaudeStreamParser,
      buildArgs: (agent, task) => {
        const args = [
          "-p", task.prompt,
          "--output-format", "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--exclude-dynamic-system-prompt-sections",
        ];
        // M11-11C: provider-native conversation reuse. First turn starts a named
        // session (--session-id); later turns resume it (--resume). Exactly one
        // flag, never both. The opaque uuid is supplied by the control plane
        // (derived from the reuse identity) — never the raw Lead/workspace id.
        if (task.sessionReuse && task.sessionReuse.turn === "first") {
          args.push("--session-id", task.sessionReuse.opaqueUuid);
        } else if (task.sessionReuse && task.sessionReuse.turn === "resume") {
          args.push("--resume", task.sessionReuse.opaqueUuid);
        } else {
          args.push("--no-session-persistence");
        }
        // M11-5：角色合同注入（config/roles/*.md，loader 已验证内容）。
        // --append-system-prompt <content> 恰好一次；用内容而非路径，消除 TOCTOU。
        if (task.roleContract) {
          args.push("--append-system-prompt", task.roleContract);
        }
        // M11-9: model/reasoning from canonical structured fields (single source).
        // When a provider exists, resolveProviderArgs returns cliFlags with
        // --model/--effort derived from the same fields. When no provider
        // (native OAuth direct-connect), we generate them here directly.
        const providerArgs = resolveProviderArgs(agent, WRAPPER_PATH);
        if (providerArgs) {
          args.push(...providerArgs.cliFlags);
        } else {
          // No provider: translate model/reasoning directly to CLI flags.
          if (agent.model?.id) args.push("--model", agent.model.id);
          if (agent.reasoning?.effort) args.push("--effort", agent.reasoning.effort);
        }
        // ad-hoc CLI flag 透传（如 --dangerously-skip-permissions）
        args.push(...(Array.isArray(agent.args) ? agent.args : []));
        return args;
      },
      // M11-7: delegate to the runtime-neutral env-policy SSOT (no mirrored
      // algorithm). inheritedEnvNames returns the declared credential name(s)
      // for claude-code (provider.apiKeyEnv / legacy --api-key-env).
      credentialEnvNames: (agent) => inheritedEnvNames(agent),
      runtimeEnv: (_agent, task) => ({
        CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
        // M12-14: auto-memory 必须对每个 supervised claude 子进程关闭（见顶部常量注释）。
        [DISABLE_AUTO_MEMORY_ENV]: "1",
        ...(task.deliveryMode ? { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1" } : {}),
      }),
      ...opts,
    });
  }

  /**
   * M12-14：backend 安全 env 必须扛住 agent.env 的反设企图。
   *
   * buildChildEnv 让 runtimeEnv（waoEnv 段）压过【同名】agent.env，但 Windows
   * env 大小写不敏感：agent.env 里的小写/混合大小写变体会与权威值并存进子进程
   * env block，解析结果不确定。spawn 前把 agent.env 中该名字的任意大小写变体
   * 剥离，让 runtimeEnv 成为唯一权威来源（同 KimiCodeBackend.spawn 的
   * backend-owned env 模式）。不改变凭据优先级，不读取、不暴露任何 env 值。
   */
  async spawn(agent, task) {
    const agentEnv = agent?.env ?? {};
    const stripped = {};
    let removed = false;
    for (const [name, value] of Object.entries(agentEnv)) {
      if (name.toUpperCase() === DISABLE_AUTO_MEMORY_ENV) {
        removed = true;
        continue;
      }
      stripped[name] = value;
    }
    return super.spawn(removed ? { ...agent, env: stripped } : agent, task);
  }

  // P4 决策B：有 provider 时，binary=node + prependArgs 从 provider 推导（wrapper 调起）。
  // 无 provider 时走默认（resolveBinary → claude on PATH，旧形态用 agent.binary/prependArgs）。
  async resolveBinary(agent) {
    const providerArgs = resolveProviderArgs(agent, WRAPPER_PATH);
    if (providerArgs) {
      return { binary: process.execPath, prependArgs: providerArgs.prependArgs };
    }
    return super.resolveBinary(agent);
  }

  defaultBinary() {
    return "claude";
  }
}
