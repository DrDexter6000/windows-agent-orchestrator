# 车道配置与维护

> [使用手册](../usage.md)的一页：配置一条车道（registry 字段、kimi 与 deepseek 车道的前提），维护 kimi 车道的 serve，找到认证入口。

## registry 配置详解

每种 backend 需要的字段不同。完整角色矩阵不要在本文复制维护；以
`config/agents.example.json` + `docs/team-roles.md` 为权威。下面只保留最小形状示例：

```jsonc
{
  "agents": {
    // ── opencode-serve（HTTP 类，fallback lane）──
    "coder_opencode_fallback": {
      "backend": "opencode-serve",
      "serveUrl": "http://127.0.0.1:4297",  // opencode serve 地址
      "agent": "build",                       // opencode agent 名
      "cwd": "D:/projects/my-app",            // 工作目录
      "model": { "providerID": "zhipuai-coding-plan", "id": "glm-5.2" },
      "tokenBudget": 5000000
    },

    // ── claude-code（0046 原生通道：官方 OAuth 订阅）──
    "opus": {
      "backend": "claude-code",
      "model": { "id": "claude-opus-5-5" },
      "reasoning": { "effort": "high" },
      "cwd": ".",
      "args": ["--dangerously-skip-permissions"]
    },

    // ── zcode（0046 原生通道：原厂 harness 驱动原厂 LLM）──
    "glm-flash": {
      "backend": "zcode",
      "binary": "C:/Users/<you>/AppData/Local/Programs/ZCode/resources/glm/zcode.cjs",
      "model": { "id": "bigmodel-api/GLM-5.3-Flash" },
      "reasoning": { "effort": "max" },
      "cwd": "."
    },

    // ── deepseek-harness（暂停使用，决定 0074；实验性；不要从 GUI preset/TUI 抓输出）──
    "coder_dsh_experimental": {
      "backend": "deepseek-harness",
      "binary": "C:/path/to/dsh-jsonrpc-agent.cmd",
      "dshConfigPath": "C:/path/to/wao-coder.cordis.yml",
      "credentialEnv": "DEEPSEEK_API_KEY",
      "dshProvider": "deepseek-official",
      "model": { "id": "deepseek-v4-flash", "contextWindow": 1000000 },
      "reasoning": { "effort": "max" },
      "cwd": "D:/projects/my-app"
    },

    // ── deepseek-acp（ADR-0031；shipped ACP profile + 操作员安装的 containment）──
    "coder_dsh_acp": {
      "backend": "deepseek-acp",
      "binary": "C:/path/to/dsh.cmd",        // 可选，缺省 PATH 上的 dsh
      "credentialEnv": "DEEPSEEK_API_KEY",
      "reasoning": { "effort": "low" },      // 可选，仅 low/high/max（wire 实证交集，
                                             // 见生成层 `docs/surface/certification.md` 能力表；其余值被 fail-closed 拒绝）
      "cwd": "D:/projects/my-app"
      // 注意：不配 model/provider 块。provider 组合面固定；model 虽已被 Phase 5
      // 证明同一 ACP 通道可 set，但 WAO 本轮未接线（ACP 的 value 是 provider/model
      // JSON 对，非裸 model.id）——配了仍被 validateAgentPolicy fail-closed 拒绝，
      // 模型取 profile 缺省。
    },

    // ── codex（进程式）──
    "tester": {
      "backend": "codex",
      "cwd": "D:/projects/my-app"
    },

    // ── 带 worktree 隔离的 agent ──
    "glm-pro": {
      "backend": "claude-code",
      "cwd": "D:/projects/my-app",
      "args": ["--dangerously-skip-permissions"],
      "isolation": { "type": "worktree", "strategy": "persistent" }
      // strategy: "persistent"（默认，run 后保留 worktree）| "ephemeral"（run 后清理）
    }
  }
}
```

`seatRole`（R10-B）**已废弃（0065，0045 §1.2 终局）**：席位角色的显式声明机制整体退役——对抗性改为**派生事实**（审者车道 × 被审产出作者车道的关系，车道指纹比对）：`wao stage 2/4 --panel-seats <a,b> [--reviewed-run <runId>[,<runId>]]` 在登记会审席位时按 registry 当前车道配置 × 被审 run 的 `run.started` 钉住作者事实派生（车道不同=对抗前提成立；席位与作者同车道=回避违反大声提示，advisory 不阻断——0019 §3 作者回避机械化）。多值 `--reviewed-run` 支持共同作者；作者不可读/缺 `run.started` 时如实输出 unknown（不折叠成"无违反"）。迁移期兼容：老 registry 里的 seatRole 字段不会被拒载——归一化直接忽略（读取面零消费），`registry validate` 对在场字段出弃用 advisory（可删除）。车道画像/认证/就绪一屏见 `npm run cli -- wao lanes`（只读参考面——非默认 `--registry` 须与 `--lanes-file` 成对，防跨绑规则同 run 命令）。

**deepseek-harness / deepseek-acp 通道适用限制、`registry validate` 能力交叉 `⚠` 警告与 metrics 判读**正文已完整迁移至 `docs/certification-runbook.md` §DSH 通道适用限制与能力交叉警告（单向链接；唯一权威；含 TD-87 metrics 行为的五态化勘误注记）。

## 接入新模型 / 新运行时（lane 内操作 vs Owner 决策）

本节正文（第一分叉、操作食谱、换模型同步面 checklist、案例一行）已完整迁移至 `docs/certification-runbook.md` §接入新模型 / 新运行时（单向链接；唯一权威）。

## backend 能力对照表（TD-162）

本节指针正文已完整迁移至 `docs/certification-runbook.md` §backend 能力对照表（TD-162）（单向链接）；权威投影仍是生成层 `docs/surface/certification.md`（`npm run gen:certification` 再生成，禁止手改）。

## 上游 harness 原语对照（实测）

本节正文（上游原语表、基线日与刷新期限、读法与勘误注记）已完整迁移至 `docs/certification-runbook.md` §上游 harness 原语对照（实测）（单向链接；唯一权威；刷新期限由 TD-184 守卫钉住）。

## 认证正文总落点（certification runbook）

认证操作正文已于 2026-09-26 **文件级全文迁移**至 `docs/certification-runbook.md`（Owner 授权；原文完整移动，非索引/节选路线）：认证结果用于派发选择的边界、DSH 通道适用限制与能力交叉警告、接入新模型 / 新运行时、backend 能力对照表（TD-162 指针）、上游 harness 原语对照（实测）、认证与转录维护命令、delta 认证规程、认证检查结果五态与能力轴分层、单次派发覆盖（场景 1b / 1c，含 MCP 覆盖特有规则）、retry 的 per-dispatch 覆盖继承、认证与当前就绪（历史认证 ≠ 当前凭据/授权/容量）。它是 `seat-certify` 行动面的必读成员（`docs/ssot.md` §0.1）；本页各原位置只保留具名标题与单向链接，不保留第二份当前正文。既有「认证节」类指向（`npm run reliability` 参数说明、backend 能力轴分层骨架等）经本节与下列标题到达新正文。

## delta 认证规程（lane 架构，ADR-0025 批次 3）

本节正文已完整迁移至 `docs/certification-runbook.md` §delta 认证规程（单向链接；唯一权威）。

## 认证检查结果五态与能力轴分层（ADR-0032 §8，2026-09-21）

本节正文（五态判定纪律、`reportsCommandExitCode` 诚实声明、运行时身份入账、能力轴分层骨架、认证证据绑定执行画像与只读适用性三态、更新触发器与执行人）已完整迁移至 `docs/certification-runbook.md` §认证检查结果五态与能力轴分层（单向链接；唯一权威；`harness-certify` 行动面读本节时经此链接跟进新正文）。

## deepseek 车道的目录权限前提

> **deepseek 车道的目录权限前提（deepseek lane prerequisites）**：DeepSeek Harness 缺省给命令套一层 Windows 沙箱（`workspace-write`），它要求工作目录**由当前用户拥有并且有完全控制**。只有"修改"权限的目录上（非系统盘的项目目录常见），沙箱内的命令在执行之前就以 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)` 失败。两种做法，WAO 都不替你选：
>
> 1. **按车道声明权限模式（一次设好，所有项目通用；决定 0074）**：在 registry 的车道条目里写 `"env": { "DSH_PERMISSION_MODE": "danger-full-access" }`（取值只能是 `read-only` / `workspace-write` / `danger-full-access`，拼错即拒）。此后少了两样：harness 的写入沙箱（命令可以写到工作目录之外）和审批请求。WAO 的工作树隔离与交付范围审计还在，但它们是事后检测，拦不住 shell 的副作用。
> 2. **保留沙箱、修目录权限**：由操作者对每个项目目录执行 harness 自带的修复脚本。它会改权限：给目录链上缺权限的目录补上当前用户的完全控制项，并扫描项目目录的子树、**移除其中应用包（AppContainer）的显式允许项**（那些应用会失去对这些对象的访问）；文件内容与所有者不变，每处改动先备份并打印恢复命令。`pwsh -NoProfile -File "<npm 全局目录>\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\assets\diagnose-windows-sandbox-acl\scripts\diagnose-windows-sandbox-acl.ps1" -Path "<项目目录>" -AllowRoot "<项目目录>" -Out "<存放恢复文件的目录>"`；不要用管理员身份运行。结果以末尾的 `nextAction` 为准：`verify_original_confined_operation` 才算修好，`stop` / `restore_pending_then_stop` 就停下按它打印的恢复命令处理。

## kimi 车道的 worker serve

**kimi 专用 worker serve 运维配方（2026-10-10 起，决定见 0047 附录 B）**：kimi
车道指向独立 serve——`pwsh -File scripts/kimi-serve.ps1 -KimiHome <主目录> -Port 58628 -WorkspaceDir <工作区>`
（实测 pwsh 7.6.6；主目录=车道的 `kimiHome`，缺省 `~/.kimi-code`；脚本置 `WAO_IN_WORKER`、`KIMI_CODE_HOME`，不带密钥类变量；
工作区=稳定目录 `D:\projects\.kimi-serve-worker-ws`，**勿用可删临时目录**
——40409 粘滞教训）。serve 会把 env 传给其 MCP 子进程与工具 shell：worker
自助派发被 0047 env 臂拒绝（验收判据=席位内 run_dispatch 被拒且
`Detected worker context: env-marker`；工具 shell `WAO_IN_WORKER` 非空）。
主 serve（默认端口 58627，无标记）留给 Owner 人类使用。车道写了
`serveWorkspaceDir` 时，派发发现 serve 没在跑会自动拉起（决定 0075）；没写就手动拉起。

**KIMI_WEB_TOKEN（kimi 车道凭据面，TD-258 补档）**：

- **是什么/从哪来**：`kimi web` serve 的持久 Bearer token，由上游 serve 签发，
  **持久化在 `<kimi 主目录>/server.token`**（2026-10-11 实测：43 字符文件；文件内
  值即活体凭据——用它调 `/api/v1/meta` 得 200；跨启动与优雅 shutdown 均不变）。
  **headless 获取配方=读该文件**，不依赖启动打印——实测重定向/无 TTY 启动**不打印**
  token（一次性 serve 于 worker 家核验，stdout/stderr 双空；上游 `--help` 的
  "printed at startup"适用于交互式控制台启动）。`rotate-token` 子命令生成新持久
  token 且旧 token **立即失效**——实测 token 按主目录隔离（`KIMI_CODE_HOME` 分家后
  两家 server.token 哈希不同、互不相通），轮换的爆炸半径=同一主目录内的全部 serve，
  轮换前先想清楚。
- **怎么注入**：Windows User 作用域（`setx KIMI_WEB_TOKEN <值>`）。**派发链
  不要求新开终端**——WAO 派发链有 env→HKCU 两级回退（TD-208 实证）；需要
  新终端（或 `[Environment]::GetEnvironmentVariable(...,'User')` 读取）的只有
  直接读进程 env 的工具（如身份探针）。值不回显；registry 只声明名
  （`tokenEnv: "KIMI_WEB_TOKEN"`）。Git Bash 下的引号纪律见
  `docs/certification-runbook.md` 代跑取证段。
- **WAO 的边界**：WAO 从 registry 的 `tokenEnv` 指定环境变量读取 Bearer
  凭据，不负责令牌发放。声明了 `kimiHome` 的车道不读它，直接读主目录的
  `server.token`（决定 0074）。

**TD-250 进程荚治理（决定 0056，2026-10-10）**：kimi serve 为每会话在创建时
拉起 6-8 个助手进程（datasource/analyzer/officecli/mcp.json 条目）且**永不拆
除**（无空闲 GC；会话/工作区删除均不触发；上游无停荚端点）——唯一全量拆除
原语是优雅 `POST /api/v1/shutdown`。三层治理已落地：

1. **终态会话卫生（自动，A1+A1b）**：kimi-web run 以 completed 收口后，
   WAO 自动调 serve 会话删除 API（门=routing 缺席+completed-only+删前 busy
   预探针；失败仅记事件不影响 run 结果）。failed/aborted 的会话**故意保留**
   （迟到收取 SOP 的取证源）。delivery 被 accept 时线系会话同样自动释放
   （验收=线系不可变）。转录事件族：`run.upstream_session_deleted` /
   `_already_gone` / `_delete_skipped` / `_delete_failed`。**这不拆进程**——
   只治会话仓/events 文件堆积。
2. **`serve status|sweep|recycle`（手动维护族，A2/A3；顶层命令——规范形 `npm run cli -- serve …`，全局 shim 形 `wao serve …`）**：
   ```powershell
   npm run cli -- serve status                    # 实例元数据/荚规模/会话计数
   npm run cli -- serve sweep                     # 清扫规划（默认 dry-run）
   npm run cli -- serve sweep --apply             # 删"worktree 已亡"的 WAO 认领会话
   npm run cli -- serve recycle --workspace-dir D:\projects\.kimi-serve-worker-ws
   ```
   - `sweep` 按 WAO 转录 `session.created` 认领（扫全部项目桶），只删
     "worktree 已亡"（形状+干净 ENOENT+父目录在场三条件）的会话；台账在
     `.wao/runs/serve-maintenance/sweep-ledger.jsonl`。**跨 serve 生效**（kimi 会话
     仓实例间共享）——58627 上由 WAO 历史派发产生的会话同样会被认领。
   - `recycle` 双门（WAO 全项目桶无 active run + serve 会话集合 soak 比对
     全 idle）→ 优雅 shutdown 全量拆荚 → 按上方配方重启（env 由命令组装，
     `WAO_IN_WORKER=1` 恒注入）→ 就绪验证。**只动 kimi 车道 serveUrl 指向的
     worker 实例**；Owner 主 serve（58627）名下存量荚由 Owner 自行重启解决。
     **死实例复活（TD-261，0063）**：serve 已死（双面连接拒绝×两探 + 实例 pid
     已死）时 recycle 直接跳过杀步重启（`revived: true`）；pid 活着但端口拒绝
     =可能正在启动 → 拒绝（`serve_not_listening_pid_alive`）。**重启失败语义
     （TD-261b）**：exe 在一切副作用之前解析（显式 `--kimi-exe` 缺席即拒、默认
     链 kimiHome/bin → PATH → `%USERPROFILE%\.kimi-code\bin`）；重启失败/未就绪
     退出码非零并附手动配方指路——shutdown 后 kimi 自清实例文件，重跑 recycle
     会 no_instance 拒绝，须按配方手动拉起。
   - 时机：跑批间隙手动调用即可；忘了的后果=荚多攒几天（有界烦恼），上游
     修复（Owner 反馈 Moonshot：要求 idle 荚 GC 或 :delete 连带拆荚）后
     recycle 退役。
3. **上报上游（A4）**：serve 永不拆助手进程是 kimi 2.1.1 的上游缺陷。
4. **TD-251/决定 0057 增补（2026-10-11）**：readOnly 非复用 run 的强制隔离改
   ephemeral——终态且停止验证确认后自动回收树（未确认留树保迟到收取）；
   delivery 验收后线系树按四道门释放（分支 wao/<runId> 永不删）。真实条件下的
   两段式：树内容+git 元数据在终态清理即删，**空目录壳**可能被泄漏荚的工具壳
   占住句柄（Windows EPERM）——`serve recycle` 杀荚后自动清扫（输出
   emptyWorktreeHusksSwept）。sweep 探针含 busy/main_turn_active 双字段且 apply
   逐项复探；存量卫生补充 v2 sessions:archive 批量归档路线（归档态转录仍可读、
   restore 可逆；台账 .wao/runs/serve-maintenance/archive-ledger.jsonl）。**根治办法 = 私有主目录**
   （决定 0074）：助手进程是主目录里的插件与 `mcp.json` 拉起的，不装它们的私有主目录
   （`KIMI_CODE_HOME`）下 serve 不拉任何助手进程。车道条目写
   `"kimiHome": "<私有主目录绝对路径>"` 即指向它：token 取自 `<kimiHome>/server.token`
   （不读环境变量），`serve status|sweep|recycle` 以它为缺省主目录。**换主目录要换端口**（清扫按
   `serveUrl` 分家）；旧主目录的会话不会跟过来。私有主目录要先单独
   登录一次（`kimi login`，勿复制 credentials），并用上面的脚本拉起一次（生成 `server.token`）；此后 serve
   没在跑由派发自动拉起（车道写了 `serveWorkspaceDir`），否则手动拉起。

## 认证清单门禁（D10，部署级，默认关；0046 §5 步⑨）

MCP 边界的 `run_dispatch` 可选升级为"只派认证清单成员"（Owner 指令"派发任务永远派发认证清单中的"的机器化；ADR 0018 的 advisory 语义在门关着时原样保留）：

- **开**：`setx WAO_MCP_REQUIRE_CERTIFIED 1` 后**重启宿主**（环境变量在 MCP 服务进程 spawn 时定格，模型不可经 tool args 翻转/绕过）；**回退**：删除该变量 + 重启。
- **成员资格**：`selectCertRecord` 双空间命中（席位键直查→车道指纹扫描）且 status ∈ {certified, conditional}——例外条款族的 conditional 是常态；**新鲜度不进门**（30 天跑步机是展示事实，不是拒绝理由）。
- **边界**：门禁只驻 MCP 边界（模型可达面）。CLI 保持 Owner/Lead 特权通道——认证 drill 本身经 CLI 自举（`npm run reliability -- --agent <lane>`），全局门=自举悖论。
- **fail-closed**：台账缺失/不可读/键空间不对=拒绝（固定文案含纠正路径）。
- 翻转前建议全量刷绿一轮（新车道先认证再开门）；2026-10-06 真机实证：门开+sol（certified）真派发放行、空台账 fail-closed 拒绝。

## opencode serve 端口不对
smoke 脚本自动探测 4297-4299。手动指定时改 `config/agents.json` 里的 `serveUrl`。
