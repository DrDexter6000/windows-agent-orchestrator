import { ProcessBackend } from "./processBackend.js";
import { KimiStreamParser } from "./parsers/kimiCode.js";
import { inheritedEnvNames } from "../envPolicy.js";

const KIMI_K3_MODEL_ID = "kimi-code/k3";
const KIMI_K3_EFFORTS = new Set(["low", "high", "max"]);
const KIMI_REASONING_EFFORT_ENV = "KIMI_MODEL_THINKING_EFFORT";

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
  // ADR-0031 §3.6 形状的 provider 会话复用（2026-09-21 落线）：会话 id 由 kimi 自产
  // 并在轮末 meta 帧 `session.resume_hint` 广告（首轮由 runner 运行期补记，resume 轮
  // 由 spawn 权威从转录取回后 in-process 送达）。上游实测（2026-09-21 直跑）：
  // `kimi -r <session_id>` 跨 run 携带上下文；错 id → `Session ... not found` 退出 1。
  supportsSessionReuse = true;
  // M11-5 Package A2: explicit role-contract capability declaration.
  // RunManager reads this boolean to decide role injection — no runtime-name
  // branch. kimi injects by concatenating role + task with a fixed delimiter
  // (prompt-level guidance, not system-level isolation).
  supportsRoleContract = true;

  // ADR-0025 批次 2（TD-87）：kimi stream-json 无 usage/token 字段（见上方类注释
  // "已知局限"）——显式声明 false（与 ProcessBackend 基类默认一致，此处显式化
  // 自文档）：tokenBudget 闸门收不到 token 事实，配 tokenBudget 不生效。
  // registry validate 据此对 tokenBudget 配置输出 ⚠（不阻塞）。
  reportsTokenUsage = false;

  // ADR-0032 §8 批次（2026-09-21）：命令退出码证据可产出——kimi stream-json 的
  // command 事件本身不带数值退出码（parser 投影 commandEvent(command, undefined)），
  // 但 tool_result 以 tool_call id 为关联键（parser toolResultEvent(id, ...)），
  // scorecard 的 withInferredCommandExitCode 据此可靠推断 0/1（reliability 记录
  // coder_mm commandEvidence 绿即此通道）。
  reportsCommandExitCode = true;

  /**
   * Kimi Code 0.29.1 exposes KIMI_MODEL_THINKING_EFFORT as a process-scoped
   * override for the Kimi provider. K3 accepts low/high/max. WAO compiles the
   * canonical reasoning field into that child-only environment variable.
   *
   * Capability: kimi can express model.id (--model) and K3 reasoning.effort.
   * It cannot express a WAO contextWindow override or provider policy.
   */
  validateAgentPolicy(agent) {
    const effort = agent?.reasoning?.effort;
    if (effort && (
      agent?.model?.id !== KIMI_K3_MODEL_ID ||
      !KIMI_K3_EFFORTS.has(effort)
    )) {
      throw new Error(
        "kimi-code backend does not support the configured reasoning.effort for this model",
      );
    }
    if (Object.hasOwn(agent?.env ?? {}, KIMI_REASONING_EFFORT_ENV)) {
      throw new Error(
        `${KIMI_REASONING_EFFORT_ENV} is managed by canonical reasoning.effort`,
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
        // provider 会话复用（2026-09-21）：resume 轮以 `-r <session_id>` 续接前任 run
        // 的会话；id 缺失/不可用在此**派发前**拒绝（双重拒绝点）。`-r` 是 kimi 自己
        // 在 `session.resume_hint` 里广告的续接开关（另有 `-S/--session`、`-c/--continue`）。
        const resumeArgs = [];
        if (task.sessionReuse?.turn === "resume") {
          const priorSessionId = task.priorProviderSessionId;
          if (typeof priorSessionId !== "string" || priorSessionId.length === 0) {
            throw new Error(
              "kimi-code sessionReuse resume turn requires the prior provider session id "
              + "(session.created.backendSessionId of the prior run) — refusing instead of "
              + "silently starting a fresh kimi conversation",
            );
          }
          resumeArgs.push("-r", priorSessionId);
        }
        return [
          "-p", prompt,
          "--output-format", "stream-json",
          ...resumeArgs,
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

  async spawn(agent, task) {
    this.validateAgentPolicy(agent);
    const effort = agent?.reasoning?.effort;
    const effectiveAgent = effort
      ? {
          ...agent,
          env: {
            ...(agent.env ?? {}),
            [KIMI_REASONING_EFFORT_ENV]: effort,
          },
        }
      : agent;
    return super.spawn(effectiveAgent, task);
  }

  defaultBinary() {
    return "kimi";
  }
}
