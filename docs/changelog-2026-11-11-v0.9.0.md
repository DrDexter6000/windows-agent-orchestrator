# Changelog 2026-11-11 — v0.9.0 发版快照（v0.8.2 → v0.9.0）

> ⏳ **本文件是过程类别（Process Log）的时间冻结快照，不是现行契约源。**（分类标准：`docs/ssot.md` §1.4）
> 冻结日期：2026-11-11。发版依据与版本策略：`.wao/decisions/0038-semver-adoption-and-release-baseline.md`，0.x 的版本号映射与快照条款由 `.wao/decisions/0109-0x-version-bump-by-upgrade-action.md` 部分取代；发版动作：`docs/milestone-discipline.md` §9。
> 范围：tag `v0.8.2` → tag `v0.9.0`：第 87–103 批，决定 0119–0123。里程碑进度唯一权威：`docs/roadmap.md`；本文件只记发版时点的范围汇总与证据指针，不复制契约正文。发版门槛证据在打标前写入下文。

## 主题分组（按用户可感知的能力）

### 后台 worker 不再随 MCP 服务一起死

- 后台 runner 经 WMI 创建的启动桥起：宿主因请求超时重启 WAO MCP 服务时，在跑的 worker 不再被连带杀掉（决定 0120，TD-347 关）。`WAO_RUNNER_LAUNCH=spawn` 换回旧的启动方式。
- 重新打包的验证持有 owner 心跳租约；MCP 的 repackage 与 reverify 有界等待默认 45 秒，落在宿主的请求时限之内（决定 0119，TD-337、TD-345 关）。
- 重新打包后验证一直没有结果的交付：先以相同输入重试 repackage，树已不在时可以有界拒收；带有效重新打包来历的 failed 运行同样适用（第 87、88 批）。

### 读得出 runner 已经不在

- runner 的 stderr 落盘；转录静默满 15 分钟且能证明 runner 已不在时，`status` 与 `run_status` 换成 runner 已不在的说法（TD-341 关）。
- `consult wait --until-settled` 在 runner 已不在时也以退出码 3 `runner_gone` 退出；`runs settle` 拒绝位置参数，`--apply` 不再吞掉下一个词（TD-342 关）；`runs prune` 连同 runner 的 stderr 文件一起处理。
- `run_stop` 对既无 pid 也无 serveUrl 的会话不再报错，记 `stop_unverified`；`runs settle` 的 runner 扫描只认 node 进程，静默窗不计被拒的审计事件（第 92 批）。

### 少一些误判

- zcode 停滞门另读挂在 app-server 上的 Windows 作业对象：经 npm、npx 这类 env 式脚本起的子进程不再脱离观测、被误判停滞（决定 0121，TD-346 关；仅 Windows 的过渡方案）。
- 隔离门对解析不出物理路径的写一律重试，事件带相对路径与原始错误码，两层脱敏（TD-336 关）。
- 会审里没派发出去的席位，失败原因写进组记录与文本输出（第 96 批）。

### 保持唤醒期间代启用户屏保

- WAO 持有"显示器保持开启"期间，键鼠空闲达到用户自己的屏保超时就启动用户的屏保，不再让屏幕一直亮着（决定 0122）。

### 车道

- 新增 fable 车道：Claude Fable 5.2，经 claude-code、effort high，只用于方案设计与头脑风暴会审；要 Claude Code CLI 2.1.321 或更新；按官方说明可能计入用量额度而非套餐内额度（第 98、99 批）。
- harness 巡检（2026-11-10）：codex 0.167.0、kimi 2.5.2；dsh 暂不升级（TD-351）。
- kimi-code 与 deepseek-harness 两个 worker 后端退役，`KNOWN_BACKENDS` 7→5；取回用 tag `archive/kimi-code-backend`、`archive/deepseek-harness-backend`；kimi 作为 MCP 宿主照旧（决定 0123，TD-117 关）。

### 正确性与测试

- `src/cli.js` 与 `src/daemon.js` 只在作为入口运行时执行 main，被 import 时不再跑（第 89、102 批）。
- 全量测试：波级看门狗 3000 秒、慢波告警 1800 秒；跑全量 `npm test` 的交付验证声明 `verificationTimeoutMs ≥ 3600000`（第 103 批，TD-138）。

## 升级须知

- **要动手**：私有注册表里还有 `backend` 为 `kimi-code` 或 `deepseek-harness` 的条目时，删掉它们。这两个后端已退役，这样的条目会让 `registry list` 与对它的派发报 `unknown backend`（`registry validate` 逐条列出）。
- 交付验证跑全量 `npm test` 的，把 `verificationTimeoutMs` 提到 3600000 或以上。
- MCP 宿主要重启才会加载新的服务端代码；重启前由旧服务派出的 runner 仍按旧方式启动。
- 要用 fable 车道：先把 Claude Code CLI 升到 2.1.321 或更新，再按车道表对齐注册表（`wao registry align`，决定 0108）。

## 本次发版自带的变化

- package.json `version` 0.8.2 → 0.9.0（MINOR：两个后端退役，引用它们的注册表条目要用户删除，决定 0109）。

## SSOT 核查（§9 第 0 步）

- 机械部分（main e5f9415e 上）：`npm run map` 的"完全不可达""只经弱边可达"两栏为空；"只经中边可达"20 个与 v0.8.2 时相同（14 个按目录或文件名加载的资产、6 个经 docs-consistency 目录边可达的 `docs/archive/m0–m5-audit.md`），都不是孤儿。横切守卫组 8 个文件全过。
- 人工判断：会审 consult_20261111072257038dg3ymr，按批次分两席只读核对本周期改动过的事实（deepseek-flash：第 87–95 批与决定 0119–0121；opus：第 96–103 批与决定 0122–0123），两席都判 FIX_FIRST。
- 修复（本版发版提交）：
  - `docs/ssot.md` 的 owner-decide 行删掉两项已无出处的待决事项（DSH 旧 harness 线去留、worker 切到 DSH 后是否跑完整 reliability）；
  - troubleshooting 一处节号指针改回 §7.13（第 101 批重编号时误改）；
  - 架构契约写明决定 0121 的只观测作业与决定 0122 的代启屏保，删掉已退役线的字段对比；
  - 代码注释去掉后端闭集的序号、扩员计数与批准记录，已退役的 kimi-code 不再当作在用的进程式后端；
  - fable 的 CLI 版本要求从注册表模板注释删掉（家在车道画像与 onboarding）；TD-138 不再复写看门狗数值。
- 判为不改：消费 `dispatchError` 的组记录说明留在 MCP 回执字段表（唯一出处）；SKILL 的 3600000 句与守卫按现状保留；`docs/testing.md` 的全量耗时区间仍覆盖本次实测。

## reliability 豁免（Owner 具名，只对 v0.9.0）

- deepseek-pro（delta）：Lead 问"v0.9.0 发版要过可靠性门（真实 token）。deepseek-pro 车道仍挂着你的暂停说明（"调试中，暂勿派发"），按规矩豁免只对一个版本有效，每次发版都要你重新点名。这一版的 deepseek-pro 这一行怎么处理？"，Owner 选"继续豁免"。理由：该车道带 Owner 的暂停派发说明，不派发也不探测。
- 状态是"豁免"，不是"通过"；不常驻，不沿用到下一版。

## 发版门槛证据（2026-11-11，本地实跑；打标后追加）

- 全量 `npm test`：**374/374 通过**（6 波，854 秒，其中 filesystem 波 498 秒；无隔离重跑，runs 守卫干净），跑在 8730c3f5 上，即 tag `v0.9.0` 指向的提交。插电。这是 00:31Z 更新重启后的第一套全量；前一天同一批代码的 filesystem 波是 701–1335 秒，差别在机器开了 13 天没重启（TD-138）。
- surface 再生成（§9 第 3 步）：在同一候选上重跑 `npm run gen:surface`，生成物与入库文件逐字节一致。
- `npm run reliability`：从主检出在 8730c3f5 上逐车道跑（`--agent <lane>`），八条车道共约 10 分钟（08:06–08:16Z）：
  - sol、astra：certified（full，含越界写被 OS 沙箱拒绝的检查）。
  - kimi、deepseek-flash、opus、fable、glm-flash、glm-pro：全过，评 conditional（delta 子集全过不产生 certified）。
  - deepseek-pro：按上文豁免，未跑。
- `npm run smoke`（主检出 8730c3f5，08:16Z）：claude-code PASS，codex PASS（回复 `smoke ok`）。smoke 不覆盖的后端，以上面各车道的 reliability 为真实运行时证据（`docs/milestone-discipline.md` §6.1）。
- 1.0.0 额外门槛（§9 第 7 步）：不适用，本版仍是 0.x；TD-194 未关。
- 复现命令：`npm test`；`npm run reliability -- --agent <lane>`；`npm run smoke`；`npm run gen:surface`；`git diff --shortstat v0.8.2 v0.9.0`；`git rev-list --count v0.8.2..v0.9.0`。

## 总量

64 个提交（含 v0.8.2 打标后的 smoke 补跑记录与本次的发版提交），207 个文件，+11,817 / −3,851 行（`git diff --shortstat v0.8.2 v0.9.0`）。

## 发版记录

- tag：`v0.9.0`（annotated → 8730c3f5，正文载门槛证据与 Owner 的豁免原话）；推送顺序：先 main，后 tag。
- main 以快进合入候选，没有压缩。
