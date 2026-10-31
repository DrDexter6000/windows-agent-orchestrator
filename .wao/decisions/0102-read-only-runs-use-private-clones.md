# 0102 ephemeral 只读运行改用源仓的私有克隆，不再用链接工作树

- 日期：2026-10-31
- 状态：accepted
- 来源：
  - TD-310：只读席位在共享仓里的写入 WAO 看不见。2026-10-30 第 54 批代码会审（consult_20261030175144250cn8lk6）的 deepseek-flash 席位（run_2026103017514764519lvon）在自己树里的 `.wao/runs/r8probe` 下做实验：实验目录本身不是仓库，`git -C` 向上找到席位自己的树，而那棵树是共享仓的链接工作树，于是建的工作树与分支 `wt2`、改的 `user.email` 都落进了共享仓。它事后显式切到主检出改回去并自报。
  - 2026-10-31 实测：1265 次只读运行里有 28 次执行过写仓库的 git 命令（2.2%）；`git branch -D` 即使分支没有配置段也会重写 `.git/config`。
  - Owner 2026-10-31：同意先发 v0.7.0、再从根上防；"具体修复方案……问问kimi和sol的意见，你汇总"。
- 关系：改决定 0057 W1a（只读 ephemeral 树）的树形态；0062 的分支回收对私有克隆不再调用，对旧转录的链接树照旧。只读声明仍是 advisory，不是沙箱。不改 sessionReuse 的只读运行（persistent 树）与交付运行。
- 方案会审：kimi、sol 均判 FIX_FIRST（consult_20261031084715631r5k8fq），方向成立；本稿按两席意见补了基点持久化、删前证据检查、两条释放路径共用、私有克隆的盘点与新旧兼容。

## 背景

- ephemeral 只读运行（会审席位都是；`--read-only` 且无 sessionReuse）原先用 `git worktree add <源仓>/.wao-worktrees/<runId> -b wao/<runId> <冻结基点>` 建树，终态且停止确认后删树，再在源仓里回收零独有提交的 `wao/<runId>`。
- 链接工作树的 `.git` 是一个指向共享 common dir 的文件。席位在自己树里跑 `git config`、`git branch`、`git worktree add`，写的都是共享仓；任务书的叮嘱挡不住。
- 检测走不通：只比较开始与结束两个时刻，看不出改了又改回；看 `.git/config` 的修改时间，又会被 WAO 自己在席位结束时删分支打乱。

## 决定

1. **建树。** 新增一个私有克隆原语，只在 `readOnly && !sessionReuse` 时选用；`createWorktree` 不动，它还服务交付与 persistent 树。
   - 先在源仓把基点解析成完整 SHA（有冻结基点用它，否则取源仓 HEAD 的提交）；解析不了即拒绝启动。
   - `git clone --shared --no-checkout --quiet <源仓> <源仓>/.wao-worktrees/<runId>`（alternates 由 git 自己写；源仓是链接工作树时也指向它的 common dir 对象库），再在克隆里 `git checkout -q -b wao/<runId> <基点 SHA>`，把 `remote.origin.pushurl` 设成一个不可用的值。
   - 任一步失败都按现有的只读隔离失败拒绝启动，绝不回退到源仓。只有 clone 成功之后的步骤失败才删目录：目标已存在且非空时 git clone 自己拒绝，clone 本身失败时 git 删它建出的目录，WAO 不删不是本次建的东西。
   - 源仓的本地 config 不复制。本机要紧的 `core.longpaths`、`core.autocrlf` 是全局配置，克隆照样生效；`core.symlinks`、`core.ignorecase` 由 git 在克隆时按文件系统探测写入。
2. **运行事实。** `run.started` 增加 `worktreeForm: "private_clone"` 与 `worktreeBaseCommit`（完整 SHA），分支仍记 `wao/<runId>`。两种 resume 构造都从这里恢复释放所需的上下文。没有 `worktreeForm` 的旧转录一律按链接树处理，走原来的释放与分支回收。
3. **删前证据检查，再决定删不删。** 正常的延迟释放与 Run 构造之前退出的清理共用同一个处置原语，顺序都是先查后删：
   - 延迟释放先过停止确认门：未确认不动（门不变）。Run 构造之前退出的路径（pending 被拒、认证门、fire-and-forget 护栏、spawn 失败）没有可核验的 worker 句柄，直接处置：前三条还没起 worker，spawn 失败沿用 TD-262 起的做法。spawn 之后才被拒的不删，留给盘点；
   - 在克隆里列出除 `refs/stash` 外全部引用与 HEAD 可达、基点不可达的提交，再到源仓的对象库里查：源仓没有的，就是在克隆里新写的提交。新对象只写进克隆自己的对象库，删克隆丢的正是这些。只认对象在哪，不认克隆里引用的值，因为引用席位能改。查不出来（git 失败、目录不是克隆）、有新提交、HEAD 不在 `wao/<runId>` 上、克隆里登记了别的工作树：都保留整个克隆，记 `run.worktree_branch_kept`（有新提交时带 `uniqueCommits`，否则带闭集 `reason`）；
   - 全过：从克隆目录之外删除整个目录（有界重试），以目录确实不在为准记 `run.worktree_released`，仍在则记 `run.worktree_release_failed`（`still_present`）。未提交的改动与 stash 照旧不保留（写入已由只读观察记下）。
   - 对私有克隆不调用 `git worktree remove` 与源仓的分支回收：源仓里没有它的登记，也没有它的分支。
4. **盘点。** 回收计划认出 `.wao-worktrees/<runId>` 下的私有克隆：自己有 `.git` 目录、alternates 指向本仓对象库、runId 绑定到一个 `worktreeForm: "private_clone"` 的转录。首版一律保留，原因记 `private_clone`；认不出来源的克隆仍按外来处理，不会被误删。私有克隆的自动回收记入台账，另批做。源仓的工作树与分支计数只数源仓自己的登记，不含私有克隆。

## 否决的备选

- **快照比对检测**：理由见背景。
- **运行期间轮询共享仓状态**：开销高，仍有窗口，WAO 自己的派发也会制造噪音。
- **每个后端配只读沙箱**：放在各 Backend 里并不违反不变量 3，但不是每个后端都有，每个都要单独实现与认证，替代不了统一的仓库数据隔离。
- **`GIT_CEILING_DIRECTORIES`**：只挡向上越过指定目录的查找；10-30 那次 git 找到的正是席位自己的树。
- **完整复制（不带 `--shared`）**：能去掉对源仓对象的依赖，但要多拷一份对象；ephemeral 席位以分钟计，不值得。
- **删前检查按克隆里的引用排除**（基点之外再排除远程跟踪分支与镜像过来的源仓标签）：代码会审（consult_20261031104732044iboe3f）实测，席位把新提交挂到 `refs/remotes/` 下就会被判干净、克隆被删；源仓标签还要另做镜像，源仓在运行中删掉的分支也会被误算。

## 已知边界

- 只挡默认作用于当前仓库的写入。席位显式写源仓路径（切过去、`git -C <源仓>`、`git push <源仓路径>`）或写全局配置，克隆挡不住；无效的 pushurl 只挡误用 origin。
- 克隆借用源仓的对象。源仓删掉引用后，日常维护最终可能清掉借来的对象；被保留下来当证据的克隆不能保证长期完整，需要长期保存时由 Lead 另行打包。
- 只在 reflog 里的提交（提交后又 reset 掉）不算新提交，删除时不保留。
- 删前检查保护的是席位留下的提交，不防席位自己藏。它在克隆里跑 git，故意改写克隆里的历史解释（复核实测 `.git/info/grafts`）能让它判干净。可席位本来就能自己删掉这些提交，蓄意藏起来不比直接删多得到什么，所以不为此加防护。
- 克隆里的远程跟踪分支停在克隆那一刻，不随源仓更新。
- 树路径超过 260 个字符时，以树为 cwd 的进程起不来：建克隆在第一个以克隆为 cwd 的 git 命令处失败、拒绝启动（链接树则在 worker 启动时失败）。
