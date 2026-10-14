# 会审

> [使用手册](../usage.md)的一页：召集多席只读会审，记录会审席位，让审计席跑派发族测试。

## 场景 4d：多席只读会审（wao consult，决定 0039）

`consult run` 把召集一次多席只读咨询做成一个动作：机械扇出、收集、council-diff 并列呈现。WAO 不做语义合成——不汇总意见、不裁分歧；接受、取舍与判断都在 Lead。

```powershell
# brief 文件 = 共享任务书（编号问题 Q1..Qn + 输出格式契约），逐字节分发给每席
npm run cli -- consult run brief.md --seats astra,kimi,glm-flash

# 带每席视角片段（答题姿势 2-3 句：差异化资产 + 自测问题；原样拼在该席 prompt 尾部）
npm run cli -- consult run brief.md --seats a,b --perspective a=persp-a.md --perspective b=persp-b.md

# 闭集字段比对（只标"字段值不同"；声明值按整词匹配、大小写敏感，不出结论词）
npm run cli -- consult run brief.md --seats a,b --fields Q1=A,B

# 黄牌核查：被审 run 的作者是否在席位清单（advisory，不拦截）
npm run cli -- consult run brief.md --seats a,b --reviewed-run <runId>

# 从组记录重渲染（只读；扇出后即可读）
npm run cli -- consult show <consultId> --format json

# 等待预算到期后接着等（可反复调用）
npm run cli -- consult wait <consultId>

# 取一席的完整原文写进文件
npm run cli -- consult show <consultId> --seat kimi --out kimi.md
```

**状态两维独立**：每席 `runState`（transcript 真值：pending/running/completed/
failed/…；超时/缺席是观察事实，不改写为失败）× `formatState`（structured /
partial / unstructured / empty——`completed` + `unstructured` 是合法组合，
malformed 不惩罚）。半结构化回复（某问藏在散文里）不做句子级切分，按整段原文
兜底进未归类区。

**不变式承诺（机器守卫钉住）**：① 零信息损失——每席回复按问题锚点（行首
`## Q1` / `Q1:` 形）只分组、不摘要、不截断、不重排隐藏，归组块+开场+未归类
三块拼接逐字节等于原文；② 标记即提示——闭集字段值不同仅标"字段值不同(Qn)"，
工具永不输出"一致/分歧"类结论；③ malformed 零自动重发——格式不合格只是观察
事实，WAO 绝不替 Lead 重问。

**组记录**：每次扇出后即在 `<项目根>/.wao/runs/consults/<consultId>.json` 落一份
组记录（席位-runId 映射，是意见到决策的回链锚点，供 decisions/declare 引用），
收集结束后覆盖为完整观察。组记录不写 `runs/`（防 metrics 聚合双计）、不写认证
台账、不产生任何 delivery 事件。席位子 run 本身是普通只读 run（`readOnly` 声明
+ 强制隔离），回复正文的唯一权威在各 run transcript，经 runId 回链。呈现尾部附
独立性三块砖事实表（厂族 / 非作者 / 会话独立性），全部 advisory、不下独立性
结论：厂族砖直读 registry 原始字段（`backend` + `provider` 标识：
`model.providerID` 优先，wrapper 形取 `provider.baseUrl`），不做族系归类判断
（判断权在 Lead）；会话独立性如实显示"未提供"。

**席位比预算慢时**：等待预算最长 10 分钟（`--wait-timeout` 默认 600000ms，范围
180000..600000，同 `runs wait`），席位常常更久，kimi 车道尤其。预算到期只是
不再等，席位照跑——`budgetExpired` 或空回执**不等于零输出**。扇出一完成，
`consult run` 就在 stderr 报出 `consultId` 与各席 runId：`consult wait
<consultId>` 接着等（各席到终态或窗口到期即返回，可反复调用），`consult show
<consultId>`（MCP 面：`run_consult {consultId}`）按当前转录重新推导，零派发。
要求窗口内交付，就在任务书里限制工作量（不跑测试、限命令数），代价是席位
自查深度，取舍归 Lead。每席 prompt 尾部始终带**席位级固定会审合同**（禁实现、
禁建文件、禁派发）。**只读席位违规自动判 FAIL**：席位 transcript 出现
`file_written` 事件即该席意见判 FAIL（`readOnlyViolation` 字段，记录与
`consult show` 可见）；不改写席位 run 的自然终态；未上报的写入（如 shell 重定向）
不计数——worktree 隔离仍是兜底。

## 场景 4e：审计席测试协议（WAO_ALLOW_NESTED_DISPATCH 命令级授权）

决定 0047 的防向下派发门拒绝 worker 上下文里的一切向下派发，因此派发族测试
（runDispatch / runManager 等直接构造 RunManager 的测试）在审计席位（验收会审
席、复核席）里会被整片拒绝。审计席位要在 worker 上下文里真跑这些测试，走正式
豁免口：`WAO_ALLOW_NESTED_DISPATCH=1`（`src/nestedDispatchGuard.js` 的设计内
行为，两臂全免——env 标记臂与 cwd 臂都不拦截）。约束如下：

**授权纪律（全部是协议要求，机器面已配合加固）**：

1. **Lead 授权、命令级作用域**：豁免只出现在审计任务 prompt 里的具体命令行
   （`WAO_ALLOW_NESTED_DISPATCH=1 npm run test:one -- test/run-lifecycle/runManager.test.js`
   形态），**绝不 setx、绝不进任何默认 env、绝不写进车道配置**——车道配置
   携带它会被 `buildChildEnv` 具名拒绝（processBackend.js 注入拒收，大小写
   不敏感），继承/凭据路径同名键一律剔除。
2. **审计回执最小证据块（四元组）**，缺一不可、可机查：
   - 命令原文 + brief 文件 SHA256（派发前 Lead 侧留档）；
   - worker 横幅行（`[canonical] NOTE: … Lead 豁免 …`——证明豁免确实生效且
     被如实报告）；
   - verdict 行（`# pass N / # fail M` 汇总行原文）；
   - 报告路径（必须 `os.tmpdir()` 之下，**禁止写进 worktree**——审计是只读
     角色，worktree 里落文件=越界写入）。
3. **豁免不旁路 busy/隔离**：席位仍是只读 run + 强制隔离，豁免只作用于
   防向下派发守卫的判定。
4. **协议外使用即事故**：任何在协议外观察到豁免被使用的场合（例如 worker
   自助启用），按安全事件上报 Owner——横幅行会如实打出豁免在场事实。

审计席位的 PATH 上常是 v24 的 node，定向测试一律走 `npm run test:one`，由它
选对 Node 版本并配好子进程环境（怎么跑测试见 `docs/testing.md`）。

## 三席会审记录：`wao stage` panel 字段（决策 0023，advisory 非门禁）

方案（stage 2）与交付物验收（stage 4）可登记会审 panel 记录——三席会审（Lead 主审 + 两名副审）是推荐标准，配不齐则以两席为次之推荐；强烈推荐但非强制，跳过需登记显式理由：

```powershell
# 登记自报副审席位（registry 存在性校验；自报、未验证——评审旁证走 --artifacts 的 runs/<runId>.jsonl）
npm run cli -- wao stage 2 --task "方案定稿" --panel-seats glm-pro,astra --artifacts docs/plan.md
# 登记跳过理由（闭集码；与 --panel-seats 互斥，非法码 fail-fast）
npm run cli -- wao stage 4 --task "交付验收" --panel-skip-reason low_risk_small_task
# 裸跑查看 panel 分布 + skip 理由分布（pipeline 自省）
npm run cli -- wao stage --cwd <目标项目>
```

- 跳过理由闭集（SSOT：`src/waoStage.js` 的 `PANEL_SKIP_REASONS`）：`no_reviewer_available` / `low_risk_small_task` / `time_critical` / `owner_direct`。细节差异（如 provider 临时不可用）进 `--note`，不扩闭集。
- 其余 stage（1/3/5/6）带 panel 参数 fail-fast（panel 字段只在方案（2）/交付物验收（4）登记）；同一 stage 允许多条记录，返工/窄复核照常再登记。
- stage 2/4 落盘成功且无 panel 字段时输出 JSON 加性字段 `panelAdvisory`（未记录会审提示；exit 0 不变——非门禁）；stage 4 成功输出固定复述红线："评审意见是证据不是验收；`run_delivery_decide` 只由 Lead 调用"。panel 记录写进 STAGE 正文 frontmatter 与 `pipeline/map.md` 索引行第 5 列（无 panel 的旧行照常解析）。
- 会审就绪提示的两张面（数据源不同，勿混）：`wao onboarding` 的分级块按面切换——私有 `config/agents.json` 不存在时是模板面（从入库模板行 + 当前环境探测推导）；存在且可读（或刚被 `--apply` 写入）时切到已配置面（从该 registry 的行 + 同一探测实现推导；标题标注"已配置面"，附"已配置 N 名 worker（真实状态以它为准）——完整体检见 `wao doctor`"指针行；私有 registry 存在但读取失败则降级模板面并标注来源不可读，不阻塞主流程）。`wao doctor` 的 `panel_readiness` 检查恒为已配置面——从你的 `config/agents.json` + doctor 既有探测推导（无效条目不进计数），仅当探测候选 ≤1 或已知族系不足两族时打印 INFO（三席且跨族才静默；registry 缺位沿"未配置（跳过）"INFO 模式；不计 DEGRADED、不改退出码）。
- 分级语义：候选=全部有效行（任何车道都可能任副审，临场帽子=派发时 role）；tier 按 ready 候选计数（探测口径，不声称已配齐可派发副审）：三席（≥2，推荐标准）/两席（恰 1，次之推荐）/零候选（跳过提示）。已知族系不足两族时仍判三席，但必附跨族系提示（doctor 不静默）。对抗性不做事前预判，由 `wao stage --reviewed-run` 按审者×作者车道指纹派生。`login_based`/`unknown`/`key_only_*` 不计入可用但如实展示（登录态型展示"登录态未验证"，serve 注入型展示"注入式认证（serve 探测不覆盖）"，探测未知展示"探测未知"，无 CLI 面凭据车道展示 key_only 面）；跨族系（推断族系标签，展示专用非契约）是更强推荐。

## MCP `run_consult`（多席只读会审）

`run_consult` 与 CLI consult 同一 service（扇出、组记录、席位只读子 run、council-diff 文本渲染的语义见场景 4d）。单工具双模式：

- **创建模式** `{brief, seats, perspectives?, fields?, reviewedRunId?, waitMs?}`：`brief` 是内联文本（编号问题 Q1..Qn + 输出格式契约）——MCP 面不接受文件路径；`perspectives` 同理内联（每席 `{agentId, text}`，只写"答题姿势"，禁止列期望结论）。每席一个 readOnly 子 run，席位 prompt = brief 逐字节 + 该席视角尾巴。服务端有界等待 `waitMs`：闭集 0..600000，默认 270000——`0` 合法（扇出后立即取当下观察快照）；到期是观察截止（席位照跑、状态如实 running、`budgetExpired:true`），永不杀进程、永不重发。返回机械回执 `view:"receipt"`：`consultId`/`recordPath` + 每席 `{runId, runState, formatState, chars, pages, textFinal}`（零正文、零摘要、零预览；视角全文与组记录在 recordPath）+ `fieldDiff`/`fieldValues` 闭集标记 + 三块砖独立性事实（registry 原始字段直读）+ 席位-runId 回链；回执帽 8KiB。`fields` 闭集声明字段（`{"Q1":["A","B"]}`）只产生"字段值不同"标记，永不出一致/分歧结论。席位 malformed（纯散文）= 观察事实（`formatState:unstructured`），零惩罚、零重发。malformed/缺席/派发失败/到期任一混合都组装降级视图（部分成功），不中断其余席位。
- **读取模式** `{consultId}`：从组记录（绑定工作区下的 `.wao/runs/consults/<consultId>.json`，与 CLI `--cwd <工作区>` 同一落点；扇出后即可读）重渲染同一回执形状，零派发——读取路径不触碰 dispatch 通道；runState/formatState 按当前 transcript 真值重导出。
- **按席分页** `{consultId, seat, page?}`：返回该席最终正文单页（`view:"seatPage"`；`page` 默认 1）——每整页响应 ≤12KiB（序列化 UTF-8 字节，含外壳与转义）；行边界优先切页、单行超帽按码点硬切（不拆代理对）；各页按序拼接逐字节等于该席最终正文；每页携带全文 `textSha256` 版本锚（跨页不一致=正文在读取间隙变化，从第 1 页重读，不跨版本拼接）；`textFinal:false`（非终态席）标记分页边界会漂移。

输入闭集校验：模式互斥（`consultId` 与创建字段同给 = 固定拒绝）；`seats` 逐个 registry 存在性校验，缺席席指名拒绝（重复席、视角席不在 seats 同样指名拒绝）；`waitMs`/`fields` 键形状由 wire schema 拒绝。创建模式要求工作区已绑定（与 `run_dispatch` 同一权威），未绑定即拒；席位的工作目录是绑定的工作区，不取服务进程的当前目录。未绑定、也没有显式给定记录目录时，两种模式都拒绝。以上输入拒绝都发生在任何派发之前（派发计数为 0）。之后的失败只回固定文案：创建模式是 `…before any seat was dispatched` 或 `…after seats were dispatched`（席位 run 可能在跑，用 `runs_list` 找）；读取模式区分找不到记录与记录在但渲染失败。

**与 CLI 的对应关系**：`wao consult run <briefFile> --seats a,b …`（brief 走文件；`--wait-timeout` 即场景 4d 的总预算）与创建模式同一 service；`wao consult show <consultId>` 与读取模式同一重渲染内核，但保持全量渲染（CLI 面不收窄）。参数与形状见 `docs/surface/mcp-tools.md`（生成层，随代码再生成）。

`run_consult` 是 advisory 动作工具（会派出真实只读子 run 并写组记录），不是观察工具——不进 `availableDrilldowns`/`semanticNotes` 目录；扇出成功 ≠ 验收成功，判断权在 Lead。
