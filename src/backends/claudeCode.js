import { resolve, dirname, join } from "node:path";
import { existsSync, mkdtempSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ProcessBackend } from "./processBackend.js";
import { ClaudeStreamParser } from "./parsers/claudeCode.js";
import { resolveProviderArgs } from "./claudeCodeProvider.js";
import { inheritedEnvNames } from "../envPolicy.js";

// claude-code-provider-wrapper.mjs 的绝对路径（本文件同目录的 ../../scripts/wrappers/）。
const WRAPPER_PATH = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "wrappers", "claude-code-provider-wrapper.mjs"));

// M12-14 worker 上下文隔离：provider auto-memory 让 supervised worker 在 WAO 检测
// workdir_escape 之前编辑了 worktree 之外的全局 memory 文件。对【每一个】claude 子
// 进程（native OAuth / provider wrapper / start / resume）强制关闭 auto-memory。
// 经 backend 自己的 runtimeEnv 注入——runtimeEnv 在每次 spawn 都跑，无需 RunManager
// 或 runtime-name 分支；buildChildEnv 合并序保证它压过同名 agent.env。
const DISABLE_AUTO_MEMORY_ENV = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";

// 2026-10-05（auditor_claude 席位设立批）：native OAuth 通道的纯净模式实现切换。
// CLI 官方语义（2.1.289 --help）：--bare 下 "OAuth and keychain are never read"
// ——OAuth 订阅凭据与 bare 纯净在架构上互斥（三连差分实测：bare+凭据文件在场仍
// 认证失败；凭据目录+无 bare 通过；空目录+无 bare 失败）。替代纯净法：把
// CLAUDE_CONFIG_DIR 指向仅含 .credentials.json 拷贝的隔离目录——hooks/settings/
// CLAUDE.md/插件/技能从空目录解析即全空（实测比 bare 更纯：bare 下用户插件仍
// 载入 3 个，隔离目录下仅剩 CLI 内置插件）。凭据文件为 spawn 时现拷贝（token
// 轮换后旧拷贝自然失效，不缓存）；目录在 os.tmpdir()（用户级），run 期间存活、
// 终态由 backend.dispose() 删除（TD-223，2026-10-07——此前"交由 OS 临时清理"
// 实测永不发生，%TEMP% 堆积上千个含凭据副本的目录；进程崩溃等残留由
// wao sweep-claude-config 清扫）；token 值永不进 argv/转录/env 展示（env 只带目录路径）。
const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";
const OAUTH_CREDENTIALS_RELATIVE = join(".claude", ".credentials.json");
// TD-223（2026-10-07）：目录内的 owner 标记文件——内容仅 {pid, createdAt}，供
// sweep（application/oauthDirSweep.js）判定"创建者进程还在不在"；不是凭据，不含
// 任何 secret。名字与 sweep 模块的 OWNER_MARKER_FILE 同一约定（值同步靠测试钉）。
const OAUTH_OWNER_MARKER_FILE = ".wao-owner.json";

function prepareClaudeOauthConfigDir(
  { credentialsSource = join(homedir(), OAUTH_CREDENTIALS_RELATIVE), onDirCreated } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "wao-claude-oauth-"));
  // TD-223 验收修（2026-10-07 sol 会审 Q1）：目录落地【立即】回调登记——标记写入或
  // 凭据拷贝中途抛错时目录已存在，晚于此刻的登记会漏回收（登记必须先于任何可能
  // 抛错的后续步骤）。
  if (typeof onDirCreated === "function") onDirCreated(dir);
  // TD-223：标记先于凭据拷贝写入——即使拷贝中途失败，目录也带 owner 标记，
  // sweep 不会把它误判成"无标记遗留目录"。
  writeFileSync(
    join(dir, OAUTH_OWNER_MARKER_FILE),
    JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    "utf8",
  );
  if (existsSync(credentialsSource)) {
    copyFileSync(credentialsSource, join(dir, ".credentials.json"));
  }
  // 凭据文件缺席 = 未登录：照常返回空目录，spawn 后由 CLI 如实报认证失败。
  return dir;
}

/**
 * Claude Code backend（M2-6）。
 * 薄封装：ProcessBackend + ClaudeStreamParser + 参数构造。
 *
 * 调用：claude -p "<prompt>" --output-format stream-json --verbose
 *
 * P4 融合项 #3（决策B）：优先用 agent.provider 一等字段推导参数（wrapper prependArgs +
 * claude CLI flags），单一真相源防漂移（opus-4.8 bug 温床）。无 provider 时向后兼容，
 * 走旧 agent.binary/prependArgs/args（手拼形态）。
 *
 * agent.args：仅作真正 ad-hoc 的 CLI flag 透传（如 ["--dangerously-skip-permissions"]）。
 *
 * M11-5 角色合同（TD-89 修复）：role contract 由 RunManager 经共享加载器
 * （roleContract.js）验证后，以 task.roleContract（已验证的字符串内容）传入。
 * 这里用 `--append-system-prompt <content>` 恰好一次注入——直接传内容，不传
 * 文件路径，消除 TOCTOU 竞态（加载验证 ROLE_A 后文件被替换为 ROLE_B 的窗口）。
 */
export class ClaudeCodeBackend extends ProcessBackend {
  // M11-5 Package A2: explicit role-contract capability declaration.
  // RunManager reads this boolean to decide whether a configured
  // agent.systemPrompt may be injected — it must NOT branch on the runtime
  // name. claude-code injects via --append-system-prompt (content, once).
  supportsRoleContract = true;

  // M11-11C: explicit provider-session-reuse capability declaration.
  // RunManager reads this boolean to gate sessionReuse routing provider-
  // neutrally (no runtime-name branch). claude-code expresses reuse natively:
  // first turn `--session-id <uuid>`, later turn `--resume <same uuid>`. The
  // opaque uuid is the only identifier handed to the provider; it derives from
  // (Lead session + bound workspace + agentId) deterministically, so the raw
  // Lead id / workspace / agentId never reach the provider.
  supportsSessionReuse = true;

  // TD188（2026-09-27）：覆写基类的取回 id 可用性判定为恒 true。claude-code 的
  // 续接 lane 编译的是路由信封里的 opaqueUuid（--resume <uuid>），从不消费
  // 转录取回的 session id——转录里记录的 proc_<pid> spawn 身份因此不是本
  // backend 的续接阻断（真实形状如此：ClaudeStreamParser 不广告 native id，
  // session.created 就是 proc 身份）。若按全局 proc 前缀规则拒绝，会误伤这条
  // 合法 opaque 续接路径（m11-11c CHAIN-2 钉的就是它）。
  canResumeWithRecoveredSessionId(_sessionId) {
    return true;
  }

  // M12-16: explicit in-flight-correction capability declaration. claude-code
  // drives ONE stream-json process whose prompt is fed over stdin
  // (`-p --input-format stream-json`), so a follow-up user turn can be queued to
  // the SAME live process. RunManager + dispatchRun read this boolean to gate
  // correctable runs provider-neutrally (no runtime-name branch). "delivered"
  // proves the bytes were accepted by the runtime stdin — NOT that the model
  // executed the turn.
  supportsInFlightCorrection = true;

  // ADR-0025 批次 2（TD-87）：claude stream-json 的 result 帧携带 usage
  // （ClaudeStreamParser 产出 metrics token 事实）——tokenBudget 闸门对该
  // backend 有效。registry validate 静态读取本声明做 tokenBudget 交叉校验。
  reportsTokenUsage = true;

  // ADR-0032 §8 批次（2026-09-21）：命令退出码证据可产出——claude stream-json 的
  // command 事件本身不带数值退出码（parser 投影 commandEvent(command, undefined)），
  // 但 tool_result 以 toolCallId 为关联键（parser toolResultEvent(toolCallId, ...)），
  // scorecard 的 withInferredCommandExitCode 据此可靠推断 0/1（reliability 记录
  // coder_hq commandEvidence 绿即此通道）。语义 = "WAO 今天能否产出命令退出码
  // 证据"——含该可靠推断通道，非仅 wire 原生数值。
  reportsCommandExitCode = true;

  /**
   * M11-9 capability: declare exactly what this backend can express.
   *
   * Provider path (wrapper): model, reasoning, contextWindow, provider — all
   * translated by resolveProviderArgs.
   * Native OAuth path (no provider): model, reasoning — translated by buildArgs
   * directly. contextWindow and provider cannot be expressed natively (no
   * wrapper to set --context-window; provider without wrapper is meaningless).
   */
  validateAgentPolicy(agent) {
    const hasProvider = !!agent?.provider;
    // Provider path: can express everything.
    if (hasProvider) return; // model/reasoning/contextWindow/provider all OK.
    // Native path: model + reasoning OK; contextWindow/provider NOT expressible.
    if (agent?.model?.contextWindow) {
      throw new Error("claude-code native path (no provider) cannot express model.contextWindow — requires a provider wrapper");
    }
    // model.id and reasoning.effort are fine on native path.
  }

  constructor(opts = {}) {
    super({
      parserClass: ClaudeStreamParser,
      // M12-16: claude stream-json user-message wire format. ONE whole line per
      // turn, fed to the child stdin. Used for BOTH the initial prompt and
      // every queued correction on a correctable run (the SAME live process).
      encodeUserMessage: (text) => JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: text }] },
      }),
      buildArgs: (agent, task) => {
        const args = [];
        // M12-16: a correctable run feeds its prompt (and later corrections) to
        // the SAME process over stdin as stream-json user messages, so it uses
        // `-p` (print mode, boolean) + `--input-format stream-json` and NO
        // positional prompt. A normal run keeps the byte-compatible `-p <prompt>`
        // positional form.
        if (task.correctable) {
          args.push("-p", "--input-format", "stream-json");
        } else {
          args.push("-p", task.prompt);
        }
        args.push(
          "--output-format", "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--exclude-dynamic-system-prompt-sections",
        );
        // M11-11C: provider-native conversation reuse. First turn starts a named
        // session (--session-id); later turns resume it (--resume). Exactly one
        // flag, never both. The opaque uuid is supplied by the control plane
        // (derived from the reuse identity) — never the raw Lead/workspace id.
        if (task.sessionReuse && task.sessionReuse.turn === "first") {
          args.push("--session-id", task.sessionReuse.opaqueUuid);
        } else if (task.sessionReuse && task.sessionReuse.turn === "resume") {
          args.push("--resume", task.sessionReuse.opaqueUuid);
        } else {
          args.push("--no-session-persistence");
        }
        // M11-5：角色合同注入（config/roles/*.md，loader 已验证内容）。
        // --append-system-prompt <content> 恰好一次；用内容而非路径，消除 TOCTOU。
        if (task.roleContract) {
          args.push("--append-system-prompt", task.roleContract);
        }
        // 2026-09-19 Owner 裁定：所有 claude-code worker 会话强制纯净模式——
        // --bare 跳过全局配置面（hooks/LSP/插件同步/自动记忆/后台预取/钥匙串/
        // CLAUDE.md 自动发现），--strict-mcp-config 跳过一切配置来源的 MCP。
        // 全局技能/插件/全局 CLAUDE.md 是 worker 的纯 token 税与工具选择干扰
        // （skillUsage 实证：worker 期零使用）；角色合同经上方显式注入不受影响。
        // M11-9: provider 判定先于纯净旗标（2026-10-05 起 bare 按通道条件化）。
        const providerArgs = resolveProviderArgs(agent, WRAPPER_PATH);
        if (providerArgs) {
          // provider wrapper 通道：凭据经 wrapper env 注入，bare 字节不变
          //（2026-09-19 Owner 裁定的原形态）。
          args.push("--bare", "--strict-mcp-config");
          args.push(...providerArgs.cliFlags);
        } else {
          // native OAuth 通道：bare 与 OAuth 互斥（见 prepareClaudeOauthConfigDir 注释）
          // ——纯净改由 CLAUDE_CONFIG_DIR 隔离目录承载（spawn 覆写预备、runtimeEnv 注入）；
          // strict-mcp-config 仍保留（MCP 面与配置目录正交，双保险）。
          args.push("--strict-mcp-config");
          // No provider: translate model/reasoning directly to CLI flags.
          if (agent.model?.id) args.push("--model", agent.model.id);
          if (agent.reasoning?.effort) args.push("--effort", agent.reasoning.effort);
        }
        // ad-hoc CLI flag 透传（如 --dangerously-skip-permissions）
        args.push(...(Array.isArray(agent.args) ? agent.args : []));
        return args;
      },
      // M11-7: delegate to the runtime-neutral env-policy SSOT (no mirrored
      // algorithm). inheritedEnvNames returns the declared credential name(s)
      // for claude-code (provider.apiKeyEnv / legacy --api-key-env).
      credentialEnvNames: (agent) => inheritedEnvNames(agent),
      runtimeEnv: (_agent, task) => ({
        CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
        // M12-14: auto-memory 必须对每个 supervised claude 子进程关闭（见顶部常量注释）。
        [DISABLE_AUTO_MEMORY_ENV]: "1",
        ...(task.deliveryMode ? { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1" } : {}),
        // 2026-10-05：native OAuth 通道的隔离配置目录（spawn 覆写预备在 task 上；
        // 只带目录路径，凭据值永不进 env 展示面之外的任何位置）。
        ...(task.claudeOauthConfigDir ? { [CLAUDE_CONFIG_DIR_ENV]: task.claudeOauthConfigDir } : {}),
      }),
      ...opts,
    });
    // TD-223（2026-10-07）：本实例创建的 native OAuth 隔离目录登记表 + 可注入的
    // 凭据源路径（默认 ~/.claude/.credentials.json；测试注入 fixture 路径——
    // 测试绝不复制真实凭据）。session 复用/多 turn 会多次 spawn 累积多个目录，
    // 全记，终态 dispose() 一次清空。
    this._oauthCredentialsSource = opts.oauthCredentialsSource ?? null;
    this._oauthConfigDirs = [];
  }

  /**
   * M12-14：backend 安全 env 必须扛住 agent.env 的反设企图。
   *
   * buildChildEnv 让 runtimeEnv（waoEnv 段）压过【同名】agent.env，但 Windows
   * env 大小写不敏感：agent.env 里的小写/混合大小写变体会与权威值并存进子进程
   * env block，解析结果不确定。spawn 前把 agent.env 中该名字的任意大小写变体
   * 剥离，让 runtimeEnv 成为唯一权威来源（同 KimiCodeBackend.spawn 的
   * backend-owned env 模式）。不改变凭据优先级，不读取、不暴露任何 env 值。
   */
  async spawn(agent, task) {
    const agentEnv = agent?.env ?? {};
    const stripped = {};
    let removed = false;
    for (const [name, value] of Object.entries(agentEnv)) {
      // CLAUDE_CONFIG_DIR 与 auto-memory 同款权威化：runtimeEnv 是唯一来源
      //（2026-10-05 native OAuth 通道由 backend 预备隔离目录，agent.env 反设剥离）。
      if (name.toUpperCase() === DISABLE_AUTO_MEMORY_ENV || name.toUpperCase() === CLAUDE_CONFIG_DIR_ENV) {
        removed = true;
        continue;
      }
      stripped[name] = value;
    }
    // native OAuth 通道：预备仅含凭据拷贝的隔离配置目录（见 prepareClaudeOauthConfigDir）。
    // task 上挂字段穿线到 runtimeEnv（buildArgs 的旗标决策纯由 agent.provider 派生，
    // 与本字段无耦合——preflight/spawn 两次 buildArgs 调用天然一致）。
    // TD-223：目录创建即登记（super.spawn 在其后才跑——ENOENT 等失败时目录已落盘，
    // 靠登记表让 dispose 在 spawn 失败路径也能回收）。
    const taskExtras = {};
    if (!agent?.provider && task && typeof task === "object") {
      taskExtras.claudeOauthConfigDir = this._prepareAndTrackOauthConfigDir();
    }
    const enrichedTask = task && typeof task === "object" ? { ...task, ...taskExtras } : task;
    return super.spawn(removed ? { ...agent, env: stripped } : agent, enrichedTask);
  }

  /**
   * TD-223（2026-10-07）：创建 native OAuth 隔离目录并登记进实例表。
   * 凭据源可注入（构造参数 oauthCredentialsSource；默认真实 ~/.claude 路径）。
   */
  _prepareAndTrackOauthConfigDir() {
    // TD-223 验收修：登记经 onDirCreated 在 mkdtemp 后立即发生（早于标记写入/
    // 凭据拷贝等任何可能抛错的步骤），杜绝"目录已建但未登记"的回收漏洞。
    return prepareClaudeOauthConfigDir({
      credentialsSource: this._oauthCredentialsSource ?? undefined,
      onDirCreated: (dir) => this._oauthConfigDirs.push(dir),
    });
  }

  /**
   * TD-223（2026-10-07）：删除本实例创建的全部 OAuth 隔离目录（含凭据副本）。
   * 生命周期：RunManager 把它组合进 run 终态 cleanupFn（start/resume 两站点），
   * spawn 失败/终态路径都会触发。设计注：dispose 只在 run 终态触发；同 run 中间
   * turn 的目录活到终态一起删——run 进行中目录必须存活（子进程正在读），这是
   * 可接受的泄漏窗口（run 崩溃不终态的残留由 wao sweep-claude-config 清扫）。
   * 幂等：重复调用无害（表已清空即 no-op）；单目录删除失败继续其余，永不抛出。
   */
  async dispose() {
    const dirs = this._oauthConfigDirs;
    this._oauthConfigDirs = [];
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 单目录失败继续其余（TD-223）：一个目录卡死不得阻塞整批清理。
      }
    }
  }

  // P4 决策B：有 provider 时，binary=node + prependArgs 从 provider 推导（wrapper 调起）。
  // 无 provider 时走默认（resolveBinary → claude on PATH，旧形态用 agent.binary/prependArgs）。
  async resolveBinary(agent) {
    const providerArgs = resolveProviderArgs(agent, WRAPPER_PATH);
    if (providerArgs) {
      return { binary: process.execPath, prependArgs: providerArgs.prependArgs };
    }
    return super.resolveBinary(agent);
  }

  defaultBinary() {
    return "claude";
  }
}
