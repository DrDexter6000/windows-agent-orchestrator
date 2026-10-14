# 运行 WAO 自己的测试

本页是开发 WAO 时"何时跑全量、何时跑定向测试"的唯一权威。失败的判读与处置见 `docs/troubleshooting.md` §8，为什么这样定见决定 0077。

## 两种跑法

- **全量**：`npm test`。`scripts/canonical-test.mjs` 按 `test/manifest.json` 把全部测试文件分波跑完，再把失败文件单独重跑一次做隔离判定。约 14 分钟。每个测试文件在 manifest 里恰好归入一个资源组（pure / git / worktree / process / lock / timeout / mcp），运行器按组分波；单跑复核只给首轮失败加上 `stable_fail` / `isolation_pass` / `environment_invalid` 分类，不会把它改判为通过。结果写在 `test-results.json`：每个文件的 `durationMs`（文件内各测试耗时之和，不含模块加载）和复核条目的 `isolationDurationMs` 只作观测，缺失时为 `null`，不影响结论。同一台机器上的全量与交付验证共用一把串行化闸，后到者排队，排队不计入任何预算（见[交付与验收](usage/delivery.md)场景 4b）。
- **定向**：`npm run test:one -- <测试文件…>`。它与全量用同一套子进程环境与超时，文件名拼错或匹配不到会直接失败。不用它而直接调 `node --test` 时，必须带 `--test-timeout=600000`，否则挂死的测试没有上限；子进程被版本守卫拒绝时设 `WAO_SKIP_VERSION_GUARD=1`。大批定向测试不要与全量同时在一台机器上跑。

`npm run test:report` 是裸 `node --test`，不是验收证据。

## 一个开发批次怎么跑

| 时机 | 跑什么 |
|---|---|
| 开发中 | 改动所在的测试文件，加上直接消费被改模块的测试 |
| 送审前 | 改动涉及的测试文件，加上横切守卫组；新增、移动或删除了测试文件时再加上 `test/isolation-infra/canonicalRunner.test.js`（它核对 `test/manifest.json` 与磁盘一致） |
| 合入 main 前 | 在最终候选上跑一次全量 |

**横切守卫组**：`test/isolation-infra/docs-consistency.test.js`、`test/isolation-infra/docsSurface.test.js`、`test/isolation-infra/staticRunsGuard.test.js`、`test/isolation-infra/desensitization.test.js`、`test/mcp-surface/m12-10-tool-surface.test.js`。它们检查文档与代码一致、生成层是否需要再生成、测试有没有写进仓库的 `runs/`、被跟踪文件里有没有凭据形状的字面量、MCP 工具面的字节上限，几秒钟跑完，却最常抓到改动的连带问题。新增这类跨全仓的守卫时，把它加进这张清单。

**最终候选**是合入后 main 将会是的那一版：分支已经基于当前 main（快进合入后两者逐字节相同），或者把 worker 交付采纳进来之后、推送之前的集成结果。并行会话先合入了 main 时，先把分支更新到新的 main 再跑。全量之后又改了被跟踪的文件，它就不再是最终候选：要么把改动留到下一批，要么重跑全量。

全局 `wao` 与宿主的 MCP 注册常常直接指向开发检出（本仓库的维护机器就是这样），main 上的错误会立刻影响正在用 WAO 的会话，所以合入前这一次全量不能省。

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
| 触及共享核心：测试与文档以外的一切改动（`src/**`、`config/**`、`scripts/**` 等），以及公共夹具 | `npm test`，并声明 `verificationTimeoutMs ≥ 1200000` |

- 任务书把 worker 自检命令与 `verificationCommands` 分开写。worker 自检一律定向，汇报写明"这些文件通过，其余未测"。
- 交付规格的其它要求（`allowedPaths`、新增测试文件时的 manifest 登记）见[交付与验收](usage/delivery.md)场景 4b。
- `verificationUnavailableReason` 声明的是"不做验证"（结果记 unavailable），不能拿来代替缩小范围的验证。
- 交付验证失败、失败全部是 `isolation_pass` 时，按 `docs/troubleshooting.md` §8.1 处置（安静时段单发复验，再走一次 reverify），不直接拒收。
