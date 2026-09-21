import { existsSync } from "node:fs";
import { ProcessBackend } from "./processBackend.js";
import { CodexStreamParser } from "./parsers/codex.js";
import { inheritedEnvNames } from "../envPolicy.js";

/**
 * Codex backend（M2-6）。
 *
 * Windows 上 codex 是 codex.cmd 包装器，Node spawn 受 CVE 补丁限制不能直接跑 .cmd。
 * 解法：绕过 .cmd，直接用 node 跑 codex.js 入口。
 * codex.cmd 最终执行的就是：node <npm-global>/node_modules/@openai/codex/bin/codex.js %*
 */
export class CodexBackend extends ProcessBackend {
  // ADR-0031 §3.6 形状的 provider 会话复用（2026-09-21 落线）：codex 不接受控制面
  // 自选的会话 id，WAO 续接的是**运行时自产**的 thread id——首轮由 wire 广告、
  // runner 运行期补记，resume 轮由 spawn 权威从转录取回后 in-process 送达。
  // 上游实测（2026-09-21 直跑）：`codex exec resume <thread_id>` 跨 run 携带上下文；
  // 错 id → `no rollout found` 退出 1（fail-closed，无静默新会话）。
  supportsSessionReuse = true;
  // M11-5 Package A2: explicit role-contract capability declaration.
  // RunManager reads this boolean to decide role injection — no runtime-name
  // branch. codex injects via -c developer_instructions (append, not replace).
  supportsRoleContract = true;

  // ADR-0025 批次 2（TD-87）：codex --json 的 turn.completed 帧携带 usage
  // （CodexStreamParser 产出 metrics token 事实）——tokenBudget 闸门对该
  // backend 有效。registry validate 静态读取本声明做 tokenBudget 交叉校验。
  reportsTokenUsage = true;

  // ADR-0032 §8 批次（2026-09-21）：命令退出码证据可产出——codex --json 的
  // item.completed (command_execution) 帧 wire 原生携带 exit_code（parser 投影
  // commandEvent(command, item.exit_code)），数值退出码直接进 command 证据。
  reportsCommandExitCode = true;

  /**
   * M11-9 capability: Codex can express model (--model) and reasoning
   * (-c model_reasoning_effort). It cannot express contextWindow (no CLI flag)
   * or provider (Codex uses its own auth, not an anthropic-compatible wrapper).
   */
  validateAgentPolicy(agent) {
    if (agent?.model?.contextWindow) {
      throw new Error("codex backend cannot express model.contextWindow (no CLI flag for it)");
    }
    if (agent?.provider) {
      throw new Error("codex backend cannot express provider (uses its own auth, not an anthropic-compatible wrapper)");
    }
    // model.id and reasoning.effort are fine.
  }

  constructor(opts = {}) {
    super({
      parserClass: CodexStreamParser,
      buildArgs: (agent, task) => {
        // provider 会话复用（2026-09-21）：resume 轮以 `exec resume <thread_id>` 续接
        // 前任 run 的会话。id 缺失/不可用在此**派发前**拒绝（双重拒绝点：spawn
        // 权威已先拒一次）——绝不静默开一段全新对话。
        const args = [];
        if (task.sessionReuse?.turn === "resume") {
          const priorSessionId = task.priorProviderSessionId;
          if (typeof priorSessionId !== "string" || priorSessionId.length === 0) {
            throw new Error(
              "codex sessionReuse resume turn requires the prior provider thread id "
              + "(session.created.backendSessionId of the prior run) — refusing instead of "
              + "silently starting a fresh codex conversation",
            );
          }
          args.push("exec", "resume", priorSessionId, "--json", "--skip-git-repo-check");
        } else {
          args.push("exec", "--json", "--skip-git-repo-check");
        }
        // M11-9: model from canonical structured field.
        if (agent.model?.id) {
          args.push("--model", agent.model.id);
        }
        // M11-9: reasoning.effort — Codex supports -c model_reasoning_effort.
        // No-model probe: codex exec accepts -c overrides (same as developer_instructions).
        if (agent.reasoning?.effort) {
          args.push("-c", `model_reasoning_effort="${agent.reasoning.effort}"`);
        }
        // M11-5（TD-89 修复）：角色合同经共享加载器验证后以 task.roleContract
        // （字符串内容）传入。Codex 的 -c developer_instructions 是 append 到
        // developer message 的 config override（Stage 0 探针证明：不替换 base
        // instructions，task 仍是独立 user message）。TOML basic string 需安全
        // 转义（TOML 1.0 §basic strings：反斜杠 → \\，双引号 → \"，newline → \n，
        // CR → \r，tab → \t；其它 C0 控制字符不允许）。role 文件是多行 Markdown，
        // newline 必须转义否则产生无效 TOML。绝不使用 model_instructions_file
        // （它会替换 Codex 内置 base instructions）。
        if (task.roleContract) {
          const safe = task.roleContract
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n")
            .replace(/\t/g, "\\t");
          args.push("-c", `developer_instructions="${safe}"`);
        }
        args.push(task.prompt);
        return args;
      },
      // M11-7: delegate to the runtime-neutral env-policy SSOT.
      credentialEnvNames: (agent) => inheritedEnvNames(agent),
      ...opts,
    });
  }

  async resolveBinary(agent) {
    // 优先直接找 codex.js（绕过 .cmd），退路走通用 resolveBinary
    const jsPath = findCodexJs();
    if (jsPath) {
      return { binary: process.execPath, prependArgs: [jsPath] };
    }
    return super.resolveBinary(agent);
  }
}

/**
 * 探测 codex.js 的真实路径。npm 全局包通常在 %APPDATA%\npm\node_modules。
 */
function findCodexJs() {
  const candidates = [
    `${process.env.APPDATA}/npm/node_modules/@openai/codex/bin/codex.js`,
    `${process.env.LOCALAPPDATA}/npm/node_modules/@openai/codex/bin/codex.js`,
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}
