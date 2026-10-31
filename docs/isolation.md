# isolation.js 使用说明

> 对应源码：`src/isolation.js`

## 模块职责

提供统一的 **git worktree 创建/删除/列举**能力，供 `RunManager` 在启动 run 时按需调用，为每个 run 建立隔离的代码工作树。ephemeral 只读 run 不用 worktree，用源仓的私有克隆：`createReadOnlyClone`、`probeReadOnlyClone`（删前证据检查）、`removeReadOnlyClone`，规则见 `docs/02-architecture.md` §4.3 ① 与决定 0102。

边界（设计原则）：

- 只负责"如何隔离"，**不决定"要不要隔离"**。后者由 `RunManager` 读取 agent 配置决定。
- worktree 目录约定放在 `<sourceCwd>/.wao-worktrees/<name>`。
- 所有 git 调用用 `execSync`（同步执行，因 worktree 操作属于快命令）。
- 所有函数返回 `Promise`，便于上层 await 统一风格。

## API

### `createWorktree(sourceCwd, name)`

创建一个独立 worktree，并新建对应分支。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `sourceCwd` | `string` | 源仓库（主工作树）路径，必须是 git 仓库 |
| `name` | `string` | worktree 名称，用作目录名与分支名 |

- **内部行为**
  1. 校验 `sourceCwd` 是 git 仓库，否则抛 `Error`。
  2. worktree 路径 = `<sourceCwd>/.wao-worktrees/<name>`。
  3. 分支名 = `wao/<name>`。
  4. 执行 `git worktree add "<path>" -b "<branch>"`。
- **返回**：`Promise<{ path: string, branch: string }>`
  - `path`：新 worktree 的绝对路径
  - `branch`：新建的分支名（`wao/<name>`）

### `removeWorktree(wtPath)`

删除指定 worktree（含目录）。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `wtPath` | `string` | 待删除的 worktree 路径 |

- **内部行为**
  1. 若路径不存在，直接 resolve（幂等）。
  2. 从目标树自己的 `git rev-parse --git-common-dir` 推出源仓库（common dir
     的父目录即主工作树根；推不出来时回退到以待删目录为 cwd 的旧行为，
     best-effort）。git 调用不依赖调用方传入仓库路径——转录里的 `cwd`
     可能是相对路径或已删掉的外层树。
  3. 在**源仓库**执行 `git worktree remove --force "<path>"`：Windows 上
     子进程以待删目录为 cwd 时，该目录因是进程自身 cwd 而锁死，git 自己的
     删除必然失败、退回 rmSync 兜底。
  4. **Windows fallback**：上一步失败（常见为文件锁 `Permission denied`）时：
     - 用 `rmSync(path, { recursive: true, force: true })` 强制删目录；
  5. 树目录删掉后，只**定向删这棵树自己的管理条目**（`removeWorktreeAdminEntry`：
     在 `<git-common-dir>/worktrees/` 下找 `gitdir` 内容指向 `<path>/.git`
     的那一项，核对无误才删）。不做仓库级 `git worktree prune`——git 2.50 的
     prune 对"既没有 locked 也没有 gitdir"的条目（别的会话 `worktree add`
     正在 mkdir 与写 locked 之间的微窗形态）无条件清掉，`--expire` 管不到，
     仓库级 prune 与并发 add 之间关不掉这个竞争（见 `isolation.js` 的
     `WORKTREE_PRUNE_EXPIRE` 注释）。其他目录已缺失的 stale 登记留给 serve
     维护 / runs verify-commit 的通用清扫（它们保留 `--expire` 判龄窗）。
- **返回**：`Promise<void>`
- **不会抛错**：所有失败均被吞掉，确保删除操作不阻塞清理流程。

### `listWorktrees(cwd)`

列出仓库下所有 worktree。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `cwd` | `string` | 仓库路径 |

- **内部行为**：执行 `git worktree list --porcelain`，解析 porcelain 输出（`worktree` / `HEAD` / `branch` 字段）。
- **返回**：`Promise<Array<{ path: string, branch?: string, head?: string }>>`

## 使用示例

```js
import { createWorktree, removeWorktree, listWorktrees } from "./src/isolation.js";

// 1. 创建隔离工作树
const { path, branch } = await createWorktree(
  "D:/projects/myrepo",
  "run_20260616103000"
);
// path   = D:/projects/myrepo/.wao-worktrees/run_20260616103000
// branch = wao/run_20260616103000

// 把 path 传给 agent 作为 cwd，agent 的任何改动都不会污染主工作树
await spawnAgent({ cwd: path /* ... */ });

// 2. 列出当前所有 worktree（含主工作树）
const trees = await listWorktrees("D:/projects/myrepo");
// [{ path: "D:/projects/myrepo", head: "abc123", branch: "refs/heads/main" },
//  { path: "D:/projects/myrepo/.wao-worktrees/run_...", branch: "refs/heads/wao/run_..." }, ...]

// 3. run 结束后清理（幂等，可重复调用）
await removeWorktree(path);
```

## 注意事项

- `createWorktree` 要求 `sourceCwd` **已是 git 仓库**；不会自动 `git init`。
- 同名 `name` 重复调用 `createWorktree` 会因分支已存在而失败——上层应保证 `name` 唯一（如用 runId）。
- `removeWorktree` 的 Windows fallback 会强删目录，调用前请确认 worktree 内无未提交且需要保留的内容。
- `.wao-worktrees/` 应加入 `.gitignore`，避免被主仓库追踪。
