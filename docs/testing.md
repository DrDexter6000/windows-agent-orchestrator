# 运行 WAO 自己的测试

本页是开发 WAO 时"何时跑全量、何时跑定向测试"以及"怎样用真实车道试用分支代码"的唯一权威。失败的判读与处置见 `docs/troubleshooting.md` §8，为什么这样定见决定 0077。

## 两种跑法

- **全量**：`npm test`。`scripts/canonical-test.mjs` 按 `test/manifest.json` 把全部测试文件分波跑完，再把失败文件单独重跑一次做隔离判定。约 10 分钟。每个测试文件在 manifest 里恰好归入一个资源组（pure / git / worktree / process / lock / timeout / mcp），运行器按组分波；单跑复核只给首轮失败加上 `stable_fail` / `isolation_pass` / `environment_invalid` 分类，不会把它改判为通过。结果写在 `test-results.json`：每个文件的 `durationMs`（文件内各测试耗时之和，不含模块加载）和复核条目的 `isolationDurationMs` 只作观测，缺失时为 `null`，不影响结论。同一台机器上的全量与交付验证共用一把串行化闸，后到者排队，排队不计入任何预算（见[交付与验收](usage/delivery.md)场景 4b）。全量期间 WAO 会向 Windows 申请保持唤醒（尽力而为；`WAO_KEEP_AWAKE=0` 关闭，行为见 `docs/02-architecture.md` §4.5，决定 0093）。
- **定向**：`npm run test:one -- <测试文件…>`。它与全量用同一套子进程环境与超时，文件名拼错或匹配不到会直接失败。不用它而直接调 `node --test` 时，必须带 `--test-timeout=600000`，否则挂死的测试没有上限；子进程被版本守卫拒绝时设 `WAO_SKIP_VERSION_GUARD=1`。大批定向测试不要与全量同时在一台机器上跑。

`npm run test:report` 是裸 `node --test`，不是验收证据。

## 一个开发批次怎么跑

| 时机 | 跑什么 |
|---|---|
| 开发中 | 改动所在的测试文件，加上直接消费被改模块的测试 |
| 送审前 | 改动涉及的测试文件，加上横切守卫组；新增、移动或删除了测试文件时再加上 `test/isolation-infra/canonicalRunner.test.js`（它核对 `test/manifest.json` 与磁盘一致） |
| 合入 main 前 | 在最终候选上跑一次全量 |
| 只改画像数据（`config/lane-traits.json`）的批次，合入前 | `test/registry-roles/laneTraits.test.js`、`test/application/laneProfile.test.js` 加横切守卫组，不跑全量（决定 0089） |

**横切守卫组**：`test/isolation-infra/docs-consistency.test.js`、`test/isolation-infra/docsSurface.test.js`、`test/isolation-infra/staticRunsGuard.test.js`、`test/isolation-infra/desensitization.test.js`、`test/mcp-surface/m12-10-tool-surface.test.js`。它们检查文档与代码一致、生成层是否需要再生成、测试有没有写进仓库的 `runs/`、被跟踪文件里有没有凭据形状的字面量、MCP 工具面的字节上限，几秒钟跑完，却最常抓到改动的连带问题。新增这类跨全仓的守卫时，把它加进这张清单。

**最终候选**是合入后 main 将会是的那一版：分支已经基于当前 main（快进合入后两者逐字节相同），或者把 worker 交付采纳进来之后、推送之前的集成结果。并行会话先合入了 main 时，先把分支更新到新的 main 再跑。全量之后又改了被跟踪的文件，它就不再是最终候选：要么把改动留到下一批，要么重跑全量。

全局 `wao` 与宿主的 MCP 注册常常直接指向开发检出（本仓库的维护机器就是这样），main 上的错误会立刻影响正在用 WAO 的会话，所以合入前这一次全量不能省；唯一的例外是上表里只改画像数据的批次。

## 用真实车道试用分支代码

测试之外要看分支代码在真实车道上的表现时，在分支工作树里这样跑：

- **CLI**：用 `npm run cli -- …`。全局 `wao` 跑的是 `npm link` 链接的那份检出（通常是主检出），不是分支。
- **注册表**：工作树里没有私有注册表。用 `--registry <主检出>/config/agents.json` 指过去，不要复制一份。注册表不是默认那份时车道表停用（见[车道](usage/lanes.md)），这时只能按 agent id 派发。要看分支的车道表，用 `npm run cli -- wao lanes --registry <主检出>/config/agents.json --lanes-file config/lanes.json`。
- **运行目录**：用 `--run-dir <主检出>/runs`。不给时 run 写进工作树自己的 `runs/`，删工作树时一起没了，提交说明里引用的 run id 就查不到。
- **目标项目**：会写文件的试验，`--cwd` 指向一个临时 Git 仓库；只读观察可以指向 WAO 仓库本身。
- **MCP**：宿主注册的 MCP 服务跑主检出的代码。要试分支的 MCP 面，在工作树里起分支的服务（`npm run mcp -- --registry <主检出>/config/agents.json --run-dir <主检出>/runs --workspace-root <目标项目>`）并经 stdio 发 JSON-RPC；或者在工作树的 `.dev/`（已被忽略）里写脚本，用 `createWaoMcpServer` 加 SDK 的 `InMemoryTransport` 直接调。合入并重启宿主后，用 `lead_preflight` 的 server build 一行确认服务进程已经加载新代码（见[宿主](usage/host.md)的 `lead_preflight` 一节）。

## 全量里出现失败时

- 失败文件**全部**被运行器判为单跑通过（`isolation_pass`），且这些文件与本次改动无关：在提交说明里记下文件名，放行，不整轮重跑。
- 单跑通过的文件里有与本次改动相关的，或者出现任何 `stable_fail`、`environment_invalid` 或别的失败形态：按真红处理，修好后重跑。判读见 `docs/troubleshooting.md` §8.1。
- 出现 `watchdog_timeout` 后，重跑前先按 `docs/troubleshooting.md` §8.3 清掉遗留的子进程。
- 在主检出根目录跑全量前，确认没有活跃的 worker 或 daemon（`docs/troubleshooting.md` §8.2）。

## worker 交付的验证命令

`delivery.verificationCommands` 按改动范围写：

| 交付改动的范围 | 验证命令 |
|---|---|
| 只改测试文件或文档（`*.md`、`docs/**`），不碰公共夹具（`test/fixtures/**`、`test/_*.mjs`、`test/reporter.mjs`） | 被改的测试文件；改了文档时加上横切守卫组，以及直接读这份文档的测试文件（`git grep -l '<文档路径>' -- test` 列出）；新增、移动或删除了测试文件时再加上 `test/isolation-infra/canonicalRunner.test.js` |
| 只改画像数据（`config/lane-traits.json`） | `test/registry-roles/laneTraits.test.js`、`test/application/laneProfile.test.js` 加横切守卫组 |
| 触及共享核心：测试、文档与画像数据以外的一切改动（`src/**`、`config/**`、`scripts/**` 等），以及公共夹具 | `npm test`，并声明 `verificationTimeoutMs ≥ 1200000` |

- 任务书把 worker 自检命令与 `verificationCommands` 分开写。worker 自检一律定向，汇报写明"这些文件通过，其余未测"。
- 交付规格的其它要求（`allowedPaths`、新增测试文件时的 manifest 登记）见[交付与验收](usage/delivery.md)场景 4b。
- `verificationUnavailableReason` 声明的是"不做验证"（结果记 unavailable），不能拿来代替缩小范围的验证。
- 交付验证失败、失败全部是 `isolation_pass` 时，按 `docs/troubleshooting.md` §8.1 处置（安静时段单发复验，再走一次 reverify），不直接拒收。
