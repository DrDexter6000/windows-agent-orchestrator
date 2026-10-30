// src/cliHelp.js
//
// The CLI help text as a named, importable constant.
//
// WHY a separate module: src/cli.js ends with a self-executing main() — importing
// it RUNS the CLI. The docs/surface generator (scripts/gen-surface.mjs) and any
// other consumer import HELP_TEXT from here instead, with zero side effects.
//
// 帮助页是给用户的速查：每条命令一行语法，需要说明的同行一句短话；内部
// 编号（决定号/TD 号/批次号）不进帮助页，长解释归 docs/usage/。run/spawn
// 的用法行与 RUN_USAGE_TEXT 列出 src/commands/run.js 读取的面向用户的参数；后台 runner
// 内部穿线用的 --run-id 不列。

export const HELP_TEXT = `Windows Agent Orchestrator PoC

Commands:
  version   # print the WAO version (bare semver from package.json; --version also works)
  consult run <briefFile> --seats a,b [--perspective <agentId>=<file>]... [--fields Q1=A,B]... [--reviewed-run <runId>] [--wait-timeout MS] [--format json|text] [--cwd DIR] [--registry FILE] [--run-dir DIR]   # 多席只读会审：扇出+收集，各席原文并列呈现，不做语义合成
  consult show <consultId> [--seat <agentId> [--out FILE]] [--format json|text] [--cwd DIR] [--run-dir DIR]   # 重渲染一场会审；--seat 取一席完整原文（--out 写进文件）
  consult wait <consultId> [--wait-ms MS] [--format json|text] [--cwd DIR] [--run-dir DIR]   # 继续等一场已扇出的会审（各席到终态或观察窗到期即返回，可反复调用）
  serve status [--url SERVEURL]   # kimi-web worker serve 观察面：实例元数据/荚规模/会话计数（零副作用）
  serve sweep [--url SERVEURL] [--apply]   # 清扫 WAO 认领且 worktree 已亡的 kimi 会话（默认 dry-run；--apply 才删）
  serve recycle [--workspace-dir <dir>] [--kimi-home DIR] [--registry FILE] [--url SERVEURL] [--kimi-exe PATH] [--soak-ms N]   # 闲置回收 worker serve：双门判定后优雅 shutdown 并显式重启；--workspace-dir 缺省取车道声明值
  registry list [--registry FILE]                    # 车道清单与各车道的认证状态
  registry check [--registry FILE] [--format json]   # live opencode-serve 健康探测；其他车道的就绪看 \`wao lanes\`，环境看 \`wao doctor\`
  registry validate [--registry FILE] [--format json]  # 静态 schema 校验，不改任何文件
  spawn <agentId> [agentId2 ...] --prompt "..." [--prompt-file FILE] [--cwd DIR] [--registry FILE] [--run-dir DIR] [--wait] [--poll-interval MS] [--wait-timeout MS] [--tag key=value] [--isolate|--no-isolate] [--scorecard-rules JSON] [--scorecard-rules-file FILE]
  run <agentId>|--lane <lane> --role <role> --prompt "..." [--prompt-file FILE] [--explain] [--cwd DIR] [--registry FILE] [--run-dir DIR] [--poll-interval MS] [--wait-timeout MS] [--format json|text] [--isolate|--no-isolate] [--require-certified] [--background] [--tag key=value] [--scorecard-rules JSON] [--scorecard-rules-file FILE] [--scorecard-mode warn|hard|off] [--delivery-spec-file FILE] [--read-only] [--model ID] [--reasoning EFFORT]
  status <runId> [--run-dir DIR] [--format json]
  tail <runId> [--limit N] [--follow] [--run-dir DIR]
  collect <runId> [--limit N] [--cursor TOKEN] [--mode full|compact] [--final [--out FILE]] [--format json] [--run-dir DIR]   # --final --out 把最终回答完整写进文件（多长都写）
  stop <runId> --observed-seq N --reason TEXT [--run-dir DIR]   # N = status 输出的 observedSeq；先看最新状态再停
  retry <runId> [--wait] [--run-dir DIR] [--model ID] [--reasoning EFFORT]
  resume <runId> [--wait] [--run-dir DIR]   # 不带 --wait = detached runner 托管续跑；--wait = 前台等待（本进程退出时 Job Object 连坐杀 worker）
  runs list [--run-dir DIR] [--agent AGENT_ID] [--latest N] [--active] [--state <state>] [--since <duration>] [--project <path|name|@sandbox|@scratch|@unattributed>] [--format json]
  runs summary [--run-dir DIR] [--format json]
  runs prune --older-than <duration> [--archive] [--run-dir DIR]   # --archive 把超龄 run 移到 runs-archive/（不删除，冲突不覆盖）
  runs migrate-projects [--apply|--verify] [--run-dir DIR]   # 存量分桶迁移：默认 dry-run 预览；--apply 实迁（幂等可续跑）；--verify 迁后核对
  runs grep <pattern> [--run-dir DIR] [--format json]
  runs lineage-close --run-id <runId> --reason-file <FILE> [--apply] [--run-dir DIR]   # 显式放弃一条交付线系：按门释放保留 worktree（本命令不删分支；默认 dry-run）
  runs settle [--run-dir DIR]   # 列出可结算的 runner 已死非终态运行（只读；各给闭集拒绝理由）
  runs settle --run-id <runId> --reason-file <FILE> [--apply] [--run-dir DIR]   # 结算 runner 已死的非终态运行为 failed/process_missing（逐门事实 dry-run；--apply 才写）
  runs metrics <runId>|--summary [--run-dir DIR] [--format json]
  runs scorecard <runId> [--run-dir DIR] [--format json]
  runs dashboard [--watch N] [--agent ID] [--latest N] [--format json] [--run-dir DIR]
  runs dashboard --web [--port N] [--run-dir DIR] [--cwd DIR]   # local read-only Owner dashboard
  dashboard [--cwd DIR] [--port N] [--run-dir DIR] [--no-open]  # Owner dashboard launcher (global wao command; auto-opens browser)
  runs diagnose <runId> [--run-dir DIR] [--format json]
  runs delivery <runId> [--run-dir DIR] [--format json]   # 交付状态查询（只读）
  runs delivery <runId> --accept|--reject --reason-file FILE [--run-dir DIR] [--format json]
  runs delivery reverify <runId> --reason <code> [--attempt 1|2] [--setup-commands-file FILE] [--timeout-ms N] [--run-dir DIR] [--cwd DIR] [--format json]   # 未变工件审计式重验证；--attempt 2 为第二次（也是最后一次）机会，仅当第一次因环境/工具码失败
  runs wait <runId> [--wait-ms N | --until-settled] [--format json|text] [--run-dir DIR]   # 阻塞等待终态或观察窗口到期（到期 exit 0）；--until-settled 轮询到收口才退出（互斥旗标，见 docs/usage/supervise.md）
  runs gate [--format json|text] [--release]   # 同机验证串行化闸：查 free/held/corrupt；--release 人工破锁（破除失败 fail-closed）
  runs verify-commit <runId> --commit <sha> --commands-file FILE [--timeout-ms N] [--run-dir DIR] [--cwd DIR] [--format json]   # 临时 worktree 检出该提交→执行命令→落证→清理（Lead 侧自检）
  playbook list [--format json]   # 列出内置 Lead playbook 摘要（只读）
  playbook show <id> [--format json]   # 展示一个完整 Lead playbook（只读）
  feedback submit --file <md> [--title <text>] [--inbox-dir DIR] [--format json]   # 宿主 Lead 报 WAO 缺陷/别扭到本机收件箱（不联网、不调用模型）
  feedback list [--all] [--inbox-dir DIR] [--format json]   # WAO 开发 Lead：列出未处理反馈；--all 含已处理
  feedback show <id> [--inbox-dir DIR] [--format json]   # 打印一条反馈全文（先找未处理，再找已处理）
  feedback close <id> --note <text> [--inbox-dir DIR] [--format json]   # 标为已处理并写明怎么处理（不改写已有处理说明）
  worktree list [--cwd DIR]
  worktree remove <path> [--cwd DIR]
  worktree reclaim [--cwd DIR] [--include <runId>]... --out <plan.json> [--run-dir DIR]   # 只读普查分类写清退计划，打印计划 sha256（Owner 按此批准）
  worktree reclaim --apply <plan.json> --expect-sha256 <hex> [--run-dir DIR]   # 执行已批准计划：分支先全量进 bundle，复核后摘树删分支，记录落 runs-archive/
  daemon start [--run-dir DIR] [--registry FILE] [--pipe PIPE] [--resume-on-start]
  daemon run <agentId> --prompt "..." [--run-dir DIR] [--registry FILE] [--prompt-file FILE]
  daemon stop [--run-dir DIR]
  daemon ping [--run-dir DIR] [--pipe PIPE]
  daemon status <runId> [--run-dir DIR] [--pipe PIPE]   # 按 runId 查单个 run；守护进程自身健康用 ping/list
  daemon list [--run-dir DIR] [--pipe PIPE]
  daemon supervise [--run-dir DIR] [--registry FILE] [--idle-exit-ms MS]
  daemon supervisor status|stop [--run-dir DIR]
  daemon health [--run-dir DIR]

MCP host registration (the MCP tool surface is host-neutral; hosts: claude-code, codex, zcode, kimi-code, opencode, claude-desktop, dsh):
  mcp status [--host <host>] [--cwd <git-root>]   # read-only: is WAO's MCP registered on this harness? no --host = every known host
  mcp bind --host <host> [--cwd <git-root>]   # codex: writes the project's .codex/config.toml (needs --cwd); every other host: prints the exact registration command/snippet (WAO never writes their config)
  mcp unbind --host codex --cwd <git-root>

Project state (.wao/) — wao-namespace subcommands; write them bare (wao doctor), namespaced (wao wao doctor), or npm form (npm run cli -- wao doctor):
  wao init [--cwd DIR] [--state-dir DIR]
  wao decision add --title T [--body B | --body-file F] [--context C]
  wao decision list [--format json]
  wao decision show <id>
  wao declare --task T --reason <code> [--note N]  # Lead 自做声明（reason 为闭集码）；裸 wao declare 列出现有声明
  wao stage <n> --task T [--artifacts a,b] [--note N] [--panel-seats id[,id] [--reviewed-run <runId>[,<runId>]] | --panel-skip-reason <code>]  # 阶段声明（n: 1=spec 2=plan 3=派发 4=验收 5=汇总 6=总结；panel 字段只在 2/4 登记）；裸 wao stage 列出进度与缺口
  wao ask <agentId> "<一句话任务>" [--mode write] [--cwd DIR]  # 快捷派工（默认只读并注入边界声明；--mode write 不注入）
  wao handoff write --from R --to R --summary S [--artifacts a,b]
  wao handoff read <role> [--format json]   # 最新一份写给该角色的 handoff
  wao doctor [--cwd DIR] [--format json] [--warn-as-error]   # 环境体检（车道/凭据/工具链）
  wao onboarding [--agent <id>] [--apply] [--endorse-worker <id>] [--host <id>] [--json]  # 从入库模板生成最小私有 registry；--host 给该宿主的注册指引；不带 --agent = 预览出口
  wao accept --run <runId> --decision <accepted|rejected> --reason <text> [--evidence-digest <sha256hex>] [--evidence-summary <text>] [--run-dir DIR]  # 验收落盘（只对终态 run）；--show 只读列出既有记录
  wao sweep-claude-config [--apply]  # 清扫 claude-code OAuth 临时配置目录（默认 dry-run，--apply 才删）
  wao lanes [--json] [--run-dir DIR] | [--registry FILE --lanes-file FILE]  # 车道一屏参考（只读）：接线轴+画像+认证简表+就绪探测

Notes:
  - 完整用法与场景说明见 docs/usage.md 与 docs/usage/ 各专页。
  - run 的逐 flag 说明：run --help（--help 必须紧跟 run 之后）。
  - runId 内嵌时间戳为 UTC；本地时间需自行换算。
`;

// A-1（friction 2026-08-15 #1）：run <agentId> 的 agentId 位置误填顶层命令名时
// （如 `run status ...`）做 did-you-mean 提示。恰 20 名；与 HELP_TEXT 的关系是
// 双向守卫（HELP_TEXT 每个两空格命令行首词必须在闭集内，闭集每个成员在
// HELP_TEXT 有行锚定条目）；不含 help（HELP_TEXT 无 help 命令行）。
export const COMMAND_NAMES = Object.freeze([
  "version", "consult", "registry", "spawn", "retry", "resume", "run", "status", "tail", "collect",
  "stop", "runs", "dashboard", "worktree", "wao", "daemon", "mcp", "playbook", "serve",
  "feedback",
]);

// A-2（friction 2026-08-15 #2）：`run --help` 用法页。顶层 HELP_TEXT 字节冻结
// （docsSurface 生成层把 docs/surface/cli.md 与 generate() 输出做字节对比），
// run 的详细用法放在这里由 `run --help` 打印（--help 必须是 run 之后的第一个参数）。
export const RUN_USAGE_TEXT = `run <agentId>|--lane <lane> --role <role> --prompt "..." [options]

Run one agent to completion and print a summary (default text format).

Flags:
  --prompt TEXT                  the task prompt (required unless --prompt-file is given)
  --prompt-file FILE             read the task prompt from FILE (multi-line safe)
  --lane LANE --role ROLE        dispatch by lane and role instead of an agent id (always together)
  --explain                      print what the agent id or lane/role resolves to, then exit without dispatching
  --cwd DIR                      target project directory (required for --background delivery runs) — must be an existing directory; a missing or non-directory path is refused at dispatch/start before any side effect
  --registry FILE                agent registry file (default config/agents.json)
  --run-dir DIR                  transcript directory (default runs/)
  --poll-interval MS             status poll interval in ms
  --wait-timeout MS              bounded observation deadline in ms (1000-600000); on expiry WAO records
                                 run.observation_deadline_reached and keeps waiting for the natural terminal —
                                 it NEVER stops the worker. Bounded observation window:
                                 runs wait <runId>; dispatcher-independent survival: --background
  --format json|text             output format (default text)
  --isolate                      run in an isolated worktree
  --no-isolate                   run in the target directory even when the config isolates by default
  --require-certified            dispatch only certified workers
  --background                   fork a detached runner and return immediately
  --scorecard-rules-file FILE    load scorecard rules from FILE (JSON)
  --scorecard-rules JSON         inline scorecard rules (JSON string)
  --scorecard-mode warn|hard|off default evidence check when no rules are given: warn (default) records, hard fails a run without evidence, off skips it
  --tag key=value                tag the run
  --delivery-spec-file FILE      delivery mode spec (requires --isolate; a --background delivery run also requires --cwd)
  --read-only                    declare a read-only run (advisory observation; forces --isolate; mutually exclusive with --delivery-spec-file and --no-isolate)
  --model ID                     per-dispatch model override (one dispatch only, never written to the registry; replaces only the registry model's id — contextWindow/providerID/variant are preserved)
  --reasoning EFFORT             per-dispatch reasoning effort override (one dispatch only, never written to the registry; replaces only the registry reasoning's effort — minimal/low/medium/high/xhigh/max; composable with --model)

Notes:
  - The file given to --delivery-spec-file must contain the INNER delivery object
    itself ({"mode":"git_commit_v1",...}), WITHOUT an outer {"delivery": ...} wrapper.
  - A --background delivery run additionally requires an explicit --cwd: the
    delivery ownership record (run.background_submitted.cwd) is built from it,
    and the dispatch is refused before any side effect when it is missing.
  - --read-only declares advisory observation, never a gate: WAO observes
    tool-reported file writes (run_activity readOnlyObservation) but never
    auto-stops or fails the run on observed writes; final judgment is the Lead's.
  - --model VALUE must be a non-empty string of at most 128 characters, not
    starting with "--", with no whitespace or control characters (the
    background runner's flag parser would split a "--"-prefixed value). It is
    mutually exclusive with --require-certified (the certification matrix is
    recorded per provider+model, so any override voids the certified
    combination) and with provider-session reuse agents (a resumed
    conversation must run one model). A mistyped model id is only reported by
    the provider when the worker starts — the echoed "effective model" in the
    dispatch output is advisory: it shows what WAO threaded, not that the
    provider accepts the id. --model exists only on run and retry (not
    spawn/daemon); a persistent model change belongs in the registry
    model policy.
  - --reasoning VALUE must be one of the closed effort set
    minimal/low/medium/high/xhigh/max; anything else is refused with a fixed
    text (never echoing the value). It may be combined with --model (the
    per-dispatch "model + effort" pairing). It is mutually exclusive with
    --require-certified (any override voids the certified-combination claim)
    and with provider-session reuse agents (a resumed conversation must run
    one reasoning effort); when combined with --model against a reuse agent,
    the refusal names the override actually at fault. A backend that cannot
    express the effort (opencode-serve) or only a conditional subset
    (kimi-code K3-only, deepseek-harness high|max) refuses the dispatch
    through its existing policy gate with a hint naming --reasoning. The
    echoed "effective reasoning" is advisory in the same sense as the model
    echo. --reasoning exists only on run and retry (not
    spawn/daemon); a persistent reasoning change belongs in the
    registry reasoning policy.
  - --help must be the FIRST argument after run: npm run cli -- run --help
`;
