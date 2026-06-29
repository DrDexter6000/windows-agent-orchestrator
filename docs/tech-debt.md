# 技术债登记表（唯一权威清单）

> 状态：✅ 强制维护。
> 本文件是全项目技术债的 **single source of truth**。
> 各 `docs/archive/mX-audit.md` 只记本里程碑的**动态**（新登记 / 偿还），并指向本表；
> 本表负责**全局汇总**——编号、状态、触发条件、登记里程碑。
>
> 维护规则（见 `milestone-discipline.md` §3）：每个 milestone 收尾审计时，
> 新发现的债追加到本表（递增编号），已偿还的标 ✅ 并注明偿还里程碑。
> **任何文档引用 TD-XX 必须能在本表查到对应条目。**

## 图例

- ✅ **已偿还** —— 已在代码中修复
- 🟡 **开放** —— 已登记，按触发条件处理
- ⚪ **设计性约束** —— 不是债，是刻意的边界（记录以防重复讨论）

---

## 已偿还

| # | 登记于 | 内容（简） | 偿还于 |
|---|--------|-----------|--------|
| TD-1 | M0 | runManager 动态 `await import("./transcript.js")`（本可静态） | M0 当场修 |
| TD-2 | M0 | waitForCompletion 与 abort 双调 onRemove 无幂等保护 | M0 当场修（`_removed` flag） |
| TD-3 | M0 | backend.abort 失败时 catch 不写 state_change（内存/transcript 不一致） | M0 当场修（catch 也 transition） |
| TD-6 | M1 | OpenCodeServeBackend 旧 waitForCompletion 死代码（含 2 测试） | M1 删除 |
| TD-7 | M1 | runManager 末尾 sleep 死代码 | M1 删除 |
| TD-8 | M1 | resume 里第二处动态 import（TD-1 同模式漏改） | M1 当场修 |
| TD-9 | M1/M2/M4 | RunEvent 证据链事件（command/file_written/tool_use/tool_result）未实现 | **M6** 全部实现 + claude/codex 两个 backend 提取 |
| TD-10 | M1 | 进程式 resume 不可能（TypeError） | M3-5 重放路径 |
| TD-11 | M2 | ProcessBackend 模块级 resolveWait 跨 run 共享（作用域 bug） | M2 重构为 EventQueue 类（实现中自检发现） |
| TD-14 | M2 | resume 硬编码 opencode 方法 | M3 按 backend 类型分支 |
| TD-17 | M2 | codex 在 Windows 是 .cmd 包装器，spawn EINVAL | M2 覆写 resolveBinary 直调 codex.js（**真实 smoke 才暴露**） |
| TD-18 | M2 | opencode 流式 parts 竞态（emit 不完整 message） | M2 改稳定性判定（看到 assistant 再确认快照不变才 emit） |
| TD-19 | M3 | createWorktree 返回 Promise 但 start 没 await | M3 当场修 |
| TD-20 | M3 | mock getAgent 的 `...overrides` 不过滤 undefined | M3 当场修（mock 对齐真 registry.js） |
| TD-25 | M5 | router activeRoutes 在层结束时清除（影响下一层） | M5 改 pendingRoutes（**真实 smoke 才暴露**） |
| TD-26 | M5 | _log payload 字段覆盖 transcript context 同名字段 | M5 自动重命名冲突字段（**真实 smoke 才暴露**） |
| TD-35 | 事故修复 | **会话兜底 abort 缺失（真实事故）**：RunManager 的 completed/failed/timed_out 路径都不调 handle.abort，opencode-serve 的 HTTP session 在 run 结束后可能继续活着。对无限多轮模型（DeepSeek-v4-flash）是 quota 黑洞——一次 researcher run 超时后 serve session 未被 abort，烧光用户当日 quota。 | 2026-06-17 修复：`_runCleanup` 兜底调 `handle.abort`（幂等 `_sessionKilled` flag 防 user-abort 路径重复），3 红绿测试覆盖 completed/failed/timed_out。注意：这只偿还“缺少 abort 调用”，后台 quietness 验证另见 TD-37。详见 `docs/incidents/2026-06-17-deepseek-quota-drain.md` |
| TD-37 | 2026-06-18 GLM quota 事故 | opencode `stop`/abort 只验证本地 ledger，不验证 serve 端 session 是否真停；06-18 事故实证会导致后台继续烧 token | 2026-06-26 完全清零：`stopCommand` abort 后做 bounded polling（token/message 增量比对），quiet=false 强制 taskkill 兜底 + `run.stop_unverified` + 告警；reliability stop drill 真实 provider 端到端通过，`backendStopQuietVerified` 有证据。详见 `docs/incidents/2026-06-18-glm-quota-drain.md` |
| TD-38 | 2026-06-23 Safety Gate | 可靠性 | `_runCleanup` 兜底 abort（TD-35）不做静默验证，可能虚假成功 | 2026-06-24 修复（C6）：`_runCleanup` abort 后调 `_verifyStopQuietIfCapable`——handle 有 session/messages（opencode 类）则复用 verifyStopQuiet 验证后台静默；未停写 `run.stop_unverified` + 告警。进程式 backend 自动跳过验证。与 TD-37 + S1-1 共同构成 opencode 三层防线 |
| TD-39 | 2026-06-23 外部审计 P0 | 可靠性 | 最小护栏（拒绝裸 spawn）只是"拒绝脚枪"非"关洞"——fire-and-forget 仍可造孤儿 session | 2026-06-25 修复（M7-P2）：新增 `src/backgroundRunner.js`（detached runner 进程）+ CLI `run/spawn --background`。CLI 不再拒绝裸 spawn，而是 fork detached runner 托管（token 闸门/超时/兜底 abort 全生效），不再产孤儿 session（06-18 架构洞正解）；顺带根治 F1。RunManager 旧护栏保留作深度防御。详见 `docs/archive/m7-phases.md` P2 |
| TD-40 | 2026-06-23 外部审计 P2 | 可靠性 | Node v24 有 libuv Windows Job Object 回归（杀长进程）；架构 spec §4.3 想要的 Job Object 绑定未实现 | 2026-06-26 修复：**重定义**为"在零依赖约束下复用 Node 内置 Job Object（v22）+ engines/启动校验守住"。行业调研结论——业界最佳实践 = taskkill /T/F（WAO 现状）+ 复用内置 kill-on-job-close，**无主流包用自定义 Job Object**（需 native binding，违反零依赖）。新增 `src/nodeVersionGuard.js`（v22 放行/v24 全拒/数据驱动未来修复版放行）接入 cli+daemon+backgroundRunner 三个 spawn 入口；`engines.node: ">=22 <25"`；保留 taskkill /T/F 作主动 abort。测试用 `WAO_SKIP_VERSION_GUARD=1`（`npm test` 已注入）。详见 ADR 0013 |
| TD-33 | M6 | opencode-serve 证据提取未实现（schema 已在 `research/07` 勘测完毕，待落 parser） | 2026-06-18 修复：`opencodeServe` 从 tool part 抽取 command/file_written/tool_use/tool_result evidence；后续 runtime+model 组合用 `npm run reliability -- --profile strict` 做 live 认证 |
| TD-36 | runtime certification | Claude Code 外部 `.bat` wrapper 用裸 `%*` 转发参数，prompt 中的 `<...>` 被 `cmd.exe` 当作重定向二次解析，导致进程 exit 0 但 stdout 为空，WAO 只能看到伪完成 | 2026-06-18 修复：新增 `agent.prependArgs` + `scripts/wrappers/claude-code-provider-wrapper.mjs`，用 Node `spawn(binary, args)` 数组转发参数；DeepSeek via Claude Code wrapper 通过 strict reliability matrix |
| TD-27 | M5 | 错误处理 | 并行层 handler 抛错（非 backend 错误）让 Promise.all reject 整个层 | 2026-06-23 修复：engine per-node try/catch，handler 抛错节点记 `completed:false + error`，失败传播照常走，兄弟节点不受影响。TDD 红绿覆盖 |
| TD-30 | M5 | 超时 | 无 workflow 级整体超时（只有单节点 waitTimeout） | 2026-06-23 修复：`execute()` 支持 `options.workflowTimeout`，每层开始前检查 deadline，超时截断剩余层并返回 `{completed:false, timedOut:true}`。不传则 Infinity（向后兼容） |
| TD-12 | M2 | 去重 | claude stream-json 同 message.id 分多条到达，不去重 | 2026-06-23 修复：`ClaudeStreamParser` 维护 `_seenMessageIds` Set，重复 id 的 assistant 行跳过；无 id 不去重（向后兼容） |
| TD-28 | M5 | 测试 | router 下游同时有 dataEdge 边的行为未测 | 2026-06-23 补测试：router 选中的下游同时通过 dataEdge 接收数据，验证路由过滤 + 数据传递都生效（行为本就正确，纯覆盖缺口） |
| TD-32 | M6 | 测试 | scorecard 并发证据未测（多条 command 同时到达，evidence 数组顺序） | 2026-06-23 补测试：多条同命令不同 exitCode（锁定 find 取首个的顺序依赖）+ tool_result 乱序到达按 toolCallId 关联推断 exitCode（含 isError=true 失败路径） |
| TD-5 | M0 | 测试 | 并发场景未测（多 run 同时 wait/abort） | 2026-06-23 补测试：两 run 并发 wait 交叉 abort（验证 activeRuns 隔离 + _aborted flag 独立）+ 同 manager 内并发一超时一完成 |
| TD-22 | M3 | 命令缺失 | persistent worktree 累积，无 worktree 管理命令 | 2026-06-24 修复：新增 CLI `worktree list` / `worktree remove <path>`（能力层 listWorktrees/removeWorktree 早已实现，补 CLI 暴露 + help）。2 红绿测试覆盖 |
| TD-21 | M3 | 偶发 | worktree remove Windows 偶发 Permission denied（已加 fallback，测试偶发 ~1%） | 2026-06-24 修复：removeWorktree 加 3 次重试 + 线性退避（100/200ms），rmSync fallback 后检查 existsSync 确认真删；幂等/容错测试覆盖（删两次/删不存在路径不抛） |
| P1-1 | 2026-06-23 外部审计 P1 | 可靠性 | **✅ 已实现 + 测试守卫（opt-in 强制门）**：审计 P1——dispatch 路径不校验 worker 是否在新鲜 reliability-summary 里。修复：RunManager.start 支持 `requireCertified`（opt-in，默认关），启用时读 `runDir/reliability-summary.json` 校验 ①worker 在 summary ②status ∈ {certified,conditional}（core 全过即放行）③generatedAt 在 certFreshnessDays(30) 内，不满足则 spawn 前拒绝 + 指引。CLI `run --require-certified` 暴露。06-18 事故教训"调度安全不能建立在模型行为假设上"。**2026-06-25 补 8 红绿测试守卫全部路径**（默认关/缺summary/worker缺失/rejected/certified/conditional/manualOverride/过期），门控逻辑不再无守护。认证重跑已闭环（见 TD-42） | ✅ 门已落 + 8 测试守卫；认证闭环见 TD-42 |
| TD-42 | 2026-06-24 配置验证 | 验证 | agents.example.json 对齐决策 0005 后，3 个新配置未经 probe 验证。**2026-06-25 闭环**：全量 reliability 重认证 + probe 实测全部验证——① coder_low `glm-5-turbo`=certified ② `ZHIPU_API_KEY` env 名正确（coder_low/coder_hq 双双 certified）③ auditor 配置：`opus-4.8` 是无效格式（claude-code 2.1.187 只认别名 `opus` 或全名 `claude-opus-4-8` 连字符），改 `claude-opus-4-8`+`--effort xhigh` 后 certified。6 worker 全认证（5 certified + coder_mm conditional） | ✅ 2026-06-25 全部 probe + 认证验证闭环 |
| TD-43 | 2026-06-25 安全 | **进程式 backend silentTimeout 断路**：RunManager 算出 silentTimeout 传给 `handle.events(signal,{silentTimeout})`，但 processBackend.events 签名是 `(signal)` 第二参数被丢弃——进程式 worker 静默死循环（provider 529 重试 / 白名单 / 不存在的 model，进程活着但 parser 零产出）只能干等 waitTimeout，期间烧 token 占资源。是 opencode 三层防线（TD-37/38/39）之外、进程式 lane 独有的静默缺口 | 2026-06-25 修复：processBackend.events 接第二参数，_streamEvents 复用 opencodeServe 语义——silentTimeout 内无任何 parser 事件则 `doneEvent(failed,'silent timeout')`+kill。3 红绿测试覆盖（静默触发/有响应不误杀/不传则向后兼容） |
| TD-44 | 2026-06-25 运维 | reliability 套件 WAIT_TIMEOUT 默认 120000，strict profile 含 scorecard+isolation+workflow 多 drill，120s 在重 worker（codex/claude-code strict）上卡边界，全量批跑易 timeout | 2026-06-25 修复：默认调到 300000（`--wait-timeout` 本就支持覆盖）。milestone-discipline §6.7 补运维说明（单 worker 增量合并 + 超时） |
| TD-54 | 2026-06-26 二次 dogfood | `run/spawn --background` 参数透传不完整会生成 ghost runId（默认 registry/runDir 未透传、`--prompt-file` 未进入 runner、启动失败无 transcript） | 2026-06-26 修复：background 分支先 `loadPrompt()`；detached runner 默认接收 `config.registry`；`runBackground` 预生成 runId 并在启动失败时写 failed transcript（含 `prompt.sent`/`run.error`）；help 补 `run --prompt-file`；`test/cli.test.js` + `test/backgroundRunner.test.js` 覆盖 |
| TD-55 | 2026-06-26 二次 dogfood | 手动 stop 与 wait 路径竞态破坏终态/seq（aborted 后被 failed 覆盖，seq 回退，diagnose 误归 crash） | 2026-06-26 修复：`JsonlTranscript.append` 加文件锁并按磁盘最大 seq 续写；`waitForCompletion` 写终态前尊重 transcript 既有 terminal state；stop 路径写 `run.aborted`；diagnose 前置识别 stop/aborted；`test/transcript.test.js`/`test/runManager.test.js`/`test/diagnosis.test.js` 覆盖 |
| TD-56 | 2026-06-26 二次 dogfood | 活跃 tool/command/metrics events 不触发 running 状态，主控轮询误读为未启动 | 2026-06-26 修复：`waitForCompletion` 对首个 message 继续用 `first_message`，对首个 metrics/tool/command/file evidence 统一转 `running(first_event)`；`test/runManager.test.js` 覆盖 |
| TD-57 | 2026-06-26 二次 dogfood | `wao handoff write --to lead` 与 `wao handoff read lead` 寻址不对称，worker→lead incoming 读不到 | 2026-06-26 修复：`readHandoff` 扫描 handoff 正文 heading `from → to (ts)`，按 `to === role` 过滤并取最新 incoming；CLI help 明确 latest incoming；`test/waoHandoff.test.js` 覆盖 |
| TD-58 | 2026-06-26 二次 dogfood | `AGENT_ONBOARDING.md` 最小闭环示例引用已不存在的 `coder_strict` / `coder_glm_claude` | 2026-06-26 修复：onboarding 改为 `coder_low` 最小闭环、显式 `--cwd <目标项目>` + `--registry <WAO目录>/config/agents.json`，补 runtime skill 目录安装说明并消除重复 `## 4`；`test/docs-consistency.test.js` 覆盖 |
| TD-52 | 2026-06-26 M8 | help 与代码漂移：`printHelp` 漏列 `runs dashboard/diagnose/forecast`、`wao` 族、`daemon` 族 | 2026-06-26 修复：补全 printHelp + spawn-based help 守卫测试，见 `test/cli.test.js` |
| TD-53 | 2026-06-26 M8 | `run --format json` 在 scorecard 注入前 early-return，导致 JSON 输出无 `scorecard` 字段 | 2026-06-26 修复：scorecard 注入前置于格式分支之前，json/text 两路都带；`test/cli.test.js` 覆盖 |
| TD-59 | 2026-06-26 fresh-runtime handoff WF-1 | claude-code OAuth 登录态会覆盖 provider wrapper 注入的第三方 provider key，导致 researcher/coder_hq/coder_low 对 DeepSeek/ZHIPU 401 | 2026-06-26 修复：`claude-code-provider-wrapper.mjs` 为 provider worker 设置隔离 `CLAUDE_CONFIG_DIR=.wao-worker-claude-config/`，删除 OAuth refresh hint，保留 `ANTHROPIC_AUTH_TOKEN` provider key 注入；auditor 不走 wrapper，不受影响。`test/claudeProviderWrapper.test.js` + docs-consistency 覆盖 |
| TD-60 | 2026-06-26 fresh-runtime handoff WF-2 | `run/spawn --background --scorecard-rules <非法 JSON>` 会先返回 runId，detached runner 随后解析失败退出，形成无 transcript 的 ghost run | 2026-06-26 修复：`spawnBackgroundRunner` fork 前复用 `parseScorecardRules` 做 fail-fast，非法 JSON 在可见 CLI 进程内非零失败且不打印 runId；`test/cli.test.js` 覆盖 |
| TD-61 | 2026-06-26 fresh-runtime handoff WF-3 | `wao doctor` 只检查 provider key 存在，不提示 Claude OAuth 登录态可能覆盖 provider-wrapped worker 的第三方 key | 2026-06-26 修复：doctor 读取 `~/.claude/.credentials.json` 的 `claudeAiOauth`，并在 registry 存在 provider-wrapped claude-code worker 时输出非失败 WARN；auditor-only 不触发；`test/cli.test.js` 覆盖 |
| TD-62 | 2026-06-26 fresh-runtime handoff WF-4 | PowerShell 经 `npm run cli --` 传 inline `--scorecard-rules` 容易损坏 JSON，且缺少文件型规则入口 | 2026-06-26 修复：新增 `--scorecard-rules-file`，foreground/background 统一从文件加载并复用 scorecard JSON 校验；help 与 SKILL 示例改为文件方式；`test/cli.test.js` + docs-consistency 覆盖 |
| TD-63 | 2026-06-26 fresh-runtime handoff WF-5 | `runs scorecard --format json` 在无 `scorecard.checked` 时输出纯文本且误报“无规则”，无法区分未配规则与提前失败 | 2026-06-26 修复：无结果分支尊重 `--format json`，输出 `{scorecard:null, reason:"no_rules"|"failed_before_scorecard"}`；RunManager 在 `run.started` 写 `scorecardConfigured` 供判别；`test/cli.test.js` 覆盖 |
| TD-64 | 2026-06-26 fresh-runtime handoff WF-6 | `run --background` 返回 runId 后立即 `status <runId>` 可能因 transcript 尚未创建而 ENOENT | 2026-06-26 修复：`spawnBackgroundRunner` fork detached runner 前同步写 `run.background_submitted` + `pending` 状态 transcript，返回 runId 时 `status --format json` 已可读；`test/cli.test.js` 覆盖 |
| TD-65 | 2026-06-26 fresh-runtime handoff WF-7 | `status` 实际输出 JSON，但 help 未暴露 `--format json`，首次使用者无法确认机器可读契约 | 2026-06-26 修复：help 补 `status <runId> [--run-dir DIR] [--format json]`，并由 help 守卫测试覆盖 |
| TD-66 | 2026-06-26 fresh-runtime handoff WF-8 | `registry list` 的 model 列对 kimi-code/codex 默认配置显示 `-`，选型时误读为缺模型信息 | 2026-06-26 修复：提取 `displayModel()`，按 `model`/`provider.model`/args/prependArgs flags 取显式模型，进程式 backend 缺省时显示 `(default)`；`test/cli.test.js` 覆盖 |
| TD-67 | 2026-06-26 fresh-runtime handoff WF-9 | `runs dashboard` 固定 `RUN_ID` 列宽，长 runId 会把后续列整体推歪 | 2026-06-26 修复：dashboard 先构造表格行，再按本批数据动态计算列宽；长短 runId 对齐测试覆盖 |
| TD-68 | 2026-06-26 fresh-runtime handoff WF-10 | README/SKILL/AGENT_ONBOARDING 对 `registry list` / `registry check` / `registry validate` 三命令分工不一致，首装用户会犹豫该跑哪个 | 2026-06-26 修复：三份入口文档统一短锚点：`registry list = inventory + certification status; registry validate = static schema; registry check = live opencode health`；docs-consistency 覆盖 |
| TD-69 | 2026-06-26 reliability gate | `scripts/run-reliability.mjs` isolation drill 调用 `execFileSync` 但未从 `node:child_process` 导入，导致真实 reliability gate 中 researcher core/strict 过但 operational 误失败 | 2026-06-26 修复：补 `execFileSync` import，并在 `test/reliabilityCertification.test.js` 增加静态守卫；随后 `npm run reliability -- --agent researcher` 与 `--agent coder_low` 均通过 |
| TD-70 | 2026-06-27 flaky test ticket | Windows 全量并行下 background/detached CLI 测试清理临时目录时，detached runner 仍可能短暂持有 cwd/file handle，导致 `rmSync(..., {recursive:true, force:true})` 抛 `EPERM`/`EBUSY`/`ENOTEMPTY` flake | 2026-06-27 修复：`test/cli.test.js` 增 `rmrfRetry()` 同步重试 helper，并将 background/detached 相关临时目录 cleanup 切到 retry；新增 Windows cwd-hold 回归测试；验证命令见本次工单记录 |
| TD-72 | 2026-06-28 fresh-agent 入口流程 | 两个互锁缺口：① `wao doctor` 把 `wao_init: 未初始化` 计为 FAIL（exit 1），但 doctor 是 onboarding §4d 的 preflight 第一道——"未 init" 是 `run wao init` 之前的正常初态，不该与 401/key 缺同列让 fresh-agent 第一步误判环境坏；② **SSOT 铁律盲维**：三条铁律 + docs-consistency.test.js 守的全是"内容去重"（状态机/事件表/角色），**命令调用形式一致这一维从未被铁律或测试覆盖**，导致 AGENT_ONBOARDING.md 全文 8 处用 `node <WAO>/src/cli.js`（v24 下被 version guard 拒），而正确的 `npm run cli`（v22 shim）从未出现在任何面向 agent 的入口文档——fresh-agent 照抄 onboarding 在第一步 `wao init` 就被挡，且文档没告诉他正确入口。 | 2026-06-28 修复：(a) doctor `wao_init` 改三态——已初始化 OK / 未初始化 WARN（不计入 HEALTHY 判定，exit 0）/ 结构异常 FAIL（回归保护）；新增 never-inited 与结构损坏两测试。(b) AGENT_ONBOARDING/SKILL/usage/troubleshooting/AGENTS 的裸 `node .../src/cli.js <真命令>` 统一切到 `npm run cli --`，保留"不要直调"解释注。(c) **核心**：docs-consistency 增"命令调用形式一致"护栏测试（扫描 6 份入口文档，禁止裸 `node .../src/cli.js <真命令>`，白名单 help/explanatory）——把"命令形式一致"从 prose 铁律变成机器不变量。元教训：凡依赖 agent 自觉遵守 prose 的约束都会漂，落到确定性测试里才守得住。`test/cli.test.js` + `test/docs-consistency.test.js` 覆盖；真实 fresh-agent e2e 闭环（coder_low）通过。 |
| TD-73 | 2026-06-28 friction log 收口 | auditor 使用缺成本闸门：SKILL 旧把 auditor 列为责任链默认一环，无"何时跳过"反向闸门，Lead 拿确定性证据仍多跑 auditor 烧 token（tester run 459s/2.65M tokens 仍触发）。证据：两份独立 friction log（WAO core + `<目标项目>_gui` FL-7）独立报告同一现象，指向机制缺口。 | 2026-06-28 Lead verdict 落地：SKILL §"Auditor 调用 policy"——默认跳过 auditor（自审+scorecard 优先，不确定才加）；**无硬红线**（任何场景 Lead 可跳过并对决策负责）；前置/后置 auditor 各自独立判不预设优先级。守住 🟡 边界：policy 落成 SKILL 显式规则但不自动化替 Lead 决定。证据素材见 `.dev/friction-log/2026-06-28T17-00_wao-and-gui-friction-log-merged.md`（auditor -SkipBackend 拦截作反向证据保留）。 |
| TD-74 | 2026-06-28 codex e2e | 诊断精度 | diagnosis 缺 provider 流式中断识别：无 `provider_disconnect` 类，"中途静默+exit 1+无 result"被笼统归 crash（runtime 真崩），与"provider 偶发断流可重派"混为一谈。证据 `run_2026062818401405116u1yd`（coder_hq/GLM-5.2）：死前 84 事件 + 末段静默后 exit 1，metrics=0，属 GLM 网关流式中断。 | 2026-06-28 落地（与 TD-75 合并）：`src/diagnosis.js` 新增 `provider_disconnect` 类（排在 crash 之前），**Lead verdict 判据**=死前 last run.event 距 run.error ≥120s + ≥3 run.event + state=failed + 无 completed，保守（宁漏贴勿误贴），不满足落回 crash。**未改 processBackend 兜底**（exit≠0→failed 结论对，改了削弱真崩检测）。test/diagnosis.test.js +3 测试。 |
| TD-75 | 2026-06-28 codex e2e | 可观测性/Lead 契约 | worker 心跳暴露给 Lead：此前判 worker "活没活"只能猜静默时长，易误判停一个还在思考的 worker（"打架内耗"）。缺一个只反映"worker 在产出"的轻量信号（不存 thinking 内容，token/隐私成本）。 | 2026-06-28 落地：`status` 加 `lastActivityTs` + `secondsSinceActivity`（= 最后一条 run.event 的 ts 及距今秒数；appendFile 每 event flush 故实时）。**只看事件流不引 isAlive**（Lead 选）。SKILL §轮询节流升级：secondsSinceActivity<120 还活着别动（守宁慢勿杀），≥120 才判停/重派；**判停永远 Lead 决定，WAO 不自动停**。test/cli.test.js +3 测试。未做：thinking 内容进 transcript（独立大议题）。补全：lastActivityKind + lastActivitySummary（message→在说话 / command→跑命令 / tool_use→用工具X / file_written→在写文件）。 |
| TD-76 | 2026-06-28 thinking 信号调研 | 可观测性 | **✅ 已落地（2026-06-28，方案 A：只记存在不存内容）**：thinking 期间 transcript 假死（worker 思考时无 run.event）是 TD-74 provider_disconnect 误判的根因。调研证实可行：claude-code stream-json 把 thinking 块放 `obj.message.content` 数组（decision 0009），流经 claudeCode.js:51 但被 `filter(c=>c.type==="text")` 丢弃。**真实 schema 实证**（GLM-5.2 网关实测，非臆测）：`{type:"thinking",thinking:"<内容>",signature:""}`，thinking 与 text 分两条 assistant 行（共享 message.id）；**GLM 确实吐 thinking**（推翻 WebSearch "可能抑制"顾虑）。 | 2026-06-28 落地分步：① 加 raw-capture 机制（`WAO_RAW_CAPTURE` env / `rawCapturePath` 构造参数，旁路日志，不影响 transcript）；② 真实 coder_low run 拿 schema（GLM 确认吐 thinking）；③ `runEvent.js` 加 `thinkingEvent()` + `claudeCode.js` 捕获 `type==="thinking"` emit 心跳事件（**不存内容**，零 token/隐私成本）；④ `cli.js` describeActivity 映射 thinking→"在思考"。心跳思考期间持续，消除假死。**codex 后端仍无 thinking 信号**（parser 无 thinking item），其静默仍按 ≥120s 判——留观察。test/processBackend.test.js +3。 |
| TD-77 | 2026-06-28 codex e2e（双子项） | 失败 run 信息抢救 | **✅ 已落地（2026-06-28，双子项 A+B）**：失败 run "崩溃后两手空空"是同一用户体感的两条腿——`collect` 只重建 message（A）+ `diagnose` 仅 exit code 无 stdout 线索（B）。证据 `run_20260628203352049lf1n0l`（researcher/claude-code 崩溃）：崩前有 144 条证据事件但无最终 message → `collect` 返回 `data:[]`；进程崩时未写 stderr → `diagnose` 只给 `process exited with code 1`。codex 调度讨论文档自陈"失败 worker 的 collect 为空，验收只能读 transcript，提高整合成本"正是此债。 | **子项 A（collect 重建）**：`cli.js` collectCommand 进程分支过滤器去掉 `kind==="message"` 限制，按 runEvent.js 字段表重建所有 run.event kind（message/command/tool_use/tool_result/file_written），输出升级为事件时间线。thinking 不重建（runManager 未持久化）。`data` 元素形状从 `{info:{role},parts}`（message-only）改为 `{kind,role,parts}`（事件时间线）——契约变化但经全仓 grep 确认无调用方消费旧形状（runs.test.js:331 既有测试已同步更新断言）。**子项 B（stdout 尾留存）**：`processBackend.js` 镜像现有 stderrTail 机制加 `stdoutTail`（累积/getStdoutTail accessor/trimStderrTail 通用化为 trimTail），detail 拼装升级——stderr 优先，无 stderr 回落 stdout 尾，都无才纯 exit code。**单点修复**：不动 runManager.js（doneError 透传）/diagnosis.js（读 run.error.error 自动变富）。test/cli.test.js +3、test/processBackend.test.js +2、test/runs.test.js 同步契约。 |
| TD-79 | 2026-06-28 codex e2e | 环境隔离 | **✅ 已落地（2026-06-28，config 层 + SKILL 层双保险）**：read-only worker（researcher）跑 `pip install -e .` 污染全局 Python env——worktree 隔离了文件，没隔离 interpreter/site-packages。证据 `run_20260628203352049lf1n0l` 同一 researcher run。codex 调度讨论文档自陈"researcher 在只读任务里跑 pip install，降低对其继续承担关键路径的信任"。 | **config 层（🟢 工具域，确定性单点）**：选 layer (b) env 注入（非 layer a venv 包装——fights Windows .cmd 路径且 worker binary 非 python）。`processBackend.js` spawn env 块加 `...(agent.env ?? {})`（透传链路：effectiveAgent spread 保留 env → backend.spawn(agent) → processBackend）。`agents.example.json` researcher 加 `env:{PIP_REQUIRE_VIRTUALENV:"1",PYTHONNOUSERSITE:"1"}` 示例（OS-native：pip 在无激活 venv 时直接拒绝安装）。`cli.js` registry validator 加 env 字段形状校验（`{string:string}` 对象）。**不自动建 venv**（layer a 过重跨平台复杂）。**SKILL 层（🔵 防御纵深，归阶段 3）**：read-only worker prompt 禁 pip install 见 SKILL §1 step3。**注意**：agents.example.json 是模板，用户真实 `config/agents.json`（gitignored）需手动应用此 env——SKILL 会提示。test/processBackend.test.js +2、test/cli.test.js +2。 |

---

## 开放（🟡）

| # | 登记于 | 类别 | 内容 | 触发条件 / 何时处理 |
|---|--------|------|------|---------------------|
| TD-4 | M0 | 架构 | stopCommand 直调 backend.abort 不走 RunManager（不写 state_change）。语义：stop 操作历史 run 可能已不在 activeRuns | M7 resume/恢复统一两条路径（active→RunManager.abort，历史→transcript 追加） |
| TD-13 | M2 | 跨平台 | ProcessBackend abort 用 Windows taskkill /T /F | 需跨平台时加 platform 分支（AGENTS.md 约束只 Windows） |
| TD-15 | M2 | 语义 | ProcessBackend retries 参数被忽略（进程式不幂等重试） | 需进程级重试（如 OOM 重启）时定义语义 |
| TD-23 | M3 | 未接入 | portAllocator 实现了但 RunManager 没用 | M5+ DAG 并行多 opencode-serve 实例时接入 |
| TD-24 | M4 | 精度 | opencode token 是"最后一条 assistant 累计值"非增量，多轮可能偏高。**部分覆盖**：metrics 已改用 session endpoint 累计值（P0-B 修复），比 message.info.tokens 准。但 session 级仍是累计非分轮，需精确分轮时再处理 | 需精确分轮 token 时处理 |
| TD-29 | M5 | 内存 | 大 DAG（100+ 节点）completedResults Map 内存占用 | 实际遇到大 DAG 时做流式/分页 |
| TD-31 | M5 | 安全 | workflow .mjs 有完全 JS 能力（和 npm script 同级风险） | 文档标注即可（与 npm script 同级，非新增风险） |
| TD-34 | 文档审计 | 维护 | `test/docs-consistency.test.js` 的断言是文档内容指纹（关键词/端口/编号）。文档大幅重构时需同步更新断言（断言≠文档质量本身，只是不变量守卫） | 文档结构性重构时同步断言 |
| TD-41 | 2026-06-23 测试稳定性 | 偶发 | `processBackend.test.js:108 "abort 能杀掉长时进程"` 在全量 suite 并发负载下偶发失败——taskkill /T /F 后 Node 回收子进程 exitCode 偶发 >2s（已轮询 2s）。隔离跑稳定（3/3 过）。非 WAO bug，是 Windows + Node 进程回收在高负载下的固有延迟 | 不阻塞；若 CI/批跑频繁红，考虑给该测试加 retry 容忍或用 `child_process` exit 事件而非轮询 isAlive |
| TD-71 | 2026-06-27 测试稳定性 | 偶发 | 未知非 EPERM flake：用户全量 `npm test` 第 5 轮出现一次 605/606、1 fail，但未捕获失败测试名；随后用户 8 轮未复现，Codex 本轮 TD-70 gate 5 轮 + 追加捕获 10 轮均未复现。已确认不是 TD-70 的 detached temp-dir `EPERM` cleanup 问题 | 暂不修复、不猜根因；下次复现必须保留完整 `npm test` 日志和失败测试名。建议命令：循环 `npm test *> $env:TEMP\\wao-flake-capture\\npm-test-<stamp>.log`，首个非零退出即停止并保留 tail/完整日志 |
| TD-45 | 2026-06-25 M7-P3-T1 | 可靠性 | **✅ 已落地（2026-06-26 修正登记）**：daemon 自愈已实现为 `src/daemonSupervisor.js`——独立 detached supervisor 进程（CLI 一次性 spawn），轮询 daemon 心跳，判死→重启 daemon（带 `--resume-on-start` 接管未完成 run）+ 退避防风暴（`decideSupervisorAction` 纯函数：风暴退避 > 判死重启 > 空闲自退 > noop）。**残留边界**：supervisor 自身被杀（如机器重启）无法自拉——"重生引导"需 Windows 服务/计划任务，留 v2。 | ✅ 主体已落地；supervisor 自身崩溃后的重生引导（Windows 服务/计划任务）留 v2 |
| TD-46 | 2026-06-25 M7-P3-T1 | 可靠性 | **🟡 可观测已就位，根因待真需求**：daemon 进程组累积清理 + 句柄/内存泄漏。daemon 常驻数小时/天会累积 worker 子进程残留、句柄泄漏——单测覆盖不到。P5-T2 已加监控（assessDaemonHealth，rss/heap/worktree/activeRuns + 阈值告警）；P5-T3 长跑 dogfood（45min/265run）**本轮未触发**（保守阈值下）。 | 🟡 根因修复留待真需求：更长时长/更高负载触发 health warn 后针对性修。监控 ✅ 已落地（T2） |
| TD-47 | 2026-06-25 M7-P3-T1 | 能力 | **🟡 划给 P5/v2**：tail 流式 IPC。P3-T1 daemon IPC 只做请求-响应（ping/list/status/start/stop/shutdown），tail 沿用文件轮询（现有 `tail --follow`）。流式推送需 IPC 长连接 + 多路复用/分帧，与"窄协议换简单"取舍相悖，故推迟。 | 🟡 真实需求驱动时再加（SSE 式推送 over 命名管道，或保留文件轮询） |
| TD-48 | 2026-06-26 M8 | 性能 | **🟡 潜在性能债**：`runs dashboard` / `runs forecast` / `runs diagnose` 逐个读全量 transcript（O(runs) 文件读取 + 全事件扫描）。runs 目录历史 run 累积到上百个时，dashboard 单次渲染会变慢。当前 M8 不阻塞（聚合是只读、无并发需求场景），但批量历史时需优化。 | 🟡 真实需求驱动时优化：缓存最近 N 个 run 的聚合结果 / 只读最后 K 个事件判态 / 增量索引。优先级低（dashboard 主要看在飞 run，历史 run 多时 Lead 通常配 --latest N） |
| TD-51 | 2026-06-26 TD-37 收口 | 测试基础设施 | **✅ 已解（2026-06-26，TD-37 收口同轮）**：原问题——reliability 的 `runCli` 用 `execFileSync` spawn CLI，CLI 内部 detached background runner（`spawn` 路径）被回收，stop drill 拿不到 transcript。**真实根因有二**（收口时挖出）：① `execFileSync` 在 Windows 退出时清理进程树连杀 detached 孙进程 → 改用 `spawnSync`（直接 spawn不清理进程树）；② **detached runner 继承 CLI 的 cwd**——cwd=TMP_DIR 时 runner 找不到 registry/config 秒退 → stop drill 的 spawn/stop 改用 `cwd=ROOT`（项目根）。两修后 stop drill 端到端通过（见 TD-37 认证）。顺带修了 runCli 走 v22 shim + runDir 错位 + waitForTranscript + 预创建目录。 | ✅ 已解；stop drill 端到端认证通过（TD-37 清零） |


---

## 设计性约束（⚪，非债）

| # | 登记于 | 内容 | 备注 |
|---|--------|------|------|
| TD-16 | M2 | 真实 CLI smoke（`npm run smoke`）不进 `npm test`（依赖真实 API/登录/费用） | 刻意设计：smoke 显式手动触发，CI 不跑。`milestone-discipline.md` §4.4 已要求涉及外部系统的 milestone 收尾必跑 smoke |
| TD-50 | 2026-06-26 M8 | `src/diagnosis.js` 的失败分类是**启发式信号匹配**（正则 + 事件类型），非语义判断。边缘 case（如非 401 的 auth 失败、新 provider 错误格式）会降级为 `unknown`。**这是刻意设计**——诊断只给证据不给处方（M8-3 铁律），分类只是帮 Lead 快速定位，不强求高准确率。处方权全在 Lead。 | 刻意设计：防"让诊断更智能"的诱惑滑向自动应对策略表（用户明确否决机械应对）。新增 provider 错误格式时扩充 AUTH_SIGNAL 即可，不必重构。

---

## 交叉引用索引

每个 TD 的**详细发现过程 / 修复 diff / 教训**在对应 audit（已归档到 `docs/archive/`）：
- TD-1~5 → `archive/m0-audit.md`
- TD-6~9 → `archive/m1-audit.md`
- TD-10~18 → `archive/m2-audit.md`
- TD-19~23 → `archive/m3-audit.md`
- TD-9(重)/24 → `archive/m4-audit.md`
- TD-25~31 → `archive/m5-audit.md`
- TD-9(偿还)/32/33 → `archive/m6-audit.md`
- TD-33 schema 勘测 → `research/07-opencode-smoke-and-weeds.md`
- TD-34 → `archive/docs-ssot-audit.md`（文档 SSOT 审计）
- TD-37/38/39 → `incidents/2026-06-18-glm-quota-drain.md`（opencode 三层防线 + fire-and-forget 护栏）
- TD-40 → `.wao/decisions/0013-进程隔离-JobObject-复用内置-vs-自定义.md`（复用内置 Job Object vs 自定义）
