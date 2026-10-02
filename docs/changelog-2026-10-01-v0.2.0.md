# Changelog 2026-10-01 — v0.2.0 发版快照（v0.1.0 → v0.2.0）

> ⏳ **本文件是过程类别（Process Log）的时间冻结快照，不是现行契约源。**（分类标准：`docs/ssot.md` §1.4）
> 冻结日期：2026-10-01。发版依据与版本策略：`.wao/decisions/0038-semver-adoption-and-release-baseline.md`。
> 范围：tag `v0.1.0`（522b801，2026-08-16）→ tag `v0.2.0`。里程碑进度唯一权威：`docs/roadmap.md`；本文件只记发版时点的范围汇总与证据指针，不复制契约正文。

## 总量

281 个提交，261 个文件，+66,419 / −2,764 行（`git diff v0.1.0..v0.2.0 --stat`）。

## 主题分组（按用户可感知的能力）

### 原厂 harness 全席覆盖（本次发版的主线）

- **zcode backend**（`src/backends/zcode.js`）：ZCode app-server 协议（stdio、双向请求），支撑 GLM-5.3 / GLM-5.3-Flash 三席（researcher / coder_hq / coder_low）。派发、会话内纠偏（steer）、usage 计量、工具帧证据投影（写文件/执行命令进 transcript）全链路可用。
- **kimi-web backend**（`src/backends/kimiWeb.js`）：kimi web 本地 serve 的 transcript 原语接线——turn 终态集合 + triggerPromptId 归属判定完成态（取代五轮轮询启发式），`prompts:steer` 在途纠偏。支撑 coder_mm（kimi-code/k3）。
- **deepseek-acp backend**：ACP over stdio 接入 dsh 驱动 DeepSeek（决定 0031），跨进程 session/resume。
- 至此 8 个 worker 席位全部运行在原厂第一方 harness 上；backend 注册面扩至 8 个（`src/registry.js` KNOWN_BACKENDS）。

### 能力矩阵与认证体系成型

- 六轴能力矩阵冻结（supportsRoleContract / supportsSessionReuse / supportsInFlightCorrection / replayByRespawn / reportsTokenUsage / reportsCommandExitCode），生成面 `docs/surface/certification.md`（`npm run gen:certification`，TD-162）。
- 两层验证与认证（决定 0032）：组件层 conformant + 组合层 certified / conditional；delta 认证规程入 `docs/certification-runbook.md`。
- 上游原语复核 SOP（TD-184 九十天复核环 + 事件触发）写入 `docs/certification-runbook.md`。
- adversarialEscape 对抗演练框架落地；契约顺从模型"无靶"形态经 Owner 例外认定投用（决定 0036/0037，TD-196 承载关闭触发）。

### 过程事故与经验固化

- kimi-web 八轮接线战全过程复盘冻结：`docs/incidents/2026-09-30-kimi-web-wiring.md`（八条教训 + 六问复核清单 + B′ 判据全文）。
- 卫生守卫首批落地（决定 0035，ADR 0035 W1–W5；`npm run hygiene`）。
- 安静窗口全量验证方法论成立：T3 首轮 247/247 全绿证据（`.wao/runs/shared-cost/t3-quiet-attempt-20260929/`，gitignored）；白天翻绿族登记 TD-194。

### 本次发版自带的变化

- `wao version` / `wao --version` 版本出口（`src/version.js`，package.json 单一来源，与 MCP serverInfo 同源；guard 豁免同 help）。
- package.json `version` 0.1.0 → 0.2.0；`docs/surface/cli.md` 随 HELP_TEXT 再生成。

## 发版门槛证据（2026-10-01 白天，本地实跑）

- 全量 `npm test`：**251/251 通过**，6 波全 exit 0，total 345629ms（≈5.8 分钟），runsGuard clean，白天首过。首轮 250/251 的唯一失败是本发布新增 `src/version.js` 未登记 layering 五桶（stable_fail，发布内修复：shared 桶 + `docs/02-architecture.md` L4 同步）后复跑全绿。
- `npm run reliability`（真实 token）：exit 1——失败集合全部可归属且在案：
  - tester / auditor（codex）：**certified strict-dispatch**，全部必需检查通过（含 command exit-code 证据）。
  - coder_mm / coder_hq / coder_low：delta drill 实跑 core+scorecard 全过（双哨兵、metrics 非零 input=23311/27520/26960、文件实体+`file_written` 证据、worktree 隔离正常）；adversarialEscape 无靶形状机械红（模型拒执行越界写）——runbook 明文"拒绝同样红，需人工分辨"，人工分辨已由决定 0036/0037 完成，台账按裁定 `conditional`（scope=delta）。首轮 coder_mm 因 Lead shell 未继承 `KIMI_WEB_TOKEN` 派发失败误记 rejected，带 token 单席重跑实跑通过后已纠正（台账裁决写回脚本：gitignored `scripts/reliability-tmp/adjudicate-0036-0037.mjs`）。
  - researcher（zcode 新 lane）：core+isolation+workflow 全过，`draft-only` 属实——该 lane delta 认证尚未走（后续事项，不阻塞发版）。
  - silentTimeout fallback lane：opencode-serve 本机未开，N/A（TD-43 单测覆盖面不变）。
- 复现命令：`npm test`；`npm run reliability`；`git diff v0.1.0..v0.2.0 --stat`；`npm run cli -- registry list`（认证投影）。

## 发版记录

- tag：`v0.2.0`（annotated）→ 推远端（沿用 v0.1.0 惯例）。

## 勘误（2026-10-02，auditor 咨询复核发现，只追加不回改）

"zcode backend"条目中"会话内纠偏（steer）"表述**错误**：zcode 协议未见证 steer 类在途注入原语，`supportsInFlightCorrection = false`（`src/backends/zcode.js:400`，翻转条件在册）。zcode 不具备在途纠偏能力——该能力属 kimi-web（`prompts:steer`）。同条目中"派发、usage 计量、工具帧证据投影"等其余声称不受影响（发版门槛实跑复核在案）。
