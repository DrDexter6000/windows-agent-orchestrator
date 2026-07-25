import { ProcessBackend } from "./processBackend.js";
import { KimiStreamParser } from "./parsers/kimiCode.js";
import { inheritedEnvNames } from "../envPolicy.js";

/**
 * Kimi Code CLI backend（S2-2，阶段 2）。
 * 薄封装：ProcessBackend + KimiStreamParser + 参数构造。
 *
 * 调用：kimi -p "<prompt>" --output-format stream-json
 * agent.args 可追加额外参数（如 ["--yolo"]，自动化场景自动批准所有动作）。
 *
 * 进程式 backend：进程死即会话死，不存在 opencode 的 stop 虚假成功问题（TD-37）。
 * kimi 自带循环控制（max_steps_per_turn=100）+ 任务超时（agent_task_timeout_s=900），
 * 比 opencode（无任何自带控制）安全得多。
 *
 * 已知局限（无 token 闸门）：kimi stream-json 不含 usage/token 字段，进程式 backend
 * 无 session endpoint 可轮询。token 预算硬闸门（S1-1）对 kimi-code 无效。成本控制靠：
 * kimi 自带超时 + WAO waitTimeout。给 kimi agent 配 tokenBudget 不会报错但不生效。
 */
export class KimiCodeBackend extends ProcessBackend {
  // M11-5 Package A2: explicit role-contract capability declaration.
  // RunManager reads this boolean to decide role injection — no runtime-name
  // branch. kimi injects by concatenating role + task with a fixed delimiter
  // (prompt-level guidance, not system-level isolation).
  supportsRoleContract = true;

  /**
   * M11-9 CTO closeout: kimi 0.29.1 has no single-process effort override
   * channel (probe confirmed: no --effort/--config CLI flag; effort is global
   * in ~/.kimi-code/config.toml which WAO must not modify). Reject reasoning
   * BEFORE any side effects (transcript/worktree/spawn).
   *
   * Capability: kimi can express model.id (--model). It CANNOT express
   * reasoning.effort, contextWindow, or provider.
   */
  validateAgentPolicy(agent) {
    if (agent?.reasoning?.effort) {
      throw new Error(
        "kimi-code backend does not support reasoning.effort " +
        "(no single-process override channel in 0.29.1; " +
        "configure ~/.kimi-code/config.toml globally instead)",
      );
    }
    if (agent?.model?.contextWindow) {
      throw new Error("kimi-code backend cannot express model.contextWindow");
    }
    if (agent?.provider) {
      throw new Error("kimi-code backend cannot express provider (uses its own managed auth)");
    }
  }

  constructor(opts = {}) {
    super({
      parserClass: KimiStreamParser,
      buildArgs: (agent, task) => {
        // M11-9: model from canonical structured field. reasoning.effort is NOT
        // supported (kimi 0.29.1 has no single-process effort override channel;
        // effort is global in ~/.kimi-code/config.toml which WAO must not modify).
        if (agent.reasoning?.effort) {
          throw new Error("kimi-code backend does not support reasoning.effort (no single-process override channel; configure ~/.kimi-code/config.toml globally instead)");
        }
        // M11-5（TD-89 修复）：kimi CLI 无 system/developer message 通道
        // （-p 只接受单个 prompt 字符串，无 system flag）。fallback：把角色
        // 合同与任务用固定分隔组合进同一个 prompt。role 在前、task 在后、
        // 各恰好一次。
        //
        // 边界声明：这不是系统级权限隔离（kimi CLI 不提供）。角色边界靠
        // prompt 级引导，与 systemPrompt 在 claude/codex 的 transport 强度
        // 不同——文档须明确这一点。
        const ROLE_TASK_SEPARATOR = "\n\n---\n\n";
        const prompt = task.roleContract
          ? `${task.roleContract}${ROLE_TASK_SEPARATOR}${task.prompt}`
          : task.prompt;
        return [
          "-p", prompt,
          "--output-format", "stream-json",
          // M11-9: model from structured field (was previously in agent.args).
          ...(agent.model?.id ? ["--model", agent.model.id] : []),
          ...(Array.isArray(agent.args) ? agent.args : []),
        ];
      },
      // M11-7: delegate to the runtime-neutral env-policy SSOT.
      credentialEnvNames: (agent) => inheritedEnvNames(agent),
      ...opts,
    });
  }

  defaultBinary() {
    return "kimi";
  }
}
