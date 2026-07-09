// TD-98 阶段 2a：共享 CLI 命令工具。
//
// 从 cli.js 抽出的纯工具/低风险共享函数，让 commands/*.js 不再反向 import ../cli.js，
// 消除 ESM 循环依赖。这些函数：
//   - parseOptions：args → options 对象（纯函数，无 I/O）
//   - extractFlag：从 args 数组取 --flag <value>（纯函数）
//   - displayModel：agent → 模型展示字符串（纯函数，依赖 extractFlag）
//   - loadPrompt：options → prompt 文本（读文件，I/O 仅 node:fs/promises）
//
// cli.js 现在从这里 import 并 re-export（保持 test/cli.test.js 的
// `from "../src/cli.js"` 导入行不变）。

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// F5: 从 args 数组里取 --flag <value> 的 value，取不到返回 undefined。
export function extractFlag(args, flag) {
  if (!Array.isArray(args)) return undefined;
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

export function displayModel(agent) {
  if (typeof agent.model === "string") return agent.model;
  return agent.model?.id
    ?? agent.provider?.model
    ?? extractFlag(agent.args, "--model")
    ?? extractFlag(agent.args, "--default-model")
    ?? extractFlag(agent.prependArgs, "--model")
    ?? extractFlag(agent.prependArgs, "--default-model")
    ?? (["claude-code", "codex", "kimi-code"].includes(agent.backend) ? "(default)" : "-");
}

export function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

export async function loadPrompt(options) {
  if (options.promptFile) {
    return readFile(resolve(options.promptFile), "utf8");
  }
  if (options.prompt) {
    return options.prompt;
  }
  throw new Error("Provide --prompt or --prompt-file");
}
