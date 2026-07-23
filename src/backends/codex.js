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
  // M11-5 Package A2: explicit role-contract capability declaration.
  // RunManager reads this boolean to decide role injection — no runtime-name
  // branch. codex injects via -c developer_instructions (append, not replace).
  supportsRoleContract = true;

  constructor(opts = {}) {
    super({
      parserClass: CodexStreamParser,
      buildArgs: (_agent, task) => {
        const args = [
          "exec",
          "--json",
          "--skip-git-repo-check",
        ];
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
