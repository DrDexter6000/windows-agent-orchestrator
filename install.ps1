<#
install.ps1 — WAO 一条命令安装（薄壳安装器，R5-A）

定位（Owner 硬约束）：本脚本是 AGENT_ONBOARDING.md §4a–§4d 文档步骤的机械执行薄壳，
不发明第二套流程：
  - 默认不改 PATH（无任何 PATH 步骤，无 HKCU/系统 PATH 读写）——要求 8
  - 绝不自动安装 Node（前置检查只检测、只给指引）——要求 4
  - 不执行 npm link（保持文档"可选、每机一次"定位，仅在结尾提示）——要求 7
  - 不写仓外文件（唯一例外：-Uninstall 的备份目录在 <Dest> 同级，属用户显式安装区）

用法：
  irm <url> | iex                                # 默认装到 %USERPROFILE%\wao
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Dest D:\wao -Ref main
  powershell -NoProfile -File install.ps1 -Uninstall        # 备份 runs/ .wao/ agents.json 后删仓
  powershell -NoProfile -File install.ps1 -Uninstall -Purge # 跳过备份直接删（危险）

支持 -WhatIf（要求 3 加分项）：预检照跑（只读），clone/pull/npm ci/删除只打印不执行。

要求 12：全程不打印任何 env 值/密钥（只打印解析出的可执行文件路径与版本）。
#>

# 要求 1：入口形态兼容。param 块按 PowerShell 语法必须置于脚本最前（前置于它的
# 只能是注释），否则 -File 传参绑定失效、irm|iex 也不行。CmdletBinding 提供 -WhatIf。
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # 要求 3：参数。Dest 默认值由 Owner 裁定。
    [string]$Dest = (Join-Path $env:USERPROFILE 'wao'),
    # Ref 为空 = 自动取远端最新 stable tag（形如 vX.Y.Z）；无 stable tag 时回退 main 并明示。
    [string]$Ref = '',
    [switch]$Uninstall,
    [switch]$Purge   # 要求 11：仅配合 -Uninstall 使用
)

# 要求 2：TLS12（PS 5.1 兜底）——本脚本第一条可执行语句（irm 已由调用方完成，
# 此行保证本脚本后续任何 .NET 层网络请求都走 TLS12）。
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$WaoRepoUrl = 'https://github.com/DrDexter6000/windows-agent-orchestrator.git'
$WaoDocOnboarding = 'AGENT_ONBOARDING.md'

# ── 输出/失败小工具 ───────────────────────────────────────────────────────────
# 要求 1：irm|iex 时脚本在调用者作用域执行——致命错误一律 throw（禁用 exit），
# 结束用正常输出 + return。
function WaoFail {
    param([string]$Message)
    throw "install.ps1: $Message"
}

function Write-WaoStep { param([string]$Msg) Write-Host ''; Write-Host "==> $Msg" -ForegroundColor Cyan }
function Write-WaoInfo { param([string]$Msg) Write-Host "    $Msg" }
function Write-WaoWarn { param([string]$Msg) Write-Host "[warn] $Msg" -ForegroundColor Yellow }

# 运行外部命令并收集输出；非零退出码视为致命（AllowFail 除外）。-WhatIf 下只打印。
function Invoke-WaoExternal {
    param([string]$Exe, [string[]]$ArgList, [string]$Activity, [switch]$AllowFail)
    if ($WhatIfPreference) {
        Write-WaoInfo "[WhatIf] 跳过: $Activity -> $($ArgList -join ' ')"
        return @{ ExitCode = 0; Output = '' }
    }
    $output = (& $Exe @ArgList 2>&1) | Out-String
    $code = $LASTEXITCODE
    if ($code -ne 0 -and -not $AllowFail) {
        WaoFail "$Activity 失败（exit $code）：`n$($output.Trim())"
    }
    return @{ ExitCode = $code; Output = $output }
}

# ── 要求 4：前置检查（只检测不安装；失败 = 三行文案：发生了什么/手动怎么做/文档小节）──

function Assert-WaoPowerShell {
    $v = $PSVersionTable.PSVersion
    if ($v -lt [version]'5.1') {
        Write-Host "[fail] PowerShell 版本过低：$v（WAO 安装器需要 >= 5.1）。" -ForegroundColor Red
        Write-Host "       怎么做：升级 Windows Management Framework 5.1（https://aka.ms/wmf5download），"
        Write-Host "               或使用 Windows 自带的 powershell.exe（默认即 5.1+）。"
        Write-Host "       文档：$WaoDocOnboarding §4（安装步骤）。"
        WaoFail '前置检查失败：PowerShell 版本 < 5.1'
    }
    Write-WaoInfo "PowerShell $v （>= 5.1 通过）"
}

function Assert-WaoGit {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) {
        Write-Host '[fail] 未在 PATH 上找到 git（WAO 以 git clone 分发，worktree 隔离/交付封装都依赖 git）。' -ForegroundColor Red
        Write-Host '       怎么做：winget install Git.Git （或官网安装器 https://git-scm.com/download/win），'
        Write-Host '               装完后新开一个终端重跑本脚本（当前会话 PATH 可能未刷新）。'
        Write-Host "       文档：$WaoDocOnboarding §3（前置条件）/ §4a（安装）。"
        WaoFail '前置检查失败：git 不在 PATH'
    }
    Write-WaoInfo "git 已就绪：$($git.Source)"
}

# 探测 Node v22 —— 顺序与 scripts/wao-node.cjs 完全一致（唯一权威）：
#   腿 1  env WAO_NODE（设置了且文件存在才命中；设置了但失效时与 shim 一致——跳过腿 2 直接看 PATH）
#   腿 2  %LOCALAPPDATA%\Programs\nodejs-v22\node.exe（约定路径）
#   腿 3  PATH 上 node 主版本 = 22
# 返回 @{ Hit; Exe; Source; Version }；未命中时附带 PATH 腿探测到的信息供失败文案用。
function Resolve-WaoNode {
    $result = @{ Hit = $false; Exe = $null; Source = $null; Version = $null; PathNodeExe = $null; PathNodeVersion = $null }

    $versionOf = {
        param([string]$Exe)
        try {
            $out = (& $Exe --version 2>$null) | Select-Object -First 1
            if ($LASTEXITCODE -ne 0) { return $null }
            return ("$out").Trim()
        }
        catch {
            return $null
        }
    }

    # 腿 1：env WAO_NODE
    if ($env:WAO_NODE) {
        if (Test-Path -LiteralPath $env:WAO_NODE -PathType Leaf) {
            $ver = & $versionOf $env:WAO_NODE
            if ($ver) {
                $result.Hit = $true; $result.Exe = $env:WAO_NODE; $result.Source = 'WAO_NODE'; $result.Version = $ver
                return $result
            }
        }
        # WAO_NODE 已设置但失效/不可执行：与 shim 的 `WAO_NODE || 约定路径` 语义一致，
        # 不再回退约定路径，落到 PATH 腿。
    }
    else {
        # 腿 2：约定路径（仅当 WAO_NODE 未设置时参与，同 shim）
        $conventional = if ($env:LOCALAPPDATA) {
            Join-Path $env:LOCALAPPDATA 'Programs\nodejs-v22\node.exe'
        } else { $null }
        if ($conventional -and (Test-Path -LiteralPath $conventional -PathType Leaf)) {
            $ver = & $versionOf $conventional
            if ($ver) {
                $result.Hit = $true; $result.Exe = $conventional; $result.Source = '约定路径'; $result.Version = $ver
                return $result
            }
        }
    }

    # 腿 3：PATH 上 node 主版本 = 22
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue | Where-Object { $_.CommandType -eq 'Application' } | Select-Object -First 1
    if ($nodeCmd) {
        $result.PathNodeExe = $nodeCmd.Source
        $result.PathNodeVersion = & $versionOf $nodeCmd.Source
        if ($result.PathNodeVersion -match '^v?(\d+)') {
            $major = [int]$Matches[1]
            if ($major -eq 22) {
                $result.Hit = $true; $result.Exe = $nodeCmd.Source; $result.Source = 'PATH'; $result.Version = $result.PathNodeVersion
                return $result
            }
        }
    }
    return $result
}

function Assert-WaoNode {
    $n = Resolve-WaoNode
    if ($n.Hit) {
        if ($n.Source -eq 'PATH') {
            # 要求 4c：PATH 命中时打印实际解析到的 node.exe 路径 + 版本（提示可用 WAO_NODE 固定）。
            Write-WaoInfo "Node $($n.Version) @ $($n.Exe)（PATH 命中；可用 env WAO_NODE 固定该路径）"
        } else {
            Write-WaoInfo "Node $($n.Version) @ $($n.Exe)（$($n.Source) 命中）"
        }
        return $n
    }
    Write-Host '[fail] 未找到可用的 Node v22（WAO 把运行版本钉死在 v22）。' -ForegroundColor Red
    if ($n.PathNodeExe) {
        Write-Host "       PATH 上的 node 是 $($n.PathNodeVersion) @ $($n.PathNodeExe)——主版本非 22，被拒绝。"
    }
    if ($env:WAO_NODE) {
        Write-Host '       env WAO_NODE 已设置但未指向可用的 node.exe（其失效时约定路径不参与探测）。'
    }
    Write-Host '       怎么做：从官方 v22 固定通道安装：https://nodejs.org/dist/latest-v22.x/ '
    Write-Host '               （装到 %LOCALAPPDATA%\Programs\nodejs-v22 后无需配置即可被识别；装到'
    Write-Host '                 其它位置则设 env WAO_NODE 指向该 node.exe；也可装 v22 到 PATH 替换默认 node）。'
    Write-Host '               注意：Node v24 现为 Active LTS，但被 WAO 拒绝（libuv Windows Job Object 回归，'
    Write-Host '               见 src/nodeVersionGuard.js）——不要装 v24 替代。本脚本不自动安装 Node。'
    Write-Host '               若 Node 刚装好仍探测不到：新开一个终端再重跑本脚本（当前会话 env 可能未刷新）。'
    Write-Host "       文档：$WaoDocOnboarding §3（前置条件）/ §4a（安装）。"
    WaoFail '前置检查失败：未找到 Node v22（WAO_NODE → 约定路径 → PATH 三腿均未命中）'
}

# ── 要求 3：Ref 解析（默认最新 stable tag，无 tag 回退 main 并明示）──────────────

function Resolve-WaoRef {
    param([string]$RequestedRef)
    if ($RequestedRef) {
        Write-WaoInfo "-Ref $RequestedRef（命令行指定）"
        return $RequestedRef
    }
    if ($WhatIfPreference) {
        Write-WaoInfo "[WhatIf] 跳过: git ls-remote（默认 -Ref 解析需要网络）→ 回退 main"
        return 'main'
    }
    Write-WaoInfo '未指定 -Ref：解析远端最新 stable tag（git ls-remote）...'
    $lines = (& git ls-remote --tags $WaoRepoUrl 2>&1) | Out-String
    if ($LASTEXITCODE -ne 0) {
        Write-WaoWarn '无法访问远端（git ls-remote 失败）——回退 main。'
        return 'main'
    }
    $tags = @()
    foreach ($line in ($lines -split "`r?`n")) {
        if ($line -match 'refs/tags/([^^\s]+)$' -and $line -notmatch '\^\{\}') {
            $tags += $Matches[1]
        }
    }
    $stable = @($tags | Where-Object { $_ -match '^v?\d+(\.\d+){0,3}$' } | Sort-Object { [version]($_ -replace '^v', '') })
    if ($stable.Count -gt 0) {
        $top = $stable[$stable.Count - 1]
        Write-WaoInfo "最新 stable tag：$top（仓库无 stable tag 时会回退 main）"
        return $top
    }
    Write-WaoWarn '远端没有 stable tag（形如 vX.Y.Z）——回退 main。'
    return 'main'
}

# ── 要求 5：幂等矩阵 + 全量 clone ────────────────────────────────────────────

function Normalize-WaoRemoteUrl {
    param([string]$Url)
    if (-not $Url) { return '' }
    $u = $Url.Trim().TrimEnd('/')
    if ($u.EndsWith('.git')) { $u = $u.Substring(0, $u.Length - 4) }
    return $u.ToLowerInvariant()
}

# 已存在的 $Dest 分流：clean / dirty / not-git / corrupt / remote-mismatch。
function Test-WaoExistingDest {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 'absent' }
    $gitMeta = Join-Path $Path '.git'
    if (-not (Test-Path -LiteralPath $gitMeta)) { return 'not-git' }
    # .git 存在但损坏（半程 clone 等）：git 元命令直接失败
    (& git -C $Path rev-parse --is-inside-work-tree 2>&1) | Out-Null
    if ($LASTEXITCODE -ne 0) { return 'corrupt' }
    $remote = (& git -C $Path remote get-url origin 2>$null) | Select-Object -First 1
    if ($LASTEXITCODE -ne 0 -or (Normalize-WaoRemoteUrl "$remote") -ne (Normalize-WaoRemoteUrl $WaoRepoUrl)) {
        return 'remote-mismatch'
    }
    $status = (& git -C $Path status --porcelain 2>&1) | Out-String
    if ($status.Trim()) { return 'dirty' }
    return 'clean'
}

function Invoke-WaoCloneOrUpdate {
    param([string]$Path, [string]$ResolvedRef)
    $state = Test-WaoExistingDest -Path $Path
    switch ($state) {
        'absent' {
            # 全新 clone：完整 clone（不用 --depth 1）；Ref 为 tag 时 --branch <tag>。
            Write-WaoStep "git clone（--branch $ResolvedRef，全量 clone）"
            $r = Invoke-WaoExternal -Exe git -ArgList @('clone', '--branch', $ResolvedRef, $WaoRepoUrl, $Path) -Activity 'git clone'
            if ($r.ExitCode -ne 0) { WaoFail "clone 失败（exit $($r.ExitCode)）：`n$($r.Output.Trim())" }
            return
        }
        'clean' {
            Write-WaoStep "$Path 已是本仓的干净 clone —— git pull --ff-only 后继续"
            # tag 检出是 detached HEAD，pull 会失败：机械跳过（处于 tag 快照，无 ff 可拉）。
            $branch = (& git -C $Path rev-parse --abbrev-ref HEAD 2>$null) | Select-Object -First 1
            if ("$branch" -eq 'HEAD') {
                Write-WaoInfo '当前是 detached HEAD（tag 检出）——跳过 pull。'
                return
            }
            $r = Invoke-WaoExternal -Exe git -ArgList @('-C', $Path, 'pull', '--ff-only') -Activity 'git pull --ff-only'
            if ($r.ExitCode -ne 0) { WaoFail "git pull --ff-only 失败（本地与远端分叉？）：`n$($r.Output.Trim())" }
            return
        }
        'dirty' {
            WaoFail "$Path 存在未提交改动（dirty）。`n怎么做：进目录自行处理（commit / stash / discard）后重跑本脚本，或换一个 -Dest。`n文档：$WaoDocOnboarding §4a。"
        }
        'not-git' {
            WaoFail "$Path 已存在且不是 git 仓库（非 WAO 安装目录）。`n怎么做：换一个 -Dest，或确认该目录可删后手动删除再重跑。`n文档：$WaoDocOnboarding §4a。"
        }
        'corrupt' {
            WaoFail "$Path 的 .git 已损坏（可能是中断的半程 clone）。`n怎么做：关闭占用该目录的程序后删除它（Remove-Item -Recurse -Force '$Path'）再重跑本脚本。`n文档：$WaoDocOnboarding §4a。"
        }
        'remote-mismatch' {
            WaoFail "$Path 是 git 仓库但 origin 不指向 $WaoRepoUrl。`n怎么做：确认目录内容；如非本仓请换一个 -Dest。`n文档：$WaoDocOnboarding §4a。"
        }
        default {
            WaoFail "Test-WaoExistingDest 返回未知状态：$state"
        }
    }
}

# ── 要求 6：npm ci（用探测到的 v22 运行 npm）──────────────────────────────────

function Resolve-WaoNpm {
    param($Node)
    if ($Node.Source -eq 'PATH') {
        # PATH 命中：直接用 PATH npm（与 node 同一安装的 npm）。
        $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
        if ($npm) { return $npm.Source }
        WaoFail "PATH 上的 node 缺少配套 npm。`n怎么做：重装 Node v22（官网安装器/npm.cmd 同目录布局）：https://nodejs.org/dist/latest-v22.x/`n文档：$WaoDocOnboarding §4a。"
    }
    # 约定路径 / WAO_NODE 安装：npm.cmd 与 node.exe 同目录（nodejs.org Windows 安装布局）。
    $sibling = Join-Path (Split-Path -Parent $Node.Exe) 'npm.cmd'
    if (Test-Path -LiteralPath $sibling -PathType Leaf) { return $sibling }
    WaoFail "未找到与 $($Node.Exe) 配套的 npm.cmd（应在同目录）。`n怎么做：确认该 Node 是完整的 nodejs.org 安装（node.exe 与 npm.cmd 同目录），或改用 PATH 上的 v22。`n文档：$WaoDocOnboarding §4a。"
}

function Invoke-WaoNpmCi {
    param([string]$NpmCmd, [string]$Path)
    # 要求 6：npm ci 前先打印预期管理（不用 --no-audit，让告警原样呈现）。
    Write-WaoInfo 'npm ci 尾部可能出现 N vulnerabilities 告警（MCP SDK 传递依赖，WAO stdio 运行无暴露面）——预期内，不阻塞。'
    if ($WhatIfPreference) {
        Write-WaoInfo "[WhatIf] 跳过: npm ci （目录 $Path）"
        return
    }
    Push-Location -LiteralPath $Path
    try {
        $output = (& $NpmCmd ci 2>&1) | Out-String
        $code = $LASTEXITCODE
        Write-Host ($output.TrimEnd())
        if ($code -ne 0) {
            WaoFail "npm ci 失败（exit $code）。`n怎么做：删除 $Path 下的 node_modules 后重跑；网络问题可先检查代理。`n文档：$WaoDocOnboarding §4a。"
        }
    }
    finally {
        Pop-Location
    }
}

# ── 要求 9：安装后自检（doctor 只打印输出，不以退出码判定成败）─────────────────

function Invoke-WaoDoctorAdvisory {
    param([string]$NpmCmd, [string]$Path)
    if ($WhatIfPreference) {
        Write-WaoInfo '[WhatIf] 跳过: wao doctor（advisory 自检）'
        return
    }
    Write-WaoStep '安装自检：wao doctor（advisory——只打印输出，FAIL 项不阻塞安装）'
    try {
        Push-Location -LiteralPath $Path
        # 目标项目用 WAO 仓自身（AGENT_ONBOARDING §4d：新机器无其它项目时可临时用本仓）。
        $output = (& $NpmCmd run cli --silent -- wao doctor --cwd $Path 2>&1) | Out-String
        Write-Host ($output.TrimEnd())
        # 要求 9：故意不检查 $LASTEXITCODE——doctor 是建议性报告，不是安装门禁。
    }
    catch {
        Write-WaoWarn "wao doctor 未运行成功（不影响安装结果）：$($_.Exception.Message)"
    }
    finally {
        Pop-Location
    }
}

# ── 要求 10：下一步文案（逐字引用 AGENT_ONBOARDING.md §4c/§4d 的命令）──────────

function Write-WaoNextSteps {
    param([string]$Path)
    Write-Host ''
    Write-Host '安装完成。下一步（命令逐字来自 AGENT_ONBOARDING.md §4c/§4d）：' -ForegroundColor Green
    Write-Host "  cd $Path"
    Write-Host '  npm run cli -- wao onboarding --agent <你保留的 worker id> --apply    # §4c 自动生成 config/agents.json'
    Write-Host '  npm run cli -- registry list --registry config/agents.json           # §4d inventory + certification'
    Write-Host '  npm run cli -- registry validate --registry config/agents.json      # §4d 静态 schema 校验'
    Write-Host '  npm run cli -- wao doctor --cwd <目标项目>                            # §4d 环境自检'
    Write-Host ''
    Write-Host '可选：npm link（每台机器一次，暴露顶层 wao 命令）——本脚本不执行它，见 AGENT_ONBOARDING.md §4a。'
    Write-Host "首次使用前必读：SKILL.md 与 references/safety-incidents.md（$WaoDocOnboarding §4）。"
}

# ── 安装主流程 ────────────────────────────────────────────────────────────────

function Invoke-WaoInstall {
    Write-WaoStep "前置检查（只检测不安装；WAO -> $Dest）"
    Assert-WaoPowerShell   # 要求 4a
    Assert-WaoGit          # 要求 4b
    $node = Assert-WaoNode # 要求 4c（WAO_NODE → 约定路径 → PATH，与 wao-node.cjs 一致）

    $ref = Resolve-WaoRef -RequestedRef:$Ref  # 要求 3
    Invoke-WaoCloneOrUpdate -Path:$Dest -ResolvedRef:$ref  # 要求 5

    # 要求 8：此处【无任何 PATH 修改步骤】——不改 HKCU/系统 PATH，不写环境变量。
    # 要求 7：此处【不执行 npm link】——保持文档"可选、每机一次"定位（见结尾提示）。

    $npm = Resolve-WaoNpm -Node:$node
    Write-WaoStep "npm ci（$npm）"
    Invoke-WaoNpmCi -NpmCmd:$npm -Path:$Dest  # 要求 6

    Invoke-WaoDoctorAdvisory -NpmCmd:$npm -Path:$Dest  # 要求 9
    Write-WaoNextSteps -Path:$Dest  # 要求 10
}

# ── 要求 11：-Uninstall（默认备份后删；-Purge 跳过备份）───────────────────────

function Invoke-WaoUninstall {
    if (-not (Test-Path -LiteralPath $Dest)) {
        Write-WaoWarn "$Dest 不存在——无需卸载。"
        return
    }
    # 安全护栏：拒绝明显错误的删除目标。
    $full = (Resolve-Path -LiteralPath $Dest).Path
    $trimmed = $full.TrimEnd('\')
    if ($trimmed -match '^[A-Za-z]:$') { WaoFail "拒绝卸载驱动器根目录：$full" }
    $homeTrimmed = "$env:USERPROFILE".TrimEnd('\')
    if ($trimmed -eq $homeTrimmed) { WaoFail "拒绝卸载用户主目录：$full" }

    # npm unlink -g（失败容忍：从未 link 过会失败——预期内，警告后继续）。
    if (Test-Path -LiteralPath (Join-Path $Dest 'package.json')) {
        Write-WaoStep 'npm unlink -g（未 link 过会失败——预期内，继续）'
        if ($WhatIfPreference) {
            Write-WaoInfo "[WhatIf] 跳过: npm unlink -g （目录 $Dest）"
        }
        else {
            $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
            if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
            if ($npm) {
                try {
                    Push-Location -LiteralPath $Dest
                    $out = (& $npm.Source unlink -g 2>&1) | Out-String
                    Write-Host ($out.TrimEnd())
                }
                catch {
                    Write-WaoWarn "npm unlink -g 失败（容忍，继续）：$($_.Exception.Message)"
                }
                finally {
                    Pop-Location
                }
            }
            else {
                Write-WaoWarn 'PATH 上没有 npm——跳过 npm unlink -g（容忍，继续）。'
            }
        }
    }

    # 数据目录备份（transcript 是事实来源，默认绝不删除）：runs/ .wao/ config/agents.json
    # 移动到 <Dest>-backup-<yyyyMMddHHmmss>\（同级，用户显式安装区内）。-Purge 跳过。
    $dataItems = @(
        (Join-Path $Dest 'runs'),
        (Join-Path $Dest '.wao'),
        (Join-Path $Dest 'config\agents.json')
    )
    $existing = @($dataItems | Where-Object { Test-Path -LiteralPath $_ })
    if ($Purge) {
        Write-WaoWarn "-Purge：跳过备份，直接删除（runs/.wao/agents.json 将不可恢复）。"
    }
    elseif ($existing.Count -gt 0) {
        $stamp = Get-Date -Format 'yyyyMMddHHmmss'
        $backup = "$Dest-backup-$stamp"
        Write-WaoStep "备份数据目录 -> $backup"
        if ($WhatIfPreference) {
            Write-WaoInfo "[WhatIf] 跳过: 备份 $($existing -join ', ')"
        }
        else {
            try {
                New-Item -ItemType Directory -Path $backup -Force | Out-Null
                foreach ($item in $existing) {
                    Move-Item -LiteralPath $item -Destination $backup -ErrorAction Stop
                }
                Write-WaoInfo "已移动（transcript 是事实来源，默认绝不删除）：$($existing -join ', ')"
            }
            catch {
                WaoFail "备份失败，已中止（$Dest 未被删除，数据未动）：$($_.Exception.Message)"
            }
        }
    }
    else {
        Write-WaoInfo '无 runs/.wao/config\agents.json 需备份。'
    }

    Write-WaoStep "删除仓库目录 $Dest"
    if ($WhatIfPreference) {
        Write-WaoInfo "[WhatIf] 跳过: Remove-Item -Recurse -Force $Dest"
    }
    else {
        try {
            Remove-Item -LiteralPath $Dest -Recurse -Force -ErrorAction Stop
        }
        catch {
            WaoFail "删除失败（备份已保留）：$($_.Exception.Message)"
        }
    }
    Write-Host '卸载完成。' -ForegroundColor Green
}

# ── 入口 ──────────────────────────────────────────────────────────────────────

# 要求 3：-Purge 仅配合 -Uninstall（防误删）。
if ($Purge -and -not $Uninstall) {
    WaoFail '-Purge 仅在与 -Uninstall 配合时有效。'
}

if ($Uninstall) {
    Invoke-WaoUninstall
}
else {
    Invoke-WaoInstall
}
# 要求 1：结束 = 正常输出 + return（irm|iex 作用域安全；绝不 exit）。
return
