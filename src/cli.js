#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
// M12-8F: trusted installation-root resolver. Only the global `wao` bin opts in
// (via WAO_INSTALL_ROOT); the legacy `npm run cli` path keeps cwd resolution.
import { readInstallRoot, resolveConfigPath, rebaseConfigPaths } from "./installRoot.js";
import {
  connectDaemon,
  readHandshake as readDaemonHandshake,
  isDaemonAlive,
  HANDSHAKE_FILE as DAEMON_HANDSHAKE_FILE,
  DEFAULT_PIPE,
  DEFAULT_LIVENESS_THRESHOLD_MS,
} from "./daemon.js";
import { checkNodeVersion } from "./nodeVersionGuard.js";
import { readSupervisorState } from "./daemonSupervisor.js";
// TD-98 阶段 1：daemon/registry 命令族拆到 src/commands/（行为不变，纯搬迁）。
import { daemonCommand } from "./commands/daemon.js";
import { registryCommand } from "./commands/registry.js";
// TD-98 阶段 2b：runs 命令族拆到 src/commands/runs.js（行为不变，纯搬迁）。
import { runsCommand, buildDashboard, runsDashboardCommand, runDashboardWeb } from "./commands/runs.js";
// M12-8F: top-level `dashboard` 命令族（人类 Owner 启动器，wao dashboard）。
import { dashboardCommand } from "./commands/dashboard.js";
// TD-98 阶段 2c：workflow + worktree 命令族拆到 src/commands/（行为不变，纯搬迁）。
import { workflowCommand } from "./commands/workflow.js";
import { worktreeCommand } from "./commands/worktree.js";
// TD-98 阶段 2d：wao + doctor 命令族拆到 src/commands/（行为不变，纯搬迁）。
// wao.js 的 waoCommand 接受 deps.askHandler（= cli.js 的 waoAskCommand）。
// waoAskCommand 留 cli.js，调用 commands/run.js 导出的 runCommand（下方 import）。
// DI 的目的：让 wao.js 不反向 import cli.js，保持依赖方向 cli.js -> wao.js。
import { waoCommand as waoCommandCore, resolveArtifactPath } from "./commands/wao.js";
// TD-98 阶段 2e-1a：只读 observe 命令族（status/tail/collect）拆到 src/commands/observe.js。
import { statusCommand, tailCommand, collectCommand } from "./commands/observe.js";
// TD-98 阶段 2e-1b：stop 命令拆到 src/commands/stop.js（杀进程 + verification + alert，非只读）。
import { stopCommand } from "./commands/stop.js";
// TD-98 阶段 2e-2：retry/resume 命令拆到 src/commands/lifecycle.js。
import { retryCommand, resumeCommand } from "./commands/lifecycle.js";
// TD-98 阶段 2e-3：run/spawn 命令族（runCommand/spawnCommand/runAndWait + scorecard helper
// + spawnBackgroundRunner）拆到 src/commands/run.js。waoAskCommand 仍留 cli.js，调 run.js 的 runCommand。
import { spawnCommand, runCommand, runAndWait } from "./commands/run.js";
// M10 P0-1: mcp bind/status/unbind 命令族（项目级 workspace activation）。
import { mcpCommand } from "./commands/mcp.js";
// M11-2B: playbook list/show 命令族（Lead Playbook Catalog 只读 CLI 适配）。
// 纯 CLI 适配：argv/format/console，数据逻辑委托 ../application/playbookCatalog.js。
import { playbookCommand } from "./commands/playbook.js";
// P4-乙 Phase 1a：help 文本抽到 src/cliHelp.js（命名导出 HELP_TEXT，字节不变）。
// cli.js 底部自执行 main()，生成器（scripts/gen-surface.mjs）不能 import 本文件——
// 它改 import 无副作用的 cliHelp.js，CLI 打印的仍是同一份 SSOT。
import { HELP_TEXT } from "./cliHelp.js";
// TD-98 阶段 2a/2b/2c/2e：parseOptions/loadPrompt/displayModel/resolveTargetCwd
// 抽到 commands/shared.js，消除 commands/*.js 对 cli.js 的反向依赖。
// cli.js re-export 以保持 test/cli.test.js 的 `from "../src/cli.js"` 导入行不变。
// M9-0: extractFlag removed (dead import); displayModel SSOT is in application/registryInventory.js.
import { parseOptions, loadPrompt, displayModel, resolveTargetCwd } from "./commands/shared.js";
// Re-export：保持外部 import 路径（test/cli.test.js）不变。
export { parseOptions, loadPrompt, displayModel, resolveTargetCwd };
// buildDashboard / runsDashboardCommand 从 runs.js re-export（test/cli.test.js 依赖）。
// M12-8D: runDashboardWeb（runs dashboard --web）同源 re-export。
export { buildDashboard, runsDashboardCommand, runDashboardWeb };
// resolveArtifactPath 从 wao.js re-export（原 cli.js export，保持符号可见）。
export { resolveArtifactPath };
// statusCommand / collectCommand 从 observe.js re-export（test/cli.test.js 依赖）。
export { statusCommand, collectCommand };
// runCommand / runAndWait 从 run.js re-export（test/cli.test.js 依赖）。
export { runCommand, runAndWait };

const hardcodedDefaults = {
  registry: "config/agents.json",
  runDir: "runs",
  pollInterval: 5000,
  waitTimeout: null,
  timeout: 30000,
  retries: 2,
  defaultIsolation: "none",
  worktreeDir: null,
  portRange: [30000, 31000],
  stateDir: ".wao",
};

async function loadConfig() {
  // M12-8F: when the global `wao` bin opts in via WAO_INSTALL_ROOT, config/
  // default.json and the WAO-owned relative state paths (runDir/registry) anchor
  // at the trusted install root — never the caller cwd. Legacy `npm run cli`
  // (no env) keeps process.cwd() resolution byte-for-byte (installRoot === null).
  const installRoot = readInstallRoot();
  const configPath = resolveConfigPath("config/default.json", installRoot);
  if (!existsSync(configPath)) return rebaseConfigPaths({ ...hardcodedDefaults }, installRoot);
  try {
    const raw = await readFile(configPath, "utf8");
    return rebaseConfigPaths({ ...hardcodedDefaults, ...JSON.parse(raw) }, installRoot);
  } catch {
    return rebaseConfigPaths({ ...hardcodedDefaults }, installRoot);
  }
}

let configCache = null;
async function getConfig() {
  if (!configCache) configCache = await loadConfig();
  return configCache;
}

// _doctorParseSmoke / isProviderWrappedClaudeCodeWorker / hasClaudeOauthCredentials /
// whichCli 已移至 src/commands/doctor.js（TD-98 阶段 2d，随 doctor 族搬迁）。

/**
 * waoCommand 派遣器包装：注入 askHandler（= waoAskCommand）。
 * waoAskCommand 留 cli.js，调用 commands/run.js 导出的 runCommand。
 * wao.js 的 waoCommandCore 不 import ../cli.js，ask 子命令靠这里注入，保持依赖方向。
 */
async function waoCommand(args, config) {
  await waoCommandCore(args, config, { askHandler: waoAskCommand });
}

// TD-98 阶段 2c：newRunManager / resolveIsolateFlag / backendFor 已移至 commands/shared.js。
// cli.js 不再直接用 newRunManager/resolveIsolateFlag（run/spawn 已迁出）；
// commands/run.js、workflow.js 等从 shared.js import 使用。

// TD-98 阶段 1：daemon 命令族已拆到 src/commands/daemon.js（行为不变）。

async function main(argv) {
  // TD-40：启动校验 Node 版本——守住 v22 的内置 Windows Job Object 进程隔离。
  // help 例外（用户始终能查帮助），其余命令在 v24/v23/过低版本上拒绝并指引 v22。
  // WAO_SKIP_VERSION_GUARD=1 绕过（仅测试用：测试在任意 Node 上跑，不依赖真实进程隔离）。
  const [firstArg] = argv;
  const isHelp = !firstArg || firstArg === "help" || firstArg === "--help" || firstArg === "-h";
  if (!isHelp && process.env.WAO_SKIP_VERSION_GUARD !== "1") {
    const guard = checkNodeVersion(process.version);
    if (!guard.ok) {
      console.error(`WAO 拒绝启动：${guard.reason}`);
      console.error("（进程隔离依赖 Node v22 的内置 Job Object；详见 docs/02-architecture.md §4.3 + ADR 0013）");
      process.exitCode = 1;
      return;
    }
  }
  const config = await getConfig();
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "registry") {
    await registryCommand(rest, config);
    return;
  }
  if (command === "spawn") {
    await spawnCommand(rest, config);
    return;
  }
  if (command === "retry") {
    await retryCommand(rest, config);
    return;
  }
  if (command === "resume") {
    await resumeCommand(rest, config);
    return;
  }
  if (command === "run") {
    await runCommand(rest, config);
    return;
  }
  if (command === "status") {
    await statusCommand(rest, config);
    return;
  }
  if (command === "tail") {
    await tailCommand(rest, config);
    return;
  }
  if (command === "collect") {
    await collectCommand(rest, config);
    return;
  }
  if (command === "stop") {
    await stopCommand(rest, config);
    return;
  }
  if (command === "runs") {
    await runsCommand(rest, config);
    return;
  }
  if (command === "dashboard") {
    await dashboardCommand(rest, config);
    return;
  }
  if (command === "workflow") {
    await workflowCommand(rest, config);
    return;
  }
  if (command === "worktree") {
    await worktreeCommand(rest, config);
    return;
  }
  if (command === "wao") {
    await waoCommand(rest, config);
    return;
  }
  if (command === "daemon") {
    await daemonCommand(rest, config);
    return;
  }
  if (command === "mcp") {
    await mcpCommand(rest, config);
    return;
  }
  if (command === "playbook") {
    await playbookCommand(rest, config);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

// TD-98 阶段 1：registry 命令族已拆到 src/commands/registry.js（行为不变）。

// TD-98 阶段 2e-2：retry/resume 命令已移至 src/commands/lifecycle.js（上方 import）。


// TD-98 阶段 1：registryCheck/Validate 已拆到 src/commands/registry.js（行为不变）。

// TD-98 阶段 2e-3：run/spawn 命令族（spawnCommand/spawnBackgroundRunner/
// loadScorecardFromTranscript/runCommand）已移至 src/commands/run.js（上方 import + re-export）。


// TD-98 阶段 2e-1a：只读 observe 命令族（statusCommand/tailCommand/collectCommand +
// describeActivity/summarizeToolInput/truncate/reconstructProcessEvent）已移至
// src/commands/observe.js（上方 import + re-export statusCommand/collectCommand）。
// stop/retry/resume/run/spawn 也已分别拆到 stop.js/lifecycle.js/run.js（TD-98 全部完成）。


// TD-98 阶段 2a：extractFlag/displayModel 已移至 commands/shared.js（上方 import）。

// TD-98 阶段 2e-1b：stop 命令（stopCommand + killProcessTree）已移至 src/commands/stop.js
//（上方 import）。stop 非只读——杀进程 + stop verification + alert，单独成族。


// TD-98 阶段 2b：runs 命令族（runsCommand + buildDashboard + runsDashboardCommand +
// list/summary/prune/grep/metrics/scorecard/diagnose + loadRunFiles + parseDuration）
// 已移至 src/commands/runs.js（上方 import + re-export）。


// TD-98 阶段 2c：workflow 命令族（workflowCommand + workflowListCommand）已移至
// src/commands/workflow.js（上方 import）。workflowRunCommand + parseTemplateVars 也在那里。


// TD-98 阶段 2d：wao 命令族（waoCommand 派遣器 + waoDoctorCommand + waoInit/Handoff/Decision/
// Declare/Stage/State 子命令 + doctor 专用 helper）已移至 src/commands/wao.js + doctor.js。
// 仅 waoAskCommand 留 cli.js——它调用 commands/run.js 导出的 runCommand（上方 import）。


/**
 * wao ask：快捷派工（TD-88 派工摩擦反转）。
 * 降低单次派工的命令构造成本——Lead 不用每次拼 run <agentId> --prompt "..." + 手写边界声明。
 *
 * 用法：
 *   wao ask researcher "读 src/foo.js 给摘要"              # 默认只读边界（注入禁写/禁装声明）
 *   wao ask coder_hq "修 src/foo.js 的 bug" --mode write   # 写模式（不注入只读边界）
 *   wao ask researcher "..." --cwd D:/projects/xxx          # 跨项目（走 resolveTargetCwd）
 *
 * 内部：构造带边界模板的 prompt，调 runCommand（复用，不重写 run 逻辑）。
 */
async function waoAskCommand(args, config) {
  const [agentId, ...rest] = args;
  if (!agentId) {
    throw new Error('wao ask requires <agentId> "<一句话任务>". 例：wao ask researcher "读 src/foo.js 给摘要"');
  }
  // 提取一句话任务（第一个非 -- 的位置参数，agentId 之后的）
  const task = rest.find((a) => !a.startsWith("--"));
  if (!task) {
    throw new Error(`wao ask requires 一句话任务. 例：wao ask ${agentId} "读 src/foo.js 给摘要"`);
  }
  const options = parseOptions(rest);
  const mode = options.mode ?? "readonly";

  // 只读模式：注入边界声明（来自 SKILL.md 安全铁律 + 派工边界要求）
  // 写模式（--mode write）：不注入，让 worker 能改文件
  let prompt = task;
  if (mode === "readonly") {
    prompt = [
      task,
      "",
      "—— 只读边界（wao ask 自动注入）——",
      "本任务只读：不得修改任何文件，不得安装依赖（pip install/npm install 等），不得改变环境。",
      "如有需要，结果直接在回复里给出，不要写文件。",
    ].join("\n");
  }

  // 构造 run 命令的参数，调 commands/run.js 导出的 runCommand（上方 import）
  const runArgs = [agentId];
  runArgs.push("--prompt", prompt);
  // 透传 Lead 给的 --cwd / --registry / --format 等（resolveTargetCwd 在 runCommand 内生效）
  for (const opt of ["cwd", "registry", "format", "run-dir"]) {
    const flag = `--${opt}`;
    if (rest.includes(flag)) {
      const idx = rest.indexOf(flag);
      runArgs.push(flag, rest[idx + 1]);
    }
  }
  await runCommand(runArgs, config);
}

// waoStateCommand 已移至 src/commands/wao.js（TD-98 阶段 2d，随 wao 族搬迁）。

// workflowRunCommand 已移至 src/commands/workflow.js（TD-98 阶段 2c，随 workflow 族搬迁）。


// parseDuration 已移至 src/commands/runs.js（runs prune 专用 helper，随 runs 族搬迁）。

// loadRun 已移至 commands/shared.js（TD-98 阶段 2e-1a：status/tail/collect 迁出后，
// stop/retry 仍暂留 cli.js 继续共用 loadRun；上方 import）。

// backendFor 已移至 commands/shared.js（TD-98 阶段 2c：newRunManager 的后端选择器，随
// newRunManager 一起搬走；cli.js 不再直接调用，但 OpenCodeServeBackend 仍被 stop/spawn 用）。

// parseAgentList / loadScorecardRules / parseScorecardRules / runAndWait 已移至
// src/commands/run.js（TD-98 阶段 2e-3，随 run/spawn 族搬迁；上方 import + re-export runAndWait）。


// parseTemplateVars + worktreeCommand 已移至 src/commands/（TD-98 阶段 2c：
// parseTemplateVars 是 workflow run 专用 helper，worktreeCommand 是 worktree 族，
// 分别搬到 commands/workflow.js 和 commands/worktree.js，上方 import）。


function printHelp() {
  console.log(HELP_TEXT);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
