// src/backends/factory.js
//
// SSOT：按 agent.backend 构造 backend 实例的唯一共享工厂。
//
// 历史：同款构造曾散在 cli.js / shared.js / backgroundRunner.js / daemon.js 多处，
// 分支语义一致但各自漂移风险高。收敛后全部构造点（daemon.js、backgroundRunner.js、
// commands/shared.js）共用本模块。
//
// 注入点：
//   - fetchImpl：HTTP 家族（opencode-serve / kimi-web）使用（测试注入；不注入走
//     默认 fetch）。
//   - waoCliPath：三个进程式 backend（claude-code / codex / kimi-code）使用。
//     显式注入优先；未注入时内部调 getWaoCliPath() 解析。
//     daemon.js / backgroundRunner.js 在启动时算好传入（每次进程一次）；
//     commands/shared.js 走薄委托不传参，每次调用由工厂内部解析——两种现状行为均不变。
//
// 刻意不在本工厂的构造点（禁止并入）：
//   - src/smoke.js：4 分支（无 kimi-code）、不传 waoCliPath，是刻意的最小探测面。
//
// （2026-10-04 修订：src/mcp/server.js 的 resolveBackendFor 曾在此列为独立构造点
//  ——那份五后端手抄名单漂移漏掉 kimi-web/zcode/deepseek-acp，误拒其 continuable/
//  correctable 派发。现改为薄包装：构造委托本工厂，仅"未知 backend → null"的
//  fail-closed 闸门留在包装层。parity 钉：mcpRunDispatch.test.js。）

import { OpenCodeServeBackend } from "./opencodeServe.js";
import { ClaudeCodeBackend } from "./claudeCode.js";
import { CodexBackend } from "./codex.js";
import { KimiCodeBackend } from "./kimiCode.js";
import { DeepSeekHarnessBackend } from "./deepSeekHarness.js";
import { DeepSeekAcpBackend } from "./deepSeekAcp.js";
import { KimiWebBackend } from "./kimiWeb.js";
import { ZcodeBackend } from "./zcode.js";
import { getWaoCliPath } from "../waoCliPath.js";

// 「转录自报」能力位（2026-10-02 Lead 体验批，双席会审两席共同裁定）：
// 消息与证据事件**完整落盘**的 backend（collect 走转录重建，不做活服务拉取）。
// 这是行为元数据表（HARNESS_VERSION_PROBES 同形状——键控查表，共享层不按
// runtime 名分支），**不是** gen:certification 的能力轴，不进派生面。
// 本批仅启用 kimi-web（其 run.event 完整性已实证：run_20261002121934119hkvz81
// 36 tool_use/67 tool_result/30 command/1 file_written/2 message 含 5,560 字终稿）。
// opencode-serve 的 run.event 亦落盘（N4）但本批不扩大爆炸半径——留口：全员
// 启用后 serve 拉取路径可整体退役（取源统一为转录重建）。
export const SELF_REPORTED_TRANSCRIPT_BACKENDS = Object.freeze(new Set(["kimi-web"]));
export function collectsFromTranscript(backendName) {
  return typeof backendName === "string" && SELF_REPORTED_TRANSCRIPT_BACKENDS.has(backendName);
}

/**
 * 按 agent.backend 选对应后端实例。
 *
 * @param {object} agent - 规范化后的 agent（含 backend 字段）
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] - HTTP 家族 backend（opencode-serve / kimi-web）
 *   的 fetch 注入（测试；不注入走默认 fetch）。
 * @param {string} [opts.waoCliPath] - worker 注入用的 WAO CLI 入口路径；
 *   未注入时内部调 getWaoCliPath() 解析（TD-90）。
 */
export function backendFor(agent, { fetchImpl, waoCliPath } = {}) {
  if (agent.backend === "opencode-serve") {
    return new OpenCodeServeBackend(fetchImpl ? { fetchImpl } : {});
  }
  // 第 7 个 backend「kimi-web」（HTTP attach，`kimi web` 本地服务器的官方 REST
  // API；闭集 6→7 扩员经 Owner 2026-09-30 批准）。构造零副作用；fetchImpl 注入
  // 同 opencode-serve 分支（HTTP 家族不需要 waoCliPath）。
  if (agent.backend === "kimi-web") {
    return new KimiWebBackend(fetchImpl ? { fetchImpl } : {});
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
  // 第 8 个 backend「zcode」（进程式 stdio app-server，驱动智谱 ZCode 桌面版捆绑
  // CLI 的 ZCode Protocol v1；闭集 7→8 扩员经 Owner 2026-10-01 批准）。进程式
  // 家族：与 claude-code/codex/kimi-code 同款注入 waoCliPath（构造零副作用）。
  if (agent.backend === "zcode") return new ZcodeBackend({ waoCliPath: cliPath });
  throw new Error(`Unsupported backend: ${agent.backend}`);
}

// ── 服务端中止实现的选择（wao stop / run_stop 的服务端路由，唯一选择处） ─────────
//
// 会话记录（session.created）带 serveUrl 的运行，停止时由这里按会话记录的 backend
// 选中止实现——runStop 只调本函数，自身不按后端名分支（仓库不变量 3）。返回值的调用
// 形状 = opencodeStopVerify.executeStopWithVerification 消费的 {abort, session,
// messages, sessionStatus}。
//   - backend 缺省 / opencode-serve：OpenCodeServeBackend（不读 registry）。
//   - kimi-web：鉴权要 token，token 不在转录里——取派发该运行的 registry agent
//     （loadAgent 回调，由调用方按 run.started.agentId 绑定读取）；agent 须同为该
//     backend、serveUrl 去尾斜杠后与会话记录相同，否则不发任何请求。token 在这里
//     就解析（resolveCredentials 回调给出派发时同一条 user-env 桥的值）：取不到同样
//     算解析失败。
//   - 其余 backend：没有服务端中止。
// 解析失败一律抛固定文案（不回显 token、URL 或 registry 内容）；调用方据此不认领终态。

const DEFAULT_SERVER_STOP_BACKEND = "opencode-serve";

export const SERVER_STOP_ROUTE_TEXT = Object.freeze({
  agentUnavailable:
    "stop route unavailable: the registry entry of the agent that dispatched this run could not be read "
    + "(no registry path, unreadable registry, or the agent is no longer registered); no stop request was sent "
    + "and the worker may still be running",
  agentMismatch:
    "stop route unavailable: the registry agent that dispatched this run no longer matches the session record "
    + "(different backend or serveUrl); no stop request was sent and the worker may still be running",
  credentialUnavailable:
    "stop route unavailable: the bearer token of the agent that dispatched this run could not be resolved "
    + "(token file or environment variable); no stop request was sent and the worker may still be running",
  unsupported:
    "stop route unavailable: this session's backend has no server-side abort; no stop request was sent "
    + "and the worker may still be running",
  unresolved:
    "stop route unavailable: the stop target could not be resolved; no stop request was sent "
    + "and the worker may still be running",
});

/** 会话记录里的 backend（缺省 = opencode-serve）——写进停止事实的 backend 字段。 */
export function serverStopBackendOf(session) {
  return typeof session?.backend === "string" && session.backend.length > 0
    ? session.backend
    : DEFAULT_SERVER_STOP_BACKEND;
}

/** 停止未核实告警里的会话称谓（opencode-serve 沿用 "opencode"，其余用 backend 名）。 */
export function serverStopSessionLabel(session) {
  const backend = serverStopBackendOf(session);
  return backend === DEFAULT_SERVER_STOP_BACKEND ? "opencode" : backend;
}

/**
 * @param {object} session — 会话记录（backend / serveUrl / backendSessionId）
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] — HTTP 注入（opencode-serve 分支原样传入构造）
 * @param {() => Promise<object>} [opts.loadAgent] — 取派发该运行的 registry agent；
 *   只在需要鉴权的 backend 上调用
 * @param {(agent: object) => Promise<Record<string, string>>} [opts.resolveCredentials] —
 *   该 agent 的凭据环境值（派发时的同一条 user-env 桥）；只在 agent 校验通过后调用
 * @returns {Promise<{abort: Function, session: Function, messages: Function, sessionStatus: Function}>}
 */
export async function serverStopTargetFor(session, { fetchImpl, loadAgent, resolveCredentials } = {}) {
  const backend = serverStopBackendOf(session);
  if (backend === "opencode-serve") {
    return new OpenCodeServeBackend({ fetchImpl });
  }
  if (backend === "kimi-web") {
    let agent = null;
    try {
      agent = typeof loadAgent === "function" ? await loadAgent() : null;
    } catch {
      agent = null;
    }
    if (!agent || typeof agent !== "object") throw new Error(SERVER_STOP_ROUTE_TEXT.agentUnavailable);
    if (agent.backend !== backend
      || typeof agent.serveUrl !== "string" || typeof session.serveUrl !== "string"
      || trimTrailingSlash(agent.serveUrl) !== trimTrailingSlash(session.serveUrl)) {
      throw new Error(SERVER_STOP_ROUTE_TEXT.agentMismatch);
    }
    let resolvedCredentials = {};
    try {
      resolvedCredentials = typeof resolveCredentials === "function" ? (await resolveCredentials(agent)) ?? {} : {};
    } catch {
      resolvedCredentials = {};
    }
    try {
      return new KimiWebBackend(fetchImpl ? { fetchImpl } : {})
        .stopTarget(agent, session.backendSessionId, { resolvedCredentials });
    } catch {
      throw new Error(SERVER_STOP_ROUTE_TEXT.credentialUnavailable);
    }
  }
  throw new Error(SERVER_STOP_ROUTE_TEXT.unsupported);
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

/**
 * backend 类声明的能力轴闭集（ADR-0032 §2 声明闭集全量——组件层
 * backendCapabilityConsistencyChecks 的逐轴对账基准）。成员增补属 Owner 决策：
 * 新成员必须同时落（a）各 backend 类的诚实声明、（b）本闭集、（c）组件层
 * 双向对账判据、（d）docs/certification-runbook.md 认证节的能力轴分层骨架。
 */
export const BACKEND_CAPABILITY_AXES = Object.freeze([
  "supportsRoleContract",
  "supportsSessionReuse",
  "supportsInFlightCorrection",
  "replayByRespawn",
  "reportsTokenUsage",
  "reportsCommandExitCode",
  "enforcesWriteSandbox",
]);

/**
 * 每 backend 的条件与限制说明——单一出处（TD-162 生成层批次，2026-09-22 从
 * docs/usage.md 手写能力对照表各格条件文字迁移并压缩：保留可判定语义，删叙述）。
 *
 * 消费者：scripts/gen-certification.mjs（渲染进 docs/surface/certification.md，
 * 字节钉由 test/isolation-infra/docsSurface.test.js + docs-consistency.test.js 守卫）。
 * 纪律：
 *   - 这里只写**派生不出**的条件/限制语义（fail-closed 分叉、通道形状、绑定事实）；
 *     判定词（支持/不支持/条件；model 栏为必填/可选＋写法）与档位集合由生成器对 validateAgentPolicy 的行为
 *     探针派生，不在此复述——静态文本复述探针可派生的集合会制造第二份会漂的值。
 *   - 键集：四个 policy 面（model / reasoning / contextWindow / provider）＋
 *     BACKEND_CAPABILITY_AXES 成员（仅承载额外条件者，如 opencode-serve 角色合同
 *     的版本门）。缺席 = 该轴无额外条件（判定词即全部语义）。
 *   - 成员增补属 Owner 决策：新 backend 必须在此登记条件说明（无则显式空对象）。
 *   - `vitalSigns` 是每个 backend 的必填项（决定 0069，Owner 2026-10-13："WAO 抽象
 *     原则统一，适配层 case by case"）：写明控制面在这条后端上读得到哪些生命体征、
 *     哪些会落成转录事实、有哪些"等不到进展"的收口门以及它们与体征的关系。口径
 *     只有一条——没有生命体征才由控制面收口，有生命体征去留归 Lead；做不到的
 *     地方在这里如实登记为例外。生成器缺项即红。
 */
export const CAPABILITY_NOTES = Object.freeze({
  "opencode-serve": Object.freeze({
    model: "`variant` 可选",
    provider: "不支持 provider 块——模型路由由 `model.providerID` 承担",
    supportsRoleContract: "须 serve healthy 且版本 ≥ 1.18.0（派发前运行时探测，OPENCODE_NATIVE_SYSTEM_MIN_VERSION）",
    reportsTokenUsage: "session.tokens 周期轮询",
    enforcesWriteSandbox: "无 OS 写沙箱——上游 serve 无沙箱面，越界写拦截按 0084（上报侦测，非阻止）",
    vitalSigns: "未按生命体征口径适配（Owner 2026-10-12：该后端不再投入）；收口门为 `silentTimeout` 与快照稳定判据",
  }),
  "claude-code": Object.freeze({
    contextWindow: "仅 provider 路径（wrapper `--context-window`）；native OAuth 直连被拒",
    provider: "经 provider wrapper（`baseUrl` / `apiKeyEnv`）表达",
    supportsSessionReuse: "`--session-id` / `--resume`（opaque uuid 由控制平面派生）",
    supportsRoleContract: "`--append-system-prompt`（内容直传，恰好一次）",
    supportsInFlightCorrection: "stdin stream-json 排队（同一活进程；delivered 证明字节被接受，不证明模型执行了该轮）",
    reportsTokenUsage: "result 帧 usage",
    enforcesWriteSandbox: "无 OS 写沙箱——CLI 未接线沙箱参数，越界写拦截按 0084（上报侦测，非阻止）",
    vitalSigns: "可读体征：stdout 事件；转录静默满 5 分钟起取样——后代进程在干活落 `process_active`、工作目录文件变化落 `files_changed`（只供观察）。没有轮内\"等不到进展\"的收口门（可选 `silentTimeout` 只管启动后零事件，默认关）：取样读到什么都不收口；长思考期间读不到体征",
  }),
  codex: Object.freeze({
    contextWindow: "无 CLI flag 可表达，配了即拒",
    provider: "codex 自有登录（非 anthropic-compatible wrapper），配了即拒",
    supportsSessionReuse: "`codex exec resume <thread_id>`；id 由 codex 自产（thread.started.thread_id）、runner 运行期补记入 `session.created`；resume 轮 id 缺失即派发前拒绝",
    supportsRoleContract: "`-c developer_instructions` 追加（TOML 安全转义；不替换 base instructions）",
    reportsTokenUsage: "turn.completed 帧 usage",
    enforcesWriteSandbox: "每次 `exec` / `exec resume` 显式传 `-c sandbox_mode=\"workspace-write\"` 等三项（压过用户 config.toml；决定 0086）；可写面 = 运行的工作目录 + 系统临时目录（`%TEMP%` 可写是已知边界），关联工作树的 git 元数据在树外不可写；活体证据 = reliability `sandboxEnforcement`（`codex sandbox -P :workspace` 探测，不经模型）",
    vitalSigns: "可读体征：stdout 事件；转录静默满 5 分钟起取样——后代进程在干活落 `process_active`、工作目录文件变化落 `files_changed`（只供观察）。没有轮内\"等不到进展\"的收口门（可选 `silentTimeout` 只管启动后零事件，默认关）：取样读到什么都不收口；长思考期间读不到体征",
  }),
  "kimi-code": Object.freeze({
    reasoning: "effort 编译为 `KIMI_MODEL_THINKING_EFFORT` 子进程 env；`agent.env` 自设同名被拒；档位与模型绑定见判定表（探针派生）",
    provider: "kimi 托管认证，配了即拒",
    supportsSessionReuse: "`kimi -r <session_id>`；id 来自轮末 `session.resume_hint`、runner 运行期补记；resume 轮 id 缺失即派发前拒绝",
    supportsRoleContract: "拼进同一条 prompt（非系统级通道，prompt 级引导）",
    reportsTokenUsage: "stream-json 无 usage——tokenBudget 不生效（TD-87）",
    enforcesWriteSandbox: "无 OS 写沙箱——CLI 无沙箱参数面，越界写拦截按 0084（上报侦测，非阻止）",
    vitalSigns: "可读体征：stdout 事件；转录静默满 5 分钟起取样——后代进程在干活落 `process_active`、工作目录文件变化落 `files_changed`（只供观察）。没有轮内\"等不到进展\"的收口门（可选 `silentTimeout` 只管启动后零事件，默认关）：取样读到什么都不收口；长思考期间读不到体征",
  }),
  "deepseek-harness": Object.freeze({
    reasoning: "可省略（未配置不拒）",
    provider: "组合由 `dshConfigPath` / `dshProvider` 表达，配 provider 块即拒",
    supportsRoleContract: "`DSH_SYSTEM_PROMPT`",
    reportsTokenUsage: "assistant/message 帧 usage",
    enforcesWriteSandbox: "无 OS 写沙箱——dsh 无沙箱参数面，越界写拦截按 0084（上报侦测，非阻止）",
    vitalSigns: "可读体征：协议帧（握手落 `initialized`，assistant 分片落 `streaming`）。没有轮内\"等不到进展\"的收口门（请求级 15s 超时除外）；长工具调用期间不落体征事实",
  }),
  "deepseek-acp": Object.freeze({
    model: "只接受 `{ id, providerID }`（ACP 的模型选项值是 provider/model 二元组 JSON，裸 id 表达不了，配了即拒）；经 `session/set_config_option` 下发，值不在 session/new 广告的选项里或响应未确认即 fail-closed 拒绝派发；resume 轮不发 set，改用 session/resume 响应 configOptions 只读核对，不符即拒；不配时新会话用 profile 缺省、resume 沿用恢复会话的模型",
    reasoning: "经 `session/set_config_option` 下发（六值闭集 ∩ ACP 广告 off/low/high/max 的交集，不发明映射）；响应未确认即 fail-closed 拒绝派发；resume 轮不发 set，改用 session/resume 响应 configOptions 只读核对，不符即拒",
    contextWindow: "无可验证设置通道，配了即拒（model 块只接受 id 与 providerID）",
    provider: "组合面固定为 `--profile acp` + 操作员 patch，配 provider 块即拒",
    supportsSessionReuse: "ADR-0031 §3.6 关联面：resume 信封只携带前任 WAO runId，sessionId 由 spawn 权威按 runId 从转录取回、in-process 送达（不进 argv）；关联缺失/损坏/上游拒绝一律 fail-closed 拒绝，绝不静默新会话；仅 stable-workspace lane 的非 delivery 派发，delivery 一律 fresh",
    supportsRoleContract: "per-dispatch `--patch` personaPrefix（结构化序列化）",
    reportsTokenUsage: "`PromptResponse` 只带 `stopReason`，`session/update` 的 `usage_update {used, size}` 是上下文占用、不是计量（0.2.1-rc.4 实测，2026-10-29）——声明 false；翻转条件 = 有可验证 token 计量通道",
    enforcesWriteSandbox: "无 OS 写沙箱（进程级）——containment 走操作员安装的 ACP 补丁面，WAO 不在调用层强制 OS 沙箱，越界写拦截按 0084（上报侦测，非阻止）",
    vitalSigns: "可读体征：协议帧（握手落 `initialized`）。没有轮内\"等不到进展\"的收口门——握手等非 prompt 请求有 60s 超时，prompt 请求本身不设时限；轮内不落体征事实",
  }),
  // 第 7 个 backend（Owner 2026-09-30 批准入册）。上游事实 = 2026-09-30 对本机
  // kimi 2.1.1 `kimi web` REST API 的直跑实测，中止与 thinking 取 kimi 2.4.0 的实测
  // （详见 src/backends/kimiWeb.js 文件头；v8 完成判定 = transcript 轮次终态原语）。
  "kimi-web": Object.freeze({
    model: "空白/纯空白 `model.id` 同样被拒；id 原样直传 prompts body——上游缺 model 时接口返 success 但轮次静默秒败，所以派发前硬拒；`model.providerID` / `model.variant` 配了即拒（prompts body 只认裸 model id，防迁移配置的路由字段被静默丢弃）；serveUrl/tokenEnv 亦必填",
    reasoning: "effort 直传 prompts body 的 `thinking`（车道声明与 `--reasoning` 覆盖同一通道，resume 轮同样带）；档位见判定表（探针派生），关闭思考不可配；型号与力度的搭配交给服务端校验（不支持的组合上游报 50001，派发失败），WAO 不做型号绑定；effort 缺省不发该字段",
    provider: "kimi 托管认证（服务器 bearer token，`tokenEnv` 每请求解析，token 值绝不进 transcript/日志/错误消息）；配 provider 块即拒",
    supportsRoleContract: "拼进 prompt 正文前缀，role/task 以 `\\n\\n---\\n\\n` 分隔（对齐 kimi-code ROLE_TASK_SEPARATOR；非系统级通道，prompt 级引导）",
    supportsSessionReuse: "resume 轮不 POST /sessions，直接向前任 session id POST prompts；id 取 `session.created.backendSessionId`（服务器自产 session_ id）、runner 运行期补记；resume 轮 id 缺失即派发前拒绝；完成判定同一段逻辑天然工作（v8 transcript 轮次归属：resume 的 prompt 在既有会话触发新 turn，triggerPromptId === prompt_id 唯一圈定，历史轮永不重放/误归属——按构造不可能）",
    supportsInFlightCorrection: "`prompts` 排队 + `prompts:steer` 转入活动轮（`steered:true` 即 delivered）；delivered 证明已转入活动轮，不证明模型截断了当轮生成（纠偏在轮边界被消费）；消费可见性：prompts 列表项带 `steeredAt` 与状态枚举（2.4.0 OpenAPI 在册，未 live 实测，仅标注）；排队成功但 steer 失败（如 40402 无活动轮）时上游可能仍会在后续轮消费该排队消息——send_failed ≠ 一定未执行，Lead 重发前须知此不对称",
    reportsTokenUsage: "transcript 轮次 `steps[].usage` 实测非零（2026-09-30 live，inputOther/output/inputCacheRead/inputCacheCreation 四计数）——v8 起声明 true（v7 false 的翻转条件自此满足；会话详情 usage 可为全零不再是唯一通道）；通道 = completed 轮 steps[].usage 求和（仅本轮）→ metrics 事件，tokenBudget 闸门生效；abort 中止会话正在跑和排队的 prompt（`GET prompts`，先对 queued 逐条、再对 active `POST …/prompts/{promptId}:abort`——只停活动的，排队那条会立刻接着跑；两样都没有视为已停；上游拒绝/传输失败抛固定文案；绝不调服务器级 `/api/v1/shutdown`；幂等，二次调用复用首次结果），停止验证经停止探针观测会话 busy 状态（中止后会话不忙）；`wao stop` / `run_stop` 同走这条中止与验证，鉴权取 registry 里派发该运行的 agent（`run.started.agentId`，须同为 kimi-web 且 serveUrl 与会话记录一致），agent 或它的 token 取不到（token 按派发时的同一条路解析）、或对不上时不发请求、不认领终态（`run.stop_unverified` 的 outcome 为 `stop_route_unavailable`）——已知边界：中止只停模型这一轮，这一轮已经启动的命令进程跑到自己结束，会话按原规则保留（failed/aborted 的会话留作取证源）；事件流有界终止 = silentTimeout（提交滞后无 turn 即 silent fail）+ 无进展出口（60–240s 自适应预算 + serve 证词，见本后端的 `vitalSigns`），两出口独立并存；waitTimeout 到期只通知不终止（ADR-0030），不构成兜底）",
    enforcesWriteSandbox: "无 OS 写沙箱——HTTP attach 远端 serve，写发生在服务器侧进程，本机调用层无沙箱面，越界写拦截按 0084（上报侦测，非阻止）",
    vitalSigns: "可读体征：turn 结构变化（落 `streaming`）、serve 证词（落 `serve_active`）。提交后 turn 迟迟不出现：`silentTimeout`，未配置时 8 拍。有 turn 无变化满 60–240s 自适应预算问 serve：不活跃或问不到即收口；活跃则续命，自上次产出增长起续命静默满 30min 仍收口——证词是服务端自述、无法交叉印证，口径的已登记例外（决定 0068）",
  }),
  // 第 8 个 backend（Owner 2026-10-01 批准入册）。上游事实 = 2026-10-01 对本机
  // zcode 0.16.9 捆绑 CLI app-server（ZCode Protocol v1）的 live 实测（详见
  // src/backends/zcode.js 文件头）；0.17.0 的复核见 docs/certification-runbook.md 原语表。
  "zcode": Object.freeze({
    model: "ref 须恰好一个 `/`、两段非空（该形状已 live 验证——backend 拆分后经 `session/setModel` 下发）；per-dispatch `--model` 覆盖同样须是 ref（裸 id 无法路由）；`model.providerID`/`model.variant` 配了即拒（路由在 ref 里）；binary 亦必填（桌面捆绑 zcode.cjs 绝对路径，桌面更新会漂移）",
    reasoning: "effort 直传 `session/setModel` 的 `options.reasoningLevel`（不发明映射）；值闭集由上游 zod 校验——域外值上游报错如实透传固定形状（`Reasoning level is required` 形缺省坑只对部分模型成立，配了才发）；effort 缺省不传 options",
    provider: "登录态与 ZCode 桌面版共享（无需额外认证，凭据不在 env 面），配 provider 块即拒",
    supportsRoleContract: "拼进 `session/send` content 前缀，role/task 以 `\\n\\n---\\n\\n` 分隔（对齐 kimi-code/kimi-web ROLE_TASK_SEPARATOR 先例；协议未证实系统级通道——prompt 级引导，非 system 级隔离）",
    supportsSessionReuse: "resume 轮不 `session/create`，次序固定 `session/resume {sessionId}` → `session/setModel` → `session/setMode {sessionId, mode:\"yolo\"}` → `session/send`（setMode 每次派发都发、失败 fail-closed 拒绝——app-server create 默认 build，scorecard 实测写被权限层拦，runs/reliability/run_20261001213724000cy1b3a）——resume 是上游持久化恢复 + 注册进**本进程**会话表的唯一途径（bundle 核证：sessions 表每进程一张、setModel 走 requireSession、查表 miss 抛 `Session is not active`、resume 装载注册；跳过 resume 直接 setModel 必失败；依据链与各版本复核见 certification-runbook 原语表 zcode 行）；resume 帧失败/未知形状 fail-closed 拒绝派发；id 取 `session.created.backendSessionId`（zcode 的该值即上游自产 sess_ id——spawn 时刻已知，无 proc_<pid> 占位中间态）；resume 轮 id 缺失/占位即派发前拒绝（live 未逐测——bundle 源码核证形状，见 zcode.js 文件头依据链）；完成判据自 2026-10-10 B′ 根修起为【身份切片】（锚点=本轮新 user 消息，完成=parent 指向它的新 assistant 末位 step-finish；历史变异=基线 id 序列不再前缀→具名失败；resume 历史缺 info.id→发送前拒绝零 token）——上游消息 info.id/role/parentID 与 part id/messageID 已 live 探针实证在场且跨快照稳定（glm-flash 三轮 fresh/同进程/跨进程 resume，证据 .dev/bprime-evidence/；验收反例组 ⑨h-⑨l/⑫f 在旧位置判据上实证红）；旧判据的「头部插入→旧 stop 右移→假 completed+发射旧答案」残余就此关闭（该残余曾连带击穿 0052 失败即弃与 run_lineage 交付链）",
    supportsInFlightCorrection: "app-server 协议不开放在途注入：活动轮里再发 `session/send` 返回 -32010 \"A prompt is already running for this session\"（live 实测；bundle 运行时虽有 steer 队列，协议方法表里没有注入活动轮的方法）——如实声明 false；翻转条件 = 协议出现注入活动轮的方法并有 live 证据",
    reportsTokenUsage: "`session/usage` 全量计量 live 非零实测（2026-10-01，inputTokens/outputTokens/reasoningTokens/cacheReadTokens/cacheCreationTokens 分量 + totalTokens/modelRequestCount——字段名按上游实现形状，cache 系带 `Tokens` 后缀；0.17.0 实跑仍非零，2026-10-29）——completed 轮取一次 → metrics 事件（分量 1:1 映射，totalTokens 合计不重复计）；会话级累计（非增量），tokenBudget 闸门按累计值比对（opencode session.tokens 同款语义）；abort 双层：RunManager signal 先杀进程树，handle.abort() 在进程仍活时先试 `session/stop`（形状未经 live 验证，失败/未知如实上抛固定错误）再启动 taskkill 树杀（启动 ≠ 树杀成功，结果不核实）；abort 幂等（共享 Promise，二次调用复用首次结果）",
    enforcesWriteSandbox: "无 OS 写沙箱——app-server 协议无沙箱参数面，越界写拦截按 0084（上报侦测，非阻止）",
    vitalSigns: "可读体征：新 part / 工具证据、模型流分片（落 `streaming`）、app-server 后代进程的 CPU / I/O / 生灭（落 `process_active`）、工作目录文件变化（落 `files_changed`）、本轮主轮请求的上游重试等待（`v4/telemetry/event` 的 `model.request.status`：仅本会话、本轮 turnId、`querySource=main_turn` 的 `model_retry_scheduled`，有效到到达时刻+delayMs+30s 余量，落 `provider_retry`；同一安排的重复通知不延长，链上其后出现 started/completed（换 requestId 也算）、turn 结束或换轮即作废且粘住——作废前首见的安排连同其重复通知不再复活续命；failed/stream_stalled 本身不续命；上游上报 maxAttempts=0（重试预算无界）时每个新安排都会重新立窗、没有自动上限，且服务端 retry-after 可把单次退避拉长到远超 300s——有体征运行的去留归 Lead，决定 0067）。三道收口门到点先看体征，全无才收口（约 5–10 分钟）；有体征没有自动上限（决定 0067；重试等待不重置停滞预算时钟——退避窗一过仍无进展即收口）",
  }),
});

/**
 * 每 backend 的配置表达力探针**底稿**——该 backend `validateAgentPolicy` 能接受的
 * 最小配置。消费者**只有** `scripts/gen-certification.mjs`：校验与用法见那里的
 * `checkProbeBase` / `probeExpressivity`；键集须等于 KNOWN_BACKENDS，新 backend
 * 必须在此登记底稿，缺了生成器即报错。占位值一律用一眼能看出是假的值（假 model
 * id / 回环丢弃端口 9 / 假 env 名）——不得出现真实路径、主机或凭据名。
 */
export const POLICY_PROBE_BASES = Object.freeze({
  "opencode-serve": Object.freeze({}),
  "claude-code": Object.freeze({}),
  "codex": Object.freeze({}),
  "kimi-code": Object.freeze({}),
  "deepseek-harness": Object.freeze({}),
  "deepseek-acp": Object.freeze({}),
  "kimi-web": Object.freeze({
    model: Object.freeze({ id: "gen-certification-probe-model" }),
    serveUrl: "http://127.0.0.1:9",
    tokenEnv: "GEN_CERTIFICATION_PROBE_TOKEN",
  }),
  "zcode": Object.freeze({
    model: Object.freeze({ id: "gen-certification-probe/gen-certification-probe-model" }),
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
 * 纯静态：全部 backend 类的构造函数都无副作用（不 spawn 进程、不发网络
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
