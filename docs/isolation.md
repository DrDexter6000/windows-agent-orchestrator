# isolation.js 使用说明

> 对应源码：`src/isolation.js`（里程碑 M3-1）

## 模块职责

提供统一的 **git worktree 创建/删除/列举**能力，供 `RunManager` 在启动 run 时按需调用，为每个 run 建立隔离的代码工作树。

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
  2. 先尝试 `git worktree remove --force "<path>"`。
  3. **Windows fallback**：上一步失败（常见为文件锁 `Permission denied`）时：
     - 用 `rmSync(path, { recursive: true, force: true })` 强制删目录；
     - 再 `git worktree prune` 清理元数据（失败不阻塞）。
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
