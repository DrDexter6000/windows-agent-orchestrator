// src/backends/zcode.js
//
// 第 8 个 backend「zcode」（进程式 stdio app-server）：驱动智谱 ZCode 桌面版
// 捆绑 CLI 的 `app-server` 子命令（ZCode Protocol v1，行分隔 JSON）。闭集 7→8
// 扩员经 Owner 2026-10-01 批准接线。
//
// 上游协议事实（live 事实 = 2026-10-01 本机实测 zcode.cjs 0.16.9，探针
// %TEMP%\wao-probe-20260930\zcode-probe*.cjs 只读参照；bundle 源码事实 =
// 同日对桌面捆绑 zcode.cjs（sha256 FAD4C35C…E6275F，15450 行）的只读核证，
// 行号在案——live 与 bundle 两类证据在下文分别标注）：
//   - 入口：`node <zcodeCliPath> app-server`。zcodeCliPath = agent.binary，指向
//     桌面版捆绑 CLI（本机 D:\...\ZCode\resources\glm\zcode.cjs）——**该路径随
//     桌面更新漂移**，故 binary 必填、由 registry 提供（不猜 PATH）。登录态与
//     桌面版共享（无需额外认证；凭据不在 env 面，envPolicy 无可选继承名）。
//   - 信封：行分隔 JSON，**非标准 JSON-RPC**——请求 `{id, method, params}`（带
//     `jsonrpc` 字段会被上游 zod 拒收）；响应 `{id, result|error}`（error 含
//     code/data.name/message——zod 校验错误逐字段教学，如实透传有界错误文本）。
//   - **双向**：server 会向 client 发请求，且 client 的应答会被上游 zod 逐方法
//     校验（zcode.cjs:15262 resolveClientRequest → resultSchema.parse，解析失败
//     = 服务端请求 reject）——应答空对象对带必填字段的方法是**校验失败**，不是
//     安全默认。逐方法应答形状（schema 全部 bundle 核证，zcode.cjs:72）：
//     `session/requestRuntimePreferences` → `{nativeSearchEnhancementsEnabled:false}`
//     （pGt：该 boolean 必填、其余字段有缺省；不应答则 session/create 15s 超时——
//     live 实测）；`interaction/requestUserInput` → `{action:"decline"}`（CYe：
//     action ∈ {accept,decline,cancel} 必填）；`interaction/requestPermission` →
//     `{decision:"deny"}`（JL：decision ∈ {allow,deny,escalate,modify} 必填——
//     **绝不自动授权**）；`interaction/requestProviderRuntimeHeaders` →
//     `{headersApplied:false}`（DGt 判别联合的 false 臂）；`interaction/
//     requestOfficialMcpAuthHeaders` → `{ok:false,reason:"official_auth_unavailable"}`
//     （OGt 的 ok:false 臂 reason 必填且 ∈ PHt 枚举——裸 {ok:false} 过不了校验）。
//     其余未知方法照此应答**显式错误帧** -32601（无交互 client 可代答的诚实拒绝，
//     绝不猜 schema）。通知（无 id：startup/storageState 等）忽略即可。
//   - `session/create` params `{workspace:{workspacePath, workspaceKey}}` →
//     result.session.sessionId（sess_ 前缀）、result.session.model、
//     result.settings.model.available[]、result.projection（status 等）。
//   - `session/setModel` params `{sessionId, model:{providerId, modelId,
//     options:{reasoningLevel?}}}`——providerId="bigmodel-api"、modelId=
//     "GLM-5.3"|"GLM-5.3-Flash" 已 live 验证（GLM provider 系 Owner 在桌面 UI
//     配好）。缺 reasoningLevel 时部分模型报 "Reasoning level is required"。另有
//     `session/setThoughtLevel {sessionId, thoughtLevel}`（v1 不用）。expectedRevision
//     v1 不传（跨轮 revision 追踪未实测，不发明）。
//   - `session/setMode {sessionId, mode}`（fresh 与 resume 都发，setModel 之后、
//     提交之前固定 mode:"yolo"）：无头 CLI `-p` 默认即 yolo（--help 在案：
//     "default: yolo for --prompt"），而 app-server 的 session/create 默认 build
//     （安全默认、写需许可）——scorecard 实测 GLM-5.3 写文件被权限层拦截
//     （"Write tool was blocked by the WAO headless permission layer"，
//     runs/reliability/run_20261001213724000cy1b3a）。worker 无人值守，写许可必须
//     放开（与其它席位 --dangerously-skip-permissions / permission_mode:"auto"
//     姿态对齐）。mode 枚举 = ["plan","build","edit","yolo","auto"]（bundle schema
//     $j 核证）；expectedRevision v1 不传（同 setModel 纪律）。setMode 失败 =
//     fail-closed 固定错误拒绝派发（权限没放开比派发失败更危险）。
//   - `session/send` params `{sessionId, content:<文本>}` →
//     `{accepted:true, stateRevision}`；消息经 `session/messages {sessionId}` 轮询：
//     result.messages[].parts[]（type:"text" 带文本；type:"step-finish" 带
//     reason:"stop" 与 tokens——**轮次完成信号**；type:"tool" 带 callId/tool/state
//     {status, input, output|error}——工具调用帧，completed 轮投影为证据事件，
//     形状见 zcodeToolIdentityEvents / zcodeToolResultEvents / projectTurnToolEvents 注释——TD-199 起台账驱动增量投影）。
//   - `session/usage {sessionId}` → 全量计量（totalTokens/inputTokens/outputTokens/
//     reasoningTokens/cacheReadTokens/cacheCreationTokens/modelRequestCount——字段名
//     以 bundle CRn 实现为准，zcode.cjs:15259；早期按 kimi 系惯例记的
//     cacheRead/cacheCreation 无 `/Tokens` 后缀，**不是上游形状**）——
//     reportsTokenUsage=true 的 live 证据（2026-10-01 非零实测）。
//   - `session/resume {sessionId}`（bundle 核证，live 未逐测——第三轮 auditor #1）：
//     **resume 轮 spawn 后必须先发它**，这是上游把持久化会话装载回内存并注册进
//     本进程会话表的唯一途径。依据链（zcode.cjs 行号在案）：15262 协议服务器
//     `sessions:new Map`（**每进程一张**，spawn 新进程 = 空表）；15256 setModel
//     实现 QKo 先走 requireSession；15245 requireSession（Xy）查表 miss 即抛
//     `"Session is not active: <id>"`；15256 resume 处理器 zKo → 装载器 wRn——
//     从 sessionStore 读持久化记录（miss 抛 "Session not found"）后
//     `sessions.set(sessionId,…)` 注册，唯一注册点除 create 外；72 行 rGt 参数
//     schema `sessionId` 必填（其余全可选）。故 resume 轮次序固定：
//     **resume → setModel → send**（跳过 resume 的 setModel 必然 "Session is not
//     active"）。resume 响应 = 与 create 同源的 snapshot（15256 zKo → D4 → sZo →
//     15251 QPn：session/settings/messages/projection…），据此做形状核验。
//   - 其他在册方法（bundle 方法表实证，形状未逐一实测）：`session/stop`（中止
//     候选——abort() 在进程仍活时先试它，形状未经 live 验证，按 `{sessionId}`
//     发送、失败/未知如实上抛固定错误）、`session/fork`、`session/subscribe`/
//     `session/event`（事件推送，v1 不用）。
//   - 无头 CLI 另有 `-p --json`（返回 sessionId/turnId/response/usage）与
//     `--resume sess_<id>`——v1 不用（无模型选择 flag），仅作参照。
//
// 完成判定（B′ 根修 2026-10-10 起为【身份切片】；v1-v4 的位置式判据退役）：
// 每拍一次 `session/messages`，本轮 = 基线消息 id 集**之外**的消息；锚点 U =
// 本轮新 user 消息（多条时以 sentContent 精确等值回显消歧，live 实证 echo
// t≈1s 在场）；完成 = 存在新 assistant 消息 A（A.parentID === U.id）且 A 的
// 末位 part 是 step-finish(stop|error)。历史变异（基线消息 id 有序序列不再是
// 当前快照前缀——头部插入/重排/删除/compaction 改写都会击穿）→ 具名失败
// "history mutated non-append"，绝不静默续用错位快照。resume 历史缺 info.id
// → 发送之前拒绝（session/send 帧数为 0，零 token）。依据链：live 探针实证
// （2026-10-10，glm-flash 真机三轮 fresh→同进程→跨进程 resume，消息
// info.id/role/parentID、part id/messageID/sessionID 全数在场且跨快照稳定，
// assistant info 另带 anchor.turnId——上游原生轮次身份原语在场；证据
// .dev/bprime-evidence/）+ 双席方案会审（consult_20261010134035145ef1yzp，
// opus 席 bundle 源码预警 + kimi 席观测面清单）+ 验收反例组（test
// ⑨h 头插假完成/⑨i 头插+真新轮/⑨j 合法同文/⑨k 错 parent/⑨l 缺 id 拒派/
// ⑫f 旧证据不重发；⑨h/⑨i/⑨k/⑨l/⑫f 在旧位置判据上实证红）。旧判据
// （全局尾部 step-finish 且序号 ≥ 基线）的缺陷：头部插入使旧 stop 右移入
// 区间 → 假 completed + 发射旧答案，连带击穿 0052 失败即弃（假 completed 让
// 下一轮照常 resume 半死会话）与 run_lineage 交付链（finish 杀死真在跑的
// 续接轮）——B′ 残余就此关闭。判据不命中的等待形状由无进展兜底
// （**已有产出后**连续 60 拍无新 part → done(failed,
// "turn stalled")；60 = 60s @ 1s 轮询——GLM-5.3 步间静默实测 8-14s ×4 余量，
// 首轮 8 拍门被步间 reasoning 误杀，第二轮 live 诊断 run_20261001203009794bb6add
// 在案，取值依据见 NO_PROGRESS_POLL_LIMIT 注释）有界收口；零 part 阶段（正常
// 思考中——GLM-5.3 high reasoning 首 part 延迟实测 >8s，
// run_20261001195259045cle1ft）该门不生效，改由 silentTimeout（在场）或零 part
// 思考预算（缺席，120 拍）有界收口。通信失败 =
// 进程死 = done(failed)（stdio 无 HTTP 重试面；请求超时/传输关闭同路径）。
//
// **TD-199（2026-10-02）证据投影同乘追加假设**：增量台账按 part 序号键控
// （live 实证 callId 缺席、partId 跨快照稳定性未证实——见 projectTurnToolEvents
// 注释），头插同样使台账错位（漏发/重发证据）；可检测的**缩短**已 fail-closed
// （snapshot shrank → done(failed)），不可检测的头插与完成判据同残余等级。
//
// assistant 文本切片的诚实边界：上游消息表未实证携带 role 标注（live 事实只有
// parts 的 type 闭集 text|step-finish）——`session/send` 的 content 若以 text part
// 回显进 messages，按**精确等值**剔除首个匹配（找得到回显 → 取其后；找不到 →
// 全量拼接）。两种上游形状都不会把 prompt 误报成 assistant 产出；剔除后为空 =
// 按 failed 收口（N1 教训：传输成功不是可用答案，绝不伪造完成）。tool part 的
// 形状后经 bundle zod schema 核证（见 zcodeToolIdentityEvents 注释）——
// completed 轮投影为证据事件（file_written/command/tool_use/tool_result，2026-10-01
// 补齐，kimi-web F2 同族）；其余 part 类型（reasoning/file/patch/compaction/…）仍
// 未投影、不猜（reportsCommandExitCode=false 同源）。
//
// 结构纪律：镜像 deepSeekAcp.js（同为双向 stdio 行协议的进程式 backend）+
// processBackend.js 的进程管理惯例（可注入 spawnFn、buildChildEnv 安全继承、
// compileInvocation argv 预算、taskkill /T /F 树杀、stderr 尾部诊断脱敏）。
// 零新增依赖（仅 node: 内置）。

import { spawn } from "node:child_process";
import readline from "node:readline";

import {
  commandEvent,
  doneEvent,
  fileWrittenEvent,
  messageEvent,
  metricsEvent,
  runtimeActivityEvent,
  toolResultEvent,
  toolUseEvent,
} from "../runEvent.js";
import { inheritedEnvNames } from "../envPolicy.js";
import { createSecretRedactor, isSecretEnvName } from "../secretRedaction.js";
import { buildChildEnv, compileInvocation, isProcessPlaceholderSessionId } from "./processBackend.js";
import { performance } from "node:perf_hooks";
import { createStallTracker } from "./stallBudget.js";
import { describeProcessActivity, fingerprintWorkingTree, snapshotDescendants } from "./processActivity.js";

const BACKEND_NAME = "zcode";

// role/task 分隔符对齐 kimiCode.js / kimiWeb.js 的 ROLE_TASK_SEPARATOR——三个
// prompt 级角色合同通道的 backend 用同一分隔形状，避免两套事实并存。
export const ZCODE_ROLE_TASK_SEPARATOR = "\n\n---\n\n";

// 无进展兜底阈值：**已有产出后**连续 60 拍轮询无新 part → done(failed,
// "turn stalled")（真停滞的有界收口）。零 part 阶段（本轮基线后尚无任何产出）
// 本门**不生效**——分相纪律 kimiWeb R9 F3 同族，缺席分支由下方思考预算收口。
//
// 60 的取值依据（2026-10-01 第二轮 live 诊断，探针 zcode-live-diag*.cjs @
// %TEMP%\wao-probe-20260930 只读参照）：GLM-5.3 high reasoning 工具任务的 part
// 时间线（1s 轮询实测）t=1s text echo → t=4s step-start → t=4s~18s 无任何新
// part（模型步间 reasoning）→ t=18s step-finish——步间静默实测 8-14s；且
// reasoning 进展可能不逐拍暴露（上游或整步一次刷出：同日诊断实测 t=8s→t=10s
// 一跳 5 parts），「拍间无新 part」不等于「模型死了」。首轮的 8 拍门（8s）恰被
// 实测步间延迟击穿：delta drill run_20261001203009794bb6add 在 session.created
// 后 20s 报 "turn stalled (8 consecutive polls)"（echo+step-start 两拍产出后
// 静默 8 拍即误杀）。60 拍 = 实测最坏 14s × 4 余量 ≈ 56s → 取整 60s；轮次真死
// （上游不发 step-finish 且 60s 无变化）仍由本门有界收口。
//
// 否决的两段式（步内 30 拍 + 总 120 拍）：「总静默预算」按静默拍累计——长工具
// 任务的多个正常步间 reasoning 会累计击穿（如 10 步 × 12s ≈ 120s 即误杀），
// 「总时长预算」则会杀掉带持续产出的长轮——单一「单次静默间隙」门不引入这两类
// 新误杀面，语义最诚实（真死轮的恢复延迟 60s 可接受：与零 part 预算同数量级）。
//
// TD-197①（2026-10-03，双席会审 v2 + 实测校准修正）：旧 60 拍门（生产
// pollInterval=5000ms ⇒ 实际 300s 静默预算——会审 brief 曾误写"≈60s"，本注释
// 为修正后事实）一周内四次误杀真实工作（2026-10-02 ×3 报告/打包阶段 + 
// 2026-10-03 run_20261003093816570xtkvw4）。**实测校准**（turn 段事件间隙，
// 真实转录）：成功完成的同任务重试 run_20261003094617447bqyhql turn 内合法
// 静默最大 **276s**（次大 215s/119s——GLM-5.3 撰写大文件体时的批间静默），
// 旧 300s 门恰压在观测最大值上；10-02 被杀 run_20261002144448432xikf8k 先验
// gap 120s。故取 **floor=300s（恰不紧于旧门，永不收紧）×3 自放大 / 600s 硬顶**
// ——预算区间 [300s,600s] 严格宽于旧门：先验 120s gap 的 run 预算 360s，其
// 301s 终末静默（旧门杀点）存活；观测 276s 的 run 预算封顶 600s。有界性不破
// 坏（真停滞最迟静默段 ≥600s 收口；顶约束静默段而非墙钟——每拍另有请求/
// 重试/睡眠叠加，不宣称严格墙钟上界）。进度定义不变（parts 增长）；零 part
// 门与 silentTimeout 优先级不变。auditor 会审数值（floor 120s）基于错误的
// 1s-间隔前提，已被本实测校准取代（Lead 裁定，会审记录在案）。
const NO_PROGRESS_FLOOR_MS = 300_000;
const NO_PROGRESS_FACTOR = 3;
const NO_PROGRESS_CEILING_MS = 600_000;

// 流活性证词（2026-10-12，Carloha 消费者侧反馈 + 三轮 glm-pro 真机探针）。
//
// 事故形态：run_20261012102243802j45ncc / run_20261012104046786m8kann——整文件
// 重写类任务上 GLM-5.3（max/high）单个模型请求连续思考数分钟，被停滞门判
// "turn stalled" 零产出收掉。zcode 自身日志实证模型没有卡死：被杀前的那次请求
// 237s 内收了 11,419 个 reasoning 分片（约 4.4 万字符）。
//
// 探针实证的上游行为（zcode CLI 0.16.9，glm-pro max）：
//   - `session/messages` 快照在一步完成之前**完全不暴露**该步的 reasoning：
//     探针里 step-start 之后 35-45s 快照零变化，随后 reasoning/text/step-finish
//     三个 part 一次性出现——"part 个数增长"这个进展定义对长思考步天然失明，
//     内容长度也无从观察（part 根本不在）。
//   - 同一时段 app-server 在 stdout 上持续推送通知帧 `v4/telemetry/event`，
//     其中 `params.kind === "stream.chunk"`（`channel`: thought/text，带数值
//     `chunkLength` 与 `sessionId`）逐分片一帧（一次 27s 的思考 2725 帧）。
//     此前 wire 对一切通知帧一律忽略。
//
// 用法（决定 0067，Owner 2026-10-12："没有任何生命体征才由控制面收口；只要有
// 生命体征就不轻易放弃，放弃与否由 Lead 决定，WAO 只做建议"）：任何一道收口门
// 到点（零 part 的 silentTimeout / 思考预算，已有产出后的停滞预算）都先看生命
// 体征，有任何一项就不收口：
//   ① 流分片——该会话在最近 STREAM_ATTEST_RECENCY_MS 内收到过流分片：上游正在
//      出 token，是"零 part 的活"不是停滞；
//   ② 进程活动——宿主进程的后代在 PROCESS_ACTIVITY_WINDOW_MS 的观察窗内有 CPU /
//      I/O / 进程生灭：工具命令在跑（测试、构建、后台任务）时模型不出 token、
//      快照不长 part，在动的是这些子进程。真实转录普查：12 次被停滞门收掉的运行
//      里 7 次死时有工具调用在途；
//   ③ 工作树变化——同一观察窗内，工作目录里已改动/未跟踪文件的清单、mtime 或
//      大小变了（输出交付物）；
//   ④ 上游重试等待——本轮主轮请求（querySource=main_turn 且 turnId 是本轮）的
//      model_retry_scheduled：上游在按 delayMs 退避，有效到到达时刻 + delayMs +
//      余量；每个安排（同 requestId 同 attempt）只在首见时立窗、其重复通知一律
//      不延长，链上其后出现
//      started/completed（换 requestId 也算）、turn 结束或换轮即作废且**粘住**——
//      作废前首见的安排连同其重复通知不再立窗，只有作废之后新出现的安排才能。
//      续命落 runtime_activity("provider_retry")（零载荷、节流）。failed 与
//      stream_stalled 本身不续命——只说明出过问题，不说明还在推进。时间边界
//      （maxAttempts 数总尝试、单请求只有流空闲超时、退避有上限不重置、整轮
//      总时长上界未知）见 createUpstreamRequestTracker 注释。
// ②③ 的判据、读数与看不到的形态见 processActivity.js。四项都没有 ⇒ 收口，文案
// 写明取到的读数；本轮主轮请求链的最后状态已知时，文案末尾追加有界上游摘要
// （闭集 status + 整数 statusCode + attempt/maxAttempts，绝不带 reason）——诊断
// 按这段摘要归因。
//
// **停滞续命没有任何自动上限**（同日早些时候的"续命静默满 120min 收口"硬顶已删）：
// 活着但迟迟不收尾的运行由 Lead 决定去留。控制面的职责是让 Lead 看得见（流在收
// 时节流发射 runtime_activity("streaming")，等待类命令据此显示有活动）并且停得掉
// （stop 经 session.created.hostPid 击杀本进程树，同批修通）。本条只管这三道
// "等不到进展"的门：协议错误、传输关闭、快照缩短、历史变异这些"证据归属不可信"
// 的失败照旧立即收口，不看生命体征。
//
// 取证只在"原本要收口"的那一刻发生：门到点且流不在收 ⇒ 取一次后代快照与工作树
// 指纹作基线，PROCESS_ACTIVITY_WINDOW_MS 之后再取一次比对（各约 1s 以内，不进
// 常规轮询）。取样本身占用时间，其间可能来了流分片或落了 part——所以比对得出
// "没有活动"后**不当拍收口**，先记下事实，下一拍照常轮询一遍（看快照、看流
// 计数），仍无进展才执行。两项证词都不适用（非 Windows 且非 git 目录）时没有
// 取样发生，立即收口，与此前一致；进程快照瞬时失败则下一拍重取，连续
// PROCESS_PROBE_MAX_FAILURES 次才按取不到处理。
//
// 只放宽、永不收紧：证词只在"原本要杀"的那一刻参与；上游改名/改形状/不再推送
// ⇒ 识别不到分片 ⇒ 行为退回只看进度与本机读数。流分片是上游内部遥测通道，形状
// 仅在上述版本实测过——诚实边界写在这里，不宣称稳定合同。
const STREAM_TELEMETRY_METHOD = "v4/telemetry/event";
const STREAM_CHUNK_KIND = "stream.chunk";
const STREAM_ATTEST_RECENCY_MS = 60_000;

// ===== 第四种生命体征：本轮主轮请求的重试等待（2026-10-15 探针事实） =====
//
// 额度耗尽时的长静默形态：zcode 在按 delayMs 退避重试本轮主轮请求。重试等待期
// 上游不出流分片（①失明）、无本地计算（②失明）、无产出落盘（③失明）——三道
// 收口门会把"上游在退避"误收成"已死"。数据源 = 同一路通知 `v4/telemetry/event`
// 里 `kind === "model.request.status"`（schema Zms，strict；Lead 2026-10-15 实测
// 事实记录 + 安装包只读核证，见 createUpstreamRequestTracker 注释）。
const TURN_STARTED_KIND = "turn.started";
const TURN_TERMINAL_KIND = "turn.terminal";
const MODEL_REQUEST_STATUS_KIND = "model.request.status";
const MAIN_TURN_QUERY_SOURCE = "main_turn";
// status 闭集（安装包 Zms schema 的 enum literal，全部成员在此列出）。
const MODEL_REQUEST_STATUSES = Object.freeze([
  "model_request_started",
  "model_request_completed",
  "model_request_failed",
  "model_retry_scheduled",
  "model_stream_stalled",
]);
// 重试等待续命的余量：zcode 的退避睡眠恰好睡 delayMs（Noe(mt, signal)），睡醒后
// 下一次尝试还要经排队、建连、首发事件才发 model_request_started，控制面轮询
// （生产 5s/拍）再叠加观察延迟。30s 覆盖这些环节且小于流分片新鲜度窗（60s）
// ——凭经验取值，无统计依据。
const RETRY_GRACE_MARGIN_MS = 30_000;
// 可采纳为续命窗的 delayMs 上界（具名 1 小时）。安装包事实（zcode.cjs ~2176）：
// server retry-after 的采纳条件是「≤300s（tHs = 5×6e4）**或**小于未封顶的计算
// 退避值」——缺省参数（baseDelayMs 2s、factor 2、attempt 从 1 起数）下未封顶的
// 指数项第 11 次尝试已达 2s × 2^10 ≈ 2048s，ZCODE_MODEL_RETRY_* 环境变量还能
// 放大 baseDelayMs/factor，故合法 delayMs 可远超 300s（缺省参数、第 9 次尝试、
// retry-after 400000ms ⇒ 采纳 400000ms）。1 小时宽于一切已核证的缺省形状，只拒
// 非有限值、负数与超过它的值（fail-closed）。
const RETRY_DELAY_MAX_MS = 3_600_000;
// 流在收时向转录发 runtime_activity("streaming") 的最小间隔：一分钟一条——流活着
// 时，任何满 60s 的观察窗内至少有一条（更短的单次等待可能遇不上，体征年龄仍按
// 最后一条算）。
const STREAM_ACTIVITY_EMIT_MIN_INTERVAL_MS = 60_000;
const PROCESS_ACTIVITY_WINDOW_MS = 30_000;
// 收口门凭进程活动 / 文件变化续命时落转录事实的最小间隔（零 part 两道门到点后
// 每个观察窗都会续命一次，不节流会每 30s 一条）。
const VITAL_SIGN_EMIT_MIN_INTERVAL_MS = 60_000;
const PROCESS_PROBE_MAX_FAILURES = 3;

// 零 part 思考预算（silentTimeout 缺席时的兜底上界）：连续 120 拍无任何 part →
// done(failed)。取值沿用上轮裁定（首轮 live 证据 run_20261001195259045cle1ft：
// GLM-5.3 high reasoning 首 part 延迟 >8s；当时按 NO_PROGRESS_POLL_LIMIT × 15
// 推导得 120）。本轮停滞门提到 60 后两预算**显式解耦**（再按 ×15 推导会得 900，
// 非本意）：两者语义本就不同——零 part = 首产出前的冷启动/深思考/上游排队（更
// 不确定 → 120 拍 + silentTimeout 优先），已有产出后 = 管道已证活、只剩步间间隙
// （实测 8-14s → 60 拍已 4 倍余量）。仍保底有界——绝不无限等待。silentTimeout
// 在场时本预算不参与（零 part 等待只以 silentTimeout 为界）。
const ZERO_PART_POLL_LIMIT = 120;

// 请求级超时：session/create 涉及 storage 装载（live 探针曾给 60s），其余 30s。
const CREATE_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
// abort 的 session/stop 上界（失败即上抛固定错误；进程树杀兜底——"启动树杀，
// 结果不核实"，见 defaultTreeKill 诚实边界）。
const STOP_TIMEOUT_MS = 5_000;

const STDERR_TAIL_LIMIT = 4000;
const BOUNDED_TEXT_LIMIT = 300;

// 轮询缺省间隔（RunManager 传 config.pollInterval，生产缺省 5000ms）。
const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * 上游原生模型 ref `<providerId>/<modelId>` 的拆分（恰好一个 "/"，两段非空）。
 * live 验证形状：bigmodel-api/GLM-5.3。返回 null = 不是该形状（调用方 fail-closed）。
 * registry.js 的 isZcodeModelRef 与本函数同形状（core 不上向 import backends，
 * 两处由 test/backends/zcode.test.js 的形状一致性用例互钉）。
 */
export function splitZcodeModelRef(id) {
  if (typeof id !== "string" || id.length === 0) return null;
  const slash = id.indexOf("/");
  if (slash <= 0 || id.indexOf("/", slash + 1) !== -1) return null;
  const providerId = id.slice(0, slash);
  const modelId = id.slice(slash + 1);
  if (providerId.length === 0 || modelId.length === 0) return null;
  return { providerId, modelId };
}

/** messages[] → 按序展平的 parts[]（缺 parts 数组的消息贡献零个 part，宽容）。 */
function flattenParts(messages) {
  const parts = [];
  for (const message of messages) {
    if (Array.isArray(message?.parts)) parts.push(...message.parts);
  }
  return parts;
}

// ===== B′ 根修（2026-10-10，双席方案会审 consult_20261010134035145ef1yzp 的 D 项
// + live 探针实证）：消息/part 身份切片 =====
//
// 探针（.dev/bprime-evidence/，glm-flash 真机三轮：fresh→同进程→跨进程 resume，
// sessionId sess_bd596853-e563-4a03-9e08-5e61d2815011）实证上游 shape：
//   - 消息：info.id（msg_*）、info.role、assistant 的 info.parentID 指向其宿主
//     user 消息（=轮次锚点）；assistant info 另带 anchor.turnId/orderedMessageIds
//     与 time.created/completed（上游原生轮次身份原语——B′ 关闭条件满足）。
//   - part：id（part_*）+ messageID（宿主回指）+ sessionID 全数在场。
//   - 跨快照稳定：生成中途连拍 ⊆ 终拍、顺序保持（追加语义下的 id 稳定）。
// 完成判据/证据台账自本批起按【身份】归属：本轮 = 宿主 user 消息不在基线 id 集
// 且 parent 指向它的 assistant 消息；历史变异（基线 id 序列不再前缀）具名失败。
// 旧位置式判据（「尾部 step-finish 且序号 ≥ 基线」）在头部插入下可被旧 stop 右
// 移击穿（发射旧答案并假 completed，还会连带击穿 0052 失败即弃——假 completed
// 让下一轮照常 resume 半死会话）——身份切片从构造上关死该窗口。

/** 消息身份（info.id/role/parentID；缺 id → null——调用方决定语义：历史缺 id
 * =派发前拒，新消息缺 id =本轮锚点不可解由有界收口兜底）。 */
function messageIdent(m) {
  const info = m?.info;
  if (!info || typeof info.id !== "string" || info.id.length === 0) return null;
  return {
    id: info.id,
    role: typeof info.role === "string" ? info.role : null,
    parentID: typeof info.parentID === "string" && info.parentID.length > 0 ? info.parentID : null,
  };
}

/** part 身份（id 非空字符串才可用；缺 id 的 part 在台账面保守跳过——完成判据
 * 只依赖消息级身份，不依赖 part id）。 */
function partIdOf(part) {
  return typeof part?.id === "string" && part.id.length > 0 ? part.id : null;
}

/**
 * 本轮锚点解析（纯函数）：newMsgs = 基线之后的消息（含 ident 与宿主 parts 文本）。
 * 锚点 U = 新 user 消息；多条时优先取 parts 含 sentContent 精确等值回显者
 * （live 实证 echo t≈1s 在场；上游偶发不回显时唯一候选即锚点，零候选=null 续
 * 等、多候选无回显=歧义 null 续等——两者均由既有有界收口兜底，绝不猜）。
 * @returns {{ id:string } | null}
 */
function resolveTurnAnchor(newMsgs, sentContent) {
  const users = newMsgs.filter((x) => x.ident?.role === "user");
  if (users.length === 0) return null;
  if (users.length === 1) return { id: users[0].ident.id };
  if (typeof sentContent === "string" && sentContent.length > 0) {
    const echoed = users.filter((u) => (u.message?.parts ?? []).some(
      (p) => p?.type === "text" && p.text === sentContent,
    ));
    if (echoed.length === 1) return { id: echoed[0].ident.id };
  }
  return null;
}

// session/usage 分量 → metrics 轴的 1:1 映射。字段名 = 上游 CRn 实现的实际形状
// （bundle 核证 zcode.cjs:15259：cacheReadTokens/cacheCreationTokens 带 Tokens
// 后缀；kimi 系的无后缀形状不是 zcode 形状——第三轮 auditor #2）。totalTokens 是
// 合计量（= 分量之和），绝不重复计入；modelRequestCount/modelErrorCount 无
// metrics 轴。任一分量在场才发事件（全缺席 ⇒ null——绝不虚构零值通道）。
const USAGE_FIELDS = Object.freeze([
  ["inputTokens", "input"],
  ["outputTokens", "output"],
  ["reasoningTokens", "reasoning"],
  ["cacheReadTokens", "cacheRead"],
  ["cacheCreationTokens", "cacheWrite"],
]);

function metricsEventFromUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const sums = {};
  let seen = false;
  for (const [source, axis] of USAGE_FIELDS) {
    const value = usage[source];
    if (typeof value === "number" && Number.isFinite(value)) {
      sums[axis] = value;
      seen = true;
    }
  }
  return seen ? metricsEvent(sums) : null;
}

// ===== 本轮主轮请求链（第四种生命体征的读数面，2026-10-15） =====
//
// 上游事实（桌面捆绑安装包里的 app-server 实现 zcode.cjs——即 agent.binary 指向
// 的那个文件，sha256 前缀 31965ce1d5d4a808，只读核证；行号按该 bundle）：
//   - 通知 `v4/telemetry/event` 的 `model.request.status`（schema Zms，strict）带
//     status 闭集（MODEL_REQUEST_STATUSES）、requestId、attempt、maxAttempts、
//     querySource?（main_turn / session_title / subagent / compact …）、
//     statusCode?、retryable?、delayMs?、reason?（自由文本）。
//   - **requestId 每次尝试轮换**：约 2170 行 hut(attribution, attempt) 在
//     attempt > 1 时换 crypto.randomUUID()——请求链不能按 requestId 分。
//   - queryId 不用于细分：createQueryId（`query_${randomUUID()}`）仅在
//     createCommand / steer / queue 三类**输入提交点**生成，子 traceContext 继承
//     父链的 queryId——同一轮（同一用户输入）的全部主轮请求共享同一 queryId，
//     分不开"同一轮里不同的主轮请求"。链 = 同 turnId 下 querySource ===
//     "main_turn" 的全部状态按到达顺序，只记最后一条。
//   - 时间边界（只读核证，供续命取舍参考）：
//     · maxAttempts 数**总尝试次数**（尝试循环 attempt 从 1 起数；bundle 内部
//       另有 maxRetries = max(0, maxAttempts-1) 的投影）。缺省 11，可被
//       ZCODE_MODEL_RETRY_* 环境变量覆盖；retry budget 无界时上报 0。
//     · 单次请求（每个 attempt）有**流空闲超时**：缺省 600s + 30s×重试序号
//       （streamIdleTimeoutMs ?? 6e5），超时发 model_stream_stalled（带 idleMs/
//       timeoutMs）。它只约束"流空闲"，不约束单次请求总时长——流持续滴落的
//       请求没有时长上界。
//     · 退避间隔**有上限、不重置**：计算退避 = min(2s × 2^(attempt-1), 60s)
//       （缺省，jitter 再乘 [0.5,1)）；server retry-after 在「≤300s 或小于未封顶
//       的计算值」时被整段采纳 ⇒ 单次 delayMs 可超 300s（缺省参数未封顶指数第
//       11 次尝试约 2048s，ZCODE_MODEL_RETRY_* 环境变量可再放大；控制面只按自己
//       的上界 RETRY_DELAY_MAX_MS 拒绝明显非 zcode 形状的值）。每次尝试自身
//       时长无上界 ⇒ **整轮总时长上界未知**。续命期间运行可能明显变长是有意
//       取舍（决定 0067：有体征的运行去留归 Lead）；不引入全局硬超时。
//
// 采纳条件（全部满足，缺一不采纳）：
//   - tracker 自会话建立即武装（activate），但 send 帧写出之前（markSent，先于
//     request 调用——写回调与 request 返回都可能晚于对端处理，PassThrough 级联
//     下应答甚至会在 write 调用栈内同步折返）到达的 turn.started 只记入基线
//     （seenTurnIds），不算本轮。「本次 send 之后」的判据 = 到达顺序 ∪ 基线
//     排除：send 帧写出之后到达、且 turnId 从未见过的首条 turn.started 才算
//     本轮（本运行一轮一 prompt，武装期的 turn.started 属于别的输入——如上一
//     轮的残留或会话标题轮）；
//   - sessionId 是本运行的会话；turnId 是本次 send 之后 turn.started 给出的本轮
//     turnId——turnId 从未见过的 turn.started = 换轮，链清空重来。采纳单调：
//     见过的 turnId（基线轮、当前轮、此前采纳过的轮）不再采纳，重复或迟到的
//     旧轮通知换不回旧轮。拿不到本轮 turnId 时一概不采纳（绝不猜归属）；
//   - querySource === "main_turn"（标题生成 session_title、subagent、compact 等
//     一概不是本轮主轮）。
// 数值与布尔字段经类型与范围校验后记录；reason 一律不读、不存、不回显。
function createUpstreamRequestTracker() {
  let sessionId = null;
  let turnId = null;
  let chain = null;
  // 续命窗：{until}。一条重试安排（key = `${turnId}:${requestId}:${attempt}`）只在
  // 首见时立窗：其后的重复通知一律不立窗、不延长——无论窗此刻属于它、已换给
  // 别的安排，还是已被作废。新的安排（新 attempt 或新 requestId）首见即立窗，
  // 覆盖当前窗。started/completed、turn.terminal、换轮作废当前窗；作废粘住由
  // 「只认首见」保证：作废前见过的安排连同其重复通知不再立窗，作废之后新出现
  // 的安排照常立窗。首见表在运行期内只增不清。delayMs 无效 / requestId 缺席时
  // 不立窗（fail-closed）；无效的首见同样记入首见表。
  let grace = null;
  const seenScheduleKeys = new Set();
  // send 武装状态：sendWritten = send 帧已进入写出（markSent 先于 request 调用）。
  // seenTurnIds = 见过的全部 turnId：send 之前到达的（基线：别的输入的残留轮）
  // 与此后采纳过的。
  let sendWritten = false;
  const seenTurnIds = new Set();
  let now = () => performance.now();

  const intIn = (value, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : null);
  const numIn = (value, min, max) => (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null);

  const handleTurnStarted = (p) => {
    if (typeof p.turnId !== "string" || p.turnId.length === 0) return;
    if (seenTurnIds.has(p.turnId)) return; // 采纳单调：见过的 turnId 不再采纳
    seenTurnIds.add(p.turnId);
    if (!sendWritten) return; // send 之前到达：只记入基线
    // 首个 turn.started（拿到本轮）或换轮：链与续命资格一并作废（旧轮的安排
    // 连同重复通知全部失效）。
    turnId = p.turnId;
    chain = null;
    grace = null;
  };
  const handleTurnTerminal = (p) => {
    if (turnId === null || p.turnId !== turnId) return;
    // 轮已结束：续命资格立即失效（粘住）。链保留——收口摘要仍要用本轮最后状态。
    grace = null;
  };
  const handleRequestStatus = (p) => {
    if (turnId === null || p.turnId !== turnId) return;
    if (p.querySource !== MAIN_TURN_QUERY_SOURCE) return;
    if (!MODEL_REQUEST_STATUSES.includes(p.status)) return;
    const attempt = intIn(p.attempt, 0, Number.MAX_SAFE_INTEGER);
    const maxAttempts = intIn(p.maxAttempts, 0, Number.MAX_SAFE_INTEGER);
    if (attempt === null || maxAttempts === null) return;
    const statusCode = intIn(p.statusCode, 100, 599);
    const delayMs = numIn(p.delayMs, 0, RETRY_DELAY_MAX_MS);
    chain = {
      status: p.status,
      statusCode,
      attempt,
      maxAttempts,
      retryable: typeof p.retryable === "boolean" ? p.retryable : null,
      delayMs,
      at: now(),
    };
    if (p.status === "model_request_started" || p.status === "model_request_completed") {
      // 链上来了 started/completed（换了 requestId 也算）——重试等待结束，续命
      // 资格立即失效（粘住）；之后是否再退避由新的 retry_scheduled 重新立窗。
      grace = null;
    } else if (p.status === "model_retry_scheduled"
      && typeof p.requestId === "string" && p.requestId.length > 0) {
      const key = `${turnId}:${p.requestId}:${attempt}`;
      if (!seenScheduleKeys.has(key)) {
        seenScheduleKeys.add(key);
        if (delayMs !== null) grace = { until: chain.at + delayMs + RETRY_GRACE_MARGIN_MS };
      }
    }
    // model_request_failed / model_stream_stalled 本身不续命（只说明出过问题，
    // 不说明还在推进），也不作废在途的窗：紧随其后的新 retry_scheduled 才是
    // 下一次续命；不再有则窗自然到期。
  };

  return {
    // 会话建立即武装（一次）：此后本会话的 turn.started 先记基线，send 写完后
    // 采纳本轮（见采纳条件注释）。
    activate(id) {
      if (typeof id === "string" && id.length > 0) sessionId = id;
    },
    // session/send 帧写出之前调用（写回调与 request 返回都可能晚于对端处理，
    // PassThrough 级联下应答会在 write 调用栈内同步折返）：从此到达的
    // turn.started 不再只记基线。
    markSent() {
      sendWritten = true;
    },
    // 与停滞门共用一只单调钟（stallClock 测试注入缝在 _streamEvents 采纳）。
    adoptClock(clock) {
      if (typeof clock === "function") now = clock;
    },
    handleNotification(p) {
      if (sessionId === null || !p || typeof p !== "object") return;
      if (p.sessionId !== sessionId) return;
      if (p.kind === TURN_STARTED_KIND) handleTurnStarted(p);
      else if (p.kind === TURN_TERMINAL_KIND) handleTurnTerminal(p);
      else if (p.kind === MODEL_REQUEST_STATUS_KIND) handleRequestStatus(p);
    },
    // 时刻 at 仍有效的续命窗终点；无效返回 null。
    retryGraceUntil(at) {
      return grace !== null && grace.until > at ? grace.until : null;
    },
    // 收口文案末尾的有界上游摘要（状态未知返回 null——文案逐字不变）。只放
    // 闭集 status、整数 statusCode、attempt/maxAttempts；attempt/max 经校验必在。
    summarySuffix() {
      if (chain === null) return null;
      const parts = [];
      if (chain.statusCode !== null) parts.push(`statusCode ${chain.statusCode}`);
      parts.push(`attempt ${chain.attempt}/${chain.maxAttempts}`);
      return `; upstream: last main-turn request ${chain.status} (${parts.join(", ")})`;
    },
  };
}

// ===== completed 轮 tool part 证据投影（2026-10-01 补齐，delta 认证证据链）=====
//
// 缺陷（kimi-web F2 同族）：模型真写了文件（run_202610012228351231l4qsr——
// "File created at …wao_cert_coder_hq_muq3vm7a.txt"、文件真实落盘），但本 backend
// 的完成路径不投影 tool part → WAO 侧零证据事件，delta scorecard 的 hasEvidence
// 误红。补齐 = completed 轮把本轮 parts 里的 tool 帧投影为证据事件（证据先于
// assistant 文本发射——opencodeServe/kimiWeb 同惯例）。
//
// tool part 形状来源 = 捆绑 zcode.cjs（0.16.9，sha256 FAD4C35C…E6275F，**形状不
// 发明**）的 zod schema 只读核证。`session/messages` 结果 schema `U5i =
// {messages: [WZe]}`、`WZe = {info, parts: [qZe]}`（bundle 第 72 行 schema 块，
// 会话快照 ePe 的 messages 同源同形）：
//   - part 联合 `qZe = discriminatedUnion("type", …)` 的 tool 臂（.strict()）：
//     `{partId, sessionId, messageId, type:"tool", callId:Ru(string), tool:Ru(string),
//     state:nor, metadata?}`——`tool` = 工具名（本 bundle 工具注册表 metadata.name
//     实证："Write"/"Edit"/"Bash"；无 "Shell"/"MultiEdit"，规则按归一化超集取），
//     `callId` = 运行时工具调用 id。
//   - state 联合 `nor = discriminatedUnion("status", …)`（全部 .strict()）：
//       `{status:"pending",   input, raw}` |
//       `{status:"running",   input, title?, metadata?, startedAt}` |
//       `{status:"completed", input, output:string, title, metadata, startedAt, completedAt}` |
//       `{status:"error",     input, error:string, metadata?, startedAt, completedAt}`
//     ——工具输入在 **state.input**（record(string, unknown)），不在 part 顶层。
//   - 工具输入键（bundle runtimeInputSchema 实证）：Write=`{file_path("must be
//     absolute, not relative"), content}`；Edit=`{file_path, old_string, new_string,
//     replace_all?}`；Bash=`{command, timeout?, description?, run_in_background?,
//     dangerouslyDisableSandbox?}`。file_path 是绝对路径形状 → fileWrittenEvent
//     **原样透传**（控制面 containment 求值用词法+realpath，kimi-web 同款）。
//
// 投影规则——镜像 src/backends/opencodeServe.js 的 evidenceEventsFromOpenCodeToolPart
// TD-199（2026-10-02，双席会审后重设）：证据投影改【part 投影台账】驱动的增量
// 投影——轮询每拍扫【本轮全区间】[baselineParts, parts.length)，每 part 双状态
// {identitySent, resultSent}，首见发主事件、首见终态发 tool_result，各恰一次。
// 为什么不能"只看新增切片"：同一 tool part 会 pending/running→completed/error
// **原位更新且 parts.length 不变**——纯切片会永久漏发 tool_result（比双发更糟的
// 证据缺失）。台账键 = part id（B′ 根修 2026-10-10：探针实证 id 跨快照稳定——
// 原注释"partId 稳定性未 live 证实"的阻塞项已解除；callId 仍作事件内
// toolCallId，缺席时回落工具名）。身份键下头部插入天然免疫：旧轮 part 因宿主
// 消息在基线 id 集内而不进扫描面。扫描成本 O(本轮 parts)，每拍可忽略。
function zcodeToolCallKey(part, tool) {
  return typeof part?.callId === "string" && part.callId.length > 0
    ? part.callId
    : tool;
}

// 主事件（identity）：bash/shell 类且有 input.command → commandEvent（无退出码
// 字段，exitCode 恒省绝不虚构）；write/edit/multiedit 类 → fileWrittenEvent
// **只在 status==="completed" 且 path 在场**（RunEvent 契约：file_written = 已
// 确认成功的写入——pending/running 的写意图不冒充成功；此前由"终态才投影"隐式
// 保证，增量时序下显式化）；其余 → toolUseEvent(tool, input)。
function zcodeToolIdentityEvents(part) {
  const tool = String(part?.tool ?? "unknown");
  const toolKey = tool.toLowerCase();
  const state = part?.state;
  const input = state?.input ?? {};
  const callId = zcodeToolCallKey(part, tool);
  if (toolKey === "bash" || toolKey === "shell") {
    // 输入晚来（2026-10-02 验证会审发现）：首拍无 input.command 的空壳不投
    // tool_use 占位、不锁 identitySent——同一 part 后续补齐 command 时补发
    // commandEvent；从不补齐则零主事件（无命令事实不虚构，tool_result 照发）。
    if (typeof input.command === "string") {
      return [commandEvent(input.command, undefined, { toolCallId: callId })];
    }
    return [];
  }
  if (isFileWriteToolKey(toolKey)) {
    const filePath = input.filePath ?? input.file_path ?? input.path;
    if (state?.status === "completed" && typeof filePath === "string") {
      return [fileWrittenEvent(filePath)];
    }
    return [];
  }
  return [toolUseEvent(tool, input)];
}

// 终态结果：status ∈ {completed, error} 恰一次——output/error 按 state 臂取，
// error → isError:true。
function zcodeToolResultEvents(part) {
  const state = part?.state;
  if (!isTerminalZcodeToolStatus(state?.status)) return [];
  const tool = String(part?.tool ?? "unknown");
  const callId = zcodeToolCallKey(part, tool);
  return [toolResultEvent(
    callId,
    state.status === "error" ? state.error : state.output,
    state.status === "error",
  )];
}

// 台账扫描：对 parts 的本轮区间逐 tool part 补投未发事件（轮询每拍与终态收口
// 复用同一台账——天然防双发且覆盖原位突变）。ledger: Map<partIndex, entry>。
// B′ 根修（2026-10-10）：投影区间从【位置区间 [baselineParts, len)】改为【本轮
// 消息（基线 id 集之外）的 parts】；台账键从 part 序号改为 part id（探针实证
// id 跨快照稳定——原注释"partId 稳定性未 live 证实"的阻塞项已由探针解除）。
// 头部插入不再错位：旧轮 part 因宿主消息在基线 id 集内而不进扫描面。缺 id 的
// tool part 保守跳过（证据缺失好过错位归属）；callId 仍作事件内 toolCallId。
function projectTurnToolEvents(newMsgs, ledger) {
  const events = [];
  for (const { message } of newMsgs) {
    for (const part of Array.isArray(message?.parts) ? message.parts : []) {
      if (part?.type !== "tool") continue;
      const partKey = partIdOf(part);
      if (partKey === null) continue;
      let entry = ledger.get(partKey);
      if (!entry) {
        entry = { identitySent: false, resultSent: false };
        ledger.set(partKey, entry);
      }
      if (!entry.identitySent) {
        const identity = zcodeToolIdentityEvents(part);
        if (identity.length > 0) {
          events.push(...identity);
          entry.identitySent = true;
        } else if (isTerminalZcodeToolStatus(part?.state?.status)) {
          // 终态仍无主事件（如 write 缺 path / 未 completed）——不会再有，标记收口
          // 免重复求值（pending write 的空主事件保持未标记，completed 时补发）。
          entry.identitySent = true;
        }
      }
      if (!entry.resultSent) {
        const result = zcodeToolResultEvents(part);
        if (result.length > 0) {
          events.push(...result);
          entry.resultSent = true;
        }
      }
    }
  }
  return events;
}

// tool part state.status 的终态闭集（bundle schema nor 核证：闭集 =
// pending|running|completed|error，其中 completed|error 为终态、pending|running
// 非终态）。与 opencode 的 isTerminalToolStatus（completed|error|failed）同位
// 不同集：zcode 的闭集是 schema literal，没有 "failed"——不掺入他席词表。
function isTerminalZcodeToolStatus(status) {
  return status === "completed" || status === "error";
}

// opencodeServe.js isFileWriteTool 同款谓词（该函数未导出——镜像保持一处一份
// 语义，kimiWeb.js isFileWriteToolKey 同款，注释互指）。
function isFileWriteToolKey(toolKey) {
  return toolKey === "write" || toolKey === "edit" || toolKey === "multiedit";
}

// workspaceKey：上游未文档化其语义（live 探针用常量 "wao-probe" 通过）。取每
// agent 稳定键（canonical id 字母表内）——绝不掺 cwd/runId（跨 run 漂移会破坏键
// 的稳定性假定；防御性归一防直调形状）。
function workspaceKeyOf(agent) {
  const id = typeof agent?.id === "string" && agent.id.length > 0 ? agent.id : "agent";
  return "wao-" + id.replace(/[^A-Za-z0-9._-]/g, "_");
}

// binary 必填（指向桌面捆绑 zcode.cjs；绝对路径形状归 registry 校验，这里只挡空值）。
function requireZcodeBinary(agent) {
  const binary = agent?.binary;
  if (typeof binary !== "string" || binary.trim().length === 0) {
    throw new Error(
      "zcode backend requires agent.binary (a path to the desktop-bundled zcode.cjs — "
      + "the install path drifts across desktop updates, so it must come from the registry)",
    );
  }
  return binary;
}

function bounded(value) {
  return String(value ?? "missing").slice(0, BOUNDED_TEXT_LIMIT);
}

function trimTail(value) {
  const text = String(value);
  return text.length <= STDERR_TAIL_LIMIT ? text : text.slice(-STDERR_TAIL_LIMIT);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 默认进程树击杀：Windows 最佳实践 taskkill /pid /T /F（ProcessBackend/
// deepSeekAcp 同款）。**诚实边界（第三轮 auditor #4②）：这里只是"启动"树杀——
// 不等待 taskkill 退出、不检查其退出码，启动 ≠ 树杀成功**（taskkill 自身失败、
// 竞态窗口内进程逃逸均不核实；跟随 processBackend 惯例——同步抛错才回落
// child.kill，异步失败无人观察，残余由 OS 级兜底层（Job Object kill-on-close）
// 承担，非本函数承诺）。killFn 注入缝让测试确定性观察"树杀被启动"。
function defaultTreeKill(child) {
  spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
}

export class ZcodeBackend {
  // 角色合同：拼进 content 前缀恰好一次（role 在前、task 在后，分隔符
  // ZCODE_ROLE_TASK_SEPARATOR）——同 kimiCode/kimiWeb 的 prompt 级先例。协议未
  // 证实系统级通道（session/create 未见证 system prompt 面）——prompt 级引导，
  // 非 system 级隔离（边界声明同 M11-5 TD-89）。
  supportsRoleContract = true;

  // 会话复用：会话常驻上游 storage（进程死 ≠ 会话死）。resume 轮不 session/create，
  // 先 `session/resume {sessionId}`（上游持久化恢复 + 注册进**本进程**会话表的唯一
  // 途径——依据链见文件头：zcode.cjs:15262 sessions:new Map 每进程一张、15256
  // setModel 走 requireSession、15245 查表 miss 抛 "Session is not active"、15256
  // wRn 装载注册；跳过 resume 的 setModel 必失败），成功后才 setModel→send；resume
  // 帧失败/未知形状一律 fail-closed 拒绝派发（固定错误）。前任 id 缺失/占位即派发前
  // 拒绝（镜像 kimiCode 关联面形状——绝不静默开新会话）。backendSessionId 在 spawn
  // 时刻即上游原生 sess_ id（无 proc_<pid> 占位中间态，ACP 同款形状）。
  supportsSessionReuse = true;

  // 在途纠偏：bundle 的运行时有 steer 队列（turn.steerQueued / turn.steerDrained 事件），
  // 但 app-server 协议不开放——活动轮里再发 session/send 返回 -32010 "A prompt is
  // already running for this session"（GLM-5.3-Flash 真机），协议方法表里也没有注入
  // 活动轮的方法。如实声明 false。翻转条件 = 协议出现注入活动轮的方法且有 live 证据。
  supportsInFlightCorrection = false;

  // fresh 派发 = 新会话 + 原 prompt 重放；跨 run 上下文续接走会话复用 lane。
  replayByRespawn = true;

  // token 计量：session/usage 全量计量 live 非零实测（2026-10-01）——完成后取
  // 一次 → metrics 事件。会话级累计（非增量）：RunManager 预算闸门按累计值比对
  // （opencode session.tokens 同款语义）；resume 轮的 usage 含前任轮用量，如实。
  reportsTokenUsage = true;

  // 命令退出码：live 闭集（text|step-finish）无退出码；bundle 核证的 tool part
  // state schema（nor：pending|running|completed|error）也无退出码字段——无已证实
  // 退出码通道，不产出该证据（翻转条件 = 实测到携带退出码的 part 形状并接线）。
  reportsCommandExitCode = false;

  // 决定 0086：显式声明无 OS 写沙箱（本类不继承 ProcessBackend 基类的默认
  // false）——无沙箱参数面，越界写拦截按 0084（上报侦测，非阻止）。
  enforcesWriteSandbox = false;

  constructor({ spawnFn = spawn, killFn = null, waoCliPath = null, platform, processProbe = null, deliverableProbe = null } = {}) {
    // 可注入 spawn（测试检查 child env/argv 而不启动真实进程——M11-7 同款缝）。
    this._spawnFn = spawnFn;
    // 可注入击杀（测试确定性观察"进程树兜底"被触发；缺省 taskkill 树杀，生产行为
    // 与 ProcessBackend 逐字同款）。
    this._killFn = killFn ?? defaultTreeKill;
    // WAO CLI 路径（注入 worker env，让 worker 能调 wao 命令记录状态）。
    this.waoCliPath = waoCliPath;
    // platform 注入缝（测试用）：compileInvocation 的 win32 包裹行为可在任意宿主
    // 上确定性钉住（deepSeekAcp 同款）。
    this._platform = platform ?? process.platform;
    // 停滞门取证（决定 0067，合同见 processActivity.js）：
    //   processProbe(pid) → 该进程后代的快照；不适用返回 null，瞬时失败抛错。
    //   deliverableProbe(cwd) → 工作树变化指纹；不适用返回 null。
    // 缺省只在真实 spawn 下接真实读数——注入了 spawnFn 的测试里 child 是假的，
    // 其 pid 与 cwd 不指向任何真实进程树/工作树，缺省即"不适用"；要测这两项
    // 证词的用例显式注入。
    this._processProbe = processProbe
      ?? (spawnFn === spawn
        ? (pid) => snapshotDescendants(pid, { platform: this._platform })
        : async () => null);
    this._deliverableProbe = deliverableProbe
      ?? (spawnFn === spawn ? (cwd) => fingerprintWorkingTree(cwd) : async () => null);
  }

  /**
   * 与 spawn argv 同源的 node 入口前缀（`node <zcode.cjs>`），供 preflight 与
   * runtimeIdentity 版本探测消费（ProcessBackend 家族契约）。zcode.cjs 是 node
   * 脚本——直发该路径在 Windows 上不可执行，探测必须经 node 入口。不合并
   * prependArgs：zcode 的 validateAgentPolicy 拒绝该配置，spawn argv 亦无此前缀。
   */
  async resolveInvocationPrefix(agent) {
    return { binary: process.execPath, args: [requireZcodeBinary(agent)] };
  }

  /**
   * M11-9 派发前策略门（RunManager 在 transcript/worktree/spawn 之前调用；spawn
   * 首行再次调用做权威防线）。zcode 能表达：model.id（上游原生 ref
   * `<providerId>/<modelId>` 拆分后经 session/setModel 下发）与 reasoning.effort
   * （直传 options.reasoningLevel——值闭集由上游 zod 校验，报错如实透传固定
   * 形状；不发明映射）。不能表达（配了即拒）：contextWindow、provider 块（登录态
   * 与桌面共享）、model.providerID/variant（路由在 ref 里）、agent.args/prependArgs
   * （app-server 协议模式无实证旗标——拒绝而非静默丢弃）。
   */
  validateAgentPolicy(agent) {
    const ref = splitZcodeModelRef(agent?.model?.id);
    if (ref === null) {
      throw new Error(
        "zcode backend requires model.id in the upstream native ref shape "
        + "<providerId>/<modelId> (exactly one slash, both segments non-empty; "
        + "live-verified example: bigmodel-api/GLM-5.3) — a bare model id cannot be "
        + "routed by session/setModel",
      );
    }
    if (agent?.model?.contextWindow !== undefined && agent?.model?.contextWindow !== null) {
      throw new Error(
        "zcode backend cannot express model.contextWindow (no verified session/create|setModel channel for it)",
      );
    }
    if (agent?.model?.providerID !== undefined || agent?.model?.variant !== undefined) {
      throw new Error(
        "zcode backend cannot express model.providerID/model.variant "
        + "(model routing is the <providerId>/<modelId> ref inside model.id — rejected instead of silently dropping routing fields)",
      );
    }
    if (agent?.provider) {
      throw new Error(
        "zcode backend cannot express provider (login state is shared with the ZCode desktop install — no anthropic-compatible wrapper face)",
      );
    }
    if (agent?.reasoning !== undefined && agent?.reasoning !== null
      && (typeof agent.reasoning.effort !== "string" || agent.reasoning.effort.length === 0)) {
      throw new Error(
        "zcode backend requires reasoning.effort to be a non-empty string when a reasoning block is present (it is passed through as setModel options.reasoningLevel)",
      );
    }
    if (Array.isArray(agent?.args) && agent.args.length > 0) {
      throw new Error(
        "zcode backend does not accept agent.args (app-server protocol mode has no evidence-backed CLI flags — refusing instead of silently dropping them)",
      );
    }
    if (Array.isArray(agent?.prependArgs) && agent.prependArgs.length > 0) {
      throw new Error(
        "zcode backend does not accept agent.prependArgs (the invocation is fixed: node <binary> app-server)",
      );
    }
  }

  /**
   * TD188 同款 backend-owned 纯可用性判定：占位进程号（proc_<pid>）是
   * ProcessBackend 家族的本地子进程身份，绝不是 zcode 会话 id。zcode 的
   * session.created.backendSessionId 即上游自产 sess_ id（spawn 时刻已知），占位
   * 形状只会来自跨 backend 误读——一律 fail-closed 拒绝。
   */
  canResumeWithRecoveredSessionId(sessionId) {
    return typeof sessionId === "string" && sessionId.length > 0
      && !isProcessPlaceholderSessionId(sessionId);
  }

  /**
   * M12-14 Package 1：零副作用 argv 预算预检（transcript/worktree/spawn 之前）。
   * zcode 的 argv 固定且短（node <zcode.cjs> app-server——prompt 走协议通道不进
   * argv），预算面天然安全；本方法同时承担 resume 轮 fail-closed 拒绝点（与
   * spawn 内的拒绝互为双拒绝点）与 cwd 存在性早拒绝的 keyed 声明（进程式家族，
   * backendCapabilityMatrix 分区守卫钉住）。
   */
  async preflightInvocation(agent, task = {}) {
    this.validateAgentPolicy(agent);
    // binary 必填的早期拒绝（错误顺序保持：先于 resume 预检）；argv 前缀统一由
    // resolveInvocationPrefix 构造（单一定义）。
    requireZcodeBinary(agent);
    if (task?.sessionReuse?.turn === "resume") {
      const priorSessionId = task.priorProviderSessionId;
      if (typeof priorSessionId !== "string" || priorSessionId.length === 0
        || isProcessPlaceholderSessionId(priorSessionId)) {
        throw new Error(
          "zcode sessionReuse resume turn requires the prior provider session id "
          + "(a runtime-advertised native id — session.created.backendSessionId of the "
          + "prior run; a proc_<pid> process placeholder is not a zcode session id) "
          + "— refusing instead of silently starting a fresh zcode conversation",
        );
      }
    }
    // 单一前缀定义（resolveInvocationPrefix）：preflight/spawn/版本探测三处同源
    // 消费，防第三份 process.execPath 副本漂移（auditor 咨询 2026-10-02）。
    const prefix = await this.resolveInvocationPrefix(agent);
    return compileInvocation({
      binary: prefix.binary,
      builtArgs: [...prefix.args, "app-server"],
      platform: this._platform,
    });
  }

  async spawn(agent, task) {
    // 权威策略门（RunManager 已在零副作用位置调过一次——defense-in-depth）。
    this.validateAgentPolicy(agent);
    // binary 必填的早期拒绝（错误顺序保持）；argv 前缀统一由
    // resolveInvocationPrefix 构造（单一定义）。
    requireZcodeBinary(agent);
    // resume 轮 fail-closed 预检（纯 task 形状检查——**先于进程创建**；与
    // preflightInvocation 互为双拒绝点）。关联面：spawn 权威（runManager）经
    // transcript SSOT 绑定读取器取回前任 session.created.backendSessionId，以
    // in-process task 字段送达（绝不进 argv）。缺失/空/占位（proc_<pid>）一律
    // 拒绝——绝不静默开新会话。
    let resumeSessionId = null;
    if (task?.sessionReuse?.turn === "resume") {
      const priorSessionId = task.priorProviderSessionId;
      if (typeof priorSessionId !== "string" || priorSessionId.length === 0
        || isProcessPlaceholderSessionId(priorSessionId)) {
        throw new Error(
          "zcode sessionReuse resume turn requires the prior provider session id "
          + "(a runtime-advertised native id — session.created.backendSessionId of the "
          + "prior run; a proc_<pid> process placeholder is not a zcode session id) "
          + "— refusing instead of silently starting a fresh zcode conversation",
        );
      }
      resumeSessionId = priorSessionId;
    }
    const agentEnv = agent.env ?? {};
    const forbiddenAgentEnv = Object.keys(agentEnv).find(isSecretEnvName);
    if (forbiddenAgentEnv) {
      throw new Error(`secret-like agent.env key is not allowed: ${forbiddenAgentEnv}`);
    }
    const resolvedCredentials = task.resolvedCredentials ?? {};
    const inheritedNames = inheritedEnvNames(agent);
    const childEnv = buildChildEnv(inheritedNames, agentEnv, {
      ...(this.waoCliPath ? { WAO_CLI: this.waoCliPath } : {}),
      WAO_TARGET_CWD: agent.cwd,
      // 0047 L1：worker 血统标记（同 processBackend——补席审计缺口）。
      WAO_IN_WORKER: "1",
    }, resolvedCredentials);
    const redactor = createSecretRedactor(
      { ...process.env, ...resolvedCredentials },
      inheritedNames,
    );

    // argv = node <zcode.cjs> app-server：zcode.cjs 是 node 脚本，Windows 下直接
    // spawn 无 shebang 关联——必须经 node 入口跑（codex.js 绕 .cmd 直跑 js 入口
    // 的同款纪律；live 探针同形状）。前缀与 preflight/版本探测同源
    // （resolveInvocationPrefix 单一定义）。
    const prefix = await this.resolveInvocationPrefix(agent);
    const compiled = compileInvocation({
      binary: prefix.binary,
      builtArgs: [...prefix.args, "app-server"],
      platform: this._platform,
    });
    const child = this._spawnFn(compiled.binary, compiled.args, {
      cwd: agent.cwd,
      env: childEnv,
      // 双向行协议：stdin 承载请求 + server→client 请求的应答。
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: compiled.windowsVerbatimArguments,
    });
    const spawned = new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    // ===== wire plumbing（行分隔 JSON，无 jsonrpc 字段）=====
    const pending = new Map();
    let nextRequestId = 1;
    let closedFact = null;
    const closedWaiters = [];
    let fatalError = null;
    let stderrTail = "";

    const wakeWaiters = () => {
      for (const waiter of closedWaiters.splice(0)) waiter();
    };
    const transportClosedError = () => new Error(
      "zcode app-server transport closed (exit code: "
      + (closedFact?.code === null || closedFact?.code === undefined ? "null" : closedFact.code)
      + (closedFact?.signal ? `, signal: ${closedFact.signal}` : "")
      + (stderrTail ? `; stderr: ${stderrTail}` : "")
      + ")",
    );
    const markClosed = (code, signal) => {
      if (closedFact) return;
      closedFact = { code, signal };
      const error = transportClosedError();
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      wakeWaiters();
    };
    // 协议级致命错误（如 stdout 非 JSON 行）：拒掉全部在途请求并唤醒等待者——
    // fail-closed，绝不静默吞协议破裂。
    const failWire = (reason) => {
      if (fatalError) return;
      fatalError = new Error(reason);
      for (const waiter of pending.values()) waiter.reject(fatalError);
      pending.clear();
      wakeWaiters();
    };

    const writeLine = (obj) => new Promise((resolve, reject) => {
      child.stdin.write(JSON.stringify(obj) + "\n", (error) => (error ? reject(error) : resolve()));
    });

    const request = (method, params, timeoutMs = REQUEST_TIMEOUT_MS) => new Promise((resolve, reject) => {
      if (fatalError) { reject(fatalError); return; }
      if (closedFact) { reject(transportClosedError()); return; }
      const id = nextRequestId++;
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`zcode ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      pending.set(id, {
        method,
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
      // 信封纪律：{id, method, params}——绝不带 jsonrpc 字段（上游 zod 拒收）。
      writeLine({ id, method, params: params ?? {} }).catch((error) => {
        const waiter = pending.get(id);
        pending.delete(id);
        waiter?.reject(error);
      });
    });

    // server→client 请求应答器（第三轮 auditor #5）。上游对 client 应答做逐方法
    // zod 校验（zcode.cjs:15262 resolveClientRequest → resultSchema.parse），空对象
    // 对带必填字段的方法 = 校验失败——必须按方法返回 schema 接受的**显式拒绝**。
    // 原则：无交互 client，**绝不自动授权**；逐方法应答形状的依据（zcode.cjs:72）：
    //   - session/requestRuntimePreferences → pGt：nativeSearchEnhancementsEnabled
    //     (boolean) 必填、其余字段有缺省——不应答则 session/create 15s 超时（live
    //     实测）。这是偏好应答而非拒绝，但同样是"必填字段在场"的形状。
    //   - interaction/requestUserInput → CYe：action ∈ {accept,decline,cancel}
    //     必填（content/reason 可选）——应 {action:"decline"}（无输入可用）。
    //   - interaction/requestPermission → JL：decision ∈ {allow,deny,escalate,
    //     modify} 必填（reason 可选）——应 {decision:"deny"}（绝不自动授权）。
    //   - interaction/requestProviderRuntimeHeaders → DGt 判别联合 headersApplied
    //     臂——应 {headersApplied:false}（errorMessage 可选）。
    //   - interaction/requestOfficialMcpAuthHeaders → OGt 判别联合 ok 臂——
    //     {ok:false} 且 reason **必填** ∈ PHt 枚举（zcode.cjs:72 Air/PHt：
    //     official_auth_unavailable | official_auth_plan_required |
    //     official_mcp_origin_untrusted）——应 {ok:false,reason:
    //     "official_auth_unavailable"}（裸 {ok:false} 过不了校验）。
    //   - 其余未知方法：应**显式错误帧** -32601（协议合法的 client 拒绝形状——
    //     服务端 requestClient 随之 reject，有界；绝不猜未知方法的 result schema）。
    const answerServerRequest = (frame) => {
      let response = null;
      switch (frame.method) {
        case "session/requestRuntimePreferences":
          response = { id: frame.id, result: { nativeSearchEnhancementsEnabled: false } };
          break;
        case "interaction/requestUserInput":
          response = { id: frame.id, result: { action: "decline", reason: "WAO zcode backend runs headless — no interactive user input available" } };
          break;
        case "interaction/requestPermission":
          response = { id: frame.id, result: { decision: "deny", reason: "WAO zcode backend runs headless — tool permission is never auto-approved" } };
          break;
        case "interaction/requestProviderRuntimeHeaders":
          response = { id: frame.id, result: { headersApplied: false, errorMessage: "WAO zcode backend supplies no provider runtime headers" } };
          break;
        case "interaction/requestOfficialMcpAuthHeaders":
          response = { id: frame.id, result: { ok: false, reason: "official_auth_unavailable" } };
          break;
        default:
          response = {
            id: frame.id,
            error: {
              code: -32601,
              message: `zcode backend (headless) does not support server request ${frame.method}`,
            },
          };
          break;
      }
      writeLine(response).catch(() => { /* best-effort 应答：传输已关，服务端等待由其超时收口 */ });
    };

    const streamChunkCounts = new Map();
    // 本轮主轮请求链（第四种生命体征的读数面）：handleFrame 写入（通知到达即
    // 记），_streamEvents 读取（续命窗 + 收口摘要）。
    const upstreamRequests = createUpstreamRequestTracker();
    const handleFrame = (frame) => {
      if (frame && typeof frame === "object" && typeof frame.method === "string") {
        if (Object.prototype.hasOwnProperty.call(frame, "id")) {
          answerServerRequest(frame);
          return;
        }
        // 通知（无 id）：认两类遥测——流分片（按会话计数，供停滞门取活性证词）
        // 与本轮主轮请求状态（upstreamRequests——采纳条件与诚实边界见其工厂
        // 注释）；startup/storageState 等其余通知一律忽略。
        const p = frame.params;
        if (frame.method === STREAM_TELEMETRY_METHOD && p && typeof p === "object") {
          if (p.kind === STREAM_CHUNK_KIND
            && typeof p.sessionId === "string" && Number.isFinite(p.chunkLength) && p.chunkLength > 0) {
            streamChunkCounts.set(p.sessionId, (streamChunkCounts.get(p.sessionId) ?? 0) + 1);
          }
          upstreamRequests.handleNotification(p);
        }
        return;
      }
      if (frame && typeof frame === "object" && Object.prototype.hasOwnProperty.call(frame, "id")) {
        const waiter = pending.get(frame.id);
        if (!waiter) return;
        pending.delete(frame.id);
        if (frame.error) {
          // 上游 zod 教学错误如实透传（固定形状 + 有界文本——code/data.name/message）。
          const name = frame.error?.data?.name;
          waiter.reject(new Error(
            `zcode ${waiter.method} failed (code ${String(frame.error.code ?? "unknown")}`
            + (typeof name === "string" && name.length > 0 ? `, ${bounded(name)}` : "")
            + `): ${bounded(frame.error.message)}`,
          ));
        } else {
          waiter.resolve(frame.result);
        }
        return;
      }
      // 合法 JSON 但非帧形状：忽略。
    };

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let frame = null;
      try { frame = JSON.parse(line); } catch { frame = null; }
      if (frame === null || typeof frame !== "object") {
        failWire(
          "zcode app-server emitted a non-JSON stdout line (protocol breakage — refusing to guess)",
        );
        return;
      }
      handleFrame(frame);
    });
    child.stderr.on("data", (chunk) => {
      // stderr 不进事件流；留脱敏尾部供传输关闭诊断（TD-77B 同款）。
      stderrTail = trimTail(stderrTail + redactor.redactString(chunk.toString("utf8")));
    });
    child.on("close", (code, signal) => markClosed(code, signal));

    const wire = {
      request,
      isClosed: () => closedFact !== null,
      // 该会话迄今收到的流分片通知数（单调增；未见过 = 0）。
      streamChunkCount: (id) => streamChunkCounts.get(id) ?? 0,
      fatal: () => fatalError,
      closedError: transportClosedError,
      // 进程死亡即时唤醒轮询等待（否则最长相邻两拍的死区）。
      waitClosed: () => new Promise((resolve) => {
        if (closedFact || fatalError) resolve();
        else closedWaiters.push(resolve);
      }),
    };

    // ===== 握手 + 提交（任何失败：杀进程 + 上抛——绝不留半握手进程）=====
    let content;
    let baselineParts;
    let baselineMessageIds;
    let sentAt;
    let terminalEmitted = false;
    let sessionId;
    try {
      await spawned;
      if (resumeSessionId !== null) {
        // resume 轮（第三轮 auditor #1）：不 session/create（绝不静默新会话），但
        // **必须先 session/resume {sessionId}**——上游会话表是每进程一张
        // （zcode.cjs:15262 sessions:new Map），resume 是持久化恢复 + 注册进本进程
        // 表的唯一途径（15256 wRn：sessionStore 读记录 miss 抛 "Session not
        // found"，读到了才 sessions.set）；跳过它直接 setModel 必撞 requireSession
        // 的 "Session is not active"（15256 QKo→15245 Xy）。超时对齐 create（同类
        // storage 装载）。resume 帧失败/未知形状 = fail-closed 拒绝派发（固定错误，
        // 绝不回落新会话、绝不带病 setModel）：期望响应 = 与 create 同源的 snapshot
        // （15256 zKo → D4 → 15251 QPn），至少有 session.sessionId 且等于前任 id。
        const resumed = await request(
          "session/resume",
          { sessionId: resumeSessionId },
          CREATE_TIMEOUT_MS,
        );
        const resumedId = resumed?.session?.sessionId;
        if (typeof resumedId !== "string" || resumedId.length === 0 || resumedId !== resumeSessionId) {
          throw new Error(
            "zcode session/resume returned an unexpected shape (expected result.session.sessionId "
            + `=== "${bounded(resumeSessionId)}", got ${JSON.stringify(bounded(resumedId))} — refusing to guess)`,
          );
        }
        sessionId = resumedId;
      } else {
        const created = await request("session/create", {
          workspace: { workspacePath: agent.cwd, workspaceKey: workspaceKeyOf(agent) },
        }, CREATE_TIMEOUT_MS);
        const createdId = created?.session?.sessionId;
        if (typeof createdId !== "string" || createdId.length === 0) {
          throw new Error("zcode session/create returned no session.sessionId (refusing to guess)");
        }
        sessionId = createdId;
      }
      // 请求链 tracker 自会话建立即武装：turn.started 可能先于 send 应答、或与
      // 应答同一数据块到达——应答后才激活会把它们全丢掉，之后的 429 等状态就进
      // 不了摘要。武装后、send 帧写完（markSent）前到达的 turn.started 只记基
      // 线，不算本轮（判据见 createUpstreamRequestTracker 采纳条件注释）。
      upstreamRequests.activate(sessionId);
      // setModel（fresh 与 resume 都发——配置的模型必须对每次派发生效，kimi/codex
      // 恒传 --model 的同款惯例；resume 轮在 session/resume 装载之后发，此时会话
      // 已注册进本进程表，requireSession 不会 miss）。effort 缺省不传 options
      // （live 事实：缺 reasoningLevel 仅部分模型报错——配置了才发，语义完整）。
      const ref = splitZcodeModelRef(agent.model.id);
      const effort = agent?.reasoning?.effort;
      await request("session/setModel", {
        sessionId,
        model: {
          providerId: ref.providerId,
          modelId: ref.modelId,
          ...(typeof effort === "string" && effort.length > 0
            ? { options: { reasoningLevel: effort } }
            : {}),
        },
      });
      // 权限模式（fresh 与 resume 都发——与 setModel 同款「每次派发生效」惯例），
      // 固定在 setModel 之后、基线快照/提交之前：session/setMode {sessionId,
      // mode:"yolo"}。依据：
      //   (1) CLI -p 默认即 yolo（zcode CLI --help："--mode <mode>  Permission mode for prompts: build, edit, plan, or yolo (default: yolo for --prompt)"）——无头 worker 与其它席位 --dangerously-skip-permissions / permission_mode:"auto" 姿态对齐；
      //   (2) app-server 的 session/create 默认 build（写需许可）——delta 认证 scorecard 实测 GLM-5.3 写文件被拦："Write tool was blocked by the WAO headless permission layer"（runs/reliability/run_20261001213724000cy1b3a），无人值守席位的写许可必须放开；
      //   (3) mode 枚举 = ["plan","build","edit","yolo","auto"]（bundle schema $j 核证；expectedRevision v1 不传，同 setModel 纪律）。
      // 失败 fail-closed（固定错误拒绝派发——权限没放开比派发失败更危险，绝不带病
      // 送 prompt；上游明细有界附注如 abort 失败腿同款）。任何拒绝形态（错误帧/
      // 超时/传输已关）走同一 catch——确认放开前 prompt 不出闸。
      try {
        await request("session/setMode", { sessionId, mode: "yolo" });
      } catch (error) {
        throw new Error(
          "zcode dispatch refused: session/setMode did not succeed ("
          + `${bounded(error?.message ?? error)}) — the app-server session/create `
          + "default is build mode and the prompt must never be dispatched without "
          + "confirmed write permission (fail-closed: an unpermitted write is worse "
          + "than a failed dispatch)",
        );
      }
      // 提交前基线快照：展平 parts 数 + 消息身份序列。本轮归属自 B′ 根修
      // （2026-10-10）起按【身份】判定：基线消息 id 有序集（前缀校验锚）+ 基线
      // id 集（本轮=集合之外的消息）。响应形状 fail-closed：缺 messages 数组即
      // 拒，绝不回落猜测。
      const baseline = await request("session/messages", { sessionId });
      if (!baseline || !Array.isArray(baseline.messages)) {
        throw new Error(
          "zcode session/messages response malformed (result.messages array is required — refusing to guess)",
        );
      }
      baselineParts = flattenParts(baseline.messages).length;
      baselineMessageIds = baseline.messages.map((m) => messageIdent(m)?.id ?? null);
      if (baselineMessageIds.some((id) => id === null)) {
        // ⑨l（会审验收项）：历史消息缺 info.id = 身份归属不可解——resume 轮的
        // 完成/证据归属都靠它。发送之前拒绝（session/send 帧数为 0，零 token）。
        throw new Error(
          "zcode resume history lacks message identity (info.id) — attribution would be positional-only and exposed to non-append history mutation; refusing to dispatch (B′ guard)",
        );
      }
      // 角色合同拼前缀恰好一次（prompt 级通道——见 supportsRoleContract 注释）。
      content = task.roleContract
        ? task.roleContract + ZCODE_ROLE_TASK_SEPARATOR + task.prompt
        : task.prompt;
      // send 帧发出之前推进武装边界。不能等写完成回调（流实现里写回调可能晚于
      // 对端处理甚至应答往返），也不能等 request() 返回（PassThrough 级联下对端
      // 的应答与同块通知会在 write 调用栈内同步折返）——markSent 必须先于帧的
      // 写出，应答之前/同块到达的 turn.started 才划得进本轮（基线判据见
      // createUpstreamRequestTracker 采纳条件注释）。
      upstreamRequests.markSent();
      const sent = await request("session/send", { sessionId, content });
      if (sent?.accepted !== true) {
        throw new Error("zcode session/send did not accept the prompt (accepted !== true — refusing to guess)");
      }
      sentAt = Date.now();
    } catch (error) {
      this._kill(child);
      throw error;
    }

    // 中止面（第三轮 auditor #4，两层语义如实描述）：**(a) RunManager 侧 signal
    // 先行**——Lead/预算/外部 abort 打 AbortController，事件流的 abort 监听
    // （_streamEvents 的 onAbort）**立即杀进程树**，不经 session/stop；**(b) 本
    // handle.abort() 是第二层**：进程仍活时先试 session/stop（bundle 方法表在册、
    // 形状未经 live 验证——按 {sessionId} 发送，上游 zod 若教学不同形状会以错误
    // 回显）再杀树。**stop 仅在进程仍活时可达**：signal 已杀进程 / 传输已关 /
    // 终态已回收时 stop 无人应答，此时跳过 stop 且不抛（无可停止物——abort 的
    // 契约是"尽力中止并回收"，进程已死即已达成；_kill 对已退出进程是 no-op）。
    // 幂等（#4①）：abortPromise 共享——二次调用复用首次结果，不重发 stop、不
    // 重复杀树、首次的拒绝原样重放。诚实措辞（#4②）：killFn/taskkill 只是
    // "启动树杀"，启动 ≠ 树杀成功（退出码不核实，见 defaultTreeKill 注释）——
    // stop 失败腿的错误文案只声明"树杀已启动"。
    let abortPromise = null;
    const doAbort = async () => {
      if (terminalEmitted) {
        this._kill(child);
        return;
      }
      if (wire.isClosed()) {
        // 传输已关（进程死）：不试 stop、不抛——二次/cleanup 兜底调用在此为
        // 幂等 no-op。
        this._kill(child);
        return;
      }
      let stopError = null;
      try {
        await request("session/stop", { sessionId }, STOP_TIMEOUT_MS);
      } catch (error) {
        stopError = error;
      }
      this._kill(child);
      if (stopError) {
        throw new Error(
          `zcode abort: session/stop failed (${bounded(stopError.message)}) `
          + "— a process-tree kill was launched as the backstop (launching the kill is not a verified kill; the stop request itself did not succeed)",
        );
      }
    };

    return {
      backend: BACKEND_NAME,
      // native sess_ id 在 spawn 时刻即已知（区别于 kimi/codex 的 proc_<pid> 占位 +
      // 运行期补记两段式）——session.created.backendSessionId 直接就是 resume 轮
      // 可用的 provider 会话 id（deepSeekAcp 同款形状）。
      backendSessionId: sessionId,
      // 承载本会话的本机进程（session.created.hostPid）：会话 id 是上游原生 id、
      // 不含 pid，stop 靠这个字段找到要击杀的进程树（TD-265）。
      ...(Number.isInteger(child.pid) && child.pid > 0 ? { hostPid: child.pid } : {}),
      redact: (value) => redactor.redact(value),
      // 事件流工厂：RunManager 传 signal（abort 静默退出——终态判定不依赖它，
      // 有界性由无进展兜底 + silentTimeout/零 part 思考预算家族保证）、pollInterval/
      // silentTimeout 控制轮询、correctable run 另传 onPollTick（zcode 不支持在途
      // 纠偏，生产不传；透传保持 provider 中立签名）。
      events: (signal, opts = {}) => this._streamEvents({
        wire,
        child,
        sessionId,
        cwd: agent.cwd,
        baselineParts,
        baselineMessageIds,
        sentAt,
        sentContent: content,
        upstreamRequests,
        signal,
        interval: opts.pollInterval,
        silentTimeout: opts.silentTimeout,
        onPollTick: opts.onPollTick,
        // TD-197① test seam: injectable monotonic clock for the stall budget.
        stallClock: opts.stallClock,
        markTerminal: () => { terminalEmitted = true; },
      }),
      abort: () => {
        abortPromise ??= doAbort();
        return abortPromise;
      },
      isAlive: () => child.exitCode === null && child.signalCode === null,
    };
  }

  /**
   * 轮询生成器（完成/失败/兜底判定归这里；signal 仅作 abort 静默退出与进程击杀，
   * 不承担终态）。每拍恰一次 session/messages：
   *   - 新 part 增长 = 进展（无进展计数清零）；完成 = 本轮（序号 >= baselineParts）
   *     出现 step-finish(reason stop|error) 且其后无新 part（快照最后一位）。
   *   - stop → 发射 tool part 证据（本轮 type:"tool" 帧投影——
   *     evidenceEventsFromZcodeParts，证据先行）+ user echo + assistant text
   *     （发射前非空复检——N1 教训；TD-199 2026-10-02 再裁定：台账补漏先行，空文本失败保留已发证据，仅不伪造 echo/assistant）+
   *     usage→metrics + done(completed)；error → done(failed)（固定文案——该
   *     part 未实证携带错误明细，不虚构）。
   *   - 无进展兜底（分相）：已有产出后连续 60 拍无新 part → done(failed,
   *     "turn stalled")（GLM-5.3 步间静默实测 8-14s，首轮 8 拍门曾把步间
   *     reasoning 误杀——run_20261001203009794bb6add）；零 part 阶段该门不
   *     生效——silentTimeout 在场只以它为界，缺席以 ZERO_PART_POLL_LIMIT
   *     思考预算（120 拍）有界（首 part 延迟实证 run_20261001195259045cle1ft；
   *     kimiWeb R9 F3 同族）。
   *   - 轮询失败（请求超时/传输关闭/进程死/致命协议错误）→ done(failed)（stdio
   *     无 HTTP 重试面：通信失败 = 进程死）。
   */
  async *_streamEvents({
    wire, child, sessionId, cwd, baselineParts, baselineMessageIds, sentAt, sentContent,
    upstreamRequests, signal, interval, silentTimeout, onPollTick, markTerminal, stallClock,
  }) {
    const pollInterval = Number.isFinite(interval) && interval > 0
      ? interval
      : DEFAULT_POLL_INTERVAL_MS;
    const baselineIds = Array.isArray(baselineMessageIds) ? baselineMessageIds : [];
    const baselineIdSet = new Set(baselineIds);
    let lastPartsCount = baselineParts;
    let noProgressPolls = 0;
    let anyNewPart = false;
    // TD-197①：no-progress 门的时间化（shared stallBudget 纯算法）。noProgressPolls
    // 仍保留——零 part 思考预算（ZERO_PART_POLL_LIMIT 拍）继续按拍计；轮内
    // 停滞改按"静默段时长 ≥ 自适应预算"判（单调钟，与 pollInterval 解耦；
    // stallClock 为测试注入缝，缺省 performance.now()）。
    const stallTracker = createStallTracker({
      floorMs: NO_PROGRESS_FLOOR_MS,
      ceilingMs: NO_PROGRESS_CEILING_MS,
      factor: NO_PROGRESS_FACTOR,
      ...(typeof stallClock === "function" ? { now: stallClock } : {}),
    });
    // TD-199 增量投影状态：台账（partId → 双状态）+ 已见 parts 高水位（缩短
    // 检测——计数回退仍 fail-closed；身份前缀检测另在下方，两者独立并存）。
    const toolLedger = new Map();
    let highWaterParts = baselineParts;
    // 生命体征状态：分片计数的上次读数、最近一次见到新分片的时刻（与停滞门同
    // 一只钟）、上次发 streaming 事实的时刻、自上一次进度以来的续命次数。
    const stallNow = typeof stallClock === "function" ? stallClock : () => performance.now();
    // 请求链的到达时刻与续命窗也用这只钟（通知到达即在 handleFrame 记时刻，
    // 与停滞门同一时间系）。
    upstreamRequests.adoptClock(stallNow);
    const streamChunksOf = () => (typeof wire.streamChunkCount === "function" ? wire.streamChunkCount(sessionId) : 0);
    let lastStreamChunks = streamChunksOf();
    let lastStreamChunkAt = null;
    let lastStreamEmitAt = null;
    // 续命证词按「段」计：一段连续续命（流在收 / 退避窗内 / 观察窗判活）只计一
    // 次，段间断开（门未到点、取证 pending、进度落地）后下一段重新计——收口文
    // 案里的 "N earlier attestation(s)" 如此为真（按拍累计会把轮询拍数当证词数）。
    let lifeAttestations = 0;
    let inGraceEpisode = false;
    // 观察窗取证状态：基线（时刻 + 后代快照 + 工作树指纹）、进程快照连续失败
    // 数、已取到但尚未执行的收口事实。
    let windowBaseline = null;
    let probeFailures = 0;
    let closeEvidence = null;
    // 最近一次观察窗比对读到的体征（闭集 runtime status），与上次落事实的时刻。
    let observedSigns = [];
    let lastVitalSignEmitAt = null;
    const resetObservation = () => {
      windowBaseline = null;
      probeFailures = 0;
      closeEvidence = null;
    };
    // 门到点且流不在收时每拍调用。返回 "pending"（基线刚取 / 窗未满 / 取样瞬时
    // 失败——继续轮询）、"alive"（窗内有进程活动或工作树变化）、null（两项证词
    // 都不适用，没有取样发生）、或一段写进收口文案的取证事实。
    const observeWindow = async () => {
      if (windowBaseline !== null && stallNow() - windowBaseline.at < PROCESS_ACTIVITY_WINDOW_MS) return "pending";
      let tree;
      let treeNote = "process activity unavailable";
      let treeFailed = false;
      try {
        tree = await this._processProbe(child.pid);
        probeFailures = 0;
      } catch {
        probeFailures += 1;
        if (probeFailures < PROCESS_PROBE_MAX_FAILURES) return "pending";
        tree = null;
        treeFailed = true;
        treeNote = `process activity unavailable (${probeFailures} consecutive snapshot failures)`;
      }
      const files = await this._deliverableProbe(cwd);
      if (windowBaseline === null) {
        if (tree === null && files === null) return treeFailed ? treeNote : null;
        windowBaseline = { at: stallNow(), tree, files };
        return "pending";
      }
      const facts = [];
      observedSigns = [];
      if (tree !== null && windowBaseline.tree !== null) {
        const activity = describeProcessActivity(windowBaseline.tree, tree, stallNow() - windowBaseline.at);
        if (activity.active) observedSigns.push("process_active");
        facts.push(`no process activity in the last ${Math.round(activity.windowMs / 1000)}s (cpu +${activity.cpuMs}ms, io +${activity.ioBytes}B across ${tree.size} descendant process(es))`);
      } else {
        facts.push(treeNote);
      }
      if (files !== null && windowBaseline.files !== null) {
        if (files !== windowBaseline.files) observedSigns.push("files_changed");
        else facts.push("no file change in the working tree");
      }
      return observedSigns.length > 0 ? "alive" : facts.join("; ");
    };
    const finish = () => {
      // 终态后回收进程（一个 WAO run 一个 app-server 进程；会话本体常驻上游
      // storage，进程回收不影响 resume lane）。幂等。
      markTerminal();
      this._kill(child);
    };
    const onAbort = () => this._kill(child);
    signal?.addEventListener("abort", onAbort);
    try {
      while (!signal?.aborted) {
        const fatal = wire.fatal();
        if (fatal) {
          finish();
          yield doneEvent("failed", fatal.message);
          return;
        }
        if (wire.isClosed()) {
          finish();
          yield doneEvent("failed", wire.closedError().message);
          return;
        }
        // onPollTick 每拍恰一次，置于轮询观察之前；best-effort——钩子抛错绝不
        // 杀死事件流。
        if (typeof onPollTick === "function") {
          try { await onPollTick(); } catch { /* best-effort */ }
        }
        let result;
        try {
          result = await wire.request("session/messages", { sessionId });
        } catch (error) {
          finish();
          yield doneEvent(
            "failed",
            `zcode polling failed: ${bounded(error?.message ?? error)}`,
          );
          return;
        }
        if (!result || !Array.isArray(result.messages)) {
          finish();
          yield doneEvent(
            "failed",
            "zcode session/messages response malformed (result.messages array is required — refusing to guess)",
          );
          return;
        }
        const msgs = result.messages;
        const parts = flattenParts(msgs);
        const streamChunks = streamChunksOf();
        if (streamChunks > lastStreamChunks) {
          lastStreamChunks = streamChunks;
          lastStreamChunkAt = stallNow();
          // 让 Lead 看得见：流在收即节流发射一条零载荷的 streaming 事实。
          if (lastStreamEmitAt === null
            || lastStreamChunkAt - lastStreamEmitAt >= STREAM_ACTIVITY_EMIT_MIN_INTERVAL_MS) {
            lastStreamEmitAt = lastStreamChunkAt;
            yield runtimeActivityEvent("streaming");
          }
        }
        if (parts.length < highWaterParts) {
          finish();
          yield doneEvent(
            "failed",
            `zcode session/messages snapshot shrank (${parts.length} < ${highWaterParts}) — evidence attribution unreliable, refusing to guess`,
          );
          return;
        }
        highWaterParts = Math.max(highWaterParts, parts.length);
        // ===== B′ 根修（2026-10-10 身份切片）：历史变异检测 + 本轮归属 =====
        // 变异 = 基线消息 id 有序序列不再是当前快照的前缀（头部插入/重排/删除/
        // compaction 改写历史都会击穿前缀）——一旦确认，完成与证据归属都不再
        // 可信，具名失败（与"快照缩短即失败"同一纪律），绝不静默续用错位快照。
        const idents = msgs.map((m) => messageIdent(m));
        let historyMutated = false;
        for (let i = 0; i < baselineIds.length; i += 1) {
          if (idents[i]?.id !== baselineIds[i]) { historyMutated = true; break; }
        }
        if (historyMutated) {
          finish();
          yield doneEvent(
            "failed",
            "zcode history mutated non-append (baseline message ids are no longer a prefix of the snapshot — turn attribution is unreliable, refusing to guess)",
          );
          return;
        }
        // 本轮消息 = 基线 id 集之外的消息（缺 id 的新消息不可归属，保守跳过——
        // 锚点不成立由有界收口兜底）。
        const newMsgs = [];
        for (let i = 0; i < msgs.length; i += 1) {
          if (!idents[i] || baselineIdSet.has(idents[i].id)) continue;
          newMsgs.push({ ident: idents[i], message: msgs[i] });
        }
        // TD-199：每拍台账扫描——工具证据在轮询期即落盘（身份键去重；头部插入
        // 下旧轮 part 因宿主消息在基线集内而不进扫描面）。纯文本/思考段仍零
        // run.event（诚实边界：本修复只治愈工具活跃期）。
        const toolEvents = projectTurnToolEvents(newMsgs, toolLedger);
        for (const event of toolEvents) {
          yield event;
        }
        const partsGrew = parts.length > lastPartsCount;
        if (partsGrew) {
          lastPartsCount = parts.length;
          anyNewPart = true;
        }
        // 进度 = 新 part 落地，或既有 tool part 原位落了新证据（工具调用的开始 /
        // 结束是状态原位变化，不一定改变 part 个数）。
        if (partsGrew || toolEvents.length > 0) {
          noProgressPolls = 0;
          stallTracker.noteProgress();
          lifeAttestations = 0;
          inGraceEpisode = false;
          resetObservation();
        } else {
          noProgressPolls += 1;
        }
        // 完成判据（身份式）：锚点 U = 本轮新 user 消息（回显优先消歧）；完成 =
        // 存在新 assistant 消息 A（A.parentID === U.id）且 A 的末位 part 是
        // step-finish(stop|error)。旧位置式判据（全局尾部 + 序号 ≥ 基线）在头部
        // 插入下可被旧 stop 右移击穿——B′ 关闭；parent 不匹配的新 assistant
        // （⑨k）不构成完成，续等由有界收口兜底。
        const anchor = resolveTurnAnchor(newMsgs, sentContent);
        let finishReason = null;
        if (anchor !== null) {
          for (const { ident, message } of newMsgs) {
            if (ident.role !== "assistant" || ident.parentID !== anchor.id) continue;
            const own = Array.isArray(message?.parts) ? message.parts : [];
            const lastOwn = own.length > 0 ? own[own.length - 1] : null;
            if (lastOwn?.type === "step-finish"
              && (lastOwn.reason === "stop" || lastOwn.reason === "error")) {
              finishReason = lastOwn.reason;
              break;
            }
          }
        }
        if (finishReason === "stop") {
          yield* this._completeTurn({
            wire, child, sessionId, newMsgs, anchor, sentContent, finish, toolLedger,
          });
          return;
        }
        if (finishReason === "error") {
          finish();
          // zcode 自己以失败结束本轮的路径：part 不带错误明细（不虚构），但本轮
          // 主轮请求链的最后状态已知时照三道门同款追加有界上游摘要（同款格式，
          // 诊断按它归因）。
          yield doneEvent(
            "failed",
            "zcode turn failed (step-finish reason error; no verified error detail on this part — refusing to invent one)"
              + (upstreamRequests.summarySuffix() ?? ""),
          );
          return;
        }
        // 无进展/静默兜底（kimiWeb R9 F3 同族分相；两相宽松度各按 live 实证分账）：
        //   - 零 part 阶段（anyNewPart=false：本轮基线后尚无任何产出）——停滞门
        //     **不得**生效（GLM-5.3 high reasoning 首 part 延迟实测 >8s，
        //     scorecard drill run_20261001195259045cle1ft 转录在案）：silentTimeout
        //     在场 → 只以 silentTimeout 为界；缺席 → 宽松思考预算
        //     ZERO_PART_POLL_LIMIT 拍有界，绝不无限等待。
        //   - 已有产出后的停滞（anyNewPart=true）——TD-197① 观测自适应时间门：
        //     静默段 ≥ budgetMs 才收口。budget = min(600s, max(300s, 3 × 本轮已
        //     恢复的最大静默间隙))——首段静默由 300s floor 直接保护（一周四次
        //     误杀实录见常量注释），轮内批间节奏自放大，硬顶保有界性（顶约束
        //     静默段而非墙钟）。真停滞仍收口。
        const stalled = anyNewPart && stallTracker.stallMs() >= stallTracker.budgetMs();
        // 生命体征①：最近是否还在收流分片。
        const streamRecent = lastStreamChunkAt !== null
          && (stallNow() - lastStreamChunkAt) <= STREAM_ATTEST_RECENCY_MS;
        // 这一拍有没有收口门到点（零 part 的两道门与已有产出后的停滞门互斥）。
        let closeGate = null;
        if (!anyNewPart && silentTimeout && (Date.now() - sentAt) > silentTimeout) closeGate = "silent_timeout";
        else if (!anyNewPart && !silentTimeout && noProgressPolls >= ZERO_PART_POLL_LIMIT) closeGate = "zero_part";
        else if (stalled) closeGate = "stalled";
        // 到点不等于收口：先看生命体征。outcome = "alive"（续命）/ "retry_wait"
        // （上游重试等待续命——第四种体征）/ "pending"（取证中）/ 其余为写进
        // 收口文案的取证事实。
        let outcome = null;
        if (closeGate === null) {
          resetObservation();
        } else if (upstreamRequests.retryGraceUntil(stallNow()) !== null) {
          outcome = "retry_wait";
        } else if (streamRecent) {
          outcome = "alive";
        } else if (closeEvidence !== null) {
          // 上一拍比对的结论是没有活动。取样占用了时间，所以多看了这一拍：快照
          // 没有新进度（否则走不到这里）、流也没来——执行收口。
          outcome = closeEvidence;
        } else {
          const observed = await observeWindow();
          if (observed === null) {
            outcome = "process activity unavailable";
          } else if (observed === "alive" || observed === "pending") {
            outcome = observed;
          } else {
            closeEvidence = observed;
            outcome = "pending";
          }
        }
        if (outcome === "alive" || outcome === "retry_wait") {
          // 续命即落转录事实（决定 0069）：凭进程活动 / 文件变化续命落各自的
          // status；重试等待续命落 provider_retry（上游 API 重试的既有闭集成员，
          // claude-code 后端同款映射）——全部零载荷（architecture §3.2：不带
          // 状态码、次数、延迟），共用 VITAL_SIGN_EMIT_MIN_INTERVAL_MS 节流。
          // 流在收时不在此处落事实（分片到达时已有节流的 streaming）。
          if (!inGraceEpisode) {
            inGraceEpisode = true;
            lifeAttestations += 1;
          }
          const retryWait = outcome === "retry_wait";
          const signs = retryWait ? ["provider_retry"] : (streamRecent ? [] : observedSigns);
          if (signs.length > 0 && (lastVitalSignEmitAt === null
            || stallNow() - lastVitalSignEmitAt >= VITAL_SIGN_EMIT_MIN_INTERVAL_MS)) {
            lastVitalSignEmitAt = stallNow();
            for (const status of signs) yield runtimeActivityEvent(status);
          }
          resetObservation();
          // 清静默段、不喂自适应学习（kimiWeb 0046 B5② 同款）。零 part 的两道门
          // 没有可清的静默段：门仍到点，下一拍重新开窗取证。重试等待续命**不**
          // 清静默段：退避窗一过、仍无进展即在预算处收口——窗内续命、窗外照旧，
          // 不为每次退避重置预算时钟（有体征的运行没有自动上限，决定 0067）。
          if (closeGate === "stalled" && !retryWait) stallTracker.resetSilent();
        } else if (outcome !== null && outcome !== "pending") {
          finish();
          const streamFact = lastStreamChunks > 0
            ? `${lastStreamChunks} model stream chunk(s) seen this turn, none in the last ${Math.round(STREAM_ATTEST_RECENCY_MS / 1000)}s`
            : "no model stream chunk observed this turn";
          // 没有取样发生（两项证词都不适用）时，零 part 两道门的文案与此前逐字相同。
          const sampled = outcome === "process activity unavailable"
            ? ""
            : ` — no vital signs: ${streamFact}; ${outcome}`;
          // 本轮主轮请求链的最后状态已知时，文案末尾追加有界上游摘要（闭集
          // status + 整数 statusCode + attempt/maxAttempts；未知就不加，上面的
          // 文案逐字不变）——诊断按这段摘要归因，额度耗尽不再写成"无法区分"。
          const upstreamNote = upstreamRequests.summarySuffix() ?? "";
          if (closeGate === "silent_timeout") {
            yield doneEvent(
              "failed",
              `silent timeout: no turn parts observed within ${silentTimeout}ms (provider may have silently rejected)${sampled}${upstreamNote}`,
            );
          } else if (closeGate === "zero_part") {
            yield doneEvent(
              "failed",
              `zcode thinking budget exceeded (no turn parts observed for ${ZERO_PART_POLL_LIMIT} consecutive polls, silentTimeout absent — bounded exit)${sampled}${upstreamNote}`,
            );
          } else {
            const d = stallTracker.diagnostics();
            yield doneEvent(
              "failed",
              `zcode turn stalled (${streamFact}; ${outcome}${lifeAttestations > 0 ? `; ${lifeAttestations} earlier attestation(s) since the last progress` : ""}; `
                + `silent stretch ${Math.round(stallTracker.stallMs())}ms exceeded adaptive budget `
                + `${Math.round(d.floorMs)}ms floor / ×${d.factor} / ${Math.round(d.ceilingMs)}ms ceiling; `
                + `max recovered gap this turn ${Math.round(d.maxObservedGapMs)}ms — no vital signs, bounded exit)${upstreamNote}`,
            );
          }
          return;
        } else {
          // 门未到点 / 取证中（pending）：本拍没有续命——续命段结束，下段重计。
          inGraceEpisode = false;
        }
        // 等待下一拍：interval 上界 + 进程死亡即时唤醒。
        await Promise.race([sleep(pollInterval), wire.waitClosed()]);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * completed 轮发射序列：usage（session/usage——reportsTokenUsage=true 的通道；
   * 失败按通信失败收口）→ 进程回收 → tool part 证据（本轮消息的 type:"tool"
   * 帧逐帧投影——身份键台账，证据先行，opencode/kimi-web 同惯例）→ 台账补漏
   * （TD-199：终态先补未发证据）→ user echo → assistant text（身份切片：只取
   * parentID===锚点 U 的新 assistant 消息的 text parts——回显启发式退役：echo
   * 是 user 消息自己的 part，parent 过滤天然排除；发射前非空复检，N1 教训）
   * → metrics（分量在场才发）→ done(completed)。
   */
  async *_completeTurn({ wire, child, sessionId, newMsgs, anchor, sentContent, finish, toolLedger }) {
    // 身份切片：本轮 assistant 文本 = 宿主为锚点 U 的新 assistant 消息的全部
    // text parts（多个 assistant 消息按快照顺序拼接）。
    const textParts = [];
    for (const { ident, message } of newMsgs) {
      if (ident.role !== "assistant" || ident.parentID !== anchor.id) continue;
      for (const part of Array.isArray(message?.parts) ? message.parts : []) {
        if (part?.type === "text" && typeof part.text === "string") textParts.push(part.text);
      }
    }
    const text = textParts.join("");
    // TD-199（双席会审修正）：终态先跑台账补漏扫描再判失败——空文本/usage 失败
    // 路径下，已发生的工具事实必须保留（原实现空文本会压掉全部证据，已记录的
    // 真实工具活动随失败丢失）；轮询期已增量发过的事件由台账天然去重。
    for (const event of projectTurnToolEvents(newMsgs, toolLedger)) {
      yield event;
    }
    if (text.trim().length === 0) {
      finish();
      yield doneEvent(
        "failed",
        "zcode turn completed without assistant text (step-finish reason stop, no text parts — refusing to fabricate completion)",
      );
      return;
    }
    let usageResult = null;
    try {
      usageResult = await wire.request("session/usage", { sessionId });
    } catch (error) {
      finish();
      yield doneEvent(
        "failed",
        `zcode session/usage failed after turn completion: ${bounded(error?.message ?? error)}`,
      );
      return;
    }
    // 进程回收先行（事件序列已定，usage 已取完）。
    finish();
    if (typeof sentContent === "string" && sentContent.length > 0) {
      yield messageEvent("user", [{ type: "text", text: sentContent }]);
    }
    yield messageEvent("assistant", [{ type: "text", text }]);
    const metrics = metricsEventFromUsage(usageResult);
    if (metrics !== null) yield metrics;
    yield doneEvent("completed");
  }

  // 进程树击杀（缺省 taskkill /T /F——ProcessBackend/deepSeekAcp 同款；killFn
  // 注入缝仅供测试确定性观察）。**只声明"已启动"**：killFn 同步抛错才回落
  // child.kill；taskkill 自身的成败不在此核实（见 defaultTreeKill 诚实边界）。
  // 对已退出进程（exitCode/signalCode 已置）是 no-op——终态回收与 abort 幂等
  // 都依赖这一点。
  _kill(child) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    try {
      this._killFn(child);
    } catch {
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    }
  }
}

