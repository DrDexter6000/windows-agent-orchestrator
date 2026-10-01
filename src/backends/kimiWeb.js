// src/backends/kimiWeb.js
//
// 第 7 个 backend「kimi-web」（HTTP attach 型）：驱动 `kimi web` 本地服务器
// （kimi 2.1.1）的 Kimi Code 官方 REST API。闭集 6→7 扩员经 Owner 2026-09-30 批准。
//
// 上游 API 事实（全部来自 2026-09-30 对本机 kimi 2.1.1 的直跑实测，本注释即依据）：
//   - 所有请求需 Authorization: Bearer <token>；响应统一包 {code,msg,data}，
//     code!==0 即失败（msg 含原因）。
//   - POST /api/v1/sessions {title?, metadata:{cwd}} → data.id（session_ 前缀）；
//     metadata.cwd 或 workspace_id 必填（缺则 40001）——WAO 侧用 agent.cwd 填。
//   - POST /api/v1/sessions/{id}/prompts {content:[{type:"text",text}], model}
//     → data.prompt_id、data.status:"running"。两个实测坑：content 必须是分段
//     数组形状（裸字符串直接 40001）；model 必填——缺 model 时接口照样返
//     success/running，但轮次**静默秒败**。v8 起（transcript 轮次原语）该失败是
//     一等公民事实：轮次以 state:"failed" + error:"Model not set" 落在
//     transcript 里，事件流首拍即 done(failed, error)——不再需要任何推断。
//   - **GET /api/v1/sessions/{id}/transcript?agent_id=main → data.items[]（轮
//     粒度）**：{kind:"turn", turnId:"t0", triggerPromptId:"msg_…", ordinal,
//     state, prompt, endedAt, durationMs, error, steps:[{stepId, turnId,
//     ordinal, state, usage:{inputOther,output,inputCacheRead,inputCacheCreation},
//     llmTiming, frames:[{kind:"thinking"|"text", text, role?}]}]}。
//       · **state 闭集：queued|running|completed|failed|cancelled**（终态 = 后
//         三个）。
//       · **triggerPromptId === POST prompts 返回的 prompt_id**（live 双验证：
//         completed 轮与 failed 轮都命中）——v8 完成判定的唯一归属键。
//       · agent_id 查询参数**必填**：缺则 40001；实测 "main" 有效、"default"
//         返回空——客户端恒发 agent_id=main（TRANSCRIPT_AGENT_ID）。
//       · 另有 data.seq 水位与 GET …/transcript/ops?since_seq= 增量对账通道
//         ——v8 不用（全量单页轮询已足够），留作 v1.1+ 备用。
//       · data.has_more + before_turn/after_turn 翻页——v8 单页不翻页（声明：
//         超长会话的早期轮可能不在首页；归属键匹配不到时由 silentTimeout /
//         无进展出口有界收口，绝不静默翻页猜测）。
//   - GET /api/v1/sessions/{id} → data{busy, main_turn_active, last_turn_reason,
//     usage{…}, …}——v8 起只承担两职：spawn 提交前静默门 + 停止验证探针
//     （sessionStatus busy 投影）；**不参与完成判定**。
//   - GET /api/v1/sessions/{id}/messages → data.items[]（**newest-first**，实测
//     如此）——**v8 起不再参与完成判定**（handle.messages 仅供停止验证消费者，
//     按 opencodeStopVerify.sample 的调用形状 (serveUrl, sessionId, {cwd}) 读取）。
//   - POST /api/v1/sessions/{id}/prompts:steer {prompt_ids:["msg_…"]}
//     → data.steered===true 即成功；无活动轮时 40402 "no active prompt to steer
//     into"（fail-closed）。
//   - 中止面实测定论：REST 无会话级/轮次级中止端点（tasks:cancel/stop/abort 等
//     8 个候选动作名全部 40001 "unsupported action"）。存在 POST /api/v1/shutdown
//     （服务器级，杀全部会话）——backend 的 abort() 绝不允许调它：共享服务器上
//     会误杀无关会话。
//
// v8 完成判定（第八轮结构性重写）：**原厂 transcript 轮次终态原语**取代全部
// 旧启发式。events 每拍 GET transcript?agent_id=main，找 triggerPromptId ===
// promptId 的 turn（本轮唯一归属——历史轮/前任轮的 triggerPromptId 永不等于
// 本轮 prompt_id，误归属与历史重放按构造不可能）：
//   - 未找到（提交滞后）→ 等；silentTimeout（相对提交时刻）到期仍无 → silent
//     fail（R9 F3：silentTimeout 在场时这是无 turn 等待的唯一上界——8 拍无进展
//     兜底不抢先，仅 silentTimeout 缺席形状生效）。
//   - state=queued|running → 等；无进展兜底：该 turn 连续 ≥8 拍
//     （NO_PROGRESS_POLL_LIMIT）state 不变且 steps/frames 无增长 → done(failed,
//     "turn stalled (no progress)")。闭集外未知 state → R9 F4 独立有界处置：
//     一律非终态、绝不猜终态，但连续 ≥8 拍仍闭集外 → done(failed,
//     "unsupported turn state")——客户端已知该 state 不受支持，等待增长没有
//     意义（增长不清零该计数）。
//   - state=completed → 从该 turn 的 steps[].frames 取 kind==="text" 且
//     role==="assistant"（或无 role 的 text 帧，按实测宽容）按序拼接；**发射前
//     复检非空**（空则按 failed 收口——N1 教训：传输成功不是可用答案，绝不伪造
//     完成）；发射 user echo（turn.prompt）+ assistant text + usage
//     （steps[].usage 求和 → metrics 事件）+ done(completed)。**只发射该 turn
//     的内容——历史重放按构造不可能**。
//   - state=failed|cancelled → done(failed, error 字段或固定文案；R9 F2：拼装
//     结果过与 request 层同一 redactToken 清洗——turn.error 是 HTTP 200 成功
//     路径的上游回显文本，不经 sanitizeError 出口，token 值绝不原样进事件流)。
// 删除面（v7→v8，被 turn 归属整体取代）：preSubmitIds 消息快照、preSubmitReason
// 锚、活动转移观测（WAIT-ACTIVE/IN-TURN/SETTLE 状态机）、messages 双读稳定性
// （F2）——messages 端点退出完成判定。
//
// 停止杠杆声明（诚实面）：REST 无会话级中止端点（abort 抛固定错误，原因由控制面
// 记入 run.aborted.error）；显式停止需 Lead 人工处置服务器侧；停止验证经 handle
// 探针（session/sessionStatus/messages，sessionStatus 为 busy 投影）；v8 起
// reportsTokenUsage=true（transcript steps[].usage 实测非零）——tokenBudget 闸门
// 生效，但失控 run 仍无 WAO 内自动停止杠杆，派发须 bounded 任务 + 操作员监督。
//
// 翻页截断声明（v8）：transcript 单页不翻页（见上）；messages 探针页同理（仅供
// 停止验证计数，不翻页）。
//
// 单 actor 会话假设：WAO 独占其派发的 session（同会话无其他提交方）。提交前静默
// 门（spawn，v7 F3 保留）之后的残余竞窗——静默观测刚确认 idle、POST prompts 落地
// 之前恰有其他 actor 提交——依赖该假设；假设破裂时（他人 prompt 抢先触发新轮）
// 归属判据仍 fail-closed：我们的 promptId 匹配不到任何 turn ⇒ 走 silent /
// 无进展有界出口，绝不误领他人轮次。
//
// 形状不符取舍（v7 F4 裁定延续，v8 换观测源）：transcript 缺 items 数组 /
// detail 缺 id 或 busy/main_turn_active 在场门不满足 ⇒ fail-closed **立即**失败
// （事件流 done(failed) 固定错误 / spawn 侧上抛），暂时性缺失不重试、无恢复路径
// ——这是有意的可用性取舍：形状不可信即整体不可信，回落 [] / {} 会把"不可观察"
// 虚报成健康观测（空会话/静止会话），与"绝不把不可观察当健康"的取向一致。

import {
  messageEvent,
  doneEvent,
  metricsEvent,
} from "../runEvent.js";
import { isProcessPlaceholderSessionId } from "./processBackend.js";

// role/task 分隔符对齐 kimiCode.js 的 ROLE_TASK_SEPARATOR（"\n\n---\n\n"）——
// 两个 prompt 级通道的 backend 用同一分隔形状，避免两套事实并存。
const ROLE_TASK_SEPARATOR = "\n\n---\n\n";

// transcript 端点的 agent_id 查询参数（实测：必填，缺则 40001；"main" 有效、
// "default" 返回空）——客户端恒发 "main"，绝不缺省。
const TRANSCRIPT_AGENT_ID = "main";

// 无进展出口阈值（named const；v8 语义收窄到 turn 归属）：归属 turn 连续 ≥8 拍
// state 不变且 steps/frames 无增长（首见拍建立基线——turn 出现即进展，提交滞后
// 的解除不算停滞）→ done(failed, "turn stalled (no progress)")。R9 分工：
// silentTimeout 在场时无 turn 等待只以 silentTimeout 为界（F3——本兜底不抢先）；
// silentTimeout 缺席的防御形状（turn 永不出现）仍被该出口有界覆盖，绝不无限
// 等待。同一阈值另作 R9 F4 闭集外 state 的独立有界计数（增长不清零——见
// streamEvents 分支注释）。
const NO_PROGRESS_POLL_LIMIT = 8;

// completed 轮 usage 求和的字段映射（kimi usage 四计数 → metrics 轴）：
// inputOther→input、output→output、inputCacheRead→cacheRead、
// inputCacheCreation→cacheWrite（1:1 语义映射，不发明聚合；reasoning/costUsd
// 无 kimi 对应字段，省略——metrics 事件只带实测通道）。
const USAGE_FIELDS = Object.freeze([
  ["inputOther", "input"],
  ["output", "output"],
  ["inputCacheRead", "cacheRead"],
  ["inputCacheCreation", "cacheWrite"],
]);

export class KimiWebBackend {
  // 会话活在 WAO 进程之外的 `kimi web` 服务器里（HTTP attach 型，TD-39 同款语义：
  // WAO 进程退出 ≠ session 死）。停止杠杆（诚实声明，见文件头）：REST 无会话级
  // 中止端点（abort 抛固定错误）；显式停止需 Lead 人工处置服务器侧；停止验证经
  // handle 探针观测会话 busy 状态；v8 起 tokenBudget 闸门生效（reportsTokenUsage=
  // true——transcript steps[].usage 实测非零）——但失控 run 仍无 WAO 内自动停止
  // 杠杆，派发须 bounded 任务 + 操作员监督。
  sessionOutlivesProcess = true;

  // 角色合同拼进 prompt 正文前缀（role 在前、task 在后、恰好一次，分隔符
  // ROLE_TASK_SEPARATOR 对齐 kimiCode.js）——与 kimiCode.js 的 prompt 级通道
  // 同款：上游无 system message 通道，这是 prompt 级引导而非系统级隔离
  // （边界声明同 M11-5 TD-89）。
  supportsRoleContract = true;

  // resume 轮不 POST /sessions 建新会话，直接向前任 session id POST prompts 续接。
  // 前任 id 的取法镜像 kimiCode.js 的 resume 轮实现：task.priorProviderSessionId
  // （spawn 权威从转录取回、in-process 送达），缺失/占位（proc_<pid>）在**派发前**
  // 抛错——绝不静默开一段全新会话。
  supportsSessionReuse = true;

  // 在途纠偏 = 先 POST prompts 排队拿 prompt_id，再 POST prompts:steer 转入活动轮。
  // delivered（steered===true）证明纠偏已转入活动轮，**不证明模型截断了当轮生成**
  // ——上游实测：纠偏在轮边界被模型消费（原生成流跑完当轮）。消费可见性（v8
  // 注，**形状未实测**——仅标注，不据此做任何判定）：steered 的消费据说可见于
  // transcript prompts[].steeredAt / turn 结构。不对称声明（保留）：排队成功但
  // steer 失败（如 40402 无活动轮）时，上游可能仍会在后续轮消费该排队消息——
  // send_failed ≠ 一定未执行，Lead 重发前须知此不对称。
  supportsInFlightCorrection = true;

  // fresh 派发 = 新会话 + 原 prompt 重放；跨 run 上下文续接走 session 复用
  // （supportsSessionReuse），本层不承担跨 run 重放。
  replayByRespawn = true;

  // v8 翻转（false→true）：2026-09-30 live 实测 transcript 轮次 steps[].usage 的
  // inputOther/output/inputCacheRead/inputCacheCreation 可非零——可验证的 token
  // 计量通道成立（v7 声明 false 的依据"会话详情 usage 可为全零"不再是唯一通道，
  // 该翻转条件自此满足）。发射 = completed 轮 steps[].usage 求和（仅本轮）→
  // metrics 事件（metricsEventFromTurn）；tokenBudget 闸门自此对该 backend 生效。
  reportsTokenUsage = true;

  // 消息形状（content 分段数组）中未证实退出码通道——命令退出码证据不产出。
  reportsCommandExitCode = false;

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
    // opencode 形状的路由字段，kimi-web 无此表达面，配了即拒（防迁移配置的
    // 路由字段被静默丢弃后仍被当作有效配置派发）。
    if (agent?.model?.providerID !== undefined || agent?.model?.variant !== undefined) {
      throw new Error(
        "kimi-web backend cannot express model.providerID/model.variant "
        + "(the prompts body takes a bare model id string — rejected instead of silently dropping routing fields)",
      );
    }
    // prompts body 有 thinking 字段但值形状未实测——不发明映射，配了即拒。
    if (agent?.reasoning !== undefined && agent?.reasoning !== null) {
      throw new Error(
        "kimi-web backend cannot express reasoning (the prompts thinking field shape is unverified — no mapping invented)",
      );
    }
    if (agent?.model?.contextWindow !== undefined) {
      throw new Error("kimi-web backend cannot express model.contextWindow");
    }
    // kimi 托管认证：服务器 bearer token（tokenEnv）是传输凭证，不是模型 provider。
    if (agent?.provider) {
      throw new Error(
        "kimi-web backend cannot express provider (kimi managed auth; the server bearer token is not a model provider)",
      );
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
  }

  // 构造零副作用（registry validate 会静态构造——backendCapabilitySnapshot 同款要求）。
  constructor({ fetchImpl = globalThis.fetch, timeout = 30_000, retries = 2 } = {}) {
    if (!fetchImpl) {
      throw new Error("fetch is required");
    }
    this.fetch = fetchImpl;
    this.timeout = timeout;
    this.retries = retries;
  }

  async spawn(agent, task, opts = {}) {
    this.validateAgentPolicy(agent);
    let sessionId;
    if (task.sessionReuse?.turn === "resume") {
      // 镜像 kimiCode.js 的 resume 轮实现：前任 provider session id 缺失/空/占位
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
    // true 即轮询等待，直到两者**严格 false** 才进入提交前 transcript 读。
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
    // roleContract 时以 ROLE_TASK_SEPARATOR 衔接（对齐 kimiCode.js）。
    const prompt = task.roleContract
      ? `${task.roleContract}${ROLE_TASK_SEPARATOR}${task.prompt}`
      : task.prompt;
    // 提交前 transcript 读（v8 时序：POST prompts 之前）：记 preSubmitTurnIds
    // （已有 turnId 集合）——**不参与任何判定分支**（triggerPromptId ===
    // promptId 的归属键已覆盖一切：历史轮的 triggerPromptId 永不等于本轮
    // prompt_id，误归属与历史重放按构造不可能）；保留为日志/调试观察锚，且
    // 这里的 data.seq 水位/翻页形状已实测留档（v1.1+ 增量对账备用，见文件头）。
    // resume 轮同一段逻辑天然工作：既有会话的历史 turn 在此被观测一遍，新
    // prompt 触发的新 turn 由归属键唯一圈定。
    const preTurns = await this.transcript(agent, sessionId);
    const preSubmitTurnIds = [];
    for (const item of preTurns.items) {
      if (typeof item?.turnId === "string" && item.turnId.length > 0) {
        preSubmitTurnIds.push(item.turnId);
      }
    }
    const admitted = await this.sendPrompt(agent, sessionId, prompt);
    // prompt_id = v8 归属键（POST 回执与 transcript turn.triggerPromptId 同一
    // id 空间，live 双验证：completed 轮与 failed 轮都命中）。缺失形状（上游
    // 违约返回无 prompt_id）不发明归属启发式：匹配不到任何 turn ⇒ 由
    // silentTimeout / 无进展出口有界收口（见 streamEvents）。
    const promptId = typeof admitted?.prompt_id === "string" && admitted.prompt_id.length > 0
      ? admitted.prompt_id
      : null;
    // 轮次归属锚：随 events 工厂透传给 streamEvents（完成判定唯一事实源）。
    const turnAnchor = { promptId, submitAt: Date.now(), preSubmitTurnIds };
    const cwd = agent.cwd;
    return {
      backend: "kimi-web",
      backendSessionId: sessionId,
      serveUrl: agent.serveUrl,
      cwd,
      // events 工厂：RunManager 传 signal（仅作 abort 静默退出——终态判定不依赖
      // 它，事件流自身的有界性由 silentTimeout 家族 + 无进展出口保证）、
      // pollInterval / silentTimeout 控制轮询（职责划分镜像 opencodeServe.streamEvents）；
      // correctable run 另传 onPollTick（排队纠偏的投递钩子——缺了它 correctable
      // run 的纠偏永远不被投递，消费侧见 runManager._pollCorrections），原样
      // 透传给 streamEvents 每轮轮询调用一次。
      events: (signal, opts) => this.streamEvents(agent, sessionId, {
        signal,
        interval: opts?.pollInterval,
        silentTimeout: opts?.silentTimeout,
        onPollTick: opts?.onPollTick,
        turnAnchor,
      }),
      // 上游无会话级中止通道（见文件头停止杠杆声明）：抛固定错误（原因由控制面
      // 记入 run.aborted.error；cleanup 的停止验证对 kimi-web 形状不可观察 → 记
      // run.stop_unverified），绝不调 POST /api/v1/shutdown（服务器级，会杀共享
      // 服务器上的无关会话）。
      abort: async () => {
        throw new Error(
          "kimi-web backend has no session-level abort channel "
          + "(upstream REST exposes none; the server-level /api/v1/shutdown would kill "
          + "unrelated sessions on the shared kimi web server) — record stop_unverified instead",
        );
      },
      // 停止探针（#1 签名对齐消费者）：opencodeStopVerify.sample / runManager 的
      // 实际调用形状是 (serveUrl, sessionId, {cwd})——serveUrl/opts 形参忽略，
      // 会话身份用闭包内 agent+sessionId（与 spawn 绑定同一会话）。messages 返回
      // {data} 页形状（sample 读 page?.data 计数）；sessionStatus 是 GET 会话详情
      // 的 busy 投影，返回形状对齐 opencodeServe.sessionStatus（{type:"busy"|
      // "idle"}；detail 不可得 → **null**——kimi-web 无 retry 形状，绝不虚构，也
      // 绝不 else-推断-idle；R9 F1：detail 在场但双字段任一非布尔 → **busy**
      // 保守投影——isKnownStatus(null)===true 会把不可观察虚记 stop_verified，
      // 宁可虚报忙、绝不虚报停止）——cleanup 的 verifyStopQuiet 据此可真正观察
      // kimi-web 会话（不可观察时如实不可观察，绝不虚报）。
      session: (_serveUrl, _sessionId, _probeOpts) => this.sessionDetail(agent, sessionId),
      messages: async (_serveUrl, _sessionId, _probeOpts) => ({
        data: await this.messages(agent, sessionId),
      }),
      sessionStatus: (_serveUrl, _sessionId, _probeOpts) => this.sessionStatus(agent, sessionId),
      // M12-16 handle 级纠偏钩子（runManager provider 中立消费，见 _pollCorrections）。
      sendCorrection: (text) => this.sendCorrection(agent, sessionId, text),
    };
  }

  /**
   * F3 提交前静默门（v7）：轮询 GET 会话详情，直到 busy/main_turn_active 两者
   * **严格 false** 才放行提交前快照。任一严格 true 即等待；非布尔形状 ≠ idle
   * （A3 纪律——形状未知绝不推断静止，同样等待）。有界：silentTimeout（传入值
   * 或默认 60s）到界抛固定错误 "session busy at dispatch"。detail 请求失败 /
   * 形状不符（A4 在场门）原样上抛（fail-closed，不吞、不猜）。
   */
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
        }),
      },
    );
    return response?.data;
  }

  /**
   * 在途纠偏（supportsInFlightCorrection 的实现）：POST prompts 排队拿 prompt_id
   * → POST prompts:steer 转入活动轮。steered===true → {ok:true}；任何失败（HTTP
   * 错 / code!==0 / 40402 无活动轮）→ {ok:false, reason:"send_failed"}（M12-16
   * 闭集 reason）。delivered 证明已转入活动轮，不证明模型截断了当轮生成。
   * 不对称声明：排队成功但 steer 失败（如 40402 无活动轮）时，上游可能仍会在
   * 后续轮消费该排队消息——send_failed ≠ 一定未执行，Lead 重发前须知此不对称。
   * 有界拒绝：错误细节不透传（token 值绝不进消息）。
   */
  async sendCorrection(agent, sessionId, text) {
    if (typeof text !== "string" || text.length === 0) {
      return { ok: false, reason: "send_failed" };
    }
    try {
      const queued = await this.sendPrompt(agent, sessionId, text);
      const promptId = queued?.prompt_id;
      if (typeof promptId !== "string" || promptId.length === 0) {
        return { ok: false, reason: "send_failed" };
      }
      const steered = await this.request(
        agent,
        `${trimSlash(agent.serveUrl)}/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts:steer`,
        {
          method: "POST",
          body: JSON.stringify({ prompt_ids: [promptId] }),
        },
      );
      return steered?.data?.steered === true
        ? { ok: true }
        : { ok: false, reason: "send_failed" };
    } catch {
      return { ok: false, reason: "send_failed" };
    }
  }

  /**
   * GET messages（v8 起职责收窄：**仅供停止验证消费者**——handle.messages 按
   * opencodeStopVerify.sample 的页形状返回；完成判定已整体迁移到 transcript
   * 轮次原语，本端点不再参与任何判定分支）。A4（缺数据虚报停止）：缺 items
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
   * GET 轮次 transcript（v8 完成判定的唯一观测源；形状锚见文件头）。agent_id
   * 查询参数必填（缺则 40001；实测 "main" 有效、"default" 返回空）——客户端
   * 恒发 TRANSCRIPT_AGENT_ID，绝不缺省。A4 fail-closed 门：响应缺 data.items
   * 数组 ⇒ 抛固定错误，绝不回落猜测形状（空数组会被当成"会话无轮次"的健康
   * 观测，虚报归属面）。返回整个 data（items + seq/has_more 水位——v8 只消费
   * items；seq/ops 增量对账与翻页留 v1.1+，见文件头声明）。
   */
  async transcript(agent, sessionId) {
    const response = await this.request(
      agent,
      `${trimSlash(agent.serveUrl)}/api/v1/sessions/${encodeURIComponent(sessionId)}`
      + `/transcript?agent_id=${TRANSCRIPT_AGENT_ID}`,
      { method: "GET" },
    );
    const data = response?.data;
    if (!data || typeof data !== "object" || !Array.isArray(data.items)) {
      throw new Error(
        "kimi web transcript response malformed (data.items array is required — refusing to guess)",
      );
    }
    return data;
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
   * opencodeServe.sessionStatus（其 statuses[sessionId] 值即该形状；kimi-web
   * 无 retry 形状，绝不虚构）。A4：detail 不可得（任何错误——HTTP/信封/在场门）
   * ⇒ 返回 **null**（消费者把"观测不可得"如实记 stop_unverified，与下面的形状
   * 投影分工不同）。**R9 F1**：detail 在场（在场门已过）但任一字段非布尔 ⇒
   * 返回 **{type:"busy"}**（保守投影）——事实依据：消费者 opencodeStopVerify 的
   * isKnownStatus(null) === true（src/backends/opencodeStopVerify.js:134，只读
   * 参照），null 会被当成"已知且非活跃"，session/messages 零增长时 verifyStopQuiet
   * 判 quiet:true ⇒ 不可观察被虚记 run.stop_verified。宁可虚报忙、绝不虚报停止
   * （与下方 F5 true 腿同款取舍）；HTTP 500/请求失败腿保持 null（消费者对不可得
   * 记 unverified，行为不同，不动）。
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
   * 轮询生成器（v8 结构性重写：**原厂 transcript 轮次终态原语**；职责划分镜像
   * opencodeServe.streamEvents——完成/失败/超时判定归这里，signal 仅作 abort
   * 静默退出，不承担任何终止兜底）。每拍恰一次 GET transcript?agent_id=main，
   * 按 triggerPromptId === promptId 圈定本轮唯一 turn（锚 = spawn 记录的
   * turnAnchor.promptId/submitAt；历史轮/前任轮按构造不可能被误归属或重放）：
   *
   *   - turn 未出现（提交滞后）→ 等；silentTimeout（相对提交时刻）到期仍无 →
   *     silent fail（上游静默拒收的诚实退出）。R9 F3：silentTimeout 在场时这是
   *     无 turn 等待的**唯一**上界——8 拍无进展兜底不抢先（仅 silentTimeout
   *     缺席形状生效：turn 永不出现也有界，绝不无限等待）。
   *   - state=queued|running → 等；无进展兜底：连续 ≥8 拍
   *     （NO_PROGRESS_POLL_LIMIT）state 不变且 steps/frames 无增长 →
   *     done(failed, "turn stalled (no progress)")（首见拍建立基线——turn
   *     出现即进展；增长/state 变化任一发生即清零）。
   *   - 闭集外未知 state（R9 F4）→ 一律非终态、绝不猜终态，但独立有界：连续
   *     ≥8 拍 turn 在场且 state 仍闭集外 → done(failed, "unsupported turn
   *     state")——增长不清零该计数（客户端已知该 state 不受支持，等待增长没有
   *     意义）；state 恢复闭集内即回正常路径（计数清零）。
   *   - state=completed → steps[].frames 取 kind==="text" 且 role==="assistant"
   *     （或无 role 的 text 帧，按实测宽容）按序拼接；**发射前复检非空**——
   *     空/纯空白 ⇒ done(failed) 收口（N1 教训：传输成功不是可用答案，绝不
   *     伪造完成）；发射 user echo（turn.prompt，在场且非空才发）+ assistant
   *     text + usage（steps[].usage 求和 → metrics 事件）+ done(completed)。
   *     **只发射该 turn 的内容**。
   *   - state=failed|cancelled → done(failed, turn.error 字段或固定文案；R9 F2：
   *     拼装后过与 request 层同一 redactToken 清洗——token 值绝不经此路径进
   *     事件流)。
   *
   *   - onPollTick 每拍恰一次（correctable run 的纠偏投递钩子——runManager 经
   *     events 工厂传入；best-effort，钩子抛错绝不杀死事件流）。
   *   - 轮询 HTTP 失败（request 内重试耗尽后抛出）→ done(failed, 错误消息)；
   *     transcript 缺 items 数组的固定错误同路径（fail-closed，绝不回落猜测
   *     形状）；null/undefined 等非 Error 抛出值在消费前包成固定文案
   *     （errorText——"request failed with non-error throw"；request() 自身仍
   *     原样抛出）。
   *   - signal.aborted → 静默 return（不 emit done，终态归 RunManager）。
   * metrics（reportsTokenUsage=true）：completed 轮发射恰一次 metrics 事件
   * （steps[].usage 四计数求和映射，见 metricsEventFromTurn；usage 数据全缺席
   * 则不发——绝不虚构零值通道）。事件顺序：user echo → assistant text →
   * metrics → done(completed)。
   */
  async *streamEvents(agent, sessionId, {
    signal, interval = 1000, silentTimeout, onPollTick, turnAnchor,
  } = {}) {
    // 归属键：spawn 传入的 promptId（非空字符串才可匹配；缺失/直调防御形状
    // 匹配不到任何 turn ⇒ 由 silentTimeout / 无进展出口有界收口，绝不发明归属
    // 启发式）。anchorTime = 提交时刻（silentTimeout 的计时原点）。
    const promptId = typeof turnAnchor?.promptId === "string" && turnAnchor.promptId.length > 0
      ? turnAnchor.promptId
      : null;
    const anchorTime = typeof turnAnchor?.submitAt === "number" ? turnAnchor.submitAt : Date.now();
    // 无进展计数：turn 首见拍建立基线（清零——turn 出现 = 进展，提交滞后的解除
    // 不算停滞）；此后 signature（state + steps/frames 结构投影）不变即累进，
    // ≥NO_PROGRESS_POLL_LIMIT → 有界收口（R9 F3 后无 turn 分支只在 silentTimeout
    // 缺席时才累进此计数——见分支内注释）。
    let noProgressPolls = 0;
    let turnSeen = false;
    let lastSignature = null;
    // R9 F4：闭集外 state 的独立有界计数——turn 在场且 state 不在支持闭集的
    // **连续**拍数（turn 消失或 state 回闭集内即清零）。steps/frames 增长**不**
    // 清零此计数（与普通停滞门分工：那守"受支持的非终态停滞"，这守"状态本身
    // 不受支持"——等待增长没有意义）。
    let unsupportedStatePolls = 0;
    while (!signal?.aborted) {
      // onPollTick 每拍恰一次，置于轮询观察之前；best-effort——钩子抛错绝不
      // 杀死事件流。
      if (typeof onPollTick === "function") {
        try { await onPollTick(); } catch { /* best-effort: never kill the event stream */ }
      }
      let items;
      try {
        items = (await this.transcript(agent, sessionId)).items;
      } catch (error) {
        yield doneEvent("failed", errorText(error));
        return;
      }
      const turn = promptId === null ? null : findTurnByPromptId(items, promptId);
      if (turn === null) {
        // 提交滞后：turn 尚未出现在 transcript——等；silentTimeout（相对提交
        // 时刻）到期仍无 → silent fail。
        if (silentTimeout && (Date.now() - anchorTime) > silentTimeout) {
          yield doneEvent(
            "failed",
            `silent timeout: turn for this prompt not observed within ${silentTimeout}ms (provider may have silently rejected)`,
          );
          return;
        }
        // R9 F3：silentTimeout 在场时，无 turn 等待**只**以 silentTimeout 为界
        //——8 拍无进展兜底绝不抢先（旧形状：silentTimeout=60s、interval=1s 时
        // 第 8 秒即失败，把"慢出现的合法 turn"误杀成失败）。兜底仅在
        // silentTimeout 缺席（null/undefined——防御形状，如直调/测试注入）时
        // 生效：turn 永不出现也有界，绝不无限等待。
        if (!silentTimeout) {
          noProgressPolls += 1;
          if (noProgressPolls >= NO_PROGRESS_POLL_LIMIT) {
            yield doneEvent(
              "failed",
              `turn stalled (no progress): turn not observed for ${NO_PROGRESS_POLL_LIMIT} consecutive polls (bounded exit, silentTimeout absent)`,
            );
            return;
          }
        }
        // turn 不在场不是"闭集外 state"的延续——F4 连续计数在此清零。
        unsupportedStatePolls = 0;
        await sleep(interval);
        continue;
      }
      const state = turn.state;
      if (state === "failed" || state === "cancelled") {
        // 终态（闭集后三之二）：error 字段在场则透传（实测形状："Model not
        // set"），缺席用固定文案——不虚构原因。R9 F2：turn.error 是上游回显
        // 文本，走的是 HTTP 200 成功路径（transcript 信封 code===0），不经
        // request() 的 sanitizeError 出口——失败文案拼装后必须过与 request 层
        // 同一 redactToken 清洗（token 值 → "<redacted>"）。token 解析缺席时
        // 传 null（redactToken 对空 token 原样透传——清洗层绝不抛错改写终态
        // 路径；能走到这里必然已成功请求过 transcript，缺席只是防御形状）。
        let redactTokenValue = null;
        try {
          redactTokenValue = resolveBearerToken(agent);
        } catch { /* env 缺席：清洗退化为无操作 */ }
        yield doneEvent("failed", turnFailureText(turn, redactTokenValue));
        return;
      }
      if (state === "completed") {
        // 答案切片：仅该 turn 的 steps[].frames（kind==="text" 且 role===
        // "assistant" 或无 role——实测宽容，两形状都见过），按 step/frame 顺序
        // 拼接为单条 assistant text；thinking 帧不投影（v8 无需求）。
        const text = assistantTextOfTurn(turn);
        if (text.trim().length === 0) {
          // 发射前复检非空（N1 教训）：completed 轮无 assistant text ⇒ 不伪造
          // 完成，按 failed 收口。
          yield doneEvent(
            "failed",
            "kimi turn completed without assistant text (state=completed, no text frames — refusing to fabricate completion)",
          );
          return;
        }
        if (typeof turn.prompt === "string" && turn.prompt.length > 0) {
          yield messageEvent("user", [{ type: "text", text: turn.prompt }]);
        }
        yield messageEvent("assistant", [{ type: "text", text }]);
        const metrics = metricsEventFromTurn(turn);
        if (metrics !== null) {
          yield metrics;
        }
        yield doneEvent("completed");
        return;
      }
      // R9 F4：闭集外未知 state（queued|running|completed|failed|cancelled 之外
      //——上游升级/形状漂移）：一律非终态、绝不猜终态，但**独立有界处置**——
      // 客户端已知该 state 不受支持，等待内容增长没有意义（增长 ≠ 将到达受支持
      // 终态；旧形状把闭集外值折进普通等待分支，steps/frames 增长会清零停滞计数
      // 且 silentTimeout 不覆盖 turn 已出现的分支 → 永等）。连续 ≥8 拍
      // （NO_PROGRESS_POLL_LIMIT）turn 在场且 state 仍闭集外 → done(failed,
      // "unsupported turn state")；**增长不清零此计数**。state 恢复闭集内（下方
      // queued|running 分支/上方终态分支）即回正常路径（计数清零）。
      if (state !== "queued" && state !== "running") {
        unsupportedStatePolls += 1;
        if (unsupportedStatePolls >= NO_PROGRESS_POLL_LIMIT) {
          yield doneEvent(
            "failed",
            `unsupported turn state: ${String(state)} (outside the supported closed set `
            + `queued|running|completed|failed|cancelled — bounded exit after ${NO_PROGRESS_POLL_LIMIT} `
            + "consecutive polls; growth does not extend this bound because the client already "
            + "knows this state is unsupported)",
          );
          return;
        }
        await sleep(interval);
        continue;
      }
      unsupportedStatePolls = 0;
      // queued | running（受支持的非终态）：等（绝不猜终态）。无进展兜底 =
      // signature（state + steps/frames 结构投影）连续 NO_PROGRESS_POLL_LIMIT
      // 拍不变 → done(failed)；首见拍建立基线（清零），steps/frames 增长或
      // state 变化任一发生即清零。
      const signature = turnSignature(turn);
      if (!turnSeen || signature !== lastSignature) {
        turnSeen = true;
        lastSignature = signature;
        noProgressPolls = 0;
      } else {
        noProgressPolls += 1;
        if (noProgressPolls >= NO_PROGRESS_POLL_LIMIT) {
          yield doneEvent(
            "failed",
            `turn stalled (no progress): turn state unchanged and no steps/frames growth for ${NO_PROGRESS_POLL_LIMIT} consecutive polls (bounded exit)`,
          );
          return;
        }
      }
      await sleep(interval);
    }
  }

  /**
   * 统一请求门：镜像 opencodeServe.request 的超时/重试/204 处理，外加 kimi web
   * 的 {code,msg,data} 信封判定——非 2xx 或 body.code!==0 都算失败（抛含 msg 的
   * 错误）。Bearer 头从 process.env[agent.tokenEnv] **每次请求**解析（不缓存）。
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
            const text = await response.text();
            throw new Error(
              `kimi web request failed ${response.status}: ${redactToken(text, token)}`,
            );
          }
          if (response.status === 204) {
            return null;
          }
          const body = await response.json();
          if (body && typeof body === "object" && body.code !== undefined && body.code !== 0) {
            throw new Error(
              `kimi web request failed (code ${body.code}): ${redactToken(String(body.msg ?? "unknown error"), token)}`,
            );
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
            : (error.name === "AbortError" || isTransient(error));
        if (!retryable || attempt === this.retries) break;
        await sleep(1000 * 2 ** attempt);
      }
    }
    // #3：最终抛出点统一清洗（全出口）。
    throw sanitizeError(lastError, token);
  }
}

// Bearer token 每次请求时从 process.env[agent.tokenEnv] 读取；字段缺失或 env 未设
// → 固定安全形状错误（只点名 env 变量名，绝不回显 env 内容——token 值永不进
// 错误消息/transcript/日志）。
function resolveBearerToken(agent) {
  const name = agent?.tokenEnv;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(
      "kimi-web backend requires tokenEnv (non-empty string; the bearer token env var name)",
    );
  }
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`kimi-web backend: bearer token env ${name} is not set (refusing dispatch)`);
  }
  return value;
}

// 归属键匹配（v8 完成判定的唯一入口）：items[] 里 triggerPromptId === promptId
// 的 turn（live 形状：kind:"turn"——文档化形状之外的条目 fail-closed 不匹配，
// 由有界出口兜底）。prompt_id 唯一 ⇒ 至多一个命中；首个命中即归属。
function findTurnByPromptId(items, promptId) {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (item?.kind === "turn" && item.triggerPromptId === promptId) {
      return item;
    }
  }
  return null;
}

// completed 轮答案切片：该 turn 全部 steps（按序）的全部 frames（按序）里
// kind==="text" 且（role==="assistant" 或无 role——实测宽容，两形状都见过）的
// text 直接拼接为单条 assistant text。thinking 帧不投影（frames 闭集
// thinking|text，v8 无 thinking 投影需求）；非字符串 text 的帧跳过（形状不可用，
// 不计入拼接——空结果由调用侧的发射前复检收口）。
function assistantTextOfTurn(turn) {
  const parts = [];
  for (const step of Array.isArray(turn?.steps) ? turn.steps : []) {
    for (const frame of Array.isArray(step?.frames) ? step.frames : []) {
      if (frame?.kind !== "text") continue;
      if (frame.role !== undefined && frame.role !== null && frame.role !== "assistant") continue;
      if (typeof frame.text !== "string") continue;
      parts.push(frame.text);
    }
  }
  return parts.join("");
}

// 终态失败文案（failed|cancelled 轮的 done(failed) 错误）：turn.error 字段在场
// 则透传（实测形状：缺 model 秒败轮的 error:"Model not set"），缺席用固定文案
// ——不虚构原因。R9 F2：拼装结果过 redactToken（与 request 层**同一**模块级
// 实现，不复制第二份）——turn.error 是上游回显文本，走 HTTP 200 成功路径，
// 不经 request()/sanitizeError 出口，token 值可能藏在其中，绝不原样进
// done.error/事件流。token 形参 null/undefined 时 redactToken 原样透传（清洗
// 退化为无操作）。
function turnFailureText(turn, token) {
  const state = turn?.state;
  const verb = state === "cancelled" ? "cancelled" : "failed";
  const error = typeof turn?.error === "string" && turn.error.length > 0 ? turn.error : null;
  const text = error === null
    ? `kimi turn ${verb} (turn state=${String(state)}, no error field upstream)`
    : `kimi turn ${verb} (turn state=${String(state)}, error: ${error})`;
  return redactToken(text, token);
}

// 无进展 signature：turn 的结构投影（state + steps 数 + 每 step 的 stepId/state/
// frames 数与文本总量）。steps/frames 增长、frame 文本增长或 state 变化都会改变
// signature（= 进展，计数清零）；usage 不入 signature（无进展判据钉死在
// "state 不变且 steps/frames 无增长"）。
function turnSignature(turn) {
  const steps = Array.isArray(turn?.steps) ? turn.steps : [];
  const parts = [];
  for (const step of steps) {
    const frames = Array.isArray(step?.frames) ? step.frames : [];
    let textLength = 0;
    for (const frame of frames) {
      if (typeof frame?.text === "string") textLength += frame.text.length;
    }
    parts.push(`${String(step?.stepId ?? "?")}:${String(step?.state ?? "?")}:${frames.length}:${textLength}`);
  }
  return `${String(turn?.state ?? "?")}|${steps.length}|${parts.join(",")}`;
}

// completed 轮 usage 求和 → metrics 事件（reportsTokenUsage=true 的通道）：该
// turn 全部 steps[].usage 按 USAGE_FIELDS 映射求和（1:1 语义映射，不发明聚合；
// reasoning/costUsd 无 kimi 对应字段——metricsEvent 省略，只带实测通道）。任一
// usage 数字在场才发事件（全缺席 ⇒ null——绝不虚构零值通道）。只计本轮 steps
// ——历史轮 usage 按构造不可能混入。
function metricsEventFromTurn(turn) {
  const sums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let seen = false;
  for (const step of Array.isArray(turn?.steps) ? turn.steps : []) {
    const usage = step?.usage;
    if (!usage || typeof usage !== "object") continue;
    for (const [kimiField, axis] of USAGE_FIELDS) {
      const value = usage[kimiField];
      if (typeof value === "number" && Number.isFinite(value)) {
        sums[axis] += value;
        seen = true;
      }
    }
  }
  return seen ? metricsEvent(sums) : null;
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

