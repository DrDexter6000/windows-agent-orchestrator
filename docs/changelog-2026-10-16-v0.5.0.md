# Changelog 2026-10-16 — v0.5.0 发版快照（v0.4.0 → v0.5.0）

> ⏳ **本文件是过程类别（Process Log）的时间冻结快照，不是现行契约源。**（分类标准：`docs/ssot.md` §1.4）
> 冻结日期：2026-10-16。发版依据与版本策略：`.wao/decisions/0038-semver-adoption-and-release-baseline.md`；发版动作：`docs/milestone-discipline.md` §9。
> 范围：tag `v0.4.0` → tag `v0.5.0`，决定 0061–0083。里程碑进度唯一权威：`docs/roadmap.md`；本文件只记发版时点的范围汇总与证据指针，不复制契约正文。发版门槛证据在打标后追加于文末（§9 第 6 步）。

## 主题分组（按用户可感知的能力）

### Lead 看得见、Lead 来定（0067–0072）

- 控制面只收口没有生命体征的 run；有生命体征时只给建议，去留由 Lead 决定（0067）。生命体征口径适用于所有车道，建议上 MCP（0068）。
- Lead 中止前先探明并说明理由，`run_activity` 给出命令原文（0069）；Lead 看得到工具调用在对什么动手、最近输出了什么，进程式后端在静默期落生命体征（0070）。
- kimi 与 deepseek 车道的命令在途可见，kimi 写文件在途预告；评分的退出码推断按后端声明门控（0071、0072）。

### 车道不靠人工步骤就能用（0064、0065、0073–0075、0079–0081）

- 退出码证据轴不适用的车道认证为 conditional，两处退出码声明翻为"否"（0073）；deepseek 权限模式按车道声明，kimi 车道可指向私有主目录的 serve，并发实测记入车道（0074）。
- kimi worker serve 在派发时按需拉起（0075），空闲时退出（0079）。
- 车道的暂停派发说明（0080）与当前型号（0081）各只写在车道配置一处，各读取面现算；`wao lanes` 是只读的车道参考面（0064）；对抗性派生取代 seatRole 人工声明（0065）。

### 宿主项目接入（0061、0066、0083）

- `wao mcp status` 只读探测 WAO 的 MCP 是否已在六种宿主上注册，表外宿主给通用片段（0066）；onboarding 凭据探测补上 key_only 两态（0061）。
- 会改工作区的 MCP 工具只从调用本身取目标项目（`expectedWorkspaceRoot`），共用一个 server 的会话不再派发进彼此的项目。
- 宿主项目的 Lead 用 `wao feedback` 把 WAO 缺陷报进本机收件箱，WAO 开发 Lead 开工时读（0083）。

### 清理与收尾（0062、0063、0082）

- `wao worktree reclaim`：陈旧 worktree 与 `wao/*` 分支按 Owner 批准的计划清退，分支先进已校验的 bundle；嵌在关联工作树里的运行树也在范围内，删除前重证范围（0082）。
- `wao runs settle` 结算 runner 已死的非终态 run；`wao stop` 不再误杀复用了 pid 的进程。
- serve recycle 复活死实例，resume 恢复 ephemeral（0063）；发版检查单（0062）。

### 诊断与正确性

- codex 的失败原因进 `run.error`，额度耗尽诊断为 provider_capacity 而不是 crash。
- 交付 containment 门遇到瞬时文件系统错误先重试再判失败，并记下错误码。
- 转录事件类型集中在代码里的一张登记表，事件清单由它生成；测试里写出未登记的类型即红。
- zcode 在上游重试等待期间保活并说明收口原因；kimi-web 的静默收口逐门分类；deepseek-acp 按 toolCallId 对应工具结果；后台派发与前台同样遵守 `--isolate` / `--no-isolate` / `--tag`。

### 文档与工程纪律（0076–0078）

- 一项事实一个归宿，台账与决定索引守形状（0076）；全量测试每批只在最终候选上跑一次，只改文档或测试的交付用定向验证（0077）；MCP 工具面的上下文预算与红线（0078）。
- 使用手册拆成按任务一页；参考文档只写现状。

### 本次发版自带的变化

- package.json `version` 0.4.0 → 0.5.0。本周期新增了命令（`wao lanes`、`wao runs settle`、`wao worktree reclaim`、`wao feedback`）与 MCP 参数，按 0038 第 1 条升 MINOR。README 双语徽章与 What's new 指向本快照。
- 台账瘦身：开放行逐行到代码核实，了结 TD-144、TD-172、TD-223；TD-97 改设计性约束；TD-171 改等待裁定；开放行的"何时处理"统一为 `下一批` / `等样本` / `择机`。

## reliability 豁免（Owner 具名，只对 v0.5.0）

- Owner 选定的答复（2026-10-16）："发 0.5.0，豁免 deepseek-pro 一行"。此前按 0.4.1 讨论时，Owner 的原话是"0.4.1 豁免 deepseek-pro 一行"；版本号改定后由 Owner 重新具名。
- 跳过的矩阵行：deepseek-pro（delta）。理由：该车道带 Owner 的暂停派发说明（"调试中，暂勿派发"；说明只提示、不拦截），Lead 按它不派发该车道，探测也不派。
- 状态是"豁免"，不是"通过"；不常驻，不沿用到下一版。本机注册表的矩阵共 9 行（入库模板只有 8 行），其余 8 行照跑。

## 发版门槛证据（2026-10-16，本地实跑；打标后追加）

- 全量 `npm test`：**340/340 通过**（6 波，626 秒，无隔离重跑，runs 守卫干净），跑在 tree 976b8bc5 上，即 tag `v0.5.0` 指向的提交 b329b47。
- surface 再生成（§9 第 3 步）：本周期 MCP surface 与 CLI help 的变动已随各特性提交再生成 `docs/surface/*`。2026-10-16 在 b329b47 的代码上重跑 `npm run gen:surface`，生成物与入库文件逐字节一致（`git status` 无改动）；`test/isolation-infra/docsSurface.test.js` 也把入库文件钉在生成器输出上。
- `npm run reliability`：从主检出在 b329b47 上逐车道跑（`--agent <lane>`），本机注册表矩阵 9 行：
  - sol、astra（strict）：全过，certified。
  - kimi、glm-pro、glm-flash ×2、opus、deepseek-flash（delta）：除越界写对抗演练外没有失败项（按决定 0073 不适用的检查记 N/A，不算通过也不算失败），评 conditional。越界演练是 TD-196 的无靶红：没有 workdir_escape 事实，工作树外也没出现越界文件。按下一节豁免。
  - deepseek-pro：按上一节豁免，未跑。
- 同日首轮 reliability 跑在 cb676a7 上，暴露了演练自身的缺陷：越界演练读不到分桶后的转录，6 个 delta 行一律报 "no run.started event"。修复在 b329b47（drills.mjs 改走 projectBuckets 解析链），上面的结果是修复后的重跑。
- 复现命令：`npm test`；`npm run reliability -- --agent <lane>`；`git diff --shortstat v0.4.0 v0.5.0`；`git rev-list --count v0.4.0..v0.5.0`。

## reliability 豁免（追加：越界写对抗演练，Owner 具名，只对 v0.5.0）

- Owner 选定的答复（2026-10-16）："豁免 6 个 delta 行的越界演练"。
- 范围：kimi、glm-pro、glm-flash ×2、opus、deepseek-flash 六个 delta 行的越界写对抗演练这一项；其余检查不得有失败项，重跑结果如此。
- 理由：TD-196。守约的模型拒绝往工作目录外写，演练无靶可拦；自 2026-10-01 起，每次 reliability 这一项都是红的。
- 条件（选定答复的一部分）：只在红的形态是 TD-196 无靶时适用；任何一行写到了外面而 WAO 没拦住，即属拦截缺陷，停发版并报告 Owner。重跑结果符合该条件。
- TD-196 改为下一批：把演练做成不依赖模型配合的形态，下一版不再豁免这一项。
- 状态是"豁免"，不是"通过"；不常驻，不沿用到下一版。

## 总量

62 个提交，332 个文件，+38,281 / −7,701 行（`git diff --shortstat v0.4.0 v0.5.0`）。

## 发版记录

- tag：`v0.5.0`（annotated → b329b47）；推送顺序：先 main，后 tag。
