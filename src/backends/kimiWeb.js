// src/backends/kimiWeb.js
//
// kimi-web backend（HTTP attach 型）：驱动 `kimi web` 本地服务器的 Kimi Code 官方
// REST API。只支持 kimi 2.6+（turns 端点；2.6 已删除旧的 GET …/transcript，实测
// 回 HTTP 404 路由不存在）。在用版本见 docs/certification-runbook.md 原语表。
//
// 上游 API 事实（标 2.6.3 的是 2026-11-17 的实测，原始响应在
// test/fixtures/kimi-2.6.3/；标 2.4.0 / 2.1.1 的是更早的实测，2.6.3 未见反证）：
//   - 所有请求需 Authorization: Bearer <token>；响应统一包 {code,msg,data}，
//     code!==0 即失败（msg 含原因）。
//   - POST /api/v1/sessions {title?, metadata:{cwd}} → data.id（session_ 前缀）；
//     metadata.cwd 或 workspace_id 必填（2.1.1：缺则 40001）——WAO 侧用 agent.cwd 填。
//   - POST /api/v1/sessions/{id}/prompts {content:[{type:"text",text}], model,
//     permission_mode:"auto", thinking?} → data {prompt_id, user_message_id, status,
//     content, created_at}（2.6.3：prompt_id === user_message_id；开轮即 status
//     "running"，有活动轮时 "queued"；文档另列 blocked/failed = 提交前就失败，未实测）。
//     2.1.1 的两个坑沿用：content 必须是分段数组（裸字符串 40001）；model 必填——缺
//     model 时接口照样返回成功，但轮次静默秒败（validateAgentPolicy 在派发前拒绝）。
//   - **GET /api/v1/sessions/{id}/agents/main/turns（2.6.3）**→ data {turns[],
//     has_more}：按 ordinal 从旧到新；不带参数取最新一页（含在跑的轮）；
//     before_ordinal 往回翻，page_size 1–200（默认 50；WAO 不发，用默认）。
//       · 轮：turn_id、ordinal、kind（只见过 "agent"）、status（running|ended）、
//         outcome（ended 才有：completed|interrupted；文档另列 failed，未实测）、
//         end_reason（见过 "user_cancelled"）、error（未见非空值）、usage
//         {input_other, output, input_cache_read, input_cache_creation}（等于各步
//         usage 之和）、steps[]{index, outcome, finish_reason, usage?}、items[]。
//       · 条目按 type 判别：user_message {prompt_ids[], placement:"opener", text}、
//         reasoning {step_index, text}、tool_call {item_id, step_index, name,
//         input, display, status, outcome, output}、assistant_message {step_index,
//         text}。写文件的 display.path 是绝对路径、input.path 是相对路径。在途
//         tool_call 的 status 值没有实测样本（只见过 "ended"）：非 "ended" 一律
//         按在途处理。
//   - **纠偏语义（2.6.3）**：活动轮在跑时提交的 prompt 进队列（status "queued"）；
//     POST …/prompts:steer {prompt_ids} → data {steered:true, prompt_ids}。转入后
//     那条 prompt 离开队列，当前轮被打断、以 outcome "completed" 无回答结束，被
//     转入的 prompt 作为下一轮的开场消息开轮并做完工作（t3/t4 实测）——所以一次
//     运行可以跨多轮。无活动轮时 steer 回 40402（2.1.1）。
//   - GET /api/v1/sessions/{id}/prompts → data {active, queued[]}：条目 {prompt_id,
//     user_message_id, status, content, created_at}（2.6.3）；无活动时 active:null。
//   - 中止：POST /api/v1/sessions/{id}/prompts/{promptId}:abort（body {}）→
//     data {aborted:true}；那一轮以 outcome "interrupted"、end_reason
//     "user_cancelled" 结束；对已停的 prompt 再 :abort → code 40402（2.6.3）。只停
//     这一轮：排队的 prompt 随即成为新的活动轮（2.4.0）；已转入、还没开轮的纠偏同样
//     不被清掉，中止后会自己开一轮（2.6 文档）。这一轮已启动的 shell 命令进程跑到
//     自己结束（2.4.0）。另有 POST /api/v1/shutdown（服务器级，杀全部会话）——
//     abort() 绝不调它。
//   - GET /api/v1/sessions/{id} → data{busy, main_turn_active, last_turn_reason,
//     …}（2.6.3 形状不变）：提交前静默门、停滞证词、中止后复查与停止验证探针。
//   - GET /api/v1/sessions/{id}/messages → data.items[]（newest-first；2.6.3 形状
//     不变，见 final-messages.json）：只供停止验证消费者，不参与完成判定。
//   - thinking（2.4.0）：prompts body 的力度字符串；"low"/"high"/"max" 被接受；非法
//     值 → code 50001。K3.1 Pro 只支持思考模式，关闭思考会被上游拒绝。
//   - 会话生命周期（TD-250，2.1.1，决定 0056）：POST /api/v1/sessions/{id}:delete
//     （body {}）→ {deleted:true}；会话不存在 → HTTP 200 + code 40401。删除不回收
//     serve 为会话拉起的助手进程，唯一全量拆除原语 = 优雅 POST /api/v1/shutdown。
//
// 一次运行 = 一个提示集合（spawn 建、sendCorrection 与事件流共用）：派发的 prompt
// + 每条被 POST prompts 接纳的纠偏（"已接纳"），其中 steer 回 steered:true 的另记
// "已转入"。某轮的 user_message.prompt_ids 含集合里的 id，该轮归本运行；最终轮 =
// 归属轮里 ordinal 最大的。每个 id 都结算了（出现在归属轮里，或 prompts 列表报
// blocked/failed，或仅接纳的纠偏到界未出现按"未执行"），最终轮 ended，且集合里
// 没有 id 还在 active/queued，才按 outcome 收口。细则见 streamEvents。
//
// 未实测、只按文档防御的形状：turn outcome "failed" 与 error 的结构（按
// {code,message} 或字符串读）、prompt status blocked/failed、在途 tool_call 的
// status 值、page_size/before_ordinal 的翻页（只实测过单页 has_more:false）、
// kind 非 agent 的轮（不按 kind 过滤，只按 prompt_ids 归属）。
//
// 形状不符取舍：turns / prompts / 会话详情的形状门不满足 ⇒ fail-closed 立即失败，
// 不重试、不回落 [] / {}——把"不可观察"当成"没有轮 / 没有排队"会虚报健康观测。
//
// 单 actor 会话假设：WAO 独占其派发的 session。提交前静默门之后的残余竞窗依赖该
// 假设；假设破裂时归属仍 fail-closed——他人的轮不含我们的 prompt id，不会被误领。
//
// 停止杠杆（诚实面）：abort() 中止会话正在跑和排队的 prompt 并有界复查（见
// abortActivePrompt）；停止验证经 handle 探针（session/sessionStatus/messages）；
// reportsTokenUsage=true（turn.usage 实测非零）。已知边界：中止不收这一轮已经启动的
// 命令进程；failed/aborted 的会话留作取证源，不删。

import {
  messageEvent,
  doneEvent,
  metricsEvent,
  commandEvent,
  fileWrittenEvent,
  toolUseEvent,
  toolResultEvent,
  runtimeActivityEvent,
} from "../runEvent.js";
import { readFileSync } from "node:fs";
import { isProcessPlaceholderSessionId } from "./processBackend.js";
import { kimiServerTokenFile, isValidKimiHome, isValidServeWorkspaceDir } from "../envPolicy.js";
import { ensureServeRunning } from "./kimiServeStart.js";
import { IDLE_WATCH_IDLE_THRESHOLD_MS, startServeIdleWatch } from "./kimiServeIdleWatch.js";
import { createSecretRedactor } from "../secretRedaction.js";
import { createStallTracker } from "./stallBudget.js";

// role/task 分隔符（"\n\n---\n\n"）——prompt 级 role-contract 通道的 backend
// （kimi-web / zcode）共用同一分隔形状，避免两套事实并存。
const ROLE_TASK_SEPARATOR = "\n\n---\n\n";

// 2.6 turns 端点的 agent 段：WAO 只读主 agent。
const TURNS_AGENT = "main";

// prompt 状态里表示"提交前就失败、不会执行"的值（2.6 文档；未实测）。
const PROMPT_FAILED_STATUSES = new Set(["blocked", "failed"]);
// ended 轮的 outcome 闭集（completed|interrupted 实测；failed 文档在册）。
const TURN_OUTCOMES = new Set(["completed", "interrupted", "failed"]);
// 中止的有界复查：最多几轮"中止 → 稍等 → 再读 prompts 与会话详情"。
const ABORT_ROUNDS = 3;

// TD-250（2026-10-10 live 探针）：会话级 40401 = "session … does not exist"——
// releaseSession 把它分派为 already_gone（HTTP 200 + code 40401 信封，非路由 404）。
const KIMI_SESSION_GONE_CODE = 40401;

// 2.4.0 实测：prompts body 的 thinking 接受的力度（服务端另报 off，WAO 不放行——
// 关闭思考对 K3.1 Pro 会被上游拒绝；WAO 的 effort 闭集里也没有 off）。
const KIMI_WEB_THINKING_EFFORTS = Object.freeze(["low", "high", "max"]);

// 形状漂移界（R9 F3/F4）：F3 = 提示未出现在任何轮里的兜底（仅 silentTimeout 缺席的
// 防御形状生效——正常路径由 silentTimeout 界定）；F4 = 最终轮 status/outcome 闭集外的
// 连续拍界（等待增长无意义，形状问题不是进度问题）。两者都不是"进度停滞"检测，维持
// 8 拍紧界——TD-197① 拆分（auditor Q5）。
const SHAPE_DRIFT_POLL_LIMIT = 8;
// 在途进度呈现的最小发射间隔（防刷屏：1s 轮询 × 快速增长帧也至多 12 次/分钟）。
const KIMI_PROGRESS_EMIT_MIN_INTERVAL_MS = 5000;

// TD-197①（2026-10-03，双席会审 v2）：无进展停滞门（turn 在场、state 在受支持
// 闭集内、signature 连续不变）改观测自适应时间预算。原 8 拍（≈8s）门当日三次
// 误杀刚提交、仍在服务端排队/慢启动的合法 turn（run_202610030913306635cko6a /
// run_20261003113532551q8oyps / run_202610031138135415ap6e2——三例全部
// session.created 在场、零 auth 错，token 从未缺位）。floor 抬到 60s 直接治
// 排队冷启动（auditor 对 v1 的 FAIL：自适应学不到被它杀掉的第一次），预算随
// 本轮已恢复的最大静默间隙 ×3 自放大、240s 硬顶保有界（顶约束静默段而非
// 墙钟——每拍另有请求/重试/睡眠叠加）。显式失败（failed/cancelled/空答案）
// 先于本门处理，不被拖慢。
const NO_PROGRESS_FLOOR_MS = 60_000;
const NO_PROGRESS_FACTOR = 3;
const NO_PROGRESS_CEILING_MS = 240_000;
// 0046 B5 根因修复（Owner 2026-10-06 否决短 brief 降质绕法）：预算击发前先取
// serve 活体证词（sessionDetail 的 main_turn_active/busy）——K3 长 dense brief 首
// 拍重思考零帧是活轮不是停滞（当日四杀实证），证词为真 = noteProgress 重置静默
// 段继续观察；证词为假/取不到 = 照杀（fail-closed 防真挂死）。证词续命的硬顶=
// **自上次产出增长以来被证词续命的静默时间**（每次续命把该段静默计入；产出/
// 流式时间不计数；产出增长即清零——决定 0068，Owner 2026-10-12）。"增长"按
// turnVolume 的最高水位判，不按签名变化判：state 在 running / queued 之间往返、
// 帧被改写都会改签名，但一个零产出的 turn 不能靠这种抖动无限清零（会审 sol 用
// 假快照复核到的路径）。此前按整 turn 累计、有进度也不清零：一个每隔几分钟落一次产出、合计静默超 30 分钟的健康长 turn 会
// 被它收掉（zcode 同形状的硬顶已先于此被改掉）。保留硬顶本身的理由：serve 的
// main_turn_active / busy 是服务端的自我声明，工具挂死时它同样报 active——没有
// 别的体征可以交叉印证，所以单段静默仍在此值收口。
const LIVENESS_ATTESTED_SILENT_CAP_MS = 30 * 60_000;

// usage 的字段映射（kimi 2.6 轮级 usage 四计数 → metrics 轴，1:1 语义映射，不发明
// 聚合；reasoning/costUsd 无 kimi 对应字段，省略）。
const USAGE_FIELDS = Object.freeze([
  ["input_other", "input"],
  ["output", "output"],
  ["input_cache_read", "cacheRead"],
  ["input_cache_creation", "cacheWrite"],
]);

export class KimiWebBackend {
  // 会话活在 WAO 进程之外的 `kimi web` 服务器里（HTTP attach 型，TD-39 同款语义：
  // WAO 进程退出 ≠ session 死）。停止杠杆（诚实声明，见文件头）：abort 中止排队与
  // 活动的 prompt（不收这一轮已经启动的命令进程）；停止验证经 handle 探针观测会话
  // busy 状态；tokenBudget 闸门生效（reportsTokenUsage=true——turn.usage 实测非零）。
  sessionOutlivesProcess = true;

  // 角色合同拼进 prompt 正文前缀（role 在前、task 在后、恰好一次，分隔符
  // ROLE_TASK_SEPARATOR）——prompt 级通道：
  // 上游无 system message 通道，这是 prompt 级引导而非系统级隔离
  // （边界声明同 M11-5 TD-89）。
  supportsRoleContract = true;

  // resume 轮不 POST /sessions 建新会话，直接向前任 session id POST prompts 续接。
  // 前任 id 的取法：task.priorProviderSessionId
  // （spawn 权威从转录取回、in-process 送达），缺失/占位（proc_<pid>）在**派发前**
  // 抛错——绝不静默开一段全新会话。
  supportsSessionReuse = true;

  // TD-250（A1/A1b，决定 0056）：终态上游会话卫生能力位。声明 true 的 backend
  // 提供 releaseSession(agent, sessionId)——控制面（RunManager 清理路径 / delivery
  // 验收路径）在门全过时 best-effort 调 serve 会话删除 API。共享编排只读此位与
  // 方法形状，不按 runtime 名分支（不变量 3）。
  supportsSessionRelease = true;

  // 在途纠偏 = 先 POST prompts 排队拿 prompt_id，再 POST prompts:steer 转入。
  // delivered（steered===true）= 已转入：2.6.3 实测当前轮被打断、无回答结束，纠偏开
  // 下一轮做完工作——运行在纠偏那一轮收口（见 streamEvents）。不对称声明：排队成功但
  // steer 失败（如 40402 无活动轮）时，上游可能仍会在后续轮执行该排队消息——
  // send_failed ≠ 一定未执行，Lead 重发前须知此不对称。
  supportsInFlightCorrection = true;

  // fresh 派发 = 新会话 + 原 prompt 重放；跨 run 上下文续接走 session 复用
  // （supportsSessionReuse），本层不承担跨 run 重放。
  replayByRespawn = true;

  // turns 端点的轮级 usage（input_other/output/input_cache_read/input_cache_creation）
  // 2.6.3 实测非零：完成时各归属轮 usage 求和 → metrics 事件（metricsEventFromTurns）；
  // tokenBudget 闸门对该 backend 生效。
  reportsTokenUsage = true;

  // 用量计量范围（TD-333，决定 0114 §3）：只累加本运行的归属轮（历史轮不含本运行的
  // prompt id）——本运行范围。kimi 的 input_other 是非缓存输入，input_cache_read 单独
  // 计量，input 不含缓存。
  usageScope = "run";
  inputIncludesCacheRead = false;

  // 消息形状（content 分段数组）中未证实退出码通道——命令退出码证据不产出。
  reportsCommandExitCode = false;

  // 决定 0086：显式声明无 OS 写沙箱（HTTP attach 家族不继承 ProcessBackend
  // 基类的默认 false）——写发生在服务器侧进程，本机调用层无沙箱面；越界写拦截
  // 按 0084（上报侦测，非阻止）。
  enforcesWriteSandbox = false;

  /**
   * 派发前的 fail-closed 策略门（M11-9 同款零副作用位置，spawn 首行再次调用）。
   * model.id 缺失必须在这里拒绝：上游缺 model 时不报错而是轮次静默秒败
   * （见文件头实测坑），绝不把静默秒败留给超时兜底。
   */
  validateAgentPolicy(agent) {
    // 空白收紧：纯空白串与缺失同罪——空白 id 直传上游就是"缺 model 静默秒败"
    // 形态（见文件头实测坑），绝不放行。
    if (typeof agent?.model?.id !== "string" || agent.model.id.trim().length === 0) {
      throw new Error(
        "kimi-web backend requires model.id (a non-blank string; upstream accepts a missing model but the turn silently fails)",
      );
    }
    // 表达面拒斥：prompts body 只认裸 model.id 字符串——providerID/variant 是
    // 带路由语义的遗留字段，kimi-web 无此表达面，配了即拒（防迁移配置的
    // 路由字段被静默丢弃后仍被当作有效配置派发）。
    if (agent?.model?.providerID !== undefined || agent?.model?.variant !== undefined) {
      throw new Error(
        "kimi-web backend cannot express model.providerID/model.variant "
        + "(the prompts body takes a bare model id string — rejected instead of silently dropping routing fields)",
      );
    }
    // reasoning.effort 直传 prompts body 的 thinking 字符串（2.4.0 实测，见文件头）。
    // 只放行 low/high/max；其余档位（含 minimal/medium/xhigh）硬拒——K3.1 Pro 只
    // 支持思考模式，关闭思考会被上游拒绝。型号与力度的搭配由服务端校验。
    if (agent?.reasoning !== undefined && agent?.reasoning !== null
      && !KIMI_WEB_THINKING_EFFORTS.includes(agent.reasoning.effort)) {
      throw new Error(
        "kimi-web backend supports reasoning.effort low, high or max only "
        + "(passed as the prompts thinking field; other efforts are rejected)",
      );
    }
    if (agent?.model?.contextWindow !== undefined) {
      throw new Error("kimi-web backend cannot express model.contextWindow");
    }
    if (typeof agent?.serveUrl !== "string" || agent.serveUrl.trim().length === 0) {
      throw new Error("kimi-web backend requires serveUrl (non-empty string)");
    }
    // 固定安全形状：只点名缺失的字段，绝不回显 env 内容（token 值永不进错误消息）。
    if (typeof agent?.tokenEnv !== "string" || agent.tokenEnv.trim().length === 0) {
      throw new Error(
        "kimi-web backend requires tokenEnv (non-empty string; the bearer token env var name)",
      );
    }
    // 决定 0074：kimiHome 可选（私有 KIMI_CODE_HOME 的绝对路径）；形状不对即拒。
    if (agent?.kimiHome !== undefined && !isValidKimiHome(agent.kimiHome)) {
      throw new Error("kimi-web backend: kimiHome must be an absolute path (no surrounding whitespace) when present");
    }
    // 决定 0075：serveWorkspaceDir 可选（worker serve 的工作目录，绝对路径）；形状不对即拒。
    if (agent?.serveWorkspaceDir !== undefined && !isValidServeWorkspaceDir(agent.serveWorkspaceDir)) {
      throw new Error("kimi-web backend: serveWorkspaceDir must be an absolute path (no surrounding whitespace) when present");
    }
  }

  // 构造零副作用（registry validate 会静态构造——backendCapabilitySnapshot 同款要求）。
  constructor({
    fetchImpl = globalThis.fetch, timeout = 30_000, retries = 2, ensureServeFn = ensureServeRunning, abortSettleMs = 500,
  } = {}) {
    if (!fetchImpl) {
      throw new Error("fetch is required");
    }
    this.fetch = fetchImpl;
    this.timeout = timeout;
    this.retries = retries;
    // 决定 0075：派发前的 serve 在场保证（注入缝——单测不起真进程）。
    this.ensureServeFn = ensureServeFn;
    // 中止后复查前的等待（见 abortActivePrompt；测试注入缝）。
    this.abortSettleMs = abortSettleMs;
  }

  async spawn(agent, task, opts = {}) {
    this.validateAgentPolicy(agent);
    // user-env 桥接值捕获（2026-10-02 坑修）：detached runner 不继承 Windows
    // user-env（setx 后长命 shell 的子进程拿不到）——runManager 的 credential
    // 桥（credentialReadiness → task.resolvedCredentials）已按 envPolicy 把
    // tokenEnv 解析进来。spawn 时捕获到 per-agent 槽，request 免 PowerShell 重读。
    bridgeBearer(agent, task?.resolvedCredentials);
    // 决定 0075：车道声明了 serveWorkspaceDir 时，serve 没在跑就先把它拉起来（resume 轮
    // 同样需要 serve 在场——会话存在主目录里，重启后的 serve 仍能续接）。拉不起来在这里抛错，
    // 派发以固定文案失败；拉起或等待过，就给 Lead 留一条说明（handle 交出后 events 的第一条；
    // 后续步骤失败则附在错误消息末尾）。
    // 会审（kimi）：畸形的续接轮（前任会话 id 缺失 / 占位）会在 spawnSession 里被拒——别先为
    // 它把 serve 拉起来。
    const malformedResume = task.sessionReuse?.turn === "resume"
      && (typeof task.priorProviderSessionId !== "string" || task.priorProviderSessionId.length === 0
        || isProcessPlaceholderSessionId(task.priorProviderSessionId));
    const serveStartNote = malformedResume ? null : await this.ensureServe(agent);
    try {
      return await this.spawnSession(agent, task, opts, serveStartNote);
    } catch (error) {
      // 拉起过 serve 而后续步骤失败：说明跟着错误走（否则 Lead 不知道这次派发留下了一个 serve）。
      if (serveStartNote !== null && error instanceof Error) error.message = `${error.message} [${serveStartNote}]`;
      throw error;
    }
  }

  // spawn 的后半段：会话（新建或续接）→ 静默门 → 提交 → handle。serve 在场保证已在 spawn 里做完。
  async spawnSession(agent, task, opts, serveStartNote) {
    let sessionId;
    if (task.sessionReuse?.turn === "resume") {
      // resume 轮实现：前任 provider session id 缺失/空/占位
      // 进程号（proc_<pid>）一律派发前拒绝——绝不静默新会话。id 语义同源：
      // 前任 run 的 session.created.backendSessionId（kimi-web 的该值就是服务器
      // 自产的 session_ id，不是进程占位）。
      const priorSessionId = task.priorProviderSessionId;
      if (typeof priorSessionId !== "string" || priorSessionId.length === 0
        || isProcessPlaceholderSessionId(priorSessionId)) {
        throw new Error(
          "kimi-web sessionReuse resume turn requires the prior provider session id "
          + "(a runtime-advertised native id — session.created.backendSessionId of the "
          + "prior run; a proc_<pid> process placeholder is not a kimi web session id) "
          + "— refusing instead of silently starting a fresh kimi web conversation",
        );
      }
      sessionId = priorSessionId;
    } else {
      sessionId = await this.createSession(agent);
    }
    // F3 提交前静默门（v7 保留）：GET detail，busy/main_turn_active 任一严格
    // true 即轮询等待，直到两者**严格 false** 才进入提交前 turns 读。
    // 消除的主暴露面：前任轮仍在跑时提交（排队/steer 语义会把新 prompt 折进
    // 前任活动轮，归属面无谓复杂化）。残余窗口（静默观测后、POST 落地前有其
    // 他 actor 提交）依赖单 actor 会话假设（WAO 独占 session，文件头已声明）。
    // 上界 = opts.silentTimeout（RunManager 的 spawn 调用恒两参——生产走默认
    // 60s；显式传入仅供需要更紧上界的调用方/测试）；到界抛固定错误
    // "session busy at dispatch"——绝不向仍在跑的会话叠提交（fail-closed，
    // 不静默排队）。
    await this.awaitSessionIdle(agent, sessionId, {
      silentTimeout: opts?.silentTimeout,
      interval: opts?.pollInterval,
    });
    // 角色合同 = prompt 正文前缀（role 在前、task 在后），恰好注入一次；有
    // roleContract 时以 ROLE_TASK_SEPARATOR 衔接。
    const prompt = task.roleContract
      ? `${task.roleContract}${ROLE_TASK_SEPARATOR}${task.prompt}`
      : task.prompt;
    // 提交前读一次 turns（最新一页）：当时最大的 ordinal 作翻页边界（没有轮为 -1）。
    // 事件流每拍从最新页往回翻到这条边界为止；resume 轮的历史轮同样只作边界，归属只看
    // prompt id——历史轮不含本运行的 id，按构造不会被误领或重放。
    const boundaryOrdinal = latestOrdinal(await this.turnsPage(agent, sessionId, null));
    const admitted = await this.sendPrompt(agent, sessionId, prompt);
    // 运行的提示集合（sendCorrection 与事件流共用）。回执缺 prompt_id（上游违约）不发明
    // 归属：派发记在永不匹配的键下，由 silentTimeout / 无进展出口有界收口。回执状态
    // blocked/failed 由事件流在首拍之前直接收口（不轮询）。
    const runPrompts = createRunPrompts({
      promptId: typeof admitted?.prompt_id === "string" && admitted.prompt_id.length > 0 ? admitted.prompt_id : null,
      status: admitted?.status,
      boundaryOrdinal,
    });
    const cwd = agent.cwd;
    // 决定 0074 会审（sol）：本次运行实际使用的 bearer 进入转录的精确值脱敏——主目录
    // 文件里的 token 不在进程环境里，按环境名构造的缺省脱敏器认不出它；经 user-env 桥
    // 解析到的环境 token 同理。请求错误出口另有 redactToken，这里管的是成功路径上
    // worker 输出里出现该值的情形。
    const runRedactor = createSecretRedactor(
      { ...process.env, WAO_KIMI_SERVER_TOKEN: resolveBearerToken(agent) },
      ["WAO_KIMI_SERVER_TOKEN"],
    );
    return {
      backend: "kimi-web",
      backendSessionId: sessionId,
      serveUrl: agent.serveUrl,
      cwd,
      redact: (value) => runRedactor.redact(value),
      // events 工厂：RunManager 传 signal（仅作 abort 静默退出——终态判定不依赖
      // 它，事件流自身的有界性由 silentTimeout 家族 + 无进展出口保证）、
      // pollInterval / silentTimeout 控制轮询（轮询与判定的职责划分同 streamEvents 惯例）；
      // correctable run 另传 onPollTick（排队纠偏的投递钩子——缺了它 correctable
      // run 的纠偏永远不被投递，消费侧见 runManager._pollCorrections），原样
      // 透传给 streamEvents 每轮轮询调用一次。
      events: (signal, opts) => this.streamEvents(agent, sessionId, {
        signal,
        interval: opts?.pollInterval,
        silentTimeout: opts?.silentTimeout,
        onPollTick: opts?.onPollTick,
        runPrompts,
        // TD-197① test seam: injectable monotonic clock for the stall budget.
        stallClock: opts?.stallClock,
        serveStartNote,
      }),
      // 停止面（abort / session / messages / sessionStatus）与 wao stop 共用同一实现。
      ...this.stopTarget(agent, sessionId),
      // M12-16 handle 级纠偏钩子（runManager provider 中立消费，见 _pollCorrections）。
      sendCorrection: (text) => this.sendCorrection(agent, sessionId, text, runPrompts),
    };
  }

  /**
   * 一个会话的停止面：handle 与 wao stop / run_stop（经 factory 的服务端中止选择）
   * 共用。调用形状对齐 serveStopVerify 的消费者：
   *   - abort：中止排队与活动的 prompt（见文件头停止杠杆声明）；成功后会话不忙，停止
   *     验证经 sessionStatus 观察到停下。绝不调 POST /api/v1/shutdown（服务器级，会杀
   *     共享服务器上的无关会话）。幂等：同一目标二次调用复用首次结果（含首次的拒绝）。
   *   - session / messages / sessionStatus：停止探针。实际调用形状是
   *     (serveUrl, sessionId, {cwd})——形参忽略，会话身份用这里的 agent+sessionId。
   *     messages 返回 {data} 页形状（sample 读 page?.data 计数）；sessionStatus 是 GET
   *     会话详情的 busy 投影，形状为 {type:"busy"|
   *     "idle"}；无 retry 形状，绝不虚构，也绝不 else-推断-idle；R9 F1：detail 在场但
   *     双字段任一非布尔 → **busy** 保守投影）。detail 不可得时底层 sessionStatus()
   *     返回 null，这里把 null 转成抛错——isKnownStatus(null)===true，直接交出 null 会
   *     让验证器在同轮 session/messages 读得到时虚记 stop_verified；抛错才记为不可观察。
   * 鉴权 token 由 agent 解析（tokenEnv / kimiHome，见 resolveBearerToken）；进程外的停止
   * 没有派发时的桥接值，调用方经 resolvedCredentials 传入同一条 user-env 桥的结果。
   * token 在建目标时就解析：取不到即抛（resolveBearerToken 的固定文案），不留到中止时。
   */
  stopTarget(agent, sessionId, { resolvedCredentials } = {}) {
    bridgeBearer(agent, resolvedCredentials);
    resolveBearerToken(agent);
    let abortPromise = null;
    return {
      abort: () => {
        abortPromise ??= this.abortActivePrompt(agent, sessionId);
        return abortPromise;
      },
      session: (_serveUrl, _sessionId, _probeOpts) => this.sessionDetail(agent, sessionId),
      messages: async (_serveUrl, _sessionId, _probeOpts) => ({
        data: await this.messages(agent, sessionId),
      }),
      // 状态读不到（null）时抛错：停止验证器才会把这一轮记为不可观察，而不是已知非活跃。
      sessionStatus: async (_serveUrl, _sessionId, _probeOpts) => {
        const status = await this.sessionStatus(agent, sessionId);
        if (status === null) throw new Error("kimi-web session status unavailable");
        return status;
      },
    };
  }

  /**
   * F3 提交前静默门（v7）：轮询 GET 会话详情，直到 busy/main_turn_active 两者
   * **严格 false** 才放行提交前快照。任一严格 true 即等待；非布尔形状 ≠ idle
   * （A3 纪律——形状未知绝不推断静止，同样等待）。有界：silentTimeout（传入值
   * 或默认 60s）到界抛固定错误 "session busy at dispatch"。detail 请求失败 /
   * 形状不符（A4 在场门）原样上抛（fail-closed，不吞、不猜）。
   */
  /**
   * 决定 0075：派发前的 serve 在场保证。车道没声明 serveWorkspaceDir → 不做任何事（null）。
   * 声明了 → 交给 ensureServeRunning：serve 有应答即返回 null；连接被拒则拉起（或等别的
   * 运行拉起），返回给 Lead 看的一句说明。拉不起来的错误原样上抛。
   */
  async ensureServe(agent) {
    if (typeof agent?.serveWorkspaceDir !== "string") return null;
    const result = await this.ensureServeFn({
      serveUrl: agent.serveUrl,
      token: resolveBearerToken(agent),
      workspaceDir: agent.serveWorkspaceDir,
      kimiHome: agent.kimiHome ?? null,
      fetchImpl: this.fetch,
      startWatchFn: startServeIdleWatch,
    });
    if (!result) return null;
    const seconds = Math.round((Number(result.waitedMs) || 0) / 1000);
    // 说明里只写端口，不写 serveUrl 原文（配置里的 URL 不保证不带别的东西）。
    let port = "unknown";
    try { port = new URL(agent.serveUrl).port || "unknown"; } catch { /* 形状不对的 URL 走不到这里 */ }
    const displaced = result.displaced;
    // 空闲看护的结果（决定 0079：WAO 拉起的 serve 空闲自己退出）。只有本
    // 次派发自己拉起的 serve 才带看护结果；起来了写 pid 与阈值，没起来如实写。
    const watch = result.idleWatch;
    const watchNote = !watch ? ""
      : watch.started
        ? `; an idle watcher (pid ${watch.pid ?? "unknown"}) will ask it to exit after ${Math.round(IDLE_WATCH_IDLE_THRESHOLD_MS / 60_000)} idle minutes`
        : "; the idle watcher could not be started — the serve keeps running until stopped by hand";
    const what = displaced
      // 目标端口在拉起期间被别人占了：kimi 不退出而是改绑别的端口——那一个已被请走（或请不动）。
      ? `a serve this dispatch started (pid ${displaced.pid}) landed on port ${displaced.port} because port ${port} was taken meanwhile; `
        + (displaced.shutdown === "requested" ? "it was asked to exit" : "asking it to exit failed — stop it by hand")
      : result.started
        ? `started it (pid ${result.pid ?? "unknown"}; the lane declares serveWorkspaceDir)${watchNote}`
        : "it was started by another process (another dispatch or a recycle)";
    const outcome = result.answer === "ok"
      ? `answering after ${seconds} s`
      : `after ${seconds} s the port answers but not with success for this lane's token — the request that follows reports the reason`;
    return `kimi-web backend: the worker serve on port ${port} was not running; ${what}; ${outcome}`;
  }

  async awaitSessionIdle(agent, sessionId, { silentTimeout = 60_000, interval = 1000 } = {}) {
    const deadline = Date.now() + silentTimeout;
    for (;;) {
      const detail = await this.sessionDetail(agent, sessionId);
      if (detail?.busy === false && detail?.main_turn_active === false) {
        return detail;
      }
      if (Date.now() > deadline) {
        throw new Error(
          "session busy at dispatch: busy/main_turn_active still not strictly false "
          + `within ${silentTimeout}ms (pre-submit silent gate — refusing to submit `
          + "over a still-running turn)",
        );
      }
      await sleep(interval);
    }
  }

  async createSession(agent) {
    // metadata.cwd 必填（缺则 40001，实测坑）——用 agent.cwd 填。
    const response = await this.request(
      agent,
      `${trimSlash(agent.serveUrl)}/api/v1/sessions`,
      {
        method: "POST",
        body: JSON.stringify({ title: "wao", metadata: { cwd: agent.cwd } }),
      },
    );
    return response?.data?.id;
  }

  async sendPrompt(agent, sessionId, text) {
    // 两个实测坑的承载：content 必须是分段数组（裸字符串 40001）；model 必填
    // （缺 model 接口返 success/running 但轮次静默秒败——validateAgentPolicy 已在
    // 派发前拒绝无 model.id 的配置，这里原样直传 agent.model.id）。
    const response = await this.request(
      agent,
      `${trimSlash(agent.serveUrl)}/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`,
      {
        method: "POST",
        body: JSON.stringify({
          content: [{ type: "text", text }],
          model: agent.model.id,
          // 上游默认 permission="manual"：工具调用需人工审批，WAO worker 无人审批，
          // 要写文件/跑命令的 turn 会永久挂起——恒发 "auto"（枚举闭集 manual|yolo|auto），
          // 与其它 worker 席位 --dangerously-skip-permissions 的姿态对齐。证据：2026-10-01 coder_mm delta 认证 scorecard 失败（turn stalled 8 拍，runs/reliability 日志）。
          permission_mode: "auto",
          // 配了力度才带 thinking（车道声明或 --reasoning 覆盖，覆盖由 RunManager 合成进
          // agent.reasoning）；没配不发这个字段，由服务端用默认值。
          ...(typeof agent.reasoning?.effort === "string" ? { thinking: agent.reasoning.effort } : {}),
        }),
      },
    );
    return response?.data;
  }

  /**
   * 中止会话正在跑和排队的 prompt：GET prompts，先对 queued 里的每一条、再对 active
   * POST …/prompts/{promptId}:abort（只停活动的，排队那条会立刻接着跑）。然后稍等
   * （abortSettleMs）再读 prompts 与会话详情——2.6 中止活动轮不清已转入、还没开轮的
   * 纠偏，它会在中止后自己开一轮。又出现活动 / 排队的 prompt，或 main_turn_active 不是
   * false → 再中止一轮，最多 ABORT_ROUNDS 轮，仍停不下按 "abort not acknowledged" 失败。
   * 单条 :abort 未获确认（40402 已停等竞态）不单独判，以复查看到的实际状态为准。会话
   * 已不存在（40401）视为已停。其余上游拒绝、传输失败或列表畸形 → 固定文案错误（不回显
   * 上游原文、token 或 URL）。绝不调服务器级 /api/v1/shutdown。
   */
  async abortActivePrompt(agent, sessionId) {
    const base = `${trimSlash(agent.serveUrl)}/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`;
    try {
      let listed = await this.promptsList(agent, sessionId);
      for (let round = 1; ; round += 1) {
        // 排队的先停：只停活动的，排队那条在 200 ms 内就成为新的活动轮（2.4.0 实测）。
        for (const entry of [...listed.queued, ...(listed.active === null ? [] : [listed.active])]) {
          try {
            await this.request(agent, `${base}/${encodeURIComponent(entry.promptId)}:abort`, {
              method: "POST",
              body: JSON.stringify({}),
            });
          } catch { /* 未获确认：由下面的复查定 */ }
        }
        await sleep(this.abortSettleMs);
        listed = await this.promptsList(agent, sessionId);
        const detail = await this.sessionDetail(agent, sessionId);
        if (listed.active === null && listed.queued.length === 0 && detail.main_turn_active === false) return;
        if (round >= ABORT_ROUNDS) throw new Error("abort not acknowledged");
      }
    } catch (error) {
      if (error?.waoCode === KIMI_SESSION_GONE_CODE) return;
      throw new Error(
        "kimi-web abort failed: the server did not confirm aborting the active prompt "
        + "(upstream rejected the request, the request failed or timed out, the prompts list was malformed, "
        + `or a prompt was still running after ${ABORT_ROUNDS} abort rounds)`,
      );
    }
  }

  /**
   * GET prompts → {active, queued, statusById}（条目归一为 {promptId, status}）。形状门
   * （fail-closed，事件流与中止面共用）：缺 active 或 queued、queued 不是数组、条目不是
   * 带非空 prompt_id 的对象 ⇒ 抛固定错误——不可观察绝不当成"没有排队"。
   */
  async promptsList(agent, sessionId) {
    const response = await this.request(
      agent,
      `${trimSlash(agent.serveUrl)}/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`,
      { method: "GET" },
    );
    const data = response?.data;
    const entryOf = (value) => (value && typeof value === "object"
      && typeof value.prompt_id === "string" && value.prompt_id.length > 0
      ? { promptId: value.prompt_id, status: value.status }
      : null);
    if (data && typeof data === "object" && "active" in data && Array.isArray(data.queued)) {
      const active = data.active === null ? null : entryOf(data.active);
      const queued = data.queued.map(entryOf);
      if ((data.active === null || active !== null) && !queued.includes(null)) {
        const entries = active === null ? queued : [...queued, active];
        return { active, queued, statusById: new Map(entries.map((entry) => [entry.promptId, entry.status])) };
      }
    }
    throw new Error(
      "kimi web prompts list malformed (data.active and a data.queued array, entries with prompt_id, are required — refusing to guess)",
    );
  }

  /**
   * 在途纠偏（supportsInFlightCorrection 的实现）：POST prompts 排队拿 prompt_id →
   * POST prompts:steer 转入活动轮。steered===true → {ok:true}；任何失败（HTTP 错 /
   * code!==0 / 40402 无活动轮 / 回执 blocked|failed）→ {ok:false, reason:"send_failed"}
   * （M12-16 闭集 reason）。有界拒绝：错误细节不透传（token 值绝不进消息）。
   * 运行级记账（runPrompts，spawn 建、事件流共用）：POST prompts 被接纳（有 prompt_id、
   * 回执状态不是 blocked/failed）即记"已接纳"，不论随后 steer 成败——steer 失败的那条
   * 仍可能在之后的轮里执行（send_failed ≠ 一定未执行，Lead 重发前须知此不对称）；steer
   * 回 steered:true 再记"已转入"与转入时刻。
   */
  async sendCorrection(agent, sessionId, text, runPrompts = null) {
    if (typeof text !== "string" || text.length === 0) {
      return { ok: false, reason: "send_failed" };
    }
    try {
      const queued = await this.sendPrompt(agent, sessionId, text);
      const promptId = queued?.prompt_id;
      if (typeof promptId !== "string" || promptId.length === 0 || PROMPT_FAILED_STATUSES.has(queued?.status)) {
        return { ok: false, reason: "send_failed" };
      }
      const accepted = { kind: "correction", submittedAt: Date.now(), steeredAt: null, waitPolls: 0, notExecuted: false };
      runPrompts?.prompts.set(promptId, accepted);
      const steered = await this.request(
        agent,
        `${trimSlash(agent.serveUrl)}/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts:steer`,
        {
          method: "POST",
          body: JSON.stringify({ prompt_ids: [promptId] }),
        },
      );
      if (steered?.data?.steered !== true) return { ok: false, reason: "send_failed" };
      accepted.steeredAt = Date.now();
      return { ok: true };
    } catch {
      return { ok: false, reason: "send_failed" };
    }
  }


  /**
   * GET messages（仅供停止验证消费者——handle.messages 按 serveStopVerify.sample 的
   * 页形状返回；本端点不参与任何完成判定）。A4（缺数据虚报停止）：缺 items
   * 数组 ⇒ 抛固定错误（fail-closed，绝不回落 []——空数组会被消费者当成"会话
   * 真的没有消息"的健康观测，虚报停止面）。
   */
  async messages(agent, sessionId) {
    const response = await this.request(
      agent,
      `${trimSlash(agent.serveUrl)}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { method: "GET" },
    );
    if (!Array.isArray(response?.data?.items)) {
      throw new Error(
        "kimi web messages response malformed (data.items array is required — refusing to guess)",
      );
    }
    return response.data.items;
  }

  /**
   * GET turns 一页（2.6.3，形状见文件头）：beforeOrdinal 为 null 取最新一页。形状门
   * （fail-closed）：data.turns 须是数组、has_more 须是布尔、每个轮须有非空 turn_id 与
   * 整数 ordinal ⇒ 否则抛固定错误（回落 [] 会把"不可观察"当成"没有轮"）。
   */
  async turnsPage(agent, sessionId, beforeOrdinal) {
    const query = beforeOrdinal === null ? "" : `?before_ordinal=${beforeOrdinal}`;
    const response = await this.request(
      agent,
      `${trimSlash(agent.serveUrl)}/api/v1/sessions/${encodeURIComponent(sessionId)}/agents/${TURNS_AGENT}/turns${query}`,
      { method: "GET" },
    );
    const data = response?.data;
    if (!data || typeof data !== "object" || !Array.isArray(data.turns) || typeof data.has_more !== "boolean"
      || !data.turns.every((turn) => typeof turn?.turn_id === "string" && turn.turn_id.length > 0
        && Number.isInteger(turn.ordinal))) {
      throw new Error(
        "kimi web turns response malformed (data.turns entries with turn_id and an integer ordinal, "
        + "and a boolean data.has_more, are required — refusing to guess)",
      );
    }
    return data;
  }

  /**
   * 本运行可能涉及的全部轮：从最新页往回翻（before_ordinal = 本页最早轮的 ordinal），
   * 直到本页最早的轮 ordinal ≤ 提交前边界或 has_more:false；按 turn_id 去重、按 ordinal
   * 升序返回。翻不到边界（has_more 却给空页、往回翻没有前进）⇒ 抛错——不完整的轮不能
   * 当成整个运行的事实（调用方按观测失败收口）。
   */
  async collectTurns(agent, sessionId, boundaryOrdinal) {
    const byId = new Map();
    let before = null;
    for (;;) {
      const page = await this.turnsPage(agent, sessionId, before);
      for (const turn of page.turns) {
        if (!byId.has(turn.turn_id)) byId.set(turn.turn_id, turn);
      }
      if (!page.has_more) break;
      const earliest = Math.min(...page.turns.map((turn) => turn.ordinal));
      if (earliest <= boundaryOrdinal) break;
      if (!Number.isFinite(earliest) || (before !== null && earliest >= before)) {
        throw new Error(
          "kimi web turns paging incomplete (has_more:true but no older turns before the boundary — refusing to judge on a partial page set)",
        );
      }
      before = earliest;
    }
    return [...byId.values()].sort((a, b) => a.ordinal - b.ordinal);
  }


  /**
   * GET 会话详情（A4 fail-closed 门）：响应缺 id 或 busy/main_turn_active 字段
   * 缺席 ⇒ 抛固定错误，绝不回落 {}——{} 会让下游把"不可观察"当成宽松的
   * idle/unknown 形状（缺数据虚报停止面）。字段**在场但非布尔**的值原样透传：
   * 值级严格性归状态机/sessionStatus（A3——非布尔视为未知，绝不推断 idle）。
   * 两层分工：在场性是结构契约（这里硬拒）；值形状是观测语义（严格相等判定）。
   */
  async sessionDetail(agent, sessionId) {
    const response = await this.request(
      agent,
      `${trimSlash(agent.serveUrl)}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      { method: "GET" },
    );
    const data = response?.data;
    if (!data || typeof data !== "object"
      || typeof data.id !== "string" || data.id.length === 0
      || data.busy === undefined || data.main_turn_active === undefined) {
      throw new Error(
        "kimi web session detail malformed "
        + "(data.id and data.busy/data.main_turn_active are required — refusing to guess)",
      );
    }
    return data;
  }

  /**
   * 停止验证的 busy 投影（handle.sessionStatus 的实现，#1/A4）：GET 会话详情的
   * busy/main_turn_active 双字段投影为 {type:"busy"|"idle"}——返回形状对齐
   * 会话状态探针（其 statuses[sessionId] 值即该形状；kimi-web
   * 无 retry 形状，绝不虚构）。A4：detail 不可得（任何错误——HTTP/信封/在场门）
   * ⇒ 返回 **null**（消费者把"观测不可得"如实记 stop_unverified，与下面的形状
   * 投影分工不同）。**R9 F1**：detail 在场（在场门已过）但任一字段非布尔 ⇒
   * 返回 **{type:"busy"}**（保守投影）——事实依据：消费者 serveStopVerify 的
   * isKnownStatus(null) === true（src/backends/serveStopVerify.js，只读
   * 参照），null 会被当成"已知且非活跃"，session/messages 零增长时 verifyStopQuiet
   * 判 quiet:true ⇒ 不可观察被虚记 run.stop_verified。宁可虚报忙、绝不虚报停止
   * （与下方 F5 true 腿同款取舍）。HTTP 500/请求失败腿本方法返回 null；停止面
   * （stopTarget）再把 null 转成抛错——验证器只把抛错记为不可观察，单个 null 在
   * 同轮 session/messages 读得到时仍算已知非活跃（状态读 500、详情读 busy、消息
   * 不增长 → 虚记 stop_verified）。
   */
  async sessionStatus(agent, sessionId) {
    let detail;
    try {
      detail = await this.sessionDetail(agent, sessionId);
    } catch {
      // detail 不可得（HTTP 500 / 请求失败 / 在场门不符）→ null（不是 idle：
      // 观测不到 ≠ 会话静止；这条腿的消费者行为 = stop_unverified，保持）。
      return null;
    }
    if (detail?.busy === true || detail?.main_turn_active === true) {
      // F5（v7 裁定，现状文档化）：混合布尔形状（一字段严格 true、另一字段非
      // 布尔）在此返回 busy——保守偏差：宁可虚报忙、不虚报闲（idle 会喂养
      // 停止验证的 quiet 判定），绝不虚报 stop_verified。
      return { type: "busy" };
    }
    if (detail?.busy === false && detail?.main_turn_active === false) {
      return { type: "idle" };
    }
    // R9 F1：任一字段非布尔（detail 在场、在场门已过，值形状不符）→ busy 保守
    // 投影，绝不 null（isKnownStatus(null)===true 会把不可观察虚记 stop_verified，
    // 见方法注释的事实依据），也绝不 else-推断-idle。
    return { type: "busy" };
  }

  /**
   * TD-250（A1/A1b，决定 0056）：终态上游会话卫生。best-effort 调
   * `POST /api/v1/sessions/{id}:delete`（API 事实见文件头 TD-250 节）。**声明：
   * 这不拆任何进程**——kimi 2.1.1 serve 永不回收每会话助手进程组（删除/归档均
   * 不触发、无空闲 GC），进程面归 serve 回收配方（docs/usage/lanes.md）；本方法只治会话仓
   * 与 serve events 文件的堆积。
   *
   * 语义（闭集结果，载荷绝不含 token/上游回显文本）：
   *   - 删前探针一次（非 sessionStatus——它把 40401 已亡折叠成 null 不可观，
   *     这里必须区分）：GET detail code 40401 → {outcome:"already_gone"}；
   *     busy/main_turn_active 任一严格 true，或值形状非严格布尔（sessionStatus
   *     F5/R9 F1 同款保守折叠——宁可当忙、不当闲）→ {outcome:"skipped_busy"}
   *     （纠偏排队-未 steer 的不对称：上游可能另开轮消费，idle 是删除的必要
   *     非充分条件，busy 是充分拒绝条件）。
   *   - POST :delete：code 0 → {outcome:"deleted"}；40401 → already_gone；其他
   *     code → {outcome:"failed", reason:"upstream_rejected", code}。
   *   - 传输层失败/超时 → failed(http_error|timeout)；参数形状不符 →
   *     failed(bad_request)。
   * 本方法绝不抛错、绝不重试（POST 非幂等，每 run 恰一枪；调用方清理路径
   * 吞错，但结构化结果直接可消费）。
   */
  async releaseSession(agent, sessionId) {
    if (typeof agent?.serveUrl !== "string" || agent.serveUrl.trim().length === 0
      || typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return { outcome: "failed", reason: "bad_request" };
    }
    let token;
    try {
      token = resolveBearerToken(agent);
    } catch {
      return { outcome: "failed", reason: "bad_request" };
    }
    // 原始一枪请求：不复用 request()（它在 code!==0 时抛含 msg 的错误——release
    // 需要原始 code 数值做闭集分派，且绝不回显 msg）。永不重试；超时经
    // AbortController 有界。正文只取 code/data 字段，其余丢弃（脱敏面最小化）。
    const rawJson = async (method, path, body) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        const response = await this.fetch(`${trimSlash(agent.serveUrl)}${path}`, {
          method,
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const text = await response.text();
        let parsed = null;
        if (text.length > 0) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
        }
        return { httpStatus: response.status, code: parsed?.code, data: parsed?.data };
      } catch (error) {
        if (error?.name === "AbortError") return { aborted: true };
        return { transportError: true };
      } finally {
        clearTimeout(timer);
      }
    };
    const enc = encodeURIComponent(sessionId);
    const detail = await rawJson("GET", `/api/v1/sessions/${enc}`);
    if (detail.aborted) return { outcome: "failed", reason: "timeout" };
    if (detail.transportError) return { outcome: "failed", reason: "http_error" };
    if (detail.code === KIMI_SESSION_GONE_CODE) return { outcome: "already_gone" };
    if (detail.code !== 0 || !detail.data || typeof detail.data !== "object") {
      return { outcome: "failed", reason: "upstream_rejected", ...(Number.isInteger(detail.code) ? { code: detail.code } : {}) };
    }
    if (detail.data.busy !== false || detail.data.main_turn_active !== false) {
      // 严格 false 双证才放行：任一 true、任一非布尔（保守折叠）、字段缺席
      // （sessionDetail 在场门的宽松版——缺席同样当忙）都拒绝删除。
      return { outcome: "skipped_busy" };
    }
    const del = await rawJson("POST", `/api/v1/sessions/${enc}:delete`, {});
    if (del.aborted) return { outcome: "failed", reason: "timeout" };
    if (del.transportError) return { outcome: "failed", reason: "http_error" };
    if (del.code === KIMI_SESSION_GONE_CODE) return { outcome: "already_gone" };
    if (del.code === 0) return { outcome: "deleted" };
    return { outcome: "failed", reason: "upstream_rejected", ...(Number.isInteger(del.code) ? { code: del.code } : {}) };
  }

  /**
   * 轮询生成器（完成/失败/超时判定归这里；signal 只作 abort 静默退出）。每拍：先跑
   * onPollTick（纠偏投递钩子，best-effort——抛错绝不杀流），再读 GET prompts、再翻
   * turns（先看队列再看轮：prompt 从队列走进轮，这个次序不会两头都错过它）。
   *
   *   - 归属：轮的任一 user_message.prompt_ids 含运行提示集合里的 id；最终轮 = 归属
   *     轮里 ordinal 最大的。
   *   - 结算（每个 id）：出现在归属轮里 = 已结算；prompts 列表报 blocked/failed ⇒
   *     done(failed) 写明哪条、什么状态。其余各按自己的计时原点等，上界 =
   *     silentTimeout（缺席时连续 SHAPE_DRIFT_POLL_LIMIT 拍）：
   *       · 派发：原点 = 提交时刻；到界仍不在任何轮里 ⇒ silent timeout 失败。
   *       · 已转入的纠偏：原点 = 转入时刻；prompts 里看不到它也算未结算；到界 ⇒
   *         失败（转入了但没有轮执行它）。
   *       · 只接纳（steer 失败）的纠偏：原点 = 它自己的提交时刻，只在它既不在轮里
   *         也不在 active/queued 时计；到界 ⇒ 按"未执行"结算并发一条 system 消息，
   *         之后若出现在某轮里照常归属。
   *   - 收口：全部结算、最终轮 status "ended"、集合里没有 id 还在 active/queued ⇒
   *     按 outcome：completed → 最终轮的 assistant_message 拼成答案（空 ⇒ failed，
   *     绝不伪造完成），先补齐全部归属轮的工具证据，再发 user echo（第一个归属轮的
   *     开场 user_message）、答案、metrics（各归属轮 usage 之和）、done(completed)；
   *     interrupted ⇒ failed（end_reason）；failed ⇒ failed（error）。来自响应体的
   *     诊断文字一律过 redactToken。
   *   - 闭集外的 status / outcome ⇒ 一律非终态，最终轮连续 SHAPE_DRIFT_POLL_LIMIT 拍
   *     仍闭集外 ⇒ done(failed, "unsupported turn state")（增长不清零该计数）。
   *   - 等待中：各归属轮的工具调用在途落证据（决定 0071/0072）；停滞门看最终轮的签名
   *     （换了最终轮算一次进展，产出量最高水位与证词累计按新轮重建）。
   *   - 读失败 / 形状不符 / 翻页不完整 ⇒ done(failed, 错误消息)；signal.aborted ⇒
   *     静默 return（终态归 RunManager）。
   */
  async *streamEvents(agent, sessionId, {
    signal, interval = 1000, silentTimeout, onPollTick, runPrompts, stallClock, serveStartNote,
  } = {}) {
    // 决定 0075：本次派发拉起过（或等过）worker serve——告诉 Lead。
    if (typeof serveStartNote === "string" && serveStartNote.length > 0) {
      yield messageEvent("system", [{ type: "text", text: serveStartNote }]);
    }
    // 直调防御形状（没有 spawn 建的集合）：派发记在永不匹配的键下，由有界出口收口。
    const run = runPrompts ?? createRunPrompts();
    // 响应体里的文字（error、end_reason、状态值）走的是 HTTP 200 成功路径，不经
    // request() 的 sanitizeError 出口——拼装后过同一 redactToken。token 取不到时清洗
    // 退化为无操作（能走到读请求必然取得到，缺席只是防御形状）。
    let tokenValue = null;
    try { tokenValue = resolveBearerToken(agent); } catch { /* 清洗退化为无操作 */ }
    const redact = (text) => redactToken(text, tokenValue);
    if (PROMPT_FAILED_STATUSES.has(run.dispatchStatus)) {
      yield doneEvent("failed", redact(
        `kimi prompt ${run.dispatchId ?? "(no prompt_id)"} was ${run.dispatchStatus} at submission (the serve will not run it)`,
      ));
      return;
    }
    // TD-197①：无进展停滞门的时间化（shared stallBudget 纯算法，单调钟；
    // stallClock 为测试注入缝，缺省 performance.now()）。
    const stallTracker = createStallTracker({
      floorMs: NO_PROGRESS_FLOOR_MS,
      ceilingMs: NO_PROGRESS_CEILING_MS,
      factor: NO_PROGRESS_FACTOR,
      ...(typeof stallClock === "function" ? { now: stallClock } : {}),
    });
    let attestedSilentMs = 0;
    let livenessAttestations = 0;
    // 最终轮已见过的产出量最高水位（硬顶清零的判据，见常量注释）。
    let volumeHighWater = -1;
    let finalTurnId = null;
    let lastSignature = null;
    // 在途进度呈现：最终轮签名变化即节流发射 runtime_activity("streaming")（闭集状态、
    // 零 payload、不算证据、不碰完成路径）。
    let lastProgressEmitAt = -Infinity;
    // 闭集外 status/outcome 的连续拍数（最终轮回到闭集内或不在场即清零；增长不清零）。
    let unsupportedStatePolls = 0;
    // 决定 0071：工具调用证据的台账（item_id → 已落的部分），跨最终轮切换保留。
    const toolLedger = new Map();
    while (!signal?.aborted) {
      if (typeof onPollTick === "function") {
        try { await onPollTick(); } catch { /* best-effort: never kill the event stream */ }
      }
      let listed;
      let turns;
      try {
        listed = await this.promptsList(agent, sessionId);
        turns = await this.collectTurns(agent, sessionId, run.boundaryOrdinal);
      } catch (error) {
        yield doneEvent("failed", errorText(error));
        return;
      }
      const attributed = turns.filter((turn) => turnPromptIds(turn).some((id) => run.prompts.has(id)));
      const seen = new Set(attributed.flatMap(turnPromptIds));
      // 结算：每个 id 各按自己的原点计（初次派发的原点绝不用于纠偏）。
      let pending = false;
      for (const [id, entry] of run.prompts) {
        if (seen.has(id) || entry.notExecuted) continue;
        const listedStatus = listed.statusById.get(id);
        if (PROMPT_FAILED_STATUSES.has(listedStatus)) {
          yield doneEvent("failed", redact(
            `kimi prompt ${String(id)} (${entry.kind}) is ${listedStatus} in the serve's prompts list (it will not run)`,
          ));
          return;
        }
        // 只接纳的纠偏还在 active/queued 里：服务端还拿着它，不计时。
        if (entry.kind === "correction" && entry.steeredAt === null && listedStatus !== undefined) {
          pending = true;
          continue;
        }
        entry.waitPolls += 1;
        const origin = entry.steeredAt ?? entry.submittedAt;
        const expired = silentTimeout
          ? Date.now() - origin > silentTimeout
          : entry.waitPolls >= SHAPE_DRIFT_POLL_LIMIT;
        if (!expired) {
          pending = true;
          continue;
        }
        const bound = silentTimeout
          ? `${silentTimeout}ms`
          : `${SHAPE_DRIFT_POLL_LIMIT} consecutive polls (silentTimeout absent)`;
        if (entry.kind === "dispatch") {
          yield doneEvent("failed", silentTimeout
            ? `silent timeout: turn for this prompt not observed within ${silentTimeout}ms (provider may have silently rejected)`
            : `turn stalled (no progress): turn not observed for ${SHAPE_DRIFT_POLL_LIMIT} consecutive polls (bounded exit, silentTimeout absent)`);
          return;
        }
        if (entry.steeredAt !== null) {
          yield doneEvent(
            "failed",
            `kimi-web backend: correction prompt ${String(id)} was steered into the session but no turn ran it within ${bound} of the steer`,
          );
          return;
        }
        entry.notExecuted = true;
        yield messageEvent("system", [{
          type: "text",
          text: `kimi-web backend: correction prompt ${String(id)} was not executed — its steer had failed and `
            + `${bound} after its submission it is in no turn of this run and no longer active or queued`,
        }]);
      }
      const final = attributed.at(-1) ?? null;
      if (final === null) {
        // 还没有归属轮：派发的上界由上面的结算出口管。
        unsupportedStatePolls = 0;
        await sleep(interval);
        continue;
      }
      const supported = final.status === "running"
        || (final.status === "ended" && TURN_OUTCOMES.has(final.outcome));
      if (!supported) {
        unsupportedStatePolls += 1;
        if (unsupportedStatePolls >= SHAPE_DRIFT_POLL_LIMIT) {
          yield doneEvent("failed", redact(
            `unsupported turn state: status=${String(final.status)} outcome=${String(final.outcome)} `
            + "(outside the supported closed set running | ended with completed|interrupted|failed — bounded exit after "
            + `${SHAPE_DRIFT_POLL_LIMIT} consecutive polls; growth does not extend this bound because the client already `
            + "knows this state is unsupported)",
          ));
          return;
        }
        await sleep(interval);
        continue;
      }
      unsupportedStatePolls = 0;
      const ourPromptListed = [...run.prompts.keys()].some((id) => listed.statusById.has(id));
      if (final.status === "ended" && !pending && !ourPromptListed) {
        if (final.outcome !== "completed") {
          yield doneEvent("failed", redact(turnFailureText(final)));
          return;
        }
        const text = answerOfTurn(final);
        if (text.trim().length === 0) {
          // N1 教训：传输成功不是可用答案——completed 轮没有回答按 failed 收口。这里不
          // 补发证据（在途已落的命令 / 工具调用留着；写文件证据只在成功路径落）。
          yield doneEvent(
            "failed",
            "kimi turn completed without assistant text (outcome=completed, no assistant_message text — refusing to fabricate completion)",
          );
          return;
        }
        // 证据先行：全部归属轮（纠偏会让工作跨轮）还没落过的工具证据在这里补齐。
        for (const turn of attributed) {
          for (const ev of projectKimiToolCalls(turn, toolLedger, { final: true })) yield ev;
        }
        const echo = openerText(attributed[0]);
        if (echo !== null) yield messageEvent("user", [{ type: "text", text: echo }]);
        yield messageEvent("assistant", [{ type: "text", text }]);
        const metrics = metricsEventFromTurns(attributed);
        if (metrics !== null) yield metrics;
        yield doneEvent("completed");
        return;
      }
      // 决定 0071：在途的工具调用就绪即落证据（命令 / 工具调用在输入就绪时，结果在
      // 条目 ended 时）；写文件类只预告路径（决定 0072）。
      for (const turn of attributed) {
        for (const ev of projectKimiToolCalls(turn, toolLedger)) yield ev;
      }
      // 无进展停滞门（TD-197① 观测自适应时间门）：最终轮签名变化 / 换了最终轮 = 进度；
      // 静默段 ≥ budgetMs → 先取 serve 证词。budget = min(240s, max(60s, 3 × 已恢复的
      // 最大静默间隙))。
      const signature = turnSignature(final);
      const switched = final.turn_id !== finalTurnId;
      if (switched || signature !== lastSignature) {
        if (switched) {
          // 换了最终轮（纠偏开了新一轮）：产出量最高水位与证词累计按新轮重建。
          finalTurnId = final.turn_id;
          volumeHighWater = -1;
        }
        lastSignature = signature;
        stallTracker.noteProgress();
        // 产出增长才清零证词续命的计数与累计静默。签名变化但产出没有超过最高水位
        // （状态往返、改写）仍是停滞门的进度，不清硬顶。
        const volume = turnVolume(final);
        if (volume > volumeHighWater) {
          volumeHighWater = volume;
          attestedSilentMs = 0;
          livenessAttestations = 0;
        }
        const nowMs = Date.now();
        if (nowMs - lastProgressEmitAt >= KIMI_PROGRESS_EMIT_MIN_INTERVAL_MS) {
          lastProgressEmitAt = nowMs;
          yield runtimeActivityEvent("streaming");
        }
      } else if (stallTracker.stallMs() >= stallTracker.budgetMs()) {
        const d = stallTracker.diagnostics();
        // 0046 B5：活体证词先行——serve 说轮还在跑（main_turn_active/busy 任一严格
        // true）就不是停滞：重置静默段继续等（硬顶另收口）。证词请求失败/形状不符 =
        // 无证词 = 照杀（fail-closed）。TD-213：不活跃（inactive）与取不到
        // （unavailable）分开写进文案。
        let attestationState = "unavailable";
        try {
          const detail = await this.sessionDetail(agent, sessionId);
          const active = detail?.main_turn_active === true || detail?.busy === true;
          const explicitInactive = detail?.main_turn_active === false && detail?.busy === false;
          attestationState = active ? "active" : (explicitInactive ? "inactive" : "unavailable");
        } catch {
          attestationState = "unavailable";
        }
        if (attestationState !== "active") {
          yield doneEvent(
            "failed",
            `turn stalled (no progress): silent stretch ${Math.round(stallTracker.stallMs())}ms exceeded adaptive budget `
              + `${Math.round(d.floorMs)}ms floor / ×${d.factor} / ${Math.round(d.ceilingMs)}ms ceiling; `
              + `max recovered gap this turn ${Math.round(d.maxObservedGapMs)}ms (bounded exit`
              + `${livenessAttestations > 0 ? `; ${livenessAttestations} prior liveness attestation(s) since the last output growth` : ""}; `
              + `attestation: ${attestationState} — ${attestationState === "inactive"
                ? "the serve reports the turn NOT active (likely a true stall; probe the session before re-dispatching)"
                : "the attestation probe failed (unknown liveness; do NOT assume the serve is dead — probe the session, then diagnose)"})`,
          );
          return;
        }
        livenessAttestations += 1;
        attestedSilentMs += stallTracker.stallMs();
        if (attestedSilentMs >= LIVENESS_ATTESTED_SILENT_CAP_MS) {
          yield doneEvent(
            "failed",
            `turn stalled: serve-attested silence since the last output growth exceeded the ${Math.round(LIVENESS_ATTESTED_SILENT_CAP_MS / 60_000)}min cap `
              + `(${Math.round(attestedSilentMs)}ms across ${livenessAttestations} attestation(s); adaptive budget diagnostics: `
              + `floor ${Math.round(d.floorMs)}ms / ×${d.factor} / ceiling ${Math.round(d.ceilingMs)}ms) — bounded exit despite liveness `
              + "(the serve keeps attesting an active turn that never lands output)",
          );
          return;
        }
        // 续命凭的是 serve 的证词——落成转录事实（决定 0069）。
        yield runtimeActivityEvent("serve_active");
        // resetSilent 清静默段但不喂自适应学习（证词不参与预算放大）。
        stallTracker.resetSilent();
      }
      await sleep(interval);
    }
  }

  /**
   * 统一请求门：超时/重试/204 统一处理，外加 kimi web
   * 的 {code,msg,data} 信封判定——非 2xx 或 body.code!==0 都算失败（抛含 msg 的
   * 错误）。Bearer 解析两级（2026-10-04 会审 coder_mm 纠正的陈旧注释）：优先
   * spawn 捕获的桥接槽 SPAWN_BRIDGED_BEARER（task.resolvedCredentials，每 run
   * 一次），缺失再读 process.env[agent.tokenEnv]，双缺抛固定安全错误（:899）。
   * 重试策略（#8）：GET 幂等，保持既有瞬态重试（超时/ECONNRESET/fetch
   * failed）；POST 非幂等（建会话/提交 prompt/steer），只在 ECONNREFUSED（连接
   * 未建立、服务器确定未收到）时重试——超时/ECONNRESET/fetch failed 的 POST 一律
   * 不重发（请求可能已送达：盲目重发 = 重复会话/重复 prompt/重复 steer）。
   * 超时覆盖面（#8）：计时器保持武装到**正文完全读取之后**（headers 立即返回、
   * 正文挂起时超时仍生效）；clearTimeout 收进内层 finally，覆盖全部返回/抛出路径。
   * token 清洗（#3/A5）：最终抛出点统一 sanitizeError——整条 cause 链递归、每层
   * 新建对象，message 与 name 都过 token→"<redacted>" 替换；非 Error 且非字符
   * 串的抛出值 JSON.stringify（循环引用回落 String）后清洗；null/undefined 抛出
   * 值原样抛出（见 sanitizeError 注释——F6：事件流消费前由 errorText 包成固定
   * 文案，本方法行为不变）。这是 backend 侧防御层；transcript 正式
   * 脱敏仍由控制面 redactor 承担。
   */
  async request(agent, url, init = {}) {
    const token = resolveBearerToken(agent);
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const controller = new AbortController();
        // #8：计时器不随 headers 返回而解除——正文读取（text/json）期间挂起时，
        // 超时经 controller.abort() 打断挂起的正文 Promise。
        const timer = setTimeout(() => controller.abort(), this.timeout);
        try {
          const response = await this.fetch(url, {
            ...init,
            signal: controller.signal,
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
              ...(init.headers ?? {}),
            },
          });
          if (!response.ok) {
            // 2026-10-04（会审 consult_202610042037269516qqzn9）：HTTP 状态失败打
            // 标记——它是服务端语义答复，绝不属于传输瞬态。旧瞬态判定按消息子串
            // （"fetch failed"），而本错误消息嵌着响应正文：401/5xx 正文若恰好含
            // 该词会被误判瞬态而重试 GET。标记后重试判定显式排除 HTTP 状态错误。
            const text = await response.text();
            const err = new Error(
              `kimi web request failed ${response.status}: ${redactToken(text, token)}`,
            );
            err.waoHttpStatus = response.status;
            throw err;
          }
          if (response.status === 204) {
            return null;
          }
          // 非 JSON 守卫（2026-10-02 坑修）：会话被服务端回收/鉴权面回退时，
          // 200 + HTML（登录页/错误页）会让 response.json() 抛裸 SyntaxError
          // （"Unexpected token '<'"）向上穿透成不可诊断崩溃。改读原文再解析，
          // 解析失败抛固定形状错误——只含状态码与 content-type，绝不回显正文。
          const rawBody = await response.text();
          let body = null;
          if (rawBody.length > 0) {
            try {
              body = JSON.parse(rawBody);
            } catch {
              throw new Error(
                `kimi web request returned a non-JSON body (status ${response.status}, `
                + `content-type ${response.headers?.get?.("content-type") ?? "unknown"}) `
                + "— session likely evicted or an HTML page was served; refusing to guess",
              );
            }
          }
          if (body && typeof body === "object" && body.code !== undefined && body.code !== 0) {
            const err = new Error(
              `kimi web request failed (code ${body.code}): ${redactToken(String(body.msg ?? "unknown error"), token)}`,
            );
            // 信封 code 随错误带出（调用方按 40401 会话已不存在分派；sanitizeError 保留）。
            err.waoCode = body.code;
            throw err;
          }
          return body;
        } finally {
          // #8：clearTimeout 移到正文完全读取之后（finally 兜住全部路径，含正文
          // 读取中途的抛出/中止——绝不在正文读取前解除计时器）。
          clearTimeout(timer);
        }
      } catch (error) {
        lastError = error;
        // A5：null/undefined 抛出值不可分类重试（也不读其属性——读取即崩），
        // 不重试、原样走最终抛出点的判空透传。
        const retryable = error === null || error === undefined
          ? false
          : init.method === "POST"
            ? isConnRefused(error)
            // waoHttpStatus 在场 = 服务端已明确答复（含 401/404/5xx）——非传输
            // 瞬态，永不重试（消息子串不可作为瞬态依据：正文可含任意词）。
            : (error.name === "AbortError"
              || (error.waoHttpStatus === undefined && isTransient(error)));
        if (!retryable || attempt === this.retries) break;
        await sleep(1000 * 2 ** attempt);
      }
    }
    // #3：最终抛出点统一清洗（全出口）。
    throw sanitizeError(lastError, token);
  }
}

// Bearer token 每次请求时解析；优先级：spawn 捕获的桥接值（runManager 的
// user-env 桥——2026-10-02 坑修）→ process.env[agent.tokenEnv]。字段缺失或两处
// 均未设 → 固定安全形状错误（只点名 env 变量名，绝不回显 env 内容——token 值
// 永不进错误消息/transcript/日志）。
// 决定 0074：车道声明了 kimiHome 时 token 取自 <kimiHome>/server.token（每个 agent
// 对象读一次并缓存），环境变量不读——别的主目录的 token 在这个 serve 上只会换来
// 40101，不做静默回落。错误只点名文件路径，不回显内容。
const SPAWN_BRIDGED_BEARER = new WeakMap();
const HOME_FILE_BEARER = new WeakMap();
// 桥接值写进 per-agent 槽（spawn 的 task.resolvedCredentials，或进程外停止的同形结果）。
function bridgeBearer(agent, resolvedCredentials) {
  const bridged = resolvedCredentials?.[agent?.tokenEnv];
  if (typeof bridged === "string" && bridged.trim().length > 0) {
    SPAWN_BRIDGED_BEARER.set(agent, bridged);
  }
}
function resolveBearerToken(agent) {
  const tokenFile = kimiServerTokenFile(agent);
  if (tokenFile !== null) {
    const cached = HOME_FILE_BEARER.get(agent);
    if (typeof cached === "string") return cached;
    let value = "";
    try { value = readFileSync(tokenFile, "utf8").trim(); } catch { value = ""; }
    if (value.length === 0) {
      throw new Error(`kimi-web backend: server token file ${tokenFile} is missing or empty (refusing dispatch)`);
    }
    HOME_FILE_BEARER.set(agent, value);
    return value;
  }
  const name = agent?.tokenEnv;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(
      "kimi-web backend requires tokenEnv (non-empty string; the bearer token env var name)",
    );
  }
  const bridged = SPAWN_BRIDGED_BEARER.get(agent);
  if (typeof bridged === "string" && bridged.trim().length > 0) {
    return bridged;
  }
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`kimi-web backend: bearer token env ${name} is not set (refusing dispatch)`);
  }
  return value;
}

// 回执缺 prompt_id 的派发记在这个键下：它永不等于轮里的 prompt id，不发明归属，
// 由 silentTimeout / 无进展出口有界收口。
const NO_PROMPT_ID = Symbol("kimi-web dispatch without prompt_id");

/**
 * 一次运行的提示集合（spawn 建一份，sendCorrection 与 streamEvents 共用）。
 * prompts: id → {kind:"dispatch"|"correction", submittedAt, steeredAt, waitPolls,
 * notExecuted}；steeredAt 非 null = 已转入。boundaryOrdinal = 提交前最大的轮
 * ordinal（没有轮为 -1），事件流往回翻页到它为止。
 */
export function createRunPrompts({ promptId = null, status, boundaryOrdinal = -1, submittedAt = Date.now() } = {}) {
  return {
    boundaryOrdinal,
    dispatchId: promptId,
    dispatchStatus: status,
    prompts: new Map([[promptId ?? NO_PROMPT_ID, {
      kind: "dispatch", submittedAt, steeredAt: null, waitPolls: 0, notExecuted: false,
    }]]),
  };
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

// 一页里最大的轮 ordinal（没有轮为 -1）。
function latestOrdinal(page) {
  return arrayOf(page?.turns).reduce((max, turn) => Math.max(max, turn.ordinal), -1);
}

// 轮的全部 user_message.prompt_ids（归属的唯一依据）。
function turnPromptIds(turn) {
  const ids = [];
  for (const item of arrayOf(turn?.items)) {
    if (item?.type !== "user_message") continue;
    for (const id of arrayOf(item.prompt_ids)) {
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
  }
  return ids;
}

// 用户回显：轮的开场 user_message 的 text（没有 placement 字段时取第一条 user_message）。
function openerText(turn) {
  const messages = arrayOf(turn?.items).filter((item) => item?.type === "user_message");
  const opener = messages.find((item) => item.placement === "opener") ?? messages[0];
  return typeof opener?.text === "string" && opener.text.length > 0 ? opener.text : null;
}

// 答案：轮的 assistant_message 条目按出现顺序；同一 step_index 首尾相接，不同步之间
// 空一行——模型在两次工具调用之间说的话和最后的答案是分开说的，粘成一行会让答案里
// 行首的 `Q1:` 这类锚点落到上一句话的句尾。reasoning 不进答案。
function answerOfTurn(turn) {
  const chunks = [];
  let step;
  for (const item of arrayOf(turn?.items)) {
    if (item?.type !== "assistant_message" || typeof item.text !== "string") continue;
    if (chunks.length > 0 && item.step_index === step) {
      chunks[chunks.length - 1] += item.text;
    } else {
      chunks.push(item.text);
      step = item.step_index;
    }
  }
  return chunks.filter((chunk) => chunk.length > 0).join("\n\n");
}

// 工具调用证据的增量投影（决定 0071）：轮的 items 里 type "tool_call" 的条目，按台账
// （item_id → 已落的部分）只发射还没落过的部分。规则：
//   - shell 类（name 小写 bash/shell）有 input.command → command 事件（kimi 无已证实
//     的退出码通道，exitCode 恒省略；item_id 进 meta 关联 tool_result）；
//   - 写文件类（write/edit/multiedit）→ file_written(path)，path 取 display.path（绝对
//     路径），没有再取 input.path；没有路径不虚构。在途只预告一条只带路径的
//     tool_use（决定 0072），file_written 只在整轮带回答成功收口时落（final=true）——
//     失败轮、无回答的 completed 轮都不落（N1）；
//   - 其余 → tool_use(name, input)；
//   - 条目 status "ended" 时追加一次 tool_result，outcome 不是 "completed" 记为错误。
// 在途的投影事件等输入就绪才发（Bash 在 input.command 到之前会被错分成 tool_use）。
// final=true 把还没落过的全部补齐。没有 item_id 的条目在途不投影（下标不是身份），
// 整轮带回答完成时按整轮投影落。
function projectKimiToolCalls(turn, ledger, { final = false } = {}) {
  const events = [];
  for (const item of arrayOf(turn?.items)) {
    if (item?.type !== "tool_call") continue;
    const id = typeof item.item_id === "string" && item.item_id.length > 0 ? item.item_id : null;
    const terminal = item.status === "ended";
    if (!final && isFileWriteToolKey(kimiToolKey(item))) {
      const writePath = kimiWritePath(item);
      if (id !== null && writePath !== null) {
        const entry = kimiLedgerEntry(ledger, id);
        if (!entry.announced) {
          events.push(toolUseEvent(String(item.name), { path: writePath }));
          entry.announced = true;
        }
      }
      continue;
    }
    if (id === null) {
      if (!final) continue;
      events.push(...kimiToolProjectionEvents(item));
      if (terminal) events.push(kimiToolResultEvent(item));
      continue;
    }
    const entry = kimiLedgerEntry(ledger, id);
    if (!entry.projected && (final || terminal || kimiToolInputReady(item))) {
      events.push(...kimiToolProjectionEvents(item));
      entry.projected = true;
    }
    if (terminal && !entry.resulted) {
      events.push(kimiToolResultEvent(item));
      entry.resulted = true;
    }
  }
  return events;
}

function kimiLedgerEntry(ledger, id) {
  let entry = ledger.get(id);
  if (entry === undefined) {
    entry = { projected: false, resulted: false, announced: false };
    ledger.set(id, entry);
  }
  return entry;
}

function kimiToolKey(item) {
  return String(item?.name ?? "").toLowerCase();
}

// 在途条目的输入是否已经到了可以定下投影事件形状的地步：input 是非空对象；shell 类
// 另要求 command 是非空字符串。这是形状判据，不是"参数已经完整"的证明。
function kimiToolInputReady(item) {
  const input = item?.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const toolKey = kimiToolKey(item);
  if (toolKey === "bash" || toolKey === "shell") return typeof input.command === "string" && input.command.trim().length > 0;
  return Object.keys(input).length > 0;
}

// 写文件类条目的目标路径：display.path（2.6.3 实测为绝对路径），没有再取 input.path
// （相对路径）；都没有 → null。
function kimiWritePath(item) {
  const displayPath = item?.display?.path;
  if (typeof displayPath === "string" && displayPath.length > 0) return displayPath;
  const inputPath = item?.input?.path;
  return typeof inputPath === "string" && inputPath.length > 0 ? inputPath : null;
}

function kimiToolCallId(item) {
  return typeof item?.item_id === "string" && item.item_id.length > 0 ? item.item_id : String(item?.name ?? "unknown");
}

function kimiToolResultEvent(item) {
  return toolResultEvent(kimiToolCallId(item), item?.output, item?.outcome !== "completed");
}

function kimiToolProjectionEvents(item) {
  const tool = String(item?.name ?? "unknown");
  const toolKey = tool.toLowerCase();
  const input = item?.input ?? {};
  if ((toolKey === "bash" || toolKey === "shell") && typeof input.command === "string") {
    return [commandEvent(input.command, undefined, { toolCallId: kimiToolCallId(item) })];
  }
  if (isFileWriteToolKey(toolKey)) {
    const filePath = kimiWritePath(item);
    return filePath === null ? [] : [fileWrittenEvent(filePath)];
  }
  return [toolUseEvent(tool, input)];
}

// isFileWriteTool 同款谓词（各后端各自一份语义，注释互指）。
function isFileWriteToolKey(toolKey) {
  return toolKey === "write" || toolKey === "edit" || toolKey === "multiedit";
}

// ended 轮非 completed 的失败文案（调用方过 redactToken）：interrupted 写 end_reason，
// failed 写 error（{code,message} 或字符串——形状未实测，按文档读）；缺席写明缺席，
// 不虚构原因。
function turnFailureText(turn) {
  const id = String(turn?.turn_id);
  if (turn?.outcome === "interrupted") {
    const reason = typeof turn.end_reason === "string" && turn.end_reason.length > 0 ? turn.end_reason : null;
    return `kimi turn interrupted (turn ${id}, ${reason === null ? "no end_reason upstream" : `end_reason: ${reason}`})`;
  }
  const error = turnErrorText(turn?.error);
  return `kimi turn failed (turn ${id}, ${error === null ? "no error field upstream" : `error: ${error}`})`;
}

function turnErrorText(error) {
  if (typeof error === "string") return error.length > 0 ? error : null;
  if (!error || typeof error !== "object") return null;
  const parts = [error.code, error.message]
    .filter((value) => (typeof value === "string" && value.length > 0) || typeof value === "number")
    .map(String);
  return parts.length > 0 ? parts.join(": ") : stringifyValue(error);
}

// 轮的产出量：步数 + 条目数 + 条目文本与工具输出的总长。只看它的最高水位判"产出有没有
// 增长"（硬顶清零的判据；不含状态——状态会变却不代表多了产出）。
function turnVolume(turn) {
  const items = arrayOf(turn?.items);
  let volume = arrayOf(turn?.steps).length + items.length;
  for (const item of items) {
    if (typeof item?.text === "string") volume += item.text.length;
    if (typeof item?.output === "string") volume += item.output.length;
  }
  return volume;
}

// 无进展签名：轮的结构投影（status/outcome + 各步 index/outcome + 各条目
// type/status/文本长/输出长）。任何增长或状态变化都改变签名（= 进展）；usage 不入签名。
function turnSignature(turn) {
  const steps = arrayOf(turn?.steps).map((step) => `${String(step?.index ?? "?")}:${String(step?.outcome ?? "?")}`);
  const items = arrayOf(turn?.items).map((item) => [
    String(item?.type ?? "?"),
    String(item?.status ?? "?"),
    typeof item?.text === "string" ? item.text.length : 0,
    typeof item?.output === "string" ? item.output.length : 0,
  ].join(":"));
  return `${String(turn?.status ?? "?")}|${String(turn?.outcome ?? "?")}|${steps.join(",")}|${items.join(",")}`;
}

// usage → metrics 事件（reportsTokenUsage=true 的通道）：各归属轮的轮级 usage 按
// USAGE_FIELDS 求和（不再叠加步骤——轮级等于各步之和）；任一数字在场才发（全缺席 ⇒
// null，绝不虚构零值通道）。firstRequest = 第一个归属轮里 index 最小、带 usage 的那一
// 步自己的 input 与 cacheRead（每步是一次模型请求；上游报 0 记 0，缺字段不写）。
function metricsEventFromTurns(turns) {
  const sums = {};
  let seen = false;
  for (const turn of turns) {
    const usage = turn?.usage;
    if (!usage || typeof usage !== "object") continue;
    for (const [kimiField, axis] of USAGE_FIELDS) {
      const value = usage[kimiField];
      if (typeof value === "number" && Number.isFinite(value)) {
        sums[axis] = (sums[axis] ?? 0) + value;
        seen = true;
      }
    }
  }
  if (!seen) return null;
  // 只写上游报出的分量：缓存分量缺失时不补 0（缓存占比按未知处理）。
  const event = metricsEvent(sums);
  const stepIndex = (step) => (Number.isFinite(step?.index) ? step.index : Infinity);
  let firstStep = null;
  for (const step of arrayOf(turns[0]?.steps)) {
    if (!step?.usage || typeof step.usage !== "object") continue;
    if (firstStep === null || stepIndex(step) < stepIndex(firstStep)) firstStep = step;
  }
  if (firstStep !== null) {
    const firstRequest = {};
    const { input_other: input, input_cache_read: cacheRead } = firstStep.usage;
    if (typeof input === "number" && Number.isFinite(input)) firstRequest.input = input;
    if (typeof cacheRead === "number" && Number.isFinite(cacheRead)) firstRequest.cacheRead = cacheRead;
    if (Object.keys(firstRequest).length > 0) event.firstRequest = firstRequest;
  }
  return event;
}


// F6（v7 起保留）：request() 对 null/undefined 抛出值原样抛出（保留"这本来就不
// 是错误对象"的类型事实），但事件流消费侧直接读 error.message 会在
// null/undefined 上 TypeError 崩溃——消费前包成固定文案。其余形状行为不变。
function errorText(error) {
  if (error === null || error === undefined) {
    return "request failed with non-error throw";
  }
  return error.message ?? String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransient(error) {
  const msg = error.message ?? "";
  if (error.cause?.code === "ECONNREFUSED") return true;
  if (error.cause?.code === "ECONNRESET") return true;
  if (msg.includes("fetch failed")) return true;
  return false;
}

// 修复 F（#8 收紧）：POST 重试的唯一种类——ECONNREFUSED（连接未建立，服务器确
// 定未收到）。只认 error.cause?.code === "ECONNREFUSED"——删除一切消息字符串
// 匹配（HTTP 500 正文里含 "ECONNREFUSED" 字样绝非连接拒绝，绝不据此重发 POST）。
function isConnRefused(error) {
  return error?.cause?.code === "ECONNREFUSED";
}

// 修复 E：token 值 → "<redacted>" 全量替换（split/join 避免正则元字符问题）。
function redactToken(text, token) {
  if (typeof text !== "string" || !token) return text;
  return text.split(token).join("<redacted>");
}

// A5（#3 深层漏洞闭合）：request() 最终抛出点的统一清洗——递归走整条 cause 链，
// 每层**新建**对象（绝不复用/变异原错误），message 与 **name** 都过
// token→"<redacted>" 替换（name 含 token 的深层泄漏向量一并闭合）。分层规则：
//   - Error：新建同 name（清洗后）的 Error，message 清洗，cause 递归清洗。
//   - 字符串：清洗后包成 Error 抛出（保持错误形状可用）。
//   - 非 Error 且非字符串（普通对象/数组）：先 JSON.stringify（try/catch，循环
//     引用回落 String）再清洗——只洗 {...cause, message} 的 message 字段会把
//     对象**其余字段**里的 token 原样放走（第 5 轮的深层漏洞）。
//   - null/undefined：清洗前先判空、**原样返回**（随后原样抛出）——包装成
//     Error 会把 null 虚构成 "null" 字符串错误，丢失"这本来就不是错误对象"的
//     原始异常类型信息（保留原始异常事实，不添造）。backend 侧防御层；
//     transcript 正式脱敏仍由控制面 redactor 承担。
//
// F6（v7）已接受残余（auditor 裁定不阻断、文档化；sanitizeError 形状边界如实
// 声明，不再扩防）：
//   - getter/Symbol/循环引用逃逸面：普通对象走 JSON.stringify——getter 求值
//     结果与 Symbol 键的值**不进序列化**（token 藏在 Symbol 属性/getter 里的
//     形状不过替换）；循环引用回落 String() 只得 "[object Object]" 一类投影
//     （自身字段内容整体丢失，只保底无害）。不试图遍历属性做全量清洗——
//     getter 求值有副作用面、Symbol 遍历枚举序不稳定，穷尽清洗的复杂度与
//     新逃逸面得不偿失。
//   - 进程内异常来源：抛出值可能来自进程内代码（fetchImpl 注入实现/自定义异
//     常类）而非远端响应。远端 REST 响应天然是 JSON 反序列化产物（无 getter/
//     Symbol/循环引用），该逃逸面只存在于进程内异常源——backend 层清洗是对
//     进程内源的防御层，不是序列化边界保证。
//   - 远端 JSON 不能携带上述形状：跨进程来的错误文本只有字符串面——清洗的
//     真实威胁模型是"远端把 token 回显进字符串字段"与"进程内异常对象携带
//     token"，前者已全覆盖（message/name/msg/正文），后者以上述残余为界。
//   - 消费侧配合（v7 唯一行为修改）：null/undefined 原样抛出后，事件流消费
//     侧读 error.message 会 TypeError——streamEvents 经 errorText() 在消费前
//     包成固定文案 "request failed with non-error throw"（request()/sanitizeError
//     自身行为不变）。
function sanitizeError(error, token) {
  if (error === null || error === undefined) {
    return error;
  }
  if (error instanceof Error) {
    const clean = new Error(redactToken(String(error.message ?? ""), token));
    clean.name = redactToken(typeof error.name === "string" ? error.name : "Error", token);
    if (error.cause !== undefined) {
      clean.cause = sanitizeCause(error.cause, token);
    }
    if (Number.isInteger(error.waoCode)) clean.waoCode = error.waoCode;
    return clean;
  }
  if (typeof error === "string") {
    return new Error(redactToken(error, token));
  }
  return new Error(redactToken(stringifyValue(error), token));
}

// cause 链清洗（A5）：Error cause 递归经 sanitizeError（每层新建、name/message
// 都洗）；字符串 cause 直接清洗；其余非空 cause JSON.stringify（循环引用回落
// String）后清洗成字符串（对象 cause 的全部字段过一遍替换）；null/undefined
// 原样保留。
function sanitizeCause(cause, token) {
  if (cause === null || cause === undefined) {
    return cause;
  }
  if (cause instanceof Error) {
    return sanitizeError(cause, token);
  }
  if (typeof cause === "string") {
    return redactToken(cause, token);
  }
  return redactToken(stringifyValue(cause), token);
}

// 非 Error 且非字符串抛出值/cause 的序列化：JSON.stringify 保留字段级内容
// （可清洗）；循环引用等序列化失败回落 String()。
function stringifyValue(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return typeof text === "string" ? text : String(value);
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

