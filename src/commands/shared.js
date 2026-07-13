// TD-98 阶段 2a：共享 CLI 命令工具。
//
// 从 cli.js 抽出的纯工具/低风险共享函数，让 commands/*.js 不再反向 import ../cli.js，
// 消除 ESM 循环依赖。这些函数：
//   - parseOptions：args → options 对象（纯函数，无 I/O）
//   - displayModel：agent → 模型展示字符串（SSOT 在 application/registryInventory.js，此处 re-export）
//   - loadPrompt：options → prompt 文本（读文件，I/O 仅 node:fs/promises）
//
// cli.js 现在从这里 import 并 re-export（保持 test/cli.test.js 的
// `from "../src/cli.js"` 导入行不变）。

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import { readRegistry } from "../registry.js";
import { RunManager } from "../runManager.js";
import { OpenCodeServeBackend } from "../backends/opencodeServe.js";
import { ClaudeCodeBackend } from "../backends/claudeCode.js";
import { CodexBackend } from "../backends/codex.js";
import { KimiCodeBackend } from "../backends/kimiCode.js";
import { getWaoCliPath } from "../waoCliPath.js";
import { readTranscript, findLastEventSeq, JsonlTranscript } from "../transcript.js";
// M9-0: displayModel SSOT lives in application/registryInventory.js;
// this re-export preserves the existing shared.js/cli.js public contract.
import { displayModel } from "../application/registryInventory.js";

export { displayModel };

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

/**
 * 解析 wao 命令的目标项目 cwd（TD-84：跨项目 scope 修复）。
 *
 * 回退链（优先级高→低）：
 *   1. 显式 --cwd 参数（options.cwd）——调用方明确指定，最优先
 *   2. WAO_TARGET_CWD env——worker 子进程被注入的目标项目（processBackend.js 注入，
 *      值 = agent.cwd）。让 worker 调 wao 命令时自动写进干活的项目，不靠角色 prompt
 *      显式传 --cwd $WAO_TARGET_CWD（那个变成冗余安全网）。
 *   3. process.cwd()——Lead 裸跑 / 本地单项目场景的默认。
 *
 * 注意：Lead 进程没有 WAO_TARGET_CWD（只注入给 worker 子进程），所以 Lead 跨项目
 * 派工时调 wao stage/declare 仍需显式带 --cwd 指向目标项目（SKILL 纪律约束）。
 *
 * TD-98 阶段 2b：从 cli.js 移到 shared.js（纯函数，多 family 共用：runs/wao/spawn）。
 */
export function resolveTargetCwd(options) {
  if (options.cwd) return resolve(options.cwd);
  if (process.env.WAO_TARGET_CWD) return resolve(process.env.WAO_TARGET_CWD);
  return resolve(process.cwd());
}

/**
 * 解析 --isolate / --no-isolate flag → true | false | undefined(不覆盖配置)。
 *
 * TD-98 阶段 2c：从 cli.js 移到 shared.js（纯函数，spawn/run/workflow 多 family 共用）。
 */
export function resolveIsolateFlag(options) {
  if (options.isolate === true) return true;
  if (options.noIsolate === true) return false;
  return undefined;
}

/**
 * 按 agent.backend 选对应后端实例。
 *
 * WAO CLI 路径（注入 worker env，让 worker 能调 wao 命令记录状态）
 * TD-90: Windows 上指向 scripts/wao-cli.cmd（v22 shim），避免 worker shell 默认 v24 触发 guard。
 *
 * TD-98 阶段 2c：从 cli.js 移到 shared.js（cli.js + workflow.js 共用）。
 */
export function backendFor(agent) {
  const waoCliPath = getWaoCliPath();
  if (agent.backend === "opencode-serve") {
    return new OpenCodeServeBackend();
  }
  if (agent.backend === "claude-code") {
    return new ClaudeCodeBackend({ waoCliPath });
  }
  if (agent.backend === "codex") {
    return new CodexBackend({ waoCliPath });
  }
  if (agent.backend === "kimi-code") {
    return new KimiCodeBackend({ waoCliPath });
  }
  throw new Error(`Unsupported backend: ${agent.backend}`);
}

/**
 * 构造 RunManager（生产路径：模块默认 readRegistry + backendFor）。
 * 测试钩子：允许 config 注入 mock readRegistry / backendFor。
 *
 * TD-98 阶段 2c：从 cli.js 移到 shared.js（cli.js + workflow.js 共用）。
 */
export function newRunManager(config) {
  return new RunManager({
    config,
    readRegistry: config.readRegistry ?? readRegistry,
    transcriptDir: config.runDir,
    backendFor: config.backendFor ?? backendFor,
  });
}

/**
 * 读 run transcript + 构造可追加的 JsonlTranscript 句柄。
 * 跨族共用：status/tail/collect/stop/retry 都靠它定位 run 的 transcript。
 * 只读 I/O（readTranscript）+ 纯构造（new JsonlTranscript），符合 shared 标准。
 *
 * TD-98 阶段 2e-1a：从 cli.js 移到 shared.js（status/tail/collect 迁出后，
 * stop/retry 仍暂留 cli.js，需继续共用 loadRun）。
 */
export async function loadRun(runId, options, config) {
  if (!runId) {
    throw new Error("runId is required");
  }
  const runDir = resolve(options.runDir ?? config.runDir);
  const filePath = join(runDir, `${runId}.jsonl`);
  const events = await readTranscript(filePath);
  const transcript = new JsonlTranscript(filePath, {
    runId,
    agentId: events[0]?.agentId ?? "unknown",
    initialSeq: findLastEventSeq(events),
  });
  return { transcript, events };
}
