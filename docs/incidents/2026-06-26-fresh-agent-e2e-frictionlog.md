# 2026-06-26 初次实装 Agent 的 E2E 摩擦日志

> 类别：过程日志（Process Log，时间冻结快照，只追加不回改）。
> 视角：把自己放在"第一次装上 WAO skill、要用它派发任务"的 agent 角度上，
> 把从技能安装→读说明→实机调用→编排→派发→轮询→汇总验收的**全流程**跑一遍，
> 记录流畅处 + friction。
> 复现脚本：见文末 §5。
> 后续：可执行的发现已抽出，建议按 §4 归口（其中代码侧 bug 建议挂 TD，本文不维护修复进度——按 SSOT 铁律，过程文档只追加不回改事实）。

---

## 0. 结论先行

WAO 的**派发→验收**主路径是顺滑的，且明显经过了真实事故打磨：preflight（`wao doctor`）+ `registry validate`/`list` 三连在动手前就给出"环境齐 + 谁可派发"的确定答案；哨兵任务一次跑通，hard scorecard 把证据链（命令真跑 + 文件真存在）卡在 `completed` 之前，transcript seq 单调、可重建。**这条路可以放心用。**

但有几处 friction 会让"第一次用的 agent"卡顿或踩坑，集中在两类：

- **文档与 CLI 不同步**（最严重，下文 F1/F2）—— `node src/cli.js help` 的命令列表与 `SKILL.md` 不一致，且 SKILL.md 责任链里点名的 `wao state/decision/handoff` 在 help 里完全缺席。
- **输出格式的不对称**（F3）—— `run --format json` 丢掉了 scorecard 字段，而默认 text 格式有，agent 程序化消费时会被误导。

下面逐条。

---

## 1. 流程走查（按我实际执行的顺序）

### 1.1 技能安装 / 读取使用说明 — ✅ 流畅
- `SKILL.md` frontmatter 清楚标了 `[LEAD-ONLY]` 和触发条件，角色边界（你现在是主控、worker 不该加载本技能）一开始就立住了。
- 责任链（理解→编排→派发→前置审计→验收→管状态→整合→汇报）是显式的 checklist，agent 知道每步该干嘛。
- 安全铁律前置且带"哪条事故来的"，可信度高。

### 1.2 实机调用工具（preflight） — ✅ 流畅，且这是亮点
- `wao doctor` 一次跑出：Node 版本、4 个 CLI 是否在 PATH、3 个 provider key、registry 是否可解析、opencode worker 是否配了 tokenBudget、`.wao/` 是否 init —— **这正是"第一次装"最想知道的全集**。返回 `HEALTHY`，零疑惑。
- `registry validate`（静态校验）+ `registry list`（含 certification 列）双命令清楚区分"配置对不对" vs "谁能真派发"。6 个 worker 全 valid，5 certified / 1 conditional，选型一目了然。
- 没有需要 `npm install` 的步骤（零依赖承诺成立）。

### 1.3 编排 / 派发 — ✅ 流畅
- 选 `coder_low`（certified + 低成本）做哨兵任务。多行 prompt 按 SKILL.md 避坑 #1 用 `--prompt-file`（PowerShell 会截断多行 `--prompt`，这条避坑被实测验证有用）。
- 带 `--cwd` 指到目标项目（避坑 #2），带 hard scorecard + rules（要求命令跑过 + 文件落地）。

### 1.4 轮询 / 读 transcript — ✅ 流畅
- `run`（同步等待）返回结构化结果：`completed/messages/evidence/metrics` 全有，agent 可直接程序化消费。
- `tail` 看到 seq 11→16 单调递增、事件链完整（state_change→message→metrics→scorecard.checked→completed→state_change）。transcript 确是 source of truth。
- 任务结束后 `tasklist` 确认无 worker 残留（进程式 backend，进程死即会话死，成立）。

### 1.5 汇总验收 — ✅ 基本流畅，但 F3 打了个绊
- `status`/`metrics`/`scorecard`/`diagnose`/`dashboard`/`forecast` 全部工作正常。
- 交付物 `wao-e2e-sentinel.txt` 磁盘内容 = `SENTINEL_OK 5168`，与 agent 自报、与 scorecard 证据、与 README 实际字符数**三方对账一致**。这就是 SKILL.md 反复强调的"别只信 worker 自报"的实际体现。
- `diagnose` 对成功 run 返回 `category: none`，不乱归类，符合"证据不足不强归类"的纪律。
- dashboard 把历史 5 个 run 一屏聚出，异常（failed）标 ⚠，summary 给 total/cost/flagged —— 省去四命令轮询。

---

## 2. 发现的 Friction（按严重度）

### F1【高】`help` 命令列表与 SKILL.md 严重不同步
`node src/cli.js help`（`src/cli.js:printHelp`）漏了一大票命令，而 SKILL.md / 代码里都有：

| 命令 | help 里有？ | 实际存在？ |
|------|:---:|:---|
| `runs dashboard` | ❌ | ✅ `cli.js:1369` |
| `runs diagnose` | ❌ | ✅ `cli.js:1284` |
| `runs forecast` | ❌ | ✅ `cli.js:1317` |
| `wao init / state / decision / handoff / doctor` | ❌ | ✅ `cli.js:1437` 整族 |
| `daemon supervise / supervisor / health` | ❌ | ✅ `cli.js:102/121/145` |
| `daemon run`（派发入口之一） | ❌ | ✅ `cli.js:195` |

**为什么严重**：很多 agent 的第一反应是 `help`，而不是读 37KB 的 SKILL.md。help 漏了 `runs dashboard/diagnose/forecast` 意味着 agent 会退回到更笨的多命令轮询（status+tail+collect+metrics 手动 join），白白多烧 token——而这些命令**正是为了省这个**而做的（M8-2/3/4）。`wao` 族完全缺席更狠：SKILL.md 责任链第 6 步"用 `wao state`/`wao decision`/`wao handoff` 管项目进度"点名要用的命令，agent 在 help 里根本找不到，只能靠全文翻 SKILL.md 撞上。

**这违反"thin control plane 的命令应当自描述"的直觉。**

### F2【高】SKILL.md 责任链点名 `wao state/decision/handoff`，但无快速入口
责任链第 6 步原文："**管状态（用 .wao/）** —— 用 `wao state`/`wao decision`/`wao handoff` 管项目进度和交接。" 但：
- `help` 没列（见 F1）。
- SKILL.md 的 Quick reference 也没把 `wao` 族放进"all commands"清单——它是散落在责任链散文里的。
- 第一次用的 agent 要么靠读散文撞见，要么直接 `wao decision add` 试错（subcommand 不对就 `Unknown wao subcommand`）。

属于"文档说了但没让 agent 容易够到"。

### F3【中】`run --format json` 丢失 scorecard 字段
- 默认 text 格式（`runCommand` 经 `renderRunSummary`）：会从 transcript 取 `scorecard.checked` 事件，**有 scorecard 卡片**。
- `--format json`：直接 `console.log(waitResult)`，而 `waitResult` 里**没有 scorecard**（只有 `loadScorecardFromTranscript` 在 text 分支才注入，见 `cli.js:748-749`）。

后果：agent 程序化消费 JSON 时，看不到验收是否过、哪些 check 挂了——只能再补一条 `runs scorecard <runId> --format json`。这是"同一个 run，两种格式信息量不对等"，容易让依赖 JSON 的 agent（也就是 WAO 的主要消费方）误以为没验收或验收过。

### F4【低】`registry list` 的 `model` 列对非 claude-code backend 显示 `-`
- `coder_mm`（kimi-code）/`tester`（codex）的 model 列是 `-`，因为 `extractFlag` 只认 `--model`/`--default-model`，kimi/codex 不走这两 flag。选型时这俩 worker 的模型信息不可见。不影响派发，但选型体验有盲点。

### F5【低】`runs dashboard` 列宽按 padEnd 固定，runId 超长会错位
`run_20260626201056960vh27g1`（23 字符）+ padEnd(18) 会让后续列整体右移。终端可读性下降。纯 cosmetic。

### F6【低】无"第一次该跑什么"的单条引导
`wao doctor` 是健康检查，不是"上手向导"。一个刚装好的 agent 看到 HEALTHY 后，仍要自己拼出"validate→list→挑 worker→写 prompt-file→run"。SKILL.md 有 Standard workflows，但没一条"最小可信闭环"的 copy-paste（比如就一句 `run coder_low --prompt-file ... --scorecard-mode hard`）。本文 §5 其实就是这个闭环，可考虑反向喂回 SKILL.md 的 onboarding。

---

## 3. 这次跑的数据（可复现、可对账）

| 项 | 值 |
|----|----|
| runId | `run_20260626201056960vh27g1` |
| agent | `coder_low`（claude-code / glm-5-turbo，certified） |
| 任务 | 读 README 字符数 + 写哨兵文件（要求命令跑过 + 文件落地） |
| 结果 | completed；README=5168 字符；哨兵文件内容 `SENTINEL_OK 5168`（三方对账✓） |
| 成本 | 20.0s，input=30146 / output=177，$0.1861 |
| scorecard | passed（hasDoneEvent ✔ / commandsPassed ✔ / filesExist ✔） |
| 残留进程 | 无（进程式 backend，任务结束即清） |
| 历史 forecast 参考 | coder_low 历史 16 样本，cost 中位 $0.0469 |

---

## 4. 归口建议（本文不维护修复进度，按 SSOT 铁律只记"当时发现"）

- **F1（help 同步）**：纯代码 bug，建议挂 TD（`printHelp` 漏列 dashboard/diagnose/forecast/wao 族/daemon supervise 等）。契约源是代码本身，不在本文维护。
- **F2（wao 族入口）**：文档侧，建议在 SKILL.md 的 Quick reference "all commands" 里补 `wao` 族一行，与责任链第 6 步呼应。
- **F3（json 丢 scorecard）**：纯代码 bug，建议挂 TD（`runCommand` json 分支也应注入 scorecard）。
- **F4/F5（model 列、列宽）**：低优，可选。
- **F6（onboarding 单条闭环）**：可选，运维类，喂回 SKILL.md。

> 注：是否真的登记 TD 由 Lead 判断（🟡 Lead 域——"要不要修"是语义决策）。本文只提供证据与发现，不下处方，符合 `src/diagnosis.js` 的同款纪律。

> **归口更新（2026-06-26，后续追加，不改写上方原始发现）**：Lead 已采纳 F1+F2+F3 修复方案并执行完毕。
> - **F1 → TD-52**（已登记 `docs/tech-debt.md` 开放表）：`printHelp` 已补全（runs dashboard/diagnose/forecast + wao 族 + daemon supervise/supervisor/health），并加 spawn-based help 守卫测试（`test/cli.test.js`）防回归。
> - **F3 → TD-53**（已登记）：`runCommand` 的 scorecard 注入已前置于格式分支之前，json/text 两路对等；加 json/text 双对照守卫测试。
> - **F2**：`SKILL.md` Quick reference 已补 `### Project state (.wao/)` 子节，与责任链第 6 步呼应。
> - F4/F5/F6 未采纳（cosmetic / 可选），保持现状。
>
> 修复进度以 `docs/tech-debt.md` 为准（本过程文档不维护修复状态，按 SSOT 铁律：过程文档只追加不回改）。

---

## 5. 复现脚本

```bash
# 前提：wao doctor HEALTHY + registry validate all valid（本文 1.2）

# 哨兵 prompt（多行，必须 --prompt-file，见 SKILL.md 避坑 #1）
cat > .dev/e2e-sentinel-prompt.txt <<'EOF'
这是一个 WAO 端到端冒烟的哨兵任务。请在 <CWD>/ 下完成两件事：
1. 读取 README.md，用 node 打印出它的字符数。
2. 创建 <CWD>/wao-e2e-sentinel.txt，内容只有一行：SENTINEL_OK <README字符数>。
完成后简短回报。不要做其它事情。
EOF

# 派发 + hard scorecard（要求命令跑过 + 文件落地）
npm run cli -- run coder_low \
  --prompt-file .dev/e2e-sentinel-prompt.txt \
  --cwd <目标项目> \
  --scorecard-mode hard \
  --scorecard-rules '{"requireCommands":["node -e"],"requireFiles":["wao-e2e-sentinel.txt"]}' \
  --format json --wait-timeout 180000

# 验收链
RID=run_20260626201056960vh27g1   # 换成你实际拿到的 runId
npm run cli -- status $RID
npm run cli -- runs scorecard $RID
npm run cli -- runs metrics $RID
npm run cli -- runs diagnose $RID
npm run cli -- runs dashboard --latest 5

# 对账：磁盘文件内容应 == SENTINEL_OK 5168
cat wao-e2e-sentinel.txt

# 清理（哨兵产物不是真代码）
rm -f wao-e2e-sentinel.txt .dev/e2e-sentinel-prompt.txt
```

---

## 6. 追加：二次 dogfood（同日，模拟新 Lead 从安装到验收）

> 追加时间：2026-06-26。本文是过程日志，只追加事实，不回改上方第一次记录。

### 6.1 本轮覆盖链路

- 技能/安装视角：读取 `SKILL.md`、`AGENT_ONBOARDING.md`、`references/safety-incidents.md`；执行 `wao doctor`、`registry validate`。
- 编排：按 `docs/team-roles.md` 选 `coder_low` 做低风险 worker；尝试 `auditor` 前置审计；主控侧轮询、collect、scorecard、metrics、diagnose、dashboard、handoff、残余进程检查。
- 交付验收：后置 `auditor` 使用给定事实复核，返回 PASS。

### 6.2 本轮关键 run

| 项 | 值 |
|----|----|
| 前置 auditor | `run_20260626205200904cax46b`，主动 stop 后最终记录为 failed |
| ghost background 1 | `run_2026062620540179514ob27`，`run --background --prompt-file` 返回 runId，但无 transcript/owner |
| ghost background 2 | `run_20260626205514338lhz90o`，`run --background --prompt` 返回 runId，但无 transcript/owner |
| 成功 worker | `run_20260626205632429qj77xy`，显式加 `--registry config\agents.json` 后 completed |
| 后置 auditor | `run_20260626205819651qvdg5n`，completed，结论 PASS |

### 6.3 成功路径证据

`run_20260626205632429qj77xy`：
- `status`：completed。
- transcript 记录 worker 读取 `SKILL.md` / `AGENT_ONBOARDING.md`。
- transcript 记录命令 `npm run cli -- wao doctor`，输出 `WAO Doctor: HEALTHY`，9 项 OK。
- transcript 记录命令 `npm run cli -- wao handoff write ... --to lead ...`，写入 `.wao/handoff/coder_low-20260626T205702.md`。
- `collect` 可重建 assistant summary。
- `runs scorecard --format json`：passed，`hasDoneEvent` + `hasEvidence` 均过。
- `runs metrics --format json`：input=42593，output=546，costUsd=0.273879，durationMs=58674。
- `runs diagnose --format json`：`category: none`。
- `runs dashboard --latest 5 --format json`：该 run completed、unflagged。
- owner heartbeat `.owner-run_20260626205632429qj77xy` 已清理。
- `tasklist | Select-String opencode` 无输出。

后置 auditor 对上述事实给出：**PASS for delivery acceptance**。它同时强调：PASS 覆盖本次交付物，不代表 harness 没有产品债。

### 6.4 新增 / 仍存在 friction

#### F7【高】`run --background` 不显式传 `--registry` 会返回 ghost runId

复现：两次执行 `run coder_low --background ...` 未显式传 `--registry`，CLI 都返回了 runId 和 `detached runner owns lifecycle` 提示，但 `runs/<runId>.jsonl` 不存在、`.owner-<runId>` 不存在、`runs list` 看不到该 run。加 `--registry config\agents.json` 后同样任务正常生成 transcript 并完成。

代码层线索：`spawnBackgroundRunner()` 只在 `options.registry` 存在时才转发 `--registry`；background runner 的 `runBackground()` 要靠 `opts.registry` 构造 RunManager config。默认 `config.registry` 未被透传，detached 子进程在写 transcript 前失败，且 `stdio: "ignore"` 吃掉错误。

归口：TD-54。

#### F8【高】background 分支和 foreground 分支的 prompt-file 行为不对等

`run --prompt-file ...` 在 foreground 实测可用，transcript 的 `prompt.sent` 是文件内容；但 help 未列 `run --prompt-file`，且 background 包装层只传 `--prompt options.prompt ?? ""`，不会先 `loadPrompt(options)`。如果用户照 SKILL.md 的 PowerShell 多行避坑使用 `run --background --prompt-file`，极易生成空 prompt 或 ghost run。

归口：TD-54（与 F7 同属 background runner 参数透传/可观测问题）。

#### F9【高】手动 stop 进程式 run 后，transcript 出现 `aborted -> failed` 覆盖和 seq 回退

前置 auditor `run_20260626205200904cax46b` 被主控主动 `stop`。`stop` 命令返回：

```json
{"stopped":true,"backend":"process","pid":36152,"taskkillCalled":true,"verified":true}
```

但后续：
- `status` 最终为 `failed`，reason=`backend_error`。
- `runs diagnose` 分类为 `crash`，而非 `aborted_manual`。
- `tail` 中先写 seq 23 `run.stop_requested`、seq 24 `running -> aborted`，随后又出现 seq 22 `run.error`、seq 23 `running -> failed`，违反 transcript seq 单调和终态唯一性直觉。

归口：TD-55。

#### F10【中】活跃 worker 有 tool events 时，状态仍显示 `submitted`

`run_20260626205632429qj77xy` 已经发生 `tool_use`、`command`、`tool_result`，但首个 assistant message 前 `status` 仍是 `submitted`。对主控轮询来说，这会把“已经在工作”误读为“还没启动”。后续首个 assistant message 才转 `running`。

归口：TD-56。

#### F11【中】`wao handoff write --to lead` 与 `wao handoff read lead` 不对称

worker 执行：

```powershell
npm run cli -- wao handoff write --from coder_low --to lead --summary "..." --artifacts ".wao/handoff/lead.md"
```

返回 written=true，实际文件为 `.wao/handoff/coder_low-20260626T205702.md`，内容标题是 `coder_low -> lead`。但主控执行 `npm run cli -- wao handoff read lead` 返回 `{ "found": false }`。这让“worker 写给 lead，lead 读取”这条责任链断在寻址规则上。

归口：TD-57。

#### F12【中】onboarding 最小闭环示例引用已不存在的 worker id

`AGENT_ONBOARDING.md` §“第一个任务”仍写 `coder_strict`，§“派发 GLM 任务”仍写 `coder_glm_claude`；当前 registry 是 `researcher/coder_hq/coder_low/coder_mm/tester/auditor`。首次安装 agent 照抄会直接失败。

归口：TD-58。

#### F13【低】前置 auditor 容易过度探索

前置 auditor prompt 要求“Return PASS or FAIL, at most three risks”，但实际开始读取多份文件并未收敛，主控最后 stop。后置 auditor 使用“只基于给定事实、不要读文件/跑命令、8 行内”后顺利 PASS。说明审计 prompt/role 需要更硬的边界，或主控默认给 auditor 更短的 `wait-timeout`。

不单独挂 TD；作为使用纪律记录。

---

## 7. 追加：TD-54~TD-58 修复验证（同日，单元/文档级）

> 追加时间：2026-06-26。本文只追加修复验证事实；TD 状态以 `docs/tech-debt.md` 为准。

- TD-54：`run/spawn --background` 默认 registry 透传、`--prompt-file` parity、启动失败 failed transcript 已加测试覆盖。验证命令：`node --test --import ./test/_guardBypass.mjs test/cli.test.js test/backgroundRunner.test.js`，结果 pass。
- TD-55：transcript 跨实例 append seq 单调、外部 aborted terminal 不被 wait failed 覆盖、diagnose 对 stop/aborted 优先归 `aborted_manual` 已加测试覆盖。验证命令：`node --test --import ./test/_guardBypass.mjs test/transcript.test.js test/runManager.test.js test/diagnosis.test.js`，结果 pass。
- TD-56：首个 `tool_use` / `command` / `metrics` active event 触发 `running(first_event)` 已加测试覆盖。验证命令：`node --test --import ./test/_guardBypass.mjs test/runManager.test.js`，结果 pass。
- TD-57：`readHandoff(role)` 改为读取发给该 role 的最新 incoming handoff，且不返回该 role 发出的 outgoing；已加单 sender + 多 sender 测试覆盖。验证命令：`node --test --import ./test/_guardBypass.mjs test/waoHandoff.test.js`，结果 pass。
- TD-58：`AGENT_ONBOARDING.md` 最小闭环改用 `coder_low`，显式 `--cwd <目标项目>` + `--registry <WAO目录>/config/agents.json`，补 runtime skill 目录安装说明并消除重复 `## 4`；docs consistency 已守卫。验证命令：`node --test --import ./test/_guardBypass.mjs test/docs-consistency.test.js`，结果 pass。

后续放行仍需执行 changed-area gate、`npm test` 和真实 `coder_low` e2e gate；单元/文档级 pass 不等同于发布放行。

### 7.1 追加：release gate 验证（真实 coder_low）

> 追加时间：2026-06-26。真实 e2e 会消耗 provider token，本节只记录本次实际执行结果。

- `npm run cli -- wao doctor`：HEALTHY，11 项 OK。
- `npm run cli -- registry validate`：6 agents checked, all valid。
- 真实 background run：`run_20260626212943717gwasmg`。
  - 派发命令未显式传 `--registry`：`npm run cli -- run coder_low --prompt-file .dev\fresh-runtime-e2e-prompt.txt --cwd D:\projects\windows-agent-orchestrator-poc --background --scorecard-mode hard --wait-timeout 240000 --format json`。
  - CLI 立即返回 `{ background: true }`；`runs/run_20260626212943717gwasmg.jsonl` 在 3 秒内存在。
  - 最终 `status`：completed。
  - worker 实机执行 `npm run cli -- wao doctor`，输出 `WAO Doctor: HEALTHY`。
  - worker 实机执行 `npm run cli -- wao handoff write --from coder_low --to lead --summary fresh-runtime-e2e-td54-58-20260626 --artifacts runs`，输出 `written: true`。
  - `collect`：可重建 assistant summary，明确 doctor HEALTHY + handoff written=true。
  - `runs scorecard --format json`：passed，`hasDoneEvent` + `hasEvidence` 均过。
  - `runs metrics --format json`：state=completed，input=36420，output=235，costUsd=0.206151。
  - `runs diagnose --format json`：`category: none`。
  - `wao handoff read lead`：读到 `# Handoff: coder_low → lead (20260626T213020)`，summary 为 `fresh-runtime-e2e-td54-58-20260626`。
  - `Get-ChildItem runs -Force -Filter ".owner-*"`：无输出。
  - `tasklist | Select-String opencode`：无输出。

结论：changed-area gate、full local gate、真实 coder_low e2e gate 均通过；TD-54~TD-58 本轮放行。

---

## 8. 追加：第三轮 dogfood（TD-52~58 修复后复跑全流程，新 runtime 视角）

> 追加时间：2026-06-26（commit `65d8593` 之后）。过程日志，只追加事实，不回改上方。
> 视角：把自己当成**这些修复都落地之后第一次装上 WAO 的 agent**，重走 安装→读说明→实机调用→编排→派发→轮询→验收 全流程，同时回归 F1/F3/F7/F8/F10/F11/F12 的修复是否真的消除了摩擦，并找新摩擦。

### 8.1 先验证：上一轮修复确实生效（回归通过）

| 旧 friction | 本轮证据 | 状态 |
|---|---|---|
| F1（help 漏列命令） | `help` 现完整列出 runs dashboard/diagnose/forecast + `wao` 全族 + daemon supervise/supervisor/health；`run` 也列了 `--prompt-file` | ✅ 已修 |
| F3（json 丢 scorecard） | `run tester --format json` 成功 run 的 JSON **含完整 `scorecard`**（passed:true + 3 项 check）；代码 `cli.js:747-748` 注入前置于格式分支 | ✅ 已修（实机+代码双证） |
| F7（background 不传 --registry → ghost） | `run coder_low --background`（**未传 --registry**）3s 内生成 transcript + `.owner-<runId>` 心跳 | ✅ 已修（registry 透传成立） |
| F8（background prompt-file parity） | `run --background --prompt-file` 正常落 `prompt.sent` 并驱动 | ✅ 已修 |
| F10（活跃却显示 submitted） | transcript seq7 `submitted->running (first_message)`，TD-56 的 first-event 转移成立 | ✅ 已修 |
| F11（handoff write/read 寻址不对称） | `handoff write --from coder_low --to lead` → `handoff read lead` 读到该 incoming handoff | ✅ 已修 |
| F12（onboarding 引用废弃 worker id） | `AGENT_ONBOARDING.md` 最小闭环已是 `coder_low` + 显式 `--cwd`/`--registry` | ✅ 已修 |

主路径仍然顺滑：preflight 三连（doctor / registry validate / registry list）、派发→轮询→验收、`diagnose` 证据-only 归类（失败 run `provider_auth`、成功 run `none`，均带/不带引用证据，不臆测）、`dashboard` 一屏聚合 + ⚠ 标记、hard scorecard 真闸（commandsPassed + filesExist）、成功交付物**三方对账**（磁盘 README=5149 / 哨兵文件 `SENTINEL_OK 5149` / worker 自报 5149 一致）、结构化失败结果（SKILL §4b 形态 `{completed:false,failed:true,timedOut,error}`）、进程式 worker 零残留。

### 8.2 本轮关键 run

| 项 | 值 |
|----|----|
| ghost（N1 复现） | `run_20260626220752817afyymi` —— `run --background` 传**被 PowerShell 损坏的** `--scorecard-rules`，CLI 返回 runId+`background:true`，但无 transcript / 无 `.owner-` / 不在 `runs list`（真 ghost） |
| 真实 401（ZHIPU） | `run_20260626221130561b9wm4q` —— `coder_low`(glm-5-turbo) background，干净 JSON 派发成功落地，但 `run.error` 401 `令牌已过期`，终态 failed |
| 真实 401（DEEPSEEK） | `run_20260626221741938och898` —— `researcher`(deepseek-v4-flash) foreground，401 `api key ...RAAA is invalid` |
| 成功交付 | `run_20260626222211162z4zvk4` —— `tester`(codex) foreground，completed，hard scorecard passed，三方对账一致，in=70729/out=699/reasoning=516，~38.6s |

### 8.3 新增 / 仍存在 friction

#### N1【高】malformed `--scorecard-rules` 走 `--background` → 静默 ghost run（F7 同类失败模式经新根因复活）
- 复现：`run coder_low --background --scorecard-rules <非法JSON>` 返回 runId + `background:true`（貌似成功），但 transcript/`.owner-`/`runs list` 全无。
- 根因链：`spawnBackgroundRunner`（`cli.js:689`）把 `--scorecard-rules` **原样转发不校验** → detached runner `runMain` 在 `JSON.parse(opts["scorecard-rules"])`（`backgroundRunner.js:228`）抛错 → 该抛错发生在 `runBackground` 的 try/catch（含 TD-54 "启动失败 failed transcript" 安全网，`:135-136`）**之外** → 冒到 `runMain().catch()` → `process.exit(1)`，而 detached `stdio:"ignore"`（`cli.js:693`）吞掉 stderr。
- 对比：foreground 路径在 CLI 进程内 `parseScorecardRules`（`cli.js:740`），非法 JSON **当场报错可见**。前/后台不对称。
- 评估：这是 TD-54 想关闭的 ghost 类，但当时只修了 registry 透传这一个根因；"background 返回 runId 但 run 静默不存在" 这一**类**未完全关闭。
- 归口建议（🟡 Lead 判）：CLI 在 fork background runner **之前**就 parse/validate `--scorecard-rules`（与 foreground 对称，fail-fast 在用户看得见的进程）；或给 runMain 的 argv+JSON 解析包一层，使解析失败也写 startup-failure transcript。

#### N2【中】SKILL.md 的 PowerShell `--scorecard-rules` 转义示例在 `npm run cli --` 链路上不成立
- SKILL.md §Scorecard 给的 PowerShell 形式 `--scorecard-rules "{\"requireCommands\":[\"npm test\"]}"`。严格照抄经 `npm run cli --` 派发，JSON 到达时被损坏成 `{\ requireCommands\:[...]}`（双引号全失），正是该节自己警告的 "JSON got eaten"——但它给的修法在**文档主推的入口**上不奏效（npm 转发层 + PowerShell 7 原生解析双重处理）。叠加 N1 = 照文档走的 fresh agent 会撞上静默 ghost。Bash 单引号可用；`node src/cli.js` 直调与 `npm run cli --` 行为可能不同。
- 归口建议（🟡）：加 `--scorecard-rules-file <path>`（仿 `--prompt-file`，彻底绕开 shell 引号）；并把 SKILL.md 的 PowerShell 示例改成文件形式或注明 inline JSON 需用 bash / `node src/cli.js`。

#### N3【中】`wao doctor` 报 HEALTHY + key "已设置"，但 key 实际失效（假绿灯）
- 本轮 ZHIPU 与 DEEPSEEK 两把 key 派发时均 401（`令牌已过期` / `api key ...RAAA is invalid`），而 `wao doctor` 全报 `[OK] key_*: 已设置` + 整体 HEALTHY。doctor 只校验环境变量**存在**，不校验**有效**。
- 但 `AGENT_ONBOARDING.md` §4d 的契约是 "doctor 必须报 HEALTHY 才能开始用"——HEALTHY ≠ 可派发。对第一次用的 agent，这是最易让"第一次真实派发"莫名失败的点（preflight 全绿却 worker 全 401）。
- 归口建议（🟡）：doctor 增 opt-in `--probe`，对每个 provider 做一次极小 auth ping；或弱化 onboarding 契约措辞（doctor 只证"存在"，有效性由 reliability cert / probe 证）。

#### N4【低-中】`runs scorecard` 对"配了规则但 run 提前失败"的措辞误导 + "none" 分支无视 `--format json`
- 失败 run（**确实带了** `--scorecard-rules`）执行 `runs scorecard --format json`，输出纯文本 `(none — run had no scorecard rules)`。两问题：(a) 措辞错——规则有传，只是 run 在 gate 前 401 死了、没有 `scorecard.checked` 事件；fresh agent 会误读成"我忘了加规则"。(b) `--format json` 被忽略，JSON 消费方拿到 text（与 F3 同类的格式不对等，只是在 `runs scorecard` 自己的 none 分支）。
- 归口建议（🟡）：区分"未配规则" vs "配了规则但 run 在 scorecard gate 前失败"；所有分支都尊重 `--format json`。

#### N5【低】刚派发的 `--background` run 在 transcript 落盘前，`status` 抛裸 `ENOENT`
- `run --background` 返回 runId 后的 ~1–3s 窗口内，`status <runId>` 抛 `ENOENT: ... runs/<id>.jsonl` 而非 "pending/初始化中"。fresh agent 立刻轮询时，**无法区分"还在启动" vs "ghost/已死"**（这也正是 N1 的 ghost 难诊断的原因——两种情况同一个 ENOENT）。
- 归口建议（🟡）：status 对"刚发放的 runId" 返回软态 pending；或 `--background` 在返回前同步写 transcript 首事件。

#### N6【低】`status` 无 `--format json`
- help 只有 `status <runId> [--run-dir DIR]`。程序化轮询方（WAO 的主要消费者）只能解析 text 或自己读 transcript。

#### 仍存在（上一轮已记、未采纳）
- F4：`registry list` 的 model 列对 kimi(`coder_mm`)/codex(`tester`) 仍显示 `-`。
- F5：`runs dashboard` 列宽对超长 runId（27 字符）仍错位（RUN_ID 列被撑爆，后续列右移）。
- 文档小不一致：`README.md` Quick start 用 `registry list` + `registry check`，而 SKILL.md / AGENT_ONBOARDING 用 `registry validate`——三个 registry 子命令并存，首次上手要犹豫一下用哪个。

### 8.4 复现脚本（关键两条）

```bash
# N1：malformed scorecard-rules 走 background → 静默 ghost
#   （注意：这里 PowerShell 形式的 JSON 会被损坏，正是触发条件）
#   PowerShell: npm run cli -- run coder_low --prompt-file P --cwd D --background \
#     --scorecard-mode hard --scorecard-rules "{\"requireFiles\":[\"x.txt\"]}" --format json
#   → 返回 runId + background:true；但 runs/<id>.jsonl 不存在、runs list 看不到

# 成功闭环（用未失效的 codex 认证，绕开过期的 ZHIPU/DEEPSEEK key）：
#   Bash 单引号 JSON 不会被损坏
npm run cli -- run tester --prompt-file P --cwd D \
  --scorecard-mode hard \
  --scorecard-rules '{"requireCommands":["node"],"requireFiles":["wao-e2e-sentinel2.txt"]}' \
  --format json --wait-timeout 240000
# → completed + scorecard.passed=true + 三方对账一致
```

> 注：是否登记 TD（N1~N6）由 Lead 判（🟡 语义决策）。本节只供证据与发现，不下处方、不维护修复进度，符合 §4 同款 SSOT 纪律。本轮真实花费≈$0（两次 401 在出 token 前即死；codex 成功 run 无计价字段）。

### 8.5 根因更正：N3 的"key 失效"结论是错的 —— 真因是 claude-code OAuth 凭证覆盖 wrapper 注入的 token

> 追加时间：2026-06-26（§8 之后的根因深挖）。按 append-only 纪律：**不回改 §8.3 的 N3 原文**，在此追加更正。N3 当时的归因（"key 已失效 / doctor 假绿灯"）**经深挖证伪**。

**证伪链（证据对账）：**
1. `$env:` 进程值 == User 注册表值，三把 key 全等（ZHIPU tail `kJUu` / DEEPSEEK tail `9268` / KIMI tail `EVhW`）→ **不是 env 陈旧/未传播**。
2. 整条 WAO 链路（plain node + `wao-node.cjs` shim child）看到的 `DEEPSEEK_API_KEY` 都是 tail `9268` → wrapper（`scripts/wrappers/claude-code-provider-wrapper.mjs:17` 读 `process.env[apiKeyEnv]`，:25 注入 `ANTHROPIC_AUTH_TOKEN`）注入的就是 `9268`。
3. **但 worker 两次 401 报的 token 尾号是 `RAAA` / `XQAA`——都不是 `9268`，且两次不同。** 静态 env 不会变值。
4. `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` 尾号 == **`XQAA`**（与第 2 次 401 完全一致），`refreshToken` tail `DAAA`，`subscriptionType: pro`，`expiresAt` 未过期；文件 mtime 随 run 刷新（`CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1` → access token 会刷新，故 `RAAA`→`XQAA`）。
5. **修法实验（决定性）**：`CLAUDE_CONFIG_DIR=<空目录>` 下重派 researcher → **completed**（`run_20260626224224728149tzj`，cost $0.119，用的就是 `9268` 那把 deepseek key）。唯一变量是隔离 OAuth 凭证可见性，结果从 401 翻转为成功。

**真根因：** claude-code worker **优先使用 `~/.claude/.credentials.json` 里的 Pro 订阅 OAuth accessToken，忽略 WAO wrapper 注入的 `ANTHROPIC_AUTH_TOKEN`**，于是把 Anthropic OAuth token 发到了被 wrapper 改写过 base-url 的第三方端点（DeepSeek/ZHIPU）→ provider 拒绝 401。token 每次不同正是 OAuth 刷新。**用户的 provider key 没失效、没陈旧、与注册表一致——压根没被 claude-code 采用。**

**触发条件：** 机器上 claude-code 处于 OAuth 登录态（Pro/Max），尤其当 WAO 由一个 OAuth 登录的 Claude Code 会话**作为 Lead 启动**时（宿主会话还会注入 ambient `ANTHROPIC_BASE_URL=https://api.anthropic.com` + OAuth 刷新机制）。`config/agents.json` 中 **6 个 worker 里有 4 个是 claude-code provider-wrapped**（researcher/coder_hq/coder_low/auditor）——这一类**全部**受影响。这解释了为何上一轮 frictionlog（§6/§7）的 coder_low 能成功（彼时大概率不是从 OAuth 登录的 claude-code 会话内派发，或 claude-code 未登录），而本轮全 401。

**WAO 的缺口（回答"是不是没讲清楚"）：**
- wrapper 的设计前提是"`ANTHROPIC_AUTH_TOKEN` 权威"——在 claude-code OAuth 登录态下**不成立**，但代码与文档都没声明这个前提，也**未隔离 worker 的 `CLAUDE_CONFIG_DIR`**。
- `wao doctor` 测不出（它只查 `process.env[key]` 存在性，真正的 auth 决策在 claude-code 进程内部）。
- `docs/troubleshooting.md:267` 只提了"key 放 User registry + 重启 runtime 让它继承"（env 传播），**没提 OAuth 覆盖**这一类。

**归口建议（🟡 Lead 判）：**
- 【高】provider-wrapped claude-code worker 启动时设 `CLAUDE_CONFIG_DIR` 指向一个**隔离的、无 OAuth 凭证的配置目录**（实测可强制回落到 `ANTHROPIC_AUTH_TOKEN`）。这同时也是更干净的 worker 隔离。
- 【中】`wao doctor` 检测到 `~/.claude/.credentials.json` 含 `claudeAiOauth` 且存在 provider-wrapped claude-code worker 时，**WARN**："claude-code 处于 OAuth 登录态，provider worker 可能用订阅 token 而非你的 provider key（除非隔离 config）"。
- 【中】AGENT_ONBOARDING / SKILL / troubleshooting 明确记录该 trap。

> 真因属代码+文档双缺口（非环境问题）。N3 在 §8.3 的原文保留作为"当时的错误归因"留痕——这正是 systematic-debugging 中"先证伪臆测再下结论"的价值示例。
