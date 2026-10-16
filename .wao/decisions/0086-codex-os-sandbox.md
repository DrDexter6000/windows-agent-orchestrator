# 0086 codex 车道的越界写由 OS 沙箱挡住：每次调用显式传 workspace-write，认证改用沙箱执行证据

- 日期：2026-10-16
- 状态：accepted（Lead 决定；Owner 2026-10-16 授权疑难问题经双席会审后由 Lead 决断）
- 来源：TD-309。
- 修订：0084 第 1、2 条。对声明了 OS 沙箱的后端，越界写拦截能力改用本决定第 4 条的证据；其余后端不变。
- 会审：方案会审 consult_20261016201806666tnnhzj（kimi、opus）。实现批的会审记在提交说明里。

## 背景

- `src/backends/codex.js` 调 `codex exec` 时不带任何沙箱参数，沙箱因此由用户的 `~/.codex/config.toml` 决定。
  - 本机的配置是 `danger-full-access`、`approval_policy = "never"`。这份配置是 Owner 交互使用的。
  - 结果是 sol、astra 的 worker 和会审席位都没有系统级沙箱。
- codex 常用 shell 命令写文件。parser 只把 `file_change` 投影成 `file_written`，shell 写入没有帧，拦截门看不见，往工作树外写也一样。
  - containmentEvidence 因此对 sol、astra 判断不了，两条 strict 行降为 conditional。
  - 这一项能否通过取决于模型挑哪个工具，正是 0084 要排除的那类依赖。
- 2026-10-16 在本机实测 codex-cli 0.159.2，"外部"目录都不在 `%TEMP%` 下：
  - **`codex exec -c sandbox_mode="workspace-write"`：**能压过用户配置里的 danger-full-access。工作目录外的写入被拒，"Access … denied"。shell 命令仍有网络。
  - **`exec resume <id> -c sandbox_mode="read-only"`：**照样生效。`exec resume` 不接受 `-s`，只接受 `-c`。
  - **`codex sandbox -P :workspace`（不经模型）：**
    - 树内可写；树外兄弟目录、源检出被拒；`%TEMP%` 可写；
    - 关联工作树里 `git status`、`log`、`diff` 正常，`git add` 因 index 在树外而被拒；
    - Node 22 和经 pwsh 调用的 npm 能运行；
    - 沙箱建的文件归沙箱用户所有，控制面仍能提交它，`git worktree remove` 也成功。

## 决定

1. **codex 后端在每次调用时显式传沙箱参数**，首轮与 resume 轮相同，都用 `-c`（`exec resume` 不接受 `-s`）：
   - `sandbox_mode="workspace-write"`；
   - `sandbox_workspace_write.network_access=true`；
   - `approval_policy="never"`。

   用户的配置文件不改。命令行上的这三项不随各机器的交互配置变化。
2. **只读运行与会审席位也用 workspace-write，不用 read-only。**
   - 只读运行总在它自己的隔离树里跑：会审席位与普通只读运行是一次性的 ephemeral 树，带 sessionReuse 的只读运行是这条线系的持久树。沙箱的根就是这棵树，树外写入被挡住，源检出与其他目录因此受保护。
   - 树内的写入不挡。席位上报为 `file_written` 的写入照旧由 0055 判 FAIL；codex 用 shell 在树内写，没有帧，0055 看不见（见已知局限）。
   - 换来的是审查席位还能跑测试核验结论：read-only 连树内与 `%TEMP%` 都拒写，测试建不了临时文件。
3. **可写面是运行的工作目录加系统临时目录。**
   - 隔离运行的工作目录是它的工作树。不隔离的写运行，工作目录是源检出，与今天相同。
   - 关联工作树的 git 元数据在树外，保持不可写，worker 在那里提交不了。交付合同本来就不让 worker 提交，打包由沙箱外的控制面完成。
4. **对声明了 OS 沙箱的后端，越界写拦截能力的证据由两段组成，取代 containmentEvidence 在 delta 与 strict 集合里的位置：**
   - **确定性（`npm test`）：**钉住参数构建。首轮与 resume 轮都带第 1 条的三项，任何路径都不出现 `danger-full-access`。另有源级钉看住取参链。
   - **活体（reliability，新检查 sandboxEnforcement，不经模型）：**
     - 在 WAO 新建的工作树里，用 `codex sandbox -P :workspace -C <树>` 执行固定写命令；codex 入口与车道的真实派发走同一解析链；
     - 写命令自己报告写成、被访问控制拒绝或其他错误；
     - 往树外目录写，必须报告被拒、退出码非零、文件确实不存在；往树内写，必须报告写成、文件在场；
     - 子命令不可用、命令没跑起来或结果不确定，记 inconclusive，不记 pass。
5. **能力由后端声明，共享代码不按运行时分支。**codex 后端声明 OS 沙箱能力，矩阵构建与认证判定按这项声明选检查。其余后端仍按 0084 认证。

## 否决的方案

- **只读运行与席位用 read-only：**
  - read-only 连树内与 `%TEMP%` 都拒写，审查席位就不能再跑测试来核验结论；
  - 换来的只是挡住只读运行自己隔离树内的写入。源检出在 workspace-write 下同样受保护。
- **从树的 git 改动合成写入证据，让 containmentEvidence 对 codex 通过：**
  - 它证明的是 git 看到了树内改动，不是车道如实上报写入，用来认证是循环论证；
  - 树外写入仍然看不见。
- **演练预建目录，诱导模型改用 apply_patch：**仍然依赖模型的工具选择，红了分不清原因。
- **改写用户的 `~/.codex/config.toml`，或用 `--ignore-user-config`：**
  - 前者改的是 Owner 的交互配置；
  - 后者会丢掉沙箱以外的用户设置，影响面没有实测。
- **写运行默认关网：**网络不是越界写的边界。worker 装依赖、取代码需要网络，而今天它们本来就有。

## 已知局限

- **`%TEMP%` 可写。**写到系统临时目录的文件不受拦截。
- **活体检查走的是 `codex sandbox`，不是 `codex exec`。**
  - WAO 确实传了参数，由确定性测试证明；
  - 2026-10-16 的实测显示两条路径的写入边界一致，网络不同：`codex sandbox` 下离线。
- **只读运行在自己树内的 shell 写入看不见。**codex 席位用 shell 改了它的 ephemeral 树，0055 判不出违规；带 sessionReuse 的只读运行，这类写入会留在线系的持久树里，但不会到达源检出。
- **活体检查只认写命令自己报告的"被访问控制拒绝"。**命令没在沙箱里跑起来、报告其他错误、缺观察值，一律记 inconclusive。
- **沙箱建的文件归沙箱用户所有。**提交与删树已实测可行；其他依赖 ACL 的操作没有逐一实测。
- **沙箱用户读不到用户目录下的部分子目录**（如 `~/.config/git`），git 会因此告警。
- **其余后端仍然只有侦测，没有 OS 沙箱**（0084 已知局限照旧）。
- **codex 升级可能改变参数语义。**harness 巡检与本决定第 4 条的活体检查是兜底。
