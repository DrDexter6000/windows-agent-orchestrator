# 0074 车道不靠人工步骤就能用：deepseek 权限模式按车道声明；kimi 车道可指向私有主目录的 serve；并发实测入车道画像；两个旧后端暂停使用

- 日期：2026-10-13
- 状态：accepted（Owner 2026-10-13 指令，原话见"来源"；具体做法由 Lead 在既有授权下确定）
- 来源：Owner 2026-10-13 对决定 0073 收尾报告的回复（原话）——"1、deepseek harness这样让我手工处理的方式不妥，因为不可能每个项目都要求人类用户去手工跑一次这个命令；2、kimi那个应该是有并发限制 —— 我突然想起来wao的workflow体系中没有提及并发建议和规则的地方？我觉得可以让lead agent得知大部分api都支持至少2~4并发。你怎么看待这个问题？3、claude code已重启；4、我又想起来，我发现每次调用kimi之后好像就会启动一个kimi-cu.exe进程，现在我看windows资源管理器里面又积累了十几个kimi-cu.exe进程了，这一点也要解决；5、kimi-code和despseek-harness我记得因为功能不完整，我们暂时弃用了？除非经过harness巡检之后发现能力得到补足、而且有明显优于kimi-web和deepseek-acp后端的地方？"；以及同日对 0073 的授权："我授权和同意你基于会审意见、你作为lead agent的最终决断来做出必要的动作、以达到我们追求的目标目的"（目标 = 各车道能被 Lead 正常调用）。
- 关系：决定 0073（deepseek 沙箱权限问题的发现与提示）；决定 0056 / 0057 / 0058（kimi serve 进程荚泄漏、私有主目录试点——"正式车道迁移待 Owner 点名"）；TD-117（deepseek-harness 实验暂停）；决定 0036（kimi 车道切 kimi-web）。
- 会审：见文末"会审"。
- 合入授权：Owner 2026-10-12——"只要是你联合会审过的，我都许可 commit & push"。

## 背景与实测

### deepseek：harness 自带按进程生效的权限开关

`dsh --profile acp --dump-default-config` 显示：沙箱与审批策略由环境变量 `DSH_PERMISSION_MODE` 在 harness 启动时选定（`sandbox-policy.mode`、`approval.policy` 都读它；缺省 `workspace-write`，另有 `read-only` 与 `danger-full-access`）。ACP 会话只广告 `model` 与 `reasoning_effort` 两个配置项，运行中改不了权限模式。

WAO 的 deepseek-acp 后端本来就把 registry 里车道的 `env`（非秘密键）传给 harness 进程。实测（临时注册表副本，两条 deepseek 车道各加 `env.DSH_PERMISSION_MODE=danger-full-access`，工作目录为 D: 盘主检出）：命令 6–8 秒正常跑完，不再出现目录授权报错，也不再有申请完全权限的往返。

`workspace-write` 的沙箱在本机 D: / E: 盘项目目录上建不起来（决定 0073）；而 WAO 对 harness 的审批请求一律自动放行（ADR-0031 §3.5），所以这层沙箱在 WAO 之下从来不是硬边界。ADR-0031 没有把它列为 containment 的组成部分——缺省值是随 profile 带进来的，不是当时的设计选择。

### kimi：助手进程是 Owner 主目录里的插件拉起的，私有主目录没有

kimi 2.1.1 的 serve 每开一个会话拉起一组助手进程且从不回收（决定 0056，上游缺陷）。实测现状：车道所用的 58628 实例（共用 Owner 的 `~/.kimi-code`）名下 197 个进程、14 组——每组是 `installed.json` 里的插件（kimi-datasource、kimi-cu-win 等）和 `mcp.json` 的三个 MCP（analyzer、officecli、wao）。

私有主目录 `D:\projects\.kimi-worker-kimihome`（决定 0058 试点时建立并登录）没有插件、没有 `mcp.json`。在它上面起一个 serve，连跑 3 个带命令的真实任务后**后代进程数为 0**；之后又跑了二十多个任务仍为 0。任务用时也更短（10–15 秒，共用目录约 23 秒）。

决定 0058 当时留下的缺口是 token：每个主目录有自己的 `server.token`，而车道从用户环境变量取 token。

### 并发：八条车道同车道 3–6 并发全部完成

逐条车道、同一时刻派 N 个相同的最小任务（跑一条命令、回一句话）：

| 车道 | 并发数 | 结果 |
|---|---|---|
| glm-pro、glm-flash、deepseek-pro、deepseek-flash、sol | 4 | 全部完成 |
| kimi | 6（共用目录的 serve）；4、6（私有目录的 serve） | 全部完成 |
| astra、opus | 3 | 全部完成 |

决定 0073 里 kimi 那次"Request timed out"发生时在跑的 kimi 任务只有一个（同时派的是 8 条不同车道），所以它不是 kimi 的并发上限；原因没有查明，当时那个 serve 名下已有上百个助手进程。

顺带观察到：kimi 在并发时偶尔把最终答案发成两段内容相同的文本帧（帧 id 不同），WAO 按帧拼接后答案重复一遍。共用目录 6 次里 1 次，私有目录更常见。这是上游行为，本批没有处理。

### 两个旧后端

- deepseek-harness（同一 harness 的旧 JSON-RPC 接线）：TD-117 于 2026-08-15 记为"实验暂停"；ADR-0031 起由 deepseek-acp 接替。
- kimi-code（`kimi -p` 进程线）：没有明确的暂停记录；kimi 车道自 2026-10-01（决定 0036）起走 kimi-web。能力对照：kimi-code 不支持在途纠偏、不上报 token 用量，会话复用 2026-09-21 起支持。

本机注册表里没有车道使用这两个后端。

## 决定

1. **deepseek-acp 的权限模式按车道声明。** 车道在 registry 的 `env` 里写 `DSH_PERMISSION_MODE`；WAO 校验取值只能是 harness 的三个预设名（拼错即拒），原样传给 harness 进程。WAO 不替车道选模式，产品缺省不变（不写就是 harness 缺省）。沙箱建不起来时的 system 提示改为先给这条车道级修法。示例注册表的两条 deepseek 车道带上 `danger-full-access` 并注明含义。
2. **kimi-web 车道可声明 `kimiHome`**（worker serve 的私有 `KIMI_CODE_HOME`，绝对路径）。声明后：bearer token 取自 `<kimiHome>/server.token`，不读环境变量（不做回落——别的主目录的 token 在这个 serve 上只会换来鉴权失败）；这条车道不再有环境凭据；`serve status | sweep | recycle` 以它为缺省主目录并用同一个 token 文件鉴权。`tokenEnv` 仍是必填字段，声明了 `kimiHome` 时不读取。
3. **同车道并发的实测值进车道画像**（`config/lane-traits.json` 的可选 `concurrencyNote`，`wao lanes` 显示）；一般性建议写进 `docs/team-roles.md` 的 Lead 派工策略：同车道 2–4 并发通常可行，出现超时或限流按事实降并发重派。WAO 不设并发上限、不代为排队。
4. **kimi-code 与 deepseek-harness 暂停使用**（Owner 2026-10-13）：不为它们配置车道；重新启用的条件是 harness 版本巡检确认能力补足，且明显优于 kimi-web / deepseek-acp。代码与测试保留。

## 本机配置（不在仓库里）

随本决定在 `config/agents.json` 上执行，结果见文末"迁移记录"：

- deepseek-pro、deepseek-flash：`env.DSH_PERMISSION_MODE = "danger-full-access"`。
- kimi：`kimiHome = D:\projects\.kimi-worker-kimihome`；58628 上的旧实例（Owner 主目录）优雅关闭，同端口在私有主目录下重启。

## 行为变化与如实边界

- **deepseek 车道在 `danger-full-access` 下，命令不进 harness 的沙箱，也不再向 WAO 请求审批**（转录里不再有"permission answered"记录）。与 glm、kimi、opus 车道现有的无人值守模式一致；WAO 自己的隔离（工作树、交付范围审计）不变。想保留沙箱的车道不写这个键，并按决定 0073 的说明修目录权限。
- **`DSH_PERMISSION_MODE` 是 harness 的环境开关，不是协议字段**：harness 换了开关名，这个设置会静默失效（表现为沙箱报错重新出现，0073 的提示会指出来）。本批验证的是 dsh 0.1.5 系的 acp profile。
- **声明了 `kimiHome` 的 kimi 车道在 `registry_list` 里显示"不需要凭据"**（与 zcode、codex 车道同形：登录态在本机，不在环境里）。token 文件缺失时派发在后端被拒，错误点名文件路径。
- **token 文件的值每个 agent 对象读一次**；serve 换了 token（`kimi web rotate-token`）之后，正在跑的运行不会跟着换。
- **私有主目录里没有 Owner 的插件、技能配置和 MCP**——worker 看到的工具集比共用目录少（没有 analyzer / officecli 这两个 MCP）。`~/.agents` 下的通用技能仍然可见（决定 0058 已记录）。
- **旧 serve 关闭后，用户环境里的 `KIMI_WEB_TOKEN` 不再被 kimi 车道使用**（它仍是 Owner 主目录 serve 的有效 token，轮换与否由 Owner 决定）。
- **serve 仍需有人拉起**：机器重启后私有主目录的 serve 不会自己起来（与此前的 58628 相同）；`serve recycle` 在实例记录缺失时拒绝，须按手动配方启动。本批没有做自动启动。
- **并发数是本机一次取样**（最小任务、每条车道一次），不是服务方承诺的限额；长任务、大上下文下的表现没有测。
- **kimi 并发时答案偶发重复**：上游行为，未处理。
- **没有验证的**：`read-only` 模式下 deepseek 车道的行为；kimi-code、deepseek-harness（暂停使用）；`kimi web rotate-token` 之后的行为。

## 验证

| 项 | 结果 |
|---|---|
| deepseek-acp：三个预设名通过、其它取值被拒；声明的模式进 harness 子进程环境；沙箱失败提示先给车道级修法（`deepSeekAcp.test.js` ACP 0074；ACP 0073 的断言随提示文案更新） | 通过 |
| kimi-web：`kimiHome` 在场时每个请求用主目录文件里的 token、环境变量不读；文件缺失即拒且不发请求；策略面不再列环境凭据；形状校验（`kimiWeb.test.js` 0074） | 通过 |
| serve 维护族：车道主目录作为缺省主目录、token 文件鉴权；未声明的车道照旧读环境变量（`serveMaintenance.test.js` serve 0074） | 通过 |
| 车道画像：`concurrencyNote` 可选、须写明实测日期；`wao lanes` 显示（`laneTraits.test.js`） | 通过 |
| 后端名普查登记表（`envPolicy.js` 的 kimi-web 计数 1 → 2） | 通过 |
| 真机 deepseek-flash、deepseek-pro（临时注册表副本加 `DSH_PERMISSION_MODE`，主检出目录，`run_20261013135809268urkz3o` / `run_20261013135818732vqubdd`）：命令直接跑成 | 通过 |
| 真机 kimi（分支代码，车道声明 `kimiHome`、进程环境里没有 token 变量，`run_20261013141931781xjvqu7`）：运行完成、上游会话自动删除；`serve status` 读到私有主目录的实例，后代进程 0 | 通过 |
| 并发实测：见"背景"表（30 个运行全部完成） | 通过 |
| 全量 `npm test` | 见提交说明 |

## 会审

见提交说明（会审在本文件成稿之后进行）。

## 迁移记录

见提交说明（迁移在合入之后执行）。
