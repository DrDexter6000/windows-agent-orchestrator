import { ProcessBackend } from "./processBackend.js";
import { KimiStreamParser } from "./parsers/kimiCode.js";

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
  constructor(opts = {}) {
    super({
      parserClass: KimiStreamParser,
      buildArgs: (agent, task) => [
        "-p", task.prompt,
        "--output-format", "stream-json",
        ...(Array.isArray(agent.args) ? agent.args : []),
      ],
      credentialEnvNames: () => ["KIMI_API_KEY", "KIMI_BASE_URL", "KIMI_MODEL_NAME"],
      ...opts,
    });
  }

  defaultBinary() {
    return "kimi";
  }
}
