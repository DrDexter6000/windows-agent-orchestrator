// src/backends/factory.js
//
// SSOT：按 agent.backend 构造 backend 实例的唯一共享工厂。
//
// 历史：同款构造曾散在 cli.js / shared.js / backgroundRunner.js / daemon.js 多处，
// 分支语义一致但各自漂移风险高。收敛后全部构造点（daemon.js、backgroundRunner.js、
// commands/shared.js）共用本模块。
//
// 注入点：
//   - fetchImpl：仅 opencode-serve 使用（测试注入；不注入走默认 fetch）。
//   - waoCliPath：三个进程式 backend（claude-code / codex / kimi-code）使用。
//     显式注入优先；未注入时内部调 getWaoCliPath() 解析。
//     daemon.js / backgroundRunner.js 在启动时算好传入（每次进程一次）；
//     commands/shared.js 走薄委托不传参，每次调用由工厂内部解析——两种现状行为均不变。
//
// 刻意不在本工厂的构造点（禁止并入）：
//   - src/mcp/server.js 的 resolveBackendFor：未知 backend return null 而非抛错，
//     这是 M12-7 续跑资格检查的刻意 fail-soft 语义。
//   - src/smoke.js：4 分支（无 kimi-code）、不传 waoCliPath，是刻意的最小探测面。

import { OpenCodeServeBackend } from "./opencodeServe.js";
import { ClaudeCodeBackend } from "./claudeCode.js";
import { CodexBackend } from "./codex.js";
import { KimiCodeBackend } from "./kimiCode.js";
import { DeepSeekHarnessBackend } from "./deepSeekHarness.js";
import { DeepSeekAcpBackend } from "./deepSeekAcp.js";
import { getWaoCliPath } from "../waoCliPath.js";

/**
 * 按 agent.backend 选对应后端实例。
 *
 * @param {object} agent - 规范化后的 agent（含 backend 字段）
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] - opencode-serve fetch 注入（测试）
 * @param {string} [opts.waoCliPath] - worker 注入用的 WAO CLI 入口路径；
 *   未注入时内部调 getWaoCliPath() 解析（TD-90）。
 */
export function backendFor(agent, { fetchImpl, waoCliPath } = {}) {
  if (agent.backend === "opencode-serve") {
    return new OpenCodeServeBackend(fetchImpl ? { fetchImpl } : {});
  }
  const cliPath = waoCliPath ?? getWaoCliPath();
  if (agent.backend === "claude-code") return new ClaudeCodeBackend({ waoCliPath: cliPath });
  if (agent.backend === "codex") return new CodexBackend({ waoCliPath: cliPath });
  if (agent.backend === "kimi-code") return new KimiCodeBackend({ waoCliPath: cliPath });
  if (agent.backend === "deepseek-harness") return new DeepSeekHarnessBackend();
  // ADR-0031（B-2）：DSH ACP 集成面（dsh --profile acp）。构造零副作用——
  // containment 资产 detect / resume fail-closed / argv 预算都在
  // preflightInvocation（spawn 前、transcript 前）执行。
  if (agent.backend === "deepseek-acp") return new DeepSeekAcpBackend();
  throw new Error(`Unsupported backend: ${agent.backend}`);
}

/**
 * backend 类声明的能力轴闭集（ADR-0032 §2 声明闭集全量——组件层
 * backendCapabilityConsistencyChecks 的逐轴对账基准）。成员增补属 Owner 决策：
 * 新成员必须同时落（a）各 backend 类的诚实声明、（b）本闭集、（c）组件层
 * 双向对账判据、（d）docs/usage.md 认证节的能力轴分层骨架。
 */
export const BACKEND_CAPABILITY_AXES = Object.freeze([
  "supportsRoleContract",
  "supportsSessionReuse",
  "supportsInFlightCorrection",
  "replayByRespawn",
  "reportsTokenUsage",
  "reportsCommandExitCode",
]);

/**
 * 每 backend 的条件与限制说明——单一出处（TD-162 生成层批次，2026-09-22 从
 * docs/usage.md 手写能力对照表各格条件文字迁移并压缩：保留可判定语义，删叙述）。
 *
 * 消费者：scripts/gen-certification.mjs（渲染进 docs/surface/certification.md，
 * 字节钉由 test/isolation-infra/docsSurface.test.js + docs-consistency.test.js 守卫）。
 * 纪律：
 *   - 这里只写**派生不出**的条件/限制语义（fail-closed 分叉、通道形状、绑定事实）；
 *     判定词（支持/不支持/条件）与档位集合由生成器对 validateAgentPolicy 的行为
 *     探针派生，不在此复述——静态文本复述探针可派生的集合会制造第二份会漂的值。
 *   - 键集：四个 policy 面（model / reasoning / contextWindow / provider）＋
 *     BACKEND_CAPABILITY_AXES 成员（仅承载额外条件者，如 opencode-serve 角色合同
 *     的版本门）。缺席 = 该轴无额外条件（判定词即全部语义）。
 *   - 成员增补属 Owner 决策：新 backend 必须在此登记条件说明（无则显式空对象）。
 */
export const CAPABILITY_NOTES = Object.freeze({
  "opencode-serve": Object.freeze({
    model: "须 OpenCode 形状 `{providerID, id, variant}`；canonical 裸 `{id}` 被拒（模型路由由 model.providerID 承担）",
    provider: "不支持 provider 块——模型路由由 `model.providerID` 承担",
    supportsRoleContract: "须 serve healthy 且版本 ≥ 1.18.0（派发前运行时探测，OPENCODE_NATIVE_SYSTEM_MIN_VERSION）",
    reportsTokenUsage: "session.tokens 周期轮询",
  }),
  "claude-code": Object.freeze({
    contextWindow: "仅 provider 路径（wrapper `--context-window`）；native OAuth 直连被拒",
    provider: "经 provider wrapper（`baseUrl` / `apiKeyEnv`）表达",
    supportsSessionReuse: "`--session-id` / `--resume`（opaque uuid 由控制平面派生）",
    supportsRoleContract: "`--append-system-prompt`（内容直传，恰好一次）",
    supportsInFlightCorrection: "stdin stream-json 排队（同一活进程；delivered 证明字节被接受，不证明模型执行了该轮）",
    reportsTokenUsage: "result 帧 usage",
  }),
  codex: Object.freeze({
    contextWindow: "无 CLI flag 可表达，配了即拒",
    provider: "codex 自有登录（非 anthropic-compatible wrapper），配了即拒",
    supportsSessionReuse: "`codex exec resume <thread_id>`；id 由 codex 自产（thread.started.thread_id）、runner 运行期补记入 `session.created`；resume 轮 id 缺失即派发前拒绝",
    supportsRoleContract: "`-c developer_instructions` 追加（TOML 安全转义；不替换 base instructions）",
    reportsTokenUsage: "turn.completed 帧 usage",
  }),
  "kimi-code": Object.freeze({
    reasoning: "effort 编译为 `KIMI_MODEL_THINKING_EFFORT` 子进程 env；`agent.env` 自设同名被拒；档位与模型绑定见判定表（探针派生）",
    provider: "kimi 托管认证，配了即拒",
    supportsSessionReuse: "`kimi -r <session_id>`；id 来自轮末 `session.resume_hint`、runner 运行期补记；resume 轮 id 缺失即派发前拒绝",
    supportsRoleContract: "拼进同一条 prompt（非系统级通道，prompt 级引导）",
    reportsTokenUsage: "stream-json 无 usage——tokenBudget 不生效（TD-87）",
  }),
  "deepseek-harness": Object.freeze({
    reasoning: "可省略（未配置不拒）",
    provider: "组合由 `dshConfigPath` / `dshProvider` 表达，配 provider 块即拒",
    supportsRoleContract: "`DSH_SYSTEM_PROMPT`",
    reportsTokenUsage: "assistant/message 帧 usage",
  }),
  "deepseek-acp": Object.freeze({
    model: "模型经 shipped acp profile 的 session configOptions 承载；通道已证可 set（Phase 5），但 WAO 未接线（ACP 值形状是 provider/model JSON 对，非裸 model.id）；配了即拒，模型取 profile 缺省",
    reasoning: "经 `session/set_config_option` 下发（六值闭集 ∩ ACP 广告 off/low/high/max 的交集，不发明映射）；响应未确认即 fail-closed 拒绝派发；resume 轮不发 set，改用 session/resume 响应 configOptions 只读核对，不符即拒",
    contextWindow: "同 model 块——无可验证设置通道，配了即拒",
    provider: "组合面固定为 `--profile acp` + 操作员 patch，配 provider 块即拒",
    supportsSessionReuse: "ADR-0031 §3.6 关联面：resume 信封只携带前任 WAO runId，sessionId 由 spawn 权威按 runId 从转录取回、in-process 送达（不进 argv）；关联缺失/损坏/上游拒绝一律 fail-closed 拒绝，绝不静默新会话；仅 stable-workspace lane 的非 delivery 派发，delivery 一律 fresh",
    supportsRoleContract: "per-dispatch `--patch` personaPrefix（结构化序列化）",
    reportsTokenUsage: "`PromptResponse.usage` 实测可为 null——声明 false（2026-09-20 裁定）；翻转条件 = 有可验证 token 计量通道",
  }),
});

/**
 * ADR-0025 批次 2（2026-09-21 扩到声明闭集全量，ADR-0032 §2）：backend 实例
 * 闭集能力声明的静态读取 SSOT（单一定义处）。
 *
 * 严格 `=== true`：未声明（undefined）与 truthy 非 true（"false"/1/{}）一律读为
 * false——fail-closed，"未声明"绝不读成"支持"（与 runManager 消费
 * supportsSessionReuse/supportsRoleContract 的 strict === true 纪律同款）。
 * registry validate 用这层读取做配置 × 能力交叉校验；不猜、不补默认 true。
 *
 * @param {object} backend — 任意 backend 实例（含测试注入的伪造形状）
 * @returns {Record<string, boolean>} 声明闭集全量成员 → 布尔（键集恒等于
 *   BACKEND_CAPABILITY_AXES）
 */
export function readBackendCapabilities(backend) {
  return Object.fromEntries(
    BACKEND_CAPABILITY_AXES.map((axis) => [axis, backend?.[axis] === true]),
  );
}

/**
 * ADR-0025 批次 2：按 agent.backend 构造 backend 并读取其闭集能力声明。
 *
 * 纯静态：五个 backend 类的构造函数都无副作用（不 spawn 进程、不发网络
 * 请求——spawn/fetch 只在运行时方法里被调用），`registry validate` 的加载
 * 路径因此可以零副作用地读到类声明。未知 backend → null（validate 的
 * "unknown backend" hard issue 由调用方另行报告；能力面不猜）。
 *
 * @param {object} agent — 只读 agent.backend（registry 原始条目即可）
 * @param {object} [opts] — 透传 backendFor（fetchImpl / waoCliPath 注入）
 * @returns {Record<string, boolean>|null} 声明闭集全量快照（键集 =
 *   BACKEND_CAPABILITY_AXES）；未知 backend → null
 */
export function backendCapabilitySnapshot(agent, opts = {}) {
  try {
    return readBackendCapabilities(backendFor(agent, opts));
  } catch {
    return null;
  }
}
