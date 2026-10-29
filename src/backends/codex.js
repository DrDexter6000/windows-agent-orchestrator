import { existsSync } from "node:fs";
import { spawnSync, execSync } from "node:child_process";
import { join } from "node:path";
import { ProcessBackend, isProcessPlaceholderSessionId } from "./processBackend.js";
import { CodexStreamParser } from "./parsers/codex.js";
import { inheritedEnvNames } from "../envPolicy.js";

// 决定 0086：codex 车道每次调用显式启用的 OS 写沙箱参数。首轮 `exec` 与 resume 轮
// `exec resume` 通用——resume 不接受 -s，一律 -c；这三项在命令行上压过用户
// ~/.codex/config.toml 的交互配置（该配置可以是完全放开、无沙箱的形态），不随
// 机器漂移。可写面 = 运行的工作目录 + 系统临时目录；本文件任何路径都不得出现
// 完全放开的沙箱模式字样（源级钉：test/backends/codexSandbox.test.js）。
export const CODEX_WRITE_SANDBOX_ARGS = Object.freeze([
  "-c", 'sandbox_mode="workspace-write"',
  "-c", "sandbox_workspace_write.network_access=true",
  "-c", 'approval_policy="never"',
]);

// sandboxEnforcement 探测的单次 codex sandbox 调用预算（毫秒）。固定写命令理应
// 秒级完成；给到分钟级只为容忍冷启动。
const SANDBOX_PROBE_TIMEOUT_MS = 120_000;

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

  // 决定 0086：本后端在每次调用时显式强制 OS 写沙箱（CODEX_WRITE_SANDBOX_ARGS，
  // workspace-write）。只读运行、会审席位与写运行同样使用 workspace-write——
  // 沙箱的根是运行的工作目录（ephemeral 树 / 源检出），树内写入由事后判定处理。
  // reliability 的 sandboxEnforcement 检查消费本声明（probeWriteSandbox）。
  enforcesWriteSandbox = true;

  // 提示词走标准输入（`codex exec` 与 `exec resume` 的提示位写 `-`），不占 Windows
  // 命令行预算；角色合同仍在命令行上（-c developer_instructions）。
  promptViaStdin = true;

  /**
   * M11-9 capability: Codex can express model (--model) and reasoning
   * (-c model_reasoning_effort). It cannot express contextWindow (no CLI flag)
   * or provider (Codex uses its own auth, not an anthropic-compatible wrapper).
   */
  validateAgentPolicy(agent) {
    // 仓库纪律（kimi-web/zcode 同款）：配了表达不了的 model 子字段必须硬拒，不静默
    // 丢弃——model.providerID 会进车道身份四元组（identityProjection），静默接受会
    // 让认证台账记下运行时根本不存在的 provider 区分。
    if (agent?.model?.providerID !== undefined || agent?.model?.variant !== undefined) {
      throw new Error(
        "codex backend cannot express model.providerID/model.variant "
        + "(only model.id is handed to the runtime via `--model` — rejected instead of silently dropping routing fields)",
      );
    }
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
        // TD188（2026-09-27）：占位进程号（proc_<pid>）同样拒绝——它不是 codex
        // thread id（与 Kimi 同类代码路径；本轮 Codex 未真实复现，按同构防线
        // fail-closed）。proc_<pid> 是 ProcessBackend 的本地子进程身份。
        const args = [];
        if (task.sessionReuse?.turn === "resume") {
          const priorSessionId = task.priorProviderSessionId;
          if (typeof priorSessionId !== "string" || priorSessionId.length === 0
            || isProcessPlaceholderSessionId(priorSessionId)) {
            throw new Error(
              "codex sessionReuse resume turn requires the prior provider thread id "
              + "(a runtime-advertised native id — session.created.backendSessionId of the "
              + "prior run; a proc_<pid> process placeholder is not a codex thread id) "
              + "— refusing instead of silently starting a fresh codex conversation",
            );
          }
          args.push("exec", "resume", priorSessionId, "--json", "--skip-git-repo-check");
        } else {
          args.push("exec", "--json", "--skip-git-repo-check");
        }
        // 决定 0086：OS 写沙箱参数固定插在基础 exec 参数之后、其余 -c 之前
        // （首轮与 resume 轮同一位置，都在 prompt 之前）。不加 --cd：工作目录由
        // spawn 的 cwd 决定，preflight 与 spawn 的参数因此保持一致。
        args.push(...CODEX_WRITE_SANDBOX_ARGS);
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
        // 提示词经标准输入送达（promptViaStdin），这里只占位。
        args.push("-");
        return args;
      },
      // M11-7: delegate to the runtime-neutral env-policy SSOT.
      credentialEnvNames: (agent) => inheritedEnvNames(agent),
      ...opts,
    });
    // sandboxEnforcement 探测的 spawnSync 注入缝（测试注入假 spawn；生产走
    // node:child_process.spawnSync）。与 _spawnFn 同款纪律。
    this._sandboxProbeSpawnSync = opts.sandboxProbeSpawnSync ?? spawnSync;
  }

  async resolveBinary(agent) {
    // 优先直接找 codex.js（绕过 .cmd），退路走通用 resolveBinary
    const jsPath = findCodexJs();
    if (jsPath) {
      return { binary: process.execPath, prependArgs: [jsPath] };
    }
    return super.resolveBinary(agent);
  }

  /**
   * 决定 0086：OS 写沙箱的活体探测——不经模型，用 `codex sandbox -P :workspace
   * -C <cwd> -- <shell> -NoProfile -Command <自报告写命令>` 在与运行时同一套
   * Windows 沙箱里执行固定写命令。对 insidePath 与 outsidePath 各执行一次。
   * codex 入口走 resolveInvocationPrefix(agent)——与真实派发同一解析链，车道
   * 配置的 binary/prependArgs 不会与被认证的入口漂移。
   *
   * 写命令自己报告结果（PROBE_MARKERS），归成 outcome："written" / "denied"
   * （UnauthorizedAccessException，被访问控制拒绝）/ "error"（其他异常）/
   * "not_run"（没有任何报告——例如沙箱里的子进程起不来）。
   *
   * 返回（从不抛出）：
   *   { available: false, reason }                  —— 子命令不存在/参数被拒
   *     （退出码 2 且打印 Usage）、codex 不可解析、探测进程没跑起来；
   *   { available: true, inside: {exitCode, fileExists, outcome, output},
   *     outside: {exitCode, fileExists, outcome, output} } —— exitCode 为 null
   *     表示进程未正常退出（超时/被杀）。判定在纯内核
   *     scripts/reliability/sandboxEnforcement.mjs，不在此复述。
   */
  async probeWriteSandbox({ agent = {}, cwd, insidePath, outsidePath } = {}) {
    const unavailable = (reason) => ({ available: false, reason });
    if (process.platform !== "win32") {
      return unavailable("codex sandbox probe is Windows-only (the enforced OS write sandbox is a Windows facility)");
    }
    if (typeof cwd !== "string" || typeof insidePath !== "string" || typeof outsidePath !== "string") {
      return unavailable("probe requires { cwd, insidePath, outsidePath } as strings");
    }
    let prefix;
    try {
      prefix = await this.resolveInvocationPrefix(agent ?? {});
    } catch (error) {
      return unavailable(`codex binary not resolvable: ${error.message}`);
    }
    const shellPath = resolvePowerShellPath();
    if (!shellPath) {
      return unavailable("no PowerShell executable found for the sandbox probe");
    }

    // 单次探测：沙箱内跑固定写命令。Node spawn 不经 MSYS 路径改写，
    // `-P :workspace` / `-C <dir>` 原样到达 codex。
    const runOne = (targetPath) => {
      const sentinel = `WAO_SBX_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const r = this._sandboxProbeSpawnSync(
        prefix.binary,
        [...prefix.args, "sandbox", "-P", ":workspace", "-C", cwd, "--", shellPath, "-NoProfile", "-Command", probeWriteCommand(targetPath, sentinel)],
        { encoding: "utf8", windowsHide: true, timeout: SANDBOX_PROBE_TIMEOUT_MS },
      );
      const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
      if (r.error) return { spawnError: r.error.message, output };
      return { exitCode: r.status, output };
    };

    const observe = (run, targetPath) => ({
      exitCode: run.exitCode,
      fileExists: existsSync(targetPath),
      outcome: probeOutcome(run.output),
      output: trimProbeOutput(run.output),
    });

    const insideRun = runOne(insidePath);
    if (insideRun.spawnError) {
      return unavailable(`codex sandbox probe did not run (inside): ${insideRun.spawnError}`);
    }
    if (isUsageRejection(insideRun)) {
      return unavailable(`codex sandbox subcommand rejected the probe arguments (exit ${insideRun.exitCode}, usage printed): ${trimProbeOutput(insideRun.output)}`);
    }
    const inside = observe(insideRun, insidePath);

    const outsideRun = runOne(outsidePath);
    if (outsideRun.spawnError) {
      return unavailable(`codex sandbox probe did not run (outside): ${outsideRun.spawnError}`);
    }
    if (isUsageRejection(outsideRun)) {
      return unavailable(`codex sandbox subcommand rejected the probe arguments (exit ${outsideRun.exitCode}, usage printed): ${trimProbeOutput(outsideRun.output)}`);
    }
    const outside = observe(outsideRun, outsidePath);

    return { available: true, inside, outside };
  }
}

// 探测写命令的自报告标记。命令本身在沙箱里跑起来才会打印其中之一。
export const PROBE_MARKERS = Object.freeze({
  written: "WAO_SBX_WRITE_OK",
  denied: "WAO_SBX_WRITE_DENIED",
  error: "WAO_SBX_WRITE_ERROR",
});

// 标记在 PowerShell 运行时由两半拼出（'WAO_SBX_WRITE_' + 'DENIED'）：命令原文里
// 不出现完整的标记，沙箱启动失败时回显整条命令（cmd=…）也不会被当成命令自己的报告。
function markerExpr(marker) {
  const cut = marker.lastIndexOf("_") + 1;
  return `('${marker.slice(0, cut)}' + '${marker.slice(cut)}')`;
}

// 自报告写命令：写成打印 written 标记退出 0；被访问控制拒绝
// （UnauthorizedAccessException）打印 denied 标记退出 3；其他异常打印 error
// 标记与异常类型退出 4。路径与 sentinel 由探测自己生成，不含单引号。
export function probeWriteCommand(targetPath, sentinel) {
  return [
    `try { Set-Content -LiteralPath '${targetPath}' -Value '${sentinel}' -ErrorAction Stop; Write-Output ${markerExpr(PROBE_MARKERS.written)}; exit 0 }`,
    `catch [System.UnauthorizedAccessException] { Write-Output ${markerExpr(PROBE_MARKERS.denied)}; exit 3 }`,
    `catch { Write-Output (${markerExpr(PROBE_MARKERS.error)} + ' ' + $_.Exception.GetType().FullName); exit 4 }`,
  ].join(" ");
}

// 输出 → outcome。只认独占一行的标记（error 标记后可跟异常类型）；没有标记 = 命令
// 没在沙箱里跑起来（not_run）；出现不止一种标记是矛盾，同样按 not_run（判不定）。
export function probeOutcome(output) {
  const lines = String(output ?? "").split(/\r?\n/).map((line) => line.trim());
  const found = new Set();
  for (const line of lines) {
    if (line === PROBE_MARKERS.written) found.add("written");
    else if (line === PROBE_MARKERS.denied) found.add("denied");
    else if (line === PROBE_MARKERS.error || line.startsWith(`${PROBE_MARKERS.error} `)) found.add("error");
  }
  return found.size === 1 ? [...found][0] : "not_run";
}

// 子命令不存在/参数被拒的固定形状：退出码 2 且输出里带 Usage（codex-cli 对
// 未知子命令与坏 flag 的拒绝形态）。
function isUsageRejection(run) {
  return run.exitCode === 2 && /usage/i.test(run.output);
}

// 探测输出只进 check detail：压成单行、限长（含 "Access … denied" 这类证据句）。
function trimProbeOutput(text, maxChars = 300) {
  const flat = String(text).replace(/\r?\n/g, " | ").trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}

// 探测命令的 shell：先取 PowerShell 7 的安装路径（版本稳定），再取 PATH 上的
// pwsh 中不在 WindowsApps 应用别名目录里的那个（别名是按用户的执行别名，沙箱
// 用户未必能启动），最后回退系统自带 Windows PowerShell 的绝对路径。
function resolvePowerShellPath() {
  const installed = join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
  if (existsSync(installed)) return installed;
  try {
    const out = execSync("where pwsh", { encoding: "utf8", windowsHide: true });
    const real = out.split(/\r?\n/).filter(Boolean).find((p) => !/\\WindowsApps\\/i.test(p));
    if (real) return real;
  } catch {
    // pwsh 未安装——回退系统 PowerShell
  }
  const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(system) ? system : null;
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
