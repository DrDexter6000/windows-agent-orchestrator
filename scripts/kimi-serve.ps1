# scripts/kimi-serve.ps1
#
# Start the kimi worker serve of a kimi-web lane under a kimi home, detached.
#
# The serve hands its own environment to every worker shell. It is therefore started without the
# operator's secret-looking variables (the name rule `wao serve recycle` applies; proxy variables are
# kept, the serve needs the network) and without the variables of an agent session that launches it
# (CLAUDE* / ANTHROPIC*). It adds KIMI_CODE_HOME (the home) and WAO_IN_WORKER=1. The serve uses the
# login stored in the home, so it does not need the dropped variables.
#
# How the child gets that environment: this process's environment is trimmed, the serve is started
# through the plain form of Start-Process (the child inherits the environment but none of the caller's
# handles), and the environment is put back. The other forms were measured on PowerShell 7.6.6 and
# rejected: -Environment makes the serve inherit the caller's output pipe, so a caller that reads this
# script's output never returns; -UseNewEnvironment together with -Environment drops the additions, and
# the serve lands in the default home with the user's whole environment.
#
# Usage:
#   pwsh -File scripts/kimi-serve.ps1 -KimiHome <home> -Port <port> -WorkspaceDir <stable dir>
#
# Prints variable names and counts only. The script returning does not mean the serve is ready: check
# with `wao serve status` (the lane's kimiHome and serveUrl in the registry select the target).

param(
  [Parameter(Mandatory = $true)][string]$KimiHome,
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$WorkspaceDir,
  [string]$KimiExe = "$env:USERPROFILE\.kimi-code\bin\kimi.exe"
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $KimiExe)) { throw "kimi exe not found: $KimiExe" }
if (-not (Test-Path -LiteralPath (Join-Path $KimiHome 'server.token'))) { throw "kimi home has no server.token: $KimiHome" }
if (-not (Test-Path -LiteralPath $WorkspaceDir)) { throw "workspace dir missing: $WorkspaceDir" }
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listening) { throw "port $Port is already listening (pid $($listening.OwningProcess)); not starting a second serve" }

$secretName = '(API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|(^|[_-])TOKEN($|[_-])|SECRET|PASSWORD|PRIVATE[_-]?KEY|CREDENTIAL)'
$dropSecrets = @(Get-ChildItem Env: | Where-Object { $_.Name -match $secretName -and $_.Name -notmatch '_PROXY$' } | ForEach-Object Name)
$dropSession = @(Get-ChildItem Env: | Where-Object { $_.Name -match '^(CLAUDE|ANTHROPIC)' -and $dropSecrets -notcontains $_.Name } | ForEach-Object Name)
$set = @{ KIMI_CODE_HOME = $KimiHome; WAO_IN_WORKER = '1' }
"dropping $($dropSecrets.Count) secret-looking variable name(s): $($dropSecrets -join ', ')"
"dropping $($dropSession.Count) agent-session variable(s) (CLAUDE* / ANTHROPIC*)"

$saved = @{}
foreach ($n in $dropSecrets + $dropSession + @($set.Keys)) { $saved[$n] = [Environment]::GetEnvironmentVariable($n, 'Process') }
try {
  # Remove-Item, not an empty value: an empty value leaves the name in the child's environment.
  foreach ($n in $dropSecrets + $dropSession) { Remove-Item -LiteralPath "Env:$n" }
  foreach ($n in $set.Keys) { Set-Item -LiteralPath "Env:$n" -Value $set[$n] }
  $p = Start-Process -FilePath $KimiExe -ArgumentList 'web', '--no-open', '--port', "$Port" `
    -WorkingDirectory $WorkspaceDir -WindowStyle Hidden -PassThru
} finally {
  foreach ($n in $saved.Keys) {
    if ($null -eq $saved[$n]) { Remove-Item -LiteralPath "Env:$n" -ErrorAction SilentlyContinue }
    else { Set-Item -LiteralPath "Env:$n" -Value $saved[$n] }
  }
}
"started pid=$($p.Id) port=$Port home=$KimiHome"
