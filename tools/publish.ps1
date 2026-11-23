# 一键发布：内容体检 → 静态构建 → 提交推送 GitHub → 准备 Trae 部署目录 → 交接提示
# 由同目录上一级的 publish.bat 调用；不要直接双击 .ps1。
# 只新增文件，不修改 start.bat / server.js / 站点代码。

[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $RepoRoot

function Step([string]$Text) {
    Write-Host ''
    Write-Host "== $Text ==" -ForegroundColor Cyan
}

function Warn([string]$Text) {
    Write-Host "[提示] $Text" -ForegroundColor Yellow
}

function Fail([string]$Reason, [string]$Hint) {
    Write-Host ''
    Write-Host "[失败] $Reason" -ForegroundColor Red
    if ($Hint) { Write-Host "        下一步：$Hint" -ForegroundColor Yellow }
    Write-Host ''
    exit 1
}

try {
    Step '0/6 环境检查'
    foreach ($cmd in @('node', 'npm', 'git')) {
        if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
            Fail "找不到命令：$cmd" "先安装并确保它在 PATH 中，然后重新双击 publish.bat"
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'package.json'))) {
        Fail '当前目录不是站点项目' "脚本应位于 $RepoRoot\tools\ 下"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.git'))) {
        Fail '当前目录不是 Git 仓库' '发布流程需要 Git 仓库'
    }
    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { Fail '读取 Git 分支失败' '确认 .git 目录完整' }
    if ($branch -ne 'main') {
        Fail "当前分支是 $branch，不是 main" '先切回 main（git switch main）再重新双击'
    }

    Step '1/6 内容体检'
    npm run check
    if ($LASTEXITCODE -ne 0) {
        Fail '内容体检未通过（缺失图片或失效链接）' '按上面的列表修好后重新双击；线上未受影响'
    }

    Step '2/6 静态导出'
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Fail '静态导出失败' '把黑窗口里的报错整段发给 Trae 会话排查'
    }
    $distDir = Join-Path $RepoRoot 'dist'
    if (-not (Test-Path -LiteralPath (Join-Path $distDir 'index.html'))) {
        Fail '构建产物缺少 index.html' '导出可能被中断，重新双击一次'
    }

    Step '3/6 检查工作区与远程'
    $unmerged = @(git diff --name-only --diff-filter=U)
    if ($unmerged.Count -gt 0) {
        Fail '存在未解决的合并冲突' '先手动解决冲突并提交，再重新双击'
    }

    $status = @(git status --porcelain)
    $hasChanges = $status.Count -gt 0
    if ($hasChanges) {
        Write-Host ("待提交文件：{0} 个" -f $status.Count)
    } else {
        Write-Host '没有待提交改动，本次跳过提交与推送'
    }

    $upstream = (git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $upstream) {
        Warn '当前分支没有配置远端上游，跳过同步检查（推送可能失败）'
    } else {
        git fetch --quiet 2>$null
        if ($LASTEXITCODE -ne 0) {
            Warn '拉取远程状态失败（可能是网络问题），继续执行'
        } else {
            $behind = [int](git rev-list --count 'HEAD..@{u}')
            if ($behind -gt 0) {
                Fail "本地落后远程 $behind 个提交" '先在终端执行 git pull --rebase，确认无冲突后重新双击'
            }
        }
    }

    Step '4/6 提交并推送（触发 GitHub Pages）'
    if (-not $hasChanges) {
        Write-Host '无改动，跳过'
    } elseif ($DryRun) {
        Write-Host '[演练模式] 跳过 git add / commit / push'
    } else {
        git add -A
        if ($LASTEXITCODE -ne 0) { Fail 'git add 失败' '检查是否有文件被占用或权限不足' }

        $msg = 'publish: 内容更新 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')
        git commit -m $msg | Out-Host
        if ($LASTEXITCODE -ne 0) { Fail 'git commit 失败' '检查 git 的 user.name / user.email 是否已配置' }

        git push
        if ($LASTEXITCODE -ne 0) {
            Fail 'git push 失败' '常见原因：远程有新提交、SSH 密钥未配置、网络不通。先 git pull --rebase 后重试'
        }
        Write-Host '已推送。GitHub Actions 约 1~2 分钟后完成发布：'
        Write-Host 'https://github.com/sheep0516/wool/actions'
    }

    Step '5/6 准备 Trae 部署目录（仓库外）'
    $src = Join-Path ([System.IO.Path]::GetTempPath()) ('trae-deploy-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $pub = Join-Path $src 'public'
    New-Item -ItemType Directory -Path $pub -Force | Out-Null
    Get-ChildItem -LiteralPath $distDir -Force | Copy-Item -Destination $pub -Recurse -Force
    Remove-Item -LiteralPath (Join-Path $pub '.nojekyll') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $pub 'public\livereload.js') -Force -ErrorAction SilentlyContinue

    if (-not (Test-Path -LiteralPath (Join-Path $pub 'index.html'))) {
        Fail '部署目录里没有 index.html' '复制步骤失败，重新双击一次'
    }
    $files = @(Get-ChildItem -LiteralPath $pub -Recurse -File)
    $sizeMb = [math]::Round((($files | Measure-Object Length -Sum).Sum / 1MB), 2)
    Write-Host ("源目录：{0}" -f $src)
    Write-Host ("文件数：{0}（上限 99）  体积：{1} MB（上限 50）" -f $files.Count, $sizeMb)
    if ($files.Count -gt 99) {
        Warn '文件数超过 99，部署插件会自动改用 Node 静态服务方式，仍可继续'
    }

    Step '6/6 交接：最后一步必须由 Trae 会话完成'
    Write-Host '部署插件需要 Trae 会话的运行时上下文，双击脚本无法完成上传。'
    Write-Host '把下面这句话发给 Trae 会话即可：'
    Write-Host ''
    Write-Host ("  用 deployment 插件把 {0} 部署为 static-web，先选「仅自己可见」" -f $src) -ForegroundColor Green
    Write-Host ''
    if ($env:TRAE_PROJECT_ID) {
        Warn '检测到当前运行在 Trae 终端内：可直接让当前会话继续执行部署'
    } else {
        Write-Host '（想连这一步也自动化：在 Trae 会话里让我运行发布流程，而不是双击 bat。）'
    }
    if ($DryRun) {
        Write-Host ''
        Write-Host '[演练模式] 未提交、未推送、未部署；上面的临时目录已生成，可直接删掉。' -ForegroundColor Yellow
    }

    exit 0
} catch {
    Write-Host ''
    Write-Host ('[异常] ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host ''
    exit 1
}
