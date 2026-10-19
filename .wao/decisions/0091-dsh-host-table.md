# 0091 dsh 进宿主表：Cordis profile patch 的 YAML 片段，探测按 profile OR 合并

- 日期：2026-10-18
- 状态：accepted
- 来源：Owner 2026-10-18「先把 dsh 的 mcp 接上吧」，接上后问「mcp 理论上讲不应该是 harness 通用兼容的吗、怎么现在还要逐个适配？」，随后「做 dsh 进宿主表」。
- 关系：承接 0043（宿主闭集与 snippet/autoBind/hostVerified 三能力）与 0066（表内宿主必须有只读注册探测）。不改变 MCP 工具面。
- 合入授权：Owner 2026-10-12——「只要是你联合会审过的，我都许可 commit & push」。

## 背景

1. 本机主要 harness 之一是 DeepSeek Harness（dsh 0.2.1-rc.2）。2026-10-18 已手工把 WAO 的 MCP server 接进它的 web profile：`~/.dsh/profiles/web/cordis.patch.yml` 加一条 `- insert:` 行，`patchReload: live` 立即生效，会话内实测 `initialize`、`tools/list` 与 `lead_preflight` 调用都成功。
2. 接之前 `mcp bind --host dsh` 只会走表外路线，emit `mcpServers` JSON 并声明格式未核实；`mcp status --host dsh` 返回 `unsupported_host`。照那段 JSON 配 dsh 不会生效——dsh 不读这个形状。
3. dsh 的接入面与表内其它宿主都不同：profile 由 bundle 层加 YAML patch 层组成，MCP client 是可选插件 `@deepseek-ai/dsh-mcp-client`，一行注册要写 `serverName`/`transport`/`command`/`args`/`toolCallTimeoutMs`。它给 MCP stdio 子进程脱敏（名字像凭据的变量被丢掉），工具前缀 `mcp__wao__`。
4. 这与 Owner 的疑问是同一件事：MCP 标准化的是线（JSON-RPC、initialize、tools/list、tools/call），不标准的是装机——配置放哪、什么格式、怎么探测、超时多少。宿主表管的是后者。

## 决定

1. **dsh 入表，snippet-only，hostVerified。** `bind` emit 片段、零写入；验证锚点 = 2026-10-18 在 0.2.1-rc.2 上真实加载并调用成功（不是格式推测）。`stability: experimental`：dsh 仍是预发布版，patch 格式可能变。
2. **片段形状 = Cordis profile patch 的 `- insert:` 行。** `configShape: "dsh-cordis-profile-patch"`，同时给结构化 `insert` 与可直接粘贴的 `yaml` 文本（同一行、两个投影）。`configHint` = `~/.dsh/profiles/<profile>/cordis.patch.yml`。`toolCallTimeoutMs: 660000`：dsh 默认 60s，WAO 等待族最长 600s，理由与 zcode 相同。
3. **`mcp bind` 额外打印 YAML 原文。** JSON 里的换行是转义的，粘不了；原文块与 `configFile` 一起给，片段本身仍是唯一形状源。
4. **探测读 `$DSH_HOME/profiles/*/cordis.patch.yml` 与 `cordis.yml`。** 用最小行扫描（不做 YAML 依赖）：认块序列与 flow 序列 args、引号键、与 `args:` 同列的块序列；块标量（`|`/`>`）里的文本不当条目。同一 profile 内两层是同一棵组合树的文件层，patch 可按 id 覆盖，所以**同一 profile 内任何不确定都记 unknown**（按 id 覆盖、`disabled` 非字面量、多个 WAO 条目、认不出的写法），只有确定才给 registered / registered_other_target / not_registered；profile 之间是独立组合，按 OR 合并（registered 压过 unknown）。
5. **识别标记用 `DSH_SESSION_ID`。** 它在 CLI 子进程里可见（派发 advisory 跑在那里）；dsh 只对 MCP stdio 子进程剥 `DSH_*`，那条路径不需要识别。

## 否决的备选

- **autoBind 替 Owner 改 `~/.dsh/profiles/*`。** WAO 对所有 snippet 宿主都不写用户家目录配置（0043 的边界）；而且一个 profile 被多个 agent/会话共用，live reload 会在别人会话中途生效。
- **照旧 emit `mcpServers` JSON。** dsh 不读这个形状，输出等于假指南；说「格式已核实」也不成立。
- **不给探测，status 恒 unknown。** 0066 的教训就是 Lead 不知道自己在的 harness 有没有工具；表内宿主必须有探测。
- **引 YAML 解析依赖或复用 `dsh --dump-config`。** 前者违反生产依赖纪律（不变量 5）；后者要 spawn，破坏探测「只读、零 spawn」的纪律。片段形状由我们自己固定，局部扫描加 unknown 兜底足够。
- **把 dsh 探测面扩到 bundle 层与 `--patch` 叠加。** 那要理解整棵组合树；本轮只承诺用户 patch 层的两处，其余如实写进已知边界。

## 已知边界

- bundle 层、`--patch` 叠加与 `cordis:include` 不在探测范围：注册写在那里的会被报成 `not_registered`。
- 整条 flow 行（`- { id: …, name: … }`）、flow 形式的 `insert`/`config:`、锚点/别名写法读不出 → `unknown`（文本里出现客户端包名或客户端行 id、但没有一条能解析的行，同样记 `unknown`）。YAML 锚点/别名、merge key、多文档与 `cordis:include` 不在解析范围。
- 同一 profile 内出现覆盖该 id 的 patch（`- id: …` 且无 `insert`，**包括带 `name` 断言的覆盖行**）、`disabled` 是 `!!js` 表达式、或同一文件多个 WAO 条目 → `unknown`：不猜最终组合结果。
- `disabled` 按 loader 的布尔语义判：字面 `true` 与非空字符串（含 `"false"`）算禁用，`false`/`null`/空值算启用。
- `sources` 不排优先级（各 profile 不是覆盖关系），`effective` 恒 `false`；`not_registered` 时不标任何生效来源。
- OR 合并回答的是"有没有任何 profile 注册了"，不是"当前会话所在的 profile 注册了没有"。某个 profile 未注册时，advisory 可能被另一个 profile 的注册压掉——dsh 没有暴露当前 profile 的会话变量可依。
- 经 dsh MCP 发起 `run` / `run_consult` 的凭据面未实测：dsh-mcp-client 给 stdio 子进程的是**脱敏后的 ambient env**（名字像凭据的变量会被丢掉）。WAO 的 Windows 用户环境桥覆盖 `credentialEnv` 声明，其余通道的登录态是文件型，预期可用；首次真实派发时确认，若被剥就用片段里的 `env:`（`!!js process.env.X`）显式透传。
- dsh 仍是 0.2.1-rc.2；升到正式版时 patch 格式与插件配置字段要复核一次。
- `DSH_SESSION_ID` 的可见性只在当前 dsh 版本上核实过；换版本后若 CLI 子进程不再带它，advisory 只会静默，不会误报。
