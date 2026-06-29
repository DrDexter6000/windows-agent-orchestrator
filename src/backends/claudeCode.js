import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessBackend } from "./processBackend.js";
import { ClaudeStreamParser } from "./parsers/claudeCode.js";
import { resolveProviderArgs } from "./claudeCodeProvider.js";

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
 * agent.systemPrompt：角色契约文件路径，存在则用 --append-system-prompt-file 注入。
 */
export class ClaudeCodeBackend extends ProcessBackend {
  constructor(opts = {}) {
    super({
      parserClass: ClaudeStreamParser,
      buildArgs: (agent, task) => {
        const args = [
          "-p", task.prompt,
          "--output-format", "stream-json",
          "--verbose",
        ];
        // 角色契约注入（config/roles/*.md）：只含身份/边界/纪律，禁编排逻辑（纪律测试守卫）
        if (agent.systemPrompt) {
          const p = resolve(agent.systemPrompt);
          if (existsSync(p)) {
            args.push("--append-system-prompt-file", p);
          }
        }
        // P4 决策B：有 provider 时，claude CLI 的 --model/--effort 从 provider 推导
        // （与 wrapper 同源，防漂移）。无 provider 时这些应在 agent.args 里（旧形态）。
        const providerArgs = resolveProviderArgs(agent, WRAPPER_PATH);
        if (providerArgs) args.push(...providerArgs.cliFlags);
        // ad-hoc CLI flag 透传（如 --dangerously-skip-permissions）
        args.push(...(Array.isArray(agent.args) ? agent.args : []));
        return args;
      },
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

