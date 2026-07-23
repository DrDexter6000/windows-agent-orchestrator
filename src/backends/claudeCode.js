import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessBackend } from "./processBackend.js";
import { ClaudeStreamParser } from "./parsers/claudeCode.js";
import { resolveProviderArgs } from "./claudeCodeProvider.js";
import { inheritedEnvNames } from "../envPolicy.js";

// claude-code-provider-wrapper.mjs 的绝对路径（本文件同目录的 ../../scripts/wrappers/）。
const WRAPPER_PATH = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "wrappers", "claude-code-provider-wrapper.mjs"));

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

  constructor(opts = {}) {
    super({
      parserClass: ClaudeStreamParser,
      buildArgs: (agent, task) => {
        const args = [
          "-p", task.prompt,
          "--output-format", "stream-json",
          "--verbose",
        ];
        // M11-5：角色合同注入（config/roles/*.md，loader 已验证内容）。
        // --append-system-prompt <content> 恰好一次；用内容而非路径，消除 TOCTOU。
        if (task.roleContract) {
          args.push("--append-system-prompt", task.roleContract);
        }
        // P4 决策B：有 provider 时，claude CLI 的 --model/--effort 从 provider 推导
        // （与 wrapper 同源，防漂移）。无 provider 时这些应在 agent.args 里（旧形态）。
        const providerArgs = resolveProviderArgs(agent, WRAPPER_PATH);
        if (providerArgs) args.push(...providerArgs.cliFlags);
        // ad-hoc CLI flag 透传（如 --dangerously-skip-permissions）
        args.push(...(Array.isArray(agent.args) ? agent.args : []));
        return args;
      },
      // M11-7: delegate to the runtime-neutral env-policy SSOT (no mirrored
      // algorithm). inheritedEnvNames returns the declared credential name(s)
      // for claude-code (provider.apiKeyEnv / legacy --api-key-env).
      credentialEnvNames: (agent) => inheritedEnvNames(agent),
      ...opts,
    });
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
