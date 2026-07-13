import { existsSync } from "node:fs";
import { ProcessBackend } from "./processBackend.js";
import { CodexStreamParser } from "./parsers/codex.js";

/**
 * Codex backend（M2-6）。
 *
 * Windows 上 codex 是 codex.cmd 包装器，Node spawn 受 CVE 补丁限制不能直接跑 .cmd。
 * 解法：绕过 .cmd，直接用 node 跑 codex.js 入口。
 * codex.cmd 最终执行的就是：node <npm-global>/node_modules/@openai/codex/bin/codex.js %*
 */
export class CodexBackend extends ProcessBackend {
  constructor(opts = {}) {
    super({
      parserClass: CodexStreamParser,
      buildArgs: (_agent, task) => [
        "exec",
        "--json",
        "--skip-git-repo-check",
        task.prompt,
      ],
      credentialEnvNames: () => ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME"],
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
